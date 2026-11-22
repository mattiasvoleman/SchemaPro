"""The log lines that measure the one gap the shared count leaves open (DEPLOYMENT 33.4).

A Generera that starts while an analysis is already running shares the cores with it, and the PR leaves that case open on
purpose: "count those lines in production before building anything to stop an analysis". A count of lines says how often. What the
decision also needs is how long the two shared the cores, and for that the line has to say WHICH analysis it started beside and how
long that had run, and the window the Generera's own line cannot see (an analysis let in a moment before a Generera's thread began)
has to be said from the analysis's side.
"""

from __future__ import annotations

import json
import logging
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.solve_load import ANALYSIS, GENERATION, SOLVE_LOAD, SolveLoad
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_optimize as to
from tests.test_suggest_changes import HEADERS, _app_settings, _body


def _events(caplog: pytest.LogCaptureFixture, name: str) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    for record in caplog.records:
        try:
            line = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(line, dict) and line.get("event") == name:
            found.append(line)
    return found


def test_the_count_says_which_solve_has_run_longest_and_for_how_long() -> None:
    load = SolveLoad()
    assert load.oldest(ANALYSIS) == (0, None, 0.0)

    with load.running(ANALYSIS, "first"):
        time.sleep(0.02)
        with load.running(ANALYSIS, "second"):
            with load.running(GENERATION, "other kind"):
                count, label, seconds = load.oldest(ANALYSIS)
                assert (count, label) == (2, "first")
                assert 0.02 <= seconds < 5
                assert load.oldest(GENERATION)[:2] == (1, "other kind")
        # "first" is still the oldest until it leaves; then "second" is the only one
        assert load.oldest(ANALYSIS)[:2] == (1, "first")
    assert load.oldest(ANALYSIS) == (0, None, 0.0)
    assert load.count(ANALYSIS) == 0

    with load.running(GENERATION):  # a solve counted without a label still counts, and has none to name
        assert load.oldest(GENERATION)[:2] == (1, None)


def test_a_generation_beside_an_analysis_names_the_analysis_and_how_long_it_had_run(
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = to._sample_payload()
    with TestClient(create_app(to._settings())) as client:
        with caplog.at_level(logging.WARNING):
            with SOLVE_LOAD.running(ANALYSIS, "the-analysis-id"):
                time.sleep(0.06)
                response = client.post("/api/v1/optimize", json=payload, headers=HEADERS)

    assert response.status_code == 200, response.text
    (line,) = _events(caplog, "generation_beside_analysis")
    assert line["request_id"] == payload["requestId"]
    assert line["analyses_running"] == 1
    assert line["analysis_request_id"] == "the-analysis-id"
    assert isinstance(line["analysis_seconds"], (int, float)) and 0.0 <= line["analysis_seconds"] < 30


def test_an_analysis_let_in_a_moment_before_a_generations_thread_is_logged_from_its_own_side(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """The route looked and found no Generera (here: its own check is made to see none); by the time the analysis's thread began a
    Generera's had. The Generera's line cannot see this, since it began first and found no analysis."""
    body = _body()
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        monkeypatch.setattr(SOLVE_LOAD, "count", lambda kind: 0)
        with caplog.at_level(logging.WARNING):
            with SOLVE_LOAD.running(GENERATION, "the-generation-id"):
                time.sleep(0.04)
                response = client.post("/api/v1/suggest-changes", json=body, headers=HEADERS)

    assert response.status_code == 200, response.text
    (line,) = _events(caplog, "analysis_beside_generation")
    assert line["level"] == "warning"
    assert line["request_id"] == body["requestId"]
    assert line["generations_running"] == 1
    assert line["generation_request_id"] == "the-generation-id"
    assert isinstance(line["generation_seconds"], (int, float)) and 0.0 <= line["generation_seconds"] < 30


def test_an_analysis_alone_logs_nothing_of_the_kind(caplog: pytest.LogCaptureFixture) -> None:
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        with caplog.at_level(logging.WARNING):
            response = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)

    assert response.status_code == 200, response.text
    assert _events(caplog, "analysis_beside_generation") == []


def test_each_route_counts_its_solve_under_the_requests_own_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """The other side's line can only name a solve that was counted with its id."""
    from app.api.v1 import suggest_changes as route

    seen: dict[str, object] = {}
    original_solve = SchedulerSolver.solve
    original_analysis = route.suggest_changes

    def solve(self: SchedulerSolver, payload: object) -> object:
        if SOLVE_LOAD.count(GENERATION):  # the analysis's own inner solves run with none counted
            seen["generation"] = SOLVE_LOAD.oldest(GENERATION)[1]
        return original_solve(self, payload)  # type: ignore[arg-type]

    def analysis(*args: object, **kwargs: object) -> object:
        seen["analysis"] = SOLVE_LOAD.oldest(ANALYSIS)[1]
        return original_analysis(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(SchedulerSolver, "solve", solve)
    monkeypatch.setattr(route, "suggest_changes", analysis)
    generation, body = to._sample_payload(), _body()
    with TestClient(create_app(to._settings())) as client:
        assert client.post("/api/v1/optimize", json=generation, headers=HEADERS).status_code == 200
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        assert client.post("/api/v1/suggest-changes", json=body, headers=HEADERS).status_code == 200

    assert seen == {"generation": generation["requestId"], "analysis": body["requestId"]}
