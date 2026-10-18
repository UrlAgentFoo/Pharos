# space-time-field: detector-free cell tracking (DoG field + min-cost flow). CPU only.
# Pinned to the versions the method was tuned with.
FROM python:3.11-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 MPLCONFIGDIR=/tmp
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==1.26.4 scipy==1.17.1 zarr==3.1.5 SimpleITK==2.5.6 matplotlib==3.11.1 imageio-ffmpeg==0.6.0
COPY stf/ /opt/pharos/stf/
COPY pharos_stf.py /opt/pharos/
WORKDIR /tmp
