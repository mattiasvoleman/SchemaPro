"""Raster: the minutes of a day a stage is not taught.

A rast is the school's own sentence about when a stage is free. Nothing here is
chosen by the solver — unlike a lunch, where the school declares a window and
the engine picks the class's sitting inside it. The school states a rast; this
module turns it into slots no lesson may occupy.

IT COSTS NOTHING. A rast SUBTRACTS from every matching lesson's start domain
rather than adding an interval to a NoOverlap. No new variables, no new
constraints, and a strictly smaller search space than the same model without
it — the same shape scheduler_solver.py already argues for in its own words
about frames: "RAMTIDER NARROW THIS DOMAIN RATHER THAN FORBIDDING INTERVALS IN
IT."

THREE RULES, and each is a decision rather than an accident:

  MATCHING IS OVERLAP, the same test frames and servings use, and for the same
  reason: a group spanning 6-7 has year-6 children in it, so a 4-6 rast binds
  it. A group whose years are unknown matches nothing, which is the answer
  frames and servings already give.

  EVERY MATCHING ROW APPLIES, and the union is an OBLIGATION where a serving's
  union is a permission. Several rasts a day is the ordinary Swedish week.

  A DAY-SPECIFIC ROW SHADOWS ONLY THE EVERY-DAY ROWS IT OVERLAPS. This is where
  a rast parts company with a serving, and it is the difference between a
  correct Friday and a silently broken one. servings.py replaces every every-day
  row on a day that names one — safe where one sitting per stage is the norm. A
  school with three rasts for åk 4-6 that adds "fredag 09:30-09:50" would, under
  that rule, lose the other two every Friday: the engine would teach straight
  through them and publish would write a one-rast Friday to every pupil in the
  stage.

ROUNDING GOES OUTWARD, which is the opposite of a frame's and a serving's, and
for a reason that follows from what each one does. A frame and a serving PERMIT,
so a window that misses the grid gives up the partial slot. A rast RESERVES, so
a window that misses the grid must TAKE the partial slot — rounding inward would
put a lesson in minutes the school has already given away. The same conservatism
TimeGrid.clamp_to_grid states for an all-day closure, and the same the fixed
lessons' blocked window uses.

Outward rounding also means no minimum length is needed anywhere: a
three-minute rast becomes one whole slot rather than nothing, so the shortest
thing a school can write down is still honoured.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from app.schemas.schedule import Rast
    from app.solver.time_grid import TimeGrid


def _matches(rast: Rast, span: tuple[int, int] | None) -> bool:
    if span is None:
        return False
    span_min, span_max = span
    return not (span_max < rast.min_grade_level or span_min > rast.max_grade_level)


def _minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _overlaps(a: Rast, b: Rast) -> bool:
    return _minutes(a.start_time) < _minutes(b.end_time) and _minutes(
        b.start_time
    ) < _minutes(a.end_time)


def blocks_for(
    rasts: Sequence[Rast],
    span: tuple[int, int] | None,
    day_of_week: int,
    grid: TimeGrid,
) -> list[tuple[int, int]]:
    """Day-local slot ranges [start, end) this stage may not be taught in.

    Merged and ordered, so a caller can subtract them without worrying about
    overlaps of its own. Clipped to the configured day: a rast written outside
    08:00-18:00 constrains nothing rather than producing negative slots.
    """
    return [
        (first, last)
        for first, last, _demands in blocks_with_demand(rasts, span, day_of_week, grid)
    ]


def blocks_with_demand(
    rasts: Sequence[Rast],
    span: tuple[int, int] | None,
    day_of_week: int,
    grid: TimeGrid,
) -> list[tuple[int, int, bool]]:
    """The same blocks, each carrying whether a lesson is owed before it.

    THE DEMAND RIDES ALONG THE MERGE, and that is the whole reason this lives
    here rather than in a caller asking each row on its own. A row read alone
    cannot know it has been shadowed: `blocks_for([rast], ...)` hands back the
    minutes an every-day rast WOULD reserve on a Friday that has already
    replaced it. The ordering rule asked exactly that question and got exactly
    that answer — a school whose Friday morning was one long rast still had to
    be taught before 09:40 on it, and could not be taught at all before 11:00,
    so it was barred from Friday altogether. Measured on two classes of 32
    lessons each: ten Friday lessons and an OPTIMAL week in five seconds became
    no Friday lessons and the whole sixty-second budget spent.

    It reads the other way too. A Friday row that MOVES the break to 09:20-09:50
    left the demand pointing at 09:40-10:00, so a class taught from 09:50 did
    not count as being there after the break and the rule quietly stopped
    applying. Neither error is visible in a finished schedule; both are visible
    here.

    A block that several rows form asks if ANY of them asks, and the boundary is
    the MERGED one: the break as it is lived runs from the first row's start to
    the last one's end, and the lesson the school wants is the one before that.
    """
    matching = [rast for rast in rasts if _matches(rast, span)]
    if not matching:
        return []

    today = [rast for rast in matching if rast.day_of_week == day_of_week]
    every_day = [
        rast
        for rast in matching
        if rast.day_of_week is None
        and not any(_overlaps(rast, specific) for specific in today)
    ]

    ranges: list[tuple[int, int, bool]] = []
    for rast in [*today, *every_day]:
        start = _minutes(rast.start_time)
        end = _minutes(rast.end_time)
        # Outward: floor the start, ceil the end.
        first = (start - grid.day_start_minutes) // grid.slot_minutes
        last = -(-(end - grid.day_start_minutes) // grid.slot_minutes)
        first = max(first, 0)
        last = min(last, grid.slots_per_day)
        if last > first:
            ranges.append((first, last, rast.requires_lesson_before))

    ranges.sort()
    merged: list[tuple[int, int, bool]] = []
    for start, end, demands in ranges:
        if merged and start <= merged[-1][1]:
            first_slot, last_slot, asked = merged[-1]
            merged[-1] = (first_slot, max(last_slot, end), asked or demands)
        else:
            merged.append((start, end, demands))
    return merged


def forbidden_starts(
    blocks: Sequence[tuple[int, int]],
    duration: int,
) -> list[tuple[int, int]]:
    """Day-local start ranges [first, last] a lesson of `duration` may not take.

    A lesson occupying [s, s + duration) overlaps a block [b0, b1) exactly when
    s < b1 and b0 < s + duration — that is, when s lies in
    [b0 - duration + 1, b1 - 1]. Inclusive on both ends, because that is the
    shape cp_model.Domain.FromIntervals wants.

    Clamped at zero rather than allowed to go negative: a block at the very
    start of the day forbids nothing before the day begins, and a negative bound
    would make the subtraction silently wider than the rast.
    """
    return [(max(b0 - duration + 1, 0), b1 - 1) for b0, b1 in blocks if b1 > b0]
