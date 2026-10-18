import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  GENERATE_STALE,
  generateStale,
  lockApplyYearKey,
  lockYearForCandidateApply,
  lockYearForRegeneration,
  lockYearForSolveStart,
  lockYearMasters,
  SCHEDULE_BUSY,
  SCHEDULE_CANDIDATE_BUSY,
  SCHEDULE_CANDIDATE_STALE,
  scheduleCandidateStale,
} from './regeneration-lock';

const YEAR = '44444444-4444-4444-8444-444444444444';

/** 55P03 as @prisma/adapter-pg hands a lock_timeout over. */
const lockTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('canceling statement due to lock timeout', {
    code: 'P2010',
    clientVersion: '7',
    meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
  });

/** The SQL text of a tagged-template $executeRaw call, its values as `?`. */
const rawSql = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

const clientWith = (executeRaw: jest.Mock, queryRaw: jest.Mock = jest.fn().mockResolvedValue([])) =>
  ({ $executeRaw: executeRaw, $queryRaw: queryRaw }) as unknown as PrismaClient;

/** The body a ConflictException answers with. */
const bodyOf = (error: unknown): Record<string, unknown> =>
  (error as ConflictException).getResponse() as Record<string, unknown>;

describe('the year’s start lock (Generera’s POST jobs and a candidate start)', () => {
  it('waits at most 5 s for the year’s own key, a different one from the rewrite’s', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);

    await lockYearForSolveStart(clientWith(executeRaw), YEAR, SCHEDULE_BUSY);

    expect(executeRaw.mock.calls.map(rawSql)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SELECT pg_advisory_xact_lock(hashtext('grundschema-solve-start'), hashtext(?::uuid::text))",
    ]);
    expect(executeRaw.mock.calls[1]!.slice(1)).toEqual([YEAR]);
  });

  it('answers a wait past the 5 s under the code its caller names', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(lockTimeout());

    const error = await lockYearForSolveStart(clientWith(executeRaw), YEAR, 'CANDIDATES_RUNNING').catch(
      (thrown: unknown) => thrown,
    );

    expect(bodyOf(error)).toMatchObject({ code: 'CANDIDATES_RUNNING' });
  });
});

describe('the room and staffing applies’ own year keys', () => {
  it('waits at most 5 s for the key and puts the transaction’s lock_timeout back after it', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);
    const queryRaw = jest.fn().mockResolvedValue([{ previous: '0' }]);

    await lockApplyYearKey(clientWith(executeRaw, queryRaw), 'room-optimization', YEAR);

    expect(executeRaw.mock.calls.map(rawSql)).toEqual([
      "SELECT set_config('lock_timeout', '5s', true)",
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::uuid::text))',
      "SELECT set_config('lock_timeout', ?, true)",
    ]);
    expect(executeRaw.mock.calls[1]!.slice(1)).toEqual(['room-optimization', YEAR]);
    expect(executeRaw.mock.calls[2]!.slice(1)).toEqual(['0']);
  });

  it('answers 409 SCHEDULE_BUSY when a schemaförslag apply holds the key past the 5 s', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(lockTimeout());
    const queryRaw = jest.fn().mockResolvedValue([{ previous: '0' }]);

    const error = await lockApplyYearKey(clientWith(executeRaw, queryRaw), 'staffing-proposal', YEAR).catch(
      (thrown: unknown) => thrown,
    );

    expect(bodyOf(error)).toMatchObject({ code: SCHEDULE_BUSY });
  });
});

describe('the year’s regeneration lock', () => {
  it('waits at most 5 s, then takes the year’s exclusive lock with the year bound as a value', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);

    await lockYearForRegeneration(clientWith(executeRaw), YEAR);

    expect(executeRaw.mock.calls.map(rawSql)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext(?::uuid::text))",
    ]);
    // A parameter, never text spliced into the statement.
    expect(executeRaw.mock.calls[1]!.slice(1)).toEqual([YEAR]);
  });

  it('answers 409 SCHEDULE_BUSY when another rewrite holds the year past the 5 s', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(lockTimeout());

    const error = await lockYearForRegeneration(clientWith(executeRaw), YEAR).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictException);
    expect(bodyOf(error)).toMatchObject({ code: SCHEDULE_BUSY });
  });

  it('answers under the code the caller names', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(lockTimeout());

    const error = await lockYearForRegeneration(clientWith(executeRaw), YEAR, SCHEDULE_CANDIDATE_BUSY).catch(
      (thrown: unknown) => thrown,
    );

    expect(bodyOf(error)).toMatchObject({ code: SCHEDULE_CANDIDATE_BUSY });
  });

  it('passes any other failure on as it is', async () => {
    const broken = new Error('connection reset');
    const executeRaw = jest.fn().mockRejectedValue(broken);

    await expect(lockYearForRegeneration(clientWith(executeRaw), YEAR)).rejects.toBe(broken);
  });

  it('takes an apply’s three locks in one order: regeneration, rooms, staffing', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);

    await lockYearForCandidateApply(clientWith(executeRaw), YEAR);

    // The order is the deadlock argument: nothing else takes two of these, so
    // two holders always meet them the same way round.
    expect(executeRaw.mock.calls.map(rawSql)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext(?::uuid::text))",
      "SELECT pg_advisory_xact_lock(hashtext('room-optimization'), hashtext(?::uuid::text))",
      "SELECT pg_advisory_xact_lock(hashtext('staffing-proposal'), hashtext(?::uuid::text))",
    ]);
  });

  it('answers an apply that waits out a room or staffing apply with SCHEDULE_CANDIDATE_BUSY', async () => {
    const executeRaw = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(lockTimeout());

    const error = await lockYearForCandidateApply(clientWith(executeRaw), YEAR).catch((thrown: unknown) => thrown);

    expect(bodyOf(error)).toMatchObject({ code: SCHEDULE_CANDIDATE_BUSY });
  });

  it('locks every master lesson of the year FOR UPDATE, in id order, and hands back their ids', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const ids = await lockYearMasters(clientWith(jest.fn(), queryRaw), YEAR);

    expect(ids).toEqual(['a', 'b']);
    const statement = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(statement.text).toBe(
      'SELECT "id"::text AS "id" FROM "MasterLessons" WHERE "academicYearId" = $1::uuid ORDER BY "id" FOR UPDATE',
    );
    expect(statement.values).toEqual([YEAR]);
  });

  it('answers a row lock held past the 5 s with SCHEDULE_CANDIDATE_BUSY', async () => {
    const queryRaw = jest.fn().mockRejectedValue(lockTimeout());

    const error = await lockYearMasters(clientWith(jest.fn(), queryRaw), YEAR).catch((thrown: unknown) => thrown);

    expect(bodyOf(error)).toMatchObject({ code: SCHEDULE_CANDIDATE_BUSY });
  });

  it('says what changed under a stale candidate, and which refusal the draft now meets', () => {
    expect(bodyOf(scheduleCandidateStale(['preserved', 'draft'], 'BLOCK_PARTLY_LOCKED_SUMMARY'))).toEqual({
      message: expect.any(String),
      code: SCHEDULE_CANDIDATE_STALE,
      changed: ['preserved', 'draft'],
      refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY',
      // What reaches the browser: the problem filter forwards flat params only.
      params: { changed: 'preserved,draft', refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' },
    });
    expect(bodyOf(scheduleCandidateStale([]))).toMatchObject({ changed: [], refusalCode: null, params: {} });
  });

  it('names a generate that lost its draft under it', () => {
    expect(generateStale().getStatus()).toBe(409);
    expect(bodyOf(generateStale())).toMatchObject({ code: GENERATE_STALE });
  });
});
