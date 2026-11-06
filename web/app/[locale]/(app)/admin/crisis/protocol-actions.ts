import { PROTOCOL_HEADERS, protocolFilename, protocolRows, pupilIds } from "@/lib/crisis-protocol";
import type { ProtocolView } from "@/lib/crisis-types";
import { downloadCsv, serializeCsv } from "@/lib/csv-export";
import { readMarks, withoutMarked } from "@/lib/protected-people";

/*
 * The two ways the protocol leaves the screen: a CSV file and paper (the
 * browser's print, which is also how a PDF is made). The only module of the
 * page that downloads or prints, so it is the one entry of lib/people-files.ts
 * (PEOPLE_FILES) for Krisläge, and its rule is HOLDS_OUT: a pupil the school
 * has marked as having a protected identity is not named in either, and the
 * page says how many were left out. The marks are read at the click, and a
 * read that fails downloads and prints nothing.
 */

/**
 * Downloads the protocol as CSV and answers how many pupils it holds out by
 * name. Which marks of those pupils go with them is lib/crisis-protocol.ts.
 */
export async function exportProtocol(view: ProtocolView, timeZone: string): Promise<number> {
  const everyone = pupilIds(view).map((id) => ({ id }));
  const file = await withoutMarked(everyone, () => true, (kept) => {
    const keptIds = new Set(kept.map((person) => person.id));
    const held = new Set(everyone.filter((person) => !keptIds.has(person.id)).map((person) => person.id));
    return serializeCsv([...PROTOCOL_HEADERS], protocolRows(view, held, timeZone));
  });
  if (file.content !== null) downloadCsv(protocolFilename(view.alarm.startedAt, timeZone), file.content);
  return file.heldOut;
}

/** The pupils of the protocol that the school has marked as protected: what the printed pages leave out. */
export async function protectedAmongPupils(view: ProtocolView): Promise<Set<string>> {
  const marks = await readMarks();
  return new Set(pupilIds(view).filter((id) => marks.has(id)));
}

/** Opens the print dialog; the paper (ProtocolPaper) is on the page by then. */
export function printProtocol(): void {
  window.print();
}
