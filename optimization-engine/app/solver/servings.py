"""Lunchsittningar: which starts a stage's meal may take.

A serving is the school's own sentence about when a stage eats. The solver
still decides which class goes when INSIDE that window — a stage too big for
the hall is split into waves by the seat cumulative, one class at a time — so
what this module computes is a DOMAIN, not a placement.

THE THREE RULES, and each is a decision rather than an accident:

  MATCHING IS OVERLAP. A group whose years touch the serving's span may attend
  it. The same test frames use, for the same reason: a group spanning 6-7 has
  year-6 children in it.

  WINDOWS UNION, which is the opposite of what frames do. A frame BOUNDS a day
  and several frames intersect into the tightest; a serving PERMITS a meal and
  several widen into the union. A 6-7 group in a school with 4-6 and 7-9
  sittings may eat at either, and intersecting two disjoint windows would leave
  it nowhere at all.

  A DAY-SPECIFIC ROW REPLACES THE EVERY-DAY ROW for that day. "Åk 7-9 alla
  dagar 12:20-13:00" plus "åk 7-9 fredag 11:40-12:20" is a school saying Friday
  is DIFFERENT. Unioning the two would give Friday 11:40-13:00 — wider than
  either, and the one reading nobody meant.

A group no serving matches is unconstrained here and keeps the school-wide
lunch window, which is what every school had before servings existed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ortools.sat.python import cp_model

if TYPE_CHECKING:
    from collections.abc import Sequence

    from app.schemas.schedule import LunchServing
    from app.solver.time_grid import TimeGrid


def _matches(serving: LunchServing, span: tuple[int, int] | None) -> bool:
    if span is None:
        return False
    span_min, span_max = span
    return not (span_max < serving.min_grade_level or span_min > serving.max_grade_level)


def _minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def allowed_starts(
    servings: Sequence[LunchServing],
    span: tuple[int, int] | None,
    day_of_week: int,
    lunch_slots: int,
    grid: TimeGrid,
) -> cp_model.Domain | None:
    """Day-local starts this stage's meal may take, or None if unconstrained.

    None means "no serving speaks about this group on this day" and is a
    different fact from an EMPTY domain, which means the school declared a
    window too short to hold the break. The caller must keep them apart: the
    first leaves the school-wide window in place, the second is a refusal.

    Rounding goes INWARD, as it does for frames: a meal may not begin before the
    hall opens and may not run past its close, so a serving that does not land
    on the grid loses the partial slot rather than gaining it.
    """
    matching = [serving for serving in servings if _matches(serving, span)]
    if not matching:
        return None

    today = [serving for serving in matching if serving.day_of_week == day_of_week]
    # The every-day rows apply only where no row named this day.
    applicable = today or [
        serving for serving in matching if serving.day_of_week is None
    ]
    if not applicable:
        return None

    windows: list[cp_model.Domain] = []
    for serving in applicable:
        start = _minutes(serving.start_time)
        end = _minutes(serving.end_time)
        first = -(-(start - grid.day_start_minutes) // grid.slot_minutes)
        last = (end - grid.day_start_minutes) // grid.slot_minutes - lunch_slots
        first = max(first, 0)
        last = min(last, grid.slots_per_day - lunch_slots)
        if last < first:
            # This one window cannot hold the break. Not an error on its own —
            # another serving may still take the group — so it contributes
            # nothing rather than emptying the union.
            continue
        windows.append(cp_model.Domain(first, last))

    if not windows:
        return cp_model.Domain.FromIntervals([])

    allowed = windows[0]
    for window in windows[1:]:
        allowed = allowed.union_with(window)
    return allowed
