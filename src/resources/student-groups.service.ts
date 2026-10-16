import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma, StudentGroup } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../access-log/access-log';
import { PrismaService } from '../database/prisma.service';
import { tellNewMentors } from '../family/leave-notices';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, studentGroupHasEnrolmentHistory } from '../common/utils/prisma-errors';
import type {
  CreateStudentGroupDto,
  PlaceHalvesDto,
  SetGroupMembersDto,
  SplitClassDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

/** The problem codes of "Dela klassen" and of placing pupils in halves. */
export const NOT_A_CLASS = 'NOT_A_CLASS';
export const CLASS_ALREADY_SPLIT = 'CLASS_ALREADY_SPLIT';
export const GROUP_NAME_TAKEN = 'GROUP_NAME_TAKEN';
export const NOT_THE_CLASS_HALVES = 'NOT_THE_CLASS_HALVES';
export const PUPIL_IN_TWO_HALVES = 'PUPIL_IN_TWO_HALVES';
export const PUPIL_NOT_IN_CLASS = 'PUPIL_NOT_IN_CLASS';

/**
 * The pupils a half of `theClass` may hold: the active pupils whose home
 * class is the class, or — a rolled läsår not yet activated — its
 * predecessor, whose pupils move into it at activation. The rule the trigger
 * app.student_group_members_in_the_class holds every writer to, read here
 * first so a refusal can say how many and of which class.
 */
async function pupilsOfTheClass(
  tx: Prisma.TransactionClient,
  theClass: { id: string; predecessorId: string | null },
): Promise<Set<string>> {
  const rows = await tx.user.findMany({
    where: {
      role: 'STUDENT',
      isActive: true,
      studentGroupId: { in: theClass.predecessorId ? [theClass.id, theClass.predecessorId] : [theClass.id] },
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/**
 * The pupils' rows FOR SHARE, in id order, before a placement touches a
 * membership row. A class change takes the pupil's row first and the
 * memberships after (the Users trigger leaves the old class's halves); a
 * placement that deleted a pupil's half row and only then met the pupil's
 * row (the member trigger reads it FOR SHARE) would take them the other way
 * round, and the two could deadlock. Held first, a class change waits for
 * the placement or the placement for it, and either sees the other's commit.
 */
async function holdPupils(tx: Prisma.TransactionClient, pupils: Iterable<string>): Promise<void> {
  const ids = [...pupils].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT 1 FROM "Users" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`;
}

function pupilsNotInClass(count: number, className: string): BadRequestException {
  return new BadRequestException({
    message: `${count === 1 ? 'En elev' : `${count} elever`} går inte i ${className} och kan inte placeras i klassens halvor.`,
    code: PUPIL_NOT_IN_CLASS,
  });
}

export interface GroupMember {
  id: string;
  firstName: string;
  lastName: string;
  homeGroupId: string | null;
}

/** One teaching-group membership: ids only. */
export interface GroupMembership {
  studentId: string;
  studentGroupId: string;
}

@Injectable()
export class StudentGroupsService {
  /**
   * NotificationsService is optional for the scripts and specs that build
   * this one by hand; without it an årskurs tells no mentor of the leave
   * requests it gives them (Nest always injects it).
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  async create(
    dto: CreateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            name: dto.name,
            kind: dto.kind ?? 'CLASS',
            gradeLevel: dto.gradeLevel ?? null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * A class that has class history (StudentEnrollments, timplan P4) keeps its
   * läsår: its pupils' segments are dated inside that year, and the history's
   * key to the class is ON UPDATE NO ACTION rather than carrying them into
   * another one. Asked first, so the 409 names the year; the key refuses a
   * race the same way (rethrowPrismaError). A class created in the wrong year
   * a minute ago has no history yet — a same-day placement leaves none once
   * the pupils are moved out — so it can still be moved.
   *
   * A class's årskurs is its pupils' årskurs in their class history, and a
   * lov spanning årskurser closes their days by it (app.leave_school_days).
   * A new årskurs may so bring a pending leave request within the
   * delegation (Mentorns ledighetsbeslut), and the update then tells the
   * mentors it gives a request, once each, in its own transaction.
   */
  async update(
    id: string,
    dto: UpdateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (dto.academicYearId !== undefined) {
          const current = await tx.studentGroup.findUnique({
            where: { id },
            select: { academicYearId: true, academicYear: { select: { name: true } } },
          });
          if (current && current.academicYearId !== dto.academicYearId) {
            const history = await tx.studentEnrollment.count({ where: { studentGroupId: id } });
            if (history > 0) throw studentGroupHasEnrolmentHistory(current.academicYear.name);
          }
        }
        const group = await tx.studentGroup.update({
          where: { id },
          data: {
            ...(dto.academicYearId !== undefined
              ? { academicYearId: dto.academicYearId }
              : {}),
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.gradeLevel !== undefined ? { gradeLevel: dto.gradeLevel } : {}),
          },
        });
        // A half is cut from its class (Halvklasser) and reads its class's
        // årskurs: frames, rasts, timplan and behörighet ask the half's own.
        if (dto.gradeLevel !== undefined && group.kind === 'CLASS') {
          await tx.studentGroup.updateMany({ where: { halfOfId: id }, data: { gradeLevel: dto.gradeLevel } });
        }
        if (this.notifications && dto.gradeLevel !== undefined) {
          await tellNewMentors(this.notifications, tx, group.schoolId);
        }
        return group;
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Teaching-group members (the M2M list — home-class members not included).
   * A ROSTER read in the läslogg, naming the members listed.
   */
  async listMembers(
    groupId: string,
    user: AuthenticatedUser,
  ): Promise<GroupMember[]> {
    const rows = await this.prisma.withRls(user, async (tx) => {
      const members = await tx.studentGroupMember.findMany({
        where: { studentGroupId: groupId },
        select: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              studentGroupId: true,
            },
          },
        },
        orderBy: { student: { lastName: 'asc' } },
      });
      await recordRead(tx, 'ROSTER', members.map((row) => row.student.id), user.channel);
      return members;
    });
    return rows.map((row) => ({
      id: row.student.id,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      homeGroupId: row.student.studentGroupId,
    }));
  }

  /**
   * Every teaching-group membership of the school, ids only: the planning
   * pages' grid of who is in which group (the web's useGroupMemberships, read
   * from PostgREST until Läslogg). A ROSTER read naming every pupil listed.
   * Unpaged: one row per pupil per group is a few thousand rows for a large
   * school, which the web paged through 1 000 at a time before.
   */
  async memberships(user: AuthenticatedUser): Promise<GroupMembership[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.studentGroupMember.findMany({
        select: { studentId: true, studentGroupId: true },
        orderBy: [{ studentGroupId: 'asc' }, { studentId: 'asc' }],
      });
      await recordRead(tx, 'ROSTER', rows.map((row) => row.studentId), user.channel);
      return rows;
    });
  }

  /**
   * "Dela klassen" (Halvklasser): two halves of a class, made as teaching
   * groups that name it (StudentGroup.halfOfId), in its year and årskurs.
   * Named "7A:1" and "7A:2" unless the school gives names.
   *
   * The class is held FOR NO KEY UPDATE first: two splits of one class at the
   * same moment would make four halves, and the second waits here and then
   * finds the halves the first made (409 CLASS_ALREADY_SPLIT). NO KEY, so the
   * halves' own foreign key (KEY SHARE on the class) never waits on it. The
   * names are asked of the year case-insensitively, as the importers and the
   * rollover read a name, and a name taken is a 409 naming it.
   */
  async split(classId: string, dto: SplitClassDto, user: AuthenticatedUser): Promise<StudentGroup[]> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "StudentGroups" WHERE "id" = ${classId}::uuid FOR NO KEY UPDATE`;
        const theClass = await tx.studentGroup.findUnique({
          where: { id: classId },
          select: {
            name: true,
            kind: true,
            academicYearId: true,
            gradeLevel: true,
            _count: { select: { halves: true } },
          },
        });
        if (!theClass) throw new NotFoundException('Student group not found.');
        if (theClass.kind !== 'CLASS') {
          throw new BadRequestException({ message: 'Bara en klass kan delas i halvor.', code: NOT_A_CLASS });
        }
        if (theClass._count.halves > 0) {
          throw new ConflictException({ message: `${theClass.name} är redan delad i halvor.`, code: CLASS_ALREADY_SPLIT });
        }
        const names = (dto.names ?? [`${theClass.name}:1`, `${theClass.name}:2`]).map((name) => name.trim());
        if (names.some((name) => name.length === 0) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
          throw new BadRequestException('names: två olika namn, ett för varje halva.');
        }
        const taken = await tx.studentGroup.findMany({
          where: {
            academicYearId: theClass.academicYearId,
            OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
          },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (taken.length > 0) {
          throw new ConflictException({
            message: `Läsåret har redan en grupp som heter ${taken.map((group) => group.name).join(' och ')}.`,
            code: GROUP_NAME_TAKEN,
          });
        }
        return tx.studentGroup.createManyAndReturn({
          data: names.map((name) => ({
            schoolId,
            academicYearId: theClass.academicYearId,
            name,
            kind: 'TEACHING_GROUP' as const,
            gradeLevel: theClass.gradeLevel,
            halfOfId: classId,
          })),
        });
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Which pupil of a class is in which of its halves: every half named, each
   * with its complete list, replacing the class's placement in one
   * transaction — so moving a pupil from 7A:1 to 7A:2 never meets the one-half
   * index halfway. A pupil in no list is unplaced, which is allowed: the
   * generator plans a half for the pupils it may still get (class-halves.ts).
   *
   * What is replaced is the placement of the pupils it judges, the class's
   * active pupils (pupilsOfTheClass), and nobody else's: the halves of a past
   * läsår keep their pupils, who are now in next year's class, as that year's
   * history (the Users trigger keeps them too), and an inactive pupil keeps
   * the half they were in. A list sent from a screen that never saw them
   * cannot take them out.
   *
   * Refused, before anything is written: a half not of this class, a half
   * left out, a pupil in two lists, and a pupil not of the class (see
   * pupilsOfTheClass). Answers counts only, so it is no read of anyone in the
   * läslogg's sense.
   *
   * The class is held FOR NO KEY UPDATE first, as split holds it: two
   * placements of one class saved at the same moment would each delete what
   * it saw and both insert, leaving a placement neither sent. The second
   * waits, and then replaces the first's.
   */
  async placeHalves(
    classId: string,
    dto: PlaceHalvesDto,
    user: AuthenticatedUser,
  ): Promise<{ placed: number; unplaced: number }> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "StudentGroups" WHERE "id" = ${classId}::uuid FOR NO KEY UPDATE`;
        const theClass = await tx.studentGroup.findUnique({
          where: { id: classId },
          select: { id: true, name: true, predecessorId: true, halves: { select: { id: true } } },
        });
        if (!theClass) throw new NotFoundException('Student group not found.');
        const halves = new Set(theClass.halves.map((half) => half.id));
        const named = dto.halves.map((half) => half.groupId);
        if (
          halves.size === 0 ||
          named.length !== halves.size ||
          new Set(named).size !== named.length ||
          named.some((id) => !halves.has(id))
        ) {
          throw new BadRequestException({
            message: `halves: alla ${theClass.name}s halvor, var och en en gång.`,
            code: NOT_THE_CLASS_HALVES,
          });
        }
        const placing = dto.halves.flatMap((half) => half.studentIds);
        if (new Set(placing).size !== placing.length) {
          throw new BadRequestException({
            message: 'En elev kan bara placeras i en av klassens halvor.',
            code: PUPIL_IN_TWO_HALVES,
          });
        }
        const pupils = await pupilsOfTheClass(tx, theClass);
        const strangers = placing.filter((id) => !pupils.has(id));
        if (strangers.length > 0) throw pupilsNotInClass(strangers.length, theClass.name);

        await holdPupils(tx, pupils);
        await tx.studentGroupMember.deleteMany({
          where: { studentGroupId: { in: named }, studentId: { in: [...pupils] } },
        });
        const rows = dto.halves.flatMap((half) =>
          half.studentIds.map((studentId) => ({ schoolId, studentGroupId: half.groupId, studentId })),
        );
        if (rows.length > 0) await tx.studentGroupMember.createMany({ data: rows });
        return { placed: placing.length, unplaced: pupils.size - placing.length };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Replace the group's teaching membership with exactly `studentIds`.
   *
   * Validated against the tenant inside the SAME RLS transaction that writes:
   * every id must be an ACTIVE STUDENT the caller can see. Ids that fail that
   * test are rejected as a 400 naming the offenders rather than silently
   * dropped — a silently shrunken save is how a student falls out of a
   * teaching group without anyone noticing until the schedule clashes.
   */
  async setMembers(
    groupId: string,
    dto: SetGroupMembersDto,
    user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    const schoolId = requireSchoolId(user);
    const unique = [...new Set(dto.studentIds)];
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const group = await tx.studentGroup.findUnique({
          where: { id: groupId },
          select: { id: true, halfOf: { select: { id: true, name: true, predecessorId: true } } },
        });
        if (!group) {
          throw new NotFoundException('Student group not found.');
        }
        // A half takes pupils of its class only (Halvklasser); a pupil
        // already in the class's other half meets the one-half index (409).
        // And it replaces only those pupils' rows, as placeHalves does.
        const classPupils = group.halfOf ? await pupilsOfTheClass(tx, group.halfOf) : null;
        if (group.halfOf && classPupils) {
          const strangers = unique.filter((id) => !classPupils.has(id));
          if (strangers.length > 0) throw pupilsNotInClass(strangers.length, group.halfOf.name);
        }

        if (unique.length > 0) {
          const students = await tx.user.findMany({
            where: { id: { in: unique }, role: 'STUDENT', isActive: true },
            select: { id: true },
          });
          const valid = new Set(students.map((s) => s.id));
          const invalid = unique.filter((id) => !valid.has(id));
          if (invalid.length > 0) {
            throw new BadRequestException(
              `Not active students in this school: ${invalid.join(', ')}`,
            );
          }
        }

        if (classPupils) await holdPupils(tx, classPupils);
        await tx.studentGroupMember.deleteMany({
          where: classPupils ? { studentGroupId: groupId, studentId: { in: [...classPupils] } } : { studentGroupId: groupId },
        });
        if (unique.length > 0) {
          await tx.studentGroupMember.createMany({
            data: unique.map((studentId) => ({
              schoolId,
              studentGroupId: groupId,
              studentId,
            })),
          });
        }
        return { count: unique.length };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
