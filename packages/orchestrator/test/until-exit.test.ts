import { describe, expect, it } from "vitest";
import { untilExit } from "../src/runner.js";

describe("waiting for a container to stop", () => {
  it("takes Docker's wait when it answers", async () => {
    const docker = { wait: async () => 3, exitCode: async () => null };
    expect(await untilExit(docker, "c", 10)).toBe(3);
  });

  it("reads the exit code from the container's state when the wait never answers", async () => {
    let checks = 0;
    const docker = { wait: () => new Promise<number>(() => {}), exitCode: async () => (++checks < 3 ? null : 0) };
    expect(await untilExit(docker, "c", 10)).toBe(0);
    expect(checks).toBe(3);
  });

  it("keeps waiting while the container runs, and fails when the wait does", async () => {
    const docker = { wait: () => new Promise<number>((_, fail) => setTimeout(() => fail(new Error("gone")), 30)), exitCode: async () => null };
    await expect(untilExit(docker, "c", 10)).rejects.toThrow("gone");
  });
});
