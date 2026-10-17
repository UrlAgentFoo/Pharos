/** Modal dialogs built on <dialog>, including parameter dialogs generated from a command's spec. */
import type { Command, ParamSpec, Params } from "@pharos/core";
import type { DirEntry, LocalServer } from "./api.js";
import { icon } from "./icons.js";

const dialog = document.getElementById("dialog") as HTMLDialogElement;

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function isDialogOpen() {
  return dialog.open;
}

export function showDialog<T>(html: string, wire: (done: (v: T) => void, el: HTMLDialogElement) => void, cancelValue: T): Promise<T> {
  dialog.innerHTML = html;
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(v);
    };
    // "close" is dispatched after a delay, so a closed dialog's event can reach the next
    // dialog opened in its place; that one is open by then, so ignore the event
    dialog.onclose = () => {
      if (!dialog.open) done(cancelValue);
    };
    dialog.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => done(cancelValue)));
    wire(done, dialog);
    dialog.showModal();
  });
}

export function alertDialog(title: string, message: string) {
  return showDialog(`<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><footer><button class="primary" data-cancel>OK</button></footer>`, () => {}, undefined);
}

export function confirmDialog(title: string, message: string, ok = "OK") {
  return showDialog<boolean>(
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><footer><button data-cancel>Cancel</button><button class="primary" data-ok>${escapeHtml(ok)}</button></footer>`,
    (done, el) => el.querySelector("[data-ok]")!.addEventListener("click", () => done(true)),
    false,
  );
}

export function promptDialog(title: string, label: string, value: string) {
  return showDialog<string | null>(
    `<form method="dialog"><h2>${escapeHtml(title)}</h2><label class="field">${escapeHtml(label)}<input name="v" value="${escapeHtml(value)}" autofocus /></label>
     <footer><button type="button" data-cancel>Cancel</button><button class="primary">OK</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        done((form.elements.namedItem("v") as HTMLInputElement).value.trim() || null);
      });
    },
    null,
  );
}

/** Form fields for a command's parameters. Shared by dialogs and the timeline's step editor. */
export function paramFields(cmd: Command, values: Params): string {
  return Object.entries(cmd.params)
    .map(([key, spec]: [string, ParamSpec]) => {
      const v = values[key] ?? spec.default;
      const hint = spec.description ? ` title="${escapeHtml(spec.description)}"` : "";
      if (spec.type === "number") {
        const attrs = [spec.min !== undefined && `min="${spec.min}"`, spec.max !== undefined && `max="${spec.max}"`, `step="${spec.step ?? "any"}"`].filter(Boolean).join(" ");
        return `<label class="field"${hint}><span>${escapeHtml(spec.label)}${spec.unit ? ` <span class="muted">(${escapeHtml(spec.unit)})</span>` : ""}</span><input name="${key}" type="number" ${attrs} value="${v}" required /></label>`;
      }
      if (spec.type === "choice") {
        const opts = spec.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === v ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
        return `<label class="field"${hint}>${escapeHtml(spec.label)}<select name="${key}">${opts}</select></label>`;
      }
      return `<label class="check"${hint}><input name="${key}" type="checkbox"${v ? " checked" : ""} /> ${escapeHtml(spec.label)}</label>`;
    })
    .join("");
}

/** Reads values back from fields made by paramFields. */
export function readParamFields(cmd: Command, form: HTMLFormElement | HTMLElement): Params {
  const out: Params = {};
  for (const [key, spec] of Object.entries(cmd.params)) {
    const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`);
    if (!el) continue;
    out[key] = spec.type === "number" ? Number(el.value) : spec.type === "boolean" ? (el as HTMLInputElement).checked : el.value;
  }
  return out;
}

/** Asks for a command's parameters; resolves to the values, or null if cancelled. */
export function paramsDialog(cmd: Command, initial: Params, opts: { validate: (p: Params) => string | null }): Promise<Params | null> {
  return showDialog<Params | null>(
    `<form method="dialog"><h2 class="with-icon">${icon(cmd.icon, 20)} ${escapeHtml(cmd.title.replace(/…$/, ""))}</h2>
      <p class="muted">${escapeHtml(cmd.description)}</p>
      ${paramFields(cmd, initial)}
      <p class="error" hidden></p>
      <footer><button type="button" data-cancel>Cancel</button><button class="primary">Apply</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      const err = el.querySelector<HTMLElement>(".error")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const p = readParamFields(cmd, form);
        const problem = opts.validate(p);
        err.hidden = !problem;
        err.textContent = problem ?? "";
        if (!problem) done(p);
      });
      queueMicrotask(() => form.querySelector<HTMLInputElement>("input, select")?.select?.());
    },
    null,
  );
}

const isTiff = (e: DirEntry) => !e.isDir && /\.tiff?$/i.test(e.name);

/**
 * Server-side file browser. Resolves to the chosen file (or folder) path, or null.
 * `accept` picks which entries can be chosen (TIFF files by default); an
 * accepted folder, such as an OME-Zarr store, is chosen rather than opened.
 */
export function browseDialog(
  server: LocalServer,
  opts: {
    title: string;
    pickFolder: boolean;
    start?: string;
    accept?: (e: DirEntry) => boolean;
    empty?: string;
    /** Also offer "Use this folder", for data that is a folder (OpenFOAM cases); files stay choosable. */
    allowFolder?: boolean;
  },
): Promise<string | null> {
  const accept = opts.accept ?? isTiff;
  return showDialog<string | null>(
    `<h2>${escapeHtml(opts.title)}</h2>
     <div class="browser"><div class="crumbs"><button data-up title="Parent folder">↑</button><input class="path" spellcheck="false" /></div><ul class="entries"></ul></div>
     <footer>${opts.pickFolder || opts.allowFolder ? `<button class="${opts.pickFolder ? "primary" : ""}" data-choose>${opts.pickFolder ? "Choose this folder" : "Use this folder"}</button>` : ""}<button data-cancel>Cancel</button></footer>`,
    (done, el) => {
      const list = el.querySelector<HTMLUListElement>(".entries")!;
      const pathEl = el.querySelector<HTMLInputElement>(".path")!;
      let current = "";
      let parent = "";
      const go = async (path?: string) => {
        try {
          const r = await server.list(path);
          current = r.path;
          parent = r.parent;
          pathEl.value = r.path;
          const shown = r.entries.filter((e) => e.isDir || accept(e));
          const empty = opts.empty ?? (opts.pickFolder ? "No subfolders or TIFFs" : "No folders or TIFF files here");
          list.innerHTML = shown.length ? "" : `<li class="none">${escapeHtml(empty)}</li>`;
          for (const e of shown) list.append(entryItem(e));
        } catch (err) {
          list.innerHTML = `<li class="none">${escapeHtml(err instanceof Error ? err.message : String(err))}</li>`;
        }
      };
      const entryItem = (e: DirEntry) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        const browse = e.isDir && !accept(e);
        b.className = browse ? "dir" : "file";
        b.innerHTML = `<span>${icon(browse ? "open" : "image", 16)} ${escapeHtml(e.name)}</span>${e.isDir ? "" : `<small>${formatSize(e.size)}</small>`}`;
        b.addEventListener("click", () => (browse ? go(e.path) : opts.pickFolder ? undefined : done(e.path)));
        li.append(b);
        return li;
      };
      el.querySelector("[data-up]")!.addEventListener("click", () => go(parent));
      pathEl.addEventListener("keydown", (e) => e.key === "Enter" && go(pathEl.value));
      el.querySelector("[data-choose]")?.addEventListener("click", () => done(current));
      go(opts.start);
    },
    null,
  );
}
