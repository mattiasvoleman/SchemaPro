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
from app.solver.rasts import blocks_for, blocks_with_demand, forbidden_starts
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
    *,
    asks: bool = False,
    grades: tuple[int, int] | None = None,
) -> Rast:
    if grades is not None:
        min_grade, max_grade = grades
    return Rast.model_validate(
        {
            "minGradeLevel": min_grade,
            "maxGradeLevel": max_grade,
            "dayOfWeek": day,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
            "requiresLessonBefore": asks,
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


class TestTheDemandRidesTheMerge:
    """Which blocks ask for a lesson before them, once shadowing has run.

    The ordering rule used to ask each row on its own — `blocks_for([rast], …)`
    — and a row read alone cannot know it has been replaced. Every case here
    fails under that reading, and none of them is visible in a finished
    schedule: the week simply comes back missing a day, or missing the rule.
    """

    def test_a_day_that_replaces_an_asking_row_replaces_its_demand(self) -> None:
        """The Friday that cost a school its Friday.

        An every-day break at 09:40 asks for a lesson before it; Friday starts
        at 11:00 instead, written as one long rast. Read row by row, Friday
        still had to be taught before 09:40 and could not be taught before
        11:00 — so the class was barred from Friday altogether, and a week that
        solved in five seconds spent the whole budget.
        """
        rows = [rast("09:40", "10:00", asks=True), rast("08:00", "11:00", day=5)]

        monday = blocks_with_demand(rows, MIDDLE, 1, GRID)
        assert monday == [(20, 24, True)]

        friday = blocks_with_demand(rows, MIDDLE, 5, GRID)
        assert friday == [(0, 36, False)], "the 09:40 break does not exist on Friday"

    def test_a_replacement_that_also_asks_keeps_the_demand(self) -> None:
        """Shadowing replaces the row, not the school's intention.

        The Friday row carries the tick too, so Friday owes a lesson — before
        ELEVEN, which is where Friday's break actually is.
        """
        rows = [
            rast("09:40", "10:00", asks=True),
            rast("08:00", "11:00", day=5, asks=True),
        ]

        assert blocks_with_demand(rows, MIDDLE, 5, GRID) == [(0, 36, True)]

    def test_a_silent_neighbour_moves_the_boundary_it_does_not_cancel_it(self) -> None:
        """Two rows that touch are one break as it is lived.

        09:20-09:40 is silent and 09:40-10:00 asks; the class is owed a lesson
        before the pair, not before the second row's start, because 09:20-09:40
        is not a minute anyone can be taught in.
        """
        rows = [rast("09:20", "09:40"), rast("09:40", "10:00", asks=True)]

        assert blocks_with_demand(rows, MIDDLE, 1, GRID) == [(16, 24, True)]

    def test_a_stage_the_asking_row_does_not_reach_is_owed_nothing(self) -> None:
        """The demand matches on years like everything else here."""
        rows = [rast("09:40", "10:00", asks=True, grades=(7, 9))]

        assert blocks_with_demand(rows, MIDDLE, 1, GRID) == []

    def test_blocks_for_is_the_same_list_without_the_flag(self) -> None:
        """One implementation, two readings — so they can never disagree.

        Asserted rather than assumed: `blocks_for` is what subtracts the
        minutes from every lesson's domain, and a second merge written beside
        it would eventually round one of them differently.
        """
        rows = [
            rast("09:40", "10:00", asks=True),
            rast("11:00", "11:20"),
            rast("08:00", "11:00", day=5),
        ]

        for day in (1, 5):
            assert blocks_for(rows, MIDDLE, day, GRID) == [
                (first, last)
                for first, last, _asks in blocks_with_demand(rows, MIDDLE, day, GRID)
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
