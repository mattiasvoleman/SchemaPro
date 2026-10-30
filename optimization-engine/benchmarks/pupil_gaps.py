#!/usr/bin/env python3
"""Elevernas håltimmar: what turning the rule on costs and buys, measured.

Two schools, each solved with the rule off and on, the two side by side in two
processes at once so the shared machine loads both alike (a paired A/B; one
after the other on a loaded Mac measures the load, not the rule):

    högstadium    hogstadium.py's 450 pupils with språkval and elevens val,
                  with its blocks or --without-blocks (then the språkval and
                  elevens val hours are the generator's to put anywhere, and
                  the pupils' holes are the rule's to close)
    2000          solve_2000_students.py's 2,000 pupils in home classes only,
                  one cohort per class: the model's size at scale

For each run, the same three numbers whichever way it was solved:

    pupil-minutes   app/solver/pupil_gaps.pupil_idle_minutes, the
                    håltimmesrapport's number, on the cohorts the rule would
                    send (sent or not)
    teacher-minutes the same count for every teacher: holes of 15 minutes and
                    more between their first and last lesson, their own
                    UNAVAILABLE rows closed, the school's lunch credited
    time            the full model's build (made before phase 1 in solve(), so
                    it is on the way to the first timetable), the satisfaction
                    model's first solution as phase 1a solves it, and solve()
                    end to end at the budget

    python benchmarks/pupil_gaps.py --school hogstadium --budget 90
    python benchmarks/pupil_gaps.py --school hogstadium --without-blocks --budget 90
    python benchmarks/pupil_gaps.py --school 2000 --budget 90
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.pupil_gaps import (  # noqa: E402
    closed_minutes,
    day_idle_minutes,
    lunch_window,
    pupil_idle_minutes,
)
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402


def _minutes(value: str) -> int:
    hours, minutes, _ = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def school(name: str, *, blocks: bool, on: bool) -> OptimizeScheduleRequest:
    """The school's request with the rule on or off; the cohorts are the same either way."""
    if name == "hogstadium":
        import hogstadium

        return hogstadium.build_request(blocks=blocks, pupil_gaps=on)
    import solve_2000_students

    request = solve_2000_students.build_request(solve_2000_students.SchoolShape(students=2000))
    if not on:
        return request
    payload = request.model_dump(by_alias=True, mode="json")
    payload["pupilGaps"] = {"cohorts": [
        {"groupIds": [str(group.id)], "homeGroupId": str(group.id), "pupils": group.lunch_headcount}
        for group in request.groups
        if group.lunch_headcount > 0
    ]}
    return OptimizeScheduleRequest.model_validate(payload)


def teacher_idle_minutes(request: OptimizeScheduleRequest, lessons) -> int:
    """Every teacher's holes, by the count's own day rule (see the docstring)."""
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    days: dict[tuple[str, int], list[tuple[int, int]]] = defaultdict(list)
    for lesson in lessons:
        requirement = by_requirement[lesson.requirement_id]
        teacher = lesson.teacher_id or requirement.teacher_id
        for person in (teacher, requirement.co_teacher_id):
            if person is not None:
                days[(str(person), lesson.day_of_week)].append(
                    (_minutes(lesson.start_time), _minutes(lesson.end_time)),
                )
    lunch = lunch_window(request)
    total = 0
    for (teacher, day), intervals in days.items():
        closures = [
            (_minutes(rule.start_time), _minutes(rule.end_time))
            for rule in request.constraints
            if rule.resource_kind == "TEACHER" and str(rule.resource_id) == teacher
            and rule.kind == "UNAVAILABLE" and rule.date is None
            and rule.day_of_week in (None, day)
        ]
        total += day_idle_minutes(intervals, closures, lunch)
    return total


def measure(args: tuple[str, bool, str, float]) -> dict[str, object]:
    name, blocks, variant, budget = args
    on = variant == "on"
    request = school(name, blocks=blocks, on=on)
    counted = school(name, blocks=blocks, on=True)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]

    started = time.perf_counter()
    full, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    full_build = time.perf_counter() - started
    started = time.perf_counter()
    feasible, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
    feasible_build = time.perf_counter() - started
    first = cp_model.CpSolver()
    first.parameters.max_time_in_seconds = budget
    first.parameters.stop_after_first_solution = True
    first_status = first.StatusName(first.Solve(feasible))

    load_before = os.getloadavg()[0]
    started = time.perf_counter()
    response = solver.solve(request)
    elapsed = time.perf_counter() - started
    return {
        "school": name,
        "blocks": blocks,
        "rule": variant,
        "status": response.status,
        "lessons": len(response.lessons),
        "pupilMinutes": pupil_idle_minutes(counted, response.lessons) if response.lessons else None,
        "responsePupilMinutes": response.pupil_idle_minutes,
        "teacherMinutes": teacher_idle_minutes(request, response.lessons) if response.lessons else None,
        "cohorts": len(counted.pupil_gaps.cohorts) if counted.pupil_gaps else 0,
        "fullVariables": len(full.Proto().variables),
        "fullConstraints": len(full.Proto().constraints),
        "fullBuildSeconds": round(full_build, 2),
        "feasibleBuildSeconds": round(feasible_build, 2),
        "firstSolution": first_status,
        "firstSolutionSeconds": round(first.WallTime(), 2),
        "solveSeconds": round(elapsed, 2),
        "budgetSeconds": budget,
        "load": [round(load_before, 1), round(os.getloadavg()[0], 1)],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--school", choices=["hogstadium", "2000"], default="hogstadium")
    parser.add_argument("--without-blocks", action="store_true")
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument(
        "--variants", default="off,on",
        help="the arms solved side by side: off and on, in that order by default",
    )
    args = parser.parse_args()
    blocks = not args.without_blocks
    for _ in range(args.rounds):
        with multiprocessing.get_context("spawn").Pool(2) as pool:
            variants = args.variants.split(",")
            for result in pool.map(measure, [(args.school, blocks, variant, args.budget) for variant in variants]):
                print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
