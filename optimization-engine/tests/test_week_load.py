"""The least week a year needs, counted with its teachers in it.

THE SCHOOL (2026-11-03). Year 8 with five home classes and five language
groups cut across all of them. Three of the groups have one teacher, so they
cannot run together even though they share no pupil with each other, and every
class has to sit through them one after the other. The class counts (cliques of
pupils) say the week is a comfortable 80 %; the count with the teachers in it
says 95 % or more, and CP-SAT spent twelve hundred seconds not finding it.

This file builds that year small and exact. Every number in the cases below is
arithmetic: a class's lessons are `n` x (50 + 5) minutes, a language group's
four lessons are 4 x (40 + 5) = 180, the three of one teacher are 540 if they
cannot overlap, a class eats 5 x 15 = 75, and the frame is 08:25-15:40 with five
minutes of changeover after the last lesson, 440 minutes a day, 2,200 a week.
"""

from __future__ import annotations

import math
import random
import time
import uuid
from uuid import uuid4

import pytest
from ortools.linear_solver import pywraplp
from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.messages import render
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleRequest
from app.solver import scheduler_solver, week_load
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.weeks import meet

CLASSES = [str(uuid4()) for _ in range(5)]
GROUPS = [str(uuid4()) for _ in range(5)]
SHARED_TEACHER = str(uuid4())
FRAME = {
    "minGradeLevel": 8,
    "maxGradeLevel": 8,
    "dayOfWeek": None,
    "startTime": "08:25:00",
    "endTime": "15:40:00",
    "changeoverMinutes": 5,
}
WEEK = 2200


def _settings(**overrides: object) -> Settings:
    return Settings(**{"SOLVER_MAX_TIME_SECONDS": 20.0, **overrides})  # type: ignore[arg-type]


def _year(
    *,
    class_lessons: int,
    shared: bool = True,
    block: bool = False,
    parity: dict[int, str] | None = None,
    extra: dict[str, object] | None = None,
    grade: int = 8,
    classes: list[str] = CLASSES,
    groups: list[str] = GROUPS,
    teacher_of_three: str = SHARED_TEACHER,
) -> dict[str, object]:
    """Year 8: five classes, five language groups, three of them one teacher's.

    `shared=False` gives every group a teacher of its own (the school's fix),
    `block=True` also declares the five a parallel block (their other half).
    `parity` marks groups, by position, as odd or even weeks only. Another
    `grade` with its own `classes` and `groups` builds a second year, and the
    same `teacher_of_three` puts one person on groups of both.
    """
    requirements: list[dict[str, object]] = []
    for position, class_id in enumerate(classes):
        requirements.append({
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": class_id,
            "teacherId": str(uuid4()),
            "lessonsPerWeek": class_lessons,
            "minutesPerLesson": 50,
            "studentGroupSize": 24,
            "minGradeLevel": grade,
            "maxGradeLevel": grade,
        })
    block_id = str(uuid4())
    group_rows: list[dict[str, object]] = []
    for position, group_id in enumerate(groups):
        teacher = teacher_of_three if shared and position < 3 else str(uuid4())
        row: dict[str, object] = {
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": group_id,
            "teacherId": teacher,
            "lessonsPerWeek": 4,
            "minutesPerLesson": 40,
            "studentGroupSize": 20,
            "minGradeLevel": grade,
            "maxGradeLevel": grade,
        }
        if block:
            row["blockId"] = block_id
        if parity and position in parity:
            row["recurrence"] = parity[position]
        group_rows.append(row)
    requirements.extend(group_rows)
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [
            {"id": class_id, "lunchHeadcount": 24, "minGradeLevel": grade, "maxGradeLevel": grade}
            for class_id in classes
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(10)],
        "groupConflicts": [[c, g] for c in classes for g in groups],
        "frameTimes": [{**FRAME, "minGradeLevel": grade, "maxGradeLevel": grade}],
        "rules": {
            "lunchStartTime": "11:20:00",
            "lunchEndTime": "13:00:00",
            "lunchMinutes": 15,
        },
    }
    payload.update(extra or {})
    return payload


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _loads(payload: dict[str, object], **settings: object) -> list[week_load.StageLoad]:
    return SchedulerSolver(_settings(**settings))._week_loads(_request(payload))


def _has_timetable(
    week: dict[str, object] | OptimizeScheduleRequest, *, days: str = "1,2", seconds: float = 20.0,
) -> bool:
    """Whether the real model (every rule, no objective) finds a timetable for the week.

    The ground the count is held to: a count that refuses a week this finds a
    timetable for is a false refusal.
    """
    request = week if isinstance(week, OptimizeScheduleRequest) else _request(week)
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS=days))
    solver._validate_request(request)
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
    search = cp_model.CpSolver()
    search.parameters.num_workers = 4
    search.parameters.random_seed = 0
    search.parameters.max_time_in_seconds = seconds
    status = search.Solve(model)
    assert status != cp_model.UNKNOWN, "the real model gave no answer in time"
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)


# ---------------------------------------------------------------------------
# What the count sees
# ---------------------------------------------------------------------------


def test_the_count_sees_a_teacher_the_class_counts_leave_out() -> None:
    """27 x 55 + 540 + 75 = 2,100 of 2,200 minutes: 95 %, where pupils alone say 1,740."""
    (load,) = _loads(_year(class_lessons=27))

    assert load.year == 8
    assert load.demand_minutes == 27 * 55 + 3 * 180 + 75
    assert load.capacity_minutes == WEEK
    assert not load.over


def test_the_same_year_with_a_teacher_of_each_group_is_not_tight() -> None:
    """The school's own fix, counted: the three groups run together, 1,485 + 180 + 75."""
    assert _loads(_year(class_lessons=27, shared=False)) == []
    # And the block, their other half, changes nothing the count sees: the
    # groups are already independent of each other.
    assert _loads(_year(class_lessons=27, shared=False, block=True)) == []


def test_a_year_above_its_frame_is_refused_before_any_model_and_named() -> None:
    payload = _year(class_lessons=29)  # 29 x 55 + 540 + 75 = 2,210 > 2,200

    started = time.monotonic()
    response = SchedulerSolver(_settings()).solve(_request(payload))
    assert time.monotonic() - started < 3.0

    assert response.status == "INFEASIBLE"
    assert response.lessons == []
    conflicts = response.conflicts
    assert conflicts is not None
    assert conflicts.summary_code == "DEMAND_YEAR_WEEK_SHORT"
    assert conflicts.summary_params == {
        "grades": "8", "demandMinutes": 2210, "capacityMinutes": WEEK, "shared": "some",
    }
    codes = [detail.code for detail in conflicts.conflicts]
    assert codes == ["DEMAND_REQUIREMENTS_EXCEED_WEEK", "TEACHER_SHARED_BY_PARALLEL_GROUPS"]
    shared = conflicts.conflicts[1]
    # The three groups of the one teacher are named, by entry, and no more.
    ids_of_shared = {
        row["id"] for row in payload["requirements"]  # type: ignore[union-attr]
        if row["teacherId"] == SHARED_TEACHER
    }
    assert {str(i) for i in shared.requirement_ids} == ids_of_shared
    assert {str(i) for i in shared.resource_ids} == ids_of_shared
    assert shared.params == {"groups": 3, "minutes": 480, "grades": "8"}
    assert shared.category == "TEACHER_OVERLAP"
    # Never a person: the teacher's id is in no field of the refusal.
    assert SHARED_TEACHER not in conflicts.model_dump_json()
    assert "8" in conflicts.summary and "2210" in conflicts.summary


def test_a_refusal_points_at_the_teachers_below_it_only_when_there_are_some() -> None:
    """31 x 55 + 540 = 2,245 > 2,200 with no `groups`: no home class, so no teacher can be named."""
    payload = _year(class_lessons=31)
    del payload["groups"]

    response = SchedulerSolver(_settings()).solve(_request(payload))

    conflicts = response.conflicts
    assert response.status == "INFEASIBLE" and conflicts is not None
    assert conflicts.summary_code == "DEMAND_YEAR_WEEK_SHORT"
    assert conflicts.summary_params["shared"] == "none"
    assert [detail.code for detail in conflicts.conflicts] == ["DEMAND_REQUIREMENTS_EXCEED_WEEK"]
    assert "see below" not in conflicts.summary
    assert conflicts.summary.endswith("take lessons out.")

    # With the home classes the same year names its teachers, and says so.
    named = SchedulerSolver(_settings()).solve(_request(_year(class_lessons=31))).conflicts
    assert named is not None and named.summary_params["shared"] == "some"
    assert "see below for teachers who stand on groups" in named.summary


def test_a_shared_teacher_is_credited_only_the_lessons_they_lead() -> None:
    """A post a teacher shares with another leads half of: 160 + 80 + 160, not 160 + 160 + 160."""
    payload = _year(class_lessons=27)
    split = _group_rows(payload)[1]
    split["lessonTeacherIds"] = [SHARED_TEACHER, SHARED_TEACHER, str(uuid4()), str(uuid4())]

    (load,) = _loads(payload)

    assert [teacher.minutes for teacher in load.shared] == [160 + 2 * 40 + 160]


def test_a_year_that_fits_is_not_refused_and_gets_a_timetable() -> None:
    """The school's fix, solved: own teacher per group plus the block."""
    # A short budget: phase 2 improves the timetable until it is spent.
    response = SchedulerSolver(_settings(SOLVER_MAX_TIME_SECONDS=6.0)).solve(
        _request(_year(class_lessons=27, shared=False, block=True)),
    )

    assert response.status in {"FEASIBLE", "OPTIMAL"}
    assert response.conflicts is None
    assert len(response.lessons) == 5 * 27 + 5 * 4


def test_the_bound_holds_when_nothing_is_shared() -> None:
    """A year whose classes alone are over the frame is over by pupils: no teacher is named."""
    response = SchedulerSolver(_settings()).solve(
        _request(_year(class_lessons=36, shared=False)),
    )

    assert response.status == "INFEASIBLE"
    # Whichever count catches it first, it is not a shared teacher's doing.
    assert all(
        detail.code != "TEACHER_SHARED_BY_PARALLEL_GROUPS"
        for detail in response.conflicts.conflicts  # type: ignore[union-attr]
    )


def test_two_classes_mathematics_under_one_teacher_is_nobody_s_pattern() -> None:
    """Every school has a teacher on two classes. Only groups that would run together count."""
    payload = _year(class_lessons=27)
    teacher = str(uuid4())
    # The same teacher takes two classes' own lessons: they share no home class.
    first, second = payload["requirements"][0], payload["requirements"][1]  # type: ignore[index]
    first["teacherId"] = second["teacherId"] = teacher  # type: ignore[index]

    (load,) = _loads(payload)

    named = {str(i) for teacher in load.shared for i in teacher.requirement_ids}
    assert first["id"] not in named and second["id"] not in named  # type: ignore[index]
    assert len(load.shared) == 1  # still only the language teacher


def test_alternating_weeks_are_counted_one_real_week_at_a_time() -> None:
    """The shared teacher's odd-week and even-week groups never meet, so they never queue.

    Group 0 runs odd weeks, group 1 even weeks, group 2 every week. Each real
    week holds two of the teacher's three groups: 1,485 + 360 + 75 = 1,920 of
    2,200, 87 %. Counted as one week the teacher's three would stack to 95 %,
    and a week the school can live with would be called tighter than it is.
    """
    payload = _year(class_lessons=27, parity={0: "ODD_WEEKS", 1: "EVEN_WEEKS"})
    solver = SchedulerSolver(_settings())
    request = _request(payload)

    per_week = [
        solver._week_loads(week) for week in scheduler_solver._week_requests(request)
    ]

    assert len(per_week) == 2
    assert [[load.demand_minutes for load in week] for week in per_week] == [[1920], [1920]]
    # The same rows with no alternation are the 95 % year.
    assert _loads(_year(class_lessons=27))[0].demand_minutes == 2100


# ---------------------------------------------------------------------------
# What a TIMEOUT carries
# ---------------------------------------------------------------------------


@pytest.fixture
def timing_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both satisfaction searches answer UNKNOWN, as a week CP-SAT cannot place does."""
    monkeypatch.setattr(
        scheduler_solver, "_solve_guarded", lambda *args, **kwargs: cp_model.UNKNOWN,
    )


def test_a_timeout_on_a_nearly_full_year_says_so(
    timing_out: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", lambda self, request, **kw: None)

    response = SchedulerSolver(_settings()).solve(_request(_year(class_lessons=27)))

    assert response.status == "TIMEOUT"
    conflicts = response.conflicts
    assert conflicts is not None
    assert conflicts.summary_code == "TIGHT_WEEK_TIMEOUT"
    assert conflicts.summary_params == {
        "budget": 20, "grades": "8", "demandMinutes": 2100, "capacityMinutes": WEEK, "percent": 95,
    }
    assert [detail.code for detail in conflicts.conflicts] == [
        "TIGHT_WEEK_LOAD", "TEACHER_SHARED_BY_PARALLEL_GROUPS",
    ]
    assert "try a longer budget" not in conflicts.summary


def test_a_probe_that_found_a_rule_keeps_its_answer_and_the_notice_follows(
    timing_out: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    found = ConflictAnalysis(
        summary_code="PROBE_ONE_RULE_HELPED",
        summary_params={"budget": 20, "rules": 1},
        conflicts=[ConflictDetail(
            category="TIMEOUT_PROBE", code="PROBE_SOLVED_WITHOUT_RASTS", params={"seconds": 1.0},
        )],
    )
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", lambda self, request, **kw: found)

    response = SchedulerSolver(_settings()).solve(_request(_year(class_lessons=27)))

    conflicts = response.conflicts
    assert conflicts is not None and conflicts.summary_code == "PROBE_ONE_RULE_HELPED"
    assert [detail.code for detail in conflicts.conflicts] == [
        "PROBE_SOLVED_WITHOUT_RASTS", "TIGHT_WEEK_LOAD", "TEACHER_SHARED_BY_PARALLEL_GROUPS",
    ]


def test_a_timeout_on_a_year_with_room_to_spare_is_what_it_was(
    timing_out: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No notice below the threshold: the response is the probe's, untouched."""
    sentinel = ConflictAnalysis(summary_code="PROBE_NOTHING_HELPED",
                                summary_params={"budget": 20, "rules": 1, "slice": 4},
                                conflicts=[])
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", lambda self, request, **kw: sentinel)

    response = SchedulerSolver(_settings()).solve(
        _request(_year(class_lessons=27, shared=False)),
    )

    assert response.status == "TIMEOUT"
    assert response.conflicts == sentinel


# ---------------------------------------------------------------------------
# The probe that names the cause
# ---------------------------------------------------------------------------


def _group_rows(payload: dict[str, object]) -> list[dict[str, object]]:
    return [
        row for row in payload["requirements"]  # type: ignore[union-attr]
        if row["studentGroupId"] in GROUPS
    ]


def test_the_probe_gives_each_shared_group_a_teacher_and_runs_the_year_as_a_block() -> None:
    payload = _year(class_lessons=27)
    solver = SchedulerSolver(_settings())
    request = _request(payload)

    relaxed = solver._parallel_groups_probe(request, solver._week_loads(request))

    assert relaxed is not None
    groups = [r for r in relaxed.requirements if str(r.student_group_id) in GROUPS]
    # The three of one teacher have three teachers now, and the two beside them keep theirs.
    assert len({r.teacher_id for r in groups}) == 5
    # All five are one block: the three that shared, and the siblings that did not.
    assert len({r.block_id for r in groups}) == 1 and groups[0].block_id is not None
    # The classes are untouched.
    classes = [r for r in relaxed.requirements if str(r.student_group_id) in CLASSES]
    assert all(r.block_id is None for r in classes)
    originals = {r.id: r for r in request.requirements}
    assert all(originals[r.id].teacher_id == r.teacher_id for r in classes)
    # And the request the school sent is as it was.
    assert {r.block_id for r in request.requirements} == {None}


def test_the_relaxed_week_is_one_the_model_solves() -> None:
    payload = _year(class_lessons=27)
    solver = SchedulerSolver(_settings())
    request = _request(payload)
    relaxed = solver._parallel_groups_probe(request, solver._week_loads(request))
    assert relaxed is not None

    model, _, decisions, plan, _ = solver._build_model(
        relaxed, use_assumptions=False, include_objective=False,
    )
    status, _ = solver._probe_search(relaxed, model, decisions, plan, 20.0, what="a test")

    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def test_a_group_whose_lessons_a_post_splits_between_teachers_is_left_alone() -> None:
    payload = _year(class_lessons=27)
    rows = _group_rows(payload)
    rows[1]["lessonTeacherIds"] = [SHARED_TEACHER, SHARED_TEACHER, str(uuid4()), str(uuid4())]
    solver = SchedulerSolver(_settings())
    request = _request(payload)

    relaxed = solver._parallel_groups_probe(request, solver._week_loads(request))

    assert relaxed is not None
    split = next(r for r in relaxed.requirements if str(r.id) == rows[1]["id"])
    assert split.block_id is None and split.lesson_teacher_ids is not None


def test_the_probe_is_offered_first_for_a_nearly_full_year_and_not_otherwise() -> None:
    solver = SchedulerSolver(_settings())

    tight = [code for code, _ in solver._timeout_relaxations(_request(_year(class_lessons=27)))]
    loose = [
        code
        for code, _ in solver._timeout_relaxations(
            _request(_year(class_lessons=27, shared=False)),
        )
    ]

    assert tight[0] == "PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK"
    assert "PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK" not in loose


ALTERNATING = {0: "ODD_WEEKS", 1: "EVEN_WEEKS"}


def test_the_probe_is_not_offered_for_a_week_that_is_tight_only_when_odd_and_even_are_added() -> None:
    """24 x 55 + 360 + 75 = 1,755 of 2,200 (79.8 %) in each real week; as one week, 1,935 (88 %).

    The shared teacher's odd-week group and even-week group never meet, so the
    year is not tight in either week. solve() counts it that way; the probe's
    offer must too, or the probe that takes most of the probe time is spent on
    a cause the week does not have.
    """
    payload = _year(class_lessons=24, parity=ALTERNATING)
    solver = SchedulerSolver(_settings())
    request = _request(payload)

    # The trap, shown: counted as one week the year looks tight, with a shared teacher.
    (as_one_week,) = solver._week_loads(request)
    assert (as_one_week.demand_minutes, len(as_one_week.shared)) == (1935, 1)
    assert not [load for week in scheduler_solver._week_requests(request)
                for load in solver._week_loads(week)]

    codes = [code for code, _ in solver._timeout_relaxations(request)]

    assert "PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK" not in codes


def test_the_probe_for_alternating_weeks_takes_the_teachers_of_both_weeks() -> None:
    """The year is tight in both weeks, and each week has a teacher the other has not.

    Odd week: the teacher T is on group 0 (odd) and group 2 (every week).
    Even week: a second teacher U is on group 1 (even) and group 3 (every
    week). Year 8 reaches the probe as two loads with different teachers, and
    the relaxed week has to give nobody two groups that can meet, in either
    week: the heaviest of the two alone would leave the other week's teacher
    where it was.
    """
    payload = _year(class_lessons=27, parity=ALTERNATING)
    rows = _group_rows(payload)
    other_teacher = str(uuid4())
    rows[1]["teacherId"] = rows[3]["teacherId"] = other_teacher
    solver = SchedulerSolver(_settings())
    request = _request(payload)
    per_week = [solver._week_loads(week) for week in scheduler_solver._week_requests(request)]
    assert [[load.year for load in week] for week in per_week] == [[8], [8]]
    shared_in = [
        {str(i) for teacher in week[0].shared for i in teacher.requirement_ids} for week in per_week
    ]
    assert shared_in[0] == {rows[0]["id"], rows[2]["id"]}
    assert shared_in[1] == {rows[1]["id"], rows[3]["id"]}

    offered = solver._timeout_relaxations(request)

    assert offered[0][0] == "PROBE_SOLVED_WITH_OWN_TEACHERS_AND_BLOCK"
    relaxed = offered[0][1]
    groups = [r for r in relaxed.requirements if str(r.student_group_id) in GROUPS]
    for position, first in enumerate(groups):
        for second in groups[position + 1:]:
            if meet(first.recurrence, second.recurrence):
                assert first.teacher_id != second.teacher_id, "two groups of one week share a teacher"
    # A block runs in one week: it holds nothing of the other parity, and every
    # block is more than one entry.
    blocks: dict[object, list[object]] = {}
    for r in groups:
        if r.block_id is not None:
            blocks.setdefault(r.block_id, []).append(r.recurrence)
    assert blocks and all(len(members) > 1 for members in blocks.values())
    assert all(len(set(members)) == 1 for members in blocks.values())
    # And it is a week the model solves, in both weeks at once.
    assert _has_timetable(relaxed, days="1,2,3,4,5")


def test_a_teacher_with_a_group_in_each_year_keeps_one_group_in_each() -> None:
    """The probe relaxes within a year: a person on groups of years 8 and 9 stays one person."""
    second_classes = [str(uuid4()) for _ in range(5)]
    second_groups = [str(uuid4()) for _ in range(5)]
    first = _year(class_lessons=27)
    second = _year(
        class_lessons=27, grade=9, classes=second_classes, groups=second_groups,
        teacher_of_three=SHARED_TEACHER,
    )
    payload = {
        **first,
        "requirements": [*first["requirements"], *second["requirements"]],  # type: ignore[misc]
        "groups": [*first["groups"], *second["groups"]],  # type: ignore[misc]
        "groupConflicts": [*first["groupConflicts"], *second["groupConflicts"]],  # type: ignore[misc]
        "frameTimes": [*first["frameTimes"], *second["frameTimes"]],  # type: ignore[misc]
    }
    solver = SchedulerSolver(_settings())
    request = _request(payload)
    loads = solver._week_loads(request)
    assert {load.year for load in loads} == {8, 9}

    relaxed = solver._parallel_groups_probe(request, loads)

    assert relaxed is not None
    held = [r for r in relaxed.requirements if r.teacher_id == uuid.UUID(SHARED_TEACHER)]
    # One group of year 8 and one of year 9, no more and no fewer.
    assert sorted(r.min_grade_level for r in held) == [8, 9]


def test_the_probe_takes_most_of_the_probe_budget_and_the_others_share_the_rest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[float] = []

    def search(self, relaxed, model, decisions, plan, seconds, **kwargs):  # type: ignore[no-untyped-def]
        seen.append(seconds)
        return cp_model.UNKNOWN, None

    monkeypatch.setattr(SchedulerSolver, "_probe_search", search)
    payload = _year(class_lessons=27)
    # A corridor of its own is already in FRAME; add a rule the probes know.
    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=20.0))

    analysis = solver._probe_timeout(_request(payload))

    assert analysis is not None and analysis.summary_code == "PROBE_NOTHING_HELPED"
    assert seen[0] == pytest.approx(12.0)  # 0.6 of 20
    others = len(seen) - 1
    assert others >= 1
    assert all(seconds == pytest.approx(8.0 / others) for seconds in seen[1:])


# ---------------------------------------------------------------------------
# Soundness, which is the point
# ---------------------------------------------------------------------------


def _exact_fractional(weights: list[int], adjacency: list[int]) -> float:
    """The fractional chromatic number by every independent set — the definition."""
    n = len(weights)
    sets = [
        mask for mask in range(1, 1 << n)
        if all(not (adjacency[v] & mask) for v in range(n) if (mask >> v) & 1)
    ]
    solver = pywraplp.Solver.CreateSolver("GLOP")
    x = [solver.NumVar(0, solver.infinity(), f"x{i}") for i in range(len(sets))]
    for v in range(n):
        row = solver.Constraint(weights[v], solver.infinity())
        for i, mask in enumerate(sets):
            if (mask >> v) & 1:
                row.SetCoefficient(x[i], 1)
    objective = solver.Objective()
    for variable in x:
        objective.SetCoefficient(variable, 1)
    objective.SetMinimization()
    assert solver.Solve() == pywraplp.Solver.OPTIMAL
    return objective.Value()


@pytest.mark.parametrize("seed", range(40))
def test_the_bound_never_exceeds_the_exact_value_and_a_cover_never_falls_below(seed: int) -> None:
    """Against the definition, on random graphs of up to nine nodes."""
    rng = random.Random(seed)
    n = rng.randint(2, 9)
    density = rng.choice([0.3, 0.5, 0.7])
    adjacency = [0] * n
    for a in range(n):
        for b in range(a + 1, n):
            if rng.random() < density:
                adjacency[a] |= 1 << b
                adjacency[b] |= 1 << a
    weights = [rng.randint(1, 12) for _ in range(n)]
    graph = week_load._Graph(
        ids=list(range(n)), weights=weights, adjacency=adjacency,
        cliques=week_load._clique_cover(adjacency),
    )

    bound = week_load._fractional_cover(
        graph, stop_at_or_below=-1.0, stop_above=math.inf, deadline=time.monotonic() + 10,
    )
    exact = _exact_fractional(weights, adjacency)

    assert float(bound.lower) <= exact + 1e-6, "the lower bound claimed more than the truth"
    assert bound.upper >= exact - 1e-6, "the cover claimed to be cheaper than the truth"
    assert bound.converged
    assert float(bound.lower) == pytest.approx(exact, abs=1e-3)


def test_the_cliques_cover_every_edge_and_only_edges() -> None:
    rng = random.Random(7)
    n = 12
    adjacency = [0] * n
    for a in range(n):
        for b in range(a + 1, n):
            if rng.random() < 0.4:
                adjacency[a] |= 1 << b
                adjacency[b] |= 1 << a
    covered = [0] * n
    for clique in week_load._clique_cover(adjacency):
        for a in clique:
            for b in clique:
                if a != b:
                    assert (adjacency[a] >> b) & 1, "a clique holds a pair that is no edge"
                    covered[a] |= 1 << b
    assert covered == adjacency


def test_an_expired_deadline_proves_nothing_and_says_nothing() -> None:
    payload = _year(class_lessons=29)
    solver = SchedulerSolver(_settings())
    request = _request(payload)
    sharing = scheduler_solver._groups_sharing_students(request.group_conflicts)

    loads = week_load.week_loads(
        request.requirements,
        request.frame_times,
        solver._grid,
        week_load.Relations(
            sharing=sharing,
            pupil_key=scheduler_solver.pupil_key_of,
            teachers_at=scheduler_solver._teachers_at,
            meal_clear_of=lambda eater, other: other == eater or other in sharing.get(eater, ()),
        ),
        None,
        threshold=0.9,
        deadline=time.monotonic() - 1,
    )

    assert loads == []


def test_a_meal_outside_the_frame_takes_nothing_from_it() -> None:
    """Lunch at 16:00-17:00, after the frame closes: the supply is not spent on it."""
    payload = _year(class_lessons=27)
    payload["rules"] = {
        "lunchStartTime": "16:00:00", "lunchEndTime": "17:00:00", "lunchMinutes": 15,
    }

    (load,) = _loads(payload)

    assert load.demand_minutes == 27 * 55 + 3 * 180  # no 75


def test_the_frames_of_other_years_do_not_shrink_this_one() -> None:
    """The supply is the union of the year's own windows: year 7's frame says nothing of 8."""
    payload = _year(class_lessons=27)
    payload["frameTimes"] = [FRAME, {**FRAME, "minGradeLevel": 7, "maxGradeLevel": 7,
                                     "endTime": "12:00:00"}]

    (load,) = _loads(payload)

    assert load.capacity_minutes == WEEK


# ---------------------------------------------------------------------------
# Never a false refusal: small weeks the model solves, counted to the minute
# ---------------------------------------------------------------------------
#
# A refusal is a claim that the week has no timetable, made without a search,
# so the property that matters is that the count never exceeds the truth. Each
# week below is one the real model solves (_has_timetable), counted exactly: a
# change that made the supply smaller or the demand larger by a single meal
# or margin would call it impossible, or move its numbers.
#
# Two days, five minutes of changeover unless a frame says otherwise.


def _frame(
    low: int, high: int, start: str, end: str, changeover: int = 5,
) -> dict[str, object]:
    return {
        "minGradeLevel": low, "maxGradeLevel": high, "dayOfWeek": None,
        "startTime": f"{start}:00", "endTime": f"{end}:00", "changeoverMinutes": changeover,
    }


def _entry(
    group: str, teacher: str, lessons: int, minutes: int, low: int, high: int, **extra: object,
) -> dict[str, object]:
    return {
        "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
        "teacherId": teacher, "lessonsPerWeek": lessons, "minutesPerLesson": minutes,
        "studentGroupSize": 20, "minGradeLevel": low, "maxGradeLevel": high, **extra,
    }


def _small(
    requirements: list[dict[str, object]],
    frames: list[dict[str, object]],
    *,
    eating: tuple[tuple[str, int, int], ...] = (),
    meal: tuple[str, str, int] | None = None,
    closed: tuple[str, ...] = (),
    sharing: tuple[tuple[str, str], ...] = (),
    placed: tuple[tuple[str, int, str], ...] = (),
) -> dict[str, object]:
    """A week of a few entries: the classes that eat, a meal window, closed days, placed meals."""
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(6)],
        "frameTimes": frames,
    }
    if eating:
        payload["groups"] = [
            {"id": group, "lunchHeadcount": 20, "minGradeLevel": low, "maxGradeLevel": high}
            for group, low, high in eating
        ]
    if meal is not None:
        payload["rules"] = {
            "lunchStartTime": f"{meal[0]}:00", "lunchEndTime": f"{meal[1]}:00", "lunchMinutes": meal[2],
        }
    if closed:
        # The class is not taught on Monday at all: the row covers the whole day.
        payload["constraints"] = [
            {
                "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": group,
                "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "18:00:00", "kind": "UNAVAILABLE",
            }
            for group in closed
        ]
    if sharing:
        payload["groupConflicts"] = [list(pair) for pair in sharing]
    if placed:
        payload["lunchPlacements"] = [
            {"studentGroupId": group, "dayOfWeek": day, "startTime": f"{start}:00"}
            for group, day, start in placed
        ]
    return payload


def _exact(payload: dict[str, object], *, days: str = "1,2") -> dict[int | None, week_load.StageLoad]:
    """Every year's bound with nothing left out: no threshold, time to finish the proof."""
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS=days))
    solver.TIGHT_WEEK_LOAD = 0.0
    solver.WEEK_LOAD_SECONDS = 20.0
    return {load.year: load for load in solver._week_loads(_request(payload))}


def _figures(
    loads: dict[int | None, week_load.StageLoad],
) -> dict[int | None, tuple[int, int, bool]]:
    return {year: (l.demand_minutes, l.capacity_minutes, l.over) for year, l in loads.items()}


def test_a_year_of_two_spans_has_the_time_of_both_spans_windows() -> None:
    """Year 7 holds an entry of years 6-7 and one of years 7-8, on different frames.

    The frames are 6: 08:00-10:00, 7: 08:00-15:00, 8: 12:00-15:00, so the
    6-7 entry is held to 08:00-10:00 and the 7-8 entry to 12:00-15:00. Year 7
    has both windows, 125 + 185 = 310 minutes a day with the margin after the
    last lesson, 620 in two days. One teacher on both: 4 x 45 + 6 x 45 = 450
    in a row, which fits. Counted on one span's window alone, 250 or 370, it
    would not.
    """
    teacher = str(uuid4())
    payload = _small(
        [
            _entry(str(uuid4()), teacher, 4, 40, 6, 7),
            _entry(str(uuid4()), teacher, 6, 40, 7, 8),
        ],
        [_frame(6, 6, "08:00", "10:00"), _frame(7, 7, "08:00", "15:00"), _frame(8, 8, "12:00", "15:00")],
    )

    assert _figures(_exact(payload)) == {
        6: (180, 250, False), 7: (450, 620, False), 8: (270, 370, False),
    }
    assert _loads(payload, SCHEDULE_DAYS="1,2") == []
    assert _has_timetable(payload)


def test_a_window_inside_another_adds_no_time_and_takes_none() -> None:
    """Year 7's entries: one on 08:00-15:00 and one, also of year 8, held to 09:00-12:00.

    The second window lies inside the first, so the year's time is the first
    alone, 425 minutes a day with the margin, 850 in two days. A union that
    kept the last window's end instead of the later of the two would cut it to
    08:00-12:05, 245 a day, and call 540 minutes of one teacher's lessons
    impossible.
    """
    teacher = str(uuid4())
    payload = _small(
        [
            _entry(str(uuid4()), teacher, 8, 40, 7, 7),
            _entry(str(uuid4()), teacher, 4, 40, 7, 8),
        ],
        [_frame(7, 7, "08:00", "15:00"), _frame(8, 8, "09:00", "12:00")],
    )

    assert _figures(_exact(payload)) == {7: (540, 850, False), 8: (180, 370, False)}
    assert _loads(payload, SCHEDULE_DAYS="1,2") == []
    assert _has_timetable(payload)


def test_a_class_that_is_closed_for_a_day_owes_no_meal_that_day() -> None:
    """The class is not taught on Monday, so it eats on Tuesday only.

    Frame 08:00-11:55 (240 minutes a day with the margin), a meal of 15 in
    09:00-10:30. The class's five lessons of 45 and the language group's six
    of 40, which take pupils from it, and the one meal it eats: 225 + 240 + 15
    = 480, exactly the two days, with the group on Monday and the class on
    Tuesday. A meal counted for Monday too would make it 495.
    """
    home, group = str(uuid4()), str(uuid4())
    payload = _small(
        [
            _entry(home, str(uuid4()), 5, 40, 8, 8),
            _entry(group, str(uuid4()), 6, 35, 8, 8),
        ],
        [_frame(8, 8, "08:00", "11:55")],
        eating=((home, 8, 8),),
        meal=("09:00", "10:30", 15),
        closed=(home,),
        sharing=((home, group),),
    )

    assert _figures(_exact(payload)) == {8: (480, 480, False)}
    assert _has_timetable(payload)

    # Open on Monday the class eats twice, the week is 495 in 480, and it is
    # impossible: the closed day is what the 15 minutes depend on.
    del payload["constraints"]
    assert _figures(_exact(payload)) == {8: (495, 480, True)}
    assert not _has_timetable(payload)


def test_a_meal_placed_by_hand_is_counted_where_it_was_placed() -> None:
    """The same week with the meal placed at 16:00 on both days, after the frame has closed.

    A meal outside the time the year has takes none of it: 240 + 240 = 480,
    the two days to the minute, with the group on Monday and the class on
    Tuesday. Left to the window the class would eat inside the frame, 15 a
    day, and 510 do not fit.
    """
    home, group = str(uuid4()), str(uuid4())
    payload = _small(
        [
            _entry(home, str(uuid4()), 6, 35, 8, 8),
            _entry(group, str(uuid4()), 6, 35, 8, 8),
        ],
        [_frame(8, 8, "08:00", "11:55")],
        eating=((home, 8, 8),),
        meal=("09:00", "10:30", 15),
        sharing=((home, group),),
        placed=((home, 1, "16:00"), (home, 2, "16:00")),
    )

    assert _figures(_exact(payload)) == {8: (480, 480, False)}
    assert _has_timetable(payload)

    del payload["lunchPlacements"]
    assert _figures(_exact(payload)) == {8: (510, 480, True)}
    assert not _has_timetable(payload)


@pytest.mark.parametrize(
    ("placed", "owed"),
    [
        # The frame ends at 11:55 and the margin takes the year to 12:00.
        (("16:00", "16:00"), 0),
        (("11:50", "16:00"), 10),  # 10 of the 15 minutes are inside, none the other day
        (("11:55", "11:55"), 10),  # 5 of the 15 minutes inside, twice
        (("10:00", "10:00"), 30),  # inside, 15 twice
    ],
)
def test_a_meal_placed_across_the_end_of_the_frame_counts_the_minutes_inside(
    placed: tuple[str, str], owed: int,
) -> None:
    home, group = str(uuid4()), str(uuid4())
    payload = _small(
        [
            _entry(home, str(uuid4()), 4, 35, 8, 8),
            _entry(group, str(uuid4()), 4, 35, 8, 8),
        ],
        [_frame(8, 8, "08:00", "11:55")],
        eating=((home, 8, 8),),
        meal=("09:00", "10:30", 15),
        sharing=((home, group),),
        placed=((home, 1, placed[0]), (home, 2, placed[1])),
    )

    assert _figures(_exact(payload)) == {8: (320 + owed, 480, False)}


def test_a_post_split_between_teachers_is_counted_by_the_teacher_of_each_lesson() -> None:
    """One day 08:00-10:30, no margin. X teaches two lessons of group A and one of the split post.

    The split post's two lessons are X's and Y's. Y teaches two lessons of
    group B and the post's other. X and Y are each busy three lessons, 150
    minutes, and the post's two lessons are not at once: lesson one with X
    while Y teaches B, lesson two with Y, and the week is exactly full. Counted
    as one entry that needs both teachers it would be 200 minutes.
    """
    x, y = str(uuid4()), str(uuid4())
    payload = _small(
        [
            _entry(str(uuid4()), x, 2, 50, 8, 8),
            _entry(str(uuid4()), y, 2, 50, 8, 8),
            _entry(str(uuid4()), x, 2, 50, 8, 8, lessonTeacherIds=[x, y]),
        ],
        [_frame(8, 8, "08:00", "10:30", changeover=0)],
    )

    assert _figures(_exact(payload, days="1")) == {8: (150, 150, False)}
    assert _has_timetable(payload, days="1")


def test_unrelated_parts_of_a_year_are_not_added_to_each_other() -> None:
    """Two classes with nothing in common each fill the morning; they run side by side.

    The year's least week is its longest chain, not the sum of its chains:
    150, not 300.
    """
    payload = _small(
        [
            _entry(str(uuid4()), str(uuid4()), 3, 50, 8, 8),
            _entry(str(uuid4()), str(uuid4()), 3, 50, 8, 8),
        ],
        [_frame(8, 8, "08:00", "10:30", changeover=0)],
    )

    assert _figures(_exact(payload, days="1")) == {8: (150, 150, False)}
    assert _has_timetable(payload, days="1")


def test_each_entry_is_padded_by_the_margin_of_its_own_span() -> None:
    """Frames 6 and 7 have no margin and frame 8 ten minutes: only the 7-8 entry is padded.

    One teacher takes two lessons of 50 for years 6-7 and one of 40 for
    years 7-8, which with its margin of 10 is 50: 150 of the 160 minutes year 7
    has (08:00-10:30, and the 7-8 entry's margin after it). With the widest
    margin on every entry the 6-7 lessons would be 60 each and the year 170.
    """
    teacher = str(uuid4())
    payload = _small(
        [
            _entry(str(uuid4()), teacher, 2, 50, 6, 7),
            _entry(str(uuid4()), teacher, 1, 40, 7, 8),
        ],
        [
            _frame(6, 6, "08:00", "10:30", changeover=0),
            _frame(7, 7, "08:00", "10:30", changeover=0),
            _frame(8, 8, "08:00", "10:30", changeover=10),
        ],
    )

    assert _figures(_exact(payload, days="1")) == {
        6: (100, 150, False), 7: (150, 160, False), 8: (50, 160, False),
    }
    assert _has_timetable(payload, days="1")


# A SMOKE FUZZ, AND WHAT IT IS NOT. Random small weeks of the kind the exact
# tests above build by hand, each with its day shortened ten minutes at a time
# until the count first refuses it; the real model then searches that week, and
# finding a timetable would be a false refusal. 60 weeks catch only a gross
# error: the review's fuzz (3,500 weeks, six seconds each) is what found the
# subtle ones, and the exact weeks above are what keep them found. Run with
# `pytest -m slow`; the ordinary run skips it (conftest.py).

SMOKE_WEEKS = 60


def _random_week(rng: random.Random, end_minutes: int) -> dict[str, object]:
    """Years 8 or 7-8: two classes a year, teaching groups across them, a teacher pool, meals."""
    years = rng.choice([[8], [7, 8]])
    pool = [str(uuid4()) for _ in range(3)]
    requirements: list[dict[str, object]] = []
    eating: list[tuple[str, int, int]] = []
    sharing: list[tuple[str, str]] = []
    frames: list[dict[str, object]] = []
    classes_of: dict[int, list[str]] = {}
    for year in years:
        classes = classes_of[year] = [str(uuid4()) for _ in range(2)]
        frames.append(_frame(
            year, year, "08:00",
            f"{(end_minutes - (30 if year == 7 else 0)) // 60:02d}:{(end_minutes - (30 if year == 7 else 0)) % 60:02d}",
            rng.choice([0, 5, 10]),
        ))
        for class_id in classes:
            eating.append((class_id, year, year))
            for _ in range(rng.randint(1, 2)):
                requirements.append(_entry(
                    class_id, rng.choice([*pool, str(uuid4())]),
                    rng.randint(2, 4), rng.choice([40, 50]), year, year,
                ))
        for _ in range(rng.randint(1, 2)):
            group = str(uuid4())
            requirements.append(_entry(group, rng.choice(pool), rng.randint(2, 4), 40, year, year))
            sharing.extend((class_id, group) for class_id in classes)
    if len(years) == 2:
        across = str(uuid4())
        requirements.append(_entry(across, rng.choice(pool), rng.randint(2, 3), 40, 7, 8))
        sharing.extend((classes_of[year][0], across) for year in years)
    meal = ("10:00", "11:30", rng.choice([15, 20, 30])) if rng.random() < 0.8 else None
    closed = (rng.choice(eating)[0],) if meal and rng.random() < 0.3 else ()
    placed = (
        ((rng.choice(eating)[0], 2, rng.choice(["10:00", "10:30", "16:00"])),)
        if meal and rng.random() < 0.3 else ()
    )
    return _small(
        requirements, frames, eating=tuple(eating) if meal else (), meal=meal,
        closed=closed, sharing=tuple(sharing), placed=placed,
    )


@pytest.mark.slow
def test_the_count_never_refuses_a_week_the_model_solves() -> None:
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2"))
    conclusive = 0
    for seed in range(SMOKE_WEEKS):
        refused_at = None
        for shorter in range(0, 40):
            payload = _random_week(random.Random(seed), 15 * 60 - 10 * shorter)
            try:
                request = _request(payload)
                solver._validate_request(request)
            except InvalidScheduleInputError:
                break
            if any(load.over for load in solver._week_loads(request)):
                refused_at = payload if shorter else None
                break
        if refused_at is None:
            continue
        request = _request(refused_at)
        model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
        search = cp_model.CpSolver()
        search.parameters.num_workers = 2
        search.parameters.random_seed = 0
        search.parameters.max_time_in_seconds = 8.0
        status = search.Solve(model)
        assert status not in (cp_model.OPTIMAL, cp_model.FEASIBLE), (
            f"seed {seed}: the count refused a week the model solves"
        )
        if status == cp_model.INFEASIBLE:
            conclusive += 1
    assert conclusive >= SMOKE_WEEKS // 3, "too few weeks reached a refusal to mean anything"


# ---------------------------------------------------------------------------
# The sentences
# ---------------------------------------------------------------------------


def test_the_sentences_read_as_sentences() -> None:
    assert render(
        "DEMAND_YEAR_WEEK_SHORT",
        {"grades": "8", "demandMinutes": 2210, "capacityMinutes": 2200, "shared": "some"},
    ).startswith("The week does not hold year 8")
    assert "the classes with unknown years" in render(
        "DEMAND_YEAR_WEEK_SHORT",
        {"grades": "any", "demandMinutes": 1, "capacityMinutes": 1, "shared": "none"},
    )
    assert "3 groups of year 8" in render(
        "TEACHER_SHARED_BY_PARALLEL_GROUPS", {"groups": 3, "minutes": 480, "grades": "8"},
    )
    assert "1 group of year 8" in render(
        "TEACHER_SHARED_BY_PARALLEL_GROUPS", {"groups": 1, "minutes": 40, "grades": "8"},
    )
