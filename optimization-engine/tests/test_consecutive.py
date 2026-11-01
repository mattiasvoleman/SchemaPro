"""Sammanhängande undervisning: at most X minutes of teaching in a row, then Y free.

THE ORACLE IS THE POINT. A short week — one teacher, a handful of lessons on a
two-hour day — is small enough to try EVERY placement of the lessons, and for
each one the model must say what the definition says: the pinned week is
feasible exactly when the teacher is in one room at a time and no stretch with
one of the solver's lessons in it is longer than the limit. A rule that refuses
a placement the definition allows is a refused week (never allowed), and one
that allows what the definition forbids is a rule that holds nothing. The
definition below shares no code with app/solver/consecutive.py.

THE SCAFFOLDING IS test_teacher_day.py's: 08:00-... days of 60-minute lessons
make every case arithmetic a reader can do in their head.
"""

from __future__ import annotations

import itertools
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.consecutive import locked_stretches, merge_windows, stretches
from app.solver.scheduler_solver import SchedulerSolver, _start_step

TEACHER = str(uuid4())
GROUP = str(uuid4())
RULE = str(uuid4())
REQUIREMENT = str(uuid4())
OTHER_REQUIREMENT = str(uuid4())
OTHER_GROUP = str(uuid4())
OTHER_TEACHER = str(uuid4())


def _settings(*, day_end: int = 720, days: str = "1", **overrides: object) -> Settings:
    return Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=10.0,
        SCHEDULE_DAYS=days,
        SCHEDULE_DAY_END_MINUTES=day_end,
        **overrides,
    )


def _payload(
    *,
    limit: int | None,
    pause: int | None,
    lengths: list[int],
    locked: list[tuple[str, str, int]] | None = None,
    recurrence: list[str | None] | None = None,
) -> dict[str, object]:
    """One teacher with one requirement per lesson, each in a class of its own."""
    requirements = []
    for index, minutes in enumerate(lengths):
        requirements.append({
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": TEACHER,
            "lessonsPerWeek": 1,
            "minutesPerLesson": minutes,
            "studentGroupSize": 20,
            **({"recurrence": recurrence[index]} if recurrence and recurrence[index] else {}),
        })
    rule: dict[str, object] = {"id": RULE, "teacherId": TEACHER}
    if limit is not None:
        rule["maxConsecutiveTeachingMinutes"] = limit
        rule["consecutiveBreakMinutes"] = pause
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in lengths],
        "fixedLessons": [
            {
                "id": str(uuid4()),
                "teacherId": TEACHER,
                "studentGroupId": str(uuid4()),
                "dayOfWeek": 1,
                "startTime": f"{start}:00",
                "endTime": f"{end}:00",
                **({"recurrence": week} if week else {}),
            }
            for start, end, *rest in (locked or [])
            for week in [rest[0] if rest else None]
        ],
        "teacherWorkRules": [rule],
    }


def _model(payload: dict[str, object], **settings: object):
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    return solver, request, solver._build_model(
        request, use_assumptions=False, include_objective=False,
    )


def _minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:5])


def _accepted(solver, model, decisions, starts: list[int]) -> bool:
    """Whether the model takes these lessons at these start slots (day 0)."""
    clone = model.Clone()
    for decision, start in zip(decisions, starts):
        clone.Add(decision.start == start)
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10
    status = cp.Solve(clone)
    assert status != cp_model.MODEL_INVALID, clone.Validate()
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def _oracle(
    solver, decisions, starts: list[int], limit: int, pause: int,
    locked: list[tuple[int, int]],
) -> bool:
    """The definition, from the module docstring, on minutes and nothing else."""
    slot = solver._grid.slot_minutes
    base = solver._grid.day_start_minutes
    placed = [
        (base + start * slot, base + (start + decision.duration) * slot, True)
        for decision, start in zip(decisions, starts)
    ]
    held = [(start, end, False) for start, end in locked]
    # One room at a time: the solver's lessons against each other and the locks.
    spans = sorted(placed + held)
    for (_s1, e1, _p1), (s2, _e2, _p2) in zip(spans, spans[1:]):
        if s2 < e1:
            return False
    stretch = None
    for start, end, is_placed in spans:
        if stretch is not None and start - stretch[1] < pause:
            stretch[1] = max(stretch[1], end)
            stretch[2] = stretch[2] or is_placed
        else:
            if stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit:
                return False
            stretch = [start, end, is_placed]
    return not (stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit)


class TestHelpers:
    def test_a_lesson_less_than_the_break_after_the_stretch_joins_it(self) -> None:
        assert stretches([(0, 12), (15, 24)], 4) == [(0, 24)]
        assert stretches([(0, 12), (16, 24)], 4) == [(0, 12), (16, 24)]

    def test_an_overlapping_lesson_joins_and_the_latest_end_counts(self) -> None:
        assert stretches([(0, 20), (4, 8), (24, 30)], 4) == [(0, 20), (24, 30)]
        assert stretches([(0, 20), (4, 8), (22, 30)], 4) == [(0, 30)]

    def test_locked_stretches_never_join_across_a_night(self) -> None:
        # Absolute slots: Monday's last slot is next to Tuesday's first.
        assert locked_stretches([(100, 120), (120, 130)], 6, 120) == [(100, 120), (120, 130)]

    def test_merge_windows_merges_touching_windows_within_a_day_only(self) -> None:
        assert merge_windows([(0, 12), (12, 18), (30, 36)], 120) == [(0, 18), (30, 36)]
        assert merge_windows([(108, 120), (120, 132)], 120) == [(108, 120), (120, 132)]


CASES = [
    # (limit, pause, lengths, locked windows (hh:mm, hh:mm))
    (120, 30, [60, 60, 60], []),
    (120, 15, [60, 60, 60], []),
    (120, 30, [40, 60, 80], []),
    (90, 15, [40, 40, 40], []),
    (120, 30, [60, 60], [("10:00", "11:00")]),
    (120, 30, [60, 60], [("08:00", "11:00")]),
    (180, 30, [60, 60], [("08:00", "09:00"), ("09:10", "10:00")]),
]


@pytest.mark.parametrize(("limit", "pause", "lengths", "locked"), CASES)
def test_every_placement_is_accepted_exactly_when_the_definition_allows_it(
    limit: int, pause: int, lengths: list[int], locked: list[tuple[str, str]],
) -> None:
    payload = _payload(
        limit=limit, pause=pause, lengths=lengths,
        locked=[(start, end, 0) for start, end in locked],
    )
    for entry in payload["fixedLessons"]:  # type: ignore[union-attr]
        entry.pop("recurrence", None)
    solver, request, (model, _registry, decisions, *_rest) = _model(payload)
    spd = solver._grid.slots_per_day
    slot = solver._grid.slot_minutes
    windows = [(_minutes(start), _minutes(end)) for start, end in locked]
    # Every start the model's own step allows: a 15-minute break pulls the step
    # down to a quarter of an hour, a 30-minute one leaves the half hour.
    grid = range(0, spd, _start_step(request, solver._grid))
    tried = accepted = 0
    for starts in itertools.product(grid, repeat=len(decisions)):
        if any(
            start + decision.duration > spd for decision, start in zip(decisions, starts)
        ):
            continue
        want = _oracle(solver, decisions, list(starts), limit, pause, windows)
        got = _accepted(solver, model, decisions, list(starts))
        assert got == want, (
            f"placement {[solver._grid.day_start_minutes + s * slot for s in starts]} "
            f"limit {limit} break {pause}: the model says {got}, the definition {want}"
        )
        tried += 1
        accepted += got
    assert tried > 0
    # The rule must be binding for the case to prove anything: some placement
    # the teacher's own no-overlap allows is refused.
    assert accepted < tried
