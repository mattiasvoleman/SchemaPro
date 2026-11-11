"""Placeringsregler: three rules a school sets about where its lessons may stand.

Each rule is the school's, off until it asks, and soft or hard as it chooses
(the engine builds all six; the gateway offers rule 1 only off or soft until a
hard one has been measured, 4.5 times the first timetable with eight workers):

    1. NOT FIRST OR LAST IN THE DAY, per subject, on the class's day
       (`add_subject_edges`): idrott never opens or closes 7A's day.
    2. AT MOST N DIFFERENT ROOMS AND M DIFFERENT BUILDINGS A DAY, for a class
       and for a teacher (`add_place_limits`): places visited, not changes.
    3. THE PUPILS TOGETHER FIT A SHARED ROOM (`shared_capacity`, used by
       room_allocator.add_room_allocation): a room the school has marked
       shareable holds several lessons at once while their pupils sum to its
       capacity.

SOFT pays WEIGHT in the full model's objective and builds nothing in the
satisfaction phase, so a school's wishes cannot make its timetable harder to
find (the free-day wish's way, and sammanhängande undervisning's after a hard
rule was measured and fell: app/solver/consecutive.py). HARD is a constraint
in both phases under a named assumption literal, so a week that cannot keep it
is refused by name; the pre-flight (`refusals`) answers what arithmetic can
before any model is built.

ALL OF IT IS ABSENT UNLESS ASKED FOR. A request without `placementRules` calls
nothing in this module, and a rule that is off is left out of it by the
gateway, so the model of a school that has set none is main's, constraint for
constraint (benchmarks/model_identity.py measures it).

Every rule is its own function with its own arguments, and none reads the
others: a mode that lets a hard rule give way (G2, Bästa möjliga schema) names
the function it relaxes.

The builders take plain records and callables rather than the solver, as
consecutive.py does, so this module never imports scheduler_solver.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from ortools.sat.python import cp_model

from app.solver.weeks import Weeks, each_week, meet


@dataclass(frozen=True)
class EdgeLesson:
    """A generated lesson as the edge rule sees it."""

    key: str
    #: The solver's LessonDecision, opaque here: `start`, `end` and the
    #: callables below are all this module reads off it.
    decision: Any
    requirement_id: UUID
    subject_id: UUID
    #: The key of the lesson's pupils (scheduler_solver.pupil_key_of).
    pupil_key: UUID
    parity: Weeks | None


@dataclass(frozen=True)
class EdgeLock:
    """A locked lesson as the edge rule sees it: a window on one day."""

    #: Absolute slots, [start, end), inside one day of the grid.
    start: int
    end: int
    pupil_keys: tuple[UUID, ...]
    parity: Weeks | None


def classes_of(
    pupil_key: UUID, classes: Iterable[UUID], partners: dict[UUID, set[UUID]],
) -> list[UUID]:
    """The home classes whose day a lesson of these pupils is part of.

    A class, and any group that shares pupils with it, sits in the class's
    day: that is THE UNION READING, and it is exact for the usual school (a
    språkval block covers the whole year, so every pupil has a lesson at the
    block's hour) and lenient for a group that only some pupils attend, where
    "someone in the class has an earlier lesson" stands in for "everyone
    does". Lenient is the safe side of a hard rule: it never refuses a week
    that would have worked.

    A lesson that is no class's, a teaching group paired with none, is its own
    class, so the rule still says something about it.
    """
    owners = [
        class_id
        for class_id in classes
        if class_id == pupil_key or class_id in partners.get(pupil_key, ())
    ]
    return owners or [pupil_key]


def add_subject_edges(
    model: cp_model.CpModel,
    *,
    slots_per_day: int,
    lessons: list[EdgeLesson],
    locks: list[EdgeLock],
    classes: list[UUID],
    partners: dict[UUID, set[UUID]],
    flagged: dict[UUID, tuple[bool, bool]],
    day_of: Callable[[Any], cp_model.IntVar],
    days_of: Callable[[Any], frozenset[int]],
    assume: Callable[[EdgeLesson, str], cp_model.IntVar] | None,
    weight: int,
) -> list[cp_model.LinearExpr]:
    """Placeringsregel 1: a flagged subject's lesson is not first or last in the class's day.

    FIRST means no lesson of the class's day starts earlier on the same day,
    LAST that none ends later: a lesson that starts together with another, a
    parallel block's, is first beside it. The class's day is every lesson its
    pupils sit, generated or locked (`classes_of`).

    ONE ROW PER LESSON, CLASS AND WEEK it runs in: "some lesson of the class
    is on the same day and earlier" is an OR over the class's other lessons of
    one literal each (`b_{m,l}` implies same day and m before l), and the row
    asks for one of them. The literal only needs its one direction: it is
    asked to be true, never to say it is false. A lock is a constant window,
    so its literal is two bounds on the lesson's own start.

    A/B-VECKOR: the row is cut by the weeks the lesson runs in (every week it
    is two rows, odd and even) and each week's row reads the lessons that meet
    that week, so slöjd udda veckor does not open the day for a class whose
    even week has nothing before idrotten.

    TERMINER, for the same reason: one row per week the lesson runs in that
    the class's lessons and locks tell apart, each reading that week's own.
    NOT IMPLIED (app/solver/weeks.py) — the autumn's slöjd does not open the
    day in the spring — so every such week has its row and no two are joined.

    HARD (`assume` given) posts the OR under the assumption of the lesson's
    requirement and edge, in both model phases; a lesson with no possible
    predecessor makes the assumption false, which is the refusal. SOFT
    (`assume` None) pays `weight` for each row left unmet, in the full model
    only; a row nothing can meet is a constant and adds no term.
    """
    members: dict[UUID, list[EdgeLesson]] = defaultdict(list)
    member_locks: dict[UUID, list[EdgeLock]] = defaultdict(list)
    for lesson in lessons:
        for class_id in classes_of(lesson.pupil_key, classes, partners):
            members[class_id].append(lesson)
    for lock in locks:
        for pupil_key in lock.pupil_keys:
            for class_id in classes_of(pupil_key, classes, partners):
                if lock not in member_locks[class_id]:
                    member_locks[class_id].append(lock)

    cache: dict[tuple[str, str, str], cp_model.IntVar | None] = {}

    def lesson_literal(other: EdgeLesson, lesson: EdgeLesson, edge: str) -> cp_model.IntVar | None:
        """`other` is on `lesson`'s day and starts before it / ends after it."""
        cache_key = (other.key, lesson.key, edge)
        if cache_key in cache:
            return cache[cache_key]
        literal: cp_model.IntVar | None = None
        if days_of(other.decision) & days_of(lesson.decision):
            literal = model.NewBoolVar(f"edge_{edge}_{other.key}_{lesson.key}")
            model.Add(day_of(other.decision) == day_of(lesson.decision)).OnlyEnforceIf(literal)
            if edge == "FIRST":
                model.Add(other.decision.start + 1 <= lesson.decision.start).OnlyEnforceIf(literal)
            else:
                model.Add(other.decision.end >= lesson.decision.end + 1).OnlyEnforceIf(literal)
        cache[cache_key] = literal
        return literal

    def lock_literal(lock: EdgeLock, lesson: EdgeLesson, edge: str) -> cp_model.IntVar | None:
        lock_day = lock.start // slots_per_day
        if lock_day not in days_of(lesson.decision):
            return None
        literal = model.NewBoolVar(f"edge_{edge}_lock{lock.start}_{lesson.key}")
        day_first = lock_day * slots_per_day
        day_last = day_first + slots_per_day - 1
        if edge == "FIRST":
            model.Add(lesson.decision.start >= lock.start + 1).OnlyEnforceIf(literal)
            model.Add(lesson.decision.start <= day_last).OnlyEnforceIf(literal)
        else:
            model.Add(lesson.decision.end <= lock.end - 1).OnlyEnforceIf(literal)
            model.Add(lesson.decision.start >= day_first).OnlyEnforceIf(literal)
        return literal

    penalties: list[cp_model.LinearExpr] = []
    for lesson in lessons:
        wanted = flagged.get(lesson.subject_id)
        if wanted is None:
            continue
        for edge, asked in (("FIRST", wanted[0]), ("LAST", wanted[1])):
            if not asked:
                continue
            seen_rows: set[tuple[Hashable, ...]] = set()
            for class_id in classes_of(lesson.pupil_key, classes, partners):
                others = [other for other in members[class_id] if other is not lesson]
                class_locks = member_locks.get(class_id, [])
                # The weeks the class's day differs in, and of them the ones
                # this lesson runs in: (None,) for a class of every week.
                weeks = each_week([
                    lesson.parity,
                    *(other.parity for other in others),
                    *(lock.parity for lock in class_locks),
                ])
                for week in (week for week in weeks if meet(lesson.parity, week)):
                    options: list[cp_model.IntVar] = []
                    for other in others:
                        if week is not None and not meet(other.parity, week):
                            continue
                        literal = lesson_literal(other, lesson, edge)
                        if literal is not None:
                            options.append(literal)
                    for lock in class_locks:
                        if week is not None and not meet(lock.parity, week):
                            continue
                        literal = lock_literal(lock, lesson, edge)
                        if literal is not None:
                            options.append(literal)
                    # The same row twice (a lesson in two classes whose days
                    # hold the same other lessons) is one row.
                    row = (week, tuple(sorted(option.Index() for option in options)))
                    if row in seen_rows:
                        continue
                    seen_rows.add(row)
                    if assume is not None:
                        # Posted whatever the options: none left is the
                        # assumption false, which is what names the rule.
                        assumption = assume(lesson, edge)
                        model.AddBoolOr([*options, assumption.Not()])
                    elif options:
                        unmet = model.NewBoolVar(f"edge_unmet_{edge}_{lesson.key}")
                        model.AddBoolOr([*options, unmet])
                        penalties.append(unmet * weight)
    return penalties


@dataclass(frozen=True)
class PlaceLesson:
    """A generated lesson as the place limits see it."""

    key: str
    decision: Any
    parity: Weeks | None
    pupil_key: UUID
    teachers: tuple[UUID, ...]
    #: Where the lesson can stand, by kind ("room", "building"): each place
    #: and the literals of which any one puts the lesson there; `(None,)` is
    #: a lesson that stands there whatever happens (its room group is forced).
    places: dict[str, dict[Hashable, tuple[cp_model.IntVar | None, ...]]]


@dataclass(frozen=True)
class PlaceLock:
    """A locked lesson in a room, as the place limits see it."""

    day: int
    parity: Weeks | None
    pupil_keys: tuple[UUID, ...]
    teachers: tuple[UUID, ...]
    #: The place the lock stands in, by kind. A lock in no room stands nowhere:
    #: an unknown place is never counted, as an unknown floor never is.
    places: dict[str, Hashable]


def add_place_limits(
    model: cp_model.CpModel,
    *,
    lessons: list[PlaceLesson],
    locks: list[PlaceLock],
    limits: dict[tuple[str, str], int],
    on: Callable[[Any, int], cp_model.IntVar],
    days_of: Callable[[Any], frozenset[int]],
    assume: Callable[[str, str], cp_model.IntVar] | None,
    weight: int,
) -> list[cp_model.LinearExpr]:
    """Placeringsregel 2: at most N different room groups and M different buildings a day.

    `limits` maps (party, kind) to the number, party "class" or "teacher" and
    kind "room" or "building"; a pair left out has no limit.

    WHAT IS COUNTED, and the whole of the definition. On one day of one real
    week a party stands in the places of its lessons, generated and locked, and
    the rule says there are at most `limit` DIFFERENT ones. It does not count
    changes between neighbouring lessons: a day that goes A, B, A is two places
    and so is A, B, A, B, which is three changes. That is the price of a count
    that needs no order of the lessons (no successor variable, no pair literal,
    no occupancy per slot), and it is measured rather than assumed:
    benchmarks/placement_rules.py counts on the timetables it makes how many
    party-days a school counting changes would find over its limit while the
    model holds none over its count of places. The exact count was priced too,
    and fell: it takes a literal per lesson, start step and party, five times
    the model. So the rule says what it holds, "at most N different", and the
    settings say so.

    A ROOM IS A ROOM GROUP, the engine's interchangeability class: two equal
    classrooms are one room here, which is what the model can see. The
    post-pass keeps a party in the room it had when that room is free
    (RoomPlan.parties), and Salsoptimering evens out the rest. A BUILDING is
    Room.building as the salsoptimering reads it, none being a value of its
    own.

    A CLASS IS A GROUP: the lessons filed under one pupil key, its own and
    nobody else's. A pupil in 7A and in a språkval group changes rooms
    between the two; counting that would count a whole parallel block's rooms
    against the class, so it is left out, and the limit is lenient for a
    class whose pupils walk to teaching groups. A TEACHER is every lesson
    they are on, lead or co-teacher.

    A party that cannot exceed its limit builds nothing: one with at most
    `limit` lessons, or whose lessons can stand in at most `limit` places in
    all. A school with one building therefore builds no building row.

    HARD (`assume` given) bounds the day's places by the limit under the
    assumption of the party and kind; SOFT pays `weight` for each place beyond
    it, in the full model only.
    """
    penalties: list[cp_model.LinearExpr] = []
    for party in ("class", "teacher"):
        for kind in ("room", "building"):
            limit = limits.get((party, kind))
            if limit is None:
                continue
            members: dict[UUID, list[PlaceLesson]] = defaultdict(list)
            held: dict[UUID, list[PlaceLock]] = defaultdict(list)
            for lesson in lessons:
                owners = (lesson.pupil_key,) if party == "class" else lesson.teachers
                for owner in dict.fromkeys(owners):
                    members[owner].append(lesson)
            for lock in locks:
                owners = lock.pupil_keys if party == "class" else lock.teachers
                for owner in dict.fromkeys(owners):
                    held[owner].append(lock)
            # Registered when a row first needs it: a limit nothing can break
            # builds no literal, and the model is the one it was.
            assumption = (lambda party=party, kind=kind: assume(party, kind)) if assume is not None else None
            for owner, group in members.items():
                penalties.extend(
                    _bound_places(
                        model, owner=owner, party=party, kind=kind, limit=limit,
                        lessons=group, locks=held.get(owner, []),
                        on=on, days_of=days_of, assumption=assumption, weight=weight,
                    ),
                )
    return penalties


def _bound_places(
    model: cp_model.CpModel,
    *,
    owner: UUID,
    party: str,
    kind: str,
    limit: int,
    lessons: list[PlaceLesson],
    locks: list[PlaceLock],
    on: Callable[[Any, int], cp_model.IntVar],
    days_of: Callable[[Any], frozenset[int]],
    assumption: Callable[[], cp_model.IntVar] | None,
    weight: int,
) -> list[cp_model.LinearExpr]:
    """One party's rows for one kind: its places a day, bounded, week by week."""
    allowed = limit
    if len(lessons) + len(locks) <= allowed:
        return []
    every_place: set[Hashable] = {
        place for lesson in lessons for place in lesson.places.get(kind, {})
    }
    every_place.update(lock.places[kind] for lock in locks if kind in lock.places)
    if len(every_place) <= allowed:
        return []

    penalties: list[cp_model.LinearExpr] = []
    # Implied (app/solver/weeks.py): a lesson fewer is no place more. One
    # class's or teacher's lessons, so every week they tell apart has its row.
    for week in each_week(
        [*(lesson.parity for lesson in lessons), *(lock.parity for lock in locks)],
    ):
        in_week = [
            lesson for lesson in lessons if week is None or meet(lesson.parity, week)
        ]
        locks_in_week = [lock for lock in locks if week is None or meet(lock.parity, week)]
        used: dict[tuple[int, Hashable], cp_model.IntVar] = {}

        def place_used(day: int, place: Hashable, *, owner: UUID = owner,
                       week: Weeks | None = week,
                       used: dict[tuple[int, Hashable], cp_model.IntVar] = used) -> cp_model.IntVar:
            literal = used.get((day, place))
            if literal is None:
                literal = model.NewBoolVar(f"places_{party}_{kind}_{owner}_{week}_{day}_{len(used)}")
                used[(day, place)] = literal
            return literal

        for lesson in in_week:
            for day in sorted(days_of(lesson.decision)):
                at = on(lesson.decision, day)
                for place, literals in lesson.places.get(kind, {}).items():
                    for literal in literals:
                        if literal is None:
                            model.AddImplication(at, place_used(day, place))
                        else:
                            model.AddBoolOr([at.Not(), literal.Not(), place_used(day, place)])
        for lock in locks_in_week:
            if kind in lock.places:
                model.Add(place_used(lock.day, lock.places[kind]) == 1)

        by_day: dict[int, list[cp_model.IntVar]] = defaultdict(list)
        for (day, _place), literal in used.items():
            by_day[day].append(literal)
        for day, literals in sorted(by_day.items()):
            if len(literals) <= allowed:
                continue
            if assumption is not None:
                model.Add(sum(literals) <= allowed).OnlyEnforceIf(assumption())
            else:
                beyond = model.NewIntVar(0, len(literals) - allowed, f"beyond_{party}_{kind}_{owner}_{day}")
                model.Add(beyond >= sum(literals) - allowed)
                penalties.append(beyond * weight)
    return penalties




@dataclass(frozen=True)
class SharedLock:
    """A locked lesson that takes seats in a shareable room, not the room."""

    #: Absolute slots, [start, end).
    start: int
    end: int
    #: Distinct pupils on the lock (FixedLesson.student_count).
    count: int
    parity: Weeks | None


@dataclass(frozen=True)
class SharedRoom:
    """A room the school lets several groups use at once, and what it holds."""

    capacity: int
    #: SOFT: the seats beyond the capacity the room may be asked for, paid per
    #: seat at the room's worst moment of the week. None is HARD.
    headroom: int | None
    locks: tuple[SharedLock, ...] = ()


def add_shared_capacity(
    model: cp_model.CpModel,
    *,
    entries: list[tuple[cp_model.IntervalVar, int, Weeks | None]],
    shared: SharedRoom,
    assume: Callable[[UUID], cp_model.IntVar] | None,
    name: str,
    room_id: UUID | None = None,
) -> cp_model.IntVar:
    """Placeringsregel 3: the lessons in a shared room never hold more pupils than it seats.

    One cumulative per real week, with the pupils of each lesson as its
    demand and the locks' pupils as fixed intervals beside them. THE CAPACITY
    IS A VARIABLE IN BOTH MODES, and that is the whole of the difference
    between them:

      HARD  pinned to the room's capacity by an assumption literal
            (`assume`), because a cumulative takes no enforcement literal and
            an assumption is what lets an infeasible week name the room. With
            assumptions off the literal is a unit clause and presolve folds
            the variable to the constant.
      SOFT  free between the capacity and `headroom` seats above it; the
            solver prices the seats above (`weight` per seat, by the caller)
            at the room's worst moment of the week and no more. The seats are
            a count of pupils, so the wish says "no more than 31 in the hall
            at 10:00" rather than "a lesson too many".

    The variable exists in the satisfaction phase too, free there, so the two
    builds stay structurally alike (solve hints one from the other).
    """
    headroom = shared.headroom if shared.headroom is not None else 0
    capacity = model.NewIntVar(shared.capacity, shared.capacity + headroom, f"shared_capacity_{name}")
    if shared.headroom is None:
        if assume is not None and room_id is not None:
            model.Add(capacity == shared.capacity).OnlyEnforceIf(assume(room_id))
        else:
            model.Add(capacity == shared.capacity)
    # Implied (app/solver/weeks.py): a lesson fewer is fewer pupils in the room.
    # One room's lessons, so every week they tell apart has its row.
    for week in each_week(
        [*(parity for _, _, parity in entries), *(lock.parity for lock in shared.locks)],
    ):
        intervals: list[cp_model.IntervalVar] = []
        demands: list[int] = []
        for interval, demand, parity in entries:
            if week is None or meet(parity, week):
                intervals.append(interval)
                demands.append(demand)
        for index, lock in enumerate(shared.locks):
            if week is None or meet(lock.parity, week):
                intervals.append(
                    model.NewFixedSizeIntervalVar(
                        lock.start, lock.end - lock.start, f"shared_lock_{name}_{index}",
                    ),
                )
                demands.append(lock.count)
        if intervals:
            model.AddCumulative(intervals, demands, capacity)
    return capacity
