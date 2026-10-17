"""
Writes the Zarr stores the preview tests read, with the real libraries
(zarr-python 3, numcodecs), so the decoders are checked against what other
tools write. Run it in the bio-utils ship's image:

    docker run --rm --user "$(id -u):$(id -g)" --network none \
      -v "$PWD/packages/server/test/fixtures:/f" --entrypoint python \
      pharos/bio-utils:0.1.0 -I /f/make_zarr_fixtures.py /f/zarr

Every image is a small movie (t, y, x = 3, 20, 24) whose pixel at (t, y, x)
is (t * 7919 + y * 31 + x * 3) % 65536, so a test can tell every value, or
noise next to an uncompressed copy of the same noise.
"""

import os
import shutil
import sys

import numpy as np
import zarr
from numcodecs import GZip, LZ4, Blosc, Zlib
from zarr.codecs import BloscCodec, BytesCodec, ShardingCodec, ZstdCodec

out = sys.argv[1]
T, Y, X = 3, 20, 24
t, y, x = np.meshgrid(np.arange(T), np.arange(Y), np.arange(X), indexing="ij")
movie = ((t * 7919 + y * 31 + x * 3) % 65536).astype("<u2")
noise = np.random.default_rng(7).integers(0, 65536, (T, Y, X)).astype("<u2")
AXES = [{"name": "t", "type": "time"}, {"name": "y", "type": "space"}, {"name": "x", "type": "space"}]


def fresh(name):
    path = os.path.join(out, name)
    shutil.rmtree(path, ignore_errors=True)
    return path


def ome(group, levels=("0",)):
    group.attrs["multiscales"] = [{"version": "0.4", "axes": AXES, "datasets": [{"path": p} for p in levels]}]


def v2(name, data=movie, chunks=(1, Y, X), compressor=None):
    g = zarr.open_group(fresh(name), mode="w", zarr_format=2)
    g.create_array("0", data=data, chunks=chunks, compressors=compressor)
    ome(g)


# Zarr 2 with each compressor numcodecs offers; partial edge chunks; Blosc's every inner codec and shuffle
v2("v2-blosc-lz4.zarr", chunks=(2, 8, 8), compressor=Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE))
v2("v2-blosc-blosclz.zarr", compressor=Blosc(cname="blosclz", clevel=9, shuffle=Blosc.SHUFFLE, blocksize=256))
v2("v2-blosc-zstd.zarr", compressor=Blosc(cname="zstd", clevel=3, shuffle=Blosc.NOSHUFFLE))
v2("v2-blosc-zlib-bitshuffle.zarr", compressor=Blosc(cname="zlib", clevel=5, shuffle=Blosc.BITSHUFFLE))
v2("v2-blosc-lz4hc.zarr", compressor=Blosc(cname="lz4hc", clevel=9, shuffle=Blosc.SHUFFLE, blocksize=512))
v2("v2-gzip.zarr", compressor=GZip(level=5))
v2("v2-zlib.zarr", compressor=Zlib(level=5))
v2("v2-lz4.zarr", compressor=LZ4())
# noise doesn't compress: Blosc stores it as it is (its "memcpyed" chunks)
v2("v2-noise-blosc.zarr", data=noise, compressor=Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE))
v2("v2-noise-raw.zarr", data=noise)
v2("v2-uint8-blosc.zarr", data=(movie % 256).astype("u1"), compressor=Blosc(cname="lz4", shuffle=Blosc.SHUFFLE))
v2("v2-float32-blosc.zarr", data=movie.astype("<f4"), compressor=Blosc(cname="zstd", shuffle=Blosc.BITSHUFFLE))
v2("v2-bigendian.zarr", data=movie.astype(">u2"))

# Zarr 3 (NGFF 0.5 keeps OME under "ome"): zstd, Blosc, and sharding
for name, kw in {
    "v3-zstd.zarr": dict(chunks=(1, Y, X), compressors=ZstdCodec(level=3)),
    "v3-blosc.zarr": dict(chunks=(2, 8, 8), compressors=BloscCodec(cname="lz4", clevel=5, shuffle="shuffle")),
    "v3-sharded.zarr": dict(shards=(T, Y, X), chunks=(1, 10, 12), compressors=ZstdCodec(level=3)),
}.items():
    g = zarr.open_group(fresh(name), mode="w", zarr_format=3)
    g.create_array("0", data=movie, **kw)
    g.attrs["ome"] = {"version": "0.5", "multiscales": [{"axes": AXES, "datasets": [{"path": "0"}]}]}

# bioformats2raw: the image in 0/, five axes with capital names
g = zarr.open_group(fresh("bioformats2raw.zarr"), mode="w", zarr_format=2)
g.attrs["bioformats2raw.layout"] = 3
inner = g.create_group("0")
inner.create_array("0", data=movie[:, None, None], chunks=(1, 1, 1, Y, X), compressors=Blosc(cname="zstd", clevel=3))
inner.attrs["multiscales"] = [{"version": "0.4", "axes": [{"name": n} for n in "TCZYX"], "datasets": [{"path": "0"}]}]

# plain arrays: xarray's named dimensions, and nothing named at all
a = zarr.create_array(fresh("plain-named.zarr"), zarr_format=2, shape=movie.shape, dtype=movie.dtype, chunks=(1, Y, X), compressors=Blosc(cname="lz4"), attributes={"_ARRAY_DIMENSIONS": ["time", "y", "x"]})
a[...] = movie
a = zarr.create_array(fresh("plain-bare.zarr"), zarr_format=3, shape=movie.shape, dtype=movie.dtype, chunks=(1, Y, X))
a[...] = movie

# a pyramid: the full movie, then every other pixel
g = zarr.open_group(fresh("pyramid.zarr"), mode="w", zarr_format=2)
g.create_array("0", data=movie, chunks=(1, Y, X), compressors=Blosc(cname="lz4"))
g.create_array("1", data=movie[:, ::2, ::2], chunks=(1, Y // 2, X // 2), compressors=Blosc(cname="lz4"))
ome(g, ("0", "1"))
print("wrote", len(os.listdir(out)), "stores")
