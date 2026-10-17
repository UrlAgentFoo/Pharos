# openfoam: runs OpenFOAM cases (OpenCFD's official image, amd64 and arm64).
FROM opencfd/openfoam-default:2512
COPY pharos_foam.sh /opt/pharos/pharos_foam.sh
# the image's entrypoint switches users; ships run as the host user instead
ENTRYPOINT []
WORKDIR /tmp
