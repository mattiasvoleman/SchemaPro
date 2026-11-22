"""benchmarks/corpus_report.py: a failed measurement is not a refusal (M5, review of #394).

`corpus_measure.py` answers ERROR for a week it could not measure (HOOK_NOT_CALLED, a wall-clock limit that
decided, a tree that cannot be handed the week). The report counts `vägran` as "the engine proved the week
impossible", so an ERROR week counted there is a number in the handbook that nobody proved.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_report as rep  # noqa: E402


def week(name: str, status: str, work: float | None = None, codes: list[str] | None = None) -> dict[str, object]:
    return {
        "name": name, "status": status, "firstScheduleDeterministic": work, "firstScheduleSeconds": None,
        "conflictCodes": codes or [],
        "facts": {"classes": 9, "lessons": 207, "groupSubjects": 3, "sharedTeachers": 0, "sharedTeachersAsked": 0,
                  "termSubjects": 0, "blockedRequirements": 0},
    }


def test_an_error_week_has_no_outcome_and_is_named() -> None:
    with pytest.raises(ValueError, match=r"n9-g3-m0-s1.*HOOK_NOT_CALLED"):
        rep.outcome(week("n9-g3-m0-s1", "ERROR", codes=["HOOK_NOT_CALLED", "the solve returned a timetable"]))


def test_a_report_of_a_measurement_with_an_error_week_is_refused_and_not_counted_as_a_refusal() -> None:
    rows = [week("n9-g3-m0-s1", "FIRST_SCHEDULE", 0.5), week("n9-g3-m0-s2", "ERROR", codes=["WALL_LIMIT_BEFORE_BUDGET"])]
    with pytest.raises(ValueError, match="n9-g3-m0-s2"):
        rep.report(rows)
    with pytest.raises(ValueError, match="n9-g3-m0-s2"):
        rep.summarise(rows)


def test_an_error_week_in_the_clock_measurement_is_refused_too() -> None:
    rows = [week("n9-g3-m0-s1", "FIRST_SCHEDULE", 0.5)]
    clock = [week("n9-g3-m0-s1", "ERROR", codes=["WALL_LIMIT_BEFORE_BUDGET"])]
    with pytest.raises(ValueError, match="n9-g3-m0-s1"):
        rep.report(rows, clock)


def test_a_real_refusal_is_still_a_refusal() -> None:
    assert rep.outcome(week("a", "INFEASIBLE", codes=["TEACHER_SHARED_BY_PARALLEL_GROUPS"])) == "vägran"
    assert rep.outcome(week("a", "REFUSED", codes=["InvalidScheduleInputError"])) == "vägran"
    assert rep.summarise([week("a", "REFUSED"), week("b", "FIRST_SCHEDULE", 1.0)])["vagran"] == 1
