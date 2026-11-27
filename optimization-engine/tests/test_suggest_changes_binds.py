"""G6b, g384-L-2, end to end: the cap a week with a locked lesson over it needs is the cap the answer names.

`tests/test_suggest_changes_refine.py::TestTheWeekThatBinds` holds the choice of week (`_worst_week`) on hand-made lines. This holds what the
choice is for, on the real solver: one day, the teacher's cap 60 minutes, a 30-minute lesson every week, a 90-minute lesson on even weeks and the
teacher's own locked 120-minute lesson on odd weeks. The odd week needs 30 + 120 = 150 minutes though the generated lessons go over by only 30;
the even week needs 90 + 30 = 120 and goes over by 60. Chosen by `over` the answer said 120, which the strict solver refuses.
"""

from __future__ import annotations

from uuid import uuid4

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver
from tests.test_suggest_changes import _request, _settings, _strict_solves, _suggest


def _week(cap: int = 60) -> dict[str, object]:
    teacher, room, subject, group_a, group_b, group_c = (str(uuid4()) for _ in range(6))
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "rooms": [{"id": room, "capacity": 30}],
        "requirements": [
            {"id": str(uuid4()), "subjectId": subject, "studentGroupId": group_a, "teacherId": teacher, "lessonsPerWeek": 1,
             "minutesPerLesson": 30, "studentGroupSize": 20, "minGradeLevel": 7, "maxGradeLevel": 7},
            {"id": str(uuid4()), "subjectId": subject, "studentGroupId": group_b, "teacherId": teacher, "lessonsPerWeek": 1,
             "minutesPerLesson": 90, "studentGroupSize": 20, "minGradeLevel": 8, "maxGradeLevel": 8, "recurrence": "EVEN_WEEKS"},
        ],
        "fixedLessons": [{
            "id": str(uuid4()), "teacherId": teacher, "studentGroupId": group_c, "roomId": room, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "10:00:00", "recurrence": "ODD_WEEKS",
        }],
        "teacherWorkRules": [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": cap}],
    }


def test_the_answer_names_the_cap_of_the_week_that_binds_and_the_strict_solver_agrees() -> None:
    payload = _week()

    answer = _suggest(payload, days="1", end=720)

    (change,) = answer.changes
    assert (change.current, change.needed) == (60, 150), "the odd week needs 150; the even week, which goes over by more, needs 120"
    assert (change.proof, change.needed_is_least) == ("SOLVED", True)
    assert answer.verified is True
    # The oracle shares nothing with the check: the strict solver, asked cold.
    assert _strict_solves(_request(_week(cap=150) | {"requestId": payload["requestId"]}), days="1") is True
    assert _strict_solves(_request(_week(cap=120)), days="1") is False


def test_the_line_a_generera_with_the_five_rules_free_reports_says_the_same_week() -> None:
    payload = _week() | {"relaxation": {"mode": "BEST_EFFORT"}, "search": {"maxSeconds": 5, "workers": 2}}

    response = SchedulerSolver(_settings(days="1", end=720)).solve(OptimizeScheduleRequest.model_validate(payload))

    (line,) = [d for d in (response.deviations or []) if d.code == "DEVIATION_TEACHER_DAILY_CAP"]
    assert (line.params["needed"], line.params["over"]) == (150, 30)
