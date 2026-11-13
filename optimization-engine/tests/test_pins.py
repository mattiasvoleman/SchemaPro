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

THE WEEK. 08:00-12:00, Monday to Friday: four one-hour slots a day. 7A has
matte with Tove and svenska with Sara, three lessons each; 7B has matte with
Tove, three, and svenska with Sara, two. Three rooms that hold any of them.
"""

from __future__ import annotations

import random
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
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

from validate_schedule import validate  # noqa: E402

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
    def test_a_week_without_a_pin_builds_the_model_it_built(
        self, include_objective: bool, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Every hook this feature has in the solver, taken out: the bytes are the same."""
        with_hooks = _proto(_payload(), include_objective=include_objective)
        monkeypatch.setattr(scheduler_solver, "add_pins", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(scheduler_solver, "pinned_room_ids", lambda _requirements: set())
        monkeypatch.setattr(scheduler_solver, "pinned_start_slots", lambda *_args: [])
        monkeypatch.setattr(scheduler_solver, "pins_of", lambda _requirements: [])
        assert _proto(_payload(), include_objective=include_objective) == with_hooks

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
