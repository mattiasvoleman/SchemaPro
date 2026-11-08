/**
 * Byten och flyttar against a real database, as the API role under RLS,
 * through the real services (round 9, G1).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-swaps.ts
 *
 * The jest specs hold the search against a brute force over a faked database;
 * this is what they cannot see: every read the snapshot makes under row
 * security as a scheduler, the clash rule reading real rosters (a class and a
 * teaching group that share a pupil), the rows locked and written, the safety
 * version, the change log, and what the database refuses.
 *
 * The school is a small högstadium laid by scripts/fixtures/hogstadium-week.ts
 * (six classes, parallel blocks of five teaching groups cut across them, a
 * teacher's closed hour, a frame), planted and dropped by this probe:
 *
 *   (sw-a) every proposal for a spread of lessons is clash-free as the DATABASE
 *          would see it — a check of this file's own, over the stored rows and
 *          the pupils the teaching groups share with the classes — and lands
 *          inside the stage's frame and outside every teacher's closed hour;
 *   (sw-b) a lesson of a block goes with the whole card in every proposal;
 *   (sw-c) a proposal applied moves exactly its lessons, takes a version first
 *          and logs a row per lesson; its undo puts every lesson back;
 *   (sw-d) the refusals: a lesson that moved since the proposal (SWAP_STALE),
 *          a block card parted (SWAP_SPLITS_PARALLEL), a locked partner
 *          (SWAP_LOCKED) — each leaves the stored lessons as they were —
 *          and a teacher's principal, whom the database will not let write;
 *   (sw-e) a locked lesson picked by the scheduler is still offered;
 *   (sw-f) a teacher whose post holds a limit (HR data) is counted against it
 *          without being worded, and the read is a row in the läslogg;
 *   (sw-g) a lesson that moved to another DAY, at the same clock, is SWAP_STALE
 *          (the version check's day condition: start and end moved together
 *          cover for one another, the day alone did not);
 *   (sw-h) a clock past the end of the day ("34:00" wraps to 10:00 where the
 *          teacher's other lesson stands) is a 400 that writes nothing;
 *   (sw-i) published calendar lessons: a proposal says how many it would
 *          REMOVE (a lesson carried to a time that has begun), apply removes
 *          exactly those and moves the rest, and Ångra, with a safety version
 *          of its own, does not bring the removed ones back.
 *
 * Independent of what earlier CI steps left in the database: it works in a
 * school of its own and counts on nothing in the seed.
 */
import { strict as assert } from 'node:assert';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { zonedTimeToUtc } from '../../src/common/utils/time';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapsService, type SwapProposalView } from '../../src/swaps/swaps.service';
import { seedHogstadium, type SeededSchool } from '../fixtures/hogstadium-week';

const SLUG = 'probe-byten';

interface Row {
  id: string;
  groupId: string;
  teacherId: string | null;
  roomId: string | null;
  day: number;
  start: number;
  locked: boolean;
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  // A transaction has 15 s and waits 2 s for a connection; on a development Mac that other work has
  // taken to a load average of a hundred neither is enough. WAIT_MS lifts both; CI sets nothing.
  const patience = Number(process.env['WAIT_MS'] ?? 0);
  if (patience > 0) {
    const withRls = api.withRls.bind(api) as (user: unknown, run: unknown, options?: object) => Promise<unknown>;
    (api as unknown as { withRls: typeof withRls }).withRls = (user, run, options) => withRls(user, run, { ...options, timeoutMs: patience });
    const transaction = api.$transaction.bind(api) as (fn: unknown, options?: object) => Promise<unknown>;
    (api as unknown as { $transaction: typeof transaction }).$transaction = (fn, options) => transaction(fn, { ...options, maxWait: patience });
  }
  try {
    const seeded = await seedHogstadium(owner, { slug: SLUG, letters: 'AB', pupils: 25 });
    await run(owner, api, seeded);
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.$disconnect();
  }
}

async function run(owner: Client, api: PrismaService, seeded: SeededSchool) {
  const { school, year, admin, adminAuth } = seeded;
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const swaps = new SwapsService(api, new MasterLessonsService(api, realtime as never, notifications as never), new ScheduleVersionsService(api), realtime as never, notifications as never);
  const asAdmin: AuthenticatedUser = { authId: adminAuth, role: Role.SCHOOL_ADMIN, userId: admin, schoolId: school, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  // The frame the stage is taught in: nothing at 15:00, the last hour the fixture lays.
  await owner.query(`UPDATE "FrameTimes" SET "endTime" = '15:00' WHERE "schoolId" = $1`, [school]);

  const rows = async (): Promise<Row[]> =>
    (
      await owner.query(
        `SELECT id, "studentGroupId" AS "groupId", "teacherId", "roomId", "dayOfWeek" AS day,
                extract(hour FROM "startTime")::int * 60 + extract(minute FROM "startTime")::int AS start, "isLocked" AS locked
           FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
        [year],
      )
    ).rows;
  const fingerprint = async () => JSON.stringify(await rows());

  // Which teaching group holds a pupil of which class: the sharing the clash rule reads from the rosters.
  const sharing = new Map<string, Set<string>>();
  for (const pair of (
    await owner.query(
      `SELECT DISTINCT u."studentGroupId" AS class, m."studentGroupId" AS grp
         FROM "StudentGroupMembers" m JOIN "Users" u ON u.id = m."studentId" WHERE m."schoolId" = $1`,
      [school],
    )
  ).rows as Array<{ class: string; grp: string }>) {
    for (const [a, b] of [[pair.class, pair.grp], [pair.grp, pair.class]] as const) {
      if (!sharing.has(a)) sharing.set(a, new Set());
      sharing.get(a)!.add(b);
    }
  }
  const closed = new Set(
    (await owner.query(`SELECT "userId", "dayOfWeek" FROM "AvailabilityConstraints" WHERE "schoolId" = $1 AND type = 'UNAVAILABLE'`, [school])).rows.map(
      (r: { userId: string; dayOfWeek: number }) => `${r.userId}|${r.dayOfWeek}`,
    ),
  );

  /** A clash as the stored rows would show it, by a rule of this file's own: a teacher, a room, a class or a shared pupil twice. */
  function clashing(after: Row[]): string | null {
    for (let i = 0; i < after.length; i++) {
      for (let j = i + 1; j < after.length; j++) {
        const a = after[i]!;
        const b = after[j]!;
        if (a.day !== b.day || a.start !== b.start) continue;
        if (a.teacherId && a.teacherId === b.teacherId) return `teacher ${a.teacherId} on day ${a.day} at ${a.start}`;
        if (a.roomId && a.roomId === b.roomId) return `room ${a.roomId} on day ${a.day} at ${a.start}`;
        if (a.groupId === b.groupId) return `group ${a.groupId} on day ${a.day} at ${a.start}`;
        if (sharing.get(a.groupId)?.has(b.groupId)) return `pupils shared by ${a.groupId} and ${b.groupId} on day ${a.day} at ${a.start}`;
      }
    }
    return null;
  }
  const afterMoves = (before: Row[], proposal: SwapProposalView): Row[] => {
    const to = new Map(proposal.moves.map((m) => [m.lessonId, m.to]));
    return before.map((row) => {
      const slot = to.get(row.id);
      return slot ? { ...row, day: slot.dayOfWeek, start: slot.startMinutes } : row;
    });
  };
  const bodyOf = (lessonId: string, proposal: SwapProposalView) => ({
    lessonId,
    moves: proposal.moves.map((m) => ({
      lessonId: m.lessonId,
      from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
      to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
    })),
  });

  const start = await rows();
  assert.ok(start.length > 100, `${start.length} lessons laid`);
  assert.equal(clashing(start), null, 'the fixture laid a clash');
  const classLesson = start.find((r) => seeded.classes.some((c) => c.id === r.groupId))!;
  const blockLesson = start.find((r) => !seeded.classes.some((c) => c.id === r.groupId))!;
  const sample = start.filter((_, i) => i % 11 === 0);

  let offered: SwapProposalView[] = [];
  await check('(sw-a) every proposal for a spread of lessons is clash-free, inside the frame and outside the closed hours', async () => {
    let proposals = 0;
    for (const lesson of sample) {
      const answer = await swaps.suggest({ lessonId: lesson.id, limit: 30 }, asAdmin);
      assert.equal(answer.immovable, undefined);
      for (const proposal of answer.proposals) {
        proposals += 1;
        const after = afterMoves(start, proposal);
        assert.equal(clashing(after), null, `a proposal for ${lesson.id} clashes`);
        for (const move of proposal.moves) {
          assert.ok(move.to.endMinutes <= 15 * 60, `lands ${clock(move.to.endMinutes)}, past the frame`);
          const mover = start.find((r) => r.id === move.lessonId)!;
          assert.ok(!mover.teacherId || !closed.has(`${mover.teacherId}|${move.to.dayOfWeek}`) || move.to.startMinutes !== 12 * 60, 'in a closed hour');
        }
        assert.ok(proposal.hard.includes('CLASH') && proposal.hard.includes('FRAME'));
      }
    }
    assert.ok(proposals > 20, `${proposals} proposals over ${sample.length} lessons`);
  });

  await check('(sw-b) a lesson of a block goes with the whole card, in every proposal', async () => {
    const answer = await swaps.suggest({ lessonId: blockLesson.id, limit: 30 }, asAdmin);
    assert.equal(answer.unit.lessonIds.length, 5, 'the card is five groups');
    assert.ok(answer.unit.links.length >= 4 && answer.unit.links.every((link) => link.kind === 'BLOCK'));
    assert.ok(answer.proposals.length > 0, 'a block card with nowhere to go');
    for (const proposal of answer.proposals) {
      for (const id of answer.unit.lessonIds) assert.ok(proposal.moves.some((m) => m.lessonId === id), 'a card member is left behind');
      assert.ok(proposal.parallels.length >= 4, 'the proposal does not name the parallel lessons');
      assert.equal(clashing(afterMoves(start, proposal)), null);
    }
  });

  await check('(sw-c) an applied proposal moves exactly its lessons, takes a version first and logs each; its undo puts them back', async () => {
    const answer = await swaps.suggest({ lessonId: classLesson.id, limit: 5 }, asAdmin);
    const proposal = answer.proposals[0]!;
    offered = answer.proposals;
    const before = await rows();
    const logsBefore = Number((await owner.query(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [school])).rows[0].n);
    const applied = await swaps.apply(bodyOf(classLesson.id, proposal), asAdmin);
    const during = await rows();
    const moved = new Set(proposal.moves.map((m) => m.lessonId));
    for (const row of during) {
      const was = before.find((r) => r.id === row.id)!;
      const move = proposal.moves.find((m) => m.lessonId === row.id);
      if (move) assert.deepEqual([row.day, row.start], [move.to.dayOfWeek, move.to.startMinutes]);
      else assert.deepEqual(row, was, 'a lesson that was not in the proposal moved');
    }
    assert.equal(clashing(during), null, 'the stored timetable clashes after the apply');
    const version = (await owner.query(`SELECT name, "lessonCount" FROM "ScheduleVersions" WHERE id = $1`, [applied.versionId])).rows[0];
    assert.equal(version.name, 'Före byte');
    assert.equal(version.lessonCount, before.length);
    const logs = Number((await owner.query(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [school])).rows[0].n);
    assert.equal(logs - logsBefore, moved.size);
    // The undo is the same moves reversed.
    await swaps.apply(
      {
        lessonId: classLesson.id,
        moves: applied.undo.map((m) => ({
          lessonId: m.lessonId,
          from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
          to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
        })),
      },
      asAdmin,
    );
    assert.equal(await fingerprint(), JSON.stringify(before), 'the undo did not put every lesson back');
  });

  await check('(sw-d) a lesson that moved since the proposal is SWAP_STALE and nothing is written', async () => {
    const proposal = offered[0]!;
    const victim = proposal.moves[1]!.lessonId;
    await owner.query(`UPDATE "MasterLessons" SET "startTime" = "startTime" + interval '1 hour', "endTime" = "endTime" + interval '1 hour' WHERE id = $1`, [victim]);
    const before = await fingerprint();
    await assert.rejects(swaps.apply(bodyOf(classLesson.id, proposal), asAdmin), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code?: string }).code, 'SWAP_STALE');
      return true;
    });
    assert.equal(await fingerprint(), before);
    await owner.query(`UPDATE "MasterLessons" SET "startTime" = "startTime" - interval '1 hour', "endTime" = "endTime" - interval '1 hour' WHERE id = $1`, [victim]);
  });

  await check('(sw-d) a block card parted is SWAP_SPLITS_PARALLEL and nothing is written', async () => {
    const answer = await swaps.suggest({ lessonId: blockLesson.id, limit: 5 }, asAdmin);
    const proposal = answer.proposals[0]!;
    const parted = { ...proposal, moves: proposal.moves.filter((m) => m.lessonId !== answer.unit.lessonIds.find((id) => id !== blockLesson.id)) };
    const before = await fingerprint();
    await assert.rejects(swaps.apply(bodyOf(blockLesson.id, parted), asAdmin), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code?: string }).code, 'SWAP_SPLITS_PARALLEL');
      return true;
    });
    assert.equal(await fingerprint(), before);
    // Whichever member is left behind, the first by id included: the same 409, never a 500.
    const members = [...answer.unit.lessonIds].sort();
    const last = members[members.length - 1]!;
    const lastOnly = { ...proposal, moves: proposal.moves.filter((m) => m.lessonId === last || !members.includes(m.lessonId)) };
    await assert.rejects(swaps.apply(bodyOf(last, lastOnly), asAdmin), (error: unknown) => {
      assert.ok(error instanceof ConflictException, String(error));
      assert.equal((error.getResponse() as { code?: string }).code, 'SWAP_SPLITS_PARALLEL');
      return true;
    });
    assert.equal(await fingerprint(), before);
  });

  await check('(sw-d) a locked partner is SWAP_LOCKED; (sw-e) a locked picked lesson is still offered', async () => {
    const answer = await swaps.suggest({ lessonId: classLesson.id, limit: 5 }, asAdmin);
    const proposal = answer.proposals.find((p) => p.kind === 'SWAP') ?? answer.proposals[0]!;
    const partner = proposal.moves.find((m) => m.lessonId !== classLesson.id)!.lessonId;
    await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true WHERE id = $1`, [partner]);
    const before = await fingerprint();
    await assert.rejects(swaps.apply(bodyOf(classLesson.id, proposal), asAdmin), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code?: string }).code, 'SWAP_LOCKED');
      return true;
    });
    assert.equal(await fingerprint(), before);
    // The locked partner is no longer offered as one; and the picked lesson may itself be locked.
    const again = await swaps.suggest({ lessonId: classLesson.id, limit: 30 }, asAdmin);
    assert.ok(again.proposals.every((p) => !p.moves.some((m) => m.lessonId === partner)), 'a locked lesson is offered as a partner');
    await owner.query(`UPDATE "MasterLessons" SET "isLocked" = false WHERE id = $1`, [partner]);
    await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true WHERE id = $1`, [classLesson.id]);
    const lockedPicked = await swaps.suggest({ lessonId: classLesson.id, limit: 5 }, asAdmin);
    assert.equal(lockedPicked.selectedLocked, true);
    assert.ok(lockedPicked.proposals.length > 0, 'a locked picked lesson was offered nothing');
    await owner.query(`UPDATE "MasterLessons" SET "isLocked" = false WHERE id = $1`, [classLesson.id]);
  });

  await check('(sw-f) a post’s limit is counted, never worded, and the read of the post is recorded', async () => {
    // A teacher of the picked lesson gets a day limit on their post.
    const teacherId = (await owner.query(`SELECT "teacherId" FROM "MasterLessons" WHERE id = $1`, [classLesson.id])).rows[0].teacherId as string;
    await owner.query(`UPDATE "TeacherEmployments" SET "maxTeachingDaysPerWeek" = 5 WHERE "schoolId" = $1 AND "userId" = $2 AND "academicYearId" = $3`, [school, teacherId, year]);
    const reads = async () =>
      Number((await owner.query(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'EMPLOYMENT'`, [school])).rows[0].n);
    const before = await reads();
    const answer = await swaps.suggest({ lessonId: classLesson.id, limit: 5 }, asAdmin);
    assert.ok(answer.proposals.length > 0);
    for (const proposal of answer.proposals) {
      const cost = proposal.soft.find((c) => c.code === 'TEACHER_DAY')!;
      assert.deepEqual(Object.keys(cost).sort(), ['after', 'before', 'code', 'delta', 'unit']);
    }
    assert.ok((await reads()) > before, 'the read of a post was not recorded');
  });

  await check('(sw-g) a lesson that moved to another day at the same clock is SWAP_STALE and nothing is written', async () => {
    const proposal = offered[0]!;
    const victim = proposal.moves[1]!.lessonId;
    const was = (await owner.query(`SELECT "dayOfWeek" AS day FROM "MasterLessons" WHERE id = $1`, [victim])).rows[0].day as number;
    await owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = $2 WHERE id = $1`, [victim, was === 5 ? 4 : was + 1]);
    const before = await fingerprint();
    try {
      await assert.rejects(swaps.apply(bodyOf(classLesson.id, proposal), asAdmin), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as { code?: string }).code, 'SWAP_STALE');
        return true;
      });
      assert.equal(await fingerprint(), before);
    } finally {
      await owner.query(`UPDATE "MasterLessons" SET "dayOfWeek" = $2 WHERE id = $1`, [victim, was]);
    }
  });

  await check('(sw-h) a clock past the end of the day is a 400 that writes nothing, not a double booking', async () => {
    // A lesson moved to "34:00": 10:00 once the day has wrapped, where another lesson of its teacher stands.
    const ends = new Map(
      (await owner.query(`SELECT id, extract(hour FROM "endTime")::int * 60 + extract(minute FROM "endTime")::int AS "end" FROM "MasterLessons" WHERE "academicYearId" = $1`, [year])).rows.map(
        (r: { id: string; end: number }) => [r.id, r.end] as const,
      ),
    );
    const a = start.find((r) => seeded.classes.some((c) => c.id === r.groupId) && r.teacherId && start.some((b) => b.id !== r.id && b.teacherId === r.teacherId && b.day !== r.day))!;
    const b = start.find((r) => r.id !== a.id && r.teacherId === a.teacherId && r.day !== a.day)!;
    const c = start.find((r) => seeded.classes.some((k) => k.id === r.groupId) && r.groupId !== a.groupId && r.teacherId !== a.teacherId)!;
    const slotOf = (r: Row) => ({ dayOfWeek: r.day, startTime: clock(r.start), endTime: clock(ends.get(r.id)!) });
    const wrapped = { dayOfWeek: b.day, startTime: clock(b.start + 24 * 60), endTime: clock(ends.get(b.id)! + 24 * 60) };
    assert.ok(Number(wrapped.startTime.slice(0, 2)) > 23);
    const before = await fingerprint();
    // Without a frame: the stage's ramtid refuses 34:00 for being outside the school day, which hid the fault in a school that has one.
    const frames = (await owner.query(`DELETE FROM "FrameTimes" WHERE "schoolId" = $1 RETURNING *`, [school])).rows as Array<Record<string, unknown>>;
    try {
      await assert.rejects(
        swaps.apply({ lessonId: a.id, moves: [{ lessonId: a.id, from: slotOf(a), to: wrapped }, { lessonId: c.id, from: slotOf(c), to: slotOf(c) }] }, asAdmin),
        (error: unknown) => error instanceof BadRequestException,
      );
      assert.equal(await fingerprint(), before, 'a wrapped clock was written');
    } finally {
      for (const frame of frames) {
        const columns = Object.keys(frame);
        await owner.query(
          `INSERT INTO "FrameTimes" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
          columns.map((column) => frame[column]),
        );
      }
    }
  });

  await check('(sw-i) a proposal says how many published lessons it removes, apply removes exactly those, and Ångra does not bring them back', async () => {
    const zone = 'Europe/Stockholm';
    const now = new Date();
    // A swap with a move back by two weekdays or more: its published lessons land before today whatever the day is.
    let lessonId = '';
    let proposalId = '';
    for (const lesson of start.filter((r) => seeded.classes.some((c) => c.id === r.groupId))) {
      const found = (await swaps.suggest({ lessonId: lesson.id, limit: 30 }, asAdmin)).proposals.find(
        (p) => p.kind === 'SWAP' && p.moves.some((m) => m.from.dayOfWeek - m.to.dayOfWeek >= 2),
      );
      if (found) {
        lessonId = lesson.id;
        proposalId = found.id;
        break;
      }
    }
    assert.ok(lessonId, 'no swap with a move back by two weekdays');
    const proposalOf = async () => (await swaps.suggest({ lessonId, limit: 30 }, asAdmin)).proposals.find((p) => p.id === proposalId)!;
    const proposal = await proposalOf();
    assert.equal(proposal.removedCalendarLessons, 0, 'nothing is published, so nothing would be removed');

    // Two published lessons per moving lesson, tomorrow and a week on. (The weekday of a planted date is not the template's:
    // the rule carries a row by the template's move, and a backward move of two weekdays lands before today from tomorrow.)
    const isoDay = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const masters = (
      await owner.query(
        `SELECT id, "subjectId", "studentGroupId", "roomId" FROM "MasterLessons" WHERE id = ANY($1::uuid[])`,
        [proposal.moves.map((m) => m.lessonId)],
      )
    ).rows as Array<{ id: string; subjectId: string; studentGroupId: string; roomId: string | null }>;
    let expected = 0;
    let planted = 0;
    for (const move of proposal.moves) {
      const master = masters.find((m) => m.id === move.lessonId)!;
      for (const offset of [1, 8]) {
        const date = isoDay(offset).toISOString().slice(0, 10);
        await owner.query(
          `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
          [school, master.id, master.subjectId, master.studentGroupId, master.roomId, date, zonedTimeToUtc(date, clock(move.from.startMinutes), zone), zonedTimeToUtc(date, clock(move.from.endMinutes), zone)],
        );
        planted += 1;
        const target = isoDay(offset + move.to.dayOfWeek - move.from.dayOfWeek).toISOString().slice(0, 10);
        if (zonedTimeToUtc(target, clock(move.to.startMinutes), zone) <= now) expected += 1;
      }
    }
    assert.ok(expected > 0 && expected < planted, `${expected} of ${planted} planted lessons would be removed: the check needs both kinds`);
    const countRows = async () =>
      Number((await owner.query(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "masterLessonId" = ANY($1::uuid[])`, [proposal.moves.map((m) => m.lessonId)])).rows[0].n);

    try {
      assert.equal((await proposalOf()).removedCalendarLessons, expected, 'the proposal does not say what apply removes');
      const before = await fingerprint();
      const applied = await swaps.apply(bodyOf(lessonId, proposal), asAdmin);
      assert.equal(applied.removedCalendarLessons, expected, 'apply removed another number than the proposal said');
      assert.equal(applied.propagatedLessons, planted - expected);
      assert.equal(await countRows(), planted - expected);

      // Ångra: the timetable's lessons go back, the removed calendar lessons do not, and the safety version has a name of its own.
      const undone = await swaps.apply({ ...bodyOf(lessonId, proposal), moves: applied.undo.map((m) => ({
        lessonId: m.lessonId,
        from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
        to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
      })), versionName: 'Före ångra' }, asAdmin);
      assert.equal(await fingerprint(), before, 'the undo did not put the timetable back');
      assert.equal(await countRows(), planted - expected - undone.removedCalendarLessons, 'a removed calendar lesson came back');
      const name = (await owner.query(`SELECT name FROM "ScheduleVersions" WHERE id = $1`, [undone.versionId])).rows[0].name;
      assert.equal(name, 'Före ångra');
    } finally {
      await owner.query(`DELETE FROM "CalendarLessons" WHERE "schoolId" = $1`, [school]);
    }
  });

  await check('(sw-d) a teacher’s principal cannot write the timetable: the database refuses and nothing moves', async () => {
    const teacher = (await owner.query(`SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY email LIMIT 1`, [school])).rows[0];
    const asTeacher: AuthenticatedUser = { authId: teacher.authId, role: Role.TEACHER, userId: teacher.id, schoolId: school, channel: 'WEB' };
    const answer = await swaps.suggest({ lessonId: classLesson.id, limit: 3 }, asAdmin);
    const before = await fingerprint();
    await assert.rejects(swaps.apply(bodyOf(classLesson.id, answer.proposals[0]!), asTeacher));
    assert.equal(await fingerprint(), before);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
