/**
 * Autosave: keeps the current session in this browser (IndexedDB) so a
 * refresh or a closed tab does not lose work. It stores the same project
 * description a saved .pharos file holds, plus each source image once as a
 * TIFF; later saves only rewrite the small description.
 *
 * It is a safety net, not a replacement for Save project: it lives in this
 * browser only, for this address.
 */
import { type Image, readTiff, writeTiff } from "@pharos/core";
import type { ProjectFile } from "./project.js";

const DB_NAME = "pharos";
const STORE = "session";

export interface SessionMeta {
  /** When the project was last saved to a file (ISO), if ever. */
  lastSaved: string | null;
  /** Whether there were changes since that file save. */
  unsaved: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

export class Autosave {
  private db: Promise<IDBDatabase> | null = null;
  /** Storage key of each source image already written. */
  private keys = new WeakMap<Image, string>();
  private seq = 0;

  private database() {
    this.db ??= openDb();
    return this.db;
  }

  /** The name a source image is stored under (stable for the same image). */
  pathFor = (img: Image): string => {
    let key = this.keys.get(img);
    if (!key) {
      key = `img-${Date.now().toString(36)}-${++this.seq}`;
      this.keys.set(img, key);
    }
    return key;
  };

  /** Marks an image as already stored under `key` (after restoring a session). */
  adopt(img: Image, key: string) {
    this.keys.set(img, key);
  }

  async save(project: ProjectFile, sources: Map<string, Image>, meta: SessionMeta) {
    const db = await this.database();
    const stored = new Set((await request(db, "readonly", (s) => s.getAllKeys())).map(String));
    for (const [key, img] of sources) {
      if (!stored.has(`img:${key}`)) await request(db, "readwrite", (s) => s.put(writeTiff(img), `img:${key}`));
    }
    await request(db, "readwrite", (s) => s.put(JSON.stringify({ project, meta }), "project"));
    // forget images no longer in the session
    for (const k of stored) {
      if (k.startsWith("img:") && !sources.has(k.slice(4))) await request(db, "readwrite", (s) => s.delete(k));
    }
  }

  /** The saved session, or null if there is none. */
  async load(): Promise<{ project: ProjectFile; images: Map<string, Image>; meta: SessionMeta } | null> {
    const db = await this.database();
    const raw = await request<string | undefined>(db, "readonly", (s) => s.get("project"));
    if (!raw) return null;
    const { project, meta } = JSON.parse(raw) as { project: ProjectFile; meta: SessionMeta };
    const images = new Map<string, Image>();
    for (const d of project.docs) {
      if (images.has(d.source)) continue;
      const bytes = await request<Uint8Array | undefined>(db, "readonly", (s) => s.get(`img:${d.source}`));
      if (!bytes) throw new Error(`autosaved image ${d.source} is missing`);
      images.set(d.source, await readTiff(bytes.slice().buffer, d.name));
    }
    return { project, images, meta };
  }

  async clear() {
    const db = await this.database();
    await request(db, "readwrite", (s) => s.clear());
  }
}
