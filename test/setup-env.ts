// Runs before any module is imported (jest `setupFiles`), because
// `ConfigModule.forRoot` validates the environment at import time.
// Values are obviously fake — the Prisma layer and AI engine are mocked.
/*
 * Pinned, because a test about a school's timezone is only a test where the
 * SERVER's differs from it.
 *
 * Nothing set TZ, so the suite ran in whatever the machine happened to be. On a
 * developer's Mac in Europe/Stockholm the date assertions bit; on a CI runner,
 * which is UTC, several of them compared a value to itself and passed whatever
 * the code did — including the ones written to catch a purge that trims "today"
 * in UTC instead of in the school's day. Vitest already pins UTC on the web
 * side (vitest.config.ts) for the same reason.
 *
 * UTC and not Europe/Stockholm: the school fixtures ARE Europe/Stockholm, so a
 * server that agrees with them proves nothing.
 *
 * SET IN THE npm SCRIPT, NOT HERE. Assigning process.env.TZ in `setupFiles`
 * looks like it works and does not: Node resolves the zone on first use and
 * jest's own bootstrap has already touched Date by the time this file runs, so
 * `process.env.TZ` read back as 'UTC' while Intl still answered
 * Europe/Stockholm. Measured, after pinning it here and believing the green
 * suite. The scripts in package.json carry `TZ=UTC` in front of `jest`, which
 * is before the process exists at all.
 */
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '4000';
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] = 'test-secret-not-used-by-the-fake-guard';
process.env['JWT_ISSUER'] = 'https://test.invalid/auth/v1';
process.env['AI_ENGINE_URL'] = 'http://localhost:65535';
process.env['AI_ENGINE_API_KEY'] = 'test-key';
process.env['AI_ENGINE_TIMEOUT_MS'] = '15000';
process.env['THROTTLE_TTL_SECONDS'] = '60';
process.env['THROTTLE_LIMIT'] = '1000';
