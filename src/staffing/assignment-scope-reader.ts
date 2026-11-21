import type { PrismaClient } from '@prisma/client';
import type { ScopeBand, ScopeVersion } from './assignment-scope';

/*
 * The ordinance's lydelser and their bands (AssignmentScopeVersions, AssignmentScopeBands; migration 20270301090000),
 * read in the caller's own RLS transaction.
 *
 * Global reference data, a handful of rows: every lydelse is read and the year's first day picks one (versionInForce),
 * so no date arithmetic lives in SQL and a year before the ordinance simply finds none. One statement for the lydelser
 * with their bands (Prisma joins a relation read on PostgreSQL), which every report that asks for the scope pays.
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

/** Every lydelse of the ordinance with its bands, oldest first. */
export async function readScopeVersions(tx: PrismaClient): Promise<ScopeVersion[]> {
  const rows = await tx.assignmentScopeVersion.findMany({
    include: { bands: true },
    orderBy: { validFrom: 'asc' },
  });
  return (rows ?? []).map(toScopeVersion);
}
