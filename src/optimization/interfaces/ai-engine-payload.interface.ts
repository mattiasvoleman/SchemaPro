/**
 * Anonymous scheduling payload sent to the Python FastAPI / OR-Tools engine.
 *
 * CRITICAL PRIVACY INVARIANT: every field in this file is a UUID or a
 * numeric/enum value. NO PII (names, emails, phone numbers, text labels)
 * must ever appear in any of these types. The `OptimizationProxyService`
 * enforces this by constructing new anonymous objects from scratch rather
 * than forwarding Prisma records.
 */

export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ConstraintKind = 'UNAVAILABLE' | 'PREFERRED_FREE' | 'PREFERRED_BUSY';
/**
 * GRADE_LEVEL is the one target that is not a row in any table: there is no
 * "årskurs 5" to point at, so such a constraint carries a year range instead of
 * a resource id and the engine matches it against each group's own year span.
 * A school holding åk 4-6 free at some hour authors one rule rather than one
 * per class — and the rule then also catches a teaching group whose own
 * gradeLevel is null but whose members are year 5, which a group-targeted rule
 * never could.
 *
 * It evicts LESSONS from that hour and says nothing about where the meal goes.
 * This comment used to offer "reserving a lunch sitting" as the example, which
 * left schools with a hole and a lunch somewhere else; a sitting is declared
 * with a LunchServing, which the lunch variable reads as its own domain.
 */
export type ResourceKind = 'TEACHER' | 'ROOM' | 'STUDENT_GROUP' | 'GRADE_LEVEL';
/**
 * An opaque room-type token. Room types are school-owned rows whose names the
 * school authors, so what crosses to the solver is an anonymised id: the
 * engine only needs to know that a room's type and a requirement's required
 * type are the SAME token, never what the school calls it.
 */
export type RoomTypeKind = string;

export interface AnonymousRequirement {
  /** Opaque anonymous id for this requirement (NOT the real DB UUID). */
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /**
   * Minutes the PUPILS are occupied on either side of the lesson — ombyte
   * before idrotten, dusch after — and nothing else.
   *
   * Outside `minutesPerLesson`, which keeps its own number: the engine still
   * places a lesson of that length and still owes the timplan that many
   * minutes. What these add is how far the CLASS's occupancy reaches past the
   * lesson it is placing, so two lessons for the same children cannot be laid
   * end to end when the first ends in a shower.
   *
   * The pupil arm only. Not the teacher's no-overlap family and not the room's
   * — the idrottslärare does not shower with the class and the hall is empty
   * while it does. That asymmetry is the whole point, and it is why this is not
   * FrameTimes.changeoverMinutes with a different name: a corridor is a floor
   * on every gap of a stage, these are two named things one class does.
   *
   * 0..60 each, 0 for every requirement no school has written a number on.
   */
  minutesBefore: number;
  minutesAfter: number;
  /** Active-student headcount — an aggregate used for room-capacity checks. */
  studentGroupSize: number;
  /** When set, lessons for this requirement may only use rooms of this type. */
  requiredRoomType: RoomTypeKind | null;
  /** Optional second teacher scheduled together with the lead (co-teaching). */
  coTeacherId: string | null;
  /**
   * The years this group's students actually belong to, derived from their
   * home classes. Null when the group has no members with a year at all —
   * then no room limit can be checked against it.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/**
 * A group the week concerns, and how many children it brings to lunch.
 *
 * Zero for a teaching group: its students eat with their home class, and
 * counting them again would fill the hall twice over with the same children.
 * Sent as its own list rather than as a field on each requirement, because a
 * class whose lessons are all placed by hand has no requirement left — and it
 * still eats.
 */
export interface AnonymousGroup {
  id: string;
  lunchHeadcount: number;
  /**
   * The years this group holds, derived from its members' home classes with the
   * group's own year as the fallback — the same derivation the requirements use.
   *
   * Needed because a lunch sitting and a ramtid both reach a STAGE, and a meal
   * has no requirement to read a span off: a class whose whole week is hand-
   * placed arrives carrying no requirement at all and still eats.
   *
   * Both bounds or neither. Null means "unknown", not year 0 — such a group
   * matches no sitting and no frame and keeps the school-wide lunch window,
   * because guessing would sweep every yearless group into a sitting written
   * for one stage.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/**
 * A lunchsittning: the window one stage of the school may eat in.
 *
 * Not anonymised, and there is nothing to anonymise — a sitting names a span of
 * years, which is a property of the timetable rather than of a person or a room.
 *
 * The engine reads it as the DOMAIN of the meal's start. Several sittings that
 * reach one group UNION (a serving grants permission), which is the opposite of
 * what frame times do (a frame imposes a bound, so several intersect).
 */
/**
 * A rast: minutes of a day one stage of the school is not taught.
 *
 * The whole declaration — unlike a serving, nothing about a rast is chosen by
 * the engine, so there is no solved half to carry back. Every matching row
 * applies, and the union is an OBLIGATION where a serving's union is a
 * permission. Nothing to anonymise: a rast names a span of years, not a person.
 */
export interface AnonymousRast {
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: DayOfWeek | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  /**
   * Whether the stretch ending at this rast must hold a lesson.
   *
   * A rast is otherwise only a hole in the day, and a class whose Monday
   * begins at the morning break has broken no rule the engine knows.
   */
  requiresLessonBefore: boolean;
}

export interface AnonymousLunchServing {
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: DayOfWeek | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  /** Chairs for this sitting; null means the hall's own diningSeats. */
  seats: number | null;
}

/**
 * A meal the school placed by hand: one class, one weekday, one start.
 *
 * The engine PINS the lunch variable it already builds for that class and day.
 * Deliberately not a fixedLesson, which would add a second mandatory interval
 * beside a variable that is still free — two reservations in one window, and
 * an INFEASIBLE with no visible cause. Only the start: the meal's length is the
 * school's one lunchMinutes.
 */
export interface AnonymousLunchPlacement {
  studentGroupId: string;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
}

export interface AnonymousRoom {
  id: string;
  capacity: number | null;
  /** Room category (an enum, not PII) enabling type eligibility checks. */
  type: RoomTypeKind | null;
  /**
   * Inclusive year range the room may host; null means no limit at that end.
   * Keeps a stage's rooms to that stage.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A soft wish that a subject's lessons land in particular rooms. */
export interface AnonymousRoomPreference {
  id: string;
  subjectId: string;
  /** WISH pays per lesson placed elsewhere; LOCK forbids everywhere else. */
  kind: 'WISH' | 'LOCK';
  /**
   * The years the rule applies to; null on both means every year.
   *
   * Matched by CONTAINMENT — the requirement's whole span inside this one — not
   * by the overlap a GRADE_LEVEL reservation uses. A room decides where a group
   * may go; a reservation only decides who must be left alone.
   */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  /** Either a type… */
  roomType: string | null;
  /** …or named rooms. The gateway sends exactly one of the two. */
  roomIds: string[];
  /** Paid per lesson placed elsewhere, relative to the other objectives. */
  weight: number;
}

/**
 * En lärares arbetstid: the lunch one teacher must get, and the rest between two
 * of their days.
 *
 * The counterpart of an `AnonymousConstraint` with resourceKind TEACHER, and the
 * thing that one cannot say. A constraint CLOSES hours — it subtracts them from
 * the week — and there was no way at all to state that a teacher is OWED
 * something, so a generated week could hand somebody six lessons back to back
 * with no meal in them and end one day at 19:30 before opening the next at 07:40.
 *
 * HARD, both of them. A week that cannot honour a row here is refused, and the
 * refusal names the row — which is why `id` is here at all and why the gateway
 * anonymises it REVERSIBLY (workRuleAnonMap). The teacher map is discarded on
 * purpose, because no person's name may enter the stored conflicts; the rule's id
 * is what the school can actually open.
 *
 * EVERY FIELD IS NULLABLE, AND NULL MEANS THE RULE DOES NOT APPLY. Not zero and
 * not a default: a school that has filled in nobody must be refused nothing, so
 * an empty `teacherWorkRules` has to leave every week exactly as it was. The
 * three lunch fields travel together — all three, or all three null — which the
 * database, the DTO and the engine's pre-flight arithmetic each check, because a
 * lunch with no window may be placed at 07:00 and a window with no length is a
 * window nothing has to happen in.
 */
export interface AnonymousTeacherWorkRule {
  /** The RULE's anonymous id, reversible so a refusal names a row to open. */
  id: string;
  /** The teacher's anonymous id, from the same map the requirements use. */
  teacherId: string;
  /** Minutes of lunch; a multiple of 5, the solver's grid. Null: no lunch rule. */
  lunchMinutes: number | null;
  /** HH:MM:SS, or null together with the rest of the trio. */
  lunchStartTime: string | null;
  /** HH:MM:SS, or null together with the rest of the trio. */
  lunchEndTime: string | null;
  /**
   * Minutes between the END of this teacher's last lesson one day and the START
   * of their first the next. Null: no rest rule.
   */
  minDailyRestMinutes: number | null;
}

export interface AnonymousConstraint {
  id: string;
  resourceKind: ResourceKind;
  /**
   * Absent for GRADE_LEVEL, which names a year range instead. Optional rather
   * than a minted throwaway id: an id nothing can match is a rule that
   * validates, saves, lists and constrains nothing, with no error anywhere.
   */
  resourceId?: string;
  /** Inclusive year range for a GRADE_LEVEL rule; null at an open end. */
  minGradeLevel?: number | null;
  maxGradeLevel?: number | null;
  dayOfWeek: DayOfWeek | null;
  /** ISO date string (YYYY-MM-DD) or null for recurring weekly constraints. */
  date: string | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  kind: ConstraintKind;
}

/**
 * A ramtid: the hours one stage of the school may be taught in.
 *
 * NOT anonymised, and there is nothing to anonymise — a frame names a span of
 * years, which is a property of the timetable and not of any person or room.
 * The same is already true of a GRADE_LEVEL constraint, and for the same
 * reason: there is no row to point at.
 *
 * The engine reads a frame as the DOMAIN of the lesson's start variable rather
 * than as forbidden intervals, so the hours a frame closes never become
 * variables at all. Sending the complement as UNAVAILABLE constraints would
 * give the same schedule and a bigger model.
 */
export interface AnonymousFrameTime {
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: DayOfWeek | null;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
  /**
   * Minutes a body needs between two lessons for this stage.
   *
   * MAX over matching frames in the engine, which is the opposite of the
   * window's intersection: a window is a bound, a corridor is a floor.
   */
  changeoverMinutes: number;
}

/**
 * A locked master lesson forwarded as an immovable placement. The solver
 * schedules the remaining demand around these: no generated lesson may
 * overlap a fixed lesson that shares its teacher, student group, or room.
 */
export interface AnonymousFixedLesson {
  id: string;
  teacherId: string | null;
  coTeacherId: string | null;
  studentGroupId: string;
  /** Additional classes attending (multi-class lessons block them all). */
  extraGroupIds?: string[];
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
}

/**
 * A slot the previous (unlocked) schedule used for a requirement. Enables
 * minimal-disruption re-optimization: the solver is rewarded for keeping
 * lessons on these slots.
 */
export interface AnonymousPreviousLesson {
  requirementId: string;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
}

/** Per-request objective weights; unset fields fall back to engine defaults. */
export interface ObjectiveWeights {
  preferredFree?: number;
  preferredBusy?: number;
  disruption?: number;
  spread?: number;
  teacherGap?: number;
}

/** Optional hard scheduling rules forwarded to the engine. */
export interface ScheduleRules {
  /** HH:MM:SS */
  lunchStartTime?: string;
  /** HH:MM:SS */
  lunchEndTime?: string;
  lunchMinutes?: number;
  /**
   * Seats in the dining hall. Omitted when the school has no limit worth
   * modelling, and the engine then places lunch exactly as it did before.
   */
  diningSeats?: number;
  maxLessonsPerDayPerGroup?: number;
}

export interface AiEngineScheduleRequest {
  /** Correlation id so the AI engine can include it in its response. */
  requestId: string;
  academicYearId: string;
  requirements: AnonymousRequirement[];
  rooms: AnonymousRoom[];
  constraints: AnonymousConstraint[];
  /** Ramtider. Empty means every stage may use the whole configured day. */
  frameTimes: AnonymousFrameTime[];
  /** Lunchsittningar. Empty means the whole lunch window is open to everyone. */
  lunchServings: AnonymousLunchServing[];
  /** Meals placed by hand. Empty means the solver places every one. */
  lunchPlacements: AnonymousLunchPlacement[];
  /** Raster. Empty means no stage has a declared break. */
  rasts: AnonymousRast[];
  /**
   * Lärarnas arbetstid. Empty means no teacher has one — which is every school
   * until somebody fills a row in, and is what makes this list safe to add: an
   * empty one refuses nothing and changes no week.
   *
   * A top-level list rather than fields on `AnonymousRequirement`, because a rule
   * belongs to the TEACHER and a requirement is per (class, subject): the same
   * teacher carries eight of them, and eight copies of one lunch rule are eight
   * things to disagree. The engine also needs the rule for a teacher whose whole
   * week is hand-placed, and such a teacher has no requirement left at all.
   */
  teacherWorkRules: AnonymousTeacherWorkRule[];
  /** Locked master lessons the solver must plan around (never re-placed). */
  fixedLessons: AnonymousFixedLesson[];
  /** Every group the week concerns, with its dining-hall headcount. */
  groups: AnonymousGroup[];
  /** Previous unlocked placements, for minimal-disruption re-optimization. */
  previousLessons: AnonymousPreviousLesson[];
  /**
   * Pairs of (anonymous) group ids that share at least one student — the home
   * class vs. teaching-group relation (7A vs Ma71, or Ma71 vs Sv73). Lessons
   * for a conflicting pair must never overlap: every shared student would be
   * double-booked. Pairwise is exactly the right granularity for the hard
   * constraint, and it keeps STUDENT data out of the engine entirely.
   */
  groupConflicts: [string, string][];
  weights?: ObjectiveWeights | null;
  rules?: ScheduleRules | null;
  roomPreferences: AnonymousRoomPreference[];
}

export type ConflictCategory =
  | 'REQUIREMENT_DEMAND'
  | 'TEACHER_OVERLAP'
  | 'ROOM_OVERLAP'
  | 'GROUP_OVERLAP'
  | 'ROOM_CAPACITY'
  | 'AVAILABILITY'
  | 'DINING_CAPACITY'
  | 'INSUFFICIENT_RESOURCES'
  | 'LUNCH_WINDOW'
  // A measurement, not a proof: which rule, switched off, let a timed-out week
  // solve inside a short probe budget.
  | 'TIMEOUT_PROBE';

export interface AiEngineConflictDetail {
  category: ConflictCategory;
  /**
   * The sentence's stable name, and the values it substitutes.
   *
   * The engine has no idea who is reading, and a Swedish school reading an
   * English refusal is what these are for: the web renders `code` from its own
   * message catalogue with `params`, and falls back to `message` when it has
   * no translation. See optimization-engine/app/messages.py.
   *
   * Values are scalars only, never a list — a sentence that needs to name
   * several classes names them through `resourceIds`, which the gateway turns
   * into `resourceNames` and the page renders itself. A comma-separated list
   * built in the engine would be a list punctuated in English.
   */
  code: string;
  params: Record<string, string | number>;
  /** Human-readable but PII-free — the engine only ever saw anonymous ids. */
  message: string;
  requirementIds: string[];
  roomIds: string[];
  constraintIds: string[];
  resourceIds: string[];
  /**
   * The school's names for the groups in resourceIds. Never sent by the
   * engine, which knows no names; filled by the gateway on the way back, so
   * a line that says "the classes named here" can show them.
   */
  resourceNames?: string[];
}

export interface AiEngineConflictAnalysis {
  summary: string;
  /** The summary's own code and values; see AiEngineConflictDetail. */
  summaryCode: string;
  summaryParams: Record<string, string | number>;
  conflicts: AiEngineConflictDetail[];
}

export interface AiEngineScheduleResponse {
  requestId: string;
  /**
   * INFEASIBLE means the engine *proved* no timetable exists (and only then is
   * `conflicts` populated). TIMEOUT means the solver ran out of time without
   * finding one — nothing was proven and the same request may succeed with a
   * longer engine budget. Both yield an empty `lessons` array.
   */
  status: 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL' | 'TIMEOUT';
  lessons: AiEngineLesson[];
  /**
   * When each student group eats, one entry per group per teaching day.
   *
   * Optional because it arrives from a NEWER engine than the one this gateway
   * may be talking to. That is safe in this direction and only this one: the
   * request is validated by pydantic with `extra="forbid"`, so an unknown field
   * sent UP is a 422 for the whole optimisation — but the reply is read through
   * a bare generic with no runtime validation, so an unknown field coming DOWN
   * is ignored and a missing one is `undefined`.
   */
  lunches?: AiEngineLunch[];
  conflicts?: AiEngineConflictAnalysis | null;
}

/**
 * One student group's sitting on one day.
 *
 * Not an AiEngineLesson: that type is keyed on `requirementId` and a meal has
 * no teaching requirement. `studentGroupId` is the anonymised id, so the
 * gateway has to map it back through the same group map the requirements used.
 */
export interface AiEngineLunch {
  studentGroupId: string;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
}

export interface AiEngineLesson {
  requirementId: string;
  roomId: string | null;
  dayOfWeek: DayOfWeek;
  /** HH:MM:SS */
  startTime: string;
  /** HH:MM:SS */
  endTime: string;
}
