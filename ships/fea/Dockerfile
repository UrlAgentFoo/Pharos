# fea: load tests with Gmsh (meshing) and CalculiX (solving), from Debian bookworm: Gmsh 4.11, CalculiX 2.20.
# The first layer is the cad ship's, so the two share it on disk.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive HOME=/tmp PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-numpy python3-gmsh && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends calculix-ccx && rm -rf /var/lib/apt/lists/*
COPY pharos_fea.py /opt/pharos/
WORKDIR /tmp
