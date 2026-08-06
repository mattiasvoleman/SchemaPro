import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

/** Loose mock of a Prisma transaction client — tests stub what they need. */
export type TxMock = {
  [model: string]: { [method: string]: jest.Mock };
};

export interface PrismaMock {
  onModuleInit: jest.Mock;
  onModuleDestroy: jest.Mock;
  withRls: jest.Mock;
  withVerifiedSubject: jest.Mock;
  withServiceKeyLookup: jest.Mock;
  withServicePrincipal: jest.Mock;
  withSystemTransaction: jest.Mock;
}

/**
 * Auto-vivifying proxy over a Prisma transaction client: `tx.roomBooking.create`
 * exists as a `jest.Mock` the first time it is touched, so a spec only stubs the
 * calls it actually asserts on. Shared by the unit specs (`src/**\/*.spec.ts`)
 * and the e2e harness so both exercise the same call shapes.
 */
export function createTxMock(): TxMock {
  // Symbol lookups must fall through untouched. Vivifying them hands jest a
  // `jest.Mock` for `Symbol.iterator` / `Symbol.toStringTag`, which makes any
  // `toHaveBeenCalledWith(tx, ...)` assertion die inside the equality check.
  const vivify = <T>(make: () => T) =>
    new Proxy<Record<string, T>>(
      {},
      {
        get(target, key) {
          if (typeof key !== 'string') {
            return (target as Record<string | symbol, unknown>)[key];
          }
          target[key] = target[key] ?? make();
          return target[key];
        },
      },
    );

  return vivify(() => vivify(() => jest.fn())) as TxMock;
}

/**
 * A `PrismaService` stand-in whose `withRls` / `withSystemTransaction` invoke
 * the caller's callback with `tx` directly. Services under test therefore run
 * their real transaction bodies without a database.
 */
export function createPrismaMock(tx: TxMock): PrismaMock {
  const run = <T>(fn: (client: PrismaClient) => Promise<T>) =>
    fn(tx as unknown as PrismaClient);

  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    withRls: jest.fn(
      <T>(_user: AuthenticatedUser, fn: (client: PrismaClient) => Promise<T>) =>
        run(fn),
    ),
    withVerifiedSubject: jest.fn(
      <T>(_authId: string, fn: (client: PrismaClient) => Promise<T>) => run(fn),
    ),
    withServiceKeyLookup: jest.fn(run),
    withServicePrincipal: jest.fn(
      <T>(_schoolId: string, fn: (client: PrismaClient) => Promise<T>) =>
        run(fn),
    ),
    withSystemTransaction: jest.fn(run),
  };
}

// NOTE: these mocks run the callback directly, so a unit test proves the call
// *shape* and nothing about tenancy. The RLS session variables each real method
// sets are what actually confine a query, and no mock can exercise them —
// see scripts/test/rls-policies.sql for the tests that do.

/** Convenience: a fully-populated principal, overridable per test. */
export function testUser(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    authId: '11111111-1111-4111-8111-111111111111',
    role: 'SCHOOL_ADMIN',
    userId: '22222222-2222-4222-8222-222222222222',
    schoolId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  } as AuthenticatedUser;
}
