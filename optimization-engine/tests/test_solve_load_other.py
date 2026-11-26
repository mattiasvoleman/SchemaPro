"""G6b, g391-L-5: the three short CP-SAT routes (a staffing proposal, an exam plan, a room proposal) are counted, and an analysis yields to them.

They share the cores with a Generera and with an analysis and were counted by nothing: an analysis started beside a staffing search and
slowed it down, and the other way round. Counted as a kind of their own (`OTHER`) around the thread's life, as the generator's is, and the
analysis answers the 429 it answers a Generera with while one runs.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Iterator

import pytest
from fastapi import HTTPException

from app.api.v1 import exams, rooms, staffing, suggest_changes
from app.config import Settings
from app.solve_load import ANALYSIS, GENERATION, OTHER, SOLVE_LOAD


@pytest.fixture
def at_zero() -> Iterator[None]:
    for kind in (GENERATION, ANALYSIS, OTHER):
        assert SOLVE_LOAD.count(kind) == 0
    yield
    for kind in (GENERATION, ANALYSIS, OTHER):
        assert SOLVE_LOAD.count(kind) == 0, "a solve left its count behind"


def _settings() -> Settings:
    return Settings(API_KEY="k" * 32, ALLOWED_ORIGINS="http://localhost")  # type: ignore[call-arg]


class _Blocking:
    """A solver whose `solve` holds until the test says so, and says what the count was while it held."""

    def __init__(self, answer: object) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.counted: dict[str, int] = {}
        self._answer = answer

    def solve(self, payload: object) -> object:
        self.counted = {kind: SOLVE_LOAD.count(kind) for kind in (GENERATION, ANALYSIS, OTHER)}
        self.entered.set()
        assert self.release.wait(10)
        return self._answer


@pytest.mark.parametrize(
    ("module", "solver_name", "runner", "payload_name"),
    [
        (staffing, "StaffingSolver", "run_staffing_solver", "StaffRequest"),
        (exams, "ExamSolver", "run_exam_solver", "PlanExamsRequest"),
        (rooms, "RoomWalkSolver", "run_room_solver", "OptimizeRoomsRequest"),
    ],
)
def test_each_short_route_counts_its_solve_while_the_thread_runs_and_leaves_nothing_behind(
    at_zero: None, monkeypatch: pytest.MonkeyPatch, module, solver_name, runner, payload_name,  # noqa: ANN001
) -> None:
    held = _Blocking(answer="answered")
    monkeypatch.setattr(module, solver_name, lambda settings: held)
    payload = type("Payload", (), {"request_id": "r-1", "search": None})()

    async def go() -> object:
        task = asyncio.ensure_future(getattr(module, runner)(payload, _settings()))
        await asyncio.to_thread(held.entered.wait, 10)
        assert held.counted[OTHER] == 1 and held.counted[GENERATION] == 0
        held.release.set()
        return await task

    assert asyncio.run(go()) == "answered"


@pytest.mark.parametrize(
    ("module", "solver_name", "runner"),
    [
        (staffing, "StaffingSolver", "run_staffing_solver"),
        (exams, "ExamSolver", "run_exam_solver"),
        (rooms, "RoomWalkSolver", "run_room_solver"),
    ],
)
def test_a_solve_that_raises_is_still_left_uncounted(
    at_zero: None, monkeypatch: pytest.MonkeyPatch, module, solver_name, runner,  # noqa: ANN001
) -> None:
    class Failing:
        def solve(self, payload: object) -> object:
            raise ValueError("boom")

    monkeypatch.setattr(module, solver_name, lambda settings: Failing())
    payload = type("Payload", (), {"request_id": "r-1", "search": None})()

    with pytest.raises(ValueError, match="boom"):
        asyncio.run(getattr(module, runner)(payload, _settings()))


def test_an_analysis_yields_to_a_short_solve_as_it_does_to_a_generera(at_zero: None) -> None:
    request = type("Request", (), {"app": type("App", (), {"state": type("State", (), {})()})()})()
    payload = type("Payload", (), {"request_id": "r-2", "search": None, "deadline_seconds": None})()

    with SOLVE_LOAD.running(OTHER, "a-staffing-search"):
        with pytest.raises(HTTPException) as busy:
            asyncio.run(suggest_changes.suggest_changes_route(payload, request, _settings()))  # type: ignore[arg-type]
    assert busy.value.status_code == 429
