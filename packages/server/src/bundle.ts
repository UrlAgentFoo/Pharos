/**
 * Self-contained project files. A `.pharos` bundle is a ZIP holding
 * project.json (the project's windows and histories, which point at data by
 * its content hash) and `objects/<hash>/…`: each artifact the project uses,
 * stored once however many windows use it. Saving streams the bundle to disk
 * (it can be gigabytes) and renames it into place, so a crash never leaves a
 * half-written project; opening copies each object into the window's
 * workspace, skips those already there, and checks every one against its
 * hash, so a damaged or altered file is caught rather than shown.
 *
 * Entries are stored, not compressed: images, videos and Zarr chunks barely
 * shrink, and storing keeps saving at disk speed. ZIP64 throughout, so files
 * and bundles past 4 GB work; Finder and `unzip` open the result.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { crc32 } from "node:zlib";
import type { Artifact } from "@pharos/contracts";
import { WorkspaceError, type WorkspaceStore } from "./workspaces.js";

/** What a bundle says about each object it carries, so it comes back as the same artifact. */
export interface BundleObject {
  name?: string;
  kind: string;
  format: string;
  /** The file or folder name inside `objects/<hash>/`. */
  file: string;
  sizeBytes?: number;
  producedBy?: string;
  meta: Record<string, unknown>;
  /** data: a window's own data; result: what a step made (re-made by running again if left out). */
  role: "data" | "result";
}

/** The parts of a saved project the bundle reads; the rest (window layout, history details) passes through. */
interface ProjectLike {
  version?: number;
  docs?: { workspace: string; source: Artifact; inputs?: Record<string, string>; steps?: { status?: string; outputs?: Record<string, string> }[] }[];
  objects?: Record<string, BundleObject>;
  [key: string]: unknown;
}

export interface ExportResult {
  path: string;
  bytes: number;
  objects: number;
  /** Hashes the project points at that no workspace has any more. */
  missing: string[];
}

export interface ImportResult {
  project: ProjectLike;
  /** Objects copied in, and those already in their workspace. */
  imported: number;
  reused: number;
  /** Objects the project lists that the bundle doesn't carry (results left out at saving). */
  missing: string[];
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 64 * 1024 * 1024;

// ---------------------------------------------------------------- ZIP writing

const FFFF = 0xffff;
const FFFFFFFF = 0xffffffff;
// 1 Jan 2026, 00:00: entries carry a fixed time, so saving the same project twice gives the same bytes
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

/** Writes a stored ZIP64 archive to a file, one entry at a time; each entry's CRC is filled in once its data is written. */
class ZipWriter {
  private pos = 0;
  private readonly entries: Written[] = [];

  private constructor(private readonly fh: FileHandle) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx"));
  }

  private async write(buf: Buffer) {
    await this.fh.write(buf, 0, buf.length, this.pos);
    this.pos += buf.length;
  }

  private localHeader(name: Buffer, size: number): Buffer {
    const h = Buffer.alloc(30 + name.length + 20);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(45, 4); // version needed: ZIP64
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(DOS_TIME, 10);
    h.writeUInt16LE(DOS_DATE, 12);
    h.writeUInt32LE(0, 14); // CRC, filled in after the data
    h.writeUInt32LE(FFFFFFFF, 18);
    h.writeUInt32LE(FFFFFFFF, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(20, 28);
    name.copy(h, 30);
    const x = 30 + name.length;
    h.writeUInt16LE(0x0001, x); // ZIP64 extra: uncompressed and compressed size
    h.writeUInt16LE(16, x + 2);
    h.writeBigUInt64LE(BigInt(size), x + 4);
    h.writeBigUInt64LE(BigInt(size), x + 12);
    return h;
  }

  /** Adds a file from disk, streamed. */
  async addFile(entryName: string, path: string, size: number) {
    const name = Buffer.from(entryName, "utf8");
    const offset = this.pos;
    await this.write(this.localHeader(name, size));
    let crc = 0;
    let written = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      const buf = chunk as Buffer;
      crc = crc32(buf, crc);
      await this.write(buf);
      written += buf.length;
    }
    if (written !== size) throw new Error(`${entryName} changed while it was being saved`);
    await this.fh.write(u32(crc), 0, 4, offset + 14);
    this.entries.push({ name, crc, size, offset });
  }

  async addBuffer(entryName: string, data: Buffer) {
    const name = Buffer.from(entryName, "utf8");
    const offset = this.pos;
    const crc = crc32(data);
    const header = this.localHeader(name, data.length);
    header.writeUInt32LE(crc, 14);
    await this.write(header);
    await this.write(data);
    this.entries.push({ name, crc, size: data.length, offset });
  }

  /** Writes the central directory and closes the file; returns its size. */
  async finish(): Promise<number> {
    const cdStart = this.pos;
    for (const e of this.entries) {
      const h = Buffer.alloc(46 + e.name.length + 28);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, ZIP64
      h.writeUInt16LE(45, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(DOS_TIME, 12);
      h.writeUInt16LE(DOS_DATE, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(FFFFFFFF, 20);
      h.writeUInt32LE(FFFFFFFF, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(28, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular, readable file
      h.writeUInt32LE(FFFFFFFF, 42);
      e.name.copy(h, 46);
      const x = 46 + e.name.length;
      h.writeUInt16LE(0x0001, x);
      h.writeUInt16LE(24, x + 2);
      h.writeBigUInt64LE(BigInt(e.size), x + 4);
      h.writeBigUInt64LE(BigInt(e.size), x + 12);
      h.writeBigUInt64LE(BigInt(e.offset), x + 20);
      await this.write(h);
    }
    const cdSize = this.pos - cdStart;
    const eocd64At = this.pos;
    const z = Buffer.alloc(56 + 20 + 22);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(this.entries.length), 24);
    z.writeBigUInt64LE(BigInt(this.entries.length), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    z.writeUInt32LE(0x07064b50, 56); // ZIP64 end locator
    z.writeUInt32LE(0, 60);
    z.writeBigUInt64LE(BigInt(eocd64At), 64);
    z.writeUInt32LE(1, 72);
    z.writeUInt32LE(0x06054b50, 76); // end of central directory, pointing on to ZIP64
    z.writeUInt16LE(0, 80);
    z.writeUInt16LE(0, 82);
    z.writeUInt16LE(Math.min(this.entries.length, FFFF), 84);
    z.writeUInt16LE(Math.min(this.entries.length, FFFF), 86);
    z.writeUInt32LE(FFFFFFFF, 88);
    z.writeUInt32LE(FFFFFFFF, 92);
    z.writeUInt16LE(0, 96);
    await this.write(z);
    await this.fh.sync();
    await this.fh.close();
    return this.pos;
  }

  async abort() {
    await this.fh.close().catch(() => {});
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};

// ---------------------------------------------------------------- ZIP reading

export interface ZipEntryInfo {
  name: string;
  size: number;
  /** Where the entry's data starts in the file. */
  dataAt: number;
}

async function readAt(fh: FileHandle, at: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, at);
  return buf.subarray(0, bytesRead);
}

/** Lists a stored ZIP's entries (ZIP64 or not), from its central directory. */
export async function readZipEntries(path: string): Promise<ZipEntryInfo[]> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65536 + 22);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        e = i;
        break;
      }
    }
    if (e < 0) throw new WorkspaceError(400, "This file isn't a Pharos project (not a ZIP).");
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdAt = tail.readUInt32LE(e + 16);
    if (count === FFFF || cdSize === FFFFFFFF || cdAt === FFFFFFFF) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new WorkspaceError(400, "This project file is damaged (no ZIP64 directory).");
      const z = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new WorkspaceError(400, "This project file is damaged (bad ZIP64 directory).");
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdAt = Number(z.readBigUInt64LE(48));
    }
    const cd = await readAt(fh, cdAt, cdSize);
    const out: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new WorkspaceError(400, "This project file is damaged (bad directory entry).");
      const method = cd.readUInt16LE(p + 10);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localAt = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      // ZIP64 extra: the 64-bit values for whichever fields were 0xFFFFFFFF, in order
      let x = p + 46 + nameLen;
      const end = x + extraLen;
      while (x + 4 <= end) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (entrySize === FFFFFFFF) {
            entrySize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (cd.readUInt32LE(p + 20) === FFFFFFFF) q += 8;
          if (localAt === FFFFFFFF) localAt = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      p = end + commentLen;
      if (name.endsWith("/")) continue;
      if (method !== 0) throw new WorkspaceError(400, `This project file has a compressed entry (${name}); Pharos reads stored ones only.`);
      const local = await readAt(fh, localAt, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new WorkspaceError(400, "This project file is damaged (bad entry header).");
      out.push({ name, size: entrySize, dataAt: localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) });
    }
    return out;
  } finally {
    await fh.close();
  }
}

async function readEntry(path: string, e: ZipEntryInfo, limit: number): Promise<Buffer> {
  if (e.size > limit) throw new WorkspaceError(400, `${e.name} is too large to read`);
  const fh = await open(path, "r");
  try {
    return await readAt(fh, e.dataAt, e.size);
  } finally {
    await fh.close();
  }
}

/** Copies an entry's data to a file. */
async function extractEntry(zipPath: string, e: ZipEntryInfo, dest: string) {
  await mkdir(dirname(dest), { recursive: true });
  const out = await open(dest, "wx");
  try {
    if (e.size > 0) {
      let pos = 0;
      for await (const chunk of createReadStream(zipPath, { start: e.dataAt, end: e.dataAt + e.size - 1, highWaterMark: 1 << 20 })) {
        await out.write(chunk as Buffer, 0, (chunk as Buffer).length, pos);
        pos += (chunk as Buffer).length;
      }
    }
  } finally {
    await out.close();
  }
}

// ---------------------------------------------------------------- projects

/** Finds an artifact by its hash: in the workspace named first, then in any other. */
async function locate(workspaces: WorkspaceStore, id: string, prefer: string): Promise<Artifact | null> {
  const first = await workspaces.get(prefer, id).catch(() => null);
  if (first) return first;
  for (const w of await workspaces.list()) {
    if (w.name === prefer) continue;
    const a = await workspaces.get(w.name, id).catch(() => null);
    if (a) return a;
  }
  return null;
}

/** Every file of an artifact, as [path on disk, path inside its object folder]. */
async function filesOf(uri: string): Promise<[string, string][]> {
  const s = await stat(uri);
  if (s.isFile()) return [[uri, basename(uri)]];
  const files = (await readdir(uri, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  return files.sort().map((f) => [f, posix.join(basename(uri), relative(uri, f).split(sep).join("/"))]);
}

/**
 * Saves a project with the data it uses: each window's data, and with
 * `results`, what its steps made. Written beside `path` and renamed into
 * place once complete; an existing file is replaced only with `overwrite`.
 */
export async function exportProject(workspaces: WorkspaceStore, project: ProjectLike, path: string, opts: { results: boolean; overwrite: boolean }): Promise<ExportResult> {
  const exists = await stat(path).then(() => true, () => false);
  if (exists && !opts.overwrite) throw new WorkspaceError(409, `already exists: ${path}`);
  const docs = Array.isArray(project.docs) ? project.docs : [];

  // what to carry: each window's data, then each finished step's outputs
  const wanted = new Map<string, { workspace: string; role: BundleObject["role"] }>();
  for (const d of docs) {
    if (d?.source?.id && HASH.test(d.source.id)) wanted.set(d.source.id, { workspace: d.workspace, role: "data" });
    // and the other data its steps read (the ground truth a run scored against, say)
    for (const id of Object.values(d?.inputs ?? {})) if (HASH.test(id) && !wanted.has(id)) wanted.set(id, { workspace: d.workspace, role: "data" });
  }
  if (opts.results) {
    for (const d of docs) {
      for (const s of d.steps ?? []) {
        for (const id of Object.values(s.outputs ?? {})) if (HASH.test(id) && !wanted.has(id)) wanted.set(id, { workspace: d.workspace, role: "result" });
      }
    }
  }
  const objects: Record<string, BundleObject> = {};
  const found: { id: string; artifact: Artifact }[] = [];
  const missing: string[] = [];
  for (const [id, w] of wanted) {
    const a = await locate(workspaces, id, w.workspace);
    if (!a) {
      missing.push(id);
      continue;
    }
    found.push({ id, artifact: a });
    objects[id] = { name: a.name, kind: a.kind, format: a.format, file: basename(a.uri), sizeBytes: a.sizeBytes, producedBy: a.producedBy, meta: a.meta ?? {}, role: w.role };
  }

  // the manifest names files relative to the bundle, never paths on this computer
  const manifest: ProjectLike = {
    ...project,
    version: 3,
    docs: docs.map((d) => ({ ...d, source: { ...d.source, uri: objects[d.source.id] ? `objects/${d.source.id}/${objects[d.source.id].file}` : "" } })),
    objects,
  };

  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.partial`);
  const zip = await ZipWriter.create(tmp);
  try {
    await zip.addBuffer("project.json", Buffer.from(JSON.stringify(manifest, null, 1)));
    for (const { id, artifact } of found) {
      for (const [file, inside] of await filesOf(artifact.uri)) await zip.addFile(`objects/${id}/${inside}`, file, (await stat(file)).size);
    }
    const bytes = await zip.finish();
    await rename(tmp, path);
    return { path, bytes, objects: found.length, missing };
  } catch (e) {
    await zip.abort();
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Opens a saved project: reads its manifest, and copies each object it
 * carries into the workspace of every window that uses it (made if needed),
 * keeping those already there. Each copy must hash to its name.
 */
export async function importProject(workspaces: WorkspaceStore, path: string): Promise<ImportResult> {
  const entries = await readZipEntries(path);
  const manifestEntry = entries.find((e) => e.name === "project.json");
  if (!manifestEntry) throw new WorkspaceError(400, "This file is not a Pharos project (no project.json inside).");
  const project = JSON.parse((await readEntry(path, manifestEntry, MAX_MANIFEST)).toString("utf8")) as ProjectLike;
  if (project.format !== "pharos-project") throw new WorkspaceError(400, "This file is not a Pharos project.");
  if ((project.version ?? 0) > 3) throw new WorkspaceError(400, "This project was saved by a newer Pharos. Update Pharos to open it.");
  const objects = project.objects ?? {};
  const docs = Array.isArray(project.docs) ? project.docs : [];

  // which workspaces want each object: every window that shows it, reads it or whose steps made it
  const homes = new Map<string, Set<string>>();
  const want = (id: string, workspace: string) => homes.set(id, (homes.get(id) ?? new Set()).add(workspace));
  for (const d of docs) {
    if (d?.source?.id) want(d.source.id, d.workspace);
    for (const id of Object.values(d?.inputs ?? {})) want(id, d.workspace);
    for (const s of d.steps ?? []) for (const id of Object.values(s.outputs ?? {})) want(id, d.workspace);
  }

  const byObject = new Map<string, ZipEntryInfo[]>();
  for (const e of entries) {
    const m = /^objects\/([0-9a-f]{64})\/(.+)$/.exec(e.name);
    if (!m) continue;
    // a name climbing out of its folder is never extracted
    if (m[2].split("/").some((part) => part === ".." || part === "" || part === ".")) throw new WorkspaceError(400, `This project file has an unsafe entry: ${e.name}`);
    byObject.set(m[1], [...(byObject.get(m[1]) ?? []), e]);
  }

  let imported = 0;
  let reused = 0;
  const missing: string[] = [];
  for (const [id, workspaceNames] of homes) {
    const info = objects[id];
    const files = byObject.get(id);
    for (const workspace of workspaceNames) {
      await workspaces.create(workspace);
      if (await workspaces.get(workspace, id).catch(() => null)) {
        reused++;
        continue;
      }
      if (!info || !files?.length) {
        if (!missing.includes(id)) missing.push(id);
        continue;
      }
      // unpack beside the workspace's artifacts (same disk, so taking it in is a rename), then check the hash
      const scratch = join((await workspaces.dirs(workspace)).artifacts, `.unpack-${randomBytes(6).toString("hex")}`);
      try {
        for (const f of files) await extractEntry(path, f, join(scratch, ...f.name.slice(`objects/${id}/`.length).split("/")));
        const artifact = await workspaces.adoptAs(workspace, join(scratch, info.file), { kind: info.kind, format: info.format }, info.producedBy ?? "", info.name, id);
        if (Object.keys(info.meta ?? {}).length) await workspaces.setMeta(workspace, artifact.id, info.meta);
        imported++;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
  return { project, imported, reused, missing };
}
