/**
 * The assistant's layout of the Controls panel for one book action on one
 * window's data (the panel's Suggested tab): a line on what it does there,
 * at most two settings shown with a hint each, every other setting folded
 * in groups, and values it suggests for this data. The book's own `controls`
 * design and guide are its starting point. What comes back is checked:
 * unknown settings go, every setting stays reachable, values keep to their
 * ranges, and the words stay short.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BookManifest, ControlsLayout, DataSummary, ParamSpec, Params } from "@pharos/contracts";
import { bookAction } from "@pharos/contracts";
import { withDefaults } from "@pharos/core";
import { type AiClient, AiError } from "./ai.js";

const MAX_GUIDE = 3000;
/** The panel's words: about eight, a little slack before cutting. */
const SHORT = 12;
const SENTENCE = 30;

const SYSTEM = `You lay out the Controls panel in Pharos, a local app that runs scientific tools: a narrow column, about 250 pixels wide, beside a window, for one action that runs on that window's data. The people using it are scientists, not programmers, and the panel should read at a glance.

Lay it out like this:
- summary: what the action does to this data, at most 8 words, plain and specific ("Finds each nucleus and measures its volume"). No final period, no jargon, no parameter names.
- shown: the one or two settings people most often change for this data, best first; usually the first ones in the book's design. Never more than two, and none when the defaults suit almost everyone.
- hint, for each shown setting: at most 8 words on what changing it does ("Larger finds bigger nuclei"), not a repeat of its label.
- more: every other setting, in groups titled in one or two words the way the book groups them. Leave none out. Settings this data makes irrelevant (a channel picker for one channel) go in the last group.
- values: set a value only when this data or the user's request clearly calls for it (from its size, voxel size, channels or time points) and the book's guide supports it; otherwise leave the default. Keep within each setting's range and options.
- rationale: one short sentence on why those values; empty when you set none.

Use the settings' names exactly as given. You see a summary of the data, never the data itself.`;

export interface ControlsInput {
  book: BookManifest;
  action: string;
  guide?: string;
  summary?: DataSummary;
  /** What the user asked for, when this action answers a message. */
  request?: string;
}

/** The action's settings as the panel shows them: no `sets`, which only Pharos needs. */
function specsOf(book: BookManifest, action: string): ParamSpec[] {
  return (bookAction(book, action)?.parameters ?? []).map(({ sets: _sets, ...spec }) => spec as ParamSpec);
}

/** Without the assistant, or as the starting point: the book's design, folded to the same shape. */
export function bookLayout(book: BookManifest, action: string): ControlsLayout {
  const a = bookAction(book, action);
  const specs = specsOf(book, action);
  const design = a?.controls ?? [{ title: "Settings", params: specs.map((s) => s.name) }];
  const order = design.flatMap((sec) => sec.params ?? []).filter((p) => specs.some((s) => s.name === p));
  const shown = order.slice(0, 2).map((param) => ({ param, hint: "" }));
  const more = design
    .map((sec) => ({ title: sec.title, params: (sec.params ?? []).filter((p) => order.indexOf(p) >= 2) }))
    .filter((g) => g.params.length);
  return tidy({ summary: a?.summary ?? a?.title ?? "", shown, more, values: {}, rationale: "" }, specs);
}

/** The JSON the model must return; setting names are an enum, so it can't invent any. */
function schema(specs: ParamSpec[]): Record<string, unknown> {
  const name = specs.length ? { type: "string", enum: specs.map((s) => s.name) } : { type: "string" };
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      shown: { type: "array", items: { type: "object", properties: { param: name, hint: { type: "string" } }, required: ["param", "hint"], additionalProperties: false } },
      more: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, params: { type: "array", items: name } }, required: ["title", "params"], additionalProperties: false },
      },
      values: {
        type: "array",
        items: {
          type: "object",
          properties: { param: name, value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
          required: ["param", "value"],
          additionalProperties: false,
        },
      },
      rationale: { type: "string" },
    },
    required: ["summary", "shown", "more", "values", "rationale"],
    additionalProperties: false,
  };
}

function describe(input: ControlsInput, specs: ParamSpec[]): string {
  const a = bookAction(input.book, input.action)!;
  const s = input.summary;
  const data = s
    ? [`kind ${s.kind}, format ${s.format}`, s.axes && s.shape ? `axes ${s.axes}, shape ${s.shape.join(" × ")}` : "", s.voxelSize ? `voxel size ${s.voxelSize.x} × ${s.voxelSize.y}${s.voxelSize.z ? ` × ${s.voxelSize.z}` : ""} ${s.voxelSize.unit}` : "", s.channels ? `${s.channels} channel(s)` : "", s.timepoints ? `${s.timepoints} time point(s)` : "", s.dtype ?? "", s.rows !== undefined ? `${s.rows} rows` : ""].filter(Boolean).join("; ")
    : "unknown";
  const settings = specs.map((p) =>
    `- ${p.name}: ${[p.label && `label "${p.label}"`, p.type, p.unit && `in ${p.unit}`, p.default !== undefined && `default ${JSON.stringify(p.default)}`, p.min !== undefined && `min ${p.min}`, p.max !== undefined && `max ${p.max}`, p.options && `options ${p.options.join(", ")}`].filter(Boolean).join(", ")}${p.description ? `. ${p.description}` : ""}`,
  );
  const design = (a.controls ?? []).map((sec) => `- "${sec.title}"${sec.note ? ` (${sec.note})` : ""}: ${(sec.params ?? []).join(", ") || "no settings"}${sec.when ? `; only when ${JSON.stringify(sec.when)}` : ""}`);
  return [
    `<book>${input.book.title}: ${input.book.summary}</book>`,
    `<action>${a.title}${a.summary ? `: ${a.summary}` : ""}</action>`,
    `<data>${data}</data>`,
    `<settings>\n${settings.join("\n") || "none"}\n</settings>`,
    design.length ? `<book_design>\n${design.join("\n")}\n</book_design>` : "",
    input.guide ? `<guide>\n${input.guide.slice(0, MAX_GUIDE)}\n</guide>` : "",
    input.request ? `<request>${input.request}</request>` : "",
    "Lay out the Controls for this action on this data.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const words = (text: string, n: number) => {
  const w = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" ");
};

/** Keeps a layout to the panel's rules, whoever made it. */
export function tidy(raw: Partial<ControlsLayout> & { values?: Params | { param: string; value: unknown }[] }, specs: ParamSpec[]): ControlsLayout {
  const known = new Map(specs.map((s) => [s.name, s]));
  const placed = new Set<string>();
  const take = (p: string) => known.has(p) && !placed.has(p) && placed.add(p) !== undefined;
  const shown = (raw.shown ?? [])
    .filter((x) => take(x.param))
    .slice(0, 2)
    .map((x) => ({ param: x.param, hint: words(x.hint ?? "", SHORT).replace(/\.$/, "") }));
  // a third "shown" setting went back to the pool; it lands in More below
  for (const p of [...placed]) if (!shown.some((x) => x.param === p)) placed.delete(p);
  const more = (raw.more ?? [])
    .map((g) => ({ title: words(g.title || "More settings", 3), params: (g.params ?? []).filter(take) }))
    .filter((g) => g.params.length);
  const rest = specs.map((s) => s.name).filter((p) => !placed.has(p));
  if (rest.length) {
    const last = more.at(-1);
    if (last) last.params.push(...rest);
    else more.push({ title: "More settings", params: rest });
  }
  const pairs = Array.isArray(raw.values) ? raw.values : Object.entries(raw.values ?? {}).map(([param, value]) => ({ param, value }));
  const values: Params = {};
  for (const { param, value } of pairs) {
    const spec = known.get(param);
    if (!spec) continue;
    try {
      values[param] = withDefaults([spec], { [param]: value as Params[string] })[param];
    } catch {
      /* out of range or the wrong type: the default stands */
    }
  }
  return { summary: words(raw.summary ?? "", SHORT).replace(/\.$/, ""), shown, more, values, rationale: Object.keys(values).length ? words(raw.rationale ?? "", SENTENCE) : "" };
}

/** Asks the model for the layout; the book's design when it can't give one. */
export async function layoutControls(client: AiClient, model: string, input: ControlsInput): Promise<{ layout: ControlsLayout; model?: string }> {
  const specs = specsOf(input.book, input.action);
  if (!bookAction(input.book, input.action)) throw new AiError(404, `${input.book.title} has no action "${input.action}"`);
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      // a small, latency-sensitive layout: low effort, and the shape fixed by the schema
      output_config: { effort: "low", format: { type: "json_schema", schema: schema(specs) } },
      ...(model === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: describe(input, specs) }],
    });
  } catch (e) {
    throw new AiError(502, `The assistant couldn't lay out the controls: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (response.stop_reason === "refusal") return { layout: bookLayout(input.book, input.action), model: response.model };
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { layout: tidy(JSON.parse(text), specs), model: response.model };
  } catch {
    return { layout: bookLayout(input.book, input.action), model: response.model };
  }
}
