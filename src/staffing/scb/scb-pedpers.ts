import type { SchoolForm, TeacherEmploymentForm } from '@prisma/client';
import { compareUnits, gradeOutsideUnits, unitForGrade, type UnitSpan } from '../../school-units/school-unit-map';
import { dutyRunsOn, type DutyDates } from '../duty-dates';
import { postOn, type LoadPeriod, type PostFigures } from '../employment-periods';
import type { GradeSpan, TeacherAssignment } from '../teacher-load';
import type { GradeNumbering } from '../../common/grade-numbering';

/*
 * SCB:s Pedagogisk personal, the file itself: built by the gateway in SCB's
 * own text format, one row per teacher, skolenhet and verksamhetstyp, from the
 * year's planned load, the post as it is on SCB's mätdatum and the school's
 * skolenheter.
 *
 * Until this phase the web built an UNDERLAG in the browser (a CSV to paste
 * into SCB's Excelmall) and left AnstForm, ForsteLarare and Lektor to the
 * school. The post now holds the anställningsform and the karriärtjänst
 * shares (migration 20261111090000), so the file fills them, and one builder
 * answers both downloads: the .txt SCB takes, and the same rows as a CSV for
 * Excel, which the web writes from `columns` and `rows`.
 *
 * PURE: every input is passed in (scb-file.service.ts reads them in one RLS
 * transaction), the output is the file and what it could not fill.
 *
 * THE SOURCE. SCB, "Pedagogisk personal HT 2026, Datafilsbeskrivning", sheet
 * "Postbeskrivning", "Specifikation, versionsdatum 2026-05-07", "Format:
 * Semikolonseparerad textfil":
 *   https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/datafilsbeskrivning-pedagogisk-personal-2026.xlsx
 * and SCB, "Pedagogisk personal 2026, Instruktioner" (mätdatum 15 oktober):
 *   https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/instruktioner-pedagogisk-personal-2026.pdf
 * both linked from https://www.scb.se/lamna-uppgifter/undersokningar/Pedagogisk-personal/,
 * retrieved and checked 2026-10-09 and again 2026-10-15.
 *
 * WHAT THE FILE FILLS, column by column, where it is not plain:
 *
 *   PersonNr       EMPTY on every row. SchemaPro stores no personnummer; the
 *                  school types it, and the download says so once.
 *   AnstForm       L when the post on the mätdatum is wholly reduced for 30
 *                  days or more (SCB: "helt tjänstledig eller sjukskriven 30
 *                  dagar eller längre"); otherwise T or V from the post's
 *                  anställningsform, empty (and listed) while the school has
 *                  not said. U belongs to SCB's prefilled rows and is never
 *                  written. A full leave SHORTER than 30 days is reported "som
 *                  tjänstgörande, med sin generella tjänsteomfattning": the
 *                  post just after the leave (or just before it), with a
 *                  notice.
 *   OmfLarare      the post on the mätdatum, tjänstgöringsgrad minus
 *                  nedsättning, spread over the person's rows by their
 *                  teaching minutes (largest remainder, summing to the post).
 *                  A tjänstledig person: the post itself, on one row, without
 *                  subjects ("Tjänstlediga lärare behöver inte rapportera
 *                  undervisningsämnen").
 *   ForsteLarare,  the post's share, spread over the person's rows like the
 *   Lektor         omfattning, so the rows sum to it — SCB asks for "hur stor
 *                  andel av tjänsten" and reports a person on several rows
 *                  "med proportionellt fördelad tjänsteomfattning". A
 *                  förstelärare uppdrag on the mätdatum with no share on the
 *                  post is listed.
 *   Omf<ämne>      the teaching time per SCB subject on the row, summing to
 *                  100; a subject SCB has no column for is left out and named.
 *
 * THE TEXT FORMAT. The datafilsbeskrivning states semicolons and each
 * column's length, and SCB takes only .txt. It states no header row, no
 * encoding and no line ending; SchemaPro's choices, said in the manual:
 *
 *   * no header row: line 1 is the first person;
 *   * UTF-8 without a byte order mark. A reader expecting Latin-1 still
 *     reads every byte (Å, Ä, Ö in a name come out as two letters each); a
 *     Latin-1 file read as UTF-8 can fail outright. The columns SCB checks —
 *     codes, numbers, dates — are ASCII either way;
 *   * CRLF after every line, the last one too;
 *   * a value holding ";" or a line break has it replaced by a space, and
 *     PersonNamn and SkolenhetNamn are cut to SCB's 100 characters. Nothing
 *     else is rewritten: this file is read by SCB, not opened in Excel, so
 *     the CSV's formula guard (web/lib/csv-export.ts) belongs to the CSV.
 */

export const SCB_PEDPERS_2026 = {
  title: 'Pedagogisk personal HT 2026, Datafilsbeskrivning',
  specVersionDate: '2026-05-07',
  sourceUrl:
    'https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/datafilsbeskrivning-pedagogisk-personal-2026.xlsx',
  instructionsUrl:
    'https://www.scb.se/contentassets/88d3362c14814f1fbc7f2523529002c8/instruktioner-pedagogisk-personal-2026.pdf',
  /**
   * The 80 variable names in SCB's order, each with the verksamhetstyper the
   * sheet's matrix ("Vilka verksamhetstyper ska ange vilka variabler?",
   * columns L, O and R) marks for it among the three this file can emit:
   *   F  Förskoleklass (1)
   *   G  Grundskola åk 1-3, 4-6, 7-9 (4, 5, 6)
   *   A  Anpassad grundskola åk 1-3, 4-6, 7-9 (10, 11, 12)
   * A column a row's verksamhetstyp does not collect is left empty on it.
   */
  columns: [
    ['System', 'FGA'], // 1
    ['Datum', 'FGA'], // 2
    ['Version', 'FGA'], // 3
    ['SkolenhetsKod', 'FGA'], // 4
    ['PersonNr', 'FGA'], // 5
    ['PersonNamn', 'FGA'], // 6
    ['Verksamhetstyp', 'FGA'], // 7
    ['SkolenhetNamn', 'FGA'], // 8
    ['AnstForm', 'FGA'], // 9
    ['OmfRektor', 'FGA'], // 10
    ['OmfLedn', 'FGA'], // 11
    ['OmfSYV', 'FGA'], // 12
    ['OmfPersBibliotek', 'FGA'], // 13
    ['OmfFritidsledare', ''], // 14
    ['OmfSpeciallarare', 'FGA'], // 15
    ['OmfSpecialpedagog', 'FGA'], // 16
    ['OmfAsyl', 'FGA'], // 17
    ['OmfAnnanP', 'FGA'], // 18
    ['Omfstudieh', 'FGA'], // 19
    ['OmfLararass', 'FGA'], // 20
    ['OmfLarare', 'FGA'], // 21
    ['OmfSFISVA', ''], // 22
    ['OmfSFIMMAL', ''], // 23
    ['KvxSfiTyp', ''], // 24
    ['AnordnOrgNr', ''], // 25
    ['ForsteLarare', 'FGA'], // 26
    ['Lektor', 'FGA'], // 27
    ['Undervisning', 'GA'], // 28
    ['OmfBiologi', 'GA'], // 29
    ['OmfFysik', 'GA'], // 30
    ['OmfGeografi', 'GA'], // 31
    ['OmfHistoria', 'GA'], // 32
    ['OmfIdrott', 'GA'], // 33
    ['OmfKemi', 'GA'], // 34
    ['OmfMatematik', 'GA'], // 35
    ['OmfReligion', 'GA'], // 36
    ['OmfSamhall', 'GA'], // 37
    ['OmfBild', 'GA'], // 38
    ['OmfHemKonsum', 'GA'], // 39
    ['OmfMusik', 'GA'], // 40
    ['OmfSlojd', 'GA'], // 41
    ['OmfTeknik', 'GA'], // 42
    ['OmfSvenska', 'GA'], // 43
    ['OmfSVA', 'GA'], // 44
    ['OmfEngelska', 'GA'], // 45
    ['OmfFranska', 'GA'], // 46
    ['OmfSpanska', 'GA'], // 47
    ['OmfTyska', 'GA'], // 48
    ['OmfSamiska', 'G'], // 49
    ['OmfOvrigtSprak', 'GA'], // 50
    ['OmfTeckensprak', 'GA'], // 51
    ['OmfMMAL', 'GA'], // 52
    ['MMalKod', 'GA'], // 53
    ['OmfPsykologi', ''], // 54
    ['OmfFilosofi', ''], // 55
    ['OmfEstetisk', 'A'], // 56
    ['OmfNaturkunsk', ''], // 57
    ['OmfYrkes', ''], // 58
    ['HuvudYrkesAmn1', ''], // 59
    ['HuvudYrkesAmn2', ''], // 60
    ['HuvudYrkesAmn3', ''], // 61
    ['OmfBilaga4', ''], // 62
    ['Bilaga4amn1', ''], // 63
    ['Bilaga4amn2', ''], // 64
    ['Bilaga4amn3', ''], // 65
    ['OmfVissa', ''], // 66
    ['Vissaamn1', ''], // 67
    ['Vissaamn2', ''], // 68
    ['Vissaamn3', ''], // 69
    ['OmfYrkesgsar', ''], // 70
    ['HuvudYrkesgsarAmn1', ''], // 71
    ['HuvudYrkesgsarAmn2', ''], // 72
    ['HuvudYrkesgsarAmn3', ''], // 73
    ['OmfKommunikation', 'A'], // 74
    ['OmfMotorik', 'A'], // 75
    ['OmfVardagsaktiviteter', 'A'], // 76
    ['OmfVerklighetsuppfattning', 'A'], // 77
    ['OmfIndivid', ''], // 78
    ['OmfNaturo', ''], // 79
    ['OmfSprakochk', ''], // 80
  ] as const satisfies readonly (readonly [string, string])[],
} as const;

export type ScbColumn = (typeof SCB_PEDPERS_2026.columns)[number][0];

export const SCB_COLUMNS: readonly ScbColumn[] = SCB_PEDPERS_2026.columns.map(([name]) => name);

/**
 * Columns 1 and 3, "System från vilket datafilen är uttagen" and
 * "Leverantörens systemversion, fritext", both at most 15. The version is
 * SchemaPro's release, the root package.json's (a spec keeps them equal).
 * SCB marks column 3 "B = Bokstäver" while calling it fritext; a version has
 * digits — said in the manual's "Kontrollera innan inlämning" (6.9), with
 * what to write should SCB's check refuse it; open until SCB answers or a
 * return is checked.
 */
export const SCB_SYSTEM = 'Rastra Schema';
export const SCB_SYSTEM_VERSION = '0.1.0';

/** SCB's maximum for PersonNamn and SkolenhetNamn. */
const NAME_MAX = 100;

/** SCB: "helt tjänstledig eller sjukskriven 30 dagar eller längre" is L. */
export const SCB_LEAVE_MIN_DAYS = 30;

/** The verksamhetstyper this file emits; "" = a row SchemaPro cannot code. */
export type Verksamhetstyp = '1' | '4' | '5' | '6' | '10' | '11' | '12' | '';

const familyOf = (type: Verksamhetstyp): 'F' | 'G' | 'A' | null =>
  type === '1' ? 'F' : type === '4' || type === '5' || type === '6' ? 'G' : type === '' ? null : 'A';

/** Whether SCB collects `column` for a row of verksamhetstyp `type`. */
export function scbColumnApplies(column: ScbColumn, type: Verksamhetstyp): boolean {
  const family = familyOf(type);
  if (family === null) return true; // an uncoded row: the admin decides
  const entry = SCB_PEDPERS_2026.columns.find(([name]) => name === column);
  return entry !== undefined && (entry[1] as string).includes(family);
}

export interface ScbSubject {
  id: string;
  nationalCode: string | null;
  code: string | null;
  name: string;
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
export function scbColumnOf(subject: Pick<ScbSubject, 'nationalCode' | 'code' | 'name'>): ScbColumn | null {
  const name = subject.name.toLocaleLowerCase('sv');
  switch (subject.nationalCode) {
    case 'BI':
      return 'OmfBiologi';
    case 'FY':
      return 'OmfFysik';
    case 'GE':
      return 'OmfGeografi';
    case 'HI':
      return 'OmfHistoria';
    case 'IDH':
      return 'OmfIdrott';
    case 'KE':
      return 'OmfKemi';
    case 'MA':
      return 'OmfMatematik';
    case 'RE':
      return 'OmfReligion';
    case 'SH':
      return 'OmfSamhall';
    case 'BL':
      return 'OmfBild';
    case 'HKK':
      return 'OmfHemKonsum';
    case 'MU':
      return 'OmfMusik';
    case 'SL':
      return 'OmfSlojd';
    case 'TK':
      return 'OmfTeknik';
    case 'EN':
      return 'OmfEngelska';
    case 'TSP':
      return 'OmfTeckensprak';
    case 'SAM':
      return 'OmfSamiska';
    case 'EST':
      return 'OmfEstetisk';
    case 'KOM':
      return 'OmfKommunikation';
    case 'MOT':
      return 'OmfMotorik';
    case 'VAR':
      return 'OmfVardagsaktiviteter';
    case 'VER':
      return 'OmfVerklighetsuppfattning';
    case 'SV_SVA':
      return subject.code?.trim().toUpperCase() === 'SVA' || name.includes('andraspråk') ? 'OmfSVA' : 'OmfSvenska';
    case 'M2':
      if (name.includes('franska')) return 'OmfFranska';
      if (name.includes('spanska')) return 'OmfSpanska';
      if (name.includes('tyska')) return 'OmfTyska';
      return 'OmfOvrigtSprak';
    default:
      return null;
  }
}

/**
 * What SchemaPro did, or could not decide, that the school should know before
 * it sends the file. Each is said once (the same code and params twice is one
 * notice), in the order met: teachers by family name.
 */
export type ScbNoticeCode =
  | 'NOT_HT2026'
  | 'NO_POST'
  | 'INACTIVE'
  | 'NO_TEACHING'
  | 'LEAVE'
  | 'SHORT_LEAVE'
  | 'LONG_ABSENCE'
  | 'POST_CHANGES'
  | 'REDUCTION'
  | 'ADMIN'
  | 'LEFT_OUT'
  | 'NO_SPAN'
  | 'GRADE_OUT_OF_SCOPE'
  | 'FORM_WITHOUT_CODE'
  | 'GRADE_WITHOUT_TIMPLAN'
  | 'NO_SCHOOL_UNIT'
  | 'UNIT_WITHOUT_CODE'
  | 'GRADE_WITHOUT_UNIT';

export interface ScbNotice {
  code: ScbNoticeCode;
  params: Record<string, string | number>;
}

/**
 * What a row still lacks, beyond PersonNr (which every row lacks, said once):
 *
 *   ANSTFORM            the post states no anställningsform;
 *   OMFATTNING          no post: OmfLarare and AnstForm are empty;
 *   VERKSAMHETSTYP      the row's teaching has no årskurs SCB codes, or there is none;
 *   SKOLENHETSKOD       the row's skolenhet has no code, or the school has no skolenhet;
 *   AMNEN               a grundskola row with teaching but no subject SCB has a column for;
 *   FORSTELARARE_ANDEL  a förstelärare uppdrag on the mätdatum, and no share on the post.
 */
export const SCB_MISSING_FIELDS = [
  'ANSTFORM',
  'OMFATTNING',
  'VERKSAMHETSTYP',
  'SKOLENHETSKOD',
  'AMNEN',
  'FORSTELARARE_ANDEL',
] as const;
export type ScbMissingField = (typeof SCB_MISSING_FIELDS)[number];

export interface ScbMissing {
  /** The row's line in the .txt, from 1 (the CSV's row below its header). */
  line: number;
  name: string;
  /** SkolenhetNamn as written. */
  unit: string;
  verksamhetstyp: Verksamhetstyp;
  /** In SCB_MISSING_FIELDS order. */
  fields: ScbMissingField[];
}

/** The post, as the load report reads it, with what SCB asks of it besides. */
export interface ScbEmployment extends PostFigures {
  signature: string | null;
  periods?: readonly LoadPeriod[];
  employmentForm: TeacherEmploymentForm | null;
  firstTeacherPercent: number | null;
  lecturerPercent: number | null;
}

export interface ScbTeacher {
  userId: string;
  employment: ScbEmployment | null;
  assignments: readonly Pick<TeacherAssignment, 'subjectId' | 'subjectName' | 'groupName' | 'gradeSpan' | 'timeMinutesPerWeek'>[];
}

export interface ScbFileInput {
  /** The download day in the school's zone, yyyy-mm-dd (column 2). */
  exportDate: string;
  /**
   * The läsår: its name for the file name, its bounds for a leave's length,
   * and its numbering (absent is NIOARIG) for the skolenhet and the stadium.
   */
  year: { name: string; startDate: string; endDate: string; gradeNumbering?: GradeNumbering };
  schoolName: string;
  /** The year's planned report rows, each post with its three SCB fields. */
  teachers: readonly ScbTeacher[];
  /** The year's FORSTELARARE uppdrag with their dates. */
  firstTeacherDuties: readonly ({ userId: string } & DutyDates)[];
  /**
   * The teachers' registered absences (TeacherAbsences, ACTIVE) over the
   * läsår, as the school's days they run, both inclusive. Their reason is
   * not read: a long absence is named whatever it is. Records that follow on
   * from each other are one absence (absenceStretches).
   */
  absences?: readonly ScbAbsence[];
  subjects: readonly ScbSubject[];
  /** The year's årskurs → the lokal timplan's skolform (AcademicYearTimplans). */
  schoolFormByGrade: ReadonlyMap<number, SchoolForm>;
  /**
   * The teachers' names; `inactiveSince` for an account that is deactivated:
   * the day it was (yyyy-mm-dd), or null when it was before the day was
   * kept (20261021100000).
   */
  people: ReadonlyMap<string, { firstName: string; lastName: string; inactiveSince?: string | null }>;
  /** SCHOOL_ADMIN users: a post of theirs is reported as Lärare, with a notice. */
  adminIds: ReadonlySet<string>;
  /** The school's skolenheter: a row is one person, one skolenhet and one verksamhetstyp. */
  units: readonly UnitSpan[];
}

export interface ScbAbsence {
  userId: string;
  /** The first day the absence touches. */
  from: string;
  /** The last day it touches: its length is from..to. */
  to: string;
  /**
   * The last day it covers whole, where a following absence picks it up:
   * `to` for an absence that ends at the school's midnight, the day before
   * for one ended during the day (Avsluta i förtid on the morning the
   * teacher is back, a day they work). Absent: `to`.
   */
  through?: string;
}

/** SCB's mätdatum for a läsår: 15 oktober of its autumn. */
export function scbMatdatum(yearStartDate: string): string {
  return `${yearStartDate.slice(0, 4)}-10-15`;
}

/**
 * Whether an absence covers the mätdatum and runs 30 days or more: what SCB
 * counts as tjänstledig when it is from the whole post. SchemaPro reads L
 * from the nedsättning; an absence registered for cover is not a post, so
 * the file names it for the school instead of guessing (LONG_ABSENCE).
 */
export function longAbsenceOver(absence: Pick<ScbAbsence, 'from' | 'to'>, matdatum: string): boolean {
  return absence.from <= matdatum && matdatum <= absence.to && daysFrom(absence.from, absence.to) >= SCB_LEAVE_MIN_DAYS;
}

/** The day after `day`, past a Saturday and Sunday: where an absence that goes on picks up. */
function nextWeekday(day: string): string {
  let next = addDays(day, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00.000Z`).getUTCDay())) next = addDays(next, 1);
  return next;
}

/**
 * A teacher's absences as SCB counts a leave: records that overlap, touch
 * or pick up after a weekend are one stretch. The cover module refuses
 * overlapping records and lets a teacher report only from today, so a sick
 * leave that goes on is a chain of records — one per week, or per
 * certificate — none of which is 30 days on its own. As leaveAround joins a
 * post's periods.
 *
 * A record picks up from the last day the one before it covers WHOLE
 * (`through`): one ended on Friday morning was a Friday at work, so a record
 * from Monday is a new absence, while one ended at Friday's midnight runs
 * on into Monday's. A record that starts on a day the one before it still
 * touches always joins it.
 */
export function absenceStretches(absences: readonly ScbAbsence[]): ScbAbsence[] {
  const sorted = [...absences].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  const stretches: ScbAbsence[] = [];
  for (const absence of sorted) {
    const last = stretches[stretches.length - 1];
    const through = absence.through ?? absence.to;
    if (
      last &&
      last.userId === absence.userId &&
      (absence.from <= last.to || absence.from <= nextWeekday(last.through ?? last.to))
    ) {
      if (absence.to > last.to) last.to = absence.to;
      if (through > (last.through ?? last.to)) last.through = through;
    } else {
      stretches.push({ ...absence, through });
    }
  }
  return stretches;
}

/** The teacher's absence stretch of 30 days or more over the mätdatum, if they have one. */
export function longAbsenceOf(
  absences: readonly ScbAbsence[],
  userId: string,
  matdatum: string,
): Pick<ScbAbsence, 'userId' | 'from' | 'to'> | undefined {
  const stretch = absenceStretches(absences.filter((absence) => absence.userId === userId)).find((candidate) =>
    longAbsenceOver(candidate, matdatum),
  );
  return stretch && { userId: stretch.userId, from: stretch.from, to: stretch.to };
}

export interface ScbFile {
  filename: string;
  /** SCB's mätdatum, 15 oktober of the läsår's autumn. */
  matdatum: string;
  specVersionDate: string;
  columns: ScbColumn[];
  /** The rows as written, 80 values each: the CSV's body. */
  rows: string[][];
  /** The .txt SCB takes. */
  text: string;
  missing: ScbMissing[];
  notices: ScbNotice[];
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * Whole numbers proportional to `weights` that sum to exactly `total`
 * (largest remainder; ties to the earlier index). All zeros when nothing
 * weighs or nothing is to be shared.
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

/** Swedish order with numbers as numbers, the web's compareSwedish. */
const collator = new Intl.Collator('sv', { numeric: true, sensitivity: 'variant', caseFirst: 'false' });

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (day: string, days: number): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS) + 1;

const omfOf = (post: PostFigures): number => post.employmentPercent - post.reductionPercent;
const whollyReduced = (post: PostFigures): boolean => omfOf(post) <= 0;

/**
 * The days around `day` the post is wholly reduced on, clamped to `lo`..`hi`;
 * null when it is not on `day`. Adjacent periods that are each a full
 * nedsättning are one leave, as SCB counts a leave.
 */
function leaveAround(
  employment: ScbEmployment,
  day: string,
  lo: string,
  hi: string,
): { from: string; to: string; days: number } | null {
  if (!whollyReduced(postOn(employment, day))) return null;
  let from = day;
  let to = day;
  while (from > lo && whollyReduced(postOn(employment, addDays(from, -1)))) from = addDays(from, -1);
  while (to < hi && whollyReduced(postOn(employment, addDays(to, 1)))) to = addDays(to, 1);
  return { from, to, days: daysFrom(from, to) };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The verksamhetstyp a grade is reported under, and why not when it cannot be.
 * A tioårig läsår's stadier are 1–4 / 5–7 / 8–10 and it has no förskoleklass
 * (SFS 2025:729); SCB has not yet published how it codes them, so they take
 * the stadium codes their pupils had (NOT_HT2026 says the spec is 2026's).
 */
function stageOf(
  grade: number,
  formByGrade: ReadonlyMap<number, SchoolForm>,
  numbering: GradeNumbering,
): { type: Verksamhetstyp; notice?: ScbNotice } {
  const tioarig = numbering === 'TIOARIG';
  if (grade === 0 && !tioarig) return { type: '1' };
  if (grade < 1 || grade > (tioarig ? 10 : 9)) return { type: '', notice: { code: 'GRADE_OUT_OF_SCOPE', params: { grade } } };
  const band = tioarig ? (grade <= 4 ? 0 : grade <= 7 ? 1 : 2) : grade <= 3 ? 0 : grade <= 6 ? 1 : 2;
  const form = formByGrade.get(grade);
  if (form === 'ANPASSAD_GRUNDSKOLA_AMNEN' || form === 'ANPASSAD_GRUNDSKOLA_AMNESOMRADEN') {
    return { type: (['10', '11', '12'] as const)[band] };
  }
  if (form === 'SPECIALSKOLA' || form === 'SAMESKOLA') {
    // SCB's list of verksamhetstyper has no code for either.
    return { type: '', notice: { code: 'FORM_WITHOUT_CODE', params: { grade, form } } };
  }
  const type = (['4', '5', '6'] as const)[band];
  return form === undefined ? { type, notice: { code: 'GRADE_WITHOUT_TIMPLAN', params: { grade } } } : { type };
}

const gradesOf = (span: GradeSpan): number[] =>
  Array.from({ length: Math.max(0, span.max - span.min + 1) }, (_, index) => span.min + index);

const STAGE_ORDER: Verksamhetstyp[] = ['1', '4', '5', '6', '10', '11', '12', ''];

interface StageBucket {
  /** The skolenhet's id, or "" when the school has none. */
  unit: string;
  type: Verksamhetstyp;
  /** Every minute of teaching on the stage, mapped or not: OmfLarare's weight. */
  minutes: number;
  /** Minutes per SCB subject column that applies on the stage. */
  byColumn: Map<ScbColumn, number>;
}

/** A value as the .txt holds it: no separator, no line break, no control character. */
export function scbValue(value: string, max?: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f;]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return max === undefined ? flat : [...flat].slice(0, max).join('').trim();
}

/**
 * Whether a teacher of the report is in the file: one with a post, or with
 * teaching (a vikarie with planned rows and no post is reported, and listed
 * for what they lack). The service records exactly these.
 */
export function inScbFile(row: Pick<ScbTeacher, 'employment' | 'assignments'>): boolean {
  return row.employment !== null || row.assignments.some((assignment) => assignment.timeMinutesPerWeek > 0);
}

export function scbFilename(yearName: string): string {
  return `scb-pedagogisk-personal-${yearName.replace(/[^0-9A-Za-z-]+/g, '-')}.txt`;
}

export function buildScbFile(input: ScbFileInput): ScbFile {
  const notices: ScbNotice[] = [];
  const once = new Set<string>();
  const notice = (entry: ScbNotice) => {
    const key = `${entry.code}|${JSON.stringify(entry.params)}`;
    if (once.has(key)) return;
    once.add(key);
    notices.push(entry);
  };
  if (!input.year.startDate.startsWith('2026')) {
    notice({ code: 'NOT_HT2026', params: { version: SCB_PEDPERS_2026.specVersionDate } });
  }
  // SCB counts the staff as on its mätdatum, 15 oktober of the läsår's
  // autumn: a post that changes during the year is reported as it is that day.
  const matdatum = scbMatdatum(input.year.startDate);
  // A leave is measured inside the läsår (and to the mätdatum, should a year
  // not hold it): a leave from before the year counts from its first day.
  const lo = matdatum < input.year.startDate ? matdatum : input.year.startDate;
  const hi = matdatum > input.year.endDate ? matdatum : input.year.endDate;

  const subjectOf = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const units = [...input.units].sort(compareUnits);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  if (units.length === 0) notice({ code: 'NO_SCHOOL_UNIT', params: {} });
  /** The unit a grade's teaching is reported under ("" without units), naming a grade no span holds. */
  const numbering = input.year.gradeNumbering ?? 'NIOARIG';
  const unitOf = (grade: number | null): string => {
    const unit = unitForGrade(units, grade, numbering);
    if (!unit) return '';
    if (grade !== null && gradeOutsideUnits(units, grade, numbering)) {
      notice({ code: 'GRADE_WITHOUT_UNIT', params: { grade, unit: unit.name } });
    }
    return unit.id;
  };
  const unitOrder = (id: string) => units.findIndex((unit) => unit.id === id);
  const blank = (): Record<string, string> => Object.fromEntries(SCB_COLUMNS.map((name) => [name, '']));
  const firstTeachers = new Set(
    input.firstTeacherDuties.filter((duty) => dutyRunsOn(duty, matdatum)).map((duty) => duty.userId),
  );

  const teachers = input.teachers
    .filter(inScbFile)
    .map((row) => ({
      row,
      person: input.people.get(row.userId) ?? {
        firstName: '',
        lastName: row.employment?.signature ?? row.userId.slice(0, 8),
      },
    }))
    .sort(
      (a, b) =>
        collator.compare(a.person.lastName, b.person.lastName) ||
        collator.compare(a.person.firstName, b.person.firstName) ||
        (a.row.userId < b.row.userId ? -1 : a.row.userId > b.row.userId ? 1 : 0),
    );

  const records: { record: Record<string, string>; missing: ScbMissingField[] }[] = [];

  for (const { row, person } of teachers) {
    const name = `${person.firstName} ${person.lastName}`.trim();
    const employment = row.employment;
    if ((employment?.periods ?? []).length > 0) notice({ code: 'POST_CHANGES', params: { name, date: matdatum } });

    // The post SCB is told about: the one on the mätdatum, or — for a full
    // leave shorter than SCB's 30 days — the post around the leave.
    let post: PostFigures | null = employment ? postOn(employment, matdatum) : null;
    let onLeave = false;
    if (employment && post && whollyReduced(post)) {
      const leave = leaveAround(employment, matdatum, lo, hi)!;
      const around =
        leave.to < hi ? postOn(employment, addDays(leave.to, 1)) : leave.from > lo ? postOn(employment, addDays(leave.from, -1)) : null;
      if (leave.days < SCB_LEAVE_MIN_DAYS && around && !whollyReduced(around)) {
        notice({ code: 'SHORT_LEAVE', params: { name, from: leave.from, to: leave.to } });
        post = around;
      } else {
        onLeave = true;
        notice({ code: 'LEAVE', params: { name, from: leave.from, to: leave.to } });
      }
    }
    const omf = post && !onLeave ? omfOf(post) : null;

    // Teaching per stage, in UNWEIGHTED undervisningstid: SCB's
    // ämnesomfattning is how the teacher's teaching TIME is divided, so a
    // FACTOR school's weights stay out of it.
    const buckets = new Map<string, StageBucket>();
    const bucketOf = (unit: string, type: Verksamhetstyp): StageBucket => {
      const key = `${unit}|${type}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { unit, type, minutes: 0, byColumn: new Map() };
        buckets.set(key, bucket);
      }
      return bucket;
    };
    for (const assignment of row.assignments) {
      const minutes = assignment.timeMinutesPerWeek;
      if (!(minutes > 0)) continue;
      const subject = subjectOf.get(assignment.subjectId);
      const column = subject ? scbColumnOf(subject) : null;
      const label = `${assignment.subjectName} ${assignment.groupName}`;
      let shares: { unit: string; type: Verksamhetstyp; minutes: number }[];
      if (assignment.gradeSpan === null) {
        notice({ code: 'NO_SPAN', params: { name, line: label } });
        shares = [{ unit: unitOf(null), type: '', minutes }];
      } else {
        // A group spanning stages (6–7), or skolenheter (F–6 and 7–9), is
        // split by its grades in each.
        const grades = gradesOf(assignment.gradeSpan);
        shares = grades.map((grade) => {
          const stage = stageOf(grade, input.schoolFormByGrade, numbering);
          if (stage.notice) notice(stage.notice);
          return { unit: unitOf(grade), type: stage.type, minutes: minutes / grades.length };
        });
      }
      for (const share of shares) {
        const bucket = bucketOf(share.unit, share.type);
        bucket.minutes += share.minutes;
        if (column !== null && share.type !== '1' && scbColumnApplies(column, share.type)) {
          bucket.byColumn.set(column, (bucket.byColumn.get(column) ?? 0) + share.minutes);
        } else if (share.type !== '1' && !onLeave) {
          // SCB: a subject without a column "utelämnas … övriga ämnen ska
          // höjas proportionellt upp till 100 procent". Named, never silent.
          notice({ code: 'LEFT_OUT', params: { name, line: label } });
        }
      }
    }

    if (post && !onLeave && post.reductionPercent > 0 && omf !== null && omf > 0) {
      notice({ code: 'REDUCTION', params: { name } });
    }
    if (input.adminIds.has(row.userId)) notice({ code: 'ADMIN', params: { name } });
    if (!employment) notice({ code: 'NO_POST', params: { name } });
    const absence = longAbsenceOf(input.absences ?? [], row.userId, matdatum);
    if (absence) notice({ code: 'LONG_ABSENCE', params: { name, from: absence.from, to: absence.to } });
    // A post outlives its account: whether the person still worked on the
    // mätdatum is the school's to say, so the row stays and is named.
    const inactiveSince = input.people.get(row.userId)?.inactiveSince;
    if (inactiveSince !== undefined) notice({ code: 'INACTIVE', params: { name, date: inactiveSince ?? 'none' } });

    const anstForm = onLeave
      ? 'L'
      : employment?.employmentForm === 'TILLSVIDARE'
        ? 'T'
        : employment?.employmentForm === 'VISSTID'
          ? 'V'
          : '';
    const lacksShare = firstTeachers.has(row.userId) && (employment?.firstTeacherPercent ?? null) === null;

    const base = (unitId: string, type: Verksamhetstyp) => {
      const record = blank();
      const unit = unitById.get(unitId);
      if (unit && unit.code === null) notice({ code: 'UNIT_WITHOUT_CODE', params: { unit: unit.name } });
      record.System = SCB_SYSTEM;
      record.Datum = input.exportDate;
      record.Version = SCB_SYSTEM_VERSION;
      record.SkolenhetsKod = unit?.code ?? '';
      record.PersonNamn = scbValue(name, NAME_MAX);
      record.Verksamhetstyp = type;
      record.SkolenhetNamn = scbValue(unit?.name ?? input.schoolName, NAME_MAX);
      record.AnstForm = anstForm;
      return record;
    };
    const push = (record: Record<string, string>) => {
      const missing: ScbMissingField[] = [];
      // Without a post, OMFATTNING says both: there is no post to state a form on.
      if (record.AnstForm === '' && employment) missing.push('ANSTFORM');
      if (record.OmfLarare === '') missing.push('OMFATTNING');
      if (record.Verksamhetstyp === '') missing.push('VERKSAMHETSTYP');
      if (record.SkolenhetsKod === '') missing.push('SKOLENHETSKOD');
      const family = familyOf(record.Verksamhetstyp as Verksamhetstyp);
      if (!onLeave && (family === 'G' || family === 'A') && record.Undervisning !== 'J' && record.Undervisning !== 'N') {
        missing.push('AMNEN');
      }
      if (lacksShare) missing.push('FORSTELARARE_ANDEL');
      records.push({ record, missing });
    };
    /** The post's karriärtjänst shares over the rows, by each row's omfattning. */
    const career = (weights: readonly number[]) => {
      const spread = (percent: number | null | undefined) =>
        percent === null || percent === undefined ? weights.map(() => null) : largestRemainder(weights, percent);
      return { first: spread(employment?.firstTeacherPercent), lecturer: spread(employment?.lecturerPercent) };
    };
    const writeCareer = (record: Record<string, string>, first: number | null | undefined, lecturer: number | null | undefined) => {
      if (first !== null && first !== undefined && first > 0) record.ForsteLarare = String(first);
      if (lecturer !== null && lecturer !== undefined && lecturer > 0) record.Lektor = String(lecturer);
    };

    // Unit by unit (in the units' order), stage by stage within each.
    const stages = [...buckets.values()]
      .filter((bucket) => bucket.minutes > 0)
      .sort((a, b) => unitOrder(a.unit) - unitOrder(b.unit) || STAGE_ORDER.indexOf(a.type) - STAGE_ORDER.indexOf(b.type));

    if (onLeave) {
      // Tjänstledig: the post held, on the row of the most teaching, without
      // subjects ("Tjänstlediga lärare behöver inte rapportera
      // undervisningsämnen").
      const largest = [...stages].sort((a, b) => b.minutes - a.minutes)[0];
      const record = base(largest?.unit ?? unitOf(null), largest?.type ?? '');
      // At least 1 %: SCB "räcker det med att sätta 1 procent" for a leave.
      const held = Math.max(1, Math.round(post!.employmentPercent));
      record.OmfLarare = String(held);
      const shares = career([held]);
      writeCareer(record, shares.first[0], shares.lecturer[0]);
      push(record);
      continue;
    }
    if (stages.length === 0) {
      // A post with no planned teaching (a speciallärare, posts not yet
      // staffed): the row has no verksamhetstyp to take from a group, and
      // SCB wants one on every row and subjects whenever OmfLarare > 0. The
      // row is kept — the tjänst is real — and named.
      if (omf !== null && omf > 0) notice({ code: 'NO_TEACHING', params: { name } });
      const record = base(unitOf(null), '');
      const post = omf === null ? null : Math.max(1, Math.round(omf));
      record.OmfLarare = post === null ? '' : String(post);
      record.Undervisning = 'N';
      const shares = career([post ?? 0]);
      writeCareer(record, shares.first[0], shares.lecturer[0]);
      push(record);
      continue;
    }

    // OmfLarare over the stage rows by their teaching minutes; a row whose
    // share rounds to 0 is merged into the largest row of its own skolenhet,
    // or the largest row when its unit has no other (SCB wants subjects on
    // every row with OmfLarare > 0, and a 0 row is noise). Shared again after
    // each merge, until no row is 0: the rows a merge leaves can round to 0 in
    // their turn. A post above 0 is at least 1 %, as SCB rounds a leave's.
    const whole = omf === null ? null : Math.max(1, Math.round(omf));
    let rows = stages.map((bucket) => ({ ...bucket, byColumn: new Map(bucket.byColumn) }));
    let omfShares: (number | null)[] =
      whole === null ? rows.map(() => null) : largestRemainder(rows.map((bucket) => bucket.minutes), whole);
    while (whole !== null && rows.length > 1 && omfShares.some((share) => share === 0)) {
      const kept = rows.map((_, index) => omfShares[index] !== 0);
      const largestOf = (unit: string | null): number | null =>
        rows.reduce<number | null>(
          (best, bucket, index) =>
            kept[index] && (unit === null || bucket.unit === unit) && (best === null || bucket.minutes > rows[best]!.minutes)
              ? index
              : best,
          null,
        );
      if (!kept.some(Boolean)) {
        kept[rows.reduce((best, bucket, index) => (bucket.minutes > rows[best]!.minutes ? index : best), 0)] = true;
      }
      rows.forEach((bucket, index) => {
        if (kept[index]) return;
        const keep = rows[largestOf(bucket.unit) ?? largestOf(null)!]!;
        keep.minutes += bucket.minutes;
        for (const [column, minutes] of bucket.byColumn) {
          if (scbColumnApplies(column, keep.type)) keep.byColumn.set(column, (keep.byColumn.get(column) ?? 0) + minutes);
        }
      });
      rows = rows.filter((_, index) => kept[index]);
      omfShares = largestRemainder(rows.map((bucket) => bucket.minutes), whole);
    }

    const shares = career(omfShares.map((share) => share ?? 0));
    rows.forEach((bucket, index) => {
      const record = base(bucket.unit, bucket.type);
      const share = omfShares[index];
      record.OmfLarare = share === null || share === undefined ? '' : String(share);
      writeCareer(record, shares.first[index], shares.lecturer[index]);
      if (bucket.type !== '1') {
        const mapped = [...bucket.byColumn.entries()].filter(([, minutes]) => minutes > 0);
        if (mapped.length > 0) {
          record.Undervisning = 'J';
          const percents = largestRemainder(
            mapped.map(([, minutes]) => minutes),
            100,
          );
          mapped.forEach(([column], position) => {
            if (percents[position]! > 0) record[column] = String(percents[position]);
          });
        }
      }
      push(record);
    });
  }

  const rows = records.map(({ record }) => SCB_COLUMNS.map((column) => scbValue(record[column] ?? '')));
  const missing: ScbMissing[] = records.flatMap(({ record, missing: fields }, index) =>
    fields.length === 0
      ? []
      : [
          {
            line: index + 1,
            name: record.PersonNamn ?? '',
            unit: record.SkolenhetNamn ?? '',
            verksamhetstyp: (record.Verksamhetstyp ?? '') as Verksamhetstyp,
            fields,
          },
        ],
  );
  return {
    filename: scbFilename(input.year.name),
    matdatum,
    specVersionDate: SCB_PEDPERS_2026.specVersionDate,
    columns: [...SCB_COLUMNS],
    rows,
    text: rows.map((values) => `${values.join(';')}\r\n`).join(''),
    missing,
    notices,
  };
}
