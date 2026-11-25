"""Ett schema som start: lay a week by holding a schedule that exists and letting go of what no longer fits (M8 PR 4, M9's engine half).

THE IDEA, AND WHAT MEASURED IT (docs/DEPLOYMENT.md §35.7, the M8 design note 4.5). A week that resembles a
schedule that exists (last year's, one read in from another program, an earlier run) is not laid by searching for
every lesson. Hold the lessons of the schedule where they were, let go of the few that clash with THIS week, and
lay those: on corpus weeks that are TIMEOUT for the whole week, 8 of 141 requirements clashing was a matter of
0.09 deterministic seconds, and the schedule given only as a hint (`previousLessons`) took 2.7.

THE PIECES, in the order the solve uses them:

  held_places       the lessons the request's `startLessons` hold, as the engine's own pinned lessons (a place per
                    lesson of its requirement, by LENGTH: an entry has an end, so a requirement with lessons of
                    several lengths gets each into the place of its length, which a start alone could not say).
                    What cannot be held is left out and counted: a requirement the week no longer has, one the school
                    pinned by hand, a split lesson (the places follow the leads, and an entry names none), an entry
                    of no place's length, and a block whose members the schedule does not hold together.
  clashes           the held requirements that meet another lesson they may not: a teacher in two places, a group or
                    two groups that share a pupil, a teacher's reservation. ARITHMETIC ON THE SCHEDULE AND THE WEEK,
                    cheap, and exactly what a changed pupil list or a new reservation does to last year's: the first
                    attempt is then not a refusal that names them one at a time.
  in_the_way        which held requirements a refusal names: the pins of a core (`PLACED_LESSON_IN_THE_WAY*`), the
                    requirements of any other row of an INFEASIBLE answer, or the requirement a pin that the week's
                    frame cannot hold is refused for. These are let go and the week is asked again.
  neighbours        where a refusal names none (a teacher's hours, say): the held requirements one step from what is
                    free, the same teacher or a group that shares a pupil, as a repair widens in the roads of M8.
  attempt           the request as one attempt lays it: the held lessons pinned, the rest free, the schedule given
                    as `previousLessons` too (the disruption term keeps what it can, and the last attempt, with
                    nothing held, IS the hint's solve), and `startLessons` taken out so the attempt is an ordinary
                    request.

NOTHING HERE LAYS ANYTHING. The loop is SchedulerSolver._solve_from_start: it asks `_solve_strict` for each attempt,
which is the engine's own solve with its prechecks, its builds, its explanation and its phase 2, so an attempt that
succeeds is a whole answer and one that is refused is an explained refusal. What it adds is only the next attempt.

LOCKS AND PINS ARE NOT THIS. A locked lesson (`fixedLessons`) is a fact about the school and a pinned one
(`pinnedLessons`) is the school's hand; both stay what they were and are never let go. A lesson of the schedule is held
until the week shows it cannot stay.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from uuid import UUID

from app.schemas.schedule import (
    AnonymousRequirement,
    ConflictAnalysis,
    OptimizeScheduleRequest,
    PinnedLesson,
    PreviousLesson,
    StartedLesson,
)
from app.solver.weeks import meet, weeks_of

logger = logging.getLogger(__name__)

#: How many times the week is asked again before every lesson is let go and the schedule is only a hint. Each round is a
#: refusal the engine has proved and explained (seconds), not a search, so six is a bound on the proofs and not on time.
MAX_ROUNDS = 6

#: The codes of a refusal that name a pinned lesson (pins.PIN_CODES), which is what a held lesson is in the model.
PIN_CODES = ("PLACED_LESSON_IN_THE_WAY", "PLACED_LESSON_IN_THE_WAY_ANY_ROOM")


def pupil_key_of(requirement: AnonymousRequirement) -> UUID:
    """The engine's own key in the pupil space (scheduler_solver.pupil_key_of), read when asked: that module imports this one."""
    from app.solver.scheduler_solver import pupil_key_of as engine_key

    return engine_key(requirement)


def _minutes(clock: str) -> int:
    hours, minutes, _ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


@dataclass
class Held:
    """The lessons of the schedule that can be held, and what could not."""

    #: requirement id -> a place per lesson of the requirement (None for a place the schedule left empty).
    places: dict[UUID, list[PinnedLesson | None]] = field(default_factory=dict)
    #: Why an entry was left out, and how many: for the log, so that a schedule that holds nothing can be told why.
    dropped: dict[str, int] = field(default_factory=dict)

    def drop(self, reason: str, count: int = 1) -> None:
        self.dropped[reason] = self.dropped.get(reason, 0) + count


def held_places(request: OptimizeScheduleRequest) -> Held:
    """The request's `startLessons` as places of its requirements' lessons (see the module)."""
    held = Held()
    by_id = {requirement.id: requirement for requirement in request.requirements}
    entries: dict[UUID, list[StartedLesson]] = defaultdict(list)
    for entry in request.start_lessons or []:
        requirement = by_id.get(entry.requirement_id)
        if requirement is None:
            held.drop("the week has no such requirement")
        elif requirement.pinned_lessons is not None:
            held.drop("the school pinned this requirement")
        elif requirement.lesson_teacher_ids is not None:
            held.drop("a split lesson")
        else:
            entries[requirement.id].append(entry)

    for requirement_id, given in entries.items():
        requirement = by_id[requirement_id]
        waiting: dict[int, list[StartedLesson]] = defaultdict(list)
        for entry in sorted(given, key=lambda e: (e.day_of_week, e.start_time)):
            waiting[_minutes(entry.end_time) - _minutes(entry.start_time)].append(entry)
        row: list[PinnedLesson | None] = []
        for length in requirement.lesson_minutes():
            queue = waiting.get(length)
            if queue:
                entry = queue.pop(0)
                row.append(PinnedLesson(
                    dayOfWeek=entry.day_of_week, startTime=entry.start_time, endTime=entry.end_time,
                ))
            else:
                row.append(None)
        extra = sum(len(queue) for queue in waiting.values())
        if extra:
            held.drop("more entries than places of that length", extra)
        if any(place is not None for place in row):
            held.places[requirement_id] = row

    # A block's k-th lessons start together, and a pinned block is pinned place by place for every member or none
    # (pins.verify_pins): a block the schedule does not hold whole is not held at all.
    members: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
    for requirement in request.requirements:
        if requirement.block_id is not None:
            members[requirement.block_id].append(requirement)
    for block, of_block in members.items():
        if not any(requirement.id in held.places for requirement in of_block):
            continue
        rows = [held.places.get(requirement.id) for requirement in of_block]
        whole = all(row is not None and all(place is not None for place in row) for row in rows)
        together = whole and all(
            len({(row[k].day_of_week, row[k].start_time) for row in rows if row is not None and row[k] is not None}) == 1  # type: ignore[union-attr]
            for k in range(of_block[0].lessons_per_week)
        )
        if not together:
            for requirement in of_block:
                if held.places.pop(requirement.id, None) is not None:
                    held.drop("a block the schedule does not hold together")
    return held


def _blocks_of(request: OptimizeScheduleRequest) -> dict[UUID, set[UUID]]:
    """block id -> the requirement ids of its members, for a block of the request."""
    out: dict[UUID, set[UUID]] = defaultdict(set)
    for requirement in request.requirements:
        if requirement.block_id is not None:
            out[requirement.block_id].add(requirement.id)
    return out


def with_blocks(request: OptimizeScheduleRequest, ids: set[UUID]) -> set[UUID]:
    """`ids` and every other member of a block one of them is in: a block is held whole or let go whole."""
    block_of = {requirement.id: requirement.block_id for requirement in request.requirements}
    blocks = _blocks_of(request)
    out = set(ids)
    for requirement_id in ids:
        block = block_of.get(requirement_id)
        if block is not None:
            out |= blocks[block]
    return out


def clashes(request: OptimizeScheduleRequest, held: Held) -> set[UUID]:
    """The held requirements that sit on something they may not sit on in THIS week.

    Pairs of lessons that overlap and may not: the same teacher; the same group, or two groups that share a pupil
    (`groupConflicts`); a teacher's reservation. Both of a clashing pair are named, since which of two should move is
    the solver's to say. A lesson only clashes with one that runs in a week of its own (periods and parity)."""
    by_id = {requirement.id: requirement for requirement in request.requirements}
    weeks = {requirement_id: weeks_of(by_id[requirement_id]) for requirement_id in held.places}
    lessons: dict[UUID, list[tuple[int, int, int]]] = {}
    for requirement_id, row in held.places.items():
        lessons[requirement_id] = [
            (place.day_of_week, _minutes(place.start_time), _minutes(place.end_time)) for place in row if place is not None
        ]
    out: set[UUID] = set()

    def overlap(a: tuple[int, int, int], b: tuple[int, int, int]) -> bool:
        return a[0] == b[0] and a[1] < b[2] and b[1] < a[2]

    def meeting(first: UUID, second: UUID) -> bool:
        return first != second and meet(weeks[first], weeks[second]) and any(
            overlap(a, b) for a in lessons[first] for b in lessons[second]
        )

    def collide(group: list[UUID], other: list[UUID] | None = None) -> None:
        if other is None:
            for index, first in enumerate(group):
                for second in group[index + 1:]:
                    if meeting(first, second):
                        out.update((first, second))
        else:
            for first in group:
                for second in other:
                    if meeting(first, second):
                        out.update((first, second))

    teachers: dict[UUID, list[UUID]] = defaultdict(list)
    groups: dict[UUID, list[UUID]] = defaultdict(list)
    for requirement_id in held.places:
        requirement = by_id[requirement_id]
        if requirement.teacher_id is not None:
            teachers[requirement.teacher_id].append(requirement_id)
        groups[pupil_key_of(requirement)].append(requirement_id)
    for requirement_ids in teachers.values():
        collide(requirement_ids)
    for requirement_ids in groups.values():
        collide(requirement_ids)
    for first, second in request.group_conflicts:
        if first != second and first in groups and second in groups:
            collide(groups[first], groups[second])

    for constraint in request.constraints:
        if (
            constraint.kind != "UNAVAILABLE" or str(constraint.resource_kind) != "TEACHER"
            or constraint.day_of_week is None or constraint.date is not None or constraint.resource_id not in teachers
        ):
            continue
        window = (int(constraint.day_of_week), _minutes(str(constraint.start_time)), _minutes(str(constraint.end_time)))
        for requirement_id in teachers[constraint.resource_id]:
            if any(overlap(lesson, window) for lesson in lessons[requirement_id]):
                out.add(requirement_id)
    return out


def in_the_way(analysis: ConflictAnalysis | None, candidates: set[UUID]) -> set[UUID]:
    """The held requirements an explained refusal names: the pins of its core first, any row's requirements after."""
    if analysis is None:
        return set()
    pins = {
        requirement_id
        for detail in analysis.conflicts if detail.code in PIN_CODES
        for requirement_id in detail.requirement_ids
    } & candidates
    if pins:
        return pins
    return {requirement_id for detail in analysis.conflicts for requirement_id in detail.requirement_ids} & candidates


def neighbours(request: OptimizeScheduleRequest, free: set[UUID], candidates: set[UUID]) -> set[UUID]:
    """The held requirements one step from what is free: the same teacher, or a group that shares a pupil with a free one."""
    by_id = {requirement.id: requirement for requirement in request.requirements}
    teachers = {by_id[i].teacher_id for i in free if i in by_id and by_id[i].teacher_id is not None}
    reach = {pupil_key_of(by_id[i]) for i in free if i in by_id}
    for first, second in request.group_conflicts:
        if first in reach:
            reach.add(second)
        if second in reach:
            reach.add(first)
    return {
        requirement_id for requirement_id in candidates
        if by_id[requirement_id].teacher_id in teachers or pupil_key_of(by_id[requirement_id]) in reach
    }


def named_by_refusal(params: dict[str, str | int], candidates: set[UUID]) -> set[UUID]:
    """The held requirements a refusal BEFORE the model (a pin the frame cannot hold) names in its params."""
    named: set[UUID] = set()
    for value in params.values():
        try:
            requirement_id = UUID(str(value))
        except ValueError:
            continue
        if requirement_id in candidates:
            named.add(requirement_id)
    return named


def attempt(request: OptimizeScheduleRequest, held: Held, free: set[UUID]) -> OptimizeScheduleRequest:
    """The request as one attempt lays it: what is held pinned, `startLessons` taken out, the schedule as a hint too.

    The schedule is given as `previousLessons` unless the caller sent some of its own: the disruption term then
    keeps whatever the attempt lets go of where it was, when it can, and an attempt that holds nothing is the hint's
    solve. A requirement that has a lesson entry in `previousLessons` already keeps the caller's."""
    pins = {requirement_id: row for requirement_id, row in held.places.items() if requirement_id not in free}
    requirements = [
        requirement.model_copy(update={"pinned_lessons": pins[requirement.id]}) if requirement.id in pins else requirement
        for requirement in request.requirements
    ]
    update: dict[str, object] = {"requirements": requirements, "start_lessons": None}
    if not request.previous_lessons:
        update["previous_lessons"] = [
            PreviousLesson(
                requirementId=entry.requirement_id, dayOfWeek=entry.day_of_week, startTime=entry.start_time,
            )
            for entry in request.start_lessons or []
            if entry.requirement_id in held.places
        ][:5000]
    return request.model_copy(update=update)
