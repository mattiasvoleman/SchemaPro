import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  enterGrundschemaWrite,
  isLockTimeout,
  PUBLISH_IN_PROGRESS,
  publishModeOf,
  tryEnterPublication,
} from './publish-mode';

const lockTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('canceling statement due to lock timeout', {
    code: 'P2010',
    clientVersion: '7',
    meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
  });

describe('publiceringsläge for writers and readers', () => {
  it('answers the mode the database gives, DIRECT for anything else', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ mode: 'DRAFT' }]) } as unknown as PrismaClient;
    await expect(enterGrundschemaWrite(tx, 'school')).resolves.toBe('DRAFT');
    const empty = { $queryRaw: jest.fn().mockResolvedValue([]) } as unknown as PrismaClient;
    await expect(publishModeOf(empty, 'school')).resolves.toBe('DIRECT');
  });

  it('takes the lock and the mode in ONE statement, the school bound as a parameter', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ mode: 'DIRECT' }]);
    await enterGrundschemaWrite({ $queryRaw: queryRaw } as unknown as PrismaClient, 'school-id');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const statement = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(statement.text).toBe('SELECT app.enter_grundschema_write($1::uuid) AS "mode"');
    expect(statement.values).toEqual(['school-id']);
  });

  it('answers 409 PUBLISH_IN_PROGRESS when the lock timeout runs out', async () => {
    const tx = { $queryRaw: jest.fn().mockRejectedValue(lockTimeout()) } as unknown as PrismaClient;
    const error = await enterGrundschemaWrite(tx, 'school').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: PUBLISH_IN_PROGRESS });
  });

  it('lets every other error through as it was', async () => {
    const other = new Error('connection reset');
    const tx = { $queryRaw: jest.fn().mockRejectedValue(other) } as unknown as PrismaClient;
    await expect(enterGrundschemaWrite(tx, 'school')).rejects.toBe(other);
    expect(isLockTimeout(other)).toBe(false);
    expect(isLockTimeout(lockTimeout())).toBe(true);
  });
});

describe('tryEnterPublication', () => {
  it('asks for the key enter_publication takes without waiting for it, the school bound as a uuid parameter', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ got: true }]);
    await expect(tryEnterPublication({ $queryRaw: queryRaw } as unknown as PrismaClient, 'school-id')).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const statement = queryRaw.mock.calls[0]![0] as Prisma.Sql;
    expect(statement.text).toBe(
      `SELECT pg_try_advisory_xact_lock(hashtext('publication'), hashtext($1::uuid::text)) AS "got"`,
    );
    expect(statement.values).toEqual(['school-id']);
  });

  it('asks again until the lock is free, and takes it', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ got: false }])
      .mockResolvedValueOnce([{ got: false }])
      .mockResolvedValue([{ got: true }]);
    await expect(
      tryEnterPublication({ $queryRaw: queryRaw } as unknown as PrismaClient, 'school', { waitMs: 1_000, everyMs: 1 }),
    ).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('gives up when the lock is not free in time, rather than queue behind the holders', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ got: false }]);
    await expect(
      tryEnterPublication({ $queryRaw: queryRaw } as unknown as PrismaClient, 'school', { waitMs: 15, everyMs: 3 }),
    ).resolves.toBe(false);
    expect(queryRaw.mock.calls.length).toBeGreaterThan(1);
  });

  it('reads an empty answer as not got', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await expect(
      tryEnterPublication({ $queryRaw: queryRaw } as unknown as PrismaClient, 'school', { waitMs: 0, everyMs: 1 }),
    ).resolves.toBe(false);
  });
});
