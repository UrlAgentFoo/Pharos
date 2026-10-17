/**
 * The assistant's token usage: every reply's tokens, counted here as it
 * arrives and kept by day and model in `usage.json` next to the settings, so
 * Settings can show today's and the total. These are Pharos's own counts; the
 * Anthropic Console has what's billed.
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
  output: number;
}

/** What `GET /api/ai/config` reports as `usage`, by model. */
export interface TokenUsage {
  /** The first day counted (YYYY-MM-DD), or null before any request. */
  since: string | null;
  today: Record<string, TokenCount>;
  total: Record<string, TokenCount>;
}

/** The part of a reply that's counted. */
interface Reply {
  model?: unknown;
  usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null;
}

type Days = Record<string, Record<string, TokenCount>>;

const FIELDS = ["requests", "input", "cachedInput", "output"] as const;
const zero = (): TokenCount => ({ requests: 0, input: 0, cachedInput: 0, output: 0 });
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
    c.requests += 1;
    c.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
    c.cachedInput += cached;
    c.output += u.output_tokens ?? 0;
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
    return { since: Object.keys(this.days).sort()[0] ?? null, today: this.days[this.today()] ?? {}, total };
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
