"""
Builds the synthetic test data for space-time-field, geff and the Track nuclei and score
against ground truth book: a small movie laid out like a Biohub challenge video (OME-Zarr v3,
axes T Z Y X, voxel 1.625 × 0.40625 × 0.40625 µm, a cubic field of view) and its ground truth
as a GEFF graph. Deterministic; run it in this ship's image, from the repository root:

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo" -w /repo \
      --entrypoint python pharos/space-time-field:0.1.0 ships/space-time-field/make_test_data.py
"""

import os
import shutil

import numpy as np
import zarr
from zarr.codecs import BloscCodec, ZstdCodec

SCALE = np.array([1.625, 0.40625, 0.40625])  # µm per voxel (z, y, x)
SHAPE = (24, 96, 96)                          # a 39 µm cube
FRAMES = 12


def nuclei(seed=7, n=10):
    """Positions (t, n, 3) in µm of n nuclei wandering slowly, kept apart and inside the view."""
    rng = np.random.default_rng(seed)
    fov = np.array(SHAPE) * SCALE
    pos = []
    while len(pos) < n:
        p = rng.uniform(6, fov - 6)
        if all(np.linalg.norm(p - q) > 10 for q in pos):
            pos.append(p)
    pos = np.array(pos)
    out = [pos]
    for _ in range(FRAMES - 1):
        pos = np.clip(pos + rng.normal(0, 0.6, pos.shape), 5, fov - 5)
        out.append(pos)
    return np.array(out)


def movie(paths, seed=8):
    """Each nucleus a soft 6 µm ball, plus camera noise, as uint16."""
    rng = np.random.default_rng(seed)
    grid = np.stack(np.indices(SHAPE, dtype=np.float32), -1) * SCALE
    frames = []
    for t in range(FRAMES):
        img = np.full(SHAPE, 120.0, np.float32)
        for p in paths[t]:
            d2 = ((grid - p) ** 2).sum(-1)
            img += 900 * np.exp(-d2 / (2 * 2.2**2))
        img += rng.normal(0, 6, SHAPE)
        frames.append(np.clip(img, 0, 65535).astype(np.uint16))
    return np.stack(frames)


def write_movie(path, data):
    shutil.rmtree(path, ignore_errors=True)
    g = zarr.open_group(path, mode="w", zarr_format=3)
    g.create_array("0", data=data, chunks=(1, *SHAPE), compressors=BloscCodec(cname="zstd", clevel=5, shuffle="bitshuffle"))
    g.attrs["multiscales"] = [{
        "version": "0.5", "name": "0",
        "axes": [{"name": "T", "type": "time", "unit": "second"}] + [{"name": a, "type": "space", "unit": "micrometer"} for a in "ZYX"],
        "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1.0, *SCALE.tolist()]}]}],
    }]


def write_geff(path, paths, keep):
    """The truth for the nuclei in `keep` only, as the challenge's ground truth is sparse."""
    shutil.rmtree(path, ignore_errors=True)
    ids, props, edges = [], {a: [] for a in "tzyx"}, []
    for i in keep:
        prev = None
        for t in range(FRAMES):
            nid = len(ids) + 1
            ids.append(nid)
            v = np.round(paths[t, i] / SCALE).astype(np.int64)
            for a, x in zip("tzyx", (t, *v)):
                props[a].append(int(x))
            if prev is not None:
                edges.append((prev, nid))
            prev = nid
    g = zarr.open_group(path, mode="w", zarr_format=3)
    axes = [{"name": "t", "type": "time", "unit": None, "min": 0.0, "max": float(FRAMES - 1), "scale": 1.0}]
    axes += [{"name": a, "type": "space", "unit": None, "min": float(min(props[a])), "max": float(max(props[a])), "scale": float(s)} for a, s in zip("zyx", SCALE)]
    g.attrs["geff"] = {
        "geff_version": "1.1", "directed": True, "axes": axes,
        "node_props_metadata": {a: {"identifier": a, "dtype": "int64", "varlength": False} for a in "tzyx"},
        "edge_props_metadata": {},
        "extra": {"estimated_number_of_nodes": int(paths.shape[1] * FRAMES)},
    }
    z = ZstdCodec(level=0)
    g.create_array("nodes/ids", data=np.array(ids, np.uint64), compressors=z)
    for a in "tzyx":
        g.create_array(f"nodes/props/{a}/values", data=np.array(props[a], np.int64), compressors=z)
    g.create_array("edges/ids", data=np.array(edges, np.uint64).reshape(-1, 2), compressors=z)
    g.create_group("edges/props")


def write_tracks(path, paths):
    """Tracks as Ultrack writes them (track_id, t, z, y, x in voxels), from the true positions."""
    with open(path, "w") as f:
        f.write("track_id,t,z,y,x,parent_track_id\n")
        for i in range(paths.shape[1]):
            for t in range(FRAMES):
                z, y, x = paths[t, i] / SCALE
                f.write(f"{i + 1},{t},{z:.3f},{y:.3f},{x:.3f},-1\n")


def main():
    paths = nuclei()
    data = movie(paths)
    keep = [0, 2, 3, 5, 7, 8]
    os.makedirs("ships/space-time-field/test/track", exist_ok=True)
    os.makedirs("ships/space-time-field/test/tracks-video", exist_ok=True)
    os.makedirs("ships/geff/test/convert", exist_ok=True)
    os.makedirs("ships/geff/test/score", exist_ok=True)
    os.makedirs("books/score-tracking/example", exist_ok=True)
    for p in ("ships/space-time-field/test/track/movie.zarr", "ships/space-time-field/test/tracks-video/image.zarr", "books/score-tracking/example/movie.zarr"):
        write_movie(p, data)
    write_tracks("ships/space-time-field/test/tracks-video/tracks.csv", paths)
    for p in ("ships/geff/test/convert/graph.geff", "ships/geff/test/score/truth.geff", "books/score-tracking/example/truth.geff"):
        write_geff(p, paths, keep)
    write_tracks("ships/geff/test/score/tracks.csv", paths)


if __name__ == "__main__":
    main()
