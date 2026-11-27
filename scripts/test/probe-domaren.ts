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
 * The first eighteen worlds are small (a class with no pupil in it, one class to a lesson, no window of dates, no other school), and the
 * file's other worlds carry what they leave out (E3, g461 L-7): pupils with a home class, teaching groups of pupils from several classes
 * (PUPILS), lessons with an extra class or pupils named on them, lessons and meals that run in a window of dates, and a room another
 * school has borrowed for an hour (OTHER_SCHOOL). They come after the eighteen, from a seed of their own, so writing the file again
 * leaves every earlier case where it was.
 *
 * What the three do NOT share, and so what the worlds leave out:
 *   - the förläggning's judge holds a row against the lessons Generera keeps and not the ones it wrote, and only to the meals the school
 *     placed (a meal Generera laid is laid again around a förläggning): every lesson here is the school's own and every meal is placed;
 *   - the förläggning's row is a post's: a class, a subject, a teacher and no extra class and no pupil named on it, so for a lesson
 *     that has either (the richer worlds, generateRichWorlds) the förläggning's judge is asked and not held to the other two;
 *   - OTHER_SCHOOL is the hand edit's and a swap's (a room another school has borrowed, RoomLoans): src/calendar/lesson-judge.property.spec.ts
 *     holds the three to one reading of the other schools' holds, including a shared teacher's lessons, which need a huvudman with two
 *     schools and which the worlds do not plant, and master-lessons.judge.spec.ts holds the PATCH to it;
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
/** How many of the richer worlds the file holds, and how many drags each (generateRichWorlds). */
const RICH_WORLDS = 14;
const RICH_DRAGS = 20;
/** How many richer worlds with no pupil named on a lesson follow them (generateRichWorlds, `named: false`). */
const UNNAMED_WORLDS = 4;

type Recurrence = 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
export interface World {
  classes: { key: string; grade: number }[];
  teachers: string[];
  rooms: string[];
  subjects: string[];
  /**
   * `class` names a class or, in the worlds with `groups`, a teaching group. `extra` is the lesson's other classes or groups
   * (MasterLessonGroups), `participants` the pupils named on it (MasterLessonStudents), `startDate` and `endDate` its window.
   * None of the three is in the eighteen first worlds.
   */
  lessons: {
    key: string;
    class: string;
    subject: string;
    teacher: string;
    coTeacher?: string;
    room?: string;
    day: number;
    start: string;
    minutes: number;
    recurrence?: Recurrence;
    extra?: string[];
    participants?: string[];
    startDate?: string;
    endDate?: string;
  }[];
  unavailable: { kind: 'teacher' | 'room' | 'class' | 'grade'; key?: string; grades?: [number, number]; day: number; start: string; end: string }[];
  frames: { grades: [number, number]; start: string; end: string }[];
  /** `startDate` and `endDate` make a meal of a part of the läsår: a class has another meal in each window. */
  meals: { class: string; day: number; start: string; end: string; startDate?: string; endDate?: string }[];
  /**
   * The pupils of the school, each in the class they name (Users.studentGroupId), as `class:n`. Only the worlds from the nineteenth
   * on have any: with none, a class has no pupil and the clash rule's PUPILS has nothing to say. `inactive`: a pupil who has left
   * (Users.isActive false) and whose rows stay, in the class they named and in the groups they were a member of: the judge reads active
   * pupils only (E3, g503 #503 L-1).
   */
  pupils?: { key: string; class: string; inactive?: true }[];
  /** Teaching groups: pupils of one or several classes who have a lesson of their own (StudentGroupMembers). */
  groups?: { key: string; members: string[] }[];
  /** A room of this school that a second school of the huvudman has borrowed for an hour of the week: OTHER_SCHOOL (RoomLoans). */
  loans?: { room: string; day: number; start: string; end: string }[];
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
// The richer worlds (E3, granskaren g461 L-7): what the first eighteen leave out.
//
// The first eighteen worlds have a class and no pupil in it, one class to a lesson, no window of dates and no other school, so the
// grid's "never milder" and the board's painting were proved on that slice only. These carry pupils with a home class, teaching groups
// of pupils from several classes, lessons with an extra class or with pupils named on them, lessons and meals that run in a window of
// the läsår, and a room that a second school of the huvudman has borrowed for an hour. They come AFTER the eighteen and their cases
// after those of the eighteen, from a seed of their own, so that writing the file again leaves every earlier case where it was.
// ---------------------------------------------------------------------------------------------------------------------

const RICH_SEED = 20261126;
/** Where the richer worlds begin in the file: the first eighteen are `generateWorlds(18, 14)`. */
export const FIRST_RICH_WORLD = 18;
const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['2026-08-31', '2026-10-25'],
  ['2026-10-26', '2026-12-20'],
  ['2027-01-11', '2027-06-06'],
];
/** The läsår the worlds plant (a Saturday to a Friday), which a meal that has no window of its own runs in. */
const YEAR_FROM = '2026-08-15';
const YEAR_TO = '2027-06-11';
const windowsOverlap = (a: { startDate?: string; endDate?: string }, b: { startDate?: string; endDate?: string }): boolean =>
  !(a.endDate && b.startDate && a.endDate < b.startDate) && !(b.endDate && a.startDate && b.endDate < a.startDate);

export function generateRichWorlds(count: number, perWorld: number, options: { seed?: number; named?: boolean } = {}): { worlds: World[]; drags: Drag[][] } {
  // `named: false` leaves out the pupils a lesson names (MasterLessonStudents): the possible-times probe (probe-mojliga-tider.ts) cannot see
  // such a pupil in its prune and so drops "the prune lets nothing through that the judge refuses" in a world that has one, and these worlds are
  // where that exactness is held for the richer rules (extra classes, teaching groups, windows, a lent room).
  const named = options.named ?? true;
  const next = random(options.seed ?? RICH_SEED);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const between = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  const sample = <T>(items: readonly T[], size: number): T[] => {
    const left = [...items];
    const taken: T[] = [];
    while (taken.length < size && left.length > 0) taken.push(left.splice(Math.floor(next() * left.length), 1)[0]!);
    return taken;
  };
  const worlds: World[] = [];
  const drags: Drag[][] = [];
  for (let w = 0; w < count; w++) {
    const classes = [
      { key: '7A', grade: 7 },
      { key: '8B', grade: 8 },
      { key: '9C', grade: 9 },
    ];
    const pupils = classes.flatMap((entry) => [1, 2, 3, 4].map((n) => ({ key: `${entry.key}:${n}`, class: entry.key })));
    // Two teaching groups, each of three or four pupils from one to three of the classes.
    const groups = ['G1', 'G2'].map((key) => ({ key, members: sample(pupils, between(3, 4)).map((pupil) => pupil.key).sort() }));
    const world: World = {
      classes,
      teachers: ['T1', 'T2', 'T3', 'T4'],
      rooms: ['R1', 'R2', 'R3'],
      subjects: ['Ma', 'Sv', 'En'],
      lessons: [],
      unavailable: [],
      frames: w % 5 === 4 ? [] : [{ grades: [7, 9], start: '08:00', end: pick(['14:30', '15:00', '16:00']) }],
      meals: [],
      pupils,
      groups,
      loans: [],
    };
    for (const entry of classes) {
      for (let day = 1; day <= 5; day++) {
        if (next() >= 0.7) continue;
        const start = 11 * 60 + 15 * between(0, 4);
        // A class has another meal in the second half of the läsår in two of every five cases.
        if (next() < 0.4) {
          // A meal's weeks run from a Monday to a Sunday (LunchSittings_weeks_start_on_a_monday).
          world.meals.push({ class: entry.key, day, start: clockOf(start), end: clockOf(start + 45), startDate: '2026-08-17', endDate: '2026-12-20' });
          world.meals.push({ class: entry.key, day, start: clockOf(start + 30), end: clockOf(start + 75), startDate: '2027-01-11', endDate: '2027-06-06' });
        } else {
          world.meals.push({ class: entry.key, day, start: clockOf(start), end: clockOf(start + 45) });
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const kind = pick(['teacher', 'room', 'class', 'grade', 'grade'] as const);
      const start = 8 * 60 + 15 * between(0, 24);
      world.unavailable.push({
        kind,
        ...(kind === 'teacher' ? { key: pick(world.teachers) } : kind === 'room' ? { key: pick(world.rooms) } : kind === 'class' ? { key: pick(classes).key } : { grades: [7 + between(0, 1), 8 + between(0, 1)] as [number, number] }),
        day: between(1, 5),
        start: clockOf(start),
        end: clockOf(start + 60),
      });
    }

    const holders = [...classes.map((entry) => entry.key), ...groups.map((group) => group.key)];
    const pupilsOfGroup = (key: string): string[] => groups.find((group) => group.key === key)?.members ?? pupils.filter((pupil) => pupil.class === key).map((pupil) => pupil.key);
    const pupilsOf = (lesson: World['lessons'][number]): Set<string> => new Set([...pupilsOfGroup(lesson.class), ...(lesson.extra ?? []).flatMap(pupilsOfGroup), ...(lesson.participants ?? [])]);
    const weeks = (a?: Recurrence, b?: Recurrence): boolean => !a || !b || a === 'ALL_WEEKS' || b === 'ALL_WEEKS' || a === b;
    // Lessons laid clear of one another by the clash rule's own measure, pupils and windows included: a drag is the question, and it is
    // no use to ask it of a world that begins in a clash.
    let attempts = 0;
    while (world.lessons.length < 12 && attempts++ < 600) {
      const klass = pick(holders);
      const lesson: World['lessons'][number] = {
        key: `L${world.lessons.length + 1}`,
        class: klass,
        subject: pick(world.subjects),
        teacher: pick(world.teachers),
        ...(next() < 0.1 ? { coTeacher: pick(world.teachers) } : {}),
        ...(next() < 0.7 ? { room: pick(world.rooms) } : {}),
        day: between(1, 5),
        start: clockOf(8 * 60 + 5 * between(0, 84)),
        minutes: pick([40, 45, 50, 60]),
        ...(next() < 0.15 ? { recurrence: pick(['ODD_WEEKS', 'EVEN_WEEKS'] as const) } : {}),
        ...(next() < 0.2 ? { extra: [pick(holders.filter((key) => key !== klass))] } : {}),
        ...(next() < 0.12 && named ? { participants: sample(pupils, between(1, 2)).map((pupil) => pupil.key).sort() } : {}),
        ...(next() < 0.3 ? (([from, to]) => ({ startDate: from, endDate: to }))(pick(WINDOWS)) : {}),
      };
      if (lesson.coTeacher === lesson.teacher) delete lesson.coTeacher;
      const mine = pupilsOf(lesson);
      const clash = world.lessons.some(
        (other) =>
          other.day === lesson.day &&
          overlaps(minutesOf(lesson.start), minutesOf(lesson.start) + lesson.minutes, minutesOf(other.start), minutesOf(other.start) + other.minutes) &&
          weeks(lesson.recurrence, other.recurrence) &&
          windowsOverlap(lesson, other) &&
          ([other.teacher, other.coTeacher].some((id) => id !== undefined && [lesson.teacher, lesson.coTeacher].includes(id)) || (lesson.room !== undefined && other.room === lesson.room) || [...pupilsOf(other)].some((pupil) => mine.has(pupil))),
      );
      if (!clash) world.lessons.push(lesson);
    }
    // Two hours of a room that a lesson stands in, borrowed by another school.
    for (const room of sample([...new Set(world.lessons.flatMap((lesson) => (lesson.room ? [lesson.room] : [])))], 2)) {
      const start = 8 * 60 + 60 * between(0, 8);
      world.loans!.push({ room, day: between(1, 5), start: clockOf(start), end: clockOf(start + 60) });
    }
    worlds.push(world);
    drags.push(
      Array.from({ length: perWorld }, () => {
        const lesson = pick(world.lessons);
        const roll = next();
        // A quarter of the drags go to a room's borrowed hour (OTHER_SCHOOL), and some of those with a lesson that stands in that room.
        if (roll < 0.25 && world.loans!.length > 0) {
          const loan = pick(world.loans!);
          const holder = world.lessons.filter((entry) => entry.room === loan.room);
          const dragged = holder.length > 0 ? pick(holder) : lesson;
          return { lesson: dragged.key, day: loan.day, start: clockOf(Math.max(8 * 60, minutesOf(loan.start) + 5 * between(-6, 6))) };
        }
        // Near another lesson, where a clash of any kind is found: the pupils of a group and of a class, an extra class, a window.
        if (roll < 0.7) {
          const anchor = pick(world.lessons);
          return { lesson: lesson.key, day: anchor.day, start: clockOf(Math.min(16 * 60 + 55, Math.max(8 * 60, minutesOf(anchor.start) + 5 * between(-8, 8)))) };
        }
        return { lesson: lesson.key, day: between(1, 5), start: clockOf(8 * 60 + 5 * between(0, 102)) };
      }),
    );
  }
  return { worlds, drags };
}

// ---------------------------------------------------------------------------------------------------------------------
// The edge worlds (granskaren g503): where a rule's comparison turns, asked on both sides of the turn.
//
// The richer worlds are random, and what a random world lacks is the exact turn of a comparison: a pupil named on TWO lessons (the pupil is
// in neither lesson's class), a window of dates that begins on the day another ends (the days are inclusive), a lesson's window that touches a
// meal's first or last day, a stage whose ramtid is not the class's own (an extra class from the younger stage), a teaching group whose pupils
// are all of years the ramtid does not reach, an hour lent to another school that a lesson touches without covering, and a pupil who has left (the judge
// reads active pupils only: the groups that share only her share none). Written by hand,
// each with the drags on both sides of its turn; after the richer worlds in the file, so that every earlier case stays where it was.
// ---------------------------------------------------------------------------------------------------------------------

export function generateEdgeWorlds(): { worlds: World[]; drags: Drag[][] } {
  const plain = (over: Partial<World> & Pick<World, 'lessons'>): World => ({
    classes: [
      { key: '7A', grade: 7 },
      { key: '8B', grade: 8 },
      { key: '9C', grade: 9 },
    ],
    teachers: ['T1', 'T2', 'T3'],
    rooms: ['R1', 'R2', 'R3'],
    subjects: ['Ma', 'Sv'],
    unavailable: [],
    frames: [],
    meals: [],
    ...over,
  });
  const pupilsOf = (...classes: string[]): { key: string; class: string }[] => classes.flatMap((key) => [1, 2].map((n) => ({ key: `${key}:${n}`, class: key })));
  const lesson = (key: string, klass: string, subject: string, teacher: string, day: number, start: string, extra: Partial<World['lessons'][number]> = {}): World['lessons'][number] => ({ key, class: klass, subject, teacher, day, start, minutes: 60, ...extra });
  const to = (name: string, day: number, start: string): Drag => ({ lesson: name, day, start });

  const worlds: World[] = [];
  const drags: Drag[][] = [];
  const add = (world: World, asked: Drag[]): void => {
    worlds.push(world);
    drags.push(asked);
  };

  // 1. A pupil named on two lessons, in neither lesson's class: the pupil is busy by the naming alone.
  add(
    plain({
      pupils: pupilsOf('7A', '8B', '9C'),
      lessons: [
        lesson('N1', '9C', 'Ma', 'T1', 1, '09:00', { room: 'R1', minutes: 45, participants: ['8B:1'] }),
        lesson('N2', '7A', 'Sv', 'T2', 2, '10:00', { room: 'R2', minutes: 45, participants: ['8B:1'] }),
        lesson('N3', '8B', 'Ma', 'T3', 3, '09:00', { room: 'R3', minutes: 45 }),
        lesson('N4', '7A', 'Ma', 'T2', 4, '09:00', { minutes: 45, participants: ['9C:2'] }),
      ],
    }),
    [
      to('N2', 1, '09:00'), // the pupil is named on both: PUPILS
      to('N2', 1, '09:40'), // 9:40 to 10:25 meets 9:00 to 9:45 by five minutes
      to('N2', 1, '09:45'), // begins where N1 ends: free
      to('N2', 1, '08:20'), // ends five minutes into N1
      to('N2', 1, '08:15'), // ends where N1 begins: free
      to('N1', 2, '10:00'), // and the other way
      to('N3', 1, '09:00'), // the other lesson names a pupil of this class (8B:1): PUPILS
      to('N4', 3, '09:00'), // 9C:2 is named on N4 and no lesson of the hour has 9C or the pupil: free
      to('N4', 1, '09:00'), // N1 is 9C's lesson: the named pupil (9C:2) is of its class
    ],
  );

  // 2. Windows of dates that meet on one day (inclusive), and windows that do not.
  add(
    plain({
      lessons: [
        lesson('A1', '7A', 'Ma', 'T1', 1, '09:00', { room: 'R1', startDate: '2026-08-31', endDate: '2026-10-02' }),
        lesson('A2', '8B', 'Sv', 'T1', 2, '10:00', { room: 'R2', startDate: '2026-10-02', endDate: '2026-12-18' }),
        lesson('A3', '7A', 'Sv', 'T2', 3, '09:00', { room: 'R3', startDate: '2026-08-31', endDate: '2026-10-01' }),
        lesson('A4', '8B', 'Ma', 'T2', 4, '10:00', { startDate: '2026-10-02', endDate: '2026-12-18' }),
      ],
    }),
    [
      to('A2', 1, '09:00'), // A1 ends the day A2 begins: they meet on that day, and share a teacher
      to('A2', 1, '09:30'),
      to('A2', 1, '10:00'), // begins where A1 ends: free
      to('A1', 2, '10:00'), // and the other way
      to('A4', 3, '09:00'), // A3 ends the day before A4 begins: they never meet
      to('A4', 3, '09:30'),
      to('A3', 4, '10:00'),
    ],
  );

  // 3. A lesson's window against a class's meals, that has another meal in each part of the läsår: the meal's first and last day are the meal's.
  add(
    plain({
      meals: [
        { class: '7A', day: 1, start: '11:00', end: '11:45', startDate: '2026-08-17', endDate: '2026-12-20' },
        { class: '7A', day: 1, start: '11:30', end: '12:15', startDate: '2027-01-11', endDate: '2027-06-06' },
      ],
      lessons: [
        lesson('B1', '7A', 'Ma', 'T1', 2, '09:00', { startDate: '2026-12-20', endDate: '2027-01-03' }),
        lesson('B2', '7A', 'Ma', 'T2', 3, '09:00', { startDate: '2026-12-21', endDate: '2027-01-10' }),
        lesson('B3', '7A', 'Ma', 'T1', 4, '09:00', { startDate: '2026-12-28', endDate: '2027-01-11' }),
        lesson('B4', '7A', 'Ma', 'T2', 5, '09:00'),
      ],
    }),
    [
      to('B1', 1, '11:15'), // begins on the autumn meal's last day: LUNCH
      to('B2', 1, '11:15'), // between the two meals, which it meets on no day: free
      to('B2', 1, '11:30'),
      to('B3', 1, '11:30'), // ends on the spring meal's first day: LUNCH
      to('B3', 1, '11:00'), // the autumn meal's hour, and its window has ended: 11:00 to 12:00 meets the spring meal (11:30), so LUNCH too
      to('B3', 1, '12:15'), // after both meals: free
      to('B4', 1, '11:15'), // no window: every meal
      to('B4', 1, '12:20'),
    ],
  );

  // 4. The ramtid of each stage, and a lesson of the older stage with a class of the younger as an extra class.
  add(
    plain({
      frames: [
        { grades: [7, 7], start: '08:00', end: '14:30' },
        { grades: [8, 9], start: '08:00', end: '16:00' },
      ],
      lessons: [
        lesson('F1', '8B', 'Ma', 'T1', 1, '09:00', { room: 'R1', extra: ['7A'] }),
        lesson('F2', '7A', 'Sv', 'T2', 2, '09:00', { room: 'R2' }),
        lesson('F3', '8B', 'Sv', 'T3', 3, '09:00', { room: 'R3' }),
        lesson('F4', '9C', 'Ma', 'T2', 4, '09:00', { extra: ['8B'] }),
      ],
    }),
    [
      to('F1', 1, '14:00'), // the extra class (7A) has closed at 14:30: FRAME
      to('F1', 1, '13:30'), // ends at 14:30 on the minute: free
      to('F1', 1, '13:35'), // five minutes over: FRAME
      to('F2', 2, '14:00'),
      to('F3', 3, '14:30'), // 8B alone: its stage is open to 16:00
      to('F4', 4, '15:00'), // 9C and 8B: both open
      to('F4', 4, '15:05'), // ends 16:05: FRAME
    ],
  );

  // 5. A teaching group whose pupils are all of years the ramtid does not reach, and one with a pupil it does.
  add(
    plain({
      pupils: pupilsOf('7A', '8B'),
      groups: [
        { key: 'G1', members: ['8B:1', '8B:2'] },
        { key: 'G2', members: ['7A:1', '8B:1'] },
      ],
      frames: [{ grades: [7, 7], start: '08:00', end: '14:30' }],
      lessons: [lesson('G1L', 'G1', 'Ma', 'T1', 1, '09:00'), lesson('G2L', 'G2', 'Sv', 'T2', 2, '09:00'), lesson('C7', '7A', 'Ma', 'T3', 3, '09:00')],
    }),
    [
      to('G1L', 1, '14:00'), // only 8B's pupils: the stage's ramtid is not theirs
      to('G2L', 2, '14:00'), // 7A:1 is in it: FRAME
      to('G2L', 2, '13:30'),
      to('C7', 3, '14:00'),
    ],
  );

  // 6. An hour lent to another school, touched and covered: the borrowed hour is the room's from its first minute to its last.
  add(
    plain({
      loans: [{ room: 'R1', day: 1, start: '09:00', end: '10:00' }],
      lessons: [
        lesson('S1', '7A', 'Ma', 'T1', 1, '12:00', { room: 'R2' }),
        lesson('S2', '8B', 'Ma', 'T2', 2, '08:00', { room: 'R2' }),
        lesson('S3', '9C', 'Ma', 'T3', 3, '08:00', { room: 'R1' }),
      ],
    }),
    [
      to('S3', 1, '08:00'), // ends where the loan begins: free
      to('S3', 1, '08:05'), // five minutes into the loan: OTHER_SCHOOL
      to('S3', 1, '09:00'),
      to('S3', 1, '09:55'), // the loan's last five minutes: OTHER_SCHOOL
      to('S3', 1, '10:00'), // begins where the loan ends: free
      to('S3', 2, '09:00'), // the loan is a Monday's: free on a Tuesday
      to('S2', 1, '09:00'), // another room: free
    ],
  );

  // 7. A pupil who has left (isActive false) and whose rows stay, in the class they named and in teaching groups: the judge reads active pupils
  // only, so two groups that share only the one who left do not share a pupil, nor does a group and a class, and a ramtid is read from the
  // pupils who are there (E3, g503 #503 L-1). The controls are the pupils who are there: a group and a class that share one still clash.
  add(
    plain({
      pupils: [
        { key: '7A:1', class: '7A', inactive: true },
        { key: '7A:2', class: '7A' },
        { key: '8B:1', class: '8B' },
        { key: '8B:2', class: '8B' },
      ],
      groups: [
        { key: 'G1', members: ['7A:1', '8B:1'] },
        { key: 'G2', members: ['7A:1', '8B:2'] },
        { key: 'G3', members: ['7A:2', '8B:2'] },
      ],
      frames: [{ grades: [7, 7], start: '08:00', end: '14:30' }],
      lessons: [
        lesson('P1', 'G1', 'Ma', 'T1', 1, '09:00', { room: 'R1' }),
        lesson('P2', 'G2', 'Sv', 'T2', 2, '09:00', { room: 'R2' }),
        lesson('P3', 'G3', 'Ma', 'T3', 3, '09:00', { room: 'R3' }),
        lesson('P4', '7A', 'Sv', 'T4', 4, '09:00', { room: 'R4' }),
      ],
      teachers: ['T1', 'T2', 'T3', 'T4'],
      rooms: ['R1', 'R2', 'R3', 'R4'],
    }),
    [
      to('P2', 1, '09:00'), // G1 and G2 share 7A:1 and nobody else, and 7A:1 has left: free
      to('P4', 1, '09:00'), // 7A and G1 share 7A:1 only: free
      to('P3', 2, '09:00'), // G3 and G2 share 8B:2, who is there: PUPILS
      to('P4', 3, '09:00'), // 7A and G3 share 7A:2, who is there: PUPILS
      to('P2', 1, '14:00'), // G2 is 7A:1 (left) and 8B:2: its years are 8's, and the ramtid is 7's: free
      to('P1', 1, '14:00'),
      to('P4', 4, '14:00'), // 7A itself: the ramtid is its own, ends 14:30: FRAME
    ],
  );

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
  /** The pupils of the world, by key, and its teaching groups (also in `classId`, so that a lesson's `class` finds either). */
  pupilId: Map<string, string>;
}

export async function plant(owner: Client, slug: string, world: World): Promise<Planted> {
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [slug, `${slug}-andra`]);
  const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${slug}`, slug])).id;
  // A läsår that starts on a Saturday, the active one, in the nine-year numbering the grade rules read.
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'probe domaren', '2026-08-15', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
      [school],
    )
  ).id;
  const person = async (label: string, role: string, adminProfile?: string, studentGroupId?: string, isActive = true) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "studentGroupId", "updatedAt") VALUES ($1, $2, $3, 'Domaren', $4, $5, $8, $6, $7, now()) RETURNING id`,
      [school, `${slug}-${label}@example.invalid`, label, role, authId, adminProfile ?? null, studentGroupId ?? null, isActive],
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
  // The pupils, each in a class of their own (the home class), and the teaching groups of pupils from several classes.
  const pupilId = new Map<string, string>();
  for (const pupil of world.pupils ?? []) pupilId.set(pupil.key, (await person(`p-${pupil.key.replace(':', '-')}`, 'STUDENT', undefined, classId.get(pupil.class), pupil.inactive !== true)).id);
  for (const group of world.groups ?? []) {
    const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, $3, 'TEACHING_GROUP', now()) RETURNING id`, [school, year, group.key])).id;
    classId.set(group.key, id);
    await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") SELECT $1, $2, s FROM unnest($3::uuid[]) s`, [school, id, group.members.map((key) => pupilId.get(key))]);
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
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "startDate", "endDate", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, false, $11::"LessonRecurrence", $12, $13, now()) RETURNING id`,
        [school, year, subjectId.get(lesson.subject), classId.get(lesson.class), teacherId.get(lesson.teacher), lesson.coTeacher ? teacherId.get(lesson.coTeacher) : null, lesson.room ? roomId.get(lesson.room) : null, lesson.day, lesson.start, end, lesson.recurrence ?? 'ALL_WEEKS', lesson.startDate ?? null, lesson.endDate ?? null],
      )
    ).id;
    lessonId.set(lesson.key, id);
    for (const extra of lesson.extra ?? []) await owner.query(`INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [school, id, classId.get(extra)]);
    for (const pupil of lesson.participants ?? []) await owner.query(`INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES ($1, $2, $3)`, [school, id, pupilId.get(pupil)]);
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
      `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate", "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, now())`,
      [school, year, classId.get(meal.class), meal.day, meal.start, meal.end, meal.startDate ?? null, meal.endDate ?? null],
    );
  }
  // A room lent to a second school of the huvudman, for the whole läsår: the judge reads the loan as another school's hold (OTHER_SCHOOL).
  if ((world.loans ?? []).length > 0) {
    const other = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`Andra ${slug}`, `${slug}-andra`])).id;
    for (const loan of world.loans!) {
      const local = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [other, `Lånad ${loan.room} ${loan.day} ${loan.start}`])).id;
      await owner.query(
        `INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate", status, "decidedAt", "localRoomId", "localRoomName", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'APPROVED', now(), $9, 'Lånad', now())`,
        [school, roomId.get(loan.room), other, loan.day, loan.start, loan.end, YEAR_FROM, YEAR_TO, local],
      );
    }
  }
  return { school, year, caller, lessonId, classId, teacherId, roomId, subjectId, slot, pupilId };
}

// ---------------------------------------------------------------------------------------------------------------------
// The three judges.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Two lessons of a world that the clash rule's group arm and its pupils arm both read as one class or one pupil twice: in the first
 * eighteen worlds, the same class; in the richer, a class or group of the one that takes in a pupil of the other (a class's pupils, a
 * group's members, an extra class's, the pupils named on the lesson).
 */
function sharesPupils(world: World, lesson: World['lessons'][number], other: World['lessons'][number]): boolean {
  if (other.class === lesson.class) return true;
  if (!world.pupils) return false;
  const of = (key: string): string[] => world.groups?.find((group) => group.key === key)?.members ?? world.pupils!.filter((pupil) => pupil.class === key).map((pupil) => pupil.key);
  const pupilsOf = (entry: World['lessons'][number]): Set<string> => new Set([...of(entry.class), ...(entry.extra ?? []).flatMap(of), ...(entry.participants ?? [])]);
  const mine = pupilsOf(lesson);
  return [...pupilsOf(other)].some((pupil) => mine.has(pupil)) || [lesson.class, ...(lesson.extra ?? [])].some((key) => key === other.class || (other.extra ?? []).includes(key));
}

const unify = (reason: string): string => (reason === 'PUPILS' ? 'GROUP' : reason);
/** The board's three rules, in the order boardCodeOf asks them, and after them the other schools' hold (SwapContext.boardRefusal): a swap's judge names the first of the four. */
const BOARD_RULES = ['FRAME', 'LUNCH', 'GRADE_RULE', 'OTHER_SCHOOL'];

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
    // After those: the richer worlds, with pupils, teaching groups, extra classes, windows of dates and a lent room (E3, g461 L-7).
    assert.equal(fixture.worlds.length, FIRST_RICH_WORLD, 'the first worlds are the eighteen');
    const rich = generateRichWorlds(RICH_WORLDS, RICH_DRAGS);
    fixture.worlds.push(...rich.worlds);
    fixture.cases.push(
      ...rich.worlds.flatMap((_world, index) =>
        rich.drags[index]!.map((drag, at) => ({ name: `r${index}-d${at}: ${drag.lesson} to day ${drag.day} at ${drag.start}`, world: FIRST_RICH_WORLD + index, drag, verdict: { ok: true, reasons: [] } })),
      ),
    );
    // After those: richer worlds again, from a seed of their own and with no pupil named on a lesson, so that the possible-times probe holds the
    // prune exact in them for the extra classes, the teaching groups, the windows and the lent rooms (`named: false`), and the edge worlds.
    assert.equal(fixture.worlds.length, FIRST_RICH_WORLD + RICH_WORLDS, 'the richer worlds are the fourteen');
    const unnamed = generateRichWorlds(UNNAMED_WORLDS, RICH_DRAGS, { seed: RICH_SEED + 1, named: false });
    fixture.worlds.push(...unnamed.worlds);
    fixture.cases.push(
      ...unnamed.worlds.flatMap((_world, index) =>
        unnamed.drags[index]!.map((drag, at) => ({ name: `u${index}-d${at}: ${drag.lesson} to day ${drag.day} at ${drag.start}`, world: FIRST_RICH_WORLD + RICH_WORLDS + index, drag, verdict: { ok: true, reasons: [] } })),
      ),
    );
    const edge = generateEdgeWorlds();
    fixture.worlds.push(...edge.worlds);
    fixture.cases.push(
      ...edge.worlds.flatMap((_world, index) =>
        edge.drags[index]!.map((drag, at) => ({ name: `e${index}-d${at}: ${drag.lesson} to day ${drag.day} at ${drag.start}`, world: FIRST_RICH_WORLD + RICH_WORLDS + UNNAMED_WORLDS + index, drag, verdict: { ok: true, reasons: [] } })),
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
              startDate: lesson.startDate ? new Date(`${lesson.startDate}T00:00:00.000Z`) : null,
              endDate: lesson.endDate ? new Date(`${lesson.endDate}T00:00:00.000Z`) : null,
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
                    : sharesPupils(world, lesson, other)),
            );
            assert.ok(named.length > 0, `${label}: ${refusal.reason} names ${JSON.stringify(refusal.params)}, which is no lesson of the world that shares it`);
            assert.equal(refusal.params['day'], day, `${label}: the day of the other lesson`);
          }

          // The three agree. The förläggning is a post's row: a class, a subject, a teacher and no extra class and no pupil named on it, so for a
          // lesson that has either (the richer worlds) it is asked and not held to the others: it is milder by what its row has no word for.
          const placementKnows = !lesson.extra?.length && !lesson.participants?.length;
          if (placementKnows) assert.equal(placement.ok, verdict.ok, `${label}: the förläggning's judge says ${placement.ok ? 'ok' : placement.reason}, the läsande frågan ${verdict.ok ? 'ok' : verdict.reasons.join(',')}`);
          // A swap moves a lesson only to where another lesson stands, so it has no question about the school day: for a Saturday or a Sunday
          // the hand edit and the förläggning say SCHOOL_DAY first, and the swap's judge is asked of the rest.
          const weekend = day > 5;
          if (weekend) assert.equal(verdict.reasons[0], 'SCHOOL_DAY', `${label}: a weekend day is the school day's no, first`);
          const swapSays = weekend ? new Set(verdict.reasons.filter((reason) => reason !== 'SCHOOL_DAY').map(unify)) : swapReasons;
          assert.equal(swapSays.size === 0, weekend ? swapReasons.size === 0 : verdict.ok, `${label}: a swap's judge says ${[...swapReasons].join(',') || 'ok'}, the läsande frågan ${verdict.ok ? 'ok' : verdict.reasons.join(',')}`);
          if (!verdict.ok) {
            if (placementKnows) assert.equal(placement.reason, verdict.reasons[0], `${label}: the heaviest reason is ${placement.reason} for the förläggning's judge and ${verdict.reasons[0]} for the läsande frågan`);
            // A swap's judge names the FIRST board rule a landing breaks (boardCodeOf); the hand edit names every one of them, so that an
            // exemption for the ramtid does not hide the lunch (Undantag med flit). The rest of the reasons are the same set.
            const firstBoard = verdict.reasons.find((reason) => BOARD_RULES.includes(reason));
            const theSwapsReasons = verdict.reasons.filter((reason) => reason !== 'SCHOOL_DAY' && (!BOARD_RULES.includes(reason) || reason === firstBoard));
            assert.deepEqual([...swapReasons].sort(), [...new Set(theSwapsReasons.map(unify))].sort(), `${label}: the reasons are not a swap's`);
          }
          for (const reason of verdict.ok ? [] : [...new Set(verdict.reasons)]) note(reason, true);
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
        await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`${SLUG}-${index}`, `${SLUG}-${index}-andra`]);
      }
      if (write) {
        fixture.cases = fixture.cases.map((one_case) => ({ ...one_case, verdict: real.get(one_case)! }));
        fixture.readme = [
          'The cases of the judge of a hand edit (src/calendar/lesson-judge.ts): each is a small world (worlds[n]), one lesson of it dragged to a new day and clock (drag, the lesson keeps its length), and the verdict the real judge gives it.',
          'WRITTEN BY scripts/test/probe-domaren.ts (DOMAREN_WRITE=1 npx ts-node --transpile-only scripts/test/probe-domaren.ts), which asks the läsande frågan, a swap\'s judge and the förläggning\'s judge of every case over real Postgres and requires them to agree before it writes. Do not edit by hand.',
          'verdict.reasons: every reason the hand edit finds, the heaviest first (TEACHER, ROOM, GROUP, PUPILS, AVAILABILITY, then FRAME, LUNCH, GRADE_RULE). web/lib/lesson-judge-mirror.contract.test.ts holds the web\'s mirror of the clash rule to them: never milder, for the rules it has.',
          'Every lesson of a world stands where it was laid, whether or not it stands against a frame, a meal or a closure (låt stå), and every meal is the school\'s own. Lessons are laid clear of one another (by the clash rule\'s measure, pupils and windows of dates included).',
          'The first eighteen worlds have a class and no pupil in it, one class to a lesson, no window of dates and no other school. The worlds from the nineteenth on (generateRichWorlds) carry pupils (`pupils`, each in the class they name), teaching groups (`groups`), lessons with an extra class (`extra`) or pupils named on them (`participants`), lessons and meals in a window of dates (`startDate`, `endDate`) and rooms a second school has borrowed (`loans`: OTHER_SCHOOL). A pupil who has left (`inactive`) keeps her rows and is not counted by the judge. A shared teacher\'s lessons at another school need a huvudman and are not here.',
        ];
        writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
        console.log(`     wrote ${fixture.cases.length} cases in ${fixture.worlds.length} worlds`);
        return;
      }
      assert.equal(differing.length, 0, `${differing.length} case(s) differ from the real judge (DOMAREN_WRITE=1 writes them back):\n${differing.join('\n')}`);
    });

    await check('(dj-c) the cases are not vacuous: every rule the three share is refused in some case, and many drags stand', async () => {
      for (const reason of ['TEACHER', 'ROOM', 'GROUP', 'PUPILS', 'AVAILABILITY', 'FRAME', 'LUNCH', 'GRADE_RULE', 'OTHER_SCHOOL', 'SCHOOL_DAY']) {
        assert.ok((seen.get(reason)?.refused ?? 0) >= 3, `${reason} is refused in ${seen.get(reason)?.refused ?? 0} cases`);
      }
      assert.ok(stood >= 20, `${stood} drags stand`);
      console.log(`     ${[...seen].map(([reason, count]) => `${reason} ${count.refused}`).join(', ')}; ${stood} stand of ${fixture.cases.length}`);
    });
  } finally {
    for (let index = 0; index < fixture.worlds.length; index++) await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`${SLUG}-${index}`, `${SLUG}-${index}-andra`]);
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
