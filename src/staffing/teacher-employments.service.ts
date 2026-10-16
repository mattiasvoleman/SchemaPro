import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TeacherEmployment, type TeacherEmploymentPeriod } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { recordRead } from '../access-log/access-log';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { readYearBoundsForShare } from '../resources/academic-year-bounds';
import { lockStaffRow } from './staff-lock';
import type {
  UpsertTeacherEmploymentDto,
  UpsertTeacherEmploymentPeriodDto,
} from './dto/teacher-employment.dto';
import { diffLogEntry, type LogChange } from './employment-log-diff';
import { postStretches } from './employment-periods';
import { hideHr, hideHrChanges, readsHr } from './hr-visibility';

/** One version of a tjänst, as the Historik card and a protokoll cite it. */
export interface TeacherHistoryEntry {
  id: string;
  /** 1, 2, 3 … per teacher and year: "Version 7". */
  version: number;
  entity: 'EMPLOYMENT' | 'DUTY' | 'PERIOD';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Who wrote it; null for a migration, the seed or the database owner. */
  actorId: string | null;
  createdAt: Date;
  changes: LogChange[];
  /**
   * A PERIOD version's Från — the period's after the write, before it for a
   * delete — so an update that moved only the figures still says which
   * period it was. Absent for the other entities.
   */
  periodFrom?: string | null;
}

/** The Från of the period a PERIOD version is about, from the row's own JSON. */
function periodFromOf(action: string, before: unknown, after: unknown): string | null {
  const row = action === 'DELETE' ? before : after;
  const value = row && typeof row === 'object' ? (row as Record<string, unknown>)['validFrom'] : null;
  return typeof value === 'string' && value !== '' ? value.slice(0, 10) : null;
}

export interface TeacherHistoryResponse {
  /** Newest first. */
  entries: TeacherHistoryEntry[];
  /** True when there were more than HISTORY_LIMIT versions; the oldest are left out. */
  truncated: boolean;
}

/** The versions one read hands back. A year's tjänst rarely has a tenth of it. */
export const HISTORY_LIMIT = 200;

/** A TEACHER asking for a colleague's history: refused before anything is read. */
export const HISTORY_OWN_ONLY = 'Du kan bara läsa historiken för din egen tjänst.';

/**
 * A post as the client sees it: the two Decimal columns as numbers.
 *
 * Prisma hands a Decimal(6,3) back as a Decimal object, which JSON.stringify
 * renders as the string "80" — and a form that multiplies a riktmärke by it
 * gets NaN. Converted once here; the arithmetic in teacher-load.ts takes the
 * same numbers.
 */
export interface TeacherEmploymentResponse
  extends Omit<TeacherEmployment, 'employmentPercent' | 'reductionPercent' | 'ss12000StretchKey'> {
  employmentPercent: number;
  reductionPercent: number;
  /**
   * The post from a date (migration 20261022120000), by Från. Empty for a
   * post that is the same all year.
   */
  periods: TeacherEmploymentPeriodResponse[];
}

/** A period of a post as the client sees it: dates as yyyy-mm-dd, percentages as numbers. */
export interface TeacherEmploymentPeriodResponse {
  id: string;
  employmentId: string;
  validFrom: string;
  validTo: string | null;
  employmentPercent: number;
  reductionPercent: number;
  teachingTargetMinutesPerWeek: number | null;
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

export function toPeriodResponse(row: TeacherEmploymentPeriod): TeacherEmploymentPeriodResponse {
  return {
    id: row.id,
    employmentId: row.employmentId,
    validFrom: asDay(row.validFrom),
    validTo: row.validTo === null ? null : asDay(row.validTo),
    employmentPercent: Number(row.employmentPercent),
    reductionPercent: Number(row.reductionPercent),
    teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
  };
}

export function toEmploymentResponse(
  row: TeacherEmployment & { periods?: TeacherEmploymentPeriod[] },
): TeacherEmploymentResponse {
  // The SS12000 stretch key leaves through no API (20261104090000), not even to the admin.
  const { periods, ss12000StretchKey: _key, ...post } = row;
  return {
    ...post,
    employmentPercent: Number(row.employmentPercent),
    reductionPercent: Number(row.reductionPercent),
    periods: [...(periods ?? [])]
      .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
      .map(toPeriodResponse),
  };
}

/** Every read of a post includes its periods, by Från. */
const WITH_PERIODS = { periods: { orderBy: { validFrom: 'asc' } } } satisfies Prisma.TeacherEmploymentInclude;

/** The 409 a period overlapping another of the same post answers with. */
export const EMPLOYMENT_PERIOD_OVERLAP = 'EMPLOYMENT_PERIOD_OVERLAP';

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
  private readonly logger = new Logger(TeacherEmploymentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One teacher's tjänst for one year, version by version: every change to
   * their post and their uppdrag the database recorded (TeacherEmploymentLogs,
   * written by a trigger on every writer — the routes here, the imports, the
   * rollover, PostgREST). Newest first, at most HISTORY_LIMIT.
   *
   * HR DATA, TWICE GUARDED. A TEACHER asking for anybody but themselves gets
   * 403 before a statement is sent; RLS (teacher_own_select) would hand them
   * nothing anyway, and a route whose only guard is the policy is one
   * refactor from a colleague's nedsättning. The admin reads any teacher.
   * The application log carries ids and a count, never a value.
   */
  async history(
    userId: string,
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<TeacherHistoryResponse> {
    requireSchoolId(user);
    if (user.role !== Role.SCHOOL_ADMIN && userId !== requireUserId(user)) {
      throw new ForbiddenException(HISTORY_OWN_ONLY);
    }
    const rows = await this.prisma.withRls(user, async (tx) => {
      const found = await tx.teacherEmploymentLog.findMany({
        where: { userId, academicYearId },
        orderBy: { version: 'desc' },
        take: HISTORY_LIMIT + 1,
        select: {
          id: true,
          version: true,
          entity: true,
          entityId: true,
          action: true,
          before: true,
          after: true,
          actorId: true,
          createdAt: true,
        },
      });
      if (found.length > 0) await recordRead(tx, 'EMPLOYMENT', [userId], user.channel);
      return found;
    });
    // A period's versions are left out for a reader without HR-läs, as the
    // periods are from the post (hr-visibility.ts): when and how a post
    // changes is HR data like the percentages.
    const shown = readsHr(user) ? rows : rows.filter((row) => row.entity !== 'PERIOD');
    const entries = shown.slice(0, HISTORY_LIMIT).map((row) => ({
      id: row.id,
      version: row.version,
      entity: row.entity,
      entityId: row.entityId,
      action: row.action,
      actorId: row.actorId,
      createdAt: row.createdAt,
      changes: readsHr(user)
        ? diffLogEntry(row.entity, row.before, row.after)
        : hideHrChanges(diffLogEntry(row.entity, row.before, row.after)),
      ...(row.entity === 'PERIOD' ? { periodFrom: periodFromOf(row.action, row.before, row.after) } : {}),
    }));
    this.logger.log(`History read [user=${userId}, year=${academicYearId}, entries=${entries.length}]`);
    return { entries, truncated: rows.length > HISTORY_LIMIT };
  }

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
    const rows = await this.prisma.withRls(user, async (tx) => {
      // Each post with its periods (20261022120000), in one read.
      const found = await tx.teacherEmployment.findMany({ where, orderBy: { userId: 'asc' }, include: WITH_PERIODS });
      // HR data: EMPLOYMENT in the läslogg (a teacher's own row is left out);
      // a post's periods are the post's, and read with it.
      await recordRead(tx, 'EMPLOYMENT', found.map((row) => row.userId), user.channel);
      return found;
    });
    // Tjänst % and nedsättning for rektor, full and HR-läs only (hr-visibility.ts).
    const posts = rows.map(toEmploymentResponse);
    return readsHr(user) ? posts : (posts.map(hideHr) as unknown as TeacherEmploymentResponse[]);
  }

  /**
   * Write (or rewrite) one teacher's post for one year. The whole row is
   * replaced, every time, for the reason the DTO gives — but for SCB's three,
   * which a PUT that leaves them out keeps (employmentData).
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
      return await this.prisma.withRls(user, async (tx) => {
        await lockStaffRow(tx, userId, 'tjänst');
        const saved = await tx.teacherEmployment.upsert({
          where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } },
          create: { schoolId, userId, academicYearId, ...data },
          update: data,
          include: WITH_PERIODS,
        });
        // The answer is the post the caller sent and, when it has any, its
        // periods, which the caller did not: a read of them, recorded as the
        // post's reads are (EMPLOYMENT), in the write's own transaction. So is
        // one of SCB's three the PUT left out and the row keeps: handed back,
        // not sent. A post with neither answers only what was sent, a write's
        // echo.
        const answer = toEmploymentResponse(saved);
        const keptUnsent = (['employmentForm', 'firstTeacherPercent', 'lecturerPercent'] as const).some(
          (field) => dto[field] === undefined && (saved[field] ?? null) !== null,
        );
        if (answer.periods.length > 0 || keptUnsent) await recordRead(tx, 'EMPLOYMENT', [userId], user.channel);
        return answer;
      });
    } catch (error) {
      rethrowEmploymentError(error, dto, academicYearId);
    }
  }

  /**
   * A new period of a teacher's post for one year: "80 % från 1 november".
   *
   * CHECK, THEN WRITE, UNDER THE POST'S LOCK. The post row is locked FOR NO
   * KEY UPDATE first — the lock every staffing write that asks the load
   * question takes (staffing-enforcement.ts lockEmploymentsOf), so a period
   * lowering the post queues behind an assignment judged against the old
   * figure instead of interleaving with it, and two period writes on one post
   * queue behind each other. Then the year's bounds FOR SHARE, as every
   * writer of a dated period reads them (academic-year-bounds.ts), and the
   * three rules that need another row: inside the läsår, at least one whole
   * week, no overlap with another period of the post. The EXCLUDE constraint
   * holds the last for every writer; it is checked here first so the answer
   * names the period it overlaps.
   */
  async createPeriod(
    userId: string,
    academicYearId: string,
    dto: UpsertTeacherEmploymentPeriodDto,
    user: AuthenticatedUser,
  ): Promise<TeacherEmploymentPeriodResponse> {
    const schoolId = requireSchoolId(user);
    const data = periodData(dto);
    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const post = await tx.teacherEmployment.findUnique({
          where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } },
          select: { id: true },
        });
        if (!post || !(await lockPost(tx, post.id))) {
          throw new NotFoundException(
            'Läraren har ingen tjänst det läsåret. Lägg in tjänsten först; en period ändrar en tjänst från ett datum.',
          );
        }
        await assertPeriodFits(tx, post.id, academicYearId, data, null);
        return tx.teacherEmploymentPeriod.create({
          data: { schoolId, employmentId: post.id, userId, academicYearId, ...data },
        });
      });
      this.logger.log(`Period created [user=${userId}, year=${academicYearId}, period=${row.id}]`);
      return toPeriodResponse(row);
    } catch (error) {
      rethrowPeriodError(error);
    }
  }

  /** Rewrite one period, whole, as the post is; it stays on its post. */
  async updatePeriod(
    periodId: string,
    dto: UpsertTeacherEmploymentPeriodDto,
    user: AuthenticatedUser,
  ): Promise<TeacherEmploymentPeriodResponse> {
    requireSchoolId(user);
    const data = periodData(dto);
    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const period = await lockPeriodPost(tx, periodId);
        await assertPeriodFits(tx, period.employmentId, period.academicYearId, data, periodId);
        return tx.teacherEmploymentPeriod.update({ where: { id: periodId }, data });
      });
      return toPeriodResponse(row);
    } catch (error) {
      rethrowPeriodError(error);
    }
  }

  /** Remove one period: its days are the post's own again. */
  async removePeriod(periodId: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        await lockPeriodPost(tx, periodId);
        await tx.teacherEmploymentPeriod.delete({ where: { id: periodId } });
      });
    } catch (error) {
      rethrowPeriodError(error);
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
  employmentForm?: NonNullable<UpsertTeacherEmploymentDto['employmentForm']> | null;
  firstTeacherPercent?: number | null;
  lecturerPercent?: number | null;
} {
  const reductionPercent = dto.reductionPercent ?? 0;
  if (reductionPercent > dto.employmentPercent) {
    throw new BadRequestException(
      `Nedsättningen (${reductionPercent} %) kan inte vara större än tjänstgöringsgraden (${dto.employmentPercent} %).`,
    );
  }
  // The table's CHECK, said in Swedish before the write when both are sent:
  // SCB counts both as shares of one post. One sent beside a stored other is
  // the CHECK's to refuse (NAMED_CHECKS, the same sentence's substance).
  const firstTeacherPercent = dto.firstTeacherPercent ?? null;
  const lecturerPercent = dto.lecturerPercent ?? null;
  if ((firstTeacherPercent ?? 0) + (lecturerPercent ?? 0) > 100) {
    throw new BadRequestException(
      `Förstelärar- och lektorsuppdraget (${firstTeacherPercent} % och ${lecturerPercent} %) kan tillsammans vara högst hela tjänsten.`,
    );
  }
  return {
    employmentPercent: dto.employmentPercent,
    reductionPercent,
    contractKind: dto.contractKind ?? 'FERIE',
    teachingTargetMinutesPerWeek: dto.teachingTargetMinutesPerWeek ?? null,
    signature: dto.signature?.trim() || null,
    note: dto.note?.trim() || null,
    // SCB's three (20261111090000) are written when sent — null clears — and
    // kept when absent, unlike the fields above: the whole row is replaced on
    // every PUT, so a web from before them, open in a tab over the release,
    // would otherwise clear what the new form wrote on its next save.
    ...(dto.employmentForm !== undefined ? { employmentForm: dto.employmentForm } : {}),
    ...(dto.firstTeacherPercent !== undefined ? { firstTeacherPercent } : {}),
    ...(dto.lecturerPercent !== undefined ? { lecturerPercent } : {}),
  };
}

/** The columns a period's DTO describes, dates parsed, defaults filled in. */
export function periodData(dto: UpsertTeacherEmploymentPeriodDto): {
  validFrom: Date;
  validTo: Date | null;
  employmentPercent: number;
  reductionPercent: number;
  teachingTargetMinutesPerWeek: number | null;
} {
  const reductionPercent = dto.reductionPercent ?? 0;
  if (reductionPercent > dto.employmentPercent) {
    throw new BadRequestException(
      `Nedsättningen (${reductionPercent} %) kan inte vara större än tjänstgöringsgraden (${dto.employmentPercent} %).`,
    );
  }
  if (dto.validTo != null && dto.validTo < dto.validFrom) {
    throw new BadRequestException(
      `validTo: perioden kan inte sluta (${dto.validTo}) innan den börjar (${dto.validFrom}).`,
    );
  }
  return {
    validFrom: parseDateString(dto.validFrom),
    validTo: dto.validTo == null ? null : parseDateString(dto.validTo),
    employmentPercent: dto.employmentPercent,
    reductionPercent,
    teachingTargetMinutesPerWeek: dto.teachingTargetMinutesPerWeek ?? null,
  };
}

/**
 * Finds a period under RLS and locks its post FOR NO KEY UPDATE, as a new
 * period's write does. A period the caller cannot see is a 404.
 */
async function lockPeriodPost(
  tx: Prisma.TransactionClient,
  periodId: string,
): Promise<Pick<TeacherEmploymentPeriod, 'employmentId' | 'academicYearId'>> {
  const period = await tx.teacherEmploymentPeriod.findUnique({
    where: { id: periodId },
    select: { employmentId: true, academicYearId: true },
  });
  if (!period || !(await lockPost(tx, period.employmentId))) throw new NotFoundException('Perioden finns inte.');
  return period;
}

/**
 * The post's row FOR NO KEY UPDATE, by id, as lockEmploymentsOf takes it: a
 * plain read finds the post, this locks it. False when it is gone by then.
 */
async function lockPost(tx: Prisma.TransactionClient, employmentId: string): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TeacherEmployments" WHERE "id" = ${employmentId}::uuid FOR NO KEY UPDATE
  `;
  return locked.length > 0;
}

/**
 * The three rules a period needs another row for, under the post's lock:
 * inside the läsår (its bounds read FOR SHARE), at least one whole week (an
 * ISO week is the post in force on its Monday — employment-periods.ts — so a
 * period holding no Monday of the year would change nothing), and no overlap
 * with another period of the post. `self` is the period being rewritten.
 */
async function assertPeriodFits(
  tx: Prisma.TransactionClient,
  employmentId: string,
  academicYearId: string,
  data: ReturnType<typeof periodData>,
  self: string | null,
): Promise<void> {
  const bounds = await readYearBoundsForShare(tx, academicYearId);
  if (!bounds) throw new NotFoundException('Läsåret finns inte.');
  const year = { startDate: asDay(bounds.startDate), endDate: asDay(bounds.endDate) };
  const from = asDay(data.validFrom);
  const to = data.validTo === null ? null : asDay(data.validTo);
  if (from < year.startDate || from > year.endDate) {
    throw new BadRequestException(
      `validFrom: ${from} ligger utanför läsåret (${year.startDate} till ${year.endDate}).`,
    );
  }
  if (to !== null && to > year.endDate) {
    throw new BadRequestException(
      `validTo: ${to} ligger utanför läsåret (${year.startDate} till ${year.endDate}). Lämna Till tomt för läsårets sista dag.`,
    );
  }
  const [alone] = postStretches(
    {
      employmentPercent: data.employmentPercent,
      reductionPercent: data.reductionPercent,
      teachingTargetMinutesPerWeek: data.teachingTargetMinutesPerWeek,
      periods: [{ ...data, validFrom: from, validTo: to }],
    },
    year,
  ).filter((stretch) => stretch.kind === 'PERIOD');
  if (!alone?.window) {
    throw new BadRequestException(
      `validFrom: perioden ${from}–${to ?? year.endDate} innehåller ingen måndag i läsåret. ` +
        'Tjänsten räknas vecka för vecka, och en vecka hör till den tjänst som gäller på måndagen — ' +
        'en period behöver minst en hel vecka.',
    );
  }
  const others = await tx.teacherEmploymentPeriod.findMany({
    where: { employmentId, ...(self ? { id: { not: self } } : {}) },
    select: { validFrom: true, validTo: true },
    orderBy: { validFrom: 'asc' },
  });
  const overlapping = others.find(
    (other) =>
      asDay(other.validFrom) <= (to ?? year.endDate) &&
      (other.validTo === null || asDay(other.validTo) >= from),
  );
  if (overlapping) {
    const otherTo = overlapping.validTo === null ? year.endDate : asDay(overlapping.validTo);
    throw new ConflictException({
      message:
        `Perioden överlappar en annan period av tjänsten (${asDay(overlapping.validFrom)} till ${otherTo}). ` +
        'Ändra eller ta bort den först — en dag har en tjänst.',
      code: EMPLOYMENT_PERIOD_OVERLAP,
    });
  }
}

/**
 * A period write's errors: the EXCLUDE constraint (23P01), which a writer that
 * did not take the post's lock can still meet, as the same 409 the check above
 * answers; everything else as every staffing write maps it.
 */
export function rethrowPeriodError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } | undefined)
      ?.driverAdapterError?.cause;
    const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
    if (cause?.originalCode === '23P01' || text.includes('TeacherEmploymentPeriods_do_not_overlap')) {
      throw new ConflictException({
        message: 'Perioden överlappar en annan period av tjänsten. Ändra eller ta bort den först — en dag har en tjänst.',
        code: EMPLOYMENT_PERIOD_OVERLAP,
      });
    }
  }
  rethrowPrismaError(error);
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
