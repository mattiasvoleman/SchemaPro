#!/usr/bin/env python3
"""Time to a first timetable, and how often there is none, for weeks shaped like real schools (M5).

    python benchmarks/corpus_measure.py --profile gate  --mode count --json
    python benchmarks/corpus_measure.py --profile sweep --mode clock --budget 120 --json
    python benchmarks/corpus_measure.py --week hogstadium --mode clock

WHAT IS MEASURED. The seconds from `solve()`'s entry to the first timetable any
of its generation searches finds: the prechecks, the builds and phase 1a (and
1b where 1a gives up), which is what a school waits for. Phase 2 spends the
rest of the budget improving a timetable that already exists, so it says how
long the budget was and nothing about how hard the week is; the measurement
stops at the first timetable. A week that has none inside the budget is a
TIMEOUT, as it is for a school, and a refusal is a refusal.

NOTHING IN THE ENGINE IS CHANGED. The solver is the engine's own SchedulerSolver
with one method replaced: `_generation_solver`, which every one of the
generation searches calls for its CpSolver. The replacement hands back a CpSolver
that records each Solve and, at the first timetable, stops the whole solve with
an exception that is not an `Exception` (so that `_solve_guarded`, which retries a
solve that throws, lets it through). `test_corpus_measure.py` keeps the hook: a
solver that no longer calls `_generation_solver` fails that test, not this tool
in silence.

TWO MODES.
  clock  every core, wall-clock seconds, as production runs. Comparable only on
         one machine, at one load: every result carries the load average.
  count  one worker and a fixed seed, so CP-SAT repeats the same search, and a
         budget in CP-SAT's DETERMINISTIC time (operations counted, not seconds)
         beside a wall-clock safety limit that is never meant to bind. The
         deterministic time is the same on every machine, which is what lets a
         nightly gate compare a tree with a floor without trusting a runner's
         speed (scripts/bench/solve-corpus-gate.mjs).

SEVERAL SEEDS (`--seeds 3`, count mode). One seed is one throw of the search's dice: the same week
needed 0.49 deterministic seconds at one seed and found nothing in 8 at the next, and a change to the
model is exactly such a new throw. A gate that compares one throw of a tree with one throw of its floor
reads the dice. With `--seeds K` every week is searched at seeds 1..K and its row is the MIDDLE
measurement (the median of the work, a week no search found counting as worse than any that did), so a
week is a timeout only when most seeds time out, and `seedWork` lists what each seed needed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

#: The engine tree to measure: this one, or the one ENGINE_ROOT names. The nightly gate
#: runs THIS script against two trees (this one and its floor), so that one corpus and
#: one harness measure both engines; the tree is read from the environment, which a
#: process pool's workers inherit.
ENGINE_ROOT = Path(os.environ.get("ENGINE_ROOT") or Path(__file__).resolve().parent.parent).resolve()
sys.path.insert(0, str(ENGINE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

from app.config import Settings  # noqa: E402
from app.exceptions import OptimizationEngineError  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

#: The wall-clock safety limit in `count` mode, as a multiple of the deterministic budget. It
#: exists so that a search that hangs ends; it is never meant to decide, because a verdict that
#: the host's load decided is no longer count mode's. One deterministic second took 8-25 s of one
#: worker on a quiet dev machine and up to 69 s at load 80, so a multiple of 40 (the first value)
#: decided 13 of the 33 TIMEOUTs of the first sweep, at load 55-119. A search that ends before its
#: deterministic budget is therefore an ERROR (WALL_LIMIT_BEFORE_BUDGET), never a TIMEOUT.
COUNT_WALL_MULTIPLE = 1000.0
#: How near its budget a search must have got for a TIMEOUT to be the budget's.
BUDGET_REACHED = 0.95
#: The status of a week that got a first timetable.
SOLVED = "FIRST_SCHEDULE"


class FirstScheduleReached(BaseException):
    """The first timetable is in hand: stop the solve.

    A BaseException on purpose: `_solve_guarded` retries a solve that raises an
    Exception (and takes a crash for a refusal after the second), and this is
    neither."""


@dataclass
class Search:
    """One CP-SAT search of the solve, as the recording solver saw it."""

    status: str
    seconds: float
    deterministic: float
    conflicts: int
    first_only: bool


@dataclass
class Recording:
    searches: list[Search] = field(default_factory=list)
    entered: float = 0.0
    #: Set when the first timetable was found: seconds since `entered`.
    first_at: float | None = None
    first_deterministic: float | None = None
    stages: list[tuple[str, float]] = field(default_factory=list)


class _RecordingCpSolver(cp_model.CpSolver):
    def __init__(self, recording: Recording, stage_of) -> None:
        super().__init__()
        self._recording = recording
        self._stage_of = stage_of

    def Solve(self, model, solution_callback=None):  # noqa: N802 (the library's name)
        started = time.monotonic()
        if self._recording.first_at is not None:
            # The first timetable is in hand and the engine went on (a path of an older engine
            # that swallowed the stop): no further search is run, the measurement is made.
            raise FirstScheduleReached
        status = super().Solve(model, solution_callback)
        now = time.monotonic()
        response = self.ResponseProto()
        rec = self._recording
        rec.searches.append(
            Search(
                status=self.StatusName(status),
                seconds=now - started,
                deterministic=response.deterministic_time,
                conflicts=self.NumConflicts(),
                first_only=bool(self.parameters.stop_after_first_solution),
            ),
        )
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) and rec.first_at is None:
            rec.first_at = now - rec.entered
            rec.first_deterministic = sum(s.deterministic for s in rec.searches)
            rec.stages = self._stage_of(now)
            raise FirstScheduleReached
        return status


class MeasuringSolver(SchedulerSolver):
    """The engine's solver with its generation searches recorded (see the module docstring)."""

    def __init__(
        self, settings: Settings, *, mode: str, deterministic_budget: float, seed: int,
    ) -> None:
        super().__init__(settings)
        self.recording = Recording()
        self._mode = mode
        self._deterministic_budget = deterministic_budget
        self._seed = seed

    def _stage_seconds(self, now: float) -> list[tuple[str, float]]:
        """The engine's own step seconds so far; none from an engine that keeps no such account.

        Called by the recording solver the moment the first timetable is found, from inside `Solve`. An
        engine from before the stage clock (the nightly's floor is a week old) has no `_stages`, and an
        AttributeError there is taken by `_solve_guarded` for a CP-SAT crash: it solves once more without
        presolve and logs a warning per week before the stop is raised. The measurement came out right
        and by that detour; this way it does not take it."""
        clock = getattr(self, "_stages", None)
        if clock is None:
            return []
        out = [(name, seconds) for name, seconds in getattr(clock, "_done", [])]
        opened = getattr(clock, "_open", None)
        if opened is not None:
            out.append((opened[0], max(0.0, now - opened[1])))
        return out

    def _generation_solver(self, request, seconds):  # type: ignore[override]
        base = SchedulerSolver._generation_solver(request, seconds)
        solver = _RecordingCpSolver(self.recording, self._stage_seconds)
        solver.parameters.copy_from(base.parameters)
        if self._mode == "count":
            solver.parameters.num_workers = 1
            solver.parameters.random_seed = self._seed
            solver.parameters.max_deterministic_time = self._deterministic_budget
            # Not the engine's own wall-clock share (phase 1a's sixty seconds, what the
            # budget has left): on a loaded host that would make the verdict the host's.
            solver.parameters.max_time_in_seconds = self._deterministic_budget * COUNT_WALL_MULTIPLE
        return solver

    def measure(self, request: OptimizeScheduleRequest) -> dict[str, object]:
        load_before = os.getloadavg()[0]
        self.recording.entered = time.monotonic()
        status = "TIMEOUT"
        codes: list[str] = []
        rec = self.recording
        try:
            response = self.solve(request)
            status = response.status
            if response.conflicts is not None:
                codes = sorted({detail.code for detail in response.conflicts.conflicts})
            if rec.first_at is None and response.lessons:
                # A timetable came back and no search of ours saw it: the engine does not hand
                # its searches to `_generation_solver`, so nothing here was measured.
                status = "ERROR"
                codes = ["HOOK_NOT_CALLED", "the solve returned a timetable that no recorded search found"]
        except FirstScheduleReached:
            pass
        except OptimizationEngineError as refusal:
            if rec.first_at is None:
                status = "REFUSED"
                codes = [type(refusal).__name__, str(refusal)[:200]]
        except Exception:  # noqa: BLE001
            # After the first timetable, whatever the engine trips on because the rest of its
            # solve was cut short is not what is measured; before it, a real failure.
            if rec.first_at is None:
                raise
        total = time.monotonic() - rec.entered
        found = rec.first_at is not None
        if status == "TIMEOUT" and self._mode == "count" and not found:
            cut = [s for s in rec.searches if s.deterministic < BUDGET_REACHED * self._deterministic_budget]
            if cut:
                status = "ERROR"
                codes = ["WALL_LIMIT_BEFORE_BUDGET",
                         f"a search ended at {cut[0].deterministic} of {self._deterministic_budget} "
                         "deterministic seconds: the wall-clock safety decided, not the budget"]
        if found:
            # What decides is the first timetable, however the solve ended after it.
            status = "FIRST_SCHEDULE"
            codes = []
        return {
            "status": status,
            "conflictCodes": codes,
            "firstScheduleSeconds": round(rec.first_at, 2) if found else None,
            "firstScheduleDeterministic": round(rec.first_deterministic, 3) if found else None,
            "totalSeconds": round(total, 2),
            "deterministicSeconds": round(sum(s.deterministic for s in rec.searches), 3),
            "conflicts": sum(s.conflicts for s in rec.searches),
            "stages": {name: round(seconds, 2) for name, seconds in _summed(rec.stages)},
            "searches": [
                {
                    "status": s.status, "seconds": round(s.seconds, 2),
                    "deterministic": round(s.deterministic, 3), "conflicts": s.conflicts,
                    "firstOnly": s.first_only,
                }
                for s in rec.searches
            ],
            "load": [round(load_before, 1), round(os.getloadavg()[0], 1)],
        }


def _summed(stages: list[tuple[str, float]]) -> list[tuple[str, float]]:
    out: dict[str, float] = {}
    for name, seconds in stages:
        out[name] = out.get(name, 0.0) + seconds
    return list(out.items())


def measure_request(
    request: OptimizeScheduleRequest, *, mode: str = "clock", budget: float = 120.0,
    deterministic_budget: float = 30.0, seed: int = 1,
) -> dict[str, object]:
    """Time to a first timetable for `request`; the dictionary of `MeasuringSolver.measure`."""
    if mode not in ("clock", "count"):
        msg = f"mode must be 'clock' or 'count', not {mode!r}"
        raise ValueError(msg)
    if mode == "count":
        # The deterministic limit decides; the wall-clock one is a safety that is
        # not meant to bind (COUNT_WALL_MULTIPLE).
        budget = deterministic_budget * COUNT_WALL_MULTIPLE
    # The probe is spent AFTER a timeout, on naming a rule: not part of the time to a timetable.
    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]
    solver = MeasuringSolver(
        settings, mode=mode, deterministic_budget=deterministic_budget, seed=seed,
    )
    result = solver.measure(request)
    result["mode"] = mode
    result["deterministicBudget"] = deterministic_budget if mode == "count" else None
    result["seed"] = seed
    return result


def median_run(runs: list[dict[str, object]]) -> dict[str, object]:
    """The middle of several measurements of one week at different seeds.

    A week no search found a timetable for ranks below every week one did, so with three seeds the
    week is solved when two of them solve it, and its work is the middle one's. A failed measurement
    (ERROR) is never averaged away: it is what the week answers."""
    errors = [run for run in runs if run["status"] == "ERROR"]
    if errors:
        return errors[0]
    solved = sorted(
        (run for run in runs if run["status"] == SOLVED),
        key=lambda run: float(run["firstScheduleDeterministic"]),  # type: ignore[arg-type]
    )
    unsolved = sorted((run for run in runs if run["status"] != SOLVED), key=lambda run: str(run["status"]))
    ranked = [*solved, *unsolved]
    return ranked[len(ranked) // 2]


def measure_shape(
    shape, *, mode: str, budget: float, deterministic_budget: float, seed: int = 1, seeds: int = 1,
) -> dict[str, object]:
    """One corpus week: its name, its facts, and the measurement. Top level so a process pool can run it.

    With `seeds` above one (count mode) the week is searched at seed, seed + 1, ... and the row is
    the middle measurement (`median_run`), with `seeds` and `seedWork` added."""
    from school_corpus import CORPUS_VERSION, build_week

    try:
        week = build_week(shape)
    except Exception as error:  # noqa: BLE001
        # An engine tree that does not know a field of the corpus (a floor from before a
        # feature the corpus uses) cannot be handed the week: that is its answer for the
        # week, so that one week does not end the measurement of all the others.
        return {
            "name": shape.name(), "facts": {"corpusVersion": CORPUS_VERSION}, "status": "ERROR",
            "conflictCodes": [type(error).__name__, str(error)[:200]], "firstScheduleSeconds": None,
            "firstScheduleDeterministic": None, "mode": mode,
            "deterministicBudget": deterministic_budget if mode == "count" else None, "seed": seed,
        }
    runs = [
        measure_request(
            week.request, mode=mode, budget=budget, deterministic_budget=deterministic_budget,
            seed=seed + offset,
        )
        for offset in range(max(1, seeds))
    ]
    result = runs[0] if len(runs) == 1 else {
        **median_run(runs), "seeds": len(runs), "seedWork": [run["firstScheduleDeterministic"] for run in runs],
    }
    return {"name": week.name, "facts": week.facts, **result}


def run_profile(
    shapes, *, mode: str, budget: float, deterministic_budget: float, jobs: int, seeds: int = 1,
) -> list[dict[str, object]]:
    """Every shape of a profile, `jobs` at a time, in the profile's order."""
    if jobs <= 1:
        return [
            measure_shape(
                shape, mode=mode, budget=budget, deterministic_budget=deterministic_budget, seeds=seeds,
            )
            for shape in shapes
        ]
    from concurrent.futures import ProcessPoolExecutor

    with ProcessPoolExecutor(max_workers=jobs) as pool:
        futures = [
            pool.submit(
                measure_shape, shape, mode=mode, budget=budget,
                deterministic_budget=deterministic_budget, seeds=seeds,
            )
            for shape in shapes
        ]
        return [future.result() for future in futures]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=("clock", "count"), default="clock")
    parser.add_argument("--budget", type=float, default=120.0, help="seconds (clock mode)")
    parser.add_argument("--det-budget", type=float, default=30.0,
                        help="deterministic seconds (count mode)")
    parser.add_argument("--profile", default=None, help="'gate' or 'sweep' (school_corpus.py)")
    parser.add_argument("--only", default=None,
                        help="only these weeks: names, comma separated; a name ending in * is a prefix")
    parser.add_argument("--jobs", type=int, default=1, help="weeks measured side by side")
    parser.add_argument("--seeds", type=int, default=1,
                        help="count mode: search each week at this many seeds and report the middle one")
    parser.add_argument("--week", default=None, help="'hogstadium' (the existing bench)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.seeds < 1 or (args.seeds > 1 and args.mode != "count"):
        parser.error("--seeds must be at least 1, and above 1 only in --mode count (clock mode has no seed)")
    if args.week == "hogstadium":
        from hogstadium import build_request

        result = measure_request(
            build_request(), mode=args.mode, budget=args.budget,
            deterministic_budget=args.det_budget,
        )
        print(json.dumps(result, indent=2 if args.json else None))
        return 0 if result["firstScheduleSeconds"] is not None else 1
    if args.profile is None:
        parser.error("give --profile gate|sweep, or --week hogstadium")
    from school_corpus import profile

    wanted = args.only.split(",") if args.only else None
    shapes = [
        shape for shape in profile(args.profile)
        if wanted is None or any(
            shape.name().startswith(token[:-1]) if token.endswith("*") else shape.name() == token
            for token in wanted
        )
    ]
    if not shapes:
        parser.error(f"no week of {args.profile} matches {args.only}")
    results = run_profile(
        shapes, mode=args.mode, budget=args.budget, deterministic_budget=args.det_budget,
        jobs=args.jobs, seeds=args.seeds,
    )
    print(json.dumps(results, indent=2 if args.json else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
