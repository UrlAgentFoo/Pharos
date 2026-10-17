"""
fea: does a part hold? A load test for Pharos, with Gmsh and CalculiX.

load-test: meshes a STEP solid into quadratic tetrahedra (Gmsh), holds one
side of it still and pushes evenly on another with the load you choose
(CalculiX, linear static), then compares the peak stress with the
material's strength: the safety factor. It writes the part as a PLY model
coloured by stress (blue unstressed, through green and yellow, to red at
the material's strength) and a one-row table of the numbers.

Sides are the faces lying on the part's bounding box: for a bracket from the
cad ship, x-min is the wall face and z-max the face a shelf rests on. The
peak leaves out the held face and two elements' depth beside it, where
holding every point perfectly still makes the stress larger than screws and
a wall would. A quick
check of a design, not a certificate: printed parts are weaker across their
layers, which is what a safety factor of 2 or more is for.

Sizes in mm, loads in N, stresses in MPa. Progress goes to stdout as JSON lines.
"""

import argparse
import contextlib
import csv
import json
import os
import re
import subprocess
import sys

import gmsh
import numpy as np

# name, Young's modulus (MPa), Poisson's ratio, strength (MPa): typical values for printed plastics (along
# their layers) and common metals (yield)
MATERIALS = {
    "pla": ("PLA", 3500, 0.36, 50),
    "petg": ("PETG", 2100, 0.38, 50),
    "abs": ("ABS", 2200, 0.35, 40),
    "nylon": ("Nylon (PA12)", 1800, 0.39, 48),
    "aluminium": ("Aluminium 6061-T6", 69000, 0.33, 276),
    "steel": ("Steel S235", 210000, 0.30, 235),
}
SIDES = {"x-min": (0, 0), "x-max": (0, 1), "y-min": (1, 0), "y-max": (1, 1), "z-min": (2, 0), "z-max": (2, 1)}
# Gmsh's 10-node tetrahedron numbers its last two edge nodes the other way round from CalculiX's C3D10
GMSH_TO_CCX = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]
# a C3D10's faces by their corner nodes, as CalculiX numbers them (P1..P4)
FACES = [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)]
# each face's edge nodes, in C3D10 order: the edge from its first corner to its second, second to third, third to first
EDGE_NODE = {(0, 1): 4, (1, 2): 5, (2, 0): 6, (0, 3): 7, (1, 3): 8, (2, 3): 9}
NODE_LINE = re.compile(r" -1\s*(\d+)")
VALUE = re.compile(r"-?\d+\.\d+E[+-]\d+")
# blue, light blue, green, yellow, red: none (0) to the material's strength (1)
STOPS = np.array([[40, 70, 170], [45, 150, 220], [90, 190, 110], [245, 200, 60], [215, 40, 40]], float)


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


@contextlib.contextmanager
def quiet():
    """OpenCASCADE's STEP reader talks on stdout, where Pharos reads progress: send it to stderr."""
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)


def mesh(path, element_size):
    """The part as quadratic tetrahedra: node coordinates and C3D10 connectivity (0-based)."""
    gmsh.initialize(readConfigFiles=False)
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.option.setNumber("General.Verbosity", 1)
    try:
        with quiet():
            gmsh.model.occ.importShapes(path)
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(3)
        if not volumes:
            raise SystemExit(f"{os.path.basename(path)} holds no solid: load-test a STEP file of a solid part")
        if len(volumes) > 1:
            gmsh.model.occ.fuse(volumes[:1], volumes[1:])
            gmsh.model.occ.synchronize()
        x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(-1, -1)
        # about two quadratic elements through the thinnest walls, which bending needs (a plate's
        # thickness is twice its volume over its surface area); finer changes the answer by a few percent
        volume = sum(gmsh.model.occ.getMass(3, v) for _, v in gmsh.model.getEntities(3))
        area = sum(gmsh.model.occ.getMass(2, f) for _, f in gmsh.model.getEntities(2))
        size = element_size or min(max(x1 - x0, y1 - y0, z1 - z0) / 45, 1.2 * volume / area)
        gmsh.option.setNumber("Mesh.MeshSizeMax", size)
        gmsh.option.setNumber("Mesh.MeshSizeMin", size / 6)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 12)
        gmsh.option.setNumber("Mesh.ElementOrder", 2)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        gmsh.model.mesh.generate(3)
        tags, coords, _ = gmsh.model.mesh.getNodes()
        _, nodes = gmsh.model.mesh.getElementsByType(11)
    finally:
        gmsh.finalize()
    if not len(nodes):
        raise SystemExit("Gmsh couldn't fill the part with elements: is it a closed solid?")
    index = np.full(int(tags.max()) + 1, -1, np.int64)
    index[tags.astype(np.int64)] = np.arange(len(tags))
    tets = index[nodes.astype(np.int64)].reshape(-1, 10)[:, GMSH_TO_CCX]
    used = np.unique(tets)
    # only the nodes the elements use (Gmsh also keeps the geometry's own points), numbered from 0
    renumber = np.full(len(tags), -1, np.int64)
    renumber[used] = np.arange(len(used))
    return coords.reshape(-1, 3)[used], renumber[tets], size


def side_nodes(xyz, side, tol):
    axis, high = SIDES[side]
    edge = xyz[:, axis].max() if high else xyz[:, axis].min()
    return np.abs(xyz[:, axis] - edge) < tol


def loaded_faces(xyz, tets, on_side):
    """(element, face number 1-4, area) of every element face lying on the loaded side."""
    out = []
    for f, (a, b, c) in enumerate(FACES):
        hit = on_side[tets[:, a]] & on_side[tets[:, b]] & on_side[tets[:, c]]
        for e in np.nonzero(hit)[0]:
            p, q, r = xyz[tets[e, a]], xyz[tets[e, b]], xyz[tets[e, c]]
            out.append((e, f + 1, 0.5 * np.linalg.norm(np.cross(q - p, r - p))))
    return out


def write_inp(path, xyz, tets, fixed, faces, pressure, modulus, poisson):
    with open(path, "w") as f:
        f.write("*HEADING\nPharos load test\n*NODE, NSET=NALL\n")
        f.writelines(f"{i + 1}, {x:.9g}, {y:.9g}, {z:.9g}\n" for i, (x, y, z) in enumerate(xyz))
        f.write("*ELEMENT, TYPE=C3D10, ELSET=EALL\n")
        f.writelines(f"{e + 1}, " + ", ".join(str(n + 1) for n in t) + "\n" for e, t in enumerate(tets))
        f.write("*NSET, NSET=FIXED\n")
        ids = np.nonzero(fixed)[0] + 1
        for k in range(0, len(ids), 12):
            f.write(", ".join(str(i) for i in ids[k : k + 12]) + "\n")
        f.write(f"*BOUNDARY\nFIXED, 1, 3, 0.\n*MATERIAL, NAME=PART\n*ELASTIC\n{modulus}, {poisson}\n*SOLID SECTION, ELSET=EALL, MATERIAL=PART\n")
        f.write("*STEP\n*STATIC\n*DLOAD\n")
        f.writelines(f"{e + 1}, P{face}, {pressure:.9g}\n" for e, face, _ in faces)
        f.write("*NODE FILE\nU\n*EL FILE\nS\n*END STEP\n")


def read_frd(path, count):
    """Displacements (n × 3) and stresses (n × 6: xx, yy, zz, xy, yz, zx) at the nodes, from CalculiX's results file."""
    disp, stress = np.zeros((count, 3)), np.zeros((count, 6))
    block = None
    with open(path) as f:
        for line in f:
            if line.startswith(" -4"):
                name = line[4:12].strip()
                block = disp if name == "DISP" else stress if name == "STRESS" else None
            elif line.startswith(" -3"):
                block = None
            elif block is not None and line.startswith(" -1"):
                # the node, then its values, which can touch ("-1.2E+00-3.4E+00"), in CalculiX's short or long columns
                m = NODE_LINE.match(line)
                values = [float(v) for v in VALUE.findall(line, m.end())][: block.shape[1]]
                block[int(m.group(1)) - 1, : len(values)] = values
    return disp, stress


def von_mises(s):
    xx, yy, zz, xy, yz, zx = s.T
    return np.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy**2 + yz**2 + zx**2))


def colour(fraction):
    t = np.clip(fraction, 0, 1) * (len(STOPS) - 1)
    k = np.minimum(t.astype(int), len(STOPS) - 2)
    w = (t - k)[:, None]
    return (STOPS[k] * (1 - w) + STOPS[k + 1] * w).round().astype(np.uint8)


def surface(xyz, tets):
    """The part's outer surface: each boundary face of a quadratic tetrahedron as 4 triangles, all facing out."""
    corners = np.sort(np.concatenate([tets[:, list(face)] for face in FACES]), axis=1)
    owner = np.tile(np.arange(len(tets)), len(FACES))
    which = np.repeat(np.arange(len(FACES)), len(tets))
    _, first, counts = np.unique(corners, axis=0, return_index=True, return_counts=True)
    triangles = []
    for i in first[counts == 1]:
        t, (a, b, c) = tets[owner[i]], FACES[which[i]]
        ab, bc, ca = (t[EDGE_NODE.get((a, b)) or EDGE_NODE[(b, a)]], t[EDGE_NODE.get((b, c)) or EDGE_NODE[(c, b)]], t[EDGE_NODE.get((c, a)) or EDGE_NODE[(a, c)]])
        a, b, c = t[a], t[b], t[c]
        # out of the element: away from its centre
        centre = xyz[t[:4]].mean(0)
        if np.dot(np.cross(xyz[b] - xyz[a], xyz[c] - xyz[a]), xyz[a] - centre) < 0:
            a, b, c, ab, bc, ca = a, c, b, ca, bc, ab
        triangles += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
    triangles = np.array(triangles)
    keep = np.unique(triangles)
    renumber = np.full(len(xyz), -1, np.int64)
    renumber[keep] = np.arange(len(keep))
    return keep, renumber[triangles]


def write_ply(path, vertices, triangles, colours, comments=()):
    header = ["ply", "format binary_little_endian 1.0", *[f"comment {c}" for c in comments], f"element vertex {len(vertices)}"]
    header += ["property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue"]
    header += [f"element face {len(triangles)}", "property list uchar int vertex_indices", "end_header"]
    v = np.empty(len(vertices), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    v["x"], v["y"], v["z"] = vertices.T
    v["r"], v["g"], v["b"] = colours.T
    f = np.empty(len(triangles), dtype=[("n", "u1"), ("i", "<i4", (3,))])
    f["n"], f["i"] = 3, triangles
    with open(path, "wb") as out:
        out.write(("\n".join(header) + "\n").encode())
        out.write(v.tobytes())
        out.write(f.tobytes())


def verdict(factor, target):
    if factor < 1:
        return "would break"
    if factor < target:
        return "too weak"
    return "passes"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--load", type=float, required=True)
    ap.add_argument("--material", default="pla", choices=list(MATERIALS))
    ap.add_argument("--fixed", default="x-min", choices=list(SIDES))
    ap.add_argument("--loaded", default="z-max", choices=list(SIDES))
    ap.add_argument("--target", type=float, default=2.0)
    ap.add_argument("--element-size", dest="element_size", type=float, default=0.0)
    args = ap.parse_args()
    if args.fixed == args.loaded:
        raise SystemExit(f"the part can't be held and loaded on the same side ({args.fixed})")
    title, modulus, poisson, strength = MATERIALS[args.material]

    progress(0.05, "meshing the part")
    xyz, tets, size = mesh(args.input, args.element_size)
    tol = 1e-4 * float(np.ptp(xyz, axis=0).max())
    fixed = side_nodes(xyz, args.fixed, tol)
    loaded = side_nodes(xyz, args.loaded, tol)
    faces = loaded_faces(xyz, tets, loaded)
    if not fixed.any():
        raise SystemExit(f"no face of the part lies flat on its {args.fixed} side to hold it by")
    if not faces:
        raise SystemExit(f"no face of the part lies flat on its {args.loaded} side to push on")
    area = sum(a for _, _, a in faces)
    pressure = args.load / area
    progress(0.3, f"{len(tets)} elements, {len(xyz)} nodes; {args.load:g} N over {area / 100:.1f} cm²")

    work = "/tmp/fea"
    os.makedirs(work, exist_ok=True)
    write_inp(os.path.join(work, "part.inp"), xyz, tets, fixed, faces, pressure, modulus, poisson)
    progress(0.35, "solving (CalculiX)")
    # one thread: Debian's CalculiX solves wrongly, and differently each time, with SPOOLES on several
    env = {**os.environ, "OMP_NUM_THREADS": "1", "CCX_NPROC_EQUATION_SOLVER": "1"}
    run = subprocess.run(["ccx", "-i", "part"], cwd=work, env=env, capture_output=True, text=True)
    log = run.stdout + run.stderr
    if run.returncode != 0 or "*ERROR" in log or not os.path.exists(os.path.join(work, "part.frd")):
        print(log[-3000:], file=sys.stderr)
        raise SystemExit("CalculiX couldn't solve the load test: see the log above")
    progress(0.85, "reading the stresses")
    disp, stress = read_frd(os.path.join(work, "part.frd"), len(xyz))
    vm = von_mises(stress)
    # the peak away from the held face (two elements' depth), where holding every point perfectly
    # still overstates the stress
    axis, high = SIDES[args.fixed]
    edge = xyz[:, axis].max() if high else xyz[:, axis].min()
    near = np.abs(xyz[:, axis] - edge) < 2 * size
    peak_node = int(np.argmax(np.where(near, -np.inf, vm)))
    peak = float(vm[peak_node])
    moved = float(np.linalg.norm(disp, axis=1).max())
    factor = strength / peak if peak > 0 else float("inf")

    os.makedirs(args.out, exist_ok=True)
    keep, triangles = surface(xyz, tets)
    write_ply(
        os.path.join(args.out, "stress.ply"),
        xyz[keep],
        triangles,
        colour(vm[keep] / strength),
        comments=["up z", f"von Mises stress, blue 0 to red {strength} MPa ({title}'s strength)", f"safety factor {factor:.2f}"],
    )
    row = {
        "verdict": verdict(factor, args.target),
        "safety_factor": round(factor, 2),
        "target": args.target,
        "peak_stress_mpa": round(peak, 2),
        "strength_mpa": strength,
        "material": title,
        "load_n": args.load,
        "max_bend_mm": round(moved, 3),
        "peak_at_mm": " ".join(f"{c:.1f}" for c in xyz[peak_node]),
        "elements": len(tets),
        "nodes": len(xyz),
    }
    with open(os.path.join(args.out, "results.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(row))
        w.writeheader()
        w.writerow(row)
    print(f"{args.load:g} N: peak {peak:.1f} MPa against {title}'s {strength} MPa, safety factor {factor:.2f} ({row['verdict']}); bends {moved:.2f} mm", file=sys.stderr, flush=True)
    progress(1.0, f"safety factor {factor:.2f}: {row['verdict']}")


if __name__ == "__main__":
    main()
