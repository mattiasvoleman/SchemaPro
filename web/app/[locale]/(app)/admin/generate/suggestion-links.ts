import type { SuggestionChange, SuggestionRule } from "@/lib/suggestion-types";

/*
 * WHERE A SUGGESTION IS APPLIED (omgång 13, G6 Åtgärdsförslag vid vägran).
 *
 * Nothing is changed from this page: a suggestion is a link to the page that owns the data, with the field named in the address, and
 * the change is made there, by the administrator, with that page's own warnings. The address says WHICH row (a work rule, a timplanspost,
 * a room rule) and never what to write: the figure stays on the card, where the proof is.
 *
 * THE OWNER PAGES READ THE PARAMETER, OR OPEN AS THEY ALWAYS DO. A page that does not read it yet opens where it always does, so a link
 * is never a dead end and the card never depends on a page that is somebody else's to change (the staffing pages are R1's).
 *
 *   TEACHER_DAILY_CAP   /admin/people?workRule=<work rule id>      the teacher's Arbetstid
 *   SUBJECT_PER_DAY     /admin/requirements?post=<post id>         the post's cell, where its rule is
 *   SUBJECT_DAYS_APART  /admin/requirements?post=<post id>
 *   ROOM_LOCK           /admin/constraints?roomRule=<room rule id> the room rules of the subject
 *   TEACHER_WORK_DAYS   /admin/staffing                            a part-timer's days live on the post: no parameter, no row named
 */

export type SuggestionPage = "people" | "requirements" | "constraints" | "staffing";

export interface SuggestionLink {
  page: SuggestionPage;
  /** A path with its query, for the locale-aware Link. */
  href: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row's id as it may go into an address: a uuid and nothing else, so no text from a run ever becomes part of a path. */
const rowOf = (id: string | undefined): string | null => (id !== undefined && UUID.test(id) ? id : null);

const withRow = (path: string, key: string, id: string | undefined): string => {
  const row = rowOf(id);
  return row === null ? path : `${path}?${key}=${row}`;
};

/** The page of each rule, whether or not a row can be named. */
export const PAGE_OF_RULE: Record<SuggestionRule, SuggestionPage> = {
  TEACHER_DAILY_CAP: "people",
  TEACHER_WORK_DAYS: "staffing",
  SUBJECT_PER_DAY: "requirements",
  SUBJECT_DAYS_APART: "requirements",
  ROOM_LOCK: "constraints",
};

const PATH_OF_PAGE: Record<SuggestionPage, string> = {
  people: "/admin/people",
  requirements: "/admin/requirements",
  constraints: "/admin/constraints",
  staffing: "/admin/staffing",
};

/** The page and row a change is applied on. */
export function linkOfChange(change: Pick<SuggestionChange, "rule" | "resourceIds" | "requirementIds">): SuggestionLink {
  const page = PAGE_OF_RULE[change.rule];
  const path = PATH_OF_PAGE[page];
  switch (change.rule) {
    case "TEACHER_DAILY_CAP":
      return { page, href: withRow(path, "workRule", change.resourceIds[0]) };
    case "ROOM_LOCK":
      return { page, href: withRow(path, "roomRule", change.resourceIds[0]) };
    case "SUBJECT_PER_DAY":
    case "SUBJECT_DAYS_APART":
      return { page, href: withRow(path, "post", change.requirementIds[0]) };
    case "TEACHER_WORK_DAYS":
      return { page, href: path };
  }
}

/** The page of a rule with no row named: where a measurement that no rule alone is behind points. */
export function linkOfRule(rule: SuggestionRule): SuggestionLink {
  const page = PAGE_OF_RULE[rule];
  return { page, href: PATH_OF_PAGE[page] };
}

/** The page and the row of a work rule a refusal names. */
export function linkOfWorkRule(ruleId: string | undefined): SuggestionLink {
  return { page: "people", href: withRow(PATH_OF_PAGE.people, "workRule", ruleId) };
}
