#!/usr/bin/env python3
"""A högstadium test school: 450 pupils, språkval and elevens val in blocks.

The bench school (solve_2000_students.py) has home classes and nothing else:
every pupil follows every lesson of their class. A Swedish högstadium does not
look like that. Each year has its språkval (moderna språk, or extra svenska and
engelska) and its elevens val, read in teaching groups cut across the classes
of the year, and the school runs each of them as a block: Spanska, Tyska and
Franska for åk 7 at the same times, so the block takes one slot of 7A's week
per lesson and not one per language. This is the week the later generator
phases measure on.

    python benchmarks/hogstadium.py                 # solve with the blocks, validate
    python benchmarks/hogstadium.py --without-blocks
    python benchmarks/hogstadium.py --budget 90 --json
    python benchmarks/hogstadium.py --first-solution  # time to a first timetable

THE SHAPE. Three years (7–9) of six classes of 25 pupils. Per class and week,
in lessons of 60 minutes unless named: matematik 3, svenska 3, engelska 2,
NO 3 (laboratory), SO 3, idrott 2 (sports hall), bild 1 (art room), musik 1
(music room), slöjd 1 × 90 (workshop), hem- och konsumentkunskap 1 (kitchen)
and teknik 1. Per year two blocks of five teaching groups of 30:
  Språkval åk N   Spanska A, Spanska B, Tyska, Franska and Svenska/engelska,
                  2 × 60 a week, each with its own teacher.
  Elevens val åk N  Idrott, Bild, Musik, Matematik and Programmering, 1 × 60,
                  taught by teachers who also teach classes.
A pupil is in one språkval group and one elevens val group, drawn so that
every group holds pupils of every class of its year. The groups that share a
pupil are sent as groupConflicts, as the gateway derives them from rosters.

The school is deterministic (fixed ids, no randomness), so a difference
between two runs is the machine's or the solver's, never the input's.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

_NS = uuid.UUID("0b2c7a52-6f1e-4c3a-9d55-7e1f4a8c2b90")

YEARS = (7, 8, 9)
CLASSES_PER_YEAR = 6
PUPILS_PER_CLASS = 25
GROUP_SIZE = 30

#: (code, lessons per week, minutes, required room type, teachers in the pool)
CLASS_SUBJECTS = (
    ("MA", 3, 60, None, 3),
    ("SV", 3, 60, None, 3),
    ("EN", 2, 60, None, 2),
    ("NO", 3, 60, "LABORATORY", 3),
    ("SO", 3, 60, None, 3),
    ("IDH", 2, 60, "GYMNASIUM", 2),
    ("BL", 1, 60, "ART", 1),
    ("MU", 1, 60, "MUSIC", 1),
    ("SL", 1, 90, "WORKSHOP", 1),
    ("HKK", 1, 60, "KITCHEN", 1),
    ("TK", 1, 60, None, 1),
)
#: Språkval: (group, the teacher who teaches it in every year).
SPRAKVAL = (
    ("Spanska A", "teacher-SPA-0"),
    ("Spanska B", "teacher-SPA-1"),
    ("Tyska", "teacher-TY-0"),
    ("Franska", "teacher-FR-0"),
    ("Svenska/engelska", "teacher-SVEN-0"),
)
#: Elevens val: (group, required room type, the teacher by year). Teachers who
#: also teach classes, so the block competes with the rest of their week.
ELEVENS_VAL = (
    ("Idrott", "GYMNASIUM", "IDH"),
    ("Bild", "ART", "BL"),
    ("Musik", "MUSIC", "MU"),
    ("Matematik", None, "MA"),
    ("Programmering", None, "TK"),
)
POOL = {code: pool for code, *_, pool in CLASS_SUBJECTS}
ROOMS = (
    ("CLASSROOM", 22),
    ("LABORATORY", 3),
    ("GYMNASIUM", 2),
    ("ART", 1),
    ("MUSIC", 1),
    ("WORKSHOP", 2),
    ("KITCHEN", 1),
)


def _uid(label: str) -> str:
    """A deterministic version-4 UUID for `label` (see solve_2000_students._uid)."""
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def build_request(*, blocks: bool = True) -> OptimizeScheduleRequest:
    """The school's week; `blocks=False` sends the same rows with no blockId."""
    requirements: list[dict[str, object]] = []
    group_ids: dict[str, str] = {}
    memberships: list[set[str]] = []

    for year in YEARS:
        classes = [f"{year}{chr(ord('A') + index)}" for index in range(CLASSES_PER_YEAR)]
        for class_index, name in enumerate(classes):
            group_ids[name] = _uid(f"group-{name}")
            for code, lessons, minutes, room_type, pool in CLASS_SUBJECTS:
                teacher = f"teacher-{code}-{(class_index + year) % pool}"
                row: dict[str, object] = {
                    "id": _uid(f"req-{name}-{code}"),
                    "subjectId": _uid(f"subject-{code}"),
                    "studentGroupId": group_ids[name],
                    "teacherId": _uid(teacher),
                    "lessonsPerWeek": lessons,
                    "minutesPerLesson": minutes,
                    "studentGroupSize": PUPILS_PER_CLASS,
                    "minGradeLevel": year,
                    "maxGradeLevel": year,
                }
                if room_type is not None:
                    row["requiredRoomType"] = room_type
                requirements.append(row)

        pupils = CLASSES_PER_YEAR * PUPILS_PER_CLASS
        for language, teacher in SPRAKVAL:
            name = f"{language} {year}"
            group_ids[name] = _uid(f"group-{name}")
            requirements.append({
                "id": _uid(f"req-{name}"),
                "subjectId": _uid(f"subject-M2-{language}"),
                "studentGroupId": group_ids[name],
                "teacherId": _uid(teacher),
                "lessonsPerWeek": 2,
                "minutesPerLesson": 60,
                "studentGroupSize": GROUP_SIZE,
                "minGradeLevel": year,
                "maxGradeLevel": year,
                **({"blockId": _uid(f"block-sprakval-{year}")} if blocks else {}),
            })
        for choice, room_type, code in ELEVENS_VAL:
            name = f"Elevens val {choice} {year}"
            group_ids[name] = _uid(f"group-{name}")
            row = {
                "id": _uid(f"req-{name}"),
                "subjectId": _uid(f"subject-EV-{choice}"),
                "studentGroupId": group_ids[name],
                # The pool's last teacher, whom the classes of this year load
                # least: a block of five is five people free at one hour.
                "teacherId": _uid(f"teacher-{code}-{(year + 1) % POOL[code]}"),
                "lessonsPerWeek": 1,
                "minutesPerLesson": 60,
                "studentGroupSize": GROUP_SIZE,
                "minGradeLevel": year,
                "maxGradeLevel": year,
                **({"blockId": _uid(f"block-elevensval-{year}")} if blocks else {}),
            }
            if room_type is not None:
                row["requiredRoomType"] = room_type
            requirements.append(row)

        # Who reads what: pupil p of the year (0..149) sits in class p // 25,
        # språkval group p % 5 and elevens val group (p + p // 25) % 5, so every
        # group draws from every class and the two choices are independent.
        for pupil in range(pupils):
            memberships.append({
                group_ids[classes[pupil // PUPILS_PER_CLASS]],
                group_ids[f"{SPRAKVAL[pupil % 5][0]} {year}"],
                group_ids[f"Elevens val {ELEVENS_VAL[(pupil + pupil // PUPILS_PER_CLASS) % 5][0]} {year}"],
            })

    conflicts = sorted({
        tuple(sorted(pair)) for groups in memberships for pair in combinations(groups, 2)
    })

    rooms = [
        {"id": _uid(f"room-{kind}-{index}"), "capacity": 32, "type": kind}
        for kind, count in ROOMS
        for index in range(count)
    ]
    groups = [
        {
            "id": group_ids[f"{year}{chr(ord('A') + index)}"],
            "lunchHeadcount": PUPILS_PER_CLASS,
            "minGradeLevel": year,
            "maxGradeLevel": year,
        }
        for year in YEARS
        for index in range(CLASSES_PER_YEAR)
    ]
    # One planning afternoon a week for every teacher of a class subject.
    teachers = sorted({
        f"teacher-{code}-{index}" for code, *_, pool in CLASS_SUBJECTS for index in range(pool)
    })
    constraints = [
        {
            "id": _uid(f"constraint-{teacher}"),
            "resourceKind": "TEACHER",
            "resourceId": _uid(teacher),
            "dayOfWeek": (index % 5) + 1,
            "startTime": "14:00:00",
            "endTime": "16:00:00",
            "kind": "UNAVAILABLE",
        }
        for index, teacher in enumerate(teachers)
    ]
    frames = [
        {
            "minGradeLevel": 7,
            "maxGradeLevel": 9,
            "dayOfWeek": day,
            "startTime": "08:00:00",
            "endTime": "16:00:00",
        }
        for day in range(1, 6)
    ]
    return OptimizeScheduleRequest.model_validate({
        "requestId": _uid("request"),
        "academicYearId": _uid("year"),
        "requirements": requirements,
        "groups": groups,
        "rooms": rooms,
        "constraints": constraints,
        "frameTimes": frames,
        "groupConflicts": [list(pair) for pair in conflicts],
        "rules": {
            "lunchStartTime": "11:00:00",
            "lunchEndTime": "13:00:00",
            "lunchMinutes": 30,
            "maxLessonsPerDayPerGroup": 7,
        },
    })


def run(*, blocks: bool, budget: float) -> dict[str, object]:
    from validate_schedule import validate

    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget)  # type: ignore[call-arg]
    solver = SchedulerSolver(settings)
    request = build_request(blocks=blocks)
    started = time.perf_counter()
    response = solver.solve(request)
    elapsed = time.perf_counter() - started
    problems = validate(solver._grid, request, response.lessons) if response.lessons else []

    # What the block is for: how many slots of 7A's week its språkval takes.
    # Five groups of two lessons each: two slots as a block, up to ten apart.
    sprakval = {uuid.UUID(_uid(f"req-{language} 7")) for language, _teacher in SPRAKVAL}
    slots = {
        (lesson.day_of_week, lesson.start_time)
        for lesson in response.lessons
        if lesson.requirement_id in sprakval
    }
    return {
        "blocks": blocks,
        "status": response.status,
        "lessons": len(response.lessons),
        "requested": sum(r.lessons_per_week for r in request.requirements),
        "requirements": len(request.requirements),
        "groupConflicts": len(request.group_conflicts),
        "estimatedVariables": solver._estimate_model_size(request),
        "sprakvalSlotsOfYear7": len(slots),
        "problems": len(problems),
        "firstProblems": problems[:5],
        "elapsedSeconds": round(elapsed, 2),
        "budgetSeconds": budget,
    }


def first_solution(*, blocks: bool, budget: float) -> dict[str, object]:
    """Seconds to a first timetable in the satisfaction model, as phase 1a builds it.

    What a block costs or saves the search, without phase 2's improving: the
    full solve spends whatever budget it is given, so its wall clock says how
    long the budget was, not how hard the week is.
    """
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]
    request = build_request(blocks=blocks)
    solver._validate_request(request)
    started = time.perf_counter()
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
    built = time.perf_counter() - started
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = budget
    cp.parameters.stop_after_first_solution = True
    status = cp.StatusName(cp.Solve(model))
    return {
        "blocks": blocks,
        "status": status,
        "buildSeconds": round(built, 2),
        "firstSolutionSeconds": round(cp.WallTime(), 2),
        "budgetSeconds": budget,
        "variables": len(model.Proto().variables),
        "constraints": len(model.Proto().constraints),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--without-blocks", action="store_true",
                        help="send the same rows with no blockId")
    parser.add_argument("--first-solution", action="store_true",
                        help="time the satisfaction model to its first timetable only")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.first_solution:
        found = first_solution(blocks=not args.without_blocks, budget=args.budget)
        print(json.dumps(found, indent=None if not args.json else 2))
        return 0 if found["status"] in {"FEASIBLE", "OPTIMAL"} else 1
    result = run(blocks=not args.without_blocks, budget=args.budget)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        verdict = "VALID" if not result["problems"] else f"INVALID ({result['problems']})"
        print(
            f"högstadium, {'with' if result['blocks'] else 'without'} blocks: "
            f"{result['status']}, {result['lessons']}/{result['requested']} lessons in "
            f"{result['elapsedSeconds']} s (budget {result['budgetSeconds']} s), språkval "
            f"åk 7 in {result['sprakvalSlotsOfYear7']} slots, {verdict}"
        )
        for problem in result["firstProblems"]:
            print(f"  - {problem}")
    return 0 if result["lessons"] and not result["problems"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
