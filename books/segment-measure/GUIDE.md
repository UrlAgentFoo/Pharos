# Segment and measure nuclei

## When to use

The user wants to find, count or measure nuclei or cells in a fluorescence
image: "count the nuclei", "how big are the cells", "measure intensity per
nucleus", "segment this stack". Works on 2D images and 3D stacks; on a
time-lapse each frame is segmented and measured separately (no tracking).

## When not to use

- Following cells over time, linking the same cell across frames, cell
  migration or lineages: use **Cell tracking** instead.
- Brightfield or phase-contrast images without a fluorescent stain:
  Cellpose's `cyto3` may work, but say the result needs checking.
- Tissue-level or texture questions with no individual objects.

## Parameters

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

## Example

Request: "Count the nuclei in this stack and measure their volume." Data:
12 × 64 × 64 voxels, uint16, voxel 2 × 0.5 × 0.5 µm, 1 channel.

Plan: Segment and measure nuclei with diameter 20 (10 µm / 0.5 µm),
model nuclei, channel 0. The table gives one row per nucleus with
`volume_um3`, centroid and mean intensity.
