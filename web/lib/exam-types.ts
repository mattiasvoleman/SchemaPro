/**
 * Provplanering: a MIRROR of what the gateway answers
 * (src/exams/exams.controller.ts, exams.service.ts, exam-planner.service.ts and
 * dto/exam.dto.ts), written by hand as the other mirrors are.
 *
 * Kept apart from lib/types.ts so that only /admin/activities/exams carries it. Nothing
 * here is code.
 */

/** GET and PUT /api/v1/exams/settings: the school's decisions. */
export interface ExamSettings {
  /** The planner is off until the school turns it on; exams and rooms can be entered either way. */
  enabled: boolean;
  maxPerClassPerDay: number;
  maxPerClassPerWeek: number;
  writersPerInvigilator: number;
  turnoverMinutes: number;
  replacementSubject: { id: string; name: string } | null;
}

/** PUT /exams/settings (ExamSettingsDto). */
export interface ExamSettingsInput {
  enabled: boolean;
  maxPerClassPerDay: number;
  maxPerClassPerWeek: number;
  writersPerInvigilator: number;
  turnoverMinutes: number;
  /** A subject that does not count toward the timplan; null leaves it unchosen. */
  replacementSubjectId: string | null;
}

/** GET /exams/rooms: every room of the school. */
export interface ExamRoom {
  roomId: string;
  name: string;
  code: string | null;
  capacity: number | null;
  /** Null: not a skrivsal. */
  seats: number | null;
}

export type ExamWindowKind = "WEEK" | "FIXED";

export interface ExamSitting {
  roomId: string;
  roomName: string;
  writers: number;
  /** A teacher with a protected identity is on no list. */
  invigilators: Array<{ teacherId: string; name: string }>;
}

/** The plan of a laid exam; null on an exam that is not laid. */
export interface ExamPlan {
  activityId: string;
  date: string;
  start: string;
  end: string;
  sittings: ExamSitting[];
}

/** Why the last run left an exam out: a code, with the figures its sentence needs. */
export interface ExamReason {
  code: string;
  params: Record<string, string | number>;
  at: string;
}

/** GET /exams?academicYearId=. */
export interface Exam {
  id: string;
  academicYearId: string;
  subjectId: string;
  subjectName: string;
  name: string;
  lengthMinutes: number;
  writers: number;
  windowKind: ExamWindowKind;
  windowFrom: string;
  windowTo: string;
  fixedStart: string | null;
  earliestStart: string | null;
  latestEnd: string | null;
  groups: Array<{ id: string; name: string }>;
  /** The exam's updatedAt: a proposal carries it back so that an exam changed since is not applied. */
  version: string;
  plan: ExamPlan | null;
  lastReason: ExamReason | null;
}

/** PATCH /exams/:id (ExamDescriptionDto): the whole description again. */
export interface ExamInput {
  subjectId: string;
  name: string;
  lengthMinutes: number;
  writers: number;
  windowKind: ExamWindowKind;
  windowFrom: string;
  windowTo: string;
  /** FIXED only. */
  fixedStart?: string;
  /** WEEK only. */
  earliestStart?: string;
  /** WEEK only. */
  latestEnd?: string;
  groupIds: string[];
}

/** POST /exams (CreateExamDto). */
export interface CreateExamInput extends ExamInput {
  academicYearId: string;
}

/** GET /exams/counter?academicYearId=: the watch each teacher has this year. */
export interface InvigilatorCounterRow {
  teacherId: string;
  name: string;
  passes: number;
  minutes: number;
}

export interface ProposedRoom {
  roomId: string;
  roomName: string;
  writers: number;
  /** The classes that sit there, by name. */
  classes: string[];
  invigilators: Array<{ teacherId: string; name: string }>;
}

export interface ProposedExam {
  examId: string;
  name: string;
  /** The exam's version as read: the apply sends it back. */
  version: string;
  date: string;
  start: string;
  end: string;
  /** Lesson minutes of other subjects the time takes away. */
  loss: number;
  rooms: ProposedRoom[];
}

export interface UnplacedExam {
  examId: string;
  name: string;
  reason: string;
  params: Record<string, string | number>;
  /** The engine's English, or null when the gateway gave the reason. */
  message: string | null;
}

export interface CounterChange {
  teacherId: string;
  name: string;
  passes: number;
  minutes: number;
  addedPasses: number;
  addedMinutes: number;
}

/** POST /exams/plan: nothing is laid by it. */
export interface ExamProposal {
  /** NOTHING_TO_PLAN when no exam was left to ask about. */
  status: "OPTIMAL" | "FEASIBLE" | "NOTHING_TO_PLAN";
  placed: ProposedExam[];
  unplaced: UnplacedExam[];
  counter: CounterChange[];
  metrics: {
    placed: number;
    unplaced: number;
    loss: number;
    roomsUsed: number;
    invigilatorPasses: number;
    maxLoad: number;
    minLoad: number;
    solveSeconds: number;
  } | null;
}

/** One placed exam of POST /exams/plan/apply (ApplyItemDto), exactly as the proposal gave it. */
export interface ApplyItem {
  examId: string;
  examVersion: string;
  date: string;
  start: string;
  rooms: Array<{ roomId: string; writers: number; teacherIds: string[] }>;
}

export interface ApplyInput {
  academicYearId: string;
  items: ApplyItem[];
  /** One notice per person an exam touches. The gateway's default is true. */
  notify?: boolean;
}

export interface ApplyOutcome {
  examId: string;
  ok: boolean;
  activityId?: string;
  /** Not ok: EXAM_STALE, EXAM_IS_PLANNED, EXAM_PLACEMENT, EXAM_ROOM_TAKEN, EXAM_PLANNING_OFF, EXAM_APPLY_FAILED. */
  code?: string;
  /** Not ok: the gateway's Swedish sentence. */
  message?: string;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  applied: number;
  failed: number;
}
