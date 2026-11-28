/**
 * Gör plats för en bricka, mot en riktig databas som API-rollen under RLS, genom de riktiga tjänsterna (E5a, g514 L-7 och L-4):
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-lagg-i-bytet.ts
 *
 * Skolan är en klass med en lektion i vägen för en bricka: 7A:s Matematik (en bricka, posten ger en lektion i veckan) ska ligga måndag 09:00, där 7A:s Kemi
 * ligger, och Kemin har en annan tid att gå till.
 *
 *   (lb-a) ett byte som gör plats för en bricka och lägger den i SAMMA transaktion: Kemin flyttad, Matematiken lagd, låst, EN version och en loggrad per
 *          lektion, och brickan är borta ur brickorna;
 *   (lb-b) en läggning som nekas efter flytten (en bild av delen som ändrats: 409 REQUIREMENT_PLACEMENTS_STALE) tar flytten med sig: Kemin ligger kvar, ingen
 *          ny lektion, ingen version, ingen loggrad, och brickan finns kvar;
 *   (lb-c) en läggning som domaren nekar efter flytten (en söndag, SCHOOL_DAY) gör likadant;
 *   (lb-d) en läggning av ett annat läsår än flyttarnas är 400 och ingenting skrivs;
 *   (lb-e) ett förslag med EN lektion (en ledig tid behöver ingen annan) kan läggas av `apply` utan forBrick: lektionen flyttas, låses och loggas, och ångran
 *          (samma flytt baklänges) tar den tillbaka;
 *   (lb-f) en sal som generatorn inte skulle ta (BOARD_ROOM_NOT_ALLOWED) och (lb-g) en lärare som är upptagen (MASTER_LESSON_REFUSED, TEACHER) nekar läggningen
 *          efter flytten och tar flytten med sig, som (lb-b) och (lb-c);
 *   (lb-h) sex `apply` med varsin flytt och samma läggning, lästa samtidigt: en lägger, fem får 409 REQUIREMENT_PLACEMENTS_STALE, och bara den enas lektion har flyttats;
 *   (lb-i) en lektion i bytet som hör till brickans egen post (samma klass, ämne, lärare och längd) ändrar inte delens bild: läggningen med den gamla `partKey` går.
 *
 * Ett eget skolspår (slug `probe-lagg-i-bytet`) som tas bort.
 */
import { strict as assert } from 'node:assert';
import { Client } from 'pg';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapsService, type SwapProposalView } from '../../src/swaps/swaps.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-lagg-i-bytet';
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '8B', grade: 8 }],
  teachers: ['T1', 'T2', 'T3'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik', 'Kemi', 'Historia', 'Svenska', 'Bild'],
  lessons: [
    { key: 'KEMI', class: '7A', subject: 'Kemi', teacher: 'T2', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'HIST', class: '8B', subject: 'Historia', teacher: 'T3', room: 'R2', day: 2, start: '09:00', minutes: 60 },
    // (lb-g) T1 teaches 8B on Wednesday 09:00: a lay of T1's brick there is a teacher clash.
    { key: 'T1BUSY', class: '8B', subject: 'Matematik', teacher: 'T1', day: 3, start: '09:00', minutes: 60 },
    // (lb-h) six lessons of 8B on Friday, each its own request's move.
    ...[8, 9, 10, 11, 12, 13].map((hour, index) => ({ key: `S${index + 1}`, class: '8B', subject: 'Historia', teacher: 'T3', day: 5, start: `${String(hour).padStart(2, '0')}:00`, minutes: 60 })),
    // (lb-i) the one lesson of a post of two that stands where its own brick is wanted.
    { key: 'BILD1', class: '7A', subject: 'Bild', teacher: 'T1', day: 2, start: '10:00', minutes: 60 },
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
  const tray = new BoardTrayService(api, masters);
  const swaps = new SwapsService(api, masters, new ScheduleVersionsService(api), realtime as never, notifications as never);
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
    const count = async (table: string): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "${table}" WHERE "schoolId" = $1`, [a.school]))[0]!.n);
    const t1 = a.teacherId.get('T1')!;
    const kemi = a.lessonId.get('KEMI')!;
    const hist = a.lessonId.get('HIST')!;
    const post = (
      await q<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 1, 60, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
        [a.school, a.year, a.subjectId.get('Matematik'), a.classId.get('7A'), t1],
      )
    )[0]!.id;
    const bricks = async () => (await tray.trayOfYear(a.year, undefined, a.caller)).bricks.filter((brick) => brick.postId === post);
    const stored = async (id: string) => (await q<{ dayOfWeek: number; startTime: string; isLocked: boolean }>(`SELECT "dayOfWeek", to_char("startTime", 'HH24:MI') AS "startTime", "isLocked" FROM "MasterLessons" WHERE id = $1`, [id]))[0]!;
    const brickAsked = (brick: Awaited<ReturnType<typeof bricks>>[number]) => ({ academicYearId: a.year, studentGroupId: brick.studentGroupId, subjectId: brick.subjectId, minutes: brick.minutes, teacherId: brick.teacherId ?? undefined });
    const layOf = (partKey: string, over: Record<string, unknown> = {}) => ({ academicYearId: a.year, postId: post, teacherId: t1, minutes: 60, partKey, dayOfWeek: 1, startTime: '09:00', roomId: null, ...over });
    const bodyOf = (proposal: SwapProposalView, over: Record<string, unknown> = {}) => ({
      forBrick: true,
      moves: proposal.moves.map((m) => ({
        lessonId: m.lessonId,
        from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
        to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
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

    const brick = (await bricks())[0]!;
    assert.equal((await bricks()).length, 1, 'the post has one brick to lay');
    const answer = await swaps.suggest({ brick: brickAsked(brick), makeRoom: { dayOfWeek: 1, startTime: '09:00' }, limit: 12 } as never, a.caller);
    assert.ok(answer.proposals.length > 0, 'Gör plats finds a way to make room for the brick');
    const proposal = answer.proposals.find((p) => p.moves.length === 1 && p.moves[0]!.lessonId === kemi)!;
    assert.ok(proposal, 'the Kemi lesson goes somewhere else');

    await check('(lb-c) a lay the judge refuses after the moves (a Sunday) takes the moves back', async () => {
      const before = { kemi: await stored(kemi), lessons: await count('MasterLessons'), versions: await count('ScheduleVersions'), logs: await count('ScheduleChangeLogs') };
      // A Sunday is no school day: the judge refuses the lay (the write path's own rule, as for a hand edit) after the Kemi lesson has been moved.
      const sunday = await refusal(swaps.apply(bodyOf(proposal, { lay: layOf(brick.partKey, { dayOfWeek: 7 }) }) as never, a.caller));
      assert.deepEqual(sunday, { status: 409, code: 'MASTER_LESSON_REFUSED' });
      assert.deepEqual(await stored(kemi), before.kemi, 'the Kemi lesson did not move');
      assert.equal(await count('MasterLessons'), before.lessons, 'no lesson was made');
      assert.equal(await count('ScheduleVersions'), before.versions, 'no version was kept');
      assert.equal(await count('ScheduleChangeLogs'), before.logs, 'no log row was written');
      assert.equal((await bricks()).length, 1, 'the brick is still to lay');
    });

    await check('(lb-b) a lay that is refused for a part that has changed takes the moves back: nothing moved, nothing made, no version, no log row', async () => {
      const before = { kemi: await stored(kemi), lessons: await count('MasterLessons'), versions: await count('ScheduleVersions'), logs: await count('ScheduleChangeLogs') };
      const stale = await refusal(swaps.apply(bodyOf(proposal, { lay: layOf('ffffffffffffffff') }) as never, a.caller));
      assert.deepEqual(stale, { status: 409, code: 'REQUIREMENT_PLACEMENTS_STALE' });
      assert.deepEqual(await stored(kemi), before.kemi, 'the Kemi lesson did not move');
      assert.equal(await count('MasterLessons'), before.lessons);
      assert.equal(await count('ScheduleVersions'), before.versions);
      assert.equal(await count('ScheduleChangeLogs'), before.logs);
      assert.equal((await bricks()).length, 1);
    });

    await check('(lb-d) a lay of another läsår than the moves’ is a 400 and nothing is written', async () => {
      const before = { kemi: await stored(kemi), lessons: await count('MasterLessons'), versions: await count('ScheduleVersions') };
      const other = await refusal(swaps.apply(bodyOf(proposal, { lay: layOf(brick.partKey, { academicYearId: '99999999-9999-4999-8999-999999999999' }) }) as never, a.caller));
      assert.equal(other.status, 400);
      assert.deepEqual(await stored(kemi), before.kemi);
      assert.equal(await count('MasterLessons'), before.lessons);
      assert.equal(await count('ScheduleVersions'), before.versions);
    });

    await check('(lb-f) a room the generator would not take refuses the lay after the moves, and takes the moves back', async () => {
      // R2 is fenced from the years of 7A: the same refusal Att lägga gives a lay alone (BOARD_ROOM_NOT_ALLOWED, YEARS).
      await owner.query(`UPDATE "Rooms" SET "minGradeLevel" = 1, "maxGradeLevel" = 3 WHERE id = $1`, [a.roomId.get('R2')]);
      try {
        const before = { kemi: await stored(kemi), lessons: await count('MasterLessons'), versions: await count('ScheduleVersions'), logs: await count('ScheduleChangeLogs') };
        const room = await refusal(swaps.apply(bodyOf(proposal, { lay: layOf(brick.partKey, { roomId: a.roomId.get('R2') }) }) as never, a.caller));
        assert.deepEqual(room, { status: 409, code: 'BOARD_ROOM_NOT_ALLOWED' });
        assert.deepEqual(await stored(kemi), before.kemi, 'the Kemi lesson did not move');
        assert.equal(await count('MasterLessons'), before.lessons);
        assert.equal(await count('ScheduleVersions'), before.versions);
        assert.equal(await count('ScheduleChangeLogs'), before.logs);
        assert.equal((await bricks()).length, 1);
      } finally {
        await owner.query(`UPDATE "Rooms" SET "minGradeLevel" = NULL, "maxGradeLevel" = NULL WHERE id = $1`, [a.roomId.get('R2')]);
      }
    });

    await check('(lb-g) a teacher who is busy refuses the lay after the moves, and takes the moves back', async () => {
      const before = { kemi: await stored(kemi), lessons: await count('MasterLessons'), versions: await count('ScheduleVersions'), logs: await count('ScheduleChangeLogs') };
      const busy = await refusal(swaps.apply(bodyOf(proposal, { lay: layOf(brick.partKey, { dayOfWeek: 3, startTime: '09:00' }) }) as never, a.caller));
      assert.deepEqual(busy, { status: 409, code: 'MASTER_LESSON_REFUSED' });
      assert.deepEqual(await stored(kemi), before.kemi, 'the Kemi lesson did not move');
      assert.equal(await count('MasterLessons'), before.lessons);
      assert.equal(await count('ScheduleVersions'), before.versions);
      assert.equal(await count('ScheduleChangeLogs'), before.logs);
    });

    await check('(lb-h) six apply with a move each and one lay, read at once: one lays, five are 409 REQUIREMENT_PLACEMENTS_STALE, and only the winner’s lesson has moved', async () => {
      const t2 = a.teacherId.get('T2')!;
      const second = (
        await q<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 1, 60, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get('Svenska'), a.classId.get('8B'), t2],
        )
      )[0]!.id;
      const key = (await tray.trayOfYear(a.year, undefined, a.caller)).bricks.find((entry) => entry.postId === second)!.partKey;
      const friday = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((name) => a.lessonId.get(name)!);
      const before = await Promise.all(friday.map((id) => stored(id)));
      const settled = await Promise.allSettled(
        friday.map((id, index) =>
          swaps.apply(
            {
              forBrick: true,
              moves: [{ lessonId: id, from: { dayOfWeek: 5, startTime: clock((8 + index) * 60), endTime: clock((9 + index) * 60) }, to: { dayOfWeek: 1, startTime: clock((8 + index) * 60), endTime: clock((9 + index) * 60) } }],
              lay: { academicYearId: a.year, postId: second, teacherId: t2, minutes: 60, partKey: key, dayOfWeek: 2 + (index % 3), startTime: '14:00', roomId: null },
            } as never,
            a.caller,
          ),
        ),
      );
      assert.equal(settled.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'one lays');
      for (const outcome of settled) {
        if (outcome.status === 'rejected') assert.equal((outcome.reason as { getResponse: () => { code: string } }).getResponse().code, 'REQUIREMENT_PLACEMENTS_STALE');
      }
      const after = await Promise.all(friday.map((id) => stored(id)));
      assert.equal(after.filter((now, index) => now.dayOfWeek !== before[index]!.dayOfWeek || now.startTime !== before[index]!.startTime).length, 1, 'only the winner’s lesson moved');
      assert.equal(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE "schoolId" = $1 AND "subjectId" = $2 AND "studentGroupId" = $3`, [a.school, a.subjectId.get('Svenska'), a.classId.get('8B')]))[0]!.n), 1, 'one lesson was made');
    });

    await check('(lb-i) a lesson of the brick’s own post goes out of the way and is locked by the move: the part is the picture it was, and the lay with the old key goes', async () => {
      const bild = (
        await q<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 2, 60, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get('Bild'), a.classId.get('7A'), t1],
        )
      )[0]!.id;
      const own = (await tray.trayOfYear(a.year, undefined, a.caller)).bricks.filter((entry) => entry.postId === bild);
      assert.equal(own.length, 1, 'one of the post’s two lessons stands, so one brick is left');
      const bild1 = a.lessonId.get('BILD1')!;
      const ask = await swaps.suggest({ brick: brickAsked(own[0]!), makeRoom: { dayOfWeek: 2, startTime: '10:00' }, limit: 12 } as never, a.caller);
      const way = ask.proposals.find((p) => p.moves.length === 1 && p.moves[0]!.lessonId === bild1);
      assert.ok(way, 'the post’s own other lesson is the one in the way');
      const result = await swaps.apply(bodyOf(way, { lay: { academicYearId: a.year, postId: bild, teacherId: t1, minutes: 60, partKey: own[0]!.partKey, dayOfWeek: 2, startTime: '10:00', roomId: null } }) as never, a.caller);
      assert.ok(result.laid, 'laid');
      assert.equal((await tray.trayOfYear(a.year, undefined, a.caller)).bricks.filter((entry) => entry.postId === bild).length, 0);
      assert.equal((await stored(bild1)).isLocked, true, 'the lesson that went out of the way is locked by the move');
    });

    await check('(lb-a) the moves and the lay are one transaction: the Kemi lesson moved, Matematik laid and locked, one version, a log row for each, the brick gone', async () => {
      const lessons = await count('MasterLessons');
      const versions = await count('ScheduleVersions');
      const logs = await count('ScheduleChangeLogs');
      const result = await swaps.apply(bodyOf(proposal, { lay: layOf(brick.partKey) }) as never, a.caller);
      const move = proposal.moves[0]!;
      const moved = await stored(kemi);
      assert.equal(moved.dayOfWeek, move.to.dayOfWeek);
      assert.equal(moved.startTime, clock(move.to.startMinutes));
      assert.equal(moved.isLocked, true, 'a lesson moved by hand is the school’s (E4)');
      assert.equal(await count('MasterLessons'), lessons + 1, 'one lesson was made');
      const made = (await q<{ id: string; dayOfWeek: number; startTime: string; isLocked: boolean; teacherId: string }>(`SELECT id, "dayOfWeek", to_char("startTime", 'HH24:MI') AS "startTime", "isLocked", "teacherId" FROM "MasterLessons" WHERE "subjectId" = $1 AND "studentGroupId" = $2`, [a.subjectId.get('Matematik'), a.classId.get('7A')]))[0]!;
      assert.deepEqual({ day: made.dayOfWeek, start: made.startTime, locked: made.isLocked, teacher: made.teacherId }, { day: 1, start: '09:00', locked: true, teacher: t1 });
      assert.equal((result.laid!.lesson as { id: string }).id, made.id, 'the answer names the lesson that was laid');
      assert.equal(await count('ScheduleVersions'), versions + 1, 'one safety version, taken before the first write');
      assert.equal(await count('ScheduleChangeLogs'), logs + 2, 'a row for the lesson moved and a row for the lesson made');
      assert.equal((await bricks()).length, 0, 'the post has no brick left');
    });

    await check('(lb-e) one lesson’s move is a proposal: a lesson moved alone to a free time is moved, locked and logged, and the undo takes it back', async () => {
      const ask = await swaps.suggest({ lessonId: hist, makeRoom: { dayOfWeek: 4, startTime: '10:00' }, limit: 3 } as never, a.caller);
      const alone = ask.proposals.find((p) => p.moves.length === 1)!;
      assert.ok(alone, 'a free time is answered with the single move');
      const before = await stored(hist);
      const versions = await count('ScheduleVersions');
      const applied = await swaps.apply({ lessonId: hist, moves: bodyOf(alone).moves } as never, a.caller);
      const moved = await stored(hist);
      assert.deepEqual({ day: moved.dayOfWeek, start: moved.startTime, locked: moved.isLocked }, { day: 4, start: '10:00', locked: true });
      assert.equal(await count('ScheduleVersions'), versions + 1);
      await swaps.apply(
        {
          lessonId: hist,
          moves: applied.undo.map((m) => ({
            lessonId: m.lessonId,
            from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
            to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
          })),
        } as never,
        a.caller,
      );
      const back = await stored(hist);
      assert.deepEqual({ day: back.dayOfWeek, start: back.startTime }, { day: before.dayOfWeek, start: before.startTime });
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
