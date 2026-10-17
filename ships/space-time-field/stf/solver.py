"""Stem Cell Tracking V2 — run the Space Time Field over a Zarr video.

This module owns the input side — opening the Zarr, normalising a Zarr
Frame — and the pipeline that strings the stages together.  It owns no
tracking algorithm at all; that is iteration_2/space_time_field.py, one
file, in the specification's own vocabulary.

    1. Volume          read the Zarr, one Zarr Frame at a time   here
    2. Transforms      affine, gated, refined to an SVF          method
    3. Probabilities   DoG of the pair, warped and averaged      method
    4. Field           the deformed 32³ grid and its values      method
    5. Graph           the rules, as edges                       method
    6. min-cost flow   the Configuration that scores highest     method
    7. evaluator       score against ground truth                iteration_1/
    8. napari          select paths and watch them evolve        iteration_2/

Stages 2 and 4 are cached under scratch/<dataset>/, so re-running to
retune the λ costs the solve and nothing else.

Usage:
    python main.py
    python main.py --zarr dataset/.../6bba_48816121.zarr
    python main.py --grid 64 --max-nodes 800      # dense data
    python main.py --no-eval --record-augmentations
    python main.py --napari
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import zarr

# ── The tracking method ──────────────────────────────────────────────────────
# Swap this line to swap the algorithm.
import Classes as METHOD
from Classes import (Field, Graph, Probabilities,
                                          ProbabilitiesEnhanced, Transforms,
                                          trackpy_boost)
import cache_layout

# ── Constants ────────────────────────────────────────────────────────────────

PROJECT = Path(__file__).parent
DATA_DIR = PROJECT / "dataset/biohub-cell-tracking-during-development/train"

ZARR_PATH = DATA_DIR / "44b6_d5e7d891.zarr"

# The evaluator's dependencies (tracksdata, polars) live in the baseline
# venv and not in the one that runs the tracking, so it is shelled out to
# that interpreter rather than imported.
EVALUATOR = PROJECT / "test.py"
BASELINE_PY = PROJECT / "kaggle_baseline" / ".venv" / "bin" / "python"

log = logging.getLogger("space_time_field")


# ── Logging ──────────────────────────────────────────────────────────────────

def setup_logging(log_dir: str | Path = "logs", level: int = logging.DEBUG):
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    
    root = logging.getLogger("space_time_field")
    root.setLevel(level)
    root.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(message)s",
                            datefmt="%H:%M:%S")
    # File logging has been replaced by structured JSON logs in this directory
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    root.addHandler(ch)

    return None


class Progress:
    """Throttled progress line with a rate and an ETA.

    Per-item lines are useful when watching one video and unreadable when
    sweeping many, so this reports on a time interval.  Rewrites one line
    on a terminal and falls back to ordinary log lines when redirected.
    """

    def __init__(self, label: str, total: int, every: float = 2.0, stream=None):
        self.label = label
        self.total = max(int(total), 1)
        self.every = every
        self.stream = stream if stream is not None else sys.stderr
        self.tty = hasattr(self.stream, "isatty") and self.stream.isatty()
        self.t0 = time.time()
        self._last = 0.0
        self._n = 0

    def update(self, n: int = 1, note: str = ""):
        self._n += n
        now = time.time()
        if now - self._last < self.every and self._n < self.total:
            return
        self._last = now
        self._render(note)

    def _render(self, note: str = ""):
        elapsed = time.time() - self.t0
        frac = self._n / self.total
        rate = self._n / elapsed if elapsed > 0 else 0.0
        eta = (self.total - self._n) / rate if rate > 0 else 0.0
        bar_w = 24
        bar = "█" * int(bar_w * frac) + "·" * (bar_w - int(bar_w * frac))
        msg = (f"{self.label:<22} [{bar}] {self._n:4d}/{self.total:<4d} "
               f"{100 * frac:5.1f}%  {rate:5.2f}/s  eta {eta:5.1f}s")
        if note:
            msg += f"  {note}"
        if self.tty:
            self.stream.write("\r" + msg + " " * 6)
            self.stream.flush()
        else:
            log.info(msg)

    def done(self, note: str = ""):
        self._n = self.total
        self._render(note)
        if self.tty:
            self.stream.write("\n")
            self.stream.flush()


# ── Volume ───────────────────────────────────────────────────────────────────

@dataclass
class Volume:
    """Zarr 3D+time microscopy video at ``{path}/0``, shape (T, Z, Y, X)."""

    path: Path
    max_frames: int | None = None
    _store: zarr.Array = field(init=False, repr=False)

    def __post_init__(self):
        self.path = Path(self.path)
        self._store = zarr.open(self.path / "0", mode="r")

    @property
    def shape(self) -> tuple[int, int, int, int]:
        t, z, y, x = self._store.shape
        if self.max_frames:
            t = min(t, self.max_frames)
        return int(t), int(z), int(y), int(x)

    @property
    def nt(self) -> int:
        return self.shape[0]

    @property
    def spatial_shape(self) -> tuple[int, int, int]:
        return self.shape[1], self.shape[2], self.shape[3]

    def frame(self, t: int) -> np.ndarray:
        """Zarr Frame *t*, normalised to [0, 1].

        Percentile limits rather than min/max: one hot voxel would
        otherwise compress the whole dynamic range and make the
        Probability scale drift from frame to frame.
        """
        vol = np.asarray(self._store[t], dtype=np.float32)
        vmin, vmax = np.percentile(vol[::2, ::4, ::4], (1.0, 99.9))
        if vmax <= vmin:
            return np.zeros_like(vol)
        return np.clip((vol - vmin) / (vmax - vmin), 0.0, 1.0)


# ── Evaluation ───────────────────────────────────────────────────────────────

def find_gt_geff(zarr_path: Path) -> Path | None:
    geff = zarr_path.with_suffix(".geff")
    return geff if geff.is_dir() else None


def evaluate(tracks_csv: Path, gt_geff: Path, n_frames: int, split: int,
             python: Path = BASELINE_PY) -> dict | None:
    if not Path(python).exists():
        log.warning(f"Evaluator skipped: no interpreter at {python}.")
        return None
    cmd = [str(python), str(EVALUATOR), "--tracks", str(tracks_csv),
           "--gt-geff", str(gt_geff), "--split", str(split),
           "--n-frames", str(n_frames), "--json"]
    log.info(f"Scoring against {gt_geff.name} ...")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=PROJECT)
    line = next((l for l in proc.stdout.splitlines() if l.startswith("{")), None)
    if line is None:
        log.error(f"Evaluator failed (exit {proc.returncode}):\n"
                  f"{proc.stderr[-800:]}")
        return None
    return json.loads(line)


def report(result: dict, dataset: str):
    def f(r, key, width=6):
        v = r.get(key)
        return f"{v:.4f}" if isinstance(v, (int, float)) else "n/a".rjust(width)

    def i(r, key):
        v = r.get(key)
        return int(v) if isinstance(v, (int, float)) else 0

    split, nf = result["split"], result["n_frames"]
    log.info("=" * 78)
    log.info(f"SCORE  {dataset}   ({nf} frames)")
    for label, r in ((f"t<{split}", result["tune"]),
                     (f"t>={split}", result["held_out"]),
                     ("full video", result["full"])):
        log.info(f"  {label:<22} score={f(r, 'combined')}  "
                 f"edgeJ={f(r, 'edge_jaccard')}  "
                 f"TP={i(r, 'edge_tp'):4d} FP={i(r, 'edge_fp'):4d} "
                 f"FN={i(r, 'edge_fn'):4d}  recall={f(r, 'node_recall')}")
    log.info("=" * 78)


# ── Pipeline ─────────────────────────────────────────────────────────────────

def small_band_jitter(vol: "Volume", args) -> float:
    """Label-free PRERUN signal: normalised frame-to-frame total variation of the
    SMALL DoG band's detection count, over a few short consecutive windows.

    High jitter = a dynamically active video (real cell births / divisions /
    migration) where per-scale-norm recovers small cells the baseline misses;
    low jitter = a static video already well covered, where per-scale-norm only
    inflates false positives.  In the prerun-selector study this was the one
    signal that generalised (leave-one-out CV: +0.8 macro over baseline, ~41% of
    the per-video oracle ceiling), beating the higher-correlated usefulness ratio
    which failed as a decision rule.  Detection only — no field build, no solve.
    """
    import scipy.ndimage as ndi
    # A throw-away 3-band per-scale-norm probe just to read the per-band p99.9
    # (_scales); transforms are not needed for raw-frame detection.
    probe = ProbabilitiesEnhanced(vol, None, inner_um=args.dog_inner,
                                  sensitivity=args.sensitivity, num_dog=3,
                                  per_scale_norm=True)
    floor = args.value_floor
    small_scale = float(np.asarray(probe._scales, float)[0])
    windows = [(5, 15), (45, 55), (80, 90)]   # short CONSECUTIVE runs
    tv = n_pairs = 0.0
    total = n_frames = 0.0
    for lo, hi in windows:
        hi = min(hi, vol.nt)
        counts = []
        for t in range(lo, hi):
            small_dog = probe._scale_dogs(probe._frame(t))[0]
            b = np.clip(small_dog / max(small_scale, 1e-12), 0.0, 1.0)
            lm = (b == ndi.maximum_filter(b, size=3)) & (b > floor)
            counts.append(int(lm.sum()))
        if len(counts) < 2:
            continue
        counts = np.array(counts, float)
        tv += float(np.abs(np.diff(counts)).sum())
        n_pairs += len(counts) - 1
        total += float(counts.sum())
        n_frames += len(counts)
    mean_count = total / max(n_frames, 1.0)
    return float((tv / max(n_pairs, 1.0)) / max(mean_count, 1e-9))


def run(args) -> tuple[Volume, Field, Graph, Path, dict]:
    vol = Volume(args.zarr, max_frames=args.max_frames)

    # Per-video auto-selection of per-scale-norm from a cheap label-free prerun.
    # Decided BEFORE the cache tag is derived, so a psn video lands in the
    # `_mdog3_psn` field dir and a baseline video in the plain dir — each reuses
    # its own cache with no extra bookkeeping.
    if getattr(args, "psn_auto_select_by_jitter", False):
        jitter = small_band_jitter(vol, args)
        use_psn = jitter >= args.jitter_threshold
        log.info("── PSN auto-select " + "─" * 55)
        log.info(f"  small-band jitter {jitter:.4f} "
                 f"{'≥' if use_psn else '<'} threshold {args.jitter_threshold} → "
                 f"{'per-scale-norm ON (num_dog=3)' if use_psn else 'baseline (num_dog=1)'}")
        if use_psn:
            args.num_dog, args.per_scale_norm = 3, True
        else:
            args.num_dog, args.per_scale_norm = 1, False
    # Hierarchical cache: transforms/ is shared across field variants of the
    # same video; each field variant lives in its own <field_tag>/ dir.  See
    # cache_layout.py — the single source of truth shared with test.py.
    if args.out_dir:                       # explicit override: flat, tagged
        out_dir = Path(args.out_dir)
        tf_cache = out_dir / f"transforms_{cache_layout.transform_tag(args)}.npz"
        fld_cache = out_dir / f"field_{cache_layout.field_tag(args)}.npz"
    else:
        cf = PROJECT / "cached_fields"
        out_dir = cache_layout.field_dir(cf, vol.path.stem, args)
        tf_cache = cache_layout.transforms_path(cf, vol.path.stem, args)
        fld_cache = out_dir / "field.npz"
        tf_cache.parent.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info(f"Dataset: {vol.path.stem}  {vol.shape}  →  {out_dir}")
    log.info(f"Voxel scale (z, y, x): {tuple(METHOD.VOXEL_SCALE)} µm, "
             f"field of view "
             f"{tuple(np.array(vol.spatial_shape) * METHOD.VOXEL_SCALE)} µm")

    # ── 1. Transforms ────────────────────────────────────────────────
    log.info("── Transforms " + "─" * 60)
    estimator = ("adaptive" if args.adaptive else
                 "affine" if args.affine else
                 "phase" if args.phase else "rigid")
    using_cached_transforms = False
    if tf_cache.exists() and not args.rebuild:
        log.info(f"  Loading cached Transforms ← {tf_cache}")
        transforms = Transforms.load(tf_cache)
        using_cached_transforms = True
    else:
        est_label = ("adaptive" if estimator == "adaptive" else
                     "phase corr" if estimator == "phase" else estimator)
        est_dof = ("adaptive" if estimator == "adaptive" else
                   "3 DOF" if estimator == "phase" else
                   "6 DOF" if estimator == "rigid" else "12 DOF")
        log.info(f"  Bulk estimator: {est_label} ({est_dof})")
        transforms = Transforms.build(
            vol, reg_spacing_um=args.reg_spacing,
            svf_spacing_um=args.svf_spacing,
            residual_gate_um=args.residual_gate,
            allow_svf=not args.no_svf,
            estimator=estimator,
            interpolate_rejected=args.interpolate_transforms or args.adaptive,
            progress=Progress(f"{est_label} + residual", vol.nt - 1))
        transforms.save(tf_cache)
    res, mot = transforms.residuals, transforms.motions
    log.info(f"  Motion at cell locations, before the Transform: median "
             f"{np.median(mot):.2f}µm, p90 {np.percentile(mot, 90):.2f}µm")
    log.info(f"  Residual motion, after it:                      median "
             f"{np.median(res):.2f}µm, p90 {np.percentile(res, 90):.2f}µm, "
             f"max {res.max():.2f}µm")
    log.info(f"  {transforms.n_refined}/{len(transforms)} frame pairs failed "
             f"the {args.residual_gate}µm gate and carry a velocity field; "
             f"{transforms.n_rejected} fits were worse than identity and "
             f"were dropped")
    dets = np.array([np.linalg.det(t.affine[:3, :3]) for t in transforms])
    log.info(f"  Affine determinants: median {np.median(dets):.4f}, "
             f"cumulated over the video {np.prod(dets):.3f} "
             f"(1.0 is a Field that neither shrinks nor grows)")

    # ── 2. Probabilities and 3. Field ────────────────────────────────
    log.info("── Probabilities and Field " + "─" * 47)
    # fld_cache derived above via cache_layout (field.npz in the variant dir,
    # or a tagged filename under an explicit --out-dir override).

    if getattr(args, "prob_method", "dog") == "cellpose":
        from Classes import ProbabilitiesCellpose
        # Diameter: cells are 5-8µm, in xy pixels ~12-20.  Default 15.
        log.info(f"  Using ProbabilitiesCellpose (nuclei, 2D per-slice, diameter={15})")
        probabilities = ProbabilitiesCellpose(
            vol, transforms,
            out_dir=out_dir,
            model_type="nuclei", gpu=True,
            diameter=15.0,
            temporal_radius=args.temporal_radius,
            center_weight=args.center_weight)
    elif args.enhanced:
        log.info(f"  Using ProbabilitiesEnhanced (sensitivity={args.sensitivity}, "
                 f"temporal_radius=±{args.temporal_radius}, drift-pooled)")
        probabilities = ProbabilitiesEnhanced(
            vol, transforms, inner_um=args.dog_inner,
            sensitivity=args.sensitivity,
            temporal_radius=args.temporal_radius,
            center_weight=args.center_weight,
            num_dog=args.num_dog,
            mult_lo=args.dog_mult_lo, mult_hi=args.dog_mult_hi,
            per_scale_norm=args.per_scale_norm)
    else:
        probabilities = Probabilities(vol, transforms, inner_um=args.dog_inner,
                                      num_dog=args.num_dog,
                                      mult_lo=args.dog_mult_lo, mult_hi=args.dog_mult_hi,
                                      per_scale_norm=args.per_scale_norm)

    probabilities.dynamic_dog = getattr(probabilities, "dynamic_dog", False) or args.dynamic_dog
    probabilities.value_floor = args.value_floor
    probabilities.temporal_mode = args.temporal_mode
    probabilities.psn_weighted = args.per_scale_norm and args.psn_weighted

    log.info("  Pre-computing 100 probability frames ...")
    # Centroid offsets are only read by --refine and --continuous-centroids;
    # skip that per-frame work otherwise.  A cached field built without them is
    # rebuilt if a run now needs them.
    need_offsets = args.refine or args.continuous_centroids
    need_size = args.size_coherence_bonus > 0 and args.num_dog > 1
    using_cached_field = False
    cached_ok = fld_cache.exists() and not args.rebuild
    if cached_ok and (need_offsets or need_size):
        _z = np.load(fld_cache)
        if need_offsets and not ("offsets" in _z and _z["offsets"].size > 0):
            cached_ok = False
            log.info("  Cached Field has no centroid offsets but a run needs "
                     "them (--refine/--continuous-centroids); rebuilding.")
        if need_size and not ("size_band" in _z and _z["size_band"].size > 0):
            cached_ok = False
            log.info("  Cached Field has no size bands but --size-coherence-"
                     "bonus needs them; rebuilding.")
    if cached_ok:
        log.info(f"  Loading cached Field ← {fld_cache}")
        fld = Field.load(fld_cache)
        using_cached_field = True
    else:
        fld = Field.build(vol, transforms, probabilities, n=args.grid,
                          supersample=args.supersample,
                          quantise=args.quantise,
                          compute_offsets=need_offsets,
                          compute_size=need_size,
                          progress=Progress("field values", vol.nt))
        fld.save(fld_cache)

    # ── 2b. Trackpy boost (optional) ──────────────────────────────
    if args.trackpy_boost > 0:
        log.info("── Trackpy Boost " + "─" * 57)
        trackpy_boost(fld, vol, probabilities, bonus=args.trackpy_boost)

    v = fld.values[fld.in_view]
    log.info(f"  Field values: mean {v.mean():.4f}, p99 "
             f"{np.percentile(v, 99):.4f}, max {v.max():.4f}; "
             f"{100 * (v > args.value_floor).mean():.2f}% above the floor")

    if args.optimize_field or args.optimize_discrete > 0:
        log.info("── Field Optimization " + "─" * 45)
        
        base_graph = Graph.build(
            fld, transforms=transforms,
            node_select=args.node_select,
            nms_radius=args.nms_radius,
            value_floor=args.value_floor,
            max_nodes_per_frame=args.max_nodes,
            box_radius=args.box_radius,
            cell_probability_multiplier=args.cell_probability_multiplier,
            link_distance=args.link_distance,
            lambda_termination=args.lambda_termination,
            lambda_start=args.lambda_start,
            dead_zone_um=args.dead_zone,
            node_capacity=args.node_capacity,
            secondary_penalty=args.secondary_penalty,
            continuous_centroids=args.continuous_centroids,
        )

        def _evaluate_field(test_field, win_transforms=None) -> float:
            test_graph = Graph.build(
                test_field,
                transforms=win_transforms if win_transforms is not None else transforms,
                node_select=args.node_select,
                nms_radius=args.nms_radius,
                value_floor=args.value_floor,
                max_nodes_per_frame=args.max_nodes,
                box_radius=args.box_radius,
                cell_probability_multiplier=args.cell_probability_multiplier,
                link_distance=args.link_distance,
                lambda_termination=args.lambda_termination,
                lambda_start=args.lambda_start,
                dead_zone_um=args.dead_zone,
                node_capacity=args.node_capacity,
                secondary_penalty=args.secondary_penalty,
                continuous_centroids=args.continuous_centroids,
            )
            # The lambda params must be frozen so the objective doesn't drift.
            test_graph.lambda_termination = base_graph.lambda_termination
            test_graph.link_distance = base_graph.link_distance
            config = test_graph.optimise(solver_log=False)
            return config.score

        if args.optimize_field:
            fld.optimize_residual(
                evaluate_fn=_evaluate_field,
                transforms=transforms,
                iters=args.opt_iters,
                samples=args.opt_samples,
                sigma=args.opt_sigma,
                alpha=args.opt_alpha,
                drift_penalty=0.05,
                window=args.opt_window
            )
            
        if args.optimize_discrete > 0:
            fld.optimize_discrete(
                evaluate_fn=_evaluate_field,
                n_regions=args.optimize_discrete
            )

    # ── 4. Graph ─────────────────────────────────────────────────────
    log.info("── Graph " + "─" * 65)
    graph = Graph.build(fld, transforms=transforms,
                        node_select=args.node_select,
                        nms_radius=args.nms_radius,
                        value_floor=args.value_floor,
                        adaptive_floor_pct=getattr(args, 'adaptive_floor_pct', 0.0),
                        max_nodes_per_frame=args.max_nodes,
                        box_radius=args.box_radius,
                        cell_probability_multiplier=args.cell_probability_multiplier,
                        link_distance=args.link_distance,
                        lambda_termination=args.lambda_termination,
                        lambda_start=args.lambda_start,
                        start_penalty_multiplier=getattr(args, 'start_penalty_multiplier', 1.0),
                        termination_penalty_multiplier=getattr(args, 'termination_penalty_multiplier', 1.25),
                        dead_zone_um=args.dead_zone,
                        node_capacity=args.node_capacity,
                        secondary_penalty=args.secondary_penalty,
                        continuous_centroids=args.continuous_centroids,
                        size_coherence_bonus=args.size_coherence_bonus)

    # ── 5. Optimisation ──────────────────────────────────────────────
    log.info("── Min-cost flow " + "─" * 57)
    graph.optimise(
        solver_log=args.solver_log,
        momentum_iters=args.momentum_iters,
        momentum_penalty=args.momentum_penalty,
        completion_iters=args.completion_iters,
        completion_bonus=args.completion_bonus
    )

    # ── 6. Output ────────────────────────────────────────────────────
    log.info("── Output " + "─" * 64)
    refined = getattr(args, 'refine', False)
    tracks_csv = out_dir / "tracks.csv"
    div_kw = dict(division_method=args.division_method,
                  division_max_um=args.division_max_um,
                  division_require_split=args.division_require_split,
                  birth_min_frames=args.birth_min_frames,
                  birth_dedup_um=args.birth_dedup_um,
                  birth_max_shadow=args.birth_max_shadow,
                  birth_adaptive=args.birth_adaptive,
                  birth_adaptive_len=args.birth_adaptive_len,
                  birth_min_value=args.birth_min_value)
    graph.save_tracks_csv(tracks_csv, refined, **div_kw)
    graph.save_competition_csv(out_dir / "tracks_competition.csv",
                               vol.path.stem, refined, **div_kw)
    graph.save_edges(out_dir / "edges.npz")

    # ── Label-free diagnostics (predict quality WITHOUT the evaluator) ──
    try:
        cfg = graph.configuration
        lens = [len(graph.path_nodes(p)) for p in cfg.paths] if cfg.paths else []
        v = fld.values[fld.in_view]
        diag = {
            "n_nodes": int(len(graph)),
            "n_paths": int(len(cfg.paths)),
            "n_singletons": int(len(cfg.singletons)),
            "frac_singleton": float(len(cfg.singletons) / max(len(graph), 1)),
            "lp_score": float(cfg.score),
            "mean_track_len": float(np.mean(lens)) if lens else 0.0,
            "median_track_len": float(np.median(lens)) if lens else 0.0,
            "field_pct_above_floor": float((v > args.value_floor).mean()),
            "node_value_median": float(np.median(graph.value)),
            "band_stats": getattr(probabilities, "_band_stats", None),
        }
        (out_dir / "diagnostics.json").write_text(json.dumps(diag, indent=2))
        log.info(f"  Diagnostics (label-free): paths {diag['n_paths']}, "
                 f"mean len {diag['mean_track_len']:.1f}, "
                 f"singleton {diag['frac_singleton']:.2f}, "
                 f"LP {diag['lp_score']:.0f}")
    except Exception as e:
        log.warning(f"  diagnostics failed: {e}")

    if args.record_augmentations:
        log.info("── Successive shortest paths " + "─" * 45)
        augs = graph.augmentations(max_paths=args.record_augmentations)
        (out_dir / "augmentations.json").write_text(json.dumps(augs))
        log.info(f"  → {out_dir / 'augmentations.json'}")

    metadata = {
        "using_cached_transforms": using_cached_transforms,
        "transforms_path": str(tf_cache),
        "using_cached_field": using_cached_field,
        "field_path": str(fld_cache),
    }

    return vol, fld, graph, out_dir, metadata


def get_parser():
    p = argparse.ArgumentParser(description="Stem Cell Tracking V2 — the "
                                            "Space Time Field")
    p.add_argument("--zarr", type=str, default=str(ZARR_PATH))
    p.add_argument("--out-dir", type=str, default=None)
    p.add_argument("--log-dir", type=str, default="logs")
    p.add_argument("--rebuild", action="store_true",
                   help="Ignore cached Transforms and Field")
    p.add_argument("--max-frames", type=int, default=None,
                   help="Track only the first N frames (development)")

    g = p.add_argument_group("Transforms")
    g.add_argument("--reg-spacing", type=float, default=METHOD.REG_SPACING_UM,
                   help="µm spacing of the isotropic grid the affine is fitted "
                        "on (default: %(default)s)")
    g.add_argument("--svf-spacing", type=float, default=METHOD.SVF_SPACING_UM,
                   help="µm spacing of the velocity field (default: %(default)s)")
    g.add_argument("--residual-gate", type=float,
                   default=METHOD.RESIDUAL_GATE_UM,
                   help="Residual motion above which the affine is refused and "
                        "an SVF is fitted (default: %(default)s)")
    g.add_argument("--no-svf", action="store_true",
                    help="Never refine; keep the bulk estimator whatever the "
                         "residual")
    g.add_argument("--affine", action="store_true",
                    help="Use the 12-DOF SimpleITK affine for bulk motion "
                         "instead of the default 6-DOF rigid")
    g.add_argument("--phase", action="store_true",
                    help="Use the 3-DOF phase correlation for bulk motion "
                         "instead of the default 6-DOF rigid")
    g.add_argument("--rigid", action="store_true",
                    help="Use the 6-DOF Euler3D transform for bulk motion "
                         "(this is now the default)")
    g.add_argument("--interpolate-transforms", action=argparse.BooleanOptionalAction,
                    dest="interpolate_transforms", default=True,
                    help="Interpolate rejected transforms from confident "
                         "neighbours instead of falling back to identity")
    g.add_argument("--adaptive", action="store_true",
                    help="Per-frame adaptive estimator: use affine+SVF on "
                         "high-SNR frames and rigid on low-SNR frames. "
                         "Implies --interpolate-transforms.")
    g.add_argument("--trackpy-boost", type=float, default=0.0,
                    dest="trackpy_boost",
                    help="Boost Field values by this amount where trackpy "
                         "independently confirms a track (e.g. 0.2). "
                         "0 = disabled (default)")

    g = p.add_argument_group("Probabilities and Field")
    g.add_argument("--dog-inner", type=float, default=METHOD.DOG_INNER_UM,
                   help="Inner DoG sigma in µm, about a nucleus radius "
                        f"(default {METHOD.DOG_INNER_UM}µm)")
    g.add_argument("--num-dog", type=int, default=getattr(METHOD, "NUM_DOG", 1),
                   help="Number of DoG scales for multi-scale detection. "
                        "1=single scale (default). >1 evaluates multiple scales and takes max.")
    g.add_argument("--temporal-mode", choices=("symmetric", "directional"),
                   default="symmetric",
                   help="Temporal coherence blend. 'symmetric' (default): "
                        "geometric mean over ±radius. 'directional': "
                        "max(past+present, present+future), so births (division "
                        "daughters, cells entering view) and deaths survive "
                        "while single-frame flicker still fails both sides.")
    g.add_argument("--size-coherence-bonus", type=float, default=0.0,
                   help="Reward edges that keep a cell in the same DoG size "
                        "band (which scale it responds to most): a same-band "
                        "link is this much cheaper. Needs --num-dog > 1 (the "
                        "bands). 0 = off (default).")
    g.add_argument("--psn-weighted", action="store_true",
                   help="With --per-scale-norm: weight each band by its "
                        "label-free detection count × cross-frame consistency "
                        "(dominant band = 1), so a video that only needs one "
                        "band isn't dragged by a noisy second/third band.")
    g.add_argument("--per-scale-norm", action=argparse.BooleanOptionalAction,
                   default=False,
                   help="Normalise each multi-DoG scale by its own p99.9 before "
                        "max-pooling, so small cells (weaker raw response) get a "
                        "fair reward instead of being drowned by one global "
                        "normalisation (only affects --num-dog > 1).")
    g.add_argument("--psn-auto-select-by-jitter", action="store_true",
                   help="Per-video champion: run a cheap label-free prerun "
                        "(frame-to-frame jitter of the small DoG band's detection "
                        "count over a few short windows) and enable per-scale-norm "
                        "(num_dog=3) only for dynamically active videos at/above "
                        "--jitter-threshold, else keep the num_dog=1 baseline. "
                        "Overrides --num-dog/--per-scale-norm per video. The one "
                        "prerun signal that generalises (LOO-CV +0.8 macro).")
    g.add_argument("--jitter-threshold", type=float, default=0.059,
                   help="Small-band jitter at/above which "
                        "--psn-auto-select-by-jitter turns per-scale-norm on "
                        "(default 0.059, tuned on the 40-video set).")
    g.add_argument("--dog-mult-lo", type=float, default=0.68,
                   help="Low end of the multi-DoG scale span (× inner σ), "
                        "used when --num-dog > 1 (default 0.68, spreads below).")
    g.add_argument("--dog-mult-hi", type=float, default=1.0,
                   help="High end of the multi-DoG scale span (× inner σ). "
                        ">1.0 reaches up to catch larger cells, e.g. 1.6 → "
                        "inner σ up to 2.4µm for ~8µm cells (default 1.0).")
    g.add_argument("--enhanced", action=argparse.BooleanOptionalAction, default=True,
                   help="Use ProbabilitiesEnhanced: oversensitive DoG with "
                        "bidirectional temporal coherence filtering (V2.5)")
    g.add_argument("--prob-method", choices=("dog", "cellpose"), default="dog",
                   help="Probability source: 'dog' (Difference of Gaussians) or "
                        "'cellpose' (learned nuclei model, 3D). Cellpose fields "
                        "are cached separately with a _cellpose suffix "
                        "(default: %(default)s)")
    g.add_argument("--sensitivity", type=float, default=0.6,
                   help="DoG sensitivity multiplier for --enhanced mode. "
                        "Lower = more sensitive (default: %(default)s)")
    g.add_argument("--dynamic-dog", action=argparse.BooleanOptionalAction, default=True,
                   help="Dynamically scale DoG per frame to maintain a "
                        "smooth cell count over time")
    g.add_argument("--temporal-radius", type=int, default=2,
                   help="±frames of temporal coherence for --enhanced mode. "
                        "Neighbours are drift-pooled so this can widen past "
                        "±2 without smearing (default: %(default)s)")
    g.add_argument("--center-weight", type=float, default=1.0,
                   help="Weight of the current frame in temporal probability geometric mean (default: %(default)s)")
    g.add_argument("--grid", type=int, default=METHOD.GRID_N,
                   help="Field grid size; 32 gives 3.25µm cells, 64 gives "
                        "1.625µm for dense data (default: %(default)s)")
    g.add_argument("--supersample", type=int, default=METHOD.SUPERSAMPLE,
                   help="k³ sample points per Field Cell (default: %(default)s)")
    g.add_argument("--quantise", action="store_true",
                   help="Quantise field values to uint4 inside the solver "
                        "(memory optimisation, default off)")

    g = p.add_argument_group("Field Optimization (Evolution Strategies)")
    g.add_argument("--optimize-field", action=argparse.BooleanOptionalAction, default=False,
                   help="Use zeroth-order optimization (ES) to iteratively "
                        "sculpt the field using the MILP solver as reward. "
                        "Default OFF: experiments showed it does not improve "
                        "accuracy (see field_optimizer_findings.md) and costs "
                        "~50-80s/video.")
    g.add_argument("--optimize-discrete", type=int, default=0,
                   help="Run the greedy discrete local search on the top N uncertain regions (e.g. 16).")
    g.add_argument("--opt-iters", type=int, default=3,
                   help="Number of optimization iterations (default: %(default)s)")
    g.add_argument("--opt-samples", type=int, default=20,
                   help="Number of noise samples per iteration (default: %(default)s)")
    g.add_argument("--opt-sigma", type=float, default=0.05,
                   help="Standard deviation of noise (default: %(default)s)")
    g.add_argument("--opt-alpha", type=float, default=0.005,
                   help="Learning rate for Adam optimizer (default: %(default)s)")
    g.add_argument("--opt-lambda", type=float, default=0.5,
                   help="L2 regularization penalty for deviating from base field "
                        "(default: %(default)s)")

    g = p.add_argument_group("Momentum Conservation (Iterative LP)")
    g.add_argument("--momentum-iters", type=int, default=0,
                   help="Number of iterative LP solves to penalize sharp turns. "
                        "0 = standard min-cost flow (default: %(default)s)")
    g.add_argument("--momentum-penalty", type=float, default=10.0,
                   help="Penalty added to the LP edge cost for edges forming "
                        "sharp turns (default: %(default)s)")
    
    g = p.add_argument_group("Chain Completion (Iterative LP)")
    g.add_argument("--completion-iters", type=int, default=0,
                   help="Number of iterations to run the chain completion solver")
    g.add_argument("--completion-bonus", type=float, default=1.0,
                   help="Bonus applied to edges that extend prematurely broken chains")

    g.add_argument("--opt-global", action="store_true",
                   help="Apply the ES CNN across the whole video instead of "
                        "only the 8 most-uncertain local regions.")
    g.add_argument("--opt-window", type=int, default=0,
                   help="Phase-1 speed: score each ES sample on a random run "
                        "of N consecutive frames (minibatch) instead of the "
                        "whole video. Needs --opt-global. 0 = full video.")
    g.add_argument("--opt-trust", type=float, default=0.0,
                   help="Per-voxel trust region: clamp each candidate value to "
                        "base ± this before solving, so the field can't drift "
                        "into a fake map (and LPs stay small). 0 = off.")
    g.add_argument("--opt-antithetic", action="store_true",
                   help="Antithetic sampling (±noise pairs) to halve gradient "
                        "variance. Needs an even --opt-samples.")
    g.add_argument("--opt-node-penalty", type=float, default=0.0,
                   help="Phase-2 anti-gaming guard: subtract this per graph node "
                        "from the reward, so the CNN can't farm the value-"
                        "dominated score by manufacturing spurious maxima. "
                        "A node must be worth > this in value to pay for itself. "
                        "0 = off.")

    g = p.add_argument_group("Graph and Solver")
    g.add_argument("--node-select", choices=("maxima", "threshold"),
                   default="maxima",
                   help="Which Field Cells become nodes. 'threshold' is the "
                        "specification read literally (default: %(default)s)")
    g.add_argument("--nms-radius", type=int, default=3,
                   help="Size of the non-maximum suppression filter for node selection (default: %(default)s)")
    g.add_argument("--value-floor", type=float, default=METHOD.VALUE_FLOOR)
    g.add_argument("--adaptive-floor-pct", type=float, default=0.0)
    g.add_argument("--max-nodes", type=int, default=METHOD.MAX_NODES_PER_FRAME)
    g.add_argument("--box-radius", type=int, default=METHOD.BOX_RADIUS,
                   help="Rule 2's reach, in Field Cells (default: %(default)s)")
    g.add_argument("--node-capacity", type=int, default=1,
                   help="Max tracks per grid cell. 2 = allow squashed cells "
                        "to share a node (default: %(default)s)")
    g.add_argument("--secondary-penalty", type=float, default=0.2,
                   help="Penalty for the 2nd track through a shared node "
                        "(only used when --node-capacity >= 2, default: %(default)s)")
    g.add_argument("--continuous-centroids", action="store_true",
                   help="Use sub-voxel continuous centroids for exact LP distance costs")

    g = p.add_argument_group("Evaluation weights (λ1·value − λ2·distance "
                             "− λ3·termination)")
    g.add_argument("--cell-probability-multiplier", type=float, default=METHOD.CELL_PROBABILITY_MULTIPLIER)
    g.add_argument("--link-distance", type=float,
                   default=METHOD.LINK_DISTANCE)
    g.add_argument("--lambda-termination", type=float,
                   default=METHOD.LAMBDA_TERMINATION)
    g.add_argument("--lambda-start", type=float,
                   default=METHOD.LAMBDA_START)
    g.add_argument("--dead-zone", type=float, default=METHOD.DEAD_ZONE_UM,
                   help="µm of link length that is free (default: %(default)s)")

    g = p.add_argument_group("Output")
    g.add_argument("--division-method", choices=("none", "simple", "birth"),
                   default="none",
                   help="Post-hoc divisions. 'simple': every track starting "
                        "at t>0 links back to its closest used node at t-1 "
                        "(transform-corrected); if that parent continues it is "
                        "split into a real division. 'birth': also recover idle "
                        "LP nodes that persist forward (cells entering view / "
                        "division daughters) as tracks (default: none).")
    g.add_argument("--division-max-um", type=float, default=0.0,
                   help="Gate 'simple' divisions on the parent-link residual "
                        "distance in µm (0 = no gate). A real division puts the "
                        "daughter ~1 cell (~1.6µm) from the parent.")
    g.add_argument("--division-require-split", action="store_true",
                   help="Keep only true two-child divisions (parent continues "
                        "past the split), dropping dead-end re-links.")
    g.add_argument("--birth-min-frames", type=int, default=3,
                   help="Min forward length (frames) for a recovered 'birth' "
                        "chain — the forward-persistence gate (default 3).")
    g.add_argument("--birth-dedup-um", type=float, default=3.25,
                   help="Drop a recovered 'birth' chain that shadows a used "
                        "track (within this µm at the same frame) for more than "
                        "--birth-max-shadow of its length. 0 disables dedup.")
    g.add_argument("--birth-max-shadow", type=float, default=0.5,
                   help="Max fraction of a birth chain allowed to shadow an "
                        "existing track before it is dropped (default 0.5).")
    g.add_argument("--birth-adaptive", action="store_true",
                   help="Only recover births on fragmented videos (mean LP "
                        "track < --birth-adaptive-len frames); clean videos "
                        "with long tracks skip recovery.")
    g.add_argument("--birth-adaptive-len", type=float, default=5.0,
                   help="Mean-LP-track-length threshold for --birth-adaptive "
                        "(default 5 frames).")
    g.add_argument("--birth-min-value", type=float, default=0.0,
                   help="Drop a recovered 'birth' chain whose mean Field value "
                        "is below this (real dropped cells are bright; noise "
                        "leftovers are dim). 0 = off.")
    g.add_argument("--refine", action=argparse.BooleanOptionalAction, default=False,
                   help="Report the probability-weighted centroid inside "
                        "the Field Cell rather than the grid centre")
    g.add_argument("--solver-log", action="store_true",
                   help="Stream the LP solver's own iteration log")
    g.add_argument("--record-augmentations", type=int, nargs="?", const=300,
                   default=0, metavar="N",
                   help="Replay the solve as N successive shortest paths and "
                        "save them, to watch the Configuration build up")
    g.add_argument("--napari", action="store_true",
                   help="Open the napari viewer when the run finishes")


    g = p.add_argument_group("Scoring")
    g.add_argument("--no-eval", action="store_true")
    g.add_argument("--gt-geff", type=str, default=None)
    g.add_argument("--eval-split", type=int, default=50)
    g.add_argument("--baseline-python", type=str, default=str(BASELINE_PY))
    g.add_argument("--config", type=Path, default=PROJECT / "default_config.json",
                   help="Path to JSON config overrides")
    g.add_argument("--test-dir", type=Path, default=None,
                   help="If provided, saves JSON log directly into this specific directory instead of logs/")
    return p

def main():
    p = get_parser()
    args = p.parse_args()

    if args.config and args.config.exists():
        try:
            import json
            import sys
            
            # Find arguments explicitly passed on the CLI so they aren't overwritten by the config
            explicit_args = {arg[2:].split("=")[0].replace("-", "_") for arg in sys.argv if arg.startswith("--")}
            explicit_args.update({arg[5:].replace("-", "_") for arg in sys.argv if arg.startswith("--no-")})
            
            with open(args.config) as f:
                config_data = json.load(f)
            
            if "config" in config_data:
                config_data = config_data["config"]
                
            if "arguments" in config_data:
                for k, v in config_data["arguments"].items():
                    if hasattr(args, k) and k not in explicit_args:
                        setattr(args, k, v)
                        
            if "method_constants" in config_data:
                for k, v in config_data["method_constants"].items():
                    if hasattr(METHOD, k):
                        setattr(METHOD, k, v)
        except Exception as e:
            print(f"Failed to load default_config.json: {e}")

    setup_logging(args.log_dir)
    t0 = time.time()
    vol, fld, graph, out_dir, metadata = run(args)
    log.info(f"Tracking finished in {time.time() - t0:.1f}s")

    gt_geff = Path(args.gt_geff) if args.gt_geff else find_gt_geff(vol.path)
    if args.no_eval:
        log.info("Skipping scoring (--no-eval).")
    elif gt_geff is None:
        log.info(f"No ground truth beside {vol.path.name}: nothing to score.")
    else:
        result = evaluate(out_dir / "tracks.csv", gt_geff, vol.nt,
                          args.eval_split, Path(args.baseline_python))
        if result:
            report(result, vol.path.stem)
            (out_dir / "score.json").write_text(json.dumps(result, indent=2))
            
            # Save comprehensive TestMeta JSON
            import datetime
            from Schemas import TestMeta, Config, KaggleMetrics
            
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            
            method_constants = {
                k: getattr(METHOD, k) for k in dir(METHOD) 
                if k.isupper() and isinstance(getattr(METHOD, k), (int, float, str, bool))
            }
            
            # Serialize paths in arguments
            args_dict = {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}

            test_meta = TestMeta(
                timestamp=timestamp,
                config=Config(
                    dataset=vol.path.stem,
                    arguments=args_dict,
                    method_constants=method_constants
                ),
                metrics=KaggleMetrics(**result),
                **metadata
            )
            
            if args.test_dir:
                args.test_dir.mkdir(parents=True, exist_ok=True)
                config_file = args.test_dir / f"{vol.path.stem}.json"
            else:
                logs_dir = PROJECT / "logs"
                logs_dir.mkdir(exist_ok=True)
                config_file = logs_dir / f"{timestamp}_{vol.path.stem}.json"
                
            config_file.write_text(test_meta.model_dump_json(indent=2))
            log.info(f"Saved TestMeta JSON log to {config_file.relative_to(PROJECT)}")

    if args.napari:
        from visualise import open_viewer
        open_viewer(vol.path, out_dir)


if __name__ == "__main__":
    main()
