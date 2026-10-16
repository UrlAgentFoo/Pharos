/** Keyboard shortcuts written as "Mod+Shift+I" (Mod = Cmd on macOS, Ctrl elsewhere). */

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };
const KEY_NAMES: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc" };

/** Display form: "⌘⇧I" on macOS, "Ctrl+Shift+I" elsewhere. */
export function formatShortcut(s: string): string {
  const parts = s.split("+").map((p) => KEY_NAMES[p] ?? p);
  return isMac ? parts.map((p) => MAC_SYMBOLS[p] ?? p).join("") : parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
}

export function matchesShortcut(e: KeyboardEvent, s: string): boolean {
  const parts = s.split("+");
  const key = parts.pop()!;
  const want = new Set(parts);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (want.has("Mod") !== mod) return false;
  if (want.has("Shift") !== e.shiftKey) return false;
  if (want.has("Alt") !== e.altKey) return false;
  if (!isMac && want.has("Ctrl") !== e.ctrlKey && !want.has("Mod")) return false;
  return key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}
