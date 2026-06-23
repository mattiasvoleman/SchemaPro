import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { JwtConfig } from '../config/configuration';
import { JwtStrategy } from './jwt.strategy';

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
        return {
          secret: jwt.secret,
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
