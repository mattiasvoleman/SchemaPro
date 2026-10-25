import type { Prisma, PrismaClient } from '@prisma/client';
import { keptByOf, replacedPupils, replacingBySubject, yearsOf } from '../common/replacing-groups';

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
 *      MasterLessonStudents);
 *
 * less, for ACTIVE, the pupils a replacing group takes off it (Ersättande
 * grupper, common/replacing-groups.ts): a member of a group replacing the
 * lesson's subject (SvA7 replaces Svenska), in the läsår of the lesson's own
 * group, none of whose groups replacing it is on the lesson, who is not in
 * the lesson's own teaching group and not named on it. So 7A's svenska does
 * not list 7A's SvA pupils, and the register, the notices and the broadcast
 * agree that they are at SvA. RECORDED takes nobody off (see RosterOptions),
 * and a lesson whose own group's läsår cannot be read takes nobody off
 * either: no answer is better than last year's.
 *
 * The attendance check asks it, and so do the register's list (GET
 * attendance/lessons/:id/roster, which the web register and the teacher app
 * both ask), the teacher app's broadcast of a changed lesson
 * (realtime.service.ts) and every notice about a lesson: the day
 * operations (cancel, reinstate, vikarie, room), the cover board, a
 * master-lesson edit, a DRAFT publish and the avbokning digest. Before it,
 * the notices read the home class alone (User.studentGroupId), so a lesson
 * taught to a teaching group told nobody in it, and a pupil named on a
 * lesson heard nothing. A later phase that changes who attends a lesson (a
 * SvA pupil who leaves class svenska) changes it here, once, and the
 * register, the broadcast and the notices keep agreeing — as Ersättande
 * grupper did.
 *
 * Its basis is CURRENT (roster-readers.inventory.spec.ts): real people at
 * dated lessons, read as they are now. It writes no row itself, but its
 * callers write attendance and tell people, and nobody is told about next
 * year's class before the activation.
 *
 * Every read runs inside the caller's RLS transaction. A cross-tenant id is
 * simply absent from the results. Under a pupil's RLS a teaching group's own
 * row is not readable (student_groups_student_select shows the home class
 * only), so no replacing group is found and none is applied: the pupil's
 * lesson reads are already narrowed by RLS (20261211090000), so a lesson the
 * rule takes them off never reaches this reader in the first place.
 */

/** The parts of a lesson that decide who attends it. */
export interface RosterScope {
  /**
   * The lesson's subject: a replacing group takes its members off its
   * subject's other lessons. Required, so a caller cannot forget it and list
   * SvA pupils on class svenska.
   */
  subjectId: string;
  /** The lesson's own class first, then every group joined to it. */
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
   * It is a superset of ACTIVE: no replacing group takes anyone off it. A
   * membership carries no dates, so marking SvA7 as replacing Svenska would
   * otherwise refuse every queued batch and every correction naming its
   * pupils on class svenska, past lessons included, while the marks already
   * made still count in reports and SS12000.
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
  subjectId: string;
  studentGroupId: string;
  extraGroups: readonly { studentGroupId: string }[];
}

/** A lesson with its named pupils already in hand (a requireLesson row, a master or a published master). */
export function scopeOf(lesson: {
  subjectId: string;
  studentGroupId: string;
  extraGroups?: readonly { studentGroupId: string }[];
  participants?: readonly { studentId: string }[];
}): RosterScope {
  return {
    subjectId: lesson.subjectId,
    groupIds: [lesson.studentGroupId, ...(lesson.extraGroups ?? []).map((group) => group.studentGroupId)],
    participantIds: (lesson.participants ?? []).map((row) => row.studentId),
  };
}

/**
 * The roster of each scope, in the order given. Two statements however
 * many lessons there are (home classes and teaching-group members), and for
 * ACTIVE two more (which named pupils are active pupils, and the groups
 * replacing the scopes' subjects) and another two only when a replacing
 * group exists (its members, and the scopes' own groups): an avbokning of a
 * whole school's week asks no more than one lesson does.
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

  // Ersättande grupper: the groups replacing a scope's subject, and their
  // members among the asked. A school with none reads one empty answer and
  // gets the rosters it got before.
  const subjectIds = [...new Set(scopes.map((scope) => scope.subjectId))];
  const replacing = !active
    ? []
    : (((await tx.studentGroup.findMany({
        where: { replacesSubjectId: { in: subjectIds } },
        select: { id: true, replacesSubjectId: true, academicYearId: true },
      })) ?? []) as { id: string; replacesSubjectId: string | null; academicYearId: string }[]);
  // Each scope's own group: its läsår, beside the replacing groups' own (a
  // group replacing Svenska last year takes nobody off this year's svenska;
  // the rollover keeps last year's memberships as history), and whether it is
  // a teaching group whose members keep the lesson (keptByOf). Read only when
  // some group replaces a scope's subject.
  const ownGroups =
    replacing.length === 0
      ? []
      : (((await tx.studentGroup.findMany({
          where: { id: { in: [...new Set(scopes.map((scope) => scope.groupIds[0]).filter((id): id is string => !!id))] } },
          select: { id: true, academicYearId: true, kind: true, halfOfId: true },
        })) ?? []) as { id: string; academicYearId: string; kind: string; halfOfId: string | null }[]);
  const yearOf = yearsOf([...replacing, ...ownGroups]);
  const ownById = new Map(ownGroups.map((group) => [group.id, group]));
  const replacingMembers =
    replacing.length === 0
      ? []
      : ((await tx.studentGroupMember.findMany({
          where: { studentGroupId: { in: replacing.map((group) => group.id) }, ...(asked ? { studentId: asked } : {}) },
          select: { studentId: true, studentGroupId: true },
        })) ?? []);
  const bySubject = replacingBySubject(
    new Map(replacing.flatMap((group) => (group.replacesSubjectId ? [[group.id, group.replacesSubjectId] as const] : []))),
  );
  const membersOfReplacing = new Map<string, Set<string>>();
  for (const row of replacingMembers) {
    const members = membersOfReplacing.get(row.studentGroupId);
    if (members) members.add(row.studentId);
    else membersOfReplacing.set(row.studentGroupId, new Set([row.studentId]));
  }

  const byGroup = new Map<string, string[]>();
  const add = (groupId: string | null, studentId: string) => {
    if (groupId === null) return;
    const list = byGroup.get(groupId);
    if (list) list.push(studentId);
    else byGroup.set(groupId, [studentId]);
  };
  for (const row of homeClass) add(row.studentGroupId, row.id);
  for (const row of teachingGroups) add(row.studentGroupId, row.studentId);
  const membersOfTeaching = new Map<string, Set<string>>();
  for (const row of teachingGroups) {
    const members = membersOfTeaching.get(row.studentGroupId);
    if (members) members.add(row.studentId);
    else membersOfTeaching.set(row.studentGroupId, new Set([row.studentId]));
  }

  return scopes.map((scope) => {
    const roster = new Set<string>();
    for (const groupId of scope.groupIds) for (const studentId of byGroup.get(groupId) ?? []) roster.add(studentId);
    for (const studentId of scope.participantIds) if (namedPupils.has(studentId)) roster.add(studentId);
    const own = scope.groupIds[0];
    const year = own === undefined ? undefined : yearOf.get(own);
    if (replacing.length > 0 && year !== undefined) {
      const keptBy = keptByOf(ownById.get(own!));
      const membersOf =
        keptBy === undefined
          ? membersOfReplacing
          : new Map([...membersOfReplacing, [keptBy, membersOfTeaching.get(keptBy) ?? new Set<string>()]]);
      for (const studentId of replacedPupils(
        roster,
        { ...scope, academicYearId: year, ...(keptBy === undefined ? {} : { keptBy }) },
        new Set(scope.participantIds),
        bySubject,
        membersOf,
        yearOf,
      )) {
        roster.delete(studentId);
      }
    }
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
