import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// the page's writer: the two ends of a dropped folder's upload, checked together
import { tarBlob } from "../../ui/src/tar.js";
import { TarError, extractTar } from "../src/tar.js";
import { type RunningServer, startServer } from "../src/server.js";

const LIMITS = { maxBytes: 1 << 30, maxFiles: 1000 };
const TOKEN = "tar-token-0123456789abcdef";
let tmp: string;
let server: RunningServer;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-tar-"));
  await mkdir(join(tmp, "ui"));
  await writeFile(join(tmp, "ui", "index.html"), "<!doctype html>");
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data") });
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

const blob = (text: string) => new Blob([text]);
async function list(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) out[join(e.parentPath, e.name).slice(dir.length + 1)] = await readFile(join(e.parentPath, e.name), "utf8");
  return out;
}
async function into(name: string, body: Blob | AsyncIterable<Buffer>) {
  const dest = join(tmp, name);
  await mkdir(dest);
  const stream = body instanceof Blob ? (body.stream() as unknown as AsyncIterable<Buffer>) : body;
  return { dest, result: await extractTar(stream, dest, LIMITS) };
}

describe("dropped folders, as tar", () => {
  it("comes out as it went in: nested files, a long path, an empty file, hidden files", async () => {
    const long = `${"deep/".repeat(30)}chunk`;
    const files = [
      { path: ".zattrs", file: blob('{"multiscales":[]}') },
      { path: "0/.zarray", file: blob('{"shape":[2]}') },
      { path: "0/0.0.0", file: blob("x".repeat(1300)) },
      { path: "empty", file: blob("") },
      { path: long, file: blob("far down") },
    ];
    const { dest, result } = await into("roundtrip", tarBlob(files));
    expect(result).toEqual({ files: 5, bytes: 18 + 13 + 1300 + 0 + 8 });
    expect(await list(dest)).toEqual({ ".zattrs": '{"multiscales":[]}', "0/.zarray": '{"shape":[2]}', "0/0.0.0": "x".repeat(1300), empty: "", [long]: "far down" });
  });

  it("reads what the system's tar writes", async () => {
    const src = join(tmp, "src.zarr");
    await mkdir(join(src, "0"), { recursive: true });
    await writeFile(join(src, ".zgroup"), '{"zarr_format":2}');
    await writeFile(join(src, "0", ".zarray"), "{}");
    let bytes: Buffer;
    try {
      bytes = execFileSync("tar", ["-cf", "-", "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    } catch {
      return; // no tar on this machine
    }
    const { dest } = await into("system", (async function* () {
      yield bytes;
    })());
    expect(await list(dest)).toEqual({ ".zgroup": '{"zarr_format":2}', "0/.zarray": "{}" });
  });

  it("refuses paths that climb out of the folder, and links", async () => {
    await expect(into("climb", tarBlob([{ path: "../evil", file: blob("no") }]))).rejects.toThrow(TarError);
    await expect(into("absolute", tarBlob([{ path: "/etc/evil", file: blob("no") }]))).rejects.toThrow(/isn't a path inside/);
    // a symbolic link: the same header with its type set to "2" and the checksum made right again
    const bytes = new Uint8Array(await tarBlob([{ path: "link", file: blob("") }]).arrayBuffer());
    bytes[156] = "2".charCodeAt(0);
    bytes.fill(0x20, 148, 156);
    const sum = bytes.subarray(0, 512).reduce((a, b) => a + b, 0);
    bytes.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    await expect(into("link", new Blob([bytes]))).rejects.toThrow(/links aren't taken/);
    await expect(into("junk", new Blob(["not a tar file at all".repeat(40)]))).rejects.toThrow(/checksum/);
  });

  it("stores a dropped .zarr folder as OME-Zarr", async () => {
    const send = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { "x-pharos-token": TOKEN, ...(init.headers ?? {}) } });
    await send("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "w" }), headers: { "content-type": "application/json" } });
    const body = tarBlob([
      { path: ".zattrs", file: blob(JSON.stringify({ multiscales: [{ version: "0.4", axes: ["t", "y", "x"], datasets: [{ path: "0" }] }] })) },
      { path: ".zgroup", file: blob('{"zarr_format":2}') },
      { path: "0/.zarray", file: blob(JSON.stringify({ shape: [3, 4, 5], chunks: [1, 4, 5], dtype: "|u1", compressor: null, fill_value: 0, order: "C", zarr_format: 2 })) },
    ]);
    const r = await send("/api/workspaces/w/artifacts/upload-folder?name=movie.zarr", { method: "PUT", body });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: "volume", format: "ome-zarr", name: "movie.zarr" });
    const bad = await send("/api/workspaces/w/artifacts/upload-folder?name=../x.zarr", { method: "PUT", body });
    expect(bad.status).toBe(400);
  });
});
