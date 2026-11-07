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
/**
 * All three 429: an eleventh request in an hour from one sender, more receipts in a day than the sender's own
 * share (8 000 for an administrator, 2 000 for a teacher), more than 20 000 receipts in a day for one school.
 */
export const ACK_TOO_MANY_REQUESTS = "ACK_TOO_MANY_REQUESTS";
export const ACK_SENDER_DAY_LIMIT = "ACK_SENDER_DAY_LIMIT";
export const ACK_TOO_MANY_RECIPIENTS = "ACK_TOO_MANY_RECIPIENTS";
/** 403 on stopping a reminder: the reader neither wrote the request nor administers the school. */
export const ACK_NOT_STAFF = "ACK_NOT_STAFF";

/** The refusals of a request that have a sentence of their own in the form. */
export const CREATE_REFUSALS = [
  ACK_DISABLED,
  ACK_UNKNOWN_PUPIL,
  ACK_NOT_YOUR_PUPIL,
  ACK_NO_GUARDIANS,
  ACK_TOO_MANY_REQUESTS,
  ACK_SENDER_DAY_LIMIT,
  ACK_TOO_MANY_RECIPIENTS,
] as const;
export type CreateRefusal = (typeof CREATE_REFUSALS)[number];

/** The days the school may wait before the one reminder, in the order a select lists them. */
export const REMIND_DAY_OPTIONS: readonly number[] = Array.from(
  { length: REMIND_DAYS_MAX - REMIND_DAYS_MIN + 1 },
  (_, index) => REMIND_DAYS_MIN + index,
);

// ---------------------------------------------------------------------------
// What the gateway answers (src/ack/ack-views.ts)
// ---------------------------------------------------------------------------

/** A page of a list: the items, and the id to ask for the next page after (null: that was the last). */
export interface AckPage<T> {
  items: T[];
  next: string | null;
}

/**
 * Where a request's one reminder stands: none (the school chose no reminder),
 * scheduled (its time has not come, or the pass has not reached it), written
 * (the notices are in the guardians' inboxes, and that the e-mail and the push
 * were taken is not confirmed: the mail is on its way, or the process stopped
 * with it in its queue, or Resend did not take it; nothing sends it again), or
 * how it ended: sent (the delivery confirmed the e-mail and the push too); not
 * needed (nobody was left to remind when the time came); lapsed (the time had
 * passed more than 30 days before the pass came); stopped (by the author or an
 * administrator); off (Kvittens was off when it fell due).
 */
export const ACK_REMINDER_STATES = ["NONE", "SCHEDULED", "WRITTEN", "SENT", "NOT_NEEDED", "LAPSED", "STOPPED", "OFF"] as const;
export type AckReminderState = (typeof ACK_REMINDER_STATES)[number];

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
  reminder: AckReminderState;
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
  /** When at least one reminder was written to the inboxes; null unless the reminder is WRITTEN or SENT. */
  reminderSentAt: string | null;
  /** When the delivery said the e-mail and the push were taken; null unless the reminder is SENT. */
  reminderMirroredAt: string | null;
  reminder: AckReminderState;
  /** The reader may stop the reminder: it is scheduled, and they wrote the request or administer the school. */
  mayStopReminder: boolean;
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

export interface AckReminderStopped {
  reminder: AckReminderState;
}

/** One use of the day's limits: rows asked for in the last 24 hours, and the most there may be. */
export interface AckUsageLine {
  used: number;
  limit: number;
}

/**
 * Kvittens' use of the day (GET /usage): the school's (an administrator only), the reader's own share, and the
 * senders who have used most (an administrator only). A row is one guardian asked about one pupil.
 */
export interface AckUsage {
  school: AckUsageLine | null;
  mine: AckUsageLine;
  senders: Array<AckUsageLine & { name: string }> | null;
}

/** From this share of a limit the card says it is near. */
export const NEAR_LIMIT = 0.75;

/** The share of a limit that is used, as a fraction in whole percent, rounded down: 99.6 % reads 99 %, never 100 %. */
export function usedShare(line: AckUsageLine): number {
  if (line.limit <= 0) return 1;
  return Math.min(1, Math.floor((line.used * 100) / line.limit) / 100);
}

/** How full a limit is: reached (all of it used), near (from 75 %), or ok. A limit of nothing is reached. */
export function limitState(line: AckUsageLine): "reached" | "near" | "ok" {
  if (line.limit <= 0 || line.used >= line.limit) return "reached";
  return line.used >= line.limit * NEAR_LIMIT ? "near" : "ok";
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
// The pages of a list
// ---------------------------------------------------------------------------

/** The items of the pages loaded so far, in the order the gateway gave them (newest first). */
export function itemsOf<T>(data: { pages: ReadonlyArray<AckPage<T>> } | undefined): T[] {
  return data ? data.pages.flatMap((page) => page.items) : [];
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
 * What a row or a request says of the reminder: the state the gateway answers,
 * except that a scheduled reminder with no time to show (the gateway answers
 * none) is said as none, so that nothing reads "Går" with no date. Whether
 * anyone is left to remind is the gateway's say, not worked out here.
 */
export function reminderOf(item: Pick<AckListItem, "reminder" | "remindAt">): AckReminderState {
  return item.reminder === "SCHEDULED" && item.remindAt === null ? "NONE" : item.reminder;
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

/**
 * The same written into every page loaded, since the request may be on any of
 * them. A page the confirmation does not touch is kept as it is.
 */
export function withConfirmedPages<D extends { pages: ReadonlyArray<AckPage<AckMine>> }>(data: D, id: string, ackedAt: string): D {
  const pages = data.pages.map((page) =>
    page.items.some((one) => one.id === id) ? { ...page, items: withConfirmed(page.items, id, ackedAt) } : page,
  );
  return { ...data, pages };
}
