import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Plan } from "@pharos/contracts";
import { connect } from "@pharos/orchestrator";
import { type RunningServer, startServer } from "../src/server.js";
import { WASM_PATH } from "../../core/test/helpers.js";

const HELLO = fileURLToPath(new URL("../../../ships/hello", import.meta.url));
const TOKEN = "plans-token-0123456789";
const docker = connect();
const dockerUp = !!docker && (await docker.ping());

const BOOK = `id: count-twice
version: 0.1.0
title: Count rows, then count the count
summary: Two chained steps, to check that plans wire outputs into later steps.
tags: [test]
ships: { hello: ^0.1 }
inputs: [{ name: table, accepts: { kind: table } }]
parameters:
  - { name: wait, type: integer, default: 0, min: 0, max: 30, sets: [first.seconds, second.seconds] }
steps:
  - { id: first, run: hello.count, in: { table: $table } }
  - { id: second, run: hello.count, in: { table: first.count } }
outputs: { rows: first.count, summary: second.count }
`;

let tmp: string;
let server: RunningServer;
let table: string;
const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { "x-pharos-token": TOKEN, ...init.headers } });
const send = (method: string, path: string, body: unknown = {}) => api(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-plans-"));
  const lib = join(tmp, "lib");
  await cp(HELLO, join(lib, "ships", "hello"), { recursive: true });
  await mkdir(join(lib, "books", "count-twice", "example"), { recursive: true });
  await writeFile(join(lib, "books", "count-twice", "book.yaml"), BOOK);
  await writeFile(join(lib, "books", "count-twice", "GUIDE.md"), "# t\n## When to use\n## When not to use\n## Parameters\n## Example\n");
  await writeFile(join(lib, "books", "count-twice", "example", "table.csv"), "a\n1\n2\n3\n");
  await writeFile(join(lib, "books", "count-twice", "example", "expected-summary.csv"), "rows\n1\n");
  await mkdir(join(tmp, "ui"));
  await writeFile(join(tmp, "ui", "index.html"), "<!doctype html>");
  await writeFile(join(tmp, "cells.csv"), "label\n1\n2\n");
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), wasmPath: WASM_PATH, token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data"), libraryDirs: [lib] });
  await send("POST", "/api/workspaces", { name: "w" });
  table = (await (await send("POST", "/api/workspaces/w/artifacts", { path: join(tmp, "cells.csv") })).json()).id;
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("plans", () => {
  it("makes a plan from a book, with defaults, ships and no problems", async () => {
    const plan: Plan = await (await send("POST", "/api/plans", { workspace: "w", from: "book", book: "count-twice", inputs: { table } })).json();
    expect(plan).toMatchObject({ status: "proposed", source: "book", book: { id: "count-twice" }, parameters: { wait: 0 }, problems: [] });
    expect(plan.ships).toEqual([expect.objectContaining({ id: "hello", version: "0.1.0", gpu: "none" })]);
  });

  it("reports missing data and bad values, and refuses to approve until they're fixed", async () => {
    const plan: Plan = await (await send("POST", "/api/plans", { workspace: "w", from: "book", book: "count-twice", inputs: {}, parameters: { wait: 99 } })).json();
    expect(plan.problems.map((p) => p.message)).toEqual(expect.arrayContaining(['no data chosen for "table"', '"wait" must be between 0 and 30']));
    const refused = await send("POST", `/api/plans/${plan.id}/approve`);
    expect(refused.status).toBe(422);
    const fixed: Plan = await (await send("PUT", `/api/plans/${plan.id}`, { inputs: { table }, parameters: { wait: 0 } })).json();
    expect(fixed.problems).toEqual([]);
    expect((await send("POST", `/api/plans/${plan.id}/cancel`)).ok).toBe(true);
    expect((await send("PUT", `/api/plans/${plan.id}`, { parameters: {} })).status).toBe(409);
  });

  it.skipIf(!dockerUp)("runs an approved plan step by step, wiring outputs into later steps", async () => {
    const plan: Plan = await (await send("POST", "/api/plans", { workspace: "w", from: "book", book: "count-twice", inputs: { table } })).json();
    const r = await (await send("POST", `/api/plans/${plan.id}/approve`)).json();
    expect(r.plan.status).toMatch(/approved|running/);
    expect(r.jobs).toEqual([expect.objectContaining({ stepId: "first", planId: plan.id })]);
    let p: Plan = r.plan;
    for (let i = 0; i < 300 && !["done", "failed", "cancelled"].includes(p.status); i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      p = await (await api(`/api/plans/${plan.id}`)).json();
    }
    expect(p).toMatchObject({ status: "done", jobs: { first: expect.any(String), second: expect.any(String) } });
    const text = async (id: string) => (await api(`/api/workspaces/w/artifacts/${id}/content`)).text();
    expect(await text(p.outputs!.rows)).toBe("rows\n2\n");
    expect(await text(p.outputs!.summary)).toBe("rows\n1\n");
  }, 120_000);

  it.skipIf(!dockerUp)("saves a plan that worked as a new book", async () => {
    const plan: Plan = await (await send("POST", "/api/plans", { workspace: "w", from: "book", book: "count-twice", inputs: { table } })).json();
    const entry = await (await send("POST", `/api/plans/${plan.id}/save-as-book`, { id: "my-count", title: "My count", summary: "Saved." })).json();
    expect(entry).toMatchObject({ type: "book", id: "my-count", version: "0.1.0" });
    const saved = await readFile(join(tmp, "data", "books", "my-count", "book.yaml"), "utf8");
    expect(saved).toMatch(/hello: \^0\.1/);
    expect((await send("POST", `/api/plans/${plan.id}/save-as-book`, { id: "my-count", title: "x", summary: "y" })).status).toBe(409);
  });

  it.skipIf(!dockerUp)("tests a book on its example and marks it verified", async () => {
    const r = await (await send("POST", "/api/books/count-twice/test")).json();
    expect(r).toMatchObject({ passed: true, target: { id: "count-twice" } });
    const books = await (await api("/api/library/books")).json();
    expect(books.find((b: { id: string }) => b.id === "count-twice").trust).toBe("verified");
  }, 120_000);
});
