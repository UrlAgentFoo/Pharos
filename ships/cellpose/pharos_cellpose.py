"""
cellpose: segments cells or nuclei in an OME-Zarr image for Pharos.

Reads /in/image (OME-Zarr, axes a subset of t, c, z, y, x), runs Cellpose 3
on one channel, in 3D when the image has z, separately for each time
point, and writes the labels as OME-Zarr with the same t, z, y, x axes and
scale. Progress goes to stdout as JSON lines.
"""

import argparse
import json
import os
import sys

import numpy as np
import zarr


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def read(path):
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
            scale = t["scale"]
    return data, names, scale, axes_meta


def write(path, labels, names, scale, axes_meta):
    group = zarr.open_group(path, mode="w", zarr_format=2)
    chunks = tuple(1 if a in "tz" else n for a, n in zip(names, labels.shape))
    arr = group.create_array("0", shape=labels.shape, dtype=labels.dtype, chunks=chunks)
    arr[...] = labels
    keep = [a for a in axes_meta if (a["name"] if isinstance(a, dict) else a) in names]
    group.attrs["multiscales"] = [
        {"version": "0.4", "name": "masks", "axes": keep, "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": scale}]}]}
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="nuclei", choices=["nuclei", "cyto3"])
    ap.add_argument("--diameter", type=float, default=30)
    ap.add_argument("--channel", type=int, default=0)
    args = ap.parse_args()

    progress(0.02, "loading the model")
    import torch
    from cellpose import models

    gpu = torch.cuda.is_available()
    print(f"cellpose on {'GPU' if gpu else 'CPU'}, model {args.model}", file=sys.stderr, flush=True)
    model = models.Cellpose(gpu=gpu, model_type=args.model)

    data, names, scale, axes_meta = read(args.input)
    if "c" in names:
        c = names.index("c")
        if args.channel >= data.shape[c]:
            raise SystemExit(f"channel {args.channel} doesn't exist: the image has {data.shape[c]}")
        data = np.take(data, args.channel, axis=c)
        scale = [s for i, s in enumerate(scale) if i != c]
        names = names.replace("c", "")
    if not {"y", "x"} <= set(names):
        raise SystemExit(f"need y and x axes, got {names}")

    three_d = "z" in names
    frames = data.shape[0] if "t" in names else 1
    sx = scale[names.index("x")]
    anisotropy = scale[names.index("z")] / sx if three_d and sx else 1.0
    diameter = args.diameter or None  # 0 → Cellpose estimates it
    out = np.zeros(data.shape, np.uint32)
    for t in range(frames):
        frame = data[t] if "t" in names else data
        masks, _, _, diams = model.eval(
            frame.astype(np.float32),
            diameter=diameter,
            channels=[0, 0],
            do_3D=three_d,
            anisotropy=anisotropy if three_d else None,
            z_axis=0 if three_d else None,
        )
        if "t" in names:
            out[t] = masks
        else:
            out = masks.astype(np.uint32)
        n = int(masks.max())
        progress((t + 1) / frames, f"frame {t + 1} of {frames}: {n} objects" + (f" (diameter {float(np.atleast_1d(diams)[0]):.1f} px)" if not diameter else ""))
    dtype = np.uint16 if out.max() < 65535 else np.uint32
    write(args.out, out.astype(dtype), names, scale, axes_meta)


if __name__ == "__main__":
    main()
