"""Årskurs för årskurs: lay a week one year at a time, each year held where it was laid (M8 PR 5, the design note's (b)).

WHAT MEASURED IT (docs/DEPLOYMENT.md §35.9, design note 4.3). A week of nine classes with six subjects in groups across them
is a search the whole week cannot win (TIMEOUT at 120 s on eight cores), and the same week laid a year at a time is three
small searches: 1.0 to 4.9 deterministic seconds in all, and the engine accepts what comes out. The years of a school share
no pupils, so a timetable of the whole week is the years' timetables side by side, apart from the teachers and rooms the years
share; those are what holding the years already laid is for.

THE PIECES, in the order the solve uses them:

  units_of      the years of the week as sets of requirements, hardest first: requirements that share a pupil (a group and
                the classes it draws on, `groupConflicts`), a block, or a year, are one unit, and a week of fewer than two
                units, or of more than MAX_UNITS, is not laid this way.
  step_request  the week as one step asks it: the units laid so far held as the engine's own pinned lessons (a place per
                lesson, rooms left free), the unit being laid free, every later unit left out.
  places_of     where a requirement's laid lessons sit among its places (`pinnedLessons` has one place per lesson, longest
                lesson first, and a split post's place is its lead's), which is not the order of the clock.

NOTHING HERE SEARCHES. The loop is SchedulerSolver._lay_by_years, which builds and solves each step with the engine's own
model; what comes out is a timetable that is a hint for the week's own search (phase 1b), never an answer: nothing here is
proved, and a step that fails, in time or in kind, ends the road and the week goes on as it always did.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from uuid import UUID

from app.schemas.schedule import (
    AnonymousRequirement,
    OptimizeScheduleRequest,
    PinnedLesson,
    ScheduledLesson,
)

#: A week of more units than this is not laid year by year: the steps are each a build and a search, and a school with a unit
#: to every class (no group crosses a class, no year is named) is not the week this road is for.
MAX_UNITS = 12


def _minutes(clock: str) -> int:
    return int(clock[:2]) * 60 + int(clock[3:5])


def _pupil_key(requirement: AnonymousRequirement) -> UUID:
    """The requirement's key in the pupil space (scheduler_solver.pupil_key_of): who sits its lessons."""
    return requirement.pupil_group_id if requirement.pupil_group_id is not None else requirement.student_group_id


@dataclass(frozen=True)
class Unit:
    """One step's requirements: the ids, and what ordered it."""

    ids: frozenset[UUID]
    #: The years its requirements are for, for the log.
    years: tuple[int, ...]
    pairs: int
    lessons: int
    coupling: int


def units_of(request: OptimizeScheduleRequest) -> list[Unit] | None:
    """The years of the week, the one that is hardest to lay first; None where the week has no such split.

    A UNIT IS A SET OF REQUIREMENTS THAT SHARE PUPILS OR A YEAR: the same pupil key, two keys that `groupConflicts` pairs, the
    members of one block (their lessons start together, so they are laid together), and the requirements of one year
    (`minGradeLevel`). A language group that draws on 7A and 8B joins their years, and a week where every year is joined to
    every other by such a group is one unit and is not laid this way. Teachers are NOT a join: two years that share a teacher are
    two steps, and the teacher's lessons in the first are what the second holds.

    THE ORDER is the design note's `hardest`: most pairs of groups that conflict inside the unit first (the unit with the
    least room to spare, laid while there is most of it), then the most lessons, then the most lessons of teachers who also
    teach in another unit, then the lowest year. The measurement found the order matters less than which year is laid second
    (4.3), and every order laid the weeks it was tried on; it is the one a person would pick."""
    requirements = request.requirements
    parent = list(range(len(requirements)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(first: int, second: int) -> None:
        a, b = find(first), find(second)
        if a != b:
            parent[max(a, b)] = min(a, b)

    anchors: dict[tuple[str, object], int] = {}

    def anchor(kind: str, key: object, index: int) -> None:
        seen = anchors.setdefault((kind, key), index)
        if seen != index:
            join(seen, index)

    for index, requirement in enumerate(requirements):
        anchor("pupil", _pupil_key(requirement), index)
        if requirement.block_id is not None:
            anchor("block", requirement.block_id, index)
        if requirement.min_grade_level is not None:
            anchor("year", requirement.min_grade_level, index)
    for first, second in request.group_conflicts:
        one, other = anchors.get(("pupil", first)), anchors.get(("pupil", second))
        if one is not None and other is not None:
            join(one, other)

    members: dict[int, list[int]] = defaultdict(list)
    for index in range(len(requirements)):
        members[find(index)].append(index)
    if len(members) < 2 or len(members) > MAX_UNITS:
        return None

    unit_of_key: dict[UUID, int] = {}
    for root, indices in members.items():
        for index in indices:
            unit_of_key[_pupil_key(requirements[index])] = root
    pairs: dict[int, int] = defaultdict(int)
    for first, second in request.group_conflicts:
        root = unit_of_key.get(first)
        if root is not None and root == unit_of_key.get(second):
            pairs[root] += 1
    teacher_units: dict[UUID, set[int]] = defaultdict(set)
    for root, indices in members.items():
        for index in indices:
            if requirements[index].teacher_id is not None:
                teacher_units[requirements[index].teacher_id].add(root)  # type: ignore[index]

    units: list[Unit] = []
    for root, indices in members.items():
        of_unit = [requirements[index] for index in indices]
        units.append(Unit(
            ids=frozenset(requirement.id for requirement in of_unit),
            years=tuple(sorted({r.min_grade_level for r in of_unit if r.min_grade_level is not None})),
            pairs=pairs[root],
            lessons=sum(requirement.lessons_per_week for requirement in of_unit),
            coupling=sum(
                requirement.lessons_per_week
                for requirement in of_unit
                if requirement.teacher_id is not None and len(teacher_units[requirement.teacher_id]) > 1
            ),
        ))
    units.sort(key=lambda unit: (-unit.pairs, -unit.lessons, -unit.coupling, unit.years or (99,)))
    return units


def places_of(requirement: AnonymousRequirement, laid: list[ScheduledLesson]) -> list[PinnedLesson]:
    """`laid`, a requirement's lessons, as its places: the order of `lesson_minutes()`, not the clock's.

    `pinnedLessons` has one place for each lesson in the order of the requirement's lengths (the longest first), and for a
    split post (`lessonTeacherIds`) place i is lead i's. A post of a 90- and a 60-minute lesson laid 60 on Monday and 90 on
    Tuesday has its 90 at place 0: pinned in the clock's order the engine would be asked to hold a Monday of 90 and a Tuesday
    of 60, another timetable than the one that was laid. ValueError where the lessons are not the requirement's places."""
    from_clock = sorted(laid, key=lambda lesson: (lesson.day_of_week, lesson.start_time))
    out: list[PinnedLesson] = []
    for index, length in enumerate(requirement.lesson_minutes()):
        lead = requirement.lesson_teacher(index) if requirement.lesson_teacher_ids is not None else None
        pick = next(
            (
                lesson for lesson in from_clock
                if _minutes(lesson.end_time) - _minutes(lesson.start_time) == length
                and (lead is None or lesson.teacher_id == lead)
            ),
            None,
        )
        if pick is None:
            msg = f"{requirement.id} has no lesson of {length} minutes laid for place {index}"
            raise ValueError(msg)
        from_clock.remove(pick)
        out.append(PinnedLesson(dayOfWeek=pick.day_of_week, startTime=pick.start_time, endTime=pick.end_time))
    if from_clock:
        msg = f"{requirement.id} has {len(from_clock)} more lessons laid than places"
        raise ValueError(msg)
    return out


def held_of(requirement: AnonymousRequirement, laid: list[ScheduledLesson]) -> list[PinnedLesson]:
    """The places a requirement is held on once it is laid: where its lessons are, a pin of the school's kept as it was made.

    A requirement the school pinned in part (a place or two of its lessons) is laid whole in its step, and is held whole in
    the steps after it: the places the school left open are where they were laid, or the step after would lay them again.
    A place the school pinned is the school's pin, whose room (if it names one) a place read off the answer does not have."""
    places = places_of(requirement, laid)
    if requirement.pinned_lessons is None:
        return places
    return [pin if pin is not None else place for pin, place in zip(requirement.pinned_lessons, places)]


def step_request(
    request: OptimizeScheduleRequest,
    free: frozenset[UUID],
    held: dict[UUID, list[PinnedLesson]],
    label: str,
) -> OptimizeScheduleRequest:
    """The week as one step asks it: `free` laid, `held` pinned where it was laid, every other requirement left out.

    `held` has an entry, a place for each lesson, for each requirement of the units laid so far (the school's own pins
    among them, kept as the school made them: `held_of`).

    The groups of the requirements in it and of their years follow (a class that has no lessons yet still eats, and a
    meal is the year's), and the pairs whose two ends are in it. Everything that is about the week and not about a
    requirement is the week's own: the frame, the reservations, the rooms, the rules, the locks (a lock is a fact about a
    class's time and a teacher's whatever year it is for). What a step does not ask is taken out: the schedule it
    is a hint toward (`previousLessons`) and the one it starts from (`startLessons`), which are for the whole week."""
    kept = [
        requirement.model_copy(update={"pinned_lessons": held[requirement.id]})
        if requirement.id in held
        else requirement
        for requirement in request.requirements
        if requirement.id in free or requirement.id in held
    ]
    classes = {requirement.student_group_id for requirement in kept}
    pupils = classes | {_pupil_key(requirement) for requirement in kept}
    years = {requirement.min_grade_level for requirement in kept}
    return request.model_copy(update={
        "request_id": uuid.UUID(int=uuid.uuid5(request.request_id, label).int, version=4),
        "requirements": kept,
        "groups": [group for group in request.groups if group.id in classes or group.min_grade_level in years],
        "group_conflicts": [
            pair for pair in request.group_conflicts if pair[0] in pupils and pair[1] in pupils
        ],
        "previous_lessons": [],
        "start_lessons": None,
    })
