"""`search`: how a schemaförslag candidate's solve is run, never what it solves.

A candidate run asks the engine for two to four timetables of one week. They
differ by their weights, which the request has always carried, and by the four
fields here: a seed, a budget, whether a refusal pays for its explanation, and
how many cores the search may take. A request carrying `search` also has its
phase 2 start from a completed hint. Every other request — every Generera —
sends none of it, and must be solved exactly as it was before the field
existed. Much of what follows pins that second half, because it is the half a
regression would hide in: a candidate run is new and watched, a Generera is
neither.

THE BUDGET IS A COPY. app.state.settings is one object shared by every request
the process serves, and a candidate and a Generera can be solving side by
side. The tests below hold that each sees its own budget while the other runs.
"""

from __future__ import annotations

import asyncio
import json
import threading
import types
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.config import Settings
from app.main import create_app, register_exception_handlers
from app.schemas.schedule import OptimizeScheduleRequest, ScheduleRules, SearchOptions
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver, settings_for_search
from app.timing import Deadline

API_KEY = "test-api-key-000000000000000000000000"
HEADERS = {"X-API-Key": API_KEY}


def _settings(**overrides: object) -> Settings:
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            **overrides,
        },
    )


def _payload(*, changeover: int = 0, search: dict[str, object] | None = None) -> dict[str, object]:
    """One teacher, one class, two hour-long lessons; a corridor on request.

    The corridor is there so a TIMEOUT has something to probe: with it the
    probe has exactly one relaxation to try and reports its budget in a
    PROBE_NOTHING_HELPED summary, which is where a TIMEOUT's budget is read.
    """
    group_id = str(uuid4())
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": group_id,
                "teacherId": str(uuid4()),
                "lessonsPerWeek": 2,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
                "minGradeLevel": 4,
                "maxGradeLevel": 6,
            }
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
    }
    if changeover:
        payload["frameTimes"] = [
            {
                "minGradeLevel": 0,
                "maxGradeLevel": 12,
                "dayOfWeek": None,
                "startTime": "08:00:00",
                "endTime": "16:00:00",
                "changeoverMinutes": changeover,
            }
        ]
    if search is not None:
        payload["search"] = search
    return payload


class _Recorder:
    """Every CpSolver.Solve: its parameters, the thread it ran on, its answer.

    `answer` None runs CP-SAT for real; a status code makes every solve return
    it at once, which is how a TIMEOUT or an INFEASIBLE is reached
    deterministically — CP-SAT's own clock cannot be asked to run out on cue.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch, answer: int | None = None) -> None:
        self.calls: list[tuple[int, dict[str, str]]] = []
        self.first_solve_waits: threading.Barrier | None = None
        self._seen_threads: set[int] = set()
        self._lock = threading.Lock()
        original = cp_model.CpSolver.Solve
        recorder = self

        def solve(
            solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object,
        ) -> int:
            thread = threading.get_ident()
            with recorder._lock:
                recorder.calls.append((thread, _parameters(solver)))
                first = thread not in recorder._seen_threads
                recorder._seen_threads.add(thread)
            if first and recorder.first_solve_waits is not None:
                recorder.first_solve_waits.wait()
            if answer is not None:
                return answer
            return original(solver, model, *args, **kwargs)

        monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)

    def parameters(self) -> list[dict[str, str]]:
        return [parameters for _, parameters in self.calls]


def _no_core(monkeypatch: pytest.MonkeyPatch) -> None:
    """A faked INFEASIBLE has no core to read: CP-SAT never ran, so asking it
    which assumptions it used raises. The explanation then finds nothing."""
    monkeypatch.setattr(scheduler_solver, "build_conflict_analysis", lambda solver, registry: None)


def _parameters(solver: cp_model.CpSolver) -> dict[str, str]:
    """The parameters a solver was given, as CP-SAT prints them: only the set ones."""
    out: dict[str, str] = {}
    for line in str(solver.parameters).splitlines():
        name, _, value = line.partition(":")
        out[name.strip()] = value.strip()
    return out


def _post(app: FastAPI, payload: dict[str, object]) -> httpx.Response:
    from fastapi.testclient import TestClient

    return TestClient(app).post("/api/v1/optimize", json=payload, headers=HEADERS)


# ---------------------------------------------------------------------------
# Absent is today
# ---------------------------------------------------------------------------


def test_absent_search_leaves_the_settings_and_the_solver_parameters_as_they_were(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pin. A Generera sends no `search`, and must be solved exactly as before.

    Three parts. The Settings it is solved under are the app's own object, not
    an equal copy of it — so no reader of a budget can tell the difference.
    Every CP-SAT solve is given what it was always given: a time limit and
    nothing else, no seed and no worker count. And there are exactly the two
    solves a feasible week always had, phase 1a and phase 2: no hint
    completion between them.
    """
    settings = _settings()
    assert settings_for_search(settings, None) is settings
    assert settings_for_search(settings, SearchOptions()) is settings
    assert settings_for_search(settings, SearchOptions(probes=True)) is settings

    recorder = _Recorder(monkeypatch)
    app = create_app(settings)
    response = _post(app, _payload())
    assert response.status_code == 200, response.text
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}
    assert app.state.settings is settings

    parameters = recorder.parameters()
    assert len(parameters) == 2, parameters
    assert all(set(each) == {"max_time_in_seconds"} for each in parameters), parameters
    assert float(parameters[0]["max_time_in_seconds"]) == 60.0


def test_an_empty_search_adds_the_hint_completion_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`search: {}` is a candidate with every field at its default.

    The one solve it adds is the completion between phase 1 and phase 2, and
    the completion is the only solve that carries anything but a time limit.
    """
    recorder = _Recorder(monkeypatch)

    response = _post(create_app(_settings()), _payload(search={}))

    assert response.status_code == 200, response.text
    parameters = recorder.parameters()
    assert [set(each) for each in parameters] == [
        {"max_time_in_seconds"},
        {"max_time_in_seconds", "fix_variables_to_their_hinted_value"},
        {"max_time_in_seconds"},
    ], parameters


def test_the_request_schema_keeps_search_optional() -> None:
    """The published contract: `search` is a property a request MAY carry.

    Checked on the OpenAPI document the gateway's contract test and a deploy
    check read, because a `required` entry there would be a 422 for every
    Generera an older gateway sends.
    """
    document = create_app(_settings()).openapi()
    request = document["components"]["schemas"]["OptimizeScheduleRequest"]
    assert "search" in request["properties"]
    assert "search" not in request.get("required", [])

    options = document["components"]["schemas"]["SearchOptions"]
    assert set(options["properties"]) == {"seed", "maxSeconds", "probes", "workers"}
    assert options.get("required", []) == []
    assert options["additionalProperties"] is False


# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("seed", -1),
        ("seed", 2_147_483_648),
        ("maxSeconds", 4),
        ("maxSeconds", 601),
        ("maxSeconds", 30.5),
        ("workers", 0),
        ("workers", 17),
        ("probes", "sometimes"),
    ],
)
def test_a_value_outside_its_bounds_is_a_422_naming_the_field(field: str, value: object) -> None:
    response = _post(create_app(_settings()), _payload(search={field: value}))

    assert response.status_code == 422, response.text
    errors = response.json()["details"]["errors"]
    assert [error["loc"] for error in errors] == [["body", "search", field]]


@pytest.mark.parametrize(
    "search",
    [
        {"seed": 0},
        {"seed": 2_147_483_647},
        {"maxSeconds": 5},
        {"maxSeconds": 600},
        {"workers": 1},
        {"workers": 16},
        {"probes": False},
        {"seed": 3, "maxSeconds": 30, "probes": False, "workers": 4},
    ],
)
def test_every_bound_is_inclusive(search: dict[str, object]) -> None:
    request = OptimizeScheduleRequest.model_validate(_payload(search=search))
    assert request.search is not None
    assert request.search.model_dump(exclude_none=True) == search


def test_a_field_search_does_not_know_is_refused_by_name() -> None:
    """extra="forbid", as everywhere in this contract: a typo in the gateway
    is a 422 naming it, not a candidate solved on defaults it did not ask for."""
    response = _post(create_app(_settings()), _payload(search={"seeds": 1}))

    assert response.status_code == 422
    [error] = response.json()["details"]["errors"]
    assert error["type"] == "extra_forbidden"
    assert error["loc"] == ["body", "search", "seeds"]


def test_an_unknown_top_level_field_is_refused_in_the_shape_the_gateway_reads() -> None:
    """What an engine older than `search` answers a candidate, pinned here.

    The gateway tells "the engine is older than the API" apart from every other
    422 by exactly this: one error, type extra_forbidden, loc ['body',
    'search']. That shape is this service's envelope — the sanitised errors of
    the validation handler — so it is pinned on the handler with a model that
    has no `search`, which is what every request model was before this one.
    """
    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/older")
    async def older(payload: ScheduleRules) -> dict[str, str]:  # noqa: ARG001
        return {}

    from fastapi.testclient import TestClient

    response = TestClient(app).post("/older", json={"search": {"workers": 4}})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "VALIDATION_ERROR"
    assert [(e["type"], e["loc"]) for e in body["details"]["errors"]] == [
        ("extra_forbidden", ["body", "search"]),
    ]


# ---------------------------------------------------------------------------
# The budget
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("configured", "search", "expected"),
    [
        # (budget, probe) configured, the request's search, (budget, probe) solved under
        ((60.0, 20.0), SearchOptions(maxSeconds=30), (30.0, 15.0)),
        ((60.0, 20.0), SearchOptions(maxSeconds=10), (10.0, 5.0)),
        # Lower than the configured budget, but half of it is still above the probe.
        ((60.0, 20.0), SearchOptions(maxSeconds=50), (50.0, 20.0)),
        # Never more than the deployment gives a Generera.
        ((60.0, 20.0), SearchOptions(maxSeconds=600), (60.0, 20.0)),
        ((20.0, 20.0), SearchOptions(maxSeconds=30), (20.0, 15.0)),
        # No probe runs, so its bound is left alone.
        ((60.0, 20.0), SearchOptions(maxSeconds=30, probes=False), (30.0, 20.0)),
        # No budget asked for: the configured one, whatever else is sent.
        ((60.0, 20.0), SearchOptions(seed=4, workers=4), (60.0, 20.0)),
    ],
)
def test_the_requests_budget_only_ever_shrinks_and_bounds_the_probe(
    configured: tuple[float, float],
    search: SearchOptions,
    expected: tuple[float, float],
) -> None:
    settings = _settings(
        SOLVER_MAX_TIME_SECONDS=configured[0], SOLVER_PROBE_SECONDS=configured[1],
    )

    scoped = settings_for_search(settings, search)

    assert (scoped.solver_max_time_seconds, scoped.solver_probe_seconds) == expected
    # The original is untouched, and scoping twice is scoping once — which is
    # what lets run_solver and solve() both call it.
    assert (settings.solver_max_time_seconds, settings.solver_probe_seconds) == configured
    assert settings_for_search(scoped, search) is scoped
    if expected == configured:
        assert scoped is settings
    # Everything else is the deployment's: grid, weights, key.
    assert scoped.slot_minutes == settings.slot_minutes
    assert scoped.weight_disruption == settings.weight_disruption
    assert scoped.api_key == settings.api_key
    assert scoped.schedule_days == settings.schedule_days


def test_a_candidates_timeout_reports_the_candidates_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every reader of the budget reads the request's, and the app's is left alone.

    A candidate given thirty seconds that runs out must say thirty, not the
    configured sixty: the page shows the number, and "the solver ran out of
    60 seconds" about a run that had 30 is a sentence about some other run.
    The phase-1 cap and the probe's slice are read off the same copy.
    """
    recorder = _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    settings = _settings()
    app = create_app(settings)

    response = _post(app, _payload(changeover=5, search={"maxSeconds": 30}))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "TIMEOUT"
    assert body["conflicts"]["summaryCode"] == "PROBE_NOTHING_HELPED"
    assert body["conflicts"]["summaryParams"]["budget"] == 30
    # One relaxation (the corridor), so the probe's slice is its whole bound:
    # min(SOLVER_PROBE_SECONDS 20, maxSeconds / 2) = 15.
    assert body["conflicts"]["summaryParams"]["slice"] == 15
    limits = [float(p["max_time_in_seconds"]) for p in recorder.parameters()]
    # Phase 1a capped at the request's 30, phase 1b on what is left of it, the probe at 15.
    assert len(limits) == 3, limits
    assert limits[0] == 30.0
    assert 29.0 < limits[1] <= 30.0
    # The probe's clock counts its own seconds from where the search ended and
    # its builds are inside them (M1), so the one slice is its whole bound less
    # the milliseconds the corridor's build took.
    assert 14.0 < limits[2] <= 15.0
    assert app.state.settings is settings
    assert settings.solver_max_time_seconds == 60.0
    assert settings.solver_probe_seconds == 20.0


def test_the_explanation_is_capped_by_the_requests_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The INFEASIBLE explanation's cap is min(budget, 15 s), and the budget is the request's."""
    recorder = _Recorder(monkeypatch, answer=cp_model.INFEASIBLE)
    _no_core(monkeypatch)

    response = SchedulerSolver(_settings()).solve(
        OptimizeScheduleRequest.model_validate(_payload(search={"maxSeconds": 10})),
    )

    assert response.status == "INFEASIBLE"
    limits = [float(p["max_time_in_seconds"]) for p in recorder.parameters()]
    # The proof (phase 1a), then the explaining solve.
    assert limits == [10.0, 10.0]


async def test_a_generera_beside_a_candidate_keeps_the_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two requests in flight at once, each solved under its own budget.

    The two solves are made to overlap for certain: each one's first CP-SAT
    call waits at a barrier until the other has reached its own. A budget
    written onto the shared Settings — by either — would show here as the
    other request's number.
    """
    recorder = _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    recorder.first_solve_waits = threading.Barrier(2, timeout=20)
    settings = _settings()
    app = create_app(settings)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        plain, candidate = await asyncio.gather(
            client.post("/api/v1/optimize", json=_payload(changeover=5), headers=HEADERS),
            client.post(
                "/api/v1/optimize",
                json=_payload(changeover=5, search={"maxSeconds": 30, "workers": 2}),
                headers=HEADERS,
            ),
        )

    assert plain.status_code == 200, plain.text
    assert candidate.status_code == 200, candidate.text
    assert plain.json()["conflicts"]["summaryParams"]["budget"] == 60
    assert candidate.json()["conflicts"]["summaryParams"]["budget"] == 30
    # One thread per request, and each thread's first solve has its own cap and
    # its own parameters: the Generera's carries no worker count.
    by_thread: dict[int, list[dict[str, str]]] = {}
    for thread, parameters in recorder.calls:
        by_thread.setdefault(thread, []).append(parameters)
    assert len(by_thread) == 2
    firsts = sorted(
        (calls[0] for calls in by_thread.values()),
        key=lambda p: float(p["max_time_in_seconds"]),
    )
    assert firsts[0] == {"max_time_in_seconds": "30", "num_workers": "2"}
    assert firsts[1] == {"max_time_in_seconds": "60"}
    assert app.state.settings is settings
    assert settings.solver_max_time_seconds == 60.0


# ---------------------------------------------------------------------------
# The seed and the workers
# ---------------------------------------------------------------------------


def test_the_seed_and_the_workers_reach_the_generation_solves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = _Recorder(monkeypatch)

    response = _post(create_app(_settings()), _payload(search={"seed": 7, "workers": 2}))

    assert response.status_code == 200, response.text
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}
    parameters = recorder.parameters()
    assert len(parameters) == 3, parameters  # phase 1a, the hint's completion, phase 2
    for each in parameters:
        assert each["random_seed"] == "7"
        assert each["num_workers"] == "2"
        # The budget is untouched: no maxSeconds was sent.
        assert float(each["max_time_in_seconds"]) <= 60.0
    assert float(parameters[0]["max_time_in_seconds"]) == 60.0


def test_the_lunch_stage_keeps_its_one_deterministic_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The seed and the workers are the GENERATION solves' only.

    The lunch stage is single-threaded on purpose, so its named causes are the
    same on every machine; a candidate's worker count must not reach it.
    """
    recorder = _Recorder(monkeypatch)
    payload = _payload(search={"seed": 7, "workers": 4})
    payload["rules"] = {"lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    # The stage runs for the classes the payload names as eating.
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
    payload["groups"] = [{"id": group_id, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6}]

    response = SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status in ("OPTIMAL", "FEASIBLE")
    parameters = recorder.parameters()
    stage = [p for p in parameters if p.get("linearization_level") == "2"]
    generation = [p for p in parameters if "linearization_level" not in p]
    assert stage, parameters
    assert all(p["num_workers"] == "1" and "random_seed" not in p for p in stage)
    assert len(generation) == 3, parameters
    assert all(p["num_workers"] == "4" and p["random_seed"] == "7" for p in generation)


# ---------------------------------------------------------------------------
# probes: false
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("probes", "solves", "explained"), [(None, 3, True), (False, 2, False)])
def test_probes_off_skips_the_timeout_probe(
    monkeypatch: pytest.MonkeyPatch, probes: bool | None, solves: int, explained: bool,
) -> None:
    """Off, a TIMEOUT stands bare after phase 1a and 1b — no probe solve at all."""
    recorder = _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    search = {"maxSeconds": 30} if probes is None else {"maxSeconds": 30, "probes": probes}

    response = SchedulerSolver(_settings()).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5, search=search)),
    )

    assert response.status == "TIMEOUT"
    assert (response.conflicts is not None) is explained
    assert len(recorder.calls) == solves


@pytest.mark.parametrize(("probes", "solves"), [(True, 2), (False, 1)])
def test_probes_off_skips_the_explanation(
    monkeypatch: pytest.MonkeyPatch, probes: bool, solves: int,
) -> None:
    """Off, an INFEASIBLE is the proof's verdict alone: no assumption re-solve,
    and so no blocks verdict either, which only ever runs after one."""
    recorder = _Recorder(monkeypatch, answer=cp_model.INFEASIBLE)
    _no_core(monkeypatch)

    response = SchedulerSolver(_settings()).solve(
        OptimizeScheduleRequest.model_validate(_payload(search={"probes": probes})),
    )

    assert response.status == "INFEASIBLE"
    assert response.lessons == []
    assert len(recorder.calls) == solves
    if not probes:
        assert response.conflicts is None


@pytest.mark.parametrize(("search", "named"), [(None, True), ({"probes": False}, False)])
def test_probes_off_skips_the_blocks_verdict(search: dict[str, object] | None, named: bool) -> None:
    """Called on its own, as _explain_infeasible would after a core named nothing.

    The control is the same call without `search`: two blocked requirements
    that solve at once without their block, so the verdict names the block.
    """
    payload = _payload(search=search)
    first = payload["requirements"][0]  # type: ignore[index]
    first["blockId"] = str(uuid4())  # type: ignore[index]
    second = {**first, "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": str(uuid4())}
    payload["requirements"] = [first, second]  # type: ignore[assignment]
    request = OptimizeScheduleRequest.model_validate(payload)

    verdict = SchedulerSolver(_settings())._blocks_verdict(request, seconds_left=30.0)

    assert (verdict is not None) is named


# ---------------------------------------------------------------------------
# The completed hint
# ---------------------------------------------------------------------------


def _hints(monkeypatch: pytest.MonkeyPatch, fail_completion: bool = False) -> list[tuple[int, int, bool]]:
    """Per solve of a model with an objective: (hinted, variables, is the completion)."""
    seen: list[tuple[int, int, bool]] = []
    original = cp_model.CpSolver.Solve

    def solve(
        solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object,
    ) -> int:
        completing = bool(solver.parameters.fix_variables_to_their_hinted_value)
        if model.HasObjective():
            proto = model.Proto()
            seen.append((len(proto.solution_hint.vars), len(proto.variables), completing))
        if completing and fail_completion:
            return cp_model.UNKNOWN
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    return seen


@pytest.mark.parametrize(("search", "complete"), [(None, False), ({"workers": 2}, True)])
def test_a_candidates_phase_2_starts_from_a_hint_on_every_variable(
    monkeypatch: pytest.MonkeyPatch, search: dict[str, object] | None, complete: bool,
) -> None:
    """Phase 1's timetable reaches phase 2 whole for a candidate, and as today for a Generera.

    Today's hint names the lessons' starts and rooms and none of the
    objective's own variables, which CP-SAT then completes by search; a
    candidate's names every variable the full model has. The previous lessons
    are sent so the disruption term, whose literals the partial hint leaves
    out, is in the model.
    """
    seen = _hints(monkeypatch)
    payload = _payload(search=search)
    requirement = payload["requirements"][0]  # type: ignore[index]
    payload["previousLessons"] = [
        {"requirementId": requirement["id"], "dayOfWeek": day, "startTime": "09:00:00"}  # type: ignore[index]
        for day in (1, 3)
    ]

    response = SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status in ("OPTIMAL", "FEASIBLE")
    phase2_hinted, phase2_variables, _ = seen[-1]
    if complete:
        # The completion, then phase 2 on the hint it wrote.
        assert [completing for _, _, completing in seen] == [True, False]
        assert phase2_hinted == phase2_variables
    else:
        assert [completing for _, _, completing in seen] == [False]
        assert phase2_hinted < phase2_variables


def test_a_completion_that_finds_nothing_leaves_phase_2_its_partial_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The completion is an improvement, never a new way to fail: phase 2
    runs on the hint it would have had without it."""
    seen = _hints(monkeypatch, fail_completion=True)

    response = SchedulerSolver(_settings()).solve(
        OptimizeScheduleRequest.model_validate(_payload(search={"workers": 2})),
    )

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert len(response.lessons) == 2
    assert [completing for _, _, completing in seen] == [True, False]
    phase2_hinted, phase2_variables, _ = seen[-1]
    assert 0 < phase2_hinted < phase2_variables


# ---------------------------------------------------------------------------
# The ceiling and the probe's clock (2026-11-17: three Generera runs answered
# 503 in the middle of their timeout probe)
# ---------------------------------------------------------------------------


#: What the gateway sends for a schemaförslag call (candidate-variants.ts
#: searchFor): the lead asks for the probes, the others do not. The same table
#: stands in src/optimization/candidate-variants.spec.ts, where the gateway's
#: wait for each call must exceed these ceilings: the engine answers first.
CANDIDATE_CEILINGS = [
    # (maxSeconds, probes, the engine's ceiling at a 20 s probe)
    (5, True, 37.5),
    (30, True, 75.0),
    (120, True, 170.0),
    (5, False, 35.0),
    (30, False, 60.0),
    (120, False, 150.0),
]


@pytest.mark.parametrize(
    ("budget", "probe", "search", "ceiling"),
    [
        # Production since 2026-11-03: 180 s and the default probe. The API waits 240 s.
        (180.0, 20.0, None, 230.0),
        # The defaults.
        (60.0, 20.0, None, 110.0),
        # A schemaförslag candidate: its 30 s, and a probe of half of that.
        (60.0, 20.0, {"maxSeconds": 30}, 75.0),
        # Probes off at the deployment: the budget and the builds.
        (60.0, 0.0, None, 90.0),
        # A candidate after the first: no probe is run, so none is waited for.
        (180.0, 20.0, {"maxSeconds": 30, "probes": False}, 60.0),
        *[
            (180.0, 20.0, {"maxSeconds": seconds, "probes": probes}, ceiling)
            for seconds, probes, ceiling in CANDIDATE_CEILINGS
        ],
    ],
)
def test_the_ceiling_lies_past_the_budget_the_probe_and_the_builds(
    budget: float, probe: float, search: dict[str, object] | None, ceiling: float,
) -> None:
    from app.api.v1.optimize import solve_ceiling_seconds

    options = SearchOptions.model_validate(search) if search is not None else None
    settings = settings_for_search(
        _settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=probe), options,
    )

    assert solve_ceiling_seconds(settings, options) == ceiling


@pytest.mark.parametrize(
    ("search", "waits"),
    [
        (None, 230.0),
        # The request's own budget and probe, not the deployment's.
        ({"maxSeconds": 30}, 75.0),
        # And no probe for a request that runs none.
        ({"maxSeconds": 30, "probes": False}, 60.0),
    ],
)
def test_run_solver_waits_for_the_ceiling_not_the_budget(
    monkeypatch: pytest.MonkeyPatch, search: dict[str, object] | None, waits: float,
) -> None:
    """The 503 is the ceiling's: a TIMEOUT and its probe answer before it."""
    from app.api.v1 import optimize

    _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    waited: list[float | None] = []
    real_wait_for = asyncio.wait_for

    async def wait_for(awaitable: object, timeout: float | None) -> object:
        waited.append(timeout)
        return await real_wait_for(awaitable, timeout=None)  # type: ignore[arg-type]

    monkeypatch.setattr(optimize.asyncio, "wait_for", wait_for)
    request = OptimizeScheduleRequest.model_validate(_payload(changeover=5, search=search))

    response = asyncio.run(
        optimize.run_solver(request, _settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20)),
    )

    assert response.status == "TIMEOUT"
    assert waited == [waits]


def test_a_solve_that_hangs_is_answered_503_with_the_sentence_the_gateway_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The route stops waiting at its ceiling and answers 503 with the shared body.

    The gateway turns exactly this 503 into ENGINE_TIMED_OUT
    (optimization-proxy.service.ts), by the code, or for an engine older than
    the code by the sentence. A rewording here would silently give every school
    the generic "The AI engine returned an error." again, so the body is read
    from tests/data/solver_timeout_body.json, which the API's spec reads too:
    change a sentence in either place and the other suite says so.
    """
    from app.api.v1 import optimize

    released = threading.Event()

    def stuck(self: SchedulerSolver, payload: OptimizeScheduleRequest) -> None:
        # Bounded, so a route that waits for it anyway fails the test rather than hanging it.
        released.wait(timeout=5.0)
        raise AssertionError("the route waited for a solve it had given up on")

    monkeypatch.setattr(SchedulerSolver, "solve", stuck)
    monkeypatch.setattr(optimize, "_SOLVE_BUILD_HEADROOM_SECONDS", 0.2)
    app = create_app(_settings(SOLVER_MAX_TIME_SECONDS=0.1, SOLVER_PROBE_SECONDS=0.1))

    with TestClient(app) as client_:
        try:
            response = client_.post("/api/v1/optimize", json=_payload(), headers=HEADERS)
        finally:
            released.set()

    shared = json.loads((Path(__file__).parent / "data" / "solver_timeout_body.json").read_text())
    assert response.status_code == 503, response.text
    assert response.json() == {
        "code": shared["code"],
        "message": shared["sentences"]["optimize"],
        # 0.1 s of search, 0.1 s of probe and the 0.2 s of headroom the test left.
        "details": {"route": "optimize", "ceilingSeconds": pytest.approx(0.4)},
    }

def test_the_timeout_probe_has_a_deadline_without_the_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    """The probe's seconds, counted from where the search ENDED.

    They were counted from where its budget ended (`started + budget + probe`),
    so a search that stopped ten seconds late spent ten of the probe's twenty
    before it began (the review of #344, LÅG-1). Here the search has no
    overrun, so the two are the same instant and the test cannot tell them
    apart; test_a_late_search_leaves_the_probe_its_own_seconds can.
    """
    _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    seen: list[tuple[float | None, float]] = []
    original = SchedulerSolver._probe_timeout

    def probe(self: SchedulerSolver, request: OptimizeScheduleRequest, *, deadline: float | None = None):  # type: ignore[no-untyped-def]
        seen.append((deadline, scheduler_solver.time.monotonic()))
        return original(self, request, deadline=deadline)

    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", probe)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=20)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    [(deadline, called_at)] = seen
    assert deadline is not None
    # Its seconds from the moment it was asked for, which lies just before the call.
    assert called_at - 1.0 <= deadline - 20.0 <= called_at

def test_a_deadline_that_leaves_the_search_nothing_leaves_the_probe_its_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A caller that waits less than the builds need is answered, without a search.

    A deadline of 7 s is a ceiling of 2 s and an answer due at 1 s, and the
    search yields the probe's floor (here its whole second): the search has
    none. It used to be a CP-SAT solve on a time limit at or under zero (a
    MODEL_INVALID, an HTTP 500). Now no search runs, and the TIMEOUT says it was
    searched for 0 s, with the one probe the clock leaves.
    """
    recorder = _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    payload = _payload(changeover=5)
    payload["deadlineSeconds"] = 7

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=0.5, SOLVER_PROBE_SECONDS=1.0)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )

    assert response.status == "TIMEOUT"
    assert response.conflicts is not None
    assert response.conflicts.summary_params["budget"] == 0
    # No search; the one solve that ran is the probe's, inside the second it was left.
    [only] = [float(p["max_time_in_seconds"]) for p in recorder.parameters()]
    assert 0.5 <= only <= 1.0, only


# ---------------------------------------------------------------------------
# The probe's clock, counted in steps (nothing sleeps)
# ---------------------------------------------------------------------------


class _Clock:
    """scheduler_solver's clock, replaced: every solve and every build is a step.

    The engine reads time.monotonic and time.perf_counter only. A solve takes
    its time limit and whatever it is told to overrun by, and a build takes
    `build` seconds, so a week that is slow to build or whose search stops late
    can be put in front of the probe without anyone waiting for it.
    """

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        *,
        late: float = 0.0,
        build: float = 0.0,
        first: int = cp_model.UNKNOWN,
        overrun: float = 0.0,
    ) -> None:
        self.now = 1000.0
        self.solves: list[float] = []
        self._late = late
        # What EVERY solve runs past its limit, as the search of the 809-lesson week did on
        # 2026-11-17 (ten seconds past its 180): `late` is the first solve's alone.
        self._overrun = overrun
        monkeypatch.setattr(
            scheduler_solver, "time",
            types.SimpleNamespace(monotonic=lambda: self.now, perf_counter=lambda: self.now),
        )

        def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *_a: object, **_k: object) -> int:
            limit = solver.parameters.max_time_in_seconds
            self.solves.append(limit)
            # The first solve stops `late` seconds after its limit, as CP-SAT does on a large week.
            self.now += limit + (self._late if len(self.solves) == 1 else 0.0) + self._overrun
            # `first` is what the first solve answers: INFEASIBLE makes a proof that comes late.
            return first if len(self.solves) == 1 else cp_model.UNKNOWN

        monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
        if build:
            original = SchedulerSolver._build_model

            def slow(solver: SchedulerSolver, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
                out = original(solver, *args, **kwargs)
                self.now += build
                return out

            monkeypatch.setattr(SchedulerSolver, "_build_model", slow)


def test_a_rule_is_probed_only_if_the_clock_has_its_build_and_a_slice_after_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rule's model is built before its slice starts, and a build with no slice after it is time for nothing.

    Builds of 4 s: the two of the search take 8, the search 10 (to 18), and the
    probe's 6 s end at 24. The first rule has the 4 s of its build and 1.5 of
    its slice (to 23.5). The second would have 0.5 s left, which is its slice's
    least and nothing for the build that comes first: it is not begun, and the
    solve answers at 23.5 and not at 27.5 after a build whose slice never ran.
    """
    clock = _Clock(monkeypatch, build=4.0)
    _rules_to_probe(monkeypatch, 4)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    assert len(clock.solves) == 2, "phase 1a and the one probe"
    assert clock.now - entered == pytest.approx(23.5)


def test_a_best_effort_rule_is_probed_only_if_the_clock_has_its_build_and_a_slice_after_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same for Bästa möjliga schema, which counts its build seconds from the request's arrival."""
    clock = _Clock(monkeypatch, build=4.0)
    _rules_to_probe(monkeypatch, 4)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_best_effort_payload()),
    )

    assert response.status == "TIMEOUT"
    assert clock.now - entered <= 10.0 + 6.0 + 1e-9, "the search from the arrival, then the probe's 6 s: not a build past them"


def test_the_requests_clock_is_gone_when_its_solve_is_over(monkeypatch: pytest.MonkeyPatch) -> None:
    """A step called on its own afterwards (a test, a benchmark) has no clock and no search seconds, as it always had none."""
    _Clock(monkeypatch)
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6))

    solver.solve(OptimizeScheduleRequest.model_validate(_payload(changeover=5)))

    assert solver._deadline is None
    assert solver._search_seconds is None
    assert solver._clock_left() is None


def _rules_to_probe(monkeypatch: pytest.MonkeyPatch, count: int) -> None:
    monkeypatch.setattr(
        SchedulerSolver, "_timeout_relaxations",
        lambda self, request: [(f"PROBE_SOLVED_WITHOUT_RULE_{index}", request) for index in range(count)],
    )


def _best_effort(changeover: int = 5) -> OptimizeScheduleRequest:
    payload = _payload(changeover=changeover)
    payload["requirements"][0]["maxLessonsPerDay"] = 1  # type: ignore[index]
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    return OptimizeScheduleRequest.model_validate(payload)


def test_a_probe_the_clock_cut_short_is_said_for_what_ran(monkeypatch: pytest.MonkeyPatch) -> None:
    """Four rules to probe, time for one: the summary says one, and how long it had.

    The caller waits 40 s, so the answer is due at 22 s (ceiling 35 less the
    three seconds the answer takes to build and the ten a solve may overrun).
    The search stops 11 s late, at 21 s, so 1 of the probe's 6 s is left, where
    a rule's slice is 1.5. It said
    "none of the 4 rules probed made a timetable appear inside 2 s each" of
    three searches that never began and a fourth that had a second.
    """
    clock = _Clock(monkeypatch, late=11.0)
    _rules_to_probe(monkeypatch, 4)
    payload = _payload(changeover=5)
    payload["deadlineSeconds"] = 40

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )

    assert response.status == "TIMEOUT"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "PROBE_NOTHING_HELPED"
    # Phase 1a, then the one probe the clock allowed.
    assert len(clock.solves) == 2
    assert clock.solves[1] == pytest.approx(1.0)
    assert response.conflicts.summary_params == {"budget": 10, "rules": 1, "slice": 1}

def test_a_search_that_used_the_probes_time_leaves_the_timeout_bare(monkeypatch: pytest.MonkeyPatch) -> None:
    """No probe ran, so no sentence says one did.

    The search stops 13 s late, at 23 s, after the answer was due (22 s).
    """
    clock = _Clock(monkeypatch, late=13.0)
    _rules_to_probe(monkeypatch, 4)
    payload = _payload(changeover=5)
    payload["deadlineSeconds"] = 40

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )

    assert response.status == "TIMEOUT"
    assert len(clock.solves) == 1
    assert response.conflicts is None


def test_a_late_search_leaves_the_probe_its_own_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    """The probe's seconds count from where the search ended, not from where its budget did.

    The review of #344 (LÅG-1): at 180 s a search that stopped ten seconds late
    left the parallel-groups probe 7 of its 12 s and the others none. Here the
    search stops 5 s late and the probe still has its 6: four rules, 1.5 s each.
    No deadline, so the clock's edge (46 s less 13) is far off.
    """
    clock = _Clock(monkeypatch, late=5.0)
    _rules_to_probe(monkeypatch, 4)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    assert clock.solves[0] == pytest.approx(10.0)
    assert clock.solves[1:] == [pytest.approx(1.5)] * 4
    assert response.conflicts is not None
    assert response.conflicts.summary_params == {"budget": 10, "rules": 4, "slice": 2}

def test_the_probe_clock_starts_after_the_builds_where_the_walk_is_not_kept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe's seconds are counted from the search, not from the request.

    Two builds of three seconds each come first, and the probe still has its
    whole share: 6 + 10 + 6 seconds after the request, not 16. Counting from
    the request would give a week that builds slowly none of the explanation
    the ceiling's thirty seconds were left for.
    """
    clock = _Clock(monkeypatch, build=3.0)
    _rules_to_probe(monkeypatch, 1)
    seen: list[float | None] = []
    original = SchedulerSolver._probe_timeout

    def probe(self: SchedulerSolver, request: OptimizeScheduleRequest, *, deadline: float | None = None):  # type: ignore[no-untyped-def]
        seen.append(deadline)
        return original(self, request, deadline=deadline)

    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", probe)
    entered = clock.now

    SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert seen == [entered + 6.0 + 10.0 + 6.0]


def test_the_best_effort_timeout_probe_ends_on_a_clock_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bästa möjliga schema's TIMEOUT answers within the search and the probe's seconds.

    The search stops two seconds late and five rules are left to probe, each
    with a one-second build. Without a clock all five ran their builds and
    slices after the budget (23 s of a 16 s allowance), which at 180 s put the
    answer past the engine's ceiling on a week with five or more rules.
    """
    clock = _Clock(monkeypatch, late=2.0)
    _rules_to_probe(monkeypatch, 5)
    original = SchedulerSolver._build_model
    in_probe = {"on": False}

    def build(solver: SchedulerSolver, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        out = original(solver, *args, **kwargs)
        if in_probe["on"]:
            clock.now += 1.0
        return out

    probe_original = SchedulerSolver._probe_timeout

    def probe(self: SchedulerSolver, request: OptimizeScheduleRequest, **kwargs: object):  # type: ignore[no-untyped-def]
        in_probe["on"] = True
        return probe_original(self, request, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", build)
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", probe)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(_best_effort())

    assert response.status == "TIMEOUT"
    # The search's 10 s and its 2 late, the probe's 6, and the one build the clock cannot cut short.
    assert clock.now - entered <= 10.0 + 2.0 + 6.0 + 1.0, clock.now - entered
    # And the probe had its time: the clock is the probe's seconds from where the search ended.
    assert len(clock.solves) > 1


# ---------------------------------------------------------------------------
# M1, Tidskedjan: what the request's clock cuts, and what it leaves alone
# ---------------------------------------------------------------------------


def _with_deadline(payload: dict[str, object], seconds: float) -> OptimizeScheduleRequest:
    payload["deadlineSeconds"] = seconds
    return OptimizeScheduleRequest.model_validate(payload)


def test_a_caller_that_waits_less_than_the_settings_need_is_answered_inside_its_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The settings say 20 s of search and 6 of probe; the caller waits 35 s.

    Its ceiling is 30 s and the answer is due at 17, so the search ends at 12
    (17 less the probe's floor of 5) and the TIMEOUT says it searched for 12 s,
    not 20: the number on the page is the number the search had. The probe has
    the 5 s that are left. Before, this was a 503 the caller had already stopped
    waiting for, and the school read "did not respond in time".
    """
    clock = _Clock(monkeypatch)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(_payload(changeover=5), 35),
    )

    assert response.status == "TIMEOUT"
    assert clock.solves == [pytest.approx(12.0), pytest.approx(5.0)]
    assert response.conflicts is not None
    assert response.conflicts.summary_params == {"budget": 12, "rules": 1, "slice": 5}
    # And the answer was in time: due at 17 s.
    assert clock.now - entered == pytest.approx(17.0)


def test_a_squeezed_search_that_stops_as_late_as_the_incidents_did_still_answers_inside_the_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The clock's edge leaves room for what a solve runs past its limit (SOLVE_OVERRUN_SECONDS).

    The settings say 30 s of search and 6 of probe; the caller waits 35 s, so the
    ceiling is 30 s. The search is cut to what the clock leaves (12 s) and then
    runs the ten seconds past that CP-SAT ran past its 180 on 2026-11-17: it ends
    at 22 s and there is no time for a probe. With the edge three seconds before
    the ceiling the search was given 22 s, ended at 32 s and the route had
    answered 503 at 30: "did not answer within its longest wait", and no TIMEOUT
    to read.
    """
    clock = _Clock(monkeypatch, overrun=10.0)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=30, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(_payload(changeover=5), 35),
    )

    assert response.status == "TIMEOUT"
    assert clock.now - entered <= 30.0, "the route's ceiling for this request"


def test_a_slow_setup_leaves_the_late_search_inside_the_ceiling_at_the_production_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """180 s of search, 20 of probe, a ceiling of 230: builds of 25 s each and a search that runs ten over.

    The two builds take 50 s, so the search is given what the clock leaves
    (217 less the probe's floor less 50: 162 s, not 180) and ends at 222 s with
    its overrun. With the edge at 227 it was given 172 s and ended at 232, after
    the route had answered 503 at 230.
    """
    clock = _Clock(monkeypatch, build=25.0, overrun=10.0)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    assert clock.now - entered <= 230.0, "180 + 20 + 30, the route's ceiling"


def test_a_deadline_the_settings_fit_inside_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Whole budget, whole probe: the same solve as a request that carried none."""
    with_deadline = _Clock(monkeypatch)
    SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(_payload(changeover=5), 400),
    )
    kept = list(with_deadline.solves)

    without = _Clock(monkeypatch)
    SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert kept == without.solves == [20.0, 6.0]


def test_an_infeasible_proof_that_comes_late_is_explained_only_as_far_as_the_clock_goes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The review of #344, LÅG-2: the explanation had a cap of its own and no clock.

    The caller waits 50 s (ceiling 45, the answer due at 32). The proof comes
    at 20 s, and the explanation's cap is 15 s, which would have ended at 35:
    past the edge. It is given the 12 s the clock has left.
    """
    clock = _Clock(monkeypatch, first=cp_model.INFEASIBLE)
    entered = clock.now

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(_payload(changeover=5), 50),
    )

    assert response.status == "INFEASIBLE"
    assert clock.solves[0] == pytest.approx(20.0)
    assert clock.solves[1] == pytest.approx(12.0)
    assert clock.now - entered <= 32.0 + 1e-9


def test_an_infeasible_proof_that_comes_too_late_stands_unexplained(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The verdict was proved; an explanation that cannot have half a second is left out.

    The proof comes at 31.7 s of an answer due at 32: nothing is built, nothing
    is solved, and the school reads INFEASIBLE without the names (as it already
    does when the explanation gives UNKNOWN).
    """
    clock = _Clock(monkeypatch, late=11.7, first=cp_model.INFEASIBLE)
    builds: list[bool] = []
    original = SchedulerSolver._build_model

    def counted(solver: SchedulerSolver, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        builds.append(bool(kwargs.get("use_assumptions")))
        return original(solver, *args, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", counted)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(_payload(changeover=5), 50),
    )

    assert response.status == "INFEASIBLE"
    assert response.conflicts is None
    assert len(clock.solves) == 1
    # The two models of the search, and none for the explanation: a build is paid before its solve.
    assert builds == [False, False]


def test_an_infeasible_proof_with_no_deadline_is_explained_as_it_always_was(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No deadline: the cap is min(budget, 15 s), and a late proof is still explained for it."""
    clock = _Clock(monkeypatch, late=5.0, first=cp_model.INFEASIBLE)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "INFEASIBLE"
    assert clock.solves[1] == 15.0


def test_the_probe_does_not_count_the_rules_after_its_time_has_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The review of #344, LÅG-3: _timeout_relaxations counted the week's load first, on no clock."""
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6))

    def counted(self: SchedulerSolver, request: OptimizeScheduleRequest) -> list[tuple[str, OptimizeScheduleRequest]]:
        raise AssertionError("the rules were counted after the clock ran out")

    monkeypatch.setattr(SchedulerSolver, "_timeout_relaxations", counted)

    outcome = solver._probe_timeout(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
        deadline=scheduler_solver.time.monotonic() - 1.0,
    )

    assert outcome is None


def test_the_week_load_count_stops_at_the_clocks_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    """Four seconds a real week, and never past the answer's edge."""
    seen: list[float] = []

    def count(*_args: object, deadline: float, **_kwargs: object) -> list[object]:
        seen.append(deadline)
        return []

    monkeypatch.setattr(scheduler_solver, "week_loads", count)
    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(_payload())

    solver._week_loads(request)
    outside_a_solve = seen.pop()
    solver._deadline = Deadline(entered=scheduler_solver.time.monotonic(), ceiling=4.0)
    solver._week_loads(request)
    inside_a_short_one = seen.pop()

    now = scheduler_solver.time.monotonic()
    assert 3.0 < outside_a_solve - now <= SchedulerSolver.WEEK_LOAD_SECONDS
    assert inside_a_short_one <= solver._deadline.answer_by
    assert inside_a_short_one - now < 2.5


def test_a_best_effort_week_whose_caller_waits_less_is_answered_inside_the_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bästa möjliga schema counts its search from the request's arrival, and the deadline holds it too."""
    clock = _Clock(monkeypatch)
    entered = clock.now
    payload = _best_effort_payload()

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(payload, 35),
    )

    assert response.status == "TIMEOUT"
    assert clock.solves[0] == pytest.approx(12.0)
    assert clock.now - entered <= 17.0 + 1e-9


def test_a_best_effort_deadline_that_leaves_the_search_nothing_is_the_timeout_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = _Clock(monkeypatch, build=3.0)
    payload = _best_effort_payload()

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=6)).solve(
        _with_deadline(payload, 14),
    )

    # Ceiling 9 s, due at 4.5 s (a ceiling that short gives up half of itself); two builds of 3 s have used it, and the search had none.
    assert response.status == "TIMEOUT"
    assert clock.solves == []


def _best_effort_payload(changeover: int = 5) -> dict[str, object]:
    payload = _payload(changeover=changeover)
    payload["requirements"][0]["maxLessonsPerDay"] = 1  # type: ignore[index]
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    return payload


def test_an_explanations_next_try_is_counted_with_what_a_build_costs(monkeypatch: pytest.MonkeyPatch) -> None:
    """The cap's remainder and the clock's, after the build the try has to pay first."""
    clock = _Clock(monkeypatch)
    solver = SchedulerSolver(_settings())
    assert solver._explanation_room(10.0, 4.0) == 10.0  # outside a solve there is no clock, only the cap

    solver._deadline = Deadline(entered=clock.now, ceiling=26.0)  # due at 13 s

    assert solver._explanation_room(10.0, 4.0) == pytest.approx(9.0)
    assert solver._explanation_room(3.0, 4.0) == pytest.approx(3.0)
    assert solver._explanation_room(20.0, 0.0) == pytest.approx(13.0)


def test_the_förläggning_verdicts_get_what_the_clock_has_left(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both asks of the released week count to the edge, not past it, whatever the settings say.

    The settings give budget 180 and probe 20, so without the clock they would be
    given 200 s from the request's arrival; the caller waits 35 s, due at 17.
    """
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleResponse

    clock = _Clock(monkeypatch)
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20))
    solver._deadline = Deadline(entered=clock.now, ceiling=30.0)
    request = OptimizeScheduleRequest.model_validate(_payload()).model_copy(update={"placements": object()})
    seen: list[float | None] = []
    monkeypatch.setattr(SchedulerSolver, "_asks_the_released_week", staticmethod(lambda request, response: True))

    def verdict(self: SchedulerSolver, request: OptimizeScheduleRequest, *, seconds_left: float | None = None) -> None:
        seen.append(seconds_left)

    monkeypatch.setattr(SchedulerSolver, "_placements_verdict", verdict)
    refused = OptimizeScheduleResponse(
        request_id=request.request_id, status="INFEASIBLE", lessons=[], conflicts=None,
    )

    solver._with_placements_named(request, refused, clock.now)
    solver._refusal_with_placements_named(
        request, InvalidScheduleInputError("a lock", code="SOME_REFUSAL"), clock.now,
    )

    assert seen == [pytest.approx(17.0), pytest.approx(17.0)]
