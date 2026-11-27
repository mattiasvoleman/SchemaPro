/**
 * Att lägga (E4), skrivvägen mot en riktig databas som API-rollen under RLS, genom de riktiga tjänsterna (granskaren g490):
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-att-lagga-skrivvagen.ts
 *
 *   (sk-a) en parkerad lektion är en bricka bara om den, tillbakalagd, svarar posten: en för alla veckor bredvid en post för ojämna veckor är ingen bricka;
 *   (sk-b) en lagd bricka svarar sin post (term och ojämna veckor): postens brickor blir en färre;
 *   (sk-c) en sal generatorn inte skulle ta (fel typ) nekas med skälet, en Labb tas, och ingen sal är "Utan sal";
 *   (sk-d) domaren dömer läggningen som en handredigering: en lördag och en söndag nekas (SCHOOL_DAY), en tid utanför klassens ramtid nekas (FRAME), och en
 *          nekad läggning skriver ingenting och förbrukar inte nyckeln; med `exempt: ['FRAME']` läggs den, låst, med undantaget sparat;
 *   (sk-e) en läggning som inte nämner lektionen när delens alla bricka är parkerade lektioner nekas som en gammal bild, och ingen ny lektion görs;
 *   (sk-f) sex som läst samma bild och lägger varsin: en skriver, fem får 409 REQUIREMENT_PLACEMENTS_STALE och ingenting skrivs för dem.
 *
 * Ett eget skolspår (slug `probe-att-lagga-skrivvagen`) som tas bort.
 */
import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-att-lagga-skrivvagen';
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik'],
  lessons: [],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const masters = new MasterLessonsService(api, { notifyMasterTimetableChanged: () => undefined } as never, { recipientsForLessons: async () => [], notifyUsers: async () => undefined } as never);
  const tray = new BoardTrayService(api, masters);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
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
    const t1 = a.teacherId.get('T1')!;
    const t2 = a.teacherId.get('T2')!;
    const labb = (await q<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, 'Labb', now()) RETURNING id`, [a.school]))[0]!.id;
    await owner.query(`UPDATE "Rooms" SET "roomTypeId" = $1 WHERE id = $2`, [labb, a.roomId.get('R2')]);
    const subject = async (name: string, needsLab = false) => {
      const id = (await q<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [a.school, name, needsLab ? labb : null]))[0]!.id;
      a.subjectId.set(name, id);
      return id;
    };
    const post = async (subjectName: string, teacher: string, lessons: number, minutes: number, recurrence = 'ALL_WEEKS', start: string | null = null, end: string | null = null) =>
      (
        await q<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "startDate", "endDate", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LessonRecurrence", $9, $10, now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get(subjectName), a.classId.get('7A'), teacher, lessons, minutes, recurrence, start, end],
        )
      )[0]!.id;
    const parkedLesson = async (subjectName: string, teacher: string, day: number, start: string, end: string, recurrence = 'ALL_WEEKS') =>
      (
        await q<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "isParked", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false, true, $9::"LessonRecurrence", now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get(subjectName), a.classId.get('7A'), teacher, day, start, end, recurrence],
        )
      )[0]!.id;
    const bricksOf = async (postId: string) => (await tray.trayOfYear(a.year, undefined, a.caller)).bricks.filter((brick) => brick.postId === postId);
    const req = (postId: string, teacher: string, minutes: number, partKey: string, day: number, start: string, extra: Record<string, unknown> = {}) =>
      ({ academicYearId: a.year, postId, teacherId: teacher, minutes, partKey, dayOfWeek: day, startTime: start, roomId: null, ...extra }) as never;
    const lessonsOf = async (subjectName: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE "academicYearId" = $1 AND "subjectId" = $2`, [a.year, a.subjectId.get(subjectName)]))[0]!.n);
    const refusal = async (promise: Promise<unknown>): Promise<{ status: number; code: string | undefined; reason: string | undefined }> => {
      try {
        await promise;
      } catch (error) {
        const e = error as { getStatus?: () => number; getResponse?: () => { code?: string; params?: { reason?: string } } };
        return { status: e.getStatus?.() ?? 500, code: e.getResponse?.()?.code, reason: e.getResponse?.()?.params?.reason };
      }
      throw new Error('the lay was not refused');
    };

    await check('(sk-a) a parked lesson of every week is no brick of a post of odd weeks: laid back it answers none of the post', async () => {
      await subject('Bild');
      const p = await post('Bild', t1, 1, 60, 'ODD_WEEKS');
      await parkedLesson('Bild', t1, 2, '09:00', '10:00', 'ALL_WEEKS');
      const bricks = await bricksOf(p);
      assert.deepEqual(bricks.map((brick) => brick.lessonId), [null]);
      await tray.lay(req(p, t1, 60, bricks[0]!.partKey, 3, '09:00'), a.caller);
      assert.equal((await bricksOf(p)).length, 0, 'the post has no brick left after its one lay');
    });

    await check('(sk-b) a laid brick answers its own post: a term and odd weeks', async () => {
      await subject('Idrott');
      const term = await post('Idrott', t1, 2, 60, 'ALL_WEEKS', '2027-01-11', '2027-06-11');
      await tray.lay(req(term, t1, 60, (await bricksOf(term))[0]!.partKey, 4, '10:00'), a.caller);
      assert.equal((await bricksOf(term)).length, 1);
      await subject('Geo');
      const odd = await post('Geo', t2, 2, 60, 'ODD_WEEKS');
      await tray.lay(req(odd, t2, 60, (await bricksOf(odd))[0]!.partKey, 5, '10:00'), a.caller);
      assert.equal((await bricksOf(odd)).length, 1);
    });

    await check('(sk-c) a room the generator would not use is refused with the reason, a Labb is laid, and no room is "Utan sal"', async () => {
      await subject('Kemi', true);
      const p = await post('Kemi', t2, 3, 60);
      const key = (await bricksOf(p))[0]!.partKey;
      const before = await lessonsOf('Kemi');
      const wrong = await refusal(tray.lay(req(p, t2, 60, key, 1, '10:00', { roomId: a.roomId.get('R1') }), a.caller));
      assert.deepEqual(wrong, { status: 409, code: 'BOARD_ROOM_NOT_ALLOWED', reason: 'TYPE' });
      assert.equal(await lessonsOf('Kemi'), before, 'nothing was written');
      const right = await tray.lay(req(p, t2, 60, key, 1, '10:00', { roomId: a.roomId.get('R2') }), a.caller);
      assert.equal(right.noRoom, false, 'the refusal did not spend the key');
      const none = await tray.lay(req(p, t2, 60, (await bricksOf(p))[0]!.partKey, 2, '10:00'), a.caller);
      assert.equal(none.noRoom, true);
    });

    await check('(sk-d) the judge judges a lay as a hand edit: the school day, the frame, the exemption; a refused lay writes nothing and spends no key', async () => {
      await subject('Slojd');
      const p = await post('Slojd', t1, 4, 60);
      const key = (await bricksOf(p))[0]!.partKey;
      const before = await lessonsOf('Slojd');
      assert.deepEqual(await refusal(tray.lay(req(p, t1, 60, key, 6, '09:00'), a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED', reason: 'SCHOOL_DAY' });
      assert.deepEqual(await refusal(tray.lay(req(p, t1, 60, key, 7, '09:00'), a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED', reason: 'SCHOOL_DAY' });
      assert.deepEqual(await refusal(tray.lay(req(p, t1, 60, key, 1, '16:00'), a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED', reason: 'FRAME' });
      assert.equal(await lessonsOf('Slojd'), before, 'nothing was written');
      assert.equal((await bricksOf(p))[0]!.partKey, key, 'the part is the picture it was');
      // An exemption is for the rules a lesson may break on purpose: the frame yes, the school day no.
      assert.deepEqual(await refusal(tray.lay(req(p, t1, 60, key, 6, '09:00', { exempt: ['FRAME'] }), a.caller)), { status: 409, code: 'MASTER_LESSON_REFUSED', reason: 'SCHOOL_DAY' });
      await tray.lay(req(p, t1, 60, key, 1, '16:00', { exempt: ['FRAME'] }), a.caller);
      const stored = (await q<{ locked: boolean; exempt: string[] | null }>(`SELECT "isLocked" AS locked, "exemptFrom" AS exempt FROM "MasterLessons" WHERE "academicYearId" = $1 AND "subjectId" = $2`, [a.year, a.subjectId.get('Slojd')]))[0]!;
      assert.deepEqual(stored, { locked: true, exempt: ['FRAME'] });
    });

    await check('(sk-e) a lay that names no lesson, when every brick of the part is a lesson on the tray, is refused as a stale picture and makes no second lesson', async () => {
      await subject('Hem');
      const p = await post('Hem', t2, 1, 60);
      const parked = await parkedLesson('Hem', t2, 3, '09:00', '10:00');
      const bricks = await bricksOf(p);
      assert.deepEqual(bricks.map((brick) => brick.lessonId), [parked]);
      assert.deepEqual(await refusal(tray.lay(req(p, t2, 60, bricks[0]!.partKey, 4, '09:00'), a.caller)), { status: 409, code: 'REQUIREMENT_PLACEMENTS_STALE', reason: undefined });
      assert.equal(await lessonsOf('Hem'), 1, 'no lesson was made beside the parked one');
      const moved = await tray.lay(req(p, t2, 60, bricks[0]!.partKey, 4, '09:00', { lessonId: parked }), a.caller);
      assert.equal((moved.lesson as { id: string }).id, parked);
      assert.equal(await lessonsOf('Hem'), 1);
    });

    await check('(sk-f) six who read one picture and lay one each: one writes, five get 409 REQUIREMENT_PLACEMENTS_STALE, and nothing is written for them', async () => {
      await subject('Musik');
      const p = await post('Musik', t1, 6, 45);
      const key = (await bricksOf(p))[0]!.partKey;
      const days = [1, 2, 3, 4, 5, 1];
      const settled = await Promise.allSettled(days.map((day, index) => tray.lay(req(p, t1, 45, key, day, index === 5 ? '11:00' : '09:00'), a.caller)));
      assert.equal(settled.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      for (const outcome of settled) {
        if (outcome.status === 'rejected') assert.equal((outcome.reason as { getResponse: () => { code: string } }).getResponse().code, 'REQUIREMENT_PLACEMENTS_STALE');
      }
      assert.equal(await lessonsOf('Musik'), 1);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
