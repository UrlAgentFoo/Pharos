/**
 * Example data for the start screen, from `examples/examples.yaml` in each
 * library folder: what it is, its files, and a suggested problem statement.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { Artifact, Example } from "@pharos/contracts";
import type { WorkspaceStore } from "./workspaces.js";

interface ExampleSource extends Example {
  paths: { path: string; name: string }[];
}

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
      out.push({
        id: item.id,
        title: String(item.title ?? item.id),
        kind: String(item.kind ?? ""),
        description: String(item.description ?? ""),
        prompt: String(item.prompt ?? ""),
        files: paths.map((p) => p.name),
        paths,
      });
    }
  }
  return out;
}

export const publicExample = ({ paths: _paths, ...e }: ExampleSource): Example => e;

export async function loadExample(dirs: string[], id: string, workspaces: WorkspaceStore, workspace: string): Promise<Artifact[]> {
  const example = (await loadExamples(dirs)).find((e) => e.id === id);
  if (!example) throw new ExampleError(404, `no example "${id}"`);
  await workspaces.create(workspace);
  const artifacts: Artifact[] = [];
  for (const p of example.paths) artifacts.push(await workspaces.importPath(workspace, p.path, p.name));
  return artifacts;
}
