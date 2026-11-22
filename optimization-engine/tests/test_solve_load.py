"""Åtgärdsförslag vid vägran: /optimize and /suggest-changes share one count of the solves this process runs.

The analysis route had a gate of one for analyses and knew nothing of a Generera, so an analysis for one school could
start beside, and take the cores from, a Generera for another school on the same engine (review of #384). The count
(app.solve_load) is held by `run_solver`, which both /api/v1/optimize and the legacy /v1/schedule go through, and read by
the analysis route, which answers 429 while a Generera runs. A Generera itself is never refused.

What these tests keep: the count is the THREAD'S life and not the answer's (a 503 ends the wait, not the work), both
entrances to a Generera are counted, the analysis is refused and never started beside one, a Generera beside an analysis
is let through and logged, and the count is back at zero when each of them ends.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse
from app.solve_load import ANALYSIS, GENERATION, SOLVE_LOAD, SolveLoad
from app.solver.scheduler_solver import SchedulerSolver
from app.timing import TRANSFER_MARGIN_SECONDS
from tests import test_optimize as to
from tests.test_suggest_changes import HEADERS, _app_settings, _body

REFUSAL = "A timetable is being generated on this engine. Try again in a moment."


def _events(caplog: pytest.LogCaptureFixture, name: str) -> list[dict[str, object]]:
    """The structured log lines called `name`, parsed: what production's log search would read."""
    found: list[dict[str, object]] = []
    for record in caplog.records:
        try:
            line = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(line, dict) and line.get("event") == name:
            found.append(line)
    return found


def _wait_until_zero(kind: str) -> None:
    for _ in range(200):
        if SOLVE_LOAD.count(kind) == 0:
            return
        threading.Event().wait(0.05)
    raise AssertionError(f"{SOLVE_LOAD.count(kind)} solve(s) of kind {kind} still counted after ten seconds")


# ---------------------------------------------------------------------------
# The count
# ---------------------------------------------------------------------------


def test_a_solve_is_counted_for_the_block_and_by_kind() -> None:
    load = SolveLoad()
    assert (load.count(GENERATION), load.count(ANALYSIS)) == (0, 0)

    with load.running(GENERATION):
        with load.running(GENERATION):
            with load.running(ANALYSIS):
                assert (load.count(GENERATION), load.count(ANALYSIS)) == (2, 1)
            assert (load.count(GENERATION), load.count(ANALYSIS)) == (2, 0)
        assert (load.count(GENERATION), load.count(ANALYSIS)) == (1, 0)
    assert (load.count(GENERATION), load.count(ANALYSIS)) == (0, 0)


def test_a_solve_that_fails_is_not_counted_afterwards() -> None:
    load = SolveLoad()

    with pytest.raises(RuntimeError):
        with load.running(GENERATION):
            raise RuntimeError("the solve failed")

    assert load.count(GENERATION) == 0


def test_a_kind_nobody_named_is_refused_and_counts_nothing() -> None:
    load = SolveLoad()

    with pytest.raises(ValueError):
        with load.running("weekbounds"):
            pass

    assert (load.count(GENERATION), load.count(ANALYSIS)) == (0, 0)


# ---------------------------------------------------------------------------
# The analysis yields to a Generera, whichever school's
# ---------------------------------------------------------------------------


def test_an_analysis_is_refused_429_while_a_generation_runs_and_is_never_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1 import suggest_changes as route

    started: list[int] = []
    real = route.suggest_changes

    def spy(*args: object, **kwargs: object) -> object:
        started.append(1)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(route, "suggest_changes", spy)
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        with SOLVE_LOAD.running(GENERATION):
            refused = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)

        assert refused.status_code == 429
        assert REFUSAL in refused.text
        assert started == [], "no analysis may be started beside a Generera"
        # Refused before the gate is reached: nothing was taken from it.
        gate = getattr(client.app.state, "suggest_changes_gate", None)
        assert gate is None or not gate.locked()

        # With the Generera over the same request is taken: the refusal is for as long as the Generera runs.
        taken = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
        assert taken.status_code == 200
        assert started == [1]


def test_an_analysis_beside_another_analysis_is_still_the_gates_429_and_not_this_ones() -> None:
    """The two refusals are told apart in the body: a Generera's is the new one, an analysis's is the gate's."""
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        client.app.state.suggest_changes_gate = asyncio.Semaphore(0)  # type: ignore[attr-defined]
        refused = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)

    assert refused.status_code == 429
    assert "Another analysis is running" in refused.text
    assert REFUSAL not in refused.text


def test_a_generation_that_outlived_its_503_still_holds_the_analysis_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """The count is the thread's life: a 503 ends the wait, and the solve goes on taking the cores."""
    from app.api.v1 import optimize

    released = threading.Event()
    seen: list[int] = []

    def stuck(self: SchedulerSolver, payload: OptimizeScheduleRequest) -> None:
        seen.append(SOLVE_LOAD.count(GENERATION))
        released.wait(timeout=10.0)
        raise RuntimeError("the solve was given up on")

    monkeypatch.setattr(SchedulerSolver, "solve", stuck)
    monkeypatch.setattr(optimize, "_SOLVE_BUILD_HEADROOM_SECONDS", 0.2)
    app = create_app(to._settings(SOLVER_MAX_TIME_SECONDS=0.1, SOLVER_PROBE_SECONDS=0.1, SCHEDULE_DAYS="1,2,3",
                                  SCHEDULE_DAY_END_MINUTES=720))

    with TestClient(app) as client:
        try:
            generated = client.post("/api/v1/optimize", json=to._sample_payload(), headers=HEADERS)
            assert generated.status_code == 503, generated.text
            assert seen == [1], "the solve was counted from the moment its thread began"

            beside = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
            assert beside.status_code == 429, "the 503 ended the wait, the thread still holds the cores"
            assert REFUSAL in beside.text
            assert SOLVE_LOAD.count(GENERATION) == 1
        finally:
            released.set()
        _wait_until_zero(GENERATION)
        assert SOLVE_LOAD.count(GENERATION) == 0


@pytest.mark.parametrize("path", ["/api/v1/optimize", "/v1/schedule"])
def test_both_entrances_to_a_generation_are_counted_and_leave_the_count_at_zero(
    path: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[int, int]] = []
    original = SchedulerSolver.solve

    def spy(self: SchedulerSolver, payload: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        seen.append((SOLVE_LOAD.count(GENERATION), SOLVE_LOAD.count(ANALYSIS)))
        return original(self, payload)

    monkeypatch.setattr(SchedulerSolver, "solve", spy)
    with TestClient(create_app(to._settings())) as client:
        response = client.post(path, json=to._sample_payload(), headers=HEADERS)

    assert response.status_code == 200, response.text
    assert seen == [(1, 0)]
    assert SOLVE_LOAD.count(GENERATION) == 0


def test_an_analysis_is_counted_for_the_length_of_its_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.api.v1 import suggest_changes as route

    real = route.suggest_changes
    seen: list[tuple[int, int]] = []

    def spy(*args: object, **kwargs: object) -> object:
        seen.append((SOLVE_LOAD.count(GENERATION), SOLVE_LOAD.count(ANALYSIS)))
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(route, "suggest_changes", spy)
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        assert client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS).status_code == 200

    assert seen == [(0, 1)]
    _wait_until_zero(ANALYSIS)


# ---------------------------------------------------------------------------
# A Generera is never refused, and says when it started beside an analysis
# ---------------------------------------------------------------------------


def test_a_generation_beside_a_running_analysis_is_let_through_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    with TestClient(create_app(to._settings())) as client:
        with caplog.at_level(logging.WARNING):
            with SOLVE_LOAD.running(ANALYSIS):
                response = client.post("/api/v1/optimize", json=to._sample_payload(), headers=HEADERS)

    assert response.status_code == 200, response.text
    assert "generation_beside_analysis" in caplog.text


def test_a_generation_alone_logs_nothing_of_the_kind(caplog: pytest.LogCaptureFixture) -> None:
    with TestClient(create_app(to._settings())) as client:
        with caplog.at_level(logging.WARNING):
            response = client.post("/api/v1/optimize", json=to._sample_payload(), headers=HEADERS)

    assert response.status_code == 200, response.text
    assert "generation_beside_analysis" not in caplog.text


def test_the_refusal_is_logged_as_the_line_production_is_to_count(caplog: pytest.LogCaptureFixture) -> None:
    """DEPLOYMENT 33.4 tells whoever reads production to count `suggest_changes_yields_to_generation` before anything is built
    to stop an analysis: the line, its level and what it carries are part of that, and were pinned by nothing."""
    body = _body()
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        with caplog.at_level(logging.WARNING):
            with SOLVE_LOAD.running(GENERATION):
                with SOLVE_LOAD.running(GENERATION):  # two, so that the logged number is the count and not a constant
                    refused = client.post("/api/v1/suggest-changes", json=body, headers=HEADERS)

    assert refused.status_code == 429
    (line,) = _events(caplog, "suggest_changes_yields_to_generation")
    assert line["level"] == "warning"
    assert line["request_id"] == body["requestId"]
    assert line["generations_running"] == 2


def test_the_generation_beside_an_analysis_logs_whose_it_is_and_how_many(caplog: pytest.LogCaptureFixture) -> None:
    """The other line the same measurement reads: `generation_beside_analysis`, with the Generera's own request id."""
    payload = to._sample_payload()
    with TestClient(create_app(to._settings())) as client:
        with caplog.at_level(logging.WARNING):
            with SOLVE_LOAD.running(ANALYSIS):
                with SOLVE_LOAD.running(ANALYSIS):  # two, so that the logged number is the count and not a constant
                    response = client.post("/api/v1/optimize", json=payload, headers=HEADERS)

    assert response.status_code == 200, response.text
    (line,) = _events(caplog, "generation_beside_analysis")
    assert line["level"] == "warning"
    assert line["request_id"] == payload["requestId"]
    assert line["analyses_running"] == 2


def test_a_generation_answered_503_before_its_thread_started_leaves_nothing_counted() -> None:
    """`deadlineSeconds` no longer than the transfer margin gives the route a ceiling of 0: it gives up before the solve's thread is
    started. The count is taken INSIDE the thread (app.solve_load: "a coroutine that was closed before its thread was started counts
    nothing and cannot leave a count behind"), so this solve counted nothing. A count taken at admission and given back by the
    thread would stay at one for ever, and every analysis would answer 429 until the engine restarted."""
    payload = to._sample_payload()
    payload["deadlineSeconds"] = TRANSFER_MARGIN_SECONDS
    with TestClient(create_app(to._settings())) as client:
        generated = client.post("/api/v1/optimize", json=payload, headers=HEADERS)
        assert generated.status_code == 503, generated.text
        assert generated.json()["details"]["ceilingSeconds"] == 0.0

        _wait_until_zero(GENERATION)
        taken = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)

    assert taken.status_code == 200, taken.text
