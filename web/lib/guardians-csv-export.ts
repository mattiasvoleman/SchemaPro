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
 * are active, and a guardian who is not is an error on the way back in. A
 * link where the pupil or the guardian has a protected identity is held out
 * there too, and counted (skyddad identitet, lib/protected-people.ts).
 */

import { api } from "@/lib/api";
import { CSV_TEMPLATES, serializeCsv } from "@/lib/csv-export";
import type { HeldOutFile } from "@/lib/protected-people";

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

/** What the gateway answers: the rows, and how many links it held out for a protected identity. */
export interface GuardianExport {
  rows: GuardianExportRow[];
  heldOut: number;
}

/**
 * The school's links, read at the click and written as vardnadshavare.csv,
 * and how many were held out; no file (null content) when no link is left.
 */
export async function guardiansCsvFor(): Promise<HeldOutFile> {
  const { rows, heldOut } = await api.get<GuardianExport>("/api/v1/guardian-links/export");
  return { content: rows.length === 0 ? null : guardiansToCsv(rows), heldOut, unit: "links" };
}
