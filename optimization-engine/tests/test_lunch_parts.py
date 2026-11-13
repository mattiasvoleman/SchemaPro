"""Klassens måltid per del av läsåret: one meal in each part of the year its locks tell apart.

A class's meal used to be one time all year, clear of every lock of the year,
so a school whose autumn locks and spring locks together fill the lunch window
was refused (LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK) though each term has a gap.
With `lunchPerPeriod` the class eats at a time in each PART of the year: a
group of periods whose locked lessons and placed meals leave the meal the
same starts. Three things are held here:

- THE CONTRACT: three optional fields, and the answer a request without them
  has is the bytes it had.
- THE MEALS OF AN ANSWER, read in every real week by benchmarks/
  validate_schedule.lunch_problems, which shares no code with the engine: one
  meal a day in each period, in the window, clear of the class's lessons and
  locks and of the seats' limit.
- THAT A CLASS THAT DOES NOT NEED PARTS HAS NONE: a class whose locks are
  alike in every period is one part, builds the model it built, and answers
  with the one meal and no mask.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

import test_period_rules as rules_module
import test_periods as periods
from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import LunchPlacement, OptimizeScheduleRequest, ScheduledLunch
from app.solver.scheduler_solver import SchedulerSolver, _period_view, _weeks_and_requests
from app.solver.weeks import part_weeks, within

AUTUMN, SPRING, SOLVED = periods.AUTUMN, periods.SPRING, periods.SOLVED
_lock, _payload, _requirement = rules_module._lock, periods._payload, periods._requirement
FIRST_HALF, SECOND_HALF = rules_module.FIRST_HALF, rules_module.SECOND_HALF
MEAL = rules_module.MEAL


def _settings(days: str = "1") -> Settings:
    return periods._settings(hours=5, days=days, SOLVER_PROBE_SECONDS=0)


def _school(
    *locks: tuple[str, str, dict[str, object]],
    masks: int = 2,
    per_period: bool = True,
    classes: int = 1,
    seats: int | None = None,
    placements: list[dict[str, object]] | None = None,
    owners: list[int] | None = None,
) -> tuple[dict[str, object], list[str]]:
    """Classes that eat 30 minutes in 11:00-12:00, with locks in the window.

    Each lock is (start, end, when it runs); `owners` says which class of the
    school holds each lock (all of the first by default). A post of the last
    period beside one of every week, so the year has `masks` periods whatever
    the locks say.
    """
    groups = [str(uuid4()) for _ in range(classes)]
    last = [index == masks - 1 for index in range(masks)]
    requirements = [
        row
        for group in groups
        for row in (_requirement(group, 2), _requirement(group, 1, periods=last))
    ]
    owners = owners or [0] * len(locks)
    rules: dict[str, object] = dict(MEAL)
    if seats is not None:
        rules["diningSeats"] = seats
    payload = _payload(
        requirements,
        rules=rules,
        fixedLessons=[
            {**_lock(groups[owner], 1, start, end, str(uuid4())), **when}
            for owner, (start, end, when) in zip(owners, locks)
        ],
        periodWeeks=[20 + index for index in range(masks)],
    )
    if per_period:
        payload["lunchPerPeriod"] = True
    if placements:
        payload["lunchPlacements"] = [
            {"studentGroupId": groups[0], "dayOfWeek": 1, **row} for row in placements
        ]
    return payload, groups


def _solve(payload: dict[str, object], days: str = "1"):
    return periods._solve(payload, _settings(days))


def _meals(response, group: str, day: int = 1) -> list[tuple[str, tuple[bool, ...] | None]]:
    """A class's meals of a day: (start, mask), in the order of the year."""
    return [
        (lunch.start_time[:5], lunch.periods)
        for lunch in response.lunches
        if str(lunch.student_group_id) == group and lunch.day_of_week == day
    ]


def _refusal(payload: dict[str, object], days: str = "1") -> InvalidScheduleInputError:
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(_settings(days))._validate_request(OptimizeScheduleRequest.model_validate(payload))
    return refused.value


def _read(payload: dict[str, object], response, days: str = "1") -> list[str]:
    """What benchmarks/validate_schedule says of the meals and the lessons of an answer, in every real week."""
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import lunch_problems

    request = OptimizeScheduleRequest.model_validate(payload)
    grid = SchedulerSolver(_settings(days))._grid
    return [
        *periods._validate(payload, response.lessons, _settings(days)),
        *lunch_problems(grid, request, response.lessons, response.lunches),
    ]


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_the_flag_needs_periods_and_a_mask_on_a_placed_meal_needs_the_flag() -> None:
    payload, group = _school((*FIRST_HALF, {"periods": AUTUMN}))
    assert OptimizeScheduleRequest.model_validate(payload).lunch_per_period is True
    # No periodWeeks: a meal per period has nothing to be per.
    with pytest.raises(ValidationError, match="lunchPerPeriod needs periodWeeks"):
        OptimizeScheduleRequest.model_validate(
            {key: value for key, value in payload.items() if key != "periodWeeks"},
        )
    # A mask on a placed meal without the flag would be read as every week.
    placed = {"studentGroupId": group[0], "dayOfWeek": 1, "startTime": "11:00:00", "periods": AUTUMN}
    with pytest.raises(ValidationError, match="needs lunchPerPeriod"):
        OptimizeScheduleRequest.model_validate({
            **{key: value for key, value in payload.items() if key != "lunchPerPeriod"},
            "lunchPlacements": [placed],
        })
    assert OptimizeScheduleRequest.model_validate({**payload, "lunchPlacements": [placed]}).lunch_placements[0].periods == (True, False)
    # The mask is a mask as every other: a period more than the year has is refused.
    with pytest.raises(ValidationError, match="same length"):
        OptimizeScheduleRequest.model_validate({**payload, "lunchPlacements": [{**placed, "periods": [True, False, False]}]})
    with pytest.raises(ValidationError):
        LunchPlacement.model_validate({**placed, "periods": [True]})


def test_a_meal_has_a_mask_only_where_it_is_one_of_several() -> None:
    plain = ScheduledLunch.model_validate({
        "studentGroupId": str(uuid4()), "dayOfWeek": 1, "startTime": "11:00:00", "endTime": "11:30:00",
    })
    assert "periods" not in plain.model_dump(by_alias=True, mode="json")
    masked = ScheduledLunch.model_validate({**plain.model_dump(by_alias=True), "periods": [True, False]})
    assert masked.model_dump(by_alias=True, mode="json")["periods"] == [True, False]


def test_a_request_without_the_flag_answers_as_it_did() -> None:
    """No periods, no flag: no key in the answer a school never sent a field for."""
    group = str(uuid4())
    payload = _payload([_requirement(group, 2)], rules=MEAL)
    response = _solve(payload)
    assert response.status in SOLVED
    assert [lunch.periods for lunch in response.lunches] == [None]
    assert all("periods" not in lunch for lunch in response.model_dump(by_alias=True, mode="json")["lunches"])
    # And with periods but without the flag: the year's one meal, the year's refusal.
    refused = _school((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}), per_period=False)[0]
    assert _refusal(refused).code == "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK"


# ---------------------------------------------------------------------------
# The year the old engine refused
# ---------------------------------------------------------------------------


def test_locks_of_two_terms_that_close_the_window_between_them_get_a_meal_in_each() -> None:
    """The refusal of #300's M2, lifted: the autumn's half hour and the spring's are the class's.

    A lock 11:00-11:30 in the autumn and 11:30-12:00 in the spring, on the
    only day of the school: the autumn's meal can only be the second half
    hour and the spring's the first, and the answer says so with a mask each.
    """
    payload, (group,) = _school((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}))
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, group) == [("11:30", (True, False)), ("11:00", (False, True))]
    assert _read(payload, response) == []
    # The same world one meal all year is the year's refusal, which it was.
    assert _refusal(_school((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}), per_period=False)[0]).code == (
        "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK"
    )


def test_periods_that_hold_the_same_locks_are_one_part_however_far_apart() -> None:
    """Four periods, the autumn's lock in the first and the third: two meals, each for two periods."""
    payload, (group,) = _school(
        (*FIRST_HALF, {"periods": [True, False, True, False]}),
        (*SECOND_HALF, {"periods": [False, True, False, True]}),
        masks=4,
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, group) == [
        ("11:30", (True, False, True, False)), ("11:00", (False, True, False, True)),
    ]
    assert _read(payload, response) == []


def test_parts_that_come_to_eat_at_the_same_time_are_one_meal_for_all_their_periods() -> None:
    """Three terms, three different locks, and the third has room where the first has: they eat alike and say so once.

    The third term's lock is the first quarter hour of the window, which leaves
    it every start from 11:15, the autumn's own 11:30 among them. Three parts
    are built (the locks differ) and the term that prices a split puts the
    third where the first is: one meal for the two of them, a mask of both.
    """
    payload, (group,) = _school(
        (*FIRST_HALF, {"periods": [True, False, False]}),
        (*SECOND_HALF, {"periods": [False, True, False]}),
        ("11:00:00", "11:15:00", {"periods": [False, False, True]}),
        masks=3,
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, group) == [("11:30", (True, False, True)), ("11:00", (False, True, False))]
    assert _read(payload, response) == []


# ---------------------------------------------------------------------------
# A class that does not need parts has none
# ---------------------------------------------------------------------------


def test_a_class_whose_locks_are_alike_in_every_period_has_the_meal_it_had() -> None:
    """The identity: a lock outside the window and the same lock in the window in every period are one part."""
    every = (*FIRST_HALF, {})
    elsewhere = ("08:00:00", "09:00:00", {"periods": AUTUMN})
    with_flag, (group,) = _school(every, elsewhere)
    without = copy.deepcopy(with_flag)
    del without["lunchPerPeriod"]
    first, second = _solve(with_flag), _solve(without)
    assert first.status in SOLVED and second.status in SOLVED
    assert _meals(first, group) == _meals(second, group) == [("11:30", None)]
    assert [(l.requirement_id, l.day_of_week, l.start_time) for l in first.lessons] == [
        (l.requirement_id, l.day_of_week, l.start_time) for l in second.lessons
    ]
    assert first.model_dump(by_alias=True, mode="json")["lunches"] == second.model_dump(by_alias=True, mode="json")["lunches"]
    assert _read(with_flag, first) == []


def _proto_of(payload: dict[str, object]) -> bytes:
    """The model a request builds, as the bytes of its proto (benchmarks/model_identity.py takes them the same way)."""
    import tempfile

    solver = SchedulerSolver(_settings())
    model, *_ = solver._build_model(
        OptimizeScheduleRequest.model_validate(payload), use_assumptions=False, include_objective=True,
    )
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "model.pb"
        assert model.ExportToFile(str(path))
        return path.read_bytes()


def test_the_model_of_a_class_whose_locks_are_alike_is_the_model_without_the_flag() -> None:
    """Not only the answer: the very variables and rows, so no search is changed for a school that gains nothing."""
    alike, _ = _school(("11:00:00", "11:30:00", {}), ("08:00:00", "09:00:00", {"periods": AUTUMN}))
    without = {key: value for key, value in alike.items() if key != "lunchPerPeriod"}
    assert _proto_of(alike) == _proto_of(without)
    # And a class that has parts builds another model, which is the point.
    parted, _ = _school((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}))
    assert _proto_of(parted) != _proto_of({key: value for key, value in parted.items() if key != "lunchPerPeriod"})


def test_a_day_on_which_the_parts_eat_alike_is_one_meal_without_a_mask() -> None:
    """Two days, a lock on Monday only: Tuesday's meal is the same in both terms and is said once."""
    payload, (group,) = _school(
        (*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}),
    )
    response = _solve(payload, days="1,2")
    assert response.status in SOLVED
    assert [mask for _, mask in _meals(response, group, 1)] == [(True, False), (False, True)]
    tuesday = _meals(response, group, 2)
    assert len(tuesday) == 1 and tuesday[0][1] is None
    assert _read(payload, response, days="1,2") == []


def test_a_pin_of_the_whole_year_beside_locks_that_differ_still_splits_by_the_locks_only() -> None:
    """A pinned meal in every period, and locks that leave it where it is: one part, one meal."""
    payload, (group,) = _school(
        ("08:00:00", "09:00:00", {"periods": AUTUMN}),
        placements=[{"startTime": "11:30:00"}],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, group) == [("11:30", None)]


# ---------------------------------------------------------------------------
# The refusal says its period
# ---------------------------------------------------------------------------


def test_a_term_whose_own_locks_close_the_window_is_refused_and_named() -> None:
    both = [(*FIRST_HALF, {"periods": SPRING}), (*SECOND_HALF, {"periods": SPRING})]
    refused = _refusal(_school(*both)[0])
    assert (refused.code, refused.params["period"]) == ("LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", 1)
    # The autumn's, when the locks are the autumn's.
    both = [(*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": AUTUMN})]
    refused = _refusal(_school(*both)[0])
    assert (refused.code, refused.params["period"]) == ("LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", 0)
    # The locks of the whole year that close it are every period's: the first is named.
    year = [(*FIRST_HALF, {}), (*SECOND_HALF, {})]
    refused = _refusal(_school(*year)[0])
    assert (refused.code, refused.params["period"]) == ("LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", 0)


def test_a_meal_placed_on_a_lock_of_its_own_term_is_refused_and_on_one_of_another_is_not() -> None:
    payload, _ = _school(
        (*FIRST_HALF, {"periods": AUTUMN}),
        placements=[{"startTime": "11:00:00", "periods": SPRING}],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    # The same meal placed for the autumn lands on the autumn's lock.
    clash, _ = _school(
        (*FIRST_HALF, {"periods": AUTUMN}),
        placements=[{"startTime": "11:00:00", "periods": AUTUMN}],
    )
    assert _refusal(clash).code == "LUNCH_PLACEMENT_COLLIDES"


def test_meals_placed_for_two_terms_are_each_held_where_they_were_put() -> None:
    payload, (group,) = _school(
        placements=[
            {"startTime": "11:00:00", "periods": AUTUMN},
            {"startTime": "11:30:00", "periods": SPRING},
        ],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, group) == [("11:00", (True, False)), ("11:30", (False, True))]
    assert _read(payload, response) == []


def test_a_meal_placed_for_one_term_leaves_the_other_to_eat_alike_where_it_can() -> None:
    payload, (group,) = _school(placements=[{"startTime": "11:30:00", "periods": AUTUMN}])
    response = _solve(payload)
    assert response.status in SOLVED
    # Nothing keeps the spring from the autumn's half hour, and the term that
    # prices a split makes it the same: one meal, said once, no mask.
    assert _meals(response, group) == [("11:30", None)]


# ---------------------------------------------------------------------------
# The hall is counted in each real week
# ---------------------------------------------------------------------------


def test_the_hall_seats_the_classes_of_one_week_and_not_of_two() -> None:
    """Two classes that cannot eat together: A is locked in the autumn's first half hour, B in the spring's.

    A hall of twenty and twenty pupils a class: in the autumn A eats second
    and B first, in the spring B second and A first. A hall counted over the
    year would put A's spring meal and B's autumn meal (both first) in one
    row, and no year would have them.
    """
    payload, (a, b) = _school(
        (*FIRST_HALF, {"periods": AUTUMN}), (*FIRST_HALF, {"periods": SPRING}),
        classes=2, seats=20, owners=[0, 1],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _meals(response, a) == [("11:30", (True, False)), ("11:00", (False, True))]
    assert _meals(response, b) == [("11:00", (True, False)), ("11:30", (False, True))]
    assert _read(payload, response) == []


def test_a_hall_too_small_for_a_term_refuses_the_term_and_only_it() -> None:
    """Both classes locked in the autumn's first half hour: they both eat second, and the hall holds one."""
    payload, _ = _school(
        (*FIRST_HALF, {"periods": AUTUMN}), (*FIRST_HALF, {"periods": AUTUMN}),
        classes=2, seats=20, owners=[0, 1],
    )
    response = _solve(payload)
    assert response.status not in SOLVED


# ---------------------------------------------------------------------------
# The lessons keep clear of the meal of their own part
# ---------------------------------------------------------------------------


def test_a_lesson_of_the_autumn_keeps_clear_of_the_autumns_meal_and_not_of_the_springs() -> None:
    """A lesson only the autumn has, a lock of the spring, and the meal of each: no walk through the other term.

    The class has a lesson of 60 minutes in every autumn week and a lock
    11:00-11:30 in the spring. The autumn lesson is anywhere clear of the
    autumn's meal (checked in the autumn), and the spring's meal is anywhere
    clear of the spring's lock.
    """
    group = str(uuid4())
    payload = _payload(
        [_requirement(group, 3, periods=AUTUMN), _requirement(group, 1, periods=SPRING)],
        rules=MEAL,
        lunchPerPeriod=True,
        periodWeeks=[20, 21],
        fixedLessons=[{**_lock(group, 1, *FIRST_HALF, str(uuid4())), "periods": SPRING}],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _read(payload, response) == []


# ---------------------------------------------------------------------------
# What reads the request in a week, and what reads it in a period
# ---------------------------------------------------------------------------


def test_the_weeks_a_request_is_cut_into_carry_the_meals_placed_for_them() -> None:
    payload, _ = _school(
        placements=[
            {"startTime": "11:00:00", "periods": AUTUMN},
            {"startTime": "11:30:00", "periods": SPRING},
        ],
    )
    request = OptimizeScheduleRequest.model_validate(payload)
    weeks = _weeks_and_requests(request)
    assert len(weeks) == 2
    for week, week_request in weeks:
        assert week is not None
        assert week_request.lunch_per_period is False and week_request.period_weeks is None
        assert len(week_request.lunch_placements) == 1
        assert week_request.lunch_placements[0].periods is None
    starts = {week.suffix(): placed.lunch_placements[0].start_time for week, placed in weeks if week is not None}
    assert sorted(starts.values()) == ["11:00:00", "11:30:00"]


def test_a_period_view_is_the_request_of_one_period() -> None:
    payload, _ = _school(
        (*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}),
        placements=[{"startTime": "11:00:00", "periods": AUTUMN}],
    )
    request = OptimizeScheduleRequest.model_validate(payload)
    autumn, spring = _period_view(request, 0), _period_view(request, 1)
    assert [fixed.start_time for fixed in autumn.fixed_lessons] == ["11:00:00"]
    assert [fixed.start_time for fixed in spring.fixed_lessons] == ["11:30:00"]
    assert len(autumn.lunch_placements) == 1 and spring.lunch_placements == []
    for view in (autumn, spring):
        assert view.lunch_per_period is False and view.period_weeks is None
        assert all(fixed.periods is None for fixed in view.fixed_lessons)


def test_a_part_is_the_weeks_of_its_periods_in_both_parities() -> None:
    part = part_weeks([0, 2], 4)
    assert part.periods == 4 and part.held() == (0, 2)
    # A lesson of the odd weeks of period 0 and the whole of period 1 has the odd weeks of period 0 in the part.
    from app.solver.weeks import weeks_of

    class Entry:
        recurrence = "ODD_WEEKS"
        periods = (True, True, False, False)

    held = within(weeks_of(Entry()), part)
    assert held.held() == (0,) and held.parity() == "ODD_WEEKS"
    assert within(None, part) is part


def test_the_validator_of_the_meals_finds_a_meal_on_a_lock_in_its_period() -> None:
    """The check that checks the answer is checked: a meal that stands on a lock of its own term is named."""
    payload, (group,) = _school((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}))
    response = _solve(payload)
    assert _read(payload, response) == []
    swapped = response.model_copy(update={"lunches": [
        response.lunches[0].model_copy(update={"periods": (False, True)}),
        response.lunches[1].model_copy(update={"periods": (True, False)}),
    ]})
    problems = _read(payload, swapped)
    assert len(problems) == 2 and all("overlaps a lesson or lock" in line for line in problems)
    # A day with two meals and one of them without a mask, and a period without any.
    unmasked = response.model_copy(update={"lunches": [response.lunches[0].model_copy(update={"periods": None}), response.lunches[1]]})
    problems = _read(payload, unmasked)
    assert any("2 meals" in line or "no mask" in line for line in problems)
    gap = response.model_copy(update={"lunches": [response.lunches[0]]})
    assert any("0 meals" in line for line in _read(payload, gap))
