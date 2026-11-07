/**
 * The wire format of the engine's exam planner (POST /api/v1/plan-exams,
 * optimization-engine/app/schemas/exams.py). Every field is an opaque id minted
 * for the request, a number or a boolean: not a name, not a date, not a room's
 * code. Dates cross as day indexes and weeks as week indexes, times as the
 * minute of the day, so the engine cannot tell a school from another.
 *
 * Every name below is also listed by hand in the engine's tests/test_exams.py
 * and in exam-engine-contract.spec.ts. The engine forbids fields it does not
 * know: a field one side sends and the other has not heard of is a 422 for the
 * whole proposal, so the contract only ever grows, engine first.
 */

export interface EngineSlot {
  /** A running index of the school day within the request. */
  day: number;
  /** A running index of the ISO week within the request. */
  week: number;
  /** Minute of the day the exam would start. */
  start: number;
  /** Lesson minutes the exam takes away beyond its own subject's. */
  loss: number;
}

/** A resource (room or teacher) that is taken at some of an exam's slots, by index into the exam's slots. */
export interface EngineBlock {
  id: string;
  slots: number[];
}

export interface EngineExam {
  id: string;
  length: number;
  writers: number;
  classes: string[];
  slots: EngineSlot[];
  roomBlocks: EngineBlock[];
  teacherBlocks: EngineBlock[];
  fixed: boolean;
}

export interface EngineRoom {
  id: string;
  seats: number;
}

export interface EngineInvigilator {
  id: string;
  /** Minutes of watch the teacher already has this year: the counter. */
  prior: number;
}

export interface EngineLimits {
  maxPerClassPerDay: number;
  maxPerClassPerWeek: number;
  writersPerInvigilator: number;
  turnoverMinutes: number;
}

export interface EngineWeights {
  loss?: number;
  rooms?: number;
  fairness?: number;
  spread?: number;
}

export interface EngineSearch {
  maxTimeSeconds?: number;
  workers?: number;
  seed?: number;
}

export interface PlanExamsRequest {
  requestId: string;
  exams: EngineExam[];
  rooms: EngineRoom[];
  teachers: EngineInvigilator[];
  limits: EngineLimits;
  weights?: EngineWeights;
  existingDayLoad: Array<{ class: string; day: number; count: number }>;
  existingWeekLoad: Array<{ class: string; week: number; count: number }>;
  search?: EngineSearch;
}

export type PlanExamsStatus = 'OPTIMAL' | 'FEASIBLE';

/** Why the engine left an exam out. The gateway adds a few of its own (see exam-reasons.ts). */
export type EngineReason =
  | 'EXAM_NO_SLOT'
  | 'EXAM_NO_ROOM_SEATS'
  | 'EXAM_NO_INVIGILATORS'
  | 'EXAM_CLASS_DAY_CAP'
  | 'EXAM_CLASS_WEEK_CAP'
  | 'EXAM_CLASS_CLASH'
  | 'EXAM_ROOMS_TAKEN'
  | 'EXAM_INVIGILATORS_TAKEN'
  | 'EXAM_NOT_REACHED';

export interface PlacedRoomOut {
  room: string;
  writers: number;
  invigilators: string[];
}

export interface PlacedExamOut {
  exam: string;
  /** Index into the exam's slots. */
  slot: number;
  rooms: PlacedRoomOut[];
}

export interface UnplacedExamOut {
  exam: string;
  reason: EngineReason;
  params: Record<string, string | number>;
  message: string;
}

export interface PlanExamsResponse {
  requestId: string;
  status: PlanExamsStatus;
  placed: PlacedExamOut[];
  unplaced: UnplacedExamOut[];
  invigilatorMinutes: Array<{ teacher: string; minutes: number }>;
  metrics: {
    placed: number;
    unplaced: number;
    loss: number;
    roomsUsed: number;
    invigilatorPasses: number;
    maxLoad: number;
    minLoad: number;
    solveSeconds: number;
  };
}
