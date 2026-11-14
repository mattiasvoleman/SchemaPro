"""app/solver/weeks.py on its own: the weeks of a year, and a row cut by them.

Three kinds of test:

- the READING: a requirement's parity and periods are the concrete weeks it
  runs in, and two entries meet exactly when the fields say so — against an
  oracle that reads the two fields directly and shares no code with the module;
- the CUT: `week_parts` and `each_week` against what every concrete week
  holds, on random rows, with and without locks beside them and past the cap;
- the PROMISE: for a year without periods, the parts, their order and their
  names are the ones the module made when it knew only odd and even weeks —
  against a copy of that module's `week_parts`, kept here for the purpose.
"""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest

from app.solver.weeks import (
    EVEN_WEEKS,
    ODD_WEEKS,
    PART_LIMIT,
    ROW_LIMIT,
    Weeks,
    alternates,
    each_week,
    half_weeks,
    meet,
    cells_of,
    named,
    needs_a_part_per_parity,
    share,
    tag,
    week_parts,
    weeks_of,
    year_of,
)

ODD, EVEN = "ODD_WEEKS", "EVEN_WEEKS"
PARITIES = (None, ODD, EVEN)


def _entry(recurrence: str | None = None, periods: list[bool] | None = None) -> SimpleNamespace:
    return SimpleNamespace(recurrence=recurrence, periods=None if periods is None else tuple(periods))


def _random_mask(rng: random.Random, periods: int) -> list[bool] | None:
    """None, or a mask that names some period and not every one."""
    if rng.random() < 0.3:
        return None
    while True:
        mask = [rng.random() < 0.5 for _ in range(periods)]
        if any(mask) and not all(mask):
            return mask


def _concrete(entry: SimpleNamespace, periods: int) -> set[tuple[int, str]]:
    """The oracle: the (period, parity) weeks an entry runs in, read off its two fields."""
    return {
        (period, parity)
        for period in range(periods)
        for parity in (ODD, EVEN)
        if (entry.periods is None or entry.periods[period])
        and entry.recurrence in (None, parity)
    }


# ---------------------------------------------------------------------------
# The reading
# ---------------------------------------------------------------------------


def test_every_week_is_none_and_a_parity_alone_is_that_parity() -> None:
    assert weeks_of(_entry()) is None
    assert weeks_of(_entry(ODD)) == ODD_WEEKS
    assert weeks_of(_entry(EVEN)) == EVEN_WEEKS
    # A stand-in that carries neither field runs every week.
    assert weeks_of(SimpleNamespace()) is None
    assert weeks_of(SimpleNamespace(recurrence=ODD)) == ODD_WEEKS


def test_a_mask_is_its_periods_in_the_entrys_parity() -> None:
    autumn = weeks_of(_entry(periods=[True, False, False]))
    assert autumn == Weeks(0b000011, 3)
    assert weeks_of(_entry(ODD, [True, False, True])) == Weeks(0b010001, 3)
    assert weeks_of(_entry(EVEN, [False, True, False])) == Weeks(0b001000, 3)
    # A list is read as the tuple the schema holds.
    assert weeks_of(SimpleNamespace(recurrence=None, periods=[True, False, False])) == autumn


def test_two_entries_meet_exactly_when_some_period_and_parity_holds_both() -> None:
    rng = random.Random(20261111)
    seen = {True: 0, False: 0}
    for _ in range(20_000):
        periods = rng.randint(2, 6)
        first = _entry(rng.choice(PARITIES), _random_mask(rng, periods))
        second = _entry(rng.choice(PARITIES), _random_mask(rng, periods))
        expected = bool(_concrete(first, periods) & _concrete(second, periods))
        assert meet(weeks_of(first), weeks_of(second)) is expected, (first, second)
        assert meet(weeks_of(second), weeks_of(first)) is expected
        seen[expected] += 1
    # Both answers were asked for, often.
    assert min(seen.values()) > 2_000


def test_meet_is_the_product_of_the_two_fields() -> None:
    """Periods that share one AND parities that are not opposed: weeksCanOverlap's shape."""
    rng = random.Random(7)
    for _ in range(5_000):
        periods = rng.randint(2, 5)
        first = _entry(rng.choice(PARITIES), _random_mask(rng, periods))
        second = _entry(rng.choice(PARITIES), _random_mask(rng, periods))
        share_a_period = (
            first.periods is None or second.periods is None
            or any(a and b for a, b in zip(first.periods, second.periods))
        )
        opposed = {first.recurrence, second.recurrence} == {ODD, EVEN}
        assert meet(weeks_of(first), weeks_of(second)) is (share_a_period and not opposed)


def test_meet_reads_the_gateways_own_names() -> None:
    assert meet(ODD, None) and meet(None, EVEN) and meet(ODD, ODD)
    assert not meet(ODD, EVEN)
    assert not meet(ODD, EVEN_WEEKS)
    assert meet(ODD, weeks_of(_entry(ODD, [True, False])))
    assert not meet(EVEN, weeks_of(_entry(ODD, [True, False])))


def test_a_parity_alone_is_that_parity_of_every_period() -> None:
    assert ODD_WEEKS.lifted(3) == 0b010101
    assert EVEN_WEEKS.lifted(2) == 0b1010
    autumn_even = weeks_of(_entry(EVEN, [True, False]))
    assert meet(EVEN_WEEKS, autumn_even) and not meet(ODD_WEEKS, autumn_even)


def test_two_cuts_of_one_year_cannot_be_compared() -> None:
    with pytest.raises(ValueError, match="periods"):
        meet(Weeks(0b0011, 2), Weeks(0b000011, 3))


def test_alternates_is_any_that_runs_in_some_weeks_only() -> None:
    assert not alternates([None, None])
    assert alternates([None, ODD_WEEKS])
    assert alternates([weeks_of(_entry(periods=[True, False]))])


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------


def test_a_year_without_periods_keeps_the_names_it_had() -> None:
    assert tag("first", None) == "first"
    assert tag("first", ODD_WEEKS) == "first_odd"
    assert tag("first", EVEN_WEEKS) == "first_even"
    assert tag("first", ODD) == "first_odd"
    assert f"{ODD_WEEKS}" == ODD and f"{EVEN_WEEKS}" == EVEN
    assert f"{ODD_WEEKS or 'all'}" == ODD
    # Sorted by name, as the gateway's names always sorted.
    assert sorted([ODD_WEEKS, EVEN_WEEKS]) == [EVEN_WEEKS, ODD_WEEKS]


def test_a_period_is_named_by_its_index_and_its_parity_if_it_has_one() -> None:
    assert tag("first", Weeks(0b000011, 3)) == "first_p0"
    assert tag("first", Weeks(0b110000, 3)) == "first_p2"
    assert tag("first", Weeks(0b000100, 3)) == "first_p1_odd"
    assert tag("first", Weeks(0b001000, 3)) == "first_p1_even"
    # Several periods joined are named by the first.
    assert tag("first", Weeks(0b111100, 3)) == "first_p1"
    assert str(Weeks(0b001000, 3)) == "p1_even"


def test_the_parts_of_one_row_have_different_names() -> None:
    rng = random.Random(11)
    for _ in range(2_000):
        periods = rng.randint(2, 6)
        items = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 9))]
        for implied in (True, False):
            names = [tag("x", week) for week, _ in week_parts(items, weeks_of, implied=implied)]
            assert len(set(names)) == len(names)


def test_what_a_refusal_says_of_its_week() -> None:
    assert named(None) == {}
    # A year without periods is told nothing it was not told before.
    assert named(ODD_WEEKS) == {} and named(EVEN) == {}
    assert named(Weeks(0b001100, 3)) == {"period": 1}
    assert named(Weeks(0b000100, 3)) == {"period": 1, "parity": ODD}
    assert named(Weeks(0b100000, 3)) == {"period": 2, "parity": EVEN}
    # Weeks of several periods are named by the first, as they were, and say
    # every one beside it: a flat value, in order, and only then.
    assert named(Weeks(0b111100, 3)) == {"period": 1, "periods": "1,2"}
    assert named(Weeks(0b110011, 3)) == {"period": 0, "periods": "0,2"}
    assert named(Weeks(0b010001, 3)) == {"period": 0, "periods": "0,2", "parity": ODD}
    assert named(Weeks(0b101010, 3)) == {"period": 0, "periods": "0,1,2", "parity": EVEN}
    assert "periods" not in named(Weeks(0b000011, 3))
    assert Weeks(0b110011, 3).held() == (0, 2)
    assert Weeks(0b001000, 3).held() == (1,)
    assert ODD_WEEKS.held() == ()


def test_the_masks_read_are_remembered_up_to_a_bound() -> None:
    """An engine process outlives its requests: what it remembers of their masks has a ceiling."""
    from app.solver import weeks

    assert weeks._span.cache_info().maxsize == weeks._lift.cache_info().maxsize == 4096
    # Past the bound the oldest reading is forgotten and read again, the same.
    autumn = weeks_of(_entry(periods=[True, False]))
    for periods in range(2, 54):
        for first in range(periods):
            weeks_of(_entry(periods=[index == first for index in range(periods)]))
            weeks_of(_entry(ODD, [index != first for index in range(periods)]) if periods > 2 else _entry(ODD))
    assert weeks._span.cache_info().currsize <= 4096
    assert weeks_of(_entry(periods=[True, False])) == autumn == Weeks(0b0011, 2)


# ---------------------------------------------------------------------------
# The cut
# ---------------------------------------------------------------------------


def _weeks_holding(items: list[SimpleNamespace], periods: int) -> dict[tuple[int, str], list[int]]:
    """The oracle: every concrete week with a member, and the members it holds, by position."""
    held: dict[tuple[int, str], list[int]] = {}
    for period in range(periods):
        for parity in (ODD, EVEN):
            inside = [
                index for index, item in enumerate(items) if (period, parity) in _concrete(item, periods)
            ]
            if inside:
                held[(period, parity)] = inside
    return held


def _positions(items: list[SimpleNamespace], members: list[SimpleNamespace]) -> list[int]:
    """Where each member stands in the row — by identity: two entries may say the same."""
    where = {id(item): index for index, item in enumerate(items)}
    return [where[id(member)] for member in members]


def _bits(week: Weeks | None, periods: int) -> set[tuple[int, str]]:
    if week is None:
        return {(period, parity) for period in range(periods) for parity in (ODD, EVEN)}
    lifted = week.lifted(periods)
    return {
        (index // 2, ODD if index % 2 == 0 else EVEN)
        for index in range(2 * periods)
        if lifted >> index & 1
    }


def test_a_row_of_every_week_is_posted_once() -> None:
    items = ["a", "b", "c"]
    assert week_parts(items, lambda _: None) == [(None, items)]
    assert week_parts(items, lambda _: None, implied=False) == [(None, items)]
    assert week_parts(items, lambda _: None, others=[None, None]) == [(None, items)]
    assert each_week([None, None]) == (None,)
    assert each_week([]) == (None,)


def test_a_not_implied_row_has_one_part_per_distinct_week_and_exactly_its_members() -> None:
    """The row a missing member can break: every week's own members, never two joined."""
    rng = random.Random(3)
    many = 0
    for _ in range(3_000):
        periods = rng.randint(2, 12)
        items = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 14))]
        held = _weeks_holding(items, periods)
        parts = week_parts(items, weeks_of, implied=False)
        if not alternates(weeks_of(item) for item in items):
            assert parts == [(None, items)]
            continue
        covered: set[tuple[int, str]] = set()
        for week, members in parts:
            weeks = _bits(week, periods)
            assert not weeks & covered, "a concrete week is in one part"
            covered |= weeks
            positions = _positions(items, members)
            assert positions == sorted(positions), "in the order given"
            for concrete in weeks:
                # Exactly this week's members: no lesson of another week among them.
                assert held[concrete] == positions
        assert covered == set(held), "every week with a member has its part"
        assert len({tuple(_positions(items, members)) for _, members in parts}) == len(parts)
        many += len(parts) > PART_LIMIT
    # Rows with more parts than the cap were among them, and were not joined.
    assert many > 50


def _implied_row_is_sound(items: list[SimpleNamespace], periods: int, **how: object) -> tuple[int, int]:
    """Check one implied row against every concrete week; (largest weeks, parts) for the caller."""
    held = _weeks_holding(items, periods)
    parts = week_parts(items, weeks_of, **how)  # type: ignore[arg-type]
    sets = [frozenset(_positions(items, members)) for _, members in parts]
    # Sound: whatever runs together in a real week is held together by some part.
    for inside in held.values():
        assert any(set(inside) <= part for part in sets), (inside, sets)
    # And no part says only what another says.
    for index, part in enumerate(sets):
        assert not any(part <= other for position, other in enumerate(sets) if position != index)
    distinct = {frozenset(inside) for inside in held.values()}
    maximal = {a for a in distinct if not any(a < b for b in distinct)}
    if len(sets) == len(maximal):
        # Nothing joined: the parts ARE the largest weeks.
        assert set(sets) == maximal
    else:
        # Joined: fewer parts, each a union of real weeks' members and never more.
        assert len(sets) < len(maximal)
        for part in sets:
            assert part == frozenset().union(*(a for a in distinct if a <= part))
    return len(maximal), len(sets)


def test_a_small_implied_row_is_cut_exactly_however_many_weeks_it_has() -> None:
    """A teacher's or a class's own lessons: every largest week is a part, none joined."""
    rng = random.Random(5)
    past_the_limit = 0
    for _ in range(3_000):
        periods = rng.randint(2, 12)
        items = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 14))]
        if not alternates(weeks_of(item) for item in items):
            continue
        maximal, parts = _implied_row_is_sound(items, periods)
        assert parts == maximal
        past_the_limit += maximal > PART_LIMIT
    assert past_the_limit > 20


def test_a_large_implied_row_is_joined_and_never_looser_than_the_weeks_it_joins() -> None:
    """A pool of a school's lessons over twelve terms: twelve largest weeks become eight."""
    rng = random.Random(6)
    joined = 0
    for _ in range(40):
        periods = 12
        items = [_entry() for _ in range(ROW_LIMIT // 8)] + [
            _entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(40)
        ]
        maximal, parts = _implied_row_is_sound(items, periods)
        assert parts <= PART_LIMIT < maximal
        joined += 1
        # Asked not to, it is cut exactly.
        assert _implied_row_is_sound(items, periods, capped=False) == (maximal, maximal)
    assert joined == 40


def test_a_large_not_implied_row_is_never_joined() -> None:
    """A row a missing member can break, over a school's lessons and twelve periods: every week its own."""
    rng = random.Random(8)
    for _ in range(20):
        periods = 12
        items = [_entry() for _ in range(ROW_LIMIT // 8)] + [
            _entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(40)
        ]
        held = _weeks_holding(items, periods)
        parts = week_parts(items, weeks_of, implied=False)
        distinct = {tuple(inside) for inside in held.values()}
        assert len(parts) == len(distinct) > PART_LIMIT
        assert {tuple(_positions(items, members)) for _, members in parts} == distinct
        # And no part of any row is the whole year: something in it runs in some weeks only.
        assert all(week is not None for week, _ in parts)


def test_a_joined_row_holds_each_terms_lesson_in_one_part() -> None:
    """Twelve terms' lessons and a school's lessons of every week: twelve weeks become eight."""
    weekly = [_entry() for _ in range(ROW_LIMIT)]
    items = weekly + [_entry(periods=[p == q for q in range(12)]) for p in range(12)]
    assert len(week_parts(items, weeks_of, capped=False)) == 12
    joined = week_parts(items, weeks_of)
    assert len(joined) == PART_LIMIT
    sets = [set(_positions(items, part)) for _, part in joined]
    # Every every-week lesson is in every part, and each term's lesson in exactly one.
    assert all(set(range(ROW_LIMIT)) <= part for part in sets)
    assert sorted(index for part in sets for index in part if index >= ROW_LIMIT) == list(
        range(ROW_LIMIT, ROW_LIMIT + 12),
    )
    # The same twelve terms on a teacher's own few lessons are not joined at all.
    small = [_entry()] + items[ROW_LIMIT:]
    assert len(week_parts(small, weeks_of)) == 12
    # Unless a soft term asks: a measure may be coarser whatever its size.
    assert len(week_parts(small, weeks_of, implied=False, capped=True)) == PART_LIMIT
    assert len(week_parts(small, weeks_of, implied=False)) == 12


def test_locks_beside_a_row_cut_it_where_they_differ() -> None:
    items = ["a", "b"]
    autumn = Weeks(0b0011, 2)
    # A lock of the autumn makes two weeks of a row whose lessons run all year.
    parts = week_parts(items, lambda _: None, others=[autumn])
    assert parts == [(autumn, items), (Weeks(0b1100, 2), items)]
    # And nothing is left out as implied: the items cannot say which week the lock leaves easier.
    assert week_parts(items, {"a": None, "b": autumn}.get, others=[autumn]) == [
        (autumn, items), (Weeks(0b1100, 2), ["a"]),
    ]
    # Locks of every week cut nothing.
    assert week_parts(items, lambda _: None, others=[None]) == [(None, items)]
    assert week_parts(items, {"a": None, "b": autumn}.get, others=[None]) == [(autumn, items)]


def test_the_weeks_of_a_part_all_have_the_same_locks() -> None:
    rng = random.Random(9)
    for _ in range(2_000):
        periods = rng.randint(2, 6)
        items = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 7))]
        locks = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 5))]
        parts = week_parts(items, weeks_of, others=[weeks_of(lock) for lock in locks], capped=False)
        if parts[0][0] is None:
            continue
        for week, members in parts:
            concrete = sorted(_bits(week, periods))
            running = [
                [index for index, lock in enumerate(locks) if c in _concrete(lock, periods)]
                for c in concrete
            ]
            assert all(row == running[0] for row in running), "one part, one set of locks"
            # Which is what a reader gets by asking which locks meet the part's weeks.
            assert running[0] == [
                index for index, lock in enumerate(locks) if meet(weeks_of(lock), week)
            ]
            for c in concrete:
                assert [
                    i for i, item in enumerate(items) if c in _concrete(item, periods)
                ] == _positions(items, members)


def test_each_week_is_the_weeks_the_entries_tell_apart() -> None:
    rng = random.Random(13)
    for _ in range(2_000):
        periods = rng.randint(2, 8)
        entries = [_entry(rng.choice(PARITIES), _random_mask(rng, periods)) for _ in range(rng.randint(1, 8))]
        weeks = each_week(weeks_of(entry) for entry in entries)
        if not alternates(weeks_of(entry) for entry in entries):
            assert weeks == (None,)
            continue
        held = max(weeks_of(entry).periods for entry in entries if weeks_of(entry) is not None)
        covered: set[tuple[int, str]] = set()
        signatures = set()
        for week in weeks:
            concrete = _bits(week, held)
            assert concrete and not concrete & covered
            covered |= concrete
            running = {
                tuple(c in _concrete(entry, held) for entry in entries) for c in concrete
            }
            assert len(running) == 1, "one week, one set of entries"
            signatures |= running
        # Every concrete week of the year, each once; weeks with the same entries are one.
        assert covered == _bits(None, held)
        assert len(signatures) == len(weeks)


def test_each_week_capped_joins_weeks_past_the_limit() -> None:
    entries = [weeks_of(_entry(periods=[p == q for q in range(12)])) for p in range(12)]
    assert len(each_week(entries)) == 12
    capped = each_week(entries, capped=True)
    assert len(capped) == PART_LIMIT
    # Every entry still meets some week, and the weeks are still the whole year.
    assert all(any(meet(entry, week) for week in capped) for entry in entries)
    assert sum(week.bits for week in capped) == (1 << 24) - 1


# ---------------------------------------------------------------------------
# The promise to a year without periods
# ---------------------------------------------------------------------------


def _week_parts_before_periods(items, recurrence_of, *, implied=True, alternating=False):
    """weeks.week_parts as it was when the module knew two weeks (main f1ba07c7), verbatim."""
    old_weeks = (ODD, EVEN)

    def old_meet(first, second):
        return first is None or second is None or first == second

    members = list(items)
    parities = [recurrence_of(item) for item in members]
    if not alternating and not any(parity is not None for parity in parities):
        return [(None, members)]
    parts = [
        (week, [item for item, parity in zip(members, parities) if old_meet(parity, week)])
        for week in old_weeks
    ]
    if implied and not alternating:
        present = set(parities)
        if EVEN not in present:
            parts = [parts[0]]
        elif ODD not in present:
            parts = [parts[1]]
    return [(week, part) for week, part in parts if part]


def test_a_year_without_periods_is_cut_exactly_as_it_was() -> None:
    rng = random.Random(1)
    by_name = {None: None, ODD: ODD_WEEKS, EVEN: EVEN_WEEKS}
    for _ in range(20_000):
        items = list(range(rng.randint(0, 8)))
        parities = [rng.choice(PARITIES) for _ in items]
        locks = [rng.choice(PARITIES) for _ in range(rng.randint(0, 3))]
        for implied in (True, False):
            old = _week_parts_before_periods(
                items, parities.__getitem__, implied=implied,
                alternating=any(lock is not None for lock in locks),
            )
            new = week_parts(items, parities.__getitem__, implied=implied, others=locks)
            assert new == [(by_name[week], part) for week, part in old], (parities, locks, implied)
            # And under the same names.
            assert [tag("x", week) for week, _ in new] == [
                "x" if week is None else f"x_{'odd' if week == ODD else 'even'}" for week, _ in old
            ]


def test_each_week_of_a_year_without_periods_is_odd_then_even() -> None:
    assert each_week([None, ODD]) == (ODD_WEEKS, EVEN_WEEKS)
    assert each_week([EVEN]) == (ODD_WEEKS, EVEN_WEEKS)
    assert each_week([ODD_WEEKS, EVEN_WEEKS, None], capped=True) == (ODD_WEEKS, EVEN_WEEKS)


# ---------------------------------------------------------------------------
# The year's weights
# ---------------------------------------------------------------------------


def _request(period_weeks=None, requirements=(), fixed=()):
    return SimpleNamespace(
        period_weeks=period_weeks, requirements=list(requirements), fixed_lessons=list(fixed),
    )


def test_a_year_without_periods_is_one_period_and_weighs_as_it_did() -> None:
    plain = _request(requirements=[_entry()])
    assert year_of(plain) == [1]
    assert half_weeks(plain) == 2
    assert share(None, year_of(plain)) // half_weeks(plain) == 1
    alternating = _request(requirements=[_entry(ODD)], fixed=[_entry()])
    assert half_weeks(alternating) == 1
    # Two weeks of one each: the factor of two a school with odd and even weeks had.
    assert share(None, year_of(alternating)) == 2
    assert share(ODD_WEEKS, year_of(alternating)) == share(EVEN, year_of(alternating)) == 1
    assert half_weeks(_request(fixed=[_entry(EVEN)])) == 1


def test_a_period_weighs_its_real_weeks() -> None:
    request = _request(period_weeks=[38, 2, 40], requirements=[_entry(periods=[True, False, False])])
    # Divided through by what they share: only the proportions are read.
    assert year_of(request) == [19, 1, 20]
    year = year_of(request)
    assert share(None, year) == 80
    assert share(Weeks(0b000011, 3), year) == 38
    assert share(Weeks(0b000001, 3), year) == 19
    assert share(Weeks(0b110011, 3), year) == 78
    # A parity alone is half of every period.
    assert share(ODD_WEEKS, year) == 40
    assert half_weeks(request) == 2


def test_masks_without_figures_weigh_every_period_alike() -> None:
    request = _request(fixed=[_entry(periods=[True, False, True, False])])
    assert year_of(request) == [1, 1, 1, 1]
    assert share(Weeks(0b00000011, 4), year_of(request)) == 2


# ---------------------------------------------------------------------------
# A row for each parity, only where one row for both would be stricter
# ---------------------------------------------------------------------------


def test_the_cells_of_a_year_are_each_periods_odd_weeks_and_its_even_ones() -> None:
    assert cells_of(1) == [(ODD_WEEKS, EVEN_WEEKS)]
    assert cells_of(3) == [
        (Weeks(0b000001, 3), Weeks(0b000010, 3)),
        (Weeks(0b000100, 3), Weeks(0b001000, 3)),
        (Weeks(0b010000, 3), Weeks(0b100000, 3)),
    ]


def test_a_period_needs_a_part_per_parity_only_when_no_owed_week_holds_every_entry() -> None:
    # An odd lock and an even lesson: neither week holds both.
    assert needs_a_part_per_parity([("lock", ODD_WEEKS), ("lesson", EVEN_WEEKS)], [None]) is True
    # An odd lock and a lesson every week: the odd weeks hold both, and a break clear of them is clear of the even weeks'.
    assert needs_a_part_per_parity([("lock", ODD_WEEKS), ("lesson", None)], [None]) is False
    # Lessons of the even weeks only: the odd weeks owe no break, so the odd lock is nothing the even weeks hold.
    assert needs_a_part_per_parity([("lock", ODD_WEEKS)], [EVEN_WEEKS]) is True
    # What runs every week is the same in both, and nothing at all needs nothing.
    assert needs_a_part_per_parity([("lock", None)], [ODD_WEEKS]) is False
    assert needs_a_part_per_parity([], [None]) is False
    assert needs_a_part_per_parity([("lock", ODD_WEEKS)], []) is False
    # The gateway's names stand for the weeks they are.
    assert needs_a_part_per_parity([("lock", "ODD_WEEKS"), ("lesson", "EVEN_WEEKS")], [None]) is True


def test_a_period_is_read_by_its_own_weeks_and_not_by_another_periods() -> None:
    autumn, spring = Weeks(0b0011, 2), Weeks(0b1100, 2)
    odd_autumn, even_spring = Weeks(0b0001, 2), Weeks(0b1000, 2)
    # An odd lock in the autumn and an even lesson in the spring are never in one period: the autumn's
    # odd weeks hold the lock and the spring's even weeks the lesson, and each holds all there is.
    assert needs_a_part_per_parity([("lock", odd_autumn), ("lesson", even_spring)], [autumn, spring]) is False
    # Both in the autumn, with a lesson in each parity of it: the odd weeks hold the lock, the even ones the lesson.
    assert needs_a_part_per_parity([("lock", odd_autumn), ("lesson", Weeks(0b0010, 2))], [autumn]) is True
    # The spring's lock is the spring's: in the autumn it is no entry of the period at all, and in the spring
    # the odd weeks hold all there is.
    assert needs_a_part_per_parity([("lock", Weeks(0b0100, 2))], [autumn]) is False
    assert needs_a_part_per_parity([("lock", Weeks(0b0100, 2))], [spring]) is False
    # ... until the spring's even weeks hold a lesson of their own, with the odd lock and no lesson of the odd weeks.
    assert needs_a_part_per_parity([("lock", Weeks(0b0100, 2))], [Weeks(0b1000, 2)]) is True


@pytest.mark.parametrize("seed", range(40))
def test_one_break_for_both_parities_is_never_stricter_where_no_part_per_parity_is_needed(seed: int) -> None:
    """COMPLETENESS, by brute force: where the predicate says no, one break holds exactly when each week's own does.

    Small worlds: up to three periods, up to four entries each with a parity
    and a mask of its own, three slots in the lunch window and a break of one.
    For every way to put each entry in a slot, one break for a period's two
    weeks is clear of every entry of both, and a break for each owed week is
    clear of that week's. Where the two differ the predicate must be true:
    saying no is what leaves a school with the one break.
    """
    rng = random.Random(seed)
    periods = rng.choice([1, 2, 3])
    count = rng.randint(1, 4)
    entries = []
    for key in range(count):
        parity = rng.choice([None, ODD, EVEN])
        mask = None if periods == 1 or rng.random() < 0.4 else [rng.random() < 0.5 for _ in range(periods)]
        if mask is not None and not any(mask):
            mask[rng.randrange(periods)] = True
        entries.append((key, SimpleNamespace(recurrence=parity, periods=mask)))
    lessons = [
        SimpleNamespace(recurrence=rng.choice([None, ODD, EVEN]), periods=None if periods == 1 else [True] * (periods - 1) + [rng.random() < 0.5])
        for _ in range(rng.randint(1, 2))
    ]
    held = [(key, weeks_of(entry)) for key, entry in entries]
    owed = [weeks_of(lesson) for lesson in lessons]
    needed = needs_a_part_per_parity(held, owed)
    levels = max([runs.periods for _, runs in held if runs is not None] + [runs.periods for runs in owed if runs is not None] + [1])
    slots = 3
    for placed in _slots(count, slots):
        for odd, even in cells_of(levels):
            owed_here = [cell for cell in (odd, even) if any(meet(runs, cell) for runs in owed)]
            if not owed_here:
                continue
            taken = {
                cell: {placed[key] for key, runs in held if meet(runs, cell)} for cell in (odd, even)
            }
            both = len(taken[odd] | taken[even]) < slots
            each = all(len(taken[cell]) < slots for cell in owed_here)
            if both != each:
                assert needed, (seed, placed)


def _slots(count: int, slots: int):  # type: ignore[no-untyped-def]
    if count == 0:
        yield ()
        return
    for rest in _slots(count - 1, slots):
        for slot in range(slots):
            yield (*rest, slot)
