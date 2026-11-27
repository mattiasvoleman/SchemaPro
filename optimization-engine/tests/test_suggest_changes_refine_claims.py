"""G6b (g493): `neededIsLeast: true` is said only where `needed` IS the least, whatever the checks that were left.

`tests/test_suggest_changes_refine.py` holds the descent where it runs to its end (an INFEASIBLE value next below the lowest accepted one) and
where the check does not decide. Not held there: the descent that stops, for want of checks or of time, with an INFEASIBLE value known and an
ACCEPTED one known and values between them never asked. `proved` then still reads True (the last answer for `bad` was a proof), and only the
adjacency of `good` and `bad` says that `needed` is the least; without it the answer claims a least that a lower value, never asked, may beat.
"""

from __future__ import annotations

import pytest
from ortools.sat.python import cp_model

from app.solver import suggestions
from app.solver.suggestions import refine, strict_check
from tests.test_suggest_changes import _cap_week, _request, _settings, _suggest
from tests.test_suggest_changes_refine import _Oracle, _cap, _run, _week


@pytest.mark.parametrize("budget", range(1, 9))
def test_the_least_is_claimed_only_where_it_is_the_least_whatever_the_number_of_checks_that_were_left(
    monkeypatch: pytest.MonkeyPatch, budget: int,
) -> None:
    oracle = _Oracle(least=180)
    monkeypatch.setattr(suggestions, "strict_check", oracle)
    monkeypatch.setattr(suggestions, "MAX_REFINEMENTS", budget)

    (change,), spent = _run(oracle, [_cap(60, 240)])

    assert spent <= budget
    assert change.needed is not None and change.needed >= 180, "a value the strict model refuses is never named"
    if change.needed_is_least:
        assert change.needed == 180, f"said to be the least after {spent} checks, and 180 holds"


def test_a_descent_that_ends_between_a_value_that_holds_and_one_that_is_refused_claims_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    # Cap 60 to 240, the strict model lays the week from 180: whichever way the first checks go, a descent cut after an INFEASIBLE and an
    # ACCEPTED value with a gap between them has a `needed` above 180 and no claim of the least.
    oracle = _Oracle(least=180)
    monkeypatch.setattr(suggestions, "strict_check", oracle)
    found: dict[int, tuple[int | None, bool | None]] = {}
    for budget in range(1, 9):
        monkeypatch.setattr(suggestions, "MAX_REFINEMENTS", budget)
        (change,), _ = _run(oracle, [_cap(60, 240)])
        found[budget] = (change.needed, change.needed_is_least)

    cut = [budget for budget, (needed, least) in found.items() if needed != 180 and least is not None and bool(least)]
    assert cut == [], f"claimed the least above 180 with budgets {cut}: {found}"
    assert any(needed != 180 and least is False for needed, least in found.values()), "the scan never stopped between the two: it proves nothing"


def test_a_value_that_was_not_decided_next_to_the_lowest_accepted_one_is_no_proof_even_after_an_earlier_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Cap 60 to 240. 190 holds, 185 is not decided (the clock), 180 and below are refused. The descent meets a proof first (180 refused), then
    # the value next below 190, which proves nothing; `proved` must be read for that value and not left standing from the earlier answer.
    asked: list[int] = []

    def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
        cap = request.teacher_work_rules[0].max_teaching_minutes_per_day
        asked.append(cap)
        if cap >= 190:
            return "ACCEPTED"
        return "UNDECIDED" if cap == 185 else "INFEASIBLE"

    monkeypatch.setattr(suggestions, "strict_check", check)

    (change,), _ = _run(None, [_cap(60, 240)])

    assert 185 in asked and 180 in asked, "the descent did meet a refusal and then the value that is not decided"
    assert (change.needed, change.needed_is_least) == (190, False)


@pytest.mark.parametrize(
    ("status", "verdict"),
    [
        (cp_model.OPTIMAL, "ACCEPTED"),
        (cp_model.FEASIBLE, "ACCEPTED"),
        (cp_model.INFEASIBLE, "INFEASIBLE"),
        (cp_model.UNKNOWN, "UNDECIDED"),
        (cp_model.MODEL_INVALID, "UNDECIDED"),
    ],
)
def test_only_a_proof_of_infeasibility_is_infeasible_and_a_clock_that_ran_out_is_not_decided(
    monkeypatch: pytest.MonkeyPatch, status: int, verdict: str,
) -> None:
    # `neededIsLeast: true` rests on this word and nothing else: a solve that stopped at its clock (UNKNOWN) proves nothing about the value.
    monkeypatch.setattr(suggestions, "_solve_guarded", lambda *args, **kwargs: status)

    assert strict_check(_week(), [], _settings(), seconds=5.0) == verdict


def test_a_build_the_engine_refuses_is_not_decided(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.exceptions import InvalidScheduleInputError
    from app.solver.scheduler_solver import SchedulerSolver

    def refuse(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        raise InvalidScheduleInputError("refused")

    monkeypatch.setattr(SchedulerSolver, "_build_model", refuse)

    assert strict_check(_week(), [], _settings(), seconds=5.0) == "UNDECIDED"


@pytest.mark.parametrize(("left", "probes"), [(34.9, 0), (35.0, 1)])
def test_no_check_is_started_with_under_five_seconds_to_give_it(monkeypatch: pytest.MonkeyPatch, left: float, probes: int) -> None:
    # The build before a check is not under its clock: 30 s of headroom come off what is left, and 5 s must remain.
    oracle = _Oracle(least=180)
    monkeypatch.setattr(suggestions, "strict_check", oracle)
    monkeypatch.setattr(suggestions, "MAX_REFINEMENTS", 1)

    refine(_week(), [], [_cap(60, 240)], _settings(), left=lambda: left)

    assert len(oracle.asked) == probes


def test_a_list_the_strict_model_did_not_accept_is_not_lowered(monkeypatch: pytest.MonkeyPatch) -> None:
    payload, days, end = _cap_week()

    def never(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError("a list that was not accepted has nothing to lower")

    monkeypatch.setattr(suggestions, "strict_accepts", lambda *args, **kwargs: False)
    monkeypatch.setattr(suggestions, "refine", never)

    answer = _suggest(payload, days=days, end=end)

    assert answer.verified is False
    assert {change.proof for change in answer.changes} == {"MAY_HELP"}
    assert all(change.needed_is_least is None for change in answer.changes)


def test_a_spread_of_days_lowered_but_not_to_the_schools_own_is_kept_and_not_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    # The way back of a spread is UP (the school keeps four days between, the timetable needed none): every value on it is at most the school's
    # own, so "reached the school's own value" cannot be read as "is at most it". 3 and 4 days between are refused, 2 (and no rule) hold.
    week = _week()
    target = week.requirements[0].id

    def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
        days = next(r.min_days_between for r in request.requirements if r.id == target)
        return "ACCEPTED" if days is None or days <= 2 else "INFEASIBLE"

    monkeypatch.setattr(suggestions, "strict_check", check)
    apart = suggestions.SuggestedChange.model_validate({
        "rule": "SUBJECT_DAYS_APART", "cost": 10, "current": 4, "needed": 1, "weekdays": [],
        "requirementIds": [target], "roomIds": [], "resourceIds": [], "proof": "SOLVED",
    })

    changes, _ = refine(week, [], [apart], _settings(), left=lambda: 500.0)

    assert [(c.rule, c.needed, c.needed_is_least) for c in changes] == [("SUBJECT_DAYS_APART", 2, True)]


def test_every_check_of_the_lowering_gets_the_workers_of_the_analysis_and_the_timetable_the_search_found(monkeypatch: pytest.MonkeyPatch) -> None:
    # The checks run beside whatever else the engine is doing: a request that names no workers gets DEFAULT_WORKERS and not every core
    # (g384-M-3), and a check without the search's timetable has no hint and is a solve from nothing.
    payload, days, end = _cap_week()
    seen: list[tuple[int | None, int]] = []
    real = suggestions.strict_check

    def spy(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
        seen.append((workers, len(lessons)))
        return real(request, lessons, settings, seconds=seconds, workers=workers)

    monkeypatch.setattr(suggestions, "strict_check", spy)

    answer = _suggest(payload, days=days, end=end)

    assert answer.verified is True and len(seen) >= 1, "the lowering asked at least one check"
    assert {workers for workers, _ in seen} == {suggestions.DEFAULT_WORKERS}
    assert all(lessons > 0 for _, lessons in seen)
