import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { listNames, rethrowPrismaError } from '../common/utils/prisma-errors';
import { todayInZone } from '../common/utils/time';
import { readYearBoundsForShare } from '../resources/academic-year-bounds';
import {
  chainOf,
  planActivation,
  readActivationSource,
  type ActivationPlan,
  type ActivationProblem,
} from './activation-plan';
import { applyRollover, type StaffingCounts } from './rollover-apply';
import { planRollover, previewOf, type RolloverPlan, type RolloverProblem } from './rollover-plan';
import { readRolloverSource, type RolloverSource } from './rollover-source';
import { rostersOfYear } from './projected-rosters';
import type { ExecuteActivationDto, ExecuteRolloverDto, RolloverOptionsDto } from './dto/year-rollover.dto';

/** The problem codes the rollover and the activation answer with, beside RolloverProblemCode. */
export const YEAR_HAS_SUCCESSOR = 'YEAR_HAS_SUCCESSOR';
export const ROLLOVER_SOURCE_NOT_ACTIVATED = 'ROLLOVER_SOURCE_NOT_ACTIVATED';
export const ROLLOVER_SOURCE_HAS_STRAGGLERS = 'ROLLOVER_SOURCE_HAS_STRAGGLERS';
export const ROLLOVER_PREVIEW_STALE = 'ROLLOVER_PREVIEW_STALE';
export const ACTIVATION_PREVIEW_STALE = 'ACTIVATION_PREVIEW_STALE';
export const YEAR_NAME_TAKEN = 'YEAR_NAME_TAKEN';

/** Long enough for a school of 40 classes and 600 timplansposter; 15 s is withRls's default. */
const ROLLOVER_TIMEOUT_MS = 60_000;

/** The activation's "today": the school day in Sweden, not the server's UTC day. */
export const ACTIVATION_TIME_ZONE = 'Europe/Stockholm';

export type RolloverPreview = Omit<RolloverPlan, 'writes'>;
export type ActivationPreview = Omit<ActivationPlan, 'writes'>;

export interface RolloverResult {
  academicYear: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    isActive: false;
    predecessorId: string;
    graduatingGradeLevel: number;
  };
  counts: { groups: number; members: number; requirements: number; breaks: number; classRules: number; timplans: number };
  /** Tjänster, uppdrag and their new slots; null for a rollover without carryStaffing. */
  staffing: StaffingCounts | null;
  planHash: string;
}

/**
 * The year's class lists as every roster reader reads them: PROJECTED for the
 * active year's rolled successor, with the home class its activation gives
 * each pupil it moves; CURRENT for any other year, with nothing overlaid.
 * Pupil ids only — the web resolves them against the people it already holds.
 */
export interface YearRosters {
  academicYearId: string;
  basis: 'CURRENT' | 'PROJECTED';
  /** Only the pupils the projection moves, sorted by id; null is a graduate or an unplaced pupil. */
  homeClasses: { studentId: string; studentGroupId: string | null }[];
  counts: { moved: number; graduates: number; unplaced: number };
  /** Teaching-group memberships the rollover decided on placements that have changed since. */
  membershipsOutOfDate: { missing: number; stale: number };
}

export interface ActivationResult {
  year: { id: string; name: string; isActive: true };
  moved: number;
  graduated: number;
  unplaced: number;
}

/**
 * Läsårsrullning (rollover) and the activation of the year it creates.
 *
 * ROLLOVER: a preview that writes nothing and returns a plan and its hash,
 * then an execute that takes the hash back. The execute locks the source
 * year (FOR SHARE, as every period writer does) and its groups (FOR SHARE, in
 * id order), reads everything again, plans again, and refuses a plan that is
 * blocked (400 naming the field or the row) or differs from the preview (409
 * ROLLOVER_PREVIEW_STALE) — before its first write. Then it only inserts, in
 * one transaction: nothing in the source year is changed.
 *
 * ACTIVATION: the same shape. The preview says who moves where; the execute
 * locks the year (FOR NO KEY UPDATE, as the year PATCH does), the chain's
 * groups and the pupils it will move, re-plans and compares, hands over the
 * active flag and moves the planned pupils by id.
 *
 * Every refusal is a code the web translates, with a Swedish message that
 * names the year, the group or the lov. Logs carry ids and counts, never a
 * pupil's or a teacher's name.
 */
@Injectable()
export class YearRolloverService {
  private readonly logger = new Logger(YearRolloverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async previewRollover(
    sourceYearId: string,
    dto: RolloverOptionsDto,
    user: AuthenticatedUser,
  ): Promise<RolloverPreview> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(
        user,
        async (tx) => {
          const source = await readRolloverSource(tx, sourceYearId, { carryStaffing: dto.carryStaffing === true });
          if (!source) throw yearNotFound();
          refuseUnrollable(source);
          return previewOf(planRollover(source, dto));
        },
        { timeoutMs: ROLLOVER_TIMEOUT_MS },
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async executeRollover(
    sourceYearId: string,
    dto: ExecuteRolloverDto,
    user: AuthenticatedUser,
  ): Promise<RolloverResult> {
    const schoolId = requireSchoolId(user);
    const carryStaffing = dto.carryStaffing === true;
    try {
      const result = await this.prisma.withRls(
        user,
        async (tx) => {
          // The year first, as every period writer reads it (FOR SHARE): a
          // year PATCH moving its dates, or an activation, waits for this
          // transaction, and this one for theirs.
          const bounds = await readYearBoundsForShare(tx, sourceYearId);
          if (!bounds) throw yearNotFound();
          // Then the year's groups, in id order, so the plan below is computed
          // from groups that cannot be renamed, moved or deleted under it.
          await tx.$queryRaw`
            SELECT "id"
            FROM "StudentGroups"
            WHERE "academicYearId" = ${sourceYearId}::uuid
            ORDER BY "id"
            FOR SHARE
          `;
          // With tjänster: the people whose rows are carried, then the rows.
          if (carryStaffing) await lockSourceStaffing(tx, sourceYearId);
          const source = await readRolloverSource(tx, sourceYearId, { carryStaffing });
          if (!source) throw yearNotFound();
          refuseUnrollable(source);
          const plan = planRollover(source, dto);
          refuseBlockedRollover(plan, source);
          if (plan.planHash !== dto.planHash) throw rolloverStale(carryStaffing);

          const applied = await applyRollover(tx, schoolId, plan.writes);
          return {
            academicYear: {
              id: applied.targetYearId,
              name: plan.writes.year.name,
              startDate: plan.writes.year.startDate,
              endDate: plan.writes.year.endDate,
              isActive: false as const,
              predecessorId: sourceYearId,
              graduatingGradeLevel: plan.writes.year.graduatingGradeLevel,
            },
            counts: applied.counts,
            staffing: carryStaffing ? applied.staffingCounts : null,
            planHash: plan.planHash,
          };
        },
        { timeoutMs: ROLLOVER_TIMEOUT_MS },
      );
      const { counts, staffing } = result;
      this.logger.log(
        `Läsår rullat [school=${schoolId}, source=${sourceYearId}, target=${result.academicYear.id}, ` +
          `groups=${counts.groups}, members=${counts.members}, requirements=${counts.requirements}, ` +
          `breaks=${counts.breaks}, classRules=${counts.classRules}, timplans=${counts.timplans}` +
          (staffing
            ? `, employments=${staffing.employments}, duties=${staffing.duties}, dutySlots=${staffing.dutySlots}`
            : '') +
          ']',
      );
      return result;
    } catch (error) {
      // Two rollovers of one year at once both pass the successor check; the
      // second meets the unique predecessor key. Its transaction is aborted,
      // so the successor is read in a transaction of its own to be named.
      const key = uniqueKeyOf(error);
      if (key?.includes('AcademicYears_predecessorId_schoolId_key')) {
        throw await this.yearHasSuccessor(sourceYearId, user);
      }
      if (key?.includes('AcademicYears_schoolId_name_key')) throw yearNameTaken(dto.name.trim());
      rethrowPrismaError(error);
    }
  }

  async previewActivation(
    yearId: string,
    user: AuthenticatedUser,
    options: { today?: string } = {},
  ): Promise<ActivationPreview> {
    requireSchoolId(user);
    const today = options.today ?? todayInStockholm();
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const source = await readActivationSource(tx, yearId);
        if (!source) throw yearNotFound();
        const { writes: _writes, ...preview } = planActivation(source, today);
        return preview;
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async executeActivation(
    yearId: string,
    dto: ExecuteActivationDto,
    user: AuthenticatedUser,
    options: { today?: string } = {},
  ): Promise<ActivationResult> {
    const schoolId = requireSchoolId(user);
    const today = options.today ?? todayInStockholm();
    try {
      const result = await this.prisma.withRls(
        user,
        async (tx) => {
          // The year, as the year PATCH locks it: a second activation, a
          // PATCH {isActive} or a rollover of this year (FOR SHARE) waits.
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id"
            FROM "AcademicYears"
            WHERE "id" = ${yearId}::uuid
            FOR NO KEY UPDATE
          `;
          if (!locked) throw yearNotFound();
          const first = await readActivationSource(tx, yearId);
          if (!first) throw yearNotFound();
          // The chain's groups, so no link the moves follow changes under them.
          const yearIds = [yearId, ...chainOf(first.years, yearId).map((year) => year.id)];
          await tx.$queryRaw`
            SELECT "id"
            FROM "StudentGroups"
            WHERE "academicYearId" = ANY(${yearIds}::uuid[])
            ORDER BY "id"
            FOR SHARE
          `;
          // The pupils the plan moves, in id order; then the plan again, from
          // rows that can no longer change, and compared with the preview.
          await lockPupils(tx, planActivation(first, today));
          const source = await readActivationSource(tx, yearId);
          if (!source) throw yearNotFound();
          const plan = planActivation(source, today);
          refuseBlockedActivation(plan);
          if (plan.planHash !== dto.planHash) throw activationStale();

          if (!plan.year.isActive) {
            await tx.academicYear.updateMany({
              where: { isActive: true, id: { not: yearId } },
              data: { isActive: false },
            });
            await tx.academicYear.update({ where: { id: yearId }, data: { isActive: true } });
          }
          let moved = 0;
          for (const move of plan.writes) {
            // By id, and only a pupil still active and still where the plan
            // found them: a pupil created or moved meanwhile stays where they
            // are, and a second activation finishes them.
            const { count } = await tx.user.updateMany({
              where: {
                id: { in: move.studentIds },
                role: 'STUDENT',
                isActive: true,
                studentGroupId: move.fromGroupId,
              },
              data: { studentGroupId: move.toGroupId },
            });
            if (move.toGroupId !== null) moved += count;
          }
          return {
            year: { id: yearId, name: plan.year.name, isActive: true as const },
            moved,
            graduated: plan.graduates.count,
            unplaced: plan.unplaced.count,
          };
        },
        { timeoutMs: ROLLOVER_TIMEOUT_MS },
      );
      this.logger.log(
        `Läsår aktiverat [school=${schoolId}, year=${yearId}, moved=${result.moved}, ` +
          `graduated=${result.graduated}, unplaced=${result.unplaced}]`,
      );
      return result;
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The basis the gateway's roster readers use for the year, so the web lays
   * the same overlay over the people it holds (the grid's clash colours, the
   * grade spans) as the server does over its rows. 404 when RLS hides the
   * year; 409 ROLLOVER_NOT_ACTIVATED for a year whose predecessor is not
   * activated (R6), as every reader answers.
   */
  async rosters(yearId: string, user: AuthenticatedUser): Promise<YearRosters> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const year = await tx.academicYear.findUnique({
          where: { id: yearId },
          select: { isActive: true, predecessorId: true },
        });
        if (!year) throw yearNotFound();
        const basis = await rostersOfYear(tx, user, yearId, year);
        if (basis.kind === 'CURRENT') {
          return {
            academicYearId: yearId,
            basis: 'CURRENT' as const,
            homeClasses: [],
            counts: { moved: 0, graduates: 0, unplaced: 0 },
            membershipsOutOfDate: { missing: 0, stale: 0 },
          };
        }
        return {
          academicYearId: yearId,
          basis: 'PROJECTED' as const,
          homeClasses: [...basis.homeOf]
            .map(([studentId, studentGroupId]) => ({ studentId, studentGroupId }))
            .sort((a, b) => (a.studentId < b.studentId ? -1 : 1)),
          counts: basis.counts,
          membershipsOutOfDate: basis.membershipsOutOfDate,
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  private async yearHasSuccessor(sourceYearId: string, user: AuthenticatedUser): Promise<ConflictException> {
    const [year, successor] = await this.prisma.withRls(user, async (tx) => [
      await tx.academicYear.findUnique({ where: { id: sourceYearId }, select: { name: true } }),
      await tx.academicYear.findFirst({ where: { predecessorId: sourceYearId }, select: { id: true, name: true } }),
    ]);
    return yearHasSuccessorConflict(year?.name ?? '', successor ?? null);
  }
}

// ---- refusals

export function todayInStockholm(): string {
  return todayInZone(ACTIVATION_TIME_ZONE).toISOString().slice(0, 10);
}

function yearNotFound(): NotFoundException {
  return new NotFoundException('Läsåret finns inte.');
}

export function yearHasSuccessorConflict(
  yearName: string,
  successor: { id: string; name: string } | null,
): ConflictException {
  return new ConflictException({
    message: successor
      ? `Läsåret ${yearName} har redan rullats vidare till ${successor.name}.`
      : `Läsåret ${yearName} har redan rullats vidare.`,
    code: YEAR_HAS_SUCCESSOR,
    params: successor ? { successorId: successor.id, successor: successor.name } : {},
  });
}

function yearNameTaken(name: string): ConflictException {
  return new ConflictException({
    message: `name: det finns redan ett läsår som heter "${name}".`,
    code: YEAR_NAME_TAKEN,
  });
}

/**
 * The reasons a year cannot be rolled at all, whatever is asked.
 *
 * Pending moves mean two different things. In a year not yet activated they
 * are all its pupils, still in the classes of the year before
 * (ROLLOVER_SOURCE_NOT_ACTIVATED: activate it). In the ACTIVE year they are
 * stragglers — a pupil who was inactive at the activation and has been set
 * active again, or one put back in an old class since, still sitting in last
 * year's class. Telling that admin "the year is not activated" is false and
 * names a remedy they cannot see; the activation of the active year moves
 * exactly those pupils (it hands no flag over), so the refusal says so. Their
 * ids are not in `params` (the problem filter drops an array whole); the
 * activation preview of the active year lists them per move, and the web
 * names them there.
 */
function refuseUnrollable(source: RolloverSource): void {
  if (source.successor) throw yearHasSuccessorConflict(source.year.name, source.successor);
  if (source.pendingMoves === 0) return;
  if (source.year.isActive) {
    throw new ConflictException({
      message:
        `${source.pendingMoves} elever står kvar i klasser från ett tidigare läsår än ${source.year.name}. ` +
        'Kör aktiveringen av läsåret igen, så flyttas de till sina klasser, och rulla sedan vidare.',
      code: ROLLOVER_SOURCE_HAS_STRAGGLERS,
      params: { year: source.year.name, pupils: source.pendingMoves },
    });
  }
  throw new ConflictException({
    message:
      `Läsåret ${source.year.name} är inte aktiverat: ${source.pendingMoves} elever väntar fortfarande på att flyttas in i dess klasser. ` +
      'Aktivera det innan det rullas vidare, så räknas klasserna på sina egna elever.',
    code: ROLLOVER_SOURCE_NOT_ACTIVATED,
    params: { year: source.year.name, pupils: source.pendingMoves },
  });
}

const GROUP_CHOICE_SV: Record<string, string> = {
  PROMOTE_GRADUATING: 'går ut och kan inte flyttas upp',
  PROMOTE_WITHOUT_GRADE: 'har ingen årskurs att flytta upp',
  INTAKE_NOT_LOWEST: 'är inte en klass i den lägsta årskursen, så INTAKE går inte',
};

/** The first blocking problem as the 400 or 409 the execute answers with. */
function refuseBlockedRollover(plan: RolloverPlan, source: RolloverSource): void {
  const first = (code: RolloverProblem['code']) =>
    plan.problems.find((problem) => problem.blocking && problem.code === code);
  const breakName = (problem: RolloverProblem) => String(problem.params['name']);

  const dates = first('ROLLOVER_TARGET_DATES');
  if (dates) {
    throw new BadRequestException({
      message:
        `startDate: det nya läsåret ska börja efter att ${source.year.name} slutar (${source.year.endDate}) ` +
        'och sluta efter att det börjar.',
      code: 'ROLLOVER_TARGET_DATES',
    });
  }
  const unknownGroup = first('ROLLOVER_UNKNOWN_GROUP');
  if (unknownGroup) {
    throw new BadRequestException({
      message: `groups: gruppen ${String(unknownGroup.params['sourceGroupId'])} finns inte i läsåret ${source.year.name}.`,
      code: 'ROLLOVER_UNKNOWN_GROUP',
    });
  }
  const choice = first('ROLLOVER_GROUP_CHOICE_INVALID');
  if (choice) {
    throw new BadRequestException({
      message: `groups: ${String(choice.params['group'])} ${GROUP_CHOICE_SV[String(choice.params['error'])] ?? 'kan inte få det utfallet'}.`,
      code: String(choice.params['error']),
    });
  }
  const grade = first('GRADUATING_GRADE_REQUIRED');
  if (grade) {
    throw new BadRequestException({
      message: 'graduatingGradeLevel: ange vilken årskurs som går ut.',
      code: 'GRADUATING_GRADE_REQUIRED',
    });
  }
  const collision = first('ROLLOVER_NAME_COLLISION');
  if (collision) {
    const names = collision.params['names'] as string[];
    throw new BadRequestException({
      message: `Nästa läsår skulle få flera grupper som heter ${listNames(names)}. Byt namn på någon av dem.`,
      code: 'ROLLOVER_NAME_COLLISION',
      params: { names },
    });
  }
  const unknownBreak = first('ROLLOVER_UNKNOWN_BREAK');
  if (unknownBreak) {
    throw new BadRequestException({
      message: `breaks: lovet ${String(unknownBreak.params['sourceBreakId'])} finns inte i läsåret ${source.year.name}.`,
      code: 'ROLLOVER_UNKNOWN_BREAK',
    });
  }
  const needsDates = first('BREAK_NEEDS_DATES');
  if (needsDates) {
    throw new BadRequestException({
      message: `breaks: ${breakName(needsDates)} har inget datumförslag nästa år. Ange start- och slutdatum.`,
      code: 'BREAK_NEEDS_DATES',
    });
  }
  const outside = first('BREAK_OUTSIDE_YEAR');
  if (outside) {
    throw new BadRequestException({
      message:
        `breaks: ${breakName(outside)} (${String(outside.params['startDate'])} – ${String(outside.params['endDate'])}) ` +
        `ligger inte inom det nya läsåret (${plan.target.startDate} – ${plan.target.endDate}).`,
      code: 'BREAK_OUTSIDE_YEAR',
    });
  }
  if (first('YEAR_NAME_TAKEN')) throw yearNameTaken(plan.target.name);
  const other = plan.problems.find((problem) => problem.blocking);
  if (other) throw new BadRequestException({ message: other.code, code: other.code });
}

function rolloverStale(carryStaffing: boolean): ConflictException {
  const what = carryStaffing
    ? 'grupper, elever, timplansposter, lov, tjänster eller uppdrag'
    : 'grupper, elever, timplansposter eller lov';
  return new ConflictException({
    message: `Läsåret har ändrats sedan förhandsvisningen: ${what} är inte längre desamma. Inget skapades. Förhandsvisa igen och granska.`,
    code: ROLLOVER_PREVIEW_STALE,
  });
}

/**
 * The locks a carry of tjänster takes on its source year's staffing, after
 * the year and the groups: the people whose posts and uppdrag it reads (FOR
 * NO KEY UPDATE, in id order — the lock lockStaffRow and the role PATCH
 * take), then the posts and the uppdrag themselves (FOR SHARE, in id order).
 *
 * No cycle with the writers it can meet: an employment upsert takes the
 * person, then the post; a duty create the person, then inserts; the uppdrag
 * import the people, then its rows; a duty PATCH or delete the duty alone;
 * a role PATCH the person, then their own rows. The activation locks pupils,
 * never staff. A row that appears after the plain read below, for a person
 * outside the locked set, was not in the preview either, so it can only
 * change the writes — which is the 409 stale, before anything is written.
 * An empty set takes no Users lock at all, as lockPupils does.
 *
 * Shared with the carry into an already rolled year (staffing-rollover.service.ts).
 */
export async function lockSourceStaffing(tx: PrismaClient, sourceYearId: string): Promise<void> {
  const posts = await tx.teacherEmployment.findMany({ where: { academicYearId: sourceYearId }, select: { userId: true } });
  const duties = await tx.teacherDuty.findMany({ where: { academicYearId: sourceYearId }, select: { userId: true } });
  const ids = [...new Set([...(posts ?? []), ...(duties ?? [])].map((row) => row.userId))].sort();
  if (ids.length > 0) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Users"
      WHERE "id" = ANY(${ids}::uuid[])
      ORDER BY "id"
      FOR NO KEY UPDATE
    `;
  }
  await tx.$queryRaw`
    SELECT "id"
    FROM "TeacherEmployments"
    WHERE "academicYearId" = ${sourceYearId}::uuid
    ORDER BY "id"
    FOR SHARE
  `;
  await tx.$queryRaw`
    SELECT "id"
    FROM "TeacherDuties"
    WHERE "academicYearId" = ${sourceYearId}::uuid
    ORDER BY "id"
    FOR SHARE
  `;
}

function activationStale(): ConflictException {
  return new ConflictException({
    message:
      'Elevernas klasser har ändrats sedan förhandsvisningen. Ingen flyttades. Förhandsvisa aktiveringen igen.',
    code: ACTIVATION_PREVIEW_STALE,
  });
}

/** The 409 for an activation the plan blocks: too early, or a superseded year. */
export function activationRefusal(problem: ActivationProblem): ConflictException {
  if (problem.code === 'YEAR_ACTIVATION_TOO_EARLY') {
    return new ConflictException({
      message:
        `Läsåret ${String(problem.params['year'])} pågår till och med ${String(problem.params['endDate'])}. ` +
        'Eleverna flyttas till sina nya klasser när det har slutat — annars blir närvarolistorna för de sista veckornas lektioner tomma.',
      code: problem.code,
      params: problem.params,
    });
  }
  return new ConflictException({
    message:
      `Läsåret ${String(problem.params['year'])} har efterträtts av ${String(problem.params['successor'])}, ` +
      `där ${String(problem.params['pupils'])} elever redan har sina klasser. Att aktivera det igen skulle lämna det utan elever.`,
    code: problem.code,
    params: problem.params,
  });
}

function refuseBlockedActivation(plan: ActivationPlan): void {
  const problem = plan.problems.find((candidate) => candidate.blocking);
  if (problem) throw activationRefusal(problem);
}

async function lockPupils(tx: PrismaClient, plan: ActivationPlan): Promise<void> {
  const ids = plan.writes.flatMap((move) => move.studentIds).sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT "id"
    FROM "Users"
    WHERE "id" = ANY(${ids}::uuid[])
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
}

/** The unique key a P2002 names, as text, or null for anything else. */
function uniqueKeyOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  return JSON.stringify(error.meta ?? {});
}
