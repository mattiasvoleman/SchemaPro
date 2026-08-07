#!/usr/bin/env python3
"""Where does the scheduling model spend its time, and what makes it unsolvable?

``solve_2000_students.py`` answers "does the engine meet the §2 budget" with a
single number. When that number is bad, this script answers "why".

It reuses that benchmark's school generator, so both operate on exactly the
same synthetic school, and it lifts ``MAX_MODEL_COMPLEXITY`` /
``MAX_LESSON_INSTANCES`` so the model can be measured at sizes the production
guard rejects. **That makes this a diagnostic, not a conformance check** — it
deliberately runs payloads the service would refuse.

Three modes:

    --breakdown   per-builder wall clock, variables and constraints added
    --ablate      add constraint groups cumulatively; find which one blocks
    --matrix      the rules x objective 2x2 at a fixed size

Examples::

    python benchmarks/profile_model.py --breakdown --students 2000
    python benchmarks/profile_model.py --ablate --students 250 --budget 10
    python benchmarks/profile_model.py --matrix --students 250 --budget 10

Build time is reported separately from solve time throughout, because the
CP-SAT time limit bounds only ``Solve()``. Model construction runs first and is
unbounded, so a large enough school can exceed a wall-clock budget before the
search is ever entered.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "profile-key-00000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from app.config import Settings  # noqa: E402
from app.solver.conflict_analyzer import AssumptionRegistry  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402

from solve_2000_students import SchoolShape, build_request  # noqa: E402

# Diagnostic only — see the module docstring.
SchedulerSolver.MAX_MODEL_COMPLEXITY = 10**12
SchedulerSolver.MAX_LESSON_INSTANCES = 10**9

_SETTINGS = Settings(
    API_KEY="profile-key-00000000000000000000000",
    ALLOWED_ORIGINS="http://localhost",
    SOLVER_MAX_TIME_SECONDS=1.0,
)

# Cumulative order matches SchedulerSolver.solve().
GROUPS = ("capacity", "teacher", "group", "room", "availability", "rules", "objective")


def _assemble(shape, enabled, model, solver, request, timings=None):
    """Build the model with only `enabled` groups. Returns the decision list."""
    rooms = request.rooms
    registry = AssumptionRegistry()

    def step(name, fn):
        if name not in enabled and name != "decisions":
            return None
        if timings is None:
            return fn()
        proto = model.Proto()
        v0, c0 = len(proto.variables), len(proto.constraints)
        t0 = time.perf_counter()
        out = fn()
        dt = time.perf_counter() - t0
        proto = model.Proto()
        timings.append({
            "step": name,
            "seconds": round(dt, 3),
            "varsAdded": len(proto.variables) - v0,
            "consAdded": len(proto.constraints) - c0,
        })
        return out

    decisions = step(
        "decisions",
        lambda: solver._create_lesson_decisions(model, request.requirements, len(rooms)),
    )
    step("capacity", lambda: solver._add_capacity_constraints(model, registry, decisions, rooms))
    step("teacher", lambda: solver._add_teacher_no_overlap(model, decisions))
    step("group", lambda: solver._add_group_no_overlap(model, decisions))
    step("room", lambda: solver._add_room_allocation(
        model, decisions, rooms, request.constraints, request.fixed_lessons))
    step("availability", lambda: solver._add_availability_constraints(
        model, registry, decisions, rooms, request.constraints))
    step("fixed", lambda: solver._add_fixed_lesson_constraints(
        model, decisions, rooms, request.fixed_lessons))

    weights = solver._resolve_weights(request)
    day_vars: dict = {}
    step("rules", lambda: solver._add_rules_constraints(
        model, decisions, request.rules, day_vars))

    def objective():
        terms = [
            *solver._add_preference_objective(
                model, decisions, rooms, request.constraints, weights),
            *solver._add_disruption_objective(
                model, decisions, request.previous_lessons, weights),
            *solver._add_spread_objective(model, decisions, weights, day_vars),
            *solver._add_teacher_gap_objective(model, decisions, weights, day_vars),
        ]
        model.Minimize(sum(terms) if terms else 0)

    step("objective", objective)
    return decisions


def _solve(solver, model, decisions, rooms, budget, build_s, workers):
    cp = cp_model.CpSolver()
    # Whatever is left of the wall-clock budget after construction.
    cp.parameters.max_time_in_seconds = max(0.2, budget - build_s)
    if workers:
        cp.parameters.num_workers = workers
    t0 = time.perf_counter()
    code = cp.Solve(model)
    solve_s = time.perf_counter() - t0
    # Every decision carries a start, so a solved model places all of them.
    # Counting decisions avoids _extract_lessons, which now needs the room plan
    # that the ablation deliberately omits in some configurations.
    scheduled = len(decisions) if code in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0
    return solver._map_status(code), solve_s, scheduled


def _fresh(students):
    shape = SchoolShape(students=students, constraint_density=1.0)
    request = build_request(shape)
    return (
        shape,
        request,
        SchedulerSolver(_SETTINGS),
        cp_model.CpModel(),
        sum(r.lessons_per_week for r in request.requirements),
    )


def breakdown(args):
    shape, request, solver, model, need = _fresh(args.students)
    timings: list[dict] = []
    t0 = time.perf_counter()
    _assemble(shape, set(GROUPS), model, solver, request, timings)
    total = time.perf_counter() - t0
    for entry in timings:
        entry["pctOfBuild"] = round(100 * entry["seconds"] / total, 1) if total else 0.0
    timings.sort(key=lambda e: -e["seconds"])
    proto = model.Proto()
    out = {
        "students": shape.students,
        "lessonInstances": need,
        "rooms": shape.rooms,
        "buildSeconds": round(total, 3),
        "variables": len(proto.variables),
        "constraints": len(proto.constraints),
        "steps": timings,
    }
    if args.json:
        print(json.dumps(out, indent=2))
        return
    print(f"{shape.students} students / {need} lessons / {shape.rooms} rooms")
    print(f"build {total:.2f}s -> {len(proto.variables):,} vars, "
          f"{len(proto.constraints):,} constraints\n")
    print(f"  {'builder':<26} {'seconds':>8} {'share':>7} {'vars':>10} {'constraints':>12}")
    print("  " + "-" * 66)
    for e in timings:
        print(f"  {e['step']:<26} {e['seconds']:>7.2f}s {e['pctOfBuild']:>6.1f}% "
              f"{e['varsAdded']:>10,} {e['consAdded']:>12,}")


def ablate(args):
    print(f"{args.students} students, {args.budget}s budget, cumulative groups\n")
    print(f"  {'+ group':<24} {'vars':>9} {'build':>7} {'solve':>7}  {'status':<9} scheduled")
    print("  " + "-" * 72)
    for upto in range(len(GROUPS) + 1):
        shape, request, solver, model, need = _fresh(args.students)
        t0 = time.perf_counter()
        decisions = _assemble(shape, set(GROUPS[:upto]), model, solver, request)
        build_s = time.perf_counter() - t0
        status, solve_s, sched = _solve(
            solver, model, decisions, request.rooms, args.budget, build_s, args.workers)
        label = "(bare decisions)" if upto == 0 else f"+ {GROUPS[upto - 1]}"
        print(f"  {label:<24} {len(model.Proto().variables):>9,} {build_s:>6.2f}s "
              f"{solve_s:>6.2f}s  {status:<9} {sched}/{need}")


def matrix(args):
    print(f"{args.students} students, {args.budget}s budget, {args.workers or 'default'} workers\n")
    print(f"  {'rules':<7} {'objective':<10} {'vars':>9} {'build':>7} {'solve':>7}  "
          f"{'status':<9} scheduled")
    print("  " + "-" * 72)
    base = set(GROUPS) - {"rules", "objective"}
    for use_rules in (False, True):
        for use_obj in (False, True):
            shape, request, solver, model, need = _fresh(args.students)
            enabled = set(base)
            if use_rules:
                enabled.add("rules")
            if use_obj:
                enabled.add("objective")
            t0 = time.perf_counter()
            decisions = _assemble(shape, enabled, model, solver, request)
            build_s = time.perf_counter() - t0
            status, solve_s, sched = _solve(
                solver, model, decisions, request.rooms, args.budget, build_s, args.workers)
            print(f"  {str(use_rules):<7} {str(use_obj):<10} "
                  f"{len(model.Proto().variables):>9,} {build_s:>6.2f}s {solve_s:>6.2f}s  "
                  f"{status:<9} {sched}/{need}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--breakdown", action="store_true", help="per-builder cost")
    mode.add_argument("--ablate", action="store_true", help="cumulative constraint groups")
    mode.add_argument("--matrix", action="store_true", help="rules x objective 2x2")
    p.add_argument("--students", type=int, default=2000)
    p.add_argument("--budget", type=float, default=10.0, help="total wall-clock budget")
    p.add_argument("--workers", type=int, default=8, help="CP-SAT num_workers (0 = library default)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    if args.breakdown:
        breakdown(args)
    elif args.ablate:
        ablate(args)
    else:
        matrix(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
