import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardBlock, BoardKept, BoardPost, PlacementBoard } from "./placement-board";
import { buildMirror } from "./placement-mirror";
import { dropOf, dropOfBlock, moverOfBlockBrick, moverOfRow, nextFreeSpot, type OtherNames } from "./placement-drop";
import { dragOf } from "./placement-drag-tools";
import type { StudentGroup } from "./types";

/**
 * The mirror of the clash rule and what asks it are fetched when the page is up and not with it (lib/placement-drag-tools.ts): about
 * 3.7 KB of the 190 KB the page may weigh. The first test says that the bound questions are the same questions; the rest walk the imports
 * of the page's first load and of every lazy piece, which a bundle gate cannot do (it measures, it does not say which import did it).
 */

const names: OtherNames = { group: (id) => ({ "g-7a": "7A", "g-7b": "7B" })[id], subject: (id) => ({ "s-ma": "Matematik", "s-sv": "Svenska" })[id] };
const post: BoardPost = { id: "post-1", studentGroupId: "g-7a", subjectId: "s-ma", teacherId: "anna", coTeacherId: null, recurrence: "ALL_WEEKS", startDate: null, endDate: null, cannotPlace: null, parts: [], rowsKey: "e3b0c44298fc1c14" };
const kept: BoardKept = { id: "k-1", dayOfWeek: 2, startTime: "10:00", endTime: "11:00", studentGroupId: "g-7b", extraGroupIds: [], subjectId: "s-sv", teacherId: "anna", coTeacherId: null, roomId: "r-b3", recurrence: "ALL_WEEKS", startDate: null, endDate: null, locked: true, generated: false };
const group = (id: string): StudentGroup => ({ id, academicYearId: "y1", name: id, kind: "CLASS", gradeLevel: 7 });
const board: PlacementBoard = { academicYearId: "y1", placements: [], posts: [post], kept: [kept], meals: [], blocks: [] };
const mirror = buildMirror({ board, keys: new Map(), groups: [group("g-7a"), group("g-7b")], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined, academicYearId: "y1" });
const mover = { id: "brick:1", post, teacherId: "anna", roomId: null, recurrence: "ALL_WEEKS" as const };

describe("dragOf", () => {
  it("asks the mirror and the names it was given, and answers what the unbound questions answer", () => {
    const drag = dragOf(mirror, names);
    // Anna keeps Tuesday 10:00-11:00 in another class: she cannot be laid there, and can be an hour later.
    const clash = { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 };
    const free = { dayOfWeek: 2, startMinutes: 660, endMinutes: 720 };
    expect(drag.dropOf(mover, clash)).toEqual(dropOf(mirror, mover, clash, names));
    expect(drag.dropOf(mover, clash).kind).toBe("CLASH");
    expect(drag.dropOf(mover, free).kind).toBe("OK");
    expect(drag.nextFreeSpot(mover, 60, { dayOfWeek: 2, startMinutes: 585 })).toEqual(nextFreeSpot(mirror, mover, 60, { dayOfWeek: 2, startMinutes: 585 }, names));
    expect(drag.nextFreeSpot(mover, 60, { dayOfWeek: 2, startMinutes: 585 })).toEqual({ dayOfWeek: 2, startMinutes: 660 });
    // A mover needs no mirror and is handed out as it is.
    expect(drag.moverOfRow).toBe(moverOfRow);
  });
});

describe("dragOf, for a lesson of a block (review of #341, mutant: the search for the block's first free time ignored where it was told to start)", () => {
  const block: BoardBlock = { id: "b-1", name: "Språkval", memberIds: ["post-1"], lengths: [60], recurrence: "ALL_WEEKS", followsBlockId: null, cannotPlace: null, rows: [], rowsKey: "k" };
  const blockMirror = buildMirror({ board: { ...board, blocks: [block] }, keys: new Map(), groups: [group("g-7a"), group("g-7b")], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined, academicYearId: "y1" });
  const blockMover = moverOfBlockBrick("block:b-1|60#1", block, new Map([[post.id, post]]), new Map());

  it("asks the mirror and the names for a block as the unbound questions do, and starts the search where it is told", () => {
    const drag = dragOf(blockMirror, names);
    // Anna keeps Tuesday 10:00-11:00 in another class, and the block's member is Anna's.
    const clash = { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 };
    expect(drag.dropOfBlock(blockMover, clash)).toEqual(dropOfBlock(blockMirror, blockMover, clash, names));
    expect(drag.dropOfBlock(blockMover, clash).kind).toBe("CLASH");
    // From a quarter before 10:00 on Tuesday: the hour after her lesson; from Thursday: Thursday's own 10:00. A search that began at Monday 08:00 gives neither.
    expect(drag.nextFreeSpotOfBlock(blockMover, 60, { dayOfWeek: 2, startMinutes: 585 })).toEqual({ dayOfWeek: 2, startMinutes: 660 });
    expect(drag.nextFreeSpotOfBlock(blockMover, 60, { dayOfWeek: 4, startMinutes: 585 })).toEqual({ dayOfWeek: 4, startMinutes: 600 });
  });
});

/** The value imports of a module of the web, as written: `@/` is the web's root. A type-only import is erased and costs nothing. */
const ROOT = resolve(__dirname, "..");
const resolveImport = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (base === null) return null;
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((path) => existsSync(path)) ?? null;
};
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
const staticImportsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const [, , typeOnly, clause, specifier] of source.matchAll(IMPORT)) {
    if (typeOnly || !specifier) continue;
    // `import { type A, type B }` is erased whole; one value in the braces keeps the import.
    const names = /\{([^}]*)\}/.exec(clause ?? "")?.[1]?.split(",").map((name) => name.trim()).filter(Boolean);
    if (names && names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
    const path = resolveImport(file, specifier);
    if (path) found.push(path);
  }
  return found;
};
const graphOf = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of staticImportsOf(file)) walk(next);
  };
  walk(entry);
  return seen;
};
const rel = (paths: Iterable<string>) => [...paths].map((path) => path.slice(ROOT.length + 1)).sort();

/** What a module fetches on request: the specifiers of its `import("…")` calls, resolved. A fetch the walk above does not follow. */
const dynamicImportsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].flatMap(([, specifier]) => resolveImport(file, specifier!) ?? []);

const HEAVY = ["lib/placement-mirror.ts", "lib/placement-drop.ts", "lib/conflicts.ts", "lib/placement-drag-tools.ts"];

describe("what the page loads in its first paint (a gate that measures cannot say which import did it)", () => {
  const page = join(ROOT, "app/[locale]/(app)/admin/placements/page.tsx");
  const first = rel(graphOf(page));

  it("does not import the mirror of the clash rule, what asks it, or the clash rule: they come with the lazy drag tools", () => {
    for (const heavy of HEAVY) expect(first, heavy).not.toContain(heavy);
  });

  it("walks the imports at all: the page reaches its own libraries (a walk that found nothing would pass the test above)", () => {
    expect(first).toContain("lib/placement-board.ts");
    expect(first).toContain("lib/use-lazy-module.ts");
    expect(first.length).toBeGreaterThan(30);
  });
});

describe("what the lazy pieces load, each in a request of its own", () => {
  const lazy = ["components/placements/place-fields.tsx", "components/placements/block-place-fields.tsx", "components/placements/card-dialog.tsx", "components/placements/week-picker.tsx", "components/placements/pair-fields.tsx"];

  it.each(lazy)("%s carries no copy of the mirror: it takes what it needs from lib/placement-field.ts, never from the drop module", (piece) => {
    const loaded = rel(graphOf(join(ROOT, piece)));
    for (const heavy of HEAVY) expect(loaded, `${piece} → ${heavy}`).not.toContain(heavy);
  });

  it("holds the mirror and the pair in one module, which is one request (two lazy modules that shared the mirror each got a copy of it)", () => {
    const tools = rel(graphOf(join(ROOT, "lib/placement-drag-tools.ts")));
    for (const heavy of ["lib/placement-mirror.ts", "lib/placement-drop.ts", "lib/conflicts.ts", "lib/placement-pair-control.ts"]) expect(tools, heavy).toContain(heavy);
    // And the page asks for no other module that imports them: the week's own tools take no part of the mirror.
    expect(rel(graphOf(join(ROOT, "lib/placement-week-tools.ts")))).not.toContain("lib/placement-mirror.ts");
  });
});

describe("what the page fetches on request, each in a request of its own (review of #341, MEDEL-3)", () => {
  it("has exactly one lazy module that reaches the mirror, the drag tools: a second would be given its own copy of it by the chunker, which the bundle gate cannot see", () => {
    const page = join(ROOT, "app/[locale]/(app)/admin/placements/page.tsx");
    // Every `import("…")` of every module the page loads in its first paint: the lazy modules, the lazy components, and what they need.
    const requested = new Set<string>();
    for (const file of graphOf(page)) for (const target of dynamicImportsOf(file)) requested.add(target);
    expect(rel(requested)).toEqual(expect.arrayContaining(["lib/placement-drag-tools.ts", "lib/placement-week-tools.ts"]));
    const reachingTheMirror = [...requested].filter((target) => graphOf(target).has(join(ROOT, "lib/placement-mirror.ts")));
    expect(rel(reachingTheMirror)).toEqual(["lib/placement-drag-tools.ts"]);
  });
});
