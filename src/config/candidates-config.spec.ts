// class-validator's decorators are read as metadata; Nest's bootstrap normally loads the polyfill.
import 'reflect-metadata';
import { DEFAULT_CANDIDATES_CONFIG, loadConfiguration } from './configuration';
import { validateEnv, type EnvironmentVariables } from './env.validation';

/*
 * Schemaförslag's four variables (src/optimization/schedule-candidates.service.ts):
 * the candidate budget, the cap on runs across schools, the solver's workers
 * per candidate, and the sweep's switch. Bounded at boot, as the engine's own
 * bounds are, so a deployment cannot ask the engine for a budget it refuses
 * (422 for the whole run) or for more parallel runs than the engine has
 * cores for.
 */

const valid = () => ({
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a-secret-long-enough-to-be-plausible-0000',
  JWT_ISSUER: 'https://example.invalid/auth/v1',
  AI_ENGINE_URL: 'http://localhost:8000',
  AI_ENGINE_API_KEY: 'a-key-long-enough-to-be-plausible-000000',
});

describe('the schemaförslag environment', () => {
  it('defaults to 30 s a candidate, two runs at once, four workers and the sweep on', () => {
    const env = validateEnv(valid());
    expect([env.CANDIDATE_MAX_SECONDS, env.CANDIDATE_RUNS_MAX, env.CANDIDATE_SOLVER_WORKERS, env.CANDIDATES_BACKGROUND]).toEqual([
      30,
      2,
      4,
      'on',
    ]);
    expect(loadConfiguration(env).candidates).toEqual({ maxSeconds: 30, runsMax: 2, solverWorkers: 4, background: true });
  });

  it.each([
    ['the smallest budget', { CANDIDATE_MAX_SECONDS: '5' }],
    ['the largest budget', { CANDIDATE_MAX_SECONDS: '120' }],
    ['one run at a time', { CANDIDATE_RUNS_MAX: '1' }],
    ['ten runs', { CANDIDATE_RUNS_MAX: '10' }],
    ['one worker', { CANDIDATE_SOLVER_WORKERS: '1' }],
    ['sixteen workers', { CANDIDATE_SOLVER_WORKERS: '16' }],
    ['the sweep off', { CANDIDATES_BACKGROUND: 'off' }],
  ])('accepts %s', (_label, extra) => {
    expect(() => validateEnv({ ...valid(), ...extra })).not.toThrow();
  });

  it.each([
    ['a budget under the engine\'s 5 s', { CANDIDATE_MAX_SECONDS: '4' }, /CANDIDATE_MAX_SECONDS/],
    ['a budget over two minutes', { CANDIDATE_MAX_SECONDS: '121' }, /CANDIDATE_MAX_SECONDS/],
    ['a fractional budget', { CANDIDATE_MAX_SECONDS: '30.5' }, /CANDIDATE_MAX_SECONDS/],
    ['no runs at all', { CANDIDATE_RUNS_MAX: '0' }, /CANDIDATE_RUNS_MAX/],
    ['eleven runs', { CANDIDATE_RUNS_MAX: '11' }, /CANDIDATE_RUNS_MAX/],
    ['no workers', { CANDIDATE_SOLVER_WORKERS: '0' }, /CANDIDATE_SOLVER_WORKERS/],
    ['seventeen workers', { CANDIDATE_SOLVER_WORKERS: '17' }, /CANDIDATE_SOLVER_WORKERS/],
    ['a sweep mode it does not know', { CANDIDATES_BACKGROUND: 'yes' }, /CANDIDATES_BACKGROUND/],
  ])('refuses %s, naming it', (_label, extra, name) => {
    expect(() => validateEnv({ ...valid(), ...extra })).toThrow(name);
  });

  it('puts the values where the candidate service reads them, and turns the sweep off only for off', () => {
    const config = loadConfiguration(
      validateEnv({
        ...valid(),
        CANDIDATE_MAX_SECONDS: '45',
        CANDIDATE_RUNS_MAX: '3',
        CANDIDATE_SOLVER_WORKERS: '8',
        CANDIDATES_BACKGROUND: 'off',
      }),
    );
    expect(config.candidates).toEqual({ maxSeconds: 45, runsMax: 3, solverWorkers: 8, background: false });
  });

  it('falls back to the defaults for an environment handed over without them', () => {
    // As configuration.spec.ts hands one over: validated elsewhere, the
    // optional names simply absent.
    const env: Partial<EnvironmentVariables> = { ...validateEnv(valid()) };
    delete env.CANDIDATE_MAX_SECONDS;
    delete env.CANDIDATE_RUNS_MAX;
    delete env.CANDIDATE_SOLVER_WORKERS;
    delete env.CANDIDATES_BACKGROUND;
    expect(loadConfiguration(env as EnvironmentVariables).candidates).toEqual(DEFAULT_CANDIDATES_CONFIG);
  });
});
