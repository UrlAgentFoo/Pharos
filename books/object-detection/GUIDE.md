# Object detection

Finds everyday objects in photos and videos with Ultralytics YOLO (the
YOLO11 segmentation models, trained on COCO). Every object is outlined, not
just boxed. Two actions: `find_in_image` labels each object in an image and
lists them in a table; `find_in_video` makes a new video with each object
outlined and named, and a table of what it found in each frame.

## When to use

The data is a photo, a stack of images or a video of ordinary scenes, and
the user wants to find, count or outline the things in it:

- `find_in_image`: "what's in this photo", "count the people", "find the
  cars", "outline every dog", "segment the objects". The image is kind
  `volume` (TIFF, OME-TIFF, OME-Zarr); a colour photo is an 8-bit RGB TIFF.
- `find_in_video`: "find the people in this video", "count the cars going
  past", "show me what it detects", "outline the objects in this clip".

The models know the 80 COCO classes: person; bicycle, car, motorcycle,
airplane, bus, train, truck, boat; traffic light, fire hydrant, stop sign,
parking meter, bench; bird, cat, dog, horse, sheep, cow, elephant, bear,
zebra, giraffe; backpack, umbrella, handbag, tie, suitcase; sports gear
(frisbee, skis, snowboard, sports ball, kite, baseball bat, baseball glove,
skateboard, surfboard, tennis racket); kitchen things (bottle, wine glass,
cup, fork, knife, spoon, bowl) and food (banana, apple, sandwich, orange,
broccoli, carrot, hot dog, pizza, donut, cake); furniture and household
things (chair, couch, potted plant, bed, dining table, toilet, tv, laptop,
mouse, remote, keyboard, cell phone, microwave, oven, toaster, sink,
refrigerator, book, clock, vase, scissors, teddy bear, hair drier,
toothbrush). Use these exact names in `classes`.

## When not to use

- Cells, nuclei or anything under a microscope: the COCO models don't know
  them. Use Cell imaging, unless the user has YOLO weights trained on their
  own images (then `weights`, below).
- Things outside the 80 classes (a particular machine part, a species of
  bird, faces as people's identities): say the models don't know them, and
  that YOLO can be trained on their own images.
- Following one object through a video ("how long did this person stay",
  "how many different cars passed"): each frame is looked at on its own, so
  the table counts objects per frame, not distinct objects. Say so, and
  count per frame instead (the most people in one frame, say).
- A video filmed walking around a still scene, to make it 3D: that's 3D
  capture.
- JPEG or PNG photos don't open in Pharos yet; ask for a TIFF.

## Parameters

Both actions:

- **classes**: empty keeps every class; "person, car" keeps only those. A
  name that isn't one of the model's classes stops the run with the list it
  knows.
- **confidence**: 0.25 by default. Lower (0.1) when objects are missed;
  higher (0.5) when there are false ones.
- **model**: nano by default (fastest); small or medium find more, smaller
  and partly hidden objects, about 2 and 5 times slower.
- **size** (px): 640 by default; 960-1280 for small or distant objects in
  large images, more slowly.
- **weights**: the file name of the user's own YOLO segmentation weights (a
  `.pt` file they put in `~/Pharos/weights`); then `model` and the COCO
  class list don't apply, and `classes` uses their model's names.

`find_in_image` adds **channel**: -1 (the default) looks at a colour image
as colour, or at the only channel; a number picks one channel of a
multichannel image.

`find_in_video` adds:

- **fps**: 10 frames a second by default, which is also the new video's
  frame rate; 0 looks at every frame (smooth, slower), 2-5 for a quick look
  at a long video.
- **max_size** (px): frames are scaled down to this longest side first
  (1280 by default); the new video has that size.

On a laptop's CPU (in Docker), the nano model takes about half a second per
image or frame at size 640, so 10 s of video at 10 frames a second takes
about a minute; small and medium are slower. Say how long a long video will
take, and offer fewer frames a second for a quick look.

## Results

`find_in_image` gives `masks` (labels: every object its own number, shown
over the image) and `objects` (a table: label, class, confidence, box in
pixels, area in pixels). `find_in_video` gives `video` (an MP4 with outlines,
boxes, names and confidences drawn) and `objects` (a table: frame `t` of the
new video, `time_s` in the original, class, confidence, box, area).

## Example

"Count the people and cars in this street video" on a 6 s clip →
`find_in_video` with classes "person, car" and fps 6. It finishes in about
half a minute; the window shows the outlined video, and the table counts
each class per frame.
