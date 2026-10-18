# geff: reads GEFF track graphs (https://liveimagetrackingtools.org/geff) and scores tracks against them. CPU only.
FROM python:3.12-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
# --exclude-newer keeps every package, dependencies included, to releases at least two weeks old
RUN pip install --no-cache-dir uv==0.12.21 && uv pip install --system --no-cache --exclude-newer 2026-10-01 \
      numpy==2.5.3 scipy==1.18.1 zarr==3.4.0
COPY pharos_geff.py /opt/pharos/
WORKDIR /tmp
