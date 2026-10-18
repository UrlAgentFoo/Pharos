"""
Meshes a STEP part evenly, as a grey PLY that make_part_image.py can draw:
the "A plate to edit" example's picture. Even triangles, because the
picture's painter's-order drawing gets long thin ones (a flat face's own
triangulation) wrong. Run it in the freecad ship's image, then draw it in
the render ship's:

    docker run --rm --user "$(id -u):$(id -g)" --network none -v "$PWD/examples:/ex" \
      pharos/freecad:0.1.0 python3 /ex/make_part_mesh.py /ex/data/mounting-plate.step /ex/plate.ply
    docker run --rm --user "$(id -u):$(id -g)" --network none -e MPLCONFIGDIR=/tmp -v "$PWD/examples:/ex" \
      --entrypoint python pharos/render:0.1.0 /ex/make_part_image.py /ex/images/mounting-plate.webp /ex/plate.ply
    rm examples/plate.ply
"""

import sys

sys.path.append("/usr/lib/freecad-python3/lib")
import FreeCAD  # noqa: E402, F401  (first: it starts FreeCAD, without which its modules crash on import)
import MeshPart  # noqa: E402
import numpy as np  # noqa: E402
import Part  # noqa: E402

GREY = (191, 196, 204)  # the 3D view's


def main(step, out):
    mesh = MeshPart.meshFromShape(Shape=Part.read(step), MaxLength=1.5)
    vertex = np.zeros(len(mesh.Points), [("p", "<f4", 3), ("c", "u1", 3)])
    vertex["p"] = [(p.x, p.y, p.z) for p in mesh.Points]
    vertex["c"] = GREY
    faces = np.zeros(len(mesh.Facets), [("n", "u1"), ("i", "<i4", 3)])
    faces["n"], faces["i"] = 3, [f.PointIndices for f in mesh.Facets]
    header = (
        "ply\nformat binary_little_endian 1.0\ncomment up z\n"
        f"element vertex {len(vertex)}\nproperty float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        f"element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n"
    )
    with open(out, "wb") as fh:
        fh.write(header.encode() + vertex.tobytes() + faces.tobytes())
    print(f"{len(vertex)} points, {len(faces)} triangles")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
