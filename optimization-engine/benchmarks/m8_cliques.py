#!/usr/bin/env python3
"""What the full model's clique rows (M8 PR 6, DEPLOYMENT §35.10) do to its size, its build and its improving search.

    python benchmarks/m8_cliques.py size    --profile gate --only n9-g3-m0-s2,n12-g3-m0-s1
    python benchmarks/m8_cliques.py quality --profile gate --det 4 --seeds 2 --jobs 4

`size`: the full model of a week (the objective in) built with one row per pair of groups and with the cover by cliques:
the rows the pupils' families post, the intervals they hold, the proto's bytes, and the seconds the build took in Python.

`quality`: the week solved twice, `SOLVER_GROUP_CLIQUES` off and on, in count mode (one worker, a fixed seed, deterministic
seconds, so the number is the same on every machine). PHASE 1a IS THE SAME SEARCH IN BOTH (its model is not built by cliques:
test_group_cliques_model.py holds that byte for byte), so both phases 2 start from the same timetable, and what differs is
the improving search alone: the objective it reached in `--det` deterministic seconds, and the bound it proved (a lower
objective is better). A week whose phase 1 found nothing in its budget has no phase 2 and says so.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import corpus_measure as cm  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver import scheduler_solver as engine  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402
from school_corpus import build_week, profile  # noqa: E402


def size_of(request, *, by_cliques: bool) -> dict[str, object]:
    """The full model of `request` as it is built: the pupils' rows, their intervals, the proto and the seconds."""
    owner: set[int] = set()
    real = engine.pupil_padded_of

    def spy(model, decision):  # noqa: ANN001, ANN202
        interval = real(model, decision)
        owner.add(interval.Index())
        return interval

    engine.pupil_padded_of = spy
    try:
        solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=0))  # type: ignore[call-arg]
        started = time.process_time()
        model, _, _, _, _ = solver._build_model(
            request, use_assumptions=False, include_objective=True, by_cliques=by_cliques,
        )
        built = time.process_time() - started
    finally:
        engine.pupil_padded_of = real
    proto = model.Proto()
    rows = [list(c.no_overlap.intervals) for c in proto.constraints if c.has_no_overlap()]
    pupils = [row for row in rows if any(i in owner for i in row)]
    return {
        "pupilRows": len(pupils),
        "pupilIntervals": sum(len(row) for row in pupils),
        "constraints": len(proto.constraints),
        "protoTextBytes": len(str(proto)),
        "buildCpuSeconds": round(built, 2),
    }


class _Improving(cp_model.CpSolver):
    """A CpSolver that remembers what an objective search reached."""

    def __init__(self, notes: dict[str, object], limit: float, seed: int) -> None:
        super().__init__()
        self._notes = notes
        self.parameters.num_workers = 1
        self.parameters.random_seed = seed
        self.parameters.max_deterministic_time = limit
        self.parameters.max_time_in_seconds = limit * cm.COUNT_WALL_MULTIPLE

    def Solve(self, model, solution_callback=None):  # noqa: N802
        status = super().Solve(model, solution_callback)
        if model.HasObjective():
            self._notes.update({
                "status": self.StatusName(status),
                "objective": self.ObjectiveValue() if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
                "bound": self.BestObjectiveBound() if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
                "deterministic": round(self.ResponseProto().deterministic_time, 3),
            })
        return status


def improve(request, *, cliques: bool, det: float, seed: int, first_budget: float = 4.0) -> dict[str, object]:
    """One solve in count mode: phase 1 as it is, phase 2 for `det` deterministic seconds; what phase 2 reached."""
    notes: dict[str, object] = {}

    class Counted(SchedulerSolver):
        def _generation_solver(self, req, seconds):  # type: ignore[override]
            # The satisfaction searches are as the gate runs them; the one that has an objective is `det`'s.
            return _Dispatch(notes, first_budget, det, seed)

    settings = Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=det * cm.COUNT_WALL_MULTIPLE, SOLVER_PROBE_SECONDS=0, SOLVER_GROUP_CLIQUES=cliques,
    )
    started = time.monotonic()
    response = Counted(settings).solve(request)
    return {"cliques": cliques, "seed": seed, "status": response.status, "wallSeconds": round(time.monotonic() - started, 1), **notes}


class _Dispatch(_Improving):
    """The search of one phase: a satisfaction model gets `first`, a model with an objective gets `det`."""

    def __init__(self, notes: dict[str, object], first: float, det: float, seed: int) -> None:
        super().__init__(notes, first, seed)
        self._first, self._det = first, det

    def Solve(self, model, solution_callback=None):  # noqa: N802
        limit = self._det if model.HasObjective() else self._first
        self.parameters.max_deterministic_time = limit
        self.parameters.max_time_in_seconds = limit * cm.COUNT_WALL_MULTIPLE
        return super().Solve(model, solution_callback)


def _job(task) -> dict[str, object]:  # noqa: ANN001
    shape, det, seed = task
    request = build_week(shape).request
    return {
        "name": shape.name(), "seed": seed,
        "pairs": improve(request, cliques=False, det=det, seed=seed),
        "cliques": improve(request, cliques=True, det=det, seed=seed),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("size", "quality"))
    parser.add_argument("--profile", default="gate")
    parser.add_argument("--only", default=None, help="names, comma separated")
    parser.add_argument("--det", type=float, default=4.0, help="deterministic seconds of phase 2 (quality)")
    parser.add_argument("--seeds", type=int, default=1)
    parser.add_argument("--jobs", type=int, default=1)
    args = parser.parse_args()
    wanted = args.only.split(",") if args.only else None
    shapes = [s for s in profile(args.profile) if wanted is None or s.name() in wanted]
    if not shapes:
        parser.error("no week matches")
    if args.command == "size":
        for shape in shapes:
            request = build_week(shape).request
            print(json.dumps({
                "name": shape.name(), "pairsOfGroups": len(request.group_conflicts),
                "pairs": size_of(request, by_cliques=False), "cliques": size_of(request, by_cliques=True),
            }), flush=True)
        return 0
    tasks = [(shape, args.det, seed) for shape in shapes for seed in range(1, args.seeds + 1)]
    if args.jobs <= 1:
        rows = [_job(task) for task in tasks]
    else:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            rows = list(pool.map(_job, tasks))
    for row in rows:
        print(json.dumps(row), flush=True)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
    raise SystemExit(main())
