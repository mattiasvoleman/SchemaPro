import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  MinLength,
  IsString,
  IsUrl,
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

  // NOTE: numeric fields need explicit `: number` annotations — TypeScript
  // only emits accurate design:type metadata for declared types, and
  // class-transformer's implicit conversion relies on it.
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number = 3000;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  /**
   * Symmetric key for first-party service tokens (see src/auth). Supabase user
   * tokens are ES256 and verified against the JWKS endpoint instead, so this
   * signs nothing the API issues — it only verifies tokens minted out-of-band,
   * such as the benchmark harness in scripts/bench.
   */
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  /**
   * Required: the API derives the JWKS URI from it, so an unset value would
   * mean every Supabase-issued access token fails verification at runtime.
   * Must be `<SUPABASE_URL>/auth/v1`.
   */
  @IsString()
  @IsNotEmpty()
  JWT_ISSUER!: string;

  @IsOptional()
  @IsString()
  JWT_AUDIENCE?: string;

  /*
   * A URL, not merely a non-empty string.
   *
   * `@IsNotEmpty` alone let the literal "undefined" through — which is what an
   * environment variable interpolated from a value that was never set looks
   * like — and the app booted happily. The failure surfaced on the first
   * attempt to generate a schedule, as "AI engine unavailable": axios refuses
   * to parse "undefined/v1/schedule" and throws a TypeError, which is neither a
   * timeout nor an AxiosError and so falls through to the proxy's most generic
   * message. Nothing in it says the URL is the problem, and the obvious next
   * move — is the engine up? — finds an engine that is perfectly healthy.
   *
   * Boot is the right place to notice. A misconfigured deployment should refuse
   * to start rather than run until somebody presses the button that needs it.
   *
   * `require_tld: false` because the engine answers at `localhost` in
   * development and at a bare service name (`http://solver:8000`) inside
   * compose; neither has a dot in it and both are correct.
   *
   * `require_protocol: true` is the half that does the work. Without it
   * validator.js accepts a bare hostname, so "undefined" and "localhost:8000"
   * both passed — and "undefined" is the exact value this rule exists to catch.
   * Found by the test, not by reading the option list.
   */
  @IsString()
  @IsNotEmpty()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  AI_ENGINE_URL!: string;

  @IsString()
  @IsNotEmpty()
  AI_ENGINE_API_KEY!: string;

  @IsInt()
  @Min(1000)
  AI_ENGINE_TIMEOUT_MS: number = 15000;

  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS: number = 60;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 120;

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

  /**
   * The public viewer (src/publication/public-timetable.controller.ts): the
   * secret the web server sends with the viewer's own client address
   * (X-Viewer-Proxy-Key beside X-Viewer-Client-Ip), so each family reading a
   * timetable through the web is rate-limited on its own address rather than
   * all of them on the web server's. Unset, the header is ignored and the
   * limit is per caller address. At least 32 characters when set.
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  PUBLIC_VIEWER_PROXY_KEY?: string;
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
