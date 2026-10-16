/**
 * The installed library: every `ships/<dir>/ship.yaml` and
 * `books/<dir>/book.yaml` under one or more roots, validated and
 * type-checked on load.
 *
 * A ship's folder is named after its id, or `<id>@<version>` to keep
 * several versions side by side. Manifests that fail validation stay out of
 * the listings but are reported, with file and line, as issues.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import semver from "semver";
import {
  type BookManifest,
  type CatalogueEntry,
  type LibraryIssue,
  type ShipManifest,
  type TrustLevel,
  validateBook,
  validateShip,
} from "@pharos/contracts";
import { type ShipLookup, checkBook, checkShip } from "./check.js";
import { type AcceptedFormats, acceptedFormats, converters } from "./formats.js";
import { type ManifestProblem, error, hasErrors, warning } from "./problems.js";
import { shipGpu } from "./resolve.js";
import { readManifest } from "./yaml.js";

export interface LoadedShip {
  type: "ship";
  /** The id the manifest declares, even when it has errors. */
  id?: string;
  dir: string;
  file: string;
  manifest?: ShipManifest;
  problems: ManifestProblem[];
}

export interface LoadedBook {
  type: "book";
  /** The id the manifest declares, even when it has errors. */
  id?: string;
  dir: string;
  file: string;
  manifest?: BookManifest;
  /** The book's GUIDE.md: the assistant's instructions for it. */
  guide?: string;
  problems: ManifestProblem[];
  accepts?: AcceptedFormats[];
}

/** Headings every GUIDE.md should have, so the assistant knows when (not) to pick the book. */
export const GUIDE_SECTIONS = ["When to use", "When not to use", "Parameters", "Example"] as const;

/** Trust per `<type>:<id>@<version>`; the verifier records it. Everything else counts as imported. */
export type TrustLookup = (type: "ship" | "book", id: string, version: string) => TrustLevel | undefined;

export class Library implements ShipLookup {
  private constructor(
    readonly roots: string[],
    readonly ships: LoadedShip[],
    readonly books: LoadedBook[],
    private readonly trust: TrustLookup,
  ) {}

  /** Loads `ships/` and `books/` from each root; earlier roots win on duplicates. */
  static async load(roots: string[], trust: TrustLookup = () => undefined): Promise<Library> {
    const ships: LoadedShip[] = [];
    for (const root of roots) {
      for (const dir of await subdirs(join(root, "ships"))) {
        const file = join(dir, "ship.yaml");
        const parsed = await readManifest(file, validateShip).catch(() => null);
        if (!parsed) continue; // a folder without ship.yaml isn't a ship
        const loaded: LoadedShip = { type: "ship", id: parsed.id, dir, file, problems: parsed.problems };
        if (parsed.value) {
          const m = parsed.value;
          loaded.problems.push(...checkShip(m).map((p) => ({ ...p, file, line: parsed.lineOf(p.path) })));
          const folder = basename(dir);
          if (folder !== m.id && folder !== `${m.id}@${m.version}`) {
            loaded.problems.push({ ...error("/id", `folder "${folder}" should be named "${m.id}" or "${m.id}@${m.version}"`), file, line: parsed.lineOf("/id") });
          }
          const twin = ships.find((s) => s.manifest?.id === m.id && s.manifest.version === m.version);
          if (twin) loaded.problems.push({ ...warning("/version", `${m.id} ${m.version} is also in ${twin.dir}, which is used instead`), file });
          if (!hasErrors(loaded.problems) && !twin) loaded.manifest = m;
        }
        ships.push(loaded);
      }
    }

    const library = new Library(roots, ships, [], trust);
    const available = converters(library.shipManifests());
    for (const root of roots) {
      for (const dir of await subdirs(join(root, "books"))) {
        const file = join(dir, "book.yaml");
        const parsed = await readManifest(file, validateBook).catch(() => null);
        if (!parsed) continue;
        const loaded: LoadedBook = { type: "book", id: parsed.id, dir, file, problems: parsed.problems };
        loaded.guide = await readFile(join(dir, "GUIDE.md"), "utf8").catch(() => undefined);
        if (parsed.value) {
          const m = parsed.value;
          loaded.problems.push(...checkBook(m, library).map((p) => ({ ...p, file, line: parsed.lineOf(p.path) })));
          loaded.problems.push(...guideProblems(loaded.guide, join(dir, "GUIDE.md")));
          if (library.books.some((b) => b.manifest?.id === m.id && b.manifest.version === m.version)) {
            loaded.problems.push({ ...warning("/version", `${m.id} ${m.version} is already loaded from another folder, which is used instead`), file });
          } else if (!hasErrors(loaded.problems)) {
            loaded.manifest = m;
            loaded.accepts = acceptedFormats(m, library, available);
          }
        }
        library.books.push(loaded);
      }
    }
    return library;
  }

  shipManifests(): ShipManifest[] {
    return this.ships.flatMap((s) => (s.manifest ? [s.manifest] : []));
  }

  bookManifests(): BookManifest[] {
    return this.books.flatMap((b) => (b.manifest ? [b.manifest] : []));
  }

  /** Versions of a ship in the library, newest first. */
  versions(id: string): string[] {
    return this.shipManifests()
      .filter((s) => s.id === id)
      .map((s) => s.version)
      .sort(semver.rcompare);
  }

  /** The newest version of a ship that matches `range` (any version without one). */
  ship(id: string, range?: string): ShipManifest | undefined {
    const version = range ? semver.maxSatisfying(this.versions(id), range) : this.versions(id)[0];
    return version ? this.shipManifests().find((s) => s.id === id && s.version === version) : undefined;
  }

  /** The newest version of a book, or a specific one. */
  book(id: string, version?: string): LoadedBook | undefined {
    const matches = this.books.filter((b) => b.manifest?.id === id && (!version || b.manifest.version === version));
    return matches.sort((a, b) => semver.rcompare(a.manifest!.version, b.manifest!.version))[0];
  }

  /** Every manifest with problems, errors first, for the library panel and `pharos check`. */
  issues(): LibraryIssue[] {
    return [...this.ships, ...this.books]
      .filter((x) => x.problems.length)
      .map((x) => ({
        type: x.type,
        id: x.manifest?.id ?? x.id ?? basename(x.dir),
        dir: x.dir,
        problems: [...x.problems].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")),
      }))
      .sort((a, b) => Number(hasErrors(b.problems)) - Number(hasErrors(a.problems)) || a.id.localeCompare(b.id));
  }

  shipEntries(): CatalogueEntry[] {
    return this.shipManifests().map((m) => ({
      type: "ship",
      id: m.id,
      version: m.version,
      title: m.id,
      summary: m.summary ?? Object.values(m.operations)[0].summary,
      tags: m.tags ?? [],
      trust: this.trust("ship", m.id, m.version) ?? "imported",
      source: "hand-written",
      installed: true,
      gpu: shipGpu(m),
    }));
  }

  bookEntries(): CatalogueEntry[] {
    return this.bookManifests().map((m) => {
      const gpus = Object.entries(m.ships).map(([id, range]) => {
        const s = this.ship(id, range);
        return s ? shipGpu(s) : "none";
      });
      return {
        type: "book",
        id: m.id,
        version: m.version,
        title: m.title,
        summary: m.summary,
        tags: m.tags ?? [],
        trust: this.trust("book", m.id, m.version) ?? "imported",
        source: "hand-written",
        installed: true,
        gpu: gpus.includes("required") ? "required" : gpus.includes("optional") ? "optional" : "none",
      };
    });
  }
}

function guideProblems(guide: string | undefined, file: string): ManifestProblem[] {
  if (guide === undefined) return [{ ...warning("/", "GUIDE.md is missing, so the assistant has no instructions for this book"), file }];
  const headings = [...guide.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1].toLowerCase());
  return GUIDE_SECTIONS.filter((s) => !headings.some((h) => h.startsWith(s.toLowerCase()))).map((s) => ({
    ...warning("/", `GUIDE.md has no "${s}" section`),
    file,
  }));
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(dir, e.name))
    .sort();
}
