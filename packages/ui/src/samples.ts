/** Synthetic sample images, so Pharos can be tried without any files. */
import { type Image, createImage } from "@pharos/core";

function prng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** A 16-bit, 3-slice field of fluorescent "cells". */
export function sampleCells(): Image {
  const width = 384;
  const height = 256;
  const slices = 3;
  const planes = Array.from({ length: slices }, (_, z) => {
    const p = new Uint16Array(width * height);
    const rand = prng(12345 + z);
    const cells = Array.from({ length: 40 }, () => [rand() * width, rand() * height, 6 + rand() * 14, 600 + rand() * 2400]);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 300 + 200 * Math.sin(x / 40 + z) * Math.cos(y / 55);
        for (const [cx, cy, r, b] of cells) {
          const d2 = (x - cx - z * 4) ** 2 + (y - cy) ** 2;
          v += b * Math.exp(-d2 / (2 * r * r));
        }
        p[y * width + x] = Math.max(0, Math.min(65535, Math.round(v + (rand() - 0.5) * 300)));
      }
    }
    return p;
  });
  return createImage({ dtype: "uint16", width, height, slices, planes, name: "sample-cells.tif", calibration: { pixelWidth: 0.16, pixelHeight: 0.16, unit: "µm" } });
}

/**
 * A 3D, two-channel 16-bit volume (a confocal-style z-stack): channel 1 shows
 * cell membranes as ellipsoidal shells, channel 2 their nuclei. 160×160×40
 * voxels of 0.2×0.2×0.5 µm.
 */
export function sampleVolume(): Image {
  const width = 160;
  const height = 160;
  const slices = 40;
  const dz = 2.5; // z voxels are 2.5× deeper than they are wide
  const rand = prng(777);
  const cells = Array.from({ length: 9 }, () => {
    const r = 18 + rand() * 14;
    return {
      x: 25 + rand() * 110,
      y: 25 + rand() * 110,
      z: (8 + rand() * 24) * dz,
      rx: r,
      ry: r * (0.75 + rand() * 0.4),
      rz: r * (0.55 + rand() * 0.25),
      nucleus: 0.42 + rand() * 0.12,
      bright: 0.7 + rand() * 0.6,
    };
  });
  const membrane: Uint16Array[] = [];
  const nuclei: Uint16Array[] = [];
  for (let z = 0; z < slices; z++) {
    const m = new Uint16Array(width * height);
    const n = new Uint16Array(width * height);
    const noise = prng(1000 + z);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let mv = 180;
        let nv = 140;
        for (const c of cells) {
          const d = Math.sqrt(((x - c.x) / c.rx) ** 2 + ((y - c.y) / c.ry) ** 2 + ((z * dz - c.z) / c.rz) ** 2);
          mv += 2600 * c.bright * Math.exp(-(((d - 1) / 0.07) ** 2)); // thin shell at d = 1
          if (d < c.nucleus * 1.4) nv += 3200 * c.bright / (1 + Math.exp((d - c.nucleus) / 0.03)); // soft-edged solid core
        }
        const i = y * width + x;
        m[i] = Math.min(65535, Math.round(mv + (noise() - 0.5) * 160));
        n[i] = Math.min(65535, Math.round(nv + (noise() - 0.5) * 160));
      }
    }
    membrane.push(m);
    nuclei.push(n);
  }
  // hyperstack order: channel varies fastest
  const planes = Array.from({ length: slices }, (_, z) => [membrane[z], nuclei[z]]).flat();
  return createImage({
    dtype: "uint16",
    width,
    height,
    channels: 2,
    slices,
    planes,
    name: "sample-3d-cells.tif",
    calibration: { pixelWidth: 0.2, pixelHeight: 0.2, pixelDepth: 0.5, unit: "µm" },
  });
}
