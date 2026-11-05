/**
 * Vårdnadshavare as the file the importer reads (vardnadshavare.csv): one row
 * per link between a guardian and a pupil.
 *
 * A module of its own, read at the click like the uppdrag export: the people
 * page sits close to its bundle budget, and nobody pays for these lines who
 * never exports. Nor does the page hold the links, which the gateway lists
 * for the whole school in one read that the läslogg records.
 *
 * Only active people and their links are in it, and the gateway makes that cut
 * (GET /api/v1/guardian-links/export): the import takes a pupil only if they
 * are active, and a guardian who is not is an error on the way back in. It
 * says nothing of a pupil's protected identity, because the school does not
 * store which pupils have one.
 */

import { api } from "@/lib/api";
import { CSV_TEMPLATES, serializeCsv } from "@/lib/csv-export";

/** What GET /api/v1/guardian-links/export answers: the file's columns, per link. */
export interface GuardianExportRow {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  studentEmail: string;
}

export function guardiansToCsv(rows: GuardianExportRow[]): string {
  return serializeCsv(
    CSV_TEMPLATES.guardians.headers,
    rows.map((row) => [row.firstName, row.lastName, row.email, row.phone ?? "", row.studentEmail]),
  );
}

/** The school's links, read at the click and written as vardnadshavare.csv; null for a school with none. */
export async function guardiansCsvFor(): Promise<string | null> {
  const rows = await api.get<GuardianExportRow[]>("/api/v1/guardian-links/export");
  return rows.length === 0 ? null : guardiansToCsv(rows);
}
