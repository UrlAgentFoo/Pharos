"""
Builds the test data for image-ops: a small 2D image of nuclei (TIFF, 0.5 µm pixels) and a
mask of them (OME-Zarr), one copy in each operation's test folder. Deterministic; run it in
this ship's image, from the repository root:

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo" -w /repo \
      --entrypoint python pharos/image-ops:0.1.0 ships/image-ops/make_test_data.py
"""

import os
import sys

import numpy as np
import tifffile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pharos_image import Image, write  # noqa: E402

ROOT = "ships/image-ops/test"
IMAGE_OPS = ["invert", "gaussian-blur", "flip", "rotate", "set-scale", "threshold", "measure", "particles"]
MASK_OPS = ["erode", "dilate", "open", "close", "fill-holes", "outline", "skeletonize", "particles"]


def nuclei(size=64, seed=3):
    rng = np.random.default_rng(seed)
    yy, xx = np.indices((size, size), dtype=np.float32)
    img = np.full((size, size), 100.0, np.float32)
    for cy, cx, r in [(16, 18, 6), (40, 22, 7), (24, 46, 5), (48, 48, 6), (10, 50, 4)]:
        img += 900 * np.exp(-(((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * r**2)) ** 2)
    img += rng.normal(0, 20, img.shape)
    return np.clip(img, 0, 65535).astype(np.uint16)


def main():
    img = nuclei()
    mask = (img > 400).astype(np.uint8)
    mask[40, 22] = 0  # a hole for fill-holes
    for op in IMAGE_OPS:
        os.makedirs(f"{ROOT}/{op}", exist_ok=True)
        tifffile.imwrite(f"{ROOT}/{op}/image.tif", img, imagej=True, resolution=(2.0, 2.0), metadata={"unit": "um", "axes": "YX"})
    for op in MASK_OPS:
        os.makedirs(f"{ROOT}/{op}", exist_ok=True)
        write(Image(mask, "yx", {"y": 0.5, "x": 0.5}, "µm"), f"{ROOT}/{op}/mask.zarr", "mask")


if __name__ == "__main__":
    main()
