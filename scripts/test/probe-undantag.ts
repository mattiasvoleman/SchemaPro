/**
 * Undantag med flit (E1b) against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-undantag.ts
 *
 * An administrator may break the stage's ramtid or the class's meal on one lesson, by naming the rule; the lesson is locked, the rule's name is saved
 * on it, and it is for the time it was given for. What no unit test can hold, because it lives in the database and in the seams between the services:
 *
 *   (ud-a) the table and its trigger (20270307090000): only the two names the CHECK knows; the exemption ends when the lesson's day, clock or dates change,
 *          when its lock is taken off and when it goes to the tray, and stays across a change of room; a writer that sets it itself, to a value it has
 *          decided on, says so for its transaction (app.keep_exemptions) and keeps it across a changed time;
 *   (ud-b) the PATCH, through the real service: an exemption is given by naming the rule, never by anything else, and a rule named for a clash is
 *          refused with its own reason; another time that breaks the rule asks again, and the answer yes keeps it (the same names across a changed time,
 *          which is the GUC's road through the adapter); a time that holds ends it, and says so;
 *   (ud-c) the seams that copy a lesson field by field: a version taken and restored, and a draft discarded back to what was published (also with the
 *          exemption kept across a changed time), and the publication's own copy of it;
 *   (ud-d) "Schema som fil": the table written with the column Undantag and read into another school, where the same file is refused without it.
 *
 * It works in schools of its own (slug `probe-undantag-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { CalendarService } from '../../src/calendar/calendar.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { DraftService } from '../../src/publication/draft.service';
import { parseCsv, writeCsv } from '../../src/schedule-exchange/csv';
import { ScheduleExchangeService } from '../../src/schedule-exchange/exchange.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-undantag';

/** One class of year 7 whose day is 08:00-15:00 and who eats 12:00-12:30 on Monday and Thursday; L1 and L2 stand clear of both, L2 shares L1's teacher. */
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }],
  teachers: ['T1'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik'],
  lessons: [
    { key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'L2', class: '7A', subject: 'Matematik', teacher: 'T1', day: 2, start: '14:30', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [
    { class: '7A', day: 1, start: '12:00', end: '12:30' },
    { class: '7A', day: 4, start: '12:00', end: '12:30' },
  ],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function undantagChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const versions = new ScheduleVersionsService(api);
  const exchange = new ScheduleExchangeService(api, realtime as never, masters);

  const exemptOf = async (id: string) => (await owner.query<{ ex: string[]; locked: boolean; day: number; start: string; room: string | null }>(
    `SELECT "exemptFrom"::text[] AS ex, "isLocked" AS locked, "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, "roomId" AS room FROM "MasterLessons" WHERE id = $1`,
    [id],
  )).rows[0]!;
  const refusalOf = async (attempt: Promise<unknown>): Promise<{ code: string; params: Record<string, unknown> }> => {
    try {
      await attempt;
    } catch (error) {
      assert.ok(error instanceof HttpException, `not refused with an HttpException: ${String(error)}`);
      assert.equal(error.getStatus(), 409);
      return error.getResponse() as { code: string; params: Record<string, unknown> };
    }
    throw new Error('the edit was not refused');
  };

  const schools = [`${SLUG}-0`, `${SLUG}-1`];
  const cleanup = async () => {
    for (const slug of schools) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  };
  await cleanup();
  try {
    const a = await plant(owner, schools[0]!, WORLD);
    const L1 = a.lessonId.get('L1')!;
    const L2 = a.lessonId.get('L2')!;
    const room2 = a.roomId.get('R2')!;

    await check('(ud-a) the table: only the two names, an exemption ends with the time, the lock and the tray, and stays across a room', async () => {
      await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = '{FRAME}', "isLocked" = true WHERE id = $1`, [L1]);
      for (const name of ['TEACHER', 'ROOM', 'GRADE_RULE', 'OTHER_SCHOOL', 'SCHOOL_DAY']) {
        await assert.rejects(owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = ARRAY[$2]::text[] WHERE id = $1`, [L1, name]), /MasterLessons_exemptFrom_names_a_rule_that_can_be_broken/, `${name} cannot be exempted`);
      }
      await owner.query(`UPDATE "MasterLessons" SET "roomId" = $2 WHERE id = $1`, [L1, room2]);
      assert.deepEqual((await exemptOf(L1)).ex, ['FRAME'], 'a room is not where the lesson stands');
      await owner.query(`UPDATE "MasterLessons" SET "startTime" = '09:05', "endTime" = '10:05' WHERE id = $1`, [L1]);
      assert.deepEqual((await exemptOf(L1)).ex, [], 'a clock ends it');
      for (const [change, sql] of [
        ['a day', `"dayOfWeek" = 3`],
        ['a date', `"startDate" = '2026-09-01'`],
        // Each of the other columns the trigger watches, alone (g467): a writer that shortens a lesson changes its end and nothing else.
        ['the start alone', `"startTime" = "startTime" + interval '5 minutes'`],
        ['the end alone', `"endTime" = "endTime" + interval '5 minutes'`],
        ['the last date alone', `"endDate" = '2027-06-01'`],
        ['the lock taken off', `"isLocked" = false`],
        ['the tray', `"isParked" = true`],
      ] as const) {
        await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = '{LUNCH}', "isLocked" = true, "isParked" = false, "dayOfWeek" = 1, "startDate" = NULL, "endDate" = NULL WHERE id = $1`, [L1]);
        assert.deepEqual((await exemptOf(L1)).ex, ['LUNCH']);
        await owner.query(`UPDATE "MasterLessons" SET ${sql} WHERE id = $1`, [L1]);
        assert.deepEqual((await exemptOf(L1)).ex, [], `${change} ends it`);
      }
      // A writer that says it sets the exemption itself keeps it across a changed time, in its own transaction only.
      await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = '{FRAME}', "isLocked" = true, "isParked" = false, "dayOfWeek" = 1, "startDate" = NULL WHERE id = $1`, [L1]);
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.keep_exemptions', 'on', true)`);
      await owner.query(`UPDATE "MasterLessons" SET "startTime" = '09:10', "endTime" = '10:10' WHERE id = $1`, [L1]);
      await owner.query('COMMIT');
      assert.deepEqual((await exemptOf(L1)).ex, ['FRAME']);
      await owner.query(`UPDATE "MasterLessons" SET "startTime" = '09:15', "endTime" = '10:15' WHERE id = $1`, [L1]);
      assert.deepEqual((await exemptOf(L1)).ex, [], 'and the next transaction asks again');
      // A statement that writes the exemption itself, to another value than it had, is the writer's own say over the changed time (g467).
      await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = '{LUNCH}', "isLocked" = true, "isParked" = false, "dayOfWeek" = 1, "startDate" = NULL, "endDate" = NULL WHERE id = $1`, [L1]);
      await owner.query(`UPDATE "MasterLessons" SET "exemptFrom" = '{FRAME}', "startTime" = "startTime" + interval '5 minutes' WHERE id = $1`, [L1]);
      assert.deepEqual((await exemptOf(L1)).ex, ['FRAME'], 'a rewritten exemption is the writer’s');
      // Put the world back.
      await owner.query(`UPDATE "MasterLessons" SET "startTime" = '09:00', "endTime" = '10:00', "roomId" = $2, "isLocked" = false, "exemptFrom" = '{}' WHERE id = $1`, [L1, a.roomId.get('R1')]);
    });

    await check('(ud-b) the PATCH: named, never otherwise; a clash is its own reason; another time asks again; a time that holds ends it', async () => {
      // The question and the write say the same.
      const plain = await masters.judgeMoves({ moves: [{ lessonId: L1, startTime: '14:30', endTime: '15:30' }] }, a.caller);
      assert.deepEqual([plain.moves[0]!.ok, plain.moves[0]!.exemptable, plain.moves[0]!.refusals.map((r) => r.reason)], [false, true, ['FRAME']]);
      const asked = await masters.judgeMoves({ moves: [{ lessonId: L1, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }] }, a.caller);
      assert.deepEqual([asked.moves[0]!.ok, asked.moves[0]!.exempted], [true, ['FRAME']]);
      const unnamed = await refusalOf(masters.update(L1, { startTime: '14:30', endTime: '15:30' }, a.caller));
      assert.equal(unnamed.code, 'MASTER_LESSON_REFUSED');
      assert.equal(unnamed.params['reason'], 'FRAME');
      assert.deepEqual((await exemptOf(L1)).ex, [], 'a refused PATCH wrote nothing');
      // The lunch does not hide behind the ramtid: Thursday 14:45-15:15 is under the meal only when the meal is moved there.
      await owner.query(`INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, 5, '14:45', '15:15', false, now())`, [a.school, a.year, a.classId.get('7A')]);
      const both = await refusalOf(masters.update(L1, { dayOfWeek: 5, startTime: '14:30', endTime: '15:30' }, a.caller));
      assert.equal(both.params['reasons'], 'FRAME,LUNCH');
      const half = await refusalOf(masters.update(L1, { dayOfWeek: 5, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, a.caller));
      assert.equal(half.params['reason'], 'LUNCH', 'the ramtid is answered, the lunch is still asked');
      await owner.query(`DELETE FROM "LunchSittings" WHERE "dayOfWeek" = 5 AND "schoolId" = $1`, [a.school]);

      // Given, by name: the lesson is locked and carries the rule.
      const given = await masters.update(L1, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, a.caller);
      assert.deepEqual([given.isLocked, given.exemptFrom], [true, ['FRAME']]);
      assert.deepEqual(await exemptOf(L1), { ex: ['FRAME'], locked: true, day: 1, start: '14:30', room: a.roomId.get('R1') });
      // A clash is no rule to exempt: L2 stands Tuesday 14:30-15:30 with the same teacher.
      const clash = await refusalOf(masters.update(L1, { dayOfWeek: 2, exempt: ['FRAME', 'LUNCH'] }, a.caller));
      assert.equal(clash.params['reason'], 'TEACHER');
      assert.equal(clash.params['className'], '7A');
      // A room is not where the lesson stands: the exemption stays, and the board is not asked.
      await masters.update(L1, { roomId: room2 }, a.caller);
      assert.deepEqual((await exemptOf(L1)).ex, ['FRAME']);
      // Another time that breaks the rule asks again, and the answer yes keeps it across the changed time (the GUC through the adapter).
      const again = await refusalOf(masters.update(L1, { startTime: '14:40', endTime: '15:40' }, a.caller));
      assert.equal(again.params['reason'], 'FRAME');
      const kept = await masters.update(L1, { startTime: '14:40', endTime: '15:40', exempt: ['FRAME'] }, a.caller);
      assert.deepEqual([kept.exemptFrom, (await exemptOf(L1)).start], [['FRAME'], '14:40']);
      // The lock it rests on cannot be taken off in the same breath as it is given.
      await assert.rejects(masters.update(L1, { startTime: '14:50', endTime: '15:50', exempt: ['FRAME'], isLocked: false }, a.caller), /exempt/);
      // A time that holds ends it, and the answer says so.
      const ended = await masters.update(L1, { startTime: '09:00', endTime: '10:00' }, a.caller);
      assert.deepEqual((await exemptOf(L1)).ex, []);
      assert.deepEqual(ended.warnings.filter((warning) => warning.code === 'EXEMPTION_ENDED'), [{ code: 'EXEMPTION_ENDED', params: { rules: 'FRAME' } }]);
      // Given again where it is not needed: saved on nothing.
      const nothing = await masters.update(L1, { exempt: ['FRAME', 'LUNCH'] }, a.caller);
      assert.equal(nothing.exemptFrom, undefined);
      // A new lesson that names the rule.
      const created = await masters.create({ academicYearId: a.year, subjectId: a.subjectId.get('Matematik')!, studentGroupId: a.classId.get('7A')!, dayOfWeek: 3, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, a.caller);
      assert.deepEqual([created.isLocked, created.exemptFrom], [true, ['FRAME']]);
      await refusalOf(masters.create({ academicYearId: a.year, subjectId: a.subjectId.get('Matematik')!, studentGroupId: a.classId.get('7A')!, dayOfWeek: 3, startTime: '14:30', endTime: '15:30' }, a.caller));
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [created.id]);
    });

    await check('(ud-c) a version taken and restored, a draft discarded, and the publication’s copy, keep the exemption', async () => {
      await masters.update(L1, { startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, a.caller);
      const version = await versions.create(a.year, 'med undantag', a.caller);
      await masters.update(L1, { startTime: '09:00', endTime: '10:00' }, a.caller);
      assert.deepEqual((await exemptOf(L1)).ex, []);
      await versions.restore(version.id, a.caller);
      const restored = (await owner.query<{ id: string; ex: string[]; locked: boolean; start: string }>(
        `SELECT id, "exemptFrom"::text[] AS ex, "isLocked" AS locked, to_char("startTime", 'HH24:MI') AS start FROM "MasterLessons" WHERE "academicYearId" = $1 AND "dayOfWeek" = 1 AND "studentGroupId" = $2`,
        [a.year, a.classId.get('7A')],
      )).rows;
      assert.deepEqual(restored.map((row) => [row.start, row.ex, row.locked]), [['14:30', ['FRAME'], true]], 'the version restored it as the exemption it was');
      const lesson = restored[0]!.id;

      // The draft: published with the exemption, edited in the draft (the exemption given again at another time), discarded.
      const calendar = new CalendarService(api);
      const drafts = new DraftService(api, calendar, versions, realtime as never);
      await drafts.switchMode('DRAFT', a.caller);
      const published = await owner.query<{ ex: string[] }>(`SELECT "exemptFrom"::text[] AS ex FROM "PublishedLessons" WHERE "masterLessonId" = $1`, [lesson]);
      assert.deepEqual(published.rows.map((row) => row.ex), [['FRAME']], 'the publication’s snapshot carries it');
      await masters.update(lesson, { startTime: '14:40', endTime: '15:40', exempt: ['FRAME'] }, a.caller);
      assert.deepEqual([(await exemptOf(lesson)).start, (await exemptOf(lesson)).ex], ['14:40', ['FRAME']]);
      const state = await drafts.state(a.year, a.caller);
      assert.equal(state.changed.length, 1, 'the draft says one lesson changed');
      await drafts.discard(a.year, a.caller);
      assert.deepEqual([(await exemptOf(lesson)).start, (await exemptOf(lesson)).ex, (await exemptOf(lesson)).locked], ['14:30', ['FRAME'], true], 'discarded back to the published time, with the exemption kept across it');
      // An exemption given in the draft alone, at the published time, is a change of the draft, and the discard takes it back.
      await masters.update(lesson, { exempt: [] }, a.caller);
      assert.equal((await drafts.state(a.year, a.caller)).changed.length, 1, 'taking an exemption back is a change of the draft');
      await drafts.discard(a.year, a.caller);
      assert.deepEqual((await exemptOf(lesson)).ex, ['FRAME']);
      await drafts.switchMode('DIRECT', a.caller);
    });

    const b = await plant(owner, schools[1]!, { ...WORLD, lessons: [] });
    await check('(ud-d) Schema som fil: the table says Undantag, and the same file is refused where the lesson would break a rule without it', async () => {
      const lesson = (await owner.query<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "dayOfWeek" = 1`, [a.year])).rows[0]!.id;
      // Two lessons with no teacher and no room, so the file names nothing that is the first school's own: one under the ramtid, one over the meal.
      await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [a.year]);
      await masters.create({ academicYearId: a.year, subjectId: a.subjectId.get('Matematik')!, studentGroupId: a.classId.get('7A')!, dayOfWeek: 3, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, a.caller);
      await masters.create({ academicYearId: a.year, subjectId: a.subjectId.get('Matematik')!, studentGroupId: a.classId.get('7A')!, dayOfWeek: 4, startTime: '11:45', endTime: '12:45', exempt: ['LUNCH'] }, a.caller);
      void lesson;
      const file = await exchange.export(a.year, 'TABLE_CSV', a.caller);
      const parsed = parseCsv(file.body.toString('utf8'));
      const header = parsed.rows[0]!;
      const at = header.indexOf('Undantag');
      assert.ok(at > 0, `the export has no column Undantag: ${header.join(',')}`);
      assert.deepEqual(parsed.rows.slice(1).map((row) => row[at]).sort(), ['Lunch', 'Ramtid']);

      const files = [{ name: 'schema.csv', bytes: file.body }];
      const plan = await exchange.preview({ academicYearId: b.year, format: 'TABLE_CSV', files }, b.caller);
      assert.deepEqual(plan.rows.map((row) => [row.action, row.refusals.length]), [['CREATE', 0], ['CREATE', 0]], `the import of the table with its exemptions: ${JSON.stringify(plan.rows.map((row) => row.refusals))}`);
      await exchange.apply({ academicYearId: b.year, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, b.caller);
      const landed = (await owner.query<{ day: number; ex: string[]; locked: boolean }>(`SELECT "dayOfWeek" AS day, "exemptFrom"::text[] AS ex, "isLocked" AS locked FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY "dayOfWeek"`, [b.year])).rows;
      assert.deepEqual(landed, [{ day: 3, ex: ['FRAME'], locked: true }, { day: 4, ex: ['LUNCH'], locked: true }], 'the lessons arrive as the exemptions they were');

      // The same file with the column emptied is refused, row by row, by the rules it would have broken (the lessons it made are taken away first, or it says they exist).
      await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [b.year]);
      const without = parsed.rows.map((row, index) => (index === 0 ? row : row.map((cell, column) => (column === at ? '' : cell))));
      const bare = await exchange.preview({ academicYearId: b.year, format: 'TABLE_CSV', files: [{ name: 'schema.csv', bytes: Buffer.from(writeCsv(without, { delimiter: ';' }), 'utf8') }] }, b.caller);
      assert.deepEqual(bare.rows.flatMap((row) => row.refusals.map((refusal) => refusal.code)).sort(), ['ON_LUNCH_SITTING', 'OUTSIDE_FRAME'], 'without the column the rules are the rules');
      // A word that is none of the two is a row that cannot be read.
      const odd = parsed.rows.map((row, index) => (index === 0 ? row : row.map((cell, column) => (column === at ? 'Lärare' : cell))));
      const refused = await exchange.preview({ academicYearId: b.year, format: 'TABLE_CSV', files: [{ name: 'schema.csv', bytes: Buffer.from(writeCsv(odd, { delimiter: ';' }), 'utf8') }] }, b.caller);
      assert.ok(JSON.stringify(refused).includes('TABLE_BAD_EXEMPTION'), 'a name that cannot be exempted is no rule');
    });
  } finally {
    await cleanup();
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await undantagChecks(owner, api, async (name, run) => {
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
