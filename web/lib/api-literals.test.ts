import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiLiterals } from "./api-literals";

/**
 * The walker behind the contract test of "Min undervisning": the `/api/v1/` routes the code of a page can name.
 * Held here on a small tree of its own, so that what it follows and what it does not is said and not assumed.
 */

let root: string;
const write = (file: string, text: string) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const reach = (...pages: string[]) =>
  new ApiLiterals(root)
    .reach(pages)
    .map((literal) => literal.path)
    .sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "api-literals-"));
  // A module with three hooks and a helper; a page uses one hook, which names the helper.
  write(
    "lib/queries.ts",
    [
      'import { helper } from "./helper";',
      'export function useMine() { return get("/api/v1/mine" + helper()); }',
      'export function useOther() { return get("/api/v1/other"); }',
      "export const useConst = () => get(`/api/v1/const/${id}`);",
      "function get(path: string) { return path; }",
    ].join("\n"),
  );
  write("lib/helper.ts", `export const helper = () => "/api/v1/from-helper";\nexport const unused = () => "/api/v1/never-reached";`);
  write("lib/barrel.ts", `export { viaBarrel } from "./deep";\nexport * from "./star";`);
  write("lib/deep.ts", `export const viaBarrel = () => "/api/v1/via-barrel";\nexport const notThis = () => "/api/v1/not-this";`);
  write("lib/star.ts", ["export const viaStar = () => `/api/v1/via-star${query()}`;", 'function query() { return ""; }'].join("\n"));
  write("lib/default.ts", `export default function Panel() { return fetch("/api/v1/panel?x=1"); }`);
  write("lib/lazy.tsx", `export function Lazy() { return fetch("/api/v1/lazy"); }\nexport const alsoLazy = () => "/api/v1/also-lazy";`);
  write("lib/ns.ts", `export const a = () => "/api/v1/ns-a";\nexport const b = () => "/api/v1/ns-b";`);
  write("lib/other.test.ts", `export const nope = "/api/v1/in-a-test";`);
  write("lib/dir/index.ts", `export const fromIndex = () => "/api/v1/from-index";`);
  write("lib/notes.ts", `export const note = "http://example.test/api/v2/x"; export const plain = "/api/v1";`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the routes the code of a page can name", () => {
  it("follows the symbols a page imports and not the rest of the module they sit in", () => {
    write("app/one.tsx", `import { useMine } from "@/lib/queries";\nexport default function Page() { return useMine(); }`);
    // `useOther` and `useConst` are in the same file and are not named: reading the module whole would put them here.
    expect(reach("app/one.tsx")).toEqual(["api/v1/from-helper", "api/v1/mine"]);
  });

  it("reads a template's holes as parameters, and a hole glued to the end as a query string", () => {
    write("app/two.tsx", `import { useConst } from "@/lib/queries";\nimport { viaStar } from "@/lib/barrel";\nexport default function Page() { return [useConst, viaStar]; }`);
    expect(reach("app/two.tsx")).toEqual(["api/v1/const/:p", "api/v1/via-star"]);
  });

  it("follows a re-export by name, and an `export *` for what the name is in", () => {
    write("app/three.tsx", `import { viaBarrel } from "@/lib/barrel";\nexport default function Page() { return viaBarrel; }`);
    expect(reach("app/three.tsx")).toEqual(["api/v1/via-barrel"]);
  });

  it("follows a default import, a relative import and a directory's index", () => {
    write("app/four/page.tsx", `import Panel from "@/lib/default";\nimport { fromIndex } from "../../lib/dir";\nexport default function Page() { return [Panel, fromIndex]; }`);
    expect(reach("app/four/page.tsx")).toEqual(["api/v1/from-index", "api/v1/panel"]);
  });

  it("follows import() into the whole of the module, which is what a lazy component is", () => {
    write("app/five.tsx", `import { lazy } from "react";\nconst Lazy = lazy(() => import("@/lib/lazy"));\nexport default function Page() { return Lazy; }`);
    expect(reach("app/five.tsx")).toEqual(["api/v1/also-lazy", "api/v1/lazy"]);
  });

  it("takes a namespace import as the whole module, and a property name as no declaration", () => {
    write("app/six.tsx", `import * as ns from "@/lib/ns";\nexport default function Page() { return { notThis: ns }; }`);
    expect(reach("app/six.tsx")).toEqual(["api/v1/ns-a", "api/v1/ns-b"]);
  });

  it("reads a page's own strings, never a test's, and nothing that is not a gateway path", () => {
    write(
      "app/seven.tsx",
      [
        'import { nope } from "@/lib/other.test";',
        'import { note, plain } from "@/lib/notes";',
        "export default function Page() { return [nope, note, plain, `/api/v1/own/${x}/tail?y=1`, \"/api/v2/nope\", \"/elsewhere\"]; }",
      ].join("\n"),
    );
    expect(reach("app/seven.tsx")).toEqual(["api/v1", "api/v1/own/:p/tail"]);
  });

  it("does not stop at an import it cannot resolve, a package or a file that is not there", () => {
    write("app/eight.tsx", `import { x } from "some-package";\nimport { y } from "@/lib/missing";\nexport default function Page() { return [x, y, "/api/v1/kept"]; }`);
    expect(reach("app/eight.tsx")).toEqual(["api/v1/kept"]);
  });

  it("reaches a hook a page starts to use, which is what lets a mutant fail the contract", () => {
    write("app/nine.tsx", `import { useMine } from "@/lib/queries";\nexport default function Page() { return useMine(); }`);
    const before = reach("app/nine.tsx");
    write("app/nine.tsx", `import { useMine, useOther } from "@/lib/queries";\nexport default function Page() { return [useMine(), useOther()]; }`);
    expect(reach("app/nine.tsx")).toEqual([...before, "api/v1/other"].sort());
  });
});
