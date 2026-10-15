import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient, type SchoolUnitType } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import type { CreateSchoolUnitDto, UpdateSchoolUnitDto } from './dto/school-unit.dto';
import { compareUnits, normaliseUnitCode, normaliseUnitTypes, spansOverlap } from './school-unit-map';

/**
 * The school's skolenheter (migration 20261031090000), written by its
 * administrator. A unit linked to the SS12000 source (ss12000Id) has its
 * name, code and skolformer from the source: the sync writes them, and a
 * change here is refused (SCHOOL_UNIT_FROM_SOURCE) rather than overwritten
 * at the next apply. The span is SchemaPro's in both cases — S1's
 * Organisation has no årskurser — and the sync only proposes one, from the
 * source's enrolments.
 *
 * Units are no personal data, so no read is written to the läslogg.
 */
export interface SchoolUnitView {
  id: string;
  name: string;
  code: string | null;
  schoolTypes: SchoolUnitType[];
  gradeFrom: number | null;
  gradeTo: number | null;
  /** Linked to the SS12000 source: name, code and skolformer are the source's. */
  fromSource: boolean;
}

export const SCHOOL_UNIT_SPAN_OVERLAP = 'SCHOOL_UNIT_SPAN_OVERLAP';
export const SCHOOL_UNIT_CODE_TAKEN = 'SCHOOL_UNIT_CODE_TAKEN';
export const SCHOOL_UNIT_CODE_INVALID = 'SCHOOL_UNIT_CODE_INVALID';
export const SCHOOL_UNIT_SPAN_INVALID = 'SCHOOL_UNIT_SPAN_INVALID';
export const SCHOOL_UNIT_FROM_SOURCE = 'SCHOOL_UNIT_FROM_SOURCE';

const SELECT = {
  id: true,
  name: true,
  code: true,
  schoolTypes: true,
  gradeFrom: true,
  gradeTo: true,
  ss12000Id: true,
} as const;

type Row = Prisma.SchoolUnitGetPayload<{ select: typeof SELECT }>;

const view = (row: Row): SchoolUnitView => ({
  id: row.id,
  name: row.name,
  code: row.code,
  schoolTypes: normaliseUnitTypes(row.schoolTypes),
  gradeFrom: row.gradeFrom,
  gradeTo: row.gradeTo,
  fromSource: row.ss12000Id !== null,
});

interface DriverCause {
  originalCode?: unknown;
}

/** The span trigger's refusal (SQLSTATE SU409), through @prisma/adapter-pg as prisma-errors.ts reads TP409. */
export function isSpanOverlapRefusal(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (error.meta as { driverAdapterError?: { cause?: DriverCause } } | undefined)?.driverAdapterError?.cause;
  return cause?.originalCode === 'SU409' || (error.code === 'P2039' && error.message.includes('Code: `SU409`'));
}

const spanOverlap = (name: string | null) =>
  new ConflictException({
    message:
      (name === null ? 'Årskurserna ligger redan i en annan skolenhet. ' : `Årskurserna ligger redan i skolenheten "${name}". `) +
      'Två skolenheter i samma skola kan inte ha samma årskurs.',
    code: SCHOOL_UNIT_SPAN_OVERLAP,
  });

const codeTaken = () =>
  new ConflictException({ message: 'En annan skolenhet i skolan har redan den skolenhetskoden.', code: SCHOOL_UNIT_CODE_TAKEN });

function normaliseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new BadRequestException({ message: 'name: skolenheten behöver ett namn.', code: 'SCHOOL_UNIT_NAME_EMPTY' });
  return trimmed;
}

function normaliseCode(code: string | null | undefined): string | null | undefined {
  if (code === undefined) return undefined;
  if (code === null || code.trim() === '') return null;
  const normalised = normaliseUnitCode(code);
  if (normalised === null) {
    throw new BadRequestException({ message: 'code: en skolenhetskod är åtta siffror.', code: SCHOOL_UNIT_CODE_INVALID });
  }
  return normalised;
}

function checkSpan(gradeFrom: number | null, gradeTo: number | null): void {
  if ((gradeFrom === null) !== (gradeTo === null) || (gradeFrom !== null && gradeTo !== null && gradeFrom > gradeTo)) {
    throw new BadRequestException({
      message: 'gradeFrom, gradeTo: ange både första och sista årskurs, och den första före den sista.',
      code: SCHOOL_UNIT_SPAN_INVALID,
    });
  }
}

/**
 * The school's units, one writer at a time: the lock every unit write takes
 * in the database (app.school_units_take_school_lock, migration
 * 20261031090000), taken here before the checks, so the checks read what
 * the write will meet and a sync apply holding it (readLocalSlice) is waited
 * out rather than raced.
 */
export async function lockSchoolUnits(tx: PrismaClient, schoolId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`SchoolUnits:${schoolId}`}, 0))`);
}

@Injectable()
export class SchoolUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<SchoolUnitView[]> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) => tx.schoolUnit.findMany({ where: { schoolId }, select: SELECT }));
    return rows.sort(compareUnits).map(view);
  }

  async create(dto: CreateSchoolUnitDto, user: AuthenticatedUser): Promise<SchoolUnitView> {
    const schoolId = requireSchoolId(user);
    const name = normaliseName(dto.name);
    const code = normaliseCode(dto.code) ?? null;
    const gradeFrom = dto.gradeFrom ?? null;
    const gradeTo = dto.gradeTo ?? null;
    checkSpan(gradeFrom, gradeTo);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockSchoolUnits(tx, schoolId);
        await this.assertFree(tx, schoolId, null, code, { gradeFrom, gradeTo });
        const row = await tx.schoolUnit.create({
          data: { schoolId, name, code, schoolTypes: normaliseUnitTypes(dto.schoolTypes ?? []), gradeFrom, gradeTo },
          select: SELECT,
        });
        return view(row);
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(id: string, dto: UpdateSchoolUnitDto, user: AuthenticatedUser): Promise<SchoolUnitView> {
    const schoolId = requireSchoolId(user);
    const name = dto.name === undefined ? undefined : normaliseName(dto.name);
    const code = normaliseCode(dto.code);
    const schoolTypes = dto.schoolTypes === undefined ? undefined : normaliseUnitTypes(dto.schoolTypes);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Read after the lock: a LINK an apply commits meanwhile is seen,
        // and its source-owned fields refused below.
        await lockSchoolUnits(tx, schoolId);
        const unit = await tx.schoolUnit.findFirst({ where: { id, schoolId }, select: SELECT });
        if (!unit) throw new NotFoundException('The requested record does not exist.');
        const gradeFrom = dto.gradeFrom !== undefined ? dto.gradeFrom : unit.gradeFrom;
        const gradeTo = dto.gradeTo !== undefined ? dto.gradeTo : unit.gradeTo;
        checkSpan(gradeFrom, gradeTo);
        if (unit.ss12000Id !== null) {
          const moved =
            (name !== undefined && name !== unit.name) ||
            (code !== undefined && code !== unit.code) ||
            (schoolTypes !== undefined && schoolTypes.join(',') !== normaliseUnitTypes(unit.schoolTypes).join(','));
          if (moved) {
            throw new ConflictException({
              message: 'Skolenhetens namn, kod och skolformer kommer från elevregistret och ändras där.',
              code: SCHOOL_UNIT_FROM_SOURCE,
            });
          }
        }
        await this.assertFree(tx, schoolId, id, code ?? null, { gradeFrom, gradeTo });
        const row = await tx.schoolUnit.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(code !== undefined ? { code } : {}),
            ...(schoolTypes !== undefined ? { schoolTypes } : {}),
            ...(dto.gradeFrom !== undefined || dto.gradeTo !== undefined ? { gradeFrom, gradeTo } : {}),
          },
          select: SELECT,
        });
        return view(row);
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /**
   * The school's lock first, as every other unit writer takes it: a DELETE
   * locks its row before the BEFORE trigger takes the school's lock, so
   * without this a delete beside an update or a sync apply (lock, then rows)
   * takes the two in the other order and the two deadlock.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    const { count } = await this.prisma.withRls(user, async (tx) => {
      await lockSchoolUnits(tx, schoolId);
      return tx.schoolUnit.deleteMany({ where: { id, schoolId } });
    });
    if (count === 0) throw new NotFoundException('The requested record does not exist.');
  }

  /**
   * The friendly half of the two guards: a 409 naming the unit in the way
   * before the write. The span trigger and the partial unique index are the
   * other half, for two writers at once.
   */
  private async assertFree(
    tx: PrismaClient,
    schoolId: string,
    self: string | null,
    code: string | null,
    span: { gradeFrom: number | null; gradeTo: number | null },
  ): Promise<void> {
    const others = await tx.schoolUnit.findMany({
      where: { schoolId, ...(self ? { id: { not: self } } : {}) },
      select: { name: true, code: true, gradeFrom: true, gradeTo: true },
    });
    if (code !== null && others.some((other) => other.code === code)) throw codeTaken();
    const overlapping = others.find((other) => spansOverlap(other, span));
    if (overlapping) throw spanOverlap(overlapping.name);
  }

  private rethrow(error: unknown): never {
    if (isSpanOverlapRefusal(error)) throw spanOverlap(null);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw codeTaken();
    rethrowPrismaError(error);
  }
}
