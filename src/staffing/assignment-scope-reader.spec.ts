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
  const stored = () => {
    const { bands, ...version } = row();
    return { version: { id: 'version-1', ...version }, bands };
  };

  it('asks the database for the lydelse that holds on the year\'s first day, then for its bands, and answers a list of one', async () => {
    const { version, bands } = stored();
    const findFirst = jest.fn().mockResolvedValue(version);
    const findMany = jest.fn().mockResolvedValue(bands);
    const tx = { assignmentScopeVersion: { findFirst }, assignmentScopeBand: { findMany } } as unknown as PrismaClient;
    const versions = await readScopeVersions(tx, '2027-08-16');
    expect(findFirst).toHaveBeenCalledTimes(1);
    const day = new Date('2027-08-16T00:00:00.000Z');
    expect(findFirst).toHaveBeenCalledWith({
      where: { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] },
      orderBy: { validFrom: 'desc' },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { versionId: 'version-1' } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.code).toBe('SFS2026:1487');
    expect(versions[0]!.bands).toHaveLength(bands.length);
  });

  it('answers none when no lydelse holds that day (a läsår that begins before the ordinance), and sends no statement for the bands', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn();
    const tx = { assignmentScopeVersion: { findFirst }, assignmentScopeBand: { findMany } } as unknown as PrismaClient;
    expect(await readScopeVersions(tx, '2026-08-17')).toEqual([]);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });
});
