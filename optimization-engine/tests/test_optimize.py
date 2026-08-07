from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

# conftest.py seeds the environment before this module is imported, which the
# module-level `app = _default_app()` in app.main needs at import time.
from app.config import Settings
from app.main import create_app

API_KEY = "test-api-key-000000000000000000000000"


def _settings(**overrides: object) -> Settings:
    """Settings for a test app. create_app() honours these for every route."""
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            **overrides,
        },
    )


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(_settings()))


def _sample_payload() -> dict[str, object]:
    requirement_id = str(uuid4())
    room_id = str(uuid4())
    teacher_id = str(uuid4())
    group_id = str(uuid4())
    subject_id = str(uuid4())

    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": requirement_id,
                "subjectId": subject_id,
                "studentGroupId": group_id,
                "teacherId": teacher_id,
                "lessonsPerWeek": 2,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
            }
        ],
        "rooms": [
            {"id": room_id, "capacity": 30},
        ],
        "constraints": [],
    }


def _large_but_satisfiable_payload() -> dict[str, object]:
    """100 lessons across 8 rooms — comfortably satisfiable, not instant to solve.

    Room capacity is 8 rooms x 50 hour-slots = 400 lesson-slots for 100 lessons,
    so a solution provably exists; the model is just big enough that a
    millisecond budget expires before CP-SAT finds one.
    """
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": str(uuid4()),
                "teacherId": str(uuid4()),
                "lessonsPerWeek": 5,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
            }
            for _ in range(20)
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(8)],
        "constraints": [],
    }


def test_healthcheck(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_optimize_requires_api_key(client: TestClient) -> None:
    response = client.post("/api/v1/optimize", json=_sample_payload())
    assert response.status_code == 401


def test_optimize_returns_schedule(client: TestClient) -> None:
    response = client.post(
        "/api/v1/optimize",
        json=_sample_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert len(body["lessons"]) == 2
    assert body["lessons"][0]["requirementId"] is not None
    assert body["lessons"][0]["roomId"] is not None


def test_legacy_schedule_route(client: TestClient) -> None:
    response = client.post(
        "/v1/schedule",
        json=_sample_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}


def test_optimize_rejects_oversized_requirements(client: TestClient) -> None:
    payload = _sample_payload()
    template = payload["requirements"][0]  # type: ignore[index]
    payload["requirements"] = [
        {**template, "id": str(uuid4()), "studentGroupId": str(uuid4())}
        for _ in range(2001)  # exceeds max_length=2000
    ]
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 422  # schema max_length rejects before solving


def test_settings_passed_to_create_app_reach_the_solver() -> None:
    """create_app()'s Settings must win over the cached env-backed defaults.

    The route used to resolve `Depends(get_settings)` — the lru_cached factory
    reading os.environ — so everything handed to create_app() (solver budget,
    grid geometry, objective weights) was silently ignored.

    A Monday-only grid is the sharpest probe: the environment says Mon-Fri, and
    under Mon-Fri the spread penalty actively pushes the requirement's two
    lessons onto *different* days. Both landing on Monday is only possible if
    the SCHEDULE_DAYS handed to create_app() is what the solver actually built.
    """
    app = create_app(_settings(SCHEDULE_DAYS="1"))
    assert app.state.settings.schedule_days == [1]

    response = TestClient(app).post(
        "/api/v1/optimize",
        json=_sample_payload(),
        headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert len(body["lessons"]) == 2
    assert [lesson["dayOfWeek"] for lesson in body["lessons"]] == [1, 1]


def test_provably_infeasible_request_still_reports_infeasible(client: TestClient) -> None:
    """A genuine impossibility keeps returning INFEASIBLE plus conflict analysis.

    Guards the other side of the timeout fix: only CP-SAT's INFEASIBLE maps to
    "INFEASIBLE", and it still must.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    # Block the group across the whole grid. 17:45 is the last representable
    # time (the 18:00 day end is exclusive), leaving only a 15-minute tail —
    # too short for the 60-minute lesson, so no placement exists.
    payload["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "STUDENT_GROUP",
            "resourceId": requirement["studentGroupId"],  # type: ignore[index]
            "dayOfWeek": day,
            "date": None,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
            "kind": "UNAVAILABLE",
        }
        for day in (1, 2, 3, 4, 5)
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "INFEASIBLE"
    assert body["lessons"] == []
    assert body["conflicts"] is not None
    assert body["conflicts"]["conflicts"], "infeasible responses must explain why"


def test_tiny_time_budget_never_reports_a_satisfiable_model_as_infeasible() -> None:
    """A budget too small to solve in must not be reported as "no schedule exists".

    CP-SAT returns UNKNOWN when it exhausts its budget without finding a
    solution — that is not a proof of infeasibility. The gateway treats
    INFEASIBLE as final and writes no lessons, so conflating the two would tell
    a school its timetable is impossible when the solver merely ran out of time.
    """
    payload = _large_but_satisfiable_payload()
    headers = {"X-API-Key": API_KEY}

    generous = TestClient(create_app(_settings(SOLVER_MAX_TIME_SECONDS=30.0)))
    baseline = generous.post("/api/v1/optimize", json=payload, headers=headers)
    assert baseline.status_code == 200
    assert baseline.json()["status"] in {"OPTIMAL", "FEASIBLE"}, (
        "payload must be satisfiable for this test to mean anything"
    )

    starved = TestClient(create_app(_settings(SOLVER_MAX_TIME_SECONDS=0.001)))
    response = starved.post("/api/v1/optimize", json=payload, headers=headers)

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "SOLVER_TIMEOUT"
    assert "INFEASIBLE" not in str(body)


def test_short_api_key_is_rejected_at_config() -> None:
    with pytest.raises(ValueError, match="at least 32 characters"):
        Settings(API_KEY="too-short", ALLOWED_ORIGINS="http://testserver")


def test_wildcard_origin_is_rejected_at_config() -> None:
    with pytest.raises(ValueError, match="Wildcard"):
        Settings(
            API_KEY="test-api-key-000000000000000000000000",
            ALLOWED_ORIGINS="*",
        )


def test_rate_limit_returns_429() -> None:
    limited_client = TestClient(create_app(_settings(RATE_LIMIT_PER_MINUTE=3)))
    # Health is exempt; hit an authed route repeatedly to trip the limiter.
    # The limiter counts requests before routing, so an intentionally invalid
    # body exercises the window without paying for three real solves.
    headers = {"X-API-Key": API_KEY}
    statuses = [
        limited_client.post("/api/v1/optimize", json={"bad": "payload"}, headers=headers).status_code
        for _ in range(5)
    ]
    # Exactly the configured limit gets through: with the 120/min default from
    # the environment, all five would have been let past.
    assert statuses == [422, 422, 422, 429, 429]


def test_rate_limit_exempts_health() -> None:
    limited_client = TestClient(create_app(_settings(RATE_LIMIT_PER_MINUTE=1)))
    statuses = [limited_client.get("/health").status_code for _ in range(3)]
    assert statuses == [200, 200, 200]


def test_fixed_lessons_block_shared_resources(client: TestClient) -> None:
    """Generated lessons must not overlap a locked lesson sharing group/teacher/room.

    The group is boxed in: Monday 08:00-18:00 is fully blocked by a fixed
    lesson except 09:00-10:00, and Tue-Fri are blocked by UNAVAILABLE
    constraints. The only legal placement for the single generated lesson is
    Monday 09:00-10:00, which proves the fixed window is honored.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    group_id = requirement["studentGroupId"]  # type: ignore[index]
    room_id = payload["rooms"][0]["id"]  # type: ignore[index]

    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "teacherId": None,
            "studentGroupId": group_id,
            "roomId": room_id,
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        },
        {
            "id": str(uuid4()),
            "teacherId": None,
            "studentGroupId": group_id,
            "roomId": room_id,
            "dayOfWeek": 1,
            "startTime": "10:00:00",
            "endTime": "18:00:00",
        },
    ]
    payload["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "STUDENT_GROUP",
            "resourceId": group_id,
            "dayOfWeek": day,
            "date": None,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
            "kind": "UNAVAILABLE",
        }
        for day in (2, 3, 4, 5)
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert len(body["lessons"]) == 1
    lesson = body["lessons"][0]
    assert lesson["dayOfWeek"] == 1
    assert lesson["startTime"] == "09:00:00"
    assert lesson["endTime"] == "10:00:00"


def test_fixed_lessons_outside_grid_are_ignored(client: TestClient) -> None:
    """A locked weekend lesson must not break a Mon-Fri grid solve."""
    payload = _sample_payload()
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "teacherId": None,
            "studentGroupId": payload["requirements"][0]["studentGroupId"],  # type: ignore[index]
            "roomId": None,
            "dayOfWeek": 6,
            "startTime": "09:00:00",
            "endTime": "10:00:00",
        }
    ]
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}


def test_required_room_type_is_enforced(client: TestClient) -> None:
    """A LABORATORY-only requirement must land in the lab, not the bigger classroom."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    requirement["requiredRoomType"] = "LABORATORY"  # type: ignore[index]
    lab_id = str(uuid4())
    payload["rooms"] = [
        {"id": payload["rooms"][0]["id"], "capacity": 100, "type": "CLASSROOM"},  # type: ignore[index]
        {"id": lab_id, "capacity": 30, "type": "LABORATORY"},
    ]
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert body["lessons"][0]["roomId"] == lab_id


def test_previous_lessons_are_preserved(client: TestClient) -> None:
    """With disruption weight active, the solver keeps the previous slots."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    payload["previousLessons"] = [
        {
            "requirementId": requirement["id"],  # type: ignore[index]
            "dayOfWeek": 3,
            "startTime": "11:00:00",
        },
        {
            "requirementId": requirement["id"],  # type: ignore[index]
            "dayOfWeek": 5,
            "startTime": "14:00:00",
        },
    ]
    payload["weights"] = {"disruption": 100, "spread": 0}
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "OPTIMAL"
    placed = {(lesson["dayOfWeek"], lesson["startTime"]) for lesson in body["lessons"]}
    assert (3, "11:00:00") in placed
    assert (5, "14:00:00") in placed


def test_co_teacher_prevents_overlap(client: TestClient) -> None:
    """Two requirements sharing a co-teacher must never overlap."""
    payload = _sample_payload()
    shared_co = str(uuid4())
    base = payload["requirements"][0]  # type: ignore[index]
    base["lessonsPerWeek"] = 3  # type: ignore[index]
    base["coTeacherId"] = shared_co  # type: ignore[index]
    payload["requirements"].append(  # type: ignore[union-attr]
        {
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "coTeacherId": shared_co,
            "lessonsPerWeek": 3,
            "minutesPerLesson": 60,
            "studentGroupSize": 20,
        }
    )
    payload["rooms"].append({"id": str(uuid4()), "capacity": 30})  # type: ignore[union-attr]
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    slots = [
        (lesson["dayOfWeek"], lesson["startTime"], lesson["endTime"])
        for lesson in body["lessons"]
    ]

    def minutes(value: str) -> int:
        h, m, _ = value.split(":")
        return int(h) * 60 + int(m)

    for i in range(len(slots)):
        for j in range(i + 1, len(slots)):
            if slots[i][0] != slots[j][0]:
                continue
            no_overlap = (
                minutes(slots[i][2]) <= minutes(slots[j][1])
                or minutes(slots[j][2]) <= minutes(slots[i][1])
            )
            assert no_overlap, f"co-taught lessons overlap: {slots[i]} vs {slots[j]}"


def test_lunch_break_rule_is_enforced(client: TestClient) -> None:
    """Each group keeps a free 45-min window inside 11:00-13:00 every day."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 10  # type: ignore[index]
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "13:00:00",
        "lunchMinutes": 45,
    }
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}

    def minutes(value: str) -> int:
        h, m, _ = value.split(":")
        return int(h) * 60 + int(m)

    by_day: dict[int, list[tuple[int, int]]] = {}
    for lesson in body["lessons"]:
        by_day.setdefault(lesson["dayOfWeek"], []).append(
            (minutes(lesson["startTime"]), minutes(lesson["endTime"]))
        )
    for day, intervals in by_day.items():
        found_window = False
        for cand in range(11 * 60, 13 * 60 - 45 + 1, 15):
            if all(end <= cand or start >= cand + 45 for start, end in intervals):
                found_window = True
                break
        assert found_window, f"no 45-min lunch window on day {day}: {sorted(intervals)}"


# ---------------------------------------------------------------------------
# Solver status semantics
#
# "INFEASIBLE" is a proof and must stay one. A solve that merely ran out of
# wall-clock time proves nothing, so it reports "TIMEOUT" and carries no
# conflict analysis — a conflict core read off an unfinished search would name
# conflicts that need not exist.
# ---------------------------------------------------------------------------


def _oversubscribed_payload() -> dict[str, object]:
    """A payload that is provably impossible: one group needs 160 h of a 50 h week.

    The single student group must attend 40 lessons of 240 minutes (9600 min)
    but the grid only offers 5 days x 600 min = 3000 min, so the group's
    no-overlap constraint is violated by simple energy reasoning. CP-SAT
    refutes this at presolve, well inside the default time budget.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 40  # type: ignore[index]
    requirement["minutesPerLesson"] = 240  # type: ignore[index]
    return payload


def _large_feasible_payload() -> dict[str, object]:
    """A satisfiable but slow-to-build payload: 30 self-contained groups.

    Every group has its own teacher and its own room, so a schedule always
    exists — whatever the solver reports, it can never legitimately be
    INFEASIBLE.
    """
    room_ids = [str(uuid4()) for _ in range(30)]
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": str(uuid4()),
                "teacherId": str(uuid4()),
                "lessonsPerWeek": 3,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
            }
            for _ in range(30)
        ],
        "rooms": [{"id": room_id, "capacity": 30} for room_id in room_ids],
        "constraints": [],
    }


def _cp_model_status(name: str) -> int:
    from ortools.sat.python import cp_model

    return int(getattr(cp_model, name))


def _patch_solve_status(monkeypatch: pytest.MonkeyPatch, status_code: int) -> None:
    """Force CpSolver.Solve to return a specific CP-SAT status code.

    Timeouts are wall-clock dependent, so faking the status is the only way to
    assert the mapping deterministically.
    """
    from app.solver import scheduler_solver as solver_module

    def _fake_solve(self, model, solution_callback=None):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202, ARG001
        return status_code

    monkeypatch.setattr(solver_module.cp_model.CpSolver, "Solve", _fake_solve)


def test_map_status_only_reports_infeasible_when_cp_sat_proved_it() -> None:
    from ortools.sat.python import cp_model

    from app.solver.scheduler_solver import SchedulerSolver

    assert SchedulerSolver._map_status(cp_model.OPTIMAL) == "OPTIMAL"
    assert SchedulerSolver._map_status(cp_model.FEASIBLE) == "FEASIBLE"
    assert SchedulerSolver._map_status(cp_model.INFEASIBLE) == "INFEASIBLE"
    # The regression: UNKNOWN is "we ran out of time", not "it is impossible".
    assert SchedulerSolver._map_status(cp_model.UNKNOWN) == "TIMEOUT"


def test_proven_infeasible_reports_infeasible_with_conflicts(client: TestClient) -> None:
    response = client.post(
        "/api/v1/optimize",
        json=_oversubscribed_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "INFEASIBLE"
    assert body["lessons"] == []
    # A proof happened, so the school gets an explanation.
    assert body["conflicts"] is not None
    assert len(body["conflicts"]["conflicts"]) >= 1
    assert body["conflicts"]["summary"]


def test_timed_out_solve_reports_timeout_not_infeasible(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_solve_status(monkeypatch, _cp_model_status("UNKNOWN"))
    response = client.post(
        "/api/v1/optimize",
        json=_sample_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "TIMEOUT"
    assert body["lessons"] == []


def test_timed_out_solve_never_builds_a_conflict_analysis(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No assumption was proven guilty, so no conflict core may be reported."""
    from app.solver import scheduler_solver as solver_module

    def _explode(*args: object, **kwargs: object) -> None:
        msg = "conflict analysis must not run on an unproven (timed-out) solve"
        raise AssertionError(msg)

    monkeypatch.setattr(solver_module, "build_conflict_analysis", _explode)
    _patch_solve_status(monkeypatch, _cp_model_status("UNKNOWN"))

    response = client.post(
        "/api/v1/optimize",
        json=_sample_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    assert response.json()["conflicts"] is None


def test_invalid_model_is_a_server_error_not_infeasible(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MODEL_INVALID is our bug, not the school's — never a scheduling verdict."""
    _patch_solve_status(monkeypatch, _cp_model_status("MODEL_INVALID"))
    response = client.post(
        "/api/v1/optimize",
        json=_sample_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 500
    assert response.json()["code"] == "SOLVER_BUILD_ERROR"


def test_tiny_time_budget_never_reports_a_satisfiable_model_as_infeasible() -> None:
    """End-to-end guard on a real solve with a 1 ms budget.

    The payload is satisfiable by construction, so INFEASIBLE is always a lie
    here no matter how fast the machine is — and conflicts may only ever
    accompany a proof. Before the fix this returned INFEASIBLE plus a conflict
    analysis read off an unfinished search.

    The budget is passed straight to `create_app()`. That only works because
    handlers now resolve configuration through `get_app_settings`; while they
    still called the lru_cached `get_settings()`, this Settings instance was
    silently ignored and the test had to set SOLVER_MAX_TIME_SECONDS in the
    environment and clear the cache around it.
    """
    settings = Settings(
        API_KEY="test-api-key-000000000000000000000000",
        ALLOWED_ORIGINS="http://testserver",
        SCHEDULE_DAYS="1,2,3,4,5",
        SOLVER_MAX_TIME_SECONDS=0.001,
    )
    impatient_client = TestClient(create_app(settings))
    response = impatient_client.post(
        "/api/v1/optimize",
        json=_large_feasible_payload(),
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] != "INFEASIBLE"
    assert body["conflicts"] is None


def _minutes(hhmmss: str) -> int:
    hours, minutes, _seconds = (int(part) for part in hhmmss.split(":"))
    return hours * 60 + minutes


def test_lessons_never_run_past_the_end_of_their_day() -> None:
    """A lesson must finish on the day it starts.

    `start` used to range over one contiguous [0, horizon - duration] band
    covering the whole week, so a 60-minute lesson could begin three slots
    before 18:00. `_extract_lessons` then reported "17:30-18:30" — past the
    configured day end — while the model had reserved the teacher, group and
    room for the *next* morning's opening slots.
    """
    from ortools.sat.python import cp_model

    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    settings = _settings(SOLVER_MAX_TIME_SECONDS=5.0)
    solver = SchedulerSolver(settings)
    request = OptimizeScheduleRequest.model_validate(_sample_payload())

    # The domain itself must exclude straddling starts, so no search decision
    # can produce one. `domain` is a flat [lo, hi, lo, hi, …] bound list.
    model = cp_model.CpModel()
    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms),
    )
    slots_per_day = solver._grid.slots_per_day
    for decision in decisions:
        # Read the domain off the MODEL proto. IntVar.Proto() segfaults the
        # interpreter in ortools 9.15 rather than raising.
        bounds = list(model.Proto().variables[decision.start.Index()].domain)
        # Check EVERY admissible value, not just the interval endpoints: the old
        # contiguous domain [0, 196] has valid endpoints (0 and 196 both leave
        # room) while containing 37, 38, 39, 77, … which do not.
        admissible = [
            value
            for lo, hi in zip(bounds[::2], bounds[1::2])
            for value in range(lo, hi + 1)
        ]
        assert admissible, "start variable has an empty domain"
        for value in admissible:
            assert value % slots_per_day + decision.duration <= slots_per_day, (
                f"start {value} leaves only "
                f"{slots_per_day - value % slots_per_day} slots before the day ends, "
                f"but the lesson needs {decision.duration}"
            )

    response = solver.solve(request)
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    day_end = settings.schedule_day_end_minutes
    for lesson in response.lessons:
        assert _minutes(lesson.end_time) <= day_end, (
            f"lesson ends {lesson.end_time}, past the {day_end}-minute day end"
        )
        assert _minutes(lesson.start_time) < _minutes(lesson.end_time), (
            "a lesson that wraps a day boundary decodes to a non-increasing span"
        )


def test_every_group_keeps_a_free_lunch_window() -> None:
    """The lunch rule survives its re-encoding as a movable interval.

    The interval formulation replaced an existential over candidate lunch
    starts. This asserts the guarantee at the response level rather than
    trusting the model: for each group and day, some contiguous window of
    `lunchMinutes` inside the lunch window must be free of that group's lessons.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    settings = _settings(SOLVER_MAX_TIME_SECONDS=10.0)

    # A 10-hour day fits exactly ten 60-minute lessons, so 50 lessons across a
    # 5-day week saturates the week to the minute. Demanding a 30-minute break
    # as well cannot fit — which makes the rule strictly binding, so a test that
    # passes with the rule removed is proving nothing.
    # lessonsPerWeek is schema-capped at 40, so the 50 lessons are split across
    # two requirements that share the group and the teacher — they still cannot
    # overlap each other.
    def _payload(total: int, with_lunch: bool) -> dict[str, object]:
        payload = _sample_payload()
        first = payload["requirements"][0]  # type: ignore[index]
        second = {
            **first,  # type: ignore[dict-item]
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
        }
        first["lessonsPerWeek"] = total // 2  # type: ignore[index]
        second["lessonsPerWeek"] = total - total // 2
        payload["requirements"] = [first, second]
        if with_lunch:
            payload["rules"] = {
                "lunchStartTime": "11:00:00",
                "lunchEndTime": "13:00:00",
                "lunchMinutes": 30,
            }
        return payload

    solver = SchedulerSolver(settings)
    packed = solver.solve(OptimizeScheduleRequest.model_validate(_payload(50, False)))
    assert packed.status in {"OPTIMAL", "FEASIBLE"}
    assert len(packed.lessons) == 50, "the week should hold exactly 50 lessons"

    constrained = solver.solve(OptimizeScheduleRequest.model_validate(_payload(50, True)))
    assert constrained.status == "INFEASIBLE", (
        "50 lessons plus a daily lunch break cannot fit a 5-day, 10-hour week; "
        "reporting anything else means the lunch rule is not being enforced"
    )

    # And in the feasible direction: with room to breathe, every day the group
    # is taught must still leave a contiguous free window inside 11:00-13:00.
    roomy = _payload(40, True)
    relaxed = solver.solve(OptimizeScheduleRequest.model_validate(roomy))
    assert relaxed.status in {"OPTIMAL", "FEASIBLE"}
    assert len(relaxed.lessons) == 40

    grid = solver._grid
    window_start = grid.parse_hhmmss("11:00:00")
    window_end = grid.parse_hhmmss("13:00:00")
    need = grid.minutes_to_slots(30)
    duration = grid.minutes_to_slots(60)

    by_day: dict[int, list[tuple[int, int]]] = {}
    for lesson in relaxed.lessons:
        start_slot = grid.parse_hhmmss(lesson.start_time)
        by_day.setdefault(lesson.day_of_week, []).append(
            (start_slot, start_slot + duration),
        )

    for day, spans in by_day.items():
        assert any(
            all(cand + need <= s or cand >= e for s, e in spans)
            for cand in range(window_start, window_end - need + 1)
        ), f"day {day} has no free 30-minute window inside 11:00-13:00"


def test_a_feasible_solve_leaves_the_assumptions_field_empty() -> None:
    """The fast path must not populate CpModel.assumptions.

    CP-SAT refuses to run multi-threaded while that field is non-empty
    ("Forcing sequential search as assumptions are not supported in
    multi-thread"), which on a real payload is the difference between a
    schedule and a timeout. Conflict analysis rebuilds with assumptions on the
    INFEASIBLE path instead — see the neighbouring conflict tests.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=5.0))
    request = OptimizeScheduleRequest.model_validate(_sample_payload())

    fast, _, _, _ = solver._build_model(request, use_assumptions=False)
    assert list(fast.Proto().assumptions) == []

    explained, registry, _, _ = solver._build_model(request, use_assumptions=True)
    assert len(explained.Proto().assumptions) > 0


def _two_room_payload(lessons_per_week: int = 4) -> dict[str, object]:
    """One group, one teacher, two interchangeable rooms."""
    payload = _sample_payload()
    payload["requirements"][0]["lessonsPerWeek"] = lessons_per_week  # type: ignore[index]
    payload["rooms"] = [
        {"id": str(uuid4()), "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
    ]
    return payload


def _contended_two_room_payload() -> dict[str, object]:
    """Two rooms, and two requirements that can run at the same time.

    Contention is the point. With slack, the post-pass happens to reproduce
    whatever room_index the solver chose, so a test built on a quiet payload
    passes even when room pinning is removed entirely.
    """
    payload = _two_room_payload()
    first = payload["requirements"][0]  # type: ignore[index]
    first["lessonsPerWeek"] = 20
    second = {
        **first,  # type: ignore[dict-item]
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "teacherId": str(uuid4()),
        "studentGroupId": str(uuid4()),
        "lessonsPerWeek": 20,
    }
    payload["requirements"] = [first, second]
    return payload


def test_no_two_lessons_share_a_room_at_the_same_time() -> None:
    """The class encoding never names a room, so the post-pass must not collide.

    Room capacity is enforced by one cumulative per interchangeability class;
    concrete rooms come from a sweep afterwards. If that sweep were wrong the
    solver would still report OPTIMAL while emitting a double-booked timetable —
    which is worse than no timetable, so it is asserted directly.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    # Two teachers and two groups so lessons CAN run concurrently, which is what
    # forces the sweep to hand out distinct rooms.
    payload = _two_room_payload()
    first = payload["requirements"][0]  # type: ignore[index]
    second = {
        **first,  # type: ignore[dict-item]
        "id": str(uuid4()),
        "teacherId": str(uuid4()),
        "studentGroupId": str(uuid4()),
        "subjectId": str(uuid4()),
        "lessonsPerWeek": 40,
    }
    first["lessonsPerWeek"] = 40  # type: ignore[index]
    payload["requirements"] = [first, second]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 80

    grid = solver._grid
    occupied: dict[tuple, str] = {}
    for lesson in response.lessons:
        day = grid.day_index(lesson.day_of_week)
        start = grid.parse_hhmmss(lesson.start_time)
        for slot in range(start, start + grid.minutes_to_slots(60)):
            marker = (lesson.room_id, day, slot)
            assert marker not in occupied, (
                f"room {lesson.room_id} double-booked on day {day} slot {slot}"
            )
            occupied[marker] = str(lesson.requirement_id)


def test_a_room_scoped_unavailability_is_honoured() -> None:
    """A ROOM-scoped constraint reifies room_index, which the class encoding
    only keeps truthful for rooms passed as distinguished. If that wiring were
    missed, the solver would satisfy the constraint against a room_index the
    post-pass then overrides — and the emitted schedule would use the room
    anyway.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _contended_two_room_payload()
    blocked_room = payload["rooms"][0]["id"]  # type: ignore[index]
    payload["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "ROOM",
            "resourceId": blocked_room,
            "dayOfWeek": day,
            "date": None,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
            "kind": "UNAVAILABLE",
        }
        for day in (1, 2, 3, 4, 5)
    ]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 40
    for lesson in response.lessons:
        assert str(lesson.room_id) != blocked_room, (
            "a lesson was placed in a room that is unavailable all week"
        )


def test_a_fixed_lesson_blocks_its_own_room() -> None:
    """A room-bearing fixed lesson must keep generated lessons out of that room."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _contended_two_room_payload()
    held_room = payload["rooms"][0]["id"]  # type: ignore[index]
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "roomId": held_room,
            "dayOfWeek": day,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
        }
        for day in (1, 2, 3, 4, 5)
    ]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 40
    for lesson in response.lessons:
        assert str(lesson.room_id) != held_room, (
            "a lesson was placed in a room a fixed lesson occupies all week"
        )


def test_specialist_room_requirements_are_respected() -> None:
    """Eligibility must survive the partition into interchangeability classes."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _sample_payload()
    lab_id = str(uuid4())
    payload["rooms"] = [
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
        {"id": lab_id, "capacity": 30, "type": "LABORATORY"},
    ]
    payload["requirements"][0]["requiredRoomType"] = "LABORATORY"  # type: ignore[index]
    payload["requirements"][0]["lessonsPerWeek"] = 5  # type: ignore[index]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 5
    for lesson in response.lessons:
        assert str(lesson.room_id) == lab_id, "a LABORATORY lesson landed elsewhere"


def test_room_classes_merge_only_truly_interchangeable_rooms() -> None:
    """Rooms differing in eligibility for ANY requirement must not be merged."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.room_allocator import build_room_classes
    from app.solver.scheduler_solver import SchedulerSolver
    from ortools.sat.python import cp_model

    payload = _sample_payload()
    payload["rooms"] = [
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
        {"id": str(uuid4()), "capacity": 30, "type": "LABORATORY"},
        {"id": str(uuid4()), "capacity": 10, "type": "CLASSROOM"},  # too small
    ]
    # Without a requirement that ASKS for a laboratory, the lab is genuinely
    # interchangeable with a classroom — eligibility is what defines a class,
    # not the room's label. Add one so the partition has something to separate.
    lab_requirement = {
        **payload["requirements"][0],  # type: ignore[dict-item]
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "requiredRoomType": "LABORATORY",
    }
    payload["requirements"] = [payload["requirements"][0], lab_requirement]  # type: ignore[index]

    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings())
    decisions = solver._create_lesson_decisions(
        cp_model.CpModel(), request.requirements, len(request.rooms),
    )

    classes = build_room_classes(decisions, request.rooms, set(), solver._room_allowed)
    sizes = sorted(len(c.room_indices) for c in classes)
    # {room 0, room 1} interchangeable; the lab and the undersized room differ.
    assert sizes == [1, 1, 2], f"unexpected partition {sizes}"

    pinned = build_room_classes(
        decisions, request.rooms, {request.rooms[0].id}, solver._room_allowed,
    )
    assert sorted(len(c.room_indices) for c in pinned) == [1, 1, 1, 1], (
        "a distinguished room must become its own singleton class"
    )


def test_phase2_failure_returns_the_phase1_schedule_not_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A solver holding a valid timetable must never answer "nothing".

    solve() runs two phases: feasibility (no objective), then optimisation
    from a hint. If the optimising phase exhausts its budget without a
    solution, the feasibility schedule is the answer — reported as FEASIBLE,
    never as phase 1's raw status: a satisfaction solve calls any solution
    OPTIMAL, which would misstate an objective it never evaluated.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver import scheduler_solver as solver_module
    from app.solver.scheduler_solver import SchedulerSolver

    real_solve = solver_module.cp_model.CpSolver.Solve
    calls = {"count": 0}

    def flaky_solve(self, model, solution_callback=None):  # noqa: ANN001, ANN202
        calls["count"] += 1
        if calls["count"] == 2:  # the optimising phase
            return solver_module.cp_model.UNKNOWN
        return real_solve(self, model)

    monkeypatch.setattr(solver_module.cp_model.CpSolver, "Solve", flaky_solve)

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(_sample_payload()))

    assert calls["count"] == 2, "expected a feasibility solve then an optimising solve"
    assert response.status == "FEASIBLE"
    assert len(response.lessons) == 2, "the phase-1 schedule must be returned intact"
    for lesson in response.lessons:
        assert lesson.room_id is not None


def test_clone_satisfaction_rescues_a_failed_clean_phase(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Phase 1 is a portfolio of two encodings, and the second must be real.

    The objective-free build wins at small sizes but stops converging entirely
    around 1,000 students, where the cleared-clone encoding solves in ~82s —
    measured, reproducible, and counterintuitive enough that someone will one
    day be tempted to delete the "redundant" second encoding. This pins the
    escalation: when the clean satisfaction solve comes back empty, the clone
    must still produce a schedule.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver import scheduler_solver as solver_module
    from app.solver.scheduler_solver import SchedulerSolver

    real_solve = solver_module.cp_model.CpSolver.Solve
    calls = {"count": 0}

    def flaky_solve(self, model, solution_callback=None):  # noqa: ANN001, ANN202
        calls["count"] += 1
        if calls["count"] == 1:  # the clean satisfaction build finds nothing
            return solver_module.cp_model.UNKNOWN
        return real_solve(self, model)

    monkeypatch.setattr(solver_module.cp_model.CpSolver, "Solve", flaky_solve)

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(_sample_payload()))

    assert calls["count"] >= 2, "the clone encoding was never tried"
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 2, "the clone-phase schedule must be delivered"
    for lesson in response.lessons:
        assert lesson.room_id is not None


def test_complexity_guard_tracks_the_model_not_the_old_formula() -> None:
    """The guard must estimate what the current encoding builds.

    Two payloads, one on each side of the line.

    The first has 450 recurring constraints on teachers who appear nowhere in
    the requirements. The retired formula charged lessons x constraints x days
    for them — 2.25M against its 2M budget, a rejection — although constraints
    that touch no lesson add literally nothing to the model.

    The second is genuinely pathological: 1,000 rooms with 500 distinct
    capacities. Every capacity tier is its own interchangeability class, so
    the room allocator would emit a class literal per (lesson, class) —
    millions of variables the build phase would sit in before any timeout
    could engage. That is precisely what the guard exists to stop.
    """
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())

    harmless = _sample_payload()
    harmless["requirements"] = [
        {
            **harmless["requirements"][0],  # type: ignore[dict-item]
            "id": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 40,
        }
        for _ in range(25)
    ]
    harmless["rooms"] = [{"id": str(uuid4()), "capacity": 30} for _ in range(25)]
    harmless["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "TEACHER",
            "resourceId": str(uuid4()),  # a teacher with no lessons
            "dayOfWeek": (i % 5) + 1,
            "date": None,
            "startTime": "13:00:00",
            "endTime": "16:00:00",
            "kind": "UNAVAILABLE",
        }
        for i in range(450)
    ]
    request = OptimizeScheduleRequest.model_validate(harmless)
    old_formula = sum(r.lessons_per_week for r in request.requirements) * (
        len(request.rooms) + len(request.constraints) * 5
    )
    assert old_formula > 2_000_000, "the fixture no longer exercises the old rejection"
    solver._validate_request(request)  # must not raise

    pathological = _sample_payload()
    pathological["requirements"] = [
        {
            **pathological["requirements"][0],  # type: ignore[dict-item]
            "id": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 40,
        }
        for _ in range(100)
    ]
    pathological["rooms"] = [
        {"id": str(uuid4()), "capacity": 41 + i // 2} for i in range(1000)
    ]
    with pytest.raises(InvalidScheduleInputError, match="too large to build"):
        solver._validate_request(OptimizeScheduleRequest.model_validate(pathological))
