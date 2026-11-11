"""Terminer: a lesson that runs in some periods of the year takes its hour only then.

Hemkunskap for half the classes until December and for the other half from
January are requirements that never meet, so they may share the teacher, the
room, the pupils and the hour, and no count adds one term to the other
(app/solver/weeks.py). Three parts:

- THE CONTRACT: `periods` on a requirement and on a locked lesson, and
  `periodWeeks` on the request.
- A PERIOD IS HELD AS A PARITY IS: every week test_ab_weeks.py solves or
  refuses for odd and even weeks is solved or refused the same with the two
  weeks written as two periods, as three, and as two periods of one parity —
  the same rows, cut by a different field.
- WHAT ONLY PERIODS HAVE: the school this was built for, a week two terms
  share, periods beside a parity, a refusal that names its period, weights,
  and more periods than a row is cut into.
"""

from __future__ import annotations

import copy
import functools
import inspect
import sys
from pathlib import Path
from types import ModuleType
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

import test_ab_weeks as ab
import test_best_effort_report
import test_consecutive
import test_placement
import test_pupil_gaps
import test_week_load
from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import MAX_PERIODS, OptimizeScheduleRequest, ScheduledLesson
from app.solver.pupil_gaps import pupil_idle_minutes, week_factor
from app.solver.scheduler_solver import SchedulerSolver, _week_requests, _weeks_and_requests
from app.solver import weeks as weeks_module
from app.solver.weeks import PART_LIMIT, Weeks

ODD, EVEN = "ODD_WEEKS", "EVEN_WEEKS"
SOLVED = {"OPTIMAL", "FEASIBLE"}
AUTUMN, SPRING = [True, False], [False, True]

_settings = ab._settings
_payload = ab._payload
_spans = ab._spans
_overlap = ab._overlap


def _requirement(group: str, lessons: int, *, periods: list[bool] | None = None, **extra: object):
    requirement = ab._requirement(group, lessons, **extra)  # type: ignore[arg-type]
    if periods is not None:
        requirement["periods"] = periods
    return requirement


def _solve(payload: dict[str, object], settings: Settings | None = None):
    return SchedulerSolver(settings or _settings()).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )


def _validate(payload: dict[str, object], lessons, settings: Settings | None = None) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    grid = SchedulerSolver(settings or _settings())._grid
    return validate(grid, OptimizeScheduleRequest.model_validate(payload), lessons)


def _all_year(payload: dict[str, object]) -> dict[str, object]:
    """The same week with every lesson and lock all year: the non-vacuous side."""
    def strip(row: dict[str, object]) -> dict[str, object]:
        return {key: value for key, value in row.items() if key not in ("periods", "recurrence")}

    return {
        **{key: value for key, value in payload.items() if key != "periodWeeks"},
        "requirements": [strip(r) for r in payload["requirements"]],  # type: ignore[union-attr]
        "fixedLessons": [strip(f) for f in payload.get("fixedLessons", [])],  # type: ignore[union-attr]
    }


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_the_field_is_optional_and_a_mask_over_the_years_periods() -> None:
    group = str(uuid4())
    payload = _payload([_requirement(group, 1), _requirement(group, 1, periods=AUTUMN)])
    request = OptimizeScheduleRequest.model_validate(payload)
    assert [r.periods for r in request.requirements] == [None, (True, False)]
    # Absent stays absent on the way out, so a payload without it is byte for byte what it was.
    assert "periods" not in request.requirements[0].model_dump(exclude_none=True)
    assert "periodWeeks" not in request.model_dump(exclude_none=True, by_alias=True)
    assert request.requirements[1].model_dump(by_alias=True)["periods"] == (True, False)


@pytest.mark.parametrize(
    "mask",
    [
        [True, True],  # every period is the field left out
        [False, False],  # an entry that never runs
        [True],  # one period is no cut at all
        [True, False] * 27,  # 54: more periods than a läsår has weeks
        [],
    ],
)
def test_a_mask_names_some_period_and_not_every_one(mask: list[bool]) -> None:
    group = str(uuid4())
    with pytest.raises(ValidationError):
        OptimizeScheduleRequest.model_validate(_payload([_requirement(group, 1, periods=mask)]))
    lock = {"id": str(uuid4()), "studentGroupId": group, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00", "periods": mask}
    with pytest.raises(ValidationError):
        OptimizeScheduleRequest.model_validate(
            _payload([_requirement(group, 1)], fixedLessons=[lock]),
        )


def test_the_longest_mask_is_a_period_per_week_of_a_lasar() -> None:
    group = str(uuid4())
    mask = [True] + [False] * (MAX_PERIODS - 1)
    request = OptimizeScheduleRequest.model_validate(
        _payload([_requirement(group, 1, periods=mask)]),
    )
    assert len(request.requirements[0].periods or ()) == 53


def test_every_mask_of_one_payload_cuts_the_year_alike() -> None:
    group = str(uuid4())
    lock = {"id": str(uuid4()), "studentGroupId": group, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00"}
    with pytest.raises(ValidationError, match="same length"):
        OptimizeScheduleRequest.model_validate(_payload([
            _requirement(group, 1, periods=AUTUMN), _requirement(group, 1, periods=[True, False, False]),
        ]))
    with pytest.raises(ValidationError, match="same length"):
        OptimizeScheduleRequest.model_validate(_payload(
            [_requirement(group, 1, periods=AUTUMN)],
            fixedLessons=[{**lock, "periods": [True, False, False]}],
        ))
    # A post released from its förläggning is a requirement of the same year.
    post = _requirement(group, 1, periods=AUTUMN)
    with pytest.raises(ValidationError, match="same length"):
        OptimizeScheduleRequest.model_validate(_payload(
            [post], fixedLessons=[lock],
            placements={
                "lessons": [{"fixedLessonId": lock["id"], "requirementId": post["id"]}],
                "requirements": [{**post, "periods": [True, False, False]}],
            },
        ))


def test_period_weeks_counts_the_masks_periods_and_nothing_else() -> None:
    group = str(uuid4())
    dated = [_requirement(group, 1, periods=AUTUMN)]
    assert OptimizeScheduleRequest.model_validate(
        _payload(dated, periodWeeks=[19, 21]),
    ).period_weeks == [19, 21]
    for weeks in ([19, 2, 21], [19], [19, 0], [19, 54]):
        with pytest.raises(ValidationError):
            OptimizeScheduleRequest.model_validate(_payload(dated, periodWeeks=weeks))
    # Without a mask there is nothing it counts.
    with pytest.raises(ValidationError, match="periodWeeks"):
        OptimizeScheduleRequest.model_validate(
            _payload([_requirement(group, 1)], periodWeeks=[19, 21]),
        )


def test_an_engine_that_predates_the_field_would_refuse_it() -> None:
    """The reason the engine ships first: its models forbid a key they have not heard of."""
    group = str(uuid4())
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        OptimizeScheduleRequest.model_validate(
            _payload([{**_requirement(group, 1), "notAField": [True, False]}]),
        )


def test_the_request_is_cut_into_its_periods_and_each_is_every_week() -> None:
    group = str(uuid4())
    weekly, autumn, spring = (
        _requirement(group, 1), _requirement(group, 1, periods=AUTUMN),
        _requirement(group, 1, periods=SPRING),
    )
    lock = {"id": str(uuid4()), "studentGroupId": str(uuid4()), "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00", "periods": SPRING}
    request = OptimizeScheduleRequest.model_validate(
        _payload([weekly, autumn, spring], fixedLessons=[lock], periodWeeks=[19, 21]),
    )
    weeks = _weeks_and_requests(request)
    assert [week for week, _ in weeks] == [Weeks(0b0011, 2), Weeks(0b1100, 2)]
    first, second = (week_request for _, week_request in weeks)
    assert [str(r.id) for r in first.requirements] == [weekly["id"], autumn["id"]]
    assert [str(r.id) for r in second.requirements] == [weekly["id"], spring["id"]]
    assert first.fixed_lessons == [] and len(second.fixed_lessons) == 1
    # Inside one week every lesson of it runs: nothing is left to cut.
    for week_request in (first, second):
        assert all(r.periods is None for r in week_request.requirements)
        assert all(f.periods is None for f in week_request.fixed_lessons)
        assert week_request.period_weeks is None
        assert _week_requests(week_request) == [week_request]


# ---------------------------------------------------------------------------
# A period is held as a parity is
# ---------------------------------------------------------------------------

#: The weeks test_ab_weeks.py is written in, as periods. Each maps the odd
#: weeks and the even ones to two sets of concrete weeks that never meet.
AS_PERIODS = {
    "two terms": {ODD: {"periods": AUTUMN}, EVEN: {"periods": SPRING}},
    "three periods, one of them shared by neither": {
        ODD: {"periods": [True, False, False]}, EVEN: {"periods": [False, False, True]},
    },
    "four periods, alternating": {
        ODD: {"periods": [True, False, True, False]}, EVEN: {"periods": [False, True, False, True]},
    },
    "two terms of the odd weeks": {
        ODD: {"periods": AUTUMN, "recurrence": ODD}, EVEN: {"periods": SPRING, "recurrence": ODD},
    },
    "the odd and the even weeks of one term": {
        ODD: {"periods": AUTUMN, "recurrence": ODD}, EVEN: {"periods": AUTUMN, "recurrence": EVEN},
    },
}

#: Tests of test_ab_weeks.py that are about the parity field itself, about the
#: validator's words for a parity, or that build requirements below the payload.
NOT_MIRRORED = {
    "test_the_field_is_optional_and_names_one_parity",
    "test_week_parts_keeps_a_row_without_alternating_members_whole",
    "test_named_rooms_refuse_the_week_no_room_assignment_holds",
    "test_a_lesson_that_may_take_a_special_room_is_given_one_whenever_it_does",
    "test_the_validator_reads_each_week",
}
MIRRORED = sorted(
    name for name in dir(ab) if name.startswith("test_") and name not in NOT_MIRRORED
)


class _IsARequest(type):
    def __instancecheck__(cls, instance: object) -> bool:
        return isinstance(instance, OptimizeScheduleRequest)


def _AsPeriods(weeks: dict[str, dict[str, object]]) -> type:  # noqa: N802 - stands in for a class
    """OptimizeScheduleRequest for a module of week tests, reading each parity as periods."""

    def row_of(row: dict[str, object]) -> dict[str, object]:
        parity = row.get("recurrence")
        if parity is None:
            return row
        rest = {key: value for key, value in row.items() if key != "recurrence"}
        return {**rest, **weeks[str(parity)]}

    class Mirrored(metaclass=_IsARequest):
        @staticmethod
        def model_validate(payload: dict[str, object]) -> OptimizeScheduleRequest:
            mirrored = copy.deepcopy(payload)
            for key in ("requirements", "fixedLessons"):
                if key in mirrored:
                    mirrored[key] = [row_of(row) for row in mirrored[key]]  # type: ignore[union-attr]
            return OptimizeScheduleRequest.model_validate(mirrored)

    return Mirrored


def test_the_mirror_reaches_every_week_test_of_the_two_weeks() -> None:
    assert len(MIRRORED) == 24
    # And it does write periods: a parity in, a mask out.
    request = _AsPeriods(AS_PERIODS["two terms"]).model_validate(
        _payload([ab._requirement(str(uuid4()), 1, recurrence=ODD)]),
    )
    assert request.requirements[0].periods == (True, False)
    assert request.requirements[0].recurrence is None


@pytest.mark.parametrize("weeks", sorted(AS_PERIODS))
@pytest.mark.parametrize("name", MIRRORED)
def test_a_period_is_held_as_a_parity_is(
    name: str, weeks: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every week the two-week tests solve or refuse, with the two weeks as periods."""
    monkeypatch.setattr(ab, "OptimizeScheduleRequest", _AsPeriods(AS_PERIODS[weeks]))
    getattr(ab, name)()


#: The other modules that test a rule in odd and even weeks: placeringsregler,
#: elevernas håltimmar, sammanhängande undervisning, Bästa möjliga schema's
#: report and the year's load. Their week tests are run with the two weeks as
#: two terms, which weigh as the two parities do (one week of two each), so a
#: test that reads a price or a count reads the same one.
ELSEWHERE: tuple[ModuleType, ...] = (
    test_placement, test_pupil_gaps, test_consecutive, test_best_effort_report, test_week_load,
)
#: Tests there that read the parity itself rather than a week held by it.
NOT_MIRRORED_ELSEWHERE: dict[str, str] = {}


def _week_tests(module: ModuleType) -> list[tuple[str, object]]:
    """Every test of `module` that writes a parity and takes nothing from pytest."""
    found: list[tuple[str, object]] = []
    for name, value in vars(module).items():
        if name.startswith("test_") and inspect.isfunction(value):
            found.append((name, value))
        elif name.startswith("Test") and inspect.isclass(value):
            found.extend(
                (f"{name}.{method}", functools.partial(function, value()))
                for method, function in vars(value).items()
                if method.startswith("test_") and inspect.isfunction(function)
            )
    kept = []
    for name, test in found:
        function = test.func if isinstance(test, functools.partial) else test
        source = inspect.getsource(function)
        takes = [p for p in inspect.signature(function).parameters if p != "self"]
        if not takes and ("recurrence" in source or "_WEEKS" in source):
            kept.append((f"{module.__name__}.{name}", test))
    return kept


MIRRORED_ELSEWHERE = {
    name: (module, test)
    for module in ELSEWHERE
    for name, test in _week_tests(module)
    if name not in NOT_MIRRORED_ELSEWHERE
}


def test_the_mirror_reaches_the_week_tests_of_the_other_rules() -> None:
    by_module = {module.__name__: 0 for module in ELSEWHERE}
    for name in MIRRORED_ELSEWHERE:
        by_module[name.split(".")[0]] += 1
    assert all(count > 0 for count in by_module.values()), by_module


@pytest.mark.parametrize("name", sorted(MIRRORED_ELSEWHERE))
def test_a_term_is_held_as_a_parity_is_by_every_other_rule(
    name: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, test = MIRRORED_ELSEWHERE[name]
    monkeypatch.setattr(module, "OptimizeScheduleRequest", _AsPeriods(AS_PERIODS["two terms"]))
    test()  # type: ignore[operator]


# ---------------------------------------------------------------------------
# What only periods have
# ---------------------------------------------------------------------------


def _the_school(with_periods: bool) -> tuple[dict[str, object], dict[str, list[dict[str, object]]]]:
    """One hemkunskap teacher, one hemkunskapssal, and the year this was built for.

    Four periods: the autumn, the weeks between the terms, the week of 11-17
    January that both terms have, and the spring.
    - Year 9: ten groups of 130 minutes; five read in the autumn, five from 11
      January.
    - Year 7: six classes in halves, 90 minutes each with the teacher and 40
      with one of two others; the first halves read until 17 January, the
      second from 18 January. So the week of 11-17 January has year 9's spring
      groups AND year 7's autumn halves.
    - Year 6: three posts of 60 minutes all year.
    The teacher has 25 posts and 2,560 minutes; 1,370 in each term.
    """
    teacher, others, hall = str(uuid4()), [str(uuid4()), str(uuid4())], "hemkunskapssal"

    def mask(*on: str) -> list[bool] | None:
        return ["ABCD".index(p) in ["ABCD".index(q) for q in on] for p in "ABCD"] if with_periods else None

    rows: dict[str, list[dict[str, object]]] = {"nine_autumn": [], "nine_spring": [], "seven_first": [],
                                                 "seven_second": [], "six": [], "workshop": []}
    for index in range(10):
        term = "nine_autumn" if index >= 5 else "nine_spring"
        rows[term].append(_requirement(
            str(uuid4()), 1, teacher=teacher, minutes=130, requiredRoomType=hall,
            periods=mask("A") if index >= 5 else mask("C", "D"),
        ))
    for index in range(6):
        for half, periods in (("seven_first", mask("A", "B", "C")), ("seven_second", mask("D"))):
            group = str(uuid4())
            rows[half].append(_requirement(
                group, 1, teacher=teacher, minutes=90, requiredRoomType=hall, periods=periods,
            ))
            rows["workshop"].append(_requirement(
                group, 1, teacher=others[index % 2], minutes=40, periods=periods,
            ))
    for _ in range(3):
        rows["six"].append(_requirement(
            str(uuid4()), 1, teacher=teacher, minutes=60, requiredRoomType=hall,
        ))
    payload = _payload(
        [row for part in rows.values() for row in part],
        rooms=[{"id": str(uuid4()), "capacity": 30, "type": hall}]
        + [{"id": str(uuid4()), "capacity": 30} for _ in range(4)],
        **({"periodWeeks": [19, 2, 1, 21]} if with_periods else {}),
    )
    return payload, rows


#: 08:00-15:30 on five days: 2,250 minutes a week.
SCHOOL = dict(SOLVER_MAX_TIME_SECONDS=30.0, SCHEDULE_DAY_END_MINUTES=480 + 450, SCHEDULE_DAYS="1,2,3,4,5")


def test_the_school_this_was_built_for_is_refused_read_as_one_week() -> None:
    """The refusal production gave: one teacher, 25 posts, 2,560 minutes against 2,250."""
    payload, _ = _the_school(with_periods=False)
    response = _solve(payload, Settings(**SCHOOL))  # type: ignore[arg-type]
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "DEMAND_TEACHER_HOURS_SHORT"
    (line,) = response.conflicts.conflicts
    assert line.code == "DEMAND_TEACHER_LESSONS_EXCEED_ROOM"
    assert (line.params["requirements"], line.params["demandMinutes"], line.params["capacityMinutes"]) == (
        25, 2560, 2250,
    )


def test_the_school_this_was_built_for_has_a_timetable_term_by_term() -> None:
    payload, rows = _the_school(with_periods=True)
    settings = Settings(**SCHOOL)  # type: ignore[arg-type]
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert len(response.lessons) == 37
    assert _validate(payload, response.lessons, settings) == []

    def spans(part: str) -> list[tuple[int, int]]:
        return [span for row in rows[part] for span in _spans(response.lessons, row)]

    # The teacher and the room are one each, so what meets is held apart:
    # the autumn's lessons from each other, and from year 6's of every week.
    def apart(*parts: str) -> bool:
        held = sorted(span for part in parts for span in spans(part))
        return all(first[1] <= second[0] for first, second in zip(held, held[1:]))

    assert apart("nine_autumn", "seven_first", "six")
    assert apart("nine_spring", "seven_second", "six")
    # The week of 11-17 January: year 9's spring groups beside year 7's autumn halves.
    assert apart("nine_spring", "seven_first", "six")
    # And what never meets shares hours: 2,560 minutes do not fit 2,250 otherwise.
    assert _overlap(spans("nine_autumn") + spans("seven_first"), spans("seven_second"))
    assert not apart("nine_autumn", "seven_second", "nine_spring", "seven_first", "six")


def test_the_week_two_terms_share_holds_them_apart() -> None:
    """Three periods; the middle one has the autumn's post and the spring's, one hour, one teacher."""
    teacher = str(uuid4())
    autumn = _requirement(str(uuid4()), 1, teacher=teacher, periods=[True, True, False])
    spring = _requirement(str(uuid4()), 1, teacher=teacher, periods=[False, True, True])
    settings = _settings(hours=1)
    refused = _solve(_payload([autumn, spring]), settings)
    assert refused.status == "INFEASIBLE"
    # Counted in the week they share, and named: the second of the three periods.
    assert refused.conflicts is not None
    assert refused.conflicts.summary_params["period"] == 1
    assert all(line.params["period"] == 1 for line in refused.conflicts.conflicts)
    # With the shared week gone they take the one hour in turn.
    autumn["periods"], spring["periods"] = [True, False, False], [False, False, True]
    payload = _payload([autumn, spring])
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _spans(response.lessons, autumn) == _spans(response.lessons, spring)
    assert _validate(payload, response.lessons, settings) == []


def test_a_term_that_cannot_be_laid_is_refused_and_named() -> None:
    """The autumn fits its four hours and the spring has five: the spring is refused, as the spring."""
    group = str(uuid4())
    weekly = _requirement(group, 2)
    autumn = _requirement(group, 2, periods=AUTUMN)
    spring = _requirement(group, 3, periods=SPRING)
    response = _solve(_payload([weekly, autumn, spring]))
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_params["period"] == 1
    assert "parity" not in response.conflicts.summary_params
    named = {rid for line in response.conflicts.conflicts for rid in line.requirement_ids}
    assert UUID(str(autumn["id"])) not in named
    assert named & {UUID(str(weekly["id"])), UUID(str(spring["id"]))}
    assert all(line.params["period"] == 1 for line in response.conflicts.conflicts)
    # The English is the sentence it always was: no sentence reads the new param.
    plain = _solve(_payload([weekly, {**spring, "periods": None}]))
    assert plain.conflicts is not None
    assert [line.message for line in response.conflicts.conflicts] == [
        line.message for line in plain.conflicts.conflicts
    ]
    # With four hours in the spring too, both terms are laid.
    spring["lessonsPerWeek"] = 2
    assert _solve(_payload([weekly, autumn, spring])).status in SOLVED


def test_a_refusal_before_the_model_names_its_period_too() -> None:
    """A teacher's cap of 120 minutes a day against 180 in the spring: a 400, with the spring's index."""
    teacher, group = str(uuid4()), str(uuid4())
    requirements = [
        _requirement(group, 1, teacher=teacher),
        _requirement(group, 1, teacher=teacher, periods=AUTUMN),
        _requirement(str(uuid4()), 2, teacher=teacher, periods=SPRING),
    ]
    payload = _payload(
        requirements,
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 120}],
    )
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(payload)
    assert refused.value.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
    assert refused.value.params["period"] == 1
    # The same refusal for a year without periods says nothing of one.
    with pytest.raises(InvalidScheduleInputError) as plain:
        _solve(_all_year(payload))
    assert "period" not in plain.value.params
    assert {key: value for key, value in refused.value.params.items() if key != "period"}.keys() == (
        plain.value.params.keys()
    )


def test_a_period_and_a_parity_are_one_week_only_together() -> None:
    """One hour, one teacher: the odd weeks of the autumn, its even weeks, and the spring."""
    teacher = str(uuid4())

    def post(periods: list[bool] | None, recurrence: str | None) -> dict[str, object]:
        return _requirement(str(uuid4()), 1, teacher=teacher, periods=periods, recurrence=recurrence)

    settings = _settings(hours=1)
    payload = _payload([post(AUTUMN, ODD), post(AUTUMN, EVEN), post(SPRING, None)])
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert len({lesson.start_time for lesson in response.lessons}) == 1
    assert _validate(payload, response.lessons, settings) == []
    for clash in (
        [post(AUTUMN, ODD), post(AUTUMN, ODD)],
        [post(AUTUMN, ODD), post(AUTUMN, None)],
        [post(AUTUMN, ODD), post(None, ODD)],
        [post(SPRING, EVEN), post(None, None)],
    ):
        refused = _solve(_payload(clash), settings)
        assert refused.status == "INFEASIBLE"
    # A refusal in the odd weeks of the autumn says both.
    refused = _solve(_payload([post(AUTUMN, ODD), post(AUTUMN, ODD), post(SPRING, None)]), settings)
    assert refused.conflicts is not None
    assert (refused.conflicts.summary_params["period"], refused.conflicts.summary_params["parity"]) == (
        0, ODD,
    )


def test_a_lock_of_one_term_holds_its_teacher_pupils_and_room_in_that_term() -> None:
    teacher, group, room = str(uuid4()), str(uuid4()), str(uuid4())
    rooms = [{"id": room, "capacity": 30}]
    lock = {"id": str(uuid4()), "teacherId": teacher, "studentGroupId": group, "roomId": room,
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00", "periods": AUTUMN}
    settings = _settings(hours=1)
    for row in (
        _requirement(str(uuid4()), 1, teacher=teacher),  # the lock's teacher
        _requirement(group, 1),  # its pupils
        _requirement(str(uuid4()), 1),  # nothing but its room
    ):
        spring = _payload([{**row, "periods": SPRING}], rooms=rooms, fixedLessons=[lock])
        response = _solve(spring, settings)
        assert response.status in SOLVED
        assert _validate(spring, response.lessons, settings) == []
        for held in (AUTUMN, None):
            autumn = _payload(
                [{**row, **({"periods": held} if held else {})}], rooms=rooms, fixedLessons=[lock],
            )
            assert _solve(autumn, settings).status == "INFEASIBLE"


def test_rooms_of_one_kind_are_shared_term_by_term_without_being_named() -> None:
    """Two slöjdsalar; three classes all year and one more in the autumn: one part, no room named.

    Every lesson of the pool is in the autumn's part, so the pool is one
    cumulative (room_allocator: every lesson in exactly one part) — where a
    pool of every-week lessons beside odd ones names its rooms.
    """
    rooms = [{"id": str(uuid4()), "capacity": 30, "type": "SL"} for _ in range(2)]
    requirements = [
        *[_requirement(str(uuid4()), 1, requiredRoomType="SL") for _ in range(3)],
        _requirement(str(uuid4()), 1, requiredRoomType="SL", periods=AUTUMN),
    ]
    payload = _payload(requirements, rooms=rooms)
    settings = _settings(hours=2)
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(settings)
    _, _, _, plan, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    assert plan.named == set() and plan.rooms_of == {}
    assert len(plan.by_week) == 1
    response = solver.solve(request)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    # Five lessons would not fit the four room-hours: the autumn holds four.
    requirements.append(_requirement(str(uuid4()), 1, requiredRoomType="SL", periods=AUTUMN))
    assert _solve(_payload(requirements, rooms=rooms), settings).status == "INFEASIBLE"
    # But one more of the SPRING does: three all year and two of each term.
    requirements[-1]["periods"] = SPRING
    payload = _payload(requirements, rooms=rooms)
    request = OptimizeScheduleRequest.model_validate(payload)
    _, _, _, plan, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    # Every-week lessons beside two terms' are in both parts: the rooms are named.
    assert len(plan.named) == 1 and plan.by_week == set()
    response = solver.solve(request)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert solver._estimate_model_size(request) >= len(
        solver._build_model(request, use_assumptions=False, include_objective=True)[0].Proto().variables,
    )


def test_two_terms_alone_in_two_rooms_are_two_colourings() -> None:
    rooms = [{"id": str(uuid4()), "capacity": 30, "type": "SL"} for _ in range(2)]
    requirements = [
        _requirement(str(uuid4()), 2, requiredRoomType="SL", periods=periods)
        for periods in (AUTUMN, AUTUMN, SPRING, SPRING)
    ]
    payload = _payload(requirements, rooms=rooms)
    settings = _settings(hours=2)
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(settings)
    _, _, _, plan, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    assert len(plan.by_week) == 1 and plan.named == set()
    assert set(plan.part_of.values()) == {Weeks(0b0011, 2), Weeks(0b1100, 2)}
    response = solver.solve(request)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_all_year(payload), settings).status == "INFEASIBLE"


def _twelve_courses() -> tuple[dict[str, object], dict[str, object], list[dict[str, object]]]:
    """One teacher: a lesson of every week, and twelve courses of a period each."""
    teacher = str(uuid4())
    weekly = _requirement(str(uuid4()), 1, teacher=teacher)
    courses = [
        _requirement(str(uuid4()), 1, teacher=teacher, periods=[p == q for q in range(12)])
        for p in range(12)
    ]
    return _payload([weekly, *courses]), weekly, courses


def test_twelve_courses_of_a_period_each_take_one_hour_of_a_teachers_week() -> None:
    """More periods than PART_LIMIT, and a teacher's own row is still cut by every one."""
    assert PART_LIMIT < 12
    payload, weekly, courses = _twelve_courses()
    settings = _settings(hours=2)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert len({tuple(_spans(response.lessons, course)) for course in courses}) == 1
    assert not _overlap(_spans(response.lessons, weekly), _spans(response.lessons, courses[0]))
    assert _solve(_all_year(payload), settings).status == "INFEASIBLE"


def test_a_row_joined_past_the_limit_is_stricter_and_never_looser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same year with every row treated as a large one: parts joined, nothing that meets shares an hour.

    Twelve weeks are cut into PART_LIMIT parts, and a joined part holds apart
    two courses that never meet. So two hours no longer take them — the cap's
    cost, which is why only a row over a school's lessons pays it — and with
    hours enough the timetable is one every real week keeps.
    """
    monkeypatch.setattr(weeks_module, "ROW_LIMIT", 0)
    payload, weekly, courses = _twelve_courses()
    assert _solve(payload, _settings(hours=2)).status == "INFEASIBLE"
    settings = _settings(hours=6)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    for course in courses:
        assert not _overlap(_spans(response.lessons, weekly), _spans(response.lessons, course))
    # One hour for the weekly lesson, and at most one more for each joined pair.
    assert len({lesson.start_time for lesson in response.lessons}) <= 2 + 12 - PART_LIMIT


def test_the_rast_is_owed_in_every_term_however_many() -> None:
    """Twelve periods, never joined: each term's class arrives at the break taught, or the week is refused.

    7A has a lesson of every week that its teacher can only give after the
    09:00 break, and a lesson before the break in eleven of the twelve
    terms. Joined into fewer weeks, a term's lesson would answer for the one
    term that has none.
    """
    a, b, teacher = str(uuid4()), str(uuid4()), str(uuid4())
    years = {"minGradeLevel": 7, "maxGradeLevel": 7}
    before = [
        _requirement(a, 1, periods=[p == q for q in range(12)], **years) for p in range(11)
    ]
    payload = _payload(
        [_requirement(a, 1, teacher=teacher, **years), _requirement(b, 1, teacher=teacher, **years),
         *before],
        constraints=[ab._closed("STUDENT_GROUP", b, 1, "09:00:00", "23:59:00")],
        rasts=[{"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "09:00:00",
                "endTime": "09:20:00", "requiresLessonBefore": True}],
    )
    settings = Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=680,
    )
    assert _solve(payload, settings).status == "INFEASIBLE"
    # A lesson before the break in the twelfth term too, and every term is answered.
    payload["requirements"].append(  # type: ignore[union-attr]
        _requirement(a, 1, periods=[q == 11 for q in range(12)], **years),
    )
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []


def test_only_so_many_weeks_are_solved_before_the_model_and_all_are_counted() -> None:
    """Twelve terms: the arithmetic verdicts read each, the lunch stage the heaviest eight."""
    group = str(uuid4())
    terms = [
        _requirement(group, 1 + (p % 3), periods=[p == q for q in range(12)]) for p in range(12)
    ]
    request = OptimizeScheduleRequest.model_validate(_payload(terms))
    solver = SchedulerSolver(_settings())
    weeks = _weeks_and_requests(request)
    assert len(weeks) == 12
    solved = solver._solved_weeks(weeks)
    assert len(solved) == solver.MAX_SOLVED_WEEKS == 8
    # The heaviest, in the order they came.
    assert [w.period() for w, _ in solved] == sorted(w.period() for w, _ in solved)
    lightest = min(sum(r.lessons_per_week for r in week.requirements) for _, week in solved)
    left_out = [week for item in weeks if item not in solved for week in [item[1]]]
    assert all(sum(r.lessons_per_week for r in week.requirements) <= lightest for week in left_out)
    # A term the arithmetic refuses is refused wherever it stands, and named.
    # Eleven terms with six lessons between two classes, and a twelfth with
    # five hours of one class's four-hour day: the lightest week of the
    # twelve, which the solving verdicts leave out, and the counting ones do not.
    other = str(uuid4())
    heavy = [
        _requirement(group if half else other, 3, periods=[p == q for q in range(12)])
        for p in range(11) for half in (True, False)
    ]
    overfull = _requirement(str(uuid4()), 5, periods=[q == 11 for q in range(12)])
    request = OptimizeScheduleRequest.model_validate(_payload([*heavy, overfull]))
    assert all(week.period() != 11 for week, _ in solver._solved_weeks(_weeks_and_requests(request)))
    response = solver.solve(request)
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None and response.conflicts.summary_params["period"] == 11


def test_a_hole_weighs_its_terms_share_of_the_year() -> None:
    """A two-hour hole in the autumn only, 19 weeks of 40: 19/40 of 120 minutes for each pupil."""
    group = str(uuid4())
    first = _requirement(group, 1)
    late = _requirement(group, 1, periods=AUTUMN)
    payload = _payload(
        [first, late], periodWeeks=[19, 21],
        pupilGaps={"cohorts": [{"groupIds": [group], "pupils": 20, "homeGroupId": group}]},
    )
    request = OptimizeScheduleRequest.model_validate(payload)

    def lesson(requirement: dict[str, object], start: str, end: str) -> ScheduledLesson:
        return ScheduledLesson.model_validate({
            "requirementId": requirement["id"], "dayOfWeek": 1,
            "startTime": start, "endTime": end, "roomId": None,
        })

    holed = [lesson(first, "08:00:00", "09:00:00"), lesson(late, "11:00:00", "12:00:00")]
    assert pupil_idle_minutes(request, holed) == pytest.approx(20 * 120 * 19 / 40)
    # The whole year in every other term's weight: 40 weeks, no parity beside them.
    assert week_factor(request) == 40
    # Without the figures the two periods weigh alike.
    unweighted = OptimizeScheduleRequest.model_validate(
        {key: value for key, value in payload.items() if key != "periodWeeks"},
    )
    assert pupil_idle_minutes(unweighted, holed) == pytest.approx(20 * 120 / 2)
    assert week_factor(unweighted) == 2
    # And a year without periods weighs what it always did.
    assert week_factor(OptimizeScheduleRequest.model_validate(_all_year(payload))) == 1
    # The objective is built and the week is laid with the hole closed.
    response = _solve(payload, _settings(hours=4))
    assert response.status in SOLVED
    assert response.pupil_idle_minutes == 0


def test_a_teachers_idle_time_is_the_years_mean() -> None:
    """Built for a teacher whose terms differ; the week is laid without a hole in either."""
    teacher = str(uuid4())
    payload = _payload(
        [_requirement(str(uuid4()), 1, teacher=teacher),
         _requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN),
         _requirement(str(uuid4()), 1, teacher=teacher, periods=SPRING)],
        periodWeeks=[10, 30],
    )
    settings = _settings(hours=4)
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(settings)
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    names = {variable.name for variable in model.Proto().variables}
    assert any(name.endswith("_p0") for name in names) and any(name.endswith("_p1") for name in names)
    # The mean over the year: 4·idle >= 1·autumn + 3·spring.
    proto = model.Proto()
    rows = [
        sorted((abs(coeff), proto.variables[index].name) for coeff, index in zip(row.linear.coeffs, row.linear.vars))
        for row in proto.constraints
        if len(row.linear.vars) == 3 and {abs(coeff) for coeff in row.linear.coeffs} == {1, 3, 4}
    ]
    assert rows, "the weighted mean was posted"
    for row in rows:
        assert [name.rsplit("_", 1)[-1] for _, name in row[:2]] == ["p0", "p1"]
        assert not row[2][1].endswith(("_p0", "_p1"))
    response = solver.solve(request)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    starts = sorted({lesson.start_time for lesson in response.lessons})
    assert len(starts) == 2 and _minutes_between(starts) == 60


def _minutes_between(starts: list[str]) -> int:
    return ab._minutes(starts[1]) - ab._minutes(starts[0])


def test_the_validator_reads_each_period() -> None:
    group = str(uuid4())
    autumn = _requirement(group, 1, periods=AUTUMN)
    spring = _requirement(group, 1, periods=SPRING)
    weekly = _requirement(group, 1)
    payload = _payload([autumn, spring, weekly])

    def lesson(requirement: dict[str, object], start: str, end: str) -> ScheduledLesson:
        return ScheduledLesson.model_validate({
            "requirementId": requirement["id"], "dayOfWeek": 1,
            "startTime": start, "endTime": end, "roomId": None,
        })

    shared = [lesson(autumn, "08:00:00", "09:00:00"), lesson(spring, "08:00:00", "09:00:00"),
              lesson(weekly, "09:00:00", "10:00:00")]
    assert _validate(payload, shared) == []
    clash = [lesson(autumn, "08:00:00", "09:00:00"), lesson(spring, "09:00:00", "10:00:00"),
             lesson(weekly, "08:30:00", "09:30:00")]
    problems = _validate(payload, clash)
    assert any("(period 1)" in problem for problem in problems)
    assert any("(period 2)" in problem for problem in problems)
    # With a parity beside the periods, each week says both.
    odd = _requirement(group, 1, periods=AUTUMN, recurrence=ODD)
    payload = _payload([odd, weekly])
    problems = _validate(payload, [lesson(odd, "08:00:00", "09:00:00"), lesson(weekly, "08:30:00", "09:30:00")])
    assert problems and all("(period 1, udda veckor)" in problem for problem in problems)


def test_a_block_may_hold_the_autumns_member_and_the_springs_of_one_teacher() -> None:
    """Two posts on the same times, one a term: the block the gateway's link is, in the engine."""
    teacher, block = str(uuid4()), str(uuid4())
    autumn = _requirement(str(uuid4()), 2, teacher=teacher, periods=AUTUMN, blockId=block)
    spring = _requirement(str(uuid4()), 2, teacher=teacher, periods=SPRING, blockId=block)
    payload = _payload([autumn, spring])
    settings = _settings(hours=2)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _spans(response.lessons, autumn) == _spans(response.lessons, spring)
    assert _validate(payload, response.lessons, settings) == []
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(_all_year(payload), settings)
    assert refused.value.code == "BLOCK_MEMBERS_SHARE_TEACHER"


# ---------------------------------------------------------------------------
# Rooms, on the allocator alone
# ---------------------------------------------------------------------------


def _allocator_alone(model, lessons, rooms, **grid):  # type: ignore[no-untyped-def]
    """Room allocation alone, over lessons at fixed times.

    `lessons` maps a name to (start, end, weeks, room type), `weeks` being the
    requirement's own fields for them ({"periods": …, "recurrence": …} or {}).
    `grid` is the day (day_slots, days) for a class that splits its rooms by it.
    Returns the decisions by name and the RoomPlan.
    """
    from app.schemas.schedule import AnonymousRequirement
    from app.solver.room_allocator import add_room_allocation
    from app.solver.scheduler_solver import LessonDecision, LessonInstance

    decisions = {}
    for name, (start, end, weeks, room_type) in lessons.items():
        requirement = AnonymousRequirement.model_validate({
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": str(uuid4()),
            "lessonsPerWeek": 1, "minutesPerLesson": 15, "studentGroupSize": 10,
            **weeks, **({"requiredRoomType": room_type} if room_type else {}),
        })
        begin = model.NewIntVar(start, start, f"s_{name}")
        finish = model.NewIntVar(end, end, f"e_{name}")
        decisions[name] = LessonDecision(
            lesson=LessonInstance(requirement, 0), start=begin, duration=end - start,
            end=finish, interval=model.NewIntervalVar(begin, end - start, finish, f"i_{name}"),
            room_index=model.NewIntVar(0, len(rooms) - 1, f"r_{name}"),
        )
    plan = add_room_allocation(
        model, list(decisions.values()), rooms, distinguished_room_ids=set(),
        room_allowed=lambda room, requirement: requirement.required_room_type in (None, room.type),
        profile_key=lambda requirement: (requirement.required_room_type,),
        **grid,
    )
    return decisions, plan


def _runs_in(weeks: dict[str, object], period: int, parity: str) -> bool:
    """The oracle's reading of a lesson's own fields: does it run in this period and parity?"""
    periods = weeks.get("periods")
    return (periods is None or periods[period]) and weeks.get("recurrence") in (None, parity)  # type: ignore[index]


def _clashes(lessons, rooms_of, periods: int) -> list[tuple[str, str, int, str]]:  # type: ignore[no-untyped-def]
    """Two lessons in one room at one time in some real week: every such pair."""
    found = []
    names = list(lessons)
    for period in range(periods):
        for parity in (ODD, EVEN):
            for index, first in enumerate(names):
                for second in names[index + 1:]:
                    a, b = lessons[first], lessons[second]
                    if (
                        rooms_of[first] == rooms_of[second]
                        and a[0] < b[1] and b[0] < a[1]
                        and _runs_in(a[2], period, parity) and _runs_in(b[2], period, parity)
                    ):
                        found.append((first, second, period, parity))
    return found


def _every_assignment(lessons, rooms, periods: int) -> bool:  # type: ignore[no-untyped-def]
    """The oracle: is there any way at all to give each lesson a room it may take?"""
    import itertools

    names = list(lessons)
    allowed = [
        [index for index, room in enumerate(rooms) if lessons[name][3] in (None, room.type)]
        for name in names
    ]
    return any(
        not _clashes(lessons, dict(zip(names, choice)), periods)
        for choice in itertools.product(*allowed)
    )


def test_named_rooms_refuse_the_two_terms_no_room_assignment_holds() -> None:
    """room_allocator's counter-example with terms for weeks: each term fits two rooms, the year does not."""
    from ortools.sat.python import cp_model

    from app.schemas.schedule import AnonymousRoom

    rooms = [AnonymousRoom(id=uuid4(), capacity=30), AnonymousRoom(id=uuid4(), capacity=30)]
    autumn, spring = {"periods": AUTUMN}, {"periods": SPRING}
    lessons = {
        "a1": (0, 2, {}, None), "o1": (0, 5, autumn, None), "e1": (1, 3, spring, None),
        "e2": (2, 6, spring, None), "a2": (4, 6, {}, None),
    }

    def solve(names: list[str]) -> tuple[str, dict[str, int]]:
        model = cp_model.CpModel()
        chosen = {name: lessons[name] for name in names}
        decisions, plan = _allocator_alone(model, chosen, rooms)
        assert plan.named, "every-week lessons beside two terms': the rooms are named"
        solver = cp_model.CpSolver()
        status = solver.StatusName(solver.Solve(model))
        if status not in SOLVED:
            return status, {}
        rooms_by_key = plan.assign_rooms(solver)
        return status, {name: rooms_by_key[d.lesson.key()] for name, d in decisions.items()}

    assert not _every_assignment(lessons, rooms, 2)
    assert solve(list(lessons))[0] == "INFEASIBLE"
    status, room = solve(["a1", "o1", "e1", "e2"])
    assert status in SOLVED
    assert _clashes({name: lessons[name] for name in room}, room, 2) == []


def test_lessons_with_different_weeks_in_one_part_are_swept_together() -> None:
    """Three periods; everything in the pool runs in the first, so the pool is one part.

    A lesson of every week, two of the first period and one of the first two
    have four different sets of weeks and all meet in the first period: one
    cumulative, one sweep, and no two of them in one room at one time.
    """
    from ortools.sat.python import cp_model

    from app.schemas.schedule import AnonymousRoom

    rooms = [AnonymousRoom(id=uuid4(), capacity=30), AnonymousRoom(id=uuid4(), capacity=30)]
    first, first_two = {"periods": [True, False, False]}, {"periods": [True, True, False]}
    lessons = {
        "every": (0, 2, {}, None), "a1": (0, 2, first, None),
        "ab": (2, 4, first_two, None), "a2": (2, 4, first, None), "late": (4, 6, {}, None),
    }
    model = cp_model.CpModel()
    decisions, plan = _allocator_alone(model, lessons, rooms)
    assert plan.named == set() and len(plan.by_week) == 1
    assert len(set(plan.part_of.values())) == 1
    solver = cp_model.CpSolver()
    assert solver.StatusName(solver.Solve(model)) in SOLVED
    by_key = plan.assign_rooms(solver)
    room = {name: by_key[d.lesson.key()] for name, d in decisions.items()}
    assert _clashes(lessons, room, 3) == []
    # A third lesson of the first period at 0-2 is one room too many there.
    model = cp_model.CpModel()
    _allocator_alone(model, {**lessons, "a3": (0, 2, first, None)}, rooms)
    assert cp_model.CpSolver().StatusName(cp_model.CpSolver().Solve(model)) == "INFEASIBLE"


def test_the_allocator_admits_exactly_the_pools_that_have_a_room_assignment() -> None:
    """Random pools at fixed times, against every assignment there is.

    Two or three rooms, some of a kind of their own; four to seven lessons
    over two or three periods, with and without a parity. The allocator's
    model has a solution exactly when some assignment keeps every real week
    apart, and the rooms the post-pass hands out are such an assignment.
    """
    import random

    from ortools.sat.python import cp_model

    from app.schemas.schedule import AnonymousRoom

    rng = random.Random(2026)
    seen = {"solved": 0, "refused": 0, "named": 0, "by part": 0, "whole": 0}
    for _ in range(400):
        periods = rng.choice((2, 3))
        typed = rng.random() < 0.5
        rooms = [
            AnonymousRoom(id=uuid4(), capacity=30, type="SL" if typed and index < 2 else None)
            for index in range(rng.choice((2, 3)))
        ]

        def weeks() -> dict[str, object]:
            fields: dict[str, object] = {}
            if rng.random() < 0.6:
                while True:
                    mask = [rng.random() < 0.5 for _ in range(periods)]
                    if any(mask) and not all(mask):
                        fields["periods"] = mask
                        break
            if rng.random() < 0.25:
                fields["recurrence"] = rng.choice((ODD, EVEN))
            return fields

        lessons = {}
        for index in range(rng.randint(4, 7)):
            start = rng.randint(0, 4)
            lessons[f"l{index}"] = (
                start, start + rng.randint(1, 3), weeks(),
                "SL" if typed and rng.random() < 0.6 else None,
            )
        model = cp_model.CpModel()
        decisions, plan = _allocator_alone(model, lessons, rooms)
        solver = cp_model.CpSolver()
        status = solver.StatusName(solver.Solve(model))
        expected = _every_assignment(lessons, rooms, periods)
        assert (status in SOLVED) is expected, (lessons, [room.type for room in rooms], status)
        seen["named" if plan.named else "by part" if plan.by_week else "whole"] += 1
        if status in SOLVED:
            by_key = plan.assign_rooms(solver)
            room = {name: by_key[d.lesson.key()] for name, d in decisions.items()}
            assert _clashes(lessons, room, periods) == [], (lessons, room)
            for name, (_, _, _, room_type) in lessons.items():
                assert room_type in (None, rooms[room[name]].type)
            seen["solved"] += 1
        else:
            seen["refused"] += 1
    # Both ways a pool of several weeks is held were among them, and both answers.
    assert min(seen[key] for key in ("solved", "refused", "named", "by part")) >= 50, seen


def test_the_measured_daily_maximum_names_only_the_class_it_holds_back_in_a_real_week() -> None:
    """One day of four hours and a maximum of two a day.

    7A has two lessons all year and one of each term: three in every real
    week, which the maximum cannot hold. 7B has one all year and one of each
    term: two in every real week, though three lessons in all. The week is
    refused for the maximum, measured on a timetable without it, and the line
    names 7A alone — a count across the terms would name 7B beside it.
    """
    a, b = str(uuid4()), str(uuid4())
    payload = _payload(
        [_requirement(a, 2), _requirement(a, 1, periods=AUTUMN), _requirement(a, 1, periods=SPRING),
         _requirement(b, 1), _requirement(b, 1, periods=AUTUMN), _requirement(b, 1, periods=SPRING)],
        rules={"maxLessonsPerDayPerGroup": 2},
    )
    response = _solve(payload)
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    lines = [
        line for line in response.conflicts.conflicts
        if line.code == "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"
    ]
    assert len(lines) == 1 and lines[0].params["measured"] == 1
    assert lines[0].resource_ids == [UUID(a)]
    # With room for three a day both classes are laid, term by term.
    payload["rules"] = {"maxLessonsPerDayPerGroup": 3}
    assert _solve(payload).status in SOLVED


@pytest.mark.parametrize(
    ("lock_start", "lock_end", "lesson_start"),
    [
        ("08:00:00", "09:00:00", "09:00:00"),  # a lock inside the day's hours
        ("07:00:00", "08:00:00", "08:00:00"),  # and one before they open
    ],
)
def test_no_walk_from_a_lock_of_the_autumn_to_a_lesson_of_the_spring(
    lock_start: str, lock_end: str, lesson_start: str,
) -> None:
    """One teacher, locked on the far site in the autumn, teaching on the near one right after in the spring."""
    teacher, group = str(uuid4()), str(uuid4())
    near, far = str(uuid4()), str(uuid4())
    far_room = str(uuid4())
    rooms = [
        {"id": str(uuid4()), "capacity": 30, "type": "near", "siteId": near},
        {"id": far_room, "capacity": 30, "type": "far", "siteId": far},
    ]
    lock = {"id": str(uuid4()), "teacherId": teacher, "studentGroupId": str(uuid4()), "roomId": far_room,
            "dayOfWeek": 1, "startTime": lock_start, "endTime": lock_end, "periods": AUTUMN}
    # The class can only be taught the hour right after the lock.
    closed = [
        ab._closed("STUDENT_GROUP", group, 1, "00:00:00", lesson_start),
        ab._closed("STUDENT_GROUP", group, 1, f"{int(lesson_start[:2]) + 1:02d}:00:00", "23:59:00"),
    ]
    payload = _payload(
        [_requirement(group, 1, teacher=teacher, periods=SPRING, requiredRoomType="near")],
        rooms=rooms, fixedLessons=[lock], constraints=closed,
        siteTravelTimes=[{"siteAId": near, "siteBId": far, "minutes": 30}],
    )
    settings = _settings(hours=2)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert [lesson.start_time for lesson in response.lessons] == [lesson_start]
    assert _validate(payload, response.lessons, settings) == []
    # In the same term the thirty minutes are owed, and the hour has none.
    payload["requirements"][0]["periods"] = AUTUMN  # type: ignore[index]
    assert _solve(payload, settings).status == "INFEASIBLE"


# ---------------------------------------------------------------------------
# Locks of a term beside lessons of every week
# ---------------------------------------------------------------------------


def test_a_lock_of_the_autumn_answers_the_autumns_rast_and_not_the_springs() -> None:
    """The class's own lessons run all year; what differs between the terms is a lock.

    One day, 08:00-11:20, a rast at 09:00 that asks for a lesson before it.
    7A is locked 08:00-09:00 in the autumn and has two lessons of every week.
    The autumn's rast is answered by the lock, so both lessons may come after
    it; the spring's needs one of them at 08:00 — where the autumn has the
    lock. No timetable keeps both terms. Read with the lock in every week it
    would be solved, and the spring left at its break untaught.
    """
    group = str(uuid4())
    years = {"minGradeLevel": 7, "maxGradeLevel": 7}
    lock = {"id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": group, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00", "periods": AUTUMN}
    payload = _payload(
        [_requirement(group, 2, **years)], fixedLessons=[lock],
        rasts=[{"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "09:00:00",
                "endTime": "09:20:00", "requiresLessonBefore": True}],
    )
    settings = Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=680,
    )
    assert _solve(payload, settings).status == "INFEASIBLE"
    # The lock all year answers every week's rast.
    assert _solve(_all_year(payload), settings).status in SOLVED
    # And with a third hour after the break the spring can open at 08:00... in the
    # autumn too, were the lock not there: still no timetable, for the same reason.
    payload["requirements"][0]["lessonsPerWeek"] = 1  # type: ignore[index]
    assert _solve(payload, settings).status == "INFEASIBLE"


def test_a_teachers_cap_reads_the_locks_of_each_term_beside_lessons_of_every_week() -> None:
    """A cap of 120 minutes a day; a lock of an hour in each term, and one lesson all year.

    Each term has the lesson and its own lock: 120 minutes. All three in one
    week would be 180, and the lesson's every-week row is what would count
    them so.
    """
    teacher = str(uuid4())

    def lock(start: str, end: str, periods: list[bool]) -> dict[str, object]:
        return {"id": str(uuid4()), "teacherId": teacher, "studentGroupId": str(uuid4()),
                "dayOfWeek": 1, "startTime": start, "endTime": end, "periods": periods}

    payload = _payload(
        [_requirement(str(uuid4()), 1, teacher=teacher)],
        fixedLessons=[lock("08:00:00", "09:00:00", AUTUMN), lock("09:00:00", "10:00:00", SPRING)],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 120}],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons) == []
    # Both locks all year leave the lesson no minute of the cap.
    with pytest.raises(InvalidScheduleInputError):
        _solve(_all_year(payload))


def test_a_teachers_rest_reads_the_locks_of_each_term_beside_lessons_of_every_week() -> None:
    """An autumn lock Monday 19-20, a spring lock Tuesday 08-09, a rest of 13 hours, a lesson all year.

    No week has both locks, so no night is twelve hours. The lesson is on
    Monday at noon in both terms, which is what makes Monday a day the rest
    rule reads.
    """
    teacher, group = str(uuid4()), str(uuid4())

    def lock(day: int, start: str, end: str, periods: list[bool]) -> dict[str, object]:
        return {"id": str(uuid4()), "teacherId": teacher, "studentGroupId": str(uuid4()),
                "dayOfWeek": day, "startTime": start, "endTime": end, "periods": periods}

    payload = _payload(
        [_requirement(group, 1, teacher=teacher)],
        constraints=[ab._closed("STUDENT_GROUP", group, 1, "00:00:00", "12:00:00"),
                     ab._closed("STUDENT_GROUP", group, 1, "13:00:00", "23:59:00"),
                     ab._closed("STUDENT_GROUP", group, 2, "00:00:00", "23:59:00")],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "minDailyRestMinutes": 780}],
        fixedLessons=[lock(1, "19:00:00", "20:00:00", AUTUMN), lock(2, "08:00:00", "09:00:00", SPRING)],
    )
    settings = _settings(hours=12, days="1,2")
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _solve(_all_year(payload), settings).status == "INFEASIBLE"


def test_a_subject_of_the_autumn_is_held_to_its_edge_in_the_autumn_only() -> None:
    """Idrott in the autumn, not first: its row is the autumn's, and the spring has none for it.

    The autumn has svenska before idrott. The spring's only lesson can only
    come after the hour idrott has — were idrott's row posted in the spring
    as well, nothing would stand before it there, and the week would be
    refused for a lesson the spring does not have.
    """
    idrott, group = str(uuid4()), str(uuid4())
    teacher, late = str(uuid4()), str(uuid4())
    requirements = [
        test_placement._requirement(idrott, group, teacher=teacher, periods=AUTUMN),
        test_placement._requirement(str(uuid4()), group, periods=AUTUMN),
        test_placement._requirement(str(uuid4()), group, teacher=late, periods=SPRING),
    ]
    payload = test_placement._payload(
        requirements,
        constraints=[
            # Idrott at 09:00 and nowhere else; the spring's lesson only from 10:00.
            ab._closed("TEACHER", teacher, 1, "00:00:00", "09:00:00"),
            ab._closed("TEACHER", teacher, 1, "10:00:00", "23:59:00"),
            ab._closed("TEACHER", late, 1, "00:00:00", "10:00:00"),
        ],
        placementRules=test_placement._edges("HARD", (idrott, True, False)),
    )
    settings = test_placement._settings(day_end=660)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    starts = {str(lesson.requirement_id): lesson.start_time for lesson in response.lessons}
    assert starts[str(requirements[0]["id"])] == "09:00:00"
    assert starts[str(requirements[1]["id"])] == "08:00:00"
    # Idrott all year has a spring too, and nothing before it there.
    del requirements[0]["periods"]
    refused = _solve(payload, settings)
    assert refused.status == "INFEASIBLE"
    assert refused.conflicts is not None
    assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in {line.code for line in refused.conflicts.conflicts}


def test_a_class_is_in_one_kind_of_room_a_day_in_each_term() -> None:
    """At most one room group a day: the autumn's lesson in the gym, the spring's in the art room."""
    group = str(uuid4())
    rooms = [{"id": str(uuid4()), "capacity": 30, "type": "GYM"}, {"id": str(uuid4()), "capacity": 30, "type": "ART"}]
    requirements = [
        test_placement._requirement(str(uuid4()), group, requiredRoomType="GYM", periods=AUTUMN),
        test_placement._requirement(str(uuid4()), group, requiredRoomType="ART", periods=SPRING),
    ]
    payload = {
        **test_placement._payload(requirements), "rooms": rooms,
        "placementRules": {"places": {"mode": "HARD", "maxClassRooms": 1}},
    }
    settings = test_placement._settings(day_end=660)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    # Both all year are two kinds of room on the week's one day.
    with pytest.raises(InvalidScheduleInputError):
        _solve(_all_year(payload), settings)


def test_the_pupils_idle_time_is_priced_by_each_terms_share_of_the_year() -> None:
    """The objective's own figures: a period of ten weeks and one of thirty, for twenty pupils."""
    group = str(uuid4())
    payload = _payload(
        [_requirement(group, 2), _requirement(group, 1, periods=AUTUMN), _requirement(group, 1, periods=SPRING)],
        periodWeeks=[10, 30],
        pupilGaps={"cohorts": [{"groupIds": [group], "pupils": 20, "homeGroupId": group}]},
    )
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings(hours=6))
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    proto = model.Proto()
    priced = {
        proto.variables[index].name: coefficient
        for index, coefficient in zip(proto.objective.vars, proto.objective.coeffs)
        if proto.variables[index].name.endswith("_idle")
    }
    autumn = [coefficient for name, coefficient in priced.items() if "_p0_" in name]
    spring = [coefficient for name, coefficient in priced.items() if "_p1_" in name]
    assert autumn and spring
    # One part of four and three parts of four, the same pupils in both.
    assert {3 * coefficient for coefficient in autumn} == set(spring)


def test_a_week_more_is_a_week_more_in_the_size_estimate() -> None:
    """What the estimate adds for the weeks grows with them, and bounds the model at every count."""
    teacher, group = str(uuid4()), str(uuid4())
    solver = SchedulerSolver(_settings(hours=6, days="1,2,3"))
    added = []
    for periods in (2, 3, 4, 6):
        terms = [
            _requirement(group, 1, teacher=teacher, periods=[p == q for q in range(periods)])
            for p in range(periods)
        ]
        payload = _payload(
            [_requirement(group, 2, teacher=teacher), *terms],
            rules={"maxLessonsPerDayPerGroup": 2},
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher,
                               "maxTeachingMinutesPerDay": 180, "minDailyRestMinutes": 600}],
            teacherDayLimits=[{"id": str(uuid4()), "teacherId": teacher,
                               "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[]]}],
            rasts=[{"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "10:00:00",
                    "endTime": "10:20:00", "requiresLessonBefore": True}],
        )
        request = OptimizeScheduleRequest.model_validate(payload)
        for include_objective in (False, True):
            model, *_ = solver._build_model(
                request, use_assumptions=False, include_objective=include_objective,
            )
            assert solver._estimate_model_size(request) >= len(model.Proto().variables)
        lessons = {UUID(teacher): 2 + periods, UUID(group): 2 + periods}
        # Less the rooms the pool names, which grow with its lessons and not with its weeks.
        added.append(solver._week_vars(request, lessons, lessons) - solver._named_room_vars(request))
    # The same teacher and class at every count: each week past the first adds the same again.
    per_week = added[0]
    assert per_week > 0
    assert added == [per_week * more for more in (1, 2, 3, 5)]


def test_a_teachers_stretch_is_measured_in_each_term_under_its_own_name() -> None:
    teacher = str(uuid4())
    payload = _payload(
        [_requirement(str(uuid4()), 2, teacher=teacher),
         _requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN),
         _requirement(str(uuid4()), 1, teacher=teacher, periods=SPRING)],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher,
                           "maxConsecutiveTeachingMinutes": 120, "consecutiveBreakMinutes": 30}],
    )
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings(hours=6))
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    names = {variable.name for variable in model.Proto().variables}
    assert any(name.startswith(f"stretchs_{teacher}_p0_") for name in names)
    assert any(name.startswith(f"stretchs_{teacher}_p1_") for name in names)
    assert not any(name.startswith(f"stretchs_{teacher}_0") for name in names)


def test_a_pool_names_its_rooms_only_where_a_lesson_is_in_two_parts() -> None:
    from app.solver.room_allocator import mixes
    from app.solver.weeks import EVEN_WEEKS, ODD_WEEKS

    autumn, spring = Weeks(0b0011, 2), Weeks(0b1100, 2)
    assert not mixes([None, None])
    # Every lesson in one part: every-week lessons beside the autumn's, or two terms alone.
    assert not mixes([None, autumn, autumn])
    assert not mixes([autumn, spring, spring])
    # Every-week lessons beside two terms' are in both parts.
    assert mixes([None, autumn, spring])
    # A POOL WITHOUT PERIODS KEEPS THE READING IT HAD: every-week beside odd
    # ones names its rooms, as it always did, though they too are one part.
    assert mixes([None, ODD_WEEKS])
    assert mixes([None, ODD_WEEKS, EVEN_WEEKS])
    assert not mixes([ODD_WEEKS, EVEN_WEEKS])
    # A parity beside a period is read with the periods.
    assert not mixes([None, Weeks(0b0001, 2)])
    assert mixes([None, Weeks(0b0001, 2), Weeks(0b0010, 2)])


def test_only_a_large_mixed_class_with_periods_splits_its_rooms() -> None:
    from app.solver.room_allocator import NAMED_LIMIT, splits
    from app.solver.weeks import EVEN_WEEKS, ODD_WEEKS

    autumn, spring = Weeks(0b0011, 2), Weeks(0b1100, 2)
    pool = [None] * 400 + [autumn, spring]
    # Thirty classrooms and four hundred lessons that fit them: far past the limit.
    assert 30 * len(pool) > NAMED_LIMIT and splits(pool, 30, 96)
    # Two workshops and the same lessons are named, exactly.
    assert 2 * len(pool) <= NAMED_LIMIT and not splits(pool, 2, 96)
    assert splits(pool, 5, 96) and not splits(pool, 4, 96)
    # Without the grid's day there is nothing to split by.
    assert not splits(pool, 30, None)
    # A POOL WITHOUT PERIODS KEEPS ITS NAMED ROOMS WHATEVER ITS SIZE: its model is the one it was.
    assert not splits([None] * 400 + [ODD_WEEKS, EVEN_WEEKS], 30, 96)


# ---------------------------------------------------------------------------
# A large mixed class splits its rooms by day
# ---------------------------------------------------------------------------


def test_a_large_mixed_class_splits_its_rooms_by_day_and_names_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three classrooms; lessons all year beside two terms' in them, through solve().

    Made large by lowering the limit, so the classrooms split: no literal per
    lesson and room, a variable a day, and a timetable every real week keeps.
    """
    from app.solver import room_allocator

    rooms = [{"id": str(uuid4()), "capacity": 30} for _ in range(3)]
    requirements = [
        *[_requirement(str(uuid4()), 2) for _ in range(4)],
        *[_requirement(str(uuid4()), 2, periods=AUTUMN) for _ in range(2)],
        *[_requirement(str(uuid4()), 2, periods=SPRING) for _ in range(2)],
    ]
    payload = _payload(requirements, rooms=rooms)
    settings = _settings(hours=4, days="1,2")
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(settings)

    _, _, _, named, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    assert len(named.named) == 1 and named.split == {}
    literals = sum(len(rooms_of) for rooms_of in named.rooms_of.values())
    assert literals == 3 * 16

    monkeypatch.setattr(room_allocator, "NAMED_LIMIT", literals - 1)
    model, _, _, plan, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    assert plan.named == set() and plan.rooms_of == {}
    (term_rooms, day_slots), = plan.split.values()
    assert len(term_rooms) == 2 and day_slots == solver._grid.slots_per_day
    # Each term's lessons are in their part, the all-year ones in neither.
    assert sorted(str(week) for week in plan.part_of.values()) == ["p0"] * 4 + ["p1"] * 4
    assert solver._estimate_model_size(request) >= len(model.Proto().variables)
    response = solver.solve(request)
    assert response.status in SOLVED
    assert len(response.lessons) == 16
    assert _validate(payload, response.lessons, settings) == []
    # Twenty-four room-hours a week. The all-year lessons take eight and each
    # term four: sixteen even with both terms in every week.
    assert _solve(_all_year(payload), settings).status in SOLVED
    # Fourteen hours more in the autumn are twenty-six there: no room for them.
    requirements.extend(_requirement(str(uuid4()), 2, periods=AUTUMN) for _ in range(7))
    assert _solve(_payload(requirements, rooms=rooms), settings).status == "INFEASIBLE"


def test_the_split_gives_a_room_to_the_term_or_to_the_others_for_a_whole_day() -> None:
    """What the split costs, on the allocator alone: two rooms, both needed by the all-year lessons at 0-2.

    A lesson of the autumn at 3-4 has a room in fact — both are free by then.
    Named, the class says so. Split, a room would have to be the term's for
    the day, and the all-year lessons need both that morning: refused. Sound
    and not exact, which is why only a class too large to name is split.
    """
    from ortools.sat.python import cp_model

    from app.schemas.schedule import AnonymousRoom
    from app.solver import room_allocator

    rooms = [AnonymousRoom(id=uuid4(), capacity=30), AnonymousRoom(id=uuid4(), capacity=30)]
    lessons = {
        "a1": (0, 2, {}, None), "a2": (0, 2, {}, None),
        "d1": (3, 4, {"periods": AUTUMN}, None), "d2": (3, 4, {"periods": SPRING}, None),
    }
    assert _every_assignment(lessons, rooms, 2)

    def status(limit: int) -> str:
        model = cp_model.CpModel()
        saved, room_allocator.NAMED_LIMIT = room_allocator.NAMED_LIMIT, limit
        try:
            _, plan = _allocator_alone(model, lessons, rooms, day_slots=8, days=1)
        finally:
            room_allocator.NAMED_LIMIT = saved
        assert bool(plan.split) is (limit == 0) and bool(plan.named) is (limit != 0)
        return cp_model.CpSolver().StatusName(cp_model.CpSolver().Solve(model))

    assert status(room_allocator.NAMED_LIMIT) in SOLVED
    assert status(0) == "INFEASIBLE"
    # With the all-year lessons one after the other, one room is theirs and one the terms'.
    lessons["a2"] = (2, 4, {}, None)
    assert status(0) in SOLVED


def test_a_split_class_never_admits_a_pool_without_a_room_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Random pools over two days, every mixed class split: sound against every assignment there is.

    Whatever the split admits has an assignment that keeps every real week
    apart, and the rooms the post-pass hands out are one. It refuses some
    pools that have one — the day's grain — and those are counted, not hidden.
    """
    import random

    from ortools.sat.python import cp_model

    from app.schemas.schedule import AnonymousRoom
    from app.solver import room_allocator

    monkeypatch.setattr(room_allocator, "NAMED_LIMIT", 0)
    rng = random.Random(1111)
    seen = {"split": 0, "solved": 0, "refused though one exists": 0, "refused, none exists": 0}
    for _ in range(500):
        periods = rng.choice((2, 3))
        rooms = [AnonymousRoom(id=uuid4(), capacity=30) for _ in range(rng.choice((2, 3)))]
        lessons = {}
        for index in range(rng.randint(4, 7)):
            fields: dict[str, object] = {}
            if rng.random() < 0.6:
                while True:
                    mask = [rng.random() < 0.5 for _ in range(periods)]
                    if any(mask) and not all(mask):
                        fields["periods"] = mask
                        break
            if rng.random() < 0.2:
                fields["recurrence"] = rng.choice((ODD, EVEN))
            start = 8 * rng.randint(0, 1) + rng.randint(0, 4)
            lessons[f"l{index}"] = (start, start + rng.randint(1, 3), fields, None)
        model = cp_model.CpModel()
        decisions, plan = _allocator_alone(model, lessons, rooms, day_slots=8, days=2)
        if not plan.split:
            # No mixed class, or one of parities alone, which keeps its named rooms.
            continue
        seen["split"] += 1
        solver = cp_model.CpSolver()
        status = solver.StatusName(solver.Solve(model))
        exists = _every_assignment(lessons, rooms, periods)
        if status in SOLVED:
            assert exists, (lessons, len(rooms))
            by_key = plan.assign_rooms(solver)
            room = {name: by_key[d.lesson.key()] for name, d in decisions.items()}
            assert _clashes(lessons, room, periods) == [], (lessons, room)
            seen["solved"] += 1
        else:
            seen["refused though one exists" if exists else "refused, none exists"] += 1
    assert seen["split"] > 200 and seen["solved"] > 100 and seen["refused, none exists"] > 20, seen
    # The cost of the day's grain on pools this tight (four to seven lessons on
    # two or three rooms): a minority, and never the other way round.
    assert 0 < seen["refused though one exists"] < seen["solved"], seen
