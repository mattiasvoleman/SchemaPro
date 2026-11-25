"""Where a timed-out solve's time went (omgång 13, M2 Förklaringen när tiden tar slut).

A Generera that ran out of time used to answer a status and a hint. It now carries
`report` (TimeoutReport): the seconds of each step by the solve's own clock, what
the satisfaction searches had done, and whether the week load was cut short; and
the 503 a route answers at its ceiling names the step the solve was in. These pin
the arithmetic of the clock, every way the solve times out (the fake clock of
test_search_options.py steers all of it), that nothing but a TIMEOUT carries the
field, and the contract.
"""

from __future__ import annotations

import asyncio
import json
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.api.v1 import optimize
from app.config import Settings
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.stage_clock import StageClock
from app.timing import Deadline
from tests import test_search_options as tso
from tests import test_travel as tt

API_KEY = tso.API_KEY
HEADERS = tso.HEADERS
SHARED = json.loads((Path(__file__).parent / "data" / "solver_timeout_body.json").read_text())


def _solve(settings: Settings, payload: dict[str, object]):  # noqa: ANN202
    return SchedulerSolver(settings).solve(OptimizeScheduleRequest.model_validate(payload))


def _stages(response) -> list[tuple[str, float]]:  # noqa: ANN001
    return [(stage.stage, stage.seconds) for stage in response.report.stages]


# ---------------------------------------------------------------------------
# The clock, as arithmetic
# ---------------------------------------------------------------------------


def test_the_steps_are_contiguous_and_add_up_to_the_total() -> None:
    clock = StageClock(100.0)
    clock.enter("BUILD", 102.0)
    clock.enter("SEARCH_CLEAN", 110.0)
    clock.enter("PROBE", 170.0)

    report = clock.report(
        175.0, budget_seconds=60, configured_budget_seconds=60,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [
        ("PRECHECKS", 2.0), ("BUILD", 8.0), ("SEARCH_CLEAN", 60.0), ("PROBE", 5.0),
    ]
    assert sum(s.seconds for s in report.stages) == report.total_seconds == 75.0


def test_a_step_entered_twice_is_summed_and_a_skipped_one_is_not_listed() -> None:
    clock = StageClock(0.0)
    clock.enter("BUILD", 1.0)
    clock.enter("BUILD", 4.0)  # the same step again: one entry, 3 + 2 s
    clock.enter("SEARCH_CLEAN", 6.0)

    report = clock.report(
        8.0, budget_seconds=5, configured_budget_seconds=5,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [
        ("PRECHECKS", 1.0), ("BUILD", 5.0), ("SEARCH_CLEAN", 2.0),
    ]


def test_seconds_are_tenths_and_never_negative() -> None:
    clock = StageClock(10.0)
    clock.enter("BUILD", 10.04)
    clock.enter("SEARCH_CLEAN", 12.26)
    clock.enter("PROBE", 12.0)  # a clock that stepped back is no negative time

    report = clock.report(
        12.0, budget_seconds=1, configured_budget_seconds=1,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [
        ("PRECHECKS", 0.0), ("BUILD", 2.2), ("SEARCH_CLEAN", 0.0), ("PROBE", 0.0),
    ]
    assert report.total_seconds == 2.0


def test_a_step_that_ran_while_the_clock_stepped_back_takes_nothing_from_its_other_entry() -> None:
    clock = StageClock(0.0)
    clock.enter("BUILD", 5.0)
    clock.enter("BUILD", 3.0)  # the clock went back two seconds: that entry is no negative time

    report = clock.report(
        6.0, budget_seconds=1, configured_budget_seconds=1,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [("PRECHECKS", 5.0), ("BUILD", 3.0)]


def test_a_clock_that_is_closed_twice_keeps_what_the_first_close_counted() -> None:
    """The solve closes its clock in `finally`, after the answer's account closed it already."""
    clock = StageClock(0.0)
    clock.enter("BUILD", 2.0)
    clock.finish(5.0)
    clock.finish(50.0)

    report = clock.report(
        90.0, budget_seconds=1, configured_budget_seconds=1,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [("PRECHECKS", 2.0), ("BUILD", 3.0)]


def test_where_names_the_step_in_progress_and_nothing_once_the_solve_is_over() -> None:
    clock = StageClock(100.0)
    clock.enter("BUILD", 103.0)
    clock.enter("SEARCH_CLONE", 160.0)

    assert clock.where(230.0) == ("SEARCH_CLONE", 70.0, 130.0)

    clock.finish(231.0)
    assert clock.where(240.0) is None


def test_a_search_note_counts_its_seconds_from_where_its_step_began() -> None:
    clock = StageClock(0.0)
    clock.enter("SEARCH_CLEAN", 5.0)
    clock.note_search("CLEAN", 65.0, conflicts=12, branches=34)
    clock.enter("SEARCH_CLONE", 65.0)
    clock.note_search("CLONE", 100.0, conflicts=None, branches=None)

    report = clock.report(
        100.0, budget_seconds=95, configured_budget_seconds=95,
        caller_wait_seconds=None, week_load_cut=False,
    )

    assert [p.model_dump() for p in report.search.phases] == [
        {"phase": "CLEAN", "seconds": 60.0, "conflicts": 12, "branches": 34},
        {"phase": "CLONE", "seconds": 35.0, "conflicts": None, "branches": None},
    ]
    assert report.search.solutions == 0


def test_cp_sats_effort_is_read_where_it_exists_and_absent_where_it_does_not() -> None:
    """A CpSolver that never solved (the guard answered UNKNOWN for a solve that threw) has nothing to read."""
    solver = SchedulerSolver(tso._settings())
    solver._stages = StageClock(0.0)

    solved = cp_model.CpSolver()
    model = cp_model.CpModel()
    model.Add(model.NewIntVar(0, 5, "x") >= 2)
    solved.Solve(model)
    solver._note_search("CLEAN", solved)
    solver._note_search("CLONE", cp_model.CpSolver())

    clean, clone = solver._stages.report(
        0.0, budget_seconds=1, configured_budget_seconds=1,
        caller_wait_seconds=None, week_load_cut=False,
    ).search.phases
    assert (clean.conflicts, clean.branches) == (solved.NumConflicts(), solved.NumBranches())
    assert isinstance(clean.conflicts, int) and isinstance(clean.branches, int)
    assert (clone.conflicts, clone.branches) == (None, None)


# ---------------------------------------------------------------------------
# Every way the solve answers TIMEOUT, on the fake clock
# ---------------------------------------------------------------------------


def test_the_usual_timeout_says_where_the_budget_went(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strict, a 100 s budget: phase 1a takes its 60 s cap, phase 1b the 40 that are left, then the probe.

    Each model build is 2 s (two of them before the search: 4 s), and a probe
    build is 2 s too, with its 3 s slice, before the clock leaves no room for a
    second rule: the probe's 5 s. 4 + 60 + 40 + 5 = 109.
    """
    clock = tso._Clock(monkeypatch, build=2.0)
    tso._rules_to_probe(monkeypatch, 2)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=6),
        tso._payload(changeover=5),
    )

    assert response.status == "TIMEOUT"
    assert clock.solves == [60.0, 40.0, 3.0]
    report = response.report
    assert _stages(response) == [
        ("PRECHECKS", 0.0), ("BUILD", 4.0), ("SEARCH_CLEAN", 60.0), ("SEARCH_CLONE", 40.0), ("PROBE", 5.0),
    ]
    assert report.total_seconds == 109.0
    assert (report.budget_seconds, report.configured_budget_seconds) == (100, 100)
    assert report.caller_wait_seconds is None
    assert report.week_load_cut is False
    assert [(p.phase, p.seconds) for p in report.search.phases] == [("CLEAN", 60.0), ("CLONE", 40.0)]
    assert report.search.solutions == 0


def test_a_small_budget_is_spent_in_phase_1a_and_phase_1b_never_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 10 s budget is all phase 1a (the cap is 60), and the clone has under half a second: no clone step."""
    tso._Clock(monkeypatch, build=2.0)
    tso._rules_to_probe(monkeypatch, 2)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6),
        tso._payload(changeover=5),
    )

    assert response.status == "TIMEOUT"
    assert _stages(response) == [
        ("PRECHECKS", 0.0), ("BUILD", 4.0), ("SEARCH_CLEAN", 10.0), ("PROBE", 5.0),
    ]
    assert [p.phase for p in response.report.search.phases] == ["CLEAN"]


def test_a_caller_that_waits_less_gets_a_search_that_says_it_was_given_less(monkeypatch: pytest.MonkeyPatch) -> None:
    """The caller waits 25 s of the engine's 46: the answer is due at 20 less the 10 a solve may overrun.

    The search ends where the probe's floor (5 s) leaves room, less the overrun
    held back for (half of the 5 s that are left, a clock this short cannot hold
    back ten): 2.5 s of the 10 the engine is set to, reported as 2. The report
    says both numbers and the wait, which is what tells a school that its run
    was short on purpose and not that its week is hard.
    """
    tso._Clock(monkeypatch)
    tso._rules_to_probe(monkeypatch, 2)
    payload = tso._payload(changeover=5)
    payload["deadlineSeconds"] = 25

    response = _solve(tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6), payload)

    report = response.report
    assert (report.budget_seconds, report.configured_budget_seconds) == (2, 10)
    assert report.caller_wait_seconds == 25.0
    assert _stages(response)[2] == ("SEARCH_CLEAN", 2.5)


def test_best_effort_accounts_for_its_time_the_same_way(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bästa möjliga schema times out through its own three exits; the usual one is phase 1b."""
    tso._Clock(monkeypatch, build=2.0)
    tso._rules_to_probe(monkeypatch, 2)

    response = SchedulerSolver(
        tso._settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=6),
    ).solve(tso._best_effort())

    assert response.status == "TIMEOUT"
    assert [stage for stage, _ in _stages(response)] == [
        "PRECHECKS", "BUILD", "SEARCH_CLEAN", "SEARCH_CLONE", "PROBE",
    ]
    assert dict(_stages(response))["SEARCH_CLEAN"] == 60.0
    assert [p.phase for p in response.report.search.phases] == ["CLEAN", "CLONE"]


def test_best_effort_with_no_time_left_for_a_search_has_no_search_step(monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller that waits less than the builds need: the timeout comes before any search ran."""
    tso._Clock(monkeypatch, build=20.0)
    tso._rules_to_probe(monkeypatch, 2)
    request = tso._best_effort().model_copy(update={"deadline_seconds": 40.0})

    response = SchedulerSolver(
        tso._settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=6),
    ).solve(request)

    assert response.status == "TIMEOUT"
    stages = [stage for stage, _ in _stages(response)]
    assert "SEARCH_CLEAN" not in stages and "SEARCH_CLONE" not in stages
    assert response.report.search.phases == []


def test_the_walks_planned_sites_search_is_a_step_of_its_own(monkeypatch: pytest.MonkeyPatch) -> None:
    """A school that keeps Restid i generatorn: the sites are searched first, then phase 1a and 1b."""
    real = scheduler_solver._solve_guarded

    def out_of_time(solver, model, *, what, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if what in ("phase 1a", "phase 1b"):
            return cp_model.UNKNOWN
        return real(solver, model, what=what, **kwargs)

    monkeypatch.setattr(scheduler_solver, "_solve_guarded", out_of_time)
    monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", lambda *_a, **_k: None)
    monkeypatch.setattr(SchedulerSolver, "_probe_timeout", lambda self, request, **kwargs: None)
    payload = tt._payload([tt._requirement(tt.GROUP, kind="LAB"), tt._requirement(tt.OTHER_GROUP, kind="GYM")])

    _solver, _request, response = tt._solve(payload)

    assert response.status == "TIMEOUT"
    assert [stage for stage, _ in _stages(response)] == [
        "PRECHECKS", "BUILD", "SITES", "SEARCH_CLEAN", "SEARCH_CLONE", "PROBE",
    ]
    # CP-SAT never ran (the guard is stubbed), so there is no effort to read, and none is made up.
    assert [(p.phase, p.conflicts, p.branches) for p in response.report.search.phases] == [
        ("CLEAN", None, None), ("CLONE", None, None),
    ]


# ---------------------------------------------------------------------------
# The week load that was cut short
# ---------------------------------------------------------------------------


def _cutting_the_week_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """The count reports that it stopped at its deadline, as it does when a year is heavy."""
    real = SchedulerSolver._week_loads

    def cut_short(self, request, *, cut=None, **kwargs):  # noqa: ANN001, ANN003, ANN202
        loads = real(self, request, cut=cut, **kwargs)
        if cut is not None:
            cut.append(True)
        return loads

    monkeypatch.setattr(SchedulerSolver, "_week_loads", cut_short)


def test_a_week_load_that_was_cut_short_is_said_beside_the_probes_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    tso._Clock(monkeypatch)
    _cutting_the_week_load(monkeypatch)
    tso._rules_to_probe(monkeypatch, 1)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6),
        tso._payload(changeover=5),
    )

    assert response.report.week_load_cut is True
    assert response.conflicts is not None
    # The probe's own answer stands, and the row follows it.
    assert response.conflicts.summary_code == "PROBE_NOTHING_HELPED"
    row = response.conflicts.conflicts[-1]
    assert (row.category, row.code, row.params) == (
        "REQUIREMENT_DEMAND", "WEEK_LOAD_NOT_COUNTED", {"seconds": 4, "percent": 85},
    )
    assert row.message == (
        "The count of the week load ran out of its 4 s before it had counted every year. "
        "A year with no line here was not counted, which is not the same as being under 85 %."
    )


@pytest.mark.parametrize(("ceiling", "said"), [(4.0, 2), (1.4, 0.7), (30.0, 4)])
def test_the_row_says_the_seconds_the_count_had_when_the_clock_cut_it_below_its_own_four(
    monkeypatch: pytest.MonkeyPatch, ceiling: float, said: float,
) -> None:
    """g371-L-1: the row said the four seconds the count is given, whatever the request's clock left it.

    The count's deadline is clamped to the answer's edge (a ceiling of 4 s is answered by 2: it gives up
    half of itself). A count that ran past THAT had two seconds, and the row says two; a ceiling that
    holds the whole four says four.
    """
    clock = tso._Clock(monkeypatch)
    solver = SchedulerSolver(tso._settings())
    solver._deadline = Deadline(entered=clock.now, ceiling=ceiling)

    def ran_out(*_args: object, deadline: float, **_kwargs: object) -> list[object]:
        clock.now = deadline + 1.0
        return []

    monkeypatch.setattr(scheduler_solver, "week_loads", ran_out)
    cut: list[bool] = []

    solver._week_loads(OptimizeScheduleRequest.model_validate(tso._payload()), cut=cut)

    assert cut == [True]
    row = solver._with_uncounted_weeks(None).conflicts[0]
    assert row.code == "WEEK_LOAD_NOT_COUNTED"
    assert row.params["seconds"] == said


def test_a_cut_week_load_with_nothing_else_to_say_is_the_whole_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    """No probe result, no tight year: the row alone, under no headline, so that "no row" never reads as "not tight"."""
    tso._Clock(monkeypatch)
    _cutting_the_week_load(monkeypatch)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=0),
        tso._payload(),
    )

    assert response.status == "TIMEOUT"
    assert response.conflicts is not None
    assert response.conflicts.summary == "" and response.conflicts.summary_code == ""
    assert [row.code for row in response.conflicts.conflicts] == ["WEEK_LOAD_NOT_COUNTED"]


def test_a_best_effort_week_load_that_was_cut_short_says_so_too(monkeypatch: pytest.MonkeyPatch) -> None:
    tso._Clock(monkeypatch)
    _cutting_the_week_load(monkeypatch)
    tso._rules_to_probe(monkeypatch, 0)

    response = SchedulerSolver(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6),
    ).solve(tso._best_effort())

    assert response.status == "TIMEOUT"
    assert response.report.week_load_cut is True
    assert response.conflicts is not None
    assert response.conflicts.conflicts[-1].code == "WEEK_LOAD_NOT_COUNTED"


def test_a_week_load_that_finished_adds_no_row(monkeypatch: pytest.MonkeyPatch) -> None:
    tso._Clock(monkeypatch)
    tso._rules_to_probe(monkeypatch, 1)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6),
        tso._payload(changeover=5),
    )

    assert response.report.week_load_cut is False
    assert response.conflicts is not None
    assert "WEEK_LOAD_NOT_COUNTED" not in [row.code for row in response.conflicts.conflicts]


# ---------------------------------------------------------------------------
# Only a TIMEOUT carries the account
# ---------------------------------------------------------------------------


def test_a_timetable_carries_no_report() -> None:
    response = _solve(tso._settings(SOLVER_MAX_TIME_SECONDS=10), tso._payload())

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert response.report is None
    assert '"report"' not in response.model_dump_json(by_alias=True)


def test_a_refusal_carries_no_report(monkeypatch: pytest.MonkeyPatch) -> None:
    tso._Clock(monkeypatch, first=cp_model.INFEASIBLE)

    response = _solve(
        tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=0),
        tso._payload(changeover=5),
    )

    assert response.status == "INFEASIBLE"
    assert '"report"' not in response.model_dump_json(by_alias=True)


def test_the_account_is_gone_when_its_solve_is_over(monkeypatch: pytest.MonkeyPatch) -> None:
    """A step called on its own afterwards (a test, a benchmark) keeps no account."""
    tso._Clock(monkeypatch)
    solver = SchedulerSolver(tso._settings(SOLVER_MAX_TIME_SECONDS=10, SOLVER_PROBE_SECONDS=6))

    solver.solve(OptimizeScheduleRequest.model_validate(tso._payload(changeover=5)))

    assert solver._stages is None
    assert solver.stage_where() is None


# ---------------------------------------------------------------------------
# The 503 names the step the solve was in
# ---------------------------------------------------------------------------


class _Waited:
    """asyncio.wait_for in the route gives up at once, as it does at the ceiling."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def give_up(awaitable: object, timeout: float) -> None:
            close = getattr(awaitable, "close", None)
            if close is not None:
                close()
            raise asyncio.TimeoutError

        monkeypatch.setattr(optimize.asyncio, "wait_for", give_up)


class _MidSearch(SchedulerSolver):
    """A solver whose clock says it entered at 0 and has been in phase 1b since 70."""

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._stages = StageClock(0.0)
        self._stages.enter("SEARCH_CLONE", 70.0)


def _hung(monkeypatch: pytest.MonkeyPatch, solver_class: type[SchedulerSolver]) -> TestClient:
    _Waited(monkeypatch)
    monkeypatch.setattr(optimize, "SchedulerSolver", solver_class)
    monkeypatch.setattr(
        scheduler_solver, "time",
        types.SimpleNamespace(monotonic=lambda: 230.0, perf_counter=lambda: 230.0),
    )
    settings = tso._settings(SOLVER_MAX_TIME_SECONDS=180, SOLVER_PROBE_SECONDS=20)
    return TestClient(create_app(settings), raise_server_exceptions=False)


def test_the_ceiling_503_names_where_the_solve_was(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _hung(monkeypatch, _MidSearch)

    response = client.post("/api/v1/optimize", json=tso._payload(), headers=HEADERS)

    assert response.status_code == 503, response.text
    assert response.json() == {
        "code": "SOLVER_TIMEOUT",
        "message": "Optimization timed out.",
        # The body the gateway's spec reads too (tests/data/solver_timeout_body.json).
        "details": SHARED["detailsWithStage"],
    }
    assert SHARED["detailsWithStage"] == {
        "route": "optimize",
        "ceilingSeconds": 230.0,
        "stage": "SEARCH_CLONE",
        "stageSeconds": 160.0,
        "elapsedSeconds": 230.0,
    }


def test_the_ceiling_503_of_a_solve_that_never_began_names_no_step(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing is made up: the body is what it was before this field existed."""
    client = _hung(monkeypatch, SchedulerSolver)

    response = client.post("/api/v1/optimize", json=tso._payload(), headers=HEADERS)

    assert response.status_code == 503, response.text
    assert response.json()["details"] == {"route": "optimize", "ceilingSeconds": 230.0}


# ---------------------------------------------------------------------------
# The contract is additive
# ---------------------------------------------------------------------------


def test_the_report_is_optional_in_the_published_response_schema() -> None:
    document = create_app(tso._settings()).openapi()
    schemas = document["components"]["schemas"]
    response = schemas["OptimizeScheduleResponse"]

    assert "report" in response["properties"]
    assert "report" not in response["required"]
    assert {"TimeoutReport", "TimeoutStage", "TimeoutSearch", "TimeoutSearchPhase"} <= set(schemas)
    assert set(schemas["TimeoutReport"]["required"]) == {"totalSeconds", "budgetSeconds", "configuredBudgetSeconds", "stages", "search"}
    assert schemas["TimeoutStage"]["properties"]["stage"]["enum"] == [
        "PRECHECKS", "BUILD", "SITES", "SEARCH_CLEAN", "SEARCH_CLONE", "PROBE",
    ]


def test_an_exception_without_a_step_keeps_its_old_shape() -> None:
    from app.exceptions import SolverTimeoutError

    error = SolverTimeoutError("Optimization timed out.", route="optimize", ceiling_seconds=230.0)

    assert (error.stage, error.stage_seconds, error.elapsed_seconds) == (None, None, None)

