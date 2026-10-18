"""
image-ops: everyday image processing for Pharos, one operation per command.

  invert, gaussian-blur, flip, rotate, set-scale   image → image
  threshold                                         image → mask
  erode, dilate, open, close, fill-holes,
  outline, skeletonize                              mask → mask
  particles                                         mask + image → labels and a table
  measure                                           image → a table

Images are read from TIFF, OME-TIFF or OME-Zarr and kept in canonical axis
order (a subset of t, c, z, y, x); results are OME-Zarr (NGFF 0.4, Zarr
format 2, zstd), which Pharos previews directly. Masks are 0/1 uint8 label
images. 2D operations (flips, binary operations, particles) work slice by
slice, as microscopists expect from these commands.

Each operation reads /in, writes /out and exits. Progress goes to stdout as
JSON lines; anything else printed is the log.
"""

import argparse
import csv
import json
import math
import os
import sys

import numpy as np

CANONICAL = "tczyx"
UNITS = {"µm": "micrometer", "um": "micrometer", "nm": "nanometer", "mm": "millimeter"}


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


# ---------------------------------------------------------------- reading and writing


class Image:
    """An array with its axes (a subset of tczyx, in that order), the size of one step per axis, and the unit."""

    def __init__(self, data, axes, scale=None, unit="pixel"):
        self.data = data
        self.axes = axes
        self.scale = scale or {}
        self.unit = unit

    def like(self, data, **kw):
        return Image(data, kw.get("axes", self.axes), kw.get("scale", dict(self.scale)), kw.get("unit", self.unit))

    def planes(self):
        """Every 2D (y, x) plane, with its position on the other axes: [(index, {axis: i})]."""
        lead = self.data.shape[:-2]
        names = self.axes[:-2]
        for idx in np.ndindex(*lead):
            yield idx, dict(zip(names, idx))


def canonical(data, letters):
    """Reorders vendor axis letters (TZCYX, S for RGB samples) to tczyx, dropping length-1 unknown axes."""
    axes = "".join({"T": "t", "Z": "z", "C": "c", "S": "c", "Y": "y", "X": "x", "I": "z", "Q": "z"}.get(ch, "?") for ch in letters.upper())
    for i in reversed(range(len(axes))):
        if axes[i] == "?":
            if data.shape[i] != 1:
                sys.exit(f"unsupported axis of length {data.shape[i]} in this file")
            data, axes = np.take(data, 0, axis=i), axes[:i] + axes[i + 1 :]
    if len(set(axes)) != len(axes):
        sys.exit(f"an axis appears twice in this file ({axes})")
    keep = [a for a in CANONICAL if a in axes]
    return np.transpose(data, [axes.index(a) for a in keep]), "".join(keep)


def read_tiff(path):
    import tifffile

    with tifffile.TiffFile(path) as tif:
        series = tif.series[0]
        data, axes = canonical(series.asarray(), series.axes)
        scale, unit = {}, "pixel"
        if tif.is_ome:
            import xml.etree.ElementTree as ET

            px = next((e for e in ET.fromstring(tif.ome_metadata).iter() if e.tag.endswith("Pixels")), None)
            if px is not None:
                for ax, key in (("x", "PhysicalSizeX"), ("y", "PhysicalSizeY"), ("z", "PhysicalSizeZ")):
                    if px.get(key):
                        scale[ax] = float(px.get(key))
                unit = px.get("PhysicalSizeXUnit", "µm") if scale else unit
        elif tif.is_imagej:
            meta = tif.imagej_metadata or {}
            res = tif.pages[0].tags.get("XResolution")
            if res and res.value[0]:
                scale["x"] = scale["y"] = res.value[1] / res.value[0]
            if "spacing" in meta:
                scale["z"] = float(meta["spacing"])
            unit = {"micron": "µm", "um": "µm", "\\u00B5m": "µm"}.get(meta.get("unit", ""), meta.get("unit", "pixel"))
        return Image(data, axes, scale, unit)


def read_zarr(path):
    import zarr

    attrs = dict(zarr.open_group(path, mode="r").attrs)
    ms = attrs.get("ome", attrs)["multiscales"][0]
    names = "".join((a["name"] if isinstance(a, dict) else a).lower() for a in ms["axes"])
    level = ms["datasets"][0]
    data = np.asarray(zarr.open_array(os.path.join(path, level["path"]), mode="r")[...])
    scale = {}
    for t in level.get("coordinateTransformations", []):
        if t.get("type") == "scale":
            scale = {a: s for a, s in zip(names, t["scale"]) if a in "zyx"}
    unit = next((a.get("unit") for a in ms["axes"] if isinstance(a, dict) and a.get("name", "").lower() == "x" and a.get("unit")), "pixel")
    keep = [a for a in CANONICAL if a in names]
    data = np.transpose(data, [names.index(a) for a in keep])
    return Image(data, "".join(keep), scale, {v: k for k, v in UNITS.items() if k != "um"}.get(unit, unit))


def read(path):
    if os.path.isdir(path) or path.lower().rstrip("/").endswith(".zarr"):
        img = read_zarr(path)
    else:
        img = read_tiff(path)
    if not img.axes.endswith("yx"):
        sys.exit(f"needs an image with y and x axes; this one has {img.axes}")
    return img


def write(img, path, name="image"):
    import zarr
    from numcodecs import Zstd

    group = zarr.open_group(path, mode="w", zarr_format=2)
    chunks = tuple(1 if a in "tcz" else n for a, n in zip(img.axes, img.data.shape))
    group.create_array("0", data=img.data, chunks=chunks, compressors=Zstd(level=3))
    unit = UNITS.get(img.unit)
    axes = [{"name": a, "type": "time" if a == "t" else "channel" if a == "c" else "space", **({"unit": unit} if a in "zyx" and unit else {})} for a in img.axes]
    scale = [float(img.scale.get(a, 1.0)) for a in img.axes]
    group.attrs["multiscales"] = [{"version": "0.4", "name": name, "axes": axes, "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": scale}]}]}]


def write_table(rows, path):
    with open(path, "w", newline="") as f:
        if not rows:
            f.write("\n")
            return
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def cast(values, dtype):
    """Back to the input's data type, rounded and clipped for integer types."""
    if np.issubdtype(dtype, np.integer):
        info = np.iinfo(dtype)
        return np.clip(np.rint(values), info.min, info.max).astype(dtype)
    return values.astype(dtype)


def mask_of(img):
    return img.data != 0


def as_mask(img, mask):
    return img.like(mask.astype(np.uint8))


def per_plane(img, fn, label):
    """Applies fn to every 2D plane, reporting progress."""
    out = np.empty_like(img.data)
    planes = list(img.planes())
    for i, (idx, _) in enumerate(planes):
        out[idx] = fn(img.data[idx])
        if i % 8 == 0 or i == len(planes) - 1:
            progress((i + 1) / len(planes), f"{label}: plane {i + 1} of {len(planes)}")
    return out


def physical_area(img):
    """µm² (or the image's unit squared) per pixel, and the unit's name."""
    if "x" in img.scale and img.unit != "pixel":
        return img.scale["x"] * img.scale.get("y", img.scale["x"]), f"{img.unit}²"
    return 1.0, "px²"


# ---------------------------------------------------------------- operations


def op_invert(a):
    img = read(a.image)
    d = img.data
    lo, hi = (0, 255) if d.dtype == np.uint8 else (d.min(), d.max())
    write(img.like(cast(lo + hi - d.astype(np.float64), d.dtype)), "/out/image.zarr")
    progress(1, "inverted")


def op_gaussian_blur(a):
    from scipy import ndimage as ndi

    img = read(a.image)
    has_z = "z" in img.axes
    out = np.empty_like(img.data)
    lead = [ax for ax in img.axes if ax in "tc"]
    blocks = list(np.ndindex(*img.data.shape[: len(lead)]))
    for i, idx in enumerate(blocks):
        block = img.data[idx].astype(np.float32)
        sigma = ([a.sigma_z] if has_z else []) + [a.sigma, a.sigma]
        out[idx] = cast(ndi.gaussian_filter(block, sigma), img.data.dtype)
        progress((i + 1) / len(blocks), f"blurred {i + 1} of {len(blocks)}")
    write(img.like(out), "/out/image.zarr")


def op_flip(a):
    img = read(a.image)
    axis = img.axes.index("x" if a.direction == "horizontal" else "y")
    write(img.like(np.ascontiguousarray(np.flip(img.data, axis))), "/out/image.zarr")
    progress(1, f"flipped {a.direction}ly")


def op_rotate(a):
    img = read(a.image)
    y, x = img.axes.index("y"), img.axes.index("x")
    data = np.ascontiguousarray(np.rot90(img.data, k=-1 if a.direction == "right" else 1, axes=(y, x)))
    scale = dict(img.scale)
    if "x" in scale or "y" in scale:
        scale["x"], scale["y"] = img.scale.get("y", 1.0), img.scale.get("x", 1.0)
    write(img.like(data, scale=scale), "/out/image.zarr")
    progress(1, f"rotated 90° {a.direction}")


def op_set_scale(a):
    img = read(a.image)
    scale = {**img.scale, "x": a.pixel_size, "y": a.pixel_size}
    if "z" in img.axes and a.z_size > 0:
        scale["z"] = a.z_size
    write(img.like(img.data, scale=scale, unit=a.unit), "/out/image.zarr")
    progress(1, f"{a.pixel_size} {a.unit} per pixel")


def op_threshold(a):
    from skimage import filters

    img = read(a.image)
    method = getattr(filters, f"threshold_{a.method}")
    out = np.zeros(img.data.shape, np.uint8)
    lead = [ax for ax in img.axes if ax in "tc"]
    blocks = list(np.ndindex(*img.data.shape[: len(lead)]))
    found = []
    for i, idx in enumerate(blocks):
        block = img.data[idx]
        level = float(method(block)) if block.min() != block.max() else float(block.min())
        found.append(level)
        out[idx] = (block > level) if a.foreground == "bright" else (block <= level)
        progress((i + 1) / len(blocks), f"{a.method} threshold {level:g}")
    write(as_mask(img, out), "/out/mask.zarr", "mask")
    progress(1, f"{a.method} threshold {', '.join(f'{v:g}' for v in found)}")


def binary(fn_name):
    def run(a):
        from scipy import ndimage as ndi

        img = read(a.mask)
        m = mask_of(img)
        n = getattr(a, "iterations", 1)
        fns = {
            "erode": lambda p: ndi.binary_erosion(p, iterations=n, border_value=1),
            "dilate": lambda p: ndi.binary_dilation(p, iterations=n),
            "open": lambda p: ndi.binary_opening(p, iterations=n),
            "close": lambda p: ndi.binary_closing(p, iterations=n, border_value=0) | p,
            "fill-holes": ndi.binary_fill_holes,
            "outline": lambda p: p & ~ndi.binary_erosion(p, border_value=1),
        }
        if fn_name == "skeletonize":
            from skimage.morphology import skeletonize

            fns["skeletonize"] = skeletonize
        out = per_plane(img.like(m), lambda p: fns[fn_name](p.astype(bool)), fn_name)
        write(as_mask(img, out), "/out/mask.zarr", "mask")

    return run


def op_particles(a):
    from skimage import measure

    mask = read(a.mask)
    image = read(a.image)
    if image.data.shape[-2:] != mask.data.shape[-2:]:
        sys.exit(f"the image ({image.data.shape[-2:]}) and the mask ({mask.data.shape[-2:]}) differ in size")
    per_px, area_unit = physical_area(image)
    labels = np.zeros(mask.data.shape, np.int32)
    rows, next_id = [], 1
    planes = list(mask.planes())
    for i, (idx, where) in enumerate(planes):
        lab = measure.label(mask.data[idx] != 0, connectivity=2)
        # the matching plane of the image: same t and z, channel 0 if the mask has none
        plane_image = image.data[tuple(where.get(ax, 0) for ax in image.axes[:-2])]
        h, w = lab.shape
        for r in measure.regionprops(lab, intensity_image=plane_image):
            if r.area < a.min_size or (a.max_size and r.area > a.max_size):
                continue
            y0, x0, y1, x1 = r.bbox
            if a.exclude_edges and (y0 == 0 or x0 == 0 or y1 == h or x1 == w):
                continue
            labels[idx][lab == r.label] = next_id
            row = {"id": next_id, **{ax: where[ax] for ax in "tcz" if ax in where}}
            row.update({
                "area_px": int(r.area),
                f"area_{area_unit}": round(r.area * per_px, 4),
                "x": round(float(r.centroid[1]), 2),
                "y": round(float(r.centroid[0]), 2),
                "perimeter_px": round(float(r.perimeter), 2),
                "circularity": round(min(1.0, 4 * math.pi * r.area / r.perimeter**2), 4) if r.perimeter else 1.0,
                "mean": round(float(r.intensity_mean), 4),
                "integrated_density": round(float(r.intensity_mean) * r.area * per_px, 4),
            })
            rows.append(row)
            next_id += 1
        if i % 8 == 0 or i == len(planes) - 1:
            progress((i + 1) / len(planes), f"{next_id - 1} particles so far")
    write(mask.like(labels), "/out/labels.zarr", "labels")
    write_table(rows, "/out/particles.csv")
    progress(1, f"{len(rows)} particles")


def op_measure(a):
    img = read(a.image)
    per_px, area_unit = physical_area(img)
    rows = []
    for idx, where in img.planes():
        p = img.data[idx].astype(np.float64)
        rows.append({
            **{ax: where[ax] for ax in "tcz" if ax in where},
            "area_px": int(p.size),
            f"area_{area_unit}": round(p.size * per_px, 4),
            "mean": round(float(p.mean()), 4),
            "std": round(float(p.std()), 4),
            "min": float(p.min()),
            "max": float(p.max()),
            "integrated_density": round(float(p.mean()) * p.size * per_px, 4),
        })
    write_table(rows, "/out/measurements.csv")
    progress(1, f"{len(rows)} plane{'s' if len(rows) != 1 else ''} measured")


# ---------------------------------------------------------------- command line


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="op", required=True)

    def op(name, fn, *args):
        s = sub.add_parser(name)
        for flag, kw in args:
            s.add_argument(flag, **kw)
        s.set_defaults(func=fn)

    image = ("--image", {"required": True})
    mask = ("--mask", {"required": True})
    op("invert", op_invert, image)
    op("gaussian-blur", op_gaussian_blur, image, ("--sigma", {"type": float, "default": 2.0}), ("--sigma-z", {"type": float, "default": 0.0}))
    op("flip", op_flip, image, ("--direction", {"choices": ["horizontal", "vertical"], "default": "horizontal"}))
    op("rotate", op_rotate, image, ("--direction", {"choices": ["right", "left"], "default": "right"}))
    op("set-scale", op_set_scale, image, ("--pixel-size", {"type": float, "required": True}), ("--z-size", {"type": float, "default": 0.0}), ("--unit", {"default": "µm"}))
    op("threshold", op_threshold, image, ("--method", {"default": "otsu"}), ("--foreground", {"choices": ["bright", "dark"], "default": "bright"}))
    for name in ("erode", "dilate", "open", "close"):
        op(name, binary(name), mask, ("--iterations", {"type": int, "default": 1}))
    for name in ("fill-holes", "outline", "skeletonize"):
        op(name, binary(name), mask)
    op("particles", op_particles, mask, image, ("--min-size", {"type": int, "default": 0}), ("--max-size", {"type": int, "default": 0}), ("--exclude-edges", {"type": lambda v: v == "true", "default": False}))
    op("measure", op_measure, image)
    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
