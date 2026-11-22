import { describe, expect, it } from "vitest";
import { closureOf } from "@/lib/__fixtures__/import-closure";

/*
 * THE PROOF THAT NOTHING LEAVES THE BROWSER, TRIED ON WHAT IT LET THROUGH (review of #377).
 *
 * pseudonym-offline.test.ts looks for fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource, cookie, window.open, location.href and `new Image()`, and
 * finds them. It did not find an image made by `new window.Image()` or `document.createElement("img")`, a script or a link made the same way, markup set
 * with innerHTML, `window.location = …` or `location.search = …`, `window["fetch"]`, `navigator["sendBeacon"]`, `eval`, `new Function`, `new Audio` or a bare
 * open(). Each of them is a request with the school's data in its address. The CSP of the page (part 2) is the browser's hindrance; this is the proof
 * from the code, and it should not be fooled by a different spelling of the same thing.
 */

describe("the tool that looks, tried on the ways out it had missed", () => {
  const found = closureOf(["lib/__fixtures__/offline-probe-gaps.ts"]).findings.map((finding) => finding.what).sort();

  it("finds every one of them, and lets an anchor for a download be", () => {
    expect(found).toEqual(
      [
        // an image, a script and markup that are made or set
        "new (window as unknown as { Image: new () => HTMLImageElement }).Image()",
        "identifier Image",
        "identifier Image",
        'createElement("img")',
        'createElement("script")',
        "property .innerHTML",
        // a navigation by assignment
        "assignment to (window as unknown as { location: string }).location",
        "assignment to location.search",
        // a global reached by a string, and one by a name that is not a literal
        '["fetch"]',
        '["sendBeacon"]',
        "computed property of the global object",
        // text run as code, the constructors that fetch what they are given, a bare open()
        "identifier eval",
        "identifier Function",
        "identifier Audio",
        "open()",
      ].sort(),
    );
    expect(found).not.toContain('createElement("a")');
  });

  it("still finds what the first probe has, and nothing more in it", () => {
    const first = closureOf(["lib/__fixtures__/offline-probe.ts"]).findings.map((finding) => finding.what).sort();
    expect(first).toEqual(["identifier XMLHttpRequest", "identifier fetch", "location.href", "property .cookie", "window.open"].sort());
  });
});
