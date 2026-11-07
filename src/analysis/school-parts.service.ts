import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import type { SchoolPartView } from './analysis.types';
import type { CreateSchoolPartDto, UpdateSchoolPartDto } from './dto/analysis.dto';
import {
  byGrade,
  CONTROL_CHARACTERS,
  overlapOf,
  SCHOOL_PART_ACCOUNT_MAX,
  SCHOOL_PART_NAME_MAX,
  spanLabel,
} from './school-part-rules';

/**
 * The school's skoldelar (migration 20270130090000): the kostnadsställen a
 * payroll is booked on, each with a name, a konto and the årskurser it holds.
 * Read by every administrator; made, changed and removed by those who decide
 * (the route says Decides and the database's arms say the same).
 *
 * Two skoldelar of a school never share an årskurs. The service compares first
 * (overlapOf) so the refusal can name the other skoldel; the database's
 * exclusion (SchoolParts_no_shared_grade) is the backstop for a race.
 *
 * A skoldel is no personal data, so no read is written to the läslogg.
 */

export const SCHOOL_PART_OVERLAPS = 'SCHOOL_PART_OVERLAPS';
export const SCHOOL_PART_NAME_TAKEN = 'SCHOOL_PART_NAME_TAKEN';
export const SCHOOL_PART_TEXT_INVALID = 'SCHOOL_PART_TEXT_INVALID';
export const SCHOOL_PART_SPAN_INVALID = 'SCHOOL_PART_SPAN_INVALID';

const SELECT = { id: true, name: true, account: true, gradeFrom: true, gradeTo: true } as const;

export const toSchoolPartView = (row: SchoolPartView): SchoolPartView => ({
  id: row.id,
  name: row.name,
  account: row.account,
  gradeFrom: row.gradeFrom,
  gradeTo: row.gradeTo,
});

const overlaps = (other: SchoolPartView | null) =>
  new ConflictException({
    message:
      (other === null ? 'Årskurserna ligger redan i en annan skoldel. ' : `Årskurserna ligger redan i skoldelen "${other.name}" (${spanLabel(other)}). `) +
      'Två skoldelar i samma skola kan inte ha samma årskurs, så att en klass hör till högst en.',
    code: SCHOOL_PART_OVERLAPS,
  });

const nameTaken = () =>
  new ConflictException({ message: 'name: skolan har redan en skoldel med det namnet.', code: SCHOOL_PART_NAME_TAKEN });

function text(field: 'name' | 'account', value: string, most: number): string {
  const trimmed = value.trim();
  if (trimmed === '' || CONTROL_CHARACTERS.test(trimmed) || [...trimmed].length > most) {
    throw new BadRequestException({
      message: `${field}: ${field === 'name' ? 'skoldelens namn' : 'kontot'} är 1–${most} tecken, utan styrtecken.`,
      code: SCHOOL_PART_TEXT_INVALID,
    });
  }
  return trimmed;
}

function span(gradeFrom: number, gradeTo: number): void {
  if (gradeFrom > gradeTo) {
    throw new BadRequestException({
      message: 'gradeFrom, gradeTo: den första årskursen ska vara före eller lika med den sista.',
      code: SCHOOL_PART_SPAN_INVALID,
    });
  }
}

interface DriverCause {
  originalCode?: unknown;
  constraint?: unknown;
}

/** The exclusion's refusal (23P01 on SchoolParts_no_shared_grade), through @prisma/adapter-pg. */
export function isSharedGradeRefusal(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
  return (
    cause?.originalCode === '23P01' ||
    error.message.includes('SchoolParts_no_shared_grade') ||
    (error.code === 'P2039' && error.message.includes('Code: `23P01`'))
  );
}

@Injectable()
export class SchoolPartsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<SchoolPartView[]> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) => tx.schoolPart.findMany({ where: { schoolId }, select: SELECT }));
    return rows.map(toSchoolPartView).sort(byGrade);
  }

  async create(dto: CreateSchoolPartDto, user: AuthenticatedUser): Promise<SchoolPartView> {
    const schoolId = requireSchoolId(user);
    const name = text('name', dto.name, SCHOOL_PART_NAME_MAX);
    const account = text('account', dto.account, SCHOOL_PART_ACCOUNT_MAX);
    span(dto.gradeFrom, dto.gradeTo);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // In årskurs order, so that the refusal names the lowest skoldel in the way, whatever order the rows come in.
        const parts = (await tx.schoolPart.findMany({ where: { schoolId }, select: SELECT })).sort(byGrade);
        if (parts.some((part) => part.name === name)) throw nameTaken();
        const other = overlapOf(parts, dto);
        if (other) throw overlaps(other);
        return toSchoolPartView(
          await tx.schoolPart.create({ data: { schoolId, name, account, gradeFrom: dto.gradeFrom, gradeTo: dto.gradeTo }, select: SELECT }),
        );
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(id: string, dto: UpdateSchoolPartDto, user: AuthenticatedUser): Promise<SchoolPartView> {
    const schoolId = requireSchoolId(user);
    const name = dto.name === undefined ? undefined : text('name', dto.name, SCHOOL_PART_NAME_MAX);
    const account = dto.account === undefined ? undefined : text('account', dto.account, SCHOOL_PART_ACCOUNT_MAX);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const parts = (await tx.schoolPart.findMany({ where: { schoolId }, select: SELECT })).sort(byGrade);
        const part = parts.find((candidate) => candidate.id === id);
        if (!part) throw new NotFoundException('The requested record does not exist.');
        const gradeFrom = dto.gradeFrom ?? part.gradeFrom;
        const gradeTo = dto.gradeTo ?? part.gradeTo;
        span(gradeFrom, gradeTo);
        if (name !== undefined && parts.some((candidate) => candidate.id !== id && candidate.name === name)) throw nameTaken();
        const other = overlapOf(parts, { gradeFrom, gradeTo }, id);
        if (other) throw overlaps(other);
        return toSchoolPartView(
          await tx.schoolPart.update({
            where: { id },
            data: {
              ...(name !== undefined ? { name } : {}),
              ...(account !== undefined ? { account } : {}),
              gradeFrom,
              gradeTo,
            },
            select: SELECT,
          }),
        );
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        // A delete finds its row under the deciders' arm; a row RLS hides is the same 404 as one that is not there.
        const removed = await tx.schoolPart.deleteMany({ where: { id } });
        if (removed.count === 0) throw new NotFoundException('The requested record does not exist.');
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** The races the checks above cannot see: a second writer's name or årskurs. */
  private rethrow(error: unknown): never {
    if (isSharedGradeRefusal(error)) throw overlaps(null);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw nameTaken();
    return rethrowPrismaError(error);
  }
}
