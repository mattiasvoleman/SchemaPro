import { EnvironmentVariables, NodeEnv, PushMode } from './env.validation';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  corsOrigins: string[];
}

export interface DatabaseConfig {
  url: string;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  jwksUri: string;
  audience?: string;
}

export interface AiEngineConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface ThrottleConfig {
  ttlSeconds: number;
  limit: number;
  redisUrl?: string;
}

export interface SupabaseAdminConfig {
  url?: string;
  serviceRoleKey?: string;
}

/** "Logga in med skolkonto": SCHOOL_ACCOUNTS=on. Off, no school-account row can be saved. */
export interface SignInConfig {
  schoolAccounts: boolean;
}

export interface PublicViewerConfig {
  /** Undefined: X-Viewer-Client-Ip is never trusted. */
  proxyKey?: string;
}

export interface PushConfig {
  /** PUSH_NOTIFICATIONS=expo. False: nothing about push leaves the process. */
  enabled: boolean;
  /** Bearer for Expo's enhanced push security; undefined sends none. */
  accessToken?: string;
  /** Without a trailing slash: `${apiUrl}/send`, `${apiUrl}/getReceipts`. */
  apiUrl: string;
}

export interface Ss12000Config {
  /** INTEGRATION_SECRETS_KEY, decoded; undefined: credentials cannot be saved. */
  secretsKey?: Buffer;
  secretsKeyPrevious?: Buffer;
  /** The background tick (SS12000_BACKGROUND, default on). */
  background: boolean;
  /** Loopback allowed for the client: SS12000_ALLOW_INSECURE_LOCAL=1 under NODE_ENV=test only. */
  allowInsecureLocal: boolean;
}

export interface GallringConfig {
  /** The nightly gallring tick (GALLRING_BACKGROUND, default on). */
  background: boolean;
}

/** Schemaförslag (src/optimization/schedule-candidates.service.ts). */
export interface CandidatesConfig {
  /** CANDIDATE_MAX_SECONDS: the solve budget of every candidate, KEEP's included, 5..120 (30). */
  maxSeconds: number;
  /** CANDIDATE_RUNS_MAX: active runs across schools, 1..10 (2). */
  runsMax: number;
  /** CANDIDATE_SOLVER_WORKERS: CP-SAT workers per candidate solve, 1..16 (4). */
  solverWorkers: number;
  /** The quarter-hourly sweep (CANDIDATES_BACKGROUND, default on). */
  background: boolean;
}

/** The defaults env.validation states, for a caller handed an environment without them. */
export const DEFAULT_CANDIDATES_CONFIG: Readonly<CandidatesConfig> = {
  maxSeconds: 30,
  runsMax: 2,
  solverWorkers: 4,
  background: true,
};

export const DEFAULT_EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push';

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  aiEngine: AiEngineConfig;
  throttle: ThrottleConfig;
  supabase: SupabaseAdminConfig;
  publicViewer: PublicViewerConfig;
  signIn: SignInConfig;
  push: PushConfig;
  ss12000: Ss12000Config;
  gallring: GallringConfig;
  candidates: CandidatesConfig;
}

/**
 * Maps the validated environment into a nested, strongly-typed config tree.
 * Consumers read these via `ConfigService.get<...>('app' | 'jwt' | ...)`,
 * so no part of the app ever touches `process.env` directly.
 */
export function loadConfiguration(env: EnvironmentVariables): Configuration {
  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      corsOrigins: (env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    database: {
      url: env.DATABASE_URL,
    },
    jwt: {
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      // Supabase publishes its rotating ES256 signing keys under the issuer,
      // which is why JWT_ISSUER is required rather than optional.
      jwksUri: `${env.JWT_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`,
      audience: env.JWT_AUDIENCE,
    },
    aiEngine: {
      baseUrl: env.AI_ENGINE_URL,
      apiKey: env.AI_ENGINE_API_KEY,
      timeoutMs: env.AI_ENGINE_TIMEOUT_MS,
    },
    throttle: {
      ttlSeconds: env.THROTTLE_TTL_SECONDS,
      limit: env.THROTTLE_LIMIT,
      redisUrl: env.REDIS_URL && env.REDIS_URL.length > 0 ? env.REDIS_URL : undefined,
    },
    supabase: {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    },
    publicViewer: {
      proxyKey: env.PUBLIC_VIEWER_PROXY_KEY && env.PUBLIC_VIEWER_PROXY_KEY.length > 0 ? env.PUBLIC_VIEWER_PROXY_KEY : undefined,
    },
    signIn: {
      schoolAccounts: env.SCHOOL_ACCOUNTS === 'on',
    },
    push: {
      enabled: env.PUSH_NOTIFICATIONS === PushMode.Expo,
      accessToken: env.EXPO_ACCESS_TOKEN && env.EXPO_ACCESS_TOKEN.length > 0 ? env.EXPO_ACCESS_TOKEN : undefined,
      apiUrl: (env.EXPO_PUSH_API_URL && env.EXPO_PUSH_API_URL.length > 0 ? env.EXPO_PUSH_API_URL : DEFAULT_EXPO_PUSH_API_URL).replace(/\/+$/, ''),
    },
    ss12000: {
      secretsKey: env.INTEGRATION_SECRETS_KEY ? Buffer.from(env.INTEGRATION_SECRETS_KEY, 'base64') : undefined,
      secretsKeyPrevious: env.INTEGRATION_SECRETS_KEY_PREVIOUS ? Buffer.from(env.INTEGRATION_SECRETS_KEY_PREVIOUS, 'base64') : undefined,
      background: env.SS12000_BACKGROUND !== 'off',
      allowInsecureLocal: env.SS12000_ALLOW_INSECURE_LOCAL === '1' && env.NODE_ENV === NodeEnv.Test,
    },
    gallring: {
      background: env.GALLRING_BACKGROUND !== 'off',
    },
    candidates: {
      maxSeconds: env.CANDIDATE_MAX_SECONDS ?? DEFAULT_CANDIDATES_CONFIG.maxSeconds,
      runsMax: env.CANDIDATE_RUNS_MAX ?? DEFAULT_CANDIDATES_CONFIG.runsMax,
      solverWorkers: env.CANDIDATE_SOLVER_WORKERS ?? DEFAULT_CANDIDATES_CONFIG.solverWorkers,
      background: env.CANDIDATES_BACKGROUND !== 'off',
    },
  };
}
