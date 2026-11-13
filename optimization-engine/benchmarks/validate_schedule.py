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
    group overlap     one student group, one place at a time, and two groups
                      sharing a pupil (groupConflicts) never at once — the
                      group of a lesson being the pupils who sit it: its
                      pupilGroupId (a lock's pupilGroupIds) when it carries
                      one (Ersättande grupper: 7A's svenska sat by 7A without
                      SvA7, whom SvA may run beside), else its own group;
                      the lunch and the cap per day stay the class's
    room overlap      one room, one lesson at a time
    room eligibility  capacity >= group size, and required type matches
    availability      no lesson inside a recurring UNAVAILABLE window — every
                      kind of row, including the year reservations that name no
                      resource, and every window, including the whole-day ones
                      written 00:00-23:59
    lunch             a free contiguous window inside the lunch window, per
                      day, for each group the request says eats — the groups it
                      names, or every group with requirements when it names
                      none — except where a recurring rule holds that whole
                      window free for the class, which is the school saying
                      the class is not in the building
    max per day       lessons per group per day within the configured cap
    distribution      a requirement's own rule (ämnesfördelning): at most its
                      number of lessons on any weekday, and no two weekdays
                      with its lessons closer than its rule allows — the
                      lessons the school locked counted from `lockedDays`,
                      since they come back in no response
    blocks            the requirements of one parallel block (språkval,
                      elevens val) at the same times: each member's lessons
                      placed on the same weekdays, starts and ends as the
                      first member's
    delade lektioner  a requirement split between leads (lessonTeacherIds):
                      every placed lesson names its lead, and the (lead,
                      length) pairs placed are the pairs requested — each
                      lesson's teacher is then read off the lesson, by every
                      check here that reads a teacher, see _lesson_teachers
    teacher's day     Lärarens dag: per teacher, lead and co-teacher alike,
                      the minutes of teaching on each weekday within their
                      work rule's cap — the union of every lesson's own
                      clock span, the locked ones from `fixedLessons`
                      included — and the weekdays they teach on within their
                      post's limit in every week `lockedWeekdays` names; what
                      the school locked judged as the engine is held to it,
                      see _teacher_day_problems
    (stretches)       Sammanhängande undervisning is a WISH the generator tries
                      to keep, so a stretch over a teacher's limit is never a
                      problem here: stretch_breaches counts them, for the
                      benchmark that measures how many the generator leaves
    travel            Restid i generatorn: between two lessons one party
                      shares on one weekday, at least the school's minutes
                      for the pair of skolområden their rooms stand on — the
                      pupils' margins added — see _travel_problems
    weeks             A/B-veckor: every check above is a check on a real
                      week, so a request with a requirement or a lock on odd
                      or even ISO weeks only is checked once per week — that
                      week's lessons and locks, the every-week ones in both —
                      and a problem says the week it was found in. Slöjd
                      udda veckor and hemkunskap jämna veckor in one hour of
                      one class, teacher or room are no clash. See _weeks
    periods           Terminer: the same for a request whose requirements or
                      locks name the periods of the year they run in
                      (`periods`) — once per period, and per parity within it
                      where the request has one, with what runs there. The
                      autumn's hemkunskap and the spring's in one hour of one
                      teacher and one room are no clash, and each period's
                      lessons are held to every rule on their own

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
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "validate-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")


def _pupils_of(requirement):
    """Who sits the requirement's lessons: its pupilGroupId, else its group.

    Ersättande grupper, re-read from the request: the pupils' checks (overlap,
    the pairs, the walk) key a lesson by who sits it, the class's checks
    (lunch, the cap per day, a reservation) by the group it is filed under.
    """
    return getattr(requirement, "pupil_group_id", None) or requirement.student_group_id


def _lock_pupils(fixed) -> set:
    """Who sits a locked lesson: its pupilGroupIds, else the groups it names."""
    pupils = getattr(fixed, "pupil_group_ids", None)
    if pupils is not None:
        return set(pupils)
    return {fixed.student_group_id, *fixed.extra_group_ids}


def _lesson_slots(grid, requirement, lesson):
    """How long this placed lesson runs, in slots.

    A uniform requirement's lessons all run its one length, as they always
    have. A split one (lessonLengths, 1 × 80 + 1 × 40) is read off the lesson's
    own start and end, and the multiset check below holds the engine to the
    lengths it was sent.
    """
    if requirement.lesson_lengths is None:
        return grid.minutes_to_slots(requirement.minutes_per_lesson)
    # The end by the clock and not by parse_hhmmss, which reads a START and
    # refuses the day's own end: a lesson ending as the day does is a lesson
    # of the day, and the within-day check below holds it there.
    return grid.minutes_to_slots(_clock(lesson.end_time) - _clock(lesson.start_time))


def _lesson_lead(requirement, lesson):
    """The placed lesson's lead: its own for a split requirement, the row's otherwise."""
    if requirement.lesson_teacher_ids is None:
        return requirement.teacher_id
    return lesson.teacher_id


def _lesson_teachers(requirement, lesson) -> set:
    """Everybody on the placed lesson: its lead and the row's co-teacher."""
    return {_lesson_lead(requirement, lesson), requirement.co_teacher_id} - {None}


def _occupied(grid, day_of_week, start_time, duration_slots):
    """Absolute slot indices a lesson occupies, plus its day-relative start."""
    day_idx = grid.day_index(day_of_week)
    start_slot = grid.parse_hhmmss(start_time)
    abs_start = day_idx * grid.slots_per_day + start_slot
    return day_idx, start_slot, list(range(abs_start, abs_start + duration_slots))


def _recurring_windows(grid, constraint) -> list[tuple[int, int, int]]:
    """A recurring rule as (day index, first slot, last slot + 1) windows.

    ONE READING OF A ROW for this whole file. Two would eventually disagree
    about which half hour a school reserved, and the lunch exemption below
    turns on the same times the availability check enforces.

    THE TIMES ARE FOLDED ONTO THE GRID, not parsed strictly, and that is the
    difference between checking a rule and skipping it. `parse_hhmmss` is right
    for the times an administrator types into a lesson: strict, because the
    typist can be told to correct them. These are availability windows, and a
    school writes those in whole days — this product's own full-day closure is
    00:00-23:59, see `isFullDay` in calendar.service.ts, and the seed ships a
    teacher rule of 12:00-23:59. Neither lands inside an 08:00-18:00 grid, so
    strict parsing raised, the loop moved on, and the rule went unchecked. In a
    checker that is the worst possible failure: a skipped rule and an enforced
    one both come out as silence, and silence here is read as a pass.

    Folding is what the times mean anyway — "unavailable until 23:59" says the
    rest of the school day — and it is how the engine reads them, so agreeing
    is not borrowing: a window this file could not read is one the engine
    rejects outright, which means no timetable exists to check.

    A row naming no weekday names EVERY teaching day. A window that misses the
    school day altogether closes nothing and yields nothing. Dated rows are the
    caller's to skip: the timetable is one generic week.
    """
    try:
        low = grid.clamp_to_grid(constraint.start_time)
        high = grid.clamp_to_grid(constraint.end_time)
    except ValueError:
        return []
    if low is None or high is None or high <= low:
        return []

    days = (
        (constraint.day_of_week,)
        if constraint.day_of_week is not None
        else grid.schedule_days
    )
    windows: list[tuple[int, int, int]] = []
    for day in days:
        try:
            windows.append((grid.day_index(day), low, high))
        except ValueError:
            # A weekday outside the configured week reserves nothing in it.
            continue
    return windows


def _grade_span(constraint) -> str:
    """How a year reservation names itself, having no resource id to print.

    A violation that ends in "GRADE_LEVEL None" tells a school nothing about
    which of its reservations it broke.
    """
    low = constraint.min_grade_level
    high = constraint.max_grade_level
    if low is None and high is None:
        return "all years"
    if low is None:
        return f"up to year {high}"
    if high is None:
        return f"from year {low}"
    return f"year {low}" if low == high else f"years {low}-{high}"


def _reached_by(constraint, requirement, lesson) -> bool:
    """Whether a reservation reaches this lesson, by the rule that wrote it.

    GRADE_LEVEL is the one that names no resource, and the one this file used
    to drop on the floor: it fell out of the ownership lookup below with an
    empty tuple and was never checked against anything. One such row holds a
    whole stage free — "åk 4-6 är lediga 11:30" — rather than fanning sixty
    group rows out of a payload capped at five thousand.

    OVERLAP, not containment. A group spanning years 6-7 has year-6 pupils in
    it, so a reservation for years 4-6 reaches it: holding a few year-7 pupils
    free costs the timetable a little room, while letting the lesson stand puts
    year-6 pupils in a classroom during time the school reserved for them. A
    group whose own years are unknown is reached by nothing, because "overlaps"
    has no answer without them, and a missing bound on the row is open at that
    end — "up to year 3" and "from year 7" are both how a school says stage.
    """
    if constraint.resource_kind == "GRADE_LEVEL":
        if requirement.min_grade_level is None or requirement.max_grade_level is None:
            return False
        below = (
            constraint.min_grade_level is not None
            and requirement.max_grade_level < constraint.min_grade_level
        )
        above = (
            constraint.max_grade_level is not None
            and requirement.min_grade_level > constraint.max_grade_level
        )
        return not (below or above)

    owner = {
        "TEACHER": tuple(_lesson_teachers(requirement, lesson)),
        "STUDENT_GROUP": (requirement.student_group_id,),
        "ROOM": (lesson.room_id,),
    }.get(constraint.resource_kind, ())
    return constraint.resource_id is not None and constraint.resource_id in owner


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

    The times are read by _recurring_windows, folded onto the grid, exactly as
    the availability loop in validate() reads them: one reading, so the window
    this excuses is the window that loop enforces. Strict parsing would fail
    here in the loud direction rather than the silent one — a row this cannot
    read becomes a missing break it reports. Schools write "away all day" as
    00:00-23:59 — this product's own full-day closure, see isFullDay in
    calendar.service.ts — and strict parsing rejects both ends of exactly the
    rule this exists for. A window that misses the school day altogether still
    constrains nothing and is dropped.

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
        for day_index, c_lo, c_hi in _recurring_windows(grid, constraint):
            if c_lo <= window_start and c_hi >= window_end:
                exempt.add((constraint.resource_id, day_index))

    return exempt


def _distribution_problems(request, placed_weekdays) -> list[str]:
    """Each requirement's ämnesfördelning, re-read from the request.

    BY WEEKDAY, the way a school reads its week: a cap is a count per weekday,
    and "not on consecutive days" compares the weekdays' own numbers, so
    Friday and Monday are four apart and a week of Monday, Wednesday and
    Friday has no two days in a row.

    THE LOCKED LESSONS ARE IN THE WEEK, and the reason this check exists in
    this form. They come back in no response — the engine plans around them
    and returns only what it placed — and they carry no requirement id on the
    way in either, so a check over the response alone would pass a Monday the
    solver added beside a locked Monday under "one a day". `lockedDays` is
    where the request says they are.

    WHAT THE SCHOOL LOCKED IS NOT JUDGED ON ITS OWN. Two locked lessons on one
    Monday were a hand edit, warned about when it was made; the engine is held
    to every lesson it PLACED. So only a weekday the solver placed a lesson on
    is counted — locked lessons and all, which is the whole point — and a pair
    of days is too close only when the solver placed a lesson on at least one
    of them.
    """
    problems: list[str] = []
    for requirement in request.requirements:
        cap = requirement.max_lessons_per_day
        apart = requirement.min_days_between
        if cap is None and apart is None:
            continue
        placed = Counter(placed_weekdays.get(requirement.id, []))
        locked = Counter(requirement.locked_days)
        if cap is not None:
            for weekday in sorted(placed):
                total = placed[weekday] + locked[weekday]
                if total > cap:
                    problems.append(
                        f"requirement {requirement.id}: {total} lessons on weekday "
                        f"{weekday} ({locked[weekday]} locked), its rule allows {cap} a day")
        if apart is not None:
            weekdays = sorted(set(placed) | set(locked))
            for index, first in enumerate(weekdays):
                for second in weekdays[index + 1:]:
                    if second - first >= apart:
                        continue
                    if first not in placed and second not in placed:
                        continue
                    problems.append(
                        f"requirement {requirement.id}: lessons on weekdays {first} and "
                        f"{second}, its rule wants lesson days at least {apart} apart")
    return problems


def _block_problems(request, lessons) -> list[str]:
    """Parallella block, re-read from the request.

    Requirements that carry the same blockId are one block when there are two
    or more of them; one alone constrains nothing, as the engine reads it. Each
    member's placements are compared as a sorted list of (weekday, start, end),
    so the check asks what a school sees — Tyska and Franska on the same
    Monday 09:00-10:00 — and not which lesson index the engine held to which.
    """
    members: dict = defaultdict(list)
    for requirement in request.requirements:
        if requirement.block_id is not None:
            members[requirement.block_id].append(requirement.id)
    placed: dict = defaultdict(list)
    for lesson in lessons:
        placed[lesson.requirement_id].append(
            (lesson.day_of_week, lesson.start_time, lesson.end_time))
    problems: list[str] = []
    for block_id, ids in members.items():
        if len(ids) < 2:
            continue
        first = sorted(placed.get(ids[0], []))
        for other in ids[1:]:
            times = sorted(placed.get(other, []))
            if times != first:
                problems.append(
                    f"block {block_id}: requirement {other} placed at {times}, "
                    f"requirement {ids[0]} at {first}")
    return problems


def _clock(value: str) -> int:
    """'HH:MM' or 'HH:MM:SS' as minutes since midnight — this file's own reading."""
    parts = value.split(":")
    return int(parts[0]) * 60 + int(parts[1])


def _union_minutes(spans) -> int:
    """Minutes the [start, end) spans cover together, an overlap counted once."""
    total = 0
    reach = None
    for start, end in sorted(span for span in spans if span[1] > span[0]):
        if reach is None or start > reach[1]:
            if reach is not None:
                total += reach[1] - reach[0]
            reach = [start, end]
        else:
            reach[1] = max(reach[1], end)
    if reach is not None:
        total += reach[1] - reach[0]
    return total


def _teacher_day_problems(request, lessons) -> list[str]:
    """Lärarens dag — a teacher's cap a day and their post's days — re-read from the request.

    THE SAME DEFINITION AS THE GATEWAY'S, NOT THE ENGINE'S CODE: every lesson
    the teacher is on, as lead or as co-teacher, counted in its own clock
    minutes from the lesson's start to its end, and a day's minutes the union
    of those spans, so two lessons that overlap count their overlap once.
    src/common/teacher-day.ts is that definition, and its fixture is replayed
    against this function in the engine's tests; nothing here is borrowed
    from the model builder, which is the point of the file.

    THE LOCKED LESSONS ARE IN THE WEEK, at their own clock times from
    `fixedLessons` — they come back in no response — and WHAT THE SCHOOL
    LOCKED IS NOT JUDGED ON ITS OWN, the distribution check's reading. A
    weekday is held to the cap only if the solver placed a lesson on it, and
    then with every locked minute on that weekday counted, an odd week's
    beside an even week's: the strict reading, as the engine's.

    THE DAYS ARE COUNTED IN EACH WEEK THE POST NAMES. The request has no
    weeks, so `lockedWeekdays` is what says which locks are taught together
    — each set the weekdays one real week's locks hold — and every lesson
    the solver placed runs every week. Each week is held to the larger of
    the post's limit and the days its own locks take: a week the school
    locked on four days of a three-day post broke the limit by hand, and the
    solver is held to adding no fifth to it. Every set the request carries
    is read, the ones the engine leaves out as implied included, so a wrong
    proof there is a red line here.
    """
    caps: dict = defaultdict(list)
    for rule in request.teacher_work_rules:
        if rule.max_teaching_minutes_per_day is not None:
            caps[rule.teacher_id].append((rule.id, rule.max_teaching_minutes_per_day))
    limits = {
        limit.teacher_id: (limit.id, limit.max_teaching_days_per_week, limit.locked_weekdays)
        for limit in request.teacher_day_limits
    }
    if not caps and not limits:
        return []

    req_by_id = {r.id: r for r in request.requirements}
    placed: dict = defaultdict(lambda: defaultdict(list))
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        span = (_clock(lesson.start_time), _clock(lesson.end_time))
        for teacher in _lesson_teachers(requirement, lesson):
            placed[teacher][lesson.day_of_week].append(span)
    locked: dict = defaultdict(lambda: defaultdict(list))
    for fixed in request.fixed_lessons:
        span = (_clock(fixed.start_time), _clock(fixed.end_time))
        if span[1] <= span[0]:
            continue
        for teacher in {fixed.teacher_id, fixed.co_teacher_id} - {None}:
            locked[teacher][fixed.day_of_week].append(span)

    problems: list[str] = []
    for teacher, rules in caps.items():
        for weekday in sorted(placed.get(teacher, {})):
            minutes = _union_minutes(
                placed[teacher][weekday] + locked.get(teacher, {}).get(weekday, []))
            for rule_id, cap in rules:
                if minutes > cap:
                    problems.append(
                        f"teacher work rule {rule_id}: {minutes} minutes of teaching on "
                        f"weekday {weekday}, its rule allows {cap} a day")
    for teacher, (limit_id, most, weeks) in limits.items():
        taught = set(placed.get(teacher, {}))
        for week in weeks:
            held = set(week)
            days = len(taught | held)
            if days > max(most, len(held)):
                where = f": weekdays {', '.join(map(str, sorted(held)))}" if held else ""
                problems.append(
                    f"teacher post {limit_id}: teaching on {days} days a week "
                    f"({len(held)} of them locked{where}), its post allows {most}")
    return problems


def _teacher_lunch_problems(grid, request, lessons) -> list[str]:
    """A teacher's own lunch (a work rule's lunch trio), re-read from the request's words.

    A teacher a rule names, with a lesson the solver placed in this week, is
    owed on every school day a gap of `lunchMinutes` inside the window
    `lunchStartTime`-`lunchEndTime`, clear of every lesson they are on — a
    placed one, or one locked in this week — and of what the school has
    reserved for them (an UNAVAILABLE reservation of the teacher's). A day
    reserved across the whole window owes none: the teacher is not there.

    BY THE CLOCK AND WITHOUT MARGINS, which is the lenient reading on every
    count: the engine rounds the window inward to its grid and a lock
    outward, and keeps the break clear of the minutes around a lesson. Each
    of those can only take a start away, so a week the engine laid has a gap
    here, and a week with no gap here has none there either.

    THE WEEK IS THIS REQUEST'S: validate() calls with one real week's lessons
    and locks, so a lesson of the autumn is not in the way of the spring's
    lunch — and the odd weeks' are not in the way of the even weeks', which
    the engine is stricter about and this file has no reason to be.
    """
    rules = [
        rule for rule in request.teacher_work_rules
        if rule.lunch_minutes and rule.lunch_start_time and rule.lunch_end_time
    ]
    if not rules:
        return []
    req_by_id = {r.id: r for r in request.requirements}
    busy: dict = defaultdict(lambda: defaultdict(list))
    placed_on: set = set()
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        for teacher in _lesson_teachers(requirement, lesson):
            placed_on.add(teacher)
            busy[teacher][lesson.day_of_week].append((_clock(lesson.start_time), _clock(lesson.end_time)))
    for fixed in request.fixed_lessons:
        for teacher in {fixed.teacher_id, fixed.co_teacher_id} - {None}:
            busy[teacher][fixed.day_of_week].append((_clock(fixed.start_time), _clock(fixed.end_time)))
    closed: dict = defaultdict(lambda: defaultdict(list))
    for constraint in request.constraints:
        if constraint.resource_kind != "TEACHER" or constraint.kind != "UNAVAILABLE":
            continue
        days = [constraint.day_of_week] if constraint.day_of_week is not None else grid.schedule_days
        for day in days:
            closed[constraint.resource_id][day].append(
                (_clock(constraint.start_time), _clock(constraint.end_time)))

    problems: list[str] = []
    for rule in rules:
        teacher = rule.teacher_id
        if teacher not in placed_on:
            continue
        low = max(_clock(rule.lunch_start_time), grid.day_start_minutes)
        high = min(_clock(rule.lunch_end_time), grid.day_end_minutes)
        for weekday in grid.schedule_days:
            away = closed.get(teacher, {}).get(weekday, [])
            if _union_minutes([(max(low, a), min(high, b)) for a, b in away]) >= high - low:
                continue
            taken = sorted(
                (max(low, a), min(high, b))
                for a, b in busy.get(teacher, {}).get(weekday, []) + away
                if min(high, b) > max(low, a)
            )
            longest, reach = 0, low
            for start, end in taken:
                longest = max(longest, start - reach)
                reach = max(reach, end)
            longest = max(longest, high - reach)
            if longest < rule.lunch_minutes:
                problems.append(
                    f"teacher work rule {rule.id}: no {rule.lunch_minutes}-minute lunch inside "
                    f"{rule.lunch_start_time[:5]}-{rule.lunch_end_time[:5]} on weekday {weekday} "
                    f"(longest gap {max(0, longest)} minutes)")
    return problems


def stretch_breaches(request, lessons) -> list[dict]:
    """Sammanhängande undervisning — every stretch of teaching longer than its teacher's limit.

    NOT A PROBLEM, A COUNT. The generator treats the limit as a wish
    (app/solver/consecutive.py) and refuses no week over it, so a stretch over
    the limit is a result and not a defect: the benchmark that measures the
    wish (benchmarks/consecutive_teaching.py) and the tests count them, and
    `validate` does not report them.

    THE GATEWAY'S DEFINITION, NOT THE ENGINE'S CODE (src/common/stretch.ts):
    per teacher and weekday, every lesson the teacher is on — lead or
    co-teacher, placed or locked — in clock minutes, sorted by start. A lesson
    joins the stretch before it when it starts less than Y after that
    stretch's latest end; a stretch is first start to last end, the short gaps
    inside it counted, and it is over when it is longer than X. Replayed
    against src/common/__fixtures__/stretch-cases.json by the tests.

    Each breach is a dict: the teacher, the work rule's id, the weekday, the
    stretch's length in minutes, the limit and the break, and whether a lesson
    the solver placed is in it (a stretch of the school's locked lessons alone
    was its own doing, and the generator could do nothing about it).
    """
    rules = {
        rule.teacher_id: rule
        for rule in request.teacher_work_rules
        if rule.max_consecutive_teaching_minutes is not None
    }
    if not rules:
        return []
    req_by_id = {r.id: r for r in request.requirements}
    days: dict = defaultdict(lambda: defaultdict(list))
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None or lesson.requirement_id is None:
            continue
        span = (_clock(lesson.start_time), _clock(lesson.end_time), True)
        if span[1] <= span[0]:
            continue
        for teacher in _lesson_teachers(requirement, lesson):
            if teacher in rules:
                days[teacher][lesson.day_of_week].append(span)
    for fixed in request.fixed_lessons:
        span = (_clock(fixed.start_time), _clock(fixed.end_time), False)
        if span[1] <= span[0]:
            continue
        for teacher in {fixed.teacher_id, fixed.co_teacher_id} - {None}:
            if teacher in rules:
                days[teacher][fixed.day_of_week].append(span)

    breaches: list[dict] = []
    for teacher, rule in rules.items():
        limit = rule.max_consecutive_teaching_minutes
        pause = rule.consecutive_break_minutes
        for weekday in sorted(days.get(teacher, {})):
            stretch = None  # [first start, latest end, holds a placed lesson]
            found = []
            for start, end, placed in sorted(
                days[teacher][weekday], key=lambda span: (span[0], span[1]),
            ):
                if stretch is not None and start - stretch[1] < pause:
                    stretch[1] = max(stretch[1], end)
                    stretch[2] = stretch[2] or placed
                else:
                    if stretch is not None:
                        found.append(stretch)
                    stretch = [start, end, placed]
            if stretch is not None:
                found.append(stretch)
            for first, last, placed in found:
                if last - first > limit:
                    breaches.append({
                        "teacher": teacher, "rule": rule.id, "weekday": weekday,
                        "minutes": last - first, "limit": limit, "break": pause,
                        "placed": placed,
                    })
    return breaches


def _travel_problems(request, lessons) -> list[str]:
    """Restid i generatorn: the walk between two skolområden, re-read from the request.

    THE GATEWAY'S DEFINITION, NOT THE ENGINE'S CODE (src/common/site-travel.ts):
    a walk is counted between two lessons on one weekday whose rooms stand on
    two different sites the school gave a figure above zero. A room on no
    site, an unknown room and a pair with no figure count nothing. Every pair
    of lessons one party shares is read, not only neighbours: wherever the
    figures keep the triangle inequality the two are the same rule, and the
    engine promises the stricter one.

    WHO WALKS: a teacher between their lessons (lead or co-teacher); the
    pupils between two lessons of one group, and between a lesson of a group
    and one of a group sharing a pupil with it (groupConflicts), a lesson's
    group being the pupils who sit it (_pupils_of, _lock_pupils). For pupils
    the walk comes after the earlier lesson's minutesAfter and before the
    later one's minutesBefore — a class showers, changes, then walks. A
    locked lesson is in the day at its own clock times and room, and two
    locked lessons are never read against each other: what the school locked
    is not judged on its own.

    THE RAW FIGURE, NOT THE STEP. The engine rounds a walk up to its start
    step; a timetable that keeps the rounded walk keeps the school's minutes,
    which is what this checks — the promise the hand-edit warning reads.
    """
    if not getattr(request, "site_travel_times", None):
        return []
    site_of = {room.id: room.site_id for room in request.rooms if room.site_id is not None}
    minutes = {
        frozenset((row.site_a_id, row.site_b_id)): row.minutes
        for row in request.site_travel_times
        if row.minutes > 0
    }
    if not minutes:
        return []
    req_by_id = {r.id: r for r in request.requirements}
    conflicts = defaultdict(set)
    for first, second in getattr(request, "group_conflicts", []) or []:
        conflicts[first].add(second)
        conflicts[second].add(first)

    # (weekday, start, end, site, teachers, groups, lead, trail, locked, label)
    entries = []
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        entries.append((
            lesson.day_of_week, _clock(lesson.start_time), _clock(lesson.end_time),
            site_of.get(lesson.room_id), _lesson_teachers(requirement, lesson),
            {_pupils_of(requirement)}, requirement.minutes_before,
            requirement.minutes_after, False, f"lesson {lesson.requirement_id}",
        ))
    for fixed in request.fixed_lessons:
        entries.append((
            fixed.day_of_week, _clock(fixed.start_time), _clock(fixed.end_time),
            site_of.get(fixed.room_id), {fixed.teacher_id, fixed.co_teacher_id} - {None},
            _lock_pupils(fixed), 0, 0, True,
            f"locked lesson {fixed.id}",
        ))

    problems: list[str] = []
    for i, first in enumerate(entries):
        for second in entries[i + 1:]:
            if first[8] and second[8]:
                continue
            if first[0] != second[0] or first[3] is None or second[3] is None:
                continue
            walk = minutes.get(frozenset((first[3], second[3])))
            if walk is None or first[3] == second[3]:
                continue
            early, late = (first, second) if first[1] <= second[1] else (second, first)
            gap = late[1] - early[2]
            if early[4] & late[4] and gap < walk:
                problems.append(
                    f"teacher walk {early[9]} -> {late[9]} on weekday {early[0]}: "
                    f"{gap} min between, the walk takes {walk}")
            shares_pupils = bool(early[5] & late[5]) or any(
                other in conflicts[group] for group in early[5] for other in late[5]
            )
            if shares_pupils and gap - early[7] - late[6] < walk:
                problems.append(
                    f"pupils' walk {early[9]} -> {late[9]} on weekday {early[0]}: "
                    f"{gap - early[7] - late[6]} min between their margins, the walk "
                    f"takes {walk}")
    return problems


def _weeks(request):
    """The request once per real week, or None when nothing alternates.

    Read off the request here and not taken from the engine, which this file
    shares no code with: a requirement or a lock with `recurrence` ODD_WEEKS
    runs in the odd week, EVEN_WEEKS in the even one, and one without it in
    both. Each week's request holds what runs in it, made every-week.

    Terminer: an entry with `periods` runs in the periods its mask marks and
    one without in every one, so a request with masks is one week per period
    — and per parity inside it, where the request has a parity. A period
    holding exactly the entries of an earlier one is the same week and is
    checked once.

    A week is named as the engine's own answers name it: "period 0" is the
    first, the index a refusal's `period` carries (weeks.named), so a line
    here and a line of a response are about the same weeks.
    """
    entries = [*request.requirements, *request.fixed_lessons]
    alternating = any(entry.recurrence for entry in entries)
    masks = [entry.periods for entry in entries if entry.periods is not None]
    if not alternating and not masks:
        return None
    parities = (
        (("ODD_WEEKS", "udda veckor"), ("EVEN_WEEKS", "jämna veckor"))
        if alternating
        else ((None, ""),)
    )
    periods = range(len(masks[0])) if masks else (None,)
    weeks = []
    seen = set()
    for period in periods:
        for week, parity_label in parities:
            def runs(entry, period=period, week=week) -> bool:
                if week is not None and entry.recurrence not in (None, week):
                    return False
                return period is None or entry.periods is None or entry.periods[period]

            every_week = {"recurrence": None, "periods": None}
            requirements = [r.model_copy(update=every_week) for r in request.requirements if runs(r)]
            fixed_lessons = [f.model_copy(update=every_week) for f in request.fixed_lessons if runs(f)]
            key = (tuple(r.id for r in requirements), tuple(f.id for f in fixed_lessons))
            if period is not None and key in seen:
                continue
            seen.add(key)
            label = ", ".join(
                part for part in (
                    f"period {period}" if period is not None else "", parity_label,
                ) if part
            )
            weeks.append((label, request.model_copy(update={
                "requirements": requirements, "fixed_lessons": fixed_lessons,
                "teacher_day_limits": _limits_of_period(request, period, week),
                "period_weeks": None,
            })))
    return weeks


def _limits_of_period(request, period, parity=None):
    """The posts' days as one period's weeks hold them: the sets that period is named for.

    `lockedWeekdayPeriods`, where a limit carries it, says for each set of
    locked weekdays which periods have a week with exactly that set, and in
    which parity (`recurrence`; none is both). A week of period p in a parity
    is then held to the sets marked for p and for its parity, and to no other
    term's or parity's; a limit without it holds every set in every week, as
    it did.
    """
    if period is None:
        return request.teacher_day_limits
    return [
        limit if limit.locked_weekday_periods is None else limit.model_copy(update={
            "locked_weekdays": [
                list(entry.weekdays) for entry in limit.locked_weekday_periods
                if entry.periods[period] and (parity is None or entry.recurrence in (None, parity))
            ],
            "locked_weekday_periods": None,
        })
        for limit in request.teacher_day_limits
    ]


def validate(grid, request, lessons) -> list[str]:
    """Return a list of rule violations; empty means the timetable is valid."""
    weeks = _weeks(request)
    if weeks is None:
        return _validate_week(grid, request, lessons)
    problems: list[str] = []
    seen: set[str] = set()
    known = {r.id for r in request.requirements}
    for lesson in lessons:
        if lesson.requirement_id not in known:
            problems.append(f"lesson names unknown requirement {lesson.requirement_id}")
    # Whose day a lesson is part of is the year's question, not a week's: a
    # class with no lesson of its own in one term is a class all the same.
    classes = _classes_with_lessons(request)
    for label, week in weeks:
        ids = {r.id for r in week.requirements}
        for problem in _validate_week(
            grid, week, [lesson for lesson in lessons if lesson.requirement_id in ids],
            classes=classes,
        ):
            if problem not in seen:
                seen.add(problem)
                problems.append(f"{problem} ({label})")
    return problems


def _shared_rooms_of(request) -> dict:
    """The shareable rooms of a school that turned regel 3 on, by id, with their capacity."""
    rules = request.placement_rules
    if rules is None or rules.shared_rooms is None:
        return {}
    return {
        room.id: room.capacity
        for room in request.rooms
        if room.shareable and room.capacity is not None
    }


def _classes_with_lessons(request) -> list:
    """The classes that have a day: the request's groups some requirement is filed under."""
    filed = {requirement.student_group_id for requirement in request.requirements}
    return [group.id for group in getattr(request, "groups", None) or [] if group.id in filed]


def _lock_window(grid, fixed):
    """A locked lesson as (weekday index, first slot of the day, slot after its last).

    By the clock: every slot the lock's minutes touch, whether or not it
    starts and ends on the grid, and only the part of it inside the school
    day. None for a lock on a weekday the school does not teach, or wholly
    outside the day: it holds nothing a lesson could stand on.
    """
    try:
        day_idx = grid.day_index(fixed.day_of_week)
    except ValueError:
        return None
    start_minutes = _clock(fixed.start_time) - grid.day_start_minutes
    end_minutes = _clock(fixed.end_time) - grid.day_start_minutes
    start = max(0, start_minutes // grid.slot_minutes)
    end = min(grid.slots_per_day, -(-end_minutes // grid.slot_minutes))
    if end <= start:
        return None
    return day_idx, start, end


def _lock_problems(grid, request, lessons) -> list[str]:
    """A placed lesson against the locked lessons of the same week.

    A lock is a lesson somebody placed by hand, and it holds its teacher, its
    co-teacher, its pupils and its room as any lesson does. The engine was
    told so (fixedLessons); this re-reads it. Only a GENERATED lesson against
    a lock: two locks on one hour are the school's own doing and no answer of
    the engine's. A room the school marked shareable is counted by its seats
    below and not here.
    """
    problems: list[str] = []
    spd = grid.slots_per_day
    req_by_id = {r.id: r for r in request.requirements}
    shared_rooms = _shared_rooms_of(request)
    partners: dict = defaultdict(set)
    for first_id, second_id in getattr(request, "group_conflicts", []) or []:
        partners[first_id].add(second_id)
        partners[second_id].add(first_id)
    held = []
    for fixed in request.fixed_lessons:
        window = _lock_window(grid, fixed)
        if window is None:
            continue
        day_idx, start, end = window
        pupils = _lock_pupils(fixed)
        held.append((
            day_idx * spd + start,
            day_idx * spd + end,
            {fixed.teacher_id, getattr(fixed, "co_teacher_id", None)} - {None},
            pupils | {partner for pupil in pupils for partner in partners.get(pupil, ())},
            fixed.room_id if fixed.room_id not in shared_rooms else None,
            fixed.id,
        ))
    if not held:
        return problems
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        try:
            duration = _lesson_slots(grid, requirement, lesson)
            _, _, slots = _occupied(grid, lesson.day_of_week, lesson.start_time, duration)
        except ValueError:
            continue
        if not slots:
            continue
        first, last = slots[0], slots[-1] + 1
        for lock_start, lock_end, teachers, pupils, room_id, lock_id in held:
            if not (first < lock_end and lock_start < last):
                continue
            for teacher in sorted(_lesson_teachers(requirement, lesson) & teachers, key=str):
                problems.append(
                    f"teacher {teacher} has lesson {lesson.requirement_id} on locked lesson "
                    f"{lock_id} at absolute slots {max(first, lock_start)}-{min(last, lock_end)}")
            if _pupils_of(requirement) in pupils:
                problems.append(
                    f"pupils of {_pupils_of(requirement)} have lesson {lesson.requirement_id} on "
                    f"locked lesson {lock_id} at absolute slots "
                    f"{max(first, lock_start)}-{min(last, lock_end)}")
            if room_id is not None and lesson.room_id == room_id:
                problems.append(
                    f"room {room_id} has lesson {lesson.requirement_id} on locked lesson "
                    f"{lock_id} at absolute slots {max(first, lock_start)}-{min(last, lock_end)}")
    return problems


def _edge_problems(grid, request, lessons, classes=None) -> list[str]:
    """Placeringsregel 1 when it is HARD: a marked subject neither opens nor closes a class's day.

    In this file's own reading of the rule's words. A CLASS'S DAY is every
    lesson and every locked lesson its pupils sit that weekday: the class's
    own, and those of any group that shares pupils with it (groupConflicts).
    A group that is no class's and shares pupils with none is its own class.
    NOT FIRST: something else of that day starts earlier. NOT LAST: something
    else of it ends later. Asked of every class the lesson's pupils belong to,
    in the week this request is.
    """
    rules = getattr(request, "placement_rules", None)
    edges = getattr(rules, "subject_edges", None) if rules is not None else None
    if edges is None or edges.mode != "HARD":
        return []
    marked = {row.subject_id: (row.not_first, row.not_last) for row in edges.subjects}
    if classes is None:
        classes = _classes_with_lessons(request)
    partners: dict = defaultdict(set)
    for first_id, second_id in getattr(request, "group_conflicts", []) or []:
        partners[first_id].add(second_id)
        partners[second_id].add(first_id)

    def days_of(pupils) -> list:
        owners = [c for c in classes if c == pupils or c in partners.get(pupils, ())]
        return owners or [pupils]

    spd = grid.slots_per_day
    req_by_id = {r.id: r for r in request.requirements}
    day: dict[tuple, list[tuple[int, int, object]]] = defaultdict(list)
    placed = []
    for index, lesson in enumerate(lessons):
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        try:
            duration = _lesson_slots(grid, requirement, lesson)
            day_idx, start, _ = _occupied(grid, lesson.day_of_week, lesson.start_time, duration)
        except ValueError:
            continue
        owners = days_of(_pupils_of(requirement))
        for class_id in owners:
            day[(class_id, day_idx)].append((start, start + duration, ("lesson", index)))
        placed.append((index, lesson, requirement, owners, day_idx, start, start + duration))
    for fixed in request.fixed_lessons:
        window = _lock_window(grid, fixed)
        if window is None:
            continue
        day_idx, start, end = window
        owners = {class_id for pupils in _lock_pupils(fixed) for class_id in days_of(pupils)}
        for class_id in owners:
            day[(class_id, day_idx)].append((start, end, ("lock", fixed.id)))

    problems: list[str] = []
    for index, lesson, requirement, owners, day_idx, start, end in placed:
        wanted = marked.get(requirement.subject_id)
        if wanted is None:
            continue
        for class_id in owners:
            others = [(s, e) for s, e, tag in day[(class_id, day_idx)] if tag != ("lesson", index)]
            if wanted[0] and not any(s < start for s, _ in others):
                problems.append(
                    f"lesson {lesson.requirement_id} of a subject that must not be first opens "
                    f"the day of {class_id} (weekday index {day_idx}, slot {start} of {spd})")
            if wanted[1] and not any(e > end for _, e in others):
                problems.append(
                    f"lesson {lesson.requirement_id} of a subject that must not be last closes "
                    f"the day of {class_id} (weekday index {day_idx}, slot {end} of {spd})")
    return problems


def _validate_week(grid, request, lessons, classes=None) -> list[str]:
    """validate() on one week: every lesson of `request` runs in it."""
    problems: list[str] = []
    spd = grid.slots_per_day

    req_by_id = {r.id: r for r in request.requirements}
    rooms_by_id = {r.id: r for r in request.rooms}

    busy: dict[str, dict] = {
        "teacher": defaultdict(dict),
        "student group": defaultdict(dict),
        "room": defaultdict(dict),
    }
    # Placeringsregler, regel 3: a room the school marked shareable holds
    # several lessons at once, and what it may not do is seat more pupils than
    # it has (checked below, for the HARD rule). Every other room is exclusive.
    shared_rooms = _shared_rooms_of(request)
    seated: dict[tuple, int] = defaultdict(int)
    per_group_day: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    placed_by_requirement: dict = defaultdict(int)
    placed_lengths: dict = defaultdict(list)
    placed_leads: dict = defaultdict(list)
    placed_weekdays: dict = defaultdict(list)

    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            problems.append(f"lesson names unknown requirement {lesson.requirement_id}")
            continue
        placed_by_requirement[requirement.id] += 1
        placed_weekdays[requirement.id].append(lesson.day_of_week)

        try:
            duration = _lesson_slots(grid, requirement, lesson)
            placed_lengths[requirement.id].append(duration * grid.slot_minutes)
            placed_leads[requirement.id].append(
                (str(_lesson_lead(requirement, lesson)), duration * grid.slot_minutes))
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
            ("teacher", _lesson_lead(requirement, lesson)),
            ("student group", _pupils_of(requirement)),
            ("room", lesson.room_id),
        ):
            if resource is None:
                continue
            if kind == "room" and resource in shared_rooms:
                for slot in slots:
                    seated[(resource, slot)] += requirement.student_group_size
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

    if request.placement_rules and request.placement_rules.shared_rooms:
        hard = request.placement_rules.shared_rooms.mode == "HARD"
        for fixed in request.fixed_lessons:
            if fixed.room_id in shared_rooms and fixed.student_count is not None:
                try:
                    first = grid.absolute_start(fixed.day_of_week, grid.parse_hhmmss(fixed.start_time))
                    last = grid.absolute_start(fixed.day_of_week, grid.parse_hhmmss(fixed.end_time))
                except ValueError:
                    continue
                for slot in range(first, last):
                    seated[(fixed.room_id, slot)] += fixed.student_count
        if hard:
            for (room_id, slot), pupils in seated.items():
                if pupils > shared_rooms[room_id]:
                    problems.append(
                        f"shared room {room_id} seats {pupils} pupils at absolute slot {slot}, "
                        f"capacity {shared_rooms[room_id]}")
                    break

    # Every requested lesson must be placed exactly as many times as requested.
    for requirement in request.requirements:
        want = requirement.lessons_per_week
        got = placed_by_requirement.get(requirement.id, 0)
        if got != want:
            problems.append(
                f"requirement {requirement.id}: {got} lessons placed, {want} requested")
        elif requirement.lesson_lengths is not None:
            placed = sorted(placed_lengths.get(requirement.id, []), reverse=True)
            if placed != list(requirement.lesson_minutes()):
                problems.append(
                    f"requirement {requirement.id}: lessons of {placed} minutes placed, "
                    f"{list(requirement.lesson_minutes())} requested")
        if got == want and requirement.lesson_teacher_ids is not None:
            requested = sorted(
                (str(lead), minutes)
                for lead, minutes in zip(requirement.lesson_teacher_ids,
                                         requirement.lesson_minutes())
            )
            if sorted(placed_leads.get(requirement.id, [])) != requested:
                problems.append(
                    f"requirement {requirement.id}: (lead, minutes) "
                    f"{sorted(placed_leads.get(requirement.id, []))} placed, {requested} requested")

    # A generated lesson never stands on a locked lesson of its teacher, its
    # pupils or its room, in the week both run in.
    problems.extend(_lock_problems(grid, request, lessons))

    # Placeringsregel 1, when the school made it hard.
    problems.extend(_edge_problems(grid, request, lessons, classes))

    # Group-conflict pairs (groups sharing students) must never overlap.
    lessons_by_group: dict = defaultdict(list)
    for lesson in lessons:
        requirement = req_by_id.get(lesson.requirement_id)
        if requirement is None:
            continue
        try:
            duration = _lesson_slots(grid, requirement, lesson)
            day_idx, start_slot, _ = _occupied(
                grid, lesson.day_of_week, lesson.start_time, duration)
        except ValueError:
            continue
        lessons_by_group[_pupils_of(requirement)].append(
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
        windows = _recurring_windows(grid, constraint)
        if not windows:
            continue
        for lesson in lessons:
            requirement = req_by_id.get(lesson.requirement_id)
            if requirement is None:
                continue
            if not _reached_by(constraint, requirement, lesson):
                continue
            try:
                duration = _lesson_slots(grid, requirement, lesson)
                day_idx, start_slot, _ = _occupied(
                    grid, lesson.day_of_week, lesson.start_time, duration)
            except ValueError:
                continue
            for c_day, c_lo, c_hi in windows:
                if day_idx != c_day:
                    continue
                if start_slot < c_hi and c_lo < start_slot + duration:
                    # The row's own times, not the folded slots: a school
                    # looking for "00:00-23:59" will not find "08:00-18:00".
                    problems.append(
                        f"lesson {lesson.requirement_id} overlaps UNAVAILABLE window "
                        f"{constraint.start_time}-{constraint.end_time} for "
                        f"{constraint.resource_kind} "
                        f"{constraint.resource_id or _grade_span(constraint)}")

    problems.extend(_distribution_problems(request, placed_weekdays))
    problems.extend(_block_problems(request, lessons))
    problems.extend(_teacher_day_problems(request, lessons))
    problems.extend(_teacher_lunch_problems(grid, request, lessons))
    problems.extend(_travel_problems(request, lessons))

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
