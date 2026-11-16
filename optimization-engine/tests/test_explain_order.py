"""Förklaringen av en vägran: stora veckor utan mål först, små veckor som förut.

SchedulerSolver._explain_infeasible names the rules of a refused week from a
single-threaded solve with assumptions. It builds that solve WITH the objective,
and a model with the objective answers with every assumption it registered;
measured across the engine's own refusals (the suite, the högstadium week, weeks
built from the benchmark schools) that was 250 of 250, which reads 45 lines at
72 lessons and 141 at 360. Without the objective the answer is the rule that is
the matter, 1 to 5 lines at every size. But that core is ONE sufficient set: on
the suite's small weeks 17 of 202 sharp cores left a second, independent cause
unnamed, and the tests that lock the small refusals name every one. So:

1. A SMALL WEEK (under EXPLAIN_SHARP_FROM_LESSONS) is explained as it was: the
   objective first, and on a walk a second try without it.
2. A LARGE WEEK's FIRST TRY is the model without the objective, on
   solver_explain_sharp_seconds (10 s) of the cap, and a core it finds is the answer.
3. THE RESERVE is the model with the objective, on what is left of the cap, when
   the first try proves nothing or proves it without resting on an assumption
   (an empty core: the room's size is the lesson's own domain, and a literal does
   not carry it).
4. A reserve that names nothing leaves the first answer, and a week with a
   pinned lesson, of any size, has no reserve (its objective core is every pin).

The measurement is in the note forklaring-utan-mal.md; the weeks it was made on
are benchmarks/hogstadium.py and benchmarks/solve_2000_students.py.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.config import Settings
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver, no_core_analysis
from tests import test_optimize as to
from tests import test_pins as tp

FIRST = "the explanation"
RESERVE = "the explanation with the objective"
#: The window a large week's first try gets, as the setting has it by default.
SHARP = tp._settings().solver_explain_sharp_seconds


@pytest.fixture
def asked(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[tuple[str, float, str]]]:
    """Every explaining solve, as (what, the time it was given, what it came to)."""
    log: list[tuple[str, float, str]] = []
    real = scheduler_solver._solve_guarded

    def recording(solver: cp_model.CpSolver, model: object, *, what: str, **rest: object):
        given = solver.parameters.max_time_in_seconds
        status = real(solver, model, what=what, **rest)
        log.append((what, given, solver.StatusName(status)))
        return status

    monkeypatch.setattr(scheduler_solver, "_solve_guarded", recording)
    yield log


@pytest.fixture
def built(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    """The objective flag of every build with assumptions, in order."""
    log: list[bool] = []
    real = SchedulerSolver._build_model

    def recording(self: SchedulerSolver, request: OptimizeScheduleRequest, **kwargs: object):
        if kwargs.get("use_assumptions"):
            log.append(bool(kwargs.get("include_objective", True)))
        return real(self, request, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", recording)
    return log


def _explanations(log: list[tuple[str, float, str]]) -> list[tuple[str, float, str]]:
    """Only the explaining solves: the probes after them are solves too."""
    return [entry for entry in log if entry[0].startswith(FIRST)]


def _tove_away_four_days() -> dict[str, object]:
    """Tove's six lessons, and the one day she is in has four hours: the week the lone cause of which is her."""
    return tp._payload(constraints=[tp._away(tp.TOVE, day) for day in (1, 2, 3, 4)])


def _with_lessons(week: dict[str, object], total: int) -> dict[str, object]:
    """The week with classes of their own beside it, each with a teacher of its own, until it has `total` lessons.

    Beside it and not in it: what makes the week impossible stays what it was,
    and only the count the explanation sorts a week by moves.
    """
    have = sum(r["lessonsPerWeek"] for r in week["requirements"])  # type: ignore[index]
    while have < total:
        lessons = min(7, total - have)
        week["requirements"].append(  # type: ignore[union-attr]
            tp._requirement(str(uuid4()), str(uuid4()), str(uuid4()), lessons),
        )
        have += lessons
    week["rooms"].extend({"id": str(uuid4()), "capacity": 30} for _ in range(3))  # type: ignore[union-attr]
    return week


def _large_tove_away_four_days() -> dict[str, object]:
    """Tove's week with classes beside it: 53 lessons, so a large week by the count."""
    return _with_lessons(_tove_away_four_days(), SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS + 3)


def _large_oversubscribed() -> dict[str, object]:
    """The oversubscribed week (to._oversubscribed_payload) with a second class beside it: 52 lessons."""
    payload = to._oversubscribed_payload()
    beside = dict(payload["requirements"][0])  # type: ignore[index]
    beside.update(id=str(uuid4()), studentGroupId=str(uuid4()), teacherId=str(uuid4()), lessonsPerWeek=12)
    payload["requirements"].append(beside)  # type: ignore[union-attr]
    return payload


def _walk_week(**extra: object) -> dict[str, object]:
    norra, sodra = str(uuid4()), str(uuid4())
    return tp._payload(
        rooms=[
            {"id": tp.R1, "capacity": 30, "siteId": norra},
            {"id": tp.R2, "capacity": 30, "siteId": sodra},
            {"id": tp.R3, "capacity": 30, "siteId": sodra},
        ],
        siteTravelTimes=[{"siteAId": norra, "siteBId": sodra, "minutes": 30}],
        **extra,
    )


def _proves_nothing(stood_in: list[tuple[str, float]]):
    """A stand-in for the guarded solve that notes what it was asked and decides nothing."""

    def solve(solver: cp_model.CpSolver, _model: object, *, what: str, **_rest: object):
        stood_in.append((what, solver.parameters.max_time_in_seconds))
        return cp_model.UNKNOWN

    return solve


class TestASmallWeek:
    """Under EXPLAIN_SHARP_FROM_LESSONS: explained as it always was, so that every cause the tests name is named."""

    def test_is_explained_with_the_objective(
        self, asked: list[tuple[str, float, str]], built: list[bool],
    ) -> None:
        solver = SchedulerSolver(tp._settings())
        response = solver._explain_infeasible(tp._request(_tove_away_four_days()))

        assert response.conflicts is not None
        assert built == [True]
        assert [what for what, _given, _status in _explanations(asked)] == [FIRST]

    def test_the_oversubscribed_week_is_named_by_its_room_capacity_in_one_solve(
        self, asked: list[tuple[str, float, str]], built: list[bool],
    ) -> None:
        """The comment in _explain_infeasible: INSUFFICIENT_RESOURCES without the objective, ROOM_CAPACITY with it."""
        solver = SchedulerSolver(to._settings())
        response = solver._explain_infeasible(
            OptimizeScheduleRequest.model_validate(to._oversubscribed_payload()),
        )

        assert response.conflicts is not None
        assert {detail.category for detail in response.conflicts.conflicts} == {"ROOM_CAPACITY"}
        assert built == [True]
        assert [what for what, _given, _status in _explanations(asked)] == [FIRST]

    def test_with_the_walk_keeps_its_second_try_without_the_objective(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        stood_in: list[tuple[str, float]] = []
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _proves_nothing(stood_in))
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))
        solver._explain_infeasible(tp._request(_walk_week()))

        (first, first_given), (second, second_given) = [
            entry for entry in stood_in if entry[0].startswith(FIRST)
        ]
        assert (first, first_given) == (FIRST, SchedulerSolver.EXPLAIN_WALK_FIRST_SECONDS)
        assert second == "the explanation without the objective"
        assert second_given == pytest.approx(SchedulerSolver.EXPLAIN_CAP_SECONDS, abs=0.5)


class TestTheSizeThatIsLarge:
    @pytest.mark.parametrize(
        ("lessons", "objective_first"),
        [
            (SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS - 1, True),
            (SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS, False),
        ],
    )
    def test_is_counted_in_lessons_a_week(
        self, monkeypatch: pytest.MonkeyPatch, built: list[bool], lessons: int, objective_first: bool,
    ) -> None:
        week = _with_lessons(_tove_away_four_days(), lessons)
        assert sum(r["lessonsPerWeek"] for r in week["requirements"]) == lessons  # type: ignore[index]
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _proves_nothing([]))
        SchedulerSolver(tp._settings())._explain_infeasible(tp._request(week))

        assert built[0] is objective_first


class TestALargeWeek:
    def test_a_teacher_who_is_away_is_named_alone_and_not_with_every_room(
        self, asked: list[tuple[str, float, str]], built: list[bool],
    ) -> None:
        """B1's week, with many lessons: the full core is the teacher's four days and a room line per lesson."""
        solver = SchedulerSolver(tp._settings())
        response = solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        assert [detail.code for detail in response.conflicts.conflicts] == [
            "AVAIL_CONSTRAINT_BLOCKS_LESSONS",
        ] * 4
        assert built == [False]
        assert [what for what, _given, _status in _explanations(asked)] == [FIRST]

    def test_the_first_try_has_ten_seconds_of_the_cap_and_not_all_of_it(
        self, asked: list[tuple[str, float, str]],
    ) -> None:
        """The slowest week measured without the objective took 7.1 s: room for it, and five left for the reserve."""
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=300.0))
        solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        (_what, given, _status), = _explanations(asked)
        assert given == SHARP
        assert SHARP < SchedulerSolver.EXPLAIN_CAP_SECONDS

    def test_a_cap_shorter_than_the_first_try_is_the_whole_first_try(
        self, asked: list[tuple[str, float, str]],
    ) -> None:
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=4.0))
        solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert _explanations(asked)[0][1] == 4.0

    def test_a_proof_that_rests_on_no_assumption_is_explained_by_the_objective(
        self, asked: list[tuple[str, float, str]], built: list[bool],
    ) -> None:
        """The oversubscribed week, large: ROOM_CAPACITY with the objective, INSUFFICIENT_RESOURCES without.

        Impossible with every assumption struck (the cap on a room's size is the
        lesson's own room domain too), so the first try's core is empty and the
        school would read the guess. Lifting the room's size makes the week
        possible, which is why the line the objective gives is the cause here.
        """
        solver = SchedulerSolver(to._settings())
        response = solver._explain_infeasible(
            OptimizeScheduleRequest.model_validate(_large_oversubscribed()),
        )

        assert response.conflicts is not None
        assert {detail.category for detail in response.conflicts.conflicts} == {"ROOM_CAPACITY"}
        assert built == [False, True]
        explained = _explanations(asked)
        assert [what for what, _given, _status in explained] == [FIRST, RESERVE]
        assert [status for _what, _given, status in explained] == ["INFEASIBLE", "INFEASIBLE"]

    def test_a_first_try_that_proves_nothing_leaves_the_reserve_the_rest_of_the_cap(
        self, monkeypatch: pytest.MonkeyPatch, built: list[bool],
    ) -> None:
        # A stood-in solve never ran, as a solve CP-SAT threw out of twice has not:
        # the time the first try took is read off our own clock, since
        # CpSolver.wall_time raises on a solver with no response.
        stood_in: list[tuple[str, float]] = []
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _proves_nothing(stood_in))
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))
        response = solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        (first, first_given), (reserve, reserve_given) = [
            entry for entry in stood_in if entry[0].startswith(FIRST)
        ]
        assert (first, first_given) == (FIRST, SHARP)
        # What is left of the cap: the first try took no time at all here.
        assert reserve == RESERVE
        assert reserve_given == pytest.approx(SchedulerSolver.EXPLAIN_CAP_SECONDS, abs=0.5)
        assert built == [False, True]
        # Nothing proved by either: the verdict stands and is not explained.
        assert response.status == "INFEASIBLE"
        assert response.conflicts is None

    def test_a_reserve_that_names_nothing_leaves_the_first_answer(
        self, monkeypatch: pytest.MonkeyPatch, asked: list[tuple[str, float, str]],
    ) -> None:
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis", lambda _s, _r: no_core_analysis(),
        )
        solver = SchedulerSolver(tp._settings())
        response = solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert [what for what, _g, _s in _explanations(asked)] == [FIRST, RESERVE]
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_NO_CORE"

    def test_a_reserve_that_proves_nothing_leaves_the_first_answer(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The first try proved the week with no assumption; a reserve that times out must not erase that."""
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis", lambda _s, _r: no_core_analysis(),
        )
        real = scheduler_solver._solve_guarded

        def times_out_the_reserve(solver: cp_model.CpSolver, model: object, *, what: str, **rest: object):
            if what == RESERVE:
                return cp_model.UNKNOWN
            return real(solver, model, what=what, **rest)

        monkeypatch.setattr(scheduler_solver, "_solve_guarded", times_out_the_reserve)
        solver = SchedulerSolver(tp._settings())
        response = solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_NO_CORE"

    def test_no_reserve_when_the_cap_leaves_less_than_a_phase(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        stood_in: list[tuple[str, float]] = []
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _proves_nothing(stood_in))
        cap = SchedulerSolver.MIN_PHASE_SECONDS - 0.2
        SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=cap))._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert [entry for entry in stood_in if entry[0].startswith(FIRST)] == [(FIRST, cap)]

    def test_with_the_walk_is_explained_like_any_other_large_week(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A small week with the walk has a split of its own; a large one has the first try and the reserve."""
        stood_in: list[tuple[str, float]] = []
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _proves_nothing(stood_in))
        week = _with_lessons(_walk_week(), SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS + 3)
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))
        solver._explain_infeasible(tp._request(week))

        (first, first_given), (reserve, reserve_given) = [
            entry for entry in stood_in if entry[0].startswith(FIRST)
        ]
        assert (first, first_given) == (FIRST, SHARP)
        assert reserve == RESERVE
        assert reserve_given == pytest.approx(SchedulerSolver.EXPLAIN_CAP_SECONDS, abs=0.5)


class TestAPinnedWeek:
    def _pinned_week(self) -> dict[str, object]:
        return tp._payload({
            tp.MATTE: [tp._pin(2, "09:00"), None, None],
            tp.SVENSKA: [tp._pin(2, "09:00", room=tp.R2), None, None],
        })

    def test_has_the_whole_cap_and_no_reserve_even_with_no_core(
        self, monkeypatch: pytest.MonkeyPatch, asked: list[tuple[str, float, str]],
        built: list[bool],
    ) -> None:
        """Its objective core is every pin (668 of 668 on the högstadium week): a reserve would be that."""
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis", lambda _s, _r: no_core_analysis(),
        )
        solver = SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))
        solver._explain_infeasible(tp._request(self._pinned_week()))

        assert built == [False]
        assert [(what, given) for what, given, _s in _explanations(asked)] == [
            (FIRST, SchedulerSolver.EXPLAIN_CAP_SECONDS),
        ]


def test_the_defaults_are_the_numbers_the_handbook_promises() -> None:
    """DEPLOYMENT.md section 23 says 10 s and 50 lessons; the other tests compare against the values, not these."""
    assert Settings(API_KEY="test-api-key-000000000000000000000000").solver_explain_sharp_seconds == 10.0
    assert SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS == 50
    assert SchedulerSolver.EXPLAIN_CAP_SECONDS == 15.0
    assert SchedulerSolver.EXPLAIN_WALK_FIRST_SECONDS == 5.0


class TestTheWindow:
    def test_is_a_setting_that_moves_the_first_try_without_a_deployment(
        self, asked: list[tuple[str, float, str]],
    ) -> None:
        """SOLVER_EXPLAIN_SHARP_SECONDS: the first measurement of a slower processor is a variable and not a release."""
        solver = SchedulerSolver(tp._settings(SOLVER_EXPLAIN_SHARP_SECONDS=4.0))
        solver._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert _explanations(asked)[0][:2] == (FIRST, 4.0)

    def test_cannot_be_zero(self) -> None:
        with pytest.raises(ValueError):
            tp._settings(SOLVER_EXPLAIN_SHARP_SECONDS=0)

    @pytest.mark.parametrize("found", [cp_model.OPTIMAL, cp_model.FEASIBLE], ids=["optimal", "feasible"])
    def test_a_first_try_that_found_a_timetable_has_no_reserve(
        self, monkeypatch: pytest.MonkeyPatch, built: list[bool], found: int,
    ) -> None:
        """The model with the objective has the same hard rules: it cannot prove a week it found a timetable for.

        OPTIMAL and FEASIBLE are the same fact here (the review of #323, round 2,
        LÅG-1): a timetable exists, and the reserve would only spend what is
        left of the cap on a week it cannot prove.
        """
        stood_in: list[tuple[str, float]] = []

        def finds_a_timetable(solver: cp_model.CpSolver, _model: object, *, what: str, **_r: object):
            stood_in.append((what, solver.parameters.max_time_in_seconds))
            return found

        monkeypatch.setattr(scheduler_solver, "_solve_guarded", finds_a_timetable)
        response = SchedulerSolver(tp._settings())._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert [what for what, _given in stood_in if what.startswith(FIRST)] == [FIRST]
        assert built == [False]
        assert response.status == "INFEASIBLE"
        assert response.conflicts is None

    def test_a_reserve_that_finds_a_timetable_proves_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The first try runs out of time and the reserve finds a timetable: the week is NOT proved without an assumption.

        A reserve that proves the week with no assumption in it replaces the first
        answer as CONFLICT_NO_CORE; one that found a timetable has proved nothing,
        and the answer stays what the first try left, which here is none (the
        review of #323, round 2, LÅG-1).
        """
        def first_runs_out(solver: cp_model.CpSolver, _model: object, *, what: str, **_r: object):
            return cp_model.UNKNOWN if what == FIRST else cp_model.OPTIMAL

        monkeypatch.setattr(scheduler_solver, "_solve_guarded", first_runs_out)
        response = SchedulerSolver(tp._settings())._explain_infeasible(tp._request(_large_tove_away_four_days()))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is None

    def test_is_logged_at_start_up_beside_the_probe_s_own(self, caplog: pytest.LogCaptureFixture) -> None:
        """DEPLOYMENT 23 says the value in force is in `service_starting`, as the first line of the log answers it.

        Each figure is different here, so a line that shows the probe's seconds
        in the window's place, or none, is not what the handbook promises (the
        review of #323, round 2, LÅG-1).
        """
        with caplog.at_level(logging.INFO):
            with TestClient(create_app(tp._settings(SOLVER_EXPLAIN_SHARP_SECONDS=7.0, SOLVER_PROBE_SECONDS=3.0))):
                pass
        starting = []
        for record in caplog.records:
            message = record.getMessage()
            if message.startswith("{") and json.loads(message).get("event") == "service_starting":
                starting.append(json.loads(message))
        assert starting, "start-up must log service_starting"
        assert starting[0]["solver_explain_sharp_seconds"] == 7.0
        assert starting[0]["solver_probe_seconds"] == 3.0


class _Clock:
    """A clock the stand-in solve moves: the first try 'takes' `spent` seconds."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _taking(clock: _Clock, spent: float, given: list[tuple[str, float]]):
    """A stand-in for the guarded solve that proves nothing and moves `clock` by `spent` for the first try."""

    def solve(solver: cp_model.CpSolver, _model: object, *, what: str, **_rest: object):
        given.append((what, solver.parameters.max_time_in_seconds))
        if what == FIRST:
            clock.now += spent
        return cp_model.UNKNOWN

    return solve


class TestTheTimeTheFirstTryTook:
    """What the stand-in that takes no time cannot show: the reserve is paid out of the cap, not on top of it."""

    def test_the_reserve_gets_what_the_first_try_left_of_the_cap(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        clock, given = _Clock(), []
        monkeypatch.setattr(scheduler_solver.time, "monotonic", clock)
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _taking(clock, 9.0, given))
        SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert [g for what, g in given if what == RESERVE] == [pytest.approx(6.0, abs=0.01)]

    def test_no_reserve_when_the_first_try_used_the_cap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        clock, given = _Clock(), []
        monkeypatch.setattr(scheduler_solver.time, "monotonic", clock)
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _taking(clock, 14.8, given))
        SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert [what for what, _ in given if what.startswith(FIRST)] == [FIRST]

    def test_the_walks_second_try_gets_what_the_first_left(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A small week with the walk: 4 s of its 5 used, so the second try has 11 s of the 15."""
        clock, given = _Clock(), []
        monkeypatch.setattr(scheduler_solver.time, "monotonic", clock)
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", _taking(clock, 4.0, given))
        SchedulerSolver(tp._settings(SOLVER_MAX_TIME_SECONDS=60.0))._explain_infeasible(
            tp._request(_walk_week()),
        )

        second = [g for what, g in given if what == "the explanation without the objective"]
        assert second == [pytest.approx(11.0, abs=0.01)]


class TestWhatFollowsTheReserve:
    def test_a_core_from_the_reserve_goes_through_the_verdicts(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The first try proves nothing and the reserve proves the week: its core is read by the daily maximum's verdict."""
        seen: list[object] = []
        real_verdict = SchedulerSolver._daily_maximum_verdict

        def spy(self: SchedulerSolver, request: OptimizeScheduleRequest, conflicts: object, **rest: object):
            seen.append(conflicts)
            return real_verdict(self, request, conflicts, **rest)

        real = scheduler_solver._solve_guarded

        def first_proves_nothing(solver: cp_model.CpSolver, model: object, *, what: str, **rest: object):
            return cp_model.UNKNOWN if what == FIRST else real(solver, model, what=what, **rest)

        monkeypatch.setattr(SchedulerSolver, "_daily_maximum_verdict", spy)
        monkeypatch.setattr(scheduler_solver, "_solve_guarded", first_proves_nothing)
        response = SchedulerSolver(tp._settings())._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY"
        assert len(seen) == 1

    def test_a_reserve_that_proves_the_week_without_an_assumption_is_the_answer_the_first_try_did_not_give(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """First try UNKNOWN, reserve INFEASIBLE with no core: CONFLICT_NO_CORE, a proof, and not no conflicts at all."""
        real = scheduler_solver._solve_guarded

        def first_proves_nothing(solver: cp_model.CpSolver, model: object, *, what: str, **rest: object):
            return cp_model.UNKNOWN if what == FIRST else real(solver, model, what=what, **rest)

        monkeypatch.setattr(scheduler_solver, "_solve_guarded", first_proves_nothing)
        monkeypatch.setattr(
            scheduler_solver, "build_conflict_analysis", lambda _s, _r: no_core_analysis(),
        )
        response = SchedulerSolver(tp._settings())._explain_infeasible(
            tp._request(_large_tove_away_four_days()),
        )

        assert response.conflicts is not None
        assert response.conflicts.summary_code == "CONFLICT_NO_CORE"


def test_a_large_week_with_two_causes_names_one_and_the_next_run_the_other() -> None:
    """What the handbook says and nothing locked: the school fixes the named cause and is told the next on the next run.

    Two teachers away the whole week on a large week: the core without the
    objective is one sufficient set, so one of them is named (measured by the
    review of #323: exactly one in 32 of 32 random weeks of two or three
    teachers, and none of eight högstadium combinations names all). Lifting the
    named teacher's rows and asking again names the other.
    """

    def week(away: tuple[str, ...]) -> dict[str, object]:
        constraints = [tp._away(who, day) for who in away for day in (1, 2, 3, 4, 5)]
        return _with_lessons(
            tp._payload(constraints=constraints), SchedulerSolver.EXPLAIN_SHARP_FROM_LESSONS + 3,
        )

    def named(payload: dict[str, object]) -> set[str]:
        response = SchedulerSolver(tp._settings())._explain_infeasible(tp._request(payload))
        assert response.conflicts is not None
        return {str(rid) for d in response.conflicts.conflicts for rid in d.resource_ids} | {
            str(cid) for d in response.conflicts.conflicts for cid in d.constraint_ids
        }

    both = week((tp.TOVE, tp.SARA))
    first = named(both)
    ids_tove = {c["id"] for c in both["constraints"] if c["resourceId"] == tp.TOVE}  # type: ignore[index]
    ids_sara = {c["id"] for c in both["constraints"] if c["resourceId"] == tp.SARA}  # type: ignore[index]
    named_tove, named_sara = bool(first & ids_tove), bool(first & ids_sara)
    assert named_tove != named_sara, "exactly one of the two teachers is named"
    # Whoever was named is fixed: lift that teacher's away rows and ask again.
    remaining = week((tp.SARA,) if named_tove else (tp.TOVE,))
    assert named(remaining), "the next run names the other"
