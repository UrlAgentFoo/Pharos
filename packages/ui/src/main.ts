import "./style.css";
import type { Artifact, Example, ServerEvent, SystemStatus } from "@pharos/contracts";
import { type AiConfig, LocalServer } from "./api.js";
import { type AskReply, Assistant, type SearchHit } from "./chat.js";
import { DataProcesses } from "./data-processes.js";
import type { Suggestion } from "./data-window.js";
import { alertDialog, browseDialog, confirmDialog, escapeHtml, isDialogOpen, promptDialog, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import { formatShortcut, isMac, matchesShortcut } from "./keys.js";
import { libraryPanel } from "./library-panel.js";
import { barHtml, clockHtml, progressHtml, startClock } from "./progress.js";
import { type Action, Overview, score } from "./overview.js";
import { PROJECT_EXT, type ProjectDoc, type ProjectFile, packProject, unpackProject } from "./project.js";
import { Autosave } from "./session.js";
import { statusChip, storageDialog } from "./storage.js";
import { WindowManager } from "./windows.js";
import { type DataDoc, Workspace } from "./workspace.js";
import { currentWorkspace, isSupported, setFormats, workspacePanel } from "./workspace-panel.js";

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
  // under the anchor, kept on screen (menus from a window's right edge open leftwards)
  pop.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, anchor.left))}px`;
  pop.style.top = `${Math.min(innerHeight - r.height - 8, anchor.bottom + 6)}px`;
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

/** Space taken by the toolbar, the assistant column and the bottom bar, which windows avoid. */
function insets() {
  const tb = $("toolbar").getBoundingClientRect();
  const column = $("assistant");
  // windows open beside the assistant column when it is shown (wide screens)
  const left = getComputedStyle(column).display !== "none" ? column.getBoundingClientRect().right + 32 : 0;
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
      ui: d.ui,
      minimized: place?.minimized ?? false,
      rect: place?.rect ?? null,
    };
  });
  return { format: "pharos-project", version: 2, saved: new Date().toISOString(), name: assistant.projectName, docs };
}

async function saveProject() {
  if (await deliver(packProject(gatherProject()), `${slug(assistant.projectName)}${PROJECT_EXT}`, "application/zip", "Save project")) {
    lastSaved = new Date();
    savedPrint = statePrint();
    updateDesk();
    void autosaveNow();
  }
}

function pickProject() {
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

/** Replaces the session with a project's windows, each showing its data and history as saved. */
async function restoreProject(project: ProjectFile) {
  for (const d of [...ws.docs]) ws.close(d.id);
  assistant.setProjectName(project.name);
  assistant.reset();
  const missing: string[] = [];
  for (const pd of project.docs) {
    // the data must still be in its workspace: results come back from there too
    const source = server ? await server.artifact(pd.workspace, pd.source.id).catch(() => null) : null;
    if (!source) {
      missing.push(pd.name);
      continue;
    }
    const doc = ws.restore({ name: pd.name, workspace: pd.workspace, source, steps: pd.steps, marker: pd.marker, output: pd.output, rationale: pd.rationale, ui: pd.ui });
    windows.sync();
    windows.restorePlacement(doc.id, pd.rect, pd.minimized);
    void processes.reattach(doc);
  }
  ws.touch();
  if (missing.length) void alertDialog("Some windows weren't restored", `Their data is no longer in its workspace:\n${missing.map((n) => `• ${n}`).join("\n")}`);
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

/** A new, empty project: windows and the conversation go; data on disk and the library stay. */
async function clearProject() {
  if (!(await confirmDialog("New project", "Close every window and clear the conversation? Your data on disk, the workspace and the library are kept.", "Clear"))) return;
  for (const d of [...ws.docs]) ws.close(d.id);
  assistant.setProjectName("");
  assistant.reset();
  $<HTMLTextAreaElement>("problem").value = "";
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
  assistant.refresh();
  $("welcome").hidden = ws.docs.length > 0;
  updateEnabled();
}

async function closeDoc(doc: DataDoc) {
  const busy = doc.steps.some((s) => s.status === "running" || s.status === "queued");
  if (busy && !(await confirmDialog(`Close ${doc.name}?`, "Some of its steps are still running; they carry on, and their results stay in the workspace.", "Close"))) return;
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
async function ask(text: string): Promise<AskReply> {
  const s = server!;
  const doc = ws.active!;
  const shown = (await windows.dataView(doc.id)?.shownArtifact()) ?? doc.source;
  const r = await s.assistantPlan(doc.workspace, text, [shown.id]);
  if (!r.plan) return { text: `${r.message}${r.matches.some((m) => m.tier !== "excluded") ? "" : "\n\nNo installed book can run on this data."}` };
  const target = await processes.fromPlan(r.plan, shown);
  const steps = r.plan.steps.length;
  return { text: r.plan.rationale ?? r.message, proposed: { window: target.name, steps, title: r.plan.title } };
}

function aiUnavailable(): string | null {
  if (!server) return NO_SERVER;
  if (!aiConfig) return "Assistant settings are unavailable.";
  if (!aiConfig.keySource) return "Add an Anthropic API key in Settings to use the assistant.";
  return null;
}

// ------------------------------------------------------------ data first: add data, examples, the problem statement

/** The optional problem statement on the start screen. */
const problemText = () => $<HTMLTextAreaElement>("problem").value.trim();

/**
 * Once data is in the workspace, each item opens in its own window; with a
 * problem statement (and the assistant set up) the assistant proposes a plan.
 */
async function dataFlow(workspace: string, artifacts: Artifact[]) {
  if (!server || !artifacts.length) return;
  for (const a of artifacts) ws.open(a, workspace);
  const text = problemText();
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

/** Example cards: what the data is, its name and the problem statement it comes with. */
const exampleCards = (examples: Example[]) =>
  examples
    .map(
      (e) => `<button class="example" data-example="${escapeHtml(e.id)}" title="${escapeHtml(e.description)}">
        <small class="eyebrow">${escapeHtml(e.kind)}</small><strong>${escapeHtml(e.title)}</strong>
        <em>“${escapeHtml(e.prompt)}”</em></button>`,
    )
    .join("");

/** Loads an example into the workspace with its problem statement, as if it had been dropped in. */
async function loadExample(s: LocalServer, e: Example) {
  const workspace = currentWorkspace();
  const added = await run(`Loading ${e.title}`, () => s.loadExample(e.id, workspace));
  if (!added) return;
  $<HTMLTextAreaElement>("problem").value = e.prompt;
  await dataFlow(workspace, added);
}

async function showExamples(s: LocalServer) {
  const examples = await s.examples().catch(() => []);
  const list = $("example-list");
  list.innerHTML = exampleCards(examples);
  $("examples").hidden = !examples.length;
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
     <div class="example-list">${exampleCards(examples) || `<p class="muted">No examples in the library.</p>`}</div>
     <footer><button class="primary" data-cancel>Close</button></footer>`,
    (done, el) => {
      el.classList.add("wide");
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
      }
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
  const keyStatus = !cfg?.keySource ? "No key set" : cfg.keySource === "settings" ? `Saved key ${cfg.keyHint ?? ""}` : "Using ANTHROPIC_API_KEY from the environment";
  const connection = server ? `Connected to the Pharos ${server.info.version} server on this computer (${server.info.platform}${server.info.capabilities.python.available ? ", Python ready" : ""}).` : NO_SERVER;
  const body = !server
    ? `<footer><button class="primary" data-cancel>Close</button></footer>`
    : `<form method="dialog">
        <p class="muted">Say what you want to find out about your data; the assistant picks a recipe and proposes its steps in the window. Nothing runs until you approve. It sees what the data is (size, type, axes), never its contents.</p>
        <label class="field">Model<select name="model">${cfg!.models.map((m) => `<option value="${m.id}"${m.id === cfg!.model ? " selected" : ""}>${escapeHtml(`${m.label} (${m.note})`)}</option>`).join("")}</select></label>
        <label class="field">Anthropic API key <input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(keyStatus)}" /></label>
        <p class="muted small">Stored on this computer in <code>~/.config/pharos/settings.json</code>, readable only by you, and used only by the local server. The key is never sent to this page. Requests are billed to the key's Anthropic account.</p>
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
  openSettings: () => void settingsDialog(),
  renamed: () => {
    updateDesk();
    scheduleAutosave();
  },
});

const windows: WindowManager = new WindowManager($("desktop"), ws, {
  dataMenu: (doc, anchor) => void dataMenu(doc, anchor),
  data: {
    server: () => server,
    notify,
    select: (doc, marker, output) => processes.select(doc, marker, output),
    approve: (doc) => processes.approve(doc),
    rerun: (doc) => processes.rerun(doc),
    cancel: (doc) => processes.cancel(doc),
    showLog: (jobId) => void processes.showLog(jobId),
    viewsFor: (a) => processes.viewsFor(a),
    runView: (doc, a, tool) => processes.runView(doc, a, tool),
    updateStep: (doc, i, params) => processes.updateStep(doc, i, params),
    removeStep: (doc, i) => processes.removeStep(doc, i),
    apply: (doc, s) => void processes.apply(doc, s),
    suggestions: (doc, a): Promise<Suggestion[]> => processes.suggestions(doc, a),
    stepSpec: (r) => processes.stepSpec(r),
    openSeparately: (doc, a) => processes.openSeparately(doc, a),
  },
  insets,
  expandArea: () => {
    const top = $("toolbar").getBoundingClientRect().bottom;
    return { x: 0, y: top, w: innerWidth, h: innerHeight - top };
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
  if (matchesShortcut(e, "Mod+K")) {
    e.preventDefault();
    return assistant.focus();
  }
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

$("formats-toggle").addEventListener("click", () => {
  const f = $("formats");
  f.hidden = !f.hidden;
  $("formats-toggle").setAttribute("aria-expanded", String(!f.hidden));
});

$("dropzone-icon").innerHTML = icon("upload", 26);
const bar = $("project-bar");
bar.querySelector('[data-action="save-project"]')!.innerHTML = `${icon("save", 15)}<span>Save project</span>`;
bar.querySelector('[data-action="open-project"]')!.innerHTML = `${icon("open", 15)}<span>Open</span>`;
bar.querySelector('[data-action="clear-project"]')!.innerHTML = `${icon("new", 15)}<span>Clear</span>`;
$("drop-icon").innerHTML = icon("upload", 40);
$("welcome-hint").innerHTML = `<kbd>Tab</kbd> shows every window · <kbd>${formatShortcut("Mod+K")}</kbd> finds any action or asks the assistant`;
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
