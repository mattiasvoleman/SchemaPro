/**
 * The adapter probe's checks for Förlägg i veckan: the year's week of
 * förläggningar (RequirementPlacementsService.boardOfYear, GET
 * /teaching-requirements/placements/board), through the real services on the
 * API's role and real Postgres as CI runs it. Two schools of their own (slugs
 * <marker>-veckan-a and <marker>-veckan-b) and a läsår that starts on a
 * Saturday, swept whole before and after:
 *
 *   vv1  as the schemaläggare who lays them: every row of the year with its
 *        verdict, every post counted (a split post by length, a shared post by
 *        teacher, a lock that answers a lesson), the lessons Generera keeps and
 *        the meals the school placed by hand, and not the generated lesson or
 *        the generated meal; the rows are the dialog's rows, verdict for
 *        verdict (listOfPost), since both ask the same judge;
 *   vv2  a lesson that has since been kept in the way turns the row red with
 *        the judge's reason and the other lesson as a class and a subject, and
 *        the answer names no person: not a name, not an e-mail, and no pupil
 *        the kept lesson holds;
 *   vv3  as the expedition and the läsare: read-only profiles are answered the
 *        same board, row for row;
 *   vv4  as a teacher: row security shows no förläggning (the administrators'
 *        policies), so the week has none to tell, and as an administrator of
 *        another school: the year is not there (404) and nothing of this
 *        school's is told;
 *   vv5  a year with no row is answered without a roster basis (as the dialog
 *        is): the posts counted and nothing judged, for a year that is not yet
 *        activated too;
 *   vv6  the week and Generera's own pre-flight (prepareSchedule) judge the
 *        same rows the same way: judgePlacements is handed the same rows and
 *        the same demand by both, and answers the same verdict for each row,
 *        on a post that shares its lessons (Bo's lock answers Bo's lesson), a
 *        post whose lock is a lesson with a second class, a post nothing
 *        keeps, and a post with no row; and what the week says is left for a
 *        post is what Generera then sends the engine (review of #315,
 *        MEDEL-1: the two used to build that input by hand, each its own).
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import type { JudgePlacementsInput, PlacementVerdict } from '../../src/requirement-placements/placement-judge';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function placementWeekSlug(marker: string, which: 'a' | 'b'): string {
  return `${marker}-veckan-${which}`;
}

export async function sweepPlacementWeekSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1::text[])`, [[placementWeekSlug(marker, 'a'), placementWeekSlug(marker, 'b')]]);
}

export async function placementWeekChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepPlacementWeekSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;

  const build = async (which: 'a' | 'b') => {
    const school = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} veckan ${which}`, placementWeekSlug(marker, which)],
      )
    ).id;
    // A läsår that starts on a Saturday (2098-08-15 is a Friday, 16 a Saturday), the active one, in the nine-year numbering
    // the grade rules read: the figures of the week count lessons, not weeks, but the board is asked of a real year.
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe veckan', '2098-08-16', '2099-06-11', true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;
    const group = async (name: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
           VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`,
          [school, year, name],
        )
      ).id;
    const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Veckan', $4, $5, true, $6, $7, now()) RETURNING id`,
        [school, `${marker}-veckan-${which}-${label}@example.invalid`, label, role, authId, extra.groupId ?? null, extra.adminProfile ?? null],
      );
      return { id: row.id, authId };
    };
    const subject = async (name: string) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;
    const room = async (name: string) =>
      (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;
    const g7a = await group('VK 7A');
    const g7b = await group('VK 7B');
    const anna = await person('anna', 'TEACHER');
    const bo = await person('bo', 'TEACHER');
    const pupil = await person('pupil', 'STUDENT', { groupId: g7b });
    const userOf = (row: { id: string; authId: string }, role: Role, adminProfile: string | null): AuthenticatedUser =>
      ({ authId: row.authId, userId: row.id, schoolId: school, role, adminProfile, channel: 'WEB', hrRead: false }) as AuthenticatedUser;
    const adminRows = {
      schema: await person('schema', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' }),
      expedition: await person('expedition', 'SCHOOL_ADMIN', { adminProfile: 'EXPEDITION' }),
      reader: await person('reader', 'SCHOOL_ADMIN', { adminProfile: 'LASARE' }),
      full: await person('full', 'SCHOOL_ADMIN', { adminProfile: 'FULL' }),
    };
    const ma = await subject('VK Matematik');
    const sv = await subject('VK Svenska');
    const idh = await subject('VK Idrott');
    const r1 = await room('VK sal 1');
    const r2 = await room('VK sal 2');
    const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number, lengths: number[] = []) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::int[], now()) RETURNING id`,
          [school, year, subjectId, groupId, teacherId, lessons, minutes, lengths],
        )
      ).id;
    return {
      school,
      year,
      g7a,
      g7b,
      anna,
      bo,
      pupil,
      ma,
      sv,
      idh,
      r1,
      r2,
      post,
      users: {
        schema: userOf(adminRows.schema, Role.SCHOOL_ADMIN, 'SCHEMALAGGARE'),
        expedition: userOf(adminRows.expedition, Role.SCHOOL_ADMIN, 'EXPEDITION'),
        reader: userOf(adminRows.reader, Role.SCHOOL_ADMIN, 'LASARE'),
        full: userOf(adminRows.full, Role.SCHOOL_ADMIN, 'FULL'),
        teacher: userOf(anna, Role.TEACHER, null),
      },
    };
  };

  try {
    const a = await build('a');
    const b = await build('b');
    const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
    const masters = new MasterLessonsService(api, realtime, {} as NotificationsService);
    const placements = new RequirementPlacementsService(api, masters);

    // Three posts: three lessons of 60 (Anna), a split post of 80 + 40 (Anna), and a shared one (Anna two of 60, Bo one).
    const p1 = await a.post(a.g7a, a.ma, a.anna.id, 3, 60);
    const p2 = await a.post(a.g7a, a.sv, a.anna.id, 2, 80, [80, 40]);
    const p3 = await a.post(a.g7b, a.idh, a.anna.id, 3, 60);
    await owner.query(
      `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`,
      [a.school, p3, a.bo.id],
    );
    // The other school has a post of its own, which the first school's administrator must not see.
    await b.post(b.g7a, b.ma, b.anna.id, 2, 60);

    // What Generera keeps: a locked hand-made lesson that answers one of the first post's lessons; and one it does not keep.
    const lesson = (subjectId: string, groupId: string, teacherId: string, roomId: string, day: number, start: string, end: string, locked: boolean, generated: boolean) =>
      owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id`,
        [a.school, a.year, subjectId, groupId, teacherId, roomId, day, start, end, locked, generated],
      );
    await lesson(a.ma, a.g7a, a.anna.id, a.r2, 1, '09:00', '10:00', true, false);
    await lesson(a.sv, a.g7a, a.anna.id, a.r2, 3, '14:00', '15:00', false, true);
    // A meal the school placed and one Generera laid: only the first is a meal a row is held to.
    const meal = (day: number, start: string, end: string, generated: boolean) =>
      owner.query(
        `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [a.school, a.year, a.g7a, day, start, end, generated],
      );
    await meal(2, '11:00', '11:30', false);
    await meal(3, '11:00', '11:30', true);

    // Laid through the service the dialog writes with, as the schemaläggare.
    const row = (dayOfWeek: number, startTime: string, minutes: number, roomId: string, extra: Record<string, unknown> = {}) => ({
      dayOfWeek,
      startTime,
      minutes,
      roomId,
      recurrence: 'ALL_WEEKS' as const,
      ...extra,
    });
    await placements.replace(p1, { placements: [row(2, '10:00', 60, a.r1)] } as never, a.users.schema);
    await placements.replace(p2, { placements: [row(4, '08:00', 40, a.r1)] } as never, a.users.schema);
    await placements.replace(p3, { placements: [row(5, '13:00', 60, a.r2, { teacherId: a.bo.id })] } as never, a.users.schema);

    const partOf = (board: Awaited<ReturnType<RequirementPlacementsService['boardOfYear']>>, postId: string) => board.posts.find((entry) => entry.id === postId)!.parts;

    await check('(vv1) as the schemaläggare: every row with its verdict, every post counted, what Generera keeps and the meals placed by hand', async () => {
      const board = await placements.boardOfYear(a.year, a.users.schema);
      assert.equal(board.academicYearId, a.year);
      assert.equal(board.placements.length, 3, 'the three rows of the year');
      for (const entry of board.placements) assert.deepEqual(entry.verdict, { ok: true }, `row ${entry.id} holds`);
      // The posts of this year only, every one of them.
      assert.deepEqual(board.posts.map((entry) => entry.id).sort(), [p1, p2, p3].sort());
      // Three lessons of 60: the locked lesson answers one, the row one, one is left for Generera.
      assert.deepEqual(partOf(board, p1), [{ teacherId: a.anna.id, minutes: 60, count: 3, locked: 1, placed: 1, left: 1, cannotPlace: null }]);
      // 80 + 40: the förläggning of 40 takes the 40 and not the nearest.
      assert.deepEqual(
        partOf(board, p2).map((part) => [part.minutes, part.count, part.placed, part.left]),
        [
          [80, 1, 0, 1],
          [40, 1, 1, 0],
        ],
      );
      // Delade lektioner: Anna's two, Bo's one, which his row takes.
      assert.deepEqual(
        partOf(board, p3).map((part) => [part.teacherId, part.count, part.placed, part.left]),
        [
          [a.anna.id, 2, 0, 2],
          [a.bo.id, 1, 1, 0],
        ],
      );
      // What the rows are held against: the locked lesson, not the generated one; the meal placed by hand, not the laid one.
      assert.equal(board.kept.length, 1);
      assert.deepEqual([board.kept[0]!.startTime, board.kept[0]!.endTime, board.kept[0]!.locked, board.kept[0]!.generated], ['09:00', '10:00', true, false]);
      assert.deepEqual(board.meals.map((meal) => [meal.dayOfWeek, meal.startTime, meal.endTime]), [[2, '11:00', '11:30']]);
      // The dialog's rows and the week's are one judge's: verdict for verdict.
      for (const [postId, count] of [[p1, 1], [p2, 1], [p3, 1]] as const) {
        const dialog = await placements.listOfPost(postId, a.users.schema);
        const week = board.placements.filter((entry) => entry.requirementId === postId);
        assert.equal(week.length, count);
        assert.deepEqual(week.map((entry) => entry.verdict), dialog.verdicts.map(({ index: _index, ...verdict }) => verdict), `the dialog and the week agree on ${postId}`);
        assert.deepEqual(week.map((entry) => entry.id), dialog.placements.map((entry) => entry.id));
      }
    });

    await check('(vv2) a lesson kept in the way turns the row red with the judge\'s reason, and the answer names no person', async () => {
      // Anna is held in 7B's Svenska at the very time of her förläggning: a lesson Generera keeps (locked, hand-made),
      // with a pupil named in it, whose name must not leave through the week.
      const kept = await owner.query<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 2, '10:30', '11:30', true, false, now()) RETURNING id`,
        [a.school, a.year, a.sv, a.g7b, a.anna.id, a.r2],
      );
      await owner.query(`INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES ($1, $2, $3)`, [a.school, kept.rows[0]!.id, a.pupil.id]);
      const board = await placements.boardOfYear(a.year, a.users.schema);
      const red = board.placements.filter((entry) => !entry.verdict.ok);
      assert.deepEqual(red.map((entry) => entry.requirementId), [p1]);
      assert.equal(red[0]!.verdict.reason, 'TEACHER');
      assert.deepEqual(
        { className: red[0]!.verdict.params?.className, subjectName: red[0]!.verdict.params?.subjectName, day: red[0]!.verdict.params?.day },
        { className: 'VK 7B', subjectName: 'VK Svenska', day: 2 },
      );
      const text = JSON.stringify(board);
      for (const secret of [a.pupil.id, 'pupil', '@example.invalid', 'Veckan']) assert.ok(!text.includes(secret), `the week names a person: ${secret}`);
      // Two lessons kept for one post now: the figures follow (the lesson with a pupil is still one lock of the post's class).
      assert.equal(board.kept.length, 2);
      // Back to what vv3 and vv4 compare.
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [kept.rows[0]!.id]);
    });

    await check('(vv3) the expedition and the läsare are answered the same week, row for row', async () => {
      const laid = await placements.boardOfYear(a.year, a.users.schema);
      assert.deepEqual(await placements.boardOfYear(a.year, a.users.expedition), laid);
      assert.deepEqual(await placements.boardOfYear(a.year, a.users.reader), laid);
      assert.deepEqual(await placements.boardOfYear(a.year, a.users.full), laid);
    });

    await check('(vv4) a teacher sees no förläggning, and another school\'s administrator sees no year and none of this school\'s', async () => {
      const asTeacher = await placements.boardOfYear(a.year, a.users.teacher);
      assert.deepEqual(asTeacher.placements, [], 'row security shows a teacher no förläggning');
      await assert.rejects(placements.boardOfYear(a.year, b.users.schema), (error: unknown) => error instanceof NotFoundException);
      const own = await placements.boardOfYear(b.year, b.users.schema);
      assert.deepEqual([own.placements.length, own.kept.length, own.meals.length], [0, 0, 0]);
      assert.equal(own.posts.length, 1);
      assert.ok(!JSON.stringify(own).includes(a.school));
      assert.ok(!own.posts.some((entry) => [p1, p2, p3].includes(entry.id)));
    });

    await check('(vv5) a year with no row is answered without a roster basis, the posts counted, and an unactivated one too', async () => {
      // A second, not activated year after the active one, with a post and no row.
      const next = (
        await one<{ id: string }>(
          `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "predecessorId", "updatedAt")
           VALUES ($1, 'probe veckan nästa', '2099-08-15', '2100-06-10', false, 'NIOARIG', $2, now()) RETURNING id`,
          [a.school, a.year],
        )
      ).id;
      const group = (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'VK 8A', 'CLASS', 8, now()) RETURNING id`,
          [a.school, next],
        )
      ).id;
      await owner.query(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 2, 60, now())`,
        [a.school, next, a.ma, group, a.anna.id],
      );
      const board = await placements.boardOfYear(next, a.users.schema);
      assert.deepEqual([board.placements.length, board.kept.length], [0, 0]);
      assert.deepEqual(board.posts.map((entry) => entry.parts.map((part) => [part.count, part.left])), [[[2, 2]]]);
    });
    await check('(vv6) the week and Generera\'s pre-flight judge every row alike, and the week says left what Generera then sends', async () => {
      const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
      const judgeModule = (await import('../../src/requirement-placements/placement-judge')) as unknown as {
        judgePlacements: (...args: unknown[]) => Promise<PlacementVerdict[]>;
      };
      const config = { getOrThrow: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 1000 }) } as unknown as ConfigService;
      const http = { post: () => { throw new Error('the pre-flight wakes no engine'); } } as unknown as HttpService;
      const proxy = new OptimizationProxyService(api, http, config, masters);

      // A third class with three posts: a shared one (Anna two of 60, Bo one), one a lesson with a second class will answer,
      // and one nothing keeps and nothing places. Rows are saved first, as the week held them, and the week then moves under them.
      const g7c = (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'VK 7C', 'CLASS', 7, now()) RETURNING id`,
          [a.school, a.year],
        )
      ).id;
      const subjectNamed = async (name: string) =>
        (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [a.school, name])).id;
      const [fysik, biologi, kemi] = [await subjectNamed('VK Fysik'), await subjectNamed('VK Biologi'), await subjectNamed('VK Kemi')];
      const p6 = await a.post(g7c, fysik, a.anna.id, 3, 60);
      await owner.query(
        `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`,
        [a.school, p6, a.bo.id],
      );
      const p7 = await a.post(g7c, biologi, a.anna.id, 2, 60);
      const p8 = await a.post(g7c, kemi, a.bo.id, 2, 60);
      await placements.replace(
        p6,
        { placements: [row(2, '13:00', 60, a.r1, { teacherId: a.anna.id }), row(3, '13:00', 60, a.r2, { teacherId: a.bo.id })] } as never,
        a.users.schema,
      );
      await placements.replace(p7, { placements: [row(4, '13:00', 60, a.r1), row(5, '08:00', 60, a.r1)] } as never, a.users.schema);
      // Bo's own lock (locked, hand-made) answers Bo's lesson of the shared post, which takes the lesson his förläggning would place.
      await lesson(fysik, g7c, a.bo.id, a.r2, 1, '09:00', '10:00', true, false);
      // A lesson Generera wrote and kept only because it has a second class: it answers one lesson of the biology post.
      const withClass = await lesson(biologi, g7c, a.bo.id, a.r2, 1, '13:00', '14:00', false, true);
      await owner.query(`INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [a.school, withClass.rows[0]!.id, a.g7a]);

      const proxyService = proxy as unknown as { prepareSchedule: (tx: unknown, year: string, user: AuthenticatedUser) => Promise<{ ready: boolean; payload?: any; demand?: any[] }> };
      type Asked = { tag: string; input: JudgePlacementsInput; verdicts: PlacementVerdict[] };
      const asked: Asked[] = [];
      let tag = '';
      const original = judgeModule.judgePlacements;
      judgeModule.judgePlacements = async (...args: unknown[]) => {
        const verdicts = await original(...args);
        asked.push({ tag, input: args[2] as JudgePlacementsInput, verdicts });
        return verdicts;
      };
      let board: Awaited<ReturnType<RequirementPlacementsService['boardOfYear']>>;
      let prepared: Awaited<ReturnType<typeof proxyService.prepareSchedule>>;
      try {
        tag = 'week';
        board = await placements.boardOfYear(a.year, a.users.schema);
        tag = 'generera';
        prepared = await api.withRls(a.users.schema, (tx) => proxyService.prepareSchedule(tx, a.year, a.users.schema));
      } finally {
        judgeModule.judgePlacements = original;
      }
      const week = asked.find((entry) => entry.tag === 'week');
      const generera = asked.find((entry) => entry.tag === 'generera');
      assert.ok(week && generera, `judgePlacements was asked by the week (${week ? 'yes' : 'no'}) and by Generera (${generera ? 'yes' : 'no'}; it answered ${prepared.ready ? 'ready' : 'a refusal before the judge'})`);

      const byId = <T extends { id: string | null }>(rows: readonly T[]) => [...rows].sort((x, y) => String(x.id).localeCompare(String(y.id)));
      assert.deepEqual(byId(week.input.rows), byId(generera.input.rows), 'the same rows, each as the post and its own slot make it');
      const verdictsOf = (entry: Asked) =>
        new Map(entry.input.rows.map((judged, at) => [judged.id, { ok: entry.verdicts[at]!.ok, reason: entry.verdicts[at]!.reason ?? null, params: entry.verdicts[at]!.params ?? null }]));
      assert.deepEqual([...verdictsOf(week)].sort(), [...verdictsOf(generera)].sort(), 'the same verdict for every row');
      const demandOf = (entry: Asked) =>
        [...(entry.input.demand ?? [])]
          .map(([id, demand]) => [id, { lockedMinutes: demand.lockedMinutes, placed: demand.placed, taught: demand.taught ?? null }] as const)
          .sort(([x], [y]) => x.localeCompare(y));
      assert.deepEqual(demandOf(week), demandOf(generera), 'the same locks and the same lessons placed, per post and per teacher');
      assert.deepEqual(week.input.beside, generera.input.beside);

      // What they say, in absolute terms (so that the two cannot drift together): the shared post's rows are over the demand because Bo's
      // lock took Bo's lesson, the biology post's because a lesson with a second class answers one, and the rows of the first posts hold.
      const reasonOfPost = (postId: string) => [...new Set(board.placements.filter((entry) => entry.requirementId === postId).map((entry) => entry.verdict.reason ?? 'ok'))];
      assert.deepEqual([p1, p2, p3].map(reasonOfPost), [['ok'], ['ok'], ['ok']]);
      assert.deepEqual([reasonOfPost(p6), reasonOfPost(p7)], [['OVER_DEMAND'], ['OVER_DEMAND']]);
      assert.deepEqual(
        demandOf(week).find(([id]) => id === p6)![1],
        { lockedMinutes: [60], placed: [60, 60], taught: { locked: [{ minutes: 60, teacherId: a.bo.id }], placed: [{ minutes: 60, teacherId: a.anna.id }, { minutes: 60, teacherId: a.bo.id }].sort((x, y) => String(x.teacherId).localeCompare(String(y.teacherId))) } },
      );
      assert.deepEqual(demandOf(week).find(([id]) => id === p7)![1], { lockedMinutes: [60], placed: [60, 60], taught: null });
      assert.ok(!demandOf(week).some(([id]) => id === p8), 'a post with no row is asked nothing');
      assert.equal(prepared.ready, false, 'a row that does not hold refuses the run before the engine');

      // The rows that do not hold taken away, as the school would, Generera goes through: what the week says is left is what it sends.
      await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = ANY($1::uuid[])`, [[p6, p7]]);
      const after = await placements.boardOfYear(a.year, a.users.schema);
      const sent = await api.withRls(a.users.schema, (tx) => proxyService.prepareSchedule(tx, a.year, a.users.schema));
      assert.equal(sent.ready, true, 'the run goes through once every row holds');
      const sentLeft = new Map((sent.demand ?? []).map((entry) => [entry.requirementId, entry.lessonsPerWeek as number]));
      for (const post of after.posts) {
        const left = post.parts.reduce((sum, part) => sum + part.left, 0);
        assert.equal(sentLeft.get(post.id) ?? 0, left, `the week's left for ${post.id} is what Generera sends`);
      }
      assert.deepEqual(
        [p6, p7, p8].map((postId) => after.posts.find((entry) => entry.id === postId)!.parts.reduce((sum, part) => sum + part.left, 0)),
        [2, 1, 2],
        'the shared post has its three less the lesson Bo\'s lock took, the biology post its two less the one the second class answers, the third post both',
      );
      // Only a post with a förläggning is in the engine's released week.
      const withRows = new Set(after.placements.map((entry) => entry.requirementId));
      assert.equal(sent.payload?.placements?.requirements.length, withRows.size, 'the released week holds the posts with a förläggning, and no other');
      assert.ok(withRows.size > 0 && withRows.size < after.posts.length);
    });
  } finally {
    await sweepPlacementWeekSchools(owner, marker);
  }
}
