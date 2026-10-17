import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPlane } from "@pharos/core";
import { readZarrImage } from "../src/zarr.js";

// written by fixtures/make_zarr_fixtures.py with zarr-python and numcodecs: a movie of t, y, x = 3, 20, 24
const FIXTURES = fileURLToPath(new URL("./fixtures/zarr/", import.meta.url));
const [T, Y, X] = [3, 20, 24];
const pixel = (t: number, y: number, x: number) => (t * 7919 + y * 31 + x * 3) % 65536;
const read = (name: string, maxBytes?: number) => readZarrImage(join(FIXTURES, name), name, maxBytes);

/** Every pixel of every frame, as the viewer holds them. */
async function frames(name: string): Promise<number[][]> {
  const img = await read(name);
  return Array.from({ length: img.shape.frames * img.shape.slices }, (_, k) => Array.from(getPlane(img, 0, img.shape.slices > 1 ? k : 0, img.shape.slices > 1 ? 0 : k)));
}
const expected = (f: (v: number) => number = (v) => v) => Array.from({ length: T }, (_, t) => Array.from({ length: Y * X }, (_, i) => f(pixel(t, Math.floor(i / X), i % X))));

describe("Zarr previews, as other tools write it", () => {
  it.each([
    "v2-blosc-lz4.zarr",
    "v2-blosc-blosclz.zarr",
    "v2-blosc-zstd.zarr",
    "v2-blosc-zlib-bitshuffle.zarr",
    "v2-blosc-lz4hc.zarr",
    "v2-gzip.zarr",
    "v2-zlib.zarr",
    "v2-lz4.zarr",
    "v2-bigendian.zarr",
    "v3-zstd.zarr",
    "v3-blosc.zarr",
    "v3-sharded.zarr",
  ])("reads %s, pixel for pixel", async (name) => {
    const img = await read(name);
    expect(img.shape).toMatchObject({ width: X, height: Y, frames: T, slices: 1, channels: 1 });
    expect(await frames(name)).toEqual(expected());
  });

  it("reads other element types: 8-bit, and float bit-shuffled", async () => {
    expect((await read("v2-uint8-blosc.zarr")).dtype).toBe("uint8");
    expect(await frames("v2-uint8-blosc.zarr")).toEqual(expected((v) => v % 256));
    expect((await read("v2-float32-blosc.zarr")).dtype).toBe("float32");
    expect(await frames("v2-float32-blosc.zarr")).toEqual(expected());
  });

  it("reads noise Blosc stored as it was, the same as an uncompressed copy", async () => {
    expect(await frames("v2-noise-blosc.zarr")).toEqual(await frames("v2-noise-raw.zarr"));
  });

  it("finds the image: bioformats2raw's 0/, a named plain array, a bare one", async () => {
    expect((await read("bioformats2raw.zarr")).shape).toMatchObject({ width: X, height: Y, frames: T, slices: 1, channels: 1 });
    expect(await frames("bioformats2raw.zarr")).toEqual(expected());
    expect((await read("plain-named.zarr")).shape).toMatchObject({ frames: T, slices: 1 });
    expect(await frames("plain-named.zarr")).toEqual(expected());
    // nothing named: three axes read as a stack, unless the name says it's a movie
    expect((await read("plain-bare.zarr")).shape).toMatchObject({ frames: 1, slices: T });
  });

  it("takes the first level of a pyramid small enough to preview", async () => {
    expect((await read("pyramid.zarr")).shape).toMatchObject({ width: X, height: Y });
    const small = await read("pyramid.zarr", T * (Y / 2) * (X / 2) * 4);
    expect(small.shape).toMatchObject({ width: X / 2, height: Y / 2, frames: T });
    expect(Array.from(getPlane(small, 0, 0, 1)).slice(0, 3)).toEqual([pixel(1, 0, 0), pixel(1, 0, 2), pixel(1, 0, 4)]);
    await expect(read("pyramid.zarr", 100)).rejects.toThrow(/too large to preview/);
  });
});
