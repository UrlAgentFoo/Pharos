import { describe, expect, it } from "vitest";
import { barHtml, duration, phaseText, progressHtml } from "../src/progress.js";

describe("progress", () => {
  it("says what phase the work is in", () => {
    expect(phaseText({ phase: "waiting" })).toBe("Waiting for its turn");
    expect(phaseText({ phase: "downloading", ship: "cellpose", bytes: { received: 300 * 1024 ** 2, total: 1.4 * 1024 ** 3 } })).toMatch(/^Downloading cellpose · 300\.0 MB of 1\.40 GB$/);
    expect(phaseText({ phase: "building", ship: "render" })).toBe("Setting up render (first use only)");
    expect(phaseText({ phase: "running", fraction: 0.414, message: "tile 3/8" })).toBe("Running · 41% · tile 3/8");
    expect(phaseText({ phase: "running" })).toBe("Running");
  });

  it("sweeps when the fraction isn't known, and fills when it is", () => {
    expect(barHtml()).toContain("indeterminate");
    expect(barHtml(0.5)).toContain("width:50%");
    // downloads fill by bytes; starting has no fraction yet
    expect(progressHtml({ phase: "downloading", bytes: { received: 1, total: 4 } })).toContain("width:25%");
    expect(progressHtml({ phase: "starting", since: Date.now(), job: "j1" })).toContain('data-quiet-job="j1"');
    expect(progressHtml({ phase: "waiting", since: Date.now() })).not.toContain("pg-quiet");
  });

  it("formats elapsed time", () => {
    expect(duration(12_400)).toBe("12 s");
    expect(duration(65_000)).toBe("1:05");
    expect(duration(3_723_000)).toBe("1:02:03");
  });
});
