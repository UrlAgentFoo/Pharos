# mapanything: feed-forward 3D reconstruction (Meta's MapAnything, the Apache 2.0 model). CPU by default
# (Docker on a Mac has no GPU), where it is slow; it is meant for an NVIDIA GPU. For a GPU build, pass the CUDA wheel index:
#   docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 -t pharos/mapanything:0.1.0 .
# The 4.9 GB model is baked into the image, since ships run without network.
FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 HF_HOME=/opt/hf TORCH_HOME=/opt/torch-hub MPLCONFIGDIR=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends git libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url "$TORCH_INDEX" torch==2.8.0 torchvision==0.23.0
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old;
# MapAnything itself is pinned to a commit of 7 Aug 2026 (version 1.1.4)
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      "mapanything @ git+https://github.com/facebookresearch/map-anything@3d10cf7"
COPY pharos_mapanything.py /opt/pharos/
# fetch the model (and anything its encoder pulls from torch hub) now, by reconstructing two tiny images
RUN python -c "import numpy as np; from PIL import Image; import os; os.makedirs('/tmp/w/images', exist_ok=True); \
[Image.fromarray((np.random.default_rng(i).random((96, 128, 3)) * 255).astype('uint8')).save(f'/tmp/w/images/{i}.jpg') for i in range(2)]" \
    && python /opt/pharos/pharos_mapanything.py reconstruct --photos /tmp/w --out /tmp/o/scene --points /tmp/o/points.ply --views 2 --points-max 1000 \
    && rm -rf /tmp/w /tmp/o && chmod -R a+rX /opt/hf /opt/torch-hub
# from here on, everything comes from the image
ENV HF_HUB_OFFLINE=1
WORKDIR /tmp
