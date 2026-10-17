/**
 * The assistant's settings: which model, and the API key (from the settings
 * file or the environment), which lives here on the server and never reaches
 * the browser. The assistant itself is the planner (planner.ts): it picks a
 * book and proposes a plan, which the user approves before anything runs.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

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
