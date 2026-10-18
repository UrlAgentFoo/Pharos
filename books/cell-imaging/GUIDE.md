# Cell imaging

Fluorescence microscopy of nuclei or cells. Four actions: `measure` counts
and measures objects in an image or stack; `track` follows them through a
time-lapse; `track_field` tracks a 3D light-sheet time-lapse without a
segmentation model; `score` does that and scores the result against
ground-truth tracks.

## When to use

- `measure`: the user wants to find, count or measure nuclei or cells:
  "count the nuclei", "how big are the cells", "measure intensity per
  nucleus", "segment this stack". Works on 2D images and 3D stacks; on a
  time-lapse each frame is segmented and measured separately (no tracking).
- `track`: the user has a time-lapse and wants to follow the cells: "track
  the cells", "how fast do they move", "measure each cell over time",
  "lineages", "migration". Works on 2D+t and 3D+t data; the summary must
  show a time axis (`t` in its axes, more than one time point).
- `track_field`: the user has a 3D light-sheet time-lapse of nuclei (t, z, y,
  x) and asks for the Space Time Field tracker, or wants tracks without a
  segmentation: "track with the space-time field", "track this embryo". No
  ground truth needed.
- `score`: the user has a 3D time-lapse **and** ground-truth tracks for it
  as a GEFF graph (a `.geff` folder), and wants to see how well tracking
  does: "score my tracks", "evaluate against the ground truth", "Biohub /
  Kaggle cell tracking". The challenge's data comes in pairs with the same
  id, `<id>.zarr` (the movie) and `<id>.geff` (the truth): give the `.zarr`
  to `timelapse` and the `.geff` to `truth`.

## When not to use

- Brightfield or phase-contrast images without a fluorescent stain:
  Cellpose's `cyto3` may work, but say the result needs checking.
- Tissue-level or texture questions with no individual objects.
- `track` on a single time point or a z-stack with no time axis: use
  `measure`. Very fast-moving or very dense cells where nuclei overlap from
  frame to frame: tracking will be unreliable; say so.
- `score` without ground truth (no `.geff`): use `track_field` (or `track`). `score` and `track_field` need t, z,
  y and x, and was tuned on Biohub light-sheet zebrafish data (voxels about
  1.625 × 0.406 × 0.406 µm, nuclei 5-8 µm); elsewhere it may do poorly, say so.

## Parameters

`measure` and `track`:

- **diameter** (pixels in x/y): the most important setting. From the data
  summary, divide the typical object size by the x voxel size. Nuclei are
  usually 8-15 µm across in mammalian cells (use ~10 µm), whole cells
  15-30 µm. Example: voxel x = 0.5 µm → nuclei ≈ 10 / 0.5 = 20 px. If the
  voxel size is unknown (unit "pixel"), use 0 so Cellpose estimates it, and
  say so.
- **model**: `nuclei` for DAPI, Hoechst or H2B-FP; `cyto3` for whole-cell
  or membrane stains.
- **channel**: with several channels, pick the nuclear stain if the user
  names it ("DAPI is channel 2" → 1, counting from 0); otherwise 0.

`track` only:

- **max_distance** (physical units, usually µm): how far a cell can move
  between time points. Use about one nucleus diameter (10-15 µm) unless the
  user says cells move fast or the frame interval is long; for frame
  intervals of minutes, 10-20 µm is typical for migrating cells.
- **min_size** (voxels): leave at 50 unless the images are very small
  (then lower it).

`track_field` and `score`: leave the defaults unless the user asks; they are the tuned
configuration. **num_dog** 2 finds small nuclei too (1 for fewer false
tracks); **temporal_radius** 2 (1 if cells move fast between frames);
**value_floor** and **lambda_termination** are tuning knobs;
**max_distance** 7 µm is the challenge's rule; **split** 50 for the
challenge's 100-frame videos, 0 halves other movies.

## Outputs

- `measure`: the masks, a table with one row per object (`volume_um3`,
  centroid, mean intensity) and a 3D model of the objects.
- `track`: a track table (one row per cell per time point, positions in
  pixels), a per-cell measurement table over time, the tracked labels and a
  video of the tracks.
- `track_field`: the track table and a video of the tracks.
- `score`: a score table with one row each for the first part (tuning), the
  second part (held out) and the whole movie (`combined` is the challenge's
  score), the track table, and a video of the tracks.

## Example

Request: "Count the nuclei in this stack and measure their volume." Data:
12 × 64 × 64 voxels, uint16, voxel 2 × 0.5 × 0.5 µm, 1 channel.

Plan: Cell imaging, action `measure`, with diameter 20 (10 µm / 0.5 µm),
model nuclei, channel 0.

Request: "Track the nuclei in this movie and tell me how they move." Data:
5 time points of 12 × 64 × 64 voxels, voxel 2 × 0.5 × 0.5 µm.

Plan: Cell imaging, action `track`, with diameter 20, max_distance 15,
channel 0, model nuclei.
