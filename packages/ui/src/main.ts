import "./style.css";
import { COMMANDS, type Command, type Kernels, type Params, autoContrast, defaultParams, getCommand, getPlane, loadKernels, minMax, parseParams, readTiff, writeTiff } from "@pharos/core";
import wasmUrl from "@pharos/core/wasm/pharos_kernels.wasm?url";
import { measureDoc, particlesDialog, setScaleInitial, thresholdDialog } from "./analysis.js";
import { type AiConfig, type ChatReply, LocalServer } from "./api.js";
import { Chat } from "./chat.js";
import { alertDialog, browseDialog, confirmDialog, escapeHtml, isDialogOpen, paramsDialog, promptDialog, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import { formatShortcut, isMac, matchesShortcut } from "./keys.js";
import { type NoteRef, Notes } from "./notes.js";
import { type Action, Overview } from "./overview.js";
import { PROJECT_EXT, type ProjectDoc, type ProjectFile, packProject, packTiffs, unpackProject } from "./project.js";
import { sampleCells, sampleVolume } from "./samples.js";
import type { StepPayload } from "./timeline-bar.js";
import { Results } from "./results.js";
import { Autosave } from "./session.js";
import { TOOLS, type Tool, onToolChange, resetRanges, setTool, thumbnailElement } from "./viewer.js";
import { WindowManager } from "./windows.js";
import { type DataDoc, type Doc, Workspace } from "./workspace.js";
import { currentWorkspace, isSupported, workspacePanel } from "./workspace-panel.js";
import { type LibraryTab, libraryPanel } from "./library-panel.js";
import { DataProcesses } from "./data-processes.js";
import type { Suggestion } from "./data-window.js";
import { JobsPanel } from "./jobs-panel.js";
import { statusChip, storageDialog } from "./storage.js";
import type { Artifact, SystemStatus } from "@pharos/contracts";

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

let kernels: Kernels;
let server: LocalServer | null = null;
let aiConfig: AiConfig | null = null;
let lastDir: string | undefined;
/** The folder you last saved into; saves start in Downloads until then. */
let lastSaveDir: string | undefined;
/** Parameters last used per command, so dialogs remember them like ImageJ does. */
const lastParams = new Map<string, Params>();

/** Commands switched off in Plugins leave the menus and search. Remembered per browser. */
const HIDDEN_KEY = "pharos.hidden-commands";
const hiddenCommands = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);
function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenCommands]));
  } catch {
    /* not remembered: fine */
  }
}

// a getter, so timelines made before the kernels finish loading still find them
const ws = new Workspace(() => ({
  get kernels() {
    return kernels;
  },
}));

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

function dtypeLabel(dtype: string) {
  return dtype === "uint8" ? "8-bit" : dtype === "uint16" ? "16-bit" : "32-bit float";
}

/** Runs a possibly slow change with a busy indicator; errors become a dialog. */
async function run<T>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const el = $("busy");
  el.textContent = `${label}…`;
  const timer = setTimeout(() => (el.hidden = false), 150); // only show it for slow work
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  const t0 = performance.now();
  try {
    const out = await fn();
    const ms = Math.round(performance.now() - t0);
    if (ms > 400) notify(`${label} done in ${ms} ms`);
    return out;
  } catch (e) {
    console.error(e);
    void alertDialog("Something went wrong", e instanceof Error ? e.message : String(e));
    return undefined;
  } finally {
    clearTimeout(timer);
    el.hidden = true;
  }
}

// ------------------------------------------------------------ actions (toolbar, menu, palette, shortcuts)

interface AppAction extends Action {
  /** Menu path; the first entry is the top-level menu. */
  menu: string[];
}

const needsImage = () => !!ws.active;

function commandAction(cmd: Command): AppAction {
  return {
    id: cmd.id,
    title: cmd.title,
    menu: cmd.menu,
    section: cmd.menu.join(" › "),
    icon: cmd.icon,
    shortcut: cmd.shortcut,
    keywords: cmd.keywords,
    description: cmd.description,
    enabled: () => needsImage() && !hiddenCommands.has(cmd.id),
    run: () => runCommand(cmd),
  };
}

/** Windows that are not minimised. */
const visibleDocs = () => ws.docs.filter((d) => !windows.isMinimized(d.id));

function act(a: Omit<AppAction, "section">): AppAction {
  return { ...a, section: a.menu.join(" › ") };
}

const appActions: AppAction[] = [
  act({ id: "open", title: "Open…", menu: ["File"], icon: "open", shortcut: "Mod+O", keywords: ["load", "file", "tiff", "browse"], enabled: () => true, run: () => openDialog() }),
  act({ id: "workspace", title: "Workspace…", menu: ["File"], icon: "panel", keywords: ["data", "artifacts", "project", "folder", "library", "import", "add"], description: "Your data on disk: add files and open them", enabled: () => true, run: () => openWorkspace() }),
  act({ id: "library", title: "Library…", menu: ["File"], icon: "plug", keywords: ["books", "recipes", "pipelines", "install", "catalogue", "ships", "tools", "plugins"], description: "Books, ships and built-in tools", enabled: () => true, run: () => openLibrary() }),
  act({ id: "add-data", title: "Add data…", menu: ["File"], icon: "add", keywords: ["import", "files", "folder", "upload", "dataset", "openfoam", "microscopy"], description: "Add files or a folder to the workspace and find books for them", enabled: () => true, run: () => addData() }),
  act({ id: "clear-project", title: "New project (clear)", menu: ["File"], icon: "new", keywords: ["clear", "reset", "new", "empty", "start over"], description: "Closes every window and clears notes and results; your data on disk is kept", enabled: () => true, run: () => clearProject() }),
  act({ id: "jobs", title: "Jobs", menu: ["View"], icon: "batch", keywords: ["running", "progress", "queue", "cancel", "ships", "containers", "logs"], description: "Ship operations: progress, logs, cancel", enabled: () => !!server, run: () => jobsPanel.toggle() }),
  act({ id: "storage", title: "Ships and storage…", menu: ["View"], icon: "save", keywords: ["docker", "gpu", "disk", "download", "remove", "cache", "status", "test"], description: "Docker, GPU, downloaded ships and the cache", enabled: () => !!server, run: () => openStorage() }),
  act({ id: "open-local", title: "Open from this computer…", menu: ["File"], icon: "upload", keywords: ["upload", "browse"], enabled: () => true, run: () => openFromComputer() }),
  act({ id: "sample", title: "Open sample image", menu: ["File"], icon: "image", keywords: ["demo", "example", "2d"], enabled: () => true, run: () => openSample(false) }),
  act({ id: "sample-3d", title: "Open 3D sample", menu: ["File"], icon: "cube", keywords: ["demo", "example", "volume", "stack", "z"], enabled: () => true, run: () => openSample(true) }),
  act({ id: "save", title: "Save as TIFF…", menu: ["File"], icon: "save", shortcut: "Mod+S", keywords: ["export", "write"], enabled: needsImage, run: () => save() }),
  act({ id: "close", title: "Close image", menu: ["File"], icon: "close", keywords: ["window"], enabled: needsImage, run: () => ws.active && closeDoc(ws.active) }),
  act({ id: "batch", title: "Run history on a folder…", menu: ["File"], icon: "batch", keywords: ["batch", "process", "folder", "pipeline", "timeline"], enabled: () => !!server && !!ws.active?.timeline.recipe().steps.length, run: () => ws.active && batchDialog(ws.active) }),
  act({ id: "undo", title: "Undo", menu: ["Edit"], icon: "undo", shortcut: "Mod+Z", keywords: ["back", "history"], enabled: () => !!ws.active?.timeline.canUndo, run: () => run("Undo", () => ws.active!.timeline.undo()) }),
  act({ id: "redo", title: "Redo", menu: ["Edit"], icon: "redo", shortcut: "Mod+Shift+Z", keywords: ["forward", "history"], enabled: () => !!ws.active?.timeline.canRedo, run: () => run("Redo", () => ws.active!.timeline.redo()) }),
  act({ id: "duplicate", title: "Duplicate", menu: ["Image"], icon: "duplicate", shortcut: "Mod+Shift+D", keywords: ["copy", "branch", "new window"], description: "Opens a copy in a new window that keeps the steps so far", enabled: needsImage, run: () => ws.active && branch(ws.active, ws.active.timeline.marker) }),
  act({ id: "rename", title: "Rename…", menu: ["Image"], icon: "image", keywords: ["title", "name"], enabled: needsImage, run: () => renameActive() }),
  act({ id: "auto", title: "Auto contrast", menu: ["Image", "Adjust"], icon: "contrast", shortcut: "Mod+Shift+C", keywords: ["brightness", "display range", "enhance"], description: "Changes only the display, not the pixel values", enabled: needsImage, run: () => adjustRange("auto") }),
  act({ id: "reset-range", title: "Reset display range", menu: ["Image", "Adjust"], icon: "contrast", keywords: ["brightness", "contrast"], enabled: needsImage, run: () => adjustRange("reset") }),
  act({ id: "overview", title: "Overview", menu: ["View"], icon: "overview", shortcut: "Tab", keywords: ["all images", "mission control", "switch", "windows", "minimised"], enabled: () => true, run: () => overview.open() }),
  act({ id: "controls", title: "Show or hide controls", menu: ["View"], icon: "panel", shortcut: "\\", keywords: ["inspector", "panel", "drawer", "contrast", "stats"], enabled: needsImage, run: () => ws.active && windows.toggleControls(ws.active.id) }),
  act({ id: "history", title: "Slim or full history line", menu: ["View"], icon: "undo", shortcut: "H", keywords: ["timeline", "steps"], enabled: needsImage, run: () => ws.active && windows.toggleHistory(ws.active.id) }),
  act({ id: "fit", title: "Zoom to fit", menu: ["View"], icon: "fit", shortcut: "F", keywords: ["zoom"], enabled: needsImage, run: () => activeViewer()?.fit() }),
  act({ id: "actual", title: "Actual size (100%)", menu: ["View"], icon: "actual", shortcut: "1", keywords: ["zoom", "100"], enabled: needsImage, run: () => activeViewer()?.actualSize() }),
  act({ id: "minimize", title: "Minimise window", menu: ["View"], icon: "collapse", shortcut: "Mod+Shift+M", keywords: ["hide", "window"], enabled: needsImage, run: () => ws.active && windows.minimize(ws.active.id) }),
  act({ id: "assistant", title: "Assistant", menu: ["View"], icon: "sparkle", shortcut: "Mod+J", keywords: ["ai", "chat", "help", "ask", "suggest"], enabled: () => true, run: () => chat.toggle() }),
  act({ id: "settings", title: "Assistant and API key…", menu: ["View"], icon: "sparkle", keywords: ["settings", "preferences", "api key", "assistant", "ai", "model"], enabled: () => true, run: () => settingsDialog() }),
  act({ id: "dark-mode", title: "Toggle dark mode", menu: ["View"], icon: "contrast", keywords: ["theme", "night", "light", "appearance"], enabled: () => true, run: () => setDark(document.documentElement.dataset.theme !== "dark") }),
  act({ id: "save-project", title: "Save project…", menu: ["File"], icon: "save", shortcut: "Mod+Shift+S", keywords: ["project", "pharos", "zip", "session", "notes"], enabled: () => true, run: () => saveProject() }),
  act({ id: "open-project", title: "Open project…", menu: ["File"], icon: "open", keywords: ["project", "pharos", "zip", "session", "load"], enabled: () => true, run: () => pickProject() }),
  act({ id: "export-all", title: "Export all images as TIFFs (.zip)", menu: ["File"], icon: "batch", keywords: ["export", "zip", "download"], enabled: needsImage, run: () => exportAllTiffs() }),
  act({ id: "export-notes", title: "Export notes as Markdown", menu: ["File"], icon: "script", keywords: ["export", "journal", "markdown", "notes"], enabled: () => true, run: () => exportNotes() }),
  act({ id: "plugins", title: "Built-in tools…", menu: ["View"], icon: "plug", keywords: ["plugins", "extensions", "commands", "manage", "hide"], enabled: () => true, run: () => openLibrary(undefined, "tools") }),
  act({ id: "layout-stack", title: "Stack windows", menu: ["Layout"], icon: "duplicate", keywords: ["cascade", "arrange", "cards"], enabled: needsImage, run: () => windows.arrange("stack") }),
  act({ id: "layout-columns", title: "Side by side", menu: ["Layout"], icon: "layout", keywords: ["split", "compare", "arrange", "columns"], enabled: () => visibleDocs().length > 1, run: () => windows.arrange("columns") }),
  act({ id: "layout-grid", title: "Grid", menu: ["Layout"], icon: "overview", keywords: ["split", "tile", "arrange"], enabled: () => visibleDocs().length > 1, run: () => windows.arrange("grid") }),
  act({ id: "layout-focus", title: "Focus on this image", menu: ["Layout"], icon: "expand", keywords: ["maximise", "full", "arrange"], enabled: needsImage, run: () => windows.arrange("focus") }),
  act({ id: "measure", title: "Measure", menu: ["Analyze"], icon: "measure", shortcut: "M", keywords: ["area", "mean", "intensity", "statistics", "results", "integrated density", "length"], description: "Measures the selection (or the whole slice) and adds a row to Results", enabled: needsImage, run: () => ws.active && measureDoc(analysisCtx, ws.active) }),
  act({ id: "threshold", title: "Threshold…", menu: ["Image", "Adjust"], icon: "threshold", shortcut: "Mod+Shift+T", keywords: ["mask", "binary", "segment", "otsu", "auto threshold", "foreground"], description: "Shows in red what counts as foreground, then makes a mask", enabled: needsImage, run: () => ws.active && thresholdDialog(analysisCtx, ws.active) }),
  act({ id: "analyze-particles", title: "Analyze Particles…", menu: ["Analyze"], icon: "particles", keywords: ["count", "nuclei", "cells", "objects", "segment", "size", "circularity"], description: "Counts and measures each object in a mask or thresholded image", enabled: needsImage, run: () => ws.active && particlesDialog(analysisCtx, ws.active) }),
  act({ id: "results", title: "Results", menu: ["Analyze"], icon: "table", keywords: ["measurements", "table", "csv", "summary", "export"], description: "Every measurement, per image, with CSV export", enabled: () => true, run: () => openResults(ws.active) }),
  act({ id: "select-none", title: "Select none", menu: ["Edit", "Selection"], icon: "close", shortcut: "Mod+Shift+A", keywords: ["deselect", "clear selection", "roi"], enabled: () => !!ws.active?.layers.roi, run: () => ws.active && setRoi(ws.active, null) }),
  act({ id: "select-all", title: "Select all", menu: ["Edit", "Selection"], icon: "select", shortcut: "Mod+A", keywords: ["selection", "roi", "whole image"], enabled: needsImage, run: () => { const d = ws.active!; const { width, height } = d.timeline.current().shape; setRoi(d, { type: "rect", x: 0, y: 0, width, height }); } }),
  act({ id: "clear-outlines", title: "Remove outlines", menu: ["Analyze"], icon: "close", keywords: ["overlay", "particles", "hide"], enabled: () => !!ws.active?.layers.overlay.length, run: () => { ws.active!.layers.overlay = []; windows.renderDoc(ws.active!.id); } }),
  ...TOOLS.filter((t) => t.id !== "hand").map((t) =>
    act({ id: `tool-${t.id}`, title: t.label.split(":")[0], menu: ["Tools"], icon: `tool-${t.id}`, shortcut: t.key, keywords: ["tool", "selection", "roi", "draw"], enabled: () => true, run: () => setTool(t.id) }),
  ),
  act({ id: "tool-hand", title: "Hand: move the view", menu: ["Tools"], icon: "tool-hand", shortcut: "Shift+H", keywords: ["pan", "move", "scroll"], enabled: () => true, run: () => setTool("hand") }),
  act({ id: "group-visible", title: "Group the visible images", menu: ["Group"], icon: "link", keywords: ["link", "sync", "compare", "share controls"], enabled: () => visibleDocs().length > 1, run: () => groupVisible() }),
  act({ id: "leave-group", title: "Remove from its group", menu: ["Group"], icon: "link", keywords: ["unlink", "ungroup"], enabled: () => !!ws.active?.group, run: () => ws.active && ws.leave(ws.active) }),
];

const ACTIONS: AppAction[] = [...appActions, ...COMMANDS.map(commandAction)];
const actionById = new Map(ACTIONS.map((a) => [a.id, a]));

async function runAction(id: string, from?: HTMLElement) {
  await ready;
  if (id === "palette") return overview.open();
  const anchor = from?.getBoundingClientRect();
  if (id === "add-menu" && anchor) return togglePopover(id, anchor, () => listHtml(["add-data", "workspace", "open", "open-local", "sample", "sample-3d"]));
  if (id === "layout-menu" && anchor) return togglePopover(id, anchor, () => listHtml(["layout-stack", "layout-columns", "layout-grid", "layout-focus"]));
  if (id === "group-menu" && anchor) return togglePopover(id, anchor, groupHtml);
  if (id === "settings-menu" && anchor) return togglePopover(id, anchor, settingsHtml);
  if (id === "export-menu" && anchor) return togglePopover(id, anchor, () => listHtml(["save", "export-all", "export-notes"]), false, true);
  const a = actionById.get(id);
  if (a?.enabled()) await a.run();
}

/** The images a step applies to: just this one, or its whole group when the group shares steps. */
function stepTargets(doc: Doc): Doc[] {
  return ws.groupOf(doc)?.sync.steps ? [doc, ...ws.peers(doc)] : [doc];
}

/** Runs an image command on the active image, asking for parameters first if it has any. */
async function runCommand(cmd: Command) {
  const doc = ws.active;
  if (!doc) return;
  if (cmd.id === "convert-to-mask") return thresholdDialog(analysisCtx, doc);
  let params: Params = cmd.id === "set-scale" ? setScaleInitial(doc, lastParams.get(cmd.id)) : (lastParams.get(cmd.id) ?? defaultParams(cmd));
  if (Object.keys(cmd.params).length) {
    const chosen = await paramsDialog(cmd, params, {
      validate: (p) => {
        try {
          parseParams(cmd, p);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    });
    if (!chosen) return;
    params = chosen;
  }
  lastParams.set(cmd.id, params);
  await applyCommand(doc, cmd, params);
}

/** Applies a command as a step on `doc`, and on its group when the group shares steps. */
async function applyCommand(doc: Doc, cmd: Command, params: Params) {
  const targets = stepTargets(doc);
  await run(cmd.title.replace(/…$/, ""), () => {
    for (const d of targets) d.timeline.apply(cmd.id, params);
  });
  if (targets.length > 1) notify(`${cmd.title.replace(/…$/, "")} applied to all ${targets.length} images in ${ws.groupOf(doc)!.name}`);
}

/**
 * The top bar holds only what is app-wide: adding images, arranging and
 * grouping windows, plugins, finding things and switching images.
 * Everything that acts on one image (undo, processing, saving, controls)
 * lives on that image's window and its ⋯ menu.
 */
function buildToolbar() {
  const text = (id: string, ic: string, label: string, opts: { shortcut?: string; menu?: boolean } = {}) =>
    `<button class="tb-text" data-action="${id}" title="${escapeHtml(label)}${opts.shortcut ? ` (${formatShortcut(opts.shortcut)})` : ""}"${opts.menu ? ' aria-haspopup="menu"' : ""}>${icon(ic, 16)}<span>${escapeHtml(label)}</span>${opts.menu ? '<span class="caret">▾</span>' : ""}</button>`;
  $("toolbar").innerHTML = `
    <div class="tb-left"><span class="brand"><span class="brand-mark" aria-hidden="true"></span><span>PHAROS</span></span></div>
    <nav class="tb-center" aria-label="Workspace">
      ${text("workspace", "panel", "Workspace")}
      ${text("library", "plug", "Library")}
      ${text("add-menu", "add", "Add data", { menu: true })}
      ${text("layout-menu", "layout", "Layout", { menu: true })}
      ${text("group-menu", "link", "Group", { menu: true })}
      ${text("results", "table", "Results")}
      ${text("overview", "overview", "Overview", { shortcut: "Tab" })}
    </nav>
    <div class="tb-right">
      <button class="tb-text sys-status" data-action="storage" hidden><span class="dot" aria-hidden="true"></span><span class="sys-text"></span></button>
      <button class="tb-text jobs-btn" data-action="jobs" title="Jobs" hidden>${icon("batch", 16)}<span>Jobs</span><span class="badge" hidden></span></button>
      ${text("settings-menu", "settings", "Settings", { menu: true })}
    </div>`;

  // search lives in the bottom-right corner, out of the way of the work
  const dock = document.createElement("button");
  dock.className = "search-dock";
  dock.dataset.action = "palette";
  dock.title = `Search commands and images (${formatShortcut("Mod+K")})`;
  dock.innerHTML = `${icon("search", 15)}<span>Search commands, images, or ask</span><kbd>${formatShortcut("Mod+K")}</kbd>`;
  document.body.append(dock);
}

/** The settings dropdown: appearance and the assistant. */
function settingsHtml() {
  const dark = document.documentElement.dataset.theme === "dark";
  return `<section>
      <label class="toggle-row">${icon("contrast", 16)}<span>Dark mode</span><input type="checkbox" data-theme-toggle ${dark ? "checked" : ""}/><span class="switch" aria-hidden="true"></span></label>
    </section>
    <section>${itemHtml("settings")}${itemHtml("library")}</section>
    <p class="pop-note">${server ? `Connected to the local Pharos ${escapeHtml(server.info.version)} server` : "Browser-only mode"}</p>`;
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
  if (!a || hiddenCommands.has(id)) return "";
  return `<button data-action="${a.id}" role="menuitem">${icon(a.icon, 16)}<span>${escapeHtml(a.title)}</span>${a.shortcut ? `<kbd>${formatShortcut(a.shortcut)}</kbd>` : ""}</button>`;
}

function listHtml(ids: string[]) {
  return `<section>${ids.map(itemHtml).join("")}</section>`;
}

/** Opens a popover under `anchor`, or closes it if the same one is already open. */
function togglePopover(key: string, anchor: DOMRect, html: () => string, wide = false, above = false) {
  if (!pop.hidden && popKey === key) return closePopover();
  popKey = key;
  pop.innerHTML = html();
  pop.classList.toggle("wide", wide);
  pop.hidden = false;
  updateEnabled();
  const r = pop.getBoundingClientRect();
  // under the anchor, kept on screen (menus from a window's right edge open leftwards)
  pop.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, anchor.left))}px`;
  pop.style.top = `${above ? Math.max(8, anchor.top - r.height - 6) : Math.min(innerHeight - r.height - 8, anchor.bottom + 6)}px`;
}

function closePopover() {
  pop.hidden = true;
  popKey = "";
}

document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (document.body.classList.contains("noting") && !t.closest(".notes, .win, .menu-pop, dialog")) setNoting(false);
  if (!pop.hidden && !pop.contains(t) && !t.closest('[aria-haspopup="menu"], [data-win="menu"], [data-win="group"]')) closePopover();
});

/** Everything you can do to one image, from its window's ⋯ button. */
function windowMenuHtml() {
  const cmds = (top: string) => COMMANDS.filter((c) => c.menu[0] === top).map((c) => c.id);
  const sections: [string, string[]][] = [
    ["Edit", ["undo", "redo", ...cmds("Edit")]],
    ["Process", cmds("Process")],
    ["Image", [...cmds("Image"), "threshold", "auto", "reset-range", "duplicate", "rename"]],
    ["Analyze", ["measure", "analyze-particles", ...cmds("Analyze"), "select-none", "clear-outlines", "results"]],
    ["Output", ["save", "batch"]],
    ["Window", ["controls", "history", "fit", "actual", "leave-group", "minimize", "close"]],
  ];
  return sections
    .map(([title, ids]) => {
      const rows = ids.map(itemHtml).join("");
      return rows ? `<section><h4>${title}</h4>${rows}</section>` : "";
    })
    .join("");
}

/** Groups: who is in each, what they share, and ways to make or leave one. */
function groupHtml() {
  const active = ws.active;
  const groups = ws.groups;
  const labels: [keyof import("./workspace.js").Group["sync"], string, string][] = [
    ["view", "Zoom and pan", "Move one, the others follow"],
    ["slice", "Slice and frame", "Step through stacks together"],
    ["contrast", "Contrast and channels", "Same display settings"],
    ["steps", "Processing steps", "A step applied to one is applied to all"],
  ];
  const list = groups
    .map((g) => {
      const members = ws.docs.filter((d) => d.group === g.id);
      return `<section class="group-card">
        <h4><span class="dot" style="background:${g.color}"></span>${escapeHtml(g.name)} <small>${members.length} images</small></h4>
        <p class="group-members">${members.map((d) => escapeHtml(d.name)).join(" · ")}</p>
        ${labels
          .map(
            ([key, label, hint]) =>
              `<label class="group-sync" title="${escapeHtml(hint)}"><input type="checkbox" data-group="${g.id}" data-sync="${key}" ${g.sync[key] ? "checked" : ""}/> <span>${label}</span><small>${hint}</small></label>`,
          )
          .join("")}
        <div class="group-actions">
          ${active && active.group !== g.id ? `<button class="chip" data-group-act="join" data-group="${g.id}">Add ${escapeHtml(active.name)}</button>` : ""}
          <button class="chip" data-group-act="ungroup" data-group="${g.id}">Ungroup</button>
        </div>
      </section>`;
    })
    .join("");
  const empty = groups.length ? "" : `<p class="group-empty">Group images to compare them: they can share zoom, slice, contrast and processing steps.</p>`;
  return `${list}${empty}<section>${itemHtml("group-visible")}${itemHtml("leave-group")}</section>`;
}

pop.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.sync) ws.setSync(input.dataset.group!, input.dataset.sync as never, input.checked);
  if ("themeToggle" in input.dataset) setDark(input.checked);
});

function setDark(dark: boolean) {
  applyTheme(dark ? "dark" : "light");
  // histograms read their colours from the theme when drawn
  for (const d of ws.docs) windows.renderDoc(d.id);
}
pop.addEventListener("click", (e) => {
  const dp = (e.target as HTMLElement).closest<HTMLElement>("[data-dp]");
  if (dp) {
    closePopover();
    void processes.menuClick(dp.dataset.dp!);
    return;
  }
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-group-act]");
  if (!b) return;
  const g = b.dataset.group!;
  if (b.dataset.groupAct === "join" && ws.active) ws.join(ws.active, g);
  if (b.dataset.groupAct === "ungroup") ws.ungroup(g);
  pop.innerHTML = groupHtml();
});

function groupVisible() {
  const docs = visibleDocs();
  const g = ws.createGroup(docs);
  if (!g) return;
  windows.arrange("columns");
  notify(`${g.name}: ${docs.length} images now share zoom, pan and slice. Change what they share from Group.`);
}

// ------------------------------------------------------------ grouped windows share controls

function followView(doc: Doc) {
  if (ws.groupOf(doc)?.sync.view) windows.follow(doc, ws.peers(doc));
}

function shareView(doc: Doc) {
  const g = ws.groupOf(doc);
  if (!g) return;
  const img = doc.timeline.current();
  for (const p of ws.peers(doc)) {
    const pi = p.timeline.current();
    let changed = false;
    if (g.sync.slice) {
      p.view.pos.z = Math.min(doc.view.pos.z, pi.shape.slices - 1);
      p.view.pos.t = Math.min(doc.view.pos.t, pi.shape.frames - 1);
      changed = true;
    }
    if (g.sync.contrast && pi.dtype === img.dtype && pi.shape.channels === img.shape.channels) {
      p.view.ranges = doc.view.ranges.map((r) => [...r] as [number, number]);
      p.view.hidden = [...doc.view.hidden];
      p.view.composite = doc.view.composite;
      p.view.pos.c = doc.view.pos.c;
      p.view.manualRange = true;
      changed = true;
    }
    if (changed) windows.renderDoc(p.id);
  }
}

// ------------------------------------------------------------ plugins

/** The library's built-in tools tab: every image command, with a switch to hide it from menus and search. */
const builtinTools = {
  html() {
    const byMenu = new Map<string, Command[]>();
    for (const c of COMMANDS) byMenu.set(c.menu.join(" › "), [...(byMenu.get(c.menu.join(" › ")) ?? []), c]);
    return `<section class="plugin">
       <header><strong>Image tools</strong><small>built in · ${COMMANDS.length} commands · run in the browser on open images</small></header>
       ${[...byMenu]
         .map(
           ([menu, cmds]) => `<p class="plugin-menu">${escapeHtml(menu)}</p>${cmds
             .map((c) => `<label class="plugin-cmd">${icon(c.icon, 16)}<span>${escapeHtml(c.title.replace(/…$/, ""))}<small>${escapeHtml(c.description)}</small></span><input type="checkbox" data-cmd="${c.id}" ${hiddenCommands.has(c.id) ? "" : "checked"} aria-label="Show ${escapeHtml(c.title)}"/></label>`)
             .join("")}`,
         )
         .join("")}
     </section>
     <p class="muted small">Unticked commands leave the menus and search. You can turn them back on here at any time.</p>`;
  },
  wire(el: HTMLElement) {
    el.querySelectorAll<HTMLInputElement>("input[data-cmd]").forEach((box) =>
      box.addEventListener("change", () => {
        if (box.checked) hiddenCommands.delete(box.dataset.cmd!);
        else hiddenCommands.add(box.dataset.cmd!);
        saveHidden();
        ws.touch();
      }),
    );
  },
};

function updateEnabled() {
  document.querySelectorAll<HTMLButtonElement>(".topbar [data-action], .menu-pop [data-action]").forEach((b) => {
    const a = actionById.get(b.dataset.action!);
    b.disabled = !!a && !a.enabled();
  });
}

// ------------------------------------------------------------ the desktop around the windows

/** Space taken by the toolbar, the notes column and the chat, which windows avoid. */
function insets() {
  const tb = $("toolbar").getBoundingClientRect();
  const notesEl = $("notes");
  // windows open beside the notes column when it is shown (wide screens)
  const column = getComputedStyle(notesEl).display !== "none" ? notesEl.getBoundingClientRect().right + 32 : 0;
  return {
    top: Math.max(16, tb.bottom + 14),
    left: Math.max(24, column),
    right: chat.isOpen ? innerWidth - chat.el.getBoundingClientRect().left + 16 : 24,
    bottom: 76, // clear of the search field in the bottom-right corner
  };
}

let lastSaved: Date | null = null;
/** A fingerprint of what a project file holds, to tell whether there are unsaved changes. */
let savedPrint: string | null = null;
let memoryWarned = false;

function statePrint(): string {
  const docs = ws.docs.map((d) => [d.name, d.timeline.marker, d.group ?? "", d.timeline.steps.map((s) => `${s.command}${JSON.stringify(s.params)}${s.enabled ? "" : "!"}`).join(",")].join(":"));
  const text = notes.data().lines.map((l) => l.map((seg) => (typeof seg === "string" ? seg : `@${seg.ref.id}`)).join(""));
  return JSON.stringify([notes.projectName, docs, ws.groups.map((g) => [g.name, g.sync]), text, results.data.rows.length, results.data.summary.length]);
}

/** The notes header line, and a warning if history memory runs high. */
function updateDesk() {
  const n = ws.docs.length;
  const changed = savedPrint !== null && savedPrint !== statePrint();
  const saved = lastSaved ? `saved ${lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${changed ? ", changed since" : ""}` : n ? "not saved yet" : "";
  notes.setStatus(["Project", n ? `${n} image${n > 1 ? "s" : ""}` : "", saved].filter(Boolean).join(" · "));
  // history keeps intermediate images in memory up to a budget, recomputing past it
  const bytes = ws.docs.reduce((sum, d) => sum + d.timeline.cachedBytes(), 0);
  const ratio = n ? bytes / (768 * 1024 ** 2 * n) : 0;
  if (ratio >= 0.9 && !memoryWarned) {
    memoryWarned = true;
    notify(`History memory is ${Math.round(ratio * 100)}% full (${(bytes / 1024 ** 2).toFixed(0)} MB). Older steps will be recomputed when you go back to them.`);
  } else if (ratio < 0.8) memoryWarned = false;
}

// ------------------------------------------------------------ notes: referencing windows as they look now

/** While the cursor is in the notes, clicking a window cites it. */
function setNoting(on: boolean) {
  document.body.classList.toggle("noting", on);
  if (!on) windows.clearNoted();
}

/** Captures a window's exact state for the notes. */
function snapshot(doc: Doc): Omit<NoteRef, "id" | "num"> {
  const img = doc.timeline.current();
  const t = doc.timeline;
  const applied = t.steps.slice(0, t.marker);
  const viewer = windows.viewerFor(doc.id);
  return {
    docId: doc.id,
    name: doc.name,
    time: Date.now(),
    marker: t.marker,
    steps: t.steps.length,
    stepIds: applied.map((s) => s.id),
    stepTitles: applied.filter((s) => s.enabled).map((s) => getCommand(s.command).title.replace(/…$/, "")),
    view: {
      pos: { ...doc.view.pos },
      slices: img.shape.slices,
      ranges: doc.view.ranges.map((r) => [...r] as [number, number]),
      composite: doc.view.composite,
      hidden: [...doc.view.hidden],
      zoom: doc.view.zoom,
      centre: viewer?.centre() ?? null,
      fitted: doc.view.fitted,
    },
    thumb: thumbnailElement(img, doc.view, 160).toDataURL("image/png"),
  };
}

/** Brings a window back to how it looked when it was referenced in the notes. */
function openRef(ref: NoteRef) {
  const doc = ws.get(ref.docId);
  if (!doc) return notify(`${ref.name} is no longer open.`);
  if (windows.isMinimized(doc.id)) windows.restore(doc.id);
  ws.activate(doc.id);
  const t = doc.timeline;
  const same = ref.stepIds.every((id, i) => t.steps[i]?.id === id);
  if (same) t.seek(ref.marker);
  else notify(`The history of ${doc.name} has changed since this note, so it shows as it is now.`);
  const img = t.current();
  doc.view.pos = { c: Math.min(ref.view.pos.c, img.shape.channels - 1), z: Math.min(ref.view.pos.z, img.shape.slices - 1), t: Math.min(ref.view.pos.t, img.shape.frames - 1) };
  if (ref.view.ranges.length === img.shape.channels) {
    doc.view.ranges = ref.view.ranges.map((r) => [...r] as [number, number]);
    doc.view.composite = ref.view.composite;
    doc.view.hidden = [...ref.view.hidden];
    doc.view.manualRange = true;
  }
  windows.renderDoc(doc.id);
  const viewer = windows.viewerFor(doc.id);
  if (ref.view.fitted || !ref.view.centre) viewer?.fit();
  else viewer?.lookAt(ref.view.centre, ref.view.zoom);
  ws.touch();
}

// ------------------------------------------------------------ projects: save, open, export

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

/**
 * Everything a project holds. `pathFor` names each source image (inside a
 * project file, or in the autosave); images branched from one another share
 * their source, which is stored once.
 */
function gatherProject(pathFor: (img: import("@pharos/core").Image) => string): { project: ProjectFile; sources: Map<string, import("@pharos/core").Image> } {
  const sources = new Map<string, import("@pharos/core").Image>();
  const docs: ProjectDoc[] = ws.docs.map((d) => {
    const source = pathFor(d.timeline.source);
    sources.set(source, d.timeline.source);
    const place = windows.placement(d.id);
    return {
      id: d.id,
      name: d.name,
      source,
      parent: d.parent,
      file: d.file,
      panels: d.panels,
      ui: d.ui,
      group: d.group,
      minimized: place?.minimized ?? false,
      rect: place?.rect ?? null,
      view: {
        pos: d.view.pos,
        ranges: d.view.ranges,
        composite: d.view.composite,
        hidden: d.view.hidden,
        manualRange: d.view.manualRange,
        fitted: d.view.fitted,
        zoom: d.view.zoom,
        centre: windows.viewerFor(d.id)?.centre() ?? null,
      },
      timeline: {
        steps: d.timeline.steps.map((s) => ({ command: s.command, params: s.params, enabled: s.enabled, origin: s.origin })),
        marker: d.timeline.marker,
      },
      roi: d.layers.roi,
    };
  });
  const project: ProjectFile = {
    format: "pharos-project",
    version: 1,
    saved: new Date().toISOString(),
    notes: notes.data(),
    groups: ws.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, sync: { ...g.sync } })),
    docs,
    results: results.data,
  };
  return { project, sources };
}

async function saveProject() {
  const names = new Map<unknown, string>();
  const { project, sources } = gatherProject((img) => {
    let n = names.get(img);
    if (!n) names.set(img, (n = `images/${names.size + 1}.tif`));
    return n;
  });
  const bytes = await run("Saving project", () => packProject(project, sources));
  if (!bytes) return;
  if (await deliver(bytes, `${slug(notes.projectName)}${PROJECT_EXT}`, "application/zip", "Save project")) {
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
  if (ws.docs.length && !(await confirmDialog("Open project?", `Opening ${filename} replaces the ${ws.docs.length} image${ws.docs.length > 1 ? "s" : ""} open now. Save first if you need them.`, "Open"))) return;
  const loaded = await run(`Opening ${filename}`, () => unpackProject(bytes));
  if (!loaded) return;
  await run("Restoring histories", () => {
    restoreProject(loaded.project, loaded.images);
    lastSaved = new Date(loaded.project.saved);
    savedPrint = statePrint();
    updateDesk();
  });
}

/**
 * Replaces the session with a project: re-runs each image's history (keeping
 * every step editable), then restores views, windows, groups and notes.
 * Returns the source path behind each new window's image.
 */
function restoreProject(project: ProjectFile, images: Map<string, import("@pharos/core").Image>): Map<string, string> {
  for (const d of [...ws.docs]) ws.close(d.id);
  const ids = new Map<string, string>();
  const sourceOf = new Map<string, string>();
  const named = new Map<string, import("@pharos/core").Image>();
  const skipped: string[] = [];
  for (const pd of project.docs) {
    // windows that shared a source keep sharing one image
    let img = named.get(pd.source);
    if (!img) named.set(pd.source, (img = { ...images.get(pd.source)!, name: pd.name }));
    const doc = ws.open(img, pd.file);
    ids.set(pd.id, doc.id);
    sourceOf.set(doc.id, pd.source);
    doc.name = pd.name;
    doc.panels = pd.panels ?? [];
    doc.ui = pd.ui ?? doc.ui;
    // re-run the history, keeping suppressed steps suppressed
    for (const st of pd.timeline.steps) {
      try {
        const step = doc.timeline.apply(st.command, st.params, st.origin);
        if (!st.enabled) doc.timeline.setEnabled(step.id, false);
      } catch (e) {
        skipped.push(`${pd.name}: ${st.command} (${e instanceof Error ? e.message : e})`);
      }
    }
    doc.timeline.seek(pd.timeline.marker);
    doc.layers.roi = pd.roi ?? null;
    Object.assign(doc.view, {
      pos: pd.view.pos,
      ranges: pd.view.ranges,
      composite: pd.view.composite,
      hidden: pd.view.hidden,
      manualRange: pd.view.manualRange,
      fitted: pd.view.fitted,
    });
  }
  for (const pd of project.docs) {
    const doc = ws.get(ids.get(pd.id)!)!;
    if (pd.parent) (doc as { parent?: Doc["parent"] }).parent = { ...pd.parent, id: ids.get(pd.parent.id) ?? pd.parent.id };
  }
  for (const g of project.groups) {
    const members = project.docs.filter((pd) => pd.group === g.id).map((pd) => ws.get(ids.get(pd.id)!)!);
    const made = ws.createGroup(members);
    if (made) Object.assign(made, { name: g.name, color: g.color, sync: { ...g.sync } });
  }
  ws.touch();
  for (const pd of project.docs) {
    const id = ids.get(pd.id)!;
    windows.restorePlacement(id, pd.rect, pd.minimized);
    windows.renderDoc(id);
    const viewer = windows.viewerFor(id);
    if (!pd.view.fitted && pd.view.centre) viewer?.lookAt(pd.view.centre, pd.view.zoom);
  }
  notes.load(project.notes, ids);
  results.load(project.results && { ...project.results, rows: project.results.rows.map((r) => ({ ...r, doc: ids.get(r.doc) ?? r.doc })) });
  ws.touch();
  if (skipped.length) void alertDialog("Some steps were skipped", skipped.join("\n"));
  return sourceOf;
}

// ------------------------------------------------------------ autosave: survive a refresh

const autosave = new Autosave();
/** False until the previous session has been restored, so an empty start never overwrites it. */
let autosaveReady = false;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosavedPrint = "";

function scheduleAutosave() {
  if (!autosaveReady) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void autosaveNow(), 1200);
}

async function autosaveNow() {
  if (!autosaveReady) return;
  try {
    const { project, sources } = gatherProject(autosave.pathFor);
    // skip if nothing a session holds has changed
    const print = JSON.stringify({ ...project, saved: "" });
    if (print === autosavedPrint) return;
    await autosave.save(project, sources, { lastSaved: lastSaved?.toISOString() ?? null, unsaved: savedPrint !== statePrint() });
    autosavedPrint = print;
  } catch (e) {
    console.warn("Pharos: autosave failed", e);
  }
}

/** Brings back the last session from this browser, if there is one. */
async function restoreSession() {
  try {
    const session = await autosave.load();
    if (!session || (!session.project.docs.length && !session.project.notes.lines?.length && session.project.notes.name === "Untitled project")) return;
    const sourceOf = restoreProject(session.project, session.images);
    for (const [docId, key] of sourceOf) autosave.adopt(ws.get(docId)!.timeline.source, key);
    lastSaved = session.meta.lastSaved ? new Date(session.meta.lastSaved) : null;
    savedPrint = lastSaved ? (session.meta.unsaved ? "" : statePrint()) : null;
    updateDesk();
    const n = session.project.docs.length;
    notify(n ? `Restored your last session: ${n} image${n > 1 ? "s" : ""} and notes` : "Restored your notes");
  } catch (e) {
    console.warn("Pharos: could not restore the last session", e);
    notify("Could not restore the last session");
  }
}

async function exportAllTiffs() {
  const bytes = await run("Exporting images", () => packTiffs(ws.docs.map((d) => ({ name: d.name, image: d.timeline.current() }))));
  if (bytes) await deliver(bytes, `${slug(notes.projectName)}-images.zip`, "application/zip", "Export images");
}

async function exportNotes() {
  await deliver(new TextEncoder().encode(notes.markdown()), `${slug(notes.projectName)}-notes.md`, "text/markdown", "Export notes");
}

// ------------------------------------------------------------ syncing everything with the workspace

function refresh() {
  updateDesk();
  scheduleAutosave();
  windows.sync();
  $("welcome").hidden = ws.docs.length > 0 || ws.dataDocs.length > 0;
  updateEnabled();
}

function activeViewer() {
  return ws.active ? windows.viewerFor(ws.active.id) : undefined;
}

function adjustRange(how: "auto" | "reset") {
  const doc = ws.active;
  if (!doc) return;
  const img = doc.timeline.current();
  const { c, z, t } = doc.view.pos;
  const plane = getPlane(img, c, z, t);
  doc.view.ranges[c] = how === "auto" ? autoContrast(plane) : img.dtype === "uint8" ? [0, 255] : minMax(plane);
  doc.view.manualRange = true;
  windows.renderActive();
  if (how === "auto") notify("Auto contrast: display only, pixel values unchanged");
}

// ------------------------------------------------------------ documents: open, save, close, branch

async function openBytes(bytes: ArrayBuffer, name: string, file: Doc["file"]) {
  const img = await run(`Opening ${name}`, () => readTiff(bytes, name));
  if (img) ws.open(img, file);
}

/** Opens dropped or picked files as windows; reports the ones that are not TIFFs. */
async function openFiles(files: File[]) {
  const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXT));
  if (project) return openProject(new Uint8Array(await project.arrayBuffer()), project.name);
  const tiffs = files.filter((f) => /\.tiff?$/i.test(f.name) || f.type === "image/tiff");
  const others = files.filter((f) => !tiffs.includes(f));
  for (const f of tiffs) await openBytes(await f.arrayBuffer(), f.name, null);
  if (others.length) void alertDialog("Not opened", `Pharos opens TIFF files for now. Skipped:\n${others.map((f) => `• ${f.name}`).join("\n")}`);
}

function openFromComputer() {
  const input = $<HTMLInputElement>("file-input");
  input.value = "";
  input.onchange = () => void openFiles([...(input.files ?? [])]);
  input.click();
}

async function openDialog() {
  if (!server) return openFromComputer();
  const path = await browseDialog(server, { title: "Open image", pickFolder: false, start: lastDir });
  if (!path) return;
  const sep = server.info.separator;
  const name = path.slice(path.lastIndexOf(sep) + 1);
  lastDir = path.slice(0, path.lastIndexOf(sep)) || sep;
  const bytes = await run(`Reading ${name}`, () => server!.read(path));
  if (bytes) await openBytes(bytes, name, { dir: lastDir, name });
}

async function openSample(volume: boolean) {
  const img = await run(volume ? "Building 3D sample" : "Building sample", () => (volume ? sampleVolume() : sampleCells()));
  if (!img) return;
  const doc = ws.open(img);
  if (!volume) return;
  // start a volume in the middle of the stack, where the cells are
  doc.view.pos.z = Math.floor(img.shape.slices / 2);
  resetRanges(doc.view, img);
  windows.renderActive();
  ws.touch();
}

async function save() {
  const doc = ws.active;
  if (!doc) return;
  const img = doc.timeline.current();
  const bytes = writeTiff({ ...img, name: doc.name });
  const suggested = doc.name.replace(/\.tiff?$/i, "") + (doc.timeline.marker ? "-pharos" : "") + ".tif";
  if (!server) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/tiff" }));
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return notify(`Downloaded ${suggested}`);
  }
  const sep = server.info.separator;
  const dir = lastSaveDir ?? downloadsDir();
  const path = await promptDialog("Save as TIFF", "File path", dir.replace(/[/\\]$/, "") + sep + suggested);
  if (!path) return;
  try {
    await server.write(path, bytes);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("already exists"))) throw e;
    if (!(await confirmDialog("Replace file?", `${path} already exists. Replace it?`, "Replace"))) return;
    await server.write(path, bytes, true);
  }
  lastSaveDir = path.slice(0, path.lastIndexOf(sep)) || sep;
  notify(`Saved ${path}`);
}

async function closeDoc(doc: Doc) {
  const n = doc.timeline.steps.length;
  if (n && !(await confirmDialog(`Close ${doc.name}?`, `Its history has ${n} step${n > 1 ? "s" : ""}, which will be lost. Save first if you need the result.`, "Close"))) return;
  ws.close(doc.id);
}

async function renameActive() {
  const doc = ws.active;
  if (!doc) return;
  const name = await promptDialog("Rename image", "Name", doc.name);
  if (name) ws.rename(doc.id, name);
}

function branch(doc: Doc, step: number) {
  const child = ws.branch(doc, step);
  notify(`Opened ${child.name} at step ${step}; its steps stay editable`);
}

function copyStep(target: Doc, payload: StepPayload) {
  const cmd = getCommand(payload.command);
  ws.activate(target.id);
  void run(`Adding ${cmd.title.replace(/…$/, "")} to ${target.name}`, () => target.timeline.apply(payload.command, payload.params));
}

// ------------------------------------------------------------ workspace: data on disk, opened by its viewer

/** Opens an artifact in a data window of its own (or brings its window forward). */
function openArtifact(_s: LocalServer, a: Artifact, workspace: string) {
  ws.openData(a, workspace);
  return Promise.resolve();
}

async function openWorkspace() {
  const s = server;
  if (!s) return alertDialog("Workspace", "Workspaces keep your data on disk, so they need the local Pharos server. Start it with `npx pharos-lab`.");
  try {
    await workspacePanel(s, {
      notify,
      open: (a, workspace) => openArtifact(s, a, workspace),
      run: async (a, workspace) => {
        ws.openData(a, workspace);
      },
      find: (data, workspace) => openLibrary({ workspace, artifacts: data }),
      ask: (data, workspace) => askAssistant(s, workspace, data),
    });
  } catch (e) {
    void alertDialog("Workspace", e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------ books: library, plans, the assistant's proposals

const processes: DataProcesses = new DataProcesses(ws, {
  server: () => server,
  notify,
  busy: (label, fn) => run(label, fn),
  openImage: (image) => ws.open(image),
  shownImage: (doc): import("@pharos/core").Image | null => windows.dataView(doc.id)?.shownImage()?.image ?? null,
  shownArtifact: (doc): Promise<Artifact | null> => windows.dataView(doc.id)?.shownArtifact() ?? Promise.resolve(null),
});

async function dataMenu(doc: DataDoc, anchor: DOMRect) {
  const html = await processes.menuHtml(doc);
  togglePopover(`data:${doc.id}`, anchor, () => html);
}

async function openLibrary(data?: { workspace: string; artifacts: Artifact[]; text?: string }, tab?: LibraryTab) {
  const s = server;
  try {
    await libraryPanel(
      s,
      {
        notify,
        gpu: () => !!lastStatus?.gpu.available,
        tools: builtinTools,
        usePlan: async (book) => {
          // a recipe applies to a dataset: its window, or the active one
          const doc = data?.artifacts[0] ? ws.openData(data.artifacts[0], data.workspace) : ws.activeData;
          if (!doc) return notify("Open your data first (Workspace, or drop it in), then choose this recipe from its window's ⋯ menu.");
          await processes.useBook(doc, book.id);
        },
      },
      data,
      tab,
    );
  } catch (e) {
    void alertDialog("Library", e instanceof Error ? e.message : String(e));
  }
}

async function askAssistant(s: LocalServer, workspace: string, data: Artifact[], question?: string) {
  const problem = aiUnavailable();
  if (problem) return alertDialog("Assistant", problem);
  const names = data.map((a) => a.name ?? a.id.slice(0, 8)).join(", ");
  const text = question ?? (await promptDialog("Ask the assistant", `What do you want to do with ${names}?`, ""));
  if (!text) return;
  const r = await run("The assistant is choosing a book", () => s.assistantPlan(workspace, text, data.map((a) => a.id)));
  if (!r) return;
  if (r.plan) {
    const plan = r.plan;
    const source = data.find((a) => Object.values(plan.inputs).includes(a.id)) ?? data[0];
    try {
      await processes.fromPlan(plan, source);
    } catch (e) {
      void alertDialog("Assistant", e instanceof Error ? e.message : String(e));
    }
  }
  else void alertDialog("Assistant", `${r.message}${r.matches.some((m) => m.tier !== "excluded") ? "" : "\n\nNo installed book can run on this data."}`);
}

// ------------------------------------------------------------ data first: add data, examples, the problem statement

/** The optional problem statement on the start screen. */
const problemText = () => $<HTMLTextAreaElement>("problem").value.trim();

/**
 * What happens once data is in the workspace: with a problem statement (and
 * the assistant set up) the assistant proposes a plan; otherwise the library
 * shows the books that can run on the data, ranked by the statement's words.
 */
async function dataFlow(workspace: string, artifacts: Artifact[]) {
  const s = server;
  if (!s || !artifacts.length) return;
  for (const a of artifacts) ws.openData(a, workspace);
  const text = problemText();
  if (text && !aiUnavailable()) return askAssistant(s, workspace, artifacts, text);
  if (text && aiConfig && !aiConfig.keySource) notify("Add an API key in Settings and the assistant will propose the steps; for now, pick a suggestion in the window or its ⋯ menu.");
}

/** Add data: a file or folder on this computer into the workspace (or, without the server, open TIFFs to view). */
async function addData() {
  const s = server;
  if (!s) return openFromComputer();
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

/** Dropped files go into the workspace; projects still open as projects. */
async function dropData(files: File[], folders: string[]) {
  const s = server;
  if (!s) return openFiles(files);
  const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXT));
  if (project) return openFiles([project]);
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

async function showExamples(s: LocalServer) {
  const examples = await s.examples().catch(() => []);
  const list = $("example-list");
  list.innerHTML = examples
    .map(
      (e) => `<button class="example" data-example="${escapeHtml(e.id)}">
        <small class="eyebrow">${escapeHtml(e.kind)}</small><strong>${escapeHtml(e.title)}</strong>
        <span>${escapeHtml(e.description)}</span><em>“${escapeHtml(e.prompt)}”</em></button>`,
    )
    .join("");
  $("examples").hidden = !examples.length;
  list.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((b) =>
    b.addEventListener("click", async () => {
      const e = examples.find((x) => x.id === b.dataset.example)!;
      const workspace = currentWorkspace();
      const added = await run(`Loading ${e.title}`, () => s.loadExample(e.id, workspace));
      if (!added) return;
      $<HTMLTextAreaElement>("problem").value = e.prompt;
      await dataFlow(workspace, added);
    }),
  );
}

/** A new, empty project: windows, notes and results go; data on disk and the library stay. */
async function clearProject() {
  if (!(await confirmDialog("New project", "Close every window and clear the notes and results? Your data on disk, the workspace and the library are kept.", "Clear"))) return;
  for (const d of [...ws.docs]) ws.close(d.id);
  for (const d of [...ws.dataDocs]) ws.close(d.id);
  notes.load({ name: "", lines: [] }, new Map());
  results.load(undefined);
  $<HTMLTextAreaElement>("problem").value = "";
  ws.touch();
  await autosaveNow();
  notify("Started a new project");
}

// ------------------------------------------------------------ ships: system status, jobs, storage

let lastStatus: SystemStatus | null = null;

function showStatus(status: SystemStatus | null) {
  lastStatus = status ?? lastStatus;
  const el = document.querySelector<HTMLElement>(".sys-status");
  if (!el) return;
  const chip = statusChip(status);
  el.hidden = false;
  el.dataset.tone = chip.tone;
  el.title = `${chip.title} Click for ships and storage.`;
  el.querySelector(".sys-text")!.textContent = chip.text;
}

async function openStorage() {
  if (!server) return;
  try {
    await storageDialog(server, notify);
  } catch (e) {
    void alertDialog("Ships and storage", e instanceof Error ? e.message : String(e));
  }
}

/** Opens a job's or plan's output in its viewer. */
function openOutput(workspace: string, id: string) {
  const s = server;
  if (!s) return;
  void s
    .artifact(workspace, id)
    .then((a) => openArtifact(s, a, workspace))
    .catch((e: unknown) => notify(e instanceof Error ? e.message : String(e)));
}

const jobsPanel = new JobsPanel({
  cancel: (id) => server!.cancelJob(id),
  rerun: (id) => server!.rerunJob(id),
  log: async (id) => (await server!.job(id)).log,
  openOutput,
  onActive: (count) => {
    const badge = document.querySelector<HTMLElement>(".jobs-btn .badge");
    if (!badge) return;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  },
  notify,
});

/** Follows the server's jobs, downloads and status for as long as the page is open. */
async function connectShips(s: LocalServer) {
  document.querySelector<HTMLElement>(".jobs-btn")!.hidden = false;
  showStatus(null);
  s.events((e) => {
    jobsPanel.handle(e);
    processes.handle(e);
    if (e.type === "status") showStatus(e.status);
  });
  const [status, jobs] = await Promise.all([s.status().catch(() => null), s.jobs().catch(() => [])]);
  showStatus(status);
  jobsPanel.load(jobs);
}

// ------------------------------------------------------------ batch

async function batchDialog(doc: Doc) {
  const s = server;
  if (!s) return alertDialog("Run on a folder", "Running on a folder needs the local Pharos server. Start it with `npx pharos`.");
  const recipe = doc.timeline.recipe();
  if (!recipe.steps.length) return alertDialog("Run on a folder", "Apply some steps to this image first; they then run on every TIFF in a folder.");
  const input = await browseDialog(s, { title: "Run on a folder: choose the input folder", pickFolder: true, start: lastDir });
  if (!input) return;
  const list = recipe.steps
    .map((st) => {
      const cmd = getCommand(st.command);
      const summary = cmd.summary?.(st.params);
      return `<li>${icon(cmd.icon, 16)} ${escapeHtml(cmd.title.replace(/…$/, ""))}${summary ? ` <small class="muted">${escapeHtml(summary)}</small>` : ""}</li>`;
    })
    .join("");
  const output = await showDialog<string | null>(
    `<form method="dialog"><p class="eyebrow">Batch</p><h2>Run on a folder</h2>
      <p class="muted">Every TIFF in <code>${escapeHtml(input)}</code> gets these steps from <strong>${escapeHtml(doc.name)}</strong>, on this computer:</p>
      <ol class="recipe">${list}</ol>
      <label class="field">Output folder<input name="output" value="${escapeHtml(input.replace(/[/\\]$/, "") + s.info.separator + "processed")}" /></label>
      <footer><button type="button" data-cancel>Cancel</button><button class="primary">Run</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        done((form.elements.namedItem("output") as HTMLInputElement).value.trim() || null);
      });
    },
    null,
  );
  if (!output) return;
  const result = await run("Running on folder", () => s.batch({ input, output, steps: recipe.steps }));
  if (!result) return;
  const total = result.processed.reduce((a, p) => a + p.ms, 0);
  const failed = result.failed.map((f) => `\n• ${f.file}: ${f.error}`).join("");
  await alertDialog("Folder done", `Processed ${result.processed.length} file(s) in ${total} ms into ${output}.${result.failed.length ? `\n${result.failed.length} failed:${failed}` : ""}`);
}

// ------------------------------------------------------------ assistant and settings

function aiUnavailable(): string | null {
  if (!server) return "The assistant needs the local Pharos server (run `npx pharos`).";
  if (!aiConfig) return "Assistant settings are unavailable.";
  if (!aiConfig.keySource) return "Add an Anthropic API key in Settings to use the assistant.";
  return null;
}

function aiContext() {
  const doc = ws.active;
  const img = doc?.timeline.current();
  return {
    image: img && { name: doc!.name, dtype: img.dtype, ...img.shape, unit: img.calibration.unit, pixelWidth: img.calibration.pixelWidth },
    steps: doc?.timeline.steps.slice(0, doc.timeline.marker).map((s) => ({ command: s.command, params: s.params, enabled: s.enabled })),
    shortcuts: ACTIONS.filter((a) => a.shortcut).map((a) => ({ title: a.title.replace(/…$/, ""), shortcut: formatShortcut(a.shortcut!) })),
  };
}

async function applySteps(doc: Doc | null, steps: ChatReply["steps"], origin: "user" | "ai") {
  if (!doc || !steps.length) return;
  const targets = stepTargets(doc);
  await run(origin === "ai" ? "Applying suggested steps" : "Applying", () => {
    for (const d of targets) for (const s of steps) d.timeline.apply(s.command, s.params, origin);
  });
  if (targets.length > 1) notify(`Applied to all ${targets.length} images in ${ws.groupOf(doc)!.name}`);
}

async function settingsDialog() {
  await ready;
  if (server) aiConfig = await server.aiConfig().catch(() => aiConfig);
  const cfg = aiConfig;
  const keyStatus = !cfg?.keySource ? "No key set" : cfg.keySource === "settings" ? `Saved key ${cfg.keyHint ?? ""}` : "Using ANTHROPIC_API_KEY from the environment";
  const connection = server
    ? `Connected to the Pharos ${server.info.version} server on this computer (${server.info.platform}${server.info.capabilities.python.available ? ", Python ready" : ""}).`
    : "Browser-only mode: files open from your computer and save as downloads. Run `npx pharos` for folders, batch and the assistant.";
  const body = !server
    ? `<p class="muted">The assistant runs through the local Pharos server, so it is not available in browser-only mode.</p><footer><button class="primary" data-cancel>Close</button></footer>`
    : `<form method="dialog">
        <p class="muted">Ask for things like “denoise this and rotate it upright”, or for controls suited to your task. It proposes; nothing runs until you apply it. It sees image size, type and your steps, never the pixels.</p>
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
}

// ------------------------------------------------------------ wiring

const notes = new Notes($("notes"), {
  openRef,
  setNoting,
  doneCiting: () => windows.clearNoted(),
  changed: () => {
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
    addProcess: (doc, anchor) => void dataMenu(doc, anchor),
    approve: (doc) => processes.approve(doc),
    rerun: (doc) => processes.rerun(doc),
    cancel: (doc) => processes.cancel(doc),
    updateStep: (doc, i, params) => processes.updateStep(doc, i, params),
    removeStep: (doc, i) => processes.removeStep(doc, i),
    apply: (doc, s) => void processes.apply(doc, s),
    suggestions: (doc, a): Promise<Suggestion[]> => processes.suggestions(doc, a),
    stepSpec: (r) => processes.stepSpec(r),
    openSeparately: (doc, a) => processes.openSeparately(doc, a),
    openAsImage: (_a, image) => ws.open(image),
  },
  addToNotes: (doc) => notes.cite(snapshot(doc)),
  roiChanged: (doc) => {
    ws.activate(doc.id);
    updateEnabled();
    scheduleAutosave();
  },
  viewChanged: followView,
  viewEdited: shareView,
  windowMenu: (doc, anchor) => {
    ws.activate(doc.id);
    togglePopover(`win-${doc.id}`, anchor, windowMenuHtml, true);
  },
  groupMenu: (anchor) => togglePopover("group-menu", anchor, groupHtml),
  copyStep,
  dtypeLabel,
  insets,
  expandArea: () => {
    const top = $("toolbar").getBoundingClientRect().bottom;
    return { x: 0, y: top, w: innerWidth, h: innerHeight - top };
  },
  timeline: {
    run: async (label, fn) => {
      await run(label, fn);
    },
    branch,
    batch: (doc) => void batchDialog(doc),
  },
  controls: {
    applyStep: (doc, command, params) => applySteps(doc, [{ command, params }], "user"),
    suggest: (doc, request) => {
      ws.activate(doc.id);
      chat.open(request ? `Suggest a control interface for this: ${request}` : "Suggest a control interface for what I am doing with this image.");
    },
    removePanel: (doc, i) => {
      doc.panels.splice(i, 1);
      ws.touch();
    },
    dtypeLabel,
    measurements: (doc) => results.forDoc(doc.id),
    summaries: (doc) => results.summariesFor(doc.id),
    showRow: (row) => results.hooks.showRow(row),
    openResults: (doc) => results.open(doc.id),
    removeRow: (row) => results.remove(row),
  },
});

const results = new Results({
  docs: () => ws.docs.map((d) => ({ id: d.id, name: d.name })),
  showRow: (row) => {
    const doc = ws.get(row.doc);
    if (!doc) return notify(`${row.image} is no longer open.`);
    if (windows.isMinimized(doc.id)) windows.restore(doc.id);
    ws.activate(doc.id);
    const img = doc.timeline.current();
    // go to the slice the row was measured on
    const m = { c: /c(\d+)/.exec(row.slice), z: /z(\d+)/.exec(row.slice), t: /t(\d+)/.exec(row.slice) };
    const at = (k: "c" | "z" | "t", n: number) => Math.min(n - 1, m[k] ? Number(m[k]![1]) - 1 : doc.view.pos[k]);
    doc.view.pos = { c: at("c", img.shape.channels), z: at("z", img.shape.slices), t: at("t", img.shape.frames) };
    setRoi(doc, row.roi);
  },
  save: (text, filename) => void deliver(new TextEncoder().encode(text), `${slug(notes.projectName)}-${filename}`, "text/csv", `Save ${filename}`),
  changed: () => {
    ws.touch();
    scheduleAutosave();
  },
});

/** Opens Results on `doc`'s measurements if it has any, otherwise on every image's. */
function openResults(doc: Doc | null) {
  results.open(doc && (results.forDoc(doc.id).length || results.summariesFor(doc.id).length) ? doc.id : undefined);
}

/** Sets a window's selection from outside its canvas (Results rows, Select all/none). */
function setRoi(doc: Doc, roi: import("@pharos/core").Roi | null) {
  doc.layers.roi = roi;
  windows.renderDoc(doc.id);
  updateEnabled();
  scheduleAutosave();
}

const analysisCtx = {
  ws,
  results,
  lastParams,
  notify,
  render: (doc: Doc) => windows.renderDoc(doc.id),
  apply: (doc: Doc, command: string, params: Params) => applyCommand(doc, getCommand(command), params),
};

const chat = new Chat({
  unavailable: aiUnavailable,
  send: (req) => server!.chat({ ...req, context: aiContext() }),
  applySteps: (steps) => applySteps(ws.active, steps, "ai"),
  openCommand: (id) => void runCommand(getCommand(id)),
  openSettings: () => void settingsDialog(),
  hasImage: () => !!ws.active,
  pinControls: (controls) => {
    const doc = ws.active;
    if (!doc) return null;
    doc.panels.push({ ...controls });
    if (!doc.ui.controls) windows.toggleControls(doc.id);
    else ws.touch();
    return doc.name;
  },
});

const overview = new Overview({
  workspace: ws,
  windows,
  actions: () => ACTIONS.filter((a) => !hiddenCommands.has(a.id)),
  ask: (q) => chat.open(q),
  aiUnavailable,
  closeDoc: (doc) => void closeDoc(doc),
  openFiles: (files) => void openFiles(files),
  dtypeLabel,
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
  if (isDialogOpen() || overview.isOpen || results.isOpen) return;
  const target = e.target as HTMLElement;
  const typing = target.matches("input, select, textarea") || target.isContentEditable;
  if (matchesShortcut(e, "Mod+K")) {
    e.preventDefault();
    return void overview.open();
  }
  if (e.key === "Escape") {
    if (document.body.classList.contains("noting")) {
      (document.activeElement as HTMLElement | null)?.blur();
      return setNoting(false);
    }
    if (!pop.hidden) return closePopover();
    if (chat.isOpen) return chat.close();
  }
  if (typing) return;
  // Tab shows every open image (like Mission Control) unless focus is on a control,
  // so keyboard navigation between buttons keeps working
  const onControl = target !== document.body && !!target.closest("button, a, [tabindex]");
  if ((e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !onControl) || e.key === "F3") {
    e.preventDefault();
    return void overview.open();
  }
  if (target.closest(".tl-marker")) return; // the marker handles arrow keys itself
  for (const a of ACTIONS) {
    if (a.shortcut && a.shortcut !== "Tab" && matchesShortcut(e, a.shortcut)) {
      e.preventDefault();
      void runAction(a.id);
      return;
    }
  }
});

// drop files anywhere to open them as windows
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || overview.isOpen) return;
  dragDepth++;
  const n = e.dataTransfer!.items.length;
  $("drop-text").textContent = server ? (n > 1 ? `Drop to add ${n} files` : "Drop to add your data") : n > 1 ? `Drop to open ${n} images` : "Drop to open";
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
bar.querySelector('[data-action="export-menu"]')!.innerHTML = `${icon("upload", 15)}<span>Export</span><span class="caret">▴</span>`;
bar.querySelector('[data-action="clear-project"]')!.innerHTML = `${icon("new", 15)}<span>Clear</span>`;
$("drop-icon").innerHTML = icon("upload", 40);
document.querySelectorAll<HTMLElement>(".sample-icon").forEach((el) => (el.innerHTML = icon(el.dataset.icon!, 20)));
$("welcome-hint").innerHTML = `<kbd>Tab</kbd> shows every image · <kbd>${formatShortcut("Mod+K")}</kbd> finds any command · <kbd>${formatShortcut("Mod+J")}</kbd> asks the assistant`;
document.documentElement.classList.toggle("mac", isMac);
buildToolbar();
const showTool = (t: Tool) => document.querySelectorAll<HTMLElement>(".tool").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tool === t)));
onToolChange(showTool);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void autosaveNow();
});
refresh();

async function boot() {
  [kernels, server] = await Promise.all([loadKernels(fetch(wasmUrl)), LocalServer.connect()]);
  if (server) aiConfig = await server.aiConfig().catch(() => null);
  if (server) void connectShips(server);
  if (server) void showExamples(server);
  await restoreSession();
  autosaveReady = true;
  updateEnabled();
  if (!crossOriginIsolated) console.info("Pharos: not cross-origin isolated, so multithreading is unavailable");
}

/** Resolves once kernels are loaded and the server connection is settled. */
const ready = boot();

ready.catch((e) => {
  console.error(e);
  notify(`Failed to start: ${e instanceof Error ? e.message : e}`);
});
