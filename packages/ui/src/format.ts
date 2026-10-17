/** Text helpers with no DOM, so modules that only build HTML strings can be tested in Node. */

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A name as people read it: "tracks-video" → "Tracks video". */
export function nameTitle(name: string) {
  return (name.charAt(0).toUpperCase() + name.slice(1)).replace(/[-_]+/g, " ");
}

/** A parameter as a list of settings shows it: its label (or its name, readable), with its unit. */
export function paramLabel(p: { name: string; label?: string; unit?: string }) {
  return `${p.label ?? nameTitle(p.name)}${p.unit ? ` (${p.unit})` : ""}`;
}
