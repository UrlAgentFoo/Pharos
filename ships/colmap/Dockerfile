# colmap: structure from motion with Ubuntu's COLMAP (CPU build) and FFmpeg for video frames.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen
RUN apt-get update && apt-get install -y --no-install-recommends colmap ffmpeg python3 python3-numpy python3-pil \
    && rm -rf /var/lib/apt/lists/*
COPY pharos_colmap.py /opt/pharos/
WORKDIR /tmp
