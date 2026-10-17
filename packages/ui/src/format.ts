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

/** A path as people read it, with their home folder as ~. */
export function homePath(path: string, home: string) {
  return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path;
}

/** What a workspace's data takes on disk: the files people added, and what runs made from them. */
export function diskUsage(artifacts: readonly { sizeBytes?: number; producedBy?: unknown }[]) {
  let added = 0;
  let results = 0;
  for (const a of artifacts) {
    if (a.producedBy) results += a.sizeBytes ?? 0;
    else added += a.sizeBytes ?? 0;
  }
  return { total: added + results, added, results };
}

/** "1.20 GB on disk · 310.2 MB you added · 890.1 MB of results", leaving out what's empty. */
export function diskUsageText(u: { total: number; added: number; results: number }) {
  if (!u.total) return "Nothing stored yet";
  if (!u.results) return `${formatSize(u.total)} on disk, all data you added`;
  if (!u.added) return `${formatSize(u.total)} on disk, all results`;
  return `${formatSize(u.total)} on disk · ${formatSize(u.added)} you added · ${formatSize(u.results)} of results`;
}
