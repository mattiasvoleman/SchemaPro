"""The guard around every CP-SAT Solve: a throw is retried, then an answer that does not lie.

CP-SAT 9.15.6755's presolve threw `IndexError:
absl::container_internal::raw_hash_map<>::at` out of Solve on a model it had
accepted, and the school's Generera came back a 500. The builders no longer
post the rows that set it off (_day_totals); _solve_guarded is what keeps the
next such row from reaching a school the same way.

TWO KINDS OF THROW. The injected one — CpSolver.Solve patched to raise what
9.15 raised — decides exactly which solve throws, so every path a caller
takes on a failed solve can be walked. The real one is that crash itself,
kept: a week of the shape the fuzz found, written straight in CP-SAT with
the rows the builders used to post, which 9.15.6755's presolve still throws
on today.
"""

from __future__ import annotations

import ast
import logging
import time
from collections.abc import Callable
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import (
    SchedulerSolver,
    SolverCrashedError,
    _day_totals,
    _solve_guarded,
)

API_KEY = "test-api-key-000000000000000000000000"
#: The id an injected throw quotes, as a CP-SAT message quoting a variable would.
QUOTED = str(uuid4())
#: The request a direct call to the guard is made for.
REQUEST = uuid4()
REAL_SOLVE = cp_model.CpSolver.Solve
LOGGER = "app.solver.scheduler_solver"


def _throwing(
    monkeypatch: pytest.MonkeyPatch,
    when: Callable[[cp_model.CpSolver, cp_model.CpModel], bool],
    *,
    before: float = 0.0,
) -> list[dict[str, float | bool]]:
    """CpSolver.Solve, made to throw whenever `when` says so and to solve for
    real otherwise. Returns every call, with the presolve and the time limit
    it ran under and when it began. `before` is wall-clock a throw spends
    first."""
    calls: list[dict[str, float | bool]] = []

    def solve(self, model, solution_callback=None):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202
        calls.append({
            "presolve": self.parameters.cp_model_presolve,
            "seconds": self.parameters.max_time_in_seconds,
            "at": time.monotonic(),
        })
        if when(self, model):
            time.sleep(before)
            raise IndexError(f"absl::container_internal::raw_hash_map<>::at {QUOTED}")
        return REAL_SOLVE(self, model, solution_callback)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    return calls


def _with_presolve(solver: cp_model.CpSolver, _model: cp_model.CpModel) -> bool:
    return solver.parameters.cp_model_presolve


def _always(_solver: cp_model.CpSolver, _model: cp_model.CpModel) -> bool:
    return True


def _small_model() -> tuple[cp_model.CpModel, cp_model.IntVar]:
    model = cp_model.CpModel()
    x = model.NewIntVar(0, 10, "x")
    model.Add(x >= 3)
    return model, x


def _solver(seconds: float = 5.0) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = seconds
    return solver


def _guarded(solver: cp_model.CpSolver, model: cp_model.CpModel, what: str, **kwargs: object):  # type: ignore[no-untyped-def]  # noqa: ANN202
    return _solve_guarded(solver, model, what=what, request_id=REQUEST, **kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _solve_guarded itself
# ---------------------------------------------------------------------------


def test_a_throw_from_presolve_is_solved_once_more_without_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _with_presolve)
    model, x = _small_model()
    solver = _solver()

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        code = _guarded(solver, model, "phase 1a")

    assert code == cp_model.OPTIMAL
    assert solver.Value(x) >= 3
    assert [call["presolve"] for call in calls] == [True, False]
    # Handed back as it was given, but for its answer.
    assert solver.parameters.cp_model_presolve is True
    assert solver.parameters.max_time_in_seconds == 5.0
    [record] = caplog.records
    assert record.levelno == logging.WARNING
    assert "IndexError in phase 1a" in record.getMessage()
    assert "raw_hash_map" in record.getMessage()


def test_the_log_names_the_request_and_never_the_school_s_ids(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """The request as _timeout_diagnosis writes it, so two candidates solving
    side by side are told apart; the exception's ids taken out."""
    _throwing(monkeypatch, _always)
    model, _x = _small_model()

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        _guarded(_solver(), model, "phase 2")

    assert len(caplog.records) == 2
    for record in caplog.records:
        assert f"[requestId={REQUEST}]" in record.getMessage()
        assert QUOTED not in record.getMessage()
        assert "<id>" in record.getMessage()


def test_a_throw_without_presolve_too_is_unknown_where_the_caller_can_say_more(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _always)
    model, _x = _small_model()
    solver = _solver()

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        code = _guarded(solver, model, "phase 2")

    assert code == cp_model.UNKNOWN
    assert [call["presolve"] for call in calls] == [True, False]
    assert solver.parameters.cp_model_presolve is True
    assert solver.parameters.max_time_in_seconds == 5.0
    assert [record.levelno for record in caplog.records] == [logging.WARNING, logging.ERROR]
    assert "again without presolve" in caplog.records[1].getMessage()


@pytest.mark.parametrize("before", [0.0, 0.25], ids=["retried", "no time to retry"])
def test_a_solve_that_must_not_degrade_raises_what_threw_without_its_ids(
    monkeypatch: pytest.MonkeyPatch, before: float,
) -> None:
    """Phase 1b's: its UNKNOWN would tell the school its week needs a longer
    budget, which a crash does not."""
    calls = _throwing(monkeypatch, _always, before=before)
    model, _x = _small_model()
    solver = _solver(0.2)

    with pytest.raises(SolverCrashedError) as raised:
        _guarded(solver, model, "phase 1b", degrade=False)

    text = str(raised.value)
    assert "IndexError in phase 1b" in text
    assert f"[requestId={REQUEST}]" in text
    assert QUOTED not in text
    # Not chained: the traceback main.py logs would print the original's text.
    assert raised.value.__suppress_context__
    assert len(calls) == (2 if before == 0.0 else 1)
    assert solver.parameters.cp_model_presolve is True


def test_the_retry_gets_what_the_first_attempt_left_of_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never a second limit: the school's budget is paid once."""
    calls = _throwing(monkeypatch, _with_presolve, before=0.3)
    model, _x = _small_model()

    assert _guarded(_solver(5.0), model, "phase 2") == cp_model.OPTIMAL

    assert calls[0]["seconds"] == 5.0
    assert 0 < calls[1]["seconds"] <= 4.7


def test_a_throw_that_spent_the_whole_limit_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _with_presolve, before=0.25)
    model, _x = _small_model()

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        code = _guarded(_solver(0.2), model, "the timeout probe")

    assert code == cp_model.UNKNOWN
    assert len(calls) == 1
    [record] = caplog.records
    assert record.levelno == logging.ERROR
    assert "no time left" in record.getMessage()


@pytest.mark.parametrize("throws_on", ["the first attempt", "the retry"])
def test_our_own_refusal_passes_through_unretried(
    monkeypatch: pytest.MonkeyPatch, throws_on: str,
) -> None:
    """An OptimizationEngineError means something its own handler tells the
    school; the guard is for CP-SAT's throws, not ours."""
    ours = InvalidScheduleInputError.of("INPUT_NO_ROOMS")
    attempts: list[bool] = []

    def solve(self, model, solution_callback=None):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202, ARG001
        attempts.append(self.parameters.cp_model_presolve)
        if throws_on == "the retry" and self.parameters.cp_model_presolve:
            raise IndexError("absl::container_internal::raw_hash_map<>::at")
        raise ours

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    model, _x = _small_model()

    with pytest.raises(InvalidScheduleInputError) as raised:
        _guarded(_solver(), model, "phase 1a")

    assert raised.value is ours
    assert len(attempts) == (1 if throws_on == "the first attempt" else 2)


def test_a_solver_without_the_solve_alias_fails_loudly() -> None:
    """Solve is OR-Tools' deprecated alias of solve. An upgrade that removes
    it must break every call here, not be caught and turn every solve into
    a TIMEOUT."""

    class WithoutTheAlias:
        parameters = cp_model.CpSolver().parameters

    model, _x = _small_model()

    with pytest.raises(AttributeError):
        _guarded(WithoutTheAlias(), model, "phase 1a")  # type: ignore[arg-type]


def _unguarded_solves(source: str) -> list[int]:
    """The lines of every CP-SAT solve outside _solve_guarded: Solve and
    solve, their solution-callback forms, on a name or on a call's result.
    SchedulerSolver(...).solve is the scheduler's own method, not CP-SAT's."""
    names = {"Solve", "solve", "SolveWithSolutionCallback", "solve_with_solution_callback"}
    lines: list[int] = []

    def visit(node: ast.AST, inside_guard: bool) -> None:
        if isinstance(node, ast.FunctionDef) and node.name == "_solve_guarded":
            inside_guard = True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in names
            and not inside_guard
            and not (
                isinstance(node.func.value, ast.Call)
                and isinstance(node.func.value.func, ast.Name)
                and node.func.value.func.id == "SchedulerSolver"
            )
        ):
            lines.append(node.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child, inside_guard)

    visit(ast.parse(source), inside_guard=False)
    return lines


def test_the_inventory_finds_every_form_of_solve() -> None:
    source = "\n".join([
        "def _solve_guarded(solver, model):",
        "    return solver.Solve(model)",
        "def f(self, m, s, cb, scoped, request):",
        "    s.Solve(m)",
        "    self._lunch_stage_solver(3.0).Solve(m)",
        "    cp_model.CpSolver().Solve(m)",
        "    s.SolveWithSolutionCallback(m, cb)",
        "    s.solve(m)",
        "    return SchedulerSolver(scoped).solve(request)",
    ])

    assert _unguarded_solves(source) == [4, 5, 6, 7, 8]


def test_no_solve_in_the_scheduler_bypasses_the_guard() -> None:
    """Nine solves go through the guard today — the lunch stage and its
    naming, phases 1a, 1b and 2, the hint completion, the explanation and the
    two probes. A Solve written tomorrow is the one nobody fuzzed."""
    import app.solver.scheduler_solver as module

    lines = _unguarded_solves(Path(module.__file__).read_text())

    assert lines == [], f"CP-SAT solved outside _solve_guarded on lines {lines}"


# ---------------------------------------------------------------------------
# What solve() answers when its solves throw
# ---------------------------------------------------------------------------


def _settings(**overrides: object) -> Settings:
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            "SOLVER_MAX_TIME_SECONDS": 10.0,
            **overrides,
        },
    )


def _payload(
    lessons_per_week: int = 2, minutes_per_lesson: int = 60, **requirement: object,
) -> dict[str, object]:
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": str(uuid4()),
                "teacherId": str(uuid4()),
                "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": minutes_per_lesson,
                "studentGroupSize": 24,
                **requirement,
            },
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
    }


def _lunch_payload() -> dict[str, object]:
    """Two classes of 30 and a hall of 60 that seats them both at 11:00: the
    lunch stage runs, and a timetable exists."""
    groups = [str(uuid4()), str(uuid4())]
    return {
        **_payload(),
        "requirements": [
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
                "teacherId": str(uuid4()), "lessonsPerWeek": 1, "minutesPerLesson": 60,
                "studentGroupSize": 30,
            }
            for group in groups
        ],
        "groups": [{"id": group, "lunchHeadcount": 30} for group in groups],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in groups],
        "rules": {
            "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00", "lunchMinutes": 60,
            "diningSeats": 60,
        },
    }


def _solve(payload: dict[str, object], **settings: object):  # type: ignore[no-untyped-def]  # noqa: ANN202
    return SchedulerSolver(_settings(**settings)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )


def test_a_week_whose_every_presolve_throws_still_gets_its_timetable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _throwing(monkeypatch, _with_presolve)

    response = _solve(_payload())

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 2
    # Phase 1a and phase 2, each thrown once and solved without presolve.
    assert [call["presolve"] for call in calls] == [True, False, True, False]


def test_no_solve_runs_past_the_request_s_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """Across a whole solve(), with a throw that costs time in both phases:
    every limit a Solve is given ends inside the budget phase 1a started.
    A retry paid from a fresh limit would end past it."""
    budget = 4.0
    calls = _throwing(monkeypatch, _with_presolve, before=0.5)

    response = _solve(_payload(), SOLVER_MAX_TIME_SECONDS=budget)

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(calls) == 4
    start = calls[0]["at"]
    for call in calls:
        assert call["at"] - start + call["seconds"] <= budget + 0.05, calls
    # The throws' own half-seconds came off what followed them.
    assert calls[1]["seconds"] <= budget - 0.5
    assert calls[3]["seconds"] <= budget - 1.0


def test_a_phase_2_that_throws_twice_returns_phase_1_s_timetable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reason the guard sits on each Solve and not around solve(): phase
    1 had found a timetable, and a throw in the phase that only improves it
    must not cost the school that one."""
    _throwing(monkeypatch, lambda _solver, model: model.Proto().has_objective())

    response = _solve(_payload())

    assert response.status == "FEASIBLE"
    assert len(response.lessons) == 2


def test_a_lunch_stage_that_throws_twice_leaves_the_week_to_the_full_model(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    # The stage's solver is the one that asks for the full linearization.
    calls = _throwing(
        monkeypatch, lambda solver, _model: solver.parameters.linearization_level == 2,
    )

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        response = _solve(_lunch_payload())

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 2
    assert len(response.lunches) == 10
    assert [call["presolve"] for call in calls[:2]] == [True, False]
    assert ["the lunch stage" in record.getMessage() for record in caplog.records] == [True, True]


def test_a_hint_completion_that_throws_twice_leaves_phase_2_its_partial_hint(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """Only a request with `search` completes its hint; a schemaförslag
    candidate whose completion throws is still solved."""
    _throwing(
        monkeypatch,
        lambda solver, _model: solver.parameters.fix_variables_to_their_hinted_value,
    )

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        response = _solve({**_payload(), "search": {"seed": 7}})

    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(response.lessons) == 2
    assert [
        "the hint completion" in record.getMessage()
        for record in caplog.records if record.levelno >= logging.WARNING
    ] == [True, True]


def test_a_timeout_probe_that_throws_twice_finds_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """Phases 1a and 1b run out of time for real, and the one rule the week
    can be probed without — its ten minutes before each lesson — is probed
    by a solve that throws. The TIMEOUT stands, with the probe's verdict
    that nothing helped: a probe is a measurement, never a proof."""
    seen: list[str] = []

    def solve(self, model, solution_callback=None):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202, ARG001
        seen.append("solve")
        if len(seen) <= 2:
            return cp_model.UNKNOWN
        raise IndexError("absl::container_internal::raw_hash_map<>::at")

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        response = _solve(_payload(minutesBefore=10))

    assert response.status == "TIMEOUT"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "PROBE_NOTHING_HELPED"
    assert len(seen) == 4
    assert any("the timeout probe" in record.getMessage() for record in caplog.records)


def test_a_proved_week_whose_explanation_throws_is_an_unexplained_infeasible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Forty four-hour lessons in a fifty-hour week: phase 1 proves it, and
    the assumption solve that would name the cause throws, twice. The proof
    stands; the names are what is lost."""
    _throwing(monkeypatch, lambda _solver, model: len(model.Proto().assumptions) > 0)

    response = _solve(_payload(lessons_per_week=40, minutes_per_lesson=240))

    assert response.status == "INFEASIBLE"
    assert response.lessons == []
    assert response.conflicts is None


def test_a_week_whose_every_solve_throws_raises_and_runs_no_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Phase 1a throws twice and hands over; phase 1b throws twice, and with
    nothing left to find a timetable the crash is raised rather than read as
    a TIMEOUT. The week carries a rule the TIMEOUT probe would relax, and no
    probe is run: four solves in all."""
    calls = _throwing(monkeypatch, _always)

    with pytest.raises(SolverCrashedError, match="IndexError in phase 1b again without presolve"):
        _solve(_payload(minutesBefore=10))

    assert [call["presolve"] for call in calls] == [True, False, True, False]


def test_through_the_api_that_crash_is_the_500_it_always_was(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """As the gateway sees it: the generic 500, never a TIMEOUT that would
    send the school to raise its budget for a week that crashed in 0.00 s."""
    _throwing(monkeypatch, _always)
    client = TestClient(create_app(_settings()), raise_server_exceptions=False)

    response = client.post(
        "/api/v1/optimize", json=_payload(minutesBefore=10), headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 500
    assert response.json()["code"] == "INTERNAL_SERVER_ERROR"


# ---------------------------------------------------------------------------
# The crash itself
# ---------------------------------------------------------------------------


def _add_the_old_rows(model: cp_model.CpModel, *, on_day_totals: bool = False) -> None:
    """A week of the shape the fuzz found, straight in CP-SAT and beside
    whatever `model` already holds: one room over two days of sixty slots, a
    lesson of another class in a block with the first of five lessons of one
    class, and those five at most two a day. Impossible by count.

    The two days' rows as the builders posted them, `Σ on_day ≤ 2`, are what
    9.15.6755's presolve throws on: its duplicate pass makes one row of the
    two, bounded both ways, and proves the week impossible, and the symmetry
    detection after it runs on the impossible model (google/or-tools#5494,
    fixed after 9.15). `on_day_totals` posts the same cap as the builders do
    now (_day_totals). The block's literal is pinned, as phase 1 pins every
    rule's."""
    on_grid = cp_model.Domain.FromValues(range(0, 120, 6))
    starts = [model.NewIntVarFromDomain(on_grid, f"old_start_{i}") for i in range(7)]
    model.AddNoOverlap([
        model.NewFixedSizeIntervalVar(start, 6, f"old_lesson_{i}") for i, start in enumerate(starts)
    ])
    together = model.NewBoolVar("old_block")
    model.AddBoolAnd([together])
    model.Add(starts[0] == starts[5]).OnlyEnforceIf(together)
    days = []
    for i in range(5):
        day = model.NewIntVar(0, 1, f"old_day_{i}")
        model.AddDivisionEquality(day, starts[i], 60)
        days.append(day)
    on_days = {}
    for day_index in (0, 1):
        on_day = []
        for i, day in enumerate(days):
            on = model.NewBoolVar(f"old_on_{day_index}_{i}")
            model.Add(day == day_index).OnlyEnforceIf(on)
            model.Add(day != day_index).OnlyEnforceIf(on.Not())
            on_day.append(on)
        on_days[day_index] = sum(on_day)
    if on_day_totals:
        _day_totals(model, "old_count", on_days, dict.fromkeys(on_days, 2), len(days))
    else:
        for on_day_sum in on_days.values():
            model.Add(on_day_sum <= 2)


def _the_crashing_model() -> cp_model.CpModel:
    model = cp_model.CpModel()
    _add_the_old_rows(model)
    return model


def test_cp_sat_s_own_presolve_crash_is_answered_and_not_raised() -> None:
    """The bare Solve is the witness that this is still the real crash. When
    an OR-Tools upgrade stops it throwing, the upstream bug is fixed: keep
    the guard, and find this test a new witness or drop its first half."""
    with pytest.raises(IndexError, match="raw_hash_map"):
        _solver(10.0).Solve(_the_crashing_model())

    assert _guarded(_solver(10.0), _the_crashing_model(), "phase 1a") == cp_model.INFEASIBLE


def test_the_same_week_on_day_totals_is_refused_by_presolve() -> None:
    """The cure on the witness itself: the same lessons and the same cap, a
    count per day with the counts summing to the five. Presolve refutes the
    week on that sum, and nothing throws."""
    model = cp_model.CpModel()
    _add_the_old_rows(model, on_day_totals=True)
    solver = _solver(10.0)
    solver.parameters.stop_after_presolve = True

    assert solver.Solve(model) == cp_model.INFEASIBLE


def test_a_build_that_crashes_presolve_is_refused_by_solve_and_not_a_500(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """The old rows, added beside every model solve() builds for a week that
    has a timetable: each build now throws in presolve, and the week is
    refused on the proof phase 1a finds without it."""
    build = SchedulerSolver._build_model

    def crashing_build(self, request, **kwargs):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202
        built = build(self, request, **kwargs)
        _add_the_old_rows(built[0])
        return built

    monkeypatch.setattr(SchedulerSolver, "_build_model", crashing_build)

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        response = _solve(_payload(), SOLVER_PROBE_SECONDS=0)

    assert response.status == "INFEASIBLE"
    assert any(
        "IndexError in phase 1a" in record.getMessage() for record in caplog.records
    )


# ---------------------------------------------------------------------------
# What the fuzz of the older rows found
# ---------------------------------------------------------------------------
#
# A generator that piled the rest, lunch, distribution and Lärarens dag rows
# onto one teacher's few open days ran 6,600 weeks on 2026-10-23; 5,865 passed
# _validate_request, and 25 of those made 9.15.6755's presolve throw the same
# IndexError. Three row families, each kept here by its smallest week:
# a class's daily maximum (21 of the 25), a subject's per-day cap (3), and
# Lärarens dag's own cap once presolve has fixed `works` to 1 (1), which is
# the constant form again. Each one was a 500 on the engine before the guard.
# Every one also holds a parallel block, has its lessons' days narrowed to two
# or three, and is impossible by count. No rest or lunch row threw on its
# own in 2,400 weeks without the two count rows.
#
# The three builders now cap a count or the minutes per day, the days summing
# to the week (_day_totals), and presolve refutes each of these weeks on that
# sum instead of throwing; the guard's retry without presolve, which on a
# large school may not finish where presolve's proof was instant, is no
# longer what answers them.


def _id(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _requirement(
    n: int, group: int, teacher: int, lessons: int, minutes: int, **rest: object,
) -> dict[str, object]:
    return {
        "id": _id(n), "subjectId": _id(n + 1), "studentGroupId": _id(group),
        "teacherId": _id(teacher), "lessonsPerWeek": lessons, "minutesPerLesson": minutes,
        "studentGroupSize": 24, **rest,
    }


def _lock(n: int, teacher: int, day: int, start: str, end: str) -> dict[str, object]:
    return {
        "id": _id(n), "teacherId": _id(teacher), "studentGroupId": _id(n + 1),
        "dayOfWeek": day, "startTime": start, "endTime": end,
    }


def _a_class_s_daily_maximum() -> tuple[dict[str, object], dict[str, object]]:
    """Class 10 has five lessons, at most two a day, and its teacher a post of
    two days, the two their locks hold."""
    return {"SCHEDULE_DAY_START_MINUTES": 480, "SCHEDULE_DAY_END_MINUTES": 1080}, {
        "requestId": _id(1), "academicYearId": _id(2),
        "requirements": [
            _requirement(3, 5, 6, 2, 30, blockId=_id(7)),
            _requirement(8, 10, 11, 2, 30, blockId=_id(7)),
            _requirement(12, 10, 11, 3, 30),
        ],
        "rooms": [{"id": _id(14), "capacity": 30}],
        "fixedLessons": [
            _lock(15, 11, 3, "11:05:00", "12:05:00"), _lock(17, 11, 5, "08:50:00", "09:50:00"),
        ],
        "teacherDayLimits": [
            {"id": _id(19), "teacherId": _id(11), "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[3, 5]]},
        ],
        "rules": {"maxLessonsPerDayPerGroup": 2},
    }


def _a_subject_s_per_day_cap() -> tuple[dict[str, object], dict[str, object]]:
    """Five lessons of a subject capped at two a day, from a teacher on a
    one-day post whose locks hold three days."""
    return {"SCHEDULE_DAY_START_MINUTES": 480, "SCHEDULE_DAY_END_MINUTES": 720}, {
        "requestId": _id(1), "academicYearId": _id(2),
        "requirements": [
            _requirement(3, 5, 6, 1, 30, blockId=_id(7)),
            _requirement(8, 10, 11, 1, 30, blockId=_id(7)),
            _requirement(12, 5, 11, 5, 30, maxLessonsPerDay=2, lockedDays=[1, 1]),
        ],
        "rooms": [{"id": _id(14), "capacity": 30}],
        "fixedLessons": [
            _lock(15, 11, 1, "09:00:00", "09:45:00"),
            _lock(17, 11, 5, "09:15:00", "10:35:00"),
            _lock(19, 11, 3, "09:35:00", "10:15:00"),
        ],
        "teacherDayLimits": [
            {"id": _id(21), "teacherId": _id(11), "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[1, 3, 5]]},
        ],
    }


def _a_teacher_s_cap_on_forced_days() -> tuple[dict[str, object], dict[str, object]]:
    """Teacher 6 has 535 minutes on the two days the frames leave them and a
    cap of 265 a day, so both days must be worked: presolve fixes `works` to
    1, and `≤ 265·works` was `≤ 265` again: times `works` alone was not the
    cure. A cap on each day's minutes, the days' minutes summing to the
    week's 535, is."""
    grade = {"minGradeLevel": 7, "maxGradeLevel": 7}

    def closed(grade_level: int, day: int) -> dict[str, object]:
        return {
            "minGradeLevel": grade_level, "maxGradeLevel": grade_level, "dayOfWeek": day,
            "startTime": "06:00:00", "endTime": "07:00:00",
        }

    return {
        "SCHEDULE_DAYS": "1,2,3,4,5,6",
        "SCHEDULE_DAY_START_MINUTES": 480,
        "SCHEDULE_DAY_END_MINUTES": 840,
    }, {
        "requestId": _id(1), "academicYearId": _id(2),
        "requirements": [
            _requirement(3, 5, 6, 3, 100, lessonLengths=[100, 30, 60], **grade),
            _requirement(7, 9, 10, 3, 70, lessonLengths=[60, 70, 45], blockId=_id(11), **grade),
            _requirement(
                12, 14, 15, 3, 70, lessonLengths=[60, 70, 45], coTeacherId=_id(6),
                blockId=_id(11), minDaysBetween=2, lockedDays=[3],
                minGradeLevel=8, maxGradeLevel=8,
            ),
            _requirement(16, 5, 6, 4, 60, lessonLengths=[60, 40, 40, 30], **grade),
        ],
        "rooms": [{"id": _id(18), "capacity": 30}],
        "teacherWorkRules": [
            {"id": _id(19), "teacherId": _id(6), "maxTeachingMinutesPerDay": 265},
        ],
        "frameTimes": [closed(8, 5), closed(7, 1), closed(7, 3), closed(7, 4), closed(7, 5)],
    }


@pytest.mark.parametrize(
    "week",
    [_a_class_s_daily_maximum, _a_subject_s_per_day_cap, _a_teacher_s_cap_on_forced_days],
    ids=["a class's daily maximum", "a subject's per-day cap", "a teacher's cap on forced days"],
)
def test_a_week_the_fuzz_found_is_refused_by_name_and_not_a_500(
    week: Callable[[], tuple[dict[str, object], dict[str, object]]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Accepted by the pre-flights, proved impossible by a bare Solve's
    presolve — which threw on all three before the day totals — and refused
    by solve() with the causes named, the guard never called on."""
    settings, payload = week()
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **settings))
    solver._validate_request(request)
    for kwargs in (
        {"use_assumptions": False, "include_objective": False},
        {"use_assumptions": False, "include_objective": True},
    ):
        model, *_rest = solver._build_model(request, **kwargs)
        presolve_only = _solver(10.0)
        presolve_only.parameters.stop_after_presolve = True
        assert presolve_only.Solve(model) == cp_model.INFEASIBLE, kwargs

    with caplog.at_level(logging.WARNING, logger=LOGGER):
        response = solver.solve(request)

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
    assert not [record for record in caplog.records if "cp-sat raised" in record.getMessage()]


def test_the_class_s_daily_maximum_week_names_the_post_and_not_the_maximum() -> None:
    """The maximum is in that week's core, beside the block and the post, and
    is no part of the answer: the week stays impossible with no maximum at
    all, so the refusal leaves it out (_daily_maximum_verdict). With no probe
    budget the line stays, unmeasured, which is what shows the core held it."""
    settings, payload = _a_class_s_daily_maximum()
    request = OptimizeScheduleRequest.model_validate(payload)

    def codes(probe_seconds: float) -> dict[str, list[UUID]]:
        solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=probe_seconds, **settings))
        response = solver.solve(request)
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        return {
            detail.code: detail.resource_ids for detail in response.conflicts.conflicts
            if detail.code in {
                "BLOCK_CANNOT_BE_PLACED", "TEACHER_WORK_DAYS_CANNOT_BE_KEPT",
                "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT",
            }
        }

    assert codes(5) == {
        "BLOCK_CANNOT_BE_PLACED": [UUID(_id(7))],
        "TEACHER_WORK_DAYS_CANNOT_BE_KEPT": [UUID(_id(19))],
    }
    assert codes(0)["GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"] == [UUID(_id(10))]


def _dist_500057() -> tuple[dict[str, object], dict[str, object]]:
    """The review's week: class 10 has eleven lessons under at most one a day
    on a five-day week, and the week is impossible without the maximum too —
    a post of two days, a teacher's daily cap, a block and the rest."""
    years = {7: {"minGradeLevel": 7, "maxGradeLevel": 7}, 8: {"minGradeLevel": 8, "maxGradeLevel": 8}}

    def frame(day: int, start: str, end: str) -> dict[str, object]:
        return {**years[8], "dayOfWeek": day, "startTime": start, "endTime": end}

    return {"SCHEDULE_DAY_START_MINUTES": 480, "SCHEDULE_DAY_END_MINUTES": 720}, {
        "requestId": _id(1), "academicYearId": _id(2),
        "requirements": [
            _requirement(
                3, 5, 6, 2, 120, **years[8], lessonLengths=[120, 60], blockId=_id(7),
                maxLessonsPerDay=2, lockedDays=[1, 6],
            ),
            _requirement(
                8, 10, 11, 2, 120, **years[7], lessonLengths=[120, 60], minutesAfter=10,
                blockId=_id(7), maxLessonsPerDay=1, minDaysBetween=4, lockedDays=[],
            ),
            _requirement(
                12, 10, 11, 4, 40, **years[7], studentGroupSize=16,
                lessonLengths=[30, 30, 40, 40], maxLessonsPerDay=2, lockedDays=[1, 2, 2],
            ),
            _requirement(
                14, 10, 11, 2, 50, **years[7], studentGroupSize=16, minutesBefore=5,
                maxLessonsPerDay=1, minDaysBetween=2,
            ),
            _requirement(16, 10, 18, 3, 120, **years[7], lessonLengths=[60, 30, 120]),
        ],
        "rooms": [{"id": _id(19), "capacity": 30}],
        "fixedLessons": [
            _lock(20, 11, 2, "10:57:00", "11:37:00"),
            _lock(22, 11, 2, "09:40:00", "10:00:00"),
            {
                "id": _id(24), "teacherId": None, "studentGroupId": _id(10), "dayOfWeek": 4,
                "startTime": "07:30:00", "endTime": "08:30:00",
            },
            {
                "id": _id(25), "teacherId": _id(26), "studentGroupId": _id(5), "dayOfWeek": 4,
                "startTime": "08:53:00", "endTime": "10:13:00",
            },
        ],
        "teacherWorkRules": [
            {"id": _id(27), "teacherId": _id(11), "maxTeachingMinutesPerDay": 220, "preferredFreeDay": 2},
        ],
        "teacherDayLimits": [
            {"id": _id(28), "teacherId": _id(11), "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[2]]},
        ],
        "frameTimes": [
            frame(3, "06:00:00", "07:00:00"), frame(4, "06:00:00", "07:00:00"),
            frame(5, "08:30:00", "11:30:00"),
        ],
        "groups": [
            {"id": _id(10), "lunchHeadcount": 24, **years[7]},
            {"id": _id(29), "lunchHeadcount": 20, **years[7]},
            {"id": _id(5), "lunchHeadcount": 24, **years[8]},
            {"id": _id(30), "lunchHeadcount": 30, "minGradeLevel": 9, "maxGradeLevel": 9},
        ],
        "groupConflicts": [[_id(10), _id(29)]],
        "rules": {"maxLessonsPerDayPerGroup": 1},
    }


def test_a_maximum_impossible_on_its_own_leads_the_refusal_of_a_week_with_other_causes() -> None:
    """dist/500057. Without the maximum the week is still impossible, and the
    verdict's first form dropped the line for that: the school was told of its
    blocks, rooms and teacher caps, would fix them, and only then hear of the
    maximum. Eleven lessons do not fit five days at one a day whatever else
    holds, so the line stays, first and `measured` 2, naming class 10."""
    settings, payload = _dist_500057()
    request = OptimizeScheduleRequest.model_validate(payload)
    SchedulerSolver(_settings(**settings))._validate_request(request)

    response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=5, **settings)).solve(request)

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
    first = response.conflicts.conflicts[0]
    assert (first.code, first.params, first.resource_ids) == (
        "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT", {"maxPerDay": 1, "measured": 2}, [UUID(_id(10))],
    )
    assert "TEACHER_DAILY_CAP_CANNOT_BE_KEPT" in {
        detail.code for detail in response.conflicts.conflicts
    }


def test_the_lines_after_the_measured_one_keep_the_core_s_order() -> None:
    """The measured line moves to the front and nothing else moves: the rest
    of dist/500057's refusal is the unmeasured core's, line for line."""
    settings, payload = _dist_500057()
    request = OptimizeScheduleRequest.model_validate(payload)

    def lines(probe_seconds: float) -> list[tuple[str, dict[str, object]]]:
        response = SchedulerSolver(
            _settings(SOLVER_PROBE_SECONDS=probe_seconds, **settings),
        ).solve(request)
        assert response.conflicts is not None
        return [(detail.code, detail.params) for detail in response.conflicts.conflicts]

    measured, unmeasured = lines(5), lines(0)

    assert measured[0][0] == "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"
    assert len(measured) > 3
    assert measured[1:] == [
        line for line in unmeasured if line[0] != "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"
    ]
