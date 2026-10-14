import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { StudentGroup } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../access-log/access-log';
import { PrismaService } from '../database/prisma.service';
import { tellNewMentors } from '../family/leave-notices';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, studentGroupHasEnrolmentHistory } from '../common/utils/prisma-errors';
import type {
  CreateStudentGroupDto,
  SetGroupMembersDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

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
          select: { id: true },
        });
        if (!group) {
          throw new NotFoundException('Student group not found.');
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

        await tx.studentGroupMember.deleteMany({
          where: { studentGroupId: groupId },
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
