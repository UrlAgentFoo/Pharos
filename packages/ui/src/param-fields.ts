/** Form fields generated from ship and book parameter specs, and reading them back. */
import type { ParamSpec, Params } from "@pharos/contracts";
import { escapeHtml } from "./dialogs.js";

/** Fields for manifest parameters (number, integer, enum, boolean, string). */
export function manifestParamFields(specs: ParamSpec[], values: Params): string {
  return specs
    .map((s) => {
      const label = `<span class="field-label">${escapeHtml(s.label ?? s.name.replace(/_/g, " "))}</span>`;
      const hint = s.description ? ` title="${escapeHtml(s.description)}"` : "";
      const v = values[s.name] ?? s.default;
      if (s.type === "boolean") return `<label class="check"${hint}><input type="checkbox" name="${s.name}" ${v ? "checked" : ""}/> ${label}</label>`;
      if (s.type === "enum") {
        const opts = (s.options ?? []).map((o) => `<option ${o === v ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
        return `<label class="field"${hint}>${label}<select name="${s.name}">${opts}</select></label>`;
      }
      const num = s.type === "number" || s.type === "integer";
      const attrs = num ? ` type="number" step="${s.type === "integer" ? 1 : "any"}"${s.min !== undefined ? ` min="${s.min}"` : ""}${s.max !== undefined ? ` max="${s.max}"` : ""}` : "";
      // the unit sits at the end of the box, so the label above stays just the name
      return `<label class="field"${hint}>${label}<span class="field-box"><input name="${s.name}"${attrs} value="${v === undefined ? "" : escapeHtml(String(v))}" ${v === undefined ? "required" : ""}/>${s.unit ? `<span class="field-unit">${escapeHtml(s.unit)}</span>` : ""}</span></label>`;
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
