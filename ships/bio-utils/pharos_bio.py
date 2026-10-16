"""
bio-utils: convert, inspect and measure microscopy data for Pharos.

Each operation reads its inputs from /in, writes to /out and exits.
Progress goes to stdout as JSON lines ({"progress": 0.4, "message": "..."});
anything else printed is the log.

Images are kept in canonical axis order: a subset of t, c, z, y, x.
OME-Zarr is written as NGFF 0.4 (Zarr format 2), the most widely read
version.
"""

import argparse
import csv
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

CANONICAL = "tczyx"


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- reading


class Image:
    """An array with its axes (a subset of tczyx, in that order) and physical scale."""

    def __init__(self, data, axes, scale=None, unit="pixel", frame_interval=None):
        self.data = data
        self.axes = axes
        self.scale = scale or {}  # axis -> size of one step, e.g. {"z": 2.0, "y": 0.3, "x": 0.3}
        self.unit = unit
        self.frame_interval = frame_interval

    def canonical(self):
        """Reorders to tczyx order, dropping axes of other kinds."""
        keep = [a for a in CANONICAL if a in self.axes]
        order = [self.axes.index(a) for a in keep]
        data = np.transpose(self.data, order) if order != list(range(len(order))) else self.data
        return Image(data, "".join(keep), self.scale, self.unit, self.frame_interval)


def _axes_from_letters(letters):
    """Maps vendor axis letters (TZCYX, S for RGB samples, Q for unknown) to ours."""
    out = []
    for ch in letters.upper():
        out.append({"T": "t", "Z": "z", "C": "c", "S": "c", "Y": "y", "X": "x", "I": "z", "Q": "z"}.get(ch, "?"))
    return "".join(out)


def _squeeze_unknown(data, axes):
    """Drops length-1 axes we don't know; refuses unknown axes with data."""
    for i in reversed(range(len(axes))):
        if axes[i] == "?":
            if data.shape[i] != 1:
                raise SystemExit(f"unsupported axis of length {data.shape[i]} in this file")
            data = np.take(data, 0, axis=i)
            axes = axes[:i] + axes[i + 1 :]
    # the same letter twice (e.g. C and S): merge by keeping the first
    seen = []
    for i, a in enumerate(axes):
        if a in seen:
            raise SystemExit(f"axis {a} appears twice in this file")
        seen.append(a)
    return data, axes


def read_tiff(path):
    import tifffile

    with tifffile.TiffFile(path) as tif:
        series = tif.series[0]
        data = series.asarray()
        axes = _axes_from_letters(series.axes)
        data, axes = _squeeze_unknown(data, axes)
        scale, unit, interval = {}, "pixel", None
        if tif.is_ome:
            import xml.etree.ElementTree as ET

            root = ET.fromstring(tif.ome_metadata)
            px = next((e for e in root.iter() if e.tag.endswith("Pixels")), None)
            if px is not None:
                for ax, key in (("x", "PhysicalSizeX"), ("y", "PhysicalSizeY"), ("z", "PhysicalSizeZ")):
                    if px.get(key):
                        scale[ax] = float(px.get(key))
                unit = px.get("PhysicalSizeXUnit", "µm") if scale else unit
                if px.get("TimeIncrement"):
                    interval = float(px.get("TimeIncrement"))
        elif tif.is_imagej:
            meta = tif.imagej_metadata or {}
            page = tif.pages[0]
            res = page.tags.get("XResolution")
            if res and res.value[0]:
                step = res.value[1] / res.value[0]
                scale["x"] = scale["y"] = step
            if "spacing" in meta:
                scale["z"] = float(meta["spacing"])
            unit = {"micron": "µm", "um": "µm", "\\u00B5m": "µm"}.get(meta.get("unit", ""), meta.get("unit", "pixel"))
            if meta.get("finterval"):
                interval = float(meta["finterval"])
        return Image(data, axes, scale, unit, interval)


def read_nd2(path):
    import nd2

    with nd2.ND2File(path) as f:
        data = f.asarray()
        axes = _axes_from_letters("".join(f.sizes.keys()))
        data, axes = _squeeze_unknown(data, axes)
        vs = f.voxel_size()
        return Image(data, axes, {"x": vs.x, "y": vs.y, "z": vs.z}, "µm")


def read_lif(path):
    from readlif.reader import LifReader

    img = LifReader(path).get_image(0)
    nt, nz, nc = img.dims.t, img.dims.z, img.channels
    planes = np.stack(
        [np.stack([np.stack([np.asarray(img.get_frame(z=z, t=t, c=c)) for z in range(nz)]) for c in range(nc)]) for t in range(nt)]
    )
    scale = {}
    if img.scale[0]:
        scale["x"] = 1 / img.scale[0]
    if img.scale[1]:
        scale["y"] = 1 / img.scale[1]
    if img.scale[2]:
        scale["z"] = 1 / img.scale[2]
    return Image(planes, "tczyx", scale, "µm")


def read_czi(path):
    import czifile

    with czifile.CziFile(path) as czi:
        data = czi.asarray()
        axes = _axes_from_letters(czi.axes)  # scene, block, mosaic and similar axes must be length 1
        data, axes = _squeeze_unknown(data, axes)
        return Image(data, axes)


def read_zarr(path):
    import zarr

    group = zarr.open_group(path, mode="r")
    attrs = dict(group.attrs)
    ome = attrs.get("ome", attrs)
    ms = ome["multiscales"][0]
    names = "".join(a["name"] if isinstance(a, dict) else a for a in ms["axes"])
    level = ms["datasets"][0]
    data = np.asarray(zarr.open_array(os.path.join(path, level["path"]), mode="r")[...])
    scale = {}
    for t in level.get("coordinateTransformations", []):
        if t.get("type") == "scale":
            scale = {a: s for a, s in zip(names, t["scale"]) if a in "zyx"}
    unit = next((a.get("unit") for a in ms["axes"] if isinstance(a, dict) and a.get("name") == "x" and a.get("unit")), "pixel")
    return Image(data, names, scale, {"micrometer": "µm"}.get(unit, unit))


def read_image(path):
    p = path.lower().rstrip("/")
    if os.path.isdir(path) or p.endswith(".zarr"):
        return read_zarr(path).canonical()
    if p.endswith((".tif", ".tiff")):
        return read_tiff(path).canonical()
    if p.endswith(".nd2"):
        return read_nd2(path).canonical()
    if p.endswith(".lif"):
        return read_lif(path).canonical()
    if p.endswith(".czi"):
        return read_czi(path).canonical()
    raise SystemExit(f"bio-utils can't read {os.path.basename(path)}")


# ---------------------------------------------------------------- writing


def write_ome_zarr(path, image, name="image"):
    """Writes one resolution level as OME-NGFF 0.4 in Zarr format 2."""
    import zarr

    data = image.data
    group = zarr.open_group(path, mode="w", zarr_format=2)
    # chunk planes (y, x) whole, one step along the other axes
    chunks = tuple(1 if a in "tcz" else n for a, n in zip(image.axes, data.shape))
    arr = group.create_array("0", shape=data.shape, dtype=data.dtype, chunks=chunks)
    arr[...] = data
    unit = {"µm": "micrometer", "um": "micrometer", "nm": "nanometer"}.get(image.unit)
    axes = []
    for a in image.axes:
        ax = {"name": a, "type": "time" if a == "t" else "channel" if a == "c" else "space"}
        if a in "zyx" and unit:
            ax["unit"] = unit
        axes.append(ax)
    scale = [float(image.scale.get(a, 1.0)) for a in image.axes]
    group.attrs["multiscales"] = [
        {
            "version": "0.4",
            "name": name,
            "axes": axes,
            "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": scale}]}],
        }
    ]


# ---------------------------------------------------------------- operations


def summary(image, name, size):
    shape = list(image.data.shape)
    out = {
        "name": name,
        "sizeBytes": size,
        "axes": image.axes,
        "shape": shape,
        "dtype": str(image.data.dtype),
        "channels": shape[image.axes.index("c")] if "c" in image.axes else 1,
        "timepoints": shape[image.axes.index("t")] if "t" in image.axes else 1,
    }
    if "x" in image.scale:
        out["voxelSize"] = {"x": image.scale["x"], "y": image.scale.get("y", image.scale["x"]), **({"z": image.scale["z"]} if "z" in image.scale else {}), "unit": image.unit}
    if image.frame_interval:
        out["frameInterval"] = {"value": image.frame_interval, "unit": "s"}
    return out


def cmd_convert(args):
    progress(0.05, "reading")
    image = read_image(args.input)
    log(f"read {os.path.basename(args.input)}: axes {image.axes}, shape {list(image.data.shape)}, {image.data.dtype}")
    progress(0.6, "writing OME-Zarr")
    write_ome_zarr(args.out, image, Path(args.input).stem)
    progress(1.0, "done")


def cmd_inspect(args):
    image = read_image(args.input)
    size = os.path.getsize(args.input) if os.path.isfile(args.input) else sum(f.stat().st_size for f in Path(args.input).rglob("*") if f.is_file())
    with open(args.out, "w") as f:
        json.dump(summary(image, os.path.basename(args.input.rstrip("/")), size), f, indent=2)
    progress(1.0, "done")


def cmd_measure(args):
    from skimage.measure import regionprops_table

    progress(0.05, "reading")
    labels = read_image(args.labels)
    image = read_image(args.image)
    if "c" in labels.axes:
        raise SystemExit("labels must not have a channel axis")
    spatial = [a for a in labels.axes if a in "zyx"]
    voxel = math.prod(image.scale.get(a, labels.scale.get(a, 1.0)) for a in spatial)
    unit = image.unit if image.unit != "pixel" else labels.unit
    frames = labels.data.shape[0] if "t" in labels.axes else 1
    channels = image.data.shape[image.axes.index("c")] if "c" in image.axes else 1

    def frame(img, axes, t):
        return np.take(img, t, axis=axes.index("t")) if "t" in axes else img

    rows = []
    for t in range(frames):
        lab = frame(labels.data, labels.axes, t)
        img_axes = image.axes.replace("t", "")
        img = frame(image.data, image.axes, t)
        # intensity image with channels last, as scikit-image expects
        if "c" in img_axes:
            img = np.moveaxis(img, img_axes.index("c"), -1)
        if img.shape[: lab.ndim] != lab.shape:
            raise SystemExit(f"labels {list(lab.shape)} and image {list(img.shape[: lab.ndim])} differ in size")
        props = regionprops_table(lab.astype(np.int64), intensity_image=img, properties=("label", "area", "centroid", "intensity_mean"))
        n = len(props["label"])
        for i in range(n):
            row = {"label": int(props["label"][i])}
            if frames > 1:
                row = {"t": t, **row}
            row["voxels"] = int(props["area"][i])
            # plain ASCII column names, so the table opens cleanly anywhere: volume_um3, area_um2
            plain = {"µm": "um"}.get(unit, unit)
            name = ("volume" if len(spatial) == 3 else "area") + f"_{plain}{len(spatial)}"
            row[name if unit != "pixel" else "voxels_scaled"] = round(props["area"][i] * voxel, 4)
            for k, a in enumerate(spatial):
                row[f"centroid_{a}"] = round(float(props[f"centroid-{k}"][i]), 3)
            for c in range(channels):
                key = f"intensity_mean-{c}" if channels > 1 else "intensity_mean"
                row[f"mean_intensity{f'_c{c}' if channels > 1 else ''}"] = round(float(props[key][i]), 3)
            rows.append(row)
        progress((t + 1) / frames, f"frame {t + 1} of {frames}: {n} objects")
    with open(args.out, "w", newline="") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        else:
            f.write("label,voxels\n")
    log(f"measured {len(rows)} objects")


def main():
    parser = argparse.ArgumentParser(prog="pharos_bio")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("convert")
    p.add_argument("--in", dest="input", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("inspect")
    p.add_argument("--in", dest="input", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("measure")
    p.add_argument("--labels", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    {"convert": cmd_convert, "inspect": cmd_inspect, "measure": cmd_measure}[args.cmd](args)


if __name__ == "__main__":
    main()
