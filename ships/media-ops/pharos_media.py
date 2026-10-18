"""
Pharos media-ops: makes videos and photo sets smaller.

  resize-video   a video -> an MP4 scaled down to a longest side, optionally at fewer
                 frames per second (sound is dropped)
  resize-photos  a photo set (photos in images/) -> the same photos scaled down

Progress goes to stdout as JSON lines; FFmpeg's own output goes to stderr.
"""

import argparse
import json
import os
import subprocess
import sys

PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png")


def progress(p, message=None):
    print(json.dumps({"progress": round(min(max(p, 0.0), 1.0), 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


def resize_video(args):
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", args.video], capture_output=True, text=True)
    try:
        duration = float(probe.stdout.strip())
    except ValueError:
        fail("Couldn't read the video; is it a video file FFmpeg can open?")
    m = args.max_size
    # the longer side down to max_size (never up), the other in proportion, both even for the encoder
    filters = [f"scale='if(gt(iw,ih),min({m},iw),-2)':'if(gt(iw,ih),-2,min({m},ih))'"]
    if args.fps > 0:
        filters.insert(0, f"fps={args.fps}")
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-y", "-progress", "pipe:1", "-i", args.video, "-vf", ",".join(filters), "-an",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out]
    progress(0.01, f"resizing {duration:.0f} s of video")
    # -progress writes key=value lines to stdout; out_time_us is how far it has got
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1)
    for line in proc.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_us" and value.isdigit() and duration > 0:
            done = int(value) / 1e6
            progress(0.02 + 0.96 * min(done / duration, 1.0), f"{done:.0f} of {duration:.0f} s")
    if proc.wait() != 0:
        fail(f"FFmpeg failed (exit {proc.returncode}); see the log above")
    before, after = os.path.getsize(args.video), os.path.getsize(args.out)
    progress(1.0, f"{before / 1e6:.1f} MB → {after / 1e6:.1f} MB")


def resize_photos(args):
    from PIL import Image, ImageOps

    source = os.path.join(args.photos, "images") if os.path.isdir(os.path.join(args.photos, "images")) else args.photos
    names = sorted(f for f in os.listdir(source) if f.lower().endswith(PHOTO_EXTENSIONS) and not f.startswith("."))
    if not names:
        fail("Found no photos (.jpg or .png) in the folder's images/.")
    out = os.path.join(args.out, "images")
    os.makedirs(out, exist_ok=True)
    for i, name in enumerate(names):
        with Image.open(os.path.join(source, name)) as im:
            # phones store the camera's turn in EXIF: apply it so the small copy stands the right way up
            im = ImageOps.exif_transpose(im).convert("RGB")
            if max(im.size) > args.max_size:
                im.thumbnail((args.max_size, args.max_size), Image.LANCZOS)
            im.save(os.path.join(out, os.path.splitext(name)[0] + ".jpg"), quality=args.quality)
        progress((i + 1) / len(names), f"photo {i + 1} of {len(names)}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("resize-video")
    v.add_argument("--video", required=True)
    v.add_argument("--out", required=True)
    v.add_argument("--max-size", type=int, default=720)
    v.add_argument("--fps", type=float, default=0)
    v.add_argument("--crf", type=int, default=23)
    ph = sub.add_parser("resize-photos")
    ph.add_argument("--photos", required=True)
    ph.add_argument("--out", required=True)
    ph.add_argument("--max-size", type=int, default=1280)
    ph.add_argument("--quality", type=int, default=92)
    args = p.parse_args()
    {"resize-video": resize_video, "resize-photos": resize_photos}[args.cmd](args)


if __name__ == "__main__":
    main()
