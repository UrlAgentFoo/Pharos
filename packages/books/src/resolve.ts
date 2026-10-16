/**
 * Resolves a book against this machine: which ship versions it will use,
 * which images still need downloading and how big they are, and whether
 * anything rules it out (a missing ship version, a GPU it can't do without).
 */
import type { BookManifest, Resolution, ShipManifest, ShipNeed } from "@pharos/contracts";
import { type ShipLookup, checkBook } from "./check.js";
import { error, hasErrors } from "./problems.js";

/** What the orchestrator knows about container images on this machine. */
export interface ImageInventory {
  has(image: string): boolean;
  /** Download size, when the registry has been asked. */
  sizeBytes?(image: string): number | undefined;
}

export interface Machine {
  gpu: boolean;
}

/** The images that nothing has downloaded yet; the orchestrator replaces this. */
export const EMPTY_INVENTORY: ImageInventory = { has: () => false };

export function shipGpu(ship: ShipManifest): ShipNeed["gpu"] {
  const gpu = ship.requires?.gpu;
  return !gpu ? "none" : gpu.optional ? "optional" : "required";
}

export function resolveBook(book: BookManifest, ships: ShipLookup & { versions(id: string): string[] }, inventory: ImageInventory, machine: Machine): Resolution {
  const problems = checkBook(book, ships).filter((p) => p.severity === "error");
  const needs: Resolution["ships"] = [];
  for (const [id, range] of Object.entries(book.ships)) {
    const ship = ships.ship(id, range);
    if (!ship) {
      const have = ships.versions(id);
      problems.push(error(`/ships/${id}`, `no version of "${id}" in the library matches ${range}${have.length ? ` (have ${have.join(", ")})` : ""}`));
      continue;
    }
    const gpu = shipGpu(ship);
    if (gpu === "required" && !machine.gpu) problems.push(error(`/ships/${id}`, `"${id}" needs an NVIDIA GPU, and this machine has none available to Docker`));
    const size = inventory.sizeBytes?.(ship.image);
    needs.push({ id, version: ship.version, image: ship.image, range, downloaded: inventory.has(ship.image), gpu, ...(size !== undefined ? { sizeBytes: size } : {}) });
  }
  // de-duplicated, so two ships sharing an image count once
  const pending = new Map(needs.filter((n) => !n.downloaded).map((n) => [n.image, n.sizeBytes ?? 0]));
  return {
    book: { id: book.id, version: book.version },
    ships: needs,
    downloadBytes: [...pending.values()].reduce((a, b) => a + b, 0),
    runnable: !hasErrors(problems),
    problems,
  };
}
