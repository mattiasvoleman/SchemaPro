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
   EXPLAIN_SHARP_SECONDS of the cap, and a core it finds is the answer.
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

from collections.abc import Iterator
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver, no_core_analysis
from tests import test_optimize as to
from tests import test_pins as tp

FIRST = "the explanation"
RESERVE = "the explanation with the objective"


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
        assert given == SchedulerSolver.EXPLAIN_SHARP_SECONDS
        assert SchedulerSolver.EXPLAIN_SHARP_SECONDS < SchedulerSolver.EXPLAIN_CAP_SECONDS

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
        assert (first, first_given) == (FIRST, SchedulerSolver.EXPLAIN_SHARP_SECONDS)
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
        assert (first, first_given) == (FIRST, SchedulerSolver.EXPLAIN_SHARP_SECONDS)
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
