import { plannedMinutesBetween } from '../common/timplan-delivered';
import type { LoadDuty } from '../staffing/teacher-load';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';
import type { PayrollLine, PayrollPerson, PayrollPersonKind, SchoolPartView } from './analysis.types';
import { byGrade } from './school-part-rules';

/*
 * Löneunderlag: kontering per anställning och skoldel.
 *
 * What a person did in a period, in minutes, split over the skoldelar the work
 * was in, so that payroll can book it on each skoldel's konto. Three kinds of
 * time, each from the rows that already say it:
 *
 *   undervisning   the lessons the calendar HELD with the person as lead or
 *                  assistant: statement E (timplan-delivered.sql.ts), the one
 *                  definition of "held" that the reconciliation and the cover
 *                  hours share, in raw clock minutes. A lesson a vikarie took
 *                  is credited to the vikarie and not to the teacher beside
 *                  them (DISPLACED), so a lesson is paid once;
 *   vikariepass    the held cover lessons of the vikarie export
 *                  (CoverReportsService.hours): its rows, not a second count,
 *                  so the file and the hour export are one figure;
 *   uppdrag        the year's uppdrag as the load report counts them
 *                  (LoadInput.duties: the stored uppdrag and the rastvaktsschema's
 *                  passes), over the period's teaching days, day by day
 *                  (plannedMinutesBetween, P3's helper: a fifth of the weekly
 *                  minutes for each Mon–Fri no school-wide lov closes).
 *
 * A LESSON'S SKOLDEL is its group's: a class by its årskurs, a teaching group by
 * the årskurs of the pupils on it. A group none holds, or a skoldel the school
 * has not made, is the line with no skoldel and no konto.
 *
 * UPPDRAG ARE SHARED, NOT PICKED. An uppdrag belongs to no årskurs (rastvakt,
 * ämnesansvar, a förstelärare's), so a person's uppdrag are shared across the
 * skoldelar they taught or covered in, in proportion to that time, in whole
 * minutes by the largest remainder so that the lines add up to the person's
 * total. A person with no teaching or cover in the period has their uppdrag
 * on a line of their own with no skoldel: the school books it by hand, and the
 * file says so (ANALYSIS_DUTIES_UNALLOCATED). (BESLUT.)
 *
 * A person appears when they have any time. The tjänstgöringsgrad, the
 * signature and whether the school has marked the person as having a protected
 * identity are the caller's to say (employmentPercentOf, signatureOf,
 * protectedOf), and names are the file's to add: this module knows ids and
 * minutes.
 *
 * PURE.
 */

export interface PayrollInput {
  from: string;
  to: string;
  year: YearBounds;
  /** Held lessons with the person as lead or assistant, per group, raw clock minutes. */
  teaching: readonly { userId: string; studentGroupId: string; minutes: number }[];
  /** The vikarie export's held covers, per lesson (a row per lesson is fine). */
  substitutes: readonly { userId: string; studentGroupId: string; minutes: number }[];
  duties: readonly LoadDuty[];
  /** The year's lov; only the ones that close the whole school count for an uppdrag. */
  closures: readonly ClosedRange[];
  parts: readonly SchoolPartView[];
  /** The skoldel a group falls in, or null. */
  partOfGroup(groupId: string): SchoolPartView | null;
  kindOf(userId: string): PayrollPersonKind;
  /** Null when the reader may not state it, or the person has no post. */
  employmentPercentOf(userId: string): number | null;
  /** The post's lärarsignatur, or null. */
  signatureOf(userId: string): string | null;
  /** The school has marked the person as having a protected identity. */
  protectedOf(userId: string): boolean;
}

export interface PayrollResult {
  people: PayrollPerson[];
  lines: PayrollLine[];
  /** People whose uppdrag are on the line with no skoldel because they had nothing to follow. */
  dutiesUnallocated: number;
}

/** `total` whole minutes shared by weights, largest remainder first, ties to the earlier. Σ result = total. */
export function shareOut(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index]! += 1;
    left -= 1;
  }
  return floors;
}

interface PartTime {
  teaching: number;
  substitute: number;
}

export function buildPayroll(input: PayrollInput): PayrollResult {
  const schoolWide = input.closures.filter((closure) => (closure.minGradeLevel ?? null) === null && (closure.maxGradeLevel ?? null) === null);
  const partKey = (groupId: string): string | null => input.partOfGroup(groupId)?.id ?? null;

  const perPerson = new Map<string, Map<string | null, PartTime>>();
  const slot = (userId: string, key: string | null): PartTime => {
    let parts = perPerson.get(userId);
    if (!parts) perPerson.set(userId, (parts = new Map()));
    let time = parts.get(key);
    if (!time) parts.set(key, (time = { teaching: 0, substitute: 0 }));
    return time;
  };
  for (const row of input.teaching) slot(row.userId, partKey(row.studentGroupId)).teaching += row.minutes;
  for (const row of input.substitutes) slot(row.userId, partKey(row.studentGroupId)).substitute += row.minutes;

  const dutyOf = new Map<string, number>();
  for (const duty of input.duties) {
    const minutes = plannedMinutesBetween(
      {
        id: '',
        studentGroupId: '',
        subjectId: '',
        lessonsPerWeek: 1,
        minutesPerLesson: duty.minutesPerWeek,
        recurrence: null,
        startDate: duty.validFrom ?? null,
        endDate: duty.validTo ?? null,
      },
      input.from,
      input.to,
      input.year,
      [...schoolWide],
      null,
    );
    if (minutes > 0) dutyOf.set(duty.userId, (dutyOf.get(duty.userId) ?? 0) + minutes);
  }

  const rank = new Map<string | null, number>([...input.parts].sort(byGrade).map((part, index) => [part.id, index]));
  rank.set(null, input.parts.length);
  const accountOf = new Map(input.parts.map((part) => [part.id, part.account]));

  const everyone = new Set([...perPerson.keys(), ...[...dutyOf].filter(([, minutes]) => Math.round(minutes) > 0).map(([userId]) => userId)]);
  const people: PayrollPerson[] = [];
  const lines: PayrollLine[] = [];
  let unallocated = 0;

  for (const userId of [...everyone].sort()) {
    const parts = perPerson.get(userId) ?? new Map<string | null, PartTime>();
    const keys = [...parts.keys()].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const duty = Math.round(dutyOf.get(userId) ?? 0);
    const weights = keys.map((key) => (parts.get(key)!.teaching + parts.get(key)!.substitute));
    let shares: number[];
    let dutyKeys = keys;
    if (duty > 0 && weights.every((weight) => weight <= 0)) {
      // Nothing to follow: the uppdrag stand alone, with no skoldel.
      dutyKeys = keys.includes(null) ? keys : [...keys, null];
      shares = dutyKeys.map((key) => (key === null ? duty : 0));
      unallocated += 1;
    } else {
      shares = shareOut(duty, weights);
    }
    let teaching = 0;
    let substitute = 0;
    dutyKeys.forEach((key, index) => {
      const time = parts.get(key) ?? { teaching: 0, substitute: 0 };
      const dutyMinutes = shares[index] ?? 0;
      if (time.teaching === 0 && time.substitute === 0 && dutyMinutes === 0) return;
      teaching += time.teaching;
      substitute += time.substitute;
      lines.push({
        userId,
        kind: input.kindOf(userId),
        schoolPartId: key,
        account: key === null ? null : (accountOf.get(key) ?? null),
        teachingMinutes: time.teaching,
        dutyMinutes,
        substituteMinutes: time.substitute,
      });
    });
    if (teaching === 0 && substitute === 0 && duty === 0) continue;
    people.push({
      userId,
      kind: input.kindOf(userId),
      teachingMinutes: teaching,
      dutyMinutes: duty,
      substituteMinutes: substitute,
      employmentPercent: input.employmentPercentOf(userId),
      signature: input.signatureOf(userId),
      protectedIdentity: input.protectedOf(userId),
    });
  }
  return { people, lines, dutiesUnallocated: unallocated };
}
