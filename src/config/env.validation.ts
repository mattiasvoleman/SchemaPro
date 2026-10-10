import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  Matches,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  MinLength,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

/** Unset, or set to nothing (`X=""` in an env file): both mean "not configured". */
const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '';

export enum PushMode {
  Off = 'off',
  Expo = 'expo',
}

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

  /**
   * Push to the mobile app through Expo's push service (src/notifications).
   * `off` — the default, and what an unset variable means — makes push inert:
   * GET /push/config answers {enabled:false}, registration is refused (409
   * PUSH_DISABLED), no Expo request is made, no ticket stored, no receipt
   * checked. `expo` turns it on; see docs/DEPLOYMENT.md for what must exist
   * first (a data processing agreement, EAS credentials, a native build).
   */
  @IsEnum(PushMode)
  PUSH_NOTIFICATIONS: PushMode = PushMode.Off;

  /**
   * Sent as a Bearer token only when set: Expo requires it once "enhanced
   * push security" is enabled for the EAS project, and not otherwise. Empty
   * is unset.
   */
  @ValidateIf((env: EnvironmentVariables) => !isBlank(env.EXPO_ACCESS_TOKEN))
  @IsString()
  @MinLength(20)
  EXPO_ACCESS_TOKEN?: string;

  /**
   * Expo's push API base (…/push/send and …/push/getReceipts beneath it).
   * HTTPS only: a token and every recipient's device token travel in it.
   * Empty, like unset (`EXPO_PUSH_API_URL=""` in .env.example), means Expo's own.
   */
  @ValidateIf((env: EnvironmentVariables) => !isBlank(env.EXPO_PUSH_API_URL))
  @IsUrl({ require_tld: true, require_protocol: true, protocols: ['https'] })
  EXPO_PUSH_API_URL?: string;

  /**
   * The key the SS12000 source's credentials are sealed with (AES-256-GCM,
   * src/integration/ss12000-sync/secret-box.ts): base64 of exactly 32 bytes,
   * `openssl rand -base64 32`. Unset: no credential can be saved (503
   * SS12000_SECRETS_NOT_CONFIGURED) and nothing is ever stored in plaintext.
   * Never in the database, never in a log.
   */
  @ValidateIf((env: EnvironmentVariables) => !isBlank(env.INTEGRATION_SECRETS_KEY))
  @Matches(/^[A-Za-z0-9+/]{43}=$/)
  INTEGRATION_SECRETS_KEY?: string;

  /** The key before the last rotation: still decrypts, never encrypts. Same shape. */
  @ValidateIf((env: EnvironmentVariables) => !isBlank(env.INTEGRATION_SECRETS_KEY_PREVIOUS))
  @Matches(/^[A-Za-z0-9+/]{43}=$/)
  INTEGRATION_SECRETS_KEY_PREVIOUS?: string;

  /**
   * The SS12000 sync's background tick (nightly runs, housekeeping). `on`
   * unless set to `off`; the test setup turns it off, and a scheduled run
   * still happens only for a source whose admin enabled the schedule.
   */
  @IsIn(['on', 'off'])
  SS12000_BACKGROUND: string = 'on';

  /**
   * Lets the SS12000 client connect to a loopback address (the tests' TLS
   * mock provider). Refused unless NODE_ENV=test; https is never relaxed.
   */
  @ValidateIf((env: EnvironmentVariables) => !isBlank(env.SS12000_ALLOW_INSECURE_LOCAL))
  @IsIn(['0', '1'])
  SS12000_ALLOW_INSECURE_LOCAL?: string;
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

  const offendingNames = errors.map((error) => error.property);
  // The loopback escape hatch exists for the test suite alone.
  if (validated.SS12000_ALLOW_INSECURE_LOCAL === '1' && validated.NODE_ENV !== NodeEnv.Test) {
    offendingNames.push('SS12000_ALLOW_INSECURE_LOCAL');
  }

  if (offendingNames.length > 0) {
    // Surface only the offending variable names — never echo secret values.
    const offending = offendingNames.join(', ');
    throw new Error(
      `Invalid or missing environment variables: ${offending}. ` +
        'See .env.example for the required configuration.',
    );
  }

  return validated;
}
