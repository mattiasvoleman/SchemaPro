"""benchmarks/corpus_measure.py: the parts the nightly gate stands on that no test reached (M5, review of #394).

The 13 tests of test_corpus_measure.py hold the hook, the one-worker fixed-seed search and the two guards. What
the nightly job runs is `main()` through a process pool, and what the gate reads is the JSON it prints: this holds
that the deterministic budget is set on every search, that the work to the first timetable is the sum of the
searches (the gate's "two searches a solve" ceiling stands on it), that a tree that cannot be handed a week
answers ERROR for that week alone, and that what `main()` prints is what `solve-corpus-gate.mjs` reads.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_measure as measure  # noqa: E402
import school_corpus as corpus  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402
from school_corpus import SchoolShape  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
GATE = REPO / "scripts" / "bench" / "solve-corpus-gate.mjs"
TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)
TINY_TOO = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0, seed=2)


def test_count_mode_gives_every_search_the_deterministic_budget() -> None:
    """Without it the only limit is the wall-clock safety (1000 times the budget): no week would ever time out."""
    from app.config import Settings

    seen: list[float] = []

    class Spy(measure.MeasuringSolver):
        def _generation_solver(self, request, seconds):  # type: ignore[override]
            solver = super()._generation_solver(request, seconds)
            seen.append(solver.parameters.max_deterministic_time)
            return solver

    Spy(
        Settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=0),  # type: ignore[call-arg]
        mode="count", deterministic_budget=3.5, seed=1,
    ).measure(corpus.build_week(TINY).request)
    assert seen
    assert all(budget == pytest.approx(3.5) for budget in seen)


def test_the_work_to_the_first_timetable_is_the_work_of_every_search_that_came_before_it() -> None:
    """A solve whose phase 1a gives up and whose phase 1b finds the timetable has spent both: the gate's ceiling is two budgets."""
    rnd = random.Random(3)
    hard = cp_model.CpModel()
    xs = [hard.NewBoolVar(f"x{i}") for i in range(300)]
    for _ in range(int(4.26 * 300)):  # random 3-SAT at its threshold: no answer in a hundredth of a second of work
        vs = rnd.sample(range(300), 3)
        hard.AddBoolOr([xs[v] if rnd.random() < 0.5 else xs[v].Not() for v in vs])
    easy = cp_model.CpModel()
    easy.NewBoolVar("a")

    recording = measure.Recording()
    recording.entered = time.monotonic()
    first = measure._RecordingCpSolver(recording, lambda now: [])
    first.parameters.num_workers = 1
    first.parameters.max_deterministic_time = 0.002
    assert first.StatusName(first.Solve(hard)) == "UNKNOWN"
    second = measure._RecordingCpSolver(recording, lambda now: [])
    with pytest.raises(measure.FirstScheduleReached):
        second.Solve(easy)
    spent = [search.deterministic for search in recording.searches]
    assert len(spent) == 2 and spent[0] > 100 * spent[1]
    assert recording.first_deterministic == pytest.approx(sum(spent))


def test_a_tree_that_cannot_be_handed_a_week_answers_error_for_that_week_and_not_for_the_run(monkeypatch) -> None:
    def refuses(shape):
        msg = "periods: extra fields not permitted"
        raise ValueError(msg)

    monkeypatch.setattr(corpus, "build_week", refuses)
    row = measure.measure_shape(TINY, mode="count", budget=0.0, deterministic_budget=4.0)
    assert row["status"] == "ERROR" and row["conflictCodes"][0] == "ValueError"
    assert row["name"] == TINY.name() and row["facts"] == {"corpusVersion": corpus.CORPUS_VERSION}
    assert row["firstScheduleDeterministic"] is None and row["mode"] == "count" and row["deterministicBudget"] == 4.0


def test_a_profile_through_a_pool_comes_back_in_the_profile_s_order_with_the_fields_the_gate_reads() -> None:
    rows = measure.run_profile([TINY, TINY_TOO], mode="count", budget=0.0, deterministic_budget=5.0, jobs=2)
    assert [row["name"] for row in rows] == [TINY.name(), TINY_TOO.name()]
    for row in rows:
        assert row["status"] == "FIRST_SCHEDULE"
        assert isinstance(row["firstScheduleDeterministic"], float) and row["firstScheduleDeterministic"] > 0
        assert row["mode"] == "count" and row["deterministicBudget"] == 5.0
        assert row["facts"]["corpusVersion"] == corpus.CORPUS_VERSION
    assert rows == json.loads(json.dumps(rows)), "plain JSON, as main() prints it"


def test_what_main_prints_is_what_the_gate_reads(monkeypatch, capsys, tmp_path) -> None:
    """The seam: the names of the fields on the Python side and on the Node side. A rename on one leaves the gate comparing nothing."""
    monkeypatch.setattr(corpus, "GATE_WEEKS", ("n9-g4-m0-s1", "n9-g3-m0-s2"))
    monkeypatch.setattr(sys, "argv", ["corpus_measure.py", "--profile", "gate", "--mode", "count", "--det-budget", "4", "--json"])
    assert measure.main() == 0
    printed = capsys.readouterr().out
    rows = json.loads(printed)  # nothing but the JSON on stdout: the job redirects it into a file
    assert [row["name"] for row in rows] == ["n9-g4-m0-s1", "n9-g3-m0-s2"]
    node = shutil.which("node")
    if node is None:
        pytest.skip("no node on this machine: the Node half of the seam is not run")
    (tmp_path / "rows.json").write_text(printed, encoding="utf-8")
    done = subprocess.run(  # noqa: S603
        [node, str(GATE), "--head", str(tmp_path / "rows.json"), "--floor", str(tmp_path / "rows.json")],
        capture_output=True, text=True, check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert "weeks both solve: 2 of 2" in done.stdout and "PASS" in done.stdout
