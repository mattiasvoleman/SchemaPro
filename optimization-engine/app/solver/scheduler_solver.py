from __future__ import annotations

import logging
import math

import time
from collections import defaultdict
from collections.abc import Callable
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date as date_type
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.solver.frames import changeover_slots, day_windows, span_of
from app.solver.rasts import blocks_for, blocks_with_demand, forbidden_starts
from app.solver.servings import allowed_starts
from app.schemas.schedule import (
    AnonymousRoomPreference,
    AnonymousConstraint,
    ConflictAnalysis,
    ConflictDetail,
    AnonymousGroup,
    AnonymousRequirement,
    AnonymousRoom,
    FixedLesson,
    FrameTime,
    LunchPlacement,
    LunchServing,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    PreviousLesson,
    Rast,
    ScheduledLesson,
    ScheduledLunch,
    ScheduleRules,
    SolverStatus,
)

logger = logging.getLogger(__name__)


from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis
from app.solver.room_allocator import (
    RoomPlan,
    add_room_allocation,
    collect_distinguished_room_ids,
)
from app.solver.time_grid import TimeGrid


@dataclass(frozen=True)
class ResolvedWeights:
    preferred_free: int
    preferred_busy: int
    room_preference: int
    disruption: int
    spread: int
    teacher_gap: int
    lunch_drift: int
    date_unavailable: int


@dataclass(frozen=True)
class LessonInstance:
    requirement: AnonymousRequirement
    lesson_index: int

    def key(self) -> str:
        return f"{self.requirement.id}_{self.lesson_index}"


@dataclass
class LessonDecision:
    lesson: LessonInstance
    start: cp_model.IntVar
    duration: int
    end: cp_model.IntVar
    interval: cp_model.IntervalVar
    room_index: cp_model.IntVar
    #: Slots of corridor this lesson's stage asks for after it. Zero by default.
    changeover: int = 0
    #: The interval plus that margin, built once and shared. See padded_of.
    _padded: cp_model.IntervalVar | None = None


def padded_of(model: cp_model.CpModel, decision: LessonDecision) -> cp_model.IntervalVar:
    """The interval a NO-OVERLAP family should see: the lesson plus its corridor.

    CP-SAT intervals are half-open, so a lesson ending 09:00 and one starting
    09:00 do not overlap and the teacher walks between two rooms in no time at
    all. Lengthening the interval the OVERLAP CHECK sees, while leaving the one
    the school is shown alone, is the whole mechanism.

    NO NEW VARIABLES. The padded interval reuses the same `start` and an affine
    end, so it adds one interval proto and not a single IntVar or BoolVar —
    which is why _estimate_model_size, which predicts variable counts, needs no
    new term for it.

    Padded at the END only. Padding both sides turns a ten-minute rule into a
    silent twenty, and padding the front makes 08:00 an illegal start for the
    first lesson of the day.

    Memoised on the decision: a lesson appears in the teacher family, its own
    group's family, one family per group that shares its pupils and the lunch
    family, and four copies of the same interval would be four protos for one
    fact.
    """
    if decision.changeover == 0:
        return decision.interval
    if decision._padded is None:
        decision._padded = model.NewIntervalVar(
            decision.start,
            decision.duration + decision.changeover,
            decision.end + decision.changeover,
            f"padded_{decision.lesson.key()}",
        )
    return decision._padded


def _grade_span_text(low: int | None, high: int | None) -> str:
    """A year span as a sentence shows it: "7", "4–6", or "" when unknown.

    An EN DASH, which is what the school's own screens use for a range, and a
    single year written once rather than as "7-7". Typography rather than
    language, so it belongs on this side: the value is substituted into every
    translation unchanged.
    """
    if low is None or high is None:
        return ""
    return str(low) if low == high else f"{low}\u2013{high}"


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Half-open [a, b) ranges, merged where they touch or overlap, in order."""
    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _subtract_range(
    ranges: list[tuple[int, int]], hole: tuple[int, int],
) -> list[tuple[int, int]]:
    """The ranges with [hole) cut out of them."""
    lo, hi = hole
    out: list[tuple[int, int]] = []
    for start, end in ranges:
        if hi <= start or lo >= end:
            out.append((start, end))
            continue
        if start < lo:
            out.append((start, lo))
        if hi < end:
            out.append((hi, end))
    return out


def _widest_free_run(
    open_slot: int,
    close_slot: int,
    blocks: list[tuple[int, int]],
) -> int:
    """The longest unbroken stretch of slots inside [open, close) after rasts.

    A frame leaves ONE window and its width is the answer; rasts leave several
    fragments, and a lesson needs one of them whole. Taking the total free time
    instead would accept a day of ten five-minute gaps as room for an hour.
    """
    longest = 0
    cursor = open_slot
    for first, last in blocks:
        start = max(first, open_slot)
        end = min(last, close_slot)
        if end <= start:
            continue
        longest = max(longest, start - cursor)
        cursor = max(cursor, end)
    return max(longest, close_slot - cursor)


@dataclass(frozen=True)
class _Clique:
    """A class and the groups the model will never let overlap with it or each other.

    `free_by_day` is day index -> merged [a, b) slot ranges within the day
    that at least one member may be taught in, less the locked lessons that
    block every member. `measure` is the greatest common divisor of the
    lessons' lengths in slots: every lesson is a whole number of it, so a gap
    rounded down to a multiple of it is a bound no placement beats.
    """

    members: list[UUID]
    requirements: list[AnonymousRequirement]
    demand: int
    measure: int
    free_by_day: dict[int, list[tuple[int, int]]]
    #: The one frame window every open day shares, as "08:00-13:30", for a
    #: sentence to quote; None when the days differ or nothing narrows them.
    window_text: str | None


def _holds(ranges: list[tuple[int, int]], measure: int) -> int:
    """Slots of lessons the ranges can hold, each rounded down to whole measures."""
    return sum(((end - start) // measure) * measure for start, end in ranges)


@dataclass(frozen=True)
class _LunchStarts:
    """One class's lunch starts on one day, as the model's four sentences.

    Absolute slots. The window is the school-wide rule and the variable's
    bounds; the other three are the narrowings the builder adds as
    constraints — the stage's sitting or frame, what the locked lessons
    leave, what the reservations leave — None where nothing narrows. Kept
    apart so a reader can name each one; composed() is what the variable
    may actually take.
    """

    window: cp_model.Domain
    declared: cp_model.Domain | None
    locked: cp_model.Domain | None
    closed: cp_model.Domain | None
    #: The start the school placed by hand, as a domain of one. Where it is set
    #: the other three are None — a pin outranks the window and the sitting,
    #: and the locks and reservations were checked against it before any build
    #: — and `window` is widened to hold it, so a meal drawn outside the school
    #: window is a narrowing like any other and never a variable that cannot
    #: be built.
    pinned: cp_model.Domain | None = None

    def composed(self) -> cp_model.Domain:
        domain = self.window
        for narrowing in (self.declared, self.locked, self.closed, self.pinned):
            if narrowing is not None:
                domain = domain.intersection_with(narrowing)
        return domain


@dataclass(frozen=True)
class _LunchStage:
    """The lunch stage's model, with one free literal per sentence it makes.

    `literals` is keyed (cause, group id): "eats", "lessons", "declared",
    "locked" and "closed" per class, and "hall" for the school with no group.
    pinned() fixes every literal for one solve — true unless relaxed — on a
    clone, so the stage is built once and solved as many times as the
    naming needs. Clone() keeps variable indices, which is what lets the
    original's literals and starts address the clone's.
    """

    model: cp_model.CpModel
    starts: dict[tuple[UUID, int], cp_model.IntVar]
    literals: dict[tuple[str, UUID | None], cp_model.IntVar]
    headcounts: dict[UUID, int]
    #: Class -> the frame window its lessons share, for the sentence about them.
    window_texts: dict[UUID, str | None]

    def pinned(self, relaxed: set[tuple[str, UUID | None]]) -> cp_model.CpModel:
        clone = self.model.Clone()
        for key, literal in self.literals.items():
            clone.Add(literal == (0 if key in relaxed else 1))
        return clone


class SchedulerSolver:
    """CP-SAT weekly master timetable optimizer."""

    # Hard ceilings applied before any CP-SAT model is constructed. The solver's
    # wall-clock timeout only bounds Solve(); the model-BUILD phase (variable and
    # constraint creation) runs first and scales multiplicatively with the input
    # list lengths. These budgets reject pathological payloads up front so a
    # single request cannot exhaust CPU/RAM before the timeout can engage.
    #
    # MAX_MODEL_COMPLEXITY bounds _estimate_model_size, a per-builder prediction
    # of the variable count (within ~8% of the real model on the benchmark
    # school). Build cost is ~17 microseconds per variable single-threaded, so
    # one million variables is roughly 15-20s of build and one to two GB of
    # proto — the edge of acceptable for a single request, and an order of
    # magnitude above a 2,000-student school (~100K).
    #
    # An earlier formula (lessons x rooms + lessons x constraints x days)
    # predated the room-class and interval-lunch encodings: its dominant term
    # tracked 3% of the real cost, grew ~n^3 against a ~n^2 model, and rejected
    # the 2,000-student benchmark that actually builds in 1.6s.
    MAX_LESSON_INSTANCES = 5_000
    MAX_MODEL_COMPLEXITY = 1_000_000

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._grid = TimeGrid(
            day_start_minutes=settings.schedule_day_start_minutes,
            day_end_minutes=settings.schedule_day_end_minutes,
            slot_minutes=settings.slot_minutes,
            schedule_days=tuple(settings.schedule_days),
        )

    def _build_model(
        self,
        request: OptimizeScheduleRequest,
        *,
        use_assumptions: bool,
        include_objective: bool = True,
    ) -> tuple[
        cp_model.CpModel,
        AssumptionRegistry,
        list[LessonDecision],
        RoomPlan,
        dict[tuple[UUID, int], cp_model.IntVar],
    ]:
        """Construct the CP-SAT model.

        `use_assumptions` is threaded through to the registry; see its docstring
        for why the default build keeps CpModel.assumptions empty.

        `include_objective=False` builds the satisfaction model for phase 1.
        Constraints are identical either way — only the objective terms and
        their auxiliary variables are omitted. Merely clearing the objective on
        a clone is NOT equivalent: the auxiliary variables stay behind as free
        variables, and a few thousand functionally-determined free literals are
        measurably enough to flip a solvable satisfaction model to UNKNOWN.
        """
        model = cp_model.CpModel()
        registry = AssumptionRegistry(use_assumptions=use_assumptions)
        rooms = request.rooms
        decisions = self._create_lesson_decisions(
            model, request.requirements, len(rooms), request.frame_times, request.rasts,
        )

        self._add_capacity_constraints(model, registry, decisions, rooms)
        self._add_teacher_no_overlap(model, decisions)
        self._add_group_no_overlap(model, decisions, request.group_conflicts)
        room_plan = self._add_room_allocation(
            model,
            decisions,
            rooms,
            request.constraints,
            request.fixed_lessons,
            request.room_preferences,
        )
        self._add_availability_constraints(model, registry, decisions, rooms, request.constraints)
        self._add_fixed_lesson_constraints(
            model, decisions, rooms, request.fixed_lessons, request.group_conflicts,
        )

        day_vars: dict[str, cp_model.IntVar] = {}
        lunch_starts = self._add_rules_constraints(
            model, registry, decisions, request.rules, day_vars,
            request.fixed_lessons, request.groups, request.constraints,
            request.lunch_servings, request.frame_times,
            request.group_conflicts, request.lunch_placements,
        )
        # After the lunch, because a rast's stretch is counted from the
        # previous break and the class's own meal can be that break.
        self._add_rast_ordering_constraints(
            model, registry, request, decisions, lunch_starts,
        )
        if include_objective:
            weights = self._resolve_weights(request)
            objective_terms = [
                *self._add_preference_objective(
                    model, decisions, rooms, request.constraints, weights,
                ),
                *self._add_disruption_objective(
                    model, decisions, request.previous_lessons, weights,
                ),
                *self._add_lunch_stability_objective(model, lunch_starts, weights),
                *self._add_spread_objective(model, decisions, weights, day_vars),
                *self._add_idle_time_objective(
                    model, decisions, request.constraints, weights, day_vars,
                ),
                *self._add_room_preference_objective(
                    model, decisions, rooms, room_plan, request.room_preferences, weights,
                ),
            ]
            model.Minimize(sum(objective_terms) if objective_terms else 0)
        return model, registry, decisions, room_plan, lunch_starts

    def _dining_hall_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """The whole hall against the whole window, decided by arithmetic.

        The validator refuses one class too big for the hall, and one sitting
        too small for its stage. Between them sat the school in the report:
        every class fits, no sittings declared, and 480 children eating thirty
        minutes each in 115 seats over a 150-minute window is 14,400
        student-minutes against 17,250 — a week with a timetable only if every
        wave of the hall fills to within a class of capacity, every day. CP-SAT
        hunted that needle for the whole budget and answered TIMEOUT, which
        names nothing.

        Student-minutes is the cumulative's own relaxation, so a payload that
        fails it has no timetable, and this can say so without a solve. It says
        so in the SAME SHAPE the solver would have: INFEASIBLE, a
        DINING_CAPACITY conflict carrying the registry's own sentence, and the
        numbers in the summary — the page already translates the category, and
        a 400 for the same fact would be a second way of saying it. A payload
        that passes narrowly is left to the solver, and to the probe.
        """
        rules = request.rules
        if (
            rules is None
            or not _lunch_window_is_set(rules)
            or rules.dining_seats is None
            or rules.lunch_minutes is None
            or not request.groups
        ):
            return None
        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
        lunch_group_ids = _lunch_group_ids(request.groups)
        _, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        headcount_by_group = _lunch_headcounts(request.groups)
        # A meal the school placed outside the window takes no chair inside it,
        # and counting it would refuse a week whose hall is fine. Left out
        # generously — a pin partly inside is left out whole — because this is
        # a proof of impossibility, and every child it under-counts only hands
        # the question to the solver.
        pins = self._lunch_pins(request.lunch_placements, lunch_group_ids)
        window_minutes = (window_end - window_start) * self._grid.slot_minutes
        offered = rules.dining_seats * window_minutes
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            eating = sum(
                headcount_by_group.get(group_id, 0)
                for group_id in lunch_group_ids
                if (group_id, day_index) not in exempt_days
                and (
                    (group_id, day_index) not in pins
                    or window_start <= pins[(group_id, day_index)] <= window_end - lunch_slots
                )
            )
            needed = eating * rules.lunch_minutes
            if needed > offered:
                return ConflictAnalysis(
                    summary_code="LUNCH_HALL_CANNOT_FEED_THE_SCHOOL",
                    summary_params={
                        "day": day_of_week,
                        "students": eating,
                        "minutes": rules.lunch_minutes,
                        "needed": needed,
                        "seats": rules.dining_seats,
                        "windowStart": rules.lunch_start_time[:5],
                        "windowEnd": rules.lunch_end_time[:5],
                        "offered": offered,
                    },
                    conflicts=[
                        ConflictDetail(
                            category="DINING_CAPACITY",
                            code="LUNCH_SEATS_CANNOT_STAGGER",
                            params={"seats": rules.dining_seats},
                        ),
                    ],
                )
        return None

    def _cliques(self, request: OptimizeScheduleRequest) -> list[tuple[AnonymousGroup, _Clique]]:
        """One clique per group in the payload, with its hours and its free time.

        SOUND BY THE MODEL'S OWN RULE, not by who is in which group. The engine
        forbids overlap PAIRWISE between any two groups that share a pupil, so
        a set of groups that pairwise share pupils — a clique — may never run
        two lessons at once, whether or not one child sits in all of them. The
        lessons of a clique therefore need, between them, at least their summed
        length of the clique's free time; and this counts only cliques, never
        the looser set of "everyone who shares with the class", because two
        halves of a class share with it and not with each other and CAN overlap.

        Greedy, in payload order — any clique is sound, and the whole set is
        not. Two readers, the hours verdict and the lunch stage, and one
        builder, so they can never disagree about who may not overlap whom.

        EVERYTHING LEANS THE OPTIMISTIC WAY, so a refusal built on these
        numbers is a refusal the model would have made: the free time is the
        UNION of the windows the model binds the clique's lessons by — each
        requirement's own years, see below — and only a locked lesson that
        blocks EVERY member is subtracted; one that blocks some leaves the
        others free, and subtracting it would refuse a week the model accepts.
        """
        sharing = _groups_sharing_students(request.group_conflicts)
        requirements_of: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
        for requirement in request.requirements:
            requirements_of[requirement.student_group_id].append(requirement)
        slots_per_day = self._grid.slots_per_day
        fixed_windows = [
            (fixed, self._fixed_window(fixed))
            for fixed in request.fixed_lessons
        ]

        cliques: list[tuple[AnonymousGroup, _Clique]] = []
        for group in request.groups:
            members: list[UUID] = [group.id]
            for other in sharing.get(group.id, ()):
                if other in requirements_of and all(
                    other in sharing.get(member, ()) for member in members
                ):
                    members.append(other)
            requirements = [
                requirement for member in members for requirement in requirements_of.get(member, [])
            ]
            if not requirements:
                continue
            lengths = [self._grid.minutes_to_slots(r.minutes_per_lesson) for r in requirements]

            # Whose years open which window: EVERY REQUIREMENT'S OWN, the way
            # the model binds each lesson (span_of(requirement) in the
            # decision builder), and never the group's. The group's span
            # governs only where its lunch may sit. This first read the class
            # off its group entry and a member off its first requirement, and
            # a panel found the week it refuses: a class whose group carries
            # years 4-4 under a frame closing 12:30 while its requirement
            # carries none — the model lets those lessons run to 18:00, the
            # count did not, and a schedulable week was refused twice over.
            # The gateway sends one span to both today; the engine does not
            # get to rely on that.
            spans = {span_of(requirement) for requirement in requirements}
            windows_of = [day_windows(request.frame_times, span, self._grid) for span in spans]
            member_set = set(members)

            free_by_day: dict[int, list[tuple[int, int]]] = {}
            open_by_day: dict[int, list[tuple[int, int]]] = {}
            for day_index in range(len(self._grid.schedule_days)):
                base = day_index * slots_per_day
                open_ranges = [windows[day_index] for windows in windows_of if day_index in windows]
                if not open_ranges:
                    continue
                free = _merge_ranges(open_ranges)
                open_by_day[day_index] = free
                for fixed, window in fixed_windows:
                    if window is None:
                        continue
                    blocked_groups = {fixed.student_group_id, *fixed.extra_group_ids}
                    blocks_all = all(
                        member in blocked_groups
                        or any(g in sharing.get(member, ()) for g in blocked_groups)
                        for member in member_set
                    )
                    if not blocks_all:
                        continue
                    lo, hi = window[0] - base, window[1] - base
                    if hi <= 0 or lo >= slots_per_day:
                        continue
                    free = _subtract_range(free, (max(lo, 0), min(hi, slots_per_day)))
                free_by_day[day_index] = free

            cliques.append((
                group,
                _Clique(
                    members=members,
                    requirements=requirements,
                    demand=sum(
                        r.lessons_per_week * length for r, length in zip(requirements, lengths)
                    ),
                    measure=math.gcd(*lengths),
                    free_by_day=free_by_day,
                    window_text=self._shared_window_text(open_by_day),
                ),
            ))
        return cliques

    def _shared_window_text(self, open_by_day: dict[int, list[tuple[int, int]]]) -> str | None:
        """"08:00-13:30" when every open day is that one window, else None.

        The sentence that names a packed day wants to quote the frame that
        packs it, and can only do so honestly when there is one such frame;
        a week of differing days, or one nothing narrows, gets no times.
        """
        windows = {tuple(ranges) for ranges in open_by_day.values()}
        if len(windows) != 1:
            return None
        (ranges,) = windows
        if len(ranges) != 1:
            return None
        (open_slot, close_slot) = ranges[0]
        if open_slot == 0 and close_slot == self._grid.slots_per_day:
            return None

        def clock(slot: int) -> str:
            minutes = self._grid.day_start_minutes + slot * self._grid.slot_minutes
            return f"{minutes // 60:02d}:{minutes % 60:02d}"

        return f"{clock(open_slot)}-{clock(close_slot)}"

    def _clique_hours_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """Hours against hours, for groups the model will never let overlap.

        The second reproduction of the report: two locked lessons at 11-12 and
        12-13 on every weekday pin the class's lunch to 10:30, the class is
        busy 10:30-13:00, and 08:00-10:30 plus 13:00-15:30 hold four lessons a
        day — twenty a week for a class that needs twenty-four. Provably
        infeasible by counting; CP-SAT could not prove it in 120 s and answered
        UNKNOWN, which the engine reported as TIMEOUT.

        The clique and its free time come from _cliques, which says why the
        count is sound. What is decided here is what a gap HOLDS: the lunch is
        placed wherever it wastes least, and a gap is rounded down to a
        multiple of the clique's lessons' COMMON MEASURE, their greatest common
        divisor. Not the shortest lesson, which this first shipped with: a
        105-minute day holds a 60- and a 45-minute lesson exactly, and rounding
        it down to a multiple of 45 called it 90 and refused five such days
        for a class the model placed in under a second. The measure is still
        a bound the model cannot beat — every lesson is a whole number of it.
        """
        if not request.groups:
            return None
        rules = request.rules
        lunch_on = rules is not None and _lunch_window_is_set(rules)
        if lunch_on:
            window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
            lunch_group_ids = _lunch_group_ids(request.groups)
            _, exempt_days = self._lunch_starts_blocked_by_constraints(
                request.constraints, set(lunch_group_ids),
                window_start, window_end - lunch_slots, window_end, lunch_slots,
            )
        else:
            window_start = window_end = lunch_slots = 0
            exempt_days = set()

        for group, clique in self._cliques(request):
            measure = clique.measure
            capacity = 0
            # The same count with no meal to seat: when THAT would have held the
            # lessons, the lunch is the difference and is named as such.
            capacity_without_lunch = 0
            for day_index, free in clique.free_by_day.items():
                capacity_without_lunch += _holds(free, measure)
                if lunch_on and (group.id, day_index) not in exempt_days:
                    # The meal must sit inside the window AND inside free time;
                    # the placement that wastes least is the one that counts.
                    best = 0
                    placed = False
                    for start in range(window_start, window_end - lunch_slots + 1):
                        if any(a <= start and start + lunch_slots <= b for a, b in free):
                            placed = True
                            best = max(
                                best,
                                _holds(_subtract_range(free, (start, start + lunch_slots)), measure),
                            )
                    if not placed:
                        # No lunch fits this day at all — a refusal of its own,
                        # made elsewhere by name. Not this verdict's to make.
                        return None
                    capacity += best
                else:
                    capacity += _holds(free, measure)

            demand = clique.demand
            if demand > capacity:
                minutes = self._grid.slot_minutes
                details = []
                if lunch_on and demand <= capacity_without_lunch:
                    # Both true, both said: the hours do not fit, and it is the
                    # meal that takes the hour they needed. A school that reads
                    # only "too many lessons" would go to the timplan; the
                    # lever is the lunch window or the lock beside it.
                    details.append(
                        ConflictDetail(
                            category="LUNCH_WINDOW",
                            code="LUNCH_BREAK_IS_THE_DIFFERENCE",
                            params={
                                "lunchMinutes": rules.lunch_minutes,
                                "freeMinutes": capacity_without_lunch * minutes,
                            },
                            resource_ids=[group.id],
                        ),
                    )
                return ConflictAnalysis(
                    summary_code="DEMAND_CLIQUE_HOURS_SHORT",
                    summary_params={
                        "group": str(group.id),
                        "sharingGroups": len(clique.members) - 1,
                        "demandMinutes": demand * minutes,
                        "capacityMinutes": capacity * minutes,
                    },
                    conflicts=[
                        ConflictDetail(
                            category="REQUIREMENT_DEMAND",
                            code="DEMAND_REQUIREMENTS_EXCEED_WEEK",
                            params={
                                "requirements": len(clique.requirements),
                                "demandMinutes": demand * minutes,
                                "capacityMinutes": capacity * minutes,
                            },
                            requirement_ids=[r.id for r in clique.requirements],
                            resource_ids=[group.id],
                        ),
                        *details,
                    ],
                )
        return None

    def _lunch_pins(
        self,
        placements: list[LunchPlacement],
        lunch_group_ids: list[UUID] | set[UUID],
    ) -> dict[tuple[UUID, int], int]:
        """(class, day index) -> the day-local slot the school put the meal at.

        One reader for the builder, the lunch stage, the narrowings and the
        dining-hall verdict, so the four can never disagree about which meals
        are pinned. Placements that cannot stand — off the grid, on a day the
        engine does not teach — are left out rather than raised: every one of
        them is refused by name in _verify_lunch_placements before any of these
        readers runs, and a reader that also refused would be a second rule.

        Only classes the payload feeds. A placement for a group with no lunch
        variable has nothing to pin; the gateway sends placements only for the
        classes it also sends in `groups`.
        """
        eating = set(lunch_group_ids)
        pins: dict[tuple[UUID, int], int] = {}
        for placement in placements:
            if placement.student_group_id not in eating:
                continue
            if placement.day_of_week not in self._grid.schedule_days:
                continue
            try:
                slot = self._grid.parse_hhmmss(placement.start_time)
            except ValueError:
                continue
            day_index = self._grid.day_index(placement.day_of_week)
            pins[(placement.student_group_id, day_index)] = slot
        return pins

    @staticmethod
    def _lunch_start_bounds(
        pin: int | None,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> tuple[int, int]:
        """The lunch variable's inclusive bounds, widened to hold a pin.

        THE WHOLE FEATURE HANGS ON THIS. The variable used to be built on the
        school window unconditionally, and a pin outside it is not an
        infeasible model but an invalid one — MODEL_INVALID, a crash. That is
        exactly the school this exists for: locked lessons fill 10:30-13:00, so
        the meal they place goes at 13:00, outside the window. The hull of the
        window and the pin holds it; the pin itself is then a constraint under
        a literal, so relaxing it widens the meal's choices instead of leaving
        a variable with nowhere to be.
        """
        low, high = day_offset + window_start, day_offset + window_end - lunch_slots
        if pin is not None:
            low, high = min(low, day_offset + pin), max(high, day_offset + pin)
        return low, high

    def _verify_lunch_placements(
        self,
        request: OptimizeScheduleRequest,
        lunch_group_ids: list[UUID],
        exempt_days: set[tuple[UUID, int]],
        lunch_slots: int,
    ) -> dict[tuple[UUID, int], int]:
        """Refuse a hand-placed meal that cannot stand; return the ones that can.

        A PIN OUTRANKS THE WINDOW AND THE SITTING, and nothing else. The window
        and the stage's sitting are rules about when a STAGE eats, and a school
        placing one class's meal by hand is overriding them on purpose. A
        locked lesson and a reservation are facts about the CLASS's own time,
        and a meal placed on top of one is two of the school's sentences that
        cannot both be true — refused here, by name, rather than left to the
        model.

        And it has to be refused here, not merely because a name is better
        than a core. The locked lessons reach the meal only as a narrowing of
        its domain — they are never intervals beside it — and a pinned day
        drops that narrowing. A pin on a lock that got past this check would
        not be refused at all: the meal would be served in a classroom.

        Tested on the PIN'S OWN SLOT, not on the starts the window leaves:
        blocked_starts is computed across the lunch window, and a meal placed
        outside it — the whole point — would be checked against nothing. The
        same two helpers the builder uses, asked about one start, so the check
        and the model can never round a locked lesson differently.
        """
        eating = set(lunch_group_ids)
        sharing = _groups_sharing_students(request.group_conflicts)
        slots_per_day = self._grid.slots_per_day
        pins: dict[tuple[UUID, int], int] = {}
        for placement in request.lunch_placements:
            group_id = placement.student_group_id
            if group_id not in eating:
                continue
            try:
                if placement.day_of_week not in self._grid.schedule_days:
                    msg = f"{placement.day_of_week} is not a teaching day"
                    raise ValueError(msg)
                slot = self._grid.parse_hhmmss(placement.start_time)
                if slot + lunch_slots > slots_per_day:
                    msg = "the meal runs past the end of the day"
                    raise ValueError(msg)
            except ValueError as exc:
                raise InvalidScheduleInputError.of("LUNCH_PLACEMENT_OFF_GRID", {
                    "group": str(group_id),
                    "day": placement.day_of_week,
                    "start": placement.start_time[:5],
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            day_index = self._grid.day_index(placement.day_of_week)
            key = (group_id, day_index)
            day_offset = day_index * slots_per_day
            what: str | None = None
            if key in exempt_days:
                # The school has said the class is not here that day. A meal
                # placed on it would have no variable to pin and would vanish
                # without a word.
                what = "day"
            else:
                locked = self._lunch_starts_blocked_by_fixed_lessons(
                    request.fixed_lessons, {group_id}, sharing, slot, slot, lunch_slots,
                ).get(key)
                closed, covered = self._lunch_starts_blocked_by_constraints(
                    request.constraints, {group_id}, slot, slot, slot + lunch_slots, lunch_slots,
                )
                if locked and self._admissible_lunch_starts(
                    day_offset, slot, slot + lunch_slots, lunch_slots, locked,
                ).is_empty():
                    what = "locked"
                elif key in covered or (
                    closed.get(key)
                    and self._admissible_lunch_starts(
                        day_offset, slot, slot + lunch_slots, lunch_slots, closed[key],
                    ).is_empty()
                ):
                    what = "closed"
            if what is not None:
                raise InvalidScheduleInputError.of("LUNCH_PLACEMENT_COLLIDES", {
                    "group": str(group_id),
                    "day": placement.day_of_week,
                    "start": placement.start_time[:5],
                    "what": what,
                })
            pins[key] = slot
        return pins

    def _lunch_start_narrowings(
        self, request: OptimizeScheduleRequest,
    ) -> dict[tuple[UUID, int], _LunchStarts] | None:
        """Where each class's lunch may start on each day, as the model says it.

        The model states the fact as four constraints on one variable: the
        window as its bounds, the stage's sitting or frame as a domain, and
        the locked lessons and the reservations as two more, each under the
        assumption literal that names it. Read here through the same helpers
        and in the same order, and KEPT APART, so a reader that needs to name
        one of them — the lunch stage — can put the same literal on the same
        sentence. None when the school asked for no lunch, the same test the
        builder makes.

        Empty compositions are allowed to come out: _validate_request refuses
        a sitting or a lock that alone leaves no start, and only their
        intersection can still be empty. The caller decides what to make of
        that.
        """
        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules) or not request.groups:
            return None
        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
        lunch_group_ids = _lunch_group_ids(request.groups)
        blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
            request.fixed_lessons,
            set(lunch_group_ids),
            _groups_sharing_students(request.group_conflicts),
            window_start,
            window_end - lunch_slots,
            lunch_slots,
        )
        closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }
        slots_per_day = self._grid.slots_per_day
        pins = self._lunch_pins(request.lunch_placements, lunch_group_ids)
        starts: dict[tuple[UUID, int], _LunchStarts] = {}
        for group_id in lunch_group_ids:
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                if (group_id, day_index) in exempt_days:
                    continue
                day_offset = day_index * slots_per_day
                pin = pins.get((group_id, day_index))
                if pin is not None:
                    low, high = self._lunch_start_bounds(
                        pin, day_offset, window_start, window_end, lunch_slots,
                    )
                    starts[(group_id, day_index)] = _LunchStarts(
                        window=cp_model.Domain(low, high),
                        declared=None,
                        locked=None,
                        closed=None,
                        pinned=cp_model.Domain(day_offset + pin, day_offset + pin),
                    )
                    continue
                declared = self._declared_lunch_domain(
                    request.lunch_servings,
                    request.frame_times,
                    span_by_group.get(group_id),
                    day_of_week,
                    day_offset,
                    window_start,
                    window_end,
                    lunch_slots,
                )
                left: list[cp_model.Domain | None] = []
                for forbidden in (
                    blocked_starts.get((group_id, day_index)),
                    closed_starts.get((group_id, day_index)),
                ):
                    left.append(
                        self._admissible_lunch_starts(
                            day_offset, window_start, window_end, lunch_slots, forbidden,
                        )
                        if forbidden
                        else None,
                    )
                starts[(group_id, day_index)] = _LunchStarts(
                    window=cp_model.Domain(
                        day_offset + window_start, day_offset + window_end - lunch_slots,
                    ),
                    declared=declared,
                    locked=left[0],
                    closed=left[1],
                )
        return starts

    def _lunch_start_domains(
        self, request: OptimizeScheduleRequest,
    ) -> dict[tuple[UUID, int], cp_model.Domain] | None:
        """The four sentences of _lunch_start_narrowings composed into one domain."""
        narrowings = self._lunch_start_narrowings(request)
        if narrowings is None:
            return None
        return {key: parts.composed() for key, parts in narrowings.items()}

    def _lunch_stage_one(
        self, request: OptimizeScheduleRequest,
    ) -> tuple[ConflictAnalysis | None, dict[tuple[UUID, int], int]]:
        """The lunches alone, before the lessons: a verdict or a warm start.

        The first reproduction of the timeout report. Years 4-6 are framed
        08:00-13:30 — exactly five hour-long lessons and one thirty-minute
        meal — so a five-lesson day is packed and its lunch can only start at
        11:00 or 12:00; twenty-four lessons a week at most five a day force
        four packed days per class; two disjoint sittings of floor(115/24) =
        4 classes seat eight packed class-days a day, forty a week, and eleven
        classes need forty-four. A counting argument over all fifty-five
        class-days at once, which CP-SAT's clause learning never assembled
        from the full model's per-slot encoding in 60 s: UNKNOWN, reported as
        TIMEOUT, on a week that has no timetable.

        A model of ONLY the lunch starts finds it in under a second: one
        boolean per start in the window, one linear seat row per slot — equal
        coefficients that presolve divides down to "at most four classes
        here" — and a per-day lesson count bounded by what the clique's free
        time holds around the chosen start. Measured on this week: the rows
        prove it in 0.2 s; the full model's cumulative in their place takes
        4 s, and beside them adds nothing, so it is not built here. The panel
        that found the encoding saw the cumulative with element-bounded caps
        stay UNKNOWN at 15 s. The 0.2 s is a portfolio's, not a model's: one
        subsolver finds the proof, and CP-SAT starts it only from four
        workers up — see LUNCH_STAGE_WORKERS.

        EVERY CONSTRAINT HERE RELAXES ONE THE FULL MODEL ENFORCES, which is
        what makes INFEASIBLE here INFEASIBLE for the week: the starts are the
        model's own four sentences (_lunch_start_narrowings); the seat rows
        say per slot exactly what the model's cumulative says over
        fixed-length intervals; the day count is the hours verdict's
        arithmetic, with the school's maximum lessons per day on top. Rasts,
        rooms, teachers and the lessons' actual placement are simply absent,
        and absence only widens.

        NAMED BY DELETION, not by a rule of thumb and not by CP-SAT's
        assumption cores. The first version named "the classes that cannot
        avoid a packed day", which is one way a week fails and not the way a
        real one did: twenty-four classes with no lessons at all, sent to a
        hall of 115 seats, cannot be seated in five thirty-minute waves — no
        packed day anywhere — and the school read "0 class(es)". Assumption
        literals were tried next and could not reproduce the proof in ten
        seconds: with assumptions CP-SAT runs one thread and keeps presolve
        from the very rewriting that IS the proof. So every sentence the
        stage builds — a class at school, its lessons, the hall, a sitting or
        frame, a lock, a reservation — is a literal the fast solve can pin
        either way, and _name_lunch_causes drops sentences while the week
        stays impossible. What is left is a sufficient set, from the first
        solve to the last, so running out of time mid-way still names
        truthfully; the summary says the set is sufficient, not smallest.

        On a feasible week the stage costs at most its cap and repays part of
        it: its starts are hinted into the existence search (measured 1.3x on
        a plain school with seats, 1.04x without). On UNKNOWN it costs the cap
        and decides nothing, and the full solve proceeds unhinted. Returns
        (verdict, hints): a verdict when the week is refused, else the chosen
        starts, empty when the stage could not decide.
        """
        narrowings = self._lunch_start_narrowings(request)
        if narrowings is None:
            return None, {}
        if any(parts.composed().is_empty() for parts in narrowings.values()):
            # A sitting and a lock that each leave a start and together leave
            # none. _validate_request refuses that by name before any solve;
            # kept because CP-SAT calls a model with an empty domain invalid,
            # and a direct caller must not be able to hand it one.
            return None, {}
        stage = self._build_lunch_stage(request, narrowings)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.LUNCH_STAGE_CAP_SECONDS
        solver.parameters.num_workers = self.LUNCH_STAGE_WORKERS
        started = time.monotonic()
        code = solver.Solve(stage.pinned(set()))
        logger.info(
            "lunch stage: %s in %.2fs over %d lunch starts",
            solver.StatusName(code), time.monotonic() - started, len(stage.starts),
        )
        if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None, {key: solver.Value(start) for key, start in stage.starts.items()}
        if code != cp_model.INFEASIBLE:
            return None, {}
        return self._name_lunch_causes(request, stage), {}

    def _build_lunch_stage(
        self,
        request: OptimizeScheduleRequest,
        narrowings: dict[tuple[UUID, int], _LunchStarts],
    ) -> _LunchStage:
        """The stage model with every sentence behind a literal of its own.

        Literals are left FREE here; _LunchStage.pinned fixes each one true
        or false per solve. Pinned true they are unit clauses presolve folds
        away, so the first solve is the plain model. Pinned false they drop
        the sentence: a class not at school chooses no start and takes no
        seat, the hall has no limit, a narrowing does not apply, a clique's
        count is not made.
        """
        rules = request.rules
        _, _, lunch_slots = self._lunch_window_slots(rules)
        headcounts = _lunch_headcounts(request.groups)
        seats = rules.dining_seats
        max_per_day = rules.max_lessons_per_day_per_group
        slots_per_day = self._grid.slots_per_day
        hall_open = seats is not None and any(
            headcounts.get(group_id, 0) > 0 for group_id, _ in narrowings
        )

        model = cp_model.CpModel()
        starts: dict[tuple[UUID, int], cp_model.IntVar] = {}
        choices: dict[tuple[UUID, int], dict[int, cp_model.IntVar]] = {}
        load: dict[int, list[tuple[int, cp_model.IntVar]]] = defaultdict(list)
        literals: dict[tuple[str, UUID | None], cp_model.IntVar] = {}

        def sentence(cause: str, group_id: UUID | None) -> cp_model.IntVar:
            key = (cause, group_id)
            literal = literals.get(key)
            if literal is None:
                literal = literals[key] = model.NewBoolVar(f"{cause}_{group_id}")
            return literal

        for (group_id, day_index), parts in narrowings.items():
            present = sentence("eats", group_id)
            start = model.NewIntVarFromDomain(parts.window, f"lunchstart_{group_id}_{day_index}")
            options = {
                slot: model.NewBoolVar(f"lunchat_{group_id}_{day_index}_{slot}")
                for lo, hi in _domain_intervals(parts.window)
                for slot in range(lo, hi + 1)
            }
            # Exactly one start while the class is at school. Nothing at all
            # otherwise — not even "at most one": the start literals are free
            # variables, all-zero is always open to them, and a solve looking
            # for a solution never fills a hall it does not have to, so a
            # constraint saying so could not change one verdict. (Tried; it
            # did not.)
            model.Add(sum(options.values()) == 1).OnlyEnforceIf(present)
            model.Add(
                start == sum(slot * literal for slot, literal in options.items()),
            ).OnlyEnforceIf(present)
            for cause in ("declared", "locked", "closed", "pinned"):
                narrowing = getattr(parts, cause)
                if narrowing is None:
                    continue
                outside = [
                    literal for slot, literal in options.items() if not narrowing.contains(slot)
                ]
                if outside:
                    model.Add(sum(outside) == 0).OnlyEnforceIf(sentence(cause, group_id))
            starts[(group_id, day_index)] = start
            choices[(group_id, day_index)] = options
            headcount = headcounts.get(group_id, 0)
            if hall_open and headcount > 0:
                for slot, literal in options.items():
                    for occupied in range(slot, slot + lunch_slots):
                        load[occupied].append((headcount, literal))
        if load:
            hall = sentence("hall", None)
            for terms in load.values():
                model.Add(
                    sum(headcount * literal for headcount, literal in terms) <= seats,
                ).OnlyEnforceIf(hall)

        window_texts: dict[UUID, str | None] = {}
        for group, clique in self._cliques(request):
            window_texts[group.id] = clique.window_text
            measure = clique.measure
            by_member: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
            for requirement in clique.requirements:
                by_member[requirement.student_group_id].append(requirement)
            # Each member places at most its weekly lessons, and at most the
            # school's daily maximum, on one day — each no longer than its
            # longest. A bound on the count, not a placement.
            member_cap = 0
            for member_requirements in by_member.values():
                weekly = sum(r.lessons_per_week for r in member_requirements)
                longest = max(
                    self._grid.minutes_to_slots(r.minutes_per_lesson) for r in member_requirements
                )
                per_day = weekly if max_per_day is None else min(weekly, max_per_day)
                member_cap += per_day * longest

            def held(ranges: list[tuple[int, int]]) -> int:
                return min(_holds(ranges, measure), member_cap) // measure

            lessons = sentence("lessons", group.id)
            day_counts = []
            for day_index, free in clique.free_by_day.items():
                base = day_index * slots_per_day
                options = choices.get((group.id, day_index))
                if options is None:
                    count = model.NewIntVar(0, held(free), f"lessons_{group.id}_{day_index}")
                else:
                    caps = {
                        slot: held(_subtract_range(free, (slot - base, slot - base + lunch_slots)))
                        for slot in options
                    }
                    count = model.NewIntVar(0, max(caps.values()), f"lessons_{group.id}_{day_index}")
                    # A class the naming leaves out chooses no start, and this
                    # bound would then read that as a day with no room at all
                    # — which is why the naming drops a class's sentences
                    # together, never its presence alone.
                    model.Add(
                        count <= sum(caps[slot] * literal for slot, literal in options.items()),
                    ).OnlyEnforceIf(lessons)
                day_counts.append(count)
            model.Add(measure * sum(day_counts) == clique.demand).OnlyEnforceIf(lessons)

        return _LunchStage(
            model=model, starts=starts, literals=literals, headcounts=headcounts,
            window_texts=window_texts,
        )

    def _name_lunch_causes(
        self, request: OptimizeScheduleRequest, stage: _LunchStage,
    ) -> ConflictAnalysis:
        """Which sentences the refusal needs, by dropping the ones it does not.

        Every solve here re-proves the week impossible with fewer sentences
        pinned, so the set still pinned is sufficient at every step — which
        is what lets the deadline cut the search anywhere and the answer stay
        true. Coarse before fine: the hall alone, then each kind of narrowing
        for the whole school, then the lessons for the whole school, then the
        classes in chunks that split only when a chunk turns out to matter.
        A solve that cannot decide in the time left counts as "needed", the
        conservative reading.
        """
        rules = request.rules
        seats = rules.dining_seats
        deadline = time.monotonic() + self.LUNCH_STAGE_CAP_SECONDS
        relaxed: set[tuple[str, UUID | None]] = set()

        def still_impossible(extra: set[tuple[str, UUID | None]]) -> bool | None:
            """True when the week stays impossible with `extra` dropped too;
            None when the clock ran out before CP-SAT could say."""
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = remaining
            # The stage's portfolio, not the host's: a naming solve that
            # cannot re-prove the week keeps its sentences, and on a small
            # host every one of them would.
            solver.parameters.num_workers = self.LUNCH_STAGE_WORKERS
            code = solver.Solve(stage.pinned(relaxed | extra))
            if code == cp_model.INFEASIBLE:
                return True
            if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                return False
            return None

        def drop_if_unneeded(candidates: set[tuple[str, UUID | None]]) -> None:
            if candidates and still_impossible(candidates):
                relaxed.update(candidates)

        by_cause: dict[str, set[tuple[str, UUID | None]]] = defaultdict(set)
        for key in stage.literals:
            by_cause[key[0]].add(key)

        # The hall is the difference when the week is refused with its seats
        # and not without them — the one question the summary leads with.
        hall = by_cause.get("hall", set())
        seats_matter: bool | None = False
        if hall:
            without = still_impossible(hall)
            # None: the clock ran out before the question was answered. The
            # hall then stays pinned — sufficiency needs nothing dropped
            # unproved — and the summary says neither "the hall" nor "not".
            seats_matter = None if without is None else not without
            if seats_matter is False:
                relaxed.update(hall)
        for cause in ("pinned", "declared", "closed", "locked", "lessons"):
            drop_if_unneeded(by_cause.get(cause, set()))

        # The classes, in chunks: a chunk that can go, goes whole; one that
        # cannot is split until the classes that matter stand alone.
        classes = [group_id for (cause, group_id) in stage.literals if cause == "eats"]

        def sentences_of(group_ids: list[UUID]) -> set[tuple[str, UUID | None]]:
            return {key for key in stage.literals if key[1] in set(group_ids)}

        def prune(chunk: list[UUID]) -> None:
            candidates = sentences_of(chunk) - relaxed
            if not candidates:
                return
            verdict = still_impossible(candidates)
            if verdict is True:
                relaxed.update(candidates)
            elif verdict is False and len(chunk) > 1:
                half = len(chunk) // 2
                prune(chunk[:half])
                prune(chunk[half:])

        chunk_size = max(1, -(-len(classes) // 4))
        for index in range(0, len(classes), chunk_size):
            prune(classes[index:index + chunk_size])

        kept = {key for key in stage.literals if key not in relaxed}
        named = sorted(
            {group_id for (_, group_id) in kept if group_id is not None},
            key=lambda group_id: classes.index(group_id),
        )
        children = sum(stage.headcounts.get(group_id, 0) for group_id in named)

        def named_for(cause: str) -> list[UUID]:
            return [group_id for group_id in named if (cause, group_id) in kept]

        details: list[ConflictDetail] = []
        if seats_matter is not False:
            details.append(ConflictDetail(
                category="DINING_CAPACITY",
                code="LUNCH_SEATS_CAP",
                params={"seats": seats},
            ))
        # One sentence per cause, the same for every class, with the classes
        # in the ids: a school reads one line, not twenty-four copies of it.
        if named_for("eats"):
            details.append(ConflictDetail(
                category="LUNCH_WINDOW" if seats_matter is False else "DINING_CAPACITY",
                code=(
                    "LUNCH_CLASSES_EAT_DAILY"
                    if seats_matter is False
                    else "LUNCH_CLASSES_FILL_THE_HALL_DAILY"
                ),
                resource_ids=named_for("eats"),
            ))
        # The lessons, quoting the frame that packs the day where there is
        # one to quote: in the frame reproduction the frame IS the lever, and
        # a line that only said "lessons" sent the school to its timplan.
        # One line per distinct frame, so classes under different frames are
        # not put under one sentence that fits neither. Two codes rather than
        # one with an optional clause: a translator cannot inflect a sentence
        # around a hole that is sometimes empty.
        by_window: dict[str | None, list[UUID]] = defaultdict(list)
        for group_id in named_for("lessons"):
            by_window[stage.window_texts.get(group_id)].append(group_id)
        for window_text, group_ids in by_window.items():
            details.append(ConflictDetail(
                category="LUNCH_WINDOW",
                code=(
                    "LUNCH_LESSONS_FILL_THE_FRAMED_DAY"
                    if window_text
                    else "LUNCH_LESSONS_FILL_THE_DAY"
                ),
                params={"window": window_text} if window_text else {},
                resource_ids=group_ids,
            ))
        for cause, category, code in (
            ("pinned", "LUNCH_WINDOW", "LUNCH_STARTS_PLACED_BY_HAND"),
            ("declared", "LUNCH_WINDOW", "LUNCH_STARTS_NARROWED_BY_SITTING_OR_FRAME"),
            ("locked", "GROUP_OVERLAP", "LUNCH_STARTS_TAKEN_BY_LOCKED_LESSONS"),
            ("closed", "AVAILABILITY", "LUNCH_STARTS_TAKEN_BY_RESERVATION"),
        ):
            group_ids = named_for(cause)
            if group_ids:
                details.append(ConflictDetail(
                    category=category, code=code, resource_ids=group_ids,
                ))

        # Three summaries rather than one with a substituted lead: a lead
        # built here would arrive at the translator as a finished English
        # sentence with a Swedish tail stapled to it.
        if seats_matter is None:
            code = "LUNCH_NO_PLACEMENT_SEATS_UNDECIDED"
            params: dict[str, str | int] = {"seats": seats, "classes": len(named)}
        elif seats_matter:
            code = "LUNCH_HALL_CANNOT_SEAT_CLASSES"
            params = {
                "seats": seats,
                "classes": len(named),
                "students": children,
                "lunchMinutes": rules.lunch_minutes,
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
            }
        else:
            code = "LUNCH_NO_PLACEMENT_FOR_CLASSES"
            params = {"classes": len(named)}
        return ConflictAnalysis(
            summary_code=code, summary_params=params, conflicts=details,
        )

    def _explain_infeasible(
        self,
        request: OptimizeScheduleRequest,
    ) -> OptimizeScheduleResponse:
        """Re-solve with assumptions so CP-SAT can name the guilty constraints.

        Only reached once the fast build has already *proved* infeasibility.
        This second solve is the single-threaded one, which is affordable here:
        it runs on a payload that has no timetable, where a precise explanation
        is the whole value of the response.

        If it cannot reproduce the proof within the budget, the verdict still
        stands — it was proved by the first solve — and the response degrades to
        an unexplained INFEASIBLE rather than an invented explanation.
        """
        # WITH the objective, though the proof came from a model without one,
        # and that is not an oversight. Dropping it here shortens some solves —
        # measured on the lunch-bounded rast payload, UNKNOWN at the 15-second
        # cap becomes INFEASIBLE in 5.3 s with the rule named — but a
        # sufficient assumption set is not unique, and the objective-free model
        # answers an oversubscribed week with INSUFFICIENT_RESOURCES where this
        # one names ROOM_CAPACITY. Trading one school's precise cause for
        # another's is a change that needs its own measurement across the
        # refusal suite, not a line borrowed from a rast fix.
        model, registry, _, _, _ = self._build_model(request, use_assumptions=True)
        solver = cp_model.CpSolver()
        # Capped, because the verdict is already in. Measured: a payload phase 1
        # proves INFEASIBLE in under a second can keep this single-threaded
        # assumption solve busy for the whole budget and still hand back
        # nothing — 60 s of waiting for an explanation that does not come. An
        # unexplained INFEASIBLE after fifteen seconds says the same thing as
        # one after sixty, and the school has its answer forty-five seconds
        # sooner.
        solver.parameters.max_time_in_seconds = min(
            self._settings.solver_max_time_seconds, self.EXPLAIN_CAP_SECONDS,
        )
        conflicts = None
        if solver.Solve(model) == cp_model.INFEASIBLE:
            conflicts = build_conflict_analysis(solver, registry)
        return OptimizeScheduleResponse(
            request_id=request.request_id,
            status="INFEASIBLE",
            lessons=[],
            conflicts=conflicts,
        )

    # A phase below this gets no real search done — it is all presolve — so a
    # smaller remainder is not worth a second solve and the winning phase-1
    # schedule is returned directly.
    MIN_PHASE_SECONDS = 0.5
    # Ceiling on the assumption re-solve that names an INFEASIBLE's causes. The
    # verdict is proved before it runs; this only decides how long the school
    # waits for the names.
    EXPLAIN_CAP_SECONDS = 15.0
    # Cap on the objective-free build's slice of phase 1. Beyond mid-size
    # schools it stops converging at all (>240s at 1,000 students), so letting
    # it run longer only starves the encoding that does work there.
    CLEAN_SAT_CAP_SECONDS = 60.0
    # Cap on the lunch stage that runs before the models are built. On a week
    # it refuses it has paid for itself many times over; on a feasible week
    # this is the most it can cost, and its starts are hinted onward.
    LUNCH_STAGE_CAP_SECONDS = 10.0
    # The lunch stage's workers, pinned rather than read off the host. CP-SAT
    # runs one worker per core by default, and WHICH subsolvers it runs
    # depends on how many: reproduction G is proved by max_lp_sym as it loads
    # the model, and CP-SAT 9.15 starts max_lp_sym only from four workers up.
    # Measured 2026-09-11 on that week: 4 or 8 workers INFEASIBLE in 0.1 s;
    # 2 workers, where default_lp must search for what max_lp_sym sees while
    # loading, 7.7-9.2 s over five payloads and once not at all — at the cap,
    # and whatever it leaves is what the naming gets, which on that run kept
    # all twenty classes instead of the eleven that matter. 1 worker decided
    # nothing. CI's two-core runner fell the wrong way every run since the
    # stage landed, refusing nothing and running on into a 60 s TIMEOUT,
    # while an eight-core laptop passed — a verdict that depends on the
    # machine is not a verdict about the week. On a smaller host the eight
    # share its cores: 0.2 s for that week in a container held to two CPUs.
    # Eight rather than the four that suffice today: margin if a later CP-SAT
    # reorders its portfolio, and the stage's tests would then fail on every
    # host alike.
    LUNCH_STAGE_WORKERS = 8

    def solve(self, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        """Two-phase solve: prove a timetable exists, then improve it.

        A single solve of the optimising model stops producing anything beyond
        ~400 students: CP-SAT hunts for a first solution of the full objective
        model and finds none within budget, so the response is TIMEOUT with
        zero lessons. Splitting existence from quality changes what the budget
        buys — measured on the benchmark school, one solve vs this method:

            750 students    nothing -> valid timetable well inside 120s
            1,300 students  nothing -> valid timetable in ~9 min

        Phase 1 proves existence with a SEQUENTIAL PORTFOLIO of two
        satisfaction encodings, because neither dominates (measured, seconds
        to first solution):

            students        250    400    500     1000
            clean build     3.6    8.3   35.4    >240 (fails)
            cleared clone   9.4   19.5   44.4      82

        The "clean" model is a fresh build without the objective builders; the
        "clone" is the full model with the objective cleared, which keeps the
        objective's auxiliary variables as free variables. Intuition says the
        smaller clean model should always win; at 1,000 students it is the
        clone that solves and the clean build that fails, reproducibly. So the
        clean build runs first (capped — see CLEAN_SAT_CAP_SECONDS), and the
        clone takes the remaining budget if needed. Both share the full
        model's constraint set exactly, so an INFEASIBLE from either is a real
        proof, and either schedule already satisfies every hard rule.

        Phase 2 re-solves the full model with every decision hinted to the
        winning phase-1 values — starting from a solution instead of searching
        for one — in whatever time remains. If it cannot produce a solution in
        that remainder, the phase-1 schedule is returned: a solver holding a
        valid timetable must never answer "nothing". It is reported as
        FEASIBLE, never as phase 1's raw status — a satisfaction solve calls
        any solution OPTIMAL, which would misstate an objective it never
        evaluated.
        """
        self._validate_request(request)
        # Arithmetic first, models second: a hall the school cannot fit in is
        # decided here in microseconds and reported the way a solve would have.
        verdict = self._dining_hall_verdict(request) or self._clique_hours_verdict(request)
        if verdict is not None:
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=verdict,
            )
        # Then the lunches alone: a small model that proves what the full one
        # could not in a minute, or hands it a warm start. See _lunch_stage_one.
        verdict, lunch_hints = self._lunch_stage_one(request)
        if verdict is not None:
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=verdict,
            )

        rooms = request.rooms
        model, _, decisions, room_plan, lunch_full = self._build_model(
            request, use_assumptions=False, include_objective=True,
        )
        feas_model, _, feas_decisions, feas_plan, lunch_feas = self._build_model(
            request, use_assumptions=False, include_objective=False,
        )

        total_budget = self._settings.solver_max_time_seconds
        started = time.monotonic()

        def _remaining() -> float:
            return total_budget - (time.monotonic() - started)

        # Warm start: the previous schedule's slots seed the existence search.
        # Measured on the benchmark school, this is the difference between
        # minutes of satisfaction search and settling into last term's shape
        # in seconds — see the warm-start table in verification-baseline.md.
        self._hint_previous_lessons(feas_model, feas_decisions, request.previous_lessons)
        # The lunch stage's starts as well: a school's meals settled before its
        # lessons are searched. Different variables from the ones above, so no
        # hint names a variable twice.
        for key, slot in lunch_hints.items():
            if key in lunch_feas:
                feas_model.AddHint(lunch_feas[key], slot)

        # ---- phase 1a: clean satisfaction build -----------------------------
        phase1 = cp_model.CpSolver()
        phase1.parameters.max_time_in_seconds = min(
            total_budget, self.CLEAN_SAT_CAP_SECONDS,
        )
        phase1_code = phase1.Solve(feas_model)

        # MODEL_INVALID is a bug in model construction, not a property of the
        # school's data — surface it as a server error instead of dressing it
        # up as a scheduling verdict.
        if phase1_code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the generated model: {feas_model.Validate()}"
            raise SolverBuildError(msg)

        # Conflict analysis is only meaningful once CP-SAT has *proved*
        # infeasibility, and the proof needs the assumptions field, which
        # these builds leave empty so the search can use every core.
        # Explaining the failure means rebuilding — paid only on a payload
        # that has no timetable.
        if phase1_code == cp_model.INFEASIBLE:
            return self._explain_infeasible(request)

        if phase1_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            winner_solver: cp_model.CpSolver = phase1
            winner_decisions = feas_decisions
            winner_plan = feas_plan
            winner_lunch = lunch_feas
            # The two builds iterate the same request in the same order, so
            # their decision lists and room-class literal maps correspond
            # one-to-one. Guarded rather than assumed: hinting mismatched
            # variables would silently corrupt the search.
            if (
                len(decisions) != len(feas_decisions)
                or set(room_plan.literals) != set(feas_plan.literals)
                # The lunch keys as well: the two builds must agree on which
                # groups eat on which days, or the map read below belongs to a
                # different school week than the one being returned.
                or set(lunch_full) != set(lunch_feas)
            ):
                msg = "objective-free and full builds disagree on model structure"
                raise SolverBuildError(msg)
            hint_pairs = list(zip(decisions, feas_decisions))
            hint_literals = [
                (literal, feas_plan.literals[key][class_index])
                for key, literals in room_plan.literals.items()
                for class_index, literal in literals.items()
            ]
        else:
            # ---- phase 1b: the cleared clone takes what is left -------------
            remaining = _remaining()
            if remaining < self.MIN_PHASE_SECONDS:
                logger.warning(self._timeout_diagnosis(request, "phase 1a used the whole budget"))
                return OptimizeScheduleResponse(
                    request_id=request.request_id,
                    status="TIMEOUT",
                    lessons=[],
                    conflicts=self._probe_timeout(request),
                )
            clone_model = model.Clone()
            clone_model.ClearObjective()
            phase1b = cp_model.CpSolver()
            phase1b.parameters.max_time_in_seconds = remaining
            phase1b_code = phase1b.Solve(clone_model)

            if phase1b_code == cp_model.MODEL_INVALID:
                msg = f"CP-SAT rejected the generated model: {clone_model.Validate()}"
                raise SolverBuildError(msg)
            if phase1b_code == cp_model.INFEASIBLE:
                return self._explain_infeasible(request)
            if phase1b_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                logger.warning(self._timeout_diagnosis(request, "neither satisfaction encoding found a timetable"))
                return OptimizeScheduleResponse(
                    request_id=request.request_id,
                    status="TIMEOUT",
                    lessons=[],
                    conflicts=self._probe_timeout(request),
                )
            # Clone() preserves variable indices, so the full model's own
            # variables read their values straight off the clone's solver.
            winner_solver = phase1b
            winner_decisions = decisions
            winner_plan = room_plan
            winner_lunch = lunch_full
            hint_pairs = [(decision, decision) for decision in decisions]
            hint_literals = [
                (literal, literal)
                for literals in room_plan.literals.values()
                for literal in literals.values()
            ]

        def _phase1_response() -> OptimizeScheduleResponse:
            lessons = self._extract_lessons(
                winner_solver, winner_decisions, rooms, winner_plan,
            )
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="FEASIBLE",
                lessons=lessons,
                lunches=self._lunches_of(winner_solver, winner_lunch, request.rules),
                conflicts=None,
            )

        remaining = _remaining()
        if remaining < self.MIN_PHASE_SECONDS:
            return _phase1_response()

        # ---- phase 2: improve the schedule in the remaining budget ----------
        # _add_disruption_objective already hints previous-lesson slots; they
        # must yield to the complete phase-1 solution — CP-SAT rejects a model
        # whose hint names the same variable twice, and a full feasible
        # assignment is a strictly stronger starting point than a partial
        # guess.
        model.ClearHints()
        for decision, source in hint_pairs:
            model.AddHint(decision.start, winner_solver.Value(source.start))
            model.AddHint(decision.room_index, winner_solver.Value(source.room_index))
        for literal, source_literal in hint_literals:
            model.AddHint(literal, winner_solver.Value(source_literal))

        phase2 = cp_model.CpSolver()
        phase2.parameters.max_time_in_seconds = remaining
        phase2_code = phase2.Solve(model)
        if phase2_code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the generated model: {model.Validate()}"
            raise SolverBuildError(msg)

        if phase2_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            lessons = self._extract_lessons(phase2, decisions, rooms, room_plan)
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status=self._map_status(phase2_code),
                lessons=lessons,
                # lunch_full, not winner_lunch: phase 2 solved the full model.
                lunches=self._lunches_of(phase2, lunch_full, request.rules),
                conflicts=None,
            )

        # Phase 2 came up empty: fall back to the phase-1 schedule rather than
        # returning nothing. FEASIBLE, deliberately.
        return _phase1_response()

    def _hint_previous_lessons(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
    ) -> int:
        """Warm-start a model from the previous schedule's placements.

        One hint per previous slot, on one not-yet-hinted lesson instance of
        the same requirement — the same pairing _add_disruption_objective uses
        for its penalty terms, so the hint and the objective pull toward the
        same assignment.

        This exists because the two-phase split silently disabled the warm
        start: the hints used to ride along inside _add_disruption_objective,
        which the objective-free phase-1a build never runs, and phase 2 clears
        all hints in favour of the phase-1 solution. Phase 1a must therefore
        be hinted explicitly. (Phase 1b needs no call — it clones the full
        model, inheriting the disruption builder's own hints.)

        Hints are guidance, not constraints: a stale slot — say the teacher it
        belonged to has a new unavailability — costs nothing beyond the search
        repairing that part of the schedule.

        Returns the number of hints installed.
        """
        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        hinted: set[str] = set()
        for previous in previous_lessons:
            candidates = by_requirement.get(previous.requirement_id)
            if not candidates:
                continue
            try:
                start_slot = self._grid.parse_hhmmss(previous.start_time)
                abs_slot = self._grid.absolute_start(previous.day_of_week, start_slot)
            except ValueError:
                continue  # off-grid previous slot — nothing to warm-start from
            for decision in candidates:
                if decision.lesson.key() not in hinted:
                    model.AddHint(decision.start, abs_slot)
                    hinted.add(decision.lesson.key())
                    break
        return len(hinted)

    def _estimate_model_size(self, request: OptimizeScheduleRequest) -> int:
        """Predict the variable count of the model this request would build.

        Computed in O(requirements + constraints + rooms) without building
        anything, one term per builder:

            3L              decisions          start, end, room_index per lesson
            L               capacity           one pinned literal per lesson
            L x classes     room allocator     one class literal per eligible
                                               class; bounded by the distinct
                                               (type, capacity) signatures plus
                                               the identity-pinned rooms
            2 x affected    availability +     before/after (or preference)
                            preference         booleans per touched lesson;
                                               ROOM-kind constraints touch every
                                               lesson and add an assignment
                                               literal each, and a GRADE_LEVEL
                                               one is charged as if every group
                                               shared the year
            (1 + D)L + GD   rules              day var per lesson, on-day
                            + GD if locks      boolean per lesson-day, one lunch
                            + 1 if seats       start per group-day. G counts
                                               every group that eats — the ones
                                               with lessons plus the ones only
                                               `groups` names, since a class
                                               whose week is locked still gets a
                                               break. Locked lessons add one
                                               literal per group-day whose lunch
                                               they narrow; which pairs those
                                               are needs a fixed-lessons x
                                               groups scan, so the worst case is
                                               charged instead, as the ROOM
                                               branch above also does. A seat
                                               limit adds exactly one variable
                                               however big the school: its
                                               cumulative reuses those same
                                               starts through optional
                                               intervals, and every one of them
                                               is present on the single
                                               registered dining literal, so the
                                               literal is the whole cost
            pairs(req)      spread             one boolean per same-requirement
                                               lesson pair
            2 x pairs(t)    teacher gap        boolean + gap var per
                                               same-teacher pair, mirroring the
                                               builder's own skip of any teacher
                                               above 600 pairs
            2P              disruption         per previous lesson
            RD(2L + G) + G  rast ordering      an `inside` and a `late` flag per
                                               lesson, and a `still_here`
                                               literal per class, for every day
                                               and every rast that asks for a
                                               lesson before it, plus one
                                               assumption literal per class for
                                               the week. Zero unless a rast
                                               asks; the minutes a rast reserves
                                               cost no variables at all

        On the 2,000-student benchmark this predicts ~99.6K against a measured
        92,546 — an upper bound within 8%. If a builder's encoding changes,
        change its term here in the same commit; the benchmark check is
        `benchmarks/solve_2000_students.py --json | grep -i complexity`.
        """
        lessons_per_requirement = {
            requirement.id: requirement.lessons_per_week
            for requirement in request.requirements
        }
        total_lessons = sum(lessons_per_requirement.values())
        day_count = len(self._grid.schedule_days)

        lessons_by_teacher: dict[UUID, int] = {}
        lessons_by_group: dict[UUID, int] = {}
        spread_pairs = 0
        for requirement in request.requirements:
            count = requirement.lessons_per_week
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id):
                if teacher_id is not None:
                    lessons_by_teacher[teacher_id] = (
                        lessons_by_teacher.get(teacher_id, 0) + count
                    )
            lessons_by_group[requirement.student_group_id] = (
                lessons_by_group.get(requirement.student_group_id, 0) + count
            )
            spread_pairs += count * (count - 1) // 2

        # The room-class partition merges rooms whose eligibility signature is
        # identical. Two rooms share a signature only if they agree on every
        # field _room_allowed reads FROM THE ROOM — type, capacity and the
        # room's own stage limits — and on which preferences name them.
        #
        # The stage limits used to be missing from this tuple, under a comment
        # asserting that (type, capacity) decided it. That was the same omission
        # that made the partition itself place year-4 lessons in a years-7-9
        # room, and here it made the bound an UNDER-estimate: the min() below
        # takes the smaller of the two, so a bound that is too low is not a
        # conservative guess but a wrong one.
        distinguished = collect_distinguished_room_ids(
            request.constraints, request.fixed_lessons,
        )
        preference_sets = [
            set(preference.room_ids)
            for preference in request.room_preferences
            if preference.kind == "WISH"
        ]
        signature_bound = len(
            {
                (
                    room.type,
                    room.capacity,
                    room.min_grade_level,
                    room.max_grade_level,
                    tuple(room.id in preferred for preferred in preference_sets),
                )
                for room in request.rooms
            },
        ) + min(len(distinguished), len(request.rooms))
        room_class_vars = total_lessons * min(signature_bound, len(request.rooms))

        affected_vars = 0
        for constraint in request.constraints:
            if constraint.resource_kind == "TEACHER":
                affected_vars += 2 * lessons_by_teacher.get(constraint.resource_id, 0)
            elif constraint.resource_kind == "STUDENT_GROUP":
                affected_vars += 2 * lessons_by_group.get(constraint.resource_id, 0)
            elif constraint.resource_kind == "GRADE_LEVEL":
                # Reaches every group whose own years overlap the reservation,
                # which is knowable only by scanning every group per constraint
                # — an O(constraints x groups) pass in a function that is
                # deliberately linear. Charged at its worst case instead, the
                # same bound the ROOM branch settles for, so the estimate stays
                # an upper bound and stays cheap.
                affected_vars += 2 * total_lessons
            else:  # ROOM: an assignment literal plus before/after for every lesson
                affected_vars += 3 * total_lessons

        # Everyone who gets a lunch start, which is more than the groups with
        # lessons: a class whose week is entirely hand-placed reaches the
        # engine only through `groups` and still eats.
        lunch_groups = len(
            _lunch_group_ids(
                request.groups,
            ),
        )
        # One literal per group-day whose lunch a locked lesson narrows, at its
        # worst case. Nothing is charged for a payload with no locked lessons,
        # which is every payload the benchmarks build.
        lunch_lock_vars = day_count * lunch_groups if request.fixed_lessons else 0
        # The same shape for the school's own reservations, which narrow the
        # lunch domain under a literal of their own. Charged only when a
        # STUDENT_GROUP row that could reach a lunch actually exists, so a
        # payload whose rules are all about teachers and rooms pays nothing.
        lunch_closure_vars = (
            day_count * lunch_groups
            if any(
                constraint.kind == "UNAVAILABLE"
                and constraint.date is None
                and constraint.resource_kind == "STUDENT_GROUP"
                for constraint in request.constraints
            )
            else 0
        )
        # Two per group-day beyond the first: a signed drift and its magnitude,
        # so a group's meal can be held to the time it ate at on its own first
        # day.
        #
        # Charged whether or not this payload has a lunch window, exactly as the
        # (1 + D)L and GD terms above are, and for the reason stated there: an
        # over-estimate on a ruleless payload is cheaper than an estimator that
        # reads the rules to decide what to charge. The seat literal stays the
        # only rules-dependent term in the whole function.
        lunch_drift_vars = (
            2 * lunch_groups * max(0, day_count - 1)
            if self._settings.weight_lunch_drift > 0
            else 0
        )
        # The seat rule's entire variable cost, charged whether or not the lunch
        # window that would build it is set — an estimate that is high by one is
        # still an upper bound.
        dining_vars = (
            1
            if request.rules is not None and request.rules.dining_seats is not None
            else 0
        )

        # _add_idle_time_objective, which replaced a pairwise encoding. The old
        # term here was `2 * pairs(t)` under a 600-pair cap that mirrored the
        # builder's own silent skip; both are gone with it. A teacher with two
        # or more lessons now costs, per day: one literal per lesson, plus
        # `first`, `last` and `idle`. Quadratic in a teacher's load became
        # linear, which is why the cap could go.
        #
        # The credit variables are NOT charged. They exist only for teachers who
        # wrote an UNAVAILABLE row on themselves, three per window, and this
        # function's own contract is an UPPER BOUND on a payload it can read —
        # counting them would mean walking the constraints a second time to
        # learn which teacher each belongs to, for a term that is zero on almost
        # every payload. Stated rather than silently omitted.
        idle_vars = 0
        if self._settings.weight_teacher_gap > 0:
            for teacher_lessons in lessons_by_teacher.values():
                if teacher_lessons >= 2:
                    idle_vars += day_count * (teacher_lessons + 3)

        # _add_rast_ordering_constraints, and the only rast term there is: the
        # minutes a rast reserves cost no variables at all, while the demand for
        # a lesson before one costs two per lesson per day per asking rast — an
        # `inside` flag and a `late` one — plus a `still_here` literal per
        # class-day-rast. Charged at the payload's total lessons rather than per
        # class, which is an over-estimate for a school whose classes each own
        # their lessons and the right bound for one where a teaching group is
        # shared: the builder reads a class's lessons THROUGH the groups that
        # share its pupils, so the per-class sums can exceed the week's lessons.
        asking_rasts = sum(1 for rast in request.rasts if rast.requires_lesson_before)
        rast_order_vars = (
            asking_rasts * day_count * (2 * total_lessons + len(request.groups))
            # And the assumption literal that lets the refusal name the rule:
            # one per class for the whole week, not one per day.
            + (len(request.groups) if asking_rasts else 0)
        )

        return (
            4 * total_lessons
            + room_class_vars
            + affected_vars
            + (1 + day_count) * total_lessons
            + day_count * lunch_groups
            + lunch_lock_vars
            + lunch_closure_vars
            # One literal per meal the school placed by hand.
            + len(request.lunch_placements)
            + lunch_drift_vars
            + dining_vars
            + spread_pairs
            + idle_vars
            + rast_order_vars
            + 2 * len(request.previous_lessons)
        )

    def _validate_request(self, request: OptimizeScheduleRequest) -> None:
        if not request.requirements:
            raise InvalidScheduleInputError.of("INPUT_NO_REQUIREMENTS")
        if not request.rooms:
            raise InvalidScheduleInputError.of("INPUT_NO_ROOMS")

        # Aggregate complexity budget — reject oversized models before building.
        total_lessons = sum(r.lessons_per_week for r in request.requirements)
        if total_lessons > self.MAX_LESSON_INSTANCES:
            raise InvalidScheduleInputError.of("INPUT_TOO_MANY_LESSONS", {
                "lessons": total_lessons, "limit": self.MAX_LESSON_INSTANCES,
            })

        estimated_size = self._estimate_model_size(request)
        if estimated_size > self.MAX_MODEL_COMPLEXITY:
            raise InvalidScheduleInputError.of("INPUT_MODEL_TOO_LARGE", {
                "variables": estimated_size, "limit": self.MAX_MODEL_COMPLEXITY,
            })

        # Resolved once for the whole request: the same map _add_room_allocation
        # builds, so a refusal here describes the model that would have been
        # built rather than a second reading of the same rows.
        locked_by_requirement = resolve_room_locks(
            request.requirements, request.room_preferences, request.rooms,
        )

        for requirement in request.requirements:
            # A duration that does not land on the grid is bad INPUT, not a
            # broken solver. `minutes_to_slots` signals it with a bare
            # ValueError, which nothing above catches — so a 40-minute lesson on
            # a 15-minute grid escaped as an unhandled exception and reached the
            # caller as a 500 with a stack trace, while the very next check in
            # this loop reports a too-long lesson as a clean 4xx. Same field,
            # same loop, two different fates.
            try:
                duration_slots = self._grid.minutes_to_slots(
                    requirement.minutes_per_lesson
                )
            except ValueError as error:
                raise InvalidScheduleInputError.of("INPUT_LESSON_LENGTH_OFF_GRID", {
                    "requirement": str(requirement.id),
                    "minutes": requirement.minutes_per_lesson,
                    "slotMinutes": self._grid.slot_minutes,
                }) from error
            if duration_slots > self._grid.slots_per_day:
                raise InvalidScheduleInputError.of("INPUT_LESSON_LONGER_THAN_DAY", {
                    "requirement": str(requirement.id),
                    "minutes": requirement.minutes_per_lesson,
                })

            # A frame narrows the start domain, and a domain can be narrowed to
            # nothing. Left to CP-SAT that is an ordinary INFEASIBLE with no
            # assumption to blame — the model simply has no variable to report —
            # so the school is told its timetable is impossible and not which
            # sentence made it so. Caught here it names the requirement, the
            # window that remains, and the lesson length that will not fit.
            if request.frame_times:
                windows = day_windows(request.frame_times, span_of(requirement), self._grid)
                widest = max(
                    (close - open_slot for open_slot, close in windows.values()),
                    default=0,
                )
                if widest < duration_slots:
                    grades = (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    )
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("FRAME_NO_WINDOW_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "remaining": remaining,
                    })

            # And a rast cuts holes in the same domain, so it can empty it the
            # same way — worse, in fact: a frame leaves one narrow window, while
            # rasts can leave several fragments none of which holds the lesson.
            # An empty domain is a proof CP-SAT reaches without touching a
            # single assumption literal, and an empty conflict core erases every
            # other cause in the payload; the school is handed
            # INSUFFICIENT_RESOURCES for a sentence it wrote itself.
            if request.rasts:
                span = span_of(requirement)
                windows = day_windows(request.frame_times, span, self._grid)
                widest = 0
                for day_index, day_of_week in enumerate(self._grid.schedule_days):
                    open_slot, close_slot = windows.get(
                        day_index, (0, self._grid.slots_per_day),
                    )
                    blocks = blocks_for(request.rasts, span, day_of_week, self._grid)
                    widest = max(
                        widest,
                        _widest_free_run(open_slot, close_slot, blocks),
                    )
                if widest < duration_slots:
                    grades = (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    )
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("RAST_NO_STRETCH_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "remaining": remaining,
                    })

            grades = (
                "any"
                if requirement.min_grade_level is None
                else _grade_span_text(
                    requirement.min_grade_level, requirement.max_grade_level,
                )
            )
            eligible_rooms = [
                room for room in request.rooms if self._room_allowed(room, requirement)
            ]
            if not eligible_rooms:
                raise InvalidScheduleInputError.of("ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT", {
                    "requirement": str(requirement.id),
                    "groupSize": requirement.student_group_size,
                    "roomType": str(requirement.required_room_type or "any"),
                    "grades": grades,
                })

            # THE LOCK GETS ITS OWN SENTENCE, and the branch is the point. The
            # message above sends a school to the room list to change a seat
            # count or a stage limit; a school whose maths is locked into a room
            # too small wrote that rule on another screen entirely, and would
            # read the sentence above and change the wrong thing.
            #
            # Checked after the general refusal so the more basic cause wins:
            # a requirement with no eligible room AT ALL has a problem the lock
            # did not create.
            locked_rooms = locked_by_requirement.get(requirement.id)
            if locked_rooms is not None:
                survivors = [
                    room for room in eligible_rooms if room.id in locked_rooms
                ]
                if not survivors:
                    raise InvalidScheduleInputError.of("ROOM_LOCK_LEAVES_NO_ROOM", {
                        "requirement": str(requirement.id), "grades": grades,
                    })

        # THE BREAKS THAT ASK FOR A LESSON, before any of the counting below:
        # a demand no stretch can hold is a contradiction between two of the
        # school's own sentences, and every verdict that follows would be
        # measuring a week the solver is about to be told to empty.
        self._verify_rast_demands(request)

        # THE WEEK, not the lesson. Every locked requirement above can have a
        # room and the set of them still not fit: three subjects locked into one
        # room, forty lessons each, against a week that holds fifty. Left to
        # CP-SAT that is an ordinary INFEASIBLE whose core names room capacity —
        # sending a school to the seat counts for a rule it wrote elsewhere.
        #
        # The bound is lesson-slots against room-slots, which is the room
        # NoOverlap's own relaxation, so violating it proves infeasibility and
        # refusing here can never refuse a week that would have worked. It
        # ignores frame times and availability, which only ever shrink the
        # supply — so it under-refuses and never over-refuses.
        by_locked_rooms: dict[frozenset[UUID], list[AnonymousRequirement]] = defaultdict(
            list,
        )
        for requirement in request.requirements:
            rooms_allowed = locked_by_requirement.get(requirement.id)
            if rooms_allowed:
                by_locked_rooms[rooms_allowed].append(requirement)

        slots_per_day = self._grid.slots_per_day
        days = len(self._grid.schedule_days)
        for rooms_allowed, group in by_locked_rooms.items():
            # Every requirement here is captive to this set by construction:
            # specificity resolution gives each ONE resolved room set, so there
            # is no choice to protect against and no requirement to exclude.
            # An earlier version filtered on base eligibility instead, which
            # asked whether the requirement could use an unlocked room — and the
            # answer is yes for exactly the requirements the lock has just taken
            # that option away from, so nothing was ever charged.
            needed = sum(
                requirement.lessons_per_week
                * self._grid.minutes_to_slots(requirement.minutes_per_lesson)
                for requirement in group
            )
            # Rooms that at least one of them could actually use. A locked room
            # too small for every requirement in the group supplies nothing, and
            # counting it would hide the very shortage this refuses.
            usable = sum(
                1
                for room in request.rooms
                if room.id in rooms_allowed
                and any(self._room_allowed(room, r) for r in group)
            )
            available = usable * days * slots_per_day
            if needed > available:
                minutes = self._grid.slot_minutes
                raise InvalidScheduleInputError.of("ROOM_LOCK_WEEK_TOO_SMALL", {
                    "requirements": len(group),
                    "rooms": usable,
                    "neededMinutes": needed * minutes,
                    "offeredMinutes": available * minutes,
                })

        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules):
            # Nothing below exists without a lunch window. A school that has
            # typed a seat count and not yet decided when lunch is has made no
            # error and must not be told it has.
            return

        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)

        if rules.dining_seats is not None and request.groups:
            # One class that does not fit in the hall makes the cumulative
            # unsatisfiable on every day of the week, whatever else the
            # timetable does. CP-SAT would spend the whole budget proving that
            # and answer INFEASIBLE without naming a class or a number.
            #
            # Reads `groups`, the same list the cumulative's demands come from.
            # Reading the requirements instead is exactly how a class whose
            # week is entirely locked slipped past both. The largest class is
            # named rather than the first one over, because its headcount is
            # the number the hall has to reach.
            largest = max(request.groups, key=lambda group: group.lunch_headcount)
            if largest.lunch_headcount > rules.dining_seats:
                raise InvalidScheduleInputError.of("LUNCH_GROUP_LARGER_THAN_HALL", {
                    "group": str(largest.id),
                    "students": largest.lunch_headcount,
                    "seats": rules.dining_seats,
                })

        # Whether locked lessons leave a group any admissible lunch start is
        # arithmetic on constants — no search decides it. Left to the model it
        # becomes an empty variable domain, and an empty domain is a proof of
        # infeasibility CP-SAT can reach without touching one assumption
        # literal, which returns an empty conflict core and takes every other
        # cause in the payload down with it. Answering here spends no solve
        # budget and names the group and the day.
        #
        # The same window arithmetic and the same reachability rule the builder
        # uses, through the same two helpers — a second rounding rule here
        # would eventually disagree with the model about when lunch is. The
        # groups that get a break are knowable without building anything:
        # every requirement carries lessons_per_week >= 1, so each one's group
        # is in `by_group` there exactly as it is in this list here.
        lunch_group_ids = _lunch_group_ids(
            request.groups,
        )
        blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
            request.fixed_lessons,
            set(lunch_group_ids),
            _groups_sharing_students(request.group_conflicts),
            window_start,
            window_end - lunch_slots,
            lunch_slots,
        )
        slots_per_day = self._grid.slots_per_day
        # Computed before either loop: an exempt day is one the school has said
        # the class is not in, and neither a locked lesson nor another rule can
        # deny it a meal it was never owed.
        closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        # THE MEALS THE SCHOOL PLACED BY HAND, before any check that would
        # refuse the day they rescue. Then every lunch refusal below skips a
        # pinned day, and the skip list is the feature: miss one and a school
        # that drew its meal to escape "locked lessons leave 4.1 no lunch gap"
        # is refused by the NEXT loop for the same class on the same day —
        # the worst thing this can do, and the default if a loop is added
        # later without it. Five places: the locks, the sitting, the captive
        # count, the reservations and the four sources together.
        pins = self._verify_lunch_placements(
            request, lunch_group_ids, exempt_days, lunch_slots,
        )
        for (group_id, day_index), forbidden in blocked_starts.items():
            if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                continue
            allowed = self._admissible_lunch_starts(
                day_index * slots_per_day,
                window_start,
                window_end,
                lunch_slots,
                forbidden,
            )
            if allowed.is_empty():
                raise InvalidScheduleInputError.of("LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", {
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": self._grid.schedule_days[day_index],
                })

        # The declarations, before either subtraction: a serving or a frame too
        # tight to hold the break empties the domain outright, and an empty
        # domain is a proof CP-SAT reaches without touching one assumption
        # literal — an empty conflict core that takes every other cause in the
        # payload down with it.
        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }
        if request.lunch_servings or request.frame_times:
            for group_id in lunch_group_ids:
                for day_index, day_of_week in enumerate(self._grid.schedule_days):
                    if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                        continue
                    declared = self._declared_lunch_domain(
                        request.lunch_servings,
                        request.frame_times,
                        span_by_group.get(group_id),
                        day_of_week,
                        day_index * slots_per_day,
                        window_start,
                        window_end,
                        lunch_slots,
                    )
                    if declared is not None and declared.is_empty():
                        raise InvalidScheduleInputError.of("LUNCH_NO_SERVING_FOR_GROUP", {
                            "group": str(group_id),
                            "minutes": rules.lunch_minutes,
                            "day": day_of_week,
                        })

        # Can the declared sittings physically feed the stages that must use
        # them? A window wide enough to hold ONE meal can still be far too small
        # for a stage's whole headcount, and that failure lands in the seat
        # cumulative — an INFEASIBLE with no assumption to name, on a payload
        # whose windows all look reasonable.
        #
        # The bound is student-minutes, which is the cumulative's own
        # relaxation: over a window of W minutes with S chairs, at most S x W
        # student-minutes can be served, and a stage of N children eating for L
        # minutes needs N x L. Violating it proves infeasibility, so refusing
        # here can never refuse a flow that would have worked.
        #
        # Counted only for groups this serving is the ONLY one open to. A group
        # with a choice of sittings could go to the other one, and charging it
        # to both would refuse schools whose overlapping windows are exactly how
        # they cope.
        if request.lunch_servings and rules.dining_seats is not None:
            headcount_by_group = _lunch_headcounts(request.groups)
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                applicable: dict[UUID, list[LunchServing]] = {}
                for group_id in lunch_group_ids:
                    # A pinned class eats where it was placed, not in this
                    # sitting, and counting it here would refuse a flow that
                    # works.
                    if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                        continue
                    matching = _servings_for(
                        request.lunch_servings, span_by_group.get(group_id), day_of_week,
                    )
                    if matching:
                        applicable[group_id] = matching

                for serving in request.lunch_servings:
                    captive = sum(
                        headcount_by_group.get(group_id, 0)
                        for group_id, options in applicable.items()
                        if options == [serving]
                    )
                    if captive == 0:
                        continue
                    seats = serving.seats if serving.seats is not None else rules.dining_seats
                    minutes = _clock_minutes(serving.end_time) - _clock_minutes(
                        serving.start_time,
                    )
                    if captive * rules.lunch_minutes > seats * minutes:
                        raise InvalidScheduleInputError.of("LUNCH_SERVING_CANNOT_FEED_STAGE", {
                            "servingStart": serving.start_time[:5],
                            "servingEnd": serving.end_time[:5],
                            "grades": _grade_span_text(
                                serving.min_grade_level, serving.max_grade_level,
                            ),
                            "students": captive,
                            "minutes": rules.lunch_minutes,
                            "seats": seats,
                        })

        # The same question of the school's own reservations. Separate loop and
        # separate sentence: a lesson to move and a rule to change are fixed in
        # two different screens, and one message covering both would send half
        # the schools to the wrong one.
        for (group_id, day_index), closed in closed_starts.items():
            if (group_id, day_index) in pins:
                continue
            allowed = self._admissible_lunch_starts(
                day_index * slots_per_day,
                window_start,
                window_end,
                lunch_slots,
                closed,
            )
            if allowed.is_empty():
                raise InvalidScheduleInputError.of("LUNCH_AVAILABILITY_LEAVES_NO_BREAK", {
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": self._grid.schedule_days[day_index],
                })

        # ALL FOUR SOURCES TOGETHER, last, because each can leave room on its own
        # while the intersection is empty. A locked lesson over the first half
        # of a sitting and a frame closing the second half is the ordinary way
        # to get there, and no single-cause loop above says a word about it.
        #
        # Left to the model this is an empty variable domain — a proof CP-SAT
        # reaches without touching an assumption literal. It does produce a
        # conflict analysis here, because the locked-lesson literal happens to
        # be in the core, but that is luck: it names one contributor of four and
        # arrives as INFEASIBLE rather than as something to fix.
        for group_id in lunch_group_ids:
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                key = (group_id, day_index)
                if key in exempt_days or key in pins:
                    continue
                allowed = self._admissible_lunch_starts(
                    day_index * slots_per_day,
                    window_start,
                    window_end,
                    lunch_slots,
                    blocked_starts.get(key, []) + closed_starts.get(key, []),
                )
                declared = self._declared_lunch_domain(
                    request.lunch_servings,
                    request.frame_times,
                    span_by_group.get(group_id),
                    day_of_week,
                    day_index * slots_per_day,
                    window_start,
                    window_end,
                    lunch_slots,
                )
                if declared is not None:
                    allowed = allowed.intersection_with(declared)
                if not allowed.is_empty():
                    continue

                # Name what is actually in play, so the sentence sends the
                # reader to the screen that holds the fix. As ONE key rather
                # than a joined list: "locked lessons and availability rules"
                # is an English list, and a language that inflects the members
                # cannot be handed it already punctuated. The sentence branches
                # on the key instead, in whatever language reads it.
                causes: list[str] = []
                if blocked_starts.get(key):
                    causes.append("locked")
                if closed_starts.get(key):
                    causes.append("closed")
                if declared is not None:
                    causes.append("declared")
                raise InvalidScheduleInputError.of("LUNCH_CAUSES_LEAVE_NO_BREAK", {
                    "causes": "_".join(causes),
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": day_of_week,
                })

    def _locks_in_stretch(
        self,
        request: OptimizeScheduleRequest,
        members: set[UUID],
        day_index: int,
        opens: int,
        first: int,
    ) -> bool:
        """Has a hand-placed lesson already taught this class in this stretch?

        A LOCKED LESSON IS A LESSON, and the rule asks whether the class was
        taught before the break, not whether the SOLVER put it there. Without
        this the engine reads a school that has hand-placed Monday 08:00-09:10
        as a class with nothing before its 09:40 break: it demands another
        lesson in a stretch the locks have already filled, cannot find one, and
        concludes the class must have gone home — deleting the rest of every
        such day. Measured on one class with three locked mornings: OPTIMAL in
        0.5 s without the rule, sixty seconds of silence with it.

        The window is the one _fixed_window rounds OUTWARD, so a lock is only
        counted when it fits inside the stretch with the rounding against it —
        which is the safe direction for a test that excuses an obligation.
        """
        base = day_index * self._grid.slots_per_day
        for fixed in request.fixed_lessons:
            if not ({fixed.student_group_id, *fixed.extra_group_ids} & members):
                continue
            window = self._fixed_window(fixed)
            if window is None:
                continue
            if base + opens <= window[0] and window[1] <= base + first:
                return True
        return False

    def _locked_after(
        self,
        request: OptimizeScheduleRequest,
        members: set[UUID],
        day_index: int,
        last: int,
    ) -> bool:
        """Is the class hand-placed into a lesson AFTER the break?

        The mirror of the test above, and it closes the other half of the same
        hole. "Still at school" is read off the lessons the solver places, so a
        class whose only afternoon is locked looked like a class that had gone
        home, and the break's demand was excused by a lesson the school had
        already written down. Here the demand is unconditional instead.
        """
        base = day_index * self._grid.slots_per_day
        for fixed in request.fixed_lessons:
            if not ({fixed.student_group_id, *fixed.extra_group_ids} & members):
                continue
            window = self._fixed_window(fixed)
            if window is not None and window[0] >= base + last:
                return True
        return False

    def _reserved_ranges(
        self,
        request: OptimizeScheduleRequest,
        requirement: AnonymousRequirement,
        day_index: int,
    ) -> list[tuple[int, int]]:
        """Day-local ranges a reservation provably keeps this requirement out of.

        The stretch before a break is measured from the calendar — the frame,
        the previous break, the meal — and a calendar cannot see a school that
        has reserved those very minutes. Measured on the payloads that survived
        the first fix: a class with a break at 11:10, a stretch of fifty roomy
        minutes behind it, and an availability row over 10:20-11:10 taking
        every one of them. Nothing fits, the rule concludes the class has gone
        home, the afternoons close, and three lessons a day against sixteen a
        week is a pigeonhole no counting argument in the model ever assembles:
        sixty seconds of silence.

        EXACTLY THE ROWS THE MODEL ITSELF APPLIES, and no others. This decides
        whether an obligation is dropped and whether a week is refused, so a row
        counted here that the solver does not enforce refuses a timetable that
        exists. Three exclusions, each for its own reason:

          A DATED ROW IS SKIPPED, because _add_availability_constraints skips
          it: the engine places a generic week and a single date is not part of
          one. Subtracting it here would refuse a week the solver would place
          without complaint — the sharpest way this could go wrong, and the
          first thing a measurement of it caught.

          A ROOM ROW IS SKIPPED, because it blocks only the lessons actually
          assigned to that room, which is a decision the solver has not made
          yet. A class is stuck only when NO eligible room is free, and that is
          not arithmetic on one row.

          ONLY UNAVAILABLE. A reservation of any other kind does not empty the
          minutes.

        The remaining three match exactly as _decisions_for_constraint matches
        them, which is the point: a teacher's row reaches the requirements that
        teacher carries, a group's row reaches its own, and a year's row
        reaches every requirement whose years OVERLAP it.
        """
        blocked: list[tuple[int, int]] = []
        day_of_week = self._grid.schedule_days[day_index]
        for constraint in request.constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.day_of_week not in (None, day_of_week):
                continue
            if constraint.resource_kind == "TEACHER":
                reaches = constraint.resource_id in (
                    requirement.teacher_id, requirement.co_teacher_id,
                )
            elif constraint.resource_kind == "STUDENT_GROUP":
                reaches = requirement.student_group_id == constraint.resource_id
            elif constraint.resource_kind == "GRADE_LEVEL":
                reaches = _grade_span_overlaps(constraint, requirement)
            else:
                reaches = False
            if not reaches:
                continue
            start = self._grid.clamp_to_grid(constraint.start_time)
            end = self._grid.clamp_to_grid(constraint.end_time)
            if start is None or end is None or end <= start:
                continue
            blocked.append((start, end))
        return blocked

    def _reserved_for_all(
        self,
        request: OptimizeScheduleRequest,
        requirements: list[AnonymousRequirement],
        day_index: int,
    ) -> list[tuple[int, int]]:
        """Minutes no requirement of this class may be taught in, today.

        The INTERSECTION of what each one is barred from, because the class is
        only barred where all of them are: a row against one teacher leaves the
        hour open to every other subject, and counting it against the class
        would shrink a week that has not shrunk.
        """
        common: list[tuple[int, int]] | None = None
        for requirement in requirements:
            blocked = self._reserved_ranges(request, requirement, day_index)
            if common is None:
                common = blocked
                continue
            common = [
                (max(a, c), min(b, d))
                for a, b in common
                for c, d in blocked
                if max(a, c) < min(b, d)
            ]
            if not common:
                return []
        return common or []

    def _room_in_stretch(
        self,
        blocked: list[tuple[int, int]],
        opens: int,
        first: int,
    ) -> int:
        """The longest unbroken run left of [opens, first) once those are gone.

        A run, not a total: a lesson needs its minutes in one piece, which is
        the same thing _widest_free_run says about a day full of rasts.
        """
        free = [(opens, first)] if first > opens else []
        for start, end in blocked:
            free = _subtract_range(free, (start, end))
        return max((end - start for start, end in free), default=0)

    def _verify_rast_demands(self, request: OptimizeScheduleRequest) -> None:
        """A break whose demand can never be met, on a week that then has no room.

        BOTH HALVES, and the second one is what makes this sound. A stretch that
        cannot hold a lesson does not by itself make a week impossible: the rule
        is satisfied just as well by a class that has GONE HOME before the
        break, and a class whose Friday ends at noon owes a 12:30 break nothing.
        Refusing on the first half alone — which is what the first version of
        this did — turns down weeks that have a timetable, and that is the worst
        answer this engine can give.

        So the arithmetic runs the whole way. When no lesson of the class can
        ever sit in the stretch, the class can never be at school after that
        break: the only remaining way to satisfy the clause is to be gone, so
        that day is worth only its minutes BEFORE the break. Cap the closed days
        that way, count what the week still holds, and refuse only when the
        class needs more than that. Then the refusal is one the model would have
        made too — it just could not make it in a minute, because the proof is a
        pigeonhole across five separate days and the search never assembles it.

        Measured: a class with an availability row over the whole stretch, 16
        lessons of 40 minutes, and mornings holding 3 a day — 15 against 16, a
        shortfall of one lesson. Sixty seconds of silence before, refused by
        name in milliseconds after.

        THE CAPACITY IS COUNTED GENEROUSLY, on purpose. No lunch is subtracted
        and no fragment is discounted beyond what _holds already does, because
        every minute this over-counts is a week that goes to the solver instead
        of being refused, and that is the direction to be wrong in.
        """
        if not any(rast.requires_lesson_before for rast in request.rasts):
            return
        by_group: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
        for requirement in request.requirements:
            by_group[requirement.student_group_id].append(requirement)

        for group, clique in self._cliques(request):
            if group.min_grade_level is None or group.max_grade_level is None:
                continue
            owned = [r for member in clique.members for r in by_group.get(member, [])]
            if not owned:
                continue

            # The days this class is shut out of the rest of, and the break that
            # shuts it — the first one found, which is the one to name.
            closed: dict[int, tuple[int, int]] = {}
            for day_index, _opens, room, first, last, meal in self._asked_stretches(
                request, (group.min_grade_level, group.max_grade_level),
            ):
                # THE BEST-PLACED REQUIREMENT DECIDES, because the demand is for
                # A lesson and not a particular one: one subject whose teacher
                # is free and whose lessons are short enough answers it for the
                # whole class. Measuring the shortest lesson alone would close a
                # day whose maths teacher is away and whose music teacher is not.
                if any(
                    self._room_in_stretch(
                        self._reserved_ranges(request, requirement, day_index), room, first,
                    ) >= self._grid.minutes_to_slots(requirement.minutes_per_lesson)
                    for requirement in owned
                ):
                    continue
                # A lesson the school placed by hand is a lesson, so a stretch
                # a lock already fills is not closed at all.
                if self._locks_in_stretch(
                    request, set(clique.members), day_index, room, first,
                ):
                    continue
                closed.setdefault(day_index, (first, last, room, meal))
            if not closed:
                continue

            rules = request.rules
            lunch_on = rules is not None and _lunch_window_is_set(rules)
            if lunch_on:
                window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
            capacity = 0
            for day_index, free in clique.free_by_day.items():
                shut = closed.get(day_index)
                if shut is not None:
                    free = [
                        (start, min(end, shut[0])) for start, end in free
                        if start < shut[0]
                    ]
                # And the minutes reserved away from EVERY requirement the
                # class has. Every one, not any: a row that stops the maths
                # teacher leaves the hour open to music, and subtracting it
                # would count a week as smaller than it is — which is the
                # direction that refuses a timetable.
                for start, end in self._reserved_for_all(request, owned, day_index):
                    free = _subtract_range(free, (start, end))
                if not lunch_on:
                    capacity += _holds(free, clique.measure)
                    continue
                # The meal placed where it wastes least, the same search the
                # hours verdict makes: the class must eat, and counting a day
                # as if it need not would over-count exactly the hour that
                # decides these weeks. Best-case, so the count stays generous
                # and a refusal stays one the model would have made.
                best = 0
                fits = False
                for start in range(window_start, window_end - lunch_slots + 1):
                    if any(a <= start and start + lunch_slots <= b for a, b in free):
                        fits = True
                        best = max(best, _holds(
                            _subtract_range(free, (start, start + lunch_slots)),
                            clique.measure,
                        ))
                # No meal fits this day at all: a refusal of its own, made
                # elsewhere by name, and not this one's to make.
                capacity += best if fits else _holds(free, clique.measure)
            if clique.demand <= capacity:
                continue

            day_index, (first, _last, room, meal) = next(iter(closed.items()))
            widest = max(
                self._room_in_stretch(
                    self._reserved_ranges(request, requirement, day_index), room, first,
                )
                for requirement in owned
            )
            minutes = self._grid.slot_minutes
            raise InvalidScheduleInputError.of("RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT", {
                "day": self._grid.schedule_days[day_index],
                "grades": _grade_span_text(group.min_grade_level, group.max_grade_level),
                "rast": self._grid.format_hhmmss(first, 0)[0][:5],
                "opens": self._grid.format_hhmmss(room, 0)[0][:5],
                "remaining": widest * minutes,
                "minutes": min(
                    self._grid.minutes_to_slots(r.minutes_per_lesson) for r in owned
                ) * minutes,
                # Which of the three took the minutes, so the school is sent to
                # the screen that holds the lever.
                "bound": (
                    "closed" if widest < first - room else "lunch" if meal else "day"
                ),
                "demandMinutes": clique.demand * minutes,
                "capacityMinutes": capacity * minutes,
            })

    def _earliest_meal_end(
        self,
        request: OptimizeScheduleRequest,
        span: tuple[int, int] | None,
        day_of_week: int,
    ) -> int:
        """The first slot this stage's meal can possibly free, today.

        THE SITTINGS COUNT, not just the school-wide window, and a stage that
        eats in the second sitting is the case this exists for: a school whose
        window opens 11:00 but whose åk 4-6 sitting is 12:00-12:45 frees those
        classes at 12:45 at the earliest, and a break at 13:00 has fifteen
        minutes before it rather than the hour the window alone suggests.

        A LOWER BOUND, deliberately, and it may only ever be raised by
        something the payload PROVES. Everything downstream skips an obligation
        or refuses a payload on this number, so an over-estimate would drop a
        rule the school asked for or refuse a week that has a timetable. The
        dining hall's seats can push a class later still — the solver decides
        that, not arithmetic — so a week narrow enough to need that reasoning
        is left to the solver, exactly as it was before.
        """
        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules):
            return 0
        window_start, _window_end, lunch_slots = self._lunch_window_slots(rules)
        starts = allowed_starts(
            request.lunch_servings, span, day_of_week, lunch_slots, self._grid,
        )
        intervals = _domain_intervals(starts) if starts is not None else []
        earliest = max(window_start, intervals[0][0]) if intervals else window_start
        return earliest + lunch_slots

    def _asked_stretches(
        self,
        request: OptimizeScheduleRequest,
        span: tuple[int, int] | None,
    ) -> list[tuple[int, int, int, int, int, bool]]:
        """A stretch a rast demands a lesson of: (day, opens, room, first, last, meal).

        ONE READER FOR TWO CALLERS, and the reason is the bug this was written
        after. The builder used to measure the stretch one way and BOUND it
        another: it skipped a lesson longer than `rast start - previous rast
        end`, then wrote the flag against `lunch start + meal` whenever the meal
        lay inside. Where the meal ended less than a lesson before the break —
        an 11:00-12:30 window with a 60-minute meal and a break at 12:30, which
        is an ordinary Swedish lunch hour — the filter measured a roomy 150
        minutes, kept every flag, and every flag was unsatisfiable. The clause
        then collapsed to "nobody is here after this break", the rule stopped
        meaning "be taught before it" and started meaning "go home at it", and
        the class lost every afternoon of the week. The week that was left was
        over capacity and infeasible, and no counting argument in the model
        could prove it: sixty seconds of silence and a TIMEOUT, on one class
        with twenty-four lessons. Measured: 0.2 s OPTIMAL without the flag.

        So the stretch is measured ONCE, honestly, and both the filter and the
        refusal read the same number.

          `opens` is where a lesson in the stretch may first START by the
          constants alone: the end of the previous break, or the frame's
          opening, whichever is later. The frame belongs here for the same
          reason the previous break does — a day that opens 09:20 has no
          08:00 — and leaving it out was half of the same bug.

          `room` is what the stretch can hold AT BEST, which is `opens` unless
          the whole lunch window lies inside it, and then the EARLIEST slot the
          meal can free. Earliest, not latest: a lesson is skipped only when no
          admissible meal leaves space for it. The latest meal end would skip
          obligations a legal early meal could still honour.

        Days the frames close entirely are absent from `day_windows` and absent
        from here: a stage with no Friday owes its Friday breaks nothing.
        """
        rules = request.rules
        lunch_on = rules is not None and _lunch_window_is_set(rules)
        if lunch_on:
            window_start, window_end, _lunch_slots = self._lunch_window_slots(rules)
        windows = day_windows(request.frame_times, span, self._grid)

        out: list[tuple[int, int, int, int, int, bool]] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            window = windows.get(day_index)
            if window is None:
                continue
            frame_open, _frame_close = window
            blocks = blocks_with_demand(request.rasts, span, day_of_week, self._grid)
            for first, last, demands in blocks:
                if not demands:
                    continue
                opens = max(
                    max((end for _start, end, _asks in blocks if end <= first), default=0),
                    frame_open,
                )
                bounded_by_lunch = (
                    lunch_on and opens <= window_start and window_end <= first
                )
                room = (
                    max(opens, self._earliest_meal_end(request, span, day_of_week))
                    if bounded_by_lunch
                    else opens
                )
                out.append((day_index, opens, room, first, last, bounded_by_lunch))
        return out

    def _add_rast_ordering_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        request: OptimizeScheduleRequest,
        decisions: list[LessonDecision],
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
    ) -> None:
        """A class still at school after a rast was taught before it.

        A rast has otherwise only been a hole in the day, and a class whose
        Monday begins at the morning break has broken no rule the engine knows.
        Measured through the whole solve on twenty-four classes: of the 110
        mornings where a class was still at school after its break, 16 had
        nothing before it, and 2 afternoons of 39. So this changes real
        schedules rather than restating what the solver already did — but the
        measurement has to be taken with the OBJECTIVE in place. A phase-1
        satisfaction solve hugs the lower bound of every domain, puts every
        lesson as early as it will go, and honours a rule about mornings by
        accident; measured there the baseline broke it not once.

        "STILL AT SCHOOL" IS THE CONDITION, not the calendar. The obligation is
        on the stretch a lesson FOLLOWS, so a class that has gone home owes
        nothing and a class whose Friday is empty owes nothing either. Written
        without it — a bare demand on every stretch of every school day — two
        asking rasts oblige every class to be taught ten times a week: measured
        on one class over five days, eight lessons was INFEASIBLE and ten the
        first count that solved.

        THE STRETCH IS COUNTED FROM THE PREVIOUS BREAK, and the class's own
        LUNCH counts as one. Read without that, "a lesson before the afternoon
        rast" is satisfied by a lesson before lunch, and the whole afternoon
        can be empty — measured, and at twenty-four classes every one of the
        hundred and twenty afternoon stretches came out that way. The lunch is
        a variable, which is the part that looked expensive and is not.

        THE WHOLE RULE IS THE EXPENSIVE ONE, and it is the only rast setting
        that makes the model bigger rather than smaller: two booleans and four
        rows per lesson per asking rast per day, about six times the variables
        of the same week without it. Measured, satisfaction phase: 0.08 s to
        3.0 s at twenty-four classes, 0.44 s to 9.6 s on a week 83% full; the
        whole solve on those twenty-four classes went 20.4 s to 38.5 s, both
        OPTIMAL and both inside the budget. That is why the flag is per rast
        and defaults false, and why a TIMEOUT probes it on its own.

        THE LUNCH BOUNDS THE STRETCH ONLY WHEN ITS WHOLE WINDOW LIES INSIDE IT.
        A lunch window straddling the rast leaves their order undecided, and
        "a lesson between them" is not a sentence about a week yet; requiring
        one anyway would refuse a schedule for a question nobody asked. That
        test is on constants and costs nothing.

        WHERE THE STRETCH IS MEASURED, _asked_stretches owns — and it is not a
        detail. Measuring it one way and bounding the flag another left every
        flag unsatisfiable on an ordinary lunch hour, which turned this clause
        into "go home at the break" and cost a school its whole afternoon and
        the engine its whole budget. Read that function before changing this
        one.

        THE CLASS'S LESSONS ARE ITS TEACHING GROUPS', the same reach the lunch
        and the hours verdict use: 4.1's maths is filed under 4ma1, and a rule
        reading only lessons filed under "4.1" would find a class with no
        lessons at all and be satisfied by nothing.

        ONE ASSUMPTION LITERAL PER CLASS, because this rule can refuse a week
        on its own — a day whose lessons will not fit before its rasts has no
        timetable — and a hard row here would be an INFEASIBLE with no
        assumption to name. The core would then be empty or made of unrelated
        rows, and the school is told its timetable is impossible without being
        told which sentence it wrote made it so; the frame and the rast
        domains already refuse that outcome by name a few hundred lines up.
        Per class rather than per row: the school reads one line naming the
        classes, and it is the class whose day the school has to change.
        """
        wanted = [rast for rast in request.rasts if rast.requires_lesson_before]
        if not wanted or not request.groups:
            return

        grid = self._grid
        slots_per_day = grid.slots_per_day
        sharing = _groups_sharing_students(request.group_conflicts)
        by_group: dict[UUID, list[LessonDecision]] = defaultdict(list)
        for decision in decisions:
            by_group[decision.lesson.requirement.student_group_id].append(decision)

        rules = request.rules
        lunch_slots = (
            self._lunch_window_slots(rules)[2]
            if rules is not None and _lunch_window_is_set(rules)
            else 0
        )

        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }

        # One read per (requirement, day) for the whole build: the same
        # requirement is looked at once per class that shares its pupils, once
        # per day, once per asking break.
        cache: dict[tuple[UUID, int], list[tuple[int, int]]] = {}

        def reserved(
            requirement: AnonymousRequirement, day_index: int,
        ) -> list[tuple[int, int]]:
            key = (requirement.id, day_index)
            if key not in cache:
                cache[key] = self._reserved_ranges(request, requirement, day_index)
            return cache[key]

        for group in request.groups:
            members = {group.id, *sharing.get(group.id, ())}
            lessons = [
                decision for member in members for decision in by_group.get(member, [])
            ]
            if not lessons:
                continue
            span = span_by_group.get(group.id)
            # Built lazily: a class no asking rast reaches adds no literal, and
            # a payload where nobody asked adds none at all.
            asks: cp_model.IntVar | None = None
            for day_index, opens, room, first, last, meal_bounds in self._asked_stretches(
                request, span,
            ):
                base = day_index * slots_per_day
                lunch_start = lunch_starts.get((group.id, day_index))
                after_lunch = meal_bounds and lunch_start is not None
                # A lesson the school placed by hand is a lesson: when one sits
                # in the stretch the demand is already met, and the cheapest
                # obligation is the one never written. `room` and not `opens`,
                # so this reads the same stretch _verify_rast_demands does —
                # see there for why the permissive end of the meal is the right
                # one to measure from.
                if self._locks_in_stretch(request, members, day_index, room, first):
                    continue
                inside = []
                for decision in lessons:
                    # A lesson too long for the stretch can never be in it,
                    # and `room` is measured against the same boundary the
                    # flag below is written against — the meal's earliest
                    # end when the meal bounds the stretch. Skipping it here
                    # is one boolean and two rows the model never sees; NOT
                    # skipping it was the timeout, because a flag that can
                    # never be true turns the clause into "go home".
                    #
                    # PER LESSON, not per stretch, because a reservation
                    # reaches a teacher rather than a class: the maths teacher
                    # being away leaves the stretch open to every other
                    # subject, and a room measured across the class would close
                    # it for all of them.
                    if decision.duration > self._room_in_stretch(
                        reserved(decision.lesson.requirement, day_index), room, first,
                    ):
                        continue
                    flag = model.NewBoolVar(
                        f"before_{group.id}_{day_index}_{first}_{decision.lesson.key()}",
                    )
                    # The lunch's own start, not an intermediate variable
                    # equal to its end: one linear row rather than two, and
                    # presolve reads straight through to the meal.
                    if after_lunch:
                        model.Add(
                            decision.start >= lunch_start + lunch_slots,
                        ).OnlyEnforceIf(flag)
                    else:
                        model.Add(decision.start >= base + opens).OnlyEnforceIf(flag)
                    model.Add(decision.end <= base + first).OnlyEnforceIf(flag)
                    inside.append(flag)
                if asks is None:
                    asks = registry.register(
                        model,
                        name=f"rast_order_{group.id}",
                        category="AVAILABILITY",
                        code="RAST_NO_LESSON_FITS_BEFORE_IT",
                        resource_ids=[group.id],
                    )
                if not inside:
                    # NOTHING CAN EVER SIT IN THIS STRETCH, so the demand has
                    # exactly one remaining way to be met: the class is gone by
                    # then. Said outright, as a hole in every one of its
                    # lessons' start domains, and NOT left to a clause over
                    # flags that can never be true — that was the timeout, and
                    # an empty BoolOr would be an unexplained INFEASIBLE
                    # besides. A domain is also the cheapest thing this engine
                    # has: no boolean, no row, and presolve reads it directly.
                    #
                    # Whether the week then still holds the class's lessons is
                    # _verify_rast_demands' question, asked before the solve.
                    for decision in lessons:
                        model.AddLinearExpressionInDomain(
                            decision.start,
                            cp_model.Domain(
                                base + last, base + slots_per_day - 1,
                            ).complement(),
                        ).OnlyEnforceIf(asks)
                    continue
                # WHO IS STILL AT SCHOOL AFTER THE RAST. Read without this
                # the rule demands a lesson in the stretch on every school
                # day, which is a different sentence: two asking rasts
                # would oblige every class to be taught ten times a week,
                # and a class with eight lessons is refused outright.
                # Measured on a five-day week with one class: 8 lessons
                # INFEASIBLE, 10 the first that solved.
                #
                # Fully reified, unlike the flags above, and that is the
                # whole reason it costs a second boolean per lesson: the
                # solver WANTS these false — false is what excuses it from
                # the stretch — so only the reverse implication, "a lesson
                # here means the class is still at school", makes them
                # true. `inside` needs no such thing.
                # A lock after the break has already answered the question the
                # literals below exist to ask, and answered it yes. The demand
                # is then unconditional, and costs one clause instead of a
                # boolean and three rows per lesson.
                if self._locked_after(request, members, day_index, last):
                    model.AddBoolOr([*inside, asks.Not()])
                    continue
                still_here = model.NewBoolVar(
                    f"after_{group.id}_{day_index}_{first}",
                )
                rest_of_day = cp_model.Domain(
                    base + last, base + slots_per_day - 1,
                )
                for decision in lessons:
                    late = model.NewBoolVar(
                        f"late_{group.id}_{day_index}_{first}_"
                        f"{decision.lesson.key()}",
                    )
                    model.AddLinearExpressionInDomain(
                        decision.start, rest_of_day,
                    ).OnlyEnforceIf(late)
                    model.AddLinearExpressionInDomain(
                        decision.start, rest_of_day.complement(),
                    ).OnlyEnforceIf(late.Not())
                    model.AddImplication(late, still_here)
                model.AddBoolOr([*inside, still_here.Not(), asks.Not()])

    def _rast_free_starts(
        self,
        rasts: list[Rast],
        span: tuple[int, int] | None,
        duration: int,
    ) -> cp_model.Domain:
        """Every absolute start a lesson of `duration` may take, rasts removed.

        Built as the COMPLEMENT of the forbidden ranges rather than as a union
        of the free ones, because the free ranges are what is left over and
        would have to be derived; the forbidden ones are what a rast says.
        """
        slots_per_day = self._grid.slots_per_day
        forbidden: list[list[int]] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            blocks = blocks_for(rasts, span, day_of_week, self._grid)
            base = day_index * slots_per_day
            forbidden.extend(
                [base + first, base + last]
                for first, last in forbidden_starts(blocks, duration)
            )
        if not forbidden:
            return cp_model.Domain(0, self._grid.horizon)
        # `complement()` over the whole integer line, then clipped back to the
        # horizon. ortools' Domain has no `difference`, and complement-then-
        # intersect is the composition it does have — the intersection with the
        # caller's own domain in _create_lesson_decisions does the clipping, but
        # doing it here too keeps this function's return value meaningful on its
        # own rather than only in the one place it is used.
        return cp_model.Domain.FromIntervals(forbidden).complement().intersection_with(
            cp_model.Domain(0, self._grid.horizon),
        )

    def _probe_timeout(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """Name what does not fit, when nothing was proved.

        _explain_infeasible works from a proof: CP-SAT said INFEASIBLE, so
        assumptions can be asked which constraints the proof rests on. A TIMEOUT
        is UNKNOWN — no proof, no core — and the school was being handed a bare
        status with four freshly declared rules to guess between: the rasts, a
        corridor, the meal, the dining hall.

        So this measures instead. One rule at a time is switched off, the
        satisfaction model is rebuilt and given a slice of a short budget, and
        every relaxation that then FINDS a timetable is reported by name. Only
        rules the payload actually carries are tried, in the order the
        measurements rank them — the corridor first, because on a 12-class,
        96-group school it alone turns a one-second solve into the whole budget.

        Not a proof either: a relaxation that stays UNKNOWN in its slice says
        nothing, and the summary says so. But "with the corridor at 0 this week
        solves in four seconds" is a sentence a rektor can act on, and it is
        true.
        """
        budget = self._settings.solver_probe_seconds
        if budget <= 0:
            return None

        relaxations = self._timeout_relaxations(request)
        if not relaxations:
            return None

        slice_seconds = max(self.MIN_PHASE_SECONDS, budget / len(relaxations))
        found: list[tuple[str, float]] = []
        for code, relaxed in relaxations:
            try:
                feas_model, _, _, _, _ = self._build_model(
                    relaxed, use_assumptions=False, include_objective=False,
                )
            except InvalidScheduleInputError:
                # A relaxation can also make the payload refuse by name (a
                # sitting that no longer reaches a stage, say). Not a finding.
                continue
            probe = cp_model.CpSolver()
            probe.parameters.max_time_in_seconds = slice_seconds
            started = time.perf_counter()
            if probe.Solve(feas_model) in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                found.append((code, time.perf_counter() - started))

        budget = round(self._settings.solver_max_time_seconds)
        if not found:
            return ConflictAnalysis(
                summary_code="PROBE_NOTHING_HELPED",
                summary_params={
                    "budget": budget,
                    "rules": len(relaxations),
                    "slice": round(slice_seconds),
                },
                conflicts=[],
            )
        # The rules are named in the details, one complete sentence each,
        # never joined into the summary: a list punctuated in English inside a
        # Swedish sentence is what a fragment param buys.
        return ConflictAnalysis(
            summary_code="PROBE_ONE_RULE_HELPED",
            summary_params={"budget": budget, "rules": len(found)},
            conflicts=[
                ConflictDetail(
                    category="TIMEOUT_PROBE",
                    code=code,
                    params={"seconds": round(seconds, 1)},
                )
                for code, seconds in found
            ],
        )

    def _timeout_relaxations(
        self, request: OptimizeScheduleRequest,
    ) -> list[tuple[str, OptimizeScheduleRequest]]:
        """The rules a timed-out week can be probed without, one at a time.

        Each is returned as the CODE of the sentence that reports it, so the
        finding reaches a school as one whole named sentence rather than an
        English fragment glued into a summary — a fragment cannot be
        translated into a language that inflects around it.

        Only what the payload carries, in the order the measurements rank them.
        THE LUNCH IS THREE THINGS, NOT ONE: the school's sittings per stage, the
        dining hall's seats, and the guaranteed break itself. The first probe
        reported "with the guaranteed lunch break switched off, a timetable was
        found in 0.1 s" — true, and useless, because a school cannot switch its
        lunch off. Which of the three it is decides what they do next: widen a
        sitting, count the chairs again, or move the window.
        """
        out: list[tuple[str, OptimizeScheduleRequest]] = []
        if any(f.changeover_minutes > 0 for f in request.frame_times):
            out.append((
                "PROBE_SOLVED_WITHOUT_CHANGEOVER",
                request.model_copy(update={
                    "frame_times": [
                        f.model_copy(update={"changeover_minutes": 0}) for f in request.frame_times
                    ],
                }),
            ))
        if any(rast.requires_lesson_before for rast in request.rasts):
            # BEFORE the rasts themselves, and separately from them, for the
            # reason the lunch is three probes and not one: "with the rasts
            # removed" is true and useless, because a school cannot delete its
            # breaks. This one it can act on — it is a switch somebody ticked,
            # and the only rast setting that makes the model bigger rather
            # than smaller.
            out.append((
                "PROBE_SOLVED_WITHOUT_LESSON_BEFORE_RAST",
                request.model_copy(update={
                    "rasts": [
                        rast.model_copy(update={"requires_lesson_before": False})
                        for rast in request.rasts
                    ],
                }),
            ))
        if request.rasts:
            out.append(("PROBE_SOLVED_WITHOUT_RASTS", request.model_copy(update={"rasts": []})))
        rules = request.rules
        if rules is not None and _lunch_window_is_set(rules):
            if request.lunch_servings:
                out.append((
                    "PROBE_SOLVED_WITHOUT_SERVINGS",
                    request.model_copy(update={"lunch_servings": []}),
                ))
            if rules.dining_seats is not None:
                out.append((
                    "PROBE_SOLVED_WITHOUT_DINING_SEATS",
                    request.model_copy(update={
                        "rules": rules.model_copy(update={"dining_seats": None}),
                    }),
                ))
            out.append((
                "PROBE_SOLVED_WITHOUT_LUNCH",
                request.model_copy(update={
                    "lunch_servings": [],
                    "rules": rules.model_copy(update={
                        "lunch_start_time": None,
                        "lunch_end_time": None,
                        "lunch_minutes": None,
                        "dining_seats": None,
                    }),
                }),
            ))
        return out

    def _timeout_diagnosis(self, request: OptimizeScheduleRequest, why: str) -> str:
        """One line naming what shaped the model that would not solve.

        A TIMEOUT carries no conflict core — UNKNOWN is not a proof — so the
        response cannot say what made the week hard, and the school is left
        guessing between the rasts it just declared, a corridor it just wrote
        and a dining hall that became real. The log can say which of those
        were in force. Measured on a 12-class, 96-group school: the same
        payload solves in 1 s with no corridor and burns the whole budget with
        five minutes of one, so the corridor is named first.
        """
        lessons = sum(r.lessons_per_week for r in request.requirements)
        corridor = max((f.changeover_minutes for f in request.frame_times), default=0)
        seats = request.rules.dining_seats if request.rules is not None else None
        eating = len(request.groups)
        return (
            f"TIMEOUT ({why}) [requestId={request.request_id}]: {lessons} lessons, "
            f"{len(request.requirements)} requirements, {eating} groups eating, "
            f"changeoverMinutes={corridor}, rasts={len(request.rasts)}, "
            f"frameTimes={len(request.frame_times)}, diningSeats={seats}, "
            f"fixedLessons={len(request.fixed_lessons)}, "
            f"budget={self._settings.solver_max_time_seconds}s. "
            + (
                "A changeover lengthens every lesson for the overlap check and is the "
                "first thing to try at 0."
                if corridor > 0
                else ""
            )
        )

    def _create_lesson_decisions(
        self,
        model: cp_model.CpModel,
        requirements: list[AnonymousRequirement],
        room_count: int,
        frames: list[FrameTime],
        rasts: list[Rast],
    ) -> list[LessonDecision]:
        decisions: list[LessonDecision] = []
        horizon = self._grid.horizon

        slots_per_day = self._grid.slots_per_day

        for requirement in requirements:
            duration = self._grid.minutes_to_slots(requirement.minutes_per_lesson)
            # One interval per day, each ending in time for the lesson to finish
            # before that day does. A single contiguous [0, horizon - duration]
            # range would also admit starts near a day's end, which put a lesson
            # across the 18:00 -> 08:00 boundary: reported as e.g. "Monday
            # 17:30-18:30" (past the configured day end) while the model has
            # actually reserved the teacher, group and room for Tuesday morning.
            #
            # RAMTIDER NARROW THIS DOMAIN RATHER THAN FORBIDDING INTERVALS IN
            # IT. A frame is a positive window, so the hours it closes never
            # become variables at all — which is the whole reason a frame is its
            # own row and not the two UNAVAILABLE constraints around it. With no
            # frames every day is (0, slots_per_day) and this is the expression
            # it always was. _validate_request has already refused the case
            # where the windows leave a requirement nowhere to go, so every
            # interval below is non-empty.
            span = span_of(requirement)
            windows = day_windows(frames, span, self._grid)
            changeover = changeover_slots(frames, span, self._grid)
            # THE DAY'S EDGE IS CLIPPED IN THE DOMAIN, not with a constraint.
            #
            # A padded interval runs `changeover` slots past the lesson, and the
            # horizon addresses day d as [d*spd, (d+1)*spd) — so an unclipped
            # last lesson would pad into tomorrow morning's slots and collide
            # with a lesson that is not on the same day at all.
            #
            # Two other fixes were considered and both are worse. A guard band
            # in TimeGrid (a `day_stride` wider than `slots_per_day`) re-encodes
            # every absolute slot for every school, so the next regeneration
            # moves lessons across the whole estate — and two places decode with
            # `// slots_per_day` that a rename would miss silently. An
            # AddMinEquality against the day's end costs an IntVar and a
            # constraint per lesson. Clipping the upper bound costs nothing.
            #
            # The price is that the last lesson of a day may not END later than
            # the day's close minus the margin, which binds only for a school
            # teaching to 18:00 with no ramtid. Wherever a frame closes earlier,
            # `close_slot - duration` is the tighter bound and nothing is lost.
            start_domain = cp_model.Domain.FromIntervals(
                [
                    [
                        day * slots_per_day + open_slot,
                        day * slots_per_day
                        + min(close_slot, slots_per_day - changeover)
                        - duration,
                    ]
                    for day, (open_slot, close_slot) in sorted(windows.items())
                    # A day too narrow for this lesson drops out here rather
                    # than reaching Domain.FromIntervals as a reversed pair.
                    # That happens to be safe today — FromIntervals discards
                    # such a pair silently — but it is undocumented behaviour
                    # to hang a whole feature's correctness on, and "silently
                    # discards" is one release away from "raises".
                    if min(close_slot, slots_per_day - changeover) - open_slot >= duration
                ],
            )

            # RASTER CUT HOLES IN THE SAME DOMAIN, for the reason the paragraph
            # above gives for frames: the minutes a stage is free never become
            # variable values at all. No new variables, no new constraints, and
            # a strictly smaller search space than the same model without them.
            # _validate_request has already refused the case where the holes
            # leave a requirement nowhere to go on any day, so what remains here
            # is never empty.
            #
            # LESSONS ONLY. The lunch interval is deliberately NOT narrowed the
            # same way, and the reason is in the Swedish word: a lunchrast IS a
            # rast. A school that writes "lunchrast 11:30-12:30" and lets the
            # engine seat its classes inside it is describing the ordinary case,
            # and subtracting the rast from the meal's domain would push the
            # meal out of exactly the window the school reserved for it — then
            # refuse the run when nowhere else is left. A rast keeps TEACHING
            # out; it has nothing to say about a break.
            if rasts:
                start_domain = start_domain.intersection_with(
                    self._rast_free_starts(rasts, span, duration),
                )
            for lesson_index in range(requirement.lessons_per_week):
                lesson = LessonInstance(requirement=requirement, lesson_index=lesson_index)
                start = model.NewIntVarFromDomain(start_domain, f"start_{lesson.key()}")
                end = model.NewIntVar(duration, horizon, f"end_{lesson.key()}")
                interval = model.NewIntervalVar(start, duration, end, f"interval_{lesson.key()}")
                model.Add(end == start + duration)
                room_index = model.NewIntVar(0, room_count - 1, f"room_{lesson.key()}")
                decisions.append(
                    LessonDecision(
                        lesson=lesson,
                        start=start,
                        duration=duration,
                        end=end,
                        interval=interval,
                        room_index=room_index,
                        changeover=changeover,
                    ),
                )

        return decisions

    def _add_capacity_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
    ) -> None:
        for decision in decisions:
            requirement = decision.lesson.requirement
            allowed_indices = [
                idx for idx, room in enumerate(rooms) if self._room_allowed(room, requirement)
            ]
            if not allowed_indices:
                continue

            assumption = registry.register(
                model,
                name=f"capacity_{requirement.id}_{decision.lesson.lesson_index}",
                category="ROOM_CAPACITY",
                # Two codes rather than one sentence with an optional tail:
                # a translator cannot inflect around a clause that is
                # sometimes absent, and the room type is a token the school
                # named itself.
                code=(
                    "ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT"
                    if requirement.required_room_type
                    else "ROOM_NO_ROOM_FOR_REQUIREMENT"
                ),
                params=(
                    {
                        "requirement": str(requirement.id),
                        "groupSize": requirement.student_group_size,
                        "roomType": str(requirement.required_room_type),
                    }
                    if requirement.required_room_type
                    else {
                        "requirement": str(requirement.id),
                        "groupSize": requirement.student_group_size,
                    }
                ),
                requirement_ids=[requirement.id],
            )

            forbidden = [idx for idx in range(len(rooms)) if idx not in allowed_indices]
            for room_idx in forbidden:
                model.Add(decision.room_index != room_idx).OnlyEnforceIf(assumption)

    def _add_teacher_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
    ) -> None:
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            requirement = decision.lesson.requirement
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id):
                if teacher_id is not None:
                    grouped.setdefault(teacher_id, []).append(decision)

        for teacher_decisions in grouped.values():
            if len(teacher_decisions) > 1:
                model.AddNoOverlap(
                    [padded_of(model, decision) for decision in teacher_decisions],
                )

    def _add_group_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
    ) -> None:
        """One student group is one set of students: no overlapping lessons.

        Two layers. Within a group, all lessons share every student, so one
        NoOverlap per group. Across groups, `group_conflicts` lists pairs that
        share AT LEAST one student — a home class vs a teaching group cut from
        it (7A vs Ma71), or two teaching groups with common members (Ma71 vs
        Sv73). Each pair gets a NoOverlap over the union of both groups'
        lessons: any overlap would double-book every shared student, which is
        exactly as hard a clash as a within-group one.

        Pairs whose groups have no scheduled lessons are skipped silently —
        the relation is derived from membership data, which can name groups
        that have no timplan entries. A self-pair (A, A) is skipped for the
        same reason: it states a truth the per-group NoOverlap above already
        enforces, and taking it literally would put every one of A's intervals
        into a single NoOverlap TWICE — asking each interval not to overlap
        itself, which turns the whole request INFEASIBLE.
        """
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            group_id = decision.lesson.requirement.student_group_id
            grouped.setdefault(group_id, []).append(decision)

        for group_decisions in grouped.values():
            if len(group_decisions) > 1:
                model.AddNoOverlap(
                    [padded_of(model, decision) for decision in group_decisions],
                )

        for first_id, second_id in group_conflicts or []:
            if first_id == second_id:
                continue
            combined = grouped.get(first_id, []) + grouped.get(second_id, [])
            if len(combined) > 1:
                model.AddNoOverlap([padded_of(model, decision) for decision in combined])

    def _add_room_allocation(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
        fixed_lessons: list[FixedLesson],
        room_preferences: list[AnonymousRoomPreference] | None = None,
    ) -> RoomPlan:
        """Enforce room capacity by interchangeability class, not by named room.

        The previous encoding reified "lesson L is in room R" for every pair —
        264,960 booleans at 2,000 students — and made 76 identical classrooms 76
        distinct search decisions. See app/solver/room_allocator.py for the
        encoding and the proof that the post-pass always succeeds.

        The returned plan is REQUIRED to read rooms back: room_index is no
        longer authoritative except for pinned rooms.
        """
        # Wishes only, and for a lock the bit would be redundant rather than
        # merely wasteful: the signature's first half is eligibility, a lock's
        # whole effect on eligibility IS "in this room set", so the bit it would
        # add is the distinction the partition has already made.
        #
        # Stated rather than tested. Once the lock is enforced there is no
        # payload where adding the bit changes the class count, so the test that
        # guarded this during the wish-only step could no longer say anything
        # and was removed instead of given a contrived fixture.
        preference_sets = [
            _preference_room_ids(preference, rooms)
            for preference in (room_preferences or [])
            if preference.kind == "WISH"
        ]
        allowed, key = self._lock_aware(
            resolve_room_locks(
                [decision.lesson.requirement for decision in decisions],
                room_preferences or [],
                rooms,
            ),
        )
        return add_room_allocation(
            model,
            decisions,
            rooms,
            distinguished_room_ids=collect_distinguished_room_ids(
                constraints, fixed_lessons,
            ),
            room_allowed=allowed,
            profile_key=key,
            preference_sets=preference_sets,
        )

    def _add_availability_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
    ) -> None:
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue

            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            affected = self._decisions_for_constraint(constraint, decisions, room_index_by_id, model)
            if not affected:
                continue

            assumption = registry.register(
                model,
                name=f"availability_{constraint.id}",
                category="AVAILABILITY",
                code="AVAIL_CONSTRAINT_BLOCKS_LESSONS",
                params=self._constraint_params(constraint),
                constraint_ids=[constraint.id],
                # A year reservation names no resource, and a conflict detail
                # carries UUIDs only — the constraint id is what the admin has
                # to look up anyway.
                resource_ids=[constraint.resource_id] if constraint.resource_id else [],
                requirement_ids=[decision.lesson.requirement.id for decision, _ in affected],
            )

            for decision, guard in affected:
                for abs_start, abs_end in windows:
                    before = model.NewBoolVar(
                        f"before_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    after = model.NewBoolVar(
                        f"after_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                    model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                    model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                    model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())

                    if guard is None:
                        model.AddBoolOr([before, after]).OnlyEnforceIf(assumption)
                    else:
                        # Both literals in ONE call. OnlyEnforceIf returns None
                        # in ortools 9.15, so chaining a second call raises
                        # AttributeError — and `guard` is non-None exactly for
                        # ROOM-scoped constraints, so every "this room is
                        # unavailable on Wednesday afternoons" payload crashed.
                        model.AddBoolOr([before, after]).OnlyEnforceIf([guard, assumption])

    def _decisions_for_constraint(
        self,
        constraint: AnonymousConstraint,
        decisions: list[LessonDecision],
        room_index_by_id: dict[UUID, int],
        model: cp_model.CpModel,
    ) -> list[tuple[LessonDecision, cp_model.IntVar | None]]:
        affected: list[tuple[LessonDecision, cp_model.IntVar | None]] = []

        if constraint.resource_kind == "TEACHER":
            for decision in decisions:
                requirement = decision.lesson.requirement
                if constraint.resource_id in (
                    requirement.teacher_id,
                    requirement.co_teacher_id,
                ):
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "STUDENT_GROUP":
            for decision in decisions:
                if decision.lesson.requirement.student_group_id == constraint.resource_id:
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "GRADE_LEVEL":
            # One row, every group of those years — including the teaching
            # groups, whose own grade level is null but whose members are year
            # 7 all the same. Fanning this out into one constraint per group in
            # the gateway would turn "hold year 7 free at 11:30" into sixty rows
            # against a payload capped at five thousand.
            #
            # THIS EVICTS LESSONS AND NOTHING ELSE. The example here used to
            # read "year 7 eats at 11:30", which was wrong in a way that
            # mattered: a reservation empties the half hour of LESSONS and says
            # nothing about where the meal goes, so a school following that
            # advice got a hole and a lunch somewhere else entirely. A sitting
            # is declared with LunchServing, which the lunch variable's own
            # domain reads.
            #
            # And a GRADE_LEVEL row deliberately does NOT subtract from that
            # domain, unlike a STUDENT_GROUP one. Schools were told to write
            # sittings this way; making the rows close the lunch would push the
            # meal out of exactly the window they reserved FOR it, and break the
            # schools that followed our own documentation.
            for decision in decisions:
                if _grade_span_overlaps(constraint, decision.lesson.requirement):
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "ROOM":
            room_idx = room_index_by_id.get(constraint.resource_id)
            if room_idx is None:
                return affected
            for decision in decisions:
                assigned_here = model.NewBoolVar(
                    f"avail_room_{constraint.id}_{decision.lesson.key()}",
                )
                model.Add(decision.room_index == room_idx).OnlyEnforceIf(assigned_here)
                model.Add(decision.room_index != room_idx).OnlyEnforceIf(assigned_here.Not())
                affected.append((decision, assigned_here))
            return affected

        return affected

    def _add_fixed_lesson_constraints(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        fixed_lessons: list[FixedLesson],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
    ) -> None:
        """Hard-block generated lessons from overlapping locked placements.

        A generated lesson may not overlap a fixed lesson that shares its
        teacher or student group — where "shares its group" includes any group
        that shares STUDENTS with it per `group_conflicts`, so a locked 7A
        mentor hour also blocks Ma71's generated lessons for the window. If
        the fixed lesson occupies a room, no generated lesson may be assigned
        that room during the window.
        """
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        # Symmetric lookup: conflicts_with[G] = groups sharing students with G.
        conflicts_with: dict[UUID, set[UUID]] = {}
        for first_id, second_id in group_conflicts or []:
            conflicts_with.setdefault(first_id, set()).add(second_id)
            conflicts_with.setdefault(second_id, set()).add(first_id)

        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                # Outside the scheduling grid (e.g. weekend when the grid is
                # Mon-Fri): generated lessons can never collide with it.
                continue
            abs_start, abs_end = window

            room_idx = (
                room_index_by_id.get(fixed.room_id) if fixed.room_id is not None else None
            )

            for decision in decisions:
                requirement = decision.lesson.requirement
                fixed_teachers = {
                    tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid
                }
                own_teachers = {
                    tid
                    for tid in (requirement.teacher_id, requirement.co_teacher_id)
                    if tid
                }
                shares_teacher = bool(fixed_teachers & own_teachers)
                fixed_groups = {fixed.student_group_id, *fixed.extra_group_ids}
                own_group = requirement.student_group_id
                shares_group = own_group in fixed_groups or any(
                    fixed_group in conflicts_with.get(own_group, ())
                    for fixed_group in fixed_groups
                )

                if shares_teacher or shares_group:
                    self._add_window_avoidance(
                        model,
                        decision,
                        abs_start,
                        abs_end,
                        tag=f"fixed_{fixed.id}_{decision.lesson.key()}",
                        guard=None,
                        # A hand-placed lesson is not an interval in this model
                        # — it is a constant window — so padded_of never reaches
                        # it. The margin has to be applied here or a generated
                        # lesson lands flush against a locked one, which is the
                        # very collision the corridor exists to prevent, on the
                        # placements a human chose deliberately.
                        margin=decision.changeover,
                    )
                    continue

                if room_idx is not None:
                    assigned_here = model.NewBoolVar(
                        f"fixed_room_{fixed.id}_{decision.lesson.key()}",
                    )
                    model.Add(decision.room_index == room_idx).OnlyEnforceIf(assigned_here)
                    model.Add(decision.room_index != room_idx).OnlyEnforceIf(
                        assigned_here.Not(),
                    )
                    self._add_window_avoidance(
                        model,
                        decision,
                        abs_start,
                        abs_end,
                        tag=f"fixed_roomwin_{fixed.id}_{decision.lesson.key()}",
                        guard=assigned_here,
                        # NO margin on the room arm. The corridor is about a
                        # body walking between two places; a room needs no time
                        # to become itself again, and a school that wants the
                        # room to breathe declares a rast. This mirrors the
                        # decision not to pad the room cumulative.
                        margin=0,
                    )

    def _add_window_avoidance(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        abs_start: int,
        abs_end: int,
        tag: str,
        guard: cp_model.IntVar | None,
        margin: int = 0,
    ) -> None:
        """decision must end before, or start after, the [abs_start, abs_end) window.

        `margin` widens the window by the same corridor padded_of gives a
        generated pair — on BOTH sides, because the body moves in both
        directions: out of the room the fixed lesson is about to fill, and into
        it after the fixed lesson leaves. That is not the double-padding
        padded_of avoids; there the two lessons each carry their own margin, so
        padding both ends would count one corridor twice.
        """
        before = model.NewBoolVar(f"before_{tag}")
        after = model.NewBoolVar(f"after_{tag}")
        model.Add(decision.end + margin <= abs_start).OnlyEnforceIf(before)
        model.Add(decision.end + margin > abs_start).OnlyEnforceIf(before.Not())
        model.Add(decision.start >= abs_end + margin).OnlyEnforceIf(after)
        model.Add(decision.start < abs_end + margin).OnlyEnforceIf(after.Not())
        if guard is None:
            model.AddBoolOr([before, after])
        else:
            model.AddBoolOr([before, after]).OnlyEnforceIf(guard)

    def _constraint_params(self, constraint: AnonymousConstraint) -> dict[str, str | int]:
        """The values a sentence about one reservation substitutes.

        Structured, never a label assembled here: the gateway turns the
        resource id into the school's own name and the reader puts the words
        in its own order. `day` is the ISO weekday, or 0 for a one-off, which
        is the branch that reads `date` instead — a reservation is written
        either way round on the Tillgänglighet page.
        """
        return {
            "constraint": str(constraint.id),
            "kind": constraint.resource_kind,
            "resource": str(constraint.resource_id or ""),
            "grades": _grade_span_text(
                constraint.min_grade_level, constraint.max_grade_level,
            ),
            "day": constraint.day_of_week or 0,
            "date": constraint.date or "",
            "start": constraint.start_time[:5],
            "end": constraint.end_time[:5],
        }

    def _fixed_window(self, fixed: FixedLesson) -> tuple[int, int] | None:
        """Absolute slot window blocked by a fixed lesson, rounded outward.

        Locked lessons are hand-placed and need not align to the slot grid;
        the blocked window is expanded to whole slots so blocking stays
        conservative. Returns None when the lesson lies outside the grid.
        """
        if fixed.day_of_week not in self._grid.schedule_days:
            return None

        start_minutes = _hhmmss_to_minutes(fixed.start_time)
        end_minutes = _hhmmss_to_minutes(fixed.end_time)
        start_minutes = max(start_minutes, self._grid.day_start_minutes)
        end_minutes = min(end_minutes, self._grid.day_end_minutes)
        if end_minutes <= start_minutes:
            return None

        slot = self._grid.slot_minutes
        start_slot = (start_minutes - self._grid.day_start_minutes) // slot
        end_slot = -(-(end_minutes - self._grid.day_start_minutes) // slot)  # ceil

        day_offset = self._grid.day_index(fixed.day_of_week) * self._grid.slots_per_day
        return day_offset + start_slot, day_offset + end_slot

    def _resolve_weights(self, request: OptimizeScheduleRequest) -> ResolvedWeights:
        override = request.weights
        return ResolvedWeights(
            preferred_free=(
                override.preferred_free
                if override and override.preferred_free is not None
                else self._settings.weight_preferred_free_violation
            ),
            preferred_busy=(
                override.preferred_busy
                if override and override.preferred_busy is not None
                else self._settings.weight_preferred_busy_violation
            ),
            disruption=(
                override.disruption
                if override and override.disruption is not None
                else self._settings.weight_disruption
            ),
            lunch_drift=self._settings.weight_lunch_drift,
            spread=(
                override.spread
                if override and override.spread is not None
                else self._settings.weight_spread
            ),
            teacher_gap=(
                override.teacher_gap
                if override and override.teacher_gap is not None
                else self._settings.weight_teacher_gap
            ),
            room_preference=(
                override.room_preference
                if override and override.room_preference is not None
                else self._settings.weight_room_preference
            ),
            date_unavailable=self._settings.weight_date_unavailable,
        )

    def _add_preference_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Soft PREFERRED_FREE / PREFERRED_BUSY windows.

        Applies to teachers and student groups directly, and to rooms via the
        room-assignment literal (a room preference only counts for lessons
        actually placed in that room).
        """
        penalties: list[cp_model.LinearExpr] = []
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        for constraint in constraints:
            # Dated constraints act exactly at publish time; inside the weekly
            # solver they become SOFT signals on their weekday (a dated
            # UNAVAILABLE nudges lessons away from slots where one-off
            # absences fall). Recurring UNAVAILABLE stays hard elsewhere.
            if constraint.date is not None:
                try:
                    weekday = date_type.fromisoformat(constraint.date).isoweekday()
                except ValueError:
                    continue
                if weekday not in self._grid.schedule_days:
                    continue
                effective_day: int | None = weekday
                dated = True
            else:
                if constraint.kind not in {"PREFERRED_FREE", "PREFERRED_BUSY"}:
                    continue
                effective_day = constraint.day_of_week
                dated = False

            try:
                windows = self._grid.window_to_absolute_range(
                    effective_day,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            affected = self._decisions_for_constraint(
                constraint, decisions, room_index_by_id, model,
            )

            for decision, guard in affected:
                for abs_start, abs_end in windows:
                    tag = f"{constraint.id}_{decision.lesson.key()}_{abs_start}"
                    before = model.NewBoolVar(f"pref_before_{tag}")
                    after = model.NewBoolVar(f"pref_after_{tag}")
                    overlaps = model.NewBoolVar(f"pref_overlap_{tag}")
                    model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                    model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                    model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                    model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())
                    model.AddBoolAnd([before.Not(), after.Not()]).OnlyEnforceIf(overlaps)
                    model.AddBoolOr([before, after]).OnlyEnforceIf(overlaps.Not())

                    violation = model.NewBoolVar(f"pref_violation_{tag}")
                    # The "raw" violation condition, before the room guard.
                    condition = (
                        overlaps
                        if constraint.kind in {"PREFERRED_FREE", "UNAVAILABLE"}
                        else overlaps.Not()
                    )
                    if guard is None:
                        model.Add(violation == 1).OnlyEnforceIf(condition)
                        model.Add(violation == 0).OnlyEnforceIf(condition.Not())
                    else:
                        model.AddBoolAnd([condition, guard]).OnlyEnforceIf(violation)
                        model.AddBoolOr([condition.Not(), guard.Not()]).OnlyEnforceIf(
                            violation.Not(),
                        )

                    if dated and constraint.kind == "UNAVAILABLE":
                        weight = weights.date_unavailable
                    elif constraint.kind == "PREFERRED_FREE":
                        weight = weights.preferred_free
                    else:
                        weight = weights.preferred_busy
                    penalties.append(violation * weight)

        return penalties

    def _add_room_preference_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        room_plan: RoomPlan,
        preferences: list[AnonymousRoomPreference],
        weights: _Weights,
    ) -> list[cp_model.LinearExpr]:
        """Pay per lesson that misses its subject's preferred rooms.

        The class literals do the work: a lesson picks exactly one class, and a
        preference's rooms form classes of their own (see build_room_classes),
        so "landed somewhere preferred" is the sum of the literals of those
        classes — 0 or 1, never more, because AddExactlyOne holds across every
        eligible class.

        A lesson with only one eligible class has no literal at all. Its
        placement is already decided, so whether it satisfies the wish is a
        constant, and a constant term cannot change which timetable wins.
        Adding it would only inflate the objective value.
        """
        if not preferences:
            return []

        penalties: list[cp_model.LinearExpr] = []
        by_subject: dict[UUID, list[AnonymousRoomPreference]] = defaultdict(list)
        for preference in preferences:
            # A LOCK is not a price. It restricts eligibility through
            # _room_allowed and must never also appear as a penalty: paying for
            # a room the lesson cannot reach anyway is a constant, and one that
            # would inflate the objective without steering anything.
            if preference.kind != "WISH":
                continue
            by_subject[preference.subject_id].append(preference)

        for decision in decisions:
            requirement = decision.lesson.requirement
            wanted = by_subject.get(requirement.subject_id)
            if not wanted:
                continue

            key = decision.lesson.key()
            literals = room_plan.literals.get(key)
            if not literals:
                continue

            for preference in wanted:
                # The stage the rule is about. Gated HERE and nowhere else: the
                # room-class partition treats "preferred" as a static property
                # of a room, and _class_is_preferred decides a whole class by
                # testing its first member, so a per-lesson room set would
                # destroy the invariant the encoding rests on.
                if not _rule_reaches(preference, requirement):
                    continue
                preferred_rooms = _preference_room_ids(preference, rooms)
                satisfied = [
                    literal
                    for class_index, literal in literals.items()
                    if _class_is_preferred(room_plan, class_index, rooms, preferred_rooms)
                ]
                if not satisfied or len(satisfied) == len(literals):
                    # Impossible or unavoidable: either way the term is a
                    # constant and steers nothing.
                    continue
                weight = preference.weight or weights.room_preference
                penalties.append((1 - sum(satisfied)) * weight)

        return penalties

    def _add_disruption_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Minimal-disruption re-optimization.

        For every slot the previous schedule used, the solver is penalized
        unless some lesson instance of the same requirement stays on it. The
        previous slots are also fed in as solver hints (warm start).
        """
        if weights.disruption <= 0 or not previous_lessons:
            return []

        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        hinted: set[str] = set()
        penalties: list[cp_model.LinearExpr] = []

        for index, previous in enumerate(previous_lessons):
            candidates = by_requirement.get(previous.requirement_id)
            if not candidates:
                continue
            try:
                start_slot = self._grid.parse_hhmmss(previous.start_time)
                abs_slot = self._grid.absolute_start(previous.day_of_week, start_slot)
            except ValueError:
                continue  # off-grid previous slot — nothing to preserve

            matches: list[cp_model.IntVar] = []
            for decision in candidates:
                b = model.NewBoolVar(f"prev_{index}_{decision.lesson.key()}")
                model.Add(decision.start == abs_slot).OnlyEnforceIf(b)
                model.Add(decision.start != abs_slot).OnlyEnforceIf(b.Not())
                matches.append(b)

            kept = model.NewBoolVar(f"prev_kept_{index}")
            model.AddBoolOr(matches).OnlyEnforceIf(kept)
            model.AddBoolAnd([m.Not() for m in matches]).OnlyEnforceIf(kept.Not())
            penalties.append((1 - kept) * weights.disruption)

            # Warm-start hint: point one not-yet-hinted instance at the slot.
            for decision in candidates:
                if decision.lesson.key() not in hinted:
                    model.AddHint(decision.start, abs_slot)
                    hinted.add(decision.lesson.key())
                    break

        return penalties

    def _day_var(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        cache: dict[str, cp_model.IntVar],
    ) -> cp_model.IntVar:
        """Lazily creates the day-index variable of a decision (shared)."""
        key = decision.lesson.key()
        existing = cache.get(key)
        if existing is not None:
            return existing
        day_var = model.NewIntVar(
            0, max(0, len(self._grid.schedule_days) - 1), f"day_{key}",
        )
        model.AddDivisionEquality(day_var, decision.start, self._grid.slots_per_day)
        cache[key] = day_var
        return day_var

    def _add_spread_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        weights: ResolvedWeights,
        day_vars: dict[str, cp_model.IntVar],
    ) -> list[cp_model.LinearExpr]:
        """Penalizes two lessons of the same requirement on the same weekday."""
        if weights.spread <= 0:
            return []

        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        penalties: list[cp_model.LinearExpr] = []

        for requirement_id, group in by_requirement.items():
            if len(group) < 2:
                continue
            group_days = [self._day_var(model, d, day_vars) for d in group]
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    same = model.NewBoolVar(f"sameday_{requirement_id}_{i}_{j}")
                    model.Add(group_days[i] == group_days[j]).OnlyEnforceIf(same)
                    model.Add(group_days[i] != group_days[j]).OnlyEnforceIf(same.Not())
                    penalties.append(same * weights.spread)

        return penalties

    def _add_idle_time_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        constraints: list[AnonymousConstraint],
        weights: ResolvedWeights,
        day_vars: dict[str, cp_model.IntVar],
    ) -> list[cp_model.LinearExpr]:
        """Penalises a teacher's idle minutes, measured once per day.

        REPLACES a pairwise encoding that charged every unordered pair of a
        teacher's same-day lessons the positive distance between them. Three
        things were wrong with it and all three are gone.

          IT CHARGED NON-ADJACENT PAIRS. With three lessons in an unbroken
          chain the first and third are still an hour apart, so a teacher paid
          for the middle lesson's own length — which quietly pushed their third
          lesson off the day, an effect no comment, document or UI string
          mentioned.

          IT GAVE UP SILENTLY. Above 600 pairs a teacher's terms were skipped
          with no log and nothing in the response, so the most heavily loaded
          teacher — the one a compact day matters most to — was the one teacher
          the objective ignored. A day is O(lessons) and needs no such guard.

          IT PUNISHED A PROTECTED BREAK. The one way a teacher can reserve their
          own time today is an UNAVAILABLE row on themselves, and the pairwise
          gap read only lesson variables: the hole their own protection created
          was charged to them at full price.

        WHAT IS MEASURED. For each teacher and each day: the span from the first
        lesson's start to the last lesson's end, minus the minutes actually
        taught, minus the minutes the teacher had protected inside that span.
        Floored at zero.

        THE CREDIT IS MEASURED, NOT SUMMED. Adding up the lengths of the
        matching windows double-counts two that overlap, and gives nothing at
        all for a window that only partly falls inside the day's span. The
        windows are merged into a disjoint union at build time and each one's
        OVERLAP with [first, last] is what is credited.

        ONLY THE TEACHER'S OWN WINDOWS ARE CREDITED. A stage's rast subtracts
        from a GROUP's lesson domain and says nothing about where a teacher is;
        crediting it here would pay a teacher for a break they spent teaching
        another class — the very defect this codebase already documents
        elsewhere, recreated inside the CP model where it is far harder to see.

        AND THERE IS NO PUPIL EQUIVALENT, deliberately. lib/gaps.ts opens by
        refusing the question — "'Where are 7A's håltimmar' cannot be asked that
        way" — because while Ma71 runs, sixteen of 7A are taught and fourteen
        may have nothing. A span-minus-taught term per group would price ghost
        holes in every 7-9 school with språkval, and pull 7A's own lessons
        together against the placements its teaching groups need. Pupils' holes
        are closed by rasts, which are hard and which the school wrote itself.
        """
        if weights.teacher_gap <= 0:
            return []

        by_teacher: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            requirement = decision.lesson.requirement
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id):
                if teacher_id is not None:
                    by_teacher.setdefault(teacher_id, []).append(decision)

        protected = self._protected_windows(constraints)
        penalties: list[cp_model.LinearExpr] = []
        slots_per_day = self._grid.slots_per_day

        for teacher_id, group in by_teacher.items():
            if len(group) < 2:
                # One lesson is a span equal to its own length: no idle time can
                # exist, and the variables would be provably zero.
                continue
            days = [self._day_var(model, d, day_vars) for d in group]

            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                base = day_index * slots_per_day
                on_day: list[cp_model.IntVar] = []
                for k, decision in enumerate(group):
                    literal = model.NewBoolVar(
                        f"idle_on_{teacher_id}_{day_index}_{decision.lesson.key()}",
                    )
                    model.Add(days[k] == day_index).OnlyEnforceIf(literal)
                    model.Add(days[k] != day_index).OnlyEnforceIf(literal.Not())
                    on_day.append(literal)

                tag = f"idle_{teacher_id}_{day_index}"
                first = model.NewIntVar(base, base + slots_per_day, f"first_{tag}")
                last = model.NewIntVar(base, base + slots_per_day, f"last_{tag}")
                # ONE-SIDED ON PURPOSE. `first` is only bounded from above and
                # `last` only from below, so nothing forces either to the true
                # extreme — the OBJECTIVE does. Minimising `last - first` pushes
                # first up to the earliest present start and last down to the
                # latest present end, which is exactly the pair of equalities a
                # two-sided encoding would cost twice as many constraints to
                # state.
                for k, decision in enumerate(group):
                    model.Add(first <= decision.start).OnlyEnforceIf(on_day[k])
                    model.Add(last >= decision.end).OnlyEnforceIf(on_day[k])

                taught = sum(
                    decision.duration * on_day[k] for k, decision in enumerate(group)
                )
                credit = self._protected_overlap(
                    model, protected.get((teacher_id, day_of_week), ()), first, last, tag,
                )

                idle = model.NewIntVar(0, slots_per_day, f"idle_{tag}")
                model.Add(idle >= last - first - taught - credit)
                penalties.append(idle * weights.teacher_gap)

        return penalties

    def _protected_windows(
        self,
        constraints: list[AnonymousConstraint],
    ) -> dict[tuple[UUID, int], tuple[tuple[int, int], ...]]:
        """(teacher, weekday) -> the teacher's own free windows, as a disjoint union.

        Merged here rather than credited row by row: two rows that overlap would
        otherwise be counted twice, and a teacher who wrote the same hour down
        in two forms would be paid for it twice over.

        Weekly rows only, matching _add_availability_constraints: the model is
        one generic week and has nowhere to put a single date.
        """
        by_key: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for constraint in constraints:
            if constraint.resource_kind != "TEACHER" or constraint.resource_id is None:
                continue
            if constraint.date is not None or constraint.day_of_week is None:
                continue
            window = self._grid.window_to_absolute_range(
                constraint.day_of_week, constraint.start_time, constraint.end_time,
            )
            if not window:
                continue
            for start, end in window:
                by_key.setdefault(
                    (constraint.resource_id, constraint.day_of_week), [],
                ).append((start, end))

        merged: dict[tuple[UUID, int], tuple[tuple[int, int], ...]] = {}
        for key, ranges in by_key.items():
            ranges.sort()
            union: list[tuple[int, int]] = []
            for start, end in ranges:
                if union and start <= union[-1][1]:
                    union[-1] = (union[-1][0], max(union[-1][1], end))
                else:
                    union.append((start, end))
            merged[key] = tuple(union)
        return merged

    def _protected_overlap(
        self,
        model: cp_model.CpModel,
        windows: Sequence[tuple[int, int]],
        first: cp_model.IntVar,
        last: cp_model.IntVar,
        tag: str,
    ) -> cp_model.LinearExpr:
        """Minutes of [first, last] the teacher had already reserved.

        Built only for teachers who actually wrote a row, which in a real school
        is a handful — so the three variables per window cost nothing on the
        common path and the term is exactly zero without them.
        """
        if not windows:
            return 0
        parts: list[cp_model.IntVar] = []
        for index, (start, end) in enumerate(windows):
            lo = model.NewIntVar(0, self._grid.horizon, f"lo_{tag}_{index}")
            hi = model.NewIntVar(0, self._grid.horizon, f"hi_{tag}_{index}")
            model.AddMaxEquality(lo, [first, start])
            model.AddMinEquality(hi, [last, end])
            overlap = model.NewIntVar(0, self._grid.slots_per_day, f"ov_{tag}_{index}")
            model.AddMaxEquality(overlap, [hi - lo, 0])
            parts.append(overlap)
        return sum(parts)

    def _lunch_window_slots(self, rules: ScheduleRules) -> tuple[int, int, int]:
        """The lunch window and break length in slots: (start, end, length).

        One rounding rule, read from two places. _validate_request needs the
        same arithmetic the builder does — it settles up front what locked
        lessons leave a group, so the solve budget is not spent proving a
        subtraction — and two copies of "which slot is 11:30" would eventually
        disagree about a school's lunch.

        Every rejection here is bad input, not a solver verdict. In particular
        a 40-minute break is off the 15-minute grid and minutes_to_slots says
        so with a bare ValueError, which outside this block escapes to
        main.py's generic handler and becomes a 500. Now that lunch is a saved
        setting rather than a value retyped per run, that 500 would come back
        on every run.
        """
        try:
            window_start = self._grid.parse_hhmmss(rules.lunch_start_time)
            window_end = self._grid.parse_hhmmss(rules.lunch_end_time)
            lunch_slots = self._grid.minutes_to_slots(rules.lunch_minutes)
        except ValueError as exc:
            # Named for the lunch rather than passed through: the grid's
            # duration complaint reads "Lesson duration 40 minutes is not
            # aligned", and a school that typed a 40-minute LUNCH on a
            # 15-minute grid went looking through its timplan for a lesson.
            raise InvalidScheduleInputError.of("LUNCH_WINDOW_OFF_GRID", {
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
                "minutes": rules.lunch_minutes,
                "slotMinutes": self._grid.slot_minutes,
            }) from exc
        if window_end - window_start < lunch_slots:
            raise InvalidScheduleInputError.of("LUNCH_WINDOW_SHORTER_THAN_BREAK", {
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
                "minutes": rules.lunch_minutes,
            })
        return window_start, window_end, lunch_slots

    def _admissible_lunch_starts(
        self,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
        forbidden: list[tuple[int, int]],
    ) -> cp_model.Domain:
        """What is left of one group's lunch window on one day, in absolute slots.

        A domain, not a NoOverlap against constant intervals: one variable's
        domain is the strongest and cheapest form the fact has. Shared with
        _validate_request, which asks the same question and only wants to know
        whether the answer is empty.
        """
        allowed = cp_model.Domain(
            day_offset + window_start,
            day_offset + window_end - lunch_slots,
        )
        for first_bad, last_bad in forbidden:
            allowed = allowed.intersection_with(
                cp_model.Domain(first_bad, last_bad).complement(),
            )
        return allowed

    def _declared_lunch_domain(
        self,
        servings: list[LunchServing],
        frames: list[FrameTime],
        span: tuple[int, int] | None,
        day_of_week: int,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> cp_model.Domain | None:
        """Where this stage's meal may start on this day, in ABSOLUTE slots.

        Two declarations meet here and they are not the same kind of thing. A
        SERVING says when the stage eats — a permission, so several union. A
        FRAME says which hours the stage may be taught in at all — a bound, so
        several intersect, and the meal has to sit inside it like everything
        else does. A school that opens the hall until 13:30 for a stage whose
        day ends at 13:00 has said two things, and the narrower one wins.

        None means nothing was declared for this group on this day: neither a
        serving nor a frame reaches it, and the school-wide lunch window stands
        untouched. An EMPTY domain is the other answer entirely — a declaration
        too tight to hold the break — and _validate_request refuses that by name
        before a solve begins.
        """
        serving_domain = allowed_starts(servings, span, day_of_week, lunch_slots, self._grid)

        frame_domain: cp_model.Domain | None = None
        if frames and span is not None:
            windows = day_windows(frames, span, self._grid)
            day_index = day_offset // self._grid.slots_per_day
            window = windows.get(day_index)
            if window is None:
                # The frames closed this day for the stage. Nowhere to eat.
                frame_domain = cp_model.Domain.FromIntervals([])
            else:
                open_slot, close_slot = window
                frame_domain = (
                    cp_model.Domain(open_slot, close_slot - lunch_slots)
                    if close_slot - lunch_slots >= open_slot
                    else cp_model.Domain.FromIntervals([])
                )

        if serving_domain is None and frame_domain is None:
            return None

        declared = serving_domain if serving_domain is not None else frame_domain
        if serving_domain is not None and frame_domain is not None:
            declared = serving_domain.intersection_with(frame_domain)

        # Day-local so far, because both sources reason inside one day. The
        # variable lives on the week's line, so shift once, here, rather than in
        # two modules that would then have to agree about it.
        assert declared is not None
        return cp_model.Domain.FromIntervals(
            [
                [day_offset + low, day_offset + high]
                for low, high in _domain_intervals(declared)
            ],
        ).intersection_with(
            cp_model.Domain(day_offset + window_start, day_offset + window_end - lunch_slots),
        )

    def _lunch_starts_blocked_by_constraints(
        self,
        constraints: list[AnonymousConstraint],
        lunch_group_ids: set[UUID],
        earliest_start: int,
        latest_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> tuple[dict[tuple[UUID, int], list[tuple[int, int]]], set[tuple[UUID, int]]]:
        """Lunch starts a group may not take, because the school closed the time.

        The lunch interval has never seen an AvailabilityConstraint. Availability
        is applied in _add_availability_constraints, which runs before the lunch
        variable exists and only ever touches LessonDecisions — so an hour a
        school emptied for samling correctly pushed the LESSONS away and then
        received the class for lunch instead. Worse than neutral: no objective
        term mentions lunch, so the emptied hour is the widest free region the
        mandatory interval can occupy, and it is where lunch tends to land.

        STUDENT_GROUP rows only, deliberately. TEACHER and ROOM rows constrain
        resources the lunch interval does not model. GRADE_LEVEL is left out
        here for a sharper reason: this engine's own comments have been telling
        schools that a year reservation is how you say "åk 7 eats at 11:30", so
        subtracting those windows would forbid lunch in exactly the half hour
        the admin reserved FOR it. That advice is retired once LunchServings can
        state the intent properly, and GRADE_LEVEL joins this subtraction then.

        Dated rows are skipped, matching _add_availability_constraints: the
        model is one generic week and has nowhere to put a single date.

        TWO ANSWERS, NOT ONE, and the difference is the whole of this method.
        A rule that covers the ENTIRE lunch window is the school saying the
        class is not here — "7A undervisas inte på tisdagar" has no other way to
        be written, and the same row blocks that day's lessons too. Refusing the
        timetable over it would answer a correct statement with an error nobody
        can act on. Such a (group, day) is returned as EXEMPT: no lunch, and no
        chairs booked either, which is strictly more accurate than the standing
        "every home class eats every school day" simplification.

        A rule that merely leaves fragments too short for the break is the
        opposite case: the class is in school, busy, and the school has asked
        for something impossible. That is subtracted, and refused by name if
        nothing survives.

        The arithmetic is _lunch_starts_blocked_by_fixed_lessons's, and the
        blocked shape is the same — absolute slots, keyed by (group, day) —
        so the two merge into one domain subtraction.
        """
        blocked: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        exempt: set[tuple[UUID, int]] = set()
        slots_per_day = self._grid.slots_per_day

        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.resource_kind != "STUDENT_GROUP":
                continue
            group_id = constraint.resource_id
            if group_id is None or group_id not in lunch_group_ids:
                continue

            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            for abs_start, abs_end in windows:
                day_index = abs_start // slots_per_day
                day_offset = day_index * slots_per_day
                local_start = abs_start - day_offset
                local_end = abs_end - day_offset

                # Covers the lunch window whole: the class is not here.
                if local_start <= earliest_start and local_end >= window_end:
                    exempt.add((group_id, day_index))
                    continue

                first_bad = local_start - lunch_slots + 1
                last_bad = local_end - 1
                if last_bad < earliest_start or first_bad > latest_start:
                    continue
                # ABSOLUTE slots, as the locked-lesson helper returns them: the
                # domain these are cut from is absolute. Day-relative, as this
                # first shipped, a range met the domain only on the first day
                # of the week, and a Tuesday reservation never moved a lunch.
                blocked.setdefault((group_id, day_index), []).append(
                    (
                        day_offset + max(first_bad, earliest_start),
                        day_offset + min(last_bad, latest_start),
                    ),
                )

        # An exempt day needs no subtraction: there is no lunch to place.
        for key in exempt:
            blocked.pop(key, None)
        return blocked, exempt

    def _lunch_starts_blocked_by_fixed_lessons(
        self,
        fixed_lessons: list[FixedLesson],
        lunch_group_ids: set[UUID],
        shares_students: dict[UUID, list[UUID]],
        earliest_start: int,
        latest_start: int,
        lunch_slots: int,
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """Lunch starts a group may not take, because a human already booked it.

        A locked lesson exists in the model only as a window the *generated*
        lessons steer around (_add_fixed_lesson_constraints); it is never an
        interval, so the free-window guarantee below has always been free to
        drop a class's lunch straight on top of a lesson somebody placed by
        hand. Now that the same interval also books seats, that puts the class
        in the hall at a time it is demonstrably sitting in a classroom.

        Both windows are constant, so the answer is arithmetic rather than a
        constraint: a break of `lunch_slots` starting at s clashes with a
        locked window [a, b) exactly for s in [a - lunch_slots + 1, b - 1].
        Handing that back as a domain to subtract costs no boolean, no
        interval and no propagator — and unlike a NoOverlap over constant
        intervals it stays quiet about two locked lessons that overlap each
        other, which is a school's own data problem and not a reason to refuse
        the whole week.

        `earliest_start` and `latest_start` bound an admissible lunch start
        within its day. A locked lesson that clears the window entirely is
        dropped here rather than carried down to subtract nothing.

        Which locked lessons reach a group is the rule
        _add_fixed_lesson_constraints already applies: the groups the lesson
        names (extra_group_ids included, since a lesson two classes attend
        holds both of them), plus every group sharing students with one of
        them. `lunch_group_ids` is the set that will actually get a break, so
        a lesson naming a group nobody is feeding subtracts nothing.
        """
        blocked: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        slots_per_day = self._grid.slots_per_day
        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                # Outside the grid: it falls on no day a lunch falls on.
                continue
            abs_start, abs_end = window
            day_index = abs_start // slots_per_day
            day_offset = day_index * slots_per_day
            # Starts this locked lesson rules out, in the day's own coordinates
            # so they can be compared with the lunch window straight off.
            first_bad = abs_start - day_offset - lunch_slots + 1
            last_bad = abs_end - day_offset - 1
            if last_bad < earliest_start or first_bad > latest_start:
                # Wholly outside the lunch window: every start it forbids was
                # inadmissible to begin with.
                continue

            reached: list[UUID] = []
            for named_id in (fixed.student_group_id, *fixed.extra_group_ids):
                for group_id in (named_id, *shares_students.get(named_id, ())):
                    if group_id in lunch_group_ids and group_id not in reached:
                        reached.append(group_id)
            for group_id in reached:
                blocked.setdefault((group_id, day_index), []).append(
                    (day_offset + first_bad, day_offset + last_bad),
                )
        return blocked

    def _add_rules_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rules: ScheduleRules | None,
        day_vars: dict[str, cp_model.IntVar],
        fixed_lessons: list[FixedLesson],
        groups: list[AnonymousGroup],
        constraints: list[AnonymousConstraint],
        servings: list[LunchServing],
        frames: list[FrameTime],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
        lunch_placements: list[LunchPlacement] | None = None,
    ) -> dict[tuple[UUID, int], cp_model.IntVar]:
        """Hard school rules: lunch break, dining hall seats, lessons per day.

        Returns the lunch start variable per (student group, day index), so the
        sitting the solver chose can be read back. It was always decided here
        and always discarded — this method was declared `-> None` and the
        variable was a loop-local. Returning the map is the whole of the fix;
        no constraint changes.

        `fixed_lessons` and `groups` are required, unlike `group_conflicts`,
        which follows its siblings in defaulting to None. The difference is
        what a caller that forgets one gets: an omitted `group_conflicts` is a
        payload that genuinely has none, while an omitted `fixed_lessons` or
        `groups` would build a model with no locked-lesson blocking and an
        empty dining hall and say nothing about it. A TypeError names the
        caller; a default would have let it profile the wrong model in silence.
        """
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar] = {}
        if rules is None:
            return lunch_starts

        by_group: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_group.setdefault(
                decision.lesson.requirement.student_group_id, [],
            ).append(decision)

        shares_students = _groups_sharing_students(group_conflicts)

        # --- Max lessons per day per student group -------------------------
        max_per_day = rules.max_lessons_per_day_per_group
        if max_per_day is not None:
            day_count = len(self._grid.schedule_days)
            for group_id, group in by_group.items():
                if len(group) <= max_per_day:
                    continue
                days = [self._day_var(model, d, day_vars) for d in group]
                for day_index in range(day_count):
                    on_day: list[cp_model.IntVar] = []
                    for k, decision in enumerate(group):
                        b = model.NewBoolVar(
                            f"onday_{group_id}_{day_index}_{decision.lesson.key()}",
                        )
                        model.Add(days[k] == day_index).OnlyEnforceIf(b)
                        model.Add(days[k] != day_index).OnlyEnforceIf(b.Not())
                        on_day.append(b)
                    model.Add(sum(on_day) <= max_per_day)

        # --- Guaranteed lunch break per student group per day ---------------
        if _lunch_window_is_set(rules):
            window_start, window_end, lunch_slots = self._lunch_window_slots(rules)

            seats = rules.dining_seats
            seats_literal = None
            if seats is not None:
                # A cumulative takes no OnlyEnforceIf, so the only way a full
                # dining hall can reach a conflict core is to be the PRESENCE
                # of the sittings in it: assume the literal and the seat rule
                # is in force, drop it and every sitting vanishes and the
                # cumulative says nothing. One literal serves every sitting —
                # they stand or fall together — so the whole mechanism costs a
                # single boolean. Without it the response degrades to the
                # INSUFFICIENT_RESOURCES fallback, which tells a school to
                # look at its rooms and teacher time for a problem that is
                # neither.
                seats_literal = registry.register(
                    model,
                    name="dining_capacity",
                    category="DINING_CAPACITY",
                    code="LUNCH_SEATS_CANNOT_STAGGER",
                    params={"seats": seats},
                )

            # Everyone who gets a break, and what each of them needs in chairs.
            # Both read the payload's `groups` rather than the decisions, which
            # is the whole of the fix for a class whose week is hand-placed:
            # such a class has no requirement left and so no decisions, and
            # while these came off the requirements it was invisible at lunch
            # while being plainly visible everywhere else.
            lunch_group_ids = _lunch_group_ids(groups)
            headcount_by_group = _lunch_headcounts(groups)
            # A meal has no requirement, so the stage it belongs to comes off
            # the group itself. A group with no derivable years matches no
            # serving and no frame and keeps the school-wide window.
            span_by_group = {
                group.id: (group.min_grade_level, group.max_grade_level)
                for group in groups
                if group.min_grade_level is not None and group.max_grade_level is not None
            }

            # The meals the school placed by hand, read once for the model.
            pins = self._lunch_pins(lunch_placements or [], lunch_group_ids)

            # Lunch starts a locked lesson has already taken away. Computed
            # once for the whole model: the windows are constant, so this is
            # arithmetic on the payload rather than anything in the model.
            blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
                fixed_lessons,
                set(lunch_group_ids),
                shares_students,
                window_start,
                window_end - lunch_slots,
                lunch_slots,
            )
            closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
                constraints,
                set(lunch_group_ids),
                window_start,
                window_end - lunch_slots,
                window_end,
                lunch_slots,
            )

            # "There is a contiguous free window of `lunch_slots` inside the
            # lunch window" is exactly "a mandatory task of that length can be
            # placed among this group's lessons". Handing that to the
            # disjunctive propagator as one movable interval per (group, day)
            # replaces an existential over every candidate start:
            #
            #   was:  3 booleans per (group x day x candidate x lesson)
            #         — 302,400 variables at 2,000 students, 46% of the model
            #   now:  1 interval per (group, day) — 400 variables
            #
            # The old encoding also propagated almost nothing: its final
            # AddBoolOr over the per-candidate literals could not prune until
            # every candidate but one had been individually refuted, which needs
            # the lesson starts nearly fixed. The interval form lets CP-SAT
            # deduce "these lessons plus a mandatory break do not fit" up front.
            #
            # The NoOverlap below spans the group's lessons *and* its lunch
            # intervals, so it also covers single-lesson groups, which
            # _add_group_no_overlap skips.

            # --- The dining hall's seats ----------------------------------
            #
            # EVERY HOME CLASS EATS EVERY SCHOOL DAY. The demand is
            # unconditional: the class's headcount, on the lunch interval it
            # already has, on every day of the grid. Two rounds of review
            # killed the alternative, which asked a presence literal whether
            # the group was "in the building" that day. The payload carries one
            # headcount per group and no finer grain — it cannot say "eight of
            # 7A are here" — so that question has no honest answer. Asking only
            # about the group's own lessons booked nought seats for a class at
            # school through a teaching group. Widening it to every group
            # sharing its students booked all N home classes in full the moment
            # one nivågrupp met, an over-count unbounded in N that refuses a
            # timetable and blames the hall. Locked lessons were invisible to
            # both. Unconditional demand has neither error: a day's total is
            # exactly the size of the school.
            #
            # What it costs, said plainly rather than buried: a class with a
            # completely empty day still books seats it will not use. That is
            # the only inexactness left, it errs towards a hall held for
            # children who stayed at home rather than children sent to a room
            # with no chairs in it, and a school can be told it in one
            # sentence — every class eats every school day.
            sittings: list[cp_model.IntervalVar] = []
            headcounts: list[int] = []

            slots_per_day = self._grid.slots_per_day
            for group_id in lunch_group_ids:
                # Empty for a class whose whole week is locked. Its NoOverlap
                # below then spans nothing but its own five lunch intervals,
                # one per day, which are disjoint by construction — a vacuous
                # constraint, and deliberately not special-cased. The interval
                # is still worth building: it is what the locked-lesson domain
                # restriction narrows and what books the class's chairs.
                lessons = by_group.get(group_id, [])
                # Partners with lessons to dodge. The relation itself keeps the
                # ones the timplan never mentions, because their locked lessons
                # still count; here there is nothing to put in a NoOverlap.
                sharing = [
                    other_id
                    for other_id in shares_students.get(group_id, ())
                    if other_id in by_group
                ]
                # Home classes only. The gateway sends a teaching group's
                # headcount as 0 because its students already eat with their
                # home class, and a group contributing nothing is left out of
                # the cumulative rather than added with demand 0: an interval
                # that occupies no seat is pure propagator work. A group the
                # gateway has not listed at all reads the same way — "nobody
                # has told us who eats" — which is what the engine sees until
                # the gateway that sends `groups` is deployed.
                headcount = headcount_by_group.get(group_id, 0)
                lunch_intervals: list[cp_model.IntervalVar] = []
                for day_index in range(len(self._grid.schedule_days)):
                    # The school has closed this day for this class. No lunch
                    # variable, no mandatory interval, no seat demand — the
                    # class is not in the building to eat.
                    if (group_id, day_index) in exempt_days:
                        continue
                    day_offset = day_index * slots_per_day
                    # Inclusive bounds matching the candidate enumeration this
                    # replaces: range(window_start, window_end - lunch_slots + 1).
                    pin = pins.get((group_id, day_index))
                    low, high = self._lunch_start_bounds(
                        pin, day_offset, window_start, window_end, lunch_slots,
                    )
                    lunch_start = model.NewIntVar(
                        low, high, f"lunchstart_{group_id}_{day_index}",
                    )
                    lunch_starts[(group_id, day_index)] = lunch_start

                    # The school's own sentence about when this stage eats, and
                    # the hours its stage may be taught in at all. Both narrow
                    # the DOMAIN rather than forbidding intervals in it — the
                    # same reason a frame narrows a lesson's start.
                    #
                    # UNCONDITIONAL, not under an assumption literal, unlike the
                    # two subtractions below. A narrowed domain that turns out
                    # empty is refused by name in _validate_request before any
                    # solve begins, so CP-SAT never meets one; an assumption
                    # would buy a conflict core for a case that cannot reach it.
                    declared = self._declared_lunch_domain(
                        servings,
                        frames,
                        span_by_group.get(group_id),
                        self._grid.schedule_days[day_index],
                        day_offset,
                        window_start,
                        window_end,
                        lunch_slots,
                    )
                    # A pinned meal outranks the sitting and the frame: that
                    # is what placing it by hand means.
                    if declared is not None and pin is None:
                        model.AddLinearExpressionInDomain(lunch_start, declared)

                    # And the locks and reservations are not narrowings of a
                    # pinned meal: _verify_lunch_placements refused any pin
                    # that lands on one, so on a pinned day they say nothing.
                    forbidden = None if pin is not None else blocked_starts.get((group_id, day_index))
                    if forbidden:
                        # UNDER AN ASSUMPTION LITERAL, not bare. A bare domain
                        # subtraction lets CP-SAT prove infeasibility without
                        # touching a single assumption, and
                        # SufficientAssumptionsForInfeasibility then returns an
                        # empty core — which does not merely lose this cause,
                        # it erases every other cause in the payload and hands
                        # the school the INSUFFICIENT_RESOURCES fallback,
                        # telling it to go and look at rooms and teacher time.
                        # One lock anywhere silently blinded the whole
                        # diagnosis. AddLinearExpressionInDomain takes
                        # OnlyEnforceIf (verified on ortools 9.15: the proto
                        # carries an enforcement_literal on the linear
                        # constraint), so the fact costs one boolean and
                        # nothing else. In the fast build the literal is pinned
                        # by AddBoolAnd and presolve folds the enforcement
                        # away, so the encoding is unchanged there.
                        #
                        # GROUP_OVERLAP, deliberately not AVAILABILITY: in this
                        # engine AVAILABILITY means an AvailabilityConstraint
                        # row and its message names one, so an admin sent there
                        # would open the reservations page and find nothing to
                        # change. Nor DINING_CAPACITY, which would be a lie —
                        # this fails with no seat limit set at all. What
                        # actually collides is the group's mandatory break and
                        # lessons its own children are sitting in, which is a
                        # group double-booked.
                        #
                        # Per (group, day) rather than one literal for the
                        # school, because "7A on Tuesday" is the whole content
                        # of the answer. The count is bounded by groups x days,
                        # an order of magnitude under what
                        # _add_capacity_constraints already registers per lesson.
                        lunch_literal = registry.register(
                            model,
                            name=f"lunchlock_{group_id}_{day_index}",
                            category="GROUP_OVERLAP",
                            # The same fact _validate_request refuses by
                            # name when the locks alone leave nothing, said
                            # through the one code both use.
                            code="LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
                            params={
                                "group": str(group_id),
                                "minutes": rules.lunch_minutes,
                                "windowStart": rules.lunch_start_time[:5],
                                "windowEnd": rules.lunch_end_time[:5],
                                "day": self._grid.schedule_days[day_index],
                            },
                            resource_ids=[group_id],
                        )
                        model.AddLinearExpressionInDomain(
                            lunch_start,
                            self._admissible_lunch_starts(
                                day_offset,
                                window_start,
                                window_end,
                                lunch_slots,
                                forbidden,
                            ),
                        ).OnlyEnforceIf(lunch_literal)

                    closed = None if pin is not None else closed_starts.get((group_id, day_index))
                    if closed:
                        # A SECOND literal rather than one domain merged with
                        # the locked-lesson one above. The two fail for reasons
                        # a school fixes in different places — a lesson to move
                        # versus a reservation to change — and a merged literal
                        # could only name one of them. AVAILABILITY here is
                        # honest, unlike the locked-lesson case: this IS an
                        # AvailabilityConstraint row and the id below is one an
                        # admin can look up.
                        closed_literal = registry.register(
                            model,
                            name=f"lunchclosed_{group_id}_{day_index}",
                            category="AVAILABILITY",
                            code="LUNCH_AVAILABILITY_LEAVES_NO_BREAK",
                            params={
                                "group": str(group_id),
                                "minutes": rules.lunch_minutes,
                                "windowStart": rules.lunch_start_time[:5],
                                "windowEnd": rules.lunch_end_time[:5],
                                "day": self._grid.schedule_days[day_index],
                            },
                            resource_ids=[group_id],
                        )
                        model.AddLinearExpressionInDomain(
                            lunch_start,
                            self._admissible_lunch_starts(
                                day_offset,
                                window_start,
                                window_end,
                                lunch_slots,
                                closed,
                            ),
                        ).OnlyEnforceIf(closed_literal)
                    if pin is not None:
                        # THE SCHOOL'S OWN MEAL, held where it was placed. Under
                        # a literal, never bare, for the reason the locked
                        # lessons above give: a bare equality lets CP-SAT prove
                        # a week impossible without touching an assumption, and
                        # the empty core that follows erases every other cause
                        # in the payload. The mandatory interval below is
                        # unchanged — the lessons still route round the meal —
                        # and so is the seat interval, because a meal the
                        # school placed does not make the hall any larger.
                        pin_literal = registry.register(
                            model,
                            name=f"lunchpin_{group_id}_{day_index}",
                            category="LUNCH_WINDOW",
                            code="LUNCH_PLACED_BY_HAND",
                            params={
                                "group": str(group_id),
                                "day": self._grid.schedule_days[day_index],
                                "start": self._grid.format_hhmmss(pin, 0)[0][:5],
                            },
                            resource_ids=[group_id],
                        )
                        model.Add(lunch_start == day_offset + pin).OnlyEnforceIf(pin_literal)
                    lunch_intervals.append(
                        model.NewFixedSizeIntervalVar(
                            lunch_start,
                            lunch_slots,
                            f"lunch_{group_id}_{day_index}",
                        ),
                    )
                    if seats_literal is not None and headcount > 0:
                        # The same start and the same length as the mandatory
                        # interval beside it, so the two views of one lunch can
                        # never disagree — but a SECOND interval object, because
                        # its presence is the dining assumption. Relaxing that
                        # assumption must empty the hall without also giving up
                        # the free-window guarantee, and it would give it up if
                        # the interval in the NoOverlap were the optional one.
                        sittings.append(
                            model.NewOptionalFixedSizeIntervalVar(
                                lunch_start,
                                lunch_slots,
                                seats_literal,
                                f"sitting_{group_id}_{day_index}",
                            ),
                        )
                        headcounts.append(headcount)
                if lunch_intervals:
                    model.AddNoOverlap(
                        [padded_of(model, decision) for decision in lessons]
                        + lunch_intervals,
                    )
                    # The break also has to be free of the lessons this group's
                    # own children sit in elsewhere. 7A cannot be eating while
                    # Ma71 is taught: those are the same thirty pupils, and the
                    # model would otherwise record a lunch that nobody had.
                    #
                    # One NoOverlap per sharing group, deliberately NOT one
                    # over the union of them all. Ma71 and Sp71 are both cut
                    # out of 7A but share no student with each other, and a
                    # single set containing both would forbid them from running
                    # at the same time — which is precisely what a school cuts
                    # parallel groups in order to do.
                    #
                    # Nothing lesson-against-lesson is added here: the partner's
                    # own lessons are already pairwise disjoint through
                    # _add_group_no_overlap, and so is every lesson pair across
                    # a sharing pair. The one new fact is lunch-against-lesson,
                    # so do not "simplify" this by folding it into the pair
                    # NoOverlap over there — that one carries no lunch.
                    for other_id in sharing:
                        model.AddNoOverlap(
                            [padded_of(model, decision) for decision in by_group[other_id]]
                            + lunch_intervals,
                        )

            if sittings:
                # One cumulative for the whole week, not one per day. Every
                # sitting's start is confined to its own day by day_offset —
                # TimeGrid addresses day d as [d * slots_per_day, (d+1) *
                # slots_per_day) and the interval ends inside the lunch window —
                # so two sittings on different days provably cannot overlap and
                # five per-day cumulatives would only cost five times the
                # constraints to say the same thing.
                model.AddCumulative(sittings, headcounts, seats)

        return lunch_starts

    @staticmethod
    def _room_allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
        capacity_ok = room.capacity is None or room.capacity >= requirement.student_group_size
        type_ok = (
            requirement.required_room_type is None
            or room.type == requirement.required_room_type
        )
        return capacity_ok and type_ok and _grade_allowed(room, requirement)

    @staticmethod
    def _lock_aware(
        locked: dict[UUID, frozenset[UUID]],
    ) -> tuple[
        Callable[[AnonymousRoom, AnonymousRequirement], bool],
        Callable[[AnonymousRequirement], tuple],
    ]:
        """The eligibility predicate and its profile key, both aware of locks.

        A LOCK IS FOLDED INTO ELIGIBILITY AND NOWHERE ELSE, and that placement
        is forced rather than chosen. add_room_allocation opens EVERY class when
        a lesson has none, and _add_capacity_constraints skips when nothing
        fits, so a lock enforced anywhere else is silently dropped rather than
        refused — on a run CP-SAT reports OPTIMAL. _room_allowed is already the
        single predicate behind all three consumers (the pre-solve refusal, the
        room_index constraints and the class partition), so folding it in here
        makes the lock inherit the existing refusal for free.
        Never as a large weight, either: the objective drops its term exactly
        when the rule is impossible, so a heavy "lock" would vanish in silence.

        THE KEY COMES BACK WITH THE PREDICATE, as one pair from one function.
        The partition stands one representative requirement in for its whole
        profile, so a field the predicate reads and the key omits places a
        lesson in a room it was never allowed — which is precisely the bug the
        stage limits caused, and locks are a second chance to cause it. Handing
        the two out together is what stops them being edited apart.
        """

        def allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
            if not SchedulerSolver._room_allowed(room, requirement):
                return False
            rooms_allowed = locked.get(requirement.id)
            return rooms_allowed is None or room.id in rooms_allowed

        def key(requirement: AnonymousRequirement) -> tuple:
            return (
                *SchedulerSolver._room_profile_key(requirement),
                locked.get(requirement.id),
            )

        return allowed, key

    @staticmethod
    def _room_profile_key(requirement: AnonymousRequirement) -> tuple:
        """Exactly the fields _room_allowed reads, and nothing else.

        DIRECTLY ABOVE ITS PREDICATE ON PURPOSE. build_room_classes stands one
        representative requirement in for its whole profile, so a field the
        predicate consults and this key omits collapses two different
        eligibilities into one class and places a lesson in a room it was never
        allowed. That is exactly how year limits leaked: the key named type and
        size, `_grade_allowed` had been added to the predicate, and nothing
        connected the two. Adding a term to _room_allowed means adding it here,
        and the pair is adjacent so the omission is visible rather than two
        files apart.
        """
        return (
            requirement.required_room_type,
            requirement.student_group_size,
            requirement.min_grade_level,
            requirement.max_grade_level,
        )

    def _add_lunch_stability_objective(
        self,
        model: cp_model.CpModel,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Pay for every slot a group's meal drifts off its own first day.

        NOTHING in this model mentioned lunch_start before: the five objective
        families all take `decisions`, so the meal was placed wherever
        propagation happened to leave it. Two runs of one payload could return
        different lunch times, which was invisible while the value was thrown
        away and is the first thing a school notices once it is drawn.

        Measured against the group's OWN first day, not against a fixed hour.
        A school-wide target would fight the seat cumulative, whose whole job is
        to put different groups at different times; this asks only that a class
        eats at the same time on Tuesday as it did on Monday, which staggering
        has no quarrel with.

        Day-local, so the comparison is between clock times rather than between
        positions on the week's line — every day's offset would otherwise swamp
        the difference this measures.

        The lowest weight in the model, and deliberately: a steady meal is worth
        having and worth nothing at the cost of a lesson.
        """
        if weights.lunch_drift <= 0:
            return []

        slots_per_day = self._grid.slots_per_day
        by_group: dict[UUID, list[tuple[int, cp_model.IntVar]]] = {}
        for (group_id, day_index), variable in lunch_starts.items():
            by_group.setdefault(group_id, []).append((day_index, variable))

        terms: list[cp_model.LinearExpr] = []
        for group_id, days in by_group.items():
            days.sort()
            if len(days) < 2:
                continue
            first_day, first_var = days[0]
            for day_index, variable in days[1:]:
                drift = model.NewIntVar(
                    -slots_per_day, slots_per_day, f"lunchdrift_{group_id}_{day_index}",
                )
                model.Add(
                    drift
                    == (variable - day_index * slots_per_day)
                    - (first_var - first_day * slots_per_day),
                )
                magnitude = model.NewIntVar(
                    0, slots_per_day, f"lunchdriftabs_{group_id}_{day_index}",
                )
                model.AddAbsEquality(magnitude, drift)
                terms.append(weights.lunch_drift * magnitude)

        return terms

    def _lunches_of(
        self,
        solver: cp_model.CpSolver,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        rules: ScheduleRules | None,
    ) -> list[ScheduledLunch]:
        """Sittings, or none if the school reserves no lunch.

        The map is empty in that case anyway; the guard is on `lunch_minutes`,
        which is what _extract_lunches needs and which is None exactly when the
        window is unset.
        """
        if rules is None or rules.lunch_minutes is None:
            return []
        return self._extract_lunches(solver, lunch_starts, rules.lunch_minutes)

    def _extract_lunches(
        self,
        solver: cp_model.CpSolver,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        lunch_minutes: int,
    ) -> list[ScheduledLunch]:
        """The sitting each group got, decoded the same way a lesson is.

        `lunch_starts` must come from the SAME build whose solver is passed in.
        solve() runs four models — the full one, an objective-free twin, a
        cleared Clone of the full one, and the assumptions rebuild — and
        solver.Value() resolves a variable by INDEX, not by identity.

        Measured, because the honest version of this warning is narrower than it
        first looks: today the two builds give the lunch variables the SAME
        indices, because _build_model appends every objective auxiliary after
        the rules are added. Passing the wrong map is therefore currently
        harmless — by accident. It stops being harmless the moment an objective
        term allocates a variable earlier, or the build order is rearranged, and
        the failure would be silent: a real number from a model nobody solved.
        Taking the map from the winning build costs nothing and removes the
        accident from the load-bearing path; test_the_two_builds_agree_on_lunch_
        variable_indices pins the assumption so its expiry is noisy.
        """
        duration = self._grid.minutes_to_slots(lunch_minutes)
        lunches: list[ScheduledLunch] = []
        for (group_id, _day_index), variable in lunch_starts.items():
            day_of_week, start_slot = self._grid.decode_absolute(solver.Value(variable))
            start_time, end_time = self._grid.format_hhmmss(start_slot, duration)
            lunches.append(
                ScheduledLunch(
                    student_group_id=group_id,
                    day_of_week=day_of_week,  # type: ignore[arg-type]
                    start_time=start_time,
                    end_time=end_time,
                ),
            )
        # Stable order: the dict is insertion-ordered by (group, day) already,
        # but a response a school reads should not depend on that being true.
        lunches.sort(key=lambda lunch: (str(lunch.student_group_id), lunch.day_of_week))
        return lunches

    def _extract_lessons(
        self,
        solver: cp_model.CpSolver,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        room_plan: RoomPlan,
    ) -> list[ScheduledLesson]:
        # room_index is not authoritative under the class encoding — the
        # post-pass is. Reading room_index here would double-book rooms.
        room_by_key = room_plan.assign_rooms(solver)
        lessons: list[ScheduledLesson] = []
        for decision in decisions:
            absolute_start = solver.Value(decision.start)
            day_of_week, start_slot = self._grid.decode_absolute(absolute_start)
            start_time, end_time = self._grid.format_hhmmss(start_slot, decision.duration)
            room_idx = room_by_key[decision.lesson.key()]
            lessons.append(
                ScheduledLesson(
                    requirement_id=decision.lesson.requirement.id,
                    room_id=rooms[room_idx].id,
                    day_of_week=day_of_week,  # type: ignore[arg-type]
                    start_time=start_time,
                    end_time=end_time,
                ),
            )
        return lessons

    @staticmethod
    def _map_status(status_code: int) -> SolverStatus:
        """Translate a CP-SAT status into the public API status.

        Only cp_model.INFEASIBLE maps to "INFEASIBLE" — that code means the
        search space was exhausted and no timetable exists. cp_model.UNKNOWN
        means the solver hit max_time_in_seconds with nothing found and nothing
        proven; reporting it as INFEASIBLE would tell a school its requirements
        are impossible when the real answer is "needs more solver time".

        cp_model.MODEL_INVALID is rejected in solve() before reaching here; it
        falls through to "TIMEOUT" only as a defensive default.
        """
        if status_code == cp_model.OPTIMAL:
            return "OPTIMAL"
        if status_code == cp_model.FEASIBLE:
            return "FEASIBLE"
        if status_code == cp_model.INFEASIBLE:
            return "INFEASIBLE"
        return "TIMEOUT"


def _hhmmss_to_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _clock_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _servings_for(
    servings: list[LunchServing],
    span: tuple[int, int] | None,
    day_of_week: int,
) -> list[LunchServing]:
    """The sittings open to one stage on one day, in declaration order.

    The same shadowing rule servings.allowed_starts applies — a day-specific row
    replaces the every-day rows — kept here rather than duplicated because the
    pre-flight has to agree with the domain it is predicting.
    """
    if span is None:
        return []
    span_min, span_max = span
    matching = [
        serving
        for serving in servings
        if not (span_max < serving.min_grade_level or span_min > serving.max_grade_level)
    ]
    today = [serving for serving in matching if serving.day_of_week == day_of_week]
    return today or [serving for serving in matching if serving.day_of_week is None]


def _domain_intervals(domain: cp_model.Domain) -> list[tuple[int, int]]:
    """A Domain's [lo, hi] pairs. FlattenedIntervals() returns them flat."""
    flat = domain.FlattenedIntervals()
    return [(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)]


def _lunch_window_is_set(rules: ScheduleRules) -> bool:
    """Whether the school actually asked for a lunch break.

    All three fields or none: a window with no length, or a length with no
    window, describes nothing the solver can build. Seats alone do not make a
    lunch rule either, which is why the seat check reads this too.
    """
    return (
        rules.lunch_start_time is not None
        and rules.lunch_end_time is not None
        and rules.lunch_minutes is not None
    )


def _lunch_group_ids(groups: list[AnonymousGroup]) -> list[UUID]:
    """Every group the solver owes a lunch break, in a stable order.

    EXACTLY THE PAYLOAD'S `groups`, and nothing derived from the lessons. The
    gateway decides who eats: it sends the HOME CLASSES, with their headcounts
    and their years, and a teaching group is not among them because its pupils
    already eat with their class. This used to union in every group that had a
    requirement — a shim for the release in which the engine shipped before the
    gateway that fills `groups` — and the shim had a cost once `groups` was
    real: a mandatory thirty-minute reservation on every teaching group's day
    for a meal nobody takes there, and an INFEASIBLE with a lunch cause on the
    day it did not fit. A class's meal is still kept clear of its teaching
    groups' lessons, through the shared-pupil pairs.

    Ordered rather than a set because both builds of the model iterate this
    and `solve` refuses to hint one from the other unless they agree
    structurally.
    """
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for group_id in (group.id for group in groups):
        if group_id not in seen:
            seen.add(group_id)
            ordered.append(group_id)
    return ordered


def _lunch_headcounts(groups: list[AnonymousGroup]) -> dict[UUID, int]:
    """Seats each group needs, keyed by group id.

    The largest of any duplicates, never the last one seen: two entries for
    one group is the gateway contradicting itself, and the whole point of
    counting every home class every day is that this number must not come out
    low.
    """
    headcounts: dict[UUID, int] = {}
    for group in groups:
        headcounts[group.id] = max(
            headcounts.get(group.id, 0), group.lunch_headcount,
        )
    return headcounts


def _groups_sharing_students(
    group_conflicts: list[tuple[UUID, UUID]] | None,
) -> dict[UUID, list[UUID]]:
    """Which groups put a given group's children in a classroom.

    The teaching groups cut out of a class, and the class a teaching group was
    cut from. That is exactly `group_conflicts`, the relation
    _add_group_no_overlap already uses to keep their lessons apart, and lunch
    needs it in both directions — each side's break has to reckon with the
    other side's lessons.

    Groups the timplan never mentions are kept, unlike in
    _add_group_no_overlap: a class whose every lesson is locked has no
    generated lessons, and its locked lessons still have to keep the teaching
    groups cut out of it from eating while its children are being taught.
    Callers that need decisions filter on `by_group` themselves.
    """
    shares_students: dict[UUID, list[UUID]] = {}
    for first_id, second_id in group_conflicts or []:
        for owner_id, other_id in ((first_id, second_id), (second_id, first_id)):
            if owner_id == other_id:
                continue
            partners = shares_students.setdefault(owner_id, [])
            if other_id not in partners:
                partners.append(other_id)
    return shares_students


def _grade_span_overlaps(
    constraint: AnonymousConstraint,
    requirement: AnonymousRequirement,
) -> bool:
    """Whether a reservation for a span of years reaches this group.

    OVERLAP, and deliberately the opposite test to _grade_allowed's
    containment a few lines below. Reserving 11:30 for years 4-6 holds those
    students free; a group spanning years 6-7 has year-6 students in it, so it
    has to be held free too. Holding a handful of year-7 students free as well
    costs the timetable a little room, whereas letting the lesson stand puts
    year-6 pupils in a classroom during their own lunch. One of those errors a
    school can live with and the other it cannot, so the rule is written to
    make the survivable one. Rooms reason the other way round because there
    half a group in an allowed year is still not an allowed placement.

    A group whose own years are unknown cannot be matched at all: with nothing
    to compare against, "overlaps" has no answer, and answering yes would
    sweep every group with no member years into a reservation meant for one
    stage of the school.

    A missing bound on the constraint is open at that end — "up to year 3" and
    "from year 7" are both a school's own way of saying stage.
    """
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return False

    if (
        constraint.min_grade_level is not None
        and requirement.max_grade_level < constraint.min_grade_level
    ):
        return False
    return not (
        constraint.max_grade_level is not None
        and requirement.min_grade_level > constraint.max_grade_level
    )


def _rule_reaches(
    preference: AnonymousRoomPreference,
    requirement: AnonymousRequirement,
) -> bool:
    """Whether a room rule scoped to a stage applies to this requirement.

    CONTAINMENT, like _grade_allowed and unlike _grade_span_overlaps, and for
    the same reason the one directly below states: a room decides where a group
    may GO, while a reservation only decides who must be left alone. Under
    overlap an åk 7-9 rule would seize a teaching group spanning 6-7 — a real
    shape, since spans come from members' home classes — and send its year-6
    pupils into a högstadie room. Not applying a rule is survivable; applying it
    to a group half outside the span is not.

    A rule with no span reaches everything, which is what every rule written
    before the span existed means, and is what keeps this change at exactly zero
    difference for a school that has not used it. A rule WITH a span does not
    reach a group whose own years are unknown: there is nothing to contain, and
    guessing would sweep every unlabelled group into a rule meant for one stage.
    """
    if preference.min_grade_level is None or preference.max_grade_level is None:
        return True
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return False
    return (
        requirement.min_grade_level >= preference.min_grade_level
        and requirement.max_grade_level <= preference.max_grade_level
    )


def _grade_allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
    """Whether a room limited to a stage may host this group.

    The group's whole year span has to fit inside the room's range: half a
    group being in an allowed year is not an allowed placement, since the
    other half would be sitting in a room the school reserved for somebody
    else. Containment, not the overlap _grade_span_overlaps uses for time
    reservations — the two rules read the same data and answer differently on
    purpose, because a room decides where a group may go while a reservation
    only decides who must be left alone.

    A group whose years are unknown — no members carrying a year — is let
    through. There is nothing to check it against, and refusing every limited
    room instead would make an unremarkable group unschedulable for a reason
    no message could explain.
    """
    if room.min_grade_level is None and room.max_grade_level is None:
        return True
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return True

    if room.min_grade_level is not None and requirement.min_grade_level < room.min_grade_level:
        return False
    return not (
        room.max_grade_level is not None
        and requirement.max_grade_level > room.max_grade_level
    )


def resolve_room_locks(
    requirements: list[AnonymousRequirement],
    preferences: list[AnonymousRoomPreference],
    rooms: list[AnonymousRoom],
) -> dict[UUID, frozenset[UUID]]:
    """requirement id -> the only rooms its locks allow. Absent means unlocked.

    THE NARROWEST SPAN WINS, AND EQUALLY NARROW RULES ARE ALTERNATIVES. Among
    the locks that reach a requirement, only those of the smallest width survive
    (a lock with no span counts as the widest, since it reaches every year), and
    the rooms of that tier UNION.

    Not intersection, even though a bound intersects in principle and that is
    what FrameTimes chose for its own kind. A frame is an interval and
    intersects continuously; a room set goes empty in ONE step. "Matte åk 4-6 ->
    Bryggan 3" plus "matte åk 4 -> Optimisten 4" would intersect to nothing, and
    a whole subject x stage becomes unschedulable from two sentences a school
    would reasonably write. Under specificity the second sentence reads as what
    a school means by it: an exception to the first.

    Not a plain union across every tier either, which is the LunchServings rule.
    Adding one broad lock would then silently weaken every narrow lock already
    written, and the narrow rule stops meaning what it says.

    Because ties union, the result is a pure function of the row set: order
    does not matter, there is no tiebreak by id, and it can never come back
    empty from two rules that each name a room. It CAN come back empty from a
    single rule whose rooms are all gone — which is a refusal, and
    _validate_request names it before any solve begins.
    """
    by_subject: dict[UUID, list[AnonymousRoomPreference]] = defaultdict(list)
    for preference in preferences:
        if preference.kind == "LOCK":
            by_subject[preference.subject_id].append(preference)
    if not by_subject:
        return {}

    locked: dict[UUID, frozenset[UUID]] = {}
    for requirement in requirements:
        reaching = [
            preference
            for preference in by_subject.get(requirement.subject_id, ())
            if _rule_reaches(preference, requirement)
        ]
        if not reaching:
            continue
        narrowest = min(_span_width(preference) for preference in reaching)
        allowed: set[UUID] = set()
        for preference in reaching:
            if _span_width(preference) == narrowest:
                allowed |= _preference_room_ids(preference, rooms)
        locked[requirement.id] = frozenset(allowed)
    return locked


def _span_width(preference: AnonymousRoomPreference) -> int:
    """How many years a rule covers. No span is the widest thing there is."""
    if preference.min_grade_level is None or preference.max_grade_level is None:
        return 14  # one more than 0-12, so it loses every tie to a real span
    return preference.max_grade_level - preference.min_grade_level + 1


def _preference_room_ids(
    preference: AnonymousRoomPreference,
    rooms: list[AnonymousRoom],
) -> set[UUID]:
    """The rooms a preference points at, whether by type or by name."""
    if preference.room_type is not None:
        return {room.id for room in rooms if room.type == preference.room_type}
    return set(preference.room_ids)


def _class_is_preferred(
    room_plan: RoomPlan,
    class_index: int,
    rooms: list[AnonymousRoom],
    preferred_rooms: set[UUID],
) -> bool:
    """Whether a class sits inside the preferred set.

    Every room of a class shares the preference bits that built it, so testing
    the first member decides the class — the same argument that makes the
    eligibility signature sound.
    """
    room_class = room_plan.classes[class_index]
    return rooms[room_class.room_indices[0]].id in preferred_rooms
