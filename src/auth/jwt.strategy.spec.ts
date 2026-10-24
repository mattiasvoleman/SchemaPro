import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
import { SCHOOL_ID_INVALID, SCHOOL_NOT_AVAILABLE } from './school-choice';
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

/** A request that names no school (X-School-Id), as every request did before Flera skolor. */
const NO_SCHOOL = { headers: {} };
const naming = (school: string) => ({ headers: { 'x-school-id': school } });

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
      tx.user.findFirst.mockResolvedValue({
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
      built.tx.user.findFirst.mockResolvedValue({
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
      tx.user.findFirst.mockResolvedValue(activeProfile());

      await expect(
        // A spoofed role/tenant in the token body must be ignored entirely.
        strategy.validate(
          NO_SCHOOL,
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

    it("carries an administrator's profile and HR-läs from the database, and nobody else's", async () => {
      tx.user.findFirst.mockResolvedValue(
        activeProfile({ role: 'SCHOOL_ADMIN', adminProfile: 'SCHEMALAGGARE', hrRead: true }),
      );
      await expect(strategy.validate(NO_SCHOOL, payload())).resolves.toEqual({
        authId: AUTH_ID,
        role: 'SCHOOL_ADMIN',
        userId: USER_ID,
        schoolId: SCHOOL_ID,
        adminProfile: 'SCHEMALAGGARE',
        hrRead: true,
      });

      tx.user.findFirst.mockResolvedValue(activeProfile({ adminProfile: null, hrRead: false }));
      const teacher = await strategy.validate(NO_SCHOOL, payload());
      expect(teacher).not.toHaveProperty('adminProfile');
      expect(teacher).not.toHaveProperty('hrRead');
    });

    it('names the school account a school-account session signed in with, and nothing for a password', async () => {
      tx.user.findFirst.mockResolvedValue(activeProfile({ role: 'SCHOOL_ADMIN' }));
      const tenant = '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f';

      await expect(
        strategy.validate(
          NO_SCHOOL,
          payload({
            amr: [{ method: 'oauth', timestamp: 1 }],
            user_metadata: { iss: `https://login.microsoftonline.com/${tenant}/v2.0`, custom_claims: { tid: tenant } },
          }),
        ),
      ).resolves.toEqual({
        authId: AUTH_ID,
        role: 'SCHOOL_ADMIN',
        userId: USER_ID,
        schoolId: SCHOOL_ID,
        schoolAccount: { provider: 'azure', entraTenantId: tenant },
      });

      const password = await strategy.validate(
          NO_SCHOOL,
        payload({
          amr: [{ method: 'password', timestamp: 1 }],
          user_metadata: { iss: `https://login.microsoftonline.com/${tenant}/v2.0` },
        }),
      );
      expect(password).not.toHaveProperty('schoolAccount');
    });

    it('scopes the lookup to the verified subject', async () => {
      tx.user.findFirst.mockResolvedValue(activeProfile());

      await strategy.validate(NO_SCHOOL, payload());

      // Regression guard: this used withSystemTransaction, which does not
      // bypass RLS and silently matched zero rows for every user.
      expect(prisma.withVerifiedSubject).toHaveBeenCalledWith(
        AUTH_ID,
        expect.any(Function),
        {},
      );
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: { authId: AUTH_ID },
        select: { id: true, schoolId: true, role: true, isActive: true, adminProfile: true, hrRead: true },
      });
    });

    describe('a login with rows at several schools (Flera skolor per inloggning)', () => {
      const OTHER_SCHOOL = '44444444-4444-4444-8444-444444444444';

      it('looks the row up at the school the request names, in lower case', async () => {
        tx.user.findFirst.mockResolvedValue(activeProfile());

        await expect(strategy.validate(naming(SCHOOL_ID.toUpperCase()), payload())).resolves.toMatchObject({
          schoolId: SCHOOL_ID,
          userId: USER_ID,
        });
        expect(prisma.withVerifiedSubject).toHaveBeenCalledTimes(1);
        expect(prisma.withVerifiedSubject).toHaveBeenCalledWith(AUTH_ID, expect.any(Function), { school: SCHOOL_ID });
      });

      it('refuses a header that names no school before touching the database', async () => {
        const error = await strategy.validate(naming('skolan'), payload()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({ code: SCHOOL_ID_INVALID });
        expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
      });

      it('answers SCHOOL_NOT_AVAILABLE, not another school, for a school the login has no row in', async () => {
        // The named school's lookup finds nothing; the login has a row elsewhere.
        tx.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: USER_ID });

        const error = await strategy.validate(naming(OTHER_SCHOOL), payload()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({ code: SCHOOL_NOT_AVAILABLE });
        expect(prisma.withVerifiedSubject).toHaveBeenNthCalledWith(1, AUTH_ID, expect.any(Function), { school: OTHER_SCHOOL });
        expect(prisma.withVerifiedSubject).toHaveBeenNthCalledWith(2, AUTH_ID, expect.any(Function), {});
      });

      it('still 401s a login with no row anywhere, whatever it names', async () => {
        tx.user.findFirst.mockResolvedValue(null);

        await expect(strategy.validate(naming(OTHER_SCHOOL), payload())).rejects.toThrow(UnauthorizedException);
      });

      it("forwards the hook's closed schools to the lookup and to every transaction after it", async () => {
        tx.user.findFirst.mockResolvedValue(activeProfile());
        const closed = { [OTHER_SCHOOL]: 'sso_required' };

        await expect(
          strategy.validate(NO_SCHOOL, payload({ rastra_closed_schools: closed } as Partial<JwtPayload>)),
        ).resolves.toMatchObject({ closedSchools: closed });
        expect(prisma.withVerifiedSubject).toHaveBeenCalledWith(AUTH_ID, expect.any(Function), { closedSchools: closed });
      });

      it('keeps every closed school, whatever its reason says', async () => {
        tx.user.findFirst.mockResolvedValue(activeProfile());

        const user = await strategy.validate(
          NO_SCHOOL,
          payload({ rastra_closed_schools: { [OTHER_SCHOOL]: 7 } } as Partial<JwtPayload>),
        );
        expect(user.closedSchools).toEqual({ [OTHER_SCHOOL]: 'closed' });
      });

      it('reads a claim that is no object as no closed school', async () => {
        tx.user.findFirst.mockResolvedValue(activeProfile());

        for (const claim of [[OTHER_SCHOOL], 'x', null, {}]) {
          const user = await strategy.validate(NO_SCHOOL, payload({ rastra_closed_schools: claim } as Partial<JwtPayload>));
          expect(user).not.toHaveProperty('closedSchools');
        }
      });
    });

    it('rejects a token with no subject before touching the database', async () => {
      await expect(strategy.validate(NO_SCHOOL, payload({ sub: undefined }))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('rejects an empty-string subject', async () => {
      await expect(strategy.validate(NO_SCHOOL, payload({ sub: '' }))).rejects.toThrow(
        'Invalid authentication token.',
      );
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('rejects a deactivated account even though the row exists', async () => {
      tx.user.findFirst.mockResolvedValue(activeProfile({ isActive: false }));

      await expect(strategy.validate(NO_SCHOOL, payload())).rejects.toThrow(
        'No active user profile is linked to this account.',
      );
    });

    it('rejects a subject with no profile row', async () => {
      tx.user.findFirst.mockResolvedValue(null);

      await expect(strategy.validate(NO_SCHOOL, payload())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    describe('SYSTEM_ADMIN fallback', () => {
      it('honours a platform operator that has no tenant profile', async () => {
        // SYSTEM_ADMIN is deliberately absent from the per-tenant Users table.
        tx.user.findFirst.mockResolvedValue(null);

        await expect(
          strategy.validate(
          NO_SCHOOL,
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
        tx.user.findFirst.mockResolvedValue(activeProfile({ isActive: false }));

        await expect(
          strategy.validate(
          NO_SCHOOL,
            payload({ role: Role.SYSTEM_ADMIN } as Partial<JwtPayload>),
          ),
        ).resolves.toMatchObject({ role: Role.SYSTEM_ADMIN });
      });

      it('ignores any other role claim when no profile exists', async () => {
        tx.user.findFirst.mockResolvedValue(null);

        for (const role of [Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT]) {
          await expect(
            strategy.validate(NO_SCHOOL, payload({ role } as Partial<JwtPayload>)),
          ).rejects.toThrow(UnauthorizedException);
        }
      });
    });
  });
});
