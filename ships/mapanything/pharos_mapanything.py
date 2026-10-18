"""
Pharos wrapper for MapAnything: works out where each photo of a scene was taken, and the
scene's 3D points, in one pass of a neural network (no feature matching), and writes them as
a COLMAP reconstruction (images/ and sparse/0/) that splat trainers read, plus a coloured
point cloud.

The photos are written at the resolution the model saw them (about 518 px wide), which is
what its camera intrinsics describe. Progress goes to stdout as JSON lines.
"""

import argparse
import json
import os
import struct
import sys
import threading
import time

import numpy as np

PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png")


def progress(p, message=None):
    print(json.dumps({"progress": round(min(max(p, 0.0), 1.0), 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


class Ticking:
    """While a long call runs, says how long it has been, so the run never looks stuck."""

    def __init__(self, start, end, label, expected):
        self.start, self.end, self.label, self.expected = start, end, label, expected
        self.stop = threading.Event()

    def __enter__(self):
        t0 = time.time()

        def tick():
            while not self.stop.wait(3):
                s = time.time() - t0
                # creep towards the end without reaching it: the call's own length is unknown
                progress(self.start + (self.end - self.start) * (1 - 1 / (1 + s / self.expected)), f"{self.label} · {s:.0f} s")

        threading.Thread(target=tick, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.stop.set()


def rotation_to_quaternion(r):
    """A rotation matrix as a unit quaternion (w, x, y, z)."""
    w = np.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    x = np.sqrt(max(0.0, 1 + r[0, 0] - r[1, 1] - r[2, 2])) / 2
    y = np.sqrt(max(0.0, 1 - r[0, 0] + r[1, 1] - r[2, 2])) / 2
    z = np.sqrt(max(0.0, 1 - r[0, 0] - r[1, 1] + r[2, 2])) / 2
    x = np.copysign(x, r[2, 1] - r[1, 2])
    y = np.copysign(y, r[0, 2] - r[2, 0])
    z = np.copysign(z, r[1, 0] - r[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def write_colmap(sparse, cams, points, colours):
    """cameras.bin, images.bin and points3D.bin: one PINHOLE camera per photo, its pose, and points without tracks."""
    os.makedirs(sparse, exist_ok=True)
    with open(os.path.join(sparse, "cameras.bin"), "wb") as f:
        f.write(struct.pack("<Q", len(cams)))
        for i, c in enumerate(cams, 1):
            k = c["K"]
            f.write(struct.pack("<iiQQ", i, 1, c["width"], c["height"]))  # model 1 = PINHOLE
            f.write(struct.pack("<4d", k[0, 0], k[1, 1], k[0, 2], k[1, 2]))
    with open(os.path.join(sparse, "images.bin"), "wb") as f:
        f.write(struct.pack("<Q", len(cams)))
        for i, c in enumerate(cams, 1):
            # COLMAP stores world-to-camera; the model gives camera-to-world (OpenCV axes, as COLMAP's)
            r = c["pose"][:3, :3].T
            t = -r @ c["pose"][:3, 3]
            f.write(struct.pack("<I4d3dI", i, *rotation_to_quaternion(r), *t, i))
            f.write(c["name"].encode() + b"\0")
            f.write(struct.pack("<Q", 0))
    with open(os.path.join(sparse, "points3D.bin"), "wb") as f:
        f.write(struct.pack("<Q", len(points)))
        rec = np.zeros(len(points), dtype=[("id", "<u8"), ("xyz", "<f8", 3), ("rgb", "u1", 3), ("error", "<f8"), ("track", "<u8")])
        rec["id"] = np.arange(1, len(points) + 1)
        rec["xyz"] = points
        rec["rgb"] = colours
        f.write(rec.tobytes())


def write_ply(path, points, colours):
    rec = np.zeros(len(points), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")])
    rec["x"], rec["y"], rec["z"] = points.T
    rec["red"], rec["green"], rec["blue"] = colours.T
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\nproperty float x\nproperty float y\nproperty float z\n" \
             "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n" % len(points)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(rec.tobytes())


def reconstruct(args):
    source = os.path.join(args.photos, "images") if os.path.isdir(os.path.join(args.photos, "images")) else args.photos
    names = sorted(f for f in os.listdir(source) if f.lower().endswith(PHOTO_EXTENSIONS) and not f.startswith("."))
    if len(names) < 2:
        fail(f"Found {len(names)} photos (.jpg or .png) in the folder's images/; at least 2 are needed.")
    if len(names) > args.views:
        # evenly spaced, so the whole capture is covered
        names = [names[round(i * (len(names) - 1) / (args.views - 1))] for i in range(args.views)]
    progress(0.02, f"loading the model for {len(names)} photos")

    import torch
    from mapanything.models import MapAnything
    from mapanything.utils.image import load_images
    from PIL import Image

    torch.set_grad_enabled(False)
    # a GPU when the ship was built for one and the run was given one; on the CPU it takes about 25 s a photo
    gpu = torch.cuda.is_available()
    device = "cuda" if gpu else "cpu"
    with Ticking(0.02, 0.2, "loading the model", 20):
        model = MapAnything.from_pretrained("facebook/map-anything-apache").to(device).eval()
    views = load_images([os.path.join(source, n) for n in names])
    with Ticking(0.2, 0.88, f"reconstructing from {len(names)} photos", (1 if gpu else 25) * len(names)):
        preds = model.infer(views, memory_efficient_inference=True, minibatch_size=None if gpu else 1, use_amp=gpu, amp_dtype="bf16",
                            apply_mask=True, mask_edges=True, apply_confidence_mask=True, confidence_percentile=10)

    progress(0.9, "writing the cameras and points")
    images = os.path.join(args.out, "images")
    os.makedirs(images, exist_ok=True)
    cams, points, colours = [], [], []
    for name, pred in zip(names, preds):
        img = pred["img_no_norm"][0].cpu().numpy()
        img = (np.clip(img, 0, 1) * 255).astype(np.uint8) if img.max() <= 1.0 else img.astype(np.uint8)
        h, w = img.shape[:2]
        out_name = os.path.splitext(name)[0] + ".jpg"
        Image.fromarray(img).save(os.path.join(images, out_name), quality=95)
        cams.append({"name": out_name, "width": w, "height": h, "K": pred["intrinsics"][0].cpu().numpy().astype(np.float64),
                     "pose": pred["camera_poses"][0].cpu().numpy().astype(np.float64)})
        mask = pred["mask"][0].cpu().numpy().reshape(h, w).astype(bool)
        pts = pred["pts3d"][0].cpu().numpy().reshape(h, w, 3)
        points.append(pts[mask])
        colours.append(img[mask])
    points = np.concatenate(points).astype(np.float64)
    colours = np.concatenate(colours)
    keep = np.isfinite(points).all(1)
    points, colours = points[keep], colours[keep]
    if len(points) > args.points_max:
        pick = np.sort(np.random.default_rng(0).choice(len(points), args.points_max, replace=False))
        points, colours = points[pick], colours[pick]
    if not len(points):
        fail("MapAnything found no confident 3D points in these photos.")
    write_colmap(os.path.join(args.out, "sparse", "0"), cams, points, colours)
    write_ply(args.points, points, colours)
    progress(1.0, f"{len(cams)} cameras · {len(points):,} points")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reconstruct")
    r.add_argument("--photos", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--points", required=True)
    r.add_argument("--views", type=int, default=32)
    r.add_argument("--points-max", type=int, default=200000)
    args = p.parse_args()
    if args.views < 2:
        fail("views must be at least 2")
    reconstruct(args)


if __name__ == "__main__":
    main()
