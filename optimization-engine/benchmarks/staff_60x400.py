#!/usr/bin/env python3
"""Staffing proposal wall-clock benchmark: 60 teachers, 400 curriculum entries.

The roadmap's assumption for Fas 4: "CP-SAT with ~60 × 400 booleans solves to
optimality well inside the cap". This builds a synthetic högstadium of that
size — 40 classes in years 7–9, 12 subjects, a third of the rows fixed, a
fifth kept with a current lead, the rest open, five per cent co-taught,
fractional charges from split and odd-week rows, behörigheter per subject and
year span — and times StaffingSolver.solve end to end, domains and build
included, because that is what the admin waits for.

    python benchmarks/staff_60x400.py                 # report, as JSON
    python benchmarks/staff_60x400.py --runs 3 --assert-under 10

It records the host's load average beside the numbers: on a shared Mac every
other process inflates wall-clock and CPU time alike, so a time without its
load is not evidence of anything.

tests/test_staffing.py imports build_school from here, so the pytest bench and
this script solve the very same school. The generated school is deterministic
(fixed RNG seed and UUID namespace).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

_NS = uuid.UUID("2b1f7e3c-5a4d-4c8e-9f60-7d3a1b2c4e5f")

SUBJECTS = 12
CLASSES = 40
ROWS_PER_CLASS = 10
TOLERANCE_PERCENT = 10
FULL_TIME_MINUTES = 1080


def _uid(label: str) -> str:
    """A deterministic version-4 UUID (the schema pins every id to UUID4)."""
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def band(target_minutes: int, tolerance: int = TOLERANCE_PERCENT) -> dict[str, int]:
    """targetTenths, limitTenths and floorTenths as the gateway computes them."""
    slack = target_minutes * tolerance / 100
    return {
        "targetTenths": 10 * target_minutes,
        "limitTenths": 10 * math.floor(target_minutes + slack) + 4,
        "floorTenths": max(0, 10 * math.ceil(target_minutes - slack) - 5),
    }


def build_school(
    seed: int = 4,
    teachers: int = 60,
    classes: int = CLASSES,
    *,
    respect: bool = True,
) -> dict:
    rng = random.Random(seed)
    subjects = [_uid(f"s{seed}-{index}") for index in range(SUBJECTS)]
    spans = [(7, 9), (7, 9), (7, 9), (7, 8), (8, 9)]

    staff: list[dict] = []
    quals: list[list[tuple[int, int, int]]] = []
    for index in range(teachers):
        roll = rng.random()
        if roll < 0.05:
            target = 0  # a full nedsättning
        elif roll < 0.12:
            target = None  # no employment row
        else:
            target = 5 * round(FULL_TIME_MINUTES * rng.choice([0.5, 0.75, 1, 1, 1]) / 5)
        duty = rng.choice([0, 0, 600, 1200])
        staff.append({
            "id": _uid(f"t{seed}-{index}"),
            **(band(target) if target is not None else {}),
            "fixedTenths": duty,
        })
        quals.append([
            (subject, *rng.choice(spans))
            for subject in rng.sample(range(SUBJECTS), rng.choice([1, 2, 2, 3]))
        ])

    def qualified(subject: int, grade: int) -> list[int]:
        return [
            t for t, held in enumerate(quals)
            if any(s == subject and low <= grade <= high for s, low, high in held)
        ]

    sets: dict[tuple[int, ...], str] = {}
    rows: list[dict] = []
    for klass in range(classes):
        grade = 7 + klass % 3
        group = _uid(f"g{seed}-{klass}")
        for subject in rng.sample(range(SUBJECTS), ROWS_PER_CLASS):
            minutes = rng.choice([40, 60, 80, 100, 120, 160, 180, 240])
            # Split and odd-week rows make the charge a fraction, as they do.
            share = rng.choice([1, 1, 1, 1, 0.5, 0.75])
            charge = math.ceil(10 * minutes * share - 1e-6)
            members = tuple(qualified(subject, grade))
            set_id = None
            if members:
                set_id = sets.setdefault(members, _uid(f"e{seed}-{len(sets)}"))
            row = {
                "id": _uid(f"r{seed}-{klass}-{subject}"),
                "subjectId": subjects[subject],
                "studentGroupId": group,
                "chargeTenths": charge,
                "lessonMinutes": minutes,
                "minGradeLevel": grade,
                "maxGradeLevel": grade,
                "fixed": False,
                "currentTeacherId": None,
                "coTeacherId": None,
                "eligibilitySetId": set_id,
                "lastYearTeacherIds": [],
            }
            kind = rng.random()
            if kind < 0.3 and members:
                lead = rng.choice(members)
                row["fixed"] = True
                row["currentTeacherId"] = staff[lead]["id"]
                staff[lead]["fixedTenths"] += charge
            elif kind < 0.5:
                # Mostly a qualified lead; now and then whoever had it.
                pool = list(members) if members and rng.random() < 0.85 else range(teachers)
                row["currentTeacherId"] = staff[rng.choice(list(pool))]["id"]
            elif members and rng.random() < 0.5:
                row["lastYearTeacherIds"] = [staff[rng.choice(members)]["id"]]
            if rng.random() < 0.05:
                co = rng.randrange(teachers)
                if staff[co]["id"] != row["currentTeacherId"]:
                    row["coTeacherId"] = staff[co]["id"]
                    staff[co]["fixedTenths"] += charge
            rows.append(row)

    return {
        "requestId": _uid(f"req{seed}"),
        "respectQualifications": respect,
        "qualificationsRecorded": True,
        "teachers": staff,
        "requirements": rows,
        "eligibilitySets": [
            {"id": set_id, "teacherIds": [staff[t]["id"] for t in members]}
            for members, set_id in sets.items()
        ],
    }


def _load_average() -> str:
    try:
        one, five, fifteen = os.getloadavg()
    except OSError:
        return "unknown"
    return f"{one:.2f} {five:.2f} {fifteen:.2f}"


def main() -> int:
    from app.config import Settings
    from app.schemas.staffing import StaffRequest
    from app.solver.staffing_solver import StaffingSolver

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=4)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--assert-under", type=float, default=None)
    args = parser.parse_args()

    request = StaffRequest.model_validate(build_school(args.seed))
    solver = StaffingSolver(Settings())
    results = []
    for _ in range(args.runs):
        load_before = _load_average()
        began = time.perf_counter()
        response = solver.solve(request)
        wall = time.perf_counter() - began
        report = solver.last_report
        results.append({
            "wallSeconds": round(wall, 3),
            "buildSeconds": round(report.build, 3),
            "stage1Seconds": round(report.stage1, 3),
            "stage2Seconds": round(report.stage2, 3),
            "stage1": report.stage1_status,
            "stage2": report.stage2_status,
            "stage2Objective": report.stage2_objective,
            "stage2Bound": report.stage2_bound,
            "canonical": report.canonical_status,
            "status": response.status,
            "unstaffedProven": response.unstaffed_proven,
            "unstaffed": len(response.unstaffed),
            "terms": response.terms.after.model_dump(by_alias=True),
            "loadAverageBefore": load_before,
        })
    print(json.dumps({
        "teachers": len(request.teachers),
        "requirements": len(request.requirements),
        "cpus": os.cpu_count(),
        "runs": results,
    }, indent=2))
    if args.assert_under is not None and any(r["wallSeconds"] >= args.assert_under for r in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
