import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { TEACHER_WORK_DAYS_HIDDEN, WORK_DAYS_HIDDEN_MESSAGE } from '../optimization/work-days';
import { deviationLabel, deviationsFinding } from './deviation-finding';
import { DEFAULT_GATE_POLICY, GATE_COLUMN, settleGates } from './publication-gates';

/**
 * PUB_DEVIATIONS (Bästa möjliga schema): a timetable applied from a candidate
 * whose rules gave way, accepted by an administrator, and not yet published.
 * The finding reads the year's newest REGENERATE-or-RESTORE entry of the
 * change log and the publications since; the policy is gateDeviations.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';
const APPLIED = new Date('2027-02-01T10:00:00.000Z');
const DIGEST = 'f'.repeat(64);

const entry = (code: string, params: Record<string, string | number>, extra: Record<string, unknown> = {}) => ({
  category: 'DEVIATION' as const,
  code,
  params,
  message: 'The engine’s English.',
  resourceNames: [],
  ...extra,
});

const ENTRIES = [
  entry('DEVIATION_SUBJECT_PER_DAY', { requirement: 'Matematik för 7B', day: 2, maxPerDay: 1, count: 2, over: 1, needed: 2 }),
  entry('DEVIATION_TEACHER_DAILY_CAP', { rule: 'rule-id', day: 3, minutes: 360, taught: 400, over: 40, needed: 400 }),
  entry('DEVIATION_ROOM_LOCK', { requirement: 'Idrott för 8A', lessons: 2, of: 3 }),
  entry('DEVIATION_SUBJECT_DAYS_APART', { requirement: 'Svenska för 9A', minDaysBetween: 2, pairs: 1, closest: 1, needed: 1 }),
  entry(TEACHER_WORK_DAYS_HIDDEN, {}, { message: WORK_DAYS_HIDDEN_MESSAGE }),
];

const logRow = (overrides: Record<string, unknown> = {}) => ({
  action: 'REGENERATE',
  createdAt: APPLIED,
  after: { source: 'CANDIDATE', runId: 'run', ordinal: 1, variant: 'BEST_EFFORT', deviations: ENTRIES, deviationsDigest: DIGEST, acceptedAt: APPLIED.toISOString() },
  ...overrides,
});

describe('deviationsFinding', () => {
  const arrange = (last: unknown, followed: unknown = null) => {
    const tx = createTxMock();
    tx.scheduleChangeLog.findFirst.mockResolvedValue(last);
    tx.timetablePublication.findFirst.mockResolvedValue(followed);
    return tx;
  };
  const find = (tx: ReturnType<typeof createTxMock>) => deviationsFinding(tx as unknown as PrismaClient, YEAR);
  const none = { code: 'PUB_DEVIATIONS', count: 0 };

  it('lists what the administrator accepted at the apply, in the gate’s Swedish, and when it was applied', async () => {
    const tx = arrange(logRow());

    const finding = await find(tx);

    expect(finding).toEqual({
      code: 'PUB_DEVIATIONS',
      count: 5,
      entries: [
        { label: 'Matematik för 7B: 2 lektioner tis, högst 1 per dag' },
        { label: 'En lärares tak per dag gav vika ons: 400 min mot taket 360 min' },
        { label: 'Idrott för 8A: 2 av 3 lektioner i ett rum utanför ämnets rum' },
        { label: 'Svenska för 9A: lektioner 1 dag från varandra, regeln kräver minst 2' },
        { label: expect.stringContaining('En lärares gräns för antal undervisningsdagar gav vika') },
      ],
      params: { appliedAt: APPLIED.toISOString() },
    });
  });

  it('looks at the year’s newest entry of the two kinds that replace the draft whole, and only at that', async () => {
    const tx = arrange(logRow());
    await find(tx);
    expect(tx.scheduleChangeLog.findFirst).toHaveBeenCalledWith({
      where: { academicYearId: YEAR, action: { in: ['REGENERATE', 'RESTORE'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, createdAt: true, after: true },
    });
  });

  it.each([
    ['no entry at all', null],
    ['a RESTORE after it: the timetable was replaced', logRow({ action: 'RESTORE' })],
    ['a Generera run (an entry with no source)', logRow({ after: { solverStatus: 'OPTIMAL' } })],
    ['a candidate that broke nothing (an empty list)', logRow({ after: { source: 'CANDIDATE', deviations: [], solverStatus: 'OPTIMAL' } })],
    ['a candidate of an ordinary run (no list at all)', logRow({ after: { source: 'CANDIDATE', ordinal: 2, variant: 'SPREAD' } })],
    ['a list that was never accepted (no digest)', logRow({ after: { source: 'CANDIDATE', deviations: ENTRIES } })],
    ['a digest that is no string', logRow({ after: { source: 'CANDIDATE', deviations: ENTRIES, deviationsDigest: 7 } })],
    ['a list under another source', logRow({ after: { source: 'RESTORE', deviations: ENTRIES, deviationsDigest: DIGEST } })],
    ['a list that is no list', logRow({ after: { source: 'CANDIDATE', deviations: { 0: ENTRIES[0] }, deviationsDigest: DIGEST } })],
    ['an entry with no after', logRow({ after: null })],
  ])('finds nothing for %s', async (_label, last) => {
    const tx = arrange(last);
    await expect(find(tx)).resolves.toEqual(none);
  });

  it('finds nothing once a publication an administrator made has followed the apply — the question is the publication’s, by its time', async () => {
    const tx = arrange(logRow(), { id: 'pub-1' });

    await expect(find(tx)).resolves.toEqual(none);

    expect(tx.timetablePublication.findFirst).toHaveBeenCalledWith({
      where: {
        academicYearId: YEAR,
        outcome: 'PUBLISHED',
        kind: { in: ['PUBLISH', 'LEGACY_PUBLISH'] },
        publishedAt: { gt: APPLIED },
      },
      select: { id: true },
    });
  });

  it('asks about no publication when there is nothing to publish a deviation of', async () => {
    const tx = arrange(logRow({ action: 'RESTORE' }));
    await find(tx);
    expect(tx.timetablePublication.findFirst).not.toHaveBeenCalled();
  });

  it('names no person and no figure of a post: the log copy holds none, and a label cannot make one up', async () => {
    const tx = arrange(logRow());
    const finding = await find(tx);
    const text = JSON.stringify(finding);
    expect(text).not.toMatch(/subjectIds|rule-id/);
    // The part-timer's line says no number: not the limit, not the days used.
    const days = finding.entries!.find((item) => item.label.includes('undervisningsdagar'))!;
    expect(days.label).not.toMatch(/\d/);
    expect(days.label).not.toMatch(/[A-ZÅÄÖ][a-zåäö]+ [A-ZÅÄÖ][a-zåäö]+ /);
  });

  describe('deviationLabel', () => {
    it('says the singular where there is one', () => {
      expect(deviationLabel(entry('DEVIATION_SUBJECT_PER_DAY', { requirement: 'Bild för 7A', day: 5, maxPerDay: 1, count: 1, over: 0, needed: 1 }))).toBe(
        'Bild för 7A: 1 lektion fre, högst 1 per dag',
      );
      expect(deviationLabel(entry('DEVIATION_SUBJECT_DAYS_APART', { requirement: 'Bild för 7A', minDaysBetween: 3, pairs: 1, closest: 2, needed: 2 }))).toBe(
        'Bild för 7A: lektioner 2 dagar från varandra, regeln kräver minst 3',
      );
    });

    it('names a weekday it has no word for by its number, and a missing one by a question mark', () => {
      expect(deviationLabel(entry('DEVIATION_TEACHER_DAILY_CAP', { day: 9, minutes: 300, taught: 310, over: 10, needed: 310 }))).toContain('dag 9');
      expect(deviationLabel(entry('DEVIATION_TEACHER_DAILY_CAP', { minutes: 300, taught: 310, over: 10, needed: 310 }))).toContain('vika ?:');
    });

    it('falls back to the sentence the entry stored for a code it does not know — a newer version wrote it', () => {
      expect(deviationLabel(entry('DEVIATION_SOMETHING_NEW', {}, { message: 'A new rule gave way.' }))).toBe('A new rule gave way.');
      expect(deviationLabel({ category: 'DEVIATION' })).toBe('Ett avsteg från skolans regler');
    });
  });

  describe('the policy', () => {
    it('follows gateDeviations, one check to one column, WARN until the school chooses', () => {
      expect(GATE_COLUMN.PUB_DEVIATIONS).toBe('gateDeviations');
      expect(DEFAULT_GATE_POLICY.gateDeviations).toBe('WARN');
      const finding = { code: 'PUB_DEVIATIONS' as const, count: 2, entries: [{ label: 'a' }, { label: 'b' }] };
      expect(settleGates([finding], DEFAULT_GATE_POLICY)[0]).toMatchObject({ code: 'PUB_DEVIATIONS', severity: 'WARN', count: 2 });
      expect(settleGates([finding], { ...DEFAULT_GATE_POLICY, gateDeviations: 'REFUSE' })[0]).toMatchObject({ severity: 'REFUSE' });
      // Another gate set to REFUSE does not refuse it.
      expect(settleGates([finding], { ...DEFAULT_GATE_POLICY, gateClashes: 'REFUSE', gateOtherSchool: 'REFUSE' })[0]).toMatchObject({ severity: 'WARN' });
    });

    it('is dropped when nothing is found, so a preview that has no deviations says nothing', () => {
      expect(settleGates([none as never], DEFAULT_GATE_POLICY)).toEqual([]);
    });
  });
});
