import { describe, expect, it } from "vitest";
import { autoContrast, createImage, getPlane, minMax, planeIndex, readTiff, toDisplayIndices, withDefaults, writeTiff } from "@pharos/core";
import { syntheticImage } from "./helpers.js";

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

describe("parameter checking", () => {
  const specs = [
    { name: "model", type: "enum" as const, options: ["cyto3", "nuclei"], default: "cyto3" },
    { name: "diameter", type: "number" as const, unit: "px", default: 30, min: 1 },
  ];
  it("fills defaults and rejects bad values", () => {
    expect(withDefaults(specs, {})).toEqual({ model: "cyto3", diameter: 30 });
    expect(() => withDefaults(specs, { model: "cyto9" })).toThrow(/one of cyto3, nuclei/);
    expect(() => withDefaults(specs, { diameter: "30" })).toThrow(/a number/);
    expect(() => withDefaults(specs, { diameter: 0 })).toThrow(/between 1/);
    expect(() => withDefaults(specs, { sigma: 1 })).toThrow(/unknown parameter "sigma"/);
    expect(() => withDefaults([{ name: "n", type: "integer" }], {})).toThrow(/required/);
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
    const [min, max] = minMax(img.planes[0]);
    expect(lo).toBeGreaterThanOrEqual(min);
    expect(hi).toBeLessThanOrEqual(max + 1);
    expect(hi).toBeGreaterThan(lo);
  });
});
