/**
 * The Controls' Suggested tab: the assistant's layout of one book action for
 * the window's data (what the chat suggested, the run on view, or the first
 * action that fits), drawn with the panel's own components. A line on what
 * it does, at most two settings with a hint each, every other setting under
 * More settings, and one button. The assistant only lays it out (the server
 * checks its layout); nothing runs or changes until the button is pressed.
 */
import type { ControlsLayout, Params } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import type { SuggestedSubject } from "./data-window.js";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./param-fields.js";
import type { DataDoc } from "./workspace.js";

export interface SuggestedHooks {
  server(): LocalServer | null;
  /** Why the assistant can't be used now, or null. */
  unavailable(): string | null;
  subject(doc: DataDoc): Promise<SuggestedSubject | null>;
  run(doc: DataDoc, subject: SuggestedSubject, values: Params): void;
  dismiss(doc: DataDoc): void;
  /** Switches the window's Controls to the Manual tab. */
  manual(doc: DataDoc): void;
}

type Laid = { layout: ControlsLayout } | { error: string };

const toManual = `<button type="button" class="link-btn" data-sug="manual">Show the manual controls</button>`;

export class SuggestedControls {
  /** Layouts by data, book, action and request: the server keeps them too, this saves the round trip. */
  private readonly layouts = new Map<string, Promise<Laid>>();
  /** Per panel: what it shows (so it's drawn again only when that changes), for which window, about what. */
  private readonly drawn = new WeakMap<HTMLElement, { state: string; doc: DataDoc; subject?: SuggestedSubject }>();

  constructor(private readonly hooks: SuggestedHooks) {}

  /** Draws the tab for `doc` into `host`. */
  async render(doc: DataDoc, host: HTMLElement) {
    if (!this.drawn.has(host)) host.addEventListener("click", (e) => this.onClick(host, e));
    const why = this.hooks.unavailable();
    const state = JSON.stringify([why, doc.marker, doc.output ?? "", doc.steps.map((s) => [s.status, s.with]), doc.suggestion ?? null]);
    const before = this.drawn.get(host);
    if (before?.state === state && before.doc === doc) return;
    this.drawn.set(host, { state, doc, subject: before?.subject });
    const current = () => this.drawn.get(host)?.state === state;
    if (why) {
      host.innerHTML = `<p class="muted small">Suggested controls come from the assistant. ${escapeHtml(why)}</p>${toManual}`;
      return;
    }
    const subject = await this.hooks.subject(doc).catch(() => null);
    if (!current()) return;
    if (!subject) {
      host.innerHTML = `<p class="muted small">Nothing to suggest here yet: no book has an action for what's on view. Every setting is on the Manual tab.</p>${toManual}`;
      return;
    }
    const key = JSON.stringify([doc.workspace, doc.source.id, subject.book.id, subject.action, subject.request ?? ""]);
    let laid = this.layouts.get(key);
    if (!laid) {
      // a new action shows the wait; the same one keeps its panel until the new layout is in
      if (before?.subject?.action !== subject.action) host.innerHTML = `<p class="chat-wait"><span class="spinner"></span> Laying out the controls…</p>`;
      laid = this.fetch(doc, subject, key);
      this.layouts.set(key, laid);
    }
    const r = await laid;
    if (!current()) return;
    this.drawn.set(host, { state, doc, subject });
    host.innerHTML = "error" in r ? `<p class="chat-warn">${escapeHtml(r.error)}</p>${toManual}` : this.html(doc, subject, r.layout);
  }

  private async fetch(doc: DataDoc, subject: SuggestedSubject, key: string): Promise<Laid> {
    const s = this.hooks.server();
    if (!s) return { error: "Suggested controls need Pharos's local server." };
    try {
      return { layout: (await s.controlsLayout(doc.workspace, doc.source.id, subject.book.id, subject.action, subject.request)).layout };
    } catch (e) {
      this.layouts.delete(key); // try again next time
      return { error: `Couldn't lay out the controls: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** The values the form starts with: a run keeps its own; a new action takes the assistant's for this data, then the chat's. */
  private values(subject: SuggestedSubject, layout: ControlsLayout): Params {
    if (subject.kind === "run") return subject.values;
    return { ...subject.values, ...layout.values, ...(subject.chosen ?? {}) };
  }

  private html(doc: DataDoc, subject: SuggestedSubject, layout: ControlsLayout): string {
    const specs = new Map(subject.specs.map((p) => [p.name, p]));
    const values = this.values(subject, layout);
    const placed = new Set<string>();
    const shown = layout.shown.filter((x) => specs.has(x.param) && !placed.has(x.param) && placed.add(x.param));
    const groups = layout.more.map((g) => ({ title: g.title, params: g.params.filter((p) => specs.has(p) && !placed.has(p) && !!placed.add(p)) })).filter((g) => g.params.length);
    // settings the layout left out (it never should) still get a place
    const rest = [...specs.keys()].filter((p) => !placed.has(p));
    if (rest.length) groups.push({ title: "More settings", params: rest });
    const field = (name: string) => manifestParamFields([specs.get(name)!], values);
    const more = groups.length
      ? `<details class="dv-more sug-more"><summary class="ctl-sec-title">${icon("chevron-right", 12)}More settings</summary>${groups
          .map((g) => `${groups.length > 1 ? `<p class="dv-next-sub">${escapeHtml(g.title)}</p>` : ""}${g.params.map(field).join("")}`)
          .join("")}</details>`
      : "";
    const why = subject.kind === "suggestion" ? subject.rationale : subject.kind === "next" ? layout.rationale : "";
    const busy = subject.kind === "run" && doc.steps.some((s) => s.status === "running" || s.status === "queued");
    const button = subject.kind === "run" ? "Apply and run" : escapeHtml(subject.title);
    return `<section class="sug">
      <p class="sug-title"><strong>${escapeHtml(subject.title)}</strong> <small>${escapeHtml(subject.book.title)}</small></p>
      ${layout.summary ? `<p class="sug-summary">${escapeHtml(layout.summary)}</p>` : ""}
      ${why ? `<p class="dv-why">${icon("sparkle", 13)} ${escapeHtml(why)}</p>` : ""}
      <form class="sug-form"${busy ? " inert" : ""}>
        ${shown.map((x) => `<div class="sug-field">${field(x.param)}${x.hint ? `<p class="sug-hint">${escapeHtml(x.hint)}</p>` : ""}</div>`).join("")}
        ${more}
        <button type="button" class="primary run-btn" data-sug="run" title="${button}"><span>${button}</span>${icon("arrow-right", 14)}</button>
      </form>
      ${subject.kind === "suggestion" ? `<button type="button" class="link-btn" data-sug="dismiss">Dismiss the suggestion</button>` : ""}
    </section>`;
  }

  private onClick(host: HTMLElement, e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-sug]");
    const drawn = this.drawn.get(host);
    if (!b || !drawn) return;
    const { doc, subject } = drawn;
    if (b.dataset.sug === "manual") return this.hooks.manual(doc);
    if (!subject) return;
    if (b.dataset.sug === "dismiss") return this.hooks.dismiss(doc);
    const form = host.querySelector<HTMLFormElement>(".sug-form");
    if (!form?.reportValidity()) return;
    this.hooks.run(doc, subject, readManifestParams(subject.specs, form));
  }
}
