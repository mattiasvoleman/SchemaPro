import { toSs12000Duty, type Ss12000Duty } from '../ss12000-duties';
import { inTurn } from './in-turn';
import {
  dayBefore,
  dayOf,
  TEACHING_DUTY_ROLES,
  type ActivityRow,
  type Day,
  type EmploymentRow,
  type GroupRow,
  type LessonRow,
  type SchoolSlice,
  type UserRow,
  type Version,
} from './slice';
import type { Scope } from './scopes';

/**
 * The objects the v2.0 provider emits, built from a SchoolSlice, field by
 * field as docs/integration-api.md's "SS12000 2.1 (v2.0)" tables say. Every
 * key written is an S1 property (ss12000-v2.contract.spec.ts walks the
 * output against s1-provider.generated.ts); an optional property is written
 * only when SchemaPro holds a value for it.
 *
 * NEVER EMITTED: civicNo, birthDate, sex, securityMarking, personStatus,
 * addresses, phoneNumbers, photo, externalIdentifiers, middleName;
 * eduPersonPrincipalNames (A1.9: S1 defines it as "spårbar, persistent och
 * globalt unik", and an email that can change and be reused is none of
 * those — v1 keeps sending the email there, unchanged); relationType (A1.10:
 * SchemaPro does not store it, and the field is optional); an absence, its
 * reason, a lesson's note or cancelCause; minutesPlanned (no per-activity
 * total over the period is computed); teachingLength*, comment,
 * parentActivity, resources; HR figures beyond the Fas 3 opt-in.
 */

export interface Reach {
  scopes: ReadonlySet<Scope>;
  /** expandReferenceNames=true. */
  names: boolean;
}

export interface Ref {
  id: string;
  displayName?: string;
}

export interface Meta {
  created: string;
  modified: string;
}

export function metaOf(version: Version | undefined, createdAt: Date | null | undefined, updatedAt: Date | null | undefined): Meta {
  const created = createdAt ?? version?.createdAt ?? new Date(0);
  const modified = version?.modifiedAt ?? updatedAt ?? created;
  return { created: created.toISOString(), modified: (modified < created ? created : modified).toISOString() };
}

/** S1 Email.type by role. */
export const EMAIL_TYPE: Record<UserRow['role'], 'Skola elev' | 'Skola personal' | 'Privat'> = {
  STUDENT: 'Skola elev',
  TEACHER: 'Skola personal',
  SCHOOL_ADMIN: 'Skola personal',
  GUARDIAN: 'Privat',
};

export const personName = (user: Pick<UserRow, 'firstName' | 'lastName'>) => `${user.firstName} ${user.lastName}`;

/**
 * The id namespace (S1 L5061, ids.ts): a linked person or group under the
 * source's id; the Organisation under the source's skolenhet id when exactly
 * one is chosen (else the school's own id, as a "Skola"); a teacher's Duty
 * under A5.5's choice.
 */
export class IdSpace {
  readonly organisationId: string;
  readonly organisationType: 'Skolenhet' | 'Skola';
  readonly schoolUnitCode: string | null;
  private readonly personOut = new Map<string, string>();
  private readonly personIn = new Map<string, string>();
  private readonly groupOut = new Map<string, string>();
  private readonly groupIn = new Map<string, string>();
  private readonly dutyOut = new Map<string, string>();
  private readonly dutyIn = new Map<string, { userId: string; yearId: string }>();

  constructor(input: {
    schoolId: string;
    organisationIds: string[];
    schoolUnitCodes: string[];
    users: UserRow[];
    groups: GroupRow[];
    employments: EmploymentRow[];
    links: { userId: string; academicYearId: string; ss12000DutyId: string; dutyRole: string; startDate: Date; id: string }[];
  }) {
    const single = input.organisationIds.length === 1 ? input.organisationIds[0]! : null;
    this.organisationId = single ?? input.schoolId;
    this.organisationType = input.organisationIds.length > 1 ? 'Skola' : 'Skolenhet';
    this.schoolUnitCode = single && input.schoolUnitCodes.length === 1 ? input.schoolUnitCodes[0]! : null;
    for (const user of input.users) {
      const emitted = (user.ss12000Id ?? user.id).toLowerCase();
      this.personOut.set(user.id, emitted);
      this.personIn.set(emitted, user.id);
    }
    for (const group of input.groups) {
      const emitted = (group.ss12000Id ?? group.id).toLowerCase();
      this.groupOut.set(group.id, emitted);
      this.groupIn.set(emitted, group.id);
    }
    // A5.5: the earliest active teaching-role link of the year, then the
    // lowest id; else the year's post (app.ss12000_duty_id is the same rule).
    const links = [...input.links]
      .filter((link) => TEACHING_DUTY_ROLES.has(link.dutyRole))
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const link of links) {
      const key = `${link.userId}:${link.academicYearId}`;
      if (!this.dutyOut.has(key)) this.dutyOut.set(key, link.ss12000DutyId.toLowerCase());
    }
    for (const post of input.employments) {
      const key = `${post.userId}:${post.academicYearId}`;
      if (!this.dutyOut.has(key)) this.dutyOut.set(key, post.id);
    }
    for (const [key, id] of this.dutyOut) {
      const [userId, yearId] = key.split(':') as [string, string];
      this.dutyIn.set(id, { userId, yearId });
    }
  }

  person(userId: string): string | null {
    return this.personOut.get(userId) ?? null;
  }
  personFrom(emitted: string): string | null {
    return this.personIn.get(emitted) ?? null;
  }
  group(groupId: string): string | null {
    return this.groupOut.get(groupId) ?? null;
  }
  groupFrom(emitted: string): string | null {
    return this.groupIn.get(emitted) ?? null;
  }
  duty(userId: string, yearId: string): string | null {
    return this.dutyOut.get(`${userId}:${yearId}`) ?? null;
  }
  dutyFrom(emitted: string): { userId: string; yearId: string } | null {
    return this.dutyIn.get(emitted) ?? null;
  }
}

// ---------------------------------------------------------------------------
// The school's people, groups and memberships, assembled once per request.
// ---------------------------------------------------------------------------

export interface Membership {
  userId: string;
  groupId: string;
  startDate?: Day;
  endDate?: Day;
}

export interface Enrolment {
  enroledAt: Ref;
  schoolYear?: number;
  schoolType: string;
  startDate: Day;
}

export interface Relation {
  type: 'enrolment' | 'duty' | 'responsibleFor.enrolment' | 'groupMembership';
  organisationId: string;
  startDate?: Day;
  endDate?: Day;
}

export class Model {
  readonly usersById: Map<string, UserRow>;
  readonly groupsById: Map<string, GroupRow>;
  readonly yearsById: Map<string, { id: string; startDate: Date; endDate: Date; isActive: boolean }>;

  private constructor(
    readonly slice: SchoolSlice,
    readonly reach: Reach,
    readonly ids: IdSpace,
    readonly school: { id: string; name: string; createdAt: Date; updatedAt: Date; timezone: string },
    readonly users: UserRow[],
    readonly groups: GroupRow[],
    years: { id: string; startDate: Date; endDate: Date; isActive: boolean }[],
    readonly activeYearId: string | null,
    readonly types: Awaited<ReturnType<SchoolSlice['schoolTypes']>>,
  ) {
    this.usersById = new Map(users.map((user) => [user.id, user]));
    this.groupsById = new Map(groups.map((group) => [group.id, group]));
    this.yearsById = new Map(years.map((year) => [year.id, year]));
  }

  static async load(slice: SchoolSlice, reach: Reach): Promise<Model> {
    const [school, identity, users, groups, years, employments, links, types] = await inTurn(
      () => slice.school(),
      () => slice.identity(),
      () => slice.users(),
      () => slice.groups(),
      () => slice.years(),
      () => slice.employments(),
      () => slice.dutyLinks(),
      () => slice.schoolTypes(),
    );
    // Guardians are emitted, referenced and named only for a key with
    // responsibles.read; to every other key they do not exist.
    const visible = reach.scopes.has('responsibles.read') ? users : users.filter((user) => user.role !== 'GUARDIAN');
    const ids = new IdSpace({
      schoolId: slice.schoolId,
      organisationIds: identity.organisationIds,
      schoolUnitCodes: identity.schoolUnitCodes,
      users: visible,
      groups,
      employments: employments.filter((post) => visible.some((user) => user.id === post.userId)),
      links,
    });
    const active = years.find((year) => year.isActive) ?? null;
    return new Model(slice, reach, ids, school, visible, groups, years, active?.id ?? null, types);
  }

  can(scope: Scope): boolean {
    return this.reach.scopes.has(scope);
  }

  // --- references ---------------------------------------------------------

  organisationRef(): Ref {
    return this.reach.names && this.can('organisations.read')
      ? { id: this.ids.organisationId, displayName: this.school.name }
      : { id: this.ids.organisationId };
  }

  personRef(userId: string): Ref | null {
    const id = this.ids.person(userId);
    const user = this.usersById.get(userId);
    if (!id || !user) return null;
    return this.reach.names && this.can('persons.read') ? { id, displayName: personName(user) } : { id };
  }

  groupRef(groupId: string): Ref | null {
    const id = this.ids.group(groupId);
    const group = this.groupsById.get(groupId);
    if (!id || !group) return null;
    return this.reach.names && this.can('groups.read') ? { id, displayName: group.name } : { id };
  }

  dutyRef(userId: string, yearId: string): Ref | null {
    const id = this.ids.duty(userId, yearId);
    const user = this.usersById.get(userId);
    if (!id || !user) return null;
    return this.reach.names && this.can('duties.read') && this.can('persons.read') ? { id, displayName: personName(user) } : { id };
  }

  yearBounds(yearId: string): { startDate: Day; endDate: Day } | null {
    const year = this.yearsById.get(yearId);
    return year ? { startDate: dayOf(year.startDate), endDate: dayOf(year.endDate) } : null;
  }

  // --- memberships and enrolments ------------------------------------------

  private membershipsMemo: Promise<Membership[]> | undefined;

  /**
   * Every membership of an emitted person in an emitted group: a class's
   * StudentEnrollments segments ([validFrom, validTo) as S1's inclusive
   * startDate/endDate, an open segment without endDate) and a teaching
   * group's StudentGroupMembers rows (no dates are held).
   */
  memberships(): Promise<Membership[]> {
    return (this.membershipsMemo ??= (async () => {
      const [segments, teaching] = await inTurn(() => this.slice.enrollments(), () => this.slice.teachingMembers());
      const out: Membership[] = [];
      for (const segment of segments) {
        if (!segment.studentGroupId || !this.groupsById.has(segment.studentGroupId) || !this.usersById.has(segment.studentId)) continue;
        out.push({
          userId: segment.studentId,
          groupId: segment.studentGroupId,
          startDate: dayOf(segment.validFrom),
          ...(segment.validTo ? { endDate: dayBefore(dayOf(segment.validTo)) } : {}),
        });
      }
      for (const row of teaching) {
        const group = this.groupsById.get(row.studentGroupId);
        if (!group || group.kind !== 'TEACHING_GROUP' || !this.usersById.has(row.studentId)) continue;
        out.push({ userId: row.studentId, groupId: row.studentGroupId });
      }
      return out;
    })());
  }

  private enrolmentsMemo: Promise<Map<string, Enrolment>> | undefined;

  /**
   * A pupil's Enrolment: from the OPEN class segment. startDate is
   * "Startdatum för inskrivningen" (S1), not the class's: the validFrom of
   * the first segment of the pupil's unbroken chain (validTo of one equal to
   * validFrom of the next), so a class move is not a new enrolment (A1.8).
   * schoolYear only within S1's 0..10; schoolType (required) from the year's
   * timplan for the grade — none derivable, no Enrolment. No endDate while
   * the pupil is active.
   */
  enrolments(): Promise<Map<string, Enrolment>> {
    return (this.enrolmentsMemo ??= (async () => {
      const segments = await this.slice.enrollments();
      const byPupil = new Map<string, typeof segments>();
      for (const segment of segments) byPupil.set(segment.studentId, [...(byPupil.get(segment.studentId) ?? []), segment]);
      const out = new Map<string, Enrolment>();
      for (const [pupilId, own] of byPupil) {
        const user = this.usersById.get(pupilId);
        if (!user || user.role !== 'STUDENT') continue;
        const sorted = [...own].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
        const openAt = sorted.findIndex((segment) => segment.validTo === null);
        if (openAt < 0) continue;
        const open = sorted[openAt]!;
        let first = openAt;
        while (first > 0 && sorted[first - 1]!.validTo && dayOf(sorted[first - 1]!.validTo!) === dayOf(sorted[first]!.validFrom)) first--;
        const schoolType = this.types.of(open.academicYearId, open.gradeLevel);
        if (!schoolType) continue;
        out.set(pupilId, {
          enroledAt: this.organisationRef(),
          ...(open.gradeLevel !== null && open.gradeLevel >= 0 && open.gradeLevel <= 10 ? { schoolYear: open.gradeLevel } : {}),
          schoolType,
          startDate: dayOf(sorted[first]!.validFrom),
        });
      }
      return out;
    })());
  }

  // --- duties ---------------------------------------------------------------

  private dutiesMemo: Promise<Array<{ duty: Ss12000Duty; post: EmploymentRow }>> | undefined;

  /**
   * The active year's posts of emitted teachers as S1 Duties: toSs12000Duty
   * exactly as v1's /duties builds them — the same select, the same
   * shareEmploymentWithIntegrations opt-in for dutyPercent and hoursPerYear,
   * the same exclusions — then translateIds: the Duty's own id (A5.5), the
   * person, dutyAt and the mentorship groups into the namespace, and meta
   * from the versions table.
   */
  duties(): Promise<Array<{ duty: Ss12000Duty; post: EmploymentRow }>> {
    return (this.dutiesMemo ??= (async () => {
      const yearId = this.activeYearId;
      if (!yearId) return [];
      const bounds = this.yearBounds(yearId)!;
      const [posts, mentorships, policy, versions] = await inTurn(
        () => this.slice.employments(),
        () => this.slice.mentorships(),
        () => this.slice.policy(),
        () => this.slice.versions('Duty'),
      );
      const out: Array<{ duty: Ss12000Duty; post: EmploymentRow }> = [];
      for (const post of posts) {
        if (post.academicYearId !== yearId || !this.usersById.has(post.userId)) continue;
        const own = mentorships.filter(
          (duty) =>
            duty.userId === post.userId &&
            duty.academicYearId === yearId &&
            duty.studentGroupId !== null &&
            this.groupsById.get(duty.studentGroupId)?.academicYearId === yearId,
        );
        const raw = toSs12000Duty({
          schoolId: this.slice.schoolId,
          year: bounds,
          share: policy.share,
          fullTimeAnnualHours: policy.fullTimeAnnualHours,
          employment: post,
          mentorships: own.map((duty) => ({ studentGroupId: duty.studentGroupId!, updatedAt: duty.updatedAt })),
        });
        out.push({ duty: this.translateDuty(raw, post, versions.get(post.id)), post });
      }
      return out;
    })());
  }

  /** A5.5's pass over toSs12000Duty's output: ids into the namespace, meta from versions. */
  translateDuty(raw: Ss12000Duty, post: EmploymentRow, version: Version | undefined): Ss12000Duty {
    const person = this.personRef(raw.person.id);
    const assignmentRole = raw.assignmentRole
      ?.map((role) => {
        const group = this.groupRef(role.group.id);
        return group ? { ...role, group } : null;
      })
      .filter((role): role is NonNullable<typeof role> => role !== null);
    const out: Ss12000Duty = {
      ...raw,
      id: this.ids.duty(post.userId, post.academicYearId) ?? raw.id,
      meta: version ? metaOf(version, post.createdAt, post.updatedAt) : raw.meta,
      person: person ?? { id: raw.person.id },
      dutyAt: this.organisationRef(),
    };
    delete out.assignmentRole;
    if (assignmentRole && assignmentRole.length > 0) out.assignmentRole = assignmentRole;
    return out;
  }

  // --- relations (persons' relationship.* filters) ---------------------------

  async relations(): Promise<Map<string, Relation[]>> {
    const [enrolments, memberships, duties, links] = await inTurn(
      () => this.enrolments(),
      () => this.memberships(),
      () => this.duties(),
      () => this.slice.guardianLinks(),
    );
    const org = this.ids.organisationId;
    const out = new Map<string, Relation[]>();
    const add = (userId: string, relation: Relation) => out.set(userId, [...(out.get(userId) ?? []), relation]);
    for (const [userId, enrolment] of enrolments) add(userId, { type: 'enrolment', organisationId: org, startDate: enrolment.startDate });
    for (const { duty, post } of duties) add(post.userId, { type: 'duty', organisationId: org, startDate: duty.startDate, endDate: duty.endDate });
    if (this.can('responsibles.read')) {
      for (const link of links) {
        const child = enrolments.get(link.studentId);
        if (!child || !this.usersById.has(link.guardianId)) continue;
        add(link.guardianId, { type: 'responsibleFor.enrolment', organisationId: org, startDate: child.startDate });
      }
    }
    for (const membership of memberships) {
      add(membership.userId, {
        type: 'groupMembership',
        organisationId: org,
        ...(membership.startDate ? { startDate: membership.startDate } : {}),
        ...(membership.endDate ? { endDate: membership.endDate } : {}),
      });
    }
    return out;
  }

  // --- activities and events ---------------------------------------------------

  activityTeachers(row: ActivityRow): Ref[] {
    if (!this.activeYearId) return [];
    return row.teacherIds.map((userId) => this.dutyRef(userId, this.activeYearId!)).filter((ref): ref is Ref => ref !== null);
  }

  lessonYear(lesson: LessonRow): string | null {
    return this.groupsById.get(lesson.studentGroupId)?.academicYearId ?? null;
  }
}

/** The groups a person belongs to now: the home class and the teaching groups. */
export function groupsOfPerson(user: UserRow, teaching: { studentGroupId: string; studentId: string }[]): Set<string> {
  const out = new Set<string>();
  if (user.studentGroupId) out.add(user.studentGroupId);
  for (const row of teaching) if (row.studentId === user.id) out.add(row.studentGroupId);
  return out;
}
