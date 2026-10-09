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
 *                   class belongs to the year, dated with the year. The other
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
 */

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
  /** The post's MENTORSKAP uppdrag of the year, on classes of the year. */
  mentorships: { studentGroupId: string; updatedAt: Date }[];
}

export function toSs12000Duty(input: DutyInput): Ss12000Duty {
  const { employment, year } = input;
  const modified = [employment.updatedAt, ...input.mentorships.map((m) => m.updatedAt)].reduce((a, b) =>
    b.getTime() > a.getTime() ? b : a,
  );
  const groups = [...new Set(input.mentorships.map((m) => m.studentGroupId))].sort();
  return {
    id: employment.id,
    meta: { created: employment.createdAt.toISOString(), modified: modified.toISOString() },
    person: { id: employment.userId },
    ...(groups.length > 0
      ? {
          assignmentRole: groups.map((id) => ({
            group: { id },
            assignmentRoleType: 'Mentor' as const,
            startDate: year.startDate,
            endDate: year.endDate,
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
