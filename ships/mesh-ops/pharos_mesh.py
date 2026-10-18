"""
Pharos mesh-ops: makes 3D models lighter so they load and turn faster.

  decimate    a PLY mesh -> fewer triangles (quadric decimation), colours kept; a PLY with
              no faces (a point cloud, or a splat saved as .ply) -> fewer points
  thin-splat  a Gaussian splat -> the Gaussians that show most (opacity x size)

Progress goes to stdout as JSON lines.
"""

import argparse
import json
import sys

import numpy as np

TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "<i2", "int16": "<i2", "ushort": "<u2", "uint16": "<u2",
         "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4", "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8"}


# numpy type (without byte order) -> PLY type name, for writing
PLY_TYPE = {"i1": "char", "u1": "uchar", "i2": "short", "u2": "ushort", "i4": "int", "u4": "uint", "f4": "float", "f8": "double"}


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


def read_ply(path):
    """Vertices as a structured array (every property kept) and triangles (or None)."""
    with open(path, "rb") as f:
        data = f.read()
    end = data.find(b"end_header")
    if not data.startswith(b"ply") or end < 0:
        fail("Not a PLY file.")
    body = data.index(b"\n", end) + 1
    lines = data[:end].decode("ascii", "replace").splitlines()
    fmt = next((l.split()[1] for l in lines if l.startswith("format")), "")
    elements = []
    for line in lines:
        parts = line.split()
        if parts and parts[0] == "element":
            elements.append({"name": parts[1], "count": int(parts[2]), "props": []})
        elif parts and parts[0] == "property":
            elements[-1]["props"].append(parts[1:])
    vertex = next((e for e in elements if e["name"] == "vertex"), None)
    if vertex is None or any(p[0] == "list" for p in vertex["props"]):
        fail("The PLY has no plain vertex element.")
    vdtype = np.dtype([(p[1], TYPES[p[0]]) for p in vertex["props"]])
    faces = None
    if fmt == "ascii":
        rows = data[body:].decode("ascii").split("\n")
        vertices = np.array([tuple(float(x) for x in r.split()) for r in rows[: vertex["count"]]], dtype=vdtype)
        face = next((e for e in elements if e["name"] == "face"), None)
        if face and face["count"]:
            faces = np.array([[int(x) for x in r.split()[1:4]] for r in rows[vertex["count"]: vertex["count"] + face["count"]]], dtype=np.int64)
        return vertices, faces, lines
    if fmt != "binary_little_endian":
        fail(f"PLY format {fmt} isn't supported; binary little-endian and ASCII are.")
    offset = body
    for e in elements:
        if e["name"] == "vertex":
            vertices = np.frombuffer(data, dtype=vdtype, count=e["count"], offset=offset).copy()
            offset += vdtype.itemsize * e["count"]
        elif e["name"] == "face" and e["count"]:
            lst = next(p for p in e["props"] if p[0] == "list")
            # faces are almost always triangles stored as (3, a, b, c)
            fdtype = np.dtype([("n", TYPES[lst[1]]), ("v", TYPES[lst[2]], 3)])
            rec = np.frombuffer(data, dtype=fdtype, count=e["count"], offset=offset)
            if (rec["n"] != 3).any():
                fail("Only triangle meshes can be decimated.")
            faces = rec["v"].astype(np.int64)
            offset += fdtype.itemsize * e["count"]
        else:
            break  # other elements after these aren't needed
    return vertices, faces, lines


def write_ply(path, vertices, faces=None, comment=None):
    header = ["ply", "format binary_little_endian 1.0"]
    if comment:
        header.append(f"comment {comment}")
    header.append(f"element vertex {len(vertices)}")
    for name in vertices.dtype.names:
        header.append(f"property {PLY_TYPE[vertices.dtype[name].newbyteorder('<').str.lstrip('<|')]} {name}")
    if faces is not None:
        header += [f"element face {len(faces)}", "property list uchar int vertex_indices"]
    header.append("end_header")
    with open(path, "wb") as f:
        f.write(("\n".join(header) + "\n").encode("ascii"))
        f.write(vertices.tobytes())
        if faces is not None:
            rec = np.empty(len(faces), dtype=[("n", "u1"), ("v", "<i4", 3)])
            rec["n"] = 3
            rec["v"] = faces
            f.write(rec.tobytes())


def importance(v):
    """How much each Gaussian shows: opacity times size; None for plain point clouds."""
    names = v.dtype.names
    if not {"opacity", "scale_0", "scale_1", "scale_2"} <= set(names):
        return None
    opacity = 1 / (1 + np.exp(-v["opacity"].astype(np.float64)))
    return opacity * np.exp(v["scale_0"].astype(np.float64) + v["scale_1"] + v["scale_2"])


def thin(vertices, keep, most):
    """Keeps the share `keep` of points (at most `most`): the Gaussians that show most, or an even sample of plain points."""
    n = len(vertices)
    target = max(1, min(int(round(n * keep)), most or n))
    if target >= n:
        return vertices
    score = importance(vertices)
    if score is None:
        pick = np.sort(np.random.default_rng(0).choice(n, target, replace=False))
    else:
        pick = np.sort(np.argpartition(-score, target - 1)[:target])
    return vertices[pick]


def decimate(args):
    progress(0.05, "reading the model")
    vertices, faces, _ = read_ply(args.mesh)
    if faces is None:
        out = thin(vertices, args.keep, 0)
        write_ply(args.out, out)
        progress(1.0, f"{len(out):,} of {len(vertices):,} points kept")
        return
    import fast_simplification
    from scipy.spatial import cKDTree

    points = np.stack([vertices["x"], vertices["y"], vertices["z"]], 1).astype(np.float64)
    progress(0.2, f"merging {len(faces):,} triangles")
    new_points, new_faces = fast_simplification.simplify(points, faces, target_reduction=1 - args.keep)
    progress(0.8, "carrying the colours over")
    colour = [c for c in ("red", "green", "blue") if c in vertices.dtype.names]
    dtype = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")] + [(c, "u1") for c in colour]
    out = np.empty(len(new_points), dtype=dtype)
    out["x"], out["y"], out["z"] = new_points[:, 0], new_points[:, 1], new_points[:, 2]
    if colour:
        # each new vertex takes the colour of the nearest old one
        _, nearest = cKDTree(points).query(new_points)
        for c in colour:
            out[c] = vertices[c][nearest]
    write_ply(args.out, out, new_faces.astype(np.int64))
    progress(1.0, f"{len(new_faces):,} of {len(faces):,} triangles kept")


def thin_splat(args):
    progress(0.05, "reading the splat")
    vertices, _, _ = read_ply(args.splat)
    if importance(vertices) is None:
        fail("This PLY isn't a Gaussian splat (it has no opacity and scales).")
    out = thin(vertices, args.keep, args.most)
    write_ply(args.out, out)
    progress(1.0, f"{len(out):,} of {len(vertices):,} Gaussians kept")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decimate")
    d.add_argument("--mesh", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--keep", type=float, default=0.25)
    t = sub.add_parser("thin-splat")
    t.add_argument("--splat", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--keep", type=float, default=0.5)
    t.add_argument("--most", type=int, default=0)
    args = p.parse_args()
    if not 0 < args.keep <= 1:
        fail("keep must be more than 0 and at most 1")
    {"decimate": decimate, "thin-splat": thin_splat}[args.cmd](args)


if __name__ == "__main__":
    main()
