/**
 * Möjliga tider (E3): THE QUERY AGAINST THE JUDGE, over the worlds the judge's fall file does not carry.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-mojliga-tider-regler.ts [scenario...]
 *
 * probe-mojliga-tider.ts holds the query to the judge over the fall file, whose worlds have no date window, no jullov, no shared room, no
 * loan of a room, no pupil named on a lesson and no ombyte. Those are the rules where the prune (swap-context.ts inTheWay) and the judge
 * (findConflicts) are two readings of one rule, and where the prune can be stricter than the judge (a start the judge lets through called
 * in the way) or name no one. Every start of the week of every lesson asked about is put to the judge, and the query must agree:
 *
 *   - a start the judge lets through is FREE (never IN_THE_WAY, CROWDED, CHANGE or CLOSED);
 *   - a start the query calls FREE the judge lets through (the service asks it; refused is counted and must be what the judge says);
 *   - a start called CLOSED is refused for the very rule it names;
 *   - a start called IN_THE_WAY or CROWDED is refused for a clash, never for a rule only (OTHER_SCHOOL, AVAILABILITY of a room, ...) that
 *     the query could name: a room lent to another school, or closed by a weekly row, with no other room to turn to, is CLOSED.
 *
 * It works in schools of its own (slug `probe-mojliga-regler-<scenario>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { ConflictReads } from '../../src/calendar/conflict-reads';
import { judgeLessons, type JudgeItem } from '../../src/calendar/lesson-judge';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PossibleTimesService, type PossibleTimes } from '../../src/calendar/possible-times.service';
import { PrismaService } from '../../src/database/prisma.service';
import { readSwapData } from '../../src/swaps/swap-snapshot';
import { CURRENT } from '../../src/year-rollover/projected-rosters';

const STEP = Number(process.env['MOJLIGA_REGLER_STEP'] ?? 10);
const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

export interface LessonSpec {
  key: string;
  cls: string;
  subject: string;
  teacher: string;
  co?: string;
  room?: string;
  day: number;
  start: string;
  minutes: number;
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  startDate?: string;
  endDate?: string;
  extra?: string[];
  /** pupils (by index in the class they name) named on the lesson, as 'cls:index' */
  pupils?: string[];
  parked?: boolean;
  exemptFrom?: string[];
  locked?: boolean;
}
export interface WorldSpec {
  classes: Array<{ key: string; grade: number; pupils: number }>;
  teachers: string[];
  rooms: Array<{ key: string; capacity?: number; shared?: boolean }>;
  subjects: string[];
  lessons: LessonSpec[];
  unavailable?: Array<{ kind: 'teacher' | 'room' | 'class'; key: string; day: number; start: string; end: string }>;
  frames?: Array<{ grades: [number, number]; start: string; end: string }>;
  meals?: Array<{ class: string; day: number; start: string; end: string }>;
  breaks?: Array<{ start: string; end: string }>;
  sharedMode?: 'SOFT' | 'HARD';
  /** ombyte/dusch before and after a post's lessons (TeachingRequirements) */
  buffers?: Array<{ cls: string; subject: string; before: number; after: number }>;
  /** a second school of the same huvudman, lending a room of the first (Day/clock) */
  loans?: Array<{ room: string; day: number; start: string; end: string }>;
}
export interface PlantedWorld {
  school: string;
  year: string;
  caller: AuthenticatedUser;
  lessonId: Map<string, string>;
  classId: Map<string, string>;
  teacherId: Map<string, string>;
  roomId: Map<string, string>;
  subjectId: Map<string, string>;
  pupilId: Map<string, string>;
}

export async function plantWorld(owner: Client, slug: string, world: WorldSpec): Promise<PlantedWorld> {
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [slug, `${slug}-andra`]);
  const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`, [slug])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'regler', '2026-08-15', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
      [school],
    )
  ).id;
  const person = async (label: string, role: string, extra: { adminProfile?: string; studentGroupId?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "studentGroupId", "updatedAt") VALUES ($1, $2, $3, 'Regler', $4, $5, true, $6, $7, now()) RETURNING id`,
      [school, `${slug}-${label}@example.invalid`, label, role, authId, extra.adminProfile ?? null, extra.studentGroupId ?? null],
    );
    return { id: row.id, authId };
  };
  const classId = new Map<string, string>();
  const pupilId = new Map<string, string>();
  for (const entry of world.classes) {
    const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [school, year, entry.key, entry.grade])).id;
    classId.set(entry.key, id);
    for (let index = 0; index < entry.pupils; index++) pupilId.set(`${entry.key}:${index}`, (await person(`${entry.key}-p${index}`, 'STUDENT', { studentGroupId: id })).id);
  }
  const teacherId = new Map<string, string>();
  for (const key of world.teachers) teacherId.set(key, (await person(key, 'TEACHER')).id);
  const roomId = new Map<string, string>();
  for (const room of world.rooms) {
    roomId.set(
      room.key,
      (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "canBeShared", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [school, room.key, room.capacity ?? null, room.shared ?? false])).id,
    );
  }
  const subjectId = new Map<string, string>();
  for (const key of world.subjects) subjectId.set(key, (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, key])).id);
  const admin = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
  const caller = { authId: admin.authId, userId: admin.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as unknown as AuthenticatedUser;

  const lessonId = new Map<string, string>();
  for (const lesson of world.lessons) {
    const end = clockOf(minutesOf(lesson.start) + lesson.minutes);
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "startDate", "endDate", "isParked", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12::"LessonRecurrence", $13, $14, $15, now()) RETURNING id`,
        [
          school, year, subjectId.get(lesson.subject), classId.get(lesson.cls), teacherId.get(lesson.teacher), lesson.co ? teacherId.get(lesson.co) : null, lesson.room ? roomId.get(lesson.room) : null,
          lesson.day, lesson.start, end, lesson.locked ?? false, lesson.recurrence ?? 'ALL_WEEKS', lesson.startDate ?? null, lesson.endDate ?? null, lesson.parked ?? false,
        ],
      )
    ).id;
    lessonId.set(lesson.key, id);
    for (const extra of lesson.extra ?? []) await owner.query(`INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [school, id, classId.get(extra)]);
    for (const pupil of lesson.pupils ?? []) await owner.query(`INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES ($1, $2, $3)`, [school, id, pupilId.get(pupil)]);
    if (lesson.exemptFrom?.length) await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = $2::text[] WHERE id = $1`, [id, lesson.exemptFrom]);
  }
  for (const rule of world.unavailable ?? []) {
    const resource = { teacher: 'TEACHER', room: 'ROOM', class: 'STUDENT_GROUP' }[rule.kind];
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "roomId", "studentGroupId", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
       VALUES ($1, $2::"ConstraintResource", $3, $4, $5, $6, $7, $8, 'UNAVAILABLE', now())`,
      [school, resource, rule.kind === 'teacher' ? teacherId.get(rule.key) : null, rule.kind === 'room' ? roomId.get(rule.key) : null, rule.kind === 'class' ? classId.get(rule.key) : null, rule.day, rule.start, rule.end],
    );
  }
  for (const frame of world.frames ?? []) {
    await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, NULL, $4, $5, now())`, [school, frame.grades[0], frame.grades[1], frame.start, frame.end]);
  }
  for (const meal of world.meals ?? []) {
    await owner.query(
      `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, false, now())`,
      [school, year, classId.get(meal.class), meal.day, meal.start, meal.end],
    );
  }
  for (const spell of world.breaks ?? []) {
    await owner.query(`INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Lov', 'HOLIDAY', $3, $4, now())`, [school, year, spell.start, spell.end]);
  }
  for (const buffer of world.buffers ?? []) {
    await owner.query(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "minutesBefore", "minutesAfter", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [school, year, subjectId.get(buffer.subject), classId.get(buffer.cls), buffer.before, buffer.after],
    );
  }
  if (world.sharedMode) {
    await owner.query(
      `INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "placementSharedMode", "updatedAt") VALUES ($1, false, '11:00', '13:00', 30, $2::"PlacementRuleMode", now())
       ON CONFLICT ("schoolId") DO UPDATE SET "placementSharedMode" = EXCLUDED."placementSharedMode"`,
      [school, world.sharedMode],
    );
  }
  if (world.loans?.length) {
    const other = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`Andra ${slug}`, `${slug}-andra`])).id;
    for (const loan of world.loans) {
      await owner.query(
        `INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate", status, "decidedAt", "localRoomId", "localRoomName", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, '2026-08-15', '2027-06-11', 'APPROVED', now(), $7, 'Lånad', now())`,
        [school, roomId.get(loan.room), other, loan.day, loan.start, loan.end, (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [other, `Lånad ${randomUUID().slice(0, 6)}`])).id],
      );
    }
  }
  return { school, year, caller, lessonId, classId, teacherId, roomId, subjectId, pupilId };
}

export interface Disagreement {
  kind: string;
  day: number;
  start: number;
  detail: string;
}

/** The query against the judge for ONE lesson (or a brick), every start of the week at STEP. */
export async function compareOne(
  api: PrismaService,
  masters: MasterLessonsService,
  possible: PossibleTimesService,
  planted: PlantedWorld,
  body: { lessonId?: string; brick?: Record<string, unknown> },
  minutes: number,
  label: string,
): Promise<{ answer: PossibleTimes; disagreements: Disagreement[]; tally: Record<string, number> }> {
  const { caller } = planted;
  const answer = await possible.possibleTimes({ ...(body as object), from: '07:00', to: '18:00', stepMinutes: STEP, limit: 40 } as never, caller);
  const starts: Array<{ day: number; start: number }> = [];
  for (const day of [1, 2, 3, 4, 5]) for (let start = 7 * 60; start + minutes <= 18 * 60; start += STEP) starts.push({ day, start });

  const verdicts = await api.withRls(caller, async (tx) => {
    const data = await readSwapData(tx, caller, planted.year);
    let lesson: JudgeItem['lesson'];
    let candidateBase: JudgeItem['candidate'];
    let stands: JudgeItem['stands'] = null;
    let exclude: string[] = [];
    if (body.lessonId) {
      const own = data.lessons.find((entry) => entry.id === body.lessonId) ?? (await tx.masterLesson.findUnique({ where: { id: body.lessonId }, include: { extraGroups: true, participants: true } }).then((row) => row && ({ id: row.id, studentGroupId: row.studentGroupId, subjectId: row.subjectId, teacherId: row.teacherId, coTeacherId: row.coTeacherId, roomId: row.roomId, extraGroupIds: row.extraGroups.map((e) => e.studentGroupId), studentIds: row.participants.map((e) => e.studentId), recurrence: row.recurrence, startDate: row.startDate?.toISOString().slice(0, 10) ?? null, endDate: row.endDate?.toISOString().slice(0, 10) ?? null, dayOfWeek: row.dayOfWeek, startMinutes: 0, endMinutes: 0 } as never)))!;
      const parked = !data.lessons.some((entry) => entry.id === body.lessonId);
      lesson = { id: own.id, studentGroupId: own.studentGroupId, subjectId: own.subjectId };
      candidateBase = {
        dayOfWeek: 1, startMinutes: 0, endMinutes: 0, teacherId: own.teacherId, coTeacherId: own.coTeacherId, roomId: own.roomId, extraGroupIds: own.extraGroupIds, studentIds: own.studentIds,
        recurrence: own.recurrence, startDate: own.startDate ? new Date(`${own.startDate}T00:00:00.000Z`) : null, endDate: own.endDate ? new Date(`${own.endDate}T00:00:00.000Z`) : null,
      };
      if (!parked) {
        stands = { dayOfWeek: own.dayOfWeek, startMinutes: own.startMinutes, endMinutes: own.endMinutes, teacherId: own.teacherId, coTeacherId: own.coTeacherId, roomId: own.roomId, extraGroupIds: own.extraGroupIds, recurrence: own.recurrence, startDate: candidateBase.startDate ?? null, endDate: candidateBase.endDate ?? null };
      }
      exclude = [own.id];
    } else {
      const brick = body.brick as { studentGroupId: string; subjectId: string; teacherId?: string; coTeacherId?: string; roomId?: string; extraGroupIds?: string[]; studentIds?: string[]; recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS'; startDate?: string; endDate?: string };
      lesson = { id: null, studentGroupId: brick.studentGroupId, subjectId: brick.subjectId };
      candidateBase = {
        dayOfWeek: 1, startMinutes: 0, endMinutes: 0, teacherId: brick.teacherId ?? null, coTeacherId: brick.coTeacherId ?? null, roomId: brick.roomId ?? null, extraGroupIds: brick.extraGroupIds ?? [], studentIds: brick.studentIds ?? [],
        recurrence: brick.recurrence ?? 'ALL_WEEKS', startDate: brick.startDate ? new Date(`${brick.startDate}T00:00:00.000Z`) : null, endDate: brick.endDate ? new Date(`${brick.endDate}T00:00:00.000Z`) : null,
      };
    }
    const items: JudgeItem[] = starts.map(({ day, start }) => ({ lesson, candidate: { ...candidateBase, dayOfWeek: day, startMinutes: start, endMinutes: start + minutes }, stands, excludeIds: exclude }));
    const judged = await judgeLessons(tx, masters, { academicYearId: planted.year, schoolId: planted.school, basis: CURRENT, gradeNumbering: 'NIOARIG' }, items, { reads: new ConflictReads() });
    return new Map(starts.map(({ day, start }, at) => [`${day}|${start}`, judged[at]!]));
  });

  const disagreements: Disagreement[] = [];
  const tally: Record<string, number> = {};
  const bump = (name: string) => (tally[name] = (tally[name] ?? 0) + 1);
  for (const { day, start } of starts) {
    const verdict = verdicts.get(`${day}|${start}`)!;
    const run = answer.days.find((entry) => entry.dayOfWeek === day)!.runs.find((candidate) => candidate.fromMinutes <= start && start <= candidate.toMinutes);
    const reasons = verdict.refusals.map((refusal) => refusal.reason);
    const at = `${label} d${day} ${clockOf(start)}`;
    if (!run) {
      disagreements.push({ kind: 'NO_RUN', day, start, detail: `${at}: not painted (judge ${verdict.ok ? 'ok' : reasons.join(',')})` });
      bump('NO_RUN');
      continue;
    }
    bump(`${run.kind}${run.code ? `:${run.code}` : ''}`);
    if (run.kind === 'STANDS') continue;
    if (verdict.ok && run.kind !== 'FREE') {
      disagreements.push({ kind: 'LOST', day, start, detail: `${at}: the judge lets it through, the query says ${run.kind}${run.code ? ' ' + run.code : ''}` });
      bump('LOST');
    }
    if ((run.kind === 'FREE') && !verdict.ok) {
      disagreements.push({ kind: 'UNSOUND', day, start, detail: `${at}: FREE but the judge says ${reasons.join(',')}` });
      bump('UNSOUND');
    }
    if (run.kind === 'CHANGE' && verdict.ok) {
      disagreements.push({ kind: 'CHANGE_BUT_OWN_ROOM_OK', day, start, detail: `${at}: CHANGE although the own room is fine` });
      bump('CHANGE_BUT_OWN_ROOM_OK');
    }
    if (run.kind === 'CLOSED' && !reasons.includes(run.code!)) {
      disagreements.push({ kind: 'WRONG_RULE', day, start, detail: `${at}: CLOSED ${run.code}, the judge says ${verdict.ok ? 'ok' : reasons.join(',')}` });
      bump('WRONG_RULE');
    }
    if ((run.kind === 'IN_THE_WAY' || run.kind === 'CROWDED') && !verdict.ok && !reasons.some((reason) => ['TEACHER', 'ROOM', 'GROUP', 'PUPILS', 'AVAILABILITY'].includes(reason))) {
      disagreements.push({ kind: 'BLOCK_WITHOUT_CLASH', day, start, detail: `${at}: ${run.kind}, the judge says ${reasons.join(',')}` });
      bump('BLOCK_WITHOUT_CLASH');
    }
    if (run.kind === 'CROWDED' && run.units === 0) {
      bump('CROWDED_ZERO');
      // what the judge calls it: remember the reason combination for the report
      bump(`CROWDED_ZERO_judge:${verdict.ok ? 'ok' : reasons.join('+')}`);
    }
  }
  if (answer.stats.refused > 0) bump(`refused_by_judge=${answer.stats.refused}`);
  return { answer, disagreements, tally };
}

// ---------------------------------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------------------------------

const base = (): WorldSpec => ({
  classes: [
    { key: '7A', grade: 7, pupils: 3 },
    { key: '7B', grade: 7, pupils: 3 },
  ],
  teachers: ['T1', 'T2', 'T3'],
  rooms: [{ key: 'R1' }, { key: 'R2' }, { key: 'R3' }],
  subjects: ['Ma', 'Sv', 'En'],
  lessons: [],
});

export const SCENARIOS: Record<string, { world: () => WorldSpec; ask: Array<{ key?: string; brick?: Record<string, unknown>; minutes?: number }> }> = {
  // The jullov: an autumn lesson to Jan 1 and a spring one from Dec 28 meet only in two closed weeks.
  jullov: {
    world: () => ({
      ...base(),
      breaks: [{ start: '2026-12-21', end: '2027-01-03' }],
      lessons: [
        { key: 'AUT', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60, endDate: '2027-01-01' },
        { key: 'SPR', cls: '7B', subject: 'Sv', teacher: 'T1', room: 'R2', day: 3, start: '09:00', minutes: 60, startDate: '2026-12-28' },
        { key: 'SPR2', cls: '7A', subject: 'En', teacher: 'T2', room: 'R3', day: 4, start: '13:00', minutes: 60, startDate: '2026-12-28' },
      ],
    }),
    ask: [{ key: 'SPR' }, { key: 'SPR2' }],
  },
  // Shared room: R1 holds 60, two lessons of 3 pupils each fit.
  sharedroom: {
    world: () => ({
      ...base(),
      rooms: [{ key: 'R1', capacity: 60, shared: true }, { key: 'R2' }, { key: 'R3' }],
      sharedMode: 'SOFT',
      lessons: [
        { key: 'A', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60 },
        { key: 'B', cls: '7B', subject: 'Sv', teacher: 'T2', room: 'R1', day: 3, start: '13:00', minutes: 60 },
      ],
    }),
    ask: [{ key: 'B' }],
  },
  // Named pupils: P names a 7B pupil; 7B has a lesson Q.
  participants: {
    world: () => ({
      ...base(),
      lessons: [
        { key: 'P', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60, pupils: ['7B:0'] },
        { key: 'Q', cls: '7B', subject: 'Sv', teacher: 'T2', room: 'R2', day: 3, start: '10:00', minutes: 60 },
        { key: 'S', cls: '7B', subject: 'En', teacher: 'T3', room: 'R3', day: 4, start: '10:00', minutes: 60 },
        { key: 'X', cls: '7A', subject: 'En', teacher: 'T3', room: 'R3', day: 1, start: '13:00', minutes: 60, pupils: ['7B:1'] },
      ],
    }),
    ask: [{ key: 'P' }, { key: 'Q' }, { key: 'S' }],
  },
  // Extra classes: E is 7A plus guest 7B; 7B has a lesson.
  extra: {
    world: () => ({
      ...base(),
      lessons: [
        { key: 'E', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60, extra: ['7B'] },
        { key: 'F', cls: '7B', subject: 'Sv', teacher: 'T2', room: 'R2', day: 3, start: '10:00', minutes: 60 },
        { key: 'G', cls: '7A', subject: 'En', teacher: 'T3', room: 'R3', day: 4, start: '10:00', minutes: 60 },
      ],
    }),
    ask: [{ key: 'E' }, { key: 'F' }],
  },
  // A room lent out in a window and one the weekly rows close: no lesson holds it.
  roomholds: {
    world: () => ({
      ...base(),
      rooms: [{ key: 'R1' }],
      unavailable: [{ kind: 'room', key: 'R1', day: 3, start: '10:00', end: '12:00' }],
      loans: [{ room: 'R1', day: 4, start: '13:00', end: '15:00' }],
      lessons: [
        { key: 'A', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60 },
        { key: 'B', cls: '7B', subject: 'Sv', teacher: 'T2', day: 2, start: '09:00', minutes: 60 },
      ],
    }),
    ask: [{ key: 'A' }, { brick: { cls: '7B', subject: 'En', teacher: 'T3', room: 'R1', minutes: 60 }, minutes: 60 }],
  },
  // Ombyte and dusch: Idrott (Sv here) leaves the class 15 minutes in the changing room after, and 10 before.
  buffers: {
    world: () => ({
      ...base(),
      buffers: [{ cls: '7A', subject: 'Sv', before: 10, after: 15 }, { cls: '7B', subject: 'En', before: 0, after: 20 }],
      lessons: [
        { key: 'GYM', cls: '7A', subject: 'Sv', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60 },
        { key: 'NEXT', cls: '7A', subject: 'Ma', teacher: 'T2', room: 'R2', day: 2, start: '10:30', minutes: 45 },
        { key: 'EN', cls: '7B', subject: 'En', teacher: 'T3', room: 'R3', day: 3, start: '10:00', minutes: 60 },
        { key: 'AFTER', cls: '7B', subject: 'Ma', teacher: 'T2', room: 'R1', day: 3, start: '11:30', minutes: 45 },
      ],
    }),
    ask: [{ key: 'GYM' }, { key: 'NEXT' }, { key: 'EN' }, { key: 'AFTER' }, { brick: { cls: '7A', subject: 'Sv', teacher: 'T3', minutes: 60 }, minutes: 60 }],
  },
  // Bricks and parked lessons.
  bricks: {
    world: () => ({
      ...base(),
      frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
      meals: [{ class: '7A', day: 1, start: '11:00', end: '11:45' }],
      lessons: [
        { key: 'A', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60 },
        { key: 'B', cls: '7B', subject: 'Sv', teacher: 'T2', room: 'R2', day: 2, start: '10:00', minutes: 60 },
        { key: 'PK', cls: '7A', subject: 'En', teacher: 'T1', room: 'R2', day: 3, start: '10:00', minutes: 45, parked: true },
      ],
    }),
    ask: [
      { brick: { cls: '7A', subject: 'Sv', teacher: 'T1', room: 'R1', minutes: 60 }, minutes: 60 },
      { brick: { cls: '7B', subject: 'Ma', teacher: 'T2', minutes: 90, extra: ['7A'] }, minutes: 90 },
      { key: 'PK' },
    ],
  },
  // Lessons standing against the ramtid and the meal on purpose (exemptFrom), asked about themselves and about others.
  exempt: {
    world: () => ({
      ...base(),
      frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
      meals: [{ class: '7A', day: 1, start: '11:00', end: '11:45' }],
      lessons: [
        { key: 'LATE', cls: '7A', subject: 'Ma', teacher: 'T1', room: 'R1', day: 2, start: '15:30', minutes: 60, exemptFrom: ['FRAME'] },
        { key: 'ONMEAL', cls: '7A', subject: 'Sv', teacher: 'T2', room: 'R2', day: 1, start: '11:00', minutes: 45, exemptFrom: ['LUNCH'] },
        { key: 'PLAIN', cls: '7B', subject: 'En', teacher: 'T1', room: 'R3', day: 3, start: '10:00', minutes: 60 },
        { key: 'ONMEAL2', cls: '7A', subject: 'En', teacher: 'T3', room: 'R3', day: 1, start: '11:15', minutes: 30 },
      ],
    }),
    ask: [{ key: 'LATE' }, { key: 'ONMEAL' }, { key: 'PLAIN' }, { key: 'ONMEAL2' }],
  },
};

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const masters = new MasterLessonsService(api, { notifyMasterTimetableChanged: () => undefined } as never, { recipientsForLessons: async () => [], notifyUsers: async () => undefined } as never);
  const possible = new PossibleTimesService(api, masters);
  // What is asked is whether the answer is right, not how fast: the judge gets all the time it needs on a loaded host.
  possible.judgeBudgetMs = 10 * 60_000;
  const wanted = process.argv.slice(2);
  const failures: string[] = [];
  try {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (wanted.length > 0 && !wanted.includes(name)) continue;
      const world = scenario.world();
      const planted = await plantWorld(owner, `probe-mojliga-regler-${name}`, world);
      for (const ask of scenario.ask) {
        let body: { lessonId?: string; brick?: Record<string, unknown> };
        let minutes: number;
        let label: string;
        if (ask.key) {
          body = { lessonId: planted.lessonId.get(ask.key)! };
          minutes = world.lessons.find((lesson) => lesson.key === ask.key)!.minutes;
          label = `${name}/${ask.key}`;
        } else {
          const b = ask.brick as { cls: string; subject: string; teacher?: string; room?: string; minutes: number; extra?: string[] };
          body = {
            brick: {
              academicYearId: planted.year,
              studentGroupId: planted.classId.get(b.cls),
              subjectId: planted.subjectId.get(b.subject),
              minutes: b.minutes,
              ...(b.teacher ? { teacherId: planted.teacherId.get(b.teacher) } : {}),
              ...(b.room ? { roomId: planted.roomId.get(b.room) } : {}),
              ...(b.extra ? { extraGroupIds: b.extra.map((x) => planted.classId.get(x)) } : {}),
            },
          };
          minutes = b.minutes;
          label = `${name}/brick(${b.cls} ${b.subject} ${b.minutes} min)`;
        }
        const { disagreements, tally, answer } = await compareOne(api, masters, possible, planted, body, minutes, label);
        assert.equal(answer.stats.truncated, false, `${label}: the judge ran out of time`);
        // No kind of disagreement is allowed, and a stretch closed by a room no lesson holds is never "crowded" by no one.
        const bad = disagreements;
        // CROWDED with no lesson in it (units: 0) is only for starts the judge refuses for a clash the prune cannot see (a pupil named on a lesson);
        // one the judge refuses for a rule the query can name, with no clash at all, is CLOSED.
        const zero = Object.entries(tally).filter(([key]) => /^CROWDED_ZERO_judge:(AVAILABILITY|OTHER_SCHOOL)(\+(AVAILABILITY|OTHER_SCHOOL))*$/.test(key)).reduce((sum, [, count]) => sum + count, 0);
        if (bad.length > 0 || zero > 0) failures.push(`${label}: ${bad.length} disagreement(s), ${zero} start(s) crowded by no one that a rule closes\n      ${bad.slice(0, 3).map((entry) => entry.detail).join('\n      ')}`);
        console.log(`  ${bad.length === 0 && zero === 0 ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(tally)}`);
      }
      await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`probe-mojliga-regler-${name}`, `probe-mojliga-regler-${name}-andra`]);
    }
  } finally {
    await owner.end();
    await api.$disconnect();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} question(s) the judge and the query read differently:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
