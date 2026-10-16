/**
 * A small client for the Docker Engine API over its unix socket: just the
 * calls Pharos needs (images, containers, logs). Talking to the API
 * directly gives byte-level download progress and needs no dependency.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ImageInfo {
  /** Content digest of the image config; changes whenever the image does. */
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Size: number;
}

export interface ContainerSpec {
  Image: string;
  Cmd: string[];
  User?: string;
  Env?: string[];
  Labels?: Record<string, string>;
  HostConfig: {
    Mounts: { Type: "bind"; Source: string; Target: string; ReadOnly: boolean }[];
    NetworkMode: "none" | "bridge";
    Memory?: number;
    CapDrop: string[];
    SecurityOpt: string[];
    Tmpfs?: Record<string, string>;
    DeviceRequests?: { Driver: string; Count: number; Capabilities: string[][] }[];
  };
}

/**
 * Builds an image from a folder with a Dockerfile, using the docker command
 * line (BuildKit), and reports each line of its output. Ship folders hold
 * the Dockerfile of images that aren't published to a registry.
 */
export function buildImage(context: string, tag: string, onLine: (line: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn("docker", ["build", "--progress=plain", "--tag", tag, context], { stdio: ["ignore", "pipe", "pipe"], signal });
    const tail: string[] = [];
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (e) => fail(new DockerError(500, e.name === "AbortError" ? "cancelled" : `couldn't run docker build: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? ok() : fail(new DockerError(500, `building ${tag} failed: ${tail.slice(-3).join(" | ")}`))));
  });
}

/** Where the Docker socket is: $DOCKER_HOST, the current docker context, or the usual places. */
export function locateSocket(): string | null {
  const fromHost = process.env.DOCKER_HOST;
  if (fromHost?.startsWith("unix://")) return fromHost.slice("unix://".length);
  const ctx = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", timeout: 3000 });
  const host = ctx.status === 0 ? ctx.stdout.trim() : "";
  if (host.startsWith("unix://") && existsSync(host.slice(7))) return host.slice(7);
  for (const p of [join(homedir(), ".docker", "run", "docker.sock"), "/var/run/docker.sock"]) if (existsSync(p)) return p;
  return null;
}

/** Splits `name[:tag]` or `name@sha256:…` into what the pull API wants. */
export function splitRef(ref: string): { name: string; tag: string } {
  const at = ref.indexOf("@");
  if (at >= 0) return { name: ref.slice(0, at), tag: ref.slice(at + 1) };
  const colon = ref.lastIndexOf(":");
  return colon > ref.lastIndexOf("/") ? { name: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { name: ref, tag: "latest" };
}

export class DockerClient {
  constructor(readonly socketPath: string) {}

  private raw(method: string, path: string, body?: unknown): Promise<IncomingMessage> {
    return new Promise((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        // unversioned path: the daemon answers in its own API version
        { socketPath: this.socketPath, method, path, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} },
        ok,
      );
      req.on("error", fail);
      req.end(data);
    });
  }

  /** A JSON (or empty) response; throws DockerError on non-2xx. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if ((res.statusCode ?? 500) >= 300) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* not JSON */
      }
      throw new DockerError(res.statusCode ?? 500, message.trim() || `Docker answered ${res.statusCode}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.raw("GET", "/_ping");
      res.resume();
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  version(): Promise<{ Version: string; ApiVersion: string; Os: string; Arch: string }> {
    return this.call("GET", "/version");
  }

  info(): Promise<{ Runtimes?: Record<string, unknown>; NCPU: number; MemTotal: number; OperatingSystem: string }> {
    return this.call("GET", "/info");
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    try {
      return await this.call<ImageInfo>("GET", `/images/${encodeURIComponent(ref)}/json`);
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }

  listImages(): Promise<ImageInfo[]> {
    return this.call("GET", "/images/json");
  }

  /**
   * Downloads an image, reporting bytes received over all layers. Layer
   * totals appear as each layer starts, so `total` grows during the pull.
   */
  async pull(ref: string, onProgress: (received: number, total: number) => void = () => {}): Promise<void> {
    const { name, tag } = splitRef(ref);
    const res = await this.raw("POST", `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`);
    if ((res.statusCode ?? 500) >= 300) {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      throw new DockerError(res.statusCode ?? 500, (() => { try { return JSON.parse(text).message; } catch { return text; } })());
    }
    const layers = new Map<string, { current: number; total: number }>();
    let buf = "";
    for await (const chunk of res) {
      buf += (chunk as Buffer).toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as { id?: string; status?: string; error?: string; progressDetail?: { current?: number; total?: number } };
        if (ev.error) throw new DockerError(500, ev.error);
        if (!ev.id) continue;
        const layer = layers.get(ev.id) ?? { current: 0, total: 0 };
        if (ev.status === "Downloading" && ev.progressDetail?.total) {
          layer.current = ev.progressDetail.current ?? 0;
          layer.total = ev.progressDetail.total;
        } else if (ev.status === "Download complete" || ev.status === "Already exists" || ev.status === "Pull complete") {
          layer.current = layer.total;
        }
        layers.set(ev.id, layer);
        let received = 0;
        let total = 0;
        for (const l of layers.values()) (received += l.current), (total += l.total);
        onProgress(received, total);
      }
    }
  }

  async removeImage(ref: string): Promise<void> {
    await this.call("DELETE", `/images/${encodeURIComponent(ref)}`);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    return (await this.call<{ Id: string }>("POST", "/containers/create", spec)).Id;
  }

  async start(id: string): Promise<void> {
    await this.call("POST", `/containers/${id}/start`);
  }

  async wait(id: string): Promise<number> {
    return (await this.call<{ StatusCode: number }>("POST", `/containers/${id}/wait`)).StatusCode;
  }

  /** Stops a container, killing it after `seconds`. */
  async stop(id: string, seconds = 5): Promise<void> {
    try {
      await this.call("POST", `/containers/${id}/stop?t=${seconds}`);
    } catch (e) {
      if (!(e instanceof DockerError && (e.status === 304 || e.status === 404))) throw e;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/containers/${id}?force=1`);
    } catch (e) {
      if (!(e instanceof DockerError && e.status === 404)) throw e;
    }
  }

  /** Follows a container's stdout and stderr from the start, line by line, until it exits. */
  async followLogs(id: string, onLine: (stream: "stdout" | "stderr", line: string) => void): Promise<void> {
    const res = await this.raw("GET", `/containers/${id}/logs?follow=1&stdout=1&stderr=1`);
    if ((res.statusCode ?? 500) >= 300) throw new DockerError(res.statusCode ?? 500, "cannot read the container's output");
    const pending = { stdout: "", stderr: "" };
    const emit = (stream: "stdout" | "stderr", text: string, flush = false) => {
      pending[stream] += text;
      const parts = pending[stream].split(/\r?\n/);
      pending[stream] = flush ? "" : parts.pop()!;
      for (const line of parts) if (line || !flush) onLine(stream, line);
    };
    // without a TTY, Docker frames each chunk: [stream, 0, 0, 0, size (4 bytes, big-endian)]
    let buf = Buffer.alloc(0);
    for await (const chunk of res) {
      buf = Buffer.concat([buf, chunk as Buffer]);
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break;
        emit(buf[0] === 2 ? "stderr" : "stdout", buf.subarray(8, 8 + size).toString("utf8"));
        buf = buf.subarray(8 + size);
      }
    }
    emit("stdout", "", true);
    emit("stderr", "", true);
  }
}
