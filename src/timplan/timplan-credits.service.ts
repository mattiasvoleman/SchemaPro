import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, timplanCreditKeyField } from '../common/utils/prisma-errors';
import type {
  CreateTimplanCreditDto,
  UpdateTimplanCreditDto,
} from './dto/timplan-credit.dto';

/** One credit as the API answers it: dates as YYYY-MM-DD, never an instant. */
export interface TimplanCreditResponse {
  id: string;
  academicYearId: string;
  date: string;
  minutes: number;
  subjectId: string | null;
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  name: string;
  note: string | null;
}

/** The problem codes a refused credit carries. */
export const TIMPLAN_CREDIT_OUTSIDE_YEAR = 'TIMPLAN_CREDIT_OUTSIDE_YEAR';
export const TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR = 'TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR';
export const TIMPLAN_CREDIT_SCOPE = 'TIMPLAN_CREDIT_SCOPE';

const SELECT = {
  id: true,
  academicYearId: true,
  date: true,
  minutes: true,
  subjectId: true,
  studentGroupId: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  name: true,
  note: true,
} as const;

type CreditRow = Prisma.TimplanCreditGetPayload<{ select: typeof SELECT }>;

export interface Scope {
  studentGroupId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const parseDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Tillgodoräknad tid: the school's written decisions that a day's activity
 * counts as undervisningstid (migration 20261009100000 argues the table).
 *
 * SCHOOL_ADMIN writes; TEACHER reads (the controller's split, and the table's
 * two arms). Every statement runs under the caller's RLS, so another school's
 * credit, year, group or subject reads as missing — a 404 for the credit
 * itself, a 400 naming the field for what a body names.
 *
 * THE RULES THAT NEED A ROW are checked here, before the write, so each
 * refusal can say what is wrong in the admin's words:
 *
 *   * the date inside the läsår (400 TIMPLAN_CREDIT_OUTSIDE_YEAR) — the
 *     table does not hold it, because a year's bounds can move later;
 *   * a group of the same läsår (400 TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR) —
 *     another year's group is legal in the table and reaches nobody;
 *   * the scope one thing (400 TIMPLAN_CREDIT_SCOPE): a group or a whole span
 *     in order, never both — the CHECKs' rule, said with the fields named.
 *
 * The keys and CHECKs are the second line: a 23503 the read could not see
 * coming (a subject deleted in between) is a 400 naming the field, and a
 * CHECK reached past the DTO a 400 naming the field (rethrowPrismaError).
 *
 * Nothing here refuses a credit for what it does to the coverage. A credit
 * on a day that still has lessons, or one that reaches nobody, is the
 * coverage's notice to give, not a write to refuse.
 */
@Injectable()
export class TimplanCreditsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(academicYearId: string, user: AuthenticatedUser): Promise<TimplanCreditResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } });
      if (!year) throw new NotFoundException('Läsåret finns inte.');
      return tx.timplanCredit.findMany({
        where: { academicYearId },
        select: SELECT,
        orderBy: [{ date: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
    });
    return rows.map(toResponse);
  }

  async create(dto: CreateTimplanCreditDto, user: AuthenticatedUser): Promise<TimplanCreditResponse> {
    const schoolId = requireSchoolId(user);
    const scope = checkScope({
      studentGroupId: dto.studentGroupId ?? null,
      minGradeLevel: dto.minGradeLevel ?? null,
      maxGradeLevel: dto.maxGradeLevel ?? null,
    });
    try {
      const row = await this.prisma.withRls(user, (tx) => createCreditInTransaction(tx, schoolId, dto, scope));
      return toResponse(row);
    } catch (error) {
      rethrowCreditError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTimplanCreditDto,
    user: AuthenticatedUser,
  ): Promise<TimplanCreditResponse> {
    requireSchoolId(user);
    // R25: naming any of the three replaces the triple; the others become null.
    const namesScope =
      dto.studentGroupId !== undefined || dto.minGradeLevel !== undefined || dto.maxGradeLevel !== undefined;
    const scope = namesScope
      ? checkScope({
          studentGroupId: dto.studentGroupId ?? null,
          minGradeLevel: dto.minGradeLevel ?? null,
          maxGradeLevel: dto.maxGradeLevel ?? null,
        })
      : null;
    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const current = await tx.timplanCredit.findUnique({
          where: { id },
          select: { ...SELECT, academicYear: { select: { id: true, name: true, startDate: true, endDate: true } } },
        });
        if (!current) throw new NotFoundException('The requested record does not exist.');
        const date = dto.date ?? asDay(current.date);
        const groupId = scope ? scope.studentGroupId : current.studentGroupId;
        const subjectId = dto.subjectId !== undefined ? dto.subjectId : current.subjectId;
        await checkRow(
          tx,
          current.academicYear,
          date,
          // Only what this PATCH names is asked again: a stored group that
          // has since moved year is the coverage's to report, not a reason
          // to refuse an edit of the minutes.
          scope && scope.studentGroupId !== current.studentGroupId ? groupId : null,
          dto.subjectId !== undefined && subjectId !== current.subjectId ? subjectId : null,
        );
        return tx.timplanCredit.update({
          where: { id },
          data: {
            ...(dto.date !== undefined ? { date: parseDay(dto.date) } : {}),
            ...(dto.minutes !== undefined ? { minutes: dto.minutes } : {}),
            ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
            ...(scope ?? {}),
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.note !== undefined ? { note: noteOf(dto.note) } : {}),
          },
          select: SELECT,
        });
      });
      return toResponse(row);
    } catch (error) {
      rethrowCreditError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) => tx.timplanCredit.delete({ where: { id }, select: { id: true } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

function toResponse(row: CreditRow): TimplanCreditResponse {
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    date: asDay(row.date),
    minutes: row.minutes,
    subjectId: row.subjectId,
    studentGroupId: row.studentGroupId,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    name: row.name,
    note: row.note,
  };
}

/** Trimmed; blank after trimming is no note (the CHECK refuses a blank one). */
function noteOf(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** A group, a whole span in order, or neither — never both. */
/**
 * create() inside a transaction the CALLER holds: the same checks and the
 * same row. A bulk avbokning that counts its day as teaching hands its
 * credits off through this (src/publication/cancellation-batches.service.ts),
 * in the transaction that cancels the lessons, so a refused credit leaves no
 * lesson cancelled. `scope` must have passed checkScope.
 */
export async function createCreditInTransaction(
  tx: Prisma.TransactionClient,
  schoolId: string,
  dto: CreateTimplanCreditDto,
  scope: Scope,
) {
  const year = await tx.academicYear.findUnique({
    where: { id: dto.academicYearId },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  if (!year) throw new BadRequestException('academicYearId: läsåret finns inte.');
  await checkRow(tx, year, dto.date, scope.studentGroupId, dto.subjectId ?? null);
  return tx.timplanCredit.create({
    data: {
      schoolId,
      academicYearId: year.id,
      date: parseDay(dto.date),
      minutes: dto.minutes,
      subjectId: dto.subjectId ?? null,
      ...scope,
      name: dto.name.trim(),
      note: noteOf(dto.note),
    },
    select: SELECT,
  });
}

export function checkScope(scope: Scope): Scope {
  const refuse = (message: string, fields: string) =>
    new BadRequestException({ message, code: TIMPLAN_CREDIT_SCOPE, params: { fields } });
  const { studentGroupId, minGradeLevel, maxGradeLevel } = scope;
  if ((minGradeLevel === null) !== (maxGradeLevel === null)) {
    throw refuse(
      'minGradeLevel och maxGradeLevel anges tillsammans: ett spann har en första och en sista årskurs.',
      'minGradeLevel, maxGradeLevel',
    );
  }
  if (minGradeLevel !== null && maxGradeLevel !== null && minGradeLevel > maxGradeLevel) {
    throw refuse(
      `minGradeLevel: åk ${minGradeLevel} ligger efter åk ${maxGradeLevel}; spannet anges från den lägsta.`,
      'minGradeLevel, maxGradeLevel',
    );
  }
  if (studentGroupId !== null && minGradeLevel !== null) {
    throw refuse(
      'studentGroupId: beslutet gäller en grupp eller ett årskursspann, inte båda.',
      'studentGroupId, minGradeLevel, maxGradeLevel',
    );
  }
  return scope;
}

/** The date inside the läsår, and what the body names visible and of the year. */
async function checkRow(
  tx: Prisma.TransactionClient,
  year: { id: string; name: string; startDate: Date; endDate: Date },
  date: string,
  studentGroupId: string | null,
  subjectId: string | null,
): Promise<void> {
  const start = asDay(year.startDate);
  const end = asDay(year.endDate);
  if (date < start || date > end) {
    throw new BadRequestException({
      message: `date: ${date} ligger utanför läsåret ${year.name} (${start}–${end}).`,
      code: TIMPLAN_CREDIT_OUTSIDE_YEAR,
      params: { date, startDate: start, endDate: end },
    });
  }
  if (studentGroupId !== null) {
    const group = await tx.studentGroup.findUnique({
      where: { id: studentGroupId },
      select: { academicYearId: true, name: true },
    });
    if (!group) throw new BadRequestException('studentGroupId: gruppen finns inte.');
    if (group.academicYearId !== year.id) {
      throw new BadRequestException({
        message: `studentGroupId: ${group.name} hör till ett annat läsår än ${year.name}.`,
        code: TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR,
        params: { groupName: group.name, yearName: year.name },
      });
    }
  }
  if (subjectId !== null) {
    const subject = await tx.subject.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!subject) throw new BadRequestException('subjectId: ämnet finns inte.');
  }
}

/**
 * A composite key's refusal names the field it guards (a subject or group
 * deleted between the read and the write, or a body the read let through);
 * everything else goes the house's way.
 */
function rethrowCreditError(error: unknown): never {
  const field = timplanCreditKeyField(error);
  if (field) throw new BadRequestException(`${field}: finns inte i skolan.`);
  rethrowPrismaError(error);
}
