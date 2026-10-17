/**
 * The assistant's replies as HTML: paragraphs, bullet and numbered lists,
 * bold, and citations ("[2]" for window 2, "[2.1]" for the first run in its
 * history) that bring that window forward when clicked. Everything else in
 * the text stays text. No DOM here, so it's tested in Node.
 */
import { escapeHtml } from "./format.js";

/** What a citation in a reply points at: a window, or a run in its history, as it was when the reply came. */
export interface CiteTarget {
  windowId: string;
  /** The run's id, and its place in the history, for a run. */
  block?: string;
  run?: number;
  /** "bracket.step" or "run 2 in bracket.step", for the citation's label. */
  label: string;
}

/**
 * A reply's text as HTML, its citations as buttons: "[2]" a window, "[2.1]"
 * a run in its history, "[1, 2.1]" both. A reference the reply doesn't know
 * (made up, or for a window that wasn't open) stays plain text.
 */
export function citedHtml(text: string, cites: Record<string, CiteTarget>, message: number): string {
  return escapeHtml(text).replace(/\[(\d{1,3}(?:\.\d{1,3})?(?:,\s*\d{1,3}(?:\.\d{1,3})?)*)\]/g, (whole, list: string) => {
    const refs = list.split(/,\s*/);
    if (!refs.some((r) => cites[r])) return whole;
    return refs
      .map((r) => {
        const t = cites[r];
        return t ? `<button type="button" class="cite" data-cite="${r}" data-msg="${message}" aria-label="Show ${escapeHtml(t.label)}" title="Show ${escapeHtml(t.label)}">[${r}]</button>` : `[${r}]`;
      })
      .join("");
  });
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+/;

/** A reply as HTML: blank lines part paragraphs, "- " and "1. " lines make lists, **bold** is bold. */
export function replyHtml(text: string, cites: Record<string, CiteTarget>, message: number): string {
  const inline = (line: string) =>
    citedHtml(line.replace(/^#{1,4}\s+(.+)$/, "**$1**"), cites, message).replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  const out: string[] = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    let lines: string[] = [];
    let list: { tag: "ul" | "ol"; items: string[] } | null = null;
    const flush = () => {
      if (lines.length) out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      lines = [];
      list = null;
    };
    for (const line of block.split("\n")) {
      const tag = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
      if (tag) {
        if (lines.length || (list && list.tag !== tag)) flush();
        list ??= { tag, items: [] };
        list.items.push(line.replace(tag === "ul" ? BULLET : NUMBERED, ""));
      } else if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`; // a list item carried on to the next line
      } else {
        if (list) flush();
        lines.push(line);
      }
    }
    flush();
  }
  return out.join("");
}
