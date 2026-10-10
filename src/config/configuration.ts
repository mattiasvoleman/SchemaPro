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

export const DEFAULT_EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push';

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  aiEngine: AiEngineConfig;
  throttle: ThrottleConfig;
  supabase: SupabaseAdminConfig;
  publicViewer: PublicViewerConfig;
  push: PushConfig;
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
    push: {
      enabled: env.PUSH_NOTIFICATIONS === PushMode.Expo,
      accessToken: env.EXPO_ACCESS_TOKEN && env.EXPO_ACCESS_TOKEN.length > 0 ? env.EXPO_ACCESS_TOKEN : undefined,
      apiUrl: (env.EXPO_PUSH_API_URL && env.EXPO_PUSH_API_URL.length > 0 ? env.EXPO_PUSH_API_URL : DEFAULT_EXPO_PUSH_API_URL).replace(/\/+$/, ''),
    },
  };
}
