# image-ops: everyday image processing (filters, flips, thresholds, binary operations, particles, measurements). CPU only.
FROM python:3.12-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==2.5.3 scipy==1.18.1 scikit-image==0.26.0 \
      tifffile==2026.9.20 imagecodecs==2026.8.16 zarr==3.4.0
COPY pharos_image.py make_test_data.py /opt/pharos/
WORKDIR /tmp
