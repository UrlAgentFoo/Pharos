# cellpose: deep-learning segmentation of cells and nuclei (Cellpose 3, cyto3 and nuclei models).
# CPU by default. For an NVIDIA GPU build, pass the CUDA wheel index:
#   docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 -t pharos/cellpose:0.1.0 .
FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 \
    CELLPOSE_LOCAL_MODELS_PATH=/opt/cellpose-models MPLCONFIGDIR=/tmp NUMBA_CACHE_DIR=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url "$TORCH_INDEX" torch==2.8.0
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==2.0.2 cellpose==3.1.1.3 zarr==3.4.0
# ships run without network: bake the models into the image
RUN python -c "from cellpose import models; models.Cellpose(model_type='cyto3'); models.Cellpose(model_type='nuclei')" \
    && chmod -R a+rX /opt/cellpose-models
COPY pharos_cellpose.py /opt/pharos/
WORKDIR /tmp
