/**
 * Warm ships: one container per ship image and workspace stays up between
 * operations, so an operation starts at once instead of paying for a new
 * container (and, with a `warm.start` process, for loading libraries or a
 * model) every time.
 *
 * The container is locked down like any run: no network, the host user's
 * uid, all capabilities dropped, the ship's memory and GPU limits. What
 * differs is how data reaches it, since mounts are fixed when it starts:
 *
 * - the workspace's artifacts are mounted read-only at `/data`, and before
 *   each operation `/in/<name>/<file>` is made a link to the input there;
 * - `/out` is a fresh in-memory folder each time, copied afterwards into the
 *   run's folder under `/runs` (the workspace's runs, mounted read-write).
 *
 * So a warm ship sees the other artifacts of its workspace (read-only), and
 * its outputs pass through memory: worth it for quick, frequent operations.
 * Operations in one container run one at a time.
 */
import { mkdir, stat } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";
import type { ShipManifest } from "@pharos/contracts";
import { buildArgv, splitWords } from "./command.js";
import type { ContainerSpec, DockerClient } from "./docker.js";
import { RunError, type RunOptions, type RunResult, parseProgress } from "./runner.js";

export const WARM_LABEL = "dev.pharos.warm";
const DEFAULT_IDLE_MINUTES = 10;

export interface WarmRunOptions extends RunOptions {
  /** The workspace's artifacts folder (mounted at /data) and runs folder (mounted at /runs; `outDir` is inside it). */
  artifactsDir: string;
  runsDir: string;
}

interface Warm {
  id: string;
  key: string;
  /** Operations queue here: one at a time per container. */
  turn: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
}

/** Turns a host path inside `root` into the same path under `mount` in the container. */
function inside(root: string, path: string, mount: string): string {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new RunError(`${path} isn't inside ${root}`);
  return posix.join(mount, ...rel.split(sep));
}

export class WarmPool {
  private readonly warm = new Map<string, Promise<Warm>>();

  constructor(private readonly docker: DockerClient) {}

  /** Removes warm containers a previous server left behind. */
  async sweep() {
    for (const c of await this.docker.listContainers(WARM_LABEL).catch(() => [])) await this.docker.remove(c.Id).catch(() => {});
  }

  /** Stops every warm container (when the server stops). */
  async close() {
    const all = [...this.warm.values()];
    this.warm.clear();
    for (const w of all) {
      const c = await w.catch(() => null);
      if (c) {
        clearTimeout(c.idle);
        await this.docker.remove(c.id).catch(() => {});
      }
    }
  }

  /** The container spec for a ship's warm container in one workspace. */
  spec(o: Pick<WarmRunOptions, "ship" | "weightsDir" | "gpu" | "artifactsDir" | "runsDir">): ContainerSpec {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const req = o.ship.requires;
    const start = o.ship.warm?.start;
    return {
      Image: o.ship.image,
      // something has to keep the container up between operations
      Cmd: start ? splitWords(start) : ["tail", "-f", "/dev/null"],
      ...(uid !== undefined && gid !== undefined ? { User: `${uid}:${gid}` } : {}),
      Env: ["HOME=/tmp", "PHAROS=1", "PYTHONUNBUFFERED=1"],
      Labels: { "dev.pharos.ship": o.ship.id, [WARM_LABEL]: "1" },
      HostConfig: {
        Mounts: [
          { Type: "bind", Source: o.artifactsDir, Target: "/data", ReadOnly: true },
          { Type: "bind", Source: o.runsDir, Target: "/runs", ReadOnly: false },
          { Type: "bind", Source: o.weightsDir, Target: "/weights", ReadOnly: false },
        ],
        NetworkMode: req?.network === "download" ? "bridge" : "none",
        ...(req?.memory_gb ? { Memory: Math.round(req.memory_gb * 1024 ** 3) } : {}),
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: { "/tmp": "rw,exec,size=4g", "/in": "rw,size=16m", "/out": "rw,size=8g" },
        ...(o.gpu ? { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] } : {}),
      },
    };
  }

  private key(o: WarmRunOptions) {
    return `${o.ship.image}|${o.artifactsDir}|${o.gpu ? "gpu" : "cpu"}`;
  }

  /** The warm container for these options, started if needed (or again, if it died). */
  private async container(o: WarmRunOptions): Promise<Warm> {
    const key = this.key(o);
    const known = this.warm.get(key);
    if (known) {
      const w = await known.catch(() => null);
      if (w && (await this.docker.running(w.id))) return w;
      this.warm.delete(key);
      if (w) await this.docker.remove(w.id).catch(() => {});
    }
    const made = (async (): Promise<Warm> => {
      await mkdir(o.weightsDir, { recursive: true });
      await mkdir(o.runsDir, { recursive: true });
      const id = await this.docker.createContainer(this.spec(o));
      await this.docker.start(id);
      return { id, key, turn: Promise.resolve() };
    })();
    this.warm.set(key, made);
    made.catch(() => this.warm.delete(key));
    return made;
  }

  private idle(o: WarmRunOptions, w: Warm) {
    clearTimeout(w.idle);
    w.idle = setTimeout(
      () => {
        this.warm.delete(w.key);
        void this.docker.remove(w.id).catch(() => {});
      },
      (o.ship.warm?.idle_minutes ?? DEFAULT_IDLE_MINUTES) * 60_000,
    );
    w.idle.unref?.();
  }

  async run(o: WarmRunOptions): Promise<RunResult> {
    const op = o.ship.operations[o.operation];
    if (!op) throw new RunError(`ship "${o.ship.id}" has no operation "${o.operation}"`);
    if (o.signal?.aborted) throw new RunError("cancelled");
    const w = await this.container(o);
    clearTimeout(w.idle);
    const mine = w.turn.then(() => this.runIn(w, o, op));
    w.turn = mine.catch(() => {});
    try {
      return await mine;
    } finally {
      this.idle(o, w);
    }
  }

  private async runIn(w: Warm, o: WarmRunOptions, op: ShipManifest["operations"][string]): Promise<RunResult> {
    if (o.signal?.aborted) throw new RunError("cancelled");
    // a cancelled operation can't be killed on its own inside the container: stop the container
    const stop = () => {
      this.warm.delete(w.key);
      void this.docker.remove(w.id).catch(() => {});
    };
    o.signal?.addEventListener("abort", stop, { once: true });
    try {
      const paths: Record<string, string> = {};
      const links: string[] = [];
      for (const [name, artifact] of Object.entries(o.inputs)) {
        paths[name] = posix.join("/in", name, basename(artifact.uri));
        links.push(`${name}=${inside(o.artifactsDir, artifact.uri, "/data")}`);
      }
      // one exec does it all (each costs a round trip): a clean /in with links to the inputs and a
      // clean /out, the operation itself, then its outputs copied into the run's folder
      await mkdir(o.outDir, { recursive: true });
      const script = [
        'out="$1"; n="$2"; shift 2',
        "rm -rf /in/* /out/* /out/.[!.]* 2>/dev/null",
        'while [ "$n" -gt 0 ]; do d="${1%%=*}"; t="${1#*=}"; mkdir -p "/in/$d" && ln -s "$t" "/in/$d/$(basename "$t")" || exit 125; n=$((n-1)); shift; done',
        '"$@"; rc=$?',
        'if [ "$rc" -eq 0 ]; then cp -a /out/. "$out" || exit 125; fi',
        "exit $rc",
      ].join("\n");
      const argv = buildArgv(op.command, o.params, paths);
      const exitCode = await this.docker.exec(w.id, ["sh", "-c", script, "sh", inside(o.runsDir, o.outDir, "/runs"), String(links.length), ...links, ...argv], (stream, line) => {
        const p = stream === "stdout" ? parseProgress(line) : null;
        if (p) o.onProgress?.(p);
        else o.onLog?.(line, stream);
      });
      if (o.signal?.aborted) throw new RunError("cancelled");
      if (exitCode === 125) throw new RunError("couldn't move data in or out of the warm container");
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
    }
  }
}
