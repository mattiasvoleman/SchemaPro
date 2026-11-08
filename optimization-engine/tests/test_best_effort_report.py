"""Bästa möjliga schema: the report is true, and a refusal names only hard rules, on weeks nobody chose.

THE REVIEW OF #285 (MEDEL-2) found four branches of the engine's report and
refusal that no test held: a mutant of each survived tests/test_best_effort.py's
82 tests, and three of them gave false reports when changed.

    1. a day the school's own lesson already holds counts against "at most N a
       day" (relaxation.py, `allowed = max(0, per_day - locked[day])`);
    2. a lesson on the SAME day as a locked one is not "too close" in "days
       apart" (`0 < abs(first - locked_day) < apart`);
    3. of two alternating weeks the report keeps the one the rule is broken most
       in (`_worst_week`), not the least;
    4. a week the hard rules alone cannot hold is explained on THE HARD PART of
       the week (`_explain_infeasible(hard, ...)`), so the refusal never names a
       rule that, in this mode, gives way, in phase 1a and (second round of the
       review) in phase 1b;
    5. the zero floor of "at most N a day" (second round): lessons the school
       locked on a day beyond N are not the generated lessons' breach.

THE WEEKS ARE THE REVIEWER'S SEEDS (10008, 10011, 10007 and 20025), small
random weeks from the generator below, solved with one worker and a fixed seed,
and the ids are drawn from the same random stream, so a week is the same week
every run. Each is checked by a VALIDATOR WRITTEN FROM THE RULES' OWN TEXT (the
field comments of app/schemas/schedule.py), not from relaxation.py's counting:
the hard rules on the timetable that came back, then each of the five rules
counted again from the lessons and compared with `deviations` in both
directions (a reported breach is there; a breach there is reported).

Each seed also asserts that the week EXERCISES its branch, so a change in the
solver's choice of timetable cannot turn the test into one that passes for the
wrong reason: if the returned timetable no longer has a lesson on a locked day,
the test says so instead of passing.
"""

from __future__ import annotations

import random
from collections import Counter, defaultdict
from typing import Any
from uuid import UUID

import pytest

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse, ScheduledLesson
from app.solver.scheduler_solver import SchedulerSolver

WEEKS = ("ODD_WEEKS", "EVEN_WEEKS")
KINDS = ("CAP", "DAYS", "PERDAY", "APART", "LOCK")


def _id(ids: random.Random) -> str:
    return str(UUID(int=ids.getrandbits(128), version=4))


def _hm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def _clock(value: str) -> int:
    hours, minutes, _ = value.split(":")
    return int(hours) * 60 + int(minutes)


def make_week(seed: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """The reviewer's generator: a small week with the five rules, A/B lessons, co-teachers and locked lessons."""
    # Two streams: the week's shape is `rng`'s alone, as in the review's runs
    # (its ids were uuid4), and the ids come from a stream of their own so the
    # week is the same week every run.
    rng = random.Random(seed)
    ids = random.Random(f"ids-{seed}")
    days = rng.choice(["1,2,3", "1,2", "1,2,3,4"])
    day_end = rng.choice([600, 660, 720])
    teachers = [_id(ids) for _ in range(rng.randint(1, 3))]
    groups = [_id(ids) for _ in range(rng.randint(2, 3))]
    subjects = [_id(ids) for _ in range(rng.randint(2, 4))]
    rooms = [_id(ids) for _ in range(rng.randint(1, 3))]
    requirements: list[dict[str, Any]] = []
    for _ in range(rng.randint(2, 6)):
        row: dict[str, Any] = {
            "id": _id(ids),
            "subjectId": rng.choice(subjects),
            "studentGroupId": rng.choice(groups),
            "teacherId": rng.choice(teachers),
            "lessonsPerWeek": rng.randint(1, 4),
            "minutesPerLesson": rng.choice([40, 60]),
            "studentGroupSize": 24,
            "minGradeLevel": 7,
            "maxGradeLevel": 7,
        }
        if rng.random() < 0.3:
            row["recurrence"] = rng.choice(["ODD_WEEKS", "EVEN_WEEKS"])
        if len(teachers) > 1 and rng.random() < 0.2:
            row["coTeacherId"] = rng.choice([t for t in teachers if t != row["teacherId"]])
        if rng.random() < 0.45:
            row["maxLessonsPerDay"] = rng.choice([1, 1, 2])
        if rng.random() < 0.35:
            row["minDaysBetween"] = rng.choice([2, 2, 3])
        requirements.append(row)
    payload: dict[str, Any] = {
        "requestId": _id(ids),
        "academicYearId": _id(ids),
        "requirements": requirements,
        "rooms": [{"id": room, "capacity": 30} for room in rooms],
        "relaxation": {"mode": "BEST_EFFORT"},
    }
    rules = [
        {"id": _id(ids), "teacherId": teacher, "maxTeachingMinutesPerDay": rng.choice([60, 80, 100, 120, 160])}
        for teacher in teachers
        if rng.random() < 0.6
    ]
    if rules:
        payload["teacherWorkRules"] = rules
    day_list = [int(day) for day in days.split(",")]
    fixed: list[dict[str, Any]] = []
    for row in requirements:
        if rng.random() < 0.3 and row["lessonsPerWeek"] > 1 and "coTeacherId" not in row:
            day = rng.choice(day_list)
            start = 480 + 60 * rng.randint(0, max(0, (day_end - 480) // 60 - 1))
            fixed.append({
                "id": _id(ids), "teacherId": row["teacherId"], "studentGroupId": row["studentGroupId"],
                "dayOfWeek": day, "startTime": _hm(start), "endTime": _hm(start + row["minutesPerLesson"]),
            })
            row["lockedDays"] = [day]
    limits = []
    for teacher in teachers:
        if rng.random() < 0.35:
            locked = sorted({item["dayOfWeek"] for item in fixed if item["teacherId"] == teacher})
            limits.append({
                "id": _id(ids), "teacherId": teacher,
                "maxTeachingDaysPerWeek": rng.choice([1, 1, 2]), "lockedWeekdays": [locked],
            })
    if limits:
        payload["teacherDayLimits"] = limits
    if fixed:
        payload["fixedLessons"] = fixed
    preferences = [
        {"id": _id(ids), "subjectId": subject, "roomIds": rng.sample(rooms, 1), "kind": "LOCK"}
        for subject in sorted({row["subjectId"] for row in requirements})
        if rng.random() < 0.35 and len(rooms) >= 2
    ]
    if preferences:
        payload["roomPreferences"] = preferences
    constraints = []
    if rng.random() < 0.3:
        constraints.append({
            "id": _id(ids), "resourceKind": "TEACHER", "resourceId": rng.choice(teachers),
            "dayOfWeek": rng.choice(day_list), "startTime": "08:00:00", "endTime": _hm(day_end),
            "kind": "UNAVAILABLE",
        })
    if rng.random() < 0.3:
        constraints.append({
            "id": _id(ids), "resourceKind": "ROOM", "resourceId": rng.choice(rooms),
            "dayOfWeek": rng.choice(day_list), "startTime": "08:00:00", "endTime": _hm(day_end),
            "kind": "UNAVAILABLE",
        })
    if constraints:
        payload["constraints"] = constraints
    return payload, {"SCHEDULE_DAYS": days, "SCHEDULE_DAY_END_MINUTES": day_end}


def solve(seed: int, *, probes: bool = False) -> tuple[dict[str, Any], dict[str, Any], OptimizeScheduleResponse]:
    payload, env = make_week(seed)
    payload["search"] = {"maxSeconds": 12, "workers": 1, "seed": seed, "probes": probes}
    response = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=12.0, **env)).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )
    return payload, env, response


# ---------------------------------------------------------------------------
# The validator: the rules as their field comments say them
# ---------------------------------------------------------------------------


def _meets(first: str | None, second: str | None) -> bool:
    """Two lessons meet unless they sit in opposed weeks (None is every week)."""
    return not (first and second and first != second)


def _in_week(recurrence: str | None, week: str) -> bool:
    return recurrence is None or recurrence == week


def _teachers_of(requirement: dict[str, Any]) -> list[str]:
    return [item for item in (requirement["teacherId"], requirement.get("coTeacherId")) if item]


def hard_violations(payload: dict[str, Any], lessons: list[ScheduledLesson], day_end: int) -> list[str]:
    bad: list[str] = []
    requirements = {row["id"]: row for row in payload["requirements"]}
    placed = Counter(str(lesson.requirement_id) for lesson in lessons)
    for rid, row in requirements.items():
        if placed.get(rid, 0) != row["lessonsPerWeek"]:
            bad.append(f"count {rid[:6]} {placed.get(rid, 0)} != {row['lessonsPerWeek']}")
    items: list[tuple[set[tuple[str, str]], int, int, int, str | None, str]] = []
    for lesson in lessons:
        row = requirements[str(lesson.requirement_id)]
        start, end = _clock(lesson.start_time), _clock(lesson.end_time)
        if end - start != row["minutesPerLesson"]:
            bad.append(f"length {end - start}")
        if start < 480 or end > day_end:
            bad.append(f"outside the day {lesson.start_time}-{lesson.end_time}")
        who = {("T", teacher) for teacher in _teachers_of(row)} | {("G", row["studentGroupId"])}
        if lesson.room_id is not None:
            who.add(("R", str(lesson.room_id)))
        items.append((who, lesson.day_of_week, start, end, row.get("recurrence"), "generated"))
    for item in payload.get("fixedLessons", []):
        who = {("G", item["studentGroupId"])}
        if item.get("teacherId"):
            who.add(("T", item["teacherId"]))
        if item.get("roomId"):
            who.add(("R", item["roomId"]))
        items.append((
            who, item["dayOfWeek"], _clock(item["startTime"]), _clock(item["endTime"]),
            item.get("recurrence"), "locked",
        ))
    for index, first in enumerate(items):
        for second in items[index + 1:]:
            if first[5] == "locked" and second[5] == "locked":
                continue
            if first[1] == second[1] and first[2] < second[3] and second[2] < first[3] \
                    and _meets(first[4], second[4]) and first[0] & second[0]:
                bad.append(f"double booking on day {first[1]}")
    for constraint in payload.get("constraints", []):
        if constraint["kind"] != "UNAVAILABLE":
            continue
        for lesson in lessons:
            row = requirements[str(lesson.requirement_id)]
            hit = (
                (constraint["resourceKind"] == "TEACHER" and constraint["resourceId"] in _teachers_of(row))
                or (
                    constraint["resourceKind"] == "ROOM" and lesson.room_id is not None
                    and str(lesson.room_id) == constraint["resourceId"]
                )
            )
            if hit and lesson.day_of_week == constraint["dayOfWeek"]:
                start, end = _clock(lesson.start_time), _clock(lesson.end_time)
                if start < _clock(constraint["endTime"]) and end > _clock(constraint["startTime"]):
                    bad.append(f"unavailable {constraint['resourceKind']} on day {constraint['dayOfWeek']}")
    return bad


def independent_deviations(payload: dict[str, Any], lessons: list[ScheduledLesson]) -> dict[str, set[Any]]:
    """What the timetable breaks of the five rules, counted from the rules' own words."""
    requirements = {row["id"]: row for row in payload["requirements"]}
    out: dict[str, set[Any]] = {kind: set() for kind in KINDS}
    fixed = payload.get("fixedLessons", [])

    for rule in payload.get("teacherWorkRules", []):
        cap = rule.get("maxTeachingMinutesPerDay")
        worst: dict[int, int] = {}
        for week in WEEKS:
            generated: dict[int, int] = defaultdict(int)
            for lesson in lessons:
                row = requirements[str(lesson.requirement_id)]
                if _in_week(row.get("recurrence"), week) and rule["teacherId"] in _teachers_of(row):
                    generated[lesson.day_of_week] += _clock(lesson.end_time) - _clock(lesson.start_time)
            for day, minutes in generated.items():
                spans = [
                    (_clock(item["startTime"]), _clock(item["endTime"]))
                    for item in fixed
                    if rule["teacherId"] in (item.get("teacherId"), item.get("coTeacherId"))
                    and item["dayOfWeek"] == day and _in_week(item.get("recurrence"), week)
                ]
                locked = 0
                last = -1
                for start, end in sorted(spans):
                    start = max(start, last)
                    if end > start:
                        locked += end - start
                        last = end
                over = min(minutes, minutes + locked - cap)
                if over > 0:
                    worst[day] = max(worst.get(day, 0), over)
        for day, over in worst.items():
            out["CAP"].add((rule["id"], day, over))

    for limit in payload.get("teacherDayLimits", []):
        teacher = limit["teacherId"]
        worst_days = 0
        for week in WEEKS:
            generated_days = {
                lesson.day_of_week for lesson in lessons
                if _in_week(requirements[str(lesson.requirement_id)].get("recurrence"), week)
                and teacher in _teachers_of(requirements[str(lesson.requirement_id)])
            }
            locked_days = {
                item["dayOfWeek"] for item in fixed
                if teacher in (item.get("teacherId"), item.get("coTeacherId"))
                and _in_week(item.get("recurrence"), week)
            }
            if not generated_days:
                continue
            over = min(
                len(generated_days - locked_days),
                len(generated_days | locked_days) - limit["maxTeachingDaysPerWeek"],
            )
            worst_days = max(worst_days, over)
        if worst_days > 0:
            out["DAYS"].add((limit["id"], worst_days))

    per_day: dict[tuple[str, int], int] = defaultdict(int)
    days_of: dict[str, set[int]] = defaultdict(set)
    for lesson in lessons:
        per_day[(str(lesson.requirement_id), lesson.day_of_week)] += 1
        days_of[str(lesson.requirement_id)].add(lesson.day_of_week)
    for rid, row in requirements.items():
        locked = Counter(row.get("lockedDays", []))
        cap = row.get("maxLessonsPerDay")
        if cap:
            for (requirement, day), count in per_day.items():
                if requirement == rid:
                    over = min(count, count + locked[day] - cap)
                    if over > 0:
                        out["PERDAY"].add((rid, day, over))
        apart = row.get("minDaysBetween")
        if apart and days_of.get(rid):
            used = sorted(days_of[rid])
            too_close = any(b - a < apart for index, a in enumerate(used) for b in used[index + 1:])
            # A lesson on the very day a locked one holds is not "too close": the distance is nothing.
            too_close = too_close or any(
                0 < abs(day - locked_day) < apart for day in used for locked_day in set(row.get("lockedDays", []))
            )
            if too_close:
                out["APART"].add(rid)

    for preference in payload.get("roomPreferences", []):
        if preference["kind"] != "LOCK":
            continue
        for lesson in lessons:
            row = requirements[str(lesson.requirement_id)]
            if row["subjectId"] == preference["subjectId"] and (
                lesson.room_id is None or str(lesson.room_id) not in preference["roomIds"]
            ):
                out["LOCK"].add(str(lesson.requirement_id))
    return out


def reported(response: OptimizeScheduleResponse) -> dict[str, set[Any]]:
    out: dict[str, set[Any]] = {kind: set() for kind in KINDS}
    for detail in response.deviations or []:
        params = detail.params
        if detail.code == "DEVIATION_TEACHER_DAILY_CAP":
            out["CAP"].add((params["rule"], params["day"], params["over"]))
        elif detail.code == "DEVIATION_TEACHER_WORK_DAYS":
            out["DAYS"].add((params["limit"], params["over"]))
        elif detail.code == "DEVIATION_SUBJECT_PER_DAY":
            out["PERDAY"].add((params["requirement"], params["day"], params["over"]))
        elif detail.code == "DEVIATION_SUBJECT_DAYS_APART":
            out["APART"].add(params["requirement"])
        elif detail.code == "DEVIATION_ROOM_LOCK":
            out["LOCK"].add(params["requirement"])
    return out


def _the_report_is_true_and_complete(
    payload: dict[str, Any], env: dict[str, Any], response: OptimizeScheduleResponse,
) -> dict[str, set[Any]]:
    assert response.status in ("OPTIMAL", "FEASIBLE"), response.status
    assert hard_violations(payload, response.lessons, env["SCHEDULE_DAY_END_MINUTES"]) == []
    truth = independent_deviations(payload, response.lessons)
    said = reported(response)
    for kind in KINDS:
        assert said[kind] == truth[kind], f"{kind}: reported {sorted(map(str, said[kind]))}, true {sorted(map(str, truth[kind]))}"
    return truth


class TestTheReportOnWeeksNobodyChose:
    def test_a_day_a_locked_lesson_holds_counts_against_at_most_n_a_day(self) -> None:
        # Seed 10008. A requirement with a locked lesson on a day and "at most
        # N a day": the generated lessons may add only N minus the locked ones
        # on that day, and the model priced exactly that. A report that forgot
        # the locked lesson left out a breach the model had paid for.
        payload, env, response = solve(10008)
        truth = _the_report_is_true_and_complete(payload, env, response)
        requirements = {row["id"]: row for row in payload["requirements"]}
        on_a_locked_day = [
            item for item in truth["PERDAY"] if item[1] in requirements[item[0]].get("lockedDays", [])
        ]
        assert on_a_locked_day, "the week no longer breaks a per-day cap on a day a locked lesson holds"

    def test_a_lesson_on_the_day_of_a_locked_one_is_not_too_close_in_days_apart(self) -> None:
        # Seed 10011. "Days apart" measures from the locked lesson's day, and
        # the same day is distance nothing, not distance too small: a lesson
        # beside the locked one on its own day breaks the per-day cap, if any,
        # and not the spacing. A report that called it too close named a
        # breach the strict model would never see.
        payload, env, response = solve(10011)
        truth = _the_report_is_true_and_complete(payload, env, response)
        requirements = {row["id"]: row for row in payload["requirements"]}
        days = defaultdict(set)
        for lesson in response.lessons:
            days[str(lesson.requirement_id)].add(lesson.day_of_week)
        beside_a_locked_lesson = [
            rid for rid, row in requirements.items()
            if row.get("minDaysBetween") and row.get("lockedDays") and set(row["lockedDays"]) & days[rid]
        ]
        assert beside_a_locked_lesson, "the week no longer puts a lesson on the day of a locked one"
        # None of those is reported only because of that very day.
        for rid in beside_a_locked_lesson:
            row = requirements[rid]
            used = sorted(days[rid])
            closer = any(b - a < row["minDaysBetween"] for index, a in enumerate(used) for b in used[index + 1:])
            near_locked = any(
                0 < abs(day - locked) < row["minDaysBetween"] for day in used for locked in set(row["lockedDays"])
            )
            assert (rid in truth["APART"]) == (closer or near_locked)

    def test_of_two_alternating_weeks_the_report_keeps_the_worse(self) -> None:
        # Seed 10007. A requirement in odd weeks only and another in even weeks
        # only, one teacher, one cap: the day is over the cap in both weeks,
        # by different amounts, and the school is told the larger.
        payload, env, response = solve(10007)
        _the_report_is_true_and_complete(payload, env, response)
        requirements = {row["id"]: row for row in payload["requirements"]}
        by_week: dict[tuple[str, int], dict[str, int]] = defaultdict(dict)
        for rule in payload.get("teacherWorkRules", []):
            for lesson in response.lessons:
                row = requirements[str(lesson.requirement_id)]
                if rule["teacherId"] not in _teachers_of(row):
                    continue
                minutes = _clock(lesson.end_time) - _clock(lesson.start_time)
                for week in WEEKS:
                    if _in_week(row.get("recurrence"), week):
                        key = (rule["id"], lesson.day_of_week)
                        by_week[key][week] = by_week[key].get(week, 0) + minutes
        said = {(rule, day): over for rule, day, over in reported(response)["CAP"]}
        caps = {rule["id"]: rule["maxTeachingMinutesPerDay"] for rule in payload["teacherWorkRules"]}
        differing = [
            key for key, weeks in by_week.items()
            if len({max(0, minutes - caps[key[0]]) for minutes in weeks.values()}) > 1
            and max(weeks.values()) > caps[key[0]]
        ]
        assert differing, "the week no longer has a teacher day over its cap by different amounts in the two weeks"
        for key in differing:
            worst = max(max(0, minutes - caps[key[0]]) for minutes in by_week[key].values())
            assert said[key] >= worst, (key, said[key], worst)


# What the refusal of a hard rule is called, and what the five rules' refusals
# are called (app/messages.py): in this mode a refusal never has the second.
SOFT_REFUSALS = (
    "TEACHER_DAILY_CAP",
    "TEACHER_WORK_DAYS",
    "SUBJECT_DISTRIBUTION",
    "SUBJECT_PER_DAY",
    "SUBJECT_DAYS_APART",
    "ROOM_LOCK",
)


class TestTheRefusalOnWeeksNobodyChose:
    def test_a_week_the_hard_rules_cannot_hold_is_explained_on_the_hard_part_of_it(self) -> None:
        # Seed 20025, probes on (the lead call of a run): a teacher or a room
        # unavailable where the lessons must go, so the hard rules alone cannot
        # hold the week and the model proves it. The proof is explained on
        # `strip(request)`, the week without the five rules, so the refusal
        # names the hard rule that stopped it. Explained on the whole week it
        # named a cap or a distribution that, in this mode, gives way, and the
        # web told the school "a rule that never gives way" about one that does.
        payload, _, response = solve(20025, probes=True)
        assert response.status == "INFEASIBLE"
        assert response.deviations is None and response.lessons == []
        assert response.conflicts is not None
        codes = [response.conflicts.summary_code, *(detail.code for detail in response.conflicts.conflicts)]
        # The week carries rules of the five kinds, so the whole-week
        # explanation had them to name.
        assert any(row.get("maxLessonsPerDay") or row.get("minDaysBetween") for row in payload["requirements"]) \
            or payload.get("teacherWorkRules") or payload.get("teacherDayLimits")
        assert {detail.code for detail in response.conflicts.conflicts} == {
            "AVAIL_CONSTRAINT_BLOCKS_LESSONS", "ROOM_NO_ROOM_FOR_REQUIREMENT",
        }
        for code in codes:
            assert not any(code.startswith(soft) for soft in SOFT_REFUSALS), codes

    @pytest.mark.parametrize("seed", [20025, 20056, 20079, 20081])
    def test_the_same_when_phase_one_a_gets_no_time_and_phase_one_b_proves_it(
        self, seed: int, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # The second `_explain_infeasible(hard, ...)` (second round of the
        # review, LÅG-R2-4). Phase 1a is given no time, so the week is proved
        # impossible by phase 1b, which explains it by its own call. In
        # production the road needs phase 1a to run out its 60 seconds with no
        # answer first, so it is rare, and its consequence is the one of the
        # first call: a refusal that names a rule that gives way.
        monkeypatch.setattr(SchedulerSolver, "CLEAN_SAT_CAP_SECONDS", 0.0)
        _, _, response = solve(seed, probes=True)
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        names = {detail.code for detail in response.conflicts.conflicts}
        assert names == {"AVAIL_CONSTRAINT_BLOCKS_LESSONS", "ROOM_NO_ROOM_FOR_REQUIREMENT"}, names
        for code in [response.conflicts.summary_code, *names]:
            assert not any(code.startswith(soft) for soft in SOFT_REFUSALS), code


class TestTheFloorOfAtMostNADay:
    def test_lessons_locked_beyond_the_cap_are_not_the_generated_lesson_s_breach(self) -> None:
        # Second round of the review, LÅG-R2-5. "At most one a day", two lessons
        # the school locked on Monday (already two, a fact) and one generated
        # lesson on the only day there is: the generated lesson adds ONE over
        # the cap, not two. Without the floor at zero (`per_day - locked[day]`
        # is -1) the report said two, a number nothing the school could change
        # would explain.
        teacher, locked_teacher, group, subject, room = (str(UUID(int=n, version=4)) for n in range(1, 6))
        locks = [
            {
                "id": str(UUID(int=10 + hour, version=4)), "teacherId": locked_teacher, "studentGroupId": group,
                "dayOfWeek": 1, "startTime": f"{8 + hour:02d}:00:00", "endTime": f"{9 + hour:02d}:00:00",
            }
            for hour in range(2)
        ]
        payload = {
            "requestId": str(UUID(int=20, version=4)),
            "academicYearId": str(UUID(int=21, version=4)),
            "requirements": [{
                "id": str(UUID(int=22, version=4)), "subjectId": subject, "studentGroupId": group, "teacherId": teacher,
                "lessonsPerWeek": 1, "minutesPerLesson": 60, "studentGroupSize": 24, "minGradeLevel": 7,
                "maxGradeLevel": 7, "maxLessonsPerDay": 1, "lockedDays": [1, 1],
            }],
            "rooms": [{"id": room, "capacity": 30}],
            "fixedLessons": locks,
            "relaxation": {"mode": "BEST_EFFORT"},
        }
        response = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=10.0, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720)).solve(
            OptimizeScheduleRequest.model_validate(payload),
        )
        assert response.status in ("OPTIMAL", "FEASIBLE")
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_SUBJECT_PER_DAY"
        assert {key: detail.params[key] for key in ("maxPerDay", "count", "over", "needed")} == {
            "maxPerDay": 1, "count": 3, "over": 1, "needed": 3,
        }
