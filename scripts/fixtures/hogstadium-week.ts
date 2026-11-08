/**
 * A högstadium test school laid for one week, planted by the owner in a few
 * statements: the shape optimization-engine/benchmarks/hogstadium.py measures
 * the generator on, as master lessons in a database (round 9, G1).
 *
 * Three years of classes of 25 pupils; per class and week matematik 3,
 * svenska 3, engelska 2, NO 3, SO 3, idrott 2, bild 1, musik 1, slöjd 1, hem-
 * och konsumentkunskap 1 and teknik 1, in lessons of 60 minutes; per year two
 * parallel blocks of five teaching groups of 30 (språkval 2 x 60, elevens val
 * 1 x 60) cut across the classes, each group with its own teacher and room.
 * Laid by a seeded randomised greedy so that nothing double-books and every
 * teacher's weekly closed hour is kept: it is a school with that many lessons
 * and that many parallel structures, not a good timetable. Deterministic.
 *
 * Used by scripts/bench/swaps.ts (the measurement) and
 * scripts/test/probe-swaps.ts (the CI probe).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

export const YEARS = [7, 8, 9];
const LETTERS = 'ABCDEF';
const PUPILS = 25;
const HOURS = 7; // 08:00 .. 15:00 starts
export const SEED = 20261107;

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

export interface Placed {
  id: string;
  classId: string;
  groupId: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
  day: number;
  start: number;
}

export interface SeededSchool {
  school: string;
  year: string;
  admin: string;
  adminAuth: string;
  classes: Array<{ id: string; name: string; grade: number; index: number; year: number }>;
  lessons: Placed[];
  teacherIds: string[];
  subjectIds: Map<string, string>;
  blockGroups: Array<{ year: number; kind: 'LANG' | 'ELECT'; name: string; groupId: string; subjectId: string; teacherId: string; roomId: string; blockId: string; lessons: number }>;
}

export async function seedHogstadium(
  owner: Client,
  options: { slug: string; letters?: string; pupils?: number; seed?: number },
): Promise<SeededSchool> {
  const LETTERS = options.letters ?? 'ABCDEF';
  const PUPILS = options.pupils ?? 25;
  const SLUG = options.slug;
  const next = random(options.seed ?? SEED);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
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
  return { school, year, admin, adminAuth, classes, lessons, teacherIds, subjectIds, blockGroups };
}
