/**
 * Analyze › Analyze Particles, ported from ImageJ 1.x (ParticleAnalyzer,
 * Wand, FloodFiller). Particles are 8-connected regions of pixels inside a
 * threshold range. Each is traced, optionally filtered by size and
 * circularity, measured like Analyze › Measure, and returned with its
 * outline.
 */
import type { Calibration, PixelArray } from "./image.js";
import { dtypeOf } from "./image.js";
import { type Measurement, type Roi, measure, polygonMask, roiBounds } from "./roi.js";

export interface ParticleOptions {
  /** Threshold range: pixels with lower <= value <= upper are particles. */
  lower: number;
  upper: number;
  /** Size range in pixels (the dialog converts calibrated units). */
  minSize?: number;
  maxSize?: number;
  /** Circularity range, 0..1. */
  minCircularity?: number;
  maxCircularity?: number;
  /** Drop particles touching the image edge. */
  excludeEdges?: boolean;
  /** Count holes inside particles as part of them. */
  includeHoles?: boolean;
}

export interface Particle {
  /** The traced outline. */
  roi: Roi & { type: "traced" };
  measurement: Measurement;
}

export interface ParticleResult {
  particles: Particle[];
  summary: { Count: number; "Total Area": number; "Average Size": number; "%Area": number; Mean: number };
}

/**
 * Finds and measures the particles in a plane. `measurePlane` (default:
 * `plane`) is where intensities are measured, like ImageJ's "Redirect to".
 */
export function analyzeParticles(
  plane: PixelArray,
  width: number,
  height: number,
  cal: Pick<Calibration, "pixelWidth" | "pixelHeight">,
  opts: ParticleOptions,
  measurePlane: PixelArray = plane,
): ParticleResult {
  const { lower: level1, upper: level2 } = opts;
  const minSize = opts.minSize ?? 0;
  const maxSize = opts.maxSize ?? Infinity;
  const minCirc = opts.minCircularity ?? 0;
  const maxCirc = opts.maxCircularity ?? 1;
  const floodFill = !opts.includeHoles;
  const type = dtypeOf(plane);

  // the colour analysed particles are painted, so they are not found again
  let fillColor: number;
  if (type === "uint8") fillColor = level1 > 0 ? 0 : level2 < 255 ? 255 : 0;
  else if (type === "uint16") fillColor = level1 > 0 ? 0 : level2 < 65535 ? 65535 : 0;
  else fillColor = -3.4028234663852886e38; // -Float.MAX_VALUE

  const work = Float64Array.from(plane); // scanned and painted as particles are found
  const ffWork = Float64Array.from(plane); // the flood filler's own copy
  const inRange = (v: number) => v >= level1 && v <= level2;
  const wand = new Wand(work, width, height);
  const particles: Particle[] = [];
  let done = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (done || !inRange(work[y * width + x])) continue;
      // trace the particle
      const pts = wand.autoOutline(x, y, level1, level2);
      if (!pts.length) continue;
      const roi: Roi & { type: "traced" } = { type: "traced", points: pts };
      const b = roiBounds(roi);
      let mask: Uint8Array | null = null;
      if (b.width > 1 && b.height > 1) {
        if (floodFill) mask = floodParticle(ffWork, width, height, x, y, level1, level2, b, fillColor);
        else mask = polygonMask(pts.map((p) => p[0] - b.x), pts.map((p) => p[1] - b.y), b.width, b.height);
      }
      const m = measure(measurePlane, width, height, cal, roi, { mask, bounds: b });
      const pixelCount = Math.round(m.Area / (cal.pixelWidth * cal.pixelHeight));
      let include = true;
      if (opts.excludeEdges && (b.x === 0 || b.y === 0 || b.x + b.width === width || b.y + b.height === height)) include = false;
      if (minCirc > 0 || maxCirc !== 1) {
        // the filter uses uncalibrated perimeter and pixel count, as ImageJ does
        const perimeter = tracedPerimeterPx(pts);
        let circ = perimeter === 0 ? 0 : 4 * Math.PI * (pixelCount / (perimeter * perimeter));
        if (circ > 1 && maxCirc <= 1) circ = 1;
        if (circ < minCirc || circ > maxCirc) include = false;
      }
      if (pixelCount >= minSize && pixelCount <= maxSize && include) particles.push({ roi, measurement: m });
      // paint the particle so the scan skips it
      for (let yy = b.y, my = 0; yy < b.y + b.height; yy++, my++) {
        for (let xx = b.x, mx = 0; xx < b.x + b.width; xx++, mx++) {
          if (!mask || mask[my * b.width + mx]) work[yy * width + xx] = fillColor;
        }
      }
      done = level1 === 0 && level2 === 255 && type === "uint8";
    }
  }

  const totalArea = width * cal.pixelWidth * height * cal.pixelHeight;
  const sum = particles.reduce((s, p) => s + p.measurement.Area, 0);
  const meanOfMeans = particles.length ? particles.reduce((s, p) => s + p.measurement.Mean, 0) / particles.length : NaN;
  return {
    particles,
    summary: { Count: particles.length, "Total Area": sum, "Average Size": sum / particles.length, "%Area": (sum * 100) / totalArea, Mean: meanOfMeans },
  };
}

function tracedPerimeterPx(p: [number, number][]): number {
  const n = p.length;
  if (n < 4) return 0;
  let sumdx = 0;
  let sumdy = 0;
  let nCorners = 0;
  let dx1 = p[0][0] - p[n - 1][0];
  let dy1 = p[0][1] - p[n - 1][1];
  let side1 = Math.abs(dx1) + Math.abs(dy1);
  let corner = false;
  for (let i = 0; i < n; i++) {
    const next = i + 1 === n ? 0 : i + 1;
    const dx2 = p[next][0] - p[i][0];
    const dy2 = p[next][1] - p[i][1];
    sumdx += Math.abs(dx1);
    sumdy += Math.abs(dy1);
    const side2 = Math.abs(dx2) + Math.abs(dy2);
    if (side1 > 1 || !corner) {
      corner = true;
      nCorners++;
    } else corner = false;
    dx1 = dx2;
    dy1 = dy2;
    side1 = side2;
  }
  return sumdx + sumdy - nCorners * (2 - Math.SQRT2);
}

/**
 * FloodFiller.particleAnalyzerFill: the 8-connected region of in-range
 * pixels from (x, y), as a mask over `b`; the region is painted in `img`.
 */
function floodParticle(
  img: Float64Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  level1: number,
  level2: number,
  b: { x: number; y: number; width: number; height: number },
  fillColor: number,
): Uint8Array {
  const mask = new Uint8Array(b.width * b.height);
  const inParticle = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const v = img[y * width + x];
    return v >= level1 && v <= level2;
  };
  const stack: number[] = [x0, y0];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (!inParticle(x, y)) continue;
    let x1 = x;
    let x2 = x;
    while (inParticle(x1, y) && x1 >= 0) x1--;
    x1++;
    while (inParticle(x2, y) && x2 < width) x2++;
    x2--;
    for (let i = x1; i <= x2; i++) {
      mask[(y - b.y) * b.width + (i - b.x)] = 255;
      img[y * width + i] = fillColor;
    }
    let inLine = false;
    const a = x1 > 0 ? x1 - 1 : x1;
    const z = x2 < width - 1 ? x2 + 1 : x2;
    for (let i = a; i <= z; i++) {
      if (!inLine && y > 0 && inParticle(i, y - 1)) {
        stack.push(i, y - 1);
        inLine = true;
      } else if (inLine && y > 0 && !inParticle(i, y - 1)) inLine = false;
    }
    inLine = false;
    for (let i = a; i <= z; i++) {
      if (!inLine && y < height - 1 && inParticle(i, y + 1)) {
        stack.push(i, y + 1);
        inLine = true;
      } else if (inLine && y < height - 1 && !inParticle(i, y + 1)) inLine = false;
    }
  }
  return mask;
}

/**
 * ImageJ's Wand in thresholded "legacy" mode, as the particle analyzer uses
 * it: traces the outline of the 8-connected region containing (x, y).
 * Outline vertices lie on pixel corners.
 */
export class Wand {
  private lower = 0;
  private upper = 0;
  private xs: number[] = [];
  private ys: number[] = [];

  constructor(
    private readonly px: ArrayLike<number>,
    private readonly width: number,
    private readonly height: number,
  ) {}

  autoOutline(startX: number, startY: number, lower: number, upper: number): [number, number][] {
    // the Wand stores its thresholds as floats
    this.lower = Math.fround(lower);
    this.upper = Math.fround(upper);
    if (startX < 0 || startX >= this.width || startY < 0 || startY >= this.height) return [];
    let x = startX;
    const y = startY;
    if (this.inside(x, y)) {
      do x++;
      while (this.inside(x, y));
    } else {
      do {
        x++;
        if (x >= this.width) return [];
      } while (!this.inside(x, y));
    }
    this.traceEdge(x, y);
    return this.xs.map((xx, i) => [xx, this.ys[i]]);
  }

  private traceEdge(startX: number, startY: number) {
    this.xs = [];
    this.ys = [];
    let startDirection: number;
    if (this.inside(startX, startY)) startDirection = 1;
    else {
      startDirection = 3;
      startY++;
    }
    let x = startX;
    let y = startY;
    let direction = startDirection;
    do {
      // 8-connected
      let newDirection = direction + 1;
      do {
        if (this.insideDir(x, y, newDirection)) break;
        newDirection--;
      } while (newDirection >= direction);
      if (newDirection !== direction) {
        this.xs.push(x);
        this.ys.push(y);
      }
      switch (newDirection & 3) {
        case 0:
          x++;
          break;
        case 1:
          y--;
          break;
        case 2:
          x--;
          break;
        case 3:
          y++;
          break;
      }
      direction = newDirection;
    } while (x !== startX || y !== startY || (direction & 3) !== startDirection);
    if (this.xs[0] !== x) {
      this.xs.push(x);
      this.ys.push(y);
    }
  }

  private inside(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    const v = Math.fround(this.px[y * this.width + x]);
    return v >= this.lower && v <= this.upper;
  }

  private insideDir(x: number, y: number, direction: number): boolean {
    switch (direction & 3) {
      case 0:
        return this.inside(x, y);
      case 1:
        return this.inside(x, y - 1);
      case 2:
        return this.inside(x - 1, y - 1);
      default:
        return this.inside(x - 1, y);
    }
  }
}
