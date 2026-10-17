/**
 * The library, in one place: books first (cards with their summary, tags,
 * trust, the ships they need and whether this machine can run them), then
 * the ships with their operations, then the built-in image tools. Opened
 * from workspace data, the books tab shows only the books that accept that
 * data (direct matches first, then after conversion), and the rest with
 * why not. Without the local server only the built-in tools are there.
 */
import type { Artifact, BookMatch, CatalogueEntry, LibraryIssue } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml, promptDialog, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";

export interface LibraryHooks {
  /** Opens a proposed plan for a book (with the data assigned when known). */
  usePlan(book: CatalogueEntry, inputs: Record<string, string>): Promise<void>;
  notify(text: string): void;
  gpu(): boolean;
  /** The built-in tools tab: its HTML, and wiring for its controls. */
  tools: { html(): string; wire(el: HTMLElement): void };
}

export type LibraryTab = "books" | "ships" | "tools";

type Action =
  | { use: CatalogueEntry }
  | { guide: CatalogueEntry }
  | { test: CatalogueEntry }
  | { testShip: CatalogueEntry }
  | { install: true }
  | { issues: true }
  | { tab: LibraryTab }
  | null;

const TRUST: Record<CatalogueEntry["trust"], string> = { verified: "Verified", verifying: "Verifying", imported: "Not yet tested" };

function card(e: CatalogueEntry, match: BookMatch | undefined, ships: string[], gpu: boolean): string {
  const blocked = (match?.tier === "excluded") || (e.gpu === "required" && !gpu);
  const tier = match ? (match.tier === "direct" ? "Fits your data" : match.tier === "convert" ? "Fits after conversion" : "Can't run on this data") : "";
  return `<li class="book-card ${blocked ? "blocked" : ""}">
    <div class="book-top"><strong>${escapeHtml(e.title)}</strong><small class="trust trust-${e.trust}">${TRUST[e.trust]}</small></div>
    <p>${escapeHtml(e.summary)}</p>
    <p class="book-meta"><small>${escapeHtml(e.id)} ${escapeHtml(e.version)}${ships.length ? ` · ships: ${ships.map(escapeHtml).join(", ")}` : ""}${e.gpu !== "none" ? ` · GPU ${e.gpu}${e.gpu === "required" && !gpu ? " (not on this machine)" : ""}` : ""}</small></p>
    ${e.tags.length ? `<p class="book-tags">${e.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</p>` : ""}
    ${match ? `<p class="book-match tier-${match.tier}"><small>${tier}: ${escapeHtml(match.reasons.join("; "))}</small></p>` : ""}
    <div class="job-actions">
      <button class="chip primary-chip" data-use="${escapeHtml(e.id)}" ${blocked ? "disabled" : ""}>${icon("batch", 13)} Use…</button>
      <button class="chip" data-guide="${escapeHtml(e.id)}">Guide</button>
      <button class="chip" data-test="${escapeHtml(e.id)}" title="Runs the book on its example data">Test</button>
    </div></li>`;
}

/**
 * Shows the library; with `data`, matched against that workspace data.
 * Loops until closed, so Install, Test and Guide come back to it.
 */
export async function libraryPanel(server: LocalServer | null, hooks: LibraryHooks, data?: { workspace: string; artifacts: Artifact[]; text?: string }, start: LibraryTab = "books") {
  let filter = "";
  let tab: LibraryTab = server ? start : "tools";
  for (;;) {
    if (!server || tab === "tools") {
      const next = await toolsTab(hooks, !!server);
      if (!next) return;
      tab = next;
      continue;
    }
    if (tab === "ships") {
      const next = await shipsTab(server, hooks);
      if (!next) return;
      tab = next;
      continue;
    }
    const [books, issues, matched] = await Promise.all([
      server.books(),
      server.issues(),
      data?.artifacts.length ? server.match(data.workspace, data.artifacts.map((a) => a.id), data.text).then((r) => r.matches) : Promise.resolve(undefined),
    ]);
    const details = new Map(await Promise.all(books.map(async (b) => [b.id, await server.book(b.id, b.version)] as const)));
    const shipsOf = (id: string) => Object.keys(details.get(id)?.manifest.ships ?? {});
    const matchOf = (id: string) => matched?.find((m) => m.book.id === id);
    const order = matched ? matched.map((m) => books.find((b) => b.id === m.book.id)!).filter(Boolean) : books;
    const errors = issues.filter((i) => i.problems.some((p) => p.severity === "error"));
    const action = await showDialog<Action>(
      `${tabs("books", true)}
       <p class="eyebrow">${data?.artifacts.length ? `Books for ${escapeHtml(data.artifacts.map((a) => a.name ?? a.id.slice(0, 8)).join(", "))}` : "Books"}</p>
       <div class="ws-head"><input type="search" class="lib-search" placeholder="Filter books" value="${escapeHtml(filter)}"/>
         <button class="chip" data-install>${icon("plus", 14)} Install…</button>
         ${issues.length ? `<button class="chip ${errors.length ? "warn-chip" : ""}" data-issues>${icon("warning", 14)} ${issues.length} with problems</button>` : ""}</div>
       <ul class="book-list">${order.map((b) => card(b, matchOf(b.id), shipsOf(b.id), hooks.gpu())).join("") || `<li class="muted">No books installed yet. Install one, or create one with <code>pharos book new</code>.</li>`}</ul>
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
        const find = (id: string) => books.find((b) => b.id === id)!;
        el.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((b) => b.addEventListener("click", () => done({ use: find(b.dataset.use!) })));
        el.querySelectorAll<HTMLButtonElement>("[data-guide]").forEach((b) => b.addEventListener("click", () => done({ guide: find(b.dataset.guide!) })));
        el.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => b.addEventListener("click", () => done({ test: find(b.dataset.test!) })));
        el.querySelector("[data-install]")!.addEventListener("click", () => done({ install: true }));
        wireTabs(el, (t) => done({ tab: t }));
        el.querySelector("[data-issues]")?.addEventListener("click", () => done({ issues: true }));
      },
      null,
    );
    document.getElementById("dialog")?.classList.remove("wide");
    if (!action) return;
    if ("tab" in action) {
      tab = action.tab;
      continue;
    }
    try {
      if ("use" in action) {
        const book = details.get(action.use.id)!.manifest;
        // give each input the first chosen data item of its kind
        const inputs: Record<string, string> = {};
        const pool = [...(data?.artifacts ?? [])];
        for (const input of book.inputs ?? []) {
          const i = pool.findIndex((a) => a.kind === input.accepts.kind);
          if (i >= 0) inputs[input.name] = pool.splice(i, 1)[0].id;
        }
        return await hooks.usePlan(action.use, inputs);
      }
      if ("guide" in action) await guideDialog(action.guide, details.get(action.guide.id)?.guide ?? "");
      if ("test" in action) {
        hooks.notify(`Testing ${action.test.id} on its example…`);
        const r = await server.testBook(action.test.id);
        hooks.notify(r.passed ? `${action.test.id} passed and is now verified` : `${action.test.id} failed: ${r.cases.map((c) => c.message).filter(Boolean).join("; ")}`);
      }
      if ("install" in action) {
        const source = await promptDialog("Install a book", "Folder on this computer, or git URL", "");
        if (source) {
          const r = await server.installBook(source);
          hooks.notify(`Installed ${r.installed.join(", ")}`);
        }
      }
      if ("issues" in action) await issuesDialog(issues);
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

// ------------------------------------------------------------ tabs

function tabs(active: LibraryTab, server: boolean): string {
  const items: [LibraryTab, string][] = server ? [["books", "Books"], ["ships", "Ships"], ["tools", "Built-in tools"]] : [["tools", "Built-in tools"]];
  return `<nav class="lib-tabs" role="tablist">${items
    .map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${id === active}">${label}</button>`)
    .join("")}</nav>`;
}

function wireTabs(el: HTMLElement, go: (t: LibraryTab) => void) {
  el.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab as LibraryTab)));
}

async function shipsTab(server: LocalServer, hooks: LibraryHooks): Promise<LibraryTab | null> {
  for (;;) {
    const entries = await server.ships();
    const manifests = await Promise.all(entries.map((e) => server.ship(e.id, e.version).then((r) => r.manifest)));
    const action = await showDialog<Action>(
      `${tabs("ships", true)}
       <p class="eyebrow">Ships</p>
       <p class="muted small">Ships are the tools books run: container images with typed operations. They download (or build) the first time a book needs them; <strong>Ships and storage</strong> shows what's on this computer.</p>
       <ul class="book-list">${entries
         .map((e, i) => {
           const m = manifests[i];
           const ops = Object.entries(m.operations).map(([name, op]) => `<li><strong>${escapeHtml(name)}</strong> <small>${escapeHtml(op.summary)}</small></li>`).join("");
           return `<li class="book-card">
             <div class="book-top"><strong>${escapeHtml(e.id)}</strong><small class="trust trust-${e.trust}">${TRUST[e.trust]}</small></div>
             <p>${escapeHtml(e.summary)}</p>
             <p class="book-meta"><small>${escapeHtml(e.version)}${e.gpu !== "none" ? ` · GPU ${e.gpu}` : ""}${m.license ? ` · ${escapeHtml(m.license)}` : ""}</small></p>
             <ul class="ship-ops">${ops}</ul>
             <div class="job-actions"><button class="chip" data-test-ship="${escapeHtml(e.id)}" title="Runs each operation on its test data">Test</button></div></li>`;
         })
         .join("") || `<li class="muted">No ships installed yet.</li>`}</ul>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      (done, el) => {
        el.classList.add("wide");
        wireTabs(el, (t) => done({ tab: t }));
        el.querySelectorAll<HTMLButtonElement>("[data-test-ship]").forEach((b) => b.addEventListener("click", () => done({ testShip: entries.find((e) => e.id === b.dataset.testShip)! })));
      },
      null,
    );
    document.getElementById("dialog")?.classList.remove("wide");
    if (!action) return null;
    if ("tab" in action) return action.tab;
    if ("testShip" in action) {
      hooks.notify(`Testing ${action.testShip.id}…`);
      try {
        const r = await server.testShip(action.testShip.id);
        hooks.notify(r.passed ? `${action.testShip.id} passed and is now verified` : `${action.testShip.id} failed: ${r.cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`).join("; ")}`);
      } catch (e) {
        hooks.notify(e instanceof Error ? e.message : String(e));
      }
    }
  }
}

async function toolsTab(hooks: LibraryHooks, server: boolean): Promise<LibraryTab | null> {
  const action = await showDialog<Action>(
    `${tabs("tools", server)}
     <p class="eyebrow">Built-in tools</p>
     ${hooks.tools.html()}
     <footer><button class="primary" data-cancel>Done</button></footer>`,
    (done, el) => {
      wireTabs(el, (t) => done({ tab: t }));
      hooks.tools.wire(el);
    },
    null,
  );
  return action && "tab" in action ? action.tab : null;
}
