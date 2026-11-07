#!/usr/bin/env python3
"""Placeringsregler: what each of the three rules costs, measured against main's model.

Two arms are solved side by side in two processes started together, so the
shared machine loads both alike (a paired A/B: one after the other on a loaded
Mac measures the load, not the rule). The `off` arm is the school as it is and
the other is the same school with one rule on:

    e1s  e1h   idrott not first and not last in the class's day, soft / hard
    e2s  e2h   the same, and slöjd not first, bild and hemkunskap not last
    r1s  r1h   at most 3 room changes a day for a class, 4 for a teacher
    b1s  b1h   at most 1 building change a day, class and teacher, the school
               in two buildings (classrooms free)
    b2s  b2h   the same with each year's classrooms in one house, as a
               two-house school keeps them
    s1s  s1h   the two halls shared, 60 seats each

    python benchmarks/placement_rules.py --mode first --arms off,e1h
    python benchmarks/placement_rules.py --mode full --arms off,b1s --budget 60
    python benchmarks/placement_rules.py --mode size --arms off,e1s,e1h,r1s,r1h,b1s,b1h,s1s,s1h

The school: `hogstadium` (450 pupils, 26 teachers, 423 lessons). Every build
and every solve runs on all the machine's cores, in both processes at once.

WHAT IS COUNTED is the rule's own measure, taken by code that shares nothing
with app/solver/placement.py, on the timetable each arm makes:

    edge      flagged lessons that open or close their class's day
    places    party-days (a class, a teacher) over the limit, counted as the
              model counts them (distinct places - 1) and as a school would
              (changes between neighbouring lessons, in time order), for
              rooms as the engine's room groups and as concrete rooms, and for
              buildings
    seats     the most pupils in a shared hall at once, against its seats

A soft arm is a wish and not a refusal, so a count is a result and never a
failure; `problems` is validate_schedule.validate on the full timetable and
must be empty.

    size    the satisfaction and the full model built, no solve: variables and
            constraints, and the pre-flight's verdict
    first   the satisfaction model solved to its first timetable (stop after
            first solution), as phase 1a does
    full    solve() end to end on the budget, then validate
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
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

import hogstadium  # noqa: E402

#: How many rooms of each kind stand in Hus A; the rest are in Hus B. The same
#: split the travel variant makes between its two sites (hogstadium.SITES).
HOUSE_A = {kind: north for kind, (north, _south) in hogstadium.SITES.items()}
SEATS = 60


def _subject(code: str) -> str:
    return hogstadium._uid(f"subject-{code}")


def _edges(mode: str, *rows: tuple[str, bool, bool]) -> dict[str, object]:
    return {"subjectEdges": {
        "mode": mode,
        "weight": 250,
        "subjects": [{"subjectId": _subject(code), "notFirst": a, "notLast": b} for code, a, b in rows],
    }}


def _changes(mode: str, **limits: int) -> dict[str, object]:
    return {"changes": {"mode": mode, "weight": 250, **limits}}


def _mode(arm: str) -> str:
    return "SOFT" if arm.endswith("s") else "HARD"


#: arm -> what it adds to the school: (placementRules, buildings, homes, shared halls)
def arm_of(name: str) -> tuple[dict[str, object] | None, bool, bool, bool]:
    if name == "off":
        return None, False, False, False
    mode = _mode(name)
    if name.startswith("e1"):
        return _edges(mode, ("IDH", True, True)), False, False, False
    if name.startswith("e2"):
        return _edges(
            mode, ("IDH", True, True), ("SL", True, False), ("BL", False, True), ("HKK", False, True),
        ), False, False, False
    if name.startswith("r1"):
        return _changes(mode, maxClassRoomChanges=3, maxTeacherRoomChanges=4), False, False, False
    if name.startswith("b1"):
        return _changes(mode, maxClassBuildingChanges=1, maxTeacherBuildingChanges=1), True, False, False
    if name.startswith("b2"):
        return _changes(mode, maxClassBuildingChanges=1, maxTeacherBuildingChanges=1), True, True, False
    if name.startswith("s1"):
        return {"sharedRooms": {"mode": mode, "weight": 250}}, False, False, True
    msg = f"unknown arm {name}"
    raise SystemExit(msg)


def school(arm: str) -> OptimizeScheduleRequest:
    rules, buildings, homes, shared = arm_of(arm)
    base = hogstadium.build_request(blocks=True)
    if rules is None:
        return base
    payload = base.model_dump(by_alias=True, mode="json", exclude_none=True)
    position: dict[str, int] = defaultdict(int)
    for room in payload["rooms"]:
        kind = room["type"]
        index = position[kind]
        position[kind] += 1
        in_a = index < HOUSE_A[kind]
        if buildings:
            room["building"] = "Hus A" if in_a else "Hus B"
        if homes and kind == "CLASSROOM":
            room["minGradeLevel"], room["maxGradeLevel"] = (7, 7) if in_a else (8, 9)
        if shared and kind == "GYMNASIUM":
            room["capacity"] = SEATS
            room["shareable"] = True
    payload["placementRules"] = rules
    return OptimizeScheduleRequest.model_validate(payload)


def _minutes(value: str) -> int:
    hours, minutes, *_ = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def counts(request: OptimizeScheduleRequest, lessons) -> dict[str, object]:
    """The rules' own measures on a timetable; no code shared with the model."""
    by_requirement = {r.id: r for r in request.requirements}
    rooms = {room.id: room for room in request.rooms}
    partners: dict[object, set[object]] = defaultdict(set)
    for first, second in request.group_conflicts:
        partners[first].add(second)
        partners[second].add(first)
    classes = [group.id for group in request.groups]
    result: dict[str, object] = {}
    rules = request.placement_rules

    placed = []
    for lesson in lessons:
        requirement = by_requirement[lesson.requirement_id]
        key = requirement.pupil_group_id or requirement.student_group_id
        placed.append({
            "day": lesson.day_of_week,
            "start": _minutes(lesson.start_time),
            "end": _minutes(lesson.end_time),
            "subject": requirement.subject_id,
            "key": key,
            "room": lesson.room_id,
            "teachers": {t for t in (lesson.teacher_id or requirement.teacher_id, requirement.co_teacher_id) if t},
            "size": requirement.student_group_size,
        })

    if rules and rules.subject_edges:
        flagged = {row.subject_id: (row.not_first, row.not_last) for row in rules.subject_edges.subjects}
        opening = closing = 0
        for lesson in placed:
            wanted = flagged.get(lesson["subject"])
            if wanted is None:
                continue
            breached_first = breached_last = False
            for class_id in classes:
                if lesson["key"] != class_id and class_id not in partners[lesson["key"]]:
                    continue
                day = [
                    other for other in placed
                    if other is not lesson and other["day"] == lesson["day"]
                    and (other["key"] == class_id or class_id in partners[other["key"]])
                ]
                breached_first |= wanted[0] and not any(o["start"] < lesson["start"] for o in day)
                breached_last |= wanted[1] and not any(o["end"] > lesson["end"] for o in day)
            opening += breached_first
            closing += breached_last
        result["edgeOpening"], result["edgeClosing"] = opening, closing

    if rules and rules.changes:
        limits = rules.changes
        asked = {
            ("class", "room"): limits.max_class_room_changes,
            ("teacher", "room"): limits.max_teacher_room_changes,
            ("class", "building"): limits.max_class_building_changes,
            ("teacher", "building"): limits.max_teacher_building_changes,
        }

        def group_of(room_id) -> object:
            room = rooms[room_id]
            return (room.type, room.capacity, room.min_grade_level, room.max_grade_level, room.building)

        for (party, kind), limit in asked.items():
            if limit is None:
                continue
            days: dict[tuple, list[dict]] = defaultdict(list)
            for lesson in placed:
                owners = [lesson["key"]] if party == "class" else lesson["teachers"]
                for owner in owners:
                    days[(owner, lesson["day"])].append(lesson)
            exact = distinct = concrete = 0
            for lessons_of_day in days.values():
                ordered = sorted(lessons_of_day, key=lambda l: l["start"])
                where = [
                    group_of(l["room"]) if kind == "room" else rooms[l["room"]].building
                    for l in ordered if l["room"] is not None
                ]
                changes = sum(a != b for a, b in zip(where, where[1:]))
                exact += changes > limit
                distinct += len(set(where)) - 1 > limit
                if kind == "room":
                    ids = [l["room"] for l in ordered if l["room"] is not None]
                    concrete += sum(a != b for a, b in zip(ids, ids[1:])) > limit
            tag = f"{party}{kind.capitalize()}"
            result[f"{tag}DaysOverByDistinct"] = distinct
            result[f"{tag}DaysOverByChanges"] = exact
            if kind == "room":
                result[f"{tag}DaysOverByConcreteRooms"] = concrete

    if rules and rules.shared_rooms:
        peak: dict[object, int] = defaultdict(int)
        events: dict[object, list[tuple[int, int, int]]] = defaultdict(list)
        for lesson in placed:
            room = rooms.get(lesson["room"])
            if room is not None and room.shareable:
                events[(lesson["room"], lesson["day"])].append((lesson["start"], 1, lesson["size"]))
                events[(lesson["room"], lesson["day"])].append((lesson["end"], 0, lesson["size"]))
        for (room_id, _day), found in events.items():
            seated = 0
            for _at, opens, size in sorted(found):
                seated += size if opens else -size
                peak[room_id] = max(peak[room_id], seated)
        result["sharedPeakSeated"] = max(peak.values(), default=0)
        result["sharedOverSeats"] = sum(
            max(0, seated - SEATS) for seated in peak.values()
        )
    return result


def measure(args: tuple[str, str, str, float]) -> dict[str, object]:
    name, mode, arm, budget = args
    request = school(arm)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]
    result: dict[str, object] = {"school": name, "mode": mode, "arm": arm, "load": [round(os.getloadavg()[0], 1)]}
    if mode in {"size", "first"}:
        try:
            solver._validate_request(request)
            result["preflight"] = "ok"
        except Exception as refused:  # noqa: BLE001 - the verdict is the result
            result["preflight"] = f"{getattr(refused, 'code', type(refused).__name__)}"
        started = time.perf_counter()
        full, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
        result["fullBuildSeconds"] = round(time.perf_counter() - started, 2)
        started = time.perf_counter()
        model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
        result["feasibleBuildSeconds"] = round(time.perf_counter() - started, 2)
        result.update({
            "variables": len(model.Proto().variables),
            "constraints": len(model.Proto().constraints),
            "fullVariables": len(full.Proto().variables),
            "fullConstraints": len(full.Proto().constraints),
            "estimate": solver._estimate_model_size(request),
        })
        if mode == "first":
            cp = cp_model.CpSolver()
            cp.parameters.max_time_in_seconds = budget
            cp.parameters.stop_after_first_solution = True
            result["status"] = cp.StatusName(cp.Solve(model))
            result["firstSolutionSeconds"] = round(cp.WallTime(), 2)
    else:
        from validate_schedule import validate

        started = time.perf_counter()
        try:
            response = solver.solve(request)
        except Exception as refused:  # noqa: BLE001 - a named refusal is a result
            result.update({"status": f"REFUSED {getattr(refused, 'code', type(refused).__name__)}"})
        else:
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
                result.update(counts(request, response.lessons))
    result["load"].append(round(os.getloadavg()[0], 1))  # type: ignore[union-attr]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=["size", "first", "full"], default="first")
    parser.add_argument("--arms", default="off,e1h")
    parser.add_argument("--budget", type=float, default=60.0)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--serial", action="store_true", help="size: one arm at a time (no pairing needed)")
    args = parser.parse_args()
    arms = args.arms.split(",")
    for _ in range(args.rounds):
        jobs = [("hogstadium", args.mode, arm, args.budget) for arm in arms]
        if args.mode == "size" or args.serial:
            for job in jobs:
                print(json.dumps(measure(job)), flush=True)
            continue
        # Pairs: `off` beside each other arm, started together.
        others = [arm for arm in arms if arm != "off"]
        for arm in others or ["off"]:
            pair = ["off", arm] if arm != "off" else ["off"]
            with multiprocessing.get_context("spawn").Pool(len(pair)) as pool:
                for result in pool.map(measure, [("hogstadium", args.mode, a, args.budget) for a in pair]):
                    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
