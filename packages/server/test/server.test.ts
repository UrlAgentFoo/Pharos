import { request } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTiff, runSteps, writeTiff } from "@pharos/core";
import type { AiClient } from "../src/ai.js";
import { type RunningServer, startServer } from "../src/server.js";
import { WASM_PATH, syntheticImage, testKernels } from "../../core/test/helpers.js";

let server: RunningServer;

/** A stand-in for the Anthropic client that records requests and replies with canned content. */
const aiCalls: { apiKey?: string; body: Record<string, unknown> }[] = [];
let aiReply: unknown[] = [];
/** The first canned reply in the multi-turn test, to check it is replayed verbatim. */
const aiReplyFirst = () => (aiCalls[aiCalls.length - 2] as unknown as { reply: unknown[] }).reply;
const fakeAi = (apiKey: string | undefined): AiClient =>
  ({
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          // copy the request: the server keeps appending to the same arrays
          aiCalls.push({ apiKey, body: JSON.parse(JSON.stringify(body)), reply: aiReply } as (typeof aiCalls)[number]);
          return { model: body.model, stop_reason: "tool_use", content: aiReply };
        },
      },
    },
  }) as unknown as AiClient;
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
  server = await startServer({ port: 0, uiDir: ui, wasmPath: WASM_PATH, token: TOKEN, configDir: join(tmp, "config"), aiClient: fakeAi, dataDir: join(tmp, "data") });
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
  it("serves the UI and the kernels", async () => {
    expect(await (await fetch(server.url)).text()).toContain("<title>Pharos</title>");
    const wasm = await fetch(`${server.url}/kernels.wasm`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(WebAssembly.validate(new Uint8Array(await wasm.arrayBuffer()))).toBe(true);
  });
});

describe("api", () => {
  it("reports info and capabilities", async () => {
    const info = await (await api("/api/info")).json();
    expect(info).toMatchObject({ name: "Pharos", mode: "local", capabilities: { filesystem: true, batch: true } });
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

  it("batch-processes a folder of TIFFs on the server", async () => {
    const input = join(tmp, "batch-in");
    const output = join(tmp, "batch-out");
    await mkdir(input);
    const a = syntheticImage("uint8", 32, 16, 1, 7);
    const b = syntheticImage("uint16", 20, 20, 2, 8);
    await writeFile(join(input, "a.tif"), writeTiff(a));
    await writeFile(join(input, "b.tiff"), writeTiff(b));
    await writeFile(join(input, "notes.txt"), "ignored");
    await writeFile(join(input, "broken.tif"), "not a tiff");

    const r = await api("/api/batch", { method: "POST", body: JSON.stringify({ input, output, steps: [{ command: "invert" }] }) });
    expect(r.status).toBe(200);
    const result = await r.json();
    expect(result.processed.map((p: { file: string }) => p.file)).toEqual(["a.tif", "b.tiff"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe("broken.tif");

    const outA = await readTiff(await readFile(join(output, "a.tif")));
    expect(outA.planes[0][0]).toBe(255 - a.planes[0][0]);
    const outB = await readTiff(await readFile(join(output, "b.tiff")));
    expect(outB.shape.slices).toBe(2);

    // a whole recipe runs in order
    const pipeline = [{ command: "flip-horizontal" }, { command: "gaussian-blur", params: { sigma: 1.5 } }];
    const r2 = await api("/api/batch", { method: "POST", body: JSON.stringify({ input, output: join(tmp, "pipe"), steps: pipeline }) });
    expect(r2.status).toBe(200);
    const outPipe = await readTiff(await readFile(join(tmp, "pipe", "a.tif")));
    expect(outPipe.planes[0]).toEqual(runSteps(a, pipeline, { kernels: await testKernels() }).planes[0]);

    const bad = (steps: unknown, out = join(tmp, "bad")) => api("/api/batch", { method: "POST", body: JSON.stringify({ input, output: out, steps }) });
    expect((await bad([{ command: "gaussian-blur", params: { sigma: -1 } }])).status).toBe(400);
    expect((await bad([{ command: "nope" }])).status).toBe(400);
    expect((await bad([])).status).toBe(400);
    expect((await bad([{ command: "invert" }], input)).status).toBe(400);
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

  it("turns tool calls into validated steps and sends metadata, not pixels", async () => {
    aiReply = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Blur to reduce noise, then invert." },
      { type: "tool_use", id: "t1", name: "gaussian-blur", input: { sigma: 1.5 } },
      { type: "tool_use", id: "t2", name: "invert", input: {} },
      { type: "tool_use", id: "t3", name: "gaussian-blur", input: { sigma: -4 } },
      { type: "tool_use", id: "t4", name: "open_dialog", input: { command: "rotate-left" } },
      { type: "tool_use", id: "t5", name: "suggest_controls", input: { title: "Clean up", commands: ["gaussian-blur", "nope", "invert"] } },
    ];
    const r = await json("/api/ai/chat", "POST", {
      message: "denoise and invert",
      context: { image: { name: "cells.tif", dtype: "uint16", width: 64, height: 32, channels: 1, slices: 3, frames: 1 }, steps: [] },
    });
    expect(r.status).toBe(200);
    const reply = await r.json();
    expect(reply.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.steps).toEqual([
      { command: "gaussian-blur", params: { sigma: 1.5 } },
      { command: "invert", params: {} },
    ]);
    expect(reply.skipped).toHaveLength(1);
    expect(reply.open).toBe("rotate-left");
    expect(reply.controls).toEqual({ title: "Clean up", commands: ["gaussian-blur", "invert"] });
    expect(reply.text).toMatch(/Blur/);

    const call = aiCalls.at(-1)!;
    expect(call.apiKey).toBe("sk-ant-test-0123456789abcdefWXYZ");
    expect(call.body.model).toBe("claude-sonnet-5-5");
    expect(call.body.fallbacks).toBe("default");
    expect(JSON.stringify(call.body.messages)).toContain("64×32, 3 slices");
    const tools = call.body.tools as { name: string; strict: boolean }[];
    expect(tools.map((t) => t.name)).toContain("gaussian-blur");
    expect(tools.every((t) => t.strict)).toBe(true);

    // the next turn replays the history unchanged and answers every tool call first
    const firstSystem = call.body.system;
    const firstTools = JSON.stringify(call.body.tools);
    aiReply = [{ type: "text", text: "Done." }];
    const r2 = await json("/api/ai/chat", "POST", { sessionId: reply.sessionId, message: "thanks", outcome: "applied" });
    expect(r2.status).toBe(200);
    const next = aiCalls.at(-1)!.body;
    const msgs = next.messages as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[];
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual((call.body.messages as unknown[])[0]);
    expect(msgs[1]).toEqual({ role: "assistant", content: aiReplyFirst() });
    expect(msgs[2].content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(msgs[2].content[0].content).toMatch(/applied/);
    expect(next.system).toBe(firstSystem);
    expect(JSON.stringify(next.tools)).toBe(firstTools);

    // unknown sessions are reported so the client can start over
    expect((await json("/api/ai/chat", "POST", { sessionId: "gone", message: "hi" })).status).toBe(404);
  });

  it("rejects empty requests", async () => {
    expect((await json("/api/ai/chat", "POST", { message: "  " })).status).toBe(400);
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
