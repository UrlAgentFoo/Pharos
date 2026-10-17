import { type DType, type Image, allocPlane, createImage } from "@pharos/core";

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
