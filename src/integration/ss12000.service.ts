import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

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
 * comes back `[]`. So every table a `select` below reaches needs a policy, and
 * a row in section 3 of scripts/test/rls-policies.sql.
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
      const where = { schoolId };
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
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: lessons.map((lesson) => ({
          id: lesson.id,
          displayName: `${lesson.subject.name} — ${lesson.studentGroup.name}`,
          activityType: 'Undervisning',
          subject: { id: lesson.subject.id, displayName: lesson.subject.name },
          groupIds: [
            lesson.studentGroup.id,
            ...lesson.extraGroups.map((entry) => entry.studentGroupId),
          ],
          teacherIds: [lesson.teacherId, lesson.coTeacherId].filter(Boolean),
          studentIds: lesson.participants.map((entry) => entry.studentId),
          roomId: lesson.roomId,
          dayOfWeek: lesson.dayOfWeek,
          startTime: toHHMMSS(lesson.startTime),
          endTime: toHHMMSS(lesson.endTime),
        })),
      };
    });
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
      return {
        totalCount,
        limit: take,
        offset: skip,
        data: lessons.map((lesson) => ({
          id: lesson.id,
          activityId: lesson.masterLessonId,
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
        select: { id: true },
      });

      let updated = 0;
      let groupsCreated = 0;
      let guardianLinks = 0;
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
        if (person.groupDisplayName && user.role === 'STUDENT' && activeYear) {
          const existing = await tx.studentGroup.findFirst({
            where: { schoolId, name: person.groupDisplayName },
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
        `SS12000 import [school=${schoolId}, updated=${updated}, groupsCreated=${groupsCreated}]`,
      );
      return {
        updated,
        groupsCreated,
        guardianLinks,
        needsProvisioning: [...new Set(needsProvisioning)],
      };
    });
  }
}

function toHHMMSS(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}:00`;
}

// Re-exported so the controller can type the system transaction if needed.
export type SystemTx = PrismaClient;
