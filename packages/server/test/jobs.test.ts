import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ServerEvent } from "@pharos/contracts";
import { connect } from "@pharos/orchestrator";
import { type RunningServer, startServer } from "../src/server.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TOKEN = "jobs-token-0123456789";
const docker = connect();
const dockerUp = !!docker && (await docker.ping());

let tmp: string;
let server: RunningServer;
const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { "x-pharos-token": TOKEN, ...init.headers } });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** Collects server-sent events until stopped. */
function listen(): { events: ServerEvent[]; stop: () => void } {
  const events: ServerEvent[] = [];
  const abort = new AbortController();
  void (async () => {
    const res = await api("/api/events", { signal: abort.signal });
    const reader = res.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (msg.startsWith("data: ")) events.push(JSON.parse(msg.slice(6)));
      }
    }
  })();
  return { events, stop: () => abort.abort() };
}

async function until(job: string): Promise<Job> {
  for (;;) {
    const j = (await (await api(`/api/jobs/${job}`)).json()) as Job;
    if (["done", "failed", "cancelled"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-jobsrv-"));
  await mkdir(join(tmp, "ui"));
  await writeFile(join(tmp, "ui", "index.html"), "<!doctype html>");
  await writeFile(join(tmp, "cells.csv"), "label,area\n1,12\n2,30\n");
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data"), libraryDirs: [REPO] });
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("status", () => {
  it("reports Docker, the GPU and free disk", async () => {
    const s = await (await api("/api/status")).json();
    expect(s.docker.available).toBe(dockerUp);
    expect(s.gpu).toHaveProperty("available");
    expect(s.disk.freeBytes).toBeGreaterThan(0);
  });
});

describe.skipIf(!dockerUp)("jobs over HTTP", () => {
  it("runs a ship operation on a workspace artifact, with live events", async () => {
    const live = listen();
    await post("/api/workspaces", { name: "w" });
    const table = await (await post("/api/workspaces/w/artifacts", { path: join(tmp, "cells.csv") })).json();
    const res = await post("/api/jobs", { workspace: "w", tool: "hello.count", inputs: { table: table.id }, params: { seconds: 1 } });
    expect(res.status).toBe(200);
    const done = await until((await res.json()).id);
    expect(done).toMatchObject({ state: "done", outputs: { count: expect.any(String) } });
    const out = await api(`/api/workspaces/w/artifacts/${done.outputs!.count}/content`);
    expect(await out.text()).toBe("rows\n2\n");
    const artifact = await (await api(`/api/workspaces/w/artifacts/${done.outputs!.count}`)).json();
    expect(artifact).toMatchObject({ kind: "table", format: "csv", producedBy: done.runId });
    await new Promise((r) => setTimeout(r, 100));
    live.stop();
    const mine = live.events.filter((e) => e.type === "job" && e.job.id === done.id);
    expect(mine.map((e) => (e as { job: Job }).job.state)).toContain("running");
    expect(live.events.some((e) => e.type === "job-log" && e.jobId === done.id)).toBe(true);

    const again = await until((await (await post("/api/jobs", { workspace: "w", tool: "hello.count", inputs: { table: table.id }, params: { seconds: 1 } })).json()).id);
    expect(again).toMatchObject({ state: "done", cached: true, outputs: done.outputs });
    expect((await api("/api/jobs")).ok).toBe(true);
  }, 120_000);

  it("rejects bad parameters, tools and inputs", async () => {
    expect((await post("/api/jobs", { workspace: "w", tool: "hello.count", inputs: {}, params: { seconds: -1 } })).status).toBe(400);
    expect((await post("/api/jobs", { workspace: "w", tool: "nope.run", inputs: {} })).status).toBe(404);
    expect((await post("/api/jobs", { workspace: "w", tool: "hello.count", inputs: { table: "0".repeat(64) } })).status).toBe(404);
    expect((await post("/api/jobs/nope/cancel")).status).toBe(404);
  });

  it("tests a ship on its test data and marks it verified", async () => {
    const before = (await (await api("/api/library/ships")).json()).find((s: { id: string }) => s.id === "hello");
    expect(before.trust).toBe("imported");
    const r = await (await post("/api/ships/hello/test")).json();
    expect(r).toMatchObject({ passed: true, cases: [{ name: "count", passed: true }] });
    const after = (await (await api("/api/library/ships")).json()).find((s: { id: string }) => s.id === "hello");
    expect(after.trust).toBe("verified");
  }, 120_000);

  it("reports storage and resolves books against downloaded images", async () => {
    const s = await (await api("/api/storage")).json();
    expect(s.ships).toContainEqual(expect.objectContaining({ id: "hello", sizeBytes: expect.any(Number), usedBy: [] }));
    expect(s.cache.usedBytes).toBeGreaterThan(0);
    expect((await api("/api/ships/hello/9.9.9", { method: "DELETE" })).status).toBe(404);
  });
});
