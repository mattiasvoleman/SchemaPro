import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptions } from 'passport-jwt';
import type { JwtConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { isRole, Role } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

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

    const options: StrategyOptions = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwt.secret,
      ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience ? { audience: jwt.audience } : {}),
    };

    super(options);
  }

  /**
   * Runs after the signature/issuer/audience/expiry have been verified.
   * Returns the principal that Passport attaches to `request.user`.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid authentication token.');
    }

    // First-party tokens carry the application role directly.
    if (isRole(payload.role)) {
      return {
        authId: payload.sub,
        role: payload.role,
        userId: payload.userId,
        schoolId: payload.schoolId,
      };
    }

    // Supabase tokens: resolve the profile from the Users table. This is an
    // identity lookup by the verified subject claim, so it intentionally runs
    // outside RLS (there is no session to scope by yet).
    const profile = await this.prisma.withSystemTransaction((tx) =>
      tx.user.findUnique({
        where: { authId: payload.sub },
        select: { id: true, schoolId: true, role: true, isActive: true },
      }),
    );

    if (!profile || !profile.isActive) {
      throw new UnauthorizedException(
        'No active user profile is linked to this account.',
      );
    }

    return {
      authId: payload.sub,
      role: profile.role as Role,
      userId: profile.id,
      schoolId: profile.schoolId,
    };
  }
}
