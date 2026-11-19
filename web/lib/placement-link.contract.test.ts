import { describe, expect, it } from "vitest";
import fixture from "../../src/optimization/__fixtures__/placement-refusal-lines.json";
import { linkTargetOf, placementLinkOfRefusal } from "./placement-link";

/**
 * THE LINK BACK TO THE WEEK, BUILT FROM THE LINES THE GATEWAY MAKES (A3).
 *
 * src/optimization/__fixtures__/placement-refusal-lines.json holds the refusal lines as the gateway stores and shows them, built
 * by its real code (src/optimization/placement-refusal-lines.spec.ts compares the file with what the code makes and fails when
 * it is old). Every line that names a förläggning gives a link to its card: the post's own id, the day and the clock time of the
 * row, and the block for a block's lesson. A line that names none gives no link.
 */

interface Entry {
  name: string;
  postId: string | null;
  blockId: string | null;
  line: { category: string; code?: string; params?: Record<string, string | number> };
}
const entries = (fixture as unknown as { lines: Entry[] }).lines;

/** What the web is expected to build for each line, by the name the gateway's case has. */
const HREF: Record<string, string | null> = {
  preflight: "/admin/placements?year=y2&post=11111111-aaaa-4aaa-8aaa-111111111111&day=3&start=10%3A00",
  "preflight-block": "/admin/placements?year=y2&post=22222222-aaaa-4aaa-8aaa-222222222222&day=4&start=13%3A15&block=33333333-aaaa-4aaa-8aaa-333333333333",
  "preflight-no-room": "/admin/placements?year=y2&post=11111111-aaaa-4aaa-8aaa-111111111111&day=3&start=10%3A00",
  "engine-room": "/admin/placements?year=y2&post=11111111-aaaa-4aaa-8aaa-111111111111&day=2&start=08%3A30",
  "engine-any-room": "/admin/placements?year=y2&post=11111111-aaaa-4aaa-8aaa-111111111111&day=2&start=08%3A30",
  probe: "/admin/placements?year=y2&post=11111111-aaaa-4aaa-8aaa-111111111111&day=2&start=08%3A30",
  "engine-block-member": "/admin/placements?year=y2&post=22222222-aaaa-4aaa-8aaa-222222222222&day=2&start=08%3A30&block=33333333-aaaa-4aaa-8aaa-333333333333",
  "cause-without-post": null,
  "other-category": null,
};

/** The refusals the page draws a link for: a conflict of the category PLACEMENT. */
const linkOf = (line: Entry["line"]) => (line.category === "PLACEMENT" ? placementLinkOfRefusal(line.params, "y2") : null);

describe("a refusal's link back to the week, from the gateway's own lines", () => {
  it("has a case for every line of the fixture, and a line for every case", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(Object.keys(HREF).sort());
  });

  it.each(entries.map((entry) => [entry.name, entry] as const))("%s: the link the page draws", (name, entry) => {
    expect(linkOf(entry.line)).toBe(HREF[name]);
  });

  it.each(entries.filter((entry) => HREF[entry.name] !== null).map((entry) => [entry.name, entry] as const))(
    "%s: the week reads the link back as the post, the day and the start it was made from",
    (_name, entry) => {
      const href = linkOf(entry.line)!;
      const target = linkTargetOf(href.slice(href.indexOf("?")));
      expect(target).toEqual({
        yearId: "y2",
        postId: entry.postId,
        blockId: entry.blockId,
        day: entry.line.params!["day"],
        start: entry.line.params!["start"],
      });
    },
  );

  it("is a link for a line with the ids and none for a line without: the fixture's own claim agrees", () => {
    for (const entry of entries) {
      expect({ name: entry.name, link: linkOf(entry.line) !== null }).toEqual({ name: entry.name, link: entry.postId !== null });
    }
  });
});
