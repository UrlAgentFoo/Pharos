/**
 * Installs a book (with any ships it brings) into the data folder's
 * library, from a folder on this computer or a git repository. The source
 * is either one book (a folder with book.yaml) or a library (folders with
 * ships/ and books/), and everything is validated before anything is
 * copied in.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Library } from "@pharos/books";
import { OrchestrationError } from "./orchestration.js";

const GIT_URL = /^(https:\/\/|git@)[\w.@:/~-]+?(\.git)?\/?$/;

function clone(url: string, dest: string): Promise<void> {
  return new Promise((ok, fail) => {
    const git = spawn("git", ["clone", "--depth", "1", "--quiet", "--", url, dest], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let err = "";
    git.stderr.on("data", (d) => (err += d));
    git.on("error", () => fail(new OrchestrationError(500, "git isn't installed")));
    git.on("close", (code) => (code === 0 ? ok() : fail(new OrchestrationError(400, `couldn't clone ${url}: ${err.trim().split("\n").pop()}`))));
  });
}

/** Returns what was installed: `<type>:<id>@<version>` keys. */
export async function installFrom(source: string, dataDir: string, existing: Library): Promise<string[]> {
  let dir = source;
  let cleanup: string | undefined;
  if (GIT_URL.test(source)) {
    cleanup = await mkdtemp(join(tmpdir(), "pharos-install-"));
    dir = join(cleanup, "repo");
    await clone(source, dir);
  } else if (!isAbsolute(source) || !(await stat(source).catch(() => null))?.isDirectory()) {
    throw new OrchestrationError(400, "give a folder on this computer (absolute path) or a git URL (https:// or git@)");
  }
  try {
    // a single book folder: wrap it as a library so it loads the same way
    let root = dir;
    if (await stat(join(dir, "book.yaml")).catch(() => null)) {
      root = await mkdtemp(join(tmpdir(), "pharos-book-"));
      cleanup ??= root;
      await cp(dir, join(root, "books", basename(dir)), { recursive: true });
    }
    // load with the existing library behind it, so books can use ships already installed
    const incoming = await Library.load([root, ...existing.roots]);
    const fromSource = (d: string) => d.startsWith(root);
    const broken = incoming.issues().filter((i) => fromSource(i.dir) && i.problems.some((p) => p.severity === "error"));
    if (broken.length) {
      throw new OrchestrationError(422, broken.map((b) => `${b.type} ${b.id}: ${b.problems.filter((p) => p.severity === "error").map((p) => p.message).join("; ")}`).join(" · "));
    }
    const installed: string[] = [];
    for (const item of [...incoming.ships, ...incoming.books]) {
      if (!fromSource(item.dir) || !item.manifest) continue;
      const { id, version } = item.manifest;
      const already = item.type === "ship" ? existing.shipManifests().some((s) => s.id === id && s.version === version) : !!existing.book(id, version);
      if (already) continue;
      const folder = item.type === "ship" ? `${id}@${version}` : id;
      await cp(item.dir, join(dataDir, `${item.type}s`, folder), { recursive: true, errorOnExist: true, force: false });
      installed.push(`${item.type}:${id}@${version}`);
    }
    if (!installed.length) throw new OrchestrationError(409, "nothing new to install: everything there is already in the library");
    return installed;
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true });
  }
}
