import type { AdminProfile } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';

/**
 * Hela skolans data (K5, 20270110090000): the numbers and names the order, the
 * job, the database and the manual all agree on.
 */

/** The format document's version, in the manifest and README. A column added or removed raises it. */
export const FORMAT_VERSION = 1;

/** A file is fetchable this long after it is built, then its pieces are deleted (the database holds a ceiling of 14 days). */
export const EXPORT_KEEP_HOURS = 72;
export const EXPORT_KEEP_INTERVAL = `${EXPORT_KEEP_HOURS} hours`;

/** The order's row is kept this long after it ended, as the record of who took a copy. */
export const LEDGER_INTERVAL = '13 months';

/** A piece of the stored file. The database accepts up to 4 MiB. */
export const CHUNK_BYTES = 1024 * 1024;

/** How often the job looks for an order, and how long it may be silent before another instance takes the export over. */
export const POLL_INTERVAL_MS = 30_000;
export const LEASE_SECONDS = 180;
export const HEARTBEAT_EVERY_MS = 15_000;

/** A data file is split into parts at this many rows: Excel opens 1 048 576. */
export const ROWS_PER_PART = 1_000_000;

/** The job's name in the runner, in JobRuns. */
export const SCHOOL_EXPORT_JOB = 'school-export';

/**
 * The administrator profiles that order and fetch a whole-school export: the
 * ones that decide (rektor and a full administrator), who own gallring and the
 * läslogg. Held three ways, as the matrix of areas is: the arms of
 * SchoolExports (app.current_user_decides()), the route (@Decides()) and this
 * list, which the spec compares with admin-areas.ts's PROFILE_DECIDES.
 */
export const SCHOOL_EXPORT_PROFILES: readonly AdminProfile[] = ['FULL', 'REKTOR'];

/**
 * The läslogg kinds a download is recorded under, with the persons per kind
 * the file holds rows about (SchoolExports.readAbout). A kind with no person
 * is not written.
 */
export type ReadAbout = Partial<Record<AccessKind, string[]>>;

/** What the export says about itself, per file, in the manifest and on the export's row. */
export interface ManifestFile {
  path: string;
  title: string;
  rows: number;
  bytes: number;
  sha256: string;
  /** Rows left out for a protected identity. */
  heldOutRows?: number;
  /** Cells emptied for a protected identity (who recorded, who decided). */
  blankedCells?: number;
}

/** What `files` on the export's row holds for each part: no person's data. */
export interface FileSummary {
  path: string;
  rows: number;
  bytes: number;
}

export interface HeldOutSummary {
  /** Persons with a protected identity the school has marked: none of them is in the file. */
  people: number;
  /** Guardian links left out because one end is marked. */
  links: number;
}
