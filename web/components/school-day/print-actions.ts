import { protectedAmong, type SchoolDayView } from "@/lib/school-day";
import { readMarks } from "@/lib/protected-people";

/*
 * Skolans dag on paper: the browser's print (which is also how a PDF is made).
 * The only module of the page that prints, so it is the one entry of
 * lib/people-files.ts (PEOPLE_FILES) for Skolans dag, and its rule is
 * HOLDS_OUT: a teacher the school has marked as having a protected identity
 * is not named on the paper, and the page says how many were left out.
 *
 * A printed sheet leaves the screen, and the screen is the whole staff's day on
 * one wall; the paper hangs in a corridor. The marks are read at the click
 * (the administrators read them, and the läslogg records it), and a read that
 * fails prints nothing: the sheet would otherwise name the person it was meant
 * to leave out. This module is fetched at the click, not with the page.
 */

/** The marked teachers among those the answer names: the names the printed copy leaves out. */
export async function protectedAmongTeachers(view: SchoolDayView): Promise<Set<string>> {
  return protectedAmong(view, await readMarks());
}

/** Opens the print dialog; the sheet, with the marked left out, is on the page by then. */
export function printGrid(): void {
  window.print();
}
