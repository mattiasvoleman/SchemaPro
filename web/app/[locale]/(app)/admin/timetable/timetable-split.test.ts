import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as lazyPieces from "./timetable-lazy";

/**
 * What the split of the timetable page must keep, and what no page test can
 * see. page.tsx was 2 743 lines in one component; its reads, clash engine,
 * view, undoable writes and lunch edits now live in use-*.ts beside it, and
 * its code-split pieces in timetable-lazy.ts. The page's behaviour is held by
 * page.test.tsx, unchanged. These hold the rest:
 *
 * - the route's first load: the bundle gate (scripts/bench/bundle-size.mjs)
 *   counts only what the route manifest names, so a hook that took a static
 *   import of a lazy piece would build, pass its page test and cost the route
 *   what the lazy() was written to save. It is the one thing a new module in
 *   this directory can silently undo;
 * - the size, so the page does not grow back into one file;
 * - the three lazy pieces that are replaced after a failed fetch.
 */
const sources = import.meta.glob("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const files = Object.entries(sources)
  .filter(([name]) => !/\.test\.tsx?$/.test(name))
  .map(([name, source]) => ({ name: name.replace("./", ""), source }));

/**
 * The modules a file takes for VALUES, as the compiler reads them: an `import` or an `export … from` that is not
 * `type` all through, written with either quote, with or without its semicolon, as `@/…` or as a path. Type-only
 * forms are erased and cost nothing. Read with the TypeScript parser and not a pattern, which saw only the
 * double-quoted `import … from "…";` and let `export { X } from '…'` through.
 */
function valueImports(source: string, from = "page.tsx"): string[] {
  const found: string[] = [];
  const file = ts.createSourceFile(from, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const asModule = (specifier: string) =>
    specifier.startsWith("@/") ? specifier : specifier.startsWith(".") ? resolveFrom(from, specifier) : specifier;
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
      if (!onlyTypes) found.push(asModule(node.moduleSpecifier.text));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause;
      const onlyTypes = node.isTypeOnly || (named !== undefined && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!onlyTypes) found.push(asModule(node.moduleSpecifier.text));
    }
  }
  return found;
}

/** `../../../../../components/x` from a file in this directory is `@/components/x`. */
function resolveFrom(from: string, specifier: string): string {
  const here = ["app", "[locale]", "(app)", "admin", "timetable", from];
  const path = here.slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") path.pop();
    else if (part !== ".") path.push(part);
  }
  return path[0] === "app" ? `./${path.slice(5).join("/")}` : `@/${path.join("/")}`;
}

describe("the timetable page's split", () => {
  it("has the pieces it is described as having", () => {
    expect(files.map((file) => file.name).sort()).toEqual(
      [
        "page.tsx",
        "timetable-exports.ts",
        "timetable-helpers.ts",
        "timetable-lazy.ts",
        "use-lunch-edits.ts",
        "use-schedule-engine.ts",
        "use-timetable-reads.ts",
        "use-timetable-view.ts",
        "use-undoable-edits.ts",
      ].sort(),
    );
  });

  it("keeps every file under 2 500 lines", () => {
    // Over that, a file is split: the page was 2 743 and nobody could read it whole.
    const long = files.filter((file) => file.source.split("\n").length > 2500).map((file) => file.name);
    expect(long).toEqual([]);
  });

  // What the route's first load must NOT take: each is fetched when somebody asks (a press, a pointer on the
  // lesson dialogs' chunk, the first block in the timplan, the first sharing rule) and costs the route nothing until.
  const LAZY = [
    "@/components/schedule/lesson-dialogs",
    "@/components/schedule/room-optimization-dialog",
    "@/components/schedule/versions-dialog",
    "@/components/schedule/swap-dialog",
    "@/components/schedule/selection-bar",
    "@/components/schedule/block-cards",
    "@/components/timplan/schedule-delta-panel",
    "@/lib/shared-rooms-board",
    "@/lib/pdf",
    "@/lib/ics",
    "./timetable-exports",
  ];

  it.each(files.map((file) => [file.name, file.source] as const))("%s takes no lazy piece statically", (name, source) => {
    const taken = valueImports(source, name).filter((module) => LAZY.includes(module));
    expect(taken).toEqual([]);
  });

  // The guard above is only as good as what it can see. Each of these is a lazy piece taken statically, written
  // in a way the first version of the guard (a pattern for `import … from "…";`) did not read.
  it.each([
    ["a re-export", 'export { SelectionBar } from "@/components/schedule/selection-bar";'],
    ["a star re-export", 'export * from "@/components/schedule/lesson-dialogs";'],
    ["single quotes", "import { VersionsDialog } from '@/components/schedule/versions-dialog';"],
    ["no semicolon", 'import { VersionsDialog } from "@/components/schedule/versions-dialog"\nconst x = 1;'],
    ["a namespace import", 'import * as dialogs from "@/components/schedule/lesson-dialogs";'],
    ["a side-effect import", 'import "@/components/schedule/swap-dialog";'],
    ["a default import", 'import panel from "@/components/timplan/schedule-delta-panel";'],
    ["a relative path", 'import { ScheduleDeltaPanel } from "../../../../../components/timplan/schedule-delta-panel";'],
    ["a neighbour's path", 'import { exportIcs } from "./timetable-exports";'],
    ["a multi-line import", 'import {\n  VersionsDialog,\n  type Props,\n} from "@/components/schedule/versions-dialog";'],
  ])("sees %s of a lazy piece", (_what, source) => {
    expect(valueImports(source).filter((module) => LAZY.includes(module))).toHaveLength(1);
  });

  it.each([
    ["a type import", 'import type { SelectionBarProps } from "@/components/schedule/selection-bar";'],
    ["all-type specifiers", 'import { type LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";'],
    ["a type re-export", 'export type { Props } from "@/components/schedule/lesson-dialogs";'],
    ["a dynamic import", 'const load = () => import("@/components/schedule/lesson-dialogs");'],
  ])("does not mistake %s for a static one", (_what, source) => {
    expect(valueImports(source).filter((module) => LAZY.includes(module))).toEqual([]);
  });

  it("is fetched where it was fetched, so the lazy pieces are still reachable", () => {
    const joined = files.map((file) => file.source).join("\n");
    // The selection bar comes in the lesson dialogs' chunk (lesson-dialogs.ts re-exports it), so no file here names it.
    for (const module of LAZY.filter((name) => name !== "@/components/schedule/selection-bar")) {
      expect(joined, `${module} must still be imported somewhere, dynamically`).toMatch(
        new RegExp(`import\\(\\s*"${module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`),
      );
    }
  });

  it("has hooks that never import the page, which would make a cycle", () => {
    const cyclic = files.filter((file) => file.name !== "page.tsx" && valueImports(file.source, file.name).some((m) => m === "./page"));
    expect(cyclic.map((file) => file.name)).toEqual([]);
  });

  it("has a page that never assigns the lazy bindings, only asks for new ones", () => {
    const page = files.find((file) => file.name === "page.tsx")!.source;
    expect(page).not.toMatch(/^\s*(lessonDialogs|LessonTimePanel|SelectionBar)\s*=[^=]/m);
    expect(page).toMatch(/resetLessonDialogs\(\)/);
    expect(page).toMatch(/resetLessonTimePanel\(\)/);
    expect(page).toMatch(/resetSelectionBar\(\)/);
  });
});

describe("the lazy pieces that are made again after a failed fetch", () => {
  // A lazy() keeps a rejected fetch for good and rethrows it on every later render, so a retry needs a new
  // wrapper. The page reads the binding again on its next render: a live binding is what makes that work.
  it("replaces the lesson dialogs as a set, and the page sees the new ones", () => {
    const before = lazyPieces.lessonDialogs;
    lazyPieces.resetLessonDialogs();
    const after = lazyPieces.lessonDialogs;
    expect(after).not.toBe(before);
    for (const name of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[name], `${name} is a new lazy() wrapper`).not.toBe(before[name]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("replaces the lesson-time panel and the selection bar each on its own", () => {
    const dialogs = lazyPieces.lessonDialogs;
    const panel = lazyPieces.LessonTimePanel;
    const bar = lazyPieces.SelectionBar;

    lazyPieces.resetSelectionBar();
    expect(lazyPieces.SelectionBar).not.toBe(bar);
    expect(lazyPieces.LessonTimePanel).toBe(panel);
    expect(lazyPieces.lessonDialogs).toBe(dialogs);

    lazyPieces.resetLessonTimePanel();
    expect(lazyPieces.LessonTimePanel).not.toBe(panel);
    expect(lazyPieces.lessonDialogs).toBe(dialogs);
  });
});
