"""The guard around every CP-SAT Solve: a throw is retried, then a status, never a 500.

CP-SAT 9.15.6755's presolve threw `IndexError:
absl::container_internal::raw_hash_map<>::at` out of Solve on a model it had
accepted, and the school's Generera came back a 500. Lärarens dag fixed the
rows that set it off; _solve_guarded is what keeps the next such row from
reaching a school the same way.

TWO KINDS OF THROW. The injected one — CpSolver.Solve patched to raise what
9.15 raised — decides exactly which solve throws, so every path a caller
takes on a failed solve can be walked. The real one is that crash itself,
kept: the Lärarens dag week with its two locked-day rows put back in the
constant form, which 9.15.6755's presolve still throws on today.
"""

from __future__ import annotations

import ast
import logging
import time
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver, _solve_guarded

API_KEY = "test-api-key-000000000000000000000000"
#: The id an injected throw quotes, as a CP-SAT message quoting a variable would.
QUOTED = str(uuid4())
REAL_SOLVE = cp_model.CpSolver.Solve


def _throwing(
    monkeypatch: pytest.MonkeyPatch,
    when: Callable[[cp_model.CpSolver, cp_model.CpModel], bool],
    *,
    error: Exception | None = None,
    before: float = 0.0,
) -> list[dict[str, float | bool]]:
    """CpSolver.Solve, made to throw whenever `when` says so and to solve for
    real otherwise. Returns every call, with the presolve and the time limit
    it ran under. `before` is wall-clock the throw spends first."""
    calls: list[dict[str, float | bool]] = []

    def solve(self, model, solution_callback=None):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202
        calls.append({
            "presolve": self.parameters.cp_model_presolve,
            "seconds": self.parameters.max_time_in_seconds,
        })
        if when(self, model):
            time.sleep(before)
            raise error or IndexError(f"absl::container_internal::raw_hash_map<>::at {QUOTED}")
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


# ---------------------------------------------------------------------------
# _solve_guarded itself
# ---------------------------------------------------------------------------


def test_a_throw_from_presolve_is_solved_once_more_without_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _with_presolve)
    model, x = _small_model()
    solver = _solver()

    with caplog.at_level(logging.WARNING, logger="app.solver.scheduler_solver"):
        code = _solve_guarded(solver, model, what="phase 1a")

    assert code == cp_model.OPTIMAL
    assert solver.Value(x) >= 3
    assert [call["presolve"] for call in calls] == [True, False]
    # Handed back as it was given, but for its answer.
    assert solver.parameters.cp_model_presolve is True
    assert solver.parameters.max_time_in_seconds == 5.0
    [record] = caplog.records
    assert record.levelno == logging.WARNING
    assert "IndexError" in record.getMessage()
    assert "phase 1a" in record.getMessage()
    assert "raw_hash_map" in record.getMessage()


def test_the_log_names_the_exception_and_never_an_id(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    _throwing(monkeypatch, _always)
    model, _x = _small_model()

    with caplog.at_level(logging.WARNING, logger="app.solver.scheduler_solver"):
        _solve_guarded(_solver(), model, what="phase 2")

    assert len(caplog.records) == 2
    for record in caplog.records:
        assert QUOTED not in record.getMessage()
        assert "<id>" in record.getMessage()


def test_a_throw_without_presolve_too_is_unknown_and_never_an_exception(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _always)
    model, _x = _small_model()
    solver = _solver()

    with caplog.at_level(logging.WARNING, logger="app.solver.scheduler_solver"):
        code = _solve_guarded(solver, model, what="phase 1b")

    assert code == cp_model.UNKNOWN
    assert [call["presolve"] for call in calls] == [True, False]
    assert solver.parameters.cp_model_presolve is True
    assert solver.parameters.max_time_in_seconds == 5.0
    assert [record.levelno for record in caplog.records] == [logging.WARNING, logging.ERROR]
    assert "again without presolve" in caplog.records[1].getMessage()


def test_the_retry_gets_what_the_first_attempt_left_of_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never a second limit: the school's budget is paid once."""
    calls = _throwing(monkeypatch, _with_presolve, before=0.3)
    model, _x = _small_model()

    assert _solve_guarded(_solver(5.0), model, what="phase 2") == cp_model.OPTIMAL

    assert calls[0]["seconds"] == 5.0
    assert 0 < calls[1]["seconds"] <= 4.7


def test_a_throw_that_spent_the_whole_limit_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    calls = _throwing(monkeypatch, _with_presolve, before=0.25)
    model, _x = _small_model()

    with caplog.at_level(logging.WARNING, logger="app.solver.scheduler_solver"):
        code = _solve_guarded(_solver(0.2), model, what="the timeout probe")

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
        _solve_guarded(_solver(), model, what="phase 1a")

    assert raised.value is ours
    assert len(attempts) == (1 if throws_on == "the first attempt" else 2)


def test_no_solve_in_the_scheduler_bypasses_the_guard() -> None:
    """Nine solves go through the guard today — the lunch stage and its
    naming, phases 1a, 1b and 2, the hint completion, the explanation and the
    two probes — and the tests above walk only the ones a payload reaches
    cheaply. A Solve written tomorrow is the one nobody fuzzed."""
    import app.solver.scheduler_solver as module

    tree = ast.parse(Path(module.__file__).read_text())
    outside: list[int] = []

    def visit(node: ast.AST, inside_guard: bool) -> None:
        if isinstance(node, ast.FunctionDef) and node.name == "_solve_guarded":
            inside_guard = True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"Solve", "solve"}
            and not inside_guard
            # SchedulerSolver(scoped).solve(request): the method, not CP-SAT's.
            and not (isinstance(node.func.value, ast.Call))
        ):
            outside.append(node.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child, inside_guard)

    visit(tree, inside_guard=False)
    assert outside == [], f"CpSolver.Solve called outside _solve_guarded on lines {outside}"


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


def _payload(lessons_per_week: int = 2, minutes_per_lesson: int = 60) -> dict[str, object]:
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
            },
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
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


def test_a_week_whose_every_solve_throws_is_a_timeout_and_never_a_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Through the API, as the gateway sees it. Nothing was decided, and
    TIMEOUT is the status that says so: the school is told to try again,
    not that its week is impossible, and not "An unexpected error occurred"."""
    _throwing(monkeypatch, _always)
    client = TestClient(create_app(_settings()))

    response = client.post(
        "/api/v1/optimize", json=_payload(), headers={"X-API-Key": API_KEY},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "TIMEOUT"
    assert body["lessons"] == []


# ---------------------------------------------------------------------------
# The crash itself
# ---------------------------------------------------------------------------

TEACHER = str(uuid4())
#: Lärarens dag's locked days in the week below, as day indexes: Monday and Thursday.
LOCKED_DAYS = (0, 3)
FIVE_SHORT_DAYS = {"SCHEDULE_DAYS": "1,2,3,4,5", "SCHEDULE_DAY_END_MINUTES": 720}


def _the_lararens_dag_week() -> OptimizeScheduleRequest:
    """test_teacher_day.py's test_a_post_the_locked_days_fill_is_refused_by_name_and_never_raises.

    A post of two days whose locked lessons hold Monday and Thursday, with
    430 minutes of room on them against the teacher's 480: INFEASIBLE, by
    the post."""
    block = str(uuid4())
    idrott = {
        "subjectId": str(uuid4()), "lessonsPerWeek": 4, "minutesPerLesson": 80,
        "lessonLengths": [80, 60, 30, 30], "studentGroupSize": 20, "blockId": block,
    }

    def locked(start: str, end: str, day_of_week: int) -> dict[str, object]:
        return {
            "id": str(uuid4()), "teacherId": TEACHER, "studentGroupId": str(uuid4()),
            "dayOfWeek": day_of_week, "startTime": start, "endTime": end,
        }

    return OptimizeScheduleRequest.model_validate({
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {**idrott, "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": TEACHER},
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": str(uuid4()),
                "teacherId": TEACHER, "lessonsPerWeek": 4, "minutesPerLesson": 80,
                "lessonLengths": [80, 80, 60, 60], "studentGroupSize": 20,
            },
            {**idrott, "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": str(uuid4())},
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(3)],
        "fixedLessons": [locked("07:30:00", "08:10:00", 1), locked("08:20:00", "09:00:00", 4)],
        "teacherDayLimits": [
            {
                "id": str(uuid4()), "teacherId": TEACHER, "maxTeachingDaysPerWeek": 2,
                "lockedWeekdays": [[1, 4]],
            },
        ],
    })


def _put_the_constant_back(model: cp_model.CpModel) -> int:
    """Rewrite each locked day's linking row `Σ minutes·x − R·works ≤ 0` as
    the `Σ minutes·x ≤ R` it was before Lärarens dag's fix. Returns how many."""
    proto = model.Proto()
    names = [variable.name for variable in proto.variables]
    works = {names.index(f"ldworks_{TEACHER}_{day}") for day in LOCKED_DAYS}
    rewritten = 0
    for constraint in proto.constraints:
        if not constraint.has_linear() or constraint.enforcement_literal:
            continue
        row = constraint.linear
        terms = list(zip(row.vars, row.coeffs))
        room = [-coeff for var, coeff in terms if var in works and coeff < 0]
        if not room or list(row.domain)[-1] != 0:
            continue
        lower = row.domain[0]
        row.vars.clear()
        row.coeffs.clear()
        row.domain.clear()
        for var, coeff in terms:
            if var not in works:
                row.vars.append(var)
                row.coeffs.append(coeff)
        row.domain.extend([lower, room[0]])
        rewritten += 1
    return rewritten


def _the_crashing_model() -> cp_model.CpModel:
    solver = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **FIVE_SHORT_DAYS))
    model, *_rest = solver._build_model(
        _the_lararens_dag_week(), use_assumptions=False, include_objective=False,
    )
    assert _put_the_constant_back(model) == len(LOCKED_DAYS)
    return model


def test_cp_sat_s_own_presolve_crash_is_answered_and_not_raised() -> None:
    """The bare Solve is the witness that this is still the real crash. When
    an OR-Tools upgrade stops it throwing, the upstream bug is fixed: keep
    the guard, and find this test a new witness or drop its first half."""
    with pytest.raises(IndexError, match="raw_hash_map"):
        _solver(10.0).Solve(_the_crashing_model())

    assert _solve_guarded(_solver(10.0), _the_crashing_model(), what="phase 1a") == (
        cp_model.INFEASIBLE
    )


def test_a_build_that_crashes_presolve_is_refused_by_solve_and_not_a_500(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    """The same rows, put back in every model solve() builds: the week is
    still refused, now on the proof phase 1a finds without presolve."""
    build = SchedulerSolver._build_model

    def constant_build(self, request, **kwargs):  # type: ignore[no-untyped-def]  # noqa: ANN001, ANN202
        built = build(self, request, **kwargs)
        _put_the_constant_back(built[0])
        return built

    monkeypatch.setattr(SchedulerSolver, "_build_model", constant_build)

    with caplog.at_level(logging.WARNING, logger="app.solver.scheduler_solver"):
        response = SchedulerSolver(
            _settings(SOLVER_PROBE_SECONDS=0, **FIVE_SHORT_DAYS),
        ).solve(_the_lararens_dag_week())

    assert response.status == "INFEASIBLE"
    assert any(
        "IndexError in phase 1a" in record.getMessage() for record in caplog.records
    )
