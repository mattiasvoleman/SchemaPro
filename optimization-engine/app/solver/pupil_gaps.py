"""Elevernas håltimmar: the pupils' idle time, counted and kept down.

Two things live here, and they answer one question two ways.

THE COUNT (pupil_idle_minutes) is the håltimmesrapport's own number, read off
a finished timetable: for every set of pupils booked alike (a cohort, see
PupilGapCohort), every day, the holes between their first and last lesson that
are neither a lesson, nor time a rule closes, nor lunch, at least
MINIMUM_GAP_MINUTES long, times the pupils sitting in them. It is
web/lib/gaps.ts findIdleGaps added up the way web/lib/candidates/idle.ts adds
it up (standardWeekPupilMinutes over the year's classes), line for line:

    lessons     the cohort's lessons, widened by the pupils' ombyte before and
                dusch after (minutesBefore/minutesAfter; fixedMargins for a
                locked lesson), merged; the first and the last bound the day
    closed      a weekly UNAVAILABLE row on one of the cohort's groups, or a
                GRADE_LEVEL row reaching one of their years; and the hours a
                ramtid closes for those years. Closed time is not a hole and
                never bounds the day
    lunch       the school's lunch window, credited once a day in clock
                order: each hole takes as much of the window as it overlaps,
                until the lunch's minutes are used up
    minimum     a hole whose minutes, less its lunch, are under 15 is a rast

src/common/__fixtures__/pupil-gaps-cases.json is the contract: the web replays
it through findIdleGaps, the gateway through the cohorts it sends, and
tests/test_pupil_gaps.py through this function.

THE OBJECTIVE (build_pupil_gap_objective) is what CP-SAT minimises when the
school turns the rule on. Per cohort and day:

    idle >= (last - first) - occupied - lunch - closed

with `first` and `last` the pupils' own day — every key of the cohort,
which is the whole of "elevens faktiska dag": the home class, the teaching
groups, the halves and the replacing groups, read in the pupil space exactly
as the no-overlap rules read it (pupil_key_of). A class is never one body
here: 7A's fourteen outside Ma71 and its sixteen inside it are two cohorts,
each with its own day, which is why a span-minus-taught term per GROUP was
refused for years (see _add_idle_time_objective) and this one is not.

WHERE THE OBJECTIVE AND THE COUNT PART, said once and measured in the PR:

    a hole under 15 minutes   counted by the objective, never by the count.
                              Which holes are short is a question about the
                              lesson after each one, and a successor per pair
                              of lessons is quadratic in every pupil's week
    lunch                     credited when the class's own placed lunch lies
                              inside the day; the count credits the window
    alternate weeks           the engine has no weeks: a locked odd-week
                              lesson is every week to both, and the report's
                              ordinary week halves it
    a locked lesson's margin  counted only by the count: the engine does not
                              keep a lock's ombyte either (FixedLessonMargin)

Every term is a lower bound pushed up to the truth by the objective, never a
rule: nothing here can make a week infeasible, and a school with the rule off
sends no pupilGaps and builds none of it.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence
    from uuid import UUID

    from ortools.sat.python import cp_model

    from app.schemas.schedule import (
        AnonymousConstraint,
        FixedLesson,
        FrameTime,
        OptimizeScheduleRequest,
        PupilGapCohort,
        ScheduledLesson,
    )

#: A hole shorter than this is the changeover between two lessons, a rast and
#: not a håltimme: web/lib/candidates/idle.ts IDLE_MINIMUM_MINUTES, the
#: report's default (DEFAULT_MINIMUM_GAP_MINUTES).
MINIMUM_GAP_MINUTES = 15

#: The objective's other terms are multiplied by this when the rule is on, and
#: a cohort pays weight_pupil_gap per pupil and slot: a whole class of this
#: many pupils then pays weight_pupil_gap × 25 a slot against a teacher's
#: weight_teacher_gap × 25. Integer weights per pupil need the other terms
#: scaled, not the pupils rounded — a cohort of one pupil rounded to a class's
#: weight would count twenty-five times over.
PUPIL_GAP_SCALE = 25

_DAY_MINUTES = 24 * 60


def _minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


# ---------------------------------------------------------------------------
# The count
# ---------------------------------------------------------------------------


def group_spans(request: OptimizeScheduleRequest) -> dict[UUID, tuple[int, int]]:
    """groupId -> its years: the payload's groups first, then each requirement's.

    The years the gateway derived from the pupils' home classes, as
    gradeSpanOf does on the web. A derived key has none and is never asked.
    """
    spans: dict[UUID, tuple[int, int]] = {}
    for group in request.groups:
        if group.min_grade_level is not None and group.max_grade_level is not None:
            spans[group.id] = (group.min_grade_level, group.max_grade_level)
    for requirement in request.requirements:
        if requirement.student_group_id in spans:
            continue
        if requirement.min_grade_level is not None and requirement.max_grade_level is not None:
            spans[requirement.student_group_id] = (
                requirement.min_grade_level, requirement.max_grade_level,
            )
    return spans


def _span_meets_rule(span: tuple[int, int] | None, constraint: AnonymousConstraint) -> bool:
    """lib/grade-span.ts spanMeetsRule: overlap, a null bound open."""
    if span is None:
        return False
    if constraint.min_grade_level is not None and span[1] < constraint.min_grade_level:
        return False
    return not (constraint.max_grade_level is not None and span[0] > constraint.max_grade_level)


def _frame_window(
    frames: Sequence[FrameTime], span: tuple[int, int], day: int,
) -> tuple[int, int] | None:
    """lib/frame-times.ts frameWindow: the intersection of the frames reaching the span."""
    start, end = 0, _DAY_MINUTES
    for frame in frames:
        if frame.day_of_week is not None and frame.day_of_week != day:
            continue
        if span[1] < frame.min_grade_level or span[0] > frame.max_grade_level:
            continue
        start = max(start, _minutes(frame.start_time))
        end = min(end, _minutes(frame.end_time))
    return (start, end) if end > start else None


def closed_minutes(
    request: OptimizeScheduleRequest,
    group_ids: Iterable[UUID],
    day: int,
    spans: dict[UUID, tuple[int, int]],
) -> list[tuple[int, int]]:
    """The minutes of one weekday a rule closes for a cohort's groups, unmerged.

    lib/gaps.ts collectBusy's closures: weekly UNAVAILABLE rows on a group or
    reaching its years, and the complement of each group's frame window. A
    group with no known years is reached by neither years nor frames.
    """
    groups = list(dict.fromkeys(group_ids))
    closures: list[tuple[int, int]] = []
    for constraint in request.constraints:
        if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
            continue
        if constraint.day_of_week is not None and constraint.day_of_week != day:
            continue
        if constraint.resource_kind == "STUDENT_GROUP":
            applies = constraint.resource_id is not None and constraint.resource_id in groups
        elif constraint.resource_kind == "GRADE_LEVEL":
            applies = any(_span_meets_rule(spans.get(group), constraint) for group in groups)
        else:
            applies = False
        start, end = _minutes(constraint.start_time), _minutes(constraint.end_time)
        if applies and start < end:
            closures.append((start, end))
    for group in groups:
        span = spans.get(group)
        if span is None:
            continue
        window = _frame_window(request.frame_times, span, day)
        if window is None:
            closures.append((0, _DAY_MINUTES))
            continue
        if window[0] > 0:
            closures.append((0, window[0]))
        if window[1] < _DAY_MINUTES:
            closures.append((window[1], _DAY_MINUTES))
    return closures


def _merged(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """lib/gaps.ts mergeIntervals: touching intervals join."""
    out: list[list[int]] = []
    for start, end in sorted(intervals, key=lambda interval: interval[0]):
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(start, end) for start, end in out]


def _free_between(busy: list[tuple[int, int]], low: int, high: int) -> list[tuple[int, int]]:
    """lib/gaps.ts freeBetween."""
    free: list[tuple[int, int]] = []
    cursor = low
    for start, end in busy:
        if start >= high:
            break
        if start > cursor:
            free.append((cursor, start))
        cursor = max(cursor, end)
        if cursor >= high:
            break
    if cursor < high:
        free.append((cursor, high))
    return free


def lunch_window(request: OptimizeScheduleRequest) -> tuple[int, int, int] | None:
    """lib/gaps.ts lunchWindowOf, on the rules the gateway sent: (start, end, minutes)."""
    rules = request.rules
    if (
        rules is None
        or rules.lunch_start_time is None
        or rules.lunch_end_time is None
        or rules.lunch_minutes is None
    ):
        return None
    start, end = _minutes(rules.lunch_start_time), _minutes(rules.lunch_end_time)
    if end <= start:
        return None
    return start, end, min(max(rules.lunch_minutes, 0), end - start)


def day_idle_minutes(
    lessons: list[tuple[int, int]],
    closures: list[tuple[int, int]],
    lunch: tuple[int, int, int] | None,
) -> int:
    """One cohort's idle minutes on one day: lib/gaps.ts holesInsideDay and creditLunch.

    `lessons` are the pupils' own intervals (margins included), `closures` the
    rules' (see closed_minutes). Holes are counted between the first lesson
    and the last; lunch is handed out in clock order, once; a hole whose
    remainder is under MINIMUM_GAP_MINUTES is a rast.
    """
    taught = _merged(interval for interval in lessons if interval[1] > interval[0])
    if not taught:
        return 0
    occupied = _merged([*taught, *closures])
    remaining = lunch[2] if lunch else 0
    idle = 0
    for start, end in _free_between(occupied, taught[0][0], taught[-1][1]):
        overlap = min(end, lunch[1]) - max(start, lunch[0]) if lunch else 0
        credit = min(max(overlap, 0), remaining)
        remaining -= credit
        if end - start - credit >= MINIMUM_GAP_MINUTES:
            idle += end - start - credit
    return idle


@dataclass
class _Margins:
    before: int = 0
    after: int = 0


@dataclass
class CohortWeek:
    """One cohort's lessons by weekday, in minutes, margins included."""

    cohort: PupilGapCohort
    by_day: dict[int, list[tuple[int, int]]] = field(default_factory=lambda: defaultdict(list))


def cohort_weeks(
    request: OptimizeScheduleRequest, lessons: Sequence[ScheduledLesson],
) -> list[CohortWeek]:
    """Every cohort's week in the timetable: the lessons placed and the locks it sits.

    A placed lesson is the cohort's when its requirement's pupil key is one of
    the cohort's keys (pupil_key_of: pupilGroupId, or the group); a lock is
    the cohort's when the cohort names it (fixedLessonIds).
    """
    gaps = request.pupil_gaps
    if gaps is None:
        return []
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    margins = {
        margin.fixed_lesson_id: _Margins(margin.minutes_before, margin.minutes_after)
        for margin in gaps.fixed_margins
    }
    fixed_by_id = {fixed.id: fixed for fixed in request.fixed_lessons}
    placed_by_key: dict[UUID, list[tuple[int, int, int]]] = defaultdict(list)
    for lesson in lessons:
        requirement = by_requirement.get(lesson.requirement_id)
        if requirement is None:
            continue
        key = requirement.pupil_group_id or requirement.student_group_id
        placed_by_key[key].append((
            lesson.day_of_week,
            _minutes(lesson.start_time) - requirement.minutes_before,
            _minutes(lesson.end_time) + requirement.minutes_after,
        ))
    weeks: list[CohortWeek] = []
    for cohort in gaps.cohorts:
        week = CohortWeek(cohort)
        for key in dict.fromkeys(cohort.group_ids):
            for day, start, end in placed_by_key.get(key, ()):
                week.by_day[day].append((start, end))
        for fixed_id in dict.fromkeys(cohort.fixed_lesson_ids):
            fixed = fixed_by_id.get(fixed_id)
            if fixed is None:
                continue
            margin = margins.get(fixed_id, _Margins())
            week.by_day[fixed.day_of_week].append((
                _minutes(fixed.start_time) - margin.before,
                _minutes(fixed.end_time) + margin.after,
            ))
        weeks.append(week)
    return weeks


def pupil_idle_minutes(
    request: OptimizeScheduleRequest, lessons: Sequence[ScheduledLesson],
) -> int | None:
    """Idle pupil-minutes in an ordinary week: the håltimmesrapport's number.

    None when the request carried no pupilGaps — the school has not turned
    the rule on, and its response says nothing it did not say before.
    """
    if request.pupil_gaps is None:
        return None
    spans = group_spans(request)
    lunch = lunch_window(request)
    total = 0
    for week in cohort_weeks(request, lessons):
        for day, intervals in week.by_day.items():
            closures = closed_minutes(request, week.cohort.group_ids, day, spans)
            total += week.cohort.pupils * day_idle_minutes(intervals, closures, lunch)
    return total


# ---------------------------------------------------------------------------
# The objective
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _KeyDay:
    """One pupil key's day: its one-sided ends and the slots its lessons fill."""

    first: cp_model.IntVar
    last: cp_model.IntVar
    occupied: cp_model.LinearExpr
    count: int


@dataclass
class PupilGapModel:
    """What the solver hands the builder: the grid and the lessons' own variables.

    `on(decision, day)` is the literal for "this lesson is on that day", None
    where its domain cannot reach the day; `reach(decision)` the absolute
    [a, b) slots it can occupy there, per day; `fixed_window(lock)` a lock's
    rounded window; `pupil_key(requirement)` scheduler_solver.pupil_key_of.
    """

    model: cp_model.CpModel
    slots_per_day: int
    slot_minutes: int
    day_start_minutes: int
    weekdays: Sequence[int]
    on: Callable[[object, int], cp_model.IntVar | None]
    reach: Callable[[object], dict[int, list[tuple[int, int]]]]
    fixed_window: Callable[[FixedLesson], tuple[int, int] | None]
    pupil_key: Callable[[object], UUID]
    lunch_starts: dict[tuple[UUID, int], cp_model.IntVar]
    lunch_slots: int
    weight: int
    _key_days: dict[tuple[UUID, int], _KeyDay | None] = field(default_factory=dict)
    _shared: dict[tuple[str, str], cp_model.IntVar] = field(default_factory=dict)
    _overlaps: dict[tuple[str, str, int], cp_model.IntVar | None] = field(default_factory=dict)
    _closure_overlaps: dict[tuple[str, int, int], cp_model.IntVar | None] = field(default_factory=dict)


def _lesson_span(decision: object) -> tuple[cp_model.LinearExpr, cp_model.LinearExpr]:
    """The pupils' interval of a lesson: [start - lead, end + trail), no corridor."""
    return decision.start - decision.lead, decision.end + decision.trail  # type: ignore[attr-defined]


def _pupil_reach(built: PupilGapModel, decision: object, day: int) -> list[tuple[int, int]]:
    """The absolute slots a lesson can keep its pupils busy on a day, margins included."""
    lead, trail = decision.lead, decision.trail  # type: ignore[attr-defined]
    return [(low - lead, high + trail) for low, high in built.reach(decision).get(day, ())]


def _meet(first: list[tuple[int, int]], second: list[tuple[int, int]]) -> bool:
    return any(a < d and c < b for a, b in first for c, d in second)


def _key_day(
    built: PupilGapModel, by_key: dict[UUID, list[object]], key: UUID, day: int,
) -> _KeyDay | None:
    """A pupil key's day, built once and shared by every cohort sitting it."""
    cache_key = (key, day)
    if cache_key in built._key_days:
        return built._key_days[cache_key]
    model = built.model
    base = day * built.slots_per_day
    lessons = [
        (decision, literal)
        for decision in by_key.get(key, ())
        if (literal := built.on(decision, day)) is not None
    ]
    if not lessons:
        built._key_days[cache_key] = None
        return None
    first = model.NewIntVar(base, base + built.slots_per_day, f"pg_first_{key}_{day}")
    last = model.NewIntVar(base, base + built.slots_per_day, f"pg_last_{key}_{day}")
    occupied: list[cp_model.LinearExpr] = []
    for decision, literal in lessons:
        start, end = _lesson_span(decision)
        model.Add(first <= start).OnlyEnforceIf(literal)
        model.Add(last >= end).OnlyEnforceIf(literal)
        length = decision.lead + decision.duration + decision.trail  # type: ignore[attr-defined]
        occupied.append(length * literal)
    day_of_key = _KeyDay(first, last, sum(occupied), len(lessons))
    built._key_days[cache_key] = day_of_key
    return day_of_key


def _overlap(
    built: PupilGapModel, first: object, second: object, day: int,
) -> cp_model.IntVar | None:
    """Slots two lessons of keys that may overlap share on `day`, at least.

    Sibling halves: an unplaced pupil sits both, and 7A:1's slöjd beside
    7A:2's NO is one hour of their day, not two. min/max exactly, so the
    overlap cannot be argued down; zero on any other day by the literal.
    """
    a, b = sorted(
        (first, second), key=lambda decision: decision.lesson.key(),  # type: ignore[attr-defined]
    )
    pair = (a.lesson.key(), b.lesson.key())  # type: ignore[attr-defined]
    cache_key = (*pair, day)
    if cache_key in built._overlaps:
        return built._overlaps[cache_key]
    on_a = built.on(a, day)
    if on_a is None or not _meet(_pupil_reach(built, a, day), _pupil_reach(built, b, day)):
        built._overlaps[cache_key] = None
        return None
    model = built.model
    shared = built._shared.get(pair)
    if shared is None:
        horizon = len(built.weekdays) * built.slots_per_day
        tag = f"pg_ov_{pair[0]}_{pair[1]}"
        (a_start, a_end), (b_start, b_end) = _lesson_span(a), _lesson_span(b)
        low = model.NewIntVar(-horizon, horizon, f"{tag}_lo")
        high = model.NewIntVar(-horizon, 2 * horizon, f"{tag}_hi")
        model.AddMaxEquality(low, [a_start, b_start])
        model.AddMinEquality(high, [a_end, b_end])
        shared = model.NewIntVar(0, built.slots_per_day, tag)
        model.AddMaxEquality(shared, [high - low, 0])
        built._shared[pair] = shared
    # The pair's overlap, charged to the day it happens on: zero on any other,
    # where the two cannot meet at all.
    today = model.NewIntVar(0, built.slots_per_day, f"pg_ov_{pair[0]}_{pair[1]}_{day}")
    model.Add(today >= shared).OnlyEnforceIf(on_a)
    built._overlaps[cache_key] = today
    return today


def _window_overlap(
    model: cp_model.CpModel,
    window: tuple[int, int],
    first: cp_model.LinearExpr,
    last: cp_model.LinearExpr,
    horizon: int,
    slots_per_day: int,
    tag: str,
) -> cp_model.IntVar:
    """Slots of a fixed window inside [first, last], exactly (the teachers' _protected_overlap)."""
    low = model.NewIntVar(0, horizon, f"{tag}_lo")
    high = model.NewIntVar(0, horizon, f"{tag}_hi")
    model.AddMaxEquality(low, [first, window[0]])
    model.AddMinEquality(high, [last, window[1]])
    inside = model.NewIntVar(0, slots_per_day, tag)
    model.AddMaxEquality(inside, [high - low, 0])
    return inside


def _closure_slots(
    built: PupilGapModel,
    request: OptimizeScheduleRequest,
    cohort: PupilGapCohort,
    day: int,
    spans: dict[UUID, tuple[int, int]],
) -> list[tuple[int, int]]:
    """The cohort's closed time on a day, in absolute slots, merged and rounded inward.

    Inward, because a closure is a CREDIT: rounding it outward would pay the
    pupils for minutes nobody closed.
    """
    weekday = built.weekdays[day]
    base = day * built.slots_per_day
    out: list[tuple[int, int]] = []
    for start, end in _merged(closed_minutes(request, cohort.group_ids, weekday, spans)):
        low = -(-(start - built.day_start_minutes) // built.slot_minutes)
        high = (end - built.day_start_minutes) // built.slot_minutes
        low, high = max(low, 0), min(high, built.slots_per_day)
        if high > low:
            out.append((base + low, base + high))
    return out


def build_pupil_gap_objective(
    built: PupilGapModel,
    request: OptimizeScheduleRequest,
    decisions: Sequence[object],
) -> list[cp_model.LinearExpr]:
    """The pupils' idle slots, cohort by cohort and day, each weighted by its pupils.

    See the module docstring for what is measured and where it parts from
    pupil_idle_minutes. Returns the terms; the caller scales the rest of the
    objective by PUPIL_GAP_SCALE beside them.
    """
    gaps = request.pupil_gaps
    if gaps is None or built.weight <= 0:
        return []
    model = built.model
    spd = built.slots_per_day
    horizon = len(built.weekdays) * spd
    by_key: dict[UUID, list[object]] = defaultdict(list)
    for decision in decisions:
        by_key[built.pupil_key(decision.lesson.requirement)].append(decision)  # type: ignore[attr-defined]
    paired = {frozenset(pair) for pair in request.group_conflicts}
    fixed_by_id = {fixed.id: fixed for fixed in request.fixed_lessons}
    spans = group_spans(request)

    terms: list[cp_model.LinearExpr] = []
    for index, cohort in enumerate(gaps.cohorts):
        keys = [key for key in dict.fromkeys(cohort.group_ids) if key in by_key]
        # Keys whose lessons may overlap inside this cohort's day: two that
        # share no pair, which in a gateway's payload is a class's halves
        # beside each other (class-halves.ts part 3).
        loose = [
            (keys[i], keys[j])
            for i in range(len(keys))
            for j in range(i + 1, len(keys))
            if frozenset((keys[i], keys[j])) not in paired
        ]
        locks: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for fixed_id in dict.fromkeys(cohort.fixed_lesson_ids):
            fixed = fixed_by_id.get(fixed_id)
            window = built.fixed_window(fixed) if fixed is not None else None
            if window is not None:
                locks[window[0] // spd].append(window)

        for day in range(len(built.weekdays)):
            parts = [part for key in keys if (part := _key_day(built, by_key, key, day)) is not None]
            if not parts:
                continue
            if sum(part.count for part in parts) + len(locks.get(day, ())) < 2:
                # One lesson is a day equal to its own length.
                continue
            base = day * spd
            tag = f"pg_{index}_{day}"
            first = model.NewIntVar(base, base + spd, f"{tag}_first")
            last = model.NewIntVar(base, base + spd, f"{tag}_last")
            for part in parts:
                model.Add(first <= part.first)
                model.Add(last >= part.last)
            occupied: list[cp_model.LinearExpr] = [part.occupied for part in parts]
            for start, end in locks.get(day, ()):
                model.Add(first <= start)
                model.Add(last >= end)
                occupied.append(end - start)
            for key_a, key_b in loose:
                for a in by_key[key_a]:
                    for b in by_key[key_b]:
                        shared = _overlap(built, a, b, day)
                        if shared is not None:
                            occupied.append(-shared)

            credit: list[cp_model.LinearExpr] = []
            lunch = (
                built.lunch_starts.get((cohort.home_group_id, day))
                if cohort.home_group_id is not None
                else None
            )
            if lunch is not None and built.lunch_slots > 0:
                inside = model.NewBoolVar(f"{tag}_lunch")
                model.Add(first <= lunch).OnlyEnforceIf(inside)
                model.Add(lunch + built.lunch_slots <= last).OnlyEnforceIf(inside)
                credit.append(built.lunch_slots * inside)

            closures = _closure_slots(built, request, cohort, day, spans)
            if closures:
                # Only a window the day can reach is credited: a frame's
                # morning lies before every lesson the cohort can have, and
                # three variables for an overlap that is always zero would be
                # most of this term at a school with ramtider.
                reach = [
                    interval
                    for key in keys
                    for decision in by_key[key]
                    for interval in _pupil_reach(built, decision, day)
                ] + locks.get(day, [])
                low = min(start for start, _ in reach)
                high = max(end for _, end in reach)
                for number, window in enumerate(closures):
                    if window[1] <= low or window[0] >= high:
                        continue
                    credit.append(_window_overlap(
                        model, window, first, last, horizon, spd, f"{tag}_cl{number}",
                    ))
                    for key in keys:
                        for decision in by_key[key]:
                            taken = _closure_overlap(built, decision, window, day)
                            if taken is not None:
                                credit.append(-taken)

            idle = model.NewIntVar(0, spd, f"{tag}_idle")
            model.Add(idle >= last - first - sum(occupied) - sum(credit))
            terms.append(built.weight * cohort.pupils * idle)
    return terms


def _closure_overlap(
    built: PupilGapModel, decision: object, window: tuple[int, int], day: int,
) -> cp_model.IntVar | None:
    """Slots a lesson of the cohort spends inside a closed window, at least.

    A rule on 7A closes 7A's hour and lets Ma71 meet in it; the pupils in both
    are busy once, and the credit for the closure must not pay them for the
    lesson's minutes too. Only a lesson whose domain reaches the window gets a
    variable.
    """
    if not _meet(_pupil_reach(built, decision, day), [window]):
        return None
    cache_key = (decision.lesson.key(), window[0], window[1])  # type: ignore[attr-defined]
    if cache_key in built._closure_overlaps:
        return built._closure_overlaps[cache_key]
    model = built.model
    horizon = len(built.weekdays) * built.slots_per_day
    start, end = _lesson_span(decision)
    tag = f"pg_clov_{cache_key[0]}_{window[0]}"
    low = model.NewIntVar(0, horizon, f"{tag}_lo")
    high = model.NewIntVar(0, horizon, f"{tag}_hi")
    model.AddMaxEquality(low, [start, window[0]])
    model.AddMinEquality(high, [end, window[1]])
    taken = model.NewIntVar(0, built.slots_per_day, tag)
    model.AddMaxEquality(taken, [high - low, 0])
    built._closure_overlaps[cache_key] = taken
    return taken


def estimate_variables(request: OptimizeScheduleRequest, days: int) -> int:
    """An upper bound on what build_pupil_gap_objective adds, for _estimate_model_size.

    Per (key, day) two ends; per lesson and day one literal; per cohort and
    day its two ends, its idle and its lunch literal; per pair of loose keys'
    lessons three and one a day. And the closures, charged here although the
    teachers' are not (_estimate_model_size): a pupil's day can be closed by
    every rule on any of their groups and every year rule, so a school with
    ramtider pays for them on every cohort. Per cohort and day three for each
    window that can close it, and per lesson three for each window and day of
    the cohorts sitting it — counted at the windows its worst cohort has,
    because the variable is the lesson's and made once.
    """
    gaps = request.pupil_gaps
    if gaps is None:
        return 0
    lessons_by_key: dict[UUID, int] = defaultdict(int)
    for requirement in request.requirements:
        lessons_by_key[requirement.pupil_group_id or requirement.student_group_id] += (
            requirement.lessons_per_week
        )
    spans = group_spans(request)
    weekly = [
        rule for rule in request.constraints
        if rule.kind == "UNAVAILABLE" and rule.date is None
    ]
    rules_on: dict[UUID, int] = defaultdict(int)
    for rule in weekly:
        if rule.resource_kind == "STUDENT_GROUP" and rule.resource_id is not None:
            rules_on[rule.resource_id] += 1
    year_rules = sum(1 for rule in weekly if rule.resource_kind == "GRADE_LEVEL")
    framed = bool(request.frame_times)

    paired = {frozenset(pair) for pair in request.group_conflicts}
    loose_pairs: set[frozenset[UUID]] = set()
    windows_of_key: dict[UUID, int] = defaultdict(int)
    cohort_windows = 0
    for cohort in gaps.cohorts:
        groups = list(dict.fromkeys(cohort.group_ids))
        windows = (
            sum(rules_on.get(group, 0) for group in groups)
            + year_rules
            + (2 * len({spans[group] for group in groups if group in spans}) if framed else 0)
        )
        cohort_windows += windows
        keys = [key for key in groups if key in lessons_by_key]
        for key in keys:
            windows_of_key[key] = max(windows_of_key[key], windows)
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                pair = frozenset((keys[i], keys[j]))
                if pair not in paired:
                    loose_pairs.add(pair)
    lessons = sum(lessons_by_key.values())
    loose = sum(
        lessons_by_key[a] * lessons_by_key[b] for a, b in (tuple(pair) for pair in loose_pairs)
    )
    closure_lessons = sum(lessons_by_key[key] * windows for key, windows in windows_of_key.items())
    return (
        days * (2 * len(lessons_by_key) + lessons + 4 * len(gaps.cohorts) + 3 * cohort_windows)
        + loose * (3 + days)
        + 3 * days * closure_lessons
    )
