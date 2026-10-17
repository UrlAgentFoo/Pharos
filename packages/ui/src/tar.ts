/**
 * A folder as a tar stream (ustar), to upload in one request: a dropped
 * .zarr store or OpenFOAM case. It's a Blob made of the files themselves, so
 * the browser reads them from disk as it sends them and a store of gigabytes
 * never sits in the page. No DOM here, so it's tested in Node.
 */

/** One file of the folder, by its path inside it ("0/.zarray"). */
export interface FolderFile {
  path: string;
  file: Blob;
}

const BLOCK = 512;
const enc = new TextEncoder();

/** The ustar header for one file: name (and prefix, for long paths), size, a checksum. */
function header(path: string, size: number, mtime: number): Uint8Array<ArrayBuffer> {
  if (size >= 8 ** 11) throw new Error(`"${path}" is too large for one upload (8 GB per file)`);
  let name = path;
  let prefix = "";
  if (enc.encode(path).length > 100) {
    // split at a slash so the name fits in 100 bytes and the rest in the 155-byte prefix
    const slashes: number[] = [];
    for (let i = 1; i < path.length; i++) if (path[i] === "/") slashes.push(i);
    const cut = slashes.filter((i) => enc.encode(path.slice(0, i)).length <= 155 && enc.encode(path.slice(i + 1)).length <= 100).pop();
    if (cut === undefined) throw new Error(`"${path}" is too long a path to upload`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const h = new Uint8Array(BLOCK);
  const put = (text: string, at: number) => h.set(enc.encode(text), at);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put(`${Math.floor(mtime / 1000).toString(8).padStart(11, "0")}\0`, 136);
  put("        ", 148); // the checksum counts its own field as spaces
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

export function tarBlob(files: FolderFile[], mtime = Date.now()): Blob {
  const parts: BlobPart[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.file.size, mtime), f.file);
    const pad = (BLOCK - (f.file.size % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(2 * BLOCK)); // two empty blocks end the archive
  return new Blob(parts, { type: "application/x-tar" });
}
