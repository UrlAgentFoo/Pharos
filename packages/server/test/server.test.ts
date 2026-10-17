import { request } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTiff, writeTiff } from "@pharos/core";
import { type RunningServer, startServer } from "../src/server.js";
import { syntheticImage } from "../../core/test/helpers.js";

let server: RunningServer;

let tmp: string;
const TOKEN = "test-token-0123456789";

/** Raw request, so tests can send forged Host/Origin headers that fetch() forbids. */
function raw(path: string, headers: Record<string, string> = {}, method = "GET", body?: Buffer | string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { host: `127.0.0.1:${server.port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { "x-pharos-token": TOKEN, ...init.headers } });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-test-"));
  const ui = join(tmp, "ui");
  await mkdir(ui);
  await writeFile(join(ui, "index.html"), "<!doctype html><title>Pharos</title>");
  await writeFile(join(tmp, "secret.txt"), "do not serve");
  server = await startServer({ port: 0, uiDir: ui, token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data") });
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("security", () => {
  it("listens on loopback only", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.launchUrl).toBe(`${server.url}/#token=${TOKEN}`);
  });

  it("rejects API calls without the right token", async () => {
    expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/info`, { headers: { "x-pharos-token": "wrong" } })).status).toBe(401);
    expect((await api("/api/info")).status).toBe(200);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await raw("/api/info", { host: `evil.example:${server.port}`, "x-pharos-token": TOKEN });
    expect(r.status).toBe(421);
    expect((await raw("/", { host: "127.0.0.1:1" })).status).toBe(421);
  });

  it("rejects cross-site Origins even with a token", async () => {
    const r = await raw("/api/info", { origin: "https://evil.example", "x-pharos-token": TOKEN });
    expect(r.status).toBe(403);
    const own = await raw("/api/info", { origin: server.url, "x-pharos-token": TOKEN });
    expect(own.status).toBe(200);
  });

  it("sends cross-origin isolation and hardening headers", async () => {
    const r = await fetch(server.url);
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not serve files outside the UI folder", async () => {
    const r = await raw("/../secret.txt");
    expect(r.body.toString()).not.toContain("do not serve");
    const enc = await raw("/%2e%2e/secret.txt");
    expect(enc.body.toString()).not.toContain("do not serve");
  });
});

describe("static", () => {
  it("serves the UI", async () => {
    expect(await (await fetch(server.url)).text()).toContain("<title>Pharos</title>");
  });
});

describe("api", () => {
  it("reports info and capabilities", async () => {
    const info = await (await api("/api/info")).json();
    expect(info).toMatchObject({ name: "Pharos", mode: "local", capabilities: { filesystem: true, ai: true } });
  });

  it("lists, writes and reads files", async () => {
    const file = join(tmp, "hello.bin");
    const put = await api(`/api/fs/write?path=${encodeURIComponent(file)}`, { method: "PUT", body: new Uint8Array([1, 2, 3]) });
    expect(put.status).toBe(200);
    const list = await (await api(`/api/fs/list?path=${encodeURIComponent(tmp)}`)).json();
    expect(list.entries).toContainEqual({ name: "hello.bin", path: file, isDir: false, size: 3 });
    expect(list.entries[0].isDir).toBe(true); // folders first
    const got = await api(`/api/fs/read?path=${encodeURIComponent(file)}`);
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("refuses to overwrite unless asked", async () => {
    const file = join(tmp, "keep.bin");
    await writeFile(file, "original");
    const path = encodeURIComponent(file);
    expect((await api(`/api/fs/write?path=${path}`, { method: "PUT", body: "new" })).status).toBe(409);
    expect(await readFile(file, "utf8")).toBe("original");
    expect((await api(`/api/fs/write?path=${path}&overwrite=1`, { method: "PUT", body: "new" })).status).toBe(200);
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("validates paths", async () => {
    expect((await api("/api/fs/read?path=relative.tif")).status).toBe(400);
    expect((await api(`/api/fs/read?path=${encodeURIComponent(join(tmp, "missing.tif"))}`)).status).toBe(404);
    expect((await api("/api/nope")).status).toBe(404);
  });
});

describe("ai", () => {
  const json = (path: string, method: string, body: unknown) =>
    api(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("stores the model and key server-side and never returns the key", async () => {
    const before = await (await api("/api/ai/config")).json();
    expect(before.model).toBe("claude-opus-5-5");
    expect((await json("/api/ai/config", "PUT", { model: "gpt-4" })).status).toBe(400);
    expect((await json("/api/ai/config", "PUT", { apiKey: "short" })).status).toBe(400);
    const key = "sk-ant-test-0123456789abcdefWXYZ";
    const saved = await (await json("/api/ai/config", "PUT", { model: "claude-sonnet-5-5", apiKey: key })).json();
    expect(saved).toMatchObject({ model: "claude-sonnet-5-5", keySource: "settings", keyHint: "…WXYZ" });
    expect(JSON.stringify(saved)).not.toContain(key);
    const file = join(tmp, "config", "settings.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("workspaces", () => {
  const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("creates, lists and imports artifacts by path and by upload", async () => {
    expect(await (await api("/api/workspaces")).json()).toEqual([]);
    const created = await (await api("/api/workspaces", json({ name: "demo" }))).json();
    expect(created).toMatchObject({ name: "demo", artifacts: 0 });
    expect(await stat(join(tmp, "data", "workspaces", "demo", "runs"))).toBeTruthy();

    const tif = join(tmp, "cells.tif");
    await writeFile(tif, writeTiff(syntheticImage("uint8", 8, 8)));
    const a = await (await api("/api/workspaces/demo/artifacts", json({ path: tif }))).json();
    expect(a).toMatchObject({ kind: "volume", format: "tiff", name: "cells.tif", id: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const csv = "label,area\n1,12\n";
    const up = await api("/api/workspaces/demo/artifacts/upload?name=table.csv", { method: "PUT", body: csv });
    const t = await up.json();
    expect(t).toMatchObject({ kind: "table", format: "csv" });

    const list = await (await api("/api/workspaces/demo/artifacts")).json();
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual([a.id, t.id].sort());
    const content = await api(`/api/workspaces/demo/artifacts/${t.id}/content`);
    expect(content.headers.get("content-type")).toMatch(/text\/csv/);
    expect(await content.text()).toBe(csv);
    const img = await readTiff(await (await api(`/api/workspaces/demo/artifacts/${a.id}/content`)).arrayBuffer());
    expect(img.shape).toMatchObject({ width: 8, height: 8 });
  });

  it("rejects bad names, unknown file types and missing workspaces", async () => {
    expect((await api("/api/workspaces", json({ name: "../escape" }))).status).toBe(400);
    expect((await api("/api/workspaces/demo/artifacts/upload?name=notes.docx", { method: "PUT", body: "x" })).status).toBe(415);
    expect((await api("/api/workspaces/demo/artifacts/upload?name=..%2Fx.csv", { method: "PUT", body: "x" })).status).toBe(400);
    expect((await api("/api/workspaces/nope/artifacts")).status).toBe(404);
    expect((await api(`/api/workspaces/demo/artifacts/${"0".repeat(64)}`)).status).toBe(404);
    expect((await api("/api/workspaces/demo/artifacts/not-an-id")).status).toBe(400);
  });
});
