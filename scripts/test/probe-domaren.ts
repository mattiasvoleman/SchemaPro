/**
 * En domare med ord (E1): ONE DRAG, THREE JUDGES, against a real database, as the API role under RLS, through the real
 * services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-domaren.ts
 *
 * A lesson of the grundschema is held to rules by four roads: the hand edit (the PATCH and the läsande frågan, lesson-judge.ts),
 * a swap (swaps/, G1) and a förläggning (requirement-placements/, judgePlacements). Until E1 the hand edit held a lesson to the clash
 * rule and nothing else. This asks the same drag of all three, over the rows of a school it plants, and requires them to agree on the
 * rules they share: the clash rule (teacher, room, class, pupils, the weekly closures), the stage's ramtid, the class's meal and the
 * rules on whole årskurser.
 *
 *   (dj-a) for every case of src/calendar/__fixtures__/lesson-judge-cases.json (small worlds, each lesson a drag to a new day and clock):
 *          the läsande frågan, a swap's judge for the one move and the förläggning's judge give the same verdict: ok or not, and
 *          the same reasons (the hand edit's heaviest is the förläggning's, its set is the swap's), and the verdict is the one the
 *          fixture holds (DOMAREN_WRITE=1 writes the real verdicts back and regenerates the worlds and drags from their seeds);
 *   (dj-b) the PATCH that follows says the same: a drag the question lets through is saved, one it refuses is a 409
 *          MASTER_LESSON_REFUSED with the question's heaviest reason and every reason it found, FLAT, and nothing is written;
 *   (dj-c) the cases are not vacuous: every rule the three share is refused in some case and let through in others.
 *
 * What the three do NOT share, and so what the worlds leave out:
 *   - the förläggning's judge holds a row against the lessons Generera keeps and not the ones it wrote, and only to the meals the school
 *     placed (a meal Generera laid is laid again around a förläggning): every lesson here is the school's own and every meal is placed;
 *   - OTHER_SCHOOL needs a huvudman with two schools; src/calendar/lesson-judge.property.spec.ts holds the three to one reading of
 *     the other schools' holds, and master-lessons.judge.spec.ts holds the PATCH to it;
 *   - SCHOOL_DAY, PAIR_ROOM, BLOCK and OVER_DEMAND are the förläggning's own questions about a row; a drag stays inside Monday to Friday
 *     08:00–18:00 on the five-minute grid.
 *
 * "Låt stå" is asked in lesson-judge.ts and master-lessons.judge.spec.ts: a drag changes where a lesson stands, so every rule is asked.
 *
 * Independent of what earlier CI steps left in the database: it works in schools of its own (slug `probe-domaren-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { judgePlacements, type JudgedPlacement } from '../../src/requirement-placements/placement-judge';
import { SwapContext } from '../../src/swaps/swap-context';
import { readSwapData } from '../../src/swaps/swap-snapshot';
import { SwapsService } from '../../src/swaps/swaps.service';
import { CURRENT } from '../../src/year-rollover/projected-rosters';

const SLUG = 'probe-domaren';
const FIXTURE = join(__dirname, '../../src/calendar/__fixtures__/lesson-judge-cases.json');
const SEED = 20261125;

type Recurrence = 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
export interface World {
  classes: { key: string; grade: number }[];
  teachers: string[];
  rooms: string[];
  subjects: string[];
  lessons: { key: string; class: string; subject: string; teacher: string; coTeacher?: string; room?: string; day: number; start: string; minutes: number; recurrence?: Recurrence }[];
  unavailable: { kind: 'teacher' | 'room' | 'class' | 'grade'; key?: string; grades?: [number, number]; day: number; start: string; end: string }[];
  frames: { grades: [number, number]; start: string; end: string }[];
  meals: { class: string; day: number; start: string; end: string }[];
}
export interface Drag {
  lesson: string;
  day: number;
  start: string;
}
export interface Verdict {
  ok: boolean;
  /** The reasons the hand edit finds, the heaviest first. */
  reasons: string[];
}
export interface Case {
  name: string;
  world: number;
  drag: Drag;
  verdict: Verdict;
}
interface Fixture {
  readme: string[];
  worlds: World[];
  cases: Case[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The worlds: seeded, so that the file can be written again from nothing.
// ---------------------------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

export function generateWorlds(count: number, perWorld: number): { worlds: World[]; drags: Drag[][] } {
  const next = random(SEED);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const between = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  const worlds: World[] = [];
  const drags: Drag[][] = [];
  for (let w = 0; w < count; w++) {
    const world: World = {
      classes: [
        { key: '7A', grade: 7 },
        { key: '8B', grade: 8 },
        { key: '9C', grade: 9 },
      ],
      teachers: ['T1', 'T2', 'T3', 'T4'],
      rooms: ['R1', 'R2', 'R3'],
      subjects: ['Ma', 'Sv', 'En'],
      lessons: [],
      unavailable: [],
      frames: w % 5 === 4 ? [] : [{ grades: [7, 9], start: '08:00', end: pick(['14:30', '15:00', '16:00']) }],
      meals: [],
    };
    for (const entry of world.classes) {
      for (let day = 1; day <= 5; day++) {
        if (next() < 0.7) {
          const start = 11 * 60 + 15 * between(0, 4);
          world.meals.push({ class: entry.key, day, start: clockOf(start), end: clockOf(start + 45) });
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      // The rules on whole årskurser twice as often as the others: they close an hour to a stage, not to one resource, and reach more drags.
      const kind = pick(['teacher', 'room', 'class', 'grade', 'grade'] as const);
      const start = 8 * 60 + 15 * between(0, 24);
      world.unavailable.push({
        kind,
        ...(kind === 'teacher' ? { key: pick(world.teachers) } : kind === 'room' ? { key: pick(world.rooms) } : kind === 'class' ? { key: pick(world.classes).key } : { grades: [7 + between(0, 1), 8 + between(0, 1)] as [number, number] }),
        day: between(1, 5),
        start: clockOf(start),
        end: clockOf(start + 60),
      });
    }
    // Lessons laid clear of one another by the clash rule's own measure (a teacher, a room or a class twice at one time is no
    // start for a drag that is asked to be let through): they may well stand against a frame, a meal or a closure.
    let attempts = 0;
    while (world.lessons.length < 12 && attempts++ < 400) {
      const lesson = {
        key: `L${world.lessons.length + 1}`,
        class: pick(world.classes).key,
        subject: pick(world.subjects),
        teacher: pick(world.teachers),
        ...(next() < 0.1 ? { coTeacher: pick(world.teachers) } : {}),
        ...(next() < 0.7 ? { room: pick(world.rooms) } : {}),
        day: between(1, 5),
        start: clockOf(8 * 60 + 5 * between(0, 84)),
        minutes: pick([40, 45, 50, 60]),
        ...(next() < 0.15 ? { recurrence: pick(['ODD_WEEKS', 'EVEN_WEEKS'] as const) } : {}),
      };
      if (lesson.coTeacher === lesson.teacher) delete (lesson as { coTeacher?: string }).coTeacher;
      const weeks = (a?: Recurrence, b?: Recurrence): boolean => !a || !b || a === 'ALL_WEEKS' || b === 'ALL_WEEKS' || a === b;
      const clash = world.lessons.some(
        (other) =>
          other.day === lesson.day &&
          overlaps(minutesOf(lesson.start), minutesOf(lesson.start) + lesson.minutes, minutesOf(other.start), minutesOf(other.start) + other.minutes) &&
          weeks(lesson.recurrence, other.recurrence) &&
          (other.class === lesson.class ||
            [other.teacher, other.coTeacher].some((id) => id !== undefined && [lesson.teacher, lesson.coTeacher].includes(id)) ||
            (lesson.room !== undefined && other.room === lesson.room)),
      );
      if (!clash) world.lessons.push(lesson);
    }
    worlds.push(world);
    drags.push(
      Array.from({ length: perWorld }, () => ({
        lesson: pick(world.lessons).key,
        day: between(1, 5),
        start: clockOf(8 * 60 + 5 * between(0, 102)),
      })),
    );
  }
  return { worlds, drags };
}

// ---------------------------------------------------------------------------------------------------------------------
// A world in a school of its own.
// ---------------------------------------------------------------------------------------------------------------------

export interface Planted {
  school: string;
  year: string;
  caller: AuthenticatedUser;
  lessonId: Map<string, string>;
  classId: Map<string, string>;
  teacherId: Map<string, string>;
  roomId: Map<string, string>;
  subjectId: Map<string, string>;
  /** A lesson as the world stores it: for putting one back where it stood. */
  slot: Map<string, { day: number; start: string; end: string }>;
}

export async function plant(owner: Client, slug: string, world: World): Promise<Planted> {
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${slug}`, slug])).id;
  // A läsår that starts on a Saturday, the active one, in the nine-year numbering the grade rules read.
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'probe domaren', '2026-08-15', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
      [school],
    )
  ).id;
  const person = async (label: string, role: string, adminProfile?: string) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt") VALUES ($1, $2, $3, 'Domaren', $4, $5, true, $6, now()) RETURNING id`,
      [school, `${slug}-${label}@example.invalid`, label, role, authId, adminProfile ?? null],
    );
    return { id: row.id, authId };
  };
  const classId = new Map<string, string>();
  for (const entry of world.classes) {
    classId.set(
      entry.key,
      (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [school, year, entry.key, entry.grade])).id,
    );
  }
  const teacherId = new Map<string, string>();
  for (const key of world.teachers) teacherId.set(key, (await person(key, 'TEACHER')).id);
  const roomId = new Map<string, string>();
  for (const key of world.rooms) roomId.set(key, (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, key])).id);
  const subjectId = new Map<string, string>();
  for (const key of world.subjects) subjectId.set(key, (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, key])).id);
  const admin = await person('admin', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
  const caller = { authId: admin.authId, userId: admin.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;

  const lessonId = new Map<string, string>();
  const slot = new Map<string, { day: number; start: string; end: string }>();
  for (const lesson of world.lessons) {
    const end = clockOf(minutesOf(lesson.start) + lesson.minutes);
    lessonId.set(
      lesson.key,
      (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, false, $11::"LessonRecurrence", now()) RETURNING id`,
          [school, year, subjectId.get(lesson.subject), classId.get(lesson.class), teacherId.get(lesson.teacher), lesson.coTeacher ? teacherId.get(lesson.coTeacher) : null, lesson.room ? roomId.get(lesson.room) : null, lesson.day, lesson.start, end, lesson.recurrence ?? 'ALL_WEEKS'],
        )
      ).id,
    );
    slot.set(lesson.key, { day: lesson.day, start: lesson.start, end });
  }
  for (const rule of world.unavailable) {
    const resource = { teacher: 'TEACHER', room: 'ROOM', class: 'STUDENT_GROUP', grade: 'GRADE_LEVEL' }[rule.kind];
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "roomId", "studentGroupId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
       VALUES ($1, $2::"ConstraintResource", $3, $4, $5, $6, $7, $8, $9, $10, 'UNAVAILABLE', now())`,
      [
        school,
        resource,
        rule.kind === 'teacher' ? teacherId.get(rule.key!) : null,
        rule.kind === 'room' ? roomId.get(rule.key!) : null,
        rule.kind === 'class' ? classId.get(rule.key!) : null,
        rule.kind === 'grade' ? rule.grades![0] : null,
        rule.kind === 'grade' ? rule.grades![1] : null,
        rule.day,
        rule.start,
        rule.end,
      ],
    );
  }
  for (const frame of world.frames) {
    await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, NULL, $4, $5, now())`, [school, frame.grades[0], frame.grades[1], frame.start, frame.end]);
  }
  for (const meal of world.meals) {
    await owner.query(
      `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, false, now())`,
      [school, year, classId.get(meal.class), meal.day, meal.start, meal.end],
    );
  }
  return { school, year, caller, lessonId, classId, teacherId, roomId, subjectId, slot };
}

// ---------------------------------------------------------------------------------------------------------------------
// The three judges.
// ---------------------------------------------------------------------------------------------------------------------

const unify = (reason: string): string => (reason === 'PUPILS' ? 'GROUP' : reason);

export async function domarenChecks(owner: Client, api: PrismaService, check: (label: string, body: () => Promise<void>) => Promise<void>): Promise<void> {
  const write = process.env['DOMAREN_WRITE'] === '1';
  const fixture: Fixture = write ? { readme: [], worlds: [], cases: [] } : (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture);
  if (write) {
    const { worlds, drags } = generateWorlds(18, 14);
    fixture.worlds = worlds;
    fixture.cases = worlds.flatMap((world, index) =>
      drags[index]!.map((drag, at) => ({ name: `w${index}-d${at}: ${drag.lesson} to day ${drag.day} at ${drag.start}`, world: index, drag, verdict: { ok: true, reasons: [] } })),
    );
    // After them, so that the cases above are the ones written before: each world's first lesson dragged onto a Saturday and a Sunday, which is
    // the school day's no (SCHOOL_DAY, granskaren g461 L-4).
    fixture.cases.push(
      ...worlds.flatMap((world, index) =>
        [6, 7].map((day) => ({
          name: `w${index}-weekend: ${world.lessons[0]!.key} to day ${day} at ${world.lessons[0]!.start}`,
          world: index,
          drag: { lesson: world.lessons[0]!.key, day, start: world.lessons[0]!.start },
          verdict: { ok: true, reasons: [] },
        })),
      ),
    );
  }

  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const swaps = new SwapsService(api, masters, new ScheduleVersionsService(api), realtime as never, notifications as never);

  /** The real verdict of each case, by the case: the weekend cases come last in the file and not last in their world. */
  const real = new Map<Case, Verdict>();
  const differing: string[] = [];
  const seen = new Map<string, { refused: number; stood: number }>();
  const note = (reason: string, refused: boolean) => {
    const entry = seen.get(reason) ?? { refused: 0, stood: 0 };
    if (refused) entry.refused += 1;
    else entry.stood += 1;
    seen.set(reason, entry);
  };
  let stood = 0;

  const byWorld = new Map<number, Case[]>();
  for (const one_case of fixture.cases) byWorld.set(one_case.world, [...(byWorld.get(one_case.world) ?? []), one_case]);

  try {
    await check(`(dj-a) one drag, three judges: the läsande frågan, a swap's judge and the förläggning's give the same verdict for every one of the ${fixture.cases.length} cases (${write ? 'WRITING the real verdicts back' : 'checking'})`, async () => {
      for (const [index, world] of fixture.worlds.entries()) {
        const planted = await plant(owner, `${SLUG}-${index}`, world);
        const { caller } = planted;
        const order = byWorld.get(index) ?? [];
        for (const [at, one_case] of order.entries()) {
          const lessonId = planted.lessonId.get(one_case.drag.lesson)!;
          const lesson = world.lessons.find((entry) => entry.key === one_case.drag.lesson)!;
          const standing = planted.slot.get(one_case.drag.lesson)!;
          const minutes = minutesOf(standing.end) - minutesOf(standing.start);
          const day = one_case.drag.day;
          const startMinutes = minutesOf(one_case.drag.start);
          const endMinutes = startMinutes + minutes;
          const label = `${one_case.name} (world ${index})`;

          // 1. The hand edit's question.
          const asked = await masters.judgeMoves({ moves: [{ lessonId, dayOfWeek: day, startTime: clockOf(startMinutes), endTime: clockOf(endMinutes) }] }, caller);
          const mine = asked.moves[0]!;
          const verdict: Verdict = { ok: mine.ok, reasons: mine.refusals.map((refusal) => refusal.reason) };

          // 2. A swap's judge for the one move: the board's rules, then the clash rule as ONE move (swaps.service.ts clashesOf).
          const move = { lessonId, from: { dayOfWeek: standing.day, startMinutes: minutesOf(standing.start), endMinutes: minutesOf(standing.end) }, to: { dayOfWeek: day, startMinutes, endMinutes } };
          const swapReasons = await api.withRls(caller, async (tx) => {
            const data = await readSwapData(tx, caller, planted.year);
            const context = new SwapContext(data);
            const board = context.boardVerdict([move]);
            const clashes = (await (swaps as unknown as { clashesOf: (...args: unknown[]) => Promise<Array<{ kind: string }>> }).clashesOf(tx, data, context, [move])) as Array<{ kind: string }>;
            return new Set([...(board ? [board] : []), ...clashes.map((clash) => clash.kind)].map(unify));
          });

          // 3. The förläggning's judge for a row at that slot, the lesson itself set aside on the tray while it is asked (a drag has
          //    taken it from where it stood), and put back.
          await owner.query(`UPDATE "MasterLessons" SET "isParked" = true WHERE id = $1`, [lessonId]);
          let placement: { ok: boolean; reason?: string };
          try {
            const row: JudgedPlacement = {
              id: null,
              requirementId: randomUUID(),
              studentGroupId: planted.classId.get(lesson.class)!,
              subjectId: planted.subjectId.get(lesson.subject)!,
              teacherId: planted.teacherId.get(lesson.teacher)!,
              coTeacherId: lesson.coTeacher ? planted.teacherId.get(lesson.coTeacher)! : null,
              dayOfWeek: day,
              startMinutes,
              minutes,
              roomId: lesson.room ? planted.roomId.get(lesson.room)! : null,
              recurrence: lesson.recurrence ?? 'ALL_WEEKS',
              startDate: null,
              endDate: null,
            };
            const [verdictOfRow] = await api.withRls(caller, (tx) =>
              judgePlacements(tx, masters, { academicYearId: planted.year, schoolId: planted.school, gradeNumbering: 'NIOARIG', basis: CURRENT, rows: [row], beside: [] }),
            );
            placement = { ok: verdictOfRow!.ok, ...(verdictOfRow!.reason ? { reason: verdictOfRow!.reason } : {}) };
          } finally {
            await owner.query(`UPDATE "MasterLessons" SET "isParked" = false WHERE id = $1`, [lessonId]);
          }

          // A clash names the other lesson by class, subject, day and clock, and that lesson is one of the world's that really
          // shares the resource at the slot (never a person, never an id).
          for (const refusal of mine.refusals.filter((entry) => ['TEACHER', 'ROOM', 'GROUP', 'PUPILS'].includes(entry.reason))) {
            const named = world.lessons.filter(
              (other) =>
                other.key !== lesson.key &&
                other.day === day &&
                other.class === refusal.params['className'] &&
                other.subject === refusal.params['subjectName'] &&
                other.start === refusal.params['start'] &&
                clockOf(minutesOf(other.start) + other.minutes) === refusal.params['end'] &&
                overlaps(startMinutes, endMinutes, minutesOf(other.start), minutesOf(other.start) + other.minutes) &&
                (refusal.reason === 'TEACHER'
                  ? [other.teacher, other.coTeacher].some((id) => id !== undefined && [lesson.teacher, lesson.coTeacher].includes(id))
                  : refusal.reason === 'ROOM'
                    ? other.room !== undefined && other.room === lesson.room
                    : other.class === lesson.class),
            );
            assert.ok(named.length > 0, `${label}: ${refusal.reason} names ${JSON.stringify(refusal.params)}, which is no lesson of the world that shares it`);
            assert.equal(refusal.params['day'], day, `${label}: the day of the other lesson`);
          }

          // The three agree.
          assert.equal(placement.ok, verdict.ok, `${label}: the förläggning's judge says ${placement.ok ? 'ok' : placement.reason}, the läsande frågan ${verdict.ok ? 'ok' : verdict.reasons.join(',')}`);
          // A swap moves a lesson only to where another lesson stands, so it has no question about the school day: for a Saturday or a Sunday
          // the hand edit and the förläggning say SCHOOL_DAY first, and the swap's judge is asked of the rest.
          const weekend = day > 5;
          if (weekend) assert.equal(verdict.reasons[0], 'SCHOOL_DAY', `${label}: a weekend day is the school day's no, first`);
          const swapSays = weekend ? new Set(verdict.reasons.filter((reason) => reason !== 'SCHOOL_DAY').map(unify)) : swapReasons;
          assert.equal(swapSays.size === 0, weekend ? swapReasons.size === 0 : verdict.ok, `${label}: a swap's judge says ${[...swapReasons].join(',') || 'ok'}, the läsande frågan ${verdict.ok ? 'ok' : verdict.reasons.join(',')}`);
          if (!verdict.ok) {
            assert.equal(placement.reason, verdict.reasons[0], `${label}: the heaviest reason is ${placement.reason} for the förläggning's judge and ${verdict.reasons[0]} for the läsande frågan`);
            assert.deepEqual([...swapReasons].sort(), [...new Set(verdict.reasons.filter((reason) => reason !== 'SCHOOL_DAY').map(unify))].sort(), `${label}: the reasons are not a swap's`);
          }
          for (const reason of verdict.ok ? [] : [...new Set(verdict.reasons.map(unify))]) note(reason, true);
          if (verdict.ok) stood += 1;

          // The fixture holds the verdict.
          real.set(one_case, verdict);
          if (!write && JSON.stringify(verdict) !== JSON.stringify(one_case.verdict)) {
            differing.push(`  ${label}\n       fixture ${JSON.stringify(one_case.verdict)}  real ${JSON.stringify(verdict)}`);
          }

          // (dj-b) The PATCH that follows says the same, on every third drag (a write, and it is put back).
          if (at % 3 === 0) {
            try {
              await masters.update(lessonId, { dayOfWeek: day, startTime: clockOf(startMinutes), endTime: clockOf(endMinutes) }, caller);
              assert.ok(verdict.ok, `${label}: the PATCH saved a drag the question refused (${verdict.reasons.join(',')})`);
              await owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = $2, "startTime" = $3, "endTime" = $4 WHERE id = $1`, [lessonId, standing.day, standing.start, standing.end]);
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              assert.equal(error.getStatus(), 409, `${label}: the PATCH failed with ${error.getStatus()}`);
              const body = error.getResponse() as { code?: string; message?: string; params?: Record<string, unknown> };
              assert.equal(body.code, 'MASTER_LESSON_REFUSED', `${label}: the PATCH's 409 has the code ${body.code}`);
              assert.ok(!verdict.ok, `${label}: the PATCH refused a drag the question let through (${body.params?.['reason']})`);
              assert.equal(body.params?.['reason'], verdict.reasons[0], `${label}: the PATCH's heaviest reason`);
              assert.equal(body.params?.['reasons'], [...new Set(verdict.reasons)].join(','), `${label}: the PATCH's reasons`);
              for (const [key, value] of Object.entries(body.params ?? {})) assert.ok(typeof value === 'string' || typeof value === 'number', `${label}: param ${key} is not flat`);
              assert.ok(typeof body.message === 'string' && body.message.length > 0, `${label}: the PATCH's 409 has no sentence`);
              const after = await owner.query(`SELECT "dayOfWeek", to_char("startTime", 'HH24:MI') AS start FROM "MasterLessons" WHERE id = $1`, [lessonId]);
              assert.deepEqual([after.rows[0].dayOfWeek, after.rows[0].start], [standing.day, standing.start], `${label}: a refused PATCH wrote`);
            }
          }
        }
        await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`${SLUG}-${index}`]);
      }
      if (write) {
        fixture.cases = fixture.cases.map((one_case) => ({ ...one_case, verdict: real.get(one_case)! }));
        fixture.readme = [
          'The cases of the judge of a hand edit (src/calendar/lesson-judge.ts): each is a small world (worlds[n]), one lesson of it dragged to a new day and clock (drag, the lesson keeps its length), and the verdict the real judge gives it.',
          'WRITTEN BY scripts/test/probe-domaren.ts (DOMAREN_WRITE=1 npx ts-node --transpile-only scripts/test/probe-domaren.ts), which asks the läsande frågan, a swap\'s judge and the förläggning\'s judge of every case over real Postgres and requires them to agree before it writes. Do not edit by hand.',
          'verdict.reasons: every reason the hand edit finds, the heaviest first (TEACHER, ROOM, GROUP, PUPILS, AVAILABILITY, then FRAME, LUNCH, GRADE_RULE). web/lib/lesson-judge-mirror.contract.test.ts holds the web\'s mirror of the clash rule to them: never milder, for the rules it has.',
          'Every lesson of a world stands where it was laid, whether or not it stands against a frame, a meal or a closure (låt stå), and every meal is the school\'s own. Lessons are laid clear of one another; OTHER_SCHOOL is not here (it needs a huvudman).',
        ];
        writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
        console.log(`     wrote ${fixture.cases.length} cases in ${fixture.worlds.length} worlds`);
        return;
      }
      assert.equal(differing.length, 0, `${differing.length} case(s) differ from the real judge (DOMAREN_WRITE=1 writes them back):\n${differing.join('\n')}`);
    });

    await check('(dj-c) the cases are not vacuous: every rule the three share is refused in some case, and many drags stand', async () => {
      for (const reason of ['TEACHER', 'ROOM', 'GROUP', 'AVAILABILITY', 'FRAME', 'LUNCH', 'GRADE_RULE', 'SCHOOL_DAY']) {
        assert.ok((seen.get(reason)?.refused ?? 0) >= 3, `${reason} is refused in ${seen.get(reason)?.refused ?? 0} cases`);
      }
      assert.ok(stood >= 20, `${stood} drags stand`);
      console.log(`     ${[...seen].map(([reason, count]) => `${reason} ${count.refused}`).join(', ')}; ${stood} stand of ${fixture.cases.length}`);
    });
  } finally {
    for (let index = 0; index < fixture.worlds.length; index++) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`${SLUG}-${index}`]);
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await domarenChecks(owner, api, async (name, run) => {
      try {
        await run();
        console.log(`  ok  ${name}`);
      } catch (error) {
        console.error(`  FAIL  ${name}`);
        throw error;
      }
    });
  } finally {
    await owner.end();
    await api.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
