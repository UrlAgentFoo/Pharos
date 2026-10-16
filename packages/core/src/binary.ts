/**
 * Binary morphology on 8-bit masks (0 = background, 255 = foreground, i.e.
 * ImageJ with "Black background" on), ported from ImageJ 1.x
 * (ByteProcessor.erode/dilate, BinaryProcessor.outline/skeletonize,
 * Binary.fill).
 */

const FG = 255;
const BG = 0;

/**
 * Process › Binary › Erode (or Dilate): a foreground pixel becomes background
 * when at least `count` of its 8 neighbours are background (Dilate: the
 * reverse). Pixels outside the image count as background, as in ImageJ
 * without "pad edges".
 */
export function erode(mask: Uint8Array, width: number, height: number, count = 1, iterations = 1): Uint8Array {
  return morph(mask, width, height, count, iterations, true);
}

export function dilate(mask: Uint8Array, width: number, height: number, count = 1, iterations = 1): Uint8Array {
  return morph(mask, width, height, count, iterations, false);
}

/** Open: erode then dilate (removes small specks). */
export function open(mask: Uint8Array, width: number, height: number, count = 1, iterations = 1): Uint8Array {
  return dilate(erode(mask, width, height, count, iterations), width, height, count, iterations);
}

/** Close: dilate then erode (fills small gaps). */
export function close(mask: Uint8Array, width: number, height: number, count = 1, iterations = 1): Uint8Array {
  return erode(dilate(mask, width, height, count, iterations), width, height, count, iterations);
}

function morph(mask: Uint8Array, width: number, height: number, count: number, iterations: number, eroding: boolean): Uint8Array {
  let src = mask;
  // erode: a foreground pixel is lost; dilate: a background pixel is gained
  const self = eroding ? FG : BG;
  const other = eroding ? BG : FG;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const p = src[i];
        if (p !== self) {
          out[i] = p;
          continue;
        }
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            const yy = y + dy;
            const v = xx < 0 || yy < 0 || xx >= width || yy >= height ? BG : src[yy * width + xx];
            if (v === other) n++;
          }
        }
        out[i] = n >= count ? other : self;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Process › Binary › Fill Holes: background regions that do not touch the
 * image edge (4-connected) become foreground.
 */
export function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const reached = new Uint8Array(mask.length);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * width + x;
    if (mask[i] === BG && !reached[i]) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let y = 0; y < height; y++) {
    seed(0, y);
    seed(width - 1, y);
  }
  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) seed(x - 1, y);
    if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < height - 1) seed(x, y + 1);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = reached[i] ? BG : FG;
  return out;
}

/**
 * Process › Binary › Outline: keeps the foreground pixels that touch the
 * background (8-neighbourhood). As in ImageJ, the one-pixel image border is
 * left unchanged.
 */
export function outline(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = mask.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] === BG) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && mask[i + dy * width + dx] === BG) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) out[i] = BG;
    }
  }
  return out;
}

// BinaryProcessor's thinning tables: for each 3x3 neighbourhood, 1 = delete on
// the first pass, 2 = on the second, 3 = on either
// prettier-ignore
const TABLE = [
  0,0,0,0,0,0,1,3,0,0,3,1,1,0,1,3,0,0,0,0,0,0,0,0,0,0,2,0,3,0,3,3,
  0,0,0,0,0,0,0,0,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,3,0,2,2,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,0,0,0,0,0,0,0,2,0,0,0,2,0,0,0,3,0,0,0,0,0,0,0,3,0,0,0,3,0,2,0,
  0,0,3,1,0,0,1,3,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
  3,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,3,1,3,0,0,1,3,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,3,0,1,0,0,0,1,0,0,0,0,0,0,0,0,3,3,0,1,0,0,0,0,2,2,0,0,2,0,0,0];
// prettier-ignore
const TABLE2 = [
  0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,2,2,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,2,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

/** Process › Binary › Skeletonize: thins foreground objects to one-pixel-wide lines. */
export function skeletonize(mask: Uint8Array, width: number, height: number): Uint8Array {
  // like ImageJ, work on a copy padded by one pixel when objects touch the edge
  let hasEdge = false;
  for (let x = 0; x < width && !hasEdge; x++) hasEdge = mask[x] === FG || mask[(height - 1) * width + x] === FG;
  for (let y = 0; y < height && !hasEdge; y++) hasEdge = mask[y * width] === FG || mask[y * width + width - 1] === FG;
  const w = hasEdge ? width + 2 : width;
  const h = hasEdge ? height + 2 : height;
  let px = new Uint8Array(w * h);
  if (hasEdge) for (let y = 0; y < height; y++) px.set(mask.subarray(y * width, (y + 1) * width), (y + 1) * w + 1);
  else px.set(mask);
  // the border becomes background
  for (let x = 0; x < w; x++) px[x] = px[(h - 1) * w + x] = BG;
  for (let y = 0; y < h; y++) px[y * w] = px[y * w + w - 1] = BG;

  let pass = 0;
  const thin = (table: number[]): number => {
    const src = px.slice();
    let removed = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] === BG) continue;
        let index = 0;
        if (src[i - w - 1] !== BG) index |= 1;
        if (src[i - w] !== BG) index |= 2;
        if (src[i - w + 1] !== BG) index |= 4;
        if (src[i + 1] !== BG) index |= 8;
        if (src[i + w + 1] !== BG) index |= 16;
        if (src[i + w] !== BG) index |= 32;
        if (src[i + w - 1] !== BG) index |= 64;
        if (src[i - 1] !== BG) index |= 128;
        const code = table[index];
        const odd = (pass & 1) === 1;
        if (odd ? code === 2 || code === 3 : code === 1 || code === 3) {
          px[i] = BG;
          removed++;
        }
      }
    }
    pass++;
    return removed;
  };
  let removed: number;
  do {
    removed = thin(TABLE);
    removed += thin(TABLE);
  } while (removed > 0);
  do {
    removed = thin(TABLE2);
    removed += thin(TABLE2);
  } while (removed > 0);

  if (!hasEdge) return px;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(px.subarray((y + 1) * w + 1, (y + 1) * w + 1 + width), y * width);
  return out;
}
