"""
space-time-field: detector-free cell tracking for Pharos.

  track         /in/movie (OME-Zarr, t z y x, optionally c) → /out/tracks.csv
                (track_id, t, z, y, x, parent_track_id in voxels, as Ultrack writes them)
  tracks-video  /in/image (OME-Zarr) + /in/tracks (CSV) → /out/video.mp4: the max projection
                along z, each tracked cell a dot and its last step an arrow

The method itself is stf/ (Classes.py and solver.py, unchanged but for their
imports): a DoG probability field pooled over time on a deformable grid, and a
min-cost flow that picks the paths that persist. stf/config.json holds the
tuned defaults (the two-band DoG configuration); the operation's parameters
override the knobs worth turning.

Progress goes to stdout as JSON lines; the solver's own log goes to stderr.
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import numpy as np
import zarr

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "stf"))
# the method's knobs are read from the environment at import
os.environ.setdefault("DRIFT_PER_HOP_UM", "0.0")


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


class OmeVolume:
    """An OME-Zarr image read one time point at a time, as the solver's Volume reads its Zarr.

    The solver's own Volume expects `{path}/0` holding (T, Z, Y, X); this reads the
    axes and voxel size from the OME metadata instead, so converted (t, c, z, y, x)
    images work too.
    """

    channel = 0

    def __init__(self, path, max_frames=None):
        self.path = Path(path)
        self.max_frames = max_frames
        group = zarr.open_group(str(path), mode="r")
        attrs = dict(group.attrs)
        ms = attrs.get("ome", attrs)["multiscales"][0]
        self.names = "".join((a["name"] if isinstance(a, dict) else a).lower() for a in ms["axes"])
        level = ms["datasets"][0]
        self._store = zarr.open_array(str(self.path / level["path"]), mode="r")
        if not all(a in self.names for a in "tzyx"):
            sys.exit(f"space-time-field needs a 3D time-lapse (axes t, z, y, x); this image has axes {self.names}")
        scale = [1.0] * len(self.names)
        for t in level.get("coordinateTransformations", []):
            if t.get("type") == "scale":
                scale = list(t["scale"])
        self.scale = np.array([scale[self.names.index(a)] for a in "zyx"], float)

    @property
    def shape(self):
        t, z, y, x = (int(self._store.shape[self.names.index(a)]) for a in "tzyx")
        if self.max_frames:
            t = min(t, self.max_frames)
        return t, z, y, x

    @property
    def nt(self):
        return self.shape[0]

    @property
    def spatial_shape(self):
        return self.shape[1:]

    def raw(self, t):
        """Time point t as (Z, Y, X), in the stored data type."""
        index = tuple(t if a == "t" else self.channel if a == "c" else slice(None) for a in self.names)
        kept = [a for a in self.names if a in "zyx"]
        return np.transpose(np.asarray(self._store[index]), [kept.index(a) for a in "zyx"])

    def frame(self, t):
        """Time point t normalised to [0, 1] by robust percentiles, exactly as the solver's Volume does."""
        vol = self.raw(t).astype(np.float32)
        vmin, vmax = np.percentile(vol[::2, ::4, ::4], (1.0, 99.9))
        if vmax <= vmin:
            return np.zeros_like(vol)
        return np.clip((vol - vmin) / (vmax - vmin), 0.0, 1.0)


def cmd_track(a):
    import Classes as METHOD
    import solver

    OmeVolume.channel = a.channel
    vol = OmeVolume(a.movie)
    nt, nz, ny, nx = vol.shape
    if nt < 2:
        sys.exit("space-time-field needs at least 2 time points")
    # Constants the method reads from module scope. In place, so default arguments bound at import see it too.
    METHOD.VOXEL_SCALE[:] = vol.scale
    fov = np.array([nz, ny, nx]) * vol.scale

    args = solver.get_parser().parse_args(["--zarr", a.movie, "--out-dir", "/tmp/stf", "--no-eval"])
    config = json.loads((HERE / "stf" / "config.json").read_text())["config"]
    for k, v in config["arguments"].items():
        if hasattr(args, k):
            setattr(args, k, v)
    for k, v in config["method_constants"].items():
        if hasattr(METHOD, k) and k != "GRID_N":
            setattr(METHOD, k, v)
    args.out_dir, args.no_eval, args.log_dir = "/tmp/stf", True, "/tmp/stf-logs"
    args.num_dog, args.temporal_radius, args.value_floor = a.num_dog, a.temporal_radius, a.value_floor
    args.lambda_termination, args.lambda_start, args.max_nodes = a.lambda_termination, a.lambda_start, a.max_nodes
    # One Field Cell per 1.625 µm, as tuned: 64³ on the 104 µm Biohub field of view.
    args.grid = max(8, int(round(fov[0] / 1.625)))

    # Report the solver's own progress bars (registration, then the field) as Pharos progress.
    spans = {"field values": (0.4, 0.85)}

    def render(self, note=""):
        lo, hi = spans.get(self.label, (0.02, 0.4))
        progress(lo + (hi - lo) * min(self._n / self.total, 1.0), f"{self.label.strip()}: {self._n}/{self.total}")

    solver.Progress._render = render
    build, optimise = METHOD.Graph.build.__func__, METHOD.Graph.optimise

    def graph_build(cls, *p, **k):
        progress(0.86, "building the graph of candidate paths")
        return build(cls, *p, **k)

    def graph_optimise(self, *p, **k):
        progress(0.9, f"solving the min-cost flow over {len(self)} nodes")
        return optimise(self, *p, **k)

    METHOD.Graph.build = classmethod(graph_build)
    METHOD.Graph.optimise = graph_optimise
    solver.Volume = OmeVolume

    solver.setup_logging(args.log_dir)
    progress(0.01, f"{nt} time points of {nz} × {ny} × {nx} voxels, field {args.grid}³")
    _, _, graph, out_dir, _ = solver.run(args)

    # The solver writes cell_id/parent_id; Pharos tracks use Ultrack's names, with -1 for no parent.
    n = set()
    with open(out_dir / "tracks.csv") as f, open("/out/tracks.csv", "w", newline="") as g:
        w = csv.writer(g)
        w.writerow(["track_id", "t", "z", "y", "x", "parent_track_id"])
        for r in csv.DictReader(f):
            n.add(r["cell_id"])
            w.writerow([r["cell_id"], r["t"], r["z"], r["y"], r["x"], r["parent_id"] or -1])
    progress(1.0, f"{len(n)} tracks")


def cmd_tracks_video(a):
    """The tracker's own view of its result: grey max projection, a dot per cell, an arrow per step."""
    import matplotlib

    matplotlib.use("Agg")
    import imageio_ffmpeg
    import matplotlib.animation as animation
    import matplotlib.pyplot as plt

    matplotlib.rcParams["animation.ffmpeg_path"] = imageio_ffmpeg.get_ffmpeg_exe()
    OmeVolume.channel = a.channel
    vol = OmeVolume(a.image)
    nt = vol.nt
    mip = np.stack([vol.raw(t).max(axis=0) for t in range(nt)])
    progress(0.1, f"projected {nt} time points")

    by_t = {}
    with open(a.tracks) as f:
        for r in csv.DictReader(f):
            tid = int(float(r.get("track_id") or r.get("cell_id")))
            by_t.setdefault(int(float(r["t"])), {})[tid] = (float(r["x"]), float(r["y"]))

    fig, ax = plt.subplots(figsize=(6, 6))
    plt.subplots_adjust(left=0, right=1, top=1, bottom=0)
    ax.axis("off")
    vmin, vmax = np.percentile(mip, 1), np.percentile(mip, 99.9)
    im = ax.imshow(mip[0], cmap="gray", vmin=vmin, vmax=vmax)
    scat = ax.scatter([], [], s=20, c=[], cmap="tab20", vmin=0, vmax=19, alpha=0.7, zorder=3)
    arrows = []

    def update(t):
        im.set_data(mip[t])
        for arr in arrows:
            arr.remove()
        arrows.clear()
        now = by_t.get(t, {})
        if now:
            ids = sorted(now)
            scat.set_offsets(np.array([now[i] for i in ids]))
            scat.set_array(np.array(ids) % 20)
            before = by_t.get(t - 1, {})
            for i in ids:
                if i in before:
                    arrows.append(ax.annotate("", xy=now[i], xytext=before[i], zorder=2,
                                              arrowprops=dict(arrowstyle="->", color="#00ff88", lw=1.2, connectionstyle="arc3,rad=0.05")))
        else:
            scat.set_offsets(np.empty((0, 2)))
        return [im, scat, *arrows]

    ani = animation.FuncAnimation(fig, update, frames=nt, blit=False, interval=1000 / a.fps)
    writer = animation.FFMpegWriter(fps=a.fps, extra_args=["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"])
    ani.save("/out/video.mp4", writer=writer, dpi=150, progress_callback=lambda i, n: progress(0.1 + 0.9 * (i + 1) / n, f"frame {i + 1} of {n}"))
    plt.close(fig)
    progress(1.0, f"{len(by_t)} time points with tracks")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("track")
    t.add_argument("--movie", required=True)
    t.add_argument("--channel", type=int, default=0)
    t.add_argument("--num-dog", type=int, default=2)
    t.add_argument("--temporal-radius", type=int, default=2)
    t.add_argument("--value-floor", type=float, default=0.0175)
    t.add_argument("--lambda-termination", type=float, default=0.6)
    t.add_argument("--lambda-start", type=float, default=0.15)
    t.add_argument("--max-nodes", type=int, default=1500)
    t.set_defaults(func=cmd_track)
    v = sub.add_parser("tracks-video")
    v.add_argument("--image", required=True)
    v.add_argument("--tracks", required=True)
    v.add_argument("--fps", type=float, default=10)
    v.add_argument("--channel", type=int, default=0)
    v.set_defaults(func=cmd_tracks_video)
    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
