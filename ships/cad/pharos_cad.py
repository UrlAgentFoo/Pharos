"""
cad: parametric parts for Pharos, drawn with Gmsh's OpenCASCADE kernel.

bracket: a shelf bracket, an L of a wall plate and an arm with a rounded
inner corner, optional side ribs (gussets) and screw holes, as a STEP solid
(to test or open in CAD) and a PLY model (to look at). Sizes are in mm: x
runs out from the wall, y across the bracket, z up, so the wall face is the
part's x-min side and the shelf rests on its z-max side. Given a part in
/in/like, the bracket keeps that part's overall size wherever a size is 0,
so a redesign still fits where the old one did.

view: a STEP solid as a PLY model, for windows.

Progress goes to stdout as JSON lines.
"""

import argparse
import contextlib
import glob
import json
import os
import sys

import gmsh
import numpy as np

LIKE = "/in/like"


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def start():
    gmsh.initialize(readConfigFiles=False)
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.option.setNumber("General.Verbosity", 1)


@contextlib.contextmanager
def quiet():
    """OpenCASCADE's STEP reader and writer talk on stdout, where Pharos reads progress: send them to stderr."""
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)


def bounding_box():
    x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(-1, -1)
    return np.array([x0, y0, z0]), np.array([x1, y1, z1])


def import_step(path):
    with quiet():
        gmsh.model.occ.importShapes(path)
    gmsh.model.occ.synchronize()
    if not gmsh.model.getEntities(3):
        raise SystemExit(f"{os.path.basename(path)} holds no solid: open a STEP file of a solid part")


def write_ply(path, vertices, triangles, colours=None, comments=()):
    """A binary PLY of a triangle mesh, with per-vertex colours when given."""
    header = ["ply", "format binary_little_endian 1.0", *[f"comment {c}" for c in comments], f"element vertex {len(vertices)}", "property float x", "property float y", "property float z"]
    fields = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")]
    if colours is not None:
        header += ["property uchar red", "property uchar green", "property uchar blue"]
        fields += [("r", "u1"), ("g", "u1"), ("b", "u1")]
    header += [f"element face {len(triangles)}", "property list uchar int vertex_indices", "end_header"]
    v = np.empty(len(vertices), dtype=fields)
    v["x"], v["y"], v["z"] = vertices[:, 0], vertices[:, 1], vertices[:, 2]
    if colours is not None:
        v["r"], v["g"], v["b"] = colours[:, 0], colours[:, 1], colours[:, 2]
    f = np.empty(len(triangles), dtype=[("n", "u1"), ("i", "<i4", (3,))])
    f["n"], f["i"] = 3, triangles
    with open(path, "wb") as out:
        out.write(("\n".join(header) + "\n").encode())
        out.write(v.tobytes())
        out.write(f.tobytes())


def surface_model(path, detail=80):
    """Meshes the model's surfaces and writes them as a PLY, every triangle facing out of the solid."""
    lo, hi = bounding_box()
    size = float(np.max(hi - lo)) / detail
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size / 8)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 24)
    gmsh.model.mesh.generate(2)
    tags, coords, _ = gmsh.model.mesh.getNodes()
    index = {int(t): i for i, t in enumerate(tags)}
    vertices = coords.reshape(-1, 3)
    # which way each surface faces out of its solid: +1 along its normal, -1 against it
    outward = {}
    for _, vol in gmsh.model.getEntities(3):
        for dim, s in gmsh.model.getBoundary([(3, vol)], oriented=True, combined=False):
            outward[abs(s)] = 1 if s > 0 else -1
    triangles = []
    for _, s in gmsh.model.getEntities(2):
        types, _, nodes = gmsh.model.mesh.getElements(2, s)
        for t, n in zip(types, nodes):
            if t != 2:  # 3-node triangles only
                continue
            tri = np.array([index[int(k)] for k in n]).reshape(-1, 3)
            if not len(tri):
                continue
            # compare the first triangle with the surface's own normal there, then turn the lot to face out
            a, b, c = vertices[tri[0]]
            centre = (a + b + c) / 3
            uv = gmsh.model.getParametrization(2, s, centre.tolist())
            normal = np.array(gmsh.model.getNormal(s, uv)[:3])
            facing = 1 if np.dot(np.cross(b - a, c - a), normal) >= 0 else -1
            if facing * outward.get(s, 1) < 0:
                tri = tri[:, ::-1]
            triangles.append(tri)
    if not triangles:
        raise SystemExit("the part has no surfaces to show")
    write_ply(path, vertices, np.concatenate(triangles), comments=["up z"])


def like_size():
    """The overall size (depth, width, height) of the part in /in/like, or None without one."""
    files = sorted(glob.glob(os.path.join(LIKE, "*")))
    if not files:
        return None
    gmsh.model.add("like")
    import_step(files[0])
    lo, hi = bounding_box()
    gmsh.model.remove()
    return hi - lo


def bracket(args):
    progress(0.05, "drawing the bracket")
    size = like_size()
    gmsh.model.add("bracket")
    D, W, H = (args.depth, args.width, args.height)
    if size is not None:
        D, W, H = (D or float(size[0]), W or float(size[1]), H or float(size[2]))
    D, W, H = (D or 120.0, W or 25.0, H or 120.0)
    t, r, f, n, d = args.thickness, args.rib, args.fillet, args.holes, args.hole_diameter
    if t * 2 >= min(D, H):
        raise SystemExit(f"a {t:g} mm plate is too thick for a {D:g} × {H:g} mm bracket: make it thinner, or the bracket bigger")
    if r and 2 * r + max(d, 4) >= W:
        raise SystemExit(f"two {r:g} mm ribs leave no room across a {W:g} mm bracket: make the ribs thinner or the bracket wider")
    if n and d >= W - 2 * r - 2:
        raise SystemExit(f"{d:g} mm screw holes don't fit across a {W:g} mm bracket between its ribs")

    occ = gmsh.model.occ
    leg = occ.addBox(0, 0, 0, t, W, H)
    arm = occ.addBox(0, 0, H - t, D, W, t)
    body, _ = occ.fuse([(3, leg)], [(3, arm)])
    occ.synchronize()
    if f > 0:
        # the inner corner: the one edge along y at x = t, z = H - t
        e = 1e-3
        edges = gmsh.model.getEntitiesInBoundingBox(t - e, -e, H - t - e, t + e, W + e, H - t + e, 1)
        if edges:
            body = occ.fillet([v for _, v in body], [c for _, c in edges], [min(f, 0.45 * (min(D, H) - t))])
            occ.synchronize()
    if r > 0:
        # a gusset on each side: a triangle under the arm, its corner sunk slightly into the L so the union is clean
        a, b, s = 0.8 * (D - t), 0.8 * (H - t), min(t / 4, 0.5)
        ribs = []
        for y0 in (0.0, W - r):
            p = [occ.addPoint(t - s, y0, H - t + s), occ.addPoint(t + a, y0, H - t + s), occ.addPoint(t - s, y0, H - t - b)]
            loop = occ.addCurveLoop([occ.addLine(p[0], p[1]), occ.addLine(p[1], p[2]), occ.addLine(p[2], p[0])])
            ribs += [dt for dt in occ.extrude([(2, occ.addPlaneSurface([loop]))], 0, r, 0) if dt[0] == 3]
        body, _ = occ.fuse(body, ribs)
        occ.synchronize()
    if n > 0:
        # screw holes through the wall plate, down its middle, below the arm
        low, high = max(2 * d, 0.15 * H), H - t - 2.5 * d
        zs = [0.5 * (low + high)] if n == 1 else list(np.linspace(low, high, n))
        holes = [(3, occ.addCylinder(-1, W / 2, z, t + 2, 0, 0, d / 2)) for z in zs]
        body, _ = occ.cut(body, holes)
        occ.synchronize()
    if len(gmsh.model.getEntities(3)) != 1:
        raise SystemExit("these sizes don't make one solid bracket: try a thicker plate or smaller holes")

    progress(0.4, "writing the solid")
    os.makedirs(args.out, exist_ok=True)
    with quiet():
        gmsh.write(os.path.join(args.out, "bracket.step"))
    progress(0.6, "meshing its surface")
    surface_model(os.path.join(args.out, "bracket.ply"))
    volume = sum(gmsh.model.occ.getMass(3, v) for _, v in gmsh.model.getEntities(3))
    print(f"bracket {D:g} × {W:g} × {H:g} mm, plate {t:g} mm, ribs {r:g} mm, fillet {f:g} mm, {n} holes: {volume / 1000:.1f} cm³", file=sys.stderr, flush=True)
    progress(1.0, f"{volume / 1000:.1f} cm³ of material")


def view(args):
    progress(0.1, "reading the part")
    gmsh.model.add("part")
    import_step(args.input)
    progress(0.4, "meshing its surface")
    surface_model(args.out)
    progress(1.0)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bracket")
    b.add_argument("--out", required=True)
    for name, default in (("depth", 0.0), ("width", 0.0), ("height", 0.0), ("thickness", 4.0), ("rib", 0.0), ("fillet", 2.0), ("hole_diameter", 4.5)):
        b.add_argument(f"--{name.replace('_', '-')}", dest=name, type=float, default=default)
    b.add_argument("--holes", type=int, default=2)
    v = sub.add_parser("view")
    v.add_argument("--in", dest="input", required=True)
    v.add_argument("--out", required=True)
    args = ap.parse_args()
    start()
    try:
        bracket(args) if args.cmd == "bracket" else view(args)
    finally:
        gmsh.finalize()


if __name__ == "__main__":
    main()
