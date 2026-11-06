import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { calendarLessonRosters, type CalendarRosterLesson } from '../calendar/lesson-roster';
import { isWriteConflict, writeConflict } from '../common/utils/prisma-errors';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { todayInZone, toWallClock, zonedTimeToUtc } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { sqlStateOf } from '../cover/cover-errors';
import { callsAt, priorAbsences, withoutList, type DayLesson, type ReportedSpan, type StartedMark } from './crisis-calls';
import { sendAlarm, sendEnded, sendGuardianAfter } from './crisis-notices';
import {
  DEFAULT_START_PROFILES,
  byName,
  countPupils,
  statusOf,
  sumCounts,
  type AlarmDetail,
  type AlarmSummary,
  type AlarmView,
  type CallBasisView,
  type CallView,
  type CrisisSettingsView,
  type FoundHereView,
  type MyAlarm,
  type MyCall,
  type MyCrisisResponse,
  type OtherPupilView,
  type PriorSourceView,
  type ProtocolView,
  type PupilView,
} from './crisis-views';
import type { AlarmListQueryDto, EndAlarmDto, MarkDto, StartAlarmDto, UpdateCrisisSettingsDto } from './dto/crisis.dto';

export const CRISIS_ALARM_OPEN = 'CRISIS_ALARM_OPEN';
export const CRISIS_ALARM_NOT_FOUND = 'CRISIS_ALARM_NOT_FOUND';
export const CRISIS_ALARM_ENDED = 'CRISIS_ALARM_ENDED';
export const CRISIS_NOT_YOURS = 'CRISIS_NOT_YOURS';
export const CRISIS_MARK_INVALID = 'CRISIS_MARK_INVALID';

/** The protocol list reads this many alarms unless it is asked for fewer. */
const LIST_LIMIT = 50;
/** How far ahead of a phone's clock an alarm may have started and still own a mark the phone made by lesson. */
const PHONE_CLOCK_SKEW_MS = 10 * 60_000;
/** The note an exercise gets when a real alarm cuts it short. */
const CUT_SHORT_NOTE = 'Avbröts av ett skarpt larm.';
/** The stand-in names of the group of pupils with no lesson; the screens say it in their own words (basis NO_LESSON). */
const NO_LESSON_GROUP = 'Ej i lektion just nu';
const NO_LESSON_SUBJECT = 'Ingen lektion pågår';

interface Names {
  get(id: string | null | undefined): { firstName: string; lastName: string } | null;
}

const nameOf = (names: Names, id: string | null | undefined): string | null => {
  const person = names.get(id);
  return person ? `${person.firstName} ${person.lastName}`.trim() : null;
};

/** The marks a call of this alarm answers to, as the rows hold them. */
type CallRow = Prisma.CrisisCallGetPayload<{ include: { teachers: true; pupils: true } }>;
type AlarmRow = Prisma.CrisisAlarmGetPayload<Record<string, never>>;

async function namesOf(tx: PrismaClient, ids: Iterable<string | null | undefined>): Promise<Names> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  const rows = wanted.length
    ? await tx.user.findMany({ where: { id: { in: wanted } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { get: (id) => (id ? (byId.get(id) ?? null) : null) };
}

function alarmView(alarm: AlarmRow, names: Names): AlarmView {
  return {
    id: alarm.id,
    kind: alarm.kind,
    mode: alarm.mode,
    startedAt: alarm.startedAt.toISOString(),
    startedBy: nameOf(names, alarm.startedByUserId),
    endedAt: alarm.endedAt?.toISOString() ?? null,
    endedBy: nameOf(names, alarm.endedByUserId),
    autoEnded: alarm.autoEnded,
    endNote: alarm.endNote,
    guardiansNotifiedAt: alarm.guardiansNotifiedAt?.toISOString() ?? null,
  };
}

function pupilViews(call: CallRow, names: Names, withMarker: boolean): PupilView[] {
  return call.pupils
    .map((pupil) => {
      const person = names.get(pupil.studentId);
      const prior = (pupil.priorAbsentSource ?? null) as PriorSourceView | null;
      return {
        studentId: pupil.studentId,
        firstName: person?.firstName ?? '',
        lastName: person?.lastName ?? '',
        status: statusOf(pupil.state, prior),
        priorAbsentSource: prior,
        markedAt: pupil.stateAt?.toISOString() ?? null,
        markedBy: withMarker ? nameOf(names, pupil.stateByUserId) : null,
      } satisfies PupilView;
    })
    .sort(byName);
}

/**
 * When the group had a mark for every pupil who was not absent before: the time of the last. Read from the
 * pupils, not kept on the call: a column the marks of a group all changed would be a row they all lock.
 */
function completedAtOf(call: CallRow): string | null {
  const expected = call.pupils.filter((pupil) => pupil.priorAbsentSource === null);
  if (expected.length === 0 || expected.some((pupil) => pupil.state === null || pupil.stateAt === null)) return null;
  return new Date(Math.max(...expected.map((pupil) => pupil.stateAt!.getTime()))).toISOString();
}

function callView(call: CallRow, names: Names): CallView {
  const pupils = pupilViews(call, names, true);
  const teachers = call.teachers.map((teacher) => ({
    userId: teacher.teacherId,
    name: nameOf(names, teacher.teacherId),
    role: teacher.role,
    answeredAt: teacher.answeredAt?.toISOString() ?? null,
  }));
  return {
    id: call.id,
    lessonId: call.calendarLessonId,
    basis: call.basis,
    groupName: call.groupName,
    subjectName: call.subjectName,
    roomName: call.roomName,
    lessonStartsAt: call.lessonStartsAt.toISOString(),
    lessonEndsAt: call.lessonEndsAt.toISOString(),
    completedAt: completedAtOf(call),
    uncovered: teachers.every((teacher) => teacher.userId === null),
    teachers,
    counts: countPupils(pupils.map((pupil) => pupil.status)),
    pupils,
  };
}

/** A call is done when nobody is left to ask: every expected pupil has a mark. */
const isDone = (call: CallView): boolean => call.counts.unreported === 0;

function summaryOf(alarm: AlarmRow, names: Names, calls: readonly CallView[]): AlarmSummary {
  const teachers = calls.flatMap((call) => call.teachers.filter((teacher) => teacher.userId !== null));
  return {
    ...alarmView(alarm, names),
    unlisted: calls.filter((call) => call.basis === 'NO_LESSON').reduce((sum, call) => sum + call.counts.pupils, 0),
    calls: calls.length,
    callsComplete: calls.filter(isDone).length,
    counts: sumCounts(calls.map((call) => call.counts)),
    teachers: teachers.length,
    teachersAnswered: teachers.filter((teacher) => teacher.answeredAt !== null).length,
  };
}

const CALL_INCLUDE = { teachers: true, pupils: true } as const;

/**
 * Krisläge: the roll call of an alarm (F2). The lists are taken from the
 * timetable in the transaction that starts the alarm (crisis-calls.ts says by
 * what rule) and never added to afterwards (the database holds the insert to
 * that transaction); a mark is appended and the lists follow it (migration
 * 20270113091000 says how). What a teacher reads is their own groups, and what
 * the administration reads is everything: row-level security gives each their
 * rows, and this service builds the same views from what it was allowed to read.
 */
@Injectable()
export class CrisisService {
  private readonly logger = new Logger(CrisisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async settings(user: AuthenticatedUser): Promise<CrisisSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.crisisSettings.findUnique({ where: { schoolId } });
      return { startProfiles: row?.startProfiles ?? [...DEFAULT_START_PROFILES], notifyGuardiansAfter: row?.notifyGuardiansAfter ?? false };
    });
  }

  /** Those who decide say who may start an alarm and whether the guardians are told afterwards. */
  async updateSettings(dto: UpdateCrisisSettingsDto, user: AuthenticatedUser): Promise<CrisisSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const data = { startProfiles: dto.startProfiles, notifyGuardiansAfter: dto.notifyGuardiansAfter };
      const row = await tx.crisisSettings.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
      return { startProfiles: row.startProfiles, notifyGuardiansAfter: row.notifyGuardiansAfter };
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * Starts an alarm: takes the snapshot of who stands before which group at
   * this moment, in one transaction with the alarm, and tells the staff after
   * it. A real alarm cuts an exercise that is going short.
   */
  async start(dto: StartAlarmDto, user: AuthenticatedUser): Promise<AlarmDetail> {
    const schoolId = requireSchoolId(user);
    const starterId = requireUserId(user);
    const started = await this.prisma.withRls(user, async (tx) => {
      const allowed = (await tx.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`SELECT app.crisis_may_start() AS allowed`))[0]?.allowed;
      if (!allowed) {
        throw new ForbiddenException({
          message: 'Din roll får inte starta larm. Rektor bestämmer vilka som får det, under Krisläge.',
          code: CRISIS_NOT_YOURS,
        });
      }
      // One start at a time in a school. The checks below read what has been committed, so two starts at once
      // (an exercise and a real alarm, two administrators) would each see the other's alarm as not there and both
      // begin; the second waits for the first here and then sees it. Held to the end of the transaction.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crisis-start:${schoolId}`}, 0))`);
      // One alarm of each mode at a time. Asked first, so the answer can name the alarm that is going: a
      // statement that fails in a transaction ends it, and the unique index below answers only a race.
      const going = await tx.crisisAlarm.findFirst({ where: { schoolId, mode: dto.mode, endedAt: null }, select: { id: true } });
      if (going) throw alarmOpen(dto.mode, going.id);
      // An exercise is not started in the middle of a real alarm (the staff would read "Övning pågår" beside it).
      if (dto.mode === 'DRILL') {
        const live = await tx.crisisAlarm.findFirst({ where: { schoolId, mode: 'LIVE', endedAt: null }, select: { id: true } });
        if (live) throw alarmOpen('LIVE', live.id, 'Ett skarpt larm pågår. En övning startas inte under ett skarpt larm.');
      }
      // The transaction's time is the alarm's start and the moment the lists are taken at.
      const at = (await tx.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT now() AS now`))[0]!.now;
      if (dto.mode === 'LIVE') {
        // The exercise's row is locked first: if somebody is ending it in this moment we wait for them, and it no
        // longer matches (it has ended), so there is nothing to cut. (A statement that fails ends the transaction,
        // so the refusal of a second end cannot be caught and gone on from.)
        const [exercise] = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT "id" FROM "CrisisAlarms" WHERE "schoolId" = ${schoolId}::uuid AND "mode" = 'DRILL' AND "endedAt" IS NULL FOR UPDATE`,
        );
        if (exercise) await tx.crisisAlarm.update({ where: { id: exercise.id }, data: { endedAt: at, endNote: CUT_SHORT_NOTE } });
      }

      const school = await tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } });
      const timezone = school?.timezone ?? 'Europe/Stockholm';
      const day = todayInZone(timezone, at);
      const snapshot = await this.snapshot(tx, schoolId, timezone, day, at);

      let alarm: AlarmRow;
      try {
        alarm = await tx.crisisAlarm.create({ data: { schoolId, kind: dto.kind, mode: dto.mode } });
      } catch (error) {
        // Another administrator started one in the same moment: the unique index answers the second.
        if (sqlStateOf(error) === '23505' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw alarmOpen(dto.mode, null);
        }
        // A real alarm began between our look and our insert (the trigger's KL412).
        if (sqlStateOf(error) === 'KL412') throw alarmOpen('LIVE', null, 'Ett skarpt larm pågår. En övning startas inte under ett skarpt larm.');
        throw error;
      }

      if (snapshot.calls.length > 0) {
        await tx.crisisCall.createMany({
          data: snapshot.calls.map((call) => ({
            id: call.id,
            schoolId,
            alarmId: alarm.id,
            calendarLessonId: call.lessonId,
            basis: call.basis,
            groupName: call.groupName,
            subjectName: call.subjectName,
            roomName: call.roomName,
            lessonStartsAt: call.lessonStartsAt,
            lessonEndsAt: call.lessonEndsAt,
          })),
        });
        const teacherRows = snapshot.calls.flatMap((call) =>
          call.teachers.map((teacher) => ({ schoolId, callId: call.id, teacherId: teacher.teacherId, role: teacher.role })),
        );
        if (teacherRows.length > 0) await tx.crisisCallTeacher.createMany({ data: teacherRows });
        await tx.crisisPupil.createMany({
          data: snapshot.calls.flatMap((call) =>
            call.pupilIds.map((studentId) => ({
              schoolId,
              alarmId: alarm.id,
              callId: call.id,
              studentId,
              priorAbsentSource: snapshot.prior.get(studentId) ?? null,
            })),
          ),
        });
      }

      // The lists are final: from here no administrator can add to them (the database stamps the time).
      alarm = await tx.crisisAlarm.update({ where: { id: alarm.id }, data: { listsSealedAt: at } });
      const staff = await tx.user.findMany({
        where: { schoolId, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, id: { not: starterId } },
        select: { id: true },
      });
      return { alarm, schoolId, recipientIds: staff.map((row) => row.id) };
    });

    // Told after the commit, in a transaction of its own: an alarm that failed to start told nobody.
    await this.tell(`Alarm notices [alarm=${started.alarm.id}]`, () =>
      this.prisma.withRls(user, async (tx) => {
        await sendAlarm(this.notifications, tx, {
          schoolId,
          alarmId: started.alarm.id,
          kind: started.alarm.kind,
          mode: started.alarm.mode,
          startedAt: started.alarm.startedAt,
          recipientIds: started.recipientIds,
        });
      }),
    );
    this.realtime.notifyCrisisChanged(schoolId, started.alarm.id, 'staff');
    this.logger.log(`Alarm started [alarm=${started.alarm.id}, kind=${started.alarm.kind}, mode=${started.alarm.mode}, staff=${started.recipientIds.length}]`);
    return this.detail(started.alarm.id, user);
  }

  /** The lists at `at`: the held lessons of the day, their pupils and teachers, and who was absent before. */
  private async snapshot(tx: PrismaClient, schoolId: string, timezone: string, day: Date, at: Date) {
    const dayString = day.toISOString().slice(0, 10);
    const lessons = await tx.calendarLesson.findMany({
      where: { schoolId, date: day, status: { in: ['SCHEDULED', 'COMPLETED'] } },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        startsAt: true,
        endsAt: true,
        subject: { select: { name: true } },
        studentGroup: { select: { name: true } },
        room: { select: { name: true } },
        extraGroups: { select: { studentGroupId: true, studentGroup: { select: { name: true } } } },
        teachers: { select: { teacherId: true, role: true } },
      },
    });
    const rosters = await calendarLessonRosters(
      tx,
      lessons.map((lesson): CalendarRosterLesson => ({
        id: lesson.id,
        subjectId: lesson.subjectId,
        studentGroupId: lesson.studentGroupId,
        extraGroups: lesson.extraGroups.map((group) => ({ studentGroupId: group.studentGroupId })),
      })),
      { pupils: 'ACTIVE' },
    );
    const absences = await tx.teacherAbsence.findMany({
      where: { schoolId, status: 'ACTIVE', startsAt: { lte: at }, endsAt: { gt: at } },
      select: { userId: true },
    });
    const dayLessons: DayLesson[] = lessons.map((lesson) => ({
      id: lesson.id,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      roster: rosters.get(lesson.id) ?? new Set<string>(),
      teachers: lesson.teachers,
    }));
    const calls = callsAt(at, dayLessons, new Set(absences.map((row) => row.userId)));
    const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    // Every active pupil of the school is on the roll call: the ones no lesson has are one more group, with no
    // teacher, that the administration answers for.
    const everyone = await tx.user.findMany({ where: { schoolId, role: 'STUDENT', isActive: true }, select: { id: true } });
    const unlisted = withoutList(
      everyone.map((row) => row.id),
      calls,
    );
    const pupilIds = [...new Set([...calls.flatMap((call) => call.pupilIds), ...unlisted])];
    const prior = await this.absentBefore(tx, schoolId, timezone, dayString, day, at, pupilIds);
    const lessonCalls = calls.map((call) => {
      const lesson = byId.get(call.lessonId)!;
      const groupNames = [lesson.studentGroup.name, ...lesson.extraGroups.map((group) => group.studentGroup.name)];
      return {
        id: randomUUID(),
        lessonId: call.lessonId as string | null,
        basis: call.basis as CallBasisView,
        groupName: groupNames.join(' + ').slice(0, 200),
        subjectName: lesson.subject.name.slice(0, 200),
        roomName: lesson.room?.name?.slice(0, 200) ?? null,
        lessonStartsAt: lesson.startsAt,
        lessonEndsAt: lesson.endsAt,
        teachers: call.teachers,
        pupilIds: call.pupilIds,
      };
    });
    const noLesson =
      unlisted.length === 0
        ? []
        : [
            {
              id: randomUUID(),
              lessonId: null as string | null,
              basis: 'NO_LESSON' as CallBasisView,
              groupName: NO_LESSON_GROUP,
              subjectName: NO_LESSON_SUBJECT,
              roomName: null as string | null,
              lessonStartsAt: at,
              lessonEndsAt: at,
              teachers: [] as { teacherId: string; role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE' }[],
              pupilIds: unlisted,
            },
          ];
    return { prior, calls: [...lessonCalls, ...noLesson] };
  }

  /** Who was absent before the alarm: the register of the day first, then a guardian's report or a leave. */
  private async absentBefore(
    tx: PrismaClient,
    schoolId: string,
    timezone: string,
    dayString: string,
    day: Date,
    at: Date,
    pupilIds: readonly string[],
  ): Promise<Map<string, PriorSourceView>> {
    if (pupilIds.length === 0) return new Map();
    const records = await tx.attendanceRecord.findMany({
      where: {
        studentId: { in: [...pupilIds] },
        status: { not: 'UNKNOWN' },
        calendarLesson: { schoolId, date: day, startsAt: { lte: at } },
      },
      select: { studentId: true, status: true, calendarLesson: { select: { startsAt: true } } },
    });
    const marks: StartedMark[] = records.map((record) => ({
      studentId: record.studentId,
      status: record.status as StartedMark['status'],
      lessonStartsAt: record.calendarLesson.startsAt,
    }));
    const wanted = new Set(pupilIds);
    const reported = await tx.$queryRaw<{ studentId: string; startTime: Date | null; endTime: Date | null }[]>(
      Prisma.sql`SELECT "studentId", "startTime", "endTime" FROM app.reported_absences(${dayString}::date)`,
    );
    const spans: ReportedSpan[] = reported
      .filter((row) => wanted.has(row.studentId))
      .map((row) => ({
        studentId: row.studentId,
        startsAt: row.startTime && row.endTime ? zonedTimeToUtc(dayString, toWallClock(row.startTime), timezone) : null,
        endsAt: row.startTime && row.endTime ? zonedTimeToUtc(dayString, toWallClock(row.endTime), timezone) : null,
      }));
    const leaves = await tx.leaveRequest.findMany({
      where: { schoolId, status: 'APPROVED', studentId: { in: [...pupilIds] }, startDate: { lte: day }, endDate: { gte: day } },
      select: { studentId: true },
    });
    for (const leave of leaves) spans.push({ studentId: leave.studentId, startsAt: null, endsAt: null });
    return priorAbsences(at, marks, spans);
  }

  // ---------------------------------------------------------------------------
  // End
  // ---------------------------------------------------------------------------

  /**
   * Ends an alarm, with a note if the administrator wrote one. After a real
   * alarm, and if the school chose to, the guardians of the pupils on the
   * lists are told that it happened and ended. Ending is once: an alarm that
   * has ended answers 409.
   */
  async end(alarmId: string, dto: EndAlarmDto, user: AuthenticatedUser): Promise<AlarmDetail> {
    const schoolId = requireSchoolId(user);
    const ended = await this.prisma.withRls(user, async (tx) => {
      const alarm = await tx.crisisAlarm.findFirst({ where: { id: alarmId, schoolId } });
      if (!alarm) throw notFound();
      if (alarm.endedAt) throw ended409();
      const settings = await tx.crisisSettings.findUnique({ where: { schoolId } });
      const tellGuardians = alarm.mode === 'LIVE' && (settings?.notifyGuardiansAfter ?? false);
      const pupils = tellGuardians ? await tx.crisisPupil.findMany({ where: { alarmId }, select: { studentId: true } }) : [];
      const guardianIds = tellGuardians ? await this.notifications.guardiansOf(tx, pupils.map((row) => row.studentId)) : [];
      let after: AlarmRow;
      try {
        after = await tx.crisisAlarm.update({
          where: { id: alarmId },
          data: {
            endedAt: new Date(),
            ...(dto.note ? { endNote: dto.note } : {}),
            ...(guardianIds.length > 0 ? { guardiansNotifiedAt: new Date() } : {}),
          },
        });
      } catch (error) {
        if (sqlStateOf(error) === 'KL409') throw ended409();
        throw error;
      }
      const staff = await tx.user.findMany({
        where: { schoolId, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
        select: { id: true },
      });
      return { alarm: after, recipientIds: staff.map((row) => row.id), guardianIds: [...new Set(guardianIds)] };
    });

    await this.tell(`Alarm end notices [alarm=${alarmId}]`, () =>
      this.prisma.withRls(user, async (tx) => {
        const facts = {
          schoolId,
          alarmId,
          kind: ended.alarm.kind,
          mode: ended.alarm.mode,
          startedAt: ended.alarm.startedAt,
          endedAt: ended.alarm.endedAt!,
        };
        await sendEnded(this.notifications, tx, { ...facts, recipientIds: ended.recipientIds });
        if (ended.guardianIds.length > 0) await sendGuardianAfter(this.notifications, tx, { ...facts, guardianIds: ended.guardianIds });
      }),
    );
    this.realtime.notifyCrisisChanged(schoolId, alarmId, 'staff');
    this.logger.log(`Alarm ended [alarm=${alarmId}, guardiansTold=${ended.guardianIds.length}]`);
    return this.detail(alarmId, user);
  }

  // ---------------------------------------------------------------------------
  // Reads: the administration
  // ---------------------------------------------------------------------------

  /** The protocol list: the school's alarms, newest first, each with its counts. */
  async list(query: AlarmListQueryDto, user: AuthenticatedUser): Promise<AlarmSummary[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const alarms = await tx.crisisAlarm.findMany({
        where: { schoolId, ...(query.mode ? { mode: query.mode } : {}) },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit ?? LIST_LIMIT,
      });
      if (alarms.length === 0) return [];
      const ids = alarms.map((alarm) => alarm.id);
      const names = await namesOf(tx, alarms.flatMap((alarm) => [alarm.startedByUserId, alarm.endedByUserId]));
      const counts = await tx.$queryRaw<
        { alarmId: string; pupils: bigint; unlisted: bigint; found: bigint; missing: bigint; away: bigint; absentBefore: bigint; unreported: bigint }[]
      >(Prisma.sql`
        SELECT p."alarmId",
               count(*) AS pupils,
               count(*) FILTER (WHERE c."basis" = 'NO_LESSON') AS unlisted,
               count(*) FILTER (WHERE p."state" = 'FOUND') AS found,
               count(*) FILTER (WHERE p."state" = 'MISSING') AS missing,
               count(*) FILTER (WHERE p."state" = 'AWAY') AS away,
               count(*) FILTER (WHERE p."state" IS NULL AND p."priorAbsentSource" IS NOT NULL) AS "absentBefore",
               count(*) FILTER (WHERE p."state" IS NULL AND p."priorAbsentSource" IS NULL) AS unreported
          FROM "CrisisPupils" p JOIN "CrisisCalls" c ON c."id" = p."callId"
         WHERE p."alarmId" = ANY (${ids}::uuid[])
         GROUP BY p."alarmId"`);
      const calls = await tx.$queryRaw<{ alarmId: string; calls: bigint; done: bigint }[]>(Prisma.sql`
        SELECT c."alarmId", count(*) AS calls,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "CrisisPupils" p
                                                   WHERE p."callId" = c."id" AND p."state" IS NULL AND p."priorAbsentSource" IS NULL)) AS done
          FROM "CrisisCalls" c
         WHERE c."alarmId" = ANY (${ids}::uuid[])
         GROUP BY c."alarmId"`);
      const teachers = await tx.$queryRaw<{ alarmId: string; teachers: bigint; answered: bigint }[]>(Prisma.sql`
        SELECT c."alarmId", count(t."teacherId") AS teachers, count(t."answeredAt") AS answered
          FROM "CrisisCalls" c JOIN "CrisisCallTeachers" t ON t."callId" = c."id"
         WHERE c."alarmId" = ANY (${ids}::uuid[])
         GROUP BY c."alarmId"`);
      const countsBy = new Map(counts.map((row) => [row.alarmId, row]));
      const callsBy = new Map(calls.map((row) => [row.alarmId, row]));
      const teachersBy = new Map(teachers.map((row) => [row.alarmId, row]));
      return alarms.map((alarm) => {
        const c = countsBy.get(alarm.id);
        const k = callsBy.get(alarm.id);
        const t = teachersBy.get(alarm.id);
        return {
          ...alarmView(alarm, names),
          unlisted: Number(c?.unlisted ?? 0),
          calls: Number(k?.calls ?? 0),
          callsComplete: Number(k?.done ?? 0),
          counts: {
            pupils: Number(c?.pupils ?? 0),
            found: Number(c?.found ?? 0),
            missing: Number(c?.missing ?? 0),
            away: Number(c?.away ?? 0),
            absentBefore: Number(c?.absentBefore ?? 0),
            unreported: Number(c?.unreported ?? 0),
          },
          teachers: Number(t?.teachers ?? 0),
          teachersAnswered: Number(t?.answered ?? 0),
        };
      });
    });
  }

  /** One alarm as the live view reads it: every group, teacher and pupil. */
  async detail(alarmId: string, user: AuthenticatedUser): Promise<AlarmDetail> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const built = await this.build(tx, alarmId, schoolId);
      await recordRead(tx, 'ROSTER', built.pupilIds, user.channel);
      await recordRead(tx, 'PEOPLE', built.pupilIds, user.channel);
      return built.detail;
    });
  }

  /** The protocol: the alarm as it stands and every mark that was made, in the order they were made. */
  async protocol(alarmId: string, user: AuthenticatedUser): Promise<ProtocolView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const built = await this.build(tx, alarmId, schoolId);
      const reports = await tx.crisisReport.findMany({
        where: { alarmId, schoolId },
        orderBy: [{ at: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
      });
      const names = await namesOf(tx, reports.map((report) => report.byUserId));
      const groupOf = new Map(built.detail.calls.map((call) => [call.id, { groupName: call.groupName, basis: call.basis }]));
      await recordRead(tx, 'ROSTER', built.pupilIds, user.channel);
      await recordRead(tx, 'PEOPLE', built.pupilIds, user.channel);
      return {
        ...built.detail,
        marks: reports.map((report) => ({
          at: report.at.toISOString(),
          receivedAt: report.receivedAt.toISOString(),
          studentId: report.studentId,
          groupName: groupOf.get(report.callId)?.groupName ?? '',
          foundIn: report.foundInCallId ? (groupOf.get(report.foundInCallId) ?? null) : null,
          state: report.state,
          by: nameOf(names, report.byUserId),
          onBehalf: report.onBehalf,
          late: report.late,
        })),
      };
    });
  }

  private async build(tx: PrismaClient, alarmId: string, schoolId: string): Promise<{ detail: AlarmDetail; pupilIds: string[] }> {
    const alarm = await tx.crisisAlarm.findFirst({ where: { id: alarmId, schoolId } });
    if (!alarm) throw notFound();
    const rows = await tx.crisisCall.findMany({
      where: { alarmId, schoolId },
      include: CALL_INCLUDE,
      orderBy: [{ lessonStartsAt: 'asc' }, { groupName: 'asc' }, { id: 'asc' }],
    });
    const names = await namesOf(tx, [
      alarm.startedByUserId,
      alarm.endedByUserId,
      ...rows.flatMap((call) => [
        ...call.teachers.map((teacher) => teacher.teacherId),
        ...call.pupils.flatMap((pupil) => [pupil.studentId, pupil.stateByUserId]),
      ]),
    ]);
    const calls = rows.map((call) => callView(call, names));
    return {
      detail: { alarm: summaryOf(alarm, names, calls), calls },
      pupilIds: rows.flatMap((call) => call.pupils.map((pupil) => pupil.studentId)),
    };
  }

  // ---------------------------------------------------------------------------
  // Reads: a teacher
  // ---------------------------------------------------------------------------

  /**
   * The alarms a teacher is to answer in and their groups: what the phone
   * shows and keeps for offline. Row-level security hands a teacher the
   * alarms that are open (or ended within the hour) and the calls they answer
   * for, so this reads without naming either.
   */
  async mine(user: AuthenticatedUser): Promise<MyCrisisResponse> {
    const schoolId = requireSchoolId(user);
    const me = requireUserId(user);
    return this.prisma.withRls(user, async (tx) => {
      const alarms = await tx.crisisAlarm.findMany({ where: { schoolId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
      const rows = alarms.length
        ? await tx.crisisCall.findMany({
            where: { schoolId, alarmId: { in: alarms.map((alarm) => alarm.id) } },
            include: CALL_INCLUDE,
            orderBy: [{ lessonStartsAt: 'asc' }, { groupName: 'asc' }, { id: 'asc' }],
          })
        : [];
      // The pupils this teacher (or a colleague on the call) found who are not on its list ("found with me"), and the
      // ones this teacher found with no group at all. A withdrawal takes a pupil off again, so each pupil is
      // followed through the marks in order.
      const callIds = new Set(rows.map((call) => call.id));
      const foundMarks = alarms.length
        ? await tx.crisisReport.findMany({
            where: {
              schoolId,
              state: { in: ['FOUND', 'RETRACTED'] },
              OR: [{ foundInCallId: { in: [...callIds] } }, { byUserId: me, foundInCallId: null, alarmId: { in: alarms.map((alarm) => alarm.id) } }],
            },
            orderBy: [{ at: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
            select: { alarmId: true, callId: true, foundInCallId: true, studentId: true, state: true, at: true, byUserId: true },
          })
        : [];
      const foundBy = new Map<string, Map<string, Date>>();
      const freeBy = new Map<string, Map<string, Date>>();
      const follow = (into: Map<string, Map<string, Date>>, key: string, mark: { studentId: string; state: string; at: Date }) => {
        const perKey = into.get(key) ?? new Map<string, Date>();
        if (mark.state === 'RETRACTED') perKey.delete(mark.studentId);
        else perKey.set(mark.studentId, mark.at);
        into.set(key, perKey);
      };
      for (const mark of foundMarks) {
        if (mark.foundInCallId && callIds.has(mark.foundInCallId)) follow(foundBy, mark.foundInCallId, mark);
        // With no group: this teacher's own, and not a pupil on one of their own lists (that is an ordinary mark).
        else if (!mark.foundInCallId && mark.byUserId === me && !callIds.has(mark.callId)) follow(freeBy, mark.alarmId, mark);
      }
      const foundIds = [...new Set([...foundBy.values(), ...freeBy.values()].flatMap((perKey) => [...perKey.keys()]))];
      const found = foundIds.length
        ? await tx.user.findMany({
            where: { schoolId, id: { in: foundIds } },
            select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } },
          })
        : [];
      const pupilById = new Map(found.map((row) => [row.id, row]));
      const foundViews = (perKey: Map<string, Date> | undefined): FoundHereView[] =>
        [...(perKey ?? new Map<string, Date>())]
          .map(([studentId, markedAt]) => {
            const person = pupilById.get(studentId);
            return {
              studentId,
              firstName: person?.firstName ?? '',
              lastName: person?.lastName ?? '',
              className: person?.studentGroup?.name ?? null,
              markedAt: markedAt.toISOString(),
            } satisfies FoundHereView;
          })
          .sort(byName);
      const names = await namesOf(tx, [
        ...alarms.flatMap((alarm) => [alarm.startedByUserId, alarm.endedByUserId]),
        ...rows.flatMap((call) => [...call.teachers.map((teacher) => teacher.teacherId), ...call.pupils.map((pupil) => pupil.studentId)]),
      ]);
      const mineOf = (call: CallRow): MyCall => {
        const pupils = pupilViews(call, names, false);
        return {
          id: call.id,
          lessonId: call.calendarLessonId,
          basis: call.basis,
          groupName: call.groupName,
          subjectName: call.subjectName,
          roomName: call.roomName,
          lessonStartsAt: call.lessonStartsAt.toISOString(),
          lessonEndsAt: call.lessonEndsAt.toISOString(),
          completedAt: completedAtOf(call),
          colleagues: call.teachers
            .filter((teacher) => teacher.teacherId !== me)
            .map((teacher) => nameOf(names, teacher.teacherId))
            .filter((name): name is string => name !== null),
          counts: countPupils(pupils.map((pupil) => pupil.status)),
          pupils,
          foundHere: foundViews(foundBy.get(call.id)),
        };
      };
      const result: MyAlarm[] = alarms.map((alarm) => ({
        ...alarmView(alarm, names),
        calls: rows.filter((call) => call.alarmId === alarm.id).map(mineOf),
        foundFree: foundViews(freeBy.get(alarm.id)),
      }));
      return { asOf: new Date().toISOString(), alarms: result };
    });
  }

  /**
   * The pupils of the school, not on the teacher's own lists, whose name or class matches every word of `q`
   * (at most 25): who a teacher picks from to say "found with me". A search and not a list: a thousand names would
   * be sent to every phone at every read, and kept there. Staff read the school's pupils directly already, so this
   * reaches no further than that; it is recorded as the read of people it is.
   */
  async searchPupils(alarmId: string, q: string, user: AuthenticatedUser): Promise<OtherPupilView[]> {
    const schoolId = requireSchoolId(user);
    const words = q.split(/\s+/).filter((word) => word.length > 0).slice(0, 4);
    return this.prisma.withRls(user, async (tx) => {
      // The alarm must be one this teacher may read (the window), and the lists they answer for are left out.
      const alarm = await tx.crisisAlarm.findFirst({ where: { id: alarmId, schoolId }, select: { id: true } });
      if (!alarm) throw notFound();
      const mine = await tx.crisisPupil.findMany({ where: { alarmId }, select: { studentId: true } });
      const rows = await tx.user.findMany({
        where: {
          schoolId,
          role: 'STUDENT',
          isActive: true,
          id: { notIn: mine.map((row) => row.studentId) },
          AND: words.map((word) => ({
            OR: [
              { firstName: { contains: word, mode: 'insensitive' as const } },
              { lastName: { contains: word, mode: 'insensitive' as const } },
              { studentGroup: { name: { contains: word, mode: 'insensitive' as const } } },
            ],
          })),
        },
        select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        take: 25,
      });
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.id), user.channel);
      return rows.map((row) => ({ studentId: row.id, firstName: row.firstName, lastName: row.lastName, className: row.studentGroup?.name ?? null }));
    });
  }

  // ---------------------------------------------------------------------------
  // Marks
  // ---------------------------------------------------------------------------

  /** A teacher's marks, sent when they were made or when the phone got a signal. */
  async markMine(marks: readonly MarkDto[], user: AuthenticatedUser): Promise<{ stored: number; duplicates: number; unresolved: string[] }> {
    return this.mark(marks, user, null);
  }

  /** The administration marks a group nobody answers for, or a pupil a teacher cannot reach. */
  async markAsAdministration(alarmId: string, marks: readonly MarkDto[], user: AuthenticatedUser) {
    return this.mark(marks, user, alarmId);
  }

  private async mark(
    marks: readonly MarkDto[],
    user: AuthenticatedUser,
    onlyAlarmId: string | null,
  ): Promise<{ stored: number; duplicates: number; unresolved: string[] }> {
    const schoolId = requireSchoolId(user);
    for (const mark of marks) {
      if ([mark.callId, mark.lessonId, mark.alarmId].filter((named) => named !== undefined).length !== 1) {
        throw new BadRequestException({
          message: 'En markering anger gruppen med callId eller lessonId, eller larmet med alarmId: ett av dem, inte flera och inte inget.',
          code: CRISIS_MARK_INVALID,
        });
      }
      // What each side may say. The database holds the same line (the teacher's arms), this is the answer in words.
      if (onlyAlarmId === null && mark.state === 'AWAY') {
        throw notOnTheList('Bara ledningen kan markera en elev som inte i huset.');
      }
      if (onlyAlarmId !== null && mark.state === 'RETRACTED') {
        throw notOnTheList('Ledningen markerar om en elev; att ta tillbaka en egen hittad-markering är lärarens.');
      }
    }
    let alarmsTouched: string[] = [];
    const result = await this.prisma
      .withRls(user, async (tx) => {
        const callIds = [...new Set(marks.flatMap((mark) => (mark.callId ? [mark.callId] : [])))];
        const lessonIds = [...new Set(marks.flatMap((mark) => (mark.lessonId ? [mark.lessonId] : [])))];
        const alarmIds = [...new Set(marks.flatMap((mark) => (mark.alarmId ? [mark.alarmId] : [])))];
        const known = await tx.crisisCall.findMany({
          where: {
            schoolId,
            ...(onlyAlarmId ? { alarmId: onlyAlarmId } : {}),
            OR: [...(callIds.length ? [{ id: { in: callIds } }] : []), ...(lessonIds.length ? [{ calendarLessonId: { in: lessonIds } }] : [])],
          },
          select: { id: true, alarmId: true, calendarLessonId: true, alarm: { select: { startedAt: true } } },
        });
        const knownAlarms = alarmIds.length
          ? await tx.crisisAlarm.findMany({ where: { schoolId, id: { in: onlyAlarmId ? alarmIds.filter((id) => id === onlyAlarmId) : alarmIds } }, select: { id: true } })
          : [];
        const alarmKnown = new Set(knownAlarms.map((alarm) => alarm.id));
        const byId = new Map(known.map((call) => [call.id, call]));
        const byLesson = new Map<string, typeof known>();
        for (const call of known) {
          if (!call.calendarLessonId) continue;
          byLesson.set(call.calendarLessonId, [...(byLesson.get(call.calendarLessonId) ?? []), call]);
        }
        const resolved: { mark: MarkDto; call: (typeof known)[number]; at: Date }[] = [];
        // A mark with no group to find the pupil with: a teacher with no group right now says they found one.
        const free: { mark: MarkDto; alarmId: string; at: Date }[] = [];
        const unresolved: string[] = [];
        for (const mark of marks) {
          const at = new Date(mark.at);
          if (mark.alarmId) {
            if (alarmKnown.has(mark.alarmId)) free.push({ mark, alarmId: mark.alarmId, at });
            else unresolved.push(mark.id);
            continue;
          }
          const call = mark.callId
            ? byId.get(mark.callId)
            : // The alarm that was going when the mark was made: the latest that had started by then, give or
              // take the minutes a phone's clock can be wrong (the database holds the time at the start).
              (byLesson.get(mark.lessonId!) ?? [])
                .filter((candidate) => candidate.alarm.startedAt.getTime() <= at.getTime() + PHONE_CLOCK_SKEW_MS)
                .sort((a, b) => b.alarm.startedAt.getTime() - a.alarm.startedAt.getTime())[0];
          if (!call) {
            unresolved.push(mark.id);
            continue;
          }
          resolved.push({ mark, call, at });
        }

        // A pupil who is not on the list of the call the mark is made with can be said to be found with it ("found
        // with me"): the mark is then on the pupil's own call, with the finder's call beside it. Only found, or the
        // withdrawal of it: nobody can say a pupil of someone else's list is missing, or not in the building.
        const listed = new Set<string>();
        if (resolved.length > 0) {
          const onLists = await tx.crisisPupil.findMany({
            where: { callId: { in: [...new Set(resolved.map((r) => r.call.id))] }, studentId: { in: [...new Set(resolved.map((r) => r.mark.studentId))] } },
            select: { callId: true, studentId: true },
          });
          for (const row of onLists) listed.add(`${row.callId}:${row.studentId}`);
        }
        const elsewhere = resolved.filter((r) => !listed.has(`${r.call.id}:${r.mark.studentId}`));
        const findings: ('FOUND' | 'RETRACTED')[] = ['FOUND', 'RETRACTED'];
        if (elsewhere.some((r) => !findings.includes(r.mark.state as 'FOUND' | 'RETRACTED'))) throw notOnTheList();
        // Only a found mark can be said with no group, by a teacher; the administration can say anything of any pupil.
        if (onlyAlarmId === null && free.some((f) => !findings.includes(f.mark.state as 'FOUND' | 'RETRACTED'))) throw notOnTheList('Utan grupp kan du bara säga att du hittat en elev.');
        const ownCall = new Map<string, string | null>();
        const lookups = [...elsewhere.map((r) => ({ alarmId: r.call.alarmId, studentId: r.mark.studentId })), ...free.map((f) => ({ alarmId: f.alarmId, studentId: f.mark.studentId }))];
        if (lookups.length > 0) {
          const looked = await tx.$queryRaw<{ alarmId: string; studentId: string; callId: string | null }[]>(Prisma.sql`
            SELECT t.alarm AS "alarmId", t.student AS "studentId", app.crisis_pupil_call(t.alarm, t.student) AS "callId"
              FROM unnest(${lookups.map((l) => l.alarmId)}::uuid[], ${lookups.map((l) => l.studentId)}::uuid[]) AS t(alarm, student)`);
          for (const row of looked) ownCall.set(`${row.alarmId}:${row.studentId}`, row.callId);
        }
        const rows: Prisma.CrisisReportCreateManyInput[] = [];
        for (const { mark, call, at } of resolved) {
          const base = { id: mark.id, schoolId, alarmId: call.alarmId, studentId: mark.studentId, state: mark.state, at };
          if (listed.has(`${call.id}:${mark.studentId}`)) {
            rows.push({ ...base, callId: call.id });
            continue;
          }
          const own = ownCall.get(`${call.alarmId}:${mark.studentId}`);
          if (!own) throw notOnTheList('Eleven finns inte i larmet.');
          rows.push({ ...base, callId: own, foundInCallId: call.id });
        }
        for (const { mark, alarmId, at } of free) {
          const own = ownCall.get(`${alarmId}:${mark.studentId}`);
          if (!own) throw notOnTheList('Eleven finns inte i larmet.');
          rows.push({ id: mark.id, schoolId, alarmId, studentId: mark.studentId, state: mark.state, at, callId: own });
        }
        // Every batch takes its pupils in the same order, so two phones that send the same group at once, each in
        // the order it marked them in, wait for each other instead of deadlocking.
        rows.sort(
          (a, b) =>
            (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0) ||
            (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0) ||
            (a.at as Date).getTime() - (b.at as Date).getTime() ||
            (a.id! < b.id! ? -1 : 1),
        );
        let stored = 0;
        if (rows.length > 0) {
          const created = await tx.crisisReport.createMany({ data: rows, skipDuplicates: true });
          stored = created.count;
        }
        return { stored, duplicates: rows.length - stored, unresolved, alarmIds: [...new Set(rows.map((row) => row.alarmId))] };
      })
      .catch((error: unknown) => {
        throw mapMarkError(error);
      });
    alarmsTouched = result.alarmIds;
    for (const alarmId of alarmsTouched) this.realtime.notifyCrisisChanged(schoolId, alarmId, 'admin');
    return { stored: result.stored, duplicates: result.duplicates, unresolved: result.unresolved };
  }

  // ---------------------------------------------------------------------------
  // The job
  // ---------------------------------------------------------------------------

  /** Ends the alarms that have stood open longer than one can. Called by the job runner, with no login. */
  async settle(): Promise<number> {
    return this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT app.crisis_settle() AS n`).then((rows) => Number(rows[0]?.n ?? 0)),
    );
  }

  private async tell(label: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(`${label} not sent [${error instanceof Error ? error.name : 'unknown'}]`);
    }
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({ message: 'Larmet finns inte.', code: CRISIS_ALARM_NOT_FOUND });
}

/** The alarm that is going is in `params`, the one member of a coded refusal the global filter lets through. */
function alarmOpen(mode: 'LIVE' | 'DRILL', alarmId: string | null, message?: string): ConflictException {
  return new ConflictException({
    message: message ?? (mode === 'LIVE' ? 'Ett skarpt larm pågår redan.' : 'En övning pågår redan.'),
    code: CRISIS_ALARM_OPEN,
    ...(alarmId ? { params: { alarmId } } : {}),
  });
}

function notOnTheList(message = 'Eleven står inte på gruppens lista, och en elev som inte står där kan bara sägas vara funnen.'): BadRequestException {
  return new BadRequestException({ message, code: CRISIS_MARK_INVALID });
}

function ended409(): ConflictException {
  return new ConflictException({ message: 'Larmet är redan avslutat.', code: CRISIS_ALARM_ENDED });
}

/** The database's refusals on a mark, as coded answers. */
function mapMarkError(error: unknown): unknown {
  if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException) return error;
  // A deadlock or a serialization failure is a 409 that says to send again: nothing was stored.
  if (isWriteConflict(error)) return writeConflict();
  switch (sqlStateOf(error)) {
    case 'KL404':
      return new NotFoundException({ message: 'Larmet finns inte.', code: CRISIS_ALARM_NOT_FOUND });
    case 'KL410':
      return new ConflictException({ message: 'Larmet avslutades för mer än en timme sedan och tar inte emot fler markeringar.', code: CRISIS_ALARM_ENDED });
    case '23503':
      return new BadRequestException({ message: 'Eleven står inte på gruppens lista.', code: CRISIS_MARK_INVALID });
    case 'KL413':
      return notOnTheList('Du har ingen markering av eleven som funnen att ta tillbaka, eller en senare markering har ersatt den.');
    case '42501':
      return new ForbiddenException({ message: 'Du svarar inte för den gruppen, eller larmet är över.', code: CRISIS_NOT_YOURS });
    default:
      return error;
  }
}

