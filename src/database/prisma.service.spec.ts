import type { PrismaClient } from '@prisma/client';
import { testUser } from '../../test/utils/prisma-mock';
import { PrismaService } from './prisma.service';

const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * The wrappers are pure plumbing around `this.$transaction`, so the spec
 * builds the service without running the PrismaClient constructor (which
 * would validate DATABASE_URL and spin up an engine) and stubs $transaction
 * to hand the callback a fake tx. What matters — and what these tests pin —
 * is WHICH session variables each wrapper injects and with WHAT values,
 * because those settings are the entire tenancy model.
 */
describe('PrismaService', () => {
  let service: PrismaService;
  let executeRaw: jest.Mock;
  let transaction: jest.Mock;
  let tx: { $executeRaw: jest.Mock };

  /** Reconstructs the SQL text of a tagged-template $executeRaw call. */
  const rawSql = (call: unknown[]): string =>
    (call[0] as readonly string[]).join('?');
  /** The interpolated values of a tagged-template $executeRaw call. */
  const rawValues = (call: unknown[]): unknown[] => call.slice(1);

  beforeEach(() => {
    executeRaw = jest.fn().mockResolvedValue(0);
    tx = { $executeRaw: executeRaw };
    transaction = jest.fn((fn: (client: PrismaClient) => Promise<unknown>) =>
      fn(tx as unknown as PrismaClient),
    );
    service = Object.create(PrismaService.prototype) as PrismaService;
    Object.assign(service, { $transaction: transaction });
  });

  describe('withRls', () => {
    it('runs the callback on the transaction client and returns its result', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      await expect(service.withRls(testUser(), fn)).resolves.toBe('result');
      expect(fn).toHaveBeenCalledWith(tx);
    });

    it('injects both JWT claim styles before the callback runs', async () => {
      let executeRawCallsWhenFnRan = -1;
      const fn = jest.fn().mockImplementation(() => {
        executeRawCallsWhenFnRan = executeRaw.mock.calls.length;
        return Promise.resolve(null);
      });

      await service.withRls(testUser({ authId: AUTH_ID }), fn);

      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(executeRawCallsWhenFnRan).toBe(1);

      const call = executeRaw.mock.calls[0] as unknown[];
      const sql = rawSql(call);
      expect(sql).toContain(`set_config('request.jwt.claims'`);
      expect(sql).toContain(`set_config('request.jwt.claim.sub'`);
      expect(sql).toContain(`set_config('request.jwt.claim.role'`);

      const [claims, sub, role] = rawValues(call);
      expect(sub).toBe(AUTH_ID);
      expect(role).toBe('authenticated');
      expect(JSON.parse(claims as string)).toEqual({
        sub: AUTH_ID,
        role: 'authenticated',
      });
    });

    it('sets the PostgreSQL role claim to the literal "authenticated", never the app role', async () => {
      // auth.role() distinguishes anon/authenticated at the DB level; the
      // application role (testUser's default is SCHOOL_ADMIN) must not leak
      // into it.
      await service.withRls(testUser(), () => Promise.resolve(null));

      const values = rawValues(executeRaw.mock.calls[0] as unknown[]);
      expect(values).not.toContain('SCHOOL_ADMIN');
      expect(values[2]).toBe('authenticated');
    });

    it('defaults the transaction timeout to 15s', async () => {
      await service.withRls(testUser(), () => Promise.resolve(null));

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 15_000,
      });
    });

    it('honors a caller-supplied timeout', async () => {
      await service.withRls(testUser(), () => Promise.resolve(null), {
        timeoutMs: 120_000,
      });

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 120_000,
      });
    });

    it('propagates a callback rejection', async () => {
      const boom = new Error('boom');

      await expect(
        service.withRls(testUser(), () => Promise.reject(boom)),
      ).rejects.toBe(boom);
    });
  });

  describe('withVerifiedSubject', () => {
    it('injects the verified subject as the sub claim', async () => {
      await expect(
        service.withVerifiedSubject(AUTH_ID, () => Promise.resolve('profile')),
      ).resolves.toBe('profile');

      const call = executeRaw.mock.calls[0] as unknown[];
      const [claims, sub, role] = rawValues(call);
      expect(sub).toBe(AUTH_ID);
      expect(role).toBe('authenticated');
      expect(JSON.parse(claims as string)).toEqual({
        sub: AUTH_ID,
        role: 'authenticated',
      });
    });
  });

  describe('withServiceKeyLookup', () => {
    it('enables only the narrow key-lookup switch, no tenant or subject', async () => {
      const fn = jest.fn().mockResolvedValue('school');

      await expect(service.withServiceKeyLookup(fn)).resolves.toBe('school');
      expect(fn).toHaveBeenCalledWith(tx);

      expect(executeRaw).toHaveBeenCalledTimes(1);
      const call = executeRaw.mock.calls[0] as unknown[];
      expect(rawSql(call)).toContain(
        `set_config('app.service_key_lookup', 'on', true)`,
      );
      // No interpolated values: nothing caller-controlled reaches the setting.
      expect(rawValues(call)).toEqual([]);
      // And no timeout override — the plain $transaction default applies.
      expect(transaction).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('withServicePrincipal', () => {
    it('scopes the transaction to the integration key’s school', async () => {
      const fn = jest.fn().mockResolvedValue(42);

      await expect(service.withServicePrincipal(SCHOOL_ID, fn)).resolves.toBe(42);
      expect(fn).toHaveBeenCalledWith(tx);

      const call = executeRaw.mock.calls[0] as unknown[];
      expect(rawSql(call)).toContain(`set_config('app.service_school_id'`);
      expect(rawValues(call)).toEqual([SCHOOL_ID]);
    });

    it('defaults the transaction timeout to 30s and honors an override', async () => {
      await service.withServicePrincipal(SCHOOL_ID, () => Promise.resolve(null));
      expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
        timeout: 30_000,
      });

      await service.withServicePrincipal(
        SCHOOL_ID,
        () => Promise.resolve(null),
        { timeoutMs: 5_000 },
      );
      expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
        timeout: 5_000,
      });
    });
  });

  describe('withSystemTransaction', () => {
    it('opens a plain transaction and sets NO session variables', async () => {
      // Documented foot-gun: with no claims set, every RLS predicate is false
      // and queries return zero rows. The wrapper must not sneak any claim in.
      const fn = jest.fn().mockResolvedValue('rows');

      await expect(service.withSystemTransaction(fn)).resolves.toBe('rows');

      expect(fn).toHaveBeenCalledWith(tx);
      expect(executeRaw).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('lifecycle', () => {
    it('connects on module init and disconnects on destroy', async () => {
      const $connect = jest.fn().mockResolvedValue(undefined);
      const $disconnect = jest.fn().mockResolvedValue(undefined);
      Object.assign(service, {
        $connect,
        $disconnect,
        logger: { log: jest.fn() },
      });

      await service.onModuleInit();
      expect($connect).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
      expect($disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
