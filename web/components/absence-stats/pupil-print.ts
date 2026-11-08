import { readMarks } from "@/lib/protected-people";

/*
 * The pupil's card on paper: the browser's print (which is also how a PDF is
 * made). The only module of Frånvarostatistik that prints, so it is the one
 * entry of lib/people-files.ts (PEOPLE_FILES) for it, and its rule is
 * HOLDS_OUT: a pupil the school has marked as having a protected identity is
 * not printed, ever, and the card says so.
 *
 * A printed sheet leaves the screen, the system and the school's rooms, and
 * it names a child and the child's absence. The marks are read at the click
 * (the administrators read them, and the läslogg records it), and a read that
 * fails prints nothing: the sheet would otherwise name the person it was meant
 * to leave out. A mentor may not read the marks; for them the gateway never
 * hands out a marked pupil's card, and the card's own `isProtected` is checked
 * before this module is even reached. The module is part of the pupil card's
 * chunk, which is fetched when the first card is opened, not with the page.
 */

/** Whether the school has marked the pupil as having a protected identity, read now. */
export async function pupilIsMarked(studentId: string): Promise<boolean> {
  return (await readMarks()).has(studentId);
}

/** Opens the print dialog; the sheet (PupilSheet) is on the page by then. */
export function printPupilCard(): void {
  window.print();
}
