"""The seam between the gateway's road limit and the engine's clock (omgång 15, H1, the 2026-11-23 incident).

Railway's edge closes a request that sends nothing after 300 s. The gateway holds
its wait, and the `deadlineSeconds` it sends, to that limit less
PATH_MARGIN_SECONDS (src/optimization/engine-timing.ts): 290 s. The engine must
then answer a TIMEOUT, with its report, BEFORE the gateway's own wait ends and so
before the road closes, with production's settings (SOLVER_MAX_TIME_SECONDS=540,
SOLVER_PROBE_SECONDS=20, 30 s of headroom) that on their own would search for 540 s.

Nothing in the gateway's tests can say that, and nothing in the engine's knew the
number: the first run of 2026-11-23 sent `deadlineSeconds` 600 and the engine's
clock cut nothing. The number the gateway sends is read from its source here, so a
change of the margin there moves the deadline used here instead of leaving the
two files to agree by luck.

The fake clock is test_search_options.py's: a solve takes its time limit and the
overrun it is told to have (CP-SAT stopped about ten seconds late on the 809-lesson
week of 2026-11-17), and a model build takes `build` seconds.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_search_options as tso

#: What Railway's edge holds a request that sends nothing (src/config/engine-path.ts).
ROAD_LIMIT_SECONDS = 300

#: The engine's own margins (app/timing.py), written out here and not imported: a test that read them from the
#: module it tests would move with a change of them, and this one is about what the gateway's numbers leave room for.
TRANSFER_MARGIN_SECONDS = 5
SOLVE_OVERRUN_SECONDS = 10.0

#: Production's engine, as it said it on 2026-11-23: its budget alone is longer than the road holds.
PRODUCTION = {"SOLVER_MAX_TIME_SECONDS": 540, "SOLVER_PROBE_SECONDS": 20}

_GATEWAY = Path(__file__).resolve().parents[2] / "src/optimization/engine-timing.ts"


def _path_margin_seconds() -> int:
    found = re.search(r"export const PATH_MARGIN_SECONDS = (\d+);", _GATEWAY.read_text())
    assert found is not None, "the gateway's PATH_MARGIN_SECONDS is not where this test reads it"
    return int(found.group(1))


def _solve(monkeypatch: pytest.MonkeyPatch, deadline: int | None, *, overrun: float, best_effort: bool):  # noqa: ANN202
    clock = tso._Clock(monkeypatch, build=4.0, overrun=overrun)
    tso._rules_to_probe(monkeypatch, 3)
    started = clock.now
    if best_effort:
        request = tso._best_effort()
        if deadline is not None:
            request = request.model_copy(update={"deadline_seconds": float(deadline)})
    else:
        payload = tso._payload(changeover=5)
        if deadline is not None:
            payload["deadlineSeconds"] = deadline
        request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(tso._settings(**PRODUCTION)).solve(request)
    stages = {stage.stage: stage.seconds for stage in response.report.stages}
    search = stages.get("SEARCH_CLEAN", 0.0) + stages.get("SEARCH_CLONE", 0.0)
    return response, clock.now - started, search


@pytest.mark.parametrize("best_effort", [False, True])
@pytest.mark.parametrize("overrun", [0.0, SOLVE_OVERRUN_SECONDS])
def test_the_engine_answers_a_timeout_before_the_gateways_wait_and_so_before_the_road_closes(
    monkeypatch: pytest.MonkeyPatch, overrun: float, best_effort: bool,
) -> None:
    deadline = ROAD_LIMIT_SECONDS - _path_margin_seconds()

    response, answered_at, search = _solve(monkeypatch, deadline, overrun=overrun, best_effort=best_effort)

    assert response.status == "TIMEOUT"
    assert response.report is not None and response.report.caller_wait_seconds == deadline
    # By the deadline less the transfer margin: the engine's own 503 is at that instant, so the answer is before it
    # even when every solve stops SOLVE_OVERRUN_SECONDS late, and the gateway's wait ends five seconds after.
    assert answered_at <= deadline - TRANSFER_MARGIN_SECONDS
    assert answered_at < ROAD_LIMIT_SECONDS - _path_margin_seconds()
    # The clock must not starve the search either: production's 540 s is cut, not thrown away. 249 s at 4 s a build (a setup of 8 s: 272 less the probe's floor, the overrun and the setup).
    assert search >= 240
    assert response.report.budget_seconds < response.report.configured_budget_seconds == 540


@pytest.mark.parametrize("best_effort", [False, True])
def test_a_deadline_the_road_does_not_hold_is_the_incident_the_engine_answers_after_the_road_closed(
    monkeypatch: pytest.MonkeyPatch, best_effort: bool,
) -> None:
    """The deadline of 2026-11-23 (the engine's ceiling and the API's ten seconds: 600) leaves the search at its 540 s.

    The answer comes at about 570 s, which is where nobody was listening. This is what makes the test above say
    something: with the number the gateway used to send, it fails.
    """
    response, answered_at, _search = _solve(monkeypatch, 600, overrun=0.0, best_effort=best_effort)

    assert response.status == "TIMEOUT"
    assert answered_at > ROAD_LIMIT_SECONDS
