/**
 * The assistant, in the left column: a chat panel whose top, which stays put,
 * is the active window's name (or, with none active, the project's), then
 * what the window needs and the conversation, which scroll under it.
 * Say hello, ask about the data, or say what you want to find out: the
 * assistant answers, and when asked to do something picks a book that fits
 * and proposes its steps in that window's history, where nothing runs until
 * you approve them. Each message goes with the conversation so far.
 *
 * Its input is the panel's foot, and doubles as search: as you type,
 * matching actions and windows show above it (arrows pick one, Enter runs
 * it); Enter with nothing picked sends the text to the assistant.
 */
import type { ChatTurn } from "@pharos/contracts";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";
import { formatShortcut } from "./keys.js";

/** What the assistant made of a request: its message, and the window it proposed steps in, if it did. */
export interface AskReply {
  text: string;
  /** Steps it proposed in a window's history, waiting for Approve. */
  proposed?: { window: string; windowId: string; steps: number; title: string };
  /** A book action it set up in a window's Controls (Suggested tab), waiting to be run. */
  suggested?: { window: string; windowId: string; title: string; book: string };
}

/** Something the input's search can run: an action or a window. */
export interface SearchHit {
  icon: string;
  title: string;
  subtitle: string;
  shortcut?: string;
  enabled: boolean;
  run(): void;
}

export interface AssistantHooks {
  /** null when the assistant can be used; otherwise why not. */
  unavailable(): string | null;
  /** The name of the window the assistant would work on, or null when none is open. */
  target(): string | null;
  /** The assistant's answer to `message`, given the conversation before it. */
  ask(message: string, history: ChatTurn[]): Promise<AskReply>;
  /** Actions and windows matching `query`, best first. */
  search(query: string): SearchHit[];
  /** The project was renamed. */
  renamed(): void;
  /** Brings a window forward, showing what the assistant left there: its Controls' Suggested tab, or its history. */
  show(windowId: string, place: "suggested" | "history"): void;
}

type Message = { role: "user"; text: string } | { role: "assistant"; reply: AskReply } | { role: "note"; text: string; error?: boolean };

export const UNTITLED = "Untitled project";
/** What the title shows until the project is named. */
const ASK = "Ask Pharos";

export class Assistant {
  private readonly log: HTMLElement;
  /** What scrolls: the window's summary (put in by its owner) and the conversation. */
  readonly scroller: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly hits: HTMLElement;
  private messages: Message[] = [];
  private busy = false;
  private name = UNTITLED;
  private found: SearchHit[] = [];
  /** The search hit Enter runs; -1 sends the text to the assistant instead. */
  private sel = -1;

  constructor(
    column: HTMLElement,
    private readonly box: HTMLElement,
    private readonly hooks: AssistantHooks,
  ) {
    column.innerHTML = `
      <header class="assistant-head">
        <p class="eyebrow assistant-status"></p>
        <h1 class="display assistant-title" tabindex="0" title="Click to name the project" spellcheck="false"></h1>
      </header>
      <div class="assistant-scroll"><div class="assistant-log" aria-live="polite"></div></div>`;
    this.scroller = column.querySelector(".assistant-scroll")!;
    this.log = column.querySelector(".assistant-log")!;
    this.title = column.querySelector(".assistant-title")!;
    this.status = column.querySelector(".assistant-status")!;
    box.innerHTML = `
      <div class="ask-hits" role="listbox" hidden></div>
      <form class="ask">
        <textarea rows="1" placeholder="Ask, or search actions and windows" aria-label="Ask the assistant or search"></textarea>
      </form>`;
    this.input = box.querySelector("textarea")!;
    this.hits = box.querySelector(".ask-hits")!;
    this.renderTitle();

    // click the title to rename; Enter or leaving the field keeps the name
    this.title.addEventListener("click", () => this.editTitle());
    this.title.addEventListener("keydown", (e) => {
      if (this.title.isContentEditable) {
        if (e.key === "Enter") {
          e.preventDefault();
          this.title.blur();
        }
        if (e.key === "Escape") {
          this.title.textContent = this.name;
          this.title.blur();
        }
      } else if (e.key === "Enter") this.editTitle();
    });
    this.title.addEventListener("blur", () => {
      if (!this.title.isContentEditable) return;
      this.title.contentEditable = "false";
      this.name = (this.title.textContent ?? "").replace(/\.$/, "").trim() || UNTITLED;
      this.renderTitle();
      this.hooks.renamed();
    });

    // a reply's "Show in Controls" or "Show the steps"
    this.log.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-show]");
      if (b) this.hooks.show(b.dataset.show!, b.dataset.place === "history" ? "history" : "suggested");
    });

    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.enter();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.enter();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!this.found.length) return;
        e.preventDefault();
        const n = this.found.length;
        this.sel = e.key === "ArrowDown" ? Math.min(n - 1, this.sel + 1) : Math.max(-1, this.sel - 1);
        this.renderHits();
      } else if (e.key === "Escape") {
        if (this.input.value) this.clearInput();
        else this.input.blur();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
      this.sel = -1;
      this.search();
    });
    this.input.addEventListener("blur", () => setTimeout(() => (this.hits.hidden = true), 150));
    this.input.addEventListener("focus", () => this.search());
    this.render();
  }

  get projectName() {
    return this.name;
  }

  setProjectName(name: string) {
    this.name = name || UNTITLED;
    this.renderTitle();
  }

  setStatus(text: string) {
    this.status.textContent = text;
  }

  /** Puts the cursor in the input, optionally with a request to send straight away. */
  focus(message?: string) {
    if (message) void this.send(message);
    else this.input.focus();
  }

  /** Clears the conversation. */
  reset() {
    this.messages = [];
    this.render();
  }

  /** Re-renders the intro, which names the active window. */
  refresh() {
    if (!this.messages.length) this.render();
  }

  private enter() {
    const hit = this.found[this.sel];
    if (hit) {
      if (!hit.enabled) return;
      this.clearInput();
      this.input.blur();
      hit.run();
      return;
    }
    void this.send(this.input.value);
  }

  private clearInput() {
    this.input.value = "";
    this.input.style.height = "auto";
    this.sel = -1;
    this.search();
  }

  private search() {
    const q = this.input.value.trim();
    this.found = q && !this.busy ? this.hooks.search(q).slice(0, 7) : [];
    this.renderHits();
  }

  private renderHits() {
    this.hits.hidden = !this.found.length;
    this.hits.innerHTML = this.found
      .map(
        (h, i) => `<button type="button" class="ask-hit${i === this.sel ? " sel" : ""}" data-hit="${i}" role="option" aria-selected="${i === this.sel}" ${h.enabled ? "" : "disabled"}>
          ${icon(h.icon, 15)}<span><span>${escapeHtml(h.title)}</span><small>${escapeHtml(h.subtitle)}</small></span>${h.shortcut ? `<kbd>${formatShortcut(h.shortcut)}</kbd>` : ""}</button>`,
      )
      .join("") + (this.found.length ? `<p class="ask-hint">${this.sel < 0 ? "Enter asks the assistant · ↑↓ picks an action" : "Enter runs it · ↑ back to asking"}</p>` : "");
    this.hits.querySelectorAll<HTMLButtonElement>("[data-hit]").forEach((b) =>
      b.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the input focused until the action runs
        this.sel = Number(b.dataset.hit);
        this.enter();
      }),
    );
  }

  private async send(text: string) {
    const message = text.trim();
    if (!message || this.busy) return;
    this.clearInput();
    const why = this.hooks.unavailable() ?? (this.hooks.target() ? null : "Open your data first (Add data, or an example): the assistant works on the active window.");
    // what was said before this message (notes are Pharos's, not the conversation's)
    const history = this.messages.flatMap((m): ChatTurn[] => (m.role === "user" ? [{ role: "user", text: m.text }] : m.role === "assistant" && m.reply.text ? [{ role: "assistant", text: m.reply.text }] : []));
    this.messages.push({ role: "user", text: message });
    if (why) {
      this.messages.push({ role: "note", text: why, error: true });
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    try {
      this.messages.push({ role: "assistant", reply: await this.hooks.ask(message, history) });
    } catch (e) {
      this.messages.push({ role: "note", text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render() {
    const log = this.log;
    log.innerHTML = "";
    // before the conversation starts, only what stops the assistant; the column above lists what fits the window
    const why = !this.messages.length && this.hooks.unavailable();
    if (why) log.innerHTML = `<div class="assistant-intro"><p class="chat-warn">${escapeHtml(why)}</p></div>`;
    for (const m of this.messages) log.append(this.messageEl(m));
    if (this.busy) log.insertAdjacentHTML("beforeend", `<div class="msg assistant"><p class="chat-wait"><span class="spinner"></span> Thinking…</p></div>`);
    // the window's summary scrolls with the conversation, above it: keep the latest message in view
    if (this.messages.length || this.busy) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private messageEl(m: Message): HTMLElement {
    const el = document.createElement("div");
    if (m.role === "user") {
      el.className = "msg user";
      el.textContent = m.text;
      return el;
    }
    if (m.role === "note") {
      el.className = `msg note${m.error ? " error" : ""}`;
      el.textContent = m.text;
      return el;
    }
    const { reply } = m;
    el.className = "msg assistant";
    if (reply.text) el.insertAdjacentHTML("beforeend", `<p>${escapeHtml(reply.text).replace(/\n/g, "<br>")}</p>`);
    // what it left in a window, in two lines: what, then where it waits, with a way there
    if (reply.proposed) {
      const p = reply.proposed;
      el.insertAdjacentHTML(
        "beforeend",
        `<div class="chat-card"><p class="chat-card-title">${icon("script", 14)}<strong>${escapeHtml(p.title)}</strong></p>
         <p class="chat-card-note">${p.steps} step${p.steps > 1 ? "s" : ""} waiting for your approval in ${escapeHtml(p.window)}. <button type="button" class="link-btn" data-show="${escapeHtml(p.windowId)}" data-place="history">Show the steps</button></p></div>`,
      );
    }
    if (reply.suggested) {
      const p = reply.suggested;
      el.insertAdjacentHTML(
        "beforeend",
        `<div class="chat-card"><p class="chat-card-title">${icon("sparkle", 14)}<span><strong>${escapeHtml(p.title)}</strong> <small>${escapeHtml(p.book)}</small></span></p>
         <p class="chat-card-note">Ready to run in ${escapeHtml(p.window)}. <button type="button" class="link-btn" data-show="${escapeHtml(p.windowId)}" data-place="suggested">Show in Controls</button></p></div>`,
      );
    }
    return el;
  }

  private editTitle() {
    if (this.title.isContentEditable) return;
    this.title.contentEditable = "true";
    // an untitled project starts empty, so typing replaces "Ask Pharos"
    this.title.textContent = this.name === UNTITLED ? "" : this.name;
    this.title.focus();
    getSelection()?.selectAllChildren(this.title);
  }

  private renderTitle() {
    this.title.textContent = this.name === UNTITLED ? ASK : `${this.name}.`;
    this.title.classList.toggle("untitled", this.name === UNTITLED);
  }
}
