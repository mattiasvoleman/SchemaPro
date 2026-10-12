import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * WHO ATTENDS A LESSON: one reader, for every caller.
 *
 * A lesson's roster is the union of three sources:
 *
 *   1. the home-class pupils (Users.studentGroupId) of the lesson's own class
 *      and of every group joined to it (CalendarLessonGroups,
 *      MasterLessonGroups);
 *   2. the teaching-group members (StudentGroupMembers) of those same groups:
 *      a nivågrupp or a språkval group has no home-class pupils at all, its
 *      roster lives entirely here;
 *   3. the pupils named on the lesson itself (CalendarLessonStudents,
 *      MasterLessonStudents).
 *
 * The attendance check asks it, and so do the register's list (GET
 * attendance/lessons/:id/roster), the teacher app's broadcast of a changed
 * lesson (realtime.service.ts) and every notice about a lesson: the day
 * operations (cancel, reinstate, vikarie, room), the cover board, a
 * master-lesson edit, a DRAFT publish and the avbokning digest. Before it,
 * the notices read the home class alone (User.studentGroupId), so a lesson
 * taught to a teaching group told nobody in it, and a pupil named on a
 * lesson heard nothing. A later phase that changes who attends a lesson (a
 * SvA pupil who leaves class svenska) changes it here, once, and the
 * register, the broadcast and the notices keep agreeing.
 *
 * Its basis is CURRENT (roster-readers.inventory.spec.ts): real people at
 * dated lessons, read as they are now. It writes no row itself, but its
 * callers write attendance and tell people, and nobody is told about next
 * year's class before the activation.
 *
 * Every read runs inside the caller's RLS transaction. A cross-tenant id is
 * simply absent from the results.
 */

/** The parts of a lesson that decide who attends it. */
export interface RosterScope {
  /** The lesson's own class and every group joined to it. */
  groupIds: readonly string[];
  /** Pupils named on the lesson itself. */
  participantIds: readonly string[];
}

export interface RosterOptions {
  /**
   * 'ACTIVE': active STUDENT rows only, which is who is told.
   *
   * 'RECORDED': membership as recorded, whatever the person's role and
   * status, which is what a register may name. A batch queued on a teacher's
   * phone must still drain after the pupil has been deactivated, and being
   * wrongly listed in a group is a catalogue problem, not a forged register.
   */
  pupils: 'ACTIVE' | 'RECORDED';
  /**
   * Ask only about these pupils (the attendance check): each answer is a
   * subset of them. A register is capped at 200 entries and a day's absences
   * are few, while a joint activity spanning several classes is not, so the
   * check never fetches the whole roster.
   */
  among?: readonly string[];
}

type Tx = Prisma.TransactionClient | PrismaClient;

/** Who is told: an active pupil. */
const PUPIL = { role: 'STUDENT', isActive: true } as const;

/** A calendar lesson as the readers below take it: its class and the groups joined to it. */
export interface CalendarRosterLesson {
  id: string;
  studentGroupId: string;
  extraGroups: readonly { studentGroupId: string }[];
}

/** A lesson with its named pupils already in hand (a requireLesson row, a master or a published master). */
export function scopeOf(lesson: {
  studentGroupId: string;
  extraGroups?: readonly { studentGroupId: string }[];
  participants?: readonly { studentId: string }[];
}): RosterScope {
  return {
    groupIds: [lesson.studentGroupId, ...(lesson.extraGroups ?? []).map((group) => group.studentGroupId)],
    participantIds: (lesson.participants ?? []).map((row) => row.studentId),
  };
}

/**
 * The roster of each scope, in the order given. Three statements however
 * many lessons there are (home classes, teaching-group members, and, for
 * ACTIVE, which named pupils are active pupils): an avbokning of a whole
 * school's week asks no more than one lesson does.
 */
export async function rostersOf(tx: Tx, scopes: readonly RosterScope[], options: RosterOptions): Promise<Set<string>[]> {
  const among = options.among ? new Set(options.among) : null;
  if (scopes.length === 0 || (among && among.size === 0)) return scopes.map(() => new Set<string>());
  const groupIds = [...new Set(scopes.flatMap((scope) => scope.groupIds))];
  const named = [...new Set(scopes.flatMap((scope) => scope.participantIds))].filter((id) => !among || among.has(id));
  const active = options.pupils === 'ACTIVE';
  const asked = among ? { in: [...among] } : undefined;

  const homeClass =
    groupIds.length === 0
      ? []
      : ((await tx.user.findMany({
          where: {
            studentGroupId: { in: groupIds },
            ...(asked ? { id: asked } : {}),
            ...(active ? PUPIL : {}),
          },
          select: { id: true, studentGroupId: true },
        })) ?? []);
  const teachingGroups =
    groupIds.length === 0
      ? []
      : ((await tx.studentGroupMember.findMany({
          where: {
            studentGroupId: { in: groupIds },
            ...(asked ? { studentId: asked } : {}),
            ...(active ? { student: PUPIL } : {}),
          },
          select: { studentId: true, studentGroupId: true },
        })) ?? []);
  const namedPupils =
    !active || named.length === 0
      ? new Set(named)
      : new Set(
          ((await tx.user.findMany({ where: { id: { in: named }, ...PUPIL }, select: { id: true } })) ?? []).map(
            (row) => row.id,
          ),
        );

  const byGroup = new Map<string, string[]>();
  const add = (groupId: string | null, studentId: string) => {
    if (groupId === null) return;
    const list = byGroup.get(groupId);
    if (list) list.push(studentId);
    else byGroup.set(groupId, [studentId]);
  };
  for (const row of homeClass) add(row.studentGroupId, row.id);
  for (const row of teachingGroups) add(row.studentGroupId, row.studentId);

  return scopes.map((scope) => {
    const roster = new Set<string>();
    for (const groupId of scope.groupIds) for (const studentId of byGroup.get(groupId) ?? []) roster.add(studentId);
    for (const studentId of scope.participantIds) if (namedPupils.has(studentId)) roster.add(studentId);
    return roster;
  });
}

/**
 * Calendar lessons' rosters by lesson id, their named pupils read in one
 * statement (only those of `among`, when given).
 */
export async function calendarLessonRosters(
  tx: Tx,
  lessons: readonly CalendarRosterLesson[],
  options: RosterOptions,
): Promise<Map<string, Set<string>>> {
  if (lessons.length === 0) return new Map();
  if (options.among && options.among.length === 0) return new Map(lessons.map((lesson) => [lesson.id, new Set<string>()]));
  const participants =
    (await tx.calendarLessonStudent.findMany({
      where: {
        calendarLessonId: { in: lessons.map((lesson) => lesson.id) },
        ...(options.among ? { studentId: { in: [...options.among] } } : {}),
      },
      select: { calendarLessonId: true, studentId: true },
    })) ?? [];
  const named = new Map<string, { studentId: string }[]>();
  for (const row of participants) named.set(row.calendarLessonId, [...(named.get(row.calendarLessonId) ?? []), row]);
  const rosters = await rostersOf(
    tx,
    lessons.map((lesson) => scopeOf({ ...lesson, participants: named.get(lesson.id) ?? [] })),
    options,
  );
  return new Map(lessons.map((lesson, index) => [lesson.id, rosters[index]!]));
}
