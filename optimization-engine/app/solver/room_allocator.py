"""Room allocation by interchangeability class rather than by named room.

The obvious encoding — a reified "lesson L is in room R" boolean per (lesson,
room) pair plus one NoOverlap per room — costs ``lessons x rooms`` booleans
(264,960 on a 2,000-student payload) and, worse, makes every room of the same
type and capacity a distinct search decision. With 76 interchangeable
classrooms the solver walks 76! equivalent permutations of the same timetable.

This module removes both costs by never naming a concrete room in the model.

1. **Interchangeability classes.** Two rooms belong to the same class when
   ``_room_allowed`` gives the same verdict for every requirement in the
   payload. Grouping by that eligibility *signature* is the coarsest partition
   that respects room eligibility exactly, which means every lesson's eligible
   room set is a union of whole classes — never a partial one. That is what
   makes step 2 lossless.

2. **Class choice.** Each lesson picks a class, not a room: one literal per
   eligible class, ``AddExactlyOne`` across them, and an optional interval into
   that class's pool. A lesson with a single eligible class needs no literal —
   its mandatory interval goes straight into the pool.

3. **One cumulative per class**, capacity = the number of rooms in it.

4. **Post-pass.** :meth:`RoomPlan.assign_rooms` turns the class assignment into
   concrete rooms by a sweep in start order.

Why the post-pass cannot fail
-----------------------------
Let class ``c`` hold ``k`` rooms and let ``S`` be the lessons assigned to it.
``AddCumulative`` with unit demands and capacity ``k`` guarantees that at every
instant at most ``k`` lessons of ``S`` are running. Sweep ``S`` in
non-decreasing start order and give each lesson any free room of ``c``. When
lesson ``d`` with start ``s`` is processed, a room is busy exactly when it
holds an already-placed lesson ``e`` with ``start(e) <= s`` and ``end(e) > s``
— precisely the placed lessons whose half-open interval covers ``s``. With
``d`` itself those number at most ``k``, so at most ``k - 1`` rooms are busy and
one is free. CP-SAT uses the same half-open convention (``end == start`` does
not overlap), so reusing a room at that instant is legal, and every room of
``c`` is eligible for every lesson of ``S`` by construction.

Why the simpler version is unsound
----------------------------------
It is tempting to skip the class literals and post one cumulative per room
*type* over every lesson that could use it. That is a strict relaxation and can
yield a timetable with no valid room assignment at all::

    rooms   A,B in class U1;   C,D in class U2
    f1, f2  eligible for all four, interval [0,10)
    r1, r2  eligible only for U1, interval [1,2)
    s1, s2  eligible only for U2, interval [3,4)

Every per-instant count holds, yet at t=1 the U1-only pair occupies A and B,
forcing f1,f2 into {C,D}; at t=3 the U2-only pair occupies C and D, forcing
f1,f2 into {A,B} — while f1 must keep one room for its whole interval.
Per-instant feasibility does not imply a time-consistent assignment. Only the
class-literal form is sound.

``room_index`` is no longer the answer
--------------------------------------
``LessonDecision.room_index`` stays in the model because other builders reify
``room_index == r`` against it, but this encoding does not make it the
authoritative room. ``_extract_lessons`` must read the post-pass instead.

Rooms that *are* named by identity — ROOM-scoped constraints and room-bearing
fixed lessons — are passed as ``distinguished_room_ids`` and become their own
singleton classes, with ``room_index`` linked to the class literal so the
solver's view and the post-pass agree exactly. Singleton classes carry no
symmetry, so nothing is lost by pinning them.

A/B-veckor: two weeks in one room
---------------------------------
A lesson on odd weeks only and one on even weeks only may share a room at
the same hour (app/solver/weeks.py). What each class's row holds then
depends on its pool — every lesson that may choose the class, which for a
class of special rooms is its own subject's lessons AND every lesson without
a room type that fits there:

- **One room**: one NoOverlap per week (``week_parts``), exact — the room is
  the room, and the post-pass gives it to every lesson of the class.
- **Several rooms, no every-week lesson in the pool**: one cumulative per
  week. Exact as well: the odd lessons never meet the even ones, so each week
  is a separate interval colouring with its own sweep (``RoomPlan.by_week``).
- **Several rooms, every-week lessons beside alternating ones** (MIXED): the
  rooms are named. Each lesson of the pool takes one room of the class
  (``RoomPlan.rooms_of``), and each room has one NoOverlap per week over the
  lessons it holds; a cumulative per week beside them is implied and only
  propagates. Per-week cumulatives ALONE would be unsound here — they can
  admit a timetable with no room assignment at all, because an every-week
  lesson must keep one room through both weeks::

      2 rooms;  a1 every week [0,2)   o1 odd [0,5)
                e1 even [1,3)         e2 even [2,6)   a2 every week [4,6)

  Each week has at most two lessons at any instant, yet a1 takes one room,
  o1 the other; e1 must avoid a1 in the even week, so e1 shares o1's room;
  e2 must avoid e1, so e2 takes a1's; and a2 must avoid o1 (odd) and e2
  (even), which is both rooms. Naming the rooms costs a literal per lesson
  and room of a mixed class — only in a payload with alternating lessons,
  and only in the classes that mix — and is exact. (The release before it
  counted the alternating lessons of a mixed class in both weeks, which is
  sound but refused real weeks: two slöjdsalar with odd and even slöjd, and
  one ordinary lesson that fits a slöjdsal, made the slöjdsalar mixed —
  review of #221, M1.)
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Hashable, Iterable
from uuid import UUID

from ortools.sat.python import cp_model

from app.solver.weeks import week_parts

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.schemas.schedule import AnonymousConstraint, AnonymousRoom, FixedLesson


class RoomAllocationError(RuntimeError):
    """The post-pass could not place a lesson — a model bug, never user input."""


@dataclass(frozen=True)
class RoomClass:
    index: int
    room_indices: tuple[int, ...]

    @property
    def capacity(self) -> int:
        return len(self.room_indices)


@dataclass
class RoomPlan:
    classes: list[RoomClass]
    #: The skolområde of each class, by class index — Restid i generatorn's
    #: reading of a lesson's class choice (app/solver/travel.py). Every class
    #: stands on one when the partition was asked to keep sites apart
    #: (`site_key`), and the list is empty when it was not: nothing then
    #: reads it.
    class_sites: list[Hashable] = field(default_factory=list)
    #: The literals that sum a lesson's classes on one site, made by
    #: travel.site_choices where a lesson has more than one class there, in
    #: build order: (lesson key, site, literal). Two builds of one request make
    #: them in the same order, which is what lets solve() hint one build's
    #: from the other's, as it hints the class literals. Empty with the rule off.
    site_vars: list[tuple[str, Hashable, cp_model.IntVar]] = field(default_factory=list)
    #: Every lesson's sites and the literal saying it stands there (None where
    #: it stands there whatever happens), by lesson key: travel.site_choices's
    #: answer, kept for solve()'s planned-sites search. Empty with the rule off.
    site_choices: dict[str, dict[Hashable, cp_model.IntVar | None]] = field(default_factory=dict)
    # lesson key -> {class index: literal}; absent when the class is forced.
    literals: dict[str, dict[int, cp_model.IntVar]] = field(default_factory=dict)
    forced_class: dict[str, int] = field(default_factory=dict)
    # lesson key -> (start var, duration, room_index var), in build order.
    placements: list[tuple[str, cp_model.IntVar, int, cp_model.IntVar]] = field(
        default_factory=list,
    )
    #: A/B-veckor: the classes whose pool holds alternating lessons and no
    #: every-week one, on several rooms — one cumulative per week, so one
    #: sweep per week — and the week of each alternating lesson, by key.
    #: Empty for a payload without alternating lessons.
    by_week: set[int] = field(default_factory=set)
    parity: dict[str, str] = field(default_factory=dict)
    #: A/B-veckor: the mixed classes (the module docstring), and the literal
    #: per lesson and room of one saying the lesson is in it, by lesson key —
    #: every mixed class's rooms the lesson may take, since a lesson without a
    #: room type is in the pool of every class it fits. The two builds of one
    #: request make them in the same order, so solve() hints one from the other
    #: as it does the class literals. Empty without a mixed class.
    named: set[int] = field(default_factory=set)
    rooms_of: dict[str, dict[int, cp_model.IntVar]] = field(default_factory=dict)

    def class_of(self, key: str, solver: cp_model.CpSolver) -> int:
        forced = self.forced_class.get(key)
        if forced is not None:
            return forced
        chosen = [c for c, lit in self.literals[key].items() if solver.Value(lit)]
        if len(chosen) != 1:
            msg = f"lesson {key} selected {len(chosen)} room classes; AddExactlyOne broke"
            raise RoomAllocationError(msg)
        return chosen[0]

    def assign_rooms(self, solver: cp_model.CpSolver) -> dict[str, int]:
        """Concrete room index per lesson key. Cannot fail on a valid solution."""
        by_class: dict[int, list[tuple[int, int, str, int]]] = defaultdict(list)
        for key, start, duration, room_index in self.placements:
            by_class[self.class_of(key, solver)].append(
                (solver.Value(start), duration, key, solver.Value(room_index)),
            )

        assignment: dict[str, int] = {}
        for class_index, entries in by_class.items():
            room_indices = self.classes[class_index].room_indices
            if class_index in self.named:
                # A mixed class: the solver named each lesson's room.
                for _start, _duration, key, _preferred in entries:
                    chosen = [
                        room for room in room_indices
                        if solver.Value(self.rooms_of[key][room])
                    ]
                    if len(chosen) != 1:  # pragma: no cover - AddExactlyOne broke
                        msg = f"lesson {key} named {len(chosen)} rooms of class {class_index}"
                        raise RoomAllocationError(msg)
                    assignment[key] = chosen[0]
                continue
            if len(room_indices) == 1 and self.parity:
                # One room is every lesson's room, whichever weeks they run:
                # its NoOverlap per week is the whole proof, and two lessons
                # of opposite weeks at one hour are both in it.
                for _start, _duration, key, _preferred in entries:
                    assignment[key] = room_indices[0]
                continue
            if class_index in self.by_week:
                # No every-week lesson: each week is its own colouring, swept
                # on its own against the week's own cumulative.
                for week in sorted({self.parity[entry[2]] for entry in entries}):
                    self._sweep(
                        class_index,
                        room_indices,
                        [entry for entry in entries if self.parity[entry[2]] == week],
                        assignment,
                    )
                continue
            self._sweep(class_index, room_indices, entries, assignment)
        return assignment

    def _sweep(
        self,
        class_index: int,
        room_indices: tuple[int, ...],
        entries: list[tuple[int, int, str, int]],
        assignment: dict[str, int],
    ) -> None:
        """Give each lesson a free room of the class in start order (module docstring)."""
        # Absolute slot from which each room is free again.
        free_from = dict.fromkeys(room_indices, 0)
        for start, duration, key, preferred in sorted(entries, key=lambda e: e[0]):
            # Prefer whatever the solver left in room_index when it is free,
            # so singleton (pinned) classes reproduce its own choice and
            # repeated solves of one schedule return stable rooms.
            chosen = None
            if preferred in free_from and free_from[preferred] <= start:
                chosen = preferred
            else:
                for candidate in room_indices:
                    if free_from[candidate] <= start:
                        chosen = candidate
                        break
            if chosen is None:  # pragma: no cover - proof says unreachable
                msg = (
                    f"no free room in class {class_index} for lesson {key} at "
                    f"slot {start}; the cumulative constraint was violated"
                )
                raise RoomAllocationError(msg)
            free_from[chosen] = start + duration
            assignment[key] = chosen


def collect_distinguished_room_ids(
    constraints: Iterable[AnonymousConstraint],
    fixed_lessons: Iterable[FixedLesson],
) -> set[UUID]:
    """Rooms other builders reify by identity, so they must stay pinnable."""
    distinguished: set[UUID] = set()
    for constraint in constraints:
        if constraint.resource_kind == "ROOM":
            distinguished.add(constraint.resource_id)
    for fixed in fixed_lessons:
        if fixed.room_id is not None:
            distinguished.add(fixed.room_id)
    return distinguished


def build_room_classes(
    decisions: list,
    rooms: list[AnonymousRoom],
    distinguished_room_ids: set[UUID],
    room_allowed: Callable[[AnonymousRoom, object], bool],
    profile_key: Callable[[object], tuple],
    preference_sets: list[set[UUID]] | None = None,
    site_key: Callable[[AnonymousRoom], Hashable] | None = None,
) -> list[RoomClass]:
    """Partition rooms so that every lesson's eligible set is a union of classes.

    THE PARTITION IS ONLY SOUND IF `profile_key` NAMES EVERY FIELD
    `room_allowed` READS. One representative requirement stands for its whole
    profile, and the signature below is computed against representatives alone —
    so a field the predicate consults and the key omits makes two genuinely
    different eligibilities collapse into one class, and a lesson is then placed
    in a room it was never allowed.

    That is not hypothetical: this function keyed on (required type, group size)
    under a comment asserting eligibility depended on nothing else, which stopped
    being true the day rooms gained their own stage limits. Two requirements of
    equal size and different years collapsed a years-7-9 room and an open room
    into one class, and year-4 lessons landed in the high-school room on a run
    reported FEASIBLE with no conflict — 19 of 20 in one reproduction, 8 of 20
    in the next, because which requirement became the representative depends on
    the order the payload happens to arrive in.

    The key is therefore passed in by the caller that owns the predicate, beside
    it, rather than spelled out here where the two can drift apart again.

    `site_key`, WHEN GIVEN, JOINS THE SIGNATURE TOO, so that no class spans two
    skolområden. Restid i generatorn reads a lesson's site off its class
    choice, and a class holding a room on each of two sites would let the
    post-pass hand the lesson a room on the other one — a walk the model never
    saw. Absent, the signature is exactly what it was, and so is every class;
    a pinned room is its own class either way and stands on its own site.
    """
    representatives: dict[tuple, object] = {}
    for decision in decisions:
        requirement = decision.lesson.requirement
        representatives.setdefault(profile_key(requirement), requirement)
    profiles = list(representatives.values())

    # Soft room preferences join the signature rather than pinning rooms: two
    # otherwise identical rooms where only one is preferred must not be
    # interchangeable, or the wish could never be expressed. Splitting only
    # where a preference actually distinguishes keeps the partition coarse —
    # naming three rooms costs three-way splits, not one class per room.
    wanted = preference_sets or []

    grouped: dict[tuple, list[int]] = {}
    for index, room in enumerate(rooms):
        if room.id in distinguished_room_ids:
            # Its own class, so room_index can be pinned to it exactly.
            signature: tuple = ("pinned", index)
        else:
            signature = (
                tuple(room_allowed(room, profile) for profile in profiles)
                + tuple(room.id in preferred for preferred in wanted)
            )
            if site_key is not None:
                signature += (site_key(room),)
        grouped.setdefault(signature, []).append(index)

    return [
        RoomClass(index=position, room_indices=tuple(members))
        for position, members in enumerate(grouped.values())
    ]


def add_room_allocation(
    model: cp_model.CpModel,
    decisions: list,
    rooms: list[AnonymousRoom],
    *,
    distinguished_room_ids: set[UUID],
    room_allowed: Callable[[AnonymousRoom, object], bool],
    profile_key: Callable[[object], tuple],
    preference_sets: list[set[UUID]] | None = None,
    site_key: Callable[[AnonymousRoom], Hashable] | None = None,
) -> RoomPlan:
    """Enforce room capacity without naming rooms. Replaces per-room NoOverlap."""
    classes = build_room_classes(
        decisions, rooms, distinguished_room_ids, room_allowed, profile_key,
        preference_sets, site_key,
    )
    plan = RoomPlan(
        classes=classes,
        class_sites=(
            [site_key(rooms[room_class.room_indices[0]]) for room_class in classes]
            if site_key is not None
            else []
        ),
    )
    pools: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)
    # The lesson behind each pool entry, by position: the week it runs in is
    # what the class's row is cut by, and a mixed class names its rooms for
    # it — the decision and the literal choosing the class, None where the
    # class is forced (module docstring, A/B-veckor).
    members: dict[int, list[str]] = defaultdict(list)
    chosen_by: dict[int, list[tuple[object, cp_model.IntVar | None]]] = defaultdict(list)

    for decision in decisions:
        requirement = decision.lesson.requirement
        key = decision.lesson.key()
        # Classes are atoms of the eligibility algebra, so testing one member
        # decides the whole class.
        eligible = [
            room_class
            for room_class in classes
            if room_allowed(rooms[room_class.room_indices[0]], requirement)
        ]
        if not eligible:
            # Mirrors _add_capacity_constraints, which leaves room_index free
            # when nothing fits. _validate_request rejects such payloads first.
            eligible = list(classes)

        plan.placements.append(
            (key, decision.start, decision.duration, decision.room_index),
        )
        parity = getattr(requirement, "recurrence", None)
        if parity is not None:
            plan.parity[key] = parity

        if len(eligible) == 1:
            only = eligible[0]
            plan.forced_class[key] = only.index
            pools[only.index].append(decision.interval)
            members[only.index].append(key)
            chosen_by[only.index].append((decision, None))
            if only.capacity == 1:
                model.Add(decision.room_index == only.room_indices[0])
            continue

        literals: dict[int, cp_model.IntVar] = {}
        for room_class in eligible:
            literal = model.NewBoolVar(f"class_{room_class.index}_{key}")
            literals[room_class.index] = literal
            pools[room_class.index].append(
                model.NewOptionalIntervalVar(
                    decision.start,
                    decision.duration,
                    decision.end,
                    literal,
                    f"opt_{room_class.index}_{key}",
                ),
            )
            members[room_class.index].append(key)
            chosen_by[room_class.index].append((decision, literal))
            # A singleton class is a specific room, and other builders may reify
            # room_index against it. Keep the two views in agreement.
            if room_class.capacity == 1:
                only_room = room_class.room_indices[0]
                model.Add(decision.room_index == only_room).OnlyEnforceIf(literal)
                model.Add(decision.room_index != only_room).OnlyEnforceIf(literal.Not())
        model.AddExactlyOne(literals.values())
        plan.literals[key] = literals

    for room_class in classes:
        pool = pools.get(room_class.index)
        if not pool:
            continue
        entries = list(zip(pool, members[room_class.index]))
        parts = week_parts(entries, lambda entry: plan.parity.get(entry[1]))  # type: ignore[arg-type,return-value]
        if room_class.capacity == 1:
            # Same semantics as a unit cumulative, stronger propagator. One
            # per week the pool's lessons run in, which is exact for one room.
            for _, part in parts:
                model.AddNoOverlap([interval for interval, _ in part])
        elif parts[0][0] is None:
            # Every lesson every week: the cumulative it always was.
            model.AddCumulative(pool, [1] * len(pool), room_class.capacity)
        elif all(entry[1] in plan.parity for entry in entries):
            # Alternating lessons only: one colouring per week.
            plan.by_week.add(room_class.index)
            for _, part in parts:
                model.AddCumulative(
                    [interval for interval, _ in part], [1] * len(part), room_class.capacity,
                )
        else:
            _name_the_rooms(model, plan, room_class, chosen_by[room_class.index])
            # Implied by the named rooms, and posted for what a cumulative
            # propagates that k no-overlaps do not.
            for _, part in parts:
                model.AddCumulative(
                    [interval for interval, _ in part], [1] * len(part), room_class.capacity,
                )

    return plan


def _name_the_rooms(
    model: cp_model.CpModel,
    plan: RoomPlan,
    room_class: RoomClass,
    chosen_by: list[tuple[object, cp_model.IntVar | None]],
) -> None:
    """A mixed class's rooms, named: each lesson in one of them, one no-overlap per room and week.

    A lesson that may choose the class is in exactly one of its rooms when it
    chooses it and in none otherwise; one forced into the class is in exactly
    one. Each room then holds its lessons apart in each week they run in
    (week_parts), so an every-week lesson keeps its room in both weeks and an
    odd and an even lesson may share one. room_index follows the named room,
    as a singleton class's does.
    """
    entries: dict[int, list[tuple[object, cp_model.IntervalVar]]] = defaultdict(list)
    for decision, chooses in chosen_by:
        key = decision.lesson.key()  # type: ignore[attr-defined]
        named: dict[int, cp_model.IntVar] = {}
        for room in room_class.room_indices:
            literal = model.NewBoolVar(f"room_{room}_{key}")
            named[room] = literal
            model.Add(decision.room_index == room).OnlyEnforceIf(literal)  # type: ignore[attr-defined]
            entries[room].append((
                decision,
                model.NewOptionalIntervalVar(
                    decision.start, decision.duration, decision.end,  # type: ignore[attr-defined]
                    literal, f"in_{room}_{key}",
                ),
            ))
        if chooses is None:
            model.AddExactlyOne(named.values())
        else:
            model.Add(sum(named.values()) == chooses)
        plan.rooms_of.setdefault(key, {}).update(named)
    plan.named.add(room_class.index)
    for room, held in entries.items():
        for _, part in week_parts(held, lambda entry: plan.parity.get(entry[0].lesson.key())):  # type: ignore[attr-defined]
            if len(part) > 1:
                model.AddNoOverlap([interval for _, interval in part])
