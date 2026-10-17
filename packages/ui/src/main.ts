import "./style.css";
import type { Artifact, CatalogueEntry, ChatTurn, Example, ServerEvent, SystemStatus, WindowRef } from "@pharos/contracts";
import { type AiConfig, LocalServer } from "./api.js";
import { type AskReply, Assistant, type CiteTarget, type SearchHit, UNTITLED } from "./chat.js";
import { DataProcesses } from "./data-processes.js";
import { alertDialog, browseDialog, confirmDialog, escapeHtml, isDialogOpen, promptDialog, showDialog } from "./dialogs.js";
import { exampleCards, showPictures, wireExampleGallery } from "./examples.js";
import { diskUsage, formatSize, homePath } from "./format.js";
import { icon } from "./icons.js";
import { formatShortcut, isMac, matchesShortcut } from "./keys.js";
import { libraryPanel } from "./library-panel.js";
import { barHtml, clockHtml, progressHtml, startClock } from "./progress.js";
import { type Action, Overview, score } from "./overview.js";
import { PROJECT_EXT, type ProjectDoc, type ProjectFile, packProject, unpackProject } from "./project.js";
import { Autosave } from "./session.js";
import { statusChip, storageDialog } from "./storage.js";
import { WindowManager } from "./windows.js";
import { type DataDoc, Workspace, blockAt, timeBlocks, underWay } from "./workspace.js";
import { kindLabel } from "./viewers.js";
import { SuggestedControls } from "./suggested-controls.js";
import { localDay, tokenUsageHtml } from "./token-usage.js";
import { WindowSummary } from "./window-summary.js";
import { currentWorkspace, formatTitle, isSupported, setFormats, workspacePanel } from "./workspace-panel.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------ theme (light by default; dark is opt-in, remembered per browser)

const THEME_KEY = "pharos.theme";
function storedTheme(): "light" | "dark" {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* not remembered: fine */
  }
}
applyTheme(storedTheme()); // before anything renders

let server: LocalServer | null = null;
let aiConfig: AiConfig | null = null;
let lastDir: string | undefined;
/** The folder you last saved into; saves start in Downloads until then. */
let lastSaveDir: string | undefined;

const ws = new Workspace();

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Shows a short message at the bottom of the window. */
function notify(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("out");
    toastTimer = setTimeout(() => (el.hidden = true), 300);
  }, 2600);
}

/** Runs a possibly slow change with a busy indicator; errors become a dialog. */
async function run<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const el = $("busy");
  el.innerHTML = `<span class="pg-head"><span>${escapeHtml(label)}…</span>${clockHtml(Date.now())}</span>${barHtml()}`;
  const timer = setTimeout(() => (el.hidden = false), 150); // only show it for slow work
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    void alertDialog("Something went wrong", e instanceof Error ? e.message : String(e));
    return undefined;
  } finally {
    clearTimeout(timer);
    el.hidden = true;
  }
}

const NO_SERVER = "Pharos runs its tools on this computer through its local server. Start it with `npx pharos-lab` and open the address it prints.";

// ------------------------------------------------------------ actions (toolbar, menus, search, shortcuts)

interface AppAction extends Action {
  /** Menu path; the first entry is the top-level menu. */
  menu: string[];
}

const hasServer = () => !!server;
const hasWindow = () => !!ws.active;
/** Windows that are not minimised. */
const visibleDocs = () => ws.docs.filter((d) => !windows.isMinimized(d.id));

function act(a: Omit<AppAction, "section">): AppAction {
  return { ...a, section: a.menu.join(" › ") };
}

const ACTIONS: AppAction[] = [
  act({ id: "add-data", title: "Add data…", menu: ["File"], icon: "add", keywords: ["import", "open", "files", "folder", "upload", "dataset", "tiff", "openfoam", "microscopy"], description: "Add files or a folder to the workspace; each opens in its own window", enabled: hasServer, run: () => addData() }),
  act({ id: "examples", title: "Example data…", menu: ["File"], icon: "flask", keywords: ["demo", "sample", "example", "openfoam", "microscopy", "try"], description: "Synthetic microscopy and simulation data to try", enabled: hasServer, run: () => examplesDialog() }),
  act({ id: "workspace", title: "Workspace…", menu: ["File"], icon: "panel", keywords: ["data", "artifacts", "project", "folder", "library", "import", "add"], description: "Your data on disk: add files and open them", enabled: hasServer, run: () => openWorkspace() }),
  act({ id: "library", title: "Books…", menu: ["File"], icon: "book", keywords: ["books", "recipes", "pipelines", "install", "catalogue"], description: "Recipes that run ships on your data", enabled: hasServer, run: () => openLibrary() }),
  act({ id: "storage", title: "Ships…", menu: ["View"], icon: "ship", keywords: ["docker", "gpu", "disk", "download", "remove", "cache", "status", "test", "storage", "containers", "tools"], description: "The tools books and windows run: what's here, Docker, GPU, disk and the cache", enabled: hasServer, run: () => openStorage() }),
  act({ id: "save-project", title: "Save project…", menu: ["File"], icon: "save", shortcut: "Mod+S", keywords: ["project", "pharos", "zip", "session"], description: "The windows and their histories as one .pharos file; the data stays in the workspace", enabled: () => true, run: () => saveProject() }),
  act({ id: "open-project", title: "Open project…", menu: ["File"], icon: "open", shortcut: "Mod+O", keywords: ["project", "pharos", "zip", "session", "load"], enabled: () => true, run: () => pickProject() }),
  act({ id: "clear-project", title: "New project (clear)", menu: ["File"], icon: "new", keywords: ["clear", "reset", "new", "empty", "start over"], description: "Closes every window and clears the conversation; your data on disk is kept", enabled: () => true, run: () => clearProject() }),
  act({ id: "overview", title: "Overview", menu: ["View"], icon: "overview", shortcut: "Tab", keywords: ["all windows", "mission control", "switch", "minimised"], enabled: () => true, run: () => overview.open() }),
  act({ id: "assistant", title: "Ask the assistant", menu: ["View"], icon: "sparkle", shortcut: "Mod+J", keywords: ["ai", "chat", "help", "ask", "suggest", "plan"], enabled: () => true, run: () => assistant.focus() }),
  act({ id: "settings", title: "Assistant and API key…", menu: ["View"], icon: "sparkle", keywords: ["settings", "preferences", "api key", "assistant", "ai", "model"], enabled: () => true, run: () => settingsDialog() }),
  act({ id: "dark-mode", title: "Toggle dark mode", menu: ["View"], icon: "contrast", keywords: ["theme", "night", "light", "appearance"], enabled: () => true, run: () => setDark(document.documentElement.dataset.theme !== "dark") }),
  act({ id: "controls", title: "Show or hide the side panel", menu: ["Window"], icon: "panel", shortcut: "\\", keywords: ["inspector", "panel", "drawer", "settings"], enabled: hasWindow, run: () => ws.active && windows.toggleControls(ws.active.id) }),
  act({ id: "fork", title: "Fork from this point", menu: ["Window"], icon: "branch", keywords: ["branch", "copy", "duplicate", "history", "try", "compare"], description: "A new window with the history up to the step on view", enabled: hasWindow, run: () => ws.active && processes.fork(ws.active) }),
  act({ id: "minimize", title: "Minimise window", menu: ["Window"], icon: "collapse", shortcut: "Mod+Shift+M", keywords: ["hide", "window"], enabled: hasWindow, run: () => ws.active && windows.minimize(ws.active.id) }),
  act({ id: "close", title: "Close window", menu: ["Window"], icon: "close", keywords: ["window"], enabled: hasWindow, run: () => ws.active && closeDoc(ws.active) }),
  act({ id: "layout-stack", title: "Stack windows", menu: ["Layout"], icon: "duplicate", keywords: ["cascade", "arrange", "cards"], enabled: hasWindow, run: () => windows.arrange("stack") }),
  act({ id: "layout-columns", title: "Side by side", menu: ["Layout"], icon: "layout", keywords: ["split", "compare", "arrange", "columns"], enabled: () => visibleDocs().length > 1, run: () => windows.arrange("columns") }),
  act({ id: "layout-grid", title: "Grid", menu: ["Layout"], icon: "overview", keywords: ["split", "tile", "arrange"], enabled: () => visibleDocs().length > 1, run: () => windows.arrange("grid") }),
  act({ id: "layout-focus", title: "Focus on this window", menu: ["Layout"], icon: "expand", keywords: ["maximise", "full", "arrange"], enabled: hasWindow, run: () => windows.arrange("focus") }),
];
const actionById = new Map(ACTIONS.map((a) => [a.id, a]));

async function runAction(id: string, from?: HTMLElement) {
  await ready;
  if (id === "palette") return assistant.focus();
  const anchor = from?.getBoundingClientRect();
  if (id === "add-menu" && anchor) return togglePopover(id, anchor, () => listHtml(["add-data", "examples", "workspace"]));
  if (id === "layout-menu" && anchor) return togglePopover(id, anchor, () => listHtml(["layout-stack", "layout-columns", "layout-grid", "layout-focus"]));
  if (id === "settings-menu" && anchor) return togglePopover(id, anchor, settingsHtml);
  if (id === "activity" && anchor) return togglePopover(id, anchor, activityHtml, true);
  const a = actionById.get(id);
  if (a?.enabled()) await a.run();
}

/** What the input's search finds for `q`: actions, then windows. */
function searchHits(q: string): SearchHit[] {
  const actions = ACTIONS.map((a) => ({ a, s: score(q, a.title, `${a.section} ${(a.keywords ?? []).join(" ")} ${a.description ?? ""}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.a.enabled()) - Number(a.a.enabled()))
    .map(({ a }): SearchHit => ({ icon: a.icon, title: a.title, subtitle: a.description ?? a.section, shortcut: a.shortcut, enabled: a.enabled(), run: () => void runAction(a.id) }));
  const wins = ws.docs
    .filter((d) => score(q, d.name, "") > 0)
    .map((d): SearchHit => ({ icon: "panel", title: d.name, subtitle: `Window · ${d.source.kind} · ${d.steps.length} steps`, enabled: true, run: () => (windows.isMinimized(d.id) ? windows.restore(d.id) : ws.activate(d.id)) }));
  return [...actions.slice(0, 5), ...wins.slice(0, 3)];
}

/**
 * The top bar holds only what is app-wide: the workspace, the library of
 * books and ships, adding data and arranging windows. Tools live on each
 * window, in its ⋯ menu, for the data that window shows.
 */
function buildToolbar() {
  const text = (id: string, ic: string, label: string, opts: { shortcut?: string; menu?: boolean; cls?: string } = {}) =>
    `<button class="tb-text${opts.cls ? ` ${opts.cls}` : ""}" data-action="${id}" title="${escapeHtml(label)}${opts.shortcut ? ` (${formatShortcut(opts.shortcut)})` : ""}"${opts.menu ? ' aria-haspopup="menu"' : ""}>${icon(ic, 16)}<span>${escapeHtml(label)}</span>${opts.menu ? '<span class="caret">▾</span>' : ""}</button>`;
  $("toolbar").innerHTML = `
    <div class="tb-left"><span class="brand"><span class="brand-mark" aria-hidden="true"></span><span>PHAROS</span></span></div>
    <nav class="tb-center" aria-label="Workspace">
      ${text("workspace", "panel", "Workspace")}
      ${text("library", "book", "Books")}
      ${text("storage", "ship", "Ships", { cls: "sys-status" })}
      ${text("add-menu", "add", "Add data", { menu: true })}
      ${text("layout-menu", "layout", "Layout", { menu: true })}
      ${text("overview", "overview", "Overview", { shortcut: "Tab" })}
    </nav>
    <div class="tb-right">
      <button class="tb-text activity" data-action="activity" aria-haspopup="menu" title="What's running" hidden><span class="pg-spin" aria-hidden="true"></span><span class="activity-text"></span></button>
      ${text("settings-menu", "settings", "Settings", { menu: true })}
    </div>`;
}

/** The settings dropdown: appearance and the assistant. */
function settingsHtml() {
  const dark = document.documentElement.dataset.theme === "dark";
  return `<section>
      <label class="toggle-row">${icon("contrast", 16)}<span>Dark mode</span><input type="checkbox" data-theme-toggle ${dark ? "checked" : ""}/><span class="switch" aria-hidden="true"></span></label>
    </section>
    <section>${itemHtml("settings")}${itemHtml("library")}${itemHtml("storage")}</section>
    <p class="pop-note">${server ? `Connected to the local Pharos ${escapeHtml(server.info.version)} server` : "Not connected to the local server"}</p>`;
}

// ------------------------------------------------------------ popovers: top-bar menus and each window's ⋯ menu

const pop = document.createElement("div");
pop.className = "menu-pop";
pop.hidden = true;
pop.setAttribute("role", "menu");
document.body.append(pop);
let popKey = "";

function itemHtml(id: string) {
  const a = actionById.get(id);
  if (!a) return "";
  return `<button data-action="${a.id}" role="menuitem">${icon(a.icon, 16)}<span>${escapeHtml(a.title)}</span>${a.shortcut ? `<kbd>${formatShortcut(a.shortcut)}</kbd>` : ""}</button>`;
}

function listHtml(ids: string[]) {
  return `<section>${ids.map(itemHtml).join("")}</section>`;
}

/** Opens a popover under `anchor`, or closes it if the same one is already open. */
function togglePopover(key: string, anchor: DOMRect, html: () => string, wide = false) {
  if (!pop.hidden && popKey === key) return closePopover();
  popKey = key;
  pop.innerHTML = html();
  pop.classList.toggle("wide", wide);
  pop.hidden = false;
  updateEnabled();
  const r = pop.getBoundingClientRect();
  // under the anchor, or above it when there's no room below (a window's history bar), kept on screen
  pop.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, anchor.left))}px`;
  const below = anchor.bottom + 6 + r.height <= innerHeight - 8;
  pop.style.top = `${below ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - r.height)}px`;
}

function closePopover() {
  pop.hidden = true;
  popKey = "";
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (!pop.hidden && !pop.contains(t) && !t.closest('[aria-haspopup="menu"], [data-win="menu"]')) closePopover();
});

pop.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if ("themeToggle" in input.dataset) setDark(input.checked);
});

pop.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-activity-win]");
  if (row) {
    closePopover();
    const id = row.dataset.activityWin!;
    return windows.isMinimized(id) ? windows.restore(id) : ws.activate(id);
  }
  const dp = (e.target as HTMLElement).closest<HTMLElement>("[data-dp]");
  if (!dp) return;
  closePopover();
  void processes.menuClick(dp.dataset.dp!);
});

function setDark(dark: boolean) {
  applyTheme(dark ? "dark" : "light");
}

function updateEnabled() {
  document.querySelectorAll<HTMLButtonElement>(".topbar [data-action], .menu-pop [data-action], .project-bar [data-action]").forEach((b) => {
    const a = actionById.get(b.dataset.action!);
    b.disabled = !!a && !a.enabled();
  });
}

// ------------------------------------------------------------ the desktop around the windows

/** Where the assistant column ends, or 0 while it's hidden (narrow screens, or no window on screen). */
function columnRight(): number {
  const column = $("assistant");
  return getComputedStyle(column).display !== "none" ? column.getBoundingClientRect().right : 0;
}

/** Space taken by the toolbar, the assistant column and the bottom bar, which windows avoid. */
function insets() {
  const tb = $("toolbar").getBoundingClientRect();
  // windows open beside the assistant column when it is shown (wide screens)
  const left = columnRight() ? columnRight() + 32 : 0;
  return { top: Math.max(16, tb.bottom + 14), left: Math.max(24, left), right: 24, bottom: 76 };
}

let lastSaved: Date | null = null;
/** A fingerprint of what a project file holds, to tell whether there are unsaved changes. */
let savedPrint: string | null = null;

function statePrint(): string {
  return JSON.stringify([assistant.projectName, ws.docs.map((d) => [d.source.id, d.marker, d.steps.map((s) => `${s.run}${JSON.stringify(s.with)}`).join(",")])]);
}

/** The status line over the project's name. */
function updateDesk() {
  const n = ws.docs.length;
  const changed = savedPrint !== null && savedPrint !== statePrint();
  const saved = lastSaved ? `saved ${lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${changed ? ", changed since" : ""}` : n ? "not saved yet" : "";
  assistant.setStatus(["Project", n ? `${n} window${n > 1 ? "s" : ""}` : "", saved].filter(Boolean).join(" · "));
  $("project-label").querySelector("span")!.textContent = assistant.projectName === UNTITLED ? "New project" : assistant.projectName;
}

/** The project's name, top right of the start screen: click it to name the project; Enter or leaving keeps it, Escape doesn't. */
function wireProjectLabel() {
  const label = $<HTMLButtonElement>("project-label");
  const input = $<HTMLInputElement>("project-label-input");
  label.insertAdjacentHTML("beforeend", icon("pencil", 13));
  const finish = (keep: boolean) => {
    if (input.hidden) return;
    input.hidden = true;
    label.hidden = false;
    if (keep && input.value.trim() !== (assistant.projectName === UNTITLED ? "" : assistant.projectName)) {
      assistant.setProjectName(input.value.trim());
      updateDesk();
      scheduleAutosave();
    }
    label.focus();
  };
  label.addEventListener("click", () => {
    input.value = assistant.projectName === UNTITLED ? "" : assistant.projectName;
    label.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault(); // or the same Enter, once focus is back on the label, would open the field again
    finish(e.key === "Enter");
  });
  input.addEventListener("blur", () => finish(true));
}

// ------------------------------------------------------------ projects: save, open, autosave

const slug = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "project";

/** Where saves go by default: the Downloads folder in your home folder. */
function downloadsDir(): string {
  const s = server!;
  return s.info.home.replace(/[/\\]$/, "") + s.info.separator + "Downloads";
}

/** Offers bytes as a download, or writes them through the local server. */
async function deliver(bytes: Uint8Array, filename: string, type: string, title: string) {
  if (!server) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notify(`Downloaded ${filename}`);
    return true;
  }
  const sep = server.info.separator;
  const path = await promptDialog(title, "File path", (lastSaveDir ?? downloadsDir()).replace(/[/\\]$/, "") + sep + filename);
  if (!path) return false;
  try {
    await server.write(path, bytes);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("already exists"))) throw e;
    if (!(await confirmDialog("Replace file?", `${path} already exists. Replace it?`, "Replace"))) return false;
    await server.write(path, bytes, true);
  }
  lastSaveDir = path.slice(0, path.lastIndexOf(sep)) || sep;
  notify(`Saved ${path}`);
  return true;
}

/** Everything a project holds: its name and each window's data and history. */
function gatherProject(): ProjectFile {
  const docs: ProjectDoc[] = ws.docs.map((d) => {
    const place = windows.placement(d.id);
    return {
      id: d.id,
      name: d.name,
      workspace: d.workspace,
      source: d.source,
      // a step still running when saved is followed again on reopening if its job is still
      // going (a reload), and runs again otherwise
      steps: d.steps.map(({ live: _, ...s }) => (s.status === "running" || s.status === "queued" ? { ...s, status: "stale" as const, progress: undefined } : s)),
      marker: d.marker,
      output: d.output,
      rationale: d.rationale,
      prefer: d.prefer,
      ui: d.ui,
      minimized: place?.minimized ?? false,
      rect: place?.rect ?? null,
    };
  });
  return { format: "pharos-project", version: 2, saved: new Date().toISOString(), name: assistant.projectName, docs };
}

/** Marks the session as saved now. */
function savedNow() {
  lastSaved = new Date();
  savedPrint = statePrint();
  updateDesk();
  void autosaveNow();
}

/**
 * Save project…: one file with the windows, their histories and the data
 * they use (and the results, unless left out), so it opens on any computer.
 */
async function saveProject() {
  const s = server;
  const project = gatherProject();
  if (!s) {
    // no local server to read the data: the project alone, as before
    if (await deliver(packProject(project), `${slug(assistant.projectName)}${PROJECT_EXT}`, "application/zip", "Save project")) savedNow();
    return;
  }
  const sizes = await projectSizes(s, project);
  const sep = s.info.separator;
  const suggestedPath = (lastSaveDir ?? downloadsDir()).replace(/[/\\]$/, "") + sep + `${slug(assistant.projectName)}${PROJECT_EXT}`;
  const choice = await showDialog<{ path: string; results: boolean } | null>(
    `<form method="dialog"><h2>Save project</h2>
      <p class="muted small">One file with the windows, their histories and the data they use, so it opens on any computer.</p>
      <label class="field">File<input name="path" value="${escapeHtml(suggestedPath)}" spellcheck="false" autofocus /></label>
      <p class="small">Data · ${formatSize(sizes.data)}</p>
      ${sizes.results ? `<label class="check"><input type="checkbox" name="results" checked /> Include results · ${formatSize(sizes.results)}</label>
      <p class="muted small">Left out, they're made again when the project is opened.</p>` : ""}
      <footer><button type="button" data-cancel>Cancel</button><button class="primary">Save</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const path = (form.elements.namedItem("path") as HTMLInputElement).value.trim();
        const box = form.elements.namedItem("results") as HTMLInputElement | null;
        if (path) done({ path: path.endsWith(PROJECT_EXT) ? path : path + PROJECT_EXT, results: box ? box.checked : false });
      });
    },
    null,
  );
  if (!choice) return;
  // big projects take a while: the busy line shows, and any failure becomes a dialog
  const label = `Saving ${choice.path.slice(choice.path.lastIndexOf(sep) + 1)}`;
  const exists = (e: unknown) => e instanceof Error && e.message.startsWith("already exists");
  let saved = await run(label, () => s.exportProject(project, choice.path, choice.results).catch((e: unknown) => (exists(e) ? ("exists" as const) : Promise.reject(e))));
  if (saved === "exists") {
    if (!(await confirmDialog("Replace file?", `${choice.path} already exists. Replace it?`, "Replace"))) return;
    saved = await run(label, () => s.exportProject(project, choice.path, choice.results, true));
  }
  if (!saved) return;
  lastSaveDir = choice.path.slice(0, choice.path.lastIndexOf(sep)) || sep;
  notify(`Saved ${choice.path} · ${formatSize(saved.bytes)}`);
  const n = saved.missing.length;
  if (n) void alertDialog("Saved without some data", `${n} item${n > 1 ? "s" : ""} the project points at ${n > 1 ? "are" : "is"} no longer in any workspace, so ${n > 1 ? "they weren't" : "it wasn't"} saved. Results among them are made again when the project is opened.`);
  savedNow();
}

/** How much a project's data and results take, for the save dialog. */
async function projectSizes(s: LocalServer, project: ProjectFile): Promise<{ data: number; results: number }> {
  const data = new Map<string, number>();
  const results = new Map<string, string>();
  for (const d of project.docs) {
    data.set(d.source.id, d.source.sizeBytes ?? 0);
    for (const st of d.steps) for (const id of Object.values(st.outputs ?? {})) if (!data.has(id)) results.set(id, d.workspace);
  }
  const sizes = await Promise.all([...results].map(([id, w]) => s.artifact(w, id).then((a) => a.sizeBytes ?? 0, () => 0)));
  return { data: [...data.values()].reduce((a, b) => a + b, 0), results: sizes.reduce((a, b) => a + b, 0) };
}

function pickProject() {
  const s = server;
  // with the local server, the file is read on disk, so a project with gigabytes of data opens without the page holding it
  if (s) return void openProjectFile(s);
  const input = $<HTMLInputElement>("project-input");
  input.value = "";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) await openProject(new Uint8Array(await f.arrayBuffer()), f.name);
  };
  input.click();
}

async function openProject(bytes: Uint8Array, filename: string) {
  if (ws.docs.length && !(await confirmDialog("Open project?", `Opening ${filename} replaces the ${ws.docs.length} window${ws.docs.length > 1 ? "s" : ""} open now. Save first if you need them.`, "Open"))) return;
  const loaded = await run(`Opening ${filename}`, () => unpackProject(bytes));
  if (!loaded) return;
  await restoreProject(loaded.project);
  if (loaded.dropped) void alertDialog("Image windows left out", `This project was saved by the image editor, which Pharos no longer has. Its ${loaded.dropped} image window${loaded.dropped > 1 ? "s were" : " was"} left out: add the images as data to process them with ships.`);
  lastSaved = new Date(loaded.project.saved);
  savedPrint = statePrint();
  updateDesk();
}

/** Open project… through the local server: its data goes back into the workspaces, each checked against its hash. */
async function openProjectFile(s: LocalServer) {
  const path = await browseDialog(s, { title: "Open project", pickFolder: false, start: lastSaveDir, accept: (e) => !e.isDir && e.name.toLowerCase().endsWith(PROJECT_EXT), empty: "No Pharos projects (.pharos) here" });
  if (!path) return;
  const name = path.slice(path.lastIndexOf(s.info.separator) + 1);
  if (ws.docs.length && !(await confirmDialog("Open project?", `Opening ${name} replaces the ${ws.docs.length} window${ws.docs.length > 1 ? "s" : ""} open now. Save first if you need them.`, "Open"))) return;
  const opened = await run(`Opening ${name}`, () => s.importProject(path));
  if (!opened) return;
  const project = opened.project as ProjectFile;
  await restoreProject(project);
  lastSaveDir = path.slice(0, path.lastIndexOf(s.info.separator)) || s.info.separator;
  lastSaved = new Date(project.saved);
  savedPrint = statePrint();
  updateDesk();
  if (opened.imported) notify(`Opened ${name} · ${opened.imported} item${opened.imported > 1 ? "s" : ""} added to the workspace${opened.reused ? `, ${opened.reused} already there` : ""}`);
}

/** An artifact by its hash: in the workspace named first, then in any other (a workspace renamed, or data added elsewhere). */
async function findArtifact(s: LocalServer, workspace: string, id: string): Promise<Artifact | null> {
  const here = await s.artifact(workspace, id).catch(() => null);
  if (here) return here;
  for (const w of await s.workspaces().catch(() => [])) {
    if (w.name === workspace) continue;
    const there = await s.artifact(w.name, id).catch(() => null);
    if (there) return there;
  }
  return null;
}

/** Replaces the session with a project's windows, each showing its data and history as saved. */
async function restoreProject(project: ProjectFile) {
  for (const d of [...ws.docs]) ws.close(d.id);
  assistant.setProjectName(project.name);
  assistant.reset();
  const missing: string[] = [];
  let remade = 0;
  for (const pd of project.docs) {
    // the data, found by its hash; without it the window can't be shown
    const source = server ? await findArtifact(server, pd.workspace, pd.source.id) : null;
    if (!source) {
      missing.push(pd.name);
      continue;
    }
    // results no longer anywhere go back to "changed": running again makes them, often from the cache
    const steps = server
      ? await Promise.all(
          pd.steps.map(async (st) => {
            const outs = Object.values(st.outputs ?? {});
            if (st.status !== "done" || !outs.length) return st;
            const found = await Promise.all(outs.map((id) => findArtifact(server!, pd.workspace, id)));
            if (found.every(Boolean)) return st;
            remade++;
            return { ...st, status: "stale" as const, outputs: undefined, jobId: undefined, cached: undefined };
          }),
        )
      : pd.steps;
    const doc = ws.restore({ name: pd.name, workspace: pd.workspace, source, steps, marker: pd.marker, output: pd.output, rationale: pd.rationale, prefer: pd.prefer, ui: pd.ui });
    windows.sync();
    windows.restorePlacement(doc.id, pd.rect, pd.minimized);
    void processes.reattach(doc);
  }
  ws.touch();
  if (missing.length) void alertDialog("Some windows weren't restored", `Their data isn't in any workspace any more:\n${missing.map((n) => `• ${n}`).join("\n")}`);
  else if (remade) notify(`${remade} step${remade > 1 ? "s" : ""} whose results weren't saved will run again: press Re-run in ${remade > 1 ? "their windows" : "its window"}`);
}

const autosave = new Autosave();
/** False until the previous session has been restored, so an empty start never overwrites it. */
let autosaveReady = false;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosavedPrint = "";

/** When the oldest unsaved change was made: a running step changes the windows every few
 * hundred milliseconds, so waiting for a quiet moment alone would never save during a run. */
let autosavePendingSince = 0;

function scheduleAutosave() {
  if (!autosaveReady) return;
  clearTimeout(autosaveTimer);
  autosavePendingSince ||= Date.now();
  const wait = Date.now() - autosavePendingSince > 5000 ? 0 : 1200;
  autosaveTimer = setTimeout(() => {
    autosavePendingSince = 0;
    void autosaveNow();
  }, wait);
}

async function autosaveNow() {
  if (!autosaveReady) return;
  try {
    const project = gatherProject();
    // skip if nothing a session holds has changed
    const print = JSON.stringify({ ...project, saved: "" });
    if (print === autosavedPrint) return;
    await autosave.save(project, { lastSaved: lastSaved?.toISOString() ?? null, unsaved: savedPrint !== statePrint() });
    autosavedPrint = print;
  } catch (e) {
    console.warn("Pharos: autosave failed", e);
  }
}

/** Brings back the last session from this browser, if there is one. */
async function restoreSession() {
  try {
    const session = await autosave.load();
    if (!session || (!session.project.docs.length && !session.project.name)) return;
    await restoreProject(session.project);
    lastSaved = session.meta.lastSaved ? new Date(session.meta.lastSaved) : null;
    savedPrint = lastSaved ? (session.meta.unsaved ? "" : statePrint()) : null;
    updateDesk();
    const n = ws.docs.length;
    if (n) notify(`Restored your last session: ${n} window${n > 1 ? "s" : ""}`);
  } catch (e) {
    console.warn("Pharos: could not restore the last session", e);
    notify("Could not restore the last session");
  }
}

/** What clearing keeps: the data and results of the project's workspaces, with how much and where. */
async function keptOnDisk(): Promise<string> {
  const fallback = "Your data on disk, the workspace and the library are kept.";
  const s = server;
  if (!s) return fallback;
  const names = [...new Set(ws.docs.map((d) => d.workspace))];
  if (!names.length) names.push(currentWorkspace());
  try {
    const [all, lists] = await Promise.all([s.workspaces(), Promise.all(names.map((n) => s.artifacts(n)))]);
    const size = formatSize(diskUsage(lists.flat()).total);
    const where = names.length === 1 ? homePath(all.find((w) => w.name === names[0])?.path ?? names[0], s.info.home) : `the ${names.join(" and ")} workspaces`;
    return `Your data and results stay on this computer (${size} in ${where}), and so does the library.`;
  } catch {
    return fallback;
  }
}

/** A new, empty project: windows and the conversation go; data on disk and the library stay. */
async function clearProject() {
  if (!(await confirmDialog("New project", `Close every window and clear the conversation? ${await keptOnDisk()}`, "Clear"))) return;
  for (const d of [...ws.docs]) ws.close(d.id);
  ws.resetRefs(); // the conversation citing them goes too, so windows count from 1 again
  assistant.setProjectName("");
  assistant.reset();
  lastSaved = null;
  savedPrint = null;
  ws.touch();
  await autosaveNow();
  notify("Started a new project");
}

// ------------------------------------------------------------ syncing everything with the workspace

// ------------------------------------------------------------ activity: everything running, in one place

/** Ship downloads and builds by ship id, including ones no open window waits for (Get ready). */
const pulls = new Map<string, Extract<ServerEvent, { type: "pull" }>>();

function activityHtml(): string {
  const steps = processes.active();
  const rows = steps.map(({ doc, step, index }) => {
    const p = step.live ?? { phase: step.status === "running" ? ("starting" as const) : ("waiting" as const) };
    return `<button class="activity-row" data-activity-win="${escapeHtml(doc.id)}" role="menuitem">
      <small class="eyebrow">${escapeHtml(doc.name)} · step ${index + 1} of ${doc.steps.length}</small>
      ${progressHtml(p, { title: processes.stepSpec(step.run)?.title ?? step.run })}</button>`;
  });
  const waitingFor = new Set(steps.map((s) => s.step.run.split(".")[0]));
  for (const [ship, e] of pulls) {
    if (waitingFor.has(ship)) continue;
    const building = !e.totalBytes && !!e.message;
    rows.push(`<div class="activity-row"><small class="eyebrow">Getting ready</small>${progressHtml({ phase: building ? "building" : "downloading", ship, ...(e.message ? { message: e.message } : {}), bytes: { received: e.receivedBytes, ...(e.totalBytes ? { total: e.totalBytes } : {}) } })}</div>`);
  }
  return `<section><h4>Running</h4>${rows.join("") || `<p class="pop-note">Nothing is running.</p>`}</section>`;
}

/** The toolbar's activity button: hidden when idle; the open list follows along. */
function updateActivity() {
  const btn = document.querySelector<HTMLElement>(".activity");
  if (!btn) return;
  const steps = processes.active();
  const running = steps.filter((s) => s.step.status === "running").length;
  const busy = steps.length + [...pulls.keys()].filter((ship) => !steps.some((s) => s.step.run.startsWith(`${ship}.`))).length;
  btn.hidden = busy === 0;
  btn.querySelector(".activity-text")!.textContent = running ? `${running} running${busy > running ? ` · ${busy - running} waiting` : ""}` : `${busy} waiting`;
  if (popKey === "activity") {
    if (!busy) closePopover();
    else pop.innerHTML = activityHtml();
  }
}

function refresh() {
  updateActivity();
  updateDesk();
  scheduleAutosave();
  windows.sync();
  overview.refresh(); // after sync, so windows added while it's open are in the grid
  assistant.refresh();
  // with no window on screen (none open, or all minimised) the start screen stands alone;
  // otherwise the column leads with the active window
  const shown = ws.docs.filter((d) => !windows.isMinimized(d.id));
  const active = ws.active && shown.includes(ws.active) ? ws.active : null;
  $("welcome").hidden = shown.length > 0;
  $("assistant").hidden = !shown.length;
  $("assistant").classList.toggle("showing-window", !!active);
  windowSummary.show(active, active ? shown.indexOf(active) + 1 : 0, shown.length);
  updateEnabled();
}

/** Removes a run (or a lone step) from a window's history once you've confirmed, with the later runs that use it. */
async function removeRun(doc: DataDoc, index: number) {
  const blocks = timeBlocks(doc);
  const block = blocks[blockAt(blocks, index + 1)];
  const run = !!block && block.last > block.first;
  const later = !!block && doc.steps.length - 1 > block.last;
  const what = run ? "run" : "step";
  const message = `It leaves this window's history${later ? `, with the later runs that use what it made` : ""}. Your data and the results on disk are kept.`;
  if (!(await confirmDialog(`Remove this ${what}?`, message, `Remove ${what}`, true))) return;
  processes.removeStep(doc, index);
}

/** Closes a window once you've confirmed: its history goes, its data and results stay in the workspace. */
async function closeDoc(doc: DataDoc) {
  const busy = doc.steps.some((s) => s.status === "running" || s.status === "queued");
  const why = busy
    ? "Some of its steps are still running; they carry on, and their results stay in the workspace."
    : `The window and its history close. The data${doc.steps.length ? " and its results stay" : " stays"} in the workspace.`;
  if (!(await confirmDialog(`Close ${doc.name}?`, why, "Close window"))) return;
  ws.close(doc.id);
}

// ------------------------------------------------------------ data: workspace, library, the assistant's proposals

const processes: DataProcesses = new DataProcesses(ws, {
  server: () => server,
  notify,
  busy: (label, fn) => run(label, fn),
  shownArtifact: (doc): Promise<Artifact | null> => windows.dataView(doc.id)?.shownArtifact() ?? Promise.resolve(null),
});

async function dataMenu(doc: DataDoc, anchor: DOMRect) {
  const html = await processes.menuHtml(doc);
  togglePopover(`data:${doc.id}`, anchor, () => html);
}

async function suggestMenu(doc: DataDoc, anchor: DOMRect) {
  const html = await processes.suggestHtml(doc);
  togglePopover(`suggest:${doc.id}`, anchor, () => html);
}

async function openWorkspace() {
  const s = server;
  if (!s) return alertDialog("Workspace", NO_SERVER);
  try {
    await workspacePanel(s, {
      notify,
      open: async (a, workspace) => void ws.open(a, workspace),
      run: async (a, workspace) => void ws.open(a, workspace),
      find: (data, workspace) => openLibrary({ workspace, artifacts: data }),
      ask: async (data, workspace) => {
        for (const a of data) ws.open(a, workspace);
        assistant.focus();
      },
    });
  } catch (e) {
    void alertDialog("Workspace", e instanceof Error ? e.message : String(e));
  }
}

async function openLibrary(data?: { workspace: string; artifacts: Artifact[]; text?: string }) {
  const s = server;
  if (!s) return alertDialog("Books", NO_SERVER);
  try {
    await libraryPanel(
      s,
      {
        notify,
        gpu: () => !!lastStatus?.gpu.available,
        usePlan: async (book, action) => {
          // a book's action applies to a dataset: its window, or the active one
          const doc = data?.artifacts[0] ? ws.open(data.artifacts[0], data.workspace) : ws.active;
          if (!doc) return notify(`Open your data first (Add data, or an example), then choose ${book.title} from its window's ⋯ menu.`);
          await processes.useBook(doc, book.id, action);
        },
      },
      data,
    );
  } catch (e) {
    void alertDialog("Books", e instanceof Error ? e.message : String(e));
  }
}

/** The assistant's turn: a recipe for the active window's data, proposed into its history. */
async function ask(text: string, history: ChatTurn[]): Promise<AskReply> {
  const s = server!;
  const doc = ws.active!;
  const shown = (await windows.dataView(doc.id)?.shownArtifact()) ?? doc.source;
  const { open, cites } = windowRefs(doc);
  const r = await s.assistantPlan(doc.workspace, text, [shown.id], history, open);
  // a reply in words (a greeting, an answer, or what's missing): the assistant knows what fits and says so itself
  if (!r.plan) return { text: r.message, cites };
  if (r.plan.book) {
    const target = await processes.suggest(r.plan, shown, text);
    void s.cancelPlan(r.plan.id).catch(() => {}); // the server's copy isn't needed: it runs from the Controls
    const sug = target.suggestion;
    return { text: r.plan.rationale ?? r.message, cites, suggested: { window: target.name, windowId: target.id, title: sug?.title ?? r.plan.title, book: sug?.book.title ?? "" } };
  }
  const target = await processes.fromPlan(r.plan, shown);
  const steps = r.plan.steps.length;
  return { text: r.plan.rationale ?? r.message, cites, proposed: { window: target.name, windowId: target.id, steps, title: r.plan.title } };
}

/**
 * The open windows as the assistant sees them, to cite: each by its number
 * ([2]), the runs in its history as they're numbered there ([2.1]); and what
 * each citation points at, kept with the reply so it still finds them later.
 */
function windowRefs(active: DataDoc): { open: WindowRef[]; cites: Record<string, CiteTarget> } {
  const open: WindowRef[] = [];
  const cites: Record<string, CiteTarget> = {};
  for (const d of ws.docs) {
    const ref = String(d.ref);
    const runs = timeBlocks(d).filter((b) => !underWay(d, b));
    open.push({
      ref,
      title: d.name,
      data: `${d.source.name ?? d.name}, ${kindLabel(d.source)} (${formatTitle(d.source.format)})`,
      ...(d === active ? { active: true } : {}),
      runs: runs.map((b, i) => ({ ref: `${ref}.${i + 1}`, title: b.title, status: b.status })),
    });
    cites[ref] = { windowId: d.id, label: d.name };
    runs.forEach((b, i) => (cites[`${ref}.${i + 1}`] = { windowId: d.id, block: d.steps[b.first].block, run: i + 1, label: `run ${i + 1} in ${d.name}` }));
  }
  return { open, cites };
}

function aiUnavailable(): string | null {
  if (!server) return NO_SERVER;
  if (!aiConfig) return "Assistant settings are unavailable.";
  if (!aiConfig.keySource) return "To use the assistant, add an Anthropic API key in Settings › Assistant and API key…, top right.";
  return null;
}

// ------------------------------------------------------------ data first: add data, or an example and its question

/**
 * Once data is in the workspace, each item opens in its own window; with a
 * question (an example's, and the assistant set up) the assistant proposes a plan.
 * An example's own action (`prefer`) leads its window's Controls.
 */
async function dataFlow(workspace: string, artifacts: Artifact[], text = "", prefer?: DataDoc["prefer"]) {
  if (!server || !artifacts.length) return;
  for (const a of artifacts) {
    const fresh = !ws.docs.some((d) => d.source.id === a.id && d.workspace === workspace);
    const doc = ws.open(a, workspace);
    if (prefer) doc.prefer = prefer;
    // a window new to this data opens with its book's opening action (an OpenFOAM case: its 3D model)
    if (fresh) void processes.openWith(doc).catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
  }
  if (text && !aiUnavailable()) return assistant.focus(text);
  if (text && aiConfig && !aiConfig.keySource) notify("Add an API key in Settings and the assistant will propose the steps; for now, pick a suggestion in the window or its ⋯ menu.");
}

/** Add data: a file or folder on this computer into the workspace. */
async function addData() {
  const s = server;
  if (!s) return alertDialog("Add data", NO_SERVER);
  const path = await browseDialog(s, { title: "Add data", pickFolder: false, allowFolder: true, start: lastDir, accept: isSupported, empty: "No supported files here; open a folder, or use this folder if it is the data" });
  if (!path) return;
  lastDir = path.slice(0, path.lastIndexOf(s.info.separator)) || s.info.separator;
  const workspace = currentWorkspace();
  const added = await run(`Adding ${path.slice(path.lastIndexOf(s.info.separator) + 1)}`, async () => {
    await s.createWorkspace(workspace);
    return s.importPath(workspace, path);
  });
  if (added) await dataFlow(workspace, [added]);
}

/** Dropped files go into the workspace; projects open as projects. */
async function dropData(files: File[], folders: string[]) {
  const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXT));
  if (project) return openProject(new Uint8Array(await project.arrayBuffer()), project.name);
  const s = server;
  if (!s) return alertDialog("Add data", NO_SERVER);
  if (folders.length) notify(`Folders can't be dropped yet (${folders.join(", ")}): use Add data… and choose the folder.`);
  if (!files.length) return;
  const workspace = currentWorkspace();
  const added = await run(`Adding ${files.length === 1 ? files[0].name : `${files.length} files`}`, async () => {
    await s.createWorkspace(workspace);
    const out: Artifact[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      try {
        out.push(await s.upload(workspace, f));
      } catch (e) {
        skipped.push(`${f.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (skipped.length) void alertDialog("Some files weren't added", skipped.join("\n"));
    return out;
  });
  if (added?.length) await dataFlow(workspace, added);
}

/** Loads an example into the workspace with its problem statement, as if it had been dropped in. */
async function loadExample(s: LocalServer, e: Example) {
  const workspace = currentWorkspace();
  const added = await run(`Loading ${e.title}`, () => s.loadExample(e.id, workspace));
  if (!added) return;
  await dataFlow(workspace, added, e.prompt, e.run && { book: e.run.book, action: e.run.action, values: e.run.params });
}

async function showExamples(s: LocalServer) {
  const examples = await s.examples().catch(() => []);
  const list = $("example-list");
  list.innerHTML = exampleCards(examples);
  $("examples-toggle").hidden = !examples.length;
  list.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((b) =>
    b.addEventListener("click", () => loadExample(s, examples.find((x) => x.id === b.dataset.example)!)),
  );
}

/** Example data, from the Add data menu once the start screen has gone. */
async function examplesDialog() {
  const s = server;
  if (!s) return;
  const examples = await s.examples().catch(() => []);
  const picked = await showDialog<Example | null>(
    `<p class="eyebrow">Add data</p><h2>Example data</h2>
     <p class="muted small">Synthetic microscopy and simulation cases, each with a question to try. Hover a card for details.</p>
     <div class="example-list grid">${exampleCards(examples) || `<p class="muted">No examples in the library.</p>`}</div>
     <footer><button class="primary" data-cancel>Close</button></footer>`,
    (done, el) => {
      el.classList.add("wide");
      showPictures(s, el);
      el.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((b) => b.addEventListener("click", () => done(examples.find((x) => x.id === b.dataset.example)!)));
    },
    null,
  );
  document.getElementById("dialog")?.classList.remove("wide");
  if (picked) await loadExample(s, picked);
}

// ------------------------------------------------------------ ships: system status, jobs, storage

let lastStatus: SystemStatus | null = null;

function showStatus(status: SystemStatus | null) {
  lastStatus = status ?? lastStatus;
  const el = document.querySelector<HTMLElement>(".sys-status");
  if (!el) return;
  const chip = statusChip(status);
  el.dataset.tone = chip.tone;
  el.title = `Ships: the tools books and windows run. ${chip.title} ${chip.text}.`;
}

async function openStorage() {
  if (!server) return alertDialog("Ships", NO_SERVER);
  try {
    await storageDialog(server, notify);
  } catch (e) {
    void alertDialog("Ships and storage", e instanceof Error ? e.message : String(e));
  }
}

/** Follows the server's jobs, downloads and status for as long as the page is open. */
async function connectShips(s: LocalServer) {
  void s.formats().then(setFormats, () => {});
  showStatus(null);
  s.events(
    (e) => {
      processes.handle(e);
      if (e.type === "status") showStatus(e.status);
      if (e.type === "pull") {
        if (e.done) pulls.delete(e.ship);
        else pulls.set(e.ship, e);
        updateActivity();
        if (e.done) windowSummary.invalidate();
        else windowSummary.render();
      }
      if (e.type === "library") windowSummary.invalidate();
    },
    (reconnect) => {
      if (reconnect) void processes.resync();
    },
  );
  showStatus(await s.status().catch(() => null));
}

// ------------------------------------------------------------ assistant settings

async function settingsDialog() {
  await ready;
  if (server) aiConfig = await server.aiConfig().catch(() => aiConfig);
  const cfg = aiConfig;
  const keyStatus = !cfg?.keySource
    ? "No key set"
    : cfg.keySource === "settings"
      ? `Saved key ${cfg.keyHint ?? ""}`
      : cfg.keySource === "file"
        ? `Using ANTHROPIC_API_KEY from ${cfg.keyFile ?? ".env"}`
        : "Using ANTHROPIC_API_KEY from the environment";
  const connection = server ? `Connected to the Pharos ${server.info.version} server on this computer (${server.info.platform}${server.info.capabilities.python.available ? ", Python ready" : ""}).` : NO_SERVER;
  const body = !server
    ? `<footer><button class="primary" data-cancel>Close</button></footer>`
    : `<form method="dialog">
        <p class="muted">Say what you want to find out about your data; the assistant picks a book and proposes its steps in the window. Nothing runs until you approve. It sees what the data is (size, type, axes), never its contents.</p>
        <label class="field">Model<select name="model">${cfg!.models.map((m) => `<option value="${m.id}"${m.id === cfg!.model ? " selected" : ""}>${escapeHtml(`${m.label} (${m.note})`)}</option>`).join("")}</select></label>
        <label class="field">Anthropic API key <input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(keyStatus)}" /></label>
        <p class="muted small">Stored on this computer in <code>~/.config/pharos/settings.json</code>, readable only by you, and used only by the local server. The key is never sent to this page. Requests are billed to the key's Anthropic account.</p>
        ${tokenUsageHtml(cfg!.usage, cfg!.models, localDay())}
        <p class="error" hidden></p>
        <footer>${cfg!.keySource === "settings" ? `<button type="button" class="danger" data-remove>Remove saved key</button><span class="spacer"></span>` : ""}<button type="button" data-cancel>Cancel</button><button class="primary">Save</button></footer>
      </form>`;
  await showDialog(
    `<p class="eyebrow">Settings</p><h2>Assistant</h2><p class="muted small">${escapeHtml(connection)}</p>${body}`,
    (done, el) => {
      const form = el.querySelector("form");
      if (!form || !server) return;
      const err = el.querySelector<HTMLElement>(".error")!;
      const fail = (e: unknown) => {
        err.hidden = false;
        err.textContent = e instanceof Error ? e.message : String(e);
      };
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const model = (form.elements.namedItem("model") as HTMLSelectElement).value;
        const key = (form.elements.namedItem("key") as HTMLInputElement).value.trim();
        try {
          aiConfig = await server!.setAiConfig(key ? { model, apiKey: key } : { model });
          notify("Settings saved");
          done(undefined);
        } catch (x) {
          fail(x);
        }
      });
      el.querySelector("[data-remove]")?.addEventListener("click", async () => {
        try {
          aiConfig = await server!.setAiConfig({ apiKey: null });
          notify("Saved API key removed");
          done(undefined);
        } catch (x) {
          fail(x);
        }
      });
    },
    undefined,
  );
  assistant.refresh();
}

// ------------------------------------------------------------ wiring

const assistant = new Assistant($("assistant"), $("ask-box"), {
  unavailable: aiUnavailable,
  target: () => ws.active?.name ?? null,
  ask,
  search: searchHits,
  renamed: () => {
    updateDesk();
    scheduleAutosave();
  },
  show: (id, place) => {
    const doc = ws.get(id);
    if (!doc) return notify("That window has been closed.");
    if (place === "suggested") {
      doc.ui.controls = true;
      doc.ui.controlsTab = "suggested";
    }
    windows.restore(id); // forward and active, out of the minimised stack if it was there
    ws.touch();
  },
  // a citation: the window forward, at the cited run (found by its id, so later runs don't move it)
  cite: (t) => {
    const doc = ws.get(t.windowId);
    if (!doc) return notify(`${t.label} has been closed.`);
    if (t.run) {
      const own = t.block ? doc.steps.flatMap((s, i) => (s.block === t.block ? [i] : [])) : [];
      const last = own.length ? own[own.length - 1] : timeBlocks(doc).filter((b) => !underWay(doc, b))[t.run - 1]?.last;
      if (last === undefined) notify(`That run is no longer in ${doc.name}'s history.`);
      else {
        doc.marker = last + 1;
        doc.output = undefined;
      }
    }
    windows.restore(doc.id);
    ws.touch();
  },
});

// the active window, atop the left column in the project's place (its name is top right)
// its name and data stay at the column's top; what it needs scrolls with the conversation, above it
const summaryTop = document.createElement("div");
summaryTop.className = "window-top";
$("assistant").querySelector(".assistant-head")!.append(summaryTop);
const summaryEl = document.createElement("section");
summaryEl.className = "window-summary";
summaryEl.setAttribute("aria-label", "The active window");
assistant.scroller.prepend(summaryEl);
const windowSummary = new WindowSummary(summaryEl, summaryTop, {
  server: () => server,
  pulls: () => pulls,
  formatTitle,
  getReady: (book) => void getReady(book),
  select: (doc, marker) => processes.select(doc, marker),
  showLog: (jobId) => void processes.showLog(jobId),
});

/** Downloads or sets up a book's missing ships now, so its first run doesn't wait (as Books… › Get ready). */
async function getReady(book: CatalogueEntry) {
  const s = server;
  if (!s) return;
  const r = await run(`Getting ${book.title} ready`, () => s.getReady(book.id));
  if (r) notify(r.pulling.length ? `Getting ${r.pulling.map((p) => p.id).join(", ")} ready; follow it under Running in the top bar.` : `${book.title} is ready.`);
}

/** The Controls' Suggested tab, for every window. */
const suggested = new SuggestedControls({
  server: () => server,
  unavailable: aiUnavailable,
  subject: (doc) => processes.suggestedSubject(doc),
  run: (doc, subject, values) => processes.runSuggested(doc, subject, values),
  dismiss: (doc) => processes.dismissSuggestion(doc),
  manual: (doc) => {
    doc.ui.controlsTab = "manual";
    ws.touch();
  },
});

const windows: WindowManager = new WindowManager($("desktop"), ws, {
  dataMenu: (doc, anchor) => void dataMenu(doc, anchor),
  close: (doc) => void closeDoc(doc),
  data: {
    server: () => server,
    notify,
    select: (doc, marker, output) => processes.select(doc, marker, output),
    fork: (doc) => processes.fork(doc),
    approve: (doc) => processes.approve(doc),
    rerun: (doc) => processes.rerun(doc),
    cancel: (doc) => processes.cancel(doc),
    showLog: (jobId) => void processes.showLog(jobId),
    viewsFor: (a) => processes.viewsFor(a),
    runView: (doc, a, tool) => processes.runView(doc, a, tool),
    updateStep: (doc, i, params) => processes.updateStep(doc, i, params),
    runControls: (doc, first) => processes.runControls(doc, first),
    updateRun: (doc, first, values) => void processes.updateRun(doc, first, values),
    nextActions: (doc) => processes.nextActions(doc),
    smallerFirst: (doc, a) => processes.smallerFirst(doc, a),
    runNext: (doc, book, action, values) => void processes.runNext(doc, book, action, values),
    removeStep: (doc, i) => void removeRun(doc, i),
    suggestMenu: (doc, anchor) => void suggestMenu(doc, anchor),
    // the assistant's layout leads while it can be used; the window remembers a choice of tab
    controlsTab: (doc) => doc.ui.controlsTab ?? (aiUnavailable() ? "manual" : "suggested"),
    renderSuggested: (doc, host) => void suggested.render(doc, host),
    stepSpec: (r) => processes.stepSpec(r),
  },
  insets,
  // below the top bar, beside the assistant column, which stays in view
  expandArea: () => {
    const top = $("toolbar").getBoundingClientRect().bottom;
    const left = columnRight();
    return { x: left, y: top, w: innerWidth - left, h: innerHeight - top };
  },
});

const overview = new Overview({
  workspace: ws,
  windows,
  actions: () => ACTIONS,
  ask: (q) => assistant.focus(q),
  aiUnavailable,
  closeDoc: (doc) => void closeDoc(doc),
  addFiles: (files) => void dropData(files, []),
});

ws.subscribe(refresh);

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const isMenu = el.getAttribute("aria-haspopup") === "menu";
  if (el.closest(".menu-pop")) closePopover();
  if (!isMenu) (document.activeElement as HTMLElement | null)?.blur();
  runAction(el.dataset.action!, el).catch((err) => alertDialog("Error", err instanceof Error ? err.message : String(err)));
});

document.addEventListener("keydown", (e) => {
  if (isDialogOpen() || overview.isOpen) return;
  const target = e.target as HTMLElement;
  const typing = target.matches("input, select, textarea") || target.isContentEditable;
  if (e.key === "Escape" && !pop.hidden) return closePopover();
  if (typing) return;
  // Tab shows every open window (like Mission Control) unless focus is on a control,
  // so keyboard navigation between buttons keeps working
  const onControl = target !== document.body && !!target.closest("button, a, [tabindex]");
  if ((e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !onControl) || e.key === "F3") {
    e.preventDefault();
    return void overview.open();
  }
  for (const a of ACTIONS) {
    if (a.shortcut && a.shortcut !== "Tab" && matchesShortcut(e, a.shortcut)) {
      e.preventDefault();
      void runAction(a.id);
      return;
    }
  }
});

// drop files anywhere to add them to the workspace
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || overview.isOpen) return;
  dragDepth++;
  const n = e.dataTransfer!.items.length;
  $("drop-text").textContent = n > 1 ? `Drop to add ${n} files` : "Drop to add your data";
  $("drop").hidden = false;
});
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop").hidden = true;
});
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  dragDepth = 0;
  $("drop").hidden = true;
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  // folders arrive as entries without readable content; note them, add the files
  const items = [...e.dataTransfer.items];
  const folders = items.map((i) => i.webkitGetAsEntry?.()).filter((x) => x?.isDirectory).map((x) => x!.name);
  const files = [...e.dataTransfer.files].filter((f) => !folders.includes(f.name));
  void dropData(files, folders);
});

wireProjectLabel();
wireExampleGallery(() => {
  if (server) showPictures(server, $("example-list"));
});

$("dropzone-icon").innerHTML = icon("upload", 26);
const bar = $("project-bar");
bar.querySelector('[data-action="save-project"]')!.innerHTML = `${icon("save", 15)}<span>Save project</span>`;
bar.querySelector('[data-action="open-project"]')!.innerHTML = `${icon("open", 15)}<span>Open</span>`;
bar.querySelector('[data-action="clear-project"]')!.innerHTML = `${icon("new", 15)}<span>Clear</span>`;
$("drop-icon").innerHTML = icon("upload", 40);
document.documentElement.classList.toggle("mac", isMac);
buildToolbar();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void autosaveNow();
});
refresh();

async function boot() {
  startClock();
  server = await LocalServer.connect();
  if (server) {
    aiConfig = await server.aiConfig().catch(() => null);
    void connectShips(server);
    void showExamples(server);
    void processes.loadShips();
  } else $("no-server").hidden = false;
  await restoreSession();
  autosaveReady = true;
  updateEnabled();
  assistant.refresh();
}

/** Resolves once the server connection is settled and the last session is back. */
const ready = boot();

ready.catch((e) => {
  console.error(e);
  notify(`Failed to start: ${e instanceof Error ? e.message : e}`);
});
