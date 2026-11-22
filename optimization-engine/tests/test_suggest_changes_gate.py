"""Åtgärdsförslag vid vägran: the gate of POST /api/v1/suggest-changes is the thread's, not the answer's.

A solve's thread cannot be cancelled: the 503 at the route's ceiling ends the WAIT. The gate used to
open with the 503, so a second analysis ran beside the first one's still-running thread, and a third
beside those. These tests keep the gate shut for as long as the thread lives.
"""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_suggest_changes import HEADERS, _app_settings, _body


def test_a_second_analysis_beside_a_thread_that_outlived_its_503_is_answered_429(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1 import suggest_changes as route

    running = threading.Event()
    release = threading.Event()
    started: list[int] = []

    def slow(*args: object, **kwargs: object) -> None:
        started.append(1)
        running.set()
        release.wait(10)

    monkeypatch.setattr(route, "solve_ceiling_seconds", lambda *args: 0.05)
    monkeypatch.setattr(route, "suggest_changes", slow)
    # A client that stays up, so that one event loop serves both requests as it does under uvicorn.
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        first = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
        assert first.status_code == 503
        assert running.wait(5)
        try:
            second = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
            assert second.status_code == 429, "the first thread is still running: no second analysis may start"
            assert len(started) == 1
        finally:
            release.set()
        # With the thread ended the gate is open again.
        for _ in range(100):
            if not client.app.state.suggest_changes_gate.locked():  # type: ignore[attr-defined]
                break
            threading.Event().wait(0.05)
        assert not client.app.state.suggest_changes_gate.locked()  # type: ignore[attr-defined]


def test_the_gate_opens_when_an_analysis_answers_in_time_and_when_it_fails() -> None:
    with TestClient(create_app(_app_settings())) as client:  # type: ignore[arg-type]
        ok = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
        assert ok.status_code == 200
        assert not client.app.state.suggest_changes_gate.locked()  # type: ignore[attr-defined]
        refused = _body()
        refused["somethingNew"] = 1  # a 422 before the gate is reached must not leave it shut
        assert client.post("/api/v1/suggest-changes", json=refused, headers=HEADERS).status_code == 422
        assert not client.app.state.suggest_changes_gate.locked()  # type: ignore[attr-defined]
        again = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
        assert again.status_code == 200
