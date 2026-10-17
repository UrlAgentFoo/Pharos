# freecad: edits STEP parts with FreeCAD's Part module (OpenCASCADE), with no window.
# Debian 13: FreeCAD 1.0, OpenCASCADE 7.8. Its package brings Qt and VTK too, even used from scripts.
FROM debian:trixie-slim
# FreeCAD keeps its settings in a home of its own: the host's user has none in the container
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 HOME=/tmp FREECAD_USER_HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends freecad-python3 && rm -rf /var/lib/apt/lists/*
COPY pharos_freecad.py pharos_warm.py /opt/pharos/
WORKDIR /tmp
