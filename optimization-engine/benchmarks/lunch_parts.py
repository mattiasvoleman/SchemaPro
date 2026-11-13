#!/usr/bin/env python3
"""Klassens måltid per del av läsåret: what planning a meal per part costs the model and the search.

A third of a school's classes have a locked lesson in the lunch window in the
periods of one half of the year and another, a quarter hour later, in the
other half: the year's reading (one meal, clear of every lock of the year) and
the per-part reading (one in each half) both have a timetable, so they can be
measured side by side on the same school, at the same time, one process each
(a loaded machine slows them alike and the ratios still mean something).

    python benchmarks/lunch_parts.py                       # högstadium, 4 periods
    python benchmarks/lunch_parts.py --school bench --students 400
    python benchmarks/lunch_parts.py --solve --budget 60   # the whole of solve(), validated

WHAT IS MEASURED, per variant (benchmarks/periods.py's `measure`, plus the
meals): variables and constraints of the satisfaction model and of the full
model, seconds to build and to a first timetable, with --solve the status and
seconds of solve(), what validate_schedule.py finds in the lessons, and what
lunch_problems finds in the meals of every real week.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import multiprocessing
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import periods as periods_benchmark  # noqa: E402


def with_parts(payload: dict[str, Any], count: int, *, every: int) -> dict[str, Any]:
    """Every `every`th class gets a lock of the first quarter hour of its window in the even periods and of the second in the odd.

    Mondays, in the first and last half hour of the lunch window's start: the
    year's reading closes 11:00-11:55 for such a class and the per-part
    reading leaves each half its own 11:30 or 11:00.
    """
    import uuid

    teacher_of: dict[str, str] = {}
    for row in payload["requirements"]:
        if row.get("teacherId") and row["studentGroupId"] not in teacher_of:
            teacher_of[row["studentGroupId"]] = row["teacherId"]
    locks = list(payload.get("fixedLessons", []))
    classes = [group["id"] for group in payload.get("groups", []) if group["id"] in teacher_of]
    for index, group in enumerate(classes):
        if index % every:
            continue
        for period in range(count):
            first_half = period % 2 == 0
            locks.append({
                "id": str(uuid.uuid5(uuid.NAMESPACE_OID, f"lunch-lock-{group}-{period}")),
                "studentGroupId": group,
                "teacherId": teacher_of[group],
                "dayOfWeek": 1,
                "startTime": "11:00:00" if first_half else "11:30:00",
                "endTime": "11:30:00" if first_half else "12:00:00",
                "periods": [i == period for i in range(count)],
            })
    return {**payload, "fixedLessons": locks, "periodWeeks": [10] * count}


def variant(args: argparse.Namespace, per_period: bool) -> dict[str, Any]:
    from app.config import Settings
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver
    from validate_schedule import lunch_problems

    with contextlib.redirect_stdout(sys.stderr):
        payload, chosen = periods_benchmark._school(args)
        payload = periods_benchmark.clone(payload, chosen, args.periods)
        payload = with_parts(payload, args.periods, every=args.every)
        if per_period:
            payload["lunchPerPeriod"] = True
        out = periods_benchmark.measure(
            payload, budget=args.budget, workers=args.workers, solve=args.solve, first=not args.skip_first,
        )
        if args.solve:
            request = OptimizeScheduleRequest.model_validate(payload)
            solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=args.budget))  # type: ignore[call-arg]
            response = solver.solve(request)
            problems = lunch_problems(solver._grid, request, response.lessons, response.lunches) if response.lessons else []
            out["mealProblems"] = len(problems)
            out["firstMealProblems"] = problems[:3]
            out["mealsWithMask"] = sum(1 for lunch in response.lunches if lunch.periods)
            out["meals"] = len(response.lunches)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--school", choices=("hogstadium", "bench"), default="hogstadium")
    parser.add_argument("--students", type=int, default=400)
    parser.add_argument("--constraint-density", type=float, default=1.0)
    parser.add_argument("--general", action="store_true")
    parser.add_argument("--periods", type=int, default=4)
    parser.add_argument("--every", type=int, default=3, help="every nth class has locks in the lunch window")
    parser.add_argument("--solve", action="store_true")
    parser.add_argument("--skip-first", action="store_true")
    parser.add_argument("--budget", type=float, default=60.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    with ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn")) as pool:
        running = {name: pool.submit(variant, args, name == "per period") for name in ("one meal", "per period")}
        results = {name: job.result() for name, job in running.items()}
    if args.json:
        print(json.dumps(results, indent=1))
        return 0
    keys = [key for key in results["one meal"] if key not in ("firstProblems", "conflictCodes", "firstMealProblems")]
    width = max(len(key) for key in keys)
    print(f"{'':{width}}  " + "  ".join(f"{name:>14}" for name in results))
    for key in keys:
        print(f"{key:{width}}  " + "  ".join(f"{str(results[name].get(key, '')):>14}" for name in results))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
