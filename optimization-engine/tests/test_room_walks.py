"""Room walks: re-dealing the rooms of a fixed grundschema so fewer people walk.

Most of these are built as a PAIR — the rule on, and the same school with the
rule off — because a room optimisation that does nothing passes every test
that only asserts what did not move. The control is what proves the rule is
the reason.

The school's own words started this: Elin has maths in sal 1 and then in sal 10
on plan 2, Alexander in sal 10 and then in sal 1, and both change floors when
each could simply keep one room.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import random
import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.api.v1 import rooms as rooms_route
from app.config import Settings
from app.exceptions import SolverBuildError
from app.main import create_app
from app.schemas.rooms import (
    CountComparison,
    OptimizeRoomsRequest,
    OptimizeRoomsResponse,
    PlacedLesson,
    RoomChange,
    Walk,
    WalkComparison,
    WalkerWalk,
    WalkRoom,
)
from app.schemas.schedule import (
    AnonymousConstraint,
    AnonymousRequirement,
    AnonymousRoom,
    AnonymousRoomPreference,
)
from app.solver import room_walks
from app.solver.room_walks import (
    MAX_MODEL_VARIABLES,
    RoomWalkSolver,
    build_model,
    estimate_model_size,
    pair_walk,
    prepare,
    weeks_can_overlap,
)
from app.solver.scheduler_solver import SchedulerSolver

API_KEY = "test-api-key-000000000000000000000000"

CHEMISTRY = str(uuid4())
OTHER_SUBJECT = str(uuid4())

AUTUMN = ("2026-08-17", "2026-12-18")
SPRING = ("2027-01-11", "2027-06-11")
ALWAYS = (None, None)
# A period that ends before it starts. weeksCanOverlap says two lessons in it
# never meet, so neither may this side.
BACKWARDS = ("2027-01-01", "2026-12-01")

RECURRENCE_FIXTURE = (
    Path(__file__).resolve().parents[2] / "src/calendar/__fixtures__/recurrence-cases.json"
)


def _settings(**overrides: object) -> Settings:
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            "ROOM_SOLVER_MAX_TIME_SECONDS": 10.0,
            **overrides,
        },
    )


SETTINGS = _settings()


def person() -> str:
    return str(uuid4())


def walk(rooms: int, floors: int, buildings: int) -> Walk:
    return Walk(room_changes=rooms, floor_changes=floors, building_changes=buildings)


class Outcome:
    """A response, with every lesson's room after it applied."""

    def __init__(self, response: OptimizeRoomsResponse, lessons: list[dict]) -> None:
        self.response = response
        self.rooms: dict[str, str | None] = {lesson["id"]: lesson["roomId"] for lesson in lessons}
        for change in response.changes:
            self.rooms[str(change.lesson_id)] = str(change.room_id)
        self.moved = {str(change.lesson_id) for change in response.changes}


class School:
    """A small school built by hand. Ids are generated; names are for the reader."""

    def __init__(self) -> None:
        self.rooms: list[dict] = []
        self.lessons: list[dict] = []
        self.preferences: list[dict] = []
        self.constraints: list[dict] = []

    def room(
        self,
        *,
        floor: int | None = None,
        building: str | None = None,
        capacity: int | None = None,
        type: str | None = None,  # noqa: A002 - the wire's own name
        grades: tuple[int, int] | None = None,
    ) -> str:
        room_id = str(uuid4())
        self.rooms.append({
            "id": room_id,
            "capacity": capacity,
            "type": type,
            "minGradeLevel": grades[0] if grades else None,
            "maxGradeLevel": grades[1] if grades else None,
            "building": building,
            "floor": floor,
        })
        return room_id

    def lesson(
        self,
        room: str | None,
        start: str,
        end: str,
        *,
        teacher: str | None = None,
        co_teacher: str | None = None,
        group: str | None = None,
        extra_groups: tuple[str, ...] | list[str] = (),
        day: int = 1,
        recurrence: str = "ALL_WEEKS",
        period: tuple[str | None, str | None] = ALWAYS,
        locked: bool = False,
        subject: str = OTHER_SUBJECT,
        size: int = 20,
        grades: tuple[int, int] | None = None,
        room_type: str | None = None,
    ) -> str:
        lesson_id = str(uuid4())
        self.lessons.append({
            "id": lesson_id,
            "subjectId": subject,
            "studentGroupId": group or str(uuid4()),
            "extraGroupIds": list(extra_groups),
            "teacherId": teacher,
            "coTeacherId": co_teacher,
            "dayOfWeek": day,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
            "recurrence": recurrence,
            "startDate": period[0],
            "endDate": period[1],
            "roomId": room,
            "movable": not locked,
            "studentGroupSize": size,
            "minGradeLevel": grades[0] if grades else None,
            "maxGradeLevel": grades[1] if grades else None,
            "requiredRoomType": room_type,
        })
        return lesson_id

    def wish(
        self,
        subject: str,
        rooms: list[str],
        weight: int = 5,
        kind: str = "WISH",
        grades: tuple[int, int] | None = None,
    ) -> None:
        self.preferences.append({
            "id": str(uuid4()),
            "subjectId": subject,
            "roomIds": rooms,
            "weight": weight,
            "kind": kind,
            "minGradeLevel": grades[0] if grades else None,
            "maxGradeLevel": grades[1] if grades else None,
        })

    def close(
        self,
        resource: str,
        start: str,
        end: str,
        *,
        kind: str = "ROOM",
        day: int | None = 1,
        date: str | None = None,
        rule: str = "UNAVAILABLE",
    ) -> None:
        self.constraints.append({
            "id": str(uuid4()),
            "resourceKind": kind,
            "resourceId": resource,
            "dayOfWeek": day,
            "date": date,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
            "kind": rule,
        })

    def payload(self, walkers: str = "TEACHERS") -> dict:
        return {
            "requestId": str(uuid4()),
            "walkers": walkers,
            "rooms": self.rooms,
            "lessons": self.lessons,
            "roomPreferences": self.preferences,
            "constraints": self.constraints,
        }

    def request(self, walkers: str = "TEACHERS") -> OptimizeRoomsRequest:
        return OptimizeRoomsRequest.model_validate(self.payload(walkers))

    def solve(self, walkers: str = "TEACHERS") -> Outcome:
        return Outcome(RoomWalkSolver(SETTINGS).solve(self.request(walkers)), self.lessons)


def _elin_and_alexander() -> tuple[School, dict[str, str]]:
    school = School()
    sal1 = school.room(floor=0)
    sal10 = school.room(floor=2)
    elin, alexander = person(), person()
    ids = {
        "sal1": sal1,
        "sal10": sal10,
        "elin_first": school.lesson(sal1, "08:00", "09:00", teacher=elin),
        "elin_second": school.lesson(sal10, "09:10", "10:00", teacher=elin),
        "alexander_first": school.lesson(sal10, "08:00", "09:00", teacher=alexander),
        "alexander_second": school.lesson(sal1, "09:10", "10:00", teacher=alexander),
    }
    return school, ids


# ---------------------------------------------------------------------------
# The school's example, and what one step costs.
# ---------------------------------------------------------------------------


def test_the_schools_own_example_each_teacher_keeps_one_room() -> None:
    school, ids = _elin_and_alexander()

    outcome = school.solve()

    assert outcome.rooms[ids["elin_first"]] == outcome.rooms[ids["elin_second"]]
    assert outcome.rooms[ids["alexander_first"]] == outcome.rooms[ids["alexander_second"]]
    teachers = outcome.response.teachers
    assert (teachers.before.floor_changes, teachers.after.floor_changes) == (2, 0)
    assert (teachers.before.room_changes, teachers.after.room_changes) == (2, 0)
    # Exactly those two lessons: one of each teacher's, and nothing else.
    assert len(outcome.moved) == 2
    assert len(outcome.moved & {ids["elin_first"], ids["elin_second"]}) == 1
    assert len(outcome.moved & {ids["alexander_first"], ids["alexander_second"]}) == 1
    assert outcome.response.status == "OPTIMAL"
    assert {walker.kind for walker in outcome.response.walkers} == {"TEACHER"}
    assert len(outcome.response.walkers) == 2


def test_a_room_change_alone_is_worth_a_move() -> None:
    """The same swap on one floor: the corridor alone is reason enough."""
    school = School()
    first, second = school.room(), school.room()
    elin, alexander = person(), person()
    school.lesson(first, "08:00", "09:00", teacher=elin)
    school.lesson(second, "09:00", "10:00", teacher=elin)
    school.lesson(second, "08:00", "09:00", teacher=alexander)
    school.lesson(first, "09:00", "10:00", teacher=alexander)

    outcome = school.solve()

    assert outcome.response.teachers.before == walk(2, 0, 0)
    assert outcome.response.teachers.after == walk(0, 0, 0)
    assert len(outcome.moved) == 2


def test_stairs_cost_more_than_a_corridor() -> None:
    """Without the floor term both rooms cost one room change and nothing moves."""
    school = School()
    home = school.room(floor=0)
    upstairs = school.room(floor=2)
    downstairs = school.room(floor=0)
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    second = school.lesson(upstairs, "09:00", "10:00", teacher=teacher)
    school.lesson(home, "09:00", "10:00", teacher=person(), locked=True)  # home is taken at nine

    outcome = school.solve()

    assert outcome.rooms[second] == downstairs
    assert outcome.response.teachers.before == walk(1, 1, 0)
    assert outcome.response.teachers.after == walk(1, 0, 0)


def test_one_trip_across_the_yard_costs_more_than_a_staircase() -> None:
    school = School()
    home = school.room(building="A", floor=0)
    other_house = school.room(building="B", floor=0)
    upstairs_at_home = school.room(building="A", floor=2)
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    second = school.lesson(other_house, "09:00", "10:00", teacher=teacher)
    school.lesson(home, "09:00", "10:00", teacher=person(), locked=True)

    outcome = school.solve()

    assert outcome.rooms[second] == upstairs_at_home
    assert outcome.response.teachers.before == walk(1, 0, 1)
    assert outcome.response.teachers.after == walk(1, 1, 0)


def test_a_building_change_never_also_counts_a_floor_change() -> None:
    """Plan 2 in one house says nothing about plan 2 in another.

    Were the floors compared across houses, moving to the other house's
    ground floor would save a staircase and the lesson would move.
    """
    school = School()
    home = school.room(building="A", floor=0)
    other_high = school.room(building="B", floor=2)
    school.room(building="B", floor=0)
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    school.lesson(other_high, "09:00", "10:00", teacher=teacher)
    school.lesson(home, "09:00", "10:00", teacher=person(), locked=True)

    outcome = school.solve()

    assert outcome.moved == set()
    assert outcome.response.teachers.before == walk(1, 0, 1)


def test_an_unknown_floor_never_counts() -> None:
    """A room with no floor is not guessed to be on another one."""
    school = School()
    home = school.room(floor=0)
    unknown = school.room(floor=None)
    school.room(floor=0)
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    school.lesson(unknown, "09:00", "10:00", teacher=teacher)
    school.lesson(home, "09:00", "10:00", teacher=person(), locked=True)

    outcome = school.solve()

    assert outcome.moved == set()
    assert outcome.response.teachers.before == walk(1, 0, 0)


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        pytest.param((None, 1), (None, 2), (1, 1, 0), id="no building on either is one house"),
        pytest.param(("A", 1), (None, 1), (1, 0, 1), id="a named house and none are two places"),
        pytest.param(("A", 1), ("B", 2), (1, 0, 1), id="across houses never also a floor"),
        pytest.param(("A", 1), ("A", None), (1, 0, 0), id="an unknown floor never counts"),
        pytest.param(("A", 1), ("A", 1), (1, 0, 0), id="next door"),
    ],
)
def test_what_one_step_costs(
    first: tuple[str | None, int | None],
    second: tuple[str | None, int | None],
    expected: tuple[int, int, int],
) -> None:
    school = School()
    here = school.room(building=first[0], floor=first[1])
    there = school.room(building=second[0], floor=second[1])
    school.lesson(here, "08:00", "09:00", teacher=person())
    problem = prepare(school.request(), SETTINGS)

    assert pair_walk(problem, UUID(here), UUID(there)) == walk(*expected)
    assert pair_walk(problem, UUID(here), UUID(here)) == walk(0, 0, 0)
    assert pair_walk(problem, UUID(here), None) == walk(0, 0, 0)


@pytest.mark.parametrize(
    ("steps", "room_changes"),
    [
        pytest.param(
            [("08:00", "09:00", "ALL_WEEKS", 0, 1), ("09:00", "10:00", "ALL_WEEKS", 0, 1),
             ("10:00", "11:00", "ALL_WEEKS", 1, 1)],
            1, id="only the lesson that starts first is next",
        ),
        pytest.param(
            [("08:00", "09:00", "EVEN_WEEKS", 0, 1), ("09:00", "10:00", "ODD_WEEKS", 1, 1),
             ("10:00", "11:00", "EVEN_WEEKS", 2, 1)],
            1, id="a lesson in weeks this one never meets is not next",
        ),
        pytest.param(
            [("08:00", "09:00", "ALL_WEEKS", 0, 1), ("08:30", "09:30", "ALL_WEEKS", 1, 1)],
            0, id="overlapping lessons are not a step",
        ),
        pytest.param(
            [("08:00", "09:00", "ALL_WEEKS", 0, 1), ("09:00", "10:00", "ALL_WEEKS", 1, 2)],
            0, id="tomorrow is not a step",
        ),
    ],
)
def test_which_lessons_are_one_step(
    steps: list[tuple[str, str, str, int, int]], room_changes: int,
) -> None:
    school = School()
    rooms = [school.room() for _ in range(3)]
    teacher = person()
    for start, end, recurrence, room, day in steps:
        school.lesson(
            rooms[room], start, end, teacher=teacher, recurrence=recurrence, day=day, locked=True,
        )

    assert school.solve().response.teachers.before.room_changes == room_changes


def test_every_class_in_the_room_walks_and_a_person_named_twice_walks_once() -> None:
    school = School()
    first, second = school.room(), school.room()
    teacher, group, joined = person(), person(), person()
    school.lesson(
        first, "08:00", "09:00",
        teacher=teacher, co_teacher=teacher, group=group, extra_groups=[joined], locked=True,
    )
    school.lesson(
        second, "09:00", "10:00",
        teacher=teacher, group=group, extra_groups=[joined, group], locked=True,
    )

    response = school.solve("BOTH").response

    assert response.groups.before.room_changes == 2  # the class, and the class joining it
    assert response.teachers.before.room_changes == 1  # one teacher, named twice


def test_a_co_teacher_walks_too() -> None:
    """Two people walking is twice the walking, and it decides who gets the room.

    Downstairs is free at nine for exactly one of two lessons. The co-taught
    one saves a staircase for two people (2 x 5); the solo teacher's saves one
    step and a staircase and most of another (9). Counted as one person, the
    co-taught lesson would lose.
    """
    school = School()
    downstairs, beside = school.room(floor=0), school.room(floor=0)
    upstairs, also_upstairs = school.room(floor=2), school.room(floor=2)
    lead, co, solo = person(), person(), person()
    school.lesson(downstairs, "08:00", "09:00", teacher=lead, co_teacher=co, locked=True)
    shared_next = school.lesson(upstairs, "09:00", "10:00", teacher=lead, co_teacher=co)
    school.lesson(downstairs, "07:00", "08:00", teacher=solo, locked=True)
    solo_next = school.lesson(also_upstairs, "09:00", "10:00", teacher=solo)
    school.lesson(beside, "10:00", "11:00", teacher=solo, locked=True)
    school.lesson(beside, "09:00", "10:00", teacher=person(), locked=True)  # beside is taken at nine

    outcome = school.solve()

    assert outcome.rooms[shared_next] == downstairs
    assert outcome.rooms[solo_next] == also_upstairs
    assert outcome.response.teachers.before == walk(4, 4, 0)
    assert outcome.response.teachers.after == walk(2, 2, 0)
    assert {(walker.kind, str(walker.id)) for walker in outcome.response.walkers} == {
        ("TEACHER", lead), ("TEACHER", co),
    }


# ---------------------------------------------------------------------------
# What may move, and where.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("locked", [True, False], ids=["locked", "control: unlocked"])
def test_a_locked_lesson_keeps_its_room(locked: bool) -> None:
    school = School()
    sal1, sal10 = school.room(floor=0), school.room(floor=2)
    teacher = person()
    first = school.lesson(sal1, "08:00", "09:00", teacher=teacher, locked=locked)
    school.lesson(sal10, "09:00", "10:00", teacher=teacher, locked=True)

    outcome = school.solve()

    if locked:
        assert outcome.moved == set()
    else:
        assert outcome.rooms[first] == sal10


def test_a_lesson_with_no_room_never_gets_one_and_breaks_the_walk() -> None:
    school = School()
    sal1, sal10 = school.room(floor=0), school.room(floor=2)
    teacher = person()
    school.lesson(sal1, "08:00", "09:00", teacher=teacher)
    between = school.lesson(None, "09:00", "10:00", teacher=teacher)
    school.lesson(sal10, "10:00", "11:00", teacher=teacher)

    outcome = school.solve()

    assert outcome.moved == set()
    assert outcome.rooms[between] is None
    assert outcome.response.teachers.before == walk(0, 0, 0)

    # The control: without the roomless lesson between them, the first and the
    # last are one step, and it is worth a move.
    school.lessons = [lesson for lesson in school.lessons if lesson["id"] != between]
    outcome = school.solve()
    assert outcome.response.teachers.before == walk(1, 1, 0)
    assert len(outcome.moved) == 1


def test_parity_twins_both_follow_the_lesson_before_them_and_share_its_room() -> None:
    school = School()
    home, odd_room, even_room = school.room(), school.room(), school.room()
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    odd = school.lesson(odd_room, "09:00", "10:00", teacher=teacher, recurrence="ODD_WEEKS")
    even = school.lesson(even_room, "09:00", "10:00", teacher=teacher, recurrence="EVEN_WEEKS")

    outcome = school.solve()

    assert outcome.response.teachers.before.room_changes == 2
    assert outcome.rooms[odd] == outcome.rooms[even] == home
    assert outcome.response.teachers.after.room_changes == 0


@pytest.mark.parametrize(
    ("first_teacher", "second_teacher", "both_move"),
    [
        pytest.param(("ODD_WEEKS", ALWAYS), ("EVEN_WEEKS", ALWAYS), True, id="odd and even share"),
        pytest.param(("ODD_WEEKS", ALWAYS), ("ALL_WEEKS", ALWAYS), False, id="all and odd do not"),
        pytest.param(("ALL_WEEKS", AUTUMN), ("ALL_WEEKS", SPRING), True, id="autumn and spring share"),
        pytest.param(("ALL_WEEKS", AUTUMN), ("ALL_WEEKS", ALWAYS), False, id="overlapping periods do not"),
    ],
)
def test_lessons_share_a_room_exactly_when_they_never_meet(
    first_teacher: tuple[str, tuple[str | None, str | None]],
    second_teacher: tuple[str, tuple[str | None, str | None]],
    both_move: bool,
) -> None:
    """Two teachers were each in `home` just before, and both want it at nine."""
    school = School()
    home, a_room, b_room = school.room(), school.room(), school.room()
    moved_in = []
    for (recurrence, period), room in ((first_teacher, a_room), (second_teacher, b_room)):
        teacher = person()
        school.lesson(
            home, "08:00", "09:00",
            teacher=teacher, recurrence=recurrence, period=period, locked=True,
        )
        moved_in.append(school.lesson(
            room, "09:00", "10:00", teacher=teacher, recurrence=recurrence, period=period,
        ))

    outcome = school.solve()

    in_home = [lesson for lesson in moved_in if outcome.rooms[lesson] == home]
    assert len(in_home) == (2 if both_move else 1)
    assert outcome.moved == set(in_home)


def test_a_period_that_never_meets_itself_shares_with_its_twin() -> None:
    """weeksCanOverlap reads a backwards period as meeting nothing — itself
    included — so two lessons in one may share a room here too."""
    school = School()
    home, a_room, b_room = school.room(), school.room(), school.room()
    moved_in = []
    for room in (a_room, b_room):
        teacher = person()
        school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
        moved_in.append(school.lesson(room, "09:00", "10:00", teacher=teacher, period=BACKWARDS))

    outcome = school.solve()

    assert outcome.moved == set(moved_in)
    assert all(outcome.rooms[lesson] == home for lesson in moved_in)


@pytest.mark.parametrize("rule", ["capacity", "type", "grade", "lock"])
def test_a_lesson_only_moves_where_the_generator_would_place_it(rule: str) -> None:
    for applied in (True, False):
        school = School()
        home = school.room(
            floor=0,
            capacity=10 if applied and rule == "capacity" else None,
            grades=(0, 3) if applied and rule == "grade" else None,
        )
        away = school.room(floor=2)
        teacher = person()
        school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
        second = school.lesson(
            away, "09:00", "10:00",
            teacher=teacher, subject=CHEMISTRY, size=25, grades=(7, 9),
            room_type="LAB" if applied and rule == "type" else None,
        )
        if applied and rule == "lock":
            school.wish(CHEMISTRY, [away], kind="LOCK")

        outcome = school.solve()

        # Applied, the lesson stays — its current room breaks the type rule
        # too, and may be kept anyway. The control moves it downstairs.
        assert (outcome.rooms[second] == home) is (not applied), (rule, applied)


def test_a_wish_keeps_a_lesson_in_its_lab_against_one_room_change() -> None:
    for wished in (True, False):
        school = School()
        classroom, lab = school.room(), school.room()
        teacher = person()
        school.lesson(classroom, "08:00", "09:00", teacher=teacher, locked=True)
        chemistry = school.lesson(lab, "09:00", "10:00", teacher=teacher, subject=CHEMISTRY)
        if wished:
            school.wish(CHEMISTRY, [lab])

        outcome = school.solve()

        if wished:
            assert outcome.moved == set()
            assert outcome.response.missed_wishes == CountComparison(before=0, after=0)
        else:
            assert outcome.rooms[chemistry] == classroom


def test_a_wish_pulls_a_lesson_into_its_lab_and_every_miss_is_counted() -> None:
    school = School()
    classroom, lab = school.room(), school.room()
    movable = school.lesson(classroom, "09:00", "10:00", teacher=person(), subject=CHEMISTRY)
    school.lesson(classroom, "10:00", "11:00", teacher=person(), subject=CHEMISTRY, locked=True)
    school.wish(CHEMISTRY, [lab])

    outcome = school.solve()

    assert outcome.rooms[movable] == lab
    # The locked lesson misses its wish before and after, and is counted both
    # times: the tally is about the school, not about what could move.
    assert outcome.response.missed_wishes == CountComparison(before=2, after=1)


def test_a_lesson_missing_two_wishes_is_two_misses() -> None:
    """The tally counts (lesson, wish) pairs, not lessons: two rules the school
    wrote for chemistry are two things it asked for, and a lesson in neither
    lab has missed both. Counted per lesson, this would read 2 -> 2 — the
    move into one lab would look like it gained nothing."""
    school = School()
    classroom, lab1, lab2 = school.room(), school.room(), school.room()
    movable = school.lesson(classroom, "09:00", "10:00", teacher=person(), subject=CHEMISTRY)
    school.lesson(classroom, "10:00", "11:00", teacher=person(), subject=CHEMISTRY, locked=True)
    school.wish(CHEMISTRY, [lab1])
    school.wish(CHEMISTRY, [lab2])

    outcome = school.solve()

    assert outcome.rooms[movable] in (lab1, lab2)
    # Two lessons missing two wishes each; then one lesson in a lab, which
    # still misses the other lab's rule.
    assert outcome.response.missed_wishes == CountComparison(before=4, after=3)


@pytest.mark.parametrize(("weight", "leaves_the_lab"), [(3, True), (8, False)])
def test_a_wish_weighs_what_the_school_said_it_weighs(weight: int, leaves_the_lab: bool) -> None:
    """Leaving the lab upstairs saves a room and a staircase (1 + 4). A wish
    lighter than that gives way; a heavier one holds."""
    school = School()
    classroom, lab = school.room(floor=0), school.room(floor=2)
    teacher = person()
    school.lesson(classroom, "08:00", "09:00", teacher=teacher, locked=True)
    chemistry = school.lesson(lab, "09:00", "10:00", teacher=teacher, subject=CHEMISTRY)
    school.wish(CHEMISTRY, [lab], weight=weight)

    outcome = school.solve()

    assert (outcome.rooms[chemistry] == classroom) is leaves_the_lab


@pytest.mark.parametrize("reaches", [True, False], ids=["åk 7-8 in an åk 7-9 rule", "åk 4-5"])
def test_a_room_rule_for_one_stage_does_not_reach_another(reaches: bool) -> None:
    """Reached by _rule_reaches, as the generator reaches it: containment."""
    grades = (7, 8) if reaches else (4, 5)

    # A wish pulls a lesson into the lab only when it reaches it.
    school = School()
    classroom, lab = school.room(), school.room()
    alone = school.lesson(
        classroom, "09:00", "10:00", teacher=person(), subject=CHEMISTRY, grades=grades,
    )
    school.wish(CHEMISTRY, [lab], grades=(7, 9))
    assert (school.solve().rooms[alone] == lab) is reaches

    # A lock holds a lesson in its room only when it reaches it.
    school = School()
    classroom, lab = school.room(), school.room()
    teacher = person()
    school.lesson(lab, "08:00", "09:00", teacher=teacher, locked=True)
    second = school.lesson(
        classroom, "09:00", "10:00", teacher=teacher, subject=CHEMISTRY, grades=grades,
    )
    school.wish(CHEMISTRY, [classroom], kind="LOCK", grades=(7, 9))
    assert (school.solve().rooms[second] == lab) is (not reaches)


@pytest.mark.parametrize(
    ("closure", "blocks"),
    [
        pytest.param({}, True, id="the room, that day"),
        pytest.param({"day": None}, True, id="the room, every day"),
        pytest.param({"date": "2026-09-14"}, False, id="one date is not part of a week"),
        pytest.param({"day": 2}, False, id="another day"),
        pytest.param({"start": "10:00", "end": "11:00"}, False, id="ends as the lesson ends"),
        pytest.param({"start": "09:50", "end": "09:10"}, False, id="a window ending before it starts"),
        pytest.param({"rule": "PREFERRED_FREE"}, False, id="only UNAVAILABLE closes"),
        pytest.param({"kind": "TEACHER"}, False, id="a row about a person is about time"),
    ],
)
def test_a_closed_room_cannot_be_moved_into(closure: dict, blocks: bool) -> None:
    school = School()
    classroom, upstairs = school.room(floor=0), school.room(floor=2)
    teacher = person()
    school.lesson(classroom, "08:00", "09:00", teacher=teacher, locked=True)
    second = school.lesson(upstairs, "09:00", "10:00", teacher=teacher)
    # The classroom's own id even on a TEACHER row: the kind decides what a
    # row is about, not which table its id happens to come from.
    school.close(
        classroom,
        closure.get("start", "09:30"),
        closure.get("end", "11:00"),
        kind=closure.get("kind", "ROOM"),
        day=closure.get("day", 1),
        date=closure.get("date"),
        rule=closure.get("rule", "UNAVAILABLE"),
    )

    outcome = school.solve()

    assert (outcome.rooms[second] == classroom) is (not blocks)


def test_a_closed_room_is_still_the_lesson_s_own() -> None:
    """The school put it there; staying is always allowed. Dropping the room
    from the lesson's own choices would force it out, or refuse the solve."""
    school = School()
    classroom, _spare = school.room(), school.room()
    only = school.lesson(classroom, "09:00", "10:00", teacher=person())
    school.close(classroom, "09:00", "10:00")

    outcome = school.solve()

    assert outcome.moved == set()
    assert outcome.rooms[only] == classroom
    assert outcome.response.status == "FEASIBLE"


def test_a_room_already_shared_is_left_exactly_as_it_is() -> None:
    """A shared hall may be deliberate: frozen, reported, and never made worse.

    Unfrozen, `a_shared` would move to `side` — it saves its teacher a step
    and happens to end the clash — and `c_second` would join the hall.
    """
    school = School()
    hall, side, far = school.room(), school.room(), school.room()
    a, b, c = person(), person(), person()
    school.lesson(side, "08:00", "09:00", teacher=a, locked=True)
    a_shared = school.lesson(hall, "09:00", "10:00", teacher=a)
    b_shared = school.lesson(hall, "09:00", "10:00", teacher=b)
    school.lesson(hall, "08:00", "09:00", teacher=c, locked=True)
    school.lesson(far, "09:00", "10:00", teacher=c)

    outcome = school.solve()

    assert outcome.moved == set()
    assert [str(lesson_id) for lesson_id in outcome.response.frozen_lesson_ids] == [
        a_shared, b_shared,
    ]


def test_who_is_spared_decides_the_move_and_both_are_counted() -> None:
    """One free room at nine: the teacher's next lesson or the class's."""
    school = School()
    home, teacher_room, group_room = school.room(), school.room(), school.room()
    teacher, group = person(), person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, group=group, locked=True)
    teacher_next = school.lesson(teacher_room, "09:00", "10:00", teacher=teacher)
    group_next = school.lesson(group_room, "09:00", "10:00", teacher=person(), group=group)

    for walkers, spared, other_kind in (
        ("TEACHERS", teacher_next, "groups"),
        ("GROUPS", group_next, "teachers"),
    ):
        outcome = school.solve(walkers)
        response = outcome.response
        assert outcome.moved == {spared}, walkers
        assert outcome.rooms[spared] == home
        spared_tally = response.teachers if walkers == "TEACHERS" else response.groups
        assert spared_tally == WalkComparison(before=walk(1, 0, 0), after=walk(0, 0, 0))
        # The other kind is reported all the same, unchanged.
        assert getattr(response, other_kind) == WalkComparison(
            before=walk(1, 0, 0), after=walk(1, 0, 0),
        )
        assert [(walker.kind, str(walker.id)) for walker in response.walkers] == [
            ("TEACHER", teacher) if walkers == "TEACHERS" else ("GROUP", group),
        ]


def test_sparing_the_teachers_may_cost_a_class_a_step() -> None:
    """The trade `walkers` exists to allow, and the Python check must allow it.

    Moving `next_up` home spares its teacher a step and costs its class one:
    better for TEACHERS, a tie for BOTH. The answer is scored against today in
    Python before it is sent — with the request's own scope, or the move a
    school asked for is thrown away as "not strictly better".
    """
    school = School()
    home, away = school.room(), school.room()
    teacher, group = person(), person()
    school.lesson(home, "08:00", "09:00", teacher=teacher, locked=True)
    next_up = school.lesson(away, "09:00", "10:00", teacher=teacher, group=group)
    school.lesson(away, "10:00", "11:00", teacher=person(), group=group, locked=True)

    outcome = school.solve("TEACHERS")

    assert outcome.moved == {next_up}
    assert outcome.rooms[next_up] == home
    assert outcome.response.status == "OPTIMAL"
    assert outcome.response.teachers == WalkComparison(before=walk(1, 0, 0), after=walk(0, 0, 0))
    assert outcome.response.groups == WalkComparison(before=walk(0, 0, 0), after=walk(1, 0, 0))

    # The control: counting both, the move gains nothing and is not made.
    assert school.solve("BOTH").moved == set()


def test_rooms_that_are_already_right_are_left_alone() -> None:
    school = School()
    first, second = school.room(floor=0), school.room(floor=0)
    school.room(floor=0)
    school.room(floor=1)
    for room in (first, second):
        teacher = person()
        for start, end in (("08:00", "09:00"), ("09:00", "10:00"), ("10:00", "11:00")):
            school.lesson(room, start, end, teacher=teacher)

    response = school.solve("BOTH").response

    assert response.changes == []
    assert response.status == "FEASIBLE"
    assert response.teachers.before == response.teachers.after
    assert response.walkers == []


# ---------------------------------------------------------------------------
# The solver's word is checked, not trusted.
# ---------------------------------------------------------------------------


def test_an_answer_that_is_not_strictly_better_is_never_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model that could only answer worse than today must come back as today."""
    original = room_walks.build_model

    def forcing_a_move(problem, scope):  # noqa: ANN001, ANN202
        built = original(problem, scope)
        index = next(iter(problem.domains))
        built.model.Add(built.x[(index, problem.current[index])] == 0)
        return built

    monkeypatch.setattr(room_walks, "build_model", forcing_a_move)
    school = School()
    home, _spare = school.room(), school.room()
    teacher = person()
    school.lesson(home, "08:00", "09:00", teacher=teacher)
    school.lesson(home, "09:00", "10:00", teacher=teacher)

    outcome = school.solve()

    assert outcome.moved == set()
    assert outcome.response.status == "FEASIBLE"


def test_a_double_booking_is_caught_in_python_not_sent_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the room rows gone the solver puts both lessons in `home`; the
    Python check has to refuse that loudly rather than propose it."""
    monkeypatch.setattr(room_walks, "_add_room_rows", lambda *_args: None)
    school = School()
    home, a_room, b_room = school.room(), school.room(), school.room()
    a, b = person(), person()
    school.lesson(home, "08:00", "09:00", teacher=a, locked=True)
    school.lesson(a_room, "09:00", "10:00", teacher=a)
    school.lesson(home, "07:00", "08:00", teacher=b, locked=True)
    school.lesson(b_room, "09:00", "10:00", teacher=b)

    with pytest.raises(SolverBuildError):
        RoomWalkSolver(SETTINGS).solve(school.request())


def test_a_model_that_refuses_todays_rooms_is_a_bug_not_an_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Today's rooms satisfy every row by construction, so INFEASIBLE can only
    mean the model was built wrong — a 500, never "nothing better found"."""
    original = room_walks.build_model

    def refusing(problem, scope):  # noqa: ANN001, ANN202
        built = original(problem, scope)
        for literal in built.x.values():
            built.model.Add(literal == 0)
        return built

    monkeypatch.setattr(room_walks, "build_model", refusing)
    school, _ids = _elin_and_alexander()

    with pytest.raises(SolverBuildError):
        RoomWalkSolver(SETTINGS).solve(school.request())


def _hint_is_feasible(problem: room_walks.RoomProblem, scope: str) -> bool:
    built = build_model(problem, scope)
    # Every choice hinted, and exactly one per lesson set: today's room. With
    # no hint at all, fixing hinted variables would fix nothing and pass.
    hint = built.model.Proto().solution_hint
    assert len(hint.vars) == len(built.x)
    assert sum(hint.values) == len(problem.domains)
    solver = cp_model.CpSolver()
    solver.parameters.fix_variables_to_their_hinted_value = True
    solver.parameters.max_time_in_seconds = 10.0
    return solver.Solve(built.model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def test_the_schools_own_rooms_are_always_a_valid_answer() -> None:
    """Invariant 5, on a timetable that breaks every rule it can."""
    school = School()
    small = school.room(capacity=10)
    plain = school.room()
    closed = school.room()
    hall = school.room()
    school.room(type="LAB")
    school.lesson(small, "08:00", "09:00", teacher=person(), size=25)  # too big for it
    school.lesson(plain, "08:00", "09:00", teacher=person(), room_type="LAB")  # wrong type
    school.lesson(closed, "08:00", "09:00", teacher=person())
    school.close(closed, "08:00", "12:00")
    school.lesson(hall, "09:00", "10:00", teacher=person())  # a clash, frozen
    school.lesson(hall, "09:30", "10:30", teacher=person())
    school.lesson(plain, "10:00", "11:00", teacher=person(), recurrence="ODD_WEEKS")
    school.lesson(plain, "10:00", "11:00", teacher=person(), recurrence="EVEN_WEEKS")
    school.lesson(small, "10:00", "11:00", teacher=person(), locked=True)  # locked clash
    school.lesson(small, "10:30", "11:30", teacher=person(), locked=True)

    for scope in ("TEACHERS", "GROUPS", "BOTH"):
        assert _hint_is_feasible(prepare(school.request(scope), SETTINGS), scope)


def test_the_room_budget_is_its_own_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings.model_fields["room_solver_max_time_seconds"].default == 10.0
    with pytest.raises(ValidationError):
        _settings(ROOM_SOLVER_MAX_TIME_SECONDS=0)

    seen: list[float] = []

    class Spy(cp_model.CpSolver):
        def Solve(self, model, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202, N802
            seen.append(self.parameters.max_time_in_seconds)
            return super().Solve(model, *args, **kwargs)

    monkeypatch.setattr(room_walks.cp_model, "CpSolver", Spy)
    school, _ids = _elin_and_alexander()
    RoomWalkSolver(_settings(ROOM_SOLVER_MAX_TIME_SECONDS=3.5)).solve(school.request())
    assert seen == [3.5]


# ---------------------------------------------------------------------------
# One rule with the generator, one rule with the gateway.
# ---------------------------------------------------------------------------


def test_a_lesson_may_move_exactly_where_the_generator_may_place_it() -> None:
    """Eligibility is _room_allowed itself, read off a PlacedLesson.

    Built profile by profile against an AnonymousRequirement and an
    AnonymousRoom carrying the same values: if PlacedLesson ever parts from
    the attribute names the predicate reads, or this module grows its own
    copy of the rule, the two verdicts part here.
    """
    rng = random.Random(20260911)
    school = School()
    for _ in range(25):
        school.room(
            capacity=rng.choice([None, 10, 20, 30]),
            type=rng.choice([None, "LAB", "GYM"]),
            grades=rng.choice([None, (0, 3), (4, 6), (7, 9), (0, 9)]),
        )
    for _ in range(40):
        # Each lesson in a room of its own, so no lesson blocks another and
        # the domain is eligibility alone.
        school.lesson(
            school.room(), "08:00", "09:00",
            teacher=person(),
            size=rng.choice([5, 15, 25]),
            room_type=rng.choice([None, "LAB", "GYM"]),
            grades=rng.choice([None, (1, 2), (4, 5), (7, 9), (3, 8)]),
        )
    problem = prepare(school.request(), SETTINGS)
    index_of = {str(lesson.id): index for index, lesson in enumerate(problem.lessons)}

    verdicts: set[bool] = set()
    for lesson in school.lessons:
        requirement = AnonymousRequirement.model_validate({
            "id": lesson["id"],
            "subjectId": lesson["subjectId"],
            "studentGroupId": lesson["studentGroupId"],
            "lessonsPerWeek": 1,
            "minutesPerLesson": 60,
            "studentGroupSize": lesson["studentGroupSize"],
            "minGradeLevel": lesson["minGradeLevel"],
            "maxGradeLevel": lesson["maxGradeLevel"],
            "requiredRoomType": lesson["requiredRoomType"],
        })
        domain = set(problem.domains[index_of[lesson["id"]]])
        for room in school.rooms:
            if room["id"] == lesson["roomId"]:
                continue
            generator_room = AnonymousRoom.model_validate({
                key: room[key] for key in ("id", "capacity", "type", "minGradeLevel", "maxGradeLevel")
            })
            verdict = SchedulerSolver._room_allowed(generator_room, requirement)
            assert (UUID(room["id"]) in domain) is verdict
            verdicts.add(verdict)
    assert verdicts == {True, False}, "the profiles never exercised both verdicts"


def test_weeks_can_overlap_agrees_with_the_gateway_on_every_shared_case() -> None:
    """src/calendar/lesson-recurrence.ts replays the same file on its side."""
    cases = json.loads(RECURRENCE_FIXTURE.read_text())["cases"]
    assert len(cases) >= 10

    def window(fields: dict) -> PlacedLesson:
        # Through the wire model, so the dates are parsed as the gateway's
        # strings will be.
        return PlacedLesson.model_validate({
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
            "movable": True,
            "studentGroupSize": 1,
            **fields,
        })

    for case in cases:
        assert weeks_can_overlap(window(case["a"]), window(case["b"])) is case["meets"], case["name"]


# ---------------------------------------------------------------------------
# The route and the wire.
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(_settings()))


def test_the_route_answers_with_the_key_and_refuses_without(client: TestClient) -> None:
    school, _ids = _elin_and_alexander()
    payload = school.payload()

    assert client.post("/api/v1/optimize-rooms", json=payload).status_code == 401

    response = client.post(
        "/api/v1/optimize-rooms", json=payload, headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["requestId"] == payload["requestId"]
    assert body["status"] == "OPTIMAL"
    assert len(body["changes"]) == 2
    assert set(body["changes"][0]) == {"lessonId", "roomId"}
    assert body["teachers"]["before"] == {"roomChanges": 2, "floorChanges": 2, "buildingChanges": 0}
    assert body["teachers"]["after"] == {"roomChanges": 0, "floorChanges": 0, "buildingChanges": 0}
    assert body["missedWishes"] == {"before": 0, "after": 0}
    assert body["frozenLessonIds"] == []


@pytest.mark.parametrize(
    "breakage",
    ["a room nobody sent", "ends when it starts", "a field the engine never heard of",
     "a floor off the building", "the same lesson twice", "the same room twice"],
)
def test_a_malformed_proposal_request_is_a_422(client: TestClient, breakage: str) -> None:
    school, _ids = _elin_and_alexander()
    payload = school.payload()
    lesson = payload["lessons"][0]
    if breakage == "a room nobody sent":
        lesson["roomId"] = str(uuid4())
    elif breakage == "ends when it starts":
        lesson["endTime"] = lesson["startTime"]
    elif breakage == "a field the engine never heard of":
        lesson["isParked"] = False
    elif breakage == "a floor off the building":
        payload["rooms"][0]["floor"] = 51
    elif breakage == "the same lesson twice":
        payload["lessons"].append(dict(lesson))
    else:
        payload["rooms"].append(dict(payload["rooms"][0]))

    response = client.post(
        "/api/v1/optimize-rooms", json=payload, headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 422, breakage


def test_the_solve_runs_off_the_event_loop_under_the_room_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A solve that never finishes is a 503 at the room budget plus head-room.

    Off the loop, or one proposal freezes every other request the engine is
    serving; under a ceiling, or a build that runs away pins the request for
    as long as it runs. And the ceiling is the ROOM budget's, not the
    generator's minute: someone is watching this spinner.
    """
    released = threading.Event()
    threads_with_a_loop: list[bool] = []
    original = RoomWalkSolver.solve

    def stuck(self: RoomWalkSolver, payload: OptimizeRoomsRequest) -> OptimizeRoomsResponse:
        try:
            asyncio.get_running_loop()
            threads_with_a_loop.append(True)
        except RuntimeError:
            threads_with_a_loop.append(False)
        # Bounded, so a route that waits for it anyway answers 200 and fails
        # the test rather than hanging it.
        released.wait(timeout=5.0)
        return original(self, payload)

    monkeypatch.setattr(RoomWalkSolver, "solve", stuck)
    monkeypatch.setattr(rooms_route, "_BUILD_HEADROOM_SECONDS", 0.3)
    app = create_app(_settings(ROOM_SOLVER_MAX_TIME_SECONDS=0.2, SOLVER_MAX_TIME_SECONDS=60.0))
    school, _ids = _elin_and_alexander()

    # Inside one client, so the answer is not held back by the loop's shutdown
    # waiting for the abandoned thread.
    with TestClient(app) as client_:
        try:
            began = time.monotonic()
            response = client_.post(
                "/api/v1/optimize-rooms", json=school.payload(), headers={"X-API-Key": API_KEY},
            )
            waited = time.monotonic() - began
        finally:
            released.set()

    assert response.status_code == 503, response.text
    assert threads_with_a_loop == [False]
    # Not before 0.2 + 0.3 s: the head-room is on top of the budget, not instead of it.
    assert 0.45 <= waited < 4.0, waited


def test_a_school_too_large_to_build_is_refused_before_the_build(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The wire's own upper range — 5,000 lessons in 300 rooms — would build
    millions of variables. Refused as input the school can act on, before a
    single one is built; the school this is for fits many times over."""
    def never(*_args: object) -> None:
        raise AssertionError("build_model ran for a model it had already refused")

    target = OptimizeRoomsRequest.model_validate(_large_school(1000, 60, seed=1))
    assert estimate_model_size(prepare(target, SETTINGS), "BOTH") < MAX_MODEL_VARIABLES // 3

    monkeypatch.setattr(room_walks, "build_model", never)
    response = client.post(
        "/api/v1/optimize-rooms",
        json=_large_school(5000, 300, seed=2),
        headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 400, response.text
    details = response.json()["details"]
    assert details["code"] == "ROOM_MODEL_TOO_LARGE"
    assert details["params"]["limit"] == MAX_MODEL_VARIABLES
    assert details["params"]["variables"] > MAX_MODEL_VARIABLES


def _field_names(model: type) -> set[str]:
    return {field.alias or name for name, field in model.model_fields.items()}


def test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads() -> None:
    """Hand-kept on both sides on purpose; see the same test in test_optimize.py.

    The mirror is src/optimization/ai-engine-contract.spec.ts. extra="forbid"
    makes a field one side has and the other lacks a 422 for the whole
    proposal, so change both lists with the engine deploy, engine first.
    """
    assert _field_names(OptimizeRoomsRequest) == {
        "requestId",
        "walkers",
        "rooms",
        "lessons",
        "roomPreferences",
        "constraints",
    }
    assert _field_names(WalkRoom) == {
        "id",
        "capacity",
        "type",
        "minGradeLevel",
        "maxGradeLevel",
        "building",
        "floor",
    }
    assert _field_names(PlacedLesson) == {
        "id",
        "subjectId",
        "studentGroupId",
        "extraGroupIds",
        "teacherId",
        "coTeacherId",
        "dayOfWeek",
        "startTime",
        "endTime",
        "recurrence",
        "startDate",
        "endDate",
        "roomId",
        "movable",
        "studentGroupSize",
        "minGradeLevel",
        "maxGradeLevel",
        "requiredRoomType",
    }
    # Reused whole, and pinned field by field in test_optimize.py.
    assert OptimizeRoomsRequest.model_fields["room_preferences"].annotation == list[
        AnonymousRoomPreference
    ]
    assert OptimizeRoomsRequest.model_fields["constraints"].annotation == list[AnonymousConstraint]

    assert _field_names(OptimizeRoomsResponse) == {
        "requestId",
        "status",
        "changes",
        "teachers",
        "groups",
        "missedWishes",
        "walkers",
        "frozenLessonIds",
    }
    assert _field_names(RoomChange) == {"lessonId", "roomId"}
    assert _field_names(WalkComparison) == {"before", "after"}
    assert _field_names(CountComparison) == {"before", "after"}
    assert _field_names(Walk) == {"roomChanges", "floorChanges", "buildingChanges"}
    assert _field_names(WalkerWalk) == {"kind", "id", "before", "after"}


# ---------------------------------------------------------------------------
# Property: small random schools against a brute-force reading of the spec.
# ---------------------------------------------------------------------------


def _minutes(clock: str) -> int:
    hours, minutes, _seconds = clock.split(":")
    return int(hours) * 60 + int(minutes)


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class _BruteForce:
    """The spec, read again from scratch and enumerated, sharing no code with
    the module beyond the request it is given."""

    WEIGHTS = (1, 4, 12)

    def __init__(self, school: School, scope: str) -> None:
        self.lessons = school.lessons
        self.rooms = {room["id"]: room for room in school.rooms}
        self.constraints = school.constraints
        self.preferences = school.preferences
        self.scope = scope
        count = len(self.lessons)
        self.current = [lesson["roomId"] for lesson in self.lessons]
        self.clash = [
            [first != second and self._clash(first, second) for second in range(count)]
            for first in range(count)
        ]
        self.frozen = {
            index
            for index in range(count)
            if self.lessons[index]["movable"]
            and self.current[index] is not None
            and any(
                self.clash[index][other] and self.current[other] == self.current[index]
                for other in range(count)
            )
        }
        self.decisions = [
            index
            for index in range(count)
            if self.lessons[index]["movable"]
            and self.current[index] is not None
            and index not in self.frozen
        ]
        keepers = [
            index
            for index in range(count)
            if self.current[index] is not None and index not in self.decisions
        ]
        self.domains: dict[int, list[str]] = {}
        for index in self.decisions:
            options = {self.current[index]}
            for room_id, room in self.rooms.items():
                if (
                    self._fits(index, room)
                    and not self._closed(index, room_id)
                    and not any(
                        self.current[keeper] == room_id and self.clash[index][keeper]
                        for keeper in keepers
                    )
                ):
                    options.add(room_id)
            self.domains[index] = sorted(options)
        self.pairs = self._pairs()

    @staticmethod
    def _meets(a: dict, b: dict) -> bool:
        if {a["recurrence"], b["recurrence"]} == {"ODD_WEEKS", "EVEN_WEEKS"}:
            return False
        if a["endDate"] and b["startDate"] and a["endDate"] < b["startDate"]:
            return False
        return not (b["endDate"] and a["startDate"] and b["endDate"] < a["startDate"])

    def _clash(self, first: int, second: int) -> bool:
        a, b = self.lessons[first], self.lessons[second]
        return (
            a["dayOfWeek"] == b["dayOfWeek"]
            and _minutes(a["startTime"]) < _minutes(b["endTime"])
            and _minutes(b["startTime"]) < _minutes(a["endTime"])
            and self._meets(a, b)
        )

    def _fits(self, index: int, room: dict) -> bool:
        lesson = self.lessons[index]
        return (room["capacity"] is None or room["capacity"] >= lesson["studentGroupSize"]) and (
            lesson["requiredRoomType"] is None or room["type"] == lesson["requiredRoomType"]
        )

    def _closed(self, index: int, room_id: str) -> bool:
        lesson = self.lessons[index]
        return any(
            row["kind"] == "UNAVAILABLE"
            and row["date"] is None
            and row["resourceKind"] == "ROOM"
            and row["resourceId"] == room_id
            and row["dayOfWeek"] in (None, lesson["dayOfWeek"])
            and _minutes(row["startTime"]) < _minutes(lesson["endTime"])
            and _minutes(lesson["startTime"]) < _minutes(row["endTime"])
            for row in self.constraints
        )

    def _pairs(self) -> list[tuple[str, str, int, int]]:
        walkers: dict[tuple[str, str], set[int]] = {}
        for index, lesson in enumerate(self.lessons):
            for teacher in {lesson["teacherId"], lesson["coTeacherId"]} - {None}:
                walkers.setdefault(("TEACHER", teacher), set()).add(index)
            for group in {lesson["studentGroupId"], *lesson["extraGroupIds"]}:
                walkers.setdefault(("GROUP", group), set()).add(index)
        pairs = []
        for (kind, walker), members in walkers.items():
            for first in members:
                a = self.lessons[first]
                later = [
                    second
                    for second in members
                    if self.lessons[second]["dayOfWeek"] == a["dayOfWeek"]
                    and _minutes(self.lessons[second]["startTime"]) >= _minutes(a["endTime"])
                    and self._meets(a, self.lessons[second])
                ]
                if later:
                    first_start = min(_minutes(self.lessons[s]["startTime"]) for s in later)
                    pairs.extend(
                        (kind, walker, first, second)
                        for second in later
                        if _minutes(self.lessons[second]["startTime"]) == first_start
                    )
        return pairs

    def step(self, here: str | None, there: str | None) -> tuple[int, int, int]:
        if here is None or there is None or here == there:
            return (0, 0, 0)
        a, b = self.rooms[here], self.rooms[there]
        if a["building"] != b["building"]:
            return (1, 0, 1)
        known = a["floor"] is not None and b["floor"] is not None
        return (1, int(known and a["floor"] != b["floor"]), 0)

    def tally(self, rooms: list[str | None], kind: str) -> tuple[int, int, int]:
        total = [0, 0, 0]
        for pair_kind, _walker, first, second in self.pairs:
            if pair_kind == kind:
                for position, value in enumerate(self.step(rooms[first], rooms[second])):
                    total[position] += value
        return tuple(total)  # type: ignore[return-value]

    def missed(self, rooms: list[str | None]) -> list[int]:
        """The weight of every wish missed, over every lesson with a room."""
        weights = []
        for index, lesson in enumerate(self.lessons):
            if rooms[index] is None:
                continue
            for preference in self.preferences:
                if (
                    preference["kind"] == "WISH"
                    and preference["subjectId"] == lesson["subjectId"]
                    and rooms[index] not in preference["roomIds"]
                ):
                    weights.append(preference["weight"])
        return weights

    def score(self, rooms: list[str | None]) -> tuple[int, int]:
        kinds = {"TEACHERS": ["TEACHER"], "GROUPS": ["GROUP"], "BOTH": ["TEACHER", "GROUP"]}
        primary = sum(
            sum(weight * value for weight, value in zip(self.WEIGHTS, self.tally(rooms, kind)))
            for kind in kinds[self.scope]
        )
        primary += sum(self.missed(rooms))
        return primary, sum(1 for index, room in enumerate(rooms) if room != self.current[index])

    def valid(self, rooms: list[str | None]) -> bool:
        return not any(
            rooms[index] == rooms[other] and self.clash[index][other]
            for index in self.decisions
            for other in range(len(rooms))
        )

    def best(self) -> tuple[int, int]:
        best = self.score(self.current)
        for choice in itertools.product(*(self.domains[index] for index in self.decisions)):
            rooms = list(self.current)
            for index, room in zip(self.decisions, choice):
                rooms[index] = room
            if self.valid(rooms):
                best = min(best, self.score(rooms))
        return best


def _random_school(rng: random.Random) -> School:
    school = School()
    rooms = [
        school.room(
            floor=rng.choice([0, 1, 2, None]),
            building=rng.choice([None, None, "A", "B"]),
            capacity=rng.choice([None, None, 15, 30]),
            type=rng.choice([None, None, "LAB"]),
        )
        for _ in range(rng.randint(2, 4))
    ]
    teachers = [person() for _ in range(rng.randint(1, 3))]
    groups = [person() for _ in range(2)]
    for _ in range(rng.randint(2, 7)):
        start = rng.choice([480, 510, 540, 570, 600])
        teacher = rng.choice(teachers)
        school.lesson(
            rng.choice(rooms) if rng.random() < 0.9 else None,
            _clock(start),
            _clock(start + rng.choice([30, 60, 90])),
            teacher=teacher,
            co_teacher=rng.choice([None, None, None, *[t for t in teachers if t != teacher]]),
            group=rng.choice(groups),
            day=rng.choice([1, 1, 2]),
            recurrence=rng.choice(["ALL_WEEKS", "ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"]),
            period=rng.choice([ALWAYS, ALWAYS, AUTUMN, SPRING]),
            locked=rng.random() < 0.2,
            subject=rng.choice([CHEMISTRY, OTHER_SUBJECT]),
            size=rng.choice([10, 20, 25]),
            room_type=rng.choice([None, None, None, "LAB"]),
        )
    if rng.random() < 0.5:
        school.wish(CHEMISTRY, [rng.choice(rooms)], weight=rng.choice([1, 3, 5]))
        # A second rule for the same subject: one lesson can then miss two
        # wishes, which the tally must count twice.
        if rng.random() < 0.4:
            school.wish(CHEMISTRY, [rng.choice(rooms)], weight=rng.choice([1, 3, 5]))
    if rng.random() < 0.3:
        school.close(rng.choice(rooms), "08:30", "09:30", day=rng.choice([None, 1]))
    return school


def test_random_small_schools_against_brute_force() -> None:
    rng = random.Random(20260911)
    exercised = {"moved": 0, "frozen": 0, "optimal_input": 0}
    for trial in range(150):
        school = _random_school(rng)
        scope = rng.choice(["TEACHERS", "GROUPS", "BOTH"])
        request = school.request(scope)
        oracle = _BruteForce(school, scope)
        problem = prepare(request, SETTINGS)
        assert _hint_is_feasible(problem, scope), trial

        response = RoomWalkSolver(SETTINGS).solve(request)
        outcome = Outcome(response, school.lessons)
        after = [outcome.rooms[lesson["id"]] for lesson in school.lessons]

        # Only decision lessons move, and only inside their domains.
        for index, lesson in enumerate(school.lessons):
            if index in oracle.domains:
                assert after[index] in oracle.domains[index], trial
            else:
                assert after[index] == oracle.current[index], trial
        # No clash the input did not have.
        assert oracle.valid(after), trial
        # Never worse; strictly better whenever anything moved; and the best
        # there is whenever the solver says so (or keeps today's rooms).
        before_score, after_score = oracle.score(oracle.current), oracle.score(after)
        assert after_score <= before_score, trial
        if response.changes:
            assert after_score[0] < before_score[0], trial
            exercised["moved"] += 1
        else:
            exercised["optimal_input"] += 1
        if response.status == "OPTIMAL" or not response.changes:
            assert after_score == oracle.best(), trial

        # The tallies are the brute force's own count.
        for kind, reported in (("TEACHER", response.teachers), ("GROUP", response.groups)):
            for rooms, walk_ in ((oracle.current, reported.before), (after, reported.after)):
                assert oracle.tally(rooms, kind) == (
                    walk_.room_changes, walk_.floor_changes, walk_.building_changes,
                ), trial
        assert response.missed_wishes == CountComparison(
            before=len(oracle.missed(oracle.current)), after=len(oracle.missed(after)),
        ), trial
        assert {str(lesson_id) for lesson_id in response.frozen_lesson_ids} == {
            school.lessons[index]["id"] for index in oracle.frozen
        }, trial
        exercised["frozen"] += bool(oracle.frozen)

        # Every walker listed changed, most improved first.
        gains = [
            sum(w * (b - a) for w, b, a in zip(
                _BruteForce.WEIGHTS,
                (walker.before.room_changes, walker.before.floor_changes, walker.before.building_changes),
                (walker.after.room_changes, walker.after.floor_changes, walker.after.building_changes),
            ))
            for walker in response.walkers
        ]
        assert all(walker.before != walker.after for walker in response.walkers), trial
        assert gains == sorted(gains, reverse=True), trial

    # The generator has to reach every branch, or the loop proves nothing.
    assert all(count >= 10 for count in exercised.values()), exercised


# ---------------------------------------------------------------------------
# How large a model gets, and the refusal that bounds it.
# ---------------------------------------------------------------------------


def _large_school(lessons: int, rooms: int, *, seed: int) -> dict:
    """A payload shaped like a real school at scale: mostly generic rooms in
    two houses and a yard, clash-free today, a co-teacher on one lesson in
    five and a joined class on some. Built as JSON, so it can be posted."""
    rng = random.Random(seed)
    room_rows = [
        {
            "id": str(uuid4()),
            "capacity": None if index % 5 else 30,
            "type": "LAB" if index % 17 == 0 else None,
            "minGradeLevel": None,
            "maxGradeLevel": None,
            "building": rng.choice(["A", "B", None]),
            "floor": rng.choice([0, 1, 2, None]),
        }
        for index in range(rooms)
    ]
    teachers = [person() for _ in range(max(2, lessons // 14))]
    groups = [person() for _ in range(max(2, lessons * 3 // 10))]
    taken: set[tuple[str, int, int]] = set()
    rows: list[dict] = []
    while len(rows) < lessons:
        day, hour = rng.randint(1, 5), rng.randint(8, 15)
        room = rng.choice(room_rows)["id"]
        if (room, day, hour) in taken:
            continue
        taken.add((room, day, hour))
        rows.append({
            "id": str(uuid4()),
            "subjectId": OTHER_SUBJECT,
            "studentGroupId": rng.choice(groups),
            "extraGroupIds": rng.sample(groups, rng.choice([0, 0, 1, 2])),
            "teacherId": rng.choice(teachers),
            "coTeacherId": rng.choice(teachers) if rng.random() < 0.2 else None,
            "dayOfWeek": day,
            "startTime": f"{hour:02d}:00:00",
            "endTime": f"{hour + 1:02d}:00:00",
            "recurrence": "ALL_WEEKS",
            "startDate": None,
            "endDate": None,
            "roomId": room,
            "movable": rng.random() > 0.05,
            "studentGroupSize": 20,
            "minGradeLevel": None,
            "maxGradeLevel": None,
            "requiredRoomType": None,
        })
    return {
        "requestId": str(uuid4()),
        "walkers": "BOTH",
        "rooms": room_rows,
        "lessons": rows,
        "roomPreferences": [],
        "constraints": [],
    }


def test_the_estimate_is_exactly_the_model_the_build_makes() -> None:
    """The refusal is only as honest as the count behind it.

    Counted, not built, so it can run before the build it guards — which
    makes it a second reading of the builders. Pinned EQUAL to the proto
    rather than merely no smaller: a builder that gains a variable fails here
    and names the estimate as the thing to change with it.
    """
    rng = random.Random(20260912)
    beyond_the_literals = 0
    for trial in range(80):
        school = _random_school(rng)
        for scope in ("TEACHERS", "GROUPS", "BOTH"):
            problem = prepare(school.request(scope), SETTINGS)
            built = build_model(problem, scope)
            estimate = estimate_model_size(problem, scope)
            assert estimate == len(built.model.Proto().variables), (trial, scope)
            beyond_the_literals += estimate > len(built.x)
    assert beyond_the_literals >= 30, "the schools never reached the step terms"

    # At a size where every house, floor and shared room appears at once.
    problem = prepare(
        OptimizeRoomsRequest.model_validate(_large_school(250, 14, seed=3)), SETTINGS,
    )
    built = build_model(problem, "BOTH")
    assert estimate_model_size(problem, "BOTH") == len(built.model.Proto().variables)
