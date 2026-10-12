import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../database/prisma.service';
import type { SignInMethodDto } from './dto';
import { accountFits, SignInMethodsService } from './sign-in-methods.service';

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

const entra = (overrides: Partial<SignInMethodDto> = {}): SignInMethodDto =>
  ({ provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, ...overrides }) as SignInMethodDto;

describe('SignInMethodsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: SignInMethodsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SignInMethodsService(prisma as unknown as PrismaService);
  });

  describe('get', () => {
    it('answers the school row and how the admin signed in, under the admin\'s RLS', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(row());
      const account = { provider: 'azure' as const, entraTenantId: TENANT };

      await expect(service.get(admin(account))).resolves.toEqual({
        method: { provider: 'azure', domains: ['skola.example'], entraTenantId: TENANT, googleHostedDomain: null, ssoOnlyForStaff: false, updatedAt: NOW },
        session: { schoolAccount: account },
      });
      expect(prisma.withRls).toHaveBeenCalledWith(admin(account), expect.any(Function));
      expect(tx.schoolSignInMethod.findUnique).toHaveBeenCalledWith({ where: { schoolId: SCHOOL } });
    });

    it('answers null for a school without school accounts and for a password session', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      await expect(service.get(admin())).resolves.toEqual({ method: null, session: { schoolAccount: null } });
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

    it('answers a lost race for the one row as a conflict, not a 500', async () => {
      tx.schoolSignInMethod.findUnique.mockResolvedValue(null);
      tx.schoolSignInMethod.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: ['schoolId'] } }),
      );
      await expect(service.put(admin(), entra())).rejects.toThrow(ConflictException);
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
