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
 * The school's people by e-mail domain, and what /login answers for other
 * domains: the two statements the domain checks send, told apart by text.
 */
function people(tx: TxMock, uses: Array<{ domain: string; people: number; staff: number }>, lookups: Record<string, string> = {}) {
  tx.$queryRaw.mockImplementation(async (query: { strings: string[]; values: unknown[] }) => {
    const text = query.strings.join('?');
    if (text.includes('split_part')) return uses.map((use) => ({ ...use, people: BigInt(use.people), staff: BigInt(use.staff) }));
    if (text.includes('sign_in_provider_for_domain')) return [{ provider: lookups[String(query.values[0])] ?? null }];
    return [];
  });
}

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
    // By default the school's people are all on skola.example.
    people(tx, [{ domain: 'skola.example', people: 120, staff: 14 }]);
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

    it('refuses a domain none of the school\'s active people use, before writing', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      await expect(service.put(admin(), entra({ domains: ['skola.example', 'annan.example'] }))).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_DOMAIN_UNUSED', params: { domains: 'annan.example' } },
      });
      expect(tx.schoolSignInMethod.create).not.toHaveBeenCalled();
    });

    it('requires the school account of staff only when every staff domain still gets an answer at /login', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      tx.schoolSignInMethod.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      people(
        tx,
        [
          { domain: 'skola.example', people: 120, staff: 14 },
          { domain: 'kommun.example', people: 12, staff: 12 },
          { domain: 'gmail.example', people: 300, staff: 0 },
          { domain: 'delad.example', people: 3, staff: 3 },
        ],
        // Another school names delad.example on Entra, so /login answers it; nobody names kommun.example.
        { 'delad.example': 'azure' },
      );
      const account = admin({ provider: 'azure', entraTenantId: TENANT });
      await expect(service.put(account, entra({ ssoOnlyForStaff: true }))).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT', params: { domains: 'kommun.example (12)' } },
      });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();

      // With kommun.example listed it goes through; guardians' gmail.example never mattered.
      people(
        tx,
        [
          { domain: 'skola.example', people: 120, staff: 14 },
          { domain: 'kommun.example', people: 12, staff: 12 },
          { domain: 'gmail.example', people: 300, staff: 0 },
          { domain: 'delad.example', people: 3, staff: 3 },
        ],
        { 'delad.example': 'azure' },
      );
      await expect(
        service.put(account, entra({ domains: ['skola.example', 'kommun.example'], ssoOnlyForStaff: true })),
      ).resolves.toMatchObject({ method: { ssoOnlyForStaff: true } });
    });

    it('does not look at other domains when the school account is not required', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
      people(tx, [
        { domain: 'skola.example', people: 120, staff: 14 },
        { domain: 'kommun.example', people: 12, staff: 12 },
      ]);
      await expect(service.put(admin(), entra())).resolves.toMatchObject({ method: { ssoOnlyForStaff: false } });
      const asked = tx.$queryRaw.mock.calls.map(([query]) => (query as { strings: string[] }).strings.join('?'));
      expect(asked.some((text) => text.includes('sign_in_provider_for_domain'))).toBe(false);
    });

    it('counts a staff domain another school names with another provider as left out', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      people(
        tx,
        [
          { domain: 'skola.example', people: 120, staff: 14 },
          { domain: 'google-skola.example', people: 2, staff: 2 },
        ],
        // /login offers Google there, so these two would find no Entra sign-in and lose their password.
        { 'google-skola.example': 'google' },
      );
      await expect(
        service.put(admin({ provider: 'azure', entraTenantId: TENANT }), entra({ ssoOnlyForStaff: true })),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT', params: { domains: 'google-skola.example (2)' } },
      });
      expect(tx.schoolSignInMethod.update).not.toHaveBeenCalled();
    });

    it('names the school\'s own domains another school uses with another provider', async () => {
      people(tx, [
        { domain: 'skola.example', people: 120, staff: 14 },
        { domain: 'delad.example', people: 3, staff: 3 },
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
