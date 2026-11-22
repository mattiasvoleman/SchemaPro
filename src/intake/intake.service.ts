import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { assess, ITEM_CAP, type IntakeFacts, type IntakeView, type Named } from './intake';

/**
 * Vad kom in (/admin/intake): the school's base data counted against what Generera and the steps after it ask for.
 *
 * READ ONLY, and COUNTS ONLY. Nothing here selects a person's name, an e-mail address, a percentage of a post or a
 * signature: a person is a row to count and a post is a row that exists. What is named is a class, a subject, an
 * årskurs. The read runs as the person asking, under row security, so the answer is what that person's role sees of the
 * school: an administrator of any profile reads every table counted here (the tjänst's percentage is hidden from a
 * profile without HR-läs by the gateway, and never leaves here at all).
 *
 * The rules that decide what is a gap, and how hard, are intake.ts's. This reads the facts.
 */
@Injectable()
export class IntakeService {
  constructor(private readonly prisma: PrismaService) {}

  /** The school's active läsår, and its base data. */
  async read(user: AuthenticatedUser): Promise<IntakeView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => assess(await readFacts(tx, schoolId)));
  }
}

/** Who teaches: a teacher, or an administrator marked as one (Users.teaches). */
const TEACHES = { isActive: true, OR: [{ role: 'TEACHER' as const }, { role: 'SCHOOL_ADMIN' as const, teaches: true }] };

const named = (rows: readonly { name: string }[]): Named => ({ count: rows.length, names: rows.slice(0, ITEM_CAP).map((row) => row.name) });

/**
 * Every fact `assess` needs, read in one transaction. Exported for the database probe, which reads the same facts from a
 * school it builds; nothing else calls it.
 */
export async function readFacts(tx: PrismaClient, schoolId: string): Promise<IntakeFacts> {
  // The ACTIVE year only: the pupils of a year that is rolled and not yet activated are still in the old classes, and what the
  // school holds now is not what that year will hold (the roster-readers inventory classifies this file CURRENT, on purpose).
  const year = await tx.academicYear.findFirst({ where: { isActive: true }, select: { id: true, name: true, isActive: true, gradeNumbering: true } });

  const [years, subjects, rooms, rasts, frameTimes, teachers, students, studentsWithoutClass, policy] = await Promise.all([
    tx.academicYear.count(),
    tx.subject.count(),
    tx.room.count(),
    tx.rast.count(),
    tx.frameTime.findMany({ select: { minGradeLevel: true, maxGradeLevel: true } }),
    tx.user.count({ where: TEACHES }),
    tx.user.count({ where: { role: 'STUDENT', isActive: true } }),
    tx.user.count({ where: { role: 'STUDENT', isActive: true, studentGroupId: null } }),
    tx.staffingPolicy.findUnique({ where: { schoolId }, select: { unstaffedGeneration: true } }),
  ]);

  const school = {
    years,
    subjects,
    rooms,
    frameTimes,
    rasts,
    teachers,
    students,
    studentsWithoutClass,
    unstaffedMode: (policy?.unstaffedGeneration === 'REFUSE' ? 'REFUSE' : 'ALLOW') as IntakeFacts['unstaffedMode'],
  };

  const empty: Named = { count: 0, names: [] };
  if (year === null) {
    return {
      ...school,
      year: null,
      subjectsWithoutPost: empty,
      subjectsNeedingMissingRoomType: empty,
      classes: 0,
      classGrades: [],
      classesWithoutGrade: empty,
      classesWithoutPost: empty,
      teachingGroups: 0,
      teachingGroupsWithoutMembers: empty,
      timplanGrades: [],
      requirements: 0,
      unstaffedRequirements: 0,
      posts: 0,
      postsWithoutSignature: 0,
      teachersWithoutPost: 0,
    };
  }

  const academicYearId = year.id;
  const [classes, groups, withoutPost, subjectsWithoutPost, needingMissingRoomType, timplans, requirements, unstaffed, posts, withoutSignature, withoutPostTeachers] =
    await Promise.all([
      tx.studentGroup.findMany({ where: { academicYearId, kind: 'CLASS' }, select: { name: true, gradeLevel: true } }),
      tx.studentGroup.findMany({
        where: { academicYearId, kind: 'TEACHING_GROUP' },
        select: { name: true, _count: { select: { teachingMembers: true } } },
      }),
      classesWithoutPosts(tx, academicYearId),
      tx.subject.findMany({ where: { teachingRequirements: { none: { academicYearId } } }, select: { name: true }, orderBy: { name: 'asc' } }),
      // A post of the year that asks for a room type no room has: the engine refuses it by name (ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT).
      tx.subject.findMany({
        where: {
          requiredRoomTypeId: { not: null },
          requiredRoomType: { rooms: { none: {} } },
          teachingRequirements: { some: { academicYearId } },
        },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      tx.academicYearTimplan.findMany({ where: { academicYearId }, select: { gradeLevel: true, localTimplan: { select: { status: true } } } }),
      tx.teachingRequirement.count({ where: { academicYearId } }),
      tx.teachingRequirement.count({ where: { academicYearId, teacherId: null } }),
      tx.teacherEmployment.count({ where: { academicYearId } }),
      // The table refuses an empty signature (TeacherEmployments_signature_is_sane): no signature is a null.
      tx.teacherEmployment.count({ where: { academicYearId, signature: null } }),
      tx.user.count({ where: { ...TEACHES, employments: { none: { academicYearId } } } }),
    ]);

  const noGrade = classes.filter((row) => row.gradeLevel === null);
  const emptyGroups = groups.filter((row) => row._count.teachingMembers === 0);
  return {
    ...school,
    year,
    subjectsWithoutPost: named(subjectsWithoutPost),
    subjectsNeedingMissingRoomType: named(needingMissingRoomType),
    classes: classes.length,
    classGrades: classes.map((row) => row.gradeLevel),
    classesWithoutGrade: named(noGrade),
    classesWithoutPost: withoutPost,
    teachingGroups: groups.length,
    teachingGroupsWithoutMembers: named(emptyGroups),
    timplanGrades: timplans.map((row) => ({ gradeLevel: row.gradeLevel, decided: row.localTimplan.status === 'DECIDED' })),
    requirements,
    unstaffedRequirements: unstaffed,
    posts,
    postsWithoutSignature: withoutSignature,
    teachersWithoutPost: withoutPostTeachers,
  };
}

/**
 * The classes the year's timplansposter give nothing to. A class has a post when it has one of its own, when a half of
 * it has one, or when a pupil of it sits in a teaching group that has one: a högstadium gives nearly every subject in
 * groups that cut across the classes, and a class that has no post of its own and every lesson in a group is not
 * unplanned. Only a class none of these reaches is listed.
 */
async function classesWithoutPosts(tx: PrismaClient, academicYearId: string): Promise<Named> {
  const rows = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT g."name"
    FROM "StudentGroups" g
    WHERE g."academicYearId" = ${academicYearId}::uuid
      AND g."kind" = 'CLASS'
      AND NOT EXISTS (
        SELECT 1 FROM "TeachingRequirements" r
        WHERE r."academicYearId" = ${academicYearId}::uuid
          AND (r."studentGroupId" = g."id"
               OR r."studentGroupId" IN (SELECT h."id" FROM "StudentGroups" h WHERE h."halfOfId" = g."id"))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "Users" u
        JOIN "StudentGroupMembers" m ON m."studentId" = u."id"
        JOIN "TeachingRequirements" r ON r."studentGroupId" = m."studentGroupId"
        WHERE u."studentGroupId" = g."id"
          AND r."academicYearId" = ${academicYearId}::uuid
      )
    ORDER BY g."name"
  `);
  return { count: rows.length, names: rows.slice(0, ITEM_CAP).map((row) => row.name) };
}
