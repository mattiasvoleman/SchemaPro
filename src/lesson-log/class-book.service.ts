import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { calendarLessonRosters } from '../calendar/lesson-roster';
import { requireSchoolId } from '../common/utils/request-context';
import { asDay, dayDate, schoolTimezone } from '../cover/cover-context';
import { PrismaService } from '../database/prisma.service';
import { schoolClock } from '../family/family-schedule.service';
import type { ClassBookQueryDto } from './dto/lesson-log.dto';
import { assertRange } from './lesson-log.service';

/**
 * KLASSBOKEN: one class's lessons over a period, each with its topic and
 * homework, as the school prints it. GET /api/v1/lesson-logs/class-book, for
 * every teacher and administrator of the school.
 *
 * WHICH LESSONS. A class's own lessons (its id on the lesson, or joined to
 * it), and every other lesson the one roster reader
 * (src/calendar/lesson-roster.ts) puts one of the class's pupils on: a
 * språkval or nivågrupp lesson, a lesson naming a pupil. The latter carry how
 * many of the class's pupils are on them, so "Spanska, 6 av klassens elever"
 * reads right beside the class's own svenska. A later phase that changes who
 * attends a lesson (a SvA pupil leaving class svenska) changes the reader,
 * and the klassbok follows. A teaching group's klassbok is its own lessons:
 * its pupils' other lessons are their classes'.
 *
 * The class's pupils are its active pupils now: a klassbok of last term
 * printed today counts the class as it stands today.
 *
 * WHAT IT SAYS. The published calendar (no draft), held, coming and
 * cancelled lessons as the family's week shows them, the
 * teachers by name with the substitute marked, the room, the topic and the
 * homework. Never the note to the substitute, which may name pupils, and
 * never a pupil: a count of them is all. So, like the print set of the
 * school's weeks, it is the timetable layer every member of staff reads, and
 * nothing is written to the läslogg (src/access-log/access-log.ts).
 *
 * At most 200 days, a term with room to spare: one statement each for the
 * group, its pupils, the candidate lessons, their rosters and their logs.
 */

export interface ClassBookLesson {
  id: string;
  date: string;
  start: string;
  end: string;
  status: string;
  subject: string;
  /** The lesson's own group first, then the groups joined to it. */
  groups: string[];
  room: string | null;
  teachers: { name: string; substitute: boolean }[];
  topic: string | null;
  homework: string | null;
  /**
   * When the log was last written, null with no log: the version an
   * administrator's removal sends as its basis, so a log rewritten since the
   * klassbok was read is a 409 and not removed unseen.
   */
  logUpdatedAt: string | null;
  /** Another group's lesson: how many of this class's pupils are on it. Null for the group's own. */
  attending: number | null;
}

export interface ClassBook {
  school: string;
  group: { id: string; name: string; kind: string };
  from: string;
  to: string;
  timezone: string;
  /** The class's active pupils now. */
  pupils: number;
  lessons: ClassBookLesson[];
}

/** What the family's week shows too: RESCHEDULED is a status nothing writes, and nobody is shown it. */
const SHOWN_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;

export const CLASS_BOOK_RANGE = 'CLASS_BOOK_RANGE';
export const CLASS_BOOK_GROUP_NOT_FOUND = 'CLASS_BOOK_GROUP_NOT_FOUND';
export const CLASS_BOOK_MAX_DAYS = 200;

@Injectable()
export class ClassBookService {
  constructor(private readonly prisma: PrismaService) {}

  async classBook(query: ClassBookQueryDto, user: AuthenticatedUser): Promise<ClassBook> {
    const schoolId = requireSchoolId(user);
    assertRange(query.from, query.to, CLASS_BOOK_MAX_DAYS, CLASS_BOOK_RANGE);
    const dates = { gte: dayDate(query.from), lte: dayDate(query.to) };

    return this.prisma.withRls(user, async (tx) => {
      const group = await tx.studentGroup.findFirst({
        where: { id: query.groupId, schoolId },
        select: { id: true, name: true, kind: true, school: { select: { name: true } } },
      });
      if (!group) throw new NotFoundException({ message: 'Klassen finns inte.', code: CLASS_BOOK_GROUP_NOT_FOUND });
      const timezone = await schoolTimezone(tx, schoolId);
      const isClass = group.kind === 'CLASS';

      const pupils = isClass
        ? ((await tx.user.findMany({
            where: { studentGroupId: group.id, role: 'STUDENT', isActive: true },
            select: { id: true },
          })) ?? []).map((row) => row.id)
        : [];

      // The groups whose lessons may hold the class's pupils: the class and
      // its pupils' teaching groups. The lessons naming a pupil come by the
      // participants arm of the same query.
      const groupIds = [group.id];
      if (pupils.length > 0) {
        const memberships =
          (await tx.studentGroupMember.findMany({
            where: { studentId: { in: pupils } },
            select: { studentGroupId: true },
            distinct: ['studentGroupId'],
          })) ?? [];
        for (const row of memberships) if (!groupIds.includes(row.studentGroupId)) groupIds.push(row.studentGroupId);
      }

      const candidates =
        (await tx.calendarLesson.findMany({
          where: {
            date: dates,
            status: { in: [...SHOWN_STATUSES] },
            OR: [
              { studentGroupId: { in: groupIds } },
              { extraGroups: { some: { studentGroupId: { in: groupIds } } } },
              ...(pupils.length > 0 ? [{ participants: { some: { studentId: { in: pupils } } } }] : []),
            ],
          },
          select: {
            id: true,
            date: true,
            startsAt: true,
            endsAt: true,
            status: true,
            // The roster reader's: a replacing group takes its pupils off its subject.
            subjectId: true,
            studentGroupId: true,
            subject: { select: { name: true } },
            studentGroup: { select: { name: true } },
            extraGroups: { select: { studentGroupId: true, studentGroup: { select: { name: true } } } },
            room: { select: { name: true } },
            teachers: {
              select: { role: true, teacher: { select: { firstName: true, lastName: true } } },
              orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
            },
          },
          orderBy: [{ startsAt: 'asc' }, { endsAt: 'asc' }, { id: 'asc' }],
        })) ?? [];

      const own = (lesson: (typeof candidates)[number]) =>
        lesson.studentGroupId === group.id || lesson.extraGroups.some((row) => row.studentGroupId === group.id);
      const others = candidates.filter((lesson) => !own(lesson));
      const rosters =
        others.length > 0 && pupils.length > 0
          ? await calendarLessonRosters(tx, others, { pupils: 'ACTIVE', among: pupils })
          : new Map<string, Set<string>>();
      const lessons = candidates.filter((lesson) => own(lesson) || (rosters.get(lesson.id)?.size ?? 0) > 0);

      const logs =
        lessons.length === 0
          ? []
          : ((await tx.lessonLog.findMany({
              where: { calendarLessonId: { in: lessons.map((lesson) => lesson.id) } },
              select: { calendarLessonId: true, topic: true, homework: true, updatedAt: true },
            })) ?? []);
      const logOf = new Map(logs.map((log) => [log.calendarLessonId, log]));

      return {
        school: group.school.name,
        group: { id: group.id, name: group.name, kind: group.kind },
        from: query.from,
        to: query.to,
        timezone,
        pupils: pupils.length,
        lessons: lessons.map((lesson) => ({
          id: lesson.id,
          date: asDay(lesson.date),
          start: schoolClock(lesson.startsAt, timezone),
          end: schoolClock(lesson.endsAt, timezone),
          status: lesson.status,
          subject: lesson.subject.name,
          groups: [lesson.studentGroup.name, ...lesson.extraGroups.map((row) => row.studentGroup.name)],
          room: lesson.room?.name ?? null,
          teachers: lesson.teachers.map((row) => ({
            name: `${row.teacher.firstName} ${row.teacher.lastName}`.trim(),
            substitute: row.role === 'SUBSTITUTE',
          })),
          topic: logOf.get(lesson.id)?.topic ?? null,
          homework: logOf.get(lesson.id)?.homework ?? null,
          logUpdatedAt: logOf.get(lesson.id)?.updatedAt.toISOString() ?? null,
          attending: own(lesson) ? null : (rosters.get(lesson.id)?.size ?? 0),
        })),
      };
    });
  }
}
