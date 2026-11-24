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
