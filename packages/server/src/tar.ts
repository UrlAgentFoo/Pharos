/**
 * Unpacks a tar stream (ustar, with pax or GNU long-name records) into a folder, for
 * folders dropped on the page: a .zarr store, an OpenFOAM case. Only plain
 * files and folders come out, every one inside `dest`: links, devices and
 * paths that climb out (absolute, "..") are refused, so an upload can never
 * write anywhere else.
 */
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export class TarError extends Error {}

const BLOCK = 512;

/** The text of a header field: up to its first NUL. */
function field(b: Buffer, at: number, len: number): string {
  const end = b.indexOf(0, at);
  return b.toString("utf8", at, end < 0 || end > at + len ? at + len : end);
}

function octal(b: Buffer, at: number, len: number): number {
  const text = field(b, at, len).trim();
  return text ? parseInt(text, 8) : 0;
}

/** A pax record set's "path" (and any other key we don't need). */
function paxPath(data: Buffer): string | undefined {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = parseInt(data.toString("utf8", at, space), 10);
    if (!len) break;
    const record = data.toString("utf8", space + 1, at + len - 1);
    if (record.startsWith("path=")) return record.slice(5);
    at += len;
  }
  return undefined;
}

/** Where an entry goes inside `dest`, or why it can't. */
function inside(dest: string, path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || isAbsolute(clean) || clean.includes("\\") || clean.split("/").some((p) => p === ".." || p === "")) throw new TarError(`"${path}" isn't a path inside the folder`);
  const target = normalize(join(dest, clean));
  if (target !== dest && !target.startsWith(dest + sep)) throw new TarError(`"${path}" would land outside the folder`);
  return target;
}

/**
 * Writes the tar `body` into `dest` (which must exist) and returns how
 * many files and bytes came out. `maxBytes` and `maxFiles` bound what one
 * upload may unpack.
 */
export async function extractTar(body: AsyncIterable<Buffer | string>, dest: string, limits: { maxBytes: number; maxFiles: number }): Promise<{ files: number; bytes: number }> {
  let buf = Buffer.alloc(0);
  let files = 0;
  let bytes = 0;
  let ended = false;
  // the entry being read: its data still to come (then padding), where it goes, and the pax path for the next one
  let left = 0;
  let pad = 0;
  let out: FileHandle | null = null;
  // a record that names the next entry (pax "x", GNU "L"), or one that names nothing we use (pax "g")
  let meta: { type: string; parts: Buffer[] } | null = null;
  let nextPath: string | undefined;
  try {
    for await (const chunk of body) {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      for (;;) {
        if (left > 0) {
          if (!buf.length) break;
          const piece = buf.subarray(0, Math.min(left, buf.length));
          if (out) await out.write(piece);
          else meta?.parts.push(Buffer.from(piece));
          left -= piece.length;
          buf = buf.subarray(piece.length);
          if (left > 0) break;
          if (out) {
            await out.close();
            out = null;
          }
          if (meta) {
            const data = Buffer.concat(meta.parts);
            if (meta.type === "x") nextPath = paxPath(data) ?? nextPath;
            if (meta.type === "L") nextPath = data.toString("utf8").replace(/\0+$/, "");
            meta = null;
          }
          continue;
        }
        if (pad > 0) {
          const skip = Math.min(pad, buf.length);
          buf = buf.subarray(skip);
          pad -= skip;
          if (pad > 0) break;
          continue;
        }
        if (ended || buf.length < BLOCK) break;
        const header = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (header.every((x) => x === 0)) {
          ended = true; // two empty blocks end the archive; anything after is ignored
          continue;
        }
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
        if (sum !== octal(header, 148, 8)) throw new TarError("this isn't a tar stream (a header's checksum is wrong)");
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const prefix = field(header, 345, 155);
        const path = nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        left = size;
        pad = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === "x" || type === "g" || type === "L") {
          meta = { type, parts: [] };
          if (size === 0) meta = null;
          continue;
        }
        nextPath = undefined;
        if (type === "5") {
          await mkdir(inside(dest, path), { recursive: true });
          continue;
        }
        if (type !== "0" && type !== "7") throw new TarError(`"${path}" isn't a plain file or folder (links aren't taken)`);
        if (++files > limits.maxFiles) throw new TarError(`more than ${limits.maxFiles} files in one folder`);
        bytes += size;
        if (bytes > limits.maxBytes) throw new TarError("the folder is too large to upload; add it by path instead");
        const target = inside(dest, path);
        await mkdir(dirname(target), { recursive: true });
        out = await open(target, "wx");
        if (size === 0) {
          await out.close();
          out = null;
        }
      }
    }
    if (left > 0 || (!ended && buf.length > 0)) throw new TarError("the upload ended part-way through a file");
    return { files, bytes };
  } finally {
    await out?.close().catch(() => {});
  }
}
