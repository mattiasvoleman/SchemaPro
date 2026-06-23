import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfiguration } from './configuration';
import { validateEnv } from './env.validation';

/**
 * Global configuration. Validates the environment once at startup and exposes
 * a nested, typed config tree (`app`, `database`, `jwt`, `aiEngine`,
 * `throttle`) through the standard NestJS `ConfigService`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnv,
      load: [() => loadConfiguration(validateEnv(process.env))],
    }),
  ],
})
export class AppConfigModule {}
