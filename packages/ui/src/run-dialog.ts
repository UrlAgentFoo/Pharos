/**
 * Run…: runs one ship operation on workspace data. Lists the operations
 * in the library that accept the chosen artifact, then asks for the other
 * inputs and the parameters, with fields generated from the manifest.
 */
import type { Artifact, CatalogueEntry, ParamSpec, Params, ShipManifest } from "@pharos/contracts";
import { type Tool, ToolRegistry } from "@pharos/core";
import type { LocalServer } from "./api.js";
import { escapeHtml, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";

export interface RunRequest {
  tool: string;
  version: string;
  inputs: Record<string, string>;
  params: Params;
  force: boolean;
}

const TRUST: Record<CatalogueEntry["trust"], string> = { verified: "Verified", verifying: "Verifying", imported: "Not yet tested" };

/** Fields for manifest parameters (number, integer, enum, boolean, string). */
export function manifestParamFields(specs: ParamSpec[], values: Params): string {
  return specs
    .map((s) => {
      const label = escapeHtml(s.label ?? s.name.replace(/_/g, " "));
      const hint = s.description ? ` title="${escapeHtml(s.description)}"` : "";
      const v = values[s.name] ?? s.default;
      const unit = s.unit ? ` <small>${escapeHtml(s.unit)}</small>` : "";
      if (s.type === "boolean") return `<label class="check"${hint}><input type="checkbox" name="${s.name}" ${v ? "checked" : ""}/> ${label}</label>`;
      if (s.type === "enum") {
        const opts = (s.options ?? []).map((o) => `<option ${o === v ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
        return `<label class="field"${hint}>${label}<select name="${s.name}">${opts}</select></label>`;
      }
      const num = s.type === "number" || s.type === "integer";
      const attrs = num ? ` type="number" step="${s.type === "integer" ? 1 : "any"}"${s.min !== undefined ? ` min="${s.min}"` : ""}${s.max !== undefined ? ` max="${s.max}"` : ""}` : "";
      return `<label class="field"${hint}>${label}${unit}<input name="${s.name}"${attrs} value="${v === undefined ? "" : escapeHtml(String(v))}" ${v === undefined ? "required" : ""}/></label>`;
    })
    .join("");
}

export function readManifestParams(specs: ParamSpec[], form: HTMLFormElement): Params {
  const out: Params = {};
  for (const s of specs) {
    const el = form.elements.namedItem(s.name) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    if (s.type === "boolean") out[s.name] = (el as HTMLInputElement).checked;
    else if (s.type === "number" || s.type === "integer") {
      if (el.value !== "") out[s.name] = Number(el.value);
    } else out[s.name] = el.value;
  }
  return out;
}

/** Asks which operation to run on `artifact`, with what; null when cancelled. */
export async function runDialog(server: LocalServer, workspace: string, artifact: Artifact): Promise<RunRequest | null> {
  const entries = await server.ships();
  const manifests: ShipManifest[] = await Promise.all(entries.map((e) => server.ship(e.id, e.version).then((r) => r.manifest)));
  const registry = new ToolRegistry([]);
  for (const m of manifests) registry.addShip(m);
  const trust = new Map(entries.map((e) => [e.id, e.trust]));
  const tools = registry.accepting(artifact.kind, artifact.format).sort((a, b) => Number(trust.get(sourceShip(b)) === "verified") - Number(trust.get(sourceShip(a)) === "verified"));
  const name = escapeHtml(artifact.name ?? artifact.id.slice(0, 12));
  if (!tools.length) {
    await showDialog(
      `<p class="eyebrow">Run</p><h2>Nothing can take ${name} yet</h2>
       <p class="muted">No ship in your library has an operation that reads ${escapeHtml(artifact.kind)} data in ${escapeHtml(artifact.format)}. Add a ship that does (<code>pharos ship new</code>), or convert the data first.</p>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      () => {},
      undefined,
    );
    return null;
  }

  const tool = await showDialog<Tool | null>(
    `<p class="eyebrow">Run on ${name}</p><h2>Choose an operation</h2>
     <ul class="entries run-tools">${tools
       .map(
         (t, i) => `<li><button class="file" data-i="${i}"><span>${icon("plug", 16)} <span><strong>${escapeHtml(t.id)}</strong><br/><small>${escapeHtml(t.summary)}</small></span></span>
           <small class="trust trust-${trust.get(sourceShip(t))}">${TRUST[trust.get(sourceShip(t)) ?? "imported"]}</small></button></li>`,
       )
       .join("")}</ul>
     <footer><button data-cancel>Cancel</button></footer>`,
    (done, el) => el.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((b) => b.addEventListener("click", () => done(tools[Number(b.dataset.i)]))),
    null,
  );
  if (!tool || tool.source.type !== "ship") return null;
  const source = tool.source;

  // the chosen artifact fills the first input that takes it; the others come from the workspace
  const first = tool.inputs.find((i) => i.kind === artifact.kind && (!i.formats || i.formats.includes(artifact.format)))!;
  const others = tool.inputs.filter((i) => i !== first);
  const pool = others.length ? await server.artifacts(workspace) : [];
  const choices = others.map((port) => ({ port, options: pool.filter((a) => a.kind === port.kind && (!port.formats || port.formats.includes(a.format))) }));
  const missing = choices.filter((c) => !c.options.length && !c.port.optional);

  return showDialog<RunRequest | null>(
    `<form method="dialog"><p class="eyebrow">Run on ${name}</p><h2>${escapeHtml(tool.id)}</h2>
     <p class="muted">${escapeHtml(tool.summary)}</p>
     ${choices
       .map(
         (c) => `<label class="field">${escapeHtml(c.port.name.replace(/_/g, " "))} <small>${escapeHtml(c.port.kind)}</small>
           <select name="in:${c.port.name}">${c.port.optional ? `<option value="">(none)</option>` : ""}${c.options.map((a) => `<option value="${a.id}">${escapeHtml(a.name ?? a.id.slice(0, 12))}</option>`).join("")}</select></label>`,
       )
       .join("")}
     ${missing.length ? `<p class="chat-warn">The workspace has no ${missing.map((m) => `${escapeHtml(m.port.kind)} for "${escapeHtml(m.port.name)}"`).join(", ")}. Add it first.</p>` : ""}
     ${manifestParamFields(tool.params, {})}
     <label class="check"><input type="checkbox" name="force"/> Run again even if this was run before (ignore the cache)</label>
     <footer><button type="button" data-cancel>Cancel</button><button class="primary" ${missing.length ? "disabled" : ""}>${icon("batch", 15)} Run</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const inputs: Record<string, string> = { [first.name]: artifact.id };
        for (const c of choices) {
          const v = (form.elements.namedItem(`in:${c.port.name}`) as HTMLSelectElement).value;
          if (v) inputs[c.port.name] = v;
        }
        done({ tool: tool.id, version: source.version, inputs, params: readManifestParams(tool.params, form), force: (form.elements.namedItem("force") as HTMLInputElement).checked });
      });
    },
    null,
  );
}

function sourceShip(t: Tool): string {
  return t.source.type === "ship" ? t.source.ship : "";
}
