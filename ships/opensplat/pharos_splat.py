"""
Pharos wrapper for OpenSplat: trains a 3D Gaussian splat from a COLMAP reconstruction
(images/ and sparse/0/) and writes it as a splat PLY (positions, colours as spherical
harmonics, opacity, scale and rotation per Gaussian).

Progress goes to stdout as JSON lines; OpenSplat's own output goes to stderr.
"""

import argparse
import json
import os
import re
import subprocess
import sys


def progress(p, message=None):
    print(json.dumps({"progress": round(min(max(p, 0.0), 1.0), 4), **({"message": message} if message else {})}), flush=True)


def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(1)


def splat_count(path):
    """The number of Gaussians, from the PLY header."""
    with open(path, "rb") as f:
        for raw in f:
            line = raw.decode("ascii", "replace").strip()
            if line.startswith("element vertex"):
                return int(line.split()[-1])
            if line == "end_header":
                break
    return 0


def train(args):
    scene = args.scene
    if not os.path.isfile(os.path.join(scene, "sparse", "0", "images.bin")):
        fail("This isn't a COLMAP reconstruction: it needs sparse/0/ (cameras.bin, images.bin, points3D.bin) beside images/.")
    progress(0.01, "loading the photos and cameras")
    # OpenSplat's schedule is made for 30,000 steps (densify every 500 from step 500 to half way), which in a
    # short run never densifies at all; scale it to the run instead
    n = args.iterations
    if n < 300:
        # a glance: just refine COLMAP's points
        schedule = ["--densify-from", str(n + 1)]
    elif n < 1000:
        # a quick look: each densification scores every camera, so a few, every 100 steps, before the end
        schedule = ["--densify-from", "100", "--refine-every", "100", "--densify-until", str(n - 50)]
    else:
        schedule = ["--densify-from", str(max(100, n // 6)), "--refine-every", str(max(100, n // 12)), "--densify-until", str(int(n * 0.75))]
    cmd = ["/opt/opensplat/opensplat", scene, "-o", args.out, "-n", str(n), "-d", str(args.downscale),
           "--sh-degree", str(args.sh_degree), "--max-gaussians", str(args.max_gaussians), *schedule, "--cpu"]
    step = re.compile(r"Step (\d+): ([0-9.eE+-]+)")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        sys.stderr.write(line)
        hit = step.search(line)
        if hit:
            i = int(hit.group(1))
            # training is the whole job; leave a sliver for writing the file
            progress(0.02 + 0.96 * i / args.iterations, f"step {i} of {args.iterations} · loss {float(hit.group(2)):.4f}")
    if proc.wait() != 0:
        fail(f"OpenSplat failed (exit {proc.returncode}); see the log above")
    if not os.path.isfile(args.out):
        fail("OpenSplat finished without writing the splat")
    progress(1.0, f"{splat_count(args.out):,} Gaussians")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--scene", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--iterations", type=int, default=2000)
    t.add_argument("--downscale", type=float, default=2)
    t.add_argument("--sh-degree", type=int, default=3)
    t.add_argument("--max-gaussians", type=int, default=1000000)
    args = p.parse_args()
    train(args)


if __name__ == "__main__":
    main()
