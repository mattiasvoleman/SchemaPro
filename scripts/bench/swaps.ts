/**
 * Byten och flyttar's measurement: the swaps and chains of one lesson in a
 * högstadium test school, through the real service on the API's role and real
 * Postgres, and one real apply and its undo.
 *
 *   PROBE_OWNER_URL=postgresql://postgres:…@127.0.0.1:<port>/schemapro \
 *   DATABASE_URL=postgresql://app_authenticated:…@127.0.0.1:<port>/schemapro \
 *   npx ts-node --transpile-only scripts/bench/swaps.ts [lessons] [rounds]
 *
 * THE SCHOOL is the shape optimization-engine/benchmarks/hogstadium.py
 * measures the generator on: three years of six classes of 25 pupils, per class
 * and week matematik 3, svenska 3, engelska 2, NO 3, SO 3, idrott 2, bild 1,
 * musik 1, slöjd 1, hem- och konsumentkunskap 1 and teknik 1 in lessons of 60
 * minutes; per year two parallel blocks of five teaching groups of 30 (språkval
 * 2 × 60, elevens val 1 × 60) cut across the classes, each group with its own
 * teacher and room. Laid by a seeded randomised greedy so that nothing
 * double-books: this measures the search over a school with that many lessons
 * and that many parallel structures, not the quality of the timetable.
 *
 * WHAT IS MEASURED. Per lesson, the whole request as the API serves it in a
 * fresh transaction: the snapshot read, the cohorts, the search, the judging.
 * Every request is PAIRED with a fixed CPU calibration taken immediately
 * before it, because the host is shared and its load inflates latency and CPU
 * time alike (the calibration is ~constant work, so request / calibration is
 * the load-free figure). Then rounds of eight requests at once, the way eight
 * browsers ask one API instance.
 *
 * Not a CI check: wall-clock numbers on a shared host measure the host.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapsService } from '../../src/swaps/swaps.service';

const YEARS = [7, 8, 9];
const LETTERS = 'ABCDEF';
const PUPILS = 25;
const SLUG = 'bench-byten';
const HOURS = 7; // 08:00 .. 15:00 starts
const SEED = 20261107;

const POSTS: Array<{ name: string; code: string; perWeek: number; teachers: number; rooms: number | 'HOME' }> = [
  { name: 'Matematik', code: 'MA', perWeek: 3, teachers: 8, rooms: 'HOME' },
  { name: 'Svenska', code: 'SV', perWeek: 3, teachers: 8, rooms: 'HOME' },
  { name: 'Engelska', code: 'EN', perWeek: 2, teachers: 6, rooms: 'HOME' },
  { name: 'NO', code: 'NO', perWeek: 3, teachers: 8, rooms: 3 },
  { name: 'SO', code: 'SO', perWeek: 3, teachers: 8, rooms: 'HOME' },
  { name: 'Idrott och hälsa', code: 'IDH', perWeek: 2, teachers: 4, rooms: 2 },
  { name: 'Bild', code: 'BL', perWeek: 1, teachers: 2, rooms: 1 },
  { name: 'Musik', code: 'MU', perWeek: 1, teachers: 2, rooms: 1 },
  { name: 'Slöjd', code: 'SL', perWeek: 1, teachers: 3, rooms: 1 },
  { name: 'Hem- och konsumentkunskap', code: 'HKK', perWeek: 1, teachers: 2, rooms: 1 },
  { name: 'Teknik', code: 'TK', perWeek: 1, teachers: 2, rooms: 'HOME' },
];
const LANGUAGE_GROUPS = ['Spanska A', 'Spanska B', 'Tyska', 'Franska', 'Svenska/engelska'];
const ELECTIVE_GROUPS = ['Idrott', 'Bild', 'Musik', 'Matematik', 'Programmering'];

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** Milliseconds of CPU this process has used: user plus system. */
const cpuMs = (): number => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

/**
 * A fixed amount of CPU work, timed in wall clock and in CPU time: what the
 * host charges for it right now. On a quiet machine it takes a few tens of
 * milliseconds; on an oversubscribed one it takes whatever the queue does.
 */
function calibrate(): { wall: number; cpu: number } {
  const started = process.hrtime.bigint();
  const cpu = cpuMs();
  let x = 1;
  for (let i = 0; i < 4_000_000; i++) x = (x * 1664525 + 1013904223) % 4294967296;
  if (x === -1) console.log(x);
  return { wall: Number(process.hrtime.bigint() - started) / 1e6, cpu: cpuMs() - cpu };
}

interface Placed {
  id: string;
  classId: string;
  groupId: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
  day: number;
  start: number;
}

async function main() {
  const sample = Number(process.argv[2] ?? 40);
  const rounds = Number(process.argv[3] ?? 5);
  const next = random(SEED);
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  try {
    const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench Byten', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'bench', current_date - 30, current_date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;

    // --- people, groups, rooms, subjects --------------------------------------------------------
    const ids = async (sql: string, params: unknown[]): Promise<string[]> => (await owner.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
    const subjectIds = new Map<string, string>();
    for (const post of POSTS) {
      subjectIds.set(
        post.code,
        (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "maxLessonsPerDay", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [school, post.name, `B${post.code}`, post.perWeek >= 2 ? 1 : null])).id,
      );
    }
    for (const name of [...LANGUAGE_GROUPS, ...ELECTIVE_GROUPS]) {
      subjectIds.set(name, (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [school, name, `B${name.slice(0, 5).toUpperCase()}${subjectIds.size}`])).id);
    }
    const teacherCount = POSTS.reduce((sum, p) => sum + p.teachers, 0) + 2 * 5 * YEARS.length;
    const teacherIds = await ids(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       SELECT $1, 'bench-byten-t' || i || '@example.invalid', 'Lärare', 'Nr ' || lpad(i::text, 3, '0'), 'TEACHER', gen_random_uuid(), true, now() FROM generate_series(1, $2) i RETURNING id`,
      [school, teacherCount],
    );
    await owner.query(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") SELECT $1, u, $2, 100, now() FROM unnest($3::uuid[]) u`, [school, year, teacherIds]);
    await owner.query(`INSERT INTO "TeacherWorkRules" ("schoolId", "userId", "maxTeachingMinutesPerDay", "updatedAt") SELECT $1, u, 300, now() FROM unnest($2::uuid[]) u`, [school, teacherIds.slice(0, 14)]);
    const adminAuth = randomUUID();
    const admin = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES ($1, 'bench-byten-admin@example.invalid', 'Admin', 'Bench', 'SCHOOL_ADMIN', 'FULL', $2, true, now()) RETURNING id`,
        [school, adminAuth],
      )
    ).id;

    const classes: Array<{ id: string; name: string; grade: number; index: number; year: number }> = [];
    for (const grade of YEARS) {
      for (const letter of LETTERS) {
        const name = `${grade}${letter}`;
        const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [school, year, name, grade])).id;
        classes.push({ id, name, grade, index: classes.length, year: grade - 7 });
      }
    }
    const pupilsByClass = new Map<string, string[]>();
    for (const cls of classes) {
      pupilsByClass.set(
        cls.id,
        await ids(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
           SELECT $1, 'bench-byten-p' || $3 || '-' || i || '@example.invalid', 'Elev', $3 || ' ' || lpad(i::text, 2, '0'), 'STUDENT', $2, gen_random_uuid(), true, now() FROM generate_series(1, $4) i RETURNING id`,
          [school, cls.id, cls.name, PUPILS],
        ),
      );
    }

    // Rooms: a home room per class and the special rooms, then the blocks' rooms.
    const roomIds = new Map<string, string[]>();
    const makeRooms = async (key: string, count: number) => {
      roomIds.set(key, await ids(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") SELECT $1, $2 || ' ' || i, now() FROM generate_series(1, $3) i RETURNING id`, [school, key, count]));
    };
    await makeRooms('Klassrum', classes.length);
    for (const post of POSTS) if (post.rooms !== 'HOME') await makeRooms(`Sal ${post.code}`, post.rooms);
    await makeRooms('Blocksal', 10 * YEARS.length);

    // Teachers per subject, in the order they were made.
    let cursor = 0;
    const teachersOf = new Map<string, string[]>();
    for (const post of POSTS) {
      teachersOf.set(post.code, teacherIds.slice(cursor, cursor + post.teachers));
      cursor += post.teachers;
    }
    const blockTeachers = teacherIds.slice(cursor);

    // --- blocks: groups, members, posts ---------------------------------------------------------
    const blockGroups: Array<{ year: number; kind: 'LANG' | 'ELECT'; name: string; groupId: string; subjectId: string; teacherId: string; roomId: string; blockId: string; lessons: number }> = [];
    let blockTeacherIndex = 0;
    for (const grade of YEARS) {
      const yearClasses = classes.filter((c) => c.grade === grade);
      const pupils = yearClasses.flatMap((c) => pupilsByClass.get(c.id)!);
      const blocks = {
        LANG: (await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [school, year, `Språkval åk ${grade}`])).id,
        ELECT: (await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [school, year, `Elevens val åk ${grade}`])).id,
      };
      for (const kind of ['LANG', 'ELECT'] as const) {
        const names = kind === 'LANG' ? LANGUAGE_GROUPS : ELECTIVE_GROUPS;
        for (let g = 0; g < names.length; g++) {
          const groupId = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'TEACHING_GROUP', $4, now()) RETURNING id`, [school, year, `${kind === 'LANG' ? 'Språkval' : 'Elevens val'} ${grade} ${names[g]}`, grade])).id;
          // A pupil sits one språkval and one elevens val group, cut across the classes.
          const members = pupils.filter((_, p) => (kind === 'LANG' ? p % 5 : Math.floor(p / 5) % 5) === g);
          await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") SELECT $1, $2, s FROM unnest($3::uuid[]) s`, [school, groupId, members]);
          blockGroups.push({
            year: grade - 7,
            kind,
            name: names[g]!,
            groupId,
            subjectId: subjectIds.get(names[g]!)!,
            teacherId: blockTeachers[blockTeacherIndex++ % blockTeachers.length]!,
            roomId: roomIds.get('Blocksal')![blockGroups.length % roomIds.get('Blocksal')!.length]!,
            blockId: blocks[kind],
            lessons: kind === 'LANG' ? 2 : 1,
          });
        }
      }
    }

    // --- requirements -------------------------------------------------------------------------
    const homeRooms = roomIds.get('Klassrum')!;
    const reqRows: Array<[string, string, string, number, string | null]> = [];
    for (const cls of classes) {
      for (const post of POSTS) {
        const pool = teachersOf.get(post.code)!;
        reqRows.push([subjectIds.get(post.code)!, cls.id, pool[cls.index % pool.length]!, post.perWeek, null]);
      }
    }
    for (const group of blockGroups) reqRows.push([group.subjectId, group.groupId, group.teacherId, group.lessons, group.blockId]);
    await owner.query(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt")
       SELECT $1, $2, r.s, r.g, r.t, r.n, 60, r.b, now()
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::int[], $7::uuid[]) AS r(s, g, t, n, b)`,
      [school, year, reqRows.map((r) => r[0]), reqRows.map((r) => r[1]), reqRows.map((r) => r[2]), reqRows.map((r) => r[3]), reqRows.map((r) => r[4])],
    );

    // --- weekly rules ----------------------------------------------------------------------------
    await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt") VALUES ($1, 7, 9, '08:00', '16:00', now())`, [school]);
    const closed = new Set<string>();
    const closedRows: Array<[string, number]> = [];
    for (let i = 0; i < 20; i++) {
      const teacher = teacherIds[Math.floor(next() * teacherIds.length)]!;
      const day = 1 + Math.floor(next() * 5);
      if (closed.has(`${teacher}|${day}`)) continue;
      closed.add(`${teacher}|${day}`);
      closedRows.push([teacher, day]);
    }
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
       SELECT $1, 'TEACHER', c.u, c.d, '12:00', '13:00', 'UNAVAILABLE', now() FROM unnest($2::uuid[], $3::int[]) AS c(u, d)`,
      [school, closedRows.map((r) => r[0]), closedRows.map((r) => r[1])],
    );

    // --- the laid week -------------------------------------------------------------------------
    const busy = { teacher: new Set<string>(), room: new Set<string>(), cls: new Set<string>() };
    const free = (kind: keyof typeof busy, id: string, day: number, hour: number) => !busy[kind].has(`${id}|${day}|${hour}`);
    const take = (kind: keyof typeof busy, id: string, day: number, hour: number) => busy[kind].add(`${id}|${day}|${hour}`);
    const lessons: Placed[] = [];
    const shuffled = <T,>(list: T[]) => [...list].sort(() => next() - 0.5);
    const slots = shuffled(Array.from({ length: 5 * HOURS }, (_, i) => ({ day: 1 + Math.floor(i / HOURS), hour: i % HOURS })));

    // Blocks first: one slot where the whole year, its five teachers and its five rooms are free.
    for (const grade of YEARS) {
      const yearClasses = classes.filter((c) => c.grade === grade);
      for (const kind of ['LANG', 'LANG', 'ELECT'] as const) {
        const groups = blockGroups.filter((g) => g.year === grade - 7 && g.kind === kind);
        const slot = shuffled(slots).find(
          (s) =>
            yearClasses.every((c) => free('cls', c.id, s.day, s.hour)) &&
            groups.every((g) => free('teacher', g.teacherId, s.day, s.hour) && free('room', g.roomId, s.day, s.hour) && !closed.has(`${g.teacherId}|${s.day}`)),
        );
        if (!slot) throw new Error(`no slot for a block in year ${grade}`);
        for (const c of yearClasses) take('cls', c.id, slot.day, slot.hour);
        for (const g of groups) {
          take('teacher', g.teacherId, slot.day, slot.hour);
          take('room', g.roomId, slot.day, slot.hour);
          lessons.push({ id: randomUUID(), classId: groups[0]!.groupId, groupId: g.groupId, subjectId: g.subjectId, teacherId: g.teacherId, roomId: g.roomId, day: slot.day, start: slot.hour });
        }
      }
    }
    // The classes' own lessons, a few random restarts each.
    for (const cls of classes) {
      for (const post of POSTS) {
        const pool = teachersOf.get(post.code)!;
        const teacherId = pool[cls.index % pool.length]!;
        const roomPool = post.rooms === 'HOME' ? [homeRooms[cls.index]!] : roomIds.get(`Sal ${post.code}`)!;
        for (let n = 0; n < post.perWeek; n++) {
          let placed = false;
          for (const s of shuffled(slots)) {
            if (!free('cls', cls.id, s.day, s.hour) || !free('teacher', teacherId, s.day, s.hour) || closed.has(`${teacherId}|${s.day}`)) continue;
            // At most one lesson of a subject a day where the school asks it.
            if (post.perWeek >= 2 && lessons.some((l) => l.groupId === cls.id && l.subjectId === subjectIds.get(post.code) && l.day === s.day)) continue;
            const room = roomPool.find((r) => free('room', r, s.day, s.hour));
            if (!room) continue;
            take('cls', cls.id, s.day, s.hour);
            take('teacher', teacherId, s.day, s.hour);
            take('room', room, s.day, s.hour);
            lessons.push({ id: randomUUID(), classId: cls.id, groupId: cls.id, subjectId: subjectIds.get(post.code)!, teacherId, roomId: room, day: s.day, start: s.hour });
            placed = true;
            break;
          }
          if (!placed) throw new Error(`could not lay ${post.name} for ${cls.name}`);
        }
      }
    }
    await owner.query(
      `INSERT INTO "MasterLessons" (id, "schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt")
       SELECT l.id, $1, $2, l.s, l.g, l.t, l.r, l.d, make_time(8 + l.h, 0, 0), make_time(9 + l.h, 0, 0), true, now()
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::int[], $9::int[]) AS l(id, s, g, t, r, d, h)`,
      [school, year, lessons.map((l) => l.id), lessons.map((l) => l.subjectId), lessons.map((l) => l.groupId), lessons.map((l) => l.teacherId), lessons.map((l) => l.roomId), lessons.map((l) => l.day), lessons.map((l) => l.start)],
    );
    console.log(
      `school: ${classes.length} classes, ${classes.length * PUPILS} pupils, ${teacherIds.length} teachers, ${lessons.length} lessons ` +
        `(${lessons.filter((l) => l.groupId !== l.classId).length} in ${YEARS.length * 3} block cards), load average ${os.loadavg().map((v) => v.toFixed(0)).join('/')}`,
    );

    // --- the service, on the API's role ----------------------------------------------------------
    const realtime = { notifyMasterTimetableChanged: () => undefined };
    const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
    const masterLessons = new MasterLessonsService(api, realtime as never, notifications as never);
    const swaps = new SwapsService(api, masterLessons, new ScheduleVersionsService(api), realtime as never, notifications as never);
    const asAdmin: AuthenticatedUser = { authId: adminAuth, role: Role.SCHOOL_ADMIN, userId: admin, schoolId: school, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };

    // A spread of lessons: every class, every kind of subject, the block cards.
    const picked = lessons.filter((_, i) => i % Math.max(1, Math.floor(lessons.length / sample)) === 0).slice(0, sample);
    await swaps.suggest({ lessonId: picked[0]!.id }, asAdmin); // warm the pool and the JIT
    const timed: Array<{ ms: number; cpu: number; calibration: number; calibrationCpu: number; proposals: number; swaps: number; chains: number; truncated: boolean; candidates: number; judged: number; refused: number; unit: number; phases: { read: number; index: number; warm: number; search: number } }> = [];
    for (const lesson of picked) {
      const calibration = calibrate();
      const started = Date.now();
      const cpuStarted = cpuMs();
      const answer = await swaps.suggest({ lessonId: lesson.id }, asAdmin);
      timed.push({
        ms: Date.now() - started,
        cpu: cpuMs() - cpuStarted,
        calibration: calibration.wall,
        calibrationCpu: calibration.cpu,
        proposals: answer.proposals.length,
        swaps: answer.proposals.filter((p) => p.kind === 'SWAP').length,
        chains: answer.proposals.filter((p) => p.kind === 'CHAIN').length,
        truncated: answer.stats.truncated,
        candidates: answer.stats.candidates,
        judged: answer.stats.judged,
        refused: answer.stats.refused,
        unit: answer.unit.lessonIds.length,
        phases: answer.stats.phasesMs,
      });
    }
    const ms = timed.map((t) => t.ms);
    const ratio = timed.map((t) => t.ms / t.calibration);
    const cpuRatio = timed.map((t) => t.cpu / t.calibrationCpu);
    console.log(`\nsequential, ${timed.length} lessons, load average ${os.loadavg().map((v) => v.toFixed(0)).join('/')} (each request paired with a fixed CPU calibration taken just before it)`);
    console.log(`  calibration   median ${quantile(timed.map((t) => t.calibration), 0.5).toFixed(0)} ms wall, ${quantile(timed.map((t) => t.calibrationCpu), 0.5).toFixed(0)} ms CPU`);
    console.log(`  request       min ${Math.min(...ms)} ms   median ${quantile(ms, 0.5)} ms   p95 ${quantile(ms, 0.95)} ms   max ${Math.max(...ms)} ms   (CPU median ${quantile(timed.map((t) => t.cpu), 0.5).toFixed(0)} ms)`);
    console.log(`  request ÷ calibration   wall median ${quantile(ratio, 0.5).toFixed(2)} p95 ${quantile(ratio, 0.95).toFixed(2)};  CPU median ${quantile(cpuRatio, 0.5).toFixed(2)} p95 ${quantile(cpuRatio, 0.95).toFixed(2)}`);
    console.log(
      `  answers   proposals median ${quantile(timed.map((t) => t.proposals), 0.5)} (swaps ${quantile(timed.map((t) => t.swaps), 0.5)}, chains ${quantile(timed.map((t) => t.chains), 0.5)}), ` +
        `candidates median ${quantile(timed.map((t) => t.candidates), 0.5)}, judged median ${quantile(timed.map((t) => t.judged), 0.5)}, refused median ${quantile(timed.map((t) => t.refused), 0.5)}, ` +
        `truncated ${timed.filter((t) => t.truncated).length}, units of more than one lesson ${timed.filter((t) => t.unit > 1).length}`,
    );
    for (const phase of ['read', 'index', 'warm', 'search'] as const) {
      console.log(`  ${phase.padEnd(7)} median ${quantile(timed.map((t) => t.phases[phase]), 0.5)} ms   p95 ${quantile(timed.map((t) => t.phases[phase]), 0.95)} ms`);
    }
    const concurrent: number[] = [];
    const concurrentCalibration: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const eight = picked.slice(round * 8, round * 8 + 8);
      if (eight.length < 8) break;
      const calibration = calibrate();
      const started = Date.now();
      const answers = await Promise.all(
        eight.map(async (lesson) => {
          const at = Date.now();
          await swaps.suggest({ lessonId: lesson.id }, asAdmin);
          return Date.now() - at;
        }),
      );
      concurrent.push(...answers);
      concurrentCalibration.push(calibration.wall);
      console.log(`  round ${round + 1}: eight at once in ${Date.now() - started} ms (calibration ${calibration.wall.toFixed(0)} ms)`);
    }
    if (concurrent.length > 0) {
      console.log(`eight at once   request median ${quantile(concurrent, 0.5)} ms   p95 ${quantile(concurrent, 0.95)} ms   (${concurrent.length} requests)`);
    }

    // --- one real apply and its undo ----------------------------------------------------------------
    const target = picked.find((l) => l.groupId === l.classId)!;
    const offer = await swaps.suggest({ lessonId: target.id }, asAdmin);
    const swap = offer.proposals.find((p) => p.kind === 'SWAP');
    if (swap) {
      const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const body = (moves: typeof swap.moves) => ({
        lessonId: target.id,
        moves: moves.map((m) => ({
          lessonId: m.lessonId,
          from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
          to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
        })),
      });
      const before = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      const applied = await swaps.apply(body(swap.moves), asAdmin);
      const during = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      const logs = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [school])).n);
      const versions = await owner.query(`SELECT name, "lessonCount" FROM "ScheduleVersions" WHERE "schoolId" = $1`, [school]);
      await swaps.apply(body(applied.undo), asAdmin);
      const after = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      console.log(
        `\napply: ${swap.moves.length} lessons moved (${JSON.stringify(before.rows) === JSON.stringify(during.rows) ? 'NOTHING CHANGED' : 'changed'}), ` +
          `${logs} change-log rows, versions ${JSON.stringify(versions.rows)}, undo ${JSON.stringify(before.rows) === JSON.stringify(after.rows) ? 'restored every lesson' : 'DID NOT RESTORE'}`,
      );
    } else {
      console.log('\napply: no swap to apply for the sampled lesson');
    }
  } finally {
    // KEEP=1 leaves the school for a closer look (the next run replaces it).
    if (!process.env['KEEP']) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.onModuleDestroy?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
