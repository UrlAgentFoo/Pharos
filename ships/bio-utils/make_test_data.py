"""
Synthetic nuclei for tests and book examples: fluorescent blobs in 3D (or
3D over time, drifting), written as ImageJ TIFFs with a real voxel size,
plus their ground-truth labels. Deterministic for a given seed.

    python make_test_data.py stack  out.tif [labels.tif]
    python make_test_data.py movie  out.tif [frames] [size] [nuclei]
"""

import sys

import numpy as np
import tifffile

VOXEL = (2.0, 0.5, 0.5)  # z, y, x in µm


def nuclei(shape=(12, 64, 64), n=10, radius=(2.5, 6.0, 6.0), seed=1, centres=None):
    rng = np.random.default_rng(seed)
    z, y, x = np.indices(shape, dtype=np.float32)
    image = np.zeros(shape, np.float32)
    labels = np.zeros(shape, np.uint16)
    if centres is None:
        centres = []
        while len(centres) < n:
            c = rng.uniform([radius[0], radius[1] + 2, radius[2] + 2], [shape[0] - radius[0], shape[1] - radius[1] - 2, shape[2] - radius[2] - 2])
            if all(np.hypot(*(np.array(c[1:]) - np.array(o[1:]))) > 2.2 * radius[1] for o in centres):
                centres.append(c)
    for i, (cz, cy, cx) in enumerate(centres, 1):
        d = ((z - cz) / radius[0]) ** 2 + ((y - cy) / radius[1]) ** 2 + ((x - cx) / radius[2]) ** 2
        image += 1500 * np.exp(-d * 1.2)
        labels[d <= 1.0] = i
    image += 100 + rng.normal(0, 25, shape)
    return np.clip(image, 0, 65535).astype(np.uint16), labels, centres


def write(path, data, axes):
    tifffile.imwrite(path, data, imagej=True, resolution=(1 / VOXEL[2], 1 / VOXEL[1]), metadata={"spacing": VOXEL[0], "unit": "um", "axes": axes})


def main():
    what, out = sys.argv[1], sys.argv[2]
    if what == "stack":
        image, labels, _ = nuclei()
        write(out, image, "ZYX")
        if len(sys.argv) > 3:
            write(sys.argv[3], labels, "ZYX")
    elif what == "movie":
        count = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        size = int(sys.argv[4]) if len(sys.argv) > 4 else 64
        n = int(sys.argv[5]) if len(sys.argv) > 5 else 10
        shape = (12, size, size)
        _, _, centres = nuclei(shape=shape, n=n, seed=2)
        # each nucleus drifts in its own direction, slowly enough to stay in view
        rng = np.random.default_rng(3)
        drift = rng.uniform(-1.2, 1.2, (len(centres), 2))
        frames = []
        for t in range(count):
            moved = [(cz, np.clip(cy + dy * t, 7, size - 8), np.clip(cx + dx * t, 7, size - 8)) for (cz, cy, cx), (dy, dx) in zip(centres, drift)]
            frames.append(nuclei(shape=shape, seed=10 + t, centres=moved)[0])
        write(out, np.stack(frames), "TZYX")
    else:
        raise SystemExit(f"unknown: {what}")


if __name__ == "__main__":
    main()
