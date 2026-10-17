# Track cells in a time-lapse

## When to use

The user has a time-lapse of fluorescent nuclei (or cells) and wants to
follow them: "track the cells", "how fast do they move", "measure each cell
over time", "lineages", "migration". Works on 2D+t and 3D+t data; the
summary must show a time axis (`t` in its axes, more than one time point).

## When not to use

- A single time point, or a z-stack with no time axis: use **Segment and
  measure** (it counts and measures, without tracking).
- Very fast-moving or very dense cells where nuclei overlap from frame to
  frame: tracking will be unreliable; say so.
- Brightfield without a fluorescent nuclear marker.
- The user also has ground-truth tracks (a `.geff`) and wants a score: use
  **Track nuclei and score against ground truth**.

## Parameters

- **diameter** (x/y pixels): typical nucleus size divided by the x voxel
  size. Mammalian nuclei are about 10 µm (use 10 / voxel x); if the voxel
  size is unknown, use 0 and say Cellpose will estimate it.
- **max_distance** (physical units, usually µm): how far a cell can move
  between time points. Use about one nucleus diameter (10-15 µm) unless the
  user says cells move fast or the frame interval is long; for frame
  intervals of minutes, 10-20 µm is typical for migrating cells.
- **channel**: the nuclear stain's channel, counting from 0; 0 if only one.
- **model**: `nuclei` for nuclear stains, `cyto3` for whole-cell stains.
- **min_size** (voxels): leave at 50 unless the images are very small
  (then lower it).

## Example

Request: "Track the nuclei in this movie and tell me how they move." Data:
5 time points of 12 × 64 × 64 voxels, uint16, voxel 2 × 0.5 × 0.5 µm.

Plan: Track cells in a time-lapse with diameter 20 (10 µm / 0.5 µm),
max_distance 15, channel 0, model nuclei. Outputs: a track table (one row
per cell per time point, positions in pixels), a per-cell measurement
table over time, the tracked labels, and a video of the tracks.
