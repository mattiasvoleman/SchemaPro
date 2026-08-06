import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { Role } from './enums/role.enum';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import { JwtStrategy } from './jwt.strategy';

const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * `PassportStrategy(Strategy)` reads config in the constructor, so every test
 * builds the strategy through this rather than Nest's DI container — the unit
 * under test is `validate()`, not the wiring.
 */
function buildStrategy(jwt: Partial<Record<string, unknown>> = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const configService = {
    getOrThrow: jest.fn().mockReturnValue({
      secret: 'a-test-secret-that-is-long-enough-000000',
      issuer: undefined,
      audience: undefined,
      ...jwt,
    }),
  } as unknown as ConfigService;

  const strategy = new JwtStrategy(
    configService,
    prisma as unknown as PrismaService,
  );
  return { strategy, tx, prisma, configService };
}

const payload = (overrides: Partial<JwtPayload> = {}): JwtPayload =>
  ({ sub: AUTH_ID, ...overrides }) as JwtPayload;

describe('JwtStrategy', () => {
  describe('constructor', () => {
    it('pins HS256 so the accepted algorithm is never negotiable', () => {
      const { configService } = buildStrategy();
      expect(configService.getOrThrow).toHaveBeenCalledWith('jwt');
    });

    it('builds without issuer/audience when they are not configured', () => {
      expect(() => buildStrategy({ issuer: undefined, audience: undefined }))
        .not.toThrow();
    });

    it('builds with issuer and audience when configured', () => {
      expect(() =>
        buildStrategy({ issuer: 'https://issuer.test', audience: 'aud' }),
      ).not.toThrow();
    });
  });

  describe('validate', () => {
    let strategy: JwtStrategy;
    let tx: TxMock;
    let prisma: PrismaMock;

    beforeEach(() => {
      ({ strategy, tx, prisma } = buildStrategy());
    });

    const activeProfile = (overrides: Record<string, unknown> = {}) => ({
      id: USER_ID,
      schoolId: SCHOOL_ID,
      role: 'TEACHER',
      isActive: true,
      ...overrides,
    });

    it('resolves the principal from the database, not the token', async () => {
      tx.user.findUnique.mockResolvedValue(activeProfile());

      await expect(
        // A spoofed role/tenant in the token body must be ignored entirely.
        strategy.validate(
          payload({
            role: Role.SCHOOL_ADMIN,
            schoolId: 'attacker-controlled',
          } as Partial<JwtPayload>),
        ),
      ).resolves.toEqual({
        authId: AUTH_ID,
        role: 'TEACHER',
        userId: USER_ID,
        schoolId: SCHOOL_ID,
      });
    });

    it('scopes the lookup to the verified subject', async () => {
      tx.user.findUnique.mockResolvedValue(activeProfile());

      await strategy.validate(payload());

      // Regression guard: this used withSystemTransaction, which does not
      // bypass RLS and silently matched zero rows for every user.
      expect(prisma.withVerifiedSubject).toHaveBeenCalledWith(
        AUTH_ID,
        expect.any(Function),
      );
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(tx.user.findUnique).toHaveBeenCalledWith({
        where: { authId: AUTH_ID },
        select: { id: true, schoolId: true, role: true, isActive: true },
      });
    });

    it('rejects a token with no subject before touching the database', async () => {
      await expect(strategy.validate(payload({ sub: undefined }))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('rejects an empty-string subject', async () => {
      await expect(strategy.validate(payload({ sub: '' }))).rejects.toThrow(
        'Invalid authentication token.',
      );
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('rejects a deactivated account even though the row exists', async () => {
      tx.user.findUnique.mockResolvedValue(activeProfile({ isActive: false }));

      await expect(strategy.validate(payload())).rejects.toThrow(
        'No active user profile is linked to this account.',
      );
    });

    it('rejects a subject with no profile row', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expect(strategy.validate(payload())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    describe('SYSTEM_ADMIN fallback', () => {
      it('honours a platform operator that has no tenant profile', async () => {
        // SYSTEM_ADMIN is deliberately absent from the per-tenant Users table.
        tx.user.findUnique.mockResolvedValue(null);

        await expect(
          strategy.validate(
            payload({
              role: Role.SYSTEM_ADMIN,
              userId: 'ops-1',
              schoolId: undefined,
            } as Partial<JwtPayload>),
          ),
        ).resolves.toEqual({
          authId: AUTH_ID,
          role: Role.SYSTEM_ADMIN,
          userId: 'ops-1',
          schoolId: undefined,
        });
      });

      it('does not let a deactivated tenant account escalate via the claim', async () => {
        // The row exists but is inactive, and the token claims SYSTEM_ADMIN.
        // The fallback is reached — this documents that deactivating a user
        // does NOT revoke a token that carries the platform-operator role.
        tx.user.findUnique.mockResolvedValue(activeProfile({ isActive: false }));

        await expect(
          strategy.validate(
            payload({ role: Role.SYSTEM_ADMIN } as Partial<JwtPayload>),
          ),
        ).resolves.toMatchObject({ role: Role.SYSTEM_ADMIN });
      });

      it('ignores any other role claim when no profile exists', async () => {
        tx.user.findUnique.mockResolvedValue(null);

        for (const role of [Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT]) {
          await expect(
            strategy.validate(payload({ role } as Partial<JwtPayload>)),
          ).rejects.toThrow(UnauthorizedException);
        }
      });
    });
  });
});
