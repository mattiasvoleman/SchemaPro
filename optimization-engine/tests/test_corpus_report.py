"""benchmarks/corpus_report.py: the tables a corpus measurement is quoted from (M5).

Pure arithmetic on rows `corpus_measure.py` wrote, so the rows here are written by hand: what is
held is that an outcome is counted as what it is (a refusal is not a TIMEOUT), the median and the
ninetieth percentile are those of the weeks that got a timetable only, and a table groups by the
key it says.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_report as rep  # noqa: E402


def week(name: str, classes: int, status: str, work: float | None = None, *, groups: int = 3,
         shared: int = 0, terms: int = 0, seconds: float | None = None) -> dict[str, object]:
    return {
        "name": name,
        "status": status,
        "firstScheduleDeterministic": work,
        "firstScheduleSeconds": seconds,
        "conflictCodes": [],
        "facts": {
            "classes": classes, "lessons": classes * 23, "groupSubjects": groups,
            "sharedTeachers": shared, "sharedTeachersAsked": shared, "termSubjects": terms,
            "blockedRequirements": 0,
        },
    }


def test_an_outcome_is_a_timetable_a_timeout_or_a_refusal() -> None:
    assert rep.outcome(week("a", 9, "FIRST_SCHEDULE", 1.0)) == "schema"
    assert rep.outcome(week("a", 9, "TIMEOUT")) == "timeout"
    assert rep.outcome(week("a", 9, "INFEASIBLE")) == "vägran"
    assert rep.outcome(week("a", 9, "REFUSED")) == "vägran"


def test_the_median_and_the_ninetieth_percentile_are_of_the_weeks_with_a_timetable_only() -> None:
    rows = [week(f"w{i}", 12, "FIRST_SCHEDULE", float(i)) for i in range(1, 11)]
    rows += [week("t", 12, "TIMEOUT"), week("r", 12, "INFEASIBLE")]
    cell = rep.summarise(rows)
    assert (cell["weeks"], cell["schema"], cell["timeout"], cell["vagran"]) == (12, 10, 1, 1)
    assert cell["workMedian"] == 5.5
    assert cell["workP90"] == pytest.approx(9.1)


def test_a_cell_with_no_timetable_has_no_median() -> None:
    cell = rep.summarise([week("t", 12, "TIMEOUT"), week("u", 12, "TIMEOUT")])
    assert cell["workMedian"] is None and cell["workP90"] is None and cell["timeout"] == 2


def test_seconds_come_from_the_clock_measurement_of_the_same_weeks() -> None:
    rows = [week("a", 9, "FIRST_SCHEDULE", 1.0), week("b", 9, "FIRST_SCHEDULE", 2.0), week("c", 9, "TIMEOUT")]
    cell = rep.summarise(rows, {"a": 10.0, "b": 30.0, "c": 99.0})
    assert cell["secondsMedian"] == 20.0
    assert cell["secondsP90"] == pytest.approx(28.0)


def test_percentile_edges() -> None:
    assert rep.percentile([], 0.9) is None
    assert rep.percentile([4.0], 0.9) == 4.0
    assert rep.percentile([1.0, 3.0], 0.5) == 2.0
    assert rep.percentile([3.0, 1.0, 2.0], 1.0) == 3.0


def test_a_table_groups_by_its_key_in_order_and_says_the_counts() -> None:
    rows = [
        week("a", 12, "FIRST_SCHEDULE", 1.0), week("b", 12, "TIMEOUT"),
        week("c", 6, "FIRST_SCHEDULE", 0.5), week("d", 6, "FIRST_SCHEDULE", 0.7),
    ]
    lines = rep.table("N", rows, lambda r: r["facts"]["classes"], label="N klasser")
    assert lines[0] == "### N"
    assert lines[3].startswith("|---")
    first, second = lines[4], lines[5]
    assert first.startswith("| 6 | 2 | 2 | 0 | 0 | 0.60 |")
    assert second.startswith("| 12 | 2 | 1 | 1 | 0 | 1.00 |")


def test_the_report_has_a_table_for_every_axis_and_runs_on_a_measurement() -> None:
    rows = []
    for classes in (6, 9, 12, 18):
        rows.append(week(f"n{classes}-g3-m0-s1", classes, "FIRST_SCHEDULE", 0.5))
        rows.append(week(f"n{classes}-g0-m0-s1", classes, "FIRST_SCHEDULE", 0.4, groups=0))
    for groups in (0, 3, 6):
        rows.append(week(f"n9-g{groups}-m0-s1", 9, "FIRST_SCHEDULE" if groups < 6 else "TIMEOUT", 1.0, groups=groups))
    rows.append(week("n12-g3-m4-s1", 12, "INFEASIBLE", groups=3, shared=4))
    rows.append(week("n12-g3-m0-s1-t3", 12, "FIRST_SCHEDULE", 2.0, terms=3))
    text = "\n".join(rep.report(rows))
    for heading in ("Klasser, tre ämnen i grupper", "Klasser, varje ämne för sig", "Ämnen i grupper över klasserna (G), 9",
                    "Delade lärare (M), 12", "Terminslektioner", "Produktionsformen"):
        assert heading in text
    assert "| 4 | 1 | 0 | 0 | 1 |" in text  # M = 4 at twelve classes: one week, refused


def test_seconds_can_be_an_estimate_from_the_work_and_are_marked_as_one() -> None:
    rows = [week("a", 9, "FIRST_SCHEDULE", 1.0), week("b", 9, "FIRST_SCHEDULE", 3.0), week("c", 9, "TIMEOUT")]
    cell = rep.summarise(rows, factor=18.0)
    assert cell["secondsMedian"] == 36.0
    assert cell["secondsP90"] == pytest.approx(18.0 + 0.9 * 36.0)
    lines = rep.table("N", rows, lambda r: r["facts"]["classes"], factor=18.0, label="N klasser")
    assert "≈ sek median" in lines[2] and lines[4].count("|") == 10
    # A measured clock wins over the estimate, and carries no mark.
    measured = rep.table("N", rows, lambda r: r["facts"]["classes"], seconds={"a": 5.0, "b": 7.0}, factor=18.0,
                         label="N klasser")
    assert "≈" not in measured[2]


def test_the_tables_can_be_written_in_english_for_docs() -> None:
    rows = [week("n9-g3-m0-s1", 9, "FIRST_SCHEDULE", 0.5), week("n9-g3-m0-s2", 9, "TIMEOUT")]
    english = "\n".join(rep.report(rows, factor=18.0, lang="en"))
    swedish = "\n".join(rep.report(rows, factor=18.0, lang="sv"))
    assert "| N classes | weeks | timetable | timeout | refused | work median |" in english
    assert "≈ s median" in english and "Shared teachers (M), 9 classes" in english
    assert "| N klasser | veckor | schema | timeout | vägran |" in swedish
    assert "weeks" not in swedish and "veckor" not in english
