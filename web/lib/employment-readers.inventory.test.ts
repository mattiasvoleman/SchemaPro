import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * WHO ON THE WEB READS A POST, AND WHETHER THEY READ ITS PERIODS.
 *
 * The web half of src/staffing/employment-readers.inventory.spec.ts. A post
 * changes from a date since migration 20261022120000, and the report hands a
 * changing post's stretches beside the base row (TeacherLoad.periods, and the
 * periods on its employment). A screen or a file that kept reading the base
 * row's tjänstgöringsgrad would print the wrong figure for part of the year,
 * and nothing would fail. So this reads web/lib, web/components and web/app
 * (not the tests) and fails on
 *
 *  1. a file that calls the post endpoints or names either table that nobody
 *     has classified below;
 *  2. a file that reads a post's figures — targetMinutesPerWeek(), or the
 *     employmentPercent / reductionPercent / teachingTargetMinutesPerWeek of
 *     a post or a stretch — that nobody has classified;
 *  3. a file classified PERIODS that reads none of them: no periods, no
 *     postOn / postStretches / stretch helper of lib/period-view.ts;
 *  4. a file classified VIA whose figures do not come from the module it
 *     names (it must import it);
 *  5. a change in the set classified NEXT. The web has none, and since
 *     "Perioder i export och rullning" neither has the gateway: SS12000, the
 *     vikarie ranking and the rollover read the post on a date there, and the
 *     web prints their answers without reading a figure of its own.
 */

const WEB = path.resolve(__dirname, "..");
const ROOTS = ["lib", "components", "app"];

type Basis = "PERIODS" | "VIA" | "WRITES" | "TRANSPORT" | "NEXT";

const CLASSIFIED: Record<string, { basis: Basis; why: string; via?: string }> = {
  "lib/teacher-load.ts": {
    basis: "PERIODS",
    why: "the report's arithmetic mirrored for the dialogs: a changing post judged stretch by stretch",
  },
  "lib/period-view.ts": {
    basis: "PERIODS",
    why: "what a stretch is called: judged or not, the grad's steps, the post on the first day",
  },
  "lib/employment-period-forms.ts": { basis: "PERIODS", why: "the period form: its draft, its rules, its body" },
  "lib/staffing-exports.ts": {
    basis: "PERIODS",
    why: "SCB on its mätdatum (postOn, 15 oktober); samverkan with the post on the first day and each stretch in its own column",
  },
  "lib/staffing-compare.ts": {
    basis: "PERIODS",
    why: "the year comparison: where each year's post starts, and its steps",
  },
  "components/staffing/employment-periods.tsx": {
    basis: "PERIODS",
    why: "the Anställning card's timeline and the periods it edits",
  },
  "components/staffing/period-load-list.tsx": {
    basis: "PERIODS",
    why: "the drawer's stretch lines: which stretch is over, without hovering",
  },
  "components/staffing/staffing-matrix.tsx": {
    basis: "PERIODS",
    why: "the badge, each stretch's verdict for a screen reader, and Tjänst % as its steps",
  },
  "components/staffing/uppdragsbeskrivning.tsx": {
    basis: "PERIODS",
    why: "the paper: the post at the start, labelled so, and every stretch with its own verdict",
  },
  "app/[locale]/(app)/teacher/tjanst/page.tsx": {
    basis: "PERIODS",
    why: "Min tjänst: the teacher's own stretches, and last year's post where it started",
  },
  "app/[locale]/(app)/admin/reports/staffing-report.tsx": {
    basis: "PERIODS",
    why: "the reconciliation's Tjänst: the steps of the stretches its range touches",
  },
  "app/[locale]/(app)/admin/staffing/year-comparison.tsx": {
    basis: "VIA",
    via: "@/lib/staffing-compare",
    why: "prints the comparison's figures, the post where it starts and its steps",
  },
  "lib/staffing-forms.ts": {
    basis: "WRITES",
    why: "the base row's form; a period is its own form (employment-period-forms)",
  },
  "lib/csv.ts": {
    basis: "WRITES",
    why: "the tjänster CSV's import mapping: the base row; a re-import leaves a post's periods as they are",
  },
  "lib/csv-export.ts": {
    basis: "WRITES",
    why: "the teachers file as the importer reads it back: the base row, so a round trip changes nothing",
  },
  "components/staffing/employment-card.tsx": {
    basis: "WRITES",
    why: "edits the base row, its target preview the base row's; the periods are the card beside it",
  },
  "app/[locale]/(app)/admin/people/page.tsx": {
    basis: "WRITES",
    why: "the person form's post fields write the base row",
  },
  "lib/staffing-queries.ts": {
    basis: "TRANSPORT",
    why: "the post and period endpoints, through the gateway; no figure read",
  },
  "lib/staffing-history-queries.ts": {
    basis: "TRANSPORT",
    why: "the Historik endpoint, through the gateway; no figure read",
  },
};

/** The web's readers left on the year-start post, written out: see 5. */
const NEXT_RELEASE: string[] = [];

const TABLE_READ = /\/api\/v1\/teacher-employments|"TeacherEmployments"|"TeacherEmploymentPeriods"/;
const FIGURES_READ = /\btargetMinutesPerWeek\(|\.(?:employmentPercent|reductionPercent|teachingTargetMinutesPerWeek)\b/;
const PERIODS_READ =
  /\bperiods\b|\bpostOn\(|\bpostStretches\(|\bchangesDuringYear\(|\bisJudged\(|\bpercentSteps(?:In)?\(|\bpostAtStart\(/;

/** The period module defines the figures; it reads no post. */
const DEFINES = new Set(["lib/employment-periods.ts"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__fixtures__" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The code without comments, so a sentence about a field is not a read of it. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

const files = ROOTS.flatMap((root) => sourceFiles(path.join(WEB, root))).map((full) => ({
  path: path.relative(WEB, full).split(path.sep).join("/"),
  text: code(readFileSync(full, "utf8")),
}));
const textOf = (file: string) => files.find((entry) => entry.path === file)?.text ?? "";

describe("who on the web reads a post, and whether they read its periods (20261022120000)", () => {
  it("classifies every file that calls the post endpoints or names the tables", () => {
    const readers = files.filter((file) => TABLE_READ.test(file.text)).map((file) => file.path);
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((file) => !(file in CLASSIFIED))).toEqual([]);
  });

  it("classifies every file that reads a post's figures", () => {
    const readers = files
      .filter((file) => !DEFINES.has(file.path) && FIGURES_READ.test(file.text))
      .map((file) => file.path);
    expect(readers.length).toBeGreaterThan(5);
    expect(readers.filter((file) => !(file in CLASSIFIED))).toEqual([]);
  });

  it("holds a file classified PERIODS to reading them, and one classified VIA to its module", () => {
    const silent = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.basis === "PERIODS")
      .map(([file]) => file)
      .filter((file) => !PERIODS_READ.test(textOf(file)));
    expect(silent).toEqual([]);
    const detached = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.basis === "VIA")
      .filter(([file, entry]) => !entry.via || !textOf(file).includes(`"${entry.via}"`))
      .map(([file]) => file);
    expect(detached).toEqual([]);
  });

  it("holds a TRANSPORT file to reading no figure", () => {
    const reading = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.basis === "TRANSPORT")
      .map(([file]) => file)
      .filter((file) => FIGURES_READ.test(textOf(file)));
    expect(reading).toEqual([]);
  });

  it("names the web's readers left on the year-start post — none — and every classified file still exists", () => {
    expect(
      Object.entries(CLASSIFIED)
        .filter(([, entry]) => entry.basis === "NEXT")
        .map(([file]) => file)
        .sort(),
    ).toEqual(NEXT_RELEASE);
    const present = new Set(files.map((file) => file.path));
    expect(Object.keys(CLASSIFIED).filter((file) => !present.has(file))).toEqual([]);
  });
});
