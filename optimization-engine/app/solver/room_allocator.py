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
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Iterable
from uuid import UUID

from ortools.sat.python import cp_model

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
    # lesson key -> {class index: literal}; absent when the class is forced.
    literals: dict[str, dict[int, cp_model.IntVar]] = field(default_factory=dict)
    forced_class: dict[str, int] = field(default_factory=dict)
    # lesson key -> (start var, duration, room_index var), in build order.
    placements: list[tuple[str, cp_model.IntVar, int, cp_model.IntVar]] = field(
        default_factory=list,
    )

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
        return assignment


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
) -> list[RoomClass]:
    """Partition rooms so that every lesson's eligible set is a union of classes."""
    # One representative requirement per distinct eligibility profile: room
    # eligibility depends only on (required type, group size).
    representatives: dict[tuple, object] = {}
    for decision in decisions:
        requirement = decision.lesson.requirement
        representatives.setdefault(
            (requirement.required_room_type, requirement.student_group_size),
            requirement,
        )
    profiles = list(representatives.values())

    grouped: dict[tuple, list[int]] = {}
    for index, room in enumerate(rooms):
        if room.id in distinguished_room_ids:
            # Its own class, so room_index can be pinned to it exactly.
            signature: tuple = ("pinned", index)
        else:
            signature = tuple(room_allowed(room, profile) for profile in profiles)
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
) -> RoomPlan:
    """Enforce room capacity without naming rooms. Replaces per-room NoOverlap."""
    classes = build_room_classes(decisions, rooms, distinguished_room_ids, room_allowed)
    plan = RoomPlan(classes=classes)
    pools: dict[int, list[cp_model.IntervalVar]] = defaultdict(list)

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

        if len(eligible) == 1:
            only = eligible[0]
            plan.forced_class[key] = only.index
            pools[only.index].append(decision.interval)
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
        if room_class.capacity == 1:
            # Same semantics as a unit cumulative, stronger propagator.
            model.AddNoOverlap(pool)
        else:
            model.AddCumulative(pool, [1] * len(pool), room_class.capacity)

    return plan
