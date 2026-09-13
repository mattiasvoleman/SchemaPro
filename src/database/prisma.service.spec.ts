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
    // A batch transaction takes its statements unexecuted, so the fakes are
    // markers the $transaction stub receives in order, and the stub answers
    // with one result per statement.
    let clientExecuteRaw: jest.Mock;

    beforeEach(() => {
      clientExecuteRaw = jest.fn().mockReturnValue('claims-statement');
      transaction.mockImplementation(() => Promise.resolve([0, 'profile']));
      Object.assign(service, { $executeRaw: clientExecuteRaw });
    });

    const lookup = () => 'lookup-statement' as never;

    it('sends the claims and the lookup as one batch, claims first', async () => {
      const query = jest.fn(lookup);

      await expect(service.withVerifiedSubject(AUTH_ID, query)).resolves.toBe(
        'profile',
      );

      expect(query).toHaveBeenCalledWith(service);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledWith([
        'claims-statement',
        'lookup-statement',
      ]);
    });

    it('injects the verified subject as the sub claim', async () => {
      await service.withVerifiedSubject(AUTH_ID, lookup);

      expect(clientExecuteRaw).toHaveBeenCalledTimes(1);
      const call = clientExecuteRaw.mock.calls[0] as unknown[];
      expect(rawSql(call)).toContain(`set_config('request.jwt.claim.sub'`);
      const [claims, sub, role] = rawValues(call);
      expect(sub).toBe(AUTH_ID);
      expect(role).toBe('authenticated');
      expect(JSON.parse(claims as string)).toEqual({
        sub: AUTH_ID,
        role: 'authenticated',
      });
    });
  });

  describe('queryWithRls', () => {
    let clientExecuteRaw: jest.Mock;

    beforeEach(() => {
      clientExecuteRaw = jest.fn().mockReturnValue('claims-statement');
      transaction.mockImplementation(() => Promise.resolve([0, ['a job']]));
      Object.assign(service, { $executeRaw: clientExecuteRaw });
    });

    it('sends the caller’s claims and the statement as one batch, claims first', async () => {
      const query = jest.fn(() => 'list-statement' as never);

      await expect(
        service.queryWithRls(testUser({ authId: AUTH_ID }), query),
      ).resolves.toEqual(['a job']);

      expect(query).toHaveBeenCalledWith(service);
      expect(transaction).toHaveBeenCalledWith([
        'claims-statement',
        'list-statement',
      ]);

      const [claims, sub, role] = rawValues(
        clientExecuteRaw.mock.calls[0] as unknown[],
      );
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
    /** The privilege probe result for a correctly configured deployment. */
    const leastPrivilege = {
      name: 'app_authenticated',
      rolsuper: false,
      rolbypassrls: false,
      unforcedOwnedTables: 0,
    };

    let $connect: jest.Mock;
    let $disconnect: jest.Mock;
    let $queryRaw: jest.Mock;
    let logger: { log: jest.Mock; warn: jest.Mock };

    const boot = (role: Partial<typeof leastPrivilege> | null) => {
      $queryRaw.mockResolvedValue(role ? [{ ...leastPrivilege, ...role }] : []);
      return service.onModuleInit();
    };

    beforeEach(() => {
      $connect = jest.fn().mockResolvedValue(undefined);
      $disconnect = jest.fn().mockResolvedValue(undefined);
      $queryRaw = jest.fn();
      logger = { log: jest.fn(), warn: jest.fn() };
      Object.assign(service, { $connect, $disconnect, $queryRaw, logger });
    });

    it('connects on module init and disconnects on destroy', async () => {
      await boot({});
      expect($connect).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith('Prisma connected.');

      await service.onModuleDestroy();
      expect($disconnect).toHaveBeenCalledTimes(1);
    });

    // Without these the tenancy model is inert: PostgreSQL skips policy
    // evaluation entirely and every query silently returns other schools' rows.
    it('refuses to boot as a role that has BYPASSRLS', async () => {
      await expect(boot({ name: 'postgres', rolbypassrls: true })).rejects.toThrow(
        /"postgres" has the BYPASSRLS attribute/,
      );
      expect(logger.log).not.toHaveBeenCalled();
    });

    it('refuses to boot as a superuser', async () => {
      await expect(boot({ name: 'postgres', rolsuper: true })).rejects.toThrow(
        /"postgres" is a superuser/,
      );
    });

    it('names the variable to change so the message is actionable', async () => {
      await expect(boot({ rolbypassrls: true })).rejects.toThrow(
        /DATABASE_URL.*app_authenticated/s,
      );
    });

    it('says what a bypassing role breaks, and where the owner rights belong instead', async () => {
      // The operator reading this is fixing a deployment whose migrations may
      // need exactly the rights refused here; the message has to say so.
      const message = await boot({ rolbypassrls: true }).then(
        () => '',
        (error: Error) => error.message,
      );

      expect(message).toMatch(/so PostgreSQL skips every row-level-security policy/);
      expect(message).toMatch(/multi-tenant isolation this API relies on is inert/);
      expect(message).toMatch(/see docs\/DEPLOYMENT\.md §3/);
      expect(message).toMatch(
        /keep those credentials in DIRECT_URL, which is not used at runtime\.$/,
      );
    });

    it('refuses to boot when the role cannot be identified', async () => {
      await expect(boot(null)).rejects.toThrow(
        /could not determine which database role/,
      );
      // And says what that leaves unconfirmed, which is the reason to refuse.
      await expect(boot(null)).rejects.toThrow(
        /no way to confirm row-level security applies to its queries\.$/,
      );
    });

    it('boots with a warning when the role owns tables that are not forced', async () => {
      await boot({ name: 'owner_role', unforcedOwnedTables: 26 });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('owns 26 application table(s)'),
      );
      // And what to do about it.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /policies do not apply to it\. DATABASE_URL should use a role that owns nothing \(see docs\/DEPLOYMENT\.md §3\)\.$/,
        ),
      );
      expect(logger.log).toHaveBeenCalledWith('Prisma connected.');
    });

    it('does not warn when the role owns nothing', async () => {
      await boot({});
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
