import type { PrismaClient } from '@prisma/client';
import {
  readHomeClassesOf,
  readHomePupils,
  type RosterBasis,
} from '../year-rollover/projected-rosters';

/**
 * What a lesson asks of a room: how many bodies, which years, which kind.
 *
 * ONE derivation, called from both payloads that put a lesson in a room: the
 * generator's (optimization-proxy.service.ts) and the room optimisation's
 * (room-optimization.service.ts). The second may only MOVE a lesson into a
 * room the first would have allowed — the engine reuses the generator's own
 * eligibility rule for exactly that reason — and the rule is only as shared as
 * its inputs. Two ways of counting 7A would drift the first time either is
 * fixed, and the drift would surface as the room optimisation putting a class
 * in a room the generator refuses it, or refusing one the generator would use.
 */

export interface Rosters {
  /** groupId -> its active students, home class and teaching group alike. */
  membersByGroup: Map<string, Set<string>>;
  /** studentId -> every group holding them. */
  groupsByStudent: Map<string, Set<string>>;
  /** Students whose HOME class is one of the groups, exactly as read. */
  homeMembers: { id: string; studentGroupId: string | null }[];
  /** studentId -> home class, for every student reached. */
  homeClassOf: Map<string, string | null>;
  /** groupId -> the year the group itself carries, where it carries one. */
  gradeOfGroup: Map<string, number | null>;
}

/**
 * Who sits in which group, from BOTH membership kinds: the home class
 * (Users.studentGroupId) and teaching groups (StudentGroupMembers).
 *
 * Only aggregates and id-relations derived from this ever leave the gateway —
 * student ids themselves are never sent to the engine.
 *
 * `namedStudentIds` are pupils a lesson names one by one. They sit in no group
 * the lesson carries, so their home class has to be read here too, or a pupil
 * on a lesson alone would have no year at all.
 *
 * `basis` is the year's (projected-rosters.ts): for a rolled year not yet
 * activated the home classes are the ones its activation would write, so 8A
 * holds 7A's pupils and Ma8's members have 8A as their home class. Required,
 * never defaulted — a forgotten basis would silently read empty classes.
 */
export async function loadRosters(
  tx: PrismaClient,
  basis: RosterBasis,
  groupIds: string[],
  groups: { id: string; gradeLevel: number | null }[],
  namedStudentIds: Iterable<string> = [],
): Promise<Rosters> {
  const [homeMembers, teachingMembers] = await Promise.all([
    readHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, groupIds),
    tx.studentGroupMember.findMany({
      where: {
        studentGroupId: { in: groupIds },
        student: { role: 'STUDENT', isActive: true },
      },
      select: { studentId: true, studentGroupId: true },
    }),
  ]);

  const groupsByStudent = new Map<string, Set<string>>();
  const membersByGroup = new Map<string, Set<string>>();
  const link = (studentId: string, groupId: string | null) => {
    if (!groupId) return;
    let memberships = groupsByStudent.get(studentId);
    if (!memberships) groupsByStudent.set(studentId, (memberships = new Set()));
    memberships.add(groupId);
    let members = membersByGroup.get(groupId);
    if (!members) membersByGroup.set(groupId, (members = new Set()));
    members.add(studentId);
  };
  for (const row of homeMembers) link(row.id, row.studentGroupId);
  for (const row of teachingMembers) link(row.studentId, row.studentGroupId);

  const involvedStudentIds = [
    ...new Set([...groupsByStudent.keys(), ...namedStudentIds]),
  ];
  const studentHomeClasses =
    involvedStudentIds.length > 0
      ? await readHomeClassesOf(tx, basis, involvedStudentIds)
      : ([] as { id: string; studentGroupId: string | null }[]);

  return {
    membersByGroup,
    groupsByStudent,
    homeMembers,
    homeClassOf: new Map(
      studentHomeClasses.map((student) => [student.id, student.studentGroupId]),
    ),
    gradeOfGroup: new Map(groups.map((group) => [group.id, group.gradeLevel])),
  };
}

/**
 * The years a set of groups (and named pupils) actually holds.
 *
 * Derived from the students' HOME classes rather than read off the group: a
 * teaching group carries no gradeLevel of its own, and treating it as
 * unrestricted would let a nionde-group into lågstadiets rooms. A span covering
 * several years takes the whole span, so a room must cover all of it — half a
 * group in an allowed year is not an allowed placement.
 *
 * With no member carrying a year, the groups' own years stand in: a class
 * created before its students are enrolled still carries one, and skipping it
 * would let 7B into lågstadiets rooms until somebody adds the first student.
 * Null when there is none at all, rather than an invented one.
 */
export function gradeSpanOf(
  rosters: Rosters,
  groupIds: string[],
  studentIds: string[] = [],
): { min: number; max: number } | null {
  const grades: number[] = [];
  for (const studentId of attendees(rosters, groupIds, studentIds)) {
    const homeClass = rosters.homeClassOf.get(studentId);
    const grade = homeClass ? rosters.gradeOfGroup.get(homeClass) : null;
    if (typeof grade === 'number') grades.push(grade);
  }
  if (grades.length === 0) {
    for (const groupId of groupIds) {
      const own = rosters.gradeOfGroup.get(groupId);
      if (typeof own === 'number') grades.push(own);
    }
  }
  return grades.length > 0
    ? { min: Math.min(...grades), max: Math.max(...grades) }
    : null;
}

export interface RoomNeeds {
  /** Distinct pupils, never below one: an empty group still needs a chair. */
  studentGroupSize: number;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** The REAL room-type id; each payload anonymises it through its own map. */
  requiredRoomTypeId: string | null;
}

/**
 * Everything a room must satisfy to take a lesson for these groups and pupils.
 *
 * Several groups count their pupils once: a pupil in both 7A and Ma71 takes one
 * chair. A requirement has exactly one group and no named pupils, so for the
 * generator this is the headcount of that one group, as it always was.
 */
export function roomNeedsOf(
  rosters: Rosters,
  attendance: { groupIds: string[]; studentIds?: string[] },
  subject: { requiredRoomTypeId: string | null },
): RoomNeeds {
  const studentIds = attendance.studentIds ?? [];
  const span = gradeSpanOf(rosters, attendance.groupIds, studentIds);
  return {
    studentGroupSize: Math.max(
      1,
      attendees(rosters, attendance.groupIds, studentIds).size,
    ),
    minGradeLevel: span?.min ?? null,
    maxGradeLevel: span?.max ?? null,
    requiredRoomTypeId: subject.requiredRoomTypeId,
  };
}

function attendees(
  rosters: Rosters,
  groupIds: string[],
  studentIds: string[],
): Set<string> {
  const everyone = new Set<string>(studentIds);
  for (const groupId of groupIds) {
    for (const studentId of rosters.membersByGroup.get(groupId) ?? []) {
      everyone.add(studentId);
    }
  }
  return everyone;
}
