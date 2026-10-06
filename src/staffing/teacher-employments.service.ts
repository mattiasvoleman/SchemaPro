import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type TeacherEmployment } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { lockStaffRow } from './staff-lock';
import type { UpsertTeacherEmploymentDto } from './dto/teacher-employment.dto';

/**
 * A post as the client sees it: the two Decimal columns as numbers.
 *
 * Prisma hands a Decimal(6,3) back as a Decimal object, which JSON.stringify
 * renders as the string "80" — and a form that multiplies a riktmärke by it
 * gets NaN. Converted once here; the arithmetic in teacher-load.ts takes the
 * same numbers.
 */
export interface TeacherEmploymentResponse
  extends Omit<TeacherEmployment, 'employmentPercent' | 'reductionPercent'> {
  employmentPercent: number;
  reductionPercent: number;
}

export function toEmploymentResponse(row: TeacherEmployment): TeacherEmploymentResponse {
  return {
    ...row,
    employmentPercent: Number(row.employmentPercent),
    reductionPercent: Number(row.reductionPercent),
  };
}

/**
 * Lärarnas tjänster: one row per teacher per läsår, upserted by the teacher
 * and year named in the URL.
 *
 * ONE WRITER. Unlike TeacherWorkRules, a teacher does not write their own row:
 * a tjänstgöringsgrad is negotiated, not declared, and the table has no teacher
 * write arm at all. A teacher READS their own row and no colleague's — this is
 * HR data, and `teacher_employments_teacher_own_select` is deliberately
 * narrower than the work rules' staff_select. The service filters the list the
 * same way, so the two agree about what a teacher sees whichever door they
 * come through; RLS is what actually holds.
 */
@Injectable()
export class TeacherEmploymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The year's posts: the whole school for an admin, the caller's own for a
   * teacher. Ordered by `userId` rather than createdAt, like the work rules —
   * the list is read beside a roster.
   */
  async list(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<TeacherEmploymentResponse[]> {
    requireSchoolId(user);
    // The filter duplicates the RLS arm on purpose: a teacher reads only their
    // own row either way, and a route whose only guard is the policy is one
    // refactor from a list of colleagues' percentages.
    const where =
      user.role === Role.SCHOOL_ADMIN
        ? { academicYearId }
        : { academicYearId, userId: requireUserId(user) };
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.teacherEmployment.findMany({ where, orderBy: { userId: 'asc' } }),
    );
    return rows.map(toEmploymentResponse);
  }

  /**
   * Write (or rewrite) one teacher's post for one year. The whole row is
   * replaced, every time, for the reason the DTO gives.
   */
  async upsert(
    userId: string,
    academicYearId: string,
    dto: UpsertTeacherEmploymentDto,
    user: AuthenticatedUser,
  ): Promise<TeacherEmploymentResponse> {
    const schoolId = requireSchoolId(user);
    const data = employmentData(dto);

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        await lockStaffRow(tx, userId, 'tjänst');
        return tx.teacherEmployment.upsert({
          where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } },
          create: { schoolId, userId, academicYearId, ...data },
          update: data,
        });
      });
      return toEmploymentResponse(row);
    } catch (error) {
      rethrowEmploymentError(error, dto, academicYearId);
    }
  }

  /** Drop the post, which is how a school says "no longer employed this year". */
  async remove(userId: string, academicYearId: string, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.teacherEmployment.delete({
          where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

/**
 * The row the DTO describes, defaults filled in so create and update write the
 * same thing. The one cross-field rule is checked here, where both numbers are
 * visible; the table says the same with
 * TeacherEmployments_reduction_within_employment, as a 500.
 */
export function employmentData(dto: UpsertTeacherEmploymentDto): {
  employmentPercent: number;
  reductionPercent: number;
  contractKind: NonNullable<UpsertTeacherEmploymentDto['contractKind']>;
  teachingTargetMinutesPerWeek: number | null;
  signature: string | null;
  note: string | null;
} {
  const reductionPercent = dto.reductionPercent ?? 0;
  if (reductionPercent > dto.employmentPercent) {
    throw new BadRequestException(
      `Nedsättningen (${reductionPercent} %) kan inte vara större än tjänstgöringsgraden (${dto.employmentPercent} %).`,
    );
  }
  return {
    employmentPercent: dto.employmentPercent,
    reductionPercent,
    contractKind: dto.contractKind ?? 'FERIE',
    teachingTargetMinutesPerWeek: dto.teachingTargetMinutesPerWeek ?? null,
    signature: dto.signature?.trim() || null,
    note: dto.note?.trim() || null,
  };
}

/**
 * A unique violation on this table, once the upsert's own key is accounted
 * for, can only be TeacherEmployments_one_signature_per_year — the partial
 * index Prisma cannot see and therefore cannot name in `meta.target`. So P2002
 * here is the signature, and the answer names it and the year rather than
 * rethrowPrismaError's "a record with these values already exists", which an
 * admin cannot act on.
 */
export function rethrowEmploymentError(
  error: unknown,
  dto: Pick<UpsertTeacherEmploymentDto, 'signature'>,
  academicYearId: string,
): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(
      `Signaturen "${dto.signature?.trim() ?? ''}" används redan av en annan lärare läsåret ${academicYearId}. Välj en annan signatur.`,
    );
  }
  rethrowPrismaError(error);
}
