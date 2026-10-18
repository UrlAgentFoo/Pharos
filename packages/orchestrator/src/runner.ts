/**
 * Runs one ship operation in a container, locked down:
 *
 * - each input is mounted read-only at `/in/<name>/<file name>`;
 * - `/out` is an empty folder the operation writes its outputs to;
 * - `/weights` is shared between runs so models download once;
 * - no network unless the ship asks for `download`, the host user's uid,
 *   all capabilities dropped, the memory limit from `requires`;
 * - nothing else from the host: never the home folder, never the Docker
 *   socket.
 *
 * Lines the operation prints as `{"progress": …, "message": …}` report
 * progress; everything else is its log.
 */
import { mkdir, stat } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Artifact, Params, ProgressLine, ShipManifest } from "@pharos/contracts";
import { buildArgv } from "./command.js";
import type { ContainerSpec, DockerClient } from "./docker.js";

export interface RunOptions {
  ship: ShipManifest;
  operation: string;
  inputs: Record<string, Artifact>;
  params: Params;
  /** Empty folder mounted at /out. */
  outDir: string;
  /** Shared model folder mounted at /weights. */
  weightsDir: string;
  /** Give the container the GPU (the machine has one and the ship wants it). */
  gpu: boolean;
  signal?: AbortSignal;
  onLog?(line: string, stream: "stdout" | "stderr"): void;
  onProgress?(p: ProgressLine): void;
  /** Called once the container exists, e.g. to record its id. */
  onContainer?(id: string): void;
}

export interface RunResult {
  exitCode: number;
  /** Output name → path on the host. */
  outputs: Record<string, string>;
}

export class RunError extends Error {}

/** Parses a progress line, or returns null for an ordinary log line. */
export function parseProgress(line: string): ProgressLine | null {
  if (!line.startsWith("{")) return null;
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const progress = typeof v.progress === "number" && v.progress >= 0 && v.progress <= 1 ? v.progress : undefined;
    const message = typeof v.message === "string" ? v.message : undefined;
    if (progress === undefined && message === undefined) return null;
    return { ...(progress !== undefined ? { progress } : {}), ...(message !== undefined ? { message } : {}) };
  } catch {
    return null;
  }
}

/** The container a run uses; exported so tests can check the lockdown without Docker. */
export function containerSpec(o: Omit<RunOptions, "signal" | "onLog" | "onProgress" | "onContainer">): ContainerSpec {
  const op = o.ship.operations[o.operation];
  if (!op) throw new RunError(`ship "${o.ship.id}" has no operation "${o.operation}"`);
  const mounts: ContainerSpec["HostConfig"]["Mounts"] = [];
  const bind = (Source: string, Target: string, ReadOnly: boolean) => mounts.push({ Type: "bind", Source, Target, ReadOnly });
  const paths: Record<string, string> = {};
  for (const [name, artifact] of Object.entries(o.inputs)) {
    const file = basename(artifact.uri);
    paths[name] = posix.join("/in", name, file);
    bind(artifact.uri, paths[name], true);
  }
  bind(o.outDir, "/out", false);
  bind(o.weightsDir, "/weights", false);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const req = o.ship.requires;
  return {
    Image: o.ship.image,
    Cmd: buildArgv(op.command, o.params, paths),
    ...(uid !== undefined && gid !== undefined ? { User: `${uid}:${gid}` } : {}),
    Env: ["HOME=/tmp", "PHAROS=1", "PYTHONUNBUFFERED=1"],
    Labels: { "dev.pharos.ship": o.ship.id, "dev.pharos.operation": o.operation },
    HostConfig: {
      Mounts: mounts,
      NetworkMode: req?.network === "download" ? "bridge" : "none",
      ...(req?.memory_gb ? { Memory: Math.round(req.memory_gb * 1024 ** 3) } : {}),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,exec,size=4g" },
      ...(o.gpu ? { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] } : {}),
    },
  };
}

/** How long the log stream may run on after the container stops. */
const LOG_GRACE_MS = 2000;

/**
 * A container's exit code: Docker's wait, or its state, checked every
 * `pollMs`, when the wait doesn't answer (under load Docker has kept a wait
 * open after the container stopped, and the job then held its slot forever).
 */
export async function untilExit(docker: Pick<DockerClient, "wait" | "exitCode">, id: string, pollMs = 3000): Promise<number> {
  let answered = false;
  const wait = docker.wait(id).finally(() => (answered = true));
  while (!answered) {
    const code = await Promise.race([wait, sleep(pollMs, null)]);
    if (code !== null) return code;
    const stopped = await docker.exitCode(id).catch(() => null);
    if (stopped !== null) return stopped;
  }
  return wait;
}

export async function runOperation(docker: DockerClient, o: RunOptions): Promise<RunResult> {
  const op = o.ship.operations[o.operation];
  const spec = containerSpec(o);
  await mkdir(o.outDir, { recursive: true });
  await mkdir(o.weightsDir, { recursive: true });
  if (o.signal?.aborted) throw new RunError("cancelled");

  const id = await docker.createContainer(spec);
  o.onContainer?.(id);
  const stop = () => void docker.stop(id).catch(() => {});
  o.signal?.addEventListener("abort", stop, { once: true });
  try {
    // cancelled while the container was being created: the listener came too late
    if (o.signal?.aborted) throw new RunError("cancelled");
    await docker.start(id);
    if (o.signal?.aborted) stop();
    const logs = docker.followLogs(id, (stream, line) => {
      const p = stream === "stdout" ? parseProgress(line) : null;
      if (p) o.onProgress?.(p);
      else o.onLog?.(line, stream);
    });
    const exitCode = await untilExit(docker, id);
    // the log stream ends with the container, but Docker has been seen to keep it open after the exit:
    // what it has sent by now is the output, so it gets a moment, not forever
    await Promise.race([logs.catch(() => {}), sleep(LOG_GRACE_MS)]);
    if (o.signal?.aborted) throw new RunError("cancelled");
    if (exitCode !== 0) return { exitCode, outputs: {} };

    const outputs: Record<string, string> = {};
    const missing: string[] = [];
    for (const out of op.outputs) {
      const host = join(o.outDir, posix.relative("/out", out.path));
      if (await stat(host).catch(() => null)) outputs[out.name] = host;
      else missing.push(out.path);
    }
    if (missing.length) throw new RunError(`the operation finished but didn't write ${missing.join(", ")}`);
    return { exitCode, outputs };
  } finally {
    o.signal?.removeEventListener("abort", stop);
    await docker.remove(id).catch(() => {});
  }
}
