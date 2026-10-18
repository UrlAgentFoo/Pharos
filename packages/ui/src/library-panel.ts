/**
 * The books in the library. Each card shows what a person needs to choose
 * one: its name, how to use it (with what it can do, one button per
 * action), the files it accepts, and the ships it runs on, ticked when
 * downloaded. Ids, versions, trust and tags stay out of sight. Opened from
 * workspace data, books that fit it come first and actions that can't run
 * on it are disabled.
 */
import type { AcceptedFormats, Artifact, BookCard, BookManifest, BookMatch, CatalogueEntry, LibraryIssue } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml, formatSize, promptDialog, showDialog } from "./dialogs.js";
import { paramLabel } from "./format.js";
import { icon } from "./icons.js";

export interface LibraryHooks {
  /** Runs one of a book's actions on the data (or the active window). */
  usePlan(book: CatalogueEntry, action: string, inputs: Record<string, string>): Promise<void>;
  notify(text: string): void;
  gpu(): boolean;
}

type Choice =
  | { use: BookCard; action: string }
  | { more: BookCard }
  | { ready: BookCard }
  | { install: true }
  | { issues: true }
  | null;

/** How much the ships a book still needs weigh, when Docker has said. */
const missingSize = (c: BookCard) => c.ships.filter((s) => !s.downloaded).reduce((n, s) => n + (s.sizeBytes ?? 0), 0);

/**
 * A book's card, the same shape as a ship's (see `.lib-card`): name and
 * whether it fits, how to use it, then its actions and the files it takes
 * (scrolling inside the card if a long one passes the card's height), and
 * at the foot its ships, ticked once downloaded, with Get ready and See more.
 */
function card(c: BookCard, match: BookMatch | undefined, withData: boolean, gpu: boolean, shipTitle: (id: string) => string): string {
  const e = c.entry;
  const noGpu = e.gpu === "required" && !gpu;
  const fits = (name: string) => !noGpu && (!withData || !!match?.actions.includes(name));
  const blocked = noGpu || (withData && !match?.actions.length);
  const badge = noGpu
    ? `<span class="lib-badge warn">Needs a GPU</span>`
    : withData && match?.actions.length
      ? `<span class="lib-badge ok">${icon("check", 13)} Fits your data</span>`
      : "";
  const files = c.accepts.length
    ? c.accepts.map((a) => `<span${a.converted ? ` class="converted" title="Converted first"` : ""}>${escapeHtml(a.title)}</span>`).join(" · ")
    : "No files: describe what you want";
  const ships = c.ships
    .map((s) => {
      const hint = s.downloaded ? "On this computer" : `Not downloaded yet${s.sizeBytes ? ` (${formatSize(s.sizeBytes)})` : ""}; it downloads the first time it's needed`;
      return `<li class="${s.downloaded ? "on" : "off"}" title="${escapeHtml(hint)}">${icon(s.downloaded ? "check" : "save", 13)}<span>${escapeHtml(shipTitle(s.id))}</span></li>`;
    })
    .join("");
  const getReady =
    c.ships.some((s) => !s.downloaded) && !noGpu
      ? `<button class="link-btn" data-ready="${escapeHtml(e.id)}" title="Downloads or sets up the ships not ticked yet, so the first run doesn't wait">Get ready${missingSize(c) ? ` (${formatSize(missingSize(c))})` : ""}</button>`
      : "";
  return `<li class="lib-card ${blocked ? "blocked" : ""}" data-book="${escapeHtml(e.id)}">
    <header class="lib-card-head"><span class="lib-card-icon">${icon("book", 16)}</span><div class="lib-card-name"><h3>${escapeHtml(e.title)}</h3>${badge}</div></header>
    <p class="lib-card-desc" title="${escapeHtml(c.howToUse)}">${escapeHtml(c.howToUse)}</p>
    <div class="lib-card-body">
      <div class="lib-card-actions">${c.actions
        .map((a) => `<button class="chip ${fits(a.name) ? "primary-chip" : ""}" data-use="${escapeHtml(e.id)}" data-action="${escapeHtml(a.name)}" ${fits(a.name) ? "" : "disabled"} title="${escapeHtml(a.summary ?? a.title)}">${escapeHtml(a.title)}</button>`)
        .join("")}</div>
      <p class="lib-card-meta">Takes ${files}</p>
      ${noGpu ? `<p class="lib-card-meta warn">Its ships need an NVIDIA GPU, and this computer has none.</p>` : ""}
    </div>
    <div class="lib-card-foot">
      <ul class="lib-card-ships" aria-label="Ships">${ships}</ul>
      <div class="lib-card-links">${getReady}<button class="link-btn" data-more="${escapeHtml(e.id)}" aria-label="See more about ${escapeHtml(e.title)}">See more</button></div>
    </div>
  </li>`;
}

/**
 * Shows the library; with `data`, matched against that workspace data.
 * Loops until closed, so Install and See more come back to it.
 */
export async function libraryPanel(server: LocalServer, hooks: LibraryHooks, data?: { workspace: string; artifacts: Artifact[]; text?: string }) {
  let filter = "";
  const withData = !!data?.artifacts.length;
  for (;;) {
    const [cards, issues, matched, ships] = await Promise.all([
      server.cards(),
      server.issues(),
      withData ? server.match(data!.workspace, data!.artifacts.map((a) => a.id), data!.text).then((r) => r.matches) : Promise.resolve(undefined),
      server.ships().catch(() => []),
    ]);
    const shipTitle = (id: string) => ships.find((s) => s.id === id)?.title ?? id;
    const matchOf = (id: string) => matched?.find((m) => m.book.id === id);
    const order = matched ? matched.map((m) => cards.find((c) => c.entry.id === m.book.id)!).filter(Boolean) : cards;
    const errors = issues.filter((i) => i.problems.some((p) => p.severity === "error"));
    const choice = await showDialog<Choice>(
      `<p class="eyebrow">Library</p><h2>${withData ? `Books for ${escapeHtml(data!.artifacts.map((a) => a.name ?? a.id.slice(0, 8)).join(", "))}` : "Books"}</h2>
       <div class="lib-head"><input type="search" class="lib-search" placeholder="Filter books" aria-label="Filter books" value="${escapeHtml(filter)}"/>
         <button class="chip" data-install>${icon("plus", 14)} Install…</button>
         ${issues.length ? `<button class="chip ${errors.length ? "warn-chip" : ""}" data-issues>${icon("warning", 14)} ${issues.length} with problems</button>` : ""}</div>
       <ul class="lib-cards">${order.map((c) => card(c, matchOf(c.entry.id), withData, hooks.gpu(), shipTitle)).join("") || `<li class="lib-empty">No books installed yet. Install one, or create one with <code>pharos book new</code>.</li>`}</ul>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      (done, el) => {
        el.classList.add("wide");
        const search = el.querySelector<HTMLInputElement>(".lib-search")!;
        const apply = () => {
          filter = search.value;
          const q = filter.toLowerCase();
          el.querySelectorAll<HTMLElement>(".lib-card").forEach((c) => (c.hidden = !!q && !c.textContent!.toLowerCase().includes(q)));
        };
        search.addEventListener("input", apply);
        apply();
        const find = (id: string) => cards.find((c) => c.entry.id === id)!;
        el.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((b) => b.addEventListener("click", () => done({ use: find(b.dataset.use!), action: b.dataset.action! })));
        el.querySelectorAll<HTMLButtonElement>("[data-more]").forEach((b) => b.addEventListener("click", () => done({ more: find(b.dataset.more!) })));
        el.querySelectorAll<HTMLButtonElement>("[data-ready]").forEach((b) => b.addEventListener("click", () => done({ ready: find(b.dataset.ready!) })));
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
      if ("ready" in choice) {
        const r = await server.getReady(choice.ready.entry.id);
        hooks.notify(r.pulling.length ? `Getting ${r.pulling.map((p) => p.id).join(", ")} ready; follow it under Running in the top bar.` : `${choice.ready.entry.title} is ready.`);
      }
      if ("more" in choice && (await bookDetails(choice.more, await server.book(choice.more.entry.id, choice.more.entry.version), shipTitle))) {
        const b = choice.more.entry;
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

const TRUST: Record<string, string> = { verified: "Verified", verifying: "Verifying", imported: "Not yet tested" };

/**
 * A book in full: how to use it, each action with the files it takes and
 * what you can set, its ships, and the guide the assistant reads (folded
 * away). Resolves true to test it on its example.
 */
function bookDetails(c: BookCard, book: { manifest: BookManifest; guide: string; accepts: AcceptedFormats[] }, shipTitle: (id: string) => string) {
  const { manifest: m, guide, accepts } = book;
  const e = c.entry;
  const title = (format: string) => c.accepts.find((a) => a.format === format)?.title ?? format;
  const actions = Object.entries(m.actions).map(([name, a]) => {
    const inputs = accepts.filter((x) => x.action === name);
    const takes = inputs.length
      ? `Takes ${inputs.map((x) => [...x.direct.map(title), ...x.converted.map((v) => `${title(v.format)} (converted first)`)].join(" or ")).join(" and ")}`
      : "Starts from its settings";
    const settings = a.parameters?.length ? `Settings: ${a.parameters.map(paramLabel).join(", ")}` : "";
    return `<li><strong>${escapeHtml(a.title)}</strong>${a.summary ? `<span>${escapeHtml(a.summary)}</span>` : ""}<small>${escapeHtml([takes, settings].filter(Boolean).join(" · "))}</small></li>`;
  });
  const ships = c.ships.map(
    (s) =>
      `<li><strong class="lib-card-where ${s.downloaded ? "on" : ""}">${icon(s.downloaded ? "check" : "save", 13)} ${escapeHtml(shipTitle(s.id))}</strong><small>${
        s.downloaded ? "On this computer" : `Not downloaded yet${s.sizeBytes ? ` (${formatSize(s.sizeBytes)})` : ""}; it downloads the first time it's needed`
      }</small></li>`,
  );
  const facts = [
    `Version ${e.version}`,
    m.authors?.length ? `By ${m.authors.join(", ")}` : "",
    TRUST[e.trust] ?? e.trust,
    e.gpu === "required" ? "Needs a GPU" : e.gpu === "optional" ? "Uses a GPU if there is one" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return showDialog<boolean>(
    `<p class="eyebrow">Book</p><h2>${escapeHtml(e.title)}</h2>
     <div class="lib-more">
       <p>${escapeHtml(c.howToUse)}</p>
       ${m.summary !== c.howToUse ? `<p class="muted small">${escapeHtml(m.summary)}</p>` : ""}
       <p class="muted small">${escapeHtml(facts)}</p>
       ${e.verifyError ? `<p class="error small">Its last test failed: ${escapeHtml(e.verifyError)}</p>` : ""}
       <h3>What it can do</h3>
       <ul class="lib-more-list">${actions.join("")}</ul>
       <h3>Ships</h3>
       <ul class="lib-more-list">${ships.join("")}</ul>
       ${m.citation ? `<h3>Cite</h3><p class="small">${escapeHtml(m.citation)}</p>` : ""}
       <details class="lib-more-guide"><summary class="link-btn">How the assistant uses it</summary>
         <pre class="code guide-text">${escapeHtml(guide || "This book has no GUIDE.md yet.")}</pre></details>
     </div>
     <footer><button data-test>Test on its example</button><button class="primary" data-cancel>Back</button></footer>`,
    (done, el) => el.querySelector("[data-test]")!.addEventListener("click", () => done(true)),
    false,
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
