"""
ultrack: links per-frame labels into tracks for Pharos.

Reads /in/labels (OME-Zarr, axes t[z]yx: one label image per time point,
e.g. from cellpose), runs Ultrack, and writes
  /out/tracks.csv   one row per cell per time point: track_id, t, z, y, x (in pixels), parent_track_id
  /out/labels.zarr  the labels relabelled so each track keeps one id over time
Progress goes to stdout as JSON lines.
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
    attrs = group.attrs.asdict()
    ms = attrs.get("ome", attrs)["multiscales"][0]
    names = "".join(a["name"] if isinstance(a, dict) else a for a in ms["axes"])
    level = ms["datasets"][0]
    data = np.asarray(zarr.open_array(os.path.join(path, level["path"]), mode="r")[...])
    scale = [1.0] * len(names)
    for t in level.get("coordinateTransformations", []):
        if t.get("type") == "scale":
            scale = list(t["scale"])
    return data, names, scale, ms["axes"]


def write(path, labels, names, scale, axes_meta):
    root = zarr.open_group(path, mode="w")
    chunks = tuple(1 if a in "tz" else n for a, n in zip(names, labels.shape))
    from numcodecs import Zstd  # zstd: readable by Pharos itself for previews (blosc isn't)

    root.create_dataset("0", data=labels, chunks=chunks, compressor=Zstd(level=3))
    root.attrs["multiscales"] = [{"version": "0.4", "name": "tracks", "axes": axes_meta, "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": scale}]}]}]


def boundaries_between_cells(labels):
    """1 where two different cells touch, 0 elsewhere (spatial axes only; axis 0 is time).

    Segmenter labels are final: the only real boundaries are between cells. Edges
    against background would make thin (few z-slice) cells look split into slabs."""
    edges = np.zeros(labels.shape, bool)
    for axis in range(1, labels.ndim):
        a = np.moveaxis(labels, axis, 0)
        e = np.moveaxis(edges, axis, 0)
        touch = (a[1:] != a[:-1]) & (a[1:] > 0) & (a[:-1] > 0)
        e[1:] |= touch
        e[:-1] |= touch
    return edges.astype(np.float32)


def close_each_cell(labels):
    """Closes diagonal-only gaps inside each cell, one cell at a time (per time point).

    Segmenters such as Cellpose join a cell's slices diagonally at times; Ultrack
    connects voxels through faces only and would split such a cell into slabs.
    Closing cells one by one never bridges two neighbouring cells."""
    from scipy import ndimage

    out = labels.copy()
    face = ndimage.generate_binary_structure(labels.ndim - 1, 1)
    for t in range(labels.shape[0]):
        frame = labels[t]
        for i, box in enumerate(ndimage.find_objects(frame), start=1):
            if box is None:
                continue
            pad = tuple(slice(max(s.start - 1, 0), s.stop + 1) for s in box)
            cell = ndimage.binary_closing(frame[pad] == i, structure=face)
            region = out[t][pad]
            region[cell & (region == 0)] = i
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-size", type=int, default=50, help="smallest object, in voxels")
    ap.add_argument("--max-size", type=int, default=1000000, help="largest object, in voxels")
    ap.add_argument("--max-distance", type=float, default=15.0, help="largest move between frames, in physical units")
    ap.add_argument("--min-frontier", type=float, default=0.1, help="how clear a boundary must be to split an object (0-1)")
    args = ap.parse_args()

    from ultrack import MainConfig, to_tracks_layer, track, tracks_to_zarr
    from ultrack.core.solve.solver import mip_solver

    # Always use the free CBC solver: Ultrack tries Gurobi first, and without a Gurobi
    # licence (or under emulation) loading it can fail in ways its fallback doesn't catch.
    original_init = mip_solver.MIPSolver.__init__
    mip_solver.MIPSolver.__init__ = lambda self, config, solver="": original_init(self, config, "CBC")

    labels, names, scale, axes_meta = read(args.labels)
    if names[0] != "t" or labels.shape[0] < 2:
        raise SystemExit(f"tracking needs a time axis with at least 2 frames, got axes {names} and shape {list(labels.shape)}")
    spatial = scale[1:]
    print(f"tracking {labels.shape[0]} frames of {list(labels.shape[1:])}, scale {spatial}", file=sys.stderr, flush=True)

    config = MainConfig()
    config.data_config.working_dir = "/tmp/ultrack"
    os.makedirs(config.data_config.working_dir, exist_ok=True)
    config.segmentation_config.min_area = args.min_size
    config.segmentation_config.max_area = args.max_size
    # labels from a segmenter have no inner boundaries; without this Ultrack also proposes
    # halves of the same cell, and can track both halves as separate cells
    config.segmentation_config.min_frontier = args.min_frontier
    config.linking_config.max_distance = args.max_distance
    config.tracking_config.time_limit = 600

    # track() runs three long stages without a word; report each as it starts
    stages = sys.modules[track.__module__]
    for name, (p, message) in {
        "segment": (0.1, "finding candidate cells in each frame"),
        "link": (0.45, "linking candidates between frames"),
        "solve": (0.65, "choosing the best tracks"),
    }.items():
        original = getattr(stages, name)
        setattr(stages, name, lambda *a, _f=original, _p=p, _m=message, **k: (progress(_p, _m), _f(*a, **k))[1])

    progress(0.05, "preparing the labels")
    closed = close_each_cell(labels)
    track(config, foreground=(closed > 0).astype(np.float32), contours=boundaries_between_cells(closed), scale=spatial, overwrite=True)
    progress(0.8, "exporting tracks")
    tracks, _graph = to_tracks_layer(config)
    os.makedirs(args.out, exist_ok=True)
    keep = [c for c in ("track_id", "t", "z", "y", "x", "parent_track_id") if c in tracks.columns]
    tracks[keep].to_csv(os.path.join(args.out, "tracks.csv"), index=False)
    relabelled = np.asarray(tracks_to_zarr(config, tracks)[...])
    write(os.path.join(args.out, "labels.zarr"), relabelled.astype(np.uint32 if relabelled.max() >= 65535 else np.uint16), names, scale, axes_meta)
    n = tracks["track_id"].nunique()
    progress(1.0, f"{n} tracks")


if __name__ == "__main__":
    main()
