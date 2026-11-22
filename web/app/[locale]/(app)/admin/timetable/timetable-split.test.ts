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

/** The modules a file imports for VALUES: `import type` and all-`type` specifiers are erased and cost nothing. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^import\s+(?!type\b)([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    const clause = match[1]!;
    const named = /\{([\s\S]*)\}/.exec(clause)?.[1];
    const hasDefaultOrNamespace = /^[\w$*]/.test(clause.trim());
    const onlyTypes = named !== undefined && !hasDefaultOrNamespace && named.split(",").every((part) => !part.trim() || /^type\s/.test(part.trim()));
    if (!onlyTypes) found.push(match[2]!);
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) found.push(match[1]!);
  return found;
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

  it.each(files.map((file) => [file.name, file.source] as const))("%s takes no lazy piece statically", (_name, source) => {
    const taken = valueImports(source).filter((module) => LAZY.includes(module));
    expect(taken).toEqual([]);
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
    const cyclic = files.filter((file) => file.name !== "page.tsx" && valueImports(file.source).some((m) => m === "./page"));
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
