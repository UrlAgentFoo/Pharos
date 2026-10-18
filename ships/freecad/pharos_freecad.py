"""
Pharos freecad: edits STEP parts with FreeCAD's Part module (OpenCASCADE),
with no window. Parts are plain solids with no history, so edits work on
their faces directly; every edit reads a STEP and writes a new one.

  inspect    a part -> its size, faces and holes (JSON) and a 3D model whose
             vertices carry the number of the face they belong to (PLY), so
             an editor can show a face and know which one was clicked
  stretch    makes it longer or shorter along x, y or z: cuts it across and
             fills the gap with its own cross-section (or takes a slice out)
  push-pull  moves a flat face out (adds material) or in (takes it away)
  hole       gives a hole a new diameter, or fills it
  fillet     rounds the edges around a face
  remove     takes features off (fillets, chamfers, holes, bosses) and
             closes the part up where they were
  transform  scales, mirrors, rotates and moves it

Faces are numbered from 1 in the order the STEP file gives them, as FreeCAD
names them (Face7), and the numbers stay the same for the same file. Lengths
are in mm. Progress goes to stdout as JSON lines.
"""

import argparse
import json
import sys

sys.path.append("/usr/lib/freecad-python3/lib")
import FreeCAD  # noqa: E402
import numpy as np  # noqa: E402
import Part  # noqa: E402

V = FreeCAD.Vector
AXES = {"x": V(1, 0, 0), "y": V(0, 1, 0), "z": V(0, 0, 1)}
SURFACE = {"Plane": "flat", "Cylinder": "cylinder", "Cone": "cone", "Sphere": "sphere", "Toroid": "torus"}
EPS = 1e-6


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


def read(path):
    shape = Part.read(path)
    if not shape.Solids:
        fail("this STEP file has no solid in it (only surfaces or wires), so there's nothing to edit")
    return shape


def write(shape, path, message):
    if not shape.isValid():
        shape.fix(1e-7, 1e-7, 1e-7)
    if not shape.isValid() or not shape.Solids:
        fail("the edit left the part broken; try a smaller change, or another face")
    shape.exportStep(path)
    print(message, file=sys.stderr, flush=True)
    progress(1.0, message)


def mm(x):
    return f"{x:.4g} mm"


def r3(v, nd=3):
    return [round(v.x, nd), round(v.y, nd), round(v.z, nd)]


def face(shape, number):
    if not 1 <= number <= len(shape.Faces):
        fail(f"there's no face {number}: this part has faces 1 to {len(shape.Faces)}")
    return shape.Faces[number - 1]


def normal(f):
    """A flat face's normal, pointing out of the part."""
    u0, u1, v0, v1 = f.ParameterRange
    return f.normalAt((u0 + u1) / 2, (v0 + v1) / 2)


def kind(f):
    return SURFACE.get(type(f.Surface).__name__, "curved")


def is_hole(f):
    """A cylinder or cone with the material outside it: its normal points at its axis."""
    s = f.Surface
    if not hasattr(s, "Axis") or kind(f) not in ("cylinder", "cone"):
        return False
    u0, u1, v0, v1 = f.ParameterRange
    u, v = (u0 + u1) / 2, (v0 + v1) / 2
    p = f.valueAt(u, v)
    on_axis = s.Center + s.Axis * (p - s.Center).dot(s.Axis)
    return f.normalAt(u, v).dot(p - on_axis) < 0


def coaxial(a, b):
    sa, sb = a.Surface, b.Surface
    if abs(abs(sa.Axis.dot(sb.Axis)) - 1) > 1e-6:
        return False
    d = sb.Center - sa.Center
    return (d - sa.Axis * d.dot(sa.Axis)).Length < 1e-3


def holes(shape):
    """Holes as groups of faces around one axis (OpenCASCADE often splits a hole's wall in two)."""
    found = []
    for i, f in enumerate(shape.Faces, 1):
        if not is_hole(f):
            continue
        for h in found:
            first = shape.Faces[h["faces"][0] - 1]
            if coaxial(first, f) and (kind(f) == "cone" or abs(f.Surface.Radius - h["radius"]) < 1e-3 or h["kind"] == "cone"):
                h["faces"].append(i)
                if kind(f) == "cylinder" and h["kind"] == "cone":
                    h.update(kind="cylinder", radius=f.Surface.Radius)
                break
        else:
            found.append({"faces": [i], "kind": kind(f), "radius": getattr(f.Surface, "Radius", 0.0)})
    out = []
    for n, h in enumerate((h for h in found if h["kind"] == "cylinder"), 1):
        fs = [shape.Faces[i - 1] for i in h["faces"]]
        axis, base = fs[0].Surface.Axis, fs[0].Surface.Center
        along = [(v.Point - base).dot(axis) for f in fs for v in f.Vertexes] or [0.0]
        lo, hi = min(along), max(along)
        out.append({
            "id": n,
            "faces": h["faces"],
            "diameter": round(2 * h["radius"], 3),
            "depth": round(hi - lo, 3),
            "axis": r3(axis),
            "center": r3(base + axis * ((lo + hi) / 2)),
            "_ends": (base + axis * lo, base + axis * hi, axis),
        })
    return out


# ---------------------------------------------------------------- inspect


def inspect(args):
    progress(0.05, "reading the part")
    shape = read(args.part)
    bb = shape.BoundBox
    faces = []
    for i, f in enumerate(shape.Faces, 1):
        d = {"id": i, "type": kind(f), "area": round(f.Area, 2), "center": r3(f.CenterOfMass)}
        if d["type"] == "flat":
            d["normal"] = r3(normal(f), 4)
            fb = f.BoundBox
            d["size"] = sorted((round(x, 2) for x in (fb.XLength, fb.YLength, fb.ZLength)), reverse=True)[:2]
        elif hasattr(f.Surface, "Radius"):
            d["diameter"] = round(2 * f.Surface.Radius, 3)
            if hasattr(f.Surface, "Axis"):
                d["axis"] = r3(f.Surface.Axis, 4)
            d["hole"] = is_hole(f)
        faces.append(d)
    found = holes(shape)
    summary = {
        "unit": "mm",
        "size": [round(bb.XLength, 3), round(bb.YLength, 3), round(bb.ZLength, 3)],
        "min": [round(bb.XMin, 3), round(bb.YMin, 3), round(bb.ZMin, 3)],
        "max": [round(bb.XMax, 3), round(bb.YMax, 3), round(bb.ZMax, 3)],
        "volume": round(shape.Volume, 2),
        "area": round(shape.Area, 2),
        "solids": len(shape.Solids),
        "faces": faces,
        "holes": [{k: v for k, v in h.items() if not k.startswith("_")} for h in found],
    }
    with open(f"{args.out}/part.json", "w") as fh:
        json.dump(summary, fh, indent=1)
    progress(0.4, f"{len(faces)} faces, {len(found)} hole{'' if len(found) == 1 else 's'}; meshing")
    # each face meshed on its own, so its vertices carry its number and a click finds it
    tol = max(bb.DiagonalLength / 1000, 0.01)
    points, tris, ids = [], [], []
    for i, f in enumerate(shape.Faces, 1):
        pts, ts = f.tessellate(tol)
        if not ts:
            continue
        # a face stored reversed keeps its surface's winding: turn its triangles to face out of the part
        a, b, c = max((tuple(pts[k] for k in t) for t in ts[:50]), key=lambda t: (t[1] - t[0]).cross(t[2] - t[0]).Length)
        u, v = f.Surface.parameter((a + b + c) / 3)
        if (b - a).cross(c - a).dot(f.normalAt(u, v)) < 0:
            ts = [(x, z, y) for x, y, z in ts]
        base = len(points)
        points.extend((p.x, p.y, p.z) for p in pts)
        ids.extend([i] * len(pts))
        tris.extend((a + base, b + base, c + base) for a, b, c in ts)
    write_ply(f"{args.out}/part.ply", np.array(points, "<f4"), np.array(tris, "<i4"), np.array(ids, "<i4"))
    sx, sy, sz = summary["size"]
    progress(1.0, f"{sx:.4g} × {sy:.4g} × {sz:.4g} mm · {len(faces)} faces · {len(found)} hole{'' if len(found) == 1 else 's'}")


def write_ply(path, points, tris, ids):
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        # parts are in mm with z up (CAD's convention); model-view turns the camera to it
        "comment up z\n"
        "comment face_id: the number of the part's face each vertex belongs to (Face1 is 1)\n"
        f"element vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\nproperty int face_id\n"
        f"element face {len(tris)}\nproperty list uchar int vertex_indices\nend_header\n"
    )
    vertex = np.zeros(len(points), dtype=[("p", "<f4", 3), ("id", "<i4")])
    vertex["p"], vertex["id"] = points, ids
    faces = np.zeros(len(tris), dtype=[("n", "u1"), ("v", "<i4", 3)])
    faces["n"], faces["v"] = 3, tris
    with open(path, "wb") as fh:
        fh.write(header.encode())
        fh.write(vertex.tobytes())
        fh.write(faces.tobytes())


# ---------------------------------------------------------------- edits


def halfspace(bb, axis, below, at):
    """A box holding everything of the part on one side of the plane `axis = at`."""
    pad = bb.DiagonalLength + 10
    lo = [bb.XMin - pad, bb.YMin - pad, bb.ZMin - pad]
    hi = [bb.XMax + pad, bb.YMax + pad, bb.ZMax + pad]
    k = "xyz".index(axis)
    if below:
        hi[k] = at
    else:
        lo[k] = at
    return Part.makeBox(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], V(*lo))


def cut_faces(shape, axis, at):
    """The faces a cut across `axis` at `at` left: the part's cross-section there."""
    n = AXES[axis]
    return [f for f in shape.Faces if kind(f) == "flat" and abs(abs(normal(f).dot(n)) - 1) < 1e-6 and abs(f.CenterOfMass.dot(n) - at) < 1e-4]


def stretch(args):
    shape = read(args.part)
    bb = shape.BoundBox
    k = "xyz".index(args.axis)
    lo, length = (bb.XMin, bb.YMin, bb.ZMin)[k], (bb.XLength, bb.YLength, bb.ZLength)[k]
    if args.length <= 0:
        fail("give the new length in mm")
    change = args.length - length
    if abs(change) < 1e-4:
        return write(shape, args.out, f"Already {mm(length)} long in {args.axis}: unchanged")
    at = lo + length * args.at
    if not lo + 1e-3 < at < lo + length - 1e-3 or (change < 0 and at - change > lo + length - 1e-3):
        fail("the cut has to go across the part, with the part on both sides of it: move it nearer the middle, or make a smaller change")
    n = AXES[args.axis]
    progress(0.2, f"cutting it across {args.axis} at {mm(at)}")
    if change > 0:
        a, b = shape.common(halfspace(bb, args.axis, True, at)), shape.common(halfspace(bb, args.axis, False, at))
        section = cut_faces(a, args.axis, at)
        if not section:
            fail("couldn't find the part's cross-section at the cut; try another place along it")
        # (Part.makeCompound ends the process in FreeCAD 1.0 here, so the pieces are fused as a list)
        fill = [f.extrude(n * change) for f in section]
        b.translate(n * change)
        progress(0.6, "filling the gap with its cross-section")
        result = a.fuse([*fill, b]).removeSplitter()
    note = ""
    if change < 0:
        cut = -change
        a, b = shape.common(halfspace(bb, args.axis, True, at)), shape.common(halfspace(bb, args.axis, False, at + cut))
        # the ends only meet cleanly where the part is the same all along the slice it loses
        sa, sb = sum(f.Area for f in cut_faces(a, args.axis, at)), sum(f.Area for f in cut_faces(b, args.axis, at + cut))
        lost = shape.Volume - a.Volume - b.Volume
        if abs(sa - sb) > 0.01 * max(sa, sb, 1e-9) or abs(lost - sa * cut) > 0.01 * max(lost, 1e-9):
            note = "; the part isn't the same all along the slice taken out, so what was there went with it: check it, or cut somewhere else"
        b.translate(n * change)
        progress(0.6, f"taking out a {mm(cut)} slice")
        result = a.fuse(b).removeSplitter()
    write(result, args.out, f"{mm(length)} → {mm(args.length)} long in {args.axis}{note}")


def push_pull(args):
    shape = read(args.part)
    f = face(shape, args.face)
    if kind(f) != "flat":
        fail(f"face {args.face} is {kind(f)}, not flat: only flat faces can be pushed or pulled (for a hole, change its diameter)")
    if abs(args.distance) < 1e-6:
        fail("give a distance: positive pulls the face out, negative pushes it in")
    prism = f.extrude(normal(f) * args.distance)
    progress(0.4, "moving the face")
    result = (shape.fuse(prism) if args.distance > 0 else shape.cut(prism)).removeSplitter()
    write(result, args.out, f"Face {args.face} {'pulled out' if args.distance > 0 else 'pushed in'} {mm(abs(args.distance))}")


def hole(args):
    shape = read(args.part)
    face(shape, args.face)
    h = next((h for h in holes(shape) if args.face in h["faces"]), None)
    if not h:
        fail(f"face {args.face} isn't the wall of a hole")
    progress(0.3, f"filling the {mm(h['diameter'])} hole")
    filled = shape.defeaturing([shape.Faces[i - 1] for i in h["faces"]])
    if not filled.isValid() or abs(filled.Volume - shape.Volume) < 1e-9:
        fail("couldn't fill the hole to redrill it (its shape is too complex); try removing its faces first")
    if args.diameter <= 0:
        return write(filled.removeSplitter(), args.out, f"Hole of {mm(h['diameter'])} filled")
    start, end, axis = h["_ends"]
    # an open end (a through hole's) is drilled a little past, so no skin of material is left there
    if not shape.isInside(start - axis * 0.05, 1e-6, True):
        start = start - axis
    if not shape.isInside(end + axis * 0.05, 1e-6, True):
        end = end + axis
    progress(0.6, f"drilling it at {mm(args.diameter)}")
    drill = Part.makeCylinder(args.diameter / 2, (end - start).Length, start, axis)
    write(filled.cut(drill).removeSplitter(), args.out, f"Hole {mm(h['diameter'])} → {mm(args.diameter)}")


def fillet(args):
    shape = read(args.part)
    f = face(shape, args.face)
    if args.radius <= 0:
        fail("give the radius in mm")
    progress(0.3, f"rounding the {len(f.Edges)} edges around face {args.face}")
    try:
        result = shape.makeFillet(args.radius, [e for e in shape.Edges if any(e.isSame(x) for x in f.Edges)])
    except Exception:
        fail(f"couldn't round those edges at {mm(args.radius)}: try a smaller radius")
    write(result, args.out, f"Edges of face {args.face} rounded at {mm(args.radius)}")


def remove(args):
    shape = read(args.part)
    try:
        numbers = sorted({int(x) for x in args.faces.replace(";", ",").split(",") if x.strip()})
    except ValueError:
        fail("list the faces to take off by number, separated by commas (3, 7)")
    if not numbers:
        fail("list the faces to take off by number (3, 7)")
    progress(0.3, f"taking off {len(numbers)} face{'' if len(numbers) == 1 else 's'}")
    result = shape.defeaturing([face(shape, n) for n in numbers])
    if not result.isValid() or result.isSame(shape) or len(result.Faces) == len(shape.Faces) and abs(result.Volume - shape.Volume) < 1e-9:
        fail("couldn't take those faces off and close the part up: pick all the faces of one feature (a fillet, a hole, a boss)")
    write(result.removeSplitter(), args.out, f"Took off face{'' if len(numbers) == 1 else 's'} {', '.join(map(str, numbers))}")


def transform(args):
    shape = read(args.part)
    centre = shape.BoundBox.Center
    done = []
    if abs(args.scale - 1) > 1e-9:
        if args.scale <= 0:
            fail("the scale has to be above 0")
        shape.scale(args.scale, centre)
        done.append(f"scaled × {args.scale:g}")
    if args.mirror != "none":
        shape = shape.mirror(centre, AXES[args.mirror])
        done.append(f"mirrored across {args.mirror}")
    for axis in "xyz":
        angle = getattr(args, f"rotate_{axis}")
        if abs(angle) > 1e-9:
            shape.rotate(centre, AXES[axis], angle)
            done.append(f"turned {angle:g}° about {axis}")
    move = V(args.move_x, args.move_y, args.move_z)
    if move.Length > 1e-9:
        shape.translate(move)
        done.append(f"moved {', '.join(f'{c:g}' for c in (move.x, move.y, move.z))} mm")
    write(shape, args.out, (", ".join(done) or "unchanged").capitalize())


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("inspect")
    p.add_argument("--part", required=True)
    p.add_argument("--out", required=True, help="a folder: part.json and part.ply go in it")
    edits = {}
    for name, fn in (("stretch", stretch), ("push-pull", push_pull), ("hole", hole), ("fillet", fillet), ("remove", remove), ("transform", transform)):
        p = sub.add_parser(name)
        p.add_argument("--part", required=True)
        p.add_argument("--out", required=True, help="the new STEP file")
        edits[name] = fn
        if name == "stretch":
            p.add_argument("--axis", choices=list(AXES), default="x")
            p.add_argument("--length", type=float, required=True)
            p.add_argument("--at", type=float, default=0.5)
        elif name == "push-pull":
            p.add_argument("--face", type=int, required=True)
            p.add_argument("--distance", type=float, required=True)
        elif name == "hole":
            p.add_argument("--face", type=int, required=True)
            p.add_argument("--diameter", type=float, required=True)
        elif name == "fillet":
            p.add_argument("--face", type=int, required=True)
            p.add_argument("--radius", type=float, required=True)
        elif name == "remove":
            p.add_argument("--faces", required=True)
        else:
            for axis in "xyz":
                p.add_argument(f"--move-{axis}", dest=f"move_{axis}", type=float, default=0.0)
                p.add_argument(f"--rotate-{axis}", dest=f"rotate_{axis}", type=float, default=0.0)
            p.add_argument("--scale", type=float, default=1.0)
            p.add_argument("--mirror", choices=["none", *AXES], default="none")
    args = ap.parse_args()
    inspect(args) if args.cmd == "inspect" else edits[args.cmd](args)


if __name__ == "__main__":
    main()
