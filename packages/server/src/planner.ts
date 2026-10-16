/**
 * The assistant's planning turn: from the user's data and a sentence, pick
 * a book from the shortlist and fill its parameters, or, when no book fits,
 * chain ship operations into an improvised pipeline.
 *
 * The shortlist comes from file-based matching, before the model sees
 * anything; the model sees data summaries (never pixels), the shortlisted
 * books with their guides, and the ship operations that might help. Its
 * choice becomes a proposed plan, which is checked; if the check finds
 * errors they go back to the model once to repair. Nothing runs until the
 * user approves the plan.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Library } from "@pharos/books";
import type { McpContext } from "@pharos/catalogue";
import type { BookMatch, DataSummary, Plan, Step } from "@pharos/contracts";
import { type AiClient, AiError } from "./ai.js";

const CHOOSE_BOOK = "choose_book";
const IMPROVISE = "improvise";
const MAX_SHORTLIST = 12;
const MAX_GUIDE = 4000;

export interface PlannerInput {
  text: string;
  /** The user's data, in the order they chose it: artifact id and summary. */
  data: { id: string; summary: DataSummary }[];
}

export interface PlannerResult {
  plan: Plan | null;
  /** What the assistant says to the user. */
  message: string;
  matches: BookMatch[];
  model?: string;
}

/** Turns a model's choice into a plan; `check` re-validates an improvised one after repair. */
export interface PlanMaker {
  fromBook(book: string, inputs: Record<string, string>, parameters: Record<string, number | string | boolean>, rationale: string): Promise<Plan>;
  improvised(title: string, rationale: string, inputs: Record<string, string>, steps: Step[]): Promise<Plan>;
}

const SYSTEM = `You are the planner inside Pharos, a local app that runs scientific tools in containers on the user's computer.

Ships are container images with typed operations. Books are tested recipes that chain ship operations for a task. The user has chosen some data and described what they want. Pharos has already matched their data against every book; you get the books that can run on it (direct, or after a conversion step), each with its guide.

Decide, in this order:
1. If a shortlisted book fits the request, call ${CHOOSE_BOOK}. Prefer verified books and direct matches. Fill parameters from the data summaries and the book's guide (for example a diameter in pixels from the voxel size and the typical object size); leave out parameters whose default suits. Assign each book input the number of the data item it should get.
2. Only if no book fits, call ${IMPROVISE} to chain the listed ship operations. Every step's input must come from a data item (as "$<input name>") or an earlier step's output ("<step id>.<output name>"), with matching kinds and formats.
3. If neither works, call no tool and say briefly what is missing (a ship, a book or different data).

Call at most one tool. Pharos checks the plan you propose and shows it to the user, who edits and approves it before anything runs. Your rationale is shown to the user: one or two plain sentences on why this book or pipeline, and any parameter you guessed. You see data summaries only, never the data itself; don't claim to have looked at it.`;

function tools(): Anthropic.Beta.BetaTool[] {
  return [
    {
      name: CHOOSE_BOOK,
      description: "Propose running one of the shortlisted books on the user's data.",
      input_schema: {
        type: "object",
        properties: {
          book: { type: "string", description: "The book's id, from the shortlist" },
          inputs: { type: "object", description: "Book input name → data item number (1-based)", additionalProperties: { type: "integer" } },
          parameters: { type: "object", description: "Book parameter name → value; only those you want to change from the default", additionalProperties: { type: ["number", "string", "boolean"] } },
          rationale: { type: "string", description: "One or two sentences for the user" },
        },
        required: ["book", "inputs", "rationale"],
      },
    },
    {
      name: IMPROVISE,
      description: "Propose a pipeline of ship operations when no shortlisted book fits.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short title for the pipeline" },
          inputs: { type: "object", description: "Pipeline input name (lowercase_snake) → data item number (1-based)", additionalProperties: { type: "integer" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "lowercase_snake step id" },
                run: { type: "string", description: "<ship>.<operation>" },
                in: { type: "object", description: "Operation input → '$<pipeline input>' or '<step id>.<output>'", additionalProperties: { type: "string" } },
                with: { type: "object", description: "Operation parameter → value", additionalProperties: { type: ["number", "string", "boolean"] } },
              },
              required: ["id", "run"],
            },
          },
          rationale: { type: "string", description: "One or two sentences for the user" },
        },
        required: ["title", "inputs", "steps", "rationale"],
      },
    },
  ];
}

/** The shortlisted books, as the model sees them. */
function describeBooks(matches: BookMatch[], library: Library): string {
  const usable = matches.filter((m) => m.tier !== "excluded").slice(0, MAX_SHORTLIST);
  if (!usable.length) {
    const near = matches.slice(0, 3).map((m) => `- ${m.book.id}: excluded (${m.reasons.join("; ")})`);
    return `No book can run on this data.${near.length ? `\nClosest books and why they don't fit:\n${near.join("\n")}` : ""}`;
  }
  return usable
    .map((m) => {
      const b = library.book(m.book.id, m.book.version)!;
      const manifest = b.manifest!;
      const guide = (b.guide ?? "").slice(0, MAX_GUIDE);
      return [
        `<book id="${m.book.id}" trust="${m.book.trust}" match="${m.tier}" gpu="${m.book.gpu}">`,
        `${manifest.title}: ${manifest.summary}`,
        `Inputs: ${(manifest.inputs ?? []).map((i) => `${i.name} (${i.accepts.kind}${i.accepts.axes ? `, axes ${i.accepts.axes}` : ""})`).join(", ") || "none"}`,
        `Parameters: ${(manifest.parameters ?? []).map((p) => `${p.name} (${p.type}${p.unit ? `, ${p.unit}` : ""}${p.default !== undefined ? `, default ${p.default}` : ""}${p.options ? `, one of ${p.options.join("/")}` : ""})${p.description ? `: ${p.description}` : ""}`).join("; ") || "none"}`,
        `Steps: ${manifest.steps.map((s) => s.run).join(" → ")}`,
        `Why it matched: ${m.reasons.join("; ")}`,
        guide ? `Guide:\n${guide}` : "",
        "</book>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Ship operations the model may chain when improvising: verified ones first, most relevant first. */
function describeOperations(ctx: McpContext, library: Library, text: string): string {
  const found = ctx.index.search({ text, type: "ship", limit: 15 });
  const entries = found.length ? found : ctx.index.search({ type: "ship", limit: 15 });
  const lines: string[] = [];
  for (const e of entries) {
    const ship = library.ship(e.id, e.version);
    if (!ship) continue;
    for (const [name, op] of Object.entries(ship.operations)) {
      const ins = (op.inputs ?? []).map((i) => `${i.name}: ${i.kind} [${i.formats.join("/")}]${i.optional ? "?" : ""}`).join(", ");
      const outs = op.outputs.map((o) => `${o.name}: ${o.kind} [${o.format}]`).join(", ");
      const params = (op.parameters ?? []).map((p) => `${p.name} ${p.type}${p.default !== undefined ? `=${p.default}` : ""}`).join(", ");
      lines.push(`- ${ship.id}.${name} (${e.trust}): ${op.summary} In: ${ins || "none"}. Out: ${outs}.${params ? ` Params: ${params}.` : ""}`);
    }
  }
  return lines.join("\n") || "(no ships in the library)";
}

function describeData(data: PlannerInput["data"]): string {
  return data.map((d, i) => `${i + 1}. ${JSON.stringify(d.summary)}`).join("\n") || "(no data chosen)";
}

function problemsText(plan: Plan): string {
  return plan.problems.filter((p) => p.severity === "error").map((p) => `- ${p.path}: ${p.message}`).join("\n");
}

/** Maps "input → data item number" to "input → artifact id", ignoring numbers that don't exist. */
function bindInputs(raw: unknown, data: PlannerInput["data"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [name, n] of Object.entries(raw as Record<string, unknown>)) {
      const item = typeof n === "number" ? data[n - 1] : undefined;
      if (item) out[name] = item.id;
    }
  }
  return out;
}

function asSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): Step[] => {
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.run !== "string") return [];
    return [{ id: o.id, run: o.run, ...(o.in && typeof o.in === "object" ? { in: o.in as Record<string, string> } : {}), ...(o.with && typeof o.with === "object" ? { with: o.with as Step["with"] } : {}) }];
  });
}

function apiError(e: unknown, model: string): never {
  if (e instanceof Anthropic.AuthenticationError) throw new AiError(400, "The API key was rejected. Check it in Settings.");
  if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(400, `The API key cannot use ${model}.`);
  if (e instanceof Anthropic.NotFoundError) throw new AiError(400, `Model ${model} was not found.`);
  if (e instanceof Anthropic.RateLimitError) throw new AiError(429, "Rate limited by the API. Try again in a moment.");
  if (e instanceof Anthropic.APIConnectionError) throw new AiError(502, "Could not reach the Anthropic API. Check your connection.");
  if (e instanceof Anthropic.APIError) throw new AiError(502, `API error ${e.status ?? ""}: ${e.message}`);
  if (e instanceof Anthropic.AnthropicError) throw new AiError(400, "No API key configured. Add one in Settings.");
  throw e;
}

export async function planWithAssistant(
  client: AiClient,
  model: string,
  input: PlannerInput,
  ctx: McpContext & { library: Library; matches: BookMatch[] },
  maker: PlanMaker,
): Promise<PlannerResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        `<data>\n${describeData(input.data)}\n</data>`,
        `<shortlist>\n${describeBooks(ctx.matches, ctx.library)}\n</shortlist>`,
        `<operations>\n${describeOperations(ctx, ctx.library, input.text)}\n</operations>`,
        `<machine gpu="${ctx.gpu}"/>`,
        `Request: ${input.text}`,
      ].join("\n\n"),
    },
  ];

  const ask = async () => {
    try {
      return await client.beta.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // on a safety decline, retry on Anthropic's recommended fallback model (not available for Haiku)
        ...(model === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: tools(),
        messages,
      });
    } catch (e) {
      apiError(e, model);
    }
  };

  let plan: Plan | null = null;
  let message = "";
  let served: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ask();
    served = response.model;
    if (response.stop_reason === "refusal") return { plan, message: "The assistant declined this request.", matches: ctx.matches, model: served };
    // append-only: the reply goes back exactly as returned
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    const call = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!call) return { plan, message: text || "No book or pipeline fits this request.", matches: ctx.matches, model: served };

    const args = (call.input ?? {}) as Record<string, unknown>;
    const rationale = typeof args.rationale === "string" ? args.rationale : text;
    try {
      if (call.name === CHOOSE_BOOK) {
        const book = String(args.book ?? "");
        if (!ctx.matches.some((m) => m.book.id === book && m.tier !== "excluded")) throw new Error(`"${book}" isn't on the shortlist`);
        plan = await maker.fromBook(book, bindInputs(args.inputs, input.data), (args.parameters ?? {}) as Record<string, number | string | boolean>, rationale);
      } else if (call.name === IMPROVISE) {
        plan = await maker.improvised(String(args.title ?? "Improvised pipeline"), rationale, bindInputs(args.inputs, input.data), asSteps(args.steps));
      } else throw new Error(`unknown tool ${call.name}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Rejected: ${why}. Choose again.` }] });
      message = rationale;
      continue;
    }
    message = rationale;
    const errors = problemsText(plan);
    if (!errors) break;
    // one repair: the model sees exactly what the check found
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Pharos checked this plan and found problems:\n${errors}\nPropose a corrected plan.` }] });
  }
  return { plan, message, matches: ctx.matches, model: served };
}
