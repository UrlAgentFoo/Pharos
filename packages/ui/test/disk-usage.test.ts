import { describe, expect, it } from "vitest";
import { diskUsage, diskUsageText, homePath } from "../src/format.js";

const MB = 1024 ** 2;

describe("disk usage", () => {
  it("splits what people added from what runs made", () => {
    const u = diskUsage([{ sizeBytes: 300 * MB }, { sizeBytes: 900 * MB, producedBy: { job: "j" } }, {}]);
    expect(u).toEqual({ total: 1200 * MB, added: 300 * MB, results: 900 * MB });
    expect(diskUsageText(u)).toBe("1.17 GB on disk · 300.0 MB you added · 900.0 MB of results");
    expect(diskUsageText(diskUsage([{ sizeBytes: 2 * MB }]))).toBe("2.0 MB on disk, all data you added");
    expect(diskUsageText(diskUsage([]))).toBe("Nothing stored yet");
  });

  it("shows the home folder as ~, and nothing else", () => {
    expect(homePath("/Users/ana/Pharos/workspaces/default", "/Users/ana")).toBe("~/Pharos/workspaces/default");
    expect(homePath("/Users/anabel/Pharos", "/Users/ana")).toBe("/Users/anabel/Pharos");
    expect(homePath("/data/Pharos", "")).toBe("/data/Pharos");
  });
});
