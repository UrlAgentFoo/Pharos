/**
 * Folders dropped on the page (a .zarr store, an OpenFOAM case): the browser
 * hands them over as directory entries, which are walked here for their
 * files, to upload as one tar stream (see tar.ts).
 */
import type { FolderFile } from "./tar.js";

/** The dropped items that are folders: read while the drop event lasts, walked after. */
export function droppedFolders(items: DataTransferItemList): FileSystemDirectoryEntry[] {
  return [...items].map((i) => i.webkitGetAsEntry?.() ?? null).filter((e): e is FileSystemDirectoryEntry => !!e?.isDirectory);
}

/** A folder's files, by their paths inside it; Finder's .DS_Store files are left out. */
export async function folderFiles(dir: FileSystemDirectoryEntry, base = ""): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  const reader = dir.createReader();
  // readEntries hands out a batch at a time, until an empty one
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.name === ".DS_Store") continue;
      if (e.isDirectory) out.push(...(await folderFiles(e as FileSystemDirectoryEntry, `${base}${e.name}/`)));
      else out.push({ path: `${base}${e.name}`, file: await new Promise<File>((ok, fail) => (e as FileSystemFileEntry).file(ok, fail)) });
    }
  }
  return out;
}
