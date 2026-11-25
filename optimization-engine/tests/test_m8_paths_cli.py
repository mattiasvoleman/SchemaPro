"""benchmarks/m8_paths.py runs from its command line (M8).

test_m8_paths.py calls the functions of the script, never `main()`: `encoding`, `years`, `start` and `slack` had no
test at all (`start` and `slack` read the engine's own private helpers: `_weeks_and_requests`, `_solved_weeks`,
`_week_loads`, `TIGHT_WEEK_LOAD`), so a rename in the engine would have been found by whoever next wanted a
measurement, in the middle of one. One week of the corpus that lays in a second is run through each of them.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402

SMALL = "n6-g0-m0-s1"


def _main(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], *argv: str) -> str:
    monkeypatch.setattr(sys, "argv", ["m8_paths.py", *argv])
    assert paths.main() == 0
    return capsys.readouterr().out


def test_encoding_lays_the_week_under_each_encoding(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    out = _main(monkeypatch, capsys, "encoding", "--only", SMALL, "--encodings", "pairs,cliques,cohorts,both")
    assert out.count("FIRST_SCHEDULE") == 4, out


def test_years_lays_the_week_a_year_at_a_time_and_the_engine_accepts_it(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _main(monkeypatch, capsys, "years", "--only", SMALL)
    assert "FIRST_SCHEDULE" in out and "verified True" in out, out


def test_start_lays_a_week_from_the_schedule_of_its_neighbour_seed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _main(monkeypatch, capsys, "start", "--only", SMALL, "--into", "1", "--from-seed", "2")
    assert '"repairStatus": "FIRST_SCHEDULE"' in out, out


def test_slack_says_how_full_the_year_is_of_its_frame(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _main(monkeypatch, capsys, "slack", "--only", SMALL, "--ends", "16:00", "--encodings", "pairs")
    assert "yearLoad [" in out and "FIRST_SCHEDULE" in out, out
