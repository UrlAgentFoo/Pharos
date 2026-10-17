"""Single source of truth for the cached_fields/ layout.

Dependency-free on purpose: solver.py (main venv) and test.py
(kaggle_baseline venv) both import this to derive identical paths, so it
must not pull in sitk/zarr/polars.

Layout (hierarchical — transforms shared across field variants):

    cached_fields/<video_id>/
        transforms/<transform_tag>.npz      # reg_spacing, estimator, no_svf
        <field_tag>/                         # grid, dog, temporal, dynamic_dog, ss, num_dog, quantise
            field.npz
            tracks.csv, tracks_competition.csv, edges.npz, score.json

`a` is any attribute- or dict-like config (argparse.Namespace via vars(),
or the `arguments` block of a config JSON).  Knob defaults live here so a
default run reproduces the canonical tag.
"""

from __future__ import annotations

from pathlib import Path


def _g(a, key, default):
    """Read `key` from a Mapping or an object, falling back to `default`."""
    if hasattr(a, "get"):
        return a.get(key, default)
    return getattr(a, key, default)


def transform_tag(a) -> str:
    reg = _g(a, "reg_spacing", 1.625)
    estimator = ("adaptive" if _g(a, "adaptive", False) else
                 "affine" if _g(a, "affine", False) else
                 "phase" if _g(a, "phase", False) else "rigid")
    nosvf = "_nosvf" if _g(a, "no_svf", False) else ""
    return f"r{reg:g}_{estimator}{nosvf}"


def field_tag(a) -> str:
    grid = _g(a, "grid", 64)
    dog = _g(a, "dog_inner", 2.5)
    enhanced = _g(a, "enhanced", True)
    tr = _g(a, "temporal_radius", 2)
    cw = _g(a, "center_weight", 1.0)
    prob = _g(a, "prob_method", "dog")

    cw_tag = f"_cw{cw}" if cw != 1.0 else ""
    prob_tag = "_cellpose" if prob == "cellpose" else ""
    tmode = _g(a, "temporal_mode", "symmetric")
    tmode_tag = "_dir" if tmode == "directional" else ""
    core = f"enh{tr}r{cw_tag}{prob_tag}{tmode_tag}" if enhanced else f"std{prob_tag}"

    # Knobs that change the field values.  Defaults collapse to "" so the
    # canonical run stays `g64_dog2.5_enh2r`.
    static = "" if _g(a, "dynamic_dog", True) else "_static"
    ss = _g(a, "supersample", 2)
    ss_tag = "" if ss == 2 else f"_ss{ss}"
    nd = _g(a, "num_dog", 1)
    mdog = "" if nd <= 1 else f"_mdog{nd}"
    psn = "_psn" if (nd > 1 and _g(a, "per_scale_norm", False)) else ""
    psnw = "w" if (psn and _g(a, "psn_weighted", False)) else ""
    mdog = mdog + psn + psnw
    # Scale span only matters for multi-DoG; default (0.68, 1.0) collapses to "".
    lo = _g(a, "dog_mult_lo", 0.68)
    hi = _g(a, "dog_mult_hi", 1.0)
    span = "" if (nd <= 1 or (lo == 0.68 and hi == 1.0)) else f"_m{lo:g}-{hi:g}"
    q_tag = "_q4" if _g(a, "quantise", False) else ""

    return f"g{grid}_dog{dog:g}_{core}{static}{ss_tag}{mdog}{span}{q_tag}"


def video_dir(base, video_id) -> Path:
    return Path(base) / video_id


def transforms_path(base, video_id, a) -> Path:
    return video_dir(base, video_id) / "transforms" / f"{transform_tag(a)}.npz"


def field_dir(base, video_id, a) -> Path:
    """Directory holding field.npz + tracks/edges/score for this variant."""
    return video_dir(base, video_id) / field_tag(a)
