# render: videos and 3D models of images, tracks, labels and simulations. CPU only.
FROM python:3.12-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 MPLCONFIGDIR=/tmp
# VTK's libraries link against these even when nothing is drawn on screen
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libxrender1 libx11-6 && rm -rf /var/lib/apt/lists/*
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==2.5.3 scipy==1.18.1 zarr==3.4.0 pillow==12.3.0 imageio==2.38.0 imageio-ffmpeg==0.6.0 \
      scikit-image==0.26.0 pyvista==0.49.0 vtk==9.7.1
COPY pharos_render.py /opt/pharos/
WORKDIR /tmp
