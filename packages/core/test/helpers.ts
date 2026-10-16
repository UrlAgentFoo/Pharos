import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type DType, type Image, type Kernels, allocPlane, createImage, loadKernels } from "@pharos/core";

export const WASM_PATH = fileURLToPath(new URL("../wasm/pharos_kernels.wasm", import.meta.url));

export async function testKernels(): Promise<Kernels> {
  return loadKernels(await readFile(WASM_PATH));
}

/** Deterministic PRNG (mulberry32) so test images are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A structured test image: gradient + blobs + noise, scaled to the dtype's range. */
export function syntheticImage(dtype: DType, width: number, height: number, slices = 1, seed = 1): Image {
  const rand = rng(seed);
  const max = dtype === "uint8" ? 255 : dtype === "uint16" ? 4095 : 1;
  const planes = Array.from({ length: slices }, (_, z) => {
    const p = allocPlane(dtype, width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const g = (x / width) * 0.4 + (y / height) * 0.2;
        const dx = x - width * (0.3 + 0.1 * z);
        const dy = y - height * 0.5;
        const blob = Math.exp(-(dx * dx + dy * dy) / (2 * (width / 8) ** 2)) * 0.35;
        const edge = x > width * 0.7 && y < height * 0.4 ? 0.2 : 0;
        const v = (g + blob + edge + (rand() - 0.5) * 0.1) * max;
        p[y * width + x] = dtype === "float32" ? v - 0.1 : Math.max(0, Math.min(max, Math.round(v)));
      }
    }
    return p;
  });
  return createImage({ dtype, width, height, slices, planes });
}

/**
 * A particle test image: dark noisy background with bright blobs of several
 * sizes, two that touch, one cut by the left edge, and a ring with a hole.
 */
export function blobImage(dtype: DType, width = 96, height = 80, seed = 9): Image {
  const rand = rng(seed);
  const max = dtype === "uint8" ? 255 : dtype === "uint16" ? 4000 : 1;
  const blobs: [number, number, number][] = [
    [20, 18, 6],
    [48, 20, 9],
    [62, 22, 7], // touches the previous one
    [2, 50, 6], // cut by the left edge
    [30, 58, 3],
    [80, 60, 5],
    [56, 64, 2],
  ];
  const p = allocPlane(dtype, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0.08 + (rand() - 0.5) * 0.06;
      for (const [cx, cy, r] of blobs) {
        const d = Math.hypot(x - cx, y - cy);
        v += 0.8 / (1 + Math.exp((d - r) * 1.5));
      }
      // a ring: bright annulus with a dark hole
      const dr = Math.hypot(x - 76, y - 30);
      if (dr > 5 && dr < 10) v += 0.7;
      v = Math.min(1, Math.max(0, v));
      p[y * width + x] = dtype === "float32" ? v * 3 - 0.5 : Math.round(v * max);
    }
  }
  return createImage({ dtype, width, height, planes: [p], calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: "µm" } });
}
