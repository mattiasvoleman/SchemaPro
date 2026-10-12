import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import type { SignInMethodDto } from './dto';
import { accountFits, domainTakenRefusal, SignInMethodsService } from './sign-in-methods.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const TENANT = '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f';
const OTHER_TENANT = '5e4d3c2b-1a09-4877-8665-544332211000';
const NOW = new Date('2026-10-20T08:00:00Z');

const admin = (schoolAccount?: AuthenticatedUser['schoolAccount']): AuthenticatedUser => ({
  authId: '11111111-1111-4111-8111-111111111111',
  role: Role.SCHOOL_ADMIN,
  userId: '22222222-2222-4222-8222-222222222222',
  schoolId: SCHOOL,
  ...(schoolAccount ? { schoolAccount } : {}),
});

const row = (overrides: Record<string, unknown> = {}) => ({
  id: '44444444-4444-4444-8444-444444444444',
  schoolId: SCHOOL,
  provider: 'azure',
  domains: ['skola.example'],
  entraTenantId: TENANT,
  googleHostedDomain: null,
  ssoOnlyForStaff: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const config = (schoolAccounts: boolean) =>
  ({ get: (key: string) => (key === 'signIn' ? { schoolAccounts } : undefined) }) as unknown as ConfigService;

/** What @prisma/adapter-pg hands up for the domain trigger's RAISE (SQLSTATE SI409). */
const domainTaken = (detail?: string) =>
  Object.assign(new Error('Database error'), {
    code: 'P2039',
    meta: { driverAdapterError: { cause: { originalCode: 'SI409', originalMessage: 'SIGN_IN_DOMAIN_TAKEN', ...(detail ? { detail } : {}) } } },
  });

/**
 * The school's staff who can sign in, by e-mail domain, as the domain checks'
 * one statement returns them. The lookup /login uses answers for another
 * school's domains here too, so a check that asked it would be fooled the
 * way the guard once was.
 */
function staff(tx: TxMock, uses: Array<{ domain: string; staff: number }>, lookups: Record<string, string> = {}) {
  tx.$queryRaw.mockImplementation(async (query: { strings: string[]; values: unknown[] }) => {
    const text = query.strings.join('?');
    if (text.includes('split_part')) return uses.map((use) => ({ ...use, staff: BigInt(use.staff) }));
    if (text.includes('sign_in_provider_for_domain')) return [{ provider: lookups[String(query.values[0])] ?? null }];
    return [];
  });
}

/** The statements put sent, as text. */
const asked = (tx: TxMock) => tx.$queryRaw.mock.calls.map(([query]) => (query as { strings: string[] }).strings.join('?'));

const entra = (overrides: Partial<SignInMethodDto> = {}): SignInMethodDto =>
  ({ provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, ...overrides }) as SignInMethodDto;

describe('SignInMethodsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: SignInMethodsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SignInMethodsService(prisma as unknown as PrismaService, config(true));
    // By default the school's staff are all on skola.example.
    staff(tx, [{ domain: 'skola.example', staff: 14 }]);
  });

  describe('get', () => {
    it('answers the school row and how the admin signed in, under the admin\'s RLS', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      const account = { provider: 'azure' as const, entraTenantId: TENANT };

      await expect(service.get(admin(account))).resolves.toEqual({
        available: true,
        method: { provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: NOW },
        session: { schoolAccount: account },
      });
      expect(prisma.withRls).toHaveBeenCalledWith(admin(account), expect.any(Function));
      expect(tx.schoolSignInMethod.findUnique).toHaveBeenCalledWith({ where: { schoolId: SCHOOL } });
    });

    it('answers null for a school without school accounts and for a password session', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      await expect(service.get(admin())).resolves.toEqual({ available: true, method: null, session: { schoolAccount: null } });
    });

    it('refuses a principal without a school', async () => {
      await expect(service.get({ authId: 'x', role: Role.SCHOOL_ADMIN })).rejects.toThrow(ForbiddenException);
    });
  });

  describe('put', () => {
    it('creates the school\'s row, keeping only the pin of the provider', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));

      const result = await service.put(admin(), entra({ googleHostedDomain: 'skola.example' }));

      expect(tx.schoolSignInMethod.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL, provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false },
      });
      expect(result.method?.googleHostedDomain).toBeNull();
    });

    it('updates the row a school already has', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));

      const result = await service.put(
        admin(),
        { provider: 'google', domains: ['skola.example'], googleHostedDomain: 'skola.example', entraTenantId: TENANT } as SignInMethodDto,
      );

      expect(tx.schoolSignInMethod.update).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL },
        data: { provider: 'google', domains: ['skola.example'], entraTenantId: null, googleHostedDomain: 'skola.example', ssoOnlyForStaff: false },
      });
      expect(result.method).toMatchObject({ provider: 'google', entraTenantId: null });
    });

    it('refuses Entra without a tenant and Google without an hd, before writing', async () => {
      await expect(service.put(admin(), entra({ entraTenantId: null }))).rejects.toMatchObject({
        response: { code: 'SIGN_IN_TENANT_REQUIRED' },
      });
      await expect(
        service.put(admin(), { provider: 'google', domains: ['skola.example'] } as SignInMethodDto),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.put(admin(), { provider: 'google', domains: ['skola.example'] } as SignInMethodDto),
      ).rejects.toMatchObject({ response: { code: 'SIGN_IN_HOSTED_DOMAIN_REQUIRED' } });
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('turns SSO-only on only from a session signed in with this very organisation', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));

      for (const account of [
        undefined,
        { provider: 'azure' as const, entraTenantId: OTHER_TENANT },
        { provider: 'google' as const, googleHostedDomain: 'skola.example' },
        { provider: 'azure' as const },
      ]) {
        const refusal = service.put(admin(account), entra({ ssoOnlyForStaff: true }));
        await expect(refusal).rejects.toThrow(ConflictException);
        await expect(service.put(admin(account), entra({ ssoOnlyForStaff: true }))).rejects.toMatchObject({
          response: { code: 'SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT' },
        });
      }
      expect(prisma.withRls).not.toHaveBeenCalled();

      const result = await service.put(admin({ provider: 'azure', entraTenantId: TENANT }), entra({ ssoOnlyForStaff: true }));
      expect(result.method?.ssoOnlyForStaff).toBe(true);
    });

    it('lets SSO-only off from any session', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row({ ssoOnlyForStaff: true }));
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      await expect(service.put(admin(), entra({ ssoOnlyForStaff: false }))).resolves.toMatchObject({
        method: { ssoOnlyForStaff: false },
      });
    });

    it('counts invited, active teachers and admins, and the admin saving, by the domain of their address', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      await service.put(admin(), entra());
      const [query] = tx.$queryRaw.mock.calls
        .map(([sent]) => sent as { strings: string[]; values: unknown[] })
        .filter((sent) => sent.strings.join('?').includes('split_part'));
      const text = query!.strings.join('?');
      expect(text).toContain('"isActive"');
      expect(text).toContain(`"role" IN ('SCHOOL_ADMIN', 'TEACHER')`);
      expect(text).toContain('"invitedAt" IS NOT NULL OR "id" = ?::uuid');
      expect(query!.values).toEqual([SCHOOL, admin().userId]);
    });

    it('locks the stored row before it reads it, so a second save is judged against the first one\'s commit', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      await service.put(admin(), entra());
      const lock = tx.$queryRaw.mock.calls.findIndex(([sent]) =>
        (sent as { strings: string[] }).strings.join('?').includes('FOR NO KEY UPDATE'),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      const [sent] = tx.$queryRaw.mock.calls[lock] as [{ strings: string[]; values: unknown[] }];
      expect(sent.strings.join('?')).toBe('SELECT 1 FROM "SchoolSignInMethods" WHERE "schoolId" = ?::uuid FOR NO KEY UPDATE');
      expect(sent.values).toEqual([SCHOOL]);
      expect(tx.$queryRaw.mock.invocationCallOrder[lock]).toBeLessThan(tx.schoolSignInMethod.findUnique.mock.invocationCallOrder[0]!);
    });

    it('refuses a domain the save adds that none of those staff use, before writing', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      await expect(service.put(admin(), entra({ domains: ['skola.example', 'annan.example'] }))).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_DOMAIN_UNUSED', params: { domains: 'annan.example' } },
      });
      expect(tx.schoolSignInMethod.create).not.toHaveBeenCalled();
    });

    it('does not ask again about a domain already on the row, so the switch always goes off', async () => {
      // The last teacher on gammal.example has left since it was listed.
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row({ domains: ['skola.example', 'gammal.example'], ssoOnlyForStaff: true }));
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      await expect(
        service.put(admin(), entra({ domains: ['skola.example', 'gammal.example'], ssoOnlyForStaff: false })),
      ).resolves.toMatchObject({ method: { ssoOnlyForStaff: false } });
    });

    it('asks again about a kept domain when the save changes the provider', async () => {
      // Nobody on gammal.example any more; switching to Google must not keep it for Google.
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row({ domains: ['skola.example', 'gammal.example'] }));
      await expect(
        service.put(admin(), {
          provider: 'google',
          domains: ['skola.example', 'gammal.example'],
          googleHostedDomain: 'skola.example',
        } as SignInMethodDto),
      ).rejects.toMatchObject({ status: 409, response: { code: 'SIGN_IN_DOMAIN_UNUSED', params: { domains: 'gammal.example' } } });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();

      // Without it the switch goes through.
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      await expect(
        service.put(admin(), { provider: 'google', domains: ['skola.example'], googleHostedDomain: 'skola.example' } as SignInMethodDto),
      ).resolves.toMatchObject({ method: { provider: 'google', domains: ['skola.example'] } });
    });

    it('requires the school account of staff only when every staff domain is on the row itself', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'kommun.example', staff: 12 },
        { domain: 'gmail.com', staff: 1 },
      ]);
      const account = admin({ provider: 'azure', entraTenantId: TENANT });
      await expect(service.put(account, entra({ ssoOnlyForStaff: true }))).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT', params: { domains: 'kommun.example (12), gmail.com (1)' } },
      });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();

      // kommun.example can be listed; the teacher on gmail.com needs a school address first.
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'kommun.example', staff: 12 },
      ]);
      await expect(
        service.put(account, entra({ domains: ['skola.example', 'kommun.example'], ssoOnlyForStaff: true })),
      ).resolves.toMatchObject({ method: { ssoOnlyForStaff: true } });
    });

    it('refuses dropping a staff domain while the switch stays on, though the old row still names it', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(
        row({ domains: ['skola.example', 'kommun.example'], ssoOnlyForStaff: true }),
      );
      // Asked inside the save, the lookup would still find the row being replaced.
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'kommun.example', staff: 12 },
      ], { 'kommun.example': 'azure' });
      await expect(
        service.put(admin({ provider: 'azure', entraTenantId: TENANT }), entra({ domains: ['skola.example'], ssoOnlyForStaff: true })),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT', params: { domains: 'kommun.example (12)' } },
      });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();
      expect(asked(tx).some((text) => text.includes('sign_in_provider_for_domain'))).toBe(false);
    });

    it('does not count a staff domain as covered because another school names it with the same provider', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      // Another school names delad.example on Entra today; it may drop it tomorrow.
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'delad.example', staff: 3 },
      ], { 'delad.example': 'azure' });
      await expect(
        service.put(admin({ provider: 'azure', entraTenantId: TENANT }), entra({ ssoOnlyForStaff: true })),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT', params: { domains: 'delad.example (3)' } },
      });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();
      expect(asked(tx).some((text) => text.includes('sign_in_provider_for_domain'))).toBe(false);
    });

    it('does not hold the switch off for staff domains when the school account is not required', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'kommun.example', staff: 12 },
      ]);
      await expect(service.put(admin(), entra())).resolves.toMatchObject({ method: { ssoOnlyForStaff: false } });
    });

    it('names the school\'s own domains another school uses with another provider', async () => {
      staff(tx, [
        { domain: 'skola.example', staff: 14 },
        { domain: 'delad.example', staff: 3 },
      ]);
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockRejectedValue(domainTaken('domains=delad.example,skola.example'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(service.put(admin(), entra({ domains: ['skola.example', 'delad.example'] }))).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_DOMAIN_TAKEN', params: { domains: 'delad.example, skola.example' } },
      });
      // The operator decides whose domain it is (DEPLOYMENT.md 11.7), so the collision is logged.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[domains=delad.example,skola.example]'));
      warn.mockRestore();
    });

    it('answers a lost race for the one row as a conflict, not a 500', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: ['schoolId'] } }),
      );
      await expect(service.put(admin(), entra())).rejects.toThrow(ConflictException);
    });
  });

  describe('with school accounts off for the deployment (SCHOOL_ACCOUNTS=off)', () => {
    beforeEach(() => {
      service = new SignInMethodsService(prisma as unknown as PrismaService, config(false));
    });

    it('says so, saves nothing, and still removes a row', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      await expect(service.get(admin())).resolves.toMatchObject({ available: false });
      await expect(service.put(admin({ provider: 'azure', entraTenantId: TENANT }), entra())).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_NOT_AVAILABLE' },
      });
      expect(tx.schoolSignInMethod.create).not.toHaveBeenCalled();
      tx.schoolSignInMethod.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.remove(admin())).resolves.toEqual({ removed: true });
    });

    it('still answers the lookup, so a school that requires the school account keeps a way in', async () => {
      tx.$queryRaw.mockResolvedValue([{ provider: 'azure' }]);
      await expect(service.providerFor('skola.example')).resolves.toBe('azure');
    });

    it('reads a missing config as off', async () => {
      const unset = new SignInMethodsService(prisma as unknown as PrismaService, { get: () => undefined } as unknown as ConfigService);
      await expect(unset.get(admin())).resolves.toMatchObject({ available: false });
    });
  });

  describe('domainTakenRefusal', () => {
    it('reads the taken domains from the trigger\'s DETAIL, and nothing else', () => {
      expect(domainTakenRefusal(domainTaken('domains=a.example,b.example'))).toEqual(['a.example', 'b.example']);
      expect(domainTakenRefusal(domainTaken('domains=a.example,<script>'))).toEqual(['a.example']);
      expect(domainTakenRefusal(domainTaken())).toEqual([]);
      expect(domainTakenRefusal(domainTaken('something else'))).toEqual([]);
      expect(domainTakenRefusal(new Error('boom'))).toBeNull();
      expect(domainTakenRefusal(null)).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes the school\'s row and says whether there was one', async () => {
      tx.schoolSignInMethod.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      await expect(service.remove(admin())).resolves.toEqual({ removed: true });
      await expect(service.remove(admin())).resolves.toEqual({ removed: false });
      expect(tx.schoolSignInMethod.deleteMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL } });
    });
  });

  describe('providerFor', () => {
    it('asks the database with the domain lowered and trimmed, without a principal', async () => {
      tx.$queryRaw.mockResolvedValue([{ provider: 'google' }]);
      await expect(service.providerFor('  Skola.Example ')).resolves.toBe('google');
      expect(prisma.withPublicViewer).toHaveBeenCalled();
      expect(tx.$queryRaw.mock.calls[0]![0].values).toEqual(['skola.example']);
    });

    it('answers null when no school names the domain', async () => {
      tx.$queryRaw.mockResolvedValue([{ provider: null }]);
      await expect(service.providerFor('okand.example')).resolves.toBeNull();
      tx.$queryRaw.mockResolvedValue([]);
      await expect(service.providerFor('okand.example')).resolves.toBeNull();
    });

    it('never asks about a string that is no host name', async () => {
      for (const domain of ['', 'localhost', 'anna@skola.example', '%.example', 'skola..example', `${'a'.repeat(64)}.example`, '10.0.0.1']) {
        await expect(service.providerFor(domain)).resolves.toBeNull();
      }
      expect(prisma.withPublicViewer).not.toHaveBeenCalled();
    });
  });

  describe('accountFits', () => {
    it('matches the provider and its pin, nothing else', () => {
      const method = { provider: 'azure' as const, entraTenantId: TENANT, googleHostedDomain: null };
      expect(accountFits({ provider: 'azure', entraTenantId: TENANT }, method)).toBe(true);
      expect(accountFits({ provider: 'azure', entraTenantId: OTHER_TENANT }, method)).toBe(false);
      expect(accountFits({ provider: 'azure' }, { ...method, entraTenantId: null })).toBe(false);
      const google = { provider: 'google' as const, entraTenantId: null, googleHostedDomain: 'skola.example' };
      expect(accountFits({ provider: 'google', googleHostedDomain: 'skola.example' }, google)).toBe(true);
      expect(accountFits({ provider: 'google', googleHostedDomain: 'annan.example' }, google)).toBe(false);
      expect(accountFits({ provider: 'google' }, { ...google, googleHostedDomain: null })).toBe(false);
      expect(accountFits(undefined, google)).toBe(false);
    });
  });
});
