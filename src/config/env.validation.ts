import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Strongly-typed schema for every environment variable the API depends on.
 * Validation runs once at bootstrap; the process refuses to start if a
 * required secret/URL is missing or malformed (fail fast, never hardcode).
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(0)
  @Max(65535)
  PORT = 3000;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ISSUER?: string;

  @IsOptional()
  @IsString()
  JWT_AUDIENCE?: string;

  @IsString()
  @IsNotEmpty()
  AI_ENGINE_URL!: string;

  @IsString()
  @IsNotEmpty()
  AI_ENGINE_API_KEY!: string;

  @IsInt()
  @Min(1000)
  AI_ENGINE_TIMEOUT_MS = 15000;

  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS = 60;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 120;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  /**
   * Supabase Auth admin access — required only for the user-invite flow
   * (`POST /api/v1/users`). All other endpoints work without it.
   */
  @IsOptional()
  @IsString()
  SUPABASE_URL?: string;

  @IsOptional()
  @IsString()
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    // Surface only the offending variable names — never echo secret values.
    const offending = errors.map((error) => error.property).join(', ');
    throw new Error(
      `Invalid or missing environment variables: ${offending}. ` +
        'See .env.example for the required configuration.',
    );
  }

  return validated;
}
