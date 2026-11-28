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
 *   (br-c) a swap locks the two lessons it moves, in sight, and Generera keeps them; the undo (the same moves reversed) takes the lock off again;
 *   (br-d) a block card moved by hand locks its block whole, the block's other card too (the generation refuses a block with only some of its lessons
 *          locked), and a card put where it stood locks nothing.
 *   (br-w) the lesson dialog's save, which sends the weeks as they stood: a new room on a lesson Generera laid leaves it Generera's, weeks it did not
 *          have hand it to the school, and a move locks it and leaves it Generera's (granskaren g509, M-3).
 *
 * It works in schools of its own (slug `probe-brickor-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { keptMastersWhere } from '../../src/optimization/preserved-lessons';
import { SwapsService } from '../../src/swaps/swaps.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-brickor';

/** Year 7 with a day 08:00-15:00. L1 and L2 share a teacher and stand clear of each other; L3 stands on L1's hour (double-booked on purpose). */
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '8B', grade: 8 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik', 'Kemi', 'Språk A', 'Språk B'],
  lessons: [
    { key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'L2', class: '7A', subject: 'Kemi', teacher: 'T2', day: 2, start: '10:00', minutes: 60 },
    // A parallel block with two cards: Språk A (7A) and Språk B (8B) on Wednesday 10:00 and again on Friday 10:00.
    { key: 'B1', class: '7A', subject: 'Språk A', teacher: 'T1', day: 3, start: '10:00', minutes: 60 },
    { key: 'B2', class: '8B', subject: 'Språk B', teacher: 'T2', day: 3, start: '10:00', minutes: 60 },
    { key: 'B3', class: '7A', subject: 'Språk A', teacher: 'T1', day: 5, start: '10:00', minutes: 60 },
    { key: 'B4', class: '8B', subject: 'Språk B', teacher: 'T2', day: 5, start: '10:00', minutes: 60 },
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

    await check('(br-d) a block card moved by hand locks its block whole, the other card too; a card put where it stood locks nothing', async () => {
      const [B1, B2, B3, B4] = ['B1', 'B2', 'B3', 'B4'].map((key) => a.lessonId.get(key)!) as [string, string, string, string];
      const school = (await owner.query<{ id: string }>(`SELECT id FROM "Schools" WHERE slug = $1`, [slug])).rows[0]!.id;
      const block = (await owner.query<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'BR Språkval', now()) RETURNING id`, [school, a.year])).rows[0]!.id;
      for (const [group, subject, teacher] of [['7A', 'Språk A', 'T1'], ['8B', 'Språk B', 'T2']] as const) {
        await owner.query(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 2, 60, $6, now())`,
          [school, a.year, a.subjectId.get(subject)!, a.classId.get(group)!, a.teacherId.get(teacher)!, block],
        );
      }
      await owner.query(`UPDATE "MasterLessons" SET "isGenerated" = true, "isLocked" = false WHERE id = ANY($1::uuid[])`, [[B1, B2, B3, B4]]);
      const lockedOf = async () => (await owner.query<{ id: string; locked: boolean }>(`SELECT id, "isLocked" AS locked FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [[B1, B2, B3, B4]])).rows;
      assert.ok(!(await kept()).some((id) => [B1, B2, B3, B4].includes(id)), 'a block Generera laid and nobody locked is not kept');
      // Dropped where it stood: no move, no lock.
      const stayed = await masters.moveBlockCard({ lessonIds: [B1, B2], dayOfWeek: 3, startTime: '10:00', endTime: '11:00' } as never, a.caller);
      assert.deepEqual([stayed.lockedLessonIds, stayed.lockedByMove], [[], undefined]);
      assert.ok((await lockedOf()).every((row) => !row.locked));
      // Moved to Thursday 09:00: the whole block is locked, the card that stayed on Friday included.
      const moved = await masters.moveBlockCard({ lessonIds: [B1, B2], dayOfWeek: 4, startTime: '09:00', endTime: '10:00' } as never, a.caller);
      assert.equal(moved.lockedByMove, true);
      assert.deepEqual([...moved.lockedLessonIds].sort(), [B1, B2, B3, B4].sort());
      assert.ok(moved.lessons.every((lesson) => lesson.isLocked && lesson.dayOfWeek === 4));
      assert.ok((await lockedOf()).every((row) => row.locked), 'every lesson of the block is locked');
      const keptNow = await kept();
      assert.ok([B1, B2, B3, B4].every((id) => keptNow.includes(id)), 'Generera keeps the whole block where the hand put it');
      // Moved again: nothing left to lock, nothing said.
      const again = await masters.moveBlockCard({ lessonIds: [B1, B2], dayOfWeek: 2, startTime: '13:00', endTime: '14:00' } as never, a.caller);
      assert.deepEqual([again.lockedLessonIds, again.lockedByMove], [[], undefined]);
      // The block is unlocked as a block, by the ids the answer named (lockBlock).
      await masters.lockBlock({ blockId: block, isLocked: false, lessonIds: moved.lockedLessonIds } as never, a.caller);
      assert.ok((await lockedOf()).every((row) => !row.locked));

      // (br-e) a swap that moves ONE card of the block does not lock that card: Generera refuses a block with some of its lessons locked and the rest
      // to place (BLOCK_PARTLY_LOCKED); a swap that moves every card of the block locks it whole (granskaren g505, M-1).
      await check('(br-e) a swap of one card of a block with two cards locks the plain lesson only; a swap of both cards locks the block whole', async () => {
        const swaps = new SwapsService(api, masters, new ScheduleVersionsService(api), realtime as never, notifications as never);
        const slotOf = (day: number, start: string) => ({ dayOfWeek: day, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00` });
        const put = async (id: string, day: number, start: string) =>
          owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = $2, "startTime" = $3, "endTime" = $4, "isLocked" = false, "isGenerated" = true WHERE id = $1`, [id, day, start, slotOf(day, start).endTime]);
        await put(B1, 3, '10:00');
        await put(B2, 3, '10:00');
        await put(B3, 5, '10:00');
        await put(B4, 5, '10:00');
        await put(L2, 2, '10:00');
        await put(L1, 4, '13:00'); // out of the way: (br-b) left it double-booked beside L2
        // The moves of the swap, written out: the card on Wednesday 10:00 and L2 on Tuesday 10:00 change places; the chain moves the other card too.
        const at = (day: number, start: string) => ({ dayOfWeek: day, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00` });
        const move = (lessonId: string, from: ReturnType<typeof at>, to: ReturnType<typeof at>) => ({ lessonId, from, to });
        const card = [move(B1, at(3, '10:00'), at(2, '10:00')), move(B2, at(3, '10:00'), at(2, '10:00')), move(L2, at(2, '10:00'), at(3, '10:00'))];
        const answer = await swaps.apply({ lessonId: L2, moves: card } as never, a.caller);
        assert.deepEqual(answer.lockedLessonIds, [L2], 'only the plain lesson is locked');
        assert.ok((await lockedOf()).every((row) => !row.locked), 'the block is not partly locked: Generera would refuse it');
        assert.equal((await stateOf(L2)).locked, true);

        // Both cards move (a chain: B1 and B2 to Tuesday 10:00, B3 and B4 to Wednesday 10:00, L2 to Friday 10:00): the block is locked whole.
        await put(B1, 3, '10:00');
        await put(B2, 3, '10:00');
        await put(B3, 5, '10:00');
        await put(B4, 5, '10:00');
        await put(L2, 2, '10:00');
        const chain = [
          move(B1, at(3, '10:00'), at(2, '10:00')),
          move(B2, at(3, '10:00'), at(2, '10:00')),
          move(B3, at(5, '10:00'), at(3, '10:00')),
          move(B4, at(5, '10:00'), at(3, '10:00')),
          move(L2, at(2, '10:00'), at(5, '10:00')),
        ];
        const whole = await swaps.apply({ lessonId: L2, moves: chain } as never, a.caller);
        assert.deepEqual([...whole.lockedLessonIds].sort(), [L2, B1, B2, B3, B4].sort());
        assert.ok((await lockedOf()).every((row) => row.locked), 'every lesson of the block is locked');
      });
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

  // A school of its own for the swap: two lessons of one class that can change places.
  const swapSlug = `${SLUG}-1`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [swapSlug]);
  try {
    const b = await plant(owner, swapSlug, {
      classes: [{ key: '7A', grade: 7 }],
      teachers: ['T1', 'T2'],
      rooms: ['R1'],
      subjects: ['Matematik', 'Kemi'],
      lessons: [
        { key: 'S1', class: '7A', subject: 'Matematik', teacher: 'T1', day: 1, start: '09:00', minutes: 60 },
        { key: 'S2', class: '7A', subject: 'Kemi', teacher: 'T2', day: 2, start: '10:00', minutes: 60 },
      ],
      unavailable: [],
      frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
      meals: [],
    });
    const S1 = b.lessonId.get('S1')!;
    const S2 = b.lessonId.get('S2')!;
    const swaps = new SwapsService(api, masters, new ScheduleVersionsService(api), realtime as never, notifications as never);
    const stateOf = async (id: string) => (await owner.query<{ locked: boolean; day: number; start: string }>(`SELECT "isLocked" AS locked, "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start FROM "MasterLessons" WHERE id = $1`, [id])).rows[0]!;
    const keptOf = async (): Promise<string[]> => api.withRls(b.caller, async (tx) => (await tx.masterLesson.findMany({ where: keptMastersWhere(b.year), select: { id: true } })).map((row) => row.id));
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const slot = (value: { dayOfWeek: number; startMinutes: number; endMinutes: number }) => ({ dayOfWeek: value.dayOfWeek, startTime: clock(value.startMinutes), endTime: clock(value.endMinutes) });
    const body = (lessonId: string, moves: ReadonlyArray<{ lessonId: string; from: Parameters<typeof slot>[0]; to: Parameters<typeof slot>[0] }>) => ({
      lessonId,
      moves: moves.map((move) => ({ lessonId: move.lessonId, from: slot(move.from), to: slot(move.to) })),
    });

    await check('(br-c) a swap locks the two lessons it moves, in sight, and Generera keeps them; the undo takes the lock off again', async () => {
      await owner.query(`UPDATE "MasterLessons" SET "isGenerated" = true, "isLocked" = false WHERE id = ANY($1::uuid[])`, [[S1, S2]]);
      assert.ok(!(await keptOf()).includes(S1), 'a lesson Generera laid and nobody locked is not kept');
      const offered = await swaps.suggest({ lessonId: S1, limit: 20 }, b.caller);
      const swap = offered.proposals.find((proposal) => proposal.kind === 'SWAP' && proposal.moves.some((move) => move.lessonId === S2));
      assert.ok(swap, 'the two lessons can change places');
      const applied = await swaps.apply(body(S1, swap.moves), b.caller);
      assert.equal(applied.lockedByMove, true);
      assert.deepEqual([...applied.lockedLessonIds].sort(), [S1, S2].sort());
      assert.deepEqual(await stateOf(S1), { locked: true, day: 2, start: '10:00' });
      assert.deepEqual(await stateOf(S2), { locked: true, day: 1, start: '09:00' });
      assert.ok((await keptOf()).includes(S1) && (await keptOf()).includes(S2), 'Generera keeps both where the hand put them');
      // The undo is the same moves reversed, sent to the same route: the partner is locked, and the swap that locked it is what is taken back.
      const undone = await swaps.apply(body(S1, applied.undo), b.caller);
      assert.deepEqual([undone.lockedLessonIds, undone.lockedByMove], [[], undefined]);
      assert.deepEqual(await stateOf(S1), { locked: false, day: 1, start: '09:00' });
      assert.deepEqual(await stateOf(S2), { locked: false, day: 2, start: '10:00' });
      // A lock the hand set afterwards is no lock the swap put there: the partner is refused.
      const again = await swaps.apply(body(S1, swap.moves), b.caller);
      await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true WHERE id = $1`, [S2]);
      await owner.query(`DELETE FROM "ScheduleChangeLogs" WHERE "masterLessonId" = $1`, [S2]);
      let refused: HttpException | undefined;
      try {
        await swaps.apply(body(S1, again.undo), b.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 409);
      assert.equal((refused?.getResponse() as { code?: string }).code, 'SWAP_LOCKED');
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [swapSlug]);
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
