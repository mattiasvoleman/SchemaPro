import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("API_KEY", "test-api-key-000000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://testserver")
os.environ.setdefault("SCHEDULE_DAYS", "1,2,3,4,5")

from app.config import Settings, get_settings
from app.main import create_app  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    get_settings.cache_clear()
    settings = Settings(
        API_KEY="test-api-key-000000000000000000000000",
        ALLOWED_ORIGINS="http://testserver",
        SCHEDULE_DAYS="1,2,3,4,5",
    )
    return TestClient(create_app(settings))


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
    get_settings.cache_clear()
    settings = Settings(
        API_KEY="test-api-key-000000000000000000000000",
        ALLOWED_ORIGINS="http://testserver",
        SCHEDULE_DAYS="1,2,3,4,5",
        RATE_LIMIT_PER_MINUTE=3,
    )
    limited_client = TestClient(create_app(settings))
    # Health is exempt; hit an authed route repeatedly to trip the limiter.
    headers = {"X-API-Key": "test-api-key-000000000000000000000000"}
    statuses = [
        limited_client.post("/api/v1/optimize", json=_sample_payload(), headers=headers).status_code
        for _ in range(5)
    ]
    assert 429 in statuses


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


def test_tiny_time_budget_never_reports_a_satisfiable_model_as_infeasible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end guard on a real solve with a 1 ms budget.

    The payload is satisfiable by construction, so INFEASIBLE is always a lie
    here no matter how fast the machine is — and conflicts may only ever
    accompany a proof. Before the fix this returned INFEASIBLE plus a conflict
    analysis read off an unfinished search.

    The budget is set through the environment because the request handler
    resolves its Settings via the cached get_settings() dependency, not from
    the Settings instance handed to create_app().
    """
    monkeypatch.setenv("SOLVER_MAX_TIME_SECONDS", "0.001")
    get_settings.cache_clear()
    try:
        settings = Settings(
            API_KEY="test-api-key-000000000000000000000000",
            ALLOWED_ORIGINS="http://testserver",
            SCHEDULE_DAYS="1,2,3,4,5",
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
    finally:
        get_settings.cache_clear()
