import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { StudentGroup } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
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

@Injectable()
export class StudentGroupsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async update(
    id: string,
    dto: UpdateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.update({
          where: { id },
          data: {
            ...(dto.academicYearId !== undefined
              ? { academicYearId: dto.academicYearId }
              : {}),
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.gradeLevel !== undefined ? { gradeLevel: dto.gradeLevel } : {}),
          },
        }),
      );
    } catch (error) {
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

  /** Teaching-group members (the M2M list — home-class members not included). */
  async listMembers(
    groupId: string,
    user: AuthenticatedUser,
  ): Promise<GroupMember[]> {
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.studentGroupMember.findMany({
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
      }),
    );
    return rows.map((row) => ({
      id: row.student.id,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      homeGroupId: row.student.studentGroupId,
    }));
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
