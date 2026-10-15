import { dutySegments, toSs12000Duties, type DutyInput, type DutyPeriod } from './ss12000-duties';
import { dutyAfterPeriodId, uuidV3, SCHEMAPRO_SS12000_NAMESPACE } from './ss12000-v2/ids';

/**
 * A post that changes during the year as SS12000 Duties (20261022120000):
 * one Duty per stretch of the year in which the grad stays the same, only
 * where the school shares employment, with ids that stay as long as what
 * they name. app.ss12000_split_duty_ids derives the same ids in the database
 * (scripts/test/probe-ss12000-provider.ts compares the two).
 */

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const POST = '11111111-1111-4111-8111-111111111111';
const SPRING = '22222222-2222-4222-8222-222222222222';
const AUTUMN_LEAVE = '33333333-3333-4333-8333-333333333333';

const period = (id: string, validFrom: string, validTo: string | null, employmentPercent: number): DutyPeriod => ({
  id,
  validFrom,
  validTo,
  employmentPercent,
  createdAt: new Date('2026-10-01T00:00:00Z'),
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
  },
  mentorships,
  periods,
});

describe('dutySegments: the year cut where the grad changes', () => {
  const post = { id: POST, employmentPercent: 100, createdAt: new Date('2026-08-01T00:00:00Z') };

  it('is the post itself, the year’s bounds and its id, when no period changes the grad', () => {
    expect(dutySegments(post, [], YEAR)).toEqual([
      { id: POST, startDate: YEAR.startDate, endDate: YEAR.endDate, employmentPercent: 100, created: post.createdAt },
    ]);
    // A period that changes only the nedsättning or the target keeps the grad: one Duty, no dates told.
    expect(dutySegments(post, [period(SPRING, '2027-01-11', null, 100)], YEAR)).toHaveLength(1);
  });

  it('gives the post’s id to the first stretch and the period’s to its own', () => {
    expect(dutySegments(post, [period(SPRING, '2027-01-11', null, 50)], YEAR).map(({ id, startDate, endDate, employmentPercent }) => [id, startDate, endDate, employmentPercent])).toEqual([
      [POST, '2026-08-17', '2027-01-10', 100],
      [SPRING, '2027-01-11', '2027-06-11', 50],
    ]);
  });

  it('names the post’s figures after a period by that period, and a period from the first day by the post', () => {
    const segments = dutySegments(post, [period(AUTUMN_LEAVE, '2026-08-17', '2026-12-20', 50)], YEAR);
    expect(segments.map(({ id, startDate, endDate }) => [id, startDate, endDate])).toEqual([
      [POST, '2026-08-17', '2026-12-20'],
      [dutyAfterPeriodId(AUTUMN_LEAVE), '2026-12-21', '2027-06-11'],
    ]);
  });

  it('makes stretches with the same grad next to each other one, so a period at the post’s own grad splits nothing', () => {
    const segments = dutySegments(
      post,
      [period(AUTUMN_LEAVE, '2026-10-01', '2026-10-31', 100), period(SPRING, '2027-01-11', null, 50)],
      YEAR,
    );
    expect(segments.map(({ id, startDate, endDate }) => [id, startDate, endDate])).toEqual([
      [POST, '2026-08-17', '2027-01-10'],
      [SPRING, '2027-01-11', '2027-06-11'],
    ]);
  });

  it('derives the after-id as RFC 4122 version 3 in SchemaPro’s namespace, lowercased', () => {
    const id = dutyAfterPeriodId(SPRING.toUpperCase());
    expect(id).toBe(uuidV3(SCHEMAPRO_SS12000_NAMESPACE, `duty-after:${SPRING}`));
    expect(id[14]).toBe('3');
    expect('89ab').toContain(id[19]!);
    expect(id).not.toBe(SPRING);
  });
});

describe('toSs12000Duties', () => {
  it('emits one Duty, the post’s, where the school does not share employment, periods or not', () => {
    const duties = toSs12000Duties(input(false, [period(SPRING, '2027-01-11', null, 50)]));
    expect(duties).toHaveLength(1);
    expect(duties[0]).toMatchObject({ id: POST, startDate: YEAR.startDate, endDate: YEAR.endDate });
    expect(duties[0]).not.toHaveProperty('dutyPercent');
  });

  it('emits a Duty per stretch where it shares, each with its own grad, hours and mentorships clipped to it', () => {
    const duties = toSs12000Duties(
      input(true, [period(SPRING, '2027-01-11', null, 50)], [
        { studentGroupId: 'g-7b', updatedAt: new Date('2026-09-15T00:00:00Z'), validFrom: null, validTo: '2026-12-20' },
      ]),
    );
    expect(duties.map((duty) => [duty.id, duty.startDate, duty.endDate, duty.dutyPercent, duty.hoursPerYear])).toEqual([
      [POST, '2026-08-17', '2027-01-10', 100, 1767],
      [SPRING, '2027-01-11', '2027-06-11', 50, 884],
    ]);
    // The mentorship ended at Christmas: the autumn's Duty only.
    expect(duties[0]!.assignmentRole).toEqual([
      { group: { id: 'g-7b' }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2026-12-20' },
    ]);
    expect(duties[1]).not.toHaveProperty('assignmentRole');
    // A period moved moves every Duty of the post; each was created with what it names.
    expect(duties.map((duty) => duty.meta)).toEqual([
      { created: '2026-08-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' },
      { created: '2026-10-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' },
    ]);
  });
});
