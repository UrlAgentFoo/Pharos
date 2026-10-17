# yolo: instance segmentation with Ultralytics YOLO (the YOLO11 segmentation models, trained on COCO).
# CPU by default. For an NVIDIA GPU build, pass the CUDA wheel index:
#   docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 -t pharos/yolo:0.2.0 .
FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 \
    YOLO_CONFIG_DIR=/tmp/ultralytics MPLCONFIGDIR=/tmp
# OpenCV (which Ultralytics needs) links against these
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url "$TORCH_INDEX" torch==2.8.0 torchvision==0.23.0
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
# (imageio-ffmpeg brings an FFmpeg with H.264, for MP4s browsers can play)
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==2.5.3 ultralytics==8.4.170 zarr==3.4.0 tifffile==2026.9.20 imagecodecs==2026.8.16 imageio-ffmpeg==0.6.0
# ships run without network: bake the models into the image
RUN mkdir -p /opt/yolo && cd /opt/yolo \
    && python -c "from ultralytics import YOLO; [YOLO(m) for m in ('yolo11n-seg.pt', 'yolo11s-seg.pt', 'yolo11m-seg.pt')]" \
    && chmod -R a+rX /opt/yolo
COPY pharos_yolo.py /opt/pharos/
WORKDIR /tmp
