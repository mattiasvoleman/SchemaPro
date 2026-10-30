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
    python benchmarks/hogstadium.py --teacher-day-rules [--first-solution]
    python benchmarks/hogstadium.py --teacher-day-rules --infeasible-days
    python benchmarks/hogstadium.py --teacher-day-rules --wish-disruption
    python benchmarks/hogstadium.py --travel 10 [--first-solution]
    python benchmarks/hogstadium.py --travel 10 --open-sites [--first-solution]
    python benchmarks/hogstadium.py --ab-weeks [--first-solution]

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

LÄRARENS DAG, opt in with --teacher-day-rules: caps, deltid days and free-day
wishes on teachers whose real loads make each one bite (see TEACHER_DAY_RULES).
Without the flag the week is byte for byte the one every earlier phase
measured on. --infeasible-days adds a deltid post the week cannot hold and the
pre-flight cannot see — two locked afternoons on a three-day post — which must
come back INFEASIBLE, quickly, and never TIMEOUT. --wish-disruption measures
the free-day wish against last term's timetable: one solve without the wishes
seeds previousLessons, then the week is solved with them, once with the
disruption term standing back on the wished days and once without.

A/B-VECKOR, opt in with --ab-weeks: slöjd and hemkunskap alternate. Classes
A-C of each year have slöjd 2 × 90 in odd weeks and hemkunskap 2 × 60 in
even ones, classes D-F the other way round, so every real week holds the
loads the weekly week held — the slöjd teacher's 27 hours, the kitchen's 18 —
and each class gets the year's minutes of both. The pair may share one hour of
a class, and the slöjd teacher's two halves of the year one hour of theirs.
Without the flag no requirement alternates, which is the week every earlier
phase measured on.

RESTID I GENERATORN, opt in with --travel MINUTES: the school stands on two
skolområden, Norra and Södra, MINUTES apart, with its rooms split between them
(SITES) — half the classrooms on each, the kitchen and the art room at Norra,
the music room and the workshops at Södra, a laboratory and a hall on each and
the third laboratory at Norra. The classrooms are each year's home, as a
two-site school keeps them: Norra's eleven for åk 7, Södra's for åk 8 and 9
(their own stage limits, which the generator already reads), so a class walks
for the rooms its site lacks and nowhere else. And the staff is the site's,
as a two-site school staffs: in a subject with more than one teacher, åk 7's
classes are taught by its first and åk 8 and 9's by the others (site_teacher),
so the teachers who walk are the ones a school has only one of — music,
slöjd, bild, hemkunskap, teknik — and the NO teachers between the
laboratories. The week's loads are the earlier phases' own, divided the other
way. --open-sites is the worst case instead: every classroom open to every
year, and every teacher spread over the years as the earlier phases staff
them, so every lesson without a room type chooses its site and nearly every
teacher walks every day. Without --travel no room has a site and no walk is
sent, which is the week every earlier phase measured on.
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
from app.schemas.schedule import OptimizeScheduleRequest, PreviousLesson  # noqa: E402
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
#: Restid i generatorn: how many rooms of each kind stand at (Norra, Södra).
SITES = {
    "CLASSROOM": (11, 11),
    "LABORATORY": (2, 1),
    "GYMNASIUM": (1, 1),
    "ART": (1, 0),
    "MUSIC": (0, 1),
    "WORKSHOP": (0, 2),
    "KITCHEN": (1, 0),
}
ROOMS = (
    ("CLASSROOM", 22),
    ("LABORATORY", 3),
    ("GYMNASIUM", 2),
    ("ART", 1),
    ("MUSIC", 1),
    ("WORKSHOP", 2),
    ("KITCHEN", 1),
)


#: Lärarens dag, per teacher: (cap in minutes a day, days a week, wished free
#: ISO weekday), None where the teacher has none. Chosen off the school's own
#: loads, so each rule binds and none makes the week impossible:
#:   SL-0   18 × 90 = 1,620 min. A cap of 360 is four slöjd lessons a day, so
#:          the week needs all five days where five a day would leave one
#:          free — and minutes and lessons part company, which a count cap
#:          could not say.
#:   BL-0   21 × 60. 300 a day is five lessons, 25 a week.
#:   MU-0   21 × 60. 360 a day and Fridays free: four days at six is 24.
#:   TK-0   21 × 60 on four days of a post, Wednesdays wished free.
#:   IDH-1  19 × 60 on four days.
#:   TY-0   6 × 60, Tyska in all three språkval blocks, on two days of a post
#:          and Fridays wished free — the deltid språklärare whose two days
#:          every other språkval teacher, and every class's block, follows.
#:   SV-0, EN-1  a wish each, Monday and Friday.
TEACHER_DAY_RULES: dict[str, tuple[int | None, int | None, int | None]] = {
    "teacher-SL-0": (360, None, None),
    "teacher-BL-0": (300, None, None),
    "teacher-MU-0": (360, None, 5),
    "teacher-TK-0": (None, 4, 3),
    "teacher-IDH-1": (None, 4, None),
    "teacher-TY-0": (None, 2, 5),
    "teacher-SV-0": (None, None, 1),
    "teacher-EN-1": (None, None, 5),
}


def _uid(label: str) -> str:
    """A deterministic version-4 UUID for `label` (see solve_2000_students._uid)."""
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def _teacher_day_rows(
    *, infeasible_days: bool,
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    """Work rules, day limits and locked lessons for --teacher-day-rules.

    WITH --infeasible-days, TK-0's post allows three days and two afternoons of
    theirs are locked, Monday and Tuesday 12:00-16:00, every week — so the
    post's one week is [[1, 2]]. The locked days are teaching days whatever
    happens, so one more day is all the post leaves:
    four hours on each locked morning and a day of eight is 16 lessons, against
    21. The pre-flight counts the best three days the week has — three whole
    days, 24 lessons — and lets it through, which is the point: only the model
    can see that two of the three are the locked ones, and the linking rows are
    what let it say so at once rather than search for the budget.
    """
    locked = [
        {
            "id": _uid(f"locked-TK-0-{day}"),
            "teacherId": _uid("teacher-TK-0"),
            "studentGroupId": _uid(f"group-locked-TK-0-{day}"),
            "dayOfWeek": day,
            "startTime": "12:00:00",
            "endTime": "16:00:00",
        }
        for day in (1, 2)
    ] if infeasible_days else []
    rules = []
    limits = []
    for teacher, (cap, days, wish) in TEACHER_DAY_RULES.items():
        if infeasible_days and teacher == "teacher-TK-0":
            days = 3
        if cap is not None or wish is not None:
            rules.append({
                "id": _uid(f"work-rule-{teacher}"),
                "teacherId": _uid(teacher),
                **({"maxTeachingMinutesPerDay": cap} if cap is not None else {}),
                **({"preferredFreeDay": wish} if wish is not None else {}),
            })
        if days is not None:
            # Every lock here runs every week, so every week holds them all:
            # the one set the gateway sends for such a teacher, and [[]] for
            # a teacher with none.
            held = sorted({
                lesson["dayOfWeek"] for lesson in locked if lesson["teacherId"] == _uid(teacher)
            })
            limits.append({
                "id": _uid(f"post-{teacher}"),
                "teacherId": _uid(teacher),
                "maxTeachingDaysPerWeek": days,
                "lockedWeekdays": [held],
            })
    return rules, limits, locked


def site_teacher(code: str, year: int, class_index: int, pool: int) -> str:
    """Restid i generatorn's staffing: åk 7 by a subject's first teacher, åk 8
    and 9 by the rest, where the subject has more than one; see the docstring."""
    if pool == 1:
        return f"teacher-{code}-0"
    if year == 7:
        return f"teacher-{code}-0"
    return f"teacher-{code}-{1 + (class_index + year) % (pool - 1)}"


def build_request(
    *,
    blocks: bool = True,
    teacher_day_rules: bool = False,
    infeasible_days: bool = False,
    travel_minutes: int | None = None,
    open_sites: bool = False,
    pupil_gaps: bool = False,
    ab_weeks: bool = False,
) -> OptimizeScheduleRequest:
    """The school's week; `blocks=False` sends the same rows with no blockId.

    `pupil_gaps` sends the pupils' cohorts (Elevernas håltimmar), as the
    gateway does for a school that turns the rule on: the pupils booked alike,
    their groups and their class. Without it the key is not sent.

    `teacher_day_rules` adds Lärarens dag's rows (TEACHER_DAY_RULES), and
    `infeasible_days` the post the week cannot hold; without them the keys are
    not sent at all, as the gateway does not send them.
    """
    requirements: list[dict[str, object]] = []
    group_ids: dict[str, str] = {}
    memberships: list[set[str]] = []

    for year in YEARS:
        classes = [f"{year}{chr(ord('A') + index)}" for index in range(CLASSES_PER_YEAR)]
        for class_index, name in enumerate(classes):
            group_ids[name] = _uid(f"group-{name}")
            for code, lessons, minutes, room_type, pool in CLASS_SUBJECTS:
                teacher = (
                    site_teacher(code, year, class_index, pool)
                    if travel_minutes is not None and not open_sites
                    else f"teacher-{code}-{(class_index + year) % pool}"
                )
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
                if ab_weeks and code in ("SL", "HKK"):
                    # Half the classes slöjd on odd weeks, the other half on
                    # even ones, and hemkunskap the other week: twice the
                    # lessons in half the weeks (the module docstring).
                    first = (code == "SL") == (class_index < CLASSES_PER_YEAR // 2)
                    row["lessonsPerWeek"] = 2 * lessons
                    row["recurrence"] = "ODD_WEEKS" if first else "EVEN_WEEKS"
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
                "teacherId": _uid(
                    site_teacher(code, year, CLASSES_PER_YEAR, POOL[code])
                    if travel_minutes is not None and not open_sites
                    else f"teacher-{code}-{(year + 1) % POOL[code]}",
                ),
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
    if travel_minutes is not None:
        position: dict[str, int] = {}
        for room in rooms:
            kind = str(room["type"])
            index = position.get(kind, 0)
            position[kind] = index + 1
            norra = index < SITES[kind][0]
            room["siteId"] = _uid("site-norra" if norra else "site-sodra")
            if kind == "CLASSROOM" and not open_sites:
                room["minGradeLevel"], room["maxGradeLevel"] = (7, 7) if norra else (8, 9)
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
    payload: dict[str, object] = {
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
    }
    if travel_minutes is not None:
        payload["siteTravelTimes"] = [{
            "siteAId": _uid("site-norra"),
            "siteBId": _uid("site-sodra"),
            "minutes": travel_minutes,
        }]
    if pupil_gaps:
        homes = {group["id"] for group in groups}
        cohorts: dict[frozenset[str], int] = {}
        for pupil_groups in memberships:
            key = frozenset(pupil_groups)
            cohorts[key] = cohorts.get(key, 0) + 1
        payload["pupilGaps"] = {"cohorts": [
            {
                "groupIds": sorted(key),
                "homeGroupId": next(group for group in sorted(key) if group in homes),
                "pupils": count,
            }
            for key, count in sorted(cohorts.items(), key=lambda item: sorted(item[0]))
        ]}
    if teacher_day_rules or infeasible_days:
        work_rules, day_limits, locked = _teacher_day_rows(infeasible_days=infeasible_days)
        payload["teacherWorkRules"] = work_rules
        payload["teacherDayLimits"] = day_limits
        if locked:
            payload["fixedLessons"] = locked
    return OptimizeScheduleRequest.model_validate(payload)


def teacher_day_counts(request: OptimizeScheduleRequest) -> dict[str, int]:
    """How many caps, posts with days and wishes the week carries."""
    return {
        "teacherCaps": sum(
            1 for rule in request.teacher_work_rules
            if rule.max_teaching_minutes_per_day is not None
        ),
        "teacherDayLimits": len(request.teacher_day_limits),
        "freeDayWishes": sum(
            1 for rule in request.teacher_work_rules if rule.preferred_free_day is not None
        ),
    }


def wishes_kept(request: OptimizeScheduleRequest, lessons) -> tuple[int, int]:
    """(kept, wished): a wish is kept when the teacher has no lesson on the day,
    generated or locked, as lead or co-teacher. A count, never a violation —
    the wish is soft."""
    teaching: dict[uuid.UUID, set[int]] = {}
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    for lesson in lessons:
        requirement = by_requirement[lesson.requirement_id]
        for teacher in {requirement.teacher_id, requirement.co_teacher_id} - {None}:
            teaching.setdefault(teacher, set()).add(lesson.day_of_week)
    for fixed in request.fixed_lessons:
        for teacher in {fixed.teacher_id, fixed.co_teacher_id} - {None}:
            teaching.setdefault(teacher, set()).add(fixed.day_of_week)
    wished = [
        (rule.teacher_id, rule.preferred_free_day)
        for rule in request.teacher_work_rules
        if rule.preferred_free_day is not None
    ]
    kept = sum(1 for teacher, day in wished if day not in teaching.get(teacher, set()))
    return kept, len(wished)


def _load() -> float:
    """The one-minute load average, printed beside every number: on the shared
    Mac a timing without it cannot be compared with anything."""
    return round(os.getloadavg()[0], 1)


def run(
    *, blocks: bool, budget: float, teacher_day_rules: bool = False,
    infeasible_days: bool = False, travel_minutes: int | None = None,
    open_sites: bool = False, ab_weeks: bool = False,
) -> dict[str, object]:
    from validate_schedule import validate

    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget)  # type: ignore[call-arg]
    solver = SchedulerSolver(settings)
    request = build_request(
        blocks=blocks, teacher_day_rules=teacher_day_rules, infeasible_days=infeasible_days,
        travel_minutes=travel_minutes, open_sites=open_sites, ab_weeks=ab_weeks,
    )
    load_before = _load()
    started = time.perf_counter()
    response = solver.solve(request)
    elapsed = time.perf_counter() - started
    problems = validate(solver._grid, request, response.lessons) if response.lessons else []
    kept, wished = wishes_kept(request, response.lessons)
    # No timetable keeps no wish: an empty week would read as every one kept.
    kept = kept if response.lessons else 0

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
        "teacherDayRules": teacher_day_rules,
        "infeasibleDays": infeasible_days,
        "travelMinutes": travel_minutes,
        "openSites": open_sites,
        "abWeeks": ab_weeks,
        **teacher_day_counts(request),
        "status": response.status,
        "conflictCodes": sorted({
            detail.code for detail in (response.conflicts.conflicts if response.conflicts else [])
        }),
        "lessons": len(response.lessons),
        "requested": sum(r.lessons_per_week for r in request.requirements),
        "requirements": len(request.requirements),
        "groupConflicts": len(request.group_conflicts),
        "estimatedVariables": solver._estimate_model_size(request),
        "sprakvalSlotsOfYear7": len(slots),
        "wishesKept": kept,
        "wishes": wished,
        "problems": len(problems),
        "firstProblems": problems[:5],
        "elapsedSeconds": round(elapsed, 2),
        "budgetSeconds": budget,
        "loadAverage": [load_before, _load()],
    }


def first_solution(
    *, blocks: bool, budget: float, teacher_day_rules: bool = False,
    infeasible_days: bool = False, travel_minutes: int | None = None,
    open_sites: bool = False, ab_weeks: bool = False,
) -> dict[str, object]:
    """Seconds to a first timetable in the satisfaction model, as phase 1a builds it.

    What a block costs or saves the search, without phase 2's improving: the
    full solve spends whatever budget it is given, so its wall clock says how
    long the budget was, not how hard the week is. The full model is built
    beside it, never solved, for its size: what a rule adds to the objective's
    model is a number the first solution cannot show.
    """
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=budget))  # type: ignore[call-arg]
    request = build_request(
        blocks=blocks, teacher_day_rules=teacher_day_rules, infeasible_days=infeasible_days,
        travel_minutes=travel_minutes, open_sites=open_sites, ab_weeks=ab_weeks,
    )
    solver._validate_request(request)
    full, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    started = time.perf_counter()
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
    built = time.perf_counter() - started
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = budget
    cp.parameters.stop_after_first_solution = True
    load_before = _load()
    status = cp.StatusName(cp.Solve(model))
    return {
        "blocks": blocks,
        "teacherDayRules": teacher_day_rules,
        "infeasibleDays": infeasible_days,
        "travelMinutes": travel_minutes,
        "openSites": open_sites,
        "abWeeks": ab_weeks,
        **teacher_day_counts(request),
        "status": status,
        "buildSeconds": round(built, 2),
        "firstSolutionSeconds": round(cp.WallTime(), 2),
        "budgetSeconds": budget,
        "variables": len(model.Proto().variables),
        "constraints": len(model.Proto().constraints),
        "fullVariables": len(full.Proto().variables),
        "fullConstraints": len(full.Proto().constraints),
        "estimatedVariables": solver._estimate_model_size(request),
        "loadAverage": [load_before, _load()],
    }


class _DisruptionBlindToWishes(SchedulerSolver):
    """The solver as it would be without A6: the disruption term rewards last
    term's slots on a wished day like any other. For the measurement only."""

    def _add_disruption_objective(self, model, decisions, previous_lessons, weights, **_ignored):
        return super()._add_disruption_objective(model, decisions, previous_lessons, weights)


def wish_disruption(*, blocks: bool, budget: float) -> dict[str, object]:
    """Wishes kept against last term's timetable, with and without A6.

    Last term is this week solved with the caps and the posts but no wishes —
    a school that sets its wishes after the timetable it already has. Its
    lessons become previousLessons, and the week is solved again with the
    wishes: once by the engine as it is, whose disruption term stops rewarding
    a wishing teacher's slots on the wished day, and once by one whose
    disruption term does not.
    """
    request = build_request(blocks=blocks, teacher_day_rules=True)
    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget)  # type: ignore[call-arg]
    last_term = SchedulerSolver(
        Settings(SOLVER_MAX_TIME_SECONDS=budget, WEIGHT_FREE_DAY_WISH=0),  # type: ignore[call-arg]
    ).solve(request)
    seeded = request.model_copy(update={
        "previous_lessons": [
            PreviousLesson(
                requirement_id=lesson.requirement_id,
                day_of_week=lesson.day_of_week,
                start_time=lesson.start_time,
            )
            for lesson in last_term.lessons
        ],
    })
    out: dict[str, object] = {
        "lastTerm": last_term.status,
        "lastTermWishesKept": wishes_kept(request, last_term.lessons)[0],
        "wishes": teacher_day_counts(request)["freeDayWishes"],
        "previousLessons": len(seeded.previous_lessons),
    }
    for label, solver in (
        ("withA6", SchedulerSolver(settings)),
        ("withoutA6", _DisruptionBlindToWishes(settings)),
    ):
        load_before = _load()
        response = solver.solve(seeded)
        moved = len(
            {(l.requirement_id, l.day_of_week, l.start_time) for l in last_term.lessons}
            - {(l.requirement_id, l.day_of_week, l.start_time) for l in response.lessons},
        )
        out[label] = {
            "status": response.status,
            "wishesKept": wishes_kept(seeded, response.lessons)[0],
            "lessonsMoved": moved,
            "loadAverage": [load_before, _load()],
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--without-blocks", action="store_true",
                        help="send the same rows with no blockId")
    parser.add_argument("--first-solution", action="store_true",
                        help="time the satisfaction model to its first timetable only")
    parser.add_argument("--teacher-day-rules", action="store_true",
                        help="add the caps, deltid days and free-day wishes of TEACHER_DAY_RULES")
    parser.add_argument("--infeasible-days", action="store_true",
                        help="add a deltid post the week cannot hold; must answer INFEASIBLE")
    parser.add_argument("--wish-disruption", action="store_true",
                        help="wishes kept against last term's timetable, with and without A6")
    parser.add_argument("--travel", type=int, default=None, metavar="MINUTES",
                        help="stand the school on two sites MINUTES apart (SITES)")
    parser.add_argument("--open-sites", action="store_true",
                        help="with --travel, open every classroom to every year")
    parser.add_argument("--ab-weeks", action="store_true",
                        help="slöjd and hemkunskap on alternate weeks (A/B-veckor)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    blocks = not args.without_blocks
    rules = {
        "teacher_day_rules": args.teacher_day_rules,
        "infeasible_days": args.infeasible_days,
        "travel_minutes": args.travel,
        "open_sites": args.open_sites,
        "ab_weeks": args.ab_weeks,
    }
    if args.wish_disruption:
        print(json.dumps(wish_disruption(blocks=blocks, budget=args.budget), indent=2))
        return 0
    if args.first_solution:
        found = first_solution(blocks=blocks, budget=args.budget, **rules)
        print(json.dumps(found, indent=None if not args.json else 2))
        return 0 if found["status"] in {"FEASIBLE", "OPTIMAL"} else 1
    result = run(blocks=blocks, budget=args.budget, **rules)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        verdict = "VALID" if not result["problems"] else f"INVALID ({result['problems']})"
        print(
            f"högstadium, {'with' if result['blocks'] else 'without'} blocks"
            f"{', teacher-day rules' if args.teacher_day_rules else ''}: "
            f"{result['status']}, {result['lessons']}/{result['requested']} lessons in "
            f"{result['elapsedSeconds']} s (budget {result['budgetSeconds']} s, load "
            f"{result['loadAverage']}), språkval åk 7 in {result['sprakvalSlotsOfYear7']} "
            f"slots, wishes kept {result['wishesKept']}/{result['wishes']}, {verdict}"
        )
        for problem in result["firstProblems"]:
            print(f"  - {problem}")
    if args.infeasible_days:
        # The point of the variant: a proof, not a timeout.
        return 0 if result["status"] == "INFEASIBLE" else 1
    return 0 if result["lessons"] and not result["problems"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
