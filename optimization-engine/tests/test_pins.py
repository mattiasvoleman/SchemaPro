"""Fästa lektioner: a lesson of a requirement held where the school laid it.

A pinned lesson (AnonymousRequirement.pinnedLessons) stays its requirement's
own lesson and is held at a weekday and start, and in a room when the pin
names one (app/solver/pins.py). These tests hold what that promise rests on:

1. THE FIELD. One place per lesson, longest first; nothing pinned is the field
   left out; a pin is as long as the lesson at its place.
2. THE MODEL. A request without a pin builds the model it built. A pinned
   lesson comes back on its day and hour and in its room, whatever else the
   week holds: on a split post, among lessons of two lengths, in a block, off
   the week's step, in Bästa möjliga schema.
3. THE REFUSAL BEFORE THE MODEL. What a pin's own requirement rules out is
   refused by name: its week, its frame, a rast, its room, its block.
4. THE NAME. A week the pins make impossible is refused with the pinned
   lessons in the way named, and the ones not in the way left out.
5. THE TWO WAYS. A pinned lesson is stricter than the same lesson sent as a
   lock, never looser: what the pin's way lays, the lock's way lays too.
6. THE MEAL OF A TERM. Klassens måltid per del av läsåret cuts a class's year
   where its pinned lessons hold the meal differently, as it does for locks.

THE WEEK. 08:00-12:00, Monday to Friday: four one-hour slots a day. 7A has
matte with Tove and svenska with Sara, three lessons each; 7B has matte with
Tove, three, and svenska with Sara, two. Three rooms that hold any of them.
"""

from __future__ import annotations

import itertools
import random
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest, ScheduledLesson
from app.solver import scheduler_solver
from app.solver.pins import pins_of, without_pins
from app.solver.relaxation import HARD_RULES
from app.solver.scheduler_solver import SchedulerSolver, _start_step

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
if str(BENCHMARKS) not in sys.path:
    sys.path.insert(0, str(BENCHMARKS))

from lunch_flag_identity import classes_in_parts  # noqa: E402
from validate_schedule import _pin_problems, lunch_problems, validate  # noqa: E402

#: 08:00-12:00, Monday to Friday.
SHORT_DAY = {"SCHEDULE_DAY_END_MINUTES": 720}

CLASS_7A = str(uuid4())
CLASS_7B = str(uuid4())
MATTE = str(uuid4())
SVENSKA = str(uuid4())
MATTE_B = str(uuid4())
SVENSKA_B = str(uuid4())
MATTE_SUBJECT = str(uuid4())
TOVE = str(uuid4())
SARA = str(uuid4())
BERTIL = str(uuid4())
R1 = str(uuid4())
R2 = str(uuid4())
R3 = str(uuid4())
SMALL = str(uuid4())

IN_THE_WAY = "PLACED_LESSON_IN_THE_WAY"
IN_THE_WAY_ANY_ROOM = "PLACED_LESSON_IN_THE_WAY_ANY_ROOM"


def _settings(**overrides: object) -> Settings:
    return Settings(  # type: ignore[arg-type]
        **{"SOLVER_MAX_TIME_SECONDS": 10.0, "SOLVER_PROBE_SECONDS": 10.0, **SHORT_DAY, **overrides},
    )


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def _pin(day: int, start: str, *, minutes: int = 60, room: str | None = None) -> dict[str, object]:
    """A pin on `day` from `start` (HH:MM), as long as the lesson at its place."""
    begins = int(start[:2]) * 60 + int(start[3:])
    pin: dict[str, object] = {
        "dayOfWeek": day,
        "startTime": _clock(begins),
        "endTime": _clock(begins + minutes),
    }
    if room is not None:
        pin["roomId"] = room
    return pin


def _requirement(
    requirement_id: str, group: str, teacher: str, lessons: int = 3, **values: object,
) -> dict[str, object]:
    return {
        "id": requirement_id,
        "subjectId": MATTE_SUBJECT if requirement_id in (MATTE, MATTE_B) else str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher,
        "lessonsPerWeek": lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 20,
        "minGradeLevel": 7,
        "maxGradeLevel": 7,
        **values,
    }


def _payload(
    pins: dict[str, list[object]] | None = None,
    *,
    posts: dict[str, dict[str, object]] | None = None,
    **extra: object,
) -> dict[str, object]:
    """The week, with `pins` by requirement id and `posts` values laid over a requirement's own."""
    requirements = [
        _requirement(MATTE, CLASS_7A, TOVE),
        _requirement(SVENSKA, CLASS_7A, SARA),
        _requirement(MATTE_B, CLASS_7B, TOVE),
        _requirement(SVENSKA_B, CLASS_7B, SARA, 2),
    ]
    for requirement in requirements:
        requirement.update((posts or {}).get(str(requirement["id"]), {}))
        if pins and requirement["id"] in pins:
            requirement["pinnedLessons"] = pins[str(requirement["id"])]
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": room, "capacity": 30} for room in (R1, R2, R3)],
        **extra,
    }


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _solve(payload: dict[str, object], **settings: object):
    return SchedulerSolver(_settings(**settings)).solve(_request(payload))


def _placed(response, requirement: str) -> set[tuple[int, str, str]]:
    """Where a requirement's lessons came back: weekday, start (HH:MM) and room."""
    return {
        (lesson.day_of_week, lesson.start_time[:5], str(lesson.room_id))
        for lesson in response.lessons
        if str(lesson.requirement_id) == requirement
    }


def _starts(response, requirement: str) -> set[tuple[int, str]]:
    return {(day, start) for day, start, _room in _placed(response, requirement)}


def _codes(response) -> list[str]:
    return sorted(detail.code for detail in response.conflicts.conflicts)


def _problems(payload: dict[str, object], response) -> list[str]:
    solver = SchedulerSolver(_settings())
    return validate(solver._grid, _request(payload), response.lessons)


def _away(teacher: str, day: int) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": "TEACHER",
        "resourceId": teacher,
        "dayOfWeek": day,
        "date": None,
        "startTime": "08:00:00",
        "endTime": "12:00:00",
        "kind": "UNAVAILABLE",
    }


def _proto(payload: dict[str, object], *, include_objective: bool) -> bytes:
    """The model's wire form, as benchmarks/model_identity.py hashes it (ExportToFile)."""
    model, *_ = SchedulerSolver(_settings())._build_model(
        _request(payload), use_assumptions=False, include_objective=include_objective,
    )
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "model.pb"
        assert model.ExportToFile(str(path))
        return path.read_bytes()


#: Klassens måltid: 30 minutes somewhere in 11:00-12:00.
MEAL = {"lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00", "lunchMinutes": 30}
AUTUMN, SPRING = [True, False], [False, True]


def _lock_of_a_term(group: str, start: str, periods: list[bool], *, minutes: int = 30) -> dict[str, object]:
    """A locked half hour of a class on Monday, in the periods named."""
    begins = int(start[:2]) * 60 + int(start[3:])
    return {
        "id": str(uuid4()), "studentGroupId": group, "teacherId": str(uuid4()), "dayOfWeek": 1,
        "startTime": _clock(begins), "endTime": _clock(begins + minutes), "periods": periods,
    }


class TestTheField:
    def test_absent_is_none(self) -> None:
        assert all(r.pinned_lessons is None for r in _request(_payload()).requirements)

    def test_a_pin_is_read_at_its_place(self) -> None:
        request = _request(_payload({MATTE: [None, _pin(3, "11:00", room=R3), None]}))
        (pin,) = pins_of(request.requirements)
        assert (str(pin.requirement.id), pin.lesson_index) == (MATTE, 1)
        assert (pin.lesson.day_of_week, pin.lesson.start_time, str(pin.lesson.room_id)) == (
            3, "11:00:00", R3,
        )

    def test_the_list_has_one_place_per_lesson(self) -> None:
        with pytest.raises(ValidationError, match="lessonsPerWeek places"):
            _request(_payload({MATTE: [_pin(3, "11:00"), None]}))

    def test_nothing_pinned_is_the_field_left_out(self) -> None:
        with pytest.raises(ValidationError, match="field left out"):
            _request(_payload({MATTE: [None, None, None]}))

    def test_a_pin_is_as_long_as_the_lesson_at_its_place(self) -> None:
        with pytest.raises(ValidationError, match="length of the lesson"):
            _request(_payload({MATTE: [_pin(3, "10:00", minutes=45), None, None]}))

    def test_the_places_are_the_lessons_longest_first(self) -> None:
        """[40, 80] is one lesson of 80 and one of 40, and place 0 is the 80."""
        two_lengths = {"lessonsPerWeek": 2, "minutesPerLesson": 80, "lessonLengths": [40, 80]}
        _request(_payload(
            {MATTE: [_pin(1, "08:00", minutes=80), _pin(2, "08:00", minutes=40)]},
            posts={MATTE: two_lengths},
        ))
        with pytest.raises(ValidationError, match="length of the lesson"):
            _request(_payload({MATTE: [_pin(1, "08:00", minutes=40), None]}, posts={MATTE: two_lengths}))

    def test_unknown_keys_are_refused(self) -> None:
        with pytest.raises(ValidationError):
            _request(_payload({MATTE: [{**_pin(3, "11:00"), "teacherId": TOVE}, None, None]}))

    def test_the_rule_that_never_gives_way_is_listed(self) -> None:
        assert any("pinned lesson" in rule for rule in HARD_RULES)
        assert len(HARD_RULES) == len(set(HARD_RULES))

    def test_the_contract_gains_a_class_and_a_property_and_renames_nothing(self) -> None:
        """A class named like one in another module would rename both (app__schemas__…)."""
        schemas = create_app(_settings()).openapi()["components"]["schemas"]
        assert "PinnedLesson" in schemas
        assert "pinnedLessons" in schemas["AnonymousRequirement"]["properties"]
        assert not [name for name in schemas if "__" in name]


class TestTheModel:
    @pytest.mark.parametrize("include_objective", [True, False])
    @pytest.mark.parametrize("terms", [False, True])
    def test_a_week_without_a_pin_builds_the_model_it_built(
        self, include_objective: bool, terms: bool, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Every hook this feature has in the solver, taken out: the bytes are the same.

        `terms` is a year of two terms whose locks cut the class's meal in two
        (klassens måltid per del av läsåret), where the meal's parts ask the
        pins what they take.
        """
        payload = _payload()
        if terms:
            payload = _payload(
                posts={SVENSKA_B: {"periods": [False, True]}},
                rules=MEAL, periodWeeks=[20, 20], lunchPerPeriod=True,
                groups=[
                    {"id": group, "lunchHeadcount": 20, "minGradeLevel": 7, "maxGradeLevel": 7}
                    for group in (CLASS_7A, CLASS_7B)
                ],
                fixedLessons=[
                    _lock_of_a_term(CLASS_7A, "11:00", [True, False]),
                    _lock_of_a_term(CLASS_7A, "11:30", [False, True]),
                ],
            )
        settings = {"SCHEDULE_DAY_END_MINUTES": 780} if terms else {}

        def proto() -> bytes:
            model, *_ = SchedulerSolver(_settings(**settings))._build_model(
                _request(payload), use_assumptions=False, include_objective=include_objective,
            )
            with tempfile.TemporaryDirectory() as scratch:
                path = Path(scratch) / "model.pb"
                assert model.ExportToFile(str(path))
                return path.read_bytes()

        with_hooks = proto()
        monkeypatch.setattr(scheduler_solver, "add_pins", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(scheduler_solver, "pinned_room_ids", lambda _requirements: set())
        monkeypatch.setattr(scheduler_solver, "pinned_start_slots", lambda *_args: [])
        monkeypatch.setattr(scheduler_solver, "pins_of", lambda _requirements: [])
        monkeypatch.setattr(scheduler_solver, "meal_starts_taken_by_pins", lambda *_args, **_kwargs: None)
        assert proto() == with_hooks

    def test_a_pinned_lesson_starts_where_it_is_pinned(self) -> None:
        payload = _payload({MATTE: [None, _pin(3, "11:00"), None]})
        response = _solve(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert (3, "11:00") in _starts(response, MATTE)
        assert len(_placed(response, MATTE)) == 3
        assert _problems(payload, response) == []

    def test_a_pinned_room_is_the_lessons_room(self) -> None:
        payload = _payload({MATTE: [None, _pin(3, "11:00", room=R3), None]})
        response = _solve(payload)
        assert (3, "11:00", R3) in _placed(response, MATTE)
        assert _problems(payload, response) == []

    def test_a_pinned_room_is_a_room_class_of_its_own(self) -> None:
        """In a class of several rooms the post-pass hands them out in start order, pin or no pin."""
        solver = SchedulerSolver(_settings())

        def classes(payload: dict[str, object]) -> list[tuple[int, ...]]:
            _, _, _, plan, _ = solver._build_model(_request(payload), use_assumptions=False)
            return sorted(room_class.room_indices for room_class in plan.classes)

        assert classes(_payload()) == [(0, 1, 2)]
        assert classes(_payload({MATTE: [None, _pin(3, "11:00"), None]})) == [(0, 1, 2)]
        assert classes(_payload({MATTE: [None, _pin(3, "11:00", room=R3), None]})) == [(0, 1), (2,)]

    def test_every_prediction_of_the_room_classes_reads_the_pinned_room(self) -> None:
        """The estimate counts the class the model builds: a pinned room is one more."""
        solver = SchedulerSolver(_settings())
        plain = solver._estimate_model_size(_request(_payload({MATTE: [None, _pin(3, "11:00"), None]})))
        roomed = solver._estimate_model_size(
            _request(_payload({MATTE: [None, _pin(3, "11:00", room=R3), None]})),
        )
        assert roomed > plain
        assert plain == solver._estimate_model_size(_request(_payload())) + 1

    def test_the_estimate_of_the_named_rooms_reads_the_pinned_room(self) -> None:
        """A class of rooms that names them (odd weeks beside every week) is a room smaller for a pin's."""
        solver = SchedulerSolver(_settings())
        mixed = {MATTE: {"recurrence": "ODD_WEEKS"}}
        plain = solver._named_room_vars(_request(_payload({SVENSKA: [_pin(3, "11:00"), None, None]}, posts=mixed)))
        roomed = solver._named_room_vars(
            _request(_payload({SVENSKA: [_pin(3, "11:00", room=R3), None, None]}, posts=mixed)),
        )
        assert 0 < roomed < plain

    def test_the_probe_that_makes_blocks_of_its_own_leaves_a_pinned_post_alone(self) -> None:
        """A block ties place to place, and the probe's blocks are checked by nobody (test_week_load's year)."""
        import test_week_load as week

        payload = week._year(class_lessons=27)
        rows = week._group_rows(payload)
        pin = _pin(1, "08:25", minutes=40)
        # One of the three groups a teacher shares, and one of the siblings beside them.
        rows[1]["pinnedLessons"] = [pin, None, None, None]
        rows[3]["pinnedLessons"] = [None, pin, None, None]
        solver = SchedulerSolver(week._settings())
        request = week._request(payload)
        relaxed = solver._parallel_groups_probe(request, solver._week_loads(request))
        assert relaxed is not None
        by_id = {str(requirement.id): requirement for requirement in relaxed.requirements}
        assert by_id[str(rows[1]["id"])].block_id is None
        assert by_id[str(rows[3]["id"])].block_id is None
        blocked = [by_id[str(rows[index]["id"])].block_id for index in (0, 2, 4)]
        assert len(set(blocked)) == 1 and blocked[0] is not None

    def test_every_lesson_of_a_post_can_be_pinned(self) -> None:
        payload = _payload({
            MATTE: [_pin(1, "08:00", room=R1), _pin(1, "09:00", room=R2), _pin(5, "11:00", room=R3)],
        })
        response = _solve(payload)
        assert _placed(response, MATTE) == {(1, "08:00", R1), (1, "09:00", R2), (5, "11:00", R3)}
        assert _problems(payload, response) == []

    def test_a_pin_on_the_weeks_step_leaves_the_step(self) -> None:
        grid = SchedulerSolver(_settings())._grid
        plain = _start_step(_request(_payload()), grid)
        assert plain == 12
        assert _start_step(_request(_payload({MATTE: [_pin(3, "11:00"), None, None]})), grid) == plain

    def test_a_pin_off_the_weeks_step_takes_the_step_with_it_and_is_kept(self) -> None:
        """08:05 in a week on the hour: without the pin in the gcd no start reaches it."""
        payload = _payload({MATTE: [_pin(2, "08:05"), None, None]})
        assert _start_step(_request(payload), SchedulerSolver(_settings())._grid) == 1
        response = _solve(payload)
        assert (2, "08:05") in _starts(response, MATTE)
        assert _problems(payload, response) == []

    def test_a_pin_the_grid_cannot_read_is_the_step_of_one(self) -> None:
        """As every other source of the step has it: the pin is refused by name before any model is built."""
        payload = _payload({MATTE: [{**_pin(2, "09:00"), "startTime": "07:00:00", "endTime": "08:00:00"}, None, None]})
        assert _start_step(_request(payload), SchedulerSolver(_settings())._grid) == 1
        with pytest.raises(InvalidScheduleInputError) as refused:
            _solve(payload)
        assert refused.value.code == "PLACED_LESSON_OUTSIDE_THE_WEEK"

    def test_every_pin_feeds_the_step_and_not_the_first_one(self) -> None:
        """08:00 on Monday and 09:20 on Tuesday: a step read off the first alone never reaches the second.

        The week would then be refused with the second pin named as in the
        way, though the timetable exists.
        """
        payload = _payload({MATTE: [_pin(1, "08:00"), _pin(2, "09:20"), None]})
        assert _start_step(_request(payload), SchedulerSolver(_settings())._grid) == 4
        response = _solve(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert {(1, "08:00"), (2, "09:20")} <= _starts(response, MATTE)
        assert _problems(payload, response) == []

    @pytest.mark.parametrize("order", list(itertools.permutations(["08:00", "09:20", "09:30"])))
    def test_the_step_is_read_off_all_three_pins_in_any_order(self, order: tuple[str, ...]) -> None:
        """On the hour, twenty past and half past: ten minutes, whichever of them stands first or last.

        A step read off the first pin alone, off the first two or off the last
        alone answers something else for one order or another (the second
        review of PR 317, neighbours Q01 and Q02 of the first review's P09).
        """
        payload = _payload({MATTE: [_pin(1, order[0]), _pin(2, order[1]), _pin(3, order[2])]})
        assert _start_step(_request(payload), SchedulerSolver(_settings())._grid) == 2

    def test_a_place_on_a_split_post_is_its_teachers_lesson(self) -> None:
        payload = _payload(
            {MATTE: [None, None, _pin(4, "10:00")]},
            posts={MATTE: {"lessonTeacherIds": [TOVE, TOVE, BERTIL]}},
        )
        response = _solve(payload)
        (bertils,) = [
            lesson for lesson in response.lessons
            if str(lesson.requirement_id) == MATTE and str(lesson.teacher_id) == BERTIL
        ]
        assert (bertils.day_of_week, bertils.start_time[:5]) == (4, "10:00")
        assert _problems(payload, response) == []

    def test_the_shorter_lesson_is_pinned_at_its_own_place(self) -> None:
        payload = _payload(
            {MATTE: [None, _pin(2, "09:00", minutes=40)]},
            posts={MATTE: {"lessonsPerWeek": 2, "minutesPerLesson": 80, "lessonLengths": [80, 40]}},
        )
        response = _solve(payload)
        lessons = {
            (lesson.day_of_week, lesson.start_time[:5], lesson.end_time[:5])
            for lesson in response.lessons
            if str(lesson.requirement_id) == MATTE
        }
        assert (2, "09:00", "09:40") in lessons
        assert _problems(payload, response) == []

    def test_a_block_is_pinned_place_by_place(self) -> None:
        """Place 0 of both members on Monday 09:00, each in its own room; place 1 follows the block."""
        block = str(uuid4())
        payload = _payload(
            {MATTE: [_pin(1, "09:00", room=R1), None, None], MATTE_B: [_pin(1, "09:00"), None, None]},
            posts={
                MATTE: {"blockId": block},
                MATTE_B: {"blockId": block, "teacherId": BERTIL},
            },
        )
        response = _solve(payload)
        assert (1, "09:00", R1) in _placed(response, MATTE)
        assert _starts(response, MATTE) == _starts(response, MATTE_B)
        assert _problems(payload, response) == []

    def test_two_posts_that_never_meet_are_pinned_on_one_hour_in_one_room(self) -> None:
        """Slöjd udda veckor and hemkunskap jämna veckor: a pin holds its post's weeks and no others."""
        payload = _payload(
            {MATTE: [_pin(1, "08:00", room=R1)], MATTE_B: [_pin(1, "08:00", room=R1)]},
            posts={
                MATTE: {"lessonsPerWeek": 1, "recurrence": "ODD_WEEKS"},
                MATTE_B: {"lessonsPerWeek": 1, "recurrence": "EVEN_WEEKS", "studentGroupId": CLASS_7A},
            },
        )
        response = _solve(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert _placed(response, MATTE) == _placed(response, MATTE_B) == {(1, "08:00", R1)}

    def test_a_pinned_room_is_the_lessons_site_for_the_walk(self) -> None:
        """Restid i generatorn: R1 on one site, R2 and R3 on the other, half an hour apart.

        Matte pinned in R1 at 08:00 and in R2 at 10:00 leaves 7A and Tove the
        walk; pinned in R2 at 09:00 it leaves them none, and the week is
        refused with the two pinned lessons among what it names.
        """
        norra, sodra = str(uuid4()), str(uuid4())
        sites = {
            "rooms": [
                {"id": R1, "capacity": 30, "siteId": norra},
                {"id": R2, "capacity": 30, "siteId": sodra},
                {"id": R3, "capacity": 30, "siteId": sodra},
            ],
            "siteTravelTimes": [{"siteAId": norra, "siteBId": sodra, "minutes": 30}],
        }
        apart = _payload({MATTE: [_pin(1, "08:00", room=R1), _pin(1, "10:00", room=R2), None]}, **sites)
        response = _solve(apart)
        assert {(1, "08:00", R1), (1, "10:00", R2)} <= _placed(response, MATTE)
        assert _problems(apart, response) == []
        flush_week = _payload(
            {MATTE: [_pin(1, "08:00", room=R1), _pin(1, "09:00", room=R2), None]}, **sites,
        )
        flush = _solve(flush_week)
        assert flush.status == "INFEASIBLE"
        # And in the probe that sets every literal aside to ask about the walk
        # alone, the pinned lessons stay where they are, as locked ones do:
        # with them free the fixed part holds the walk and the probe says the
        # walk is not the matter.
        solver = SchedulerSolver(_settings())
        deadline = time.monotonic() + 10.0
        assert solver._walk_against_the_fixed_part(_request(flush_week), deadline=deadline) is True
        assert solver._walk_against_the_fixed_part(_request(apart), deadline=deadline) is False
        named = [detail for detail in flush.conflicts.conflicts if detail.code == IN_THE_WAY]
        assert {(detail.params["start"], detail.params["room"]) for detail in named} == {
            ("08:00", R1), ("09:00", R2),
        }

    def test_bästa_möjliga_schema_keeps_the_pin_and_prices_the_rule_it_breaks(self) -> None:
        """Two of matte pinned on Monday under "at most one a day": the rule gives way, the pins do not."""
        payload = _payload(
            {MATTE: [_pin(1, "08:00"), _pin(1, "09:00"), None]},
            posts={MATTE: {"maxLessonsPerDay": 1}},
        )
        strict = _solve(payload)
        assert strict.status == "INFEASIBLE"
        assert _codes(strict) == [IN_THE_WAY_ANY_ROOM, IN_THE_WAY_ANY_ROOM, "SUBJECT_DISTRIBUTION_PER_DAY"]
        best = _solve({**payload, "relaxation": {"mode": "BEST_EFFORT"}})
        assert best.status in ("OPTIMAL", "FEASIBLE")
        assert {(1, "08:00"), (1, "09:00")} <= _starts(best, MATTE)
        assert [deviation.code for deviation in best.deviations or []]

    def test_bästa_möjliga_schema_refuses_a_pin_no_rule_can_give_way_for(self) -> None:
        payload = _payload(
            {MATTE: [_pin(2, "09:00"), None, None], SVENSKA: [_pin(2, "09:00"), None, None]},
            relaxation={"mode": "BEST_EFFORT"},
        )
        response = _solve(payload)
        assert response.status == "INFEASIBLE"
        assert _codes(response) == [IN_THE_WAY_ANY_ROOM, IN_THE_WAY_ANY_ROOM]


def _three_member_block(odd_member: int, place: int) -> dict[str, object]:
    """A block of three posts pinned at `place` on Tuesday 09:00 in each member but `odd_member`, which has Wednesday."""
    block = str(uuid4())
    third, class_c, teacher_c = str(uuid4()), str(uuid4()), str(uuid4())
    members = [MATTE, MATTE_B, third]
    payload = _payload(posts={MATTE: {"blockId": block}, MATTE_B: {"blockId": block, "teacherId": BERTIL}})
    requirements: list[dict[str, object]] = payload["requirements"]  # type: ignore[assignment]
    requirements.append({**_requirement(third, class_c, teacher_c), "blockId": block})
    for requirement in requirements:
        if requirement["id"] in members:
            places: list[object] = [None, None, None]
            places[place] = _pin(3 if members.index(str(requirement["id"])) == odd_member else 2, "09:00")
            requirement["pinnedLessons"] = places
    return payload


def _beside_a_förläggning(payload: dict[str, object]) -> dict[str, object]:
    """The week with a förläggning in it: svenska of 7B has a lesson as a lock on Friday, and `placements` says so."""
    lock = str(uuid4())
    requirements: list[dict[str, object]] = payload["requirements"]  # type: ignore[assignment]
    whole = next(requirement for requirement in requirements if requirement["id"] == SVENSKA_B)
    payload["requirements"] = [
        {**requirement, "lessonsPerWeek": 1} if requirement["id"] == SVENSKA_B else requirement
        for requirement in requirements
    ]
    payload["fixedLessons"] = [{
        "id": lock, "teacherId": SARA, "studentGroupId": CLASS_7B, "roomId": R1,
        "dayOfWeek": 5, "startTime": "10:00:00", "endTime": "11:00:00",
    }]
    payload["placements"] = {"lessons": [{"fixedLessonId": lock, "requirementId": SVENSKA_B}], "requirements": [whole]}
    return payload


class TestTheRefusalBeforeTheModel:
    def _refused(self, payload: dict[str, object]) -> InvalidScheduleInputError:
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(payload)
        return refusal.value

    @pytest.mark.parametrize(
        "pin",
        [
            pytest.param(_pin(6, "09:00"), id="a Saturday"),
            pytest.param(_pin(2, "12:00"), id="after the day"),
            pytest.param(_pin(2, "07:00"), id="before the day"),
            pytest.param(_pin(2, "11:30"), id="across the day's end"),
            pytest.param(_pin(2, "09:02"), id="between the grid's steps"),
        ],
    )
    def test_a_pin_outside_the_week_is_refused_by_name(self, pin: dict[str, object]) -> None:
        refusal = self._refused(_payload({MATTE: [pin, None, None]}))
        assert refusal.code == "PLACED_LESSON_OUTSIDE_THE_WEEK"
        assert refusal.params == {
            "requirement": MATTE,
            "day": pin["dayOfWeek"],
            "start": str(pin["startTime"])[:5],
            "end": str(pin["endTime"])[:5],
        }

    def test_a_pin_outside_the_frame_is_refused_by_name(self) -> None:
        frame = {"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "08:00:00", "endTime": "11:00:00"}
        assert _solve(_payload({MATTE: [_pin(3, "10:00"), None, None]}, frameTimes=[frame])).lessons
        refusal = self._refused(_payload({MATTE: [_pin(3, "11:00"), None, None]}, frameTimes=[frame]))
        assert refusal.code == "PLACED_LESSON_OUTSIDE_FRAME"

    def test_a_pin_whose_margins_cross_the_day_is_refused_by_its_own_name(self) -> None:
        """The frame offers the hour. What does not fit is the changing before it, or the shower after."""
        before = self._refused(_payload(
            {MATTE: [_pin(3, "08:00"), None, None]}, posts={MATTE: {"minutesBefore": 15}},
        ))
        assert before.code == "PLACED_LESSON_MARGINS_PAST_THE_DAY"
        after = self._refused(_payload(
            {MATTE: [_pin(3, "11:00"), None, None]}, posts={MATTE: {"minutesAfter": 15}},
        ))
        assert after.code == "PLACED_LESSON_MARGINS_PAST_THE_DAY"
        frame = {
            "minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "08:00:00", "endTime": "12:00:00",
            "changeoverMinutes": 10,
        }
        changeover = self._refused(_payload({MATTE: [_pin(3, "11:00"), None, None]}, frameTimes=[frame]))
        assert changeover.code == "PLACED_LESSON_MARGINS_PAST_THE_DAY"
        assert _solve(_payload(
            {MATTE: [_pin(3, "08:15"), None, None]}, posts={MATTE: {"minutesBefore": 15}},
        )).lessons

    def test_a_pin_across_a_rast_is_refused_by_name(self) -> None:
        rast = {"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "09:00:00", "endTime": "09:20:00"}
        assert _solve(_payload({MATTE: [_pin(3, "09:20"), None, None]}, rasts=[rast])).lessons
        for start in ("09:00", "08:30"):
            refusal = self._refused(_payload({MATTE: [_pin(3, start), None, None]}, rasts=[rast]))
            assert refusal.code == "PLACED_LESSON_IN_A_RAST"

    def test_a_room_too_small_is_refused_by_name(self) -> None:
        rooms = [{"id": room, "capacity": 30} for room in (R1, R2, R3)] + [{"id": SMALL, "capacity": 10}]
        refusal = self._refused(_payload({MATTE: [_pin(3, "10:00", room=SMALL), None, None]}, rooms=rooms))
        assert refusal.code == "PLACED_LESSON_ROOM_NOT_ALLOWED"
        assert refusal.params["room"] == SMALL

    def test_a_room_outside_the_subjects_lock_is_refused_strictly_and_priced_in_the_mode(self) -> None:
        lock = {"id": str(uuid4()), "subjectId": MATTE_SUBJECT, "roomIds": [R1], "kind": "LOCK"}
        payload = _payload({MATTE: [_pin(3, "10:00", room=R2), None, None]}, roomPreferences=[lock])
        assert self._refused(payload).code == "PLACED_LESSON_ROOM_NOT_ALLOWED"
        best = _solve({**payload, "relaxation": {"mode": "BEST_EFFORT"}})
        assert (3, "10:00", R2) in _placed(best, MATTE)
        assert "ROOM_LOCK" in " ".join(deviation.code for deviation in best.deviations or [])

    def test_a_room_the_request_does_not_hold_is_the_callers_error(self) -> None:
        refusal = self._refused(_payload({MATTE: [_pin(3, "10:00", room=str(uuid4())), None, None]}))
        assert refusal.code == ""

    def test_a_block_pinned_in_one_member_only_is_refused_by_name(self) -> None:
        block = str(uuid4())
        posts = {MATTE: {"blockId": block}, MATTE_B: {"blockId": block, "teacherId": BERTIL}}
        refusal = self._refused(_payload({MATTE: [_pin(1, "09:00"), None, None]}, posts=posts))
        assert refusal.code == "PLACED_LESSONS_OF_BLOCK_DIFFER"
        assert refusal.params == {"block": block, "requirement": MATTE, "other": MATTE_B}

    def test_a_block_pinned_at_two_times_is_refused_by_name(self) -> None:
        block = str(uuid4())
        posts = {MATTE: {"blockId": block}, MATTE_B: {"blockId": block, "teacherId": BERTIL}}
        refusal = self._refused(_payload(
            {MATTE: [_pin(1, "09:00"), None, None], MATTE_B: [_pin(1, "10:00"), None, None]}, posts=posts,
        ))
        assert refusal.code == "PLACED_LESSONS_OF_BLOCK_DIFFER"

    def test_a_block_pinned_at_two_places_on_one_hour_is_refused_by_name(self) -> None:
        """Place 0 of one member and place 1 of the other: the k-th lessons start together."""
        block = str(uuid4())
        posts = {MATTE: {"blockId": block}, MATTE_B: {"blockId": block, "teacherId": BERTIL}}
        refusal = self._refused(_payload(
            {MATTE: [_pin(1, "09:00"), None, None], MATTE_B: [None, _pin(1, "09:00"), None]}, posts=posts,
        ))
        assert refusal.code == "PLACED_LESSONS_OF_BLOCK_DIFFER"

    def test_a_block_is_read_at_every_place_and_not_the_first(self) -> None:
        """Place 0 pinned nowhere, place 1 on Tuesday in one member and on Wednesday in the other."""
        block = str(uuid4())
        posts = {MATTE: {"blockId": block}, MATTE_B: {"blockId": block, "teacherId": BERTIL}}
        refusal = self._refused(_payload(
            {MATTE: [None, _pin(2, "09:00"), None], MATTE_B: [None, _pin(3, "09:00"), None]}, posts=posts,
        ))
        assert refusal.code == "PLACED_LESSONS_OF_BLOCK_DIFFER"

    def test_a_pins_own_refusal_is_not_asked_again_with_the_förläggningar_released(self) -> None:
        """A request with förlagda locks AND a pin its frame refuses: the answer is the pin's own refusal.

        A refusal before the model is asked once more with every förläggning
        released, to say whether they were what stood in the way
        (_refusal_with_placements_named). A pinned lesson's own refusal names
        its lesson already, and that question would bury the one under all of
        them.
        """
        lock = str(uuid4())
        payload = _payload(
            {MATTE: [_pin(3, "08:00"), None, None]},
            frameTimes=[{"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "09:00:00", "endTime": "11:00:00"}],
            fixedLessons=[{
                "id": lock, "teacherId": TOVE, "studentGroupId": CLASS_7B, "roomId": R1,
                "dayOfWeek": 5, "startTime": "10:00:00", "endTime": "11:00:00",
            }],
        )
        requirements: list[dict[str, object]] = payload["requirements"]  # type: ignore[assignment]
        whole = next(requirement for requirement in requirements if requirement["id"] == MATTE_B)
        payload["requirements"] = [
            {**requirement, "lessonsPerWeek": 2} if requirement["id"] == MATTE_B else requirement
            for requirement in requirements
        ]
        payload["placements"] = {
            "lessons": [{"fixedLessonId": lock, "requirementId": MATTE_B}],
            "requirements": [whole],
        }
        with pytest.raises(InvalidScheduleInputError) as refused:
            _solve(payload)
        assert refused.value.code == "PLACED_LESSON_OUTSIDE_FRAME"

    @pytest.mark.parametrize("place", [0, 1, 2])
    @pytest.mark.parametrize("odd_member", [0, 1, 2])
    def test_a_member_of_a_block_pinned_apart_is_refused_wherever_it_stands(self, place: int, odd_member: int) -> None:
        """Three members, and each of them in turn the one pinned on another day, at each place.

        A rule that reads place 0 alone, leaves the last place unread or
        compares only the second member with the first lets one of the nine
        through to the model, which refuses it by another name (the second
        review of PR 317, Q03 and Q04 beside the first review's V09).
        """
        assert self._refused(_three_member_block(odd_member, place)).code == "PLACED_LESSONS_OF_BLOCK_DIFFER"

    def test_a_pin_outside_the_week_is_its_own_refusal_beside_a_förläggning(self) -> None:
        """Not the frame's refusal alone: every refusal of a pin's own is kept out of the released week's question (Q06)."""
        payload = _beside_a_förläggning(_payload({MATTE: [_pin(6, "08:00"), None, None]}))
        assert self._refused(payload).code == "PLACED_LESSON_OUTSIDE_THE_WEEK"

    def test_a_pin_in_a_room_too_small_is_its_own_refusal_beside_a_förläggning(self) -> None:
        payload = _payload({MATTE: [_pin(1, "08:00", room=SMALL), None, None]})
        payload["rooms"] = [*payload["rooms"], {"id": SMALL, "capacity": 5}]  # type: ignore[misc]
        assert self._refused(_beside_a_förläggning(payload)).code == "PLACED_LESSON_ROOM_NOT_ALLOWED"

    def test_a_block_pinned_apart_is_its_own_refusal_beside_a_förläggning(self) -> None:
        """The block's code begins PLACED_LESSONS_, which a reading of the prefix PLACED_LESSON_ leaves out (Q07)."""
        assert self._refused(_beside_a_förläggning(_three_member_block(2, 1))).code == "PLACED_LESSONS_OF_BLOCK_DIFFER"

    @pytest.mark.parametrize("pinned", [False, True], ids=["no pin", "a room pinned for another class"])
    def test_a_room_pinned_for_another_class_leaves_the_places_a_class_is_forced_into(self, pinned: bool) -> None:
        """7A has a lesson in an ordinary room and one in the lab on the week's one day, and may be in one room a day.

        The count before the model refuses it by the places the class is
        forced into (PLACEMENT_PLACES_FORCED, _verify_place_limits). A lesson
        of 7B pinned in one of the three ordinary rooms makes that room a
        class of its own in the model. Read by the count too, 7A's ordinary
        lesson would be free to choose between two places, the count would
        pass, and the week would be refused by the proof without the count's
        sentence. The first review's S23: the count once read the pinned
        rooms, and the edit that took the reading away refused more weeks
        early, every one of them rightly.
        """
        ordinary, lab = [str(uuid4()) for _ in range(3)], str(uuid4())
        other = _requirement(str(uuid4()), CLASS_7B, str(uuid4()), 1, requiredRoomType="STD")
        if pinned:
            other["pinnedLessons"] = [_pin(1, "08:00", room=ordinary[0])]
        payload = {
            "requestId": str(uuid4()),
            "academicYearId": str(uuid4()),
            "requirements": [
                _requirement(str(uuid4()), CLASS_7A, str(uuid4()), 1, requiredRoomType="STD"),
                _requirement(str(uuid4()), CLASS_7A, str(uuid4()), 1, requiredRoomType="LAB"),
                other,
            ],
            "rooms": [
                *({"id": room, "capacity": 30, "type": "STD"} for room in ordinary),
                {"id": lab, "capacity": 30, "type": "LAB"},
            ],
            "placementRules": {"places": {"mode": "HARD", "maxClassRooms": 1}},
        }
        with pytest.raises(InvalidScheduleInputError) as refused:
            _solve(payload, SCHEDULE_DAYS="1")
        assert refused.value.code == "PLACEMENT_PLACES_FORCED"
        assert refused.value.params == {"party": "class", "kind": "room", "places": 2, "limit": 1, "days": 2, "open": 1}

    def test_a_pin_five_minutes_past_the_days_end_is_refused_by_name(self) -> None:
        """The day ends 12:00, and 11:05 and sixty minutes is one step of the grid past it (Q11)."""
        assert self._refused(_payload({MATTE: [_pin(1, "11:05"), None, None]})).code == "PLACED_LESSON_OUTSIDE_THE_WEEK"


class TestTheName:
    def test_two_pins_on_one_hour_of_a_class_are_named_and_the_third_is_not(self) -> None:
        response = _solve(_payload({
            MATTE: [_pin(2, "09:00"), None, None],
            SVENSKA: [_pin(2, "09:00"), None, None],
            MATTE_B: [None, _pin(5, "11:00"), None],
        }))
        assert response.status == "INFEASIBLE"
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        assert _codes(response) == [IN_THE_WAY_ANY_ROOM, IN_THE_WAY_ANY_ROOM]
        assert {detail.params["requirement"] for detail in response.conflicts.conflicts} == {MATTE, SVENSKA}
        assert all(
            detail.params == {"requirement": detail.params["requirement"], "day": 2, "start": "09:00", "end": "10:00"}
            for detail in response.conflicts.conflicts
        )

    def test_two_pins_on_one_hour_of_a_teacher_are_named(self) -> None:
        response = _solve(_payload({
            MATTE: [_pin(2, "09:00"), None, None], MATTE_B: [_pin(2, "09:00"), None, None],
        }))
        assert response.status == "INFEASIBLE"
        assert {detail.params["requirement"] for detail in response.conflicts.conflicts} == {MATTE, MATTE_B}

    def test_two_pins_in_one_room_on_one_hour_are_named_with_the_room(self) -> None:
        response = _solve(_payload({
            MATTE: [_pin(1, "08:00", room=R1), None, None],
            SVENSKA_B: [_pin(1, "08:00", room=R1), None],
        }))
        assert response.status == "INFEASIBLE"
        assert _codes(response) == [IN_THE_WAY, IN_THE_WAY]
        assert {detail.params["room"] for detail in response.conflicts.conflicts} == {R1}
        assert {str(room) for detail in response.conflicts.conflicts for room in detail.room_ids} == {R1}

    def test_a_pinned_room_that_is_never_free_is_named_with_the_pin(self) -> None:
        """R1 is closed all week. Nothing but the pin puts matte there, so the proof rests on the pin.

        The room's equality hangs on the pin's literal as the start's does:
        posted bare, the week would be refused for the room's reservations
        with no word of the lesson the school laid in it.
        """
        closed = [{**_away(R1, day), "resourceKind": "ROOM"} for day in (1, 2, 3, 4, 5)]
        response = _solve(_payload({MATTE: [_pin(2, "09:00", room=R1), None, None]}, constraints=closed))
        assert response.status == "INFEASIBLE"
        codes = _codes(response)
        assert codes.count(IN_THE_WAY) == 1
        assert set(codes) == {"AVAIL_CONSTRAINT_BLOCKS_LESSONS", IN_THE_WAY}

    def test_a_pinned_room_locked_all_week_is_named_by_the_proof_itself(self) -> None:
        """R1 holds another class's locked lessons every hour of the week, and matte is pinned into it.

        A lock's window has no literal, so the only thing the proof can rest
        on is the pin, and it does: the summary is the proof's, not the
        released week's. With the room's equality posted bare the week is
        impossible on no assumption at all, and the pin is named only by
        the reserve.
        """
        elsewhere = str(uuid4())
        locks = [
            {
                "id": str(uuid4()), "teacherId": BERTIL, "studentGroupId": elsewhere, "roomId": R1,
                "dayOfWeek": day, "startTime": "08:00:00", "endTime": "12:00:00",
            }
            for day in (1, 2, 3, 4, 5)
        ]
        response = _solve(_payload({MATTE: [_pin(2, "09:00", room=R1), None, None]}, fixedLessons=locks))
        assert response.status == "INFEASIBLE"
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        assert _codes(response) == [IN_THE_WAY]

    def test_a_pin_where_the_teacher_is_away_is_named_with_the_reservation(self) -> None:
        response = _solve(_payload(
            {MATTE: [None, None, _pin(4, "10:00")], MATTE_B: [None, _pin(5, "11:00"), None]},
            constraints=[_away(TOVE, 4)],
        ))
        assert response.status == "INFEASIBLE"
        assert _codes(response) == ["AVAIL_CONSTRAINT_BLOCKS_LESSONS", IN_THE_WAY_ANY_ROOM]

    def test_a_pin_with_no_room_of_its_type_free_is_named_alone(self) -> None:
        """The one laboratory holds a locked lesson on Monday 08:00; matte, pinned there, needs it.

        THE PIN AND NOTHING BESIDE IT, and that is the limit of the name. A
        lock's window is posted bare and one eligible room class is forced
        with no literal, so the proof rests on the pin alone: the school is
        told which lesson cannot stand where it was laid and not that the
        laboratory is taken. The lesson not in the way is still left out.
        """
        lab = str(uuid4())
        lock = {
            "id": str(uuid4()), "teacherId": BERTIL, "studentGroupId": str(uuid4()), "roomId": lab,
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
        }
        payload = _payload(
            {MATTE: [_pin(1, "08:00"), None, None], MATTE_B: [None, _pin(5, "11:00"), None]},
            posts={MATTE: {"requiredRoomType": "LAB"}},
            rooms=[{"id": room, "capacity": 30} for room in (R1, R2, R3)]
            + [{"id": lab, "capacity": 30, "type": "LAB"}],
            fixedLessons=[lock],
        )
        response = _solve(payload)
        assert response.status == "INFEASIBLE"
        assert _codes(response) == [IN_THE_WAY_ANY_ROOM]
        assert {detail.params["requirement"] for detail in response.conflicts.conflicts} == {MATTE}
        moved = _payload({MATTE: [_pin(1, "09:00"), None, None]}, **{
            key: payload[key] for key in ("rooms", "fixedLessons")
        }, posts={MATTE: {"requiredRoomType": "LAB"}})
        assert (1, "09:00", lab) in _placed(_solve(moved), MATTE)

    def test_pins_that_leave_a_class_no_lunch_are_named(self) -> None:
        """7A eats half an hour inside 10:00-11:00, and matte is pinned across all of it on Tuesday."""
        lunch = {
            "groups": [{"id": CLASS_7A, "lunchHeadcount": 20}, {"id": CLASS_7B, "lunchHeadcount": 20}],
            "rules": {"lunchStartTime": "10:00:00", "lunchEndTime": "11:00:00", "lunchMinutes": 30},
        }
        assert _solve(_payload({MATTE: [_pin(2, "09:00"), None, None]}, **lunch)).lessons
        response = _solve(_payload(
            {MATTE: [_pin(2, "10:00"), None, None], MATTE_B: [None, _pin(5, "08:00"), None]}, **lunch,
        ))
        assert response.status == "INFEASIBLE"
        named = [detail for detail in response.conflicts.conflicts if detail.code == IN_THE_WAY_ANY_ROOM]
        assert [detail.params["requirement"] for detail in named] == [MATTE]

    def test_a_pin_holds_its_posts_periods_and_no_others(self) -> None:
        """Four periods. Two of Tove's posts pinned on one hour meet only where their periods do."""
        def week(first: list[bool], second: list[bool]) -> dict[str, object]:
            return _payload(
                {MATTE: [_pin(2, "09:00")], MATTE_B: [_pin(2, "09:00")]},
                posts={
                    MATTE: {"lessonsPerWeek": 1, "periods": first},
                    MATTE_B: {"lessonsPerWeek": 1, "periods": second},
                },
                periodWeeks=[10, 9, 10, 9],
            )

        apart = _solve(week([True, True, False, False], [False, False, True, True]))
        assert apart.status in ("OPTIMAL", "FEASIBLE")
        assert _starts(apart, MATTE) == _starts(apart, MATTE_B) == {(2, "09:00")}
        together = _solve(week([True, True, False, False], [False, True, True, False]))
        assert together.status == "INFEASIBLE"
        assert _codes(together) == [IN_THE_WAY_ANY_ROOM, IN_THE_WAY_ANY_ROOM]

    def test_pins_over_the_class_daily_maximum_are_named_with_the_maximum(self) -> None:
        """At most two lessons a day for a class, and three of 7A's pinned on Monday."""
        response = _solve(_payload(
            {
                MATTE: [_pin(1, "08:00"), _pin(1, "09:00"), None],
                SVENSKA: [_pin(1, "10:00"), None, None],
            },
            rules={"maxLessonsPerDayPerGroup": 2},
        ))
        assert response.status == "INFEASIBLE"
        codes = _codes(response)
        assert codes.count(IN_THE_WAY_ANY_ROOM) == 3
        assert "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT" in codes

    def test_a_pinned_week_with_the_walk_is_explained_once_and_on_the_whole_cap(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Restid i generatorn explains with the objective first, on a part of the cap. A pinned week does not.

        A week with the walk is explained on the model with the objective for
        EXPLAIN_WALK_FIRST_SECONDS, and on the one without it when that proved
        nothing. A week with a pinned lesson is explained on the model without
        the objective from the start, so it has the whole cap and no second
        pass. The explaining solve is stood in for by one that proves nothing,
        which is when a second pass would be made.
        """
        norra, sodra = str(uuid4()), str(uuid4())
        week = _payload(
            {MATTE: [_pin(1, "08:00", room=R1), _pin(1, "09:00", room=R2), None]},
            rooms=[
                {"id": R1, "capacity": 30, "siteId": norra},
                {"id": R2, "capacity": 30, "siteId": sodra},
                {"id": R3, "capacity": 30, "siteId": sodra},
            ],
            siteTravelTimes=[{"siteAId": norra, "siteBId": sodra, "minutes": 30}],
        )
        asked: list[tuple[str, float]] = []

        def proves_nothing(solver: cp_model.CpSolver, _model: object, *, what: str, **_rest: object) -> object:
            asked.append((what, solver.parameters.max_time_in_seconds))
            return cp_model.UNKNOWN

        monkeypatch.setattr(scheduler_solver, "_solve_guarded", proves_nothing)
        solver = SchedulerSolver(_settings())
        solver._explain_infeasible(_request(week))
        cap = min(10.0, SchedulerSolver.EXPLAIN_CAP_SECONDS)
        assert cap > SchedulerSolver.EXPLAIN_WALK_FIRST_SECONDS
        assert [entry for entry in asked if entry[0].startswith("the explanation")] == [("the explanation", cap)]

    def test_a_week_impossible_without_its_pins_names_none_of_them(self) -> None:
        """Tove's six lessons in the four hours of the one day she is in: no pin is why."""
        response = _solve(_payload(
            {SVENSKA: [_pin(2, "09:00"), None, None]},
            constraints=[_away(TOVE, day) for day in (1, 2, 3, 4)],
        ))
        assert response.status == "INFEASIBLE"
        assert IN_THE_WAY_ANY_ROOM not in _codes(response)
        assert response.conflicts.summary_code != "PLACEMENTS_PROBE_SUMMARY"

    def test_a_request_that_turned_its_probes_off_is_not_explained(self) -> None:
        response = _solve(_payload(
            {MATTE: [_pin(2, "09:00"), None, None], SVENSKA: [_pin(2, "09:00"), None, None]},
            search={"probes": False},
        ))
        assert response.status == "INFEASIBLE"
        assert response.conflicts is None

    def test_a_proof_that_names_nothing_releases_the_pins_and_names_them_all(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The reserve: the week once more with nothing pinned, as a förlagd lock's is asked."""
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis",
            lambda _solver, _registry: scheduler_solver.no_core_analysis(),
        )
        response = _solve(_payload({
            MATTE: [_pin(2, "09:00"), None, None],
            SVENSKA: [_pin(2, "09:00", room=R2), None, None],
            MATTE_B: [None, _pin(5, "11:00"), None],
        }))
        assert response.status == "INFEASIBLE"
        assert response.conflicts.summary_code == "PLACEMENTS_PROBE_SUMMARY"
        assert response.conflicts.summary_params["count"] == 3
        assert _codes(response)[:4] == [
            "CONFLICT_NO_CORE_GUESS", IN_THE_WAY, IN_THE_WAY_ANY_ROOM, IN_THE_WAY_ANY_ROOM,
        ]


class TestTheReleasedWeek:
    def test_a_week_without_a_pin_is_itself(self) -> None:
        request = _request(_payload())
        assert without_pins(request) is request

    def test_every_pin_goes_and_nothing_else_moves(self) -> None:
        pinned = _payload({MATTE: [_pin(2, "09:00", room=R1), None, None], SVENSKA: [None, _pin(3, "10:00"), None]})
        released = without_pins(_request(pinned))
        assert pins_of(released.requirements) == []
        bare = {**pinned, "requirements": [
            {key: value for key, value in requirement.items() if key != "pinnedLessons"}
            for requirement in pinned["requirements"]  # type: ignore[union-attr]
        ]}
        assert released == _request(bare)

    def test_a_timeout_probes_the_week_with_its_pins_released(self) -> None:
        request = _request(_payload({MATTE: [_pin(2, "09:00"), None, None]}))
        relaxations = dict(SchedulerSolver(_settings())._timeout_relaxations(request))
        assert pins_of(relaxations["PROBE_SOLVED_WITH_PLACEMENTS_RELEASED"].requirements) == []

    def test_a_week_without_pins_has_no_such_probe(self) -> None:
        codes = [code for code, _ in SchedulerSolver(_settings())._timeout_relaxations(_request(_payload()))]
        assert "PROBE_SOLVED_WITH_PLACEMENTS_RELEASED" not in codes


class TestTheIndependentCheck:
    """benchmarks/validate_schedule._pin_problems is the judge of the property tests, so it is judged here.

    One lesson handed to it at a time: in the wrong room, with the wrong end,
    one lesson for two pins, the wrong teacher's lesson on a split post, on
    the wrong day, and with the wrong start.
    """

    def _lesson(self, requirement: str, **given: object) -> ScheduledLesson:
        return ScheduledLesson(**{  # type: ignore[arg-type]
            "requirement_id": requirement, "room_id": R1, "day_of_week": 3,
            "start_time": "10:00:00", "end_time": "11:00:00", **given,
        })

    def test_a_lesson_in_another_room_than_the_pins_is_a_problem(self) -> None:
        request = _request(_payload({MATTE: [None, _pin(3, "10:00", room=R2), None]}))
        assert _pin_problems(request, [self._lesson(MATTE, room_id=R1)])
        assert not _pin_problems(request, [self._lesson(MATTE, room_id=R2)])

    def test_a_lesson_that_ends_at_another_minute_is_a_problem(self) -> None:
        request = _request(_payload({MATTE: [None, _pin(3, "10:00"), None]}))
        assert _pin_problems(request, [self._lesson(MATTE, end_time="10:50:00")])
        assert not _pin_problems(request, [self._lesson(MATTE)])

    def test_one_lesson_does_not_answer_two_pins(self) -> None:
        request = _request(_payload({MATTE: [_pin(3, "10:00"), _pin(3, "10:00"), None]}))
        assert _pin_problems(request, [self._lesson(MATTE)])
        assert not _pin_problems(request, [self._lesson(MATTE), self._lesson(MATTE, room_id=R2)])

    def test_a_place_on_a_split_post_is_held_to_its_teacher(self) -> None:
        request = _request(_payload(
            {MATTE: [None, _pin(3, "10:00"), None]}, posts={MATTE: {"lessonTeacherIds": [TOVE, BERTIL, TOVE]}},
        ))
        assert _pin_problems(request, [self._lesson(MATTE, teacher_id=TOVE)])
        assert not _pin_problems(request, [self._lesson(MATTE, teacher_id=BERTIL)])

    def test_a_lesson_on_another_day_is_a_problem(self) -> None:
        request = _request(_payload({MATTE: [None, _pin(3, "10:00"), None]}))
        assert _pin_problems(request, [self._lesson(MATTE, day_of_week=4)])
        assert not _pin_problems(request, [self._lesson(MATTE)])

    def test_a_lesson_that_starts_at_another_minute_is_a_problem(self) -> None:
        """With the pin's own end, so that the start alone tells the lesson from the pin."""
        request = _request(_payload({MATTE: [None, _pin(3, "10:00"), None]}))
        assert _pin_problems(request, [self._lesson(MATTE, start_time="10:05:00")])


# ---------------------------------------------------------------------------
# The two ways: a pinned lesson against the same lesson sent as a lock.
#
# THE WEEKS DRAWN HAVE THE RULES THE INDEPENDENT CHECK READS: one teacher, one
# class, one room at a time, rooms that hold the class, and a subject's "at
# most one a day". A pin is stricter than a lock in more rules than those —
# frames, rasts, margins, room locks, a teacher's day — and
# benchmarks/validate_schedule.py reads none of them off a lock, so the last
# statement below is said of these weeks and not of every week. Each of the
# others has its own refusal by name above.


def _random_week(seed: int) -> dict[str, object]:
    """Three classes, eight teachers' worth of posts, three rooms: small enough to prove either way."""
    rng = random.Random(seed)
    groups = [str(UUID(int=rng.getrandbits(128), version=4)) for _ in range(3)]
    teachers = [str(UUID(int=rng.getrandbits(128), version=4)) for _ in range(4)]
    rooms = [str(UUID(int=rng.getrandbits(128), version=4)) for _ in range(3)]
    requirements = []
    for group in groups:
        for _ in range(rng.randint(2, 3)):
            requirements.append({
                "id": str(UUID(int=rng.getrandbits(128), version=4)),
                "subjectId": str(UUID(int=rng.getrandbits(128), version=4)),
                "studentGroupId": group,
                "teacherId": rng.choice(teachers),
                "lessonsPerWeek": rng.randint(1, 3),
                "minutesPerLesson": 60,
                "studentGroupSize": 20,
                "minGradeLevel": 7,
                "maxGradeLevel": 7,
                **({"maxLessonsPerDay": 1} if rng.random() < 0.5 else {}),
            })
    return {
        "requestId": str(UUID(int=rng.getrandbits(128), version=4)),
        "academicYearId": str(UUID(int=rng.getrandbits(128), version=4)),
        "requirements": requirements,
        "rooms": [{"id": room, "capacity": 30} for room in rooms],
    }


def _with_pins(week: dict[str, object], pins: dict[tuple[str, int], dict[str, object]]) -> dict[str, object]:
    requirements = []
    for requirement in week["requirements"]:  # type: ignore[union-attr]
        places = [pins.get((requirement["id"], place)) for place in range(requirement["lessonsPerWeek"])]
        requirements.append({**requirement, **({"pinnedLessons": places} if any(places) else {})})
    return {**week, "requirements": requirements}


def _as_locks(week: dict[str, object], pins: dict[tuple[str, int], dict[str, object]]) -> dict[str, object]:
    """Today's way: each pinned lesson a lock, taken off its post, its weekday told to the post's rule."""
    posts = {requirement["id"]: requirement for requirement in week["requirements"]}  # type: ignore[union-attr]
    taken: dict[str, list[int]] = {}
    locks = []
    for (requirement_id, _place), pin in pins.items():
        post = posts[requirement_id]
        taken.setdefault(requirement_id, []).append(pin["dayOfWeek"])  # type: ignore[arg-type]
        locks.append({
            "id": str(uuid4()),
            "teacherId": post["teacherId"],
            "studentGroupId": post["studentGroupId"],
            "dayOfWeek": pin["dayOfWeek"],
            "startTime": pin["startTime"],
            "endTime": pin["endTime"],
            **({"roomId": pin["roomId"]} if "roomId" in pin else {}),
        })
    requirements = []
    for requirement in week["requirements"]:  # type: ignore[union-attr]
        days = taken.get(requirement["id"], [])
        left = requirement["lessonsPerWeek"] - len(days)
        if left > 0:
            requirements.append({
                **requirement,
                "lessonsPerWeek": left,
                **({"lockedDays": sorted(days)} if days and "maxLessonsPerDay" in requirement else {}),
            })
    return {**week, "requirements": requirements, "fixedLessons": locks}


def _answered(payload: dict[str, object]) -> tuple[str, list]:
    """The status a week comes back with, a refusal before the model read as INFEASIBLE."""
    if not payload["requirements"]:
        return "FEASIBLE", []
    try:
        response = _solve(payload, SOLVER_MAX_TIME_SECONDS=5.0, SOLVER_PROBE_SECONDS=2.0)
    except InvalidScheduleInputError:
        return "INFEASIBLE", []
    return ("FEASIBLE" if response.status in ("OPTIMAL", "FEASIBLE") else response.status), response.lessons


def _pins_from(week: dict[str, object], lessons: list, rng: random.Random, count: int) -> dict:
    """`count` lessons of a timetable as pins, every other one with the room it stood in."""
    by_post: dict[str, list] = {}
    for lesson in sorted(lessons, key=lambda l: (l.day_of_week, l.start_time)):
        by_post.setdefault(str(lesson.requirement_id), []).append(lesson)
    places = [(post, place) for post, held in by_post.items() for place in range(len(held))]
    pins = {}
    for index, (post, place) in enumerate(rng.sample(places, min(count, len(places)))):
        lesson = by_post[post][place]
        pins[(post, place)] = {
            "dayOfWeek": lesson.day_of_week,
            "startTime": lesson.start_time,
            "endTime": lesson.end_time,
            **({"roomId": str(lesson.room_id)} if index % 2 == 0 else {}),
        }
    return pins


class TestTheTwoWays:
    @pytest.mark.parametrize("seed", range(20))
    def test_lessons_pinned_where_a_timetable_had_them_are_kept_and_both_ways_lay_the_week(
        self, seed: int,
    ) -> None:
        week = _random_week(seed)
        status, lessons = _answered(week)
        if status != "FEASIBLE":
            pytest.skip("the drawn week has no timetable to pin from")
        rng = random.Random(1000 + seed)
        pins = _pins_from(week, lessons, rng, count=rng.randint(1, 6))
        pinned = _with_pins(week, pins)
        status, kept = _answered(pinned)
        assert status == "FEASIBLE"
        assert validate(SchedulerSolver(_settings())._grid, _request(pinned), kept) == []
        # The locks' way, each lock in the room the pin's way gave the lesson.
        rooms = {
            (str(lesson.requirement_id), lesson.day_of_week, lesson.start_time): str(lesson.room_id)
            for lesson in kept
        }
        roomed = {
            place: {**pin, "roomId": rooms[(place[0], pin["dayOfWeek"], pin["startTime"])]}
            for place, pin in pins.items()
        }
        assert _answered(_as_locks(week, roomed))[0] == "FEASIBLE"

    @pytest.mark.parametrize("seed", range(20))
    def test_what_the_pins_way_lays_the_locks_way_lays_and_what_only_the_locks_way_lays_breaks_a_rule(
        self, seed: int,
    ) -> None:
        """Pins drawn at random, each with a room: a lock is never stricter than the pin.

        Drawn onto two days, two hours and two rooms, so that about half the
        draws put two pins in each other's way — a teacher, a class, a room,
        a subject's "at most one a day" — which is the half the last assertion
        is about. Measured over forty seeds: 23 weeks both ways lay and 17
        only the locks' way does; the first twenty run here.
        """
        week = _random_week(seed)
        rng = random.Random(2000 + seed)
        rooms = [room["id"] for room in week["rooms"]][:2]  # type: ignore[union-attr]
        places = [
            (requirement["id"], place)
            for requirement in week["requirements"]  # type: ignore[union-attr]
            for place in range(requirement["lessonsPerWeek"])
        ]
        pins = {
            place: _pin(rng.randint(1, 2), f"{rng.randint(8, 9):02d}:00", room=rng.choice(rooms))
            for place in rng.sample(places, rng.randint(2, 4))
        }
        pinned = _with_pins(week, pins)
        pins_way, _ = _answered(pinned)
        locks_way, laid = _answered(_as_locks(week, pins))
        if {pins_way, locks_way} - {"FEASIBLE", "INFEASIBLE"}:
            pytest.skip("a solve ran out of time: nothing was proved either way")
        if pins_way == "FEASIBLE":
            assert locks_way == "FEASIBLE"
        elif locks_way == "FEASIBLE":
            # The locks read as the lessons they are: the independent check finds
            # the rule the pin's way refused the week for.
            held = [
                ScheduledLesson(
                    requirement_id=UUID(post), room_id=UUID(str(pin["roomId"])),
                    day_of_week=pin["dayOfWeek"], start_time=pin["startTime"], end_time=pin["endTime"],
                )
                for (post, _place), pin in pins.items()
            ]
            assert validate(SchedulerSolver(_settings())._grid, _request(pinned), [*laid, *held]) != []


class TestTheMealOfATerm:
    """Klassens måltid per del av läsåret, and the lessons a school pinned.

    ONE CLASS, MONDAY, 08:00-13:00, a year of two terms. It eats 30 minutes
    somewhere in 11:00-12:00 and has two lessons of every week. The posts
    under test are half an hour each and run one term each.

    With `lunchPerPeriod` a class's year is cut where its LOCKED lessons hold
    its meal differently, and a class cut so eats at an hour of its own in
    each part. A pinned lesson is a lesson with a known hour too, so it cuts
    the same way (pins.meal_starts_taken_by_pins). Read by
    benchmarks/validate_schedule.lunch_problems, which shares no code with the
    engine: one meal a day in each period, clear of the class's lessons.
    """

    GROUP = str(uuid4())
    ONE_DAY = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 780, "SOLVER_PROBE_SECONDS": 0}

    def _post(self, periods: list[bool] | None, pin: dict[str, object] | None, **values: object) -> dict[str, object]:
        post = _requirement(str(uuid4()), self.GROUP, str(uuid4()), 1, minutesPerLesson=30, **values)
        if periods is not None:
            post["periods"] = periods
        if pin is not None:
            post["pinnedLessons"] = [pin]
        return post

    def _year(self, *posts: dict[str, object], locks: list[dict[str, object]] | None = None) -> dict[str, object]:
        return {
            "requestId": str(uuid4()),
            "academicYearId": str(uuid4()),
            "requirements": [_requirement(str(uuid4()), self.GROUP, str(uuid4()), 2), *posts],
            "groups": [{"id": self.GROUP, "lunchHeadcount": 20, "minGradeLevel": 7, "maxGradeLevel": 7}],
            "rooms": [{"id": room, "capacity": 30} for room in (R1, R2, R3)],
            "rules": MEAL,
            "fixedLessons": locks or [],
            "periodWeeks": [20, 20],
            "lunchPerPeriod": True,
        }

    def _answer(self, payload: dict[str, object]):
        return SchedulerSolver(_settings(**self.ONE_DAY)).solve(_request(payload))

    def _meals(self, response) -> list[tuple[str, tuple[bool, ...] | None]]:
        return sorted(
            ((lunch.start_time[:5], lunch.periods) for lunch in response.lunches),
            key=lambda meal: (meal[1] is not None and not meal[1][0], meal[0]),
        )

    def _read(self, payload: dict[str, object], response) -> list[str]:
        grid = SchedulerSolver(_settings(**self.ONE_DAY))._grid
        request = _request(payload)
        return [
            *validate(grid, request, response.lessons),
            *lunch_problems(grid, request, response.lessons, response.lunches),
        ]

    def test_two_posts_pinned_across_the_meal_one_a_term_get_a_meal_in_each(self) -> None:
        """11:00-11:30 in the autumn and 11:30-12:00 in the spring: no hour of the year is free, one of each term is."""
        payload = self._year(
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(SPRING, _pin(1, "11:30", minutes=30)),
        )
        response = self._answer(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert self._meals(response) == [("11:30", (True, False)), ("11:00", (False, True))]
        assert self._read(payload, response) == []

    def test_the_pinned_year_eats_when_the_locked_year_does(self) -> None:
        """The same two half hours sent as locks: the meals are the same."""
        pinned = self._answer(self._year(
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(SPRING, _pin(1, "11:30", minutes=30)),
        ))
        locked = self._answer(self._year(
            self._post(SPRING, None),
            locks=[
                _lock_of_a_term(self.GROUP, "11:00", AUTUMN),
                _lock_of_a_term(self.GROUP, "11:30", SPRING),
            ],
        ))
        assert self._meals(pinned) == self._meals(locked)

    def test_a_post_pinned_in_the_meal_all_year_leaves_the_meal_one(self) -> None:
        """Every period has the same pin: the year is one part, and the answer has one meal and no mask."""
        payload = self._year(self._post(None, _pin(1, "11:00", minutes=30)), self._post(SPRING, None))
        response = self._answer(payload)
        assert self._meals(response) == [("11:30", None)]
        assert self._read(payload, response) == []

    def test_pins_that_take_no_meal_start_leave_the_meal_one(self) -> None:
        """Two posts pinned at different hours of the morning, one a term: nothing of the meal is told apart."""
        payload = self._year(
            self._post(AUTUMN, _pin(1, "10:00", minutes=30)),
            self._post(SPRING, _pin(1, "10:30", minutes=30)),
        )
        response = self._answer(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert [mask for _start, mask in self._meals(response)] == [None]
        assert self._read(payload, response) == []

    def test_the_minutes_the_pupils_change_cut_the_year_too(self) -> None:
        """Neither lesson touches the window, their changing does: 20 minutes after one, 20 before the other.

        The autumn's ends 11:00 and its pupils are busy to 11:20; the spring's
        starts 12:00 and its pupils are busy from 11:40. A meal of the whole
        year would start at 11:20 or later and end by 11:40. One of each term
        fits.
        """
        payload = self._year(
            self._post(AUTUMN, _pin(1, "10:30", minutes=30), minutesAfter=20),
            self._post(SPRING, _pin(1, "12:00", minutes=30), minutesBefore=20),
        )
        response = self._answer(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        (autumn, autumn_mask), (spring, spring_mask) = self._meals(response)
        assert (autumn_mask, spring_mask) == ((True, False), (False, True))
        assert autumn >= "11:20" and spring <= "11:10"
        assert self._read(payload, response) == []

    def test_a_pin_in_one_term_and_a_lock_on_its_hour_in_the_other_are_two_parts(self) -> None:
        """Kept apart from the locks' own starts: a part carries the locks of one of its periods as its own.

        The pin is the autumn's and the lock the spring's, on the same half
        hour. Joined into one part, the part would carry the autumn's locks,
        which are none, and the meal would be kept off the spring's lock only
        by what this module reckons a pin takes. Two parts in the model, a
        meal start in each, and each clear of what its term holds. The answer
        has one meal: the two parts eat at the same hour, and it says so once.
        """
        payload = self._year(
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(SPRING, None),
            locks=[_lock_of_a_term(self.GROUP, "11:00", SPRING)],
        )
        model, *_ = SchedulerSolver(_settings(**self.ONE_DAY))._build_model(
            _request(payload), use_assumptions=False,
        )
        assert len([v for v in model.Proto().variables if v.name.startswith("lunchstart_")]) == 2
        response = self._answer(payload)
        assert self._meals(response) == [("11:30", None)]
        assert self._read(payload, response) == []

    def test_a_pin_of_a_group_cut_from_the_class_cuts_the_class_year(self) -> None:
        """The class's children sit in the group's lesson: the group's pins hold the class's meal as its own do."""
        half = str(uuid4())
        payload = self._year(
            {**self._post(AUTUMN, _pin(1, "11:00", minutes=30)), "studentGroupId": half},
            {**self._post(SPRING, _pin(1, "11:30", minutes=30)), "studentGroupId": half},
        )
        payload["groupConflicts"] = [[self.GROUP, half]]
        response = self._answer(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert self._meals(response) == [("11:30", (True, False)), ("11:00", (False, True))]
        assert self._read(payload, response) == []
        assert classes_in_parts(payload) == 1

    def test_the_days_of_a_week_are_told_apart(self) -> None:
        """Monday 11:00 and Tuesday 11:30 in the autumn, and the other way round in the spring.

        Read without their day the two terms take the same starts, the year
        is one part, and neither day has a half hour for a meal of the whole
        year.
        """
        payload = self._year(
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)), self._post(AUTUMN, _pin(2, "11:30", minutes=30)),
            self._post(SPRING, _pin(1, "11:30", minutes=30)), self._post(SPRING, _pin(2, "11:00", minutes=30)),
        )
        solver = SchedulerSolver(_settings(**{**self.ONE_DAY, "SCHEDULE_DAYS": "1,2"}))
        request = _request(payload)
        response = solver.solve(request)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert sorted((lunch.day_of_week, lunch.start_time[:5], lunch.periods) for lunch in response.lunches) == [
            (1, "11:00", (False, True)), (1, "11:30", (True, False)),
            (2, "11:00", (True, False)), (2, "11:30", (False, True)),
        ]
        assert [
            *validate(solver._grid, request, response.lessons),
            *lunch_problems(solver._grid, request, response.lessons, response.lunches),
        ] == []
        assert classes_in_parts(payload) == 1

    def test_the_hall_carries_one_class_pins_into_another_class_year(self) -> None:
        """A hall that seats one class at a time: the class with no pin of its own eats around the one that has them.

        7B's posts are pinned 11:00-11:30 in the autumn and 11:30-12:00 in the
        spring, so 7B eats at 11:30 and then at 11:00. The hall has room for
        one class, so the other class eats at 11:00 and then at 11:30, though
        nothing is pinned or locked for it: its year is cut by what the hall
        couples it to.
        """
        other = str(uuid4())
        payload = self._year(
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(SPRING, _pin(1, "11:30", minutes=30)),
        )
        payload["requirements"].append(_requirement(str(uuid4()), other, str(uuid4()), 2))  # type: ignore[union-attr]
        payload["groups"].append(  # type: ignore[union-attr]
            {"id": other, "lunchHeadcount": 20, "minGradeLevel": 7, "maxGradeLevel": 7},
        )
        payload["rules"] = {**MEAL, "diningSeats": 20}
        response = self._answer(payload)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        meals = {
            (str(lunch.student_group_id), lunch.periods): lunch.start_time[:5] for lunch in response.lunches
        }
        assert meals == {
            (self.GROUP, (True, False)): "11:30", (self.GROUP, (False, True)): "11:00",
            (other, (True, False)): "11:00", (other, (False, True)): "11:30",
        }
        assert self._read(payload, response) == []

    def test_the_hall_seats_a_class_with_pinned_quarters_as_it_does_with_the_quarters_locked(self) -> None:
        """A quarter of an hour pinned in each term, 11:00 and then 11:30, and a hall for one class at a time.

        The world the second review of PR 314 left (seam_hall_pins.py): the
        class with the quarters eats 11:30 and then 11:00, the other class
        the other way round, and the same quarters sent as locks are seated
        the same.
        """
        other = str(uuid4())

        def hall(posts: list[dict[str, object]], locks: list[dict[str, object]]) -> dict[str, object]:
            payload = self._year(*posts, locks=locks)
            payload["requirements"].append(_requirement(str(uuid4()), other, str(uuid4()), 2))  # type: ignore[union-attr]
            payload["groups"].append(  # type: ignore[union-attr]
                {"id": other, "lunchHeadcount": 20, "minGradeLevel": 7, "maxGradeLevel": 7},
            )
            payload["rules"] = {**MEAL, "diningSeats": 20}
            return payload

        def seated(response) -> dict[tuple[str, tuple[bool, ...] | None], str]:
            return {(str(lunch.student_group_id), lunch.periods): lunch.start_time[:5] for lunch in response.lunches}

        pinned = hall([
            {**self._post(AUTUMN, _pin(1, "11:00", minutes=15)), "minutesPerLesson": 15},
            {**self._post(SPRING, _pin(1, "11:30", minutes=15)), "minutesPerLesson": 15},
        ], [])
        locked = hall([], [
            _lock_of_a_term(self.GROUP, "11:00", AUTUMN, minutes=15),
            _lock_of_a_term(self.GROUP, "11:30", SPRING, minutes=15),
        ])
        response = self._answer(pinned)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert seated(response) == {
            (self.GROUP, (True, False)): "11:30", (self.GROUP, (False, True)): "11:00",
            (other, (True, False)): "11:00", (other, (False, True)): "11:30",
        }
        assert seated(response) == seated(self._answer(locked))
        assert self._read(pinned, response) == []

    @pytest.mark.parametrize(
        ("posts", "cut"),
        [
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "11:00", minutes=30)},
                    {"periods": SPRING, "pin": _pin(1, "11:30", minutes=30)},
                ],
                True, id="across the meal, one a term",
            ),
            pytest.param(
                [{"periods": None, "pin": _pin(1, "11:00", minutes=30)}, {"periods": SPRING, "pin": None}],
                False, id="in the meal all year",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:00", minutes=30)},
                    {"periods": SPRING, "pin": _pin(1, "10:30", minutes=30)},
                ],
                False, id="clear of every meal start",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:30", minutes=30)},
                    {"periods": SPRING, "pin": _pin(1, "12:00", minutes=30)},
                ],
                False, id="up to the window and from its end",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:30", minutes=30), "minutesAfter": 20},
                    {"periods": SPRING, "pin": _pin(1, "12:00", minutes=30), "minutesBefore": 20},
                ],
                True, id="the pupils' changing minutes, after one and before the other",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "12:00", minutes=30), "minutesBefore": 20},
                    {"periods": SPRING, "pin": _pin(1, "12:00", minutes=30)},
                ],
                True, id="the minutes before a lesson alone",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:30", minutes=30), "minutesAfter": 3},
                    {"periods": SPRING, "pin": _pin(1, "10:30", minutes=30), "minutesAfter": 5},
                ],
                False, id="three minutes and five are one step of the grid",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:30", minutes=30), "minutesAfter": 5},
                    {"periods": SPRING, "pin": _pin(1, "10:30", minutes=30), "minutesAfter": 10},
                ],
                True, id="five minutes and ten are two",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:30", minutes=30), "frame": 10},
                    {"periods": SPRING, "pin": _pin(1, "10:00", minutes=30), "frame": 10},
                ],
                True, id="the corridor of the class's years after a lesson",
            ),
            pytest.param(
                [
                    {"periods": AUTUMN, "pin": _pin(1, "10:45", minutes=20), "minutesPerLesson": 20},
                    {"periods": AUTUMN, "pin": _pin(1, "11:30", minutes=30)},
                    {"periods": SPRING, "pin": _pin(1, "11:00", minutes=60), "minutesPerLesson": 60},
                ],
                False, id="two lessons that take the starts one takes",
            ),
        ],
    )
    def test_the_payload_alone_tells_the_cut_the_engine_makes(
        self, monkeypatch: pytest.MonkeyPatch, posts: list[dict[str, object]], cut: bool,
    ) -> None:
        """benchmarks/lunch_flag_identity.classes_in_parts reads a pinned lesson as the engine's parts do.

        That reading is the judge of "the engine split exactly the classes
        its starts split", written in minutes and sharing no code with the
        engine, so it is judged here against the engine's own split: a
        pinned lesson it did not read would call every cut by a pin a split
        without cause. The worlds are the edges of what a pinned lesson
        takes: its periods, the window's two ends, the pupils' minutes before
        and after and their rounding onto the grid, the corridor of the
        class's years, and two lessons whose starts join into one's.
        """
        def post(given: dict[str, object]) -> dict[str, object]:
            values = {key: value for key, value in given.items() if key not in ("periods", "pin", "frame")}
            return {**self._post(given["periods"], given["pin"]), **values}  # type: ignore[arg-type]

        payload = self._year(*(post(given) for given in posts))
        corridor = max((int(given.get("frame", 0)) for given in posts), default=0)  # type: ignore[call-overload]
        if corridor:
            payload["frameTimes"] = [{
                "minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "08:00:00", "endTime": "13:00:00",
                "changeoverMinutes": corridor,
            }]
        cuts: list[int] = []
        original = SchedulerSolver._lunch_parts

        def watching(solver: SchedulerSolver, *arguments: object, **keywords: object):
            parts = original(solver, *arguments, **keywords)  # type: ignore[arg-type]
            cuts.append(len(parts))
            return parts

        monkeypatch.setattr(SchedulerSolver, "_lunch_parts", watching)
        SchedulerSolver(_settings(**self.ONE_DAY))._build_model(_request(payload), use_assumptions=False)
        assert cuts and (cuts[-1] > 0) is cut
        assert (classes_in_parts(payload) > 0) is cut

    def test_two_posts_pinned_onto_the_whole_window_of_one_term_are_named(self) -> None:
        """Both in the autumn: that term has no half hour, and the refusal names the two pinned lessons."""
        first, second = (
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(AUTUMN, _pin(1, "11:30", minutes=30)),
        )
        response = self._answer(self._year(first, second, self._post(SPRING, None)))
        assert response.status == "INFEASIBLE"
        named = {
            str(requirement_id)
            for detail in response.conflicts.conflicts
            if detail.code == IN_THE_WAY_ANY_ROOM
            for requirement_id in detail.requirement_ids
        }
        assert named == {str(first["id"]), str(second["id"])}

    def test_the_estimate_charges_the_parts_pins_can_cut(self) -> None:
        """An upper bound: the parts' own variables are charged when a pin could cut the year, lock or no lock."""
        solver = SchedulerSolver(_settings(**self.ONE_DAY))
        autumn, spring = (
            self._post(AUTUMN, _pin(1, "11:00", minutes=30)),
            self._post(SPRING, _pin(1, "11:30", minutes=30)),
        )
        payload = self._year(autumn, spring)
        bare = {
            **payload,
            "requirements": [
                {key: value for key, value in post.items() if key != "pinnedLessons"}
                for post in payload["requirements"]  # type: ignore[union-attr]
            ],
        }
        estimated = solver._estimate_model_size(_request(payload))
        # A literal for each pin, and for the one class and day six a period past the first.
        assert estimated == solver._estimate_model_size(_request(bare)) + 2 + 6
        model, *_ = solver._build_model(_request(payload), use_assumptions=True)
        assert len(model.Proto().variables) <= estimated
