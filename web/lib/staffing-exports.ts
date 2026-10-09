/**
 * Tjänstefördelningens two CSV exports (staffing Fas 3), built in the browser
 * from what the report tab already holds: the year's load report (planned),
 * the reconciliation over the chosen range, and the names.
 *
 * IMPORTED ON CLICK (`import()` in the report tab), so no route carries it.
 * Both files go through serializeCsv — UTF-8 BOM, `;`, CRLF, formulas
 * neutralised — which is what Swedish Excel opens. Decimals are written with
 * csvDecimal: a decimal comma, an ASCII minus and no grouping. NOT
 * toLocaleString("sv-SE"): that writes negatives with U+2212, which Excel
 * reads as text (C15).
 *
 *   A. "Tjänstefördelning för samverkan" — one row per teacher with a post, a
 *      planned row or anything in the reconciliation (a vikarie with neither
 *      post nor plan who held lessons is NOT dropped), sorted by family name.
 *
 *   B. "SCB Pedagogisk personal, underlag" — rows shaped by SCB's
 *      datafilsbeskrivning for HT 2026, as an UNDERLAG to complete and check,
 *      never as SCB's file. See SCB_PEDPERS_2026 below for the source and what
 *      SchemaPro cannot fill.
 *
 * Pure: every input is passed in, the output is a string and a list of
 * notices the tab renders. Nothing here names a person beyond what the
 * caller hands over, and legitimation is never written to the SCB file.
 */

import { serializeCsv } from "@/lib/csv-export";
import { compareSwedish } from "@/lib/sorting";
import type { GradeSpan, LoadModel, TeacherLoad } from "@/lib/teacher-load";
import type { TeacherReconciliation } from "@/lib/staffing-reconciliation";
import type { SchoolForm, Subject, TeacherDuty, TeacherQualification } from "@/lib/types";

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A number for a Swedish spreadsheet: rounded to `digits`, a decimal comma,
 * an ASCII hyphen-minus, no thousands separator; an integer stays plain.
 * Null and non-finite values are an empty cell, never "NaN".
 */
export function csvDecimal(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  if (Number.isInteger(rounded)) return String(rounded === 0 ? 0 : rounded);
  return rounded.toFixed(digits).replace(/0+$/, "").replace(".", ",");
}

const whole = (value: number | null | undefined): string => csvDecimal(value, 0);

/**
 * Integers that sum to `total`, proportional to `weights`, by largest
 * remainder (ties to the earlier entry). All-zero weights give all zeros.
 */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const floors = exact.map((value) => Math.floor(value));
  let left = total - floors.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface ExportPerson {
  firstName: string;
  lastName: string;
}

/** Who a userId is, or null when the people list cannot say. */
export type PersonOf = (userId: string) => ExportPerson | null;

/** A teacher the roster cannot name keeps their signature, else the id's head. */
function personOrFallback(
  userId: string,
  personOf: PersonOf,
  signature: string | null | undefined,
): ExportPerson {
  return personOf(userId) ?? { firstName: "", lastName: signature ?? userId.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// A. Tjänstefördelning för samverkan
// ---------------------------------------------------------------------------

export interface SamverkanInput {
  loadModel: LoadModel;
  /** The year's planned report rows (GET /staffing/load). */
  load: readonly TeacherLoad[];
  /** The reconciliation's teachers over the range (GET /staffing/delivered). */
  reconciliation: readonly TeacherReconciliation[];
  from: string;
  to: string;
  personOf: PersonOf;
  subjectName: (subjectId: string) => string;
  /**
   * The behörigheter column, only when the admin ticked "Ta med behörigheter"
   * for THIS file; null leaves the column out entirely.
   */
  qualifications: readonly TeacherQualification[] | null;
}

const KIND_WORD: Record<TeacherQualification["kind"], string> = {
  LEGITIMATION: "legitimation",
  BEHORIG: "behörig",
  TILLATEN: "tillåten",
};

export const SAMVERKAN_HEADERS = [
  "Efternamn",
  "Förnamn",
  "Signatur",
  "Tjänstgöringsgrad %",
  "Nedsättning %",
  "Avtalsform",
  "Riktmärke min/v",
  "Undervisning min/v (standardvecka)",
  "Toppvecka min/v",
  "Uppdrag min/v",
  "Räknat mot riktmärket min/v",
  "Saldo min/v",
  "Andel av riktmärke %",
  "Undervisning h/år",
  "Uppdrag h/år",
  "Reglerad arbetstid h/år (skolans inställning)",
  "Årsarbetstid h/år (skolans inställning)",
  "A-dagar (skolans inställning)",
  "Ämnen min/v",
  "Planerat i perioden min (avrundat per rad)",
  "Schemalagt i perioden min (avrundat per rad)",
  "Genomfört i perioden min (avrundat per rad)",
  "Varav som vikarie min",
  "Vikarierad av andra min",
  "Bortfall min",
  "Period från",
  "Period till",
  "Beräkningsmodell",
] as const;

/**
 * Under FACTOR every minute the load report and the reconciliation charge is
 * RÄKNAD tid — lesson time × the subject's factor — and a file cited in a
 * samverkan protokoll must not call it undervisning. The charged columns are
 * renamed, as the matrix and the AnnualCard already say "räknad tid", and the
 * real lesson time (Σ assignments.timeMinutesPerWeek, never weighted) gets a
 * column of its own beside it. Under MINUTES the two are the same figure and
 * the file is exactly SAMVERKAN_HEADERS, unchanged.
 */
const FACTOR_HEADER: Partial<Record<(typeof SAMVERKAN_HEADERS)[number], string>> = {
  "Undervisning min/v (standardvecka)": "Räknad undervisning min/v (standardvecka, faktor)",
  "Toppvecka min/v": "Räknad toppvecka min/v (faktor)",
  "Räknat mot riktmärket min/v": "Räknat mot riktmärket min/v (faktor)",
  "Saldo min/v": "Saldo min/v (räknad tid, faktor)",
  "Undervisning h/år": "Räknad undervisning h/år (faktor)",
  "Ämnen min/v": "Ämnen räknad tid min/v (faktor)",
  "Planerat i perioden min (avrundat per rad)": "Planerat i perioden min (räknad tid, faktor, avrundat per rad)",
  "Schemalagt i perioden min (avrundat per rad)": "Schemalagt i perioden min (räknad tid, faktor, avrundat per rad)",
  "Genomfört i perioden min (avrundat per rad)": "Genomfört i perioden min (räknad tid, faktor, avrundat per rad)",
  "Varav som vikarie min": "Varav som vikarie min (räknad tid, faktor)",
  "Vikarierad av andra min": "Vikarierad av andra min (räknad tid, faktor)",
  "Bortfall min": "Bortfall min (räknad tid, faktor)",
};
/** Under FACTOR, after the charged undervisning: the lesson time itself. */
export const SAMVERKAN_TIME_HEADER = "Undervisningstid min/v (standardvecka, utan faktor)";
const TIME_AFTER = SAMVERKAN_HEADERS.indexOf("Undervisning min/v (standardvecka)") + 1;

export function samverkanHeaders(loadModel: LoadModel): string[] {
  if (loadModel !== "FACTOR") return [...SAMVERKAN_HEADERS];
  const headers: string[] = SAMVERKAN_HEADERS.map((header) => FACTOR_HEADER[header] ?? header);
  headers.splice(TIME_AFTER, 0, SAMVERKAN_TIME_HEADER);
  return headers;
}

export function samverkanCsv(input: SamverkanInput): string {
  const loadOf = new Map(input.load.map((row) => [row.userId, row]));
  const recOf = new Map(input.reconciliation.map((row) => [row.userId, row]));
  const ids = [...new Set([...loadOf.keys(), ...recOf.keys()])];
  const people = ids.map((id) => ({
    id,
    person: personOrFallback(id, input.personOf, loadOf.get(id)?.employment?.signature),
  }));
  people.sort(
    (a, b) =>
      compareSwedish(a.person.lastName, b.person.lastName) ||
      compareSwedish(a.person.firstName, b.person.firstName) ||
      (a.id < b.id ? -1 : 1),
  );
  const model = input.loadModel === "FACTOR" ? "Faktor" : "Minuter";

  const rows = people.map(({ id, person }) => {
    const load = loadOf.get(id);
    const rec = recOf.get(id);
    const employment = load?.employment ?? null;
    const subjects = [...(load?.subjects ?? [])]
      .sort((a, b) => b.minutesPerWeek - a.minutesPerWeek || compareSwedish(a.subjectName, b.subjectName))
      .map((subject) => `${subject.subjectName} ${whole(subject.minutesPerWeek)}`)
      .join("; ");
    const row = [
      person.lastName,
      person.firstName,
      employment?.signature ?? "",
      csvDecimal(employment?.employmentPercent, 3),
      csvDecimal(employment?.reductionPercent, 3),
      employment ? (employment.contractKind === "FERIE" ? "Ferietjänst" : "Semestertjänst") : "",
      whole(load?.targetMinutesPerWeek),
      whole(load?.assignedMinutesPerWeek),
      whole(load?.peakMinutesPerWeek),
      whole(load?.dutyMinutesPerWeek),
      whole(load?.countedMinutesPerWeek),
      whole(load?.balanceMinutesPerWeek),
      csvDecimal(load?.percentOfTarget, 1),
      csvDecimal(load?.annual.assignedHoursPerYear, 1),
      csvDecimal(load?.annual.dutyHoursPerYear, 1),
      csvDecimal(load?.annual.regulatedHoursPerYear, 1),
      csvDecimal(load?.annual.annualHours, 1),
      // A-dagar belong to a ferietjänst's frame; without a post there is none.
      employment ? whole(load?.annual.workDaysPerYear) : "",
      subjects,
      whole(rec?.planned),
      whole(rec?.scheduled),
      whole(rec?.delivered),
      whole(rec?.substituteMinutes),
      whole(rec?.coveredByOthersMinutes),
      whole(rec?.lostMinutes),
      input.from,
      input.to,
      model,
    ];
    if (input.loadModel === "FACTOR") {
      const time = load?.assignments?.reduce((sum, assignment) => sum + assignment.timeMinutesPerWeek, 0);
      row.splice(TIME_AFTER, 0, whole(time));
    }
    if (input.qualifications !== null) {
      row.push(
        input.qualifications
          .filter((qualification) => qualification.userId === id)
          .map(
            (q) =>
              `${input.subjectName(q.subjectId)} åk ${
                q.minGradeLevel === q.maxGradeLevel ? q.minGradeLevel : `${q.minGradeLevel}–${q.maxGradeLevel}`
              } (${KIND_WORD[q.kind]})`,
          )
          .sort(compareSwedish)
          .join("; "),
      );
    }
    return row;
  });

  const headers = samverkanHeaders(input.loadModel);
  if (input.qualifications !== null) headers.push("Behörigheter");
  return serializeCsv(headers, rows);
}

export function samverkanFilename(yearName: string, from: string, to: string): string {
  return `tjanstefordelning-${yearName.replace(/[^0-9A-Za-z-]+/g, "-")}-${from}-${to}.csv`;
}

// ---------------------------------------------------------------------------
// B. SCB Pedagogisk personal — underlag
// ---------------------------------------------------------------------------

/**
 * SCB, "Pedagogisk personal HT 2026, Datafilsbeskrivning", sheet
 * "Postbeskrivning", "Specifikation, versionsdatum 2026-05-07", "Format:
 * Semikolonseparerad textfil":
 *   https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/datafilsbeskrivning-pedagogisk-personal-2026.xlsx
 * and SCB, "Pedagogisk personal 2026, Instruktioner" (mätdatum 15 oktober
 * 2026, sista insändningsdag 2 november 2026):
 *   https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/instruktioner-pedagogisk-personal-2026.pdf
 * both linked from https://www.scb.se/lamna-uppgifter/undersokningar/Pedagogisk-personal/,
 * retrieved and checked 2026-10-09.
 *
 * The 80 variable names in SCB's order, each with the verksamhetstyper the
 * sheet's matrix ("Vilka verksamhetstyper ska ange vilka variabler?",
 * columns L, O and R) marks for it among the three this export can emit:
 *   F  Förskoleklass (1)
 *   G  Grundskola åk 1-3, 4-6, 7-9 (4, 5, 6)
 *   A  Anpassad grundskola åk 1-3, 4-6, 7-9 (10, 11, 12)
 * A column a row's verksamhetstyp does not collect is left empty on it.
 *
 * What the datafilsbeskrivning does NOT state — a header row, an encoding,
 * a byte order mark — this file adds as SchemaPro's own choice, for a file
 * opened in Excel and pasted into SCB's Excelmall; the report tab and the
 * manual say so. The upload takes SCB's Excelmall or a system's .txt.
 */
export const SCB_PEDPERS_2026 = {
  title: "Pedagogisk personal HT 2026, Datafilsbeskrivning",
  specVersionDate: "2026-05-07",
  sourceUrl:
    "https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/datafilsbeskrivning-pedagogisk-personal-2026.xlsx",
  instructionsUrl:
    "https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/instruktioner-pedagogisk-personal-2026.pdf",
  retrieved: "2026-10-09",
  columns: [
    ["System", "FGA"], // 1
    ["Datum", "FGA"], // 2
    ["Version", "FGA"], // 3
    ["SkolenhetsKod", "FGA"], // 4
    ["PersonNr", "FGA"], // 5
    ["PersonNamn", "FGA"], // 6
    ["Verksamhetstyp", "FGA"], // 7
    ["SkolenhetNamn", "FGA"], // 8
    ["AnstForm", "FGA"], // 9
    ["OmfRektor", "FGA"], // 10
    ["OmfLedn", "FGA"], // 11
    ["OmfSYV", "FGA"], // 12
    ["OmfPersBibliotek", "FGA"], // 13
    ["OmfFritidsledare", ""], // 14
    ["OmfSpeciallarare", "FGA"], // 15
    ["OmfSpecialpedagog", "FGA"], // 16
    ["OmfAsyl", "FGA"], // 17
    ["OmfAnnanP", "FGA"], // 18
    ["Omfstudieh", "FGA"], // 19
    ["OmfLararass", "FGA"], // 20
    ["OmfLarare", "FGA"], // 21
    ["OmfSFISVA", ""], // 22
    ["OmfSFIMMAL", ""], // 23
    ["KvxSfiTyp", ""], // 24
    ["AnordnOrgNr", ""], // 25
    ["ForsteLarare", "FGA"], // 26
    ["Lektor", "FGA"], // 27
    ["Undervisning", "GA"], // 28
    ["OmfBiologi", "GA"], // 29
    ["OmfFysik", "GA"], // 30
    ["OmfGeografi", "GA"], // 31
    ["OmfHistoria", "GA"], // 32
    ["OmfIdrott", "GA"], // 33
    ["OmfKemi", "GA"], // 34
    ["OmfMatematik", "GA"], // 35
    ["OmfReligion", "GA"], // 36
    ["OmfSamhall", "GA"], // 37
    ["OmfBild", "GA"], // 38
    ["OmfHemKonsum", "GA"], // 39
    ["OmfMusik", "GA"], // 40
    ["OmfSlojd", "GA"], // 41
    ["OmfTeknik", "GA"], // 42
    ["OmfSvenska", "GA"], // 43
    ["OmfSVA", "GA"], // 44
    ["OmfEngelska", "GA"], // 45
    ["OmfFranska", "GA"], // 46
    ["OmfSpanska", "GA"], // 47
    ["OmfTyska", "GA"], // 48
    ["OmfSamiska", "G"], // 49
    ["OmfOvrigtSprak", "GA"], // 50
    ["OmfTeckensprak", "GA"], // 51
    ["OmfMMAL", "GA"], // 52
    ["MMalKod", "GA"], // 53
    ["OmfPsykologi", ""], // 54
    ["OmfFilosofi", ""], // 55
    ["OmfEstetisk", "A"], // 56
    ["OmfNaturkunsk", ""], // 57
    ["OmfYrkes", ""], // 58
    ["HuvudYrkesAmn1", ""], // 59
    ["HuvudYrkesAmn2", ""], // 60
    ["HuvudYrkesAmn3", ""], // 61
    ["OmfBilaga4", ""], // 62
    ["Bilaga4amn1", ""], // 63
    ["Bilaga4amn2", ""], // 64
    ["Bilaga4amn3", ""], // 65
    ["OmfVissa", ""], // 66
    ["Vissaamn1", ""], // 67
    ["Vissaamn2", ""], // 68
    ["Vissaamn3", ""], // 69
    ["OmfYrkesgsar", ""], // 70
    ["HuvudYrkesgsarAmn1", ""], // 71
    ["HuvudYrkesgsarAmn2", ""], // 72
    ["HuvudYrkesgsarAmn3", ""], // 73
    ["OmfKommunikation", "A"], // 74
    ["OmfMotorik", "A"], // 75
    ["OmfVardagsaktiviteter", "A"], // 76
    ["OmfVerklighetsuppfattning", "A"], // 77
    ["OmfIndivid", ""], // 78
    ["OmfNaturo", ""], // 79
    ["OmfSprakochk", ""], // 80
  ] as const satisfies readonly (readonly [string, string])[],
} as const;

export type ScbColumn = (typeof SCB_PEDPERS_2026.columns)[number][0];

/**
 * What goes in column 3, "Leverantörens systemversion, fritext" (max 15):
 * SchemaPro's release, web/package.json's version (a vitest keeps them
 * equal). SCB marks the column "B = Bokstäver" while calling it fritext; a
 * version has digits — said in the manual and an open question until SCB
 * answers or a real return is checked.
 */
export const SCB_SYSTEM = "SchemaPro";
export const SCB_SYSTEM_VERSION = "0.1.0";

/** The verksamhetstyper this export emits; "" = a row SchemaPro cannot code. */
export type Verksamhetstyp = "1" | "4" | "5" | "6" | "10" | "11" | "12" | "";

const familyOf = (type: Verksamhetstyp): "F" | "G" | "A" | null =>
  type === "1" ? "F" : type === "4" || type === "5" || type === "6" ? "G" : type === "" ? null : "A";

/** Whether SCB collects `column` for a row of verksamhetstyp `type`. */
export function scbColumnApplies(column: ScbColumn, type: Verksamhetstyp): boolean {
  const family = familyOf(type);
  if (family === null) return true; // an uncoded row: the admin decides
  const entry = SCB_PEDPERS_2026.columns.find(([name]) => name === column);
  return entry !== undefined && entry[1].includes(family);
}

/**
 * The SCB subject column a school subject's teaching is reported in, from
 * its national code (Subjects.nationalCode), or null when SCB has no single
 * column for it: the ämnesgrupper NO and SO (SCB wants Bi/Fy/Ke and
 * Ge/Hi/Re/Sh), Fördelningsbar undervisningstid, Rörelse och drama, and every
 * subject outside the national timplan.
 *
 *   SV_SVA  OmfSvenska, or OmfSVA when the school's code is "SVA" or the
 *           name says andraspråk;
 *   M2      OmfFranska / OmfSpanska / OmfTyska by name, else OmfOvrigtSprak.
 */
export function scbColumnOf(subject: Pick<Subject, "nationalCode" | "code" | "name">): ScbColumn | null {
  const name = subject.name.toLocaleLowerCase("sv");
  switch (subject.nationalCode) {
    case "BI":
      return "OmfBiologi";
    case "FY":
      return "OmfFysik";
    case "GE":
      return "OmfGeografi";
    case "HI":
      return "OmfHistoria";
    case "IDH":
      return "OmfIdrott";
    case "KE":
      return "OmfKemi";
    case "MA":
      return "OmfMatematik";
    case "RE":
      return "OmfReligion";
    case "SH":
      return "OmfSamhall";
    case "BL":
      return "OmfBild";
    case "HKK":
      return "OmfHemKonsum";
    case "MU":
      return "OmfMusik";
    case "SL":
      return "OmfSlojd";
    case "TK":
      return "OmfTeknik";
    case "EN":
      return "OmfEngelska";
    case "TSP":
      return "OmfTeckensprak";
    case "SAM":
      return "OmfSamiska";
    case "EST":
      return "OmfEstetisk";
    case "KOM":
      return "OmfKommunikation";
    case "MOT":
      return "OmfMotorik";
    case "VAR":
      return "OmfVardagsaktiviteter";
    case "VER":
      return "OmfVerklighetsuppfattning";
    case "SV_SVA":
      return subject.code?.trim().toUpperCase() === "SVA" || name.includes("andraspråk")
        ? "OmfSVA"
        : "OmfSvenska";
    case "M2":
      if (name.includes("franska")) return "OmfFranska";
      if (name.includes("spanska")) return "OmfSpanska";
      if (name.includes("tyska")) return "OmfTyska";
      return "OmfOvrigtSprak";
    default:
      return null;
  }
}

export type ScbNoticeCode =
  | "NOT_HT2026"
  | "NO_POST"
  | "FULL_LEAVE"
  | "REDUCTION"
  | "FORSTELARARE"
  | "ADMIN"
  | "LEFT_OUT"
  | "NO_SPAN"
  | "GRADE_OUT_OF_SCOPE"
  | "FORM_WITHOUT_CODE"
  | "GRADE_WITHOUT_TIMPLAN"
  | "ALL_LEFT_OUT";

export interface ScbNotice {
  code: ScbNoticeCode;
  params: Record<string, string | number>;
}

export interface ScbInput {
  /** The export day in the school's zone, YYYY-MM-DD (column 2). */
  exportDate: string;
  /** The läsår's first day: a year not starting in 2026 gets the "check this year's" notice. */
  yearStartDate: string;
  schoolName: string;
  /** The planned report rows of the selected YEAR (SCB asks for the läsår's plan). */
  load: readonly TeacherLoad[];
  duties: readonly Pick<TeacherDuty, "userId" | "kind">[];
  subjects: readonly Pick<Subject, "id" | "nationalCode" | "code" | "name">[];
  /** The year's årskurs → the lokal timplan's skolform (AcademicYearTimplans). */
  schoolFormByGrade: ReadonlyMap<number, SchoolForm>;
  personOf: PersonOf;
  /** SCHOOL_ADMIN users: a post of theirs is reported as Lärare, with a notice. */
  adminIds: ReadonlySet<string>;
}

interface StageBucket {
  type: Verksamhetstyp;
  /** Every minute of teaching on the stage, mapped or not: OmfLarare's weight. */
  minutes: number;
  /** Minutes per SCB subject column that applies on the stage. */
  byColumn: Map<ScbColumn, number>;
}

/** The verksamhetstyp a grade is reported under, and why not when it cannot be. */
function stageOf(
  grade: number,
  formByGrade: ReadonlyMap<number, SchoolForm>,
): { type: Verksamhetstyp; notice?: ScbNotice } {
  if (grade === 0) return { type: "1" };
  if (grade < 1 || grade > 9) return { type: "", notice: { code: "GRADE_OUT_OF_SCOPE", params: { grade } } };
  const band = grade <= 3 ? 0 : grade <= 6 ? 1 : 2;
  const form = formByGrade.get(grade);
  if (form === "ANPASSAD_GRUNDSKOLA_AMNEN" || form === "ANPASSAD_GRUNDSKOLA_AMNESOMRADEN") {
    return { type: (["10", "11", "12"] as const)[band] };
  }
  if (form === "SPECIALSKOLA" || form === "SAMESKOLA") {
    // SCB's list of verksamhetstyper has no code for either.
    return { type: "", notice: { code: "FORM_WITHOUT_CODE", params: { grade, form } } };
  }
  const type = (["4", "5", "6"] as const)[band];
  return form === undefined
    ? { type, notice: { code: "GRADE_WITHOUT_TIMPLAN", params: { grade } } }
    : { type };
}

const gradesOf = (span: GradeSpan): number[] =>
  Array.from({ length: Math.max(0, span.max - span.min + 1) }, (_, index) => span.min + index);

const STAGE_ORDER: Verksamhetstyp[] = ["1", "4", "5", "6", "10", "11", "12", ""];

export function scbUnderlag(input: ScbInput): { csv: string; notices: ScbNotice[] } {
  const notices: ScbNotice[] = [];
  const once = new Set<string>();
  const notice = (entry: ScbNotice) => {
    const key = `${entry.code}|${JSON.stringify(entry.params)}`;
    if (once.has(key)) return;
    once.add(key);
    notices.push(entry);
  };
  if (!input.yearStartDate.startsWith("2026")) {
    notice({ code: "NOT_HT2026", params: { version: SCB_PEDPERS_2026.specVersionDate } });
  }
  const subjectOf = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const columns = SCB_PEDPERS_2026.columns.map(([name]) => name);
  const blank = (): Record<string, string> => Object.fromEntries(columns.map((name) => [name, ""]));

  const teachers = input.load
    .filter((row) => row.employment !== null || (row.assignments ?? []).some((a) => a.timeMinutesPerWeek > 0))
    .map((row) => ({ row, person: personOrFallback(row.userId, input.personOf, row.employment?.signature) }))
    .sort(
      (a, b) =>
        compareSwedish(a.person.lastName, b.person.lastName) ||
        compareSwedish(a.person.firstName, b.person.firstName) ||
        (a.row.userId < b.row.userId ? -1 : 1),
    );

  const out: string[][] = [];
  for (const { row, person } of teachers) {
    const name = `${person.firstName} ${person.lastName}`.trim();
    const employment = row.employment;
    const omf = employment ? employment.employmentPercent - employment.reductionPercent : null;

    // Teaching per stage, in UNWEIGHTED undervisningstid (C11): SCB's
    // ämnesomfattning is how the teacher's teaching TIME is divided, so a
    // FACTOR school's weights stay out of it.
    const buckets = new Map<Verksamhetstyp, StageBucket>();
    const bucketOf = (type: Verksamhetstyp): StageBucket => {
      let bucket = buckets.get(type);
      if (!bucket) {
        bucket = { type, minutes: 0, byColumn: new Map() };
        buckets.set(type, bucket);
      }
      return bucket;
    };
    for (const assignment of row.assignments ?? []) {
      const minutes = assignment.timeMinutesPerWeek;
      if (!(minutes > 0)) continue;
      const subject = subjectOf.get(assignment.subjectId);
      const column = subject ? scbColumnOf(subject) : null;
      const label = `${assignment.subjectName} ${assignment.groupName}`;
      let shares: { type: Verksamhetstyp; minutes: number }[];
      if (assignment.gradeSpan === null) {
        notice({ code: "NO_SPAN", params: { name, line: label } });
        shares = [{ type: "", minutes }];
      } else {
        // A group spanning stages (6–7) is split by its grades in each.
        const grades = gradesOf(assignment.gradeSpan);
        shares = grades.map((grade) => {
          const stage = stageOf(grade, input.schoolFormByGrade);
          if (stage.notice) notice(stage.notice);
          return { type: stage.type, minutes: minutes / grades.length };
        });
      }
      for (const share of shares) {
        const bucket = bucketOf(share.type);
        bucket.minutes += share.minutes;
        if (column !== null && share.type !== "1" && scbColumnApplies(column, share.type)) {
          bucket.byColumn.set(column, (bucket.byColumn.get(column) ?? 0) + share.minutes);
        } else if (share.type !== "1") {
          // SCB: a subject without a column "utelämnas … övriga ämnen ska
          // höjas proportionellt upp till 100 procent". Named, never silent.
          notice({ code: "LEFT_OUT", params: { name, line: label } });
        }
      }
    }

    if (employment && employment.reductionPercent > 0 && omf !== null && omf > 0) {
      notice({ code: "REDUCTION", params: { name } });
    }
    if (input.duties.some((duty) => duty.userId === row.userId && duty.kind === "FORSTELARARE")) {
      notice({ code: "FORSTELARARE", params: { name } });
    }
    if (input.adminIds.has(row.userId)) notice({ code: "ADMIN", params: { name } });
    if (omf === null) notice({ code: "NO_POST", params: { name } });

    const base = (type: Verksamhetstyp) => {
      const record = blank();
      record.System = SCB_SYSTEM;
      record.Datum = input.exportDate;
      record.Version = SCB_SYSTEM_VERSION;
      record.PersonNamn = name;
      record.Verksamhetstyp = type;
      record.SkolenhetNamn = input.schoolName;
      return record;
    };

    const stages = STAGE_ORDER.map((type) => buckets.get(type)).filter(
      (bucket): bucket is StageBucket => bucket !== undefined && bucket.minutes > 0,
    );

    if (omf !== null && omf <= 0) {
      // Helt nedsatt: SCB reports a tjänstledig with the post held before
      // the leave and wants no subjects for them (AnstForm L).
      notice({ code: "FULL_LEAVE", params: { name } });
      const largest = [...stages].sort((a, b) => b.minutes - a.minutes)[0];
      const record = base(largest?.type ?? "");
      record.OmfLarare = String(Math.round(employment!.employmentPercent));
      out.push(columns.map((column) => record[column] ?? ""));
      continue;
    }
    if (stages.length === 0) {
      const record = base("");
      record.OmfLarare = omf === null ? "" : String(Math.round(omf));
      record.Undervisning = "N";
      out.push(columns.map((column) => record[column] ?? ""));
      continue;
    }

    // OmfLarare over the stage rows by their teaching minutes; a row whose
    // share rounds to 0 is merged into the largest (SCB wants subjects on
    // every row with OmfLarare > 0, and a 0 row is noise).
    let rows = stages.map((bucket) => ({ ...bucket, byColumn: new Map(bucket.byColumn) }));
    let omfShares =
      omf === null ? rows.map(() => null) : largestRemainder(rows.map((bucket) => bucket.minutes), Math.round(omf));
    if (omf !== null && rows.length > 1 && omfShares.some((share) => share === 0)) {
      const largest = rows.reduce((best, bucket, index) => (bucket.minutes > rows[best]!.minutes ? index : best), 0);
      const keep = rows[largest]!;
      rows.forEach((bucket, index) => {
        if (index === largest || omfShares[index] !== 0) return;
        keep.minutes += bucket.minutes;
        for (const [column, minutes] of bucket.byColumn) {
          if (scbColumnApplies(column, keep.type)) {
            keep.byColumn.set(column, (keep.byColumn.get(column) ?? 0) + minutes);
          }
        }
      });
      rows = rows.filter((_, index) => index === largest || omfShares[index] !== 0);
      omfShares = largestRemainder(rows.map((bucket) => bucket.minutes), Math.round(omf));
    }

    rows.forEach((bucket, index) => {
      const record = base(bucket.type);
      const share = omfShares[index];
      record.OmfLarare = share === null || share === undefined ? "" : String(share);
      if (bucket.type !== "1") {
        const mapped = [...bucket.byColumn.entries()].filter(([, minutes]) => minutes > 0);
        if (mapped.length === 0) {
          notice({ code: "ALL_LEFT_OUT", params: { name } });
        } else {
          record.Undervisning = "J";
          const percents = largestRemainder(
            mapped.map(([, minutes]) => minutes),
            100,
          );
          mapped.forEach(([column], position) => {
            if (percents[position]! > 0) record[column] = String(percents[position]);
          });
        }
      }
      out.push(columns.map((column) => record[column] ?? ""));
    });
  }

  return { csv: serializeCsv(columns, out), notices };
}

export function scbFilename(yearName: string): string {
  return `scb-pedagogisk-personal-underlag-${yearName.replace(/[^0-9A-Za-z-]+/g, "-")}.csv`;
}
