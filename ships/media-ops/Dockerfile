# media-ops: scales videos and photo sets down, with FFmpeg and Pillow. CPU only.
FROM python:3.12-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 pillow==12.3.0
COPY pharos_media.py /opt/pharos/
WORKDIR /tmp
