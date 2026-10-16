/**
 * File-based shortlisting, before any model is involved: every book's
 * `accepts` is checked against the dropped data's summary.
 *
 * - excluded: wrong kind, missing axes, too many channels, a data type or
 *   size it can't take, or a GPU this machine lacks; the reasons are kept;
 * - convert: readable after a converter ship;
 * - direct: read as it is.
 *
 * What's left is ranked by tier, then trust (verified first), then how
 * well the user's words match the book's title, summary, tags and guide.
 */
import type { AcceptedFormats } from "@pharos/books";
import type { Accepts, BookManifest, BookMatch, CatalogueEntry, DataSummary, TrustLevel } from "@pharos/contracts";

export interface MatchableBook {
  entry: CatalogueEntry;
  manifest: BookManifest;
  accepts: AcceptedFormats[];
  guide?: string;
}

const TIER_SCORE = { direct: 100, convert: 60, excluded: 0 } as const;
const TRUST_SCORE: Record<TrustLevel, number> = { verified: 20, verifying: 8, imported: 0 };

/** Lowercase words of three letters or more, without very common ones. */
export function words(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "want", "need", "please", "can", "how", "what", "data", "file", "files", "image", "images", "some", "all", "each", "every", "per"]);
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 3 && !stop.has(w));
}

/** How many of the request's words appear in the book (prefix matches count: "track" ~ "tracking"). */
function keywordScore(book: MatchableBook, request: string[]): { score: number; hits: string[] } {
  if (!request.length) return { score: 0, hits: [] };
  const hay = words(`${book.manifest.title} ${book.manifest.summary} ${(book.manifest.tags ?? []).join(" ")} ${book.manifest.id.replace(/-/g, " ")}`);
  const guide = words(book.guide ?? "");
  const hits: string[] = [];
  let score = 0;
  for (const w of request) {
    const stem = w.slice(0, Math.max(4, w.length - 3));
    if (hay.some((h) => h.startsWith(stem) || w.startsWith(h.slice(0, Math.max(4, h.length - 3))))) (score += 10), hits.push(w);
    else if (guide.some((h) => h.startsWith(stem))) (score += 3), hits.push(w);
  }
  return { score, hits };
}

/** Why `data` can't go into an input that accepts `accepts`, or null if it can. */
export function acceptProblems(accepts: Accepts, data: DataSummary): string[] {
  const out: string[] = [];
  if (accepts.kind !== data.kind) return [`needs ${accepts.kind} data, this is ${data.kind}`];
  if (accepts.axes && data.axes) {
    const missing = [...accepts.axes].filter((a) => !data.axes!.includes(a));
    if (missing.length) out.push(`needs axes ${accepts.axes}, this has ${data.axes} (no ${missing.join(", ")})`);
  }
  if (accepts.channels !== undefined && data.channels !== undefined) {
    const [lo, hi] = typeof accepts.channels === "number" ? [accepts.channels, accepts.channels] : accepts.channels.split("-").map(Number).concat(NaN).slice(0, 2);
    const max = Number.isNaN(hi) ? lo : hi;
    if (data.channels < lo || data.channels > max) out.push(`takes ${accepts.channels} channel(s), this has ${data.channels}`);
  }
  if (accepts.dtype && data.dtype && !accepts.dtype.includes(data.dtype)) out.push(`takes ${accepts.dtype.join(", ")} data, this is ${data.dtype}`);
  if (accepts.max_size_gb && data.sizeBytes > accepts.max_size_gb * 1024 ** 3) out.push(`takes up to ${accepts.max_size_gb} GB, this is larger`);
  return out;
}

export function matchBooks(books: MatchableBook[], data: DataSummary[], opts: { text?: string; gpu: boolean }): BookMatch[] {
  const request = words(opts.text ?? "");
  const out: BookMatch[] = books.map((book) => {
    const reasons: string[] = [];
    let tier: BookMatch["tier"] = "direct";
    if (book.entry.gpu === "required" && !opts.gpu) {
      return { book: book.entry, tier: "excluded", reasons: ["needs an NVIDIA GPU, which this machine doesn't have"], score: 0 };
    }
    const inputs = book.manifest.inputs ?? [];
    if (!inputs.length) {
      // starts from parameters alone: only the request can pick it
      const k = keywordScore(book, request);
      if (!k.hits.length) return { book: book.entry, tier: "excluded", reasons: ["takes no data; describe what you want to run it"], score: 0 };
      return { book: book.entry, tier: "direct", reasons: [`matches "${k.hits.join(", ")}"`], score: 40 + TRUST_SCORE[book.entry.trust] + k.score };
    }
    for (const input of inputs) {
      const formats = book.accepts.find((a) => a.input === input.name);
      // the best file for this input: direct beats conversion beats nothing
      let best: { tier: "direct" | "convert"; why: string } | undefined;
      const problems: string[] = [];
      for (const d of data) {
        const p = acceptProblems(input.accepts, d);
        if (p.length) {
          problems.push(...p.map((x) => `${d.name}: ${x}`));
          continue;
        }
        if (!formats || formats.direct.includes(d.format)) best = { tier: "direct", why: `${input.name} ← ${d.name}` };
        else {
          const via = formats.converted.find((c) => c.format === d.format)?.via;
          if (via) best ??= { tier: "convert", why: `${input.name} ← ${d.name}, converted by ${via}` };
          else problems.push(`${d.name}: reads ${[...formats.direct, ...formats.converted.map((c) => c.format)].join(", ")}, not ${d.format}`);
        }
        if (best?.tier === "direct") break;
      }
      if (!best) {
        return { book: book.entry, tier: "excluded", reasons: problems.length ? problems : [`needs ${input.accepts.kind} data for "${input.name}"`], score: 0 };
      }
      if (best.tier === "convert") tier = "convert";
      reasons.push(best.why);
    }
    const k = keywordScore(book, request);
    if (k.hits.length) reasons.push(`matches "${k.hits.join(", ")}"`);
    return { book: book.entry, tier, reasons, score: TIER_SCORE[tier] + TRUST_SCORE[book.entry.trust] + k.score };
  });
  return out.sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title));
}
