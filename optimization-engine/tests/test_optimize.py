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
