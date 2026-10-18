import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniff } from "@pharos/catalogue";
import { WorkspaceStore } from "../src/workspaces.js";

let tmp: string;
let store: WorkspaceStore;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-ws-"));
  store = new WorkspaceStore(join(tmp, "data"));
  await store.create("w");
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("sniff", () => {
  it("knows the formats Pharos uses", () => {
    expect(sniff("a.ome.tif", false)).toEqual({ kind: "volume", format: "ome-tiff" });
    expect(sniff("A.TIFF", false)).toEqual({ kind: "volume", format: "tiff" });
    expect(sniff("m.zarr", true)).toEqual({ kind: "volume", format: "ome-zarr" });
    expect(sniff("case", true, ["system", "constant", "0"])).toEqual({ kind: "sim-case", format: "openfoam-case" });
    expect(sniff("t.parquet", false)).toEqual({ kind: "table", format: "parquet" });
    expect(sniff("notes.txt", false)).toBeNull();
    expect(sniff("plain-folder", true)).toBeNull();
  });
});

describe("WorkspaceStore", () => {
  it("stores identical content once", async () => {
    await writeFile(join(tmp, "a.csv"), "x\n1\n");
    await writeFile(join(tmp, "b.csv"), "x\n1\n");
    const a = await store.importPath("w", join(tmp, "a.csv"));
    const b = await store.importPath("w", join(tmp, "b.csv"));
    expect(b.id).toBe(a.id);
    expect(a.contentHash).toBe(`sha256:${a.id}`);
    expect(a.sizeBytes).toBe(4);
  });

  it("imports folders (OME-Zarr) and hashes their files", async () => {
    const z = join(tmp, "m.zarr");
    await mkdir(join(z, "0"), { recursive: true });
    await writeFile(join(z, ".zattrs"), "{}");
    await writeFile(join(z, "0", "0.0"), "chunk");
    const a = await store.importPath("w", z);
    expect(a).toMatchObject({ kind: "volume", format: "ome-zarr", sizeBytes: 7 });
    expect(await readdir(a.uri)).toEqual(expect.arrayContaining([".zattrs", "0"]));
  });

  it("streams uploads and leaves no temporary folders behind", async () => {
    const a = await store.importStream("w", "t.csv", Readable.from(["a,b\n", "1,2\n"]));
    expect(a).toMatchObject({ kind: "table", sizeBytes: 8 });
    await expect(store.importStream("w", "x.unknown", Readable.from(["?"]))).rejects.toMatchObject({ status: 415 });
    const left = (await readdir(join(store.root, "w", "artifacts"))).filter((n) => n.startsWith("."));
    expect(left).toEqual([]);
  });

  it("lists newest first and counts artifacts per workspace", async () => {
    const list = await store.artifacts("w");
    expect(list.length).toBe(3);
    expect(list[0].createdAt >= list[list.length - 1].createdAt).toBe(true);
    expect(await store.list()).toEqual([expect.objectContaining({ name: "w", artifacts: 3 })]);
  });
});
