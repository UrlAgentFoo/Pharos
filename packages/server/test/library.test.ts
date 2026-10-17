import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBook, newShip } from "@pharos/books";
import { createImage, writeTiff } from "@pharos/core";
import { runAuthorCommand } from "../src/author.js";
import { type RunningServer, startServer } from "../src/server.js";

const TOKEN = "library-token-0123456789";
let tmp: string;
let lib: string;
let server: RunningServer;

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { "x-pharos-token": TOKEN, ...init.headers } });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-libsrv-"));
  lib = join(tmp, "lib");
  await newShip(lib, "my-tool");
  await newBook(lib, "my-book", "my-tool");
  await mkdir(join(tmp, "ui"));
  await writeFile(join(tmp, "ui", "index.html"), "<!doctype html>");
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data"), libraryDirs: [lib] });
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("library routes", () => {
  it("lists books and ships as catalogue entries", async () => {
    expect(await (await api("/api/library/books")).json()).toEqual([expect.objectContaining({ type: "book", id: "my-book", version: "0.1.0", gpu: "none" })]);
    expect(await (await api("/api/library/ships")).json()).toEqual([expect.objectContaining({ type: "ship", id: "my-tool" })]);
  });

  it("returns a book with its guide and accepted formats", async () => {
    const r = await (await api("/api/library/books/my-book")).json();
    expect(r.manifest.actions.measure.steps[0].run).toBe("my-tool.run");
    expect(r.guide).toMatch(/## When to use/);
    expect(r.accepts).toEqual([{ action: "measure", input: "image", kind: "volume", direct: ["tiff"], converted: [] }]);
    expect((await api("/api/library/books/nope")).status).toBe(404);
    expect((await api("/api/library/ships/my-tool?version=9.9.9")).status).toBe(404);
  });

  it("lists books as cards: how to use, actions, accepted files and ships", async () => {
    const [card] = await (await api("/api/library/cards")).json();
    expect(card).toEqual({
      entry: expect.objectContaining({ id: "my-book" }),
      howToUse: "Two or three plain sentences people see on the book's card.",
      actions: [{ name: "measure", title: "What this action does, as a button" }],
      accepts: [{ format: "tiff", title: "TIFF", converted: false }],
      ships: [{ id: "my-tool", version: "0.1.0", downloaded: false }],
    });
    const formats = await (await api("/api/library/formats")).json();
    expect(formats["openfoam-case"]).toMatchObject({ kind: "sim-case", folder: true });
  });

  it("resolves a book to the ships it needs", async () => {
    const r = await (await api("/api/books/my-book/resolve", { method: "POST", body: "{}" })).json();
    expect(r).toMatchObject({ book: { id: "my-book" }, runnable: true, ships: [expect.objectContaining({ id: "my-tool", downloaded: false, range: "^0.1" })] });
  });

  it("picks up new and broken manifests without a restart", async () => {
    await mkdir(join(lib, "books", "broken"), { recursive: true });
    await writeFile(join(lib, "books", "broken", "book.yaml"), "id: broken\nversion: 1\n");
    let issues: { id: string; problems: { line?: number }[] }[] = [];
    for (let i = 0; i < 40 && !issues.some((x) => x.id === "broken"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      issues = await (await api("/api/library/issues")).json();
    }
    expect(issues.find((x) => x.id === "broken")?.problems[0]).toMatchObject({ line: expect.any(Number) });
  });
});

describe("inspect, match and search", () => {
  it("summarises workspace data once and shortlists the books that accept it", async () => {
    const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    await api("/api/workspaces", json({ name: "w" }));
    const tif = join(tmp, "stack.tif");
    await writeFile(tif, writeTiff(createImage({ dtype: "uint8", width: 8, height: 8, slices: 3 })));
    const a = await (await api("/api/workspaces/w/artifacts", json({ path: tif }))).json();
    const s = await (await api("/api/inspect", json({ workspace: "w", artifact: a.id }))).json();
    expect(s).toMatchObject({ axes: "zyx", shape: [3, 8, 8], dtype: "uint8" });
    expect((await (await api(`/api/workspaces/w/artifacts/${a.id}`)).json()).meta.summary).toEqual(s);
    const m = await (await api("/api/match", json({ workspace: "w", artifacts: [a.id], text: "count" }))).json();
    expect(m.matches[0]).toMatchObject({ book: { id: "my-book" }, tier: "direct" });
    expect(await (await api("/api/catalogue/search?text=tool&type=ship")).json()).toEqual([expect.objectContaining({ id: "my-tool" })]);
    expect(await (await api("/api/catalogue/stats")).json()).toMatchObject({ books: { imported: 1 } });
  });
});

describe("examples", () => {
  it("lists examples whose files exist and loads them into a workspace", async () => {
    await mkdir(join(lib, "examples", "data"), { recursive: true });
    await writeFile(join(lib, "examples", "data", "t.csv"), "a\n1\n");
    await writeFile(
      join(lib, "examples", "examples.yaml"),
      "- { id: table, title: A table, kind: Table, description: One row., prompt: Count the rows., files: [{ path: data/t.csv, name: rows.csv }] }\n" +
        "- { id: gone, title: Missing, files: [{ path: data/nope.csv }] }\n",
    );
    const list = await (await api("/api/examples")).json();
    expect(list).toEqual([{ id: "table", title: "A table", kind: "Table", description: "One row.", prompt: "Count the rows.", files: ["rows.csv"] }]);
    const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const loaded = await (await api("/api/examples/table/load", json({ workspace: "ex" }))).json();
    expect(loaded).toEqual([expect.objectContaining({ name: "rows.csv", kind: "table" })]);
    expect((await api("/api/examples/gone/load", json({ workspace: "ex" }))).status).toBe(404);
  });
});

describe("install", () => {
  it("installs a book folder into the data folder's library, once", async () => {
    const src = join(tmp, "incoming");
    await newBook(src, "extra-book", "my-tool");
    const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const r = await api("/api/library/books", json({ source: join(src, "books", "extra-book") }));
    expect(await r.json()).toEqual({ installed: ["book:extra-book@0.1.0"] });
    expect((await (await api("/api/library/books")).json()).map((b: { id: string }) => b.id)).toContain("extra-book");
    expect((await api("/api/library/books", json({ source: join(src, "books", "extra-book") }))).status).toBe(409);
    expect((await api("/api/library/books", json({ source: "relative/path" }))).status).toBe(400);
  });
});

describe("pharos check", () => {
  it("prints problems with file and line and fails on errors", async () => {
    const out: string[] = [];
    const code = await runAuthorCommand(["check", lib], (s) => out.push(s));
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/book broken[\s\S]*error\s+\S*broken\/book\.yaml:2/);
    expect(out.at(-1)).toMatch(/1 ship and 1 book OK; \d+ errors?/);
  });

  it("creates ships and books, and ignores other commands", async () => {
    const dir = join(tmp, "new");
    const out: string[] = [];
    expect(await runAuthorCommand(["ship", "new", "fresh", "--dir", dir], (s) => out.push(s))).toBe(0);
    expect(await runAuthorCommand(["check", dir], (s) => out.push(s))).toBe(0);
    expect(await runAuthorCommand(["--port", "1"])).toBeNull();
  });
});
