"""
yolo: finds and outlines objects with Ultralytics YOLO for Pharos.

  segment        an image (OME-Zarr, or TIFF; axes a subset of t, c, z, y, x)
                 -> every object as its own label, OME-Zarr with the image's
                 t, z, y, x axes and scale, plus a CSV of the objects (where,
                 which class, how sure); every 2D plane is looked at
  segment-video  a video -> an MP4 with each object outlined and named, plus
                 a CSV of the objects in each frame

Where objects overlap, the more confident one keeps the pixels. A model that
only draws boxes fills each box.

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
from collections import Counter

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
    if data.dtype == np.uint8 and channel_axis is not None:
        return data  # an 8-bit colour image is a photo: stretching each channel would shift its colours
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


def load_model(args):
    """The model, and the class ids to keep (None for all)."""
    progress(0.02, "loading the model")
    from ultralytics import YOLO

    model = YOLO(weights_path(args.model, args.weights))
    known = {str(n).lower(): i for i, n in model.names.items()}
    wanted = [c.strip().lower() for c in args.classes.split(",") if c.strip()]
    unknown = [c for c in wanted if c not in known]
    if unknown:
        sample = ", ".join(list(known)[:12])
        raise SystemExit(f"this model has no class {', '.join(unknown)}; it knows {len(known)}, such as {sample}")
    return model, [known[c] for c in wanted] or None


def mask_of(r, i, h, w):
    """Object i's pixels in an (h, w) image: its outline filled, or its box for a model that only draws boxes."""
    if r.masks is not None:
        mask = r.masks.data[i].cpu().numpy() > 0.5
        if mask.shape != (h, w):
            import cv2

            mask = cv2.resize(mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
        return mask
    x0, y0, x1, y1 = (float(v) for v in r.boxes.xyxy[i].cpu().numpy())
    mask = np.zeros((h, w), bool)
    mask[max(0, int(y0)) : min(h, int(np.ceil(y1))), max(0, int(x0)) : min(w, int(np.ceil(x1)))] = True
    return mask


def found_summary(rows):
    """The classes found, most first: "12 person, 3 car"."""
    return ", ".join(f"{n} {c}" for c, n in Counter(r["class"] for r in rows).most_common()) or "nothing"


def segment(args):
    model, class_ids = load_model(args)
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
        # YOLO takes arrays in OpenCV's blue, green, red order
        r = model.predict(np.ascontiguousarray(img[..., ::-1]), imgsz=args.size, conf=args.confidence, classes=class_ids, retina_masks=True, verbose=False)[0]
        out = labels[at]
        found = len(r.boxes) if r.boxes is not None else 0
        confidences = r.boxes.conf.cpu().numpy() if found else np.zeros(0)
        # least sure first, so the surest object keeps the pixels where two overlap
        for i in np.argsort(confidences):
            x0, y0, x1, y1 = (float(v) for v in r.boxes.xyxy[i].cpu().numpy())
            out[mask_of(r, i, h, w)] = next_id
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
    print(f"{len(rows)} objects over {len(planes)} plane(s): {found_summary(rows)}", file=sys.stderr, flush=True)


def even_size(w, h, longest):
    """(w, h) scaled down so the longer side is at most `longest`, both even for the H.264 encoder."""
    f = min(1.0, longest / max(w, h))
    return max(2, int(round(w * f / 2)) * 2), max(2, int(round(h * f / 2)) * 2)


def segment_video(args):
    import cv2
    import imageio_ffmpeg

    model, class_ids = load_model(args)
    video = cv2.VideoCapture(args.video)
    if not video.isOpened():
        raise SystemExit("couldn't open the video: is it an MP4 or MOV file?")
    source_fps = video.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(video.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    # every frame, or the ones nearest each step of 1 / fps seconds
    fps = min(args.fps, source_fps) if args.fps > 0 else source_fps
    step = source_fps / fps

    writer = None
    rows = []
    kept = 0
    index = -1
    while True:
        ok, frame = video.read()  # blue, green, red, as YOLO takes them
        if not ok:
            break
        index += 1
        if index < round(kept * step):
            continue
        h, w = frame.shape[:2]
        size = even_size(w, h, args.max_size)
        if size != (w, h):
            frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
            w, h = size
        r = model.predict(frame, imgsz=args.size, conf=args.confidence, classes=class_ids, retina_masks=True, verbose=False)[0]
        found = len(r.boxes) if r.boxes is not None else 0
        for i in range(found):
            x0, y0, x1, y1 = (float(v) for v in r.boxes.xyxy[i].cpu().numpy())
            rows.append({"t": kept, "time_s": round(index / source_fps, 3), "class": model.names[int(r.boxes.cls[i])], "confidence": round(float(r.boxes.conf[i]), 4),
                         "x_min": round(x0, 1), "y_min": round(y0, 1), "x_max": round(x1, 1), "y_max": round(y1, 1), "area_px": int(mask_of(r, i, h, w).sum())})
        if writer is None:
            writer = imageio_ffmpeg.write_frames(args.out_video, (w, h), fps=fps, codec="libx264", quality=None, macro_block_size=2,
                                                 output_params=["-crf", "23", "-preset", "veryfast", "-movflags", "+faststart"])
            writer.send(None)
        writer.send(np.ascontiguousarray(r.plot()[..., ::-1]))  # outlines, boxes and names drawn, back to red, green, blue
        kept += 1
        message = f"{index / source_fps:.1f} s: {found} object{'' if found == 1 else 's'}"
        progress(0.05 + 0.94 * min(index + 1, total) / total if total else 0.5, message)
    video.release()
    if writer is None:
        raise SystemExit("the video has no frames Pharos could read")
    writer.close()

    with open(args.table, "w", newline="") as f:
        out = csv.DictWriter(f, fieldnames=["t", "time_s", "class", "confidence", "x_min", "y_min", "x_max", "y_max", "area_px"])
        out.writeheader()
        out.writerows(rows)
    print(f"{len(rows)} objects over {kept} frames at {fps:g} fps: {found_summary(rows)}", file=sys.stderr, flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="op", required=True)
    for name in ("segment", "segment-video"):
        p = sub.add_parser(name)
        p.add_argument("--model", default="nano", choices=list(MODELS))
        p.add_argument("--weights", default="")
        p.add_argument("--confidence", type=float, default=0.25)
        p.add_argument("--classes", default="")
        p.add_argument("--size", type=int, default=640)
        if name == "segment":
            p.add_argument("--in", dest="input", required=True)
            p.add_argument("--out", required=True)
            p.add_argument("--channel", type=int, default=-1)
        else:
            p.add_argument("--video", required=True)
            p.add_argument("--out-video", required=True)
            p.add_argument("--table", required=True)
            p.add_argument("--fps", type=float, default=0)
            p.add_argument("--max-size", type=int, default=1280)
    args = ap.parse_args()
    segment(args) if args.op == "segment" else segment_video(args)


if __name__ == "__main__":
    main()
