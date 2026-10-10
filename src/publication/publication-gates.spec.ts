import {
  DEFAULT_GATE_POLICY,
  GATE_CODES,
  GATE_COLUMN,
  GATE_POLICY_KEYS,
  MAX_GATE_ENTRIES,
  gateVerdict,
  refusesAnything,
  settleGates,
} from './publication-gates';

describe('Får publiceras: the gates, settled by the school policy', () => {
  it('warns on everything by default, so nothing that works today is refused', () => {
    expect(GATE_POLICY_KEYS.every((key) => DEFAULT_GATE_POLICY[key] === 'WARN')).toBe(true);
    expect(refusesAnything(DEFAULT_GATE_POLICY)).toBe(false);
    const items = settleGates(
      GATE_CODES.filter((code) => code !== 'PUB_CALENDAR_REFUSED').map((code) => ({ code, count: 1 })),
      DEFAULT_GATE_POLICY,
    );
    expect(gateVerdict(items).refused).toBe(false);
    expect(gateVerdict(items).needsAcknowledgement).toBe(true);
  });

  it('maps every policy column to exactly one check', () => {
    const columns = Object.values(GATE_COLUMN).filter((column) => column !== null);
    expect([...columns].sort()).toEqual([...GATE_POLICY_KEYS].sort());
  });

  it('refuses what the school set to REFUSE, and only that', () => {
    const items = settleGates(
      [
        { code: 'PUB_NO_ROOM', count: 2 },
        { code: 'PUB_CLASHES', count: 1 },
      ],
      { ...DEFAULT_GATE_POLICY, gateMissingRoom: 'REFUSE' },
    );
    expect(items.map((item) => [item.code, item.severity])).toEqual([
      ['PUB_NO_ROOM', 'REFUSE'],
      ['PUB_CLASHES', 'WARN'],
    ]);
    expect(gateVerdict(items)).toEqual({ refused: true, needsAcknowledgement: true });
  });

  it('always refuses a dry run the database refused, whatever the policy', () => {
    const items = settleGates([{ code: 'PUB_CALENDAR_REFUSED', count: 1 }], DEFAULT_GATE_POLICY);
    expect(items[0].severity).toBe('REFUSE');
  });

  it('shows information without asking for "Publicera ändå"', () => {
    const items = settleGates(
      [
        { code: 'PUB_NOTHING_TO_PUBLISH', count: 1, info: true },
        { code: 'PUB_RANGE_OVERLAP', count: 1, info: true },
      ],
      { ...DEFAULT_GATE_POLICY, gateOverlap: 'REFUSE' },
    );
    expect(items.every((item) => item.severity === 'INFO')).toBe(true);
    expect(gateVerdict(items)).toEqual({ refused: false, needsAcknowledgement: false });
  });

  it('drops a check that found nothing and caps the entries, keeping the count', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({ label: `rad ${index}` }));
    const items = settleGates(
      [
        { code: 'PUB_PARKED', count: 0 },
        { code: 'PUB_NO_TEACHER', count: 30, entries },
      ],
      DEFAULT_GATE_POLICY,
    );
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(30);
    expect(items[0].items).toHaveLength(MAX_GATE_ENTRIES);
  });
});
