"""Halvklasser: two halves of one class rotate through the same hour.

7A is split into 7A:1 and 7A:2 (src/common/class-halves.ts). 7A:1 has
trä- och metallslöjd while 7A:2 has NO in the lab, and the halves swap
after; nothing else of 7A's may run beside either. The engine has no notion
of a half and needs none: the gateway sends each half paired with its class
in `groupConflicts` — and with every group of the class's pupils still placed
in no half — and never pairs the two halves. The engine's pairwise
no-overlap then lets the halves share an hour that the class itself cannot
spare. These tests pin that the solver reads the pairs that way, so a change
to how groupConflicts are built cannot quietly turn the rotation off.

ONE DAY of five hours (08:00-13:00, Monday only): 7A has three hours of
svenska and each half a two-hour lesson. The day holds the week only if the
two halves take the same two hours.
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import UUID, uuid4

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest, ScheduledLesson
from app.solver.scheduler_solver import SchedulerSolver

#: 08:00-13:00, Monday only.
ONE_SHORT_DAY = {"SCHEDULE_DAY_END_MINUTES": 780, "SCHEDULE_DAYS": "1"}

CLASS_7A = str(uuid4())
HALF_1 = str(uuid4())
HALF_2 = str(uuid4())
MA7 = str(uuid4())
SVENSKA = str(uuid4())
SLOJD = str(uuid4())
NO = str(uuid4())
MATEMATIK = str(uuid4())


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, **{**ONE_SHORT_DAY, **overrides})  # type: ignore[arg-type]


def _requirement(requirement_id: str, group: str, lessons: int, minutes: int, size: int) -> dict[str, object]:
    return {
        "id": requirement_id,
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": str(uuid4()),
        "lessonsPerWeek": lessons,
        "minutesPerLesson": minutes,
        "studentGroupSize": size,
    }


def _payload(
    conflicts: list[list[str]], *, with_ma7: bool = False, svenska: int = 3, no_minutes: int = 120,
) -> dict[str, object]:
    """7A's svenska, 7A:1's slöjd and 7A:2's NO; Ma7 (cut from 7A) when asked."""
    requirements = [
        _requirement(SVENSKA, CLASS_7A, svenska, 60, 24),
        _requirement(SLOJD, HALF_1, 1, 120, 12),
        _requirement(NO, HALF_2, 1, no_minutes, 12),
    ]
    if with_ma7:
        requirements.append(_requirement(MATEMATIK, MA7, 1, 60, 8))
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [{"id": CLASS_7A, "lunchHeadcount": 24}],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(4)],
        "groupConflicts": conflicts,
    }


#: What the gateway sends for 7A's halves before anyone is placed in them.
BEFORE_PLACEMENT = [[CLASS_7A, HALF_1], [CLASS_7A, HALF_2]]


def _solve(payload: dict[str, object]) -> tuple[str, list[ScheduledLesson]]:
    response = SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))
    return response.status, response.lessons


def _spans(lessons: list[ScheduledLesson], requirement_id: str) -> list[tuple[int, int]]:
    def minutes(clock: str) -> int:
        hours, mins, *_ = (int(part) for part in clock.split(":"))
        return hours * 60 + mins

    return sorted(
        (minutes(lesson.start_time), minutes(lesson.end_time))
        for lesson in lessons
        if lesson.requirement_id == UUID(requirement_id)
    )


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> bool:
    return any(start < other_end and other_start < end for start, end in a for other_start, other_end in b)


def _validate(payload: dict[str, object], lessons: list[ScheduledLesson]) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    return validate(SchedulerSolver(_settings())._grid, OptimizeScheduleRequest.model_validate(payload), lessons)


def test_the_two_halves_share_the_hour_the_class_cannot_spare() -> None:
    payload = _payload(BEFORE_PLACEMENT)
    status, lessons = _solve(payload)

    assert status in {"OPTIMAL", "FEASIBLE"}
    slojd, no, svenska = _spans(lessons, SLOJD), _spans(lessons, NO), _spans(lessons, SVENSKA)
    # The rotation: the two halves' lessons are the same two hours …
    assert slojd == no
    # … and nothing of the class's own runs beside either half.
    assert not _overlap(slojd, svenska)
    assert not _overlap(no, svenska)
    assert _validate(payload, lessons) == []


def test_halves_paired_with_each_other_cannot_rotate_and_the_day_does_not_hold() -> None:
    """Non-vacuity: the hour is found only because the halves are not paired."""
    status, _ = _solve(_payload([*BEFORE_PLACEMENT, [HALF_1, HALF_2]]))

    assert status == "INFEASIBLE"


def test_a_group_cut_from_the_class_keeps_off_both_halves_until_its_pupils_are_placed() -> None:
    """Ma7 holds pupils of 7A who may end up in either half: it pairs with both.

    Two hours of svenska, 7A:1's two-hour slöjd and 7A:2's three-hour NO: the
    halves take three hours of the day together, and Ma7's one hour fits only
    in NO's third hour, beside 7A:2 and clear of 7A:1.
    """
    conflicts = [*BEFORE_PLACEMENT, [CLASS_7A, MA7], [MA7, HALF_1], [MA7, HALF_2]]
    status, _ = _solve(_payload(conflicts, with_ma7=True, svenska=2, no_minutes=180))

    # Before placement Ma7 keeps off both halves: no hour is left for it.
    assert status == "INFEASIBLE"

    # Once Ma7's pupils are all placed in 7A:1, 7A:2's NO may run beside Ma7.
    placed = [*BEFORE_PLACEMENT, [CLASS_7A, MA7], [MA7, HALF_1]]
    payload = _payload(placed, with_ma7=True, svenska=2, no_minutes=180)
    status, lessons = _solve(payload)

    assert status in {"OPTIMAL", "FEASIBLE"}
    assert not _overlap(_spans(lessons, MATEMATIK), _spans(lessons, SLOJD))
    assert _overlap(_spans(lessons, MATEMATIK), _spans(lessons, NO))
    assert _validate(payload, lessons) == []


def test_a_block_of_the_two_halves_holds_them_to_one_hour_and_is_not_refused() -> None:
    """A school that wants the rotation, and not just allows it, blocks the two posts.

    One hour of svenska leaves the day room for the halves to part, so
    nothing but the block (4.2, Parallella block) makes them meet. The block
    is accepted because the halves are never paired: had the gateway paired
    them, the engine would refuse it as a block of groups sharing pupils.
    """
    block = str(uuid4())
    payload = _payload(BEFORE_PLACEMENT, svenska=1)
    for requirement in payload["requirements"]:  # type: ignore[union-attr]
        if requirement["id"] in (SLOJD, NO):
            requirement["blockId"] = block
    status, lessons = _solve(payload)

    assert status in {"OPTIMAL", "FEASIBLE"}
    assert _spans(lessons, SLOJD) == _spans(lessons, NO)
    assert _validate(payload, lessons) == []

    paired = {**payload, "groupConflicts": [*BEFORE_PLACEMENT, [HALF_1, HALF_2]]}
    try:
        SchedulerSolver(_settings())._validate_request(OptimizeScheduleRequest.model_validate(paired))
    except InvalidScheduleInputError as error:
        assert error.code == "BLOCK_MEMBERS_SHARE_PUPILS"
    else:
        raise AssertionError("a block of paired halves was accepted")
