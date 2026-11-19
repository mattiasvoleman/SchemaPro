import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * WHO ON THE WEB READS A BEHÖRIGHET, AND WHETHER THEY GET THE DERIVED ROWS.
 *
 * The web half of src/staffing/qualification-readers.inventory.spec.ts. A subject may use another's
 * behörighet since migration 20270225090000 ("SO WS" -> "SO"), and the rule that makes SO's rows count
 * for SO WS is the gateway's alone: GET /teacher-qualifications answers the STORED rows, which is what a
 * form edits and saves whole and what a CSV prints, and `?inherited=true` adds the rows derived from
 * them, each marked viaSubjectId. The web does not copy the rule. A screen that JUDGES who is qualified
 * (the candidate badge and the lists that sort by it) must therefore ask for the derived rows, and a
 * screen that WRITES the list back must not get them, or a derived row would be saved as a second,
 * stored one. Both are one word apart in a hook call, so this reads web/lib, web/components and web/app
 * (not the tests) and fails on
 *
 *  1. a file that reads the endpoint or calls useTeacherQualifications() and is not classified below;
 *  2. a file classified JUDGES that does not ask for { inherited: true };
 *  3. a file classified STORED that does: the form, the card, the drawer and the file for the
 *     samverkan CSV show or print what is stored;
 *  4. a file that judges coverage itself — qualificationCovers, candidateQualification,
 *     strongestCoveringQualification — outside the modules that define them and the two screens
 *     classified JUDGES: it would be reading rows from somewhere this does not see.
 */

const WEB = path.resolve(__dirname, "..");
const ROOTS = ["lib", "components", "app"];

type Basis = "JUDGES" | "STORED" | "DEFINES";

const CLASSIFIED: Record<string, { basis: Basis; why: string }> = {
  "app/[locale]/(app)/admin/requirements/page.tsx": {
    basis: "JUDGES",
    why: "the candidate badges and the matrix's unqualified list, and the dialog it hands the rows to",
  },
  "app/[locale]/(app)/admin/people/page.tsx": {
    basis: "STORED",
    why: "the person's form, and the file the behörigheter CSV is built from",
  },
  "app/[locale]/(app)/admin/staffing/page.tsx": {
    basis: "STORED",
    why: "the drawer's card of the teacher's own behörigheter; the report it sits beside is the gateway's",
  },
  "app/[locale]/(app)/admin/reports/staffing-report.tsx": {
    basis: "STORED",
    why: "the samverkan file prints what the table holds, and imports back to it",
  },
  "lib/staffing-queries.ts": {
    basis: "DEFINES",
    why: "the hook, and the write that replaces a teacher's whole list",
  },
};

/** Modules that define or mirror the coverage rule, and screens that judge by rows handed to them. */
const COVERAGE_MODULES = new Set([
  "lib/standard-week.ts",
  "lib/teacher-load.ts",
  "lib/staffing-candidates.ts",
  "components/timplan/term-halves-dialog.tsx",
  "app/[locale]/(app)/admin/requirements/page.tsx",
]);

// The hook, the gateway's endpoint (also behind a `${base}` prefix), and PostgREST's table by name: a screen can read the rows
// through any of the three, and only the first two are ones this file knew to look for.
const READS = /useTeacherQualifications\s*\(|["'`]\/api\/v1\/teacher-qualifications|\$\{[^}]*\}\/api\/v1\/teacher-qualifications|["'`]TeacherSubjectQualifications["'`]/;
const ASKS_INHERITED = /useTeacherQualifications\s*\(\s*[^)]*inherited\s*:\s*true/;
const JUDGES_COVERAGE = /\b(?:qualificationCovers|candidateQualification|strongestCoveringQualification)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const FILES = ROOTS.flatMap((root) => sources(path.join(WEB, root))).map((full) => ({
  path: path.relative(WEB, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));
const textOf = (file: string) => FILES.find((candidate) => candidate.path === file)?.text ?? "";

describe("who on the web reads a behörighet", () => {
  it("recognises every way a screen can read the rows, and nothing else", () => {
    // The inventory is only as good as READS: a read it cannot see is a screen nobody classified.
    const reads = [
      "const { data } = useTeacherQualifications();",
      'api.get<TeacherQualification[]>("/api/v1/teacher-qualifications")',
      "api.get(`/api/v1/teacher-qualifications?userId=${id}`)",
      "fetch(`${base}/api/v1/teacher-qualifications`)",
      'await selectAll<Row>("TeacherSubjectQualifications", "userId, subjectId", "userId")',
      "supabase.from('TeacherSubjectQualifications').select('*')",
    ];
    const notReads = ["const subjects = useSubjects();", 'api.get("/api/v1/teacher-employments")', "// the qualifications of one teacher"];
    expect(reads.filter((text) => !READS.test(text))).toEqual([]);
    expect(notReads.filter((text) => READS.test(text))).toEqual([]);
  });

  it("has every reader of the endpoint classified", () => {
    const unclassified = FILES.filter((file) => READS.test(file.text) && !(file.path in CLASSIFIED)).map((file) => file.path);
    expect(unclassified).toEqual([]);
  });

  it("has every JUDGES screen ask for the derived rows", () => {
    const judges = Object.entries(CLASSIFIED).filter(([, { basis }]) => basis === "JUDGES");
    expect(judges.length).toBeGreaterThan(0);
    for (const [file] of judges) {
      expect({ file, inherited: ASKS_INHERITED.test(textOf(file)) }).toEqual({ file, inherited: true });
    }
  });

  it("has no STORED screen ask for them", () => {
    for (const [file, { basis }] of Object.entries(CLASSIFIED)) {
      if (basis === "JUDGES") continue;
      expect({ file, inherited: /inherited\s*:\s*true|inherited=true/.test(textOf(file)) && basis === "STORED" }).toEqual({
        file,
        inherited: false,
      });
    }
  });

  it("has no classified file that is gone, or reads nothing", () => {
    for (const [file] of Object.entries(CLASSIFIED)) {
      expect({ file, reads: READS.test(textOf(file)) }).toEqual({ file, reads: true });
    }
  });

  it("lets no other file judge coverage by rows of its own", () => {
    const judging = FILES.filter((file) => JUDGES_COVERAGE.test(file.text) && !COVERAGE_MODULES.has(file.path)).map((file) => file.path);
    expect(judging).toEqual([]);
  });
});
