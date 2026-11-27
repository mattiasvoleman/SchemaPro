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
        // And, since X1b, the names the calls go through: window, globalThis, location, navigator, and what document.body is reached by.
        "reference to window",
        "reference to window",
        "reference to window",
        "reference to globalThis",
        "reference to location",
        "reference to navigator",
        "reference to document (document.body)",
      ].sort(),
    );
    expect(found).not.toContain('createElement("a")');
  });

  it("still finds what the first probe has, and nothing more in it", () => {
    const first = closureOf(["lib/__fixtures__/offline-probe.ts"]).findings.map((finding) => finding.what).sort();
    expect(first).toEqual(
      ["identifier XMLHttpRequest", "identifier fetch", "location.href", "property .cookie", "window.open", "reference to document (document.cookie)", "reference to location", "reference to window"].sort(),
    );
  });
});

/*
 * THE WAYS OUT THAT START FROM A NAME OF THEIR OWN (X1b, the review of #398, L-4).
 *
 * `const w: any = window; const loc = w.location; loc.assign(url)` went through the proof and through the component test (28 of 28 green), and the page's policy does not refuse a navigation either. The rules above look for `location.assign` and
 * `window.open` by their spelling, and a variable has another. The review left it as "a trade-off for X1": to forbid the word `location` in the whole closure changes the exact lists of the search tool's tests. The price is
 * paid here, once, because nothing the pseudonymiser does needs the browser's objects but `document.createElement("a")` for a download: window, globalThis, self, top, parent, frames, opener, location, history and navigator are findings
 * wherever they are referenced, and so is every use of document but that one. A name that is only a property (`box.top`) is not a reference.
 */
describe("the tool that looks, tried on the ways out that go through a name of their own", () => {
  const found = closureOf(["lib/__fixtures__/offline-probe-aliases.ts"]).findings.map((finding) => finding.what);

  it("finds the name every one of them starts from", () => {
    for (const reference of ["reference to window", "reference to globalThis", "reference to top", "reference to parent", "reference to self", "reference to location", "reference to history", "reference to navigator"]) {
      expect(found, reference).toContain(reference);
    }
    expect(found).toContain("reference to document (document.location)");
    expect(found).toContain("reference to document (document.defaultView)");
  });

  it("finds the alias of window, which every rule above let through: the function that has nothing but a variable", () => {
    const only = closureOf(["lib/__fixtures__/offline-probe-aliases.ts"]).findings;
    expect(only.filter((finding) => finding.what === "reference to window").length).toBe(2);
  });

  it("lets a property called top or parent be, and the anchor of a download", () => {
    expect(found).not.toContain('createElement("a")');
    expect(found.filter((what) => what === "reference to top")).toHaveLength(1);
    expect(found.filter((what) => what === "reference to parent")).toHaveLength(1);
  });

  it("finds nothing of the kind in the pseudonymiser: the core and the tool use none of them", () => {
    expect(closureOf(["lib/pseudonym-run.ts", "lib/pseudonym-download.ts", "app/[locale]/pseudonymisera/tool.tsx"]).findings).toEqual([]);
  });
});
