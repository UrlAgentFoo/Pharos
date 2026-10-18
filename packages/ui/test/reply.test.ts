import { describe, expect, it } from "vitest";
import { citedHtml, replyHtml } from "../src/reply.js";

const cites = { "1": { windowId: "d1", label: "bracket.step" }, "1.2": { windowId: "d1", block: "b2", run: 2, label: "run 2 in bracket.step" } };
const buttons = (html: string) => [...html.matchAll(/data-cite="([^"]+)"/g)].map((m) => m[1]);

describe("citations in the assistant's replies", () => {
  it("turns the windows and runs it knows into buttons", () => {
    const html = citedHtml("The bracket [1] would break; the redesign [1.2] holds.", cites, 3);
    expect(buttons(html)).toEqual(["1", "1.2"]);
    expect(html).toContain('data-msg="3"');
    expect(html).toContain('aria-label="Show run 2 in bracket.step"');
    expect(html).toContain(">[1.2]</button> holds.");
  });

  it("splits a list, and leaves what it doesn't know as text", () => {
    expect(buttons(citedHtml("Both [1, 1.2].", cites, 0))).toEqual(["1", "1.2"]);
    expect(citedHtml("See [1, 7].", cites, 0)).toContain("[7]");
    expect(citedHtml("A made-up [9] and a range [1-2]", cites, 0)).toBe("A made-up [9] and a range [1-2]");
  });

  it("escapes the text around them", () => {
    expect(citedHtml("<b>[1]</b>", cites, 0)).toMatch(/^&#60;b&#62;<button/);
  });

  it("lays a reply out: paragraphs, lists and bold, citations inside them", () => {
    const html = replyHtml("So far:\n\n- **bracket.step** [1]: load-tested [1.2]\n- the street\n\nNext:\n1. print it\n2. hang it", cites, 0);
    expect(html.replace(/<button[^>]*>([^<]*)<\/button>/g, "{$1}")).toBe(
      "<p>So far:</p><ul><li><strong>bracket.step</strong> {[1]}: load-tested {[1.2]}</li><li>the street</li></ul><p>Next:</p><ol><li>print it</li><li>hang it</li></ol>",
    );
  });

  it("keeps a lone line break, and leaves stray asterisks and markup alone", () => {
    expect(replyHtml("one\ntwo", {}, 0)).toBe("<p>one<br>two</p>");
    expect(replyHtml("2 * 3 = 6 and <i>", {}, 0)).toBe("<p>2 * 3 = 6 and &#60;i&#62;</p>");
  });
});
