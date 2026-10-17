/**
 * LZ4's block format, decoded: for Blosc's lz4 and lz4hc streams, and
 * numcodecs' LZ4 (a block after its 4-byte size). Each sequence is a token
 * (literal count, match length), the literals, then a 2-byte offset back
 * into what's been written and the match to copy from there.
 */
export function lz4Block(src: Uint8Array, size: number): Buffer {
  const out = Buffer.alloc(size);
  lz4Into(src, out, 0, size);
  return out;
}

/** One LZ4 block decoded into `out` from `start`: `size` bytes, or an error. */
export function lz4Into(src: Uint8Array, out: Uint8Array, start: number, size: number) {
  const end = start + size;
  let ip = 0;
  let op = start;
  const more = (n: number) => {
    let b = 255;
    while (b === 255) {
      if (ip >= src.length) throw new Error("LZ4 data ends early");
      b = src[ip++];
      n += b;
    }
    return n;
  };
  while (ip < src.length) {
    const token = src[ip++];
    let literals = token >> 4;
    if (literals === 15) literals = more(literals);
    if (op + literals > end || ip + literals > src.length) throw new Error("LZ4 literals run past the block");
    out.set(src.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    if (ip >= src.length) break; // the last sequence is literals only
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    let match = token & 15;
    if (match === 15) match = more(match);
    match += 4;
    if (!offset || offset > op - start || op + match > end) throw new Error("LZ4 match points outside the block");
    if (offset >= match) {
      out.copyWithin(op, op - offset, op - offset + match);
      op += match;
    } else for (let k = 0; k < match; k++, op++) out[op] = out[op - offset]; // a match that overlaps what it writes (a run): byte by byte
  }
  if (op !== end) throw new Error(`LZ4 block came to ${op - start} bytes, not ${size}`);
}

/** numcodecs' LZ4 codec: the uncompressed size (4 bytes, little-endian), then one LZ4 block. */
export function numcodecsLz4(src: Uint8Array): Buffer {
  const size = src[0] | (src[1] << 8) | (src[2] << 16) | (src[3] << 24);
  return lz4Block(src.subarray(4), size >>> 0);
}
