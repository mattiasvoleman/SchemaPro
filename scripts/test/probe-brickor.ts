/**
 * Brickorna och ägandet (E4) against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-brickor.ts
 *
 *   (br-a) a lesson Generera laid and nobody has locked is not kept by the next Generera; a PATCH that moves it by hand locks it (beslut 2), says
 *          so, and the lesson is then one of the lessons Generera keeps (keptMastersWhere, the one read of Generera's fetch);
 *   (br-b) a lock, an unlock and a restated save of a lesson that is double-booked are let through, and a new room on it is asked as before;
 *   (br-w) the lesson dialog's save, which sends the weeks as they stood: a new room on a lesson Generera laid leaves it Generera's, weeks it did not
 *          have hand it to the school, and a move locks it and leaves it Generera's (granskaren g509, M-3).
 *
 * It works in schools of its own (slug `probe-brickor-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { keptMastersWhere } from '../../src/optimization/preserved-lessons';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-brickor';

/** Year 7 with a day 08:00-15:00. L1 and L2 share a teacher and stand clear of each other; L3 stands on L1's hour (double-booked on purpose). */
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '8B', grade: 8 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik', 'Kemi'],
  lessons: [
    { key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'L2', class: '7A', subject: 'Kemi', teacher: 'T2', day: 2, start: '10:00', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function brickorChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const slug = `${SLUG}-0`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  try {
    const a = await plant(owner, slug, WORLD);
    const L1 = a.lessonId.get('L1')!;
    const L2 = a.lessonId.get('L2')!;
    const kept = async (): Promise<string[]> => api.withRls(a.caller, async (tx) => (await tx.masterLesson.findMany({ where: keptMastersWhere(a.year), select: { id: true } })).map((row) => row.id));
    const stateOf = async (id: string) => (await owner.query<{ locked: boolean; generated: boolean; day: number; start: string }>(`SELECT "isLocked" AS locked, "isGenerated" AS generated, "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start FROM "MasterLessons" WHERE id = $1`, [id])).rows[0]!;

    await check('(br-a) a lesson Generera laid is Generera\'s until it is moved by hand: then it is locked, in sight, and one of the lessons Generera keeps', async () => {
      await owner.query(`UPDATE "MasterLessons" SET "isGenerated" = true WHERE id = ANY($1::uuid[])`, [[L1, L2]]);
      assert.ok(!(await kept()).includes(L1), 'a lesson Generera laid and nobody locked is not kept: the next Generera lays it again');
      // A room is no move: the lesson stays Generera's.
      const room = await masters.update(L1, { roomId: a.roomId.get('R2')! }, a.caller);
      assert.equal(room.lockedByMove, undefined);
      assert.deepEqual([(await stateOf(L1)).locked, (await kept()).includes(L1)], [false, false]);
      // Moved by hand, as the page saves it: the lock restated off is the lesson's own value, and the move locks it.
      const moved = await masters.update(L1, { dayOfWeek: 3, startTime: '13:00', endTime: '14:00', isLocked: false }, a.caller);
      assert.deepEqual([moved.isLocked, moved.lockedByMove], [true, true]);
      assert.deepEqual(await stateOf(L1), { locked: true, generated: true, day: 3, start: '13:00' });
      assert.ok((await kept()).includes(L1), 'the moved lesson is kept by the next Generera: it stands where the hand put it');
      // Taking the lock off in the same breath as a move is the reader's own answer and is kept.
      const free = await masters.update(L1, { dayOfWeek: 4, startTime: '13:00', endTime: '14:00', isLocked: false }, a.caller);
      assert.equal(free.lockedByMove, undefined);
      assert.equal((await stateOf(L1)).locked, false, 'a locked lesson moved with isLocked: false is unlocked: the lock was changed by the request, not set by the server');
    });

    await check('(br-b) a lock or an unlock of a double-booked lesson is let through, and a new room on it is asked as before', async () => {
      // L2 stands Tuesday 10:00 with its own teacher: put L1 on the same hour with the same class so that the two clash on the class.
      await owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = 2, "startTime" = '10:30', "endTime" = '11:30', "isLocked" = false WHERE id = $1`, [L1]);
      const locked = await masters.update(L1, { isLocked: true }, a.caller);
      assert.equal(locked.isLocked, true);
      const unlocked = await masters.update(L1, { isLocked: false }, a.caller);
      assert.equal(unlocked.isLocked, false);
      let refused: HttpException | undefined;
      try {
        // L1 has R2 since (br-a): R1 is a new room, and the lesson clashes with its class's other lesson.
        await masters.update(L1, { roomId: a.roomId.get('R1')! }, a.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 409, 'a new room on a double-booked lesson is asked the clash rule');
    });

    await check('(br-w) a save that sends the weeks as they stood is no write of them: only weeks the lesson did not have hand it to the school', async () => {
      const R1 = a.roomId.get('R1')!;
      const R2 = a.roomId.get('R2')!;
      const weeks = async (id: string) => (await owner.query<{ recurrence: string; start: string | null; end: string | null }>(`SELECT recurrence, to_char("startDate", 'YYYY-MM-DD') AS start, to_char("endDate", 'YYYY-MM-DD') AS "end" FROM "MasterLessons" WHERE id = $1`, [id])).rows[0]!;
      /** L1 as Generera laid it: Monday 09:00, R1, every week, nobody's lock. */
      const reset = () => owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = 1, "startTime" = '09:00', "endTime" = '10:00', "roomId" = $2, "isLocked" = false, "isGenerated" = true, recurrence = 'ALL_WEEKS', "startDate" = NULL, "endDate" = NULL WHERE id = $1`, [L1, R1]);
      /** What the dialog sends: every field, the weeks as it read them. */
      const dialog = (change: Record<string, unknown>) => ({ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', roomId: R1, isLocked: false, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null, ...change });

      await reset();
      const room = await masters.update(L1, dialog({ roomId: R2 }), a.caller);
      assert.equal(room.lockedByMove, undefined);
      assert.deepEqual(await stateOf(L1), { locked: false, generated: true, day: 1, start: '09:00' }, 'a room changed in the dialog leaves the lesson Generera\'s');
      assert.ok(!(await kept()).includes(L1), 'and the next Generera lays it again');

      // The same date that the lesson has, sent again, is no window either.
      await owner.query(`UPDATE "MasterLessons" SET "startDate" = '2026-08-17' WHERE id = $1`, [L1]);
      await masters.update(L1, dialog({ roomId: R1, startDate: '2026-08-17' }), a.caller);
      assert.equal((await stateOf(L1)).generated, true, 'a first day sent as it stands is no write of it');

      // Weeks the lesson did not have are the school's: Generera cannot make them, and keeps the lesson as it is.
      await reset();
      await masters.update(L1, dialog({ recurrence: 'ODD_WEEKS' }), a.caller);
      assert.deepEqual([(await stateOf(L1)).generated, (await weeks(L1)).recurrence], [false, 'ODD_WEEKS']);
      assert.ok((await kept()).includes(L1), 'a lesson handed to the school is kept by the next Generera');
      await reset();
      await masters.update(L1, dialog({ startDate: '2026-09-01' }), a.caller);
      assert.deepEqual([(await stateOf(L1)).generated, (await weeks(L1)).start], [false, '2026-09-01']);
      await reset();
      await masters.update(L1, dialog({ endDate: '2026-12-18' }), a.caller);
      assert.deepEqual([(await stateOf(L1)).generated, (await weeks(L1)).end], [false, '2026-12-18']);
      // Odd weeks sent as they stand are no write of them; even weeks, where the lesson had odd, are.
      await reset();
      await owner.query(`UPDATE "MasterLessons" SET recurrence = 'ODD_WEEKS' WHERE id = $1`, [L1]);
      await masters.update(L1, dialog({ roomId: R2, recurrence: 'ODD_WEEKS' }), a.caller);
      assert.equal((await stateOf(L1)).generated, true, 'odd weeks sent as they stand');
      await masters.update(L1, dialog({ roomId: R2, recurrence: 'EVEN_WEEKS' }), a.caller);
      assert.deepEqual([(await stateOf(L1)).generated, (await weeks(L1)).recurrence], [false, 'EVEN_WEEKS']);
      // The day is the window: the same first day as a timestamp with an offset is the same first day.
      await reset();
      await owner.query(`UPDATE "MasterLessons" SET "startDate" = '2026-08-17' WHERE id = $1`, [L1]);
      await masters.update(L1, dialog({ roomId: R2, startDate: '2026-08-17T23:59:59+02:00' }), a.caller);
      assert.equal((await stateOf(L1)).generated, true, 'the same day, written as a timestamp, is no write of the first day');

      // A move by the dialog locks the lesson, in sight, and leaves it Generera's: the lock is what keeps it.
      await reset();
      const moved = await masters.update(L1, dialog({ dayOfWeek: 3, startTime: '13:00', endTime: '14:00' }), a.caller);
      assert.deepEqual([moved.isLocked, moved.lockedByMove], [true, true]);
      assert.deepEqual(await stateOf(L1), { locked: true, generated: true, day: 3, start: '13:00' });
      assert.ok((await kept()).includes(L1), 'kept for the lock, and still Generera\'s own lesson');
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
    await brickorChecks(owner, api, async (name, run) => {
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
