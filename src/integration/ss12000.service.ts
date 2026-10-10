import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { readGrundschema, type PublishedMaster } from '../publication/published-grundschema';
import { dutyEmploymentSelect, toSs12000Duty, type Ss12000Duty } from './ss12000-duties';

/**
 * SS12000:2020-inspired read API + roster import.
 *
 * Every method receives the school id resolved by `IntegrationKeyGuard` and
 * acts for that one school; the tenancy note below says what holds it there.
 *
 * Field naming follows SS12000 conventions (persons, groups, activities,
 * calendarEvents, displayName, groupMemberships, …); see
 * docs/integration-api.md for the exact mapping table.
 */
/**
 * Tenancy note: every method runs inside `withServicePrincipal(schoolId, …)`.
 *
 * `schoolId` always originates from `IntegrationKeyGuard`, which resolves it
 * from a hashed `X-API-Key` — never from request input. Inside that
 * transaction the service-principal RLS policies constrain each statement to
 * that one school, so the `where: { schoolId }` clauses below are defence in
 * depth rather than the only thing standing between two tenants: a query that
 * forgets one returns nothing instead of leaking.
 *
 * The same property cuts the other way. A table with no service-principal
 * policy reads as empty here, not as denied: a required relation into it
 * throws "Inconsistent query result" (a 500), and a list relation silently
 * comes back `[]`. So every table a query below reads needs a policy, and a
 * row in section 3 of scripts/test/rls-policies.sql. The one table that is
 * denied instead is `_prisma_migrations`, which no API role may touch
 * (section 14 there); nothing below reads it.
 *
 * These methods previously used `withSystemTransaction` on the assumption that
 * it bypassed RLS. It does not, so every endpoint here returned empty payloads
 * — which an integrating system reads as "this school has no data".
 */
@Injectable()
export class Ss12000Service {
  private readonly logger = new Logger(Ss12000Service.name);

  constructor(private readonly prisma: PrismaService) {}

  private page(limit?: string, offset?: string): { take: number; skip: number } {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const skip = Math.max(Number(offset) || 0, 0);
    return { take, skip };
  }

  async organisation(schoolId: string) {
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      const school = await tx.school.findUnique({
        where: { id: schoolId },
        select: { id: true, name: true, timezone: true },
      });
      return {
        id: school?.id,
        displayName: school?.name,
        organisationType: 'Skolenhet',
        timezone: school?.timezone,
      };
    });
  }

  async persons(schoolId: string, limit?: string, offset?: string, role?: string) {
    const { take, skip } = this.page(limit, offset);
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      const where = {
        schoolId,
        ...(role ? { role: role as never } : {}),
      };
      const [totalCount, users] = await Promise.all([
        tx.user.count({ where }),
        tx.user.findMany({
          where,
          orderBy: { lastName: 'asc' },
          take,
          skip,
          select: {
            id: true,
            role: true,
            firstName: true,
            lastName: true,
            email: true,
            isActive: true,
            studentGroupId: true,
            guardianLinks: { select: { studentId: true } },
            studentLinks: { select: { guardianId: true } },
          },
        }),
      ]);
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: users.map((user) => ({
          id: user.id,
          givenName: user.firstName,
          familyName: user.lastName,
          eduPersonPrincipalNames: [user.email],
          enabled: user.isActive,
          personRole:
            user.role === 'SCHOOL_ADMIN'
              ? 'Personal'
              : user.role === 'TEACHER'
                ? 'Lärare'
                : user.role === 'GUARDIAN'
                  ? 'Vårdnadshavare'
                  : 'Elev',
          enrolments: user.studentGroupId
            ? [{ groupId: user.studentGroupId }]
            : [],
          responsibleFor: user.guardianLinks.map((link) => ({
            personId: link.studentId,
          })),
          responsibles: user.studentLinks.map((link) => ({
            personId: link.guardianId,
          })),
        })),
      };
    });
  }

  async groups(schoolId: string, limit?: string, offset?: string) {
    const { take, skip } = this.page(limit, offset);
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      // The active läsår's groups only. After a läsårsrullning the school
      // holds next year's classes beside this year's — "8A" twice, one of
      // them the promoted 7A with no pupils yet — and a kommun reading both
      // under one name cannot tell which roster is the one in session. The
      // pupils' own groupMemberships (persons) already point into the active
      // year only, so this keeps the two exports talking about the same year.
      const where = { schoolId, academicYear: { isActive: true } };
      const [totalCount, groups] = await Promise.all([
        tx.studentGroup.count({ where }),
        tx.studentGroup.findMany({
          where,
          orderBy: { name: 'asc' },
          take,
          skip,
          select: {
            id: true,
            name: true,
            gradeLevel: true,
            academicYearId: true,
            members: { select: { id: true }, where: { isActive: true } },
          },
        }),
      ]);
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: groups.map((group) => ({
          id: group.id,
          displayName: group.name,
          groupType: 'Klass',
          schoolYear: group.gradeLevel,
          schoolYearId: group.academicYearId,
          groupMemberships: group.members.map((member) => ({
            person: { id: member.id },
          })),
        })),
      };
    });
  }

  /**
   * The active läsår's teaching posts as SS12000 2.1.0 Duty objects — the
   * one feed here that uses the standard's own property names and `meta`
   * (src/integration/ss12000-duties.ts, with the citation and every field's
   * source). Paging is the house's, ordered by the post's id.
   *
   * Posts of active users only. The principal reads TeacherEmployments and
   * TeacherDuties through their service arms (20261006100000,
   * 20261007090000) and the policy through 20261010110000's; the select
   * names exactly the Duty's columns, so reductionPercent, the target and the
   * note never leave the database. dutyPercent and hoursPerYear appear only
   * when the school has turned shareEmploymentWithIntegrations on.
   */
  async duties(
    schoolId: string,
    limit?: string,
    offset?: string,
  ): Promise<{ totalCount: number; limit: number; offset: number; data: Ss12000Duty[] }> {
    const { take, skip } = this.page(limit, offset);
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      const year = await tx.academicYear.findFirst({
        where: { schoolId, isActive: true },
        select: { id: true, startDate: true, endDate: true },
      });
      if (!year) return { totalCount: 0, limit: take, offset: skip, data: [] };
      const policy = await tx.staffingPolicy.findUnique({
        where: { schoolId },
        select: { shareEmploymentWithIntegrations: true, fullTimeAnnualHours: true },
      });
      const share = policy?.shareEmploymentWithIntegrations === true;
      const where = { schoolId, academicYearId: year.id, user: { isActive: true } };
      // One statement after another: a transaction is one connection.
      const totalCount = await tx.teacherEmployment.count({ where });
      const posts = await tx.teacherEmployment.findMany({
        where,
        orderBy: { id: 'asc' },
        take,
        skip,
        select: dutyEmploymentSelect(share),
      });
      const mentorships =
        posts.length === 0
          ? []
          : await tx.teacherDuty.findMany({
              where: {
                schoolId,
                academicYearId: year.id,
                kind: 'MENTORSKAP',
                userId: { in: posts.map((post) => post.userId) },
                studentGroup: { academicYearId: year.id },
              },
              select: { userId: true, studentGroupId: true, updatedAt: true },
              orderBy: [{ userId: 'asc' }, { studentGroupId: 'asc' }],
            });
      const bounds = {
        startDate: year.startDate.toISOString().slice(0, 10),
        endDate: year.endDate.toISOString().slice(0, 10),
      };
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: posts.map((post) =>
          toSs12000Duty({
            schoolId,
            year: bounds,
            share,
            fullTimeAnnualHours: policy?.fullTimeAnnualHours ?? null,
            employment: {
              id: post.id,
              userId: post.userId,
              employmentPercent: Number(post.employmentPercent),
              signature: post.signature,
              createdAt: post.createdAt,
              updatedAt: post.updatedAt,
              ...('contractKind' in post ? { contractKind: post.contractKind as 'FERIE' | 'SEMESTER' } : {}),
            },
            mentorships: mentorships
              .filter((duty) => duty.userId === post.userId && duty.studentGroupId !== null)
              .map((duty) => ({ studentGroupId: duty.studentGroupId!, updatedAt: duty.updatedAt })),
          }),
        ),
      };
    });
  }

  /** Weekly master timetable as SS12000 activities. */
  async activities(schoolId: string, limit?: string, offset?: string) {
    const { take, skip } = this.page(limit, offset);
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      // Set-aside lessons are not activities: the kommun reads this as the
      // weekly timetable, and a parked lesson is on nobody's.
      const where = { schoolId, academicYear: { isActive: true }, isParked: false };
      const [totalCount, lessons] = await Promise.all([
        tx.masterLesson.count({ where }),
        tx.masterLesson.findMany({
          where,
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
          take,
          skip,
          select: {
            id: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
            teacherId: true,
            coTeacherId: true,
            roomId: true,
            subject: { select: { id: true, name: true } },
            studentGroup: { select: { id: true, name: true } },
            extraGroups: { select: { studentGroupId: true } },
            participants: { select: { studentId: true } },
          },
        }),
      ]);
      // A DRAFT school (Publicering, 20261011100000) shows the service no
      // master lesson: the kommun reads the PUBLISHED weekly timetable, from
      // the snapshot, in the same order and shape. Asked only when the live
      // read found nothing, so DIRECT sends the statements it always sent.
      if (totalCount === 0) {
        const published = await this.publishedActivities(tx, schoolId);
        if (published !== null) {
          return {
            totalCount: published.length,
            limit: take,
            offset: skip,
            data: published.slice(skip, skip + take).map(toActivity),
          };
        }
      }
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: lessons.map(toActivity),
      };
    });
  }

  /**
   * The published weekly timetable of the active year, for a DRAFT school:
   * null in DIRECT (the masters are read as they are). Parked lessons are
   * not activities, as in the live read; ordered by (dayOfWeek, startTime,
   * id) — the live read's order with the id as the tie it leaves open.
   */
  private async publishedActivities(tx: PrismaClient, schoolId: string): Promise<PublishedMaster[] | null> {
    const year = await tx.academicYear.findFirst({ where: { schoolId, isActive: true }, select: { id: true } });
    if (!year) return null;
    const { rows, source } = await readGrundschema(tx, { role: null, schoolId }, year.id, async () => [] as PublishedMaster[]);
    if (source.kind === 'LIVE') return null;
    return rows
      .filter((row) => !row.isParked)
      .sort(
        (a, b) =>
          a.dayOfWeek - b.dayOfWeek ||
          a.startTime.getTime() - b.startTime.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  /** Dated lessons (the "lesson export" consumed by Vklass-style systems). */
  async calendarEvents(
    schoolId: string,
    from?: string,
    to?: string,
    limit?: string,
    offset?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('from and to (YYYY-MM-DD) are required.');
    }
    const { take, skip } = this.page(limit, offset);
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      const where = {
        schoolId,
        date: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      };
      const [totalCount, lessons] = await Promise.all([
        tx.calendarLesson.count({ where }),
        tx.calendarLesson.findMany({
          where,
          orderBy: { startsAt: 'asc' },
          take,
          skip,
          select: {
            id: true,
            masterLessonId: true,
            startsAt: true,
            endsAt: true,
            status: true,
            subject: { select: { id: true, name: true } },
            studentGroup: { select: { id: true, name: true } },
            room: { select: { id: true, name: true } },
            teachers: { select: { teacherId: true, role: true } },
            extraGroups: { select: { studentGroupId: true } },
            participants: { select: { studentId: true } },
          },
        }),
      ]);
      // The published key (Publicering, 20261011100000): a lesson whose
      // template a DRAFT school deleted keeps that template as its activity
      // until a publish settles it. Asked only of a page holding a row with
      // no master lesson, so a page without one sends what it always sent.
      const orphans = lessons.filter((lesson) => lesson.masterLessonId === null).map((lesson) => lesson.id);
      const pendingKey = new Map(
        orphans.length === 0
          ? []
          : (
              await tx.publicationPendingRemoval.findMany({
                where: { calendarLessonId: { in: orphans } },
                select: { calendarLessonId: true, masterLessonId: true },
              })
            ).map((row) => [row.calendarLessonId, row.masterLessonId]),
      );
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: lessons.map((lesson) => ({
          id: lesson.id,
          activityId: lesson.masterLessonId ?? pendingKey.get(lesson.id) ?? null,
          startTime: lesson.startsAt.toISOString(),
          endTime: lesson.endsAt.toISOString(),
          cancelled: lesson.status === 'CANCELLED',
          subject: { id: lesson.subject.id, displayName: lesson.subject.name },
          groupIds: [
            lesson.studentGroup.id,
            ...lesson.extraGroups.map((entry) => entry.studentGroupId),
          ],
          teachers: lesson.teachers.map((assignment) => ({
            personId: assignment.teacherId,
            role: assignment.role,
          })),
          studentIds: lesson.participants.map((entry) => entry.studentId),
          room: lesson.room
            ? { id: lesson.room.id, displayName: lesson.room.name }
            : null,
        })),
      };
    });
  }

  /**
   * Roster sync from a municipal source system. Update-only for identity
   * safety: existing persons (matched by email) get names, group membership
   * and guardian relations synced; unknown persons are returned in
   * `needsProvisioning` for account creation via the People page.
   */
  async importPersons(
    schoolId: string,
    persons: Array<{
      givenName?: string;
      familyName?: string;
      email?: string;
      groupDisplayName?: string;
      responsibleEmails?: string[];
    }>,
  ) {
    if (!Array.isArray(persons) || persons.length === 0 || persons.length > 2000) {
      throw new BadRequestException('persons must be a non-empty array (max 2000).');
    }
    return this.prisma.withServicePrincipal(schoolId, async (tx) => {
      const activeYear = await tx.academicYear.findFirst({
        where: { schoolId, isActive: true },
        select: { id: true, predecessorId: true, graduatingGradeLevel: true },
      });
      // Last year's classes that graduated into no successor (9A when G = 9):
      // a pupil with no class whom the roster still lists in one of them is
      // a graduate the source system has not rolled yet, not a new 9A pupil.
      const graduatedNames = new Set(
        activeYear?.predecessorId && activeYear.graduatingGradeLevel != null
          ? (
              await tx.studentGroup.findMany({
                where: {
                  schoolId,
                  academicYearId: activeYear.predecessorId,
                  kind: 'CLASS',
                  gradeLevel: { gte: activeYear.graduatingGradeLevel },
                  successor: { is: null },
                },
                select: { name: true },
              })
            ).map((group) => group.name)
          : [],
      );

      let updated = 0;
      let groupsCreated = 0;
      let guardianLinks = 0;
      let classesKept = 0;
      const needsProvisioning: string[] = [];

      for (const person of persons) {
        const email = person.email?.trim().toLowerCase();
        if (!email) continue;
        const user = await tx.user.findFirst({
          where: { schoolId, email: { equals: email, mode: 'insensitive' } },
          select: { id: true, role: true },
        });
        if (!user) {
          needsProvisioning.push(email);
          continue;
        }

        // Group membership (students only), creating the class if unknown.
        let studentGroupId: string | undefined;
        if (
          person.groupDisplayName &&
          user.role === 'STUDENT' &&
          activeYear &&
          (await this.namesAnotherYearsClass(tx, schoolId, user.id, person.groupDisplayName, graduatedNames))
        ) {
          classesKept++;
        } else if (person.groupDisplayName && user.role === 'STUDENT' && activeYear) {
          // Matched within the active läsår, where the class is created too.
          // Group names are unique per (school, year), not per school: after
          // a läsårsrullning "8A" is both this year's 8A and next year's (the
          // promoted 7A), and a name match across years could put this
          // year's 8A pupil into next year's 8A — where activation counts
          // them as already placed, so they never reach 9A.
          const existing = await tx.studentGroup.findFirst({
            where: { schoolId, academicYearId: activeYear.id, name: person.groupDisplayName },
            select: { id: true },
          });
          if (existing) {
            studentGroupId = existing.id;
          } else {
            const created = await tx.studentGroup.create({
              data: {
                schoolId,
                academicYearId: activeYear.id,
                name: person.groupDisplayName,
              },
              select: { id: true },
            });
            groupsCreated++;
            studentGroupId = created.id;
          }
        }

        // The class is written by the statement that checks the role, because
        // the role above was read without a lock. Under READ COMMITTED an
        // admin's PATCH making this person a teacher can commit between that
        // read and this write, and an UPDATE keyed on the id alone would then
        // put a teacher in the class — handing them the pupils' read path,
        // since app.current_user_group_id() never looks at the role. An UPDATE
        // that waits on the row lock re-evaluates its WHERE against the row
        // that committed, so `role: 'STUDENT'` is judged at the moment of the
        // write rather than at the read.
        //
        // Users_only_a_student_has_a_class states the same rule in the table;
        // this is what keeps the sync from meeting that CHECK. Without it the
        // lost race is a check violation, and the whole batch rolls back with
        // a 500 over one person.
        //
        // When the role has moved, the person gets their names and no class:
        // exactly what the sync does for someone already a teacher when read,
        // so the race ends in one of its two serial outcomes. They are still
        // counted in `updated` — their row was written — and nothing new is
        // reported, as nothing is for a teacher the roster lists in a class.
        // A class created for them above stays; the roster named it.
        const names = {
          ...(person.givenName ? { firstName: person.givenName } : {}),
          ...(person.familyName ? { lastName: person.familyName } : {}),
        };
        const enrolled =
          studentGroupId !== undefined &&
          (
            await tx.user.updateMany({
              where: { id: user.id, role: 'STUDENT' },
              data: { ...names, studentGroupId },
            })
          ).count === 1;
        if (!enrolled) {
          await tx.user.update({ where: { id: user.id }, data: names });
        }
        updated++;

        // Guardian relations by email (existing guardian accounts only).
        for (const guardianEmail of person.responsibleEmails ?? []) {
          const guardian = await tx.user.findFirst({
            where: {
              schoolId,
              role: 'GUARDIAN',
              email: { equals: guardianEmail.trim().toLowerCase(), mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (!guardian) {
            needsProvisioning.push(guardianEmail.trim().toLowerCase());
            continue;
          }
          await tx.guardianStudent.upsert({
            where: {
              guardianId_studentId: { guardianId: guardian.id, studentId: user.id },
            },
            create: { schoolId, guardianId: guardian.id, studentId: user.id },
            update: {},
          });
          guardianLinks++;
        }
      }

      this.logger.log(
        `SS12000 import [school=${schoolId}, updated=${updated}, groupsCreated=${groupsCreated}, classesKept=${classesKept}]`,
      );
      return {
        updated,
        groupsCreated,
        guardianLinks,
        classesKept,
        needsProvisioning: [...new Set(needsProvisioning)],
      };
    });
  }

  /**
   * Whether the roster names the pupil's class by its name in the year
   * before or after — the source system and SchemaPro rolling the läsår on
   * different days. Then the class is kept and counted (classesKept), not
   * moved.
   *
   * WHY. The sync matches a class by name within the active läsår, and
   * names repeat across years by design: next year's 8A is the promoted 7A.
   * A municipal register usually switches its placements on 1 July or in
   * August, while SchemaPro activates the new year the day after the old one
   * ends. In between, a nightly sync sends last year's names:
   *  - a pupil now in B's 8A (promoted from A's 7A) arrives as "7A", and the
   *    sync put them in B's intake 7A — or created an ungraded "7A" — one
   *    grade down;
   *  - a graduate (no class since the activation) arrives as "9A", and was
   *    put in B's 9A, the promoted 8A.
   * The other way round, a register that switched before the activation
   * sends A's 7A pupil as "8A", which in the active year A is the outgoing
   * cohort; the activation then follows A-8A → B-9A, and the pupil skips a
   * grade. Each silently undoes the activation for that pupil.
   *
   * The rule: the name sent is the name of the pupil's current class's
   * predecessor or successor (and not the class's own name), or the pupil
   * has no class and the name is one of last year's graduated classes. A
   * pupil genuinely moved back into a class named like their old one in the
   * same window is kept too, and shows in classesKept for the admin to move
   * on the people page.
   */
  private async namesAnotherYearsClass(
    tx: PrismaClient,
    schoolId: string,
    userId: string,
    name: string,
    graduatedNames: ReadonlySet<string>,
  ): Promise<boolean> {
    const current = await tx.studentGroup.findFirst({
      where: { schoolId, members: { some: { id: userId } } },
      select: {
        name: true,
        predecessor: { select: { name: true } },
        successor: { select: { name: true } },
      },
    });
    if (!current) return graduatedNames.has(name);
    if (current.name === name) return false;
    return current.predecessor?.name === name || current.successor?.name === name;
  }
}

function toHHMMSS(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}:00`;
}

// Re-exported so the controller can type the system transaction if needed.
export type SystemTx = PrismaClient;

/** One master lesson — live, or a published snapshot's — as an SS12000 activity. */
function toActivity(lesson: {
  id: string;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  subject: { id: string; name: string };
  studentGroup: { id: string; name: string };
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
}) {
  return {
    id: lesson.id,
    displayName: `${lesson.subject.name} — ${lesson.studentGroup.name}`,
    activityType: 'Undervisning',
    subject: { id: lesson.subject.id, displayName: lesson.subject.name },
    groupIds: [lesson.studentGroup.id, ...lesson.extraGroups.map((entry) => entry.studentGroupId)],
    teacherIds: [lesson.teacherId, lesson.coTeacherId].filter(Boolean),
    studentIds: lesson.participants.map((entry) => entry.studentId),
    roomId: lesson.roomId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMMSS(lesson.startTime),
    endTime: toHHMMSS(lesson.endTime),
  };
}
