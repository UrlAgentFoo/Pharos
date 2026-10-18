import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Artifact } from "@pharos/contracts";
import { exportProject, importProject, readZipEntries } from "../src/bundle.js";
import { WorkspaceStore } from "../src/workspaces.js";

let tmp: string;
let here: WorkspaceStore;
let source: Artifact;
let folderResult: Artifact;
let tableResult: Artifact;

/** A saved project as the UI writes it: one window, its data, and two steps that made results. */
const project = () => ({
  format: "pharos-project",
  version: 2,
  saved: "2026-10-17T00:00:00.000Z",
  name: "Test",
  docs: [
    {
      id: "d1",
      name: "case",
      workspace: "lab",
      source,
      steps: [
        { id: "mesh", run: "openfoam.mesh", in: { case: "$data" }, with: {}, status: "done", outputs: { case: folderResult.id } },
        { id: "table", run: "bio-utils.measure", in: {}, with: {}, status: "done", outputs: { table: tableResult.id } },
      ],
      marker: 2,
      prefer: { book: "fluid-flow", action: "simulate" },
      ui: { controls: true, history: "full" },
      minimized: false,
      rect: null,
    },
  ],
});

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-bundle-"));
  here = new WorkspaceStore(join(tmp, "here"));
  await here.create("lab");
  await writeFile(join(tmp, "data.csv"), "x,y\n1,2\n3,4\n");
  source = await here.importPath("lab", join(tmp, "data.csv"));
  // a folder result, with a nested file, as OpenFOAM cases and Zarr stores are
  const caseDir = join(tmp, "case");
  await mkdir(join(caseDir, "system"), { recursive: true });
  await mkdir(join(caseDir, "constant"), { recursive: true });
  await writeFile(join(caseDir, "system", "controlDict"), "endTime 1;\n");
  await writeFile(join(caseDir, "constant", "transportProperties"), "nu 0.01;\n");
  folderResult = await here.importPath("lab", caseDir);
  await writeFile(join(tmp, "result.csv"), "n\n7\n");
  tableResult = await here.importPath("lab", join(tmp, "result.csv"));
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("project bundles", () => {
  it("save the data and results by hash, and open them elsewhere as the same artifacts", async () => {
    const file = join(tmp, "test.pharos");
    const saved = await exportProject(here, project(), file, { results: true, overwrite: false });
    expect(saved).toMatchObject({ objects: 3, missing: [] });
    expect((await stat(file)).size).toBe(saved.bytes);

    // another computer: an empty data folder
    const there = new WorkspaceStore(join(tmp, "there"));
    const opened = await importProject(there, file);
    expect(opened).toMatchObject({ imported: 3, reused: 0, missing: [] });
    for (const a of [source, folderResult, tableResult]) {
      const back = await there.get("lab", a.id);
      expect(back).toMatchObject({ id: a.id, kind: a.kind, format: a.format, name: a.name, sizeBytes: a.sizeBytes });
    }
    // the project comes back whole, with no path from the computer that saved it
    const doc = (opened.project.docs as { prefer: unknown; source: Artifact }[])[0];
    expect(doc.prefer).toEqual({ book: "fluid-flow", action: "simulate" });
    expect(doc.source.uri).toBe(`objects/${source.id}/data.csv`);
    expect(await readFile((await there.get("lab", source.id)).uri, "utf8")).toBe("x,y\n1,2\n3,4\n");

    // opening it again copies nothing
    expect(await importProject(there, file)).toMatchObject({ imported: 0, reused: 3 });
  });

  it("can leave the results out, which then re-run", async () => {
    const file = join(tmp, "data-only.pharos");
    const saved = await exportProject(here, project(), file, { results: false, overwrite: false });
    expect(saved.objects).toBe(1);
    const opened = await importProject(new WorkspaceStore(join(tmp, "data-only")), file);
    expect(opened).toMatchObject({ imported: 1 });
    expect(opened.missing.sort()).toEqual([folderResult.id, tableResult.id].sort());
  });

  it("replaces a file only when asked, and never leaves a partial one", async () => {
    const file = join(tmp, "once.pharos");
    await exportProject(here, project(), file, { results: false, overwrite: false });
    await expect(exportProject(here, project(), file, { results: false, overwrite: false })).rejects.toThrow(/already exists/);
    await exportProject(here, project(), file, { results: true, overwrite: true });
    expect((await readZipEntries(file)).some((e) => e.name.includes("controlDict"))).toBe(true);
  });

  it("refuses data whose content no longer matches its hash", async () => {
    const file = join(tmp, "damaged.pharos");
    await exportProject(here, project(), file, { results: false, overwrite: false });
    // change one byte of the data inside the bundle, keeping its length
    const bytes = await readFile(file);
    const entry = (await readZipEntries(file)).find((e) => e.name.endsWith("data.csv"))!;
    bytes[entry.dataAt] = "z".charCodeAt(0);
    await writeFile(file, bytes);
    await expect(importProject(new WorkspaceStore(join(tmp, "damaged")), file)).rejects.toThrow(/damaged/);
  });

  it("writes a ZIP other tools open", async () => {
    const file = join(tmp, "test.pharos");
    const unzip = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    if (unzip.error) return; // no unzip on this machine
    expect(unzip.stdout).toMatch(/No errors detected/);
  });
});
