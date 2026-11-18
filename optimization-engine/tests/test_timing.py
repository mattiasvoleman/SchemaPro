"""The engine's times (app/timing.py), what it says of them, and the 503 it answers at its ceiling.

M1, Tidskedjan. The chain of times a generation passes through used to be set by
hand in two Railway services, and the review of #344 found three steps that ran
outside the clock the ceiling was counted from. These pin the parts that need no
solve: the arithmetic, GET /api/v1/timing, the body every route answers with
when it stops waiting, and that a request's own deadline is in the ceiling.
(The steps of a solve that end on the clock are in test_search_options.py,
where the fake clock is.)
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import exams, optimize, rooms, staffing
from app.config import Settings
from app.exceptions import SolverTimeoutError
from app.main import create_app, register_exception_handlers
from app.schemas.schedule import OptimizeScheduleRequest, SearchOptions
from tests import test_search_options as tso
from app.timing import (
    ANSWER_SLACK_SECONDS,
    BUILD_HEADROOM_SECONDS,
    PROBE_FLOOR_SECONDS,
    SOLVE_OVERRUN_SECONDS,
    TRANSFER_MARGIN_SECONDS,
    Deadline,
    RouteLimits,
    ceiling_seconds,
    generation_limits,
)

API_KEY = "test-api-key-000000000000000000000000"
HEADERS = {"X-API-Key": API_KEY}
SHARED = json.loads((Path(__file__).parent / "data" / "solver_timeout_body.json").read_text())


def _settings(**overrides: object) -> Settings:
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            **overrides,
        },
    )


# ---------------------------------------------------------------------------
# The arithmetic
# ---------------------------------------------------------------------------


def test_the_named_margins_are_what_the_design_says() -> None:
    """The numbers the API's wait and DEPLOYMENT.md quote; changing one is a decision."""
    assert BUILD_HEADROOM_SECONDS == 30.0
    assert TRANSFER_MARGIN_SECONDS == 5.0
    assert ANSWER_SLACK_SECONDS == 3.0
    assert SOLVE_OVERRUN_SECONDS == 10.0
    assert PROBE_FLOOR_SECONDS == 5.0


@pytest.mark.parametrize(
    ("budget", "probe", "runs_probes", "expected"),
    [
        (180.0, 20.0, True, 230.0),  # production: 180 s, 20 s, 30 s of headroom
        (60.0, 20.0, True, 110.0),  # the engine's own defaults
        (30.0, 15.0, True, 75.0),  # a schemaförslag lead call, probe = min(20, 30 / 2)
        (30.0, 20.0, False, 60.0),  # a candidate after the first: nothing after its budget
        (60.0, 0.0, True, 90.0),  # SOLVER_PROBE_SECONDS=0 switches the probe off
    ],
)
def test_the_ceiling_is_the_search_the_probe_and_the_builds(
    budget: float, probe: float, runs_probes: bool, expected: float,
) -> None:
    settings = _settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=probe)

    limits = generation_limits(settings, runs_probes=runs_probes)

    assert limits.ceiling_seconds == expected
    assert ceiling_seconds(limits) == expected


@pytest.mark.parametrize(
    ("deadline", "expected"),
    [
        (None, 230.0),  # no deadline: what the settings need
        (400.0, 230.0),  # a deadline that holds the settings changes nothing
        (235.0, 230.0),  # exactly the settings' ceiling plus the transfer margin
        (234.9, 229.9),  # a hair short: the deadline wins
        (120.0, 115.0),  # AI_ENGINE_TIMEOUT_MS = 120000 against a 180 s budget
        (5.0, 0.0),  # a deadline inside the transfer margin leaves no time, not a negative one
        (2.0, 0.0),
    ],
)
def test_a_deadline_can_only_shorten_the_ceiling(deadline: float | None, expected: float) -> None:
    limits = generation_limits(_settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20))

    assert ceiling_seconds(limits, deadline) == pytest.approx(expected)


def test_the_answer_is_due_a_little_before_the_ceiling() -> None:
    clock = Deadline(entered=1000.0, ceiling=230.0)

    assert clock.answer_by == 1000.0 + 230.0 - ANSWER_SLACK_SECONDS - SOLVE_OVERRUN_SECONDS
    assert clock.left(1100.0) == pytest.approx(117.0)
    assert clock.left(1218.0) == pytest.approx(-1.0)
    assert clock.cap(1100.0, 20.0) == 20.0
    assert clock.cap(1210.0, 20.0) == pytest.approx(7.0)
    assert clock.clamp(5000.0) == clock.answer_by
    assert clock.clamp(1100.0) == 1100.0


def test_a_step_cut_at_the_edge_that_overran_is_still_inside_the_ceiling() -> None:
    """The edge lies a solve's overrun and the answer's slack before the ceiling.

    On 2026-11-17 CP-SAT stopped ten seconds after its 180: a step the clock cut
    at `answer_by` (a search squeezed by a short deadline, the explanation, a
    probe's last slice) may do the same, and the answer is built after it.
    """
    clock = Deadline(entered=0.0, ceiling=230.0)

    assert clock.answer_by + SOLVE_OVERRUN_SECONDS + ANSWER_SLACK_SECONDS <= clock.ceiling


def test_a_ceiling_shorter_than_the_slack_gives_up_half_of_itself_not_all() -> None:
    """A ceiling of 2 s is answered by 1 s, never by a negative number of seconds."""
    assert Deadline(entered=10.0, ceiling=2.0).answer_by == 11.0
    assert Deadline(entered=10.0, ceiling=0.0).answer_by == 10.0


def test_the_search_has_its_whole_budget_while_the_clock_holds_it() -> None:
    """EXACTLY the budget, not the budget less the rounding of two clock readings."""
    clock = Deadline(entered=123456.789012345, ceiling=230.0)

    assert clock.search_budget(started=123456.789012345 + 8.0, budget=180.0, probe_seconds=20.0) == 180.0


def test_the_search_ends_where_the_clock_leaves_the_probes_floor() -> None:
    """A slow build, or a caller that waits less than the settings need."""
    clock = Deadline(entered=0.0, ceiling=230.0)

    # Builds took 30 s: 217 (the answer) less the probe's floor (5) less 30 is 182 ... of 180: held.
    assert clock.search_budget(started=30.0, budget=180.0, probe_seconds=20.0) == 180.0
    # Builds took 60 s: 217 - 5 - 60 = 152, so the search ends there.
    assert clock.search_budget(started=60.0, budget=180.0, probe_seconds=20.0) == pytest.approx(152.0)
    # The floor is the probe's own seconds when they are fewer than five.
    assert clock.search_budget(started=60.0, budget=180.0, probe_seconds=2.0) == pytest.approx(155.0)
    # No probe: the search keeps everything up to the answer.
    assert clock.search_budget(started=60.0, budget=180.0, probe_seconds=0.0) == pytest.approx(157.0)
    # The builds ate it all: no search, and not a negative one.
    assert clock.search_budget(started=500.0, budget=180.0, probe_seconds=20.0) == 0.0


def test_the_probe_counts_from_where_the_search_ended_and_never_past_the_edge() -> None:
    clock = Deadline(entered=0.0, ceiling=230.0)

    assert clock.probe_end(now=190.0, probe_seconds=20.0) == 210.0
    # A search that ended late: the probe is cut to the edge, not dropped.
    assert clock.probe_end(now=205.0, probe_seconds=20.0) == clock.answer_by
    assert clock.probe_end(now=300.0, probe_seconds=20.0) == clock.answer_by


# ---------------------------------------------------------------------------
# What the engine says: GET /api/v1/timing
# ---------------------------------------------------------------------------


def test_timing_needs_the_service_key() -> None:
    client = TestClient(create_app(_settings()))

    assert client.get("/api/v1/timing").status_code == 401
    assert client.get("/api/v1/timing", headers={"X-API-Key": "x" * 40}).status_code == 401


def test_timing_says_what_each_route_may_take() -> None:
    client = TestClient(
        create_app(
            _settings(
                SOLVER_MAX_TIME_SECONDS=180,
                SOLVER_PROBE_SECONDS=20,
                ROOM_SOLVER_MAX_TIME_SECONDS=10,
                STAFF_SOLVER_MAX_TIME_SECONDS=12,
                EXAM_SOLVER_MAX_TIME_SECONDS=20,
            ),
        ),
    )

    response = client.get("/api/v1/timing", headers=HEADERS)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "version": 1,
        "capabilities": ["deadlineSeconds"],
        "transferMarginSeconds": 5.0,
        "routes": {
            "optimize": {"budgetSeconds": 180.0, "probeSeconds": 20.0, "headroomSeconds": 30.0, "ceilingSeconds": 230.0},
            "optimize-rooms": {"budgetSeconds": 10.0, "probeSeconds": 0.0, "headroomSeconds": 30.0, "ceilingSeconds": 40.0},
            "staff": {"budgetSeconds": 12.0, "probeSeconds": 0.0, "headroomSeconds": 30.0, "ceilingSeconds": 42.0},
            "plan-exams": {"budgetSeconds": 20.0, "probeSeconds": 0.0, "headroomSeconds": 30.0, "ceilingSeconds": 50.0},
        },
    }


# The four routes, each with how to run it on a payload that has nothing but a request id and
# (for the exam planner) a search: the solve is replaced, so nothing else is read.
_ROUTES = [
    ("optimize", optimize.run_solver),
    ("optimize-rooms", rooms.run_room_solver),
    ("staff", staffing.run_staffing_solver),
    ("plan-exams", exams.run_exam_solver),
]


def _hung_app(route: str, monkeypatch: pytest.MonkeyPatch, settings: Settings) -> FastAPI:
    """An app whose one route runs the real run_*_solver on a solve that never answers.

    `asyncio.wait_for` is replaced by one that says its timeout was reached the
    moment it is asked, and records what it was asked to wait: that number is
    what the route's ceiling IS, which is what /api/v1/timing has to say.
    """
    seen: dict[str, float] = {}

    async def give_up(awaitable: object, timeout: float) -> None:
        seen["timeout"] = timeout
        close = getattr(awaitable, "close", None)
        if close is not None:
            close()
        raise asyncio.TimeoutError

    for module in (optimize, rooms, staffing, exams):
        monkeypatch.setattr(module.asyncio, "wait_for", give_up)

    run = dict(_ROUTES)[route]
    application = FastAPI()
    application.state.settings = settings
    register_exception_handlers(application)
    application.state.seen = seen

    @application.get("/hung")
    async def hung() -> None:
        payload = SimpleNamespace(request_id=uuid4(), search=None, deadline_seconds=None)
        await run(payload, settings)

    return application


@pytest.mark.parametrize("route", [name for name, _ in _ROUTES])
def test_every_route_answers_503_with_the_shared_body_at_the_ceiling_timing_reports(
    route: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The number /api/v1/timing says is the number the route waits by, and its 503 is the fixture's.

    Not two formulas that are meant to agree: the route's own wait_for is
    caught and compared with the report. The body is read from
    tests/data/solver_timeout_body.json, which the API's spec reads too.
    """
    settings = _settings(
        SOLVER_MAX_TIME_SECONDS=90,
        SOLVER_PROBE_SECONDS=15,
        ROOM_SOLVER_MAX_TIME_SECONDS=7,
        STAFF_SOLVER_MAX_TIME_SECONDS=9,
        EXAM_SOLVER_MAX_TIME_SECONDS=11,
    )
    application = _hung_app(route, monkeypatch, settings)

    with TestClient(application, raise_server_exceptions=False) as client_:
        response = client_.get("/hung")
    reported = TestClient(create_app(settings)).get("/api/v1/timing", headers=HEADERS).json()
    ceiling = reported["routes"][route]["ceilingSeconds"]

    assert application.state.seen["timeout"] == ceiling
    assert response.status_code == 503, response.text
    assert response.json() == {
        "code": SHARED["code"],
        "message": SHARED["sentences"][route],
        "details": {"route": route, "ceilingSeconds": ceiling},
    }


def test_the_shared_fixture_names_the_four_routes_and_their_sentences() -> None:
    """The gateway matches these sentences for an engine older than the code."""
    assert SHARED["code"] == "SOLVER_TIMEOUT"
    assert SHARED["sentences"] == {
        "optimize": "Optimization timed out.",
        "optimize-rooms": "Room optimization timed out.",
        "staff": "Staffing proposal timed out.",
        "plan-exams": "Exam planning timed out.",
    }


def test_the_exception_carries_what_the_handler_says() -> None:
    error = SolverTimeoutError("Optimization timed out.", route="optimize", ceiling_seconds=230.0)

    assert str(error) == "Optimization timed out."
    assert (error.route, error.ceiling_seconds) == ("optimize", 230.0)


# ---------------------------------------------------------------------------
# A request carries its deadline
# ---------------------------------------------------------------------------


class _Waited:
    """Records the timeout run_solver hands asyncio.wait_for, then gives up."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.timeout: float | None = None

        async def give_up(awaitable: object, timeout: float) -> None:
            self.timeout = timeout
            close = getattr(awaitable, "close", None)
            if close is not None:
                close()
            raise asyncio.TimeoutError

        monkeypatch.setattr(optimize.asyncio, "wait_for", give_up)


def _request(*, deadline: float | None = None, search: dict[str, object] | None = None) -> OptimizeScheduleRequest:
    payload = tso._payload(search=search)
    if deadline is not None:
        payload["deadlineSeconds"] = deadline
    return OptimizeScheduleRequest.model_validate(payload)


def test_a_request_without_a_deadline_is_waited_for_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    waited = _Waited(monkeypatch)

    with pytest.raises(SolverTimeoutError):
        asyncio.run(optimize.run_solver(_request(), _settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20)))

    assert waited.timeout == 230.0


@pytest.mark.parametrize(
    ("deadline", "search", "expected"),
    [
        (240, None, 230.0),  # AI_ENGINE_TIMEOUT_MS=240000 holds the settings
        (120, None, 115.0),  # 120000 does not: the engine answers by 115 s
        (240, {"maxSeconds": 30}, 75.0),  # a candidate lead call: 30 + min(20, 15) + 30
        (60, {"maxSeconds": 30}, 55.0),  # and a candidate whose caller waits less
        (240, {"maxSeconds": 30, "probes": False}, 60.0),  # a candidate after the first: no probe
    ],
)
def test_the_requests_deadline_is_in_the_ceiling_the_route_waits_by(
    deadline: int, search: dict[str, object] | None, expected: float, monkeypatch: pytest.MonkeyPatch,
) -> None:
    waited = _Waited(monkeypatch)
    request = _request(deadline=deadline, search=search)

    with pytest.raises(SolverTimeoutError) as raised:
        asyncio.run(optimize.run_solver(request, _settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20)))

    assert waited.timeout == expected
    assert raised.value.ceiling_seconds == expected


@pytest.mark.parametrize("deadline", [0, -1, 3601, "soon"])
def test_a_deadline_that_is_not_a_positive_number_of_seconds_up_to_an_hour_is_refused(
    deadline: object,
) -> None:
    with pytest.raises(ValueError):
        OptimizeScheduleRequest.model_validate({**_request().model_dump(by_alias=True, mode="json"), "deadlineSeconds": deadline})


def test_the_deadline_is_optional_in_the_published_schema() -> None:
    """Additive: an older gateway that sends none, and the schema's `required` is as it was."""
    document = create_app(_settings()).openapi()
    schema = document["components"]["schemas"]["OptimizeScheduleRequest"]

    assert "deadlineSeconds" in schema["properties"]
    assert "deadlineSeconds" not in schema["required"]
    assert "/api/v1/timing" in document["paths"]
    assert {"EngineTiming", "RouteTiming"} <= set(document["components"]["schemas"])


def test_search_options_do_not_carry_the_deadline() -> None:
    """In `search` its presence would make a Generera a candidate (SearchOptions)."""
    assert "deadlineSeconds" not in SearchOptions.model_fields
    assert "deadline_seconds" not in SearchOptions.model_fields


def test_route_limits_name_their_parts() -> None:
    limits = RouteLimits(budget_seconds=10.0, probe_seconds=0.0)

    assert limits.headroom_seconds == BUILD_HEADROOM_SECONDS
    assert limits.ceiling_seconds == 40.0
