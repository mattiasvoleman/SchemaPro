import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { unstaffedRequirementsWhere } from '../staffing/unstaffed-requirements';
import { PrismaService } from '../database/prisma.service';
import { assess, type IntakeFacts, type IntakeView, type Named } from './intake';

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

// Every name, and never the first few in the order the database happened to give them: `assess` sorts them the way the page reads them (sv, numeric
// 7A before 10A) and then takes the first ITEM_CAP, so the card lists the first classes by name and not an arbitrary eight of them.
const named = (rows: readonly { name: string }[]): Named => ({ count: rows.length, names: rows.map((row) => row.name) });

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
  const [classes, teachingGroups, spanlessGroups, withoutPost, subjectsWithoutPost, needingMissingRoomType, timplans, requirements, unstaffed, posts, withoutSignature, withoutPostTeachers] =
    await Promise.all([
      tx.studentGroup.findMany({ where: { academicYearId, kind: 'CLASS' }, select: { name: true, gradeLevel: true } }),
      tx.studentGroup.count({ where: { academicYearId, kind: 'TEACHING_GROUP' } }),
      // The groups Generera binds to no årskurs: the gateway's own "spanless" (gradeSpanOf, shown on Generera as noYearTitle). A group the
      // timplan names whose year cannot be derived: no pupil sits in a class that has one, and the group has none of its own. A half is made
      // with its class's årskurs (student-groups.service.ts), and is planned before its pupils are placed: an empty half is not unbound.
      tx.studentGroup.findMany({
        where: {
          academicYearId,
          kind: 'TEACHING_GROUP',
          gradeLevel: null,
          teachingRequirements: { some: { academicYearId } },
          teachingMembers: { none: { student: { studentGroup: { gradeLevel: { not: null } } } } },
        },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      classesWithoutPosts(tx, academicYearId),
      tx.subject.findMany({ where: { teachingRequirements: { none: { academicYearId } } }, select: { name: true }, orderBy: { name: 'asc' } }),
      // A post of the year that asks for a room type no room has: the engine refuses it by name (ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT).
      // The same refusal has two more causes this does not count: no room big enough for the group, and no room for its årskurser.
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
      // The rows Generera's pre-flight and the publish gate call unstaffed: no lead, or a share nobody teaches (one predicate, theirs).
      tx.teachingRequirement.count({ where: unstaffedRequirementsWhere(academicYearId) }),
      tx.teacherEmployment.count({ where: { academicYearId } }),
      // The table refuses an empty signature (TeacherEmployments_signature_is_sane): no signature is a null.
      tx.teacherEmployment.count({ where: { academicYearId, signature: null } }),
      tx.user.count({ where: { ...TEACHES, employments: { none: { academicYearId } } } }),
    ]);

  const noGrade = classes.filter((row) => row.gradeLevel === null);
  return {
    ...school,
    year,
    subjectsWithoutPost: named(subjectsWithoutPost),
    subjectsNeedingMissingRoomType: named(needingMissingRoomType),
    classes: classes.length,
    classGrades: classes.map((row) => row.gradeLevel),
    classesWithoutGrade: named(noGrade),
    classesWithoutPost: withoutPost,
    teachingGroups,
    teachingGroupsWithoutMembers: named(spanlessGroups),
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
  // The classes the year's posts reach, found once from the posts and not once per class: an OR between a class's own post and a subselect
  // over its halves cannot be hashed, so the planner nested-looped every class against every post (300 classes and 10 000 posts: 0,45 s,
  // against 0,015 s from this shape, the same classes). The three ways a class is reached are the three arms of `reached`.
  const rows = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
    WITH posts AS MATERIALIZED (
      SELECT r."studentGroupId" AS "groupId" FROM "TeachingRequirements" r WHERE r."academicYearId" = ${academicYearId}::uuid
    ),
    reached AS (
      -- a post of the class's own
      SELECT p."groupId" AS "classId" FROM posts p
      UNION
      -- a post of one of its halves
      SELECT h."halfOfId" FROM "StudentGroups" h JOIN posts p ON p."groupId" = h."id" WHERE h."halfOfId" IS NOT NULL
      UNION
      -- a post of a teaching group one of its pupils sits in
      SELECT u."studentGroupId"
      FROM "Users" u
      JOIN "StudentGroupMembers" m ON m."studentId" = u."id"
      JOIN posts p ON p."groupId" = m."studentGroupId"
      WHERE u."studentGroupId" IS NOT NULL
    )
    SELECT g."name"
    FROM "StudentGroups" g
    WHERE g."academicYearId" = ${academicYearId}::uuid
      AND g."kind" = 'CLASS'
      AND NOT EXISTS (SELECT 1 FROM reached x WHERE x."classId" = g."id")
    ORDER BY g."name"
  `);
  return named(rows);
}
