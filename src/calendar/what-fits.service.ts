import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { SwapReads } from '../swaps/swap-reads';
import { readSwapData } from '../swaps/swap-snapshot';
import type { SoftCost, SwapLesson } from '../swaps/swap-types';
import type { FitCandidateDto, RoomChoicesDto, WhatFitsDto } from './dto/possible-times.dto';
import {
  byScore,
  costOf,
  prepare,
  probeAt,
  type ClosedCode,
  type CostedStart,
  type PossibleSubject,
} from './possible-times';
import { BRICK_ID, clock, PossibleTimesService, STORED_LESSON_SELECT, swapLessonOfRow, type PossibleBlocker } from './possible-times.service';
import { roomChoicesOf, type RoomChoice } from './room-choices';

/*
 * E3: "VAD KAN LIGGA HÄR?" AND THE ROOM CHOOSER.
 *
 * Two questions over the same machinery as possible-times: the prune of one subject at one start (probeAt), the written cost
 * (costOf), the judge (judgePairs). The first turns the question around: the schemaläggare picked an empty time on the board, and
 * asks which of the lessons that are waiting (the bricks of Att lägga, or any lessons) can stand there, best first. The second asks
 * which room a lesson laid at a time should be given, with the rooms in the order they should be looked at.
 *
 * Nothing here writes. A lesson is called to fit only when the judge lets it through, as in possible-times.
 */

const JUDGE_CHUNK = 24;

export type FitAnswerKind = 'FREE' | 'CHANGE' | 'CLOSED' | 'IN_THE_WAY' | 'CROWDED' | 'STANDS' | 'PLACED' | 'UNJUDGED';

export interface FitAnswer {
  /** Its place in the request. */
  index: number;
  /** The lesson (a lesson on the tray is a brick of its own id), or null for a brick that is not a lesson yet. */
  lessonId: string | null;
  className: string;
  subjectName: string;
  minutes: number;
  answer: FitAnswerKind;
  /** 1 is the best of the lessons that fit; null for the others. */
  rank: number | null;
  /** FREE and CHANGE: the room each lesson of the unit would stand in, and the cost. */
  lessons?: Array<{ lessonId: string; roomId: string | null; startMinutes: number; endMinutes: number }>;
  roomChanged?: boolean;
  costs?: SoftCost[];
  wishes?: { met: number; avoided: number };
  score?: number;
  /** CLOSED: the rule and what it is about. */
  code?: ClosedCode;
  params?: Record<string, string | number>;
  /** IN_THE_WAY: the lesson that holds it (named in `blockers`). CROWDED: how many units, and whether one is locked. */
  blockerId?: string;
  units?: number;
  locked?: boolean;
}

export interface WhatFits {
  academicYearId: string;
  dayOfWeek: number;
  startMinutes: number;
  /** In the order of the request. */
  answers: FitAnswer[];
  /** The indices of the lessons that fit, best first. */
  fits: number[];
  blockers: Record<string, PossibleBlocker>;
  stats: { candidates: number; judged: number; refused: number; truncated: boolean; elapsedMs: number };
}

export interface RoomChoices {
  academicYearId: string;
  lessonId: string | null;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  /** The lesson is a förläggning's: its room is chosen on the timplan. */
  immovable?: 'PLACED';
  rooms: RoomChoice[];
  stats: { rooms: number; free: number; elapsedMs: number };
}

const minutesOfClock = (value: string): number => clock(value, 0);

@Injectable()
export class WhatFitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly possible: PossibleTimesService,
  ) {}

  async whatFits(dto: WhatFitsDto, user: AuthenticatedUser): Promise<WhatFits> {
    for (const candidate of dto.candidates) {
      if ((candidate.lessonId === undefined) === (candidate.brick === undefined)) throw new BadRequestException('Each candidate names either lessonId or brick, and not both.');
      if (candidate.brick && candidate.brick.academicYearId !== dto.academicYearId) throw new BadRequestException('A brick is of another läsår than the question.');
    }
    const ids = dto.candidates.flatMap((candidate) => (candidate.lessonId ? [candidate.lessonId] : []));
    if (new Set(ids).size !== ids.length) throw new BadRequestException('candidates: a lesson is named twice.');
    const started = Date.now();
    const startMinutes = minutesOfClock(dto.startTime);

    return this.prisma.withRls(user, async (tx) => {
      // 1. The candidates as lessons of the search: the stored ones, and the bricks as the lessons they would be.
      const rows = ids.length === 0 ? [] : await tx.masterLesson.findMany({ where: { id: { in: ids } }, select: STORED_LESSON_SELECT });
      const rowOf = new Map(rows.map((row) => [row.id, row]));
      const bricks = dto.candidates.flatMap((candidate) => (candidate.brick ? [candidate.brick] : []));
      const [groups, subjects] = bricks.length === 0 ? [[], []] : await Promise.all([
        tx.studentGroup.findMany({ where: { id: { in: [...new Set(bricks.map((brick) => brick.studentGroupId))] }, academicYearId: dto.academicYearId }, select: { id: true, name: true } }),
        tx.subject.findMany({ where: { id: { in: [...new Set(bricks.map((brick) => brick.subjectId))] } }, select: { id: true, name: true } }),
      ]);
      const groupName = new Map(groups.map((group) => [group.id, group.name]));
      const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));

      interface Entry {
        index: number;
        lesson: SwapLesson;
        unplaced: boolean;
        lessonId: string | null;
        placed: boolean;
      }
      const entries: Entry[] = dto.candidates.map((candidate, index) => {
        if (candidate.lessonId !== undefined) {
          const row = rowOf.get(candidate.lessonId);
          if (!row) throw new NotFoundException('Master lesson not found.');
          if (row.academicYearId !== dto.academicYearId) throw new BadRequestException('A lesson is of another läsår than the question.');
          return { index, lesson: swapLessonOfRow(row), unplaced: row.isParked, lessonId: row.id, placed: row.fromPlacement };
        }
        const brick = (candidate as FitCandidateDto).brick!;
        const group = groupName.get(brick.studentGroupId);
        const subject = subjectName.get(brick.subjectId);
        if (group === undefined) throw new NotFoundException('Student group not found in the year.');
        if (subject === undefined) throw new NotFoundException('Subject not found.');
        const lesson: SwapLesson = {
          id: `${BRICK_ID}#${index}`,
          subjectId: brick.subjectId,
          subjectName: subject,
          studentGroupId: brick.studentGroupId,
          groupName: group,
          teacherId: brick.teacherId ?? null,
          coTeacherId: brick.coTeacherId ?? null,
          roomId: brick.roomId ?? null,
          dayOfWeek: 1,
          startMinutes: 0,
          endMinutes: brick.minutes,
          recurrence: (brick.recurrence ?? 'ALL_WEEKS') as LessonRecurrence,
          startDate: brick.startDate ? brick.startDate.slice(0, 10) : null,
          endDate: brick.endDate ? brick.endDate.slice(0, 10) : null,
          isLocked: false,
          isGenerated: false,
          extraGroupIds: [...new Set(brick.extraGroupIds ?? [])].filter((id) => id !== brick.studentGroupId).sort(),
          studentIds: [...new Set(brick.studentIds ?? [])].sort(),
        };
        return { index, lesson, unplaced: true, lessonId: null, placed: false };
      });

      // 2. The school as it stands, with the lessons that stand nowhere known to it.
      const data = await readSwapData(tx, user, dto.academicYearId);
      const context = await this.possible.contextOf(tx, data, entries.filter((entry) => entry.unplaced).map((entry) => entry.lesson));
      const reads = new SwapReads(data.lessons);
      await reads.warm(tx, data);
      const world = await this.possible.worldOf(tx, data, context, entries.map((entry) => entry.lesson));

      // 3. The prune, for each candidate at this one start.
      const answers: FitAnswer[] = entries.map((entry) => ({
        index: entry.index,
        lessonId: entry.lessonId,
        className: entry.lesson.groupName,
        subjectName: entry.lesson.subjectName,
        minutes: entry.lesson.endMinutes - entry.lesson.startMinutes,
        answer: 'UNJUDGED',
        rank: null,
      }));
      const blockers: Record<string, PossibleBlocker> = {};
      const toJudge: Array<{ entry: Entry; subject: PossibleSubject; candidate: CostedStart }> = [];
      for (const entry of entries) {
        const answer = answers[entry.index]!;
        if (entry.placed) {
          answer.answer = 'PLACED';
          continue;
        }
        const unit = context.unitOf.get(entry.lesson.id);
        if (!unit) throw new NotFoundException('The lesson is not in the year read.');
        const subject: PossibleSubject = { unit, lesson: entry.lesson, unplaced: entry.unplaced };
        const probe = probeAt(world, subject, prepare(world, subject), dto.dayOfWeek, startMinutes);
        switch (probe.kind) {
          case 'STANDS':
            answer.answer = 'STANDS';
            break;
          case 'CLOSED':
            Object.assign(answer, { answer: 'CLOSED', code: probe.code, params: probe.params });
            break;
          case 'IN_THE_WAY': {
            const other = probe.blocker;
            blockers[other.id] ??= { lessonId: other.id, className: other.groupName, subjectName: other.subjectName, dayOfWeek: other.dayOfWeek, startMinutes: other.startMinutes, endMinutes: other.endMinutes, isLocked: other.isLocked };
            Object.assign(answer, { answer: 'IN_THE_WAY', blockerId: other.id });
            break;
          }
          case 'CROWDED':
            Object.assign(answer, { answer: 'CROWDED', units: probe.units, locked: probe.locked });
            break;
          case 'CANDIDATE':
            toJudge.push({ entry, subject, candidate: costOf(world, subject, { dayOfWeek: dto.dayOfWeek, startMinutes, rooms: probe.rooms, roomChanged: probe.roomChanged }) });
            break;
        }
      }

      // 4. The judge, in the order of the cost, until the time is out.
      toJudge.sort((a, b) => byScore(a.candidate, b.candidate));
      const judging = Date.now();
      const accepted: typeof toJudge = [];
      let judged = 0;
      let refused = 0;
      let truncated = false;
      for (let at = 0; at < toJudge.length; at += JUDGE_CHUNK) {
        if (at > 0 && Date.now() - judging > this.possible.judgeBudgetMs) {
          truncated = true;
          break;
        }
        const chunk = toJudge.slice(at, at + JUDGE_CHUNK);
        const verdicts = await this.possible.judgePairs(tx, data, chunk, reads);
        chunk.forEach((pair, index) => {
          judged += 1;
          const answer = answers[pair.entry.index]!;
          if (verdicts[index]) {
            accepted.push(pair);
            answer.answer = pair.candidate.roomChanged ? 'CHANGE' : 'FREE';
          } else {
            refused += 1;
            Object.assign(answer, { answer: 'CROWDED', units: 0, locked: false });
          }
        });
      }
      const fits = accepted
        .sort((a, b) => byScore(a.candidate, b.candidate))
        .map(({ entry, subject, candidate }, rank) => {
          Object.assign(answers[entry.index]!, {
            rank: rank + 1,
            lessons: subject.unit.members.map((member) => ({
              lessonId: member.id.startsWith(BRICK_ID) ? '' : member.id,
              roomId: candidate.rooms.get(member.id) ?? null,
              startMinutes: candidate.startMinutes,
              endMinutes: candidate.startMinutes + (member.endMinutes - member.startMinutes),
            })),
            roomChanged: candidate.roomChanged,
            costs: candidate.costs,
            wishes: candidate.wishes,
            score: candidate.score,
          });
          return entry.index;
        });

      // A teacher's day counted against a limit of their post is a read of that post.
      const limited = accepted.flatMap(({ subject }) => subject.unit.members.flatMap((member) => [member.teacherId, member.coTeacherId])).filter((id): id is string => id !== null && data.postLimited.has(id));
      if (fits.length > 0) await recordRead(tx, 'EMPLOYMENT', limited, user.channel);

      return {
        academicYearId: dto.academicYearId,
        dayOfWeek: dto.dayOfWeek,
        startMinutes,
        answers,
        fits,
        blockers,
        stats: { candidates: entries.length, judged, refused, truncated, elapsedMs: Date.now() - started },
      };
    }, { timeoutMs: this.possible.transactionMs() });
  }

  async roomChoices(dto: RoomChoicesDto, user: AuthenticatedUser): Promise<RoomChoices> {
    if ((dto.lessonId === undefined) === (dto.brick === undefined)) throw new BadRequestException('Name either lessonId or brick, and not both.');
    const started = Date.now();
    const startMinutes = minutesOfClock(dto.startTime);
    return this.prisma.withRls(user, async (tx) => {
      const found = await this.possible.subjectOf(tx, dto);
      const base = {
        academicYearId: found.academicYearId,
        lessonId: found.view.lessonId,
        className: found.view.className,
        subjectName: found.view.subjectName,
        dayOfWeek: dto.dayOfWeek,
        startMinutes,
        endMinutes: startMinutes + found.view.minutes,
      };
      if (found.placed) return { ...base, immovable: 'PLACED' as const, rooms: [], stats: { rooms: 0, free: 0, elapsedMs: Date.now() - started } };

      const data = await readSwapData(tx, user, found.academicYearId);
      const context = await this.possible.contextOf(tx, data, found.lesson.unplaced ? [found.lesson.lesson] : []);
      const unit = context.unitOf.get(found.lesson.lesson.id);
      if (!unit) throw new NotFoundException('The lesson is not in the year read.');
      const world = await this.possible.worldOf(tx, data, context, unit.members);
      const subject: PossibleSubject = { unit, lesson: found.lesson.lesson, unplaced: found.lesson.unplaced };
      // The rooms the school lets several lessons share are free to the prune whoever sits in them; the judge counts the pupils, so it is
      // asked of each of them, and one it refuses for its seats is a room a lesson sits in, not a free one.
      const full = new Map<string, SwapLesson[]>();
      const shared = world.rooms.filter((room) => context.isSharedRoom(room.id));
      if (shared.length > 0) {
        const reads = new SwapReads(data.lessons);
        await reads.warm(tx, data);
        const verdicts = await this.possible.judgeVerdicts(
          tx,
          data,
          shared.map((room) => ({
            subject,
            candidate: { dayOfWeek: dto.dayOfWeek, startMinutes, rooms: new Map(unit.members.map((member) => [member.id, member.id === found.lesson.lesson.id ? room.id : member.roomId])) },
          })),
          reads,
        );
        const length = found.lesson.lesson.endMinutes - found.lesson.lesson.startMinutes;
        shared.forEach((room, at) => {
          const own = unit.members.findIndex((member) => member.id === found.lesson.lesson.id);
          if (!verdicts[at]![own]!.refusals.some((refusal) => refusal.reason === 'ROOM')) return;
          const sitting = data.lessons.filter(
            (other) =>
              other.roomId === room.id &&
              other.dayOfWeek === dto.dayOfWeek &&
              !unit.members.some((member) => member.id === other.id) &&
              other.startMinutes < startMinutes + length &&
              startMinutes < other.endMinutes,
          );
          if (sitting.length > 0) full.set(room.id, sitting);
        });
      }
      const rooms = roomChoicesOf(world, subject, dto.dayOfWeek, startMinutes, full);
      return { ...base, rooms, stats: { rooms: rooms.length, free: rooms.filter((room) => room.state === 'FREE').length, elapsedMs: Date.now() - started } };
    }, { timeoutMs: this.possible.transactionMs() });
  }
}
