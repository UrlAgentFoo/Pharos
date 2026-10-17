"""
geff: GEFF track graphs for Pharos.

  convert  /in/graph (GEFF) → /out/tracks.csv: track_id, t, [z,] y, x, parent_track_id, positions
           in voxels as the graph stores them. A track runs while a node has one successor and
           that successor one predecessor; a division starts daughter tracks whose parent is the
           mother's track.
  score    /in/tracks (CSV, as Ultrack writes them) + /in/truth (GEFF) → /out/score.csv, the
           Biohub cell tracking challenge's metric for the first half, the second half and the
           whole movie.

The metric (as the challenge defines it): per time point, tracked and true cells are paired by
an optimal assignment on distance in µm, up to max_distance. A tracked edge is a true positive
when both its ends are paired with the ends of a true edge; it is counted at all (as a possible
false positive) only when one of its ends is paired with a true cell that has an edge that way,
since the truth is sparse. edge_jaccard = TP / (TP + FP + FN), and combined multiplies it by
1 - 0.1 · (tracked cells - expected cells) / expected cells, where the expected count comes from
the graph's `estimated_number_of_nodes` (no penalty without it).

Progress goes to stdout as JSON lines.
"""

import argparse
import csv
import json
import os
import sys
from collections import defaultdict

import numpy as np
import zarr
from scipy.optimize import linear_sum_assignment

NODE_PENALTY_ALPHA = 0.1


def progress(p, message=None):
    print(json.dumps({"progress": round(p, 4), **({"message": message} if message else {})}), flush=True)


def read_geff(path):
    """Nodes {id: {axis: value}}, edges [(source, target)], the axes in order, µm per axis, and the metadata."""
    group = zarr.open_group(path, mode="r")
    meta = dict(group.attrs).get("geff")
    if meta is None:
        sys.exit(f"{os.path.basename(path)} has no GEFF metadata")
    axes = meta.get("axes") or [{"name": n, "type": "time" if n == "t" else "space"} for n in ("t", "z", "y", "x")]
    ids = np.asarray(group["nodes/ids"][...]).astype(np.int64)
    values = {}
    for a in axes:
        values[a["name"]] = np.asarray(group[f"nodes/props/{a['name']}/values"][...], dtype=np.float64)
    nodes = {int(n): {a["name"]: values[a["name"]][i] for a in axes} for i, n in enumerate(ids)}
    edges = [(int(s), int(d)) for s, d in np.asarray(group["edges/ids"][...]).astype(np.int64).reshape(-1, 2)]
    scale = {a["name"]: float(a.get("scale") or 1.0) for a in axes}
    return nodes, edges, axes, scale, meta


def axis_names(axes):
    time = next(a["name"] for a in axes if a.get("type") == "time")
    space = [a["name"] for a in axes if a.get("type") == "space"]
    return time, space


def chains(nodes, edges, time):
    """Splits the graph into tracks: {node: track_id} and {track_id: parent track_id or -1}."""
    succ, pred = defaultdict(list), defaultdict(list)
    for s, d in edges:
        succ[s].append(d)
        pred[d].append(s)
    track, parent = {}, {}
    for n in sorted(nodes, key=lambda n: (nodes[n][time], n)):
        if n in track:
            continue
        tid = len(parent) + 1
        p = pred[n][0] if pred[n] else None
        parent[tid] = track.get(p, -1) if p is not None else -1
        while n is not None and n not in track:
            track[n] = tid
            nxt = succ[n][0] if len(succ[n]) == 1 else None
            n = nxt if nxt is not None and len(pred[nxt]) == 1 else None
    return track, parent


def cmd_convert(a):
    nodes, edges, axes, _, _ = read_geff(a.inp)
    time, space = axis_names(axes)
    track, parent = chains(nodes, edges, time)
    progress(0.5, f"{len(nodes)} cells, {len(edges)} links, {len(parent)} tracks")
    rows = sorted(nodes, key=lambda n: (track[n], nodes[n][time]))
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["track_id", "t", *space, "parent_track_id"])
        for n in rows:
            v = nodes[n]
            w.writerow([track[n], int(v[time]), *(f"{v[s]:g}" for s in space), parent[track[n]]])
    progress(1.0, f"{len(parent)} tracks")


def read_tracks(path, space):
    """Tracked cells {(track, t): (t, *position)} and their edges: along each track, and from a mother's last cell to each daughter's first."""
    by_track, parents = defaultdict(list), {}
    with open(path) as f:
        for r in csv.DictReader(f):
            tid = int(float(r.get("track_id") or r["cell_id"]))
            by_track[tid].append((int(float(r["t"])), *(float(r[s]) for s in space)))
            p = r.get("parent_track_id", r.get("parent_id", ""))
            parents[tid] = int(float(p)) if p not in ("", None) else -1
    nodes, edges = {}, []
    for tid, pts in by_track.items():
        pts.sort()
        for p in pts:
            nodes[(tid, p[0])] = p
        edges += [((tid, a[0]), (tid, b[0])) for a, b in zip(pts, pts[1:]) if b[0] == a[0] + 1]
    for tid, pid in parents.items():
        if pid in by_track and tid in by_track:
            last, first = by_track[pid][-1][0], by_track[tid][0][0]
            if first == last + 1:
                edges.append(((pid, last), (tid, first)))
    return nodes, edges


def match(gt_at_t, pr_at_t, um, max_distance):
    """Optimal pairing of one time point's tracked and true cells within max_distance µm: {tracked: true}."""
    if not gt_at_t or not pr_at_t:
        return {}
    gt_ids, pr_keys = list(gt_at_t), list(pr_at_t)
    G = np.array([gt_at_t[i][1:] for i in gt_ids]) * um
    P = np.array([pr_at_t[k][1:] for k in pr_keys]) * um
    cost = np.linalg.norm(G[:, None, :] - P[None, :, :], axis=2)
    ri, ci = linear_sum_assignment(cost)
    return {pr_keys[c]: gt_ids[r] for r, c in zip(ri, ci) if cost[r, c] <= max_distance}


def score(lo, hi, gt, pred, um, max_distance, expected):
    gt_nodes, gt_edges, outdeg, indeg = gt
    pr_nodes, pr_edges = pred
    win_gt = {i: v for i, v in gt_nodes.items() if lo <= v[0] < hi}
    win_pr = {k: v for k, v in pr_nodes.items() if lo <= v[0] < hi}
    true_edges = {(s, d) for s, d in gt_edges if s in win_gt and d in win_gt}

    gt_by_t, pr_by_t = defaultdict(dict), defaultdict(dict)
    for i, v in win_gt.items():
        gt_by_t[v[0]][i] = v
    for k, v in win_pr.items():
        pr_by_t[v[0]][k] = v
    matched = {}
    for t in set(gt_by_t) | set(pr_by_t):
        matched.update(match(gt_by_t.get(t, {}), pr_by_t.get(t, {}), um, max_distance))

    tp = counted = 0
    for s, d in pr_edges:
        if s not in win_pr or d not in win_pr:
            continue
        gs, gd = matched.get(s), matched.get(d)
        hit = gs is not None and gd is not None and (gs, gd) in true_edges
        tp += hit
        counted += hit or (gs is not None and outdeg.get(gs, 0) > 0) or (gd is not None and indeg.get(gd, 0) > 0)
    fp, fn = counted - tp, len(true_edges) - tp
    jaccard = tp / (tp + fp + fn) if tp + fp + fn else 0.0
    penalty = 1.0 - NODE_PENALTY_ALPHA * (len(win_pr) - expected) / expected if expected else 1.0
    return {
        "combined": round(max(0.0, jaccard * penalty), 4),
        "edge_jaccard": round(jaccard, 4),
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "recall": round(len(set(matched.values())) / len(win_gt), 4) if win_gt else 0.0,
        "tracked_cells": len(win_pr),
        "true_cells": len(win_gt),
    }


def cmd_score(a):
    nodes, edges, axes, scale, meta = read_geff(a.truth)
    time, space = axis_names(axes)
    um = np.array([scale[s] for s in space])
    gt_nodes = {n: (int(v[time]), *(v[s] for s in space)) for n, v in nodes.items()}
    outdeg, indeg = defaultdict(int), defaultdict(int)
    for s, d in edges:
        outdeg[s] += 1
        indeg[d] += 1
    pred = read_tracks(a.tracks, space)
    progress(0.2, f"{len(pred[0])} tracked cells against {len(gt_nodes)} true cells ({len(edges)} links)")

    t_axis = next(x for x in axes if x["name"] == time)
    last = max([v[0] for v in gt_nodes.values()] + [v[0] for v in pred[0].values()])
    n_frames = int(t_axis["max"]) + 1 if t_axis.get("max") is not None else last + 1
    split = a.split if 0 < a.split < n_frames else n_frames // 2
    estimated = (meta.get("extra") or {}).get("estimated_number_of_nodes")

    windows = [("first part", 0, split), ("second part", split, n_frames), ("whole movie", 0, n_frames)]
    rows = []
    for i, (name, lo, hi) in enumerate(windows):
        expected = estimated * (hi - lo) / n_frames if estimated else None
        rows.append({"window": name, "from_t": lo, "to_t": hi - 1, **score(lo, hi, (gt_nodes, edges, outdeg, indeg), pred, um, a.max_distance, expected)})
        progress(0.2 + 0.8 * (i + 1) / len(windows), f"{name}: combined {rows[-1]['combined']:.4f}")
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    progress(1.0, f"combined {rows[-1]['combined']:.4f} over the whole movie")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("convert")
    c.add_argument("--in", dest="inp", required=True)
    c.add_argument("--out", required=True)
    c.set_defaults(func=cmd_convert)
    s = sub.add_parser("score")
    s.add_argument("--tracks", required=True)
    s.add_argument("--truth", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--max-distance", type=float, default=7.0)
    s.add_argument("--split", type=int, default=50)
    s.set_defaults(func=cmd_score)
    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
