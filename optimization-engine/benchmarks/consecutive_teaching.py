#!/usr/bin/env python3
"""Sammanhängande undervisning: what the rule costs, measured against main's model.

Two arms are solved side by side in two processes started together, so the
shared machine loads both alike (a paired A/B: one after the other on a loaded
Mac measures the load, not the rule). The `off` arm is the school as it is and
the others flag the busiest teachers with a rule:

    A   at most 180 minutes in a row, then 30 free (the start step is unchanged)
    B   at most 180 minutes in a row, then 15 free (the step goes from 30 to 15)

    python benchmarks/consecutive_teaching.py --mode first --arms off,A
    python benchmarks/consecutive_teaching.py --mode full --arms off,B --budget 90
    python benchmarks/consecutive_teaching.py --mode gate --arms off,A --budget 90
    python benchmarks/consecutive_teaching.py --mode infeasible

The schools: `hogstadium` (450 pupils, 26 teachers, 423 lessons) and `bench`
(the nightly gate's 400 pupils, validate_schedule.py --students 400).

THE RULE HAS TO BIND, or the pair measures nothing. Every arm counts the
flagged teachers whose timetable has a stretch longer than the rule in a
timetable it makes (`breaching`): in the `off` arm that is how many teachers
the rule has to move, and in an arm with the rule on it must be zero.

    first   the satisfaction model solved to its first timetable (stop after
            first solution), as phase 1a does, and the full model built beside it
    full    solve() end to end on the budget, then validate_schedule.validate
    gate    the nightly gate: solve() on the bench school with a budget, then
            validate, as quality-gates.yml runs it
    infeasible  a flagged teacher whose week the rule makes impossible; must
            answer INFEASIBLE and name the rule, quickly
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
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

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver, _lesson_teachers  # noqa: E402

_NS = uuid.UUID("5c2d2f0a-3f6b-4d2e-8d6a-0a8c1b9d7e44")

#: (max minutes in a row, minutes free)
ARMS: dict[str, tuple[int, int] | None] = {"off": None, "A": (180, 30), "B": (180, 15)}
FLAGGED = 8


def _uid(label: str) -> str:
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def school(name: str) -> OptimizeScheduleRequest:
    if name == "hogstadium":
        import hogstadium

        return hogstadium.build_request(blocks=True)
    from solve_2000_students import SchoolShape, build_request

    return build_request(SchoolShape(students=400, constraint_density=1.0))


def busiest(request: OptimizeScheduleRequest, count: int) -> list[str]:
    """The teachers with the most minutes a week, lead or co-teacher, most first."""
    load: dict[str, int] = defaultdict(int)
    for requirement in request.requirements:
        minutes = sum(requirement.lesson_minutes())
        for teacher in {requirement.teacher_id, requirement.co_teacher_id} - {None}:
            load[str(teacher)] += minutes * requirement.lessons_per_week // max(
                1, len(requirement.lesson_minutes()),
            )
    return [teacher for teacher, _ in sorted(load.items(), key=lambda item: (-item[1], item[0]))][:count]


def flagged(request: OptimizeScheduleRequest, arm: str, count: int = FLAGGED) -> OptimizeScheduleRequest:
    """The request with the arm's rule on the busiest teachers; the request itself for `off`."""
    rule = ARMS[arm]
    if rule is None:
        return request
    payload = request.model_dump(by_alias=True, mode="json")
    payload["teacherWorkRules"] = [
        *payload.get("teacherWorkRules", []),
        *(
            {
                "id": _uid(f"stretch-rule-{teacher}"),
                "teacherId": teacher,
                "maxConsecutiveTeachingMinutes": rule[0],
                "consecutiveBreakMinutes": rule[1],
            }
            for teacher in busiest(request, count)
        ),
    ]
    return OptimizeScheduleRequest.model_validate(payload)


def breaching(
    request: OptimizeScheduleRequest, spans: dict[tuple[str, int], list[tuple[int, int]]],
    rule: tuple[int, int],
) -> int:
    """Teachers (of the busiest) with a stretch over the rule somewhere in `spans`."""
    limit, pause = rule
    count = 0
    for teacher in busiest(request, FLAGGED):
        over = False
        for (who, _day), windows in spans.items():
            if who != teacher:
                continue
            stretch = None
            for start, end in sorted(windows):
                if stretch is not None and start - stretch[1] < pause:
                    stretch[1] = max(stretch[1], end)
                else:
                    if stretch is not None and stretch[1] - stretch[0] > limit:
                        over = True
                    stretch = [start, end]
            if stretch is not None and stretch[1] - stretch[0] > limit:
                over = True
        count += over
    return count


def spans_of_solution(
    solver: SchedulerSolver, decisions, cp: cp_model.CpSolver,
) -> dict[tuple[str, int], list[tuple[int, int]]]:
    grid = solver._grid
    spans: dict[tuple[str, int], list[tuple[int, int]]] = defaultdict(list)
    for decision in decisions:
        value = cp.Value(decision.start)
        day = value // grid.slots_per_day
        start = grid.day_start_minutes + (value % grid.slots_per_day) * grid.slot_minutes
        end = start + decision.duration * grid.slot_minutes
        for teacher in set(_lesson_teachers(decision.lesson)):
            spans[(str(teacher), day)].append((start, end))
    return spans


def spans_of_lessons(request: OptimizeScheduleRequest, lessons) -> dict[tuple[str, int], list[tuple[int, int]]]:
    by_requirement = {requirement.id: requirement for requirement in request.requirements}

    def minutes(value: str) -> int:
        hours, mins, *_ = (int(part) for part in value.split(":"))
        return hours * 60 + mins

    spans: dict[tuple[str, int], list[tuple[int, int]]] = defaultdict(list)
    for lesson in lessons:
        requirement = by_requirement[lesson.requirement_id]
        lead = lesson.teacher_id or requirement.teacher_id
        for teacher in {lead, requirement.co_teacher_id} - {None}:
            spans[(str(teacher), lesson.day_of_week)].append(
                (minutes(lesson.start_time), minutes(lesson.end_time)),
            )
    return spans


def _load() -> float:
    return round(os.getloadavg()[0], 1)


def measure(args: tuple[str, str, str, float]) -> dict[str, object]:
    name, mode, arm, budget = args
    rule = ARMS[arm]
    request = flagged(school(name), arm)
    base = school(name)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]
    # The count is always against the arm's own rule; `off` is counted against A
    # so the pair says how many teachers a rule has to move.
    counted = rule or ARMS["A"]
    result: dict[str, object] = {
        "school": name, "mode": mode, "arm": arm, "rule": rule, "load": [_load()],
    }
    if mode == "first":
        solver._validate_request(request)
        started = time.perf_counter()
        full, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
        result["fullBuildSeconds"] = round(time.perf_counter() - started, 2)
        started = time.perf_counter()
        model, _registry, decisions, *_ = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        result["feasibleBuildSeconds"] = round(time.perf_counter() - started, 2)
        cp = cp_model.CpSolver()
        cp.parameters.max_time_in_seconds = budget
        cp.parameters.stop_after_first_solution = True
        status = cp.StatusName(cp.Solve(model))
        result.update({
            "status": status,
            "firstSolutionSeconds": round(cp.WallTime(), 2),
            "variables": len(model.Proto().variables),
            "constraints": len(model.Proto().constraints),
            "fullVariables": len(full.Proto().variables),
            "fullConstraints": len(full.Proto().constraints),
            "estimate": solver._estimate_model_size(request),
        })
        if status in {"FEASIBLE", "OPTIMAL"}:
            result["breaching"] = breaching(base, spans_of_solution(solver, decisions, cp), counted)
    else:
        from validate_schedule import validate

        started = time.perf_counter()
        response = solver.solve(request)
        elapsed = time.perf_counter() - started
        problems = validate(solver._grid, request, response.lessons) if response.lessons else []
        result.update({
            "status": response.status,
            "lessons": len(response.lessons),
            "requested": sum(r.lessons_per_week for r in request.requirements),
            "solveSeconds": round(elapsed, 2),
            "problems": len(problems),
            "firstProblems": problems[:3],
            "conflictCodes": sorted({
                detail.code for detail in (response.conflicts.conflicts if response.conflicts else [])
            }),
        })
        if response.lessons:
            result["breaching"] = breaching(base, spans_of_lessons(request, response.lessons), counted)
    result["load"].append(_load())  # type: ignore[union-attr]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--school", choices=["hogstadium", "bench"], default=None)
    parser.add_argument("--mode", choices=["first", "full", "gate"], default="first")
    parser.add_argument("--arms", default="off,A")
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--rounds", type=int, default=1)
    args = parser.parse_args()
    name = args.school or ("bench" if args.mode == "gate" else "hogstadium")
    arms = args.arms.split(",")
    for _ in range(args.rounds):
        with multiprocessing.get_context("spawn").Pool(len(arms)) as pool:
            for result in pool.map(measure, [(name, args.mode, arm, args.budget) for arm in arms]):
                print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
