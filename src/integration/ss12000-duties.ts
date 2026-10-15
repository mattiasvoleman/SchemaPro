/*
 * SS12000 Duty, field by field — the one place the /duties feed's shape is
 * decided, against the standard rather than the house.
 *
 * SOURCE. SIS TK450, "SS12000 OpenAPI 3.0", info.version 2.1.0 (korrigendum
 * augusti 2022), components.schemas.Duty and the schemas it refers to:
 * https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml,
 * linked from https://www.sis.se/en/delta-och-paverka/tksidor/tk400499/sistk450/ss-12000/,
 * retrieved 2026-10-09. The SIS page lists no newer YAML; the December 2024
 * edition of the standard adds an informative annex only.
 *
 * Duty's properties in 2.1.0 are exactly: id, meta, person, assignmentRole,
 * dutyAt, dutyRole, description, signature, dutyPercent ("Tjänstgöringsgrad i
 * procent", integer), hoursPerYear (integer), startDate, endDate; required:
 * dutyAt, dutyRole, id, meta, startDate. Meta requires created and modified.
 * An assignmentRole item requires group and assignmentRoleType. Every key
 * this module writes is in DUTY_PROPERTIES (ss12000-duties.contract.spec.ts
 * walks the output recursively), and only those with a value are written.
 *
 * WHAT A DUTY IS HERE. One TeacherEmployment row — a teaching post at this
 * skolenhet for one läsår — is one Duty with dutyRole "Lärare". Its id is the
 * employment's id, so a teacher has a NEW Duty id every läsår (posts roll
 * yearly), and startDate/endDate are the läsår's bounds, not the date of
 * employment the standard means: SchemaPro does not hold the employment
 * date, and the post it does hold is the year's. Förstelärare (a DutyRole
 * value) is an uppdrag inside the post here, not a Duty of its own.
 *
 *   assignmentRole  one "Mentor" item per MENTORSKAP uppdrag of the year whose
 *                   class belongs to the year, dated with the uppdrag's own
 *                   Från and Till, the year's bounds where it has none — a
 *                   mentor until the jullov is no mentor in March, and a
 *                   consumer reading the year would say so. The other
 *                   uppdrag kinds have no AssignmentRoleType value and are left
 *                   out; the standard says teaching is no assignment ("Lärares
 *                   undervisning ska inte uttryckas som en arbetsuppgift").
 *   dutyPercent     Math.round(employmentPercent) — ONLY when the school has
 *   hoursPerYear    turned shareEmploymentWithIntegrations on; hoursPerYear
 *                   only for a ferietjänst, policy.fullTimeAnnualHours ×
 *                   employmentPercent / 100. From the POST, never post −
 *                   nedsättning: with dutyPercent beside it the difference
 *                   would publish the nedsättning, which is HR data and has no
 *                   SS12000 field.
 *   meta.modified   the latest of the post's and its mentorships' updatedAt —
 *                   best effort: a mentorship deleted does not move it.
 *   description     never: no source.
 *
 * Never selected, so never emitted: reductionPercent, the teaching target,
 * the note, the qualifications.
 *
 * A POST THAT CHANGES DURING THE YEAR (20261022120000) is one Duty per
 * stretch of the year in which its grad — the one HR figure a Duty carries —
 * stays the same (toSs12000Duties, dutySegments): "75 % from 11 January" is
 * two Duties, the autumn's and the spring's, each with its own dutyPercent
 * and dates. Only where the school shares employment with integrations:
 * without the opt-in no figure leaves, and the dates alone would tell that
 * the post changed. A period that changes only the nedsättning or the
 * target changes nothing a Duty carries, so it splits nothing — a split
 * there would publish the nedsättning's dates. The first stretch keeps the
 * post's id, so every reference to the post's Duty (an Activity's teachers,
 * a CalendarEvent's exceptions) still finds one; a period's stretch is the
 * period's id; the post's own figures after a period are
 * dutyAfterPeriodId(that period). app.ss12000_split_duty_ids derives the
 * same ids in the database, for the versions and the tombstones.
 */

import { dutyAfterPeriodId } from './ss12000-v2/ids';

export const DUTY_PROPERTIES = [
  'id',
  'meta',
  'person',
  'assignmentRole',
  'dutyAt',
  'dutyRole',
  'description',
  'signature',
  'dutyPercent',
  'hoursPerYear',
  'startDate',
  'endDate',
] as const;
export const META_PROPERTIES = ['created', 'modified'] as const;
/** ObjectReference (PersonReference, OrganisationReference, GroupReference). */
export const REFERENCE_PROPERTIES = ['id', 'displayName'] as const;
export const ASSIGNMENT_ROLE_PROPERTIES = ['group', 'assignmentRoleType', 'startDate', 'endDate'] as const;
/** Code_DutyRole, 2.1.0. */
export const DUTY_ROLES = [
  'Rektor', 'Lärare', 'Förskollärare', 'Barnskötare', 'Bibliotekarie', 'Lärarassistent', 'Fritidspedagog',
  'Annan personal', 'Studie- och yrkesvägledare', 'Förstelärare', 'Kurator', 'Skolsköterska', 'Skolläkare',
  'Skolpsykolog', 'Speciallärare/specialpedagog', 'Skoladministratör', 'Övrig arbetsledning',
  'Övrig pedagogisk personal', 'Förskolechef',
] as const;
/** Code_AssignmentRole, 2.1.0. */
export const ASSIGNMENT_ROLE_TYPES = [
  'Mentor', 'Förskollärare', 'Barnskötare', 'Fritidspedagog', 'Specialpedagog', 'Elevhälsopersonal',
  'Pedagogisk ledare', 'Schemaläggare', 'Lärarassistent', 'Administrativ personal',
] as const;

export interface DutyAssignmentRole {
  group: { id: string };
  assignmentRoleType: (typeof ASSIGNMENT_ROLE_TYPES)[number];
  startDate: string;
  endDate: string;
}

export interface Ss12000Duty {
  id: string;
  meta: { created: string; modified: string };
  person: { id: string };
  assignmentRole?: DutyAssignmentRole[];
  dutyAt: { id: string };
  dutyRole: (typeof DUTY_ROLES)[number];
  signature?: string;
  dutyPercent?: number;
  hoursPerYear?: number;
  startDate: string;
  endDate: string;
}

/** The columns of a post the feed reads — and nothing else (asserted). */
export function dutyEmploymentSelect(share: boolean) {
  return {
    id: true,
    userId: true,
    employmentPercent: true,
    signature: true,
    createdAt: true,
    updatedAt: true,
    ...(share ? { contractKind: true } : {}),
  } as const;
}

export interface DutyInput {
  schoolId: string;
  year: { startDate: string; endDate: string };
  share: boolean;
  fullTimeAnnualHours: number | null;
  employment: {
    id: string;
    userId: string;
    employmentPercent: number;
    signature: string | null;
    createdAt: Date;
    updatedAt: Date;
    contractKind?: 'FERIE' | 'SEMESTER';
  };
  /**
   * The post's MENTORSKAP uppdrag of the year, on classes of the year, with
   * their own Från and Till (yyyy-mm-dd; null or absent: the year's bound).
   */
  mentorships: { studentGroupId: string; updatedAt: Date; validFrom?: string | null; validTo?: string | null }[];
}

export function toSs12000Duty(input: DutyInput): Ss12000Duty {
  const { employment, year } = input;
  const modified = [employment.updatedAt, ...input.mentorships.map((m) => m.updatedAt)].reduce((a, b) =>
    b.getTime() > a.getTime() ? b : a,
  );
  // One item per class and period: two uppdrag on one class with the same
  // dates are one assignment, and two periods are two.
  const roles = new Map<string, { group: string; startDate: string; endDate: string }>();
  for (const mentorship of input.mentorships) {
    const startDate = mentorship.validFrom ?? year.startDate;
    const endDate = mentorship.validTo ?? year.endDate;
    roles.set(`${mentorship.studentGroupId}|${startDate}|${endDate}`, {
      group: mentorship.studentGroupId,
      startDate,
      endDate,
    });
  }
  const assignments = [...roles.values()].sort((a, b) =>
    a.group < b.group ? -1 : a.group > b.group ? 1 : a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0,
  );
  return {
    id: employment.id,
    meta: { created: employment.createdAt.toISOString(), modified: modified.toISOString() },
    person: { id: employment.userId },
    ...(assignments.length > 0
      ? {
          assignmentRole: assignments.map((role) => ({
            group: { id: role.group },
            assignmentRoleType: 'Mentor' as const,
            startDate: role.startDate,
            endDate: role.endDate,
          })),
        }
      : {}),
    dutyAt: { id: input.schoolId },
    dutyRole: 'Lärare',
    ...(employment.signature ? { signature: employment.signature } : {}),
    ...(input.share ? { dutyPercent: Math.round(employment.employmentPercent) } : {}),
    ...(input.share && employment.contractKind === 'FERIE' && input.fullTimeAnnualHours !== null
      ? { hoursPerYear: Math.round((input.fullTimeAnnualHours * employment.employmentPercent) / 100) }
      : {}),
    startDate: year.startDate,
    endDate: year.endDate,
  };
}

/** A period of the post as a Duty reads it: its dates and grad, and its times. */
export interface DutyPeriod {
  id: string;
  /** yyyy-mm-dd. */
  validFrom: string;
  /** yyyy-mm-dd; null: the läsår's last day. */
  validTo: string | null;
  employmentPercent: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One Duty of a post that changes during the year: an id, the dates, the grad. */
export interface DutySegment {
  id: string;
  startDate: string;
  endDate: string;
  employmentPercent: number;
  /** When the stretch first existed: the post's or its period's creation. */
  created: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The year cut where the grad changes: the post's own figures between and
 * around its periods, each period its own, then stretches with the same
 * grad next to each other made one. The dates are the ones the school
 * stated (postStretches' `from` and `to`), clamped to the läsår. One
 * segment, with the post's id and the year's bounds, for a post whose grad
 * never changes. app.ss12000_split_duty_ids walks the periods the same way.
 */
export function dutySegments(
  employment: { id: string; employmentPercent: number; createdAt: Date },
  periods: readonly DutyPeriod[],
  year: { startDate: string; endDate: string },
): DutySegment[] {
  const inYear = periods
    .map((period) => ({
      ...period,
      from: period.validFrom > year.startDate ? period.validFrom : year.startDate,
      to: (period.validTo ?? year.endDate) < year.endDate ? (period.validTo ?? year.endDate) : year.endDate,
    }))
    .filter((period) => period.from <= period.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const segments: DutySegment[] = [];
  const add = (id: string, startDate: string, endDate: string, employmentPercent: number, created: Date) => {
    const last = segments[segments.length - 1];
    if (last && last.employmentPercent === employmentPercent) {
      last.endDate = endDate;
      return;
    }
    // The first stretch is the post's own Duty, whatever it is.
    const first = segments.length === 0;
    segments.push({
      id: first ? employment.id : id,
      startDate,
      endDate,
      employmentPercent,
      created: first ? employment.createdAt : created,
    });
  };
  let cursor = year.startDate;
  let after: DutyPeriod | null = null;
  for (const period of inYear) {
    if (period.from > cursor) {
      add(
        after ? dutyAfterPeriodId(after.id) : employment.id,
        cursor,
        shiftDay(period.from, -1),
        employment.employmentPercent,
        after ? after.createdAt : employment.createdAt,
      );
    }
    add(period.id, period.from, period.to, period.employmentPercent, period.createdAt);
    after = period;
    cursor = shiftDay(period.to, 1);
  }
  if (cursor <= year.endDate) {
    add(
      after ? dutyAfterPeriodId(after.id) : employment.id,
      cursor,
      year.endDate,
      employment.employmentPercent,
      after ? after.createdAt : employment.createdAt,
    );
  }
  return segments;
}

/**
 * A post's Duties: toSs12000Duty's one, or — for a post whose grad changes
 * during the year, in a school that shares employment — one per segment,
 * each with its own id, dates and dutyPercent (hoursPerYear from it), and
 * the mentorships clipped to its dates. meta.modified is the latest of the
 * post's, its periods' and its mentorships': a period moved moves every
 * Duty of the post.
 */
export function toSs12000Duties(input: DutyInput & { periods?: readonly DutyPeriod[] }): Ss12000Duty[] {
  const whole = toSs12000Duty(input);
  const periods = input.periods ?? [];
  if (!input.share || periods.length === 0) return [whole];
  const segments = dutySegments(input.employment, periods, input.year);
  if (segments.length <= 1) return [whole];
  const modified = periods
    .map((period) => period.updatedAt)
    .reduce((a, b) => (b.getTime() > a.getTime() ? b : a), new Date(whole.meta.modified));
  return segments.map((segment) => {
    const duty = toSs12000Duty({
      ...input,
      employment: { ...input.employment, employmentPercent: segment.employmentPercent },
    });
    const roles = (duty.assignmentRole ?? [])
      .map((role) => ({
        ...role,
        startDate: role.startDate > segment.startDate ? role.startDate : segment.startDate,
        endDate: role.endDate < segment.endDate ? role.endDate : segment.endDate,
      }))
      .filter((role) => role.startDate <= role.endDate);
    const out: Ss12000Duty = {
      ...duty,
      id: segment.id,
      meta: { created: segment.created.toISOString(), modified: modified.toISOString() },
      startDate: segment.startDate,
      endDate: segment.endDate,
    };
    delete out.assignmentRole;
    if (roles.length > 0) out.assignmentRole = roles;
    return out;
  });
}
