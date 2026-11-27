import { describe, expect, it } from "vitest";
import { closureOf, type Closure } from "@/lib/__fixtures__/import-closure";

/*
 * THE PSEUDONYMISER MAKES NO REQUEST AND KEEPS NOTHING (Pseudonymiseraren, X1), shown from the code.
 *
 * The page promises that a school's file never leaves its browser. Three things hold that promise up, and each has its own test:
 * this one (nothing the code can reach talks to the network or keeps anything: from the syntax tree, so a comment or a string cannot fool it),
 * the component test that runs the whole flow with every way out replaced by a trap, and the policy the browser itself enforces
 * (connect-src 'none', lib/pseudonym-policy.ts). This file holds the first, for the code of the core; the page's own files are added to ENTRIES
 * where the page is.
 *
 * What this test holds is not a proof. A static analysis of code is never complete: it finds the ways out that its lists and rules name
 * (import-closure.ts), and a way out spelled in a form nobody has listed passes it. A green run says "none of the listed ways out is in this
 * code", not "there is no way out". The other two things above are what catch the rest, and a rule is added to the list the day a spelling
 * is found that it missed.
 */

export const CORE_ENTRIES = [
  "lib/pseudonym-run.ts",
  "lib/pseudonym-input.ts",
  "lib/pseudonym-xlsx.ts",
  "lib/pseudonym-write.ts",
  "lib/pseudonym-detect.ts",
  "lib/pseudonym-markers.ts",
  "lib/pseudonym-names.ts",
  "lib/pseudonym-headers.ts",
];

/** The only packages the pseudonymiser's code may import: none. Everything it needs is the browser's own and the page's own pure modules. */
const ALLOWED_PACKAGES: string[] = [];

describe("what the core of the pseudonymiser can reach", () => {
  const closure: Closure = closureOf(CORE_ENTRIES);

  it("reaches no package at all, so no HTTP client, no store, no framework with a way out", () => {
    expect(closure.packages).toEqual(ALLOWED_PACKAGES);
  });

  it("reaches only the page's own pure modules: the readers it reuses, the shape of a personnummer and its own files", () => {
    expect(closure.files).toEqual(
      expect.arrayContaining([
        "lib/column-source.ts",
        "lib/column-table.ts",
        "lib/csv-encoding.ts",
        "lib/personal-number.ts",
        ...CORE_ENTRIES,
      ]),
    );
    // Nothing from the app: no gateway client, no session, no supabase, no components.
    for (const file of closure.files) expect(file, file).toMatch(/^lib\/(pseudonym-[a-z]+|column-source|column-table|csv-encoding|personal-number)\.ts$/);
  });

  it("holds no call, name or element that sends, loads, stores or navigates: no fetch, XHR, beacon, socket, worker, storage, cookie, form or window.open", () => {
    expect(closure.findings).toEqual([]);
  });
});

describe("what the page's tool, the part that runs in the browser, can reach", () => {
  const closure: Closure = closureOf(["app/[locale]/pseudonymisera/tool.tsx"]);

  it("reaches one package, react, and no HTTP client, store, router, query cache or socket", () => {
    expect(closure.packages).toEqual(["react"]);
  });

  it("reaches only the tool's own files and the page's pure modules: nothing from the app's shell, its gateway client, its session or its components", () => {
    for (const file of closure.files) {
      expect(file, file).toMatch(/^(app\/\[locale\]\/pseudonymisera\/(tool|entry|file-card|result-view|styles)\.tsx?|lib\/(pseudonym-[a-z]+|column-source|column-table|csv-encoding|personal-number)\.ts)$/);
    }
    expect(closure.files).toEqual(expect.arrayContaining(["app/[locale]/pseudonymisera/tool.tsx", "lib/pseudonym-run.ts", "lib/pseudonym-download.ts", "lib/pseudonym-report.ts"]));
  });

  it("holds no call, name or element that sends, loads, stores or navigates", () => {
    expect(closure.findings).toEqual([]);
  });
});

describe("the tool that looks (it must find what it is looking for)", () => {
  it("finds a network call in a file that has one, and not in a comment or a string that names one", () => {
    const found = closureOf(["lib/__fixtures__/offline-probe.ts"]);
    expect(found.findings.map((f) => f.what).sort()).toEqual(
      [
        "identifier XMLHttpRequest",
        "identifier fetch",
        "location.href",
        "property .cookie",
        "window.open",
        // The names the calls above go through are findings of their own since X1b (offline-probe-aliases.ts says why).
        "reference to document (document.cookie)",
        "reference to location",
        "reference to window",
      ].sort(),
    );
    // The package that is imported is found; the one that is imported only for its types (erased when the code is built) is not.
    expect(found.packages).toEqual(["clsx"]);
  });
});
