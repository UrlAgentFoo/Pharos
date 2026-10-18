# ultrack: links segmented cells over time into tracks, on the official Ultrack image.
# The official images are amd64 only (on Apple silicon Docker runs them emulated, more slowly).
# For an NVIDIA GPU build: --build-arg BASE=royerlab/ultrack:0.6.1-cuda12.4
ARG BASE=royerlab/ultrack:0.6.1-cpu
FROM --platform=linux/amd64 ${BASE}
ENV HOME=/tmp MPLCONFIGDIR=/tmp NUMBA_CACHE_DIR=/tmp PYTHONDONTWRITEBYTECODE=1
COPY pharos_ultrack.py /opt/pharos/
# no display needed: skip the image's xvfb-run wrapper
ENTRYPOINT ["tini", "--"]
CMD []
WORKDIR /tmp
