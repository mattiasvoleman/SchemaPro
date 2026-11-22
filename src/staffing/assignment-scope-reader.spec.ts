import type { PrismaClient } from '@prisma/client';
import { readScopeVersions, toScopeVersion } from './assignment-scope-reader';

const band = (gradeFrom: number, gradeTo: number, overrides: Record<string, unknown> = {}) => ({
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG' as const,
  gradeFrom,
  gradeTo,
  teachingHoursLow: 550,
  teachingHoursHigh: 650,
  planningFloorPercent: 100,
  teachingSection: '3 § p. 1',
  planningSection: '4 § p. 1',
  note: null,
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: new Date('2027-07-01T00:00:00.000Z'),
  validTo: null as Date | null,
  source: 'https://example.invalid/sfs',
  bands: [band(7, 9), band(1, 6)],
  ...overrides,
});

describe('toScopeVersion', () => {
  it('reads a @db.Date as the day it holds, and an open end as null', () => {
    const version = toScopeVersion(row({ validTo: new Date('2029-12-31T00:00:00.000Z') }));
    expect(version.validFrom).toBe('2027-07-01');
    expect(version.validTo).toBe('2029-12-31');
    expect(toScopeVersion(row()).validTo).toBeNull();
  });

  it('puts the bands in grade order, however the database returned them, and keeps every figure', () => {
    const version = toScopeVersion(row());
    expect(version.bands.map((one) => [one.gradeFrom, one.gradeTo])).toEqual([[1, 6], [7, 9]]);
    expect(version.bands[0]).toEqual({
      schoolForm: 'GRUNDSKOLA',
      gradeNumbering: 'NIOARIG',
      gradeFrom: 1,
      gradeTo: 6,
      teachingHoursLow: 550,
      teachingHoursHigh: 650,
      planningFloorPercent: 100,
      teachingSection: '3 § p. 1',
      planningSection: '4 § p. 1',
      note: null,
    });
  });

  it('keeps the same grades in two numberings apart, the nine-year one first', () => {
    const version = toScopeVersion(row({ bands: [band(1, 7, { gradeNumbering: 'TIOARIG' }), band(1, 6)] }));
    expect(version.bands.map((one) => one.gradeNumbering)).toEqual(['NIOARIG', 'TIOARIG']);
  });
});

describe('readScopeVersions', () => {
  it('reads every lydelse with its bands in one call, oldest first', async () => {
    const findMany = jest.fn().mockResolvedValue([row()]);
    const tx = { assignmentScopeVersion: { findMany } } as unknown as PrismaClient;
    const versions = await readScopeVersions(tx);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ include: { bands: true }, orderBy: { validFrom: 'asc' } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.code).toBe('SFS2026:1487');
  });

  it('answers none for an empty table', async () => {
    const tx = { assignmentScopeVersion: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
    expect(await readScopeVersions(tx)).toEqual([]);
  });
});
