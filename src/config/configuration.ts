import { EnvironmentVariables, NodeEnv } from './env.validation';

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
  issuer?: string;
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

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  aiEngine: AiEngineConfig;
  throttle: ThrottleConfig;
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
  };
}
