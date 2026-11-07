import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  MasterLessonsService,
  type MasterLessonConflict,
  type MasterLessonResult,
} from '../calendar/master-lessons.service';
import { propagateTemplateChange } from '../calendar/propagate-template';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { requireSchoolId } from '../common/utils/request-context';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { parseTimeString } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requirementName } from '../optimization/optimization-proxy.service';
import { lockYearsOfLessonsForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import type { ApplySwapDto, SuggestSwapsDto } from './dto/swaps.dto';
import { SwapContext } from './swap-context';
import { dayLessonOf, SwapReads } from './swap-reads';
import { proposalId, searchSwaps } from './swap-search';
import { readSwapData, type SwapData } from './swap-snapshot';
import type {
  ExternalTouch,
  HardCode,
  ParallelLink,
  SoftCost,
  SwapMove,
  SwapProposal,
} from './swap-types';

export const SWAP_STALE = 'SWAP_STALE';
export const SWAP_SPLITS_PARALLEL = 'SWAP_SPLITS_PARALLEL';
export const SWAP_LOCKED = 'SWAP_LOCKED';
export const SWAP_BREAKS_BOARD_RULE = 'SWAP_BREAKS_BOARD_RULE';

/** The most a search may take before it answers with what it has judged. */
const BUDGET_MS = 1500;
const DEFAULT_LIMIT = 12;

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toHHMM = (time: Date): string =>
  `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}`;
const minutesOf = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const toDateOrNull = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** A lesson the page already holds, named for the panel: the label and who is on it. */
export interface SwapLessonView {
  id: string;
  subjectName: string;
  groupName: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  isLocked: boolean;
}

export interface SwapProposalView extends Omit<SwapProposal, 'score'> {
  /** Every lesson the proposal names, once. */
  lessons: SwapLessonView[];
}

export interface SwapSuggestion {
  lessonId: string;
  academicYearId: string;
  /** What the picked lesson moves with: its own parallel lessons. */
  unit: { lessonIds: string[]; links: ParallelLink[] };
  /** The picked lesson stands in a slot the generation keeps: moving it is the schemaläggare's own say. */
  selectedLocked: boolean;
  proposals: SwapProposalView[];
  /** Why there is nothing to offer when the lesson cannot move at all. */
  immovable?: 'PARKED' | 'NOT_PLACED';
  stats: {
    partners: number;
    candidates: number;
    judged: number;
    refused: number;
    /** The time budget or the candidate cap ended the search: there may be more proposals. */
    truncated: boolean;
    /** Chains were tried among the cheapest units on each side only. */
    chainsCut: boolean;
    elapsedMs: number;
    /** Where the time went: the snapshot read, indexing it, warming the roster reads, the search. */
    phasesMs: { read: number; index: number; warm: number; search: number };
  };
}

export interface SwapApplyResult {
  lessons: MasterLessonResult[];
  propagatedLessons: number;
  removedCalendarLessons: number;
  /** The safety version taken before anything moved. */
  versionId: string;
  /** The moves that take it back: send them to the same route. */
  undo: SwapMove[];
}

const WEEKDAY_MAX = 7;

/**
 * Byten och flyttar (G1): swap suggestions and chains of three on the
 * grundschema, and their apply.
 *
 * WHERE THE SEARCH LIVES, AND WHY HERE. The rules a proposal must hold are the
 * hand edit's: findConflicts, the grid's ramtider and meals, the other
 * schools' holds. They are not predicates in the engine — there they are
 * constraints of a model — so asking the engine means rebuilding the school's
 * model for every question, seconds before the first answer, over ids
 * anonymised and realised again. Here the rules are the functions the write
 * path already calls, and every proposal offered has been judged by them as
 * ONE move, the way a block's card is. The engine is untouched: no contract
 * moves, so nothing to deploy beside the API, nothing to switch per school.
 *
 * WHAT IT WRITES. Only through the template's own write path: the lessons'
 * day and clock, the published calendar following (propagateTemplateChange),
 * a change-log row per lesson, a safety version first, the same notice to the
 * classes whose published lessons moved. In a draft layer (DRAFT) it is a
 * draft like any hand edit, and the publish gates read it when it is
 * published.
 */
@Injectable()
export class SwapsService {
  private readonly logger = new Logger(SwapsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterLessons: MasterLessonsService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Suggest
  // ---------------------------------------------------------------------------

  async suggest(dto: SuggestSwapsDto, user: AuthenticatedUser): Promise<SwapSuggestion> {
    const started = Date.now();
    return this.prisma.withRls(user, async (tx) => {
      const picked = await tx.masterLesson.findUnique({
        where: { id: dto.lessonId },
        select: { id: true, academicYearId: true, isParked: true },
      });
      if (!picked) throw new NotFoundException('Master lesson not found.');
      const empty = (immovable: SwapSuggestion['immovable']): SwapSuggestion => ({
        lessonId: picked.id,
        academicYearId: picked.academicYearId,
        unit: { lessonIds: [picked.id], links: [] },
        selectedLocked: false,
        proposals: [],
        immovable,
        stats: {
          partners: 0,
          candidates: 0,
          judged: 0,
          refused: 0,
          truncated: false,
          chainsCut: false,
          elapsedMs: Date.now() - started,
          phasesMs: { read: 0, index: 0, warm: 0, search: 0 },
        },
      });
      if (picked.isParked) return empty('PARKED');

      const read = Date.now();
      const data = await readSwapData(tx, user, picked.academicYearId);
      const indexing = Date.now();
      const context = new SwapContext(data);
      const unit = context.unitOf.get(picked.id);
      if (!unit) return empty('NOT_PLACED');
      const reads = new SwapReads(data.lessons);
      const warming = Date.now();
      await reads.warm(tx, data);
      const searching = Date.now();

      const result = await searchSwaps({
        lessonId: picked.id,
        unitOf: context.unitOf,
        mayStand: (candidate, to, vacating) => context.mayStand(candidate, to, vacating),
        soft: (moves) => context.soft.evaluate(moves),
        judge: async (moves) => {
          if (context.boardVerdict(moves) !== null) return false;
          return (await this.clashesOf(tx, data, context, moves, reads)).length === 0;
        },
        limit: dto.limit ?? DEFAULT_LIMIT,
        budgetMs: BUDGET_MS,
      });

      const proposals = result.proposals.map((proposal) => this.viewOf(data, context, proposal));
      // A teacher's day or week counted against a limit of their post is a read of that post.
      if (proposals.length > 0) {
        const teachers = new Set(
          proposals.flatMap((proposal) =>
            proposal.lessons.flatMap((lesson) => [lesson.teacherId, lesson.coTeacherId]).filter((id): id is string => id !== null),
          ),
        );
        await recordRead(tx, 'EMPLOYMENT', [...teachers].filter((id) => data.postLimited.has(id)), user.channel);
      }

      const partners = new Set([...context.unitOf.values()].map((candidate) => candidate.id)).size - 1;
      return {
        lessonId: picked.id,
        academicYearId: picked.academicYearId,
        unit: { lessonIds: unit.members.map((member) => member.id), links: unit.links },
        selectedLocked: unit.locked,
        proposals,
        stats: {
          partners,
          candidates: result.candidates,
          judged: result.judged,
          refused: result.refused,
          truncated: result.truncated,
          chainsCut: result.chainsCut,
          elapsedMs: Date.now() - started,
          phasesMs: { read: indexing - read, index: warming - indexing, warm: searching - warming, search: Date.now() - searching },
        },
      };
    });
  }

  private viewOf(
    data: SwapData,
    context: SwapContext,
    proposal: { kind: SwapProposal['kind']; moves: SwapMove[]; parallels: SwapProposal['parallels']; soft: SoftCost[] },
  ): SwapProposalView {
    const lessons = proposal.moves.map((move) => {
      const lesson = context.lessonById.get(move.lessonId)!;
      return {
        id: lesson.id,
        subjectName: lesson.subjectName,
        groupName: lesson.groupName,
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        roomId: lesson.roomId,
        isLocked: lesson.isLocked,
      };
    });
    const external: ExternalTouch[] = context.externalTouches(proposal.moves);
    const hard: HardCode[] = ['CLASH'];
    if (data.frames.length > 0) hard.push('FRAME');
    if (data.sittings.length > 0) hard.push('LUNCH');
    if (data.constraints.some((row) => row.resourceType === 'GRADE_LEVEL')) hard.push('GRADE_RULE');
    if (data.holds.length > 0) hard.push('OTHER_SCHOOL');
    return {
      id: proposalId(proposal.moves),
      kind: proposal.kind,
      moves: proposal.moves,
      parallels: proposal.parallels,
      external,
      hard,
      soft: proposal.soft,
      lessons,
    };
  }

  // ---------------------------------------------------------------------------
  // The hard rule, asked of the moves as one move
  // ---------------------------------------------------------------------------

  /**
   * The clash rule (findConflicts) asked of every moving lesson, the others
   * left out of where they stood and laid where they go: the card's way
   * (moveBlockCard). Empty: every lesson of the move is clear of the week and
   * of its fellow movers.
   */
  private async clashesOf(
    tx: PrismaClient,
    data: SwapData,
    context: SwapContext,
    moves: readonly SwapMove[],
    reads?: SwapReads,
  ): Promise<MasterLessonConflict[]> {
    const movingIds = moves.map((move) => move.lessonId);
    // The movers as they will stand. The rule reads `alongside` as lessons of
    // the candidate's own day (a block's card moves to one day), and these go
    // to several: each is laid only beside the movers that land on its day.
    const placed = moves.map((move) => ({ day: move.to.dayOfWeek, row: dayLessonOf(context.lessonById.get(move.lessonId)!, move.to) }));
    for (const move of moves) {
      const lesson = context.lessonById.get(move.lessonId)!;
      const conflicts = await this.masterLessons.findConflicts(
        tx,
        data.basis,
        {
          id: lesson.id,
          academicYearId: data.academicYearId,
          studentGroupId: lesson.studentGroupId,
          subjectId: lesson.subjectId,
        },
        {
          dayOfWeek: move.to.dayOfWeek,
          startMinutes: move.to.startMinutes,
          endMinutes: move.to.endMinutes,
          teacherId: lesson.teacherId,
          coTeacherId: lesson.coTeacherId,
          roomId: lesson.roomId,
          extraGroupIds: lesson.extraGroupIds,
          studentIds: lesson.studentIds,
          recurrence: lesson.recurrence,
          startDate: lesson.startDate ? new Date(`${lesson.startDate}T00:00:00.000Z`) : null,
          endDate: lesson.endDate ? new Date(`${lesson.endDate}T00:00:00.000Z`) : null,
        },
        {
          excludeIds: movingIds,
          alongside: placed.filter((other) => other.day === move.to.dayOfWeek).map((other) => other.row),
          ...(reads ? { reads } : {}),
        },
      );
      if (conflicts.length > 0) {
        const name = requirementName(lesson.subjectName, lesson.groupName);
        return conflicts.map((conflict) => ({ ...conflict, message: `${name}: ${conflict.message}` }));
      }
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  async apply(dto: ApplySwapDto, user: AuthenticatedUser): Promise<SwapApplyResult> {
    try {
      return await this.applyIn(dto, user);
    } catch (error) {
      if (isWriteConflict(error)) throw writeConflict();
      throw error;
    }
  }

  private applyIn(dto: ApplySwapDto, user: AuthenticatedUser): Promise<SwapApplyResult> {
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      const ids = [...new Set(dto.moves.map((move) => move.lessonId))].sort();
      if (ids.length !== dto.moves.length) throw new BadRequestException('moves: a lesson is named twice.');
      if (!ids.includes(dto.lessonId)) throw new BadRequestException('lessonId: the picked lesson is not among the moves.');

      // The edit's share of the year's regeneration lock, then the rows held to
      // COMMIT in id order, before anything is read: the slots compared below
      // are the slots written over.
      await lockYearsOfLessonsForGrundschemaEdit(tx, ids);
      await tx.$queryRaw`
        SELECT 1 FROM "MasterLessons" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`;
      const rows = await tx.masterLesson.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          academicYearId: true,
          subjectId: true,
          studentGroupId: true,
          teacherId: true,
          coTeacherId: true,
          roomId: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          isLocked: true,
          isParked: true,
          recurrence: true,
          startDate: true,
          endDate: true,
          extraGroups: { select: { studentGroupId: true } },
          participants: { select: { studentId: true } },
          school: { select: { id: true, timezone: true } },
        },
        orderBy: { id: 'asc' },
      });
      if (rows.length !== ids.length) throw swapStale();
      const leader = rows[0]!;
      if (rows.some((row) => row.academicYearId !== leader.academicYearId)) throw swapStale();

      const moves: SwapMove[] = dto.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startMinutes: toMinutes(move.from.startTime), endMinutes: toMinutes(move.from.endTime) },
        to: { dayOfWeek: move.to.dayOfWeek, startMinutes: toMinutes(move.to.startTime), endMinutes: toMinutes(move.to.endTime) },
      }));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const move of moves) {
        const row = byId.get(move.lessonId)!;
        const length = move.from.endMinutes - move.from.startMinutes;
        if (move.to.startMinutes >= move.to.endMinutes || move.to.endMinutes - move.to.startMinutes !== length) {
          throw new BadRequestException('moves: a lesson keeps its length.');
        }
        if (move.to.dayOfWeek < 1 || move.to.dayOfWeek > WEEKDAY_MAX) throw new BadRequestException('moves: no such weekday.');
        // Where the page saw it, or the proposal is about a timetable that has moved.
        if (
          row.isParked ||
          row.dayOfWeek !== move.from.dayOfWeek ||
          minutesOf(row.startTime) !== move.from.startMinutes ||
          minutesOf(row.endTime) !== move.from.endMinutes
        ) {
          throw swapStale();
        }
      }

      const data = await readSwapData(tx, user, leader.academicYearId);
      const context = new SwapContext(data);
      this.assertWhole(context, dto.lessonId, moves);

      const board = context.boardVerdict(moves);
      if (board !== null) {
        throw new ConflictException({
          message: 'Bytet skulle lägga en lektion mot en regel som schemat håller. Inget ändrades.',
          code: SWAP_BREAKS_BOARD_RULE,
          rule: board,
        });
      }
      // The write path's own rule, read from the database: the snapshot is the
      // search's, and this is the write.
      const conflicts = await this.clashesOf(tx, data, context, moves);
      if (conflicts.length > 0) {
        throw new ConflictException([...new Set(conflicts.map((conflict) => conflict.message))].join(' '));
      }

      // Before the first write, in THIS transaction: a refused apply leaves no
      // version describing a change that never happened.
      const version = await this.versions.snapshotInTransaction(
        tx,
        leader.academicYearId,
        dto.versionName?.trim() || 'Före byte',
        user,
      );

      const results: MasterLessonResult[] = [];
      let propagatedLessons = 0;
      let removedCalendarLessons = 0;
      const notices: Array<{ before: (typeof rows)[number]; after: MasterLessonResult }> = [];
      for (const move of moves) {
        const row = byId.get(move.lessonId)!;
        const startTime = parseTimeString(clockOf(move.to.startMinutes));
        const endTime = parseTimeString(clockOf(move.to.endMinutes));
        const { count } = await tx.masterLesson.updateMany({
          where: {
            id: row.id,
            dayOfWeek: row.dayOfWeek,
            startTime: row.startTime,
            endTime: row.endTime,
            isParked: false,
          },
          data: { dayOfWeek: move.to.dayOfWeek, startTime, endTime },
        });
        if (count !== 1) throw swapStale();
        const updated = { ...row, dayOfWeek: move.to.dayOfWeek, startTime, endTime };
        const { moved, removed } =
          dto.propagate === false || mode === 'DRAFT'
            ? { moved: 0, removed: 0 }
            : await propagateTemplateChange(tx, row, updated, {
                timezone: row.school.timezone,
                schoolId: row.school.id,
                academicYearId: row.academicYearId,
              });
        propagatedLessons += moved;
        removedCalendarLessons += removed;
        const after = resultOf(updated);
        await tx.scheduleChangeLog.create({
          data: {
            schoolId: row.school.id,
            academicYearId: row.academicYearId,
            masterLessonId: row.id,
            actorId: user.userId ?? null,
            action: 'UPDATE',
            before: resultOf(row) as unknown as Prisma.InputJsonValue,
            after: after as unknown as Prisma.InputJsonValue,
          },
        });
        results.push(after);
        if (moved > 0 || removed > 0) notices.push({ before: row, after });
      }

      this.logger.log(
        `Swap applied [lessons=${moves.length}, propagated=${propagatedLessons}, removed=${removedCalendarLessons}, version=${version.id}]`,
      );
      if (mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(leader.school.id, { draft: true });
      else this.realtime.notifyMasterTimetableChanged(leader.school.id);

      // As a hand edit tells a class its published lessons moved: one notice per
      // lesson, to the roster attending it, about its own subject.
      for (const { before, after } of notices) {
        const recipients = await this.notifications.recipientsForLessons(tx, [
          { subjectId: after.subjectId, groupIds: [before.studentGroupId, ...after.extraGroupIds], participantIds: after.studentIds },
        ]);
        await this.notifications.notifyUsers(tx, {
          schoolId: before.school.id,
          userIds: recipients,
          type: 'SCHEDULE_CHANGED',
          meta: {
            subjectName: context.lessonById.get(before.id)?.subjectName ?? '',
            dayOfWeek: after.dayOfWeek,
            startTime: after.startTime,
            endTime: after.endTime,
          },
        });
      }

      return {
        lessons: results,
        propagatedLessons,
        removedCalendarLessons,
        versionId: version.id,
        undo: moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from })),
      };
    });
  }

  /**
   * The moves are whole: every lesson of every moving unit is among them, the
   * members of a unit land together, and no unit but the picked lesson's is
   * locked. A move set that would split what the school laid together, or move
   * what the generation keeps, is refused by name — never finished on the
   * page's behalf.
   */
  private assertWhole(context: SwapContext, pickedId: string, moves: readonly SwapMove[]): void {
    const moved = new Map(moves.map((move) => [move.lessonId, move]));
    const pickedUnit = context.unitOf.get(pickedId);
    if (!pickedUnit) throw swapStale();
    const units = new Set<string>();
    for (const move of moves) {
      const unit = context.unitOf.get(move.lessonId);
      if (!unit) throw swapStale();
      units.add(unit.id);
      // Where the members that ARE named go; the one asked about is among them, so there is one.
      const landing = moved.get(unit.members.find((member) => moved.has(member.id))!.id)!.to;
      const missing = unit.members.filter((member) => !moved.has(member.id));
      const apart = unit.members.filter((member) => {
        const to = moved.get(member.id)?.to;
        return to !== undefined && (to.dayOfWeek !== landing.dayOfWeek || to.startMinutes !== landing.startMinutes);
      });
      if (missing.length > 0 || apart.length > 0) {
        throw new ConflictException({
          message: `Bytet skulle dela upp lektioner som ligger parallellt: ${[...missing, ...apart]
            .map((lesson) => requirementName(lesson.subjectName, lesson.groupName))
            .join(', ')}. Inget ändrades.`,
          code: SWAP_SPLITS_PARALLEL,
          lessonIds: [...missing, ...apart].map((lesson) => lesson.id),
        });
      }
      if (unit.locked && unit.id !== pickedUnit.id) {
        throw new ConflictException({
          message: 'Bytet skulle flytta en låst lektion. Inget ändrades.',
          code: SWAP_LOCKED,
          lessonIds: unit.members.filter((member) => member.isLocked).map((member) => member.id),
        });
      }
    }
    if (units.size < 2) throw new BadRequestException('moves: a swap moves at least two units.');
  }
}

const toMinutes = (time: string): number => {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

function swapStale(): ConflictException {
  return new ConflictException({
    message: 'Schemat har ändrats sedan förslaget togs fram. Hämta nya förslag.',
    code: SWAP_STALE,
  });
}

interface RowForResult {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  roomId: string | null;
  teacherId: string | null;
  coTeacherId: string | null;
  isLocked: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
}

/** The change log's and the answer's shape for a lesson: MasterLessonsService's toResult. */
function resultOf(lesson: RowForResult): MasterLessonResult {
  return {
    id: lesson.id,
    academicYearId: lesson.academicYearId,
    subjectId: lesson.subjectId,
    studentGroupId: lesson.studentGroupId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    roomId: lesson.roomId,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    isLocked: lesson.isLocked,
    isParked: lesson.isParked,
    recurrence: lesson.recurrence,
    startDate: toDateOrNull(lesson.startDate),
    endDate: toDateOrNull(lesson.endDate),
    extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: lesson.participants.map((entry) => entry.studentId),
  };
}
