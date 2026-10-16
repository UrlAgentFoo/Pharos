/**
 * The run cache: same image, operation, parameters and input content means
 * the outputs of an earlier run are reused, even from another book. Each
 * entry is a small file in the workspace's `cache/` folder pointing at the
 * output artifacts; the artifacts themselves stay in the workspace.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheKeyInput } from "@pharos/contracts";

export interface CacheEntry {
  key: string;
  /** Output name → artifact id. */
  outputs: Record<string, string>;
  /** Total size of the outputs, for the storage view and eviction. */
  bytes: number;
  runId: string;
  createdAt: string;
  lastUsed: string;
}

/** JSON with sorted keys, so equal values always hash the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(input: CacheKeyInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export class RunCache {
  constructor(
    private readonly dir: string,
    /** Least-recently-used entries are dropped once the outputs they point at exceed this. */
    readonly limitBytes = 50 * 1024 ** 3,
  ) {}

  private file(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid cache key ${key}`);
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), "utf8")) as CacheEntry;
      entry.lastUsed = new Date().toISOString();
      await writeFile(this.file(key), JSON.stringify(entry));
      return entry;
    } catch {
      return null;
    }
  }

  async put(entry: Omit<CacheEntry, "createdAt" | "lastUsed">): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(this.file(entry.key), JSON.stringify({ ...entry, createdAt: now, lastUsed: now }));
    await this.evict();
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async entries(): Promise<CacheEntry[]> {
    const names = await readdir(this.dir).catch(() => []);
    const out = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => readFile(join(this.dir, n), "utf8").then((t) => JSON.parse(t) as CacheEntry, () => null)),
    );
    return out.filter((e): e is CacheEntry => !!e);
  }

  async usage(): Promise<number> {
    return (await this.entries()).reduce((n, e) => n + e.bytes, 0);
  }

  /** Forgets every cached result; returns the bytes the entries pointed at. */
  async clear(): Promise<number> {
    const entries = await this.entries();
    await Promise.all(entries.map((e) => this.delete(e.key)));
    return entries.reduce((n, e) => n + e.bytes, 0);
  }

  private async evict() {
    const entries = (await this.entries()).sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    for (const e of entries) {
      if (total <= this.limitBytes) break;
      await this.delete(e.key);
      total -= e.bytes;
    }
  }
}
