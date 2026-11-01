"""Delade lokaler och lärare: the blocks the gateway sends for another school.

The engine learns nothing new: a shared teacher's lessons at another school
of the huvudman, the walk between the schools on both sides, arrive as the
recurring UNAVAILABLE rows on the teacher that a school writes by hand, and a
room lent to another school, or borrowed from one, as UNAVAILABLE rows on the
room (src/sharing/other-school-busy.ts and room-loan-windows.ts build them).
These tests hold the engine to what the gateway relies on:

  * a block keeps the teacher's (or room's) lessons out of it and no one
    else's, on the slot grid the gateway rounds it to;
  * a block that leaves a lesson nowhere refuses the week by name
    (AVAIL_CONSTRAINT_BLOCKS_LESSONS), with the row's id, which the gateway
    reads back as "Anna has lessons at Norraskolan";
  * a block on a day outside the school week is refused as input, which is
    why the gateway sends none for a weekend;
  * a borrowed room's complement of its windows, whole days included, leaves
    its lessons in the windows;
  * the payload the gateway sends for a school sharing many teachers builds
    in no time.

THE SCAFFOLDING is test_travel.py's: Monday 08:00–10:30, lessons of 60
minutes, a start step of 30.
"""

from __future__ import annotations

import time
from uuid import uuid4

import pytest

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver

ANNA = str(uuid4())
BO = str(uuid4())
CLASS_A = str(uuid4())
CLASS_B = str(uuid4())
ONE_DAY = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 630}
#: The production week, Monday to Friday, on the same short day.
SCHOOL_WEEK = {"SCHEDULE_DAYS": "1,2,3,4,5", "SCHEDULE_DAY_END_MINUTES": 630}


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, SOLVER_PROBE_SECONDS=5.0, **{**ONE_DAY, **overrides})  # type: ignore[arg-type]


def _room(kind: str | None = None) -> dict[str, object]:
    room: dict[str, object] = {"id": str(uuid4()), "capacity": 30}
    if kind is not None:
        room["type"] = kind
    return room


def _requirement(group: str, teacher: str, *, kind: str | None = None, lessons: int = 1) -> dict[str, object]:
    row: dict[str, object] = {
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher,
        "lessonsPerWeek": lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 24,
    }
    if kind is not None:
        row["requiredRoomType"] = kind
    return row


def _block(kind: str, resource: str, start: str, end: str, day: int = 1) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": kind,
        "resourceId": resource,
        "dayOfWeek": day,
        "startTime": start,
        "endTime": end,
        "kind": "UNAVAILABLE",
    }


def _solve(
    requirements: list[dict[str, object]],
    rooms: list[dict[str, object]],
    constraints: list[dict[str, object]],
    **settings: object,
):
    payload = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": rooms,
        "constraints": constraints,
    }
    return SchedulerSolver(_settings(**settings)).solve(OptimizeScheduleRequest.model_validate(payload))


def _starts(response, teacher_rows: set[str] | None = None) -> list[str]:  # noqa: ANN001
    return sorted(
        lesson.start_time for lesson in response.lessons
        if teacher_rows is None or str(lesson.requirement_id) in teacher_rows
    )


class TestSharedTeacherBlocks:
    def test_a_block_keeps_the_teacher_out_and_nobody_else(self) -> None:
        """Anna is at Norra 08:00–09:00 (her lesson there 08:15–08:45, 15 minutes each way)."""
        anna = _requirement(CLASS_A, ANNA)
        bo = _requirement(CLASS_B, BO)
        response = _solve([anna, bo], [_room(), _room()], [_block("TEACHER", ANNA, "08:00:00", "09:00:00")])
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _starts(response, {anna["id"]}) in (["09:00:00"], ["09:30:00"])
        assert len(_starts(response, {bo["id"]})) == 1

    def test_two_blocks_leave_the_one_start_between_them(self) -> None:
        anna = _requirement(CLASS_A, ANNA)
        response = _solve(
            [anna], [_room()],
            [_block("TEACHER", ANNA, "08:00:00", "08:30:00"), _block("TEACHER", ANNA, "09:30:00", "10:30:00")],
        )
        assert _starts(response) == ["08:30:00"]

    def test_a_block_on_another_day_holds_nothing_that_day_and_the_teacher_the_next(self) -> None:
        anna = _requirement(CLASS_A, ANNA)
        response = _solve(
            [anna], [_room()], [_block("TEACHER", ANNA, "08:00:00", "10:30:00", day=1)],
            SCHEDULE_DAYS="1,2",
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert [lesson.day_of_week for lesson in response.lessons] == [2]

    def test_a_block_outside_the_school_week_is_refused_as_input(self) -> None:
        """Why the gateway sends no block for a Saturday: the engine plans Monday to Friday."""
        anna = _requirement(CLASS_A, ANNA)
        with pytest.raises(InvalidScheduleInputError) as caught:
            _solve([anna], [_room()], [_block("TEACHER", ANNA, "08:00:00", "09:00:00", day=6)], **SCHOOL_WEEK)
        assert caught.value.code == "INPUT_CONSTRAINT_TIME_OFF_GRID"

    def test_a_week_the_block_leaves_no_room_in_is_refused_by_the_row(self) -> None:
        anna = _requirement(CLASS_A, ANNA)
        block = _block("TEACHER", ANNA, "08:00:00", "10:00:00")
        response = _solve([anna], [_room()], [block])
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        lines = [line for line in response.conflicts.conflicts if line.code == "AVAIL_CONSTRAINT_BLOCKS_LESSONS"]
        assert lines, [line.code for line in response.conflicts.conflicts]
        assert {str(i) for i in lines[0].constraint_ids} == {block["id"]}
        assert anna["id"] in {str(i) for i in lines[0].requirement_ids}

class TestRoomLoanBlocks:
    def test_a_lent_room_takes_no_lesson_in_the_window(self) -> None:
        gym = _room("GYM")
        pe = _requirement(CLASS_A, ANNA, kind="GYM")
        response = _solve([pe], [gym, _room()], [_block("ROOM", gym["id"], "08:00:00", "09:30:00")])
        assert _starts(response) == ["09:30:00"]

    def test_a_borrowed_room_holds_its_lessons_to_the_windows(self) -> None:
        """The gateway closes the room outside Tuesday's window 09:00–10:00, and the other weekdays whole."""
        gym = _room("GYM")
        pe = _requirement(CLASS_A, ANNA, kind="GYM")
        complement = [
            _block("ROOM", gym["id"], "00:00:00", "09:00:00", day=2),
            _block("ROOM", gym["id"], "10:00:00", "23:59:00", day=2),
            *(_block("ROOM", gym["id"], "00:00:00", "23:59:00", day=d) for d in (1, 3, 4, 5)),
        ]
        response = _solve([pe], [gym], complement, **SCHOOL_WEEK)
        assert [(lesson.day_of_week, lesson.start_time) for lesson in response.lessons] == [(2, "09:00:00")]

    def test_a_borrowed_room_with_no_window_that_fits_refuses_the_week_by_the_room(self) -> None:
        gym = _room("GYM")
        pe = _requirement(CLASS_A, ANNA, kind="GYM")
        closed = [_block("ROOM", gym["id"], "00:00:00", "09:00:00"), _block("ROOM", gym["id"], "09:30:00", "23:59:00")]
        response = _solve([pe], [gym], closed)
        assert response.status == "INFEASIBLE"
        named = {str(i) for line in response.conflicts.conflicts for i in line.constraint_ids}
        assert named & {row["id"] for row in closed}


class TestManyBlocks:
    def test_a_school_sharing_forty_teachers_builds_at_once(self) -> None:
        """Forty shared teachers, five blocks a week each: two hundred rows."""
        teachers = [str(uuid4()) for _ in range(40)]
        groups = [str(uuid4()) for _ in range(40)]
        requirements = [_requirement(g, t) for g, t in zip(groups, teachers)]
        blocks = [_block("TEACHER", t, "08:00:00", "08:30:00", day=d) for t in teachers for d in range(1, 6)]
        rooms = [_room() for _ in range(40)]
        started = time.monotonic()
        response = _solve(requirements, rooms, blocks, **SCHOOL_WEEK)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert all(lesson.start_time != "08:00:00" for lesson in response.lessons)
        assert time.monotonic() - started < 20
