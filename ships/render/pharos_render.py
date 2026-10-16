"""
render: videos of images, and of tracks drawn over them, for Pharos.

  video        /in/image (OME-Zarr) → /out/video.mp4, a max projection along z per time point
  tracks-video /in/image + /in/tracks (CSV: track_id, t, [z,] y, x in pixels, as Ultrack writes them)
               → /out/video.mp4 with each track's recent path drawn over the projection

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


def main():
    ap = argparse.ArgumentParser(prog="pharos_render")
    sub = ap.add_subparsers(dest="cmd", required=True)
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
    (cmd_video if args.cmd == "video" else cmd_tracks)(args)


if __name__ == "__main__":
    main()
