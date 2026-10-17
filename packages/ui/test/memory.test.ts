import { describe, expect, it } from "vitest";
import { forgetView, holdView, touchView, weight } from "../src/view-memory.js";

const MB = 1024 ** 2;
const page = (mb: number) => ({ type: "page" as const, url: "blob:x", bytes: mb * MB });

describe("the memory budget for loaded views", () => {
  it("lets the least recently shown go first, and never what's on screen", () => {
    const dropped: string[] = [];
    const hold = (key: string, mb: number, onScreen = false) => holdView(key, page(mb), () => onScreen, () => dropped.push(key));
    hold("on-screen", 250, true);
    hold("older", 150);
    hold("newer", 100);
    touchView("older"); // shown again, so "newer" is now the one not seen longest
    hold("latest", 100); // 600 MB held against 512: one has to go
    expect(dropped).toEqual(["newer"]);
    hold("huge", 400, true); // on screen too: everything else goes, and what's on screen stays even past the budget
    expect(dropped).toEqual(["newer", "older", "latest"]);
    for (const key of ["on-screen", "older", "newer", "latest", "huge"]) forgetView(key);
  });

  it("weighs what an entry holds", () => {
    expect(weight(page(3))).toBe(3 * MB);
    expect(weight({ type: "table", rows: [["ab", "c"]], total: 1 })).toBe(6);
    expect(weight({ type: "video", url: "/api/media/x" })).toBe(0); // streamed: nothing held in the page
  });
});
