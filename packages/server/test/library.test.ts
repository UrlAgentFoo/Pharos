import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBook, newShip } from "@pharos/books";
import { runAuthorCommand } from "../src/author.js";
import { type RunningServer, startServer } from "../src/server.js";
import { WASM_PATH } from "../../core/test/helpers.js";

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
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), wasmPath: WASM_PATH, token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data"), libraryDirs: [lib] });
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
    expect(r.manifest.steps[0].run).toBe("my-tool.run");
    expect(r.guide).toMatch(/## When to use/);
    expect(r.accepts).toEqual([{ input: "image", kind: "volume", direct: ["tiff"], converted: [] }]);
    expect((await api("/api/library/books/nope")).status).toBe(404);
    expect((await api("/api/library/ships/my-tool?version=9.9.9")).status).toBe(404);
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
