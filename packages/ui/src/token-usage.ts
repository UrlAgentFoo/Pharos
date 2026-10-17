/**
 * The assistant's token usage as Settings shows it: today and since counting
 * began, then each model's share when more than one was used.
 */
import type { TokenCount, TokenUsage } from "./api.js";
import { escapeHtml } from "./format.js";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** A token count as people read it: 980, 48.2K, 1.2M. */
export const tokens = (n: number) => compact.format(n);

function sum(counts: Record<string, TokenCount>): TokenCount {
  const t = { requests: 0, input: 0, cachedInput: 0, output: 0 };
  for (const c of Object.values(counts)) {
    t.requests += c.requests;
    t.input += c.input;
    t.cachedInput += c.cachedInput;
    t.output += c.output;
  }
  return t;
}

/** "1 Oct" from "2026-10-01". */
function dayTitle(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function tokenUsageHtml(usage: TokenUsage | undefined, models: readonly { id: string; label: string }[], today: string): string {
  const head = `<p class="eyebrow">Token usage</p>`;
  if (!usage?.since) return `<section class="usage">${head}<p class="muted small">None yet. Each reply's tokens are counted here once you ask the assistant something.</p></section>`;
  // counting began today: both columns would be the same
  const columns: [string, TokenCount][] = [["Today", sum(usage.today)], ...(usage.since === today ? [] : [[`Since ${dayTitle(usage.since)}`, sum(usage.total)] as [string, TokenCount]])];
  const row = (label: string, value: (c: TokenCount) => string, sub = false) =>
    `<tr${sub ? ` class="sub"` : ""}><th scope="row">${label}</th>${columns.map(([, c]) => `<td>${value(c)}</td>`).join("")}</tr>`;
  const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
  const used = Object.entries(usage.total).sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  const byModel =
    used.length > 1
      ? `<p class="muted small">By model, since ${escapeHtml(dayTitle(usage.since))}: ${used.map(([id, c]) => `${escapeHtml(label(id))} ${tokens(c.input)} in, ${tokens(c.output)} out`).join(" · ")}.</p>`
      : "";
  return `<section class="usage">${head}
    <table class="usage-table">
      <thead><tr><td></td>${columns.map(([title]) => `<th scope="col">${escapeHtml(title)}</th>`).join("")}</tr></thead>
      <tbody>
        ${row("Input tokens", (c) => tokens(c.input))}
        ${row("from the cache", (c) => tokens(c.cachedInput), true)}
        ${row("Output tokens", (c) => tokens(c.output))}
        ${row("Replies", (c) => tokens(c.requests))}
      </tbody>
    </table>
    ${byModel}
    <p class="muted small">Counted by Pharos on this computer${used.length === 1 ? `, all with ${escapeHtml(label(used[0][0]))}` : ""}. Your Anthropic Console shows what's billed.</p>
  </section>`;
}

/** Today on this computer's clock, as the server keeps days: YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
