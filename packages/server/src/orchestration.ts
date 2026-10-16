/**
 * The server's side of running ships: system status, the job queue, the
 * live event stream, storage, "Get ready" downloads, Test ship, and the
 * trust records Test ship leaves behind.
 */
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Library } from "@pharos/books";
import type { ImageInventory } from "@pharos/books";
import type { Artifact, Job, Params, ServerEvent, ShipManifest, StorageReport, SystemStatus, TestResult, TrustLevel } from "@pharos/contracts";
import { withDefaults } from "@pharos/core";
import { type DockerClient, JobQueue, type JobRequest, RunCache, type WorkspaceAccess, connect, detectStatus } from "@pharos/orchestrator";
import { WorkspaceError, type WorkspaceStore } from "./workspaces.js";

export class OrchestrationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Workspace that Test ship runs in, so tests don't fill the user's own. */
export const TEST_WORKSPACE = "pharos-tests";

// ------------------------------------------------------------ trust records

type TrustRecord = { trust: TrustLevel; at: string; error?: string };

/** `<data>/trust.json`: which ship and book versions passed their tests on this machine. */
export class TrustStore {
  private records: Record<string, TrustRecord> = {};
  /** Bumped on every change, so caches built from trust levels know to rebuild. */
  version = 0;
  private constructor(private readonly file: string) {}

  static async load(dataDir: string): Promise<TrustStore> {
    const store = new TrustStore(join(dataDir, "trust.json"));
    store.records = JSON.parse(await readFile(store.file, "utf8").catch(() => "{}")) as Record<string, TrustRecord>;
    return store;
  }

  get = (type: "ship" | "book", id: string, version: string): TrustLevel | undefined => this.records[`${type}:${id}@${version}`]?.trust;

  async set(type: "ship" | "book", id: string, version: string, record: Omit<TrustRecord, "at">) {
    this.records[`${type}:${id}@${version}`] = { ...record, at: new Date().toISOString() };
    this.version++;
    await writeFile(this.file, JSON.stringify(this.records, null, 2) + "\n");
  }
}

// ------------------------------------------------------------ orchestration

export class Orchestration {
  readonly events = new EventEmitter<{ event: [ServerEvent] }>();
  private docker: DockerClient | null = null;
  private queue: JobQueue | null = null;
  private status: SystemStatus | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly workspaces: WorkspaceStore,
    private readonly library: () => Promise<Library>,
    readonly trust: TrustStore,
  ) {}

  emit(event: ServerEvent) {
    this.events.emit("event", event);
  }

  /** Checks Docker and the GPU again; creates the queue once Docker answers. */
  async refreshStatus(): Promise<SystemStatus> {
    this.docker ??= connect();
    const status = await detectStatus(this.dataDir, this.docker);
    const changed = JSON.stringify({ ...status, disk: null }) !== JSON.stringify({ ...this.status, disk: null });
    this.status = status;
    if (status.docker.available && this.docker && !this.queue) {
      this.queue = new JobQueue({ docker: this.docker, workspaces: this.access(), weightsDir: join(this.dataDir, "weights"), gpu: status.gpu.available });
      this.queue.on("job", (job) => this.emit({ type: "job", job }));
      this.queue.on("log", (jobId, line) => this.emit({ type: "job-log", jobId, line }));
      this.queue.on("pull", (p) => this.emit({ type: "pull", ship: p.ship, version: p.version, receivedBytes: p.receivedBytes, ...(p.totalBytes ? { totalBytes: p.totalBytes } : {}), done: p.done, ...(p.error ? { error: p.error } : {}) }));
    }
    if (changed) this.emit({ type: "status", status });
    return status;
  }

  /** The workspace store as the queue sees it: a missing artifact is null, not an error. */
  private access(): WorkspaceAccess {
    const store = this.workspaces;
    return {
      dirs: (w) => store.dirs(w),
      adopt: (w, path, type, producedBy) => store.adopt(w, path, type, producedBy),
      get: (w, id) =>
        store.get(w, id).catch((e: unknown) => {
          if (e instanceof WorkspaceError && e.status === 404) return null;
          throw e;
        }),
    };
  }

  private async ready(): Promise<{ docker: DockerClient; queue: JobQueue; status: SystemStatus }> {
    const status = this.status?.docker.available ? this.status : await this.refreshStatus();
    if (!this.docker || !this.queue) throw new OrchestrationError(503, status.docker.error ?? "Docker isn't available");
    return { docker: this.docker, queue: this.queue, status };
  }

  /** What's downloaded, for resolving books. Asks Docker about each ship image once. */
  async inventory(ships: ShipManifest[]): Promise<ImageInventory> {
    const sizes = new Map<string, number>();
    if (this.status?.docker.available || (await this.refreshStatus()).docker.available) {
      await Promise.all(
        ships.map(async (s) => {
          const info = await this.docker!.inspectImage(s.image).catch(() => null);
          if (info) sizes.set(s.image, info.Size);
        }),
      );
    }
    return { has: (image) => sizes.has(image), sizeBytes: (image) => sizes.get(image) };
  }

  gpu(): boolean {
    return !!this.status?.gpu.available;
  }

  // ---------------------------------------------------------- jobs

  async run(req: { workspace: string; tool: string; version?: string; inputs: Record<string, string>; params?: Params; force?: boolean }) {
    const { queue } = await this.ready();
    const [shipId, operation] = req.tool.split(".");
    const ship = (await this.library()).ship(shipId, req.version);
    if (!ship) throw new OrchestrationError(404, `no ship "${shipId}" in the library`);
    if (!ship.operations[operation]) throw new OrchestrationError(404, `ship "${shipId}" has no operation "${operation}"`);
    const inputs: Record<string, Artifact> = {};
    for (const [name, id] of Object.entries(req.inputs ?? {})) inputs[name] = await this.workspaces.get(req.workspace, id);
    try {
      return queue.submit({ workspace: req.workspace, ship, operation, inputs, params: await this.checkedParams(ship, operation, req.params ?? {}), force: req.force });
    } catch (e) {
      throw new OrchestrationError(400, e instanceof Error ? e.message : String(e));
    }
  }

  private async checkedParams(ship: ShipManifest, operation: string, params: Params): Promise<Params> {
    try {
      return withDefaults(ship.operations[operation].parameters ?? [], params);
    } catch (e) {
      throw new OrchestrationError(400, e instanceof Error ? e.message : String(e));
    }
  }

  /** Queues one job of a plan; parameters must already be checked. */
  async submit(req: JobRequest): Promise<Job> {
    const { queue } = await this.ready();
    try {
      return queue.submit(req);
    } catch (e) {
      throw new OrchestrationError(400, e instanceof Error ? e.message : String(e));
    }
  }

  async finished(jobId: string): Promise<Job> {
    return (await this.ready()).queue.finished(jobId);
  }

  jobs() {
    return this.queue?.list() ?? [];
  }

  job(id: string) {
    const job = this.queue?.get(id);
    if (!job) throw new OrchestrationError(404, `no job ${id}`);
    return job;
  }

  cancel(id: string) {
    const job = this.queue?.cancel(id);
    if (!job) throw new OrchestrationError(404, `no job ${id}`);
    return job;
  }

  rerun(id: string) {
    const job = this.queue?.rerun(id);
    if (!job) throw new OrchestrationError(404, `no job ${id}`);
    return job;
  }

  // ---------------------------------------------------------- ships on disk

  /** Starts downloading the ships a book needs that aren't here yet. */
  async getReady(bookId: string, version?: string) {
    const { queue } = await this.ready();
    const lib = await this.library();
    const book = lib.book(bookId, version)?.manifest;
    if (!book) throw new OrchestrationError(404, `no book "${bookId}" in the library`);
    const ships = Object.entries(book.ships).flatMap(([id, range]) => lib.ship(id, range) ?? []);
    const inventory = await this.inventory(ships);
    const missing = ships.filter((s) => !inventory.has(s.image));
    for (const s of missing) void queue.pull(s).catch(() => {}); // failures arrive as pull events
    return { pulling: missing.map((s) => ({ id: s.id, version: s.version, image: s.image })) };
  }

  async storage(): Promise<StorageReport> {
    const lib = await this.library();
    const ships = lib.shipManifests();
    const inventory = await this.inventory(ships);
    const report: StorageReport = { ships: [], cache: { usedBytes: 0, limitBytes: new RunCache("").limitBytes }, artifactsBytes: 0 };
    for (const s of ships) {
      if (!inventory.has(s.image)) continue;
      report.ships.push({ id: s.id, version: s.version, image: s.image, sizeBytes: inventory.sizeBytes?.(s.image) ?? 0, usedBy: this.usedBy(lib, s) });
    }
    for (const w of await this.workspaces.list()) {
      const dirs = await this.workspaces.dirs(w.name);
      report.cache.usedBytes += await new RunCache(dirs.cache).usage();
      report.artifactsBytes += (await this.workspaces.artifacts(w.name)).reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
    }
    return report;
  }

  private usedBy(lib: Library, ship: ShipManifest): string[] {
    return lib
      .bookManifests()
      .filter((b) => b.ships[ship.id] && lib.ship(ship.id, b.ships[ship.id])?.version === ship.version)
      .map((b) => b.id);
  }

  /** Deletes a ship's image; refuses while an installed book needs it, unless forced. */
  async removeShip(id: string, version: string, force: boolean) {
    const { docker } = await this.ready();
    const lib = await this.library();
    const ship = lib.shipManifests().find((s) => s.id === id && s.version === version);
    if (!ship) throw new OrchestrationError(404, `no ship "${id}" ${version} in the library`);
    const users = this.usedBy(lib, ship);
    if (users.length && !force) throw new OrchestrationError(409, `${users.join(", ")} still use${users.length === 1 ? "s" : ""} ${id} ${version}`);
    const info = await docker.inspectImage(ship.image);
    if (!info) return { freedBytes: 0 };
    await docker.removeImage(ship.image).catch((e: Error) => {
      throw new OrchestrationError(409, `Docker couldn't remove it: ${e.message}`);
    });
    this.emit({ type: "library", change: "ships" });
    return { freedBytes: info.Size };
  }

  async clearCache() {
    let freedBytes = 0;
    for (const w of await this.workspaces.list()) freedBytes += await new RunCache((await this.workspaces.dirs(w.name)).cache).clear();
    return { freedBytes };
  }

  // ---------------------------------------------------------- Test ship

  /**
   * Runs each operation on its test data: `test/<operation>/<input>.<ext>`,
   * optional `params.yaml`, and optional `expected-<output>.<ext>` files the
   * outputs must equal. A ship that passes every case becomes verified.
   */
  async testShip(id: string, version?: string): Promise<TestResult> {
    const { queue } = await this.ready();
    const lib = await this.library();
    const ship = lib.ship(id, version);
    const loaded = lib.ships.find((s) => s.manifest === ship);
    if (!ship || !loaded) throw new OrchestrationError(404, `no ship "${id}" in the library`);
    await this.workspaces.create(TEST_WORKSPACE);
    const cases: TestResult["cases"] = [];
    for (const [name, op] of Object.entries(ship.operations)) {
      const dir = join(loaded.dir, "test", name);
      const files = await readdir(dir).catch(() => null);
      if (!files) {
        cases.push({ name, passed: false, message: `no test data in test/${name}/` });
        continue;
      }
      try {
        const inputs: Record<string, Artifact> = {};
        for (const input of op.inputs ?? []) {
          const file = files.find((f) => f === input.name || f.startsWith(`${input.name}.`));
          if (!file) {
            if (input.optional) continue;
            throw new Error(`test/${name}/ has no file for input "${input.name}"`);
          }
          inputs[input.name] = await this.workspaces.importPath(TEST_WORKSPACE, join(dir, file));
        }
        const params = files.includes("params.yaml") ? ((parse(await readFile(join(dir, "params.yaml"), "utf8")) ?? {}) as Params) : {};
        const job = queue.submit({ workspace: TEST_WORKSPACE, ship, operation: name, inputs, params: await this.checkedParams(ship, name, params), force: true });
        const done = await queue.finished(job.id);
        if (done.state !== "done") {
          cases.push({ name, passed: false, message: done.error ?? done.state, jobId: job.id });
          continue;
        }
        const mismatched: string[] = [];
        for (const out of op.outputs) {
          const expected = files.find((f) => f.startsWith(`expected-${out.name}.`));
          if (!expected) continue;
          const artifact = await this.workspaces.get(TEST_WORKSPACE, done.outputs![out.name]);
          const [want, got] = await Promise.all([readFile(join(dir, expected)), readFile(artifact.uri).catch(() => null)]);
          if (!got || !want.equals(got)) mismatched.push(out.name);
        }
        cases.push(
          mismatched.length
            ? { name, passed: false, message: `output ${mismatched.join(", ")} differs from test/${name}/expected-*`, jobId: job.id }
            : { name, passed: true, jobId: job.id },
        );
      } catch (e) {
        cases.push({ name, passed: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    const passed = cases.length > 0 && cases.every((c) => c.passed);
    const failed = cases.find((c) => !c.passed);
    await this.trust.set("ship", ship.id, ship.version, passed ? { trust: "verified" } : { trust: "imported", error: `${failed?.name}: ${failed?.message}` });
    this.emit({ type: "library", change: "ships" });
    return { target: { type: "ship", id: ship.id, version: ship.version }, passed, cases };
  }
}
