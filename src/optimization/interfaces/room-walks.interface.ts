/**
 * Anonymous payload for the engine's room optimisation (POST
 * /api/v1/optimize-rooms): the grundschema's lessons with their times fixed,
 * and the rooms they may be moved between.
 *
 * CRITICAL PRIVACY INVARIANT, the same one ai-engine-payload.interface.ts
 * states: every field here is a UUID, a number, an enum or an opaque token.
 * NO PII and no school-authored text — not a name, not a room code, not what
 * the school calls a building. `RoomOptimizationService` builds these objects
 * from scratch rather than forwarding Prisma records, so a column added to a
 * table cannot ride along by accident.
 */
import type {
  AnonymousConstraint,
  AnonymousRoomPreference,
  DayOfWeek,
  RoomTypeKind,
} from './ai-engine-payload.interface';

/** Whose walking between lessons the objective pays for. */
export type Walkers = 'TEACHERS' | 'GROUPS' | 'BOTH';

/**
 * An opaque building token. Buildings are school-authored text ("Hus B",
 * "Annexet"), and the engine needs only to know whether two rooms are in the
 * SAME building — so it gets a token per distinct name, minted per request,
 * exactly as room types are.
 */
export type BuildingKind = string;

export interface WalkRoom {
  id: string;
  capacity: number | null;
  type: RoomTypeKind | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** Null is a building of its own, not a wildcard; see Room.building. */
  building: BuildingKind | null;
  /** Null is unknown, and never counted as a floor change. -5..50. */
  floor: number | null;
}

export interface PlacedLesson {
  id: string;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS. Minutes, not slots: a hand-placed 08:05 must not be refused. */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  /** YYYY-MM-DD, or null for "from the start of the year". */
  startDate: string | null;
  /** YYYY-MM-DD, or null for "until the year ends". */
  endDate: string | null;
  /** Null is a lesson with no room: never given one, but it breaks a walk. */
  roomId: string | null;
  /** False for a LOCKED lesson, which keeps its room. */
  movable: boolean;
  /** Derived by room-eligibility.ts, the generator's own derivation. */
  studentGroupSize: number;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  requiredRoomType: RoomTypeKind | null;
}

export interface OptimizeRoomsRequest {
  requestId: string;
  walkers: Walkers;
  rooms: WalkRoom[];
  lessons: PlacedLesson[];
  roomPreferences: AnonymousRoomPreference[];
  /** Only undated UNAVAILABLE rows about a room are read by the engine. */
  constraints: AnonymousConstraint[];
}

/** One tally of walking, summed over consecutive pairs of lessons. */
export interface Walk {
  roomChanges: number;
  floorChanges: number;
  buildingChanges: number;
}

export interface WalkComparison {
  before: Walk;
  after: Walk;
}

/** One teacher's or one group's walk, sent only when it changed. */
export interface WalkerWalk {
  kind: 'TEACHER' | 'GROUP';
  id: string;
  before: Walk;
  after: Walk;
}

export interface OptimizeRoomsResponse {
  requestId: string;
  /**
   * FEASIBLE also covers "found nothing strictly better in time": the engine
   * then returns the input unchanged, so there is no refusal status at all —
   * the current rooms are always a valid answer.
   */
  status: 'OPTIMAL' | 'FEASIBLE';
  /** Only lessons whose room changed. Anonymous ids, both of them. */
  changes: { lessonId: string; roomId: string }[];
  /** Both tallies always, whichever `walkers` the objective paid for. */
  teachers: WalkComparison;
  groups: WalkComparison;
  missedWishes: { before: number; after: number };
  walkers: WalkerWalk[];
  /** Lessons already sharing a room with an overlapping one; left alone. */
  frozenLessonIds: string[];
}
