# cad: parametric parts with Gmsh's OpenCASCADE kernel (Debian bookworm: Gmsh 4.11, OCCT 7.6).
# The same first layer as the fea ship's, so the two share it on disk.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive HOME=/tmp PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-numpy python3-gmsh && rm -rf /var/lib/apt/lists/*
COPY pharos_cad.py /opt/pharos/
WORKDIR /tmp
