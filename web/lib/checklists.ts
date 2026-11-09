/**
 * Checklistor (F5), the web's side of the vocabulary, the shapes and the forms
 * (/admin/checklists and /teacher/checklists): instruction proofs
 * (instruktionsbevis) and consent lists per class (samtyckeslistor).
 *
 * The gateway's src/checklists/checklists.ts says the same bounds and codes,
 * src/checklists/checklists-views.ts the same shapes and consent-state.ts the
 * same states; checklists.test.ts reads them and fails when this file drifts.
 * Free of React and of imports besides Kvittens's vocabulary (lib/ack.ts, itself
 * free of imports), so a test can read it as it is.
 *
 * WHO IS DONE and WHAT A CONSENT IS NOW are the gateway's say (consent-state.ts
 * there is the one definition): nothing here works out whether a pupil has
 * consented. What this file does is turn rows into what a person reads and what
 * a form sends.
 */

import {
  ACK_DISABLED,
  ACK_NOT_YOUR_PUPIL,
  ACK_NO_GUARDIANS,
  ACK_TOO_MANY_RECIPIENTS,
  ACK_TOO_MANY_REQUESTS,
  ACK_UNKNOWN_PUPIL,
  setChosen,
} from "@/lib/ack";

export { setChosen };

// ---------------------------------------------------------------------------
// Bounds and codes (src/checklists/checklists.ts)
// ---------------------------------------------------------------------------

/** The gateway's routes (src/checklists/checklists.controller.ts). */
export const CHECKLISTS_BASE = "/api/v1/checklists";

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
/** A proof's note. */
export const PROOF_NOTE_MAX = 500;
/** An answer's note, and who gave it. */
export const ENTRY_NOTE_MAX = 300;
export const GIVEN_BY_MAX = 120;
export const REASON_MAX = 300;
/** The text of a list: the request to the guardians is this and one sentence more, which must fit Kvittens's 2 000. */
export const LIST_BODY_MAX = 1700;
/** Pupils in one tick or one answer, and in one ask. */
export const TICK_MAX = 300;
export const ASK_MAX = 2000;

export const CHECKLIST_NOT_FOUND = "CHECKLIST_NOT_FOUND";
export const CHECKLIST_NOT_STAFF = "CHECKLIST_NOT_STAFF";
export const CHECKLIST_NOT_YOUR_PUPIL = "CHECKLIST_NOT_YOUR_PUPIL";
export const CHECKLIST_UNKNOWN_PUPIL = "CHECKLIST_UNKNOWN_PUPIL";
export const CHECKLIST_TEMPLATE_RETIRED = "CHECKLIST_TEMPLATE_RETIRED";
export const CHECKLIST_TEMPLATE_EXISTS = "CHECKLIST_TEMPLATE_EXISTS";
export const CHECKLIST_UNKNOWN_SUBJECT = "CHECKLIST_UNKNOWN_SUBJECT";
export const CHECKLIST_DATE_IN_THE_FUTURE = "CHECKLIST_DATE_IN_THE_FUTURE";
export const CHECKLIST_DATE_INVALID = "CHECKLIST_DATE_INVALID";
export const CONSENT_ASK_NEEDS_ALL = "CONSENT_ASK_NEEDS_ALL";
export const CONSENT_ASK_ALREADY_ANSWERED = "CONSENT_ASK_ALREADY_ANSWERED";
export const CHECKLIST_INSTRUCTOR_IS_NOT_STAFF = "CHECKLIST_INSTRUCTOR_IS_NOT_STAFF";
export const CHECKLIST_REASON_NEEDED = "CHECKLIST_REASON_NEEDED";
export const CONSENT_LIST_CLOSED = "CONSENT_LIST_CLOSED";
export const CONSENT_LIST_EXISTS = "CONSENT_LIST_EXISTS";
export const CONSENT_NOT_A_CLASS = "CONSENT_NOT_A_CLASS";
export const CONSENT_NOT_YOUR_CLASS = "CONSENT_NOT_YOUR_CLASS";
export const CONSENT_NOBODY_TO_ASK = "CONSENT_NOBODY_TO_ASK";

/** The gateway's own codes, the ones src/checklists/checklists.ts names. */
export const CHECKLIST_CODES = [
  CHECKLIST_NOT_FOUND,
  CHECKLIST_NOT_STAFF,
  CHECKLIST_NOT_YOUR_PUPIL,
  CHECKLIST_UNKNOWN_PUPIL,
  CHECKLIST_TEMPLATE_RETIRED,
  CHECKLIST_TEMPLATE_EXISTS,
  CHECKLIST_UNKNOWN_SUBJECT,
  CHECKLIST_DATE_IN_THE_FUTURE,
  CHECKLIST_DATE_INVALID,
  CONSENT_ASK_NEEDS_ALL,
  CONSENT_ASK_ALREADY_ANSWERED,
  CHECKLIST_INSTRUCTOR_IS_NOT_STAFF,
  CHECKLIST_REASON_NEEDED,
  CONSENT_LIST_CLOSED,
  CONSENT_LIST_EXISTS,
  CONSENT_NOT_A_CLASS,
  CONSENT_NOT_YOUR_CLASS,
  CONSENT_NOBODY_TO_ASK,
] as const;

/**
 * Every refusal that has a sentence of its own in `checklists.refusal`: the
 * gateway's, and the ones Kvittens answers an ask with (the ask goes through
 * its service). A status alone cannot tell two 409s apart, so the code is the
 * key. Another 429 is the throttler's, with only its English words.
 */
export const REFUSALS = [
  ...CHECKLIST_CODES,
  ACK_DISABLED,
  ACK_UNKNOWN_PUPIL,
  ACK_NOT_YOUR_PUPIL,
  ACK_NO_GUARDIANS,
  ACK_TOO_MANY_REQUESTS,
  ACK_TOO_MANY_RECIPIENTS,
] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The sentence's key for an error, or null when the gateway sent nothing we have a sentence for. */
export function refusalOf(error: unknown): Refusal | "THROTTLED" | null {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && (REFUSALS as readonly string[]).includes(code)) return code as Refusal;
  return status === 429 ? "THROTTLED" : null;
}

// ---------------------------------------------------------------------------
// What the gateway answers (src/checklists/checklists-views.ts)
// ---------------------------------------------------------------------------

/** What a consent is now, in the order the screen lists them. */
export const CONSENT_STATES = ["GRANTED", "DECLINED", "WITHDRAWN", "ASKED", "MISSING"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

/** What a person can write down: the three answers. */
export const CONSENT_KINDS = ["GRANTED", "DECLINED", "WITHDRAWN"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ConsentCounts {
  pupils: number;
  granted: number;
  declined: number;
  withdrawn: number;
  asked: number;
  missing: number;
}

export type GroupKind = "CLASS" | "TEACHING_GROUP";

export interface TemplateView {
  id: string;
  subjectId: string | null;
  subjectName: string | null;
  title: string;
  description: string | null;
  active: boolean;
}

/** A group the reader can look at the proofs of; canTick when it is one of their own groups or lessons (an administrator's: all). */
export interface GroupChoice {
  id: string;
  name: string;
  kind: GroupKind;
  /** The subjects the reader teaches it, for a teacher. */
  subjects: string[];
  canTick: boolean;
  /** The reader may make a consent list for it: a class, and for a teacher one they have a mentee in (an administrator under Drift: any). */
  canMakeList: boolean;
}

export interface Instructor {
  id: string;
  name: string;
}

export interface ProofView {
  id: string;
  instructedOn: string;
  instructorId: string | null;
  instructorName: string | null;
  recordedByName: string | null;
  recordedAt: string;
  note: string | null;
  /** The reader may void it: the one who wrote it, or an administrator under Drift. */
  canVoid: boolean;
}

export interface ProofRow {
  studentId: string;
  name: string;
  className: string | null;
  /** The reader may tick this pupil (they teach them; an administrator under Drift: all). */
  canTick: boolean;
  /** The valid proofs, the latest instruction first. */
  proofs: ProofView[];
}

export interface ProofRoster {
  template: TemplateView;
  group: { id: string; name: string; kind: GroupKind };
  rows: ProofRow[];
  /** Pupils with at least one valid proof, and all of them (of those in `rows`). */
  done: number;
  pupils: number;
  /** For paper only: the pupils with a protected identity the sheet leaves out. Always 0 on the screen, which names every pupil the reader may see. */
  heldOut: number;
}

export interface ProofsWritten {
  written: number;
  /** Pupils who already had a proof for the same day. */
  already: number;
}

export interface ProofVoided {
  voidedAt: string;
}

export interface ConsentEntryView {
  id: string;
  kind: ConsentKind;
  source: "REGISTERED" | "KVITTENS";
  givenOn: string;
  givenBy: string | null;
  note: string | null;
  /** Null for a confirmation in the app. */
  recordedByName: string | null;
  recordedAt: string;
}

export interface ConsentAskView {
  askedAt: string;
  guardiansAsked: number;
  guardiansWaiting: number;
}

export interface ConsentRow {
  studentId: string;
  name: string;
  className: string | null;
  /** Still in the list's class (after the rollover the class is empty, and the list is what it was). */
  inClass: boolean;
  state: ConsentState;
  /** The answer that decides, when there is one. */
  entry: ConsentEntryView | null;
  /** Every answer, the latest first. */
  history: ConsentEntryView[];
  ask: ConsentAskView | null;
  /** The reader may write an answer for this pupil (their mentee; an administrator under Drift: all). */
  canWrite: boolean;
}

export interface ConsentListItem {
  id: string;
  title: string;
  classId: string | null;
  className: string;
  createdAt: string;
  createdByName: string | null;
  closedAt: string | null;
  counts: ConsentCounts;
}

export interface ConsentDetail {
  list: ConsentListItem & { body: string };
  /** The school has Kvittens on, so a request can be sent to the guardians. */
  kvittens: boolean;
  /** The reader may close the list (its maker, an administrator under Drift) and write to it. */
  canClose: boolean;
  rows: ConsentRow[];
  /** For paper only: the pupils with a protected identity the sheet leaves out (the counts are of the rows kept). Always 0 on the screen. */
  heldOut: number;
}

export interface ConsentWritten {
  written: number;
}

export interface ConsentAsked {
  requestId: string;
  pupils: number;
  guardians: number;
  withoutGuardian: string[];
}

export interface ConsentClosed {
  closedAt: string;
}

export interface PupilProof extends ProofView {
  templateId: string;
  templateTitle: string;
  subjectName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface PupilConsent {
  listId: string;
  title: string;
  className: string;
  closed: boolean;
  state: ConsentState;
  entry: ConsentEntryView | null;
}

export interface PupilCard {
  student: { id: string; name: string; className: string | null };
  /** Every proof, voided ones too, with why. */
  proofs: PupilProof[];
  consents: PupilConsent[];
}

export interface ChecklistSettings {
  /** The school has Kvittens on: "Fråga i appen" is offered. */
  kvittens: boolean;
}

export interface SubjectChoice {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Instruktionsbevis: templates
// ---------------------------------------------------------------------------

/** "Slöjd – Maskinerna", or the title alone for a template with no subject: how a select spells one. */
export function templateLabel(template: Pick<TemplateView, "title" | "subjectName">): string {
  return template.subjectName ? `${template.subjectName} – ${template.title}` : template.title;
}

/** The templates the school ticks in: the active ones. */
export function activeTemplates<T extends Pick<TemplateView, "active">>(templates: readonly T[]): T[] {
  return templates.filter((template) => template.active);
}

export interface TemplateForm {
  title: string;
  description: string;
  /** "" is no subject. */
  subjectId: string;
}

export function emptyTemplateForm(): TemplateForm {
  return { title: "", description: "", subjectId: "" };
}

export function formOfTemplate(template: TemplateView): TemplateForm {
  return { title: template.title, description: template.description ?? "", subjectId: template.subjectId ?? "" };
}

export type TemplateProblem = "title" | "titleLong" | "descriptionLong";

/** What stops a template from being saved, in the order the fields come. The gateway trims and counts after. */
export function templateProblems(form: TemplateForm): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const title = form.title.trim().length;
  if (title === 0) problems.push("title");
  else if (title > TITLE_MAX) problems.push("titleLong");
  if (form.description.trim().length > DESCRIPTION_MAX) problems.push("descriptionLong");
  return problems;
}

/** What POST /templates takes: the text trimmed, and what is left blank left out. */
export function templateCreateBody(form: TemplateForm): { title: string; description?: string; subjectId?: string } {
  const description = form.description.trim();
  return {
    title: form.title.trim(),
    ...(description ? { description } : {}),
    ...(form.subjectId ? { subjectId: form.subjectId } : {}),
  };
}

/**
 * What PATCH /templates/:id takes: only what changed. A description or a subject taken away is `null`, which the
 * gateway reads as clearing it; an empty patch (nothing changed) is `null` here, and nothing is sent.
 */
export function templatePatch(
  template: TemplateView,
  form: TemplateForm,
): { title?: string; description?: string | null; subjectId?: string | null } | null {
  const patch: { title?: string; description?: string | null; subjectId?: string | null } = {};
  const title = form.title.trim();
  if (title !== template.title) patch.title = title;
  const description = form.description.trim();
  if (description !== (template.description ?? "")) patch.description = description === "" ? null : description;
  if (form.subjectId !== (template.subjectId ?? "")) patch.subjectId = form.subjectId === "" ? null : form.subjectId;
  return Object.keys(patch).length === 0 ? null : patch;
}

// ---------------------------------------------------------------------------
// Instruktionsbevis: the roster and the tick
// ---------------------------------------------------------------------------

/** "7A" or "7A · Matematik, Fysik": the group, and what the reader teaches it. */
export function groupLabel(group: Pick<GroupChoice, "name" | "subjects">): string {
  return group.subjects.length > 0 ? `${group.name} · ${group.subjects.join(", ")}` : group.name;
}

/** The classes of the groups: what a list can be filtered by. */
export function classesOfGroups(groups: readonly GroupChoice[]): GroupChoice[] {
  return groups.filter((group) => group.kind === "CLASS");
}

/** The classes a list can be made for: the gateway's say per group (a teacher's mentored classes, an administrator's all, a läsare's none). */
export function classesForNewList(groups: readonly GroupChoice[]): GroupChoice[] {
  return classesOfGroups(groups).filter((group) => group.canMakeList);
}

/** The latest valid instruction, which is how a row reads. */
export function latestProof(row: Pick<ProofRow, "proofs">): ProofView | null {
  return row.proofs[0] ?? null;
}

/** How many earlier valid instructions a row has besides the latest: the "+2 tidigare". */
export function earlierProofs(row: Pick<ProofRow, "proofs">): number {
  return Math.max(0, row.proofs.length - 1);
}

/** Who gave an instruction: the instructor the writer named, else the writer. */
export function instructorOf(proof: Pick<ProofView, "instructorName" | "recordedByName">): string | null {
  return proof.instructorName ?? proof.recordedByName;
}

export function tickableIds(rows: readonly ProofRow[]): string[] {
  return rows.filter((row) => row.canTick).map((row) => row.studentId);
}

/** The pupils the reader may tick who have no valid proof: "Välj alla som saknas". */
export function missingIds(rows: readonly ProofRow[]): string[] {
  return rows.filter((row) => row.canTick && row.proofs.length === 0).map((row) => row.studentId);
}

/** The chosen pupils that are still on the roster (a read again may have taken one off it). */
export function stillOnRoster(chosen: readonly string[], rows: readonly ProofRow[]): string[] {
  const known = new Set(tickableIds(rows));
  return chosen.filter((id) => known.has(id));
}

export interface TickForm {
  studentIds: string[];
  /** yyyy-mm-dd; "" is not a day. */
  instructedOn: string;
  /** "" is nobody chosen: the signed-in person gave it. */
  instructorId: string;
  note: string;
}

export type TickProblem = "pupils" | "pupilsMany" | "date" | "dateFuture" | "noteLong";

/** The day is not after `today` (yyyy-mm-dd: the strings order as the days do). */
export const isFuture = (day: string, today: string): boolean => day > today;

export function tickProblems(form: TickForm, today: string): TickProblem[] {
  const problems: TickProblem[] = [];
  if (form.studentIds.length === 0) problems.push("pupils");
  else if (form.studentIds.length > TICK_MAX) problems.push("pupilsMany");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.instructedOn)) problems.push("date");
  else if (isFuture(form.instructedOn, today)) problems.push("dateFuture");
  if (form.note.trim().length > PROOF_NOTE_MAX) problems.push("noteLong");
  return problems;
}

/**
 * What POST /proofs takes. A day that is today is left out, so the gateway's
 * today (the school's clock) is the day, and not the browser's; nobody chosen
 * as the instructor is left out, so the writer is.
 */
export function tickBody(
  templateId: string,
  form: TickForm,
  today: string,
): { templateId: string; studentIds: string[]; instructedOn?: string; instructorId?: string; note?: string } {
  const note = form.note.trim();
  return {
    templateId,
    studentIds: [...new Set(form.studentIds)],
    ...(form.instructedOn !== today ? { instructedOn: form.instructedOn } : {}),
    ...(form.instructorId ? { instructorId: form.instructorId } : {}),
    ...(note ? { note } : {}),
  };
}

export type VoidProblem = "reason" | "reasonLong";

export function voidProblem(reason: string): VoidProblem | null {
  const length = reason.trim().length;
  if (length === 0) return "reason";
  return length > REASON_MAX ? "reasonLong" : null;
}

// ---------------------------------------------------------------------------
// Samtycken
// ---------------------------------------------------------------------------

export interface ListForm {
  classId: string;
  title: string;
  body: string;
}

export function emptyListForm(): ListForm {
  return { classId: "", title: "", body: "" };
}

export type ListProblem = "class" | "title" | "titleLong" | "body" | "bodyLong";

export function listProblems(form: ListForm): ListProblem[] {
  const problems: ListProblem[] = [];
  if (form.classId === "") problems.push("class");
  const title = form.title.trim().length;
  if (title === 0) problems.push("title");
  else if (title > TITLE_MAX) problems.push("titleLong");
  const body = form.body.trim().length;
  if (body === 0) problems.push("body");
  else if (body > LIST_BODY_MAX) problems.push("bodyLong");
  return problems;
}

export function listBody(form: ListForm): { classId: string; title: string; body: string } {
  return { classId: form.classId, title: form.title.trim(), body: form.body.trim() };
}

/** The numbers of a list in the order a reader scans them, with the state each stands for. */
export const COUNT_OF_STATE: Readonly<Record<ConsentState, keyof Omit<ConsentCounts, "pupils">>> = {
  GRANTED: "granted",
  DECLINED: "declined",
  WITHDRAWN: "withdrawn",
  ASKED: "asked",
  MISSING: "missing",
};

export function countOf(counts: ConsentCounts, state: ConsentState): number {
  return counts[COUNT_OF_STATE[state]];
}

/** The bar's segments: each state's share of the pupils, in percent; none for a list with no pupil or a state with none. */
export function sharesOf(counts: ConsentCounts): Array<{ state: ConsentState; count: number; percent: number }> {
  if (counts.pupils <= 0) return [];
  return CONSENT_STATES.map((state) => ({ state, count: countOf(counts, state), percent: (countOf(counts, state) / counts.pupils) * 100 })).filter(
    (share) => share.count > 0,
  );
}

export interface EntryForm {
  kind: ConsentKind;
  /** yyyy-mm-dd; "" is not a day. */
  givenOn: string;
  givenBy: string;
  note: string;
}

export function emptyEntryForm(kind: ConsentKind, today: string): EntryForm {
  return { kind, givenOn: today, givenBy: "", note: "" };
}

export type EntryProblem = "pupils" | "pupilsMany" | "date" | "dateFuture" | "givenByLong" | "noteLong";

export function entryProblems(form: EntryForm, studentIds: readonly string[], today: string): EntryProblem[] {
  const problems: EntryProblem[] = [];
  if (studentIds.length === 0) problems.push("pupils");
  else if (studentIds.length > TICK_MAX) problems.push("pupilsMany");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.givenOn)) problems.push("date");
  else if (isFuture(form.givenOn, today)) problems.push("dateFuture");
  if (form.givenBy.trim().length > GIVEN_BY_MAX) problems.push("givenByLong");
  if (form.note.trim().length > ENTRY_NOTE_MAX) problems.push("noteLong");
  return problems;
}

/** What POST /entries takes. A day that is today is left out (the school's clock decides it); blank text is left out. */
export function entryBody(
  form: EntryForm,
  studentIds: readonly string[],
  today: string,
): { studentIds: string[]; kind: ConsentKind; givenOn?: string; givenBy?: string; note?: string } {
  const givenBy = form.givenBy.trim();
  const note = form.note.trim();
  return {
    studentIds: [...new Set(studentIds)],
    kind: form.kind,
    ...(form.givenOn !== today ? { givenOn: form.givenOn } : {}),
    ...(givenBy ? { givenBy } : {}),
    ...(note ? { note } : {}),
  };
}

/** The rows the reader may write for: the selection can only hold these. */
export function writableIds(rows: readonly ConsentRow[]): string[] {
  return rows.filter((row) => row.canWrite).map((row) => row.studentId);
}

/** The pupils with no answer the reader may ask about and write for: "Fråga alla som saknar svar". */
export function unansweredIds(rows: readonly ConsentRow[]): string[] {
  return rows.filter((row) => row.canWrite && row.inClass && row.state === "MISSING").map((row) => row.studentId);
}

/** The chosen pupils that are still writable (a read again may have closed the list or moved a pupil). */
export function stillWritable(chosen: readonly string[], rows: readonly ConsentRow[]): string[] {
  const known = new Set(writableIds(rows));
  return chosen.filter((id) => known.has(id));
}

/** What POST /ask takes: the chosen pupils, or nothing for every pupil with no answer. */
export function askBody(chosen: readonly string[]): { studentIds?: string[] } {
  return chosen.length === 0 ? {} : { studentIds: [...new Set(chosen)] };
}

/** The names behind the ids the gateway left out of an ask (no guardian to ask), in the list's order. */
export function namesOfIds(rows: readonly Pick<ConsentRow, "studentId" | "name">[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return rows.filter((row) => wanted.has(row.studentId)).map((row) => row.name);
}
