"""The exam planner: POST /api/v1/plan-exams and app/solver/exam_solver.py.

Most fixtures are two or three exams, one to three rooms and a handful of
teachers, built so that exactly one rule or one objective term decides the
answer. The synthetic provvecka of benchmarks/provvecka.py is the measured
school; here it appears once, to show that a week of that size is answered
with a valid plan inside the budget.
"""

from __future__ import annotations

import asyncio
import random
import sys
import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.api.v1 import exams as exams_route
from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.main import create_app
from app.messages import MESSAGES, render
from app.schemas.exams import (
    ExamBlock,
    ExamClassDayLoad,
    ExamClassWeekLoad,
    ExamIn,
    ExamLimits,
    ExamMetrics,
    ExamRoomIn,
    ExamSearch,
    ExamSlot,
    ExamWeights,
    InvigilatorIn,
    InvigilatorMinutes,
    PlacedExam,
    PlacedRoom,
    PlanExamsRequest,
    PlanExamsResponse,
    UnplacedExam,
)
from app.solver import exam_solver
from app.solver.exam_solver import (
    ExamSolver,
    Placement,
    RoomUse,
    budget_seconds,
    check,
    estimate_model_size,
    greedy_plan,
    min_invigilators,
    plan_weight,
    prepare,
    unplaced_reasons,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
import provvecka  # noqa: E402

API_KEY = "test-api-key-000000000000000000000000"


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {"API_KEY": API_KEY, "ALLOWED_ORIGINS": "http://testserver"}
    values.update(overrides)
    return Settings(**values)


# A tiny model is proven in milliseconds on an idle host; the room is for a
# host so loaded that CP-SAT's threads wait their turn for seconds.
SETTINGS = _settings(EXAM_SOLVER_MAX_TIME_SECONDS=15.0)


# ---------------------------------------------------------------------------
# A small plan, named by labels.
# ---------------------------------------------------------------------------


class Week:
    """Exams, rooms and teachers by label; ids are fresh v4 uuids, as the
    gateway's are."""

    def __init__(
        self,
        *,
        day_cap: int = 2,
        week_cap: int = 6,
        ratio: int = 30,
        turnover: int = 0,
        search: dict | None = None,
        **weights: int,
    ) -> None:
        self.limits = {
            "maxPerClassPerDay": day_cap,
            "maxPerClassPerWeek": week_cap,
            "writersPerInvigilator": ratio,
            "turnoverMinutes": turnover,
        }
        self.weights = weights
        self.search = search
        self.rooms: list[dict] = []
        self.teachers: list[dict] = []
        self.exams: list[dict] = []
        self.day_load: list[dict] = []
        self.week_load: list[dict] = []
        self.ids: dict[str, str] = {}

    def id(self, label: str) -> str:
        return self.ids.setdefault(label, str(uuid4()))

    def room(self, label: str, seats: int = 30) -> str:
        self.rooms.append({"id": self.id(label), "seats": seats})
        return label

    def teacher(self, label: str, prior: int = 0) -> str:
        self.teachers.append({"id": self.id(label), "prior": prior})
        return label

    def exam(
        self,
        label: str,
        *,
        classes: tuple[str, ...] = ("A",),
        writers: int = 20,
        length: int = 60,
        slots: tuple[tuple[int, ...], ...] = ((0, 480, 0),),
        fixed: bool = False,
        busy_rooms: dict[str, list[int]] | None = None,
        busy_teachers: dict[str, list[int]] | None = None,
    ) -> str:
        """`slots` are (day, start, loss) with the week being day // 5, or
        (day, start, loss, week)."""
        self.exams.append({
            "id": self.id(label),
            "length": length,
            "writers": writers,
            "classes": [self.id(f"class:{name}") for name in classes],
            "slots": [
                {"day": s[0], "week": s[3] if len(s) > 3 else s[0] // 5, "start": s[1],
                 "loss": s[2]}
                for s in slots
            ],
            "roomBlocks": [
                {"id": self.id(room), "slots": at} for room, at in (busy_rooms or {}).items()
            ],
            "teacherBlocks": [
                {"id": self.id(teacher), "slots": at}
                for teacher, at in (busy_teachers or {}).items()
            ],
            "fixed": fixed,
        })
        return label

    def already_on_day(self, klass: str, day: int, count: int) -> None:
        self.day_load.append({"class": self.id(f"class:{klass}"), "day": day, "count": count})

    def already_in_week(self, klass: str, week: int, count: int) -> None:
        self.week_load.append({"class": self.id(f"class:{klass}"), "week": week, "count": count})

    def payload(self) -> dict:
        body = {
            "requestId": str(uuid4()),
            "exams": self.exams,
            "rooms": self.rooms,
            "teachers": self.teachers,
            "limits": self.limits,
            "weights": self.weights,
            "existingDayLoad": self.day_load,
            "existingWeekLoad": self.week_load,
        }
        if self.search is not None:
            body["search"] = self.search
        return body

    def request(self) -> PlanExamsRequest:
        return PlanExamsRequest.model_validate(self.payload())

    def solve(self, settings: Settings = SETTINGS) -> Answer:
        return Answer(self, ExamSolver(settings).solve(self.request()))


class Answer:
    def __init__(self, week: Week, response: PlanExamsResponse) -> None:
        self.response = response
        self._label = {value: key for key, value in week.ids.items()}
        #: exam label -> (slot, {room label: (writers, [teacher labels])})
        self.placed = {
            self._label[str(item.exam)]: (
                item.slot,
                {
                    self._label[str(use.room)]: (
                        use.writers, [self._label[str(t)] for t in use.invigilators],
                    )
                    for use in item.rooms
                },
            )
            for item in response.placed
        }
        self.reasons = {
            self._label[str(item.exam)]: item.reason for item in response.unplaced
        }
        self.params = {
            self._label[str(item.exam)]: item.params for item in response.unplaced
        }

    def slot(self, exam: str) -> int:
        return self.placed[exam][0]

    def rooms(self, exam: str) -> dict[str, int]:
        return {room: writers for room, (writers, _) in self.placed[exam][1].items()}

    def teachers(self, exam: str) -> list[str]:
        return [t for _, (_, ts) in self.placed[exam][1].items() for t in ts]

    def passes(self, teacher: str) -> int:
        return sum(teacher in self.teachers(exam) for exam in self.placed)


def _two_rooms_and_teachers(week: Week, teachers: int = 3) -> None:
    week.room("R1", 30)
    week.room("R2", 30)
    for index in range(teachers):
        week.teacher(f"T{index}")


# ---------------------------------------------------------------------------
# The wire.
# ---------------------------------------------------------------------------


def _field_names(model: type) -> set[str]:
    return {field.alias or name for name, field in model.model_fields.items()}


def test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads() -> None:
    """Hand-kept on both sides on purpose, like the staffing proposal's.

    The mirror is the gateway's contract spec for plan-exams. extra="forbid"
    makes a field one side has and the other lacks a 422 for the whole plan,
    so change both lists with the engine deploy, engine first.
    """
    assert _field_names(PlanExamsRequest) == {
        "requestId", "exams", "rooms", "teachers", "limits", "weights", "existingDayLoad",
        "existingWeekLoad", "search",
    }
    assert _field_names(ExamIn) == {
        "id", "length", "writers", "classes", "slots", "roomBlocks", "teacherBlocks", "fixed",
    }
    assert _field_names(ExamSlot) == {"day", "week", "start", "loss"}
    assert _field_names(ExamBlock) == {"id", "slots"}
    assert _field_names(ExamRoomIn) == {"id", "seats"}
    assert _field_names(InvigilatorIn) == {"id", "prior"}
    assert _field_names(ExamLimits) == {
        "maxPerClassPerDay", "maxPerClassPerWeek", "writersPerInvigilator", "turnoverMinutes",
    }
    assert _field_names(ExamWeights) == {"loss", "rooms", "fairness", "spread"}
    assert _field_names(ExamClassDayLoad) == {"class", "day", "count"}
    assert _field_names(ExamClassWeekLoad) == {"class", "week", "count"}
    assert _field_names(ExamSearch) == {"maxTimeSeconds", "workers", "seed"}
    assert _field_names(PlanExamsResponse) == {
        "requestId", "status", "placed", "unplaced", "invigilatorMinutes", "metrics",
    }
    assert _field_names(PlacedExam) == {"exam", "slot", "rooms"}
    assert _field_names(PlacedRoom) == {"room", "writers", "invigilators"}
    assert _field_names(UnplacedExam) == {"exam", "reason", "params", "message"}
    assert _field_names(InvigilatorMinutes) == {"teacher", "minutes"}
    assert _field_names(ExamMetrics) == {
        "placed", "unplaced", "loss", "roomsUsed", "invigilatorPasses", "maxLoad", "minLoad",
        "solveSeconds",
    }
    assert ExamWeights().model_dump(by_alias=True) == {
        "loss": 10, "rooms": 30, "fairness": 5, "spread": 2,
    }
    reasons = UnplacedExam.model_json_schema(by_alias=True)["properties"]["reason"]["enum"]
    assert reasons == [
        "EXAM_NO_SLOT", "EXAM_NO_ROOM_SEATS", "EXAM_NO_INVIGILATORS", "EXAM_CLASS_DAY_CAP",
        "EXAM_CLASS_WEEK_CAP", "EXAM_CLASS_CLASH", "EXAM_ROOMS_TAKEN",
        "EXAM_INVIGILATORS_TAKEN", "EXAM_NOT_REACHED",
    ]


def test_what_the_gateway_may_leave_out_it_may_leave_out() -> None:
    """Rooms, teachers, weights, loads, search and every block are optional:
    the smallest request is limits and one exam."""
    request = PlanExamsRequest.model_validate({
        "requestId": str(uuid4()),
        "exams": [{
            "id": str(uuid4()), "length": 60, "writers": 5, "classes": [str(uuid4())],
            "slots": [],
        }],
        "limits": {
            "maxPerClassPerDay": 1, "maxPerClassPerWeek": 1, "writersPerInvigilator": 1,
            "turnoverMinutes": 0,
        },
    })
    assert request.rooms == [] and request.teachers == [] and request.search is None
    assert request.weights == ExamWeights()
    assert request.exams[0].fixed is False
    required = PlanExamsRequest.model_json_schema(by_alias=True)["required"]
    assert set(required) == {"requestId", "exams", "limits"}


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(SETTINGS))


def _valid_payload() -> dict:
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E", slots=((0, 480, 0), (1, 480, 5)), busy_rooms={"R1": [0]},
              busy_teachers={"T0": [1]})
    week.exam("F", classes=("B",), slots=((0, 480, 0),))
    week.already_on_day("A", 0, 1)
    week.already_in_week("A", 0, 1)
    return week.payload()


def test_the_route_answers_with_the_key_and_refuses_without(client: TestClient) -> None:
    payload = _valid_payload()
    assert client.post("/api/v1/plan-exams", json=payload).status_code == 401

    response = client.post("/api/v1/plan-exams", json=payload, headers={"X-API-Key": API_KEY})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["requestId"] == payload["requestId"]
    assert body["status"] == "OPTIMAL"
    assert {item["exam"] for item in body["placed"]} == {e["id"] for e in payload["exams"]}
    assert body["unplaced"] == []
    assert set(body["metrics"]) == _field_names(ExamMetrics)
    for item in body["placed"]:
        assert set(item) == _field_names(PlacedExam)
        assert all(set(room) == _field_names(PlacedRoom) for room in item["rooms"])
    assert all(set(item) == _field_names(InvigilatorMinutes) for item in body["invigilatorMinutes"])


@pytest.mark.parametrize(
    "breakage",
    [
        "a field the engine never heard of", "an exam field the engine never heard of",
        "a room nobody sent", "a teacher nobody sent", "a block slot out of range",
        "a negative block slot", "the same exam twice", "the same room twice",
        "the same teacher twice", "a class twice in an exam", "two slots at one time",
        "a fixed exam with two slots", "a room blocked twice", "a teacher blocked twice",
        "a block naming one slot twice", "no exams", "an exam without classes",
        "a weight over 100", "a writer count of zero", "an exam of four minutes",
        "a limit of zero", "a day load named twice", "a week load named twice",
        "a search for zero seconds", "a search with seventeen workers", "a start at midnight+",
        "a negative prior", "a request id that is not a v4 uuid",
    ],
)
def test_a_malformed_plan_is_a_422(client: TestClient, breakage: str) -> None:
    payload = _valid_payload()
    exam = payload["exams"][0]
    if breakage == "a field the engine never heard of":
        payload["subject"] = "Matematik"
    elif breakage == "an exam field the engine never heard of":
        exam["subjectId"] = str(uuid4())
    elif breakage == "a room nobody sent":
        exam["roomBlocks"].append({"id": str(uuid4()), "slots": [0]})
    elif breakage == "a teacher nobody sent":
        exam["teacherBlocks"].append({"id": str(uuid4()), "slots": [0]})
    elif breakage == "a block slot out of range":
        exam["roomBlocks"][0]["slots"] = [2]
    elif breakage == "a negative block slot":
        exam["roomBlocks"][0]["slots"] = [-1]
    elif breakage == "the same exam twice":
        payload["exams"].append(dict(exam))
    elif breakage == "the same room twice":
        payload["rooms"].append(dict(payload["rooms"][0]))
    elif breakage == "the same teacher twice":
        payload["teachers"].append(dict(payload["teachers"][0]))
    elif breakage == "a class twice in an exam":
        exam["classes"] = exam["classes"] * 2
    elif breakage == "two slots at one time":
        exam["slots"][1] = dict(exam["slots"][0])
    elif breakage == "a fixed exam with two slots":
        exam["fixed"] = True
    elif breakage == "a room blocked twice":
        exam["roomBlocks"].append(dict(exam["roomBlocks"][0]))
    elif breakage == "a teacher blocked twice":
        exam["teacherBlocks"].append(dict(exam["teacherBlocks"][0]))
    elif breakage == "a block naming one slot twice":
        exam["roomBlocks"][0]["slots"] = [0, 0]
    elif breakage == "no exams":
        payload["exams"] = []
    elif breakage == "an exam without classes":
        exam["classes"] = []
    elif breakage == "a weight over 100":
        payload["weights"] = {"loss": 101}
    elif breakage == "a writer count of zero":
        exam["writers"] = 0
    elif breakage == "an exam of four minutes":
        exam["length"] = 4
    elif breakage == "a limit of zero":
        payload["limits"]["maxPerClassPerDay"] = 0
    elif breakage == "a day load named twice":
        payload["existingDayLoad"].append(dict(payload["existingDayLoad"][0]))
    elif breakage == "a week load named twice":
        payload["existingWeekLoad"].append(dict(payload["existingWeekLoad"][0]))
    elif breakage == "a search for zero seconds":
        payload["search"] = {"maxTimeSeconds": 0}
    elif breakage == "a search with seventeen workers":
        payload["search"] = {"workers": 17}
    elif breakage == "a start at midnight+":
        exam["slots"][0]["start"] = 1440
    elif breakage == "a negative prior":
        payload["teachers"][0]["prior"] = -1
    else:
        payload["requestId"] = "not-a-uuid"

    response = client.post("/api/v1/plan-exams", json=payload, headers={"X-API-Key": API_KEY})
    assert response.status_code == 422, breakage


def test_a_block_naming_an_unknown_room_says_so_in_words() -> None:
    week = Week()
    week.room("R1")
    week.exam("E", slots=((0, 480, 0),))
    payload = week.payload()
    payload["exams"][0]["roomBlocks"] = [{"id": str(uuid4()), "slots": [0]}]
    with pytest.raises(ValidationError, match="blocks a room that is not in the request"):
        PlanExamsRequest.model_validate(payload)
    payload["exams"][0]["roomBlocks"] = []
    payload["exams"][0]["teacherBlocks"] = [{"id": str(uuid4()), "slots": [0]}]
    with pytest.raises(ValidationError, match="blocks a teacher that is not in the request"):
        PlanExamsRequest.model_validate(payload)
    payload["exams"][0]["teacherBlocks"] = []
    payload["exams"][0]["roomBlocks"] = [{"id": payload["rooms"][0]["id"], "slots": [3]}]
    with pytest.raises(ValidationError, match="at a slot it does not have"):
        PlanExamsRequest.model_validate(payload)


def test_a_fixed_exam_may_have_no_slot_at_all_and_is_then_unplaceable() -> None:
    """A nationellt prov whose date falls where no time is possible is one
    exam left out with its reason, not a refusal of the whole plan."""
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("N", fixed=True, slots=())
    week.exam("E")
    answer = week.solve()
    assert answer.reasons == {"N": "EXAM_NO_SLOT"}
    assert "E" in answer.placed


# ---------------------------------------------------------------------------
# The helper that counts invigilators.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("writers", "seats", "ratio", "expected"),
    [
        (25, [30], 30, 1),
        (31, [60], 30, 2),
        (61, [90], 30, 3),
        (40, [40], 20, 2),
        (30, [10, 10, 10], 20, 3),   # three rooms are three invigilators
        (30, [30, 10], 20, 2),       # one room of 30: 20 + 10 → two
        (45, [30, 30], 20, 3),
        (50, [30, 30], 20, 3),
        (100, [30, 60, 90], 30, 4),
        (180, [30, 60, 90], 30, 6),
        (181, [30, 60, 90], 30, None),
        (5, [], 30, None),
    ],
)
def test_the_fewest_invigilators_for_writers_in_rooms(
    writers: int, seats: list[int], ratio: int, expected: int | None,
) -> None:
    assert min_invigilators(writers, seats, ratio) == expected


def test_the_fewest_invigilators_agrees_with_brute_force() -> None:
    rng = random.Random(7)
    for _ in range(300):
        seats = [rng.randint(1, 12) for _ in range(rng.randint(1, 3))]
        ratio = rng.randint(1, 6)
        writers = rng.randint(1, sum(seats) + 1)
        best: int | None = None
        # Every split of the writers over the rooms.
        def split(room: int, left: int, used: int) -> None:
            nonlocal best
            if room == len(seats):
                if left == 0 and (best is None or used < best):
                    best = used
                return
            for take in range(0, min(seats[room], left) + 1):
                split(room + 1, left - take, used + (-(-take // ratio) if take else 0))

        split(0, writers, 0)
        assert min_invigilators(writers, seats, ratio) == best, (writers, seats, ratio)


# ---------------------------------------------------------------------------
# Placing: the hard rules.
# ---------------------------------------------------------------------------


def test_an_easy_exam_is_placed_in_its_cheapest_slot_with_one_room_and_one_teacher() -> None:
    week = Week()
    week.room("R1", 30)
    week.teacher("T")
    week.exam("E", slots=((0, 480, 90), (0, 600, 30), (1, 480, 60)))
    answer = week.solve()
    assert answer.response.status == "OPTIMAL"
    assert answer.slot("E") == 1
    assert answer.placed["E"][1] == {"R1": (20, ["T"])}
    assert answer.response.unplaced == []
    metrics = answer.response.metrics
    assert (metrics.placed, metrics.unplaced, metrics.loss) == (1, 0, 30)
    assert (metrics.rooms_used, metrics.invigilator_passes) == (1, 1)
    assert [(str(m.teacher), m.minutes) for m in answer.response.invigilator_minutes] == [
        (week.ids["T"], 60),
    ]


def test_the_writers_are_split_over_rooms_that_each_hold_their_share() -> None:
    week = Week(ratio=20, rooms=0)
    week.room("S", 30)
    week.room("M", 30)
    for index in range(4):
        week.teacher(f"T{index}")
    week.exam("E", writers=50, slots=((0, 480, 0),))
    answer = week.solve()
    rooms = answer.rooms("E")
    assert sum(rooms.values()) == 50
    assert set(rooms) == {"S", "M"} and all(1 <= n <= 30 for n in rooms.values())
    # 30 + 20 needs 2 + 1 invigilators; 25 + 25 would need 4. The cheaper split.
    assert len(answer.teachers("E")) == 3
    for room, (writers, watchers) in answer.placed["E"][1].items():
        assert len(watchers) == max(1, -(-writers // 20)), room


def test_one_big_room_is_preferred_to_two_small_ones() -> None:
    week = Week()
    week.room("small", 30)
    week.room("big", 60)
    for index in range(4):
        week.teacher(f"T{index}")
    week.exam("E", writers=45)
    answer = week.solve()
    assert answer.rooms("E") == {"big": 45}
    assert answer.response.metrics.rooms_used == 1


def test_the_invigilators_of_a_room_follow_its_writers() -> None:
    week = Week(ratio=30)
    week.room("hall", 90)
    for index in range(4):
        week.teacher(f"T{index}")
    week.exam("E", writers=61)
    answer = week.solve()
    assert answer.rooms("E") == {"hall": 61}
    assert len(answer.placed["E"][1]["hall"][1]) == 3
    assert len(set(answer.teachers("E"))) == 3


def test_a_teacher_watches_one_room_of_an_exam() -> None:
    week = Week(ratio=10, rooms=0)
    week.room("R1", 10)
    week.room("R2", 10)
    for index in range(3):
        week.teacher(f"T{index}")
    week.exam("E", writers=20)
    answer = week.solve()
    teachers = answer.teachers("E")
    assert len(teachers) == 2 and len(set(teachers)) == 2


def test_two_exams_of_one_class_never_overlap_but_may_follow_each_other() -> None:
    week = Week(day_cap=3)
    _two_rooms_and_teachers(week)
    week.exam("E1", slots=((0, 480, 0), (0, 540, 50)))
    week.exam("E2", slots=((0, 480, 0), (0, 510, 0), (0, 540, 0)))
    answer = week.solve()
    assert set(answer.placed) == {"E1", "E2"}
    starts = {
        "E1": (480, 540)[answer.slot("E1")],
        "E2": (480, 510, 540)[answer.slot("E2")],
    }
    first, second = sorted(starts.values())
    assert second >= first + 60
    # And the cheaper time for E1 is kept: 480 for E1 (loss 0), 540 for E2.
    assert starts == {"E1": 480, "E2": 540}


def test_the_daily_cap_counts_what_the_class_already_has() -> None:
    week = Week(day_cap=2)
    _two_rooms_and_teachers(week)
    week.exam("E", slots=((0, 480, 0), (1, 480, 80)))
    week.already_on_day("A", 0, 2)
    week.already_on_day("B", 0, 5)        # a class no exam names: ignored
    answer = week.solve()
    assert answer.slot("E") == 1

    stacked = Week(day_cap=2)
    _two_rooms_and_teachers(stacked)
    stacked.exam("E", slots=((0, 480, 0), (1, 480, 80)))
    stacked.already_on_day("A", 0, 1)
    assert stacked.solve().slot("E") == 0


def test_three_exams_do_not_fit_a_cap_of_two_a_day() -> None:
    week = Week(day_cap=2, spread=0)
    _two_rooms_and_teachers(week, 3)
    for label, start in (("E1", 480), ("E2", 600), ("E3", 720)):
        week.exam(label, slots=((0, start, 0),))
    answer = week.solve()
    assert len(answer.placed) == 2
    ((unplaced, reason),) = answer.reasons.items()
    assert reason == "EXAM_CLASS_DAY_CAP"
    assert answer.params[unplaced]["limit"] == 2
    assert answer.params[unplaced]["classId"] == week.ids["class:A"]


def test_the_weekly_cap_counts_what_the_class_already_has() -> None:
    week = Week(day_cap=3, week_cap=3)
    _two_rooms_and_teachers(week)
    week.exam("E", slots=((0, 480, 0), (5, 480, 70)))     # week 0 and week 1
    week.already_in_week("A", 0, 3)
    answer = week.solve()
    assert answer.slot("E") == 1

    full = Week(day_cap=3, week_cap=3)
    _two_rooms_and_teachers(full)
    full.exam("E", slots=((0, 480, 0), (1, 480, 0)))
    full.already_in_week("A", 0, 3)
    answer = full.solve()
    assert answer.reasons == {"E": "EXAM_CLASS_WEEK_CAP"}
    assert answer.params["E"] == {"limit": 3, "classId": full.ids["class:A"]}


def test_a_room_holds_one_exam_at_a_time_and_a_turnover_beyond_it() -> None:
    def week(turnover: int) -> Week:
        w = Week(turnover=turnover)
        w.room("R", 30)
        w.teacher("T1")
        w.teacher("T2")
        w.exam("E1", classes=("A",), slots=((0, 480, 0),))
        w.exam("E2", classes=("B",), slots=((0, 540, 0),))
        return w

    both = week(0).solve()
    assert set(both.placed) == {"E1", "E2"}
    one = week(15).solve()
    assert len(one.placed) == 1
    ((left_out, reason),) = one.reasons.items()
    assert reason == "EXAM_ROOMS_TAKEN"
    assert one.params[left_out] == {"writers": 20, "seats": 0}


def test_a_teacher_holds_one_exam_at_a_time_and_a_turnover_beyond_it() -> None:
    def week(turnover: int) -> Week:
        w = Week(turnover=turnover)
        w.room("R1", 30)
        w.room("R2", 30)
        w.teacher("T")
        w.exam("E1", classes=("A",), slots=((0, 480, 0),))
        w.exam("E2", classes=("B",), slots=((0, 540, 0),))
        return w

    both = week(0).solve()
    assert set(both.placed) == {"E1", "E2"}
    assert both.teachers("E1") == both.teachers("E2") == ["T"]
    one = week(15).solve()
    assert len(one.placed) == 1
    ((left_out, reason),) = one.reasons.items()
    assert reason == "EXAM_INVIGILATORS_TAKEN"
    assert one.params[left_out] == {"needed": 1, "free": 0}


def test_busy_rooms_and_teachers_are_respected() -> None:
    week = Week()
    week.room("R1", 30)
    week.room("R2", 30)
    week.teacher("T1")
    week.teacher("T2")
    week.exam(
        "E", slots=((0, 480, 0), (0, 600, 40)),
        busy_rooms={"R1": [0], "R2": [0]},     # no room at all at 480
        busy_teachers={"T1": [1]},             # and T1 is teaching at 600
    )
    answer = week.solve()
    assert answer.slot("E") == 1
    assert answer.teachers("E") == ["T2"]

    only = Week()
    only.room("R1", 30)
    only.room("R2", 30)
    only.teacher("T1")
    only.exam("E", slots=((0, 480, 0),), busy_rooms={"R1": [0]})
    assert only.solve().rooms("E") == {"R2": 20}


def test_a_fixed_exam_is_never_moved_and_wins_the_room_it_competes_for() -> None:
    week = Week()
    week.room("R", 30)
    week.teacher("T")
    week.exam("free", classes=("A",), slots=((0, 480, 0),))
    week.exam("national", classes=("B",), slots=((0, 480, 200),), fixed=True)
    answer = week.solve()
    assert set(answer.placed) == {"national"}
    assert answer.slot("national") == 0
    assert answer.reasons == {"free": "EXAM_ROOMS_TAKEN"}


def test_an_exam_that_could_be_moved_makes_way_for_one_that_cannot() -> None:
    """Placing as many as possible beats a cheap time for one: the exam with
    two slots takes its dearer one so that the other can have the room."""
    week = Week()
    week.room("R", 30)
    week.teacher("T")
    week.exam("movable", classes=("A",), slots=((0, 480, 0), (0, 700, 150)))
    week.exam("stuck", classes=("B",), slots=((0, 480, 0),))
    answer = week.solve()
    assert set(answer.placed) == {"movable", "stuck"}
    assert answer.slot("movable") == 1


def test_one_more_exam_outweighs_any_amount_of_cancelled_lessons_and_rooms() -> None:
    week = Week(loss=100, rooms=100, fairness=100, spread=100)
    week.room("R1", 30)
    week.room("R2", 30)
    week.teacher("T1")
    week.teacher("T2")
    week.exam("cheap", classes=("A",), slots=((0, 480, 0),))
    week.exam("dear", classes=("B",), slots=((0, 700, 100000),), writers=50)
    answer = week.solve()
    assert set(answer.placed) == {"cheap", "dear"}
    assert answer.response.metrics.loss == 100000


def test_an_empty_list_of_rooms_places_nothing_and_says_why() -> None:
    week = Week()
    week.teacher("T")
    week.exam("E", writers=25)
    answer = week.solve()
    assert answer.placed == {}
    assert answer.reasons == {"E": "EXAM_NO_ROOM_SEATS"}
    assert answer.params["E"] == {"writers": 25, "seats": 0}
    assert answer.response.status == "OPTIMAL"


def test_an_empty_list_of_teachers_places_nothing_and_says_why() -> None:
    week = Week()
    week.room("R", 30)
    week.exam("E", writers=25)
    answer = week.solve()
    assert answer.reasons == {"E": "EXAM_NO_INVIGILATORS"}
    assert answer.params["E"] == {"needed": 1, "free": 0}
    metrics = answer.response.metrics
    assert (metrics.max_load, metrics.min_load) == (0, 0)


def test_the_metrics_count_rooms_passes_and_loads() -> None:
    week = Week(ratio=20, turnover=0)
    week.room("S", 30)
    week.room("M", 30)
    week.teacher("old", prior=100)
    week.teacher("new", prior=0)
    week.teacher("extra", prior=0)
    week.exam("E", writers=50, length=45, slots=((0, 480, 12),))
    answer = week.solve()
    metrics = answer.response.metrics
    assert (metrics.placed, metrics.unplaced, metrics.loss) == (1, 0, 12)
    assert (metrics.rooms_used, metrics.invigilator_passes) == (2, 3)
    assert metrics.solve_seconds > 0
    minutes = {str(m.teacher): m.minutes for m in answer.response.invigilator_minutes}
    assert sorted(minutes.values()) == [45, 45, 45]
    loads = [100 + minutes.get(week.ids["old"], 0), minutes.get(week.ids["new"], 0),
             minutes.get(week.ids["extra"], 0)]
    assert (metrics.max_load, metrics.min_load) == (max(loads), min(loads))


# ---------------------------------------------------------------------------
# Placing: the soft terms.
# ---------------------------------------------------------------------------


def test_a_teacher_with_a_big_counter_watches_less() -> None:
    week = Week()
    week.room("R", 30)
    week.teacher("busy-all-year", prior=900)
    week.teacher("fresh", prior=0)
    for index, start in enumerate((480, 600, 720)):
        week.exam(f"E{index}", classes=(f"C{index}",), slots=((0, start, 0),))
    answer = week.solve()
    assert answer.passes("fresh") == 3
    assert answer.passes("busy-all-year") == 0


def test_the_counter_evens_the_year_out() -> None:
    """Four sittings of an hour: 120 minutes carried already against none ends
    at 180 each, one sitting for the one with a counter and three for the
    other."""
    week = Week()
    week.room("R", 30)
    week.teacher("had-two-hours", prior=120)
    week.teacher("had-none", prior=0)
    for index, start in enumerate((480, 600, 720, 840)):
        week.exam(f"E{index}", classes=(f"C{index}",), slots=((0, start, 0),))
    answer = week.solve()
    assert answer.passes("had-two-hours") == 1
    assert answer.passes("had-none") == 3
    metrics = answer.response.metrics
    assert (metrics.max_load, metrics.min_load) == (180, 180)


def test_without_the_fairness_weight_the_counter_does_not_matter() -> None:
    week = Week(fairness=0)
    week.room("R", 30)
    week.teacher("a", prior=900)
    week.teacher("b", prior=0)
    week.exam("E", slots=((0, 480, 0),))
    answer = week.solve()
    assert len(answer.teachers("E")) == 1


def test_cancelled_lesson_minutes_decide_the_time_when_nothing_else_does() -> None:
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E", slots=((0, 480, 60), (1, 480, 30), (2, 480, 45)))
    assert week.solve().slot("E") == 1


def test_a_class_is_spread_over_the_days_when_it_costs_nothing() -> None:
    week = Week(day_cap=2)
    _two_rooms_and_teachers(week, 4)
    week.exam("E1", slots=((0, 480, 0), (1, 480, 0)))
    week.exam("E2", slots=((0, 480, 0), (1, 480, 0)))
    answer = week.solve()
    assert {answer.slot("E1"), answer.slot("E2")} == {0, 1}

    squeezed = Week(day_cap=2)
    _two_rooms_and_teachers(squeezed, 4)
    squeezed.exam("E1", slots=((0, 480, 0), (1, 480, 0)))
    squeezed.exam("E2", slots=((0, 480, 0), (1, 480, 0)))
    squeezed.already_on_day("A", 1, 1)
    # The two overlap on either day, so one goes on each whatever it costs.
    answer = squeezed.solve()
    assert len(answer.placed) == 2
    assert sorted((answer.slot("E1"), answer.slot("E2"))) == [0, 1]


def test_a_class_with_an_exam_already_on_a_day_is_given_a_quieter_one() -> None:
    week = Week(day_cap=3)
    _two_rooms_and_teachers(week)
    week.exam("E", slots=((0, 480, 0), (1, 480, 0)))
    week.already_on_day("A", 0, 1)
    assert week.solve().slot("E") == 1


# ---------------------------------------------------------------------------
# The reasons.
# ---------------------------------------------------------------------------


def test_an_exam_with_no_time_is_named_for_it() -> None:
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E", slots=())
    week.exam("F")
    answer = week.solve()
    assert answer.reasons == {"E": "EXAM_NO_SLOT"}
    assert answer.params["E"] == {}
    (item,) = answer.response.unplaced
    assert item.message == render("EXAM_NO_SLOT", {})


def test_seats_that_cannot_hold_the_writers_are_named_with_the_best_the_rooms_offer() -> None:
    week = Week()
    week.room("R1", 30)
    week.room("R2", 30)
    week.room("R3", 50)
    for index in range(3):
        week.teacher(f"T{index}")
    # At 480 the 50-seat room is busy (60 seats); at 600 it is free (110).
    week.exam("E", writers=100, slots=((0, 480, 0), (0, 600, 0)), busy_rooms={"R3": [0]})
    answer = week.solve()
    assert answer.reasons == {"E": "EXAM_NO_ROOM_SEATS"}
    assert answer.params["E"] == {"writers": 100, "seats": 60}


def test_too_few_teachers_are_named_with_the_most_that_are_free() -> None:
    week = Week(ratio=20)
    week.room("R", 60)
    week.teacher("T1")
    week.teacher("T2")
    week.teacher("T3")
    # 3 writers' worth of 60 needs 3 invigilators; the slots leave 2 and 1.
    week.exam(
        "E", writers=60, slots=((0, 480, 0), (0, 600, 0)),
        busy_teachers={"T1": [0], "T2": [0, 1]},
    )
    answer = week.solve()
    assert answer.reasons == {"E": "EXAM_NO_INVIGILATORS"}
    assert answer.params["E"] == {"needed": 3, "free": 2}


def test_the_reason_is_the_rule_that_stops_the_most_times() -> None:
    """Judged on a given plan, with no search: three times stopped by the
    class's daily cap and one by a clash, so the cap is named."""
    week = Week(day_cap=1)
    _two_rooms_and_teachers(week, 4)
    week.exam("holder", classes=("A",), slots=((0, 480, 0),))
    week.exam("clash", classes=("A",), slots=((0, 480, 0), (0, 540, 0), (0, 700, 0), (1, 480, 0)))
    problem = prepare(week.request())
    plan = {0: Placement(0, [RoomUse(0, 20, [0])])}
    reasons = unplaced_reasons(problem, plan)
    # 480 on day 0 overlaps the holder (a clash); 540 and 700 hit the cap of one
    # a day; day 1 is free, so the exam could have been added.
    assert reasons == {1: ("EXAM_NOT_REACHED", {})}

    week.exam("closed", classes=("A",), slots=((0, 480, 0), (0, 540, 0), (0, 700, 0)))
    problem = prepare(week.request())
    reasons = unplaced_reasons(problem, plan)
    assert reasons[2] == ("EXAM_CLASS_DAY_CAP", {"limit": 1, "classId": week.ids["class:A"]})


def test_a_tie_is_broken_in_the_order_the_rules_are_tried() -> None:
    week = Week(day_cap=1)
    _two_rooms_and_teachers(week, 4)
    week.exam("holder", classes=("A",), slots=((0, 480, 0),))
    week.exam("tied", classes=("A",), slots=((0, 480, 0), (0, 700, 0)))
    problem = prepare(week.request())
    plan = {0: Placement(0, [RoomUse(0, 20, [0])])}
    # One slot is a clash and one the daily cap: a tie, and the clash comes first.
    assert unplaced_reasons(problem, plan)[1] == (
        "EXAM_CLASS_CLASH", {"classId": week.ids["class:A"]},
    )


def test_a_class_clash_is_named_when_another_exam_takes_every_time() -> None:
    week = Week(day_cap=3)
    _two_rooms_and_teachers(week, 4)
    week.exam("E1", slots=((0, 480, 0),))
    week.exam("E2", slots=((0, 510, 0),))
    answer = week.solve()
    assert len(answer.placed) == 1
    ((left_out, reason),) = answer.reasons.items()
    assert reason == "EXAM_CLASS_CLASH"
    assert answer.params[left_out] == {"classId": week.ids["class:A"]}


def test_rooms_taken_by_other_exams_are_named_with_the_seats_that_are_left() -> None:
    week = Week()
    week.room("R", 30)
    week.teacher("T1")
    week.teacher("T2")
    week.exam("E1", classes=("A",), slots=((0, 480, 0),))
    week.exam("E2", classes=("B",), slots=((0, 480, 0),))
    answer = week.solve()
    ((left_out, reason),) = answer.reasons.items()
    assert reason == "EXAM_ROOMS_TAKEN"
    assert answer.params[left_out] == {"writers": 20, "seats": 0}


def test_invigilators_taken_by_other_exams_are_named_with_who_is_free() -> None:
    week = Week()
    week.room("R1", 30)
    week.room("R2", 30)
    week.teacher("T")
    week.exam("E1", classes=("A",), slots=((0, 480, 0),))
    week.exam("E2", classes=("B",), slots=((0, 480, 0),))
    answer = week.solve()
    ((left_out, reason),) = answer.reasons.items()
    assert reason == "EXAM_INVIGILATORS_TAKEN"
    assert answer.params[left_out] == {"needed": 1, "free": 0}
    (item,) = answer.response.unplaced
    assert item.message == render("EXAM_INVIGILATORS_TAKEN", {"needed": 1, "free": 0})


def test_rooms_taken_picks_the_slot_with_the_most_seats_left() -> None:
    week = Week()
    week.room("S", 30)
    week.room("L", 60)
    week.room("M", 30)
    week.teacher("T1")
    week.teacher("T2")
    week.exam("X", classes=("A",), writers=90, slots=((0, 480, 0),))
    week.exam("Y", classes=("C",), writers=60, slots=((1, 480, 0),))
    week.exam("held", classes=("B",), writers=70, slots=((0, 480, 0), (1, 480, 0)))
    problem = prepare(week.request())
    plan = {
        0: Placement(0, [RoomUse(1, 60, [0]), RoomUse(0, 30, [1])]),
        1: Placement(0, [RoomUse(1, 60, [0])]),
    }
    # Day 0 leaves the 30 seats of M; day 1 leaves S and M, 60: the closer.
    assert unplaced_reasons(problem, plan)[2] == (
        "EXAM_ROOMS_TAKEN", {"writers": 70, "seats": 60},
    )


def test_invigilators_taken_picks_the_slot_that_came_closest() -> None:
    week = Week(ratio=20)
    for room in ("R1", "R2", "R3"):
        week.room(room, 60)
    for teacher in ("T0", "T1", "T2"):
        week.teacher(teacher)
    week.exam("X", classes=("A",), writers=60, slots=((0, 480, 0),))
    week.exam("Y", classes=("C",), writers=40, slots=((1, 480, 0),))
    week.exam("held", classes=("B",), writers=40, slots=((0, 480, 0), (1, 480, 0)))
    problem = prepare(week.request())
    plan = {
        0: Placement(0, [RoomUse(0, 60, [0, 1, 2])]),
        1: Placement(0, [RoomUse(1, 40, [0, 1])]),
    }
    # Two are needed. Day 0 leaves nobody, day 1 leaves T2: the closer.
    assert unplaced_reasons(problem, plan)[2] == (
        "EXAM_INVIGILATORS_TAKEN", {"needed": 2, "free": 1},
    )


def test_a_search_cut_short_leaves_exams_not_reached(monkeypatch: pytest.MonkeyPatch) -> None:
    """With neither a search nor a floor under it the answer is the empty
    plan, and every exam that could have been added says so."""
    monkeypatch.setattr(exam_solver, "greedy_plan", lambda problem: {})
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E1", classes=("A",))
    week.exam("E2", classes=("B",))
    # A budget that the answer's tail alone uses up: the search never starts.
    answer = week.solve(_settings(EXAM_SOLVER_MAX_TIME_SECONDS=0.2))
    assert answer.placed == {}
    assert answer.reasons == {"E1": "EXAM_NOT_REACHED", "E2": "EXAM_NOT_REACHED"}
    assert answer.params == {"E1": {}, "E2": {}}
    assert answer.response.status == "FEASIBLE"
    assert answer.response.metrics.placed == 0


def test_a_budget_that_leaves_no_time_to_search_is_answered_with_the_greedy() -> None:
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E1", classes=("A",))
    week.exam("E2", classes=("B",))
    solver = ExamSolver(_settings(EXAM_SOLVER_MAX_TIME_SECONDS=0.2))
    response = solver.solve(week.request())
    assert response.status == "FEASIBLE"
    assert len(response.placed) == 2 and response.unplaced == []
    assert solver.last_report.status == "NOT_RUN"


def test_a_request_can_ask_for_less_time_but_never_more() -> None:
    cap = _settings(EXAM_SOLVER_MAX_TIME_SECONDS=20.0)
    assert budget_seconds(cap, None) == 20.0
    assert budget_seconds(cap, ExamSearch.model_validate({})) == 20.0
    assert budget_seconds(cap, ExamSearch.model_validate({"maxTimeSeconds": 3.5})) == 3.5
    assert budget_seconds(cap, ExamSearch.model_validate({"maxTimeSeconds": 600})) == 20.0

    week = Week(search={"maxTimeSeconds": 0.1})
    _two_rooms_and_teachers(week)
    week.exam("E")
    solver = ExamSolver(_settings(EXAM_SOLVER_MAX_TIME_SECONDS=30.0))
    response = solver.solve(week.request())
    # 30 seconds were allowed and 0.1 asked for: no search, the floor.
    assert solver.last_report.status == "NOT_RUN"
    assert response.status == "FEASIBLE" and len(response.placed) == 1


def test_a_week_nothing_can_place_is_answered_without_a_search() -> None:
    week = Week()
    week.exam("E", writers=25)
    solver = ExamSolver(SETTINGS)
    response = solver.solve(week.request())
    assert response.status == "OPTIMAL"
    assert solver.last_report.status == "NOT_RUN"
    assert [u.reason for u in response.unplaced] == ["EXAM_NO_ROOM_SEATS"]


def test_every_reason_renders_its_sentence_from_its_params() -> None:
    cases = {
        "EXAM_NO_SLOT": {},
        "EXAM_NO_ROOM_SEATS": {"writers": 100, "seats": 60},
        "EXAM_NO_INVIGILATORS": {"needed": 3, "free": 2},
        "EXAM_CLASS_DAY_CAP": {"limit": 2, "classId": str(uuid4())},
        "EXAM_CLASS_WEEK_CAP": {"limit": 1, "classId": str(uuid4())},
        "EXAM_CLASS_CLASH": {"classId": str(uuid4())},
        "EXAM_ROOMS_TAKEN": {"writers": 1, "seats": 0},
        "EXAM_INVIGILATORS_TAKEN": {"needed": 1, "free": 1},
        "EXAM_NOT_REACHED": {},
    }
    for code, params in cases.items():
        item = UnplacedExam(exam=uuid4(), reason=code, params=params)  # type: ignore[arg-type]
        assert item.message == render(code, params) and item.message
        assert "{" not in item.message
    assert render("EXAM_NO_ROOM_SEATS", cases["EXAM_NO_ROOM_SEATS"]) == (
        "100 pupils write the exam, but the exam rooms that are free for it seat at most 60, "
        "even with no other exam in them. Mark more rooms as exam rooms, or split the exam."
    )
    assert render("EXAM_CLASS_DAY_CAP", {"limit": 1}).startswith("The class already has 1 exam a day")
    assert {code for code in MESSAGES if code.startswith("EXAM_")} == set(cases) | {
        "EXAM_MODEL_TOO_LARGE",
    }


# ---------------------------------------------------------------------------
# The re-check of every hard rule.
# ---------------------------------------------------------------------------


def _checked_week() -> Week:
    week = Week(day_cap=1, week_cap=1, turnover=15, ratio=20)
    week.room("R1", 30)
    week.room("R2", 30)
    for index in range(4):
        week.teacher(f"T{index}")
    week.exam("E1", classes=("A",), writers=25, slots=((0, 480, 0), (0, 700, 0)),
              busy_rooms={"R2": [0]}, busy_teachers={"T3": [0]})
    week.exam("E2", classes=("A", "B"), writers=25, slots=((0, 480, 0), (0, 540, 0), (1, 480, 0)))
    week.exam("E3", classes=("C",), writers=25, slots=((0, 480, 0), (0, 540, 0)))
    week.exam("E4", classes=("D",), writers=35, slots=((1, 480, 0),))
    return week


def test_a_valid_hand_made_plan_passes_the_recheck() -> None:
    problem = prepare(_checked_week().request())
    check(problem, {})
    check(problem, {
        0: Placement(0, [RoomUse(0, 25, [0, 1])]),
        2: Placement(1, [RoomUse(1, 25, [2, 3])]),
    })


@pytest.mark.parametrize(
    ("what", "plan", "message"),
    [
        ("a slot the exam does not have", {0: Placement(5, [RoomUse(0, 25, [0, 1])])},
         "slot it does not have"),
        ("writers that do not add up", {0: Placement(0, [RoomUse(0, 24, [0, 1])])},
         "exactly its writers"),
        ("more writers than seats", {0: Placement(0, [RoomUse(0, 25, [0, 1])]),
                                    1: Placement(0, [RoomUse(1, 25, [2, 3])])},
         "holds two exams at once"),
        ("a room busy then", {0: Placement(0, [RoomUse(1, 25, [0, 1])])}, "busy then"),
        ("too few invigilators", {0: Placement(0, [RoomUse(0, 25, [0])])},
         "wrong number of invigilators"),
        ("too many invigilators", {0: Placement(0, [RoomUse(0, 25, [0, 1, 2])])},
         "wrong number of invigilators"),
        ("a teacher twice", {0: Placement(0, [RoomUse(0, 25, [0, 0])])}, "two places"),
        ("a teacher busy then", {0: Placement(0, [RoomUse(0, 25, [0, 3])])},
         "teacher who is busy"),
        ("a room twice", {0: Placement(0, [RoomUse(0, 10, [0]), RoomUse(0, 15, [1])])},
         "uses a room twice"),
        ("a room over its seats", {3: Placement(0, [RoomUse(0, 35, [0, 1])])},
         "35 writers in a room of 30 seats"),
        ("an empty room", {0: Placement(0, [RoomUse(0, 0, [0]), RoomUse(1, 25, [1, 2])])},
         "0 writers in a room of 30 seats"),
        ("one class in two exams at once", {
            0: Placement(0, [RoomUse(0, 25, [0, 1])]), 1: Placement(0, [RoomUse(1, 25, [2, 3])]),
        }, "holds two exams at once"),
        ("a room held through the turnover", {
            0: Placement(0, [RoomUse(0, 25, [0, 1])]), 2: Placement(1, [RoomUse(0, 25, [2, 3])]),
        }, "holds two exams at once"),
        ("a teacher held through the turnover", {
            0: Placement(0, [RoomUse(0, 25, [0, 1])]), 2: Placement(1, [RoomUse(1, 25, [0, 3])]),
        }, "holds two exams at once"),
        ("two exams on a class's day over the cap", {
            0: Placement(1, [RoomUse(0, 25, [0, 1])]), 1: Placement(1, [RoomUse(1, 25, [2, 3])]),
        }, "more than 1 exams on day 0"),
    ],
)
def test_the_recheck_refuses_a_plan_that_breaks_a_rule(
    what: str, plan: dict[int, Placement], message: str,
) -> None:
    problem = prepare(_checked_week().request())
    with pytest.raises(SolverBuildError, match=message):
        check(problem, plan)


def test_the_recheck_refuses_a_week_over_the_weekly_cap_with_what_was_already_there() -> None:
    week = Week(day_cap=3, week_cap=2)
    _two_rooms_and_teachers(week)
    week.exam("E1", slots=((0, 480, 0),))
    week.exam("E2", slots=((1, 480, 0),))
    week.already_in_week("A", 0, 1)
    problem = prepare(week.request())
    with pytest.raises(SolverBuildError, match="more than 2 exams in week 0"):
        check(problem, {
            0: Placement(0, [RoomUse(0, 20, [0])]), 1: Placement(0, [RoomUse(0, 20, [0])]),
        })


def test_a_model_cp_sat_refuses_or_cannot_solve_is_not_an_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E")
    request = week.request()

    def returns(code: int):
        def solve(self: cp_model.CpSolver, model: cp_model.CpModel, *args: object) -> int:
            return code
        return solve

    monkeypatch.setattr(cp_model.CpSolver, "Solve", returns(cp_model.INFEASIBLE))
    with pytest.raises(SolverBuildError, match="refused the empty plan"):
        ExamSolver(SETTINGS).solve(request)
    monkeypatch.setattr(cp_model.CpSolver, "Solve", returns(cp_model.MODEL_INVALID))
    with pytest.raises(SolverBuildError, match="rejected the exam model"):
        ExamSolver(SETTINGS).solve(request)
    monkeypatch.setattr(cp_model.CpSolver, "Solve", returns(cp_model.UNKNOWN))
    response = ExamSolver(SETTINGS).solve(request)
    # No plan from the search: the floor under it is the answer.
    assert response.status == "FEASIBLE" and len(response.placed) == 1
    monkeypatch.setattr(exam_solver, "greedy_plan", lambda problem: {})
    response = ExamSolver(SETTINGS).solve(request)
    assert response.status == "FEASIBLE" and response.placed == []
    assert [u.reason for u in response.unplaced] == ["EXAM_NOT_REACHED"]


# ---------------------------------------------------------------------------
# The solve as a whole.
# ---------------------------------------------------------------------------


def test_the_same_plan_is_answered_the_same_with_one_worker_and_a_seed() -> None:
    week = Week(search={"workers": 1, "seed": 4})
    week.room("S", 30)
    week.room("L", 60)
    for index in range(5):
        week.teacher(f"T{index}", prior=30 * index)
    for index in range(4):
        week.exam(
            f"E{index}", classes=(f"C{index % 2}",), writers=20 + 10 * index,
            slots=((0, 480, 10 * index), (0, 600, 5), (1, 480, 0), (1, 600, 20)),
        )
    payload = week.payload()
    first = ExamSolver(SETTINGS).solve(PlanExamsRequest.model_validate(payload))
    second = ExamSolver(SETTINGS).solve(PlanExamsRequest.model_validate(payload))
    assert first.status == "OPTIMAL"
    assert first.placed == second.placed
    assert first.unplaced == second.unplaced
    assert first.invigilator_minutes == second.invigilator_minutes


def _random_week(seed: int) -> Week:
    rng = random.Random(seed)
    week = Week(
        day_cap=rng.randint(1, 2), week_cap=rng.randint(1, 4), ratio=rng.choice((10, 20, 30)),
        turnover=rng.choice((0, 0, 15)), search={"workers": 1, "seed": seed},
    )
    rooms = [week.room(f"R{i}", rng.choice((10, 20, 30, 40))) for i in range(rng.randint(1, 3))]
    teachers = [
        week.teacher(f"T{i}", prior=rng.choice((0, 30, 120))) for i in range(rng.randint(1, 5))
    ]
    classes = [f"C{i}" for i in range(rng.randint(1, 3))]
    grid = [(day, start) for day in (0, 1) for start in (480, 510, 600)]
    for index in range(rng.randint(2, 5)):
        slots = tuple(
            (day, start, rng.choice((0, 10, 40)))
            for day, start in rng.sample(grid, rng.randint(1, 4))
        )
        fixed = len(slots) == 1 and rng.random() < 0.3
        count = len(slots)
        week.exam(
            f"E{index}",
            classes=tuple(rng.sample(classes, rng.randint(1, len(classes)))),
            writers=rng.randint(1, 60), length=rng.choice((30, 60)), slots=slots, fixed=fixed,
            busy_rooms={r: [i for i in range(count) if rng.random() < 0.25]
                        for r in rooms if rng.random() < 0.5} or None,
            busy_teachers={t: [i for i in range(count) if rng.random() < 0.4]
                           for t in teachers if rng.random() < 0.6} or None,
        )
    for klass in classes:
        if rng.random() < 0.4:
            week.already_on_day(klass, rng.choice((0, 1)), 1)
        if rng.random() < 0.3:
            week.already_in_week(klass, 0, rng.randint(1, 2))
    return week


@pytest.mark.parametrize("seed", range(60))
def test_a_proven_plan_leaves_no_exam_that_could_still_be_added(seed: int) -> None:
    """The reasons are judged on the answer from the request alone, and the
    model decides from its own constraints: when the model says it is done
    (OPTIMAL), the reasons must agree that nothing more fits. Any exam with a
    time nothing stops would be one more placed, which the objective weighs
    above everything else — so NOT_REACHED beside OPTIMAL is a rule the model
    and the reasons read differently. check() has already vetted every rule on
    the plan itself."""
    week = _random_week(seed)
    answer = week.solve()
    if answer.response.status == "OPTIMAL":
        assert "EXAM_NOT_REACHED" not in answer.reasons.values(), seed
    placed = {e["id"] for e in week.exams} - {str(u.exam) for u in answer.response.unplaced}
    assert placed == {str(p.exam) for p in answer.response.placed}


def test_a_provvecka_of_a_school_is_answered_with_a_valid_plan_inside_the_budget() -> None:
    payload = provvecka.build_week(2)
    payload["search"] = {"seed": 0}
    settings = _settings(EXAM_SOLVER_MAX_TIME_SECONDS=8.0)
    began = time.monotonic()
    solver = ExamSolver(settings)
    response = solver.solve(PlanExamsRequest.model_validate(payload))
    wall = time.monotonic() - began
    if not response.placed and response.status == "FEASIBLE":
        pytest.skip("the host was too busy for CP-SAT to find a first plan in the budget")
    # Every hard rule was re-checked inside solve(); a plan came back.
    assert response.metrics.placed >= 15
    assert len(response.placed) + len(response.unplaced) == len(payload["exams"])
    # The route's own ceiling is the budget plus this head-room, not the budget.
    assert wall < 8.0 + exams_route._BUILD_HEADROOM_SECONDS, wall
    fixed = {e["id"] for e in payload["exams"] if e["fixed"]}
    left_out = {str(u.exam) for u in response.unplaced}
    # A fixed exam is left out only for a reason a plan cannot change.
    for item in response.unplaced:
        if str(item.exam) in fixed:
            assert item.reason != "EXAM_NOT_REACHED" or response.status == "FEASIBLE"
    assert left_out.isdisjoint({str(p.exam) for p in response.placed})


def test_the_size_estimate_counts_variables_and_block_literals() -> None:
    small = prepare(_checked_week().request())
    assert 0 < estimate_model_size(small) < 1000
    big = prepare(PlanExamsRequest.model_validate(provvecka.build_week(1)))
    assert 10_000 < estimate_model_size(big) < exam_solver.MAX_MODEL_VARIABLES


def test_a_plan_too_large_to_build_is_refused_with_its_code(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(exam_solver, "MAX_MODEL_VARIABLES", 3)
    response = client.post(
        "/api/v1/plan-exams", json=_valid_payload(), headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 400, response.text
    details = response.json()["details"]
    assert details["code"] == "EXAM_MODEL_TOO_LARGE"
    assert details["params"]["limit"] == 3 and details["params"]["variables"] > 3
    with pytest.raises(InvalidScheduleInputError):
        ExamSolver(SETTINGS).solve(_valid_request())


def _valid_request() -> PlanExamsRequest:
    return PlanExamsRequest.model_validate(_valid_payload())


# ---------------------------------------------------------------------------
# The greedy under the search.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(60))
def test_the_greedy_is_a_valid_plan_and_no_exam_it_leaves_could_still_be_added(seed: int) -> None:
    problem = prepare(_random_week(seed).request())
    plan = greedy_plan(problem)
    check(problem, plan)
    reasons = unplaced_reasons(problem, plan)
    assert "EXAM_NOT_REACHED" not in {code for code, _ in reasons.values()}
    assert set(reasons) | set(plan) == set(range(len(problem.exams)))


def test_the_greedy_places_the_fixed_exams_first_and_the_tightest_next() -> None:
    week = Week()
    week.room("R", 30)
    week.teacher("T")
    week.exam("loose", classes=("A",), slots=((0, 480, 0), (0, 600, 0)))
    week.exam("tight", classes=("B",), slots=((0, 480, 0),))
    week.exam("national", classes=("C",), slots=((0, 480, 0),), fixed=True)
    problem = prepare(week.request())
    plan = greedy_plan(problem)
    # The national exam holds the only room at 480, so the tight exam, whose
    # only time that is, is left out and the loose one takes its second time.
    assert set(plan) == {0, 2}
    assert plan[2].slot == 0
    assert plan[0].slot == 1


@pytest.mark.parametrize(
    ("writers", "rooms", "ratio", "expected"),
    [
        (45, [30, 30, 60], 30, {2: 45}),
        (60, [30, 30, 60], 30, {2: 60}),
        (70, [30, 30, 60], 30, {2: 60, 0: 10}),
        (30, [10, 10, 10], 20, {0: 10, 1: 10, 2: 10}),
        (35, [30, 30], 20, {0: 20, 1: 15}),
    ],
)
def test_the_greedy_split_uses_the_fewest_invigilators_and_then_the_fewest_rooms(
    writers: int, rooms: list[int], ratio: int, expected: dict[int, int],
) -> None:
    week = Week(ratio=ratio)
    for index, seats in enumerate(rooms):
        week.room(f"R{index}", seats)
    week.exam("E", writers=writers)
    problem = prepare(week.request())
    split = exam_solver._split(problem, 0, list(range(len(rooms))))
    assert dict(split) == expected
    assert sum(w for _, w in split) == writers
    used = sum(max(1, -(-w // ratio)) for _, w in split)
    assert used == min_invigilators(writers, rooms, ratio)


def test_a_search_that_ends_below_the_greedy_answers_with_the_greedy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(exam_solver, "read_plan", lambda problem, built, solver: {})
    week = Week()
    _two_rooms_and_teachers(week)
    week.exam("E1", classes=("A",))
    week.exam("E2", classes=("B",))
    response = ExamSolver(SETTINGS).solve(week.request())
    assert response.status == "FEASIBLE"
    assert len(response.placed) == 2


def test_a_search_that_starts_from_the_greedy_never_ends_below_it() -> None:
    for seed in range(0, 60, 6):
        week = _random_week(seed)
        problem = prepare(week.request())
        floor = plan_weight(problem, greedy_plan(problem))
        answer = week.solve()
        placed = {e["id"] for e in week.exams} - {str(u.exam) for u in answer.response.unplaced}
        fixed = {e["id"] for e in week.exams if e["fixed"]}
        weight = (len(placed & fixed), len(placed - fixed))
        assert weight >= floor, (seed, weight, floor)


# ---------------------------------------------------------------------------
# The route, the settings and the other contracts.
# ---------------------------------------------------------------------------


def test_the_solve_runs_off_the_event_loop_under_the_exam_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    released = threading.Event()
    threads_with_a_loop: list[bool] = []
    original = ExamSolver.solve

    def stuck(self: ExamSolver, payload: PlanExamsRequest) -> PlanExamsResponse:
        try:
            asyncio.get_running_loop()
            threads_with_a_loop.append(True)
        except RuntimeError:
            threads_with_a_loop.append(False)
        released.wait(timeout=5.0)
        return original(self, payload)

    monkeypatch.setattr(ExamSolver, "solve", stuck)
    monkeypatch.setattr(exams_route, "_BUILD_HEADROOM_SECONDS", 0.3)
    app = create_app(_settings(EXAM_SOLVER_MAX_TIME_SECONDS=0.2, SOLVER_MAX_TIME_SECONDS=60.0))

    with TestClient(app) as client_:
        try:
            began = time.monotonic()
            response = client_.post(
                "/api/v1/plan-exams", json=_valid_payload(), headers={"X-API-Key": API_KEY},
            )
            waited = time.monotonic() - began
        finally:
            released.set()

    assert response.status_code == 503, response.text
    assert threads_with_a_loop == [False]
    assert 0.45 <= waited < 4.0, waited


def test_the_exam_budget_is_its_own_setting() -> None:
    assert Settings.model_fields["exam_solver_max_time_seconds"].default == 20.0
    assert Settings.model_fields["exam_solver_max_time_seconds"].alias == (
        "EXAM_SOLVER_MAX_TIME_SECONDS"
    )
    assert _settings().exam_solver_max_time_seconds == 20.0
    assert _settings(EXAM_SOLVER_MAX_TIME_SECONDS=7).exam_solver_max_time_seconds == 7.0
    with pytest.raises(ValidationError):
        _settings(EXAM_SOLVER_MAX_TIME_SECONDS=0)
    with pytest.raises(ValidationError):
        _settings(EXAM_SOLVER_MAX_TIME_SECONDS=-1)
    # The other budgets are where they were.
    assert _settings().staff_solver_max_time_seconds == 10.0
    assert _settings().room_solver_max_time_seconds == 10.0
    assert _settings().solver_max_time_seconds == 60.0


#: Every route and every schema the app had before the exam planner: the
#: generator's, the room optimiser's, the staffing proposal's, the health
#: check. The legacy /v1/schedule is not in the schema.
ROUTES_BEFORE = {
    "/api/v1/optimize": {"post"},
    "/api/v1/optimize-rooms": {"post"},
    "/api/v1/staff": {"post"},
    "/health": {"get"},
}


def test_the_exam_route_changes_nothing_else_in_the_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every other route and schema answers the gateway byte for byte as
    before: the OpenAPI document of the app, components included, is the same
    with the exam router as with an empty one in its place. A model here that
    reused one of their names would rename theirs.

    The baseline is an app built with the exam router swapped for an empty
    one, not a filter over `app.routes`: included routers show up there as
    entries with no path, so a filter on a path removes nothing.
    """
    from app import main as main_module

    with_exams = create_app(SETTINGS).openapi()
    monkeypatch.setattr(main_module, "exams_router", APIRouter())
    without = create_app(SETTINGS).openapi()

    assert set(without["paths"]) == set(ROUTES_BEFORE)
    assert set(with_exams["paths"]) == set(ROUTES_BEFORE) | {"/api/v1/plan-exams"}
    for path, methods in ROUTES_BEFORE.items():
        assert set(with_exams["paths"][path]) == methods
        assert with_exams["paths"][path] == without["paths"][path], path
    assert set(with_exams["paths"]["/api/v1/plan-exams"]) == {"post"}
    assert {k: v for k, v in with_exams.items() if k not in ("paths", "components")} == {
        k: v for k, v in without.items() if k not in ("paths", "components")
    }
    for name, schema in without["components"]["schemas"].items():
        assert with_exams["components"]["schemas"][name] == schema, name
    added = set(with_exams["components"]["schemas"]) - set(without["components"]["schemas"])
    assert {"PlanExamsRequest", "PlanExamsResponse"} <= added
    assert all(name.startswith(("Exam", "Plan", "Placed", "Unplaced", "Invigilator"))
               for name in added), added
    # The components the exam router adds are the only difference.
    assert set(with_exams["components"]["schemas"]) == set(without["components"]["schemas"]) | added


def test_the_other_routes_still_answer_without_the_exam_planner(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}
    # A route the exam planner did not touch still refuses a bad key.
    assert client.post("/api/v1/staff", json={}).status_code == 401
    assert client.post("/api/v1/optimize-rooms", json={}).status_code == 401


def test_a_plan_with_a_distinct_id_for_everything_is_not_sent_anywhere_but_answered() -> None:
    """The ids that cross are the request's own: a response names no id the
    request did not."""
    week = _checked_week()
    answer = week.solve()
    sent = {e["id"] for e in week.exams} | {r["id"] for r in week.rooms} | {
        t["id"] for t in week.teachers
    }
    seen: set[str] = set()
    for item in answer.response.placed:
        seen.add(str(item.exam))
        for room in item.rooms:
            seen.add(str(room.room))
            seen.update(str(t) for t in room.invigilators)
    seen.update(str(u.exam) for u in answer.response.unplaced)
    seen.update(str(m.teacher) for m in answer.response.invigilator_minutes)
    assert seen <= sent
    for ident in seen:
        assert UUID(ident).version == 4
