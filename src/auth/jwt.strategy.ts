import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, StrategyOptions } from 'passport-jwt';
import type { JwtConfig } from '../config/configuration';
import { isRole } from './enums/role.enum';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
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
  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload.sub || !isRole(payload.role)) {
      throw new UnauthorizedException('Invalid authentication token.');
    }

    return {
      authId: payload.sub,
      role: payload.role,
      userId: payload.userId,
      schoolId: payload.schoolId,
    };
  }
}
