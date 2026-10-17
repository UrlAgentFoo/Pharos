# slicer: PrusaSlicer's command line (Debian bookworm: PrusaSlicer 2.5), for a generic 0.4 mm-nozzle printer.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive HOME=/tmp PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-numpy prusa-slicer && rm -rf /var/lib/apt/lists/*
COPY pharos_slicer.py /opt/pharos/
WORKDIR /tmp
