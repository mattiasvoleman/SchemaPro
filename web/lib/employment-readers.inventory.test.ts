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
 *     web prints their answers without reading a figure of its own;
 *  6. a change in who reads the post's undervisningsdagar (Lärarens dag,
 *     20261123090000). Deltid in days is HR like the percentages and sits on
 *     the post, never on a period, so it is not a figure a reader has to take
 *     stretch by stretch — it is one a reader must not have at all unless the
 *     gateway hands it over. Its readers are the post's two forms, written out
 *     below; a summary, a toast or a planner's cross-check that started
 *     reading it would put a figure the gateway hides beside the rows it
 *     shows.
 *
 * The gateway half also counts a Prisma `_count` or a nested select of the
 * post as a read. The web's equivalent is a PostgREST embed of either table
 * in another table's select, `TeacherEmployments(…)`, which TABLE_READ
 * catches beside the quoted name and the endpoint.
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
    why: "samverkan with the post on the first day (postOn) and each stretch in its own column; SCB's file is the gateway's (src/staffing/scb)",
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

const TABLE_READ =
  /\/api\/v1\/teacher-employments|"TeacherEmployments"|"TeacherEmploymentPeriods"|\bTeacherEmployment(?:Period)?s(?:![A-Za-z_]+)*\(/;
const FIGURES_READ =
  /\btargetMinutesPerWeek\(|\.(?:employmentPercent|reductionPercent|teachingTargetMinutesPerWeek|maxTeachingDaysPerWeek)\b/;
/** The post's undervisningsdagar alone: see 6. */
const DAYS_READ = /\.maxTeachingDaysPerWeek\b/;
const DAYS_READERS = ["components/staffing/employment-card.tsx", "lib/staffing-forms.ts"];
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

  it("counts an embed of either table in another select as a read, and a hook's name as none", () => {
    expect(TABLE_READ.test('selectAll("Users", "id, TeacherEmployments(maxTeachingDaysPerWeek)")')).toBe(true);
    expect(TABLE_READ.test('"id, post:TeacherEmploymentPeriods!fk_post(validFrom)"')).toBe(true);
    expect(TABLE_READ.test("useTeacherEmployments(activeYearId)")).toBe(false);
  });

  it("names the post's two forms as the only readers of its undervisningsdagar (Lärarens dag)", () => {
    expect(FIGURES_READ.test("row.maxTeachingDaysPerWeek")).toBe(true);
    expect(
      files
        .filter((file) => DAYS_READ.test(file.text))
        .map((file) => file.path)
        .sort(),
    ).toEqual(DAYS_READERS);
    expect(DAYS_READERS.filter((file) => CLASSIFIED[file]?.basis !== "WRITES")).toEqual([]);
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
