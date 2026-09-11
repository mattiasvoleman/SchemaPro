"""Room walks: re-assign the rooms of a fixed timetable so fewer people walk.

WHY THIS EXISTS. The generator never names a concrete room in its model: it
picks an interchangeability CLASS per lesson (room_allocator.py) and a post-pass
sweep hands out concrete rooms in start order, with no idea who taught where a
moment before. That sweep is exactly what sends Elin from sal 1 up to sal 10 on
plan 2 while Alexander walks the other way, when each could simply have kept
one room. The school's words for it: it is pointless for both of them to change
floors.

WHAT IT MAY TOUCH. Rooms, and nothing else. Every time, day, teacher, group,
recurrence and date is input and stays input; a separate, small model is
cheaper and far easier to trust than re-opening the generator with times held.

WHAT MAKES IT SAFE TO PRESS. The school's current rooms are always a feasible
answer — every lesson may stay where it is even when its room breaks a rule
today — so the optimisation can never be refused and can never hand back
something worse. The answer is additionally checked in plain Python against the
input, and the input comes back unchanged unless the solver's is strictly
better.

ELIGIBILITY IS THE GENERATOR'S, REUSED. A lesson may only MOVE into a room the
generator itself would have placed it in: SchedulerSolver._lock_aware over
resolve_room_locks, i.e. _room_allowed plus LOCK rules. PlacedLesson and
WalkRoom carry the very attribute names those predicates read (id, subject_id,
student_group_size, required_room_type, min_grade_level, max_grade_level on the
lesson; id, capacity, type and the grade bounds on the room), so they are
passed in unchanged rather than re-implemented here — a second copy of "which
rooms may this lesson use" is how the stage limits once leaked, and
tests/test_room_walks.py pins that the two agree.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import NamedTuple, Protocol
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.schemas.rooms import (
    CountComparison,
    OptimizeRoomsRequest,
    OptimizeRoomsResponse,
    PlacedLesson,
    RoomChange,
    Walk,
    WalkComparison,
    WalkerKind,
    WalkerWalk,
    WalkRoom,
)
from app.solver.scheduler_solver import (
    SchedulerSolver,
    _preference_room_ids,
    _rule_reaches,
    resolve_room_locks,
)

logger = logging.getLogger(__name__)

# What one consecutive pair costs, per kind of change.
#
# A room change is a door and a corridor: the unit. A floor change is stairs,
# with a class and a bag of books, four times that. A building change is a coat,
# a yard and a crossing in January — twelve, which is three staircases, so that
# one trip outdoors is never traded for fewer than three trips up the stairs.
#
# W_BUILDING must stay above W_FLOOR for a reason beyond taste: a building
# change never ALSO counts as a floor change (two houses' floors are not
# comparable), so were it cheaper, the solver would dodge a staircase by
# sending people across the yard instead.
W_ROOM = 1
W_FLOOR = 4
W_BUILDING = 12

# The largest model this module will build, in CP-SAT variables: the
# generator's own budget (SchedulerSolver.MAX_MODEL_COMPLEXITY), for the same
# reason. The time limit bounds Solve() and nothing before it, and the build
# here is plain Python whose size is every step a walker takes times the rooms
# both ends of it could share — it grows roughly with the square of the school.
# A thousand lessons in sixty rooms, the school this is for, is under 200,000;
# the wire's upper range (5,000 lessons, hundreds of rooms) is several million,
# which spent the route's whole ceiling building, answered 503, and then kept
# a worker thread building and solving for nobody, because a thread cannot be
# cancelled. Refused up front instead, with the generator's own sentence.
MAX_MODEL_VARIABLES = 1_000_000


# ---------------------------------------------------------------------------
# When two lessons can meet: the gateway's rule, mirrored.
# ---------------------------------------------------------------------------


class WeekWindow(Protocol):
    recurrence: str | None
    start_date: date | None
    end_date: date | None


class _Weeks(NamedTuple):
    """A lesson's week window as a hashable key: lessons sharing one are alike."""

    recurrence: str
    start_date: date | None
    end_date: date | None


def weeks_can_overlap(a: WeekWindow, b: WeekWindow) -> bool:
    """Whether two weekly templates can ever fall in the same week.

    A line-for-line mirror of weeksCanOverlap in src/calendar/lesson-recurrence.ts,
    and it must stay one: the gateway's grid flags a room clash by that rule and
    the gateway re-checks every applied proposal with it. Read a clash more
    loosely here and the proposal puts two classes in one room that the grid
    then flags; read it more strictly and a swap the grid allows is refused.
    Both sides replay src/calendar/__fixtures__/recurrence-cases.json.

    Opposed parities never meet, periods that do not overlap never meet, and
    everything else is assumed to meet — deliberately not week-exact, because
    "unsure" must land on the side of calling it a clash.
    """
    first = a.recurrence or "ALL_WEEKS"
    second = b.recurrence or "ALL_WEEKS"
    if {first, second} == {"ODD_WEEKS", "EVEN_WEEKS"}:
        return False
    if a.end_date is not None and b.start_date is not None and a.end_date < b.start_date:
        return False
    return not (
        b.end_date is not None and a.start_date is not None and b.end_date < a.start_date
    )


def _clock_minutes(value: str) -> int:
    # Minutes, not grid slots. There is no grid here: a lesson a school placed by
    # hand at 08:05 is where it is, and rounding it to a slot would invent a
    # clash (or hide one) that the gateway's own check does not see.
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


# ---------------------------------------------------------------------------
# The problem, prepared in plain Python.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WalkPair:
    """One walker going from lesson ``first`` to lesson ``second``."""

    kind: WalkerKind
    walker_id: UUID
    first: int
    second: int


@dataclass
class RoomProblem:
    """Everything the model and the tallies read, computed once."""

    lessons: list[PlacedLesson]
    rooms: dict[UUID, WalkRoom]
    day: list[int]
    start: list[int]
    end: list[int]
    weeks: list[_Weeks]
    current: list[UUID | None]
    #: Movable lessons already sharing a room with a lesson they meet.
    frozen: set[int]
    #: Room choices per DECISION lesson (movable, not frozen, has a room). The
    #: current room comes first. Absent for every other lesson.
    domains: dict[int, tuple[UUID, ...]]
    pairs: list[WalkPair]
    movable_count: int
    #: (lesson index, WISH preference) for every wish that reaches the lesson.
    wishes: list[tuple[int, UUID, frozenset[UUID], int]] = field(default_factory=list)

    def clashes(self, first: int, second: int) -> bool:
        """Invariant 7: same day, half-open overlap, and weeks that can meet."""
        return (
            self.day[first] == self.day[second]
            and self.start[first] < self.end[second]
            and self.start[second] < self.end[first]
            and weeks_can_overlap(self.weeks[first], self.weeks[second])
        )

    def choices(self, index: int) -> tuple[UUID, ...]:
        """The rooms a lesson can end up in; one for anything that cannot move."""
        domain = self.domains.get(index)
        if domain is not None:
            return domain
        current = self.current[index]
        return (current,) if current is not None else ()


def prepare(request: OptimizeRoomsRequest, settings: Settings) -> RoomProblem:
    lessons = list(request.lessons)
    rooms = {room.id: room for room in request.rooms}
    count = len(lessons)
    day = [lesson.day_of_week for lesson in lessons]
    start = [_clock_minutes(lesson.start_time) for lesson in lessons]
    end = [_clock_minutes(lesson.end_time) for lesson in lessons]
    weeks = [
        _Weeks(lesson.recurrence, lesson.start_date, lesson.end_date) for lesson in lessons
    ]
    current = [lesson.room_id for lesson in lessons]

    problem = RoomProblem(
        lessons=lessons,
        rooms=rooms,
        day=day,
        start=start,
        end=end,
        weeks=weeks,
        current=current,
        frozen=set(),
        domains={},
        pairs=[],
        movable_count=sum(1 for lesson in lessons if lesson.movable),
    )

    # Who is in which room today, per day, for the clash scans below.
    in_room: dict[tuple[UUID, int], list[int]] = defaultdict(list)
    for index in range(count):
        if current[index] is not None:
            in_room[(current[index], day[index])].append(index)

    # FROZEN: a movable lesson that already meets another lesson in its own
    # room. Left alone rather than resolved, because a shared hall — two
    # classes in the aula for a joint assembly — may be exactly what the school
    # meant, and a proposal that "fixes" it would move a lesson nobody asked
    # to move. Treating it as fixed is also what keeps the current assignment
    # feasible: with the clash inside the model, the school's own timetable
    # would violate a room row and the whole optimisation would be refused.
    for members in in_room.values():
        for position, first in enumerate(members):
            for second in members[position + 1:]:
                if problem.clashes(first, second):
                    for index in (first, second):
                        if lessons[index].movable:
                            problem.frozen.add(index)

    decisions = [
        index
        for index in range(count)
        if lessons[index].movable
        and current[index] is not None
        and index not in problem.frozen
    ]
    # What a decision lesson may NOT move next to: every lesson that keeps its
    # room — locked or frozen. Decision lessons are handled by the room rows.
    occupied: dict[tuple[UUID, int], list[int]] = defaultdict(list)
    for index in range(count):
        if current[index] is not None and (
            not lessons[index].movable or index in problem.frozen
        ):
            occupied[(current[index], day[index])].append(index)

    # Undated UNAVAILABLE rows on a room. Dated rows are skipped for the reason
    # the generator skips them: a grundschema is a generic week, and one date
    # is not part of it. A missing day is every day, as the generator reads it.
    closed: dict[UUID, list[tuple[int | None, int, int]]] = defaultdict(list)
    for constraint in request.constraints:
        if (
            constraint.kind != "UNAVAILABLE"
            or constraint.date is not None
            or constraint.resource_kind != "ROOM"
        ):
            continue
        window_start = _clock_minutes(constraint.start_time)
        window_end = _clock_minutes(constraint.end_time)
        if window_end <= window_start:
            continue  # constrains nothing, as window_to_absolute_range reads it
        closed[constraint.resource_id].append(
            (constraint.day_of_week, window_start, window_end),
        )

    def blocked(room_id: UUID, index: int) -> bool:
        for window_day, window_start, window_end in closed.get(room_id, ()):
            if (
                window_day in (None, day[index])
                and window_start < end[index]
                and start[index] < window_end
            ):
                return True
        return any(
            problem.clashes(other, index)
            for other in occupied.get((room_id, day[index]), ())
        )

    # The generator's predicate and its profile key, handed out together by
    # _lock_aware for exactly this use: the key names every field the
    # predicate reads, locks included, so two lessons with one key are
    # eligible for the same rooms and the room scan runs once per profile.
    decision_lessons = [lessons[index] for index in decisions]
    allowed, profile_key = SchedulerSolver._lock_aware(
        resolve_room_locks(decision_lessons, request.room_preferences, request.rooms),
    )
    eligible_by_profile: dict[tuple, list[UUID]] = {}
    for index in decisions:
        lesson = lessons[index]
        key = profile_key(lesson)
        eligible = eligible_by_profile.get(key)
        if eligible is None:
            eligible = [room.id for room in request.rooms if allowed(room, lesson)]
            eligible_by_profile[key] = eligible
        here = current[index]
        assert here is not None
        # The current room is ALWAYS a choice, whatever it breaks today — a
        # lesson in a room too small for it is the school's decision to keep,
        # and dropping the room would make the timetable the school already
        # has infeasible in this model.
        problem.domains[index] = (here,) + tuple(
            room_id
            for room_id in eligible
            if room_id != here and not blocked(room_id, index)
        )

    problem.pairs = _consecutive_pairs(problem)
    problem.wishes = _wishes(problem, request, settings)
    return problem


def _walkers(lesson: PlacedLesson) -> list[tuple[WalkerKind, UUID]]:
    # Sets, so a lesson naming the same teacher twice (or its own group among
    # its extras) is one person walking, not two.
    teachers = {lesson.teacher_id, lesson.co_teacher_id} - {None}
    groups = {lesson.student_group_id, *lesson.extra_group_ids}
    return [("TEACHER", teacher) for teacher in teachers] + [
        ("GROUP", group) for group in groups
    ]


def _consecutive_pairs(problem: RoomProblem) -> list[WalkPair]:
    """Every walker's lesson-to-next-lesson steps, parity twins included.

    The successor is the walker's lesson that starts FIRST at or after this one
    ends, among those in weeks this one can meet. Every lesson sharing that
    earliest start pairs — an ODD and an EVEN lesson after the same one are both
    where this walker goes next, on alternate weeks. A lesson that overlaps
    this one is not a step at all, and a lesson with no room still counts as
    the successor: a teacher with a roomless lesson in between does not walk
    straight from the first to the third.
    """
    by_walker: dict[tuple[WalkerKind, UUID], list[int]] = defaultdict(list)
    for index, lesson in enumerate(problem.lessons):
        for walker in _walkers(lesson):
            by_walker[walker].append(index)

    pairs: list[WalkPair] = []
    for (kind, walker_id), members in by_walker.items():
        by_day: dict[int, list[int]] = defaultdict(list)
        for index in members:
            by_day[problem.day[index]].append(index)
        for same_day in by_day.values():
            for first in same_day:
                successors = [
                    second
                    for second in same_day
                    if second != first
                    and problem.start[second] >= problem.end[first]
                    and weeks_can_overlap(problem.weeks[first], problem.weeks[second])
                ]
                if not successors:
                    continue
                earliest = min(problem.start[second] for second in successors)
                pairs.extend(
                    WalkPair(kind, walker_id, first, second)
                    for second in successors
                    if problem.start[second] == earliest
                )
    return pairs


def _wishes(
    problem: RoomProblem,
    request: OptimizeRoomsRequest,
    settings: Settings,
) -> list[tuple[int, UUID, frozenset[UUID], int]]:
    """(lesson, preference, preferred rooms, weight) for every wish that reaches.

    Reached exactly as the generator reaches it — same subject, and
    _rule_reaches for a rule scoped to a stage — so a wish that steers a lesson
    into its lab when the week is generated keeps it there when rooms are
    re-dealt. Over EVERY lesson with a room, because the tally reports all of
    them; the model only builds the terms of lessons that can move.
    """
    by_subject: dict[UUID, list] = defaultdict(list)
    for preference in request.room_preferences:
        if preference.kind == "WISH":
            by_subject[preference.subject_id].append(preference)
    wishes: list[tuple[int, UUID, frozenset[UUID], int]] = []
    preferred_by_id: dict[UUID, frozenset[UUID]] = {}
    for index, lesson in enumerate(problem.lessons):
        if problem.current[index] is None:
            continue
        for preference in by_subject.get(lesson.subject_id, ()):
            if not _rule_reaches(preference, lesson):
                continue
            preferred = preferred_by_id.get(preference.id)
            if preferred is None:
                preferred = frozenset(_preference_room_ids(preference, request.rooms))
                preferred_by_id[preference.id] = preferred
            weight = preference.weight or settings.weight_room_preference
            wishes.append((index, preference.id, preferred, weight))
    return wishes


# ---------------------------------------------------------------------------
# Tallies: always plain Python over an assignment, never the objective.
# ---------------------------------------------------------------------------


def pair_walk(problem: RoomProblem, first: UUID | None, second: UUID | None) -> Walk:
    """What one step from room ``first`` to room ``second`` costs its walker."""
    if first is None or second is None or first == second:
        return Walk(room_changes=0, floor_changes=0, building_changes=0)
    here, there = problem.rooms[first], problem.rooms[second]
    if here.building != there.building:
        # Compared as values, None included: "Hus B" and no building are two
        # places. And never ALSO a floor change — plan 2 in one house says
        # nothing about plan 2 in another.
        return Walk(room_changes=1, floor_changes=0, building_changes=1)
    floor = int(
        here.floor is not None and there.floor is not None and here.floor != there.floor,
    )
    return Walk(room_changes=1, floor_changes=floor, building_changes=0)


def _cost(walk: Walk) -> int:
    return (
        W_ROOM * walk.room_changes
        + W_FLOOR * walk.floor_changes
        + W_BUILDING * walk.building_changes
    )


def _add(total: Walk, step: Walk) -> Walk:
    return Walk(
        room_changes=total.room_changes + step.room_changes,
        floor_changes=total.floor_changes + step.floor_changes,
        building_changes=total.building_changes + step.building_changes,
    )


_NO_WALK = Walk(room_changes=0, floor_changes=0, building_changes=0)


def walks_by_walker(
    problem: RoomProblem, assignment: list[UUID | None],
) -> dict[tuple[WalkerKind, UUID], Walk]:
    walks: dict[tuple[WalkerKind, UUID], Walk] = {}
    for pair in problem.pairs:
        key = (pair.kind, pair.walker_id)
        step = pair_walk(problem, assignment[pair.first], assignment[pair.second])
        walks[key] = _add(walks.get(key, _NO_WALK), step)
    return walks


def missed_wishes(problem: RoomProblem, assignment: list[UUID | None]) -> int:
    return sum(
        1
        for index, _preference, preferred, _weight in problem.wishes
        if assignment[index] not in preferred
    )


#: Which walkers' steps a request's `walkers` puts in the objective. Tallies
#: always report both kinds; only the objective and its Python check narrow.
_COUNTED: dict[str, frozenset[str]] = {
    "TEACHERS": frozenset({"TEACHER"}),
    "GROUPS": frozenset({"GROUP"}),
    "BOTH": frozenset({"TEACHER", "GROUP"}),
}


def score(
    problem: RoomProblem, assignment: list[UUID | None], scope: str,
) -> tuple[int, int]:
    """(primary, secondary) of an assignment, computed in Python.

    The same quantity the model minimises, plus constants the model drops —
    which cancel whenever two assignments of one problem are compared, and a
    comparison is the only thing this is used for.
    """
    counted = _COUNTED[scope]
    primary = sum(
        _cost(pair_walk(problem, assignment[pair.first], assignment[pair.second]))
        for pair in problem.pairs
        if pair.kind in counted
    )
    primary += sum(
        weight
        for index, _preference, preferred, weight in problem.wishes
        if assignment[index] not in preferred
    )
    secondary = sum(
        1 for index, room in enumerate(assignment) if room != problem.current[index]
    )
    return primary, secondary


def new_clashes(problem: RoomProblem, assignment: list[UUID | None]) -> list[tuple[int, int]]:
    """Room clashes the assignment has that the input did not."""
    in_room: dict[tuple[UUID, int], list[int]] = defaultdict(list)
    for index, room in enumerate(assignment):
        if room is not None:
            in_room[(room, problem.day[index])].append(index)
    found: list[tuple[int, int]] = []
    for (room, _day), members in in_room.items():
        for position, first in enumerate(members):
            for second in members[position + 1:]:
                if not problem.clashes(first, second):
                    continue
                already = problem.current[first] == room and problem.current[second] == room
                if not already:
                    found.append((first, second))
    return found


# ---------------------------------------------------------------------------
# The model.
# ---------------------------------------------------------------------------


def _maximal_cliques(
    nodes: list[Hashable], adjacent: Callable[[Hashable, Hashable], bool],
) -> list[list[Hashable]]:
    """Bron–Kerbosch with a pivot. Nodes here are week windows at one instant —
    a handful at most (a parity or two, a term or two) — so brute force is fine."""
    neighbours = {
        node: {other for other in nodes if other != node and adjacent(node, other)}
        for node in nodes
    }
    cliques: list[list[Hashable]] = []

    def expand(chosen: list[Hashable], candidates: set, excluded: set) -> None:
        if not candidates and not excluded:
            cliques.append(chosen)
            return
        pivot = max(candidates | excluded, key=lambda node: len(neighbours[node] & candidates))
        for node in list(candidates - neighbours[pivot]):
            expand(chosen + [node], candidates & neighbours[node], excluded & neighbours[node])
            candidates.discard(node)
            excluded.add(node)

    expand([], set(nodes), set())
    return cliques


@dataclass
class RoomModel:
    model: cp_model.CpModel
    #: (decision lesson index, room id) -> literal
    x: dict[tuple[int, UUID], cp_model.IntVar]


def _both(model: cp_model.CpModel, first: object, second: object) -> object:
    """A term that can be 1 only when both sides are — at most min(first, second).

    Only an upper bound: every place this is used rewards it for being high,
    so at the optimum it equals the product. Constants short-cut, which keeps
    a pair with one fixed side down to a single literal and no new variable.
    """
    if isinstance(first, int):
        return second if first == 1 else 0
    if isinstance(second, int):
        return first if second == 1 else 0
    share = model.NewBoolVar("")
    model.Add(share <= first)
    model.Add(share <= second)
    return share


def _steered_steps(problem: RoomProblem, scope: str) -> list[tuple[tuple[int, int], int]]:
    """Each step the objective can steer, with how many counted walkers take it.

    A step shared by several walkers (a lead and a co-teacher, a class and the
    teaching group inside it) is linearised once and weighted by how many walk
    it: two people walking is twice the walking. build_model and
    estimate_model_size both read this list, so the refusal and the build can
    never disagree about which steps exist.
    """
    multiplicity: dict[tuple[int, int], int] = defaultdict(int)
    for pair in problem.pairs:
        if pair.kind in _COUNTED[scope]:
            multiplicity[(pair.first, pair.second)] += 1

    steered: list[tuple[tuple[int, int], int]] = []
    for (first, second), walkers in sorted(multiplicity.items()):
        first_rooms, second_rooms = problem.choices(first), problem.choices(second)
        if not first_rooms or not second_rooms:
            continue  # a lesson with no room costs nothing
        if len(first_rooms) == 1 and len(second_rooms) == 1:
            continue  # constant: the tally counts it, the model has nothing to steer
        steered.append(((first, second), walkers))
    return steered


def build_model(problem: RoomProblem, scope: str) -> RoomModel:
    model = cp_model.CpModel()
    x: dict[tuple[int, UUID], cp_model.IntVar] = {}
    for index, domain in problem.domains.items():
        literals = []
        for room_id in domain:
            literal = model.NewBoolVar(f"x_{index}_{room_id}")
            x[(index, room_id)] = literal
            literals.append(literal)
            # The school's own rooms, which are feasible by construction —
            # the search starts from something valid and only has to improve.
            model.AddHint(literal, 1 if room_id == problem.current[index] else 0)
        model.AddExactlyOne(literals)

    def lit(index: int, room_id: UUID) -> object:
        if index in problem.domains:
            return x.get((index, room_id), 0)
        return 1 if problem.current[index] == room_id else 0

    _add_room_rows(problem, model, x)

    primary: list[object] = []
    for (first, second), walkers in _steered_steps(problem, scope):
        for weight, change in _step_changes(problem, model, lit, first, second):
            primary.append(weight * walkers * change)

    for index, _preference, preferred, weight in problem.wishes:
        domain = problem.domains.get(index)
        if domain is None:
            continue
        satisfied = [x[(index, room_id)] for room_id in domain if room_id in preferred]
        if not satisfied or len(satisfied) == len(domain):
            continue  # impossible or unavoidable: a constant, as in the generator
        primary.append(weight * (1 - sum(satisfied)))

    secondary = [
        1 - x[(index, problem.current[index])]
        for index in problem.domains
    ]
    # Lexicographic: one unit of walking outweighs moving every movable lesson,
    # so a lesson moves only when moving it pays — the proposal a school reads
    # is the smallest one that achieves the least walking.
    model.Minimize(sum(primary) * (problem.movable_count + 1) + sum(secondary))
    return RoomModel(model=model, x=x)


def _add_room_rows(
    problem: RoomProblem,
    model: cp_model.CpModel,
    x: dict[tuple[int, UUID], cp_model.IntVar],
) -> None:
    """At most one lesson per room at any instant, among lessons that can meet.

    Sound and complete because time intervals form an interval graph: two
    lessons that overlap in time both cover the later one's start, so checking
    every start is checking every overlap. At one instant the lessons covering
    it all overlap in time, and whether they clash is then down to their weeks
    alone — so the rows are the maximal cliques of the week windows under
    weeks_can_overlap. An ALL_WEEKS lesson meets both an ODD and an EVEN one,
    which do not meet each other: two rows, {ALL, ODD} and {ALL, EVEN}, and the
    parity twins may share the room.

    Lessons that keep their room (locked, frozen) are not in these rows: they
    were taken out of every domain that would clash with them.
    """
    by_room_day: dict[tuple[UUID, int], list[int]] = defaultdict(list)
    for index, domain in problem.domains.items():
        for room_id in domain:
            by_room_day[(room_id, problem.day[index])].append(index)

    def window_key(index: int) -> tuple[_Weeks, int | None]:
        weeks = problem.weeks[index]
        # A window that cannot meet ITSELF (a period ending before it starts)
        # gets a key of its own, so two lessons sharing it are not wrongly put
        # in one row. weeksCanOverlap says they never meet; so must this.
        return (weeks, None) if weeks_can_overlap(weeks, weeks) else (weeks, index)

    def adjacent(first: Hashable, second: Hashable) -> bool:
        return weeks_can_overlap(first[0], second[0])

    for (room_id, _day), members in by_room_day.items():
        if len(members) < 2:
            continue
        rows: set[frozenset[int]] = set()
        for instant in sorted({problem.start[index] for index in members}):
            active = [
                index
                for index in members
                if problem.start[index] <= instant < problem.end[index]
            ]
            if len(active) < 2:
                continue
            by_window: dict[Hashable, list[int]] = defaultdict(list)
            for index in active:
                by_window[window_key(index)].append(index)
            for clique in _maximal_cliques(list(by_window), adjacent):
                row = frozenset(index for key in clique for index in by_window[key])
                if len(row) > 1:
                    rows.add(row)
        for row in sorted(rows, key=sorted):
            model.Add(sum(x[(index, room_id)] for index in row) <= 1)


def _step_changes(
    problem: RoomProblem,
    model: cp_model.CpModel,
    lit: Callable[[int, UUID], object],
    first: int,
    second: int,
) -> Iterable[tuple[int, object]]:
    """(weight, change literal) for a step that is not constant.

    Each change is a 0..1 variable bounded BELOW by what the rooms imply, with a
    positive cost, so at the optimum it equals the true value. Terms that can
    only be one value are left out rather than modelled.
    """
    first_rooms, second_rooms = problem.choices(first), problem.choices(second)
    rooms = problem.rooms

    # Room: changed unless both lie in one common room.
    reachable = set(second_rooms)
    common = [room_id for room_id in first_rooms if room_id in reachable]
    if common:
        change = model.NewBoolVar("")
        model.Add(
            change >= 1 - sum(_both(model, lit(first, r), lit(second, r)) for r in common),
        )
        yield W_ROOM, change

    def by(key: Callable[[WalkRoom], Hashable | None], index: int, domain: tuple[UUID, ...]):
        grouped: dict[Hashable, list[object]] = defaultdict(list)
        for room_id in domain:
            value = key(rooms[room_id])
            if value is not None:
                grouped[value].append(lit(index, room_id))
        return {value: sum(literals) for value, literals in grouped.items()}

    # Building: None is a value here, so wrap it to survive the None filter.
    first_buildings = by(lambda room: (room.building,), first, first_rooms)
    second_buildings = by(lambda room: (room.building,), second, second_rooms)
    if len(set(first_buildings) | set(second_buildings)) > 1:
        shared = [value for value in first_buildings if value in second_buildings]
        if shared:
            change = model.NewBoolVar("")
            model.Add(
                change
                >= 1 - sum(
                    _both(model, first_buildings[value], second_buildings[value])
                    for value in shared
                ),
            )
            yield W_BUILDING, change

    # Floor: only inside one building, and only between known floors. kb says
    # "both are in building B on a known floor", sz says "both on floor z of B";
    # the change is forced exactly when some kb holds and no sz does.
    def zone(room: WalkRoom) -> Hashable | None:
        return None if room.floor is None else (room.building, room.floor)

    first_zones = by(zone, first, first_rooms)
    second_zones = by(zone, second, second_rooms)
    floors_in: dict[Hashable, set[int]] = defaultdict(set)
    for building, floor in [*first_zones, *second_zones]:
        floors_in[building].add(floor)
    buildings = [
        building
        for building in floors_in
        if len(floors_in[building]) > 1
        and any(value[0] == building for value in first_zones)
        and any(value[0] == building for value in second_zones)
    ]
    if buildings:
        change = model.NewBoolVar("")
        together: list[object] = []
        for building in buildings:
            first_known = sum(v for k, v in first_zones.items() if k[0] == building)
            second_known = sum(v for k, v in second_zones.items() if k[0] == building)
            if isinstance(first_known, int) and isinstance(second_known, int):
                together.append(max(0, first_known + second_known - 1))
                continue
            both_known = model.NewBoolVar("")
            model.Add(both_known >= first_known + second_known - 1)
            together.append(both_known)
        same_floor = [
            _both(model, first_zones[value], second_zones[value])
            for value in first_zones
            if value in second_zones and value[0] in buildings
        ]
        model.Add(change >= sum(together) - sum(same_floor))
        yield W_FLOOR, change


def estimate_model_size(problem: RoomProblem, scope: str) -> int:
    """How many variables build_model would create, counted without building.

    Term for term what the builders make: one literal per (decision lesson,
    room choice), and for every steered step one change variable per kind of
    change that can go either way, plus what _both and the floor block add.
    Those extras exist only where both ends are decisions — a lesson that
    keeps its room is a constant there, and _both short-cuts it — and it is
    that term, the rooms and buildings two decisions could share, that grows
    with the square of the school. Set arithmetic here, so counting costs a
    small fraction of building. tests/test_room_walks.py pins the two equal:
    a builder that grows a variable has to grow this too, or the refusal
    stops describing the model it refuses.
    """
    rooms = problem.rooms
    count = sum(len(domain) for domain in problem.domains.values())

    # Per lesson once, not per step: a lesson ends a step and starts the next.
    places: dict[int, tuple[set[UUID], set[Hashable], set[Hashable], set[Hashable]]] = {}

    def where(index: int) -> tuple[set[UUID], set[Hashable], set[Hashable], set[Hashable]]:
        found = places.get(index)
        if found is None:
            choices = problem.choices(index)
            zones = {
                (rooms[room_id].building, rooms[room_id].floor)
                for room_id in choices
                if rooms[room_id].floor is not None
            }
            found = (
                set(choices),
                {(rooms[room_id].building,) for room_id in choices},
                zones,
                {building for building, _floor in zones},
            )
            places[index] = found
        return found

    for (first, second), _walkers in _steered_steps(problem, scope):
        both_decide = first in problem.domains and second in problem.domains
        first_rooms, first_buildings, first_zones, first_known = where(first)
        second_rooms, second_buildings, second_zones, second_known = where(second)

        common = len(first_rooms & second_rooms)
        if common:
            count += 1 + (common if both_decide else 0)

        if len(first_buildings | second_buildings) > 1:
            shared = len(first_buildings & second_buildings)
            if shared:
                count += 1 + (shared if both_decide else 0)

        floors_in: dict[Hashable, set[int]] = defaultdict(set)
        for building, floor in first_zones | second_zones:
            floors_in[building].add(floor)
        buildings = {
            building
            for building in first_known & second_known
            if len(floors_in[building]) > 1
        }
        if buildings:
            # One "both on a known floor" literal per building: a steered step
            # has a decision at one end at least, so its sum is never constant.
            count += 1 + len(buildings)
            if both_decide:
                count += sum(
                    1 for zone in first_zones & second_zones if zone[0] in buildings
                )
    return count


# ---------------------------------------------------------------------------
# The solve.
# ---------------------------------------------------------------------------


class RoomWalkSolver:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def solve(self, request: OptimizeRoomsRequest) -> OptimizeRoomsResponse:
        problem = prepare(request, self._settings)
        before = list(problem.current)
        after, status = self._search(problem, request)
        return self._response(problem, request, before, after, status)

    def _search(
        self, problem: RoomProblem, request: OptimizeRoomsRequest,
    ) -> tuple[list[UUID | None], str]:
        unchanged = list(problem.current)
        if not any(len(domain) > 1 for domain in problem.domains.values()):
            return unchanged, "FEASIBLE"  # nothing can move, so nothing to search

        # Before the build, not after it: the build is what cannot be stopped.
        size = estimate_model_size(problem, request.walkers)
        if size > MAX_MODEL_VARIABLES:
            raise InvalidScheduleInputError.of("ROOM_MODEL_TOO_LARGE", {
                "variables": size, "limit": MAX_MODEL_VARIABLES,
            })

        built = build_model(problem, request.walkers)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self._settings.room_solver_max_time_seconds
        code = solver.Solve(built.model)

        # Either is a bug in this module, never a property of the school's
        # data: the school's own rooms satisfy every row by construction, so a
        # model that refuses them has been built wrong.
        if code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the room model: {built.model.Validate()}"
            raise SolverBuildError(msg)
        if code == cp_model.INFEASIBLE:
            msg = "The room model refused the school's current rooms; it was built wrong."
            raise SolverBuildError(msg)
        if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            logger.info("room_walks_no_solution request_id=%s", request.request_id)
            return unchanged, "FEASIBLE"

        candidate = list(problem.current)
        for (index, room_id), literal in built.x.items():
            if solver.Value(literal):
                candidate[index] = room_id

        # Checked in Python, not taken on the model's word. A clash the input
        # did not have would be a model bug, and sending it on would put two
        # classes in one room — so it is loud. Domains need no such check: the
        # only literals that exist are the domain's.
        clashes = new_clashes(problem, candidate)
        if clashes:
            first, second = clashes[0]
            msg = (
                f"The room model double-booked lessons {problem.lessons[first].id} "
                f"and {problem.lessons[second].id}."
            )
            raise SolverBuildError(msg)

        if score(problem, candidate, request.walkers) < score(problem, unchanged, request.walkers):
            return candidate, "OPTIMAL" if code == cp_model.OPTIMAL else "FEASIBLE"
        return unchanged, "FEASIBLE"

    @staticmethod
    def _response(
        problem: RoomProblem,
        request: OptimizeRoomsRequest,
        before: list[UUID | None],
        after: list[UUID | None],
        status: str,
    ) -> OptimizeRoomsResponse:
        walks_before = walks_by_walker(problem, before)
        walks_after = walks_by_walker(problem, after)

        def total(walks: dict[tuple[WalkerKind, UUID], Walk], kind: str) -> Walk:
            result = _NO_WALK
            for (walker_kind, _id), walk in walks.items():
                if walker_kind == kind:
                    result = _add(result, walk)
            return result

        # Both maps come from the same pairs, so they share their keys.
        changed_walkers = [
            WalkerWalk(kind=kind, id=walker_id, before=walk, after=walks_after[(kind, walker_id)])
            for (kind, walker_id), walk in walks_before.items()
            if walk != walks_after[(kind, walker_id)]
        ]
        # Most improved first: the dialog names the few people this helps most.
        changed_walkers.sort(
            key=lambda walker: (
                _cost(walker.after) - _cost(walker.before), walker.kind, str(walker.id),
            ),
        )

        return OptimizeRoomsResponse(
            request_id=request.request_id,
            status=status,
            changes=[
                RoomChange(lesson_id=problem.lessons[index].id, room_id=room)
                for index, room in enumerate(after)
                if room != before[index]
            ],
            teachers=WalkComparison(
                before=total(walks_before, "TEACHER"), after=total(walks_after, "TEACHER"),
            ),
            groups=WalkComparison(
                before=total(walks_before, "GROUP"), after=total(walks_after, "GROUP"),
            ),
            missed_wishes=CountComparison(
                before=missed_wishes(problem, before), after=missed_wishes(problem, after),
            ),
            walkers=changed_walkers,
            frozen_lesson_ids=[
                lesson.id
                for index, lesson in enumerate(problem.lessons)
                if index in problem.frozen
            ],
        )
