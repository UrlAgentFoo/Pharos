/**
 * Autosave: keeps the current session in this browser (IndexedDB) so a
 * refresh or a closed tab does not lose work. It stores the same project
 * description a saved .pharos file holds; the data and results themselves
 * stay in the workspace on disk.
 *
 * It is a safety net, not a replacement for Save project: it lives in this
 * browser only, for this address.
 */
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

  private database() {
    this.db ??= openDb();
    return this.db;
  }

  async save(project: ProjectFile, meta: SessionMeta) {
    const db = await this.database();
    await request(db, "readwrite", (s) => s.put(JSON.stringify({ project, meta }), "project"));
    // images autosaved by the old image editor are no longer needed
    for (const k of await request(db, "readonly", (s) => s.getAllKeys())) {
      if (String(k).startsWith("img:")) await request(db, "readwrite", (s) => s.delete(k));
    }
  }

  /** The saved session, or null if there is none. Sessions from the image editor keep only their name. */
  async load(): Promise<{ project: ProjectFile; meta: SessionMeta } | null> {
    const db = await this.database();
    const raw = await request<string | undefined>(db, "readonly", (s) => s.get("project"));
    if (!raw) return null;
    const { project, meta } = JSON.parse(raw) as { project: ProjectFile | { version: 1; saved: string; notes?: { name?: string } }; meta: SessionMeta };
    if (project.version === 1) return { project: { format: "pharos-project", version: 2, saved: project.saved, name: project.notes?.name ?? "", docs: [] }, meta };
    return { project, meta };
  }
}
