import { dutySegments, toSs12000Duties, type DutyInput, type DutyPeriod } from './ss12000-duties';
import { dutyStretchId, uuidV3, SCHEMAPRO_SS12000_NAMESPACE } from './ss12000-v2/ids';

/**
 * A post that changes during the year as SS12000 Duties (20261022120000):
 * one Duty per stretch of the year in which the grad stays the same whole
 * percent, only where the school shares employment. The first is the post's
 * id, every other is named by the post and its first day: what a reader of
 * the Duties sees, so a period no Duty shows names nothing.
 * app.ss12000_split_duty_ids derives the same ids in the database
 * (scripts/test/probe-ss12000-provider.ts compares the two).
 */

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const POST = '11111111-1111-4111-8111-111111111111';
const KEY = '44444444-4444-4444-8444-444444444444';

const period = (validFrom: string, validTo: string | null, employmentPercent: number): DutyPeriod => ({
  validFrom,
  validTo,
  employmentPercent,
  updatedAt: new Date('2026-10-02T00:00:00Z'),
});

const input = (share: boolean, periods: DutyPeriod[], mentorships: DutyInput['mentorships'] = []) => ({
  schoolId: 'school',
  year: YEAR,
  share,
  fullTimeAnnualHours: 1767,
  employment: {
    id: POST,
    userId: 'user',
    employmentPercent: 100,
    signature: 'ANN',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    contractKind: 'FERIE' as const,
    stretchKey: KEY,
  },
  mentorships,
  periods,
});

const cut = (periods: DutyPeriod[], employmentPercent = 100) =>
  dutySegments({ id: POST, employmentPercent, stretchKey: KEY }, periods, YEAR).map(({ id, startDate, endDate, employmentPercent: grad }) => [id, startDate, endDate, grad]);

describe('dutySegments: the year cut where the grad changes', () => {
  it('is the post itself, the year’s bounds and its id, when no period changes the grad', () => {
    expect(dutySegments({ id: POST, employmentPercent: 100, stretchKey: KEY }, [], YEAR)).toEqual([
      { id: POST, startDate: YEAR.startDate, endDate: YEAR.endDate, employmentPercent: 100 },
    ]);
    // A period that changes only the nedsättning or the target keeps the grad: one Duty, no dates told.
    expect(cut([period('2027-01-11', null, 100)])).toHaveLength(1);
  });

  it('makes stretches whose grad is the same whole percent one Duty, with the first stretch’s grad', () => {
    // 66.667 % and 66.9 % both read 67: two Duties would differ in their dates alone.
    expect(cut([period('2027-01-11', null, 66.9)], 66.667)).toEqual([[POST, YEAR.startDate, YEAR.endDate, 66.667]]);
    // 66.4 % reads 66: a Duty of its own.
    expect(cut([period('2027-01-11', null, 66.4)], 66.667)).toHaveLength(2);
  });

  it('gives the post’s id to the first stretch and names every other by the post and its first day', () => {
    expect(cut([period('2027-01-11', null, 50)])).toEqual([
      [POST, '2026-08-17', '2027-01-10', 100],
      [dutyStretchId(POST, KEY, '2027-01-11'), '2027-01-11', '2027-06-11', 50],
    ]);
    // A period from the first day is the post's own stretch; the figures after it are named by their first day.
    expect(cut([period('2026-08-17', '2026-12-20', 50)])).toEqual([
      [POST, '2026-08-17', '2026-12-20', 50],
      [dutyStretchId(POST, KEY, '2026-12-21'), '2026-12-21', '2027-06-11', 100],
    ]);
  });

  it('makes stretches with the same grad next to each other one, so a period at the post’s own grad splits nothing', () => {
    expect(cut([period('2026-10-01', '2026-10-31', 100), period('2027-01-11', null, 50)])).toEqual([
      [POST, '2026-08-17', '2027-01-10', 100],
      [dutyStretchId(POST, KEY, '2027-01-11'), '2027-01-11', '2027-06-11', 50],
    ]);
  });

  it('lets no period a Duty does not show name a stretch: one at the post’s grad straight after a leave, a leave cut in two', () => {
    // 50 % from 11 January to 31 March; the post's own 100 % after it.
    const leave = [period('2027-01-11', '2027-03-31', 50)];
    const was = cut(leave);
    expect(was.map(([id]) => id)).toEqual([POST, dutyStretchId(POST, KEY, '2027-01-11'), dutyStretchId(POST, KEY, '2027-04-01')]);
    // Back at 100 % from 1 April with a nedsättning: the same Duties, the same ids.
    expect(cut([...leave, period('2027-04-01', null, 100)])).toEqual(was);
    // The leave written as two periods at the same grad: the same again.
    expect(cut([period('2027-01-11', '2027-02-28', 50), period('2027-03-01', '2027-03-31', 50)])).toEqual(was);
  });

  it('derives a stretch’s id as RFC 4122 version 3 in SchemaPro’s namespace, from the post’s key, the post and the day', () => {
    const id = dutyStretchId(POST.toUpperCase(), KEY.toUpperCase(), '2027-01-11');
    expect(id).toBe(uuidV3(SCHEMAPRO_SS12000_NAMESPACE, `duty-from:${KEY}:${POST}:2027-01-11`));
    expect(id[14]).toBe('3');
    expect('89ab').toContain(id[19]!);
    expect(id).not.toBe(dutyStretchId(POST, KEY, '2027-01-12'));
    // Without the key no reader can name it: not from the post and the day alone.
    expect(id).not.toBe(uuidV3(SCHEMAPRO_SS12000_NAMESPACE, `duty-from:${POST}:2027-01-11`));
    expect(id).not.toBe(dutyStretchId(POST, '55555555-5555-4555-8555-555555555555', '2027-01-11'));
  });

  it('cuts no post whose key it was not given: a later stretch has no id without it', () => {
    expect(() => dutySegments({ id: POST, employmentPercent: 100 }, [period('2027-01-11', null, 50)], YEAR)).toThrow(/ss12000StretchKey/);
    // One stretch needs none: it is the post's own id.
    expect(dutySegments({ id: POST, employmentPercent: 100 }, [period('2027-01-11', null, 100)], YEAR)).toHaveLength(1);
  });
});

describe('toSs12000Duties', () => {
  it('emits one Duty, the post’s, where the school does not share employment, periods or not', () => {
    const duties = toSs12000Duties(input(false, [period('2027-01-11', null, 50)]));
    expect(duties).toHaveLength(1);
    expect(duties[0]).toMatchObject({ id: POST, startDate: YEAR.startDate, endDate: YEAR.endDate });
    expect(duties[0]).not.toHaveProperty('dutyPercent');
  });

  it('gives a period that covers the whole year its own grad, under the post’s id', () => {
    const [only] = toSs12000Duties(input(true, [period(YEAR.startDate, null, 80)]));
    expect(only).toMatchObject({ id: POST, startDate: YEAR.startDate, endDate: YEAR.endDate, dutyPercent: 80, hoursPerYear: 1414 });
    expect(toSs12000Duties(input(true, [period(YEAR.startDate, null, 80)]))).toHaveLength(1);
    // Without the opt-in, no figure at all, as for any post.
    expect(toSs12000Duties(input(false, [period(YEAR.startDate, null, 80)]))[0]).not.toHaveProperty('dutyPercent');
  });

  it('emits a Duty per stretch where it shares, each with its own grad, hours and mentorships clipped to it', () => {
    const duties = toSs12000Duties(
      input(true, [period('2027-01-11', null, 50)], [
        { studentGroupId: 'g-7b', updatedAt: new Date('2026-09-15T00:00:00Z'), validFrom: null, validTo: '2026-12-20' },
      ]),
    );
    expect(duties.map((duty) => [duty.id, duty.startDate, duty.endDate, duty.dutyPercent, duty.hoursPerYear])).toEqual([
      [POST, '2026-08-17', '2027-01-10', 100, 1767],
      [dutyStretchId(POST, KEY, '2027-01-11'), '2027-01-11', '2027-06-11', 50, 884],
    ]);
    // The mentorship ended at Christmas: the autumn's Duty only.
    expect(duties[0]!.assignmentRole).toEqual([
      { group: { id: 'g-7b' }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2026-12-20' },
    ]);
    expect(duties[1]).not.toHaveProperty('assignmentRole');
    // A period moved moves every Duty of the post; each was created with the post, as no Duty shows when a period was written.
    expect(duties.map((duty) => duty.meta)).toEqual([
      { created: '2026-08-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' },
      { created: '2026-08-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' },
    ]);
  });
});
