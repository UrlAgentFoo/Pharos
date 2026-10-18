#!/bin/sh
# Fetches the real photo and video behind the object detection examples from
# Wikimedia Commons (both CC0) and cuts them down: a photo as an RGB TIFF, six
# seconds of video at 640 × 360, a one-second clip for the yolo ship's test,
# and the two cards' pictures. COCO's YOLO models find nothing in synthetic
# scenes, so these are real. Needs curl and FFmpeg (with libx264 and libwebp);
# run it from the repo's root:
#
#   sh examples/make_media.sh
#
# Photo: "Traffic and pedestrians on Calle Velásquez near Catedral San Nicolás
#   de Bari in Porlamar, Venezuela", by Wilfredor, CC0.
#   https://commons.wikimedia.org/wiki/File:Traffic_and_pedestrians_on_Calle_Vel%C3%A1squez_near_Catedral_San_Nicol%C3%A1s_de_Bari_in_Porlamar,_Venezuela.jpg
# Video: "Diagonal crosswalk at Yonge & Dundas in Toronto", by Raysonho, CC0.
#   https://commons.wikimedia.org/wiki/File:DiagonalCrosswalkYongeDundas.webm
set -eu

PHOTO=https://upload.wikimedia.org/wikipedia/commons/9/93/Traffic_and_pedestrians_on_Calle_Vel%C3%A1squez_near_Catedral_San_Nicol%C3%A1s_de_Bari_in_Porlamar%2C_Venezuela.jpg
VIDEO=https://upload.wikimedia.org/wikipedia/commons/d/d2/DiagonalCrosswalkYongeDundas.webm
BOOK=books/object-detection/example
TEST=ships/yolo/test/segment-video

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Wikimedia asks for a user agent that says who's asking
agent="Pharos examples (https://github.com/UrlAgentFoo/Pharos; examples/make_media.sh)"
curl -fsSL -A "$agent" -o "$tmp/photo.jpg" "$PHOTO"
curl -fsSL -A "$agent" -o "$tmp/video.webm" "$VIDEO"

mkdir -p "$BOOK" "$TEST" examples/images
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 8-bit RGB, deflate; 1024 px wide, from 2367 (YOLO looks at 640 by default)
ff -i "$tmp/photo.jpg" -vf scale=1024:-2:flags=lanczos -pix_fmt rgb24 -compression_algo deflate "$BOOK/image.tif"
# seconds 8 to 14: cars turning through the crossing while people walk; no sound
ff -ss 8 -t 6 -i "$tmp/video.webm" -an -vf scale=640:360:flags=lanczos,format=yuv420p \
  -c:v libx264 -preset slow -crf 26 -movflags +faststart "$BOOK/video.mp4"
ff -ss 9 -t 1 -i "$tmp/video.webm" -an -vf scale=320:180:flags=lanczos,format=yuv420p \
  -c:v libx264 -crf 30 -movflags +faststart "$TEST/video.mp4"

# the cards: 480 × 300, cropped from the middle
ff -i "$tmp/photo.jpg" -vf scale=517:300:flags=lanczos,crop=480:300 -quality 82 examples/images/street-photo.webp
ff -ss 12 -i "$tmp/video.webm" -frames:v 1 -vf scale=533:300:flags=lanczos,crop=480:300 -quality 82 examples/images/street-crossing.webp

ls -l "$BOOK" "$TEST" examples/images/street-*.webp
