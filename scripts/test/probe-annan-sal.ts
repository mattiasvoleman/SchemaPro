/**
 * Annan ledig sal (E5a): en flyttad lektion får ta en annan sal, mot en riktig databas som API-rollen under RLS, genom de riktiga tjänsterna:
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-annan-sal.ts
 *
 * Skolan: 7A:s Matematik (A, T1, R1) ligger tisdag 09:00, 7A:s Kemi (H, T2, R2) tisdag 10:00, och 8B:s Kemi (X, T3, R2) håller R2 tisdag 09:00. A frågas
 * efter tisdag 10:00, där H står i vägen (samma klass); H får gå till tisdag 09:00 (A:s tid), och där är dess egen sal R2 hållen av X.
 *
 *   (as-a) utan `otherRooms` svarar Gör plats som förut: ingen flytt bär en sal;
 *   (as-b) med den tar H sal R3 (den bästa som är ledig då och passar: R1 är A:s till dess A gått), A behåller R1, och X flyttas inte;
 *   (as-c) förslaget tillämpat skriver salen med dag och klockslag, tar EN version, loggar salen före och efter, och ångran (samma flyttar baklänges) sätter
 *          tillbaka lektionerna och salarna;
 *   (as-d) en lektion som fått annan sal sedan förslaget är SWAP_STALE och ingenting skrivs;
 *   (as-e) en sal som inte är skolans (en annan skolas, som RLS döljer) är 400 och ingenting skrivs;
 *   (as-f) en sal som en annan lektion står i då nekas av krockregeln (409 MASTER_LESSON_REFUSED) och ingenting skrivs, och samma flytt utan saländringen, med
 *          den egna salen R2 som X håller, nekas likadant: det är salen som döms.
 *
 * Ett eget skolspår (slug `probe-annan-sal`) som tas bort.
 */
import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapsService, type SwapProposalView } from '../../src/swaps/swaps.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-annan-sal';
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '8B', grade: 8 }, { key: '9C', grade: 9 }],
  teachers: ['T1', 'T2', 'T3', 'T4'],
  rooms: ['R1', 'R2', 'R3'],
  subjects: ['Matematik', 'Kemi'],
  lessons: [
    { key: 'A', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 2, start: '09:00', minutes: 60 },
    { key: 'H', class: '7A', subject: 'Kemi', teacher: 'T2', room: 'R2', day: 2, start: '10:00', minutes: 60 },
    { key: 'X', class: '8B', subject: 'Kemi', teacher: 'T3', room: 'R2', day: 2, start: '09:00', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const swaps = new SwapsService(api, masters, new ScheduleVersionsService(api), realtime as never, notifications as never);
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [SLUG, `${SLUG}-andra`]);
  let failures = 0;
  const check = async (label: string, body: () => Promise<void>) => {
    try {
      await body();
      console.log(`  ok  ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL  ${label}\n        ${error instanceof Error ? error.message.replace(/\n/g, '\n        ') : String(error)}`);
    }
  };
  try {
    const a = await plant(owner, SLUG, WORLD);
    const q = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
    const count = async (table: string): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "${table}" WHERE "schoolId" = $1`, [a.school]))[0]!.n);
    const [lessonA, lessonH, lessonX] = ['A', 'H', 'X'].map((key) => a.lessonId.get(key)!) as [string, string, string];
    const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((key) => a.roomId.get(key)!) as [string, string, string];
    const stored = async (id: string) =>
      (await q<{ dayOfWeek: number; startTime: string; roomId: string; isLocked: boolean }>(`SELECT "dayOfWeek", to_char("startTime", 'HH24:MI') AS "startTime", "roomId", "isLocked" FROM "MasterLessons" WHERE id = $1`, [id]))[0]!;
    const state = async () => ({ A: await stored(lessonA), H: await stored(lessonH), X: await stored(lessonX) });
    const bodyOf = (moves: SwapProposalView['moves'], over: Record<string, unknown> = {}) => ({
      lessonId: lessonA,
      moves: moves.map((m) => ({
        lessonId: m.lessonId,
        from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
        to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
        ...(m.room ? { room: m.room } : {}),
      })),
      ...over,
    });
    const refusal = async (promise: Promise<unknown>): Promise<{ status: number; code: string | undefined }> => {
      try {
        await promise;
      } catch (error) {
        const e = error as { getStatus?: () => number; getResponse?: () => { code?: string } };
        return { status: e.getStatus?.() ?? 500, code: e.getResponse?.()?.code };
      }
      throw new Error('the apply was not refused');
    };
    const ask = (over: Record<string, unknown> = {}) => swaps.suggest({ lessonId: lessonA, makeRoom: { dayOfWeek: 2, startTime: '10:00', depth: 2, ...over }, limit: 20 } as never, a.caller);
    const original = await state();

    await check('(as-a) without otherRooms, Gör plats answers as before the rooms: no move carries a room', async () => {
      const answer = await ask();
      assert.ok(answer.proposals.length > 0, 'H goes somewhere');
      for (const proposal of answer.proposals) for (const move of proposal.moves) assert.equal(move.room, undefined);
    });

    const answer = await ask({ otherRooms: true });
    const proposal = answer.proposals.find((p) => p.moves.length === 2 && p.moves.some((m) => m.lessonId === lessonH && m.to.dayOfWeek === 2 && m.to.startMinutes === 540 && m.room !== undefined));

    await check('(as-b) with otherRooms, H lands at Tuesday 09:00 in R3 (R2 is X’s then), A keeps R1, and X does not move', async () => {
      assert.ok(proposal, 'the swap of A and H with a room for H is offered');
      const h = proposal.moves.find((m) => m.lessonId === lessonH)!;
      const aMove = proposal.moves.find((m) => m.lessonId === lessonA)!;
      assert.deepEqual(h.room, { from: r2, to: r3 });
      assert.equal(aMove.room, undefined);
      assert.ok(!proposal.moves.some((m) => m.lessonId === lessonX), 'X stays');
    });

    await check('(as-d) a lesson that has been given another room since the proposal is SWAP_STALE, and nothing is written', async () => {
      assert.ok(proposal);
      await owner.query(`UPDATE "MasterLessons" SET "roomId" = $2 WHERE id = $1`, [lessonH, r1]);
      const versions = await count('ScheduleVersions');
      const stale = await refusal(swaps.apply(bodyOf(proposal.moves) as never, a.caller));
      assert.deepEqual(stale, { status: 409, code: 'SWAP_STALE' });
      assert.equal(await count('ScheduleVersions'), versions);
      assert.equal((await stored(lessonA)).startTime, '09:00', 'A did not move');
      await owner.query(`UPDATE "MasterLessons" SET "roomId" = $2 WHERE id = $1`, [lessonH, r2]);
    });

    await check('(as-e) a room that is not the school’s is a 400 and nothing is written', async () => {
      assert.ok(proposal);
      const other = (await q<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`, [`${SLUG}-andra`]))[0]!.id;
      const foreign = (await q<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'Främmande', now()) RETURNING id`, [other]))[0]!.id;
      const moves = proposal.moves.map((m) => (m.room ? { ...m, room: { from: m.room.from, to: foreign } } : m));
      const versions = await count('ScheduleVersions');
      const refused = await refusal(swaps.apply(bodyOf(moves) as never, a.caller));
      assert.equal(refused.status, 400);
      assert.equal(await count('ScheduleVersions'), versions);
      assert.deepEqual(await state(), original);
      await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`${SLUG}-andra`]);
    });

    await check('(as-f) the room is what is judged: R2 kept (X holds it then) and R3 given while another lesson stands in it are double bookings, nothing is written', async () => {
      assert.ok(proposal);
      const versions = await count('ScheduleVersions');
      // H to Tuesday 09:00 with no room change keeps R2, which X holds then: refused by the clash rule.
      const plain = proposal.moves.map((m) => ({ ...m, room: undefined }));
      assert.deepEqual(await refusal(swaps.apply(bodyOf(plain) as never, a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED' });
      // A lesson of another class and teacher now stands in R3 on Tuesday 09:00 (as one would have been put there since the proposal was made): the room H is given is taken.
      const y = (
        await q<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 2, '09:00', '10:00', false, false, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get('Kemi'), a.classId.get('9C'), a.teacherId.get('T4'), r3],
        )
      )[0]!.id;
      try {
        assert.deepEqual(await refusal(swaps.apply(bodyOf(proposal.moves) as never, a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED' });
      } finally {
        await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [y]);
      }
      assert.equal(await count('ScheduleVersions'), versions, 'a refused apply keeps no version');
      assert.deepEqual(await state(), original);
    });

    await check('(as-c) the proposal applied writes the room with the day and the clock, one version, a log row with the room before and after; the undo puts both back', async () => {
      assert.ok(proposal);
      const versions = await count('ScheduleVersions');
      const logs = await count('ScheduleChangeLogs');
      const result = await swaps.apply(bodyOf(proposal.moves) as never, a.caller);
      const now = await state();
      assert.deepEqual({ day: now.H.dayOfWeek, start: now.H.startTime, room: now.H.roomId, locked: now.H.isLocked }, { day: 2, start: '09:00', room: r3, locked: true });
      assert.deepEqual({ day: now.A.dayOfWeek, start: now.A.startTime, room: now.A.roomId }, { day: 2, start: '10:00', room: r1 });
      assert.deepEqual(now.X, original.X, 'X was not touched');
      assert.equal(await count('ScheduleVersions'), versions + 1);
      assert.equal(await count('ScheduleChangeLogs'), logs + 2);
      const log = (await q<{ before: { roomId: string }; after: { roomId: string } }>(`SELECT before, after FROM "ScheduleChangeLogs" WHERE "masterLessonId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [lessonH]))[0]!;
      assert.deepEqual({ before: log.before.roomId, after: log.after.roomId }, { before: r2, after: r3 });
      const undone = await swaps.apply(bodyOf(result.undo as never) as never, a.caller);
      void undone;
      const back = await state();
      for (const key of ['A', 'H', 'X'] as const) assert.deepEqual({ d: back[key].dayOfWeek, s: back[key].startTime, r: back[key].roomId }, { d: original[key].dayOfWeek, s: original[key].startTime, r: original[key].roomId });
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [SLUG, `${SLUG}-andra`]);
    await owner.end();
    await api.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
