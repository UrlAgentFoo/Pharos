/**
 * The job queue: each job is one ship operation, moving through
 * queued → downloading → running → done | failed | cancelled.
 *
 * One GPU job runs at a time and a few CPU jobs alongside it. A job's
 * image downloads once even when several jobs need it. Deterministic
 * operations are cached: the same image, operation, parameters and input
 * content return the earlier outputs at once, without running anything.
 * Every finished job leaves a run record (`runs/<id>/run.json` and
 * `log.txt`) so each output traces back to the run that made it.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, Job, Params, RunRecord, ShipManifest } from "@pharos/contracts";
import { RunCache, cacheKey } from "./cache.js";
import { type DockerClient, buildImage } from "./docker.js";
import { RunError, runOperation } from "./runner.js";

/** How the queue reads and writes a workspace; the server's workspace store provides it. */
export interface WorkspaceAccess {
  /** The workspace's `runs/` and `cache/` folders. */
  dirs(workspace: string): Promise<{ runs: string; cache: string }>;
  /** Moves an output into the workspace as an artifact. */
  adopt(workspace: string, path: string, type: { kind: Artifact["kind"]; format: Artifact["format"] }, producedBy: string): Promise<Artifact>;
  get(workspace: string, id: string): Promise<Artifact | null>;
}

export interface JobRequest {
  workspace: string;
  ship: ShipManifest;
  operation: string;
  inputs: Record<string, Artifact>;
  params: Params;
  planId?: string;
  stepId?: string;
  book?: { id: string; version: string };
  /** Run even when a cached result exists (Re-run). */
  force?: boolean;
}

export interface QueueOptions {
  docker: DockerClient;
  workspaces: WorkspaceAccess;
  weightsDir: string;
  /** The machine can give containers an NVIDIA GPU. */
  gpu: boolean;
  cpuSlots?: number;
  /** A ship's folder when it holds a Dockerfile: its image is built there rather than pulled. */
  buildContext?(ship: ShipManifest): string | undefined;
}

export interface PullEvent {
  image: string;
  ship: string;
  version: string;
  receivedBytes: number;
  totalBytes?: number;
  done: boolean;
  error?: string;
  /** For builds: the latest line of build output. */
  message?: string;
}

interface Entry {
  job: Job;
  req: JobRequest;
  abort: AbortController;
  log: string[];
}

/** A counting semaphore. */
class Slots {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async take(signal: AbortSignal): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((ok, fail) => {
      const go = () => {
        signal.removeEventListener("abort", cancel);
        ok();
      };
      const cancel = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        fail(new RunError("cancelled"));
      };
      this.waiting.push(go);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  give() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

const MAX_LOG_LINES = 5000;
const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export class JobQueue extends EventEmitter<{ job: [Job]; log: [string, string]; pull: [PullEvent] }> {
  private readonly jobs = new Map<string, Entry>();
  private readonly pulls = new Map<string, Promise<void>>();
  private readonly gpuSlot = new Slots(1);
  private readonly cpuSlots: Slots;

  constructor(private readonly o: QueueOptions) {
    super();
    this.cpuSlots = new Slots(o.cpuSlots ?? 2);
  }

  list(): Job[] {
    return [...this.jobs.values()].map((e) => e.job).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): (Job & { log: string }) | undefined {
    const e = this.jobs.get(id);
    return e && { ...e.job, log: e.log.join("\n") };
  }

  /** Whether the ship's GPU request is honoured on this machine. */
  private usesGpu(ship: ShipManifest): boolean {
    return !!ship.requires?.gpu && this.o.gpu;
  }

  submit(req: JobRequest): Job {
    const op = req.ship.operations[req.operation];
    if (!op) throw new RunError(`ship "${req.ship.id}" has no operation "${req.operation}"`);
    if (req.ship.requires?.gpu && !req.ship.requires.gpu.optional && !this.o.gpu) {
      throw new RunError(`${req.ship.id}.${req.operation} needs an NVIDIA GPU, and this machine has none available to Docker`);
    }
    const job: Job = {
      id: newId("job"),
      workspace: req.workspace,
      ship: req.ship.id,
      version: req.ship.version,
      operation: req.operation,
      state: "queued",
      gpu: this.usesGpu(req.ship),
      createdAt: now(),
      ...(req.planId ? { planId: req.planId } : {}),
      ...(req.stepId ? { stepId: req.stepId } : {}),
    };
    const entry: Entry = { job, req, abort: new AbortController(), log: [] };
    this.jobs.set(job.id, entry);
    this.emit("job", { ...job });
    void this.execute(entry);
    return { ...job };
  }

  cancel(id: string): Job | undefined {
    const e = this.jobs.get(id);
    if (!e) return undefined;
    if (!["done", "failed", "cancelled"].includes(e.job.state)) e.abort.abort();
    return { ...e.job };
  }

  /** Runs a finished job again, ignoring the cache. */
  rerun(id: string): Job | undefined {
    const e = this.jobs.get(id);
    return e && this.submit({ ...e.req, force: true });
  }

  /** Waits for a job to finish; mainly for tests and the Test buttons. */
  finished(id: string): Promise<Job> {
    return new Promise((ok) => {
      const check = (job: Job) => {
        if (job.id === id && ["done", "failed", "cancelled"].includes(job.state)) {
          this.off("job", check);
          ok(job);
        }
      };
      this.on("job", check);
      const e = this.jobs.get(id);
      if (e) check(e.job);
    });
  }

  private update(e: Entry, patch: Partial<Job>) {
    Object.assign(e.job, patch);
    this.emit("job", { ...e.job });
  }

  private log(e: Entry, line: string) {
    e.log.push(line);
    if (e.log.length > MAX_LOG_LINES) e.log.splice(0, e.log.length - MAX_LOG_LINES);
    this.emit("log", e.job.id, line);
  }

  /** Downloads (or builds) an image once, however many jobs wait for it. */
  pull(ship: ShipManifest): Promise<void> {
    const image = ship.image;
    const running = this.pulls.get(image);
    if (running) return running;
    const event = (patch: Partial<PullEvent>) => void this.emit("pull", { image, ship: ship.id, version: ship.version, receivedBytes: 0, done: false, ...patch });
    const context = this.o.buildContext?.(ship);
    const fetch = context
      ? buildImage(context, image, (line) => event({ message: line.slice(0, 200) }))
      : this.o.docker.pull(image, (receivedBytes, totalBytes) => event({ receivedBytes, totalBytes }));
    const p: Promise<void> = fetch
      .then(
        () => event({ done: true }),
        (err: unknown) => {
          event({ done: true, error: err instanceof Error ? err.message : String(err) });
          throw err;
        },
      )
      .finally(() => this.pulls.delete(image));
    this.pulls.set(image, p);
    return p;
  }

  private async execute(e: Entry) {
    const { req, abort } = e;
    const signal = abort.signal;
    const runId = newId("run");
    const startedAt = now();
    const dirs = await this.o.workspaces.dirs(req.workspace);
    const cache = new RunCache(dirs.cache);
    const runDir = join(dirs.runs, runId);
    let slot: Slots | undefined;
    try {
      // the image: pinned digests identify it without downloading
      let image = await this.o.docker.inspectImage(req.ship.image);
      const pinned = req.ship.image.includes("@sha256:") ? req.ship.image.slice(req.ship.image.indexOf("@") + 1) : undefined;
      const op = req.ship.operations[req.operation];
      const deterministic = op.cache?.deterministic ?? false;

      // the cache, before waiting for a slot or a download
      let key: string | undefined;
      const imageDigest = pinned ?? image?.Id;
      if (imageDigest) {
        key = cacheKey({
          imageDigest,
          operation: `${req.ship.id}.${req.operation}`,
          params: req.params,
          inputHashes: Object.fromEntries(Object.entries(req.inputs).map(([n, a]) => [n, a.contentHash ?? a.id])),
        });
        if (deterministic && !req.force && (await this.fromCache(e, cache, key))) return;
      }

      if (!image) {
        this.update(e, { state: "downloading", message: `${this.o.buildContext?.(req.ship) ? "Building" : "Downloading"} ${req.ship.id} ${req.ship.version}` });
        await this.pull(req.ship);
        if (signal.aborted) throw new RunError("cancelled");
        image = await this.o.docker.inspectImage(req.ship.image);
        if (!image) throw new RunError(`downloaded ${req.ship.image}, but Docker can't find it`);
        key ??= cacheKey({
          imageDigest: image.Id,
          operation: `${req.ship.id}.${req.operation}`,
          params: req.params,
          inputHashes: Object.fromEntries(Object.entries(req.inputs).map(([n, a]) => [n, a.contentHash ?? a.id])),
        });
        if (deterministic && !req.force && (await this.fromCache(e, cache, key))) return;
      }
      const runKey = key!; // set above: from the pinned digest, or once the image is here

      this.update(e, { state: "queued", message: e.job.gpu ? "Waiting for the GPU" : "Waiting for a free slot" });
      slot = e.job.gpu ? this.gpuSlot : this.cpuSlots;
      await slot.take(signal);
      this.update(e, { state: "running", startedAt: now(), progress: 0, message: "Starting" });

      await mkdir(runDir, { recursive: true });
      const logFile = join(runDir, "log.txt");
      const result = await runOperation(this.o.docker, {
        ship: req.ship,
        operation: req.operation,
        inputs: req.inputs,
        params: req.params,
        outDir: join(runDir, "out"),
        weightsDir: this.o.weightsDir,
        gpu: e.job.gpu,
        signal,
        onLog: (line) => {
          this.log(e, line);
          void appendFile(logFile, line + "\n");
        },
        onProgress: (p) => this.update(e, { ...(p.progress !== undefined ? { progress: p.progress } : {}), ...(p.message ? { message: p.message } : {}) }),
      });
      if (result.exitCode !== 0) {
        const tail = e.log.slice(-3).join(" ").slice(-300);
        throw new RunError(`exited with code ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }

      const outputs: Record<string, string> = {};
      let bytes = 0;
      for (const out of op.outputs) {
        const a = await this.o.workspaces.adopt(req.workspace, result.outputs[out.name], { kind: out.kind, format: out.format }, runId);
        outputs[out.name] = a.id;
        bytes += a.sizeBytes ?? 0;
      }
      await rm(join(runDir, "out"), { recursive: true, force: true });
      if (deterministic) await cache.put({ key: runKey, outputs, bytes, runId });

      const record: RunRecord = {
        id: runId,
        jobId: e.job.id,
        ...(req.book ? { book: req.book } : {}),
        ...(req.stepId ? { stepId: req.stepId } : {}),
        ship: { id: req.ship.id, version: req.ship.version, imageDigest: imageDigest ?? image.Id },
        operation: req.operation,
        params: req.params,
        inputs: Object.fromEntries(Object.entries(req.inputs).map(([n, a]) => [n, a.id])),
        outputs,
        cacheKey: runKey,
        cached: false,
        exitCode: result.exitCode,
        logFile: "log.txt",
        startedAt,
        finishedAt: now(),
      };
      await writeFile(join(runDir, "run.json"), JSON.stringify(record, null, 2) + "\n");
      this.update(e, { state: "done", progress: 1, message: "Done", outputs, runId, finishedAt: now() });
    } catch (err) {
      const cancelled = signal.aborted;
      const message = cancelled ? "Cancelled" : err instanceof Error ? err.message : String(err);
      if (!cancelled) this.log(e, `error: ${message}`);
      this.update(e, { state: cancelled ? "cancelled" : "failed", message, ...(cancelled ? {} : { error: message }), finishedAt: now() });
      await rm(join(runDir, "out"), { recursive: true, force: true }).catch(() => {});
    } finally {
      slot?.give();
    }
  }

  /** Finishes the job from the cache when every cached output still exists. */
  private async fromCache(e: Entry, cache: RunCache, key: string): Promise<boolean> {
    const hit = await cache.get(key);
    if (!hit) return false;
    for (const id of Object.values(hit.outputs)) {
      if (!(await this.o.workspaces.get(e.req.workspace, id))) {
        await cache.delete(key);
        return false;
      }
    }
    this.log(e, `Reused the outputs of ${hit.runId} (same image, inputs and parameters).`);
    this.update(e, { state: "done", cached: true, progress: 1, message: "Done (cached)", outputs: hit.outputs, runId: hit.runId, finishedAt: now() });
    return true;
  }
}
