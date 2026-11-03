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
from uuid import uuid4

import pytest
from ortools.linear_solver import pywraplp
from ortools.sat.python import cp_model

from app.config import Settings
from app.messages import render
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleRequest
from app.solver import scheduler_solver, week_load
from app.solver.scheduler_solver import SchedulerSolver

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
) -> dict[str, object]:
    """Year 8: five classes, five language groups, three of them one teacher's.

    `shared=False` gives every group a teacher of its own (the school's fix),
    `block=True` also declares the five a parallel block (their other half).
    `parity` marks groups, by position, as odd or even weeks only.
    """
    requirements: list[dict[str, object]] = []
    for position, class_id in enumerate(CLASSES):
        requirements.append({
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": class_id,
            "teacherId": str(uuid4()),
            "lessonsPerWeek": class_lessons,
            "minutesPerLesson": 50,
            "studentGroupSize": 24,
            "minGradeLevel": 8,
            "maxGradeLevel": 8,
        })
    block_id = str(uuid4())
    group_rows: list[dict[str, object]] = []
    for position, group_id in enumerate(GROUPS):
        teacher = SHARED_TEACHER if shared and position < 3 else str(uuid4())
        row: dict[str, object] = {
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": group_id,
            "teacherId": teacher,
            "lessonsPerWeek": 4,
            "minutesPerLesson": 40,
            "studentGroupSize": 20,
            "minGradeLevel": 8,
            "maxGradeLevel": 8,
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
            {"id": class_id, "lunchHeadcount": 24, "minGradeLevel": 8, "maxGradeLevel": 8}
            for class_id in CLASSES
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(10)],
        "groupConflicts": [[c, g] for c in CLASSES for g in GROUPS],
        "frameTimes": [FRAME],
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


def test_a_year_above_its_frame_is_refused_in_microseconds_and_named() -> None:
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
        "grades": "8", "demandMinutes": 2210, "capacityMinutes": WEEK,
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
# The sentences
# ---------------------------------------------------------------------------


def test_the_sentences_read_as_sentences() -> None:
    assert render(
        "DEMAND_YEAR_WEEK_SHORT",
        {"grades": "8", "demandMinutes": 2210, "capacityMinutes": 2200},
    ).startswith("The week does not hold year 8")
    assert "the classes with unknown years" in render(
        "DEMAND_YEAR_WEEK_SHORT",
        {"grades": "any", "demandMinutes": 1, "capacityMinutes": 1},
    )
    assert "3 groups of year 8" in render(
        "TEACHER_SHARED_BY_PARALLEL_GROUPS", {"groups": 3, "minutes": 480, "grades": "8"},
    )
    assert "1 group of year 8" in render(
        "TEACHER_SHARED_BY_PARALLEL_GROUPS", {"groups": 1, "minutes": 40, "grades": "8"},
    )
