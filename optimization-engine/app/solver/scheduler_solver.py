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
    AnonymousTeacherWorkRule,
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
    #: Slots the PUPILS are occupied before the lesson and after it — changing,
    #: showering, changing again — rounded up onto the grid from the
    #: requirement's minutesBefore and minutesAfter. Zero for every lesson
    #: nobody has written a number for. See pupil_padded_of for who sees them.
    lead: int = 0
    trail: int = 0
    #: The interval plus that margin, built once and shared. See padded_of.
    _padded: cp_model.IntervalVar | None = None
    #: The same lesson as the PUPILS are occupied by it. See pupil_padded_of.
    _pupils: cp_model.IntervalVar | None = None


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

    THE CORRIDOR IS PADDED AT ONE END, THE PUPILS' CHANGING AT BOTH, AND THE
    DIFFERENCE IS NOT A STYLE. A corridor is ONE body walking between two
    places: the walk happens once between a pair of lessons, so each lesson
    carries it once, and a lesson carrying it at both ends would turn a
    ten-minute rule into a silent twenty and make 08:00 an illegal start for
    the first lesson of the day. Changing and showering are not a distance
    between two lessons but TIME THE PUPILS ARE UNAVAILABLE, and they are
    unavailable before the lesson as well as after it — so that margin is
    two-sided, and it lives in pupil_padded_of rather than here.

    THIS interval is what the TEACHER's family sees, and it is exactly what it
    saw before the pupils had a margin at all. The teacher is not the one
    changing: the user's decision is that idrottsläraren may take the next
    class the minute the lesson ends, and the room the pupils have left may be
    taken by anybody. Neither of them reads pupil_padded_of.

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


def pupil_padded_of(
    model: cp_model.CpModel, decision: LessonDecision,
) -> cp_model.IntervalVar:
    """The interval a family of PUPILS should see: `[start - lead, end + trail + changeover)`.

    The lesson, the minutes before it the class spends changing, and the
    minutes after it they spend showering and changing back. Every family whose
    members are the children reads this one — the class's own no-overlap, each
    family for a group that shares its pupils, and the lunch — while the
    teacher's family and the room pool keep reading padded_of. That split IS
    the feature: the pupils are busy, nobody else is.

    THE TRAILING MARGIN IS ADDITIVE, NOT A MAX. After idrotten a class showers,
    changes, and THEN walks to the next room, so a school that declares both a
    corridor and twenty minutes of shower has asked for both and gets their
    sum. A max would quietly spend the corridor twice — once as a corridor and
    once as part of the shower — and deliver a class to its next lesson still
    walking. The leading side takes no corridor of its own for the reason
    padded_of gives: the walk between two lessons is carried once, by the
    lesson before.

    NO NEW VARIABLES, on the same terms as padded_of: the start is `start`
    shifted by a constant and the end is `end` shifted by a constant, both
    affine, so this is one more interval proto and not one more IntVar. The
    start domain is what keeps `start - lead` inside its own day — see
    _create_lesson_decisions, which raises the lower bound by the lead for
    exactly that reason.

    Memoised like _padded, and for the same arithmetic: a lesson sits in its
    own group's family, in one family per sharing group and in the lunch's, so
    the interval is built once and handed out.

    ZERO IS THE MODEL AS IT WAS. With no buffers declared this returns
    padded_of's own answer — the padded interval, or the bare lesson when there
    is no corridor either — so a school that has written no number gets not one
    extra proto, and the pupils' families are the sets they have always been.
    """
    if decision.lead == 0 and decision.trail == 0:
        return padded_of(model, decision)
    if decision._pupils is None:
        decision._pupils = model.NewIntervalVar(
            decision.start - decision.lead,
            decision.duration + decision.lead + decision.trail + decision.changeover,
            decision.end + decision.trail + decision.changeover,
            f"pupils_{decision.lesson.key()}",
        )
    return decision._pupils


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


@dataclass(frozen=True)
class _TeacherDay:
    """One teacher's day, as the model addresses its two ends.

    `first` is the start of their earliest lesson that day and `last` the end
    of their latest, both in absolute slots; `works` is true exactly when they
    have a lesson on the day at all; `on_day` is the literal per lesson that
    decides it, and `taught` the slots those lessons occupy.

    TWO-SIDED AND UNCONDITIONAL, which is the difference between this and the
    pair _add_idle_time_objective used to build for itself. That one bounds
    `first` only from above and `last` only from below and says so: the
    objective minimises `last - first`, which drives each to the true extreme
    on its own, and the other half of every equality would have been two
    constraints bought for nothing.

    A HARD RULE CANNOT LEAN ON AN OBJECTIVE. The rest rule reads `last` on one
    day and `first` on the next, and the objective is not there to push them:
    it is switched off by a weight of zero, it skips a teacher with a single
    lesson, and on a day with no lesson at all nothing bounds either end. The
    direction the rest inequality happens to lean is the safe one today — it
    wants `last` small and `first` large, which are exactly the bounds the
    one-sided pair already carries — but that is a property of one inequality's
    shape and not of these variables, and the consecutive-teaching rule that is
    already planned reads them the other way round. So both ends are pinned,
    `works` is a variable rather than an assumption, and an empty day gives
    `first` the day's close and `last` its open: a span of minus a whole day,
    which the objective's floor at zero already handles and which no rest
    constraint is enforced over.
    """

    first: cp_model.IntVar
    last: cp_model.IntVar
    works: cp_model.IntVar
    on_day: tuple[cp_model.IntVar, ...]
    taught: cp_model.LinearExpr


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
        # Read off THIS request, never kept on the solver: the timeout probe
        # builds a relaxed copy of the week, and a week without its rasts or
        # its sittings may step further than the week that timed out.
        step = _start_step(request, self._grid)
        decisions = self._create_lesson_decisions(
            model, request.requirements, len(rooms), request.frame_times, request.rasts,
            step=step,
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
            step=step,
        )
        # After the lunch, because a rast's stretch is counted from the
        # previous break and the class's own meal can be that break.
        self._add_rast_ordering_constraints(
            model, registry, request, decisions, lunch_starts,
        )
        # The teachers' own lunch and rest. BEFORE THE OBJECTIVE, and that is
        # the only ordering this builder has: the idle term measures the same
        # two ends the rest rule bounds, and reads the pair left here in
        # `teacher_days` rather than building a second, weaker one of its own.
        # See _TeacherDay. Nothing here touches a lunch or a rast variable, so
        # its place among the other rule builders says nothing at all.
        teacher_days: dict[tuple[UUID, int], _TeacherDay] = {}
        self._add_teacher_work_constraints(
            model,
            registry,
            decisions,
            request.teacher_work_rules,
            request.fixed_lessons,
            request.constraints,
            day_vars,
            teacher_days,
            step=step,
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
                    teacher_days,
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
        lunch_group_ids = _lunch_group_ids(
            request.groups, _group_ids_with_lessons(request.requirements),
        )
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
            # Every LESSON's length, not every requirement's: a requirement of
            # 1 × 80 + 1 × 40 demands 120 minutes and packs on gcd(80, 40).
            lengths = [
                self._grid.minutes_to_slots(minutes)
                for r in requirements
                for minutes in r.lesson_minutes()
            ]

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
                    demand=sum(lengths),
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
            lunch_group_ids = _lunch_group_ids(
                request.groups, _group_ids_with_lessons(request.requirements),
            )
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
        self, request: OptimizeScheduleRequest, *, step: int,
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

        None as well when the payload names nobody, and there the builder no
        longer agrees: it owes such a school a meal per group with lessons
        (see _lunch_group_ids). The stage then decides nothing for that week
        and the full model carries its meals alone — slower to refuse a week
        with no room for them, and no less bound by them.

        Empty compositions are allowed to come out: _validate_request refuses
        a sitting or a lock that alone leaves no start, and only their
        intersection can still be empty. The caller decides what to make of
        that.

        The window is on `step`, the variable's own domain in the builder, so
        every narrowing composed with it is too. Nothing is lost by that: the
        window's ends and a pin are multiples of the step (see _start_step).
        """
        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules) or not request.groups:
            return None
        lattice = _start_lattice(step, self._grid.horizon)
        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
        lunch_group_ids = _lunch_group_ids(
            request.groups, _group_ids_with_lessons(request.requirements),
        )
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
                        window=_on_lattice(cp_model.Domain(low, high), lattice),
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
                    window=_on_lattice(
                        cp_model.Domain(
                            day_offset + window_start, day_offset + window_end - lunch_slots,
                        ),
                        lattice,
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
        narrowings = self._lunch_start_narrowings(
            request, step=_start_step(request, self._grid),
        )
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
        stay UNKNOWN at 15 s.

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

        ON THE FULL MODEL'S STEP, and still a relaxation of it: every start the
        stage may choose is one the model's own variable may take. A refusal
        here is a refusal of the model on the step, which _start_step shows is
        a refusal of the week.
        """
        narrowings = self._lunch_start_narrowings(
            request, step=_start_step(request, self._grid),
        )
        if narrowings is None:
            return None, {}
        if any(parts.composed().is_empty() for parts in narrowings.values()):
            # A sitting and a lock that each leave a start and together leave
            # none. _validate_request refuses that by name before any solve;
            # kept because CP-SAT calls a model with an empty domain invalid,
            # and a direct caller must not be able to hand it one.
            return None, {}
        stage = self._build_lunch_stage(request, narrowings)
        solver = self._lunch_stage_solver(self.LUNCH_STAGE_CAP_SECONDS)
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

    def _lunch_stage_solver(self, seconds: float) -> cp_model.CpSolver:
        """A solver for the stage whose search does not depend on the machine.

        THE PROOF IS THE LP RELAXATION, and asking for it by name is the whole
        point of this method. Left to itself CP-SAT sizes its portfolio from
        the host's core count, and the subsolver that carries the full
        linearization — max_lp_sym, which finishes this model while it is still
        loading — is only in the portfolio on a machine with cores to spare.
        Measured on Reproduction G, ortools 9.15: 0.17 s at eight workers,
        0.20 s at four, and 7.6-18.8 s at two or one, against a 10 s cap. So a
        two-core host did not refuse the week at all — it spent the cap, said
        UNKNOWN, and handed the school the 60 s TIMEOUT this stage exists to
        prevent. That is what CI's two-core runner had been reporting since the
        stage was written; a small VPS with SOLVER_CPUS=2 would read the same.

        One worker, not eight: asked for the linearization directly the proof
        takes 0.09 s single-threaded, which is faster than any portfolio found
        it, and a single worker makes CP-SAT deterministic — the same week now
        yields the same named causes on every machine, which matters more here
        than anywhere else in the solver, because these names are read by a
        school and quoted back to us in support.
        """
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        solver.parameters.num_workers = 1
        solver.parameters.linearization_level = 2
        return solver

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
            solver = self._lunch_stage_solver(remaining)
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
        # THE STEP, beside the grid it counts in. Per request, because the week
        # decides it: one lesson locked at 08:05 takes a school searched every
        # thirty minutes back to every five, and a log that only named the
        # grid would not show why the same school slowed down.
        step = _start_step(request, self._grid)
        logger.info(
            "start step: slot_minutes=%d step_slots=%d step_minutes=%d",
            self._grid.slot_minutes, step, step * self._grid.slot_minutes,
        )
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
            TD(2)           teacher lunch      a movable start and the literal
                            + TD(3L + 3)       its presence hangs on, per rule
                            teacher rest       and day; and for the rest, per
                                               day, a literal per lesson saying
                                               whether it is here, the two
                                               clamped ends it feeds a minimum
                                               and a maximum, and the day's own
                                               first, last and `works`, plus a
                                               literal per pair of consecutive
                                               days and, where the payload
                                               holds locked lessons, two more
                                               per day for folding one in. T
                                               counts only the teachers the
                                               timplan gives a lesson to, which
                                               is the builder's own skip
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

        NO TERM FOR THE PADDED INTERVALS, and that is a measurement rather than
        an omission. A lesson can now carry two extra interval protos — the
        corridor's padded_of and the pupils' pupil_padded_of — and each reuses
        the lesson's own `start` and `end` through affine expressions, so
        neither adds an IntVar or a BoolVar. What this function predicts is the
        VARIABLE count, which is what MAX_MODEL_COMPLEXITY is calibrated in, so
        the honest update for the pupils' interval was to check the arithmetic
        and write this paragraph. A future padding that needs a variable of its
        own — an AddMinEquality against the day's end, say, which is exactly
        what _create_lesson_decisions rejected in favour of clipping a domain —
        owes this table a term.

        On the 2,000-student benchmark this predicts ~99.6K against a measured
        92,546 — an upper bound within 8%. It is LOOSER where the teachers' work
        rules are filled in, and knowingly: on the 400-student gate week with
        both halves given to all 33 teachers it predicts 22,642 against 17,732,
        because the rest rule's day and the idle objective's are the same
        variables charged twice. Still an upper bound, which is the contract. If
        a builder's encoding changes,
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
                request.groups, _group_ids_with_lessons(request.requirements),
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
        # AND CHARGED IN FULL EVEN WHERE THE REST RULE PAID FOR IT. A teacher
        # with a rest rule has their day built two-sided by
        # _add_teacher_work_constraints, and this term then reuses that pair and
        # adds one `idle` variable — so the two terms together over-count such a
        # teacher by a day's worth of literals each. Deliberate: this function's
        # contract is an upper bound, and the alternative is a term that has to
        # know which of two builders ran first.
        idle_vars = 0
        if self._settings.weight_teacher_gap > 0:
            for teacher_lessons in lessons_by_teacher.values():
                if teacher_lessons >= 2:
                    idle_vars += day_count * (teacher_lessons + 3)

        # _add_teacher_work_constraints, one term per half. Only teachers the
        # timplan actually gives a lesson to, which is the builder's own skip: a
        # rule naming a teacher with nothing left to place builds nothing, and
        # charging it would make this an over-estimate for every school that
        # hand-places a teacher's whole week.
        teacher_work_vars = 0
        for rule in request.teacher_work_rules:
            teacher_lessons = lessons_by_teacher.get(rule.teacher_id, 0)
            if teacher_lessons == 0:
                continue
            if rule.has_lunch:
                teacher_work_vars += 2 * day_count
            if rule.min_daily_rest_minutes is not None:
                teacher_work_vars += (
                    day_count * (3 * teacher_lessons + 3)
                    + max(0, day_count - 1)
                    # The folded locked edge, at its worst case — which pair of
                    # (teacher, day) a locked lesson reaches needs a
                    # fixed-lessons x teachers scan, and the lunch-lock term
                    # above settles for the same bound for the same reason.
                    + (2 * day_count if request.fixed_lessons else 0)
                )

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
            + teacher_work_vars
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
            #
            # EVERY LENGTH OF THE REQUIREMENT, longest first, so a uniform one
            # is asked exactly what it always was and a split one names the
            # length that misses the grid rather than the one that does not.
            for minutes in sorted(set(requirement.lesson_minutes()), reverse=True):
                try:
                    self._grid.minutes_to_slots(minutes)
                except ValueError as error:
                    raise InvalidScheduleInputError.of("INPUT_LESSON_LENGTH_OFF_GRID", {
                        "requirement": str(requirement.id),
                        "minutes": minutes,
                        "slotMinutes": self._grid.slot_minutes,
                    }) from error
            # The longest is the one every check below measures: a frame, a
            # margin or a rast that holds it holds every shorter lesson too.
            duration_slots = self._grid.minutes_to_slots(requirement.minutes_per_lesson)
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

            # AND THE MARGINS ROUND THE LESSON, which the check above does not
            # count. It asks whether the WINDOW holds the lesson; the domain the
            # model then builds pushes the first start forward by the pupils'
            # leading buffer and pulls the last one back by their trailing one
            # and the corridor, because neither margin may cross into a
            # neighbouring day (_build_decisions argues both clips there). So a
            # window exactly as wide as the lesson passes the frame check and
            # empties the domain anyway — and an empty domain is not even an
            # INFEASIBLE with a core: CP-SAT raises `var #0 has no domain()`,
            # which became a SolverBuildError and reached the school as a 500
            # with nothing in it to act on. The corridor alone could do it
            # wherever a frame reached the day's end, which is older than the
            # pupils' buffer; the buffer widens the trigger to any window that
            # opens on the day's first slot.
            #
            # BEFORE THE RASTS, in the order the model itself empties the
            # domain: the day ranges are cut from the windows and these margins,
            # and only then do the rasts intersect what is left. A margin that
            # has already left no day to start on is the earlier fact.
            #
            # The arithmetic is _build_decisions', deliberately down to the
            # rounding: a second rule here would eventually disagree with the
            # model about which days it kept, and this refusal would either
            # refuse a week that would have solved or let the 500 back through.
            span = span_of(requirement)
            changeover = changeover_slots(request.frame_times, span, self._grid)
            lead = -(-requirement.minutes_before // self._grid.slot_minutes)
            trail = -(-requirement.minutes_after // self._grid.slot_minutes)
            # Skipped when every margin is zero, and not merely as an economy:
            # with no margins this asks exactly what the frame check above asked,
            # and the sentence would blame margins of zero for a window that is
            # simply too narrow for the lesson.
            if lead or trail or changeover:
                widest = 0
                for open_slot, close_slot in day_windows(
                    request.frame_times, span, self._grid,
                ).values():
                    first = max(open_slot, lead)
                    last = min(
                        close_slot, self._grid.slots_per_day - changeover - trail,
                    )
                    widest = max(widest, last - first)
                if widest < duration_slots:
                    grades = (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    )
                    # What a day still leaves for the LESSON once the margins
                    # have taken theirs — not the window, which the frame check
                    # already reports and which this school's window may be
                    # perfectly good.
                    #
                    # THE MARGINS ARE REPORTED AS THE GRID ROUNDS THEM, not as
                    # they were typed: seven minutes before on a five-minute grid
                    # takes ten, and ten is what leaves the window. Written the
                    # other way the sentence's own numbers would not add up to
                    # the window a school can measure them against — and the
                    # rounded figure is the one it has to get under.
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("MARGIN_NO_WINDOW_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "before": lead * self._grid.slot_minutes,
                        "after": trail * self._grid.slot_minutes,
                        "changeover": changeover * self._grid.slot_minutes,
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

        # THE TEACHERS' OWN LUNCH AND REST, whose refusals are arithmetic on
        # constants and belong here for the reason every refusal below gives: a
        # narrowed domain that turns out empty is a proof CP-SAT reaches without
        # touching one assumption literal, and the empty conflict core that
        # follows takes every other cause in the payload down with it.
        #
        # BEFORE THE LUNCH BLOCK BELOW, which returns early for a school that has
        # not set a lunch window. A teacher's own break has nothing to do with
        # the pupils' one, and behind that return a school with teacher rules and
        # no school-wide lunch would never have been told a thing.
        self._verify_teacher_work_rules(request)

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
                self._grid.minutes_to_slots(minutes)
                for requirement in group
                for minutes in requirement.lesson_minutes()
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
            request.groups, _group_ids_with_lessons(request.requirements),
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

    def _verify_teacher_work_rules(self, request: OptimizeScheduleRequest) -> None:
        """The three refusals a teacher's own lunch and rest can be arithmetic.

        THE ORDER IS THE ROW'S OWN. The lunch window's arithmetic first, because
        a window narrower than the break it has to hold is a number the school
        typed and can read back on the same screen; then what the locked lessons
        and reservations leave of that window, which sends the reader somewhere
        else entirely; then the rest, which is a different field and the one a
        school is least likely to have got wrong. A school whose window is too
        narrow must not be handed a sentence about Tuesday's locked lessons
        first, and change the wrong thing.

        A RULE THAT REACHES NO LESSON IS SKIPPED WHOLE, matching
        _add_teacher_work_constraints: a teacher with nothing left for the solver
        to place has no variable either rule could bound, and refusing a week
        over a row that could not have changed it is the one mistake a pre-flight
        check must not make.

        COUNTED GENEROUSLY, as _verify_rast_demands argues: every one of these
        over-counts what the week offers, so a week that is merely tight goes to
        the solver and is refused there by name. The rest check ignores the
        teacher's locked lessons and every frame, both of which can only shorten
        the night it measures; the lunch checks read the window through the same
        grid the model does, because there the alternative to agreeing with the
        model is not a refused week but an empty domain and a 500.
        """
        rules = request.teacher_work_rules
        if not rules:
            return

        lessons_by_teacher: dict[UUID, int] = {}
        shortest_by_teacher: dict[UUID, int] = {}
        for requirement in request.requirements:
            duration = self._grid.minutes_to_slots(requirement.shortest_lesson_minutes())
            for teacher_id in _teachers_of(requirement):
                lessons_by_teacher[teacher_id] = (
                    lessons_by_teacher.get(teacher_id, 0) + requirement.lessons_per_week
                )
                shortest_by_teacher[teacher_id] = min(
                    shortest_by_teacher.get(teacher_id, duration), duration,
                )

        slots_per_day = self._grid.slots_per_day
        day_count = len(self._grid.schedule_days)
        minutes = self._grid.slot_minutes
        reaching = [
            rule for rule in rules if lessons_by_teacher.get(rule.teacher_id, 0) > 0
        ]

        # The window against the break it has to hold.
        for rule in reaching:
            window = _teacher_lunch_slots(rule, self._grid)
            if window is None:
                continue
            window_start, window_end, lunch_slots = window
            if window_end - window_start < lunch_slots:
                raise InvalidScheduleInputError.of("TEACHER_LUNCH_WINDOW_TOO_NARROW", {
                    "rule": str(rule.id),
                    "minutes": rule.lunch_minutes,
                    "windowStart": rule.lunch_start_time[:5],
                    "windowEnd": rule.lunch_end_time[:5],
                    "remaining": max(0, window_end - window_start) * minutes,
                })

        # And what the locked lessons and the reservations leave of it, day by
        # day. The same two readers and the same subtraction the builder makes —
        # a second rounding rule here would eventually disagree with the model
        # about when a teacher may eat.
        if any(rule.has_lunch for rule in reaching):
            locked_busy = self._teacher_busy_from_locks(request.fixed_lessons)
            closed_busy = self._teacher_busy_from_constraints(request.constraints)
            for rule in reaching:
                window = _teacher_lunch_slots(rule, self._grid)
                if window is None:
                    continue
                window_start, window_end, lunch_slots = window
                for day_index, day_of_week in enumerate(self._grid.schedule_days):
                    day_offset = day_index * slots_per_day
                    key = (rule.teacher_id, day_index)
                    closed = closed_busy.get(key, [])
                    # A reservation over the whole window says the teacher is not
                    # here; the builder grants no break on such a day, so nothing
                    # can leave one too short.
                    if _covers(
                        closed, day_offset + window_start, day_offset + window_end,
                    ):
                        continue
                    locked = locked_busy.get(key, [])
                    # PER SOURCE, and not from `locked + closed`, because the
                    # `causes` key below names what the school has to go and
                    # change. Asking only whether the teacher HAS a lock or a
                    # reservation somewhere that day answers a different
                    # question: a locked lesson at 08:00 cannot take a lunch
                    # start away from a window that opens at 10:30, and naming
                    # it sends the rektor to move a lesson whose removal changes
                    # nothing. _forbidden_lunch_starts has already dropped the
                    # rows that rule out no admissible start, so its OUTPUT is
                    # the honest answer — which is what the group lunch's own
                    # causes read, from blocked_starts and closed_starts.
                    #
                    # Splitting the call changes no outcome: the helper is per
                    # interval and coalesces nothing, so two calls concatenated
                    # are the one call's list in another order, and the domain
                    # subtraction below is order-blind.
                    forbidden_by_source = [
                        (
                            name,
                            _forbidden_lunch_starts(
                                rows,
                                day_offset + window_start,
                                day_offset + window_end - lunch_slots,
                                lunch_slots,
                            ),
                        )
                        for name, rows in (("locked", locked), ("closed", closed))
                    ]
                    forbidden = [
                        band for _, bands in forbidden_by_source for band in bands
                    ]
                    if not forbidden:
                        continue
                    allowed = self._admissible_lunch_starts(
                        day_offset, window_start, window_end, lunch_slots, forbidden,
                    )
                    if not allowed.is_empty():
                        continue
                    # Which of the two it was, as ONE key rather than a joined
                    # list: "locked lessons and reservations" is an English list,
                    # and a language that inflects its members cannot be handed
                    # one already punctuated. The sentence branches on the key.
                    causes = [name for name, bands in forbidden_by_source if bands]
                    raise InvalidScheduleInputError.of("TEACHER_LUNCH_LEAVES_NO_START", {
                        "causes": "_".join(causes),
                        "rule": str(rule.id),
                        "minutes": rule.lunch_minutes,
                        "windowStart": rule.lunch_start_time[:5],
                        "windowEnd": rule.lunch_end_time[:5],
                        "day": day_of_week,
                    })

        # The rest against the longest night the week can offer.
        #
        # A week of one day has no pair of consecutive days and the builder adds
        # no constraint, so there is nothing to refuse.
        if day_count < 2:
            return
        for rule in reaching:
            if rule.min_daily_rest_minutes is None:
                continue
            rest_slots = -(-rule.min_daily_rest_minutes // minutes)
            shortest = shortest_by_teacher[rule.teacher_id]
            # The most favourable placement there is: the last lesson of one day
            # taken first thing in the morning, the first lesson of the next
            # taken as late as the day allows, and the teacher's SHORTEST lesson
            # in both places. Over the most favourable pair of days, which for a
            # school teaching Monday, Wednesday and Friday is a pair with two
            # nights in it.
            #
            # `pad + slots_per_day` is the whole distance between the same clock
            # time on the two days, which is what the rest is measured against:
            # the pad alone is the part of it the grid does not address, and
            # taking it for the night would refuse a week for want of the hours
            # the school teaches in.
            widest_night = (
                max(
                    _night_pad_slots(self._grid, day_index)
                    for day_index in range(day_count - 1)
                )
                + slots_per_day
            )
            longest_night = widest_night + (slots_per_day - shortest) - shortest
            if rest_slots <= longest_night:
                continue
            # THE ESCAPE, before refusing: a teacher who never teaches two days
            # in a row is never asked to rest between them. Whether their week
            # fits on the days that are not next to each other is counted
            # generously — every day filled to the brim with their shortest
            # lesson, frames, rooms and other teachers ignored — so this refuses
            # only a teacher whose lessons cannot possibly avoid a pair.
            per_day = slots_per_day // shortest
            if lessons_by_teacher[rule.teacher_id] <= -(-day_count // 2) * per_day:
                continue
            raise InvalidScheduleInputError.of("TEACHER_REST_LONGER_THAN_THE_NIGHT", {
                "rule": str(rule.id),
                "restMinutes": rule.min_daily_rest_minutes,
                "nightMinutes": max(0, longest_night) * minutes,
                "lessons": lessons_by_teacher[rule.teacher_id],
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
                    ) >= self._grid.minutes_to_slots(requirement.shortest_lesson_minutes())
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
                    self._grid.minutes_to_slots(r.shortest_lesson_minutes()) for r in owned
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
        THE TEACHERS' OWN TIME IS TWO, on the same principle — see there.
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
        if any(
            requirement.minutes_before > 0 or requirement.minutes_after > 0
            for requirement in request.requirements
        ):
            # BESIDE THE CORRIDOR AND FOR THE SAME MEASURED REASON: it lengthens
            # the interval an overlap check sees, and that is what turns a
            # one-second week into a whole budget. Worse than the corridor per
            # minute, in fact — it lengthens at both ends, so two lessons of the
            # class cost lead + trail between them — and better to report,
            # because a school CAN act on it: somebody typed twenty minutes on a
            # requirement, and fifteen may do. Named apart from the corridor
            # because the two are different rows on different screens, and "the
            # margin between lessons" would send a rektor to the wrong one.
            out.append((
                "PROBE_SOLVED_WITHOUT_PUPIL_BUFFERS",
                request.model_copy(update={
                    "requirements": [
                        requirement.model_copy(
                            update={"minutes_before": 0, "minutes_after": 0},
                        )
                        for requirement in request.requirements
                    ],
                }),
            ))
        # THE TEACHERS' OWN TIME IS TWO PROBES AND NEVER ONE, for the reason the
        # lunch below is three: "with the teachers' working time switched off, a
        # timetable was found" is true and useless, because a school cannot
        # switch its teachers' working time off. A guaranteed lunch is widened or
        # shortened; a night's rest is a different number on the same row; and
        # which of the two it is decides what a rektor does next.
        #
        # HERE IN THE ORDER, and the place is measured rather than guessed. On
        # the 400-student nightly gate week, 33 teachers and 576 lessons, with
        # both halves given to every teacher: the lunch adds 330 variables of
        # 8,465 and no measurable time (7.6s against 7.8s), while the rest adds
        # 9,267 — it builds three per teacher, day and lesson where the lunch
        # builds two per teacher and day — and takes the satisfaction solve from
        # 7.8s to 11.1s. So the rest is probed first.
        if any(
            rule.min_daily_rest_minutes is not None
            for rule in request.teacher_work_rules
        ):
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_REST",
                request.model_copy(update={
                    "teacher_work_rules": [
                        rule.model_copy(update={"min_daily_rest_minutes": None})
                        for rule in request.teacher_work_rules
                    ],
                }),
            ))
        if any(rule.has_lunch for rule in request.teacher_work_rules):
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_LUNCH",
                request.model_copy(update={
                    "teacher_work_rules": [
                        rule.model_copy(update={
                            "lunch_minutes": None,
                            "lunch_start_time": None,
                            "lunch_end_time": None,
                        })
                        for rule in request.teacher_work_rules
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
        # The widest SUM, not the widest single number: what the model pays per
        # lesson is the two ends together, and a requirement asking 10 before and
        # 20 after is a thirty-minute lesson longer than it looks.
        buffer_minutes = max(
            (r.minutes_before + r.minutes_after for r in request.requirements),
            default=0,
        )
        seats = request.rules.dining_seats if request.rules is not None else None
        # THE NUMBER THE MODEL FED, not the length of `groups`. They differ
        # exactly where this line matters most: a payload that names nobody is
        # still owed a meal per group with lessons, and reading the list's
        # length reported "0 groups eating" over a model carrying eighty lunch
        # intervals — naming as absent the very thing that shaped the week.
        # Zero without a lunch window, where the field says nothing either way.
        eating = (
            len(_lunch_group_ids(
                request.groups, _group_ids_with_lessons(request.requirements),
            ))
            if request.rules is not None and _lunch_window_is_set(request.rules)
            else 0
        )
        # How far apart the starts were searched. Equal to the grid means one
        # time somewhere off the week's coarser step — a lock at 08:05, a
        # 45-minute lesson among hours — put the whole school on every slot.
        step_minutes = _start_step(request, self._grid) * self._grid.slot_minutes
        # THE RULES THE MODEL ACTUALLY BUILT, not the length of the list, for the
        # reason the `eating` count above gives: a row naming a teacher the
        # timplan gives no lesson builds nothing at all, and a line reporting it
        # as in force would name as the week's shape a rule that never touched
        # it. Counted here rather than off the builder because this line is
        # written on a path where no model survives to be asked.
        with_lessons = {
            teacher_id
            for requirement in request.requirements
            for teacher_id in _teachers_of(requirement)
        }
        teacher_lunches = sum(
            1
            for rule in request.teacher_work_rules
            if rule.has_lunch and rule.teacher_id in with_lessons
        )
        teacher_rests = sum(
            1
            for rule in request.teacher_work_rules
            if rule.min_daily_rest_minutes is not None
            and rule.teacher_id in with_lessons
        )
        # One sentence per thing worth trying at zero, in the order the
        # measurements rank them, and none at all for a week that carries
        # neither — the line already says what was in force, and advice about a
        # rule nobody wrote is noise in a log somebody is reading at speed.
        hints = []
        if corridor > 0:
            hints.append(
                "A changeover lengthens every lesson for the overlap check and is the "
                "first thing to try at 0.",
            )
        if buffer_minutes > 0:
            hints.append(
                "A pupil buffer lengthens it at BOTH ends for the classes' own "
                "families — the teacher and the room are left free — so two lessons "
                "of one class cost the sum between them; worth a run at 0.",
            )
        return (
            f"TIMEOUT ({why}) [requestId={request.request_id}]: {lessons} lessons, "
            f"{len(request.requirements)} requirements, {eating} groups eating, "
            f"changeoverMinutes={corridor}, "
            f"pupilBufferMinutes={buffer_minutes}, rasts={len(request.rasts)}, "
            f"frameTimes={len(request.frame_times)}, diningSeats={seats}, "
            f"fixedLessons={len(request.fixed_lessons)}, "
            f"teacherLunches={teacher_lunches}, teacherRests={teacher_rests}, "
            f"startStepMinutes={step_minutes}, "
            f"budget={self._settings.solver_max_time_seconds}s. "
            + " ".join(hints)
        )

    def _create_lesson_decisions(
        self,
        model: cp_model.CpModel,
        requirements: list[AnonymousRequirement],
        room_count: int,
        frames: list[FrameTime],
        rasts: list[Rast],
        *,
        step: int,
    ) -> list[LessonDecision]:
        decisions: list[LessonDecision] = []
        horizon = self._grid.horizon

        slots_per_day = self._grid.slots_per_day
        lattice = _start_lattice(step, horizon)

        for requirement in requirements:
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
            # where the WINDOWS leave a requirement nowhere to go, so every
            # interval below is non-empty as far as the windows go.
            #
            # AND THE MARGINS BELOW ARE IN A REFUSAL OF THEIR OWN, beside that
            # one: a lesson that fits its stage's window exactly, whose margin
            # then does not, used to empty this domain and reach the caller as
            # CP-SAT's own "var has no domain" — a 500 where a named 4xx belongs.
            # The corridor can only do it where a frame reaches the day's end,
            # which is older than the pupils' buffer; a lead can do it wherever a
            # window is exactly as wide as the lesson and opens on the day's
            # first slot. MARGIN_NO_WINDOW_FOR_REQUIREMENT names the margin
            # rather than blaming the frame for minutes it does offer, and is
            # deliberately not folded into FRAME_NO_WINDOW_FOR_REQUIREMENT, whose
            # sentence would then be untrue about the frame. Its arithmetic is
            # the arithmetic below, and the two must stay the same one: a check
            # that rounded differently would either refuse a week this builds
            # perfectly well or let the 500 back through.
            span = span_of(requirement)
            windows = day_windows(frames, span, self._grid)
            changeover = changeover_slots(frames, span, self._grid)
            # The pupils' own margin, rounded UP for the reason a corridor is:
            # it is a floor on time the class is unavailable, so a value that
            # misses the grid takes the next whole slot rather than lose the
            # remainder. Seven minutes on a five-minute grid is two slots.
            lead = -(-requirement.minutes_before // self._grid.slot_minutes)
            trail = -(-requirement.minutes_after // self._grid.slot_minutes)
            # THE DAY'S EDGE IS CLIPPED IN THE DOMAIN, not with a constraint.
            #
            # A padded interval runs `changeover` slots past the lesson, and the
            # horizon addresses day d as [d*spd, (d+1)*spd) — so an unclipped
            # last lesson would pad into tomorrow morning's slots and collide
            # with a lesson that is not on the same day at all.
            #
            # BOTH EDGES NOW, because the pupils' interval reaches backwards as
            # well: it starts `lead` slots before the lesson, and a first lesson
            # left unclipped would have its changing room in YESTERDAY's last
            # slots — the same collision in the other direction, and an interval
            # with a start below the horizon's floor on day 0 besides.
            #
            # Two other fixes were considered and both are worse. A guard band
            # in TimeGrid (a `day_stride` wider than `slots_per_day`) re-encodes
            # every absolute slot for every school, so the next regeneration
            # moves lessons across the whole estate — and two places decode with
            # `// slots_per_day` that a rename would miss silently. An
            # AddMinEquality against the day's end costs an IntVar and a
            # constraint per lesson. Clipping the bounds costs nothing.
            #
            # THE FRAME BOUNDS THE TEACHING, THE DAY'S EDGE BOUNDS THE BODIES,
            # which is why the two compose as a min and a max rather than by
            # subtraction. A frame says which hours a stage may be TAUGHT in: a
            # lesson may end exactly at its close and still let the corridor and
            # the shower run past it, exactly as the corridor has always been
            # allowed to. What may not happen is either margin crossing into a
            # neighbouring day, and that is the day's own edge talking. So the
            # close is clipped with the whole trailing margin and the open is
            # raised only where the lead would otherwise reach below the day.
            #
            # The price is that the last lesson of a day may not END later than
            # the day's close minus those margins, which binds only for a school
            # teaching to 18:00 with no ramtid. Wherever a frame closes earlier,
            # `close_slot - duration` is the tighter bound and nothing is lost.
            #
            # ONE DOMAIN PER LENGTH. A requirement of 1 × 80 + 1 × 40 has two
            # kinds of lesson, and the last start of a day is the close minus
            # the lesson, so the 40 may start forty minutes later than the 80.
            # Built once per distinct length, longest first; a uniform
            # requirement builds the one domain it always built. Every check
            # _validate_request makes reads the longest, and a window, a margin
            # or a rast that holds the longest holds every shorter lesson too,
            # so no domain built here is empty where the longest's is not.
            domains: dict[int, cp_model.Domain] = {}
            lengths = [self._grid.minutes_to_slots(m) for m in requirement.lesson_minutes()]
            for duration in sorted(set(lengths), reverse=True):
                day_ranges: list[list[int]] = []
                for day, (open_slot, close_slot) in sorted(windows.items()):
                    first = max(open_slot, lead)
                    last = min(close_slot, slots_per_day - changeover - trail) - duration
                    # A day too narrow for this lesson drops out here rather than
                    # reaching Domain.FromIntervals as a reversed pair. That happens
                    # to be safe today — FromIntervals discards such a pair silently
                    # — but it is undocumented behaviour to hang a whole feature's
                    # correctness on, and "silently discards" is one release away
                    # from "raises".
                    if last < first:
                        continue
                    day_ranges.append(
                        [day * slots_per_day + first, day * slots_per_day + last],
                    )
                start_domain = cp_model.Domain.FromIntervals(day_ranges)

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
                # ON THE WEEK'S STEP, last. Every bound and hole above is cut on the
                # grid the school wrote it on, and only the starts between the
                # step's multiples go — none of which a timetable needs, and every
                # bound above is itself a multiple. _start_step says why.
                start_domain = _on_lattice(start_domain, lattice)
                domains[duration] = start_domain
            for lesson_index, duration in enumerate(lengths):
                lesson = LessonInstance(requirement=requirement, lesson_index=lesson_index)
                start = model.NewIntVarFromDomain(domains[duration], f"start_{lesson.key()}")
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
                        lead=lead,
                        trail=trail,
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
        """One teacher is one body: no overlapping lessons, corridor included.

        padded_of, NOT pupil_padded_of, and the line is the user's decision
        rather than an oversight. The minutes around an idrottslektion are the
        PUPILS' — changing and showering — and the teacher spends none of them
        undressed. Reading the pupils' interval here would forbid the very thing
        a school does on purpose: idrottsläraren taking the next class in the
        hall while the last one is still in the changing room.
        """
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

        BOTH LAYERS ARE FAMILIES OF CHILDREN, so both read pupil_padded_of: a
        class changing for idrotten is as unavailable as a class being taught,
        and the pupils Ma71 shares with 7A are the ones in the changing room.
        The teacher's family next door reads padded_of instead — see there.
        """
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            group_id = decision.lesson.requirement.student_group_id
            grouped.setdefault(group_id, []).append(decision)

        for group_decisions in grouped.values():
            if len(group_decisions) > 1:
                model.AddNoOverlap(
                    [pupil_padded_of(model, decision) for decision in group_decisions],
                )

        for first_id, second_id in group_conflicts or []:
            if first_id == second_id:
                continue
            combined = grouped.get(first_id, []) + grouped.get(second_id, [])
            if len(combined) > 1:
                model.AddNoOverlap([pupil_padded_of(model, decision) for decision in combined])

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

        ONE DISJUNCTION PER PAIR, WIDENED BY THE UNION OF THE MARGINS. A lesson
        can share a locked lesson's teacher and its pupils at once, and then two
        margins apply to the same window: the teacher's corridor and the
        pupils' changing. Both are intervals AROUND THE SAME LESSON BODY, so
        each side's requirement is nested inside the other's — avoiding the
        window for the wider of the two is avoiding it for both — and the widest
        margin on each side is the whole answer. Two separate disjunctions would
        cost two more booleans per pair to say it.
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
                        # AND THE PUPILS' OWN MARGIN, BUT ONLY WHERE THE LOCK
                        # REACHES THE PUPILS. A locked lesson that merely shares
                        # the teacher blocks nothing for the children — the class
                        # is not in it — so their changing time has no business
                        # widening that window, and widening it anyway would
                        # forbid the teacher the back-to-back the whole feature
                        # promises they may keep. Where the lock DOES hold the
                        # class (its own group, or one sharing its pupils), the
                        # children cannot be changing during it either: they
                        # would have to be in two places.
                        lead=decision.lead if shares_group else 0,
                        trail=decision.trail if shares_group else 0,
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
                        # NO margin on the room arm, and no pupil buffer either.
                        # The corridor is about a body walking between two
                        # places; a room needs no time to become itself again,
                        # and a school that wants the room to breathe declares a
                        # rast. Changing and showering are the same answer from
                        # the other side: they happen to the children, not to the
                        # hall, and the hall is free the moment they walk out of
                        # it. This mirrors the decision not to pad the room
                        # cumulative.
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
        lead: int = 0,
        trail: int = 0,
    ) -> None:
        """decision must end before, or start after, the [abs_start, abs_end) window.

        `margin` widens the window by the same corridor padded_of gives a
        generated pair — on BOTH sides, because the body moves in both
        directions: out of the room the fixed lesson is about to fill, and into
        it after the fixed lesson leaves. That is not the double-padding
        padded_of avoids; there the two lessons each carry their own margin, so
        padding both ends would count one corridor twice.

        `lead` and `trail` widen it ASYMMETRICALLY, by the minutes the pupils
        spend changing before this lesson and showering after it. Each lands on
        its own side and nowhere else: `trail` where the generated lesson ends
        before the locked window, `lead` where it starts after — which is the
        one place the two halves of the corridor argument above do not apply,
        because these minutes are not a distance to be walked once but time the
        class is unavailable at a particular end of its lesson.
        THEY ADD TO THE CORRIDOR RATHER THAN REPLACING IT, exactly as
        pupil_padded_of adds them to a generated pair: a class showers, changes
        and then walks. Only the caller knows whether a lock reaches the
        children at all, so it passes zero where it does not.
        """
        before = model.NewBoolVar(f"before_{tag}")
        after = model.NewBoolVar(f"after_{tag}")
        model.Add(decision.end + margin + trail <= abs_start).OnlyEnforceIf(before)
        model.Add(decision.end + margin + trail > abs_start).OnlyEnforceIf(before.Not())
        model.Add(decision.start >= abs_end + margin + lead).OnlyEnforceIf(after)
        model.Add(decision.start < abs_end + margin + lead).OnlyEnforceIf(after.Not())
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

        The rounding lives in _fixed_lesson_window, so _start_step reads the
        very window every builder blocks rather than a second copy of it.
        """
        return _fixed_lesson_window(fixed, self._grid)

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
        teacher_days: dict[tuple[UUID, int], _TeacherDay] | None = None,
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

        AND WHERE A HARD RULE HAS ALREADY BUILT THE DAY, THIS READS ITS PAIR.
        The teachers' rest rule needs the same two ends and needs them
        two-sided, so `teacher_days` carries a (teacher, day) it has already
        encoded and this method takes it rather than adding a second, weaker
        `first` and `last` beside it — which would be twice the literals for one
        fact, and two answers to "when did Anna's Tuesday begin". A pinned pair
        is what minimising `last - first` drives the one-sided pair to anyway,
        so the term's value is unchanged; what changes is that it costs nothing
        here. Teachers no work rule names keep the one-sided pair below, which
        is why the paragraph about it is still true and still the common case.

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
                tag = f"idle_{teacher_id}_{day_index}"
                built = (teacher_days or {}).get((teacher_id, day_index))
                if built is not None:
                    first, last, taught = built.first, built.last, built.taught
                else:
                    on_day: list[cp_model.IntVar] = []
                    for k, decision in enumerate(group):
                        literal = model.NewBoolVar(
                            f"idle_on_{teacher_id}_{day_index}_{decision.lesson.key()}",
                        )
                        model.Add(days[k] == day_index).OnlyEnforceIf(literal)
                        model.Add(days[k] != day_index).OnlyEnforceIf(literal.Not())
                        on_day.append(literal)

                    first = model.NewIntVar(base, base + slots_per_day, f"first_{tag}")
                    last = model.NewIntVar(base, base + slots_per_day, f"last_{tag}")
                    # ONE-SIDED ON PURPOSE. `first` is only bounded from above and
                    # `last` only from below, so nothing forces either to the true
                    # extreme — the OBJECTIVE does. Minimising `last - first` pushes
                    # first up to the earliest present start and last down to the
                    # latest present end, which is exactly the pair of equalities a
                    # two-sided encoding would cost twice as many constraints to
                    # state. A HARD rule cannot lean on that, which is why
                    # _TeacherDay is two-sided and why this branch is only for the
                    # teachers no work rule has already built a day for.
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
        """What is left of one lunch window on one day, in absolute slots.

        A domain, not a NoOverlap against constant intervals: one variable's
        domain is the strongest and cheapest form the fact has. Shared with
        _validate_request, which asks the same question and only wants to know
        whether the answer is empty — and with the TEACHERS' own break, which is
        a window, a length and a list of what is taken exactly as a class's is.
        Whose break it is changes what fills `forbidden`, and nothing here.
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
        *,
        step: int,
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
            lattice = _start_lattice(step, self._grid.horizon)

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
            # Both prefer the payload's `groups` to the decisions, which is the
            # whole of the fix for a class whose week is hand-placed: such a
            # class has no requirement left and so no decisions, and while
            # these came off the requirements it was invisible at lunch while
            # being plainly visible everywhere else. `by_group` is passed as
            # the reading for a payload that sends no `groups` AT ALL — not as
            # something unioned in on top of one that does.
            lunch_group_ids = _lunch_group_ids(groups, by_group)
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
                    # On the week's step, as every lesson start is. Both bounds
                    # and a pin are multiples of it (see _start_step), so the
                    # hull loses neither end.
                    lunch_start = model.NewIntVarFromDomain(
                        _on_lattice(cp_model.Domain(low, high), lattice),
                        f"lunchstart_{group_id}_{day_index}",
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
                    # THE PUPILS' OWN INTERVAL, like every other family whose
                    # members are the children: a class still in the changing
                    # room has not got its break, and a meal that starts while
                    # they are showering is a meal the model records and nobody
                    # eats. Twenty minutes of shower is worth more of a lunch
                    # break than a corridor ever was.
                    model.AddNoOverlap(
                        [pupil_padded_of(model, decision) for decision in lessons]
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
                            [
                                pupil_padded_of(model, decision)
                                for decision in by_group[other_id]
                            ]
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

    def _teacher_day_bounds(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        group: list[LessonDecision],
        day_index: int,
        day_vars: dict[str, cp_model.IntVar],
        cache: dict[tuple[UUID, int], _TeacherDay],
    ) -> _TeacherDay:
        """The two ends of one teacher's day, built once and handed out.

        Shared with _add_idle_time_objective through `cache`, which is why it is
        keyed on (teacher, day) and not on anything about the caller: the
        objective measures the same span this rule bounds, and two encodings of
        "when does Anna's Tuesday begin" would eventually disagree — and cost
        twice the literals while doing it.

        THE ABSENT LESSON IS GIVEN THE DAY'S OWN EDGE rather than left free.
        `AddMinEquality` needs a value from every lesson, including the ones on
        another day entirely, so each contributes its real start when it is here
        and the day's CLOSE when it is not — the identity for a minimum — and
        its real end or the day's OPEN for the maximum. Two IntVars per lesson
        and day, which is the price of a pair that means what its name says;
        the alternative, a literal per lesson saying "this one is the first",
        costs the same and propagates worse.
        """
        key = (teacher_id, day_index)
        existing = cache.get(key)
        if existing is not None:
            return existing

        slots_per_day = self._grid.slots_per_day
        base = day_index * slots_per_day
        tag = f"{teacher_id}_{day_index}"
        on_day: list[cp_model.IntVar] = []
        starts: list[cp_model.IntVar] = []
        ends: list[cp_model.IntVar] = []
        for decision in group:
            day_var = self._day_var(model, decision, day_vars)
            literal = model.NewBoolVar(f"tworks_{tag}_{decision.lesson.key()}")
            model.Add(day_var == day_index).OnlyEnforceIf(literal)
            model.Add(day_var != day_index).OnlyEnforceIf(literal.Not())
            on_day.append(literal)

            eff_start = model.NewIntVar(
                base, base + slots_per_day, f"tstart_{tag}_{decision.lesson.key()}",
            )
            model.Add(eff_start == decision.start).OnlyEnforceIf(literal)
            model.Add(eff_start == base + slots_per_day).OnlyEnforceIf(literal.Not())
            starts.append(eff_start)

            eff_end = model.NewIntVar(
                base, base + slots_per_day, f"tend_{tag}_{decision.lesson.key()}",
            )
            model.Add(eff_end == decision.end).OnlyEnforceIf(literal)
            model.Add(eff_end == base).OnlyEnforceIf(literal.Not())
            ends.append(eff_end)

        first = model.NewIntVar(base, base + slots_per_day, f"tfirst_{tag}")
        last = model.NewIntVar(base, base + slots_per_day, f"tlast_{tag}")
        model.AddMinEquality(first, starts)
        model.AddMaxEquality(last, ends)
        # A maximum over booleans is their disjunction, and one constraint says
        # it: `works` is true exactly when some lesson of this teacher is here.
        works = model.NewBoolVar(f"tday_{tag}")
        model.AddMaxEquality(works, on_day)

        built = _TeacherDay(
            first=first,
            last=last,
            works=works,
            on_day=tuple(on_day),
            taught=sum(
                decision.duration * literal
                for decision, literal in zip(group, on_day)
            ),
        )
        cache[key] = built
        return built

    def _add_teacher_work_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        work_rules: list[AnonymousTeacherWorkRule],
        fixed_lessons: list[FixedLesson],
        constraints: list[AnonymousConstraint],
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        *,
        step: int,
    ) -> None:
        """The two hours a teacher is owed: a lunch every day, a night's rest.

        THE FIRST RULE IN THIS MODEL WRITTEN FOR THE ADULTS. The lunch beside it
        is the PUPILS' — a window per class, a rast per stage — and the only
        per-teacher row that existed was an UNAVAILABLE reservation, which is a
        teacher CLOSING hours rather than being owed any. A teacher had no lunch
        anywhere in the model, and the idle-time objective is an objective: it
        prefers a compact day and will sell any hour of it for a placement.

        EMPTY IS NOT A DEFAULT. A rule naming no lunch and no rest constrains
        nothing, and a teacher no rule names is not reached at all, so a school
        that has filled in nobody is refused nothing. That is the user's own
        decision and it is also what lets the engine ship before the gateway
        that fills the list.

        A TEACHER WITH NO LESSON LEFT TO PLACE IS SKIPPED, and the line is
        deliberate. Both rules constrain where the SOLVER may put a lesson; a
        teacher whose whole week is hand-placed has no variable for either rule
        to bound, and refusing that week would be refusing the school's own
        arrangement in the name of a rule that could not have changed it. Their
        locked lessons are still read, everywhere a teacher who does have
        lessons meets them.

        padded_of AND NOT pupil_padded_of, which is _add_teacher_no_overlap's
        decision and its reason: the minutes around an idrottslektion are the
        PUPILS' — changing and showering — and the teacher spends none of them
        undressed. A lunch that read the pupils' interval would forbid what a
        school does on purpose, idrottsläraren eating while the class showers.

        TWO ROWS FOR ONE TEACHER ARE BUILT AS TWO, and the table's own unique
        index on the teacher is what makes that unreachable. Read literally, two
        rows are two breaks and two rests, which is what this builds; a silent
        "the first one wins" would be the engine quietly deciding which half of a
        payload it disagrees with, and that is worse than a week that is harder
        than anybody asked for.
        """
        if not work_rules:
            return

        by_teacher: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            for teacher_id in _teachers_of(decision.lesson.requirement):
                by_teacher.setdefault(teacher_id, []).append(decision)

        locked_busy = self._teacher_busy_from_locks(fixed_lessons)
        closed_busy = self._teacher_busy_from_constraints(constraints)
        lattice = _start_lattice(step, self._grid.horizon)

        for rule in work_rules:
            group = by_teacher.get(rule.teacher_id)
            if not group:
                continue
            window = _teacher_lunch_slots(rule, self._grid)
            if window is not None:
                self._add_teacher_lunch(
                    model,
                    registry,
                    rule,
                    group,
                    window,
                    locked_busy,
                    closed_busy,
                    lattice,
                )
            if rule.min_daily_rest_minutes is not None:
                self._add_teacher_rest(
                    model,
                    registry,
                    rule,
                    group,
                    locked_busy,
                    day_vars,
                    teacher_days,
                )

    def _add_teacher_lunch(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        rule: AnonymousTeacherWorkRule,
        group: list[LessonDecision],
        window: tuple[int, int, int],
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        closed_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        lattice: cp_model.Domain | None,
    ) -> None:
        """One movable break per day, kept clear of everything the teacher does.

        THE SAME SHAPE THE GROUP LUNCH SETTLED ON, and for the same measured
        reason: "there is a contiguous free window of `lunch_slots` inside the
        window" is exactly "a task of that length can be placed among these
        lessons", and one movable interval per (teacher, day) hands that to the
        disjunctive propagator instead of an existential over every candidate
        start. One IntVar per teacher and day, against three booleans per
        candidate and lesson.

        NO `len(group) < 2` SKIP, which _add_idle_time_objective does make: idle
        time needs two lessons to exist between, and a lunch does not. A teacher
        with one four-hour lesson across the whole window is exactly the teacher
        this rule is for.

        THE INTERVAL IS OPTIONAL AND ITS PRESENCE IS THE ASSUMPTION. A mandatory
        interval in a NoOverlap takes no OnlyEnforceIf, so a week made
        impossible by the break alone would be proved impossible without
        touching a single assumption literal —
        SufficientAssumptionsForInfeasibility then returns an EMPTY core, which
        does not merely lose this cause but erases every other cause in the
        payload and hands the school the INSUFFICIENT_RESOURCES fallback,
        telling it to go and look at rooms and teacher time. Presence on a
        literal is the same trick the dining hall's seats use, for the same
        reason. In the fast build the literal is pinned by AddBoolAnd and
        presolve folds the optionality away, so the encoding is unchanged there.

        PER TEACHER AND DAY, like the group lunch's own literals and unlike the
        one literal per teacher this could have been. Two reasons, and the
        second is the load-bearing one. "Anna's Tuesday" is the whole content of
        the answer, as "7A on Tuesday" is next door. And the reading order in
        _how_far_it_narrows puts a line naming neither a day nor a resource
        last, as a line about the whole week — which a teacher's own rule is
        not; it cannot name a resource, because the only id it could put there
        is the teacher's and the gateway discards that map on purpose, so the
        DAY is the only thing that can lift this sentence out of the cellar.

        ONE LITERAL FOR BOTH SUBTRACTIONS, where the group lunch uses two. It
        can afford two because it has two sentences to say, one about a lesson
        to move and one about a reservation to change. This rule has one, and a
        second literal carrying the same code and the same values would be
        merged back into a single line by build_conflict_analysis — a variable
        for nothing. Which of the two it was is in the pre-flight refusal, which
        has the `causes` the day needs.
        """
        window_start, window_end, lunch_slots = window
        breaks: list[cp_model.IntervalVar] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            day_offset = day_index * self._grid.slots_per_day
            key = (rule.teacher_id, day_index)
            closed = closed_busy.get(key, [])
            # The school has closed the whole window for this teacher: they are
            # not here, and a break they were never owed must not refuse the
            # week. The same reading _lunch_starts_blocked_by_constraints makes
            # of a class whose Tuesday is reserved end to end.
            if _covers(closed, day_offset + window_start, day_offset + window_end):
                continue

            lunch_start = model.NewIntVarFromDomain(
                _on_lattice(
                    cp_model.Domain(
                        day_offset + window_start,
                        day_offset + window_end - lunch_slots,
                    ),
                    lattice,
                ),
                f"teacherlunch_{rule.teacher_id}_{day_index}",
            )
            literal = registry.register(
                model,
                name=f"teacherlunchstart_{rule.teacher_id}_{day_index}",
                category="LUNCH_WINDOW",
                code="TEACHER_LUNCH_HAS_NOWHERE_TO_GO",
                params={
                    "rule": str(rule.id),
                    "minutes": rule.lunch_minutes,
                    "windowStart": rule.lunch_start_time[:5],
                    "windowEnd": rule.lunch_end_time[:5],
                    "day": day_of_week,
                },
                # THE RULE'S ID AND NEVER THE TEACHER'S. The gateway keeps a map
                # for the rule and reverses it here as well as in the sentence,
                # so this is a row an administrator can open; the teacher map is
                # discarded by design, so a teacher id put here would reach the
                # school as a uuid in no table, and no name would ever fill the
                # slot beside it. It also lifts this line to the top of the
                # reading order in _how_far_it_narrows, which ranks a cause
                # naming both a day and a something above one naming neither —
                # and a teacher's own rule on a known day is the most checkable
                # thing in the whole report.
                resource_ids=[rule.id],
            )
            forbidden = _forbidden_lunch_starts(
                locked_busy.get(key, []) + closed,
                day_offset + window_start,
                day_offset + window_end - lunch_slots,
                lunch_slots,
            )
            if forbidden:
                # UNDER THE LITERAL, never bare, for the reason the group
                # lunch's own subtraction gives: a bare domain narrowing lets
                # CP-SAT prove a week impossible without touching an assumption,
                # and the empty core that follows takes every other cause in the
                # payload down with it.
                #
                # Through the class lunch's own helper, which asks exactly this
                # question of exactly this shape — the window less what is taken,
                # in absolute slots — so a teacher's break and a class's are
                # subtracted by one rule and not by two that could disagree.
                model.AddLinearExpressionInDomain(
                    lunch_start,
                    self._admissible_lunch_starts(
                        day_offset, window_start, window_end, lunch_slots, forbidden,
                    ),
                ).OnlyEnforceIf(literal)
            breaks.append(
                model.NewOptionalFixedSizeIntervalVar(
                    lunch_start,
                    lunch_slots,
                    literal,
                    f"teacherbreak_{rule.teacher_id}_{day_index}",
                ),
            )
        if breaks:
            # ONE NoOverlap FOR THE WEEK, as the group lunch builds one per
            # class: every break's start is confined to its own day and ends
            # inside the window, so two of them provably cannot overlap, and one
            # constraint per day would only cost five times as much to say the
            # same thing about the same lessons.
            model.AddNoOverlap(
                [padded_of(model, decision) for decision in group] + breaks,
            )

    def _add_teacher_rest(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        rule: AnonymousTeacherWorkRule,
        group: list[LessonDecision],
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
    ) -> None:
        """Hours between the end of one teaching day and the start of the next.

        ONE INEQUALITY PER PAIR OF CONSECUTIVE DAYS: `last(d) + rest <=
        first(d+1) + pad`, where pad is the closed part of the night the grid
        itself leaves (see _night_pad_slots — absolute slots count only the
        hours the school teaches in, so the night has to be added back).

        ENFORCED ONLY WHERE BOTH DAYS HOLD A LESSON. A day nobody works must not
        refuse the week: without the guard a teacher with a free Wednesday would
        be asked to rest between two days they did not work, and `first` and
        `last` on an empty day are the day's own edges rather than any lesson's.
        The guard is a variable and not an assumption, so relaxing the rule
        cannot accidentally decide which days the teacher works.

        THE TEACHER'S LOCKED LESSONS ARE FOLDED IN AS CONSTANTS, and leaving
        them out was the one way this rule could have been quietly optional. A
        locked lesson is real teaching — _add_fixed_lesson_constraints makes it
        a hard blocker for the same teacher — and a school whose Monday evening
        is hand-placed would otherwise have its Tuesday morning placed freely
        against a rest rule that could not see the evening at all. Folding costs
        two IntVars on a day that has one, no new literal, and it also closes
        the case where BOTH ends are locked: the day is then certainly worked,
        so its `works` guard is dropped and the inequality is left to compare
        two constants — which is a refusal the literal can name, rather than one
        nothing in the model would have made.

        A WEEK THE GRID CANNOT BREAK. With the engine's own 08:00-18:00 day the
        closed night is fourteen hours, so eleven hours of rest can never bind:
        the rule bites exactly where a school's configured day runs longer than
        the night the rest asks for, which is why 660 minutes is a safe
        suggestion for a grundskola and a real constraint for a school teaching
        into the evening. Stated here because a rule that holds vacuously is
        worth knowing about before somebody measures its cost and finds none.

        A WEEK OF ONE DAY HAS NO PAIR OF CONSECUTIVE DAYS, and nothing is built
        for it — not the inequality, and not the day it would compare either,
        which is several variables per lesson bought to be measured against
        nothing.
        """
        if len(self._grid.schedule_days) < 2:
            return
        rest_slots = -(-rule.min_daily_rest_minutes // self._grid.slot_minutes)
        bounds = [
            self._teacher_day_bounds(
                model, rule.teacher_id, group, day_index, day_vars, teacher_days,
            )
            for day_index in range(len(self._grid.schedule_days))
        ]
        for day_index, day_of_week in enumerate(self._grid.schedule_days[:-1]):
            literal = registry.register(
                model,
                name=f"teacherrest_{rule.teacher_id}_{day_index}",
                category="TEACHER_OVERLAP",
                code="TEACHER_REST_CANNOT_BE_KEPT",
                params={
                    "rule": str(rule.id),
                    "restMinutes": rule.min_daily_rest_minutes,
                    "day": day_of_week,
                },
                # The rule and never the teacher — see the lunch literal above.
                resource_ids=[rule.id],
            )
            enforce = [literal]
            ends = self._teacher_locked_edge(
                model, rule.teacher_id, day_index, bounds[day_index], locked_busy,
                latest=True,
            )
            if ends is None:
                ends = bounds[day_index].last
                enforce.append(bounds[day_index].works)
            starts = self._teacher_locked_edge(
                model, rule.teacher_id, day_index + 1, bounds[day_index + 1],
                locked_busy, latest=False,
            )
            if starts is None:
                starts = bounds[day_index + 1].first
                enforce.append(bounds[day_index + 1].works)
            model.Add(
                ends + rest_slots <= starts + _night_pad_slots(self._grid, day_index),
            ).OnlyEnforceIf(enforce)

    def _teacher_locked_edge(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        day_index: int,
        bounds: _TeacherDay,
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        *,
        latest: bool,
    ) -> cp_model.IntVar | None:
        """One end of a day that also holds locked lessons, or None if it has none.

        The generated end folded with the hand-placed one: the latest end of the
        two, or the earliest start. None where the teacher has no locked lesson
        that day, which is the ordinary case and pays nothing — the caller then
        uses the day's own end and guards it with `works`, since a day with
        nothing locked may hold no lesson at all.
        """
        windows = locked_busy.get((teacher_id, day_index))
        if not windows:
            return None
        slots_per_day = self._grid.slots_per_day
        base = day_index * slots_per_day
        folded = model.NewIntVar(
            base,
            base + slots_per_day,
            f"tlocked{'end' if latest else 'start'}_{teacher_id}_{day_index}",
        )
        if latest:
            model.AddMaxEquality(
                folded, [bounds.last, max(end for _start, end in windows)],
            )
        else:
            model.AddMinEquality(
                folded, [bounds.first, min(start for start, _end in windows)],
            )
        return folded

    def _teacher_busy_from_locks(
        self, fixed_lessons: list[FixedLesson],
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """(teacher, day index) -> the absolute windows a hand-placed lesson takes.

        The reach _add_fixed_lesson_constraints uses, which is the lesson's own
        teacher and its co-teacher: a lesson two adults give occupies both of
        them, and a rule that read the lead alone would let every co-taught
        school out of both halves of this feature.

        The window is _fixed_lesson_window's, rounded outward and clipped to the
        day, so a lunch subtracted from it and a lesson blocked by it agree to
        the slot.
        """
        busy: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                continue
            day_index = window[0] // self._grid.slots_per_day
            for teacher_id in (fixed.teacher_id, fixed.co_teacher_id):
                if teacher_id is not None:
                    busy.setdefault((teacher_id, day_index), []).append(window)
        return busy

    def _teacher_busy_from_constraints(
        self, constraints: list[AnonymousConstraint],
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """(teacher, day index) -> the absolute windows the school has closed.

        TEACHER rows only, and weekly ones only, matching
        _add_availability_constraints: the model is one generic week and has
        nowhere to put a single date. A dated absence is already a soft penalty
        over there and must not become a hard hole in a break somebody is owed.

        NOT the other kinds. A room being closed says nothing about where a
        teacher eats, and a class's reservation is the class's own time — the
        teacher is very often the person the class was reserved FOR.

        These windows are read by the lunch and NOT by the rest, and the
        asymmetry is the point: a reservation is time the teacher is NOT
        teaching, so it can take a lunch start away, and it can never be the
        late lesson that shortens a night.
        """
        busy: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.resource_kind != "TEACHER" or constraint.resource_id is None:
                continue
            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week, constraint.start_time, constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from, which leaves a school to find which reservation that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc
            for abs_start, abs_end in windows:
                day_index = abs_start // self._grid.slots_per_day
                busy.setdefault(
                    (constraint.resource_id, day_index), [],
                ).append((abs_start, abs_end))
        return busy

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


def _fixed_lesson_window(fixed: FixedLesson, grid: TimeGrid) -> tuple[int, int] | None:
    """Absolute slot window blocked by a fixed lesson, rounded outward.

    Locked lessons are hand-placed and need not align to the slot grid;
    the blocked window is expanded to whole slots so blocking stays
    conservative. Returns None when the lesson lies outside the grid.
    """
    if fixed.day_of_week not in grid.schedule_days:
        return None

    start_minutes = _hhmmss_to_minutes(fixed.start_time)
    end_minutes = _hhmmss_to_minutes(fixed.end_time)
    start_minutes = max(start_minutes, grid.day_start_minutes)
    end_minutes = min(end_minutes, grid.day_end_minutes)
    if end_minutes <= start_minutes:
        return None

    slot = grid.slot_minutes
    start_slot = (start_minutes - grid.day_start_minutes) // slot
    end_slot = -(-(end_minutes - grid.day_start_minutes) // slot)  # ceil

    day_offset = grid.day_index(fixed.day_of_week) * grid.slots_per_day
    return day_offset + start_slot, day_offset + end_slot


def _start_step(request: OptimizeScheduleRequest, grid: TimeGrid) -> int:
    """How many slots apart this week's lesson and lunch starts may be.

    THE GRID STAYS; ONLY THE STARTS STEP. Every length, rounding, refusal,
    weight and output is still counted on `grid`, and a school whose time is
    off the five-minute grid is still told so in those words. What the step
    changes is which values a lesson's start and a lunch's start may take:
    the multiples of it, as holes in their domains. The nightly 400-student
    gate writes every time on the half hour, so its lessons get 95 starts each
    instead of 545, over the same variables and constraints.

    THE STEP IS THE GCD OF EVERY CONSTANT A START IS COMPARED WITH, after the
    model's own rounding: the day's length; each lesson's length and the
    meal's; each teacher's own lunch window, that break's length rounded up,
    the rest they are owed rounded up and the night the grid leaves between two
    days; each requirement's two pupil buffers, rounded up; the lunch window;
    each frame's open and close, rounded both ways, and its changeover, rounded
    up; each rast rounded outward and each sitting inward; every availability
    row of every kind, dated or not, folded onto the grid; each locked lesson's
    outward window within its day; each hand-placed meal; each previous lesson
    the disruption term can read.

    A FRAME IS READ OUTWARD TOO, AND NEED NOT BE. frames.day_windows is the
    only reader of a frame's times, and it rounds inward: the open up, the
    close down. The open rounded down and the close rounded up are compared
    with nothing, and the argument below does without them. They stay as
    caution: a frame on the grid reads the same both ways and costs nothing,
    one off it costs the coarser step it could have had (08:07 gives five
    minutes where ten would do), and a later reader rounding a frame outward
    is already covered. Dropping them is a choice, and a row in
    tests/test_start_step.py says so.

    NO WEEK IS LOST. Let every one of those constants be a multiple of g, and
    take any timetable the model accepts without the step. Round every start
    DOWN to a multiple of g. Every rule still holds:

      - a start bounded by a constant, a start barred from a hole whose edges
        are constants, an end bounded by a constant (the same bound less a
        length): rounding down never crosses a multiple;
      - no-overlap: a ending before b starts is a + len_a <= b, and then
        floor(a) + len_a = floor(a + len_a) <= floor(b). So every NoOverlap
        holds, and every cumulative — rooms, seats — too: rounding can part
        two intervals and never join them, and intervals that pairwise meet
        share an instant, so no instant carries more than it did;
      - a teacher's rest, `last(d) + rest <= first(d+1) + pad`, is that same
        sentence with a constant added to each side: `last` is a start plus a
        length and `first` is a start, so from `a + c <= b + c'` with c and c'
        multiples of g it follows that floor(a) + c <= floor(b) + c'. Both
        constants are in the gcd for exactly this step, `pad` included;
      - the day a start falls on, `start // slots_per_day`, does not move;
      - a pinned meal is a multiple already and stays where it was;
      - the rast rule's "taught before" flags are bounds as above, and its
        "still at school" test, `start >= base + last`, answers the same
        before and after.

    So a timetable exists on the step exactly when one exists at all.
    FEASIBLE, INFEASIBLE, a conflict core and the lunch stage's refusal mean on
    the stepped model what they meant without it.

    NO OPTIMUM IS LOST EITHER, where a step is allowed. Round every start to
    g * floor((start + t) / g) instead, for a shift t in 0..g-1. Each shift
    keeps every rule above that is not strict, and averaged over the shifts
    every start stays exactly where it was. So every term linear in the starts
    keeps its average, and so does a lunch's drift, the size of a difference
    whose sign no common rounding flips. A teacher's idle time — span less
    taught and protected minutes, floored at zero — keeps it too, because its
    rounded values are two neighbouring multiples of g and never straddle
    zero. A PREFERRED_FREE or dated overlap can only shrink on average, and
    the disruption reward reads a multiple and keeps its value. Some shift
    then costs no more than the timetable it came from. Two sentences break
    that average, and the answer for them is a step of 1 rather than an
    OPTIMAL that is not one:

      - A PREFERRED_BUSY row pays when a lesson does NOT overlap it. A lesson
        straddling two adjacent busy half hours overlaps both, and only off
        the multiples can it straddle: tests/test_start_step.py builds that
        week, 0 without the step and 5 with it.
      - The rast rule's "gone home" side is strict, and a lesson its own rasts
        do not keep out of an asking break can be rounded up into lateness.
        See _rast_rule_reads_held_lessons.

    ANY NEW RULE THAT COMPARES A START WITH A CONSTANT MUST FEED THIS FUNCTION,
    and any new objective term must keep the average above or make the step 1.
    Nothing checks either at build time. A constant left out is a start the
    model can no longer reach, and the week that needed it is refused, or
    reported worse than it is, without a word — the drift solver-grid.ts risks
    for the gateway. tests/test_start_step.py holds one case per source and
    compares verdicts and optima with the step and without it.

    ONE ODD TIME ANYWHERE brings the whole school to a step of 1, as a lesson
    locked at 08:05 does, and it is then searched exactly as it was before the
    step existed: slower, never wrong. A step per connected part of the school
    is not worth its code, because the room pool joins nearly everything.

    UNREADABLE IS 1. A time or a length the grid cannot read is refused by name
    in _validate_request before any model is built, and a guess would buy
    nothing. A previous lesson the disruption term skips is skipped here too.

    Holes in the domains, not start = g * k over a narrower variable: that
    might propagate better, and has not been tried.
    """
    if any(constraint.kind == "PREFERRED_BUSY" for constraint in request.constraints):
        return 1
    if not _rast_rule_reads_held_lessons(request, grid):
        return 1

    slots_per_day = grid.slots_per_day

    def folded(value: str, *, upward: bool) -> int:
        # The rounding frames.py, rasts.py and servings.py apply to their own
        # rows, clipped to the day as each of them clips.
        offset = _clock_minutes(value) - grid.day_start_minutes
        slots = -(-offset // grid.slot_minutes) if upward else offset // grid.slot_minutes
        return min(max(slots, 0), slots_per_day)

    values = [slots_per_day]
    try:
        values.extend(
            grid.minutes_to_slots(minutes)
            for requirement in request.requirements
            for minutes in set(requirement.lesson_minutes())
        )
        rules = request.rules
        if rules is not None and _lunch_window_is_set(rules):
            # The three readings _lunch_window_slots makes, through the same
            # grid calls. Its refusals are _validate_request's to make.
            values.extend((
                grid.parse_hhmmss(rules.lunch_start_time),
                grid.parse_hhmmss(rules.lunch_end_time),
                grid.minutes_to_slots(rules.lunch_minutes),
            ))
        for constraint in request.constraints:
            for value in (constraint.start_time, constraint.end_time):
                slot = grid.clamp_to_grid(value)
                if slot is not None:
                    values.append(slot)
        values.extend(
            grid.parse_hhmmss(placement.start_time)
            for placement in request.lunch_placements
        )
    except ValueError:
        return 1

    for requirement in request.requirements:
        # The pupils' changing time, rounded up as _create_lesson_decisions
        # rounds it. Both bound a start — the lead from below, since the domain's
        # first slot of the day rises by it, and the trail from above through the
        # day's clipped close — and a buffer left out of this gcd is a week
        # refused for want of a start the school could have had. Zero feeds
        # nothing: gcd(0, n) is n, which is why the overwhelming majority of
        # requirements, carrying no buffer at all, cost no step here.
        values.extend((
            -(-requirement.minutes_before // grid.slot_minutes),
            -(-requirement.minutes_after // grid.slot_minutes),
        ))
    # The teachers' own lunch and rest. The window's two ends and the break's
    # length bound a lunch start exactly as the school's own three do, through
    # the same helper the builder reads them with — and the REST feeds two
    # constants, not one. It is compared with a start as `last(d) + rest <=
    # first(d+1) + pad`, and `pad` is a constant of the grid rather than of any
    # row: without it in the gcd a week whose starts step by 25 minutes would
    # have the inequality shifted by a number no multiple of 25 can reach, and
    # the rounding-down argument above — which needs both added constants to be
    # multiples of the step — would no longer hold. See _night_pad_slots.
    for rule in request.teacher_work_rules:
        window = _teacher_lunch_slots(rule, grid)
        if window is not None:
            values.extend(window)
        if rule.min_daily_rest_minutes is not None:
            values.append(-(-rule.min_daily_rest_minutes // grid.slot_minutes))
            values.extend(
                _night_pad_slots(grid, day_index)
                for day_index in range(len(grid.schedule_days) - 1)
            )
    for frame in request.frame_times:
        for value in (frame.start_time, frame.end_time):
            values.extend((folded(value, upward=False), folded(value, upward=True)))
        values.append(-(-frame.changeover_minutes // grid.slot_minutes))
    for rast in request.rasts:
        values.extend((
            folded(rast.start_time, upward=False), folded(rast.end_time, upward=True),
        ))
    for serving in request.lunch_servings:
        values.extend((
            folded(serving.start_time, upward=True), folded(serving.end_time, upward=False),
        ))
    for fixed in request.fixed_lessons:
        window = _fixed_lesson_window(fixed, grid)
        if window is not None:
            day_offset = window[0] // slots_per_day * slots_per_day
            values.extend((window[0] - day_offset, window[1] - day_offset))
    for previous in request.previous_lessons:
        try:
            values.append(grid.parse_hhmmss(previous.start_time))
        except ValueError:
            continue
    return max(math.gcd(*values), 1)


def _rast_rule_reads_held_lessons(request: OptimizeScheduleRequest, grid: TimeGrid) -> bool:
    """Whether every lesson an asking rast reads is kept out of that break.

    THE ONE STRICT COMPARISON IN THE MODEL. A class is still at school after
    an asking break when one of its lessons starts at or after the break's end.
    A lesson starting inside the break's last step is not, and rounded UP to
    the next multiple it is — so _start_step's optimum argument, which rounds
    some starts up, needs no lesson ever to start there. A lesson its own rasts
    keep out of the break never can: its domain has a hole from the break's
    first slot less its length to the break's last slot, and its length is at
    least the step.

    The lesson that is not kept out is a teaching group whose years the gateway
    could not derive: its class's rule reads it through the shared pupils, and
    no rast reaches the group itself. tests/test_start_step.py builds that
    week, and its verdict is the same either way while its optimum is not.

    The reach _add_rast_ordering_constraints uses — the class's own years for
    the break, each requirement's own years for its holes, the groups sharing
    pupils for its lessons — and cautious where that method skips: a day a
    frame closes, or a stretch no lesson fits, is still asked about.
    """
    if not request.groups or not any(rast.requires_lesson_before for rast in request.rasts):
        return True
    sharing = _groups_sharing_students(request.group_conflicts)
    spans_of: dict[UUID, set[tuple[int, int] | None]] = defaultdict(set)
    for requirement in request.requirements:
        spans_of[requirement.student_group_id].add(span_of(requirement))
    holes: dict[tuple[tuple[int, int] | None, int], list[tuple[int, int]]] = {}
    for group in request.groups:
        if group.min_grade_level is None or group.max_grade_level is None:
            continue
        span = (group.min_grade_level, group.max_grade_level)
        lesson_spans = {
            lesson_span
            for member in (group.id, *sharing.get(group.id, ()))
            for lesson_span in spans_of.get(member, ())
        }
        for day_of_week in grid.schedule_days:
            for _first, last, asks in blocks_with_demand(request.rasts, span, day_of_week, grid):
                if not asks:
                    continue
                for lesson_span in lesson_spans:
                    key = (lesson_span, day_of_week)
                    if key not in holes:
                        holes[key] = blocks_for(request.rasts, lesson_span, day_of_week, grid)
                    if not any(start < last <= end for start, end in holes[key]):
                        return False
    return True


def _start_lattice(step: int, horizon: int) -> cp_model.Domain | None:
    """Every multiple of the step across the week, or None at a step of 1.

    None rather than [0, horizon], so a week whose step is 1 builds exactly
    the model it built before steps existed.
    """
    if step <= 1:
        return None
    return cp_model.Domain.FromValues(list(range(0, horizon + 1, step)))


def _on_lattice(domain: cp_model.Domain, lattice: cp_model.Domain | None) -> cp_model.Domain:
    """The domain's values on the step; the domain itself at a step of 1."""
    return domain if lattice is None else domain.intersection_with(lattice)


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


def _teacher_lunch_slots(
    rule: AnonymousTeacherWorkRule, grid: TimeGrid,
) -> tuple[int, int, int] | None:
    """One teacher's lunch window and the break's length, in a day's own slots.

    ONE ROUNDING RULE READ FROM THREE PLACES — the refusal in
    _validate_request, the builder, and _start_step's gcd — for the reason
    _lunch_window_slots gives about the school's own lunch: two copies of
    "which slot is 10:30" would eventually disagree about a teacher's break,
    and the copy that rounded outward would empty a variable's domain and reach
    the school as CP-SAT's own `var #0 has no domain()`, which is a 500 with
    nothing in it to act on.

    INWARD, LIKE A SITTING AND UNLIKE A RAST. The window is a PERMISSION the
    break has to sit inside, so its open rounds UP and its close rounds DOWN: a
    window of 10:32-13:28 on a five-minute grid offers 10:35-13:25, where
    rounding outward would let a lunch begin two minutes before the school said
    it may. The LENGTH rounds up, the one direction that cannot shorten a break
    somebody is owed — a 20-minute lunch on a 15-minute grid takes 30, which
    protects the teacher rather than the search.

    CLIPPED TO THE SCHOOL DAY, and never refused merely for reaching past it. A
    school whose day ends at 13:00 and whose teachers may eat until 13:30 has
    said two things, and the narrower one wins — exactly as a frame and a
    sitting compose. A window entirely outside the day clips to nothing, and
    nothing is too narrow to hold a lunch, which is refused by name with the
    width it really offers quoted in the sentence.

    None when the rule asks for no lunch at all. The trio is validated by the
    schema, so one field present means all three are.
    """
    if not rule.has_lunch:
        return None
    assert rule.lunch_start_time is not None
    assert rule.lunch_end_time is not None
    assert rule.lunch_minutes is not None

    def folded(value: str, *, upward: bool) -> int:
        offset = _clock_minutes(value) - grid.day_start_minutes
        slots = -(-offset // grid.slot_minutes) if upward else offset // grid.slot_minutes
        return min(max(slots, 0), grid.slots_per_day)

    return (
        folded(rule.lunch_start_time, upward=True),
        folded(rule.lunch_end_time, upward=False),
        -(-rule.lunch_minutes // grid.slot_minutes),
    )


def _covers(ranges: list[tuple[int, int]], start: int, end: int) -> bool:
    """Whether [start, end) is entirely inside the union of `ranges`.

    Used to read a reservation that covers a whole lunch window as the school
    saying the teacher is not there that day — the same reading
    _lunch_starts_blocked_by_constraints makes of a class's reserved Tuesday,
    and for the same reason: answering a correct statement with a refusal
    nobody can act on is worse than granting no break at all. Merged first, so
    two rows that between them cover the window are read as covering it.
    """
    cursor = start
    for low, high in _merge_ranges(list(ranges)):
        if low > cursor:
            return False
        cursor = max(cursor, high)
        if cursor >= end:
            return True
    return cursor >= end


def _forbidden_lunch_starts(
    busy: list[tuple[int, int]],
    earliest: int,
    latest: int,
    lunch_slots: int,
) -> list[tuple[int, int]]:
    """Lunch starts in [earliest, latest] that a busy window rules out.

    The arithmetic _lunch_starts_blocked_by_fixed_lessons states for a class: a
    break of `lunch_slots` starting at s clashes with a busy window [a, b)
    exactly for s in [a - lunch_slots + 1, b - 1]. Everything here is a
    constant, so the answer is a domain to subtract rather than a propagator —
    no boolean, no interval, and quiet about two busy windows that overlap each
    other, which is the school's own data and not a reason to refuse a week.

    Absolute slots throughout, and windows that rule out no admissible start at
    all are dropped rather than carried down to subtract nothing.
    """
    forbidden: list[tuple[int, int]] = []
    for start, end in busy:
        first_bad = start - lunch_slots + 1
        last_bad = end - 1
        if last_bad < earliest or first_bad > latest:
            continue
        forbidden.append((max(first_bad, earliest), min(last_bad, latest)))
    return forbidden


def _night_pad_slots(grid: TimeGrid, day_index: int) -> int:
    """Slots to add to a start on day_index + 1 to compare it with day_index's end.

    THE NIGHT IS NOT THE GRID. A start is an absolute slot and the grid
    addresses day d as [d * slots_per_day, (d+1) * slots_per_day), so the
    distance between two absolute slots on consecutive days counts only the
    hours the school teaches in — 08:00 Tuesday is 120 slots after 08:00 Monday
    on a ten-hour day, when the clock says 288. The difference, `slots in the
    calendar days crossed` less `slots_per_day`, is exactly the closed part of
    the night, and adding it to tomorrow's start turns a comparison of absolute
    slots into a comparison of real elapsed time.

    IT READS THE WEEKDAYS AND NOT THE INDICES, because SCHEDULE_DAYS need not
    be contiguous: a school that teaches Monday, Wednesday and Friday has two
    nights between index 0 and index 1, and a rest rule that counted one would
    refuse a week for want of hours the teacher slept through.

    1440 // slot_minutes is a whole number for every legal slot length — the
    settings validator requires one that divides 60.
    """
    days_apart = grid.schedule_days[day_index + 1] - grid.schedule_days[day_index]
    return days_apart * (1440 // grid.slot_minutes) - grid.slots_per_day


def _teachers_of(requirement: AnonymousRequirement) -> tuple[UUID, ...]:
    """Everyone who teaches this requirement: the lead and the co-teacher.

    Its own reader because every teacher-keyed rule in this module has to make
    the same union, and a rule that read `teacher_id` alone would let a
    co-taught school out of it: a co-taught lesson is teaching for both of
    them, and both are owed the lunch and the rest it takes away.
    """
    return tuple(
        teacher_id
        for teacher_id in (requirement.teacher_id, requirement.co_teacher_id)
        if teacher_id is not None
    )


def _group_ids_with_lessons(
    requirements: list[AnonymousRequirement],
) -> Iterable[UUID]:
    """Every group the timplan gives a lesson to, in the payload's own order.

    One reader, so the callers of `_lunch_group_ids` that hold a request — the
    timeout diagnosis among them — cannot drift from each other about what
    "has lessons" means. The builder holds decisions rather than requirements
    and passes its own `by_group`, which is the same list: decisions are
    created requirement by requirement, and every requirement carries
    lessons_per_week >= 1.
    """
    return (requirement.student_group_id for requirement in requirements)


def _lunch_group_ids(
    groups: list[AnonymousGroup],
    with_lessons: Iterable[UUID],
) -> list[UUID]:
    """Every group the solver owes a lunch break, in a stable order.

    THE PAYLOAD'S `groups` WHEN IT HAS ANY, and the groups with lessons when
    it has none. The gateway decides who eats: it sends the HOME CLASSES, with
    their headcounts and their years, and a teaching group is not among them
    because its pupils already eat with their class. Reading anything else
    alongside a `groups` that is really there has a cost: a mandatory
    thirty-minute reservation on every teaching group's day for a meal nobody
    takes there, and an INFEASIBLE with a lunch cause on the day it did not
    fit. A class's meal is still kept clear of its teaching groups' lessons,
    through the shared-pupil pairs.

    AN ABSENT `groups` IS NOT AN EMPTY DINING ROOM. The field is optional so
    the engine can ship before the gateway that fills it, and the schema says
    what the engine owes until then: the free-window guarantee still reaches
    every group with requirements, and the hall simply hears about nobody.
    Read as "the payload's groups, full stop", an absent list withdrew the
    guarantee from the whole school in silence — every class taught edge to
    edge through 11:00-13:00, no lunch in the response, and an OPTIMAL over
    the top of it. That is what the benchmark validator caught: for its school
    the model built not one lunch interval, and the school had asked for
    lunch. A school that names nobody still gets its break; the hall is what
    goes unmodelled, and it does, because every headcount is then 0.

    `with_lessons` is required, not defaulted, for the reason
    _add_rules_constraints requires `groups`: a caller that forgets it would
    silently build the model with no lunch in it at all, which is precisely
    the bug this parameter exists to close.

    Ordered rather than a set because both builds of the model iterate this
    and `solve` refuses to hint one from the other unless they agree
    structurally.
    """
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for group_id in (group.id for group in groups) if groups else with_lessons:
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
