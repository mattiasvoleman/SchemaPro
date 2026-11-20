/**
 * The adapter probe's checks for the search for the choice of teachers that eases the week (lärarval F3, 20270227090000), through
 * the REAL services on the API's role and real Postgres as CI runs it. In two schools of their own (slugs <marker>-sokning and
 * <marker>-sokning-b), swept whole before and after. The engine is the probe's stand-in (a week's demand is a base and the most
 * one teacher's posts in it add up to); everything else is the real thing: the plan, the fetch of the week
 * (prepareSchedule), the lease, the arms and the checks of the table, the sweep's door.
 *
 *   vo1  a whole search by the full administrator: the run is inserted, leased and renewed, accepts moves into the checkpoint, ends
 *        SUCCEEDED with figures, and every statement the task writes passes the table's own CHECKs (acceptedMoves <= round, the
 *        lease follows the heartbeat); the proposal it gives is an ordinary one whose changes are the checkpoint's, which the
 *        apply takes with the digest that covers the week, and which an undo reverses;
 *   vo2  two starts at once of one year: one wins and the other is 409 STAFFING_SEARCH_ALREADY_RUNNING, through the partial unique
 *        index as the adapter delivers it (23505), and an active search is not replaced by a start after it;
 *   vo3  a cancel: CANCELLING in the row, the task sees it at its next renewal and ends CANCELLED with the best so far kept;
 *   vo4  the arms: a teacher reads no run, the läsare reads and cannot start (the insert arm), another school's administrator
 *        meets a 404 and cannot cancel, and the table holds one finished run per year after a new start;
 *   vo5  the sweep's door: a run with an expired lease is failed SEARCH_ABANDONED with its checkpoint kept and shown as such by
 *        the page's read, a finished run past a day is deleted and a live one is not touched, and a call that carries a login is
 *        refused VO403 as the adapter delivers a custom SQLSTATE (P2010);
 *   vo6  a proposal that has gone old: a release taken back, or a frame time set, after the search read the school makes it 409
 *        STAFF_PROPOSAL_STALE, and the checkpoint of a run that was lost is still read as a proposal while the school is as it was.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { from } from 'rxjs';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { STAFF_PROPOSAL_STALE, StaffingProposalService } from '../../src/optimization/staffing-proposal.service';
import { STAFFING_SEARCH_ALREADY_RUNNING, STAFFING_SEARCH_GONE, StaffingSearchService } from '../../src/optimization/staffing-search.service';
import { StaffingWeekService } from '../../src/optimization/staffing-week.service';
import { withWeekBasis } from '../../src/optimization/staffing-week';
import { EngineReleaseService } from '../../src/staffing/engine-release.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function sokningSlug(marker: string): string {
  return `${marker}-sokning`;
}

export async function sweepSokningSchools(owner: Client, marker: string): Promise<void> {
  const slug = sokningSlug(marker);
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [slug, `${slug}-b`]);
}

const rejectsWith = async (body: () => Promise<unknown>, status: number, code?: string): Promise<void> => {
  await assert.rejects(body, (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
    assert.equal(error.getStatus?.(), status, `status ${String(error.getStatus?.())}: ${JSON.stringify(error.getResponse?.() ?? error)}`);
    if (code !== undefined) assert.equal((error.getResponse?.() as { code?: string })?.code, code, JSON.stringify(error.getResponse?.()));
    return true;
  });
};

const CAPACITY = 1000;
const BASE = 700;

/**
 * The stand-in engine: /week-bounds answers a week of the years it is asked for in which the demand is a base and the most one
 * teacher's posts add up to. It can be held (a gate) so that a search is mid-flight when the probe acts on it; /check-week
 * answers a week under the threshold, for the week route.
 */
function stubEngine() {
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const http = {
    post: (url: string, payload: Record<string, unknown>) =>
      from(
        (async () => {
          calls.push({ url, body: payload });
          if (url.endsWith('/check-week')) {
            return { data: { requestId: 'probe', verdict: 'OK', years: [], conflicts: null, skipped: ['LUNCH_STAGE'], elapsedMs: 1 } };
          }
          if (gate && calls.filter((call) => call.url.endsWith('/week-bounds')).length > 2) await gate;
          const requirements = (payload.requirements ?? []) as { teacherId: string | null; lessonsPerWeek: number; minutesPerLesson: number }[];
          const perTeacher = new Map<string, number>();
          for (const entry of requirements) {
            if (entry.teacherId === null) continue;
            perTeacher.set(entry.teacherId, (perTeacher.get(entry.teacherId) ?? 0) + entry.lessonsPerWeek * entry.minutesPerLesson);
          }
          const demand = BASE + Math.max(0, ...perTeacher.values());
          const years = (payload.years as number[] | undefined) ?? [9];
          const cut = (payload.cutoffs as { year: number; demandMinutes: number; capacityMinutes: number }[] | undefined) ?? [];
          return {
            data: {
              requestId: payload.requestId,
              weeksTotal: 1,
              weeksCounted: 1,
              rows: years.map((year) => {
                const guard = cut.find((c) => c.year === year);
                const stopped = guard !== undefined && demand * guard.capacityMinutes > guard.demandMinutes * CAPACITY;
                return { year, period: null, parity: null, demandMinutes: demand, capacityMinutes: CAPACITY, over: demand > CAPACITY, converged: !stopped, cutoff: stopped };
              }),
              refusal: null,
              deadlineHit: false,
              elapsedMs: 1,
            },
          };
        })(),
      ),
  };
  return {
    http,
    calls,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
      gate = null;
    },
  };
}

export async function sokningChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSokningSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const many = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const school = async (slug: string, name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [name, slug])).id;
  const a = await school(sokningSlug(marker), `${marker} sokning`);
  const b = await school(`${sokningSlug(marker)}-b`, `${marker} sokning b`);
  const yearOf = async (schoolId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe sokning', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [schoolId],
      )
    ).id;
  const yearA = await yearOf(a);
  const yearB = await yearOf(b);
  await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt") VALUES ($1, 1200, now())`, [a]);
  const group = async (schoolId: string, yearId: string, name: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 9, now()) RETURNING id`,
        [schoolId, yearId, name],
      )
    ).id;
  const classes = [await group(a, yearA, '9A'), await group(a, yearA, '9B'), await group(a, yearA, '9C'), await group(a, yearA, '9D')];
  const groupB = await group(b, yearB, '9X');
  const subject = async (schoolId: string, name: string, code: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [schoolId, name, code])).id;
  const ma = await subject(a, 'Matematik', 'MA');
  const maB = await subject(b, 'Matematik', 'MA');
  const person = async (schoolId: string, role: string, label: string, profile: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
      [schoolId, `${marker}-sokning-${label}@example.invalid`, label, role, profile, authId],
    );
    return { id: row.id, authId };
  };
  const user = (schoolId: string, who: { id: string; authId: string }, role: Role, adminProfile?: AuthenticatedUser['adminProfile']): AuthenticatedUser => ({
    authId: who.authId,
    userId: who.id,
    schoolId,
    role,
    channel: 'WEB',
    ...(adminProfile ? { adminProfile } : {}),
  });
  const full = await person(a, 'SCHOOL_ADMIN', 'full', 'FULL');
  const reader = await person(a, 'SCHOOL_ADMIN', 'lasare', 'LASARE');
  const fullB = await person(b, 'SCHOOL_ADMIN', 'full-b', 'FULL');
  const teachers = [await person(a, 'TEACHER', 'karin'), await person(a, 'TEACHER', 'lars'), await person(a, 'TEACHER', 'maria')];
  for (const t of teachers) {
    await owner.query(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 100, now())`, [a, t.id, yearA]);
    await owner.query(
      `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt") VALUES ($1, $2, $3, 7, 9, 'BEHORIG', now())`,
      [a, t.id, ma],
    );
  }
  // Four posts of Matematik, one per class, all led by Karin and all released: a week with a busy teacher and two idle ones.
  const posts: string[] = [];
  for (const g of classes) {
    posts.push(
      (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 2, 100, now()) RETURNING id`,
          [a, yearA, ma, g, teachers[0]!.id],
        )
      ).id,
    );
  }
  const postB = (
    await one<{ id: string }>(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt") VALUES ($1, $2, $3, $4, 2, 100, now()) RETURNING id`,
      [b, yearB, maB, groupB],
    )
  ).id;
  void postB;
  const asFull = user(a, full, Role.SCHOOL_ADMIN, 'FULL');
  const asReader = user(a, reader, Role.SCHOOL_ADMIN, 'LASARE');
  const asTeacher = user(a, teachers[1]!, Role.TEACHER);
  const asFullB = user(b, fullB, Role.SCHOOL_ADMIN, 'FULL');

  const engine = stubEngine();
  const proxy = new OptimizationProxyService(
    api,
    engine.http as never,
    { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 5000 }) } as never,
  );
  const staffing = new StaffingProposalService(api, proxy);
  const weeks = new StaffingWeekService(api, proxy, staffing);
  const search = new StaffingSearchService(api, proxy, staffing);
  const releases = new EngineReleaseService(api);
  const leadOf = async (id: string) => (await one<{ t: string | null }>(`SELECT "teacherId"::text AS t FROM "TeachingRequirements" WHERE id = $1`, [id])).t;
  const runRows = async (schoolId = a) =>
    many<{ id: string; status: string; errorCode: string | null; stopReason: string | null; acceptedMoves: number; round: number; checkpoint: { changes: unknown[] } | null }>(
      `SELECT id, status::text AS status, "errorCode", "stopReason", "acceptedMoves", round, checkpoint FROM "StaffingSearchRuns" WHERE "schoolId" = $1 ORDER BY "createdAt"`,
      [schoolId],
    );
  const idle = async (): Promise<void> => {
    for (let i = 0; i < 600 && search.running.length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(search.running, [], 'a search was still going');
  };
  const releaseAll = async () => {
    await releases.set({ academicYearId: yearA, requirementIds: posts, released: true }, asFull);
  };

  try {
    await check('(vo1) a whole search: leased, renewed, moves into the checkpoint, SUCCEEDED, a proposal the apply takes and an undo reverses', async () => {
      await releaseAll();
      const { runId } = await search.start({ academicYearId: yearA }, asFull);
      await idle();

      const view = await search.view(runId, asFull);
      assert.equal(view.status, 'SUCCEEDED', JSON.stringify(view));
      assert.ok(view.acceptedMoves > 0, 'a week with one busy teacher and two idle ones had nothing to ease');
      assert.ok(view.hasProposal);
      assert.equal(view.figures?.years.length, 1);
      assert.equal(view.figures?.years[0]?.year, 9);
      const week = view.figures!.years[0]!.weeks[0]!;
      assert.equal(week.before.demandMinutes, BASE + 4 * 200);
      assert.ok(week.after.demandMinutes < week.before.demandMinutes, JSON.stringify(week));
      // Counted by the engine's own route, one year at a time first, then each candidate with the guard.
      const bounds = engine.calls.filter((call) => call.url.endsWith('/week-bounds'));
      assert.ok(bounds.length > 2);
      assert.deepEqual(bounds[0]!.body.years, [9]);
      assert.equal(bounds[0]!.body.cutoffs, undefined);
      assert.ok(Array.isArray(bounds[1]!.body.cutoffs));

      const row = (await runRows()).find((r) => r.id === runId)!;
      assert.equal(row.status, 'SUCCEEDED');
      assert.ok(row.acceptedMoves <= row.round, 'the CHECK acceptedMoves <= round would have refused it');
      assert.ok(row.checkpoint!.changes.length > 0);

      // The proposal is the ordinary one: the checkpoint's moves, each from Karin to a teacher who is qualified.
      const { proposal } = await search.proposal(runId, asFull);
      assert.equal(proposal.assignments.length, row.checkpoint!.changes.length);
      assert.ok(proposal.assignments.every((x) => x.fromTeacherId === teachers[0]!.id && [teachers[1]!.id, teachers[2]!.id].includes(x.toTeacherId)));
      // Its digest is the tjänstefördelning's and the week's together, never the tjänstefördelning's alone.
      const staffingAlone = await api.withRls(asFull, (tx) => staffing.currentBasis(tx, asFull, yearA));
      assert.notEqual(proposal.basisSha256, staffingAlone);

      const changes = proposal.assignments.map((x) => ({ requirementId: x.requirementId, fromTeacherId: x.fromTeacherId, toTeacherId: x.toTeacherId }));
      // The week route takes the digest that covers the week, and answers the same.
      const shown = await weeks.check({ academicYearId: yearA, basisSha256: proposal.basisSha256, coversWeek: true, changes }, asFull);
      assert.equal(shown.status, 'DONE', JSON.stringify(shown));
      assert.equal(shown.basisSha256, proposal.basisSha256);
      const confirmed = proposal.assignments.filter((x) => x.newTeaching !== undefined).map((x) => ({ requirementId: x.requirementId, toTeacherId: x.toTeacherId }));
      const applied = await staffing.apply({ academicYearId: yearA, basisSha256: proposal.basisSha256, coversWeek: true, confirmedNewTeaching: confirmed, changes }, asFull);
      assert.equal(applied.updated, changes.length);
      for (const change of changes) assert.equal(await leadOf(change.requirementId), change.toTeacherId);
      await staffing.apply(
        { academicYearId: yearA, basisSha256: applied.basisSha256, undo: true, changes: changes.map((x) => ({ requirementId: x.requirementId, fromTeacherId: x.toTeacherId, toTeacherId: x.fromTeacherId })) },
        asFull,
      );
      for (const change of changes) assert.equal(await leadOf(change.requirementId), teachers[0]!.id);
    });

    await check('(vo2) two starts at once of one year: one wins, the other is 409 through the partial unique index', async () => {
      await releaseAll();
      engine.hold();
      const both = await Promise.allSettled([search.start({ academicYearId: yearA }, asFull), search.start({ academicYearId: yearA }, asFull)]);
      const won = both.filter((result) => result.status === 'fulfilled');
      const lost = both.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      assert.equal(won.length, 1, JSON.stringify(both.map((r) => r.status)));
      assert.equal(lost.length, 1);
      assert.equal((lost[0]!.reason as { getStatus: () => number }).getStatus(), 409);
      assert.equal((lost[0]!.reason as { getResponse: () => { code: string } }).getResponse().code, STAFFING_SEARCH_ALREADY_RUNNING);
      // And a start after it, while it is held mid-flight, is refused too: the active run keeps the year.
      await rejectsWith(() => search.start({ academicYearId: yearA }, asFull), 409, STAFFING_SEARCH_ALREADY_RUNNING);
      assert.equal((await runRows()).filter((r) => ['PENDING', 'RUNNING', 'CANCELLING'].includes(r.status)).length, 1);

      // (vo3, on the same run) a cancel: the row says CANCELLING, the task sees it, and the run ends CANCELLED.
      const active = (await runRows()).find((r) => ['PENDING', 'RUNNING'].includes(r.status))!;
      const cancelled = await search.cancel(active.id, asFull);
      assert.equal(cancelled.status, 'CANCELLING');
      engine.release();
      await idle();
      const ended = (await runRows()).find((r) => r.id === active.id)!;
      assert.ok(['CANCELLED', 'SUCCEEDED'].includes(ended.status), ended.status);
      assert.notEqual(ended.status, 'FAILED');
    });

    await check('(vo4) a teacher reads no run, the läsare reads and cannot start, another school meets a 404 and cannot cancel; one finished run is kept per year', async () => {
      await releaseAll();
      const { runId } = await search.start({ academicYearId: yearA }, asFull);
      await idle();
      assert.equal((await search.latest(yearA, asTeacher)), null, 'a teacher read a run');
      assert.equal((await search.latest(yearA, asReader))?.id, runId);
      await assert.rejects(() => search.start({ academicYearId: yearA }, asReader), /./, 'the läsare started a search');
      await rejectsWith(() => search.view(runId, asFullB), 404, STAFFING_SEARCH_GONE);
      await rejectsWith(() => search.cancel(runId, asFullB), 404, STAFFING_SEARCH_GONE);
      assert.equal((await search.latest(yearB, asFullB)), null);
      // A new start removes the year's older finished run: one is kept.
      await search.start({ academicYearId: yearA }, asFull);
      await idle();
      const rows = await runRows();
      assert.equal(rows.filter((r) => !['PENDING', 'RUNNING', 'CANCELLING'].includes(r.status)).length, 1, JSON.stringify(rows));
      assert.ok(!rows.some((r) => r.id === runId), 'the older finished run was kept');
    });

    await check('(vo5) the sweep: an expired lease is abandoned with its checkpoint kept, an old finished run is deleted, a live one is not touched, a login is refused VO403', async () => {
      await owner.query(`DELETE FROM "StaffingSearchRuns" WHERE "schoolId" = $1`, [a]);
      const basis = 'c'.repeat(64);
      const checkpointJson = JSON.stringify({
        changes: [{ requirementId: posts[0], fromTeacherId: teachers[0]!.id, toTeacherId: teachers[1]!.id }],
        tally: { better: 1, notBetter: 0, worse: 0, refused: 0, unranked: 0 },
      });
      const plant = async (
        status: string,
        times: { heartbeatAgo?: string; leaseAgo?: string; startedAgo?: string; finishedAgo?: string },
        withCheckpoint = false,
      ): Promise<string> => {
        const columns = ['"schoolId"', '"academicYearId"', 'status', '"staffingBasis"', '"weekBasis"', '"acceptedMoves"', 'round'];
        const values = ['$1', '$2', '$3::"StaffingSearchRunStatus"', '$4', '$4', withCheckpoint ? '1' : '0', withCheckpoint ? '2' : '0'];
        const params: unknown[] = [a, yearA, status, basis];
        const at = (column: string, ago: string | undefined) => {
          if (ago === undefined) return;
          columns.push(column);
          values.push(`now() - interval '${ago}'`);
        };
        at('"heartbeatAt"', times.heartbeatAgo);
        at('"leaseUntil"', times.leaseAgo);
        at('"startedAt"', times.startedAgo);
        at('"finishedAt"', times.finishedAgo);
        if (withCheckpoint) {
          columns.push('checkpoint');
          params.push(checkpointJson);
          values.push(`$${params.length}::jsonb`);
        }
        return (await one<{ id: string }>(`INSERT INTO "StaffingSearchRuns" (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING id`, params)).id;
      };
      const lost = await plant('RUNNING', { heartbeatAgo: '20 minutes', leaseAgo: '10 minutes', startedAgo: '21 minutes' }, true);
      const old = await plant('SUCCEEDED', { finishedAgo: '25 hours' });
      const fresh = await plant('SUCCEEDED', { finishedAgo: '23 hours' });
      // The page's read shows the lost run as what the sweep will make it, with its best so far.
      const shown = await search.view(lost, asFull);
      assert.equal(shown.status, 'FAILED');
      assert.equal(shown.errorCode, 'SEARCH_ABANDONED');
      assert.equal(shown.hasProposal, true);

      const changed = await search.sweep();
      assert.ok(changed >= 2, `the sweep changed ${changed}`);
      const rows = await runRows();
      const after = rows.find((r) => r.id === lost)!;
      assert.equal(after.status, 'FAILED');
      assert.equal(after.errorCode, 'SEARCH_ABANDONED');
      assert.equal(after.checkpoint!.changes.length, 1, 'the sweep dropped the checkpoint');
      assert.ok(!rows.some((r) => r.id === old), 'a run finished 25 hours ago was kept');
      assert.ok(rows.some((r) => r.id === fresh), 'a run finished 23 hours ago was deleted');
      assert.equal((await search.sweep()), 0, 'a second sweep changed something');

      // A door that takes no login: refused when the session has claims (the adapter delivers a custom SQLSTATE as P2010).
      await assert.rejects(
        () => api.withRls(asFull, (tx) => tx.$queryRaw`SELECT app.staffing_search_sweep()`),
        (error: { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } }; message?: string }) =>
          error.code === 'P2010' && (error.meta?.driverAdapterError?.cause?.originalCode === 'VO403' || /VO403|tar ingen inloggning/.test(error.message ?? '')),
      );
      await owner.query(`DELETE FROM "StaffingSearchRuns" WHERE "schoolId" = $1`, [a]);
    });

    await check('(vo6) a proposal gone old: a release taken back, or a school day set, after the search read the school is 409 STAFF_PROPOSAL_STALE', async () => {
      await owner.query(`DELETE FROM "FrameTimes" WHERE "schoolId" = $1`, [a]);
      await releaseAll();
      const { runId } = await search.start({ academicYearId: yearA }, asFull);
      await idle();
      assert.equal((await search.view(runId, asFull)).status, 'SUCCEEDED');
      const { proposal } = await search.proposal(runId, asFull);
      assert.equal(proposal.basisSha256.length, 64);

      // The week moves and the tjänstefördelning does not: a school day is set.
      await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt") VALUES ($1, 7, 9, '08:00', '15:30', now())`, [a]);
      await rejectsWith(() => search.proposal(runId, asFull), 409, STAFF_PROPOSAL_STALE);
      await owner.query(`DELETE FROM "FrameTimes" WHERE "schoolId" = $1`, [a]);
      // The school as it was: the proposal reads again, and its digest is the one it had.
      const again = await search.proposal(runId, asFull);
      assert.equal(again.proposal.basisSha256, proposal.basisSha256);

      // A release taken back changes the tjänstefördelning's basis (it covers the releases): old.
      await releases.set({ academicYearId: yearA, requirementIds: [posts[0]!], released: false }, asFull);
      await rejectsWith(() => search.proposal(runId, asFull), 409, STAFF_PROPOSAL_STALE);
      // The digest is both halves: the week's alone, or the tjänstefördelning's alone, is not it.
      assert.notEqual(withWeekBasis('a'.repeat(64), 'b'.repeat(64)), proposal.basisSha256);
    });
  } finally {
    await sweepSokningSchools(owner, marker);
  }
}
