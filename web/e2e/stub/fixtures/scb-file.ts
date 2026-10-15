import type { ScbFile, ScbMissing, ScbNotice } from "../../../lib/scb-file";
import type { AcademicYear } from "../../../lib/types";
import { TODAY } from "./calendar";
import { SCHOOL_UNITS } from "./misc-school";
import { loadReport } from "./staffing-load";
import { EMPLOYMENTS } from "./staffing-rows";
import { TEACHER_LIST } from "./world";

/**
 * GET /api/v1/staffing/scb-file as the gateway answers the fixture school's
 * year: one row per teacher in the load report (a post or teaching), in
 * family-name order, from the post's own row. Anna's spring period begins
 * after the mätdatum, so the base row is her post on 15 October.
 *
 * NARROWER THAN THE GATEWAY ON PURPOSE. The stub answers the columns its rows
 * fill — SCB's first nine, OmfLarare, the karriärtjänster and Undervisning —
 * where the gateway writes all 80 and splits a teacher over skolenheter and
 * stadier by their teaching (src/staffing/scb/scb-pedpers.ts, and its spec,
 * hold that arithmetic). What the browser does with the answer is the same
 * whatever the width: it saves `text`, writes `rows` as a CSV, and lists
 * `missing` and `notices`. Every teacher of the fixture school teaches 7–9,
 * so each row is verksamhetstyp 6 in the school's one skolenhet.
 */
const COLUMNS = [
  "System",
  "Datum",
  "Version",
  "SkolenhetsKod",
  "PersonNr",
  "PersonNamn",
  "Verksamhetstyp",
  "SkolenhetNamn",
  "AnstForm",
  "OmfLarare",
  "ForsteLarare",
  "Lektor",
  "Undervisning",
];

const byFamilyName = new Intl.Collator("sv", { numeric: true });

export function scbFileOf(year: AcademicYear): ScbFile {
  const unit = SCHOOL_UNITS[0]!;
  const matdatum = `${year.startDate.slice(0, 4)}-10-15`;
  const rows: string[][] = [];
  const missing: ScbMissing[] = [];
  const notices: ScbNotice[] = [];
  const teachers = loadReport(year)
    .teachers.map((row) => ({ row, person: TEACHER_LIST.find((teacher) => teacher.id === row.userId)! }))
    .filter(({ row, person }) => person && (row.employment !== null || row.assignedMinutesPerWeek > 0))
    .sort((a, b) => byFamilyName.compare(a.person.lastName, b.person.lastName));
  for (const { row, person } of teachers) {
    const name = `${person.firstName} ${person.lastName}`;
    const post = row.employment
      ? (EMPLOYMENTS.find((candidate) => candidate.userId === row.userId && candidate.academicYearId === year.id) ?? null)
      : null;
    const form = post?.employmentForm === "TILLSVIDARE" ? "T" : post?.employmentForm === "VISSTID" ? "V" : "";
    const omf = post ? Math.round(post.employmentPercent - post.reductionPercent) : null;
    rows.push([
      "SchemaPro",
      TODAY,
      "0.1.0",
      unit.code ?? "",
      "",
      name,
      "6",
      unit.name,
      form,
      omf === null ? "" : String(omf),
      post?.firstTeacherPercent ? String(post.firstTeacherPercent) : "",
      post?.lecturerPercent ? String(post.lecturerPercent) : "",
      "J",
    ]);
    const fields: ScbMissing["fields"] = [];
    if (form === "" && post) fields.push("ANSTFORM");
    if (omf === null) fields.push("OMFATTNING");
    if (fields.length > 0) missing.push({ line: rows.length, name, unit: unit.name, verksamhetstyp: "6", fields });
    if (!post) notices.push({ code: "NO_POST", params: { name } });
    if (post && post.reductionPercent > 0) notices.push({ code: "REDUCTION", params: { name } });
  }
  return {
    filename: `scb-pedagogisk-personal-${year.name.replace(/[^0-9A-Za-z-]+/g, "-")}.txt`,
    matdatum,
    specVersionDate: "2026-05-07",
    columns: COLUMNS,
    rows,
    text: rows.map((values) => `${values.join(";")}\r\n`).join(""),
    missing,
    notices,
  };
}
