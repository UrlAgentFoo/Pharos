/**
 * The local server can read and write the user's files, so it must only
 * answer the Pharos page it launched:
 *
 * - it listens on loopback only;
 * - the Host header must be a loopback name with our port (blocks DNS rebinding);
 * - a present Origin header must be our own origin (blocks cross-site requests);
 * - every API call needs the per-launch secret token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const i = host.lastIndexOf(":");
  if (i < 0) return false;
  return LOOPBACK_NAMES.has(host.slice(0, i).toLowerCase()) && host.slice(i + 1) === String(port);
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // same-origin GETs and non-browser clients send none
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOOPBACK_NAMES.has(u.hostname.toLowerCase()) && u.port === String(port);
  } catch {
    return false;
  }
}

export function tokenMatches(req: IncomingMessage, token: string): boolean {
  const given = req.headers["x-pharos-token"];
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Headers on every response: cross-origin isolation (enables wasm threads) and hardening. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src blob:; connect-src 'self'; frame-ancestors 'none'",
};
