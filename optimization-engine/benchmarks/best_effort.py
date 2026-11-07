#!/usr/bin/env python3
"""Bästa möjliga schema, measured: model size, time to a first timetable, quality.

The week is the högstadium test school (hogstadium.py) with Lärarens dag's
rows, which is the week the generator phases measure on, and fuzzed impossible
variants of it: the same school with a few teachers' caps, posts and subjects'
distribution rules pushed past what the week can hold. Every one of those is
HARD-FEASIBLE: only a rule on the list in app/solver/relaxation.py makes it
impossible, which is what the mode is for.

    python benchmarks/best_effort.py pair first base            # strict vs relaxed, concurrent
    python benchmarks/best_effort.py pair first impossible --seed 3
    python benchmarks/best_effort.py pair solve fuzz --seed 1 --budget 60
    python benchmarks/best_effort.py sizes base                 # strict vs relaxed model sizes
    python benchmarks/best_effort.py strict-ab base             # this tree vs another tree, strict, concurrent
    python benchmarks/best_effort.py one first-relaxed fuzz --seed 2

TWO SIDES RUN AT ONCE, never one after the other. The Mac is shared with a
dozen sessions and its load moves the same run by a factor of three; two runs
started together see the same load, so the ratio between them means something
where either number alone does not (the paired method of the round's rules).
Each side runs CP-SAT with `--workers` workers (eight by default, the round's
setting), in a process of its own.

WHAT THE KINDS MEASURE:
  first-strict / first-relaxed   seconds to a FIRST timetable of the satisfaction
                                 model phase 1a builds, with the build's size.
                                 The relaxed side is the model of
                                 SchedulerSolver._solve_best_effort: the same
                                 hard rules, the relaxable ones priced.
  solve-strict / solve-relaxed   the whole solve() at `--budget` seconds: status,
                                 wall time, lessons placed, and what gave way.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
import uuid
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

import hogstadium  # noqa: E402
from app.config import Settings  # noqa: E402
from app.exceptions import OptimizationEngineError  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver import relaxation  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

_NS = uuid.UUID("5b0f6c4e-1f1d-4f0e-9a0e-2a9a4f0c7e11")
THIS = Path(__file__).resolve()


# ---------------------------------------------------------------------------
# The weeks
# ---------------------------------------------------------------------------


def _weekly_minutes(request: OptimizeScheduleRequest) -> dict[uuid.UUID, int]:
    minutes: dict[uuid.UUID, int] = defaultdict(int)
    for requirement in request.requirements:
        for teacher in {requirement.teacher_id, requirement.co_teacher_id} - {None}:
            minutes[teacher] += sum(requirement.lesson_minutes())
    return minutes


def fuzz(request: OptimizeScheduleRequest, seed: int) -> OptimizeScheduleRequest:
    """The week with a few rules pushed past what it can hold, from `seed`.

    Three teachers get a daily cap under a fifth of their week, one gets a
    post of two days, and three subjects of three lessons get "one a day, not
    on consecutive days" on top of a four-day school week of frames — each a
    rule on the list, so that the week is impossible for them alone and
    possible without them.
    """
    rng = random.Random(seed)
    loads = _weekly_minutes(request)
    heavy = sorted(teacher for teacher, minutes in loads.items() if minutes >= 900)
    chosen = rng.sample(heavy, min(4, len(heavy)))
    rules = {rule.teacher_id: rule for rule in request.teacher_work_rules}
    limits = {limit.teacher_id: limit for limit in request.teacher_day_limits}
    for teacher in chosen[:3]:
        cap = max(30, (loads[teacher] // 5 // 30) * 30 - 30)
        rule = rules.get(teacher)
        if rule is not None:
            rules[teacher] = rule.model_copy(update={"max_teaching_minutes_per_day": cap})
        else:
            rules[teacher] = type(request.teacher_work_rules[0]).model_validate({
                "id": hogstadium._uid(f"g2-rule-{teacher}"),
                "teacherId": str(teacher),
                "maxTeachingMinutesPerDay": cap,
            })
    if len(chosen) > 3 and chosen[3] not in limits:
        limits[chosen[3]] = type(request.teacher_day_limits[0]).model_validate({
            "id": hogstadium._uid(f"g2-post-{chosen[3]}"),
            "teacherId": str(chosen[3]),
            "maxTeachingDaysPerWeek": 2,
            "lockedWeekdays": [[]],
        })
    three = [r for r in request.requirements if r.lessons_per_week == 3 and r.block_id is None]
    picked = {r.id for r in rng.sample(three, min(3, len(three)))}
    requirements = [
        r.model_copy(update={"max_lessons_per_day": 1, "min_days_between": 2})
        if r.id in picked
        else r
        for r in request.requirements
    ]
    return request.model_copy(update={
        "requirements": requirements,
        "teacher_work_rules": list(rules.values()),
        "teacher_day_limits": list(limits.values()),
    })


def week(scenario: str, seed: int) -> OptimizeScheduleRequest:
    if scenario == "base":
        return hogstadium.build_request(teacher_day_rules=True)
    if scenario == "impossible":
        return hogstadium.build_request(teacher_day_rules=True, infeasible_days=True)
    if scenario == "fuzz":
        return fuzz(hogstadium.build_request(teacher_day_rules=True), seed)
    msg = f"unknown scenario {scenario}"
    raise SystemExit(msg)


# ---------------------------------------------------------------------------
# One measurement
# ---------------------------------------------------------------------------


def _load() -> float:
    return round(os.getloadavg()[0], 1)


def _eight(workers: int, deterministic: float | None = None) -> None:
    """Every generation solve of this process runs `workers` workers.

    With ONE worker the solve is limited in the solver's own deterministic time
    (`deterministic` seconds a phase) and given a fixed seed, so the host's
    load does not move what it finds: the way to compare two builds on a Mac
    that a dozen sessions share.
    """
    original = SchedulerSolver._generation_solver

    def with_workers(request, seconds):  # type: ignore[no-untyped-def]
        solver = original(request, seconds)
        solver.parameters.num_workers = workers
        if workers == 1 and deterministic is not None:
            solver.parameters.random_seed = 0
            solver.parameters.max_time_in_seconds = 6 * 3600
            solver.parameters.max_deterministic_time = deterministic
        return solver

    SchedulerSolver._generation_solver = staticmethod(with_workers)  # type: ignore[method-assign]


def teacher_idle(request: OptimizeScheduleRequest, lessons) -> int:  # type: ignore[no-untyped-def]
    """Minutes teachers wait between their first and last lesson of a day."""
    by_requirement = {r.id: r for r in request.requirements}
    days: dict[tuple[uuid.UUID, int], list[tuple[int, int]]] = defaultdict(list)
    for lesson in lessons:
        requirement = by_requirement[lesson.requirement_id]
        start = int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5])
        end = int(lesson.end_time[:2]) * 60 + int(lesson.end_time[3:5])
        for teacher in {requirement.teacher_id, requirement.co_teacher_id} - {None}:
            days[(teacher, lesson.day_of_week)].append((start, end))
    idle = 0
    for spans in days.values():
        spans.sort()
        busy = sum(end - start for start, end in spans)
        idle += max(0, spans[-1][1] - spans[0][0] - busy)
    return idle


def measure(kind: str, scenario: str, seed: int, budget: float, workers: int) -> dict[str, object]:
    request = week(scenario, seed)
    deterministic = budget if workers == 1 else None
    settings = Settings(SOLVER_MAX_TIME_SECONDS=100000.0 if workers == 1 else budget)  # type: ignore[call-arg]
    solver = SchedulerSolver(settings)
    _eight(workers, deterministic)
    relaxed = kind.endswith("relaxed")
    out: dict[str, object] = {
        "kind": kind, "scenario": scenario, "seed": seed, "workers": workers,
        "tree": str(THIS.parent.parent),
        "relaxableRules": relaxation.prices_anything(request) if hasattr(relaxation, "prices_anything") else None,
    }
    started = time.perf_counter()
    load_before = _load()
    try:
        if kind.startswith("first"):
            out.update(_first(solver, request, relaxed, budget, workers))
        else:
            out.update(_solve(solver, request, relaxed))
    except OptimizationEngineError as error:
        out.update({"status": "REFUSED", "refusal": getattr(error, "code", type(error).__name__)})
    out["wallSeconds"] = round(time.perf_counter() - started, 2)
    out["loadAverage"] = [load_before, _load()]
    return out


def _first(
    solver: SchedulerSolver, request: OptimizeScheduleRequest, relaxed: bool,
    budget: float, workers: int,
) -> dict[str, object]:
    checked = relaxation.strip(request) if relaxed else request
    solver._validate_request(checked)
    kwargs: dict[str, object] = {}
    full_kwargs: dict[str, object] = {}
    if relaxed:
        kwargs["relax"] = relaxation.Relax(solver._grid.slot_minutes)
        full_kwargs["relax"] = relaxation.Relax(solver._grid.slot_minutes)
    build_started = time.perf_counter()
    model, *_ = solver._build_model(
        request, use_assumptions=False, include_objective=False, **kwargs,  # type: ignore[arg-type]
    )
    built = time.perf_counter() - build_started
    full, *_ = solver._build_model(
        request, use_assumptions=False, include_objective=True, **full_kwargs,  # type: ignore[arg-type]
    )
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = budget
    cp.parameters.num_workers = workers
    cp.parameters.stop_after_first_solution = True
    if workers == 1:
        # ONE WORKER AND A FIXED SEED, LIMITED IN DETERMINISTIC TIME: the
        # host's load then does not enter the number that matters, the
        # solver's own deterministic time, nor the point the search stops at.
        # `budget` is then deterministic seconds and the wall clock is let run.
        cp.parameters.random_seed = 0
        cp.parameters.max_time_in_seconds = 6 * 3600
        cp.parameters.max_deterministic_time = budget
    status = cp.StatusName(cp.Solve(model))
    return {
        "status": status,
        "deterministicTime": round(cp.ResponseProto().deterministic_time, 2),
        "buildSeconds": round(built, 2),
        "firstSolutionSeconds": round(cp.WallTime(), 2),
        "variables": len(model.Proto().variables),
        "constraints": len(model.Proto().constraints),
        "fullVariables": len(full.Proto().variables),
        "fullConstraints": len(full.Proto().constraints),
    }


def _solve(
    solver: SchedulerSolver, request: OptimizeScheduleRequest, relaxed: bool,
) -> dict[str, object]:
    asked = (
        OptimizeScheduleRequest.model_validate({
            **request.model_dump(by_alias=True, mode="json"), "relaxation": {"mode": "BEST_EFFORT"},
        })
        if relaxed
        else request
    )
    response = solver.solve(asked)
    details = response.deviations or []
    return {
        "status": response.status,
        "lessons": len(response.lessons),
        "requested": sum(r.lessons_per_week for r in request.requirements),
        "conflictCode": response.conflicts.summary_code if response.conflicts else None,
        "deviations": len(details),
        "deviationCodes": sorted({detail.code for detail in details}),
        "deviationUnits": sum(int(detail.params.get("over", detail.params.get("pairs", detail.params.get("lessons", 1)))) for detail in details),
        "teacherIdleMinutes": teacher_idle(request, response.lessons) if response.lessons else None,
        "wishesKept": hogstadium.wishes_kept(request, response.lessons)[0] if response.lessons else None,
    }


# ---------------------------------------------------------------------------
# Pairs
# ---------------------------------------------------------------------------


def _spawn(
    kind: str, scenario: str, seed: int, budget: float, workers: int, tree: Path,
) -> subprocess.Popen[str]:
    script = tree / "benchmarks" / "best_effort.py"
    return subprocess.Popen(
        [sys.executable, str(script), "one", kind, scenario, "--seed", str(seed),
         "--budget", str(budget), "--workers", str(workers)],
        stdout=subprocess.PIPE, text=True,
    )


def _collect(process: subprocess.Popen[str]) -> dict[str, object]:
    stdout, _ = process.communicate()
    lines = [line for line in stdout.splitlines() if line.startswith("{")]
    return json.loads(lines[-1]) if lines else {"status": "NO OUTPUT"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("one", "pair", "sizes", "strict-ab"))
    parser.add_argument("what", help="kind (one), first|solve (pair), or the scenario")
    parser.add_argument("scenario", nargs="?", default="base")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--budget", type=float, default=60.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--other-tree", type=Path, default=None,
                        help="strict-ab: the optimization-engine directory of the tree to compare against")
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args()

    if args.command == "one":
        print(json.dumps(measure(args.what, args.scenario, args.seed, args.budget, args.workers)))
        return 0

    tree = THIS.parent.parent
    results: list[dict[str, object]] = []
    for _ in range(args.repeats):
        if args.command == "pair":
            a, b = (f"{args.what}-strict", f"{args.what}-relaxed")
            sides = [(a, tree), (b, tree)]
            scenario = args.scenario
        elif args.command == "strict-ab":
            if args.other_tree is None:
                parser.error("strict-ab needs --other-tree")
            # hogstadium.py exists in both trees and says the same thing in both.
            processes = [
                subprocess.Popen(
                    [sys.executable, str(t / "benchmarks" / "hogstadium.py"), "--first-solution",
                     "--teacher-day-rules", "--json", "--budget", str(args.budget)],
                    stdout=subprocess.PIPE, text=True, cwd=str(t),
                )
                for t in (args.other_tree, tree)
            ]
            results.extend(_collect(process) for process in processes)
            continue
        else:
            sides = [("first-strict", tree), ("first-relaxed", tree)]
            scenario = args.what
        processes = [_spawn(kind, scenario, args.seed, args.budget, args.workers, t) for kind, t in sides]
        results.extend(_collect(process) for process in processes)
    for result in results:
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
