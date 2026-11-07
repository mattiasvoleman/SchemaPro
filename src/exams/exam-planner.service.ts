import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { isoWeekday } from '../calendar/publish-days';
import { requireSchoolId } from '../common/utils/request-context';
import { todayInZone } from '../common/utils/time';
import { schoolTimezone } from '../cover/cover-context';
import { PrismaService } from '../database/prisma.service';
import { OptimizationProxyService, type AnonMaps } from '../optimization/optimization-proxy.service';
import { ScheduleActivitiesService } from '../publication/schedule-activities.service';
import { ownersOf } from '../publication/activity-plan';
import { asDay, day as dayOf } from '../publication/cancellation-core';
import { loadGroupFacts, memberHomes, ownersWithPupils } from '../publication/activity-replacements';
import { enterGrundschemaWrite, isLockTimeout } from '../publication/publish-mode';
import { isRoomAlreadyHeld } from '../room-bookings/room-bookings.service';
import { checkScope, createCreditInTransaction } from '../timplan/timplan-credits.service';
import { markedIds } from '../users/person-protections';
import { roomFreeFor, teacherFreeFor, type SlotSpan } from './exam-availability';
import {
  badExam,
  conflictingExam,
  EXAM_BUSY,
  EXAM_IS_PLANNED,
  EXAM_NO_REPLACEMENT_SUBJECT,
  EXAM_NO_ROOMS,
  EXAM_NOT_PLANNED,
  EXAM_PLACEMENT,
  EXAM_PLANNING_OFF,
  EXAM_ROOM_TAKEN,
  EXAM_STALE,
  EXAM_TOO_MANY,
  forbiddenExam,
} from './exam-errors';
import { clockOf, invigilatorsNeeded, minuteOf, seatGroups } from './exam-plan';
import {
  datesToRead,
  examFacts,
  loanCheck,
  readCancellableLessons,
  readLoans,
  readRoomUses,
  readTeacherDays,
  standingOf,
  instantOf,
  type Facts,
} from './exam-reads';
import { buildRequest, realise, type PlanningExam, type PlanningState, type RealisedPlan } from './exam-request';
import type { PlanExamsResponse } from './interfaces/exam-engine.interface';
import type { ApplyExamPlanDto, ApplyItemDto, PlanExamsDto } from './dto/exam.dto';
import {
  EXAM_SELECT,
  clearLeftovers,
  isPlanned,
  readOne,
  readSettings,
  watchMinutes,
  type ExamRow,
  type ExamSettingsView,
} from './exams.service';

/** The engine's route; see optimization-engine/app/api/v1/exams.py. */
const PLAN_EXAMS_PATH = '/api/v1/plan-exams';

/** The most exams the engine takes in one request. */
const MAX_EXAMS = 300;

/** The wait for one proposal: the engine's own budget (20 s by default) and its headroom, with a margin. */
const PLAN_TIMEOUT_MS = 90_000;

export interface ProposedRoom {
  roomId: string;
  roomName: string;
  writers: number;
  /** The classes that sit there, by name. */
  classes: string[];
  invigilators: Array<{ teacherId: string; name: string }>;
}

export interface ProposedExam {
  examId: string;
  name: string;
  /** The exam's version as read: the apply sends it back. */
  version: string;
  date: string;
  start: string;
  end: string;
  /** Lesson minutes of other subjects the time takes away. */
  loss: number;
  rooms: ProposedRoom[];
}

export interface UnplacedExam {
  examId: string;
  name: string;
  reason: string;
  params: Record<string, string | number>;
  /** The engine's English, or null when the gateway gave the reason. */
  message: string | null;
}

export interface CounterChange {
  teacherId: string;
  name: string;
  passes: number;
  minutes: number;
  addedPasses: number;
  addedMinutes: number;
}

export interface ExamProposal {
  /** NOTHING_TO_PLAN when no exam was left to ask about. */
  status: 'OPTIMAL' | 'FEASIBLE' | 'NOTHING_TO_PLAN';
  placed: ProposedExam[];
  unplaced: UnplacedExam[];
  counter: CounterChange[];
  metrics: PlanExamsResponse['metrics'] | null;
}

export interface ApplyOutcome {
  examId: string;
  ok: boolean;
  activityId?: string;
  code?: string;
  message?: string;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  applied: number;
  failed: number;
}

/**
 * PROVPLANERING: the exams are laid by a small model in the engine, and the
 * result is made of what the product already has.
 *
 * ## A proposal, and nothing is laid
 *
 * `propose` reads the unplaced exams of a läsår and everything that decides
 * where they can go (exam-reads.ts), builds the engine's request from it
 * (exam-request.ts), calls the engine OUTSIDE any transaction (a solve held in
 * a pooled connection would run into withRls's own timeout), and answers with
 * the placements, the exams that did not fit and the reason each did not (the
 * engine's, or the gateway's when an exam had no time to offer), and the
 * invigilator counter before and after. The reasons are written on the exams
 * (Exams.lastReason) without touching their version, so that they are still
 * there when the proposal has been closed. The school's switch is checked
 * first: a school that has not turned the planner on can enter exams and
 * mark rooms but is not given a proposal.
 *
 * ## Apply: an exam is a schemabrytande aktivitet
 *
 * `apply` takes the placements the administrator accepted and, for each, in a
 * transaction of its own, asks everything again: the exam is as the proposal
 * read it (its version), the time and the rooms are inside the exam's window and
 * the skrivsalar, the invigilators are in the pool and free by the same rules
 * that found them, and the classes' caps and clashes hold against the exams that
 * stand now (the ones applied a moment ago in this very call included). Then
 * the activity is made by ScheduleActivitiesService.createWithin: the lessons
 * the exam overlaps are cancelled, a replacement lesson per class carries the
 * register, the invigilators of a class's rooms are its teachers. On top of that
 * the exam writes what an activity with a time window cannot: the credit of its
 * own minutes to its subject (the same TimplanCredit an activity writes, linked
 * to the same avbokning so that removing the activity removes it), a booking
 * for each room, and a room on each class's replacement lesson. One exam failing
 * leaves the others as they were; the answer names which and why.
 *
 * ## Unplan
 *
 * Removes the activity by the activity's own remove (lessons back, credits
 * and replacement lessons ahead gone) and then what the exam holds beside it.
 */
@Injectable()
export class ExamPlannerService {
  private readonly logger = new Logger(ExamPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
    private readonly activities: ScheduleActivitiesService,
  ) {}

  async propose(dto: PlanExamsDto, user: AuthenticatedUser): Promise<ExamProposal> {
    const schoolId = requireSchoolId(user);
    const read = await this.prisma.withRls(user, (tx) => this.readState(tx, schoolId, dto));
    if (read.state.exams.length === 0 && read.unplacedUpFront.length === 0) {
      return { status: 'NOTHING_TO_PLAN', placed: [], unplaced: [], counter: [], metrics: null };
    }
    const built = buildRequest(read.state);
    let realised: RealisedPlan;
    if (built.request.exams.length === 0) {
      realised = {
        status: 'OPTIMAL',
        placed: [],
        unplaced: built.unplaced.map((one) => ({ examId: one.examId, reason: one.reason, params: one.params, message: null })),
        added: new Map(),
        metrics: { placed: 0, unplaced: built.unplaced.length, loss: 0, roomsUsed: 0, invigilatorPasses: 0, maxLoad: 0, minLoad: 0, solveSeconds: 0 },
      };
    } else {
      // The engine takes at most MAX_EXAMS in one request; a school with more lays them a week at a time.
      if (built.request.exams.length > MAX_EXAMS) {
        throw badExam(EXAM_TOO_MANY, `Planera högst ${MAX_EXAMS} prov åt gången: välj de prov som hör till en provvecka.`, { limit: MAX_EXAMS });
      }
      const response = await this.proxy.callAiEngine<PlanExamsResponse>(PLAN_EXAMS_PATH, built.request, engineMaps(), {
        timeoutMs: PLAN_TIMEOUT_MS,
      });
      realised = realise(built, response);
    }
    realised.unplaced.push(...read.unplacedUpFront.map((one) => ({ examId: one.examId, reason: one.reason, params: one.params, message: null })));
    return this.present(user, schoolId, dto, read, realised);
  }

  async apply(dto: ApplyExamPlanDto, user: AuthenticatedUser): Promise<ApplyResult> {
    const schoolId = requireSchoolId(user);
    const outcomes: ApplyOutcome[] = [];
    // One exam at a time, in the order given: each is judged against the ones laid before it.
    for (const item of dto.items) {
      try {
        const done = await this.prisma.withRls(user, (tx) => this.applyOne(tx, user, schoolId, dto, item), { timeoutMs: 120_000 });
        await this.activities.settleCreated(user, done.created);
        outcomes.push({ examId: item.examId, ok: true, activityId: done.created.id });
      } catch (error) {
        outcomes.push(refusalOf(item.examId, error, this.logger));
      }
    }
    const applied = outcomes.filter((outcome) => outcome.ok).length;
    return { outcomes, applied, failed: outcomes.length - applied };
  }

  async unplan(examId: string, user: AuthenticatedUser): Promise<{ removed: true }> {
    requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) => readOne(tx, examId));
    if (row.activityId && isPlanned(row)) await this.activities.remove(row.activityId, user);
    else if (row.sittings.length === 0 && row.activityId === null) {
      throw conflictingExam(EXAM_NOT_PLANNED, 'Provet är inte lagt.');
    }
    await this.prisma.withRls(user, async (tx) => clearLeftovers(tx, [await readOne(tx, examId)]));
    return { removed: true };
  }

  // -------------------------------------------------------------------------

  private async readState(tx: PrismaClient, schoolId: string, dto: PlanExamsDto) {
    const settings = await readSettings(tx, schoolId);
    this.assertReady(settings);
    const skrivsalar = await tx.examRoom.findMany({ select: { roomId: true, seats: true } });
    if (skrivsalar.length === 0) {
      throw badExam(EXAM_NO_ROOMS, 'Ingen sal är markerad som skrivsal: markera de salar som får användas.');
    }
    const timezone = await schoolTimezone(tx, schoolId);
    const now = new Date();
    const today = asDay(todayInZone(timezone, now));
    const all = (await tx.exam.findMany({ where: { academicYearId: dto.academicYearId }, select: EXAM_SELECT })) as ExamRow[];
    await clearLeftovers(tx, all);
    const standingRows = all.filter(isPlanned);
    const toPlan = all.filter((row) => !isPlanned(row) && (dto.examIds === undefined || dto.examIds.includes(row.id)));

    const groups = await loadGroupFacts(tx, dto.academicYearId);
    const homes = await memberHomes(tx, groups.filter((group) => group.kind === 'TEACHING_GROUP').map((group) => group.id));
    const facts: Facts = { groups, byId: new Map(groups.map((group) => [group.id, group])), homes };

    const unplacedUpFront: Array<{ examId: string; reason: string; params: Record<string, string | number> }> = [];
    const windows = toPlan.map((row) => ({ from: asDay(row.windowFrom), to: asDay(row.windowTo) }));
    const first = windows.map((w) => w.from).sort()[0] ?? today;
    const last = windows.map((w) => w.to).sort().reverse()[0] ?? today;
    const breaks = await tx.schoolBreak.findMany({
      where: { academicYearId: dto.academicYearId, startDate: { lte: dayOf(last) }, endDate: { gte: dayOf(first) } },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    const exams: PlanningExam[] = [];
    for (const row of toPlan) {
      const planning = examFacts(row, facts, breaks);
      if (planning) exams.push(planning);
      else unplacedUpFront.push({ examId: row.id, reason: 'EXAM_GROUPS_GONE', params: {} });
    }

    const touched = [...new Set(exams.flatMap((exam) => [...exam.affected]))];
    const lessons = await readCancellableLessons(tx, touched, first, last, timezone, now);
    const dates = datesToRead(exams, today);
    const held = await markedIds(tx, schoolId);
    const teachers = (await tx.user.findMany({ where: { role: 'TEACHER', isActive: true }, select: { id: true } }))
      .map((teacher) => teacher.id)
      .filter((id) => !held.has(id))
      .sort();
    const personDays = await readTeacherDays(tx, teachers, dates, timezone, dto.academicYearId);
    const roomIds = skrivsalar.map((room) => room.roomId);
    const roomUses = await readRoomUses(tx, roomIds, dates, timezone);
    const loans = await readLoans(tx);
    const prior = new Map([...(await watchMinutes(tx, dto.academicYearId))].map(([id, entry]) => [id, entry.minutes]));

    const state: PlanningState = {
      today,
      timezone,
      limits: {
        maxPerClassPerDay: settings.maxPerClassPerDay,
        maxPerClassPerWeek: settings.maxPerClassPerWeek,
        writersPerInvigilator: settings.writersPerInvigilator,
        turnoverMinutes: settings.turnoverMinutes,
      },
      exams,
      lessons,
      teacherIds: teachers,
      personDays,
      prior,
      rooms: skrivsalar.map((room) => ({ id: room.roomId, seats: room.seats })),
      roomUses,
      loan: loanCheck(loans, timezone),
      standing: standingOf(standingRows, facts),
    };
    return { state, rows: toPlan, facts, settings, unplacedUpFront };
  }

  private assertReady(settings: ExamSettingsView): void {
    if (!settings.enabled) {
      throw forbiddenExam(EXAM_PLANNING_OFF, 'Provplaneringen är inte påslagen för skolan.');
    }
    if (!settings.replacementSubject) {
      throw badExam(EXAM_NO_REPLACEMENT_SUBJECT, 'Välj det ämne provens ersättningslektioner hålls i (ett som inte räknas mot timplanen).');
    }
  }

  /** The proposal in names, with the counter before and after; the reasons written on the exams. */
  private async present(
    user: AuthenticatedUser,
    schoolId: string,
    dto: PlanExamsDto,
    read: Awaited<ReturnType<ExamPlannerService['readState']>>,
    plan: RealisedPlan,
  ): Promise<ExamProposal> {
    return this.prisma.withRls(user, async (tx) => {
      const byId = new Map(read.rows.map((row) => [row.id, row]));
      const roomIds = [...new Set(plan.placed.flatMap((one) => one.rooms.map((room) => room.roomId)))];
      const [rooms, teachers, minutes] = await Promise.all([
        tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } }),
        tx.user.findMany({ where: { role: 'TEACHER', isActive: true }, select: { id: true, firstName: true, lastName: true } }),
        watchMinutes(tx, dto.academicYearId),
      ]);
      const held = await markedIds(tx, schoolId);
      const roomName = new Map(rooms.map((room) => [room.id, room.name]));
      const teacherName = new Map(teachers.map((teacher) => [teacher.id, `${teacher.firstName} ${teacher.lastName}`]));
      const settings = read.settings;

      const placed: ProposedExam[] = [];
      for (const one of plan.placed) {
        const row = byId.get(one.examId);
        if (!row) continue;
        const owners = await classNamesByRoom(tx, read.facts, row, settings.replacementSubject!.id, one);
        placed.push({
          examId: one.examId,
          name: row.name,
          version: row.updatedAt.toISOString(),
          date: one.date,
          start: clockOf(one.start),
          end: clockOf(one.end),
          loss: one.loss,
          rooms: one.rooms.map((room) => ({
            roomId: room.roomId,
            roomName: roomName.get(room.roomId) ?? '',
            writers: room.writers,
            classes: owners.get(room.roomId) ?? [],
            // The pool left a protected teacher out, so nobody here is one; this holds a mark made since.
            invigilators: room.teacherIds
              .filter((id) => !held.has(id))
              .map((id) => ({ teacherId: id, name: teacherName.get(id) ?? '' }))
              .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.teacherId.localeCompare(b.teacherId)),
          })),
        });
      }
      placed.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name, 'sv'));

      // A reason that names a class says it by name: the engine had only an id it minted.
      const named = (params: Record<string, string | number>): Record<string, string | number> => {
        const { classId, ...rest } = params;
        const name = typeof classId === 'string' ? read.facts.byId.get(classId)?.name : undefined;
        return name ? { ...rest, class: name } : rest;
      };
      const unplaced: UnplacedExam[] = plan.unplaced
        .map((one) => ({ examId: one.examId, name: byId.get(one.examId)?.name ?? '', reason: one.reason, params: named(one.params), message: one.message }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.examId.localeCompare(b.examId));

      // What the run said, kept on the exams without moving their version.
      const stamp = new Date();
      for (const row of read.rows) {
        const left = plan.unplaced.find((one) => one.examId === row.id);
        await tx.exam.update({
          where: { id: row.id },
          data: left
            ? { lastReason: left.reason, lastReasonParams: named(left.params) as Prisma.InputJsonValue, lastPlannedAt: stamp, updatedAt: row.updatedAt }
            : { lastReason: null, lastReasonParams: Prisma.DbNull, lastPlannedAt: null, updatedAt: row.updatedAt },
        });
      }

      const counter: CounterChange[] = teachers
        .filter((teacher) => !held.has(teacher.id) && ((minutes.get(teacher.id)?.minutes ?? 0) > 0 || plan.added.has(teacher.id)))
        .map((teacher) => ({
          teacherId: teacher.id,
          name: teacherName.get(teacher.id) ?? '',
          passes: minutes.get(teacher.id)?.passes ?? 0,
          minutes: minutes.get(teacher.id)?.minutes ?? 0,
          addedPasses: plan.placed.reduce((sum, one) => sum + one.rooms.filter((room) => room.teacherIds.includes(teacher.id)).length, 0),
          addedMinutes: plan.added.get(teacher.id) ?? 0,
        }))
        .sort((a, b) => b.minutes + b.addedMinutes - (a.minutes + a.addedMinutes) || a.name.localeCompare(b.name, 'sv'));
      return { status: plan.status, placed, unplaced, counter, metrics: plan.metrics };
    });
  }

  // -------------------------------------------------------------------------

  /** One exam of an accepted proposal, asked everything again and made, in the caller's transaction. */
  private async applyOne(tx: PrismaClient, user: AuthenticatedUser, schoolId: string, dto: ApplyExamPlanDto, item: ApplyItemDto) {
    // One exam of a year is laid at a time: two applies that read the same free room or the same free teacher
    // would each lay an exam on them (the booking's exclusion stops the room, nothing stops the teacher).
    // The publication lock first, this second, as the other applies take them.
    await enterGrundschemaWrite(tx, schoolId);
    await lockExamApply(tx, dto.academicYearId);
    const settings = await readSettings(tx, schoolId);
    this.assertReady(settings);
    const row = await readOne(tx, item.examId);
    await clearLeftovers(tx, [row]);
    if (isPlanned(row)) throw conflictingExam(EXAM_IS_PLANNED, 'Provet är redan lagt.');
    if (row.updatedAt.toISOString() !== item.examVersion) {
      throw conflictingExam(EXAM_STALE, 'Provet har ändrats sedan förslaget gjordes: planera om.');
    }
    if (row.academicYearId !== dto.academicYearId) throw badExam(EXAM_PLACEMENT, 'Provet hör till ett annat läsår.');

    const timezone = await schoolTimezone(tx, schoolId);
    const today = asDay(todayInZone(timezone));
    const groups = await loadGroupFacts(tx, row.academicYearId);
    const homes = await memberHomes(tx, groups.filter((group) => group.kind === 'TEACHING_GROUP').map((group) => group.id));
    const facts: Facts = { groups, byId: new Map(groups.map((group) => [group.id, group])), homes };
    const breaks = await tx.schoolBreak.findMany({
      where: { academicYearId: row.academicYearId, startDate: { lte: row.windowTo }, endDate: { gte: row.windowFrom } },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    const exam = examFacts(row, facts, breaks);
    if (!exam) throw badExam(EXAM_PLACEMENT, 'Provets klasser och grupper finns inte längre i läsåret.');

    // The time.
    const start = minuteOf(item.start);
    const end = start + exam.lengthMinutes;
    this.assertTime(exam, item.date, start, end, today);

    // The rooms and the invigilators.
    const marks = new Map((await tx.examRoom.findMany({ select: { roomId: true, seats: true } })).map((mark) => [mark.roomId, mark.seats]));
    const seen = new Set<string>();
    let seated = 0;
    for (const room of item.rooms) {
      const seats = marks.get(room.roomId);
      if (seats === undefined) throw badExam(EXAM_PLACEMENT, 'En sal är inte längre markerad som skrivsal.');
      if (seen.has(room.roomId)) throw badExam(EXAM_PLACEMENT, 'En sal anges två gånger.');
      seen.add(room.roomId);
      if (room.writers > seats) throw badExam(EXAM_PLACEMENT, `Salen rymmer ${seats} skrivande, inte ${room.writers}.`);
      if (room.teacherIds.length < invigilatorsNeeded(room.writers, settings.writersPerInvigilator)) {
        throw badExam(EXAM_PLACEMENT, 'En sal har färre vakter än den behöver.');
      }
      seated += room.writers;
    }
    if (seated !== exam.writers) throw badExam(EXAM_PLACEMENT, 'Platserna i salarna stämmer inte med antalet skrivande.');
    const teacherIds = item.rooms.flatMap((room) => room.teacherIds);
    if (new Set(teacherIds).size !== teacherIds.length) throw badExam(EXAM_PLACEMENT, 'En lärare kan inte vaka i två salar.');
    const held = await markedIds(tx, schoolId);
    const pool = new Set(
      (await tx.user.findMany({ where: { id: { in: teacherIds }, role: 'TEACHER', isActive: true }, select: { id: true } })).map((teacher) => teacher.id),
    );
    for (const id of teacherIds) {
      if (!pool.has(id) || held.has(id)) throw badExam(EXAM_PLACEMENT, 'En vakt finns inte eller får inte vara vakt.');
    }

    // Free by the rules that found them, now.
    const slot: SlotSpan = { date: item.date, start: instantOf(item.date, start, timezone), end: instantOf(item.date, end, timezone) };
    const days = await readTeacherDays(tx, teacherIds, [item.date], timezone, row.academicYearId);
    for (const id of teacherIds) {
      const personDay = days.get(item.date)?.get(id);
      if (!personDay || !teacherFreeFor(personDay, slot, exam.affected)) throw badExam(EXAM_PLACEMENT, 'En vakt är inte längre ledig.');
    }
    const uses = await readRoomUses(tx, [...seen], [item.date], timezone);
    const loans = loanCheck(await readLoans(tx), timezone);
    for (const roomId of seen) {
      if (!roomFreeFor(roomId, uses.get(roomId), slot, exam.affected, loans)) throw conflictingExam(EXAM_ROOM_TAKEN, 'En sal är inte längre ledig.');
    }

    // The classes' clashes and caps against the exams that stand now.
    const standingRows = (await tx.exam.findMany({ where: { academicYearId: row.academicYearId, id: { not: row.id } }, select: EXAM_SELECT })) as ExamRow[];
    const standing = standingOf(standingRows.filter(isPlanned), facts);
    this.assertClasses(exam, item.date, start, end, standing, settings);

    // The activity.
    await enterGrundschemaWrite(tx, schoolId);
    const owners = ownersOf({ scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: exam.named }, groups);
    const { planOwners } = await ownersWithPupils(tx, { scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: exam.named }, groups, settings.replacementSubject!.id);
    const seating = seatGroups(
      planOwners.map((owner) => ({ groupId: owner.groupId, pupils: owner.pupils.size })),
      exam.writers,
      item.rooms.map((room) => ({ roomId: room.roomId, writers: room.writers })),
    );
    const teachersByGroup = new Map<string, string[]>();
    for (const room of seating) {
      const there = item.rooms.find((candidate) => candidate.roomId === room.roomId)!;
      for (const seat of room.groups) {
        const list = teachersByGroup.get(seat.groupId) ?? [];
        for (const id of there.teacherIds) if (!list.includes(id)) list.push(id);
        teachersByGroup.set(seat.groupId, list);
      }
    }
    const created = await this.activities.createWithin(tx, user, {
      academicYearId: row.academicYearId,
      name: `Prov: ${row.name}`,
      fromDate: item.date,
      toDate: item.date,
      startTime: clockOf(start),
      endTime: clockOf(end),
      scope: 'GROUPS',
      groupIds: [...exam.named],
      replacementSubjectId: settings.replacementSubject!.id,
      teachers: owners.flatMap((owner) =>
        (teachersByGroup.get(owner.id) ?? []).slice(0, 8).map((teacherId, index) => ({
          studentGroupId: owner.id,
          teacherId,
          role: index === 0 ? ('LEAD' as const) : ('ASSISTANT' as const),
        })),
      ),
      notify: dto.notify !== false,
    });

    // What an activity with a time window cannot carry itself: the exam's own minutes as a credit, the rooms, the invigilators.
    const batch = await tx.scheduleActivity.findUniqueOrThrow({ where: { id: created.id }, select: { batchId: true } });
    for (const name of exam.named) {
      const target = checkScope({ studentGroupId: name, minGradeLevel: null, maxGradeLevel: null });
      const credit = await createCreditInTransaction(
        tx,
        schoolId,
        { academicYearId: row.academicYearId, date: item.date, minutes: exam.lengthMinutes, subjectId: row.subjectId, name: `Prov: ${row.name}`, ...target },
        target,
      );
      await tx.cancellationBatchCredit.create({ data: { batchId: batch.batchId, creditId: credit.id, schoolId } });
    }
    const startsAt = new Date(slot.start);
    const endsAt = new Date(slot.end);
    const bookedById = user.userId!;
    for (const room of item.rooms) {
      const booking = await tx.roomBooking
        .create({
          data: { schoolId, roomId: room.roomId, bookedById, title: `Prov: ${row.name}`, startsAt, endsAt, status: 'APPROVED' },
          select: { id: true },
        })
        .catch((error: unknown) => {
          if (isRoomAlreadyHeld(error)) throw conflictingExam(EXAM_ROOM_TAKEN, 'En sal hann bokas av någon annan.');
          throw error;
        });
      await tx.examSitting.create({ data: { examId: row.id, roomId: room.roomId, schoolId, writers: room.writers, bookingId: booking.id } });
      await tx.examInvigilator.createMany({ data: room.teacherIds.map((teacherId) => ({ examId: row.id, roomId: room.roomId, teacherId, schoolId })) });
    }
    // The room the pupils go to: where most of a class's writers sit.
    for (const owner of owners) {
      const mostly = seating
        .map((room) => ({ roomId: room.roomId, writers: room.groups.find((seat) => seat.groupId === owner.id)?.writers ?? 0 }))
        .sort((a, b) => b.writers - a.writers)[0];
      if (!mostly || mostly.writers === 0) continue;
      const link = await tx.scheduleActivityLesson.findFirst({ where: { activityId: created.id, studentGroupId: owner.id }, select: { calendarLessonId: true } });
      if (link) await tx.calendarLesson.update({ where: { id: link.calendarLessonId }, data: { roomId: mostly.roomId } });
    }
    await tx.exam.update({
      where: { id: row.id },
      data: { activityId: created.id, lastReason: null, lastReasonParams: Prisma.DbNull, lastPlannedAt: null },
    });
    return { created };
  }

  private assertTime(exam: PlanningExam, date: string, start: number, end: number, today: string): void {
    const refuse = (message: string) => badExam(EXAM_PLACEMENT, message);
    if (date <= today) throw refuse('Provet kan läggas tidigast i morgon.');
    if (isoWeekday(date) > 5) throw refuse('Provet kan inte läggas en helgdag.');
    if (date < exam.from || date > exam.to) throw refuse('Tiden ligger utanför provets fönster.');
    if (exam.closed.has(date)) throw refuse('Klassen har ledigt den dagen.');
    if (end > 1440) throw refuse('Provet slutar efter midnatt.');
    if (exam.windowKind === 'FIXED') {
      if (start !== exam.fixedStart) throw refuse('Ett fast prov flyttas inte från sin starttid.');
    } else {
      if (exam.earliestStart !== null && start < exam.earliestStart) throw refuse('Provet börjar före den tidigaste starten.');
      if (exam.latestEnd !== null && end > exam.latestEnd) throw refuse('Provet slutar efter den senaste sluttiden.');
    }
  }

  private assertClasses(
    exam: PlanningExam,
    date: string,
    start: number,
    end: number,
    standing: ReadonlyArray<{ date: string; start: number; end: number; classes: readonly string[] }>,
    settings: ExamSettingsView,
  ): void {
    const shared = (other: { classes: readonly string[] }) => other.classes.some((id) => exam.classes.includes(id));
    if (standing.some((other) => other.date === date && other.start < end && start < other.end && shared(other))) {
      throw conflictingExam(EXAM_PLACEMENT, 'En klass skriver redan ett annat prov då.', { rule: 'EXAM_CLASS_CLASH' });
    }
    for (const id of exam.classes) {
      const sameDay = standing.filter((other) => other.date === date && other.classes.includes(id)).length;
      if (sameDay + 1 > settings.maxPerClassPerDay) {
        throw conflictingExam(EXAM_PLACEMENT, `En klass skulle få fler än ${settings.maxPerClassPerDay} prov den dagen.`, { rule: 'EXAM_CLASS_DAY_CAP' });
      }
      const weekKey = isoWeekKey(date);
      const sameWeek = standing.filter((other) => isoWeekKey(other.date) === weekKey && other.classes.includes(id)).length;
      if (sameWeek + 1 > settings.maxPerClassPerWeek) {
        throw conflictingExam(EXAM_PLACEMENT, `En klass skulle få fler än ${settings.maxPerClassPerWeek} prov den veckan.`, { rule: 'EXAM_CLASS_WEEK_CAP' });
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** The year's exam-apply lock, exclusive, waited for at most 5 s. */
async function lockExamApply(tx: PrismaClient, academicYearId: string): Promise<void> {
  try {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('exam-apply'), hashtext(${academicYearId}::uuid::text))`;
  } catch (error) {
    if (isLockTimeout(error)) throw conflictingExam(EXAM_BUSY, 'Ett annat prov läggs just nu: försök igen om en stund.');
    throw error;
  }
}

function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const year = d.getUTCFullYear();
  return `${year}-${Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)}`;
}

/** The classes that sit in each room of a placed exam, by name. */
async function classNamesByRoom(
  tx: PrismaClient,
  facts: Facts,
  row: ExamRow,
  replacementSubjectId: string,
  placed: { rooms: Array<{ roomId: string; writers: number }> },
): Promise<Map<string, string[]>> {
  const named = row.groups.map((group) => group.studentGroupId).filter((id) => facts.byId.has(id));
  const rule = { scope: 'GROUPS' as const, minGradeLevel: null, maxGradeLevel: null, groupIds: named };
  const { planOwners } = await ownersWithPupils(tx, rule, facts.groups, replacementSubjectId);
  const seating = seatGroups(
    planOwners.map((owner) => ({ groupId: owner.groupId, pupils: owner.pupils.size })),
    row.writers,
    placed.rooms,
  );
  const name = (id: string) => facts.byId.get(id)?.name ?? '';
  return new Map(
    seating.map((room) => [room.roomId, [...new Set(room.groups.map((seat) => name(seat.groupId)))].sort((a, b) => a.localeCompare(b, 'sv'))]),
  );
}

/** A refused exam as the answer names it: the code and the sentence of whatever stopped it. */
function refusalOf(examId: string, error: unknown, logger: Logger): ApplyOutcome {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null) {
      const { message, code } = body as { message?: unknown; code?: unknown };
      return {
        examId,
        ok: false,
        code: typeof code === 'string' ? code : EXAM_PLACEMENT,
        message: typeof message === 'string' ? message : error.message,
      };
    }
    return { examId, ok: false, code: EXAM_PLACEMENT, message: error.message };
  }
  logger.error(`Exam could not be laid [exam=${examId}]: ${error instanceof Error ? error.message : String(error)}`);
  return { examId, ok: false, code: 'EXAM_APPLY_FAILED', message: 'Provet kunde inte läggas.' };
}

/** The maps the proxy reads a refusal's ids back through; this route's refusals name none of the generator's. */
function engineMaps(): AnonMaps {
  return {
    requirementAnonMap: new Map(),
    roomAnonMap: new Map(),
    groupAnonMap: new Map(),
    roomTypeAnonMap: new Map(),
    constraintAnonMap: new Map(),
    workRuleAnonMap: new Map(),
    nameById: new Map(),
    lessonAnonMap: new Map(),
  };
}

