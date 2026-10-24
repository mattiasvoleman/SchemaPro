"""Delade lektioner: one requirement, its lessons led by more than one teacher.

A requirement names a lead (teacherId) and maybe a co-teacher who is on every
lesson. Since lessonTeacherIds a post's lessons can be split between leads —
Matematik för 7A, two lessons of Anna's and one of Bertil's — one entry per
lesson in lesson_minutes() order, each lesson with exactly one lead, the
co-teacher still on all of them. Absent, the payload is byte for byte what it
was, and benchmarks/model_identity.py measures that the model is too.

What has to hold, and what each class below pins:

  * the field: it agrees with the row — its count, teacherId its first entry,
    the co-teacher not in it, two different leads — or nothing is built;
  * the response: a split post's lessons each name their lead, and nothing
    else in any response gains a key;
  * the families: a lesson is in its own lead's no-overlap, reservations,
    locks, and nobody else's;
  * the teachers' own time: the cap, the lunch and the free-day wish count a
    teacher's own lessons of the post, and the disruption reward is kept by
    the lessons whose teachers do not wish the day free;
  * the pre-flight stays sound: a check that reads the row counts a lead's
    reservation only where it reaches every lesson, and a block reads the
    union of the leads.

THE SCAFFOLDING IS test_teacher_day.py's: a 08:00-12:00 day of four 60-minute
lessons, on three days, so every verdict is arithmetic a reader can do — and
where the split is what makes a week possible, the same payload read the old
way (every lead on every lesson, _every_lead_on_every_lesson) is shown not to be.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import (
    AnonymousRequirement,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    ScheduledLesson,
)
from app.solver.scheduler_solver import (
    SchedulerSolver,
    _teachers_at,
    _teachers_of,
    _teachers_on_every_lesson,
)

API_KEY = "test-api-key-000000000000000000000000"
#: 08:00-12:00 on Monday to Wednesday: four 60-minute lessons a day, three days.
SHORT_WEEK = {"SCHEDULE_DAYS": "1,2,3", "SCHEDULE_DAY_END_MINUTES": 720}
#: Every soft term but the reservations and the wish priced at nothing.
WISH_AND_WINDOWS = {
    "WEIGHT_TEACHER_GAP": 0,
    "WEIGHT_SPREAD": 0,
    "WEIGHT_LUNCH_DRIFT": 0,
    "WEIGHT_DISRUPTION": 0,
}

ANNA = str(uuid4())
BERTIL = str(uuid4())
CO_TEACHER = str(uuid4())
GROUP = str(uuid4())
OTHER_GROUP = str(uuid4())
REQUIREMENT = str(uuid4())
OTHER_REQUIREMENT = str(uuid4())

MONDAY, TUESDAY, WEDNESDAY = 1, 2, 3


def _settings(**overrides: object) -> Settings:
    return Settings(**{  # type: ignore[arg-type]
        "API_KEY": API_KEY,
        "ALLOWED_ORIGINS": "http://testserver",
        "SOLVER_MAX_TIME_SECONDS": 10.0,
        **SHORT_WEEK,
        **overrides,
    })


def _requirement(
    leads: list[str | None] | None,
    *,
    teacher: str | None = None,
    lessons: int | None = None,
    requirement_id: str = REQUIREMENT,
    group: str = GROUP,
    **values: object,
) -> dict[str, object]:
    """A requirement led lesson by lesson by `leads`, or by `teacher` alone."""
    row: dict[str, object] = {
        "id": requirement_id,
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": leads[0] if leads is not None else teacher,
        "lessonsPerWeek": len(leads) if leads is not None else lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 24,
        "minGradeLevel": 7,
        "maxGradeLevel": 7,
        **values,
    }
    if leads is not None:
        row["lessonTeacherIds"] = leads
    return row


def _payload(*requirements: dict[str, object], **keys: object) -> dict[str, object]:
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": list(requirements),
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
        **keys,
    }


def _every_lead_on_every_lesson(payload: dict[str, object]) -> dict[str, object]:
    """The same week read the requirement-level way: both leads on every lesson.

    The reading every teacher-keyed rule took before a post could be split,
    spelled as the payload that means it — the first lead as teacherId, the
    other as the co-teacher — so a test can show the week that reading builds.
    """
    rows = []
    for row in payload["requirements"]:  # type: ignore[union-attr]
        leads = row.get("lessonTeacherIds")
        if leads is None:
            rows.append(row)
            continue
        named = list(dict.fromkeys(lead for lead in leads if lead is not None))
        assert len(named) == 2 and row.get("coTeacherId") is None
        rows.append({
            **{key: value for key, value in row.items() if key != "lessonTeacherIds"},
            "teacherId": named[0], "coTeacherId": named[1],
        })
    return {**payload, "requirements": rows}


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _solve(payload: dict[str, object], **settings: object) -> OptimizeScheduleResponse:
    return SchedulerSolver(_settings(**settings)).solve(_request(payload))


def _build(payload: dict[str, object], *, objective: bool = False, **settings: object):
    solver = SchedulerSolver(_settings(**settings))
    return solver._build_model(
        _request(payload), use_assumptions=False, include_objective=objective,
    )


def _status(payload: dict[str, object], **settings: object) -> str:
    """The satisfaction model solved once, on one worker: FEASIBLE or INFEASIBLE."""
    model, *_rest = _build(payload, **settings)
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10.0
    code = cp.Solve(model)
    assert code in (cp_model.OPTIMAL, cp_model.FEASIBLE, cp_model.INFEASIBLE), cp.StatusName(code)
    return "INFEASIBLE" if code == cp_model.INFEASIBLE else "FEASIBLE"


def _refusal(payload: dict[str, object], **settings: object) -> InvalidScheduleInputError | None:
    try:
        SchedulerSolver(_settings(**settings))._validate_request(_request(payload))
    except InvalidScheduleInputError as error:
        return error
    return None


def _validate(payload: dict[str, object], lessons: list[ScheduledLesson]) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    return validate(SchedulerSolver(_settings())._grid, _request(payload), lessons)


def _mine(response: OptimizeScheduleResponse, teacher: str) -> list[ScheduledLesson]:
    return [
        lesson for lesson in response.lessons
        if str(lesson.requirement_id) == REQUIREMENT and str(lesson.teacher_id) == teacher
    ]


def _minutes(clock: str) -> int:
    hours, minutes, _seconds = clock.split(":")
    return int(hours) * 60 + int(minutes)


def _reservation(teacher: str, day: int, start: str = "08:00:00", end: str = "12:00:00",
                 kind: str = "UNAVAILABLE") -> dict[str, object]:
    return {
        "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": teacher,
        "dayOfWeek": day, "startTime": start, "endTime": end, "kind": kind,
    }


# ---------------------------------------------------------------------------
# The field
# ---------------------------------------------------------------------------


class TestTheField:
    def test_absent_is_one_lead_on_every_lesson(self) -> None:
        requirement = AnonymousRequirement.model_validate(_requirement(None, teacher=ANNA, lessons=3))
        assert requirement.lesson_teacher_ids is None
        assert [str(requirement.lesson_teacher(k)) for k in range(3)] == [ANNA] * 3

    def test_a_split_is_read_lesson_by_lesson_in_lesson_minutes_order(self) -> None:
        requirement = AnonymousRequirement.model_validate(
            _requirement([ANNA, BERTIL], minutesPerLesson=80, lessonLengths=[40, 80]),
        )
        assert requirement.lesson_minutes() == (80, 40)
        assert [str(requirement.lesson_teacher(k)) for k in range(2)] == [ANNA, BERTIL]

    def test_a_lesson_may_have_no_lead(self) -> None:
        requirement = AnonymousRequirement.model_validate(_requirement([ANNA, None, ANNA]))
        assert requirement.lesson_teacher(1) is None

    @pytest.mark.parametrize(
        ("label", "row", "message"),
        [
            (
                "a count that disagrees with the lessons",
                _requirement([ANNA, BERTIL], lessonsPerWeek=3),
                "lessonTeacherIds must hold exactly lessonsPerWeek entries.",
            ),
            (
                "a teacherId that is not the first entry",
                {**_requirement([ANNA, BERTIL]), "teacherId": BERTIL},
                "teacherId must be the first entry of lessonTeacherIds.",
            ),
            (
                "the co-teacher among the leads",
                _requirement([ANNA, BERTIL], coTeacherId=BERTIL),
                "coTeacherId is on every lesson and must not be in lessonTeacherIds.",
            ),
            (
                "one lead throughout",
                _requirement([ANNA, ANNA, ANNA]),
                "lessonTeacherIds must name two different leads; one lead is teacherId alone.",
            ),
        ],
    )
    def test_a_list_that_contradicts_the_row_is_refused(
        self, label: str, row: dict[str, object], message: str,
    ) -> None:
        with pytest.raises(ValidationError, match=message):
            AnonymousRequirement.model_validate(row)

    def test_the_route_answers_a_contradicting_list_with_422(self) -> None:
        client = TestClient(create_app(_settings()))
        response = client.post(
            "/api/v1/optimize",
            json=_payload(_requirement([ANNA, ANNA])),
            headers={"X-API-Key": API_KEY},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# The response
# ---------------------------------------------------------------------------


class TestTheResponse:
    def test_each_lesson_names_its_lead_and_the_counts_are_the_list_s(self) -> None:
        payload = _payload(_requirement([ANNA, ANNA, BERTIL]))

        result = _solve(payload)

        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert Counter(str(lesson.teacher_id) for lesson in result.lessons) == {ANNA: 2, BERTIL: 1}
        assert _validate(payload, result.lessons) == []

    def test_a_lesson_the_list_gives_nobody_carries_no_teacher(self) -> None:
        payload = _payload(_requirement([ANNA, None, ANNA]))

        result = _solve(payload)

        assert sorted(str(lesson.teacher_id) for lesson in result.lessons) == sorted(
            [ANNA, ANNA, "None"],
        )
        nobody = next(lesson for lesson in result.lessons if lesson.teacher_id is None)
        assert "teacherId" not in json.loads(nobody.model_dump_json())
        assert _validate(payload, result.lessons) == []

    def test_mixed_lengths_give_the_second_lead_the_shorter_lesson(self) -> None:
        """[80, 40] with [A, B]: the list is aligned with lesson_minutes(),
        longest first, whatever order the lengths came in."""
        payload = _payload(_requirement(
            [ANNA, BERTIL], minutesPerLesson=80, lessonLengths=[40, 80],
        ))

        result = _solve(payload, SCHEDULE_DAYS="1,2,3,4,5", SCHEDULE_DAY_END_MINUTES=1080)

        lengths = {
            str(lesson.teacher_id): _minutes(lesson.end_time) - _minutes(lesson.start_time)
            for lesson in result.lessons
        }
        assert lengths == {ANNA: 80, BERTIL: 40}

    def test_a_response_without_a_split_carries_no_teacher_key(self) -> None:
        """Through the route, so FastAPI's own serialisation is what is read."""
        client = TestClient(create_app(_settings()))
        response = client.post(
            "/api/v1/optimize",
            json=_payload(_requirement(None, teacher=ANNA, lessons=2, coTeacherId=BERTIL)),
            headers={"X-API-Key": API_KEY},
        )
        assert response.status_code == 200
        lessons = response.json()["lessons"]
        assert len(lessons) == 2
        assert all(set(lesson) == {
            "requirementId", "roomId", "dayOfWeek", "startTime", "endTime",
        } for lesson in lessons)
        assert "teacherId" not in response.text

    def test_the_route_returns_each_lesson_s_lead(self) -> None:
        client = TestClient(create_app(_settings()))
        response = client.post(
            "/api/v1/optimize",
            json=_payload(_requirement([ANNA, BERTIL, None])),
            headers={"X-API-Key": API_KEY},
        )
        assert response.status_code == 200
        assert sorted(lesson.get("teacherId", "-") for lesson in response.json()["lessons"]) == sorted(
            [ANNA, BERTIL, "-"],
        )

    def test_the_validator_holds_each_lesson_to_its_lead(self) -> None:
        payload = _payload(_requirement([ANNA, BERTIL]))
        room = payload["rooms"][0]["id"]  # type: ignore[index]

        def placed(*leads: str) -> list[ScheduledLesson]:
            return [
                ScheduledLesson.model_validate({
                    "requirementId": REQUIREMENT, "roomId": room, "dayOfWeek": day,
                    "startTime": "08:00:00", "endTime": "09:00:00", "teacherId": lead,
                })
                for day, lead in zip((MONDAY, TUESDAY), leads)
            ]

        assert _validate(payload, placed(ANNA, BERTIL)) == []
        assert any("(lead, minutes)" in problem for problem in _validate(payload, placed(ANNA, ANNA)))


# ---------------------------------------------------------------------------
# The families a lesson is in
# ---------------------------------------------------------------------------


class TestTheFamilies:
    def test_an_unsplit_lesson_reads_the_pair_it_always_read(self) -> None:
        """The pair, in its order, with neither dropped for being the other:
        what every teacher-keyed builder read off the requirement before."""
        for teacher, co_teacher in ((ANNA, None), (ANNA, BERTIL), (None, BERTIL), (ANNA, ANNA)):
            requirement = AnonymousRequirement.model_validate(
                _requirement(None, teacher=teacher, lessons=2, coTeacherId=co_teacher),
            )
            pair = tuple(t for t in (requirement.teacher_id, requirement.co_teacher_id) if t)
            assert all(_teachers_at(requirement, k) == pair for k in range(2))
            assert _teachers_of(requirement) == _teachers_on_every_lesson(requirement) == pair

    def test_a_split_lesson_is_its_lead_s_and_the_co_teacher_s(self) -> None:
        requirement = AnonymousRequirement.model_validate(
            _requirement([ANNA, BERTIL, ANNA, None], coTeacherId=CO_TEACHER),
        )
        assert [tuple(map(str, _teachers_at(requirement, k))) for k in range(4)] == [
            (ANNA, CO_TEACHER), (BERTIL, CO_TEACHER), (ANNA, CO_TEACHER), (CO_TEACHER,),
        ]
        # The row's union: every lead once, in lesson order, then the co-teacher.
        assert list(map(str, _teachers_of(requirement))) == [ANNA, BERTIL, CO_TEACHER]
        # And on every lesson only the co-teacher: no lead is on all four.
        assert list(map(str, _teachers_on_every_lesson(requirement))) == [CO_TEACHER]

    def test_no_overlap_is_per_lesson(self) -> None:
        """Bertil leads one lesson of 7A's and ten of another class's: eleven
        hours of a twelve-hour week. Read the old way he is on all three of
        7A's and the week is thirteen hours of his; read per lesson it fits,
        and Anna's two lessons sit beside his other class's."""
        payload = _payload(
            _requirement([ANNA, ANNA, BERTIL]),
            _requirement(
                None, teacher=BERTIL, lessons=10,
                requirement_id=OTHER_REQUIREMENT, group=OTHER_GROUP,
            ),
        )

        assert _status(_every_lead_on_every_lesson(payload)) == "INFEASIBLE"
        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert _validate(payload, result.lessons) == []

        def at(lesson: ScheduledLesson) -> tuple[int, str]:
            return lesson.day_of_week, lesson.start_time

        others = {at(lesson) for lesson in result.lessons if str(lesson.requirement_id) == OTHER_REQUIREMENT}
        assert not others & {at(lesson) for lesson in _mine(result, BERTIL)}
        assert others & {at(lesson) for lesson in _mine(result, ANNA)}

    def test_a_reservation_of_one_lead_reaches_only_their_lesson(self) -> None:
        """Bertil is away Monday and Tuesday, Anna on Wednesday: read the old
        way every day is shut to 7A's maths. Per lesson his lesson takes
        Wednesday and hers the other two days."""
        reservations = [
            _reservation(BERTIL, MONDAY), _reservation(BERTIL, TUESDAY), _reservation(ANNA, WEDNESDAY),
        ]
        payload = _payload(_requirement([ANNA, ANNA, BERTIL]), constraints=reservations)

        _model, registry, *_rest = _build(payload)
        reached = {
            str(record.constraint_ids[0]): record.requirement_ids
            for record in registry._records if record.code == "AVAIL_CONSTRAINT_BLOCKS_LESSONS"
        }
        assert [len(reached[row["id"]]) for row in reservations] == [1, 1, 2]
        assert _status(_every_lead_on_every_lesson(payload)) == "INFEASIBLE"

        result = _solve(payload)
        assert {lesson.day_of_week for lesson in _mine(result, BERTIL)} == {WEDNESDAY}
        assert {lesson.day_of_week for lesson in _mine(result, ANNA)} <= {MONDAY, TUESDAY}
        assert _validate(payload, result.lessons) == []

    def test_a_lock_of_one_lead_keeps_only_their_lesson_off_it(self) -> None:
        """Every morning hour of Bertil's is locked elsewhere, so his lesson
        is an 11:00 one; Anna's are free to start at 08:00."""
        locked = [
            {
                "id": str(uuid4()), "teacherId": BERTIL, "studentGroupId": str(uuid4()),
                "dayOfWeek": day, "startTime": "08:00:00", "endTime": "11:00:00",
            }
            for day in (MONDAY, TUESDAY, WEDNESDAY)
        ]
        payload = _payload(_requirement([ANNA, ANNA, BERTIL]), fixedLessons=locked)

        _model, _registry, decisions, *_rest = _build(payload)
        proto = _model.Proto()
        names = [variable.name for variable in proto.variables]
        avoided = {name.rsplit("_", 1)[1] for name in names if name.startswith("before_fixed_")}
        assert avoided == {"2"}

        result = _solve(payload)
        assert [lesson.start_time for lesson in _mine(result, BERTIL)] == ["11:00:00"]
        assert _validate(payload, result.lessons) == []


# ---------------------------------------------------------------------------
# The teachers' own time
# ---------------------------------------------------------------------------


class TestTheTeachersOwnTime:
    def test_the_daily_cap_counts_only_the_teacher_s_own_lessons(self) -> None:
        """An hour a day for Bertil and two of 7A's four lessons: his week is
        two hours in three days. Read the old way it is four, and refused."""
        payload = _payload(
            _requirement([ANNA, ANNA, BERTIL, BERTIL]),
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": BERTIL, "maxTeachingMinutesPerDay": 60}],
        )

        old = _refusal(_every_lead_on_every_lesson(payload))
        assert old is not None and old.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
        assert _refusal(payload) is None
        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert len({lesson.day_of_week for lesson in _mine(result, BERTIL)}) == 2
        assert _validate(payload, result.lessons) == []

    def test_a_days_limit_counts_only_the_teacher_s_own_lessons(self) -> None:
        """Deltid: Bertil teaches on at most one day a week, and has one of
        7A's three maths, which go one a day. Read the old way all three are
        his, on three days, and no week holds them; per lesson his one is on
        one day and Anna's two on two others."""
        payload = _payload(
            _requirement([ANNA, ANNA, BERTIL], maxLessonsPerDay=1),
            teacherDayLimits=[{
                "id": str(uuid4()), "teacherId": BERTIL, "maxTeachingDaysPerWeek": 1,
                "lockedWeekdays": [[]],
            }],
        )

        assert _status(_every_lead_on_every_lesson(payload)) == "INFEASIBLE"
        assert _refusal(payload) is None
        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert len({lesson.day_of_week for lesson in _mine(result, BERTIL)}) == 1
        assert len({lesson.day_of_week for lesson in result.lessons}) == 3
        assert _validate(payload, result.lessons) == []

    def test_the_lunch_is_kept_clear_of_the_teacher_s_own_lessons_only(self) -> None:
        """7A is taught every hour of the week, and Anna eats at 11:00 each
        day. Read the old way she teaches every one of the twelve, lunch
        hours included; per lesson Bertil's nine take the 11:00s."""
        payload = _payload(
            _requirement([ANNA, ANNA, ANNA] + [BERTIL] * 9),
            teacherWorkRules=[{
                "id": str(uuid4()), "teacherId": ANNA, "lunchMinutes": 60,
                "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00",
            }],
        )

        assert _status(_every_lead_on_every_lesson(payload)) == "INFEASIBLE"
        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert "11:00:00" not in {lesson.start_time for lesson in _mine(result, ANNA)}
        assert [lesson.start_time for lesson in _mine(result, BERTIL)].count("11:00:00") == 3

    def test_a_free_day_wish_does_not_move_the_other_lead_s_lessons(self) -> None:
        """Anna would rather not teach Monday or Tuesday, Bertil wishes his
        Wednesdays free. Per lesson both are kept: her two on Wednesday, his
        one before it. Read the old way his wish counts her lessons, and the
        cheapest week moves all three off Wednesday."""
        payload = _payload(
            _requirement([ANNA, ANNA, BERTIL]),
            constraints=[
                _reservation(ANNA, MONDAY, kind="PREFERRED_FREE"),
                _reservation(ANNA, TUESDAY, kind="PREFERRED_FREE"),
            ],
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": BERTIL, "preferredFreeDay": WEDNESDAY}],
        )

        result = _solve(payload, **WISH_AND_WINDOWS)
        assert {lesson.day_of_week for lesson in _mine(result, ANNA)} == {WEDNESDAY}
        assert {lesson.day_of_week for lesson in _mine(result, BERTIL)} <= {MONDAY, TUESDAY}
        old = _solve(_every_lead_on_every_lesson(payload), **WISH_AND_WINDOWS)
        assert WEDNESDAY not in {lesson.day_of_week for lesson in old.lessons}

    def test_a_wished_day_s_previous_slot_is_kept_by_the_other_lead_s_lessons(self) -> None:
        """Last term's Wednesday 08:00 earns nothing for Bertil's lesson, whose
        lead wishes Wednesdays free; Anna's lesson may still keep it."""
        previous = [{"requirementId": REQUIREMENT, "dayOfWeek": WEDNESDAY, "startTime": "08:00:00"}]
        rule = [{"id": str(uuid4()), "teacherId": BERTIL, "preferredFreeDay": WEDNESDAY}]
        split = _payload(_requirement([ANNA, BERTIL]), previousLessons=previous, teacherWorkRules=rule)
        bertil_s = _payload(
            _requirement(None, teacher=BERTIL, lessons=2), previousLessons=previous, teacherWorkRules=rule,
        )

        def matches(payload: dict[str, object]) -> list[str]:
            model, *_rest = _build(payload, objective=True)
            return [v.name for v in model.Proto().variables if v.name.startswith("prev_0_")]

        assert matches(split) == [f"prev_0_{REQUIREMENT}_0"]
        assert matches(bertil_s) == []

    def test_a_teacher_with_no_lesson_left_and_a_lesson_with_no_lead_build_nothing_empty(self) -> None:
        """Rules on a lead whose lessons are a subset, and on a teacher the
        list leaves out entirely: nothing is built for the second, nothing
        empty for the first, and the week solves."""
        nobody = str(uuid4())
        payload = _payload(
            _requirement([ANNA, None, None]),
            teacherWorkRules=[
                {"id": str(uuid4()), "teacherId": ANNA, "maxTeachingMinutesPerDay": 60,
                 "minDailyRestMinutes": 600, "preferredFreeDay": MONDAY,
                 "lunchMinutes": 30, "lunchStartTime": "10:00:00", "lunchEndTime": "12:00:00"},
                {"id": str(uuid4()), "teacherId": nobody, "maxTeachingMinutesPerDay": 60},
            ],
            teacherDayLimits=[{
                "id": str(uuid4()), "teacherId": nobody, "maxTeachingDaysPerWeek": 1,
                "lockedWeekdays": [[]],
            }],
        )

        model, *_rest = _build(payload, objective=True)
        assert not [v.name for v in model.Proto().variables if nobody in v.name]
        assert model.Validate() == ""
        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        assert [lesson.day_of_week for lesson in _mine(result, ANNA)] != [MONDAY]
        assert _validate(payload, result.lessons) == []


# ---------------------------------------------------------------------------
# The pre-flight
# ---------------------------------------------------------------------------


class TestThePreflight:
    def test_one_lead_s_closed_day_stays_open_to_the_others(self) -> None:
        """At most one a day over three days, and Bertil away on Wednesday.
        Read the old way Wednesday is shut to 7A's maths and three lessons
        have two days; per lesson Anna takes Wednesday."""
        payload = _payload(
            _requirement([ANNA, ANNA, BERTIL], maxLessonsPerDay=1),
            constraints=[_reservation(BERTIL, WEDNESDAY)],
        )

        old = _refusal(_every_lead_on_every_lesson(payload))
        assert old is not None and old.code == "SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT"
        assert _refusal(payload) is None
        result = _solve(payload)
        assert sorted(lesson.day_of_week for lesson in result.lessons) == [MONDAY, TUESDAY, WEDNESDAY]
        assert {lesson.day_of_week for lesson in _mine(result, BERTIL)} <= {MONDAY, TUESDAY}

    def test_a_reservation_counts_against_the_row_only_on_every_lesson(self) -> None:
        """The pre-flight's reading is the row's and keeps out only what
        reaches every lesson; the rast flag's is the lesson's own."""
        rows = [_reservation(BERTIL, MONDAY, "09:00:00", "10:00:00"),
                _reservation(CO_TEACHER, MONDAY, "10:00:00", "11:00:00")]
        payload = _payload(_requirement([ANNA, BERTIL], coTeacherId=CO_TEACHER), constraints=rows)
        request = _request(payload)
        solver = SchedulerSolver(_settings())
        requirement = request.requirements[0]
        slots = 60 // solver._grid.slot_minutes

        assert solver._reserved_ranges(request, requirement, 0) == [(2 * slots, 3 * slots)]
        assert sorted(solver._reserved_ranges(
            request, requirement, 0, _teachers_at(requirement, 1),
        )) == [(slots, 2 * slots), (2 * slots, 3 * slots)]

    def test_a_block_member_s_leads_are_all_its_teachers(self) -> None:
        """A block member split between Anna and Bertil, beside a member of
        Bertil's alone: the k-th lessons start together, and one of the pair
        is his in both. The union is the reading, and it is refused by name."""
        block = str(uuid4())
        payload = _payload(
            _requirement([ANNA, BERTIL], blockId=block),
            _requirement(
                None, teacher=BERTIL, lessons=2, blockId=block,
                requirement_id=OTHER_REQUIREMENT, group=OTHER_GROUP,
            ),
        )

        error = _refusal(payload)
        assert error is not None and error.code == "BLOCK_MEMBERS_SHARE_TEACHER"
        apart = _payload(
            _requirement([ANNA, BERTIL], blockId=block),
            _requirement(
                None, teacher=CO_TEACHER, lessons=2, blockId=block,
                requirement_id=OTHER_REQUIREMENT, group=OTHER_GROUP,
            ),
        )
        assert _refusal(apart) is None

    def test_a_block_with_one_split_member_is_placed_lesson_by_lesson(self) -> None:
        """Parallella block (#144): a member split between Anna and Bertil
        beside one of the co-teacher's alone. The k-th lessons start together,
        and either of the split member's lessons may stand beside either of
        the other's, so the block is placed: each start holds one lesson of
        each, the split one's with its own lead."""
        block = str(uuid4())
        payload = _payload(
            _requirement([ANNA, BERTIL], blockId=block),
            _requirement(
                None, teacher=CO_TEACHER, lessons=2, blockId=block,
                requirement_id=OTHER_REQUIREMENT, group=OTHER_GROUP,
            ),
        )

        result = _solve(payload)
        assert result.status in {"OPTIMAL", "FEASIBLE"}
        def starts(requirement: str) -> list[tuple[int, object]]:
            return sorted(
                (lesson.day_of_week, lesson.start_time)
                for lesson in result.lessons if str(lesson.requirement_id) == requirement
            )

        assert starts(REQUIREMENT) == starts(OTHER_REQUIREMENT)
        assert sorted(str(lesson.teacher_id) for lesson in result.lessons
                      if str(lesson.requirement_id) == REQUIREMENT) == sorted([ANNA, BERTIL])
        assert _validate(payload, result.lessons) == []


def test_the_hours_verdict_charges_a_lead_of_a_split_post_their_own_lessons_only() -> None:
    """Bertil's week is 720 of a 720-minute week: three of 7A's six lessons
    and nine of 8A's. Read the requirement-level way — every lead on every
    lesson — he is charged all six of 7A's, 900 minutes, and the verdict
    refuses a week that has a timetable. Per lesson it refuses nothing, and
    the week is placed.
    """
    split = _requirement([ANNA, ANNA, ANNA, BERTIL, BERTIL, BERTIL])
    other = _requirement(
        None, teacher=BERTIL, lessons=9, requirement_id=OTHER_REQUIREMENT, group=OTHER_GROUP,
    )
    payload = _payload(split, other)
    solver = SchedulerSolver(_settings())

    assert solver._teacher_hours_verdict(_request(payload)) is None
    refused = solver._teacher_hours_verdict(_request(_every_lead_on_every_lesson(payload)))
    assert refused is not None and refused.summary_code == "DEMAND_TEACHER_HOURS_SHORT"
    assert refused.conflicts[0].params["demandMinutes"] == 900
    assert _status(payload) == "FEASIBLE"
