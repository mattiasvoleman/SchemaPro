"""What the engine's log says of a generation request, on BOTH of its doors (omgång 15, the 2026-11-23 incident).

The gateway calls `POST /v1/schedule`, the older door, and not `/api/v1/optimize`. Only the second logged
`optimization_requested`, so the engine's log of the incident showed a 540 s search and a TIMEOUT with no line that said
what the request was or how long its caller waited: nothing in the log answered whether the call had carried a
`deadlineSeconds`, which is what decides whether the engine's own clock cuts the search before a proxy closes the call.
Both doors now say the same line, from one function, and `deadline_seconds` is in it when the caller sent one.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests import test_optimize as to
from tests.test_suggest_changes import HEADERS

DOORS = ["/api/v1/optimize", "/v1/schedule"]


def _events(caplog: pytest.LogCaptureFixture, name: str) -> list[dict[str, Any]]:
    """The structured log lines called `name`, parsed: what production's log search would read."""
    found: list[dict[str, Any]] = []
    for record in caplog.records:
        try:
            line = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(line, dict) and line.get("event") == name:
            found.append(line)
    return found


def _post(path: str, caplog: pytest.LogCaptureFixture, **extra: object) -> dict[str, Any]:
    payload = {**to._sample_payload(), **extra}
    with caplog.at_level(logging.INFO):
        with TestClient(create_app(to._settings())) as client:
            response = client.post(path, json=payload, headers=HEADERS)
    assert response.status_code == 200, response.text
    return payload


@pytest.mark.parametrize("path", DOORS)
def test_a_generation_request_says_what_it_is_on_both_doors(path: str, caplog: pytest.LogCaptureFixture) -> None:
    payload = _post(path, caplog)

    requested = _events(caplog, "optimization_requested")
    assert len(requested) == 1
    assert requested[0]["request_id"] == payload["requestId"]
    assert requested[0]["academic_year_id"] == payload["academicYearId"]
    assert requested[0]["requirement_count"] == 1
    assert requested[0]["room_count"] == 1
    assert requested[0]["constraint_count"] == 0


@pytest.mark.parametrize("path", DOORS)
def test_it_says_how_long_the_caller_waits_when_the_caller_said(path: str, caplog: pytest.LogCaptureFixture) -> None:
    _post(path, caplog, deadlineSeconds=290)

    (requested,) = _events(caplog, "optimization_requested")
    assert requested["deadline_seconds"] == 290


@pytest.mark.parametrize("path", DOORS)
def test_it_leaves_the_field_out_when_none_was_sent_so_the_line_reads_as_it_always_has(
    path: str, caplog: pytest.LogCaptureFixture,
) -> None:
    _post(path, caplog)

    (requested,) = _events(caplog, "optimization_requested")
    assert "deadline_seconds" not in requested
    assert "search" not in requested


@pytest.mark.parametrize("path", DOORS)
def test_the_search_options_are_said_when_sent_on_both_doors(path: str, caplog: pytest.LogCaptureFixture) -> None:
    _post(path, caplog, search={"maxSeconds": 10, "probes": False})

    (requested,) = _events(caplog, "optimization_requested")
    # As /api/v1/optimize has always said it (the model's own dump): the line is not reworded.
    assert requested["search"] == {"maxSeconds": 10, "probes": False}


@pytest.mark.parametrize("path", DOORS)
def test_the_answer_is_logged_on_both_doors(path: str, caplog: pytest.LogCaptureFixture) -> None:
    payload = _post(path, caplog)

    (completed,) = _events(caplog, "optimization_completed")
    assert completed["request_id"] == payload["requestId"]
    assert completed["status"] in {"OPTIMAL", "FEASIBLE"}
    assert completed["lesson_count"] == 2


def test_the_two_doors_say_the_same_line(caplog: pytest.LogCaptureFixture) -> None:
    """One function says it for both, so that a field added to one cannot be missing from the other."""
    seen: dict[str, dict[str, Any]] = {}
    for path in DOORS:
        caplog.clear()
        _post(path, caplog, deadlineSeconds=120)
        (requested,) = _events(caplog, "optimization_requested")
        seen[path] = {key: value for key, value in requested.items() if key not in {"request_id", "academic_year_id", "timestamp"}}

    assert seen["/api/v1/optimize"] == seen["/v1/schedule"]


# What the review of omgång 15 (H1, del 3) added: three things the eleven cases above let through.


@pytest.mark.parametrize("path", DOORS)
def test_a_deadline_with_a_fraction_is_said_as_it_was_sent(path: str, caplog: pytest.LogCaptureFixture) -> None:
    """`deadlineSeconds` is a float (gt=0, le=3600): a line that rounded it would say a wait the caller never named."""
    _post(path, caplog, deadlineSeconds=289.5)

    (requested,) = _events(caplog, "optimization_requested")
    assert requested["deadline_seconds"] == 289.5


@pytest.mark.parametrize("path", DOORS)
def test_the_request_is_said_before_the_solve_starts_and_stays_when_the_solve_never_answers(
    path: str, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The incident's own case: a search that ran 540 s for a caller that left at 300 s, and a solve that is
    answered 503 at its ceiling. The line that says what the call was has to be in the log WHEN the solve starts,
    not after it: moved behind `run_solver` it still passes every case above on a solve that answers, and leaves
    the log as blind as it was on 2026-11-23 on the two endings this PR was written for."""
    import app.api.v1.optimize as optimize_module
    import app.main as main_module
    from app.exceptions import SolverTimeoutError

    said_when_the_solve_started: list[int] = []

    async def never_answers(payload: object, settings: object) -> object:
        said_when_the_solve_started.append(len(_events(caplog, "optimization_requested")))
        raise SolverTimeoutError("Optimization timed out.", route="optimize", ceiling_seconds=230.0)

    # Each door calls the `run_solver` its own module imported: both are replaced.
    monkeypatch.setattr(optimize_module, "run_solver", never_answers)
    monkeypatch.setattr(main_module, "run_solver", never_answers)

    payload = {**to._sample_payload(), "deadlineSeconds": 290}
    with caplog.at_level(logging.INFO):
        with TestClient(create_app(to._settings())) as client:
            response = client.post(path, json=payload, headers=HEADERS)

    assert response.status_code == 503
    assert said_when_the_solve_started == [1]
    (requested,) = _events(caplog, "optimization_requested")
    assert requested["request_id"] == payload["requestId"]
    assert requested["deadline_seconds"] == 290
    # A solve that never answered has nothing to say it completed, on either door.
    assert _events(caplog, "optimization_completed") == []


# Everything the line may carry, and nothing else: the engine is given anonymous ids and numbers, and its log is
# read by whoever runs the deployment (docs/dataskydd-sakbeskrivning.md). A field added to the shared function
# reaches BOTH doors and every Generera of every school, so it is added here on purpose or not at all.
_ALLOWED_REQUESTED_KEYS = {
    "event", "level", "logger", "timestamp",
    "request_id", "academic_year_id", "requirement_count", "room_count", "constraint_count",
    "search", "deadline_seconds",
}
_ALLOWED_SEARCH_KEYS = {"maxSeconds", "seed", "probes", "workers"}


@pytest.mark.parametrize("path", DOORS)
def test_the_line_carries_only_ids_and_counts_and_numbers(path: str, caplog: pytest.LogCaptureFixture) -> None:
    _post(path, caplog, deadlineSeconds=120, search={"maxSeconds": 10, "seed": 3, "probes": False, "workers": 2})

    (requested,) = _events(caplog, "optimization_requested")
    assert set(requested) <= _ALLOWED_REQUESTED_KEYS, sorted(set(requested) - _ALLOWED_REQUESTED_KEYS)
    assert set(requested["search"]) == _ALLOWED_SEARCH_KEYS
    for key in ("requirement_count", "room_count", "constraint_count"):
        assert isinstance(requested[key], int)
