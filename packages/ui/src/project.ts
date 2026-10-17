/**
 * Pharos project files (.pharos): a ZIP holding project.json, which has the
 * project's name and every data window: which workspace data it shows and
 * its history of processes. The data and results stay in the workspace on disk,
 * so a project is small and reopens with its results straight from there.
 */
import type { Artifact } from "@pharos/contracts";
import type { DataDoc } from "./workspace.js";
import { unzip, zip } from "./zip.js";

export const PROJECT_EXT = ".pharos";

export interface ProjectDoc {
  id: string;
  name: string;
  workspace: string;
  source: Artifact;
  steps: DataDoc["steps"];
  marker: number;
  output?: string;
  rationale?: string;
  ui: DataDoc["ui"];
  minimized: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
}

export interface ProjectFile {
  format: "pharos-project";
  /** 1 was the image editor's format: only its name is read now. */
  version: 2;
  saved: string;
  name: string;
  docs: ProjectDoc[];
}

export function packProject(project: ProjectFile): Uint8Array {
  return zip([{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(project, null, 1)) }]);
}

/** Reads a project file; `dropped` counts image windows from an older Pharos, which can't be opened any more. */
export function unpackProject(bytes: Uint8Array): { project: ProjectFile; dropped: number } {
  const json = unzip(bytes).get("project.json");
  if (!json) throw new Error("This file is not a Pharos project (no project.json inside).");
  const raw = JSON.parse(new TextDecoder().decode(json)) as { format?: string; version?: number; notes?: { name?: string }; docs?: unknown[]; saved?: string; name?: string };
  if (raw.format !== "pharos-project") throw new Error("This file is not a Pharos project.");
  if ((raw.version ?? 0) > 2) throw new Error("This project was saved by a newer Pharos. Update Pharos to open it.");
  if (raw.version === 1) {
    return { project: { format: "pharos-project", version: 2, saved: raw.saved ?? new Date().toISOString(), name: raw.notes?.name ?? "", docs: [] }, dropped: raw.docs?.length ?? 0 };
  }
  return { project: raw as ProjectFile, dropped: 0 };
}
