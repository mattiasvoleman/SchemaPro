"""benchmarks/corpus_measure.py --seeds: a week is the middle of several searches, not one throw of the dice (M5, review of #394).

The nightly gate compares a tree with its floor week by week. At one seed a week's work is one draw from a
wide distribution (0.49 deterministic seconds at one seed, no timetable in 8 at the next), so any change to
the model re-rolls the draw and the gate's "lost week" rule reads the dice as a regression.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_measure as measure  # noqa: E402
from school_corpus import SchoolShape  # noqa: E402

TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)


def run(status: str, work: float | None = None, seed: int = 1) -> dict[str, object]:
    return {"status": status, "firstScheduleDeterministic": work, "seed": seed, "conflictCodes": []}


def test_the_middle_of_three_solved_seeds_is_the_middle_work() -> None:
    rows = [run("FIRST_SCHEDULE", 3.0, 1), run("FIRST_SCHEDULE", 1.0, 2), run("FIRST_SCHEDULE", 2.0, 3)]
    assert measure.median_run(rows)["firstScheduleDeterministic"] == 2.0


def test_a_week_is_solved_when_most_seeds_solve_it_and_times_out_when_most_do_not() -> None:
    one_timeout = [run("TIMEOUT", None, 1), run("FIRST_SCHEDULE", 1.0, 2), run("FIRST_SCHEDULE", 2.0, 3)]
    assert measure.median_run(one_timeout)["status"] == "FIRST_SCHEDULE"
    assert measure.median_run(one_timeout)["firstScheduleDeterministic"] == 2.0
    two_timeouts = [run("TIMEOUT", None, 1), run("FIRST_SCHEDULE", 1.0, 2), run("TIMEOUT", None, 3)]
    assert measure.median_run(two_timeouts)["status"] == "TIMEOUT"


def test_a_failed_measurement_is_never_averaged_away() -> None:
    error = {**run("ERROR", None, 2), "conflictCodes": ["WALL_LIMIT_BEFORE_BUDGET"]}
    picked = measure.median_run([run("FIRST_SCHEDULE", 1.0, 1), error, run("FIRST_SCHEDULE", 2.0, 3)])
    assert picked["status"] == "ERROR"
    assert picked["conflictCodes"] == ["WALL_LIMIT_BEFORE_BUDGET"]


def test_a_refusal_stays_a_refusal() -> None:
    refused = [{**run("INFEASIBLE"), "conflictCodes": ["X_ONE"]}] * 3
    assert measure.median_run(refused)["status"] == "INFEASIBLE"


def test_a_week_is_searched_at_consecutive_seeds_and_the_row_says_what_each_needed(monkeypatch) -> None:
    seen: list[int] = []
    work = {1: 3.0, 2: 1.0, 3: 2.0}

    def fake(request, *, mode, budget, deterministic_budget, seed):
        seen.append(seed)
        return run("FIRST_SCHEDULE", work[seed], seed)

    monkeypatch.setattr(measure, "measure_request", fake)
    row = measure.measure_shape(TINY, mode="count", budget=0.0, deterministic_budget=4.0, seeds=3)
    assert seen == [1, 2, 3]
    assert row["firstScheduleDeterministic"] == 2.0 and row["seed"] == 3
    assert row["seeds"] == 3 and row["seedWork"] == [3.0, 1.0, 2.0]
    assert row["name"] == TINY.name() and row["facts"]["corpusVersion"]


def test_one_seed_is_what_it_was(monkeypatch) -> None:
    monkeypatch.setattr(measure, "measure_request", lambda request, **kw: run("FIRST_SCHEDULE", 1.5, kw["seed"]))
    row = measure.measure_shape(TINY, mode="count", budget=0.0, deterministic_budget=4.0)
    assert "seeds" not in row and "seedWork" not in row and row["firstScheduleDeterministic"] == 1.5


def test_seeds_are_for_count_mode_only(capsys) -> None:
    with pytest.raises(SystemExit) as stopped:
        monkey_argv(["--profile", "gate", "--mode", "clock", "--seeds", "3"])
    assert stopped.value.code == 2
    assert "--seeds" in capsys.readouterr().err


def monkey_argv(argv: list[str]) -> int:
    old = sys.argv
    sys.argv = ["corpus_measure.py", *argv]
    try:
        return measure.main()
    finally:
        sys.argv = old


def test_three_real_searches_of_a_small_week_give_the_middle_one() -> None:
    row = measure.measure_shape(TINY, mode="count", budget=0.0, deterministic_budget=5.0, seeds=3)
    assert row["status"] == "FIRST_SCHEDULE" and row["seeds"] == 3
    assert len(row["seedWork"]) == 3 and row["firstScheduleDeterministic"] in row["seedWork"]
    assert row["firstScheduleDeterministic"] == sorted(row["seedWork"])[1]
