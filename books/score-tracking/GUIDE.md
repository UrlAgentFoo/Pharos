# Track nuclei and score against ground truth

## When to use

The user has a 3D time-lapse of fluorescent nuclei **and** ground-truth
tracks for it as a GEFF graph (a `.geff` folder), and wants to track the
cells and see how well the tracking did: "score my tracks", "evaluate
against the ground truth", "how good is the tracker on this video",
"Biohub / Kaggle cell tracking". The challenge's data comes in pairs with
the same id, `<id>.zarr` (the movie) and `<id>.geff` (the truth): give the
`.zarr` to `movie` and the `.geff` to `truth`.

## When not to use

- No ground truth (no `.geff`): use **Track cells in a time-lapse**.
- 2D movies, or a single time point: this tracker needs t, z, y and x.
- Field of view far from a cube, or voxels far from 1.625 × 0.406 ×
  0.406 µm with 5-8 µm nuclei: the tracker was tuned on Biohub light-sheet
  zebrafish data and may do poorly elsewhere; say so.

## Parameters

Leave the defaults unless the user asks: they are the tuned configuration.

- **num_dog**: 2 (default) finds small nuclei too; 1 if the user wants
  fewer false tracks.
- **temporal_radius**: 2; lower it (1) only if cells move fast between
  frames.
- **value_floor** and **lambda_termination**: tuning knobs; change them
  only when the user is exploring the score.
- **max_distance** (µm): 7 is the challenge's rule; keep it.
- **split**: 50 for the challenge's 100-frame videos; 0 halves other
  movies.

## Outputs

- `score`: one row each for the first part (tuning), the second part
  (held out) and the whole movie: `combined` is the challenge's score
  (edge Jaccard × node-count penalty), with true and false positives,
  false negatives and recall. A much better first part than second part
  suggests parameters tuned to it.
- `tracks`: one row per cell per time point, positions in voxels.
- `video`: the max projection along z with a dot per tracked cell and an
  arrow for each step.

## Example

Request: "Track the cells in 44b6_e28840c6 and score them." Data:
`44b6_e28840c6.zarr`, 100 time points of 64 × 256 × 256 voxels, uint16,
voxel 1.625 × 0.406 × 0.406 µm; `44b6_e28840c6.geff`, 311 true cells.

Plan: Track nuclei and score against ground truth with the defaults.
Outputs: a score table (first 50 frames, last 50, whole movie), the track
table and a video of the tracks.
