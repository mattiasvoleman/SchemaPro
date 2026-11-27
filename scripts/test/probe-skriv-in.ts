/**
 * Skriv in förläggningarna (E4b) against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-skriv-in.ts
 *
 *   (si-a) a förläggning that holds and names a room is written as the lesson Generera writes (the post's class, subject, teacher, room, clock and weeks,
 *          locked, the run's own, marked from a förläggning); the preview says what the write does; a second write over the same rows changes
 *          nothing: the same lessons, no version, no log row;
 *   (si-b) a row the week does not hold, a row that leaves the room to the engine and a block's row are named with their reasons and not written, and the
 *          rows that hold are;
 *   (si-c) a row moved since replaces its lesson; a lesson that answers a row the bridge does not write stays; the dated lessons of a replaced one go from the
 *          calendar, and a restore point is taken;
 *   (si-d) a written lesson is a placed lesson: a hand edit cannot move it (409 LESSON_IS_PLACED); another school's year is a 404; a year being rewritten
 *          by something else is a 409 SCHEDULE_BUSY and nothing is written.
 *
 * It works in schools of its own (slug `probe-skriv-in-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { PlacementWriteInService } from '../../src/requirement-placements/placement-write-in.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-skriv-in';

const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '7B', grade: 7 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik', 'Kemi', 'Musik', 'Språk A', 'Språk B'],
  lessons: [],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function skrivInChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const bridge = new PlacementWriteInService(api, new RequirementPlacementsService(api, masters), new ScheduleVersionsService(api), realtime as never);
  const slugs = [`${SLUG}-0`, `${SLUG}-1`];
  const cleanup = async () => {
    for (const slug of slugs) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  };
  await cleanup();
  try {
    const a = await plant(owner, slugs[0]!, WORLD);
    const b = await plant(owner, slugs[1]!, WORLD);
    const post = async (cls: string, subject: string, teacher: string, lessons: number, minutes: number, extra: { block?: string } = {}) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "blockId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ALL_WEEKS'::"LessonRecurrence", $8, now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get(subject), a.classId.get(cls), a.teacherId.get(teacher), lessons, minutes, extra.block ?? null],
        )
      ).rows[0]!.id;
    const row = async (postId: string, day: number, start: string, minutes: number, room: string | null, recurrence = 'ALL_WEEKS') =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7::"LessonRecurrence", now()) RETURNING id`,
          [a.school, postId, day, start, minutes, room, recurrence],
        )
      ).rows[0]!.id;
    const R1 = a.roomId.get('R1')!;
    const R2 = a.roomId.get('R2')!;
    const pMath = await post('7A', 'Matematik', 'T1', 3, 60);
    const pKem = await post('7A', 'Kemi', 'T2', 2, 60);
    const pMusik = await post('7B', 'Musik', 'T2', 1, 40);
    const placed = async () =>
      (
        await owner.query<{ id: string; subject: string; day: number; start: string; end: string; room: string | null; teacher: string | null; locked: boolean; generated: boolean; placement: boolean }>(
          `SELECT l.id, s.name AS subject, l."dayOfWeek" AS day, to_char(l."startTime", 'HH24:MI') AS start, to_char(l."endTime", 'HH24:MI') AS "end", l."roomId" AS room, l."teacherId" AS teacher,
                  l."isLocked" AS locked, l."isGenerated" AS generated, l."fromPlacement" AS placement
             FROM "MasterLessons" l JOIN "Subjects" s ON s.id = l."subjectId" WHERE l."academicYearId" = $1 AND l."fromPlacement" ORDER BY s.name, l."dayOfWeek", l."startTime"`,
          [a.year],
        )
      ).rows;
    const count = async (sql: string, ...params: unknown[]) => Number((await owner.query<{ n: string }>(sql, params)).rows[0]!.n);
    const versions = () => count(`SELECT count(*) AS n FROM "ScheduleVersions" WHERE "academicYearId" = $1`, a.year);
    const logRows = () => count(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1`, a.year);

    await check('(si-a) a förläggning that holds and names a room is written as Generera writes it; the preview says so; a second write changes nothing', async () => {
      await row(pMath, 1, '09:00', 60, R1);
      await row(pMath, 3, '10:00', 60, R2);
      const preview = await bridge.preview(a.year, a.caller);
      assert.deepEqual([preview.preview, preview.lessonsWritten, preview.lessonsReplaced, preview.postsWritten, preview.notWritten], [true, 2, 0, 1, []]);
      assert.deepEqual(await placed(), [], 'a preview writes nothing');
      assert.equal(await versions(), 0);
      const written = await bridge.write(a.year, a.caller);
      assert.deepEqual([written.preview, written.lessonsWritten, written.lessonsReplaced, written.postsWritten], [false, 2, 0, 1]);
      assert.ok(written.safetyVersionId, 'a restore point is taken first');
      const teacher = a.teacherId.get('T1')!;
      assert.deepEqual(
        (await placed()).map(({ id: _id, ...rest }) => rest),
        [
          { subject: 'Matematik', day: 1, start: '09:00', end: '10:00', room: R1, teacher, locked: true, generated: true, placement: true },
          { subject: 'Matematik', day: 3, start: '10:00', end: '11:00', room: R2, teacher, locked: true, generated: true, placement: true },
        ],
      );
      // Nothing more to write: the same lessons, no version, no log row.
      const ids = (await placed()).map((lesson) => lesson.id);
      const [versionsBefore, logBefore] = [await versions(), await logRows()];
      const again = await bridge.write(a.year, a.caller);
      assert.deepEqual([again.lessonsWritten, again.lessonsReplaced, again.safetyVersionId], [0, 0, null]);
      assert.deepEqual((await placed()).map((lesson) => lesson.id), ids);
      assert.deepEqual([await versions(), await logRows()], [versionsBefore, logBefore]);
    });

    await check('(si-b) a row the week does not hold, a row without a room and a block\'s row are named and not written; the rows that hold are', async () => {
      const kemiRow = await row(pKem, 2, '09:00', 60, R1);
      // Kemi's second row stands on the same hour of the same class as Matematik's Monday lesson: the week does not hold it.
      const clashing = await row(pKem, 1, '09:00', 60, R2);
      const noRoom = await row(pMusik, 4, '11:00', 40, null);
      const block = (await owner.query<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'SI Språkval', now()) RETURNING id`, [a.school, a.year])).rows[0]!.id;
      await post('7A', 'Språk A', 'T1', 2, 60, { block });
      await post('7B', 'Språk B', 'T2', 2, 60, { block });
      const blockRow = (await owner.query<{ id: string }>(`INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, 5, '10:00', 60, now()) RETURNING id`, [a.school, block, a.year])).rows[0]!.id;
      const mathMonday = (await owner.query<{ id: string }>(`SELECT id FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1 AND "dayOfWeek" = 1`, [pMath])).rows[0]!.id;
      const result = await bridge.write(a.year, a.caller);
      const reasons = Object.fromEntries(result.notWritten.map((entry) => [entry.rowId, entry.reason]));
      // A clash refuses both rows, as Generera's pre-flight judges them against each other: Matematik's Monday row is not written now either, and
      // its lesson, which was written while it held, stays where it stands.
      assert.deepEqual(reasons, { [clashing]: 'REFUSED', [mathMonday]: 'REFUSED', [noRoom]: 'NO_ROOM', [blockRow]: 'BLOCK' });
      assert.ok(result.notWritten.find((entry) => entry.rowId === clashing)?.verdict?.reason, 'a refused row says why');
      const subjects = (await placed()).map((lesson) => `${lesson.subject} ${lesson.day} ${lesson.start}`);
      assert.deepEqual(subjects, ['Kemi 2 09:00', 'Matematik 1 09:00', 'Matematik 3 10:00']);
      assert.equal(result.lessonsWritten, 1, 'Kemi\'s Tuesday row is the only new lesson; Matematik\'s Wednesday lesson is what it was');
      void kemiRow;
    });

    await check('(si-c) a moved row replaces its lesson, a lesson that answers a row left stays, the dated lessons of a replaced one go from the calendar', async () => {
      const mathRows = (await owner.query<{ id: string }>(`SELECT id FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1 AND "dayOfWeek" = 3`, [pMath])).rows;
      assert.equal(mathRows.length, 1);
      // A lesson Generera wrote for the row without a room, with the room the engine chose: the bridge leaves it be.
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "fromPlacement", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 4, '11:00', '11:40', true, true, true, now())`,
        [a.school, a.year, a.subjectId.get('Musik'), a.classId.get('7B'), a.teacherId.get('T2'), R1],
      );
      // The row of Matematik's Wednesday lesson moves to Thursday; its lesson has a dated lesson on the calendar.
      const old = (await placed()).find((lesson) => lesson.subject === 'Matematik' && lesson.day === 3)!;
      await owner.query(
        `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
         SELECT "schoolId", id, "subjectId", "studentGroupId", current_date + 400, (current_date + 400)::timestamptz + interval '9 hours', (current_date + 400)::timestamptz + interval '10 hours', 'SCHEDULED', now()
           FROM "MasterLessons" WHERE id = $1`,
        [old.id],
      );
      await owner.query(`UPDATE "TeachingRequirementPlacements" SET "dayOfWeek" = 4 WHERE id = $1`, [mathRows[0]!.id]);
      const versionsBefore = await versions();
      const result = await bridge.write(a.year, a.caller);
      assert.deepEqual([result.lessonsWritten, result.lessonsReplaced], [1, 1]);
      assert.equal(result.calendarLessonsRemoved, 1);
      assert.equal(await versions(), versionsBefore + 1);
      const now = (await placed()).map((lesson) => `${lesson.subject} ${lesson.day} ${lesson.start}`);
      assert.deepEqual(now, ['Kemi 2 09:00', 'Matematik 1 09:00', 'Matematik 4 10:00', 'Musik 4 11:00']);
      assert.equal(await count(`SELECT count(*) AS n FROM "MasterLessons" WHERE id = $1`, old.id), 0);
    });

    await check('(si-d) a written lesson is a placed lesson a hand edit cannot move; another school\'s year is a 404; a year being rewritten is a 409 and nothing is written', async () => {
      const lesson = (await placed()).find((entry) => entry.subject === 'Matematik' && entry.day === 1)!;
      let refused: unknown;
      try {
        await masters.update(lesson.id, { dayOfWeek: 2, startTime: '13:00', endTime: '14:00' }, a.caller);
      } catch (error) {
        refused = error;
      }
      assert.ok(refused instanceof ConflictException);
      assert.equal((refused.getResponse() as { code?: string }).code, 'LESSON_IS_PLACED');
      await assert.rejects(bridge.write(b.year, a.caller), NotFoundException);
      await assert.rejects(bridge.write(a.year, b.caller), NotFoundException);
      // Another writer holds the year's regeneration lock: the bridge waits its 5 s and answers 409, having written nothing.
      await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1`, [pKem]);
      const holder = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext($1::uuid::text))`, [a.year]);
        const before = (await placed()).length;
        let busy: unknown;
        try {
          await bridge.write(a.year, a.caller);
        } catch (error) {
          busy = error;
        }
        assert.ok(busy instanceof ConflictException);
        assert.equal((busy.getResponse() as { code?: string }).code, 'SCHEDULE_BUSY');
        assert.equal((await placed()).length, before, 'nothing was written');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      // And once it is free, the write goes through and takes Kemi's lesson away with its row.
      const freed = await bridge.write(a.year, a.caller);
      assert.equal(freed.lessonsReplaced, 0, 'a lesson whose post has no row left is not the bridge\'s to take: the next Generera replaces it');
    });

    await check('(si-e) a pair whose even half stops holding: the odd half is written once and the even half\'s lesson stays, whatever the order of the ids (granskaren g505, M-1)', async () => {
      await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement"`, [a.year]);
      await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "schoolId" = $1`, [a.school]);
      const pPair = await post('7B', 'Matematik', 'T1', 1, 60);
      // One statement: the database refuses a lone half (FP409 PAIRS).
      await owner.query(
        `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "updatedAt")
         VALUES ($1, $2, 5, '13:00', 60, $3, 'ODD_WEEKS'::"LessonRecurrence", now()), ($1, $2, 5, '13:00', 60, $4, 'EVEN_WEEKS'::"LessonRecurrence", now())`,
        [a.school, pPair, R1, R2],
      );
      const lessonOf = async (id: string, recurrence: string, room: string) =>
        owner.query(
          `INSERT INTO "MasterLessons" (id, "schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "fromPlacement", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, 5, '13:00', '14:00', true, true, true, $8::"LessonRecurrence", now())`,
          [id, a.school, a.year, a.subjectId.get('Matematik'), a.classId.get('7B'), a.teacherId.get('T1'), room, recurrence],
        );
      // The odd half's lesson sorts first by id: the order that made the write keep the wrong one.
      await lessonOf('00000000-0000-4000-8000-0000000000e1', 'ODD_WEEKS', R1);
      await lessonOf('00000000-0000-4000-8000-0000000000e2', 'EVEN_WEEKS', R2);
      // The even half stops holding: the same teacher has a lesson of the school's own at that hour in the even weeks.
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 5, '13:00', '14:00', true, false, 'EVEN_WEEKS'::"LessonRecurrence", now())`,
        [a.school, a.year, a.subjectId.get('Musik'), a.classId.get('7A'), a.teacherId.get('T1')],
      );
      const result = await bridge.write(a.year, a.caller);
      assert.deepEqual(result.notWritten.filter((entry) => entry.requirementId === pPair).map((entry) => entry.reason), ['REFUSED'], 'the even half is named and left');
      const lessons = (await owner.query<{ id: string; recurrence: string }>(`SELECT id, recurrence::text AS recurrence FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement" ORDER BY recurrence, id`, [a.year])).rows;
      assert.deepEqual(lessons.map((lesson) => lesson.recurrence), ['EVEN_WEEKS', 'ODD_WEEKS'], 'one lesson for each half, none written twice');
      assert.deepEqual([result.lessonsWritten, result.lessonsReplaced], [0, 0], 'the odd half\'s lesson is what its row writes: nothing to do');
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
    await skrivInChecks(owner, api, async (name, run) => {
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
