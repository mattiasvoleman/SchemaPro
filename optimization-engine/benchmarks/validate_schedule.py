#!/usr/bin/env python3
"""Independently check that a produced timetable actually obeys the rules.

Nothing else in the repo does this. The solver's own status is not evidence:
CP-SAT reports OPTIMAL for the model it was given, so a constraint that was
never posted — or was posted wrongly — yields a confident OPTIMAL and an
invalid timetable. This module re-derives every rule from the *request* and
checks the *response*, sharing no code with the model builders.

That independence is the point, and it has already paid: it caught the solver
emitting a lesson at slot 38 running four slots past a 40-slot day end
(``_create_lesson_decisions`` gives ``start`` the contiguous domain
``[0, horizon - duration]``, which spans the whole week rather than one day).

Checks, all derived from the request:

    within-day        a lesson may not run past the end of its own day
    teacher overlap   one teacher, one place at a time
    group overlap     one student group, one place at a time
    room overlap      one room, one lesson at a time
    room eligibility  capacity >= group size, and required type matches
    availability      no lesson inside a recurring UNAVAILABLE window
    lunch             a free contiguous window inside the lunch window, per
                      day, for each group the request says eats — the groups it
                      names, or every group with requirements when it names
                      none — except where a recurring rule holds that whole
                      window free for the class, which is the school saying
                      the class is not in the building
    max per day       lessons per group per day within the configured cap

Use as a library::

    from validate_schedule import validate
    problems = validate(grid, request, response.lessons)

or from the command line against the synthetic benchmark school::

    python benchmarks/validate_schedule.py --students 250 --budget 10
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "validate-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")


def _occupied(grid, day_of_week, start_time, duration_slots):
    """Absolute slot indices a lesson occupies, plus its day-relative start."""
    day_idx = grid.day_index(day_of_week)
    start_slot = grid.parse_hhmmss(start_time)
    abs_start = day_idx * grid.slots_per_day + start_slot
    return day_idx, start_slot, list(range(abs_start, abs_start + duration_slots))


def _lunch_exempt_days(grid, constraints, window_start, window_end) -> set[tuple]:
    """(group, day) pairs the school has excused from lunch, from the request.

    A recurring UNAVAILABLE rule on a STUDENT_GROUP that holds the ENTIRE lunch
    window free is not a school asking for an impossible break. It is a school
    saying the class is not in the building: "7A undervisas inte på tisdagar"
    has no other way to be written, and the same row keeps that day's lessons
    away too. The engine reads it that way — no sitting is built for such a
    (group, day) and no chair is booked in the hall — so demanding a free
    window here would answer a correct timetable with a violation nobody can
    act on.

    A rule that eats only PART of the window is the opposite case: the class is
    in school, busy, and the break must still fit around it. So the test is
    coverage of the whole window and nothing less.

    The times are folded onto the grid rather than parsed strictly, unlike the
    availability loop in validate(). That loop may be strict because a row it
    cannot read is a row it declines to check; this one must not decline,
    because a row it fails to read becomes a violation it invents. Schools
    write "away all day" as 00:00-23:59 — this product's own full-day closure,
    see isFullDay in calendar.service.ts — and strict parsing rejects both ends
    of exactly the rule this exists for. A window that misses the school day
    altogether still constrains nothing and is dropped.

    A row with no weekday names every teaching day, and dated rows are skipped:
    the timetable is one generic week with nowhere to put a single date.

    NOT REACHABLE THROUGH THIS ENGINE'S OWN OUTPUT TODAY, and modelled anyway.
    A group's lessons are held out of the group's own reserved window by the
    availability rule, so an exempt day reaches the lunch check with an empty
    window and passes by luck — the luck of a different rule holding. Borrowed
    correctness is what this file exists to refuse: were the engine to drop
    that rule, the lunch check would report the excused class's missing break
    beside the real fault and bury it. And validate() is a library, which may
    be handed a week this engine never produced.
    """
    exempt: set[tuple] = set()

    for constraint in constraints:
        if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
            continue
        if constraint.resource_kind != "STUDENT_GROUP" or constraint.resource_id is None:
            continue
        try:
            c_lo = grid.clamp_to_grid(constraint.start_time)
            c_hi = grid.clamp_to_grid(constraint.end_time)
        except ValueError:
            continue
        if c_lo is None or c_hi is None or c_hi <= c_lo:
            continue
        if c_lo > window_start or c_hi < window_end:
            continue
        days = (
            (constraint.day_of_week,)
            if constraint.day_of_week is not None
            else grid.schedule_days
        )
        for day in days:
            try:
                exempt.add((constraint.resource_id, grid.day_index(day)))
            except ValueError:
                continue

    return exempt


def validate(grid, request, lessons) -> list[str]:
    """Return a list of rule violations; empty means the timetable is valid."""
    problems: list[str] = []
    spd = grid.slots_per_day

    req_by_id = {r.id: r for r in request.requirements}
    rooms_by_id = {r.id: r for r in request.rooms}

    busy: dict[str, dict] = {
        "teacher": defaultdict(dict),
        "student group": defaultdict(dict),
        "room": defaultdict(dict),
    }
    per_group_day: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    placed_by_requirement: dict = defaultdict(int)

    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            problems.append(f"lesson names unknown requirement {lesson.requirement_id}")
            continue
        placed_by_requirement[requirement.id] += 1

        try:
            duration = grid.minutes_to_slots(requirement.minutes_per_lesson)
            day_idx, start_slot, slots = _occupied(
                grid, lesson.day_of_week, lesson.start_time, duration)
        except ValueError as exc:
            problems.append(f"lesson {lesson.requirement_id}: unreadable placement — {exc}")
            continue

        # A lesson must finish inside the day it started.
        if start_slot + duration > spd:
            problems.append(
                f"lesson {lesson.requirement_id} starts at slot {start_slot} and runs "
                f"{duration} slots, past the {spd}-slot day end — it also occupies the "
                f"next day's opening slots")

        for kind, resource in (
            ("teacher", requirement.teacher_id),
            ("student group", requirement.student_group_id),
            ("room", lesson.room_id),
        ):
            if resource is None:
                continue
            table = busy[kind][resource]
            for slot in slots:
                if slot in table:
                    problems.append(
                        f"{kind} {resource} double-booked at absolute slot {slot}")
                    break
                table[slot] = lesson.requirement_id

        if lesson.room_id is not None:
            room = rooms_by_id.get(lesson.room_id)
            if room is None:
                problems.append(f"lesson {lesson.requirement_id} names unknown room "
                                f"{lesson.room_id}")
            else:
                if room.capacity is not None and room.capacity < requirement.student_group_size:
                    problems.append(
                        f"lesson {lesson.requirement_id} in room {lesson.room_id}: "
                        f"capacity {room.capacity} < group size "
                        f"{requirement.student_group_size}")
                if (requirement.required_room_type is not None
                        and room.type != requirement.required_room_type):
                    problems.append(
                        f"lesson {lesson.requirement_id} requires "
                        f"{requirement.required_room_type} but got {room.type}")

        per_group_day[(requirement.student_group_id, day_idx)].append(
            (start_slot, start_slot + duration))

    # Every requested lesson must be placed exactly as many times as requested.
    for requirement in request.requirements:
        want = requirement.lessons_per_week
        got = placed_by_requirement.get(requirement.id, 0)
        if got != want:
            problems.append(
                f"requirement {requirement.id}: {got} lessons placed, {want} requested")

    # Group-conflict pairs (groups sharing students) must never overlap.
    lessons_by_group: dict = defaultdict(list)
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        try:
            duration = grid.minutes_to_slots(requirement.minutes_per_lesson)
            day_idx, start_slot, _ = _occupied(
                grid, lesson.day_of_week, lesson.start_time, duration)
        except ValueError:
            continue
        lessons_by_group[requirement.student_group_id].append(
            (day_idx * grid.slots_per_day + start_slot,
             day_idx * grid.slots_per_day + start_slot + duration))
    for first_id, second_id in getattr(request, "group_conflicts", []) or []:
        for a_start, a_end in lessons_by_group.get(first_id, []):
            for b_start, b_end in lessons_by_group.get(second_id, []):
                if a_start < b_end and b_start < a_end:
                    problems.append(
                        f"groups {first_id} and {second_id} share students but "
                        f"overlap at absolute slots {max(a_start, b_start)}-"
                        f"{min(a_end, b_end)}")

    # Recurring UNAVAILABLE windows are hard constraints.
    for constraint in request.constraints:
        if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
            continue
        try:
            c_day = grid.day_index(constraint.day_of_week)
            c_lo = grid.parse_hhmmss(constraint.start_time)
            c_hi = grid.parse_hhmmss(constraint.end_time)
        except ValueError:
            continue
        for lesson in lessons:
            requirement = req_by_id.get(lesson.requirement_id)
            if requirement is None:
                continue
            owner = {
                "TEACHER": (requirement.teacher_id, requirement.co_teacher_id),
                "STUDENT_GROUP": (requirement.student_group_id,),
                "ROOM": (lesson.room_id,),
            }.get(constraint.resource_kind, ())
            if constraint.resource_id not in owner:
                continue
            try:
                duration = grid.minutes_to_slots(requirement.minutes_per_lesson)
                day_idx, start_slot, _ = _occupied(
                    grid, lesson.day_of_week, lesson.start_time, duration)
            except ValueError:
                continue
            if day_idx != c_day:
                continue
            if start_slot < c_hi and c_lo < start_slot + duration:
                problems.append(
                    f"lesson {lesson.requirement_id} overlaps UNAVAILABLE window "
                    f"{constraint.start_time}-{constraint.end_time} for "
                    f"{constraint.resource_kind} {constraint.resource_id}")

    rules = request.rules
    if rules is not None:
        # WHO IS OWED A MEAL, re-derived from the request as every other check
        # here is, and by the rule the schema writes beside `groups`. A named
        # list is the gateway naming the home classes that eat: a teaching
        # group is not among them because its pupils already eat with their
        # class, so demanding a window for one would fail a timetable that is
        # correct. An ABSENT list is the other case, and it is not an empty
        # dining room. The field is optional so the engine can ship before the
        # gateway that fills it, and until then the guarantee reaches every
        # group with requirements while the hall hears about nobody. Silence
        # there would pass exactly the week that turned this gate red: a model
        # that carried no lunch at all, taught edge to edge through the window.
        eating_group_ids = (
            {group.id for group in request.groups}
            if request.groups
            else {r.student_group_id for r in request.requirements}
        )

        if rules.lunch_start_time and rules.lunch_end_time and rules.lunch_minutes:
            lo = grid.parse_hhmmss(rules.lunch_start_time)
            hi = grid.parse_hhmmss(rules.lunch_end_time)
            need = grid.minutes_to_slots(rules.lunch_minutes)
            exempt_days = _lunch_exempt_days(grid, request.constraints, lo, hi)
            for group_id in eating_group_ids:
                for day_idx in range(len(grid.schedule_days)):
                    # The school held this whole window free for this class,
                    # which is how it says the class is not here. Nothing is
                    # owed on a day nobody eats — see _lunch_exempt_days.
                    if (group_id, day_idx) in exempt_days:
                        continue
                    spans = per_group_day.get((group_id, day_idx), [])
                    if not any(
                        all(cand + need <= s or cand >= e for s, e in spans)
                        for cand in range(lo, hi - need + 1)
                    ):
                        problems.append(
                            f"group {group_id}, day index {day_idx}: no free "
                            f"{rules.lunch_minutes}-minute window inside "
                            f"{rules.lunch_start_time}-{rules.lunch_end_time}")

        if rules.max_lessons_per_day_per_group is not None:
            cap = rules.max_lessons_per_day_per_group
            for (group_id, day_idx), spans in per_group_day.items():
                if len(spans) > cap:
                    problems.append(
                        f"group {group_id}, day index {day_idx}: {len(spans)} lessons "
                        f"exceeds the cap of {cap}")

    return problems


def main() -> int:
    from app.config import Settings
    from app.solver.scheduler_solver import SchedulerSolver

    from solve_2000_students import SchoolShape, build_request

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--students", type=int, default=250)
    parser.add_argument("--budget", type=float, default=10.0)
    parser.add_argument("--lift-guard", action="store_true",
                        help="bypass MAX_MODEL_COMPLEXITY so large schools can be tried")
    args = parser.parse_args()

    if args.lift_guard:
        SchedulerSolver.MAX_MODEL_COMPLEXITY = 10**12
        SchedulerSolver.MAX_LESSON_INSTANCES = 10**9

    settings = Settings(
        API_KEY="validate-key-0000000000000000000000",
        ALLOWED_ORIGINS="http://localhost",
        SOLVER_MAX_TIME_SECONDS=args.budget,
    )
    request = build_request(SchoolShape(students=args.students, constraint_density=1.0))
    solver = SchedulerSolver(settings)
    response = solver.solve(request)

    print(f"{args.students} students — solver reported {response.status}, "
          f"{len(response.lessons)} lessons")
    if not response.lessons:
        print("no timetable to validate")
        return 1

    problems = validate(solver._grid, request, response.lessons)
    if not problems:
        print("VALID — every checked rule holds")
        return 0
    print(f"INVALID — {len(problems)} violation(s):")
    for problem in problems[:25]:
        print(f"  - {problem}")
    if len(problems) > 25:
        print(f"  … and {len(problems) - 25} more")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
