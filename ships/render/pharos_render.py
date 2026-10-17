"""
render: videos of images, and of tracks drawn over them, for Pharos.

  video        /in/image (OME-Zarr) → /out/video.mp4, a max projection along z per time point
  tracks-video /in/image + /in/tracks (CSV: track_id, t, [z,] y, x in pixels, as Ultrack writes them)
               → /out/video.mp4 with each track's recent path drawn over the projection
  flow-video   /in/case (a solved OpenFOAM case, ASCII fields, cell centres in 0/C)
               → /out/video.mp4 of vorticity or speed in the x-y plane, one frame per written time

Progress goes to stdout as JSON lines.
"""

import argparse
import csv
import json
import os

import imageio.v3 as iio
import numpy as np
import zarr
from PIL import Image, ImageDraw


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def read(path):
    group = zarr.open_group(path, mode="r")
    attrs = dict(group.attrs)
    ms = attrs.get("ome", attrs)["multiscales"][0]
    names = "".join(a["name"] if isinstance(a, dict) else a for a in ms["axes"])
    level = ms["datasets"][0]
    data = np.asarray(zarr.open_array(os.path.join(path, level["path"]), mode="r")[...])
    scale = [1.0] * len(names)
    for t in level.get("coordinateTransformations", []):
        if t.get("type") == "scale":
            scale = list(t["scale"])
    return data, names, dict(zip(names, scale))


def frames(data, names, channel):
    """One 2D grey frame per time point: the chosen channel, max-projected along z, scaled to 8 bits."""
    if "c" in names:
        data = np.take(data, channel, axis=names.index("c"))
        names = names.replace("c", "")
    if "t" not in names:
        data, names = data[None], "t" + names
    if "z" in names:
        data = data.max(axis=names.index("z"))
    lo, hi = np.percentile(data, [1, 99.8])
    scaled = np.clip((data.astype(np.float32) - lo) / max(hi - lo, 1e-6), 0, 1)
    return (scaled * 255).astype(np.uint8)


def upscale(frame, target=512):
    """Nearest-neighbour upscale so small images make a watchable video (even sides, as H.264 wants)."""
    f = max(1, target // max(frame.shape))
    out = np.kron(frame, np.ones((f, f), np.uint8))
    return out[: out.shape[0] // 2 * 2, : out.shape[1] // 2 * 2], f


def colour(track_id):
    rng = np.random.default_rng(int(track_id))
    h = rng.uniform(0, 1)
    # bright, saturated colour from a hue
    k = lambda n: (n + h * 6) % 6
    f = lambda n: 1 - max(0, min(k(n), 4 - k(n), 1))
    return tuple(int(255 * v) for v in (f(5), f(3), f(1)))


def cmd_video(args):
    data, names, _ = read(args.image)
    grey = frames(data, names, args.channel)
    out = []
    for i, f in enumerate(grey):
        big, _ = upscale(f)
        out.append(np.stack([big] * 3, axis=-1))
        progress((i + 1) / len(grey) * 0.9, f"frame {i + 1} of {len(grey)}")
    iio.imwrite(args.out, np.stack(out), fps=args.fps, codec="libx264")
    progress(1.0, "done")


def cmd_tracks(args):
    data, names, _ = read(args.image)
    grey = frames(data, names, args.channel)
    with open(args.tracks) as f:
        rows = list(csv.DictReader(f))
    by_track = {}
    for r in rows:
        by_track.setdefault(r["track_id"], []).append((int(float(r["t"])), float(r["y"]), float(r["x"])))
    for pts in by_track.values():
        pts.sort()
    out = []
    for t, f in enumerate(grey):
        big, k = upscale(f)
        img = Image.fromarray(np.stack([big] * 3, axis=-1))
        draw = ImageDraw.Draw(img)
        for tid, pts in by_track.items():
            seen = [(y * k + k / 2, x * k + k / 2) for (tt, y, x) in pts if t - args.tail <= tt <= t]
            if not seen:
                continue
            c = colour(tid)
            if len(seen) > 1:
                draw.line([(x, y) for (y, x) in seen], fill=c, width=2)
            y, x = seen[-1]
            draw.ellipse([x - 4, y - 4, x + 4, y + 4], outline=c, width=2)
        out.append(np.asarray(img))
        progress((t + 1) / len(grey) * 0.9, f"frame {t + 1} of {len(grey)}")
    iio.imwrite(args.out, np.stack(out), fps=args.fps, codec="libx264")
    progress(1.0, f"{len(by_track)} tracks drawn")


# ---------------------------------------------------------------- OpenFOAM


def read_foam_field(path):
    """The internalField of an ASCII OpenFOAM field: (n,) scalars or (n, 3) vectors, or a uniform value."""
    text = open(path).read()
    start = text.index("internalField")
    head = text[start : start + 200]
    if "nonuniform" not in head:
        inner = head.split("uniform", 1)[1].split(";", 1)[0].strip().strip("()")
        return np.array([float(v) for v in inner.split()], np.float32)
    body = text[start:]
    count_at = body.index("\n", body.index("nonuniform"))
    open_at = body.index("(", count_at)
    close_at = body.index("\n)", open_at)
    values = body[open_at + 1 : close_at].replace("(", " ").replace(")", " ")
    data = np.array(values.split(), np.float32)
    n = int(body[count_at:open_at].strip())
    return data.reshape(n, -1) if data.size != n else data


def foam_times(case):
    times = []
    for name in os.listdir(case):
        try:
            t = float(name)
        except ValueError:
            continue
        if os.path.isfile(os.path.join(case, name, "U")):
            times.append((t, name))
    return [name for t, name in sorted(times)]


def diverging(v):
    """Blue (negative) - white - red (positive), for values in [-1, 1]."""
    v = np.clip(v, -1, 1)[..., None]
    blue, white, red = np.array([40, 90, 200]), np.array([250, 250, 250]), np.array([200, 40, 40])
    return np.where(v < 0, white + (blue - white) * -v, white + (red - white) * v).astype(np.uint8)


def sequential(v):
    """Dark blue - teal - yellow, for values in [0, 1]."""
    stops = np.array([[20, 30, 70], [30, 110, 140], [70, 170, 120], [240, 220, 60]], np.float32)
    x = np.clip(v, 0, 1) * (len(stops) - 1)
    i = np.minimum(x.astype(int), len(stops) - 2)
    f = (x - i)[..., None]
    return (stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8)


def cmd_flow(args):
    from scipy.interpolate import LinearNDInterpolator
    from scipy.spatial import Delaunay, cKDTree

    case = args.case
    times = [t for t in foam_times(case) if float(t) > 0]
    centres_file = os.path.join(case, "0", "C")
    if not times or not os.path.isfile(centres_file):
        raise SystemExit(
            "This case hasn't been simulated yet, so there is no flow to show. "
            "Run it first (openfoam › solve, or the 'Simulate flow past an obstacle' recipe), then make the video from the solved case."
        )
    centres = read_foam_field(centres_file)
    if centres.ndim != 2:
        raise SystemExit("0/C doesn't hold cell centres; re-run the case with openfoam › solve")
    xy = centres[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    width = args.width
    px = (hi[0] - lo[0]) / width
    # video encoders want sides divisible by 16
    height = max(16, int(round((hi[1] - lo[1]) / px)) // 16 * 16)
    gx, gy = np.meshgrid(lo[0] + (np.arange(width) + 0.5) * px, lo[1] + (np.arange(height) + 0.5) * (hi[1] - lo[1]) / height)
    pixels = np.stack([gx.ravel(), gy.ravel()], axis=1)
    tree = cKDTree(xy)
    dist, nearest = tree.query(pixels)
    # inside an obstacle: farther from the nearest cell centre than that cell's neighbours are
    # (the 4th neighbour, so long thin cells count their long side too)
    spacing, _ = tree.query(xy, k=5)
    inside = (dist > 0.75 * spacing[nearest, 4] + 0.5 * px).reshape(height, width)
    triangulation = Delaunay(xy)  # built once; each frame only interpolates new values on it

    fields = []
    for i, t in enumerate(times):
        u = read_foam_field(os.path.join(case, t, "U"))
        uv = LinearNDInterpolator(triangulation, u[:, :2])(pixels).reshape(height, width, 2)
        ux, uy = uv[..., 0], uv[..., 1]
        if args.field == "vorticity":
            f = np.gradient(uy, px, axis=1) - np.gradient(ux, px, axis=0)
        else:
            f = np.hypot(ux, uy)
        f[inside | np.isnan(f)] = np.nan
        fields.append(f)
        progress(0.6 * (i + 1) / len(times), f"read t = {t}")
    stack = np.stack(fields)
    scale = np.nanpercentile(np.abs(stack), 99) or 1.0
    frames = []
    for f in stack:
        rgb = diverging(np.nan_to_num(f / scale)) if args.field == "vorticity" else sequential(np.nan_to_num(f / scale))
        rgb[np.isnan(f)] = (60, 60, 60)
        frames.append(rgb[::-1])  # y up
    iio.imwrite(args.out, np.stack(frames), fps=args.fps, codec="libx264")
    progress(1.0, f"{len(frames)} frames of {args.field}")


def main():
    ap = argparse.ArgumentParser(prog="pharos_render")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("flow-video")
    p.add_argument("--case", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--field", choices=["vorticity", "speed"], default="vorticity")
    p.add_argument("--fps", type=float, default=12)
    p.add_argument("--width", type=int, default=800)
    for name in ("video", "tracks-video"):
        p = sub.add_parser(name)
        p.add_argument("--image", required=True)
        p.add_argument("--out", required=True)
        p.add_argument("--fps", type=float, default=4)
        p.add_argument("--channel", type=int, default=0)
        if name == "tracks-video":
            p.add_argument("--tracks", required=True)
            p.add_argument("--tail", type=int, default=10, help="time points of path to draw behind each cell")
    args = ap.parse_args()
    {"video": cmd_video, "tracks-video": cmd_tracks, "flow-video": cmd_flow}[args.cmd](args)


if __name__ == "__main__":
    main()
