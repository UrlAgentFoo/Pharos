/**
 * The assistant's token usage as Settings shows it: today and since counting
 * began, with what it cost at list prices, then each model's share when more
 * than one was used.
 */
import type { TokenCount, TokenUsage } from "./api.js";
import { escapeHtml } from "./format.js";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A token count as people read it: 980, 48.2K, 1.2M. */
export const tokens = (n: number) => compact.format(n);

/** A cost as people read it: $0.42, $1,204.10; under a cent, "<$0.01", so a little never reads as nothing. */
export const cost = (usd: number) => (usd > 0 && usd < 0.005 ? "<$0.01" : dollars.format(usd));

function sum(counts: Record<string, TokenCount>): TokenCount {
  const t: TokenCount = { requests: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, costUsd: 0, unpriced: 0 };
  for (const c of Object.values(counts)) for (const k of Object.keys(t) as (keyof TokenCount)[]) t[k] += c[k] ?? 0;
  return t;
}

/** "1 Oct" from "2026-10-01"; with the year, "1 Oct 2026". */
function dayTitle(day: string, year = false) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
}

export function tokenUsageHtml(usage: TokenUsage | undefined, models: readonly { id: string; label: string }[], today: string): string {
  const head = `<p class="eyebrow">Token usage</p>`;
  if (!usage?.since) return `<section class="usage">${head}<p class="muted small">None yet. Each reply's tokens and cost are counted here once you ask the assistant something.</p></section>`;
  // counting began today: both columns would be the same
  const columns: [string, TokenCount][] = [["Today", sum(usage.today)], ...(usage.since === today ? [] : [[`Since ${dayTitle(usage.since)}`, sum(usage.total)] as [string, TokenCount]])];
  const row = (label: string, value: (c: TokenCount) => string, cls = "") =>
    `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${label}</th>${columns.map(([, c]) => `<td>${value(c)}</td>`).join("")}</tr>`;
  const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
  const used = Object.entries(usage.total).sort((a, b) => b[1].costUsd - a[1].costUsd || b[1].input + b[1].output - (a[1].input + a[1].output));
  const byModel =
    used.length > 1
      ? `<p class="muted small">By model, since ${escapeHtml(dayTitle(usage.since))}: ${used.map(([id, c]) => `${escapeHtml(label(id))} ${tokens(c.input)} in, ${tokens(c.output)} out${c.unpriced < c.requests ? `, ${escapeHtml(cost(c.costUsd))}` : ""}`).join(" · ")}.</p>`
      : "";
  const unpriced = sum(usage.total).unpriced;
  const left = unpriced ? ` It leaves out ${unpriced} ${unpriced === 1 ? "reply" : "replies"} from a model with no price listed.` : "";
  return `<section class="usage">${head}
    <table class="usage-table">
      <thead><tr><td></td>${columns.map(([title]) => `<th scope="col">${escapeHtml(title)}</th>`).join("")}</tr></thead>
      <tbody>
        ${row("Input tokens", (c) => tokens(c.input))}
        ${row("from the cache", (c) => tokens(c.cachedInput), "sub")}
        ${row("Output tokens", (c) => tokens(c.output))}
        ${row("Replies", (c) => tokens(c.requests))}
        ${row("Estimated cost", (c) => escapeHtml(cost(c.costUsd)), "cost")}
      </tbody>
    </table>
    ${byModel}
    <p class="muted small">Counted by Pharos on this computer${used.length === 1 ? `, all with ${escapeHtml(label(used[0][0]))}` : ""}, and priced at Anthropic's list prices of ${escapeHtml(dayTitle(usage.pricesAsOf, true))}.${left} Your Anthropic Console shows what's billed.</p>
  </section>`;
}

/** Today on this computer's clock, as the server keeps days: YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
