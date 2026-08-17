import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtSecretRequestType } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../config/configuration';
import { JwtStrategy } from './jwt.strategy';
import {
  ACCEPTED_ALGORITHMS,
  createSigningKeyProvider,
} from './signing-key.provider';

/**
 * Provides JWT verification infrastructure (strategy + module) to the rest
 * of the application. Guards and decorators are exported for direct use.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwt = configService.getOrThrow<JwtConfig>('jwt');
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
      },
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
