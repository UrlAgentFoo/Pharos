import { describe, expect, it } from "vitest";
import { tokenUsageHtml, tokens } from "../src/token-usage.js";

const models = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
const count = (input: number, output: number, requests = 1) => ({ requests, input, cachedInput: Math.floor(input / 2), output });
const cells = (html: string) => [...html.slice(html.indexOf("<tbody>")).matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);

describe("token usage in Settings", () => {
  it("reads as people count", () => {
    expect([tokens(980), tokens(48_213), tokens(1_240_000)]).toEqual(["980", "48.2K", "1.2M"]);
  });

  it("says what will appear before anything is counted", () => {
    expect(tokenUsageHtml(undefined, models, "2026-10-17")).toContain("None yet");
    expect(tokenUsageHtml({ since: null, today: {}, total: {} }, models, "2026-10-17")).not.toContain("<table");
  });

  it("shows today and the total, and each model's share when there's more than one", () => {
    const html = tokenUsageHtml(
      { since: "2026-10-01", today: { "claude-opus-5-5": count(1000, 100) }, total: { "claude-opus-5-5": count(1_200_000, 40_000, 9), "claude-haiku-5-5": count(5000, 300, 3) } },
      models,
      "2026-10-17",
    );
    expect(html).toContain("Since 1 Oct");
    expect(cells(html)).toEqual(["1K", "1.2M", "500", "602.5K", "100", "40.3K", "1", "12"]);
    expect(html).toContain("By model, since 1 Oct: Claude Opus 5.5 1.2M in, 40K out · Claude Haiku 5.5 5K in, 300 out.");
  });

  it("keeps one column on the first day, and names the only model", () => {
    const html = tokenUsageHtml({ since: "2026-10-17", today: { "claude-opus-5-5": count(10, 2) }, total: { "claude-opus-5-5": count(10, 2) } }, models, "2026-10-17");
    expect(html).not.toContain("Since");
    expect(cells(html)).toEqual(["10", "5", "2", "1"]);
    expect(html).toContain("all with Claude Opus 5.5");
    expect(html).not.toContain("By model");
  });
});
