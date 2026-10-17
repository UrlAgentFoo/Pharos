"""
yolo: finds and outlines objects with Ultralytics YOLO for Pharos, as labels.

Reads /in/image (OME-Zarr, or TIFF; axes a subset of t, c, z, y, x), runs a
YOLO segmentation model on each 2D plane (every z slice of every time
point), and writes every object it finds as its own label: OME-Zarr with
the image's t, z, y, x axes and scale, plus a CSV of the objects (where,
which class, how sure). Where objects overlap, the more confident one
keeps the pixels. A model that only draws boxes fills each box.

The models baked into the image know the 80 everyday COCO classes; for
cells or anything else, train YOLO on your own images and put the weights
in Pharos's weights folder (mounted at /weights). Progress goes to stdout
as JSON lines.
"""

import argparse
import csv
import json
import os
import sys

import numpy as np
import zarr

MODELS = {"nano": "yolo11n-seg.pt", "small": "yolo11s-seg.pt", "medium": "yolo11m-seg.pt"}
BAKED = "/opt/yolo"
WEIGHTS = "/weights"
AXES = "tczyx"


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def read(path):
    """The image as (data, axes, scale per axis, OME axes metadata)."""
    if os.path.isdir(path):
        group = zarr.open_group(path, mode="r")
        attrs = dict(group.attrs)
        ms = attrs.get("ome", attrs)["multiscales"][0]
        axes_meta = ms["axes"]
        names = "".join(a["name"] if isinstance(a, dict) else a for a in axes_meta)
        level = ms["datasets"][0]
        data = np.asarray(zarr.open_array(os.path.join(path, level["path"]), mode="r")[...])
        scale = [1.0] * len(names)
        for t in level.get("coordinateTransformations", []):
            if t.get("type") == "scale":
                scale = list(t["scale"])
        return data, names, scale, axes_meta
    import tifffile

    with tifffile.TiffFile(path) as f:
        series = f.series[0]
        data = series.asarray()
        # RGB samples count as channels; a plain stack of pages, as z
        names = series.axes.lower().replace("s", "c").replace("i", "z").replace("q", "z")
    if len(set(names)) != len(names) or not set(names) <= set(AXES):
        raise SystemExit(f"can't read the TIFF's axes ({names}): convert it to OME-Zarr first (bio-utils › convert)")
    kind = {"t": "time", "c": "channel"}
    return data, names, [1.0] * len(names), [{"name": a, "type": kind.get(a, "space")} for a in names]


def write(path, labels, names, scale, axes_meta):
    group = zarr.open_group(path, mode="w", zarr_format=2)
    chunks = tuple(1 if a in "tz" else n for a, n in zip(names, labels.shape))
    from numcodecs import Zstd  # zstd: readable by Pharos itself for previews (blosc isn't)

    arr = group.create_array("0", shape=labels.shape, dtype=labels.dtype, chunks=chunks, compressors=Zstd(level=3))
    arr[...] = labels
    keep = [a for a in axes_meta if (a["name"] if isinstance(a, dict) else a) in names]
    group.attrs["multiscales"] = [
        {"version": "0.4", "name": "masks", "axes": keep, "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": scale}]}]}
    ]


def weights_path(model, weights):
    if weights.strip():
        # only a file name, so a setting can't reach outside the weights folder
        name = os.path.basename(weights.strip())
        path = os.path.join(WEIGHTS, name)
        if not os.path.isfile(path):
            raise SystemExit(f'no weights named "{name}" in Pharos\'s weights folder: copy your trained .pt file into ~/Pharos/weights and name it here')
        return path
    return os.path.join(BAKED, MODELS[model])


def to_uint8(data, channel_axis):
    """Scales each channel to 0-255 over the whole image (1st to 99.8th percentile), so every plane is lit alike."""
    data = data.astype(np.float32)
    if channel_axis is None:
        lo, hi = np.percentile(data, [1, 99.8])
        return (np.clip((data - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)
    out = np.empty(data.shape, np.uint8)
    for c in range(data.shape[channel_axis]):
        sl = [slice(None)] * data.ndim
        sl[channel_axis] = c
        plane = data[tuple(sl)]
        lo, hi = np.percentile(plane, [1, 99.8])
        out[tuple(sl)] = (np.clip((plane - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="nano", choices=list(MODELS))
    ap.add_argument("--weights", default="")
    ap.add_argument("--confidence", type=float, default=0.25)
    ap.add_argument("--classes", default="")
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--channel", type=int, default=-1)
    args = ap.parse_args()

    progress(0.02, "loading the model")
    from ultralytics import YOLO

    model = YOLO(weights_path(args.model, args.weights))
    known = {str(n).lower(): i for i, n in model.names.items()}
    wanted = [c.strip().lower() for c in args.classes.split(",") if c.strip()]
    unknown = [c for c in wanted if c not in known]
    if unknown:
        sample = ", ".join(list(known)[:12])
        raise SystemExit(f"this model has no class {', '.join(unknown)}; it knows {len(known)}, such as {sample}")
    class_ids = [known[c] for c in wanted] or None

    data, names, scale, axes_meta = read(args.input)
    if not {"y", "x"} <= set(names):
        raise SystemExit(f"need y and x axes, got {names}")
    # the planes the model sees: one channel as grey, or the first three as colour
    if "c" in names:
        c = names.index("c")
        if args.channel >= 0:
            if args.channel >= data.shape[c]:
                raise SystemExit(f"channel {args.channel} doesn't exist: the image has {data.shape[c]}")
            data = np.take(data, args.channel, axis=c)
            colour = None
        else:
            data = np.take(data, range(min(3, data.shape[c])), axis=c)
            colour = c
        if colour is None:
            scale = [s for i, s in enumerate(scale) if i != c]
            names = names.replace("c", "")
    else:
        colour = None
    data = to_uint8(data, colour)
    if colour is not None:
        data = np.moveaxis(data, colour, -1)  # channels last, as YOLO wants
        scale = [s for i, s in enumerate(scale) if i != names.index("c")]
        names = names.replace("c", "")

    # every plane: an index over the axes before y, x
    lead = data.shape[: len(names) - 2]
    labels = np.zeros(data.shape[: len(names)], np.uint32)
    rows = []
    next_id = 1
    planes = list(np.ndindex(*lead)) if lead else [()]
    for k, at in enumerate(planes):
        plane = data[at]
        img = np.repeat(plane[..., None], 3, axis=-1) if plane.ndim == 2 else (plane if plane.shape[-1] == 3 else np.concatenate([plane] + [plane[..., -1:]] * (3 - plane.shape[-1]), axis=-1))
        h, w = img.shape[:2]
        r = model.predict(np.ascontiguousarray(img), imgsz=args.size, conf=args.confidence, classes=class_ids, retina_masks=True, verbose=False)[0]
        out = labels[at]
        found = len(r.boxes) if r.boxes is not None else 0
        confidences = r.boxes.conf.cpu().numpy() if found else np.zeros(0)
        # least sure first, so the surest object keeps the pixels where two overlap
        for i in np.argsort(confidences):
            x0, y0, x1, y1 = (float(v) for v in r.boxes.xyxy[i].cpu().numpy())
            if r.masks is not None:
                mask = r.masks.data[i].cpu().numpy() > 0.5
                if mask.shape != (h, w):
                    import cv2

                    mask = cv2.resize(mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
            else:
                mask = np.zeros((h, w), bool)
                mask[max(0, int(y0)) : min(h, int(np.ceil(y1))), max(0, int(x0)) : min(w, int(np.ceil(x1)))] = True
            out[mask] = next_id
            where = dict(zip([a for a in names[:-2]], at))
            rows.append({"label": next_id, **where, "class": model.names[int(r.boxes.cls[i])], "confidence": round(float(confidences[i]), 4), "x_min": round(x0, 1), "y_min": round(y0, 1), "x_max": round(x1, 1), "y_max": round(y1, 1)})
            next_id += 1
        progress((k + 1) / len(planes), f"plane {k + 1} of {len(planes)}: {found} object{'' if found == 1 else 's'}" if len(planes) > 1 else f"{found} object{'' if found == 1 else 's'}")

    # areas after overlaps; an object another one covered completely is gone
    areas = np.bincount(labels.ravel(), minlength=next_id)
    rows = [{**row, "area_px": int(areas[row["label"]])} for row in rows if areas[row["label"]] > 0]
    dtype = np.uint16 if next_id < 65535 else np.uint32
    write(os.path.join(args.out, "masks.zarr"), labels.astype(dtype), names, scale, axes_meta)
    columns = ["label", *[a for a in names[:-2]], "class", "confidence", "x_min", "y_min", "x_max", "y_max", "area_px"]
    with open(os.path.join(args.out, "objects.csv"), "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} objects over {len(planes)} plane(s)", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
