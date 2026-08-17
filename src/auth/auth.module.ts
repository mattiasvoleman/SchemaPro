import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtSecretRequestType } from '@nestjs/jwt';
import type { JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../config/configuration';
import { JwtStrategy } from './jwt.strategy';
import {
  ACCEPTED_ALGORITHMS,
  createSigningKeyProvider,
} from './signing-key.provider';

/**
 * Builds the JwtModule options from resolved config.
 *
 * Extracted from the decorator so the security-relevant choices here —
 * algorithm pinning, the VERIFY-vs-sign key split, and the optional issuer /
 * audience claims — are reachable by unit tests. A factory inlined in a
 * `@Module` decorator can only be exercised by booting the DI container,
 * which is exactly why this logic went untested when it was written.
 */
export function buildJwtModuleOptions(jwt: JwtConfig): JwtModuleOptions {
  const signingKey = createSigningKeyProvider(jwt);
  return {
    // RealtimeGateway verifies the same Supabase tokens as the HTTP
    // strategy, so it needs the same JWKS lookup and the same pinning.
    secretOrKeyProvider: (requestType, tokenOrPayload) =>
      requestType === JwtSecretRequestType.VERIFY
        ? signingKey(tokenOrPayload as string)
        : jwt.secret,
    verifyOptions: {
      algorithms: [...ACCEPTED_ALGORITHMS],
      ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience ? { audience: jwt.audience } : {}),
    },
    signOptions: {
      ...(jwt.issuer ? { issuer: jwt.issuer } : {}),
      ...(jwt.audience ? { audience: jwt.audience } : {}),
    },
  };
}

/**
 * Provides JWT verification infrastructure (strategy + module) to the rest
 * of the application. Guards and decorators are exported for direct use.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildJwtModuleOptions(configService.getOrThrow<JwtConfig>('jwt')),
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
