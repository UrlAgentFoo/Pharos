/**
 * The assistant's token usage: every reply's tokens, counted here as it
 * arrives and kept by day and model in `usage.json` next to the settings, so
 * Settings can show today's and the total. Each reply is also priced as it
 * arrives (Haiku's price depends on that request's prompt), at the list
 * prices below. These are Pharos's own estimates; the Anthropic Console has
 * what's billed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiClient } from "./ai.js";

export interface TokenCount {
  requests: number;
  /** Every input token, the cached ones included. */
  input: number;
  /** The input read from the prompt cache, which costs less. */
  cachedInput: number;
  /** The input written to the prompt cache, which costs a little more. */
  cacheWrite: number;
  output: number;
  /** What those replies cost at list prices, in US dollars. */
  costUsd: number;
  /** Replies from a model with no price below, so left out of `costUsd`. */
  unpriced: number;
}

/** What `GET /api/ai/config` reports as `usage`, by model. */
export interface TokenUsage {
  /** The first day counted (YYYY-MM-DD), or null before any request. */
  since: string | null;
  today: Record<string, TokenCount>;
  total: Record<string, TokenCount>;
  /** The day the prices were taken from Anthropic's pricing page. */
  pricesAsOf: string;
}

/** List prices in US dollars per million tokens. */
interface Rates {
  input: number;
  cacheRead: number;
  output: number;
}

/**
 * From https://platform.claude.com/docs/en/about-claude/pricing, read on
 * PRICES_AS_OF: the models Settings offers, and those a server-side fallback
 * may answer with. Cache writes are 1.25x the input price for 5 minutes (what
 * Pharos asks for) and 2x for an hour.
 */
export const PRICES_AS_OF = "2026-10-17";
const PRICES: Record<string, { rates: Rates; /** Haiku 5.5's, for a prompt over 100,000 tokens. */ long?: Rates }> = {
  "claude-fable-5-1": { rates: { input: 10, cacheRead: 0.25, output: 50 } },
  "claude-fable-5": { rates: { input: 10, cacheRead: 1, output: 50 } },
  "claude-opus-5-5": { rates: { input: 4, cacheRead: 0.2, output: 20 } },
  "claude-opus-5": { rates: { input: 5, cacheRead: 0.5, output: 25 } },
  "claude-opus-4-8": { rates: { input: 5, cacheRead: 0.5, output: 25 } },
  "claude-opus-4-7": { rates: { input: 5, cacheRead: 0.5, output: 25 } },
  "claude-sonnet-5-5": { rates: { input: 2, cacheRead: 0.1, output: 10 } },
  "claude-sonnet-5": { rates: { input: 2, cacheRead: 0.2, output: 10 } },
  "claude-sonnet-4-6": { rates: { input: 3, cacheRead: 0.3, output: 15 } },
  "claude-haiku-5-5": { rates: { input: 0.1, cacheRead: 0.01, output: 0.5 }, long: { input: 0.5, cacheRead: 0.05, output: 2.5 } },
};
const LONG_PROMPT = 100_000;

/** A model's prices, for a prompt of this many tokens; null for a model not listed. */
function ratesFor(model: string, prompt: number): Rates | null {
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")]; // a dated id is the same model
  if (!p) return null;
  return p.long && prompt > LONG_PROMPT ? p.long : p.rates;
}

/** What one reply cost at list prices, in US dollars; null when its model has no price. */
export function replyCost(model: string, u: NonNullable<Reply["usage"]>): number | null {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const hour = Math.min(written, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const r = ratesFor(model, (u.input_tokens ?? 0) + written + read);
  if (!r) return null;
  return ((u.input_tokens ?? 0) * r.input + (written - hour) * r.input * 1.25 + hour * r.input * 2 + read * r.cacheRead + (u.output_tokens ?? 0) * r.output) / 1e6;
}

/** The part of a reply that's counted. */
interface Reply {
  model?: unknown;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    /** How the cache writes split between the 5-minute and the hour-long cache. */
    cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  } | null;
}

type Days = Record<string, Record<string, TokenCount>>;

const FIELDS = ["requests", "input", "cachedInput", "cacheWrite", "output", "costUsd", "unpriced"] as const;
const zero = (): TokenCount => ({ requests: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, costUsd: 0, unpriced: 0 });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today on this computer's clock, as YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Only well-formed days and counts from the file; anything else is dropped. */
function clean(raw: unknown): Days {
  const days: Days = {};
  const src = (raw as { days?: unknown })?.days;
  if (!src || typeof src !== "object") return days;
  for (const [day, models] of Object.entries(src)) {
    if (!DAY.test(day) || !models || typeof models !== "object") continue;
    for (const [model, c] of Object.entries(models)) {
      const count = zero();
      for (const f of FIELDS) count[f] = Number.isFinite((c as Record<string, unknown>)?.[f]) ? Math.max(0, (c as Record<string, number>)[f]) : 0;
      // counted before replies were priced: priced now, with the cache writes (not kept then) at the input price
      if (!Number.isFinite((c as Record<string, unknown>)?.costUsd)) {
        const cost = replyCost(model, { input_tokens: Math.max(0, count.input - count.cachedInput), cache_read_input_tokens: count.cachedInput, output_tokens: count.output });
        if (cost === null) count.unpriced = count.requests;
        else count.costUsd = cost;
      }
      (days[day] ??= {})[model] = count;
    }
  }
  return days;
}

export class TokenMeter {
  private days: Days = {};
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private readonly today: () => string,
  ) {}

  /** The counts kept in `dir`; `today` is for tests. */
  static async load(dir: string, today = () => localDay()): Promise<TokenMeter> {
    const m = new TokenMeter(dir, today);
    try {
      m.days = clean(JSON.parse(await readFile(join(dir, "usage.json"), "utf8")));
    } catch {
      /* none yet, or unreadable: counting starts again */
    }
    return m;
  }

  /** Counts one reply's tokens; a reply without usage (a stream, a test's fake) counts nothing. */
  add(reply: Reply) {
    const u = reply?.usage;
    if (!u || typeof reply.model !== "string") return;
    const c = ((this.days[this.today()] ??= {})[reply.model] ??= zero());
    const cached = u.cache_read_input_tokens ?? 0;
    const cost = replyCost(reply.model, u);
    c.requests += 1;
    c.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
    c.cachedInput += cached;
    c.cacheWrite += u.cache_creation_input_tokens ?? 0;
    c.output += u.output_tokens ?? 0;
    if (cost === null) c.unpriced += 1;
    else c.costUsd += cost;
    this.save();
  }

  view(): TokenUsage {
    const total: Record<string, TokenCount> = {};
    for (const models of Object.values(this.days)) {
      for (const [model, c] of Object.entries(models)) {
        const t = (total[model] ??= zero());
        for (const f of FIELDS) t[f] += c[f];
      }
    }
    return { since: Object.keys(this.days).sort()[0] ?? null, today: this.days[this.today()] ?? {}, total, pricesAsOf: PRICES_AS_OF };
  }

  /** Written whole after each reply, one write at a time, through a temporary file so a crash can't leave half of it. */
  private save() {
    const text = JSON.stringify({ days: this.days }, null, 2) + "\n";
    const file = join(this.dir, "usage.json");
    this.saving = this.saving
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, text);
        await rename(`${file}.tmp`, file);
      })
      .catch(() => {
        /* not saved: the counts stay in memory and the next reply tries again */
      });
  }

  /** Resolves once what's been counted is on disk. */
  flushed(): Promise<void> {
    return this.saving;
  }
}

/** The client, with `meter` counting the tokens of every reply `beta.messages.create` gets. */
export function metered(client: AiClient, meter: TokenMeter): AiClient {
  const messages = new Proxy(client.beta.messages, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== "create" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => Promise<Reply>).apply(target, args).then((reply) => {
          meter.add(reply);
          return reply;
        });
    },
  });
  const beta = new Proxy(client.beta, {
    get: (target, prop) => {
      if (prop === "messages") return messages;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { beta } as AiClient;
}
