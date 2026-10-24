import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptionsWithRequest } from 'passport-jwt';
import type { JwtConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import { schoolAccountOf } from './school-account';
import { closedSchoolsOf, schoolChoiceOf, schoolNotAvailable } from './school-choice';
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

    const options: StrategyOptionsWithRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // validate() reads the school the request names (X-School-Id).
      passReqToCallback: true,
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
   *
   * A login has one row per school (Flera skolor per inloggning), and the
   * request names the school in X-School-Id. The lookup runs under that
   * choice, so the row it finds is the one the database's RLS answers for
   * in every transaction after it (PrismaService names the row's school
   * again there): the named school's active row, else, with none named, the
   * login's row that took the login first. A school named that the login has
   * no active row in, or that the access-token hook closed, gets 403
   * SCHOOL_NOT_AVAILABLE rather than another school: the client asked about
   * that one.
   */
  async validate(
    request: { headers?: Record<string, string | string[] | undefined> },
    payload: JwtPayload,
  ): Promise<AuthenticatedUser> {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid authentication token.');
    }
    const school = schoolChoiceOf(request.headers);
    const closedSchools = closedSchoolsOf(payload.rastra_closed_schools);

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
    //
    // A login with rows at several schools reads only the chosen one: RLS
    // shows a person their own row at the chosen school and no other, so the
    // filter on authId finds that row or none.
    const profile = await this.prisma.withVerifiedSubject(
      payload.sub,
      (db) =>
        db.user.findFirst({
          where: { authId: payload.sub },
          select: { id: true, schoolId: true, role: true, isActive: true, adminProfile: true, hrRead: true },
        }),
      { ...(school ? { school } : {}), ...(closedSchools ? { closedSchools } : {}) },
    );

    if (profile && profile.isActive) {
      // Which school account this session signed in with, if it did: only
      // for "would this lock me out?" (SignInMethodsService), never a grant.
      const schoolAccount = schoolAccountOf(payload);
      return {
        authId: payload.sub,
        role: profile.role as Role,
        userId: profile.id,
        schoolId: profile.schoolId,
        // Set exactly on an administrator (CHECK Users_a_profile_is_an_administrators).
        ...(profile.adminProfile ? { adminProfile: profile.adminProfile, hrRead: profile.hrRead } : {}),
        ...(schoolAccount ? { schoolAccount } : {}),
        ...(closedSchools ? { closedSchools } : {}),
      };
    }

    // A school was named and gave no row: the login has a row somewhere,
    // just not one this request may use there. Asked only on this rare path,
    // so a session's ordinary request stays one lookup.
    if (school) {
      const elsewhere = await this.prisma.withVerifiedSubject(
        payload.sub,
        (db) => db.user.findFirst({ where: { authId: payload.sub }, select: { id: true } }),
        closedSchools ? { closedSchools } : {},
      );
      if (elsewhere) {
        throw schoolNotAvailable();
      }
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
