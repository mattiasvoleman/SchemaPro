"""Ramtider: turning a school's stated school day into slot windows.

A frame says which hours a stage of the school may be taught in. Every lesson
for a group whose years touch the frame's span has to fall inside it, and where
several frames touch that group they all apply — so the window a group is bound
by on a given day is the INTERSECTION of the matching frames.

That single rule is what makes the model need no precedence order. A weekday
frame and an every-day frame both match a Friday, so both apply, and
"08:00-15:00 always, 08:00-13:00 on Friday" means the obvious thing without a
second sentence explaining which one wins. Frames for neighbouring stages
compose the same way for a group that straddles them: 4-6 and 7-9 both reach a
6-7 group, and the tighter of the two is what it gets. That is the reading which
keeps its year-6 pupils out of an afternoon their own stage has closed.

Matching is OVERLAP, the same test _grade_span_overlaps applies to
reservations, and for the same reason. A group whose own years are unknown
cannot be matched at all: "overlaps" has no answer against nothing, and
answering yes would sweep every yearless group into a frame meant for one stage.
Such a group keeps the whole configured day, which is what it had before frames
existed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from app.schemas.schedule import AnonymousRequirement, FrameTime
    from app.solver.time_grid import TimeGrid


def _matches(frame: FrameTime, span: tuple[int, int] | None) -> bool:
    if span is None:
        return False
    span_min, span_max = span
    return not (span_max < frame.min_grade_level or span_min > frame.max_grade_level)


def span_of(requirement: AnonymousRequirement) -> tuple[int, int] | None:
    """A requirement's year span, or None when its group's years are unknown.

    Lifted out of _matches so the same overlap test can answer for a GROUP as
    well. A frame bounds a stage's day, and a lunch belongs to a stage just as a
    lesson does — but a sitting has no requirement to read the span off.
    """
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return None
    return (requirement.min_grade_level, requirement.max_grade_level)


def _minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def day_windows(
    frames: Sequence[FrameTime],
    span: tuple[int, int] | None,
    grid: TimeGrid,
) -> dict[int, tuple[int, int]]:
    """day index -> (first slot a lesson may start, first slot it may not end after).

    Both are slot offsets within the day, so the pair reads like a Python range:
    a lesson of `duration` slots may start anywhere in
    `range(open_slot, close_slot - duration + 1)`.

    Days the frames close entirely are ABSENT from the result, which is a
    different fact from a day with a full-length window and has to stay
    distinguishable — a school that writes no Friday frame gets the whole
    Friday, and one that writes a Friday frame ending before it starts has said
    something the caller must refuse rather than quietly widen.

    CLAMPED, NOT REJECTED, at the edges of the configured day: a frame reaching
    past 18:00 is a school describing its own hours, not an error, and the
    engine's day window is the harder limit of the two. Rounding goes inward at
    both ends — a lesson may not start before the frame opens and may not run
    past its close — so a frame that does not land on the grid loses the partial
    slot rather than gaining it.
    """
    windows: dict[int, tuple[int, int]] = {}
    matching = [frame for frame in frames if _matches(frame, span)]

    for day_index, day_of_week in enumerate(grid.schedule_days):
        open_slot = 0
        close_slot = grid.slots_per_day

        for frame in matching:
            if frame.day_of_week is not None and frame.day_of_week != day_of_week:
                continue
            start = _minutes(frame.start_time)
            end = _minutes(frame.end_time)
            # Inward rounding: ceil the open, floor the close.
            frame_open = -(-(start - grid.day_start_minutes) // grid.slot_minutes)
            frame_close = (end - grid.day_start_minutes) // grid.slot_minutes
            open_slot = max(open_slot, frame_open)
            close_slot = min(close_slot, frame_close)

        # No clamp back to [0, slots_per_day] here, and none is reachable: the
        # pair starts as the whole day and each frame can only raise the open or
        # lower the close. A frame entirely outside the day therefore lands with
        # close <= open and falls out below as a closed day, which is what it is
        # — rather than as a reversed window some caller would have to interpret.
        if close_slot > open_slot:
            windows[day_index] = (open_slot, close_slot)

    return windows
