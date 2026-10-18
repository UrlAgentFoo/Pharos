import { describe, expect, it } from "vitest";
import { cost, tokenUsageHtml, tokens } from "../src/token-usage.js";

const models = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
const count = (input: number, output: number, costUsd: number, requests = 1, unpriced = 0) => ({ requests, input, cachedInput: Math.floor(input / 2), cacheWrite: 0, output, costUsd, unpriced });
const cells = (html: string) => [...html.slice(html.indexOf("<tbody>")).matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
const AS_OF = "2026-10-17";

describe("token usage in Settings", () => {
  it("reads as people count", () => {
    expect([tokens(980), tokens(48_213), tokens(1_240_000)]).toEqual(["980", "48.2K", "1.2M"]);
    expect([cost(0), cost(0.0004), cost(0.42), cost(1204.1)]).toEqual(["$0.00", "<$0.01", "$0.42", "$1,204.10"]);
  });

  it("says what will appear before anything is counted", () => {
    expect(tokenUsageHtml(undefined, models, "2026-10-17")).toContain("None yet");
    expect(tokenUsageHtml({ since: null, today: {}, total: {}, pricesAsOf: AS_OF }, models, "2026-10-17")).not.toContain("<table");
  });

  it("shows today and the total with their cost, and each model's share when there's more than one", () => {
    const html = tokenUsageHtml(
      { since: "2026-10-01", today: { "claude-opus-5-5": count(1000, 100, 0.0031) }, total: { "claude-opus-5-5": count(1_200_000, 40_000, 3.81, 9), "claude-haiku-5-5": count(5000, 300, 0.0007, 3) }, pricesAsOf: AS_OF },
      models,
      "2026-10-17",
    );
    expect(html).toContain("Since 1 Oct");
    expect(cells(html)).toEqual(["1K", "1.2M", "500", "602.5K", "100", "40.3K", "1", "12", "&#60;$0.01", "$3.81"]);
    expect(html).toContain("By model, since 1 Oct: Claude Opus 5.5 1.2M in, 40K out, $3.81 · Claude Haiku 5.5 5K in, 300 out, &#60;$0.01.");
    expect(html).toContain("list prices of 17 Oct 2026");
  });

  it("keeps one column on the first day, names the only model, and says what it couldn't price", () => {
    const html = tokenUsageHtml({ since: "2026-10-17", today: { "claude-opus-5-5": count(10, 2, 0) }, total: { "claude-opus-5-5": count(10, 2, 0, 3, 2) }, pricesAsOf: AS_OF }, models, "2026-10-17");
    expect(html).not.toContain("Since");
    expect(cells(html)).toEqual(["10", "5", "2", "1", "$0.00"]);
    expect(html).toContain("all with Claude Opus 5.5");
    expect(html).toContain("It leaves out 2 replies from a model with no price listed.");
    expect(html).not.toContain("By model");
  });
});
