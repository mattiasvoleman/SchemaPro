/**
 * Ett schema som start (omgång 15, M9) through Nest's own injection, against Postgres, with the REAL engine on the wire: a
 * school of six classes laid by Generera, and then what Generera does when it is asked to start from a schedule that exists.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5791/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5791/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8941 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=240000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-schema-som-start-motor.ts
 *
 * Needs an engine of this tree at AI_ENGINE_URL. Not in CI (the Database job has no engine); the unit specs of
 * start-schedule.ts, start-sources.ts and optimization-proxy.start.spec.ts hold the same rules against stubs, and this shows
 * that they are what the real Generera does.
 *
 *   PROBE_ENGINE=older   runs only (sa-older): an engine from before `startLessons` (extract it with `git archive ed3f1db39
 *                        optimization-engine`), where Generera must answer as it always did and the run must say the engine
 *                        was older. Any other value, or none, runs everything else.
 *
 *   (sa-0)   the world is laid from nothing, as Generera has always laid it: the baseline;
 *   (sa-1)   an UNCHANGED week started from its own schedule gives that schedule back, every lesson held and none moved or
 *            laid, and writes the same lessons (the point of the phase: "lägger tillbaka det schemat för en oförändrad vecka");
 *   (sa-2)   a CHANGED week (a teacher is unavailable for a morning they teach in): the lessons that clash move and the rest
 *            are held, no teacher, class or room is in two places, and the counts are what the database shows, set against
 *            the same week laid from nothing with the schedule as a hint (what Generera did before), with the time of each;
 *   (sa-3)   the same from a SAVED VERSION of the year (the schedule as it was, after the week has changed);
 *   (sa-4)   the year after, rolled over (each class's successor, the old 7th grade leaving, a new 7th grade with no past):
 *            PREVIOUS_YEAR holds what it can map, counts what it cannot, and the answer is a timetable with no clash;
 *   (sa-5)   the job path: start() with a startFrom stores the run's start on the row, and the row is read back whitelisted;
 *   (sa-6)   a start that cannot be one is answered at the click, with a code, and no job row is written.
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share the world. The exit code is 1 for any FAIL.
 * A school of its own, planted and dropped by this probe, in the years 2095/96 and 2096/97.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-schema-som-start';
const OLDER = process.env['PROBE_ENGINE'] === 'older';

let failures = 0;
const timings: { label: string; ms: number }[] = [];

function summarise(error: unknown): string {
  if (error instanceof HttpException) return `${error.name} ${error.getStatus()} ${JSON.stringify(error.getResponse())}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${summarise(error).replace(/\n/g, '\n     ')}`);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  if (!process.env['AI_ENGINE_URL'] || !process.env['AI_ENGINE_API_KEY']) {
    console.error('AI_ENGINE_URL and AI_ENGINE_API_KEY name the real engine this probe asks.');
    process.exit(2);
  }
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  try {
    await sweep(owner);
    process.env['NODE_ENV'] ??= 'test';
    process.env['JWT_SECRET'] ??= 'probe-secret-not-used-by-anything-here';
    process.env['JWT_ISSUER'] ??= 'https://probe.invalid/auth/v1';
    const { EnvironmentVariables } = await import('../../src/config/env.validation');
    for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) {
      process.env[name] = 'off';
    }
    // AppModule first, as main.ts reads it (see probe-forlagda-poster.ts).
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(owner, app);
    } finally {
      await app.close();
    }
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  console.log('\nTimes (wall clock of the whole call: fetch, engine, write):');
  for (const { label, ms } of timings) console.log(`  ${label.padEnd(64)} ${(ms / 1000).toFixed(1).padStart(7)} s`);
  if (failures > 0) {
    console.error(`==> Schema-som-start probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Schema-som-start probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DROP TABLE IF EXISTS probe_schema_som_start_baseline`);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { OptimizationJobsService } = await import('../../src/optimization/optimization-jobs.service');
  const { ScheduleVersionsService } = await import('../../src/calendar/schedule-versions.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const jobs = resolve(OptimizationJobsService);
  const versions = resolve(ScheduleVersionsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // ---------------------------------------------------------------------------------------------------------------------
  // The school: three grades of two classes, ten subjects, eighteen teachers, gyms, a slöjd room and classrooms
  // ---------------------------------------------------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe schema som start', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const classNames = [
    ['VS 7A', 7],
    ['VS 7B', 7],
    ['VS 8A', 8],
    ['VS 8B', 8],
    ['VS 9A', 9],
    ['VS 9B', 9],
  ] as const;
  const group = async (yearId: string, name: string, grade: number, predecessorId: string | null = null) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "predecessorId", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, $5, now()) RETURNING id`,
        [s, yearId, name, grade, predecessorId],
      )
    ).id;
  const groups: { id: string; name: string; grade: number }[] = [];
  for (const [name, grade] of classNames) groups.push({ id: await group(year, name, grade), name, grade });

  const person = async (label: string, role: string, extra: { adminProfile?: string; groupId?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Start', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
  const teachers: string[] = [];
  for (let index = 0; index < 18; index += 1) teachers.push((await person(`t${String(index).padStart(2, '0')}`, 'TEACHER')).id);
  for (const [index, entry] of groups.entries()) {
    await person(`p${index}a`, 'STUDENT', { groupId: entry.id });
    await person(`p${index}b`, 'STUDENT', { groupId: entry.id });
  }
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'SCHEMALAGGARE',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;

  const roomType = async (name: string) => (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const gymType = await roomType('VS Gymnastiksal');
  const slojdType = await roomType('VS Slöjdsal');
  const classType = await roomType('VS Klassrum');
  const room = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, name, typeId])).id;
  await room('VS Gympasal 1', gymType);
  await room('VS Gympasal 2', gymType);
  await room('VS Slöjdsalen', slojdType);
  for (let index = 1; index <= 8; index += 1) await room(`VS Klassrum ${index}`, classType);

  // The school day is 08:00-16:00 for every grade, so that 30 lessons a week of 60 minutes are 75 % of a 40-hour week.
  await owner.query(
    `INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, 7, 9, NULL, '08:00', '16:00', now())`,
    [s],
  );
  // [name, lessons a week, room type].
  const subjectSpecs: [string, number, string][] = [
    ['Matematik', 4, classType],
    ['Svenska', 4, classType],
    ['Engelska', 3, classType],
    ['Naturorienterande', 4, classType],
    ['Samhällsorienterande', 4, classType],
    ['Idrott', 3, gymType],
    ['Bild', 2, classType],
    ['Musik', 2, classType],
    ['Slöjd', 2, slojdType],
    ['Språk', 2, classType],
  ];
  const subjects: { id: string; name: string; lessons: number }[] = [];
  for (const [name, lessons, typeId] of subjectSpecs) {
    subjects.push({
      id: (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, `VS ${name}`, typeId])).id,
      name,
      lessons,
    });
  }
  // One teacher a subject and grade: the same teacher teaches both classes of the grade, so the two classes' lessons meet.
  const teacherOf = (subjectIndex: number, grade: number): string => teachers[(subjectIndex * 3 + (grade - 7)) % teachers.length]!;
  const post = async (yearId: string, groupId: string, subjectId: string, teacherId: string, lessons: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 60, 'ALL_WEEKS', now()) RETURNING id`,
        [s, yearId, subjectId, groupId, teacherId, lessons],
      )
    ).id;
  for (const entry of groups) {
    for (const [subjectIndex, subject] of subjects.entries()) await post(year, entry.id, subject.id, teacherOf(subjectIndex, entry.grade), subject.lessons);
  }
  const demand = groups.length * subjects.reduce((sum, subject) => sum + subject.lessons, 0);

  // ---------------------------------------------------------------------------------------------------------------------
  // What the checks read
  // ---------------------------------------------------------------------------------------------------------------------
  interface MasterRow {
    groupId: string;
    subjectId: string;
    teacherId: string | null;
    roomId: string | null;
    day: number;
    start: string;
    end: string;
  }
  const masters = (yearId: string): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT "studentGroupId" AS "groupId", "subjectId", "teacherId", "roomId", "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, to_char("endTime", 'HH24:MI') AS "end"
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY "studentGroupId", "subjectId", "dayOfWeek", "startTime"`,
      [yearId],
    );
  const keyOf = (row: MasterRow): string => `${row.groupId}|${row.subjectId}|${row.day}|${row.start}|${row.end}`;
  /** Lessons of `after` that stand where a lesson of `before` stood (a multiset, as the engine's answer is counted). */
  const staying = (before: MasterRow[], after: MasterRow[]): number => {
    const had = new Map<string, number>();
    for (const row of before) had.set(keyOf(row), (had.get(keyOf(row)) ?? 0) + 1);
    let stayed = 0;
    for (const row of after) {
      const left = had.get(keyOf(row)) ?? 0;
      if (left > 0) {
        stayed += 1;
        had.set(keyOf(row), left - 1);
      }
    }
    return stayed;
  };
  const clashes = (rows: MasterRow[]): string[] => {
    const found: string[] = [];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.day !== b.day || !(a.start < b.end && b.start < a.end)) continue;
        if (a.groupId === b.groupId) found.push(`class ${a.groupId} d${a.day} ${a.start}`);
        if (a.teacherId !== null && a.teacherId === b.teacherId) found.push(`teacher ${a.teacherId} d${a.day} ${a.start}`);
        if (a.roomId !== null && a.roomId === b.roomId) found.push(`room ${a.roomId} d${a.day} ${a.start}`);
      }
    }
    return found;
  };
  const OK = ['OPTIMAL', 'FEASIBLE'];
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await work();
    } finally {
      timings.push({ label, ms: Date.now() - at });
    }
  };
  // The baseline, kept in a table of its own so that every run starts from the same grundschema.
  const keepBaseline = () => owner.query(`DROP TABLE IF EXISTS probe_schema_som_start_baseline; CREATE TABLE probe_schema_som_start_baseline AS SELECT * FROM "MasterLessons" WHERE "academicYearId" = '${year}'`);
  const restoreBaseline = async () => {
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`INSERT INTO "MasterLessons" SELECT * FROM probe_schema_som_start_baseline`);
  };
  let baseline: MasterRow[] = [];

  if (OLDER) {
    await check('(sa-older) an engine from before startLessons: Generera answers as it always did, and the run says the engine was older', async () => {
      const plain = await timed('older engine, from nothing', () => proxy.triggerScheduling(year, admin));
      assert.ok(OK.includes(plain.status), `from nothing: ${plain.status}`);
      const plainRows = await masters(year);
      assert.equal(plainRows.length, demand);
      assert.equal('startedFrom' in plain, false, 'a run that asked for no start says nothing of one');

      const asked = await timed('older engine, asked to start from CURRENT', () => proxy.triggerScheduling(year, admin, null, null, { source: 'CURRENT' }));
      assert.ok(OK.includes(asked.status), `asked to start: ${asked.status}`);
      assert.equal((await masters(year)).length, demand, 'the week is laid in full');
      assert.deepEqual(clashes(await masters(year)), []);
      assert.equal(asked.startedFrom?.engine, 'OLDER');
      assert.equal(asked.startedFrom?.held, null);
      assert.equal(asked.startedFrom?.used, 0);
    });
    return;
  }

  await check(`(sa-0) the world is laid from nothing, as Generera has always laid it: ${demand} lessons for ${groups.length} classes`, async () => {
    const answer = await timed('baseline: from nothing', () => proxy.triggerScheduling(year, admin));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status} ${JSON.stringify(answer.conflicts?.summary ?? '')}`);
    baseline = await masters(year);
    assert.equal(baseline.length, demand, `${baseline.length} lessons written for a demand of ${demand}`);
    assert.deepEqual(clashes(baseline), [], 'the baseline has a clash');
    assert.equal('startedFrom' in answer, false);
    await keepBaseline();
  });
  if (baseline.length === 0) return;

  await check('(sa-1) an unchanged week started from its own schedule gives the schedule back: every lesson held, none moved or laid', async () => {
    const answer = await timed('unchanged week, start CURRENT', () => proxy.triggerScheduling(year, admin, null, null, { source: 'CURRENT' }));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status}`);
    const after = await masters(year);
    assert.equal(after.length, demand);
    assert.deepEqual(answer.startedFrom && { engine: answer.startedFrom.engine, held: answer.startedFrom.held, moved: answer.startedFrom.moved, laid: answer.startedFrom.laid, used: answer.startedFrom.used }, {
      engine: 'USED',
      held: demand,
      moved: 0,
      laid: 0,
      used: demand,
    });
    assert.equal(staying(baseline, after), demand, 'the lessons written are not the schedule it started from');
    console.log(`     (${demand} of ${demand} held)`);
  });

  // Two teachers who teach on a weekday morning lose it: the lessons of theirs in the window must move.
  const busiest = await all<{ teacherId: string; day: number; n: string }>(
    `SELECT DISTINCT ON ("teacherId") "teacherId", "dayOfWeek" AS day, count(*) AS n FROM probe_schema_som_start_baseline
      WHERE "startTime" >= '08:00' AND "startTime" < '12:00' AND "teacherId" IS NOT NULL
      GROUP BY "teacherId", "dayOfWeek" ORDER BY "teacherId", count(*) DESC, "dayOfWeek"`,
  );
  const lost = busiest.sort((a, b) => Number(b.n) - Number(a.n) || a.teacherId.localeCompare(b.teacherId)).slice(0, 2);
  const inWindowOf = (rows: MasterRow[]) =>
    rows.filter((row) => lost.some((entry) => row.teacherId === entry.teacherId && row.day === entry.day && row.start >= '08:00' && row.start < '12:00')).length;
  const inWindow = inWindowOf(baseline);
  for (const entry of lost) {
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
       VALUES ($1, 'TEACHER', $2, $3, '08:00', '12:00', 'UNAVAILABLE', now())`,
      [s, entry.teacherId, entry.day],
    );
  }
  const lessonsInWindow = inWindowOf;

  let hintMoved = -1;
  await check(`(sa-2a) the changed week laid as Generera laid it before (from nothing, the schedule as a hint): the comparison`, async () => {
    await restoreBaseline();
    const answer = await timed('changed week, from nothing (as before)', () => proxy.triggerScheduling(year, admin));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status}`);
    const after = await masters(year);
    assert.equal(after.length, demand);
    hintMoved = demand - staying(baseline, after);
    console.log(`     (from nothing: ${hintMoved} of ${demand} lessons are not where they were)`);
  });

  await check(`(sa-2) the changed week started from its own schedule: the ${inWindow} lessons that clash move, the rest are held`, async () => {
    await restoreBaseline();
    const answer = await timed('changed week, start CURRENT', () => proxy.triggerScheduling(year, admin, null, null, { source: 'CURRENT' }));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status} ${JSON.stringify(answer.conflicts?.summary ?? '')}`);
    const after = await masters(year);
    assert.equal(after.length, demand);
    assert.deepEqual(clashes(after), [], 'a clash in the answer');
    assert.equal(lessonsInWindow(after), 0, 'the teacher teaches in the morning they are unavailable for');
    const started = answer.startedFrom!;
    assert.equal(started.engine, 'USED');
    assert.equal(started.used, demand);
    assert.equal(started.held, staying(baseline, after), 'the count of lessons held is not what the database shows');
    assert.equal(started.held! + started.moved! + started.laid!, demand);
    assert.ok(started.moved! >= inWindow, `${started.moved} moved for ${inWindow} lessons that clash`);
    assert.ok(started.held! >= demand - inWindow - Math.ceil(demand * 0.15), `only ${started.held} of ${demand} held for ${inWindow} that clash`);
    console.log(`     (held ${started.held}, moved ${started.moved}, laid ${started.laid}; from nothing ${hintMoved} were not where they were)`);
    // What the schedule is for is not fewer moved lessons than the hint gets (the disruption weight keeps most of them too): it is
    // that the lessons that stay are the ones the school had, in a fraction of the time. A loose bound on the consequences of
    // the lessons that had to move, so that a run that threw the schedule away would fail it.
    assert.ok(demand - started.held! <= inWindow * 3, `${demand - started.held!} lessons are not where they were, for ${inWindow} that clash`);
  });

  let versionId = '';
  await check('(sa-3) a SAVED VERSION of the year as it was, started from after the week has changed', async () => {
    await restoreBaseline();
    const saved = await versions.create(year, 'Före ändringen (probe)', admin);
    versionId = saved.id;
    const answer = await timed('changed week, start VERSION', () => proxy.triggerScheduling(year, admin, null, null, { source: 'VERSION', versionId }));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status}`);
    const after = await masters(year);
    assert.deepEqual(clashes(after), []);
    assert.equal(lessonsInWindow(after), 0);
    assert.equal(answer.startedFrom?.source, 'VERSION');
    assert.equal(answer.startedFrom?.versionName, 'Före ändringen (probe)');
    assert.equal(answer.startedFrom?.held, staying(baseline, after));
    assert.ok(answer.startedFrom!.moved! >= inWindow);
    console.log(`     (held ${answer.startedFrom!.held}, moved ${answer.startedFrom!.moved}, laid ${answer.startedFrom!.laid}; the version: ${answer.startedFrom!.offered} lessons)`);
  });

  await check('(sa-4) last year’s schedule under each class’s successor: the 7th grade leaves, a new 7th grade has no past', async () => {
    await restoreBaseline();
    await owner.query(`DELETE FROM "AvailabilityConstraints" WHERE "schoolId" = $1`, [s]);
    const year2 = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "predecessorId", "updatedAt") VALUES ($1, 'Probe 2096/97', '2096-08-13', '2097-06-09', false, $2, now()) RETURNING id`,
        [s, year],
      )
    ).id;
    // 7A -> 8A, 7B -> 8B, 8A -> 9A, 8B -> 9B; 9A and 9B leave; a new 7A and 7B continue nothing.
    const successors: { id: string; from: { id: string; grade: number; name: string } }[] = [];
    for (const entry of groups.filter((candidate) => candidate.grade < 9)) {
      const name = entry.name.replace(String(entry.grade), String(entry.grade + 1));
      successors.push({ id: await group(year2, name, entry.grade + 1, entry.id), from: entry });
    }
    const intake: { id: string; twin: { id: string; grade: number } }[] = [];
    for (const entry of groups.filter((candidate) => candidate.grade === 7)) {
      intake.push({ id: await group(year2, `${entry.name} (ny)`, 7), twin: entry });
    }
    for (const [subjectIndex, subject] of subjects.entries()) {
      for (const successor of successors) await post(year2, successor.id, subject.id, teacherOf(subjectIndex, successor.from.grade + 1), subject.lessons);
      for (const entry of intake) await post(year2, entry.id, subject.id, teacherOf(subjectIndex, 7), subject.lessons);
    }
    const demand2 = (successors.length + intake.length) * subjects.reduce((sum, subject) => sum + subject.lessons, 0);

    const answer = await timed('year after, start PREVIOUS_YEAR', () => proxy.triggerScheduling(year2, admin, null, null, { source: 'PREVIOUS_YEAR' }));
    assert.ok(OK.includes(answer.status), `Generera answered ${answer.status} ${JSON.stringify(answer.conflicts?.summary ?? '')}`);
    const after = await masters(year2);
    assert.equal(after.length, demand2, `${after.length} lessons for a demand of ${demand2}`);
    assert.deepEqual(clashes(after), [], 'a clash in the year after');
    const started = answer.startedFrom!;
    assert.equal(started.source, 'PREVIOUS_YEAR');
    assert.equal(started.engine, 'USED');
    const mappable = successors.length * subjects.reduce((sum, subject) => sum + subject.lessons, 0);
    assert.equal(started.used, mappable, `${started.used} given for ${mappable} lessons of classes that have a successor`);
    // The 9th grade left: its lessons are counted, not given.
    assert.equal(started.dropped.NO_SUCCESSOR, 2 * subjects.reduce((sum, subject) => sum + subject.lessons, 0));
    assert.equal(started.held! + started.moved! + started.laid!, demand2);
    // The new 7th grade has no past: its lessons are laid, and everything the successors had is held or moved.
    assert.ok(started.laid! >= intake.length * subjects.reduce((sum, subject) => sum + subject.lessons, 0));
    console.log(`     (held ${started.held}, moved ${started.moved}, laid ${started.laid}; ${started.dropped.NO_SUCCESSOR} of last year's lessons had no successor)`);
  });

  await check('(sa-5) the job path: the run stores its start on the row, and the row reads back whitelisted', async () => {
    await restoreBaseline();
    const { jobId } = await jobs.start(year, admin, undefined, undefined, { source: 'CURRENT' });
    let view = await jobs.get(jobId, admin);
    for (let waited = 0; (view.status === 'PENDING' || view.status === 'RUNNING') && waited < 300; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      view = await jobs.get(jobId, admin);
    }
    assert.equal(view.status, 'SUCCEEDED', `the run ended ${view.status} ${view.error ?? ''}`);
    assert.ok(view.startedFrom, 'the row says nothing of its start');
    assert.equal(view.startedFrom!.source, 'CURRENT');
    assert.equal(view.startedFrom!.held, demand);
    const raw = await one<{ startedFrom: Record<string, unknown> }>(`SELECT "startedFrom" FROM "OptimizationJobs" WHERE id = $1`, [jobId]);
    assert.deepEqual(Object.keys(raw.startedFrom).sort(), ['dropped', 'engine', 'held', 'laid', 'moved', 'offered', 'source', 'used', 'versionName']);
    const plain = await jobs.start(year, admin);
    let second = await jobs.get(plain.jobId, admin);
    for (let waited = 0; (second.status === 'PENDING' || second.status === 'RUNNING') && waited < 300; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      second = await jobs.get(plain.jobId, admin);
    }
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(second.startedFrom, null, 'a run that asked for no start says none');
  });

  await check('(sa-6) a start that cannot be one is answered at the click with its code, and no job row is written', async () => {
    const rowsBefore = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "OptimizationJobs" WHERE "academicYearId" = $1`, [year])).n);
    const codeOf = async (startFrom: { source: 'VERSION' | 'PREVIOUS_YEAR' | 'CURRENT'; versionId?: string }) => {
      const error = await jobs.start(year, admin, undefined, undefined, startFrom).then(() => null, (thrown: unknown) => thrown);
      assert.ok(error instanceof HttpException, 'it was accepted');
      return { status: error.getStatus(), code: (error.getResponse() as { code?: string }).code };
    };
    assert.deepEqual(await codeOf({ source: 'VERSION', versionId: randomUUID() }), { status: 404, code: 'START_VERSION_NOT_FOUND' });
    assert.deepEqual(await codeOf({ source: 'PREVIOUS_YEAR' }), { status: 409, code: 'START_NO_PREVIOUS_YEAR' });
    assert.equal(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "OptimizationJobs" WHERE "academicYearId" = $1`, [year])).n), rowsBefore);
  });
}

main().then(
  () => {
    process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    console.error(`FAIL ${summarise(error)}`);
    process.exit(1);
  },
);
