#!/usr/bin/env python3
"""Solver wall-clock benchmark for a 2,000-student secondary school.

Engineering spec §2: "Schedule generation for 2,000 students under 10s".

The benchmark builds a synthetic but structurally realistic demand set and
times ``SchedulerSolver.solve`` end to end — model construction included,
because that is what a caller actually waits for. It calls the solver directly
rather than going over HTTP so the number measures the solver, not uvicorn.

    python benchmarks/solve_2000_students.py                # report only
    python benchmarks/solve_2000_students.py --assert-under 10
    python benchmarks/solve_2000_students.py --students 4000 --json

Exit code is 1 when ``--assert-under`` is given and the budget is exceeded, so
CI can gate on it directly.

The generated school is deterministic (fixed RNG seed and UUID namespace), so
run-to-run variation reflects machine and solver behaviour, never the input.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

# Allow running as a plain script from the package root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from app.config import Settings  # noqa: E402
from app.exceptions import InvalidScheduleInputError  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

# Fixed namespace → identical ids on every run and every machine.
_NS = uuid.UUID("6f9619ff-8b86-d011-b42d-00cf4fc964ff")


def _uid(label: str) -> str:
    """A deterministic *version-4* UUID for ``label``.

    The schema pins every id to UUID4, so a plain ``uuid5`` digest is rejected.
    Taking the uuid5 bits and restamping the version/variant nibbles keeps the
    determinism while producing ids the payload validator accepts.
    """
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


@dataclass(frozen=True)
class SchoolShape:
    """Structural parameters of the synthetic school."""

    students: int
    students_per_class: int = 25
    subjects_per_class: int = 12
    lessons_per_subject_per_week: int = 3
    minutes_per_lesson: int = 60
    # Swedish upper-secondary staffing is roughly one teacher per 12 students.
    students_per_teacher: int = 12
    # Rooms are the binding constraint in practice; keep them just above the
    # peak concurrent class count so the model is genuinely constrained.
    room_slack: float = 1.15
    # Share of teachers given a recurring weekly unavailability. 1.0 is the
    # realistic case (every teacher has a planning slot) but drives the model
    # past SchedulerSolver.MAX_MODEL_COMPLEXITY at 2,000 students; lower values
    # isolate raw solve time from that ceiling.
    constraint_density: float = 1.0

    @property
    def classes(self) -> int:
        return max(1, self.students // self.students_per_class)

    @property
    def teachers(self) -> int:
        return max(1, self.students // self.students_per_teacher)

    @property
    def rooms(self) -> int:
        return max(1, int(self.classes * self.room_slack))


def build_request(shape: SchoolShape) -> OptimizeScheduleRequest:
    """Build a full weekly demand payload for the given school shape."""
    room_types = ["CLASSROOM"] * 8 + ["LABORATORY", "GYMNASIUM", "WORKSHOP"]

    rooms = [
        {
            "id": _uid(f"room-{i}"),
            "capacity": shape.students_per_class + 5,
            "type": room_types[i % len(room_types)],
        }
        for i in range(shape.rooms)
    ]

    requirements = []
    for class_index in range(shape.classes):
        for subject_index in range(shape.subjects_per_class):
            # Spread teaching load round-robin so no teacher is over-committed
            # beyond what a real timetable would contain.
            teacher_index = (
                class_index * shape.subjects_per_class + subject_index
            ) % shape.teachers
            requirement = {
                "id": _uid(f"req-{class_index}-{subject_index}"),
                "subjectId": _uid(f"subject-{subject_index}"),
                "studentGroupId": _uid(f"group-{class_index}"),
                "teacherId": _uid(f"teacher-{teacher_index}"),
                "lessonsPerWeek": shape.lessons_per_subject_per_week,
                "minutesPerLesson": shape.minutes_per_lesson,
                "studentGroupSize": shape.students_per_class,
            }
            # Science and PE need specialist rooms — this is what makes room
            # assignment non-trivial rather than a free choice.
            if subject_index == 3:
                requirement["requiredRoomType"] = "LABORATORY"
            elif subject_index == 7:
                requirement["requiredRoomType"] = "GYMNASIUM"
            requirements.append(requirement)

    # Who is in the building: one home class per class, with its headcount,
    # which is the shape the gateway sends for a school that has entered its
    # classes. `_lunch_group_ids` takes a named list at its word, and only a
    # payload that names nobody falls back to every group with requirements,
    # as the schema says beside `groups`. For this school the two readings are
    # the same set — it has no teaching groups, so the classes that eat are
    # exactly the ones holding lessons — and naming them makes the nightly
    # gate exercise the reading production takes rather than the fallback,
    # which the engine's own tests hold.
    groups = [
        {
            "id": _uid(f"group-{class_index}"),
            "lunchHeadcount": shape.students_per_class,
        }
        for class_index in range(shape.classes)
    ]

    # Teachers are unavailable for one afternoon a week (meetings, planning).
    constrained_teachers = int(shape.teachers * shape.constraint_density)
    constraints = [
        {
            "id": _uid(f"constraint-{t}"),
            "resourceKind": "TEACHER",
            "resourceId": _uid(f"teacher-{t}"),
            "dayOfWeek": (t % 5) + 1,
            "startTime": "13:00:00",
            "endTime": "16:00:00",
            "kind": "UNAVAILABLE",
        }
        for t in range(constrained_teachers)
    ]

    return OptimizeScheduleRequest.model_validate(
        {
            "requestId": _uid("request"),
            "academicYearId": _uid("year"),
            "requirements": requirements,
            "groups": groups,
            "rooms": rooms,
            "constraints": constraints,
            "rules": {
                "lunchStartTime": "11:00:00",
                "lunchEndTime": "13:00:00",
                "lunchMinutes": 30,
                "maxLessonsPerDayPerGroup": 8,
            },
        }
    )


def run(shape: SchoolShape, solver_seconds: float) -> dict[str, object]:
    settings = Settings(
        API_KEY="benchmark-key-0000000000000000000000",
        ALLOWED_ORIGINS="http://localhost",
        SOLVER_MAX_TIME_SECONDS=solver_seconds,
    )

    request = build_request(shape)
    solver = SchedulerSolver(settings)

    total_lessons = sum(r.lessons_per_week for r in request.requirements)
    # The solver's own estimator, so a rejection is reported with the same
    # arithmetic that caused it — a private copy here would drift the first
    # time the model encoding changes, which is exactly how the previous
    # formula ended up rejecting schools the solver handled with ease.
    complexity = solver._estimate_model_size(request)

    shape_facts: dict[str, object] = {
        "students": shape.students,
        "classes": shape.classes,
        "teachers": shape.teachers,
        "rooms": shape.rooms,
        "requirements": len(request.requirements),
        "constraints": len(request.constraints),
        "lessonsRequested": total_lessons,
        "estimatedComplexity": complexity,
        "complexityBudget": SchedulerSolver.MAX_MODEL_COMPLEXITY,
    }

    started = time.perf_counter()
    try:
        response = solver.solve(request)
    except InvalidScheduleInputError as exc:
        # A refused payload is a failed benchmark, not an error to swallow: the
        # engine cannot schedule this school at any speed.
        return {
            **shape_facts,
            "status": "REJECTED",
            "rejectionReason": str(exc),
            "lessonsScheduled": 0,
            "elapsedSeconds": round(time.perf_counter() - started, 3),
        }
    elapsed = time.perf_counter() - started

    return {
        **shape_facts,
        "lessonsScheduled": len(response.lessons),
        "status": response.status,
        "elapsedSeconds": round(elapsed, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--students", type=int, default=2000)
    parser.add_argument(
        "--subjects",
        type=int,
        default=12,
        help="Subjects taught per class per week (default 12).",
    )
    parser.add_argument(
        "--constraint-density",
        type=float,
        default=1.0,
        metavar="FRACTION",
        help="Share of teachers given a weekly unavailability (default 1.0).",
    )
    parser.add_argument(
        "--assert-under",
        type=float,
        default=None,
        metavar="SECONDS",
        help="Exit non-zero when the solve exceeds this wall-clock budget.",
    )
    parser.add_argument(
        "--solver-seconds",
        type=float,
        default=9.0,
        help="CP-SAT time limit. Kept below the budget so the ceiling is the "
        "solver's own limit, not an unbounded search.",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON only.")
    args = parser.parse_args()

    result = run(
        SchoolShape(
            students=args.students,
            subjects_per_class=args.subjects,
            constraint_density=args.constraint_density,
        ),
        args.solver_seconds,
    )

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"{result['students']} students / {result['classes']} classes / "
            f"{result['requirements']} requirements / {result['rooms']} rooms / "
            f"{result['constraints']} constraints"
        )
        print(
            f"  status            {result['status']}\n"
            f"  lessons scheduled {result['lessonsScheduled']} "
            f"of {result['lessonsRequested']}\n"
            f"  model complexity  {result['estimatedComplexity']:,} "
            f"(budget {result['complexityBudget']:,})\n"
            f"  wall clock        {result['elapsedSeconds']}s"
        )
        if result["status"] == "REJECTED":
            print(f"  rejected          {result['rejectionReason']}")

    if args.assert_under is not None:
        if result["status"] == "REJECTED":
            print(
                "FAIL: the solver refused this school before solving — "
                f"{result['rejectionReason']} "
                f"(estimated complexity {result['estimatedComplexity']:,} vs "
                f"budget {result['complexityBudget']:,}).",
                file=sys.stderr,
            )
            return 1
        # An INFEASIBLE verdict returned quickly is not a passing benchmark —
        # it means the model was never actually solved at scale.
        if result["status"] == "INFEASIBLE":
            print(
                "FAIL: solver returned INFEASIBLE; the timing is meaningless.",
                file=sys.stderr,
            )
            return 1
        elapsed = float(result["elapsedSeconds"])
        if elapsed > args.assert_under:
            print(
                f"FAIL: {elapsed}s exceeds the {args.assert_under}s budget.",
                file=sys.stderr,
            )
            return 1
        print(f"PASS: {elapsed}s within the {args.assert_under}s budget.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
