"""Placeringsregler: a school's three rules about where its lessons stand.

Rule 1, not first or last in the class's day, per subject. Rule 2, at most N
room changes and M building changes a day. Rule 3, the pupils together fit a
shared room. Each is the school's, off until asked for, and soft or hard.

THE SCAFFOLDING IS test_consecutive.py's and test_class_halves.py's: a short
Monday of 60-minute lessons, so every case is arithmetic a reader does in
their head, and a payload per case rather than a fixture.
"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver

CLASS_7A = str(uuid4())
CLASS_7B = str(uuid4())
IDROTT = str(uuid4())
MATTE = str(uuid4())
SVENSKA = str(uuid4())

#: Every other term of the objective off, so that what is left is the rule.
QUIET = {
    "WEIGHT_TEACHER_GAP": 0,
    "WEIGHT_SPREAD": 0,
    "WEIGHT_DISRUPTION": 0,
    "WEIGHT_LUNCH_DRIFT": 0,
    "WEIGHT_ROOM_PREFERENCE": 0,
    "WEIGHT_DATE_UNAVAILABLE": 0,
}


def _settings(*, day_end: int = 660, days: str = "1", seconds: float = 10.0, **overrides: object) -> Settings:
    """08:00 to day_end (660 is 11:00), Monday only unless told otherwise."""
    return Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=seconds,
        SCHEDULE_DAYS=days,
        SCHEDULE_DAY_END_MINUTES=day_end,
        **overrides,
    )


def _requirement(
    subject: str, group: str, *, lessons: int = 1, minutes: int = 60, size: int = 20,
    teacher: str | None = None, **extra: object,
) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "subjectId": subject,
        "studentGroupId": group,
        "teacherId": teacher or str(uuid4()),
        "lessonsPerWeek": lessons,
        "minutesPerLesson": minutes,
        "studentGroupSize": size,
        **extra,
    }


def _payload(requirements: list[dict[str, object]], **extra: object) -> dict[str, object]:
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(max(2, len(requirements)))],
        **extra,
    }


def _edges(mode: str, *rows: tuple[str, bool, bool], weight: int | None = None) -> dict[str, object]:
    block: dict[str, object] = {
        "mode": mode,
        "subjects": [{"subjectId": subject, "notFirst": first, "notLast": last} for subject, first, last in rows],
    }
    if weight is not None:
        block["weight"] = weight
    return {"subjectEdges": block}


def _solve(payload: dict[str, object], **settings: object):
    request = OptimizeScheduleRequest.model_validate(payload)
    return SchedulerSolver(_settings(**settings)).solve(request)


def _digest(model: object) -> str:
    """The model's proto as bytes, hashed (ortools 9.15 has no SerializeToString)."""
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "model.pb"
        assert model.ExportToFile(str(path))  # type: ignore[attr-defined]
        return hashlib.sha256(path.read_bytes()).hexdigest()


def _start_of(response, subject: str, requirements: list[dict[str, object]]) -> str:
    ids = {str(r["id"]) for r in requirements if r["subjectId"] == subject}
    return sorted(str(lesson.start_time) for lesson in response.lessons if str(lesson.requirement_id) in ids)[0]


class TestSubjectEdgesHard:
    """Rule 1 as a constraint: the flagged lesson is neither the class's first nor its last."""

    def test_a_lesson_not_first_and_not_last_takes_the_middle(self) -> None:
        requirements = [
            _requirement(IDROTT, CLASS_7A),
            _requirement(MATTE, CLASS_7A),
            _requirement(SVENSKA, CLASS_7A),
        ]
        payload = _payload(requirements, placementRules=_edges("HARD", (IDROTT, True, True)))

        response = _solve(payload)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _start_of(response, IDROTT, requirements) == "09:00:00"

    def test_not_first_alone_lets_it_close_the_day(self) -> None:
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)]
        payload = _payload(requirements, placementRules=_edges("HARD", (IDROTT, True, False)))

        response = _solve(payload, day_end=600)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _start_of(response, IDROTT, requirements) == "09:00:00"

    def test_a_class_with_nothing_else_cannot_keep_it(self) -> None:
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)]
        payload = _payload(requirements, placementRules=_edges("HARD", (IDROTT, True, True)))

        response = _solve(payload, day_end=600)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        codes = {detail.code for detail in response.conflicts.conflicts}
        assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in codes

    def test_a_locked_lesson_before_it_opens_the_day(self) -> None:
        """The class's day is its locked lessons too: a locked 08:00 lesson is the opener."""
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)]
        locked = {
            "id": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": CLASS_7A,
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        }
        payload = _payload(
            requirements,
            fixedLessons=[locked],
            placementRules=_edges("HARD", (IDROTT, True, True)),
        )

        response = _solve(payload, day_end=720)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        starts = sorted(str(lesson.start_time) for lesson in response.lessons)
        # The locked 08:00 lesson opens the day; the other two lessons hold the
        # middle and the end, and idrott is the middle one.
        assert _start_of(response, IDROTT, requirements) < starts[-1] or len(starts) == 1

    def test_a_group_paired_with_the_class_counts_as_its_day(self) -> None:
        """A teaching group that shares pupils with 7A opens 7A's day for idrott in 7A."""
        group = str(uuid4())
        requirements = [
            _requirement(IDROTT, CLASS_7A),
            _requirement(MATTE, group, size=8),
        ]
        payload = _payload(
            requirements,
            groups=[{"id": CLASS_7A, "lunchHeadcount": 20}],
            groupConflicts=[[CLASS_7A, group]],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )

        response = _solve(payload, day_end=600)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _start_of(response, IDROTT, requirements) == "09:00:00"

    def test_odd_and_even_weeks_are_each_held_apart(self) -> None:
        """Idrott every week needs something before it in BOTH weeks: a lock of the odd weeks alone is not enough."""
        requirements = [_requirement(IDROTT, CLASS_7A)]
        opener = {
            "id": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": CLASS_7A,
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        }
        payload = _payload(
            requirements,
            fixedLessons=[{**opener, "recurrence": "ODD_WEEKS"}],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )
        both_weeks = _payload(
            requirements,
            fixedLessons=[opener],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )

        # The even week has no opener at all, and the pre-flight reads each week
        # on its own: it refuses by name what the model would have proved.
        refused = _refusal(payload, day_end=600)
        assert refused is not None
        assert refused.code == "PLACEMENT_EDGE_NO_OTHER_LESSON"
        assert _solve(both_weeks, day_end=600).status in {"OPTIMAL", "FEASIBLE"}

    def test_a_subject_of_the_odd_weeks_alone_leaves_the_even_week_nothing_to_open_with(self) -> None:
        slojd = str(uuid4())
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A), _requirement(slojd, CLASS_7A, recurrence="ODD_WEEKS")],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )

        with pytest.raises(InvalidScheduleInputError) as refused:
            _solve(payload, day_end=600)

        assert refused.value.code == "PLACEMENT_EDGE_NO_OTHER_LESSON"

    def test_the_model_reads_each_week_on_its_own(self) -> None:
        """The pre-flight above skips a class with a lock, so this is the model's A/B split and nobody else's.

        Idrott every week, not first. Slöjd runs in the odd weeks only and the
        class's one lesson of the even weeks is a lock at 10:00, after idrott's
        slot: in an even week nothing stands before idrott at 08:00 or 09:00,
        and a model that took slöjd of the odd weeks as the opener of every week
        would answer OPTIMAL, a timetable that breaks the rule every second week.
        """
        slojd = str(uuid4())
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(slojd, CLASS_7A, recurrence="ODD_WEEKS")]
        lock = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": CLASS_7A, "dayOfWeek": 1,
            "startTime": "10:00:00", "endTime": "11:00:00", "recurrence": "EVEN_WEEKS",
        }
        payload = _payload(requirements, fixedLessons=[lock], placementRules=_edges("HARD", (IDROTT, True, False)))

        response = _solve(payload, day_end=660)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}

    @pytest.mark.parametrize(("edge", "rows"), [("first", (IDROTT, True, False)), ("last", (IDROTT, False, True))])
    def test_a_lesson_of_a_parallel_block_is_first_and_last_beside_its_partner(
        self, edge: str, rows: tuple[str, bool, bool],
    ) -> None:
        """Two groups that share pupils with 7A and not with each other run at the same hour: neither is before the other.

        The day is one hour long, so idrott of one group and matte of the other
        start together and end together. A model that counted "starts at the
        same time" as earlier (or "ends at the same time" as later) would find
        the other group's lesson to stand behind, and keep a rule nothing keeps.
        """
        group_one, group_two = str(uuid4()), str(uuid4())
        payload = _payload(
            [_requirement(IDROTT, group_one, size=10), _requirement(MATTE, group_two, size=10)],
            groups=[{"id": CLASS_7A, "lunchHeadcount": 20}],
            groupConflicts=[[CLASS_7A, group_one], [CLASS_7A, group_two]],
            placementRules=_edges("HARD", rows),
        )

        response = _solve(payload, day_end=540)

        assert response.status == "INFEASIBLE", edge
        assert response.conflicts is not None
        assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}

    @pytest.mark.parametrize(("edge", "rows"), [("first", (IDROTT, True, False)), ("last", (IDROTT, False, True))])
    def test_a_lock_of_a_parallel_block_is_first_and_last_beside_its_partner(
        self, edge: str, rows: tuple[str, bool, bool],
    ) -> None:
        """The same with the partner's lesson locked at that hour: a lock that starts or ends with it does not stand behind it."""
        group_one, group_two = str(uuid4()), str(uuid4())
        lock = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": group_two, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00",
        }
        payload = _payload(
            [_requirement(IDROTT, group_one, size=10)],
            groups=[{"id": CLASS_7A, "lunchHeadcount": 20}],
            groupConflicts=[[CLASS_7A, group_one], [CLASS_7A, group_two]],
            fixedLessons=[lock],
            placementRules=_edges("HARD", rows),
        )

        response = _solve(payload, day_end=540)

        assert response.status == "INFEASIBLE", edge
        assert response.conflicts is not None
        assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}


class TestSubjectEdgesSoft:
    """Rule 1 as a wish: paid for in the full model, never a refusal."""

    def test_the_wish_holds_when_nothing_outweighs_it(self) -> None:
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)]
        payload = _payload(requirements, placementRules=_edges("SOFT", (IDROTT, True, False)))

        response = _solve(payload, day_end=600, **QUIET)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _start_of(response, IDROTT, requirements) == "09:00:00"

    def test_a_week_that_cannot_keep_it_is_still_solved(self) -> None:
        requirements = [_requirement(IDROTT, CLASS_7A)]
        payload = _payload(requirements, placementRules=_edges("SOFT", (IDROTT, True, True)))

        response = _solve(payload, day_end=600, **QUIET)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 1

    def test_it_is_paid_for_in_the_objective_and_not_in_the_satisfaction_phase(self) -> None:
        requirements = [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)]
        request = OptimizeScheduleRequest.model_validate(
            _payload(requirements, placementRules=_edges("SOFT", (IDROTT, True, False))),
        )
        solver = SchedulerSolver(_settings(day_end=600, **QUIET))

        with_wish, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
        satisfaction, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
        plain = OptimizeScheduleRequest.model_validate(_payload(requirements))
        main, *_ = solver._build_model(plain, use_assumptions=False, include_objective=False)

        assert len(satisfaction.Proto().constraints) == len(main.Proto().constraints)
        assert len(with_wish.Proto().constraints) > len(satisfaction.Proto().constraints)


class TestRulesOffIsMain:
    """A request without placementRules builds the model it always built."""

    def test_the_model_is_byte_for_byte_the_same(self) -> None:
        requirements = [
            _requirement(IDROTT, CLASS_7A),
            _requirement(MATTE, CLASS_7A),
            _requirement(SVENSKA, CLASS_7B),
        ]
        payload = _payload(requirements)
        request = OptimizeScheduleRequest.model_validate(payload)
        solver = SchedulerSolver(_settings())

        first, *_ = solver._build_model(request, use_assumptions=False)
        second, *_ = solver._build_model(request, use_assumptions=False)

        assert _digest(first) == _digest(second)


def _room(kind: str | None, *, building: str | None = None, capacity: int = 30, **extra: object) -> dict[str, object]:
    room: dict[str, object] = {"id": str(uuid4()), "capacity": capacity, **extra}
    if kind is not None:
        room["type"] = kind
    if building is not None:
        room["building"] = building
    return room


def _places(mode: str, weight: int | None = None, **limits: int) -> dict[str, object]:
    block: dict[str, object] = {"mode": mode, **limits}
    if weight is not None:
        block["weight"] = weight
    return {"places": block}


def _lock(
    room: dict[str, object], day: int, group: str, *, start: str = "08:00:00", end: str = "09:00:00",
) -> dict[str, object]:
    """A locked lesson of `group` in `room`."""
    return {
        "id": str(uuid4()),
        "teacherId": str(uuid4()),
        "studentGroupId": group,
        "roomId": room["id"],
        "dayOfWeek": day,
        "startTime": start,
        "endTime": end,
    }


def _three_rooms() -> list[dict[str, object]]:
    """A lab and a hall in Hus A, a workshop in Hus B: one room of each type."""
    return [
        _room("LAB", building="Hus A"),
        _room("HALL", building="Hus A"),
        _room("WORKSHOP", building="Hus B"),
    ]


def _lessons_in_three_types(group: str, teacher: str | None = None) -> list[dict[str, object]]:
    return [
        _requirement(str(uuid4()), group, requiredRoomType=kind, teacher=teacher)
        for kind in ("LAB", "HALL", "WORKSHOP")
    ]


class TestBuildingsPerDay:
    """Rule 2, buildings: at most M different buildings a day."""

    def test_two_buildings_on_every_day_break_a_limit_of_zero(self) -> None:
        """The pre-flight counts forced places against days; here they fit, and the days do not.

        7A is locked in Hus A on both days, and its workshop lesson can only be
        in Hus B: every day it could take has both buildings in it.
        """
        rooms = _three_rooms()
        locks = [_lock(rooms[0], day, CLASS_7A) for day in (1, 2)]
        payload = _payload(
            [_requirement(str(uuid4()), CLASS_7A, requiredRoomType="WORKSHOP")],
            rooms=rooms, fixedLessons=locks,
            placementRules=_places("HARD", maxClassBuildings=1),
        )

        response = _solve(payload, days="1,2")

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "PLACES_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}

    def test_two_buildings_hold_a_limit_of_two(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("HARD", maxClassBuildings=2),
        )

        assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}

    def test_a_second_day_takes_the_other_building(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("HARD", maxClassBuildings=1),
        )

        response = _solve(payload, days="1,2")

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        buildings = {str(r["id"]): r.get("building") for r in payload["rooms"]}  # type: ignore[union-attr]
        by_day: dict[int, set[object]] = {}
        for lesson in response.lessons:
            by_day.setdefault(lesson.day_of_week, set()).add(buildings[str(lesson.room_id)])
        assert all(len(found) == 1 for found in by_day.values())

    def test_a_teacher_is_limited_apart_from_the_class(self) -> None:
        """A limit on the classes alone leaves the teacher free to walk."""
        teacher = str(uuid4())
        requirements = [
            *_lessons_in_three_types(CLASS_7A, teacher),
        ]
        # One lesson per class, so the class limit has nothing to bind.
        requirements = [
            {**requirement, "studentGroupId": str(uuid4())} for requirement in requirements
        ]
        free = _payload(
            requirements, rooms=_three_rooms(),
            placementRules=_places("HARD", maxClassBuildings=1),
        )
        bound = _payload(
            requirements, rooms=_three_rooms(),
            placementRules=_places("HARD", maxTeacherBuildings=1),
        )

        assert _solve(free).status in {"OPTIMAL", "FEASIBLE"}
        refused = _refusal(bound)
        assert refused is not None
        assert refused.params["party"] == "teacher"

    def test_a_locked_lesson_in_a_building_counts(self) -> None:
        rooms = _three_rooms()
        requirements = [_requirement(str(uuid4()), CLASS_7A, requiredRoomType="WORKSHOP")]
        locked = {
            "id": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": CLASS_7A,
            "roomId": rooms[0]["id"],
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        }
        payload = _payload(
            requirements, rooms=rooms, fixedLessons=[locked],
            placementRules=_places("HARD", maxClassBuildings=1),
        )

        refused = _refusal(payload)
        assert refused is not None
        assert refused.code == "PLACEMENT_PLACES_FORCED"
        assert _solve(payload, days="1,2").status in {"OPTIMAL", "FEASIBLE"}

    def test_a_school_with_one_building_builds_nothing(self) -> None:
        rooms = [_room("LAB", building="Hus A"), _room("HALL", building="Hus A"), _room("WORKSHOP", building="Hus A")]
        requirements = _lessons_in_three_types(CLASS_7A)
        request = OptimizeScheduleRequest.model_validate(
            _payload(requirements, rooms=rooms, placementRules=_places("HARD", maxClassBuildings=1)),
        )
        plain = OptimizeScheduleRequest.model_validate(_payload(requirements, rooms=rooms))
        solver = SchedulerSolver(_settings())

        with_rule, *_ = solver._build_model(request, use_assumptions=False)
        without, *_ = solver._build_model(plain, use_assumptions=False)

        assert len(with_rule.Proto().constraints) == len(without.Proto().constraints)

    def test_the_soft_limit_pays_and_never_refuses(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("SOFT", maxClassBuildings=1),
        )

        response = _solve(payload)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 3

    def test_the_soft_limit_takes_the_second_day_when_it_has_one(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("SOFT", maxClassBuildings=1),
        )

        response = _solve(payload, days="1,2", **QUIET)

        buildings = {str(r["id"]): r.get("building") for r in payload["rooms"]}  # type: ignore[union-attr]
        by_day: dict[int, set[object]] = {}
        for lesson in response.lessons:
            by_day.setdefault(lesson.day_of_week, set()).add(buildings[str(lesson.room_id)])
        assert all(len(found) == 1 for found in by_day.values())


class TestRoomsPerDay:
    """Rule 2, rooms: at most N different room groups a day."""

    def test_three_kinds_of_room_on_every_day_break_a_limit_of_one(self) -> None:
        rooms = _three_rooms()
        locks = [_lock(rooms[0], day, CLASS_7A) for day in (1, 2)]
        locks += [_lock(rooms[1], day, CLASS_7A, start="09:00:00", end="10:00:00") for day in (1, 2)]
        payload = _payload(
            [_requirement(str(uuid4()), CLASS_7A, requiredRoomType="WORKSHOP")],
            rooms=rooms, fixedLessons=locks,
            placementRules=_places("HARD", maxClassRooms=2),
        )

        response = _solve(payload, days="1,2", day_end=720)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "PLACES_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}

    def test_three_kinds_of_room_in_a_one_day_week_are_refused_by_name(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("HARD", maxClassRooms=2),
        )

        refused = _refusal(payload)

        assert refused is not None
        assert refused.code == "PLACEMENT_PLACES_FORCED"

    def test_three_kinds_hold_a_limit_of_three(self) -> None:
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=_three_rooms(),
            placementRules=_places("HARD", maxClassRooms=3),
        )

        assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}

    def test_two_equal_classrooms_are_one_room_group(self) -> None:
        rooms = [_room(None), _room(None)]
        requirements = [_requirement(str(uuid4()), CLASS_7A) for _ in range(3)]
        payload = _payload(requirements, rooms=rooms, placementRules=_places("HARD", maxClassRooms=1))

        assert _solve(payload).status in {"OPTIMAL", "FEASIBLE"}


def _gym(*, capacity: int = 50, shared: bool = True) -> dict[str, object]:
    return _room("GYM", capacity=capacity, **({"shareable": True} if shared else {}))


def _shared(mode: str, weight: int | None = None) -> dict[str, object]:
    block: dict[str, object] = {"mode": mode}
    if weight is not None:
        block["weight"] = weight
    return {"sharedRooms": block}


def _two_classes_in_the_hall(first: int, second: int) -> list[dict[str, object]]:
    return [
        _requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=first),
        _requirement(IDROTT, CLASS_7B, requiredRoomType="GYM", size=second),
    ]


class TestSharedRooms:
    """Rule 3: a room marked shareable holds several lessons while the pupils fit."""

    def test_an_exclusive_hall_cannot_hold_two_classes_in_one_hour(self) -> None:
        payload = _payload(_two_classes_in_the_hall(25, 25), rooms=[_gym(shared=False)])

        assert _solve(payload, day_end=540).status == "INFEASIBLE"

    def test_a_shared_hall_holds_both_while_they_fit(self) -> None:
        requirements = _two_classes_in_the_hall(25, 25)
        gym = _gym()
        payload = _payload(requirements, rooms=[gym], placementRules=_shared("HARD"))

        response = _solve(payload, day_end=540)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert {str(lesson.room_id) for lesson in response.lessons} == {str(gym["id"])}
        assert {str(lesson.start_time) for lesson in response.lessons} == {"08:00:00"}

    def test_a_hard_hall_refuses_pupils_over_its_seats(self) -> None:
        payload = _payload(
            _two_classes_in_the_hall(30, 30), rooms=[_gym()], placementRules=_shared("HARD"),
        )

        response = _solve(payload, day_end=540)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "SHARED_ROOM_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}

    def test_a_soft_hall_takes_them_anyway(self) -> None:
        payload = _payload(
            _two_classes_in_the_hall(30, 30), rooms=[_gym()], placementRules=_shared("SOFT"),
        )

        response = _solve(payload, day_end=540)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 2

    def test_a_soft_hall_prefers_the_second_hour_when_it_has_one(self) -> None:
        payload = _payload(
            _two_classes_in_the_hall(30, 30), rooms=[_gym()], placementRules=_shared("SOFT"),
        )

        response = _solve(payload, day_end=600, **QUIET)

        assert len({str(lesson.start_time) for lesson in response.lessons}) == 2

    def test_a_lock_that_says_its_pupils_leaves_the_rest_of_the_hall(self) -> None:
        gym = _gym()
        locked = {
            "id": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": CLASS_7B,
            "roomId": gym["id"],
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
            "studentCount": 30,
        }
        fits = _payload(
            [_requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=20)],
            rooms=[gym], fixedLessons=[locked], placementRules=_shared("HARD"),
        )
        over = _payload(
            [_requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=25)],
            rooms=[gym], fixedLessons=[locked], placementRules=_shared("HARD"),
        )

        assert _solve(fits, day_end=540).status in {"OPTIMAL", "FEASIBLE"}
        assert _solve(over, day_end=540).status == "INFEASIBLE"

    def test_a_lock_that_does_not_say_takes_the_whole_room(self) -> None:
        gym = _gym()
        locked = {
            "id": str(uuid4()),
            "teacherId": str(uuid4()),
            "studentGroupId": CLASS_7B,
            "roomId": gym["id"],
            "dayOfWeek": 1,
            "startTime": "08:00:00",
            "endTime": "09:00:00",
        }
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=5)],
            rooms=[gym], fixedLessons=[locked], placementRules=_shared("HARD"),
        )

        assert _solve(payload, day_end=540).status == "INFEASIBLE"

    def test_a_room_with_no_capacity_stays_exclusive(self) -> None:
        gym = {"id": str(uuid4()), "type": "GYM", "shareable": True}
        payload = _payload(
            _two_classes_in_the_hall(5, 5), rooms=[gym], placementRules=_shared("HARD"),
        )

        assert _solve(payload, day_end=540).status == "INFEASIBLE"

    def test_alternating_weeks_are_each_counted(self) -> None:
        """Idrott every week beside an odd-week lesson: the hall holds each week's pupils apart."""
        requirements = [
            _requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=30),
            _requirement(IDROTT, CLASS_7B, requiredRoomType="GYM", size=30, recurrence="ODD_WEEKS"),
        ]
        payload = _payload(requirements, rooms=[_gym()], placementRules=_shared("HARD"))

        assert _solve(payload, day_end=540).status == "INFEASIBLE"

    def test_a_class_of_the_odd_weeks_and_a_class_of_the_even_weeks_share_the_hour(self) -> None:
        """The other way round: 30 and 30 pupils in a hall of 50 never meet, so the hall holds them in the same hour."""
        requirements = [
            _requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=30, recurrence="ODD_WEEKS"),
            _requirement(IDROTT, CLASS_7B, requiredRoomType="GYM", size=30, recurrence="EVEN_WEEKS"),
        ]
        payload = _payload(requirements, rooms=[_gym()], placementRules=_shared("HARD"))

        assert _solve(payload, day_end=540).status in {"OPTIMAL", "FEASIBLE"}


def _refusal(payload: dict[str, object], **settings: object) -> InvalidScheduleInputError | None:
    """The named refusal the pre-flight gives the week, or None when it lets it through."""
    request = OptimizeScheduleRequest.model_validate(payload)
    try:
        SchedulerSolver(_settings(**settings))._validate_request(request)
    except InvalidScheduleInputError as refused:
        return refused
    return None


class TestThePreFlight:
    """What counting answers before any model is built, with the row named."""

    def test_a_class_with_two_lessons_a_day_has_no_day_for_a_lesson_between(self) -> None:
        requirement = _requirement(IDROTT, CLASS_7A)
        payload = _payload(
            [requirement, _requirement(MATTE, CLASS_7A)],
            rules={"maxLessonsPerDayPerGroup": 2},
            placementRules=_edges("HARD", (IDROTT, True, True)),
        )

        refused = _refusal(payload)

        assert refused is not None
        assert refused.code == "PLACEMENT_EDGE_DAY_TOO_SHORT"
        assert refused.params == {
            "requirement": requirement["id"], "edges": "both", "needed": 3, "maxPerDay": 2,
        }
        assert str(refused).startswith(f"{requirement['id']} cannot be placed")

    def test_three_lessons_a_day_hold_it(self) -> None:
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)],
            rules={"maxLessonsPerDayPerGroup": 3},
            placementRules=_edges("HARD", (IDROTT, True, True)),
        )

        assert _refusal(payload) is None

    def test_a_group_sharing_pupils_could_open_the_day_so_nothing_is_refused(self) -> None:
        group = str(uuid4())
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A), _requirement(MATTE, group, size=8)],
            rules={"maxLessonsPerDayPerGroup": 1},
            groupConflicts=[[CLASS_7A, group]],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )

        assert _refusal(payload) is None

    def test_a_class_with_only_the_barred_subject_has_nothing_to_open_with(self) -> None:
        requirement = _requirement(IDROTT, CLASS_7A, lessons=2)
        payload = _payload([requirement], placementRules=_edges("HARD", (IDROTT, True, False)))

        refused = _refusal(payload)

        assert refused is not None
        assert refused.code == "PLACEMENT_EDGE_NO_OTHER_LESSON"
        assert refused.params == {"requirement": requirement["id"], "edge": "FIRST"}

    def test_a_locked_lesson_could_open_the_day_so_nothing_is_refused(self) -> None:
        locked = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": CLASS_7A,
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
        }
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A)],
            fixedLessons=[locked],
            placementRules=_edges("HARD", (IDROTT, True, False)),
        )

        assert _refusal(payload) is None

    def test_a_soft_rule_refuses_nothing(self) -> None:
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A)], placementRules=_edges("SOFT", (IDROTT, True, True)),
        )

        assert _refusal(payload) is None

    def test_buildings_forced_on_more_days_than_the_week_has(self) -> None:
        rooms = _three_rooms()
        payload = _payload(
            _lessons_in_three_types(CLASS_7A),
            rooms=rooms,
            placementRules=_places("HARD", maxClassBuildings=1),
        )

        refused = _refusal(payload)

        assert refused is not None
        assert refused.code == "PLACEMENT_PLACES_FORCED"
        assert refused.params == {
            "party": "class", "kind": "building", "places": 2, "limit": 1, "days": 2, "open": 1,
        }
        assert _refusal(payload, days="1,2") is None

    def test_a_locked_lesson_with_more_pupils_than_the_hall_seats(self) -> None:
        gym = _gym(capacity=40)
        locked = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": CLASS_7B,
            "roomId": gym["id"], "dayOfWeek": 1, "startTime": "08:00:00",
            "endTime": "09:00:00", "studentCount": 45,
        }
        payload = _payload(
            [_requirement(IDROTT, CLASS_7A, requiredRoomType="GYM", size=5)],
            rooms=[gym], fixedLessons=[locked], placementRules=_shared("HARD"),
        )

        refused = _refusal(payload)

        assert refused is not None
        assert refused.code == "SHARED_ROOM_LOCK_OVER_CAPACITY"
        assert refused.params == {"room": gym["id"], "pupils": 45, "capacity": 40}

    def test_two_locks_that_overlap_with_more_pupils_than_the_hall_seats(self) -> None:
        gym = _gym(capacity=40)
        locks = [
            {
                "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": group,
                "roomId": gym["id"], "dayOfWeek": 1, "startTime": start, "endTime": end,
                "studentCount": 25,
            }
            for group, start, end in ((CLASS_7A, "08:00:00", "09:00:00"), (CLASS_7B, "08:30:00", "09:30:00"))
        ]
        payload = _payload(
            [_requirement(MATTE, CLASS_7A, size=5)],
            rooms=[gym, _room(None)], fixedLessons=locks, placementRules=_shared("HARD"),
        )

        refused = _refusal(payload, day_end=720)

        assert refused is not None
        assert refused.code == "SHARED_ROOM_LOCKS_OVER_CAPACITY"
        assert refused.params == {"room": gym["id"], "pupils": 50, "capacity": 40}
        # Back to back they never meet.
        locks[1]["startTime"], locks[1]["endTime"] = "09:00:00", "10:00:00"
        assert _refusal(payload, day_end=720) is None


class TestTheTimeoutProbe:
    """A timed-out week is probed without each HARD rule, one at a time, and never without a SOFT one."""

    def _relaxations(self, placement: dict[str, object]) -> dict[str, OptimizeScheduleRequest]:
        payload = _payload([_requirement(IDROTT, CLASS_7A), _requirement(MATTE, CLASS_7A)], placementRules=placement)
        solver = SchedulerSolver(_settings())
        return dict(solver._timeout_relaxations(OptimizeScheduleRequest.model_validate(payload)))

    def test_each_hard_rule_is_dropped_alone_and_the_others_stay(self) -> None:
        placement = {
            **_edges("HARD", (IDROTT, True, False)),
            **_places("HARD", maxClassRooms=3),
            **_shared("HARD"),
        }

        found = self._relaxations(placement)

        edges = found["PROBE_SOLVED_WITHOUT_SUBJECT_EDGES"].placement_rules
        assert edges is not None and edges.subject_edges is None
        assert edges.places is not None and edges.shared_rooms is not None
        changes = found["PROBE_SOLVED_WITHOUT_PLACE_LIMITS"].placement_rules
        assert changes is not None and changes.places is None and changes.subject_edges is not None
        shared = found["PROBE_SOLVED_WITHOUT_SHARED_ROOMS"].placement_rules
        assert shared is not None and shared.shared_rooms is None

    def test_the_last_rule_dropped_leaves_no_block_at_all(self) -> None:
        found = self._relaxations(_edges("HARD", (IDROTT, True, False)))

        assert found["PROBE_SOLVED_WITHOUT_SUBJECT_EDGES"].placement_rules is None

    def test_a_soft_rule_is_not_probed(self) -> None:
        found = self._relaxations({
            **_edges("SOFT", (IDROTT, True, False)), **_places("SOFT", maxClassRooms=3),
        })

        assert not [code for code in found if "SUBJECT_EDGES" in code or "CHANGE_LIMITS" in code]


class TestThePostPassKeepsAPartyInItsRoom:
    """Two equal classrooms are one room group to the model; the sweep keeps a party in the one it had."""

    def _plan(self, parties: dict[str, tuple[object, ...]]):
        from app.solver.room_allocator import RoomClass, RoomPlan

        return RoomPlan(classes=[RoomClass(index=0, room_indices=(0, 1))], parties=parties)

    def _sweep(self, plan, entries):
        assignment: dict[str, int] = {}
        plan._sweep(0, (0, 1), entries, assignment)
        return assignment

    def test_a_class_whose_first_room_was_taken_keeps_the_room_it_got(self) -> None:
        plan = self._plan({
            "b": (("class", "7B"),), "a1": (("class", "7A"),), "a2": (("class", "7A"),),
        })
        # 7B takes room 0 at slot 0; 7A is sent to room 1, and at slot 2 both are
        # free and the solver's own choice was room 0.
        entries = [(0, 2, "b", 0), (0, 2, "a1", 0), (2, 2, "a2", 0)]

        assert self._sweep(plan, entries) == {"b": 0, "a1": 1, "a2": 1}

    def test_without_the_rule_it_is_the_sweep_it_was(self) -> None:
        plan = self._plan({})
        entries = [(0, 2, "b", 0), (0, 2, "a1", 0), (2, 2, "a2", 0)]

        assert self._sweep(plan, entries) == {"b": 0, "a1": 1, "a2": 0}

    def test_a_teacher_is_kept_in_their_room_too(self) -> None:
        plan = self._plan({
            "b": (("class", "7B"), ("teacher", "T2")),
            "a1": (("class", "7A"), ("teacher", "T1")),
            "a2": (("class", "7C"), ("teacher", "T1")),
        })
        entries = [(0, 2, "b", 0), (0, 2, "a1", 0), (2, 2, "a2", 0)]

        assert self._sweep(plan, entries)["a2"] == 1

    def test_a_room_that_is_taken_is_not_kept(self) -> None:
        plan = self._plan({"a1": (("class", "7A"),), "a2": (("class", "7A"),), "c": (("class", "7C"),)})
        # 7A stood in room 1; at slot 2 room 1 is taken by 7C, which started
        # earlier in the sweep, so 7A takes the other room.
        entries = [(0, 2, "a1", 1), (2, 4, "c", 1), (3, 1, "a2", 1)]

        assignment = self._sweep(plan, entries)

        assert assignment["a1"] == 1 and assignment["c"] == 1 and assignment["a2"] == 0
