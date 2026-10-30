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
    weeks       a cohort with a lesson or a lock on alternate weeks has an odd
                week and an even week, each of what runs in it; an ordinary
                week is half of each (the report's weekShare), so the number
                can end in a half

Except where the report reads what the engine never sees, and the count then
takes every week as it stands: a lesson its dates keep to part of the läsår,
and a halvklass terminsvis (the class holds the leader post, so its pupil key
is the class's), which the report counts as a hole for the half not reading
the subject in the period. The manual's box "Där generatorn räknar grövre än
sidan" says the same.

src/common/__fixtures__/pupil-gaps-cases.json is the contract: the web replays
it through findIdleGaps, the gateway through the cohorts it sends, and
tests/test_pupil_gaps.py through this function.

THE OBJECTIVE (build_pupil_gap_objective) is what CP-SAT minimises when the
school turns the rule on. Per cohort and day:

    idle >= (last - first) - busy - lunch

with `first` and `last` the pupils' own day — every key of the cohort,
which is the whole of "elevens faktiska dag": the home class, the teaching
groups, the halves and the replacing groups, read in the pupil space exactly
as the no-overlap rules read it (pupil_key_of) — and the locks they sit. A
class is never one body here: 7A's fourteen outside Ma71 and its sixteen
inside it are two cohorts, each with its own day, which is why a
span-minus-taught term per GROUP was refused for years (see
_add_idle_time_objective) and this one is not.

`busy` is the union the count merges, each slot once, by inclusion and
exclusion: the lessons, less the overlap of every two that may meet (sibling
halves for a pupil in neither); then the windows that never move — the
cohort's locks and its closed time, merged per day, so both halves' locked
rotation is one hour and a lock in closed time is busy once — each where it
lies inside the day, less the slots a lesson fills of it, plus those two
siblings fill of it together. A lesson its key's lock holds off
(_add_fixed_lesson_constraints) is never in that lock's window and pays
nothing; every other one gets its overlap, exactly, from its own min and max.

A cohort whose day has a lesson or a lock on alternate weeks gets that day
once per week, each of what runs in it (app/solver/weeks.py): slöjd odd and
hemkunskap even at one hour are the hour once in each week, never two hours
in one. See build_pupil_gap_objective for how the two weeks are weighed.

WHERE THE OBJECTIVE AND THE COUNT PART, said once and measured in the PR:

    a hole under 15 minutes   counted by the objective, never by the count.
                              Which holes are short is a question about the
                              lesson after each one, and a successor per pair
                              of lessons is quadratic in every pupil's week
    lunch                     credited when the class's own placed lunch lies
                              inside the day, whole, even where the pupils are
                              busy during some of it (a dusch, a lock of
                              another of their groups); the count credits the
                              window, and only what of it lies in a hole
    a locked lesson's margin  counted only by the count: the engine does not
                              keep a lock's ombyte either (FixedLessonMargin)

Every term is a lower bound pushed up to the truth by the objective, never a
rule: nothing here can make a week infeasible — each `idle` reaches as far as
its right side can, whatever the payload — and a school with the rule off
sends no pupilGaps and builds none of it.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.solver.weeks import WEEKS, alternates, meet
from app.solver.weeks import tag as week_tag

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
        WeekParity,
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
    """One cohort's lessons by weekday, in minutes, margins included, each with its weeks."""

    cohort: PupilGapCohort
    by_day: dict[int, list[tuple[int, int, WeekParity | None]]] = field(
        default_factory=lambda: defaultdict(list),
    )


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
    placed_by_key: dict[UUID, list[tuple[int, int, int, WeekParity | None]]] = defaultdict(list)
    for lesson in lessons:
        requirement = by_requirement.get(lesson.requirement_id)
        if requirement is None:
            continue
        key = requirement.pupil_group_id or requirement.student_group_id
        placed_by_key[key].append((
            lesson.day_of_week,
            _minutes(lesson.start_time) - requirement.minutes_before,
            _minutes(lesson.end_time) + requirement.minutes_after,
            requirement.recurrence,
        ))
    weeks: list[CohortWeek] = []
    for cohort in gaps.cohorts:
        week = CohortWeek(cohort)
        for key in dict.fromkeys(cohort.group_ids):
            for day, start, end, runs in placed_by_key.get(key, ()):
                week.by_day[day].append((start, end, runs))
        for fixed_id in dict.fromkeys(cohort.fixed_lesson_ids):
            fixed = fixed_by_id.get(fixed_id)
            if fixed is None:
                continue
            margin = margins.get(fixed_id, _Margins())
            week.by_day[fixed.day_of_week].append((
                _minutes(fixed.start_time) - margin.before,
                _minutes(fixed.end_time) + margin.after,
                fixed.recurrence,
            ))
        weeks.append(week)
    return weeks


def pupil_idle_minutes(
    request: OptimizeScheduleRequest, lessons: Sequence[ScheduledLesson],
) -> float | None:
    """Idle pupil-minutes in an ordinary week: the håltimmesrapport's number.

    A cohort with a lesson or a lock on alternate weeks has two weeks, each
    counted with the lessons and locks that run in it (weeks.meet), and an
    ordinary week is half of each — gaps.ts reports every hole once per
    parity it exists in and candidates/idle.ts weekShare halves one that
    exists in only one. So the number can end in a half; it is summed in
    halves here and exact. None when the request carried no pupilGaps — the
    school has not turned the rule on, and its response says nothing it did
    not say before.
    """
    if request.pupil_gaps is None:
        return None
    spans = group_spans(request)
    lunch = lunch_window(request)
    halves = 0
    for week in cohort_weeks(request, lessons):
        both = alternates(
            parity for intervals in week.by_day.values() for _, _, parity in intervals
        )
        for day, intervals in week.by_day.items():
            closures = closed_minutes(request, week.cohort.group_ids, day, spans)
            for parity in WEEKS if both else (None,):
                idle = day_idle_minutes(
                    [(start, end) for start, end, runs in intervals if meet(runs, parity)],
                    closures,
                    lunch,
                )
                halves += week.cohort.pupils * idle * (1 if both else 2)
    return halves / 2


# ---------------------------------------------------------------------------
# The objective
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SlotGrid:
    """The grid in slots: what a closure or a lock needs to become one."""

    slots_per_day: int
    slot_minutes: int
    day_start_minutes: int
    weekdays: Sequence[int]


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
    rounded window; `lock_keys(lock)` scheduler_solver.pupil_keys_of, the keys
    whose pupils sit it; `pupil_key(requirement)` scheduler_solver.pupil_key_of.
    """

    model: cp_model.CpModel
    slots_per_day: int
    slot_minutes: int
    day_start_minutes: int
    weekdays: Sequence[int]
    on: Callable[[object, int], cp_model.IntVar | None]
    reach: Callable[[object], dict[int, list[tuple[int, int]]]]
    fixed_window: Callable[[FixedLesson], tuple[int, int] | None]
    lock_keys: Callable[[FixedLesson], list[UUID]]
    pupil_key: Callable[[object], UUID]
    lunch_starts: dict[tuple[UUID, int], cp_model.IntVar]
    lunch_slots: int
    weight: int
    _key_days: dict[tuple[object, ...], _KeyDay | None] = field(default_factory=dict)
    #: A pair of loose lessons: the later start, the earlier end, the overlap.
    _shared: dict[
        tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar, cp_model.IntVar]
    ] = field(default_factory=dict)
    _overlaps: dict[tuple[str, str, int], cp_model.IntVar | None] = field(default_factory=dict)
    _in_window: dict[tuple[str, int, int], cp_model.IntVar] = field(default_factory=dict)
    _pairs_in_window: dict[tuple[str, str, int, int], cp_model.IntVar] = field(
        default_factory=dict,
    )


def _lesson_span(decision: object) -> tuple[cp_model.LinearExpr, cp_model.LinearExpr]:
    """The pupils' interval of a lesson: [start - lead, end + trail), no corridor."""
    return decision.start - decision.lead, decision.end + decision.trail  # type: ignore[attr-defined]


def _pupil_reach(built: PupilGapModel, decision: object, day: int) -> list[tuple[int, int]]:
    """The absolute slots a lesson can keep its pupils busy on a day, margins included."""
    lead, trail = decision.lead, decision.trail  # type: ignore[attr-defined]
    return [(low - lead, high + trail) for low, high in built.reach(decision).get(day, ())]


def _meet(first: list[tuple[int, int]], second: list[tuple[int, int]]) -> bool:
    return any(a < d and c < b for a, b in first for c, d in second)


def _cut(intervals: list[tuple[int, int]], cuts: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """`intervals` less every one of `cuts`."""
    out = list(intervals)
    for low, high in cuts:
        out = [
            piece
            for start, end in out
            for piece in (
                ((start, end),) if high <= start or low >= end
                else ((start, low), (high, end))
            )
            if piece[0] < piece[1]
        ]
    return out


def _common(first: list[tuple[int, int]], second: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Where two lists of intervals both lie."""
    return [
        (max(a, c), min(b, d))
        for a, b in first
        for c, d in second
        if max(a, c) < min(b, d)
    ]


def _runs(decision: object) -> WeekParity | None:
    """A/B-veckor: the weeks a lesson runs in, None for every week (scheduler_solver._parity)."""
    return decision.lesson.requirement.recurrence  # type: ignore[attr-defined]


def _key_day(
    built: PupilGapModel,
    by_key: dict[UUID, list[object]],
    key: UUID,
    day: int,
    week: WeekParity | None = None,
) -> _KeyDay | None:
    """A pupil key's day in one week, built once and shared by every cohort sitting it.

    A key none of whose lessons alternates has one day for both weeks, the
    one it always had: same members, same names.
    """
    lessons_of_key = by_key.get(key, ())
    if week is not None and not alternates(_runs(decision) for decision in lessons_of_key):
        week = None
    cache_key: tuple[object, ...] = (key, day) if week is None else (key, day, week)
    if cache_key in built._key_days:
        return built._key_days[cache_key]
    model = built.model
    base = day * built.slots_per_day
    lessons = [
        (decision, literal)
        for decision in lessons_of_key
        if meet(_runs(decision), week) and (literal := built.on(decision, day)) is not None
    ]
    if not lessons:
        built._key_days[cache_key] = None
        return None
    first = model.NewIntVar(
        base, base + built.slots_per_day, week_tag(f"pg_first_{key}_{day}", week),
    )
    last = model.NewIntVar(
        base, base + built.slots_per_day, week_tag(f"pg_last_{key}_{day}", week),
    )
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
    if pair not in built._shared:
        horizon = len(built.weekdays) * built.slots_per_day
        tag = f"pg_ov_{pair[0]}_{pair[1]}"
        (a_start, a_end), (b_start, b_end) = _lesson_span(a), _lesson_span(b)
        low = model.NewIntVar(-horizon, horizon, f"{tag}_lo")
        high = model.NewIntVar(-horizon, 2 * horizon, f"{tag}_hi")
        model.AddMaxEquality(low, [a_start, b_start])
        model.AddMinEquality(high, [a_end, b_end])
        shared = model.NewIntVar(0, built.slots_per_day, tag)
        model.AddMaxEquality(shared, [high - low, 0])
        built._shared[pair] = (low, high, shared)
    # The pair's overlap, charged to the day it happens on: zero on any other,
    # where the two cannot meet at all.
    today = model.NewIntVar(0, built.slots_per_day, f"pg_ov_{pair[0]}_{pair[1]}_{day}")
    model.Add(today >= built._shared[pair][2]).OnlyEnforceIf(on_a)
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
    grid: SlotGrid | PupilGapModel,
    request: OptimizeScheduleRequest,
    cohort: PupilGapCohort,
    day: int,
    spans: dict[UUID, tuple[int, int]],
) -> list[tuple[int, int]]:
    """The cohort's closed time on a day, in absolute slots, merged and rounded inward.

    Inward, because closed time is no hole: rounding it outward would pay the
    pupils for minutes nobody closed.
    """
    weekday = grid.weekdays[day]
    base = day * grid.slots_per_day
    out: list[tuple[int, int]] = []
    for start, end in _merged(closed_minutes(request, cohort.group_ids, weekday, spans)):
        low = -(-(start - grid.day_start_minutes) // grid.slot_minutes)
        high = (end - grid.day_start_minutes) // grid.slot_minutes
        low, high = max(low, 0), min(high, grid.slots_per_day)
        if high > low:
            out.append((base + low, base + high))
    return out


def _held_off(
    keys: Iterable[UUID], lock_keys: list[UUID], paired: set[frozenset[UUID]],
) -> frozenset[UUID]:
    """The cohort's keys a lock keeps out of its window.

    _add_fixed_lesson_constraints's `shares_group`: a key the lock's pupils
    sit, or one sharing pupils with them, is held off the window with the
    pupils' margins on both sides, so none of its lessons is ever inside it.
    Any other key's lesson may be: the sibling half's NO beside 7A:1's locked
    slöjd, the class's matte under a lock that names one of its pupils.
    """
    return frozenset(
        key
        for key in keys
        if key in lock_keys or any(frozenset((key, other)) in paired for other in lock_keys)
    )


def build_pupil_gap_objective(
    built: PupilGapModel,
    request: OptimizeScheduleRequest,
    decisions: Sequence[object],
) -> list[cp_model.LinearExpr]:
    """The pupils' idle slots, cohort by cohort and day, each weighted by its pupils.

    See the module docstring for what is measured and where it parts from
    pupil_idle_minutes. Returns the terms; the caller scales the rest of the
    objective by pupil_gap_scale(request) beside them.

    A/B-VECKOR. A cohort with a lesson or a lock on alternate weeks has an
    odd week and an even week, each built from what runs in it (weeks.meet),
    as the count counts them: two lessons of one key at one hour, slöjd odd
    and hemkunskap even, are that hour once in each week and never two hours
    in one. Its terms are the two weeks' sum, and in such a school every
    other cohort's day counts twice and the rest of the objective is scaled
    twice as far (week_factor), so every term weighs an ordinary week — half
    of each — in integers. A school without alternating lessons builds
    exactly what it built before.
    """
    gaps = request.pupil_gaps
    if gaps is None or built.weight <= 0:
        return []
    model = built.model
    spd = built.slots_per_day
    by_key: dict[UUID, list[object]] = defaultdict(list)
    for decision in decisions:
        by_key[built.pupil_key(decision.lesson.requirement)].append(decision)  # type: ignore[attr-defined]
    paired = {frozenset(pair) for pair in request.group_conflicts}
    fixed_by_id = {fixed.id: fixed for fixed in request.fixed_lessons}
    spans = group_spans(request)
    every_week = week_factor(request)

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
        locks: dict[
            int, list[tuple[tuple[int, int], frozenset[UUID], WeekParity | None]]
        ] = defaultdict(list)
        for fixed_id in dict.fromkeys(cohort.fixed_lesson_ids):
            fixed = fixed_by_id.get(fixed_id)
            window = built.fixed_window(fixed) if fixed is not None else None
            if window is not None and fixed is not None:
                locks[window[0] // spd].append(
                    (window, _held_off(keys, built.lock_keys(fixed), paired), fixed.recurrence),
                )
        weekly = alternates(
            _runs(decision) for key in keys for decision in by_key[key]
        ) or alternates(runs for rows in locks.values() for _, _, runs in rows)

        for day, week in (
            (day, week)
            for day in range(len(built.weekdays))
            for week in (WEEKS if weekly else (None,))
        ):
            members = (
                by_key if week is None
                else {key: [d for d in by_key[key] if meet(_runs(d), week)] for key in keys}
            )
            parts = [
                part for key in keys
                if (part := _key_day(built, by_key, key, day, week)) is not None
            ]
            if not parts:
                continue
            day_locks = [
                (window, held) for window, held, runs in locks.get(day, ()) if meet(runs, week)
            ]
            if sum(part.count for part in parts) + len(day_locks) < 2:
                # One lesson is a day equal to its own length.
                continue
            base = day * spd
            tag = week_tag(f"pg_{index}_{day}", week)
            first = model.NewIntVar(base, base + spd, f"{tag}_first")
            last = model.NewIntVar(base, base + spd, f"{tag}_last")
            for part in parts:
                model.Add(first <= part.first)
                model.Add(last >= part.last)
            for (start, end), _ in day_locks:
                model.Add(first <= start)
                model.Add(last >= end)
            busy: list[cp_model.LinearExpr] = [part.occupied for part in parts]
            met: list[tuple[object, object]] = []
            for key_a, key_b in loose:
                for a in members[key_a]:
                    for b in members[key_b]:
                        shared = _overlap(built, a, b, day)
                        if shared is not None:
                            busy.append(-shared)
                            met.append((a, b))
            busy.extend(_constant_busy(
                built, request, cohort, day, spans, keys, members, day_locks, met,
                (first, last), tag,
            ))

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

            # The day, and a day more for every pair's overlap: what the right
            # side can reach whatever the payload, so the term is never a rule.
            # Each overlap is exact for two keys at once, which is all a
            # gateway sends; three keys no pair joins would take the same
            # minutes off three times, and a tighter bound would turn that
            # over-count into an INFEASIBLE week.
            idle = model.NewIntVar(0, spd * (1 + len(met)), f"{tag}_idle")
            model.Add(idle >= last - first - sum(busy) - sum(credit))
            # One week of two is half an ordinary week; a day of every week,
            # in a school whose weeks differ, is both.
            weeks = every_week if week is None else 1
            terms.append(built.weight * cohort.pupils * weeks * idle)
    return terms


def week_factor(request: OptimizeScheduleRequest) -> int:
    """Two in a school with a lesson or a lock on alternate weeks, one in any other.

    The term counts such a school's alternating days once per week, so every
    other part of the objective counts twice to weigh the same ordinary week.
    """
    return 2 if alternates(
        requirement.recurrence for requirement in request.requirements
    ) or alternates(fixed.recurrence for fixed in request.fixed_lessons) else 1


def pupil_gap_scale(request: OptimizeScheduleRequest) -> int:
    """What the rest of the objective is multiplied by beside the pupils' term."""
    return PUPIL_GAP_SCALE * week_factor(request)


def _constant_busy(
    built: PupilGapModel,
    request: OptimizeScheduleRequest,
    cohort: PupilGapCohort,
    day: int,
    spans: dict[UUID, tuple[int, int]],
    keys: list[UUID],
    by_key: dict[UUID, list[object]],
    day_locks: list[tuple[tuple[int, int], frozenset[UUID]]],
    met: list[tuple[object, object]],
    ends: tuple[cp_model.IntVar, cp_model.IntVar],
    tag: str,
) -> list[cp_model.LinearExpr]:
    """The cohort's locks and closed time on a day, as busy time counted once.

    One union of windows that never move, so both halves' locked rotation at
    10:00 is one hour of an unplaced pupil's day and not two, and a lock in
    closed time is not busy twice. A window counts where it lies inside the
    day: whole when locks alone make it, since every lock bounds the day,
    else its overlap with [first, last]. Less what the cohort's lessons
    already fill of it — a lesson the window's locks do not hold off may sit
    there (_held_off) — and plus what two of them fill together, which the
    pair's overlap took off once already: lessons ∪ windows, each slot once.
    """
    model = built.model
    spd = built.slots_per_day
    horizon = len(built.weekdays) * spd
    locked = [window for window, _ in day_locks]
    windows = _merged(locked + _closure_slots(built, request, cohort, day, spans))
    if not windows:
        return []
    # Only a window the day can reach counts: a frame's morning lies before
    # every lesson the cohort can have, and three variables for an overlap
    # that is always zero would be most of this term at a school with
    # ramtider. A lock is always within reach: it is in the day.
    reach = [
        interval
        for key in keys
        for decision in by_key[key]
        for interval in _pupil_reach(built, decision, day)
    ] + locked
    low = min(start for start, _ in reach)
    high = max(end for _, end in reach)
    first, last = ends
    out: list[cp_model.LinearExpr] = []
    for number, window in enumerate(windows):
        if window[1] <= low or window[0] >= high:
            continue
        if _cut([window], locked):
            out.append(_window_overlap(
                model, window, first, last, horizon, spd, f"{tag}_cw{number}",
            ))
        else:
            out.append(window[1] - window[0])
        open_to = {
            key: _cut([window], [lock for lock, held in day_locks if key in held])
            for key in keys
        }
        for key in keys:
            if not open_to[key]:
                continue
            for decision in by_key[key]:
                taken = _lesson_in_window(built, decision, window, open_to[key], day)
                if taken is not None:
                    out.append(-taken)
        for a, b in met:
            both = _common(
                open_to[built.pupil_key(a.lesson.requirement)],  # type: ignore[attr-defined]
                open_to[built.pupil_key(b.lesson.requirement)],  # type: ignore[attr-defined]
            )
            if both:
                together = _pair_in_window(built, a, b, window, both, day)
                if together is not None:
                    out.append(together)
    return out


def _lesson_in_window(
    built: PupilGapModel,
    decision: object,
    window: tuple[int, int],
    open_part: list[tuple[int, int]],
    day: int,
) -> cp_model.IntVar | None:
    """Slots a lesson of the cohort spends inside a window, exactly.

    A rule on 7A closes 7A's hour and lets Ma71 meet in it; the pupils in both
    are busy once, and the window must not count the lesson's minutes too.
    Only a lesson whose domain reaches the window's `open_part` — the window
    less the locks holding the lesson off — gets a variable.
    """
    if not _meet(_pupil_reach(built, decision, day), open_part):
        return None
    cache_key = (decision.lesson.key(), window[0], window[1])  # type: ignore[attr-defined]
    if cache_key in built._in_window:
        return built._in_window[cache_key]
    model = built.model
    horizon = len(built.weekdays) * built.slots_per_day
    start, end = _lesson_span(decision)
    tag = f"pg_in_{cache_key[0]}_{window[0]}_{window[1]}"
    low = model.NewIntVar(0, horizon, f"{tag}_lo")
    high = model.NewIntVar(0, horizon, f"{tag}_hi")
    model.AddMaxEquality(low, [start, window[0]])
    model.AddMinEquality(high, [end, window[1]])
    taken = model.NewIntVar(0, built.slots_per_day, tag)
    model.AddMaxEquality(taken, [high - low, 0])
    built._in_window[cache_key] = taken
    return taken


def _pair_in_window(
    built: PupilGapModel,
    first: object,
    second: object,
    window: tuple[int, int],
    open_part: list[tuple[int, int]],
    day: int,
) -> cp_model.IntVar | None:
    """Slots two loose lessons share inside a window, exactly.

    Both halves' lessons at 10:00 inside a closure 10:00-10:40: the window
    takes 40 off each, and they were one hour together, so 40 come back
    once. Read off the pair's own later start and earlier end (_overlap).
    """
    if not (
        _meet(_pupil_reach(built, first, day), open_part)
        and _meet(_pupil_reach(built, second, day), open_part)
    ):
        return None
    a, b = sorted(
        (first, second), key=lambda decision: decision.lesson.key(),  # type: ignore[attr-defined]
    )
    pair = (a.lesson.key(), b.lesson.key())  # type: ignore[attr-defined]
    cache_key = (*pair, window[0], window[1])
    if cache_key in built._pairs_in_window:
        return built._pairs_in_window[cache_key]
    model = built.model
    horizon = len(built.weekdays) * built.slots_per_day
    later, earlier, _ = built._shared[pair]
    tag = f"pg_pin_{pair[0]}_{pair[1]}_{window[0]}_{window[1]}"
    low = model.NewIntVar(-horizon, 2 * horizon, f"{tag}_lo")
    high = model.NewIntVar(-horizon, 2 * horizon, f"{tag}_hi")
    model.AddMaxEquality(low, [later, window[0]])
    model.AddMinEquality(high, [earlier, window[1]])
    together = model.NewIntVar(0, built.slots_per_day, tag)
    model.AddMaxEquality(together, [high - low, 0])
    built._pairs_in_window[cache_key] = together
    return together


def estimate_variables(
    request: OptimizeScheduleRequest,
    grid: SlotGrid,
    fixed_window: Callable[[FixedLesson], tuple[int, int] | None],
) -> int:
    """An upper bound on what build_pupil_gap_objective adds, for _estimate_model_size.

    Per (key, day) two ends; per lesson and day one literal; per cohort and
    day its two ends, its idle and its lunch literal; per pair of loose keys'
    lessons three and one a day. And the windows, charged here although the
    teachers' closures are not (_estimate_model_size): a pupil's day can be
    closed by every rule on any of their groups and every year rule, so a
    school with ramtider pays for them on every cohort. They are the
    builder's own — each cohort's locks and closed time, merged per day — so
    three for every window closed time reaches (its overlap with the day),
    three for every lesson and distinct window of a cohort sitting its key,
    and three for every pair of loose lessons and window, as the builder
    makes each of those once. A school with alternating lessons has both
    weeks: every key's and cohort's day twice, and each week's windows.
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
    paired = {frozenset(pair) for pair in request.group_conflicts}
    fixed_by_id = {fixed.id: fixed for fixed in request.fixed_lessons}
    days = len(grid.weekdays)
    weeks = WEEKS if week_factor(request) == 2 else (None,)

    loose_pairs: set[frozenset[UUID]] = set()
    key_windows: set[tuple[UUID, int, int]] = set()
    pair_windows: set[tuple[frozenset[UUID], int, int]] = set()
    closed_windows = 0
    for cohort in gaps.cohorts:
        keys = [key for key in dict.fromkeys(cohort.group_ids) if key in lessons_by_key]
        pairs = [
            pair
            for i in range(len(keys))
            for j in range(i + 1, len(keys))
            if (pair := frozenset((keys[i], keys[j]))) not in paired
        ]
        loose_pairs.update(pairs)
        locks: dict[int, list[tuple[tuple[int, int], WeekParity | None]]] = defaultdict(list)
        for fixed_id in dict.fromkeys(cohort.fixed_lesson_ids):
            fixed = fixed_by_id.get(fixed_id)
            window = fixed_window(fixed) if fixed is not None else None
            if window is not None and fixed is not None:
                locks[window[0] // grid.slots_per_day].append((window, fixed.recurrence))
        for day, week in ((day, week) for day in range(days) for week in weeks):
            locked = [window for window, runs in locks.get(day, ()) if meet(runs, week)]
            for window in _merged(locked + _closure_slots(grid, request, cohort, day, spans)):
                if _cut([window], locked):
                    closed_windows += 1
                key_windows.update((key, *window) for key in keys)
                pair_windows.update((pair, *window) for pair in pairs)

    def both(pair: frozenset[UUID]) -> int:
        a, b = tuple(pair)
        return lessons_by_key[a] * lessons_by_key[b]

    lessons = sum(lessons_by_key.values())
    return (
        days * (len(weeks) * (2 * len(lessons_by_key) + 4 * len(gaps.cohorts)) + lessons)
        + sum(both(pair) for pair in loose_pairs) * (3 + days)
        + 3 * closed_windows
        + 3 * sum(lessons_by_key[key] for key, _, _ in key_windows)
        + 3 * sum(both(pair) for pair, _, _ in pair_windows)
    )
