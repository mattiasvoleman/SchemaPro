/**
 * A class's meal holds weeks (20270209090000) against a real database, as the API role under RLS,
 * through the real CalendarService, the publication's snapshot, the swap board's reader and
 * LunchSittingsService.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-maltid-per-termin.ts
 *
 * The RLS sections 475-479 prove the constraints, the grants and what each role sees, and the
 * jest specs the readers with the database faked; this is what the adapter makes of them: a
 * `@db.Date` column read back as a Date and compared as a day, a Time column beside it, the
 * school's own time zone across both changes of summer time, and a write that meets the
 * exclusion constraint as a 409 and never a 500. In a school of its own (<tag>-mtermin), removed
 * whole before and after.
 *
 * Nothing writes a date yet (the API refuses one: the engine does not plan per part until a
 * later release), so the dated rows are planted as the owner, which is what a later release's
 * writers will have written. The läsår starts on a Saturday, as production's does.
 *
 *   (mt-a)  THE ORACLE, over the calendar: every date of the läsår, one by one. Two classes, Mondays
 *           and Wednesdays; 7A eats at 11:00 in the autumn and 11:30 from 11 January (nothing in the
 *           three weeks between), 7B at 10:30 with one week at 11:00 in October, and a control on a
 *           Wednesday with no dates. Published through CalendarService; for each date and class the
 *           meal there is, or the lack of one, is what the rows say, and the instant is the
 *           school's clock (11:00 in Stockholm, summer or winter);
 *   (mt-b)  the publication's snapshot keeps the weeks (two meals of one class and weekday), reads
 *           them back with their dates, and a calendar materialised from the snapshot alone is the
 *           calendar the live rows made, instant for instant;
 *   (mt-c)  a meal placed by hand takes the day over: both parts of 7A's Monday go and the one meal
 *           of the whole läsår stands, placed again it is updated where it is (the same id);
 *   (mt-d)  two placements that meet at the constraint: the one that lost is 409 WRITE_CONFLICT
 *           (held open as the owner, then released), nothing half written;
 *   (mt-e)  the swap board's reader: the meal for a date is the one that holds it and none in the
 *           weeks between, the template holds every meal of the weekday, and a lesson is held to
 *           the meals of its own weeks.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarService } from '../../src/calendar/calendar.service';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { readPublishedSittings, snapshotSittings } from '../../src/publication/published-grundschema';
import { LunchSittingsService } from '../../src/resources/lunch-sittings.service';
import { boardCodeOf, readBoardFacts, sittingKey } from '../../src/swaps/board-rules';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const TZ = 'Europe/Stockholm';
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const addDays = (iso: string, by: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** An instant's minutes after midnight on the school's own clock. */
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const stockholmMinutes = (instant: Date): number => {
  const [h, m] = clockFormat.format(instant).split(':').map(Number);
  return h! * 60 + m!;
};

const YEAR_START = '2026-08-15'; // a Saturday, as production's läsår
const YEAR_END = '2027-06-11';

/** What the probe planted: a class, its weekday, the weeks (null for the läsår's bound) and the start of the meal. */
interface Planted {
  group: 'A' | 'B';
  day: number;
  from: string | null;
  to: string | null;
  start: string;
}
const PLANT: Planted[] = [
  { group: 'A', day: 1, from: null, to: '2026-12-20', start: '11:00' },
  { group: 'A', day: 1, from: '2027-01-11', to: null, start: '11:30' },
  { group: 'A', day: 3, from: null, to: null, start: '11:00' },
  { group: 'B', day: 1, from: null, to: '2026-10-04', start: '10:30' },
  { group: 'B', day: 1, from: '2026-10-05', to: '2026-10-11', start: '11:00' },
  { group: 'B', day: 1, from: '2026-10-12', to: null, start: '10:30' },
  // A meal on the last day of its stretch, a Sunday: the end of a window is a day it holds.
  { group: 'A', day: 7, from: '2026-10-05', to: '2026-10-11', start: '11:00' },
];

/** The meal a class has on a date, from what was planted: written out here, apart from the readers. */
function expectedStart(group: 'A' | 'B', date: string): string | null {
  const day = isoWeekday(date);
  const held = PLANT.filter((row) => row.group === group && row.day === day && (row.from === null || row.from <= date) && (row.to === null || date <= row.to));
  assert.ok(held.length <= 1, `the plant has ${held.length} meals of ${group} on ${date}`);
  return held[0]?.start ?? null;
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const slug = `${randomUUID().slice(0, 8)}-mtermin`;

  const sweep = async () => {
    await owner.$executeRaw`DELETE FROM "Schools" WHERE slug LIKE '%-mtermin'`;
  };
  await sweep();
  try {
    await checks(owner, api, slug);
  } finally {
    await sweep().catch((error) => console.error('cleanup:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nmaltid-per-termin probe passed.');
}

async function checks(owner: PrismaClient, api: PrismaService, slug: string): Promise<void> {
  const school = await owner.school.create({ data: { name: 'Måltid per termin', slug, timezone: TZ } });
  const s = school.id;
  const year = await owner.academicYear.create({
    data: { schoolId: s, name: 'Termin', startDate: utc(YEAR_START), endDate: utc(YEAR_END), isActive: true, gradeNumbering: 'NIOARIG' },
  });
  const klass = (name: string) => owner.studentGroup.create({ data: { schoolId: s, academicYearId: year.id, name, kind: 'CLASS', gradeLevel: 7 } });
  const classes = { A: await klass('7A'), B: await klass('7B') };
  const person = (role: 'SCHOOL_ADMIN' | 'TEACHER', key: string) =>
    owner.user.create({ data: { schoolId: s, authId: randomUUID(), role, firstName: key, lastName: 'Probe', email: `${key}@${slug}.test`, ...(role === 'SCHOOL_ADMIN' ? { adminProfile: 'FULL' as const } : {}) } });
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const asAdmin: AuthenticatedUser = { authId: admin.authId!, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, adminProfile: 'FULL' };
  await owner.lunchSetting.create({ data: { schoolId: s, lunchEnabled: true, lunchStartTime: time('10:30'), lunchEndTime: time('13:00'), lunchMinutes: 30 } });

  const plant = async (rows: Planted[]) => {
    for (const row of rows) {
      await owner.lunchSitting.create({
        data: {
          schoolId: s,
          academicYearId: year.id,
          studentGroupId: classes[row.group].id,
          dayOfWeek: row.day,
          startTime: time(row.start),
          endTime: time(row.start === '10:30' ? '11:00' : row.start === '11:00' ? '11:30' : '12:00'),
          startDate: row.from === null ? null : utc(row.from),
          endDate: row.to === null ? null : utc(row.to),
          isGenerated: true,
        },
      });
    }
  };
  await plant(PLANT);
  // The calendar is materialised from a master timetable, and refuses a year with none: one lesson, on a Tuesday, for the classes to share.
  const subject = await owner.subject.create({ data: { schoolId: s, name: 'Matematik' } });
  await owner.masterLesson.create({
    data: { schoolId: s, academicYearId: year.id, subjectId: subject.id, studentGroupId: classes.A.id, dayOfWeek: 2, startTime: time('08:00'), endTime: time('09:00') },
  });

  const calendar = new CalendarService(api);
  const dto = { academicYearId: year.id, fromDate: YEAR_START, toDate: YEAR_END };
  const dates: string[] = [];
  for (let d = YEAR_START; d <= YEAR_END; d = addDays(d, 1)) dates.push(d);

  /** The school's own clock: `hhmm` on each date as an instant, read from the database's own zone rules. */
  const instants = async (): Promise<Map<string, number>> => {
    const rows = await owner.$queryRaw<Array<{ d: string; t: string; at: Date }>>`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS d, t, ((d::date + t::time) AT TIME ZONE ${TZ}) AS at
        FROM generate_series(${YEAR_START}::date, ${YEAR_END}::date, interval '1 day') d, unnest(ARRAY['10:30', '11:00', '11:30']) t`;
    return new Map(rows.map((row) => [`${row.d}|${row.t}`, row.at.getTime()]));
  };

  /** The calendar's meals as rows: `<group>|<date>` -> the instant it starts. */
  const calendarMeals = async (): Promise<Map<string, number>> => {
    const rows = await owner.calendarLunch.findMany({ where: { schoolId: s }, select: { studentGroupId: true, date: true, startsAt: true, endsAt: true } });
    const byId = new Map<string, 'A' | 'B'>([[classes.A.id, 'A'], [classes.B.id, 'B']]);
    for (const row of rows) assert.equal(row.endsAt.getTime() - row.startsAt.getTime(), 30 * 60_000, 'a meal of half an hour');
    return new Map(rows.map((row) => [`${byId.get(row.studentGroupId)}|${row.date.toISOString().slice(0, 10)}`, row.startsAt.getTime()]));
  };

  /** THE ORACLE: every date of the läsår, one by one, for both classes. */
  const oracle = async (meals: Map<string, number>, label: string): Promise<{ dated: number; lacking: number }> => {
    const clock = await instants();
    let dated = 0;
    let lacking = 0;
    for (const date of dates) {
      for (const group of ['A', 'B'] as const) {
        const start = expectedStart(group, date);
        const got = meals.get(`${group}|${date}`);
        if (start === null) {
          assert.equal(got, undefined, `${label}: ${group} has a meal on ${date} that no sitting holds`);
          if ([1, 3].includes(isoWeekday(date))) lacking += 1;
        } else {
          assert.equal(got, clock.get(`${date}|${start}`), `${label}: ${group} on ${date} eats at ${start} in the school's time`);
          dated += 1;
        }
      }
    }
    assert.equal(meals.size, dated, `${label}: no meal beyond the ones counted`);
    return { dated, lacking };
  };

  await check('(mt-a) the oracle: every date of the läsår has the meal the weeks say, and none where no sitting holds the date', async () => {
    const result = await calendar.publish(dto, asAdmin);
    assert.ok(result.created > 0, 'publish laid the lesson');
    const meals = await calendarMeals();
    assert.ok(meals.size > 0, 'publish laid meals');
    const { dated, lacking } = await oracle(meals, 'publish');
    // 7A: Mondays of the autumn (to 20 Dec) and from 11 Jan, plus every Wednesday; 7B: every Monday. The three weeks between hold no Monday meal for 7A.
    assert.equal(dated, 127, `a läsår of meals: 7A 18 autumn + 22 spring Mondays + 43 Wednesdays, 7B 43 Mondays, and one Sunday`);
    assert.notEqual(meals.get('A|2026-10-11'), undefined, 'the Sunday that ends its stretch has its meal');
    assert.equal(meals.get('A|2026-10-18'), undefined, 'and the next Sunday has none');
    assert.ok(lacking >= 3, `the weeks between hold no meal (${lacking} school days without one)`);
    for (const date of ['2026-12-21', '2026-12-28', '2027-01-04']) assert.equal(meals.get(`A|${date}`), undefined, `7A eats nothing on ${date}`);
    assert.notEqual(meals.get('A|2026-12-14'), undefined);
    assert.notEqual(meals.get('A|2027-01-11'), undefined);
    // 7B's one week at another time, to the day.
    const clock = await instants();
    assert.equal(meals.get('B|2026-10-05'), clock.get('2026-10-05|11:00'));
    assert.equal(meals.get('B|2026-10-12'), clock.get('2026-10-12|10:30'));
    assert.equal(meals.get('B|2026-09-28'), clock.get('2026-09-28|10:30'));
  });

  await check('(mt-a) the summer time changes the instant and not the clock: 11:00 on 5 October and on 4 January are different hours in UTC', async () => {
    const meals = await calendarMeals();
    const summer = new Date(meals.get('A|2026-10-05') ?? NaN);
    const winter = new Date(meals.get('A|2026-12-14') ?? NaN);
    // 5 October is summer time in Stockholm (09:00Z for 11:00), 14 December winter time (10:00Z).
    assert.deepEqual([summer.getUTCHours(), summer.getUTCMinutes()], [9, 0]);
    assert.deepEqual([winter.getUTCHours(), winter.getUTCMinutes()], [10, 0]);
  });

  const publication = await owner.timetablePublication.create({
    data: { schoolId: s, academicYearId: year.id, kind: 'BASELINE', outcome: 'PUBLISHED', publishMode: 'DRAFT', validFrom: utc(YEAR_START), validTo: utc(YEAR_END), lessonCount: 0 },
  });

  await check('(mt-b) the snapshot keeps the weeks: both meals of a class and weekday, read back with their dates', async () => {
    const written = await api.withRls(asAdmin, (tx) => snapshotSittings(tx, { id: publication.id, schoolId: s, academicYearId: year.id }));
    assert.equal(written, PLANT.length);
    const read = await api.withRls(asAdmin, (tx) => readPublishedSittings(tx, publication.id));
    assert.equal(read.length, PLANT.length);
    const mondays = read.filter((row) => row.studentGroupId === classes.A.id && row.dayOfWeek === 1);
    assert.deepEqual(
      mondays.map((row) => [row.startDate?.toISOString().slice(0, 10) ?? null, row.endDate?.toISOString().slice(0, 10) ?? null]),
      [[null, '2026-12-20'], ['2027-01-11', null]],
      'the autumn first (a meal with no start date sorts first), then the spring',
    );
  });

  await check('(mt-b) a calendar materialised from the snapshot alone is the calendar the live rows made, instant for instant', async () => {
    const live = await calendarMeals();
    await owner.calendarLunch.deleteMany({ where: { schoolId: s } });
    await api.withRls(asAdmin, async (tx) => {
      const sittings = await readPublishedSittings(tx, publication.id);
      await calendar.materialise(tx, s, dto, { sittings });
    });
    const refilled = await calendarMeals();
    assert.equal(refilled.size, live.size);
    for (const [key, at] of live) assert.equal(refilled.get(key), at, `${key} is the same instant`);
    await oracle(refilled, 'refill');
  });

  await check('(mt-c) a meal placed by hand takes the day over: the two parts go, and the one of the whole läsår is updated where it stands', async () => {
    const service = new LunchSittingsService(api);
    const body = { academicYearId: year.id, studentGroupId: classes.A.id, dayOfWeek: 1 };
    const first = await service.place({ ...body, startTime: '12:00' }, asAdmin);
    assert.deepEqual([first.startDate, first.endDate, first.startTime, first.isGenerated], [null, null, '12:00', false]);
    const rows = await owner.lunchSitting.findMany({ where: { studentGroupId: classes.A.id, dayOfWeek: 1 } });
    assert.equal(rows.length, 1, 'the autumn and the spring are gone');
    const again = await service.place({ ...body, startTime: '12:30' }, asAdmin);
    assert.equal(again.id, first.id, 'a meal of the whole läsår is taken over in place');
    assert.equal(again.startTime, '12:30');
    assert.equal((await owner.lunchSitting.count({ where: { studentGroupId: classes.A.id, dayOfWeek: 1 } })), 1);
  });

  await check('(mt-d) two placements that meet at the constraint: the one that lost is a 409 and nothing is half written', async () => {
    const service = new LunchSittingsService(api);
    const body = { academicYearId: year.id, studentGroupId: classes.B.id, dayOfWeek: 2, startTime: '11:30' };
    // The owner holds a meal of 7B's Tuesday that is not committed: the placement finds none, creates its own, and waits on the other.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let planted!: () => void;
    const holding = new Promise<void>((resolve) => { planted = resolve; });
    const holder = owner.$transaction(
      async (tx) => {
        await tx.lunchSitting.create({
          data: { schoolId: s, academicYearId: year.id, studentGroupId: classes.B.id, dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30'), isGenerated: true },
        });
        planted();
        await released;
      },
      { timeout: 30_000 },
    );
    await holding;
    const placing = service.place(body, asAdmin);
    const outcome = placing.then(() => 'placed' as const, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 800));
    release();
    await holder;
    const result = await outcome;
    assert.ok(result instanceof ConflictException, `a 409 (got ${result instanceof Error ? result.message : String(result)})`);
    assert.equal(((result as ConflictException).getResponse() as { code?: string }).code, 'WRITE_CONFLICT');
    const rows = await owner.lunchSitting.findMany({ where: { studentGroupId: classes.B.id, dayOfWeek: 2 } });
    assert.equal(rows.length, 1, 'one meal of 7B on Tuesday');
    // Trying again finds the meal and takes it over.
    const retried = await service.place(body, asAdmin);
    assert.equal(retried.startTime, '11:30');
    assert.equal(retried.id, rows[0]!.id);
  });

  await check('(mt-e) the swap board reads the meal that holds the date, none in the weeks between, and every meal for the template', async () => {
    // Restore 7A's two Mondays (mt-c replaced them) as the owner, and clear the calendar's meals so that the board falls back on the sittings.
    await owner.calendarLunch.deleteMany({ where: { schoolId: s } });
    await owner.lunchSitting.deleteMany({ where: { studentGroupId: classes.A.id, dayOfWeek: 1 } });
    await plant(PLANT.filter((row) => row.group === 'A' && row.day === 1));
    const basis = { kind: 'CURRENT' } as never;
    const read = (date?: string) =>
      api.withRls(asAdmin, (tx) =>
        readBoardFacts(tx, {
          academicYearId: year.id,
          schoolId: s,
          gradeNumbering: 'NIOARIG',
          basis,
          groupIds: [classes.A.id],
          weekday: 1,
          ...(date ? { date: { day: date, localMinutes: stockholmMinutes } } : {}),
        }),
      );
    const key = sittingKey(classes.A.id, 1);
    const autumn = await read('2026-10-05');
    assert.deepEqual(autumn.sittings.get(key)?.map((m) => m.startMinutes), [11 * 60]);
    const spring = await read('2027-02-01');
    assert.deepEqual(spring.sittings.get(key)?.map((m) => m.startMinutes), [11 * 60 + 30]);
    const between = await read('2026-12-28');
    assert.equal(between.sittings.get(key), undefined, 'no meal in the weeks between');
    const template = await read();
    assert.deepEqual(template.sittings.get(key)?.map((m) => m.startMinutes).sort(), [11 * 60, 11 * 60 + 30]);
    const lesson = (from: string, to: string, start: number) => boardCodeOf(template, [classes.A.id], { dayOfWeek: 1, startMinutes: start, endMinutes: start + 30 }, { startDate: from, endDate: to });
    assert.equal(lesson('2026-08-17', '2026-12-18', 11 * 60), 'LUNCH', 'an autumn lesson on the autumn meal');
    assert.equal(lesson('2026-08-17', '2026-12-18', 11 * 60 + 30), null, 'an autumn lesson on the spring meal is clear of it');
    assert.equal(lesson('2027-01-11', '2027-06-11', 11 * 60 + 30), 'LUNCH', 'a spring lesson on the spring meal');
    assert.equal(lesson('2027-01-11', '2027-06-11', 11 * 60), null, 'a spring lesson on the autumn meal is clear of it');
    assert.equal(boardCodeOf(template, [classes.A.id], { dayOfWeek: 1, startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 }), 'LUNCH', 'a lesson of no weeks is held to both');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
