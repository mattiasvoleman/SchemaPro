import {
  abandonedAt,
  generateAlreadyRunning,
  GENERATE_ALREADY_RUNNING,
  INSTANCE_NAME,
  LEASE_MARGIN_SECONDS,
  LEASE_MAX_SECONDS,
  LEASE_MIN_SECONDS,
  RUN_MAX_AGE_MS,
  leaseSecondsFor,
} from './generate-runs';

const NOW = new Date('2027-02-22T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60 * 1000;

describe('leaseSecondsFor', () => {
  it('is the API’s wait for the engine plus thirty seconds of its own steps', () => {
    // 240 s is what DEPLOYMENT.md asks of AI_ENGINE_TIMEOUT_MS at a 180 s budget and a 20 s probe, whose engine
    // ceiling is 230 s: the lease is never shorter than the longest the engine can still be solving.
    expect(leaseSecondsFor(240)).toBe(240 + LEASE_MARGIN_SECONDS);
    expect(LEASE_MARGIN_SECONDS).toBe(30);
    expect(leaseSecondsFor(240)).toBeGreaterThan(230);
  });

  it('rounds a fractional wait up, never down', () => {
    expect(leaseSecondsFor(90.2)).toBe(91 + LEASE_MARGIN_SECONDS);
  });

  it('stays inside what the database allows (the lease is at most an hour past the heartbeat)', () => {
    expect(leaseSecondsFor(1)).toBe(LEASE_MIN_SECONDS);
    expect(leaseSecondsFor(0)).toBe(LEASE_MIN_SECONDS);
    expect(leaseSecondsFor(-50)).toBe(LEASE_MIN_SECONDS);
    expect(leaseSecondsFor(100_000)).toBe(LEASE_MAX_SECONDS);
    expect(LEASE_MAX_SECONDS).toBe(3600);
  });

  it.each([[undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'falls back to the default deployment’s when the wait is not a number (%s)',
    (wait) => {
      expect(leaseSecondsFor(wait as number | undefined)).toBe(270);
    },
  );
});

describe('abandonedAt', () => {
  const run = (over: Partial<{ status: string; leaseUntil: Date | null; createdAt: Date }> = {}) => ({
    status: 'RUNNING',
    leaseUntil: ago(-MINUTE),
    createdAt: ago(2 * MINUTE),
    ...over,
  });

  it('is when the lease ran out, for an active run whose lease has', () => {
    const leaseEnded = ago(90 * 1000);
    expect(abandonedAt(run({ leaseUntil: leaseEnded }), NOW)).toEqual(leaseEnded);
    expect(abandonedAt(run({ status: 'PENDING', leaseUntil: leaseEnded }), NOW)).toEqual(leaseEnded);
  });

  it('is null while the lease holds, to the millisecond', () => {
    expect(abandonedAt(run({ leaseUntil: ago(-1) }), NOW)).toBeNull();
    expect(abandonedAt(run({ leaseUntil: NOW }), NOW)).toBeNull();
    expect(abandonedAt(run({ leaseUntil: ago(1) }), NOW)).toEqual(ago(1));
  });

  it('is null for a run that is not active, whatever its lease', () => {
    expect(abandonedAt(run({ status: 'SUCCEEDED', leaseUntil: ago(MINUTE) }), NOW)).toBeNull();
    expect(abandonedAt(run({ status: 'FAILED', leaseUntil: ago(MINUTE) }), NOW)).toBeNull();
  });

  it('is null for a row that carries no lease: one read from before the column', () => {
    expect(abandonedAt(run({ leaseUntil: null }), NOW)).toBeNull();
    expect(abandonedAt({ status: 'RUNNING', createdAt: ago(5 * 60 * MINUTE) }, NOW)).toBeNull();
  });

  it('is now, never a lease that has not come, for a run past the half hour with a lease that holds', () => {
    expect(RUN_MAX_AGE_MS).toBe(30 * MINUTE);
    expect(abandonedAt(run({ createdAt: ago(30 * MINUTE + 1), leaseUntil: ago(-MINUTE) }), NOW)).toEqual(NOW);
    expect(abandonedAt(run({ createdAt: ago(30 * MINUTE), leaseUntil: ago(-MINUTE) }), NOW)).toBeNull();
  });

  it('is the earlier of the two when both limits are passed', () => {
    const leaseEnded = ago(5 * MINUTE);
    expect(abandonedAt(run({ createdAt: ago(40 * MINUTE), leaseUntil: leaseEnded }), NOW)).toEqual(leaseEnded);
  });
});

describe('the refusal of a second start', () => {
  it('is a 409 with its own name, which is not SCHEDULE_BUSY and not a schemaförslag’s', () => {
    const refusal = generateAlreadyRunning();
    expect(refusal.getStatus()).toBe(409);
    expect(refusal.getResponse()).toEqual({
      message: 'Generera kör redan för läsåret. Vänta tills körningen är klar.',
      code: GENERATE_ALREADY_RUNNING,
    });
    expect(GENERATE_ALREADY_RUNNING).toBe('GENERATE_ALREADY_RUNNING');
  });
});

describe('INSTANCE_NAME', () => {
  it('names the process and fits the column’s check', () => {
    expect(INSTANCE_NAME.length).toBeGreaterThan(0);
    expect(INSTANCE_NAME.length).toBeLessThanOrEqual(100);
    expect(INSTANCE_NAME).toContain(`:${process.pid}:`);
  });
});
