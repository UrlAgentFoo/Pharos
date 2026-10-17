import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiClient } from "../src/ai.js";
import { TokenMeter, metered } from "../src/token-usage.js";

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
    expect(view.today).toEqual({ "claude-opus-5-5": { requests: 1, input: 20, cachedInput: 0, output: 5 }, "claude-haiku-5-5": { requests: 1, input: 7, cachedInput: 0, output: 3 } });
    expect(view.total["claude-opus-5-5"]).toEqual({ requests: 2, input: 1520, cachedInput: 1000, output: 55 });

    await meter.flushed();
    expect((await TokenMeter.load(dir, () => day)).view()).toEqual(view);
  });

  it("drops what isn't a count from the file", async () => {
    await writeFile(join(dir, "usage.json"), JSON.stringify({ days: { "2026-10-01": { m: { requests: 2, input: "lots", output: -4 } }, yesterday: { m: { requests: 9 } } } }));
    const meter = await TokenMeter.load(dir, () => "2026-10-17");
    expect(meter.view()).toEqual({ since: "2026-10-01", today: {}, total: { m: { requests: 2, input: 0, cachedInput: 0, output: 0 } } });
    await writeFile(join(dir, "usage.json"), "not json");
    expect((await TokenMeter.load(dir)).view().since).toBeNull();
    expect(await readFile(join(dir, "usage.json"), "utf8")).toBe("not json"); // only rewritten once there's something to count
  });
});
