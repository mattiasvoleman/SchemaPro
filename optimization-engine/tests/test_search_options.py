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
import threading
import types
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
    assert limits[2] == 15.0
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
    """The ceiling end to end: the status and the body's sentence.

    The gateway turns exactly this 503 into ENGINE_TIMED_OUT
    (optimization-proxy.service.ts, ENGINE_CEILING_SENTENCE) by comparing
    the sentence, so a rewording here would silently give every school the
    generic "The AI engine returned an error." again. The same body stands in
    that file's spec.
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

    assert response.status_code == 503, response.text
    assert response.json() == {"code": "HTTP_ERROR", "message": "Optimization timed out."}


def test_the_timeout_probe_has_a_deadline_without_the_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    """The budget and the probe's seconds from the moment the search began."""
    _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    seen: list[tuple[float | None, float]] = []
    original = SchedulerSolver._probe_timeout

    def probe(self: SchedulerSolver, request: OptimizeScheduleRequest, *, deadline: float | None = None):  # type: ignore[no-untyped-def]
        seen.append((deadline, scheduler_solver.time.monotonic()))
        return original(self, request, deadline=deadline)

    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", probe)
    before = scheduler_solver.time.monotonic()

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=20)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    [(deadline, called_at)] = seen
    assert deadline is not None
    # started lies between the request's arrival and the probe's call.
    assert before + 80.0 <= deadline <= called_at + 80.0


def test_a_search_that_overran_its_budget_leaves_the_probe_unstarted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A probe that cannot have the rest of its slice is not started.

    Phase 1a is made to stop late, as CP-SAT does on a large week: past the
    budget AND the probe's seconds. Without the deadline the probe ran its
    whole slice after it, which on 2026-11-17 put the answer past the API's
    ceiling. With it the TIMEOUT answers at once, unprobed.
    """
    recorder = _Recorder(monkeypatch, answer=cp_model.UNKNOWN)
    original = cp_model.CpSolver.Solve

    def late(solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
        answer = original(solver, model, *args, **kwargs)
        threading.Event().wait(1.6)
        return answer

    monkeypatch.setattr(cp_model.CpSolver, "Solve", late)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=0.5, SOLVER_PROBE_SECONDS=1.0)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    # Phase 1a only: phase 1b had no time left, and the probe's deadline had passed.
    assert len(recorder.calls) == 1, recorder.parameters()


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

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, late: float = 0.0, build: float = 0.0) -> None:
        self.now = 1000.0
        self.solves: list[float] = []
        self._late = late
        monkeypatch.setattr(
            scheduler_solver, "time",
            types.SimpleNamespace(monotonic=lambda: self.now, perf_counter=lambda: self.now),
        )

        def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *_a: object, **_k: object) -> int:
            limit = solver.parameters.max_time_in_seconds
            self.solves.append(limit)
            # The first solve stops `late` seconds after its limit, as CP-SAT does on a large week.
            self.now += limit + (self._late if len(self.solves) == 1 else 0.0)
            return cp_model.UNKNOWN

        monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
        if build:
            original = SchedulerSolver._build_model

            def slow(solver: SchedulerSolver, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
                out = original(solver, *args, **kwargs)
                self.now += build
                return out

            monkeypatch.setattr(SchedulerSolver, "_build_model", slow)


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

    The search stops 5 s late, so 1 of the probe's 6 s is left, where a rule's
    slice is 1.5. It said "none of the 4 rules probed made a timetable appear
    inside 2 s each" of three searches that never began and a fourth that had
    a second.
    """
    clock = _Clock(monkeypatch, late=5.0)
    _rules_to_probe(monkeypatch, 4)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "PROBE_NOTHING_HELPED"
    # Phase 1a, then the one probe the clock allowed.
    assert len(clock.solves) == 2
    assert response.conflicts.summary_params == {"budget": 10, "rules": 1, "slice": 1}


def test_a_search_that_used_the_probes_time_leaves_the_timeout_bare(monkeypatch: pytest.MonkeyPatch) -> None:
    """No probe ran, so no sentence says one did."""
    clock = _Clock(monkeypatch, late=7.0)
    _rules_to_probe(monkeypatch, 4)

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6)).solve(
        OptimizeScheduleRequest.model_validate(_payload(changeover=5)),
    )

    assert response.status == "TIMEOUT"
    assert len(clock.solves) == 1
    assert response.conflicts is None


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
    """Bästa möjliga schema's TIMEOUT answers within the budget and the probe.

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
    # The budget, the probe, and the one build the clock cannot cut short.
    assert clock.now - entered <= 10.0 + 6.0 + 1.0, clock.now - entered
    # And the probe had its time: the clock is the budget AND the probe's seconds.
    assert len(clock.solves) > 1
