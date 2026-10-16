/**
 * The assistant chat: a floating panel where the model answers questions,
 * proposes steps (applied only when the user says so) and suggests a small
 * control panel for the task at hand, which is pinned to that image's
 * Controls drawer so it stays with the image it was made for.
 */
import { getCommand } from "@pharos/core";
import type { ChatReply } from "./api.js";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";

export interface ChatHooks {
  /** null when the assistant can be used; otherwise why not. */
  unavailable(): string | null;
  send(req: { sessionId?: string; message: string; outcome?: "applied" | "dismissed" }): Promise<ChatReply>;
  applySteps(steps: ChatReply["steps"]): Promise<void>;
  openCommand(id: string): void;
  openSettings(): void;
  hasImage(): boolean;
  /** Adds a suggested panel to the active image's Controls; returns that image's name. */
  pinControls(controls: NonNullable<ChatReply["controls"]>): string | null;
}

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; reply: ChatReply; applied: boolean; pinnedTo: string | null }
  | { role: "note"; text: string; error?: boolean };

const STARTERS = ["Suggest controls for this image", "Reduce the noise in this stack", "How do I count nuclei?", "What does Gaussian blur do?"];

export class Chat {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private messages: Message[] = [];
  private sessionId: string | undefined;
  private busy = false;

  constructor(private readonly hooks: ChatHooks) {
    this.el = document.createElement("aside");
    this.el.className = "chat";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Assistant");
    this.el.innerHTML = `
      <header class="chat-head">
        <span class="chat-mark">${icon("sparkle", 16)}</span><strong>Assistant</strong>
        <span class="spacer"></span>
        <button class="icon-btn" data-chat="new" title="New conversation" aria-label="New conversation">${icon("new", 17)}</button>
        <button class="icon-btn" data-chat="close" title="Close (Esc)" aria-label="Close">${icon("close", 16)}</button>
      </header>
      <div class="chat-log" aria-live="polite"></div>
      <form class="chat-input">
        <textarea rows="1" placeholder="Ask, or describe what you want to do…" aria-label="Message"></textarea>
        <button class="chat-send" title="Send (Enter)" aria-label="Send">${icon("send", 16)}</button>
      </form>
      <p class="chat-foot">Sees image size, type and steps, never pixels. Nothing runs until you apply it.</p>`;
    document.body.append(this.el);
    this.log = this.el.querySelector(".chat-log")!;
    this.input = this.el.querySelector("textarea")!;

    this.el.querySelector(".chat-head")!.addEventListener("click", (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>("[data-chat]")?.dataset.chat;
      if (what === "close") this.close();
      if (what === "new") this.reset();
    });
    this.el.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send(this.input.value);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(this.input.value);
      }
      if (e.key === "Escape") this.close();
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
    });
    this.render();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** Opens the panel; with a message, sends it straight away. */
  open(message?: string) {
    this.el.hidden = false;
    this.render();
    if (message) void this.send(message);
    else this.input.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private reset() {
    this.messages = [];
    this.sessionId = undefined;
    this.render();
    this.input.focus();
  }

  private async send(text: string) {
    const message = text.trim();
    if (!message || this.busy) return;
    const why = this.hooks.unavailable();
    if (why) {
      this.messages.push({ role: "note", text: why, error: true });
      this.render();
      return;
    }
    this.input.value = "";
    this.input.style.height = "auto";
    // tell the model what happened to its last suggestions
    const last = [...this.messages].reverse().find((m) => m.role === "assistant");
    const hadSuggestions = last?.role === "assistant" && (last.reply.steps.length || last.reply.controls || last.reply.open);
    // pinned controls count as taken up: the user now has them on their image
    const outcome = hadSuggestions ? (last.applied || last.pinnedTo ? "applied" : "dismissed") : undefined;
    this.messages.push({ role: "user", text: message });
    this.busy = true;
    this.render();
    try {
      let reply: ChatReply;
      try {
        reply = await this.hooks.send({ sessionId: this.sessionId, message, outcome });
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
        this.messages.splice(this.messages.length - 1, 0, { role: "note", text: "The previous conversation expired, so this starts a new one." });
        reply = await this.hooks.send({ message });
      }
      this.sessionId = reply.sessionId;
      const pinnedTo = reply.controls ? this.hooks.pinControls(reply.controls) : null;
      this.messages.push({ role: "assistant", reply, applied: false, pinnedTo });
    } catch (e) {
      this.messages.push({ role: "note", text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      this.busy = false;
      this.render();
      this.input.focus();
    }
  }

  private render() {
    const log = this.log;
    log.innerHTML = "";
    if (!this.messages.length) {
      const why = this.hooks.unavailable();
      log.innerHTML = `
        <div class="chat-intro">
          <p><strong>What are you trying to do?</strong></p>
          <p class="muted">Describe your goal and the assistant suggests steps or builds a small control panel for it.</p>
          ${why ? `<p class="chat-warn">${escapeHtml(why)}</p><button class="btn" data-settings>${icon("settings", 16)}<span>Open settings</span></button>` : ""}
          <div class="chat-starters">${STARTERS.map((s) => `<button class="chip" data-starter="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}</div>
        </div>`;
      log.querySelector("[data-settings]")?.addEventListener("click", () => this.hooks.openSettings());
      log.querySelectorAll<HTMLElement>("[data-starter]").forEach((b) => b.addEventListener("click", () => void this.send(b.dataset.starter!)));
    }
    for (const m of this.messages) log.append(this.messageEl(m));
    if (this.busy) log.insertAdjacentHTML("beforeend", `<div class="msg assistant"><p class="chat-wait"><span class="spinner"></span> Thinking…</p></div>`);
    log.scrollTop = log.scrollHeight;
    (this.el.querySelector(".chat-send") as HTMLButtonElement).disabled = this.busy;
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
      if (m.error && /Settings|API key/i.test(m.text)) {
        const b = document.createElement("button");
        b.className = "btn";
        b.innerHTML = `${icon("settings", 16)}<span>Open settings</span>`;
        b.addEventListener("click", () => this.hooks.openSettings());
        el.append(b);
      }
      return el;
    }
    const { reply } = m;
    el.className = "msg assistant";
    if (reply.text) el.insertAdjacentHTML("beforeend", `<p>${escapeHtml(reply.text).replace(/\n/g, "<br>")}</p>`);

    if (reply.steps.length) {
      const card = document.createElement("div");
      card.className = "chat-card";
      card.innerHTML = `<ol class="chat-steps">${reply.steps
        .map((s) => {
          const cmd = getCommand(s.command);
          const summary = cmd.summary?.(s.params as never);
          return `<li>${icon(cmd.icon, 16)}<span>${escapeHtml(cmd.title.replace(/…$/, ""))}${summary ? ` <small>${escapeHtml(summary)}</small>` : ""}</span></li>`;
        })
        .join("")}</ol>`;
      const apply = document.createElement("button");
      apply.className = "btn primary";
      const label = m.applied ? "Applied" : !this.hooks.hasImage() ? "Open an image first" : `Apply ${reply.steps.length} step${reply.steps.length > 1 ? "s" : ""}`;
      apply.innerHTML = `${icon("check", 16)}<span>${label}</span>`;
      apply.disabled = m.applied || !this.hooks.hasImage();
      apply.addEventListener("click", async () => {
        await this.hooks.applySteps(reply.steps);
        m.applied = true;
        this.render();
      });
      card.append(apply);
      el.append(card);
    }

    if (reply.controls) {
      const card = document.createElement("div");
      card.className = "chat-card chat-controls";
      card.innerHTML = `<h4>${icon("panel", 15)} ${escapeHtml(reply.controls.title)}</h4>
        <p class="chat-cmds">${reply.controls.commands.map((id) => `<span>${icon(getCommand(id).icon, 13)}${escapeHtml(getCommand(id).title.replace(/…$/, ""))}</span>`).join("")}</p>
        <p class="small muted">${m.pinnedTo ? `Added to the Controls of <strong>${escapeHtml(m.pinnedTo)}</strong>.` : "Open an image to pin these controls to it."}</p>`;
      el.append(card);
    }

    if (reply.open) {
      const cmd = getCommand(reply.open);
      const b = document.createElement("button");
      b.className = "btn";
      b.innerHTML = `${icon(cmd.icon, 16)}<span>Open ${escapeHtml(cmd.title.replace(/…$/, ""))}</span>`;
      b.addEventListener("click", () => {
        m.applied = true;
        this.hooks.openCommand(cmd.id);
      });
      el.append(b);
    }
    if (reply.skipped.length) el.insertAdjacentHTML("beforeend", `<p class="small muted">Ignored ${reply.skipped.length} invalid suggestion(s).</p>`);
    return el;
  }
}
