import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { weeksCanOverlap } from '../calendar/lesson-recurrence';
import { reconcilableLessons } from '../calendar/master-lessons.service';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import type {
  ApplyRoomChangesDto,
  RoomChangeDto,
  RoomProposalDto,
} from './dto/room-optimization.dto';
import type {
  AnonymousConstraint,
  AnonymousRoomPreference,
  DayOfWeek,
} from './interfaces/ai-engine-payload.interface';
import type {
  OptimizeRoomsRequest,
  OptimizeRoomsResponse,
  PlacedLesson,
  Walk,
  WalkComparison,
  WalkerWalk,
  WalkRoom,
  Walkers,
} from './interfaces/room-walks.interface';
import { OptimizationProxyService, type AnonMaps } from './optimization-proxy.service';
import { loadRosters, roomNeedsOf, type RoomNeeds } from './room-eligibility';

/** The code a stale apply answers with, so the page recomputes rather than guesses. */
export const ROOM_PROPOSAL_STALE = 'ROOM_PROPOSAL_STALE';
/** The code the defensive clash guard answers with. */
export const ROOM_CLASH = 'ROOM_CLASH';
/** The safety snapshot's name. Listed under Versioner, so in the school's language. */
export const ROOM_SNAPSHOT_NAME = 'Före salsoptimering';

/** The engine's route; see optimization-engine/app/api/v1/rooms.py. */
const OPTIMIZE_ROOMS_PATH = '/api/v1/optimize-rooms';

/** One lesson's move, in real ids. */
export interface RoomMove {
  lessonId: string;
  fromRoomId: string;
  toRoomId: string;
}

export interface RoomProposal {
  status: OptimizeRoomsResponse['status'];
  /** What the proposal was computed from; apply refuses any other state. */
  basis: string;
  changes: RoomMove[];
  teachers: WalkComparison;
  groups: WalkComparison;
  missedWishes: { before: number; after: number };
  /** Real teacher and group ids; the page names them from lists it has. */
  walkers: WalkerWalk[];
  frozenLessonIds: string[];
  roomsTotal: number;
  /** So the page can say the floors are missing before it says "no gain". */
  roomsWithoutFloor: number;
}

export interface RoomApplyResult {
  updated: number;
  /**
   * Published calendar lessons that moved with their templates, so the page
   * can say the calendar followed — or that it had nothing to follow yet.
   */
  calendarUpdated: number;
  /** The basis of the timetable AFTER the apply — what an undo must send. */
  basis: string;
  versionId: string;
}

/*
 * Everything a proposal reads, and so everything its basis covers. Selected
 * through Prisma.validator so each row type is exactly its select.
 */
const LESSON_SELECT = Prisma.validator<Prisma.MasterLessonSelect>()({
  id: true,
  subjectId: true,
  studentGroupId: true,
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
  isParked: true,
  extraGroups: { select: { studentGroupId: true } },
  // In the basis only through the room needs derived from them; see basisOf.
  participants: { select: { studentId: true } },
  subject: { select: { requiredRoomTypeId: true } },
});

const ROOM_SELECT = Prisma.validator<Prisma.RoomSelect>()({
  id: true,
  capacity: true,
  roomTypeId: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  building: true,
  floor: true,
});

const PREFERENCE_SELECT = Prisma.validator<Prisma.RoomPreferenceSelect>()({
  id: true,
  subjectId: true,
  kind: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  roomTypeId: true,
  weight: true,
  rooms: { select: { roomId: true } },
});

const CONSTRAINT_SELECT = Prisma.validator<Prisma.AvailabilityConstraintSelect>()({
  id: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
});

type LessonRow = Prisma.MasterLessonGetPayload<{ select: typeof LESSON_SELECT }>;
type RoomRow = Prisma.RoomGetPayload<{ select: typeof ROOM_SELECT }>;
type PreferenceRow = Prisma.RoomPreferenceGetPayload<{ select: typeof PREFERENCE_SELECT }>;
type ConstraintRow = Prisma.AvailabilityConstraintGetPayload<{
  select: typeof CONSTRAINT_SELECT;
}>;

interface YearState {
  schoolId: string;
  lessons: LessonRow[];
  rooms: RoomRow[];
  preferences: PreferenceRow[];
  constraints: ConstraintRow[];
  /** lessonId -> what it asks of a room, for every lesson that is sent. */
  needs: Map<string, RoomNeeds>;
}

/** realId -> anonymous id, one map per id space, minted per request. */
interface RoomAnonMaps {
  lessons: Map<string, string>;
  rooms: Map<string, string>;
  groups: Map<string, string>;
  teachers: Map<string, string>;
  subjects: Map<string, string>;
  roomTypes: Map<string, string>;
  buildings: Map<string, string>;
  preferences: Map<string, string>;
  constraints: Map<string, string>;
}

/**
 * Salsoptimering: a times-fixed re-assignment of ROOMS ONLY on the current
 * grundschema.
 *
 * The generator never names a concrete room in its model — it picks a class of
 * interchangeable rooms per lesson and a post-pass hands out concrete rooms in
 * start order, with no idea who taught where just before. So Elin goes 1→10 and
 * Alexander 10→1 at the same bell, both of them up a flight of stairs, when
 * swapping two rooms would keep each of them where they are. This asks the
 * engine for exactly that swap and nothing else: only `roomId` of existing
 * master lessons ever changes, never a time, a day, a teacher or a group.
 *
 * The same masking discipline as OptimizationProxyService: the engine gets
 * fresh anonymous ids per request, buildings as opaque tokens, and no names.
 */
@Injectable()
export class RoomOptimizationService {
  private readonly logger = new Logger(RoomOptimizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * A proposal, and nothing written.
   *
   * The engine is called OUTSIDE the transaction, as the generator's is: a
   * transaction held open across a ten-second solve would pin a pooled
   * connection for its duration and run into withRls's own timeout. Apply does
   * not trust anything carried over from here — it re-reads under the year's
   * lock and compares the basis.
   */
  async propose(dto: RoomProposalDto, user: AuthenticatedUser): Promise<RoomProposal> {
    const requestId = randomUUID();
    const state = await this.prisma.withRls(user, (tx) =>
      this.readYear(tx, dto.academicYearId),
    );

    const basis = basisOf(state);
    const roomsTotal = state.rooms.length;
    const roomsWithoutFloor = state.rooms.filter((room) => room.floor === null).length;
    // A parked lesson occupies nothing (see its schema comment), so it is not
    // sent at all; see sendable.
    const placed = state.lessons.filter(sendable);

    // Nothing to move, and the tallies are truly zero: with no lessons there
    // are no pairs, and with no rooms every lesson is roomless and a pair with
    // a roomless side costs nothing. The engine refuses an empty list anyway.
    if (placed.length === 0 || state.rooms.length === 0) {
      return {
        status: 'OPTIMAL',
        basis,
        changes: [],
        teachers: stillWalk(),
        groups: stillWalk(),
        missedWishes: { before: 0, after: 0 },
        walkers: [],
        frozenLessonIds: [],
        roomsTotal,
        roomsWithoutFloor,
      };
    }

    const { payload, maps } = this.anonymise(requestId, dto.walkers, state, placed);
    const response = await this.proxy.callAiEngine<OptimizeRoomsResponse>(
      OPTIMIZE_ROOMS_PATH,
      payload,
      refusalMaps(maps),
    );
    const realised = this.realise(response, placed, maps);

    this.logger.log(
      `Room proposal [requestId=${requestId}, status=${response.status}, ` +
        `lessons=${placed.length}, changes=${realised.changes.length}]`,
    );

    return { status: response.status, basis, ...realised, roomsTotal, roomsWithoutFloor };
  }

  /**
   * Apply a proposal — or, with its changes reversed and the basis the apply
   * returned, undo one. One RLS transaction, all or nothing.
   */
  async apply(dto: ApplyRoomChangesDto, user: AuthenticatedUser): Promise<RoomApplyResult> {
    const { result, schoolId } = await this.prisma.withRls(user, async (tx) => {
      // One apply per year at a time, taken before anything is read. withRls
      // runs READ COMMITTED, so without it two applies from one basis — a
      // double click, two admins on one proposal — both read the same state,
      // both match, and both commit: two sets of moves that are each
      // clash-free can clash with each other, and nothing below would see it.
      // Under the lock the second one reads after the first has committed,
      // sees its rooms, and is refused as stale. Transaction-scoped, so the
      // commit or the rollback releases it and a thrown 409 cannot leak it;
      // the first key keeps it apart from any other lock on the same id.
      //
      // It orders applies, not a hand edit of the grundschema, which takes no
      // such lock — the exposure migration 20260822131500 states for two admins
      // editing one slot. The from-room on every UPDATE below still refuses a
      // hand edit of a lesson this moves.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('room-optimization'), hashtext(${dto.academicYearId}))`;

      const state = await this.readYear(tx, dto.academicYearId);
      // Everything the proposal read, re-read here and compared whole. A
      // teacher moved, a room renumbered to another floor, a lesson locked —
      // any of them changes what the best rooms are, and a proposal applied
      // over them would be an answer to a question nobody is asking any more.
      if (basisOf(state) !== dto.basis) throw stale();

      const moves = checkedMoves(state, dto.changes);
      assertNoNewClash(state, moves);

      // Before the first write, in THIS transaction: a refused apply must not
      // leave a version behind promising a change that never happened.
      const version = await this.versions.snapshotInTransaction(
        tx,
        dto.academicYearId,
        ROOM_SNAPSHOT_NAME,
        user,
      );

      // One statement per (from, to) pair rather than per lesson — a swap of
      // two rooms is two statements however many lessons it moves — and every
      // one still carries the from-room: a lesson is only moved if it is where
      // the proposal found it. The basis says it is; this is what makes the
      // write itself refuse otherwise, rather than trusting the read.
      const byPair = new Map<string, RoomChangeDto[]>();
      for (const move of moves.values()) {
        const key = `${move.fromRoomId}>${move.toRoomId}`;
        const pair = byPair.get(key);
        if (pair) pair.push(move);
        else byPair.set(key, [move]);
      }
      let calendarUpdated = 0;
      for (const pair of byPair.values()) {
        const lessonIds = pair.map((move) => move.lessonId);
        const { count } = await tx.masterLesson.updateMany({
          where: {
            id: { in: lessonIds },
            academicYearId: dto.academicYearId,
            roomId: pair[0]!.fromRoomId,
          },
          data: { roomId: pair[0]!.toRoomId },
        });
        if (count !== pair.length) throw stale();

        // The published calendar follows, as it does a room changed by hand
        // (MasterLessonsService.update -> propagate). Publish never rewrites a
        // room, so without this a school that has already published would see
        // nothing change. The rows are the ones propagate may still rewrite —
        // reconcilableLessons, so a past lesson or one with attendance stays
        // as it happened — and, unlike propagate, only those still in the room
        // the template is leaving: a date somebody moved by hand was moved for
        // a reason this optimisation knows nothing about.
        //
        // Undo is the same statement with the rooms swapped, so what this moved
        // goes back and a date moved by hand in between stays where it was put.
        // A date that sat in the to-room by hand BEFORE the apply cannot be
        // told apart from one this moved, and goes back with them.
        const published = await tx.calendarLesson.updateMany({
          where: { ...reconcilableLessons(lessonIds), roomId: pair[0]!.fromRoomId },
          data: { roomId: pair[0]!.toRoomId },
        });
        calendarUpdated += published.count;
      }

      // The audit trail every other timetable write keeps; the room is all
      // that changed, so the room is all each entry records.
      await tx.scheduleChangeLog.createMany({
        data: [...moves.values()].map((move) => ({
          schoolId: state.schoolId,
          academicYearId: dto.academicYearId,
          masterLessonId: move.lessonId,
          actorId: user.userId ?? null,
          action: 'UPDATE' as const,
          before: { roomId: move.fromRoomId },
          after: { roomId: move.toRoomId },
        })),
      });

      // The basis of what is now stored, computed from what was read with the
      // moves laid over it. Only roomId was written, and the year's lock keeps
      // every other apply out between that read and the commit, so a fresh
      // read hashes to exactly this — and the undo the page offers is refused
      // the moment anything else changes. A hand edit committed meanwhile is
      // not held off by the lock; it makes this basis wrong, which refuses the
      // undo as stale rather than reversing over it.
      const after: YearState = {
        ...state,
        lessons: state.lessons.map((lesson) => {
          const move = moves.get(lesson.id);
          return move ? { ...lesson, roomId: move.toRoomId } : lesson;
        }),
      };
      return {
        result: {
          updated: moves.size,
          calendarUpdated,
          basis: basisOf(after),
          versionId: version.id,
        },
        schoolId: state.schoolId,
      };
    });

    this.logger.log(
      `Room changes applied [academicYearId=${dto.academicYearId}, updated=${result.updated}, calendarUpdated=${result.calendarUpdated}, version=${result.versionId}]`,
    );
    this.realtime.notifyMasterTimetableChanged(schoolId);
    return result;
  }

  // ---------------------------------------------------------------------------

  private async readYear(tx: PrismaClient, academicYearId: string): Promise<YearState> {
    const year = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { id: true, schoolId: true },
    });
    // Without this, an unknown year reads as an empty timetable and the page
    // is told its rooms are already as good as they get.
    if (!year) throw new NotFoundException('Academic year not found.');

    // School-scoped rows through the year -> school hop, as the generator
    // reads them, so a request for another school's year pulls nothing.
    const inSchool = { school: { academicYears: { some: { id: academicYearId } } } };
    const [lessons, rooms, preferences, constraints] = await Promise.all([
      tx.masterLesson.findMany({ where: { academicYearId }, select: LESSON_SELECT }),
      tx.room.findMany({ where: inSchool, select: ROOM_SELECT }),
      tx.roomPreference.findMany({ select: PREFERENCE_SELECT }),
      // Only what the engine reads: a room closed on a weekday. A dated row is
      // one day of a year the grundschema repeats every week of.
      tx.availabilityConstraint.findMany({
        where: {
          ...inSchool,
          resourceType: 'ROOM',
          type: 'UNAVAILABLE',
          date: null,
          roomId: { not: null },
        },
        select: CONSTRAINT_SELECT,
      }),
    ]);

    // What each lesson asks of a room, derived HERE so that propose and apply
    // read it the same way: the proposal sends it, and the basis covers it.
    // The generator's own derivation, so a lesson may only move into a room
    // the generator would have given it. See room-eligibility.ts.
    const placed = lessons.filter(sendable);
    const groups = await tx.studentGroup.findMany({
      where: { academicYearId },
      select: { id: true, gradeLevel: true },
    });
    const rosters = await loadRosters(
      tx,
      [...new Set(placed.flatMap(groupsOf))],
      groups,
      placed.flatMap((lesson) => lesson.participants.map((entry) => entry.studentId)),
    );
    const needs = new Map(
      placed.map((lesson) => [
        lesson.id,
        roomNeedsOf(
          rosters,
          {
            groupIds: groupsOf(lesson),
            studentIds: lesson.participants.map((entry) => entry.studentId),
          },
          lesson.subject,
        ),
      ]),
    );

    return { schoolId: year.schoolId, lessons, rooms, preferences, constraints, needs };
  }

  private anonymise(
    requestId: string,
    walkers: Walkers,
    state: YearState,
    placed: LessonRow[],
  ): { payload: OptimizeRoomsRequest; maps: RoomAnonMaps } {
    const maps: RoomAnonMaps = {
      lessons: new Map(),
      rooms: new Map(),
      groups: new Map(),
      teachers: new Map(),
      subjects: new Map(),
      roomTypes: new Map(),
      buildings: new Map(),
      preferences: new Map(),
      constraints: new Map(),
    };
    const anon = (map: Map<string, string>, realId: string): string => {
      const existing = map.get(realId);
      if (existing) return existing;
      const id = randomUUID();
      map.set(realId, id);
      return id;
    };

    const rooms: WalkRoom[] = state.rooms.map((room) => ({
      id: anon(maps.rooms, room.id),
      capacity: room.capacity,
      type: room.roomTypeId ? anon(maps.roomTypes, room.roomTypeId) : null,
      minGradeLevel: room.minGradeLevel,
      maxGradeLevel: room.maxGradeLevel,
      // The school's own words for its buildings never leave the gateway: the
      // engine only asks whether two rooms share one, and a token per distinct
      // name answers that exactly.
      building: room.building ? anon(maps.buildings, room.building) : null,
      floor: room.floor,
    }));

    const lessons: PlacedLesson[] = placed.map((lesson) => {
      // Derived in readYear, once, for every lesson `placed` holds.
      const needs = state.needs.get(lesson.id)!;
      return {
        id: anon(maps.lessons, lesson.id),
        subjectId: anon(maps.subjects, lesson.subjectId),
        studentGroupId: anon(maps.groups, lesson.studentGroupId),
        extraGroupIds: groupsOf(lesson)
          .slice(1)
          .map((groupId) => anon(maps.groups, groupId)),
        teacherId: lesson.teacherId ? anon(maps.teachers, lesson.teacherId) : null,
        coTeacherId: lesson.coTeacherId ? anon(maps.teachers, lesson.coTeacherId) : null,
        dayOfWeek: lesson.dayOfWeek as DayOfWeek,
        startTime: clock(lesson.startTime),
        endTime: clock(lesson.endTime),
        recurrence: lesson.recurrence,
        startDate: day(lesson.startDate),
        endDate: day(lesson.endDate),
        roomId: lesson.roomId ? anon(maps.rooms, lesson.roomId) : null,
        // A locked lesson keeps its room; it is still sent, because it holds
        // that room and is a step in its teacher's day.
        movable: !lesson.isLocked,
        studentGroupSize: needs.studentGroupSize,
        minGradeLevel: needs.minGradeLevel,
        maxGradeLevel: needs.maxGradeLevel,
        requiredRoomType: needs.requiredRoomTypeId
          ? anon(maps.roomTypes, needs.requiredRoomTypeId)
          : null,
      };
    });

    const roomPreferences: AnonymousRoomPreference[] = state.preferences.map((rule) => ({
      id: anon(maps.preferences, rule.id),
      subjectId: anon(maps.subjects, rule.subjectId),
      kind: rule.kind,
      minGradeLevel: rule.minGradeLevel,
      maxGradeLevel: rule.maxGradeLevel,
      roomType: rule.roomTypeId ? anon(maps.roomTypes, rule.roomTypeId) : null,
      // Every room of the school is in the payload, so a rule naming one the
      // map does not know names a room that no longer exists.
      roomIds: rule.rooms
        .map((entry) => maps.rooms.get(entry.roomId))
        .filter((id): id is string => id !== undefined),
      weight: rule.weight,
    }));

    const constraints: AnonymousConstraint[] = state.constraints.flatMap((row) => {
      const roomId = row.roomId ? maps.rooms.get(row.roomId) : undefined;
      if (roomId === undefined) return [];
      return [
        {
          id: anon(maps.constraints, row.id),
          resourceKind: 'ROOM' as const,
          resourceId: roomId,
          dayOfWeek: row.dayOfWeek as DayOfWeek | null,
          date: null,
          startTime: clock(row.startTime),
          endTime: clock(row.endTime),
          kind: 'UNAVAILABLE' as const,
        },
      ];
    });

    return {
      payload: { requestId, walkers, rooms, lessons, roomPreferences, constraints },
      maps,
    };
  }

  /**
   * The engine's answer in real ids — and refused whole if it moves anything
   * it was not allowed to.
   *
   * A change to a lesson that was locked, roomless, frozen or never sent is
   * not a proposal for this timetable, whatever the engine's status says, and
   * showing it would have the school confirm a move that apply then refuses.
   * Walkers and frozen ids are only displayed, so one the maps do not know is
   * dropped rather than failing the answer.
   */
  private realise(
    response: OptimizeRoomsResponse,
    placed: LessonRow[],
    maps: RoomAnonMaps,
  ): Pick<
    RoomProposal,
    'changes' | 'teachers' | 'groups' | 'missedWishes' | 'walkers' | 'frozenLessonIds'
  > {
    const realLesson = reverse(maps.lessons);
    const realRoom = reverse(maps.rooms);
    const realTeacher = reverse(maps.teachers);
    const realGroup = reverse(maps.groups);
    const lessonById = new Map(placed.map((lesson) => [lesson.id, lesson]));
    const frozen = new Set(response.frozenLessonIds);

    const moved = new Set<string>();
    const changes = response.changes.map((change): RoomMove => {
      const lesson = lessonById.get(realLesson.get(change.lessonId) ?? '');
      const toRoomId = realRoom.get(change.roomId);
      if (
        !lesson ||
        !toRoomId ||
        lesson.isLocked ||
        lesson.roomId === null ||
        lesson.roomId === toRoomId ||
        frozen.has(change.lessonId) ||
        moved.has(lesson.id)
      ) {
        this.logger.error(
          `Rejected a room proposal: it moves lesson ${change.lessonId} to room ${change.roomId}, which the request did not allow.`,
        );
        throw new HttpException(
          'The AI engine returned a room proposal that does not match the request.',
          HttpStatus.BAD_GATEWAY,
        );
      }
      moved.add(lesson.id);
      return { lessonId: lesson.id, fromRoomId: lesson.roomId, toRoomId };
    });

    return {
      changes,
      teachers: compared(response.teachers),
      groups: compared(response.groups),
      missedWishes: {
        before: response.missedWishes.before,
        after: response.missedWishes.after,
      },
      walkers: response.walkers.flatMap((walker): WalkerWalk[] => {
        const id = (walker.kind === 'TEACHER' ? realTeacher : realGroup).get(walker.id);
        return id
          ? [{ kind: walker.kind, id, before: walk(walker.before), after: walk(walker.after) }]
          : [];
      }),
      frozenLessonIds: response.frozenLessonIds.flatMap((anonId) => {
        const id = realLesson.get(anonId);
        return id ? [id] : [];
      }),
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * The digest of everything a proposal read.
 *
 * Rows sorted by id and fields in a fixed order, as arrays: the database may
 * return rows in any order, and a basis that changed with the query plan would
 * refuse every apply. Only what the proposal depends on is in it — the version
 * an apply writes, or an `updatedAt` the moves themselves bump, must not make
 * the undo stale.
 *
 * That includes what each lesson asks of a room. The engine offered a lesson
 * only the rooms that fit its headcount, its years and its subject's room
 * type, and apply re-checks clashes but not fit — so a pupil added to 7A, a
 * class moved up a year or a subject that now needs a lab has to make the
 * proposal stale, or apply puts a class in a room it no longer fits. Hashed as
 * the derived needs rather than the rosters behind them: that is exactly what
 * the engine read, it keeps student ids out of the digest, and a pupil who
 * swaps places with another of the same year changes nothing it depends on.
 */
function basisOf(state: YearState): string {
  const canonical = {
    lessons: sortedById(state.lessons).map((lesson) => [
      lesson.id,
      lesson.dayOfWeek,
      clock(lesson.startTime),
      clock(lesson.endTime),
      lesson.roomId,
      lesson.teacherId,
      lesson.coTeacherId,
      lesson.studentGroupId,
      lesson.extraGroups.map((entry) => entry.studentGroupId).sort(),
      lesson.subjectId,
      lesson.recurrence,
      day(lesson.startDate),
      day(lesson.endDate),
      lesson.isLocked,
      lesson.isParked,
      needsKey(state.needs.get(lesson.id)),
    ]),
    rooms: sortedById(state.rooms).map((room) => [
      room.id,
      room.capacity,
      room.roomTypeId,
      room.minGradeLevel,
      room.maxGradeLevel,
      room.building,
      room.floor,
    ]),
    roomPreferences: sortedById(state.preferences).map((rule) => [
      rule.id,
      rule.subjectId,
      rule.kind,
      rule.minGradeLevel,
      rule.maxGradeLevel,
      rule.roomTypeId,
      rule.weight,
      rule.rooms.map((entry) => entry.roomId).sort(),
    ]),
    constraints: sortedById(state.constraints).map((row) => [
      row.id,
      row.roomId,
      row.dayOfWeek,
      clock(row.startTime),
      clock(row.endTime),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Room needs in a fixed order; null for a lesson that is never sent. */
function needsKey(needs: RoomNeeds | undefined): unknown[] | null {
  return needs
    ? [
        needs.studentGroupSize,
        needs.minGradeLevel,
        needs.maxGradeLevel,
        needs.requiredRoomTypeId,
      ]
    : null;
}

/**
 * The requested moves, each checked against what was just read.
 *
 * The basis matched, so the proposal was computed from exactly this state —
 * which makes every failure below a request the proposal never produced, and
 * a 400. The one exception is a from-room that is not the lesson's room: the
 * page is holding moves for another timetable than this one, and recomputing
 * is what fixes it, so that answers as stale.
 */
function checkedMoves(state: YearState, changes: RoomChangeDto[]): Map<string, RoomChangeDto> {
  const lessons = new Map(state.lessons.map((lesson) => [lesson.id, lesson]));
  const rooms = new Set(state.rooms.map((room) => room.id));
  const moves = new Map<string, RoomChangeDto>();
  for (const change of changes) {
    if (moves.has(change.lessonId)) {
      throw new BadRequestException(`Lesson ${change.lessonId} is moved more than once.`);
    }
    const lesson = lessons.get(change.lessonId);
    if (!lesson) {
      throw new BadRequestException(`Lesson ${change.lessonId} is not in this academic year.`);
    }
    // A locked lesson keeps its room, and a parked one occupies none.
    if (lesson.isLocked || lesson.isParked) {
      throw new BadRequestException(
        `Lesson ${change.lessonId} is ${lesson.isLocked ? 'locked' : 'parked'} and keeps its room.`,
      );
    }
    if (!rooms.has(change.toRoomId)) {
      throw new BadRequestException(`Room ${change.toRoomId} does not exist.`);
    }
    if (change.toRoomId === change.fromRoomId) {
      throw new BadRequestException(`Lesson ${change.lessonId} is moved to the room it is in.`);
    }
    if (lesson.roomId !== change.fromRoomId) throw stale();
    moves.set(change.lessonId, change);
  }
  return moves;
}

/**
 * Refuse any room clash the moves would CREATE.
 *
 * Defensive: the engine never proposes one, and apply only replays what it
 * proposed. But apply is also undo, and an HTTP route will take any body it is
 * given — so the invariant is checked where the write happens, not only where
 * the proposal is made.
 *
 * A clash is the gateway's own rule, the one the grid and the manual editor
 * apply: same day, half-open overlap, and weeksCanOverlap. Pairs that already
 * shared a room before are left alone — a shared hall may be deliberate, and
 * the engine froze those lessons rather than resolve them. In memory and
 * before the first write, because times never change here: what was read,
 * with the new rooms laid over it, IS the state the writes would produce.
 */
function assertNoNewClash(state: YearState, moves: Map<string, RoomChangeDto>): void {
  // Only what the engine was shown holds a room here. A parked lesson occupies
  // nothing, here as in every other clash check; and one that ends before it
  // starts was withheld from the engine, which therefore offered its room
  // freely — counting it here would refuse that offer on every apply, and
  // recomputing would only offer it again.
  const byDay = new Map<number, LessonRow[]>();
  for (const lesson of state.lessons) {
    if (!sendable(lesson)) continue;
    const onDay = byDay.get(lesson.dayOfWeek);
    if (onDay) onDay.push(lesson);
    else byDay.set(lesson.dayOfWeek, [lesson]);
  }
  const roomAfter = (lesson: LessonRow): string | null =>
    moves.get(lesson.id)?.toRoomId ?? lesson.roomId;

  for (const move of moves.values()) {
    const lesson = state.lessons.find((candidate) => candidate.id === move.lessonId)!;
    for (const other of byDay.get(lesson.dayOfWeek) ?? []) {
      if (other.id === lesson.id) continue;
      if (roomAfter(other) !== move.toRoomId) continue;
      const sharedBefore = lesson.roomId !== null && lesson.roomId === other.roomId;
      if (sharedBefore) continue;
      if (!meet(lesson, other)) continue;
      throw new ConflictException({
        message:
          'Salsbytet skulle krocka med en annan lektion i samma sal. Inget ändrades.',
        code: ROOM_CLASH,
      });
    }
  }
}

/** Invariant 7: the rule MasterLessonsService.findConflicts applies. */
function meet(a: LessonRow, b: LessonRow): boolean {
  return (
    a.dayOfWeek === b.dayOfWeek &&
    minutes(a.startTime) < minutes(b.endTime) &&
    minutes(b.startTime) < minutes(a.endTime) &&
    weeksCanOverlap(a, b)
  );
}

function stale(): ConflictException {
  return new ConflictException({
    message:
      'Grundschemat har ändrats sedan förslaget beräknades. Beräkna ett nytt förslag.',
    code: ROOM_PROPOSAL_STALE,
  });
}

/**
 * Whether a lesson goes to the engine at all.
 *
 * Not a parked one: it occupies nothing (see its schema comment), so it is
 * neither a room to protect nor a step in anybody's day. Nor one that ends
 * before it starts: nothing in the database forbids such a row, it occupies no
 * minute, and the engine refuses the WHOLE request over it with a validation
 * error no school could act on.
 */
function sendable(lesson: LessonRow): boolean {
  return !lesson.isParked && lesson.endTime.getTime() > lesson.startTime.getTime();
}

/** The lesson's group first, then its other classes, each once. */
function groupsOf(lesson: LessonRow): string[] {
  return [
    ...new Set([
      lesson.studentGroupId,
      ...lesson.extraGroups.map((entry) => entry.studentGroupId),
    ]),
  ];
}

/**
 * The maps a refusal from this route is translated through.
 *
 * Room rules go in the requirement slot because that is where the generator
 * mints their ids too (see fetchAndAnonymize), so a sentence naming a rule
 * reads the same from either route. No names: an engine sentence here is a
 * programming error about ids, not a school-facing refusal.
 */
function refusalMaps(maps: RoomAnonMaps): AnonMaps {
  return {
    requirementAnonMap: maps.preferences,
    roomAnonMap: maps.rooms,
    groupAnonMap: maps.groups,
    roomTypeAnonMap: maps.roomTypes,
    constraintAnonMap: maps.constraints,
    // This route sends no arbetstider — it moves lessons between rooms and
    // leaves every time exactly where it was, so no teacher's lunch or night can
    // be the thing it fails on. Empty rather than absent, so the map stays
    // required in AnonMaps and a route that genuinely needs it cannot forget.
    workRuleAnonMap: new Map(),
    nameById: new Map(),
    lessonAnonMap: maps.lessons,
  };
}

function reverse(map: Map<string, string>): Map<string, string> {
  return new Map([...map].map(([realId, anonId]) => [anonId, realId]));
}

function sortedById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A walk copied field by field. The reply is read through a bare generic with
 * no runtime validation, so this is what keeps a field the engine adds later
 * from riding through to the page unannounced.
 */
function walk(value: Walk): Walk {
  return {
    roomChanges: value.roomChanges,
    floorChanges: value.floorChanges,
    buildingChanges: value.buildingChanges,
  };
}

function compared(value: WalkComparison): WalkComparison {
  return { before: walk(value.before), after: walk(value.after) };
}

function stillWalk(): WalkComparison {
  const none = (): Walk => ({ roomChanges: 0, floorChanges: 0, buildingChanges: 0 });
  return { before: none(), after: none() };
}

/** A `@db.Time` as the HH:MM:SS the engine reads, in UTC as Prisma anchors it. */
function clock(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  const s = time.getUTCSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Minutes as MasterLessonsService counts them, so both read one clash. */
function minutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

function day(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
