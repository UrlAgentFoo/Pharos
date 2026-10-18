/**
 * Large data: past a size per kind, running anything on it is slow, so a
 * window first suggests making it smaller. What can do that is found, not
 * listed: operations of ships tagged `downsample` that take the data's kind
 * and format and give the same kind back (media-ops for videos and photo
 * sets, mesh-ops for meshes and splats).
 */
import type { Artifact, ShipManifest } from "@pharos/contracts";
import type { Suggestion } from "./data-window.js";

/** Above these sizes, data is worth making smaller before anything else runs on it. */
export const LARGE_BYTES: Record<string, number> = { video: 100e6, photos: 300e6, mesh: 100e6, splat: 150e6 };

/** Operations that make `artifact` smaller: from ships tagged `downsample`, taking its kind and format and giving the same kind back. */
export function downsizers(ships: Iterable<ShipManifest>, artifact: Pick<Artifact, "kind" | "format">): Extract<Suggestion, { type: "op" }>[] {
  const out: Extract<Suggestion, { type: "op" }>[] = [];
  for (const ship of ships) {
    if (!ship.tags?.includes("downsample")) continue;
    for (const [name, op] of Object.entries(ship.operations)) {
      const takes = (op.inputs ?? []).some((i) => i.kind === artifact.kind && i.formats.includes(artifact.format));
      if (takes && op.outputs[0]?.kind === artifact.kind) out.push({ type: "op", id: `${ship.id}.${name}`, title: `${ship.id} › ${name}`, summary: op.summary, trust: "imported" });
    }
  }
  return out;
}
