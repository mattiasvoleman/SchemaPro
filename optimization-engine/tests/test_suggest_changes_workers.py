"""Åtgärdsförslag vid vägran: the search and the check never take every core of a shared engine unasked.

`SearchOptions.workers` absent is CP-SAT's own default: every core. A Generera of another school can be
running in the same process, and this route's gate does not hold /optimize back, so the route gives itself
DEFAULT_WORKERS (4, the design note's D2) when the request names none, in the search AND in the check.
"""

from __future__ import annotations

import pytest

from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse
from app.solver import suggestions
from app.solver.scheduler_solver import SchedulerSolver
from tests.test_suggest_changes import _cap_week, _request, _suggest


def _spy(monkeypatch: pytest.MonkeyPatch) -> tuple[list[int | None], list[int | None]]:
    searched: list[int | None] = []
    checked: list[int | None] = []
    original = SchedulerSolver.solve
    real_check = suggestions.strict_accepts

    def solve(self: SchedulerSolver, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        # solve() builds a solver of its own for a request that carries `search` and calls itself again:
        # the first call is the route's.
        searched.append(None if request.search is None else request.search.workers)
        return original(self, request)

    def check(*args: object, **kwargs: object) -> bool:
        checked.append(kwargs.get("workers"))  # type: ignore[arg-type]
        return real_check(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(SchedulerSolver, "solve", solve)
    monkeypatch.setattr(suggestions, "strict_accepts", check)
    return searched, checked


def test_a_request_that_names_no_workers_gets_four_in_the_search_and_in_the_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload, days, end = _cap_week()
    searched, checked = _spy(monkeypatch)
    response = _suggest(payload, days=days, end=end)
    assert response.verified is True
    assert searched[0] == 4
    assert checked == [4]


def test_a_request_that_names_workers_gets_exactly_those(monkeypatch: pytest.MonkeyPatch) -> None:
    payload, days, end = _cap_week()
    payload["search"] = {"maxSeconds": 9, "workers": 2}
    searched, checked = _spy(monkeypatch)
    _suggest(payload, days=days, end=end)
    assert searched[0] == 2
    assert checked == [2]
    payload["search"] = {"maxSeconds": 9, "workers": 16}
    searched.clear()
    checked.clear()
    _suggest(payload, days=days, end=end)
    assert searched[0] == 16 and checked == [16]


def test_the_default_is_a_number_a_request_could_have_named() -> None:
    # SearchOptions.workers is 1..16: a default outside it would be a number the engine hands itself and refuses a caller.
    assert suggestions.DEFAULT_WORKERS == 4
    request = _request(_cap_week()[0])
    OptimizeScheduleRequest.model_validate(
        {**request.model_dump(by_alias=True, mode="json"), "search": {"workers": suggestions.DEFAULT_WORKERS}},
    )
