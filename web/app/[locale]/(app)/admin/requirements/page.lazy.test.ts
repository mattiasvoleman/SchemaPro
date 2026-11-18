import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * What /admin/requirements loads in its first paint (a gate that measures cannot say which import did it). The route is at its bundle budget
 * (190 KB), and what only the cell dialog and the export button need is fetched with them (review of the budget: the route had 483 B left, and now
 * has 5 483). A module imported statically anywhere in the page's graph is in the first load again, silently until the gate fails somewhere else.
 *
 * The walk follows value imports as written (`@/` is the web's root; a type-only import is erased). An `import("…")` or a `lazy(…)` is not followed.
 */

const ROOT = resolve(__dirname, "../../../../..");
const resolveImport = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (base === null) return null;
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((path) => existsSync(path)) ?? null;
};
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
const staticImportsOf = (file: string): string[] => {
  const found: string[] = [];
  for (const [, , typeOnly, clause, specifier] of readFileSync(file, "utf8").matchAll(IMPORT)) {
    if (typeOnly || !specifier) continue;
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
const PAGE = join(ROOT, "app/[locale]/(app)/admin/requirements/page.tsx");

describe("what /admin/requirements loads in its first paint", () => {
  const first = rel(graphOf(PAGE));

  it("walks the imports at all: the page reaches its own libraries (a walk that found nothing would pass the tests below)", () => {
    expect(first).toContain("lib/subject-distribution.ts");
    expect(first).toContain("components/timplan/placed-badge.tsx");
    expect(first.length).toBeGreaterThan(40);
  });

  it("does not import the rule's switch, its two fields or the list of what it breaks: they come with the cell dialog (CellDistribution, fetched with it)", () => {
    for (const lazy of ["components/timplan/cell-distribution.tsx", "components/timplan/distribution-fields.tsx", "components/ui/switch.tsx"]) {
      expect(first, lazy).not.toContain(lazy);
    }
  });

  it("does not import the CSV templates and the download: the export button fetches them at the click", () => {
    expect(first).not.toContain("lib/csv-export.ts");
    expect(first).not.toContain("lib/csv.ts");
  });

  it("reads the per-day field's bounds from the rule's own module, which the page has anyway, and not from the fields", () => {
    expect(first).toContain("lib/subject-distribution.ts");
  });
});

describe("what the lazy pieces need that the page does not carry", () => {
  it("the cell's rule reaches the controls it draws: a lazy piece that lost its imports would be fetched for nothing", () => {
    const loaded = rel(graphOf(join(ROOT, "components/timplan/cell-distribution.tsx")));
    expect(loaded).toEqual(expect.arrayContaining(["components/timplan/distribution-fields.tsx", "components/ui/switch.tsx"]));
  });

  it("the export button reaches csv-export only by a request at the click", () => {
    const loaded = rel(graphOf(join(ROOT, "components/import/csv-export-button.tsx")));
    expect(loaded).not.toContain("lib/csv-export.ts");
    expect(readFileSync(join(ROOT, "components/import/csv-export-button.tsx"), "utf8")).toMatch(/import\("@\/lib\/csv-export"\)/);
  });
});
