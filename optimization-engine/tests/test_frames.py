"""Ramtider, at the level where the arithmetic is visible.

The end-to-end tests in test_optimize.py prove the solver honours a frame. This
file proves the window it honours is the right one — the rounding, the
intersection, and the cases where a frame reaches nobody. Those are the parts a
feasible schedule cannot distinguish: a lesson at 09:00 satisfies a frame that
opens at 08:00 and one that opens at 08:55, so only exact windows show whether
the boundary is where the school put it.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.schemas.schedule import FrameTime
from app.solver.frames import day_windows, span_of
from app.solver.time_grid import TimeGrid

# 08:00-18:00, five days, five-minute slots: 120 slots per day. The real grid.
GRID = TimeGrid(
    day_start_minutes=480,
    day_end_minutes=1080,
    slot_minutes=5,
    schedule_days=(1, 2, 3, 4, 5),
)

SLOTS = GRID.slots_per_day


def frame(
    min_grade: int,
    max_grade: int,
    start: str,
    end: str,
    day: int | None = None,
) -> FrameTime:
    return FrameTime.model_validate(
        {
            "minGradeLevel": min_grade,
            "maxGradeLevel": max_grade,
            "dayOfWeek": day,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
        },
    )


def years(min_grade: int | None = 4, max_grade: int | None = 4) -> tuple[int, int] | None:
    """A group's year span, which is all day_windows needs.

    It used to take a whole AnonymousRequirement and read the span off it. A
    lunch belongs to a stage exactly as a lesson does but has no requirement to
    read, so the span is now the argument and span_of() lifts it off a
    requirement at the lesson call site.
    """
    if min_grade is None or max_grade is None:
        return None
    return (min_grade, max_grade)


def slot(clock: str) -> int:
    """The slot offset a wall clock lands on, so the tests read as times."""
    hours, minutes = (int(part) for part in clock.split(":"))
    return (hours * 60 + minutes - GRID.day_start_minutes) // GRID.slot_minutes


# ---------------------------------------------------------------------------
# No frames, and frames that reach nobody
# ---------------------------------------------------------------------------


def test_no_frames_leaves_the_whole_day_open() -> None:
    """The behaviour that existed before frames did, stated as a test."""
    windows = day_windows([], years(), GRID)
    assert windows == {index: (0, SLOTS) for index in range(5)}


def test_a_frame_for_another_stage_is_not_applied() -> None:
    windows = day_windows([frame(7, 9, "08:00", "16:00")], years(4, 4), GRID)
    assert windows == {index: (0, SLOTS) for index in range(5)}


def test_a_group_with_unknown_years_keeps_the_whole_day() -> None:
    """Overlap has no answer against nothing, so nothing is what it answers.

    Saying yes instead would sweep every group whose members carry no year into
    a frame written for one stage of the school — and a group with no years is
    the ordinary state of a school that has not entered its pupils yet.
    """
    windows = day_windows([frame(0, 12, "08:00", "12:00")], years(None, None), GRID)
    assert windows == {index: (0, SLOTS) for index in range(5)}


# ---------------------------------------------------------------------------
# One frame
# ---------------------------------------------------------------------------


def test_an_every_day_frame_applies_to_every_day() -> None:
    windows = day_windows([frame(4, 6, "08:00", "15:00")], years(4, 4), GRID)
    assert windows == {index: (0, slot("15:00")) for index in range(5)}


def test_a_weekday_frame_touches_only_that_weekday() -> None:
    windows = day_windows([frame(4, 6, "08:00", "13:00", day=5)], years(4, 4), GRID)

    assert windows[4] == (0, slot("13:00"))
    for index in range(4):
        assert windows[index] == (0, SLOTS)


def test_a_late_start_moves_the_open_slot() -> None:
    windows = day_windows([frame(4, 6, "09:00", "15:00")], years(4, 4), GRID)
    assert windows[0] == (slot("09:00"), slot("15:00"))


# ---------------------------------------------------------------------------
# Composition — the rule the whole design rests on
# ---------------------------------------------------------------------------


def test_a_weekday_frame_narrows_the_every_day_frame() -> None:
    """"08:00-15:00 always, 08:00-13:00 on Friday" means the obvious thing.

    Both frames match a Friday, so both apply and the intersection is Friday's
    window. No precedence rule is needed or wanted: a school that writes the
    two rows has said something about Friday that is narrower than what it said
    about the week, and the narrower statement is the one it meant.
    """
    frames = [frame(4, 6, "08:00", "15:00"), frame(4, 6, "08:00", "13:00", day=5)]
    windows = day_windows(frames, years(4, 4), GRID)

    assert windows[0] == (0, slot("15:00"))
    assert windows[4] == (0, slot("13:00"))


def test_a_group_straddling_two_stages_gets_the_tighter_window() -> None:
    """A 6-7 group overlaps both a 4-6 frame and a 7-9 one, so both bind it.

    The alternative reading — take the wider, or take neither — puts its year-6
    pupils in a classroom during an afternoon their own stage has closed. This
    one costs the timetable some room, which is the survivable error of the two.
    """
    frames = [frame(4, 6, "08:00", "15:00"), frame(7, 9, "08:00", "16:00")]
    windows = day_windows(frames, years(6, 7), GRID)

    assert windows[0] == (0, slot("15:00"))


def test_frames_narrow_from_both_ends_at_once() -> None:
    frames = [frame(4, 6, "09:00", "16:00"), frame(4, 6, "08:00", "15:00", day=1)]
    windows = day_windows(frames, years(4, 4), GRID)

    assert windows[0] == (slot("09:00"), slot("15:00"))
    assert windows[1] == (slot("09:00"), slot("16:00"))


# ---------------------------------------------------------------------------
# The edges of the configured day
# ---------------------------------------------------------------------------


def test_a_frame_wider_than_the_school_day_is_clamped_not_refused() -> None:
    """A school describing hours the engine does not model is not in error."""
    windows = day_windows([frame(4, 6, "06:00", "22:00")], years(4, 4), GRID)
    assert windows == {index: (0, SLOTS) for index in range(5)}


def test_a_frame_ending_exactly_at_the_day_end_keeps_the_last_slot() -> None:
    windows = day_windows([frame(4, 6, "08:00", "18:00")], years(4, 4), GRID)
    assert windows[0] == (0, SLOTS)


def test_a_frame_entirely_before_the_school_day_closes_it() -> None:
    """Absent, not (0, 0).

    A day the frames close is a different fact from a day with a full window,
    and the caller has to be able to tell them apart: one is a school that
    wrote nothing about Friday, the other is a school that closed it.
    """
    windows = day_windows([frame(4, 6, "05:00", "07:00")], years(4, 4), GRID)
    assert windows == {}


def test_a_frame_entirely_after_the_school_day_closes_it() -> None:
    windows = day_windows([frame(4, 6, "19:00", "21:00")], years(4, 4), GRID)
    assert windows == {}


def test_two_frames_that_cannot_both_hold_close_the_day() -> None:
    frames = [frame(4, 6, "08:00", "10:00"), frame(4, 6, "14:00", "16:00")]
    assert day_windows(frames, years(4, 4), GRID) == {}


# ---------------------------------------------------------------------------
# Rounding, which goes inward at both ends
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        # A 15-minute grid on a day starting at 08:00: 08:10 is not a boundary.
        ("08:10", "15:00", (1, 28)),
        # ...and neither is 14:50, which must not gain the slot it sits inside.
        ("08:00", "14:50", (0, 27)),
    ],
)
def test_a_frame_off_the_grid_loses_the_partial_slot(
    start: str, end: str, expected: tuple[int, int],
) -> None:
    """Inward at both ends: ceil the open, floor the close.

    Rounding outward would let a lesson start before the frame opens or run
    past its close, which is the school's own sentence broken by arithmetic.
    """
    grid = TimeGrid(
        day_start_minutes=480, day_end_minutes=1080, slot_minutes=15,
        schedule_days=(1, 2, 3, 4, 5),
    )
    windows = day_windows([frame(4, 6, start, end)], years(4, 4), grid)
    assert windows[0] == expected
