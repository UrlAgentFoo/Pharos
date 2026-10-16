/**
 * The project notebook in the left column: a project name you can click to
 * edit, and free-form notes. While you write, clicking an image window
 * cites it at the cursor, like "nuclei look larger [2.3]": 2 is the image
 * (numbered in the order first cited) and 3 its history step. Each citation
 * links to the window's exact state at that moment (history step, slice,
 * contrast, zoom) and brings it back when clicked.
 */
import { escapeHtml } from "./dialogs.js";

export interface NoteRef {
  id: string;
  docId: string;
  name: string;
  /** When the reference was taken (ms since epoch). */
  time: number;
  marker: number;
  steps: number;
  /** Ids of the applied steps, to tell whether the history changed since. */
  stepIds: string[];
  /** Titles of the applied steps, for the Markdown export. */
  stepTitles: string[];
  view: {
    pos: { c: number; z: number; t: number };
    slices: number;
    ranges: [number, number][];
    composite: boolean;
    hidden: boolean[];
    zoom: number;
    centre: { x: number; y: number } | null;
    fitted: boolean;
  };
  /** A small PNG of the window's image as it looked. */
  thumb: string;
  /** The image's citation number (the "2" in [2.3]). */
  num?: number;
}

/** One line of notes: text and citations. */
export type NoteLine = (string | { ref: NoteRef })[];

export interface NotesData {
  name: string;
  lines: NoteLine[];
}

export interface NotesHooks {
  openRef(ref: NoteRef): void;
  /** Writing notes turns on citing by clicking a window. */
  setNoting(on: boolean): void;
  /** A space after a citation: done citing for now, stop the animation. */
  doneCiting(): void;
  changed(): void;
}

const UNTITLED = "Untitled project";
let nextRef = 0;

export class Notes {
  private name = UNTITLED;
  private refs = new Map<string, NoteRef>();
  /** Citation number per image, in the order first cited. */
  private numbers = new Map<string, number>();
  private readonly title: HTMLElement;
  private readonly editor: HTMLElement;
  private readonly status: HTMLElement;
  private readonly preview: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: NotesHooks,
  ) {
    root.innerHTML = `
      <p class="eyebrow notes-status"></p>
      <h1 class="display notes-title" tabindex="0" title="Click to rename the project" spellcheck="false"></h1>
      <div class="notes-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Project notes"
        data-placeholder="Notes for this project… While you write, click any image to cite it here as it looks right now, like [1.0]."></div>`;
    this.title = root.querySelector(".notes-title")!;
    this.editor = root.querySelector(".notes-editor")!;
    this.status = root.querySelector(".notes-status")!;
    this.preview = document.createElement("div");
    this.preview.className = "cite-preview";
    this.preview.hidden = true;
    document.body.append(this.preview);
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
      const v = (this.title.textContent ?? "").replace(/\.$/, "").trim();
      this.name = v || UNTITLED;
      this.renderTitle();
      this.hooks.changed();
    });

    this.editor.addEventListener("focus", () => this.hooks.setNoting(true));
    this.editor.addEventListener("pointerdown", () => this.hooks.setNoting(true));
    this.editor.addEventListener("input", () => {
      this.updateEmpty();
      this.hooks.changed();
    });
    // a space typed right after a citation means "done citing": stop the animation
    this.editor.addEventListener("keydown", (e) => {
      if (e.key === " " && this.justAfterCitation()) this.hooks.doneCiting();
    });
    // pasted text only, so the notes stay clean
    this.editor.addEventListener("paste", (e) => {
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
    });
    this.editor.addEventListener("click", (e) => {
      const cite = (e.target as HTMLElement).closest<HTMLElement>(".cite");
      const ref = cite && this.refs.get(cite.dataset.ref!);
      if (ref) {
        e.preventDefault();
        this.hooks.openRef(ref);
      }
    });
    // hover a citation for a preview of what it points at
    this.editor.addEventListener("pointerover", (e) => {
      const cite = (e.target as HTMLElement).closest<HTMLElement>(".cite");
      const ref = cite && this.refs.get(cite.dataset.ref!);
      if (cite && ref) this.showPreview(cite, ref);
    });
    this.editor.addEventListener("pointerout", (e) => {
      if ((e.target as HTMLElement).closest(".cite")) this.preview.hidden = true;
    });
    this.updateEmpty();
  }

  get projectName() {
    return this.name;
  }

  /** True while the cursor is in the notes, so a click on a window cites it. */
  get writing() {
    return document.activeElement === this.editor;
  }

  setStatus(text: string) {
    this.status.textContent = text;
  }

  /** Cites a window at the cursor (or at the end), e.g. "[2.3]", and keeps the cursor after it. */
  cite(ref: Omit<NoteRef, "id" | "num">) {
    let num = this.numbers.get(ref.docId);
    if (!num) {
      num = this.numbers.size + 1;
      this.numbers.set(ref.docId, num);
    }
    const full: NoteRef = { ...ref, id: `r${++nextRef}`, num };
    this.refs.set(full.id, full);
    const el = this.citeEl(full);

    const sel = getSelection();
    let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !this.editor.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(this.editor);
      range.collapse(false);
    }
    range.deleteContents();
    // a space before the citation if it would touch a word or another citation
    const before = range.startContainer.nodeType === Node.TEXT_NODE ? (range.startContainer.textContent ?? "").slice(0, range.startOffset) : "";
    if ((before && !/\s$/.test(before)) || (!before && this.justAfterCitation())) range.insertNode(document.createTextNode(" "));
    range.collapse(false);
    range.insertNode(el);
    // the cursor goes right after the citation
    const after = document.createRange();
    after.setStartAfter(el);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    this.editor.focus();
    this.updateEmpty();
    this.hooks.changed();
  }

  /** The notes as data, for saving in a project file. */
  data(): NotesData {
    const lines: NoteLine[] = [];
    let line: NoteLine = [];
    const pushText = (t: string) => {
      if (!t) return;
      const last = line[line.length - 1];
      if (typeof last === "string") line[line.length - 1] = last + t;
      else line.push(t);
    };
    const endLine = () => {
      lines.push(line);
      line = [];
    };
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return pushText(node.textContent ?? "");
      if (!(node instanceof HTMLElement)) return;
      if (node.classList.contains("cite")) {
        const ref = this.refs.get(node.dataset.ref!);
        if (ref) line.push({ ref });
        return;
      }
      if (node.tagName === "BR") return endLine();
      const block = node.tagName === "DIV" || node.tagName === "P";
      if (block && line.length) endLine();
      node.childNodes.forEach(walk);
      if (block && line.length) endLine();
    };
    this.editor.childNodes.forEach(walk);
    if (line.length) endLine();
    while (lines.length && !lines[lines.length - 1].length) lines.pop();
    return { name: this.name, lines };
  }

  /**
   * Loads notes from a project. `docIds` maps the project's image ids to the
   * ids of the reopened windows. Older projects stored references as cards
   * ("blocks"); those become citations.
   */
  load(data: NotesData & { blocks?: ({ type: "text"; text: string } | { type: "ref"; ref: NoteRef })[] }, docIds: Map<string, string>) {
    this.name = data.name || UNTITLED;
    this.renderTitle();
    this.refs.clear();
    this.numbers.clear();
    this.editor.innerHTML = "";
    const lines: NoteLine[] =
      data.lines ??
      (data.blocks ?? []).flatMap((b): NoteLine[] => (b.type === "text" ? b.text.split("\n").map((t) => [t]) : [[{ ref: b.ref }]]));
    for (const segs of lines) {
      const div = document.createElement("div");
      for (const seg of segs) {
        if (typeof seg === "string") div.append(seg);
        else {
          const docId = docIds.get(seg.ref.docId) ?? seg.ref.docId;
          let num = this.numbers.get(docId);
          if (!num) {
            num = seg.ref.num ?? this.numbers.size + 1;
            this.numbers.set(docId, num);
          }
          const ref: NoteRef = { ...seg.ref, id: `r${++nextRef}`, docId, num };
          this.refs.set(ref.id, ref);
          div.append(this.citeEl(ref));
        }
      }
      if (!div.childNodes.length) div.append(document.createElement("br"));
      this.editor.append(div);
    }
    this.updateEmpty();
  }

  /** The notes as Markdown: citations stay inline and are listed as footnotes. */
  markdown(): string {
    const out = [`# ${this.name}`, ""];
    const cited = new Map<string, NoteRef>();
    for (const line of this.data().lines) {
      out.push(
        line
          .map((seg) => {
            if (typeof seg === "string") return seg;
            const label = this.label(seg.ref);
            cited.set(`${label}|${seg.ref.time}`, seg.ref);
            return `[${label}]`;
          })
          .join(""),
      );
    }
    if (cited.size) {
      out.push("", "---", "");
      for (const r of cited.values()) {
        const steps = r.stepTitles.length ? r.stepTitles.join(" → ") : "no processing";
        out.push(`[${this.label(r)}]: ${r.name}, step ${r.marker} of ${r.steps} (${steps})${r.view.slices > 1 ? `, slice ${r.view.pos.z + 1}` : ""}, ${new Date(r.time).toLocaleString()}`);
      }
    }
    return out.join("\n");
  }

  private label(ref: NoteRef) {
    return `${ref.num ?? "?"}.${ref.marker}`;
  }

  private justAfterCitation(): boolean {
    const sel = getSelection();
    if (!sel || !sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const prev =
      node.nodeType === Node.TEXT_NODE ? (r.startOffset === 0 ? node.previousSibling : null) : node.childNodes[r.startOffset - 1] ?? null;
    return prev instanceof HTMLElement && prev.classList.contains("cite");
  }

  private editTitle() {
    if (this.title.isContentEditable) return;
    this.title.contentEditable = "true";
    this.title.textContent = this.name;
    this.title.focus();
    getSelection()?.selectAllChildren(this.title);
  }

  private renderTitle() {
    this.title.textContent = `${this.name}.`;
    this.title.classList.toggle("untitled", this.name === UNTITLED);
  }

  private updateEmpty() {
    this.editor.classList.toggle("empty", !this.editor.textContent?.trim() && !this.editor.querySelector(".cite"));
  }

  private citeEl(ref: NoteRef): HTMLElement {
    const a = document.createElement("a");
    a.className = "cite";
    a.contentEditable = "false";
    a.dataset.ref = ref.id;
    a.href = "#";
    a.textContent = `[${this.label(ref)}]`;
    a.setAttribute("aria-label", `${ref.name} at step ${ref.marker}: show it as it was`);
    return a;
  }

  private showPreview(anchor: HTMLElement, ref: NoteRef) {
    const when = new Date(ref.time);
    const sameDay = when.toDateString() === new Date().toDateString();
    const stamp = sameDay ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : when.toLocaleDateString([], { day: "numeric", month: "short" });
    this.preview.innerHTML = `<img src="${ref.thumb}" alt="" />
      <strong>${escapeHtml(ref.name)}</strong>
      <small>step ${ref.marker} of ${ref.steps}${ref.view.slices > 1 ? ` · slice ${ref.view.pos.z + 1}` : ""} · ${escapeHtml(stamp)}</small>
      <small class="muted">Click to show it as it was</small>`;
    this.preview.hidden = false;
    const r = anchor.getBoundingClientRect();
    const p = this.preview.getBoundingClientRect();
    this.preview.style.left = `${Math.min(innerWidth - p.width - 8, Math.max(8, r.left))}px`;
    this.preview.style.top = `${r.bottom + 6 + p.height > innerHeight ? r.top - p.height - 6 : r.bottom + 6}px`;
  }
}
