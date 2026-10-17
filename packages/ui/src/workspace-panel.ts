/**
 * The workspace panel: pick or create a workspace on disk, see its
 * artifacts, add data to it, and open an artifact in its viewer.
 *
 * Workspaces live on the local server (`<data>/workspaces/<name>`), so the
 * panel needs it; the chosen workspace is remembered per browser.
 */
import { type Artifact, type FormatInfo, sniffFormat } from "@pharos/contracts";
import { kindIcon } from "./data-window.js";
import type { DirEntry, LocalServer } from "./api.js";
import { browseDialog, escapeHtml, formatSize, promptDialog, showDialog } from "./dialogs.js";
import { diskUsage, diskUsageText, homePath } from "./format.js";
import { icon } from "./icons.js";
import { kindLabel } from "./viewers.js";

const CURRENT_KEY = "pharos.workspace";
const DEFAULT_WORKSPACE = "default";

/** Every format the server recognises (built in, plus those ships declare), once it has said. */
let formats: Record<string, FormatInfo> | undefined;
export function setFormats(f: Record<string, FormatInfo>) {
  formats = f;
}

/** A format as people know it ("OME-Zarr"), once the server has said; its id until then. */
export const formatTitle = (format: string) => formats?.[format]?.title ?? format;

/** Names the server knows how to store; folders without a telling name can still be chosen whole. */
export const isSupported = (e: Pick<DirEntry, "name" | "isDir">) => !!sniffFormat(e.name, e.isDir, [], formats);

export function currentWorkspace(): string {
  try {
    return localStorage.getItem(CURRENT_KEY) || DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

function setCurrent(name: string) {
  try {
    localStorage.setItem(CURRENT_KEY, name);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/** What the panel closed for; `refresh` reopens it (another workspace chosen, files dropped). */
type PanelResult =
  | { open: Artifact }
  | { run: Artifact }
  | { find: Artifact[] }
  | { ask: Artifact[] }
  | { add: "path" | "upload" }
  | { create: true }
  | { refresh: true }
  | null;

/** Shows the panel until the user closes it, handling adds and opens in between. */
export async function workspacePanel(
  server: LocalServer,
  opts: {
    open: (a: Artifact, workspace: string) => Promise<void>;
    run: (a: Artifact, workspace: string) => Promise<void>;
    /** Shows the books that accept the chosen data. */
    find: (data: Artifact[], workspace: string) => Promise<void>;
    /** Asks the assistant to plan for the chosen data. */
    ask: (data: Artifact[], workspace: string) => Promise<void>;
    notify: (text: string) => void;
  },
) {
  let name = currentWorkspace();
  await server.createWorkspace(name);
  for (;;) {
    const [all, artifacts] = await Promise.all([server.workspaces(), server.artifacts(name)]);
    const where = homePath(all.find((w) => w.name === name)?.path ?? "", server.info.home);
    const result = await showPanel(name, all.map((w) => w.name), where, artifacts, (next) => {
      name = next;
      setCurrent(name);
    }, server, opts.notify);
    if (!result) return;
    if ("refresh" in result) continue;
    if ("open" in result) return opts.open(result.open, name);
    if ("run" in result) return opts.run(result.run, name);
    if ("find" in result) return opts.find(result.find, name);
    if ("ask" in result) return opts.ask(result.ask, name);
    if ("create" in result) {
      const next = await promptDialog("New workspace", "Name", "");
      if (next) {
        try {
          name = (await server.createWorkspace(next)).name;
          setCurrent(name);
        } catch (e) {
          opts.notify(e instanceof Error ? e.message : String(e));
        }
      }
      continue;
    }
    let added: Artifact[] = [];
    try {
      added = result.add === "path" ? await addByPath(server, name) : await addByUpload(server, name);
    } catch (e) {
      opts.notify(e instanceof Error ? e.message : String(e));
    }
    if (added.length) opts.notify(`Added ${added.length === 1 ? (added[0].name ?? "1 item") : `${added.length} items`} to ${name}`);
  }
}

function showPanel(
  name: string,
  names: string[],
  where: string,
  artifacts: Artifact[],
  choose: (n: string) => void,
  server: LocalServer,
  notify: (text: string) => void,
): Promise<PanelResult> {
  const options = names.map((n) => `<option ${n === name ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
  const rows = artifacts.length
    ? artifacts
        .map(
          (a, i) => `<li class="ws-row"><input type="checkbox" data-pick="${i}" aria-label="Choose ${escapeHtml(a.name ?? "data")}"/><button class="file" data-i="${i}" title="Open in its own window">
            <span>${icon(kindIcon(a.kind), 16)} ${escapeHtml(a.name ?? a.id.slice(0, 12))}</span>
            <small>${a.producedBy ? "result · " : ""}${escapeHtml(kindLabel(a))} · ${escapeHtml(a.format)} · ${formatSize(a.sizeBytes ?? 0)}</small></button></li>`,
        )
        .join("")
    : `<li class="none">No data yet. Add files from this computer, or drop them here.</li>`;
  return showDialog<PanelResult>(
    `<p class="eyebrow">Workspace</p>
     <div class="ws-head"><select data-ws aria-label="Workspace">${options}</select><button class="chip" data-new>${icon("plus", 14)} New</button></div>
     <div class="browser ws-drop"><ul class="entries">${rows}</ul></div>
     <div class="ws-pick"><span class="muted small" data-picked>Tick data to find books for it, or to ask the assistant.</span>
       <button class="chip" data-find disabled>${icon("search", 13)} Find books</button>
       <button class="chip" data-ask disabled>${icon("sparkle", 13)} Ask the assistant…</button></div>
     <p class="ws-usage small">${escapeHtml(diskUsageText(diskUsage(artifacts)))}</p>
     <p class="muted small">Stored on this computer${where ? ` in <span class="ws-where">${escapeHtml(where)}</span>` : ""}. Data you add is copied in, so the original files are never changed.</p>
     <footer><button data-path>${icon("open", 15)} Add from this computer…</button><button data-upload>${icon("upload", 15)} Upload…</button><button class="primary" data-cancel>Close</button></footer>`,
    (done, el) => {
      el.querySelector<HTMLSelectElement>("[data-ws]")!.addEventListener("change", (e) => {
        choose((e.target as HTMLSelectElement).value);
        done({ refresh: true });
      });
      el.querySelector("[data-new]")!.addEventListener("click", () => done({ create: true }));
      el.querySelector("[data-path]")!.addEventListener("click", () => done({ add: "path" }));
      el.querySelector("[data-upload]")!.addEventListener("click", () => done({ add: "upload" }));
      el.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((b) => b.addEventListener("click", () => done({ open: artifacts[Number(b.dataset.i)] })));
      const picked = () => [...el.querySelectorAll<HTMLInputElement>("[data-pick]:checked")].map((c) => artifacts[Number(c.dataset.pick)]);
      el.querySelectorAll<HTMLInputElement>("[data-pick]").forEach((c) =>
        c.addEventListener("change", () => {
          const n = picked().length;
          el.querySelector<HTMLButtonElement>("[data-find]")!.disabled = !n;
          el.querySelector<HTMLButtonElement>("[data-ask]")!.disabled = !n;
          el.querySelector("[data-picked]")!.textContent = n ? `${n} chosen` : "Tick data to find books for it, or to ask the assistant.";
        }),
      );
      el.querySelector("[data-find]")!.addEventListener("click", () => done({ find: picked() }));
      el.querySelector("[data-ask]")!.addEventListener("click", () => done({ ask: picked() }));
      const drop = el.querySelector<HTMLElement>(".ws-drop")!;
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.classList.add("over");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation(); // the desktop would open the files as windows
        drop.classList.remove("over");
        const files = [...(e.dataTransfer?.files ?? [])];
        try {
          await uploadAll(server, name, files);
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err));
        }
        done({ refresh: true });
      });
    },
    null,
  );
}

async function addByPath(server: LocalServer, name: string): Promise<Artifact[]> {
  const path = await browseDialog(server, { title: `Add to ${name}`, pickFolder: false, allowFolder: true, accept: isSupported, empty: "No supported files here; open a folder, or use this folder if it is the data" });
  return path ? [await server.importPath(name, path)] : [];
}

function addByUpload(server: LocalServer, name: string): Promise<Artifact[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve(uploadAll(server, name, [...(input.files ?? [])]));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

async function uploadAll(server: LocalServer, name: string, files: File[]): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const f of files) out.push(await server.upload(name, f));
  return out;
}
