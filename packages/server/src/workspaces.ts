/**
 * Workspaces on disk: `<data>/workspaces/<name>/{artifacts,runs,cache}`.
 *
 * Artifacts are content-addressed: an artifact's id is the sha256 of its
 * content, so importing the same file twice (or two pipelines producing the
 * same output) stores it once. Each lives in `artifacts/<id>/` as its data
 * (a file, or a folder for OME-Zarr and simulation cases) next to an
 * `artifact.json` record.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { constants, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Artifact, ArtifactKind, Format, WorkspaceInfo } from "@pharos/contracts";

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NAME = /^[\w][\w .-]{0,63}$/;
const ID = /^[0-9a-f]{64}$/;
const SUBFOLDERS = ["artifacts", "runs", "cache"] as const;

/** Guesses an artifact's kind and format from its name (and whether it is a folder). */
export function sniff(name: string, isDir: boolean, entries: string[] = []): { kind: ArtifactKind; format: Format } | null {
  const n = name.toLowerCase();
  if (isDir) {
    if (n.endsWith(".zarr")) return { kind: "volume", format: "ome-zarr" };
    if (entries.includes("system") && entries.includes("constant")) return { kind: "sim-case", format: "openfoam-case" };
    return null;
  }
  if (/\.ome\.tiff?$/.test(n)) return { kind: "volume", format: "ome-tiff" };
  const ext = n.slice(n.lastIndexOf(".") + 1);
  const byExt: Record<string, { kind: ArtifactKind; format: Format }> = {
    tif: { kind: "volume", format: "tiff" },
    tiff: { kind: "volume", format: "tiff" },
    czi: { kind: "volume", format: "czi" },
    nd2: { kind: "volume", format: "nd2" },
    lif: { kind: "volume", format: "lif" },
    csv: { kind: "table", format: "csv" },
    parquet: { kind: "table", format: "parquet" },
    ply: { kind: "mesh", format: "ply" },
    vtk: { kind: "mesh", format: "vtk" },
    vtu: { kind: "mesh", format: "vtk" },
    vtp: { kind: "mesh", format: "vtk" },
    mp4: { kind: "video", format: "mp4" },
  };
  return byExt[ext] ?? null;
}

/** sha256 of a file, or of a folder's sorted relative paths and file contents. */
async function hashPath(path: string): Promise<{ hash: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  const s = await stat(path);
  if (s.isFile()) {
    for await (const chunk of createReadStream(path)) {
      h.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { hash: h.digest("hex"), size };
  }
  const files = (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(path, join(e.parentPath, e.name)))
    .sort();
  for (const rel of files) {
    const sub = await hashPath(join(path, rel));
    h.update(`${rel.split(sep).join("/")}\0${sub.hash}\n`);
    size += sub.size;
  }
  return { hash: h.digest("hex"), size };
}

export class WorkspaceStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "workspaces");
  }

  private dir(name: string): string {
    if (!NAME.test(name)) throw new WorkspaceError(400, `invalid workspace name "${name}": letters, digits, spaces, . _ - (max 64)`);
    return join(this.root, name);
  }

  private async existing(name: string): Promise<string> {
    const dir = this.dir(name);
    const s = await stat(join(dir, "artifacts")).catch(() => null);
    if (!s?.isDirectory()) throw new WorkspaceError(404, `no workspace "${name}"`);
    return dir;
  }

  async list(): Promise<WorkspaceInfo[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: WorkspaceInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !NAME.test(e.name)) continue;
      const ids = await readdir(join(this.root, e.name, "artifacts")).catch(() => null);
      if (ids) out.push({ name: e.name, path: join(this.root, e.name), artifacts: ids.filter((i) => ID.test(i)).length });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates a workspace, or returns it if it already exists. */
  async create(name: string): Promise<WorkspaceInfo> {
    const dir = this.dir(name);
    for (const sub of SUBFOLDERS) await mkdir(join(dir, sub), { recursive: true });
    return (await this.list()).find((w) => w.name === name)!;
  }

  async artifacts(name: string): Promise<Artifact[]> {
    const dir = await this.existing(name);
    const ids = (await readdir(join(dir, "artifacts"))).filter((i) => ID.test(i));
    const out = await Promise.all(ids.map((id) => this.read(dir, id).catch(() => null)));
    return out.filter((a): a is Artifact => !!a).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(name: string, id: string): Promise<Artifact> {
    if (!ID.test(id)) throw new WorkspaceError(400, `invalid artifact id "${id}"`);
    return this.read(await this.existing(name), id).catch(() => {
      throw new WorkspaceError(404, `no artifact ${id} in "${name}"`);
    });
  }

  private async read(dir: string, id: string): Promise<Artifact> {
    return JSON.parse(await readFile(join(dir, "artifacts", id, "artifact.json"), "utf8")) as Artifact;
  }

  /** Copies a file or folder from anywhere on disk into the workspace. */
  async importPath(name: string, source: string, displayName?: string): Promise<Artifact> {
    const s = await stat(source).catch(() => null);
    if (!s) throw new WorkspaceError(404, `not found: ${source}`);
    return this.ingest(name, basename(source), async (dest) => {
      // copy-on-write clones where the filesystem supports them (APFS, btrfs)
      await cp(source, dest, { recursive: true, mode: constants.COPYFILE_FICLONE });
    }, displayName);
  }

  /** Stores uploaded bytes (a dropped file) as an artifact. */
  async importStream(name: string, filename: string, body: NodeJS.ReadableStream): Promise<Artifact> {
    if (!filename || filename !== basename(filename)) throw new WorkspaceError(400, `invalid file name "${filename}"`);
    return this.ingest(name, filename, (dest) => pipeline(body, createWriteStream(dest)));
  }

  private async ingest(name: string, filename: string, fill: (dest: string) => Promise<void>, displayName?: string): Promise<Artifact> {
    const dir = await this.existing(name);
    const tmp = join(dir, "artifacts", `.incoming-${randomBytes(6).toString("hex")}`);
    const data = join(tmp, filename);
    try {
      await mkdir(tmp, { recursive: true });
      await fill(data);
      const isDir = (await stat(data)).isDirectory();
      const type = sniff(filename, isDir, isDir ? await readdir(data) : []);
      if (!type) throw new WorkspaceError(415, `Pharos doesn't know what kind of data "${filename}" is yet`);
      const { hash, size } = await hashPath(data);
      const final = join(dir, "artifacts", hash);
      const known = await this.read(dir, hash).catch(() => null);
      if (known) return known;
      const artifact: Artifact = {
        id: hash,
        kind: type.kind,
        format: type.format,
        uri: join(final, filename),
        name: displayName ?? filename,
        meta: {},
        contentHash: `sha256:${hash}`,
        sizeBytes: size,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(tmp, "artifact.json"), JSON.stringify(artifact, null, 2) + "\n");
      await rename(tmp, final);
      return artifact;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
