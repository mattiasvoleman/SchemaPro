import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptions } from 'passport-jwt';
import type { JwtConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  ACCEPTED_ALGORITHMS,
  createSigningKeyProvider,
} from './signing-key.provider';

/**
 * Verifies bearer JWTs. Supports both first-party service tokens (which carry
 * the application role directly) and Supabase Auth access tokens (whose `role`
 * claim is the PostgREST role, e.g. "authenticated"). For Supabase tokens the
 * application role / tenant are resolved from the `Users` table by `authId`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const jwt = configService.getOrThrow<JwtConfig>('jwt');
    const signingKey = createSigningKeyProvider(jwt);

    const options: StrategyOptions = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: (_request, rawToken: string, done) => {
        // passport-jwt hands the key unchanged to jsonwebtoken.verify, which
        // takes a KeyObject; @types/passport-jwt still types it string | Buffer.
        const pass = done as (error: unknown, key?: KeyObject) => void;
        signingKey(rawToken).then(
          (key) => pass(null, key),
          (error: unknown) => pass(error),
        );
      },
      // Pin the accepted signature algorithms. Supabase issues ES256 (verified
      // against its JWKS); HS256 covers first-party service tokens. Pinning
      // removes any algorithm ambiguity — notably "none".
      algorithms: [...ACCEPTED_ALGORITHMS],
      ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience ? { audience: jwt.audience } : {}),
    };

    super(options);
  }

  /**
   * Runs after the signature/issuer/audience/expiry have been verified.
   * Returns the principal that Passport attaches to `request.user`.
   *
   * Security note: the application role, tenant (`schoolId`) and internal
   * `userId` are ALWAYS resolved from the `Users` table by the verified
   * subject claim — never trusted from the token body. This ensures that even
   * if a token carried a spoofed `role`/`schoolId` claim, it cannot grant
   * access beyond what the database says the account is, and revoked/inactive
   * accounts are rejected on every request.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid authentication token.');
    }

    // Identity lookup by the verified subject claim, scoped to that subject.
    //
    // This previously used `withSystemTransaction` on the assumption that it
    // ran outside RLS. It does not — the API connects as a non-owner role, so
    // policies apply to every statement, and with no claims set the lookup
    // matched zero rows. Every authenticated request failed with "No active
    // user profile is linked to this account".
    //
    // `payload.sub` is verified at this point (signature, issuer, audience and
    // expiry are all checked before validate() runs), so injecting it grants
    // exactly the caller's own row via the users_self_select policy.
    const profile = await this.prisma.withVerifiedSubject(payload.sub, (tx) =>
      tx.user.findUnique({
        where: { authId: payload.sub },
        select: { id: true, schoolId: true, role: true, isActive: true },
      }),
    );

    if (profile && profile.isActive) {
      return {
        authId: payload.sub,
        role: profile.role as Role,
        userId: profile.id,
        schoolId: profile.schoolId,
      };
    }

    // No tenant profile exists for this subject. A genuine cross-tenant
    // platform operator (SYSTEM_ADMIN) is intentionally NOT stored in the
    // per-tenant Users table, so honour that role ONLY when the verified token
    // explicitly carries it — it grants no implicit RLS data access.
    if (payload.role === Role.SYSTEM_ADMIN) {
      return {
        authId: payload.sub,
        role: Role.SYSTEM_ADMIN,
        userId: payload.userId,
        schoolId: payload.schoolId,
      };
    }

    throw new UnauthorizedException(
      'No active user profile is linked to this account.',
    );
  }
}
