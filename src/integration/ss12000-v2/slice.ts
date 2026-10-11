import { Prisma, type PrismaClient, type SchoolForm } from '@prisma/client';
import { inTurn } from './in-turn';
import { readGrundschema } from '../../publication/published-grundschema';
import { dutyEmploymentSelect } from '../ss12000-duties';
import { adhocActivityId } from './ids';
import type { EmittedResource } from './scopes';

/**
 * One school as the v2.0 provider reads it: flat reads of exactly the
 * columns an emitted object carries, each made once per request and only
 * when a resource asks for it, all under the service principal (whose arms
 * hold every statement to the key's school; 20261014130000 added the ones
 * v2 needs). The objects are built in memory from these rows (mappers.ts):
 * a school is a few thousand people and a few hundred groups and
 * activities, and calendar events are read for the window asked only.
 *
 * NEVER SELECTED, so never emitted: Users.phone, invitedAt and authId;
 * CalendarLessons.note (it can carry an absence reason) and cancelCause;
 * every column of TeacherAbsences and their reasons (no absence leaves);
 * TeacherEmployments.reductionPercent, the target and the note (Fas 3: only
 * dutyPercent and hoursPerYear, and only under the school's opt-in, through
 * dutyEmploymentSelect and toSs12000Duty, as v1); the source's baseUrl,
 * tokenUrl and clientId (the identity function hands over organisation ids
 * and skolenhetskoder only).
 */

export type Day = string; // YYYY-MM-DD

export const dayOf = (value: Date): Day => value.toISOString().slice(0, 10);

/** The day before `day` (StudentEnrollments.validTo is exclusive, S1's endDate inclusive). */
export function dayBefore(day: Day): Day {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return dayOf(date);
}

export interface YearRow {
  id: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
}

export interface UserRow {
  id: string;
  role: 'SCHOOL_ADMIN' | 'TEACHER' | 'STUDENT' | 'GUARDIAN';
  firstName: string;
  lastName: string;
  email: string;
  ss12000Id: string | null;
  studentGroupId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupRow {
  id: string;
  academicYearId: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  ss12000Id: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentRow {
  studentId: string;
  academicYearId: string;
  studentGroupId: string | null;
  gradeLevel: number | null;
  validFrom: Date;
  validTo: Date | null;
}

export interface EmploymentRow {
  id: string;
  userId: string;
  academicYearId: string;
  employmentPercent: number;
  signature: string | null;
  createdAt: Date;
  updatedAt: Date;
  contractKind?: 'FERIE' | 'SEMESTER';
}

export interface DutyLinkRow {
  id: string;
  userId: string;
  academicYearId: string;
  ss12000DutyId: string;
  dutyRole: string;
  startDate: Date;
  endDate: Date | null;
}

/** A master lesson — live in DIRECT, the active snapshot's in DRAFT — as an Activity's source. */
export interface ActivityRow {
  /** The emitted id: the master's, or an ad-hoc lesson's UUIDv5. */
  id: string;
  /** The versions row's entity id: the master's, or the ad-hoc lesson's. */
  entityId: string;
  adhoc: boolean;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  teacherIds: string[];
  startDate: Day;
  endDate: Day;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface LessonRow {
  id: string;
  masterLessonId: string | null;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Version {
  createdAt: Date;
  modifiedAt: Date;
}

/** LocalTimplans.schoolForm → S1 SchoolTypesEnum (Q11: 2.1.0 still names grundsärskola/träningsskola). */
export const SCHOOL_TYPE: Record<SchoolForm, string> = {
  GRUNDSKOLA: 'GR',
  ANPASSAD_GRUNDSKOLA_AMNEN: 'GRS',
  ANPASSAD_GRUNDSKOLA_AMNESOMRADEN: 'TR',
  SPECIALSKOLA: 'SP',
  SAMESKOLA: 'SAM',
};

/** The role an S1 Duty (and a teaching DutyLink) has here; A5.5's set. */
export const TEACHING_DUTY_ROLES = new Set([
  'Lärare',
  'Förstelärare',
  'Speciallärare/specialpedagog',
  'Lärarassistent',
  'Fritidspedagog',
  'Förskollärare',
]);

const CHUNK = 5000;

async function chunked<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += CHUNK) out.push(...(await read(ids.slice(at, at + CHUNK))));
  return out;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => (cached ??= load());
}

export class SchoolSlice {
  constructor(
    readonly tx: PrismaClient,
    readonly schoolId: string,
    readonly today: Day,
  ) {}

  readonly school = memo(async () => {
    const row = await this.tx.school.findUnique({
      where: { id: this.schoolId },
      select: { id: true, name: true, timezone: true, createdAt: true, updatedAt: true },
    });
    if (!row) throw new Error('the key\'s school is not readable');
    return row;
  });

  /** The source's organisation ids and skolenhetskoder (app.ss12000_provider_identity), or none. */
  readonly identity = memo(async () => {
    const rows = await this.tx.$queryRaw<{ organisation_ids: string[] | null; school_unit_codes: string[] | null }[]>(
      Prisma.sql`SELECT organisation_ids, school_unit_codes FROM app.ss12000_provider_identity()`,
    );
    const row = rows?.[0];
    return {
      organisationIds: (row?.organisation_ids ?? []).map((id) => id.toLowerCase()),
      schoolUnitCodes: row?.school_unit_codes ?? [],
    };
  });

  readonly years = memo(
    async () =>
      (await this.tx.academicYear.findMany({
        where: { schoolId: this.schoolId },
        select: { id: true, startDate: true, endDate: true, isActive: true },
      })) as YearRow[],
  );

  /** Active or past (app.ss12000_year_is_emitted): a future year never leaves. */
  readonly emittedYears = memo(async () => {
    const years = await this.years();
    const active = years.find((year) => year.isActive);
    const horizon = active ? dayOf(active.startDate) : this.tomorrow();
    return new Map(years.filter((year) => year.isActive || dayOf(year.startDate) < horizon).map((year) => [year.id, year]));
  });

  readonly activeYear = memo(async () => (await this.years()).find((year) => year.isActive) ?? null);

  private tomorrow(): Day {
    const date = new Date(`${this.today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return dayOf(date);
  }

  /** (yearId, gradeLevel) → S1 schoolType, through the year's timplans. */
  readonly schoolTypes = memo(async () => {
    const [links, plans] = await inTurn(() => this.tx.academicYearTimplan.findMany({
        where: { schoolId: this.schoolId },
        select: { academicYearId: true, gradeLevel: true, localTimplanId: true },
      }), () => this.tx.localTimplan.findMany({ where: { schoolId: this.schoolId }, select: { id: true, schoolForm: true } }));
    const formOf = new Map(plans.map((plan) => [plan.id, plan.schoolForm as SchoolForm]));
    const byGrade = new Map<string, string>();
    const formsByYear = new Map<string, Set<string>>();
    for (const link of links) {
      const form = formOf.get(link.localTimplanId);
      if (!form) continue;
      // Grade 0 under grundskolans timplan is förskoleklass, its own school type.
      byGrade.set(`${link.academicYearId}:${link.gradeLevel}`, link.gradeLevel === 0 && form === 'GRUNDSKOLA' ? 'FKLASS' : SCHOOL_TYPE[form]);
      const forms = formsByYear.get(link.academicYearId) ?? new Set<string>();
      forms.add(SCHOOL_TYPE[form]);
      formsByYear.set(link.academicYearId, forms);
    }
    return {
      of: (yearId: string, gradeLevel: number | null): string | null =>
        gradeLevel === null ? null : (byGrade.get(`${yearId}:${gradeLevel}`) ?? null),
      /** Every type of a year, förskoleklass included. */
      ofYear: (yearId: string): string[] =>
        [...new Set([...byGrade.entries()].filter(([key]) => key.startsWith(`${yearId}:`)).map(([, type]) => type))].sort(),
      /** The year's timplans' school forms (no förskoleklass): one, or the Syllabus has no schoolType. */
      formsOf: (yearId: string): string[] => [...(formsByYear.get(yearId) ?? [])].sort(),
    };
  });

  /** Active users; a deactivated person is not emitted (and was buried). */
  readonly users = memo(
    async () =>
      (await this.tx.user.findMany({
        where: { schoolId: this.schoolId, isActive: true },
        select: {
          id: true,
          role: true,
          firstName: true,
          lastName: true,
          email: true,
          ss12000Id: true,
          studentGroupId: true,
          createdAt: true,
          updatedAt: true,
        },
      })) as UserRow[],
  );

  /** Groups of the active and past years. */
  readonly groups = memo(async () => {
    const years = await this.emittedYears();
    const rows = (await this.tx.studentGroup.findMany({
      where: { schoolId: this.schoolId },
      select: {
        id: true,
        academicYearId: true,
        name: true,
        kind: true,
        gradeLevel: true,
        ss12000Id: true,
        createdAt: true,
        updatedAt: true,
      },
    })) as GroupRow[];
    return rows.filter((row) => years.has(row.academicYearId));
  });

  readonly enrollments = memo(
    async () =>
      (await this.tx.studentEnrollment.findMany({
        where: { schoolId: this.schoolId },
        select: { studentId: true, academicYearId: true, studentGroupId: true, gradeLevel: true, validFrom: true, validTo: true },
      })) as EnrollmentRow[],
  );

  readonly teachingMembers = memo(
    async () =>
      await this.tx.studentGroupMember.findMany({
        where: { schoolId: this.schoolId },
        select: { studentGroupId: true, studentId: true },
      }),
  );

  readonly guardianLinks = memo(
    async () =>
      await this.tx.guardianStudent.findMany({
        where: { schoolId: this.schoolId },
        select: { guardianId: true, studentId: true },
      }),
  );

  readonly policy = memo(async () => {
    const row = await this.tx.staffingPolicy.findUnique({
      where: { schoolId: this.schoolId },
      select: { shareEmploymentWithIntegrations: true, fullTimeAnnualHours: true },
    });
    return { share: row?.shareEmploymentWithIntegrations === true, fullTimeAnnualHours: row?.fullTimeAnnualHours ?? null };
  });

  /** Every post of the school (a Duty id per year), with the Duty's columns only. */
  readonly employments = memo(async () => {
    const { share } = await this.policy();
    const rows = await this.tx.teacherEmployment.findMany({
      where: { schoolId: this.schoolId },
      select: { ...dutyEmploymentSelect(share), academicYearId: true },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      academicYearId: row.academicYearId,
      employmentPercent: Number(row.employmentPercent),
      signature: row.signature,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...('contractKind' in row ? { contractKind: row.contractKind as 'FERIE' | 'SEMESTER' } : {}),
    })) as EmploymentRow[];
  });

  /** Live (not ended) duty links: the source's Duty ids, no HR figure. */
  readonly dutyLinks = memo(
    async () =>
      (await this.tx.ss12000DutyLink.findMany({
        where: { schoolId: this.schoolId, endedAt: null },
        select: { id: true, userId: true, academicYearId: true, ss12000DutyId: true, dutyRole: true, startDate: true, endDate: true },
      })) as DutyLinkRow[],
  );

  readonly mentorships = memo(
    async () =>
      await this.tx.teacherDuty.findMany({
        where: { schoolId: this.schoolId, kind: 'MENTORSKAP' },
        select: { userId: true, academicYearId: true, studentGroupId: true, updatedAt: true },
      }),
  );

  readonly rooms = memo(
    async () =>
      await this.tx.room.findMany({
        where: { schoolId: this.schoolId },
        select: { id: true, name: true, capacity: true, createdAt: true, updatedAt: true },
      }),
  );

  readonly subjects = memo(
    async () =>
      await this.tx.subject.findMany({
        where: { schoolId: this.schoolId },
        select: { id: true, name: true, nationalCode: true, countsTowardTimplan: true, createdAt: true, updatedAt: true },
      }),
  );

  /**
   * The active year's activities: the PUBLISHED weekly timetable (the live
   * masters in DIRECT, the snapshot valid now in DRAFT, through the same
   * readGrundschema v1's /activities uses), parked lessons excluded, plus
   * the ad-hoc lessons of the active year (a CalendarLesson with no master
   * and no pending removal), each its own Activity under a UUIDv5.
   */
  readonly activities = memo(async (): Promise<ActivityRow[]> => {
    const year = await this.activeYear();
    if (!year) return [];
    const start = dayOf(year.startDate);
    const end = dayOf(year.endDate);
    const live = async () => {
      const masters = await this.tx.masterLesson.findMany({
        where: { schoolId: this.schoolId, academicYearId: year.id, isParked: false },
        select: {
          id: true,
          subjectId: true,
          studentGroupId: true,
          teacherId: true,
          coTeacherId: true,
          startDate: true,
          endDate: true,
          isParked: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const extra =
        masters.length === 0
          ? []
          : await chunked(masters.map((m) => m.id), (ids) =>
              this.tx.masterLessonGroup.findMany({ where: { masterLessonId: { in: ids } }, select: { masterLessonId: true, studentGroupId: true } }),
            );
      return masters.map((master) => ({
        ...master,
        extraGroups: extra.filter((row) => row.masterLessonId === master.id).map((row) => ({ studentGroupId: row.studentGroupId })),
      }));
    };
    const { rows, source } = await readGrundschema(this.tx, { role: null, schoolId: this.schoolId }, year.id, live);
    const published =
      source.kind === 'PUBLISHED' && source.publicationId
        ? await this.tx.timetablePublication.findFirst({ where: { id: source.publicationId }, select: { publishedAt: true } })
        : null;
    const out: ActivityRow[] = rows
      .filter((row) => !row.isParked)
      .map((row) => {
        const own = row as typeof row & { createdAt?: Date; updatedAt?: Date };
        return {
          id: row.id,
          entityId: row.id,
          adhoc: false,
          subjectId: row.subjectId,
          studentGroupId: row.studentGroupId,
          extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId).sort(),
          teacherIds: [row.teacherId, row.coTeacherId].filter((id): id is string => id !== null),
          startDate: row.startDate ? dayOf(row.startDate) : start,
          endDate: row.endDate ? dayOf(row.endDate) : end,
          createdAt: own.createdAt ?? published?.publishedAt ?? null,
          updatedAt: own.updatedAt ?? published?.publishedAt ?? null,
        };
      });
    out.push(...(await this.adhocActivities(year.id)));
    return out;
  });

  private async adhocActivities(yearId: string): Promise<ActivityRow[]> {
    const groups = (await this.groups()).filter((group) => group.academicYearId === yearId).map((group) => group.id);
    if (groups.length === 0) return [];
    const lessons = await chunked(groups, (ids) =>
      this.tx.calendarLesson.findMany({
        where: { schoolId: this.schoolId, masterLessonId: null, studentGroupId: { in: ids } },
        select: { id: true, subjectId: true, studentGroupId: true, startsAt: true, createdAt: true, updatedAt: true },
      }),
    );
    if (lessons.length === 0) return [];
    const ids = lessons.map((lesson) => lesson.id);
    const [pending, extra, teachers] = await inTurn(
      () => chunked(ids, (chunk) => this.tx.publicationPendingRemoval.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true } })),
      () => chunked(ids, (chunk) => this.tx.calendarLessonGroup.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, studentGroupId: true } })),
      () => chunked(ids, (chunk) => this.tx.calendarLessonTeacher.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, teacherId: true, role: true } })),
    );
    const keyed = new Set(pending.map((row) => row.calendarLessonId));
    const timezone = (await this.school()).timezone;
    return lessons
      .filter((lesson) => !keyed.has(lesson.id))
      .map((lesson) => {
        const day = localDay(lesson.startsAt, timezone);
        return {
          id: adhocActivityId(lesson.id),
          entityId: lesson.id,
          adhoc: true,
          subjectId: lesson.subjectId,
          studentGroupId: lesson.studentGroupId,
          extraGroupIds: extra.filter((row) => row.calendarLessonId === lesson.id).map((row) => row.studentGroupId).sort(),
          teacherIds: teachers
            .filter((row) => row.calendarLessonId === lesson.id && row.role !== 'SUBSTITUTE')
            .map((row) => row.teacherId)
            .sort(),
          startDate: day,
          endDate: day,
          createdAt: lesson.createdAt,
          updatedAt: lesson.updatedAt,
        };
      });
  }

  /** Calendar lessons whose start lies in [from, to], of the active and past years' groups. */
  async lessons(from: Date, to: Date): Promise<LessonRow[]> {
    const groups = new Set((await this.groups()).map((group) => group.id));
    const rows = (await this.tx.calendarLesson.findMany({
      where: { schoolId: this.schoolId, startsAt: { gte: from, lte: to } },
      select: {
        id: true,
        masterLessonId: true,
        subjectId: true,
        studentGroupId: true,
        roomId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    })) as LessonRow[];
    return rows.filter((row) => groups.has(row.studentGroupId));
  }

  async lessonsById(ids: readonly string[]): Promise<LessonRow[]> {
    const groups = new Set((await this.groups()).map((group) => group.id));
    const rows = (await chunked([...ids], (chunk) =>
      this.tx.calendarLesson.findMany({
        where: { schoolId: this.schoolId, id: { in: chunk } },
        select: {
          id: true,
          masterLessonId: true,
          subjectId: true,
          studentGroupId: true,
          roomId: true,
          startsAt: true,
          endsAt: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    )) as LessonRow[];
    return rows.filter((row) => groups.has(row.studentGroupId));
  }

  /** The parts of the given lessons an event carries. */
  async lessonParts(ids: readonly string[]) {
    const [teachers, extra, students, pending] = await inTurn(() => chunked([...ids], (chunk) =>
        this.tx.calendarLessonTeacher.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, teacherId: true, role: true } }),
      ), () => chunked([...ids], (chunk) =>
        this.tx.calendarLessonGroup.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, studentGroupId: true } }),
      ), () => chunked([...ids], (chunk) =>
        this.tx.calendarLessonStudent.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, studentId: true } }),
      ), () => chunked([...ids], (chunk) =>
        this.tx.publicationPendingRemoval.findMany({ where: { calendarLessonId: { in: chunk } }, select: { calendarLessonId: true, masterLessonId: true } }),
      ));
    const group = <T extends { calendarLessonId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.calendarLessonId, [...(map.get(row.calendarLessonId) ?? []), row]);
      return map;
    };
    return {
      teachers: group(teachers),
      extraGroups: group(extra),
      students: group(students),
      pendingKey: new Map(pending.map((row) => [row.calendarLessonId, row.masterLessonId])),
    };
  }

  /** meta per entity id of one resource; only the ids asked for when given. */
  async versions(resource: EmittedResource, ids?: readonly string[]): Promise<Map<string, Version>> {
    const rows =
      ids === undefined
        ? await this.tx.ss12000EntityVersion.findMany({
            where: { schoolId: this.schoolId, resource },
            select: { entityId: true, createdAt: true, modifiedAt: true },
          })
        : await chunked([...ids], (chunk) =>
            this.tx.ss12000EntityVersion.findMany({
              where: { schoolId: this.schoolId, resource, entityId: { in: chunk } },
              select: { entityId: true, createdAt: true, modifiedAt: true },
            }),
          );
    return new Map(rows.map((row) => [row.entityId, { createdAt: row.createdAt, modifiedAt: row.modifiedAt }]));
  }

  async tombstones(after: Date | null) {
    return await this.tx.ss12000Tombstone.findMany({
      where: { schoolId: this.schoolId, ...(after ? { removedAt: { gt: after } } : {}) },
      select: { resource: true, emittedId: true, removedAt: true },
    });
  }
}

/** The school-local date of an instant. */
export function localDay(instant: Date, timeZone: string): Day {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
