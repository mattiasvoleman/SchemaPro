"""Lunchsittningar, at the level where the rule is visible.

The end-to-end tests prove a declared flow comes out of the solver. These prove
the rule that decides it — union across spans, shadowing across weekdays, and
the difference between "nothing declared" and "declared too tight". A feasible
schedule cannot tell those apart: a class eating at 11:15 satisfies a sitting
that opens at 11:00 and one that opens at 11:15 equally.
"""

from __future__ import annotations

from app.schemas.schedule import LunchServing
from app.solver.servings import allowed_starts
from app.solver.time_grid import TimeGrid

# 08:00-18:00, five days, five-minute slots. The real grid.
GRID = TimeGrid(
    day_start_minutes=480, day_end_minutes=1080, slot_minutes=5,
    schedule_days=(1, 2, 3, 4, 5),
)
#: A thirty-minute meal, in slots.
MEAL = 6


def serving(
    min_grade: int,
    max_grade: int,
    start: str,
    end: str,
    day: int | None = None,
) -> LunchServing:
    return LunchServing.model_validate(
        {
            "minGradeLevel": min_grade,
            "maxGradeLevel": max_grade,
            "dayOfWeek": day,
            "startTime": f"{start}:00",
            "endTime": f"{end}:00",
        },
    )


def slot(clock: str) -> int:
    hours, minutes = (int(part) for part in clock.split(":"))
    return (hours * 60 + minutes - GRID.day_start_minutes) // GRID.slot_minutes


def starts(domain) -> list[int]:  # noqa: ANN001
    flat = domain.FlattenedIntervals()
    out: list[int] = []
    for i in range(0, len(flat), 2):
        out.extend(range(flat[i], flat[i + 1] + 1))
    return out


# ---------------------------------------------------------------------------
# Nothing declared
# ---------------------------------------------------------------------------


def test_no_servings_leaves_the_school_window_alone() -> None:
    """None, not an empty domain — the two mean opposite things.

    None is "nobody said anything about this group", which must leave the
    school-wide lunch window in place. An empty domain is "the school declared
    something too tight", which is a refusal.
    """
    assert allowed_starts([], (4, 6), 1, MEAL, GRID) is None


def test_a_serving_for_another_stage_says_nothing() -> None:
    assert allowed_starts([serving(7, 9, "12:20", "13:00")], (4, 4), 1, MEAL, GRID) is None


def test_a_group_with_unknown_years_is_unconstrained() -> None:
    # Overlap has no answer against nothing, and answering yes would sweep every
    # yearless group into a sitting written for one stage.
    assert allowed_starts([serving(0, 12, "11:00", "11:40")], None, 1, MEAL, GRID) is None


# ---------------------------------------------------------------------------
# One sitting
# ---------------------------------------------------------------------------


def test_a_sitting_bounds_the_meal_at_both_ends() -> None:
    domain = allowed_starts([serving(4, 6, "11:40", "12:20")], (4, 6), 1, MEAL, GRID)

    assert domain is not None
    # A meal may begin at 11:40 and, ending at 12:20, no later than 11:50.
    assert starts(domain) == list(range(slot("11:40"), slot("11:50") + 1))


def test_a_weekday_sitting_touches_only_that_weekday() -> None:
    servings = [serving(4, 6, "11:40", "12:20", day=5)]

    assert allowed_starts(servings, (4, 6), 5, MEAL, GRID) is not None
    assert allowed_starts(servings, (4, 6), 1, MEAL, GRID) is None


def test_a_sitting_exactly_one_meal_long_leaves_one_start() -> None:
    domain = allowed_starts([serving(4, 6, "11:00", "11:30")], (4, 6), 1, MEAL, GRID)

    assert starts(domain) == [slot("11:00")]


def test_a_sitting_shorter_than_the_meal_is_empty_not_absent() -> None:
    """The refusal case, and it must not read as "nothing declared".

    Returned as an empty domain so _validate_request can name it; returned as
    None it would silently restore the school-wide window and feed the stage at
    a time the school explicitly closed.
    """
    domain = allowed_starts([serving(4, 6, "11:00", "11:20")], (4, 6), 1, MEAL, GRID)

    assert domain is not None
    assert domain.is_empty()


# ---------------------------------------------------------------------------
# Composition — union across spans, shadow across weekdays
# ---------------------------------------------------------------------------


def test_a_group_straddling_two_stages_may_use_either_sitting() -> None:
    """UNION, and this is the opposite of what frames do.

    A serving grants permission where a frame imposes a bound. Intersecting a
    4-6 sitting with a 7-9 one would leave a 6-7 group nowhere at all — two
    disjoint windows have no overlap — and the class would be refused a meal
    the school has room for twice over.
    """
    servings = [serving(4, 6, "11:40", "12:20"), serving(7, 9, "12:20", "13:00")]

    domain = allowed_starts(servings, (6, 7), 1, MEAL, GRID)

    assert slot("11:40") in starts(domain)
    assert slot("12:20") in starts(domain)


def test_a_weekday_row_replaces_the_every_day_row_rather_than_widening_it() -> None:
    """"Alla dagar 12:20-13:00" plus "fredag 11:40-12:20" means Friday DIFFERS.

    Unioning them would give Friday 11:40-13:00 — wider than either, and the one
    reading nobody meant. The rule is that a day-specific row shadows.
    """
    servings = [
        serving(7, 9, "12:20", "13:00"),
        serving(7, 9, "11:40", "12:20", day=5),
    ]

    monday = starts(allowed_starts(servings, (7, 9), 1, MEAL, GRID))
    friday = starts(allowed_starts(servings, (7, 9), 5, MEAL, GRID))

    assert monday == list(range(slot("12:20"), slot("12:30") + 1))
    assert friday == list(range(slot("11:40"), slot("11:50") + 1))
    assert slot("12:30") not in friday


def test_two_waves_for_one_stage_union_into_both() -> None:
    # No unique key on the table, precisely so a school with a hall smaller than
    # its 7-9 can write both waves by hand.
    servings = [
        serving(7, 9, "11:40", "12:10"),
        serving(7, 9, "12:20", "12:50"),
    ]

    got = starts(allowed_starts(servings, (7, 9), 1, MEAL, GRID))

    assert got == [slot("11:40"), slot("12:20")]


def test_one_unusable_wave_does_not_empty_the_other() -> None:
    # A window too short for the meal contributes nothing rather than emptying
    # the union: the other wave can still take the stage.
    servings = [
        serving(7, 9, "11:40", "11:50"),
        serving(7, 9, "12:20", "12:50"),
    ]

    assert starts(allowed_starts(servings, (7, 9), 1, MEAL, GRID)) == [slot("12:20")]


# ---------------------------------------------------------------------------
# The edges of the grid
# ---------------------------------------------------------------------------


def test_a_sitting_off_the_grid_loses_the_partial_slot() -> None:
    """Inward at both ends, as frames round: a meal may not begin before the
    hall opens and may not run past its close."""
    grid = TimeGrid(
        day_start_minutes=480, day_end_minutes=1080, slot_minutes=15,
        schedule_days=(1, 2, 3, 4, 5),
    )
    # 11:05-11:55 on a quarter-hour grid: opens 11:15, closes 11:45.
    domain = allowed_starts([serving(4, 6, "11:05", "11:55")], (4, 6), 1, 2, grid)

    flat = domain.FlattenedIntervals()
    first, last = flat[0], flat[-1]
    assert first == (11 * 60 + 15 - 480) // 15
    assert last == (11 * 60 + 45 - 480) // 15 - 2


def test_a_sitting_reaching_past_the_school_day_is_clamped() -> None:
    domain = allowed_starts([serving(4, 6, "06:00", "22:00")], (4, 6), 1, MEAL, GRID)

    got = starts(domain)
    assert got[0] == 0
    assert got[-1] == GRID.slots_per_day - MEAL
