import type { ConsentCounts, ConsentKind, ConsentState } from './consent-state';

/**
 * Checklistor (F5): what the gateway answers. Days are ISO days (yyyy-mm-dd) in the school's zone, instants ISO
 * strings. A pupil's name is the staff's to read already (they read Users), and is named on the screen whoever the
 * school has marked as having a protected identity; what is printed is the web's, and holds the marked out
 * (web/lib/people-files.ts).
 */

export interface TemplateView {
  id: string;
  subjectId: string | null;
  subjectName: string | null;
  title: string;
  description: string | null;
  active: boolean;
}

/** A group the caller can look at the proofs of; canTick when it is one of the caller's own groups or lessons (an administrator's: all). */
export interface GroupChoice {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  /** The subjects the caller teaches it, for a teacher. */
  subjects: string[];
  canTick: boolean;
  /** The caller may make a consent list for it: a class, and for a teacher one they have a mentee in (an administrator under Drift: any). */
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
  /** The caller may void it: the one who wrote it, or an administrator under Drift. */
  canVoid: boolean;
}

export interface ProofRow {
  studentId: string;
  name: string;
  className: string | null;
  /** The caller may tick this pupil (they teach them; an administrator under Drift: all). */
  canTick: boolean;
  /** The valid proofs, the latest instruction first. */
  proofs: ProofView[];
}

export interface ProofRoster {
  template: TemplateView;
  group: { id: string; name: string; kind: 'CLASS' | 'TEACHING_GROUP' };
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
  source: 'REGISTERED' | 'KVITTENS';
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
  /** The caller may write an answer for this pupil (their mentee; an administrator under Drift: all). */
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
  /** The caller may close the list (its maker, an administrator under Drift) and write to it. */
  canClose: boolean;
  rows: ConsentRow[];
  /** For paper only: the pupils with a protected identity the sheet leaves out (the counts above are of the rows kept). Always 0 on the screen. */
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

export interface PupilCard {
  student: { id: string; name: string; className: string | null };
  /** Every proof, voided ones too, with why. */
  proofs: Array<ProofView & { templateId: string; templateTitle: string; subjectName: string | null; voidedAt: string | null; voidedByName: string | null; voidReason: string | null }>;
  consents: Array<{ listId: string; title: string; className: string; closed: boolean; state: ConsentState; entry: ConsentEntryView | null }>;
}

export interface ChecklistSettings {
  /** The school has Kvittens on: "Fråga i appen" is offered. */
  kvittens: boolean;
}
