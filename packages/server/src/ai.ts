/**
 * AI assistant: a conversation that turns plain-language requests into
 * proposed timeline steps, answers questions, and suggests small control
 * panels for the task at hand.
 *
 * The model sees the command registry as tools plus image metadata (size,
 * type, calibration, the current steps). It never receives pixels. It only
 * proposes; the UI shows proposals for review and applies them through the
 * timeline, so every AI action is recorded, editable and undoable.
 *
 * Conversations live here on the server and are append-only: each turn adds
 * the user's message and the model's full reply (thinking and tool calls
 * included), never rewriting earlier turns. Current models reject edited
 * histories, and append-only also keeps the prompt cache warm.
 *
 * The API key lives here too (settings file or environment) and never
 * reaches the browser.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { COMMANDS, findCommand, paramsJsonSchema, parseParams } from "@pharos/core";

export const AI_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "most capable" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "faster" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "fastest, lowest cost" },
] as const;

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface AiSettings {
  model: string;
  apiKey?: string;
}

export interface AiConfigView {
  models: typeof AI_MODELS;
  model: string;
  /** Where the key comes from; null when none is configured. */
  keySource: "settings" | "environment" | null;
  /** Last characters of a saved key, so users can tell which one is set. */
  keyHint?: string;
}

export interface AiContext {
  image?: { name?: string; dtype: string; width: number; height: number; channels: number; slices: number; frames: number; unit?: string; pixelWidth?: number };
  steps?: { command: string; params: unknown; enabled: boolean }[];
  shortcuts?: { title: string; shortcut: string }[];
}

export interface ChatRequest {
  /** Omit to start a new conversation. */
  sessionId?: string;
  message: string;
  context?: AiContext;
  /** What the user did with the previous reply's suggestions, reported back to the model. */
  outcome?: "applied" | "dismissed";
}

export interface ChatReply {
  sessionId: string;
  /** The model's reply to show the user. */
  text: string;
  /** Proposed steps, validated against the registry, in order. */
  steps: { command: string; params: Record<string, unknown> }[];
  /** A command whose dialog the model wants opened for the user. */
  open?: string;
  /** A small control panel the model suggests for this task. */
  controls?: { title: string; commands: string[] };
  /** Tool calls that were dropped because they failed validation. */
  skipped: string[];
  model: string;
}

/** The slice of the Anthropic client this module uses (tests pass a fake). */
export type AiClient = Pick<Anthropic, "beta">;
export type AiClientFactory = (apiKey: string | undefined) => AiClient;

export const defaultClientFactory: AiClientFactory = (apiKey) => (apiKey ? new Anthropic({ apiKey }) : new Anthropic());

export class AiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- settings

export function configDir(): string {
  return process.env.PHAROS_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pharos");
}

export async function loadSettings(dir: string): Promise<AiSettings> {
  try {
    const s = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { ai?: Partial<AiSettings> };
    const model = AI_MODELS.some((m) => m.id === s.ai?.model) ? s.ai!.model! : DEFAULT_MODEL;
    return { model, apiKey: typeof s.ai?.apiKey === "string" ? s.ai.apiKey : undefined };
  } catch {
    return { model: DEFAULT_MODEL };
  }
}

export async function saveSettings(dir: string, ai: AiSettings): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "settings.json");
  await writeFile(file, JSON.stringify({ ai }, null, 2), { mode: 0o600 });
  await chmod(file, 0o600); // writeFile's mode only applies when creating the file
}

export function configView(s: AiSettings): AiConfigView {
  const env = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  return {
    models: AI_MODELS,
    model: s.model,
    keySource: s.apiKey ? "settings" : env ? "environment" : null,
    keyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : undefined,
  };
}

/** Applies a PUT /api/ai/config body: `apiKey: null` clears the saved key. */
export function updateSettings(s: AiSettings, body: { model?: unknown; apiKey?: unknown }): AiSettings {
  const next = { ...s };
  if (body.model !== undefined) {
    if (!AI_MODELS.some((m) => m.id === body.model)) throw new AiError(400, `unknown model ${String(body.model)}`);
    next.model = body.model as string;
  }
  if (body.apiKey === null || body.apiKey === "") delete next.apiKey;
  else if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || !/^\S{20,}$/.test(body.apiKey.trim())) throw new AiError(400, "that does not look like an API key");
    next.apiKey = body.apiKey.trim();
  }
  return next;
}

// ---------------------------------------------------------------- conversation

const OPEN_DIALOG = "open_dialog";
const SUGGEST_CONTROLS = "suggest_controls";
const COMMAND_IDS = COMMANDS.map((c) => c.id);

const SYSTEM = `You are the assistant built into Pharos, a local app for scientific data analysis. You talk with the user in a side panel next to their image.

You can:
- propose processing steps by calling the command tools, in the order they should run. The user reviews your proposal before anything runs; each applied step lands in the image's undo timeline, where it stays editable.
- call ${OPEN_DIALOG} when the user asks to open, find or "load" a tool, or when a command needs parameters you cannot judge, so they can set them themselves.
- call ${SUGGEST_CONTROLS} when the user asks for an interface, a panel or the right tools for a task: pick the few commands that matter for what they are doing, so Pharos can show them as a compact control panel.
- answer questions (what a command does, keyboard shortcuts, how to approach an analysis) in a short text reply.

Each user message starts with the current image metadata and steps. You never see the pixels, so do not claim to have looked at the image. Choose parameters from what the user said and the metadata; when a value is a guess, say so in one short sentence. When a tool result tells you whether the user applied your last suggestion, take that into account.

Only the listed commands exist in Pharos so far. If the request needs something else (for example thresholding, measurements or particle analysis), say it is not available yet. Keep replies brief: a sentence or two, or a short list.`;

function tools(): Anthropic.Beta.BetaTool[] {
  const commandTools: Anthropic.Beta.BetaTool[] = COMMANDS.map((c) => ({
    name: c.id,
    description: `${c.title.replace(/…$/, "")} (${c.menu.join(" › ")}). ${c.description}`,
    input_schema: paramsJsonSchema(c) as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  }));
  return [
    ...commandTools,
    {
      name: OPEN_DIALOG,
      description: "Opens a command's dialog (or runs it from the palette) so the user can choose parameters. Use for requests like 'open the blur tool'.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string", enum: COMMAND_IDS, description: "Command id" } },
        required: ["command"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      name: SUGGEST_CONTROLS,
      description: "Shows the user a compact control panel with the commands most useful for their current task, in the order they would use them.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short panel title naming the task, e.g. 'Clean up a noisy stack'" },
          commands: { type: "array", items: { type: "string", enum: COMMAND_IDS }, description: "Command ids, most useful first (2 to 6)" },
        },
        required: ["title", "commands"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

function describeContext(ctx: AiContext | undefined): string {
  const lines: string[] = [];
  const img = ctx?.image;
  if (img) {
    const dims = [`${img.width}×${img.height}`, img.channels > 1 && `${img.channels} channels`, img.slices > 1 && `${img.slices} slices`, img.frames > 1 && `${img.frames} frames`]
      .filter(Boolean)
      .join(", ");
    const cal = img.unit && img.unit !== "pixel" && img.pixelWidth ? `, pixel size ${img.pixelWidth} ${img.unit}` : "";
    lines.push(`Current image: "${img.name ?? "untitled"}", ${img.dtype}, ${dims}${cal}.`);
  } else lines.push("No image is open.");
  const steps = ctx?.steps ?? [];
  if (steps.length) {
    lines.push("Steps already applied, in order:");
    for (const s of steps) lines.push(`- ${s.command} ${JSON.stringify(s.params)}${s.enabled ? "" : " (suppressed)"}`);
  }
  const keys = ctx?.shortcuts ?? [];
  if (keys.length) lines.push(`Keyboard shortcuts: ${keys.map((k) => `${k.title} = ${k.shortcut}`).join("; ")}.`);
  return lines.join("\n");
}

interface Session {
  id: string;
  model: string;
  /** The full transcript as sent to the API; only ever appended to. */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** tool_use ids in the last reply, answered at the start of the next user turn. */
  pendingToolUses: string[];
  lastUsed: number;
}

/** In-memory conversations, newest last. Lost when the server restarts. */
export class ChatStore {
  private sessions = new Map<string, Session>();
  constructor(private readonly max = 20) {}

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastUsed = Date.now();
    return s;
  }

  create(model: string): Session {
    const s: Session = { id: randomUUID(), model, messages: [], pendingToolUses: [], lastUsed: Date.now() };
    this.sessions.set(s.id, s);
    while (this.sessions.size > this.max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      this.sessions.delete(oldest.id);
    }
    return s;
  }
}

export async function chatTurn(client: AiClient, store: ChatStore, model: string, req: ChatRequest): Promise<ChatReply> {
  const message = typeof req.message === "string" ? req.message.trim().slice(0, 4000) : "";
  if (!message) throw new AiError(400, "empty message");
  let session: Session;
  if (req.sessionId) {
    const found = store.get(req.sessionId);
    if (!found) throw new AiError(404, "This conversation has expired. Start a new one.");
    session = found;
  } else session = store.create(model); // a conversation keeps the model it started with

  // answer the previous reply's tool calls first, then the new message
  const outcome = req.outcome === "applied" ? "The user applied this suggestion." : "Shown to the user; they did not apply it.";
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...session.pendingToolUses.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: outcome })),
    { type: "text", text: `${describeContext(req.context)}\n\nUser: ${message}` },
  ];
  const userTurn: Anthropic.Beta.BetaMessageParam = { role: "user", content };

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: session.model,
      max_tokens: 16000,
      // a side panel should feel quick; these are short planning tasks
      output_config: { effort: "low" },
      // on a safety decline, retry on Anthropic's recommended fallback model (not available for Haiku)
      ...(session.model === "claude-haiku-5-5" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      system: SYSTEM,
      tools: tools(),
      messages: [...session.messages, userTurn],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError(400, "The API key was rejected. Check it in Settings.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(400, `The API key cannot use ${session.model}.`);
    if (e instanceof Anthropic.NotFoundError) throw new AiError(400, `Model ${session.model} was not found.`);
    if (e instanceof Anthropic.RateLimitError) throw new AiError(429, "Rate limited by the API. Try again in a moment.");
    if (e instanceof Anthropic.APIConnectionError) throw new AiError(502, "Could not reach the Anthropic API. Check your connection.");
    if (e instanceof Anthropic.APIError) throw new AiError(502, `API error ${e.status ?? ""}: ${e.message}`);
    if (e instanceof Anthropic.AnthropicError) throw new AiError(400, "No API key configured. Add one in Settings.");
    throw e;
  }

  const reply: ChatReply = { sessionId: session.id, text: "", steps: [], skipped: [], model: response.model };
  if (response.stop_reason === "refusal" && !response.content.length) {
    // nothing to append: the turn is dropped and the transcript stays as it was
    return { ...reply, text: "The model declined this request." };
  }

  // append the user turn and the model's reply exactly as returned
  session.messages.push(userTurn, { role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
  session.pendingToolUses = [];

  const text: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") text.push(block.text);
    if (block.type !== "tool_use") continue;
    session.pendingToolUses.push(block.id);
    const input = block.input as Record<string, unknown>;
    if (block.name === OPEN_DIALOG) {
      if (typeof input?.command === "string" && findCommand(input.command)) reply.open = input.command;
      else reply.skipped.push(`${OPEN_DIALOG}: unknown command`);
    } else if (block.name === SUGGEST_CONTROLS) {
      const commands = Array.isArray(input?.commands) ? (input.commands as unknown[]).filter((c): c is string => typeof c === "string" && !!findCommand(c)) : [];
      if (commands.length) reply.controls = { title: typeof input.title === "string" ? input.title : "Suggested controls", commands: [...new Set(commands)] };
      else reply.skipped.push(`${SUGGEST_CONTROLS}: no known commands`);
    } else {
      const cmd = findCommand(block.name);
      if (!cmd) {
        reply.skipped.push(`${block.name}: unknown command`);
        continue;
      }
      try {
        reply.steps.push({ command: cmd.id, params: parseParams(cmd, input) });
      } catch (e) {
        reply.skipped.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  reply.text = text.join("\n").trim();
  if (response.stop_reason === "refusal") reply.text += (reply.text ? "\n" : "") + "(The model stopped: it declined to continue.)";
  if (response.stop_reason === "max_tokens") reply.text += (reply.text ? "\n" : "") + "(The reply was cut short.)";
  return reply;
}
