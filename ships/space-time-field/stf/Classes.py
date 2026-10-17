"""Stem Cell Tracking V2 — the Space Time Field, implemented in its own terms.

One method, one file.  The specification's vocabulary is the code's
vocabulary: Transforms, Probabilities, Field, Field Cell, Distance Matrix,
Graph, Path, Configuration.

    Initialisation (in the order the specification gives, because each
    stage consumes the one before)

        Transforms      per frame pair, an affine, refined to a
                        stationary velocity field when the residual
                        motion at cell locations exceeds the gate.
                        Velocity-based, so exp(-v) is the exact inverse.
        Probabilities   DoG of frame t averaged with the DoG of frame
                        t+1 warped back through the transform.  Shares
                        the Zarr Frame Voxel grid.  Negatives clipped.
        Field           a 32x32x32 grid of 3.25µm isotropic cubes,
                        deformed by the cumulated transform at t so it
                        follows the tissue.  Each Field Cell's value is
                        the volume-weighted average of the Probability
                        voxels it overlaps -- which is also the
                        anisotropic to isotropic resample.

    Rules -> Graph      edges go forward exactly one frame; the end node
                        is at most 2 cells away in any direction; paths
                        end only at t=99 or out of view; paths cannot
                        merge.

    Optimisation        min-cost flow.  Every Field Cell splits into an
                        in node and an out node joined by a capacity-1
                        edge carrying the value reward; that split is
                        rule 4.  A free source edge is "appearing is not
                        penalised"; a sink edge carrying the termination
                        penalty is rule 3.  The constraint matrix is an
                        incidence matrix, so it is totally unimodular,
                        so the LP relaxation is already integral -- HiGHS
                        returns the exact optimum with no branch and
                        bound.  The number of paths tunes itself: the
                        solver adds a track only while its cheapest
                        augmenting path has negative cost.

No detector, no centroid model, no learned weights.  A cell is whatever
persists through the Space Time Field.

The one deliberate departure from the specification as written is node
selection.  Taking every Field Cell would put 3.3M nodes and 410M edges
in the LP, and would also let two parallel paths run through the two
halves of one 7µm nucleus, which rule 4 does not forbid because they
never share a node.  Field Cells that are local maxima of the Field in
their own 3x3x3 index neighbourhood are kept instead -- the same
"one cell, one maximum" the specification already names as the method's
resolution limit.  ``node_select="threshold"`` restores the literal
reading for small grids.
"""

from __future__ import annotations

import csv
import logging
import os
import time
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import numpy as np
import SimpleITK as sitk
from scipy import ndimage as ndi
from scipy import sparse
from scipy.optimize import linprog

log = logging.getLogger("space_time_field")


# ── Constants ────────────────────────────────────────────────────────────────

# µm per Zarr Frame Voxel, (z, y, x).  Identical across every video in the
# competition set, so it is a constant rather than something read per file.
VOXEL_SCALE = np.array([1.625, 0.40625, 0.40625])

# The Field grid.  64 * 1.625 = 256 * 0.40625 = 104µm, so a 32³ grid of
# 3.25µm cubes tiles the field of view exactly, and so does a 64³ grid of
# 1.625µm cubes.  Nothing here assumes 32; the spacing is derived.
# 64³ is the default: its 1.625µm cells localise cells sharply enough to
# match the overnight benchmark (e.g. 44b6_7e557709: 0.94 vs 0.75 at 32³).
GRID_N = 64

# ── Transforms ───────────────────────────────────────────────────────────────
# Spacing of the isotropic grid the registration runs on.  Finer than the
# Field, because the affine is estimated once and used everywhere.
REG_SPACING_UM = 1.625
# Spacing of the velocity field.  Residual motion is smooth; the Field's
# own resolution carries it.
SVF_SPACING_UM = 3.25
# Residual motion above which the affine is refused and the SVF is fitted.
# Two Field Cells at 32³ -- the same 6.5µm as rule 2's reach, because a
# residual larger than the gate is a match the rules can no longer see.
RESIDUAL_GATE_UM = 6.5
SVF_ITERATIONS = 40
SVF_SMOOTH_UM = 6.5          # diffusion regularisation, in µm
SVF_MAX_STEP_UM = 3.25       # per-iteration update cap, one Field Cell
SVF_SQUARINGS = 6            # scaling-and-squaring steps for exp(v)

# ── Probabilities ────────────────────────────────────────────────────────────
# Inner sigma in µm, about a nucleus radius.  Set in µm, so it is
# anisotropic in voxel units: 1.5 voxels in z against 6.2 in y and x.
DOG_INNER_UM = 2.5
DOG_RATIO = 1.6              # outer / inner, the usual Laplacian match

# ── Field ────────────────────────────────────────────────────────────────────
SUPERSAMPLE = 2              # k³ sample points per Field Cell

# Re-anchoring (opt-in, default OFF).  The transform chain drifts ~0.55µm per
# hop (measured, random walk), so at ±k the warped sample can slide a whole
# nucleus off its cell and the temporal geometric mean smears.  Setting this
# >0 max-pools each neighbour frame over that per-hop radius before sampling,
# so a cell the chain drifted off is recovered from within the pool — which
# holds the effective drift flat and lets the window widen past ±2.  Measured
# a clear win on SPARSE video (6bba ±8: 0.727→0.756, FP 142→106) but a
# regression on DENSE/crowded video (44b6_d5e7d891 ±2: 0.639→0.581), where
# the max-pool merges neighbouring peaks.  Off by default until a per-video
# density gate turns it on only where it helps; enable with DRIFT_PER_HOP_UM
# (e.g. 0.55) for known-sparse video.  The centre frame is never pooled.
DRIFT_PER_HOP_UM = float(os.environ.get("DRIFT_PER_HOP_UM", "0.0"))

# Temporal blend weighting.  The blend is a geometric mean over the centre
# Frame and each ±dt neighbour; this weights each neighbour by decay**dt, so
# further (and drift-noisier) frames count for less — a "diminishing stack"
# that softens the window instead of a hard cutoff.  1.0 = equal weights =
# the original geometric mean (lossless).  e.g. 0.6 gives the centre ~2.8x the
# weight of a ±2 frame.  Env-tunable; default equal.
TEMPORAL_DECAY = float(os.environ.get("TEMPORAL_DECAY", "1.0"))

# Probability shaping.  The base Probability is DoG/scale clipped to [0,1];
# raising it to a power sharpens contrast — background toward 0, peaks kept
# high — which can suppress dim spurious maxima.  1.0 = linear (unchanged);
# 2.0 = quadratic.  Monotonic, so it does not move the maxima, but it shifts
# which clear the floor and the median the λ auto-calibration keys off.
PROB_POWER = float(os.environ.get("PROB_POWER", "1.0"))

# Convexity bonus.  Adds a flat bonus to the Probability wherever the intensity
# Hessian is negative-definite (a locally convex bright blob), rewarding
# blob-shaped points over saddles/ridges.  Uses Sylvester's criterion on the
# six Hessian components (no per-voxel eigensolve).  0.0 = off (unchanged).
CONVEX_BONUS = float(os.environ.get("CONVEX_BONUS", "0.0"))

# Adaptive estimator: SNR threshold for switching between rigid and affine.
# Frames with SNR >= this use affine (captures real tissue deformation);
# frames with SNR < this use rigid (avoids overfitting on noise).
ADAPTIVE_SNR_THRESHOLD = float(os.environ.get("ADAPTIVE_SNR_THRESHOLD", "1.35"))

# Graded convexity: instead of a flat bonus across the whole convex region,
# scale it by the normalised determinant-of-Hessian magnitude, which peaks at
# the blob centre and fades to the edge.  Concentrates the bonus where maxima
# already are, so it adds far fewer new nodes over the floor (less node-count
# penalty) than the flat mask.  Off => flat binary bonus.
CONVEX_GRADED = os.environ.get("CONVEX_GRADED", "0") == "1"

# Convexity source.  By default convexity is measured on the raw intensity,
# whose large-scale background curvature makes broad bright regions read as
# "convex" and inflates the node count.  With this on, it is measured on the
# band-passed DoG instead, which strips that background so convexity fires
# only on true blob-scale structure.
CONVEX_ON_DOG = os.environ.get("CONVEX_ON_DOG", "0") == "1"

# ── Graph ────────────────────────────────────────────────────────────────────
BOX_RADIUS = 3               # rule 2: at most 3 cells away in any direction
MAX_NODES_PER_FRAME = 1500
VALUE_FLOOR = 0.02           # a Field Cell this dim is not offered at all

# ── Evaluation weights ───────────────────────────────────────────────────────
# λ1·value − λ2·distance − λ3·termination.  Three different scales, so
# these are tuned against the competition metric, not chosen on looks.
CELL_PROBABILITY_MULTIPLIER = 1.0
LINK_DISTANCE = 1.0      # per µm (fallback; overridden by auto)
LAMBDA_TERMINATION = 0.60    # fallback; overridden by auto
LAMBDA_START = 0.15          # fallback; overridden by auto (0.25 * termination)

# Auto-calibration structural constants (universal, not video-specific).
# K_TERM: a path break costs K_TERM × median node rewards.
# K_DIST: a 3× residual edge costs ~K_DIST × median node reward.
K_TERM = 4.0
K_DIST = 0.5
DEAD_ZONE_UM = 3.0           # residual wobble is free


# ── Small helpers ────────────────────────────────────────────────────────────

def _sample(vol: np.ndarray, idx: np.ndarray, order: int = 1) -> np.ndarray:
    """Interpolate *vol* at voxel indices *idx*, shape (3, ...)."""
    return ndi.map_coordinates(vol, idx, order=order, mode="nearest",
                               prefilter=False)


def _sitk_image(vol: np.ndarray, spacing_um) -> sitk.Image:
    """A numpy (z, y, x) array as a SimpleITK image with physical spacing."""
    img = sitk.GetImageFromArray(np.ascontiguousarray(vol, dtype=np.float32))
    s = np.atleast_1d(spacing_um).astype(float)
    if s.size == 1:
        s = np.repeat(s, 3)
    img.SetSpacing((float(s[2]), float(s[1]), float(s[0])))   # sitk is x, y, z
    return img


def _isotropic(img: sitk.Image, spacing_um: float) -> sitk.Image:
    """Resample onto an isotropic grid of the given spacing.

    This is where the anisotropy leaves the pipeline: everything after it
    measures distance in µm on a grid whose steps are equal in every
    direction.
    """
    extent = [n * sp for n, sp in zip(img.GetSize(), img.GetSpacing())]
    size = [max(1, int(round(e / spacing_um))) for e in extent]
    r = sitk.ResampleImageFilter()
    r.SetOutputSpacing([spacing_um] * 3)
    r.SetSize(size)
    r.SetOutputOrigin(img.GetOrigin())
    r.SetOutputDirection(img.GetDirection())
    r.SetInterpolator(sitk.sitkLinear)
    return r.Execute(img)


def _iso_array(vol: np.ndarray, spacing_um: float) -> np.ndarray:
    return sitk.GetArrayFromImage(
        _isotropic(_sitk_image(vol, VOXEL_SCALE), spacing_um)).astype(np.float32)


def _box_moment(vol: np.ndarray, box: np.ndarray, axis: int) -> np.ndarray:
    """First moment of *vol* about the centre of a box window, in voxels.

    Separable, and using exactly the window ``uniform_filter`` uses, so
    dividing this by the box mean gives the centre of mass inside the
    cube in the same coordinates the cube was sampled at.
    """
    out = vol
    for ax in range(3):
        k = int(box[ax])
        w = np.ones(k) / k
        if ax == axis:
            w = w * (np.arange(k) - (k - 1) / 2.0)
        out = ndi.correlate1d(out, w, axis=ax, mode="nearest")
    return out.astype(np.float32)


def _gauss_um(vol: np.ndarray, sigma_um, scale=VOXEL_SCALE) -> np.ndarray:
    """Gaussian with the sigma given in µm, hence anisotropic in voxels."""
    sig = np.atleast_1d(sigma_um).astype(float)
    if sig.size == 1:
        sig = np.repeat(sig, 3)
    return ndi.gaussian_filter(vol, sigma=tuple(sig / scale), mode="nearest")


# ── The stationary velocity field ────────────────────────────────────────────

def svf_exp(v: np.ndarray, spacing_um: float, squarings: int = SVF_SQUARINGS,
            sign: float = 1.0) -> np.ndarray:
    """exp(sign·v) as a displacement field, by scaling and squaring.

    v is (3, nz, ny, nx) in µm on an isotropic grid.  φ(x) = x + u(x) with
    u = exp(v); φ is a diffeomorphism, and exp(-v) is its exact inverse.
    That is the whole reason the residual is carried as a velocity and not
    as a displacement: inverting it is a negation, not a solve.
    """
    u = (sign / (2 ** squarings)) * v
    for _ in range(squarings):
        u = u + _warp_vector(u, u, spacing_um)
    return u


def _warp_vector(field: np.ndarray, u: np.ndarray,
                 spacing_um: float) -> np.ndarray:
    """Sample the vector *field* at x + u(x); both (3, nz, ny, nx) in µm."""
    shape = field.shape[1:]
    grid = np.indices(shape, dtype=np.float32)
    idx = grid + u / spacing_um
    return np.stack([_sample(field[c], idx) for c in range(3)])


def _warp_volume(vol: np.ndarray, u: np.ndarray,
                 spacing_um: float) -> np.ndarray:
    """Sample the scalar *vol* at x + u(x)."""
    grid = np.indices(vol.shape, dtype=np.float32)
    return _sample(vol, grid + u / spacing_um)


def fit_svf(fixed: np.ndarray, moving: np.ndarray, spacing_um: float,
            n_iter: int = SVF_ITERATIONS,
            smooth_um: float = SVF_SMOOTH_UM,
            max_step_um: float = SVF_MAX_STEP_UM) -> np.ndarray:
    """Log-domain diffeomorphic demons: the velocity v aligning moving to fixed.

    Returns v in µm, shape (3, nz, ny, nx), such that
    ``moving(x + exp(v)(x)) ≈ fixed(x)``.  The update is the usual demons
    force with the fixed image's gradient, composed onto v additively
    (first-order BCH) and smoothed each step, which is what keeps the
    field diffeomorphic and the Jacobian positive.
    """
    fixed = np.ascontiguousarray(fixed, dtype=np.float32)
    moving = np.ascontiguousarray(moving, dtype=np.float32)
    v = np.zeros((3,) + fixed.shape, dtype=np.float32)

    grad = np.stack(np.gradient(fixed)).astype(np.float32) / spacing_um
    gsq = (grad ** 2).sum(0)
    # Intensity-noise term: keeps the update finite where the gradient
    # vanishes, scaled to the image's own contrast.
    sigma_i2 = float(np.var(fixed)) + 1e-8
    sigma_vox = smooth_um / spacing_um

    for _ in range(n_iter):
        u = svf_exp(v, spacing_um)
        diff = fixed - _warp_volume(moving, u, spacing_um)
        denom = gsq + (diff ** 2) / sigma_i2
        step = np.where(denom > 1e-12, diff / np.maximum(denom, 1e-12), 0.0)
        upd = (grad * step).astype(np.float32)

        mag = np.sqrt((upd ** 2).sum(0))
        over = mag > max_step_um
        if over.any():
            upd[:, over] *= (max_step_um / mag[over])

        v = v + upd
        for c in range(3):
            v[c] = ndi.gaussian_filter(v[c], sigma_vox, mode="nearest")
    return v


@dataclass
class Transform:
    """The cumulated change to the Field across one frame pair, t -> t+1.

        forward(x) = A · (x + exp(v)(x))
        inverse(y) = z + exp(-v)(z),   z = A⁻¹ y

    with x in frame t's µm coordinates and y in frame t+1's.  The affine
    carries the bulk motion; the velocity field carries whatever the
    affine could not, and only exists when the residual gate said so.
    """

    affine: np.ndarray                       # 4x4, µm, maps t -> t+1
    velocity: np.ndarray | None = None       # (3, nz, ny, nx) µm, in t's frame
    svf_spacing_um: float = SVF_SPACING_UM
    residual_um: float = 0.0                 # motion left after this Transform
    motion_um: float = 0.0                   # motion before it, for comparison
    refined: bool = False
    rejected: bool = False                   # the fit was worse than identity

    def _apply_affine(self, pts: np.ndarray, inverse: bool = False):
        M = np.linalg.inv(self.affine) if inverse else self.affine
        return pts @ M[:3, :3].T + M[:3, 3]

    def _displace(self, pts: np.ndarray, sign: float) -> np.ndarray:
        """exp(sign·v) sampled at *pts* (µm, frame-t space)."""
        if self.velocity is None:
            return np.zeros_like(pts)
        u = svf_exp(self.velocity, self.svf_spacing_um, sign=sign)
        idx = (pts / self.svf_spacing_um).T
        return np.stack([_sample(u[c], idx) for c in range(3)], axis=-1)

    def forward(self, pts: np.ndarray) -> np.ndarray:
        """Where the material at *pts* in frame t is in frame t+1."""
        pts = np.asarray(pts, dtype=np.float64)
        return self._apply_affine(pts + self._displace(pts, +1.0))

    def inverse(self, pts: np.ndarray) -> np.ndarray:
        """Where the material at *pts* in frame t+1 was in frame t."""
        z = self._apply_affine(np.asarray(pts, dtype=np.float64), inverse=True)
        return z + self._displace(z, -1.0)

    def displacement_field(self, shape, spacing_um: float,
                           sign: float = +1.0) -> np.ndarray:
        """The whole transform as a displacement field on a voxel grid.

        Used to warp images; ``sign=-1`` gives the inverse, exactly,
        because inverting the velocity part is a negation.
        """
        sp = np.atleast_1d(spacing_um).astype(np.float64)
        if sp.size == 1:
            sp = np.repeat(sp, 3)
        grid = np.indices(shape, dtype=np.float32) * sp[:, None, None, None]
        pts = grid.reshape(3, -1).T
        moved = self.forward(pts) if sign > 0 else self.inverse(pts)
        return (moved - pts).T.reshape((3,) + tuple(shape)).astype(np.float32)


class Transforms:
    """One Transform per frame pair, and the cumulated push of a point set.

    Built first, because both the Probabilities (which warp t+1 back onto
    t before averaging) and the Field grid (which is deformed by the
    cumulated transform) are defined in terms of them.
    """

    def __init__(self, transforms: list[Transform], nt: int):
        self.transforms = transforms
        self.nt = nt

    def __len__(self):
        return len(self.transforms)

    def __getitem__(self, t: int) -> Transform:
        return self.transforms[t]

    @property
    def n_refined(self) -> int:
        return sum(1 for tr in self.transforms if tr.refined)

    @property
    def n_rejected(self) -> int:
        return sum(1 for tr in self.transforms if tr.rejected)

    @property
    def residuals(self) -> np.ndarray:
        return np.array([tr.residual_um for tr in self.transforms])

    @property
    def motions(self) -> np.ndarray:
        """Motion at cell locations before any Transform was applied."""
        return np.array([tr.motion_um for tr in self.transforms])

    # ── construction ─────────────────────────────────────────────────────

    @classmethod
    def build(cls, volume, reg_spacing_um: float = REG_SPACING_UM,
              svf_spacing_um: float = SVF_SPACING_UM,
              residual_gate_um: float = RESIDUAL_GATE_UM,
              allow_svf: bool = True, estimator: str = "affine",
              interpolate_rejected: bool = False,
              progress=None) -> "Transforms":
        from concurrent.futures import ThreadPoolExecutor
        import os

        nt = volume.nt
        out: list[Transform] = []
        n_workers = min(os.cpu_count() or 4, 8)

        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            iso_frames = list(pool.map(lambda t: _iso_array(volume.frame(t), reg_spacing_um), range(nt)))

        # Pre-compute per-frame SNR for adaptive estimator selection
        if estimator == "adaptive":
            frame_snr = []
            for t in range(nt):
                f = iso_frames[t].astype(np.float32)
                snr = float(f.mean() / (f.std() + 1e-8))
                frame_snr.append(snr)
            
            # Use median SNR across the entire video to prevent mixed estimators
            video_snr = float(np.median(frame_snr))
            use_affine = video_snr >= ADAPTIVE_SNR_THRESHOLD
            
            n_affine = (nt - 1) if use_affine else 0
            n_rigid = (nt - 1) - n_affine
            
            log.info(f"  Adaptive: video SNR {video_snr:.2f} "
                     f"({'≥' if use_affine else '<'} {ADAPTIVE_SNR_THRESHOLD:.2f}) → "
                     f"{'ALL AFFINE' if use_affine else 'ALL RIGID'}")

        def _choose_estimator(t: int) -> tuple[str, float, bool]:
            """Return (estimator, gate, allow_svf) for pair t."""
            if estimator != "adaptive":
                return estimator, residual_gate_um, allow_svf
            
            if use_affine:
                # High SNR: affine can capture real deformation, SVF at 3µm
                return "affine", 3.0, True
            else:
                # Low SNR: rigid is safer, no SVF
                return "rigid", residual_gate_um, allow_svf

        def _process_pair(t: int) -> Transform:
            est, gate, svf = _choose_estimator(t)
            return cls._pair(iso_frames[t], iso_frames[t+1], reg_spacing_um, svf_spacing_um,
                             gate, svf, est)

        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = [pool.submit(_process_pair, t) for t in range(nt - 1)]
            for fut in futures:
                tr = fut.result()
                out.append(tr)
                if progress:
                    progress.update(1, f"{tr.motion_um:4.2f} → "
                                       f"{tr.residual_um:4.2f}µm"
                                       f"{' +svf' if tr.refined else ''}"
                                       f"{' (fit rejected)' if tr.rejected else ''}")
        if progress:
            progress.done()

        result = cls(out, nt)
        if interpolate_rejected:
            result._interpolate_rejected()
        return result

    def _interpolate_rejected(self):
        """Replace rejected transforms with interpolated affines.

        When a fit is rejected the current fallback is identity (no motion).
        That creates a discontinuity in the cumulated transform chain.
        Instead, linearly interpolate the affine from the nearest
        non-rejected neighbours on each side.  Edge cases (rejected at
        the very start or end) fall back to the nearest valid transform.
        """
        n = len(self.transforms)
        rejected_idx = [i for i, tr in enumerate(self.transforms) if tr.rejected]
        if not rejected_idx:
            return

        # Find nearest non-rejected on each side for every rejected frame
        good = [i for i in range(n) if not self.transforms[i].rejected]
        if not good:
            # Every single frame was rejected — nothing to interpolate from
            return

        n_interp = 0
        for i in rejected_idx:
            # Find nearest good neighbour to the left
            left = None
            for g in reversed(good):
                if g < i:
                    left = g
                    break
            # Find nearest good neighbour to the right
            right = None
            for g in good:
                if g > i:
                    right = g
                    break

            if left is not None and right is not None:
                # Interpolate: weight by distance
                span = right - left
                alpha = (i - left) / span
                A_interp = (1.0 - alpha) * self.transforms[left].affine \
                         + alpha * self.transforms[right].affine
            elif left is not None:
                A_interp = self.transforms[left].affine.copy()
            elif right is not None:
                A_interp = self.transforms[right].affine.copy()
            else:
                continue  # unreachable given the good check above

            self.transforms[i] = Transform(
                affine=A_interp,
                velocity=None,
                svf_spacing_um=self.transforms[i].svf_spacing_um,
                residual_um=self.transforms[i].residual_um,
                motion_um=self.transforms[i].motion_um,
                rejected=False,           # no longer rejected
                refined=False,
            )
            n_interp += 1

        if n_interp:
            log.info(f"  Interpolated {n_interp} rejected transforms from neighbours")

    @staticmethod
    def _pair(fixed: np.ndarray, moving: np.ndarray, reg_spacing_um: float,
              svf_spacing_um: float, gate_um: float,
              allow_svf: bool, estimator: str = "affine") -> Transform:
        """Bulk estimator first; measure the residual; refine only if it
        fails the gate.

        The measurement comes before the decision in both directions: a
        fitted transform that leaves *more* motion at cell locations than
        doing nothing is a failed fit, not a transform, and is dropped.
        Without that guard a bad pair does not merely waste itself -- the
        Field grid is deformed by the cumulated product, so one bad
        transform corrupts every frame after it.

        ``estimator`` selects the bulk-motion model:

        * ``"affine"``  — 12-DOF SimpleITK affine (the default).
        * ``"rigid"``   — 6-DOF SimpleITK rigid.
        * ``"phase"``   — 3-DOF translation via FFT phase correlation,
          much more robust on sparse / low-contrast data because there
          are no scaling or shear parameters to fit noise into.
        """
        motion = _residual_at_cells(fixed, moving, reg_spacing_um)
        if estimator == "affine":
            A = _fit_affine(fixed, moving, reg_spacing_um)
        elif estimator == "rigid":
            A = _fit_rigid(fixed, moving, reg_spacing_um)
        elif estimator == "phase":
            A = _fit_phase_correlation(fixed, moving, reg_spacing_um)
        else:
            A = _fit_affine(fixed, moving, reg_spacing_um)

        # Frame t+1 pulled back into frame t's grid by the affine alone.
        pulled = _resample_by_transform(moving, Transform(affine=A),
                                        reg_spacing_um)
        residual = _residual_at_cells(fixed, pulled, reg_spacing_um)

        rejected = residual > motion
        if rejected:
            A, pulled, residual = np.eye(4), moving, motion
        affine_only = Transform(affine=A, residual_um=residual,
                                motion_um=motion, rejected=rejected)

        if not allow_svf or residual <= gate_um:
            return affine_only

        # The affine left more motion than rule 2 can reach across, so the
        # remainder goes into a velocity field.  Fitted on the coarser SVF
        # grid: residual motion is smooth, and this is what gets stored.
        f = _rescale(fixed, reg_spacing_um, svf_spacing_um)
        m = _rescale(pulled, reg_spacing_um, svf_spacing_um)
        v = fit_svf(f, m, svf_spacing_um)

        refined = Transform(affine=A, velocity=v,
                            svf_spacing_um=svf_spacing_um,
                            motion_um=motion, rejected=rejected, refined=True)
        # The velocity only keeps its place if it beats the affine alone,
        # measured the same way through the whole composed transform.
        after = _residual_at_cells(
            fixed, _resample_by_transform(moving, refined, reg_spacing_um),
            reg_spacing_um)
        if after > residual:
            return affine_only
        refined.residual_um = after
        return refined

    # ── persistence ──────────────────────────────────────────────────────

    def save(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = {
            "nt": np.int32(self.nt),
            "affine": np.stack([tr.affine for tr in self.transforms]),
            "residual": self.residuals,
            "motion": self.motions,
            "refined": np.array([tr.refined for tr in self.transforms]),
            "rejected": np.array([tr.rejected for tr in self.transforms]),
            "svf_spacing": np.float32(
                self.transforms[0].svf_spacing_um if self.transforms
                else SVF_SPACING_UM),
        }
        for i, tr in enumerate(self.transforms):
            if tr.velocity is not None:
                blob[f"v{i}"] = tr.velocity.astype(np.float32)
        np.savez_compressed(path, **blob)
        log.info(f"  Transforms cached → {path} ({self.n_refined} refined)")
        return path

    @classmethod
    def load(cls, path: Path) -> "Transforms":
        z = np.load(path)
        sp = float(z["svf_spacing"])
        out = []
        for i, (A, r, mo, ref, rej) in enumerate(zip(
                z["affine"], z["residual"], z["motion"], z["refined"],
                z["rejected"])):
            v = z[f"v{i}"] if f"v{i}" in z else None
            out.append(Transform(affine=A, velocity=v, svf_spacing_um=sp,
                                 residual_um=float(r), motion_um=float(mo),
                                 refined=bool(ref), rejected=bool(rej)))
        return cls(out, int(z["nt"]))


def _transform_matrix(tx) -> np.ndarray:
    """Any SimpleITK transform as a 4x4 in (z, y, x) µm, by probing it.

    Read off by transforming the origin and the three basis vectors
    rather than unpacking parameters, which keeps it correct for every
    transform type and leaves no room for an axis-order mistake:
    SimpleITK works in (x, y, z) and everything here is (z, y, x).
    """
    o = np.array(tx.TransformPoint((0.0, 0.0, 0.0)))
    M = np.stack([np.array(tx.TransformPoint(tuple(np.eye(3)[i]))) - o
                  for i in range(3)], axis=1)
    flip = np.array([2, 1, 0])
    A = np.eye(4)
    A[:3, :3] = M[np.ix_(flip, flip)]
    A[:3, 3] = o[flip]
    return A


def _fit_affine(fixed: np.ndarray, moving: np.ndarray,
                spacing_um: float) -> np.ndarray:
    """A 4x4 affine in µm mapping frame-t points to frame-t+1 points.

    SimpleITK's registration maps fixed-image points to moving-image
    points; with frame t as fixed and t+1 as moving that is already
    t -> t+1, so nothing is inverted here.

    The optimiser is a regular-step gradient descent and not the plain
    one.  Frame-to-frame motion in this data is around a micron -- well
    under one voxel -- and plain gradient descent at any usable learning
    rate overshoots that and returns a transform *worse* than identity
    (correlation -0.88 against identity's -0.96, with a 1.13 determinant
    that compounds into a 40x volume blow-up over 20 frames).  The
    step-halving keeps the determinant at 1.000 and halves the residual
    instead.
    """
    f = _sitk_image(fixed, spacing_um)
    m = _sitk_image(moving, spacing_um)

    init = sitk.CenteredTransformInitializer(
        f, m, sitk.AffineTransform(3),
        sitk.CenteredTransformInitializerFilter.GEOMETRY)

    reg = sitk.ImageRegistrationMethod()
    reg.SetMetricAsCorrelation()
    reg.SetMetricSamplingStrategy(reg.NONE)
    reg.SetInterpolator(sitk.sitkLinear)
    reg.SetOptimizerAsRegularStepGradientDescent(
        learningRate=1.0, minStep=1e-4, numberOfIterations=200,
        relaxationFactor=0.6, gradientMagnitudeTolerance=1e-6,
        maximumStepSizeInPhysicalUnits=2.0)
    reg.SetOptimizerScalesFromPhysicalShift()
    reg.SetShrinkFactorsPerLevel([4, 2, 1])
    reg.SetSmoothingSigmasPerLevel([2.0, 1.0, 0.0])
    reg.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    reg.SetInitialTransform(init, inPlace=False)

    try:
        tx = reg.Execute(f, m)
    except RuntimeError as exc:                       # pragma: no cover
        log.warning(f"  affine failed ({exc}); using identity")
        return np.eye(4)
    return _transform_matrix(tx)


def _fit_rigid(fixed: np.ndarray, moving: np.ndarray,
                spacing_um: float) -> np.ndarray:
    """A 4x4 rigid (6 DOF) transform in µm mapping t to t+1."""
    f = _sitk_image(fixed, spacing_um)
    m = _sitk_image(moving, spacing_um)

    init = sitk.CenteredTransformInitializer(
        f, m, sitk.Euler3DTransform(),
        sitk.CenteredTransformInitializerFilter.GEOMETRY)

    reg = sitk.ImageRegistrationMethod()
    reg.SetMetricAsCorrelation()
    reg.SetMetricSamplingStrategy(reg.NONE)
    reg.SetInterpolator(sitk.sitkLinear)
    reg.SetOptimizerAsRegularStepGradientDescent(
        learningRate=1.0, minStep=1e-4, numberOfIterations=200,
        relaxationFactor=0.6, gradientMagnitudeTolerance=1e-6,
        maximumStepSizeInPhysicalUnits=2.0)
    reg.SetOptimizerScalesFromPhysicalShift()
    reg.SetShrinkFactorsPerLevel([4, 2, 1])
    reg.SetSmoothingSigmasPerLevel([2.0, 1.0, 0.0])
    reg.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    reg.SetInitialTransform(init, inPlace=False)

    try:
        tx = reg.Execute(f, m)
    except RuntimeError as exc:                       # pragma: no cover
        log.warning(f"  rigid failed ({exc}); using identity")
        return np.eye(4)
    return _transform_matrix(tx)


def _fit_phase_correlation(fixed: np.ndarray, moving: np.ndarray,
                           spacing_um: float,
                           dog_inner_um: float = DOG_INNER_UM,
                           dog_ratio: float = DOG_RATIO) -> np.ndarray:
    """Translation-only registration via phase correlation.

    Returns a 4×4 matrix with only the translation set, in µm (z, y, x).
    Three degrees of freedom instead of twelve -- far more robust when the
    data is sparse or the frame-to-frame motion is sub-voxel, because there
    are no scaling or shear parameters to absorb noise.

    Both volumes are DoG-filtered first so the correlation locks onto
    cell-sized blobs rather than background texture or noise.  The
    cross-power spectrum is then whitened (phase-only normalisation), and a
    Tukey window suppresses spectral leakage at the volume boundary.
    Sub-voxel accuracy comes from a parabolic fit around the correlation
    peak.
    """
    from scipy.signal.windows import tukey

    # DoG bandpass: isolate cell-sized features before correlating.
    scale = np.full(3, spacing_um)   # isotropic grid
    dog_outer_um = dog_inner_um * dog_ratio
    fixed = (_gauss_um(fixed, dog_inner_um, scale)
             - _gauss_um(fixed, dog_outer_um, scale))
    moving = (_gauss_um(moving, dog_inner_um, scale)
              - _gauss_um(moving, dog_outer_um, scale))

    # 3-D separable Tukey window (alpha=0.3 tapers the outer 30% per axis).
    w = np.ones(fixed.shape, dtype=np.float32)
    for ax in range(3):
        t = tukey(fixed.shape[ax], alpha=0.3).astype(np.float32)
        slc = [None] * 3
        slc[ax] = slice(None)
        w *= t[tuple(slc)]

    import scipy.fft
    F = scipy.fft.rfftn(fixed * w)
    M = scipy.fft.rfftn(moving * w)
    cross = np.conj(F) * M
    cross /= np.abs(cross) + 1e-12          # phase-only normalisation
    corr = scipy.fft.irfftn(cross, s=fixed.shape)

    peak = list(np.unravel_index(np.argmax(corr), corr.shape))
    peak_val = float(corr[tuple(peak)])

    shift = np.zeros(3, dtype=np.float64)
    for ax in range(3):
        n = corr.shape[ax]
        i = peak[ax]
        i_unwrapped = i - n if i > n // 2 else i

        # Parabolic sub-voxel refinement using circular neighbours.
        idx_m, idx_p = list(peak), list(peak)
        idx_m[ax] = (i - 1) % n
        idx_p[ax] = (i + 1) % n
        vm = corr[tuple(idx_m)]
        v0 = corr[tuple(peak)]
        vp = corr[tuple(idx_p)]
        denom = vm - 2.0 * v0 + vp
        delta = (np.clip(0.5 * (vm - vp) / denom, -0.5, 0.5)
                 if abs(denom) > 1e-12 else 0.0)
        shift[ax] = i_unwrapped + delta

    shift_um = shift * spacing_um
    log.debug(f"  phase corr shift {shift} vox = {shift_um} µm  "
              f"(peak {peak_val:.4f})")

    A = np.eye(4)
    A[:3, 3] = shift_um
    return A


def _resample_by_transform(moving: np.ndarray, tr: "Transform",
                           spacing_um: float) -> np.ndarray:
    """Frame t+1 sampled on frame t's grid, through the whole Transform.

    ``out[x] = moving(forward(x))``: forward(x) is where the material at x
    went, so reading frame t+1 there brings it back onto frame t's grid.
    """
    grid = np.indices(moving.shape, dtype=np.float32) * spacing_um
    pts = grid.reshape(3, -1).T
    idx = (tr.forward(pts).T / spacing_um).reshape((3,) + moving.shape)
    return _sample(moving, idx).astype(np.float32)


def _rescale(vol: np.ndarray, from_um: float, to_um: float) -> np.ndarray:
    if abs(from_um - to_um) < 1e-9:
        return vol
    return _iso_array_iso(vol, from_um, to_um)


def _iso_array_iso(vol: np.ndarray, from_um: float, to_um: float) -> np.ndarray:
    img = _sitk_image(vol, from_um)
    return sitk.GetArrayFromImage(_isotropic(img, to_um)).astype(np.float32)


def _residual_at_cells(fixed: np.ndarray, pulled: np.ndarray,
                       spacing_um: float, n_points: int = 200,
                       patch: int = 2, search: int = 2) -> float:
    """Median residual motion, in µm, measured where the cells are.

    No detector: the sample points are simply the brightest maxima of the
    blurred frame, which is all that is needed to ask "did the affine
    actually put the bright things on top of each other".  Block matching
    by zero-normalised cross-correlation over an integer search cube,
    vectorised over the points.
    """
    sm = ndi.gaussian_filter(fixed, 1.0, mode="nearest")
    lo = patch + search
    inner = np.zeros_like(sm, dtype=bool)
    inner[lo:-lo or None, lo:-lo or None, lo:-lo or None] = True
    peak = (sm >= ndi.maximum_filter(sm, size=3, mode="nearest")) & inner
    cand = np.argwhere(peak)
    if len(cand) == 0:
        return 0.0
    order = np.argsort(sm[tuple(cand.T)])[::-1][:n_points]
    pts = cand[order]

    d = np.arange(-patch, patch + 1)
    off = np.stack(np.meshgrid(d, d, d, indexing="ij"), -1).reshape(-1, 3)
    ref = fixed[tuple((pts[:, None, :] + off[None]).reshape(-1, 3).T)]
    ref = ref.reshape(len(pts), -1)
    ref = ref - ref.mean(1, keepdims=True)
    ref_n = np.linalg.norm(ref, axis=1) + 1e-8

    s = np.arange(-search, search + 1)
    shifts = np.stack(np.meshgrid(s, s, s, indexing="ij"), -1).reshape(-1, 3)
    ncc = np.empty((len(shifts), len(pts)), np.float32)
    for i, sh in enumerate(shifts):
        w = pulled[tuple((pts[:, None, :] + off[None] + sh).reshape(-1, 3).T)]
        w = w.reshape(len(pts), -1)
        w = w - w.mean(1, keepdims=True)
        ncc[i] = (ref * w).sum(1) / (ref_n * (np.linalg.norm(w, axis=1) + 1e-8))

    # Sub-voxel peak by a parabola through the best shift and its two
    # neighbours on each axis.  Without it the smallest residual the
    # search can report is one grid step, which is most of the gate.
    side = 2 * search + 1
    cube = ncc.reshape(side, side, side, len(pts))
    flat = np.argmax(ncc, axis=0)
    peak = np.stack(np.unravel_index(flat, (side, side, side)), axis=1)
    delta = np.zeros((len(pts), 3))
    for ax in range(3):
        i0 = peak[:, ax]
        interior = (i0 > 0) & (i0 < side - 1)
        if not interior.any():
            continue
        idx = [peak[:, a] for a in range(3)] + [np.arange(len(pts))]
        c = cube[tuple(idx)]
        lo_i, hi_i = list(idx), list(idx)
        lo_i[ax] = np.clip(i0 - 1, 0, side - 1)
        hi_i[ax] = np.clip(i0 + 1, 0, side - 1)
        a_, b_ = cube[tuple(lo_i)], cube[tuple(hi_i)]
        den = a_ - 2 * c + b_
        ok = interior & (np.abs(den) > 1e-9)
        delta[ok, ax] = np.clip(0.5 * (a_[ok] - b_[ok]) / den[ok], -0.5, 0.5)

    offset = (peak - search) + delta
    return float(np.median(np.linalg.norm(offset, axis=1)) * spacing_um)


# ── Probabilities ────────────────────────────────────────────────────────────

class Probabilities:
    """Blobness on the Zarr Frame Voxel grid, one Probability Frame per t.
    """

    def __init__(self, volume, transforms: Transforms,
                 inner_um: float = DOG_INNER_UM, ratio: float = DOG_RATIO,
                 num_dog: int = 1, mult_lo: float = 0.68, mult_hi: float = 1.0,
                 per_scale_norm: bool = False):
        self.volume = volume
        self.transforms = transforms
        self.inner_um = inner_um
        self.outer_um = inner_um * ratio
        self.num_dog = num_dog
        # Scale span for the multi-DoG max-pool (only used when num_dog > 1).
        # Default (0.68, 1.0) spreads *below* inner_um; a span with hi > 1.0
        # reaches *up* to catch larger cells (inner σ up to inner_um * mult_hi).
        self.mult_lo = mult_lo
        self.mult_hi = mult_hi
        # Normalise each DoG scale by its own p99.9 before max-pooling, so a
        # small cell (weaker raw response) competes fairly with a large one
        # instead of being drowned out by one global normalisation.
        self.per_scale_norm = per_scale_norm
        self._scales = None
        # psn-weighted: down-weight bands that are noisy (inconsistent count
        # across frames) or sparse, so a video that only needs one band is not
        # forced to share the max-pool with a noise band.  Set post-construction.
        self.psn_weighted = False
        self._band_weights = None
        self._band_stats = None
        self._raw: dict[int, np.ndarray] = {}
        self._scale = self._calibrate()

    def _scale_dogs(self, vol: np.ndarray, base_r: float = None) -> list:
        """The per-scale raw DoG responses (a single-element list when
        num_dog <= 1), before any max-pool."""
        if base_r is None:
            base_r = self.inner_um
        ratio = self.outer_um / self.inner_um
        if getattr(self, "num_dog", 1) <= 1:
            return [_gauss_um(vol, base_r) - _gauss_um(vol, base_r * ratio)]
        multipliers = np.linspace(getattr(self, "mult_lo", 0.68),
                                  getattr(self, "mult_hi", 1.0),
                                  getattr(self, "num_dog", 1))
        return [_gauss_um(vol, base_r * m) - _gauss_um(vol, base_r * m * ratio)
                for m in multipliers]

    def _dog(self, vol: np.ndarray, base_r: float = None) -> np.ndarray:
        dogs = self._scale_dogs(vol, base_r)
        if len(dogs) == 1:
            return dogs[0]
        if getattr(self, "per_scale_norm", False) and self._scales is not None:
            dogs = [d / max(s, 1e-12) for d, s in zip(dogs, self._scales)]
            w = getattr(self, "_band_weights", None)
            if w is not None and len(w) == len(dogs):
                dogs = [d * float(wi) for d, wi in zip(dogs, w)]
        return np.maximum.reduce(dogs)

    def _compute_band_stats(self, n_sample: int = 12) -> dict:
        """Label-free per-band detection stats over sampled frames: mean count,
        std (→ cross-frame consistency), and a weight = mean_count · consistency
        renormalised so the dominant band is 1.  ``psn_weighted`` then applies
        these weights, suppressing noisy/sparse bands.  Also the raw material for
        predicting quality without the evaluator."""
        nb = max(int(getattr(self, "num_dog", 1)), 1)
        if nb <= 1:
            return {}
        floor = float(getattr(self, "value_floor", 0.02))
        nt = self.volume.nt
        frames = np.unique(np.linspace(0, nt - 1, min(n_sample, nt)).astype(int))
        counts = np.zeros((len(frames), nb))
        for fi, t in enumerate(frames):
            probs = self._scale_probs_raw(self.volume.frame(t))
            for i in range(nb):
                b = probs[i]
                lm = (b == ndi.maximum_filter(b, size=3)) & (b > floor)
                counts[fi, i] = int(lm.sum())
        mean = counts.mean(0)
        std = counts.std(0)
        cv = std / np.maximum(mean, 1e-9)
        consistency = 1.0 / (1.0 + cv)
        raw = mean * consistency
        weights = raw / max(float(raw.max()), 1e-9)
        self._band_stats = dict(
            mean_count=[round(float(x), 1) for x in mean],
            std_count=[round(float(x), 1) for x in std],
            consistency=[round(float(x), 3) for x in consistency],
            weights=[round(float(x), 3) for x in weights])
        if getattr(self, "psn_weighted", False):
            self._band_weights = weights
        return self._band_stats

    def _scale_probs_raw(self, vol: np.ndarray, base_r: float = None) -> np.ndarray:
        """Per-band probs WITHOUT the psn weights (for computing the weights)."""
        w, self._band_weights = self._band_weights, None
        try:
            return self._scale_probs(vol, base_r)
        finally:
            self._band_weights = w

    def _normalize(self, dog: np.ndarray) -> np.ndarray:
        return np.clip(dog / max(getattr(self, "_scale", 1e-12), 1e-12), 0.0, 1.0)

    def _scale_probs(self, vol: np.ndarray, base_r: float = None) -> np.ndarray:
        """Per-band normalised probabilities, shape (n_bands, Z, Y, X).

        Their max over bands is the pooled value ``_dog``+``_normalize`` gives;
        their **argmax is the size band** — which DoG scale a cell responds to
        most, i.e. how big it is.  Cheap size attribution for the same scales
        the field is already built from."""
        dogs = self._scale_dogs(vol, base_r)
        sc = max(getattr(self, "_scale", 1e-12), 1e-12)
        if len(dogs) == 1:
            return np.clip(dogs[0] / sc, 0.0, 1.0)[None]
        if getattr(self, "per_scale_norm", False) and self._scales is not None:
            bands = [np.clip(d / max(s, 1e-12), 0.0, 1.0)
                     for d, s in zip(dogs, self._scales)]
        else:
            bands = [np.clip(d / sc, 0.0, 1.0) for d in dogs]
        w = getattr(self, "_band_weights", None)
        if w is not None and len(w) == len(bands):
            bands = [b * float(wi) for b, wi in zip(bands, w)]
        return np.stack(bands, 0)

    def _convex_mask(self, vol: np.ndarray) -> np.ndarray:
        """1.0 where the intensity Hessian is negative-definite (convex bright
        blob), 0.0 at saddles/ridges — Sylvester's criterion, no eigensolve."""
        sig = tuple(self.inner_um / VOXEL_SCALE)
        d = lambda o: ndi.gaussian_filter(vol, sigma=sig, order=o, mode="nearest")
        Hzz, Hyy, Hxx = d((2, 0, 0)), d((0, 2, 0)), d((0, 0, 2))
        Hzy, Hzx, Hyx = d((1, 1, 0)), d((1, 0, 1)), d((0, 1, 1))
        m2 = Hzz * Hyy - Hzy ** 2
        det3 = (Hzz * (Hyy * Hxx - Hyx ** 2) - Hzy * (Hzy * Hxx - Hyx * Hzx)
                + Hzx * (Hzy * Hyx - Hyy * Hzx))
        convex = (Hzz < 0) & (m2 > 0) & (det3 < 0)
        if not CONVEX_GRADED:
            return convex.astype(np.float32)
        # graded: normalised |det Hessian| (peaks at blob centre) within convex
        doh = np.where(convex, -det3, 0.0)
        pos = doh[doh > 0]
        norm = np.percentile(pos, 99.0) if pos.size else 1.0
        return np.clip(doh / max(norm, 1e-12), 0.0, 1.0).astype(np.float32)

    def _frame(self, t: int) -> np.ndarray:
        """Frame t, normalised, with a two-frame rolling cache."""
        if t not in self._raw:
            self._raw[t] = self.volume.frame(t)
            for k in list(self._raw):
                if k < t - 1:
                    del self._raw[k]
        return self._raw[t]

    def _calibrate(self) -> float:
        """One global scale so a Field value means the same in every frame.

        With ``per_scale_norm`` each DoG scale gets its own p99.9 (stored in
        ``self._scales``) so it is normalised independently before max-pooling;
        the returned global scale is then 1.0."""
        frames = [self._frame(t) for t in
                  (0, self.volume.nt // 2, self.volume.nt - 1)]
        if getattr(self, "per_scale_norm", False) and getattr(self, "num_dog", 1) > 1:
            n = self.num_dog
            acc = np.zeros(n)
            for f in frames:
                for i, d in enumerate(self._scale_dogs(f)):
                    acc[i] += np.percentile(d, 99.9)
            self._scales = np.maximum(acc / len(frames), 1e-6)
            log.info("  Per-scale DoG p99.9: "
                     f"{[round(float(x), 4) for x in self._scales]}")
            return 1.0
        vals = [np.percentile(self._dog(f), 99.9) for f in frames]
        s = float(max(np.mean(vals), 1e-6))
        log.info(f"  Probability scale (p99.9 of DoG): {s:.4f}")
        return s

    def frame(self, t: int) -> np.ndarray:
        """The base Probability Frame at t, in [0, 1], shape (Z, Y, X)."""
        p = self._normalize(self._dog(self._frame(t)))
        if CONVEX_BONUS != 0.0:
            src = self._dog(self._frame(t)) if CONVEX_ON_DOG else self._frame(t)
            p = np.clip(p + CONVEX_BONUS * self._convex_mask(src), 0.0, 1.0)
        return p.astype(np.float32)


class ProbabilitiesEnhanced(Probabilities):
    """Temporally-coherent probability field parameters (V2.5)."""

    def __init__(self, volume, transforms: Transforms,
                 inner_um: float = DOG_INNER_UM,
                 ratio: float = DOG_RATIO,
                 sensitivity: float = 0.6,
                 temporal_radius: int = 2,
                 center_weight: float = 1.0,
                 num_dog: int = 1,
                 mult_lo: float = 0.68, mult_hi: float = 1.0,
                 per_scale_norm: bool = False, psn_weighted: bool = False):
        super().__init__(volume, transforms,
                         inner_um=inner_um * sensitivity, ratio=ratio,
                         num_dog=num_dog, mult_lo=mult_lo, mult_hi=mult_hi,
                         per_scale_norm=per_scale_norm)
        self.psn_weighted = psn_weighted
        self.sensitivity = sensitivity
        self.temporal_radius = temporal_radius
        self.center_weight = center_weight
# ── Field ────────────────────────────────────────────────────────────────────

@dataclass
class Field:
    """The Space Time Field: a value in [0,1] at every (t, i, j, k).

    The grid is drawn once as ``n³`` cubes of ``spacing`` µm covering the
    field of view, then pushed forward frame by frame through the
    Transforms, so Field Cell (i, j, k) follows the same piece of tissue
    for the whole video.  That is what makes rule 2 mean what it says: a
    cell that only moves with the tissue does not move in the Field at
    all, and ``|Δijk|`` is residual motion, already tissue-corrected.
    """

    values: np.ndarray            # (T, n, n, n) float32, in [0, 1]
    positions: np.ndarray         # (T, n, n, n, 3) float32, µm, camera frame
    in_view: np.ndarray           # (T, n, n, n) bool
    spacing_um: float
    n: int
    jac_min: np.ndarray = dc_field(default_factory=lambda: np.zeros(0))
    offsets: np.ndarray | None = None    # (T, n, n, n, 3) µm, centre → centroid
    size_band: np.ndarray | None = None  # (T, n, n, n) uint8, argmax DoG scale

    @property
    def nt(self) -> int:
        return self.values.shape[0]

    @property
    def centroids(self) -> np.ndarray:
        """Cube centres moved onto the Probability's centre of mass.

        A Field Cell centre is quantised to one 3.25µm cube and the metric
        matches at 7µm, so this is worth reporting -- but it is strictly a
        report.  The Graph, the rules and the flow have all already run on
        Field values alone; nothing here feeds back into which path won.
        """
        if self.offsets is None:
            return self.positions
        return self.positions + self.offsets

    @property
    def levels(self) -> np.ndarray:
        """The values packed to uint4, the Field Cell as specified.

        Kept as a view on the float, not as the storage: the flow's costs
        want the full precision, and 13 MB of float32 is not worth
        quantising away.  ``quantise=True`` at build time makes the
        packed value the one the solver sees, which is the memory-first
        reading of the specification.
        """
        return np.clip(np.rint(self.values * 15.0), 0, 15).astype(np.uint8)

    @classmethod
    def build(cls, volume, transforms: Transforms,
              probabilities: "Probabilities", n: int = GRID_N,
              supersample: int = SUPERSAMPLE, quantise: bool = False,
              progress=None, compute_offsets: bool = True,
              compute_size: bool = False) -> "Field":
        import os
        from concurrent.futures import ThreadPoolExecutor

        shape = np.array(volume.spatial_shape)
        fov = shape * VOXEL_SCALE
        spacing = float(fov[0] / n)
        if not np.allclose(fov / n, spacing, rtol=1e-3):
            log.warning(f"  Field of view {fov} is not cubic; spacing taken "
                        f"from z as {spacing:.4f}µm")
        log.info(f"  Field: {n}³ cells of {spacing:.4f}µm "
                 f"(field of view {fov[0]:.1f}µm)")

        nt = volume.nt
        values = np.zeros((nt, n, n, n), np.float32)
        positions = np.zeros((nt, n, n, n, 3), np.float32)
        offsets_out = np.zeros((nt, n, n, n, 3), np.float32)
        in_view = np.zeros((nt, n, n, n), bool)
        jac_min = np.zeros(nt, np.float32)

        # ── Loop-invariant setup ─────────────────────────────────────────
        # The grid stays at rest, so positions, Jacobian, inside mask, and
        # centre index are all constant across frames.

        ax = (np.arange(n) + 0.5) * spacing
        rest = np.stack(np.meshgrid(ax, ax, ax, indexing="ij"), -1)
        p = rest.astype(np.float64)           # (n, n, n, 3) — rest grid

        # Supersample offsets inside the unit cube, in rest µm.
        k = max(int(supersample), 1)
        o = (np.arange(k) + 0.5) / k - 0.5
        ss_offsets = np.stack(np.meshgrid(o, o, o, indexing="ij"), -1
                              ).reshape(-1, 3) * spacing

        box = np.maximum(np.round(spacing / VOXEL_SCALE).astype(int), 1)
        box_shift = (box // 2) - (box - 1) / 2.0
        log.info(f"  Probability box filter {tuple(box)} voxels "
                 f"= {tuple(np.round(box * VOXEL_SCALE, 2))}µm")

        # Jacobian: constant on the rest grid (diagonal, spacing per axis).
        J = np.stack(np.gradient(p, axis=(0, 1, 2)), axis=-1)     # (n,n,n,3,3)
        det = np.linalg.det(J) / spacing ** 3
        rest_jac_min = float(det.min())

        # Sample positions for supersampling and centroid, constant.
        ss_queries = []
        for off in ss_offsets:
            d = J @ (off / spacing)
            q = (p + d) / VOXEL_SCALE + box_shift
            ss_queries.append(np.moveaxis(q, -1, 0).astype(np.float32))
        centre_idx = np.moveaxis(p / VOXEL_SCALE + box_shift, -1, 0
                                 ).astype(np.float32)
        inside = np.all((p >= 0) & (p <= (shape - 1) * VOXEL_SCALE), -1)
        node_pts_um = p.reshape(-1, 3)

        # Fill constant arrays.
        positions[:] = p.astype(np.float32)
        in_view[:] = inside
        jac_min[:] = rest_jac_min

        n_workers = min(os.cpu_count() or 4, 8)
        # ── Phase 1: pre-compute all probability frames (parallel) ─────
        # By-passing the rolling cache to safely thread this.
        # Each frame is ~40ms (DoG).  For 100 frames: ~4s.
        log.info(f"  Pre-computing {nt} probability frames ...")

        # psn-weighted: derive per-band weights from label-free count/consistency
        # stats BEFORE the field is filled, so the weights apply to every frame.
        if getattr(probabilities, "psn_weighted", False):
            st = probabilities._compute_band_stats()
            if st:
                log.info(f"  psn-weighted bands: count {st['mean_count']} "
                         f"(±{st['std_count']}), consistency {st['consistency']} "
                         f"→ weights {st['weights']}")

        # Dynamic DoG Normalization
        if getattr(probabilities, "dynamic_dog", False):
            log.info("  Calculating dynamic per-frame DoG spatial radii...")
            import scipy.optimize
            
            def _get_baseline_peaks(t: int):
                dog = probabilities._dog(volume.frame(t))
                lm = dog == ndi.maximum_filter(dog, size=3)
                peaks = dog[lm & (dog > 0)]
                peaks.sort()
                return peaks
                
            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                all_baseline_peaks = list(pool.map(_get_baseline_peaks, range(nt)))
                
            base_scale = probabilities._scale
            value_floor = getattr(probabilities, "value_floor", 0.02)
            raw_threshold = base_scale * value_floor
            
            raw_counts = np.array([np.sum(p >= raw_threshold) for p in all_baseline_peaks], dtype=float)
            target_counts = ndi.gaussian_filter1d(raw_counts, sigma=2.0)
            target_counts = np.clip(np.round(target_counts).astype(int), 1, [len(p) for p in all_baseline_peaks])
            
            ratio = probabilities.outer_um / probabilities.inner_um
            
            def _optimize_radius_for_frame(t: int):
                vol = volume.frame(t)
                target = target_counts[t]
                
                def objective(r):
                    dog = probabilities._dog(vol, base_r=r)
                    lm = dog == ndi.maximum_filter(dog, size=3)
                    peaks = dog[lm & (dog > 0)]
                    count = np.sum(peaks >= raw_threshold)
                    return abs(count - target)
                    
                res = scipy.optimize.minimize_scalar(objective, bounds=(1.0, 3.0), method='bounded', options={'xatol': 0.1})
                best_r = float(res.x)
                
                best_dog = probabilities._dog(vol, base_r=best_r)
                
                p = probabilities._normalize(best_dog)
                if CONVEX_BONUS != 0.0:
                    src = best_dog if CONVEX_ON_DOG else vol
                    sig = tuple(best_r / VOXEL_SCALE)
                    d = lambda o: ndi.gaussian_filter(src, sigma=sig, order=o, mode="nearest")
                    Hzz, Hyy, Hxx = d((2, 0, 0)), d((0, 2, 0)), d((0, 0, 2))
                    Hzy, Hzx, Hyx = d((1, 1, 0)), d((1, 0, 1)), d((0, 1, 1))
                    m2 = Hzz * Hyy - Hzy ** 2
                    det3 = (Hzz * (Hyy * Hxx - Hyx ** 2) - Hzy * (Hzy * Hxx - Hyx * Hzx)
                            + Hzx * (Hzy * Hyx - Hyy * Hzx))
                    convex = (Hzz < 0) & (m2 > 0) & (det3 < 0)
                    mask = convex.astype(np.float32)
                    if CONVEX_GRADED:
                        doh = np.where(convex, -det3, 0.0)
                        pos = doh[doh > 0]
                        norm = np.percentile(pos, 99.0) if pos.size else 1.0
                        mask = np.clip(doh / max(norm, 1e-12), 0.0, 1.0).astype(np.float32)
                    
                    p = np.clip(p + CONVEX_BONUS * mask, 0.0, 1.0)
                return p.astype(np.float32)

            log.info("  Optimizing spatial radii for probability frames...")
            _get_prob = _optimize_radius_for_frame
            del all_baseline_peaks
        else:
            def _get_prob(t: int) -> np.ndarray:
                raw = volume.frame(t)
                dog = probabilities._dog(raw)
                p = probabilities._normalize(dog)
                if CONVEX_BONUS != 0.0:
                    src = dog if CONVEX_ON_DOG else raw
                    p = np.clip(p + CONVEX_BONUS * probabilities._convex_mask(src), 0.0, 1.0)
                return p.astype(np.float32)

        # ── Phase 1 & 2: per-frame probability + prefilter + moments + supersample (parallel)
        # scipy.ndimage releases the GIL: ThreadPoolExecutor gives real
        # parallelism without serialisation overhead. Memory is bounded by n_workers.
        
        # Limit workers tightly to cap RAM usage during concurrent Gaussian filters
        n_workers_capped = min(n_workers, 4)

        # Per-frame output stored as arrays indexed by t.
        all_prefiltered: list[np.ndarray | None] = [None] * nt
        all_base_values: list[np.ndarray | None] = [None] * nt
        all_centroid_off: list[np.ndarray | None] = [None] * nt
        all_size: list[np.ndarray | None] = [None] * nt

        def _process_frame(t: int) -> None:
            prob_t = _get_prob(t)
            if compute_size:
                # Size = which DoG band responds most, sampled onto the grid at
                # the cell centres (nearest — it's a categorical label).
                sp = probabilities._scale_probs(volume.frame(t))
                size_vox = sp.argmax(0).astype(np.float32)
                all_size[t] = ndi.map_coordinates(
                    size_vox, centre_idx, order=0).astype(np.uint8)
            pref = ndi.uniform_filter(prob_t, size=tuple(box), mode="nearest")
            all_prefiltered[t] = pref

            # Supersampled base values.
            acc = np.zeros((n, n, n), np.float32)
            for sq in ss_queries:
                acc += _sample(pref, sq)
            all_base_values[t] = acc / len(ss_queries)

            # Centroid offset: first moment / zeroth moment.  Only --refine and
            # --continuous-centroids read it; skip the 3 box-moments + samples
            # otherwise (offsets=None then falls back to the grid centre).
            if compute_offsets:
                moms = [_box_moment(prob_t, box, a) for a in range(3)]
                denom = np.maximum(_sample(pref, centre_idx), 1e-8)
                off_um = np.stack([_sample(moms[a], centre_idx) / denom
                                   * VOXEL_SCALE[a] for a in range(3)], -1)
                all_centroid_off[t] = np.clip(off_um, -spacing / 2, spacing / 2)

        log.info(f"  Computing {nt} probability frames + prefiltering (capped {n_workers_capped} workers)...")
        with ThreadPoolExecutor(max_workers=n_workers_capped) as pool:
            futures = [pool.submit(_process_frame, t) for t in range(nt)]
            for i, fut in enumerate(futures):
                fut.result()                  # raises if the worker threw
                if progress:
                    progress.update(1, f"jac min {rest_jac_min:+.2f}")

        if compute_offsets:
            offsets_out[:] = np.array(all_centroid_off)    # (T, n, n, n, 3)
        else:
            offsets_out = None
        size_band_out = (np.array(all_size, dtype=np.uint8)
                         if compute_size else None)

        # ── Phase 3: temporal blending (sequential, uses pre-computed) ────
        # Temporal blending needs prefiltered volumes from neighbour frames
        # and the transform chain, so it stays sequential.

        is_enh = hasattr(probabilities, "temporal_radius")
        temp_rad = getattr(probabilities, "temporal_radius", 0)

        # Drift-tolerant sampling: max-pool over expected drift.
        pool_cache: dict[tuple[int, int], np.ndarray] = {}

        def pooled(t_nbr: int, dt: int) -> np.ndarray:
            key = (t_nbr, dt)
            if key not in pool_cache:
                pref = all_prefiltered[t_nbr]
                r_vox = np.round(DRIFT_PER_HOP_UM * dt / VOXEL_SCALE).astype(int)
                size = tuple(int(s) for s in np.maximum(2 * r_vox + 1, 1))
                pool_cache[key] = (ndi.maximum_filter(pref, size=size,
                                                      mode="nearest")
                                   if max(size) > 1 else pref)
            return pool_cache[key]

        for t in range(nt):
            base_values = all_base_values[t]

            if is_enh:
                cw = getattr(probabilities, "center_weight", 1.0)
                mode = getattr(probabilities, "temporal_mode", "symmetric")
                base = base_values.ravel()
                back, back_w, fwd, fwd_w = [], [], [], []   # directional split
                for dt in range(1, temp_rad + 1):
                    w_dt = TEMPORAL_DECAY ** dt
                    for t_nbr in (t - dt, t + dt):
                        if 0 <= t_nbr < nt:
                            pts_cur = node_pts_um
                            step = 1 if t_nbr > t else -1
                            t_cur = t
                            valid = True
                            for _ in range(abs(t_nbr - t)):
                                t_next = t_cur + step
                                if step == 1 and t_cur < len(transforms):
                                    pts_cur = transforms[t_cur].forward(pts_cur)
                                elif step == -1 and t_next < len(transforms):
                                    pts_cur = transforms[t_next].inverse(pts_cur)
                                else:
                                    valid = False
                                    break
                                t_cur = t_next

                            if valid:
                                q = pts_cur / VOXEL_SCALE + box_shift
                                pref_nbr = pooled(t_nbr, dt)
                                sampled = np.clip(
                                    _sample(pref_nbr, np.moveaxis(q, -1, 0)), 0.0, None)
                                if t_nbr < t:
                                    back.append(sampled); back_w.append(w_dt)
                                else:
                                    fwd.append(sampled); fwd_w.append(w_dt)

                def _geomean(cs, ws):
                    tw = float(sum(ws))
                    prod = np.ones_like(base)
                    for w, c in zip(ws, cs):
                        prod = prod * (c if w == 1.0 else np.power(c, w))
                    return np.power(np.clip(prod, 0.0, None), 1.0 / tw)

                if mode == "directional":
                    # A cell should score on its best contiguous run through the
                    # present: max(past+present, present+future).  This keeps
                    # births (division daughters, cells entering view) and deaths,
                    # while true single-frame flicker still fails both sides.
                    b = _geomean([base] + back, [cw] + back_w)
                    f = _geomean([base] + fwd, [cw] + fwd_w)
                    blended = np.maximum(b, f)
                else:                                   # symmetric (default)
                    blended = _geomean([base] + back + fwd,
                                       [cw] + back_w + fwd_w)
                values[t] = np.clip(blended, 0.0, 1.0).reshape((n, n, n))
            else:
                contributors = [base_values.ravel()]
                t_nbr = t + 1
                if 0 <= t_nbr < nt and t < len(transforms):
                    pts_cur = transforms[t].forward(node_pts_um)
                    q = pts_cur / VOXEL_SCALE + box_shift
                    pref_nbr = all_prefiltered[t_nbr]
                    sampled = _sample(pref_nbr, np.moveaxis(q, -1, 0))
                    contributors.append(np.clip(sampled, 0.0, None))

                blended = sum(contributors) / len(contributors)
                values[t] = np.clip(blended, 0.0, 1.0).reshape((n, n, n))

            values[t][~inside] = 0.0

            # Free memory for frames we no longer need.
            # We never look back further than t - temp_rad (or t for non-enhanced).
            safe_to_drop = t - max(temp_rad, 0) - 1
            if safe_to_drop >= 0:
                all_prefiltered[safe_to_drop] = None
                keys_to_del = [k for k in pool_cache if k[0] == safe_to_drop]
                for k in keys_to_del:
                    del pool_cache[k]

        # Free pre-computed arrays.
        del all_prefiltered, all_base_values, all_centroid_off
        pool_cache.clear()

        if progress:
            progress.done()

        folds = int((jac_min <= 0).sum())
        if folds:
            log.warning(f"  Jacobian determinant went non-positive in {folds} "
                        f"frame(s): the deformed cells overlap there, which "
                        f"injects motion the rules will read as real")
        else:
            log.info(f"  Jacobian determinant stayed positive in every frame "
                     f"(min {jac_min.min():.3f}) — the deformed cells tile")

        f = cls(values=values, positions=positions, in_view=in_view,
                spacing_um=spacing, n=n, jac_min=jac_min,
                offsets=offsets_out, size_band=size_band_out)
        if offsets_out is not None:
            moved = np.linalg.norm(offsets_out[in_view], axis=-1)
            log.info(f"  Centre of mass inside the cube: median "
                     f"{np.median(moved):.2f}µm, p90 {np.percentile(moved, 90):.2f}µm")
        if quantise:
            f.values = (f.levels.astype(np.float32) / 15.0)
            log.info("  Field packed to uint4; the solver sees the packed value")
        return f

    def save(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, values=self.values,
                            positions=self.positions, in_view=self.in_view,
                            spacing_um=np.float32(self.spacing_um),
                            n=np.int32(self.n), jac_min=self.jac_min,
                            offsets=(self.offsets if self.offsets is not None
                                     else np.zeros(0, np.float32)),
                            size_band=(self.size_band if self.size_band is not None
                                       else np.zeros(0, np.uint8)))
        return path

    @classmethod
    def load(cls, path: Path) -> "Field":
        z = np.load(path)
        off = z["offsets"] if "offsets" in z else np.zeros(0, np.float32)
        sz = z["size_band"] if "size_band" in z else np.zeros(0, np.uint8)
        return cls(values=z["values"], positions=z["positions"],
                   in_view=z["in_view"], spacing_um=float(z["spacing_um"]),
                   n=int(z["n"]), jac_min=z["jac_min"],
                   offsets=off if off.size else None,
                   size_band=sz if sz.size else None)

    def optimize(self, evaluate_fn, iters: int = 3, samples: int = 20,
                 sigma: float = 0.05, alpha: float = 0.1, lam: float = 0.5,
                 global_field: bool = False, transforms=None, window: int = 0,
                 trust_eps: float = 0.0, antithetic: bool = False,
                 node_penalty: float = 0.0) -> None:
        """Zeroth-Order Optimization (ES) of the Field values.

        Uses finite differences / REINFORCE to iteratively update the field values,
        treating the MILP solver score as a black-box reward. Uses Adam for stable updates.

        The same small CNN parameterises the edit either way; only its reach
        changes.  By default it is applied to the 8 most uncertain local
        regions.  With ``global_field=True`` the identical CNN is applied to
        every frame of the whole video, giving each of its ~221 weights far
        more leverage on the MILP score (and, symmetrically, making a uniform
        "inflate everything" cheat easier — watch held-out accuracy, not just
        the reward).

        Args:
            evaluate_fn: Callback that takes a Field and returns the MILP score.
            iters: Number of gradient steps.
            samples: Number of noise samples per step.
            sigma: Standard deviation of the Gaussian noise.
            alpha: Learning rate.
            lam: L2 penalty for deviating from the base field (regularization).
            global_field: Apply the CNN to the entire video instead of the 8
                most-uncertain local regions.
            transforms: The video's Transforms, needed to score windowed
                sub-clips (passed straight through to ``evaluate_fn``).
            window: Phase-1 speed knob. If >0 (and ``global_field``), each ES
                step scores its samples on a random run of ``window``
                consecutive frames instead of the whole video — the CNN is a
                per-frame spatial filter, so a window is an unbiased minibatch.
                Small windows keep every MILP solve tiny and fast.
            trust_eps: Per-voxel trust region. Each candidate value is clamped
                to ``base ± trust_eps`` *before* the solve, so the field can
                never drift into a "fake" probability map — and, because the
                node/edge topology then stays near the base field's, the LP
                never blows up. 0 disables (soft L2 only).
            antithetic: Draw half the perturbations and mirror them (±noise
                pairs) to halve the gradient-estimate variance. Needs an even
                ``samples``.
            node_penalty: Phase-2 anti-gaming guard. The MILP score is value-
                dominated, so the cheapest way to raise it is to roughen the
                field and manufacture spurious local maxima — each new node
                earns ``lambda_value·value`` for free. Subtracting
                ``node_penalty`` per graph node removes that incentive: a node
                only pays for itself if its value exceeds ``node_penalty``, so
                the CNN is pushed to sharpen/re-weight real cells instead of
                inventing false positives. (The absolute count is used; the ES
                baseline subtraction turns it into a penalty on node *growth*.)
        """
        import time
        from concurrent.futures import ThreadPoolExecutor
        import os
        import torch
        import torch.nn as nn

        # Define the parameterization network
        class FieldFilter(nn.Module):
            def __init__(self):
                super().__init__()
                self.conv1 = nn.Conv3d(1, 4, kernel_size=3, padding=1)
                self.relu = nn.ReLU()
                self.conv2 = nn.Conv3d(4, 1, kernel_size=3, padding=1)
                
                # Initialize to zero so the initial residual is 0
                nn.init.zeros_(self.conv1.weight)
                nn.init.zeros_(self.conv1.bias)
                nn.init.zeros_(self.conv2.weight)
                nn.init.zeros_(self.conv2.bias)

            def forward(self, x):
                residual = self.conv1(x)
                residual = self.relu(residual)
                residual = self.conv2(residual)
                return torch.clamp(x + residual, 0.0, 1.0)

        # Setup model and base data
        model = FieldFilter()
        device = torch.device('cpu') # Fast enough for 200 params and few samples
        model.to(device)

        base_values = self.values.copy()

        # 0. Choose the CNN's reach: the whole video, or the 8 most uncertain
        #    local regions.  Either way it is expressed as a list of index
        #    tuples so the rest of the routine is identical.
        if global_field:
            regions = [(slice(None), slice(None), slice(None), slice(None))]
            log.info("  Global mode: applying CNN across the entire video field "
                     f"({base_values.size:,} voxels).")
        else:
            # Find the 8 most uncertain 8x16x16x16 regions
            import scipy.ndimage
            uncertainty = base_values * (1.0 - base_values)
            shape = (8, 16, 16, 16)
            smoothed = scipy.ndimage.uniform_filter(uncertainty, size=shape, mode='constant', cval=0.0)

            regions = []
            mask = np.ones_like(smoothed, dtype=bool)
            for _ in range(8):
                masked_smoothed = smoothed * mask
                if masked_smoothed.max() == 0:
                    break

                idx = np.unravel_index(np.argmax(masked_smoothed), masked_smoothed.shape)

                t_start = max(0, idx[0] - shape[0]//2)
                t_end = min(base_values.shape[0], idx[0] + shape[0]//2 + shape[0]%2)
                z_start = max(0, idx[1] - shape[1]//2)
                z_end = min(base_values.shape[1], idx[1] + shape[1]//2 + shape[1]%2)
                y_start = max(0, idx[2] - shape[2]//2)
                y_end = min(base_values.shape[2], idx[2] + shape[2]//2 + shape[2]%2)
                x_start = max(0, idx[3] - shape[3]//2)
                x_end = min(base_values.shape[3], idx[3] + shape[3]//2 + shape[3]%2)

                mask[t_start:t_end, z_start:z_end, y_start:y_end, x_start:x_end] = False
                regions.append((slice(t_start, t_end), slice(z_start, z_end), slice(y_start, y_end), slice(x_start, x_end)))

            log.info(f"  Targeting {len(regions)} highly uncertain regions for optimization.")
        
        # The 8-region path edits fixed 4-D crops; the global path runs the
        # CNN over a (possibly windowed) run of whole frames.
        region_tensors = None if global_field else [
            torch.from_numpy(base_values[r]).unsqueeze(1).to(device) for r in regions]

        # Flatten parameters
        def get_weights(m):
            return torch.cat([p.data.view(-1) for p in m.parameters()]).numpy()

        def set_weights(m, w):
            idx = 0
            for p in m.parameters():
                n_el = p.numel()
                p.data.copy_(torch.from_numpy(w[idx:idx + n_el]).view_as(p))
                idx += n_el

        theta = get_weights(model)
        dim = theta.size
        n_workers = min(os.cpu_count() or 4, samples)

        T = base_values.shape[0]
        minibatch = bool(global_field and window and 0 < window < T)
        if window and not global_field:
            log.warning("  --opt-window needs --opt-global; ignoring the window.")
        if window and global_field and transforms is None:
            log.warning("  --opt-window needs transforms; scoring the full video.")
            minibatch = False

        def make_field(values, fr):
            """A Field over frames `fr`, sharing the static geometry arrays."""
            return Field(values=values,
                         positions=self.positions[fr],
                         in_view=self.in_view[fr],
                         spacing_um=self.spacing_um, n=self.n,
                         jac_min=self.jac_min,
                         offsets=None if self.offsets is None else self.offsets[fr])

        def slice_transforms(start, length):
            if transforms is None or length >= T:
                return transforms
            # window frames 0..length-1 → pairs 0..length-2 → global start..
            return Transforms(transforms.transforms[start:start + length - 1],
                              nt=length)

        def apply_cnn(weights, fr):
            """Run the CNN over frames `fr`, clamped into the trust region."""
            local = FieldFilter().to(device)
            set_weights(local, weights)
            base_fr = base_values[fr]
            with torch.no_grad():
                out = local(torch.from_numpy(base_fr).unsqueeze(1).to(device))
                out = out.squeeze(1).numpy()
            if trust_eps > 0.0:
                out = np.clip(out, base_fr - trust_eps, base_fr + trust_eps)
            return np.clip(out, 0.0, 1.0)

        # Antithetic sampling: draw half the perturbations and mirror them.
        use_anti = antithetic and samples % 2 == 0
        if antithetic and not use_anti:
            log.warning("  antithetic needs an even --opt-samples; using plain sampling")

        def draw_noises():
            if use_anti:
                half = [np.random.normal(0, sigma, dim).astype(np.float32)
                        for _ in range(samples // 2)]
                return half + [-h for h in half]
            return [np.random.normal(0, sigma, dim).astype(np.float32)
                    for _ in range(samples)]

        log.info(f"  Starting CNN ES: {iters} iters, {samples} samples/iter, "
                 f"sigma={sigma}, alpha={alpha}, lambda={lam}, params={dim}"
                 + (f", window={window}f/{T}" if minibatch else "")
                 + (f", trust=±{trust_eps}" if trust_eps > 0 else "")
                 + (", antithetic" if use_anti else ""))

        # Adam state
        m = np.zeros_like(theta)
        v = np.zeros_like(theta)
        beta1, beta2, eps = 0.9, 0.999, 1e-8

        for i in range(iters):
            t0 = time.time()
            noises = draw_noises()

            # Pick this iteration's minibatch window — shared by all samples so
            # reward differences reflect the weights, not window difficulty.
            w0, fr, win_tf, win_len = 0, slice(None), transforms, T
            if minibatch:
                w0 = int(np.random.randint(0, T - window + 1))
                fr, win_tf, win_len = slice(w0, w0 + window), \
                    slice_transforms(w0, window), window

            # 1. Build candidate fields (CNN forward on CPU, sequential).
            test_values_list = []
            for k in range(samples):
                if global_field:
                    test_values_list.append(apply_cnn(theta + noises[k], fr))
                else:
                    local_model = FieldFilter().to(device)
                    set_weights(local_model, theta + noises[k])
                    hyb = base_values.copy()
                    with torch.no_grad():
                        for j, r in enumerate(regions):
                            hyb[r] = local_model(region_tensors[j]).squeeze(1).numpy()
                    if trust_eps > 0.0:
                        hyb = np.clip(hyb, base_values - trust_eps,
                                      base_values + trust_eps)
                    test_values_list.append(hyb)

            base_ref = base_values[fr] if global_field else base_values

            # 2. Score one sample: windowed field + windowed transforms, minus
            #    the soft L2 drift penalty.
            def _eval_milp(k: int) -> float:
                vals = test_values_list[k]
                fld = make_field(vals, fr) if global_field else make_field(
                    vals, slice(None))
                result = evaluate_fn(fld, win_tf if global_field else transforms)
                score, n_nodes = result if isinstance(result, tuple) else (result, 0)
                l2 = float(np.sum((vals - base_ref) ** 2))
                return score - (lam * l2) - (node_penalty * n_nodes)

            # 3. Evaluate in parallel (small windowed LPs no longer contend).
            rewards = np.zeros(samples, dtype=np.float32)
            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                futures = [pool.submit(_eval_milp, k) for k in range(samples)]
                for k, fut in enumerate(futures):
                    rewards[k] = fut.result()

            # Baseline + std normalisation (variance reduction).
            baseline = float(np.mean(rewards))
            std_reward = float(np.std(rewards)) + 1e-8
            normalized = (rewards - baseline) / std_reward

            # Gradient: 1/(N·sigma²) · Σ reward_k · noise_k
            grad = np.zeros_like(theta)
            for k in range(samples):
                grad += normalized[k] * noises[k]
            grad /= (samples * (sigma ** 2))

            # Adam step (ascending, we maximise reward).
            t = i + 1
            m = beta1 * m + (1 - beta1) * grad
            v = beta2 * v + (1 - beta2) * (grad ** 2)
            m_hat = m / (1 - beta1 ** t)
            v_hat = v / (1 - beta2 ** t)
            step = alpha * m_hat / (np.sqrt(v_hat) + eps)
            theta = theta + step

            win_note = f" win[{w0}:{w0 + win_len}]" if minibatch else ""
            log.info(f"  Iter {t}/{iters} [{time.time()-t0:.1f}s]{win_note}: "
                     f"Reward mean={baseline:.2f} "
                     f"(min={rewards.min():.2f}, max={rewards.max():.2f}), "
                     f"grad_norm={np.linalg.norm(grad):.2f}, "
                     f"step_norm={np.linalg.norm(step):.4f}")

        # Apply the trained CNN to the WHOLE field, trust-clamped.
        if global_field:
            self.values = apply_cnn(theta, slice(None))
        else:
            set_weights(model, theta)
            hyb = base_values.copy()
            with torch.no_grad():
                for j, r in enumerate(regions):
                    hyb[r] = model(region_tensors[j]).squeeze(1).numpy()
            if trust_eps > 0.0:
                hyb = np.clip(hyb, base_values - trust_eps, base_values + trust_eps)
            self.values = hyb
        log.info("  CNN ES optimization complete.")

    def optimize_residual(self, evaluate_fn, transforms=None,
                          iters: int = 60, samples: int = 16,
                          sigma: float = 0.02, alpha: float = 0.002,
                          trust: float = 0.03, drift_penalty: float = 0.05,
                          window: int = 8, validate_fn=None,
                          validate_every: int = 10, seed: int = 0) -> dict:
        """Learn a small additive tensor on the Field, scored by the MILP.

        A tiny 3-D CNN reads the base Field and emits a residual tensor
        ``Δ``; the candidate Field is ``base + Δ``.  ``Δ`` is bounded by a
        smooth ``trust · tanh`` rather than a hard clip, so it can never
        leave the trust region and the reward is never flat in the way a
        clip makes it (a clipped candidate returns the identical score for
        every perturbation that pushes past the bound, which reads to the
        optimiser as zero gradient).

        Three things differ from ``optimize`` and each is deliberate:

        * **The init is not all-zero.**  With both convolutions zeroed, the
          only weight that changes the output at first order is ``c2.bias``
          -- a single global brightness knob, 1 live parameter out of 221.
          Zeroing only the *last* layer keeps the map exactly the identity
          at step 0 while leaving 109 weights first-order live.
        * **The λ are frozen.**  ``Graph.auto_calibrate`` derives
          λ_termination and λ_distance from the candidate's own median node
          value, so left alone the objective moves with the thing being
          scored.  ``evaluate_fn`` is expected to pin them to the base
          Field's calibration.
        * **The drift penalty is a mean, not a sum.**  A summed penalty
          scales with grid size and window length, so the same coefficient
          means something different at 32³ and 64³.

        Args:
            evaluate_fn: ``(Field, Transforms) -> float``, the MILP score.
            transforms: the video's Transforms, sliced to each window.
            iters: ES steps.  Zeroth-order search over ~221 weights needs
                hundreds, not the 3 the older routine defaulted to.
            samples: perturbations per step; halved into ± pairs.
            sigma: perturbation scale.
            alpha: Adam step size.  Small by intent.
            trust: bound on |Δ| per voxel.
            drift_penalty: coefficient on ``mean((Δ/trust)²)``, which is 1
                when Δ sits at the bound everywhere and 0 at the base
                Field.  Scaled by the baseline score so it is dimensionless.
            window: frames per minibatch.  The CNN is a per-frame spatial
                filter, so a run of frames is an unbiased sample of it, and
                a short window keeps each MILP solve small.
            validate_fn: optional ``(Field) -> float`` on held-out truth,
                used to pick the returned weights.  Without it the ES
                reward picks them, which only measures the proxy.
            validate_every: run ``validate_fn`` this often.
            seed: RNG seed for the perturbations.

        Returns:
            History dict with per-iteration reward/drift and the validation
            trace, so reward and accuracy can be read against each other.
        """
        import os
        import time
        from concurrent.futures import ThreadPoolExecutor

        import torch
        import torch.nn as nn

        class Residual(nn.Module):
            def __init__(self):
                super().__init__()
                self.c1 = nn.Conv3d(1, 4, kernel_size=3, padding=1)
                self.c2 = nn.Conv3d(4, 1, kernel_size=3, padding=1)
                nn.init.kaiming_normal_(self.c1.weight, nonlinearity="relu")
                nn.init.zeros_(self.c1.bias)
                nn.init.zeros_(self.c2.weight)     # identity at step 0
                nn.init.zeros_(self.c2.bias)

            def forward(self, x):
                return self.c2(torch.relu(self.c1(x)))

        rng = np.random.default_rng(seed)
        torch.manual_seed(seed)
        net = Residual()
        base_values = self.values.copy()
        T = base_values.shape[0]

        def get_weights(m):
            return torch.cat([p.data.view(-1) for p in m.parameters()]).numpy()

        def set_weights(m, w):
            i = 0
            for p in m.parameters():
                n_el = p.numel()
                p.data.copy_(torch.from_numpy(
                    w[i:i + n_el].astype(np.float32)).view_as(p))
                i += n_el

        theta = get_weights(net).astype(np.float64)
        dim = theta.size
        # c1 is random, so the identity lives at c2 == 0, not at theta == 0.
        theta0 = theta.copy()

        minibatch = bool(window and 0 < window < T and transforms is not None)

        def make_field(values, fr):
            return Field(values=values, positions=self.positions[fr],
                         in_view=self.in_view[fr],
                         spacing_um=self.spacing_um, n=self.n,
                         jac_min=self.jac_min,
                         offsets=None if self.offsets is None
                         else self.offsets[fr])

        def slice_transforms(start, length):
            if transforms is None or length >= T:
                return transforms
            return Transforms(transforms.transforms[start:start + length - 1],
                              nt=length)

        def candidate(weights, fr):
            """The Field at these weights, and the tensor that was added."""
            local = Residual()
            set_weights(local, weights)
            base_fr = base_values[fr]
            x = torch.from_numpy(base_fr).unsqueeze(1)
            with torch.no_grad():
                delta = trust * torch.tanh(local(x))
                out = torch.clamp(x + delta, 0.0, 1.0)
            vals = out.squeeze(1).numpy()
            return vals, vals - base_fr        # realised Δ, after the clamp

        # Baseline score, to make drift_penalty dimensionless and to give
        # the reward trace an anchor.
        fr0 = slice(0, window) if minibatch else slice(None)
        base_score = float(evaluate_fn(
            make_field(base_values[fr0], fr0),
            slice_transforms(0, window) if minibatch else transforms))
        scale = abs(base_score) if base_score else 1.0

        n_workers = min(os.cpu_count() or 4, samples)
        half = samples // 2
        log.info(f"  Residual ES: {iters} iters x {samples} samples, "
                 f"sigma={sigma}, alpha={alpha}, trust=±{trust}, "
                 f"drift_penalty={drift_penalty}, params={dim}"
                 + (f", window={window}f/{T}" if minibatch else "")
                 + f"; baseline score {base_score:.1f}")

        m = np.zeros(dim)
        v = np.zeros(dim)
        beta1, beta2, eps = 0.9, 0.999, 1e-8
        hist = dict(iter=[], reward=[], milp=[], drift=[], val=[], val_iter=[])
        best = dict(theta=theta0.copy(), val=None, milp=None)

        for i in range(iters):
            t0 = time.time()
            noises = [rng.normal(0, sigma, dim) for _ in range(half)]
            noises += [-n for n in noises]          # antithetic pairs

            w0 = int(rng.integers(0, T - window + 1)) if minibatch else 0
            fr = slice(w0, w0 + window) if minibatch else slice(None)
            win_tf = (slice_transforms(w0, window) if minibatch else transforms)

            cands = [candidate(theta + n, fr) for n in noises]

            def score_one(k):
                vals, delta = cands[k]
                milp = float(evaluate_fn(make_field(vals, fr), win_tf))
                drift = float(np.mean((delta / trust) ** 2))
                return milp - drift_penalty * scale * drift, milp, drift

            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                out = list(pool.map(score_one, range(samples)))
            rewards = np.array([o[0] for o in out])
            milps = np.array([o[1] for o in out])
            drifts = np.array([o[2] for o in out])

            # Rank shaping: robust to the one sample that games the score,
            # which a mean/std normalisation would let dominate the step.
            order = np.argsort(np.argsort(rewards))
            shaped = order / (samples - 1.0) - 0.5

            grad = np.zeros(dim)
            for k in range(samples):
                grad += shaped[k] * noises[k]
            grad /= (samples * sigma)

            t = i + 1
            m = beta1 * m + (1 - beta1) * grad
            v = beta2 * v + (1 - beta2) * grad ** 2
            step = alpha * (m / (1 - beta1 ** t)) / (
                np.sqrt(v / (1 - beta2 ** t)) + eps)
            theta = theta + step

            hist["iter"].append(t)
            hist["reward"].append(float(rewards.mean()))
            hist["milp"].append(float(milps.mean()))
            hist["drift"].append(float(drifts.mean()))

            note = ""
            if validate_fn is not None and (t % validate_every == 0
                                            or t == iters):
                vals, _ = candidate(theta, slice(None))
                val = float(validate_fn(make_field(vals, slice(None))))
                hist["val"].append(val)
                hist["val_iter"].append(t)
                if best["val"] is None or val > best["val"]:
                    best.update(theta=theta.copy(), val=val,
                                milp=float(milps.mean()))
                note = f"  val={val:.4f}"

            log.info(f"  it {t:>3}/{iters} [{time.time() - t0:4.1f}s] "
                     f"milp={milps.mean():9.1f} "
                     f"(spread {milps.max() - milps.min():7.1f}) "
                     f"drift={drifts.mean():.3f} "
                     f"|step|={np.linalg.norm(step):.2e}{note}")

        # Without held-out truth the ES reward is the only thing that could
        # pick the weights, and that is the proxy grading its own homework;
        # say so rather than quietly returning the last iterate.
        if validate_fn is None:
            log.warning("  No validate_fn: keeping the final weights "
                        "unvalidated. The MILP reward alone cannot tell a "
                        "sharpened real cell from a manufactured one.")
            chosen = theta
        else:
            base_val = float(validate_fn(make_field(base_values, slice(None))))
            hist["base_val"] = base_val
            if best["val"] is not None and best["val"] > base_val:
                chosen = best["theta"]
                log.info(f"  Best validated {best['val']:.4f} > base "
                         f"{base_val:.4f}: keeping the learned tensor.")
            else:
                chosen = theta0
                log.info(f"  Nothing beat the base Field "
                         f"({base_val:.4f}); reverting to it.")

        vals, delta = candidate(chosen, slice(None))
        self.values = vals
        hist["final_abs_delta_mean"] = float(np.abs(delta).mean())
        hist["final_abs_delta_max"] = float(np.abs(delta).max())
        log.info(f"  Applied tensor: mean|Δ| "
                 f"{hist['final_abs_delta_mean']:.4f}, "
                 f"max|Δ| {hist['final_abs_delta_max']:.4f}")
        return hist

    def optimize_discrete(self, evaluate_fn, n_regions: int = 16, chunk_size: int = 8):
        """Greedy discrete local search that makes explicit binary topological changes (boost/suppress)
        to the most uncertain blocks in the field, keeping them only if they strictly improve the MILP score.
        """
        import concurrent.futures
        import copy

        log.info(f"  Starting Discrete Local Search (N={n_regions} regions, chunk_size={chunk_size})")

        # 1. Find most uncertain regions
        uncertainty = self.values * (1.0 - self.values)
        regions = []
        unc_copy = uncertainty.copy()
        pad = chunk_size // 2

        for _ in range(n_regions):
            idx = np.unravel_index(np.argmax(unc_copy), unc_copy.shape)
            t, z, y, x = idx

            # define slice boundaries
            nt, nz, ny, nx = self.values.shape
            t0, t1 = max(0, t - pad), min(nt, t + pad)
            z0, z1 = max(0, z - pad), min(nz, z + pad)
            y0, y1 = max(0, y - pad), min(ny, y + pad)
            x0, x1 = max(0, x - pad), min(nx, x + pad)

            regions.append((slice(t0, t1), slice(z0, z1), slice(y0, y1), slice(x0, x1)))

            # blank out neighborhood to prevent overlapping regions
            unc_copy[t0:t1, z0:z1, y0:y1, x0:x1] = 0.0

        baseline_score = evaluate_fn(self)
        log.info(f"  Baseline MILP score: {baseline_score:.2f}")

        improved_any = False

        for i, r in enumerate(regions):
            # Test Boost
            boost_vals = self.values.copy()
            boost_vals[r] = np.clip(boost_vals[r] + 0.5, 0.0, 1.0)
            
            # Test Suppress
            suppress_vals = self.values.copy()
            suppress_vals[r] = np.clip(suppress_vals[r] - 0.5, 0.0, 1.0)
            
            boost_field = copy.copy(self)
            boost_field.values = boost_vals
            
            suppress_field = copy.copy(self)
            suppress_field.values = suppress_vals
            
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                f_boost = executor.submit(evaluate_fn, boost_field)
                f_suppress = executor.submit(evaluate_fn, suppress_field)
                
                score_boost = f_boost.result()
                score_suppress = f_suppress.result()
                
            best_score = max(score_boost, score_suppress)
            if best_score > baseline_score:
                if score_boost > score_suppress:
                    self.values = boost_vals
                    action = "BOOST"
                else:
                    self.values = suppress_vals
                    action = "SUPPRESS"
                
                log.info(f"  Region {i+1:2d}/{n_regions}: {action} improved score {baseline_score:.2f} -> {best_score:.2f}. Accepted.")
                baseline_score = best_score
                improved_any = True
            else:
                log.info(f"  Region {i+1:2d}/{n_regions}: Rejected (Boost: {score_boost:.2f}, Suppress: {score_suppress:.2f})")
                
        if improved_any:
            log.info(f"  Discrete optimization complete. Final MILP score: {baseline_score:.2f}")
        else:
            log.info("  Discrete optimization complete. No improvements found.")


def trackpy_boost(field: Field, volume,
                  probabilities: "Probabilities" = None,
                  bonus: float = 0.2,
                  search_range_um: float = 5.0) -> None:
    """Boost Field values at nodes where trackpy independently confirms a track.

    Runs trackpy completely independently:
    1. DoG detection on each raw frame (same as standalone trackpy).
    2. Link across the full video with ``tp.link``.
    3. For each linked detection, find the nearest Field grid node.
    4. Add ``bonus`` to that node's value (clamped to [0, 1]).

    This mutates ``field.values`` in-place.
    """
    import trackpy as tp
    import pandas as pd
    from skimage.feature import peak_local_max

    tp_logger = logging.getLogger("trackpy")
    tp_logger.setLevel(logging.WARNING)

    nt = volume.nt
    spacing = field.spacing_um
    n = field.n

    # ── 1. DoG detection on raw frames ───────────────────────────────
    log.info(f"  Trackpy boost: DoG detection on raw frames ...")
    sig_inner = DOG_INNER_UM / VOXEL_SCALE
    sig_outer = sig_inner * DOG_RATIO

    all_dets = []
    for t in range(nt):
        vol = volume.frame(t)
        dog = ndi.gaussian_filter(vol, sigma=sig_inner) - \
              ndi.gaussian_filter(vol, sigma=sig_outer)
        coords = peak_local_max(dog, min_distance=3, threshold_abs=0.02,
                                exclude_border=False)
        if len(coords) > 1500:
            values = dog[coords[:, 0], coords[:, 1], coords[:, 2]]
            keep = np.argsort(values)[-1500:]
            coords = coords[keep]
        for z, y, x in coords:
            all_dets.append({
                "frame": t,
                "z_um": float(z) * VOXEL_SCALE[0],
                "y_um": float(y) * VOXEL_SCALE[1],
                "x_um": float(x) * VOXEL_SCALE[2],
            })
    dets = pd.DataFrame(all_dets)
    log.info(f"    {len(dets)} detections across {nt} frames")

    # ── 2. Link with trackpy (full video, one shot) ──────────────────
    log.info(f"    Linking full video, search_range={search_range_um}µm ...")
    linked = tp.link(dets, search_range=search_range_um,
                     pos_columns=["z_um", "y_um", "x_um"], memory=0)

    # Keep only tracks spanning ≥2 frames
    track_lens = linked.groupby("particle")["frame"].nunique()
    good_pids = set(track_lens[track_lens >= 2].index)
    tracked = linked[linked["particle"].isin(good_pids)]
    n_tracks = len(good_pids)
    log.info(f"    {n_tracks} trackpy tracks (≥2 frames), "
             f"{len(tracked)} linked detections")

    # ── 3. Map trackpy positions → nearest Field grid nodes ──────────
    log.info(f"    Mapping to Field grid (bonus +{bonus}) ...")
    boosted = 0
    for t in range(nt):
        t_dets = tracked[tracked["frame"] == t]
        if len(t_dets) == 0:
            continue
        det_um = t_dets[["z_um", "y_um", "x_um"]].values  # (D, 3)
        node_pos = field.positions[t].reshape(-1, 3)       # (n³, 3)

        # Vectorised nearest-neighbour: batch all detections at this t
        # using a KD-tree for speed
        from scipy.spatial import cKDTree
        tree = cKDTree(node_pos)
        dists, idxs = tree.query(det_um)

        for d, idx in zip(dists, idxs):
            if d < spacing * 1.5:
                ijk = np.unravel_index(idx, (n, n, n))
                field.values[t, ijk[0], ijk[1], ijk[2]] = min(
                    field.values[t, ijk[0], ijk[1], ijk[2]] + bonus, 1.0)
                boosted += 1

    pct = 100.0 * boosted / max(len(tracked), 1)
    log.info(f"    Boosted {boosted} field nodes by +{bonus} "
             f"({pct:.1f}% of tracked detections)")


# ── Graph ────────────────────────────────────────────────────────────────────

@dataclass
class DistanceMatrix:
    """The legal Edge Pairs and their length in µm.

    A step in i, j or k is the same ``spacing`` µm in every direction
    because the Field grid is isotropic, so the distance is read straight
    off the index offset — and because the grid follows the tissue, that
    distance is already the motion the Transforms could not explain.
    """

    pairs: np.ndarray             # (E, 2) node indices
    offset: np.ndarray            # (E, 3) Δijk
    distance: np.ndarray          # (E,) µm

    def __len__(self):
        return len(self.pairs)


@dataclass
class Configuration:
    """A list of Paths; a Path is a list of Field Cell id pairs."""

    paths: list[tuple[int, ...]]              # tuples of edge indices
    singletons: list[int]                     # nodes used by no edge
    score: float = 0.0


class Graph:
    """The Field Cells plus the legal edges left after the rules.

    Nodes are the Field Cells that survive selection; ``ijk`` is their
    position in the Field, ``t`` their frame, ``value`` their Field value.
    Edges are the Edge Pairs allowed by rules 1 and 2.  Rules 3 and 4 are
    not edges: they are the sink cost and the capacity-1 node split, and
    both live in the optimisation.
    """

    def __init__(self, field: Field, node_t, node_ijk, node_value,
                 node_pos, node_centroid, start_free, end_free, transforms=None,
                 cell_probability_multiplier=CELL_PROBABILITY_MULTIPLIER,
                 link_distance=LINK_DISTANCE,
                 lambda_termination=LAMBDA_TERMINATION,
                 lambda_start=LAMBDA_START,
                 start_penalty_multiplier=0.25,
                 termination_penalty_multiplier=1.0,
                 dead_zone_um=DEAD_ZONE_UM, box_radius=BOX_RADIUS,
                 node_capacity=1, secondary_penalty=0.2,
                 continuous_centroids=False, node_size=None,
                 size_coherence_bonus=0.0):
        self.field = field
        self.transforms = transforms
        self.t = node_t
        self.ijk = node_ijk
        self.value = node_value
        self.pos = node_pos
        self.centroid = node_centroid
        self.node_size = node_size              # (N,) size band per node, or None
        self.size_coherence_bonus = size_coherence_bonus
        self.start_free = start_free
        self.end_free = end_free
        self.start_penalty_multiplier = start_penalty_multiplier
        self.termination_penalty_multiplier = termination_penalty_multiplier
        self.cell_probability_multiplier = cell_probability_multiplier
        self.link_distance = link_distance
        self.lambda_termination = lambda_termination
        self.lambda_start = lambda_start
        self.start_penalty_multiplier = start_penalty_multiplier
        self.dead_zone_um = dead_zone_um
        self.box_radius = box_radius
        self.node_capacity = node_capacity
        self.secondary_penalty = secondary_penalty
        self.continuous_centroids = continuous_centroids
        self.distance_matrix: DistanceMatrix | None = None
        self.configuration: Configuration | None = None
        self._solution: np.ndarray | None = None
        self._lp_N: int = 0   # stashed for decode / report

    def __len__(self):
        return len(self.t)

    # ── node selection ───────────────────────────────────────────────────

    @classmethod
    def build(cls, field: Field, transforms=None,
              node_select: str = "maxima",
              nms_radius: int = 3,
              value_floor: float = VALUE_FLOOR,
              adaptive_floor_pct: float = 0.0,
              max_nodes_per_frame: int = MAX_NODES_PER_FRAME,
              box_radius: int = BOX_RADIUS,
              continuous_centroids: bool = False,
              size_coherence_bonus: float = 0.0, **weights) -> "Graph":
        
        log.info(f"DEBUG IN GRAPH.BUILD: PROB_POWER={PROB_POWER}")
        if PROB_POWER != 1.0:
            # We apply PROB_POWER dynamically here so it doesn't force a cache rebuild!
            # Math equivalence: taking power after geometric mean (in ProbabilitiesEnhanced) 
            # is identical to taking power before it. 
            field.values = np.power(field.values, PROB_POWER)

        if adaptive_floor_pct > 0:
            nz = field.values[field.values > 0]
            if nz.size > 0:
                p_val = float(np.percentile(nz, adaptive_floor_pct))
                old_floor = value_floor
                value_floor = max(value_floor, p_val)
                log.info(f"    Adaptive floor (p{adaptive_floor_pct}): {old_floor:.3f} -> {value_floor:.3f}")

        nt, n = field.nt, field.n
        ts, ijks, vals = [], [], []

        for t in range(nt):
            v = field.values[t]
            if node_select == "maxima":
                keep = (v >= ndi.maximum_filter(v, size=nms_radius, mode="constant",
                                                cval=-1.0))
            elif node_select == "threshold":
                keep = np.ones_like(v, bool)
            else:
                raise ValueError(f"unknown node_select {node_select!r}")
            keep &= (v >= value_floor) & field.in_view[t]

            idx = np.argwhere(keep)
            if len(idx) > max_nodes_per_frame:
                order = np.argsort(v[tuple(idx.T)])[::-1][:max_nodes_per_frame]
                idx = idx[order]
            ts.append(np.full(len(idx), t, np.int32))
            ijks.append(idx.astype(np.int16))
            vals.append(v[tuple(idx.T)].astype(np.float32))

        node_t = np.concatenate(ts)
        node_ijk = np.concatenate(ijks)
        node_value = np.concatenate(vals)
        sel = (node_t, node_ijk[:, 0], node_ijk[:, 1], node_ijk[:, 2])
        node_pos = field.positions[sel]
        node_centroid = field.centroids[sel]
        node_size = (field.size_band[sel].astype(np.int16)
                     if field.size_band is not None else None)

        # Rule 3: a path may end for free at the last frame, or where the
        # tissue the Field Cell tracks has left the camera by the next one.
        end_free = node_t == nt - 1
        if transforms is not None:
            fov_max = field.n * field.spacing_um
            for t_val in range(nt - 1):
                frame_idx = np.nonzero(node_t == t_val)[0]
                if len(frame_idx) == 0:
                    continue
                predicted = transforms[t_val].forward(node_pos[frame_idx])
                out = np.any((predicted < 0) | (predicted >= fov_max), axis=1)
                end_free[frame_idx[out]] = True
        else:
            nxt_in_view = np.ones(len(node_t), bool)
            alive = node_t < nt - 1
            a = node_t[alive]
            nxt_in_view[alive] = field.in_view[a + 1, node_ijk[alive, 0],
                                                node_ijk[alive, 1],
                                                node_ijk[alive, 2]]
            end_free = end_free | ~nxt_in_view

        # Rule 3b: a path may start for free at the first frame, or where the
        # tissue the Field Cell tracks has entered the camera from the previous one.
        start_free = node_t == 0
        if transforms is not None:
            for t_val in range(1, nt):
                frame_idx = np.nonzero(node_t == t_val)[0]
                if len(frame_idx) == 0:
                    continue
                # Where did this point come from in the previous frame?
                predicted = transforms[t_val - 1].inverse(node_pos[frame_idx])
                out = np.any((predicted < 0) | (predicted >= fov_max), axis=1)
                start_free[frame_idx[out]] = True
        else:
            prev_in_view = np.ones(len(node_t), bool)
            alive = node_t > 0
            a = node_t[alive]
            prev_in_view[alive] = field.in_view[a - 1, node_ijk[alive, 0],
                                                node_ijk[alive, 1],
                                                node_ijk[alive, 2]]
            start_free = start_free | ~prev_in_view

        g = cls(field, node_t, node_ijk, node_value, node_pos, node_centroid,
                start_free, end_free, transforms=transforms, box_radius=box_radius,
                node_size=node_size, size_coherence_bonus=size_coherence_bonus,
                **weights)
        log.info(f"  Graph: {len(g)} nodes selected ({node_select}, floor "
                 f"{value_floor}, cap {max_nodes_per_frame}/frame), "
                 f"{int(end_free.sum())} may end for free")
        if node_size is not None and size_coherence_bonus > 0:
            log.info(f"    size bands {sorted(set(node_size.tolist()))}, "
                     f"coherence bonus {size_coherence_bonus} on same-band edges")
        log.info(f"    value  min {node_value.min():.3f}  "
                 f"median {np.median(node_value):.3f}  "
                 f"max {node_value.max():.3f}")
        g.compute_distance_matrix()
        g.auto_calibrate()
        return g

    # ── the rules ────────────────────────────────────────────────────────

    def compute_distance_matrix(self) -> DistanceMatrix:
        """Rules 1 and 2: one step forward in time, at most 2 cells away.

        When transforms are available, edges are built by predicting where
        each source node's tissue will be at t+1 using the per-step
        transform, then searching within box_radius of the predicted grid
        index.  The edge distance is the residual — how far the target
        node is from the prediction.  Each edge uses one pairwise
        transform, so drift cannot accumulate.

        Without transforms, falls back to raw index-offset edges.
        """
        f = self.field
        nt, n, r = f.nt, f.n, self.box_radius
        spacing = f.spacing_um

        # (t, i, j, k) -> node index, or -1.
        lookup = np.full((nt, n, n, n), -1, np.int32)
        lookup[self.t, self.ijk[:, 0], self.ijk[:, 1],
               self.ijk[:, 2]] = np.arange(len(self), dtype=np.int32)

        d = np.arange(-r, r + 1)
        offsets = np.stack(np.meshgrid(d, d, d, indexing="ij"),
                           -1).reshape(-1, 3)

        alive = np.nonzero(self.t < nt - 1)[0]
        next_t = self.t[alive] + 1

        if self.continuous_centroids:
            src_pos_eval = self.centroid[alive].astype(np.float64)
            tgt_pos_eval = self.centroid
        else:
            src_pos_eval = self.pos[alive].astype(np.float64)
            tgt_pos_eval = self.pos

        # Predict where each source node's tissue goes at t+1.
        if self.transforms is not None:
            predicted = np.zeros_like(src_pos_eval)
            for t_val in range(nt - 1):
                mask = self.t[alive] == t_val
                if mask.any():
                    predicted[mask] = self.transforms[t_val].forward(
                        src_pos_eval[mask])
            centre_ijk = np.floor(predicted / spacing).astype(np.int32)
            centre_ijk = np.clip(centre_ijk, 0, n - 1)
        else:
            centre_ijk = self.ijk[alive].astype(np.int32)
            predicted = None

        pairs, offs_list, dist_list = [], [], []
        for off in offsets:
            q = centre_ijk + off
            ok = np.all((q >= 0) & (q < n), axis=1)
            if not ok.any():
                continue
            tgt = lookup[next_t[ok], q[ok, 0], q[ok, 1], q[ok, 2]]
            hit = tgt >= 0
            if not hit.any():
                continue
            src = alive[ok][hit]
            pairs.append(np.stack([src, tgt[hit]], axis=1))
            offs_list.append(np.repeat(off[None], hit.sum(), axis=0))
            if predicted is not None:
                residual = np.linalg.norm(
                    tgt_pos_eval[tgt[hit]] - predicted[ok][hit], axis=1)
                dist_list.append(residual)
            elif self.continuous_centroids:
                residual = np.linalg.norm(
                    tgt_pos_eval[tgt[hit]] - tgt_pos_eval[src], axis=1)
                dist_list.append(residual)

        if pairs:
            pairs = np.concatenate(pairs).astype(np.int32)
            offs = np.concatenate(offs_list).astype(np.int16)
            if dist_list:
                dist = np.concatenate(dist_list)
            else:
                dist = np.linalg.norm(offs, axis=1).astype(np.float64) * spacing
        else:                                              # pragma: no cover
            pairs = np.zeros((0, 2), np.int32)
            offs = np.zeros((0, 3), np.int16)
            dist = np.zeros(0, np.float64)

        self.distance_matrix = DistanceMatrix(pairs, offs, dist)
        log.info(f"    {len(pairs)} Edge Pairs survive rules 1 and 2 "
                 f"({len(pairs) / max(len(self), 1):.1f} per node), "
                 f"length median {np.median(dist) if len(dist) else 0:.2f}µm")
        return self.distance_matrix

    def auto_calibrate(self) -> None:
        """Derive λ_distance and λ_termination from the data.

        When transforms are available the distance cost uses per-frame
        normalisation (dimensionless), so λ_distance must match that
        scale.  Both weights are anchored to the median node reward so
        the LP terms are balanced without video-specific tuning.

        Only overrides weights that are still at their *module defaults*;
        explicit user overrides are preserved.
        """
        if self.transforms is None:
            return  # No adaptive mode; keep manual settings.

        med = float(np.median(self.value))
        if med <= 0:
            return  # Degenerate field; skip.

        auto_term = K_TERM * self.cell_probability_multiplier * med
        auto_dist = K_DIST * med

        changed = []
        if self.lambda_termination == LAMBDA_TERMINATION:
            self.lambda_termination = auto_term * self.termination_penalty_multiplier
            changed.append(f"λ_term={self.lambda_termination:.3f}")
        if self.lambda_start == LAMBDA_START:
            self.lambda_start = auto_term * self.start_penalty_multiplier
            changed.append(f"λ_start={self.lambda_start:.3f}")
        if self.link_distance < 0:
            self.link_distance = auto_dist
            changed.append(f"λ_dist={auto_dist:.3f}")

        if changed:
            log.info(f"    Auto-calibrated from median value {med:.3f}: "
                     f"{', '.join(changed)}")

    # ── the three terms ──────────────────────────────────────────────────

    def set_weights(self, **kw) -> "Graph":
        """Change the λ in place.

        The rules, the nodes and the Distance Matrix do not depend on the
        weights, so a sweep re-solves and rebuilds nothing.
        """
        for k, v in kw.items():
            if v is None:
                continue
            if not hasattr(self, k):
                raise AttributeError(f"no weight named {k!r}")
            setattr(self, k, v)
        return self

    def node_reward(self) -> np.ndarray:
        """λ1 · value, earned once per unique Field Cell in the Configuration.

        It rides the node's internal in→out edge, so a Field Cell pays for
        itself exactly when it is used, however many pairs mention it.
        """
        return self.cell_probability_multiplier * self.value

    def edge_cost(self) -> np.ndarray:
        """λ2 · distance, adaptive to per-frame transform quality.

        When transforms are available, each edge's distance is normalised
        by the expected residual for its source frame.  Edges within 1×
        the expected residual are free (adaptive dead zone); beyond that
        the penalty scales as ``λ2 · (distance / expected - 1)``.

        Falls back to the fixed dead zone when transforms are absent.
        """
        dm = self.distance_matrix
        if self.transforms is not None and len(dm) > 0:
            residuals = self.transforms.residuals   # (nt-1,)
            # The noise floor has two components:
            #   1. Transform residual (p90): unexplained tissue motion
            #   2. Grid spacing: quantisation of cell positions
            # Combined as RSS to get the expected edge distance for
            # correctly-matched cells.
            p90 = float(np.percentile(residuals, 90))
            spacing = self.field.spacing_um
            expected = max(np.sqrt(p90**2 + spacing**2), 0.1)
            normalised = dm.distance / expected - 1.0
            cost = self.link_distance * np.maximum(normalised, 0.0)
        else:
            cost = self.link_distance * np.maximum(
                dm.distance - self.dead_zone_um, 0.0)
        return self._apply_size_coherence(cost)

    def _apply_size_coherence(self, cost: np.ndarray) -> np.ndarray:
        """Reward edges that keep a cell in the same size band: a cell's size
        is consistent frame to frame (it only *halves* at division), so a
        same-band link is cheaper by ``size_coherence_bonus``.  A DAG in time,
        so a negative edge cost creates no negative cycle."""
        bonus = getattr(self, "size_coherence_bonus", 0.0)
        if bonus <= 0 or self.node_size is None or len(cost) == 0:
            return cost
        dm = self.distance_matrix
        same = self.node_size[dm.pairs[:, 0]] == self.node_size[dm.pairs[:, 1]]
        return cost - bonus * same

    def termination_cost(self) -> np.ndarray:
        """λ3 on the sink edge, except where rule 3 allows the end."""
        return np.where(self.end_free, 0.0, self.lambda_termination)

    def start_cost(self) -> np.ndarray:
        """λ_start on the source edge, except where rule 3b allows the start."""
        return np.where(self.start_free, 0.0, self.lambda_start)

    # ── optimisation ─────────────────────────────────────────────────────

    def optimise(self, solver_log: bool = False, momentum_iters: int = 0, momentum_penalty: float = 10.0, completion_iters: int = 0, completion_bonus: float = 1.0) -> Configuration:
        """The Configuration of maximum score, by min-cost flow.

        When ``node_capacity == 1`` (default), variables are:

            [0, N)          node used            (the in→out edge)
            [N, 2N)         path starts here     (the free source edge)
            [2N, 3N)        path ends here       (the sink edge)
            [3N, 3N+E)      Edge Pair used

        When ``node_capacity == 2``, we add a secondary copy of each node:

            [0, N)          primary node   (capacity 1, full reward)
            [N, 2N)         secondary node (capacity 1, reward = −penalty)
            [2N, 3N)        path starts here
            [3N, 4N)        path ends here
            [4N, 4N+E)      Edge Pair used

        The constraints remain 2N.  Both primary and secondary bridge the
        same entry / exit rows, so the solver naturally fills the primary
        first (higher reward) and only spills into the secondary when a
        second track genuinely needs that grid cell.

        The matrix is still an incidence matrix (each column has at most
        one +1 and one −1), hence totally unimodular, hence every vertex
        of the feasible region is integral.
        """
        if self.distance_matrix is None:
            self.compute_distance_matrix()
        dm = self.distance_matrix
        N, E = len(self), len(dm)
        self._lp_N = N
        t0 = time.time()
        cap2 = (self.node_capacity >= 2)

        reward = self.node_reward()
        start_pen = self.start_cost()
        end_pen = self.termination_cost()
        edge_pen = self.edge_cost()

        idx = np.arange(N)

        if cap2:
            # Variable layout: primary(N), secondary(N), start(N), end(N), edges(E)
            # Cost vector (linprog minimises, we negate rewards)
            secondary_cost = np.full(N, self.secondary_penalty)  # positive = penalty in minimisation
            cost = np.concatenate([-reward, secondary_cost,
                                   start_pen, end_pen, edge_pen])

            # Constraint matrix: 2N rows (entry + exit per physical node)
            # Primary:   col i     → row i (-1), row N+i (+1)
            # Secondary: col N+i   → row i (-1), row N+i (+1)
            # Start:     col 2N+i  → row i (+1)
            # End:       col 3N+i  → row N+i (-1)
            rows = [idx, N + idx,           # primary
                    idx, N + idx,           # secondary
                    idx,                    # start
                    N + idx]                # end
            cols = [idx, idx,               # primary
                    N + idx, N + idx,       # secondary
                    2 * N + idx,            # start
                    3 * N + idx]            # end
            vals = [np.full(N, -1.0), np.full(N, 1.0),   # primary
                    np.full(N, -1.0), np.full(N, 1.0),   # secondary
                    np.full(N, 1.0),                      # start
                    np.full(N, -1.0)]                     # end
            if E:
                a, b = dm.pairs[:, 0], dm.pairs[:, 1]
                e = 4 * N + np.arange(E)
                rows += [N + a, b]
                cols += [e, e]
                vals += [np.full(E, -1.0), np.full(E, 1.0)]

            A = sparse.coo_matrix(
                (np.concatenate(vals),
                 (np.concatenate(rows), np.concatenate(cols))),
                shape=(2 * N, 4 * N + E)).tocsr()

            # Bounds: primary/secondary (0,1); start/end/edges (0,2)
            bounds = np.zeros((4 * N + E, 2))
            bounds[:2 * N, 1] = 1.0        # primary + secondary: cap 1 each
            bounds[2 * N:, 1] = 2.0         # start, end, edges: cap 2

            n_vars = 4 * N + E
            log.info(f"  LP: {n_vars} variables ({N} primary, {N} secondary, "
                     f"{N} starts, {N} ends, {E} edges), {2 * N} constraints")
            log.info(f"  Node capacity 2 (secondary penalty {self.secondary_penalty:.2f})")
        else:
            # Original capacity-1 layout
            cost = np.concatenate([-reward, start_pen, end_pen, edge_pen])

            rows = [idx, N + idx, idx, N + idx]
            cols = [idx, idx, N + idx, 2 * N + idx]
            vals = [np.full(N, -1.0), np.full(N, 1.0),
                    np.full(N, 1.0), np.full(N, -1.0)]
            if E:
                a, b = dm.pairs[:, 0], dm.pairs[:, 1]
                e = 3 * N + np.arange(E)
                rows += [N + a, b]
                cols += [e, e]
                vals += [np.full(E, -1.0), np.full(E, 1.0)]
            A = sparse.coo_matrix(
                (np.concatenate(vals),
                 (np.concatenate(rows), np.concatenate(cols))),
                shape=(2 * N, 3 * N + E)).tocsr()

            bounds = (0.0, 1.0)
            n_vars = 3 * N + E
            log.info(f"  LP: {n_vars} variables ({N} nodes, {N} starts, "
                     f"{N} ends, {E} edges), {2 * N} constraints")

        log.info("  Solving: simplex, integral by total unimodularity "
                 "(no branch and bound) ...")
                 
        total_iters = max(momentum_iters, completion_iters)
        for it in range(total_iters + 1):
            if it > 0:
                log.info(f"  Iteration {it}/{total_iters}: Resolving LP...")
                
            res = linprog(cost, A_eq=A, b_eq=np.zeros(2 * N), bounds=bounds,
                          method="highs", options={"disp": bool(solver_log)})
            if not res.success:
                if it > 0:
                    log.warning(f"  LP failed: {res.message}. Keeping previous iteration.")
                    break
                else:
                    raise RuntimeError(f"LP failed: {res.message}")

            x = res.x
            frac = float(np.abs(x - np.round(x)).max())
            if frac > 1e-6:
                log.warning(f"  solution is fractional ({frac:.3e}); rounding")

            self._solution = x
            config = self._decode(x, N, E)
            config.score = float(-res.fun)
            self.configuration = config
            
            if it == total_iters:
                break
                
            changed = False
            e_off = self._edge_offset(N)
            
            # --- Momentum Check ---
            if it < momentum_iters:
                penalized = 0
                for path_edges in config.paths:
                    if len(path_edges) < 2:
                        continue
                    nodes = [int(dm.pairs[path_edges[0], 0])] + [int(dm.pairs[e, 1]) for e in path_edges]
                    for i in range(1, len(nodes) - 1):
                        n_prev, n_curr, n_next = nodes[i-1], nodes[i], nodes[i+1]
                        p_prev = self.pos[n_prev]
                        p_curr = self.pos[n_curr]
                        p_next = self.pos[n_next]
                        
                        v1 = p_curr - p_prev
                        v2 = p_next - p_curr
                        
                        n1 = np.linalg.norm(v1)
                        n2 = np.linalg.norm(v2)
                        if n1 > 0 and n2 > 0:
                            cos_theta = np.dot(v1, v2) / (n1 * n2)
                            if cos_theta < 0.0:
                                cost[e_off + path_edges[i-1]] += momentum_penalty
                                cost[e_off + path_edges[i]] += momentum_penalty
                                penalized += 1
                                
                if penalized > 0:
                    log.info(f"  Momentum Iteration {it+1}: Penalized {penalized} sharp turns.")
                    changed = True
                    
            # --- Completion Bonus (Gap Bridging) ---
            if it < completion_iters:
                bonused = 0
                for path_edges in config.paths:
                    if not path_edges:
                        continue
                    
                    # Track start node (if not a free start boundary node)
                    start_node = int(dm.pairs[path_edges[0], 0])
                    if not self.start_free[start_node]:
                        inc_mask = (dm.pairs[:, 1] == start_node)
                        inc_edges = np.where(inc_mask)[0]
                        for e in inc_edges:
                            cost[e_off + e] -= completion_bonus
                            bonused += 1
                            
                    # Track end node (if not a free end boundary node)
                    end_node = int(dm.pairs[path_edges[-1], 1])
                    if not self.end_free[end_node]:
                        out_mask = (dm.pairs[:, 0] == end_node)
                        out_edges = np.where(out_mask)[0]
                        for e in out_edges:
                            cost[e_off + e] -= completion_bonus
                            bonused += 1
                            
                if bonused > 0:
                    log.info(f"  Completion Iteration {it+1}: Subsidized {bonused} bridging edges.")
                    changed = True
                            
            if not changed:
                log.info(f"  Iteration {it+1}: No penalties or bonuses applied. Converged.")
                break
                
        self._report(x, N, E, reward, end_pen, edge_pen, dm,
                     time.time() - t0, frac)
        return config

    def _edge_offset(self, N: int) -> int:
        """Column offset where edge variables start in the solution vector."""
        return (4 * N) if self.node_capacity >= 2 else (3 * N)

    def _start_offset(self, N: int) -> int:
        """Column offset where start variables begin."""
        return (2 * N) if self.node_capacity >= 2 else N

    def _end_offset(self, N: int) -> int:
        """Column offset where end variables begin."""
        return (3 * N) if self.node_capacity >= 2 else (2 * N)

    def _decode(self, x: np.ndarray, N: int, E: int) -> Configuration:
        cap2 = (self.node_capacity >= 2)
        s_off = self._start_offset(N)
        e_off = self._edge_offset(N)

        # With capacity 2, flow values can be 0, 1 or 2
        xi = np.round(x).astype(int)
        starts_flow = xi[s_off:s_off + N]  # (N,) int, 0..2
        edge_flow = xi[e_off:] if E else np.empty(0, int)  # (E,) int, 0..2
        dm = self.distance_matrix

        # Build adjacency: node -> list of (edge_index) with multiplicity
        from collections import defaultdict
        out_edges: dict[int, list[int]] = defaultdict(list)
        for e_idx in range(len(edge_flow)):
            for _ in range(int(edge_flow[e_idx])):
                out_edges[int(dm.pairs[e_idx, 0])].append(int(e_idx))

        # Trace paths from start nodes (each start unit = one track)
        # Total flow through node = primary + secondary
        node_flow = xi[:N]
        if cap2:
            node_flow = xi[:N] + xi[N:2*N]

        paths, singles = [], []
        for s in range(N):
            for _ in range(int(starts_flow[s])):
                if node_flow[s] <= 0:
                    break
                node_flow[s] -= 1
                node, chain = int(s), []
                while out_edges[node]:
                    e = out_edges[node].pop()
                    chain.append(e)
                    next_node = int(dm.pairs[e, 1])
                    node_flow[next_node] -= 1
                    node = next_node
                if chain:
                    paths.append(tuple(chain))
                else:
                    singles.append(int(s))
        return Configuration(paths=paths, singletons=singles)

    def _report(self, x, N, E, reward, end_pen, edge_pen, dm, elapsed, frac):
        config = self.configuration
        cap2 = (self.node_capacity >= 2)
        e_off = self._edge_offset(N)
        end_off = self._end_offset(N)

        xi = np.round(x).astype(int)
        node_used = xi[:N]                      # primary flow
        if cap2:
            node_used_total = xi[:N] + xi[N:2*N]
            secondary_used = int(xi[N:2*N].sum())
        end_flow = xi[end_off:end_off + N]
        edge_flow = xi[e_off:] if E else np.zeros(0, int)

        lengths = np.array([len(p) + 1 for p in config.paths] or [0])
        penalised = int(((end_flow > 0) & ~self.end_free).sum())
        used = int((node_used > 0).sum())

        log.info(f"  Configuration: {len(config.paths)} paths "
                 f"+ {len(config.singletons)} single Field Cells")
        log.info(f"    Field Cells used  {used}/{N} ({used / max(N, 1):.1%})")
        if cap2:
            shared = int((node_used_total > 1).sum())
            log.info(f"    Shared cells      {shared} ({secondary_used} secondary uses)")
        log.info(f"    Edge Pairs used   {int((edge_flow > 0).sum())}/{E} "
                 f"({int((edge_flow > 0).sum()) / max(E, 1):.1%})")
        log.info(f"    path length       mean {lengths.mean():.1f}  "
                 f"median {int(np.median(lengths))}  max {int(lengths.max())}")
        log.info(f"    terminations      {penalised} penalised, "
                 f"{int(end_flow.sum()) - penalised} free (rule 3)")
        # Score breakdown uses float x for accuracy
        node_on = x[:N] > 0.5
        end_on = x[end_off:end_off + N] > 0.5
        edge_on = (x[e_off:] > 0.5) if E else np.zeros(0, bool)
        log.info(f"    score {config.score:.1f} = "
                 f"{float(reward[node_on].sum()):+.1f} value "
                 f"{-float(edge_pen[edge_on].sum()):+.1f} distance "
                 f"{-float(end_pen[end_on].sum()):+.1f} termination")
        log.info(f"    solved in {elapsed:.1f}s, max fractionality {frac:.1e}")

    # ── successive shortest paths, for watching it build ─────────────────

    def augmentations(self, max_paths: int = 300) -> list[dict]:
        """Replay the solve one augmenting path at a time.

        The same min-cost flow, solved the other way round: repeatedly
        take the cheapest source→sink path in the residual graph and send
        one unit down it, stopping when the next one costs more than it is
        worth.  Slower than the LP and capped, so this is for watching the
        Configuration assemble, not for producing it -- but it is the same
        problem, and the running total converges on the LP's score.

        Potentials come from an exact DAG relaxation on the first pass
        (the graph is time-ordered, so shortest paths with negative costs
        are a topological sweep), after which every reduced cost is
        non-negative and Dijkstra is valid on the residual graph.
        """
        from scipy.sparse.csgraph import dijkstra

        dm = self.distance_matrix
        N, E = len(self), len(dm)
        reward, end_pen, edge_pen = (self.node_reward(),
                                     self.termination_cost(), self.edge_cost())

        # Arc list: source=2N, sink=2N+1; in_i = i, out_i = N + i.
        SRC, SNK = 2 * N, 2 * N + 1
        tails = np.concatenate([np.full(N, SRC), np.arange(N),
                                N + np.arange(N),
                                N + dm.pairs[:, 0] if E else np.zeros(0, int)])
        heads = np.concatenate([np.arange(N), N + np.arange(N),
                                np.full(N, SNK),
                                dm.pairs[:, 1] if E else np.zeros(0, int)])
        costs = np.concatenate([np.zeros(N), -reward, end_pen, edge_pen])

        # (tail, head) -> arc, built once: rebuilding it per augmentation
        # would make the replay quadratic in the number of arcs.
        arc_of = {(int(u), int(v)): i
                  for i, (u, v) in enumerate(zip(tails, heads))}

        order = np.argsort(np.concatenate([
            self.t * 4, self.t * 4 + 1, self.t * 4 + 2,
            self.t[dm.pairs[:, 0]] * 4 + 3 if E else np.zeros(0, int)]))
        # Topological potential sweep: nodes are ordered by frame, and
        # every arc goes forward in that order, so one pass is exact.
        pot = np.full(2 * N + 2, np.inf)
        pot[SRC] = 0.0
        for a in order:
            u, v_, c = tails[a], heads[a], costs[a]
            if pot[u] + c < pot[v_]:
                pot[v_] = pot[u] + c
        pot[SNK] = min(pot[SNK], 0.0)
        pot[~np.isfinite(pot)] = 0.0

        flow = np.zeros(len(tails), np.int8)
        out: list[dict] = []
        total = 0.0
        for _ in range(max_paths):
            fwd = flow == 0
            rc_f = costs + pot[tails] - pot[heads]
            rc_b = -costs + pot[heads] - pot[tails]
            rows = np.concatenate([tails[fwd], heads[~fwd]])
            cols = np.concatenate([heads[fwd], tails[~fwd]])
            data = np.maximum(np.concatenate([rc_f[fwd], rc_b[~fwd]]), 0.0)
            g = sparse.csr_matrix((data + 1e-12, (rows, cols)),
                                  shape=(2 * N + 2, 2 * N + 2))
            dist, pred = dijkstra(g, indices=SRC, return_predecessors=True)
            if not np.isfinite(dist[SNK]):
                break
            real = dist[SNK] + pot[SNK] - pot[SRC]
            if real >= -1e-9:                       # not worth its own cost
                break

            # Nodes Dijkstra could not reach keep a valid potential by
            # taking the sink's distance, which is the standard guard
            # against an unreachable node making a later reduced cost
            # negative.
            pot += np.minimum(dist, dist[SNK])

            chain, v_ = [], SNK
            while v_ != SRC:
                u = int(pred[v_])
                chain.append((u, v_))
                v_ = u
            chain.reverse()

            for u, v2 in chain:
                a = arc_of.get((int(u), int(v2)))
                if a is None:                       # residual (backward) arc
                    flow[arc_of[(int(v2), int(u))]] = 0
                else:
                    flow[a] = 1

            total += real
            # The Configuration so far, not just this path: an augmenting
            # path may undo an earlier choice, so the honest thing to show
            # is the current flow.
            chosen = np.nonzero(flow[3 * N:] > 0)[0] if E else np.empty(0, int)
            out.append({"cost": float(real), "total": float(total),
                        "nodes": sorted(int(u) for u, _ in chain
                                        if 0 <= u < N),
                        "edges": [int(e) for e in chosen]})
        log.info(f"  Recorded {len(out)} augmentations, running total "
                 f"{-total:.1f} (LP optimum "
                 f"{self.configuration.score if self.configuration else float('nan'):.1f})")
        return out

    # ── reading the answer out ───────────────────────────────────────────

    def path_nodes(self, path: tuple[int, ...]) -> list[int]:
        dm = self.distance_matrix
        out = [int(dm.pairs[path[0], 0])]
        for e in path:
            out.append(int(dm.pairs[e, 1]))
        return out

    def tracks(self, refined: bool = True) -> dict:
        """The Configuration as {cell_id: [(t, z, y, x) in camera voxels]}.

        ``refined`` reports the centre of mass inside each chosen Field
        Cell instead of the cube centre.  The graph never saw either, so
        this changes what is written out and nothing about which path won.
        """
        cfg = self.configuration
        if cfg is None:
            raise RuntimeError("optimise() first")
        pos = self.centroid if refined else self.pos
        out, cid = {}, 1
        for path in cfg.paths:
            rows = []
            for nd in self.path_nodes(path):
                z, y, x = np.asarray(pos[nd]) / VOXEL_SCALE
                rows.append((int(self.t[nd]), float(z), float(y), float(x)))
            out[cid] = rows
            cid += 1
        return out

    def _recover_birth_chains(self, used_nodes: set, min_frames: int,
                              dedup_um: float = 3.25,
                              max_shadow: float = 0.5,
                              min_value: float = 0.0) -> list:
        """Post-LP, additive: trace forward chains through the LP's *unused*
        nodes.  A cell that enters view or is a division daughter has an empty
        past, so the symmetric field crushes it and the LP leaves it idle — yet
        it persists *forward*.  We recover those idle nodes into tracks without
        touching the solved configuration (they use only unused cells, so no
        capacity conflict), keeping only chains that persist ``min_frames``
        (the forward-persistence gate that rejects short transients).

        De-dup: a chain whose nodes sit within ``dedup_um`` of a *used* node at
        the same frame for more than ``max_shadow`` of its length is a duplicate
        detection of an already-tracked cell — the leftover secondary maximum
        beside a real track — so it is dropped.  Genuine recoveries live in
        empty regions; division daughters survive because they diverge away
        after the first frame.  ``dedup_um`` <= 0 disables it."""
        from collections import defaultdict
        dm = self.distance_matrix
        fwd = defaultdict(list)               # unused src -> [(dist, unused tgt)]
        has_unused_in = set()
        for e in range(len(dm)):
            s, t2 = int(dm.pairs[e, 0]), int(dm.pairs[e, 1])
            if s not in used_nodes and t2 not in used_nodes:
                fwd[s].append((float(dm.distance[e]), t2))
                has_unused_in.add(t2)

        used_pos_by_t = {}
        if dedup_um > 0:
            tmp = defaultdict(list)
            for nd in used_nodes:
                tmp[int(self.t[nd])].append(self.pos[nd])
            used_pos_by_t = {t: np.asarray(v) for t, v in tmp.items()}

        visited, chains = set(), []
        starts = sorted((n for n in range(len(self.t)) if n not in used_nodes
                         and n not in has_unused_in and int(self.t[n]) > 0),
                        key=lambda n: int(self.t[n]))
        for s in starts:
            if s in visited:
                continue
            chain, cur = [s], s
            visited.add(s)
            while True:
                nxt = [(d, t) for d, t in fwd.get(cur, ()) if t not in visited]
                if not nxt:
                    break
                _, nx = min(nxt)
                chain.append(nx); visited.add(nx); cur = nx
            if len(chain) < min_frames:
                continue
            if min_value > 0:
                mv = float(np.mean([self.value[nd] for nd in chain]))
                if mv < min_value:
                    continue
            if dedup_um > 0:
                shadowed = 0
                for nd in chain:
                    up = used_pos_by_t.get(int(self.t[nd]))
                    if up is not None and up.size and \
                       np.min(np.linalg.norm(up - self.pos[nd], axis=1)) <= dedup_um:
                        shadowed += 1
                if shadowed / len(chain) > max_shadow:
                    continue
            chains.append(chain)
        return chains

    def tracks_and_parents(self, refined: bool = True,
                           division_method: str = "none",
                           division_max_um: float = 0.0,
                           division_require_split: bool = False,
                           birth_min_frames: int = 3,
                           birth_dedup_um: float = 3.25,
                           birth_max_shadow: float = 0.5,
                           birth_adaptive: bool = False,
                           birth_adaptive_len: float = 5.0,
                           birth_min_value: float = 0.0
                           ) -> tuple[dict, dict]:
        """Like :meth:`tracks`, but also returns a parent map.

        ``division_method="simple"``: every track that starts at t>0 must have
        spawned, so it is linked back to the closest *used* node at t-1.  That
        closest node is read straight off the track's own candidate incoming
        Edge Pairs, whose distance is already the transform-corrected residual
        (Rules 1 & 2) — so "closest, considering the transformation" needs no
        new geometry.  If the parent track continues past the split it is cut
        there, so the shared node gains a second child and becomes a real
        division; otherwise the daughter simply re-links to a track that ended.

        ``division_method="birth"`` additionally recovers idle-node forward
        chains (cells the LP dropped because they enter mid-video) and feeds
        them through the same connect-and-split logic — purely additive.  The
        recovery is de-duplicated (``birth_dedup_um``/``birth_max_shadow``, see
        :meth:`_recover_birth_chains`) and, when ``birth_adaptive`` is set, only
        runs on fragmented videos whose mean LP track spans fewer than
        ``birth_adaptive_len`` frames — clean videos with long tracks have
        little to recover and only accrue duplicates.

        ``division_max_um`` > 0 gates the link on that residual distance (a real
        division puts the daughter ~1 cell from the parent).  ``division_require
        _split`` keeps only true two-child divisions (parent continues past the
        split), dropping the re-link-to-a-dead-end cases.
        """
        pos = self.centroid if refined else self.pos
        node_lists = [self.path_nodes(p) for p in self.configuration.paths]

        def rows_of(nodes):
            out = []
            for nd in nodes:
                z, y, x = np.asarray(pos[nd]) / VOXEL_SCALE
                out.append((int(self.t[nd]), float(z), float(y), float(x)))
            return out

        if division_method not in ("simple", "birth") or self.distance_matrix is None:
            tracks = {i + 1: rows_of(ns) for i, ns in enumerate(node_lists)}
            return tracks, {c: None for c in tracks}

        if division_method == "birth":
            used = set()
            for ns in node_lists:
                used.update(ns)
            do_birth = True
            if birth_adaptive and node_lists:
                mean_len = sum(len(ns) for ns in node_lists) / len(node_lists)
                do_birth = mean_len < birth_adaptive_len
            if do_birth:
                node_lists = node_lists + self._recover_birth_chains(
                    used, birth_min_frames, birth_dedup_um, birth_max_shadow,
                    birth_min_value)

        # node -> original track index, and the set of used nodes.
        node_to_track = {}
        for ti, nodes in enumerate(node_lists):
            for nd in nodes:
                node_to_track[nd] = ti
        used = set(node_to_track)

        # Candidate incoming Edge Pairs grouped by their target node.
        dm = self.distance_matrix
        from collections import defaultdict
        incoming = defaultdict(list)          # target node -> [(dist, src)]
        for e in range(len(dm)):
            incoming[int(dm.pairs[e, 1])].append(
                (float(dm.distance[e]), int(dm.pairs[e, 0])))

        # Each track starting at t>0 picks its closest used parent node,
        # optionally gated on the residual distance.
        parent_node_of_track = {}             # track idx -> parent node N
        for ti, nodes in enumerate(node_lists):
            nd0 = nodes[0]
            if int(self.t[nd0]) == 0:
                continue
            cands = [(d, s) for d, s in incoming.get(nd0, []) if s in used
                     and (division_max_um <= 0 or d <= division_max_um)]
            if not cands:
                continue
            _, N = min(cands)
            if node_to_track[N] != ti:        # ignore a self-referential pick
                parent_node_of_track[ti] = N

        # A parent that continues past the attach point becomes a real division
        # (its shared node gains a second child); one that ends is a plain
        # re-link.  ``require_split`` keeps only the former.
        split_ts = defaultdict(set)           # parent track idx -> {split t}
        for ti, N in list(parent_node_of_track.items()):
            pti = node_to_track[N]
            t0 = int(self.t[N]) + 1
            continues = any(int(self.t[nd]) >= t0 for nd in node_lists[pti])
            if continues:
                split_ts[pti].add(t0)
            elif division_require_split:
                del parent_node_of_track[ti]  # drop dead-end re-links

        # Cut each track at its split points into consecutively-parented cells.
        out_tracks, out_parent, seg_of_node = {}, {}, {}
        next_cid = 1
        for ti, nodes in enumerate(node_lists):
            cuts = sorted(split_ts.get(ti, []))
            segments, cur, ci = [], [], 0
            for nd in nodes:                  # nodes are time-ordered
                t = int(self.t[nd])
                while ci < len(cuts) and t >= cuts[ci]:
                    if cur:
                        segments.append(cur); cur = []
                    ci += 1
                cur.append(nd)
            if cur:
                segments.append(cur)
            prev = None
            for seg in segments:
                cid = next_cid; next_cid += 1
                out_tracks[cid] = rows_of(seg)
                out_parent[cid] = prev        # continuation half of a division
                for nd in seg:
                    seg_of_node[nd] = cid
                prev = cid

        # Point each daughter's first segment at the parent segment holding N.
        for ti, N in parent_node_of_track.items():
            out_parent[seg_of_node[node_lists[ti][0]]] = seg_of_node[N]

        return out_tracks, out_parent

    def save_tracks_csv(self, path: Path, refined: bool = True,
                        division_method: str = "none",
                        division_max_um: float = 0.0,
                        division_require_split: bool = False,
                        birth_min_frames: int = 3,
                        birth_dedup_um: float = 3.25,
                        birth_max_shadow: float = 0.5,
                        birth_adaptive: bool = False,
                        birth_adaptive_len: float = 5.0,
                        birth_min_value: float = 0.0):
        """cell_id, t, z, y, x, parent_id in camera voxel coordinates."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tracks, parent = self.tracks_and_parents(
            refined, division_method, division_max_um, division_require_split,
            birth_min_frames, birth_dedup_um, birth_max_shadow,
            birth_adaptive, birth_adaptive_len, birth_min_value)
        n_div = sum(1 for p in parent.values() if p is not None)
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["cell_id", "t", "z", "y", "x", "parent_id"])
            for cid, rows in sorted(tracks.items()):
                pid = parent.get(cid)
                for t, z, y, x in rows:
                    w.writerow([cid, t, f"{z:.3f}", f"{y:.3f}", f"{x:.3f}",
                                "" if pid is None else pid])
        log.info(f"  Saved {len(tracks)} paths ({n_div} with a parent) → {path}")
        return tracks

    def save_competition_csv(self, path: Path, dataset: str,
                             refined: bool = True,
                             division_method: str = "none",
                             division_max_um: float = 0.0,
                             division_require_split: bool = False,
                             birth_min_frames: int = 3,
                             birth_dedup_um: float = 3.25,
                             birth_max_shadow: float = 0.5,
                             birth_adaptive: bool = False,
                             birth_adaptive_len: float = 5.0,
                             birth_min_value: float = 0.0):
        """The node/edge rows the competition asks for."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tracks, parent = self.tracks_and_parents(
            refined, division_method, division_max_um, division_require_split,
            birth_min_frames, birth_dedup_um, birth_max_shadow,
            birth_adaptive, birth_adaptive_len, birth_min_value)
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "dataset", "row_type", "node_id", "t", "z", "y",
                        "x", "source_id", "target_id"])
            rid, nid = 0, 1
            edges = []
            first_nid, last_nid = {}, {}       # cell_id -> global node id
            for cid, rows in sorted(tracks.items()):
                ids = []
                for t, z, y, x in rows:
                    w.writerow([rid, dataset, "node", nid, t, int(round(z)),
                                int(round(y)), int(round(x)), -1, -1])
                    ids.append(nid)
                    rid += 1
                    nid += 1
                first_nid[cid], last_nid[cid] = ids[0], ids[-1]
                edges += list(zip(ids, ids[1:]))
            # Division edges: parent's last node -> daughter's first node.
            for cid, pid in parent.items():
                if pid is not None and pid in last_nid:
                    edges.append((last_nid[pid], first_nid[cid]))
            for s, tt in edges:
                w.writerow([rid, dataset, "edge", -1, -1, -1, -1, -1, s, tt])
                rid += 1
        log.info(f"  Saved competition CSV → {path}")

    def save_edges(self, path: Path):
        """Every candidate Edge Pair with its cost, and whether it won.

        This is the object to explore: the rules produced it, the flow
        chose a subset of it, and the difference is where the λ live.
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        dm = self.distance_matrix
        N = len(self)
        e_off = self._edge_offset(N)
        chosen = (self._solution[e_off:] > 0.5 if self._solution is not None
                  else np.zeros(len(dm), bool))
        np.savez_compressed(
            path,
            node_t=self.t, node_ijk=self.ijk, node_value=self.value,
            node_pos=self.pos, node_centroid=self.centroid,
            node_end_free=self.end_free,
            node_used=(self._solution[:N] > 0.5 if self._solution is not None
                       else np.zeros(N, bool)),
            pairs=dm.pairs, offset=dm.offset, distance=dm.distance,
            edge_cost=self.edge_cost(), edge_chosen=chosen,
            node_reward=self.node_reward(),
            termination_cost=self.termination_cost(),
        )
        log.info(f"  Saved {len(dm)} edges ({int(chosen.sum())} chosen) "
                 f"→ {path}")
