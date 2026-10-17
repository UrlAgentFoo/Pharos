# 3D capture

Turns a video or a set of photos of a still scene into a 3D Gaussian splat:
COLMAP works out where each frame was taken (structure from motion), then
OpenSplat trains the splat. The result opens in the window as a 3D scene to
turn, zoom and fly through.

## When to use

The data is a video (kind `video`: `.mp4`, `.mov`) or a photo set (kind
`photos`: a folder with the photos in `images/`) of a real scene seen from
many positions, and the user wants it in 3D:

- `splat_video` (the main action): "make a 3D model of this video", "Gaussian
  splat", "3D scan", "turn this into something I can fly through", "NeRF",
  "reconstruct the scene".
- `cameras_video`: "where was the camera", "check the video works for 3D",
  "show the point cloud"; a quicker check (minutes) before the long
  training. Its frames and cameras are reused by `splat_video` with the same
  frame settings.
- `splat_photos`: the same from a folder of photos.

## When not to use

- Microscopy time-lapses or videos Pharos made (track videos, flow videos):
  a splat needs a camera moving through a still scene, not a fixed camera
  watching things move.
- Screen recordings, slideshows, or footage that cuts between shots.
- A single photo: at least a few dozen overlapping views are needed.
- Measuring sizes: the splat's scale is arbitrary (COLMAP doesn't know the
  real size), so lengths in it aren't in metres.

## Parameters

`splat_video`:

- **frames**: 60-120 for a short orbit; more for long or fast-moving videos.
  Too few and COLMAP can't link the frames ("couldn't work out where the
  photos were taken"); then suggest more frames.
- **max_size** (px): 1280 is plenty; lower (960) for speed. The frames are
  scaled here, so shrinking the video first (media-ops resize-video) gives
  the same splat; it only saves disk for very long or 4K videos. Pharos
  suggests it first in the window for videos over 100 MB; say so when the
  user's video is that large.
- **iterations**: training runs on the CPU at roughly 10-20 steps a second
  for small frames (slower as the splat grows), so 2000 steps on a short
  video take a few minutes. Offer 500-1000 for a quick look, 5000+ for a
  sharp result, and say about how long it will take.
- **max_gaussians**: the cap on the splat's size; 100,000-300,000 trains
  faster and gives a lighter model for a quick demo.
- **downscale**: 2 by default; 4 for a quick, softer look; 1 for full sharpness
  (four times slower than 2).
- **sh_degree**: 3 by default; 1 for faster training and flat colour.

`splat_photos` adds **matcher**: exhaustive for photos in any order (up to
a few hundred), sequential for photos taken in order along a path.

## Example

"Make a 3D model of this video" on a 10 s phone video walking around a
statue → `splat_video` with frames 80, iterations 2000. The run places the
cameras in under a minute, then trains for a few minutes; the window shows
the splat when it's done, and Results also has the sparse point cloud and the
frames. To make the result lighter afterwards, the mesh-ops ship's
thin-splat keeps the Gaussians that show most.
