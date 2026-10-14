import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/*
 * Who may act for a pupil: report an absence (FamilyService) or file a leave
 * request (LeaveService). RLS decides it again at the write; these give the
 * caller a 403 that says why, instead of an empty result or a 42501.
 */

/** Guardians act for linked children; students for themselves; admins for anyone. */
export async function assertMayActForStudent(
  tx: PrismaClient,
  studentId: string,
  user: AuthenticatedUser,
): Promise<void> {
  if (user.role === Role.SCHOOL_ADMIN) return;
  if (user.role === Role.STUDENT) {
    if (user.userId !== studentId) {
      throw new ForbiddenException('Students may only report for themselves.');
    }
    return;
  }
  if (user.role === Role.GUARDIAN) {
    const link = await tx.guardianStudent.findFirst({
      where: { guardianId: user.userId, studentId },
      select: { id: true },
    });
    if (!link) {
      throw new ForbiddenException('Not a guardian of this student.');
    }
    return;
  }
  throw new ForbiddenException('This role cannot report absences.');
}

/** The pupil's school, as the caller reads the pupil; 404 when they cannot. */
export async function schoolIdOf(tx: PrismaClient, studentId: string): Promise<string> {
  const student = await tx.user.findUnique({
    where: { id: studentId },
    select: { schoolId: true },
  });
  if (!student) throw new NotFoundException('Student not found.');
  return student.schoolId;
}
