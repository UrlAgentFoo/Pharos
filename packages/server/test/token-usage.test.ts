import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiClient } from "../src/ai.js";
import { TokenMeter, metered, replyCost } from "../src/token-usage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pharos-tokens-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reply = (model: string, usage: Record<string, number | null> | null) => ({ model, usage, content: [] });
/** A fake client whose replies come from a queue. */
const fake = (replies: unknown[]): AiClient => ({ beta: { messages: { create: async () => replies.shift() } } }) as unknown as AiClient;

describe("token usage", () => {
  it("counts each reply by day and model, cached input included, and keeps it on disk", async () => {
    let day = "2026-10-16";
    const meter = await TokenMeter.load(dir, () => day);
    const client = metered(
      fake([
        reply("claude-opus-5-5", { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 1000, output_tokens: 50 }),
        reply("claude-opus-5-5", { input_tokens: 20, cache_read_input_tokens: null, output_tokens: 5 }),
        reply("claude-haiku-5-5", { input_tokens: 7, output_tokens: 3 }),
        reply("claude-opus-5-5", null), // nothing to count
      ]),
      meter,
    );
    const ask = () => client.beta.messages.create({ model: "x", max_tokens: 1, messages: [] });
    await ask();
    day = "2026-10-17";
    await ask();
    const got = await ask();
    expect(got).toMatchObject({ model: "claude-haiku-5-5" }); // the reply itself passes through
    await ask();

    const view = meter.view();
    expect(view.since).toBe("2026-10-16");
    expect(Object.keys(view.today)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(view.today["claude-opus-5-5"]).toMatchObject({ requests: 1, input: 20, cachedInput: 0, cacheWrite: 0, output: 5, unpriced: 0 });
    expect(view.total["claude-opus-5-5"]).toMatchObject({ requests: 2, input: 1520, cachedInput: 1000, cacheWrite: 400, output: 55 });
    // $4 in, $5 for 5-minute cache writes, $0.20 cache reads and $20 out, per million
    expect(view.total["claude-opus-5-5"].costUsd).toBeCloseTo((100 * 4 + 400 * 5 + 1000 * 0.2 + 50 * 20 + 20 * 4 + 5 * 20) / 1e6, 12);

    await meter.flushed();
    expect((await TokenMeter.load(dir, () => day)).view()).toEqual(view);
  });

  it("prices a reply at its model's list price, Haiku's by the size of its prompt", () => {
    expect(replyCost("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(12);
    expect(replyCost("claude-haiku-5-5", { input_tokens: 90_000, output_tokens: 1000 })).toBeCloseTo((90_000 * 0.1 + 1000 * 0.5) / 1e6);
    // over 100,000 tokens of prompt, cache reads counting, every token costs Haiku's higher price
    expect(replyCost("claude-haiku-5-5", { input_tokens: 10_000, cache_read_input_tokens: 95_000, output_tokens: 1000 })).toBeCloseTo((10_000 * 0.5 + 95_000 * 0.05 + 1000 * 2.5) / 1e6);
    // hour-long cache writes cost twice the input price
    expect(replyCost("claude-opus-5-5", { input_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 400 } } as never)).toBeCloseTo((600 * 5 + 400 * 8) / 1e6);
    expect(replyCost("claude-opus-5-5-20261001", { input_tokens: 1e6 })).toBeCloseTo(4);
    expect(replyCost("claude-unknown-9", { input_tokens: 1e6 })).toBeNull();
  });

  it("counts replies from a model it has no price for apart, rather than as free", async () => {
    const meter = await TokenMeter.load(dir, () => "2026-10-17");
    meter.add(reply("claude-unknown-9", { input_tokens: 10, output_tokens: 2 }));
    expect(meter.view().today["claude-unknown-9"]).toMatchObject({ requests: 1, costUsd: 0, unpriced: 1 });
    await meter.flushed(); // before the folder goes
  });

  it("drops what isn't a count from the file, and prices what was counted before prices were", async () => {
    await writeFile(
      join(dir, "usage.json"),
      JSON.stringify({ days: { "2026-10-01": { m: { requests: 2, input: "lots", output: -4 }, "claude-opus-5-5": { requests: 1, input: 1500, cachedInput: 1000, output: 50 } }, yesterday: { m: { requests: 9 } } } }),
    );
    const meter = await TokenMeter.load(dir, () => "2026-10-17");
    const view = meter.view();
    expect(view.since).toBe("2026-10-01");
    expect(view.total.m).toEqual({ requests: 2, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, costUsd: 0, unpriced: 2 });
    expect(view.total["claude-opus-5-5"].costUsd).toBeCloseTo((500 * 4 + 1000 * 0.2 + 50 * 20) / 1e6, 12);
    await writeFile(join(dir, "usage.json"), "not json");
    expect((await TokenMeter.load(dir)).view().since).toBeNull();
    expect(await readFile(join(dir, "usage.json"), "utf8")).toBe("not json"); // only rewritten once there's something to count
  });
});
