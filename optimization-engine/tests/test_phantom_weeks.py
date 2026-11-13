"""Terminer: a cell of the year that no real week is in (`periodOddWeeks`).

The review of #304, MEDEL-2, LÅG-1 and LÅG-2. The engine's week is a period in
a parity, and a period of one week (the läsår's first two days, a test week,
the weeks between terms) has the one parity of that week. The other cell was
counted, built and named as if it were a week: a school whose every real week
fits was refused for it, and a refusal of the real week said "the even weeks"
of a period that has only the one.

The year below is the reviewer's: period 0 is weeks 17, 19 and 20 of 2027 (two
odd weeks and one even), period 1 is week 18 (3 to 9 May), which is even and
the only week of its period.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from pydantic import ValidationError

import test_periods as periods
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleRequest, ScheduledLesson
from app.solver.refusals import of_most_weeks, said_weeks
from app.solver.relaxation import _weeks_of, _worst_week, deviations_of
from app.solver.scheduler_solver import SchedulerSolver, _locks_by_week, _teacher_locks, _weeks_and_requests
from app.solver.weeks import Weeks, closed, named, only_phantom, phantom_cells, says_exactly, share, year_weighing

_payload, _requirement = periods._payload, periods._requirement

#: Period 0, three real weeks of which two are odd. Period 1, one even week.
WEEKS, ODD = [3, 1], [2, 0]


def _settings():
    return periods._settings(hours=4, days="1", SOLVER_PROBE_SECONDS=0)


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _refused(payload: dict[str, object]):
    response, *_ = SchedulerSolver(_settings())._prechecks(_request(payload))
    return response


def _four_hours_of_week_18(*, told: bool, extra: list[dict[str, object]]) -> dict[str, object]:
    """Four posts of an hour, dated to week 18 (the day is four hours), and `extra` beside them."""
    teacher = str(uuid4())
    posts = [
        _requirement(str(uuid4()), 1, teacher=teacher, periods=[False, True]) for _ in range(4)
    ]
    posts += [{**post, "teacherId": teacher, "studentGroupId": str(uuid4())} for post in extra]
    return _payload(posts, periodWeeks=WEEKS, **({"periodOddWeeks": ODD} if told else {}))


# ---------------------------------------------------------------------------
# MEDEL-2: a school is not refused for a week no calendar has
# ---------------------------------------------------------------------------


def _reviewers_school(*, told: bool) -> dict[str, object]:
    odd = _requirement(str(uuid4()), 1, recurrence="ODD_WEEKS")
    return _four_hours_of_week_18(told=told, extra=[odd])


def test_a_school_whose_every_real_week_fits_is_not_refused_for_the_odd_cell_of_a_period_with_one_even_week() -> None:
    """Four posts of an hour in week 18 and a post of the odd weeks all year: 240 minutes in week 18 and 60 in the others.

    Without periodOddWeeks the odd post runs in the odd cell of the period
    that is week 18, beside its four: 300 minutes of a four-hour day, in a
    week no calendar has. Told that the period has no odd week, the post
    runs where there are some.
    """
    refused = _refused(_reviewers_school(told=False))
    assert refused is not None
    assert refused.conflicts.summary_code == "DEMAND_TEACHER_HOURS_SHORT"
    assert refused.conflicts.summary_params["period"] == 1
    assert refused.conflicts.summary_params["parity"] == "ODD_WEEKS"

    assert _refused(_reviewers_school(told=True)) is None


def test_the_same_school_is_planned_when_told_and_every_post_is_placed() -> None:
    response = periods._solve(_reviewers_school(told=True), _settings())
    assert response.status in periods.SOLVED
    assert len(response.lessons) == 5
    # The odd post is in no week of period 1: its lesson may share the hour of week 18's posts,
    # which is what a calendar with one even week in the period allows.


def test_what_runs_in_no_cell_of_a_period_is_taken_out_of_its_mask() -> None:
    request = _request(_reviewers_school(told=True))
    odd = next(requirement for requirement in request.requirements if requirement.recurrence == "ODD_WEEKS")
    assert odd.periods == (True, False)
    # And the posts that run every week of period 1 are as they came.
    assert all(requirement.periods == (False, True) for requirement in request.requirements if requirement is not odd)
    # Not told, nothing is touched: the same school as it always was.
    untold = _request(_reviewers_school(told=False))
    assert next(r for r in untold.requirements if r.recurrence == "ODD_WEEKS").periods is None


# ---------------------------------------------------------------------------
# What is read of the field, and what is changed by it
# ---------------------------------------------------------------------------


def test_periododdweeks_is_a_shape_of_period_weeks() -> None:
    payload = _reviewers_school(told=True)
    for bad in (
        {"periodOddWeeks": [2]},  # as long as the periods
        {"periodOddWeeks": [2, 2]},  # more odd weeks than a period of one week has
        {"periodOddWeeks": [4, 0]},  # more odd weeks than a period has weeks
        {"periodOddWeeks": [2, 0], "periodWeeks": None},  # beside periodWeeks only
    ):
        with pytest.raises(ValidationError):
            _request({**payload, **bad})
    # A period of one week may be odd or even.
    assert _request({**payload, "periodOddWeeks": [2, 1]}).period_odd_weeks == [2, 1]


def test_only_a_post_of_one_parity_is_changed_and_only_by_the_periods_that_have_none_of_it() -> None:
    teacher = str(uuid4())

    def post(**extra: object) -> dict[str, object]:
        return _requirement(str(uuid4()), 1, teacher=teacher, **extra)

    # Period 0 has both parities, period 1 is one even week, period 2 is one odd week.
    payload = _payload(
        [
            post(recurrence="ODD_WEEKS"),  # no mask: every period, but the second
            post(recurrence="EVEN_WEEKS", periods=[False, True, True]),  # the third has no even week
            post(recurrence="ODD_WEEKS", periods=[True, True, False]),  # the second has no odd week
            post(periods=[True, False, True]),  # no parity: every week of its periods, whatever they have
            post(recurrence="ODD_WEEKS", periods=[False, True, False]),  # would run in no week at all
        ],
        fixedLessons=[{
            "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": teacher,
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
            "recurrence": "ODD_WEEKS", "periods": [True, True, False],
        }],
        periodWeeks=[3, 1, 1], periodOddWeeks=[2, 0, 1],
    )
    request = _request(payload)
    assert [r.periods for r in request.requirements] == [
        (True, False, True),
        (False, True, False),
        (True, False, False),
        (True, False, True),
        # An entry that would run in no week keeps its mask (a mask of nothing is no mask): a post dated into a
        # period it has no week in, which the gateway does not send.
        (False, True, False),
    ]
    assert request.fixed_lessons[0].periods == (True, False, False)


def test_a_request_without_periododdweeks_or_with_every_period_having_both_parities_is_not_touched() -> None:
    payload = _payload(
        [_requirement(str(uuid4()), 1, recurrence="ODD_WEEKS", periods=[True, False])],
        periodWeeks=[3, 4],
    )
    assert _request(payload).requirements[0].periods == (True, False)
    both = _request({**payload, "periodOddWeeks": [2, 2]})
    assert both.requirements[0].periods == (True, False)
    assert phantom_cells(both) is None


# ---------------------------------------------------------------------------
# The cells, and what is said of them
# ---------------------------------------------------------------------------


def test_the_cells_no_week_is_in_are_found_from_the_odd_weeks_a_period_has() -> None:
    request = _request(_reviewers_school(told=True))
    # Period 0 has both parities. Period 1 is one even week: its odd cell (bit 2) is none.
    assert phantom_cells(request) == Weeks(0b0100, 2)
    # A period of one odd week has no even cell, and a period with none of either is not a thing.
    odd_week = _request({**_reviewers_school(told=True), "periodOddWeeks": [2, 1]})
    assert phantom_cells(odd_week) == Weeks(0b1000, 2)
    assert phantom_cells(_request(_reviewers_school(told=False))) is None


def test_a_period_is_said_whole_where_its_only_real_week_is_there() -> None:
    phantom = Weeks(0b0100, 2)
    even_of_the_second = Weeks(0b1000, 2)
    assert named(even_of_the_second) == {"period": 1, "parity": "EVEN_WEEKS"}
    assert closed(even_of_the_second, phantom) == Weeks(0b1100, 2)
    assert named(closed(even_of_the_second, phantom)) == {"period": 1}
    # The cell beside nothing is not filled in: the odd weeks of the first period are those.
    assert closed(Weeks(0b0001, 2), phantom) == Weeks(0b0001, 2)
    assert closed(None, phantom) is None
    assert closed(even_of_the_second, None) == even_of_the_second
    # Nothing but the phantom cell is no week at all.
    assert only_phantom(phantom, phantom)
    assert not only_phantom(Weeks(0b1100, 2), phantom)
    assert not only_phantom(Weeks(0b0001, 2), phantom)
    assert not only_phantom(None, phantom)


def test_weeks_with_a_period_of_one_parity_are_said_exactly_once_it_is_filled_in() -> None:
    """Period 0 whole and the even week of period 1: "periods 0,1" and no week more."""
    group = Weeks(0b1011, 2)
    assert not says_exactly(group)
    assert says_exactly(closed(group, Weeks(0b0100, 2)))
    assert named(closed(group, Weeks(0b0100, 2))) == {"period": 0, "periods": "0,1"}


# ---------------------------------------------------------------------------
# said_weeks: the year, the weeks, and the cell
# ---------------------------------------------------------------------------


def _never() -> bool:
    return False


def test_a_refusal_every_real_week_gives_is_the_years_though_a_cell_is_none() -> None:
    first, second = Weeks(0b0011, 2), Weeks(0b1000, 2)
    phantom = Weeks(0b0100, 2)
    assert said_weeks([first, second], [first, second], _never, phantom) is None
    # Not told, the odd cell of the second period is a week nobody asked, so the refusal is not the year's,
    # and the words cannot say these two (the first period whole, the second's even weeks alone).
    assert said_weeks([first, second], [first, second], _never) == first


def test_a_refusal_of_a_period_s_only_week_is_said_as_the_period() -> None:
    first, second = Weeks(0b0011, 2), Weeks(0b1000, 2)
    phantom = Weeks(0b0100, 2)
    said = said_weeks([second], [first, second], _never, phantom)
    assert said == Weeks(0b1100, 2)
    assert named(said) == {"period": 1}
    assert named(said_weeks([second], [first, second], _never)) == {"period": 1, "parity": "EVEN_WEEKS"}


def test_weeks_no_words_say_are_said_as_their_first_cell_and_not_as_the_first_group() -> None:
    """LÅG-1 of the review of #304: the first group holds a period in both parities and another in one.

    Said as that group, "periods 0,1" is more than the weeks that give the
    refusal; the first of its weeks is what is true of all of them.
    """
    group = Weeks(0b0111, 2)  # period 0 in both, period 1 odd
    other = Weeks(0b1000, 2)
    asked = [group, other]
    assert not says_exactly(group)
    said = said_weeks([group], asked, _never)
    assert said == Weeks(0b0001, 2)
    assert named(said) == {"period": 0, "parity": "ODD_WEEKS"}
    # A group the words say is still said whole.
    assert said_weeks([Weeks(0b1100, 2)], [Weeks(0b1100, 2), Weeks(0b0011, 2)], _never) == Weeks(0b1100, 2)


def test_a_cell_no_week_is_in_is_not_in_the_words_though_it_is_in_the_group() -> None:
    """The first period is one even week, and a group holds its odd cell beside the second period whole."""
    phantom = Weeks(0b0001, 2)
    group = Weeks(0b1101, 2)
    said = said_weeks([group], [group, Weeks(0b0010, 2)], _never, phantom)
    assert said == Weeks(0b1100, 2)
    assert named(said) == {"period": 1}


# ---------------------------------------------------------------------------
# LÅG-2: the refusal said is the one most real weeks give
# ---------------------------------------------------------------------------


def test_weeks_are_weighed_by_the_odd_weeks_a_period_really_has() -> None:
    """A period of three weeks that starts on an odd one has two odd and one even: not as many of each."""
    odd, even = Weeks(0b01, 1), Weeks(0b10, 1)
    assert share(odd, [3], [2]) == 2
    assert share(even, [3], [2]) == 1
    assert share(None, [3], [2]) == 3
    # Without the figures a period's two parities are as many as each other, as they were.
    assert share(odd, [3]) == share(even, [3]) == 3
    # The refusal the odd weeks give is said, though the even weeks' came first.
    (first, second) = (("even's", even), ("odd's", odd))
    refusal, held = of_most_weeks([(week, name) for name, week in (first, second)], lambda name: name, [3], [2])
    assert (refusal, held) == ("odd's", [odd])
    # Told nothing, the two tie and the earlier is said, as it was.
    refusal, held = of_most_weeks([(week, name) for name, week in (first, second)], lambda name: name, [3])
    assert (refusal, held) == ("even's", [even])


def test_the_request_weighs_its_year_by_what_it_sent() -> None:
    told = _request(_reviewers_school(told=True))
    assert year_weighing(told) == ([3, 1], [2, 0])
    untold = _request(_reviewers_school(told=False))
    assert year_weighing(untold) == ([3, 1], None)
    # Divided through by what they have in common where nothing says the odd weeks, as year_of always did.
    assert year_weighing(_request({**_reviewers_school(told=False), "periodWeeks": [4, 2]})) == ([2, 1], None)


# ---------------------------------------------------------------------------
# The weeks a school is asked of
# ---------------------------------------------------------------------------


def _with_a_post_in_no_week(*, told: bool) -> OptimizeScheduleRequest:
    """The corner: a post of the odd weeks dated into the period that has none stays as it came."""
    teacher = str(uuid4())
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=[False, True]) for _ in range(3)]
    posts.append(_requirement(str(uuid4()), 1, teacher=teacher, recurrence="ODD_WEEKS", periods=[False, True]))
    return _request(_payload(posts, periodWeeks=WEEKS, **({"periodOddWeeks": ODD} if told else {})))


def test_no_week_is_asked_of_a_cell_no_real_week_is_in() -> None:
    request = _with_a_post_in_no_week(told=True)
    phantom = phantom_cells(request)
    assert phantom == Weeks(0b0100, 2)
    labels = [label for label, _ in _weeks_and_requests(request)]
    assert labels and Weeks(0b0100, 2) not in labels
    assert not any(only_phantom(label, phantom) for label in labels)
    # And the deviations of Bästa möjliga schema are of the weeks there are.
    assert Weeks(0b0100, 2) not in _weeks_of(request)
    # Told nothing, the cell is a week, as it always was: a week of its own, asked and named.
    untold = _with_a_post_in_no_week(told=False)
    assert Weeks(0b0100, 2) in [label for label, _ in _weeks_and_requests(untold)]
    assert Weeks(0b0100, 2) in _weeks_of(untold)


def test_a_teacher_s_lunch_is_read_in_the_weeks_that_are_there() -> None:
    request = _request(_reviewers_school(told=True))
    phantom = phantom_cells(request)
    week = Weeks(0b1111, 2)
    cells = [label for label, _ in _locks_by_week([], week, phantom) if label is not None]
    assert cells == [Weeks(0b0001, 2), Weeks(0b0010, 2), Weeks(0b1000, 2)]
    # Not told: all four.
    assert len([label for label, _ in _locks_by_week([], week) if label is not None]) == 4


# ---------------------------------------------------------------------------
# A refusal of the real week
# ---------------------------------------------------------------------------


def test_a_refusal_of_week_18_is_said_as_the_period_and_not_as_its_even_weeks() -> None:
    """Five posts of the even weeks in a four-hour day, dated to a period that is one even week."""
    teacher = str(uuid4())
    posts = [
        _requirement(str(uuid4()), 1, teacher=teacher, recurrence="EVEN_WEEKS", periods=[False, True])
        for _ in range(5)
    ]
    told = _refused(_payload(posts, periodWeeks=WEEKS, periodOddWeeks=ODD))
    assert told is not None
    assert told.conflicts.summary_params["period"] == 1
    assert "parity" not in told.conflicts.summary_params
    # Not told, the period has an even week and the words say it: the even weeks of the second period.
    untold = _refused(_payload(posts, periodWeeks=WEEKS))
    assert untold is not None
    assert untold.conflicts.summary_params["period"] == 1
    assert untold.conflicts.summary_params["parity"] == "EVEN_WEEKS"


# ---------------------------------------------------------------------------
# What is said, wherever a week is said
# ---------------------------------------------------------------------------


def test_the_first_group_is_said_as_the_period_it_fills_when_the_words_say_nothing_of_all() -> None:
    """A group of one period's real week, beside another's odd cell alone: the first is said, whole."""
    phantom = Weeks(0b0100, 2)
    first, second = Weeks(0b1000, 2), Weeks(0b0001, 2)
    # Together the words cannot say them (period 1 whole, period 0 odd alone); the first group is the period.
    said = said_weeks([first, second], [first, second, Weeks(0b0010, 2)], _never, phantom)
    assert said == Weeks(0b1100, 2)
    assert named(said) == {"period": 1}


def test_the_refusal_said_of_a_school_is_the_one_most_real_weeks_give() -> None:
    """Period 0 is three weeks of which one is odd: the even weeks are two of its three, and the odd week is one.

    One teacher is over her hours in the odd weeks and another in the even ones. The cells are as many by
    half-weeks (a period's two cells are one half each), so without the odd weeks the earlier is said; with
    them the even weeks' teacher is, since two real weeks are more than one.
    """
    odd_teacher, even_teacher = str(uuid4()), str(uuid4())
    odd_posts = [
        _requirement(str(uuid4()), 1, teacher=odd_teacher, recurrence="ODD_WEEKS", periods=[True, False])
        for _ in range(5)
    ]
    even_posts = [
        _requirement(str(uuid4()), 1, teacher=even_teacher, recurrence="EVEN_WEEKS", periods=[True, False])
        for _ in range(6)
    ]

    def said(told: bool) -> str:
        payload = _payload(
            [*odd_posts, *even_posts], periodWeeks=[3, 2], **({"periodOddWeeks": [1, 1]} if told else {}),
        )
        refused = _refused(payload)
        assert refused is not None
        named_posts = {str(i) for line in refused.conflicts.conflicts for i in line.requirement_ids}
        return "odd" if named_posts & {p["id"] for p in odd_posts} else "even"

    assert said(told=False) == "odd"
    assert said(told=True) == "even"


def test_a_solved_refusal_is_said_with_the_period_filled_in() -> None:
    teacher = str(uuid4())
    posts = [
        _requirement(str(uuid4()), 1, teacher=teacher, recurrence="EVEN_WEEKS", periods=[False, True])
        for _ in range(3)
    ]
    request = _request(_payload(posts, periodWeeks=WEEKS, periodOddWeeks=ODD))
    label = Weeks(0b1000, 2)
    week = next(week for week_label, week in _weeks_and_requests(request) if week_label == label)
    verdict = ConflictAnalysis(
        summary_code="DEMAND_TEACHER_HOURS_SHORT", summary_params={"teachers": 1},
        conflicts=[ConflictDetail(category="REQUIREMENT_DEMAND", code="DEMAND_TEACHER_HOURS_SHORT", params={"x": 1}, message="m")],
    )
    # The verdict is not the year's: nothing is asked of the year without a post of its own.
    said = SchedulerSolver(_settings())._solved_in(verdict, label, week, request, lambda _week: None)
    assert said.summary_params["period"] == 1
    assert "parity" not in said.summary_params
    assert all("parity" not in line.params for line in said.conflicts)


def test_a_teacher_s_lunch_refused_in_a_period_s_only_week_says_the_period() -> None:
    """Her odd weeks' lock and her even weeks' lesson tell the first period apart, so she is read week by week.

    The second period is one even week, and a lock of its even weeks closes her window: the refusal is that
    week's, and the period is said whole, with no parity, since it has no other week.
    """
    teacher, group = str(uuid4()), str(uuid4())

    def refusal(told: bool) -> InvalidScheduleInputError:
        payload = _payload(
            [_requirement(group, 1, teacher=teacher, recurrence="EVEN_WEEKS")],
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                               "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}],
            fixedLessons=[
                {**periods_lock("11:00:00", "12:00:00", teacher, [True, False]), "recurrence": "ODD_WEEKS"},
                {**periods_lock("11:00:00", "13:00:00", teacher, [False, True]), "recurrence": "EVEN_WEEKS"},
            ],
            periodWeeks=WEEKS, **({"periodOddWeeks": ODD} if told else {}),
        )
        with pytest.raises(InvalidScheduleInputError) as refused:
            SchedulerSolver(periods._settings(hours=5, days="1", SOLVER_PROBE_SECONDS=0))._validate_request(_request(payload))
        return refused.value

    told = refusal(True)
    assert told.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert told.params["period"] == 1
    assert "parity" not in told.params
    untold = refusal(False)
    assert untold.params["period"] == 1
    assert untold.params["parity"] == "EVEN_WEEKS"


def periods_lock(start: str, end: str, teacher: str, mask: list[bool]) -> dict[str, object]:
    return {
        "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": teacher, "dayOfWeek": 1,
        "startTime": start, "endTime": end, "periods": mask,
    }


def test_a_deviation_in_a_period_s_only_week_is_said_as_the_period() -> None:
    """Bästa möjliga schema: two lessons of the even weeks put a teacher over her cap in the period that is one even week."""
    teacher = str(uuid4())
    posts = [
        _requirement(str(uuid4()), 1, teacher=teacher, recurrence="EVEN_WEEKS", periods=[False, True])
        for _ in range(2)
    ]
    request = _request(_payload(
        posts, periodWeeks=WEEKS, periodOddWeeks=ODD,
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}],
    ))
    placed = [
        ScheduledLesson.model_validate({
            "requirementId": post["id"], "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00", "roomId": None,
        })
        for post in posts
    ]
    (line,) = deviations_of(
        request, placed, request.rooms, {}, (1, 2, 3), flatten=lambda fixed: _teacher_locks(fixed)[0],
    )
    assert line.code == "DEVIATION_TEACHER_DAILY_CAP"
    assert line.params["period"] == 1
    assert "parity" not in line.params


def test_a_line_some_weeks_have_alike_says_them_with_the_period_filled_in() -> None:
    """The first period whole and the second's one even week: said together, as the periods they are."""
    phantom = Weeks(0b0100, 2)
    first, second = Weeks(0b0011, 2), Weeks(0b1000, 2)
    other = Weeks(0b0001, 2)

    def breach(week: Weeks) -> ConflictDetail:
        return ConflictDetail(
            category="DEVIATION", code="DEVIATION_TEACHER_DAILY_CAP", message="m",
            params={"rule": "r", "day": 1, "over": 60, **named(week)},
        )

    # A third week the line is not in, so it is not the year's.
    (line,) = _worst_week(
        [(first, breach(first)), (second, breach(second))], ("rule", "day"), (first, second, other), phantom,
    )
    assert line.params["period"] == 0
    assert line.params["periods"] == "0,1"
    assert "parity" not in line.params
