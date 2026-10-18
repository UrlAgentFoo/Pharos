"""
slicer: gets a part ready to 3D print, with PrusaSlicer, for Pharos.

slice: lays a part (PLY or STL, sizes in mm) on the bed of a generic
0.4 mm-nozzle printer with the axis you choose pointing up, slices it with
the layer height, walls and infill you choose, and reports how long it
takes to print, how much filament it uses and what that costs. It writes
the G-code, and its toolpath as a PLY point cloud coloured by what each line
is, as PrusaSlicer's preview colours them: outer walls orange, inner walls
yellow, infill dark red, solid infill purple, top surfaces red, bridges
blue, the skirt teal.

Progress goes to stdout as JSON lines.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys

import numpy as np

BED = (250.0, 210.0, 210.0)  # x, y, height, mm: a common bed size
# density (g/cm³), nozzle and bed temperatures (°C)
MATERIALS = {"pla": ("PLA", 1.24, 215, 60), "petg": ("PETG", 1.27, 240, 80), "abs": ("ABS", 1.04, 250, 100)}
COLOURS = {
    "External perimeter": (255, 125, 56),
    "Overhang perimeter": (0, 0, 255),
    "Perimeter": (255, 230, 77),
    "Internal infill": (176, 48, 41),
    "Solid infill": (150, 84, 204),
    "Top solid infill": (240, 64, 64),
    "Bridge infill": (77, 128, 186),
    "Gap fill": (255, 255, 255),
    "Skirt/Brim": (0, 135, 110),
    "Skirt": (0, 135, 110),
    "Support material": (0, 255, 0),
    "Support material interface": (0, 128, 0),
}
# a rotation that turns each axis of the part to point up on the bed
UP = {
    "z": np.eye(3),
    "y": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float),
    "x": np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], float),
}
MOVE = re.compile(r"([XYZEF])(-?\d*\.?\d+)")


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def read_ply(path):
    """Vertices and triangles of a PLY mesh (ASCII or binary; extra vertex properties skipped)."""
    with open(path, "rb") as f:
        data = f.read()
    end = data.index(b"end_header") + len(b"end_header")
    end = data.index(b"\n", end) + 1
    lines = data[:end].decode("ascii", "replace").splitlines()
    fmt = next(l.split()[1] for l in lines if l.startswith("format"))
    elements, current = [], None
    for l in lines:
        w = l.split()
        if w[:1] == ["element"]:
            current = {"name": w[1], "count": int(w[2]), "props": []}
            elements.append(current)
        elif w[:1] == ["property"] and current is not None:
            current["props"].append(w[1:])
    types = {"char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1", "short": "i2", "ushort": "u2", "int16": "i2", "uint16": "u2", "int": "i4", "uint": "u4", "int32": "i4", "uint32": "u4", "float": "f4", "float32": "f4", "double": "f8", "float64": "f8"}
    order = ">" if fmt == "binary_big_endian" else "<"
    vertices, faces = None, []
    if fmt == "ascii":
        rows = iter(data[end:].decode("ascii", "replace").split("\n"))
        for el in elements:
            for _ in range(el["count"]):
                v = next(rows).split()
                if el["name"] == "vertex":
                    names = [p[-1] for p in el["props"]]
                    vertices = vertices if vertices is not None else []
                    vertices.append([float(v[names.index(a)]) for a in "xyz"])
                elif el["name"] == "face":
                    n = int(v[0])
                    faces.append([int(x) for x in v[1 : 1 + n]])
        vertices = np.array(vertices, float)
    else:
        offset = end
        for el in elements:
            if all(p[0] != "list" for p in el["props"]):
                dtype = np.dtype([(p[-1], order + types[p[0]]) for p in el["props"]])
                rows = np.frombuffer(data, dtype, el["count"], offset)
                offset += el["count"] * dtype.itemsize
                if el["name"] == "vertex":
                    vertices = np.stack([rows[a].astype(float) for a in "xyz"], 1)
                continue
            if el["name"] != "face" or len(el["props"]) != 1:
                raise SystemExit("this PLY's faces carry more than their corners: save it as STL instead")
            _, count_t, index_t, _ = el["props"][0]
            ct, it = np.dtype(order + types[count_t]), np.dtype(order + types[index_t])
            for _ in range(el["count"]):
                n = int(np.frombuffer(data, ct, 1, offset)[0])
                faces.append(np.frombuffer(data, it, n, offset + ct.itemsize).tolist())
                offset += ct.itemsize + n * it.itemsize
    if vertices is None or not faces:
        raise SystemExit("this PLY has no faces to print: slice a mesh, not a point cloud")
    # fans for polygons with more than three corners
    tris = [(f[0], f[k], f[k + 1]) for f in faces for k in range(1, len(f) - 1)]
    return vertices, np.array(tris, np.int64)


def read_stl(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) >= 84:
        n = int(np.frombuffer(data, "<u4", 1, 80)[0])
        if 84 + 50 * n == len(data):
            rows = np.frombuffer(data, np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]), n, 84)
            return rows["v"].reshape(-1, 3).astype(float), np.arange(3 * n).reshape(-1, 3)
    v = [[float(x) for x in l.split()[1:4]] for l in data.decode("ascii", "replace").splitlines() if l.strip().startswith("vertex")]
    return np.array(v, float), np.arange(len(v)).reshape(-1, 3)


def write_stl(path, vertices, triangles):
    t = vertices[triangles]
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    rows = np.zeros(len(t), np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rows["n"], rows["v"] = n, t
    with open(path, "wb") as f:
        f.write(b"Pharos slicer".ljust(80, b" "))
        f.write(np.array([len(t)], "<u4").tobytes())
        f.write(rows.tobytes())


def config(path, args, material):
    _, density, nozzle_t, bed_t = material
    settings = {
        "printer_technology": "FFF",
        "bed_shape": f"0x0,{BED[0]:g}x0,{BED[0]:g}x{BED[1]:g},0x{BED[1]:g}",
        "max_print_height": BED[2],
        "nozzle_diameter": 0.4,
        "gcode_flavor": "marlin2",
        "filament_diameter": 1.75,
        "filament_density": density,
        "filament_cost": args.price,
        "temperature": nozzle_t,
        "first_layer_temperature": nozzle_t,
        "bed_temperature": bed_t,
        "first_layer_bed_temperature": bed_t,
        "layer_height": args.layer_height,
        "first_layer_height": max(args.layer_height, 0.2),
        "perimeters": args.walls,
        "top_solid_layers": 5,
        "bottom_solid_layers": 4,
        "fill_density": f"{args.infill:g}%",
        "fill_pattern": "gyroid",
        "skirts": 1,
        "skirt_distance": 3,
        "support_material": 1 if args.supports else 0,
        "support_material_auto": 1,
        "start_gcode": "G28 ; home",
        "end_gcode": "M104 S0\\nM140 S0\\nM84",
    }
    with open(path, "w") as f:
        f.writelines(f"{k} = {v}\n" for k, v in settings.items())


def minutes(text):
    """'1d 2h 3m 4s' as minutes."""
    units = {"d": 1440, "h": 60, "m": 1, "s": 1 / 60}
    return sum(float(n) * units[u] for n, u in re.findall(r"(\d+)([dhms])", text))


def toolpath(gcode, points_wanted=150_000):
    """About `points_wanted` points spread along the extruded lines, each with the colour of what it is, and the G-code's summary comments."""
    pos = np.zeros(4)  # x, y, z, e
    relative_e = False
    kind = "Perimeter"
    starts, ends, kinds, notes, layers = [], [], [], {}, 0
    with open(gcode) as f:
        for line in f:
            if line.startswith(";"):
                if line.startswith(";TYPE:"):
                    kind = line[6:].strip()
                elif line.startswith(";LAYER_CHANGE"):
                    layers += 1
                elif "=" in line:
                    k, _, v = line[1:].partition("=")
                    notes[k.strip()] = v.strip()
                continue
            code = line.split(";", 1)[0].strip()
            if not code:
                continue
            word = code.split()[0]
            if word == "M83":
                relative_e = True
            elif word == "M82":
                relative_e = False
            elif word == "G92":
                for axis, value in MOVE.findall(code):
                    if axis == "E":
                        pos[3] = float(value)
            elif word in ("G0", "G1"):
                new = pos.copy()
                for axis, value in MOVE.findall(code):
                    if axis in "XYZ":
                        new["XYZ".index(axis)] = float(value)
                    elif axis == "E":
                        new[3] = pos[3] + float(value) if relative_e else float(value)
                if word == "G1" and new[3] > pos[3] + 1e-9 and np.any(new[:3] != pos[:3]):
                    starts.append(pos[:3].copy())
                    ends.append(new[:3].copy())
                    kinds.append(COLOURS.get(kind, (200, 200, 200)))
                pos = new
    if not starts:
        raise SystemExit("PrusaSlicer wrote no extrusion: is the part on the bed and bigger than a nozzle?")
    a, b, c = np.array(starts), np.array(ends), np.array(kinds, np.uint8)
    lengths = np.linalg.norm(b - a, axis=1)
    step = max(0.25, lengths.sum() / points_wanted)
    n = np.maximum(1, (lengths / step).astype(int))
    which = np.repeat(np.arange(len(a)), n)
    # where along its line each point sits: evenly, starting half a step in
    within = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n) + 0.5) / np.repeat(n, n)
    points = a[which] + within[:, None] * (b - a)[which]
    return points, c[which], notes, layers


def write_points(path, points, colours):
    header = ["ply", "format binary_little_endian 1.0", "comment up z", "comment a print's toolpath, coloured by what each line is", f"element vertex {len(points)}"]
    header += ["property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", "end_header"]
    v = np.empty(len(points), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    v["x"], v["y"], v["z"] = points.T
    v["r"], v["g"], v["b"] = colours.T
    with open(path, "wb") as f:
        f.write(("\n".join(header) + "\n").encode())
        f.write(v.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--up", default="z", choices=list(UP))
    ap.add_argument("--layer-height", dest="layer_height", type=float, default=0.2)
    ap.add_argument("--walls", type=int, default=3)
    ap.add_argument("--infill", type=float, default=20)
    ap.add_argument("--material", default="pla", choices=list(MATERIALS))
    ap.add_argument("--price", type=float, default=25)
    ap.add_argument("--supports", default="false")
    args = ap.parse_args()
    args.supports = args.supports.lower() == "true"
    material = MATERIALS[args.material]

    progress(0.05, "laying the part on the bed")
    vertices, triangles = read_stl(args.input) if args.input.lower().endswith(".stl") else read_ply(args.input)
    vertices = vertices @ UP[args.up].T
    vertices -= vertices.min(0)
    size = vertices.max(0)
    if size[0] > BED[0] or size[1] > BED[1] or size[2] > BED[2]:
        # try it turned a quarter on the bed before giving up
        if size[1] <= BED[0] and size[0] <= BED[1] and size[2] <= BED[2]:
            vertices = vertices[:, [1, 0, 2]] * [1, -1, 1]
            vertices -= vertices.min(0)
            size = vertices.max(0)
        else:
            raise SystemExit(f"the part is {size[0]:.0f} × {size[1]:.0f} × {size[2]:.0f} mm laid this way up: too big for a {BED[0]:g} × {BED[1]:g} × {BED[2]:g} mm printer")
    work = "/tmp/slice"
    os.makedirs(work, exist_ok=True)
    write_stl(os.path.join(work, "part.stl"), vertices, triangles)
    config(os.path.join(work, "printer.ini"), args, material)

    progress(0.15, "slicing (PrusaSlicer)")
    os.makedirs(args.out, exist_ok=True)
    gcode = os.path.join(args.out, "part.gcode")
    cmd = ["prusa-slicer", "--export-gcode", "--load", os.path.join(work, "printer.ini"), "--center", f"{BED[0] / 2:g},{BED[1] / 2:g}", "--output", gcode, os.path.join(work, "part.stl")]
    run = subprocess.run(cmd, capture_output=True, text=True)
    if run.returncode != 0 or not os.path.exists(gcode):
        print("\n".join(l for l in (run.stdout + run.stderr).splitlines() if "[trace]" not in l and "[debug]" not in l)[-3000:], file=sys.stderr)
        raise SystemExit("PrusaSlicer couldn't slice the part: see the log above")

    progress(0.8, "reading the toolpath")
    points, colours, notes, layers = toolpath(gcode)
    write_points(os.path.join(args.out, "toolpath.ply"), points, colours)
    time_text = notes.get("estimated printing time (normal mode)", "")
    grams = float(notes.get("total filament used [g]", notes.get("filament used [g]", "0")) or 0)
    metres = float(notes.get("filament used [mm]", "0") or 0) / 1000
    cost = float(notes.get("total filament cost", notes.get("filament cost", "0")) or 0)
    row = {
        "print_time": time_text,
        "minutes": round(minutes(time_text), 1),
        "filament_g": round(grams, 1),
        "filament_m": round(metres, 2),
        "cost": round(cost, 2),
        "price_per_kg": args.price,
        "material": material[0],
        "layers": layers,
        "layer_height_mm": args.layer_height,
        "walls": args.walls,
        "infill_percent": args.infill,
        "up": args.up,
        "size_mm": " × ".join(f"{s:.0f}" for s in size),
    }
    with open(os.path.join(args.out, "print.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(row))
        w.writeheader()
        w.writerow(row)
    print(f"{time_text or 'unknown time'}, {grams:.1f} g of {material[0]} ({metres:.1f} m), {cost:.2f} at {args.price:g} per kg; {layers} layers", file=sys.stderr, flush=True)
    progress(1.0, f"{time_text}, {grams:.0f} g")


if __name__ == "__main__":
    main()
