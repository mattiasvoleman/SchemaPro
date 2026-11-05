/**
 * Skyddad identitet (20270107090000): the persons a school has marked as
 * having a protected identity, and the files the web writes without them.
 *
 * A file of people is built at the click from lists the page already holds,
 * and the marks are read then (GET /api/v1/person-protections, which every
 * administrator reads and the läslogg records): a page never holds who is
 * protected, and nobody pays for these lines who never exports. Pages import
 * this module with import() at the click, as they load their own builders.
 *
 * Which files leave the marked out, and which keep them and say so, is
 * PEOPLE_FILES in lib/people-files.ts; its test fails a download it does not
 * list.
 */

import { api } from "@/lib/api";

export interface PersonProtection {
  userId: string;
  /** Who said so: the SS12000 sync, or an administrator. null once removed. */
  source: "SS12000" | "MANUAL" | null;
}

/**
 * A file and how many marked persons it does not name. A file that names
 * links (vardnadshavare.csv) counts links instead (`unit: "links"`). A null
 * content is no file at all: there was nothing left to write.
 */
export interface HeldOutFile {
  content: string | null;
  heldOut: number;
  unit?: "people" | "links";
}

/** The school's marked persons, read now. */
export async function readMarks(): Promise<Set<string>> {
  const rows = await api.get<PersonProtection[]>("/api/v1/person-protections");
  return new Set(rows.map((row) => row.userId));
}

/**
 * Builds a file from the unmarked persons only. `heldOut` is the number of
 * marked persons the file is about (`about`: a role, or a test for a file
 * whose people are not one role) that it would otherwise have had: the
 * file names none of them, and no row that names one of them.
 */
export async function withoutMarked<P extends { id: string; role?: string }>(
  people: readonly P[],
  about: string | ((person: P) => boolean),
  build: (people: P[]) => string | null | Promise<string | null>,
): Promise<HeldOutFile> {
  const marks = await readMarks();
  const kept = people.filter((person) => !marks.has(person.id));
  const counted = typeof about === "string" ? (person: P) => person.role === about : about;
  const heldOut = people.filter((person) => marks.has(person.id) && counted(person)).length;
  return { content: await build(kept), heldOut, unit: "people" };
}

/**
 * A file that keeps every person it names, because its recipient must have
 * them all (SCB, payroll, the samverkan on the tjänstefördelning): how many
 * of `ids` are marked, so the page can say the file holds protected persons.
 */
export async function markedAmong(ids: Iterable<string>): Promise<number> {
  const marks = await readMarks();
  return new Set([...ids].filter((id) => marks.has(id))).size;
}
