# opensplat: trains Gaussian splats with OpenSplat, built for the CPU so it runs on any machine
# (Docker on a Mac has no GPU). Built against the libtorch inside PyTorch's CPU wheel, which
# exists for amd64 and arm64; the final image keeps only OpenSplat and the libraries it links.
FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake ninja-build git ca-certificates \
      libopencv-dev python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/torch && /opt/torch/bin/pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
RUN git clone --depth 1 --branch v1.2.2 https://github.com/pierotofy/OpenSplat /src/opensplat
RUN cd /src/opensplat && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGPU_RUNTIME=CPU \
      -DCMAKE_PREFIX_PATH="$(/opt/torch/bin/python -c 'import torch; print(torch.utils.cmake_prefix_path)')" \
    && cmake --build build --target opensplat --parallel 2    # each file pulls in libtorch's headers: a few GB per compile
# the binary and every shared library it needs, outside the system's own
RUN mkdir -p /opt/opensplat/lib && cp /src/opensplat/build/opensplat /opt/opensplat/ \
    && ldd /opt/opensplat/opensplat | awk '/=> \// { print $3 }' | grep -v -E '/(libc|libm|libdl|librt|libpthread)\.so' \
       | xargs -I{} cp -L {} /opt/opensplat/lib/

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 LD_LIBRARY_PATH=/opt/opensplat/lib
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/opensplat /opt/opensplat
COPY pharos_splat.py /opt/pharos/
WORKDIR /tmp
