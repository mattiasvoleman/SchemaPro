/**
 * Tjänstefördelning för samverkan (staffing Fas 3), the CSV built in the
 * browser from what the report tab already holds: the year's load report
 * (planned), the reconciliation over the chosen range, and the names. One row
 * per teacher with a post, a planned row or anything in the reconciliation (a
 * vikarie with neither post nor plan who held lessons is NOT dropped), sorted
 * by family name.
 *
 * IMPORTED ON CLICK (`import()` in the report tab), so no route carries it.
 * The file goes through serializeCsv — UTF-8 BOM, `;`, CRLF, formulas
 * neutralised — which is what Swedish Excel opens. Decimals are written with
 * csvDecimal: a decimal comma, an ASCII minus and no grouping. NOT
 * toLocaleString("sv-SE"): that writes negatives with U+2212, which Excel
 * reads as text (C15).
 *
 * SCB's Pedagogisk personal was built here too, as an underlag, until the
 * gateway built the file itself (src/staffing/scb, lib/scb-file.ts).
 *
 * Pure: every input is passed in, the output is a string. Nothing here names
 * a person beyond what the caller hands over.
 */

import { serializeCsv } from "@/lib/csv-export";
import { postOn } from "@/lib/employment-periods";
import { isJudged } from "@/lib/period-view";
import { compareSwedish } from "@/lib/sorting";
import {
  qualificationValidInYear,
  type LoadModel,
  type LoadStatus,
  type PeriodLoad,
  type TeacherLoad,
} from "@/lib/teacher-load";
import type { TeacherReconciliation } from "@/lib/staffing-reconciliation";
import type { TeacherQualification } from "@/lib/types";

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
  /** The läsår's bounds: a behörighet is listed only if valid at some point of it. */
  year: { startDate: string; endDate: string };
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
  "Tjänstens perioder",
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
  "Tjänstens perioder": "Tjänstens perioder (räknad tid, faktor)",
};
/** Under FACTOR, after the charged undervisning: the lesson time itself. */
export const SAMVERKAN_TIME_HEADER = "Undervisningstid min/v (standardvecka, utan faktor)";
const TIME_AFTER = SAMVERKAN_HEADERS.indexOf("Undervisning min/v (standardvecka)") + 1;

/**
 * When some post in the file changes during the year, the grad and the
 * nedsättning are the post on the läsår's first day, beside a riktmärke and
 * hours weighted over its periods. The headers say so, as the
 * uppdragsbeskrivning does; a file without such a post keeps its headers.
 */
const AT_START_HEADER: Partial<Record<(typeof SAMVERKAN_HEADERS)[number], string>> = {
  "Tjänstgöringsgrad %": "Tjänstgöringsgrad % vid läsårets start",
  "Nedsättning %": "Nedsättning % vid läsårets start",
};

export function samverkanHeaders(loadModel: LoadModel, postsChange = false): string[] {
  const named = (header: (typeof SAMVERKAN_HEADERS)[number]): string =>
    (postsChange ? AT_START_HEADER[header] : undefined) ??
    (loadModel === "FACTOR" ? FACTOR_HEADER[header] : undefined) ??
    header;
  const headers: string[] = SAMVERKAN_HEADERS.map(named);
  if (loadModel === "FACTOR") headers.splice(TIME_AFTER, 0, SAMVERKAN_TIME_HEADER);
  return headers;
}

const STATUS_WORD: Record<LoadStatus, string> = {
  OVER: "över mål",
  UNDER: "under mål",
  OK: "i nivå",
  NO_TARGET: "inget mål",
};

/**
 * A post that changes during the year (20261022120000), stretch by stretch,
 * in one cell: the dates, the figures and each stretch's own verdict, so the
 * file says which part of the year is over. Empty for a post the same all
 * year, whose figures are the row's.
 */
export function stretchesCell(periods: readonly PeriodLoad[] | undefined): string {
  return (periods ?? [])
    .map((period) => {
      const figures =
        `${csvDecimal(period.employmentPercent, 3)} %` +
        (period.reductionPercent > 0 ? `, nedsättning ${csvDecimal(period.reductionPercent, 3)} %` : "");
      const verdict = !isJudged(period)
        ? "ingen undervisningsvecka"
        : period.targetMinutesPerWeek === null
          ? `räknat ${whole(period.countedMinutesPerWeek)} min/v, inget mål`
          : `riktmärke ${whole(period.targetMinutesPerWeek)} min/v, räknat ${whole(period.countedMinutesPerWeek)} min/v, ${STATUS_WORD[period.status]}`;
      return `${period.from}–${period.to}: ${figures}, ${verdict}`;
    })
    .join("; ");
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
    // A post that changes during the year: its grad and nedsättning as on
    // the läsår's first day, the stretches in their own column.
    const employment = load?.employment ? postOn(load.employment, input.year.startDate) : null;
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
      stretchesCell(load?.periods),
    ];
    if (input.loadModel === "FACTOR") {
      const time = load?.assignments?.reduce((sum, assignment) => sum + assignment.timeMinutesPerWeek, 0);
      row.splice(TIME_AFTER, 0, whole(time));
    }
    if (input.qualifications !== null) {
      row.push(
        input.qualifications
          // A tidsbegränsad behörighet that ended before the läsår (or starts
          // after it) is not this year's: the file goes to the unions, and a
          // lapsed TILLATEN must not read as current. The load report's own
          // test, so the file and the matrix agree.
          .filter((qualification) => qualification.userId === id && qualificationValidInYear(qualification, input.year))
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

  const headers = samverkanHeaders(
    input.loadModel,
    input.load.some((row) => (row.periods?.length ?? 0) > 0),
  );
  if (input.qualifications !== null) headers.push("Behörigheter");
  return serializeCsv(headers, rows);
}

export function samverkanFilename(yearName: string, from: string, to: string): string {
  return `tjanstefordelning-${yearName.replace(/[^0-9A-Za-z-]+/g, "-")}-${from}-${to}.csv`;
}
