"""
Draws the shelf-bracket example's picture into images/: the example part
load-tested, coloured by stress as the fea ship colours it (red at the
root, where it would break), on the 3D view's dark background, at 480 × 300.
It takes the stress model the example's run makes (`pharos warm`), in the
"examples" workspace's artifacts. Run it in the render ship's image, which
has numpy, matplotlib and Pillow:

    docker run --rm --user "$(id -u):$(id -g)" --network none -e MPLCONFIGDIR=/tmp \
      -v "$PWD/examples:/ex" -v ~/Pharos/workspaces/examples/artifacts:/runs:ro \
      --entrypoint python pharos/render:0.1.0 /ex/make_part_image.py /ex/images/shelf-bracket.webp /runs/<id>/stress.ply
"""

import io
import sys

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402
from PIL import Image  # noqa: E402

W, H = 480, 300
BACKGROUND = "#1e1d1b"  # the 3D view's


def read_ply(path):
    data = open(path, "rb").read()
    end = data.index(b"end_header\n") + len(b"end_header\n")
    head = data[:end].decode().splitlines()
    nv = int(next(l for l in head if l.startswith("element vertex")).split()[-1])
    nf = int(next(l for l in head if l.startswith("element face")).split()[-1])
    vd = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    v = np.frombuffer(data, vd, nv, end)
    f = np.frombuffer(data, np.dtype([("n", "u1"), ("i", "<i4", (3,))]), nf, end + nv * vd.itemsize)["i"]
    return np.stack([v["x"], v["y"], v["z"]], 1).astype(float), np.stack([v["r"], v["g"], v["b"]], 1) / 255, f


def main():
    out, ply = sys.argv[1], sys.argv[2]
    p, c, f = read_ply(ply)
    tris = p[f]
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    light = np.array([0.5, -0.7, 0.8])
    shade = 0.5 + 0.5 * np.clip(n @ (light / np.linalg.norm(light)), 0, 1)
    fig = plt.figure(figsize=(W / 100 * 2, H / 100 * 2), dpi=100, facecolor=BACKGROUND)
    ax = fig.add_axes([0, 0, 1, 1], projection="3d", facecolor=BACKGROUND)
    ax.add_collection3d(Poly3DCollection(tris, facecolors=np.clip(c[f].mean(1) * shade[:, None], 0, 1), linewidths=0))
    lo, hi = p.min(0), p.max(0)
    mid, half = (lo + hi) / 2, (hi - lo).max() / 2
    ax.set_xlim(mid[0] - half, mid[0] + half)
    ax.set_ylim(mid[1] - half, mid[1] + half)
    ax.set_zlim(mid[2] - half, mid[2] + half)
    ax.view_init(elev=20, azim=-58)
    ax.set_axis_off()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=BACKGROUND)
    image = Image.open(buf).convert("RGB")
    # framed on the part itself, with an even margin, at the card's shape
    pixels = np.asarray(image).astype(int)
    drawn = np.abs(pixels - pixels[0, 0]).sum(2) > 24
    rows, cols = np.nonzero(drawn.any(1))[0], np.nonzero(drawn.any(0))[0]
    top, bottom, left, right = rows[0], rows[-1], cols[0], cols[-1]
    cy, cx = (top + bottom) / 2, (left + right) / 2
    h = max(bottom - top, (right - left) * H / W) * 1.25
    w = h * W / H
    box = tuple(int(round(v)) for v in (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2))
    framed = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), BACKGROUND)
    framed.paste(image.crop((max(box[0], 0), max(box[1], 0), min(box[2], image.width), min(box[3], image.height))), (max(-box[0], 0), max(-box[1], 0)))
    # drawn larger and averaged down, for smooth edges
    framed.resize((W, H), Image.BOX).save(out, quality=85, method=6)


if __name__ == "__main__":
    main()
