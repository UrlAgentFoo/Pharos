"""
Pharos wrapper for COLMAP (structure from motion) and FFmpeg.

  frames       a video -> evenly spaced frames, as a photo set (a folder with images/)
  reconstruct  a photo set -> where each photo was taken (a COLMAP folder: images/ and
               sparse/0/) and the scene's sparse points as a coloured PLY

Progress goes to stdout as JSON lines; COLMAP's and FFmpeg's own output goes to stderr.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png")


def progress(p, message=None):
    print(json.dumps({"progress": round(min(max(p, 0.0), 1.0), 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


def run(cmd, on_line=None, failed=None):
    """Runs a command, passing its output to stderr line by line (and to `on_line`); `failed` is what to say if it fails."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        sys.stderr.write(line)
        if on_line:
            on_line(line)
    if proc.wait() != 0:
        fail(failed or f"{os.path.basename(cmd[0])} {cmd[1] if len(cmd) > 1 else ''} failed (exit {proc.returncode}); see the log above")


def find_photos(folder):
    return sorted(f for f in os.listdir(folder) if f.lower().endswith(PHOTO_EXTENSIONS) and not f.startswith("."))


# ---------------------------------------------------------------- frames


def video_seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def frames(args):
    video = args.video
    seconds = video_seconds(video)
    if seconds <= 0:
        fail("Couldn't read how long the video is; is it a video file FFmpeg can open?")
    images = os.path.join(args.out, "images")
    os.makedirs(images, exist_ok=True)
    rate = args.frames / seconds
    # scale the longer side down to max_size, keeping the aspect ratio (even sizes for the encoder)
    m = args.max_size
    scale = f"scale='if(gt(iw,ih),min({m},iw),-2)':'if(gt(iw,ih),-2,min({m},ih))'"
    progress(0.02, f"taking {args.frames} frames from {seconds:.0f} s of video")
    done = re.compile(r"frame=\s*(\d+)")

    def on_line(line):
        hit = done.search(line)
        if hit:
            progress(0.05 + 0.9 * int(hit.group(1)) / args.frames, f"frame {hit.group(1)} of {args.frames}")

    run(["ffmpeg", "-hide_banner", "-nostdin", "-i", video, "-vf", f"fps={rate:.6f},{scale}", "-frames:v", str(args.frames), "-q:v", "2", os.path.join(images, "frame_%04d.jpg")], on_line)
    n = len(find_photos(images))
    if n < 3:
        fail(f"Only {n} frames came out of the video; it needs at least 3.")
    progress(1.0, f"{n} frames")


# ---------------------------------------------------------------- reconstruct


def reconstruct(args):
    source = args.photos
    if os.path.isdir(os.path.join(source, "images")):
        source = os.path.join(source, "images")
    names = find_photos(source)
    if len(names) < 3:
        fail(f"Found {len(names)} photos (.jpg or .png) in the folder's images/; at least 3 are needed, overlapping each other.")

    from PIL import Image

    scene = args.out
    images = os.path.join(scene, "images")
    os.makedirs(images, exist_ok=True)
    progress(0.01, f"preparing {len(names)} photos")
    for i, name in enumerate(names):
        with Image.open(os.path.join(source, name)) as im:
            im = im.convert("RGB")
            if max(im.size) > args.max_size:
                im.thumbnail((args.max_size, args.max_size), Image.LANCZOS)
            im.save(os.path.join(images, os.path.splitext(name)[0] + ".jpg"), quality=95)
        progress(0.01 + 0.04 * (i + 1) / len(names))

    work = "/tmp/colmap"
    os.makedirs(work, exist_ok=True)
    db = os.path.join(work, "database.db")
    n = len(names)

    # each stage's share of the bar: features, matching, mapping
    def counter(pattern, start, share, label):
        rx = re.compile(pattern)

        def on_line(line):
            hit = rx.search(line)
            if hit:
                i, total = int(hit.group(1)), int(hit.group(2)) if hit.lastindex >= 2 else n
                progress(start + share * min(i / max(total, 1), 1.0), f"{label} {i} of {total}")

        return on_line

    run(["colmap", "feature_extractor", "--database_path", db, "--image_path", images,
         "--ImageReader.single_camera", "1", "--SiftExtraction.use_gpu", "0",
         # CPU SIFT takes a lot of memory per thread: a few threads keep it inside the ship's memory limit
         "--SiftExtraction.num_threads", str(min(4, os.cpu_count() or 1)), "--SiftExtraction.max_image_size", str(args.max_size)],
        counter(r"Processed file \[(\d+)/(\d+)\]", 0.05, 0.2, "finding features in photo"))
    if args.matcher == "exhaustive":
        run(["colmap", "exhaustive_matcher", "--database_path", db, "--SiftMatching.use_gpu", "0"],
            counter(r"Matching block \[(\d+)/(\d+)", 0.25, 0.25, "matching block"))
    else:
        run(["colmap", "sequential_matcher", "--database_path", db, "--SiftMatching.use_gpu", "0", "--SequentialMatching.overlap", "12"],
            counter(r"Matching image \[(\d+)/(\d+)\]", 0.25, 0.25, "matching photo"))

    sparse = os.path.join(work, "sparse")
    os.makedirs(sparse, exist_ok=True)
    registered = re.compile(r"Registering image #\d+ \((\d+)\)")

    def on_map(line):
        hit = registered.search(line)
        if hit:
            k = int(hit.group(1))
            progress(0.5 + 0.4 * min(k / n, 1.0), f"placed {k} of {n} photos")

    lost = ("COLMAP couldn't work out where the photos were taken. The camera has to move around a still scene (walk around it), "
            "and each spot has to be seen in several sharp photos; a fixed camera, or things moving through the view, won't work. "
            "Try a video that circles the subject slowly, or more frames.")
    run(["colmap", "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse, "--random_seed", "1"], on_map, failed=lost)

    # COLMAP may split the photos into several models when they don't all connect: keep the largest
    models = [os.path.join(sparse, d) for d in os.listdir(sparse) if os.path.isfile(os.path.join(sparse, d, "images.bin"))]
    if not models:
        fail(lost)
    best = max(models, key=lambda m: os.path.getsize(os.path.join(m, "images.bin")))
    shutil.copytree(best, os.path.join(scene, "sparse", "0"))

    progress(0.92, "writing the point cloud")
    run(["colmap", "model_converter", "--input_path", os.path.join(scene, "sparse", "0"), "--output_path", args.points, "--output_type", "PLY"])
    placed = count_images(os.path.join(scene, "sparse", "0", "images.bin"))
    progress(1.0, f"placed {placed} of {n} photos")


def count_images(path):
    with open(path, "rb") as f:
        return int.from_bytes(f.read(8), "little")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("frames")
    f.add_argument("--video", required=True)
    f.add_argument("--out", required=True)
    f.add_argument("--frames", type=int, default=80)
    f.add_argument("--max-size", type=int, default=1280)
    r = sub.add_parser("reconstruct")
    r.add_argument("--photos", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--points", required=True)
    r.add_argument("--matcher", choices=["sequential", "exhaustive"], default="sequential")
    r.add_argument("--max-size", type=int, default=1600)
    args = p.parse_args()
    {"frames": frames, "reconstruct": reconstruct}[args.cmd](args)


if __name__ == "__main__":
    main()
