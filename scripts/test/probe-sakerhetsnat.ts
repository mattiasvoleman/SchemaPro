/**
 * Säkerhetsnät (E9): TVÅ SKRIBENTER, EN LEKTION, against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-sakerhetsnat.ts
 *
 *   (sn-a) two pages read the same lesson; the first writes, the second asks to write on what it read: 409 LESSON_CHANGED naming the fields,
 *          the lesson is the first's and the change log holds one row of the second's write: none;
 *   (sn-b) the same two requests at the same moment, thirty times over: exactly one is written and the other is refused, never both;
 *   (sn-c) the second request is already past its first read and waiting for the row when the first writer commits (a writer held open by hand):
 *          it is refused on what the first wrote, and not let through on the lesson it read before the lock;
 *   (sn-d) a request that names only the fields it writes is not in the way of a colleague's change of another one, and the dialog, which names
 *          them all, is: the colleague's teacher is not put back by a save that changed the room;
 *   (sn-e) a request that sends no expectation is written as it always was (the mobile app and an older page send none);
 *   (sn-g) a request that sets the value that already stands is no conflict: the same save twice, a lock a colleague set too;
 *   (sn-f) a first day that is no YYYY-MM-DD is a 400 LESSON_DATE_FORM and nothing is written (granskaren g511, L-6): it was a 500.
 *
 * It works in a school of its own (slug `probe-sakerhetsnat-0`) and drops it.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-sakerhetsnat';

/** Year 7 and 8 with a day 08:00-15:00; every lesson has a teacher of its own and stands clear of the others. */
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '8B', grade: 8 }],
  teachers: ['T1', 'T2', 'T3'],
  rooms: ['R1', 'R2', 'R3'],
  subjects: ['Matematik', 'Kemi', 'Fysik'],
  lessons: [
    { key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'L2', class: '8B', subject: 'Kemi', teacher: 'T2', room: 'R2', day: 2, start: '10:00', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const refusalOf = async (run: () => Promise<unknown>): Promise<HttpException | undefined> => {
  try {
    await run();
  } catch (error) {
    return error as HttpException;
  }
  return undefined;
};
const codeOf = (error: HttpException | undefined): string | undefined => (error?.getResponse() as { code?: string } | undefined)?.code;
const fieldsOf = (error: HttpException | undefined): string | undefined => (error?.getResponse() as { params?: { fields?: string } } | undefined)?.params?.fields;

export async function sakerhetsnatChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const slug = `${SLUG}-0`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  try {
    const a = await plant(owner, slug, WORLD);
    const L1 = a.lessonId.get('L1')!;
    const L2 = a.lessonId.get('L2')!;
    const [R1, R2, R3] = ['R1', 'R2', 'R3'].map((key) => a.roomId.get(key)!) as [string, string, string];
    const [T1, T2] = ['T1', 'T2'].map((key) => a.teacherId.get(key)!) as [string, string];
    const stateOf = async (id: string) =>
      (
        await owner.query<{ day: number; start: string; room: string | null; teacher: string | null; locked: boolean }>(
          `SELECT "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, "roomId" AS room, "teacherId" AS teacher, "isLocked" AS locked FROM "MasterLessons" WHERE id = $1`,
          [id],
        )
      ).rows[0]!;
    const logRows = async (id: string) => Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "masterLessonId" = $1`, [id])).rows[0]!.n);
    /** Puts a lesson where the world has it and clears the lock, so that a check starts from the page's reading. */
    const reset = async (id: string, day: number, start: string, end: string, room: string, teacher: string) =>
      owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = $2, "startTime" = $3, "endTime" = $4, "roomId" = $5, "teacherId" = $6, "isLocked" = false, "updatedAt" = now() WHERE id = $1`, [id, day, start, end, room, teacher]);
    // What a page that read L1 holds of the fields a drag writes.
    const SAW_L1 = { dayOfWeek: 1, startTime: '09:00', endTime: '10:00' };

    await check('(sn-a) the second of two pages that read the same lesson is refused with the fields, and the first one\'s write stands', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      const first = await masters.update(L1, { dayOfWeek: 3, startTime: '13:00', endTime: '14:00', expected: SAW_L1 }, a.caller);
      assert.equal(first.dayOfWeek, 3);
      const logsAfterFirst = await logRows(L1);
      const second = await refusalOf(() => masters.update(L1, { dayOfWeek: 4, startTime: '11:00', endTime: '12:00', expected: SAW_L1 }, a.caller));
      assert.equal(second?.getStatus(), 409);
      assert.equal(codeOf(second), 'LESSON_CHANGED');
      assert.equal(fieldsOf(second), 'dayOfWeek,startTime,endTime');
      assert.deepEqual(await stateOf(L1), { day: 3, start: '13:00', room: R1, teacher: T1, locked: true }, 'the lesson is where the first writer put it, and was not overwritten');
      assert.equal(await logRows(L1), logsAfterFirst, 'a refused write leaves nothing in the change log');
    });

    await check('(sn-b) the same two requests at the same moment, thirty times over: one is written and the other refused, never both', async () => {
      for (let round = 0; round < 30; round += 1) {
        await reset(L2, 2, '10:00', '11:00', R2, T2);
        const saw = { dayOfWeek: 2, startTime: '10:00', endTime: '11:00' };
        const results = await Promise.all([
          refusalOf(() => masters.update(L2, { dayOfWeek: 3, startTime: '10:00', endTime: '11:00', expected: saw }, a.caller)),
          refusalOf(() => masters.update(L2, { dayOfWeek: 5, startTime: '10:00', endTime: '11:00', expected: saw }, a.caller)),
        ]);
        const refused = results.filter((error) => error !== undefined);
        assert.equal(refused.length, 1, `round ${round}: exactly one of two writers on the same reading is refused`);
        assert.equal(codeOf(refused[0]), 'LESSON_CHANGED', `round ${round}`);
        const winner = results[0] === undefined ? 3 : 5;
        assert.equal((await stateOf(L2)).day, winner, `round ${round}: the lesson is where the writer that was let through put it`);
      }
    });

    await check('(sn-h) a request with an expectation against Generera, which holds the year and then every row, is never a deadlock: the year\'s share is taken before the row (granskaren g515)', async () => {
      const outcomes: Record<string, number> = {};
      for (let round = 0; round < 24; round += 1) {
        await reset(L1, 1, '09:00', '10:00', R1, T1);
        const generera = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
        await generera.connect();
        const holding = (async () => {
          try {
            await generera.query('BEGIN');
            await generera.query(`SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext($1::uuid::text))`, [a.year]);
            await new Promise((resolve) => setTimeout(resolve, 150));
            await generera.query(`SELECT "id" FROM "MasterLessons" WHERE "academicYearId" = $1::uuid ORDER BY "id" FOR UPDATE`, [a.year]);
            await generera.query('COMMIT');
            return 'generera-ok';
          } catch (error) {
            await generera.query('ROLLBACK').catch(() => undefined);
            return `generera-${(error as { code?: string }).code}`;
          }
        })();
        // The request starts at another point of Generera's turn each round: before it, while it holds the year, and while it holds the rows.
        await new Promise((resolve) => setTimeout(resolve, (round % 12) * 12));
        const request = refusalOf(() => masters.update(L1, { roomId: R3, expected: { roomId: R1 } }, a.caller)).then((error) => (error === undefined ? 'ok' : (codeOf(error) ?? 'refused')), (error: unknown) => `error-${(error as { code?: string }).code}`);
        const [rows, answer] = await Promise.all([holding, request]);
        await generera.end();
        outcomes[`${answer} | ${rows}`] = (outcomes[`${answer} | ${rows}`] ?? 0) + 1;
      }
      assert.deepEqual(Object.keys(outcomes), ['ok | generera-ok'], `no deadlock between a request that names what it saw and Generera: ${JSON.stringify(outcomes)}`);
    });

    await check('(sn-c) a request that has read the lesson and waits for its row meets the write that held it, and is refused on that', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      // A writer held open by hand: the row is locked, as a PATCH in the middle of its transaction would have it.
      const holder = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "MasterLessons" WHERE id = $1 FOR NO KEY UPDATE`, [L1]);
        const waiting = refusalOf(() => masters.update(L1, { roomId: R3, expected: { roomId: R1 } }, a.caller));
        // The request is past its first read (the lesson as it stood, room R1) and queued behind the row; the holder now writes and commits.
        await new Promise((resolve) => setTimeout(resolve, 600));
        await holder.query(`UPDATE "MasterLessons" SET "roomId" = $2, "updatedAt" = now() WHERE id = $1`, [L1, R2]);
        await holder.query('COMMIT');
        const refused = await waiting;
        assert.equal(codeOf(refused), 'LESSON_CHANGED', 'a lesson read before the colleague committed is not let through on that reading');
        assert.equal(fieldsOf(refused), 'roomId');
        assert.equal((await stateOf(L1)).room, R2, 'the colleague\'s room stands');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    });

    await check('(sn-d) a request that names what it writes passes a colleague\'s change of something else, and a dialog that names every field does not', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      // A colleague gives the lesson another teacher and another room.
      await owner.query(`UPDATE "MasterLessons" SET "teacherId" = $2, "roomId" = $3, "updatedAt" = now() WHERE id = $1`, [L1, T2, R2]);
      // A drag writes the day and the clock and names only those: it is written, and the colleague's two changes stand beside it.
      const dragged = await masters.update(L1, { dayOfWeek: 2, startTime: '13:00', endTime: '14:00', expected: SAW_L1 }, a.caller);
      assert.equal(dragged.dayOfWeek, 2);
      const after = await stateOf(L1);
      assert.deepEqual([after.teacher, after.room], [T2, R2], 'what the colleague changed was not touched');
      // The dialog saves every field it holds, the teacher too, as it read it: it is refused, and the colleague's teacher is not put back.
      const saw = { dayOfWeek: 2, startTime: '13:00', endTime: '14:00', roomId: R2, teacherId: T1 };
      const dialog = await refusalOf(() => masters.update(L1, { ...saw, roomId: R3, expected: saw }, a.caller));
      assert.equal(codeOf(dialog), 'LESSON_CHANGED');
      assert.equal(fieldsOf(dialog), 'teacherId');
      assert.deepEqual([(await stateOf(L1)).teacher, (await stateOf(L1)).room], [T2, R2]);
    });

    await check('(sn-e) a request that sends no expectation is written over the colleague\'s change, as it always was', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      await owner.query(`UPDATE "MasterLessons" SET "roomId" = $2, "updatedAt" = now() WHERE id = $1`, [L1, R2]);
      const saved = await masters.update(L1, { roomId: R3 }, a.caller);
      assert.equal(saved.roomId, R3);
      assert.equal((await stateOf(L1)).room, R3);
    });

    await check('(sn-g) a request that sets the value that already stands is nothing written over: the same save sent twice, and a lock a colleague set too (granskaren g515)', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      const move = { dayOfWeek: 5, startTime: '13:00', endTime: '14:00', expected: SAW_L1 };
      await masters.update(L1, move, a.caller);
      const again = await refusalOf(() => masters.update(L1, move, a.caller));
      assert.equal(again, undefined, 'the second of two equal saves is no conflict with the first');
      assert.deepEqual(await stateOf(L1), { day: 5, start: '13:00', room: R1, teacher: T1, locked: true });
      // A colleague has locked the lesson; the page saw it free and asks for the lock: it is there.
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true, "updatedAt" = now() WHERE id = $1`, [L1]);
      assert.equal(await refusalOf(() => masters.update(L1, { isLocked: true, propagate: false, expected: { isLocked: false } }, a.caller)), undefined);
      // The field a colleague changed that this request does write over, with another value, is still refused.
      await owner.query(`UPDATE "MasterLessons" SET "roomId" = $2, "updatedAt" = now() WHERE id = $1`, [L1, R2]);
      const over = await refusalOf(() => masters.update(L1, { roomId: R3, isLocked: true, expected: { roomId: R1, isLocked: false } }, a.caller));
      assert.equal(codeOf(over), 'LESSON_CHANGED');
      assert.equal(fieldsOf(over), 'roomId');
    });

    await check('(sn-f) a first day that is no YYYY-MM-DD is a 400 LESSON_DATE_FORM and nothing is written; it was a 500', async () => {
      await reset(L1, 1, '09:00', '10:00', R1, T1);
      const before = await logRows(L1);
      for (const startDate of ['20260817', '2026-W34-1', '2026-229']) {
        const refused = await refusalOf(() => masters.update(L1, { startDate }, a.caller));
        assert.equal(refused?.getStatus(), 400, `${startDate}`);
        assert.equal(codeOf(refused), 'LESSON_DATE_FORM', `${startDate}`);
      }
      assert.equal(await logRows(L1), before);
      // A day with a time of day after it is still a day.
      const stamped = await masters.update(L1, { startDate: '2026-09-07T00:00:00.000Z' }, a.caller);
      assert.equal(stamped.startDate, '2026-09-07');
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await sakerhetsnatChecks(owner, api, async (name, run) => {
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
