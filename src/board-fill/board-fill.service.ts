import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { judgeLessons, type JudgeItem } from '../calendar/lesson-judge';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { PossibleTimesService } from '../calendar/possible-times.service';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { requireSchoolId } from '../common/utils/request-context';
import { recordRead } from '../access-log/access-log';
import { outOfTime } from '../common/bulk';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { gradeSpanOf } from '../optimization/room-eligibility';
import { lockYearForRegeneration } from '../optimization/regeneration-lock';
import { BoardTrayService, type BoardTrayResponse, type TrayBrick } from '../board-tray/board-tray.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { lockPostForShares } from '../resources/requirement-shares';
import { SwapContext } from '../swaps/swap-context';
import { readSwapData, type SwapData } from '../swaps/swap-snapshot';
import type { SoftCost, SwapLesson } from '../swaps/swap-types';
import { FILL_MAX_BRICKS, type FillApplyDto, type FillBrickRefDto, type FillProposeDto } from './dto/fill.dto';
import { FillReads } from './fill-reads';
import { planFill, windowOfFrames, type FillBrick, type FillCandidate, type FillLeftReason, type FillPlaced } from './fill-plan';

/*
 * LÄGG DET SOM GÅR (E7a), THE GATEWAY: a proposal for the bricks of the tray, and "Ta in" that writes it.
 *
 * PROPOSE reads and writes nothing. It lays the bricks asked for one at a time, the one with the fewest free starts first, each on its lowest-cost
 * free start with a room the generator's rule allows (fill-plan.ts), and the judge (judgeLessons, the function POST /judge and every write ask) has
 * the last word on every start it chooses, with the lessons laid so far standing. The answer is a proposal: how many fitted, which did not and why, and
 * a `basis` that names the grundschema it was made on. It never says that something cannot be laid: a brick left over is "not laid by this", and the
 * word "går inte" belongs to the engine alone, when it has proved it (E7b).
 *
 * APPLY ("Ta in") is the only write. One transaction: the school's mode and the year's lock first (as every writer of the grundschema), the posts'
 * locks, the basis compared (409 BOARD_FILL_STALE and nothing written when anything of the year's lessons or posts has changed since the proposal was
 * read), a version saved, and then every lesson written through the tray's own write (BoardTrayService.writeBrick: the hand edit's createIn and
 * updateIn), which judges it again with the lessons before it in the database, logs it and, for a lesson on the tray that is laid back, asks the school's
 * question in Direkt (P5's requireDirectReachAnswered, inside updateIn). A lesson the judge then refuses rolls the whole write back. Each lesson is locked,
 * as a brick laid by hand is.
 *
 * NO EXEMPTION, NO MOVE. Nothing here gives an exemption (a time that needs one is closed to the fill), and nothing that stands is moved: `moved` is the
 * place where a later PR (E5a's search, the choice "får flytta" with a cap) will say what it moved, and is empty.
 */

/** The problem `code` of an apply whose proposal is not about the grundschema as it stands now. */
export const BOARD_FILL_STALE = 'BOARD_FILL_STALE';
/** What the proposal is given to be made: after it the bricks not yet begun are left with the reason TIME (decision 8: 20 s). */
export const FILL_BUDGET_MS = 20_000;
/**
 * The longest a Ta in's transaction may live. The caller's request sends nothing until the answer, and the platform's edge closes such a request after 300 s
 * (docs/DEPLOYMENT.md §5.3): a transaction allowed to run past that would commit the lessons for a client that was told 502. 120 s is where the other writers of a
 * whole year stand (publish, a plan of exams), and 4 times what 600 lessons took in a measurement under load (47 ms a lesson, 28 s); it leaves the answer and the
 * lock's 5 s a wide berth under the edge.
 */
export const FILL_APPLY_CEILING_MS = 120_000;

/** The transaction's time for a Ta in of this many lessons: 10 s and 0.6 s a lesson, 13 times what a lesson took, and never more than the ceiling. */
export const applyTimeoutMs = (lessons: number): number => Math.min(FILL_APPLY_CEILING_MS, Math.max(15_000, 10_000 + lessons * 600));
/** The code of a Ta in whose transaction ran out of its time: nothing was written and no version was kept (the transaction is rolled back with its version). */
export const BOARD_FILL_TIMED_OUT = 'BOARD_FILL_TIMED_OUT';

/**
 * What a school is told when Ta in's transaction ran out of its time (Prisma's P2028 or the database's own cancelling). Left alone it reached the page as the
 * filter's anonymous 500 "An unexpected database error occurred.", which says neither that nothing was written nor what to do; and the same proposal asked again
 * runs out the same way. Each lesson is some forty round trips to the database, so what fits in the time depends on how far the database is: fewer at a time fits.
 */
function timedOut(lessons: number): ConflictException {
  const seconds = Math.round(applyTimeoutMs(lessons) / 1000);
  return new ConflictException({
    message: `Ta in hann inte på ${seconds} sekunder, så ingenting skrevs och ingen version sparades. Ta in färre åt gången: en klass eller en årskurs i taget.`,
    code: BOARD_FILL_TIMED_OUT,
    params: { lessons, seconds },
  });
}
/**
 * The id a brick has as a lesson that stands nowhere: a UUID in form and in no table. The judge names a lesson its clash rule meets by reading that lesson's row
 * (namesOf), and the fill's own lessons stand in its reads as they are laid, so a prefixed key such as `fill:<post>|<teacher>|60|1` reached Postgres as a uuid
 * and the whole proposal answered 500 (P2007) whenever the judge met a lesson the prune had not: a school with a group that replaces a subject.
 */
export function fillIdOf(key: string): string {
  const hex = createHash('sha256').update(`fill|${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type FillLeftViewReason = FillLeftReason | 'BLOCK' | 'NO_TEACHER';

/** A brick as the answer names it: ids only, the page resolves the names from the lists it reads. */
export interface FillBrickView {
  key: string;
  postId: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  minutes: number;
  /** The lesson on the tray this brick is, or null for a brick that is no lesson yet. */
  lessonId: string | null;
}

export interface FillPlacedView extends FillBrickView {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  roomId: string | null;
  /** "Utan sal": the school has no room the generator would put the lesson in. */
  noRoom: boolean;
  /** How many starts were free for the brick when it was taken, and which of them, best first, it was laid on. */
  freeStarts: number;
  rank: number;
  costs: SoftCost[];
}

export interface FillLeftView extends FillBrickView {
  reason: FillLeftViewReason;
}

export interface FillProposal {
  academicYearId: string;
  /** Who answered: the fill, which proves nothing. The engine's answer (E7b) is the other one. */
  answeredBy: 'FILL';
  /** The grundschema the proposal was made on; Ta in gives it back. */
  basis: string;
  /** How many bricks were asked about. */
  asked: number;
  placed: FillPlacedView[];
  left: FillLeftView[];
  /** The lessons the proposal moves. Always empty: the choice "får flytta" is a later PR, and nothing that stands is moved. */
  moved: never[];
  /** The time ran out before every brick was begun: the ones not begun are in `left` with the reason TIME. */
  truncated: boolean;
  stats: { elapsedMs: number; worldMs: number; probeMs: number; costMs: number; judgeMs: number; worlds: number };
}

export interface FillApplyResult {
  academicYearId: string;
  /** The version saved before the first write: what "Ångra" goes back to. */
  versionId: string;
  laid: Array<{ key: string; lessonId: string; created: boolean; noRoom: boolean }>;
}

/** The problem `code` of a question about more bricks than Ta in can take in at once (FILL_MAX_BRICKS): the page narrows it to a year or a class. */
export const BOARD_FILL_TOO_MANY = 'BOARD_FILL_TOO_MANY';

const dateOf = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);
const keyOf = (brick: Pick<TrayBrick, 'postId' | 'teacherId' | 'minutes' | 'nth'>): string => `${brick.postId}|${brick.teacherId ?? '-'}|${brick.minutes}|${brick.nth}`;

function viewOf(brick: TrayBrick): FillBrickView {
  return { key: keyOf(brick), postId: brick.postId, studentGroupId: brick.studentGroupId, subjectId: brick.subjectId, teacherId: brick.teacherId, minutes: brick.minutes, lessonId: brick.lessonId };
}

/** A brick as a lesson that stands nowhere, for the world the planner reads. */
export function lessonOfBrick(brick: TrayBrick): SwapLesson {
  return {
    id: fillIdOf(keyOf(brick)),
    subjectId: brick.subjectId,
    subjectName: '',
    studentGroupId: brick.studentGroupId,
    groupName: '',
    teacherId: brick.teacherId,
    coTeacherId: brick.coTeacherId,
    roomId: null,
    dayOfWeek: 1,
    startMinutes: 0,
    endMinutes: brick.minutes,
    recurrence: brick.recurrence as LessonRecurrence,
    startDate: brick.startDate,
    endDate: brick.endDate,
    isLocked: false,
    isGenerated: false,
    extraGroupIds: [],
    studentIds: [],
  };
}

/** What a lesson on the tray has that its post does not say: the lesson's own co-teacher, weeks, other classes and named pupils. */
interface OwnOfLesson {
  id: string;
  coTeacherId: string | null;
  recurrence: string;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
}

const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** The brick as the lesson it is when it is one: updateIn keeps these of the lesson, so the proposal judges them too. */
export function withOwn(lesson: SwapLesson, own: OwnOfLesson | undefined): SwapLesson {
  if (!own) return lesson;
  return {
    ...lesson,
    coTeacherId: own.coTeacherId,
    recurrence: own.recurrence as LessonRecurrence,
    startDate: dayOf(own.startDate),
    endDate: dayOf(own.endDate),
    extraGroupIds: own.extraGroups.map((entry) => entry.studentGroupId).filter((id) => id !== lesson.studentGroupId).sort(),
    studentIds: own.participants.map((entry) => entry.studentId).sort(),
  };
}

function stale(): ConflictException {
  return new ConflictException({
    message: 'Grundschemat har ändrats sedan förslaget gjordes. Läs om det och försök igen. Inget ändrades.',
    code: BOARD_FILL_STALE,
  });
}

@Injectable()
export class BoardFillService {
  /** The time a proposal is given, in milliseconds: a field so that a probe on a loaded host can be given more. */
  budgetMs = FILL_BUDGET_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tray: BoardTrayService,
    private readonly masters: MasterLessonsService,
    private readonly possible: PossibleTimesService,
    private readonly versions: ScheduleVersionsService,
  ) {}

  // ---------------------------------------------------------------------------
  // The proposal.
  // ---------------------------------------------------------------------------

  async propose(dto: FillProposeDto, user: AuthenticatedUser): Promise<FillProposal> {
    return this.prisma.withRls(
      user,
      async (tx) => {
        const trayOfYear = await this.tray.trayIn(tx, dto.academicYearId, undefined);
        const data = await readSwapData(tx, user, dto.academicYearId);
        const asked = this.bricksAsked(dto, trayOfYear, data);
        // Ta in takes in at most FILL_MAX_BRICKS lessons (its DTO and its transaction are sized to it), so a proposal longer than that could never be taken in: a school
        // that fills a year from nothing would be given 700 lessons and refused 400 "items must contain no more than 600 elements" when it said yes.
        const placeable = asked.filter((brick) => brick.cannotPlace === null).length;
        if (placeable > FILL_MAX_BRICKS) {
          throw new BadRequestException({
            message: `Det är ${placeable} brickor att lägga, och ett förslag rymmer högst ${FILL_MAX_BRICKS}. Fyll en årskurs eller en klass i taget.`,
            code: BOARD_FILL_TOO_MANY,
            params: { asked: placeable, max: FILL_MAX_BRICKS },
          });
        }

        const bricks = asked.filter((brick) => brick.cannotPlace === null);
        const left: FillLeftView[] = asked.filter((brick) => brick.cannotPlace !== null).map((brick) => ({ ...viewOf(brick), reason: brick.cannotPlace as FillLeftViewReason }));
        const byKey = new Map(asked.map((brick) => [keyOf(brick), brick]));
        const basis = await this.basisOf(tx, dto.academicYearId, trayOfYear);

        if (bricks.length === 0) return this.answer(dto.academicYearId, basis, asked.length, [], left, false, { elapsedMs: 0, worldMs: 0, probeMs: 0, costMs: 0, judgeMs: 0, worlds: 0 });

        // A brick that is a lesson on the tray is that lesson, and the write that takes it in (updateIn) judges it with what it has: its other classes, the pupils
        // named on it and the weeks it runs. The proposal must ask the judge the same, or Ta in refuses (409) what the proposal said fitted.
        const own = await this.ownOfLessons(tx, bricks);
        const fillBricks: FillBrick[] = bricks.map((brick) => ({ key: keyOf(brick), lesson: withOwn(lessonOfBrick(brick), own.get(brick.lessonId ?? '')) }));
        const facts = await this.possible.worldFactsOf(tx, data);
        const initial = new SwapContext(data, { unplaced: fillBricks.map((brick) => brick.lesson), ...facts });
        const possible = await this.possible.worldOf(tx, data, initial, fillBricks.map((brick) => brick.lesson));
        const reads = new FillReads(data.lessons);
        await reads.warm(tx, data);
        const judgeWorld = { academicYearId: data.academicYearId, schoolId: data.schoolId, basis: data.basis, gradeNumbering: data.gradeNumbering };

        const plan = await planFill(
          { data, rooms: possible.rooms, wishes: possible.wishes, needsOf: possible.needsOf, ...facts },
          fillBricks,
          windowOfFrames(data),
          {
            order: 'FEWEST',
            choice: 'KEEP_OPEN',
            stepMinutes: 5,
            starts: 'POINTS',
            budgetMs: this.budgetMs,
            judge: async (candidate) => (await judgeLessons(tx, this.masters, judgeWorld, [this.judgeItemOf(candidate)], { reads }))[0]!.ok,
            onPlaced: (placed: FillPlaced) => reads.add({ ...placed.brick.lesson, dayOfWeek: placed.dayOfWeek, startMinutes: placed.startMinutes, endMinutes: placed.endMinutes, roomId: placed.roomId, isLocked: true }),
          },
        );

        const placed: FillPlacedView[] = plan.placed.map((entry) => ({
          ...viewOf(byKey.get(entry.brick.key)!),
          dayOfWeek: entry.dayOfWeek,
          startMinutes: entry.startMinutes,
          endMinutes: entry.endMinutes,
          roomId: entry.roomId,
          noRoom: entry.roomId === null,
          freeStarts: entry.freeStarts,
          rank: entry.rank,
          costs: entry.costs,
        }));
        for (const entry of plan.left) left.push({ ...viewOf(byKey.get(entry.brick.key)!), reason: entry.reason });
        // A teacher's day or stretch counted against a limit of their post is a read of that post (HR data): the cost every start was ranked by read it, for each brick
        // that was costed (laid, or tried and refused by the judge). Möjliga tider, Vad får plats and the swap search record the same read (EMPLOYMENT).
        const costed = [...plan.placed.map((entry) => entry.brick), ...plan.left.filter((entry) => entry.reason === 'JUDGE').map((entry) => entry.brick)];
        const limited = costed.flatMap((brick) => [brick.lesson.teacherId, brick.lesson.coTeacherId]).filter((id): id is string => id !== null && data.postLimited.has(id));
        await recordRead(tx, 'EMPLOYMENT', limited, user.channel);
        return this.answer(dto.academicYearId, basis, asked.length, placed, left, plan.left.some((entry) => entry.reason === 'TIME'), plan.stats);
      },
      { timeoutMs: this.budgetMs + 30_000 },
    );
  }

  /** The lessons on the tray that the bricks asked for are, with what each has of its own. One read, and none when no brick is a lesson. */
  private async ownOfLessons(tx: PrismaClient, bricks: readonly TrayBrick[]): Promise<Map<string, OwnOfLesson>> {
    const ids = bricks.flatMap((brick) => (brick.lessonId === null ? [] : [brick.lessonId]));
    if (ids.length === 0) return new Map();
    const rows = await tx.masterLesson.findMany({
      where: { id: { in: ids } },
      select: { id: true, coTeacherId: true, recurrence: true, startDate: true, endDate: true, extraGroups: { select: { studentGroupId: true } }, participants: { select: { studentId: true } } },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The judge's item for a candidate: a lesson that does not exist yet, standing nowhere, with no exemption asked. */
  private judgeItemOf(candidate: FillCandidate): JudgeItem {
    const lesson = candidate.brick.lesson;
    return {
      lesson: { id: null, studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId },
      candidate: {
        dayOfWeek: candidate.dayOfWeek,
        startMinutes: candidate.startMinutes,
        endMinutes: candidate.endMinutes,
        teacherId: lesson.teacherId,
        coTeacherId: lesson.coTeacherId,
        roomId: candidate.roomId,
        extraGroupIds: lesson.extraGroupIds,
        studentIds: lesson.studentIds,
        recurrence: lesson.recurrence,
        startDate: dateOf(lesson.startDate),
        endDate: dateOf(lesson.endDate),
      },
      stands: null,
    };
  }

  private answer(
    academicYearId: string,
    basis: string,
    asked: number,
    placed: FillPlacedView[],
    left: FillLeftView[],
    truncated: boolean,
    stats: FillProposal['stats'],
  ): FillProposal {
    return {
      academicYearId,
      answeredBy: 'FILL',
      basis,
      asked,
      placed,
      left,
      moved: [],
      truncated,
      stats: { elapsedMs: stats.elapsedMs, worldMs: stats.worldMs, probeMs: stats.probeMs, costMs: stats.costMs, judgeMs: stats.judgeMs, worlds: stats.worlds },
    };
  }

  /** The bricks the request asks for, in the tray's order. A brick named that is no brick of the tray is 409: the page read another picture. */
  private bricksAsked(dto: FillProposeDto, tray: BoardTrayResponse, data: SwapData): TrayBrick[] {
    switch (dto.scope) {
      case 'SCHOOL':
        return tray.bricks;
      case 'CLASS': {
        if (dto.studentGroupId === undefined) throw new BadRequestException('studentGroupId: name the class to fill.');
        return tray.bricks.filter((brick) => brick.studentGroupId === dto.studentGroupId);
      }
      case 'GRADE': {
        if (dto.gradeLevel === undefined) throw new BadRequestException('gradeLevel: name the year to fill.');
        const inYear = new Map<string, boolean>();
        const grade = dto.gradeLevel;
        return tray.bricks.filter((brick) => {
          let hit = inYear.get(brick.studentGroupId);
          if (hit === undefined) {
            const span = gradeSpanOf(data.rosters, [brick.studentGroupId]);
            hit = span !== null && span.min <= grade && grade <= span.max;
            inYear.set(brick.studentGroupId, hit);
          }
          return hit;
        });
      }
      case 'BRICKS': {
        if (dto.bricks === undefined) throw new BadRequestException('bricks: name the bricks to fill.');
        const wanted = new Set(dto.bricks.map((ref: FillBrickRefDto) => keyOf({ postId: ref.postId, teacherId: ref.teacherId ?? null, minutes: ref.minutes, nth: ref.nth })));
        const found = tray.bricks.filter((brick) => wanted.has(keyOf(brick)));
        if (found.length !== wanted.size) throw stale();
        return found;
      }
    }
  }

  /**
   * What the proposal was made on: the year's lessons and posts as the tray reads them. A lesson written, moved, parked or deleted by anyone changes
   * it (the count and the last change of the year's lessons), and so does a post asked for more or fewer lessons (the tray's keys of every part).
   */
  async basisOf(tx: PrismaClient, academicYearId: string, tray: BoardTrayResponse): Promise<string> {
    const [lessons, posts] = await Promise.all([
      tx.masterLesson.aggregate({ where: { academicYearId }, _count: { _all: true }, _max: { updatedAt: true } }),
      tx.teachingRequirement.aggregate({ where: { academicYearId }, _count: { _all: true }, _max: { updatedAt: true } }),
    ]);
    const parts = [...new Set(tray.bricks.map((brick) => `${brick.postId}|${brick.teacherId ?? '-'}|${brick.minutes}|${brick.partKey}`))].sort();
    return createHash('sha256')
      .update(JSON.stringify([lessons._count._all, lessons._max.updatedAt?.toISOString() ?? null, posts._count._all, posts._max.updatedAt?.toISOString() ?? null, parts]))
      .digest('hex')
      .slice(0, 32);
  }

  // ---------------------------------------------------------------------------
  // "Ta in".
  // ---------------------------------------------------------------------------

  async apply(dto: FillApplyDto, user: AuthenticatedUser): Promise<FillApplyResult> {
    try {
      return await this.applyIn(dto, user);
    } catch (error) {
      if (isWriteConflict(error)) throw writeConflict();
      // The transaction was rolled back when its time ran out, so a second try is as safe as the first (a connection that never came free is the filter's 503 DATABASE_BUSY).
      if (outOfTime(error) === 'ran out') throw timedOut(dto.items.length);
      throw error;
    }
  }

  private applyIn(dto: FillApplyDto, user: AuthenticatedUser): Promise<FillApplyResult> {
    const keys = dto.items.map((item) => item.key);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('items: a brick is named twice.');
    return this.prisma.withRls(
      user,
      async (tx) => {
        await enterGrundschemaWrite(tx, requireSchoolId(user));
        // The year is the school's before its lock is taken (the row is read under row-level security, so another school's year is not found): an exclusive lock on a
        // year that is nobody's here would queue the school that owns it behind a stranger's request, and every hand edit of that school behind the queue.
        if (!(await tx.academicYear.findUnique({ where: { id: dto.academicYearId }, select: { id: true } }))) throw new NotFoundException('Läsåret finns inte.');
        // The year's lock EXCLUSIVE, as the three other writers of many lessons take it (Generera's persist, an apply of a candidate, a restore): a hand edit takes it
        // shared and runs beside others, which is right for one lesson and wrong for a Ta in. Two proposals made on the same basis (two administrators filling two
        // classes of one teacher) both pass the basis and the judge when each reads the grundschema without the other's uncommitted lessons, and both commit: a
        // teacher and a room in two places at once, locked. The second Ta in now queues for up to 5 s (409 SCHEDULE_BUSY) and, when it gets the lock, reads the
        // grundschema after the first, so its basis is stale (409 BOARD_FILL_STALE) and nothing is written.
        await lockYearForRegeneration(tx, dto.academicYearId);
        // The posts' locks in id order, before the tray is read under them: two administrators that lay bricks of one post queue here.
        const postIds = [...new Set(keys.map((key) => key.split('|')[0]!))].sort();
        for (const postId of postIds) await lockPostForShares(tx, postId);

        const trayOfYear = await this.tray.trayIn(tx, dto.academicYearId, undefined);
        if ((await this.basisOf(tx, dto.academicYearId, trayOfYear)) !== dto.basis) throw stale();
        const byKey = new Map(trayOfYear.bricks.map((brick) => [keyOf(brick), brick]));
        const bricks = dto.items.map((item) => {
          const brick = byKey.get(item.key);
          if (!brick || brick.cannotPlace !== null) throw stale();
          return brick;
        });

        // Before the first write, in THIS transaction: a refused write leaves no version describing a change that never happened.
        const version = await this.versions.snapshotInTransaction(tx, dto.academicYearId, dto.versionName?.trim() || 'Före påfyllning', user);

        const laid: FillApplyResult['laid'] = [];
        for (const [index, item] of dto.items.entries()) {
          const brick = bricks[index]!;
          const ownLessonIds = new Set(trayOfYear.bricks.filter((entry) => entry.postId === brick.postId && entry.teacherId === brick.teacherId && entry.minutes === brick.minutes).flatMap((entry) => (entry.lessonId === null ? [] : [entry.lessonId])));
          const result = await this.tray.writeBrick(
            tx,
            brick,
            { academicYearId: dto.academicYearId, postId: brick.postId, dayOfWeek: item.dayOfWeek, startTime: item.startTime, roomId: item.roomId ?? null, ...(brick.lessonId !== null ? { lessonId: brick.lessonId } : {}), ownLessonIds },
            user,
          );
          laid.push({ key: item.key, lessonId: result.lesson.id, created: brick.lessonId === null, noRoom: result.noRoom });
        }
        return { academicYearId: dto.academicYearId, versionId: version.id, laid };
      },
      { timeoutMs: applyTimeoutMs(dto.items.length) },
    );
  }
}

