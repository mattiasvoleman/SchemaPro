/**
 * Kvittens (F4), the web's side of the vocabulary, the shapes and the form
 * (/admin/acknowledgements, /teacher/acknowledgements and
 * /guardian/acknowledgements).
 *
 * The gateway's src/ack/ack.ts says the same bounds, rules and codes, and
 * src/ack/ack-views.ts the same shapes; ack.test.ts reads the first and fails
 * when this file drifts. Free of React and of imports, so a test can read it
 * as it is.
 *
 * WHO IS DONE is the database's say (app.ack_status): nothing here works out
 * whether a request is met. What the guardian is shown is their own row and
 * nothing of the other guardian's: AckMine has no field for it.
 */

export const ACK_RULES = ["ANY", "ALL"] as const;
export type AckRule = (typeof ACK_RULES)[number];

export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
/** Pupils in one request. */
export const PUPILS_MAX = 2000;
export const REMIND_DAYS_MIN = 1;
export const REMIND_DAYS_MAX = 30;

/** The gateway's codes (src/ack/ack.ts). A status alone cannot tell the two 409s apart. */
export const ACK_DISABLED = "ACK_DISABLED";
export const ACK_NOT_FOUND = "ACK_NOT_FOUND";
export const ACK_CUSTODY_ENDED = "ACK_CUSTODY_ENDED";
export const ACK_UNKNOWN_PUPIL = "ACK_UNKNOWN_PUPIL";
export const ACK_NOT_YOUR_PUPIL = "ACK_NOT_YOUR_PUPIL";
export const ACK_NO_GUARDIANS = "ACK_NO_GUARDIANS";

/** The refusals of a request that have a sentence of their own in the form. */
export const CREATE_REFUSALS = [ACK_DISABLED, ACK_UNKNOWN_PUPIL, ACK_NOT_YOUR_PUPIL, ACK_NO_GUARDIANS] as const;
export type CreateRefusal = (typeof CREATE_REFUSALS)[number];

/** The days the school may wait before the one reminder, in the order a select lists them. */
export const REMIND_DAY_OPTIONS: readonly number[] = Array.from(
  { length: REMIND_DAYS_MAX - REMIND_DAYS_MIN + 1 },
  (_, index) => REMIND_DAYS_MIN + index,
);

// ---------------------------------------------------------------------------
// What the gateway answers (src/ack/ack-views.ts)
// ---------------------------------------------------------------------------

export interface AckSettings {
  enabled: boolean;
  /** Days before the one reminder; null: none. */
  remindAfterDays: number | null;
}

/** What PUT /settings takes: a save names what changed. */
export interface AckSettingsChange {
  enabled?: boolean;
  remindAfterDays?: number | null;
}

export interface AckPupilChoice {
  id: string;
  name: string;
  className: string | null;
  /** Guardians who would be asked. Zero: nobody can be asked about the pupil. */
  guardians: number;
}

export interface AckCreated {
  id: string;
  pupils: number;
  guardians: number;
  /** Ids of the pupils left out because no guardian could be asked. */
  withoutGuardian: string[];
}

/** What the page keeps of a request just sent: the answer, and the names behind `withoutGuardian`. */
export interface AckSent {
  created: AckCreated;
  withoutGuardianNames: string[];
}

export interface AckListItem {
  id: string;
  title: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  /** Pupils the reader sees in it. */
  pupils: number;
  /** Of those, how many are met. */
  met: number;
  /** Guardians who have not confirmed and still can. */
  waiting: number;
  remindAt: string | null;
  reminderSent: boolean;
}

export type AckGuardianState = "CONFIRMED" | "WAITING" | "ENDED";

export interface AckGuardianRow {
  id: string;
  name: string;
  state: AckGuardianState;
  ackedAt: string | null;
  remindedAt: string | null;
}

export interface AckPupilRow {
  id: string;
  name: string;
  className: string | null;
  met: boolean;
  guardians: AckGuardianRow[];
}

export interface AckDetail {
  id: string;
  title: string;
  body: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  remindAt: string | null;
  reminderSentAt: string | null;
  pupils: AckPupilRow[];
}

/** A request as its guardian sees it: their own children, their own confirmation and no one else's. */
export interface AckMine {
  id: string;
  title: string;
  body: string;
  rule: AckRule;
  authorName: string;
  createdAt: string;
  children: Array<{ id: string; name: string }>;
  ackedAt: string | null;
}

export interface AckConfirmed {
  ackedAt: string;
}

// ---------------------------------------------------------------------------
// The request form
// ---------------------------------------------------------------------------

/** The form's fields as typed. */
export interface AckForm {
  title: string;
  body: string;
  rule: AckRule;
  studentIds: string[];
}

/** ANY ("räcker att en vårdnadshavare bekräftar") is the common case; the sender may change it. */
export function emptyAckForm(): AckForm {
  return { title: "", body: "", rule: "ANY", studentIds: [] };
}

export type FormProblem = "title" | "titleLong" | "body" | "bodyLong" | "pupils" | "pupilsMany" | "nobody";

/**
 * What stops the form from being sent, in the order the fields come. The
 * gateway trims the title and the text and counts them after, so this does
 * too. "nobody": pupils are chosen but none of them has a guardian to ask.
 */
export function formProblems(form: AckForm, pupils: readonly AckPupilChoice[]): FormProblem[] {
  const problems: FormProblem[] = [];
  const title = form.title.trim().length;
  const body = form.body.trim().length;
  if (title === 0) problems.push("title");
  else if (title > TITLE_MAX) problems.push("titleLong");
  if (body === 0) problems.push("body");
  else if (body > BODY_MAX) problems.push("bodyLong");
  if (form.studentIds.length === 0) problems.push("pupils");
  else if (form.studentIds.length > PUPILS_MAX) problems.push("pupilsMany");
  else if (guardiansOf(pupils, form.studentIds) === 0) problems.push("nobody");
  return problems;
}

/** What POST / takes: the title and the text trimmed, each pupil once. */
export function bodyOfForm(form: AckForm): { title: string; body: string; rule: AckRule; studentIds: string[] } {
  return { title: form.title.trim(), body: form.body.trim(), rule: form.rule, studentIds: [...new Set(form.studentIds)] };
}

const chosen = (pupils: readonly AckPupilChoice[], ids: readonly string[]): AckPupilChoice[] => {
  const set = new Set(ids);
  return pupils.filter((pupil) => set.has(pupil.id));
};

/** The guardians who would be asked, over the chosen pupils. */
export function guardiansOf(pupils: readonly AckPupilChoice[], ids: readonly string[]): number {
  return chosen(pupils, ids).reduce((sum, pupil) => sum + pupil.guardians, 0);
}

/** The chosen pupils nobody can be asked about: they are left out of the request. */
export function withoutGuardianOf(pupils: readonly AckPupilChoice[], ids: readonly string[]): AckPupilChoice[] {
  return chosen(pupils, ids).filter((pupil) => pupil.guardians === 0);
}

/** The names behind ids the gateway named, in the order the pupils list has them. */
export function namesOf(pupils: readonly AckPupilChoice[], ids: readonly string[]): string[] {
  return chosen(pupils, ids).map((pupil) => pupil.name);
}

/** Does a pupil answer a search? A name or a class, in any case. */
export function matchesPupil(pupil: Pick<AckPupilChoice, "name" | "className">, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("sv");
  if (needle === "") return true;
  return (
    pupil.name.toLocaleLowerCase("sv").includes(needle) || (pupil.className ?? "").toLocaleLowerCase("sv").includes(needle)
  );
}

/** The classes the pupils are in, once each, in the order a reader looks for them (7A before 7B before 10A). */
export function classesOf(pupils: readonly Pick<AckPupilChoice, "className">[]): string[] {
  const names = new Set<string>();
  for (const pupil of pupils) if (pupil.className) names.add(pupil.className);
  return [...names].sort((a, b) => a.localeCompare(b, "sv", { numeric: true }));
}

/** The pupils a search and a class show, in the list's order. An empty class is every class. */
export function shownPupils(pupils: readonly AckPupilChoice[], query: string, className: string): AckPupilChoice[] {
  return pupils.filter((pupil) => (className === "" || pupil.className === className) && matchesPupil(pupil, query));
}

/** `ids` chosen or not chosen, the rest as they were. Each id once, in the order they were chosen. */
export function setChosen(current: readonly string[], ids: readonly string[], on: boolean): string[] {
  if (on) return [...new Set([...current, ...ids])];
  const drop = new Set(ids);
  return current.filter((id) => !drop.has(id));
}

// ---------------------------------------------------------------------------
// Reading a request
// ---------------------------------------------------------------------------

/** How many of the pupils in a request are met. */
export function metIn(detail: Pick<AckDetail, "pupils">): number {
  return detail.pupils.filter((pupil) => pupil.met).length;
}

/**
 * Where a pupil stands: met; waiting for a guardian who can still confirm; or
 * nobody (every guardian's custody has ended and none confirmed), which the
 * reader should see as such and not as a wait that will end.
 */
export function pupilStanding(pupil: Pick<AckPupilRow, "met" | "guardians">): "MET" | "WAITING" | "NOBODY" {
  if (pupil.met) return "MET";
  return pupil.guardians.some((guardian) => guardian.state === "WAITING") ? "WAITING" : "NOBODY";
}

/** The pupils still to hear from, for the reader who chases. */
export function pupilsNotMet<T extends Pick<AckPupilRow, "met">>(pupils: readonly T[]): T[] {
  return pupils.filter((pupil) => !pupil.met);
}

/**
 * What a list row says of the reminder: sent; due later; not needed because
 * nobody waits any more; or none (the school sets no reminder).
 */
export function reminderOf(item: Pick<AckListItem, "reminderSent" | "remindAt" | "waiting">): "SENT" | "DUE" | "NOT_NEEDED" | "NONE" {
  if (item.reminderSent) return "SENT";
  if (item.remindAt === null) return "NONE";
  return item.waiting === 0 ? "NOT_NEEDED" : "DUE";
}

/** The request's own pupils all met? A request with no pupil the reader sees is not "done". */
export function isDone(item: Pick<AckListItem, "pupils" | "met">): boolean {
  return item.pupils > 0 && item.met === item.pupils;
}

// ---------------------------------------------------------------------------
// The guardian's list
// ---------------------------------------------------------------------------

/** How many of the guardian's messages still wait for them. */
export function waitingFor(mine: readonly Pick<AckMine, "ackedAt">[]): number {
  return mine.filter((one) => one.ackedAt === null).length;
}

/** The list with a confirmation written into one request, as the gateway answered it. */
export function withConfirmed<T extends Pick<AckMine, "id" | "ackedAt">>(mine: readonly T[], id: string, ackedAt: string): T[] {
  return mine.map((one) => (one.id === id ? { ...one, ackedAt: one.ackedAt ?? ackedAt } : one));
}
