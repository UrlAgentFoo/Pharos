import type { PlanProblem } from "@pharos/contracts";

/** A problem in a manifest, located by JSON pointer and, when known, file and line. */
export interface ManifestProblem extends PlanProblem {
  file?: string;
  line?: number;
}

export const error = (path: string, message: string): ManifestProblem => ({ path, message, severity: "error" });
export const warning = (path: string, message: string): ManifestProblem => ({ path, message, severity: "warning" });
export const hasErrors = (problems: readonly ManifestProblem[]) => problems.some((p) => p.severity === "error");
