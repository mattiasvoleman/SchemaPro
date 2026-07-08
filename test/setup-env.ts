// Runs before any module is imported (jest `setupFiles`), because
// `ConfigModule.forRoot` validates the environment at import time.
// Values are obviously fake — the Prisma layer and AI engine are mocked.
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '4000';
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] = 'test-secret-not-used-by-the-fake-guard';
process.env['AI_ENGINE_URL'] = 'http://localhost:65535';
process.env['AI_ENGINE_API_KEY'] = 'test-key';
process.env['AI_ENGINE_TIMEOUT_MS'] = '15000';
process.env['THROTTLE_TTL_SECONDS'] = '60';
process.env['THROTTLE_LIMIT'] = '1000';
