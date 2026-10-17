"""
Draws the start screen's example pictures into images/: one 480 × 300 WebP
per example in examples.yaml. Microscopy comes from the example's own data,
max-projected and coloured by time (time-lapses) or depth (stacks). Flow
comes from a solved copy of the case, since the case itself holds no flow
yet: the examples' runs make one (`pharos warm`), in the "examples"
workspace's artifacts. Run it in the render ship's image, which has numpy,
scipy, tifffile, zarr, PyYAML and Pillow:

    docker run --rm --user "$(id -u):$(id -g)" --network none \
      -v "$PWD/examples:/ex" -v "$PWD/books:/books:ro" -v ~/Pharos/workspaces/examples/artifacts:/solved:ro \
      --entrypoint python pharos/render:0.1.0 /ex/make_images.py /ex \
      --solved cylinder-flow=/solved/<id>/case --solved backward-step=/solved/<id>/case ...

Flow examples without --solved are skipped.
"""

import argparse
import os
import sys

import numpy as np
import tifffile
import yaml
from PIL import Image

sys.path.insert(0, "/opt/pharos")
from pharos_render import diverging, foam_times, read, read_foam_field  # noqa: E402

W, H = 480, 300

# what each flow picture shows, in the case's metres: x from, x to, and the centre in y
# (the height follows from the picture's shape); other cases show their whole domain
WINDOWS = {
    "cylinder-flow": (-1.5, 10.1, 0.65),
    "tandem-blocks": (-1.5, 10.1, 0.65),
    "slot-jet": (-1.5, 10.1, 0.1),
    "backward-step": (-1.5, 6.5, 1.5),
}


# ---------------------------------------------------------------- microscopy

# early to late, or near to far: violet, blue, teal, green, yellow, orange
STOPS = np.array([[130, 100, 240], [60, 140, 245], [40, 205, 205], [120, 225, 110], [250, 210, 70], [250, 135, 70]], np.float32)


def lut(v):
    x = np.clip(v, 0, 1) * (len(STOPS) - 1)
    i = np.minimum(np.asarray(x).astype(int), len(STOPS) - 2)
    f = np.asarray(x - i)[..., None]
    return STOPS[i] * (1 - f) + STOPS[i + 1] * f


def load(path):
    """An image's array and its axes in lowercase ("tzyx", "yx", ...)."""
    if path.endswith(".zarr"):
        data, names, _ = read(path)
        return data, names.lower()
    with tifffile.TiffFile(path) as f:
        series = f.series[0]
        return series.asarray(), series.axes.lower()


def microscopy(path):
    data, axes = load(path)
    if "c" in axes:
        data, axes = np.take(data, 0, axis=axes.index("c")), axes.replace("c", "")
    data = data.astype(np.float32)
    # from the median (the background, in these sparse images) so the background is black like the margins
    lo, hi = np.percentile(data, [50, 99.8])
    data = np.clip((data - lo) / max(hi - lo, 1e-6), 0, 1) ** 0.8
    if "t" in axes and "z" in axes:
        data, axes = data.max(axis=axes.index("z")), axes.replace("z", "")
    coded = "t" if "t" in axes else "z" if "z" in axes else None
    if coded:
        # each plane tinted by its place in time or depth, then the brightest wins
        stack = np.moveaxis(data, axes.index(coded), 0)
        rgb = np.zeros(stack.shape[1:] + (3,), np.float32)
        for k, plane in enumerate(stack):
            rgb = np.maximum(rgb, plane[..., None] * lut(k / max(len(stack) - 1, 1)))
    else:
        rgb = data[..., None] * lut(0.4)
    picture = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    # the whole field, as large as fits, on its own background (the median of its edges)
    edges = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    background = tuple(int(v) for v in np.clip(np.median(edges, axis=0), 0, 255))
    scale = min(W / picture.width, H / picture.height)
    picture = picture.resize((round(picture.width * scale), round(picture.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), background)
    canvas.paste(picture, ((W - picture.width) // 2, (H - picture.height) // 2))
    return canvas


# ---------------------------------------------------------------- flow


def flow(case, window):
    """The vorticity at the last saved time, in the window; solids (obstacles, and beyond the walls) in grey."""
    from scipy.interpolate import LinearNDInterpolator
    from scipy.ndimage import binary_dilation, distance_transform_edt
    from scipy.spatial import cKDTree

    times = [t for t in foam_times(case) if float(t) > 0]
    if not times:
        raise SystemExit(f"{case} hasn't been simulated: pass a solved copy")
    xy = read_foam_field(os.path.join(case, "0", "C"))[:, :2]
    if window:
        x0, x1, yc = window
    else:
        (x0, y0), (x1, y1) = xy.min(axis=0), xy.max(axis=0)
        yc = (y0 + y1) / 2
    # drawn at twice the size, then halved, so obstacle edges are smooth
    w, h = 2 * W, 2 * H
    px = (x1 - x0) / w
    gx, gy = np.meshgrid(x0 + (np.arange(w) + 0.5) * px, yc + (np.arange(h) - h / 2 + 0.5) * px)
    pixels = np.stack([gx.ravel(), gy.ravel()], axis=1)
    tree = cKDTree(xy)
    dist, nearest = tree.query(pixels)
    spacing, _ = tree.query(xy, k=5)
    solid = (dist > 0.75 * spacing[nearest, 4] + 0.5 * px).reshape(h, w)
    u = read_foam_field(os.path.join(case, times[-1], "U"))
    uv = LinearNDInterpolator(xy, u[:, :2])(pixels).reshape(h, w, 2)
    # between the outermost cell centres and the walls there's nothing to interpolate: those pixels
    # (and their neighbours, whose gradients they'd spoil) take the vorticity of the nearest pixel that has one
    gap = binary_dilation(np.isnan(uv[..., 0]) & ~solid, iterations=2) & ~solid
    uv = np.nan_to_num(uv)
    f = np.gradient(uv[..., 1], px, axis=1) - np.gradient(uv[..., 0], px, axis=0)
    if gap.any():
        _, (iy, ix) = distance_transform_edt(gap | solid, return_indices=True)
        f[gap] = f[iy[gap], ix[gap]]
    f[solid] = np.nan
    scale = np.nanpercentile(np.abs(f), 99) or 1.0
    rgb = diverging(np.nan_to_num(f / scale))
    rgb[np.isnan(f)] = (60, 60, 60)
    # y up; averaged down (Lanczos would ring into a white halo along dark edges)
    return Image.fromarray(rgb[::-1]).resize((W, H), Image.BOX)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("examples", help="this folder")
    ap.add_argument("--solved", action="append", default=[], metavar="ID=CASE", help="a solved copy of a flow example's case")
    args = ap.parse_args()
    solved = dict(s.split("=", 1) for s in args.solved)
    with open(os.path.join(args.examples, "examples.yaml")) as f:
        examples = yaml.safe_load(f)
    os.makedirs(os.path.join(args.examples, "images"), exist_ok=True)
    for e in examples:
        path = os.path.normpath(os.path.join(args.examples, e["files"][0]["path"]))
        if os.path.isdir(os.path.join(path, "system")):
            if e["id"] not in solved:
                print(f"{e['id']}: skipped (no --solved case)")
                continue
            picture = flow(solved[e["id"]], WINDOWS.get(e["id"]))
        else:
            picture = microscopy(path)
        out = os.path.join(args.examples, "images", f"{e['id']}.webp")
        picture.save(out, quality=85, method=6)
        print(f"{e['id']}: {os.path.getsize(out) // 1024} KB")


if __name__ == "__main__":
    main()
