"""Förlagda poster: lessons the school placed on a timplanspost before Generera.

A förläggning reaches the engine as a FixedLesson, its post as a requirement
with that lesson taken off its demand, and the request carries `placements`:
which locks are förlagda and what their posts would be without them. The field
is read by the explanation alone. These tests hold the three things that
promise rests on:

1. THE MODEL. A request with `placements` builds exactly the model the same
   request without it builds, constraint for constraint and variable for
   variable, and solves to the same timetable.
2. THE RELEASE. release_placements is the same week with the förläggningar
   free: their locks out, their posts whole, nothing else moved.
3. THE NAME. A week the förläggningar make impossible is refused with each of
   them named, in the strict mode and in Bästa möjliga schema; a week that is
   impossible for another reason keeps the refusal it had.

THE WEEK. 08:00-10:00, Monday to Friday: two one-hour slots a day, so every
case is arithmetic. 7A has matte with Tove, who is away Tuesday to Friday, so
matte has Monday's two hours and no others. Idrott with Ulf is förlagd on
Monday 08:00 — the one hour matte cannot spare.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.placements import release_placements
from app.solver.relaxation import HARD_RULES
from app.solver.scheduler_solver import SchedulerSolver

#: 08:00-10:00, Monday to Friday.
SHORT_DAY = {"SCHEDULE_DAY_END_MINUTES": 600}

CLASS_7A = str(uuid4())
MATTE = str(uuid4())
IDROTT = str(uuid4())
SVENSKA = str(uuid4())
TOVE = str(uuid4())
ULF = str(uuid4())
SARA = str(uuid4())
HALL = str(uuid4())
ROOM = str(uuid4())
PLACED = str(uuid4())


def _settings(**overrides: object) -> Settings:
    return Settings(  # type: ignore[arg-type]
        SOLVER_MAX_TIME_SECONDS=10.0, SOLVER_PROBE_SECONDS=10.0, **{**SHORT_DAY, **overrides},
    )


def _away(teacher: str, day: int) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": "TEACHER",
        "resourceId": teacher,
        "dayOfWeek": day,
        "date": None,
        "startTime": "08:00:00",
        "endTime": "10:00:00",
        "kind": "UNAVAILABLE",
    }


def _requirement(requirement_id: str, teacher: str, lessons: int, **values: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": requirement_id,
        "subjectId": str(uuid4()),
        "studentGroupId": CLASS_7A,
        "teacherId": teacher,
        "lessonsPerWeek": lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 25,
    }
    row.update(values)
    return row


#: Idrott as the gateway sends it with nothing förlagt: one lesson to place.
IDROTT_WHOLE = _requirement(IDROTT, ULF, 1)


def _placed_idrott(day: int = 1, start: str = "08:00:00", end: str = "09:00:00") -> dict[str, object]:
    return {
        "id": PLACED,
        "teacherId": ULF,
        "studentGroupId": CLASS_7A,
        "roomId": HALL,
        "dayOfWeek": day,
        "startTime": start,
        "endTime": end,
    }


def _payload(
    *,
    matte: int = 2,
    placements: bool = True,
    day: int = 1,
    **extra: object,
) -> dict[str, object]:
    """7A's matte, Tove on Mondays only, idrott förlagd at `day` 08:00."""
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [_requirement(MATTE, TOVE, matte)],
        "groups": [{"id": CLASS_7A, "lunchHeadcount": 25}],
        "rooms": [{"id": HALL, "capacity": 30}, {"id": ROOM, "capacity": 30}],
        "constraints": [_away(TOVE, weekday) for weekday in (2, 3, 4, 5)],
        "fixedLessons": [_placed_idrott(day)],
        **extra,
    }
    if placements:
        payload["placements"] = {
            "lessons": [{"fixedLessonId": PLACED, "requirementId": IDROTT}],
            "requirements": [IDROTT_WHOLE],
        }
    return payload


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _solve(payload: dict[str, object], **settings: object):
    return SchedulerSolver(_settings(**settings)).solve(_request(payload))


def _proto(payload: dict[str, object], *, include_objective: bool) -> bytes:
    """The model's wire form, as benchmarks/model_identity.py hashes it (ExportToFile)."""
    solver = SchedulerSolver(_settings())
    model, *_ = solver._build_model(
        _request(payload), use_assumptions=False, include_objective=include_objective,
    )
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "model.pb"
        assert model.ExportToFile(str(path))
        return path.read_bytes()


class TestTheField:
    def test_absent_is_none(self) -> None:
        assert _request(_payload(placements=False)).placements is None

    def test_a_placed_lesson_names_a_lock_of_the_request(self) -> None:
        payload = _payload()
        payload["placements"]["lessons"][0]["fixedLessonId"] = str(uuid4())  # type: ignore[index]
        with pytest.raises(ValidationError, match="fixed lesson the request does not carry"):
            _request(payload)

    def test_a_placed_lesson_names_a_post_given_beside_it(self) -> None:
        payload = _payload()
        payload["placements"]["lessons"][0]["requirementId"] = str(uuid4())  # type: ignore[index]
        with pytest.raises(ValidationError, match="does not carry"):
            _request(payload)

    def test_a_post_is_given_once(self) -> None:
        payload = _payload()
        payload["placements"]["requirements"] = [IDROTT_WHOLE, IDROTT_WHOLE]  # type: ignore[index]
        with pytest.raises(ValidationError, match="unique"):
            _request(payload)

    def test_a_lock_is_placed_once(self) -> None:
        payload = _payload()
        lesson = {"fixedLessonId": PLACED, "requirementId": IDROTT}
        payload["placements"]["lessons"] = [lesson, lesson]  # type: ignore[index]
        with pytest.raises(ValidationError, match="twice"):
            _request(payload)

    def test_unknown_keys_are_refused(self) -> None:
        payload = _payload()
        payload["placements"]["release"] = True  # type: ignore[index]
        with pytest.raises(ValidationError):
            _request(payload)

    def test_the_rule_that_never_gives_way_is_listed(self) -> None:
        assert any("placed lesson" in rule for rule in HARD_RULES)


class TestTheModel:
    """`placements` is read by the explanation alone: the model is the same."""

    @pytest.mark.parametrize("include_objective", [True, False])
    def test_the_same_request_with_and_without_the_field_builds_one_model(
        self, include_objective: bool,
    ) -> None:
        with_field = _payload(matte=1, day=3)
        without = {key: value for key, value in with_field.items() if key != "placements"}
        assert _proto(with_field, include_objective=include_objective) == _proto(
            without, include_objective=include_objective,
        )

    def test_a_week_that_holds_is_answered_alike(self) -> None:
        # One worker and seed 0 (SearchOptions), so two solves are one search.
        with_field = _payload(matte=2, day=3, search={"seed": 0, "workers": 1})
        without = {key: value for key, value in with_field.items() if key != "placements"}
        answered = _solve(with_field)
        plain = _solve(without)
        assert answered.status in ("OPTIMAL", "FEASIBLE")
        assert answered.model_dump(exclude={"request_id"}) == plain.model_dump(exclude={"request_id"})
        # The förlagd lesson is the school's: the engine never returns it.
        assert all(lesson.requirement_id != UUID(IDROTT) for lesson in answered.lessons)


class TestTheRelease:
    def test_the_lock_leaves_and_the_post_comes_back_whole(self) -> None:
        released = release_placements(_request(_payload()))
        assert released.placements is None
        assert released.fixed_lessons == []
        assert [str(r.id) for r in released.requirements] == [MATTE, IDROTT]
        assert released.requirements[1].lessons_per_week == 1

    def test_a_post_partly_förlagd_is_replaced_where_it_stands(self) -> None:
        payload = _payload()
        # Matte with one of three lessons förlagd: two to place, three released.
        payload["requirements"] = [_requirement(MATTE, TOVE, 2), _requirement(SVENSKA, SARA, 1)]
        payload["placements"] = {
            "lessons": [{"fixedLessonId": PLACED, "requirementId": MATTE}],
            "requirements": [_requirement(MATTE, TOVE, 3)],
        }
        released = release_placements(_request(payload))
        assert [(str(r.id), r.lessons_per_week) for r in released.requirements] == [
            (MATTE, 3), (SVENSKA, 1),
        ]

    def test_nothing_else_of_the_week_moves(self) -> None:
        request = _request(_payload())
        released = release_placements(request)
        untouched = {"requirements", "fixed_lessons", "pupil_gaps", "placements"}
        for name in OptimizeScheduleRequest.model_fields:
            if name not in untouched:
                assert getattr(released, name) == getattr(request, name), name

    def test_the_pupils_day_forgets_the_released_lock(self) -> None:
        other = str(uuid4())
        payload = _payload()
        payload["fixedLessons"] = [  # type: ignore[assignment]
            _placed_idrott(),
            {**_placed_idrott(day=2), "id": other},
        ]
        payload["pupilGaps"] = {
            "cohorts": [{"groupIds": [CLASS_7A], "fixedLessonIds": [PLACED, other], "pupils": 25}],
            "fixedMargins": [
                {"fixedLessonId": PLACED, "minutesBefore": 10},
                {"fixedLessonId": other, "minutesBefore": 10},
            ],
        }
        released = release_placements(_request(payload))
        assert [str(f.id) for f in released.fixed_lessons] == [other]
        assert released.pupil_gaps is not None
        assert [str(i) for i in released.pupil_gaps.cohorts[0].fixed_lesson_ids] == [other]
        assert [str(m.fixed_lesson_id) for m in released.pupil_gaps.fixed_margins] == [other]

    def test_a_request_without_the_field_is_itself(self) -> None:
        request = _request(_payload(placements=False))
        assert release_placements(request) is request


def _codes(response) -> list[str]:
    return [detail.code for detail in (response.conflicts.conflicts if response.conflicts else [])]


class TestTheName:
    def test_a_week_the_förläggning_makes_impossible_names_it(self) -> None:
        response = _solve(_payload())
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "PLACEMENTS_PROBE_SUMMARY"
        assert response.conflicts.summary_params["count"] == 1
        line = response.conflicts.conflicts[0]
        assert line.category == "PLACEMENT"
        assert line.code == "PLACED_LESSON_IN_THE_WAY"
        assert [str(i) for i in line.requirement_ids] == [IDROTT]
        assert [str(i) for i in line.room_ids] == [HALL]
        assert line.params == {
            "requirement": IDROTT, "room": HALL, "day": 1, "start": "08:00", "end": "09:00",
        }
        assert "placed on Monday 08:00–09:00" in line.message

    def test_the_refusal_it_had_is_kept_under_the_names(self) -> None:
        payload = _payload()
        plain = _solve({key: value for key, value in payload.items() if key != "placements"})
        assert plain.status == "INFEASIBLE"
        assert plain.conflicts is None or plain.conflicts.summary_code != "PLACEMENTS_PROBE_SUMMARY"
        named = _solve(payload)
        assert plain.conflicts is not None
        assert named.conflicts is not None
        assert named.conflicts.conflicts[1:] == plain.conflicts.conflicts

    def test_without_the_field_nothing_is_named(self) -> None:
        response = _solve(_payload(placements=False))
        assert response.status == "INFEASIBLE"
        assert "PLACED_LESSON_IN_THE_WAY" not in _codes(response)

    def test_a_week_impossible_without_the_förläggning_keeps_its_refusal(self) -> None:
        # Three matte lessons in Tove's two hours: released or not, no week.
        payload = _payload(matte=3, day=3)
        named = _solve(payload)
        plain = _solve({key: value for key, value in payload.items() if key != "placements"})
        assert named.status == plain.status == "INFEASIBLE"
        assert named.conflicts == plain.conflicts

    def test_a_request_that_turned_its_probes_off_is_not_probed(self) -> None:
        response = _solve(_payload(search={"probes": False, "seed": 0}))
        assert response.status == "INFEASIBLE"
        assert "PLACED_LESSON_IN_THE_WAY" not in _codes(response)

    def test_no_time_left_names_nothing(self) -> None:
        solver = SchedulerSolver(_settings())
        assert solver._placements_verdict(_request(_payload()), seconds_left=0.1) is None

    def test_bästa_möjliga_schema_never_lets_it_give_way_and_names_it(self) -> None:
        response = _solve(_payload(relaxation={"mode": "BEST_EFFORT"}))
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "PLACEMENTS_PROBE_SUMMARY"
        assert response.deviations is None or all(
            UUID(IDROTT) not in deviation.requirement_ids for deviation in response.deviations
        )


class TestTheTimeoutProbe:
    def test_the_released_week_is_one_of_the_rules_probed(self) -> None:
        request = _request(_payload())
        relaxations = dict(SchedulerSolver(_settings())._timeout_relaxations(request))
        assert relaxations["PROBE_SOLVED_WITH_PLACEMENTS_RELEASED"] == release_placements(request)

    def test_a_week_without_förläggningar_has_no_such_probe(self) -> None:
        request = _request(_payload(placements=False))
        codes = [code for code, _ in SchedulerSolver(_settings())._timeout_relaxations(request)]
        assert "PROBE_SOLVED_WITH_PLACEMENTS_RELEASED" not in codes
