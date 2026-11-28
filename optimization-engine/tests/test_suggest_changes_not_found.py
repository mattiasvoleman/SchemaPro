"""Åtgärdsförslag vid vägran: "found nothing in N seconds" says the N the search really had.

A caller that waits less than the engine's budget leaves the search less time (app.timing.Deadline); the TIMEOUT it
ends in carries the budget it ran on (TimeoutReport.budget_seconds). NOT_FOUND used to say the nominal one.
"""

from __future__ import annotations

import pytest

from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.suggestions import suggest_changes
from tests.test_suggest_changes import _cap_week, _engine, _request, _suggest


def test_a_caller_that_waits_six_seconds_is_not_told_the_search_had_twenty() -> None:
    payload, days, end = _cap_week()
    response = suggest_changes(
        _request({**payload, "deadlineSeconds": 6}),
        _engine(SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end),
        ceiling_seconds=200.0,
    )
    assert response.verdict == "NOT_FOUND"
    assert response.search_seconds == 0


def test_a_week_that_was_found_says_the_seconds_the_search_was_asked_for() -> None:
    payload, days, end = _cap_week()
    assert _suggest(payload, days=days, end=end).search_seconds == 20


def test_the_budget_the_report_says_is_the_one_given(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.schemas.schedule import TimeoutReport

    payload, days, end = _cap_week()

    def timeout(self: SchedulerSolver, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        report = TimeoutReport.model_validate({
            "totalSeconds": 9.0, "budgetSeconds": 7, "configuredBudgetSeconds": 20, "stages": [], "search": {"phases": []},
        })
        return OptimizeScheduleResponse(request_id=request.request_id, status="TIMEOUT", lessons=[], report=report)

    monkeypatch.setattr(SchedulerSolver, "solve", timeout)
    response = _suggest(payload, days=days, end=end)
    assert response.verdict == "NOT_FOUND" and response.search_seconds == 7
    # Never more than the seconds it was asked for, whatever a report says.
    monkeypatch.setattr(
        SchedulerSolver, "solve",
        lambda self, request: OptimizeScheduleResponse(
            request_id=request.request_id, status="TIMEOUT", lessons=[],
            report=TimeoutReport.model_validate({
                "totalSeconds": 9.0, "budgetSeconds": 90, "configuredBudgetSeconds": 90, "stages": [], "search": {"phases": []},
            }),
        ),
    )
    assert _suggest(payload, days=days, end=end).search_seconds == 20


def test_a_not_found_carries_the_account_of_where_the_search_s_time_went_and_nothing_else_does(monkeypatch: pytest.MonkeyPatch) -> None:
    """G6b, g384-L-4: "found nothing in 60 s" did not say whether the minute was the builds or the search. M2's report did, and was dropped."""
    from app.schemas.schedule import TimeoutReport

    payload, days, end = _cap_week()
    report = TimeoutReport.model_validate({
        "totalSeconds": 61.0, "budgetSeconds": 20, "configuredBudgetSeconds": 20,
        "stages": [{"stage": "BUILD", "seconds": 41.0}, {"stage": "SEARCH_CLEAN", "seconds": 20.0}],
        "search": {"phases": [{"phase": "CLEAN", "seconds": 20.0, "conflicts": 5, "branches": 9}]},
    })
    monkeypatch.setattr(
        SchedulerSolver, "solve",
        lambda self, request: OptimizeScheduleResponse(request_id=request.request_id, status="TIMEOUT", lessons=[], report=report),
    )

    lost = _suggest(payload, days=days, end=end)

    assert lost.verdict == "NOT_FOUND" and lost.report == report
    bytes_of = lost.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert bytes_of["report"]["stages"][0] == {"stage": "BUILD", "seconds": 41.0}

    monkeypatch.undo()
    found = _suggest(payload, days=days, end=end)
    assert found.verdict == "CHANGES" and found.report is None
    assert "report" not in found.model_dump(mode="json", by_alias=True)
