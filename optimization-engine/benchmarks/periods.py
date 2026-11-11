#!/usr/bin/env python3
"""Terminer: what cutting a school's year into periods costs the model and the search.

A period is a set of real weeks in which the same entries run, and a row over
several lessons is posted once per week its members tell apart
(app/solver/weeks.py). This measures what that adds, on the benchmark schools,
beside the same week with no periods — which is the week main builds, byte for
byte (benchmarks/model_identity.py).

    python benchmarks/periods.py                              # högstadium, 2, 4 and 8 periods
    python benchmarks/periods.py --school bench --students 2000
    python benchmarks/periods.py --general                    # a classroom subject is dated too
    python benchmarks/periods.py --solve --budget 60          # the whole of solve(), validated
    python benchmarks/periods.py --periods 2 --swap           # högstadium: slöjd and hemkunskap by term

HOW A WEEK IS CUT, so that it stays the week it was:

    clone   (the default) every chosen requirement becomes N, one per period,
            alike in everything but the period it runs in. Each period's week
            then holds exactly the lessons the uncut week held — the same
            load on every teacher, class and room, in every real week — so
            what is measured is the cut and nothing else. The copies are
            placed independently: a class's bild may sit on Monday in one
            period and on Thursday in the next.
    swap    högstadium with two periods only: half the classes have slöjd
            2 × 90 in the first term and hemkunskap 2 × 60 in the second, the
            other half the other way round, as --ab-weeks does it with odd and
            even weeks. Every real week holds the loads the weekly week held.

WHICH REQUIREMENTS: the subjects with a room of their own that a school reads
by term — bild, musik, slöjd and hemkunskap in the högstadium, the laboratory
subject in the bench school. --general adds a subject of the ordinary
classrooms (teknik; subject 5), which makes the classrooms' pool hold lessons
of every week beside lessons of each period: the case that names its rooms
(app/solver/room_allocator.py), and the dear one.

WHAT IS MEASURED, per variant:

    weeks        the distinct weeks the request is cut into
    variables, constraints
                 of the satisfaction model (phase 1a) and of the full model
    named        room classes that name their rooms, and the literals that costs
    build        seconds to build the satisfaction model
    first        seconds to a first timetable in it, on --workers workers
    solve        with --solve: status and seconds of solve() under --budget
                 (on the engine's own worker count, as a deployment runs it),
                 and what validate_schedule.py finds in the timetable

The variants are measured AT THE SAME TIME, one process each, so a loaded
machine slows them alike and their ratios still mean something.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver, _weeks_and_requests  # noqa: E402

_NS = uuid.UUID("0c1f1e6a-7c0b-4c53-9d7e-5b1f7a2d9e44")
#: The room types whose subjects a högstadium reads by term.
TERM_ROOMS = {"ART", "MUSIC", "WORKSHOP", "KITCHEN"}


def _uid(label: str) -> str:
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def _school(args: argparse.Namespace) -> tuple[dict[str, object], set[str]]:
    """The uncut week as a payload, and the ids of the requirements to cut."""
    if args.school == "hogstadium":
        import hogstadium

        request = hogstadium.build_request()
        general = {hogstadium._uid("subject-TK")}
        chosen = {
            str(r.id) for r in request.requirements
            if r.block_id is None and (
                r.required_room_type in TERM_ROOMS
                or (args.general and str(r.subject_id) in general)
            )
        }
    else:
        import solve_2000_students as bench

        request = bench.build_request(bench.SchoolShape(
            students=args.students, constraint_density=args.constraint_density,
        ))
        subjects = {bench._uid("subject-3")} | ({bench._uid("subject-5")} if args.general else set())
        chosen = {str(r.id) for r in request.requirements if str(r.subject_id) in subjects}
    return request.model_dump(by_alias=True, exclude_none=True, mode="json"), chosen


def clone(payload: dict[str, object], chosen: set[str], periods: int) -> dict[str, object]:
    """Every chosen requirement once per period (the module docstring)."""
    requirements: list[dict[str, object]] = []
    for row in payload["requirements"]:  # type: ignore[union-attr]
        if row["id"] not in chosen:
            requirements.append(row)
            continue
        for period in range(periods):
            requirements.append({
                **row,
                "id": row["id"] if period == 0 else _uid(f"{row['id']}-period-{period}"),
                "periods": [index == period for index in range(periods)],
            })
    return {**payload, "requirements": requirements}


def swap(payload: dict[str, object]) -> dict[str, object]:
    """Högstadium: slöjd and hemkunskap by term, twice the lessons in half the year."""
    import hogstadium

    slojd, hemkunskap = hogstadium._uid("subject-SL"), hogstadium._uid("subject-HKK")
    order: dict[str, int] = {}
    requirements = []
    for row in payload["requirements"]:  # type: ignore[union-attr]
        if row["subjectId"] in (slojd, hemkunskap):
            index = order.setdefault(row["studentGroupId"], len(order))
            first = (row["subjectId"] == slojd) == (index % 6 < 3)
            row = {
                **row, "lessonsPerWeek": 2 * row["lessonsPerWeek"],
                "periods": [first, not first],
            }
        requirements.append(row)
    return {**payload, "requirements": requirements}


def measure(payload: dict[str, object], *, budget: float, workers: int, solve: bool) -> dict[str, object]:
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]
    out: dict[str, object] = {
        "requirements": len(request.requirements),
        "lessons": sum(r.lessons_per_week for r in request.requirements),
        "dated": sum(1 for r in request.requirements if r.periods is not None),
        "weeks": len(_weeks_and_requests(request)),
        "load": os.getloadavg()[0],
    }
    started = time.perf_counter()
    solver._validate_request(request)
    out["validateSeconds"] = round(time.perf_counter() - started, 2)
    full, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    started = time.perf_counter()
    model, _, _, plan, _ = solver._build_model(request, use_assumptions=False, include_objective=False)
    out["buildSeconds"] = round(time.perf_counter() - started, 2)
    out["variables"] = len(model.Proto().variables)
    out["constraints"] = len(model.Proto().constraints)
    out["fullVariables"] = len(full.Proto().variables)
    out["fullConstraints"] = len(full.Proto().constraints)
    out["estimatedVariables"] = solver._estimate_model_size(request)
    out["namedClasses"] = len(plan.named)
    out["namedLiterals"] = sum(len(rooms) for rooms in plan.rooms_of.values())
    out["classesPerPart"] = len(plan.by_week)
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = budget
    cp.parameters.num_workers = workers
    cp.parameters.stop_after_first_solution = True
    out["firstStatus"] = cp.StatusName(cp.Solve(model))
    out["firstSeconds"] = round(cp.WallTime(), 2)
    if solve:
        from validate_schedule import validate

        started = time.perf_counter()
        response = solver.solve(request)
        out["solveSeconds"] = round(time.perf_counter() - started, 2)
        out["solveStatus"] = response.status
        out["placed"] = len(response.lessons)
        problems = validate(solver._grid, request, response.lessons) if response.lessons else []
        out["problems"] = len(problems)
        out["firstProblems"] = problems[:3]
        out["conflictCodes"] = sorted({
            detail.code for detail in (response.conflicts.conflicts if response.conflicts else [])
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--school", choices=("hogstadium", "bench"), default="hogstadium")
    parser.add_argument("--students", type=int, default=2000)
    parser.add_argument("--constraint-density", type=float, default=1.0)
    parser.add_argument("--periods", type=int, nargs="+", default=[2, 4, 8])
    parser.add_argument("--general", action="store_true", help="date a classroom subject too")
    parser.add_argument("--swap", action="store_true", help="högstadium, two periods: slöjd/hemkunskap by term")
    parser.add_argument("--solve", action="store_true", help="run solve() too, and validate its timetable")
    parser.add_argument("--budget", type=float, default=60.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--one", type=int, default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.one is not None:
        payload, chosen = _school(args)
        if args.one:
            payload = swap(payload) if args.swap else clone(payload, chosen, args.one)
        print(json.dumps(measure(payload, budget=args.budget, workers=args.workers, solve=args.solve)))
        return 0

    # One process per variant, all at once: the same machine, the same minutes.
    variants = [0, *([2] if args.swap else args.periods)]
    own = [name for name in sys.argv[1:]]
    running = {
        periods: subprocess.Popen(
            [sys.executable, __file__, *own, "--one", str(periods)],
            stdout=subprocess.PIPE, text=True,
        )
        for periods in variants
    }
    results: dict[int, dict[str, object]] = {}
    for periods, process in running.items():
        stdout, _ = process.communicate()
        if process.returncode != 0:
            print(f"periods={periods}: exit {process.returncode}", file=sys.stderr)
            return 1
        results[periods] = json.loads(stdout.strip().splitlines()[-1])
    if args.json:
        print(json.dumps({str(periods): row for periods, row in results.items()}, indent=1))
        return 0
    keys = [key for key in results[0] if key not in ("firstProblems", "conflictCodes")]
    width = max(len(key) for key in keys)
    print(f"{'':{width}}  " + "  ".join(f"{('uncut' if p == 0 else f'{p} periods'):>12}" for p in variants))
    for key in keys:
        print(f"{key:{width}}  " + "  ".join(f"{str(results[p].get(key, '')):>12}" for p in variants))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
