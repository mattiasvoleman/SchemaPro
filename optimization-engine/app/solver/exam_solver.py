"""Exam planning: which time, which rooms and which invigilators, solved.

WHY THIS EXISTS. A provvecka is 20-30 prov that must not collide, must not
stack on a class, must fit in the exam rooms and must find a teacher to watch
every room, in a week where most teachers teach most hours. Skola24 and Untis
leave it to a spreadsheet. This is a small CP-SAT model over the exams of one
plan, separate from the generator in every way — its own request, its own
route, its own budget — because it answers a question the generator never asks
and must never change the generator's answers.

WHAT IT DECIDES, for every exam, or leaves the exam out:

* one of the exam's candidate times (the gateway has already found them
  possible and priced them: `loss` is the lesson minutes the time cancels);
* one or more exam rooms, with as many writers in each as the room seats;
* the invigilators of each room: max(1, ceil(writers / ratio)) of them, a
  teacher in at most one room of an exam.

THE HARD RULES. A class sits at most one exam at a time, at most
`maxPerClassPerDay` a day and `maxPerClassPerWeek` a week, counting what it
already has from outside the plan. A room and a teacher hold one exam at a
time, and for `length + turnover` minutes, never while the gateway says they
are busy (blocks). Every writer has a seat. Leaving an exam unplaced is always
allowed, so the model is never INFEASIBLE and the worst answer is an empty
plan with a named reason on every exam.

THE OBJECTIVE, one weighted sum whose first term outweighs all the rest
together (EXAMS FIRST, below): more exams placed; then, by the request's
weights, fewer cancelled lesson minutes, fewer rooms beyond an exam's first,
a fairer share of invigilation over the whole year (the `prior` counter is
what makes it the year's and not the week's) and fewer exams stacked on a
class's day. A nationellt prov (`fixed`) outweighs every exam that is not.

EXAMS FIRST. The weight of a placed exam is one more than the sum of every
soft term at its worst, computed from the request, so no number of cancelled
lessons or extra rooms is ever traded for an exam left out. A fixed exam's is
one more than every exam that is not fixed put together.

WHAT IT NEVER DOES: read a name, a date or a subject. The invigilators are
chosen per exam and handed to the exam's rooms in payload order afterwards:
nothing the model knows distinguishes one room's watchers from another's, so
asking CP-SAT to decide it would only multiply variables. See
app/schemas/exams.py for what crosses the wire.
"""

from __future__ import annotations

import logging
import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.schemas.exams import (
    ExamIn,
    ExamLimits,
    ExamMetrics,
    ExamRoomIn,
    ExamSearch,
    ExamWeights,
    InvigilatorIn,
    InvigilatorMinutes,
    PlacedExam,
    PlacedRoom,
    PlanExamsRequest,
    PlanExamsResponse,
    UnplacedExam,
)

logger = logging.getLogger(__name__)

#: CP-SAT's parallel portfolio, as the staffing proposal's. A request's own
#: `search.workers` replaces it.
EXAM_WORKERS = 8

#: The largest model this module builds, counted in CP-SAT variables plus the
#: literals of the block clauses: the time limit bounds Solve() and nothing
#: before it, and a build over a million of them would eat the request.
MAX_MODEL_VARIABLES = 1_000_000

#: Below this much time left the search is not started: CP-SAT's own start-up
#: would eat it.
MIN_SEARCH_SECONDS = 0.05

#: Kept back from the search for what follows it — reading the answer, the
#: Python re-check, the reasons and the response — so the whole request, not
#: just the search, ends inside the time limit.
AFTER_SEARCH_SECONDS = 0.25

#: The fairness term: eight thresholds, THRESHOLD_MINUTES apart, starting at
#: the lowest prior of the teachers who can invigilate at all. A teacher pays
#: `fairness` per minute above each of them, divided by 30 (see _SCALE).
FAIRNESS_THRESHOLDS = 8
THRESHOLD_MINUTES = 30

#: Every other term of the objective is multiplied by this so that the
#: fairness weight can be "per half hour" on a model of whole minutes without
#: a fraction: loss, rooms and spread are per count, fairness per minute / 30.
_SCALE = 30

#: The reasons an exam can be stopped by, in the order they are tried at a
#: slot and the order that breaks a tie between two that stop equally many.
_STOP_ORDER = (
    "EXAM_CLASS_CLASH",
    "EXAM_CLASS_DAY_CAP",
    "EXAM_CLASS_WEEK_CAP",
    "EXAM_NO_ROOM_SEATS",
    "EXAM_ROOMS_TAKEN",
    "EXAM_NO_INVIGILATORS",
    "EXAM_INVIGILATORS_TAKEN",
)


# ---------------------------------------------------------------------------
# The problem: the request, with every id turned into a payload position.
# ---------------------------------------------------------------------------


def min_invigilators(writers: int, seats: list[int], ratio: int) -> int | None:
    """The fewest invigilators that can watch `writers` pupils in rooms of
    `seats`, or None when the rooms cannot seat them.

    A room used needs at least one invigilator, and each further one adds
    `ratio` places to it up to its seats. Each room's additions come in
    non-increasing steps (ratio, ratio, ..., the remainder), so taking the
    largest steps overall until the writers are covered is optimal and always
    takes each room's steps in order.
    """
    if sum(seats) < writers:
        return None
    full = sum(room // ratio for room in seats)
    covered = full * ratio
    if writers <= covered:
        return -(-writers // ratio)
    remainders = sorted((room % ratio for room in seats if room % ratio), reverse=True)
    # The seats cover the writers, so the remainders reach them.
    needed = writers - covered
    count = full
    while needed > 0:
        needed -= remainders[count - full]
        count += 1
    return count


@dataclass
class ExamProblem:
    """The request, and everything the model and the reasons read off it.

    Positions, never uuids, are what everything below iterates and orders by:
    the gateway mints fresh uuids for every request, so anything sorted by
    one would be ordered at random and the answer would differ between two
    presses on the same plan.
    """

    request: PlanExamsRequest
    exams: list[ExamIn]
    rooms: list[ExamRoomIn]
    teachers: list[InvigilatorIn]
    limits: ExamLimits
    weights: ExamWeights
    #: Exam → its classes, as positions in order of first appearance.
    classes: list[tuple[int, ...]]
    class_ids: list[UUID]
    #: Exam → slot → the absolute start minute (day * 1440 + start).
    starts: list[list[int]]
    #: Exam → room position → the slots (indices into the exam's slots) it is
    #: busy at; the same for teachers. A resource not named is free everywhere.
    room_blocked: list[dict[int, frozenset[int]]]
    teacher_blocked: list[dict[int, frozenset[int]]]
    existing_day: dict[tuple[int, int], int]
    existing_week: dict[tuple[int, int], int]
    #: Exam → the slots the model keeps: those no rule rules out on its own.
    viable: list[list[int]] = field(default_factory=list)
    #: Exam → the rooms and teachers that are free at some viable slot.
    room_candidates: list[list[int]] = field(default_factory=list)
    teacher_candidates: list[list[int]] = field(default_factory=list)

    @property
    def modelled(self) -> list[int]:
        """Exams with at least one slot the model keeps, in payload order."""
        return [exam for exam, slots in enumerate(self.viable) if slots]

    def day_left(self, klass: int, day: int) -> int:
        """Exams `klass` may still be given on `day`."""
        return max(0, self.limits.max_per_class_per_day - self.existing_day.get((klass, day), 0))

    def week_left(self, klass: int, week: int) -> int:
        return max(0, self.limits.max_per_class_per_week - self.existing_week.get((klass, week), 0))

    def blocked_rooms_at(self, exam: int) -> dict[int, set[int]]:
        """Slot → the rooms the exam cannot use there."""
        at: dict[int, set[int]] = defaultdict(set)
        for room, slots in self.room_blocked[exam].items():
            for slot in slots:
                at[slot].add(room)
        return at

    def blocked_teachers_at(self, exam: int) -> dict[int, set[int]]:
        at: dict[int, set[int]] = defaultdict(set)
        for teacher, slots in self.teacher_blocked[exam].items():
            for slot in slots:
                at[slot].add(teacher)
        return at

    def room_seats_at(self, exam: int, blocked: set[int]) -> list[int]:
        """The seats of every room not in `blocked`, in payload order."""
        return [
            room.seats for index, room in enumerate(self.rooms) if index not in blocked
        ]

    def needed_at(self, exam: int, free_rooms: list[int]) -> int | None:
        return min_invigilators(
            self.exams[exam].writers, free_rooms, self.limits.writers_per_invigilator,
        )


def prepare(request: PlanExamsRequest) -> ExamProblem:
    exams = list(request.exams)
    room_index = {room.id: index for index, room in enumerate(request.rooms)}
    teacher_index = {teacher.id: index for index, teacher in enumerate(request.teachers)}
    class_index: dict[UUID, int] = {}
    classes = [
        tuple(class_index.setdefault(klass, len(class_index)) for klass in exam.classes)
        for exam in exams
    ]
    # A class only the existing loads name is no exam's and gets no position:
    # nothing reads its load.
    problem = ExamProblem(
        request=request,
        exams=exams,
        rooms=list(request.rooms),
        teachers=list(request.teachers),
        limits=request.limits,
        weights=request.weights,
        classes=classes,
        class_ids=list(class_index),
        starts=[[slot.day * 1440 + slot.start for slot in exam.slots] for exam in exams],
        room_blocked=[
            {room_index[block.id]: frozenset(block.slots) for block in exam.room_blocks}
            for exam in exams
        ],
        teacher_blocked=[
            {teacher_index[block.id]: frozenset(block.slots) for block in exam.teacher_blocks}
            for exam in exams
        ],
        existing_day={
            (class_index[load.class_id], load.day): load.count
            for load in request.existing_day_load
            if load.class_id in class_index
        },
        existing_week={
            (class_index[load.class_id], load.week): load.count
            for load in request.existing_week_load
            if load.class_id in class_index
        },
    )
    _narrow(problem)
    return problem


def _narrow(problem: ExamProblem) -> None:
    """Keep only the slots, rooms and teachers a rule does not rule out alone.

    Pure pruning: a slot dropped here could not be used in any answer, and
    the reasons are judged on the final answer from the request, not from
    what the model kept. A smaller model is the whole point.
    """
    for index, exam in enumerate(problem.exams):
        blocked_rooms = problem.blocked_rooms_at(index)
        blocked_teachers = problem.blocked_teachers_at(index)
        viable: list[int] = []
        for slot_index, slot in enumerate(exam.slots):
            if any(
                problem.day_left(klass, slot.day) < 1 or problem.week_left(klass, slot.week) < 1
                for klass in problem.classes[index]
            ):
                continue
            seats = problem.room_seats_at(index, blocked_rooms.get(slot_index, set()))
            needed = problem.needed_at(index, seats)
            if needed is None:
                continue
            free = len(problem.teachers) - len(blocked_teachers.get(slot_index, ()))
            if free < needed:
                continue
            viable.append(slot_index)
        problem.viable.append(viable)
        kept = set(viable)
        problem.room_candidates.append([
            room for room in range(len(problem.rooms))
            if kept - problem.room_blocked[index].get(room, frozenset())
        ])
        problem.teacher_candidates.append([
            teacher for teacher in range(len(problem.teachers))
            if kept - problem.teacher_blocked[index].get(teacher, frozenset())
        ])


def estimate_model_size(problem: ExamProblem) -> int:
    """CP-SAT variables plus the literals of the block clauses, before the
    model is built: the guard against a plan that would eat the request."""
    size = 0
    for exam in problem.modelled:
        kept = len(problem.viable[exam])
        size += 2 * kept + 2
        for room in problem.room_candidates[exam]:
            blocked = len(problem.room_blocked[exam].get(room, ()))
            size += 3 + min(blocked, kept)
        for teacher in problem.teacher_candidates[exam]:
            blocked = len(problem.teacher_blocked[exam].get(teacher, ()))
            size += 1 + min(blocked, kept)
    return size + (1 + FAIRNESS_THRESHOLDS) * len(problem.teachers)


# ---------------------------------------------------------------------------
# An answer, and the Python re-check of every hard rule on it.
# ---------------------------------------------------------------------------


@dataclass
class RoomUse:
    room: int
    writers: int
    invigilators: list[int]


@dataclass
class Placement:
    slot: int
    rooms: list[RoomUse]


#: Exam position → where and how it is held; unplaced exams are absent.
Plan = dict[int, Placement]


def _overlap_free(intervals: list[tuple[int, int]]) -> bool:
    ordered = sorted(intervals)
    return all(later[0] >= earlier[1] for earlier, later in zip(ordered, ordered[1:]))


def check(problem: ExamProblem, plan: Plan) -> None:
    """Every hard rule on the answer, in plain Python.

    An answer that breaks one is a bug in the model or the reading of it, so
    it raises rather than reaching a school: the empty plan satisfies every
    rule, so there is always a correct answer to fall back on, and it is the
    caller's job to notice.
    """
    limits = problem.limits
    ratio = limits.writers_per_invigilator
    turnover = limits.turnover_minutes
    class_intervals: dict[int, list[tuple[int, int]]] = defaultdict(list)
    room_intervals: dict[int, list[tuple[int, int]]] = defaultdict(list)
    teacher_intervals: dict[int, list[tuple[int, int]]] = defaultdict(list)
    day_count: dict[tuple[int, int], int] = defaultdict(int)
    week_count: dict[tuple[int, int], int] = defaultdict(int)
    for index, placement in plan.items():
        exam = problem.exams[index]
        if not 0 <= placement.slot < len(exam.slots):
            msg = f"Exam {index} is given a slot it does not have."
            raise SolverBuildError(msg)
        slot = exam.slots[placement.slot]
        start = problem.starts[index][placement.slot]
        if sum(use.writers for use in placement.rooms) != exam.writers:
            msg = f"Exam {index} does not seat exactly its writers."
            raise SolverBuildError(msg)
        watchers: list[int] = []
        for use in placement.rooms:
            room = problem.rooms[use.room]
            if not 1 <= use.writers <= room.seats:
                msg = f"Exam {index} puts {use.writers} writers in a room of {room.seats} seats."
                raise SolverBuildError(msg)
            if placement.slot in problem.room_blocked[index].get(use.room, ()):
                msg = f"Exam {index} is given a room that is busy then."
                raise SolverBuildError(msg)
            if len(use.invigilators) != max(1, -(-use.writers // ratio)):
                msg = f"Exam {index} has the wrong number of invigilators in a room."
                raise SolverBuildError(msg)
            room_intervals[use.room].append((start, start + exam.length + turnover))
            watchers += use.invigilators
        if len({use.room for use in placement.rooms}) != len(placement.rooms):
            msg = f"Exam {index} uses a room twice."
            raise SolverBuildError(msg)
        if len(set(watchers)) != len(watchers):
            msg = f"Exam {index} gives one teacher two places."
            raise SolverBuildError(msg)
        for teacher in watchers:
            if placement.slot in problem.teacher_blocked[index].get(teacher, ()):
                msg = f"Exam {index} is given a teacher who is busy then."
                raise SolverBuildError(msg)
            teacher_intervals[teacher].append((start, start + exam.length + turnover))
        for klass in problem.classes[index]:
            class_intervals[klass].append((start, start + exam.length))
            day_count[klass, slot.day] += 1
            week_count[klass, slot.week] += 1
    for groups, what in (
        (class_intervals, "class"), (room_intervals, "room"), (teacher_intervals, "teacher"),
    ):
        for key, intervals in groups.items():
            if not _overlap_free(intervals):
                msg = f"A {what} ({key}) holds two exams at once."
                raise SolverBuildError(msg)
    for (klass, day), count in day_count.items():
        if count + problem.existing_day.get((klass, day), 0) > limits.max_per_class_per_day:
            msg = f"A class has more than {limits.max_per_class_per_day} exams on day {day}."
            raise SolverBuildError(msg)
    for (klass, week), count in week_count.items():
        if count + problem.existing_week.get((klass, week), 0) > limits.max_per_class_per_week:
            msg = f"A class has more than {limits.max_per_class_per_week} exams in week {week}."
            raise SolverBuildError(msg)


def invigilator_minutes(problem: ExamProblem, plan: Plan) -> list[int]:
    """This run's invigilation minutes per teacher, in payload order."""
    minutes = [0] * len(problem.teachers)
    for index, placement in plan.items():
        for use in placement.rooms:
            for teacher in use.invigilators:
                minutes[teacher] += problem.exams[index].length
    return minutes


# ---------------------------------------------------------------------------
# The model.
# ---------------------------------------------------------------------------


@dataclass
class ExamModel:
    model: cp_model.CpModel
    placed: dict[int, cp_model.IntVar] = field(default_factory=dict)
    slots: dict[int, list[cp_model.IntVar]] = field(default_factory=dict)
    writers: dict[tuple[int, int], cp_model.IntVar] = field(default_factory=dict)
    uses: dict[tuple[int, int], cp_model.IntVar] = field(default_factory=dict)
    watchers: dict[tuple[int, int], cp_model.IntVar] = field(default_factory=dict)
    #: The start of each modelled exam, and each room's invigilator count.
    starts: dict[int, cp_model.IntVar] = field(default_factory=dict)
    counts: dict[tuple[int, int], cp_model.IntVar] = field(default_factory=dict)
    #: Helper variables the hint states: exams stacked on a class's day, the
    #: minutes a teacher is over each fairness threshold, the highest load.
    stacked: dict[tuple[int, int], cp_model.IntVar] = field(default_factory=dict)
    excess: dict[tuple[int, int], tuple[cp_model.IntVar, int]] = field(default_factory=dict)
    peak: cp_model.IntVar | None = None
    loaded: list[int] = field(default_factory=list)
    #: The soft terms, as (coefficient, variable), already scaled.
    soft: list[tuple[int, cp_model.IntVar]] = field(default_factory=list)
    #: The most the soft terms can cost together, and the exams that are not
    #: fixed: what the weight of a placed exam is made larger than.
    soft_bound: int = 0
    free_exams: list[int] = field(default_factory=list)


def _block_clause(
    model: cp_model.CpModel,
    used: cp_model.IntVar,
    slots: list[cp_model.IntVar],
    blocked: frozenset[int],
    kept: list[int],
) -> None:
    """`used` may not be true at a slot the resource is busy at.

    Either one clause over the slots it is free at, or one implication per
    busy slot — whichever is shorter. The exam holds exactly one slot when
    it is placed, so the two say the same.
    """
    busy = [position for position, slot in enumerate(kept) if slot in blocked]
    if not busy:
        return
    free = [position for position, slot in enumerate(kept) if slot not in blocked]
    if len(free) <= len(busy):
        model.AddBoolOr([used.Not(), *(slots[position] for position in free)])
    else:
        for position in busy:
            model.AddBoolOr([used.Not(), slots[position].Not()])


def build_model(problem: ExamProblem) -> ExamModel:
    built = ExamModel(model=cp_model.CpModel())
    model = built.model
    limits = problem.limits
    weights = problem.weights
    ratio = limits.writers_per_invigilator
    turnover = limits.turnover_minutes

    class_intervals: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)
    room_intervals: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)
    teacher_intervals: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)
    by_day: dict[tuple[int, int], list[cp_model.IntVar]] = defaultdict(list)
    by_week: dict[tuple[int, int], list[cp_model.IntVar]] = defaultdict(list)
    watch_terms: dict[int, list[tuple[int, cp_model.IntVar]]] = defaultdict(list)
    soft: list[tuple[int, cp_model.IntVar]] = []
    soft_bound = 0

    for index in problem.modelled:
        exam = problem.exams[index]
        kept = problem.viable[index]
        starts = [problem.starts[index][slot] for slot in kept]
        placed = model.NewBoolVar(f"placed_{index}")
        slots = [model.NewBoolVar(f"slot_{index}_{position}") for position in range(len(kept))]
        model.Add(sum(slots) == placed)
        start = model.NewIntVarFromDomain(
            cp_model.Domain.FromValues(sorted(set(starts))), f"start_{index}",
        )
        model.Add(start == cp_model.LinearExpr.WeightedSum(slots, starts)).OnlyEnforceIf(placed)
        built.placed[index] = placed
        built.slots[index] = slots
        built.starts[index] = start

        sitting = model.NewOptionalFixedSizeIntervalVar(
            start, exam.length, placed, f"sitting_{index}",
        )
        for klass in problem.classes[index]:
            class_intervals[klass].append(sitting)
            for position, slot_index in enumerate(kept):
                slot = exam.slots[slot_index]
                by_day[klass, slot.day].append(slots[position])
                by_week[klass, slot.week].append(slots[position])

        losses = [exam.slots[slot_index].loss for slot_index in kept]
        for position, loss in enumerate(losses):
            if loss and weights.loss:
                soft.append((_SCALE * weights.loss * loss, slots[position]))
        soft_bound += _SCALE * weights.loss * max(losses)

        room_vars: list[cp_model.IntVar] = []
        used_vars: list[cp_model.IntVar] = []
        watcher_counts: list[cp_model.IntVar] = []
        for room in problem.room_candidates[index]:
            seats = min(problem.rooms[room].seats, exam.writers)
            x = model.NewIntVar(0, seats, f"writers_{index}_{room}")
            y = model.NewBoolVar(f"uses_{index}_{room}")
            v = model.NewIntVar(0, -(-seats // ratio), f"watchers_{index}_{room}")
            model.Add(x >= 1).OnlyEnforceIf(y)
            model.Add(x == 0).OnlyEnforceIf(y.Not())
            model.Add(v == 0).OnlyEnforceIf(y.Not())
            # Exactly max(1, ceil(x / ratio)): ratio*(v-1) < x <= ratio*v.
            model.Add(ratio * v >= x)
            model.Add(ratio * v - (ratio - 1) <= x).OnlyEnforceIf(y)
            _block_clause(model, y, slots, problem.room_blocked[index].get(room, frozenset()), kept)
            built.writers[index, room] = x
            built.uses[index, room] = y
            built.counts[index, room] = v
            room_vars.append(x)
            used_vars.append(y)
            watcher_counts.append(v)
            room_intervals[room].append(model.NewOptionalFixedSizeIntervalVar(
                start, exam.length + turnover, y, f"room_{index}_{room}",
            ))
        model.Add(sum(room_vars) == exam.writers * placed)
        if weights.rooms:
            extra = max(0, min(len(used_vars), exam.writers) - 1)
            soft_bound += _SCALE * weights.rooms * extra
            soft.extend((_SCALE * weights.rooms, y) for y in used_vars)
            soft.append((-_SCALE * weights.rooms, placed))

        watching: list[cp_model.IntVar] = []
        for teacher in problem.teacher_candidates[index]:
            w = model.NewBoolVar(f"watch_{index}_{teacher}")
            _block_clause(
                model, w, slots, problem.teacher_blocked[index].get(teacher, frozenset()), kept,
            )
            built.watchers[index, teacher] = w
            watching.append(w)
            teacher_intervals[teacher].append(model.NewOptionalFixedSizeIntervalVar(
                start, exam.length + turnover, w, f"teacher_{index}_{teacher}",
            ))
            watch_terms[teacher].append((exam.length, w))
        model.Add(sum(watching) == sum(watcher_counts))

        if weights.spread:
            soft_bound += _SCALE * weights.spread * len(problem.classes[index])

    for intervals in (*class_intervals.values(), *room_intervals.values(),
                      *teacher_intervals.values()):
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)

    for (klass, day), variables in by_day.items():
        if len(variables) > problem.day_left(klass, day):
            model.Add(sum(variables) <= problem.day_left(klass, day))
    for (klass, week), variables in by_week.items():
        if len(variables) > problem.week_left(klass, week):
            model.Add(sum(variables) <= problem.week_left(klass, week))

    if weights.spread:
        for (klass, day), variables in by_day.items():
            before = problem.existing_day.get((klass, day), 0)
            if before >= 1:
                soft.extend((_SCALE * weights.spread, variable) for variable in variables)
            elif len(variables) >= 2:
                stacked = model.NewIntVar(0, len(variables) - 1, f"stacked_{klass}_{day}")
                model.Add(stacked >= sum(variables) - 1)
                built.stacked[klass, day] = stacked
                soft.append((_SCALE * weights.spread, stacked))

    fairness, fairness_bound = _fairness(problem, built, watch_terms)
    soft += fairness

    built.soft = _merged(soft)
    built.soft_bound = soft_bound + fairness_bound
    built.free_exams = [i for i in problem.modelled if not problem.exams[i].fixed]
    # One more exam outweighs every soft term at its worst, so the sum below
    # is lexicographic: exams first (fixed ones before the rest), then cost.
    reward = placement_terms(problem, built, built.soft_bound + 1)
    model.Minimize(_sum(_merged(built.soft + [(-weight, variable) for weight, variable in reward])))
    return built


def placement_terms(
    problem: ExamProblem, built: ExamModel, unit: int,
) -> list[tuple[int, cp_model.IntVar]]:
    """What placing each exam is worth: `unit` for an exam, and for a fixed
    one more than all the others together, so a nationellt prov is placed
    whenever any plan places it."""
    fixed = (len(built.free_exams) + 1) * unit
    return [
        (fixed if problem.exams[index].fixed else unit, built.placed[index])
        for index in problem.modelled
    ]


def _merged(terms: list[tuple[int, cp_model.IntVar]]) -> list[tuple[int, cp_model.IntVar]]:
    """One coefficient per variable (a placed exam is in the soft terms twice,
    as the exam and as the room term's "beyond the first")."""
    merged: dict[int, tuple[int, cp_model.IntVar]] = {}
    for weight, variable in terms:
        key = variable.Index()
        merged[key] = (merged[key][0] + weight if key in merged else weight, variable)
    return [(weight, variable) for weight, variable in merged.values() if weight]


def _sum(terms: list[tuple[int, cp_model.IntVar]]) -> cp_model.LinearExpr:
    return cp_model.LinearExpr.WeightedSum(
        [variable for _, variable in terms], [weight for weight, _ in terms],
    )


def _fairness(
    problem: ExamProblem,
    built: ExamModel,
    watch_terms: dict[int, list[tuple[int, cp_model.IntVar]]],
) -> tuple[list[tuple[int, cp_model.IntVar]], int]:
    """The convex share term, and the most it can cost.

    A teacher's load is prior + the minutes they watch in this plan. The cost
    of a load is the sum, over eight thresholds a half hour apart starting at
    the lowest prior in the pool, of the minutes above each: a convex
    piecewise-linear curve whose slope grows by one at every threshold, so a
    teacher who already carries a lot pays more for each further minute than
    one who carries little. That, and only that, makes the prior the year's
    counter. A small term on the highest load of all is added for the
    teachers beyond the last threshold, where the curve is flat.
    """
    model = built.model
    weight = problem.weights.fairness
    if not weight or not watch_terms:
        return [], 0
    base = min(problem.teachers[teacher].prior for teacher in watch_terms)
    terms: list[tuple[int, cp_model.IntVar]] = []
    bound = 0
    loads: list[tuple[int, int, list[tuple[int, cp_model.IntVar]]]] = []
    for teacher, entries in watch_terms.items():
        prior = problem.teachers[teacher].prior
        added = sum(length for length, _ in entries)
        loads.append((prior, added, entries))
        linear = 0
        for step in range(FAIRNESS_THRESHOLDS):
            threshold = base + THRESHOLD_MINUTES * step
            if threshold >= prior + added:
                break
            if threshold <= prior:
                linear += 1
                continue
            excess = model.NewIntVar(0, prior + added - threshold, f"excess_{teacher}_{step}")
            model.Add(
                excess >= prior - threshold
                + cp_model.LinearExpr.WeightedSum(
                    [variable for _, variable in entries], [length for length, _ in entries],
                ),
            )
            terms.append((weight, excess))
            built.excess[teacher, step] = (excess, threshold)
            bound += weight * added
        # The teacher at the lowest prior is on the first threshold's line, so
        # every teacher is over at least one.
        terms.extend((weight * linear * length, variable) for length, variable in entries)
        bound += weight * linear * added
    peak = model.NewIntVar(
        max(prior for prior, _, _ in loads),
        max(prior + added for prior, added, _ in loads),
        "peak_load",
    )
    for prior, _, entries in loads:
        model.Add(
            peak >= prior
            + cp_model.LinearExpr.WeightedSum(
                [variable for _, variable in entries], [length for length, _ in entries],
            ),
        )
    terms.append((weight, peak))
    built.peak = peak
    built.loaded = list(watch_terms)
    bound += weight * max(prior + added for prior, added, _ in loads)
    return terms, bound


def read_plan(problem: ExamProblem, built: ExamModel, solver: cp_model.CpSolver) -> Plan:
    """The plan CP-SAT found, with each room's invigilators dealt in payload
    order from the exam's watchers (nothing in the model tells two rooms'
    watchers apart, so nothing needs to decide it)."""
    ratio = problem.limits.writers_per_invigilator
    plan: Plan = {}
    for index in problem.modelled:
        if not solver.Value(built.placed[index]):
            continue
        slot = next(
            problem.viable[index][position]
            for position, variable in enumerate(built.slots[index])
            if solver.Value(variable)
        )
        watchers = [
            teacher for teacher in problem.teacher_candidates[index]
            if solver.Value(built.watchers[index, teacher])
        ]
        rooms: list[RoomUse] = []
        taken = 0
        for room in problem.room_candidates[index]:
            if not solver.Value(built.uses[index, room]):
                continue
            writers = solver.Value(built.writers[index, room])
            count = max(1, -(-writers // ratio))
            rooms.append(RoomUse(room, writers, watchers[taken:taken + count]))
            taken += count
        plan[index] = Placement(slot, rooms)
    return plan


# ---------------------------------------------------------------------------
# What a plan leaves free, and why an exam was left out.
# ---------------------------------------------------------------------------


@dataclass
class Free:
    """What is left for one exam at one slot, given the exams already placed.

    `rooms` and `teachers` are the ones the exam's own blocks leave open
    (so what is left with no other exam in the plan); `free_rooms` and
    `free_teachers` the ones no placed exam holds then.
    """

    rooms: list[int]
    free_rooms: list[int]
    teachers: list[int]
    free_teachers: list[int]


class State:
    """The exams placed so far, as the rules read them: what each class,
    room and teacher has and when. Built from a plan for the reasons and
    grown one exam at a time by the greedy."""

    def __init__(self, problem: ExamProblem) -> None:
        self.problem = problem
        self.class_busy: dict[int, list[tuple[int, int]]] = defaultdict(list)
        self.day_count: dict[tuple[int, int], int] = defaultdict(int)
        self.week_count: dict[tuple[int, int], int] = defaultdict(int)
        #: (start, end incl. turnover, rooms, teachers) of every placed exam.
        self.holds: list[tuple[int, int, set[int], set[int]]] = []
        self.minutes = [0] * len(problem.teachers)

    @classmethod
    def of(cls, problem: ExamProblem, plan: Plan) -> State:
        state = cls(problem)
        for index, placement in plan.items():
            state.add(index, placement)
        return state

    def add(self, index: int, placement: Placement) -> None:
        problem = self.problem
        exam = problem.exams[index]
        slot = exam.slots[placement.slot]
        start = problem.starts[index][placement.slot]
        for klass in problem.classes[index]:
            self.class_busy[klass].append((start, start + exam.length))
            self.day_count[klass, slot.day] += 1
            self.week_count[klass, slot.week] += 1
        teachers = {teacher for use in placement.rooms for teacher in use.invigilators}
        for teacher in teachers:
            self.minutes[teacher] += exam.length
        self.holds.append((
            start, start + exam.length + problem.limits.turnover_minutes,
            {use.room for use in placement.rooms}, teachers,
        ))

    def free_at(self, index: int, slot_index: int) -> Free:
        """The rooms and teachers `index` could use at `slot_index`."""
        problem = self.problem
        exam = problem.exams[index]
        start = problem.starts[index][slot_index]
        until = start + exam.length + problem.limits.turnover_minutes
        busy_rooms: set[int] = set()
        busy_teachers: set[int] = set()
        for begin, finish, rooms, teachers in self.holds:
            if begin < until and start < finish:
                busy_rooms |= rooms
                busy_teachers |= teachers
        blocked_rooms = {
            room for room, slots in problem.room_blocked[index].items() if slot_index in slots
        }
        blocked_teachers = {
            teacher for teacher, slots in problem.teacher_blocked[index].items()
            if slot_index in slots
        }
        rooms = [room for room in range(len(problem.rooms)) if room not in blocked_rooms]
        teachers = [
            teacher for teacher in range(len(problem.teachers)) if teacher not in blocked_teachers
        ]
        return Free(
            rooms=rooms,
            free_rooms=[room for room in rooms if room not in busy_rooms],
            teachers=teachers,
            free_teachers=[teacher for teacher in teachers if teacher not in busy_teachers],
        )

    def stop(
        self, index: int, slot_index: int,
    ) -> tuple[str, dict[str, str | int], Free] | None:
        """The first rule that stops `index` at `slot_index`, with that slot's
        figures, or None when nothing does (the exam could be added as it
        stands, with the others where they are)."""
        problem = self.problem
        exam = problem.exams[index]
        slot = exam.slots[slot_index]
        limits = problem.limits
        start = problem.starts[index][slot_index]
        end = start + exam.length
        free = self.free_at(index, slot_index)
        for klass in problem.classes[index]:
            if any(begin < end and start < finish for begin, finish in self.class_busy[klass]):
                return "EXAM_CLASS_CLASH", {"classId": str(problem.class_ids[klass])}, free
        for klass in problem.classes[index]:
            if (
                problem.existing_day.get((klass, slot.day), 0) + self.day_count[klass, slot.day]
                >= limits.max_per_class_per_day
            ):
                return "EXAM_CLASS_DAY_CAP", {
                    "limit": limits.max_per_class_per_day,
                    "classId": str(problem.class_ids[klass]),
                }, free
        for klass in problem.classes[index]:
            if (
                problem.existing_week.get((klass, slot.week), 0)
                + self.week_count[klass, slot.week]
                >= limits.max_per_class_per_week
            ):
                return "EXAM_CLASS_WEEK_CAP", {
                    "limit": limits.max_per_class_per_week,
                    "classId": str(problem.class_ids[klass]),
                }, free

        all_seats = [problem.rooms[room].seats for room in free.rooms]
        free_seats = [problem.rooms[room].seats for room in free.free_rooms]
        if sum(all_seats) < exam.writers:
            return "EXAM_NO_ROOM_SEATS", {"writers": exam.writers, "seats": sum(all_seats)}, free
        if sum(free_seats) < exam.writers:
            return "EXAM_ROOMS_TAKEN", {"writers": exam.writers, "seats": sum(free_seats)}, free
        alone = problem.needed_at(index, all_seats)
        with_others = problem.needed_at(index, free_seats)
        # Both exist: the seats were checked above.
        assert alone is not None and with_others is not None
        if len(free.teachers) < alone:
            return "EXAM_NO_INVIGILATORS", {"needed": alone, "free": len(free.teachers)}, free
        if len(free.free_teachers) < with_others:
            return "EXAM_INVIGILATORS_TAKEN", {
                "needed": with_others, "free": len(free.free_teachers),
            }, free
        return None


def unplaced_reasons(
    problem: ExamProblem, plan: Plan,
) -> dict[int, tuple[str, dict[str, str | int]]]:
    """For every exam not in `plan`, the one rule that stops it most often.

    Each of the exam's slots is tried against the placed exams, which stay
    where they are, and the first rule that stops it is counted: a class
    already sitting an exam then (EXAM_CLASS_CLASH), the class's daily and
    weekly caps, seats (EXAM_NO_ROOM_SEATS when the exam does not fit even
    with the rooms to itself, EXAM_ROOMS_TAKEN when other exams hold the
    rest), then invigilators the same way. The reason is the rule that stops
    the most slots, ties in that order; params carry the figures of the slot
    that came closest. A slot nothing stops means the exam could have been
    added and the search did not get there (EXAM_NOT_REACHED), whatever the
    other slots say; an exam with no slots at all is EXAM_NO_SLOT.
    """
    state = State.of(problem, plan)
    answers: dict[int, tuple[str, dict[str, str | int]]] = {}
    for index, exam in enumerate(problem.exams):
        if index in plan:
            continue
        if not exam.slots:
            answers[index] = ("EXAM_NO_SLOT", {})
            continue
        stopped: dict[str, list[dict[str, str | int]]] = defaultdict(list)
        reachable = False
        for slot_index in range(len(exam.slots)):
            verdict = state.stop(index, slot_index)
            if verdict is None:
                reachable = True
                break
            stopped[verdict[0]].append(verdict[1])
        if reachable:
            answers[index] = ("EXAM_NOT_REACHED", {})
            continue
        code = max(_STOP_ORDER, key=lambda name: (len(stopped[name]), -_STOP_ORDER.index(name)))
        answers[index] = (code, _closest(code, stopped[code]))
    return answers


def _closest(code: str, figures: list[dict[str, str | int]]) -> dict[str, str | int]:
    """The figures of the slot a rule came closest to letting through."""
    if code in ("EXAM_NO_ROOM_SEATS", "EXAM_ROOMS_TAKEN"):
        return max(figures, key=lambda item: int(item["seats"]))
    if code in ("EXAM_NO_INVIGILATORS", "EXAM_INVIGILATORS_TAKEN"):
        return max(figures, key=lambda item: int(item["free"]) - int(item["needed"]))
    return figures[0]


# ---------------------------------------------------------------------------
# The greedy: the floor under the search, and its first hint.
# ---------------------------------------------------------------------------


def _split(
    problem: ExamProblem, index: int, free_rooms: list[int],
) -> list[tuple[int, int]]:
    """(room, writers) for `index` in the rooms in `free_rooms`, using as few
    invigilators as the rooms allow and, among those, as few rooms."""
    exam = problem.exams[index]
    ratio = problem.limits.writers_per_invigilator
    steps: list[tuple[int, int, int]] = []     # (-places, -seats, room)
    for room in free_rooms:
        seats = problem.rooms[room].seats
        steps += [(-ratio, -seats, room)] * (seats // ratio)
        if seats % ratio:
            steps.append((-(seats % ratio), -seats, room))
    steps.sort()
    capacity: dict[int, int] = defaultdict(int)
    covered = 0
    for places, _, room in steps:
        if covered >= exam.writers:
            break
        capacity[room] += -places
        covered += -places
    left = exam.writers
    split: list[tuple[int, int]] = []
    for room in sorted(capacity, key=lambda r: (-capacity[r], r)):
        # The steps were taken only until the writers were covered, so every
        # room in the split seats at least one of them.
        take = min(capacity[room], left)
        split.append((room, take))
        left -= take
    return split


def greedy_plan(problem: ExamProblem) -> Plan:
    """A valid plan built exam by exam: the most tied-down exams first, each
    at its cheapest slot that nothing stops, in the fewest rooms, with the
    teachers who carry the least so far.

    It is the answer of last resort and the search's first hint. It is never
    asked to be good, only valid: every exam it places passes State.stop on
    the plan so far, which is exactly the rule set of the model.
    """
    state = State(problem)
    ratio = problem.limits.writers_per_invigilator
    plan: Plan = {}
    order = sorted(
        problem.modelled,
        key=lambda i: (
            not problem.exams[i].fixed, len(problem.viable[i]), -problem.exams[i].writers, i,
        ),
    )
    for index in order:
        exam = problem.exams[index]
        by_cost = sorted(
            problem.viable[index],
            key=lambda s: (
                exam.slots[s].loss,
                max((state.day_count[k, exam.slots[s].day] for k in problem.classes[index]),
                    default=0),
                s,
            ),
        )
        for slot_index in by_cost:
            if state.stop(index, slot_index) is not None:
                continue
            free = state.free_at(index, slot_index)
            split = _split(problem, index, free.free_rooms)
            wanted = sum(max(1, -(-writers // ratio)) for _, writers in split)
            ranked = sorted(free.free_teachers, key=lambda t: (
                problem.teachers[t].prior + state.minutes[t], t,
            ))
            team = ranked[:wanted]
            uses: list[RoomUse] = []
            taken = 0
            for room, writers in split:
                count = max(1, -(-writers // ratio))
                uses.append(RoomUse(room, writers, team[taken:taken + count]))
                taken += count
            plan[index] = Placement(slot_index, uses)
            state.add(index, plan[index])
            break
    return plan


def plan_weight(problem: ExamProblem, plan: Plan) -> tuple[int, int]:
    """(fixed exams placed, other exams placed): what the objective weighs
    first, in the order it weighs them."""
    fixed = sum(1 for index in plan if problem.exams[index].fixed)
    return fixed, len(plan) - fixed


def hint_plan(problem: ExamProblem, built: ExamModel, plan: Plan) -> None:
    """Hand `plan` to CP-SAT as its starting point, every variable stated."""
    model = built.model
    ratio = problem.limits.writers_per_invigilator
    for index in problem.modelled:
        kept = problem.viable[index]
        placement = plan.get(index)
        at = kept.index(placement.slot) if placement is not None else -1
        model.AddHint(built.placed[index], int(placement is not None))
        for position, variable in enumerate(built.slots[index]):
            model.AddHint(variable, int(position == at))
        model.AddHint(
            built.starts[index],
            problem.starts[index][placement.slot] if placement is not None
            else problem.starts[index][kept[0]],
        )
        uses = {use.room: use for use in placement.rooms} if placement is not None else {}
        for room in problem.room_candidates[index]:
            use = uses.get(room)
            model.AddHint(built.writers[index, room], use.writers if use else 0)
            model.AddHint(built.uses[index, room], int(use is not None))
            model.AddHint(
                built.counts[index, room], max(1, -(-use.writers // ratio)) if use else 0,
            )
        watching = {
            teacher for use in uses.values() for teacher in use.invigilators
        }
        for teacher in problem.teacher_candidates[index]:
            model.AddHint(built.watchers[index, teacher], int(teacher in watching))
    minutes = invigilator_minutes(problem, plan)
    for (teacher, step), (variable, threshold) in built.excess.items():
        model.AddHint(
            variable, max(0, problem.teachers[teacher].prior + minutes[teacher] - threshold),
        )
    if built.peak is not None:
        model.AddHint(built.peak, max(
            problem.teachers[teacher].prior + minutes[teacher] for teacher in built.loaded
        ))
    state = State.of(problem, plan)
    for (klass, day), variable in built.stacked.items():
        model.AddHint(variable, max(0, state.day_count[klass, day] - 1))


# ---------------------------------------------------------------------------
# The solve.
# ---------------------------------------------------------------------------


def budget_seconds(settings: Settings, search: ExamSearch | None) -> float:
    """The request's time limit: the deployment's, or less if the request asks
    for less. Never more."""
    cap = settings.exam_solver_max_time_seconds
    if search is not None and search.max_time_seconds is not None:
        return min(cap, search.max_time_seconds)
    return cap


@dataclass
class SolveReport:
    """Where one solve's time went, for the log and benchmarks/provvecka.py."""

    build: float = 0.0
    search: float = 0.0
    total: float = 0.0
    status: str = "NOT_RUN"
    objective: float = 0.0
    bound: float = 0.0


class ExamSolver:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        #: The last solve's report; read by the benchmark, never by the route.
        self.last_report = SolveReport()

    def _solver(self, seconds: float, search: ExamSearch | None) -> cp_model.CpSolver:
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        solver.parameters.num_workers = (
            search.workers if search is not None and search.workers is not None else EXAM_WORKERS
        )
        solver.parameters.random_seed = (
            search.seed if search is not None and search.seed is not None else 0
        )
        return solver

    def solve(self, request: PlanExamsRequest) -> PlanExamsResponse:
        started = time.monotonic()
        problem = prepare(request)
        report = SolveReport()
        self.last_report = report

        size = estimate_model_size(problem)
        if size > MAX_MODEL_VARIABLES:
            raise InvalidScheduleInputError.of("EXAM_MODEL_TOO_LARGE", {
                "variables": size, "limit": MAX_MODEL_VARIABLES,
            })
        plan, optimal = self._search(problem, started, report)
        check(problem, plan)
        report.total = time.monotonic() - started
        response = self._response(problem, plan, optimal, report.total)
        logger.info(
            "exam_solve request_id=%s exams=%d rooms=%d teachers=%d placed=%d status=%s "
            "cpsat=%s build=%.2fs search=%.2fs total=%.2fs",
            request.request_id, len(problem.exams), len(problem.rooms), len(problem.teachers),
            len(plan), response.status, report.status, report.build, report.search, report.total,
        )
        return response

    def _search(
        self, problem: ExamProblem, started: float, report: SolveReport,
    ) -> tuple[Plan, bool]:
        if not problem.modelled:
            # Every exam is stopped by a rule on its own: nothing to decide.
            return {}, True
        floor = greedy_plan(problem)
        check(problem, floor)
        began = time.monotonic()
        built = build_model(problem)
        report.build = time.monotonic() - began

        search = problem.request.search
        cap = budget_seconds(self._settings, search)
        # Measured from the start of the request: the narrowing and the build
        # eat into the cap, and the search gets what is left. With nothing
        # left the greedy is the answer.
        left = cap - AFTER_SEARCH_SECONDS - (time.monotonic() - started)
        if left < MIN_SEARCH_SECONDS:
            return floor, False
        hint_plan(problem, built, floor)
        solver = self._solver(left, search)
        began = time.monotonic()
        code = solver.Solve(built.model)
        report.search = time.monotonic() - began
        report.status = solver.StatusName(code)
        if code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the exam model: {built.model.Validate()}"
            raise SolverBuildError(msg)
        if code == cp_model.INFEASIBLE:
            # Leaving every exam out satisfies every rule, so this is a bug in
            # the model, never a property of the school's data.
            msg = "The exam model refused the empty plan; it was built wrong."
            raise SolverBuildError(msg)
        if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return floor, False
        report.objective = solver.ObjectiveValue()
        report.bound = solver.BestObjectiveBound()
        found = read_plan(problem, built, solver)
        # The greedy is a floor, never a competitor: the search starts from it
        # and keeps whatever it beats, so it only wins when CP-SAT stopped
        # before it had matched it.
        if plan_weight(problem, found) >= plan_weight(problem, floor):
            return found, code == cp_model.OPTIMAL
        return floor, False

    @staticmethod
    def _response(
        problem: ExamProblem, plan: Plan, optimal: bool, seconds: float,
    ) -> PlanExamsResponse:
        request = problem.request
        placed = [
            PlacedExam(
                exam=problem.exams[index].id,
                slot=placement.slot,
                rooms=[
                    PlacedRoom(
                        room=problem.rooms[use.room].id,
                        writers=use.writers,
                        invigilators=[problem.teachers[t].id for t in use.invigilators],
                    )
                    for use in placement.rooms
                ],
            )
            for index, placement in sorted(plan.items())
        ]
        reasons = unplaced_reasons(problem, plan)
        unplaced = [
            UnplacedExam(exam=problem.exams[index].id, reason=code, params=params)  # type: ignore[arg-type]
            for index, (code, params) in sorted(reasons.items())
        ]
        minutes = invigilator_minutes(problem, plan)
        loads = [teacher.prior + minutes[i] for i, teacher in enumerate(problem.teachers)]
        return PlanExamsResponse(
            request_id=request.request_id,
            status="OPTIMAL" if optimal else "FEASIBLE",
            placed=placed,
            unplaced=unplaced,
            invigilator_minutes=[
                InvigilatorMinutes(teacher=problem.teachers[i].id, minutes=m)
                for i, m in enumerate(minutes) if m > 0
            ],
            metrics=ExamMetrics(
                placed=len(plan),
                unplaced=len(reasons),
                loss=sum(
                    problem.exams[index].slots[placement.slot].loss
                    for index, placement in plan.items()
                ),
                rooms_used=sum(len(placement.rooms) for placement in plan.values()),
                invigilator_passes=sum(
                    len(use.invigilators) for placement in plan.values() for use in placement.rooms
                ),
                max_load=max(loads, default=0),
                min_load=min(loads, default=0),
                solve_seconds=round(seconds, 3),
            ),
        )
