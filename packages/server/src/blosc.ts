/**
 * Blosc (version 1's chunk format, which Zarr's Blosc writes), decoded: a
 * 16-byte header, then the chunk's blocks, each split into one stream per
 * byte of the element type when shuffled, each stream compressed with
 * blosclz, LZ4, zlib or zstd, then the bytes (or bits) put back in order.
 */
import { inflateSync, zstdDecompressSync } from "node:zlib";
import { lz4Into } from "./lz4.js";

const DOSHUFFLE = 0x1;
const MEMCPYED = 0x2;
const DOBITSHUFFLE = 0x4;
const DONT_SPLIT = 0x10;
const MAX_SPLITS = 16;
const MIN_BUFFERSIZE = 128;
const CODECS = ["blosclz", "lz4", "snappy", "zlib", "zstd"];

export function blosc(src: Uint8Array): Buffer {
  if (src.length < 16) throw new Error("not a Blosc chunk (too short)");
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const version = src[0];
  const flags = src[2];
  const typesize = src[3] || 1;
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  if (flags & MEMCPYED) return Buffer.from(src.subarray(16, 16 + nbytes));
  const codec = CODECS[flags >> 5];
  if (!codec || codec === "snappy") throw new Error(`Blosc chunks compressed with ${codec ?? `codec ${flags >> 5}`} can't be previewed`);
  const out = Buffer.alloc(nbytes);
  const nblocks = Math.ceil(nbytes / blocksize);
  const shuffled = (flags & DOSHUFFLE && typesize > 1) || flags & DOBITSHUFFLE;
  // a shuffled block is decoded here first, then put back in order into `out`; one that isn't, straight into `out`
  const scratch = shuffled ? new Uint8Array(blocksize) : null;
  for (let b = 0; b < nblocks; b++) {
    const leftover = b === nblocks - 1 && nbytes % blocksize !== 0;
    const bsize = leftover ? nbytes % blocksize : blocksize;
    let at = view.getUint32(16 + 4 * b, true);
    const split = !(flags & DONT_SPLIT) && typesize <= MAX_SPLITS && blocksize / typesize >= MIN_BUFFERSIZE && !leftover;
    const streams = split ? typesize : 1;
    const per = bsize / streams;
    const [target, base] = scratch ? [scratch, 0] : [out, b * blocksize];
    for (let s = 0; s < streams; s++) {
      const cbytes = view.getUint32(at, true);
      at += 4;
      const data = src.subarray(at, at + cbytes);
      at += cbytes;
      // a stream that didn't compress is stored as it is
      if (cbytes === per) target.set(data, base + s * per);
      else inflate(codec, data, target, base + s * per, per);
    }
    if (!scratch) continue;
    const block = scratch.subarray(0, bsize);
    if (flags & DOSHUFFLE && typesize > 1) unshuffle(block, typesize, out, b * blocksize);
    else out.set(bitunshuffle(Buffer.from(block), typesize, version), b * blocksize);
  }
  return out;
}

/** One compressed stream into `out` at `at`: `size` bytes. */
function inflate(codec: string, data: Uint8Array, out: Uint8Array, at: number, size: number) {
  if (codec === "lz4") return lz4Into(data, out, at, size);
  const got = codec === "zlib" ? inflateSync(data) : codec === "zstd" ? zstdDecompressSync(data) : blosclz(data, size);
  if (got.length !== size) throw new Error(`a Blosc ${codec} stream came to ${got.length} bytes, not ${size}`);
  out.set(got, at);
}

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Byte shuffle undone, into `out` at `at`: byte j of every element was stored together, the j-th run. */
function unshuffle(src: Uint8Array, typesize: number, out: Uint8Array, at: number) {
  const n = Math.floor(src.length / typesize);
  // the bytes past whole elements stay as they are
  out.set(src.subarray(n * typesize), at + n * typesize);
  const aligned = (out.byteOffset + at) % typesize === 0;
  if (LITTLE && aligned && typesize === 2) {
    // a whole element at a time: low byte from the first run, high byte from the second
    const out16 = new Uint16Array(out.buffer, out.byteOffset + at, n);
    for (let i = 0; i < n; i++) out16[i] = src[i] | (src[n + i] << 8);
    return;
  }
  if (LITTLE && aligned && typesize === 4) {
    const out32 = new Uint32Array(out.buffer, out.byteOffset + at, n);
    for (let i = 0; i < n; i++) out32[i] = (src[i] | (src[n + i] << 8) | (src[2 * n + i] << 16) | (src[3 * n + i] << 24)) >>> 0;
    return;
  }
  for (let j = 0; j < typesize; j++) for (let i = 0; i < n; i++) out[at + i * typesize + j] = src[j * n + i];
}

/**
 * Bit shuffle undone: bit k of byte j of every element was stored together,
 * row j * 8 + k, one bit per element, least significant first. Only whole
 * runs of 8 elements are shuffled; Blosc's format 2 shuffles a block only
 * when all its elements are.
 */
function bitunshuffle(src: Buffer, typesize: number, version: number): Buffer {
  let n = Math.floor(src.length / typesize);
  if (version <= 2 && n % 8 !== 0) return src;
  n -= n % 8;
  const out = Buffer.from(src);
  out.fill(0, 0, n * typesize);
  const rowBytes = n / 8;
  for (let j = 0; j < typesize; j++)
    for (let k = 0; k < 8; k++) {
      const row = (j * 8 + k) * rowBytes;
      for (let i = 0; i < n; i++) if ((src[row + (i >> 3)] >> (i & 7)) & 1) out[i * typesize + j] |= 1 << k;
    }
  return out;
}

const MAX_DISTANCE = 8191;

/**
 * blosclz (Blosc's own LZ77, after FastLZ): a run of up to 32 literals, or a
 * match of length and distance, with longer lengths and distances in extra
 * bytes.
 */
export function blosclz(src: Uint8Array, size: number): Buffer {
  const out = Buffer.alloc(size);
  let ip = 0;
  let op = 0;
  let ctrl = src[ip++] & 31;
  for (;;) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      if (len === 6) {
        let code = 255;
        while (code === 255) {
          if (ip >= src.length) throw new Error("blosclz data ends early");
          code = src[ip++];
          len += code;
        }
      }
      const code = src[ip++];
      len += 3;
      let ref = op - ofs - code;
      if (code === 255 && ofs === 31 << 8) {
        ofs = (src[ip] << 8) + src[ip + 1];
        ip += 2;
        ref = op - ofs - MAX_DISTANCE;
      }
      ref--;
      if (ref < 0 || op + len > size) throw new Error("blosclz match points outside the block");
      for (let k = 0; k < len; k++, op++) out[op] = out[ref + k];
    } else {
      const n = ctrl + 1;
      if (op + n > size || ip + n > src.length) throw new Error("blosclz literals run past the block");
      out.set(src.subarray(ip, ip + n), op);
      ip += n;
      op += n;
    }
    if (ip >= src.length) break;
    ctrl = src[ip++];
  }
  if (op !== size) throw new Error(`blosclz stream came to ${op} bytes, not ${size}`);
  return out;
}
