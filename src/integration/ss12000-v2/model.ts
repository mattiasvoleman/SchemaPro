import { type GradeNumbering } from '../../common/grade-numbering';
import { compareUnits, unitForGrade } from '../../school-units/school-unit-map';
import { toSs12000Duties, type Ss12000Duty } from '../ss12000-duties';
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
  type UnitRow,
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

/** An emitted Organisation: a unit, or the school itself when it has none. */
export interface EmittedOrganisation {
  id: string;
  /** Skolenhet for a unit; for a school without units, as before them. */
  organisationType: 'Skolenhet' | 'Skola';
  /** The skolenhet; null when the school has none and is emitted itself. */
  unit: UnitRow | null;
  schoolUnitCode: string | null;
}

/**
 * The id namespace (S1 L5061, ids.ts): a linked person or group under the
 * source's id; a teacher's Duty under A5.5's choice; and the Organisations:
 *
 *   * one per skolenhet (migration 20261031090000), under the source's id
 *     once the unit is linked, else the unit's own, in compareUnits order;
 *   * with no unit, the school itself exactly as before: under the source's
 *     skolenhet id when exactly one is chosen (a Skolenhet), else the
 *     school's own id, a Skolenhet with none chosen and a "Skola" with
 *     several. That type changes with the code and not with the data, so it
 *     would move no meta.modified; the sync turns the chosen skolenheter
 *     into units, whose arrival the triggers track.
 *
 * app.ss12000_organisation_ids(school) is the same set; the triggers bury
 * and move by it. What belongs where is src/school-units/school-unit-map.ts:
 * a class by its årskurs, what has none by the first unit.
 */
export class IdSpace {
  /** Every emitted Organisation; the first is what has no årskurs. Never empty. */
  readonly organisations: EmittedOrganisation[];
  private readonly units: UnitRow[];
  private readonly unitIds = new Map<string, string>();
  private readonly personOut = new Map<string, string>();
  private readonly personIn = new Map<string, string>();
  private readonly groupOut = new Map<string, string>();
  private readonly groupIn = new Map<string, string>();
  private readonly dutyOut = new Map<string, string>();
  private readonly dutyIn = new Map<string, { userId: string; yearId: string }>();
  private readonly stretchIn = new Map<string, { userId: string; yearId: string }>();
  /** The source's own Duty behind an emitted id that is the source's (A5.5). */
  private readonly dutyLinkOut = new Map<string, { dutyRole: string; startDate: Date; endDate: Date | null }>();

  constructor(input: {
    schoolId: string;
    organisationIds: string[];
    schoolUnitCodes: string[];
    units: UnitRow[];
    users: UserRow[];
    groups: GroupRow[];
    employments: EmploymentRow[];
    links: { userId: string; academicYearId: string; ss12000DutyId: string; dutyRole: string; startDate: Date; endDate?: Date | null; id: string }[];
  }) {
    this.units = [...input.units].sort(compareUnits);
    if (this.units.length > 0) {
      this.organisations = this.units.map((unit) => {
        const id = (unit.ss12000Id ?? unit.id).toLowerCase();
        this.unitIds.set(unit.id, id);
        return { id, organisationType: 'Skolenhet' as const, unit, schoolUnitCode: unit.code };
      });
    } else {
      const single = input.organisationIds.length === 1 ? input.organisationIds[0]! : null;
      this.organisations = [
        {
          id: single ?? input.schoolId,
          organisationType: input.organisationIds.length > 1 ? 'Skola' : 'Skolenhet',
          unit: null,
          schoolUnitCode: single && input.schoolUnitCodes.length === 1 ? input.schoolUnitCodes[0]! : null,
        },
      ];
    }
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
      if (this.dutyOut.has(key)) continue;
      this.dutyOut.set(key, link.ss12000DutyId.toLowerCase());
      this.dutyLinkOut.set(key, { dutyRole: link.dutyRole, startDate: link.startDate, endDate: link.endDate ?? null });
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

  /** The first Organisation: a room's owner, and what no årskurs places. */
  get primaryOrganisation(): string {
    return this.organisations[0]!.id;
  }
  /**
   * The Organisation of a class, a pupil's class or a mentor's class, by its
   * årskurs in its läsår's numbering (a TIOARIG läsår reads a unit's span as
   * SFS 2025:729 övergångsbestämmelse 5 does, unitSpanIn).
   */
  organisationOf(grade: number | null, numbering: GradeNumbering = 'NIOARIG'): string {
    const unit = unitForGrade(this.units, grade, numbering);
    return unit ? this.unitIds.get(unit.id)! : this.primaryOrganisation;
  }
  /** The Organisation emitted under `id`, if one is. */
  organisation(id: string): EmittedOrganisation | null {
    return this.organisations.find((organisation) => organisation.id === id) ?? null;
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
  /**
   * A Duty of a changing post beyond its first (ss12000-duties.ts
   * dutySegments), once duties() has emitted it: the läslogg finds its
   * teacher as the post's (dutyRead). No filter does: activities and events
   * name the post's own Duty, so a stretch's id matches nothing there, and
   * resolving it would tell a key without duties.read where a stretch
   * starts (its id is the post's and its first day).
   */
  addDutySegment(emitted: string, userId: string, yearId: string): void {
    this.stretchIn.set(emitted.toLowerCase(), { userId, yearId });
  }
  /** The teacher of an emitted Duty id that activities and events name: the post's, or the source's. */
  dutyFrom(emitted: string): { userId: string; yearId: string } | null {
    return this.dutyIn.get(emitted) ?? null;
  }
  /** The teacher of any Duty the provider emitted, a stretch too: for the läslogg. */
  dutyRead(emitted: string): { userId: string; yearId: string } | null {
    return this.dutyIn.get(emitted) ?? this.stretchIn.get(emitted) ?? null;
  }
  /** The source's role and dates when the emitted Duty id is the source's; null for SchemaPro's own post id. */
  dutyLink(userId: string, yearId: string): { dutyRole: string; startDate: Date; endDate: Date | null } | null {
    return this.dutyLinkOut.get(`${userId}:${yearId}`) ?? null;
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
  readonly yearsById: Map<string, { id: string; startDate: Date; endDate: Date; isActive: boolean; gradeNumbering?: GradeNumbering }>;

  private constructor(
    readonly slice: SchoolSlice,
    readonly reach: Reach,
    readonly ids: IdSpace,
    readonly school: { id: string; name: string; createdAt: Date; updatedAt: Date; timezone: string },
    readonly users: UserRow[],
    readonly groups: GroupRow[],
    years: { id: string; startDate: Date; endDate: Date; isActive: boolean; gradeNumbering?: GradeNumbering }[],
    readonly activeYearId: string | null,
    readonly types: Awaited<ReturnType<SchoolSlice['schoolTypes']>>,
  ) {
    this.usersById = new Map(users.map((user) => [user.id, user]));
    this.groupsById = new Map(groups.map((group) => [group.id, group]));
    this.yearsById = new Map(years.map((year) => [year.id, year]));
  }

  static async load(slice: SchoolSlice, reach: Reach): Promise<Model> {
    const [school, identity, units, users, groups, years, employments, links, types] = await inTurn(
      () => slice.school(),
      () => slice.identity(),
      () => slice.units(),
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
      units,
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

  /** A reference to an emitted Organisation (the first when none is named). */
  organisationRef(id: string = this.ids.primaryOrganisation): Ref {
    if (!(this.reach.names && this.can('organisations.read'))) return { id };
    return { id, displayName: this.ids.organisation(id)?.unit?.name ?? this.school.name };
  }

  /** The Organisation a group belongs to: its skolenhet by its årskurs, in its own läsår's numbering. */
  groupOrganisation(groupId: string): string {
    const group = this.groupsById.get(groupId);
    return this.ids.organisationOf(group?.gradeLevel ?? null, this.numberingOf(group?.academicYearId));
  }

  /** A läsår's numbering; NIOARIG for one the slice does not hold. */
  numberingOf(academicYearId: string | null | undefined): GradeNumbering {
    return (academicYearId ? this.yearsById.get(academicYearId)?.gradeNumbering : undefined) ?? 'NIOARIG';
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
   * Moving up a year is not one either: the summer between two consecutive
   * läsår — the rollover closes the old class at the old year's end and
   * opens the new one at the new year's start — does not break the chain.
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
        while (first > 0 && this.continues(sorted[first - 1]!, sorted[first]!)) first--;
        const schoolType = this.types.of(open.academicYearId, open.gradeLevel);
        if (!schoolType) continue;
        out.set(pupilId, {
          // The skolenhet holding the pupil's årskurs now.
          enroledAt: this.organisationRef(this.ids.organisationOf(open.gradeLevel, this.numberingOf(open.academicYearId))),
          ...(open.gradeLevel !== null && open.gradeLevel >= 0 && open.gradeLevel <= 11 ? { schoolYear: open.gradeLevel } : {}),
          schoolType,
          startDate: dayOf(sorted[first]!.validFrom),
        });
      }
      return out;
    })());
  }

  /**
   * Whether `next` continues `prev`'s enrolment: back to back, or across the
   * gap between two consecutive läsår (prev ends at or after its year's end,
   * next starts at or before the following year's start, no year between).
   */
  private continues(
    prev: { validTo: Date | null; academicYearId: string },
    next: { validFrom: Date; academicYearId: string },
  ): boolean {
    if (!prev.validTo) return false;
    const end = dayOf(prev.validTo);
    const start = dayOf(next.validFrom);
    if (end === start) return true;
    if (prev.academicYearId === next.academicYearId || end > start) return false;
    const before = this.yearBounds(prev.academicYearId);
    const after = this.yearBounds(next.academicYearId);
    if (!before || !after || before.endDate >= after.startDate) return false;
    const between = [...this.yearsById.values()].some((year) => {
      const day = dayOf(year.startDate);
      return day > before.endDate && day < after.startDate;
    });
    return !between && end >= before.endDate && start <= after.startDate;
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
      const [posts, mentorships, policy, versions, periods] = await inTurn(
        () => this.slice.employments(),
        () => this.slice.mentorships(),
        () => this.slice.policy(),
        () => this.slice.versions('Duty'),
        () => this.slice.employmentPeriods(),
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
        // A teacher under the source's Duty id is that one Duty, with the
        // source's dates and no figure of SchemaPro's: nothing to cut.
        const ownId = this.ids.duty(post.userId, post.academicYearId) === post.id;
        const raws = toSs12000Duties({
          schoolId: this.slice.schoolId,
          year: bounds,
          share: policy.share,
          fullTimeAnnualHours: policy.fullTimeAnnualHours,
          employment: post,
          mentorships: own.map((duty) => ({
            studentGroupId: duty.studentGroupId!,
            updatedAt: duty.updatedAt,
            validFrom: duty.validFrom ? dayOf(duty.validFrom) : null,
            validTo: duty.validTo ? dayOf(duty.validTo) : null,
          })),
          periods: ownId ? (periods.get(post.id) ?? []) : [],
        });
        // dutyAt: the skolenhet of the teacher's mentor classes when they are
        // one unit's, else the first unit (S1 Duty.dutyAt is required, and
        // a teacher teaching across units has one post here). Every Duty of
        // a post cut where its grad changes is at the same unit.
        const mentorUnits = new Set(own.map((duty) => this.groupOrganisation(duty.studentGroupId!)));
        const dutyAt = mentorUnits.size === 1 ? [...mentorUnits][0]! : this.ids.primaryOrganisation;
        for (const raw of raws) {
          if (raw.id !== post.id) this.ids.addDutySegment(raw.id, post.userId, post.academicYearId);
          out.push({ duty: this.translateDuty(raw, post, versions.get(raw.id), dutyAt), post });
        }
      }
      return out;
    })());
  }

  /** A5.5's pass over toSs12000Duty's output: ids into the namespace, meta from versions. */
  translateDuty(raw: Ss12000Duty, post: EmploymentRow, version: Version | undefined, dutyAt: string = this.ids.primaryOrganisation): Ss12000Duty {
    const person = this.personRef(raw.person.id);
    const assignmentRole = raw.assignmentRole
      ?.map((role) => {
        const group = this.groupRef(role.group.id);
        return group ? { ...role, group } : null;
      })
      .filter((role): role is NonNullable<typeof role> => role !== null);
    const out: Ss12000Duty = {
      ...raw,
      // A later stretch of a changing post keeps its own id (dutySegments);
      // the post's own Duty is the one A5.5 names.
      id: raw.id === post.id ? (this.ids.duty(post.userId, post.academicYearId) ?? raw.id) : raw.id,
      // Without a version row, the post's creation: its updatedAt also moves
      // on HR-only edits (employmentPercent, contractKind) that leave the
      // Duty unchanged when the Fas 3 opt-in is off.
      meta: version ? metaOf(version, post.createdAt, post.updatedAt) : { ...raw.meta, modified: raw.meta.created },
      person: person ?? { id: raw.person.id },
      dutyAt: this.organisationRef(dutyAt),
    };
    delete out.assignmentRole;
    if (assignmentRole && assignmentRole.length > 0) out.assignmentRole = assignmentRole;
    // Under the SOURCE's Duty id (S1's one namespace, L5061) the object must
    // not contradict the source's: its role and dates are the source's, as
    // the link stored them, and SchemaPro's own HR figures stay out — the
    // source holds its own under that id.
    const link = this.ids.dutyLink(post.userId, post.academicYearId);
    if (link) {
      out.dutyRole = link.dutyRole as Ss12000Duty['dutyRole'];
      out.startDate = dayOf(link.startDate);
      if (link.endDate) out.endDate = dayOf(link.endDate);
      else delete (out as Partial<Ss12000Duty>).endDate;
      delete out.dutyPercent;
      delete out.hoursPerYear;
    }
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
    const out = new Map<string, Relation[]>();
    const add = (userId: string, relation: Relation) => out.set(userId, [...(out.get(userId) ?? []), relation]);
    for (const [userId, enrolment] of enrolments) {
      add(userId, { type: 'enrolment', organisationId: enrolment.enroledAt.id, startDate: enrolment.startDate });
    }
    // One relation per post, over all of it, at its dutyAt (every Duty of a
    // post is at the same unit): a reader without duties.read filters
    // persons by these dates, and a post cut where its grad changes would
    // tell that reader when (the opt-in is the school's, not the key's).
    const spans = new Map<string, { userId: string; organisationId: string; startDate: string; endDate: string | undefined }>();
    for (const { duty, post } of duties) {
      const span = spans.get(post.id);
      const end = duty.endDate as string | undefined;
      if (!span) spans.set(post.id, { userId: post.userId, organisationId: duty.dutyAt.id, startDate: duty.startDate, endDate: end });
      else {
        if (duty.startDate < span.startDate) span.startDate = duty.startDate;
        if (span.endDate !== undefined && (end === undefined || end > span.endDate)) span.endDate = end;
      }
    }
    for (const span of spans.values()) {
      add(span.userId, { type: 'duty', organisationId: span.organisationId, startDate: span.startDate, endDate: span.endDate });
    }
    if (this.can('responsibles.read')) {
      for (const link of links) {
        const child = enrolments.get(link.studentId);
        if (!child || !this.usersById.has(link.guardianId)) continue;
        add(link.guardianId, { type: 'responsibleFor.enrolment', organisationId: child.enroledAt.id, startDate: child.startDate });
      }
    }
    for (const membership of memberships) {
      add(membership.userId, {
        type: 'groupMembership',
        organisationId: this.groupOrganisation(membership.groupId),
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
