import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPlane } from "@pharos/core";
import { type PreviewBudget, readZarrImage } from "../src/zarr.js";

// written by fixtures/make_zarr_fixtures.py with zarr-python and numcodecs: a movie of t, y, x = 3, 20, 24
const FIXTURES = fileURLToPath(new URL("./fixtures/zarr/", import.meta.url));
const [T, Y, X] = [3, 20, 24];
const pixel = (t: number, y: number, x: number) => (t * 7919 + y * 31 + x * 3) % 65536;
const preview = (name: string, limits?: Partial<PreviewBudget>) => readZarrImage(join(FIXTURES, name), name, limits);
const read = async (name: string, limits?: Partial<PreviewBudget>) => (await preview(name, limits)).image;

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

  it("shows small images whole, with nothing to say", async () => {
    expect((await preview("v3-zstd.zarr")).note).toBeUndefined();
  });

  it("previews what fits of a larger image, and says what it left out", async () => {
    // a pyramid: the first level no wider than the preview
    const level = await preview("pyramid.zarr", { maxSide: 12 });
    expect(level.image.shape).toMatchObject({ width: X / 2, height: Y / 2, frames: T });
    expect(Array.from(getPlane(level.image, 0, 0, 1)).slice(0, 3)).toEqual([pixel(1, 0, 0), pixel(1, 0, 2), pixel(1, 0, 4)]);
    expect(level.note).toBe("A preview: level 2 of 2 of its pyramid");
    // no pyramid: every n-th pixel
    const thin = await preview("v3-zstd.zarr", { maxSide: 8 });
    expect(thin.image.shape).toMatchObject({ width: 8, height: 7, frames: T });
    expect(getPlane(thin.image, 0, 0, 2)[1 * 8 + 1]).toBe(pixel(2, 3, 3));
    expect(thin.image.calibration.pixelWidth).toBe(3);
    expect(thin.note).toBe("A preview: every 3rd pixel");
    // more frames than fit: every n-th, the frame interval to match
    const frames = await preview("v3-sharded.zarr", { maxBytes: Y * X * 2 * 2 });
    expect(frames.image.shape).toMatchObject({ width: X, frames: 2 });
    expect(Array.from(getPlane(frames.image, 0, 0, 1)).slice(0, 2)).toEqual([pixel(2, 0, 0), pixel(2, 0, 1)]);
    expect(frames.note).toBe("A preview: 1 in 2 frames");
  });

  it("keeps a stack's slices, at lower resolution, rather than skip slices", async () => {
    const room = { maxBytes: Y * X * 2 * 2 }; // two full planes
    // the stack can't go below 6 pixels across: halving to 12 × 10 fits all three slices
    const whole = await preview("plain-bare.zarr", { ...room, minSide: 6 });
    expect(whole.image.shape).toMatchObject({ width: X / 2, height: Y / 2, slices: T });
    expect(whole.note).toBe("A preview: every 2nd pixel");
    // where it may not shrink further: every other slice
    const skipped = await preview("plain-bare.zarr", { ...room, minSide: 20 });
    expect(skipped.image.shape).toMatchObject({ width: X, slices: 2 });
    expect(skipped.note).toBe("A preview: 1 in 2 slices");
  });
});
