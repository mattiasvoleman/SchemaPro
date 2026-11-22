/**
 * Åtgärdsförslag vid vägran (20270305090000) through the real SuggestionsService and OptimizationJobsService, against Postgres, as
 * the API's role. The engine is answered by hand; everything else is the database's:
 *
 *   ag-a  a press on a run that ended INFEASIBLE claims the column through the adapter (the jsonb cast and the lease's seconds
 *         passed as a number to make_interval), answers RUNNING, and when the engine answers the column is DONE with the changes;
 *         the page's read of the run carries them, names a cap's teacher, and offers the button;
 *   ag-b  a second press while one runs is the first one's answer, and two presses at once are one analysis (the claim is one
 *         conditional UPDATE): the engine was asked once;
 *   ag-c  an analysis that has been RUNNING for longer than any lasts is read as FAILED/ABANDONED before anything sweeps it, and a
 *         new press takes it over; the late answer of the process that lost it does NOT overwrite the one that took over;
 *   ag-d  a run it may not be asked for (a timetable, an older run than the year's newest, a year with a run going) is 409 with
 *         its code, and wakes nothing; another school's administrator sees no such run (404);
 *   ag-e  the whitelist holds across the database: a column a hand edited (a part-timer's days in the open) is shown as nothing.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import type { AiEngineSuggestChangesResponse } from '../../src/optimization/interfaces/suggest-changes.interface';
import { OptimizationJobsService } from '../../src/optimization/optimization-jobs.service';
import type { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { SuggestionsService } from '../../src/optimization/suggestions.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function suggestionsSlug(marker: string, which: 'a' | 'b' = 'a'): string {
  return `${marker}-forslag-vagran-${which}`;
}

export async function sweepSuggestionsSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1)`, [[suggestionsSlug(marker, 'a'), suggestionsSlug(marker, 'b')]]);
}

export async function suggestionsChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSuggestionsSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const schoolOf = async (which: 'a' | 'b'): Promise<{ school: string; year: string; admin: AuthenticatedUser; adminId: string; teacher: string }> => {
    const school = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} förslag vid vägran ${which}`, suggestionsSlug(marker, which)],
      )
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe förslag vid vägran', '2095-08-17', '2096-06-12', true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;
    const adminRow = await one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'Frida', 'Förslag', 'SCHOOL_ADMIN', 'FULL', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
      [school, `${marker}-forslag-vagran-${which}@example.invalid`],
    );
    const teacher = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'Anna', 'Andersson', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id`,
        [school, `${marker}-forslag-lararen-${which}@example.invalid`],
      )
    ).id;
    return {
      school,
      year,
      adminId: adminRow.id,
      teacher,
      admin: { authId: adminRow.authId, userId: adminRow.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL' },
    };
  };
  const a = await schoolOf('a');
  const b = await schoolOf('b');

  // The engine, answered by hand: every call waits for the probe to say so.
  const calls: Array<(response: AiEngineSuggestChangesResponse) => void> = [];
  const RULE = '11111111-1111-4111-8111-111111111111';
  const proxy = {
    waitSeconds: 240,
    prepareSchedule: async () => ({
      ready: true,
      payload: { requestId: 'probe', academicYearId: a.year, requirements: [{ id: 'r' }], rooms: [], constraints: [] },
      storedRules: null,
      anonMaps: {},
    }),
    realiserOf: () => ({
      real: (id: string) => id,
      nameOf: () => undefined,
      teacherOfRule: (id: string) => (id === RULE ? a.teacher : undefined),
    }),
    callAiEngine: () => new Promise<AiEngineSuggestChangesResponse>((resolve) => calls.push(resolve)),
  };
  const service = new SuggestionsService(api, proxy as unknown as OptimizationProxyService);
  const jobs = new OptimizationJobsService(proxy as unknown as OptimizationProxyService, api);

  const answer = (): AiEngineSuggestChangesResponse => ({
    requestId: 'probe',
    verdict: 'CHANGES',
    changes: [{
      rule: 'TEACHER_DAILY_CAP', cost: 168, current: 300, needed: 330, weekdays: [3], requirementIds: [], roomIds: [], resourceIds: [RULE], proof: 'SOLVED',
    }],
    verified: true,
    searchSeconds: 60,
    verifySeconds: 2.5,
    elapsedMs: 70_000,
  });
  const plantRun = async (who: typeof a, over: { status?: string; solverStatus?: string | null; errorCode?: string | null; createdAt?: string } = {}): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "OptimizationJobs" ("schoolId", "academicYearId", "actorId", status, "solverStatus", "errorCode", "createdAt", "finishedAt")
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()))
         RETURNING id`,
        [who.school, who.year, who.adminId, over.status ?? 'SUCCEEDED', over.solverStatus === undefined ? 'INFEASIBLE' : over.solverStatus, over.errorCode ?? null, over.createdAt ?? null],
      )
    ).id;
  const column = async (id: string): Promise<{ state: string | null; startedAt: string | null; verdict: string | null }> =>
    one(`SELECT "suggestions"->>'state' AS state, "suggestions"->>'startedAt' AS "startedAt", "suggestions"->>'verdict' AS verdict FROM "OptimizationJobs" WHERE id = $1`, [id]);
  const until = async (what: string, done: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`never: ${what}`);
  };
  const codeOf = (error: unknown): string | undefined => (error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined);

  try {
    let first = '';

    await check('(ag-a) a press claims the column through the adapter, answers RUNNING, and the engine\'s answer makes it DONE and readable', async () => {
      first = await plantRun(a);
      const view = await service.start(first, a.admin);
      assert.equal(view.state, 'RUNNING');
      assert.deepEqual(await column(first), { state: 'RUNNING', startedAt: view.startedAt, verdict: null });
      await until('the engine was asked', async () => calls.length === 1);
      calls.shift()!(answer());
      await until('the column is DONE', async () => (await column(first)).state === 'DONE');
      assert.equal((await column(first)).verdict, 'CHANGES');
      const read = await jobs.get(first, a.admin);
      assert.equal(read.suggestionsOffered, true);
      assert.equal(read.suggestions?.state, 'DONE');
      assert.equal(read.suggestions?.changes[0]?.rule, 'TEACHER_DAILY_CAP');
      assert.deepEqual(read.suggestions?.changes[0]?.teacherNames, ['Anna Andersson']);
      assert.ok(!JSON.stringify(read).includes(a.teacher), 'the Users id never leaves');
    });

    await check('(ag-b) a second press while one runs is the first one\'s answer, and two at once are one analysis', async () => {
      const outcomes = await Promise.all([service.start(first, a.admin), service.start(first, a.admin)]);
      assert.equal(outcomes[0]!.state, 'RUNNING');
      assert.equal(outcomes[1]!.state, 'RUNNING');
      await until('one engine call', async () => calls.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(calls.length, 1, 'the engine was asked once for two presses at once');
      const third = await service.start(first, a.admin);
      assert.equal(third.state, 'RUNNING');
      assert.equal(third.startedAt, (await column(first)).startedAt, 'the same analysis');
      assert.equal(calls.length, 1, 'a press while it runs asks nobody');
      calls.shift()!(answer());
      await until('the column is DONE', async () => (await column(first)).state === 'DONE');
    });

    await check('(ag-c) an analysis RUNNING for longer than any lasts reads as abandoned, a press takes it over, and the late answer of the one that lost it does not overwrite', async () => {
      // Press once and leave the engine call open: this is the process that is about to be lost.
      await service.start(first, a.admin);
      await until('the engine was asked by the process that will be lost', async () => calls.length === 1);
      const lost = calls.shift()!;
      const startedAt = (await column(first)).startedAt!;
      await owner.query(
        `UPDATE "OptimizationJobs" SET "suggestions" = jsonb_set("suggestions", '{startedAt}', to_jsonb(to_char((now() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
        [first],
      );
      const read = await jobs.get(first, a.admin);
      assert.equal(read.suggestions?.state, 'FAILED');
      assert.equal(read.suggestions?.failure, 'ABANDONED');
      // A new press takes it over.
      const taken = await service.start(first, a.admin);
      assert.equal(taken.state, 'RUNNING');
      assert.notEqual(taken.startedAt, startedAt);
      await until('the engine was asked by the press that took over', async () => calls.length === 1);
      // The lost process answers late: its write is over an analysis that is not its own, and lands nowhere.
      lost(answer());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const held = await column(first);
      assert.equal(held.state, 'RUNNING', 'the late answer did not overwrite the analysis that took over');
      assert.equal(held.startedAt, taken.startedAt);
      calls.shift()!(answer());
      await until('the one that took over is DONE', async () => (await column(first)).state === 'DONE');
    });

    await check('(ag-d) a run it may not be asked for is 409 with its code and wakes nothing; another school sees no such run', async () => {
      calls.length = 0;
      const future = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();
      // A run with a timetable, the year's newest: no analysis of that.
      const withTimetable = await plantRun(a, { solverStatus: 'OPTIMAL', createdAt: future(60) });
      await assert.rejects(service.start(withTimetable, a.admin), (error: unknown) => codeOf(error) === 'SUGGESTIONS_NOT_FOR_THIS_RUN');
      // `first` is a refusal, but no longer the year's newest run.
      await assert.rejects(service.start(first, a.admin), (error: unknown) => codeOf(error) === 'SUGGESTIONS_RUN_IS_OLD');
      // A run going in the year holds the engine's cores: an older one, so that the refusal below is the newest run's.
      await owner.query(
        `INSERT INTO "OptimizationJobs" ("schoolId", "academicYearId", "actorId", status, "createdAt") VALUES ($1, $2, $3, 'RUNNING', now() - interval '1 hour')`,
        [a.school, a.year, a.adminId],
      );
      const newest = await plantRun(a, { createdAt: future(120) });
      await assert.rejects(service.start(newest, a.admin), (error: unknown) => codeOf(error) === 'SUGGESTIONS_YEAR_BUSY');
      assert.equal(calls.length, 0, 'none of them woke the engine');
      await owner.query(`DELETE FROM "OptimizationJobs" WHERE "academicYearId" = $1 AND status = 'RUNNING'`, [a.year]);
      // Another school: the run is not there for its administrator.
      await assert.rejects(service.start(newest, b.admin), (error: unknown) => error instanceof HttpException && error.getStatus() === 404);
    });

    await check('(ag-e) a column a hand edited into showing a part-timer\'s days in the open is shown as nothing', async () => {
      const run = await plantRun(b);
      await owner.query(
        `UPDATE "OptimizationJobs" SET "suggestions" = $2::jsonb WHERE id = $1`,
        [run, JSON.stringify({
          version: 1, state: 'DONE', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), verdict: 'CHANGES', verified: true, total: 1,
          searchSeconds: 60, verifySeconds: 1, failure: null,
          changes: [{ rule: 'TEACHER_WORK_DAYS', proof: 'SOLVED', cost: 1200, current: 3, needed: 4, weekdays: [2], requirementIds: [], requirementNames: [], roomIds: [], roomNames: [], resourceIds: [], teacherIds: [], hidden: false }],
        })],
      );
      const read = await jobs.get(run, b.admin);
      assert.equal(read.suggestions, null);
      assert.ok(!JSON.stringify(read).includes('TEACHER_WORK_DAYS'));
    });
  } finally {
    await sweepSuggestionsSchools(owner, marker);
  }
}
