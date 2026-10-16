/**
 * The catalogue index: every ship and book manifest in a SQLite database
 * with full-text search over summaries, operations, accepted data, EDAM
 * terms and guides. Built from the library, so it is rebuilt (in
 * milliseconds for hundreds of manifests) whenever the library changes.
 *
 * The Pharos assistant, the build agents (through the MCP server) and
 * outside assistants all search through this one implementation.
 */
import { DatabaseSync } from "node:sqlite";
import semver from "semver";
import type { Library } from "@pharos/books";
import { ARTIFACT_KINDS, type CatalogueEntry, type CatalogueStats, FORMATS, type ShipManifest, type TrustLevel } from "@pharos/contracts";

export interface SearchOptions {
  text?: string;
  type?: "ship" | "book";
  trust?: TrustLevel;
  gpu?: CatalogueEntry["gpu"];
  tag?: string;
  limit?: number;
}

export interface Gaps {
  /** Formats nothing verified can read. */
  unreadFormats: string[];
  /** Kinds no verified operation produces. */
  unproducedKinds: string[];
  /** Kinds without a converter, so books on them only take the formats they read directly. */
  noConverter: string[];
}

const TRUST_ORDER = "CASE trust WHEN 'verified' THEN 0 WHEN 'verifying' THEN 1 ELSE 2 END";

/** Turns free text into an FTS5 query: each word as a prefix, any of them matching. */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null;
}

export class CatalogueIndex {
  readonly db: DatabaseSync;
  private ships: ShipManifest[] = [];

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE entries (key TEXT PRIMARY KEY, type TEXT, id TEXT, version TEXT, title TEXT, summary TEXT, tags TEXT,
        trust TEXT, source TEXT, gpu TEXT, installed INTEGER, entry TEXT, manifest TEXT, guide TEXT);
      CREATE VIRTUAL TABLE search USING fts5(key UNINDEXED, id, title, summary, tags, operations, data, guide, tokenize = 'porter unicode61');
    `);
  }

  /** Replaces the index's contents with the library's ships and books. */
  rebuild(library: Library) {
    this.db.exec("DELETE FROM entries; DELETE FROM search;");
    const insert = this.db.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const text = this.db.prepare("INSERT INTO search VALUES (?,?,?,?,?,?,?,?)");
    this.ships = library.shipManifests();
    const add = (e: CatalogueEntry, manifest: unknown, operations: string, data: string, guide: string) => {
      const key = `${e.type}:${e.id}@${e.version}`;
      insert.run(key, e.type, e.id, e.version, e.title, e.summary, e.tags.join(" "), e.trust, e.source, e.gpu, e.installed ? 1 : 0, JSON.stringify(e), JSON.stringify(manifest), guide);
      text.run(key, e.id.replace(/-/g, " "), e.title, e.summary, e.tags.join(" "), operations, data, guide);
    };
    for (const e of library.shipEntries()) {
      const m = this.ships.find((s) => s.id === e.id && s.version === e.version)!;
      const ops = Object.entries(m.operations).map(([n, o]) => `${n} ${o.summary} ${o.edam ?? ""}`).join(" ");
      const data = Object.values(m.operations)
        .flatMap((o) => [...(o.inputs ?? []).flatMap((i) => [i.kind, ...i.formats]), ...o.outputs.flatMap((x) => [x.kind, x.format])])
        .join(" ");
      add(e, m, ops, data, "");
    }
    for (const e of library.bookEntries()) {
      const b = library.book(e.id, e.version)!;
      const m = b.manifest!;
      const data = (m.inputs ?? []).flatMap((i) => [i.accepts.kind, i.accepts.axes ?? "", i.accepts.edam ?? "", ...(b.accepts?.find((a) => a.input === i.name)?.direct ?? [])]).join(" ");
      add(e, m, m.steps.map((s) => s.run.replace(".", " ")).join(" "), data, b.guide ?? "");
    }
  }

  search(o: SearchOptions = {}): CatalogueEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const q = o.text ? ftsQuery(o.text) : null;
    if (q) {
      where.push("e.key IN (SELECT key FROM search WHERE search MATCH ?)");
      args.push(q);
    }
    for (const [col, v] of [["type", o.type], ["trust", o.trust], ["gpu", o.gpu]] as const) {
      if (v) {
        where.push(`e.${col} = ?`);
        args.push(v);
      }
    }
    if (o.tag) {
      where.push("(' ' || e.tags || ' ') LIKE ?");
      args.push(`% ${o.tag} %`);
    }
    // rank: trust first, then text relevance (bm25: lower is better)
    const rank = q ? `, (SELECT bm25(search) FROM search WHERE search MATCH ? AND search.key = e.key)` : ", 0";
    const sql = `SELECT e.entry ${rank} AS relevance FROM entries e ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${TRUST_ORDER}, relevance, e.title LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(q ? [q, ...args] : args), o.limit ?? 20) as { entry: string }[];
    return rows.map((r) => JSON.parse(r.entry) as CatalogueEntry);
  }

  manifest(type: "ship" | "book", id: string, version?: string): { entry: CatalogueEntry; manifest: unknown; guide?: string } | null {
    const rows = this.db.prepare("SELECT version, entry, manifest, guide FROM entries WHERE type = ? AND id = ?").all(type, id) as { version: string; entry: string; manifest: string; guide: string }[];
    const row = version ? rows.find((r) => r.version === version) : rows.sort((a, b) => semver.rcompare(a.version, b.version))[0];
    return row ? { entry: JSON.parse(row.entry), manifest: JSON.parse(row.manifest), ...(row.guide ? { guide: row.guide } : {}) } : null;
  }

  stats(): CatalogueStats {
    const zero = () => ({ verified: 0, verifying: 0, imported: 0 });
    const out: CatalogueStats = { ships: zero(), books: zero(), byDomain: {} };
    for (const r of this.db.prepare("SELECT type, trust, tags FROM entries").all() as { type: "ship" | "book"; trust: TrustLevel; tags: string }[]) {
      out[r.type === "ship" ? "ships" : "books"][r.trust]++;
      for (const t of r.tags.split(" ").filter(Boolean)) out.byDomain[t] = (out.byDomain[t] ?? 0) + 1;
    }
    return out;
  }

  /** What the verified ships can't do yet, to steer importers. */
  gaps(): Gaps {
    const verified = new Set((this.db.prepare("SELECT id, version FROM entries WHERE type = 'ship' AND trust = 'verified'").all() as { id: string; version: string }[]).map((r) => `${r.id}@${r.version}`));
    const ops = this.ships.filter((s) => verified.has(`${s.id}@${s.version}`)).flatMap((s) => Object.entries(s.operations));
    const read = new Set(ops.flatMap(([, o]) => (o.inputs ?? []).flatMap((i) => i.formats)));
    const produced = new Set(ops.flatMap(([, o]) => o.outputs.map((x) => x.kind)));
    const converted = new Set(ops.filter(([n, o]) => n === "convert" && o.inputs?.length === 1 && o.outputs.length === 1 && o.inputs[0].kind === o.outputs[0].kind).map(([, o]) => o.outputs[0].kind));
    return {
      unreadFormats: FORMATS.filter((f) => !read.has(f)),
      unproducedKinds: ARTIFACT_KINDS.filter((k) => !produced.has(k)),
      noConverter: ARTIFACT_KINDS.filter((k) => !converted.has(k)),
    };
  }

  close() {
    this.db.close();
  }
}
