import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Artifact, Job, ShipManifest } from "@pharos/contracts";
import { JobQueue, RunCache, WARM_LABEL, type WorkspaceAccess, buildArgv, cacheKey, connect, containerSpec, contextHash, detectStatus, parseProgress, splitRef, splitWords } from "@pharos/orchestrator";

const HELLO: ShipManifest = parse(await readFile(new URL("../../../ships/hello/ship.yaml", import.meta.url), "utf8"));

const artifact = (uri: string, extra: Partial<Artifact> = {}): Artifact => ({
  id: "a".repeat(64),
  kind: "table",
  format: "csv",
  uri,
  meta: {},
  contentHash: "sha256:" + "a".repeat(64),
  createdAt: new Date(0).toISOString(),
  ...extra,
});

describe("commands", () => {
  it("splits words and keeps quoted text together", () => {
    expect(splitWords(`run --in /in/x --name "two words" 'it''s'`)).toEqual(["run", "--in", "/in/x", "--name", "two words", "its"]);
    expect(splitWords(`a "" b`)).toEqual(["a", "", "b"]);
    expect(() => splitWords(`a "b`)).toThrow(/unclosed/);
  });

  it("fills placeholders inside words, so values can't add arguments or commands", () => {
    const argv = buildArgv("tool --in {in.image} --model={model} --d {diameter}", { model: "x; rm -rf / #", diameter: 30 }, { image: "/in/image/a.tif" });
    expect(argv).toEqual(["tool", "--in", "/in/image/a.tif", "--model=x; rm -rf / #", "--d", "30"]);
    expect(() => buildArgv("tool {nope}", {}, {})).toThrow(/no parameter "nope"/);
    expect(() => buildArgv("tool {in.mask}", {}, {})).toThrow(/no input "mask"/);
  });

  it("parses image references for pulling", () => {
    expect(splitRef("busybox@sha256:abc")).toEqual({ name: "busybox", tag: "sha256:abc" });
    expect(splitRef("localhost:5000/a/b:1.2")).toEqual({ name: "localhost:5000/a/b", tag: "1.2" });
    expect(splitRef("localhost:5000/a/b")).toEqual({ name: "localhost:5000/a/b", tag: "latest" });
  });

  it("reads progress lines and leaves everything else as log", () => {
    expect(parseProgress('{"progress": 0.5, "message": "tile 3/8"}')).toEqual({ progress: 0.5, message: "tile 3/8" });
    expect(parseProgress('{"progress": 50e-2}')).toEqual({ progress: 0.5 });
    expect(parseProgress('{"progress": 7}')).toBeNull();
    expect(parseProgress('{"other": 1}')).toBeNull();
    expect(parseProgress("plain text")).toBeNull();
  });
});

describe("container lockdown", () => {
  const spec = containerSpec({
    ship: HELLO,
    operation: "count",
    inputs: { table: artifact("/data/ws/artifacts/x/cells.csv") },
    params: { seconds: 1 },
    outDir: "/data/ws/runs/r1/out",
    weightsDir: "/data/weights",
    gpu: false,
  });

  it("mounts inputs read-only, an empty /out and /weights, and nothing else", () => {
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/data/ws/artifacts/x/cells.csv", Target: "/in/table/cells.csv", ReadOnly: true },
      { Type: "bind", Source: "/data/ws/runs/r1/out", Target: "/out", ReadOnly: false },
      { Type: "bind", Source: "/data/weights", Target: "/weights", ReadOnly: false },
    ]);
    const sources = spec.HostConfig.Mounts.map((m) => m.Source);
    expect(sources).not.toContain(homedir());
    expect(sources.some((s) => s.includes("docker.sock"))).toBe(false);
  });

  it("has no network, no capabilities and the host user's uid", () => {
    expect(spec.HostConfig.NetworkMode).toBe("none");
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(spec.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(spec.HostConfig.Memory).toBe(0.25 * 1024 ** 3);
    expect(spec.HostConfig.DeviceRequests).toBeUndefined();
    expect(spec.Cmd.slice(-2)).toEqual(["/in/table/cells.csv", "1"]);
  });

  it("asks for the GPU only when told to, and the network only for downloads", () => {
    const gpu = containerSpec({ ship: { ...HELLO, requires: { network: "download" } }, operation: "count", inputs: { table: artifact("/x.csv") }, params: { seconds: 1 }, outDir: "/o", weightsDir: "/w", gpu: true });
    expect(gpu.HostConfig.DeviceRequests).toEqual([{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }]);
    expect(gpu.HostConfig.NetworkMode).toBe("bridge");
  });
});

describe("cache", () => {
  it("keys on canonical content, not key order", () => {
    const a = cacheKey({ imageDigest: "sha256:1", operation: "x.y", params: { a: 1, b: "2" }, inputHashes: { i: "h" } });
    const b = cacheKey({ inputHashes: { i: "h" }, params: { b: "2", a: 1 }, operation: "x.y", imageDigest: "sha256:1" });
    expect(a).toBe(b);
    expect(cacheKey({ imageDigest: "sha256:1", operation: "x.y", params: { a: 2, b: "2" }, inputHashes: { i: "h" } })).not.toBe(a);
  });

  it("evicts the least recently used entries over its limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-cache-"));
    try {
      const cache = new RunCache(dir, 250);
      const key = (n: number) => String(n).repeat(64);
      await cache.put({ key: key(1), outputs: { o: "1" }, bytes: 100, runId: "r1" });
      await new Promise((r) => setTimeout(r, 5));
      await cache.put({ key: key(2), outputs: { o: "2" }, bytes: 100, runId: "r2" });
      await new Promise((r) => setTimeout(r, 5));
      expect(await cache.get(key(1))).toMatchObject({ runId: "r1" }); // now the most recently used
      await new Promise((r) => setTimeout(r, 5));
      await cache.put({ key: key(3), outputs: { o: "3" }, bytes: 100, runId: "r3" });
      expect((await cache.entries()).map((e) => e.runId).sort()).toEqual(["r1", "r3"]);
      expect(await cache.usage()).toBe(200);
      expect(await cache.clear()).toBe(200);
      expect(await cache.entries()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ship images", () => {
  it("hash what goes into the image, ignoring tests and ship.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-ctx-"));
    try {
      await writeFile(join(dir, "Dockerfile"), "FROM busybox\nCOPY run.sh /\n");
      await writeFile(join(dir, "run.sh"), "echo 1\n");
      await writeFile(join(dir, "ship.yaml"), "id: x\n");
      await mkdir(join(dir, "test"));
      const first = await contextHash(dir);
      await writeFile(join(dir, "ship.yaml"), "id: x\nsummary: changed\n");
      await writeFile(join(dir, "test", "input.csv"), "a\n1\n");
      expect(await contextHash(dir)).toBe(first);
      await writeFile(join(dir, "run.sh"), "echo 2\n");
      expect(await contextHash(dir)).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ with Docker

const docker = connect();
const dockerUp = !!docker && (await docker.ping());

describe.skipIf(!dockerUp)("with Docker", () => {
  let root: string;
  let queue: JobQueue;
  let table: Artifact;
  const adopted = new Map<string, Artifact>();
  /** Which workspaces hold which artifacts: the cache is shared, the artifacts aren't. */
  const held = new Map<string, Set<string>>();
  const hold = (ws: string, id: string) => held.set(ws, new Set([...(held.get(ws) ?? []), id]));
  const events: Job[] = [];

  const access: WorkspaceAccess = {
    dirs: async () => ({ runs: join(root, "runs"), cache: join(root, "cache"), artifacts: join(root, "artifacts") }),
    adopt: async (ws, path, type, producedBy) => {
      const id = String(adopted.size + 1).padStart(64, "0");
      const dest = join(root, "artifacts", id);
      await mkdir(join(root, "artifacts"), { recursive: true });
      await rename(path, dest);
      const a = artifact(dest, { id, ...type, producedBy, sizeBytes: (await stat(dest)).size });
      adopted.set(id, a);
      hold(ws, id);
      return a;
    },
    get: async (ws, id) => (held.get(ws)?.has(id) ? (adopted.get(id) ?? null) : null),
    copy: async (from, id, to) => {
      if (!held.get(from)?.has(id)) return null;
      hold(to, id);
      return adopted.get(id) ?? null;
    },
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pharos-jobs-"));
    await writeFile(join(root, "cells.csv"), "label,area\n1,12\n2,30\n3,7\n");
    table = artifact(join(root, "cells.csv"));
    queue = new JobQueue({ docker: docker!, workspaces: access, weightsDir: join(root, "weights"), gpu: false });
    queue.on("job", (j) => events.push(j));
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it("reports Docker in the system status", async () => {
    const s = await detectStatus(root, docker);
    expect(s.docker).toMatchObject({ available: true, version: expect.any(String) });
    expect(s.disk.freeBytes).toBeGreaterThan(0);
  });

  it("runs an operation with progress, writes a run record and adopts its output", async () => {
    const job = queue.submit({ workspace: "w", ship: HELLO, operation: "count", inputs: { table }, params: { seconds: 2 } });
    const done = await queue.finished(job.id);
    expect(done).toMatchObject({ state: "done", progress: 1, outputs: { count: expect.any(String) } });
    expect(events.filter((e) => e.id === job.id).map((e) => e.state)).toEqual(expect.arrayContaining(["queued", "running", "done"]));
    expect(events.some((e) => e.id === job.id && e.message === "step 1 of 2")).toBe(true);
    const out = adopted.get(done.outputs!.count)!;
    expect(await readFile(out.uri, "utf8")).toBe("rows\n3\n");
    const record = JSON.parse(await readFile(join(root, "runs", done.runId!, "run.json"), "utf8"));
    expect(record).toMatchObject({ jobId: job.id, operation: "count", params: { seconds: 2 }, cached: false, exitCode: 0 });
    expect(queue.get(job.id)!.log).toMatch(/counting \/in\/table\/cells\.csv/);
  }, 120_000);

  it("returns cached outputs for the same inputs and parameters, unless re-run", async () => {
    const job = queue.submit({ workspace: "w", ship: HELLO, operation: "count", inputs: { table }, params: { seconds: 2 } });
    const done = await queue.finished(job.id);
    expect(done).toMatchObject({ state: "done", cached: true });
    const again = queue.rerun(job.id)!;
    expect(await queue.finished(again.id)).toMatchObject({ state: "done" });
    expect((await queue.finished(again.id)).cached).toBeUndefined();
  }, 120_000);

  it("reuses a result made in another workspace, bringing its outputs over", async () => {
    const job = queue.submit({ workspace: "w2", ship: HELLO, operation: "count", inputs: { table }, params: { seconds: 2 } });
    const done = await queue.finished(job.id);
    expect(done).toMatchObject({ state: "done", cached: true });
    expect(held.get("w2")?.has(done.outputs!.count)).toBe(true);
  }, 120_000);

  it("runs warm ships inside one container that stays up, and stops it on close", async () => {
    const warm: ShipManifest = { ...HELLO, mode: "warm" };
    await mkdir(join(root, "artifacts", "t"), { recursive: true });
    await writeFile(join(root, "artifacts", "t", "cells.csv"), "label\n1\n2\n");
    const input = artifact(join(root, "artifacts", "t", "cells.csv"), { id: "b".repeat(64), contentHash: undefined });
    const first = await queue.finished(queue.submit({ workspace: "w", ship: warm, operation: "count", inputs: { table: input }, params: { seconds: 1 }, force: true }).id);
    expect(first).toMatchObject({ state: "done" });
    expect(await readFile(adopted.get(first.outputs!.count)!.uri, "utf8")).toBe("rows\n2\n");
    const second = await queue.finished(queue.submit({ workspace: "w", ship: warm, operation: "count", inputs: { table: input }, params: { seconds: 0 }, force: true }).id);
    expect(second).toMatchObject({ state: "done" });
    expect((await docker!.listContainers(WARM_LABEL)).length).toBe(1);
    await queue.close();
    expect(await docker!.listContainers(WARM_LABEL)).toEqual([]);
  }, 120_000);

  it("cancels a running job", async () => {
    const job = queue.submit({ workspace: "w", ship: HELLO, operation: "count", inputs: { table }, params: { seconds: 60 } });
    while (queue.get(job.id)!.state !== "running") await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    queue.cancel(job.id);
    expect(await queue.finished(job.id)).toMatchObject({ state: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 120_000);

  it("fails clearly when the operation fails", async () => {
    const broken: ShipManifest = { ...HELLO, operations: { count: { ...HELLO.operations.count, command: "sh -c 'echo no such file >&2; exit 3'" } } };
    const job = queue.submit({ workspace: "w", ship: broken, operation: "count", inputs: { table }, params: {}, force: true });
    const done = await queue.finished(job.id);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/exited with code 3: no such file/);
  }, 120_000);
});
