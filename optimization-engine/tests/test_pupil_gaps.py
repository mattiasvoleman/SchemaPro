"""Elevernas håltimmar: the count, the objective, and the payload without them.

THE COUNT is pinned to src/common/__fixtures__/pupil-gaps-cases.json, which the
web replays through findIdleGaps (web/lib/gaps.contract.test.ts) and the
gateway through the cohorts it derives (src/optimization/pupil-cohorts.spec.ts).
Every case's number is worked out by hand in its `why`.

THE OBJECTIVE is asserted on its value for lessons pinned where a test says,
as test_idle_time.py asserts the teachers' — where the lessons land is the
solver's taste, what the term is for is which of two days costs more — and on
whole solves only where the week leaves the solver one honest answer.
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest, ScheduledLesson
from app.solver.pupil_gaps import (
    MINIMUM_GAP_MINUTES,
    PUPIL_GAP_SCALE,
    SlotGrid,
    day_idle_minutes,
    estimate_variables,
    pupil_idle_minutes,
)
from app.solver.scheduler_solver import SchedulerSolver, _TeacherDayLiterals

FIXTURE = (
    Path(__file__).resolve().parents[2] / "src" / "common" / "__fixtures__" / "pupil-gaps-cases.json"
)
CASES = json.loads(FIXTURE.read_text())["cases"]


class _Ids(dict):
    """A readable fixture name -> a uuid4 of its own, stable within one case."""

    def __missing__(self, name: str) -> str:
        self[name] = str(uuid4())
        return self[name]


def _engine_payload(case: dict[str, object]) -> tuple[OptimizeScheduleRequest, list[ScheduledLesson]]:
    """The case's engine form as a request and the timetable laid for it."""
    ids = _Ids()
    engine = case["engine"]
    years = {group["id"]: group["years"] for group in case["groups"]}

    def span(group: str) -> dict[str, int]:
        low, high = years.get(group, (None, None))
        return {"minGradeLevel": low, "maxGradeLevel": high} if low is not None else {}

    lessons_of: dict[str, int] = {}
    for lesson in engine["lessons"]:
        lessons_of[lesson["requirement"]] = lessons_of.get(lesson["requirement"], 0) + 1
    requirements = []
    for requirement in engine["requirements"]:
        entry = {
            "id": ids[requirement["id"]],
            "subjectId": ids["subject"],
            "studentGroupId": ids[requirement["group"]],
            "lessonsPerWeek": max(1, lessons_of.get(requirement["id"], 0)),
            "minutesPerLesson": 60,
            "minutesBefore": requirement["minutesBefore"],
            "minutesAfter": requirement["minutesAfter"],
            **span(requirement["group"]),
        }
        if requirement["pupilKey"] != requirement["group"]:
            entry["pupilGroupId"] = ids[requirement["pupilKey"]]
        requirements.append(entry)
    constraints = [
        {
            "id": str(uuid4()),
            "resourceKind": rule["kind"],
            "resourceId": ids[rule["group"]] if rule["group"] else None,
            "minGradeLevel": rule["min"],
            "maxGradeLevel": rule["max"],
            "dayOfWeek": rule["day"],
            "date": None,
            "startTime": f"{rule['start']}:00",
            "endTime": f"{rule['end']}:00",
            "kind": "UNAVAILABLE",
        }
        for rule in case["constraints"]
    ]
    payload = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [
            {"id": ids[group["id"]], "lunchHeadcount": 1, **span(group["id"])}
            for group in case["groups"]
            if group["kind"] == "CLASS"
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": constraints,
        "frameTimes": [
            {
                "minGradeLevel": frame["min"],
                "maxGradeLevel": frame["max"],
                "dayOfWeek": frame["day"],
                "startTime": f"{frame['start']}:00",
                "endTime": f"{frame['end']}:00",
            }
            for frame in case["frames"]
        ],
        "fixedLessons": [
            {
                "id": ids[fixed["id"]],
                "studentGroupId": ids[fixed["groups"][0]],
                "extraGroupIds": [ids[group] for group in fixed["groups"][1:]],
                "dayOfWeek": fixed["day"],
                "startTime": f"{fixed['start']}:00",
                "endTime": f"{fixed['end']}:00",
            }
            for fixed in engine["fixedLessons"]
        ],
        "pupilGaps": {
            "cohorts": [
                {
                    "groupIds": [ids[key] for key in cohort["groupIds"]],
                    "fixedLessonIds": [ids[key] for key in cohort["fixedLessonIds"]],
                    "homeGroupId": ids[cohort["home"]],
                    "pupils": cohort["pupils"],
                }
                for cohort in engine["cohorts"]
            ],
            "fixedMargins": [
                {
                    "fixedLessonId": ids[margin["fixedLesson"]],
                    "minutesBefore": margin["minutesBefore"],
                    "minutesAfter": margin["minutesAfter"],
                }
                for margin in engine["fixedMargins"]
            ],
        },
    }
    lunch = case["lunch"]
    if lunch is not None:
        payload["rules"] = {
            "lunchStartTime": f"{lunch['start']}:00",
            "lunchEndTime": f"{lunch['end']}:00",
            "lunchMinutes": lunch["minutes"],
        }
    lessons = [
        ScheduledLesson.model_validate({
            "requirementId": ids[lesson["requirement"]],
            "dayOfWeek": lesson["day"],
            "startTime": f"{lesson['start']}:00",
            "endTime": f"{lesson['end']}:00",
        })
        for lesson in engine["lessons"]
    ]
    return OptimizeScheduleRequest.model_validate(payload), lessons


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_count_is_the_reports(case: dict[str, object]) -> None:
    request, lessons = _engine_payload(case)
    assert pupil_idle_minutes(request, lessons) == case["pupilIdleMinutes"], case["why"]


def test_the_fixture_reaches_every_rule_of_the_count() -> None:
    """A case per reading, so a rule the count forgot fails a case of its own."""
    names = {case["name"] for case in CASES}
    assert len(names) == len(CASES)
    assert any(case["lunch"] for case in CASES)
    assert any(case["buffers"] for case in CASES)
    assert any(case["frames"] for case in CASES)
    assert any(case["engine"]["fixedMargins"] for case in CASES)
    assert {rule["kind"] for case in CASES for rule in case["constraints"]} == {
        "STUDENT_GROUP", "GRADE_LEVEL",
    }
    assert any(group["replacesSubjectId"] for case in CASES for group in case["groups"])
    assert any(group["halfOfId"] for case in CASES for group in case["groups"])
    assert any(lesson["pupils"] for case in CASES for lesson in case["lessons"])


def test_no_pupil_gaps_no_count() -> None:
    request, lessons = _engine_payload(CASES[1])
    without = request.model_copy(update={"pupil_gaps": None})
    assert pupil_idle_minutes(without, lessons) is None


@pytest.mark.parametrize(
    ("hole", "lunch", "idle"),
    [
        # The minimum is inclusive: fifteen minutes is a håltimme.
        ((600, 600 + MINIMUM_GAP_MINUTES), None, MINIMUM_GAP_MINUTES),
        ((600, 600 + MINIMUM_GAP_MINUTES - 5), None, 0),
        # The lunch makes a hole a rast when what is left is short of it.
        ((660, 700), (660, 780, 30), 0),
        ((660, 705), (660, 780, 30), 15),
        # A hole outside the window gets no lunch.
        ((600, 640), (660, 780, 30), 40),
    ],
)
def test_one_hole(hole: tuple[int, int], lunch: tuple[int, int, int] | None, idle: int) -> None:
    lessons = [(480, hole[0]), (hole[1], hole[1] + 60)]
    assert day_idle_minutes(lessons, [], lunch) == idle


# ---------------------------------------------------------------------------
# The objective
# ---------------------------------------------------------------------------

CLASS = str(uuid4())
TY = str(uuid4())
TEACHERS = [str(uuid4()) for _ in range(3)]


def _week(*, pupil_gaps: bool, lunch: bool = False, ty_teacher_free: str | None = None) -> dict[str, object]:
    """One day: 7A has four lessons, Ty7 (ten of its 25) one.

    `ty_teacher_free` closes Ty7's teacher at every hour but the one named,
    so the språkval hour is the school's, not the solver's, choice.
    """
    requirements = [
        {
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": CLASS,
            "teacherId": TEACHERS[index], "lessonsPerWeek": 2, "minutesPerLesson": 60,
            "studentGroupSize": 25, "minGradeLevel": 7, "maxGradeLevel": 7,
        }
        for index in range(2)
    ] + [
        {
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": TY,
            "teacherId": TEACHERS[2], "lessonsPerWeek": 1, "minutesPerLesson": 60,
            "studentGroupSize": 10, "minGradeLevel": 7, "maxGradeLevel": 7,
        },
    ]
    constraints = []
    if ty_teacher_free is not None:
        hour = int(ty_teacher_free[:2])
        for start, end in ((8, hour), (hour + 1, 15)):
            if end > start:
                constraints.append({
                    "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": TEACHERS[2],
                    "dayOfWeek": 1, "date": None, "kind": "UNAVAILABLE",
                    "startTime": f"{start:02d}:00:00", "endTime": f"{end:02d}:00:00",
                })
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [{"id": CLASS, "lunchHeadcount": 25, "minGradeLevel": 7, "maxGradeLevel": 7}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "groupConflicts": [[CLASS, TY]],
        "constraints": constraints,
        "frameTimes": [{
            "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
            "startTime": "08:00:00", "endTime": "15:00:00",
        }],
    }
    if lunch:
        payload["rules"] = {
            "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00", "lunchMinutes": 30,
        }
    if pupil_gaps:
        payload["pupilGaps"] = {"cohorts": [
            {"groupIds": [CLASS, TY], "pupils": 10, "homeGroupId": CLASS},
            {"groupIds": [CLASS], "pupils": 15, "homeGroupId": CLASS},
        ]}
    return payload


def _solver(**overrides: object) -> SchedulerSolver:
    return SchedulerSolver(Settings(
        SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1", **overrides,  # type: ignore[arg-type]
    ))


def _pupil_term(payload: dict[str, object], starts: list[int]) -> float:
    """The pupils' term alone, in pupil-slots, for lessons pinned at these minutes.

    Nothing else in the objective: the value is this term's own opinion. The
    starts are minutes from midnight, one per lesson in _create_lesson_decisions'
    order.
    """
    solver = _solver()
    request = OptimizeScheduleRequest.model_validate(payload)
    model = cp_model.CpModel()
    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts, step=1,
    )
    assert len(decisions) == len(starts)
    terms = solver._add_pupil_gap_objective(
        model, request, decisions, {}, _TeacherDayLiterals(), {},
    )
    grid = solver._grid
    for decision, minutes in zip(decisions, starts):
        model.Add(decision.start == (minutes - grid.day_start_minutes) // grid.slot_minutes)
    model.Minimize(sum(terms) if terms else 0)
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = 10.0
    assert cp.Solve(model) == cp_model.OPTIMAL
    return cp.ObjectiveValue() / solver._settings.weight_pupil_gap


def test_the_term_is_the_cohorts_own_day() -> None:
    """Ty7 at 10:00 between 7A's lessons: the fifteen outside it wait an hour.

    Twelve slots for fifteen pupils, and nothing for the ten who are taught —
    which a per-group term could not tell apart: it would see 7A busy at 10:00.
    """
    payload = _week(pupil_gaps=True)
    middle = [8 * 60, 9 * 60, 11 * 60, 12 * 60, 10 * 60]
    edge = [8 * 60, 9 * 60, 10 * 60, 11 * 60, 12 * 60]
    assert _pupil_term(payload, middle) == 15 * 12
    assert _pupil_term(payload, edge) == 0


def test_the_term_counts_what_the_count_counts_where_they_agree() -> None:
    """Pinned weeks without short holes or lunch: the term is the count in slots."""
    payload = _week(pupil_gaps=True)
    request = OptimizeScheduleRequest.model_validate(payload)
    ids = [requirement.id for requirement in request.requirements]
    for starts in (
        [8 * 60, 9 * 60, 11 * 60, 12 * 60, 10 * 60],
        [8 * 60, 10 * 60, 12 * 60, 13 * 60, 9 * 60],
        [8 * 60, 9 * 60, 13 * 60, 14 * 60, 11 * 60],
    ):
        owners = [ids[0], ids[0], ids[1], ids[1], ids[2]]
        lessons = [
            ScheduledLesson.model_validate({
                "requirementId": owner, "dayOfWeek": 1,
                "startTime": f"{minutes // 60:02d}:{minutes % 60:02d}:00",
                "endTime": f"{minutes // 60 + 1:02d}:{minutes % 60:02d}:00",
            })
            for owner, minutes in zip(owners, starts)
        ]
        assert _pupil_term(payload, starts) * 5 == pupil_idle_minutes(request, lessons)


def test_off_builds_none_of_it() -> None:
    """No pupilGaps, no term — and a weight of zero switches it off as well."""
    assert _pupil_term(_week(pupil_gaps=False), [480, 540, 600, 660, 720]) == 0
    request = OptimizeScheduleRequest.model_validate(_week(pupil_gaps=True))
    model = cp_model.CpModel()
    solver = _solver(WEIGHT_PUPIL_GAP=0)
    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms), request.frame_times, request.rasts, step=1,
    )
    before = len(model.Proto().variables)
    assert solver._add_pupil_gap_objective(
        model, request, decisions, {}, _TeacherDayLiterals(), {},
    ) == []
    assert len(model.Proto().variables) == before


def test_the_generator_keeps_the_hour_at_the_edge() -> None:
    """Ty7's teacher is free at 10:00 only: on, 7A's day starts at 11:00 for nobody to wait.

    The ten in Ty7 have 10:00 and then 7A from 11:00; the fifteen start at
    11:00. Off, nothing stops 7A's lessons sitting around the hour. The
    response's number is the count's, and zero only on.
    """
    on = _solver().solve(OptimizeScheduleRequest.model_validate(
        _week(pupil_gaps=True, ty_teacher_free="10:00"),
    ))
    assert on.status in {"OPTIMAL", "FEASIBLE"}
    assert on.pupil_idle_minutes == 0
    off = _solver().solve(OptimizeScheduleRequest.model_validate(
        _week(pupil_gaps=False, ty_teacher_free="10:00"),
    ))
    assert off.pupil_idle_minutes is None
    assert "pupilIdleMinutes" not in json.loads(off.model_dump_json(by_alias=True))


def test_the_lunch_inside_the_day_is_not_idle() -> None:
    """A lunch between lessons is credited; the same minutes empty are a hole."""
    payload = _week(pupil_gaps=True, lunch=True)
    response = _solver().solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert response.pupil_idle_minutes == 0
    lunch = next(lunch for lunch in response.lunches)
    starts = sorted(lesson.start_time for lesson in response.lessons)
    # The class has lessons on both sides of its meal: the day spans it.
    assert starts[0] < lunch.start_time < starts[-1]


def test_the_rest_of_the_objective_is_scaled_beside_it() -> None:
    """On, every other term is PUPIL_GAP_SCALE times what it was; off, as it was."""
    request = OptimizeScheduleRequest.model_validate(_week(pupil_gaps=True))
    solver = _solver()
    model, *_ = solver._build_model(request, use_assumptions=False)
    off_model, *_ = solver._build_model(
        request.model_copy(update={"pupil_gaps": None}), use_assumptions=False,
    )
    on_coeffs = dict(zip(model.Proto().objective.vars, model.Proto().objective.coeffs))
    off_coeffs = dict(zip(off_model.Proto().objective.vars, off_model.Proto().objective.coeffs))
    assert off_coeffs
    for variable, coefficient in off_coeffs.items():
        assert on_coeffs[variable] == PUPIL_GAP_SCALE * coefficient


def _halves_payload() -> dict[str, object]:
    """7A, its two halves with one lesson each, and one pupil placed in neither."""
    half_a, half_b = str(uuid4()), str(uuid4())
    requirement = lambda group, teacher: {  # noqa: E731
        "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
        "teacherId": teacher, "lessonsPerWeek": 1, "minutesPerLesson": 60,
        "studentGroupSize": 10, "minGradeLevel": 7, "maxGradeLevel": 7,
    }
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            requirement(CLASS, TEACHERS[0]),
            requirement(half_a, TEACHERS[1]),
            requirement(half_b, TEACHERS[2]),
            requirement(CLASS, TEACHERS[0]),
        ],
        "groups": [{"id": CLASS, "lunchHeadcount": 25, "minGradeLevel": 7, "maxGradeLevel": 7}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "groupConflicts": [[CLASS, half_a], [CLASS, half_b]],
        "pupilGaps": {"cohorts": [
            {"groupIds": [CLASS, half_a, half_b], "pupils": 1, "homeGroupId": CLASS},
        ]},
    }


def test_sibling_halves_meeting_is_one_hour() -> None:
    """An unplaced pupil sits both halves: their rotation is one busy hour, not two.

    Without the overlap the two hours would count as 24 slots taught inside a
    12-slot span, and the day 08:00-11:00 with a hole at 09:00 would read as
    none.
    """
    payload = _halves_payload()
    # The halves rotate at 09:00, the class at 08:00 and 11:00: 10:00 is a hole.
    assert _pupil_term(payload, [8 * 60, 9 * 60, 9 * 60, 11 * 60]) == 12
    # Side by side at 09:00 and 10:00: no hole for the pupil who has both.
    assert _pupil_term(payload, [8 * 60, 9 * 60, 10 * 60, 11 * 60]) == 0


def test_closed_time_is_credited_once_however_many_are_in_it() -> None:
    """7A is closed 10:00-11:00 and Ty7 meets in it: its ten are busy once, not twice.

    7A at 08:00, 09:00, 11:00 and 14:00, Ty7 at 10:00. Both cohorts wait
    12:00-14:00, 24 slots. The ten in Ty7 must not be paid for the closed hour
    as well as for their lesson in it: without the lesson's share taken off
    the closure's credit they would wait 12 slots.
    """
    payload = _week(pupil_gaps=True)
    payload["constraints"] = [{
        "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": CLASS,
        "dayOfWeek": 1, "date": None, "kind": "UNAVAILABLE",
        "startTime": "10:00:00", "endTime": "11:00:00",
    }]
    assert _pupil_term(payload, [8 * 60, 9 * 60, 11 * 60, 14 * 60, 10 * 60]) == 15 * 24 + 10 * 24
    # And with nothing between: the closed hour is no hole for either.
    assert _pupil_term(payload, [8 * 60, 9 * 60, 11 * 60, 12 * 60, 10 * 60]) == 0


def _closed_week() -> dict[str, object]:
    payload = _week(pupil_gaps=True)
    payload["constraints"] = [{
        "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": CLASS,
        "dayOfWeek": 1, "date": None, "kind": "UNAVAILABLE",
        "startTime": "10:00:00", "endTime": "11:00:00",
    }]
    return payload


@pytest.mark.parametrize(
    "make",
    [_closed_week, _halves_payload, lambda: _locked_halves()],
    ids=["a closed hour", "sibling halves", "locks, halves and closed time"],
)
def test_the_size_estimate_bounds_what_the_term_builds(make) -> None:  # noqa: ANN001
    """_estimate_model_size stays an upper bound with the rule on.

    A closed hour mid-day, and sibling halves, so the closure credits and the
    halves' overlaps are made as well as the ends and the day literals.
    """
    on = OptimizeScheduleRequest.model_validate(make())
    off = on.model_copy(update={"pupil_gaps": None})
    solver = _solver()
    built_on, *_ = solver._build_model(on, use_assumptions=False)
    built_off, *_ = solver._build_model(off, use_assumptions=False)
    # The whole model, which is what the estimate promises: the day variables
    # the term reads are charged by the rules' own term, with or without it.
    assert len(built_on.Proto().variables) > len(built_off.Proto().variables)
    assert solver._estimate_model_size(on) >= len(built_on.Proto().variables)
    assert solver._estimate_model_size(on) > solver._estimate_model_size(off)


def _pupil_objective(payload: dict[str, object], starts: list[int], lunch_at: int | None = None) -> float:
    """The whole objective with every other weight at zero, lessons (and the meal) pinned.

    What the term is worth inside the model it is built in: with the lunch
    variable it reads, the day variables the rules made and the scale beside
    it. In pupil-slots.
    """
    payload = {
        **payload,
        "weights": {
            "preferredFree": 0, "preferredBusy": 0, "disruption": 0,
            "spread": 0, "teacherGap": 0, "roomPreference": 0,
        },
    }
    solver = _solver(WEIGHT_LUNCH_DRIFT=0, WEIGHT_FREE_DAY_WISH=0)
    request = OptimizeScheduleRequest.model_validate(payload)
    model, _, decisions, _, lunches = solver._build_model(request, use_assumptions=False)
    grid = solver._grid
    for decision, minutes in zip(decisions, starts):
        model.Add(decision.start == (minutes - grid.day_start_minutes) // grid.slot_minutes)
    if lunch_at is not None:
        for variable in lunches.values():
            model.Add(variable == (lunch_at - grid.day_start_minutes) // grid.slot_minutes)
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = 10.0
    assert cp.Solve(model) == cp_model.OPTIMAL
    return cp.ObjectiveValue() / solver._settings.weight_pupil_gap


def test_the_lunch_in_the_day_is_credited_and_the_lunch_outside_it_is_not() -> None:
    """7A at 08, 09, 12 and 13, Ty7 at 10, and 7A's lunch at 11:00 or at 14:00.

    At 11:00 the meal is in the day of both cohorts: Ty7's ten wait 11:30-12:00
    (6 slots), the fifteen 10:00-11:00 and 11:30-12:00 (18). At 14:00, after
    the last lesson, it is in neither day, and both wait its half hour too.
    """
    payload = _week(pupil_gaps=True, lunch=True)
    payload["rules"] = {"lunchStartTime": "11:00:00", "lunchEndTime": "14:30:00", "lunchMinutes": 30}
    starts = [8 * 60, 9 * 60, 12 * 60, 13 * 60, 10 * 60]
    assert _pupil_objective(payload, starts, lunch_at=11 * 60) == 10 * 6 + 15 * 18
    assert _pupil_objective(payload, starts, lunch_at=14 * 60) == 10 * 12 + 15 * 24


def test_the_pupils_margins_are_busy_time_in_the_term() -> None:
    """Idrott with 15 minutes of dusch after it: the pupils are busy until a quarter past.

    7A's first requirement is idrott (minutesAfter 15) at 08:00 and 12:00, its
    second at 09:30 and 13:30, and Ty7 at 10:30. The fifteen outside Ty7 wait
    09:15-09:30, 10:30-12:00 and 13:15-13:30 (3 + 18 + 3 slots); the ten in it
    09:15-09:30, 11:30-12:00 and 13:15-13:30 (3 + 6 + 3). Without the dusch
    as busy time each 15-minute wait would be half an hour.
    """
    payload = _week(pupil_gaps=True)
    payload["requirements"][0]["minutesAfter"] = 15
    starts = [8 * 60, 12 * 60, 9 * 60 + 30, 13 * 60 + 30, 10 * 60 + 30]
    assert _pupil_term(payload, starts) == 15 * (3 + 18 + 3) + 10 * (3 + 6 + 3)


def test_the_estimate_charges_the_closures_the_term_builds() -> None:
    """The term's own closure variables, against what its estimate adds for them."""
    open_week = _week(pupil_gaps=True)
    closed_week = _closed_week()
    solver = _solver()

    def variables(payload: dict[str, object], on: bool) -> int:
        request = OptimizeScheduleRequest.model_validate(payload)
        if not on:
            request = request.model_copy(update={"pupil_gaps": None})
        model, *_ = solver._build_model(request, use_assumptions=False)
        return len(model.Proto().variables)

    built = (variables(closed_week, True) - variables(open_week, True)) - (
        variables(closed_week, False) - variables(open_week, False)
    )
    charged = _estimate(solver, closed_week) - _estimate(solver, open_week)
    assert built > 0
    assert charged >= built


def _estimate(solver: SchedulerSolver, payload: dict[str, object]) -> int:
    grid = solver._grid
    return estimate_variables(
        OptimizeScheduleRequest.model_validate(payload),
        SlotGrid(grid.slots_per_day, grid.slot_minutes, grid.day_start_minutes, grid.schedule_days),
        solver._fixed_window,
    )


# ---------------------------------------------------------------------------
# The pupils' whole day: margins, derived keys and locks, term against count
# ---------------------------------------------------------------------------

HALF_A = str(uuid4())
HALF_B = str(uuid4())
OTHER = str(uuid4())


def _requirement(group: str, teacher: int, lessons: int = 1, **extra: object) -> dict[str, object]:
    return {
        "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
        "teacherId": TEACHERS[teacher], "lessonsPerWeek": lessons, "minutesPerLesson": 60,
        "studentGroupSize": 10, "minGradeLevel": 7, "maxGradeLevel": 7, **extra,
    }


def _lock(group: str, start: str, end: str) -> dict[str, object]:
    return {
        "id": str(uuid4()), "studentGroupId": group, "dayOfWeek": 1,
        "startTime": f"{start}:00", "endTime": f"{end}:00",
    }


def _school(
    requirements: list[dict[str, object]],
    cohorts: list[dict[str, object]],
    *,
    locks: list[dict[str, object]] = (),  # type: ignore[assignment]
    closed: list[tuple[str, str, str]] = (),  # type: ignore[assignment]
    conflicts: list[list[str]] | None = None,
) -> dict[str, object]:
    """7A and its halves, Monday 08:00-16:00: `closed` is (group, start, end) closed by a rule."""
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [{"id": CLASS, "lunchHeadcount": 25, "minGradeLevel": 7, "maxGradeLevel": 7}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "groupConflicts": conflicts if conflicts is not None else [[CLASS, HALF_A], [CLASS, HALF_B]],
        "fixedLessons": list(locks),
        "constraints": [
            {
                "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": group,
                "dayOfWeek": 1, "date": None, "kind": "UNAVAILABLE",
                "startTime": f"{start}:00", "endTime": f"{end}:00",
            }
            for group, start, end in closed
        ],
        "pupilGaps": {"cohorts": cohorts},
    }


def _counted(payload: dict[str, object], starts: list[int]) -> int:
    """The count for lessons at these minutes, each its requirement's length, in the decisions' order."""
    request = OptimizeScheduleRequest.model_validate(payload)
    placed = [
        (requirement.id, requirement.minutes_per_lesson)
        for requirement in request.requirements
        for _ in range(requirement.lessons_per_week)
    ]
    clock = lambda minutes: f"{minutes // 60:02d}:{minutes % 60:02d}:00"  # noqa: E731
    return pupil_idle_minutes(request, [
        ScheduledLesson.model_validate({
            "requirementId": owner, "dayOfWeek": 1,
            "startTime": clock(minutes), "endTime": clock(minutes + length),
        })
        for (owner, length), minutes in zip(placed, starts)
    ])


def _term_is_the_count(payload: dict[str, object], starts: list[int], slots: int) -> None:
    """The term says `slots` pupil-slots for the week, and the count says the same in minutes."""
    assert _pupil_term(payload, starts) == slots
    assert _counted(payload, starts) == slots * 5


def test_both_halves_locked_at_once_are_one_hour_of_the_day() -> None:
    """The halves' slöjd locked 11:00-12:00 for both: nine pupils in neither sit one hour.

    7A at 08:00 and 09:00 leaves 10:00-11:00 empty before the rotation. Two
    locks of an hour each in a four-hour day would read as a day without a
    hole, and a generator could not tell it from 7A at 09:00 and 10:00.
    """
    locks = [_lock(HALF_A, "11:00", "12:00"), _lock(HALF_B, "11:00", "12:00")]
    payload = _school(
        [_requirement(CLASS, 0, lessons=2)],
        [{
            "groupIds": [CLASS, HALF_A, HALF_B], "pupils": 9, "homeGroupId": CLASS,
            "fixedLessonIds": [lock["id"] for lock in locks],
        }],
        locks=locks,
    )
    _term_is_the_count(payload, [8 * 60, 9 * 60], 9 * 12)
    _term_is_the_count(payload, [9 * 60, 10 * 60], 0)


def test_a_lock_and_the_sibling_halfs_lesson_beside_it_are_one_hour() -> None:
    """7A:1's slöjd locked 10:00-11:00, 7A:2's NO placed: four pupils in neither half.

    7A at 08:00 and 13:00. NO beside the lock leaves 09:00-10:00 and
    11:00-13:00 (36 slots); NO at 11:00 leaves 09:00-10:00 and 12:00-13:00
    (24). Counted as two hours, the lock and the NO beside it would cost what
    the NO after it does.
    """
    lock = _lock(HALF_A, "10:00", "11:00")
    payload = _school(
        [_requirement(CLASS, 0, lessons=2), _requirement(HALF_B, 1)],
        [{
            "groupIds": [CLASS, HALF_A, HALF_B], "pupils": 4, "homeGroupId": CLASS,
            "fixedLessonIds": [lock["id"]],
        }],
        locks=[lock],
    )
    _term_is_the_count(payload, [8 * 60, 13 * 60, 10 * 60], 4 * 36)
    _term_is_the_count(payload, [8 * 60, 13 * 60, 11 * 60], 4 * 24)


def test_a_lock_in_closed_time_is_busy_once() -> None:
    """7A is closed 10:00-11:00, and Ty7's språkval is locked in that hour.

    7A at 08:00, 09:00, 11:00 and 14:00. The ten in Ty7 and the fifteen
    outside it wait 12:00-14:00 alike: 24 slots each. Counted as the closure
    and the lock both, the ten would wait only half of it.
    """
    lock = _lock(TY, "10:00", "11:00")
    payload = _school(
        [_requirement(CLASS, 0, lessons=2), _requirement(CLASS, 1, lessons=2)],
        [
            {
                "groupIds": [CLASS, TY], "pupils": 10, "homeGroupId": CLASS,
                "fixedLessonIds": [lock["id"]],
            },
            {"groupIds": [CLASS], "pupils": 15, "homeGroupId": CLASS},
        ],
        locks=[lock],
        closed=[(CLASS, "10:00", "11:00")],
        conflicts=[[CLASS, TY]],
    )
    _term_is_the_count(payload, [8 * 60, 9 * 60, 11 * 60, 14 * 60], 25 * 24)


def test_both_halves_in_closed_time_are_busy_once() -> None:
    """The halves both at 09:00, inside 09:00-09:40 a rule closes for the pupils' stödgrupp.

    Three pupils in neither half, 7A at 08:00 and 10:00: a day without a hole.
    The closure took 40 minutes off each half's hour; together they are one
    hour, and the 40 minutes come back once, or the pupils would wait them.
    """
    payload = _school(
        [_requirement(CLASS, 0, lessons=2), _requirement(HALF_A, 1), _requirement(HALF_B, 2)],
        [{"groupIds": [CLASS, HALF_A, HALF_B, OTHER], "pupils": 3, "homeGroupId": CLASS}],
        closed=[(OTHER, "09:00", "09:40")],
    )
    _term_is_the_count(payload, [8 * 60, 10 * 60, 9 * 60, 9 * 60], 0)
    _term_is_the_count(payload, [8 * 60, 11 * 60, 9 * 60, 9 * 60], 3 * 12)


def test_a_lock_naming_a_pupil_shares_the_hour_with_their_class() -> None:
    """One pupil of 7A is named on a lock of another group, 09:00-10:00, and 7A has matte then.

    7A at 08:00, 09:00 and 11:00: everyone waits 10:00-11:00, the named
    pupil too. The lock holds 7A off nothing, so the class's hour may lie on
    it, and the two are one hour of that pupil's day.
    """
    lock = _lock(OTHER, "09:00", "10:00")
    payload = _school(
        [_requirement(CLASS, 0, lessons=3)],
        [
            {
                "groupIds": [CLASS], "pupils": 1, "homeGroupId": CLASS,
                "fixedLessonIds": [lock["id"]],
            },
            {"groupIds": [CLASS], "pupils": 24, "homeGroupId": CLASS},
        ],
        locks=[lock],
        conflicts=[],
    )
    _term_is_the_count(payload, [8 * 60, 9 * 60, 11 * 60], 25 * 12)


def test_keys_nobody_paired_never_make_the_week_infeasible() -> None:
    """Four keys of one cohort with no pair between them, all four lessons at 08:00.

    Each pair's overlap is taken off once, so three keys over the same hours
    take them off more than once and the right side outgrows a day. A
    gateway sends at most two such keys; whatever comes, the term is a cost,
    and this week — every hard rule kept — must stay a week.
    """
    groups = [str(uuid4()) for _ in range(4)]
    payload = _school(
        [
            {**_requirement(group, 0), "teacherId": str(uuid4()), "minutesPerLesson": 240}
            for group in groups
        ],
        [{"groupIds": groups, "pupils": 1, "homeGroupId": groups[0]}],
        conflicts=[],
    )
    assert _pupil_term(payload, [8 * 60] * 4) >= 0


def _locked_halves() -> dict[str, object]:
    """A lock on one half, the other half's lesson, and closed time reaching them all."""
    lock = _lock(HALF_A, "10:00", "11:00")
    return _school(
        [_requirement(CLASS, 0, lessons=2), _requirement(HALF_A, 1), _requirement(HALF_B, 2)],
        [
            {
                "groupIds": [CLASS, HALF_A, HALF_B, OTHER], "pupils": 3, "homeGroupId": CLASS,
                "fixedLessonIds": [lock["id"]],
            },
            {"groupIds": [CLASS, HALF_A], "pupils": 10, "homeGroupId": CLASS,
             "fixedLessonIds": [lock["id"]]},
        ],
        locks=[lock],
        closed=[(OTHER, "13:00", "13:40")],
    )
