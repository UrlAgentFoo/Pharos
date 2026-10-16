/**
 * Pharos project files (.pharos): a ZIP holding project.json and the source
 * image of every window as a TIFF. Histories are stored as steps, not
 * pixels, so a project re-runs each image's steps on load and keeps them
 * editable, exactly as they were.
 */
import { type Image, type Roi, readTiff, writeTiff } from "@pharos/core";
import type { NotesData } from "./notes.js";
import type { ResultsData } from "./results.js";
import type { Group } from "./workspace.js";
import { type ZipEntry, unzip, zip } from "./zip.js";

export const PROJECT_EXT = ".pharos";

export interface ProjectDoc {
  id: string;
  name: string;
  /** Path of the source TIFF inside the archive. */
  source: string;
  parent?: { id: string; name: string; step: number };
  file: { dir: string; name: string } | null;
  panels: { title: string; commands: string[] }[];
  ui: { controls: boolean; history: "full" | "slim" };
  group?: string;
  minimized: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
  view: {
    pos: { c: number; z: number; t: number };
    ranges: [number, number][];
    composite: boolean;
    hidden: boolean[];
    manualRange: boolean;
    fitted: boolean;
    zoom: number;
    centre: { x: number; y: number } | null;
  };
  timeline: {
    steps: { command: string; params: Record<string, unknown>; enabled: boolean; origin: "user" | "ai" }[];
    marker: number;
  };
  /** The selection on the image, if any. */
  roi?: Roi | null;
}

export interface ProjectFile {
  format: "pharos-project";
  version: 1;
  saved: string;
  notes: NotesData;
  groups: Pick<Group, "id" | "name" | "color" | "sync">[];
  docs: ProjectDoc[];
  /** Measurements (added after the first projects; may be missing). */
  results?: ResultsData;
}

/** Packs a project and its source images (keyed by the paths the docs refer to). */
export function packProject(project: ProjectFile, sources: Map<string, Image>): Uint8Array {
  const entries: ZipEntry[] = [{ name: "project.json", data: new TextEncoder().encode(JSON.stringify(project, null, 1)) }];
  for (const [path, img] of sources) entries.push({ name: path, data: writeTiff(img) });
  return zip(entries);
}

export async function unpackProject(bytes: Uint8Array): Promise<{ project: ProjectFile; images: Map<string, Image> }> {
  const files = unzip(bytes);
  const json = files.get("project.json");
  if (!json) throw new Error("This file is not an Pharos project (no project.json inside).");
  const project = JSON.parse(new TextDecoder().decode(json)) as ProjectFile;
  if (project.format !== "pharos-project") throw new Error("This file is not an Pharos project.");
  if (project.version > 1) throw new Error("This project was saved by a newer Pharos. Update Pharos to open it.");
  const images = new Map<string, Image>();
  for (const d of project.docs) {
    if (images.has(d.source)) continue;
    const data = files.get(d.source);
    if (!data) throw new Error(`The project is missing ${d.source}.`);
    images.set(d.source, await readTiff(data.slice().buffer, d.name));
  }
  return { project, images };
}

/** Builds a ZIP of TIFFs, one per image, as it currently looks. */
export function packTiffs(images: { name: string; image: Image }[]): Uint8Array {
  const used = new Set<string>();
  return zip(
    images.map(({ name, image }) => {
      let file = name.replace(/\.tiff?$/i, "") + ".tif";
      for (let i = 2; used.has(file); i++) file = `${name.replace(/\.tiff?$/i, "")}-${i}.tif`;
      used.add(file);
      return { name: file, data: writeTiff({ ...image, name }) };
    }),
  );
}
