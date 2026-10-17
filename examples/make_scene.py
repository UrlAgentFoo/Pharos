"""
Renders the 3D capture example: a short video circling a small still scene (a
patterned ball, a box and a pebble on a patterned floor), as a phone video
walking around an object would. Synthetic, deterministic and rich in texture,
so structure from motion can follow it. Run it in the colmap ship's image,
which has numpy, Pillow and FFmpeg:

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo" --entrypoint python3 \
      pharos/colmap:0.1.0 /repo/examples/make_scene.py /repo

It writes books/3d-capture/example/orbit.mp4 and examples/images/orbit-scene.webp.
"""

import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

W, H, FRAMES, FPS = 640, 480, 180, 30


def noise_texture(size, seed, palette):
    """Smooth multi-scale noise in the palette's colours, sprinkled with small dots for features."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), np.float32)
    for cells, weight in ((4, 1.0), (12, 0.6), (40, 0.35), (120, 0.2)):
        coarse = Image.fromarray((rng.random((cells, cells)) * 255).astype(np.uint8))
        acc += weight * np.asarray(coarse.resize((size, size), Image.BICUBIC), np.float32) / 255
    acc = (acc - acc.min()) / (acc.max() - acc.min())
    pal = np.asarray(palette, np.float32) / 255
    idx = acc * (len(pal) - 1)
    lo = np.floor(idx).astype(int).clip(0, len(pal) - 2)
    t = (idx - lo)[..., None]
    tex = pal[lo] * (1 - t) + pal[lo + 1] * t
    # dots: distinct corners for feature detectors
    n = size * size // 900
    ys, xs = rng.integers(0, size, n), rng.integers(0, size, n)
    colours = rng.random((n, 3)).astype(np.float32)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx * dx + dy * dy <= 5:
                tex[(ys + dy) % size, (xs + dx) % size] = colours
    return tex


def sample(tex, u, v):
    s = tex.shape[0]
    return tex[(np.mod(v, 1.0) * (s - 1)).astype(int), (np.mod(u, 1.0) * (s - 1)).astype(int)]


FLOOR = noise_texture(2048, 1, [(60, 52, 44), (150, 120, 90), (210, 190, 150), (90, 110, 70), (40, 60, 90)])
BALL = noise_texture(1024, 2, [(30, 40, 120), (200, 60, 50), (240, 200, 80), (40, 140, 120), (240, 240, 230)])
BOX = noise_texture(1024, 3, [(20, 20, 20), (230, 120, 30), (250, 240, 220), (120, 30, 90)])
PEBBLE = noise_texture(512, 4, [(80, 80, 85), (170, 170, 160), (110, 90, 70)])

BALL_C, BALL_R = np.array([0.0, 0.0, 0.6]), 0.6
PEBBLE_C, PEBBLE_R = np.array([-0.95, 0.75, 0.28]), 0.28
BOX_MIN, BOX_MAX = np.array([0.75, -0.95, 0.0]), np.array([1.45, -0.25, 0.7])
LIGHT = np.array([0.4, -0.5, 0.75]) / np.linalg.norm([0.4, -0.5, 0.75])


def sphere_hit(o, d, c, r):
    oc = o - c
    b = np.einsum("ij,ij->i", oc, d)
    disc = b * b - (np.einsum("ij,ij->i", oc, oc) - r * r)
    t = -b - np.sqrt(np.maximum(disc, 0))
    return np.where((disc > 0) & (t > 1e-4), t, np.inf)


def box_hit(o, d):
    inv = 1.0 / np.where(np.abs(d) < 1e-9, 1e-9, d)
    t0, t1 = (BOX_MIN - o) * inv, (BOX_MAX - o) * inv
    near, far = np.minimum(t0, t1).max(1), np.maximum(t0, t1).min(1)
    return np.where((far > near) & (near > 1e-4), near, np.inf)


def render(eye, target):
    fwd = target - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    f = 0.5 * W / np.tan(np.radians(55) / 2)
    xs, ys = np.meshgrid(np.arange(W) - W / 2 + 0.5, np.arange(H) - H / 2 + 0.5)
    d = (fwd[None] * f + right[None] * xs.reshape(-1, 1) - up[None] * ys.reshape(-1, 1))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    o = np.broadcast_to(eye, d.shape)

    t_floor = np.where(d[:, 2] < -1e-6, -o[:, 2] / np.where(d[:, 2] < -1e-6, d[:, 2], -1), np.inf)
    hits = np.stack([t_floor, sphere_hit(o, d, BALL_C, BALL_R), sphere_hit(o, d, PEBBLE_C, PEBBLE_R), box_hit(o, d)])
    which, t = hits.argmin(0), hits.min(0)
    p = o + d * np.where(np.isfinite(t), t, 0)[:, None]
    # a soft sky where nothing is hit
    colour = np.tile(np.array([0.78, 0.84, 0.92], np.float32), (len(d), 1)) * (0.85 + 0.15 * d[:, 2:3].clip(0, 1))
    normal = np.zeros_like(d)

    m = (which == 0) & np.isfinite(t) & (np.abs(p[:, 0]) < 4) & (np.abs(p[:, 1]) < 4)
    colour[m] = sample(FLOOR, p[m, 0] / 8 + 0.5, p[m, 1] / 8 + 0.5)
    normal[m] = [0, 0, 1]
    for k, (c, r, tex) in ((1, (BALL_C, BALL_R, BALL)), (2, (PEBBLE_C, PEBBLE_R, PEBBLE))):
        m = (which == k) & np.isfinite(t)
        n = (p[m] - c) / r
        colour[m] = sample(tex, np.arctan2(n[:, 1], n[:, 0]) / (2 * np.pi) + 0.5, np.arccos(n[:, 2].clip(-1, 1)) / np.pi)
        normal[m] = n
    m = (which == 3) & np.isfinite(t)
    q = (p[m] - BOX_MIN) / (BOX_MAX - BOX_MIN)
    face = np.abs(q - 0.5).argmax(1)
    n = np.zeros_like(q)
    n[np.arange(len(q)), face] = np.sign(q[np.arange(len(q)), face] - 0.5)
    # each face samples its own part of the texture, so faces look different
    uv = np.where(face[:, None] == 0, q[:, [1, 2]], np.where(face[:, None] == 1, q[:, [0, 2]], q[:, [0, 1]]))
    colour[m] = sample(BOX, uv[:, 0] / 2 + (face % 2) * 0.5, uv[:, 1] / 2 + (face // 2) * 0.5)
    normal[m] = n

    lit = np.isfinite(t) & (np.abs(normal).sum(1) > 0)
    shade = 0.45 + 0.6 * np.einsum("ij,j->i", normal[lit], LIGHT).clip(0, 1)
    colour[lit] *= shade[:, None]
    return (colour.reshape(H, W, 3).clip(0, 1) * 255).astype(np.uint8)


def main(repo):
    out = os.path.join(repo, "books", "3d-capture", "example")
    os.makedirs(out, exist_ok=True)
    target = np.array([0.15, -0.1, 0.35])
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(FRAMES):
            a = 2 * np.pi * i / FRAMES
            # walking around the scene, the camera bobbing a little as a hand-held phone does
            eye = np.array([3.0 * np.cos(a), 3.0 * np.sin(a), 1.5 + 0.25 * np.sin(3 * a)])
            frame = render(eye, target)
            Image.fromarray(frame).save(os.path.join(tmp, f"f{i:04d}.png"))
            if i == FRAMES // 8:
                card = Image.fromarray(frame).resize((480, 360), Image.LANCZOS).crop((0, 30, 480, 330))
                card.save(os.path.join(repo, "examples", "images", "orbit-scene.webp"), quality=82)
            print(f"frame {i + 1} of {FRAMES}", flush=True)
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(tmp, "f%04d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", os.path.join(out, "orbit.mp4")], check=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
