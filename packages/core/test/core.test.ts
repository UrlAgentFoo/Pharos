import { describe, expect, it } from "vitest";
import {
  autoContrast,
  createImage,
  fromFloat,
  gaussianBlur,
  getPlane,
  invert,
  planeIndex,
  planeStats,
  readTiff,
  toDisplayIndices,
  writeTiff,
} from "@pharos/core";
import { syntheticImage, testKernels } from "./helpers.js";

describe("image model", () => {
  it("orders planes channel-fastest, then slice, then frame", () => {
    const shape = { width: 2, height: 2, channels: 2, slices: 3, frames: 2 };
    expect(planeIndex(shape, 0, 0, 0)).toBe(0);
    expect(planeIndex(shape, 1, 0, 0)).toBe(1);
    expect(planeIndex(shape, 0, 1, 0)).toBe(2);
    expect(planeIndex(shape, 1, 2, 1)).toBe(11);
    expect(() => planeIndex(shape, 2, 0, 0)).toThrow(RangeError);
  });

  it("validates plane count, size and type", () => {
    expect(() => createImage({ dtype: "uint8", width: 2, height: 2, slices: 2, planes: [new Uint8Array(4)] })).toThrow(/expected 2 planes/);
    expect(() => createImage({ dtype: "uint8", width: 2, height: 2, planes: [new Uint8Array(3)] })).toThrow(/3 pixels/);
    expect(() => createImage({ dtype: "uint8", width: 2, height: 2, planes: [new Uint16Array(4)] })).toThrow(TypeError);
    expect(() => createImage({ dtype: "uint8", width: 0, height: 2 })).toThrow(/width/);
  });
});

describe("ops", () => {
  it("computes ImageJ-style stats (sample std dev)", () => {
    const s = planeStats(new Uint8Array([1, 2, 3, 4]));
    expect(s).toMatchObject({ count: 4, min: 1, max: 4, mean: 2.5 });
    expect(s.stdDev).toBeCloseTo(Math.sqrt(5 / 3), 12);
  });

  it("inverts 8-bit as 255-v and 16-bit over the data range", () => {
    const u8 = createImage({ dtype: "uint8", width: 3, height: 1, planes: [new Uint8Array([0, 100, 255])] });
    expect(Array.from(invert(u8).planes[0])).toEqual([255, 155, 0]);
    const u16 = createImage({ dtype: "uint16", width: 3, height: 1, planes: [new Uint16Array([100, 150, 1100])] });
    expect(Array.from(invert(u16).planes[0])).toEqual([1100, 1050, 100]);
  });

  it("does not mutate its input", () => {
    const img = syntheticImage("uint8", 16, 16);
    const before = img.planes[0].slice();
    invert(img);
    expect(img.planes[0]).toEqual(before);
  });

  it("rounds float results back like ImageJ (+0.5, truncate, clamp)", () => {
    const out = fromFloat(new Float32Array([-3, 0.49, 0.5, 254.6, 300]), "uint8");
    expect(Array.from(out)).toEqual([0, 0, 1, 255, 255]);
  });

  it("blurs through the wasm kernels and keeps flat images flat", async () => {
    const k = await testKernels();
    const flat = createImage({ dtype: "uint16", width: 32, height: 24, planes: [new Uint16Array(32 * 24).fill(1234)] });
    const blurred = gaussianBlur(k, flat, { sigmaX: 2 });
    expect(blurred.dtype).toBe("uint16");
    expect(new Set(blurred.planes[0]).size).toBe(1);
    expect(blurred.planes[0][0]).toBe(1234);
  });

  it("reduces noise when blurring", async () => {
    const k = await testKernels();
    const img = syntheticImage("float32", 64, 64);
    const before = planeStats(img.planes[0]).stdDev;
    const after = planeStats(gaussianBlur(k, img, { sigmaX: 3 }).planes[0]).stdDev;
    expect(after).toBeLessThan(before);
  });
});

describe("TIFF", () => {
  for (const dtype of ["uint8", "uint16", "float32"] as const) {
    it(`round-trips a ${dtype} stack with calibration`, async () => {
      const img = { ...syntheticImage(dtype, 37, 21, 3), calibration: { pixelWidth: 0.25, pixelHeight: 0.25, pixelDepth: 1.5, unit: "µm", frameInterval: 0, timeUnit: "sec" } };
      const back = await readTiff(writeTiff(img));
      expect(back.dtype).toBe(dtype);
      expect(back.shape).toEqual(img.shape);
      back.planes.forEach((p, i) => expect(p).toEqual(img.planes[i]));
      expect(back.calibration.unit).toBe("µm");
      expect(back.calibration.pixelWidth).toBeCloseTo(0.25, 6);
      expect(back.calibration.pixelDepth).toBe(1.5);
    });
  }

  it("round-trips hyperstack dimensions", async () => {
    const img = createImage({ dtype: "uint8", width: 4, height: 3, channels: 2, slices: 3, frames: 2 });
    img.planes.forEach((p, i) => p.fill(i));
    const back = await readTiff(writeTiff(img));
    expect(back.shape).toEqual(img.shape);
    expect(getPlane(back, 1, 2, 1)[0]).toBe(11);
  });

  it("rejects garbage", async () => {
    await expect(readTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
  });
});

describe("display", () => {
  it("maps the display range linearly onto 0..255", () => {
    const idx = toDisplayIndices(new Float32Array([0, 0.5, 1, -1, 2, NaN]), 0, 1);
    expect(Array.from(idx)).toEqual([0, 128, 255, 0, 255, 0]);
  });

  it("auto contrast stays inside the data range", () => {
    const img = syntheticImage("uint16", 64, 64);
    const [lo, hi] = autoContrast(img.planes[0]);
    const s = planeStats(img.planes[0]);
    expect(lo).toBeGreaterThanOrEqual(s.min);
    expect(hi).toBeLessThanOrEqual(s.max + 1);
    expect(hi).toBeGreaterThan(lo);
  });
});
