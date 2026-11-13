"""When two weeks' refusals are one refusal, and which is said (app/solver/refusals.py).

One rule for every refusal that is said of weeks: the counted ones, the 400s
and the lines of Bästa möjliga schema. These are the rule itself, one line of
it at a time. test_period_rules.py has it through the engine, and the two
weeks a real school has (the days before the first Monday, and the autumn).
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import ConflictAnalysis, ConflictDetail
from app.solver.refusals import of_analysis, of_error, of_line, of_most_weeks, said_weeks
from app.solver.weeks import Weeks


def _line(**changes: object) -> ConflictDetail:
    fields: dict[str, object] = {
        "category": "REQUIREMENT_DEMAND", "code": "DEMAND_TEACHER_HOURS_SHORT",
        "params": {"teacher": "t", "minutes": 300, "capacity": 240},
        # A sentence is made from the code and its figures, and is no part of the reading: given, not rendered.
        "message": "m",
    }
    return ConflictDetail.model_validate({**fields, **changes})


A, B, C = uuid4(), uuid4(), uuid4()


# ---------------------------------------------------------------------------
# What a refusal says: its sentence, its figures and what it names
# ---------------------------------------------------------------------------


def test_a_line_is_what_it_says_and_nothing_of_its_week_or_the_order_of_its_ids() -> None:
    base = _line(requirement_ids=[A, B], room_ids=[C])
    assert of_line(base) == of_line(_line(requirement_ids=[B, A], room_ids=[C]))
    # Which week it was counted in is what is being decided, so it is no part of the reading.
    named = _line(params={"teacher": "t", "minutes": 300, "capacity": 240, "period": 3, "periods": "3,4", "parity": "ODD_WEEKS"},
                  requirement_ids=[A, B], room_ids=[C])
    assert of_line(named) == of_line(base)
    # The same id twice is the post once.
    assert of_line(_line(requirement_ids=[A, A, B], room_ids=[C])) == of_line(base)


@pytest.mark.parametrize("changes", [
    {"code": "DEMAND_LESSONS_EXCEED_ROOM"},
    {"params": {"teacher": "t", "minutes": 301, "capacity": 240}},
    {"params": {"teacher": "u", "minutes": 300, "capacity": 240}},
    {"params": {"teacher": "t", "minutes": 300}},
    {"params": {"teacher": "t", "minutes": 300, "capacity": 240, "extra": 1}},
    {"requirement_ids": [A]},
    {"requirement_ids": [A, B, C]},
    {"requirement_ids": [], "room_ids": [A, B]},
    {"room_ids": []},
    {"room_ids": [A]},
    {"constraint_ids": [C]},
    {"resource_ids": [C]},
])
def test_a_line_another_sentence_figure_or_name_is_another_line(changes: dict[str, object]) -> None:
    base = _line(requirement_ids=[A, B], room_ids=[C])
    other = _line(**{"requirement_ids": [A, B], "room_ids": [C], **changes})
    assert of_line(other) != of_line(base)


def test_the_four_kinds_of_id_are_four_things_a_line_names() -> None:
    """The same id as a post and as a room is two different statements."""
    assert of_line(_line(requirement_ids=[A])) != of_line(_line(room_ids=[A]))
    assert of_line(_line(room_ids=[A])) != of_line(_line(constraint_ids=[A]))
    assert of_line(_line(constraint_ids=[A])) != of_line(_line(resource_ids=[A]))
    assert of_line(_line(resource_ids=[A])) != of_line(_line(requirement_ids=[A]))


def _analysis(lines: list[ConflictDetail], **changes: object) -> ConflictAnalysis:
    fields: dict[str, object] = {
        "summary_code": "DEMAND_TEACHER_HOURS_SHORT_SUMMARY", "summary_params": {"teachers": 1}, "conflicts": lines,
        "summary": "s",
    }
    return ConflictAnalysis.model_validate({**fields, **changes})


def test_a_counted_refusal_is_its_headline_and_the_lines_under_it_in_no_order() -> None:
    one, two = _line(requirement_ids=[A]), _line(requirement_ids=[B])
    base = _analysis([one, two])
    assert of_analysis(_analysis([two, one])) == of_analysis(base)
    assert of_analysis(_analysis([one, two], summary_params={"teachers": 1, "period": 2, "periods": "2,3"})) == of_analysis(base)
    assert of_analysis(_analysis([one, two], summary_params={"teachers": 1, "parity": "EVEN_WEEKS"})) == of_analysis(base)


@pytest.mark.parametrize("changes", [
    {"summary_code": "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL"},
    {"summary_params": {"teachers": 2}},
    {"summary_params": {}},
    {"summary_params": {"teachers": 1, "extra": "x"}},
])
def test_a_counted_refusal_with_another_headline_is_another_refusal(changes: dict[str, object]) -> None:
    one, two = _line(requirement_ids=[A]), _line(requirement_ids=[B])
    assert of_analysis(_analysis([one, two], **changes)) != of_analysis(_analysis([one, two]))


def test_a_counted_refusal_with_other_lines_is_another_refusal() -> None:
    one, two = _line(requirement_ids=[A]), _line(requirement_ids=[B])
    base = of_analysis(_analysis([one, two]))
    assert of_analysis(_analysis([one])) != base
    assert of_analysis(_analysis([one, two, _line(requirement_ids=[C])])) != base
    # Two posts and the same two posts named in other lines: other posts are named.
    assert of_analysis(_analysis([one, _line(requirement_ids=[C])])) != base
    # One line twice is not once.
    assert of_analysis(_analysis([one, one])) != of_analysis(_analysis([one]))
    assert of_analysis(_analysis([one, one, two])) != base


def _error(code: str, params: dict[str, str | int]) -> InvalidScheduleInputError:
    return InvalidScheduleInputError("m", code=code, params=params)


def test_a_400_is_its_code_and_its_figures_and_what_it_names_it_names_in_them() -> None:
    cap = "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
    base = _error(cap, {"rule": "r", "minutes": 60, "weekMinutes": 120})
    same = _error(cap, {"rule": "r", "minutes": 60, "weekMinutes": 120, "period": 1, "periods": "1,2", "parity": "ODD_WEEKS"})
    assert of_error(same) == of_error(base)
    for code, params in (
        ("TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK", {"rule": "r", "minutes": 60, "weekMinutes": 120}),
        (cap, {"rule": "r", "minutes": 60, "weekMinutes": 180}),
        (cap, {"rule": "s", "minutes": 60, "weekMinutes": 120}),
        (cap, {"rule": "r", "minutes": 60}),
    ):
        assert of_error(_error(code, params)) != of_error(base)


# ---------------------------------------------------------------------------
# Which refusal is said: the one most of the year gives
# ---------------------------------------------------------------------------

# Four periods of one parity-less year: the bits of period p are 0b11 << 2p.
P0, P1, P2, P3 = (Weeks(0b11 << (2 * period), 4) for period in range(4))


def _same(refusal: str) -> str:
    return refusal


def test_the_refusal_said_is_the_one_whose_weeks_are_most_of_the_year() -> None:
    # The two days before the first Monday are the first period: one week of eighteen and twenty.
    found = [(P0, "short"), (P1, "long"), (P2, "long")]
    assert of_most_weeks(found, _same, [1, 18, 20, 1]) == ("long", [P1, P2])
    assert of_most_weeks(found, _same, [30, 1, 1, 1]) == ("short", [P0])


def test_weeks_count_by_their_real_weeks_and_not_by_how_many_periods_there_are() -> None:
    found = [(P0, "two periods"), (P1, "one period"), (P2, "two periods")]
    assert of_most_weeks(found, _same, [1, 5, 1, 1]) == ("one period", [P1])
    assert of_most_weeks(found, _same, [1, 1, 1, 1]) == ("two periods", [P0, P2])
    # The odd weeks and the even weeks of a period are half of it each.
    odd, even = Weeks(0b0001, 4), Weeks(0b0010, 4)
    assert of_most_weeks([(odd, "x"), (even, "y"), (P2, "y")], _same, [4, 4, 4, 4]) == ("y", [even, P2])
    assert of_most_weeks([(odd, "x"), (P1, "y")], _same, [4, 1, 4, 4]) == ("x", [odd])


def test_the_earliest_refusal_is_said_when_two_have_as_many_weeks() -> None:
    # Tied at two weeks each: the one that comes first in the year, whichever way round they are met.
    assert of_most_weeks([(P0, "a"), (P1, "b"), (P2, "a")], _same, [1, 2, 1, 1]) == ("a", [P0, P2])
    assert of_most_weeks([(P0, "a"), (P1, "b"), (P2, "b")], _same, [2, 1, 1, 1]) == ("a", [P0])
    assert of_most_weeks([(P1, "b"), (P2, "a")], _same, [1, 1, 1, 1]) == ("b", [P1])


def test_weeks_whose_refusals_are_one_are_one_answer_by_the_one_rule() -> None:
    """`same` is the reading: refusals it calls one are one answer, and the first's words are said."""
    found = [(P0, "first-of-b"), (P1, "a"), (P2, "second-of-b")]
    assert of_most_weeks(found, lambda refusal: refusal.split("-")[-1], [1, 1, 1, 1]) == (
        "first-of-b", [P0, P2],
    )


# ---------------------------------------------------------------------------
# The weeks it is said of
# ---------------------------------------------------------------------------


def _never() -> bool:
    raise AssertionError("the year was asked of, and did not need to be")


def test_a_refusal_every_asked_week_gives_is_the_years_when_no_week_was_left_out() -> None:
    everything = [Weeks(0b0011, 2), Weeks(0b1100, 2)]
    assert said_weeks(everything, everything, _never) is None


def test_a_refusal_every_asked_week_gives_is_the_years_if_the_year_without_a_post_gives_it_too() -> None:
    asked = [P0, P1]  # periods 2 and 3 had nothing to place
    assert said_weeks(asked, asked, lambda: True) is None
    assert said_weeks(asked, asked, lambda: False) == together_of(P0, P1)


def together_of(*weeks: Weeks) -> Weeks:
    bits = 0
    for week in weeks:
        bits |= week.bits
    return Weeks(bits, weeks[0].periods)


def test_a_refusal_some_asked_weeks_give_is_theirs_and_the_year_is_not_asked() -> None:
    asked = [P0, P1, P2]
    assert said_weeks([P0, P2], asked, _never) == together_of(P0, P2)
    assert said_weeks([P1], asked, _never) == P1


def test_weeks_the_words_cannot_say_exactly_are_said_as_the_first_of_them() -> None:
    """The autumn's odd weeks with the whole spring: no words say those three weeks of four."""
    odd_autumn, spring = Weeks(0b0001, 2), Weeks(0b1100 >> 0, 2)
    other = Weeks(0b0010, 2)
    asked = [odd_autumn, other, spring]
    assert said_weeks([odd_autumn, spring], asked, _never) == odd_autumn
    assert said_weeks([spring, odd_autumn], asked, _never) == spring


# ---------------------------------------------------------------------------
# Every place a refusal is said of weeks reads it by this rule
# ---------------------------------------------------------------------------


def test_the_lines_of_a_deviation_are_one_when_they_say_the_same_in_any_order() -> None:
    """Bästa möjliga schema: a breach every week has alike names no week, and "alike" is the one rule."""
    from app.solver.relaxation import _worst_week
    from app.solver.weeks import named

    def breach(week: Weeks, ids: list) -> ConflictDetail:  # type: ignore[type-arg]
        return _line(
            category="DEVIATION", code="DEVIATION_TEACHER_DAILY_CAP",
            params={"rule": "r", "day": 1, "over": 60, **named(week)}, requirement_ids=ids,
        )

    first, second = Weeks(0b0011, 2), Weeks(0b1100, 2)
    # The same two posts, met in another order: the same breach in both weeks, so no week is named.
    (line,) = _worst_week([(first, breach(first, [A, B])), (second, breach(second, [B, A]))], ("rule", "day"), (first, second))
    assert not {"period", "periods", "parity"} & set(line.params)
    # Another post in the second week is another breach: the first is said, and its week with it.
    (line,) = _worst_week([(first, breach(first, [A, B])), (second, breach(second, [A, C]))], ("rule", "day"), (first, second))
    assert line.params["period"] == 0 and line.requirement_ids == [A, B]
    # And another room, rule or constraint named is another breach too (the id lists are the line's).
    other = breach(second, [A, B]).model_copy(update={"room_ids": [C]})
    (line,) = _worst_week([(first, breach(first, [A, B])), (second, other)], ("rule", "day"), (first, second))
    assert line.params["period"] == 0


def test_a_solved_refusal_is_the_years_when_the_year_alone_says_the_same_in_any_order() -> None:
    """_solved_in asks whether the entries of every week give the verdict too, and "the same" is the one rule."""
    import test_periods as periods
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver, _weeks_and_requests

    group, other = str(uuid4()), str(uuid4())
    request = OptimizeScheduleRequest.model_validate(periods._payload([
        periods._requirement(group, 1),
        periods._requirement(other, 1, periods=[True, False]),
    ]))
    (label, week), *_ = _weeks_and_requests(request)
    solver = SchedulerSolver(periods._settings())
    verdict = _analysis([_line(requirement_ids=[A, B])])

    def said(alone: ConflictAnalysis | None) -> dict[str, object]:
        again = solver._solved_in(verdict, label, week, request, lambda _asked: alone)
        assert again.conflicts[0].requirement_ids == [A, B]
        return {name: value for name, value in again.summary_params.items() if name in ("period", "periods", "parity")}

    # The year without the autumn's post gives this verdict, in another order: it is nobody's term.
    assert said(_analysis([_line(requirement_ids=[B, A])])) == {}
    # Another post, or none at all, and it is the autumn's.
    assert said(_analysis([_line(requirement_ids=[A])])) == {"period": 0}
    assert said(None) == {"period": 0}
