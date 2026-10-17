import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantPlan, Plan } from "@pharos/contracts";
import type { AiClient } from "../src/ai.js";
import { type RunningServer, startServer } from "../src/server.js";

const HELLO = fileURLToPath(new URL("../../../ships/hello", import.meta.url));
const TOKEN = "assistant-token-0123456789";

const BOOK = `id: count-rows
version: 0.1.0
title: Count the rows of a table
summary: Counts how many rows a table has.
tags: [test, tables]
ships: { hello: ^0.1 }
actions:
  count:
    title: Count the rows
    inputs: [{ name: table, accepts: { kind: table } }]
    parameters:
      - { name: wait, type: integer, default: 0, min: 0, max: 30, sets: count.seconds }
    steps:
      - { id: count, run: hello.count, in: { table: $table } }
    outputs: { rows: count.count }
`;

/** A fake model: replies come from a queue; requests are recorded. */
const requests: Record<string, unknown>[] = [];
let replies: unknown[][] = [];
const toolUse = (name: string, input: unknown) => ({ type: "tool_use", id: `tu_${requests.length}`, name, input });
const fakeAi = (): AiClient =>
  ({
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          const content = replies.shift() ?? [{ type: "text", text: "(no reply scripted)" }];
          return { model: body.model, stop_reason: content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", content, usage: { input_tokens: 10, output_tokens: 2 } };
        },
      },
    },
  }) as unknown as AiClient;

let tmp: string;
let server: RunningServer;
let table: string;
const send = (path: string, body: unknown) =>
  fetch(`${server.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "x-pharos-token": TOKEN, "content-type": "application/json" } });
const ask = async (text: string): Promise<AssistantPlan> => (await send("/api/assistant/plan", { workspace: "w", text, artifacts: [table] })).json();

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-assist-"));
  const lib = join(tmp, "lib");
  await cp(HELLO, join(lib, "ships", "hello"), { recursive: true });
  await mkdir(join(lib, "books", "count-rows"), { recursive: true });
  await writeFile(join(lib, "books", "count-rows", "book.yaml"), BOOK);
  await writeFile(join(lib, "books", "count-rows", "GUIDE.md"), "# Count rows\n## When to use\nAny question about how many rows or records a table has.\n## When not to use\n## Parameters\n## Example\n");
  await mkdir(join(tmp, "ui"));
  await writeFile(join(tmp, "ui", "index.html"), "<!doctype html>");
  await writeFile(join(tmp, "cells.csv"), "label,area\n1,2\n");
  server = await startServer({ port: 0, uiDir: join(tmp, "ui"), token: TOKEN, configDir: join(tmp, "config"), dataDir: join(tmp, "data"), libraryDirs: [lib], aiClient: fakeAi });
  await send("/api/workspaces", { name: "w" });
  table = (await (await send("/api/workspaces/w/artifacts", { path: join(tmp, "cells.csv") })).json()).id;
});

afterAll(async () => {
  await server?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("assistant planning", () => {
  it("picks a shortlisted book, binds the data and sets parameters", async () => {
    replies = [[{ type: "text", text: "Counting rows." }, toolUse("choose_book", { book: "count-rows", action: "count", inputs: { table: 1 }, parameters: { wait: 2 }, rationale: "The table is a CSV; this book counts its rows." })]];
    const r = await ask("how many cells are in this table?");
    expect(r.plan).toMatchObject({ source: "book", book: { id: "count-rows", action: "count" }, inputs: { table }, parameters: { wait: 2 }, problems: [], status: "proposed", rationale: "The table is a CSV; this book counts its rows." });
    expect(r.matches[0]).toMatchObject({ book: { id: "count-rows" }, tier: "direct", actions: ["count"] });

    // what the model saw: summaries and the book's guide, not the file itself
    const req = requests.at(-1)!;
    const prompt = JSON.stringify(req.messages);
    expect(prompt).toContain('\\"columns\\":[\\"label\\",\\"area\\"]');
    expect(prompt).toContain("Any question about how many rows");
    expect(prompt).not.toContain(tmp);
    expect(req).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" }, fallbacks: "default" });
    expect(JSON.stringify(req.system)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it("sends the check's problems back once and keeps only the repaired plan", async () => {
    replies = [
      [toolUse("choose_book", { book: "count-rows", inputs: { table: 1 }, parameters: { wait: 99 }, rationale: "Slow count." })],
      [toolUse("choose_book", { book: "count-rows", inputs: { table: 1 }, parameters: { wait: 30 }, rationale: "Slow count, within limits." })],
    ];
    const before = requests.length;
    const r = await ask("count slowly");
    expect(requests.length - before).toBe(2);
    const repair = JSON.stringify((requests.at(-1)!.messages as unknown[]).at(-1));
    expect(repair).toContain('\\"wait\\" must be between 0 and 30');
    expect(r.plan).toMatchObject({ parameters: { wait: 30 }, problems: [] });
  });

  it("rejects books that aren't on the shortlist and asks again", async () => {
    replies = [
      [toolUse("choose_book", { book: "made-up", inputs: { table: 1 }, rationale: "?" })],
      [toolUse("choose_book", { book: "count-rows", inputs: { table: 1 }, rationale: "Counts rows." })],
    ];
    const r = await ask("count rows");
    expect(JSON.stringify((requests.at(-1)!.messages as unknown[]).at(-1))).toContain(`isn't on the shortlist`);
    expect(r.plan?.book?.id).toBe("count-rows");
  });

  it("improvises from ship operations when no book fits", async () => {
    replies = [[toolUse("improvise", { title: "Count twice", inputs: { data: 1 }, steps: [{ id: "a", run: "hello.count", in: { table: "$data" } }, { id: "b", run: "hello.count", in: { table: "a.count" } }], rationale: "No book counts twice." })]];
    const r = await ask("count the rows, then count that");
    const plan = r.plan as Plan;
    expect(plan).toMatchObject({ source: "improvised", title: "Count twice", inputs: { data: table }, problems: [] });
    expect(plan.ships.map((s) => s.id)).toEqual(["hello"]);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("hello.count");
  });

  it("answers in words when nothing fits", async () => {
    replies = [[{ type: "text", text: "None of your ships can segment images yet." }]];
    expect(await ask("segment this")).toMatchObject({ plan: null, message: "None of your ships can segment images yet." });
  });

  it("lays out a book action's Controls, keeps it to the panel's rules and remembers it", async () => {
    const text = JSON.stringify({
      summary: "Counts the rows of this table one by one and then reports how many there are.",
      shown: [{ param: "wait", hint: "Seconds to pause before counting." }],
      more: [{ title: "Timing", params: ["wait"] }],
      values: [{ param: "wait", value: 99 }],
      rationale: "A long pause suits a big table.",
    });
    replies = [[{ type: "text", text }]];
    const body = { workspace: "w", artifact: table, book: "count-rows", action: "count" };
    const before = requests.length;
    const r = await (await send("/api/assistant/controls", body)).json();
    // cut to about eight words, the setting shown once, and 99 is past its maximum of 30, so the default stands
    expect(r.layout).toEqual({ summary: "Counts the rows of this table one by one and then reports…", shown: [{ param: "wait", hint: "Seconds to pause before counting" }], more: [], values: {}, rationale: "" });
    expect((requests.at(-1)!.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect((await (await send("/api/assistant/controls", body)).json()).layout).toEqual(r.layout);
    expect(requests.length).toBe(before + 1);
    // a reply that isn't the layout falls back to the book's own design
    replies = [[{ type: "text", text: "not json" }]];
    const fallback = await (await send("/api/assistant/controls", { ...body, request: "count them" })).json();
    expect(fallback.layout).toMatchObject({ summary: "Count the rows", shown: [{ param: "wait", hint: "" }], more: [] });
  });

  it("talks back, with the conversation so far before the message it answers", async () => {
    replies = [[{ type: "text", text: "Hi! I can count the rows of this table." }]];
    const history = [
      { role: "assistant", text: "a reply with nothing before it is dropped" },
      { role: "user", text: "hello" },
      { role: "user", text: "anyone there?" },
      { role: "assistant", text: "Yes, hi." },
      { role: "system", text: "not a role the conversation has" },
    ];
    const r: AssistantPlan = await (await send("/api/assistant/plan", { workspace: "w", text: "what can you do?", artifacts: [table], history })).json();
    expect(r).toMatchObject({ plan: null, message: "Hi! I can count the rows of this table." });
    const messages = requests.at(-1)!.messages as { role: string; content: unknown }[];
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "hello\n\nanyone there?" },
      { role: "assistant", content: "Yes, hi." },
    ]);
    expect(messages[2].role).toBe("user");
    expect(String(messages[2].content)).toContain("Message: what can you do?");
  });

  it("counts the tokens of every reply, for Settings to show", async () => {
    const config = await (await fetch(`${server.url}/api/ai/config`, { headers: { "x-pharos-token": TOKEN } })).json();
    const counts = Object.values(config.usage.total) as { requests: number; input: number; output: number }[];
    expect(counts.reduce((n, c) => n + c.requests, 0)).toBe(requests.length);
    expect(counts.reduce((n, c) => n + c.output, 0)).toBe(2 * requests.length);
    expect(config.usage.today).toEqual(config.usage.total);
    expect(JSON.stringify(config)).not.toMatch(/sk-ant/);
  });
});
