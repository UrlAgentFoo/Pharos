"""
Makes test/<operation>/part.step: a plate 80 × 30 × 8 mm with two 6 mm through
holes, a round boss on top and rounded vertical corners, so every edit has
something to work on. The start screen's "A plate to edit" is the same part
(examples/data/mounting-plate.step). Run it in this ship's image:

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/ships/freecad:/ship" pharos/freecad:0.1.0 python3 /ship/make_test_part.py /ship/test
"""

import os
import sys

sys.path.append("/usr/lib/freecad-python3/lib")
import FreeCAD  # noqa: E402
import Part  # noqa: E402

V = FreeCAD.Vector


def part():
    plate = Part.makeBox(80, 30, 8)
    # the four vertical corners rounded
    plate = plate.makeFillet(4, [e for e in plate.Edges if abs(e.Vertexes[0].Z - e.Vertexes[1].Z) > 1])
    boss = Part.makeCylinder(7, 6, V(40, 15, 8))
    shape = plate.fuse(boss).removeSplitter()
    for x in (14, 66):
        shape = shape.cut(Part.makeCylinder(3, 10, V(x, 15, -1)))
    return shape.removeSplitter()


def main(out):
    shape = part()
    for op in ("inspect", "stretch", "push-pull", "hole", "fillet", "remove", "transform"):
        os.makedirs(os.path.join(out, op), exist_ok=True)
        shape.exportStep(os.path.join(out, op, "part.step"))
    print(f"{len(shape.Faces)} faces, volume {shape.Volume:.0f} mm³")


if __name__ == "__main__":
    main(sys.argv[1])
