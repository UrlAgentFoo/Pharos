/**
 * The books in the library. Each card shows what a person needs to choose
 * one: its name, how to use it (with what it can do, one button per
 * action), the files it accepts, and the ships it runs on, solid when
 * downloaded and faded when not. Ids, versions, trust and tags stay out of
 * sight. Opened from workspace data, books that fit it come first and
 * actions that can't run on it are disabled.
 */
import type { Artifact, BookCard, BookMatch, CatalogueEntry, LibraryIssue } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml, formatSize, promptDialog, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";

export interface LibraryHooks {
  /** Runs one of a book's actions on the data (or the active window). */
  usePlan(book: CatalogueEntry, action: string, inputs: Record<string, string>): Promise<void>;
  notify(text: string): void;
  gpu(): boolean;
}

type Choice =
  | { use: BookCard; action: string }
  | { guide: BookCard }
  | { test: BookCard }
  | { install: true }
  | { issues: true }
  | null;

function card(c: BookCard, match: BookMatch | undefined, withData: boolean, gpu: boolean): string {
  const e = c.entry;
  const noGpu = e.gpu === "required" && !gpu;
  const fits = (name: string) => !noGpu && (!withData || !!match?.actions.includes(name));
  const files = c.accepts.length
    ? c.accepts.map((a) => `<span class="${a.converted ? "converted" : ""}" title="${a.converted ? "Converted first" : "Read directly"}">${escapeHtml(a.title)}</span>`).join("")
    : `<span class="muted">No files: describe what you want</span>`;
  const ships = c.ships
    .map((s) => {
      const title = s.downloaded ? "Downloaded" : `Not downloaded yet${s.sizeBytes ? ` (${formatSize(s.sizeBytes)})` : ""}; it downloads the first time it's needed`;
      return `<li class="book-ship ${s.downloaded ? "on" : "off"}" title="${escapeHtml(title)}">${icon("ship", 13)}<span>${escapeHtml(s.id)}</span></li>`;
    })
    .join("");
  const blocked = noGpu || (withData && !match?.actions.length);
  return `<li class="book-card ${blocked ? "blocked" : ""}" data-book="${escapeHtml(e.id)}">
    <div class="book-top"><h3>${escapeHtml(e.title)}</h3>${withData && match?.actions.length ? `<small class="book-fit">${icon("check", 12)} Fits your data</small>` : ""}</div>
    <section><h4>How to use</h4><p>${escapeHtml(c.howToUse)}</p>
      <div class="book-actions">${c.actions
        .map((a) => `<button class="chip ${fits(a.name) ? "primary-chip" : ""}" data-use="${escapeHtml(e.id)}" data-action="${escapeHtml(a.name)}" ${fits(a.name) ? "" : "disabled"} title="${escapeHtml(a.summary ?? a.title)}">${escapeHtml(a.title)}</button>`)
        .join("")}</div></section>
    <section><h4>Accepted files</h4><p class="book-files">${files}</p></section>
    <section><h4>Ships</h4><ul class="book-ships">${ships}</ul>${noGpu ? `<p class="book-note">Needs an NVIDIA GPU, which this machine doesn't have.</p>` : ""}</section>
    <div class="book-more"><button class="link-btn" data-guide="${escapeHtml(e.id)}">Guide</button><button class="link-btn" data-test="${escapeHtml(e.id)}" title="Runs each action on the book's example data">Test</button></div>
  </li>`;
}

/**
 * Shows the library; with `data`, matched against that workspace data.
 * Loops until closed, so Install, Test and Guide come back to it.
 */
export async function libraryPanel(server: LocalServer, hooks: LibraryHooks, data?: { workspace: string; artifacts: Artifact[]; text?: string }) {
  let filter = "";
  const withData = !!data?.artifacts.length;
  for (;;) {
    const [cards, issues, matched] = await Promise.all([
      server.cards(),
      server.issues(),
      withData ? server.match(data!.workspace, data!.artifacts.map((a) => a.id), data!.text).then((r) => r.matches) : Promise.resolve(undefined),
    ]);
    const matchOf = (id: string) => matched?.find((m) => m.book.id === id);
    const order = matched ? matched.map((m) => cards.find((c) => c.entry.id === m.book.id)!).filter(Boolean) : cards;
    const errors = issues.filter((i) => i.problems.some((p) => p.severity === "error"));
    const choice = await showDialog<Choice>(
      `<p class="eyebrow">${withData ? `Books for ${escapeHtml(data!.artifacts.map((a) => a.name ?? a.id.slice(0, 8)).join(", "))}` : "Books"}</p>
       <div class="ws-head"><input type="search" class="lib-search" placeholder="Filter books" value="${escapeHtml(filter)}"/>
         <button class="chip" data-install>${icon("plus", 14)} Install…</button>
         ${issues.length ? `<button class="chip ${errors.length ? "warn-chip" : ""}" data-issues>${icon("warning", 14)} ${issues.length} with problems</button>` : ""}</div>
       <ul class="book-list">${order.map((c) => card(c, matchOf(c.entry.id), withData, hooks.gpu())).join("") || `<li class="muted">No books installed yet. Install one, or create one with <code>pharos book new</code>.</li>`}</ul>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      (done, el) => {
        el.classList.add("wide");
        const search = el.querySelector<HTMLInputElement>(".lib-search")!;
        const apply = () => {
          filter = search.value;
          const q = filter.toLowerCase();
          el.querySelectorAll<HTMLElement>(".book-card").forEach((c) => (c.hidden = !!q && !c.textContent!.toLowerCase().includes(q)));
        };
        search.addEventListener("input", apply);
        apply();
        const find = (id: string) => cards.find((c) => c.entry.id === id)!;
        el.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((b) => b.addEventListener("click", () => done({ use: find(b.dataset.use!), action: b.dataset.action! })));
        el.querySelectorAll<HTMLButtonElement>("[data-guide]").forEach((b) => b.addEventListener("click", () => done({ guide: find(b.dataset.guide!) })));
        el.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => b.addEventListener("click", () => done({ test: find(b.dataset.test!) })));
        el.querySelector("[data-install]")!.addEventListener("click", () => done({ install: true }));
        el.querySelector("[data-issues]")?.addEventListener("click", () => done({ issues: true }));
      },
      null,
    );
    document.getElementById("dialog")?.classList.remove("wide");
    if (!choice) return;
    try {
      if ("use" in choice) {
        const { manifest } = await server.book(choice.use.entry.id, choice.use.entry.version);
        // give each of the action's inputs the first chosen data item of its kind
        const inputs: Record<string, string> = {};
        const pool = [...(data?.artifacts ?? [])];
        for (const input of manifest.actions[choice.action]?.inputs ?? []) {
          const i = pool.findIndex((a) => a.kind === input.accepts.kind);
          if (i >= 0) inputs[input.name] = pool.splice(i, 1)[0].id;
        }
        return await hooks.usePlan(choice.use.entry, choice.action, inputs);
      }
      if ("guide" in choice) await guideDialog(choice.guide.entry, (await server.book(choice.guide.entry.id)).guide);
      if ("test" in choice) {
        const b = choice.test.entry;
        hooks.notify(`Testing ${b.title} on its example…`);
        const r = await server.testBook(b.id);
        hooks.notify(r.passed ? `${b.title} passed` : `${b.title} failed: ${r.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message ?? "failed"}`).join("; ")}`);
      }
      if ("install" in choice) {
        const source = await promptDialog("Install a book", "Folder on this computer, or git URL", "");
        if (source) {
          const r = await server.installBook(source);
          hooks.notify(`Installed ${r.installed.join(", ")}`);
        }
      }
      if ("issues" in choice) await issuesDialog(issues);
    } catch (e) {
      hooks.notify(e instanceof Error ? e.message : String(e));
    }
  }
}

function guideDialog(book: CatalogueEntry, guide: string) {
  return showDialog(
    `<p class="eyebrow">Guide · ${escapeHtml(book.id)}</p><h2>${escapeHtml(book.title)}</h2>
     <pre class="code guide-text">${escapeHtml(guide || "This book has no GUIDE.md yet.")}</pre>
     <footer><button class="primary" data-cancel>Back</button></footer>`,
    () => {},
    undefined,
  );
}

function issuesDialog(issues: LibraryIssue[]) {
  return showDialog(
    `<p class="eyebrow">Library</p><h2>Ships and books with problems</h2>
     <p class="muted small">Ships and books with errors are left out of the library until they're fixed. Run <code>pharos check</code> in their folder for the same list.</p>
     <ul class="issue-list">${issues
       .map(
         (i) => `<li><strong>${escapeHtml(i.type)} ${escapeHtml(i.id)}</strong> <small>${escapeHtml(i.dir)}</small><ul>${i.problems
           .map((p) => `<li class="${p.severity}">${p.severity === "error" ? icon("warning", 13) : ""} ${escapeHtml(p.message)} <small>${escapeHtml(p.file ? `${p.file.split("/").slice(-2).join("/")}${p.line ? `:${p.line}` : ""}` : p.path)}</small></li>`)
           .join("")}</ul></li>`,
       )
       .join("")}</ul>
     <footer><button class="primary" data-cancel>Back</button></footer>`,
    () => {},
    undefined,
  );
}
