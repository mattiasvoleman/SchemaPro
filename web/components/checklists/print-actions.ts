import { api } from "@/lib/api";
import { CHECKLISTS_BASE, type ConsentDetail, type ProofRoster } from "@/lib/checklists";

/*
 * Checklistor on paper: the browser's print (which is also how a PDF is made).
 * The only module of Checklistor that prints, so it is the one entry of
 * lib/people-files.ts (PEOPLE_FILES) for it.
 *
 * THE PAPER IS THE GATEWAY'S. The screen names every pupil the reader may see: a
 * teacher reads the register already, and Checklistor is how they work with it.
 * A sheet leaves the screen and hangs in a corridor or lies on a table, so it
 * is not made from what the screen holds. At the click the web asks the
 * gateway for the roster or the list "for paper" (GET .../roster/print and
 * GET .../consent-lists/:id/print), which leaves out every pupil the school has
 * marked as having a protected identity (skyddad identitet) from the rows and
 * from the counts, and says how many in `heldOut`; the sheet shows that and
 * nothing else. The gateway decides because the marks are an administrator's
 * to read: a teacher, who prints too, could not hold the marked out here.
 * Rule HANDS_OVER in lib/people-files.ts. A read that fails prints nothing.
 *
 * This module is fetched at the click, together with the sheet's own markup
 * (printed-sheet.tsx), and not with the page. The reads are recorded in the
 * läslogg like the screen's.
 */

/** A group's roster for paper: the marked pupils are not in `rows`, `done` or `pupils`, and `heldOut` counts them. */
export function fetchRosterForPaper(templateId: string, groupId: string): Promise<ProofRoster> {
  return api.get<ProofRoster>(`${CHECKLISTS_BASE}/templates/${templateId}/roster/print?groupId=${encodeURIComponent(groupId)}`);
}

/** A consent list for paper: the marked pupils are not in `rows` or `list.counts`, and `heldOut` counts them. */
export function fetchListForPaper(listId: string): Promise<ConsentDetail> {
  return api.get<ConsentDetail>(`${CHECKLISTS_BASE}/consent-lists/${listId}/print`);
}

/** Opens the print dialog; the sheet, made of what the gateway answered, is on the page by then. */
export function printSheet(): void {
  window.print();
}
