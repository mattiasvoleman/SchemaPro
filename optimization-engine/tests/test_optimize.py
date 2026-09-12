from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model
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


def test_startup_says_which_grid_is_in_force(caplog) -> None:  # type: ignore[no-untyped-def]
    """The grid comes from the environment, so the code is not evidence of it.

    A deployment left on an old SLOT_MINUTES refuses every 40- and 50-minute
    lesson, and the only thing that said so was the rejection itself — one
    generation attempt after startup, and one service away from the variable.
    Working out which value was in force took reading the image, the compose
    file and the repository. The first line of the log should answer it.
    """
    import json
    import logging

    from fastapi.testclient import TestClient as _TestClient

    from app.main import create_app

    # The app renders JSON through structlog and hands it to stdlib logging, so
    # the whole event is the RECORD'S MESSAGE, not a set of attributes on it.
    # Two earlier attempts here looked in the wrong place — structlog's own
    # capture (replaced when `configure_logging` runs inside the lifespan) and
    # captured stdout — and both found nothing while the line was being emitted
    # perfectly well.
    with caplog.at_level(logging.INFO):
        with _TestClient(create_app(_settings(SLOT_MINUTES=15))):
            pass

    lines = []
    for record in caplog.records:
        message = record.getMessage()
        if message.startswith("{"):
            lines.append(json.loads(message))
    starting = [entry for entry in lines if entry.get("event") == "service_starting"]
    assert starting, "startup must log service_starting"
    assert starting[0]["slot_minutes"] == 15
    # The window too, for the same reason: both decide which lessons are
    # possible and both come from the environment.
    assert starting[0]["schedule_day"] == "08:00-18:00"


def test_a_misaligned_lesson_length_is_input_not_a_crash(client: TestClient) -> None:
    """A duration off the grid must answer, not explode.

    A duration between slots is impossible, and the engine says so with a bare
    ValueError from `minutes_to_slots`.
    `TimeGrid.minutes_to_slots` says so with a bare ValueError, and nothing
    between it and uvicorn caught one — so the caller got a 500 and a stack
    trace, while the very next check in the same loop reports a too-long lesson
    as a clean 4xx. The whole point of `_validate_request` is that bad input has
    an answer.
    """
    payload = _sample_payload()
    # 37, not 40: the grid is five minutes now and 40 is legal on it — that is
    # the whole reason it moved. What is still impossible is a length between
    # slots.
    payload["requirements"][0]["minutesPerLesson"] = 37  # type: ignore[index]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code < 500
    body = response.text
    # The answer has to name the number that is wrong and the number that is
    # allowed; "invalid request" would send an administrator back to the grid
    # they cannot see.
    assert "37" in body
    assert "grid" in body.lower() or "rutn" in body.lower()


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

    The analysis this returns changed once `AssumptionRegistry.resolve` began
    reading the conflict core as literal references. It used to resolve two
    records by list position — a reading that happened to land on availability
    records here and told the truth by coincidence. Now the five blocking
    reservations are named individually, by the ids the payload sent, which is
    the whole point of registering an assumption per constraint. That is worth
    asserting rather than counting: the school's next move is to open one of
    those five rows, and it can only do that if the id reaches the response.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    # Block the group across the whole grid. 17:45 is the last representable
    # time (the 18:00 day end is exclusive), leaving only a 15-minute tail —
    # too short for the 60-minute lesson, so no placement exists.
    blocked_days = [
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
    payload["constraints"] = blocked_days

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
    conflicts = body["conflicts"]["conflicts"]
    assert conflicts, "infeasible responses must explain why"

    blamed = {
        constraint_id
        for conflict in conflicts
        if conflict["category"] == "AVAILABILITY"
        for constraint_id in conflict["constraintIds"]
    }
    assert blamed == {constraint["id"] for constraint in blocked_days}, (
        "every reservation that helped make the week impossible has to be "
        "nameable, or the admin has nothing to open"
    )
    # The summary points at the rows rather than listing their categories:
    # the page shows each as a translated badge, and a list built in the
    # engine could only ever be an English one.
    assert body["conflicts"]["summaryCode"] == "CONFLICT_CORE_SUMMARY"
    assert "AVAILABILITY" in {c["category"] for c in conflicts}


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
    """Each group keeps a free 45-min window inside 11:00-13:00 every day.

    The payload has to NAME the class that eats. `groups` is who gets a break
    — a teaching group's pupils eat with their class, so the engine owes a
    meal to nobody it was not told about — and this test ran for a while
    without one: no lunch interval was built at all, and it passed on the days
    the solver happened to leave a gap and failed on the days it did not. A
    flaky test over a rule that was never in force.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 10  # type: ignore[index]
    payload["groups"] = [
        {"id": requirement["studentGroupId"], "lunchHeadcount": 24},  # type: ignore[index]
    ]
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

    # THE MEAL ITSELF, not a gap that happens to be there. The old assertion
    # looked for any free 45 minutes among the LESSONS, which a loose week
    # leaves by luck whether or not the engine promised one — it passed with
    # the whole lunch mechanism switched off. What the engine undertakes is to
    # place a break and return it, so that is what is read.
    group_id = requirement["studentGroupId"]  # type: ignore[index]
    lunches = [lunch for lunch in body["lunches"] if lunch["studentGroupId"] == group_id]
    assert len(lunches) == 5, f"one meal per school day, got {lunches}"
    for lunch in lunches:
        start, end = minutes(lunch["startTime"]), minutes(lunch["endTime"])
        assert end - start == 45
        assert 11 * 60 <= start and end <= 13 * 60, lunch

    # And no lesson of the class runs through its own meal.
    by_day: dict[int, list[tuple[int, int]]] = {}
    for lesson in body["lessons"]:
        by_day.setdefault(lesson["dayOfWeek"], []).append(
            (minutes(lesson["startTime"]), minutes(lesson["endTime"]))
        )
    for lunch in lunches:
        start, end = minutes(lunch["startTime"]), minutes(lunch["endTime"])
        for lesson_start, lesson_end in by_day.get(lunch["dayOfWeek"], []):
            assert lesson_end <= start or lesson_start >= end, (
                f"a lesson runs through the meal on day {lunch['dayOfWeek']}"
            )


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
    """A proof happened, so the school gets an explanation — a NAMED one.

    This used to come back as the INSUFFICIENT_RESOURCES fallback ("no minimal
    conflict core was returned"), because `AssumptionRegistry.resolve` read the
    core as offsets into its own record list and every real literal reference
    fell outside it. Nothing about the payload changed; the core was always
    there and always said room capacity. Asserting the category rather than
    "at least one conflict" is the difference between a test that noticed and
    a test that did not.

    The count IS pinned, and pinning it is the second thing this test does.
    `_add_capacity_constraints` registers one literal per lesson INSTANCE, so
    all forty of this requirement's lessons answered with the same sentence and
    an administrator opened the response to forty identical lines. One cause is
    one line: records agreeing on category and message are the same statement
    about the same thing, and forty copies of it bury whatever else the core
    found.

    The summary is quoted in full because every word of it is a claim about
    what CP-SAT proved. SufficientAssumptionsForInfeasibility returns a
    sufficient set, not a minimal one, so "these caused it" would state as fact
    something nothing established — and a school acts on this sentence.
    """
    payload = _oversubscribed_payload()
    requirement_id = payload["requirements"][0]["id"]  # type: ignore[index]
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "INFEASIBLE"
    assert body["lessons"] == []
    assert body["conflicts"] is not None
    conflicts = body["conflicts"]["conflicts"]
    assert {conflict["category"] for conflict in conflicts} == {"ROOM_CAPACITY"}, (
        "the core names room capacity; falling back on INSUFFICIENT_RESOURCES "
        "sends the school to look at teacher hours as well, for no reason"
    )
    assert len(conflicts) == 1, (
        f"one requirement, one cause, one line — {len(conflicts)} came back, "
        f"which is one per lesson instance the capacity builder registered"
    )
    # Folded together, not thinned out. The forty records all name this one
    # requirement, and the surviving line still has to name it: an admin whose
    # response lost the id has been told a room is too small and not which
    # lesson wanted it.
    assert conflicts[0]["requirementIds"] == [requirement_id]
    # The summary points at the rows rather than listing their categories in
    # English; the page shows each as its own translated badge.
    assert body["conflicts"]["summaryCode"] == "CONFLICT_CORE_SUMMARY"
    assert body["conflicts"]["summary"] == (
        "No timetable satisfies every rule. Start with the causes listed below: "
        "together they are enough to make the week impossible, but the solver "
        "reports a sufficient set rather than the smallest one, so some of "
        "them may carry no blame."
    )


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

    Running out of budget is a VERDICT, not a transport failure: the request
    was answered, so it is a 200 carrying "TIMEOUT" and no lessons. A second
    copy of this test used to sit further up the file under the same name —
    shadowed, therefore never run — asserting a 503 with code SOLVER_TIMEOUT.
    Nothing raises SolverTimeoutError anywhere in the engine, so that copy
    described a behaviour that does not exist and would have failed the moment
    it was collected. Its one honest claim, that the caller is not handed an
    error, is folded into the status-code assertion here.
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
    # The two claims the response can make about infeasibility, and there are
    # only two: `status` and `conflicts` are the whole of what
    # OptimizeScheduleResponse carries besides the lessons. A third assertion
    # searching the serialised body for the word added nothing — it could only
    # fail where one of these two already had.
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
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts,
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
            # The gateway names who eats. A group is owed a meal because it is
            # listed here, not because it has lessons — a teaching group has
            # lessons and eats with its class.
            payload["groups"] = [{"id": first["studentGroupId"], "lunchHeadcount": 24}]
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


# ---------------------------------------------------------------------------
# The dining hall
#
# The lunch rule above guarantees every group a free window; on its own it is
# perfectly happy to send the whole school in at 11:30. Seats are what make the
# solver spread lunch out, and they are the one lunch preference a school
# cannot express as a time.
# ---------------------------------------------------------------------------


def _dining_payload(headcounts: list[int], lessons_per_week: int = 1) -> dict[str, object]:
    """One 30-student class per headcount, each with its own teacher and room.

    Nothing in a payload built this way is scarce except seats — every group
    has a teacher and a room to itself and the week is nearly empty — so one
    that fails to schedule fails because of the hall.

    `lunchHeadcount` is how many children eat *as* this group. It rides on the
    `groups` list rather than on the requirement, and is deliberately
    independent of `studentGroupSize`: a teaching group is thirty students
    large and nought students hungry, because those thirty already have seats
    with their home classes.
    """
    payload = _sample_payload()
    template = payload["requirements"][0]  # type: ignore[index]
    group_ids = [str(uuid4()) for _ in headcounts]
    payload["requirements"] = [
        {
            **template,  # type: ignore[dict-item]
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": group_id,
            "lessonsPerWeek": lessons_per_week,
            "studentGroupSize": 30,
        }
        for group_id in group_ids
    ]
    payload["groups"] = [
        {"id": group_id, "lunchHeadcount": headcount}
        for group_id, headcount in zip(group_ids, headcounts)
    ]
    payload["rooms"] = [{"id": str(uuid4()), "capacity": 30} for _ in headcounts]
    return payload


def _lunch_rules(**overrides: object) -> dict[str, object]:
    """11:00-12:00 with a 60-minute break: one sitting wide, and no wider.

    The lunch start then has a single admissible value, so every group in the
    model sits down at 11:00 and the seat count alone decides whether they fit.
    Widening `lunchEndTime` to 13:00 buys a second sitting — which is how a
    test asks whether staggering is *possible* rather than whether it is
    needed.
    """
    return {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:00:00",
        "lunchMinutes": 60,
        **overrides,
    }


def test_a_dining_hall_smaller_than_the_school_forces_lunch_to_be_staggered() -> None:
    """The seat limit binds, and a school can pay for it in seats or in time.

    Two classes of 30 on a Monday-only week. The window is one sitting wide, so
    both sit down at 11:00 whatever the timetable does, and 30 seats do not
    hold 60 children: INFEASIBLE. The same week schedules again either with 60
    seats or — the entire point of the rule — with the same 30 seats and a
    window two sittings wide, which is the only currency a school that already
    owns its hall has left to spend.

    The chosen sitting time never reaches the response (`ScheduledLesson` has
    no field for it), so the proof has to be the verdict rather than two times
    read back off the timetable.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))

    def _solve(seats: int, lunch_end: str):  # noqa: ANN202
        payload = _dining_payload([30, 30])
        payload["rules"] = _lunch_rules(diningSeats=seats, lunchEndTime=lunch_end)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    crowded = _solve(30, "12:00:00")
    assert crowded.status == "INFEASIBLE", (
        "sixty children cannot sit down at once in a thirty-seat hall; "
        "reporting anything else means the seat limit is not enforced"
    )

    bigger_hall = _solve(60, "12:00:00")
    assert bigger_hall.status in {"OPTIMAL", "FEASIBLE"}
    assert len(bigger_hall.lessons) == 2

    longer_window = _solve(30, "13:00:00")
    assert longer_window.status in {"OPTIMAL", "FEASIBLE"}, (
        "two sittings put sixty children through a thirty-seat hall; refusing "
        "this means the hall is counted per week rather than per instant"
    )
    assert len(longer_window.lessons) == 2


def test_a_teaching_group_does_not_take_its_students_seats_a_second_time() -> None:
    """Ma71 is cut out of 7A, and at lunch they are the same thirty children.

    The gateway says so by sending the teaching group a lunchHeadcount of 0
    while its studentGroupSize stays 30 — it is still a class-sized group that
    needs a class-sized room. Read the size instead of the headcount and a
    thirty-seat hall is asked for sixty places, and a week that is genuinely
    fine collapses.

    The twin below is the same payload with Ma71 turned into a second home
    class of its own thirty children, and that one MUST collapse. Without it
    this test would pass just as happily against a solver that had forgotten
    about seats altogether.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))

    def _solve(ma71_headcount: int):  # noqa: ANN202
        payload = _dining_payload([30, ma71_headcount])
        class_7a = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
        group_ma71 = payload["requirements"][1]["studentGroupId"]  # type: ignore[index]
        payload["groupConflicts"] = [[class_7a, group_ma71]]
        payload["rules"] = _lunch_rules(diningSeats=30)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    shared_students = _solve(0)
    assert shared_students.status in {"OPTIMAL", "FEASIBLE"}, (
        "7A's thirty students were seated twice, once as 7A and once as Ma71"
    )
    assert len(shared_students.lessons) == 2

    two_home_classes = _solve(30)
    assert two_home_classes.status == "INFEASIBLE", (
        "sixty distinct children still do not fit thirty seats; if this "
        "schedules, the case above is proving nothing"
    )


def test_a_teaching_group_cut_from_two_classes_does_not_multiply_the_hall() -> None:
    """A day's demand is exactly the size of the school. Not more, not less.

    Ma71 is drawn from 7A and 7B, so it shares students with both. The rule is
    that every home class eats every school day and a teaching group eats
    nothing, which makes the hall's load on any day 30 + 30 = 60 — the number
    of children the school actually has.

    Both bounds are asserted, and they are what makes the number exact rather
    than merely safe. Sixty seats fit, so nothing may inflate the count: the
    encoding that read `studentGroupSize` instead of `lunchHeadcount` asked for
    ninety, and the one that booked every class sharing students with a
    teaching group the moment that group met asked for more again, growing with
    the number of classes the nivågrupp was cut from. Fifty-nine do not fit, so
    nothing may deflate it either: a version that let a class slip out of the
    count would schedule this week happily.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))

    def _solve(seats: int):  # noqa: ANN202
        payload = _dining_payload([30, 30, 0])
        class_7a = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
        class_7b = payload["requirements"][1]["studentGroupId"]  # type: ignore[index]
        group_ma71 = payload["requirements"][2]["studentGroupId"]  # type: ignore[index]
        payload["groupConflicts"] = [
            [class_7a, group_ma71],
            [class_7b, group_ma71],
        ]
        # One sitting wide, so the whole school is in the hall at once and the
        # seat count is the only thing being asked about.
        payload["rules"] = _lunch_rules(diningSeats=seats)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    exactly_enough = _solve(60)
    assert exactly_enough.status in {"OPTIMAL", "FEASIBLE"}, (
        "sixty children were charged for more than sixty seats — the "
        "nivågrupp was counted, or the classes it draws from were counted "
        "once each per lesson of it"
    )
    assert len(exactly_enough.lessons) == 3

    one_short = _solve(59)
    assert one_short.status == "INFEASIBLE", (
        "fifty-nine seats held sixty children, so somebody was not counted "
        "and the test above is proving nothing"
    )


def _blocks_the_whole_day(group_id: str, day_of_week: int) -> dict[str, object]:
    """A reservation that leaves this group nowhere to be taught on that day.

    17:45 is the last representable time — the 18:00 day end is exclusive — so
    what survives is a 15-minute tail no 60-minute lesson fits into. Pinning a
    group's day this way is the only way to state "7A is not taught on Tuesday"
    in a payload, and STUDENT_GROUP reservations deliberately do not propagate
    across groupConflicts, so blocking 7A leaves Ma71 free.
    """
    return {
        "id": str(uuid4()),
        "resourceKind": "STUDENT_GROUP",
        "resourceId": group_id,
        "dayOfWeek": day_of_week,
        "date": None,
        "startTime": "08:00:00",
        "endTime": "17:45:00",
        "kind": "UNAVAILABLE",
    }


def test_a_class_with_a_completely_empty_day_still_books_seats_it_will_not_use() -> None:
    """The one inexactness left in the seat count, stated out loud.

    Every home class eats every school day. A class that is reserved out of
    Tuesday altogether is not in the building on Tuesday and will not eat, and
    the model books its thirty seats regardless. That is deliberate: the
    payload carries one headcount per group and nothing finer, so "is 7A here
    today" has no honest answer once a nivågrupp can bring half a class in on
    its own — and of the two ways to be wrong, holding chairs for children who
    stayed at home beats sending children to a room with no chairs in it. It is
    also the one sentence a school needs to hear: every class eats every school
    day.

    An accepted inexactness with no test is indistinguishable from a bug
    nobody has noticed yet, so it is pinned here rather than left to the
    docstrings. 7A is reserved out of Tuesday and so is taught on Monday; 8A
    has both days to choose from. Thirty seats hold neither day, because both
    classes book on both. Sixty seats and the same week schedules, which is
    what makes this a statement about the count rather than about the
    reservation.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1,2"))

    def _solve(seats: int):  # noqa: ANN202
        payload = _dining_payload([30, 30])
        class_7a = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
        payload["constraints"] = [_blocks_the_whole_day(class_7a, 2)]
        payload["rules"] = _lunch_rules(diningSeats=seats)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    roomy = _solve(60)
    assert roomy.status in {"OPTIMAL", "FEASIBLE"}, (
        "two classes fit a sixty-seat hall on either day; if they do not, the "
        "verdict below is about something other than seats"
    )
    assert len(roomy.lessons) == 2

    crowded = _solve(30)
    assert crowded.status == "INFEASIBLE", (
        "8A was given Tuesday on the grounds that 7A is reserved out of it — "
        "which is true, and which the seat count deliberately does not know"
    )


def test_a_class_in_school_only_through_a_teaching_group_still_books_its_seats() -> None:
    """7A's children eat on Tuesday if Tuesday is the day Ma71 is taught.

    A class whose own Tuesday column is empty is not thereby at home: the half
    of it that goes to the nivågrupp is in a classroom, and children in the
    building eat. That was the under-count that killed the presence encoding —
    asking only whether the group had a lesson of its own that day booked 7A
    nought seats on Tuesday, and a hall with room for one class seated two and
    reported OPTIMAL.

    Unconditional demand cannot under-count, and the fixture is kept in the
    shape that would catch it if it ever could. 7A is reserved out of Tuesday
    and Ma71 out of Monday, so 7A is taught on Monday, its children sit in Ma71
    on Tuesday, and both days are therefore days 7A eats. 8A is a second full
    class with one lesson and both days to put it on — and with thirty seats
    there is no day left for it, whichever it picks. A model that let 7A off
    Tuesday would hand 8A that day and call the week fine.

    Sixty seats and the same week schedules, which is what makes the hall the
    binding thing rather than the reservations.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1,2"))

    def _solve(seats: int):  # noqa: ANN202
        # Ma71 is a teaching group cut out of 7A: class-sized, but nought
        # hungry, because those thirty already have seats as 7A.
        payload = _dining_payload([30, 0, 30])
        class_7a = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
        group_ma71 = payload["requirements"][1]["studentGroupId"]  # type: ignore[index]
        payload["groupConflicts"] = [[class_7a, group_ma71]]
        payload["constraints"] = [
            _blocks_the_whole_day(class_7a, 2),
            _blocks_the_whole_day(group_ma71, 1),
        ]
        payload["rules"] = _lunch_rules(diningSeats=seats)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    roomy = _solve(60)
    assert roomy.status in {"OPTIMAL", "FEASIBLE"}, (
        "with room for two classes at a sitting this week is fine; if it is "
        "not, the verdict below is about something other than seats"
    )
    assert len(roomy.lessons) == 3

    crowded = _solve(30)
    assert crowded.status == "INFEASIBLE", (
        "8A was seated on a day 7A already fills, because 7A was counted as "
        "absent on the day its own children were sitting in Ma71"
    )


def _lunch_no_overlap_count(model) -> int:  # noqa: ANN001
    """How many NoOverlap sets the lunch rule built, and only those.

    A lunch interval belongs to no other builder, so "contains an interval
    named lunch_* or sitting_*" separates this rule's sets from the ones
    _add_group_no_overlap and the room allocator put in the same model.
    """
    proto = model.Proto()
    lunch = {
        index
        for index, constraint in enumerate(proto.constraints)
        if constraint.name.startswith(("lunch_", "sitting_"))
    }
    return sum(
        1
        for constraint in proto.constraints
        if constraint.has_no_overlap()
        and lunch.intersection(constraint.no_overlap.intervals)
    )


def test_a_shared_student_pair_the_timplan_never_heard_of_is_skipped() -> None:
    """groupConflicts is membership data, and membership is untidier than a week.

    It can name a group with no lessons at all — every one of them locked, or
    simply no timplan entry this year — and it can name the same pair twice,
    once from each side. Neither is a fact about the week, and the lunch rule
    reads the relation to decide whose lessons its breaks must dodge, so both
    have to fall away: the first is otherwise a KeyError and a 500 for a school
    whose data is merely old, and the second quietly builds every NoOverlap
    twice for as long as the relation stays messy.

    A third kind of noise — a group named as its own partner — is NOT exercised
    here, and deliberately so. The lunch builder drops it, but
    _add_group_no_overlap puts that group's lessons into one NoOverlap set
    twice over, which asks every lesson not to overlap itself and refuses the
    whole week. That is a live defect older than the dining hall and it is not
    this file's to hide behind a passing test.

    Counting the rule's own NoOverlap sets is what makes the second observable:
    three groups, one real pair between them, five sets whatever noise the
    relation carries — one per group for its own lessons, plus one on each side
    of the pair.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1,2"))

    def _build(noisy: bool):  # noqa: ANN202, FBT001
        payload = _dining_payload([30, 0, 30])
        class_7a = str(payload["requirements"][0]["studentGroupId"])  # type: ignore[index]
        group_ma71 = str(payload["requirements"][1]["studentGroupId"])  # type: ignore[index]
        pairs = [[class_7a, group_ma71]]
        if noisy:
            pairs += [
                [group_ma71, class_7a],  # the same pair, read from the other side
                [class_7a, str(uuid4())],  # a group with nothing on the timetable
            ]
        payload["groupConflicts"] = pairs
        # Two home classes of thirty, and a hall that holds both: this test is
        # about how many NoOverlap sets get built, so the seat count must not
        # be the thing that decides the verdict.
        payload["rules"] = _lunch_rules(diningSeats=60)
        request = OptimizeScheduleRequest.model_validate(payload)
        model, _, _, _, _ = solver._build_model(request, use_assumptions=False)
        return _lunch_no_overlap_count(model), solver.solve(request)

    clean_sets, clean = _build(noisy=False)
    noisy_sets, noisy = _build(noisy=True)

    assert clean_sets == 5, "three groups and one pair: 3 + 2 sets"
    assert noisy_sets == clean_sets, (
        f"the noise built {noisy_sets - clean_sets} NoOverlap sets of its own"
    )
    assert (noisy.status, len(noisy.lessons)) == (clean.status, len(clean.lessons))
    assert clean.status in {"OPTIMAL", "FEASIBLE"}


def _solved_spans(solver, request):  # noqa: ANN001, ANN202
    """Every lesson AND every sitting the model chose, as absolute slot spans.

    The response cannot answer this. `ScheduledLesson` is the only row
    `OptimizeScheduleResponse` carries and there is no field for a sitting, so
    the chosen lunch start exists nowhere outside the model — a known gap that
    also leaves `benchmarks/validate_schedule.py` unable to check the rule.
    Reading `lunchstart_<group>_<day>` off the solved proto is therefore the
    only way to assert WHEN a group eats rather than merely that a week did or
    did not schedule.

    Both halves come out of ONE solve, so the lessons and the sittings are the
    same timetable and can be compared to each other.
    """
    from ortools.sat.python import cp_model

    model, _registry, decisions, _plan, _lunch = solver._build_model(
        request, use_assumptions=False,
    )
    cp_solver = cp_model.CpSolver()
    cp_solver.parameters.max_time_in_seconds = 10.0
    status = cp_solver.Solve(model)
    assert status in {cp_model.OPTIMAL, cp_model.FEASIBLE}, cp_solver.StatusName(status)

    lessons: dict[str, list[tuple[int, int]]] = {}
    for decision in decisions:
        group_id = str(decision.lesson.requirement.student_group_id)
        start = cp_solver.Value(decision.start)
        lessons.setdefault(group_id, []).append((start, start + decision.duration))

    lunch_slots = solver._grid.minutes_to_slots(request.rules.lunch_minutes)
    solution = cp_solver.ResponseProto().solution
    sittings: dict[str, list[tuple[int, int]]] = {}
    for index, variable in enumerate(model.Proto().variables):
        if not variable.name.startswith("lunchstart_"):
            continue
        _prefix, group_id, _day_index = variable.name.split("_")
        start = solution[index]
        sittings.setdefault(group_id, []).append((start, start + lunch_slots))
    return lessons, sittings


def test_a_class_never_eats_while_its_own_children_sit_in_a_teaching_group() -> None:
    """7A cannot be at lunch during a Ma71 lesson — same thirty pupils.

    The lunch NoOverlap spanned the group's own lessons only, so the model was
    free to record a break for 7A at the exact hour its children were being
    taught mathematics. Nobody ate; the timetable said they had.

    Two halves, because neither is enough on its own.

    The tight day proves the rule BINDS. 11:00-13:15 holds nine slots, and 7A's
    lesson, Ma71's lesson and 7A's break are three hours that must now be
    disjoint: twelve slots do not fit into nine, so the week has no answer.
    Before the fix this scheduled, with 7A's sitting laid exactly over the Ma71
    lesson — the arrangement the rule exists to forbid.

    The roomy day proves the rule is HONEST. One hour longer and the arrangement
    that respects it exists, so the fix cannot be passing by refusing
    everything; and this is the half that states the rule outright, by reading
    the sitting back out of the model and checking it against both lessons.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    def _request(lunch_end: str):  # noqa: ANN202
        payload = _dining_payload([30, 0, 30])
        class_7a = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
        group_ma71 = payload["requirements"][1]["studentGroupId"]  # type: ignore[index]
        payload["groupConflicts"] = [[class_7a, group_ma71]]
        payload["rules"] = _lunch_rules(lunchEndTime=lunch_end, diningSeats=30)
        return (
            OptimizeScheduleRequest.model_validate(payload),
            str(class_7a),
            str(group_ma71),
        )

    def _solver(day_end_minutes: int):  # noqa: ANN202
        # A day that starts at 11:00 and ends where the test needs it to, so
        # the arithmetic above is the whole of what the week can hold.
        return SchedulerSolver(
            _settings(
                SCHEDULE_DAYS="1",
                SOLVER_MAX_TIME_SECONDS=10.0,
                SCHEDULE_DAY_START_MINUTES=660,
                SCHEDULE_DAY_END_MINUTES=day_end_minutes,
            ),
        )

    tight_request, _, _ = _request("13:00:00")
    tight = _solver(795).solve(tight_request)
    assert tight.status == "INFEASIBLE", (
        "three hours that must not overlap were fitted into a nine-slot day, "
        "which only works if 7A is allowed to eat during the Ma71 lesson"
    )

    roomy_solver = _solver(855)
    roomy_request, class_7a, group_ma71 = _request("14:00:00")
    lessons, sittings = _solved_spans(roomy_solver, roomy_request)

    (sitting_start, sitting_end) = sittings[class_7a][0]
    for owner in (class_7a, group_ma71):
        for lesson_start, lesson_end in lessons[owner]:
            assert not (sitting_start < lesson_end and lesson_start < sitting_end), (
                f"7A eats at slots {sitting_start}-{sitting_end} while a lesson "
                f"of {'its own' if owner == class_7a else 'Ma71'} runs at "
                f"{lesson_start}-{lesson_end}"
            )


def _locked_lesson(
    group_id: str,
    start_time: str,
    end_time: str,
    day_of_week: int = 1,
    extra_group_ids: list = None,  # noqa: RUF013
) -> dict[str, object]:
    """A hand-placed lesson: no teacher, no room, only a group and a window.

    Stripping it to the group is what keeps the tests below about lunch. A
    locked lesson with a teacher or a room blocks generated lessons through
    those as well, and a week that failed to schedule would no longer be
    evidence about anybody's break.
    """
    return {
        "id": str(uuid4()),
        "studentGroupId": group_id,
        "extraGroupIds": extra_group_ids or [],
        "dayOfWeek": day_of_week,
        "startTime": start_time,
        "endTime": end_time,
    }


def test_a_class_is_never_sent_to_lunch_on_top_of_a_locked_lesson() -> None:
    """A break laid over a lesson a human placed by hand is not a break.

    Locked lessons enter the model only as windows the GENERATED lessons steer
    around; they are never intervals, so nothing ever stopped the free-window
    guarantee from putting a class's lunch exactly where somebody had already
    put a lesson. Now that the same interval also books a seat, the model would
    have the class in the dining hall at an hour it is demonstrably in a
    classroom.

    The window here is one sitting wide, so the class has exactly one
    admissible lunch start and a locked lesson covering it leaves none. That is
    pure arithmetic on constants, so it is refused before the solver runs, with
    the group and the day named — an unexplained INFEASIBLE after the whole
    time budget would leave a school reading about rooms and teacher time for a
    problem that is neither.

    Four ways a locked lesson reaches a class, and three ways it does not. The
    reach is the rule _add_fixed_lesson_constraints already uses — the group
    the lesson names, the extra classes attending it, and any group sharing
    students with either — because a lesson that keeps a class out of a
    classroom keeps it out of the hall for the same reason. The controls are
    what stop this from passing against an implementation that simply refuses
    every week containing a locked lesson.
    """
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))
    ma71 = str(uuid4())
    class_7b = str(uuid4())
    stranger = str(uuid4())

    def _solve(arrange) -> str:  # noqa: ANN001
        payload = _dining_payload([30])
        class_7a = str(payload["requirements"][0]["studentGroupId"])  # type: ignore[index]
        fixed_lessons, conflicts = arrange(class_7a)
        payload["fixedLessons"] = fixed_lessons
        payload["groupConflicts"] = conflicts
        payload["rules"] = _lunch_rules(diningSeats=30)
        return solver.solve(OptimizeScheduleRequest.model_validate(payload)).status

    def _refusal(arrange) -> str:  # noqa: ANN001
        """The rejection message, so the reach can be read off the group it names."""
        with pytest.raises(InvalidScheduleInputError) as raised:
            _solve(arrange)
        return str(raised.value)

    lunch_hour = ("11:00:00", "12:00:00")

    assert "no 60-minute lunch break" in _refusal(
        lambda g: ([_locked_lesson(g, *lunch_hour)], []),
    ), "7A would have been sent to the hall during a lesson of its own"
    assert "on Monday" in _refusal(
        # 11:05-11:50 is inside the same slots once _fixed_window rounds it
        # outward, and locked lessons are hand-typed times that rarely land on
        # the grid.
        lambda g: ([_locked_lesson(g, "11:05:00", "11:50:00")], []),
    ), "the blocked window must be the rounded-out one"
    assert "no 60-minute lunch break" in _refusal(
        lambda g: ([_locked_lesson(class_7b, *lunch_hour, extra_group_ids=[g])], []),
    ), "a lesson two classes attend holds both of them, so it holds 7A"
    assert "no 60-minute lunch break" in _refusal(
        lambda g: ([_locked_lesson(ma71, *lunch_hour)], [[g, ma71]]),
    ), "the nivågrupp's locked lesson has 7A's own children in it"

    feasible = {"OPTIMAL", "FEASIBLE"}
    assert _solve(
        lambda g: ([_locked_lesson(stranger, *lunch_hour)], []),
    ) in feasible, (
        "a locked lesson for a class that shares nobody with 7A took 7A's "
        "lunch away — the reach rule is blocking everyone"
    )
    assert _solve(
        lambda g: ([_locked_lesson(g, "08:00:00", "09:00:00")], []),
    ) in feasible, "a locked lesson clear of the lunch window forbids no start"
    assert _solve(
        lambda g: ([_locked_lesson(g, *lunch_hour, day_of_week=6)], []),
    ) in feasible, (
        "a Saturday lesson on a Monday-only grid falls on no day a lunch falls "
        "on"
    )


def test_a_class_whose_week_is_entirely_hand_placed_still_books_its_seats() -> None:
    """Being at school has nothing to do with having lessons left to place.

    The gateway subtracts locked lessons from a requirement's weekly demand and
    drops the requirement when the remainder reaches zero, so a class whose week
    is entirely hand-placed arrives carrying only fixed lessons. While the
    headcount rode on the requirement, that class ate nothing and took no
    chairs — and the model was not merely ignorant of it, it was demonstrably
    aware, because those same locked lessons were pushing other groups' lunches
    around. Thirty children in the building, and the hall told about none.

    One 30-seat hall, one sitting, one class with a requirement and one present
    only as a locked lesson: sixty children, and the honest answer is that they
    do not fit.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))
    hand_placed = str(uuid4())

    payload = _dining_payload([30])
    payload["groups"] = [
        *payload["groups"],  # type: ignore[misc]
        {"id": hand_placed, "lunchHeadcount": 30},
    ]
    payload["fixedLessons"] = [
        _locked_lesson(hand_placed, "08:00:00", "09:00:00"),
    ]
    payload["rules"] = _lunch_rules(diningSeats=30)

    assert (
        solver.solve(OptimizeScheduleRequest.model_validate(payload)).status
        == "INFEASIBLE"
    ), "the hand-placed class ate nothing and its thirty chairs went unbooked"

    # The control: the same week with room for both classes schedules, so the
    # refusal above is the seat count and not the mere presence of a group that
    # owns no requirement.
    payload["rules"] = _lunch_rules(diningSeats=60)
    assert solver.solve(
        OptimizeScheduleRequest.model_validate(payload),
    ).status in {"OPTIMAL", "FEASIBLE"}


def test_a_lunch_blocked_by_locked_lessons_is_named_even_with_no_seat_limit() -> None:
    """The regression a school already using the lunch rule would have hit.

    Making the break steer around hand-placed lessons is right — before it, a
    class was quietly sent to lunch during a lesson somebody had put there. But
    the restriction was written bare, and a bare domain subtraction lets CP-SAT
    prove infeasibility without touching a single assumption. The core comes
    back empty, and an empty core does not merely lose this cause: it erases
    every other cause in the payload and hands the school the
    INSUFFICIENT_RESOURCES fallback, telling it to go and look at rooms and
    teacher time. One lock anywhere blinded the whole diagnosis — with no seat
    limit set at all, so on every school already using this rule.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    # A two-hour day, so the one admissible lunch start is also the only place
    # the lesson can go: impossible in combination, which is exactly the case
    # the up-front arithmetic cannot settle and the literal has to carry.
    solver = SchedulerSolver(
        _settings(
            SOLVER_MAX_TIME_SECONDS=10.0,
            SCHEDULE_DAYS="1",
            SCHEDULE_DAY_START_MINUTES=630,
            SCHEDULE_DAY_END_MINUTES=765,
        ),
    )
    payload = _dining_payload([30], lessons_per_week=1)
    group_id = str(payload["groups"][0]["id"])  # type: ignore[index]
    payload["fixedLessons"] = [_locked_lesson(group_id, "10:30:00", "11:30:00")]
    payload["rules"] = {
        "lunchStartTime": "10:30:00",
        "lunchEndTime": "12:30:00",
        "lunchMinutes": 30,
    }  # no diningSeats at all

    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    categories = {conflict.category for conflict in response.conflicts.conflicts}
    assert "INSUFFICIENT_RESOURCES" not in categories, (
        "the empty core swallowed the diagnosis and blamed rooms and teacher time"
    )
    assert any(
        "lunch break" in conflict.message for conflict in response.conflicts.conflicts
    ), "nothing in the answer says the lunch window is what cannot be satisfied"

    # And the literal must actually GATE the restriction, which the response
    # above cannot show: CP-SAT returns a sufficient core, not a minimal one, so
    # a literal that gates nothing at all is still reported in it. Dropping the
    # enforcement therefore leaves every assertion above passing while the bare
    # constraint quietly reacquires the power to prove infeasibility on its own,
    # which is what emptied the core in the first place. Read off the model.
    model, _, _ = SchedulerSolver(
        _settings(
            SOLVER_MAX_TIME_SECONDS=10.0,
            SCHEDULE_DAYS="1",
            SCHEDULE_DAY_START_MINUTES=630,
            SCHEDULE_DAY_END_MINUTES=765,
        ),
    )._build_model(
        OptimizeScheduleRequest.model_validate(payload),
        use_assumptions=True,
        include_objective=False,
    )[:3]
    proto = model.Proto()
    lock_indices = {
        index
        for index, variable in enumerate(proto.variables)
        if variable.name.startswith("lunchlock_")
    }
    assert lock_indices, "no lunch-lock literal was registered at all"
    enforced = {
        literal
        for constraint in proto.constraints
        for literal in constraint.enforcement_literal
    }
    assert lock_indices & enforced, (
        "the lunch-start restriction is bare again: it can prove the week "
        "impossible without touching an assumption, which empties the core"
    )


def test_a_locked_lesson_moves_the_break_rather_than_only_refusing_the_week() -> None:
    """The class eats in the gap the locked lessons leave, and it is a real gap.

    The test above proves the rule binds by making it impossible to satisfy,
    which on its own would also be satisfied by an implementation that refused
    everything. This one states the rule outright: a two-hour window, two
    locked lessons eating one end each, and exactly one 60-minute break that
    fits between them.

    11:00-13:00 admits starts at 11:00, 11:15, ... 12:00. A locked 11:00-11:45
    rules out every start before 11:45, and a locked 12:45-13:00 rules out
    12:00 (and everything from 11:45 up would have been fine but for the first
    one). What survives is 11:45 alone, so the chosen sitting is not a matter
    of which solution the solver happened to find.

    The start is read off the solved model because the response has no field
    for it — `ScheduledLesson` is the only row a response carries, which is
    also why `benchmarks/validate_schedule.py` cannot check this rule.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))
    payload = _dining_payload([30])
    class_7a = str(payload["requirements"][0]["studentGroupId"])  # type: ignore[index]
    payload["fixedLessons"] = [
        _locked_lesson(class_7a, "11:00:00", "11:45:00"),
        _locked_lesson(class_7a, "12:45:00", "13:00:00"),
    ]
    payload["rules"] = _lunch_rules(lunchEndTime="13:00:00", diningSeats=30)
    request = OptimizeScheduleRequest.model_validate(payload)

    def _slot(hhmmss: str) -> int:
        return (_minutes(hhmmss) - solver._grid.day_start_minutes) // solver._grid.slot_minutes

    _lessons, sittings = _solved_spans(solver, request)
    assert sittings[class_7a] == [(_slot("11:45:00"), _slot("12:45:00"))], (
        "the only hour of the window the locked lessons leave free is "
        "11:45-12:45, and that is where the class has to eat"
    )


def _lunch_encoding(rules: dict[str, object]) -> dict[str, int]:
    """Count what the lunch builder actually put in the model for `rules`."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _dining_payload([30, 30])
    payload["rules"] = rules
    request = OptimizeScheduleRequest.model_validate(payload)
    model, _, _, _, _ = solver._build_model(request, use_assumptions=False)

    proto = model.Proto()
    variables = [variable.name for variable in proto.variables]
    return {
        "variables": len(variables),
        "lunch_starts": sum(1 for name in variables if name.startswith("lunchstart_")),
        "dining_literals": sum(1 for name in variables if name == "dining_capacity"),
        "sittings": sum(
            1 for constraint in proto.constraints if constraint.name.startswith("sitting_")
        ),
        "cumulatives": sum(
            1 for constraint in proto.constraints if constraint.has_cumulative()
        ),
        "estimate": solver._estimate_model_size(request),
    }


def test_without_a_seat_limit_the_lunch_encoding_is_the_one_it_always_was() -> None:
    """Most schools have room to spare and must not pay for counting who sits.

    A payload naming no seats has to build exactly what it built before the
    hall existed: one lunch start per group-day, no sittings, no literal
    standing for the hall, and no cumulative beyond the one the room allocator
    owns. Nothing is conditional on a seat count that is not there.

    What naming seats costs is ONE BOOLEAN for the whole model, at any size of
    school, and that is the claim worth pinning because it is the one that
    sounds untrue. The cumulative reuses the lunch starts that already exist;
    an optional fixed-size interval over an existing start variable adds none
    of its own, because its end is an affine expression rather than a variable;
    and every sitting is present on the same shared literal, so the literal is
    the whole cost. Counting the model's variables end to end is the only
    assertion that would notice if any of those three stopped holding.

    `_estimate_model_size` has to charge for that difference and nothing else,
    or the complexity guard stops describing the model it guards.
    """
    open_hall = _lunch_encoding(_lunch_rules())
    limited = _lunch_encoding(_lunch_rules(diningSeats=60))

    assert open_hall["lunch_starts"] == 10, "2 groups x 5 days of free windows"
    assert open_hall["sittings"] == 0
    assert open_hall["dining_literals"] == 0

    assert limited["lunch_starts"] == open_hall["lunch_starts"], (
        "the free-window guarantee must not change shape when seats appear"
    )
    assert limited["sittings"] == 10, "one sitting per group-day, over 2 x 5"
    assert limited["dining_literals"] == 1, (
        "one literal for every sitting in the school — they stand or fall "
        "together, so a second one would buy nothing and cost a search"
    )
    assert limited["cumulatives"] == open_hall["cumulatives"] + 1, (
        "one cumulative for the whole week — the days cannot overlap"
    )
    assert limited["variables"] - open_hall["variables"] == 1, (
        f"ten sittings cost {limited['variables'] - open_hall['variables']} "
        f"variables; the whole seat rule is meant to cost one"
    )
    assert limited["estimate"] - open_hall["estimate"] == 1
    for encoding in (open_hall, limited):
        assert encoding["estimate"] >= encoding["variables"], (
            "the complexity guard has to bound the model it predicts"
        )


def test_a_seat_limit_with_no_headcounts_yet_seats_nobody() -> None:
    """The engine ships before the gateway that fills the new field.

    In the window between the two deploys a school can already have saved a
    seat count while every requirement still arrives with lunchHeadcount at its
    default of 0. That has to mean "nobody has told us who eats" and build no
    sittings at all — not a hall closed to the entire school, which is what a
    demand of zero read as a real number would come to.

    A group of nought is also what every teaching group looks like once the
    gateway does fill the field, so this is the same guard that keeps a
    nivågrupp out of the cumulative rather than in it demanding nothing: an
    interval that occupies no seat is pure propagator work.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _dining_payload([0, 0])
    payload["rules"] = _lunch_rules(diningSeats=60)

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, _, _, _, _ = solver._build_model(request, use_assumptions=False)
    proto = model.Proto()

    assert not [
        constraint.name
        for constraint in proto.constraints
        if constraint.name.startswith("sitting_")
    ]
    assert [
        variable.name
        for variable in proto.variables
        if variable.name.startswith("lunchstart_")
    ], "the free-window guarantee is not conditional on anybody eating"
    assert solver.solve(request).status in {"OPTIMAL", "FEASIBLE"}


def test_seats_without_a_lunch_window_are_inert_and_deliberately_so() -> None:
    """A seat count on its own is a number about a room nobody is sent to.

    The whole dining-hall mechanism hangs off the lunch interval, and there is
    no lunch interval until the school has given a window and a length. So a
    settings row carrying `diningSeats` and no lunch window builds nothing:
    no lunch starts, no sittings, no literal for the hall, no cumulative — and,
    just as importantly, no rejection. A school that types a seat count before
    it has decided when lunch is has made no error and must not be told it has.

    That is reachable today. The three lunch fields and the seat count live on
    one settings form, and the engine ships before the gateway that fills any
    of them, so "seats but no window" is an ordinary intermediate state rather
    than a corner case.

    Both halves are asserted because they fail apart. The fail-fast check that
    refuses a class larger than the hall reads the same window test; drop it
    from there and a school with a class of thirty and twenty seats gets a 400
    for a rule that is not switched on.
    """
    seats_only = _lunch_encoding({"diningSeats": 30})

    assert seats_only["lunch_starts"] == 0
    assert seats_only["sittings"] == 0
    assert seats_only["dining_literals"] == 0
    assert seats_only["cumulatives"] == _lunch_encoding(_lunch_rules())["cumulatives"], (
        "the only cumulative in the model belongs to the room allocator"
    )

    # ... and a class the hall could never hold is not an error either, because
    # there is no sitting for it to fail to fit into.
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))
    too_big = _dining_payload([30])
    too_big["rules"] = {"diningSeats": 20}
    response = solver.solve(OptimizeScheduleRequest.model_validate(too_big))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 1


def test_a_full_dining_hall_is_named_in_the_infeasible_response() -> None:
    """The school is told the hall is full, in the hall's own numbers.

    A cumulative takes no OnlyEnforceIf, so the seat rule reaches a conflict
    core only through the literal every sitting's presence implies. What that
    buys is one sentence in the response: a DINING_CAPACITY conflict quoting
    the seat count the school typed in. Without it the answer degrades to the
    INSUFFICIENT_RESOURCES fallback, which sends an administrator to look at
    rooms and teachers' hours for a problem that is neither.

    The earlier version of this test asserted only that a variable named
    "dining_capacity" appeared in `CpModel.assumptions`. That was true of the
    model and false of the product: the core came back and was thrown away by
    `AssumptionRegistry.resolve`, so no response ever carried the category, and
    the test passed throughout. Assert what the school reads.

    Sixty children, thirty seats, a window one sitting wide. The same week with
    sixty seats schedules, which is what makes the hall the cause rather than
    some incidental scarcity in the fixture.
    """
    one_day = TestClient(
        create_app(_settings(SCHEDULE_DAYS="1", SOLVER_MAX_TIME_SECONDS=10.0)),
    )

    def _post(payload: dict[str, object]) -> dict:
        response = one_day.post(
            "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
        )
        assert response.status_code == 200
        return response.json()

    def _crowd(seats: int) -> dict[str, object]:
        payload = _dining_payload([30, 30])
        payload["rules"] = _lunch_rules(diningSeats=seats)
        return payload

    assert _post(_crowd(60))["status"] in {"OPTIMAL", "FEASIBLE"}, (
        "the fixture must be schedulable once the hall is big enough, or the "
        "verdict below says nothing about seats"
    )

    body = _post(_crowd(30))
    assert body["status"] == "INFEASIBLE"
    assert body["conflicts"] is not None
    categories = {conflict["category"] for conflict in body["conflicts"]["conflicts"]}
    # AMONG the causes, not the only one. CP-SAT also hands back the
    # room-capacity assumptions of two requirements that fit their rooms
    # perfectly well: the core it returns is sufficient, not minimal, and "a
    # category is in the core" is not "that category is the cause".
    assert "DINING_CAPACITY" in categories, f"got {sorted(categories)}"
    named = next(
        conflict
        for conflict in body["conflicts"]["conflicts"]
        if conflict["category"] == "DINING_CAPACITY"
    )
    assert named["code"] == "LUNCH_SEATS_CANNOT_STAGGER"
    assert named["params"] == {"seats": 30}
    assert named["message"] == (
        "Lunch cannot be staggered within the dining hall's 30 seats."
    )
    assert body["conflicts"]["summaryCode"] == "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL"

    # And a school that never named a seat count is never told about seats. The
    # hall is a rule the model does not contain, so an assumption standing for
    # it could only ever name an innocent. Blocking the whole of the one
    # scheduled day is an impossibility with nothing to do with lunch.
    unlimited = _dining_payload([30, 30])
    unlimited["rules"] = _lunch_rules()
    unlimited["constraints"] = [
        _blocks_the_whole_day(
            unlimited["requirements"][0]["studentGroupId"],  # type: ignore[index]
            1,
        ),
    ]
    open_hall = _post(unlimited)
    assert open_hall["status"] == "INFEASIBLE"
    # The exact set, not merely "DINING_CAPACITY is absent": an analysis that
    # named nothing at all would satisfy the weaker form without saying a word
    # about the hall either way.
    assert {conflict["category"] for conflict in open_hall["conflicts"]["conflicts"]} == {
        "AVAILABILITY",
        "ROOM_CAPACITY",
    }


def test_a_class_too_big_for_the_hall_is_refused_before_the_solver_runs(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Thirty children never fit twenty places, on any timetable at all.

    CP-SAT would spend the whole budget proving that and answer INFEASIBLE
    without naming a class or a number — a verdict nobody can act on, at full
    price. So the arithmetic belongs beside the other impossibilities in
    _validate_request, and the way to say that is that no solve happens.
    """
    from app.solver import scheduler_solver as solver_module

    solves: list[object] = []
    real_solve = solver_module.cp_model.CpSolver.Solve

    def recording_solve(self, model, solution_callback=None):  # noqa: ANN001, ANN202
        solves.append(model)
        return real_solve(self, model)

    monkeypatch.setattr(solver_module.cp_model.CpSolver, "Solve", recording_solve)

    payload = _dining_payload([30])
    payload["rules"] = _lunch_rules(diningSeats=20)
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "INVALID_SCHEDULE_INPUT"
    assert body["message"] == (
        f"Student group {group_id} brings 30 students to lunch, more than the "
        f"dining hall's 20 seats."
    )
    assert solves == [], "the seat check must reject before any model is solved"


def test_an_off_grid_lunch_break_is_a_400_not_a_500(client: TestClient) -> None:
    """A saved setting that breaks every run has to say which setting.

    minutes_to_slots refuses an off-grid duration with a bare ValueError, and
    that call used to sit outside the block turning those into
    InvalidScheduleInputError, so main.py's catch-all answered 500 for plain bad
    input. Now that lunch is a stored preference rather than a number retyped
    per run, the same 500 would come back on every generation until somebody
    guessed which of the settings was wrong.

    The value moved from 40 to 37 when the grid went from fifteen minutes to
    five: 40 is legal now, which is exactly why the grid moved. The same
    oversight lived on in `minutes_per_lesson` until a school with 40-minute
    lessons found it — see
    test_a_misaligned_lesson_length_is_input_not_a_crash.

    The neighbouring rejection — a window too short to hold the break it asks
    for — already answered 400 and has to keep doing so.
    """
    payload = _sample_payload()
    payload["rules"] = _lunch_rules(lunchEndTime="13:00:00", lunchMinutes=37)
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "INVALID_SCHEDULE_INPUT"
    # Named for the lunch. The grid's own complaint says "Lesson duration 37
    # minutes", and a school that typed a 37-minute LUNCH went looking through
    # its timplan for a lesson that was not there.
    assert body["details"]["code"] == "LUNCH_WINDOW_OFF_GRID"
    assert body["message"] == (
        "The lunch window 11:00-13:00 and its 37-minute break do not fit the "
        "5-minute scheduling grid. Use whole multiples of 5 minutes."
    )

    payload["rules"] = _lunch_rules(lunchEndTime="11:30:00")
    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 400
    assert response.json()["message"] == (
        "The lunch window 11:00-11:30 is shorter than the 60-minute lunch "
        "break it has to hold."
    )


def test_a_per_day_lesson_cap_and_a_seat_limit_hold_at_the_same_time() -> None:
    """Two rules in one settings form, and neither may cost the other anything.

    The cap reifies "is this group taught on this day" once per group-day-
    lesson, and those literals are its own. An earlier seat encoding asked the
    same question — it wanted to know whether a class was in the building
    before charging it a sitting — and the two rules had to be made to share
    them or the term the complexity guard charges once would have been paid
    twice. Unconditional demand does not ask at all: every class eats every
    school day whatever the timetable does with it. So the hall now adds NO
    on-day literals rather than sharing them, and the way to say that is that
    a payload with both rules reifies exactly what the cap alone reifies.

    The cap is made to bind on its own first (seven lessons will not fit three
    days at two a day), because a cap that is never reached would let this test
    pass against a solver that had dropped it.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(
        _settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1,2,3"),
    )

    def _request(lessons: int, rules: dict[str, object]):  # noqa: ANN202
        payload = _dining_payload([30], lessons_per_week=lessons)
        payload["rules"] = rules
        return OptimizeScheduleRequest.model_validate(payload)

    cap_only: dict[str, object] = {"maxLessonsPerDayPerGroup": 2}
    overloaded = solver.solve(_request(7, cap_only))
    assert overloaded.status == "INFEASIBLE", (
        "seven lessons at two a day need four days; a three-day week cannot "
        "hold them unless the cap is being ignored"
    )

    def _named(request, prefix: str) -> list[str]:  # noqa: ANN001
        model, _, _, _, _ = solver._build_model(request, use_assumptions=False)
        return [
            variable.name
            for variable in model.Proto().variables
            if variable.name.startswith(prefix)
        ]

    # Rules that mention no lunch must not build one — the whole lunch block is
    # conditional on the window, not on `rules` being present at all.
    capped = _request(6, cap_only)
    assert _named(capped, "lunchstart_") == []
    assert solver.solve(capped).status in {"OPTIMAL", "FEASIBLE"}

    both = _request(6, _lunch_rules(diningSeats=30, maxLessonsPerDayPerGroup=2))
    cap_only_literals = _named(capped, "onday_")
    both_literals = _named(both, "onday_")
    assert len(cap_only_literals) == 3 * 6, (
        "one literal per group-day-lesson, 3 days x 6 lessons"
    )
    # Counts, not names: every fixture mints its own ids and the literals are
    # named after them.
    assert len(both_literals) == len(cap_only_literals), (
        f"the seat limit reified {len(both_literals) - len(cap_only_literals)} "
        f"on-day literals of its own; unconditional demand needs none"
    )
    assert len(both_literals) == len(set(both_literals)), (
        "the same on-day literal was reified twice"
    )

    response = solver.solve(both)
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 6
    per_day: dict[int, int] = {}
    for lesson in response.lessons:
        per_day[lesson.day_of_week] = per_day.get(lesson.day_of_week, 0) + 1
    assert sorted(per_day.values()) == [2, 2, 2], (
        f"the cap of two a day was not honoured alongside the seat limit: {per_day}"
    )


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

    fast, _, _, _, _ = solver._build_model(request, use_assumptions=False)
    assert list(fast.Proto().assumptions) == []

    explained, registry, _, _, _ = solver._build_model(request, use_assumptions=True)
    assert len(explained.Proto().assumptions) > 0


def test_a_conflict_core_is_read_as_literal_references_not_list_positions() -> None:
    """What OR-Tools returns are variable indices. They are not list offsets.

    Reading them as offsets is why no category ever reached a response: on any
    real payload the room and availability builders have claimed hundreds of
    variable indices before the first assumption literal exists, so every
    reference fell off the end of a short record list, resolved to nothing, and
    the whole analysis degraded to the INSUFFICIENT_RESOURCES fallback. On a
    payload long enough for the numbers to land INSIDE the list it is worse
    than a fallback: the positions name unrelated records, confidently.

    The padding below is what makes the two readings distinguishable, and is
    the only reason this test can tell them apart at all.
    """
    from ortools.sat.python import cp_model

    from app.solver.conflict_analyzer import AssumptionRegistry

    model = cp_model.CpModel()
    for position in range(5):
        model.NewBoolVar(f"padding_{position}")

    registry = AssumptionRegistry(use_assumptions=True)
    literals = [
        registry.register(model, name=name, category=category, code=name)
        for name, category in (
            ("full_room", "ROOM_CAPACITY"),
            ("blocked_window", "AVAILABILITY"),
            ("full_hall", "DINING_CAPACITY"),
        )
    ]

    references = [literal.Index() for literal in literals]
    assert references == [5, 6, 7], "the padding must push literals off position"
    assert [record.category for record in registry.resolve(references)] == [
        "ROOM_CAPACITY",
        "AVAILABILITY",
        "DINING_CAPACITY",
    ]

    assert registry.resolve([0, 1, 2]) == [], (
        "positions 0-2 are padding variables this registry never assumed; "
        "resolving them to its first three records is the original bug"
    )
    # A negated literal is a negative reference (-index - 1). This registry only
    # ever assumes fresh positive variables, so a core naming one belongs to
    # somebody else and must be skipped — never folded back onto its variable.
    assert registry.resolve([literals[0].Not().Index()]) == []


def test_an_infeasibility_no_assumption_explains_still_says_something() -> None:
    """An empty core must not come back as an empty explanation.

    CP-SAT returns no core when the proof needed nothing it was told to assume,
    and a school reading "INFEASIBLE" with no conflicts at all has been told
    less than nothing. The fallback is deliberately vague because it is a
    guess, and it says so in its own summary.

    This used to be the answer to almost every infeasible payload, since
    `resolve` threw away every real core. Now that cores resolve, the fallback
    is reachable only where it belongs — an infeasibility genuinely outside the
    registered assumptions, which is what the arithmetic below is. No payload
    in this suite reaches it any more, so this test is the whole of its
    coverage and the arithmetic is built rather than found for that reason.

    "No CONFLICT core", not "no MINIMAL conflict core". CP-SAT never promised a
    minimal one, the sibling summary now says so outright, and a word left
    standing here would have gone on teaching the misconception next door.
    """
    from ortools.sat.python import cp_model

    from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis

    model = cp_model.CpModel()
    registry = AssumptionRegistry(use_assumptions=True)
    registry.register(
        model,
        name="innocent",
        category="ROOM_CAPACITY",
        code="ROOM_NO_ROOM_FOR_REQUIREMENT",
        params={"requirement": str(uuid4()), "groupSize": 30},
    )
    hours = model.NewIntVar(0, 5, "hours")
    model.Add(hours >= 4)
    model.Add(hours <= 2)

    solver = cp_model.CpSolver()
    assert solver.Solve(model) == cp_model.INFEASIBLE
    assert list(solver.SufficientAssumptionsForInfeasibility()) == [], (
        "the impossibility must be independent of the assumption, or this is "
        "testing the resolved path instead of the fallback"
    )

    analysis = build_conflict_analysis(solver, registry)
    assert [conflict.category for conflict in analysis.conflicts] == [
        "INSUFFICIENT_RESOURCES",
    ]
    assert analysis.summary == (
        "No timetable satisfies every rule, and the solver could not name "
        "which of them collide."
    )
    assert analysis.conflicts[0].message, "a guess still has to say something"


def test_the_causes_a_school_can_check_are_listed_first() -> None:
    """The order is the difference between a report and a wall of text.

    Taken from a real one. A school of two classes got twenty-four true lines
    saying "the requirement X needs a room of type Klassrum that holds 20", one
    per teaching group, and below them four lines naming a class and a weekday
    — "locked lessons leave 4.1 no lunch gap on Tuesday" — one of which was the
    week's actual problem. Same set, same sentences; the reader had to get past
    two dozen lines about rooms that were not short to reach the Tuesday that
    was full.

    Asserted on the ORDER and not on the membership, because nothing here drops
    a cause: the core is sufficient and not minimal, the summary says so, and a
    line that reads as innocent today is the one somebody needs tomorrow.
    """
    from app.schemas.schedule import ConflictDetail
    from app.solver.conflict_analyzer import _how_far_it_narrows

    rooms = [
        ConflictDetail(
            category="ROOM_CAPACITY",
            code="ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT",
            params={"requirement": str(uuid4()), "groupSize": 20, "roomType": "Klassrum"},
            requirementIds=[uuid4()],
        )
        for _ in range(24)
    ]
    hall = ConflictDetail(
        category="DINING_CAPACITY",
        code="LUNCH_SEATS_CANNOT_STAGGER",
        params={"seats": 115},
    )
    days = [
        ConflictDetail(
            category="GROUP_OVERLAP",
            code="LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
            params={
                "group": str(uuid4()), "minutes": 15, "day": day,
                "windowStart": "10:30", "windowEnd": "13:00",
            },
            resourceIds=[uuid4()],
        )
        for day in (2, 3, 1, 5)
    ]

    found = [*rooms, hall, *days]
    found.sort(key=_how_far_it_narrows(found))

    assert [conflict.category for conflict in found[:4]] == ["GROUP_OVERLAP"] * 4, (
        "a class and a weekday is a thing to open and look at"
    )
    assert found[-1] is hall, (
        "the hall's seats describe the whole week and narrow nothing"
    )
    assert len(found) == 29, "ordering may not drop a cause"


def test_a_weekday_outranks_a_rarer_cause_that_names_none() -> None:
    """The day is worth more than the rarity, and only this shape shows it.

    Where the two agree the order comes out right either way, which is most
    payloads and is why this case is built rather than found: one lonely line
    about a room against three about a class and a weekday. Rarity alone would
    put the room first — it is stated once — and the school would open its room
    list to look for a shortage while the Tuesday that is full waits below.
    """
    from app.schemas.schedule import ConflictDetail
    from app.solver.conflict_analyzer import _how_far_it_narrows

    room = ConflictDetail(
        category="ROOM_CAPACITY",
        code="ROOM_NO_ROOM_FOR_REQUIREMENT",
        params={"requirement": str(uuid4()), "groupSize": 20},
        requirementIds=[uuid4()],
    )
    days = [
        ConflictDetail(
            category="GROUP_OVERLAP",
            code="LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
            params={
                "group": str(uuid4()), "minutes": 15, "day": day,
                "windowStart": "10:30", "windowEnd": "13:00",
            },
            resourceIds=[uuid4()],
        )
        for day in (1, 2, 3)
    ]

    found = [room, *days]
    found.sort(key=_how_far_it_narrows(found))

    assert found[0] in days, "one class on one day beats one line about rooms"
    assert found[-1] is room


def test_the_rarer_sentence_goes_first_where_nothing_else_separates_them() -> None:
    """Twenty variations on one code are a property many things share.

    Both of these name a requirement and neither names a day, so the tier
    cannot separate them; what is left is that one of them was said once and
    the other three times, and the one said once is likelier to be the
    particular thing that went wrong.
    """
    from app.schemas.schedule import ConflictDetail
    from app.solver.conflict_analyzer import _how_far_it_narrows

    common = [
        ConflictDetail(
            category="ROOM_CAPACITY",
            code="ROOM_NO_ROOM_FOR_REQUIREMENT",
            params={"requirement": str(uuid4()), "groupSize": 20},
            requirementIds=[uuid4()],
        )
        for _ in range(3)
    ]
    lone = ConflictDetail(
        category="ROOM_CAPACITY",
        code="ROOM_LOCK_LEAVES_NO_ROOM",
        params={"requirement": str(uuid4()), "grades": "4-6"},
        requirementIds=[uuid4()],
    )

    found = [*common, lone]
    found.sort(key=_how_far_it_narrows(found))

    assert found[0] is lone


def test_the_analysis_the_school_receives_is_the_ordered_one() -> None:
    """Through the real path, because the key function alone proves nothing.

    Ordering that is written and then not applied looks exactly like ordering
    that works, right up until a school reads the report. So this asserts on
    what build_conflict_analysis returns, with a core CP-SAT actually produced.
    """
    from ortools.sat.python import cp_model

    from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis

    model = cp_model.CpModel()
    registry = AssumptionRegistry(use_assumptions=True)
    vague = registry.register(
        model,
        name="hall",
        category="DINING_CAPACITY",
        code="LUNCH_SEATS_CANNOT_STAGGER",
        params={"seats": 115},
    )
    precise = registry.register(
        model,
        name="tuesday",
        category="GROUP_OVERLAP",
        code="LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
        params={
            "group": str(uuid4()), "minutes": 15, "day": 2,
            "windowStart": "10:30", "windowEnd": "13:00",
        },
        resource_ids=[uuid4()],
    )
    # Registered vague-first, so a returned list in registration order fails.
    hours = model.NewIntVar(0, 5, "hours")
    model.Add(hours >= 4).OnlyEnforceIf(vague)
    model.Add(hours <= 2).OnlyEnforceIf(precise)

    solver = cp_model.CpSolver()
    assert solver.Solve(model) == cp_model.INFEASIBLE

    analysis = build_conflict_analysis(solver, registry)

    assert [conflict.category for conflict in analysis.conflicts] == [
        "GROUP_OVERLAP", "DINING_CAPACITY",
    ]


def test_the_reading_order_is_stable_when_nothing_separates_two_causes() -> None:
    """Two lines the rule cannot tell apart keep the order they arrived in.

    A report that reshuffles itself between two runs of the same payload reads
    as though something changed in the school's data, and an administrator
    comparing this run with the last one would go looking for it.
    """
    from app.schemas.schedule import ConflictDetail
    from app.solver.conflict_analyzer import _how_far_it_narrows

    twins = [
        ConflictDetail(
            category="ROOM_CAPACITY",
            code="ROOM_NO_ROOM_FOR_REQUIREMENT",
            params={"requirement": str(uuid4()), "groupSize": 20},
            requirementIds=[uuid4()],
        )
        for _ in range(5)
    ]

    ordered = list(twins)
    ordered.sort(key=_how_far_it_narrows(ordered))

    assert ordered == twins


def test_one_sentence_twice_becomes_one_line_that_names_both_causes() -> None:
    """De-duplication merges the ids; it does not pick a survivor.

    Two records can carry the same sentence and different ids — a year
    reservation registers once per requirement it blocks, and every one of
    those registrations says the same thing about a different lesson. Showing
    an administrator one of them and silently dropping the rest points at an
    arbitrary member of the set, which is worse than the forty duplicate lines
    de-duplication exists to remove: those at least agreed.

    The end-to-end test above cannot see this. Its forty duplicates all come
    from one requirement and therefore all carry the identical id, so the union
    below is never exercised by any payload in this file.
    """
    from ortools.sat.python import cp_model

    from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis

    first_requirement = uuid4()
    second_requirement = uuid4()
    # One code and one set of values is what makes two records the same
    # sentence — not the English, which is only what that pair renders to.
    same_sentence = {"requirement": str(uuid4()), "groupSize": 30}

    model = cp_model.CpModel()
    registry = AssumptionRegistry(use_assumptions=True)
    hours = model.NewIntVar(0, 5, "hours")
    for requirement_id, bound in (
        (first_requirement, hours >= 4),
        (second_requirement, hours <= 2),
    ):
        literal = registry.register(
            model,
            name=f"capacity_{requirement_id}",
            category="ROOM_CAPACITY",
            code="ROOM_NO_ROOM_FOR_REQUIREMENT",
            params=same_sentence,
            requirement_ids=[requirement_id],
        )
        model.Add(bound).OnlyEnforceIf(literal)

    solver = cp_model.CpSolver()
    assert solver.Solve(model) == cp_model.INFEASIBLE
    assert len(solver.SufficientAssumptionsForInfeasibility()) == 2, (
        "both assumptions have to be in the core, or there is nothing to merge"
    )

    analysis = build_conflict_analysis(solver, registry)
    assert len(analysis.conflicts) == 1, "one sentence, one line"
    assert analysis.conflicts[0].requirement_ids == [
        first_requirement,
        second_requirement,
    ], "the merged line has to name every requirement the duplicates named"


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
        cp_model.CpModel(),
        request.requirements,
        len(request.rooms),
        request.frame_times,
        request.rasts,
    )

    classes = build_room_classes(
        decisions, request.rooms, set(), solver._room_allowed, solver._room_profile_key,
    )
    sizes = sorted(len(c.room_indices) for c in classes)
    # {room 0, room 1} interchangeable; the lab and the undersized room differ.
    assert sizes == [1, 1, 2], f"unexpected partition {sizes}"

    pinned = build_room_classes(
        decisions,
        request.rooms,
        {request.rooms[0].id},
        solver._room_allowed,
        solver._room_profile_key,
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

    Two payloads, one on each side of the line, then the two terms this
    release added.

    The first has 450 recurring constraints on teachers who appear nowhere in
    the requirements. The retired formula charged lessons x constraints x days
    for them — 2.25M against its 2M budget, a rejection — although constraints
    that touch no lesson add literally nothing to the model.

    The second is genuinely pathological: 1,000 rooms with 500 distinct
    capacities. Every capacity tier is its own interchangeability class, so
    the room allocator would emit a class literal per (lesson, class) —
    millions of variables the build phase would sit in before any timeout
    could engage. That is precisely what the guard exists to stop.

    Then the new terms. A GRADE_LEVEL constraint reaches whichever groups its
    years overlap, which the estimator cannot enumerate without an
    O(constraints x groups) scan it is written to avoid, so it is charged the
    worst case: every lesson, twice. It must not fall through to the ROOM
    branch, which charges a third literal per lesson for a room assignment a
    year reservation never reifies.

    The rules term is (1 + D)L + GD, plus ONE for a seat limit — a day var per
    lesson, an on-day boolean per lesson-day, a lunch start per group-day, and
    the single literal every sitting is present on. Not one per group-day: the
    cumulative reuses the lunch starts, an optional fixed-size interval over an
    existing start adds no variable of its own, and one shared literal serves
    the whole school. The one is charged whenever a seat count is set, lunch
    window or no lunch window, because an estimate that is high by one is still
    an upper bound and the alternative is reading three more fields to save it.
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

    seated = _dining_payload([30, 30], lessons_per_week=3)
    unlocked = OptimizeScheduleRequest.model_validate(seated)
    total_lessons = sum(r.lessons_per_week for r in unlocked.requirements)

    seated["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "GRADE_LEVEL",
            "resourceId": None,
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
            "dayOfWeek": 1,
            "date": None,
            "startTime": "11:00:00",
            "endTime": "12:00:00",
            "kind": "UNAVAILABLE",
        },
    ]
    year_locked = OptimizeScheduleRequest.model_validate(seated)
    assert solver._estimate_model_size(year_locked) - solver._estimate_model_size(
        unlocked,
    ) == 2 * total_lessons

    seated["constraints"] = []
    seated["rules"] = _lunch_rules()
    open_hall = OptimizeScheduleRequest.model_validate(seated)
    seated["rules"] = _lunch_rules(diningSeats=60)
    limited = OptimizeScheduleRequest.model_validate(seated)
    assert solver._estimate_model_size(limited) - solver._estimate_model_size(
        open_hall,
    ) == 1, "one literal for the whole hall, at any size of school"

    # The seat literal is the ONLY rules-dependent variable in the estimate.
    # (1 + D)L and GD are charged whether or not the school set a single rule,
    # which is an upper bound taken deliberately rather than by oversight: it
    # costs an over-estimate on a payload with no lunch and saves the estimator
    # from reading the rules to decide what to charge.
    seated["rules"] = None
    ruleless = OptimizeScheduleRequest.model_validate(seated)
    assert solver._estimate_model_size(open_hall) == solver._estimate_model_size(
        ruleless,
    ), "the day, on-day and lunch-start terms do not depend on the rules"
    assert solver._estimate_model_size(limited) - solver._estimate_model_size(
        ruleless,
    ) == 1

    # Seats with no window to spend them on are charged all the same. The
    # builder makes nothing in that case, so the estimate is high by one — the
    # safe direction for a bound, and cheaper than reading three more fields.
    seated["rules"] = {"diningSeats": 60}
    seats_only = OptimizeScheduleRequest.model_validate(seated)
    assert solver._estimate_model_size(seats_only) - solver._estimate_model_size(
        ruleless,
    ) == 1

    # The property all of this exists for: whatever the terms say, the estimate
    # has to bound the model it predicts.
    model, _, _, _, _ = solver._build_model(limited, use_assumptions=False)
    assert solver._estimate_model_size(limited) >= len(model.Proto().variables)


def test_previous_lessons_warm_start_the_feasibility_phase(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The phase-1 model must carry hints from the previous schedule.

    The warm-start hints used to live inside _add_disruption_objective, which
    the objective-free phase-1a build never runs — and phase 2 clears hints
    in favour of the phase-1 solution, so previous_lessons silently stopped
    accelerating anything. Measured cost of losing this: 1,000 students cold
    is a TIMEOUT at 120s; warm it solves in ~7s. This pins the hint
    installation on the FIRST model solved.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver import scheduler_solver as solver_module
    from app.solver.scheduler_solver import SchedulerSolver

    real_solve = solver_module.cp_model.CpSolver.Solve
    solved_models = []

    def recording_solve(self, model, solution_callback=None):  # noqa: ANN001, ANN202
        solved_models.append(model)
        return real_solve(self, model)

    monkeypatch.setattr(solver_module.cp_model.CpSolver, "Solve", recording_solve)

    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    payload["previousLessons"] = [
        {
            "requirementId": requirement["id"],  # type: ignore[index]
            "dayOfWeek": 3,
            "startTime": "11:00:00",
        },
    ]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=5.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}

    hint = solved_models[0].Proto().solution_hint
    assert len(hint.vars) == 1, "one previous slot must install exactly one hint"

    # Wednesday 11:00, worked out from the grid rather than written down.
    #
    # This used to assert a bare 92 — day index 2 x 40 slots + 12 — which was
    # right for a fifteen-minute grid and silently wrong the moment it became
    # five. Deriving it keeps the test about the thing it is for: a previous
    # lesson installs a hint at ITS OWN absolute slot. The arithmetic is spelled
    # out rather than borrowed from TimeGrid, so a fault in the grid cannot hide
    # inside both sides of the comparison.
    settings = _settings()
    slots_per_day = (
        settings.schedule_day_end_minutes - settings.schedule_day_start_minutes
    ) // settings.slot_minutes
    minutes_into_day = 11 * 60 - settings.schedule_day_start_minutes
    wednesday = 2
    expected = wednesday * slots_per_day + minutes_into_day // settings.slot_minutes
    assert list(hint.values) == [expected]


def _shared_student_payload() -> dict[str, object]:
    """Home class 7A and teaching group Ma71 that share students.

    Both groups need 20 hour-lessons in a 40-slot week with two rooms and
    DIFFERENT teachers, so teacher/room constraints leave plenty of overlap
    freedom: without the group-conflict pair the solver can (and with 40
    lessons into 40 slots per group, must) run them in parallel; with the
    pair, both groups must share one sequence — which still fits, since
    2 x 20 = 40 slots. The pair is therefore strictly binding but satisfiable.
    """
    class_7a = str(uuid4())
    group_ma71 = str(uuid4())
    payload = _sample_payload()
    template = payload["requirements"][0]  # type: ignore[index]
    payload["requirements"] = [
        {
            **template,  # type: ignore[dict-item]
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": class_7a,
            "lessonsPerWeek": 20,
        },
        {
            **template,  # type: ignore[dict-item]
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": group_ma71,
            "lessonsPerWeek": 20,
        },
    ]
    payload["rooms"] = [
        {"id": str(uuid4()), "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
    ]
    payload["groupConflicts"] = [[class_7a, group_ma71]]
    return payload


def _absolute_spans(solver, lessons, req_by_id):  # noqa: ANN001, ANN202
    grid = solver._grid
    spans = []
    for lesson in lessons:
        requirement = req_by_id[lesson.requirement_id]
        duration = grid.minutes_to_slots(requirement.minutes_per_lesson)
        start = grid.day_index(lesson.day_of_week) * grid.slots_per_day + grid.parse_hhmmss(
            lesson.start_time,
        )
        spans.append((requirement.student_group_id, start, start + duration))
    return spans


def test_groups_sharing_students_never_overlap() -> None:
    """A teaching group and a home class with common students must serialise.

    This is the Swedish nivågrupper/språkval case: a student belongs to class
    7A and to Ma71, so a 7A lesson and an Ma71 lesson at the same time
    double-books that student. The engine only sees group ids; the
    groupConflicts pairs carry the shared-students relation.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _shared_student_payload()
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 40

    request = OptimizeScheduleRequest.model_validate(payload)
    req_by_id = {r.id: r for r in request.requirements}
    spans = _absolute_spans(solver, response.lessons, req_by_id)
    for i in range(len(spans)):
        for j in range(i + 1, len(spans)):
            group_a, start_a, end_a = spans[i]
            group_b, start_b, end_b = spans[j]
            if group_a == group_b:
                continue  # within-group overlap is covered by existing tests
            assert not (start_a < end_b and start_b < end_a), (
                f"conflicting groups overlap at slots "
                f"{max(start_a, start_b)}-{min(end_a, end_b)}"
            )


def test_without_the_conflict_pair_the_groups_do_overlap() -> None:
    """Non-vacuity twin: drop the pair and the same school MUST overlap.

    Each group needs 20 of the week's 40 slots; two disjoint groups can only
    fit by running in parallel somewhere. If this test ever starts failing
    (the solver serialises them anyway), the positive test above has stopped
    proving anything and both need a harder fixture.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _shared_student_payload()
    payload["groupConflicts"] = []
    # 21 + 20 lessons cannot fit 40 slots serially, so SOME overlap is forced.
    payload["requirements"][0]["lessonsPerWeek"] = 21  # type: ignore[index]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20.0))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}, (
        "without the conflict pair this school is trivially schedulable"
    )

    request = OptimizeScheduleRequest.model_validate(payload)
    req_by_id = {r.id: r for r in request.requirements}
    spans = _absolute_spans(solver, response.lessons, req_by_id)
    cross_overlaps = sum(
        1
        for i in range(len(spans))
        for j in range(i + 1, len(spans))
        if spans[i][0] != spans[j][0]
        and spans[i][1] < spans[j][2]
        and spans[j][1] < spans[i][2]
    )
    assert cross_overlaps > 0, (
        "expected parallel lessons once the conflict pair is removed"
    )


def test_a_fixed_lesson_blocks_conflicting_groups_too() -> None:
    """A locked 7A lesson must also block Ma71's generated lessons.

    The fixed-lesson builder matches on group identity; with groupConflicts it
    must widen to groups sharing students. One fixed lesson covering all of
    Monday 08:00-17:45 for 7A, plus one generated Ma71 lesson and a Monday-only
    grid, forces the question: without the widening the Ma71 lesson lands on
    Monday inside the window; with it, the model is INFEASIBLE.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    class_7a = str(uuid4())
    group_ma71 = str(uuid4())
    payload = _sample_payload()
    template = payload["requirements"][0]  # type: ignore[index]
    payload["requirements"] = [
        {
            **template,  # type: ignore[dict-item]
            "id": str(uuid4()),
            "studentGroupId": group_ma71,
            "lessonsPerWeek": 1,
        },
    ]
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "studentGroupId": class_7a,
            "teacherId": str(uuid4()),
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
        },
    ]
    payload["groupConflicts"] = [[class_7a, group_ma71]]

    solver = SchedulerSolver(
        _settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"),
    )
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status == "INFEASIBLE", (
        "the locked class lesson leaves no Monday room for the teaching group"
    )

    # Sanity inversion: without the pair the same payload schedules fine.
    payload["groupConflicts"] = []
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}


def test_a_group_paired_with_itself_is_dropped_at_the_boundary() -> None:
    """(A, A) says nothing, so it must not survive into the request.

    The pairs are derived from membership data; an unfiltered self-join on the
    gateway side emits (A, A). It is vacuous — a group always shares students
    with itself — but read literally it is poison, so the schema strips it
    while leaving every genuine pair alone.
    """
    from app.schemas.schedule import OptimizeScheduleRequest

    payload = _shared_student_payload()
    class_7a, group_ma71 = payload["groupConflicts"][0]  # type: ignore[index]
    payload["groupConflicts"] = [  # type: ignore[assignment]
        [class_7a, class_7a],
        [class_7a, group_ma71],
        [group_ma71, group_ma71],
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    assert [tuple(map(str, pair)) for pair in request.group_conflicts] == [
        (class_7a, group_ma71)
    ], "self-pairs must be dropped, genuine pairs kept"


def test_a_self_pair_reaching_the_solver_is_not_infeasible() -> None:
    """A group paired with itself must not sink the whole request.

    _add_group_no_overlap used to concatenate both sides of every pair, so
    (A, A) put each of A's intervals into one NoOverlap TWICE — asking every
    interval not to overlap itself. CP-SAT answered INFEASIBLE for the entire
    school over a pair that states a truth the per-group NoOverlap already
    enforces. The schema now strips such pairs, so this pins the solver guard
    directly by re-injecting one after validation.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _sample_payload()
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
    request = OptimizeScheduleRequest.model_validate(payload)
    request.group_conflicts = [(UUID(group_id), UUID(group_id))]  # type: ignore[arg-type]

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0))
    response = solver.solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 2


def test_rooms_limited_to_a_stage_reject_other_years(client: TestClient) -> None:
    """A 4-6 room must not take a year 8 group, even when nothing else fits.

    The room a school reserves for mellanstadiet is reserved for a reason —
    it is in their building, or sized for them. Letting a högstadie group in
    because it happened to be free defeats the setting entirely.
    """
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    requirement["minGradeLevel"] = 8  # type: ignore[index]
    requirement["maxGradeLevel"] = 8  # type: ignore[index]

    upper_id = str(uuid4())
    payload["rooms"] = [
        {
            "id": payload["rooms"][0]["id"],  # type: ignore[index]
            "capacity": 100,
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
        },
        {"id": upper_id, "capacity": 30, "minGradeLevel": 7, "maxGradeLevel": 9},
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    assert body["lessons"][0]["roomId"] == upper_id


def test_a_group_spanning_two_years_needs_a_room_covering_both(
    client: TestClient,
) -> None:
    """Half a group being in an allowed year is not an allowed placement."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    requirement["minGradeLevel"] = 6  # type: ignore[index]
    requirement["maxGradeLevel"] = 7  # type: ignore[index]

    wide_id = str(uuid4())
    payload["rooms"] = [
        {
            "id": payload["rooms"][0]["id"],  # type: ignore[index]
            "capacity": 100,
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
        },
        {"id": wide_id, "capacity": 30, "minGradeLevel": 4, "maxGradeLevel": 9},
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    assert response.json()["lessons"][0]["roomId"] == wide_id


def test_a_room_with_no_limits_takes_any_year(client: TestClient) -> None:
    """The default has to stay "every year", or existing schools break."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    requirement["minGradeLevel"] = 9  # type: ignore[index]
    requirement["maxGradeLevel"] = 9  # type: ignore[index]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}


def test_a_group_with_unknown_years_is_not_locked_out(client: TestClient) -> None:
    """No members carrying a year means nothing to check — not "refuse all"."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    payload["rooms"] = [
        {
            "id": payload["rooms"][0]["id"],  # type: ignore[index]
            "capacity": 100,
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
        },
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    assert response.json()["status"] in {"OPTIMAL", "FEASIBLE"}


def test_no_room_for_the_years_is_reported_as_such(client: TestClient) -> None:
    """The message has to name the years, or a school cannot act on it."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["minGradeLevel"] = 9  # type: ignore[index]
    requirement["maxGradeLevel"] = 9  # type: ignore[index]
    payload["rooms"] = [
        {
            "id": payload["rooms"][0]["id"],  # type: ignore[index]
            "capacity": 100,
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
        },
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    # 400: the request is well-formed but describes a school where this group
    # has nowhere to be — a configuration error, not a solver failure.
    assert response.status_code == 400
    assert "years 9" in str(response.json())


# ---------------------------------------------------------------------------
# Times reserved for a span of years
#
# A school that keeps 11:30 free for years 4-6 owns no row called "year 5", so
# the reservation names a range instead of a resource and the solver matches it
# against the years each group's own members carry. That is the same data the
# room limits just above read, asked the opposite question: a room decides
# where a group may go, a reservation only decides who must be left alone.
# ---------------------------------------------------------------------------


def _year_lock(min_grade, max_grade):  # noqa: ANN001, ANN202
    """A whole-Monday UNAVAILABLE window aimed at a span of years.

    08:00-17:45 is the widest window the grid can express — 18:00 is the
    exclusive day end — so on a Monday-only week a group the reservation
    reaches has nowhere left to be, and the verdict answers "reached?"
    directly instead of through a timetable that has to be read.
    """
    return {
        "id": str(uuid4()),
        "resourceKind": "GRADE_LEVEL",
        "resourceId": None,
        "minGradeLevel": min_grade,
        "maxGradeLevel": max_grade,
        "dayOfWeek": 1,
        "date": None,
        "startTime": "08:00:00",
        "endTime": "17:45:00",
        "kind": "UNAVAILABLE",
    }


def _reservation_reaches(solver, lock, group_years) -> bool:  # noqa: ANN001
    """Whether a one-lesson Monday survives the reservation `lock`."""
    from app.schemas.schedule import OptimizeScheduleRequest

    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]
    requirement["minGradeLevel"] = group_years[0]  # type: ignore[index]
    requirement["maxGradeLevel"] = group_years[1]  # type: ignore[index]
    payload["constraints"] = [_year_lock(*lock)]

    status = solver.solve(OptimizeScheduleRequest.model_validate(payload)).status
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, (
        f"the probe has to be decided one way or the other, not {status}"
    )
    return status == "INFEASIBLE"


def test_a_year_reservation_reaches_every_group_whose_years_overlap_it() -> None:
    """Keeping Monday free for years 4-6 is a rule about children, not groups.

    Year 5 is reached outright. Years 6-7 are reached too — OVERLAP, not the
    containment the room limits use: part of that group is in year 6, and
    holding the rest of it free as well costs the timetable a little room,
    where letting the lesson stand would put year-6 pupils in a classroom
    during their own lunch. A school can live with the first mistake and not
    with the second, so the rule is written to make the survivable one.

    Year 8 is untouched, or a reservation for one stage of the school would be
    a school-wide closure with extra steps.
    """
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))

    assert _reservation_reaches(solver, (4, 6), (5, 5))
    assert _reservation_reaches(solver, (4, 6), (6, 7)), (
        "a group spanning years 6-7 has year-6 children in it; containment "
        "would leave them in a lesson during a break reserved for them"
    )
    assert not _reservation_reaches(solver, (4, 6), (8, 8))


def test_an_open_ended_year_reservation_stops_at_the_stage_it_names() -> None:
    """"From year 7" and "up to year 3" are how a school says a stage.

    A missing bound is open at that end rather than absent, so each of these is
    checked against the year just inside the edge and the year just outside it.

    A group whose members carry no year at all is never reached: with nothing
    to compare against, "overlaps" has no answer, and answering yes would sweep
    every yearless group into a reservation meant for one part of the school.
    """
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))

    assert _reservation_reaches(solver, (7, None), (6, 7))
    assert not _reservation_reaches(solver, (7, None), (4, 6))

    assert _reservation_reaches(solver, (None, 3), (0, 2))
    assert not _reservation_reaches(solver, (None, 3), (4, 6))

    assert not _reservation_reaches(solver, (None, 3), (None, None)), (
        "a group with no member years is not a group in every year"
    )


def test_a_year_reservation_reaches_a_teaching_group_no_group_lock_can() -> None:
    """Ma51 has no year of its own; its members do, and that is enough.

    A nivågrupp is cut across the classes, so the group register carries no
    gradeLevel for it and there is no single row a lock could name that covers
    both it and the classes it came from. Locking class 5A's window leaves
    Ma51's lessons free to land inside it — the model believes those children
    are at lunch and they are in a maths lesson.

    The year rule is the only shape that reaches them, and it reaches them
    through the same member-derived span the room limits already read.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1"))
    class_5a = str(uuid4())  # the home class; its own lessons are elsewhere

    def _solve(constraint: dict[str, object]):  # noqa: ANN202
        payload = _sample_payload()
        requirement = payload["requirements"][0]  # type: ignore[index]
        requirement["lessonsPerWeek"] = 1  # type: ignore[index]
        requirement["minGradeLevel"] = 5  # type: ignore[index]
        requirement["maxGradeLevel"] = 5  # type: ignore[index]
        payload["constraints"] = [constraint]
        return solver.solve(OptimizeScheduleRequest.model_validate(payload))

    named_the_class = _solve(
        {
            "id": str(uuid4()),
            "resourceKind": "STUDENT_GROUP",
            "resourceId": class_5a,
            "dayOfWeek": 1,
            "date": None,
            "startTime": "08:00:00",
            "endTime": "17:45:00",
            "kind": "UNAVAILABLE",
        },
    )
    assert named_the_class.status in {"OPTIMAL", "FEASIBLE"}, (
        "a lock naming 5A cannot reach a group cut out of 5A — which is the "
        "gap the year rule exists to close"
    )

    named_the_years = _solve(_year_lock(4, 6))
    assert named_the_years.status == "INFEASIBLE"


def test_a_reservation_that_cannot_say_what_it_holds_free_is_refused(
    client: TestClient,
) -> None:
    """A lock nobody can act on is worse than no lock, because it looks saved.

    The gateway builds resourceId from whichever of teacher, room or group the
    row carries. A year rule carries none of the three, so before the field
    could be null something had to be minted there — and a minted id names a
    resource the engine has never heard of: the rule is accepted, validated,
    matches no lesson, and no layer says a word about it. 422 is the only place
    that silence becomes a noise.

    The mirror case is a year rule with no bound at either end. It reads as
    "every year", but a range was far more likely lost on the way here than
    deliberately left out.
    """
    window: dict[str, object] = {
        "dayOfWeek": 1,
        "date": None,
        "startTime": "11:00:00",
        "endTime": "12:00:00",
        "kind": "UNAVAILABLE",
    }

    def _rejection(constraint: dict[str, object]) -> str:
        payload = _sample_payload()
        payload["constraints"] = [{"id": str(uuid4()), **window, **constraint}]
        response = client.post(
            "/api/v1/optimize",
            json=payload,
            headers={"X-API-Key": "test-api-key-000000000000000000000000"},
        )
        assert response.status_code == 422
        return " ".join(
            error["msg"] for error in response.json()["details"]["errors"]
        )

    assert "target a year range, not a resourceId" in _rejection(
        {
            "resourceKind": "GRADE_LEVEL",
            "resourceId": str(uuid4()),
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
        },
    )
    assert "need minGradeLevel or maxGradeLevel" in _rejection(
        {"resourceKind": "GRADE_LEVEL", "resourceId": None},
    )
    # And the same door in the other direction: making resourceId optional must
    # not let a group lock through without the group it locks.
    assert "STUDENT_GROUP constraints need a resourceId" in _rejection(
        {"resourceKind": "STUDENT_GROUP", "resourceId": None},
    )


def _lessons_in_preferred_room(client: TestClient, *, with_preference: bool) -> int:
    """Schedule a week where many lessons want one scarce room; count the wins.

    Both runs solve the same school. The only difference is whether the wish is
    stated, so the difference in how often it is granted is the wish's doing —
    unlike asserting which of two interchangeable rooms was picked, where
    merely restating the model changes a deterministic tie-break and the test
    passes without the objective doing anything at all.
    """
    payload = _sample_payload()
    subject_id = payload["requirements"][0]["subjectId"]  # type: ignore[index]
    preferred_id = str(uuid4())

    payload["requirements"] = [
        {
            "id": str(uuid4()),
            "subjectId": subject_id,
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 4,
            "minutesPerLesson": 60,
            "studentGroupSize": 20,
        }
        for _ in range(3)
    ]
    payload["rooms"] = [
        {"id": preferred_id, "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
    ]
    if with_preference:
        payload["roomPreferences"] = [
            {
                "id": str(uuid4()),
                "subjectId": subject_id,
                "roomIds": [preferred_id],
                "weight": 300,
            }
        ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    lessons = response.json()["lessons"]
    assert len(lessons) == 12
    return sum(1 for lesson in lessons if lesson["roomId"] == preferred_id)


def test_a_stated_preference_wins_the_preferred_room_more_often(
    client: TestClient,
) -> None:
    without = _lessons_in_preferred_room(client, with_preference=False)
    with_wish = _lessons_in_preferred_room(client, with_preference=True)

    assert with_wish > without


def _lessons_in_preferred_type(client: TestClient, *, with_preference: bool) -> int:
    """Same measurement as above, but the wish names a TYPE rather than rooms.

    Worth its own test: the two travel different paths through
    `_preference_room_ids` — one reads `room_ids` straight, the other resolves
    a type against the payload's rooms — and only the room-id path was covered
    when this feature shipped.
    """
    payload = _sample_payload()
    subject_id = payload["requirements"][0]["subjectId"]  # type: ignore[index]
    lab_id = str(uuid4())

    payload["requirements"] = [
        {
            "id": str(uuid4()),
            "subjectId": subject_id,
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 4,
            "minutesPerLesson": 60,
            "studentGroupSize": 20,
        }
        for _ in range(3)
    ]
    payload["rooms"] = [
        {"id": lab_id, "capacity": 30, "type": "LABORATORY"},
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
        {"id": str(uuid4()), "capacity": 30, "type": "CLASSROOM"},
    ]
    if with_preference:
        payload["roomPreferences"] = [
            {
                "id": str(uuid4()),
                "subjectId": subject_id,
                "roomType": "LABORATORY",
                "weight": 300,
            }
        ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )
    assert response.status_code == 200
    lessons = response.json()["lessons"]
    assert len(lessons) == 12
    return sum(1 for lesson in lessons if lesson["roomId"] == lab_id)


def test_a_wish_for_a_room_type_wins_that_type_more_often(client: TestClient) -> None:
    without = _lessons_in_preferred_type(client, with_preference=False)
    with_wish = _lessons_in_preferred_type(client, with_preference=True)

    assert with_wish > without


def test_room_preference_yields_rather_than_making_a_week_impossible(
    client: TestClient,
) -> None:
    """Soft means soft.

    Three simultaneous lessons prefer the one room that can hold only one of
    them. A hard rule would make the week infeasible; the wish must instead be
    paid for and the other two placed elsewhere.
    """
    payload = _sample_payload()
    subject_id = payload["requirements"][0]["subjectId"]  # type: ignore[index]
    teacher_a, teacher_b, teacher_c = str(uuid4()), str(uuid4()), str(uuid4())
    groups = [str(uuid4()) for _ in range(3)]

    payload["requirements"] = [
        {
            "id": str(uuid4()),
            "subjectId": subject_id,
            "studentGroupId": group,
            "teacherId": teacher,
            "lessonsPerWeek": 5,
            "minutesPerLesson": 60,
            "studentGroupSize": 20,
        }
        for group, teacher in zip(groups, [teacher_a, teacher_b, teacher_c])
    ]

    preferred_id = str(uuid4())
    payload["rooms"] = [
        {"id": preferred_id, "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
        {"id": str(uuid4()), "capacity": 30},
    ]
    payload["roomPreferences"] = [
        {
            "id": str(uuid4()),
            "subjectId": subject_id,
            "roomIds": [preferred_id],
            "weight": 1000,
        }
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    # All 15 lessons scheduled — the wish bent, the week did not break.
    assert len(body["lessons"]) == 15


def test_a_preference_for_another_subject_does_not_move_this_one(
    client: TestClient,
) -> None:
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["lessonsPerWeek"] = 1  # type: ignore[index]

    preferred_id = str(uuid4())
    payload["rooms"] = [
        {"id": payload["rooms"][0]["id"], "capacity": 30},  # type: ignore[index]
        {"id": preferred_id, "capacity": 30},
    ]
    payload["roomPreferences"] = [
        {
            "id": str(uuid4()),
            "subjectId": str(uuid4()),  # some other subject
            "roomIds": [preferred_id],
            "weight": 1000,
        }
    ]

    response = client.post(
        "/api/v1/optimize",
        json=payload,
        headers={"X-API-Key": "test-api-key-000000000000000000000000"},
    )

    assert response.status_code == 200
    # Nothing to satisfy for this subject: the run succeeds and the lesson is
    # placed wherever the other objectives put it.
    assert len(response.json()["lessons"]) == 1


# ---------------------------------------------------------------------------
# The three-sided wire contract, pinned from the engine's side.
#
# CamelModel sets extra="forbid", so a field the gateway sends and these models
# have not heard of is a 422 for the WHOLE optimize request. The mirror of this
# test lives in src/optimization/ai-engine-contract.spec.ts and asserts the same
# names against what the gateway actually emits; either half failing means the
# two sides have parted company. Fix the code, not the list — and change both
# halves in the same commit as the engine deploy, because the engine has to be
# out first for a new field to be accepted at all.
#
# Evidence this drifts unnoticed: ObjectiveWeights carries a room_preference
# weight the gateway has never had a way to send.
# ---------------------------------------------------------------------------


def _field_names(model: type) -> set[str]:
    return {
        field.alias or name for name, field in model.model_fields.items()
    }


def test_the_wire_contract_is_exactly_what_the_gateway_sends() -> None:
    from app.schemas.schedule import (
        AnonymousConstraint,
        AnonymousGroup,
        AnonymousRequirement,
        AnonymousRoomPreference,
        FrameTime,
        LunchPlacement,
        LunchServing,
        OptimizeScheduleRequest,
        Rast,
        ScheduleRules,
    )

    assert _field_names(OptimizeScheduleRequest) == {
        "requestId",
        "academicYearId",
        "requirements",
        "groups",
        "rooms",
        "constraints",
        "frameTimes",
        "lunchServings",
        "lunchPlacements",
        "rasts",
        "roomPreferences",
        "fixedLessons",
        "groupConflicts",
        "previousLessons",
        "weights",
        "rules",
    }
    # A rast, which is the whole declaration: nothing about it is chosen, so
    # unlike a serving it has no solved second half to carry back.
    assert _field_names(Rast) == {
        "minGradeLevel",
        "maxGradeLevel",
        "dayOfWeek",
        "startTime",
        "endTime",
        "requiresLessonBefore",
    }
    # The group's years, so a serving and a frame can reach a MEAL — which has
    # no requirement to read a span off.
    assert _field_names(AnonymousGroup) == {
        "id",
        "lunchHeadcount",
        "minGradeLevel",
        "maxGradeLevel",
    }
    # The room rule's own fields, which neither half of the contract has ever
    # pinned — only the top-level key list. That is how a dead weight fallback
    # sat unnoticed in the objective for months.
    assert _field_names(AnonymousRoomPreference) == {
        "id",
        "subjectId",
        "roomType",
        "roomIds",
        "weight",
        "kind",
        "minGradeLevel",
        "maxGradeLevel",
    }
    # A meal placed by hand is a START and nothing else: the meal's length is
    # the school's one lunchMinutes, and an end here would be a second answer
    # to "how long is lunch".
    assert _field_names(LunchPlacement) == {
        "studentGroupId",
        "dayOfWeek",
        "startTime",
    }
    assert _field_names(LunchServing) == {
        "minGradeLevel",
        "maxGradeLevel",
        "dayOfWeek",
        "startTime",
        "endTime",
        "seats",
    }
    assert _field_names(FrameTime) == {
        "minGradeLevel",
        "maxGradeLevel",
        "dayOfWeek",
        "startTime",
        "endTime",
        "changeoverMinutes",
    }
    assert _field_names(AnonymousRequirement) == {
        "id",
        "subjectId",
        "studentGroupId",
        "teacherId",
        "coTeacherId",
        "lessonsPerWeek",
        "minutesPerLesson",
        "studentGroupSize",
        "minGradeLevel",
        "maxGradeLevel",
        "requiredRoomType",
    }
    assert _field_names(AnonymousConstraint) == {
        "id",
        "resourceKind",
        "resourceId",
        "minGradeLevel",
        "maxGradeLevel",
        "dayOfWeek",
        "date",
        "startTime",
        "endTime",
        "kind",
    }
    assert _field_names(ScheduleRules) == {
        "lunchStartTime",
        "lunchEndTime",
        "lunchMinutes",
        "diningSeats",
        "maxLessonsPerDayPerGroup",
    }


def test_an_all_day_closure_is_scheduled_around_rather_than_refused() -> None:
    """The shapes a school actually writes must not fell the whole request.

    Availability windows are not typed against the solver's grid. This product
    writes a full-day closure as 00:00-23:59 — `isFullDay` in
    calendar.service.ts says so, and its own spec asserts it — and the seed
    ships a teacher rule of 12:00-23:59. Neither lands inside an 08:00-18:00
    day, and strict parsing turned each into a 400 for the ENTIRE optimization:
    one holiday and the school could not generate a timetable at all.

    Folding is what those times mean. "Unavailable until 23:59" is the rest of
    the school day, and the rest of the school day ends when the grid does. The
    assertions below are placements, not statuses, because a fold that quietly
    dropped every constraint would return OPTIMAL just as happily.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(
        _settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1,2"),
    )

    def place(start: str, end: str, kind: str = "TEACHER"):  # noqa: ANN202
        payload = _sample_payload()
        requirement = payload["requirements"][0]  # type: ignore[index]
        requirement["lessonsPerWeek"] = 1  # type: ignore[index]
        payload["constraints"] = [
            {
                "id": str(uuid4()),
                "resourceKind": kind,
                "resourceId": str(
                    requirement["teacherId"]  # type: ignore[index]
                    if kind == "TEACHER"
                    else requirement["studentGroupId"]  # type: ignore[index]
                ),
                "dayOfWeek": 1,
                "date": None,
                "startTime": start,
                "endTime": end,
                "kind": "UNAVAILABLE",
            },
        ]
        response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
        assert response.status in {"OPTIMAL", "FEASIBLE"}, (
            f"{start}-{end} felled the whole request instead of being scheduled around"
        )
        return response.lessons

    # A holiday: the group is closed all of Monday, so Monday is unusable.
    for lesson in place("00:00:00", "23:59:00", "STUDENT_GROUP"):
        assert lesson.day_of_week != 1, "the all-day closure was folded into nothing"

    # The seed's own rule: the teacher is gone from noon, so a Monday lesson
    # must finish before it.
    for lesson in place("12:00:00", "23:59:00"):
        if lesson.day_of_week == 1:
            assert lesson.end_time <= "12:00:00"

    # Exactly the school day. Strict parsing rejected the end time for being one
    # minute past the last representable moment.
    for lesson in place("08:00:00", "18:00:00"):
        assert lesson.day_of_week != 1

    # And a window that misses the school day entirely constrains nothing —
    # clamping it would invent a rule the school never wrote.
    monday = [
        lesson for lesson in place("19:00:00", "20:00:00") if lesson.day_of_week == 1
    ]
    assert monday, "an evening window took Monday away, which nobody asked it to"

# ---------------------------------------------------------------------------
# Ramtider
#
# test_frames.py proves the window arithmetic. These prove the solver actually
# stands on it: that a frame moves where lessons land, that a frame reaching
# nobody moves nothing, and that a frame too tight to hold a lesson comes back
# as a sentence about the frame rather than as "no feasible schedule".
# ---------------------------------------------------------------------------


def _framed_payload(**requirement_overrides: object) -> dict[str, object]:
    """The sample week, but for a year-4 group so a frame can reach it."""
    payload = _sample_payload()
    requirement = payload["requirements"][0]  # type: ignore[index]
    requirement["minGradeLevel"] = 4  # type: ignore[index]
    requirement["maxGradeLevel"] = 4  # type: ignore[index]
    requirement.update(requirement_overrides)  # type: ignore[union-attr]
    return payload


def _lessons(client: TestClient, payload: dict[str, object]) -> list[dict[str, object]]:
    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] in {"OPTIMAL", "FEASIBLE"}
    return body["lessons"]


def test_a_frame_keeps_every_lesson_inside_its_window(client: TestClient) -> None:
    """The window is in the AFTERNOON, and that is the whole point.

    A morning frame proves nothing: the objective already prefers mornings, so
    every lesson lands inside an 08:00-10:00 window whether the frame reached
    the group or not, and the assertion passes over a solver that ignores
    frames entirely. Pushing the window to 14:00-17:00 makes the frame the only
    reason a lesson could be there.
    """
    payload = _framed_payload()
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
            "dayOfWeek": None,
            "startTime": "14:00:00",
            "endTime": "17:00:00",
        },
    ]

    lessons = _lessons(client, payload)

    assert lessons
    for lesson in lessons:
        assert lesson["startTime"] >= "14:00:00"
        assert lesson["endTime"] <= "17:00:00"


def test_a_frame_for_another_stage_leaves_the_day_alone(client: TestClient) -> None:
    """The control for the test above.

    Without it, a solver that simply never placed anything after 10:00 — because
    the objective happens to prefer mornings — would pass that assertion with
    the frame doing nothing at all.
    """
    payload = _framed_payload(lessonsPerWeek=7, minutesPerLesson=60)
    payload["frameTimes"] = [
        {
            "minGradeLevel": 7,
            "maxGradeLevel": 9,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        },
    ]

    lessons = _lessons(client, payload)

    # Seven lessons against a window that holds one a day across five days.
    # At least two MUST land outside it whatever the objective would rather do,
    # so this asserts the frame did not reach a year-4 group rather than
    # asserting the solver's taste in mornings. A count the window could have
    # swallowed would have proved neither.
    assert len(lessons) == 7
    assert any(lesson["endTime"] > "09:00:00" for lesson in lessons)


def test_a_weekday_frame_binds_that_weekday_only(client: TestClient) -> None:
    """Monday is pushed to the afternoon; the rest of the week is not.

    Both halves matter. Monday landing after 15:00 is only explicable by the
    frame, and some other day landing before it is what shows the frame stayed
    on the weekday it named instead of applying to the week.
    """
    payload = _framed_payload(lessonsPerWeek=5, minutesPerLesson=60)
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": 1,
            "startTime": "15:00:00",
            "endTime": "17:00:00",
        },
    ]

    lessons = _lessons(client, payload)

    assert len(lessons) == 5
    monday = [lesson for lesson in lessons if lesson["dayOfWeek"] == 1]
    assert monday, "the week has five lessons and five days; Monday holds one"
    for lesson in monday:
        assert lesson["startTime"] >= "15:00:00"
        assert lesson["endTime"] <= "17:00:00"
    assert any(
        lesson["dayOfWeek"] != 1 and lesson["startTime"] < "15:00:00"
        for lesson in lessons
    )


def test_the_close_holds_against_an_objective_pulling_past_it(client: TestClient) -> None:
    """A previous placement at 14:00 is a reward the frame has to outrank.

    Every other assertion here would survive a solver that read only the OPEN
    edge of the window, because nothing else in this file wants a late slot:
    the objective prefers early, so "not before 14:00" and "inside 14:00-17:00"
    look the same from outside. Handing the solver a previous lesson at 14:00
    and a frame that closes at 12:00 makes the two edges disagree, and only the
    close can decide it.
    """
    payload = _framed_payload()
    requirement_id = payload["requirements"][0]["id"]  # type: ignore[index]
    payload["previousLessons"] = [
        {"requirementId": requirement_id, "dayOfWeek": 1, "startTime": "14:00:00"},
        {"requirementId": requirement_id, "dayOfWeek": 2, "startTime": "14:00:00"},
    ]
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "12:00:00",
        },
    ]

    lessons = _lessons(client, payload)

    assert len(lessons) == 2
    for lesson in lessons:
        assert lesson["endTime"] <= "12:00:00"


def test_a_frame_that_closes_one_day_leaves_the_others(client: TestClient) -> None:
    """Monday is too narrow for a lesson; the week is not, so this is not an error.

    The gate in _validate_request asks whether ANY day still fits the lesson,
    and that "any" is the whole of it: asking whether EVERY day fits would
    refuse this perfectly ordinary request — a school that keeps Monday morning
    for something else — with a message about an impossible timetable.
    """
    payload = _framed_payload(lessonsPerWeek=4, minutesPerLesson=60)
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "08:30:00",
        },
    ]

    lessons = _lessons(client, payload)

    assert len(lessons) == 4
    assert all(lesson["dayOfWeek"] != 1 for lesson in lessons)


def test_a_frame_too_tight_for_the_lesson_is_named(client: TestClient) -> None:
    """A narrowed-to-nothing domain is INFEASIBLE with nothing to blame.

    CP-SAT has no variable left to point at, so the school would be told its
    timetable is impossible and not which sentence made it so. The gate in
    _validate_request turns that into a 4xx naming the requirement, the window
    that remains and the length that will not fit.
    """
    payload = _framed_payload(minutesPerLesson=90)
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        },
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    detail = response.json()["message"]
    assert "The frame times" in detail
    assert "90-minute" in detail
    assert "60 minutes" in detail


def test_a_frame_that_closes_every_day_is_named_too(client: TestClient) -> None:
    payload = _framed_payload()
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": None,
            "startTime": "19:00:00",
            "endTime": "20:00:00",
        },
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    assert "the widest any day still offers is 0 minutes" in response.json()["message"]


def test_an_inverted_frame_is_refused_by_the_schema(client: TestClient) -> None:
    payload = _framed_payload()
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
            "dayOfWeek": None,
            "startTime": "15:00:00",
            "endTime": "08:00:00",
        },
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 422, response.text


def test_a_payload_with_no_frames_behaves_as_it_always_did(client: TestClient) -> None:
    """The field is optional, and absent must mean the whole day."""
    payload = _framed_payload()
    assert "frameTimes" not in payload

    assert len(_lessons(client, payload)) == 2

# ---------------------------------------------------------------------------
# Sittningarna — the lunch the solver already decided
#
# _solved_spans above reads `lunchstart_<group>_<day>` off the solved proto
# because, as its docstring says, "the chosen lunch start exists nowhere
# outside the model". These assert that it now does, and — the part that is
# easy to get wrong — that the time returned belongs to the build that won.
# ---------------------------------------------------------------------------


def _lunch_payload(**over: object) -> dict[str, object]:
    payload = _sample_payload()
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "13:00:00",
        "lunchMinutes": 30,
    }
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
    payload["groups"] = [{"id": group_id, "lunchHeadcount": 24}]
    payload.update(over)
    return payload


def test_the_response_says_when_each_group_eats(client: TestClient) -> None:
    payload = _lunch_payload()

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text
    lunches = response.json()["lunches"]
    # One sitting per group per teaching day, not one per lesson.
    assert len(lunches) == 5
    assert {lunch["dayOfWeek"] for lunch in lunches} == {1, 2, 3, 4, 5}
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
    for lunch in lunches:
        assert lunch["studentGroupId"] == group_id
        assert lunch["startTime"] >= "11:00:00"
        assert lunch["endTime"] <= "13:00:00"
        assert lunch["endTime"] > lunch["startTime"]


def test_a_sitting_is_exactly_the_configured_length(client: TestClient) -> None:
    payload = _lunch_payload()
    payload["rules"]["lunchMinutes"] = 45  # type: ignore[index]

    lunches = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()["lunches"]

    for lunch in lunches:
        start = _minutes(lunch["startTime"])
        assert _minutes(lunch["endTime"]) - start == 45


def test_a_school_with_no_lunch_rule_gets_no_sittings(client: TestClient) -> None:
    """Absent, not a list of nulls — the field must not invent a meal."""
    payload = _sample_payload()

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    assert body["lunches"] == []


def test_the_sitting_returned_is_the_one_the_lessons_were_solved_with() -> None:
    """The map must come from the build that won, not from a shared one.

    solve() runs four models: the full one, an objective-free twin, a cleared
    Clone of the full one, and the assumptions rebuild. Only the Clone shares
    variable indices with its original. Reading a phase-1a win off the FULL
    build's map would return a number — a plausible, wrong number — from a model
    that was never solved, and large schools take exactly that path.

    Asserted by consistency rather than by which phase ran: whatever comes back,
    no lesson of a group may overlap that group's own returned sitting. A time
    read off the wrong build has no reason to satisfy that.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _lunch_payload()
    payload["requirements"][0]["lessonsPerWeek"] = 20  # type: ignore[index]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert response.lunches

    by_day: dict[int, list[tuple[int, int]]] = {}
    for lesson in response.lessons:
        by_day.setdefault(lesson.day_of_week, []).append(
            (_minutes(lesson.start_time), _minutes(lesson.end_time)),
        )
    for lunch in response.lunches:
        start, end = _minutes(lunch.start_time), _minutes(lunch.end_time)
        for lesson_start, lesson_end in by_day.get(lunch.day_of_week, []):
            assert lesson_end <= start or lesson_start >= end, (
                f"lesson {lesson_start}-{lesson_end} overlaps the returned "
                f"sitting {start}-{end} on day {lunch.day_of_week}"
            )


def _minutes(clock: str) -> int:
    hours, minutes, _seconds = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def test_the_two_builds_agree_on_lunch_variable_indices() -> None:
    """Why passing the wrong build's map is harmless today — and a tripwire.

    solve() reads the winning build's lunch map, which is correct. This pins the
    reason a mistake there would currently go unnoticed: the full build and its
    objective-free twin give the lunch variables identical indices, because
    _build_model appends the objective's auxiliaries last. If that stops being
    true this test fails, and whoever is standing there learns that the
    per-build wiring in solve() is now load-bearing rather than tidy.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    request = OptimizeScheduleRequest.model_validate(_lunch_payload())
    solver = SchedulerSolver(_settings())

    full_model, _, _, _, lunch_full = solver._build_model(
        request, use_assumptions=False, include_objective=True,
    )
    feas_model, _, _, _, lunch_feas = solver._build_model(
        request, use_assumptions=False, include_objective=False,
    )

    assert set(lunch_full) == set(lunch_feas)
    assert {key: var.Index() for key, var in lunch_full.items()} == {
        key: var.Index() for key, var in lunch_feas.items()
    }
    # And the builds really are different models, so the agreement above is a
    # property worth pinning rather than a tautology.
    assert len(full_model.Proto().variables) > len(feas_model.Proto().variables)


# ---------------------------------------------------------------------------
# Lunch mot tillgänglighet
#
# The lunch interval had never seen an AvailabilityConstraint: availability is
# applied before the lunch variable exists and only ever touched lesson
# decisions. So an hour a school emptied pushed the LESSONS away and then
# received the class for lunch instead — and since no objective term mentions
# lunch, the emptied hour was the widest free region it could occupy.
# ---------------------------------------------------------------------------


def _closes(group_id: str, day: int, start: str, end: str) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": "STUDENT_GROUP",
        "resourceId": group_id,
        "dayOfWeek": day,
        "date": None,
        "startTime": start,
        "endTime": end,
        "kind": "UNAVAILABLE",
    }


def _group_of(payload: dict[str, object]) -> str:
    return payload["requirements"][0]["studentGroupId"]  # type: ignore[index,return-value]


def _monday_lunch(body: dict[str, object]) -> list[str]:
    return [
        lunch["startTime"]
        for lunch in body["lunches"]  # type: ignore[index]
        if lunch["dayOfWeek"] == 1
    ]


def test_a_reservation_moves_the_sitting_off_itself(client: TestClient) -> None:
    payload = _lunch_payload()
    payload["constraints"] = [_closes(_group_of(payload), 1, "11:00:00", "12:00:00")]

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    # The window is 11:00-13:00 and the first hour is closed, so the only
    # admissible starts are 12:00 onwards. Before this the answer was 11:00.
    assert _monday_lunch(body) == ["12:00:00"]
    # ...and the other days are untouched: the rule named one weekday.
    assert len(body["lunches"]) == 5


def test_a_reservation_for_another_group_leaves_the_sitting_alone(
    client: TestClient,
) -> None:
    payload = _lunch_payload()
    payload["constraints"] = [
        _closes(str(uuid4()), 1, "11:00:00", "12:00:00"),
    ]

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    assert _monday_lunch(body) == ["11:00:00"]


def test_a_rule_about_a_group_that_never_eats_refuses_nothing(
    client: TestClient,
) -> None:
    """A teaching group's own reservation must not refuse the school's week.

    The builder only reads closures for groups that actually get a lunch, so a
    stray key there is inert. _validate_request does not — it walks the whole
    map — so without the membership test it would raise a 400 naming a group
    that eats with its home class and has no sitting of its own. Scraps rather
    than a whole-window block on purpose: a whole block is the exempt path and
    would pass either way.
    """
    payload = _lunch_payload()
    payload["rules"]["lunchEndTime"] = "12:00:00"  # type: ignore[index]
    payload["constraints"] = [_closes(str(uuid4()), 1, "11:15:00", "11:45:00")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text
    assert _monday_lunch(response.json()) == ["11:00:00"]


def test_a_wish_is_not_a_closure(client: TestClient) -> None:
    """PREFERRED_FREE is a preference the solver trades off, not a statement.

    Treating one as a closure would silently move a meal a school only nudged —
    the same distinction the publish path draws when it honours UNAVAILABLE
    alone.
    """
    payload = _lunch_payload()
    payload["constraints"] = [
        {**_closes(_group_of(payload), 1, "11:00:00", "12:00:00"), "kind": "PREFERRED_FREE"},
    ]

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    assert _monday_lunch(body) == ["11:00:00"]


def test_a_dated_reservation_does_not_reach_the_weekly_sitting(
    client: TestClient,
) -> None:
    # The model is one generic week with nowhere to put a single date, which is
    # exactly how _add_availability_constraints treats a dated row.
    payload = _lunch_payload()
    payload["constraints"] = [
        {**_closes(_group_of(payload), 1, "11:00:00", "12:00:00"), "date": "2027-03-01"},
    ]

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    assert _monday_lunch(body) == ["11:00:00"]


def test_a_class_that_is_not_in_school_that_day_is_not_owed_a_lunch(
    client: TestClient,
) -> None:
    """The praktik case, and the reason this is not simply a refusal.

    "7A undervisas inte på tisdagar" has no other way to be written than a rule
    covering the whole day, and the same row blocks that day's lessons too.
    Answering a correct statement with "no timetable exists" would be an error
    nobody can act on — so the day is exempt: no sitting, and no chairs booked
    either, which is more accurate than the standing "every home class eats
    every school day" simplification.
    """
    payload = _lunch_payload()
    payload["constraints"] = [_closes(_group_of(payload), 1, "08:00:00", "17:45:00")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert _monday_lunch(body) == []
    # The rest of the week still eats — the exemption is per day, not per group.
    assert {lunch["dayOfWeek"] for lunch in body["lunches"]} == {2, 3, 4, 5}


def _validator_problems(payload: dict[str, object]) -> list[str]:
    """The independent checker's verdict on a week that fills the lunch window.

    `benchmarks/validate_schedule.py` re-derives every rule from the request
    and shares no code with the model builders, which is the whole of why its
    verdict is evidence — and why a rule it does not model is a false alarm
    waiting for a payload to write one.

    The timetable is built by hand rather than solved for, because no solve
    produces it. The engine keeps a class's lessons out of the class's own
    reserved window, and reserves nothing at all for a group it was never told
    about, so both false alarms below reach the lunch check with an empty
    window and pass on correctness borrowed from another rule. Put two lessons
    in that window — as an engine that dropped availability would, or as a week
    from somewhere else might, since `validate` is a library — and the check
    has to answer for itself.
    """
    import sys
    from pathlib import Path

    from app.schemas.schedule import OptimizeScheduleRequest, ScheduledLesson
    from app.solver.scheduler_solver import SchedulerSolver

    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    # Monday 11:00-13:00 is the entire lunch window, and this class fills it.
    lessons = [
        ScheduledLesson.model_validate(
            {
                "requirementId": payload["requirements"][0]["id"],  # type: ignore[index]
                "roomId": payload["rooms"][0]["id"],  # type: ignore[index]
                "dayOfWeek": 1,
                "startTime": start,
                "endTime": end,
            },
        )
        for start, end in (("11:00:00", "12:00:00"), ("12:00:00", "13:00:00"))
    ]
    grid = SchedulerSolver(_settings())._grid
    return validate(grid, OptimizeScheduleRequest.model_validate(payload), lessons)


def test_the_validator_owes_no_lunch_to_a_class_the_school_marked_away() -> None:
    """The praktik rule again, on the other side of the seam.

    A recurring rule covering the whole lunch window is the school saying the
    class is not in the building, and the engine answers by building no
    sitting and booking no chair. No payload in the repo writes such a row
    today (`solve_2000_students.py` emits TEACHER rows only), so the guard
    belongs here rather than in the benchmark.
    """
    payload = _lunch_payload()
    unexcused = _validator_problems(payload)
    assert len(unexcused) == 1, unexcused
    assert "no free 30-minute window" in unexcused[0]

    payload["constraints"] = [_closes(_group_of(payload), 1, "08:00:00", "17:45:00")]
    excused = _validator_problems(payload)
    # The reservation is still enforced against the lessons. The exemption
    # silences the break the class was not owed, not the fault that put two
    # lessons inside a window the school had closed.
    assert len(excused) == 2, excused
    assert all("overlaps UNAVAILABLE window" in problem for problem in excused), excused


def test_the_validator_reads_the_rows_it_used_to_skip() -> None:
    """A rule the checker cannot read is a rule nobody is checking.

    The availability loop parsed constraint times with `parse_hhmmss`, which is
    strict on purpose — it is right for the times an administrator types into a
    lesson. Availability windows are not those times: a school writes them in
    whole days, and this product's own full-day closure is 00:00-23:59. Every
    one of them raised, the loop moved on, and the rule went unchecked. In a
    checker that failure is invisible by construction: a skipped rule and a
    kept one both come out as silence, and silence is read as a pass.

    Three rows the loop dropped, each of which the engine enforces. The lessons
    sit at 11:00-13:00 on Monday, so a row that reaches them has something to
    say and a row that is skipped says nothing.
    """
    payload = _lunch_payload()
    group_id = _group_of(payload)
    payload["groups"] = []  # lunch is not what is under test here

    # Away all day, in the notation the product itself writes.
    payload["constraints"] = [_closes(group_id, 1, "00:00:00", "23:59:00")]
    all_day = _validator_problems(payload)
    assert len(all_day) == 2, all_day
    assert all("00:00:00-23:59:00" in problem for problem in all_day), all_day

    # No weekday at all: the row names every teaching day, Monday among them.
    every_day = dict(_closes(group_id, 1, "10:00:00", "14:00:00"), dayOfWeek=None)
    assert len(_validator_problems({**payload, "constraints": [every_day]})) == 2

    # A year reservation names no resource, and fell out of the ownership
    # lookup with an empty tuple — matched against nothing, ever.
    payload["requirements"][0]["minGradeLevel"] = 6  # type: ignore[index]
    payload["requirements"][0]["maxGradeLevel"] = 7  # type: ignore[index]
    stage = {
        **_closes(group_id, 1, "10:00:00", "14:00:00"),
        "resourceKind": "GRADE_LEVEL",
        "resourceId": None,
        "minGradeLevel": 4,
        "maxGradeLevel": 6,  # overlaps 6-7 on year 6 alone, which is enough
    }
    reserved = _validator_problems({**payload, "constraints": [stage]})
    assert len(reserved) == 2, reserved
    # Named by its span: "GRADE_LEVEL None" tells a school nothing.
    assert all("GRADE_LEVEL years 4-6" in problem for problem in reserved), reserved


def test_the_validator_leaves_alone_the_rows_that_reach_nothing() -> None:
    """The other half: reading more rows must not mean inventing violations.

    Each row below is one the engine builds nothing from, so a complaint about
    any of them would be this file's own invention rather than the model's
    fault — the failure that matters most in a checker whose whole value is
    that its verdict can be trusted without reading it.
    """
    payload = _lunch_payload()
    group_id = _group_of(payload)
    payload["groups"] = []
    payload["requirements"][0]["minGradeLevel"] = 6  # type: ignore[index]
    payload["requirements"][0]["maxGradeLevel"] = 7  # type: ignore[index]

    rows = {
        # Wholly outside the school day: folded, it closes nothing.
        "evening": _closes(group_id, 1, "19:00:00", "20:00:00"),
        # A single date, which a generic week has nowhere to put.
        "dated": {**_closes(group_id, 1, "10:00:00", "14:00:00"), "date": "2027-03-01"},
        # A wish, not a rule.
        "wish": {
            **_closes(group_id, 1, "10:00:00", "14:00:00"),
            "kind": "PREFERRED_FREE",
        },
        # A weekday outside the configured week.
        "saturday": _closes(group_id, 6, "10:00:00", "14:00:00"),
        # Years 1-3 do not reach a group spanning 6-7.
        "other stage": {
            **_closes(group_id, 1, "10:00:00", "14:00:00"),
            "resourceKind": "GRADE_LEVEL",
            "resourceId": None,
            "minGradeLevel": 1,
            "maxGradeLevel": 3,
        },
    }
    for name, row in rows.items():
        assert _validator_problems({**payload, "constraints": [row]}) == [], name


def test_the_validator_owes_no_lunch_to_a_group_the_request_never_seats() -> None:
    """Who eats is the payload's `groups`, not everyone holding a requirement.

    A teaching group's pupils eat with their home class, so the engine reserves
    a meal for exactly the groups it was sent and the shim that once unioned in
    every group with a requirement is gone. Demanded off the requirements
    instead, this check asks for a window the model was never asked to leave —
    and it did: against the 400-student benchmark, which sent a lunch window
    and no groups at all, it reported 69 violations for a timetable that was
    right, and the gate could not say which of the two was wrong.

    A payload naming nobody is a payload saying nobody eats. Silence is the
    verdict the model would give, so it is the verdict here.
    """
    payload = _lunch_payload()
    payload["groups"] = []

    assert _validator_problems(payload) == []


def test_a_reservation_leaving_only_scraps_is_refused_by_name(
    client: TestClient,
) -> None:
    """The other half of the same rule, and the one that must stay loud.

    Fragments too short for the break mean the class IS in school and busy, and
    the school has asked for something impossible. Left to CP-SAT this is an
    empty variable domain — a proof of infeasibility reachable without touching
    one assumption literal, which returns an empty core and takes every other
    cause in the payload down with it.
    """
    payload = _lunch_payload()
    payload["rules"]["lunchEndTime"] = "12:00:00"  # type: ignore[index]
    # 11:00-11:15 and 11:45-12:00 survive; neither holds thirty minutes.
    payload["constraints"] = [_closes(_group_of(payload), 1, "11:15:00", "11:45:00")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "availability constraint" in message
    assert "30-minute lunch break" in message
    # An instruction, not just a verdict: three things the school could change.
    assert "Shorten the constraint" in message


def test_a_locked_lesson_and_a_reservation_that_only_together_leave_nothing(
    client: TestClient,
) -> None:
    """Each subtraction leaves room; their intersection does not.

    Neither single-cause loop says a word about this, which is why the pair is
    checked on its own.
    """
    payload = _lunch_payload()
    payload["rules"]["lunchEndTime"] = "12:00:00"  # type: ignore[index]
    group_id = _group_of(payload)
    payload["constraints"] = [_closes(group_id, 1, "11:00:00", "11:30:00")]
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "teacherId": None,
            "coTeacherId": None,
            "studentGroupId": group_id,
            "roomId": None,
            "dayOfWeek": 1,
            "startTime": "11:30:00",
            "endTime": "12:00:00",
        },
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    assert "Together" in response.json()["message"]


# ---------------------------------------------------------------------------
# Lunchflödet
#
# test_servings.py owns the window rule. These prove the flow a school actually
# operates: stages eating in the order the school wrote, a stage bigger than the
# hall split into waves by the solver, and the two ways a declaration can be
# impossible answered by name rather than as "no timetable exists".
# ---------------------------------------------------------------------------


def _school(stages: list[tuple[int, int, int]], **rules: object) -> dict[str, object]:
    """A school of `stages`, each (minYear, maxYear, classes) with 30 pupils."""
    groups: list[dict[str, object]] = []
    requirements: list[dict[str, object]] = []
    for min_year, max_year, classes in stages:
        for _ in range(classes):
            group_id = str(uuid4())
            groups.append(
                {
                    "id": group_id,
                    "lunchHeadcount": 30,
                    "minGradeLevel": min_year,
                    "maxGradeLevel": max_year,
                },
            )
            requirements.append(
                {
                    "id": str(uuid4()),
                    "subjectId": str(uuid4()),
                    "studentGroupId": group_id,
                    "teacherId": str(uuid4()),
                    "lessonsPerWeek": 3,
                    "minutesPerLesson": 60,
                    "studentGroupSize": 30,
                },
            )
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": groups,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in requirements],
        "constraints": [],
        "rules": {
            "lunchStartTime": "10:30:00",
            "lunchEndTime": "13:30:00",
            "lunchMinutes": 30,
            **rules,
        },
    }


def _sitting(min_year: int, max_year: int, start: str, end: str, **extra: object) -> dict:
    return {
        "minGradeLevel": min_year,
        "maxGradeLevel": max_year,
        "dayOfWeek": None,
        "startTime": f"{start}:00",
        "endTime": f"{end}:00",
        **extra,
    }


def _spans_of(payload: dict[str, object]) -> dict[str, tuple[int, int]]:
    return {
        group["id"]: (group["minGradeLevel"], group["maxGradeLevel"])  # type: ignore[index]
        for group in payload["groups"]  # type: ignore[union-attr]
    }


def test_the_stages_eat_in_the_order_the_school_wrote(client: TestClient) -> None:
    payload = _school([(0, 3, 1), (4, 6, 1), (7, 9, 1)], diningSeats=60)
    payload["lunchServings"] = [
        _sitting(0, 3, "11:00", "11:40"),
        _sitting(4, 6, "11:40", "12:20"),
        _sitting(7, 9, "12:20", "13:00"),
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text
    spans = _spans_of(payload)
    for lunch in response.json()["lunches"]:
        low, high = spans[lunch["studentGroupId"]]
        window = {(0, 3): ("11:00", "11:40"), (4, 6): ("11:40", "12:20"), (7, 9): ("12:20", "13:00")}[
            (low, high)
        ]
        assert lunch["startTime"] >= f"{window[0]}:00"
        assert lunch["endTime"] <= f"{window[1]}:00"


def test_a_stage_bigger_than_the_hall_is_split_into_waves(client: TestClient) -> None:
    """The user's own requirement: the system splits, the school does not.

    Four classes of thirty against sixty seats cannot all sit at once, and the
    school declared ONE window. The solver has to produce two waves inside it.
    """
    payload = _school([(4, 6, 4)], diningSeats=60)
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "12:30")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text
    monday = [
        lunch for lunch in response.json()["lunches"] if lunch["dayOfWeek"] == 1
    ]
    assert len(monday) == 4
    # At least two distinct sitting times, and nobody outside the window.
    assert len({lunch["startTime"] for lunch in monday}) >= 2
    for lunch in monday:
        assert lunch["startTime"] >= "11:00:00"
        assert lunch["endTime"] <= "12:30:00"


def test_a_sitting_too_short_for_the_meal_is_named(client: TestClient) -> None:
    payload = _school([(4, 6, 1)])
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "11:20")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "No lunch sitting leaves student group" in message
    assert "30-minute meal" in message


def test_a_sitting_too_small_for_the_stage_is_named(client: TestClient) -> None:
    """Wide enough for ONE meal, far too small for the stage's headcount.

    This failure lands in the seat cumulative — an INFEASIBLE with no assumption
    to name, on a payload whose windows all look reasonable. The bound is
    student-minutes, which is the cumulative's own relaxation, so refusing here
    can never refuse a flow that would have worked.
    """
    payload = _school([(4, 6, 4)], diningSeats=60)
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "11:30")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "cannot feed 120 students" in message
    assert "60 seats" in message
    # Three things the school could change, not just a verdict.
    assert "split the stage across two sittings" in message


def test_a_group_with_a_choice_of_sittings_is_not_charged_to_both(
    client: TestClient,
) -> None:
    """Overlapping windows are how a school copes, not a reason to refuse.

    Each sitting alone looks too small for the whole stage; together they are
    ample. Charging a group that could attend either to both would refuse the
    arrangement that works.
    """
    payload = _school([(4, 6, 4)], diningSeats=60)
    payload["lunchServings"] = [
        _sitting(4, 6, "11:00", "11:30"),
        _sitting(4, 6, "11:30", "12:00"),
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text


def test_a_frame_narrows_a_sitting_that_reaches_past_the_stage_s_day(
    client: TestClient,
) -> None:
    """Two declarations meet, and the narrower one wins.

    A serving PERMITS and a frame BOUNDS. A hall open to åk 4-6 until 13:00 and
    a stage whose day ends at 12:00 is a school that has said two things; the
    meal has to sit inside both.
    """
    payload = _school([(4, 6, 1)])
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "13:00")]
    payload["frameTimes"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "12:00:00",
        },
    ]
    # The locked morning is what makes this a discriminator rather than a
    # coincidence. The sitting alone would still allow 12:00-12:30, so a solver
    # that ignored the frame would answer OPTIMAL and place the meal after the
    # stage's day has ended. Asserting a time instead would prove nothing: with
    # no objective term on lunch, 11:00 comes back either way.
    group_id = payload["groups"][0]["id"]  # type: ignore[index]
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "teacherId": None,
            "coTeacherId": None,
            "studentGroupId": group_id,
            "roomId": None,
            "dayOfWeek": 1,
            "startTime": "11:00:00",
            "endTime": "12:00:00",
        },
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "locked lessons" in message
    assert "the declared lunch sittings" in message


def test_a_sitting_may_carry_its_own_seat_count(client: TestClient) -> None:
    """One serving line closed, without restating the hall's own size.

    Charged against LunchSettings.diningSeats instead, this school looks ample:
    120 students, 120 chairs. The sitting's own thirty is what makes it
    impossible, and only reading `seats` can see that.
    """
    payload = _school([(4, 6, 4)], diningSeats=120)
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "11:30", seats=30)]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    assert "30 seats" in response.json()["message"]


def test_a_sitting_without_its_own_seats_uses_the_hall_s(client: TestClient) -> None:
    # The control: the same school, the same window, no per-sitting number.
    payload = _school([(4, 6, 4)], diningSeats=120)
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "11:30")]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200, response.text


def test_a_school_with_no_sittings_keeps_the_whole_lunch_window(
    client: TestClient,
) -> None:
    payload = _school([(4, 6, 1)])
    assert "lunchServings" not in payload

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    assert len(body["lunches"]) == 5
    for lunch in body["lunches"]:
        assert lunch["startTime"] >= "10:30:00"
        assert lunch["endTime"] <= "13:30:00"


def test_a_group_eats_at_the_same_time_every_day_when_it_can() -> None:
    """Nothing mentioned lunch_start in the objective, so it wandered.

    The five objective families all take `decisions`; the meal was placed
    wherever propagation happened to leave it, and two runs of one payload could
    answer differently. That was invisible while the value was thrown away and
    is the first thing a school notices once it is drawn on a grid.

    THE WEEK HAS TO BE BUSY, and this is the whole difficulty of testing it.
    Measured on a sparse fixture the starts collapse onto one time with or
    without the term, because propagation has nothing to push against — the
    first version of this test passed with the objective disconnected. Fourteen
    sixty-minute lessons against a 10:30-13:30 window is where the difference
    appears: without the term the same group eats at 10:30, 11:00 and 12:00 in
    one week.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    group_id = str(uuid4())
    payload = _sample_payload()
    payload["requirements"] = [
        {
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": group_id,
            "teacherId": str(uuid4()),
            "lessonsPerWeek": count,
            "minutesPerLesson": 60,
            "studentGroupSize": 24,
        }
        for count in (8, 6)
    ]
    payload["groups"] = [{"id": group_id, "lunchHeadcount": 24}]
    payload["rooms"] = [{"id": str(uuid4()), "capacity": 30} for _ in range(3)]
    payload["rules"] = {
        "lunchStartTime": "10:30:00",
        "lunchEndTime": "13:30:00",
        "lunchMinutes": 30,
    }

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    times = {lunch.start_time for lunch in response.lunches}
    assert len(response.lunches) == 5
    assert len(times) == 1, (
        f"the group eats at {sorted(times)} — a meal that moves between days is "
        f"what the drift term exists to stop"
    )


def test_a_day_that_cannot_hold_the_usual_time_moves_rather_than_failing() -> None:
    """The drift term is a preference and must never behave like a rule.

    A locked lesson over Monday's usual slot makes that time impossible, not
    merely expensive, so this pins that the term yields — the week is still
    solved and Monday simply eats later. It does NOT pin the weight's
    magnitude: no weight can override a hard constraint, so a mutation raising
    the number would pass here. What keeps the number honest is that it is the
    lowest in config.py and says so.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _school([(4, 6, 1)])
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:30:00",
        "lunchMinutes": 30,
    }
    group_id = payload["groups"][0]["id"]  # type: ignore[index]
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "teacherId": None,
            "coTeacherId": None,
            "studentGroupId": group_id,
            "roomId": None,
            "dayOfWeek": 1,
            "startTime": "11:00:00",
            "endTime": "12:00:00",
        },
    ]

    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    monday = next(lunch for lunch in response.lunches if lunch.day_of_week == 1)
    assert monday.start_time >= "12:00:00"


# ---------------------------------------------------------------------------
# Rumsklasserna och årskursen
# ---------------------------------------------------------------------------


def test_a_stage_limited_room_never_takes_a_lesson_from_another_stage() -> None:
    """The leak the profile key exists to close.

    build_room_classes stands ONE representative requirement in for its whole
    profile, and it keyed that profile on (required type, group size) under a
    comment asserting eligibility depended on nothing else. It stopped being
    true the day rooms gained their own stage limits: two requirements of equal
    size and different years collapsed a years-7-9 room and an open room into a
    single class, and åk-4 lessons landed in the high-school room.

    THE ORDER OF THE REQUIREMENTS IS THE WHOLE TEST. Listed with the year-4
    requirement first it passes even with the bug, because the year-4 profile
    becomes the representative and correctly refuses the room. Listing the
    year-7-9 requirement first is what made 19 of 20 lessons leak in one run and
    8 in the next — and that order-dependence is why a school could meet this
    and not reproduce it.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    subject = str(uuid4())
    young, old = str(uuid4()), str(uuid4())
    open_room, senior_room = str(uuid4()), str(uuid4())

    def requirement(group_id: str, low: int, high: int) -> dict[str, object]:
        return {
            "id": str(uuid4()),
            "subjectId": subject,
            "studentGroupId": group_id,
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 20,
            "minutesPerLesson": 60,
            "studentGroupSize": 24,
            "minGradeLevel": low,
            "maxGradeLevel": high,
        }

    payload = _sample_payload()
    # The high-school requirement FIRST, so it becomes the representative.
    payload["requirements"] = [requirement(old, 7, 9), requirement(young, 4, 4)]
    payload["groups"] = [
        {"id": old, "lunchHeadcount": 24},
        {"id": young, "lunchHeadcount": 24},
    ]
    payload["rooms"] = [
        {"id": open_room, "capacity": 30},
        {"id": senior_room, "capacity": 30, "minGradeLevel": 7, "maxGradeLevel": 9},
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    span_of = {
        str(r.id): (r.min_grade_level, r.max_grade_level) for r in request.requirements
    }
    trespassing = [
        lesson
        for lesson in response.lessons
        if str(lesson.room_id) == senior_room
        and span_of[str(lesson.requirement_id)] == (4, 4)
    ]
    assert trespassing == [], (
        f"{len(trespassing)} year-4 lessons were placed in a room the school "
        f"reserved for years 7-9"
    )


def test_the_profile_key_names_every_field_the_predicate_reads() -> None:
    """A tripwire for the next term added to _room_allowed.

    The leak above was not a typo — it was a term added to the predicate and
    not to the key, two files apart. Reading them as text is the only check
    that notices, so it is written down rather than trusted to review.
    """
    import inspect

    from app.solver.scheduler_solver import SchedulerSolver

    predicate = inspect.getsource(SchedulerSolver._room_allowed)
    key = inspect.getsource(SchedulerSolver._room_profile_key)

    for field in ("student_group_size", "required_room_type"):
        assert field in predicate and field in key, f"{field} is in one and not the other"
    # _grade_allowed is the indirection that hid the leak: the predicate calls
    # it, so the key must carry the fields IT reads.
    assert "_grade_allowed" in predicate
    assert "min_grade_level" in key and "max_grade_level" in key


# ---------------------------------------------------------------------------
# Salsregler per årskurs — önskan
# ---------------------------------------------------------------------------


def _room_rule_payload(**over: object) -> tuple[dict[str, object], dict[str, str]]:
    """One subject, two stages, two rooms — the smallest school that can show it."""
    subject = str(uuid4())
    young, old = str(uuid4()), str(uuid4())
    wanted_room, other_room = str(uuid4()), str(uuid4())

    def requirement(group_id: str, low: int, high: int) -> dict[str, object]:
        return {
            "id": str(uuid4()),
            "subjectId": subject,
            "studentGroupId": group_id,
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 5,
            "minutesPerLesson": 60,
            "studentGroupSize": 24,
            "minGradeLevel": low,
            "maxGradeLevel": high,
        }

    payload = _sample_payload()
    payload["requirements"] = [requirement(young, 4, 4), requirement(old, 7, 9)]
    payload["groups"] = [
        {"id": young, "lunchHeadcount": 24},
        {"id": old, "lunchHeadcount": 24},
    ]
    payload["rooms"] = [
        {"id": wanted_room, "capacity": 30},
        {"id": other_room, "capacity": 30},
    ]
    payload.update(over)
    names = {
        "subject": subject,
        "wanted": wanted_room,
        "other": other_room,
        "young": young,
        "old": old,
    }
    return payload, names


def _rule(names: dict[str, str], **over: object) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "subjectId": names["subject"],
        "roomType": None,
        "roomIds": [names["wanted"]],
        "weight": 500,
        **over,
    }


def _rooms_by_span(response, request) -> dict[tuple, set[str]]:  # noqa: ANN001
    span_of = {
        str(r.id): (r.min_grade_level, r.max_grade_level) for r in request.requirements
    }
    out: dict[tuple, set[str]] = {}
    for lesson in response.lessons:
        out.setdefault(span_of[str(lesson.requirement_id)], set()).add(str(lesson.room_id))
    return out


def test_a_wish_without_a_span_still_reaches_every_year(client: TestClient) -> None:
    """The behaviour every existing row has, unchanged.

    A rule written before the span column existed carries null on both bounds,
    and null must keep meaning "every year" or this migration would move
    timetables nobody edited.
    """
    payload, names = _room_rule_payload()
    payload["roomPreferences"] = [_rule(names)]

    body = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    ).json()

    rooms = {lesson["roomId"] for lesson in body["lessons"]}
    assert rooms == {names["wanted"]}, "both stages should have been pulled in"


def test_a_wish_scoped_to_a_stage_leaves_the_other_alone(client: TestClient) -> None:
    """The whole point: a rule that minds its own business.

    Weight 500 against a school with room to spare makes the wish decisive, so
    what the year-7-9 lessons do is evidence about the SCOPE rather than about
    how hard the solver tried.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["roomPreferences"] = [_rule(names, minGradeLevel=4, maxGradeLevel=4)]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    by_span = _rooms_by_span(response, request)
    assert by_span[(4, 4)] == {names["wanted"]}
    # The other stage is free of it. With ten lessons and two rooms the spread
    # and gap objectives have no reason to crowd them into the wanted one.
    assert names["other"] in by_span[(7, 9)]


def test_a_wish_does_not_reach_a_group_only_half_inside_its_span(
    client: TestClient,
) -> None:
    """Containment, and the case that separates it from overlap.

    A rule for åk 7-9 overlaps a teaching group spanning 6-7 at year 7 — a real
    shape, since spans come from members' home classes. Under overlap the rule
    would apply and send the group's year-6 pupils wherever it points.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["requirements"][1]["minGradeLevel"] = 6  # type: ignore[index]
    payload["requirements"][1]["maxGradeLevel"] = 7  # type: ignore[index]
    payload["roomPreferences"] = [_rule(names, minGradeLevel=7, maxGradeLevel=9)]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    by_span = _rooms_by_span(response, request)
    assert names["other"] in by_span[(6, 7)], (
        "a 6-7 group was pulled into a rule written for years 7-9"
    )


def test_a_wish_says_nothing_about_a_group_with_unknown_years(
    client: TestClient,
) -> None:
    # There is nothing to contain, and guessing would sweep every unlabelled
    # group into a rule meant for one stage.
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["requirements"][1]["minGradeLevel"] = None  # type: ignore[index]
    payload["requirements"][1]["maxGradeLevel"] = None  # type: ignore[index]
    payload["roomPreferences"] = [_rule(names, minGradeLevel=0, maxGradeLevel=12)]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    by_span = _rooms_by_span(response, request)
    assert names["other"] in by_span[(None, None)]


def _terms_for(payload: dict[str, object], objective_only_wishes: bool) -> list:  # noqa: ANN401
    """Objective terms, with the PLAN always built from every rule.

    Eligibility and price are two different questions and the lock touches both,
    so a test that varies the rule list varies the partition too and can no
    longer see which one moved. The plan is therefore built once from the whole
    rule set, and only the list handed to the objective changes.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings())
    model = cp_model.CpModel()
    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), [], [],
    )
    plan = solver._add_room_allocation(
        model, decisions, request.rooms, [], [], request.room_preferences,
    )
    offered = (
        [p for p in request.room_preferences if p.kind == "WISH"]
        if objective_only_wishes
        else request.room_preferences
    )
    return solver._add_room_preference_objective(
        model, decisions, request.rooms, plan, offered, solver._resolve_weights(request),
    )


def test_a_lock_never_appears_as_a_price() -> None:
    """A LOCK restricts; it must not also be paid for.

    Paying for a room the lesson cannot reach anyway is a constant — it inflates
    the objective and steers nothing. Asserted on the objective terms, because
    the lock IS enforced now and the lessons land in the named room either way,
    so no behavioural test can tell a price from a bound.

    A WISH RIDES ALONG ON PURPOSE. Two filters keep a lock out of the objective
    — one on the bucket, one on the class signature — and with a lock alone they
    mask each other: without the signature bit the rooms share a class, the term
    becomes a constant, and dropping the bucket filter changes nothing. The wish
    splits the partition, so the lock's own term would appear if it were ever
    bucketed.
    """
    payload, names = _room_rule_payload()
    payload["roomPreferences"] = [
        _rule(names, roomIds=[names["other"]]),
        _rule(names, kind="LOCK", roomIds=[names["wanted"]], minGradeLevel=4, maxGradeLevel=4),
    ]

    assert _terms_for(payload, objective_only_wishes=True), (
        "the wish must produce a price at all, or this asserts nothing"
    )
    assert len(_terms_for(payload, objective_only_wishes=False)) == len(
        _terms_for(payload, objective_only_wishes=True),
    ), "the lock added a penalty term of its own"


# ---------------------------------------------------------------------------
# Salsregler per årskurs — låset
# ---------------------------------------------------------------------------


def test_a_lock_puts_a_stage_in_its_room_and_leaves_the_others(
    client: TestClient,
) -> None:
    """The user's first example: matte, Optimisten 4, åk 4.

    A WISH PULLS THE OTHER WAY, and that is what makes this a test. With two
    rooms and nothing else to separate them, a solver that ignored the lock
    entirely would still be free to put year 4 in the locked room, and the
    assertion would pass over a lock doing nothing. A heavy wish for the OTHER
    room removes that: the only reason to stay is that nowhere else is allowed.

    It also pins the relationship between the two kinds — a lock is a bound and
    a wish is a price, so no weight can buy its way past one.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", minGradeLevel=4, maxGradeLevel=4),
        _rule(names, roomIds=[names["other"]], weight=1000),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    by_span = _rooms_by_span(response, request)
    assert by_span[(4, 4)] == {names["wanted"]}, (
        "the wish bought its way past the lock"
    )
    # The stage the lock says nothing about follows the wish, which is the
    # control: it proves the wish was strong enough to move anything at all.
    assert by_span[(7, 9)] == {names["other"]}


def test_a_locked_requirement_never_shares_a_room_class_with_an_unlocked_one(
    client: TestClient,
) -> None:
    """The stage-limit bug, one dimension over — and locks are a second chance.

    build_room_classes stands ONE representative requirement in for its whole
    profile. A lock changes eligibility, so a profile key that omits it collapses
    a locked and an unlocked requirement into one class and the locked lesson
    lands wherever the class allows.

    TWO SUBJECTS, ONE SPAN, and that is the whole construction. A lock is keyed
    on subject and span, so two requirements sharing both share their lock and
    can never differ; differing by SPAN would be caught by the key's existing
    year fields and prove nothing new. Different subjects with identical
    (type, size, span) are the one shape whose eligibility differs while every
    pre-existing key field agrees.

    The unlocked requirement is listed first so it becomes the representative
    and its permissive eligibility is the one the signature is computed from.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    free_subject, locked_subject = str(uuid4()), str(uuid4())
    only_room, other_room = str(uuid4()), str(uuid4())

    def requirement(subject_id: str) -> dict[str, object]:
        return {
            "id": str(uuid4()),
            "subjectId": subject_id,
            "studentGroupId": str(uuid4()),
            "teacherId": str(uuid4()),
            "lessonsPerWeek": 10,
            "minutesPerLesson": 60,
            "studentGroupSize": 24,
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
        }

    payload = _sample_payload()
    payload["requirements"] = [requirement(free_subject), requirement(locked_subject)]
    payload["groups"] = [
        {"id": r["studentGroupId"], "lunchHeadcount": 24}  # type: ignore[index]
        for r in payload["requirements"]  # type: ignore[union-attr]
    ]
    payload["rooms"] = [
        {"id": only_room, "capacity": 30},
        {"id": other_room, "capacity": 30},
    ]
    payload["roomPreferences"] = [
        {
            "id": str(uuid4()),
            "subjectId": locked_subject,
            "kind": "LOCK",
            "roomType": None,
            "roomIds": [only_room],
            "weight": 5,
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
        },
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=20.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    subject_of = {str(r.id): str(r.subject_id) for r in request.requirements}
    trespassing = [
        lesson
        for lesson in response.lessons
        if subject_of[str(lesson.requirement_id)] == locked_subject
        and str(lesson.room_id) != only_room
    ]
    assert trespassing == [], (
        f"{len(trespassing)} locked lessons escaped their room through a class "
        f"they shared with an unlocked requirement"
    )


def test_a_lock_with_no_span_loses_every_tie_to_one_that_has_a_span() -> None:
    """A rule about every year is the widest thing there is.

    It reaches everything, so treating it as narrow would make it win every
    specificity contest — and a school's one general rule would then override
    every exception it had carefully written.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver, resolve_room_locks

    payload, names = _room_rule_payload()
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", roomIds=[names["other"]]),  # no span at all
        _rule(names, kind="LOCK", roomIds=[names["wanted"]], minGradeLevel=4, maxGradeLevel=4),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    locked = resolve_room_locks(
        request.requirements, request.room_preferences, request.rooms,
    )
    year_four = next(r for r in request.requirements if r.min_grade_level == 4)
    assert locked[year_four.id] == frozenset({UUID(names["wanted"])})


def test_a_wish_never_restricts_where_a_lesson_may_go() -> None:
    """The two kinds must not converge.

    A wish naming a room too small for the group is an aspiration the solver
    ignores; the same rule as a LOCK is a week that cannot be scheduled. If the
    resolver stopped filtering on kind, every wish a school has ever written
    would become a restriction — silently, on the next run.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["rooms"] = [
        {"id": names["wanted"], "capacity": 10},  # too small for anyone
        {"id": names["other"], "capacity": 30},
    ]
    payload["roomPreferences"] = [
        _rule(names, minGradeLevel=4, maxGradeLevel=4),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    by_span = _rooms_by_span(response, request)
    assert by_span[(4, 4)] == {names["other"]}


def test_a_lock_may_name_several_rooms(client: TestClient) -> None:
    """The second example: matte, Optimisten 4 AND Bryggan 3, åk 5.

    Named rooms are alternatives, not a sequence — the engine has no way to say
    "Optimisten first, Bryggan as a fallback", and the flat set is what the
    school's own checkbox list already produces.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    third = str(uuid4())
    payload["rooms"].append({"id": third, "capacity": 30})  # type: ignore[union-attr]
    payload["requirements"][0]["minGradeLevel"] = 5  # type: ignore[index]
    payload["requirements"][0]["maxGradeLevel"] = 5  # type: ignore[index]
    payload["roomPreferences"] = [
        _rule(
            names,
            kind="LOCK",
            roomIds=[names["wanted"], names["other"]],
            minGradeLevel=5,
            maxGradeLevel=5,
        ),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    by_span = _rooms_by_span(response, request)
    assert by_span[(5, 5)] <= {names["wanted"], names["other"]}
    assert third not in by_span[(5, 5)]


def test_a_lock_may_name_a_room_type(client: TestClient) -> None:
    """Room types too, which the user asked for after the design was written.

    _preference_room_ids already expanded a type for the wish, so the lock
    inherits it: the type is resolved to its rooms once, in the same place, and
    a type that gains a room later simply widens the lock.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    lab = str(uuid4())
    payload["rooms"] = [
        {"id": names["wanted"], "capacity": 30, "type": lab},
        {"id": names["other"], "capacity": 30},
    ]
    payload["roomPreferences"] = [
        {
            "id": str(uuid4()),
            "subjectId": names["subject"],
            "kind": "LOCK",
            "roomType": lab,
            "roomIds": [],
            "weight": 5,
            "minGradeLevel": 4,
            "maxGradeLevel": 4,
        },
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    by_span = _rooms_by_span(response, request)
    assert by_span[(4, 4)] == {names["wanted"]}


def test_the_narrowest_lock_wins_rather_than_emptying_the_set(
    client: TestClient,
) -> None:
    """Two sentences a school would reasonably write, and the reading that works.

    "Matte åk 4-6 -> Bryggan 3" plus "matte åk 4 -> Optimisten 4" intersects to
    NOTHING, and a whole subject x stage becomes unschedulable. Under
    specificity the second sentence is an exception to the first, which is what
    a school means by writing it.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    payload["requirements"][1]["minGradeLevel"] = 5  # type: ignore[index]
    payload["requirements"][1]["maxGradeLevel"] = 5  # type: ignore[index]
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", roomIds=[names["other"]], minGradeLevel=4, maxGradeLevel=6),
        _rule(names, kind="LOCK", roomIds=[names["wanted"]], minGradeLevel=4, maxGradeLevel=4),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    by_span = _rooms_by_span(response, request)
    # Year 4 takes the exception; year 5 is only reached by the broad rule.
    assert by_span[(4, 4)] == {names["wanted"]}
    assert by_span[(5, 5)] == {names["other"]}


def test_two_equally_narrow_locks_are_alternatives(client: TestClient) -> None:
    # Duplicate rows are harmless — a strict improvement over a duplicate WISH,
    # which silently doubles the strength the admin set on the slider.
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload, names = _room_rule_payload()
    third = str(uuid4())
    payload["rooms"].append({"id": third, "capacity": 30})  # type: ignore[union-attr]
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", roomIds=[names["wanted"]], minGradeLevel=4, maxGradeLevel=4),
        _rule(names, kind="LOCK", roomIds=[names["other"]], minGradeLevel=4, maxGradeLevel=4),
    ]

    request = OptimizeScheduleRequest.model_validate(payload)
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=15.0)).solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    by_span = _rooms_by_span(response, request)
    assert by_span[(4, 4)] <= {names["wanted"], names["other"]}
    assert third not in by_span[(4, 4)]


def test_a_lock_naming_a_room_too_small_is_refused_by_name(client: TestClient) -> None:
    """The refusal must not send the school to the wrong screen.

    "No room satisfies capacity/type/years" points at the room list; this school
    wrote the offending rule somewhere else entirely and would change the wrong
    thing.
    """
    payload, names = _room_rule_payload()
    payload["rooms"] = [
        {"id": names["wanted"], "capacity": 10},
        {"id": names["other"], "capacity": 30},
    ]
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", minGradeLevel=4, maxGradeLevel=4),
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "A room lock leaves requirement" in message
    assert "Widen the lock" in message


def test_locks_that_cannot_hold_a_week_are_refused_by_volume(
    client: TestClient,
) -> None:
    """Every lesson can have a room and the week still not fit.

    Left to CP-SAT this is an INFEASIBLE whose core names room capacity, which
    sends a school to the seat counts for a rule it wrote elsewhere.
    """
    payload, names = _room_rule_payload()
    # Forty 90-minute lessons for one stage against a single room: 3600
    # minutes a week against the 3000 one room offers in a 08-18 week.
    payload["requirements"][0]["lessonsPerWeek"] = 40  # type: ignore[index]
    payload["requirements"][0]["minutesPerLesson"] = 90  # type: ignore[index]
    payload["roomPreferences"] = [
        _rule(names, kind="LOCK", minGradeLevel=4, maxGradeLevel=4),
    ]

    response = client.post(
        "/api/v1/optimize", json=payload, headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    message = response.json()["message"]
    assert "Room locks put" in message
    assert "minutes a week" in message


# ---------------------------------------------------------------------------
# Raster, end to end: the minutes a stage declared free stay free.
# ---------------------------------------------------------------------------


def _rast_payload(
    rasts: list[dict[str, object]],
    *,
    lessons_per_week: int = 4,
    minutes_per_lesson: int = 60,
) -> dict[str, object]:
    """One class, one teacher, one room, a frame that leaves a short day.

    The day is deliberately narrow — 08:00-12:00 — because a rast has to be
    provably binding: on a ten-hour day a solver would avoid 09:40-10:00 by
    accident often enough that a passing test would prove nothing.
    """
    requirement_id = str(uuid4())
    group_id = str(uuid4())
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": requirement_id,
                "subjectId": str(uuid4()),
                "studentGroupId": group_id,
                "teacherId": str(uuid4()),
                "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": minutes_per_lesson,
                "studentGroupSize": 24,
                "minGradeLevel": 4,
                "maxGradeLevel": 6,
            }
        ],
        "groups": [
            {"id": group_id, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
        "frameTimes": [
            {
                "minGradeLevel": 0,
                "maxGradeLevel": 12,
                "dayOfWeek": None,
                "startTime": "08:00:00",
                "endTime": "12:00:00",
            },
        ],
        "rasts": rasts,
    }


def _rast(
    start: str,
    end: str,
    day: int | None = None,
    *,
    asks: bool = False,
    grades: tuple[int, int] = (4, 6),
) -> dict[str, object]:
    return {
        "minGradeLevel": grades[0],
        "maxGradeLevel": grades[1],
        "dayOfWeek": day,
        "startTime": f"{start}:00",
        "endTime": f"{end}:00",
        "requiresLessonBefore": asks,
    }


def test_the_rast_is_cut_out_of_the_start_domain() -> None:
    """The discriminating test, asserted on the MODEL rather than an answer.

    A solved week cannot prove this. With five days and four lessons the solver
    avoids a twenty-minute rast most of the time by accident, so an end-to-end
    assertion passes whether or not the constraint is there — which is exactly
    what happened: removing the subtraction left every end-to-end test green.

    The domain is where the rule lives, so the domain is what is asserted. A
    sixty-minute lesson may not START in [09:00, 09:55] on any day: 09:00 is the
    first start that would still be running at 09:40, and 09:55 the last that
    begins before 10:00.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(
        _rast_payload([_rast("09:40", "10:00")]),
    )
    model = cp_model.CpModel()

    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts,
    )

    grid = solver._grid
    forbidden = {
        day * grid.slots_per_day + slot
        for day in range(len(grid.schedule_days))
        for slot in range((9 * 60 - 480) // 5, (9 * 60 + 60 - 480) // 5)
    }
    allowed = {
        value
        for decision in decisions
        for value in decision.start.proto.domain
    }
    assert decisions
    for decision in decisions:
        values = cp_model.Domain.from_flat_intervals(
            list(decision.start.proto.domain),
        )
        for slot in sorted(forbidden):
            assert not values.contains(slot), (
                f"slot {slot} would put a 60-minute lesson across the rast"
            )
        # And the day is not emptied: the starts outside the rast survive.
        assert values.contains(0), "08:00 must still be a legal start"
    assert allowed


def test_no_lesson_is_placed_across_a_declared_rast() -> None:
    """The same rule, seen from the answer rather than the model.

    Weaker than the domain assertion above — with five days the solver often
    avoids the rast by accident — and kept because it exercises the whole path
    from payload to placement, which the domain test does not.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(
        _rast_payload([_rast("09:40", "10:00")]),
    )

    response = solver.solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert response.lessons
    for lesson in response.lessons:
        start = int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5])
        end = int(lesson.end_time[:2]) * 60 + int(lesson.end_time[3:5])
        assert not (start < 10 * 60 and 9 * 60 + 40 < end), (
            f"{lesson.day_of_week} {lesson.start_time}-{lesson.end_time} "
            f"runs across the 09:40-10:00 rast"
        )


def test_a_rast_that_leaves_no_room_is_refused_by_name() -> None:
    """An empty domain, caught before CP-SAT can reach it with no core.

    A start domain narrowed to nothing is a proof CP-SAT finds without touching
    an assumption literal, and an empty conflict core erases every other cause in
    the payload — the school is handed INSUFFICIENT_RESOURCES for a sentence it
    wrote itself. So the message names the years, the requirement and the
    longest unbroken stretch that is left.
    """
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    # 08:00-12:00 chopped into three fragments, the longest of which is 100
    # minutes, against a lesson that needs 120.
    request = OptimizeScheduleRequest.model_validate(
        _rast_payload(
            [_rast("09:40", "10:00"), _rast("11:00", "11:20")],
            lessons_per_week=1,
            minutes_per_lesson=120,
        ),
    )

    with pytest.raises(InvalidScheduleInputError) as error:
        solver.solve(request)

    message = str(error.value)
    assert "rasts leave no room for requirement" in message
    assert "100 minutes" in message


def test_the_longest_stretch_is_measured_unbroken_not_summed() -> None:
    """Total free time is not the question a lesson asks.

    Two rasts leave 100 + 60 + 40 free minutes here. Summed, that is room for a
    two-hour lesson; unbroken, the longest is 100 and there is not. Measuring the
    total would accept a day of ten five-minute gaps as room for an hour.
    """
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(
        _rast_payload(
            [_rast("09:40", "10:00"), _rast("11:00", "11:20")],
            lessons_per_week=1,
            minutes_per_lesson=105,
        ),
    )

    with pytest.raises(InvalidScheduleInputError):
        solver.solve(request)


def test_a_rast_leaves_the_meal_alone() -> None:
    """A lunchrast IS a rast, and the engine must not push the meal out of one.

    A school that writes "lunchrast 11:00-12:00" and lets the engine seat its
    classes inside it is describing the ordinary case. Subtracting the rast from
    the MEAL's domain the way it is subtracted from a lesson's would move the
    meal out of exactly the window that was reserved for it, and then refuse the
    run when nowhere else was left.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _rast_payload([_rast("11:00", "12:00")], lessons_per_week=2)
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:00:00",
        "lunchMinutes": 30,
    }
    request = OptimizeScheduleRequest.model_validate(payload)

    response = solver.solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert response.lunches, "the meal must still be placed inside the lunchrast"
    for lunch in response.lunches:
        assert lunch.start_time >= "11:00:00"
        assert lunch.end_time <= "12:00:00"


# ---------------------------------------------------------------------------
# "Minst en lektion före rasten": a class still at school after a rast was
# taught before it.
#
# A rast has otherwise only been a hole in the day. Nothing stopped a class's
# Monday from opening with the morning break, or its whole afternoon from
# being empty — measured before the rule was written, about one class-day
# stretch in five came out that way, and at twenty-four classes EVERY
# afternoon stretch did once a morning lesson satisfied the afternoon's rast.
#
# ASSERTED AS INFEASIBLE-VERSUS-FEASIBLE wherever it can be, not on a returned
# week, for the reason test_the_rast_is_cut_out_of_the_start_domain gives about
# its own rule: a solved week is compatible with the rule being absent. A week
# that solves with the flag off and is refused with it on can only be the flag.
# ---------------------------------------------------------------------------

MONDAY = {"SCHEDULE_DAYS": "1"}


def _ordering_payload(
    rasts: list[dict[str, object]],
    *,
    lessons_per_week: int = 1,
    minutes_per_lesson: int = 60,
    frame_end: str = "12:00:00",
    closed: list[tuple[str, str]] | None = None,
) -> dict[str, object]:
    """A rast payload on a day of the caller's length, with a window shut.

    `closed` reserves the class's own time, which is how a lesson is pushed
    to the far side of a rast: the frame and the timplan alone leave the
    solver free to put the week wherever it likes, and a rule about ORDER
    cannot be read off a week that had no order forced on it.
    """
    payload = _rast_payload(
        rasts, lessons_per_week=lessons_per_week, minutes_per_lesson=minutes_per_lesson,
    )
    payload["frameTimes"][0]["endTime"] = frame_end  # type: ignore[index]
    payload["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": "STUDENT_GROUP",
            "resourceId": payload["groups"][0]["id"],  # type: ignore[index]
            "kind": "UNAVAILABLE",
            "dayOfWeek": None,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
        }
        for start, end in closed or []
    ]
    return payload


def _solve(payload: dict[str, object], **settings: object):  # type: ignore[no-untyped-def]
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(**{**MONDAY, **settings}))
    return solver.solve(OptimizeScheduleRequest.model_validate(payload))


def _refusal(payload: dict[str, object], **settings: object):  # type: ignore[no-untyped-def]
    """Solve, expecting the named 400 rather than a verdict."""
    from app.exceptions import InvalidScheduleInputError

    with pytest.raises(InvalidScheduleInputError) as raised:
        _solve(payload, **settings)
    return raised.value


def test_a_break_the_meal_leaves_no_room_before_is_refused_by_name() -> None:
    """The timeout a school reported, and the sentence it should have read.

    An 11:00-12:30 lunch window with a 60-minute meal frees the class at 12:00
    at the earliest, and a break at 12:30 asking for a lesson between them is
    asking a 60-minute lesson to fit in thirty minutes. The engine used to
    build the demand anyway: every flag was unsatisfiable, so the only way left
    to satisfy the clause was for the class to have gone home, and the rule
    quietly became "empty the afternoon". The week that was left was over
    capacity, infeasible, and past the reach of any counting argument in the
    model — sixty seconds of silence and a TIMEOUT naming nothing.

    The arithmetic is on four constants, so it is answered before the solve.
    """
    payload = _rast_payload(
        [_rast("12:30", "12:45", asks=True)],
        lessons_per_week=4,
    )
    payload["frameTimes"][0]["endTime"] = "14:00:00"  # type: ignore[index]
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:30:00",
        "lunchMinutes": 60,
    }

    refusal = _refusal(payload)

    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"
    # The numbers a rektor acts on: half an hour between the meal's earliest
    # end and the break, against a lesson that needs an hour.
    assert refusal.params["remaining"] == 30
    assert refusal.params["minutes"] == 60
    assert refusal.params["bound"] == "lunch"


def test_the_same_break_is_fine_once_the_meal_is_short_enough() -> None:
    """The control, and it is the whole reason the refusal is not "no rast
    may sit after a lunch window".

    Thirty minutes of meal frees the class at 11:30, which leaves an hour
    before the same break — room for the same lesson. Nothing is refused and
    the rule still binds.
    """
    payload = _rast_payload(
        [_rast("12:30", "12:45", asks=True)],
        lessons_per_week=4,
    )
    payload["frameTimes"][0]["endTime"] = "14:00:00"  # type: ignore[index]
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:30:00",
        "lunchMinutes": 30,
    }

    assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


def _reserved_payload(
    *, lessons_per_week: int, kind: str = "STUDENT_GROUP", date: str | None = None,
) -> dict[str, object]:
    """A class whose stretch before the 11:10 break is reserved away entirely.

    Two breaks and a reservation over the whole of the second stretch: the
    calendar shows fifty roomy minutes between 10:20 and 11:10, and the school
    has already given every one of them away. This is the shape the payloads
    that survived the first fix all had.
    """
    payload = _rast_payload(
        [_rast("10:00", "10:20"), _rast("10:00", "10:20")],
        lessons_per_week=lessons_per_week,
        minutes_per_lesson=40,
    )
    payload["rasts"] = [
        _rast("10:00", "10:20"),
        _rast("11:10", "11:30", asks=True),
    ]
    payload["frameTimes"][0]["endTime"] = "16:00:00"  # type: ignore[index]
    requirement = payload["requirements"][0]
    payload["constraints"] = [
        {
            "id": str(uuid4()),
            "resourceKind": kind,
            "resourceId": (
                payload["groups"][0]["id"]  # type: ignore[index]
                if kind == "STUDENT_GROUP"
                else requirement["teacherId"]  # type: ignore[index]
                if kind == "TEACHER"
                else payload["rooms"][0]["id"]  # type: ignore[index]
            ),
            "kind": "UNAVAILABLE",
            "dayOfWeek": None,
            "date": date,
            "startTime": "10:20:00",
            "endTime": "11:10:00",
        },
    ]
    return payload


def test_a_reservation_over_the_stretch_closes_the_day_and_can_refuse_the_week() -> None:
    """The timeout that survived measuring the stretch from the calendar.

    Fifty minutes between the breaks, every one of them reserved. No lesson can
    ever sit there, so the class can never be at school after 11:30 — and its
    mornings hold three forty-minute lessons a day against sixteen a week. A
    shortfall of one lesson, and the proof is a pigeonhole across five separate
    days that CP-SAT's encoding never assembles: sixty seconds of silence
    before this, refused in milliseconds after.
    """
    refusal = _refusal(_reserved_payload(lessons_per_week=16), SCHEDULE_DAYS="1,2,3,4,5")

    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"
    assert refusal.params["bound"] == "closed"
    assert refusal.params["remaining"] == 0
    assert refusal.params["demandMinutes"] > refusal.params["capacityMinutes"]


def test_the_same_reservation_on_a_week_that_still_fits_is_not_refused() -> None:
    """The other half of the rule, and the half that makes it sound.

    A stretch that can hold nothing does not make a week impossible: the demand
    is satisfied just as well by a class that has GONE HOME before the break.
    The first version of this refused on the closure alone and turned down
    weeks that had a timetable — measured on this very payload, which solves
    with every lesson in the morning.
    """
    response = _solve(_reserved_payload(lessons_per_week=6), SCHEDULE_DAYS="1,2,3,4,5")

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert response.lessons
    assert all(lesson.end_time <= "10:00:00" for lesson in response.lessons), (
        "the closed afternoon is the rule working, not the rule refusing"
    )


def test_a_dated_reservation_is_not_counted_against_the_stretch() -> None:
    """The sharpest way this could refuse a week that has a timetable.

    _add_availability_constraints skips a dated row — the engine places a
    generic week and a single date is not part of one — so a stretch measured
    as if the row applied would refuse a payload the solver would place without
    complaint. Same sixteen lessons as the refused case, and it must solve.
    """
    response = _solve(
        _reserved_payload(lessons_per_week=16, date="2026-09-14"),
        SCHEDULE_DAYS="1,2,3,4,5",
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}


def test_a_room_reservation_is_not_counted_against_the_stretch() -> None:
    """A room row blocks the lessons assigned to that room, and no others.

    Which room a lesson takes is a decision the solver has not made when this
    arithmetic runs, so a class is stuck only when NO eligible room is free —
    not a fact about one row. Counted here it would close a stretch the class
    can use, and refuse a week that has a timetable.
    """
    # Asserted as "not refused" rather than "solved": a room row still closes
    # the day inside the model, and the week that is left is over capacity and
    # beyond the reach of any counting argument the engine can make from
    # constants. That week still times out, and saying so here is the honest
    # boundary of this change.
    response = _solve(
        _reserved_payload(lessons_per_week=16, kind="ROOM"), SCHEDULE_DAYS="1,2,3,4,5",
    )

    assert response.status != "REFUSED"


def test_a_reservation_on_one_teacher_leaves_the_stretch_open_to_the_others() -> None:
    """The demand is for A lesson, not a particular one.

    The maths teacher is away over the whole stretch; the music teacher is not,
    and one music lesson answers the break for the whole class. Measured
    against the shortest lesson of the class alone, this closes a day that is
    plainly open.
    """
    payload = _reserved_payload(lessons_per_week=8, kind="TEACHER")
    music = dict(payload["requirements"][0])  # type: ignore[index]
    music["id"] = str(uuid4())
    music["subjectId"] = str(uuid4())
    music["teacherId"] = str(uuid4())
    payload["requirements"].append(music)  # type: ignore[union-attr]

    response = _solve(payload, SCHEDULE_DAYS="1,2,3,4,5")

    assert response.status in {"OPTIMAL", "FEASIBLE"}


def test_a_stretch_only_a_locked_lesson_fits_is_not_refused() -> None:
    """The refusal asks whether a lesson CAN be there, not whether one can be placed.

    The stretch is thirty minutes and the class's placeable lessons are sixty,
    so the arithmetic alone says nothing fits and the payload would be refused.
    But the school has already hand-placed a thirty-minute lesson into exactly
    those minutes: the class is taught before the break, the demand is met, and
    a refusal here would be the engine turning down a week that works.
    """
    payload = _ordering_payload(
        [_rast("08:30", "08:50", asks=True)], closed=[("08:50", "10:00")],
    )
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "studentGroupId": payload["groups"][0]["id"],  # type: ignore[index]
            "teacherId": str(uuid4()),
            "roomId": payload["rooms"][0]["id"],  # type: ignore[index]
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "08:30:00",
        },
    ]

    assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


def test_a_late_sitting_moves_the_break_the_meal_leaves_room_before() -> None:
    """The window is not the whole story; the stage's own sitting is.

    The school-wide window opens 11:00, so a 30-minute meal looks like it frees
    the class at 11:30 and leaves an hour before a 12:30 break. This stage eats
    in the second sitting, 12:00-12:30, so it is free at 12:30 and has nothing
    before the break at all. Read off the window alone, the demand is built
    against flags no meal can satisfy and the afternoon quietly disappears.
    """
    payload = _rast_payload([_rast("12:30", "12:45", asks=True)], lessons_per_week=4)
    payload["frameTimes"][0]["endTime"] = "14:00:00"  # type: ignore[index]
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:30:00",
        "lunchMinutes": 30,
    }
    payload["lunchServings"] = [
        {
            "minGradeLevel": 4,
            "maxGradeLevel": 6,
            "dayOfWeek": None,
            "startTime": "12:00:00",
            "endTime": "12:30:00",
        },
    ]

    # And it is NOT refused, because the class can simply go home at 12:30:
    # four sixty-minute lessons and a thirty-minute meal fit in 08:00-12:30
    # exactly. A break may close a class's afternoon without closing its week,
    # and refusing here — which an earlier version of this did — turns down a
    # timetable that exists.
    response = _solve(payload)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert all(lesson.end_time <= "12:00:00" for lesson in response.lessons), (
        "the sitting bars the afternoon, so the week has to fit before it"
    )


def test_a_break_too_soon_after_the_frame_opens_is_refused_by_name() -> None:
    """The frame's opening is where the day's first stretch starts.

    Measured from the grid's 08:00 instead, a break at 09:40 on a day that
    opens 09:20 looked like a hundred roomy minutes; the class had twenty. The
    same collapse follows, by the same route, without a lunch anywhere near it.
    """
    payload = _rast_payload([_rast("09:40", "10:00", asks=True)], lessons_per_week=2)
    payload["frameTimes"][0]["startTime"] = "09:20:00"  # type: ignore[index]

    refusal = _refusal(payload)

    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"
    assert refusal.params["remaining"] == 20
    assert refusal.params["bound"] == "day"


def test_a_lesson_the_school_placed_by_hand_is_a_lesson() -> None:
    """A locked lesson in the stretch has already answered the demand.

    Without this the engine reads a school that hand-placed 08:00-09:00 as a
    class with nothing before its 09:40 break: it demands another lesson in a
    stretch the lock has filled, finds none, and concludes the class went home
    — deleting the rest of that day and every day like it. Measured on one
    class with three locked mornings: OPTIMAL in half a second without the
    rule, sixty seconds of silence with it.
    """
    payload = _rast_payload([_rast("09:40", "10:00", asks=True)], lessons_per_week=1)
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "studentGroupId": payload["groups"][0]["id"],  # type: ignore[index]
            "teacherId": payload["requirements"][0]["teacherId"],  # type: ignore[index]
            "roomId": payload["rooms"][0]["id"],  # type: ignore[index]
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        },
    ]

    response = _solve(payload)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    # And the placed lesson is free to sit AFTER the break, which is the whole
    # point: the class was taught before it.
    assert response.lessons


def test_a_locked_afternoon_makes_the_demand_unconditional() -> None:
    """The mirror, and the other half of the same hole.

    "Still at school" is read off the lessons the solver places, so a class
    whose only afternoon is hand-placed looked like a class that had gone home
    — and the break's demand was excused by a lesson the school had already
    written down. The class is plainly there at 10:30, so the morning owes a
    lesson, and its one placeable lesson has nowhere else to go but before the
    break.
    """
    payload = _rast_payload([_rast("09:40", "10:00", asks=True)], lessons_per_week=1)
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()),
            "studentGroupId": payload["groups"][0]["id"],  # type: ignore[index]
            "teacherId": str(uuid4()),
            "roomId": payload["rooms"][0]["id"],  # type: ignore[index]
            "dayOfWeek": 1,
            "startTime": "10:30:00",
            "endTime": "11:30:00",
        },
    ]

    response = _solve(payload)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lesson.start_time for lesson in response.lessons] == ["08:00:00"], (
        "the only placeable lesson must land before the break"
    )


def test_a_day_that_replaces_the_asking_break_keeps_its_lessons() -> None:
    """The shadowing bug, end to end and on the schedule itself.

    Monday's 09:40 break asks for a lesson before it. Friday replaces the
    morning with one long rast, so Friday has no 09:40 break and owes it
    nothing — but the demand was read off the every-day row alone, which no
    Friday lesson could satisfy, and the class lost the day. The assertion is
    the Friday column, because that is where the damage was: status stayed
    OPTIMAL throughout.
    """
    payload = _rast_payload(
        [
            _rast("09:40", "10:00", asks=True),
            _rast("08:00", "11:00", day=5),
        ],
        lessons_per_week=8,
        minutes_per_lesson=60,
    )
    payload["frameTimes"][0]["endTime"] = "16:00:00"  # type: ignore[index]

    response = _solve(payload, SCHEDULE_DAYS="1,5")

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert any(lesson.day_of_week == 5 for lesson in response.lessons), (
        "Friday is a teaching day; the break it does not have may not empty it"
    )


# ---------------------------------------------------------------------------
# A lunch the school placed by hand.
# ---------------------------------------------------------------------------


def _placed_payload(
    *pins: str,
    window: tuple[str, str] = ("11:00", "12:00"),
    lessons_per_week: int = 2,
) -> dict[str, object]:
    """One class on a Monday 08:00-14:00, a lunch window, and meals placed by hand."""
    payload = _rast_payload([], lessons_per_week=lessons_per_week)
    payload["frameTimes"][0]["endTime"] = "14:00:00"  # type: ignore[index]
    payload["rules"] = {
        "lunchStartTime": f"{window[0]}:00",
        "lunchEndTime": f"{window[1]}:00",
        "lunchMinutes": 30,
    }
    group = payload["groups"][0]["id"]  # type: ignore[index]
    payload["lunchPlacements"] = [
        {"studentGroupId": group, "dayOfWeek": 1, "startTime": f"{pin}:00"} for pin in pins
    ]
    return payload


def _lock(payload: dict[str, object], start: str, end: str) -> None:
    """A lesson placed by hand for the payload's class, on its Monday."""
    payload.setdefault("fixedLessons", []).append({  # type: ignore[union-attr]
        "id": str(uuid4()),
        "studentGroupId": payload["groups"][0]["id"],  # type: ignore[index]
        "teacherId": str(uuid4()),
        "roomId": payload["rooms"][0]["id"],  # type: ignore[index]
        "dayOfWeek": 1,
        "startTime": f"{start}:00",
        "endTime": f"{end}:00",
    })


def test_a_placed_meal_outside_the_window_is_where_the_class_eats() -> None:
    """The line the whole feature hangs on.

    The lunch variable used to be built on the school window unconditionally,
    so a meal placed at 12:30 against an 11:00-12:00 window was not an
    infeasible model but an invalid one — MODEL_INVALID, raised as a build
    error, a crash. And outside the window is exactly where this school's meal
    has to go: its locked lessons fill the window.
    """
    response = _solve(_placed_payload("12:30"))

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lunch.start_time for lunch in response.lunches] == ["12:30:00"]


def test_a_placed_meal_rescues_a_day_the_locks_left_no_lunch_in() -> None:
    """The school's own case, end to end.

    A lesson locked over the whole 11:00-12:00 window leaves the class no
    thirty-minute lunch start, and the week is refused by name. The school
    places the meal at 12:00, and the same week solves with it there. The skip
    list is what this proves: without it the pin escapes the lock refusal only
    to be refused by the next check for the same class on the same day.
    """
    refused = _placed_payload()
    _lock(refused, "11:00", "12:00")
    assert _refusal(refused).code == "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK"

    rescued = _placed_payload("12:00")
    _lock(rescued, "11:00", "12:00")
    response = _solve(rescued)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lunch.start_time for lunch in response.lunches] == ["12:00:00"]


def test_a_placed_meal_on_a_locked_lesson_is_refused_by_name() -> None:
    """Outside the window, where the lock check used to look at nothing.

    blocked_starts is computed across the lunch window, so a meal placed at
    12:30 on a lesson locked 12:30-13:30 would be checked against no start at
    all — and a pinned day drops the lock narrowing, since the lock reaches the
    meal only through it. Let past, the meal is served in a classroom.
    """
    payload = _placed_payload("12:30")
    _lock(payload, "12:30", "13:30")

    refusal = _refusal(payload)

    assert refusal.code == "LUNCH_PLACEMENT_COLLIDES"
    assert refusal.params["what"] == "locked"


def test_a_placed_meal_on_a_reservation_is_refused_by_name() -> None:
    """The class's own reserved time is a fact the pin does not outrank."""
    payload = _placed_payload("12:30")
    payload["constraints"] = [{
        "id": str(uuid4()),
        "resourceKind": "STUDENT_GROUP",
        "resourceId": payload["groups"][0]["id"],  # type: ignore[index]
        "kind": "UNAVAILABLE",
        "dayOfWeek": 1,
        "startTime": "12:30:00",
        "endTime": "13:00:00",
    }]

    refusal = _refusal(payload)

    assert refusal.code == "LUNCH_PLACEMENT_COLLIDES"
    assert refusal.params["what"] == "closed"


@pytest.mark.parametrize(
    ("start", "why"),
    [
        ("12:07", "off the five-minute grid"),
        ("17:45", "a thirty-minute meal would run past the end of the day"),
    ],
)
def test_a_placed_meal_off_the_grid_is_refused_by_name(start: str, why: str) -> None:
    """Refused as the school's own input, not crashed into as a bad model."""
    refusal = _refusal(_placed_payload(start))

    assert refusal.code == "LUNCH_PLACEMENT_OFF_GRID", why


def test_a_placed_meal_outranks_the_stages_sitting() -> None:
    """Placing a meal by hand is overriding the sitting on purpose.

    Years 4-6 are declared to eat 11:00-11:30, and this class's meal is placed
    at 12:00. Were the sitting still a narrowing of a pinned meal, the two would
    contradict and the week would be refused for a choice the school made.
    """
    payload = _placed_payload("12:00")
    payload["lunchServings"] = [{
        "minGradeLevel": 4, "maxGradeLevel": 6, "dayOfWeek": None,
        "startTime": "11:00:00", "endTime": "11:30:00",
    }]

    response = _solve(payload)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lunch.start_time for lunch in response.lunches] == ["12:00:00"]


def _second_class(payload: dict[str, object], pin: str | None = None) -> str:
    """A second class of twenty-four beside the first, with a room of its own."""
    second = str(uuid4())
    payload["groups"].append(  # type: ignore[union-attr]
        {"id": second, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
    )
    twin = dict(payload["requirements"][0])  # type: ignore[index]
    twin.update({
        "id": str(uuid4()), "subjectId": str(uuid4()), "teacherId": str(uuid4()),
        "studentGroupId": second,
    })
    payload["requirements"].append(twin)  # type: ignore[union-attr]
    payload["rooms"].append({"id": str(uuid4()), "capacity": 30})  # type: ignore[union-attr]
    if pin is not None:
        payload["lunchPlacements"].append(  # type: ignore[union-attr]
            {"studentGroupId": second, "dayOfWeek": 1, "startTime": f"{pin}:00"},
        )
    return second


def test_a_placed_meal_rescues_a_day_the_sitting_left_no_lunch_in() -> None:
    """The sitting refusal skips a pinned day, or the pin cannot outrank it.

    Years 4-6 are declared to eat 13:00-13:30, which the 11:00-12:00 window
    does not reach, so the stage has no admissible start and the week is
    refused by name. The class's meal placed at 12:30 is the school overriding
    that sitting on purpose, and the same week solves.
    """
    def payload(*pins: str) -> dict[str, object]:
        built = _placed_payload(*pins)
        built["lunchServings"] = [{
            "minGradeLevel": 4, "maxGradeLevel": 6, "dayOfWeek": None,
            "startTime": "13:00:00", "endTime": "13:30:00",
        }]
        return built

    assert _refusal(payload()).code == "LUNCH_NO_SERVING_FOR_GROUP"
    response = _solve(payload("12:30"))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lunch.start_time for lunch in response.lunches] == ["12:30:00"]


def test_a_placed_meal_rescues_a_day_a_reservation_left_no_lunch_in() -> None:
    """The reservation refusal and the builder both let a pinned day go.

    A reservation over 11:00-11:45 leaves a thirty-minute meal no start in an
    11:00-12:00 window. Placed at 12:30 — clear of the reservation — the meal
    rescues the day; were the reservation still a narrowing of a pinned meal,
    the model would be infeasible for a choice that breaks nothing.
    """
    def payload(*pins: str) -> dict[str, object]:
        built = _placed_payload(*pins)
        built["constraints"] = [{
            "id": str(uuid4()),
            "resourceKind": "STUDENT_GROUP",
            "resourceId": built["groups"][0]["id"],  # type: ignore[index]
            "kind": "UNAVAILABLE",
            "dayOfWeek": 1,
            "startTime": "11:00:00",
            "endTime": "11:45:00",
        }]
        return built

    assert _refusal(payload()).code == "LUNCH_AVAILABILITY_LEAVES_NO_BREAK"
    response = _solve(payload("12:30"))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert [lunch.start_time for lunch in response.lunches] == ["12:30:00"]


def test_a_placed_meal_on_a_day_the_class_is_not_at_school_is_refused() -> None:
    """A day the school closed for the class has no meal to pin.

    The engine builds no lunch variable for an exempt day, so a meal placed on
    one would vanish without a word. Refused, naming the day.
    """
    payload = _placed_payload("12:30")
    payload["constraints"] = [{
        "id": str(uuid4()),
        "resourceKind": "STUDENT_GROUP",
        "resourceId": payload["groups"][0]["id"],  # type: ignore[index]
        "kind": "UNAVAILABLE",
        "dayOfWeek": 1,
        "startTime": "08:00:00",
        "endTime": "14:00:00",
    }]

    refusal = _refusal(payload)

    assert refusal.code == "LUNCH_PLACEMENT_COLLIDES"
    assert refusal.params["what"] == "day"


def test_a_class_placed_outside_the_sitting_is_not_counted_in_it() -> None:
    """A pinned class eats where it was placed, not in the stage's sitting.

    Two classes of twenty-four, twenty-four seats, and one thirty-minute sitting
    both are captive to: forty-eight children in a room for twenty-four, refused
    by name. With the second class's meal placed at 12:00 the sitting feeds one
    class, which it can, and the week solves.
    """
    def payload(pin: str | None) -> dict[str, object]:
        built = _placed_payload()
        _second_class(built, pin)
        built["rules"]["diningSeats"] = 24  # type: ignore[index]
        built["lunchServings"] = [{
            "minGradeLevel": 4, "maxGradeLevel": 6, "dayOfWeek": None,
            "startTime": "11:00:00", "endTime": "11:30:00",
        }]
        return built

    assert _refusal(payload(None)).code == "LUNCH_SERVING_CANNOT_FEED_STAGE"
    assert _solve(payload("12:00")).status in {"OPTIMAL", "FEASIBLE"}


def test_a_meal_placed_outside_the_window_takes_no_chair_inside_it() -> None:
    """The hall verdict counts only the meals the window has to seat.

    Twenty-four seats over a thirty-minute window can feed one class of
    twenty-four, not two, and that is refused before any solve. A class whose
    meal is placed at 12:00 is not eating in the window at all.
    """
    def payload(pin: str | None) -> dict[str, object]:
        built = _placed_payload(window=("11:00", "11:30"))
        _second_class(built, pin)
        built["rules"]["diningSeats"] = 24  # type: ignore[index]
        return built

    assert _solve(payload(None)).conflicts.summary_code == "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL"
    assert _solve(payload("12:00")).status in {"OPTIMAL", "FEASIBLE"}


def test_each_placed_meal_is_charged_to_the_size_estimate() -> None:
    """One literal per pin, and the estimate says so.

    The estimate is a sum of per-construct upper bounds, and the test that
    compares it with a built model reads the total — which has slack enough
    to hide a missing term. Asserted term by term instead.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(**MONDAY))
    bare = OptimizeScheduleRequest.model_validate(_placed_payload())
    pinned = OptimizeScheduleRequest.model_validate(_placed_payload("12:30"))

    assert solver._estimate_model_size(pinned) - solver._estimate_model_size(bare) == 1


def test_a_placed_meal_still_takes_its_chairs() -> None:
    """A meal the school placed does not make the hall any larger.

    Two classes of twenty-four and twenty-four seats. Placed at the same minute
    they cannot both be seated, and the week is refused; placed half an hour
    apart it is fine. Were a pinned meal left out of the hall, the first would
    solve and the kitchen would be told to seat forty-eight in a room for
    twenty-four.
    """
    def payload(second: str) -> dict[str, object]:
        built = _placed_payload("12:00")
        second_class = str(uuid4())
        built["groups"].append(  # type: ignore[union-attr]
            {"id": second_class, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
        )
        twin = dict(built["requirements"][0])  # type: ignore[index]
        twin.update({
            "id": str(uuid4()), "subjectId": str(uuid4()), "teacherId": str(uuid4()),
            "studentGroupId": second_class,
        })
        built["requirements"].append(twin)  # type: ignore[union-attr]
        built["rooms"].append({"id": str(uuid4()), "capacity": 30})  # type: ignore[union-attr]
        built["rules"]["diningSeats"] = 24  # type: ignore[index]
        built["lunchPlacements"].append(  # type: ignore[union-attr]
            {"studentGroupId": second_class, "dayOfWeek": 1, "startTime": f"{second}:00"},
        )
        return built

    assert _solve(payload("12:30")).status in {"OPTIMAL", "FEASIBLE"}
    refused = _solve(payload("12:00"))
    assert refused.status == "INFEASIBLE"
    # Refused by the lunch stage, which has to carry the pin exactly as the full
    # model does: without it the stage waves the week through, the full model
    # then refuses it with a bare core, and the sentence that says the SCHOOL'S
    # placement is part of why the hall cannot seat them is never written.
    assert refused.conflicts is not None
    codes = {conflict.code for conflict in refused.conflicts.conflicts}
    assert "LUNCH_STARTS_PLACED_BY_HAND" in codes, refused.conflicts


def test_a_week_that_solves_without_the_rule_is_refused_with_it() -> None:
    """The discriminating pair, and the whole rule in two solves.

    The class is free from 10:00 and has one lesson, so its Monday begins at
    10:00 — on the far side of the 09:40 break, with nothing before it. That
    is precisely the day the rule exists to refuse, and with the flag off it
    is an ordinary Monday. Nothing but `requiresLessonBefore` separates them.
    """
    def payload(asks: bool) -> dict[str, object]:
        return _ordering_payload(
            [_rast("09:40", "10:00", asks=asks)], closed=[("08:00", "10:00")],
        )

    assert _solve(payload(asks=False)).status in {"OPTIMAL", "FEASIBLE"}

    # Refused before the solve now, and by name. The reservation that pushes
    # the class past the break takes the whole stretch with it, so no lesson
    # can ever answer the demand, so the class can never be there after it —
    # and its one lesson has nowhere left to go. The arithmetic reaches that in
    # milliseconds; the model used to reach it in a solve, and on a bigger week
    # it did not reach it at all.
    refusal = _refusal(payload(asks=True))
    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"


def test_the_model_refuses_by_name_when_the_arithmetic_cannot() -> None:
    """The core path, and it needs a payload the arithmetic has to let through.

    Every refusal above is settled before the solve, on constants. This one
    cannot be: the stretch is open, nothing is reserved, and whether a class
    can be taught in it depends on who gets the only room — which is the
    solver's decision, not arithmetic. Two classes, one room, one stretch that
    holds a single lesson, and both classes with a lesson stranded after the
    break. One of them must break the rule.

    So the model does the refusing, and the assumption literal is what makes it
    sayable: without one the core comes back empty or made of unrelated rows,
    and a school is told its timetable is impossible for sentences it did not
    write.
    """
    payload = _ordering_payload(
        [_rast("09:40", "10:00", asks=True)], lessons_per_week=2, frame_end="12:00:00",
    )
    first = payload["groups"][0]["id"]  # type: ignore[index]
    second = str(uuid4())
    payload["groups"].append(  # type: ignore[union-attr]
        {"id": second, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
    )
    twin = dict(payload["requirements"][0])  # type: ignore[index]
    twin["id"] = str(uuid4())
    twin["subjectId"] = str(uuid4())
    twin["teacherId"] = str(uuid4())
    twin["studentGroupId"] = second
    payload["requirements"].append(twin)  # type: ignore[union-attr]
    # One room for both, and a morning that holds one lesson: 08:00-09:40 fits
    # a single sixty-minute lesson, and the two classes cannot share it.
    payload["frameTimes"][0]["startTime"] = "08:40:00"  # type: ignore[index]

    refused = _solve(payload)

    assert refused.status == "INFEASIBLE"
    assert refused.conflicts is not None
    codes = {conflict.code for conflict in refused.conflicts.conflicts}
    assert "RAST_NO_LESSON_FITS_BEFORE_IT" in codes, refused.conflicts


def test_a_class_that_has_gone_home_owes_the_rast_nothing() -> None:
    """The obligation is on the stretch a lesson FOLLOWS, and only then.

    Read as a demand on every stretch of every school day instead, two asking
    rasts oblige every class to be taught ten times a week — measured on this
    payload before the condition was there: eight lessons INFEASIBLE, ten the
    first count that solved. A class with eight lessons a week is an ordinary
    åk 1, and refusing its week over a rule about breaks is not what the
    school asked for.
    """
    response = _solve(
        _ordering_payload(
            [_rast("09:40", "10:00", asks=True), _rast("14:00", "14:20", asks=True)],
            lessons_per_week=8,
            frame_end="16:00:00",
        ),
        SCHEDULE_DAYS="1,2,3,4,5",
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 8


def test_a_class_at_school_after_the_rast_is_taught_before_it() -> None:
    """The rule in the affirmative, on a week that could have broken it.

    Three forty-minute lessons and a morning that holds one, so at least one
    lesson lies after the break whatever the solver does — and the moment one
    does, the morning owes a lesson too. Without the rule all three fit in
    10:00-12:00 and the morning stands empty, which is the week this refuses.
    """
    response = _solve(
        _ordering_payload(
            [_rast("09:40", "10:00", asks=True)],
            lessons_per_week=3,
            minutes_per_lesson=40,
        ),
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    placed = [
        (_minutes(lesson.start_time), _minutes(lesson.end_time))
        for lesson in response.lessons
    ]
    assert any(start >= 10 * 60 for start, _ in placed), placed
    assert any(end <= 9 * 60 + 40 for _, end in placed), placed


def test_the_afternoon_is_counted_from_the_lunch_not_from_the_morning() -> None:
    """The reading that makes the rule mean anything after midday.

    "A lesson before the afternoon rast" read literally is satisfied by a
    lesson before lunch, and the whole afternoon may still be empty; measured
    at twenty-four classes, all one hundred and twenty afternoon stretches
    were. So the stretch is counted from the MEAL when the meal falls inside
    it.

    The day here holds exactly three lessons — one before the morning rast,
    one between it and the 11:00 meal, one after the afternoon rast — so the
    class is provably at school after 14:20 and the stretch between the meal
    and the 14:00 rast is shut. Nothing can lie in it, and the week is
    refused. Under the literal reading the 10:00 lesson answers for the
    afternoon and this same Monday solves.
    """
    payload = _ordering_payload(
        [_rast("09:40", "10:00"), _rast("14:00", "14:20", asks=True)],
        lessons_per_week=3,
        frame_end="16:00:00",
        closed=[("12:00", "14:00")],
    )
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "12:00:00",
        "lunchMinutes": 60,
    }

    assert _solve(payload).status == "INFEASIBLE"

    # The same day with the rast asking nothing is an ordinary Monday, so the
    # closure and the meal are not what refused it.
    payload["rasts"] = [_rast("09:40", "10:00"), _rast("14:00", "14:20")]
    assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


def test_a_lunch_window_that_straddles_the_rast_bounds_nothing() -> None:
    """An order nobody has decided yet is not an obligation.

    The window is 11:00-13:00 and the rast is at 12:00, so whether the meal
    comes before the rast or after it is the solver's own choice — "a lesson
    between them" is not yet a sentence about a week. Counted from the meal
    anyway, the stretch would be 11:45-12:00 at best and this Monday would be
    refused for a question the school never asked.

    The class is free from 11:00 and has two lessons, so one is provably after
    the break and the rule is live; the other has exactly one place to be, and
    the assertion is that it is allowed to be there.
    """
    payload = _ordering_payload(
        [_rast("12:00", "12:20", asks=True)],
        lessons_per_week=2,
        frame_end="16:00:00",
        closed=[("08:00", "11:00")],
    )
    payload["rules"] = {
        "lunchStartTime": "11:00:00",
        "lunchEndTime": "13:00:00",
        "lunchMinutes": 45,
    }

    response = _solve(payload)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    placed = [
        (_minutes(lesson.start_time), _minutes(lesson.end_time))
        for lesson in response.lessons
    ]
    assert any(start >= 12 * 60 + 20 for start, _ in placed), placed
    assert any(
        start >= 11 * 60 and end <= 12 * 60 for start, end in placed
    ), placed


def test_the_stretch_begins_at_the_previous_rast_not_at_the_day() -> None:
    """A lesson two breaks ago does not answer for this one.

    That is the difference between "a lesson before the rast" and "a lesson
    since the last rast", and it is the whole reason a Swedish day with three
    breaks needs this rule rather than one test on the morning. Here the
    10:00-11:00 stretch is shut, so the class is taught at 08:00 and again
    after 11:20 — which leaves the 11:00 break opening its own half of the day,
    and the week is refused. Bounded from the start of the day instead, the
    08:00 lesson would answer for the 11:00 break and this Monday would solve.
    """
    payload = _ordering_payload(
        [_rast("09:40", "10:00"), _rast("11:00", "11:20", asks=True)],
        lessons_per_week=2,
        frame_end="13:00:00",
        closed=[("10:00", "11:00")],
    )

    assert _solve(payload).status == "INFEASIBLE"

    payload["rasts"] = [_rast("09:40", "10:00"), _rast("11:00", "11:20")]
    assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


def test_a_lunch_before_the_stretch_opens_does_not_bound_it() -> None:
    """The meal bounds a stretch it lies INSIDE, and no other.

    A class that ate at 10:30 and has a break at 13:00 owes a lesson since
    12:20 — the break before it — not since the meal two hours earlier. Read
    from the meal, the 11:00 lesson would answer for the 13:00 break and the
    afternoon would again be free to stand empty, which is the reading this
    whole section exists to refuse.

    So the day here is shut except 11:00-11:40 and everything after 13:20: the
    class is provably still at school after the break, and the stretch that
    ends at it holds nothing. Refused — unless the meal is allowed to open a
    stretch it is not in.
    """
    payload = _ordering_payload(
        [_rast("12:00", "12:20"), _rast("13:00", "13:20", asks=True)],
        lessons_per_week=2,
        minutes_per_lesson=40,
        frame_end="16:00:00",
        closed=[("08:00", "10:30"), ("11:40", "13:20")],
    )
    payload["rules"] = {
        "lunchStartTime": "10:30:00",
        "lunchEndTime": "11:00:00",
        "lunchMinutes": 30,
    }

    # Refused before the solve, and by name: the reservation takes the whole
    # stretch, so the class can never be there after the break, and the days
    # that are left hold forty minutes against the eighty its lessons need.
    # The verdict is the one the model used to reach; only the route changed.
    assert _refusal(payload).code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"

    payload["rasts"] = [_rast("12:00", "12:20"), _rast("13:00", "13:20")]
    assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


@pytest.mark.parametrize(
    ("start", "end", "remaining", "why"),
    [
        ("08:00", "08:20", 0, "the day opens with it, so the stretch is empty"),
        ("08:30", "08:50", 0, "the stretch is 30 minutes and a reservation holds all of it"),
    ],
)
def test_a_stretch_no_lesson_fits_is_refused_by_name(
    start: str, end: str, remaining: int, why: str,
) -> None:
    """No lesson fits, so the demand is a contradiction — and it is said out loud.

    This used to pass silently, and the argument for silence was sound as far
    as it went: an `AddBoolOr([])` is false, which is an INFEASIBLE CP-SAT
    proves before it touches an assumption literal, so the school would be told
    its week is impossible and nothing would say why. Between a bad refusal and
    saying nothing, nothing was better.

    It is not the choice any more, because there is now a third thing to do.
    The stretch is arithmetic on constants — where the day opens, where the
    previous break ended, when the meal can be over — so the payload can be
    refused with the numbers in it before a solver runs. Silence had a cost of
    its own: a rektor ticked a box, the engine ignored it, and nothing on any
    screen said so.
    """
    refusal = _refusal(
        _ordering_payload([_rast(start, end, asks=True)], closed=[("08:00", "10:00")]),
    )

    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT", why
    # Nothing, not the thirty minutes the calendar shows: the payload closes
    # 08:00-10:00 for this class, and the stretch is measured after that.
    assert refusal.params["remaining"] == remaining
    assert refusal.params["minutes"] == 60


def test_a_rast_written_for_another_stage_asks_this_class_nothing() -> None:
    """The obligation reaches exactly as far as the rast does.

    Read on a 4-6 class this payload is the refused one from the pair above.
    Written for years 7-9 the rast does not reach it, and the Monday stands —
    the same overlap test blocks_for applies to the minutes, applied to the
    demand.
    """
    response = _solve(
        _ordering_payload(
            [_rast("09:40", "10:00", asks=True, grades=(7, 9))],
            closed=[("08:00", "10:00")],
        ),
    )

    assert response.status in {"OPTIMAL", "FEASIBLE"}


def test_the_estimate_charges_for_the_lesson_before_a_rast() -> None:
    """The complexity guard has to describe the model it guards.

    Every other rast term is zero: the minutes a rast reserves are subtracted
    from a start domain and cost no variable at all. This one is the exception
    and the estimator says so in the same commit that built it, which is what
    _estimate_model_size's own docstring asks of a changed builder.

    Asserted both ways round. A rast that asks nothing must charge nothing —
    an estimator that read the count of rasts rather than the count of ASKING
    rasts would refuse a large school for a rule it never turned on. And with
    the flag on the estimate must still be an upper bound on the model that is
    actually built, because a bound that is too low is not a conservative
    guess but a wrong one.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _rast_payload([_rast("09:40", "10:00")], lessons_per_week=4)
    quiet = OptimizeScheduleRequest.model_validate(payload)
    payload["rasts"] = [_rast("09:40", "10:00", asks=True)]
    asking = OptimizeScheduleRequest.model_validate(payload)

    assert solver._estimate_model_size(quiet) == solver._estimate_model_size(
        OptimizeScheduleRequest.model_validate({**payload, "rasts": []}),
    ), "a rast that asks for nothing is free, and the estimate must say so"

    built_quiet, _, _, _, _ = solver._build_model(quiet, use_assumptions=False)
    built_asking, _, _, _, _ = solver._build_model(asking, use_assumptions=False)
    grew = len(built_asking.Proto().variables) - len(built_quiet.Proto().variables)
    assert grew > 0, "the rule builds variables, or it is not in the model"
    assert solver._estimate_model_size(asking) >= len(built_asking.Proto().variables)
    assert solver._estimate_model_size(asking) - solver._estimate_model_size(quiet) >= grew


def test_a_class_answers_with_its_teaching_groups_lessons() -> None:
    """4.1's maths is filed under 4ma1, and the rule has to know it.

    The class carries the years, the lunch and the rast; the lessons are filed
    under the teaching groups cut out of it. A rule reading only what is filed
    under "4.1" finds a class with no lessons at all, has nothing to put in any
    stretch and nothing to follow one either, and passes every week in silence.

    So the payload is the refused pair with the lesson moved to a teaching
    group. It must still be refused.
    """
    payload = _ordering_payload(
        [_rast("09:40", "10:00", asks=True)], closed=[("08:00", "10:00")],
    )
    home_class = payload["groups"][0]["id"]  # type: ignore[index]
    teaching_group = str(uuid4())
    payload["requirements"][0]["studentGroupId"] = teaching_group  # type: ignore[index]
    payload["groupConflicts"] = [[home_class, teaching_group]]
    # The closure follows the lessons: an availability constraint on a home
    # class does not reach the teaching groups cut out of it, and one left
    # pointing at 4.1 would shut a group that has nothing to place.
    payload["constraints"][0]["resourceId"] = teaching_group  # type: ignore[index]

    assert _refusal(payload).code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"


# ---------------------------------------------------------------------------
# Kortegen: the margin a body needs between two lessons inside one block.
# ---------------------------------------------------------------------------


def _changeover_payload(minutes: int, *, lessons_per_week: int = 4) -> dict[str, object]:
    """One teacher, one class, one room, an 08:00-12:00 day.

    Four sixty-minute lessons and a five-minute corridor need 4x65 - 5 = 255
    minutes of the 240 the day has, so the week is refused unless the corridor
    is honoured at exactly zero — which is what makes the difference visible
    rather than a matter of the solver's taste.
    """
    requirement_id = str(uuid4())
    group_id = str(uuid4())
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": requirement_id,
                "subjectId": str(uuid4()),
                "studentGroupId": group_id,
                "teacherId": str(uuid4()),
                "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
                "minGradeLevel": 4,
                "maxGradeLevel": 6,
            }
        ],
        "groups": [
            {"id": group_id, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
        "frameTimes": [
            {
                "minGradeLevel": 0,
                "maxGradeLevel": 12,
                "dayOfWeek": None,
                "startTime": "08:00:00",
                "endTime": "12:00:00",
                "changeoverMinutes": minutes,
            },
        ],
    }


def test_two_lessons_of_one_class_keep_the_declared_corridor() -> None:
    """The other half of the rektor's first complaint.

    CP-SAT intervals are half-open, so 08:00-09:00 and 09:00-10:00 do not
    overlap and the class walks between two rooms in no time at all. With a
    corridor declared, every same-day pair has to be at least that far apart.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2"))
    request = OptimizeScheduleRequest.model_validate(_changeover_payload(10))

    response = solver.solve(request)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    by_day: dict[int, list[tuple[int, int]]] = {}
    for lesson in response.lessons:
        start = int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5])
        end = int(lesson.end_time[:2]) * 60 + int(lesson.end_time[3:5])
        by_day.setdefault(lesson.day_of_week, []).append((start, end))
    for day, slots in by_day.items():
        slots.sort()
        for (_, first_end), (second_start, _) in zip(slots, slots[1:]):
            assert second_start - first_end >= 10, (
                f"day {day}: only {second_start - first_end} minutes between two lessons"
            )


def test_the_corridor_is_the_widest_of_the_frames_that_match() -> None:
    """MAX, not the tightest — a window is a bound, a corridor is a floor."""
    from app.schemas.schedule import FrameTime
    from app.solver.frames import changeover_slots
    from app.solver.time_grid import TimeGrid

    grid = TimeGrid(
        day_start_minutes=480, day_end_minutes=1080, slot_minutes=5,
        schedule_days=(1, 2, 3, 4, 5),
    )
    frame = lambda lo, hi, minutes: FrameTime.model_validate(  # noqa: E731
        {
            "minGradeLevel": lo,
            "maxGradeLevel": hi,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "16:00:00",
            "changeoverMinutes": minutes,
        },
    )

    assert changeover_slots([frame(0, 12, 5), frame(4, 6, 10)], (4, 6), grid) == 2
    # A stage the wider frame alone reaches keeps the wider frame's number.
    assert changeover_slots([frame(0, 12, 5), frame(4, 6, 10)], (7, 9), grid) == 1
    # Rounded UP, for the reason a rast rounds outward: the margin is a minimum.
    assert changeover_slots([frame(0, 12, 7)], (4, 6), grid) == 2
    # A group whose years are unknown matches no frame, as everywhere else.
    assert changeover_slots([frame(0, 12, 10)], None, grid) == 0


def test_a_zero_corridor_leaves_the_model_exactly_as_it_was() -> None:
    """Every school, until somebody writes a number.

    The padded interval is built only when the margin is non-zero, so a run with
    no corridor declared adds not one interval proto — which is what lets this
    ship without a release note for anybody who has not asked for it.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2"))
    request = OptimizeScheduleRequest.model_validate(_changeover_payload(0))
    model = cp_model.CpModel()

    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts,
    )

    assert decisions
    assert all(decision.changeover == 0 for decision in decisions)
    from app.solver.scheduler_solver import padded_of

    assert all(padded_of(model, d) is d.interval for d in decisions)


def test_a_padded_lesson_may_not_run_past_the_end_of_its_day() -> None:
    """The clip, without a guard band and without an AddMinEquality.

    A padded interval runs `changeover` slots past the lesson, and day d is
    addressed as [d*spd, (d+1)*spd) — so an unclipped last lesson pads into
    tomorrow morning and collides with a lesson that is not on the same day.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2"))
    payload = _changeover_payload(10)
    # No frame at all, so the clip is the only thing holding the day's edge.
    payload["frameTimes"] = [
        {
            "minGradeLevel": 0,
            "maxGradeLevel": 12,
            "dayOfWeek": None,
            "startTime": "08:00:00",
            "endTime": "18:00:00",
            "changeoverMinutes": 10,
        },
    ]
    request = OptimizeScheduleRequest.model_validate(payload)
    model = cp_model.CpModel()

    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts,
    )

    grid = solver._grid
    # The last legal start on day 0: the day is 120 slots, the lesson 12, the
    # corridor 2 — so 106, whose padded end is exactly the day's last slot.
    domain = cp_model.Domain.from_flat_intervals(list(decisions[0].start.proto.domain))
    assert domain.contains(grid.slots_per_day - 12 - 2)
    assert not domain.contains(grid.slots_per_day - 12 - 1)



def test_a_timeout_names_what_shaped_the_model() -> None:
    """UNKNOWN is not a proof, so a TIMEOUT has no core to explain itself with.

    What the log CAN say is which of the things that make a week hard were in
    force — and the corridor first, because measured on a 12-class school it is
    the difference between one second and the whole budget.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _changeover_payload(10)
    payload["rasts"] = [_rast("09:40", "10:00")]
    request = OptimizeScheduleRequest.model_validate(payload)

    line = solver._timeout_diagnosis(request, "test")

    assert "changeoverMinutes=10" in line
    assert "rasts=1" in line
    assert "groups eating" in line
    assert "first thing to try at 0" in line
    assert "first thing to try at 0" not in solver._timeout_diagnosis(
        OptimizeScheduleRequest.model_validate(_changeover_payload(0)), "test",
    )



def _teaching_group_school(
    classes: int = 12,
    tgs_per_class: int = 8,
    lessons_per_tg: int = 3,
    *,
    changeover: int = 0,
) -> dict[str, object]:
    """The school in the report: every lesson on a teaching group, none on the class.

    Each class has eight teaching groups that all share its pupils, so every
    pair of them — and each of them with the class — is a shared-pupil pair.
    The classes are who eat; the teaching groups are not.
    """
    reqs: list[dict[str, object]] = []
    groups: list[dict[str, object]] = []
    pairs: list[list[str]] = []
    teachers = [str(uuid4()) for _ in range(classes * 2)]
    rooms = [{"id": str(uuid4()), "capacity": 30} for _ in range(int(classes * 1.3))]
    t = 0
    for c in range(classes):
        cls = str(uuid4())
        grade = 4 + (c % 6)
        tg_ids: list[str] = []
        for _ in range(tgs_per_class):
            tg = str(uuid4())
            tg_ids.append(tg)
            reqs.append({
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": tg,
                "teacherId": teachers[t % len(teachers)], "lessonsPerWeek": lessons_per_tg,
                "minutesPerLesson": 60, "studentGroupSize": 24,
                "minGradeLevel": grade, "maxGradeLevel": grade,
            })
            t += 1
            pairs.append([cls, tg])
        for i in range(len(tg_ids)):
            for j in range(i + 1, len(tg_ids)):
                pairs.append([tg_ids[i], tg_ids[j]])
        groups.append({"id": cls, "lunchHeadcount": 24, "minGradeLevel": grade, "maxGradeLevel": grade})
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()), "requirements": reqs,
        "groups": groups, "rooms": rooms, "constraints": [], "groupConflicts": pairs,
        "rules": {"lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30},
        "frameTimes": [{
            "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
            "startTime": "08:00:00", "endTime": "15:30:00", "changeoverMinutes": changeover,
        }],
    }


def test_the_probe_names_the_corridor_as_what_does_not_fit() -> None:
    """The probe, measured on the school in the report.

    UNKNOWN is not a proof, so nothing can be asked which constraints it rests
    on. What CAN be done is to switch one rule off at a time and see which
    relaxation lets the same week solve. Here the corridor is the only rule in
    the payload besides the lunch, and with it at 0 the week solves at once.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=20.0))
    request = OptimizeScheduleRequest.model_validate(
        _teaching_group_school(classes=12, changeover=5),
    )

    analysis = solver._probe_timeout(request)

    assert analysis is not None
    assert analysis.conflicts, analysis.summary
    assert analysis.conflicts[0].category == "TIMEOUT_PROBE"
    # One whole named sentence per relaxation, never a fragment glued into
    # the summary: a fragment cannot be translated into a language that
    # inflects around it.
    assert analysis.conflicts[0].code == "PROBE_SOLVED_WITHOUT_CHANGEOVER"
    assert "margin between lessons" in analysis.conflicts[0].message
    assert analysis.summary_code == "PROBE_ONE_RULE_HELPED"
    assert "not a proof" in analysis.summary


def test_a_timeout_carries_the_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """The wiring: a phase-1 UNKNOWN reaches the caller WITH the measurement.

    Forcing a real phase-1 timeout needs a week too hard for CP-SAT to place
    inside a budget, and every fixture this file has solves in a second. So
    CP-SAT is told to answer UNKNOWN and the probe is stubbed; what is asserted
    is that the response built on that path carries what the probe returned.
    """
    from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    monkeypatch.setattr(cp_model.CpSolver, "Solve", lambda self, model: cp_model.UNKNOWN)
    verdict = ConflictAnalysis(
        summary_code="PROBE_ONE_RULE_HELPED",
        summary_params={"budget": 2, "rules": 1},
        conflicts=[ConflictDetail(
            category="TIMEOUT_PROBE",
            code="PROBE_SOLVED_WITHOUT_RASTS",
            params={"seconds": 1.0},
        )],
    )
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", lambda self, request: verdict)
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=2.0))

    response = solver.solve(OptimizeScheduleRequest.model_validate(_sample_payload()))

    assert response.status == "TIMEOUT"
    assert response.conflicts == verdict


def test_the_probe_is_silent_when_there_is_nothing_to_relax() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=5.0))
    # No corridor, no rasts, no lunch rule: nothing this probe knows how to
    # switch off, so it says nothing rather than something invented.
    request = OptimizeScheduleRequest.model_validate(_sample_payload())

    assert solver._probe_timeout(request) is None


def test_the_probe_can_be_switched_off() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0))
    request = OptimizeScheduleRequest.model_validate(_changeover_payload(10))

    assert solver._probe_timeout(request) is None



def test_the_probe_takes_the_lunch_apart_before_switching_it_off() -> None:
    """Three relaxations for the lunch, not one — because a school cannot act on
    "switch the lunch off". Which of the sittings, the seats and the break
    itself does not fit decides whether they widen a window, count the chairs
    again, or move the whole thing.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=4)
    payload["rules"]["diningSeats"] = 115
    payload["lunchServings"] = [
        {"minGradeLevel": 4, "maxGradeLevel": 6, "dayOfWeek": None,
         "startTime": "11:00:00", "endTime": "12:00:00"},
    ]
    payload["frameTimes"][0]["changeoverMinutes"] = 5
    payload["rasts"] = [_rast("09:40", "10:00")]

    codes = [code for code, _ in solver._timeout_relaxations(
        OptimizeScheduleRequest.model_validate(payload),
    )]

    assert codes == [
        "PROBE_SOLVED_WITHOUT_CHANGEOVER",
        "PROBE_SOLVED_WITHOUT_RASTS",
        "PROBE_SOLVED_WITHOUT_SERVINGS",
        "PROBE_SOLVED_WITHOUT_DINING_SEATS",
        "PROBE_SOLVED_WITHOUT_LUNCH",
    ]
    # And each relaxation is a real change to the request, not a relabel.
    relaxed = dict(solver._timeout_relaxations(OptimizeScheduleRequest.model_validate(payload)))
    assert relaxed["PROBE_SOLVED_WITHOUT_SERVINGS"].lunch_servings == []
    assert relaxed["PROBE_SOLVED_WITHOUT_DINING_SEATS"].rules.dining_seats is None
    assert relaxed["PROBE_SOLVED_WITHOUT_LUNCH"].rules.lunch_minutes is None


def test_the_probe_offers_only_what_the_payload_carries() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    # A lunch window, no seats, no sittings: only the break itself can go.
    codes = [code for code, _ in solver._timeout_relaxations(
        OptimizeScheduleRequest.model_validate(_teaching_group_school(classes=2)),
    )]
    assert codes == ["PROBE_SOLVED_WITHOUT_LUNCH"]


def test_the_probe_takes_the_rasts_apart_the_same_way_as_the_lunch() -> None:
    """The demand for a lesson before the break is its own relaxation.

    For the reason the lunch has three: "with the rasts removed" is true and
    unactionable, because a school cannot delete its breaks. The requirement
    of a lesson before one it CAN act on — it is a switch somebody ticked, and
    the only rast setting that makes the model bigger rather than smaller.
    Offered only when a rast asks; a school that ticked nothing is not shown a
    rule it does not have.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=2)
    payload["rasts"] = [_rast("09:40", "10:00")]

    codes = [code for code, _ in solver._timeout_relaxations(
        OptimizeScheduleRequest.model_validate(payload),
    )]
    assert codes == ["PROBE_SOLVED_WITHOUT_RASTS", "PROBE_SOLVED_WITHOUT_LUNCH"]

    payload["rasts"] = [_rast("09:40", "10:00", asks=True)]
    relaxations = dict(solver._timeout_relaxations(
        OptimizeScheduleRequest.model_validate(payload),
    ))
    assert list(relaxations) == [
        "PROBE_SOLVED_WITHOUT_LESSON_BEFORE_RAST",
        "PROBE_SOLVED_WITHOUT_RASTS",
        "PROBE_SOLVED_WITHOUT_LUNCH",
    ]
    # The minutes stay reserved, which is the whole point of separating them.
    dropped = relaxations["PROBE_SOLVED_WITHOUT_LESSON_BEFORE_RAST"]
    assert len(dropped.rasts) == 1
    assert dropped.rasts[0].start_time == "09:40:00"
    assert dropped.rasts[0].requires_lesson_before is False



def test_a_hall_too_small_for_the_school_is_refused_by_name() -> None:
    """The gap between the two seat checks the engine already had.

    One refuses a class too big for the hall, the other a sitting too small
    for its stage. Between them sat the report: every class fits, no sittings,
    and the school as a whole does not — CP-SAT hunted a perfect packing for
    the whole budget and answered TIMEOUT.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=20)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00",
        "lunchMinutes": 30, "diningSeats": 115,
    }
    # 20 x 30 = 600 pupils x 30 min = 18,000 student-minutes; 115 x 150 = 17,250.
    for group in payload["groups"]:
        group["lunchHeadcount"] = 30

    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))

    # The SAME shape the solver would have produced after burning its budget:
    # the category the page translates, the registry's own sentence, and — new
    # — the numbers in the summary.
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert [c.category for c in response.conflicts.conflicts] == ["DINING_CAPACITY"]
    assert response.conflicts.conflicts[0].message == (
        "Lunch cannot be staggered within the dining hall's 115 seats."
    )
    assert response.conflicts.summary_code == "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL"
    assert response.conflicts.summary_params["students"] == 600
    assert response.conflicts.summary_params["needed"] == 18000
    assert "600 students" in response.conflicts.summary


def test_a_hall_that_can_feed_the_school_is_left_to_the_solver() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=20)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00",
        "lunchMinutes": 30, "diningSeats": 115,
    }
    # 20 x 24 = 480 x 30 = 14,400 <= 17,250: narrow, and the solver's to decide.
    assert solver._dining_hall_verdict(OptimizeScheduleRequest.model_validate(payload)) is None



def test_the_hall_check_leaves_out_a_class_that_is_not_in_school_that_day() -> None:
    """Exempt days count for nothing, as they do in the sitting check beside it.

    Twenty classes of thirty do not fit 115 seats (18,000 student-minutes
    against 17,250). Send one of them home every weekday — a STUDENT_GROUP rule
    covering the whole lunch window is the engine's own reading of "7A
    undervisas inte på tisdagar" — and the remaining 570 do: 17,100. A check
    that counted the absent class would refuse a week that has a timetable.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=20)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00",
        "lunchMinutes": 30, "diningSeats": 115,
    }
    for group in payload["groups"]:
        group["lunchHeadcount"] = 30
    absent = payload["groups"][0]["id"]
    payload["constraints"] = [
        {
            "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": absent,
            "dayOfWeek": day, "date": None, "startTime": "10:30:00", "endTime": "13:00:00",
            "kind": "UNAVAILABLE",
        }
        for day in (1, 2, 3, 4, 5)
    ]

    assert solver._dining_hall_verdict(OptimizeScheduleRequest.model_validate(payload)) is None



def test_the_explanation_solve_is_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    """An INFEASIBLE is proved before its explanation is sought.

    Measured on three overlapping lunch sittings: phase 1 proves INFEASIBLE in
    under a second, and the single-threaded assumption solve then ran the full
    sixty seconds and returned nothing. The cap decides how long a school waits
    for names it may not get — not whether the verdict stands.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    seen: list[float] = []
    real_solve = cp_model.CpSolver.Solve

    def recording_solve(self: cp_model.CpSolver, model: cp_model.CpModel) -> int:
        seen.append(self.parameters.max_time_in_seconds)
        return real_solve(self, model)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", recording_solve)
    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=300.0))

    solver._explain_infeasible(OptimizeScheduleRequest.model_validate(_sample_payload()))

    assert seen == [SchedulerSolver.EXPLAIN_CAP_SECONDS]



def _pin_lunch_with_locked_lessons(payload: dict[str, object]) -> dict[str, object]:
    """Reproduction B: one class's first two teaching groups locked 11-12 and
    12-13 every weekday, so its lunch can only start 10:30 and its pupils are
    busy 10:30-13:00. Four lessons a day fit around that; the class needs
    twenty-four a week."""
    cls = payload["groups"][0]["id"]  # type: ignore[index]
    tgs = [b for a, b in payload["groupConflicts"] if a == cls]  # type: ignore[union-attr]
    teacher = {r["studentGroupId"]: r["teacherId"] for r in payload["requirements"]}  # type: ignore[union-attr]
    fixed = []
    for day in (1, 2, 3, 4, 5):
        for tg, (start, end) in ((tgs[0], ("11:00:00", "12:00:00")), (tgs[1], ("12:00:00", "13:00:00"))):
            fixed.append({
                "id": str(uuid4()), "teacherId": teacher[tg], "coTeacherId": None,
                "studentGroupId": tg, "extraGroupIds": [], "roomId": None,
                "dayOfWeek": day, "startTime": start, "endTime": end,
            })
    payload["fixedLessons"] = fixed
    return payload


def test_locked_lessons_that_pin_the_lunch_are_refused_by_counting() -> None:
    """Reproduction B, decided by arithmetic instead of 120 s of UNKNOWN."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=4)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
    }
    _pin_lunch_with_locked_lessons(payload)

    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    detail = response.conflicts.conflicts[0]
    assert detail.category == "REQUIREMENT_DEMAND"
    # 24 x 60 = 1440 needed; 4 a day x 60 x 5 = 1200 offered.
    assert "1440 minutes" in detail.message
    assert "1200" in detail.message
    assert len(detail.requirement_ids) == 8
    # And the lunch is named as the difference: without it, 08:00-11:00 holds
    # three and 13:00-15:30 two, 25 a week for a class that needs 24.
    lunch = response.conflicts.conflicts[1]
    assert lunch.category == "LUNCH_WINDOW"
    assert "lunch break" in lunch.message
    assert "1500 minutes free" in lunch.message


def test_the_hours_verdict_leaves_a_solvable_week_alone() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=4)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
    }

    assert solver._clique_hours_verdict(OptimizeScheduleRequest.model_validate(payload)) is None


def _twelve_halves_of_one_class() -> dict[str, object]:
    """4ma1 and 4ma2 both share pupils with 4.1 and not with each other, so the
    model lets them run at once. Twelve halves, three lessons each = 36 lessons
    "for the class" if summed — far past the 25 a packed day holds — but they
    pair off freely, so at most 18 need distinct slots and the week is fine.
    """
    cls = str(uuid4())
    halves = [str(uuid4()) for _ in range(12)]
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        # Twelve halves, three lessons each = 36 lessons "for the class" if
        # summed — far past the 25 a packed day holds — but they pair off
        # freely, so at most 18 need distinct slots and the week is fine.
        "requirements": [
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": half,
                "teacherId": str(uuid4()), "lessonsPerWeek": 3, "minutesPerLesson": 60,
                "studentGroupSize": 12, "minGradeLevel": 4, "maxGradeLevel": 4,
            }
            for half in halves
        ],
        "groups": [{"id": cls, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 4}],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(6)],
        "constraints": [],
        # Each half shares with the class; halves share with each other only in
        # pairs (0,1), (2,3) ... — never a clique of three.
        "groupConflicts": [[cls, half] for half in halves]
        + [[halves[i], halves[i + 1]] for i in range(0, 12, 2)],
        "rules": {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30},
        "frameTimes": [{
            "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
            "startTime": "08:00:00", "endTime": "13:30:00", "changeoverMinutes": 0,
        }],
    }


def test_the_hours_verdict_never_sums_two_halves_that_may_overlap() -> None:
    """SOUNDNESS. 4ma1 and 4ma2 both share pupils with 4.1 and not with each
    other, so the model lets them run at once. Summing every group that shares
    with the class would count both halves against the same hours and refuse a
    week the model accepts. Only a clique is summed.
    """
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _twelve_halves_of_one_class()

    assert solver._clique_hours_verdict(OptimizeScheduleRequest.model_validate(payload)) is None


def test_a_locked_lesson_that_blocks_only_one_member_is_not_subtracted() -> None:
    """SOUNDNESS. A locked lesson of a group that shares pupils with one member
    of the clique blocks that member's lessons and nobody else's; the others may
    teach through it. Subtracting it from the clique's free time would refuse a
    week the model accepts."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=2)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
    }
    # A stranger group, sharing pupils with ONE teaching group of class 0 only,
    # locked 11-13 every day. Were it subtracted from the whole clique, class 0
    # would read as twenty lessons against twenty-four, as in reproduction B.
    cls = payload["groups"][0]["id"]
    tg0 = next(b for a, b in payload["groupConflicts"] if a == cls)
    stranger = str(uuid4())
    payload["groupConflicts"].append([stranger, tg0])
    payload["fixedLessons"] = [
        {
            "id": str(uuid4()), "teacherId": None, "coTeacherId": None,
            "studentGroupId": stranger, "extraGroupIds": [], "roomId": None,
            "dayOfWeek": day, "startTime": start, "endTime": end,
        }
        for day in (1, 2, 3, 4, 5)
        for start, end in (("11:00:00", "12:00:00"), ("12:00:00", "13:00:00"))
    ]

    assert solver._clique_hours_verdict(OptimizeScheduleRequest.model_validate(payload)) is None


def _one_class_with_a_short_day(lessons_per_week: int, minutes: tuple[int, ...]) -> dict[str, object]:
    """One class, no lunch, framed 08:00-09:45: 105 minutes a day, five days."""
    cls = str(uuid4())
    teacher = str(uuid4())
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": cls,
                "teacherId": teacher, "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": length, "studentGroupSize": 24,
                "minGradeLevel": 4, "maxGradeLevel": 4,
            }
            for length in minutes
        ],
        "groups": [{"id": cls, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 4}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [], "groupConflicts": [], "rules": {},
        "frameTimes": [{
            "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
            "startTime": "08:00:00", "endTime": "09:45:00", "changeoverMinutes": 0,
        }],
    }


def test_the_hours_verdict_measures_a_gap_by_the_lessons_common_measure() -> None:
    """SOUNDNESS. A 105-minute day holds a 60- and a 45-minute lesson exactly.
    Rounding the gap down to a multiple of the SHORTEST lesson called it 90
    and refused five such days for a class the model schedules in a second."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(_one_class_with_a_short_day(5, (60, 45)))

    assert solver._clique_hours_verdict(request) is None
    assert solver.solve(request).status == "OPTIMAL"


def test_the_hours_verdict_still_rounds_a_gap_down_to_whole_lessons() -> None:
    """The measure is the lessons' common divisor, not the minute: a 105-minute
    day holds ONE hour-long lesson, so eight a week do not fit in five days
    although 8 x 60 = 480 < 5 x 105 = 525."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    verdict = solver._clique_hours_verdict(
        OptimizeScheduleRequest.model_validate(_one_class_with_a_short_day(8, (60,))),
    )

    assert verdict is not None
    assert verdict.conflicts[0].category == "REQUIREMENT_DEMAND"
    assert "480 minutes" in verdict.conflicts[0].message
    assert "300" in verdict.conflicts[0].message


def _frames_that_pack_the_middle_years(payload: dict[str, object]) -> dict[str, object]:
    """Reproduction G: years 4-6 framed 08:00-13:30 — exactly five hour-long
    lessons and a thirty-minute meal — with 115 seats for a school of 480.
    A five-lesson day is packed and its lunch can only start 11:00 or 12:00;
    twenty-four lessons at most five a day force four packed days a class;
    two disjoint sittings of four classes seat eight packed class-days a day,
    forty a week, and the eleven classes of those years need forty-four."""
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
        "diningSeats": 115, "maxLessonsPerDayPerGroup": 7,
    }
    payload["frameTimes"] = [
        {
            "minGradeLevel": low, "maxGradeLevel": high, "dayOfWeek": None,
            "startTime": start, "endTime": end, "changeoverMinutes": 0,
        }
        for low, high, start, end in (
            (0, 3, "08:00:00", "13:30:00"),
            (4, 6, "08:00:00", "13:30:00"),
            (7, 9, "08:10:00", "15:30:00"),
        )
    ]
    return payload


def test_a_frame_that_packs_a_stage_day_is_refused_by_the_lunch_stage() -> None:
    """Reproduction G, decided in under a second by the lunch stage. Neither
    arithmetic verdict sees it — the hall feeds the school's student-minutes
    and every class's hours fit — and the full model answered UNKNOWN at 60 s."""
    import time

    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _frames_that_pack_the_middle_years(_teaching_group_school(classes=20))
    request = OptimizeScheduleRequest.model_validate(payload)
    assert solver._dining_hall_verdict(request) is None
    assert solver._clique_hours_verdict(request) is None

    started = time.monotonic()
    response = solver.solve(request)

    assert time.monotonic() - started < 20
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert "115 seats cannot seat the 11 classes named (264 students)" in response.conflicts.summary
    details = response.conflicts.conflicts
    assert details[0].category == "DINING_CAPACITY"
    assert "115 seats" in details[0].message
    # The classes named are exactly those the proof needs: the eleven of years
    # 4-6, whose frame packs the day, and none of years 7-9, whose frame leaves
    # six a day. Each is named twice — as at school, and as having the lessons
    # — because dropping either sentence for any one of them lets the week
    # solve. The frames themselves are not named: they narrow no lunch start.
    middle_years = {g["id"] for g in payload["groups"] if g["maxGradeLevel"] <= 6}  # type: ignore[index]
    assert len(middle_years) == 11
    named = {(d.category, str(g)) for d in details[1:] for g in d.resource_ids}
    assert named == {(c, g) for c in ("DINING_CAPACITY", "LUNCH_WINDOW") for g in middle_years}
    assert len(details) == 3
    # The frame IS the lever, and the line about the lessons says which one.
    assert details[2].code == "LUNCH_LESSONS_FILL_THE_FRAMED_DAY"
    assert details[2].params == {"window": "08:00-13:30"}


@pytest.mark.parametrize("seats", [None, 115])
def test_the_lunch_stage_names_the_lunch_when_seats_are_not_the_difference(
    monkeypatch: pytest.MonkeyPatch, seats: int | None,
) -> None:
    """Reproduction B with the hours verdict switched off, so the stage is what
    decides it. Refused with the seats and without them alike, so it is the
    lock beside the lunch that is named, never the hall — with 115 seats for
    96 pupils the hall was never the problem."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    monkeypatch.setattr(SchedulerSolver, "_clique_hours_verdict", lambda self, request: None)
    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=4)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
        **({"diningSeats": seats} if seats else {}),
    }
    _pin_lunch_with_locked_lessons(payload)

    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert "for the 1 class named" in response.conflicts.summary
    assert "seats" not in response.conflicts.summary
    pinned = payload["groups"][0]["id"]  # type: ignore[index]
    # Three sentences about one class: it is at school, it has the lessons,
    # and the locks take the starts. Never the hall.
    assert [
        (d.category, [str(g) for g in d.resource_ids]) for d in response.conflicts.conflicts
    ] == [
        ("LUNCH_WINDOW", [pinned]), ("LUNCH_WINDOW", [pinned]), ("GROUP_OVERLAP", [pinned]),
    ]
    assert "Locked lessons" in response.conflicts.conflicts[2].message


def test_the_lunch_stage_settles_a_solvable_school_s_meals_within_its_seats() -> None:
    """Four classes of 24 and a hall of 50: two waves. The stage hands back one
    start per class and day, never more than the hall holds at any slot, and
    the week then solves."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _teaching_group_school(classes=4)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
        "diningSeats": 50,
    }
    request = OptimizeScheduleRequest.model_validate(payload)

    verdict, hints = solver._lunch_stage_one(request)

    assert verdict is None
    classes = {UUID(g["id"]) for g in payload["groups"]}  # type: ignore[index]
    assert set(hints) == {(cls, day) for cls in classes for day in range(5)}
    lunch_slots = 6  # 30 minutes on a five-minute grid
    for day in range(5):
        starts = [slot for (_, hinted_day), slot in hints.items() if hinted_day == day]
        assert all(day * 120 + 30 <= slot <= day * 120 + 54 for slot in starts)  # 10:30 .. 12:30
        for slot in starts:
            eating = sum(24 for other in starts if other <= slot < other + lunch_slots)
            assert eating <= 50
    assert solver.solve(request).status in ("OPTIMAL", "FEASIBLE")


def test_the_lunch_stage_starts_are_hinted_into_the_existence_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the stage settles reaches phase 1a as a hint on that lunch start,
    and only that one: an unrelated variable carries no hint from it."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _teaching_group_school(classes=2)
    payload["rules"] = {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    first = UUID(payload["groups"][0]["id"])  # type: ignore[index]
    eleven = 36  # 11:00 on day 0, in slots from 08:00
    monkeypatch.setattr(
        SchedulerSolver, "_lunch_stage_one", lambda self, request: (None, {(first, 0): eleven}),
    )
    solved: list[cp_model.CpModel] = []
    original = cp_model.CpSolver.Solve

    def spy(self: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
        solved.append(model)
        return original(self, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", spy)

    SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))

    phase_1a = solved[0].Proto()
    hinted = dict(zip(phase_1a.solution_hint.vars, phase_1a.solution_hint.values))
    index_of = {variable.name: index for index, variable in enumerate(phase_1a.variables)}
    assert hinted[index_of[f"lunchstart_{first}_0"]] == eleven
    assert index_of[f"lunchstart_{first}_1"] not in hinted


def test_a_lunch_stage_that_cannot_decide_costs_the_week_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """UNKNOWN from the stage is not a verdict and not a hint: the full solve
    runs exactly as before it existed."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _teaching_group_school(classes=2)
    payload["rules"] = {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    solved: list[cp_model.CpModel] = []
    original = cp_model.CpSolver.Solve

    def first_call_runs_out(
        self: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object,
    ) -> int:
        solved.append(model)
        if len(solved) == 1:
            return cp_model.UNKNOWN
        return original(self, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", first_call_runs_out)

    response = SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert len(response.lunches) == 10
    # The first model solved was the stage's — lunch starts, the day counts,
    # and the sentence literals the naming can drop, nothing else.
    assert all(
        v.name.startswith((
            "lunchstart_", "lunchat_", "lessons_", "eats_", "hall_", "declared_", "locked_", "closed_",
        ))
        for v in solved[0].Proto().variables
    )
    assert len(solved[1].Proto().solution_hint.vars) == 0


def test_the_lunch_stage_reads_the_lunch_starts_the_model_allows() -> None:
    """One domain per class and day, composed from the same four facts the
    model states as four constraints: the window, the stage's sitting, the
    locked lesson beside it and the reservation on top of it."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver, _domain_intervals

    payload = _teaching_group_school(classes=1)
    cls = payload["groups"][0]["id"]  # type: ignore[index]
    teaching_group = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]
    payload["rules"] = {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    # The sitting: years 4-6 eat 11:00-12:30, so a 30-minute meal starts 11:00-12:00.
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "12:30")]
    # Monday: a locked lesson 11:00-11:30 on a teaching group of the class.
    payload["fixedLessons"] = [{
        "id": str(uuid4()), "teacherId": payload["requirements"][0]["teacherId"],  # type: ignore[index]
        "coTeacherId": None, "studentGroupId": teaching_group, "extraGroupIds": [], "roomId": None,
        "dayOfWeek": 1, "startTime": "11:00:00", "endTime": "11:30:00",
    }]
    # Tuesday: the class is reserved 12:00-13:00.
    payload["constraints"] = [{
        "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": cls,
        "dayOfWeek": 2, "date": None, "startTime": "12:00:00", "endTime": "13:00:00",
        "kind": "UNAVAILABLE",
    }]
    solver = SchedulerSolver(_settings())

    domains = solver._lunch_start_domains(OptimizeScheduleRequest.model_validate(payload))

    assert domains is not None
    day = 120  # slots per day on a five-minute grid, 08:00-18:00
    key = UUID(cls)
    # Slots from 08:00: 11:00 = 36, 11:30 = 42, 12:00 = 48.
    assert _domain_intervals(domains[(key, 0)]) == [(42, 48)]
    assert _domain_intervals(domains[(key, 1)]) == [(day + 36, day + 42)]
    assert _domain_intervals(domains[(key, 2)]) == [(2 * day + 36, 2 * day + 48)]
    assert len(domains) == 5


def test_the_lunch_stage_is_silent_without_a_lunch_window() -> None:
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _teaching_group_school(classes=1)
    payload["rules"] = {"diningSeats": 115}

    assert SchedulerSolver(_settings())._lunch_stage_one(
        OptimizeScheduleRequest.model_validate(payload),
    ) == (None, {})


def test_the_lunch_stage_steps_aside_when_a_sitting_and_a_lock_leave_no_start() -> None:
    """A sitting of exactly one start and a locked lesson on that start: each
    alone leaves a meal; together they leave none. Validation refuses that by
    name before any solve, so the stage never sees it through solve() — and
    a direct caller still gets no verdict and no empty variable handed to
    CP-SAT, which would call the model invalid."""
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _teaching_group_school(classes=1)
    payload["rules"] = {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    payload["lunchServings"] = [_sitting(4, 6, "11:00", "11:30")]
    payload["fixedLessons"] = [{
        "id": str(uuid4()), "teacherId": payload["requirements"][0]["teacherId"],  # type: ignore[index]
        "coTeacherId": None, "studentGroupId": payload["requirements"][0]["studentGroupId"],  # type: ignore[index]
        "extraGroupIds": [], "roomId": None,
        "dayOfWeek": 1, "startTime": "11:00:00", "endTime": "11:30:00",
    }]
    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(payload)

    assert solver._lunch_stage_one(request) == (None, {})
    with pytest.raises(InvalidScheduleInputError, match="Together, locked lessons and the declared"):
        solver.solve(request)


def test_a_reservation_moves_the_lunch_on_any_day_of_the_week() -> None:
    """The reservations helper returned day-relative slots into an absolute
    domain, so a reservation narrowed a lunch on Monday only — on Tuesday the
    range met nothing and the class ate straight through its samling. Reserve
    10:30-12:30 on Tuesday and the only start left is 12:30."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    payload = _teaching_group_school(classes=1)
    cls = payload["groups"][0]["id"]  # type: ignore[index]
    payload["rules"] = {"lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30}
    payload["constraints"] = [{
        "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": cls,
        "dayOfWeek": 2, "date": None, "startTime": "10:30:00", "endTime": "12:30:00",
        "kind": "UNAVAILABLE",
    }]

    response = SchedulerSolver(_settings()).solve(OptimizeScheduleRequest.model_validate(payload))

    assert response.status in ("OPTIMAL", "FEASIBLE")
    tuesday = [lunch for lunch in response.lunches if lunch.day_of_week == 2]
    assert [lunch.start_time for lunch in tuesday] == ["12:30:00"]



def test_the_lunch_stage_never_refuses_two_halves_that_may_overlap() -> None:
    """SOUNDNESS, the same as the hours verdict's: the stage counts a clique's
    lessons against its free time, and halves that pair off freely are no
    clique. Twelve halves, three lessons each, in a frame that holds five a
    day — refused if summed, fine when they overlap."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    verdict, hints = solver._lunch_stage_one(
        OptimizeScheduleRequest.model_validate(_twelve_halves_of_one_class()),
    )

    assert verdict is None
    assert len(hints) == 5


def _the_register(idle_classes: int, pupils: int) -> dict[str, object]:
    """Two classes scheduled, and the rest of the school's register entered
    with its pupils and no lessons — what a school looks like the week it
    tries the tool on two classes."""
    payload = _teaching_group_school(classes=2)
    payload["rules"] = {
        "lunchStartTime": "10:30:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
        "diningSeats": 115,
    }
    for index in range(idle_classes):
        payload["groups"].append({  # type: ignore[union-attr]
            "id": str(uuid4()), "lunchHeadcount": pupils,
            "minGradeLevel": 4 + index % 6, "maxGradeLevel": 4 + index % 6,
        })
    return payload


def test_a_register_the_hall_cannot_seat_in_waves_is_named_by_its_classes() -> None:
    """The school in the report: two classes with lessons and twenty without,
    every one of them sent to a hall of 115 seats. 22 x 24 x 30 student-minutes
    fit the window's 115 x 150, so the arithmetic verdict passes; but five
    classes of 24 are 120, so a wave seats four, five waves seat twenty, and
    twenty-two do not fit. No class has a packed day, so the first naming rule
    found nobody and the school read "0 class(es)". Named by deletion: any
    twenty-one classes are enough, and the lessons are no cause at all."""
    import time

    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _the_register(idle_classes=20, pupils=24)
    request = OptimizeScheduleRequest.model_validate(payload)
    assert solver._dining_hall_verdict(request) is None

    started = time.monotonic()
    response = solver.solve(request)

    assert time.monotonic() - started < 20
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert "115 seats cannot seat the 21 classes named (504 students)" in response.conflicts.summary
    details = response.conflicts.conflicts
    assert [d.category for d in details] == ["DINING_CAPACITY", "DINING_CAPACITY"]
    every_class = {g["id"] for g in payload["groups"]}  # type: ignore[index]
    named = {str(g) for g in details[1].resource_ids}
    assert len(named) == 21
    assert named <= every_class


def test_the_naming_stays_true_when_the_clock_runs_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every naming solve re-proves the week impossible with fewer sentences
    pinned, so whatever is still pinned when the time runs out is enough. Here
    it runs out at once: the verdict stands, every class stays named, and the
    summary says the hall question was never answered."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    calls = {"n": 0}
    original = cp_model.CpSolver.Solve

    def solve(self: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            return original(self, model, *args, **kwargs)  # the stage's own proof
        return cp_model.UNKNOWN

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    solver = SchedulerSolver(_settings())
    payload = _frames_that_pack_the_middle_years(_teaching_group_school(classes=20))

    verdict, hints = solver._lunch_stage_one(OptimizeScheduleRequest.model_validate(payload))

    assert hints == {}
    assert verdict is not None
    assert "ran out of time" in verdict.summary
    assert "for the 20 classes named" in verdict.summary
    named = {str(g) for d in verdict.conflicts for g in d.resource_ids}
    assert named == {g["id"] for g in payload["groups"]}  # type: ignore[index]


def _one_class(*, group_span: tuple[int, int] | None, requirement_spans: list[tuple[int, int] | None],
               lessons_per_week: int, frame: tuple[int, int, str, str]) -> dict[str, object]:
    """One class, one teacher, its lessons on requirements that may carry
    other years than the group entry does — which the gateway never sends,
    and the engine must not rely on."""
    cls = str(uuid4())
    teacher = str(uuid4())
    group: dict[str, object] = {"id": cls, "lunchHeadcount": 24, "minGradeLevel": None, "maxGradeLevel": None}
    if group_span is not None:
        group["minGradeLevel"], group["maxGradeLevel"] = group_span
    requirements = []
    for span in requirement_spans:
        requirements.append({
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": cls, "teacherId": teacher,
            "lessonsPerWeek": lessons_per_week, "minutesPerLesson": 60, "studentGroupSize": 24,
            "minGradeLevel": span[0] if span else None, "maxGradeLevel": span[1] if span else None,
        })
    lo, hi, start, end = frame
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()), "requirements": requirements,
        "groups": [group], "rooms": [{"id": str(uuid4()), "capacity": 30}], "constraints": [],
        "groupConflicts": [],
        "rules": {"lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30},
        "frameTimes": [{
            "minGradeLevel": lo, "maxGradeLevel": hi, "dayOfWeek": None,
            "startTime": f"{start}:00", "endTime": f"{end}:00", "changeoverMinutes": 0,
        }],
    }


def test_the_clique_reads_each_lesson_by_its_own_years_not_the_group_s() -> None:
    """SOUNDNESS, found by a panel. The group entry says years 4-4 and a frame
    closes that stage's day at 12:30; the requirement carries no years, so the
    model lets its lessons run to 18:00 and places 25 a week with ease. The
    clique first read the class's window off the group entry, counted 25 hours
    into a four-and-a-half-hour day, and both readers refused the week."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10))
    payload = _one_class(group_span=(4, 4), requirement_spans=[None], lessons_per_week=25,
                         frame=(4, 4, "08:00", "12:30"))
    request = OptimizeScheduleRequest.model_validate(payload)

    assert solver._clique_hours_verdict(request) is None
    verdict, hints = solver._lunch_stage_one(request)
    assert verdict is None
    assert len(hints) == 5
    assert solver.solve(request).status in ("OPTIMAL", "FEASIBLE")


def test_the_clique_reads_every_requirement_of_a_member_not_its_first() -> None:
    """The same hole from the other side: a member's first requirement carries
    years 4-4, its second none. Only the first was read, and the second's
    lessons — free to run all day in the model — were counted into the frame."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=10))
    payload = _one_class(group_span=(4, 4), requirement_spans=[(4, 4), None], lessons_per_week=10,
                         frame=(4, 4, "08:00", "12:30"))
    request = OptimizeScheduleRequest.model_validate(payload)

    # Twenty hours a week; the frame holds four a day around the break, the
    # spanless half is not bound by it, and the week is fine.
    assert solver._clique_hours_verdict(request) is None
    verdict, _ = solver._lunch_stage_one(request)
    assert verdict is None
    assert solver.solve(request).status in ("OPTIMAL", "FEASIBLE")


def test_the_clique_still_refuses_when_the_years_agree() -> None:
    """The control: group and requirement both say 4-4, the frame closes at
    12:30, and 25 hours a week do not fit four a day. Refused by counting, as
    before — the fix widened nothing it should not have."""
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    solver = SchedulerSolver(_settings())
    payload = _one_class(group_span=(4, 4), requirement_spans=[(4, 4)], lessons_per_week=25,
                         frame=(4, 4, "08:00", "12:30"))
    verdict = solver._clique_hours_verdict(OptimizeScheduleRequest.model_validate(payload))

    assert verdict is not None
    assert "1500 minutes" in verdict.conflicts[0].message
