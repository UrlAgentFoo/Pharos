/**
 * Thresholding, ported from ImageJ 1.x: AutoThresholder (G. Landini's
 * Auto_Threshold methods) and ImageProcessor.setAutoThreshold, including how
 * 16-bit and float images are binned to 256 levels and the levels mapped
 * back. Integer arithmetic (including Java int overflow) is reproduced, so
 * thresholds match ImageJ exactly.
 */
import { type PixelArray, dtypeOf } from "./image.js";

export const THRESHOLD_METHODS = [
  "Default",
  "Huang",
  "Intermodes",
  "IsoData",
  "IJ_IsoData",
  "Li",
  "MaxEntropy",
  "Mean",
  "MinError",
  "Minimum",
  "Moments",
  "Otsu",
  "Percentile",
  "RenyiEntropy",
  "Shanbhag",
  "Triangle",
  "Yen",
] as const;

export type ThresholdMethod = (typeof THRESHOLD_METHODS)[number];

const EPS = 2.220446049250313e-16;
const DOUBLE_MIN = 4.9e-324; // Java's Double.MIN_VALUE
const DOUBLE_MAX = Number.MAX_VALUE;
/** Java int arithmetic: wrap to 32 bits. */
const int = (v: number) => v | 0;

/** AutoThresholder.getThreshold on a 256-bin histogram (with bilevel images handled as ImageJ does). */
export function autoThresholdLevel(method: ThresholdMethod, histogram: ArrayLike<number>, bilevelSubtractOne = true): number {
  const data = Array.from(histogram, (v) => int(v));
  const bi = bilevel(data, bilevelSubtractOne);
  if (bi >= 0) return bi;
  let t: number;
  switch (method) {
    case "Default":
      t = defaultIsoData(data);
      break;
    case "IJ_IsoData":
      t = ijIsoData(data);
      break;
    case "Huang":
      t = huang(data);
      break;
    case "Intermodes":
      t = intermodes(data);
      break;
    case "IsoData":
      t = isoData(data);
      break;
    case "Li":
      t = li(data);
      break;
    case "MaxEntropy":
      t = maxEntropy(data);
      break;
    case "Mean":
      t = mean(data);
      break;
    case "MinError":
      t = minErrorI(data);
      break;
    case "Minimum":
      t = minimum(data);
      break;
    case "Moments":
      t = moments(data);
      break;
    case "Otsu":
      t = otsu(data);
      break;
    case "Percentile":
      t = percentile(data);
      break;
    case "RenyiEntropy":
      t = renyiEntropy(data);
      break;
    case "Shanbhag":
      t = shanbhag(data);
      break;
    case "Triangle":
      t = triangle(data);
      break;
    case "Yen":
      t = yen(data);
      break;
  }
  return t === -1 ? 0 : t;
}

function bilevel(data: number[], subtractOne: boolean): number {
  let first = -1;
  let second = -1;
  let nonZero = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) {
      nonZero++;
      if (nonZero > 2) return -1;
      if (first === -1) first = i;
      else second = i;
    }
  }
  if (nonZero === 1) return first - (subtractOne ? 1 : 0);
  if (nonZero === 2) return second - (subtractOne ? 1 : 0);
  return -1;
}

function defaultIsoData(data: number[]): number {
  const n = data.length;
  const data2 = data.slice();
  let mode = 0;
  let maxCount = 0;
  for (let i = 0; i < n; i++) {
    if (data2[i] > maxCount) {
      maxCount = data2[i];
      mode = i;
    }
  }
  let maxCount2 = 0;
  for (let i = 0; i < n; i++) if (data2[i] > maxCount2 && i !== mode) maxCount2 = data2[i];
  let hmax = maxCount;
  if (hmax > maxCount2 * 2 && maxCount2 !== 0) {
    hmax = Math.trunc(maxCount2 * 1.5);
    data2[mode] = hmax;
  }
  return ijIsoData(data2);
}

function ijIsoData(data: number[]): number {
  const maxValue = data.length - 1;
  const count0 = data[0];
  data[0] = 0; // so erased areas are not included
  const countMax = data[maxValue];
  data[maxValue] = 0;
  let min = 0;
  while (data[min] === 0 && min < maxValue) min++;
  let max = maxValue;
  while (data[max] === 0 && max > 0) max--;
  if (min >= max) {
    data[0] = count0;
    data[maxValue] = countMax;
    return Math.trunc(data.length / 2);
  }
  let moving = min;
  let result: number;
  do {
    let sum1 = 0;
    let sum2 = 0;
    let sum3 = 0;
    let sum4 = 0;
    for (let i = min; i <= moving; i++) {
      sum1 += i * data[i];
      sum2 += data[i];
    }
    for (let i = moving + 1; i <= max; i++) {
      sum3 += i * data[i];
      sum4 += data[i];
    }
    result = (sum1 / sum2 + sum3 / sum4) / 2.0;
    moving++;
  } while (moving + 1 <= result && moving < max - 1);
  data[0] = count0;
  data[maxValue] = countMax;
  return javaRound(result);
}

/** Java's Math.round: floor(x + 0.5). */
const javaRound = (x: number) => Math.floor(x + 0.5);

function huang(data: number[]): number {
  let first = 0;
  for (let ih = 0; ih < data.length; ih++) {
    if (data[ih] !== 0) {
      first = ih;
      break;
    }
  }
  let last = data.length - 1;
  for (let ih = data.length - 1; ih >= first; ih--) {
    if (data[ih] !== 0) {
      last = ih;
      break;
    }
  }
  const term = 1.0 / (last - first);
  const mu0 = new Float64Array(data.length);
  let sumPix = 0;
  let numPix = 0;
  for (let ih = first; ih < data.length; ih++) {
    sumPix = int(sumPix + int(ih * data[ih]));
    numPix = int(numPix + data[ih]);
    mu0[ih] = sumPix / numPix;
  }
  const mu1 = new Float64Array(data.length);
  sumPix = numPix = 0;
  for (let ih = last; ih > 0; ih--) {
    sumPix = int(sumPix + int(ih * data[ih]));
    numPix = int(numPix + data[ih]);
    mu1[ih - 1] = sumPix / numPix;
  }
  let threshold = -1;
  let minEnt = DOUBLE_MAX;
  for (let it = 0; it < data.length; it++) {
    let ent = 0.0;
    for (let ih = 0; ih <= it; ih++) {
      const mu = 1.0 / (1.0 + term * Math.abs(ih - mu0[it]));
      if (!(mu < 1e-6 || mu > 0.999999)) ent += data[ih] * (-mu * Math.log(mu) - (1.0 - mu) * Math.log(1.0 - mu));
    }
    for (let ih = it + 1; ih < data.length; ih++) {
      const mu = 1.0 / (1.0 + term * Math.abs(ih - mu1[it]));
      if (!(mu < 1e-6 || mu > 0.999999)) ent += data[ih] * (-mu * Math.log(mu) - (1.0 - mu) * Math.log(1.0 - mu));
    }
    if (ent < minEnt) {
      minEnt = ent;
      threshold = it;
    }
  }
  return threshold;
}

function bimodalTest(y: Float64Array): boolean {
  let modes = 0;
  for (let k = 1; k < y.length - 1; k++) {
    if (y[k - 1] < y[k] && y[k + 1] < y[k]) {
      modes++;
      if (modes > 2) return false;
    }
  }
  return modes === 2;
}

function intermodes(data: number[]): number {
  const h = Float64Array.from(data);
  let iter = 0;
  while (!bimodalTest(h)) {
    let previous = 0;
    let current = 0;
    let next = h[0];
    for (let i = 0; i < data.length - 1; i++) {
      previous = current;
      current = next;
      next = h[i + 1];
      h[i] = (previous + current + next) / 3;
    }
    h[data.length - 1] = (current + next) / 3;
    if (++iter > 10000) return -1;
  }
  let tt = 0;
  for (let i = 1; i < data.length - 1; i++) if (h[i - 1] < h[i] && h[i + 1] < h[i]) tt += i;
  return Math.floor(tt / 2.0);
}

function isoData(data: number[]): number {
  let g = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] > 0) {
      g = i + 1;
      break;
    }
  }
  for (;;) {
    let l = 0;
    let totl = 0;
    for (let i = 0; i < g; i++) {
      totl = int(totl + data[i]);
      l = int(l + int(data[i] * i));
    }
    let h = 0;
    let toth = 0;
    for (let i = g + 1; i < data.length; i++) {
      toth = int(toth + data[i]);
      h = int(h + int(data[i] * i));
    }
    if (totl > 0 && toth > 0) {
      l = Math.trunc(l / totl);
      h = Math.trunc(h / toth);
      if (g === javaRound((l + h) / 2.0)) break;
    }
    g++;
    if (g > data.length - 2) return -1;
  }
  return g;
}

function li(data: number[]): number {
  let numPixels = 0;
  for (let ih = 0; ih < data.length; ih++) numPixels = int(numPixels + data[ih]);
  let meanAll = 0.0;
  for (let ih = 0; ih < data.length; ih++) meanAll += int(ih * data[ih]);
  meanAll /= numPixels;
  let newThresh = meanAll;
  let oldThresh: number;
  let threshold: number;
  do {
    oldThresh = newThresh;
    threshold = Math.trunc(oldThresh + 0.5);
    let sumBack = 0;
    let numBack = 0;
    for (let ih = 0; ih <= threshold; ih++) {
      sumBack = int(sumBack + int(ih * data[ih]));
      numBack = int(numBack + data[ih]);
    }
    const meanBack = numBack === 0 ? 0.0 : sumBack / numBack;
    let sumObj = 0;
    let numObj = 0;
    for (let ih = threshold + 1; ih < data.length; ih++) {
      sumObj = int(sumObj + int(ih * data[ih]));
      numObj = int(numObj + data[ih]);
    }
    const meanObj = numObj === 0 ? 0.0 : sumObj / numObj;
    const temp = (meanBack - meanObj) / (Math.log(meanBack) - Math.log(meanObj));
    newThresh = temp < -EPS ? Math.trunc(temp - 0.5) : Math.trunc(temp + 0.5);
  } while (Math.abs(newThresh - oldThresh) > 0.5);
  return threshold;
}

/** Normalised and cumulative histograms shared by the entropy methods. */
function cumulative(data: number[]) {
  let total = 0;
  for (const v of data) total = int(total + v);
  const norm = data.map((v) => v / total);
  const P1 = new Float64Array(data.length);
  const P2 = new Float64Array(data.length);
  P1[0] = norm[0];
  P2[0] = 1.0 - P1[0];
  for (let ih = 1; ih < data.length; ih++) {
    P1[ih] = P1[ih - 1] + norm[ih];
    P2[ih] = 1.0 - P1[ih];
  }
  let first = 0;
  for (let ih = 0; ih < data.length; ih++) {
    if (!(Math.abs(P1[ih]) < EPS)) {
      first = ih;
      break;
    }
  }
  let last = data.length - 1;
  for (let ih = data.length - 1; ih >= first; ih--) {
    if (!(Math.abs(P2[ih]) < EPS)) {
      last = ih;
      break;
    }
  }
  return { norm, P1, P2, first, last };
}

function maxEntropy(data: number[]): number {
  const { norm, P1, P2, first, last } = cumulative(data);
  let threshold = -1;
  let maxEnt = DOUBLE_MIN;
  for (let it = first; it <= last; it++) {
    let back = 0.0;
    for (let ih = 0; ih <= it; ih++) if (data[ih] !== 0) back -= (norm[ih] / P1[it]) * Math.log(norm[ih] / P1[it]);
    let obj = 0.0;
    for (let ih = it + 1; ih < data.length; ih++) if (data[ih] !== 0) obj -= (norm[ih] / P2[it]) * Math.log(norm[ih] / P2[it]);
    const tot = back + obj;
    if (maxEnt < tot) {
      maxEnt = tot;
      threshold = it;
    }
  }
  return threshold;
}

function mean(data: number[]): number {
  // Java longs: exact for any realistic histogram
  let tot = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    tot += data[i];
    sum += i * data[i];
  }
  return Math.floor(Math.trunc(sum / tot));
}

function A(y: number[], j: number) {
  let x = 0;
  for (let i = 0; i <= j; i++) x += y[i];
  return x;
}
function B(y: number[], j: number) {
  let x = 0;
  for (let i = 0; i <= j; i++) x += Math.imul(i, y[i]);
  return x;
}
function C(y: number[], j: number) {
  let x = 0;
  for (let i = 0; i <= j; i++) x += Math.imul(Math.imul(i, i), y[i]);
  return x;
}

function minErrorI(data: number[]): number {
  let threshold = mean(data);
  let prev = -2;
  const L = data.length - 1;
  while (threshold !== prev) {
    const mu = B(data, threshold) / A(data, threshold);
    const nu = (B(data, L) - B(data, threshold)) / (A(data, L) - A(data, threshold));
    const p = A(data, threshold) / A(data, L);
    const q = (A(data, L) - A(data, threshold)) / A(data, L);
    const sigma2 = C(data, threshold) / A(data, threshold) - mu * mu;
    const tau2 = (C(data, L) - C(data, threshold)) / (A(data, L) - A(data, threshold)) - nu * nu;
    const w0 = 1.0 / sigma2 - 1.0 / tau2;
    const w1 = mu / sigma2 - nu / tau2;
    const w2 = (mu * mu) / sigma2 - (nu * nu) / tau2 + Math.log10((sigma2 * (q * q)) / (tau2 * (p * p)));
    const sq = w1 * w1 - w0 * w2;
    if (sq < 0) return threshold; // not converging
    prev = threshold;
    const temp = (w1 + Math.sqrt(sq)) / w0;
    threshold = Number.isNaN(temp) ? prev : Math.floor(temp);
  }
  return threshold;
}

function minimum(data: number[]): number {
  if (data.length < 2) return 0;
  let max = -1;
  const h = Float64Array.from(data);
  for (let i = 0; i < data.length; i++) if (data[i] > 0) max = i;
  const t = new Float64Array(h.length);
  let iter = 0;
  while (!bimodalTest(h)) {
    for (let i = 1; i < data.length - 1; i++) t[i] = (h[i - 1] + h[i] + h[i + 1]) / 3;
    t[0] = (h[0] + h[1]) / 3;
    t[data.length - 1] = (h[data.length - 2] + h[data.length - 1]) / 3;
    h.set(t);
    if (++iter > 10000) return -1;
  }
  for (let i = 1; i < max; i++) if (h[i - 1] > h[i] && h[i + 1] >= h[i]) return i;
  return -1;
}

function moments(data: number[]): number {
  let total = 0;
  for (const v of data) total += v;
  const histo = data.map((v) => v / total);
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  const m0 = 1.0;
  for (let i = 0; i < data.length; i++) {
    m1 += i * histo[i];
    m2 += Math.imul(i, i) * histo[i];
    m3 += Math.imul(Math.imul(i, i), i) * histo[i];
  }
  const cd = m0 * m2 - m1 * m1;
  const c0 = (-m2 * m2 + m1 * m3) / cd;
  const c1 = (m0 * -m3 + m2 * m1) / cd;
  const z0 = 0.5 * (-c1 - Math.sqrt(c1 * c1 - 4.0 * c0));
  const z1 = 0.5 * (-c1 + Math.sqrt(c1 * c1 - 4.0 * c0));
  const p0 = (z1 - m1) / (z1 - z0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += histo[i];
    if (sum > p0) return i;
  }
  return -1;
}

function otsu(data: number[]): number {
  let numPixels = 0;
  for (const v of data) numPixels = int(numPixels + v);
  const term = 1.0 / numPixels;
  const histo = data.map((v) => term * v);
  const cnh = new Float64Array(data.length);
  const meanH = new Float64Array(data.length);
  cnh[0] = histo[0];
  for (let ih = 1; ih < data.length; ih++) cnh[ih] = cnh[ih - 1] + histo[ih];
  meanH[0] = 0.0;
  for (let ih = 1; ih < data.length; ih++) meanH[ih] = meanH[ih - 1] + ih * histo[ih];
  const totalMean = meanH[data.length - 1];
  let threshold = -2147483648; // Integer.MIN_VALUE
  let maxBcv = 0.0;
  for (let ih = 0; ih < data.length; ih++) {
    let bcv = totalMean * cnh[ih] - meanH[ih];
    bcv *= bcv / (cnh[ih] * (1.0 - cnh[ih]));
    if (maxBcv < bcv) {
      maxBcv = bcv;
      threshold = ih;
    }
  }
  return threshold;
}

function percentile(data: number[]): number {
  let threshold = -1;
  const total = A(data, data.length - 1);
  let temp = 1.0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(A(data, i) / total - 0.5);
    if (v < temp) {
      temp = v;
      threshold = i;
    }
  }
  return threshold;
}

function renyiEntropy(data: number[]): number {
  const { norm, P1, P2, first, last } = cumulative(data);
  let threshold = 0;
  let maxEnt = 0.0;
  for (let it = first; it <= last; it++) {
    let back = 0.0;
    for (let ih = 0; ih <= it; ih++) if (data[ih] !== 0) back -= (norm[ih] / P1[it]) * Math.log(norm[ih] / P1[it]);
    let obj = 0.0;
    for (let ih = it + 1; ih < data.length; ih++) if (data[ih] !== 0) obj -= (norm[ih] / P2[it]) * Math.log(norm[ih] / P2[it]);
    const tot = back + obj;
    if (maxEnt < tot) {
      maxEnt = tot;
      threshold = it;
    }
  }
  let tStar2 = threshold;
  threshold = 0;
  maxEnt = 0.0;
  let term = 1.0 / (1.0 - 0.5);
  for (let it = first; it <= last; it++) {
    let back = 0.0;
    for (let ih = 0; ih <= it; ih++) back += Math.sqrt(norm[ih] / P1[it]);
    let obj = 0.0;
    for (let ih = it + 1; ih < data.length; ih++) obj += Math.sqrt(norm[ih] / P2[it]);
    const tot = term * (back * obj > 0.0 ? Math.log(back * obj) : 0.0);
    if (tot > maxEnt) {
      maxEnt = tot;
      threshold = it;
    }
  }
  let tStar1 = threshold;
  threshold = 0;
  maxEnt = 0.0;
  term = 1.0 / (1.0 - 2.0);
  for (let it = first; it <= last; it++) {
    let back = 0.0;
    for (let ih = 0; ih <= it; ih++) back += (norm[ih] * norm[ih]) / (P1[it] * P1[it]);
    let obj = 0.0;
    for (let ih = it + 1; ih < data.length; ih++) obj += (norm[ih] * norm[ih]) / (P2[it] * P2[it]);
    const tot = term * (back * obj > 0.0 ? Math.log(back * obj) : 0.0);
    if (tot > maxEnt) {
      maxEnt = tot;
      threshold = it;
    }
  }
  let tStar3 = threshold;
  if (tStar2 < tStar1) [tStar1, tStar2] = [tStar2, tStar1];
  if (tStar3 < tStar2) [tStar2, tStar3] = [tStar3, tStar2];
  if (tStar2 < tStar1) [tStar1, tStar2] = [tStar2, tStar1];
  let beta1: number;
  let beta2: number;
  let beta3: number;
  if (Math.abs(tStar1 - tStar2) <= 5) {
    if (Math.abs(tStar2 - tStar3) <= 5) [beta1, beta2, beta3] = [1, 2, 1];
    else [beta1, beta2, beta3] = [0, 1, 3];
  } else if (Math.abs(tStar2 - tStar3) <= 5) [beta1, beta2, beta3] = [3, 1, 0];
  else [beta1, beta2, beta3] = [1, 2, 1];
  const omega = P1[tStar3] - P1[tStar1];
  return Math.trunc(tStar1 * (P1[tStar1] + 0.25 * omega * beta1) + 0.25 * tStar2 * omega * beta2 + tStar3 * (P2[tStar3] + 0.25 * omega * beta3));
}

function shanbhag(data: number[]): number {
  const { norm, P1, P2, first, last } = cumulative(data);
  let threshold = -1;
  let minEnt = DOUBLE_MAX;
  for (let it = first; it <= last; it++) {
    let back = 0.0;
    let term = 0.5 / P1[it];
    for (let ih = 1; ih <= it; ih++) back -= norm[ih] * Math.log(1.0 - term * P1[ih - 1]);
    back *= term;
    let obj = 0.0;
    term = 0.5 / P2[it];
    for (let ih = it + 1; ih < data.length; ih++) obj -= norm[ih] * Math.log(1.0 - term * P2[ih]);
    obj *= term;
    const tot = Math.abs(back - obj);
    if (tot < minEnt) {
      minEnt = tot;
      threshold = it;
    }
  }
  return threshold;
}

function triangle(input: number[]): number {
  const data = input.slice();
  let min = 0;
  let dmax = 0;
  let max = 0;
  let min2 = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) {
      min = i;
      break;
    }
  }
  if (min > 0) min--;
  for (let i = data.length - 1; i > 0; i--) {
    if (data[i] > 0) {
      min2 = i;
      break;
    }
  }
  if (min2 < data.length - 1) min2++;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > dmax) {
      max = i;
      dmax = data[i];
    }
  }
  let inverted = false;
  if (max - min < min2 - max) {
    inverted = true;
    data.reverse();
    min = data.length - 1 - min2;
    max = data.length - 1 - max;
  }
  if (min === max) return min;
  let nx = data[max];
  let ny = min - max;
  let d = Math.sqrt(nx * nx + ny * ny);
  nx /= d;
  ny /= d;
  d = nx * min + ny * data[min];
  let split = min;
  let splitDistance = 0;
  for (let i = min + 1; i <= max; i++) {
    const nd = nx * i + ny * data[i] - d;
    if (nd > splitDistance) {
      split = i;
      splitDistance = nd;
    }
  }
  split--;
  return inverted ? data.length - 1 - split : split;
}

function yen(data: number[]): number {
  let total = 0;
  for (const v of data) total = int(total + v);
  const norm = data.map((v) => v / total);
  const P1 = new Float64Array(data.length);
  const P1sq = new Float64Array(data.length);
  const P2sq = new Float64Array(data.length);
  P1[0] = norm[0];
  for (let ih = 1; ih < data.length; ih++) P1[ih] = P1[ih - 1] + norm[ih];
  P1sq[0] = norm[0] * norm[0];
  for (let ih = 1; ih < data.length; ih++) P1sq[ih] = P1sq[ih - 1] + norm[ih] * norm[ih];
  P2sq[data.length - 1] = 0.0;
  for (let ih = data.length - 2; ih >= 0; ih--) P2sq[ih] = P2sq[ih + 1] + norm[ih + 1] * norm[ih + 1];
  let threshold = -1;
  let maxCrit = DOUBLE_MIN;
  for (let it = 0; it < data.length; it++) {
    const crit =
      -1.0 * (P1sq[it] * P2sq[it] > 0.0 ? Math.log(P1sq[it] * P2sq[it]) : 0.0) + 2 * (P1[it] * (1.0 - P1[it]) > 0.0 ? Math.log(P1[it] * (1.0 - P1[it])) : 0.0);
    if (crit > maxCrit) {
      maxCrit = crit;
      threshold = it;
    }
  }
  return threshold;
}

// ---------------------------------------------------------------- applying to images

/** The data range ImageJ uses to bin a non-8-bit plane (resetMinAndMax). */
function dataRange(plane: PixelArray): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * The 256-bin histogram ImageJ thresholds on: the plane itself for 8-bit,
 * otherwise the plane scaled to 8 bits over its data range (TypeConverter),
 * restricted to `mask` when given.
 */
export function thresholdHistogram(plane: PixelArray, mask?: Uint8Array | null): { histogram: Uint32Array; min: number; max: number } {
  const histogram = new Uint32Array(256);
  const type = dtypeOf(plane);
  if (type === "uint8") {
    for (let i = 0; i < plane.length; i++) if (!mask || mask[i]) histogram[plane[i]]++;
    return { histogram, min: 0, max: 255 };
  }
  const [min, max] = dataRange(plane);
  if (type === "uint16") {
    const scale = 256.0 / (max - min + 1);
    for (let i = 0; i < plane.length; i++) {
      if (mask && !mask[i]) continue;
      let v = plane[i] - min;
      if (v < 0) v = 0;
      v = Math.trunc(v * scale + 0.5);
      if (v > 255) v = 255;
      histogram[v]++;
    }
  } else {
    const scale = 255.0 / (max - min);
    for (let i = 0; i < plane.length; i++) {
      if (mask && !mask[i]) continue;
      let v = plane[i] - min;
      if (v < 0) v = 0;
      let iv = Math.trunc(v * scale + 0.5);
      if (iv > 255) iv = 255;
      if (iv !== iv) continue; // NaN pixels
      histogram[iv]++;
    }
  }
  return { histogram, min, max };
}

/**
 * Image › Adjust › Threshold with an automatic method: the [lower, upper]
 * range of pixel values counted as foreground, in the plane's own units.
 * `darkBackground` selects the bright side, as ImageJ's "dark" option.
 */
export function autoThreshold(plane: PixelArray, method: ThresholdMethod, darkBackground: boolean, mask?: Uint8Array | null): [number, number] {
  const { histogram, min, max } = thresholdHistogram(plane, mask);
  const t = autoThresholdLevel(method, histogram, true);
  let lower: number;
  let upper: number;
  if (darkBackground) [lower, upper] = [t + 1, 255];
  else [lower, upper] = [0, t];
  if (lower > 255) lower = 255;
  const type = dtypeOf(plane);
  if (type === "uint8") return [lower, upper];
  // scaleAndSetThreshold: back to the plane's range
  if (max > min) {
    if (lower === 0) {
      if (type === "float32") lower = Math.min(min, -1e30);
    } else lower = min + (lower / 255.0) * (max - min);
    if (upper === 255) upper = type === "uint16" ? 65535 : Math.max(max, 1e30);
    else upper = min + (upper / 255.0) * (max - min);
  } else lower = upper = min;
  // ShortProcessor.setThreshold: 16-bit levels are clamped and rounded
  if (type === "uint16") {
    lower = javaRound(Math.max(0, lower));
    upper = javaRound(Math.min(65535, upper));
  }
  return [lower, upper];
}

/** Process › Binary › Convert to Mask: 255 where lower <= value <= upper, else 0. */
export function thresholdToMask(plane: PixelArray, lower: number, upper: number): Uint8Array {
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (v >= lower && v <= upper) out[i] = 255;
  }
  return out;
}
