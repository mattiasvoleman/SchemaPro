import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { passportJwtSecret } from 'jwks-rsa';
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
import { ACCEPTED_ALGORITHMS } from './signing-key.provider';

jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn() }));

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
      issuer: 'https://issuer.test',
      jwksUri: 'https://issuer.test/.well-known/jwks.json',
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
    it('reads the pinned algorithms and JWKS URI from config', () => {
      const { configService } = buildStrategy();
      expect(configService.getOrThrow).toHaveBeenCalledWith('jwt');
      // "none" and the RSA family stay unnegotiable; see signing-key.provider.
      expect([...ACCEPTED_ALGORITHMS]).toEqual(['ES256', 'HS256']);
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

  // The path that actually broke in production: Supabase rotated to ES256, the
  // strategy still verified HS256, and every logged-in user got a bare 401.
  describe('authenticate', () => {
    const KID = 'f3fe84d5-3e20-4933-864d-81e41e2bfe07';
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKey = ec.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const privateKey = ec.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    beforeEach(() => {
      (passportJwtSecret as jest.Mock).mockReturnValue(
        (_request: unknown, _token: string, done: (e: unknown, k?: string) => void) =>
          done(null, publicKey),
      );
    });

    const supabaseToken = (keyid = KID) =>
      new JwtService({}).signAsync(
        { sub: AUTH_ID, role: 'authenticated' },
        {
          algorithm: 'ES256',
          privateKey,
          keyid,
          issuer: 'https://issuer.test',
        },
      );

    const run = (strategy: JwtStrategy, token: string) =>
      new Promise((resolve, reject) => {
        Object.assign(strategy, {
          success: resolve,
          fail: (challenge: unknown) => reject(new Error(String(challenge))),
          error: reject,
        });
        strategy.authenticate({
          headers: { authorization: `Bearer ${token}` },
        } as unknown as Parameters<JwtStrategy['authenticate']>[0]);
      });

    it('accepts an ES256 Supabase token and yields the database principal', async () => {
      const { strategy, tx } = buildStrategy();
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        schoolId: SCHOOL_ID,
        role: 'SCHOOL_ADMIN',
        isActive: true,
      });

      await expect(run(strategy, await supabaseToken())).resolves.toEqual({
        authId: AUTH_ID,
        role: 'SCHOOL_ADMIN',
        userId: USER_ID,
        schoolId: SCHOOL_ID,
      });
    });

    it('rejects a token signed with a key the JWKS does not serve', async () => {
      const { strategy, prisma } = buildStrategy();
      const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const token = await new JwtService({}).signAsync(
        { sub: AUTH_ID },
        {
          algorithm: 'ES256',
          privateKey: other.privateKey
            .export({ format: 'pem', type: 'pkcs8' })
            .toString(),
          keyid: KID,
          issuer: 'https://issuer.test',
        },
      );

      await expect(run(strategy, token)).rejects.toThrow();
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    /** A token the strategy would accept, but for the one claim a test changes. */
    const tokenWith = (
      claims: Record<string, unknown>,
      options: { issuer?: string; audience?: string } = {},
    ) =>
      new JwtService({}).signAsync(
        { sub: AUTH_ID, role: 'authenticated', ...claims },
        {
          algorithm: 'ES256',
          privateKey,
          keyid: KID,
          issuer: options.issuer ?? 'https://issuer.test',
          ...(options.audience ? { audience: options.audience } : {}),
        },
      );

    /** An active account, so that nothing but the token can be refused. */
    const withActiveAccount = (built: ReturnType<typeof buildStrategy>) => {
      built.tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        schoolId: SCHOOL_ID,
        role: 'TEACHER',
        isActive: true,
      });
      return built;
    };

    it('rejects an expired token even for an active account', async () => {
      const { strategy, prisma } = withActiveAccount(buildStrategy());
      const token = await tokenWith({ exp: Math.floor(Date.now() / 1000) - 60 });

      await expect(run(strategy, token)).rejects.toThrow(/expired/);
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('rejects a token some other issuer signed with a key the JWKS serves', async () => {
      const { strategy, prisma } = withActiveAccount(buildStrategy());
      const token = await tokenWith({}, { issuer: 'https://another-project.test' });

      await expect(run(strategy, token)).rejects.toThrow(/issuer invalid/);
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('holds a token to the configured audience', async () => {
      const built = withActiveAccount(buildStrategy({ audience: 'authenticated' }));

      await expect(
        run(built.strategy, await tokenWith({}, { audience: 'service_role' })),
      ).rejects.toThrow(/audience invalid/);
      await expect(
        run(built.strategy, await tokenWith({}, { audience: 'authenticated' })),
      ).resolves.toMatchObject({ userId: USER_ID });
    });

    it('fails the request when the signing keys cannot be fetched, instead of leaving it hanging', async () => {
      (passportJwtSecret as jest.Mock).mockReturnValue(
        (_request: unknown, _token: string, done: (e: unknown) => void) =>
          done(new Error('JWKS endpoint unreachable')),
      );
      const { strategy, prisma } = withActiveAccount(buildStrategy());
      const token = await tokenWith({});

      let timer: NodeJS.Timeout | undefined;
      const unanswered = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the strategy never answered')), 2000);
      });
      try {
        await expect(Promise.race([run(strategy, token), unanswered])).rejects.toThrow(
          /JWKS endpoint unreachable/,
        );
      } finally {
        clearTimeout(timer);
      }
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
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
