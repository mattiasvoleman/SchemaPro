"""Raster, at the level where the rule is visible.

An end-to-end run proves a declared rast keeps lessons out. These prove the
rules that decide WHICH minutes are kept, and a feasible schedule cannot tell
them apart: a lesson at 10:00 satisfies a model that blocked 09:40-10:00 and one
that blocked nothing equally, on a week with room to spare.

The three that matter, and each has bitten a sibling module:

  OUTWARD ROUNDING. Frames and servings round INWARD because they permit; a rast
  reserves, so a window that misses the grid must take the partial slot or a
  lesson lands in minutes the school gave away.

  OVERLAP SHADOWING. servings.py replaces every every-day row on a day that
  names one. Applied here it deletes a stage's other Friday rasts in silence.

  THE WIDEST FREE RUN. A frame leaves one window and its width is the answer;
  rasts leave fragments, and a lesson needs one of them whole.
"""

from __future__ import annotations

import pytest

from app.schemas.schedule import Rast
from app.solver.rasts import blocks_for, forbidden_starts
from app.solver.time_grid import TimeGrid

# 08:00-18:00, five days, five-minute slots. The real grid.
GRID = TimeGrid(
    day_start_minutes=480, day_end_minutes=1080, slot_minutes=5,
    schedule_days=(1, 2, 3, 4, 5),
)

MIDDLE = (4, 6)


def rast(
    start: str,
    end: str,
    day: int | None = None,
    min_grade: int = 4,
    max_grade: int = 6,
) -> Rast:
    return Rast.model_validate(
        {
            "minGradeLevel": min_grade,
            "maxGradeLevel": max_grade,
            "dayOfWeek": day,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
        },
    )


def slots(hhmm: str) -> int:
    hours, minutes = (int(part) for part in hhmm.split(":"))
    return (hours * 60 + minutes - GRID.day_start_minutes) // GRID.slot_minutes


class TestMatching:
    def test_a_stage_whose_years_touch_the_span_is_bound(self) -> None:
        # A 6-7 group has year-6 children in it. Containment would leave them
        # taught through their own stage's rast.
        assert blocks_for([rast("09:40", "10:00")], (6, 7), 1, GRID) == [
            (slots("09:40"), slots("10:00")),
        ]

    def test_a_stage_the_rast_does_not_reach_is_free(self) -> None:
        assert blocks_for([rast("09:40", "10:00")], (7, 9), 1, GRID) == []

    def test_a_group_with_no_years_matches_nothing(self) -> None:
        # The answer frames and servings already give, and for the same reason:
        # "overlaps" has no answer against nothing.
        assert blocks_for([rast("09:40", "10:00")], None, 1, GRID) == []


class TestRounding:
    def test_a_window_off_the_grid_takes_the_whole_slot(self) -> None:
        # 09:42-09:53 on a five-minute grid becomes 09:40-09:55. Rounding inward
        # would leave 09:45-09:50 and put a lesson in minutes the school gave
        # away — which is exactly what a frame SHOULD do and a rast must not.
        assert blocks_for([rast("09:42", "09:53")], MIDDLE, 1, GRID) == [
            (slots("09:40"), slots("09:55")),
        ]

    def test_a_three_minute_rast_survives(self) -> None:
        # Outward rounding is why no minimum length is needed anywhere: three
        # minutes is one slot rather than nothing, and three minutes is what a
        # changeover between two rooms is.
        assert blocks_for([rast("09:41", "09:44")], MIDDLE, 1, GRID) == [
            (slots("09:40"), slots("09:45")),
        ]

    def test_a_rast_outside_the_configured_day_constrains_nothing(self) -> None:
        assert blocks_for([rast("06:00", "07:00")], MIDDLE, 1, GRID) == []


class TestEveryRowApplies:
    def test_several_rasts_a_day_all_bind(self) -> None:
        # The ordinary Swedish week. A rule that kept one would be a rule that
        # deleted the others.
        blocks = blocks_for(
            [rast("13:00", "13:15"), rast("09:40", "10:00")], MIDDLE, 1, GRID,
        )
        assert blocks == [
            (slots("09:40"), slots("10:00")),
            (slots("13:00"), slots("13:15")),
        ]

    def test_touching_rows_merge_into_one_block(self) -> None:
        blocks = blocks_for(
            [rast("09:40", "10:00"), rast("10:00", "10:10")], MIDDLE, 1, GRID,
        )
        assert blocks == [(slots("09:40"), slots("10:10"))]


class TestWeekdayShadowing:
    def test_a_friday_row_replaces_the_every_day_row_it_overlaps(self) -> None:
        rows = [rast("09:40", "10:00"), rast("09:30", "09:50", day=5)]
        assert blocks_for(rows, MIDDLE, 5, GRID) == [
            (slots("09:30"), slots("09:50")),
        ]
        assert blocks_for(rows, MIDDLE, 1, GRID) == [
            (slots("09:40"), slots("10:00")),
        ]

    def test_it_keeps_the_rasts_the_friday_row_does_not_overlap(self) -> None:
        """The case this module does not share with servings.py.

        servings.py computes `today or [every-day rows]`, so ANY day-specific
        row deletes ALL every-day rows for that day. A school with three rasts
        for åk 4-6 that adds "fredag 09:30-09:50" would lose its midday and
        afternoon breaks every Friday — the engine would teach straight through
        them and publish would write a one-rast Friday to every pupil in the
        stage.
        """
        rows = [
            rast("09:40", "10:00"),
            rast("11:30", "11:45"),
            rast("13:00", "13:15"),
            rast("09:30", "09:50", day=5),
        ]
        assert blocks_for(rows, MIDDLE, 5, GRID) == [
            (slots("09:30"), slots("09:50")),
            (slots("11:30"), slots("11:45")),
            (slots("13:00"), slots("13:15")),
        ]


class TestForbiddenStarts:
    @pytest.mark.parametrize("duration", [1, 6, 12])
    def test_a_lesson_may_not_start_where_it_would_run_into_a_rast(
        self, duration: int,
    ) -> None:
        # A lesson of `duration` overlaps [b0, b1) exactly when it starts in
        # [b0 - duration + 1, b1 - 1].
        blocks = [(100, 104)]
        assert forbidden_starts(blocks, duration) == [(100 - duration + 1, 103)]

    def test_a_block_at_the_start_of_the_day_forbids_nothing_before_it(self) -> None:
        # Clamped at zero rather than allowed to go negative: a negative bound
        # would make the subtraction silently wider than the rast.
        assert forbidden_starts([(0, 4)], 6) == [(0, 3)]

    def test_a_lesson_ending_exactly_when_the_rast_begins_is_allowed(self) -> None:
        # The half-open rule every other window comparison in this codebase
        # uses. A rast that refused the lesson before it would refuse the
        # ordinary case it exists to create.
        (first, last) = forbidden_starts([(100, 104)], 6)[0]
        assert 94 not in range(first, last + 1)
        assert 95 in range(first, last + 1)
