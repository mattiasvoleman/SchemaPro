/**
 * Provet på korpusens veckor för Lägg det som går (E7a, Klart (a)): ta bort 5, 20 och 100 lektioner ur ett vittnesschema, låt påfyllningen lägga
 * tillbaka dem och skriv hur många som kom tillbaka och på vilken tid.
 *
 *   # veckorna, en gång (motorns korpus och vittnen läses, ingenting i optimization-engine/ skrivs):
 *   ENGINE_ROOT=<träd>/optimization-engine <venv>/bin/python scripts/bench/fill-corpus-export.py <katalog>
 *
 *   npx ts-node --transpile-only scripts/bench/fill-corpus.ts <katalog> [--weeks a,b] [--n 5,20,100] [--modes scatter,class] [--seeds 1,2,3]
 *                                                              [--orders LONGEST,FEWEST_ONCE,FEWEST] [--choices COST,EARLIEST] [--step 30] [--out fil.jsonl]
 *
 * VAD SOM KÖRS. `planFill` (src/board-fill/fill-plan.ts), samma funktion tjänsten kör, över en vecka ur korpusen: SwapData byggs ur motorns
 * begäran (krav, grupper, salar, tillgänglighet, ramtider, lunchfönster), vittnets lektioner med de salar motorn delade ut, och de luncher motorn
 * lade; elevernas listor över grupper blir en elev var (`cohorts` är de OLIKA listorna, så antalet elever per lista är okänt och de mjuka
 * kostnaderna för elevernas håltimmar väger varje lista lika). Domaren frågas inte (provet har ingen databas): beskärningens ord står, vilket är
 * ett övre tak för vad domaren släpper igenom. Vittnet är ett fullständigt schema, så alla borttagna lektioner KAN ligga kvar där de låg:
 * allt under N av N är påfyllningens förlust och ingenting annat.
 *
 * BORTTAGNINGEN. `scatter`: N slumpade lektioner ur hela skolan. `class`: hela klassveckor, en klass i taget, till N är nått och
 * sedan slumpas överskottet bort ur den sista.
 * En klass vecka är allt dess elever läser: klassens egna lektioner och de gruppers som delar en elev med den. Samma frö ger samma lektioner.
 *
 * Tiden skrivs med `uptime` bredvid: provet läser lasten, det skapar ingen.
 */
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFill, windowOfFrames, type FillBrick, type FillChoice, type FillOrder, type FillWorld } from '../../src/board-fill/fill-plan';
import type { RoomFact } from '../../src/calendar/possible-times';
import type { Rosters } from '../../src/optimization/room-eligibility';
import type { SwapConstraint, SwapData, SwapFrame, SwapGroup, SwapPost, SwapSitting } from '../../src/swaps/swap-snapshot';
import { SwapContext } from '../../src/swaps/swap-context';
import type { SwapLesson } from '../../src/swaps/swap-types';

interface Requirement {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId?: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  minutesBefore: number;
  minutesAfter: number;
  studentGroupSize: number;
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
  requiredRoomType?: string | null;
}

interface WeekDocument {
  name: string;
  request: {
    requirements: Requirement[];
    groups: Array<{ id: string; lunchHeadcount: number; minGradeLevel: number; maxGradeLevel: number }>;
    rooms: Array<{ id: string; capacity: number; type: string }>;
    constraints: Array<{ resourceKind: string; resourceId: string; dayOfWeek: number; startTime: string; endTime: string; kind: string }>;
    frameTimes: Array<{ minGradeLevel: number; maxGradeLevel: number; dayOfWeek: number | null; startTime: string; endTime: string }>;
    rules: { lunchStartTime: string; lunchEndTime: string; lunchMinutes: number };
  };
  lessons: Array<{ requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string }>;
  lunches: Array<{ studentGroupId: string; dayOfWeek: number; startTime: string; endTime: string }>;
  cohorts: string[][];
}

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The corpus week as the swap search holds a school: the witness's lessons standing, the pupils as one per distinct list of groups. */
export function worldOfWeek(doc: WeekDocument): { world: FillWorld; lessons: SwapLesson[]; requirementOf: Map<string, Requirement> } {
  const { request } = doc;
  const requirementOf = new Map(request.requirements.map((requirement) => [requirement.id, requirement]));
  const classIds = new Set(request.groups.map((group) => group.id));
  const seen = new Map<string, number>();
  const lessons: SwapLesson[] = doc.lessons.map((row) => {
    const requirement = requirementOf.get(row.requirementId)!;
    const nth = (seen.get(row.requirementId) ?? 0) + 1;
    seen.set(row.requirementId, nth);
    return {
      id: `${row.requirementId}#${nth}`,
      subjectId: requirement.subjectId,
      subjectName: requirement.subjectId.slice(0, 8),
      studentGroupId: requirement.studentGroupId,
      groupName: requirement.studentGroupId.slice(0, 8),
      teacherId: requirement.teacherId,
      coTeacherId: requirement.coTeacherId ?? null,
      roomId: row.roomId,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOf(row.startTime),
      endMinutes: minutesOf(row.endTime),
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      isLocked: false,
      isGenerated: true,
      extraGroupIds: [],
      studentIds: [],
    };
  });

  const groupIds = new Set<string>([...classIds, ...request.requirements.map((requirement) => requirement.studentGroupId)]);
  const gradeOfClass = new Map(request.groups.map((group) => [group.id, group.minGradeLevel]));
  const groups: SwapGroup[] = [...groupIds].map((id) => ({
    id,
    name: id.slice(0, 8),
    kind: classIds.has(id) ? 'CLASS' : 'TEACHING_GROUP',
    halfOfId: null,
    replacesSubjectId: null,
    gradeLevel: gradeOfClass.get(id) ?? null,
  }));

  const rosters: Rosters = {
    membersByGroup: new Map(),
    groupsByStudent: new Map(),
    homeMembers: [],
    homeClassOf: new Map(),
    gradeOfGroup: new Map(groups.map((group) => [group.id, group.gradeLevel])),
    halfPairs: [],
    unplacedShare: new Map(),
  };
  doc.cohorts.forEach((cohort, index) => {
    const pupil = `pupil-${index}`;
    const home = cohort.find((id) => classIds.has(id)) ?? null;
    rosters.groupsByStudent.set(pupil, new Set(cohort));
    for (const id of cohort) {
      const members = rosters.membersByGroup.get(id) ?? new Set<string>();
      members.add(pupil);
      rosters.membersByGroup.set(id, members);
    }
    rosters.homeMembers.push({ id: pupil, studentGroupId: home });
    rosters.homeClassOf.set(pupil, home);
  });

  const posts: SwapPost[] = request.requirements.map((requirement) => ({
    studentGroupId: requirement.studentGroupId,
    subjectId: requirement.subjectId,
    blockId: null,
    minutesBefore: requirement.minutesBefore,
    minutesAfter: requirement.minutesAfter,
    distribution: { maxLessonsPerDay: null, minDaysBetween: null },
  }));
  const constraints: SwapConstraint[] = request.constraints
    .filter((row) => row.kind === 'UNAVAILABLE' && row.resourceKind === 'TEACHER')
    .map((row) => ({
      resourceType: 'TEACHER',
      userId: row.resourceId,
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOf(row.startTime),
      endMinutes: minutesOf(row.endTime),
    }));
  const frames: SwapFrame[] = request.frameTimes.map((row) => ({ min: row.minGradeLevel, max: row.maxGradeLevel, day: row.dayOfWeek, start: minutesOf(row.startTime), end: minutesOf(row.endTime) }));
  const sittings: SwapSitting[] = doc.lunches.map((row) => ({ studentGroupId: row.studentGroupId, dayOfWeek: row.dayOfWeek, startMinutes: minutesOf(row.startTime), endMinutes: minutesOf(row.endTime) }));

  const data: SwapData = {
    schoolId: 'corpus-school',
    academicYearId: 'corpus-year',
    gradeNumbering: 'NIOARIG',
    basis: { kind: 'CURRENT' },
    lessons,
    posts,
    blocks: [],
    groups,
    rosters,
    constraints,
    frames,
    lunch: { start: minutesOf(request.rules.lunchStartTime), end: minutesOf(request.rules.lunchEndTime), minutes: request.rules.lunchMinutes },
    sittings,
    holds: [],
    teacherRules: new Map(),
    postLimited: new Set(),
  };
  const rooms: RoomFact[] = request.rooms.map((room) => ({ id: room.id, name: room.id.slice(0, 8), capacity: room.capacity, roomTypeId: room.type, minGradeLevel: null, maxGradeLevel: null, building: null }));
  const world: FillWorld = {
    data,
    rooms,
    wishes: [],
    needsOf: (lesson) => {
      const requirement = requirementOf.get(lesson.id.replace(/^fill:/, '').split('#')[0]!);
      if (!requirement) return null;
      return {
        studentGroupSize: requirement.studentGroupSize,
        minGradeLevel: requirement.minGradeLevel ?? null,
        maxGradeLevel: requirement.maxGradeLevel ?? null,
        requiredRoomTypeId: requirement.requiredRoomType ?? null,
      };
    },
    closedWeeks: null,
    sharedRooms: new Set(),
  };
  return { world, lessons, requirementOf };
}

/** A fixed pseudo-random generator: the same seed takes the same lessons out. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

/**
 * The lessons taken out: N of them, scattered over the school or a class's week at a time. A class's week is every lesson its pupils sit: its own
 * and those of the groups that share a pupil with it (the corpus's groups cut across the classes, so a class has few lessons of its own).
 */
export function removalOf(
  lessons: readonly SwapLesson[],
  classIds: ReadonlySet<string>,
  cohorts: readonly (readonly string[])[],
  count: number,
  mode: 'scatter' | 'class',
  seed: number,
): SwapLesson[] {
  const random = generator(seed);
  if (mode === 'scatter') return shuffled(lessons, random).slice(0, count);
  const groupsOfClass = new Map<string, Set<string>>();
  for (const cohort of cohorts) {
    for (const classId of cohort.filter((id) => classIds.has(id))) {
      const set = groupsOfClass.get(classId) ?? new Set<string>([classId]);
      for (const id of cohort) set.add(id);
      groupsOfClass.set(classId, set);
    }
  }
  const taken = new Map<string, SwapLesson>();
  for (const classId of shuffled([...groupsOfClass.keys()].sort(), random)) {
    const week = lessons.filter((lesson) => groupsOfClass.get(classId)!.has(lesson.studentGroupId) && !taken.has(lesson.id));
    const room = count - taken.size;
    for (const lesson of week.length <= room ? week : shuffled(week, random).slice(0, room)) taken.set(lesson.id, lesson);
    if (taken.size >= count) break;
  }
  return [...taken.values()];
}

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const uptime = (): string => execSync('uptime').toString().trim().replace(/^.*load averages?: /, 'load ');

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith('--')) throw new Error('Usage: fill-corpus.ts <katalog med veckor> [flaggor]');
  const only = flag('weeks', '').split(',').filter(Boolean);
  const sizes = flag('n', '5,20,100').split(',').map(Number);
  const modes = flag('modes', 'scatter,class').split(',') as Array<'scatter' | 'class'>;
  const seeds = flag('seeds', '1,2,3').split(',').map(Number);
  const orders = flag('orders', 'LONGEST,FEWEST_ONCE,FEWEST').split(',') as FillOrder[];
  const choices = flag('choices', 'COST').split(',') as FillChoice[];
  const step = Number(flag('step', '30'));
  const starts = flag('starts', 'STEP') as 'STEP' | 'POINTS';
  const out = flag('out', '');
  if (out) writeFileSync(out, '');

  const files = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  console.log(`# fyllprovet ${new Date().toISOString()} step=${step} starts=${starts} orders=${orders} choices=${choices} seeds=${seeds}`);
  console.log(['vecka', 'läge', 'N', 'frö', 'ordning', 'val', 'kom_tillbaka', 'tid_ms', 'världar_ms', 'prov_ms', 'kostnad_ms', 'elevhål_min', 'vittnets_elevhål_min_samma_lektioner', 'lärarhål_min', 'vittnets_lärarhål_min_samma_lektioner', 'last'].join('\t'));
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    if (only.length > 0 && !only.includes(name)) continue;
    const doc = JSON.parse(readFileSync(join(directory, file), 'utf8')) as WeekDocument;
    const { world, lessons } = worldOfWeek(doc);
    const classIds = new Set(doc.request.groups.map((group) => group.id));
    const window = windowOfFrames(world.data);
    for (const mode of modes) {
      for (const count of sizes) {
        for (const seed of seeds) {
          const removed = removalOf(lessons, classIds, doc.cohorts, count, mode, seed);
          const gone = new Set(removed.map((lesson) => lesson.id));
          const bricks: FillBrick[] = removed.map((lesson) => ({
            key: lesson.id,
            lesson: { ...lesson, id: `fill:${lesson.id}`, dayOfWeek: 1, startMinutes: 0, endMinutes: lesson.endMinutes - lesson.startMinutes, roomId: null, isLocked: false, isGenerated: false },
          }));
          const thinned: FillWorld = { ...world, data: { ...world.data, lessons: world.data.lessons.filter((lesson) => !gone.has(lesson.id)) } };
          for (const order of orders) {
            for (const choice of choices) {
              const load = uptime();
              const plan = await planFill(thinned, bricks, window, { order, choice, stepMinutes: step, starts });
              const finalLessons: SwapLesson[] = [
                ...thinned.data.lessons,
                ...plan.placed.map((entry) => ({ ...entry.brick.lesson, id: entry.brick.key, dayOfWeek: entry.dayOfWeek, startMinutes: entry.startMinutes, endMinutes: entry.endMinutes, roomId: entry.roomId })),
              ];
              // The same lessons where the witness has them: the figure to set the fill's against (a brick the fill did not lay is left out of both).
              const unlaid = new Set(plan.left.map((entry) => entry.brick.key));
              const witnessIdle = new SwapContext({ ...world.data, lessons: world.data.lessons.filter((lesson) => !unlaid.has(lesson.id)) }, {}).soft.baseline();
              const idle = new SwapContext({ ...world.data, lessons: finalLessons }, {}).soft.baseline();
              const row = [
                name, mode, removed.length, seed, order, choice, `${plan.placed.length}/${removed.length}`, plan.stats.elapsedMs, plan.stats.worldMs, plan.stats.probeMs, plan.stats.costMs,
                Math.round(idle.pupilIdleMinutes), Math.round(witnessIdle.pupilIdleMinutes), Math.round(idle.teacherIdleMinutes), Math.round(witnessIdle.teacherIdleMinutes), load,
              ];
              console.log(row.join('\t'));
              if (out) appendFileSync(out, `${JSON.stringify({ week: name, mode, n: removed.length, seed, order, choice, step, starts, placed: plan.placed.length, left: plan.left.map((entry) => [entry.brick.key, entry.reason]), stats: plan.stats, idle, witnessIdle, load })}\n`);
            }
          }
        }
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
