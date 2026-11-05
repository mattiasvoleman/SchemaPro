import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { requireSchoolId } from '../common/utils/request-context';
import { enterGrundschemaWrite, publishModeOf, type PublishMode } from '../publication/publish-mode';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { MasterLessonsService, type DayLesson } from '../calendar/master-lessons.service';
import { loadRosters, gradeSpanOf } from '../optimization/room-eligibility';
import { rostersOfYear, type RosterBasis } from '../year-rollover/projected-rosters';
import { toNioarigSpan } from '../common/grade-numbering';
import { recordRead } from '../access-log/access-log';
import { clockOfMinutes, type ExchangeDocument, type ExchangeLesson, type ReadProblem, type TeacherRef, type WeekPattern } from './exchange-model';
import {
  EXCHANGE_FORMATS,
  readUpload,
  renderExport,
  type ExchangeFormat,
  type RenderedFile,
  type UploadedFile,
} from './exchange-files';
import {
  DAY_NAMES,
  deriveRequirements,
  duplicateKey,
  fitRefusals,
  indexContext,
  labelOf,
  lunchFits,
  matchExisting,
  changesOf,
  planFingerprint,
  resolveLesson,
  type BlockRow,
  type ExistingLesson,
  type FinalLesson,
  type GroupRow,
  type Occupant,
  type PlanContext,
  type PlanRow,
  type PlanWarning,
  type Refusal,
  type RequirementPlan,
  type RequirementRow,
  type ResolvedLesson,
} from './exchange-plan';

/** The problem `code` of an apply whose file or school moved since the preview. */
export const IMPORT_PLAN_CHANGED = 'IMPORT_PLAN_CHANGED';
/** The problem `code` of an apply while a row is refused. */
export const IMPORT_HAS_REFUSALS = 'IMPORT_HAS_REFUSALS';

const RECURRENCE_OF: Record<WeekPattern, LessonRecurrence> = { ALL: 'ALL_WEEKS', ODD: 'ODD_WEEKS', EVEN: 'EVEN_WEEKS' };
const PATTERN_OF: Record<LessonRecurrence, WeekPattern> = { ALL_WEEKS: 'ALL', ODD_WEEKS: 'ODD', EVEN_WEEKS: 'EVEN' };

/** One transaction reads the school at most this long: a preview runs a clash scan per row. */
const PLAN_TIMEOUT_MS = 120_000;

export interface ExchangeSummary {
  academicYearId: string;
  yearName: string;
  publishMode: PublishMode;
  lessons: number;
  parked: number;
  teachers: number;
  teachersWithoutSignature: number;
}

export interface ImportPlan {
  format: ExchangeFormat;
  academicYearId: string;
  yearName: string;
  summary: { rows: number; create: number; unchanged: number; refused: number; unreadable: number; notInFile: number };
  rows: PlanRow[];
  /** Lines of the file that could not be read as a lesson at all. */
  unreadable: ReadProblem[];
  requirements: RequirementPlan[];
  /** Blocks the import would create. */
  newBlocks: string[];
  warnings: PlanWarning[];
  /** The choices the readers made where the format is ambiguous. */
  notes: string[];
  canApply: boolean;
  fingerprint: string;
}

export interface ImportResult {
  created: number;
  unchanged: number;
  requirementsCreated: number;
  blocksCreated: number;
  fingerprint: string;
}

interface Loaded {
  ctx: PlanContext;
  /** What the pupils' basis and each group's years are read from (rostersOf). */
  year: { isActive: boolean; predecessorId: string | null };
  schoolId: string;
  schoolName: string;
  mode: PublishMode;
  participants: Map<string, string[]>;
  blocksById: Map<string, BlockRow>;
}

/** Master lessons read and written as the exchange formats see them. */
@Injectable()
export class ScheduleExchangeService {
  private readonly logger = new Logger(ScheduleExchangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly masterLessons: MasterLessonsService,
  ) {}

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async summary(academicYearId: string, user: AuthenticatedUser): Promise<ExchangeSummary> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await this.readYear(tx, academicYearId);
      const [lessons, parked, employments, taught] = await Promise.all([
        tx.masterLesson.count({ where: { academicYearId, isParked: false } }),
        tx.masterLesson.count({ where: { academicYearId, isParked: true } }),
        tx.teacherEmployment.findMany({ where: { academicYearId }, select: { userId: true, signature: true } }),
        tx.masterLesson.findMany({ where: { academicYearId, isParked: false }, select: { teacherId: true, coTeacherId: true } }),
      ]);
      const teachers = [...new Set(taught.flatMap((l) => [l.teacherId, l.coTeacherId]).filter((id): id is string => id !== null))].map((id) => ({ id }));
      const signed = new Set(employments.filter((e) => (e.signature ?? '').trim() !== '').map((e) => e.userId));
      return {
        academicYearId,
        yearName: year.name,
        publishMode: await publishModeOf(tx, year.schoolId),
        lessons,
        parked,
        teachers: teachers.length,
        teachersWithoutSignature: teachers.filter((t) => !signed.has(t.id)).length,
      };
    });
  }

  /**
   * The grundschema (MasterLessons) as one file. What it reads, and why:
   *
   *   - The GRUNDSCHEMA, not the published week. It is the one layer an import
   *     writes, so the only one a round trip can close; it is the weekly
   *     template, with week patterns and periods, which the formats express,
   *     where the published layer is dated days with substitutions and
   *     cancellations that belong to a day and not to a schedule; and in a
   *     school that publishes through a draft it IS the draft, which is what a
   *     school wants to hand to Untis or aSc before it publishes. The
   *     published week already leaves by Schemavisaren, ICS and print.
   *   - Parked lessons (on the grid's tray) are left out: they occupy nothing.
   *
   * It names teachers, with e-mail addresses, so it is a read of other people's
   * personal data and is recorded (PEOPLE).
   */
  async export(
    academicYearId: string,
    format: ExchangeFormat,
    user: AuthenticatedUser,
  ): Promise<RenderedFile> {
    if (!EXCHANGE_FORMATS.includes(format)) throw new BadRequestException('Okänt format.');
    return this.prisma.withRls(user, async (tx) => {
      const loaded = await this.load(tx, academicYearId);
      const doc = documentOf(loaded.schoolName, loaded.ctx, loaded.blocksById);
      const teacherIds = new Set<string>();
      for (const l of loaded.ctx.existing) for (const id of [l.teacherId, l.coTeacherId]) if (id) teacherIds.add(id);
      await recordRead(tx, 'PEOPLE', teacherIds, user.channel);
      return renderExport(format, doc);
    }, { timeoutMs: PLAN_TIMEOUT_MS });
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  /** What an import would do, writing nothing: read-only, so a läsare may ask. */
  async preview(
    dto: { academicYearId: string; format: ExchangeFormat; files: UploadedFile[]; periods?: string },
    user: AuthenticatedUser,
  ): Promise<ImportPlan> {
    return this.prisma.withRls(user, (tx) => this.plan(tx, user, dto, false), { timeoutMs: PLAN_TIMEOUT_MS });
  }

  /**
   * Writes the plan, all of it or none: the preview's fingerprint must still
   * be the plan's (409 IMPORT_PLAN_CHANGED otherwise), and a refused row stops
   * everything (409 IMPORT_HAS_REFUSALS) so that no row is dropped in silence.
   * Inside the same lock a hand edit takes, so a Generera write or a publish
   * never lands between the plan and the writes.
   */
  async apply(
    dto: { academicYearId: string; format: ExchangeFormat; files: UploadedFile[]; periods?: string; fingerprint: string },
    user: AuthenticatedUser,
  ): Promise<ImportResult> {
    const result = await this.prisma.withRls(
      user,
      async (tx) => {
        const schoolId = requireSchoolId(user);
        const mode = await enterGrundschemaWrite(tx, schoolId);
        await lockYearForGrundschemaEdit(tx, dto.academicYearId);
        const plan = await this.plan(tx, user, dto, true);
        if (plan.fingerprint !== dto.fingerprint) {
          throw new ConflictException({
            message: 'Schemat eller filen har ändrats sedan förhandsvisningen. Förhandsgranska igen.',
            code: IMPORT_PLAN_CHANGED,
          });
        }
        if (!plan.canApply) {
          throw new ConflictException({
            message: 'Importen har rader som inte går att placera och skrev ingenting.',
            code: IMPORT_HAS_REFUSALS,
            refused: plan.summary.refused,
            unreadable: plan.summary.unreadable,
          });
        }
        return { written: await this.write(tx, user, schoolId, plan), mode, schoolId, plan };
      },
      { timeoutMs: PLAN_TIMEOUT_MS },
    );
    if (result.written.created > 0) {
      if (result.mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(result.schoolId, { draft: true });
      else this.realtime.notifyMasterTimetableChanged(result.schoolId);
    }
    this.logger.log(
      `Timetable import applied [format=${dto.format}, created=${result.written.created}, posts=${result.written.requirementsCreated}]`,
    );
    return { ...result.written, unchanged: result.plan.summary.unchanged, fingerprint: result.plan.fingerprint };
  }

  // -------------------------------------------------------------------------
  // The plan
  // -------------------------------------------------------------------------

  private async plan(
    tx: PrismaClient,
    user: AuthenticatedUser,
    dto: { academicYearId: string; format: ExchangeFormat; files: UploadedFile[]; periods?: string },
    inApply: boolean,
  ): Promise<ImportPlan> {
    if (!EXCHANGE_FORMATS.includes(dto.format)) throw new BadRequestException('Okänt format.');
    let parsed;
    try {
      parsed = readUpload(dto.format, dto.files, dto.periods === undefined ? {} : { periods: dto.periods });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        message: `Filen går inte att läsa som ${dto.format}: ${error instanceof Error ? error.message : 'okänt fel'}`,
        code: 'IMPORT_UNREADABLE',
      });
    }
    const loaded = await this.load(tx, dto.academicYearId);
    const basis = await this.rostersOf(tx, user, loaded);
    const { ctx } = loaded;
    const idx = indexContext(ctx);
    const rows: PlanRow[] = [];
    const warnings: PlanWarning[] = [];

    // 1. Names to things, row by row.
    const resolved: Array<ResolvedLesson | null> = [];
    const refusalsOf: Refusal[][] = [];
    parsed.lessons.forEach((lesson) => {
      const r = resolveLesson(lesson, idx, ctx);
      if ('resolved' in r) {
        resolved.push(r.resolved);
        refusalsOf.push([]);
      } else {
        resolved.push(null);
        refusalsOf.push(r.refusals);
      }
    });
    const matches = matchExisting(resolved, ctx.existing);

    // 2. Each row: what the school has, what fits, what clashes. In file
    //    order, so that a row is held against the rows before it.
    const seen = new Map<string, string>();
    const accepted: Array<{ row: PlanRow; lesson: ResolvedLesson; fake: DayLesson }> = [];
    const existingLabel = (id: string): string => {
      const e = ctx.existing.find((x) => x.id === id);
      if (!e) return 'en annan lektion';
      return `${idx.subjectsById.get(e.subjectId)?.name ?? '?'} för ${idx.groupsById.get(e.groupId)?.name ?? '?'} ${DAY_NAMES[e.day]} ${clockOfMinutes(e.startMin)}`;
    };
    for (let i = 0; i < parsed.lessons.length; i += 1) {
      const lesson = parsed.lessons[i]!;
      const r = resolved[i] ?? null;
      const row: PlanRow = {
        ref: lesson.ref,
        label: labelOf(lesson),
        action: 'REFUSED',
        refusals: [...refusalsOf[i]!],
        changes: [],
        existingId: null,
        resolved: r,
      };
      rows.push(row);
      if (!r) continue;

      const existing = matches[i] ?? null;
      if (existing) {
        const changes = changesOf(existing, r);
        row.existingId = existing.id;
        if (changes.length === 0) {
          row.action = 'UNCHANGED';
        } else {
          row.changes = changes;
          row.refusals.push({
            code: 'EXISTS_DIFFERENT',
            params: { lesson: existingLabel(existing.id), changes: changes.join(', ') },
            detail: `Skolan har redan ${existingLabel(existing.id)}, men med annan ${changes.join(', ')}. Importen ändrar inga befintliga lektioner: ta bort eller ändra lektionen i schemat först.`,
          });
        }
        continue;
      }

      const dup = seen.get(duplicateKey(r));
      if (dup !== undefined) {
        row.refusals.push({ code: 'DUPLICATE_ROW', params: { first: dup }, detail: `Samma lektion står redan på ${dup}.` });
        continue;
      }
      seen.set(duplicateKey(r), lesson.ref);

      const fit = fitRefusals(r, ctx);
      row.refusals.push(...fit.refusals);
      warnings.push(...fit.warnings.map((w) => ({ ...w, params: { ...w.params, ref: lesson.ref } })));
      if (row.refusals.length > 0) continue;

      const fake = dayLessonOf(r, `import:${i}`);
      const conflicts = await this.masterLessons.findConflicts(
        tx,
        basis,
        { id: null, academicYearId: ctx.year.id, studentGroupId: r.group.id, subjectId: r.subject.id },
        {
          dayOfWeek: r.day,
          startMinutes: r.startMin,
          endMinutes: r.endMin,
          teacherId: r.teacherIds[0] ?? null,
          coTeacherId: r.teacherIds[1] ?? null,
          roomId: r.roomId,
          extraGroupIds: r.extraGroups.map((g) => g.id),
          studentIds: [],
          recurrence: RECURRENCE_OF[r.weeks],
          startDate: r.from ? new Date(`${r.from}T00:00:00.000Z`) : null,
          endDate: r.to ? new Date(`${r.to}T00:00:00.000Z`) : null,
        },
        { alongside: accepted.filter((a) => a.lesson.day === r.day).map((a) => a.fake) },
      );
      for (const c of conflicts) {
        const other = c.masterLessonId?.startsWith('import:')
          ? `${rows[Number(c.masterLessonId.slice(7))]?.ref ?? 'en tidigare rad'}`
          : c.masterLessonId
            ? existingLabel(c.masterLessonId)
            : 'en regel';
        const code = c.kind === 'TEACHER' ? 'CLASH_TEACHER' : c.kind === 'ROOM' ? 'CLASH_ROOM' : c.kind === 'GROUP' ? 'CLASH_GROUP' : 'CLASH_AVAILABILITY';
        const what = { TEACHER: 'Läraren', ROOM: 'Salen', GROUP: 'Klassen eller gruppen', AVAILABILITY: 'En upptagen tid' }[c.kind];
        row.refusals.push({
          code,
          params: { with: other, kind: c.kind },
          detail: c.kind === 'AVAILABILITY' ? `${what} (${c.message})` : `${what} är redan upptagen: ${other} (${c.message})`,
        });
      }
      if (row.refusals.length === 0) {
        row.action = 'CREATE';
        accepted.push({ row, lesson: r, fake });
      }
    }

    // 3. Lunch, once the week is whole: a class taught across its lunch window
    //    that is left with no free stretch of the length. The row that tips it
    //    over (the last of the day, in file order) is the one refused.
    this.lunchPass(ctx, accepted);

    // 4. Timplansposter from the lessons the school will have.
    const stays = accepted.filter((a) => a.row.action === 'CREATE').map((a) => a.lesson);
    const unchangedRows = rows.filter((r) => r.action === 'UNCHANGED');
    const touched = new Set<string>();
    for (const l of stays) touched.add(`${l.group.id}|${l.subject.id}`);
    for (const r of unchangedRows) if (r.resolved) touched.add(`${r.resolved.group.id}|${r.resolved.subject.id}`);
    const final: FinalLesson[] = ctx.existing
      .map((e) => ({
        groupId: e.groupId,
        subjectId: e.subjectId,
        teacherId: e.teacherId,
        coTeacherId: e.coTeacherId,
        startMin: e.startMin,
        endMin: e.endMin,
        weeks: e.weeks,
        from: e.from,
        to: e.to,
        block: blockNameOf(ctx, loaded.blocksById, e.groupId, e.subjectId),
      }))
      .concat(
        stays.map((l) => ({
          groupId: l.group.id,
          subjectId: l.subject.id,
          teacherId: l.teacherIds[0] ?? null,
          coTeacherId: l.teacherIds[1] ?? null,
          startMin: l.startMin,
          endMin: l.endMin,
          weeks: l.weeks,
          from: l.from,
          to: l.to,
          block: l.block,
        })),
      );
    const derived = deriveRequirements(final, ctx, touched);
    warnings.push(...derived.warnings);
    const { plans: requirements, newBlocks } = settleBlocks(derived.plans, ctx, warnings);

    // 5. Read the plan back.
    const unreadable = parsed.problems;
    const refused = rows.filter((r) => r.action === 'REFUSED' || r.refusals.length > 0);
    for (const r of refused) r.action = 'REFUSED';
    const matched = new Set(rows.map((r) => r.existingId).filter((id): id is string => id !== null));
    const summary = {
      rows: rows.length,
      create: rows.filter((r) => r.action === 'CREATE').length,
      unchanged: rows.filter((r) => r.action === 'UNCHANGED').length,
      refused: refused.length,
      unreadable: unreadable.length,
      notInFile: ctx.existing.filter((e) => !matched.has(e.id)).length,
    };
    if (!inApply) {
      const teacherIds = new Set<string>();
      for (const r of rows) for (const id of r.resolved?.teacherIds ?? []) teacherIds.add(id);
      await recordRead(tx, 'PEOPLE', teacherIds, user.channel);
    }
    return {
      format: dto.format,
      academicYearId: dto.academicYearId,
      yearName: ctx.year.name,
      summary,
      rows,
      unreadable,
      requirements,
      newBlocks,
      warnings,
      notes: parsed.notes,
      canApply: summary.refused === 0 && summary.unreadable === 0 && summary.rows > 0,
      fingerprint: planFingerprint(rows, requirements),
    };
  }

  private lunchPass(
    ctx: PlanContext,
    accepted: Array<{ row: PlanRow; lesson: ResolvedLesson; fake: DayLesson }>,
  ): void {
    if (!ctx.lunch?.enabled) return;
    const occupantsOf = (): Occupant[] => [
      ...ctx.existing.map((e) => ({ groupIds: [e.groupId, ...e.extraGroupIds], day: e.day, startMin: e.startMin, endMin: e.endMin, weeks: e.weeks })),
      ...accepted
        .filter((a) => a.row.action === 'CREATE')
        .map((a) => ({
          groupIds: [a.lesson.group.id, ...a.lesson.extraGroups.map((g) => g.id)],
          day: a.lesson.day,
          startMin: a.lesson.startMin,
          endMin: a.lesson.endMin,
          weeks: a.lesson.weeks,
        })),
    ];
    const touched = new Map<string, { group: GroupRow; day: number }>();
    for (const a of accepted) {
      for (const g of [a.lesson.group, ...a.lesson.extraGroups]) touched.set(`${g.id}|${a.lesson.day}`, { group: g, day: a.lesson.day });
    }
    for (const { group, day } of touched.values()) {
      for (;;) {
        const verdict = lunchFits(ctx, group, day, occupantsOf());
        if (verdict.fits || !verdict.window) break;
        const window = verdict.window;
        // The last row of the file that puts this class in its lunch window that day.
        const blame = [...accepted]
          .reverse()
          .find(
            (a) =>
              a.row.action === 'CREATE' &&
              a.lesson.day === day &&
              [a.lesson.group.id, ...a.lesson.extraGroups.map((g) => g.id)].includes(group.id) &&
              a.lesson.startMin < window.endMin &&
              window.startMin < a.lesson.endMin,
          );
        if (!blame) break;
        blame.row.action = 'REFUSED';
        blame.row.refusals.push({
          code: 'NO_ROOM_FOR_LUNCH',
          params: { group: group.name, day, start: clockOfMinutes(window.startMin), end: clockOfMinutes(window.endMin), minutes: ctx.lunch.minutes },
          detail: `${group.name} får inte ${ctx.lunch.minutes} minuter ledigt för lunch ${DAY_NAMES[day]} ${clockOfMinutes(window.startMin)}–${clockOfMinutes(window.endMin)} med den här lektionen.`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The write
  // -------------------------------------------------------------------------

  private async write(
    tx: PrismaClient,
    user: AuthenticatedUser,
    schoolId: string,
    plan: ImportPlan,
  ): Promise<{ created: number; requirementsCreated: number; blocksCreated: number }> {
    const yearId = plan.academicYearId;
    const toCreate = plan.rows.filter((r) => r.action === 'CREATE' && r.resolved);

    // Blocks first, so a post can name one.
    const blockIds = new Map<string, string>();
    const existingBlocks = await tx.teachingBlock.findMany({ where: { academicYearId: yearId }, select: { id: true, name: true } });
    for (const b of existingBlocks) blockIds.set(b.name, b.id);
    for (const name of plan.newBlocks) {
      const created = await tx.teachingBlock.create({ data: { schoolId, academicYearId: yearId, name }, select: { id: true, name: true } });
      blockIds.set(created.name, created.id);
    }

    // The posts, and then the lessons: locked, and never the optimizer's.
    let requirementsCreated = 0;
    for (const q of plan.requirements) {
      if (q.action !== 'CREATE') continue;
      await tx.teachingRequirement.create({
        data: {
          schoolId,
          academicYearId: yearId,
          subjectId: q.subjectId,
          studentGroupId: q.groupId,
          teacherId: q.teacherId,
          coTeacherId: q.coTeacherId,
          lessonsPerWeek: q.lessonsPerWeek,
          minutesPerLesson: q.minutesPerLesson,
          ...(q.lessonLengths.length > 0 ? { lessonLengths: q.lessonLengths } : {}),
          recurrence: RECURRENCE_OF[q.recurrence],
          startDate: q.from ? new Date(`${q.from}T00:00:00.000Z`) : null,
          endDate: q.to ? new Date(`${q.to}T00:00:00.000Z`) : null,
          blockId: q.block ? (blockIds.get(q.block) ?? null) : null,
        },
      });
      requirementsCreated += 1;
    }

    const ids = toCreate.map(() => randomUUID());
    if (toCreate.length > 0) {
      await tx.masterLesson.createMany({
        data: toCreate.map((r, i) => {
          const l = r.resolved!;
          return {
            id: ids[i]!,
            schoolId,
            academicYearId: yearId,
            subjectId: l.subject.id,
            studentGroupId: l.group.id,
            teacherId: l.teacherIds[0] ?? null,
            coTeacherId: l.teacherIds[1] ?? null,
            roomId: l.roomId,
            dayOfWeek: l.day,
            startTime: timeOf(l.startMin),
            endTime: timeOf(l.endMin),
            // Locked, and handmade: regeneration keeps what was imported.
            isLocked: true,
            isGenerated: false,
            recurrence: RECURRENCE_OF[l.weeks],
            startDate: l.from ? new Date(`${l.from}T00:00:00.000Z`) : null,
            endDate: l.to ? new Date(`${l.to}T00:00:00.000Z`) : null,
          };
        }),
      });
      const extras = toCreate.flatMap((r, i) =>
        r.resolved!.extraGroups.map((g) => ({ schoolId, masterLessonId: ids[i]!, studentGroupId: g.id })),
      );
      if (extras.length > 0) await tx.masterLessonGroup.createMany({ data: extras });
      await tx.scheduleChangeLog.createMany({
        data: toCreate.map((r, i) => {
          const l = r.resolved!;
          return {
            schoolId,
            academicYearId: yearId,
            masterLessonId: ids[i]!,
            actorId: user.userId ?? null,
            action: 'CREATE' as const,
            after: {
              id: ids[i]!,
              academicYearId: yearId,
              subjectId: l.subject.id,
              studentGroupId: l.group.id,
              dayOfWeek: l.day,
              startTime: clockOfMinutes(l.startMin),
              endTime: clockOfMinutes(l.endMin),
              teacherId: l.teacherIds[0] ?? null,
              coTeacherId: l.teacherIds[1] ?? null,
              roomId: l.roomId,
              isLocked: true,
              recurrence: RECURRENCE_OF[l.weeks],
              startDate: l.from,
              endDate: l.to,
              extraGroupIds: l.extraGroups.map((g) => g.id),
              source: 'schedule-exchange',
            } as Prisma.InputJsonValue,
          };
        }),
      });
    }
    return { created: toCreate.length, requirementsCreated, blocksCreated: plan.newBlocks.length };
  }

  // -------------------------------------------------------------------------
  // Reading the school
  // -------------------------------------------------------------------------

  private async readYear(tx: PrismaClient, academicYearId: string) {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: {
        id: true,
        schoolId: true,
        name: true,
        startDate: true,
        endDate: true,
        isActive: true,
        predecessorId: true,
        gradeNumbering: true,
        school: { select: { name: true } },
      },
    });
    if (!year) throw new NotFoundException('Läsåret finns inte.');
    return year;
  }

  /**
   * The pupils' basis for the year (projected-rosters.ts: a year two steps
   * ahead is refused with R6's 409) and, from it, the years each group holds
   * in NIOARIG, which the frames, the raster and the lunch are stated in. Only
   * the import asks: an export reads the lessons alone.
   */
  private async rostersOf(tx: PrismaClient, user: AuthenticatedUser, loaded: Loaded): Promise<RosterBasis> {
    const { ctx } = loaded;
    const basis = await rostersOfYear(tx, user, ctx.year.id, loaded.year);
    const read = await loadRosters(
      tx,
      basis,
      ctx.groups.map((g) => g.id),
      ctx.groups,
    );
    for (const g of ctx.groups) {
      const span = toNioarigSpan(gradeSpanOf(read, [g.id]), ctx.year.numbering);
      if (span) ctx.spans.set(g.id, span);
    }
    return basis;
  }

  private async load(tx: PrismaClient, academicYearId: string): Promise<Loaded> {
    const year = await this.readYear(tx, academicYearId);
    const [groups, subjects, rooms, users, employments, lessons, frames, rasts, lunch, servings, sittings, requirements, blocks] =
      await Promise.all([
        tx.studentGroup.findMany({ where: { academicYearId }, select: { id: true, name: true, kind: true, gradeLevel: true, halfOfId: true } }),
        tx.subject.findMany({ select: { id: true, name: true, code: true } }),
        tx.room.findMany({ select: { id: true, name: true, code: true } }),
        tx.user.findMany({
          where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
          select: { id: true, firstName: true, lastName: true, email: true, isActive: true },
        }),
        tx.teacherEmployment.findMany({ where: { academicYearId }, select: { userId: true, signature: true } }),
        tx.masterLesson.findMany({
          where: { academicYearId, isParked: false },
          select: {
            id: true,
            studentGroupId: true,
            subjectId: true,
            teacherId: true,
            coTeacherId: true,
            roomId: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
            recurrence: true,
            startDate: true,
            endDate: true,
            isLocked: true,
            isGenerated: true,
            extraGroups: { select: { studentGroupId: true } },
            participants: { select: { studentId: true } },
          },
        }),
        tx.frameTime.findMany(),
        tx.rast.findMany(),
        tx.lunchSetting.findUnique({ where: { schoolId: year.schoolId } }),
        tx.lunchServing.findMany(),
        tx.lunchSitting.findMany({ where: { academicYearId }, select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true } }),
        tx.teachingRequirement.findMany({
          where: { academicYearId },
          select: {
            id: true,
            studentGroupId: true,
            subjectId: true,
            teacherId: true,
            coTeacherId: true,
            lessonsPerWeek: true,
            minutesPerLesson: true,
            lessonLengths: true,
            recurrence: true,
            startDate: true,
            endDate: true,
            blockId: true,
          },
        }),
        tx.teachingBlock.findMany({ where: { academicYearId }, select: { id: true, name: true } }),
      ]);

    const signature = new Map(employments.map((e) => [e.userId, (e.signature ?? '').trim() || null]));
    const participants = new Map<string, string[]>();
    for (const l of lessons) participants.set(l.id, l.participants.map((p) => p.studentId));
    const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const ctx: PlanContext = {
      year: {
        id: year.id,
        name: year.name,
        start: iso(year.startDate)!,
        end: iso(year.endDate)!,
        numbering: year.gradeNumbering ?? 'NIOARIG',
      },
      groups: groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind, gradeLevel: g.gradeLevel, halfOfId: g.halfOfId })),
      subjects,
      rooms,
      teachers: users.map((u) => ({ ...u, signature: signature.get(u.id) ?? null })),
      existing: lessons.map((l): ExistingLesson => ({
        id: l.id,
        groupId: l.studentGroupId,
        subjectId: l.subjectId,
        teacherId: l.teacherId,
        coTeacherId: l.coTeacherId,
        roomId: l.roomId,
        day: l.dayOfWeek,
        startMin: minutes(l.startTime),
        endMin: minutes(l.endTime),
        weeks: PATTERN_OF[l.recurrence],
        from: iso(l.startDate),
        to: iso(l.endDate),
        extraGroupIds: l.extraGroups.map((e) => e.studentGroupId),
        isLocked: l.isLocked,
        isGenerated: l.isGenerated,
      })),
      frames: frames.map((f) => ({ minGradeLevel: f.minGradeLevel, maxGradeLevel: f.maxGradeLevel, dayOfWeek: f.dayOfWeek, startMin: minutes(f.startTime), endMin: minutes(f.endTime) })),
      rasts: rasts.map((r) => ({ name: r.name, minGradeLevel: r.minGradeLevel, maxGradeLevel: r.maxGradeLevel, dayOfWeek: r.dayOfWeek, startMin: minutes(r.startTime), endMin: minutes(r.endTime) })),
      lunch: lunch ? { enabled: lunch.lunchEnabled, startMin: minutes(lunch.lunchStartTime), endMin: minutes(lunch.lunchEndTime), minutes: lunch.lunchMinutes } : null,
      servings: servings.map((s) => ({ minGradeLevel: s.minGradeLevel, maxGradeLevel: s.maxGradeLevel, dayOfWeek: s.dayOfWeek, startMin: minutes(s.startTime), endMin: minutes(s.endTime) })),
      sittings: sittings.map((s) => ({ groupId: s.studentGroupId, day: s.dayOfWeek, startMin: minutes(s.startTime), endMin: minutes(s.endTime) })),
      requirements: requirements.map((r): RequirementRow => ({
        id: r.id,
        groupId: r.studentGroupId,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        coTeacherId: r.coTeacherId,
        lessonsPerWeek: r.lessonsPerWeek,
        minutesPerLesson: r.minutesPerLesson,
        lessonLengths: r.lessonLengths,
        recurrence: PATTERN_OF[r.recurrence],
        from: iso(r.startDate),
        to: iso(r.endDate),
        blockId: r.blockId,
      })),
      blocks,
      spans: new Map(),
    };
    return {
      ctx,
      year: { isActive: year.isActive, predecessorId: year.predecessorId },
      schoolId: year.schoolId,
      schoolName: year.school.name,
      mode: await publishModeOf(tx, year.schoolId),
      participants,
      blocksById: new Map(blocks.map((b) => [b.id, b])),
    };
  }
}

// ---------------------------------------------------------------------------

function timeOf(minutes: number): Date {
  return new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
}

/** The lesson as the clash scan's `alongside` wants it: a lesson accepted earlier in the file. */
function dayLessonOf(l: ResolvedLesson, id: string): DayLesson {
  return {
    id,
    teacherId: l.teacherIds[0] ?? null,
    coTeacherId: l.teacherIds[1] ?? null,
    roomId: l.roomId,
    studentGroupId: l.group.id,
    subjectId: l.subject.id,
    startTime: timeOf(l.startMin),
    endTime: timeOf(l.endMin),
    recurrence: RECURRENCE_OF[l.weeks],
    startDate: l.from ? new Date(`${l.from}T00:00:00.000Z`) : null,
    endDate: l.to ? new Date(`${l.to}T00:00:00.000Z`) : null,
    subject: { name: l.subject.name },
    extraGroups: l.extraGroups.map((g) => ({ studentGroupId: g.id })),
    participants: [],
  };
}

function blockNameOf(ctx: PlanContext, blocks: ReadonlyMap<string, BlockRow>, groupId: string, subjectId: string): string | null {
  const post = ctx.requirements.find((r) => r.groupId === groupId && r.subjectId === subjectId);
  return post?.blockId ? (blocks.get(post.blockId)?.name ?? null) : null;
}

/**
 * Decides which blocks the new posts join, and which blocks are new.
 *
 * A block's members must agree on lessons and weeks (the database holds them
 * to it: TB409), so a block is made only when every new member of it has the
 * same shape, and a new post joins an existing block only when it matches one
 * of that block's posts. Otherwise the posts are made without the block and
 * the preview says so.
 */
function settleBlocks(
  plans: RequirementPlan[],
  ctx: PlanContext,
  warnings: PlanWarning[],
): { plans: RequirementPlan[]; newBlocks: string[] } {
  const shapeOf = (q: { lessonsPerWeek: number; minutesPerLesson: number; lessonLengths: number[]; recurrence: WeekPattern; from: string | null; to: string | null }) =>
    [q.lessonsPerWeek, q.minutesPerLesson, q.lessonLengths.join('+'), q.recurrence, q.from ?? '', q.to ?? ''].join('|');
  const byBlock = new Map<string, RequirementPlan[]>();
  for (const q of plans) if (q.action === 'CREATE' && q.block) byBlock.set(q.block, [...(byBlock.get(q.block) ?? []), q]);
  const newBlocks: string[] = [];
  const existing = new Map(ctx.blocks.map((b) => [b.name, b.id]));
  for (const [name, members] of byBlock) {
    const shapes = new Set(members.map(shapeOf));
    const blockId = existing.get(name);
    let ok = shapes.size === 1;
    if (ok && blockId) {
      const others = ctx.requirements.filter((r) => r.blockId === blockId);
      ok = others.length === 0 || others.every((o) => shapeOf(o) === [...shapes][0]);
    }
    if (!ok) {
      warnings.push({
        code: 'BLOCK_MEMBERS_DIFFER',
        params: { block: name },
        detail: `Blocket ${name}: posternas lektioner och veckor stämmer inte överens, så posterna lades utan block.`,
      });
      for (const q of members) q.block = null;
    } else if (!blockId) {
      newBlocks.push(name);
    }
  }
  // A post that exists keeps the block it has; the lessons' block column never moves it.
  return { plans, newBlocks: newBlocks.sort() };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The year as an ExchangeDocument. A teacher with no signature is given a
 * short name made from the name (initials, then a number if taken), flagged by
 * nothing in the file itself: the summary says how many there are, and the
 * made-up names do not match a signature on the way back, so an import
 * falls back on the e-mail address where the format carries one.
 */
export function documentOf(schoolName: string, ctx: PlanContext, blocks: ReadonlyMap<string, BlockRow>): ExchangeDocument {
  const idx = indexContext(ctx);
  const used = new Set(ctx.teachers.map((t) => (t.signature ?? '').toLowerCase()).filter((s) => s !== ''));
  const shortOf = new Map<string, string>();
  const teacherRef = (id: string): TeacherRef => {
    const t = idx.teachersById.get(id)!;
    let short = t.signature;
    if (!short) {
      short = shortOf.get(id) ?? '';
      if (!short) {
        const base = `${t.firstName.slice(0, 2)}${t.lastName.slice(0, 2)}`.toUpperCase() || 'XX';
        short = base;
        for (let n = 2; used.has(short.toLowerCase()); n += 1) short = `${base}${n}`;
        used.add(short.toLowerCase());
        shortOf.set(id, short);
      }
    }
    return { short, name: `${t.firstName} ${t.lastName}`.trim(), email: t.email, id: t.id };
  };

  const lessons: ExchangeLesson[] = ctx.existing.map((e) => {
    const group = idx.groupsById.get(e.groupId)!;
    const subject = idx.subjectsById.get(e.subjectId)!;
    const room = e.roomId ? idx.roomsById.get(e.roomId) : undefined;
    const extras = e.extraGroupIds.map((id) => idx.groupsById.get(id)).filter((g): g is GroupRow => g !== undefined);
    return {
      ref: '',
      group: group.name,
      extraGroups: extras.map((g) => g.name),
      subject: subject.name,
      subjectCode: subject.code,
      teachers: [e.teacherId, e.coTeacherId].filter((id): id is string => id !== null).map(teacherRef),
      room: room?.name ?? null,
      day: e.day,
      start: clockOfMinutes(e.startMin),
      end: clockOfMinutes(e.endMin),
      weeks: e.weeks,
      from: e.from,
      to: e.to,
      block: blockNameOf(ctx, blocks, e.groupId, e.subjectId),
      ids: {
        lesson: e.id,
        group: group.id,
        extraGroups: extras.map((g) => g.id),
        subject: subject.id,
        room: room?.id ?? null,
      },
    };
  });
  const named = new Set(lessons.flatMap((l) => l.teachers.map((t) => t.id)));
  const teachers = ctx.teachers
    .filter((t) => t.isActive || named.has(t.id))
    .filter((t) => named.has(t.id) || t.signature)
    .map((t) => teacherRef(t.id));
  const nameOf = (id: string | null): string | null => (id ? (idx.groupsById.get(id)?.name ?? null) : null);
  return {
    school: schoolName,
    year: { name: ctx.year.name, start: ctx.year.start, end: ctx.year.end },
    lessons,
    groups: ctx.groups.map((g) => ({ name: g.name, kind: g.kind, gradeLevel: g.gradeLevel, halfOf: nameOf(g.halfOfId) })),
    subjects: ctx.subjects.map((s) => ({ name: s.name, code: s.code })),
    rooms: ctx.rooms.map((r) => r.name),
    teachers,
  };
}

