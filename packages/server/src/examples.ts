/**
 * Example data for the start screen, from `examples/examples.yaml` in each
 * library folder: what it is, its files, a suggested problem statement, and
 * optionally how to run it quickly (a book action with small parameters).
 */
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "yaml";
import { type Artifact, type Example, type Params, type Plan, bookAction } from "@pharos/contracts";
import type { Library } from "@pharos/books";
import type { Plans } from "./plans.js";
import type { WorkspaceStore } from "./workspaces.js";

/** Where prepared examples run; the shared cache makes their results instant everywhere. */
export const EXAMPLES_WORKSPACE = "examples";

interface ExampleSource extends Example {
  paths: { path: string; name: string }[];
  imagePath?: string;
}

/** The picture formats an example's card can show. */
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export class ExampleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Every example in the library folders whose files exist; earlier folders win on duplicate ids. */
export async function loadExamples(dirs: string[]): Promise<ExampleSource[]> {
  const out: ExampleSource[] = [];
  for (const dir of dirs) {
    const file = join(dir, "examples", "examples.yaml");
    const raw = await readFile(file, "utf8").catch(() => null);
    if (!raw) continue;
    const items = parse(raw) as unknown;
    if (!Array.isArray(items)) continue;
    for (const item of items as Record<string, unknown>[]) {
      if (typeof item?.id !== "string" || out.some((e) => e.id === item.id) || !Array.isArray(item.files)) continue;
      const paths = (item.files as { path?: unknown; name?: unknown }[]).flatMap((f) =>
        typeof f?.path === "string" ? [{ path: resolve(dirname(file), f.path), name: typeof f.name === "string" ? f.name : basename(f.path) }] : [],
      );
      const present = await Promise.all(paths.map((p) => stat(p.path).then(() => true, () => false)));
      if (!paths.length || present.includes(false)) continue;
      const image = typeof item.image === "string" ? resolve(dirname(file), item.image) : undefined;
      const imagePath = image && IMAGE_TYPES[extname(image).toLowerCase()] && (await stat(image).then((s) => s.isFile(), () => false)) ? image : undefined;
      out.push({
        id: item.id,
        title: String(item.title ?? item.id),
        kind: String(item.kind ?? ""),
        description: String(item.description ?? ""),
        prompt: String(item.prompt ?? ""),
        files: paths.map((p) => p.name),
        ...(imagePath ? { image: true } : {}),
        ...(run(item.run) ? { run: run(item.run)! } : {}),
        paths,
        ...(imagePath ? { imagePath } : {}),
      });
    }
  }
  return out;
}

function run(raw: unknown): Example["run"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.book !== "string") return undefined;
  return {
    book: r.book,
    ...(typeof r.action === "string" ? { action: r.action } : {}),
    ...(r.params && typeof r.params === "object" ? { params: r.params as Params } : {}),
  };
}

export const publicExample = ({ paths: _paths, imagePath: _image, ...e }: ExampleSource): Example => e;

/** An example's picture for its card, and its media type. */
export async function exampleImage(dirs: string[], id: string): Promise<{ data: Buffer; type: string }> {
  const example = (await loadExamples(dirs)).find((e) => e.id === id);
  if (!example) throw new ExampleError(404, `no example "${id}"`);
  if (!example.imagePath) throw new ExampleError(404, `example "${id}" has no picture`);
  return { data: await readFile(example.imagePath), type: IMAGE_TYPES[extname(example.imagePath).toLowerCase()] };
}

export async function loadExample(dirs: string[], id: string, workspaces: WorkspaceStore, workspace: string): Promise<Artifact[]> {
  const example = (await loadExamples(dirs)).find((e) => e.id === id);
  if (!example) throw new ExampleError(404, `no example "${id}"`);
  await workspaces.create(workspace);
  const artifacts: Artifact[] = [];
  for (const p of example.paths) artifacts.push(await workspaces.importPath(workspace, p.path, p.name));
  return artifacts;
}

/**
 * Loads an example into `workspace` and makes a plan from its `run`: its
 * files fill the action's inputs by kind, in order. The plan is proposed,
 * not started; the caller approves it.
 */
export async function examplePlan(dirs: string[], id: string, workspaces: WorkspaceStore, plans: Plans, library: Library, workspace = EXAMPLES_WORKSPACE): Promise<Plan> {
  const example = (await loadExamples(dirs)).find((e) => e.id === id);
  if (!example) throw new ExampleError(404, `no example "${id}"`);
  if (!example.run) throw new ExampleError(422, `example "${id}" doesn't say how to run it`);
  const book = library.book(example.run.book)?.manifest;
  const action = book && bookAction(book, example.run.action);
  if (!book || !action) throw new ExampleError(422, `example "${id}" runs ${example.run.book}${example.run.action ? ` › ${example.run.action}` : ""}, which isn't in the library`);
  const pool = await loadExample(dirs, id, workspaces, workspace);
  const inputs: Record<string, string> = {};
  for (const input of action.inputs ?? []) {
    const i = pool.findIndex((a) => a.kind === input.accepts.kind);
    if (i >= 0) inputs[input.name] = pool.splice(i, 1)[0].id;
  }
  return plans.fromBook(workspace, book.id, inputs, example.run.params ?? {}, book.version, action.name);
}
