import type { PrismaClient } from '@prisma/client';
import type { ScopeBand, ScopeVersion } from './assignment-scope';

/*
 * The ordinance's lydelser and their bands (AssignmentScopeVersions, AssignmentScopeBands; migration 20270301090000),
 * read in the caller's own RLS transaction.
 *
 * Global reference data, a handful of rows. The lydelse that holds on the year's first day is asked for by that day, and the
 * arithmetic that decides between two (versionInForce) stays in the pure module for the callers that hold several.
 */

type VersionRow = {
  code: string;
  sfs: string;
  title: string;
  validFrom: Date;
  validTo: Date | null;
  source: string;
  bands: {
    schoolForm: string;
    gradeNumbering: 'NIOARIG' | 'TIOARIG';
    gradeFrom: number;
    gradeTo: number;
    teachingHoursLow: number;
    teachingHoursHigh: number;
    planningFloorPercent: number;
    teachingSection: string;
    planningSection: string;
    note: string | null;
  }[];
};

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/** A row as the arithmetic reads it: dates as yyyy-mm-dd, the bands in grade order. */
export function toScopeVersion(row: VersionRow): ScopeVersion {
  const bands: ScopeBand[] = row.bands
    .map((band) => ({
      schoolForm: band.schoolForm,
      gradeNumbering: band.gradeNumbering,
      gradeFrom: band.gradeFrom,
      gradeTo: band.gradeTo,
      teachingHoursLow: band.teachingHoursLow,
      teachingHoursHigh: band.teachingHoursHigh,
      planningFloorPercent: band.planningFloorPercent,
      teachingSection: band.teachingSection,
      planningSection: band.planningSection,
      note: band.note,
    }))
    .sort((a, b) => a.gradeFrom - b.gradeFrom || a.gradeNumbering.localeCompare(b.gradeNumbering));
  return {
    code: row.code,
    sfs: row.sfs,
    title: row.title,
    validFrom: asDay(row.validFrom),
    validTo: row.validTo === null ? null : asDay(row.validTo),
    source: row.source,
    bands,
  };
}

/**
 * The lydelse that holds on a year's first day, with its bands, as a list of one; empty when none holds (every läsår that begins
 * before 2027-07-01). The database picks it, and the bands are read only when one is found: a year the ordinance does not reach costs ONE
 * statement, and one it reaches TWO. (A relation read through `include` is a statement of its own under Prisma 7 and is sent
 * for a parent that was not found too, with an empty set: the statement count of a year that is not reached was two,
 * review of #404, M-3. `relationLoadStrategy: 'join'` is not on.)
 */
export async function readScopeVersions(tx: PrismaClient, yearStart: string): Promise<ScopeVersion[]> {
  const day = new Date(`${yearStart}T00:00:00.000Z`);
  const version = await tx.assignmentScopeVersion.findFirst({
    where: { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] },
    orderBy: { validFrom: 'desc' },
  });
  if (!version) return [];
  const bands = await tx.assignmentScopeBand.findMany({ where: { versionId: version.id } });
  return [toScopeVersion({ ...version, bands })];
}
