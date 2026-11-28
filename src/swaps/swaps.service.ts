import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  LESSON_IS_PLACED,
  MasterLessonsService,
  type MasterLessonConflict,
  type MasterLessonResult,
} from '../calendar/master-lessons.service';
import { propagateTemplateChange } from '../calendar/propagate-template';
import { clashRefusedConflict } from '../calendar/clash-refusal';
import { judgeLessons, type JudgeItem } from '../calendar/lesson-judge';
import { lessonRefusalText } from '../calendar/lesson-refusal';
import { isNewLesson, PossibleTimesService, STORED_LESSON_SELECT } from '../calendar/possible-times.service';
import { exemptionKey, exemptionsOf } from '../calendar/lesson-exemption';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { requireSchoolId } from '../common/utils/request-context';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { parseTimeString } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requirementName } from '../optimization/optimization-proxy.service';
import { lockYearsOfLessonsForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite, publishModeOf } from '../publication/publish-mode';
import { requireDirectReachAnswered } from '../publication/direct-reach';
import { RealtimeService } from '../realtime/realtime.service';
import type { ApplySwapDto, PairSwapDto, SuggestSwapsDto } from './dto/swaps.dto';
import { SwapContext } from './swap-context';
import { lessonsLeftUnlockedByBlock } from './swap-block-lock';
import { removedCalendarLessons } from './swap-calendar';
import { dayLessonOf, SwapReads } from './swap-reads';
import { movesOfUnit, searchMakeRoom } from './swap-make-room';
import { proposalId, searchSwaps } from './swap-search';
import { readSwapData, type SwapData } from './swap-snapshot';
import type {
  ExternalTouch,
  HardCode,
  ParallelLink,
  SoftCost,
  SwapLesson,
  SwapMove,
  SwapProposal,
  SwapSlot,
  SwapUnit,
} from './swap-types';

export const SWAP_STALE = 'SWAP_STALE';
export const SWAP_SPLITS_PARALLEL = 'SWAP_SPLITS_PARALLEL';
export const SWAP_LOCKED = 'SWAP_LOCKED';
export const SWAP_BREAKS_BOARD_RULE = 'SWAP_BREAKS_BOARD_RULE';

/** The most a search may take before it answers with what it has judged. */
const BUDGET_MS = 1500;
const DEFAULT_LIMIT = 12;
/** Gör plats: units in a proposal (the picked one included), landings tried for each unit that has to go, and sets costed in all. */
const ROOM_MAX_UNITS = 6;
const ROOM_PER_UNIT = 8;
const ROOM_MAX_CANDIDATES = 1200;
const ROOM_DEPTH = 3;
const SCHOOL_DAYS = [1, 2, 3, 4, 5];
const SCHOOL_WEEK_END = 5;

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
  /** MAKE_ROOM: the level of each lesson that moves, by lesson id: 0 is the picked lesson, 1 what stood in its way, 2 what stood in the way of that. */
  levels?: Record<string, number>;
  /** MAKE_ROOM: the deepest level of the proposal. */
  depth?: number;
  /**
   * MAKE_ROOM for a lesson that stands nowhere (a brick, or a lesson on the tray): where it is laid once the moves have made room. It is
   * not among `moves`, which are the lessons that stand and have to go; the page lays it by the road a lesson is laid by.
   */
  lay?: { lessonId: string | null; subjectName: string; groupName: string; teacherId: string | null; coTeacherId: string | null; roomId: string | null; slot: SwapSlot };
  /**
   * The published calendar lessons applying it would REMOVE instead of move —
   * a lesson the move would carry to a time that has begun — with the vikarie,
   * lesson log and homework on them. Undo puts the master lessons back and not
   * these. Zero in a draft layer, where the calendar is not touched until the
   * draft is published.
   */
  removedCalendarLessons: number;
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
  /** PLACED: Generera wrote it from a förläggning on its timplanspost, which is where it moves (Förlagda poster). */
  /** EXEMPT (Gör plats): the lesson carries a deliberate exemption, which an automat does not move it out of: the schemaläggare moves it by hand. */
  immovable?: 'PARKED' | 'NOT_PLACED' | 'PLACED' | 'EXEMPT';
  /**
   * Gör plats: what the asked time holds, said whether or not there is a proposal. `stuck` is why nothing could be offered when that is known
   * before a single move is tried: the time is shut by a rule (CLOSED), a lesson the generation keeps stands in the way (LOCKED_IN_THE_WAY),
   * or more lessons stand in the way than a proposal may move (TOO_MANY).
   */
  makeRoom?: {
    target: SwapSlot;
    blockers: Array<{ lessonIds: string[]; subjectName: string; groupName: string; isLocked: boolean }>;
    stuck?: 'CLOSED' | 'LOCKED_IN_THE_WAY' | 'TOO_MANY';
    depth: number;
    /** Landings were tried for the units that go among the ones that stand in the way of fewest others, and the rest were not asked. */
    landingsCut: boolean;
  };
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

/** A reason a lesson cannot stand where the other lesson of a swap of two stands: the judge's own, with the sentence it is told in. */
export interface SwapPairRefusal {
  lessonId: string;
  reason: string;
  params: Record<string, string | number>;
  text: string;
}

/** Byt plats: two marked lessons that each take the other's start. */
export interface SwapPair {
  academicYearId: string;
  ok: boolean;
  /** The swap, with what it costs, when both lessons stand where the other stands. */
  proposal?: SwapProposalView;
  /** When they do not: every reason, by lesson, the heaviest first. */
  refusals: SwapPairRefusal[];
  /**
   * There is no swap to judge: a lesson is on the tray (PARKED), written from a förläggning (PLACED), or stands nowhere in the year
   * (NOT_PLACED); the two lessons move as one (SAME_UNIT: a parallel block's, a half's) or already stand at one start (SAME_PLACE).
   */
  immovable?: 'PARKED' | 'PLACED' | 'NOT_PLACED' | 'SAME_UNIT' | 'SAME_PLACE';
  immovableLessonId?: string;
}

export interface SwapApplyResult {
  lessons: MasterLessonResult[];
  propagatedLessons: number;
  removedCalendarLessons: number;
  /** The safety version taken before anything moved. */
  versionId: string;
  /** The moves that take it back: send them to the same route. */
  undo: SwapMove[];
  /**
   * Undantag med flit: a moved lesson that stood against a rule of the board on purpose lost it (MasterLessons_exemption_ends: an exemption is for the
   * time it was given for). `rules` are the names, comma-joined, as on a PATCH's EXEMPTION_ENDED. Empty when no moved lesson had one.
   */
  exemptionsEnded: Array<{ lessonId: string; rules: string }>;
  /**
   * Låset vid en flytt (E4, beslut 2), as a PATCH says it: the swap locked the lessons it moved that were not locked, so that the next Generera does
   * not lay them where they stood. `lockedLessonIds` are those lessons (not one that was locked already); `lockedByMove` is said only when there
   * are any. The undo (the same moves reversed) takes the lock off what the swap locked.
   */
  lockedLessonIds: string[];
  lockedByMove?: true;
}

const WEEKDAY_MAX = 7;

/** A clash `clashesOf` found: the rule's own hit, and what the refusal needs of the lesson it was found for. */
type ClashOf = MasterLessonConflict & { requirement: string; groupIds: string[]; slot: SwapSlot };

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
  /**
   * E3's reading of the school for a lesson or a brick (the subject, the context with its closed weeks and shared rooms): Gör plats
   * and Byt plats ask the same questions of the same snapshot, so they ask them of the same code. Made here rather than injected: it
   * holds nothing but the two services it is given, and CalendarModule need not export it for this.
   */
  private readonly possible: PossibleTimesService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterLessons: MasterLessonsService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {
    this.possible = new PossibleTimesService(prisma, masterLessons);
  }

  // ---------------------------------------------------------------------------
  // Suggest
  // ---------------------------------------------------------------------------

  async suggest(dto: SuggestSwapsDto, user: AuthenticatedUser): Promise<SwapSuggestion> {
    if ((dto.lessonId === undefined) === (dto.brick === undefined)) throw new BadRequestException('Name either lessonId or brick, and not both.');
    if (dto.brick !== undefined && dto.makeRoom === undefined) {
      throw new BadRequestException('A brick has no place to swap with: ask it with makeRoom.');
    }
    if (dto.makeRoom !== undefined) return this.suggestRoom(dto, user);
    return this.suggestSwaps({ ...dto, lessonId: dto.lessonId! }, user);
  }

  /** The swaps and chains of three a lesson can take part in (G1). */
  private async suggestSwaps(dto: SuggestSwapsDto & { lessonId: string }, user: AuthenticatedUser): Promise<SwapSuggestion> {
    const started = Date.now();
    return this.prisma.withRls(user, async (tx) => {
      const picked = await tx.masterLesson.findUnique({
        where: { id: dto.lessonId },
        select: { id: true, academicYearId: true, isParked: true, fromPlacement: true, school: { select: { timezone: true } } },
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
      // Förlagda poster: the next Generera writes it again where its
      // förläggning stands, so a swap would be undone without a word (review
      // of #293, LÅG-2). It moves on the timplan, not here.
      if (picked.fromPlacement) return empty('PLACED');

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

      const viewed = result.proposals.map((proposal) => this.viewOf(data, context, proposal));
      // What each would take out of the published calendar, said before it is applied. A draft layer
      // leaves the calendar alone until it is published, so there is nothing to say then.
      const removals =
        viewed.length > 0 && (await publishModeOf(tx, data.schoolId)) !== 'DRAFT'
          ? await removedCalendarLessons(
              tx,
              viewed.map((proposal) => proposal.moves),
              context.lessonById,
              picked.school.timezone,
            )
          : viewed.map(() => 0);
      const proposals = viewed.map((proposal, index) => ({ ...proposal, removedCalendarLessons: removals[index] ?? 0 }));
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
  ): Omit<SwapProposalView, 'removedCalendarLessons'> {
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
  // Gör plats (E5a): what has to move for a lesson to stand at a time
  // ---------------------------------------------------------------------------

  /**
   * The sets of moves that make room for a lesson (or a brick, or a lesson on the tray) at the asked time: the search is swap-make-room.ts, the
   * order is the swap search's own soft measure (the figures a proposal carries are the figures it is ordered by), and the verdict is E1's judge,
   * asked of each set as ONE move. Nothing is written.
   *
   * A lesson the generation keeps is never moved (the search holds the lock as a wall), and nor is a lesson with an exemption (an exemption is
   * locked as long as it holds, so it is the same wall); the picked lesson itself, when it carries one, is not moved either: moving it would
   * take its exemption away from a proposal nobody asked it of, so it is answered EXEMPT and moved by hand.
   */
  private async suggestRoom(dto: SuggestSwapsDto, user: AuthenticatedUser): Promise<SwapSuggestion> {
    const started = Date.now();
    const ask = dto.makeRoom!;
    return this.prisma.withRls(user, async (tx) => {
      const found = await this.possible.subjectOf(tx, dto);
      const lesson = found.lesson.lesson;
      const unplaced = found.lesson.unplaced;
      const nothing = (immovable?: SwapSuggestion['immovable']): SwapSuggestion => ({
        lessonId: found.view.lessonId ?? '',
        academicYearId: found.academicYearId,
        unit: { lessonIds: found.view.lessonId ? [found.view.lessonId] : [], links: [] },
        selectedLocked: false,
        proposals: [],
        ...(immovable ? { immovable } : {}),
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
      // A lesson Generera wrote from a förläggning is moved on the timplan.
      if (found.placed) return nothing('PLACED');

      const reading = Date.now();
      const data = await readSwapData(tx, user, found.academicYearId);
      const indexing = Date.now();
      const context = await this.possible.contextOf(tx, data, unplaced ? [lesson] : []);
      const unit = context.unitOf.get(lesson.id);
      if (!unit) return nothing('NOT_PLACED');
      if (!unplaced) {
        const exempt = await tx.masterLesson.findMany({ where: { id: { in: unit.members.map((member) => member.id) } }, select: { exemptFrom: true } });
        if (exempt.some((row) => exemptionsOf(row.exemptFrom).length > 0)) return nothing('EXEMPT');
      }
      const reads = new SwapReads(data.lessons);
      const warming = Date.now();
      await reads.warm(tx, data);
      const searching = Date.now();

      const length = unit.slot.endMinutes - unit.slot.startMinutes;
      const at: SwapSlot = { dayOfWeek: ask.dayOfWeek, startMinutes: clockMinutes(ask.startTime), endMinutes: clockMinutes(ask.startTime) + length };
      const unplacedIds = new Set(unplaced ? [lesson.id] : []);
      const depth = ask.depth ?? ROOM_DEPTH;
      const result = await searchMakeRoom({
        picked: unit,
        placed: !unplaced,
        target: { dayOfWeek: at.dayOfWeek, startMinutes: at.startMinutes },
        unitOf: context.unitOf,
        starts: [...new Set(data.lessons.map((placed) => placed.startMinutes))].sort((a, b) => a - b),
        days: SCHOOL_DAYS,
        world: {
          inTheWay: (moving, to) => {
            const vacating = new Set(moving.members.map((member) => member.id));
            const lessons = new Map<string, SwapLesson>();
            let closed = false;
            for (const landing of context.landingsOf(moving, to)) {
              const way = context.inTheWay(landing, vacating);
              for (const other of way.lessons) lessons.set(other.id, other);
              if (way.closures.length > 0 || context.boardRefusal(landing) !== null) closed = true;
            }
            return { lessons: [...lessons.values()], closed };
          },
          landingsClash: (a, b) => context.landingsOf(a.unit, a.to).some((left) => context.landingsOf(b.unit, b.to).some((right) => context.landingsClash(left, right))),
        },
        soft: (moves) => context.soft.evaluate(moves),
        judge: (sets) => this.judgeSets(tx, data, context, sets, reads, unplacedIds),
        limit: dto.limit ?? DEFAULT_LIMIT,
        budgetMs: BUDGET_MS,
        depth,
        maxUnits: ROOM_MAX_UNITS,
        perUnit: ROOM_PER_UNIT,
        maxCandidates: ROOM_MAX_CANDIDATES,
      });

      const viewed = result.proposals.map((proposal) => {
        const standing = proposal.moves.filter((move) => !unplacedIds.has(move.lessonId));
        const view = this.viewOf(data, context, {
          kind: 'MAKE_ROOM',
          moves: standing,
          parallels: proposal.units.flatMap((moving) => moving.links.map((link) => ({ ...link, outcome: 'FOLLOWS' as const }))),
          // A lesson that is laid is not "moved": the count of moved lessons is the lessons that stood.
          soft: unplaced ? proposal.soft.map((cost) => (cost.code === 'MOVED_LESSONS' ? { ...cost, after: cost.after - 1, delta: cost.delta - 1 } : cost)) : proposal.soft,
        });
        return {
          ...view,
          // The name of the whole set, the laid lesson's landing included: two sets that differ only there are two proposals.
          id: proposalId(proposal.moves),
          levels: Object.fromEntries(proposal.units.flatMap((moving) => moving.members.filter((member) => !unplacedIds.has(member.id)).map((member) => [member.id, proposal.levels[moving.id] ?? 0]))),
          depth: proposal.depth,
          ...(unplaced
            ? {
                lay: {
                  lessonId: isNewLesson(lesson.id) ? null : lesson.id,
                  subjectName: lesson.subjectName,
                  groupName: lesson.groupName,
                  teacherId: lesson.teacherId,
                  coTeacherId: lesson.coTeacherId,
                  roomId: lesson.roomId,
                  slot: at,
                },
              }
            : {}),
        };
      });
      const timezone = viewed.length > 0 ? await this.timezoneOf(tx, data.schoolId) : null;
      const removals =
        timezone !== null && (await publishModeOf(tx, data.schoolId)) !== 'DRAFT'
          ? await removedCalendarLessons(tx, viewed.map((proposal) => proposal.moves), context.lessonById, timezone)
          : viewed.map(() => 0);
      const proposals = viewed.map((proposal, index) => ({ ...proposal, removedCalendarLessons: removals[index] ?? 0 }));
      await this.recordPostReads(tx, data, proposals, user);

      const nameOf = (blocking: SwapUnit) => ({
        lessonIds: blocking.members.map((member) => member.id),
        subjectName: blocking.members[0]!.subjectName,
        groupName: blocking.members[0]!.groupName,
        isLocked: blocking.locked,
      });
      return {
        lessonId: isNewLesson(lesson.id) ? '' : lesson.id,
        academicYearId: found.academicYearId,
        unit: { lessonIds: unplaced && isNewLesson(lesson.id) ? [] : unit.members.map((member) => member.id), links: unit.links },
        selectedLocked: unit.locked,
        proposals,
        makeRoom: {
          target: at,
          blockers: result.blockers.map(nameOf),
          ...(result.stuck ? { stuck: result.stuck } : {}),
          depth,
          landingsCut: result.landingsCut,
        },
        stats: {
          partners: new Set([...context.unitOf.values()].map((candidate) => candidate.id)).size - 1,
          candidates: result.candidates,
          judged: result.judged,
          refused: result.refused,
          truncated: result.truncated,
          chainsCut: false,
          elapsedMs: Date.now() - started,
          phasesMs: { read: indexing - reading, index: warming - indexing, warm: searching - warming, search: Date.now() - searching },
        },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Byt plats (E5a): two marked lessons, each taking the other's start
  // ---------------------------------------------------------------------------

  /**
   * Two lessons the schemaläggare marked trade starts: each lesson (with the lessons beside it) goes to the day and clock where the other
   * stands and keeps its own length, so a lesson of an hour and one of three quarters swap when both fit where the other was, and are refused,
   * by the judge's own reasons, when one does not. The two are judged as ONE move (each is gone from where it stood when the other is asked
   * of), by E1's judge. A lesson the generation keeps may be swapped: it is the person's hand, as a PATCH is; the swap locks them, as every
   * hand move does. Nothing is written.
   */
  async pair(dto: PairSwapDto, user: AuthenticatedUser): Promise<SwapPair> {
    if (dto.lessonId === dto.otherLessonId) throw new BadRequestException('Name two different lessons.');
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.masterLesson.findMany({ where: { id: { in: [dto.lessonId, dto.otherLessonId] } }, select: STORED_LESSON_SELECT });
      const first = rows.find((row) => row.id === dto.lessonId);
      const second = rows.find((row) => row.id === dto.otherLessonId);
      if (!first || !second) throw new NotFoundException('Master lesson not found.');
      if (first.academicYearId !== second.academicYearId) throw new BadRequestException('The lessons are not of one läsår.');
      const academicYearId = first.academicYearId;
      const cannot = (immovable: NonNullable<SwapPair['immovable']>, lessonId: string): SwapPair => ({
        academicYearId,
        ok: false,
        refusals: [],
        immovable,
        immovableLessonId: lessonId,
      });
      for (const row of [first, second]) {
        if (row.isParked) return cannot('PARKED', row.id);
        // Generera writes it again where its förläggning stands, so a swap would be undone without a word (see suggestSwaps).
        if (row.fromPlacement) return cannot('PLACED', row.id);
      }
      const data = await readSwapData(tx, user, academicYearId);
      const context = await this.possible.contextOf(tx, data, []);
      const left = context.unitOf.get(first.id);
      const right = context.unitOf.get(second.id);
      if (!left) return cannot('NOT_PLACED', first.id);
      if (!right) return cannot('NOT_PLACED', second.id);
      if (left.id === right.id) return cannot('SAME_UNIT', first.id);
      // Each takes the other's START and keeps its length, so two lessons that begin at one clock of one day (a lesson of an hour and one of three
      // quarters, say) have nothing to trade: the moves would be from each place to itself (g514).
      if (left.slot.dayOfWeek === right.slot.dayOfWeek && left.slot.startMinutes === right.slot.startMinutes) return cannot('SAME_PLACE', first.id);

      const moves = [...movesOfUnit(left, right.slot), ...movesOfUnit(right, left.slot)];
      const reads = new SwapReads(data.lessons);
      await reads.warm(tx, data);
      const verdicts = await judgeLessons(tx, this.masterLessons, this.judgeWorld(data), this.itemsOf(context, moves, new Set()), { reads });
      const refusals = verdicts.flatMap((verdict, index) =>
        verdict.refusals.map((refusal) => ({ lessonId: moves[index]!.lessonId, reason: refusal.reason, params: refusal.params, text: lessonRefusalText(refusal) })),
      );
      if (refusals.length > 0) return { academicYearId, ok: false, refusals };

      const { costs } = context.soft.evaluate(moves);
      const view = this.viewOf(data, context, {
        kind: 'SWAP',
        moves,
        parallels: [left, right].flatMap((moving) => moving.links.map((link) => ({ ...link, outcome: 'FOLLOWS' as const }))),
        soft: costs,
      });
      const removed =
        (await publishModeOf(tx, data.schoolId)) !== 'DRAFT'
          ? await removedCalendarLessons(tx, [moves], context.lessonById, await this.timezoneOf(tx, data.schoolId))
          : [0];
      const proposal = { ...view, removedCalendarLessons: removed[0] ?? 0 };
      await this.recordPostReads(tx, data, [proposal], user);
      return { academicYearId, ok: true, proposal, refusals: [] };
    });
  }

  private async timezoneOf(tx: PrismaClient, schoolId: string): Promise<string> {
    const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
    return school?.timezone ?? 'Europe/Stockholm';
  }

  /** A teacher's day or week counted against a limit of their post is a read of that post. */
  private async recordPostReads(tx: PrismaClient, data: SwapData, proposals: ReadonlyArray<{ lessons: SwapLessonView[] }>, user: AuthenticatedUser): Promise<void> {
    if (proposals.length === 0) return;
    const teachers = new Set(
      proposals.flatMap((proposal) => proposal.lessons.flatMap((lesson) => [lesson.teacherId, lesson.coTeacherId]).filter((id): id is string => id !== null)),
    );
    await recordRead(tx, 'EMPLOYMENT', [...teachers].filter((id) => data.postLimited.has(id)), user.channel);
  }

  private judgeWorld(data: SwapData) {
    return { academicYearId: data.academicYearId, schoolId: data.schoolId, basis: data.basis, gradeNumbering: data.gradeNumbering };
  }

  /**
   * The judge's items for a set of moves asked as ONE move (the card's way): every moving lesson is left out of where it stood and laid, for
   * the others, where it goes. A lesson that stands nowhere (a brick, a lesson on the tray: `unplacedIds`) has no place to "låt stå" from, so
   * every rule is asked of it, and a brick has no id to leave out.
   */
  private itemsOf(context: SwapContext, moves: readonly SwapMove[], unplacedIds: ReadonlySet<string>): JudgeItem[] {
    const dateOf = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);
    const movingIds = moves.map((move) => move.lessonId).filter((id) => !isNewLesson(id));
    const landed = moves.map((move) => ({ id: move.lessonId, day: move.to.dayOfWeek, row: dayLessonOf(context.lessonById.get(move.lessonId)!, move.to) }));
    return moves.map((move) => {
      const lesson = context.lessonById.get(move.lessonId)!;
      const weeks = { recurrence: lesson.recurrence, startDate: dateOf(lesson.startDate), endDate: dateOf(lesson.endDate) };
      return {
        lesson: { id: isNewLesson(lesson.id) ? null : lesson.id, studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId },
        candidate: {
          dayOfWeek: move.to.dayOfWeek,
          startMinutes: move.to.startMinutes,
          endMinutes: move.to.endMinutes,
          teacherId: lesson.teacherId,
          coTeacherId: lesson.coTeacherId,
          roomId: lesson.roomId,
          extraGroupIds: lesson.extraGroupIds,
          studentIds: lesson.studentIds,
          ...weeks,
        },
        stands: unplacedIds.has(lesson.id)
          ? null
          : {
              dayOfWeek: lesson.dayOfWeek,
              startMinutes: lesson.startMinutes,
              endMinutes: lesson.endMinutes,
              teacherId: lesson.teacherId,
              coTeacherId: lesson.coTeacherId,
              roomId: lesson.roomId,
              extraGroupIds: lesson.extraGroupIds,
              ...weeks,
            },
        excludeIds: movingIds,
        alongside: landed.filter((other) => other.id !== move.lessonId && other.day === move.to.dayOfWeek).map((other) => other.row),
      };
    });
  }

  /** The judge's verdict on each set of moves, each as ONE move: one call for all the sets, the board's facts read once per weekday. */
  private async judgeSets(
    tx: PrismaClient,
    data: SwapData,
    context: SwapContext,
    sets: ReadonlyArray<readonly SwapMove[]>,
    reads: SwapReads,
    unplacedIds: ReadonlySet<string>,
  ): Promise<boolean[]> {
    const owner: number[] = [];
    const items = sets.flatMap((moves, index) => {
      const own = this.itemsOf(context, moves, unplacedIds);
      for (let at = 0; at < own.length; at += 1) owner.push(index);
      return own;
    });
    const verdicts = await judgeLessons(tx, this.masterLessons, this.judgeWorld(data), items, { reads });
    const ok = sets.map(() => true);
    verdicts.forEach((verdict, index) => {
      if (!verdict.ok) ok[owner[index]!] = false;
    });
    return ok;
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
  ): Promise<ClashOf[]> {
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
        return conflicts.map((conflict) => ({
          ...conflict,
          message: `${name}: ${conflict.message}`,
          // What the refusal names the lesson and its place by (lesson-refusal.ts clashRefusedConflict).
          requirement: name,
          groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
          slot: move.to,
        }));
      }
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  async apply(dto: ApplySwapDto, user: AuthenticatedUser): Promise<SwapApplyResult> {
    // One move is a proposal only when it makes room for a lesson that stands nowhere (forBrick); a swap moves two, said before anything is read.
    if (dto.forBrick !== true && dto.moves.length < 2) throw new BadRequestException('moves: a swap moves at least two lessons.');
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
      // The lessons the schemaläggare chose themselves, and so may be locked: the picked one and, for a swap of two marked, the other. With
      // forBrick the moves make room for a lesson that stands nowhere and no lesson of them was chosen: every one is an automat's to move.
      const chosen = dto.forBrick === true ? [] : [dto.lessonId, ...(dto.alsoPicked ?? [])];
      if (chosen.some((id) => !ids.includes(id))) throw new BadRequestException('lessonId: the picked lesson is not among the moves.');

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
          fromPlacement: true,
          exemptFrom: true,
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
      // Förlagda poster: never moved by a swap, picked or not (see suggest).
      const placedRows = rows.filter((row) => row.fromPlacement);
      if (placedRows.length > 0) {
        throw new ConflictException({
          message:
            'Bytet skulle flytta en lektion som är förlagd på timplanen; Generera skriver om den därifrån. Ändra förläggningen på timplansposten i stället. Inget ändrades.',
          code: LESSON_IS_PLACED,
          lessonIds: placedRows.map((row) => row.id),
        });
      }
      const leader = rows[0]!;
      if (rows.some((row) => row.academicYearId !== leader.academicYearId)) throw swapStale();

      // The minutes are the parsed clocks' — the very values written below — so that
      // the clash rule judges the time that is stored.
      const moves: SwapMove[] = dto.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startMinutes: clockMinutes(move.from.startTime), endMinutes: clockMinutes(move.from.endTime) },
        to: { dayOfWeek: move.to.dayOfWeek, startMinutes: clockMinutes(move.to.startTime), endMinutes: clockMinutes(move.to.endTime) },
      }));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const move of moves) {
        const row = byId.get(move.lessonId)!;
        const length = move.from.endMinutes - move.from.startMinutes;
        if (move.to.startMinutes >= move.to.endMinutes || move.to.endMinutes - move.to.startMinutes !== length) {
          throw new BadRequestException('moves: a lesson keeps its length.');
        }
        if (move.to.dayOfWeek < 1 || move.to.dayOfWeek > WEEKDAY_MAX) throw new BadRequestException('moves: no such weekday.');
        // The school week is Monday to Friday: the judge refuses a Saturday (SCHOOL_DAY) on every other road, and a lesson written there is locked by
        // this very write and sent to the engine as a fixed lesson on a day it does not schedule. Since `forBrick` one move is enough to ask for it (g514).
        if (move.to.dayOfWeek > SCHOOL_WEEK_END) throw new BadRequestException('moves: not a school day (Monday to Friday).');
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
      // Ångra: the lock a swap put on a lesson goes with the swap, so a request that takes the last move of a locked lesson back (where that move
      // found it, and that move was what locked it) is let move it and takes the lock off again. The undo is the same moves reversed.
      const takenBack = await this.locksTakenBack(tx, rows, moves);
      this.assertWhole(context, chosen, moves, takenBack, dto.forBrick === true);
      // A lesson of a parallel block whose other lessons the swap leaves unlocked is not locked (swap-block-lock.ts): Generera refuses a partly locked block.
      const leftUnlocked = lessonsLeftUnlockedByBlock(data, new Set(moves.map((move) => move.lessonId)));

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
        // The hand edit's refusal, said by the same code: the clash and the other lesson by class, subject, day and clock.
        throw clashRefusedConflict(conflicts, (lessonId) => {
          const other = context.lessonById.get(lessonId);
          if (!other) return undefined;
          // A lesson that moves with this one stands where it lands.
          const at = moves.find((move) => move.lessonId === lessonId)?.to ?? other;
          return {
            groupIds: new Set([other.studentGroupId, ...other.extraGroupIds]),
            className: other.groupName,
            subjectName: other.subjectName,
            day: 'dayOfWeek' in at ? at.dayOfWeek : other.dayOfWeek,
            start: at.startMinutes,
            end: at.endMinutes,
          };
        });
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
      const exemptionsEnded: Array<{ lessonId: string; rules: string }> = [];
      const lockedLessonIds: string[] = [];
      let propagatedLessons = 0;
      let removedCalendarLessons = 0;
      const notices: Array<{ before: (typeof rows)[number]; after: MasterLessonResult }> = [];
      for (const move of moves) {
        const row = byId.get(move.lessonId)!;
        const startTime = parseTimeString(clockOf(move.to.startMinutes));
        const endTime = parseTimeString(clockOf(move.to.endMinutes));
        // Låset vid en flytt (E4, beslut 2): a lesson moved by hand is the school's and is locked (a lesson that was locked stays so), or the next
        // Generera lays it again where it stood. An undo that takes back the move that locked it takes the lock off.
        const locks = !row.isLocked && !leftUnlocked.has(row.id);
        const unlocks = takenBack.has(row.id);
        const { count } = await tx.masterLesson.updateMany({
          where: {
            id: row.id,
            dayOfWeek: row.dayOfWeek,
            startTime: row.startTime,
            endTime: row.endTime,
            isParked: false,
          },
          data: { dayOfWeek: move.to.dayOfWeek, startTime, endTime, ...(locks ? { isLocked: true } : unlocks ? { isLocked: false } : {}) },
        });
        if (count !== 1) throw swapStale();
        if (locks) lockedLessonIds.push(row.id);
        // The trigger takes an exemption away from a lesson whose day or clock changes: the answer and the log say so.
        const ended = exemptionsOf(row.exemptFrom);
        if (ended.length > 0) exemptionsEnded.push({ lessonId: row.id, rules: ended.join(',') });
        const updated = { ...row, dayOfWeek: move.to.dayOfWeek, startTime, endTime, ...(locks ? { isLocked: true } : unlocks ? { isLocked: false } : {}) };
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
        const after = resultOf(updated, false);
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

      // Direkt: the swap moved published lessons. The first change in a published period is asked of the school before it goes (P5, beslut 8);
      // the throw rolls the whole swap back, the safety version above included, so nothing has moved and no notice has gone.
      await requireDirectReachAnswered(tx, {
        academicYearId: leader.academicYearId,
        mode,
        reached: propagatedLessons + removedCalendarLessons,
      });

      this.logger.log(
        `Swap applied [lessons=${moves.length}, propagated=${propagatedLessons}, removed=${removedCalendarLessons}, version=${version.id}]`,
      );
      this.announce(tx, leader.school.id, mode, ids);

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
        exemptionsEnded,
        lockedLessonIds,
        ...(lockedLessonIds.length > 0 ? { lockedByMove: true as const } : {}),
      };
    });
  }

  /**
   * The staff room hears of a DIRECT swap, and a DRAFT one is heard of by the school's admins only: said when the transaction has COMMITTED
   * (PrismaService.onCommit), and with the lessons that moved, as MasterLessonsService.announce says a hand edit (g465 L-3). Said inside it, a
   * collaborator who read the year at once could read it before the commit and find the lessons as they were; said without the ids, the page
   * read the whole year again; and said before a refusal that rolled the swap back, it was said for a swap that never happened. A swap that
   * fails or is retried is not announced for the run that did not commit.
   */
  private announce(tx: PrismaClient, schoolId: string, mode: 'DIRECT' | 'DRAFT', lessonIds: readonly string[]): void {
    const say = () => this.realtime.notifyMasterTimetableChanged(schoolId, mode === 'DRAFT' ? { draft: true, lessonIds } : { lessonIds });
    if (!this.prisma.onCommit(tx, async () => say())) say();
  }

  /**
   * The locked lessons among the moves whose lock this request takes back: the lesson's last logged change locked it (it was unlocked before and
   * locked after) and the request moves it from where that change put it to where that change found it. Nothing else lifts a lock a swap must
   * keep its hands off: a lesson locked by hand, or one moved since, is not taken back.
   */
  private async locksTakenBack(
    tx: PrismaClient,
    rows: ReadonlyArray<{ id: string; isLocked: boolean }>,
    moves: readonly SwapMove[],
  ): Promise<Set<string>> {
    const taken = new Set<string>();
    const lockedIds = new Set(rows.filter((row) => row.isLocked).map((row) => row.id));
    for (const move of moves) {
      if (!lockedIds.has(move.lessonId)) continue;
      const last = await tx.scheduleChangeLog.findFirst({
        where: { masterLessonId: move.lessonId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { action: true, before: true, after: true },
      });
      if (!last || last.action !== 'UPDATE') continue;
      const before = last.before as LoggedSlot | null;
      const after = last.after as LoggedSlot | null;
      if (!before || !after || before.isLocked !== false || after.isLocked !== true) continue;
      if (!isLoggedAt(after, move.from) || !isLoggedAt(before, move.to)) continue;
      taken.add(move.lessonId);
    }
    return taken;
  }

  /**
   * The moves are whole: every lesson of every moving unit is among them, the
   * members of a unit land together, and no unit but the picked lesson's is
   * locked. A move set that would split what the school laid together, or move
   * what the generation keeps, is refused by name — never finished on the
   * page's behalf.
   */
  private assertWhole(
    context: SwapContext,
    chosenIds: readonly string[],
    moves: readonly SwapMove[],
    takenBack: ReadonlySet<string> = new Set(),
    forBrick = false,
  ): void {
    const moved = new Map(moves.map((move) => [move.lessonId, move]));
    // The units of the lessons the schemaläggare chose: the only ones that may be locked.
    const chosenUnits = new Set<string>();
    for (const id of chosenIds) {
      const chosenUnit = context.unitOf.get(id);
      if (!chosenUnit) throw swapStale();
      chosenUnits.add(chosenUnit.id);
    }
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
      // A lock the swap this one takes back put there is no lock to keep (takenBack).
      const kept = unit.members.filter((member) => member.isLocked && !takenBack.has(member.id));
      if (kept.length > 0 && !chosenUnits.has(unit.id)) {
        throw new ConflictException({
          message: 'Bytet skulle flytta en låst lektion. Inget ändrades.',
          code: SWAP_LOCKED,
          lessonIds: kept.map((member) => member.id),
        });
      }
    }
    if (units.size < 2 && !forBrick) throw new BadRequestException('moves: a swap moves at least two units.');
  }
}

/**
 * The minutes of a clock as the database will hold it: read from the parsed
 * time, the Date that is written, and not from the string.
 *
 * parseTimeString wraps an hour past 23 into the next day, so "34:00" is
 * stored as 10:00. Counted from the string it is minute 2040 — a time where
 * nothing stands — and the clash rule found no clash for a lesson that was then
 * written on top of another. A clock that does not come out of the parse as it
 * went in ("34:00", "12:60") is refused here, behind the DTO's pattern, for the
 * callers that do not pass through it.
 */
function clockMinutes(value: string): number {
  const minutes = minutesOf(parseTimeString(value));
  if (clockOf(minutes) !== value) throw new BadRequestException(`moves: ${value} is not a clock of the day (HH:MM, 00:00–23:59).`);
  return minutes;
}

/** A lesson as the change log holds it (resultOf): what a swap's before and after rows say of where it stood and whether it was locked. */
interface LoggedSlot {
  isLocked?: boolean;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
}

const isLoggedAt = (logged: LoggedSlot, slot: SwapSlot): boolean =>
  logged.dayOfWeek === slot.dayOfWeek && logged.startTime === clockOf(slot.startMinutes) && logged.endTime === clockOf(slot.endMinutes);

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
  /** Undantag med flit; absent on a row built by hand. */
  exemptFrom?: readonly string[];
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
}

/** The change log's and the answer's shape for a lesson: MasterLessonsService's toResult. */
function resultOf(lesson: RowForResult, withExemption = true): MasterLessonResult {
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
    // As MasterLessonsService's toResult, only on a lesson that has one: the log's `before` shows what a swap took away. A moved lesson has none after it.
    ...(withExemption ? exemptionKey(lesson.exemptFrom) : {}),
  };
}
