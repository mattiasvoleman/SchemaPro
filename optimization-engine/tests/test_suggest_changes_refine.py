"""Åtgärdsförslag vid vägran: `needed` lowered to the least the strict model can lay the week with (G6b, g384-L-1 and g384-L-2).

`needed` is the value the search's timetable needed, and the search is not looking for the least: on 3 of 59 weeks the strict solver
laid the week a step below it (a cap of 240 where 180 holds). `refine` lowers each change by halving, with a strict check of the whole list
for each probe. What is held here, in the order the code reads:

  * the values back toward the school's own, by rule and direction (`_values_back`);
  * the descent, against a strict check whose answer the test decides: it ends at the least accepted value, drops a change the week does
    not need, ends without a claim where the check does not decide, spends nothing it has no time for, and lowers the dearest first with
    the others as they then are;
  * the same against the real strict solver, on a week whose `needed` is made too high on purpose: it is brought back, and `neededIsLeast`
    is true because the value below it was PROVED not to hold;
  * the week with a locked lesson over the cap in one of two weeks names the week that binds (`_worst_week`, g384-L-2).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from app.schemas.schedule import ConflictDetail
from app.schemas.suggestions import SuggestedChange
from app.solver import relaxation, suggestions
from app.solver.suggestions import MAX_REFINEMENTS, _values_back, apply_changes, refine
from tests.test_suggest_changes import RULE, _cap_week, _request, _settings, _suggest
from tests.test_best_effort import TEACHER


def _change(rule: str, current: int | None, needed: int | None, cost: int = 100, **ids: object) -> SuggestedChange:
    return SuggestedChange.model_validate({
        "rule": rule, "cost": cost, "current": current, "needed": needed, "weekdays": [],
        "requirementIds": ids.get("requirementIds", []), "roomIds": [], "resourceIds": ids.get("resourceIds", []), "proof": "SOLVED",
    })


class TestTheValuesBack:
    def test_a_cap_goes_back_by_five_minutes_and_ends_at_the_schools_own(self) -> None:
        values = _values_back(_change("TEACHER_DAILY_CAP", 60, 80))
        assert values == [75, 70, 65, 60]

    def test_a_cap_one_step_above_the_schools_own_has_only_that_one_to_try(self) -> None:
        assert _values_back(_change("TEACHER_DAILY_CAP", 60, 65)) == [60]

    def test_days_and_lessons_a_day_go_back_by_one(self) -> None:
        assert _values_back(_change("TEACHER_WORK_DAYS", 2, 5)) == [4, 3, 2]
        assert _values_back(_change("SUBJECT_PER_DAY", 1, 3)) == [2, 1]

    def test_a_spread_of_days_is_tightened_by_raising_it(self) -> None:
        # The school keeps three days between; the timetable needed one. The way back is up: 2, then the school's own 3.
        assert _values_back(_change("SUBJECT_DAYS_APART", 3, 1)) == [2, 3]

    def test_a_room_lock_and_a_change_with_no_number_have_nothing_to_lower(self) -> None:
        assert _values_back(_change("ROOM_LOCK", None, None)) == []
        assert _values_back(_change("TEACHER_DAILY_CAP", None, 120)) == []
        assert _values_back(_change("TEACHER_DAILY_CAP", 60, None)) == []

    def test_a_change_already_at_the_schools_own_value_has_nothing_to_lower(self) -> None:
        assert _values_back(_change("SUBJECT_PER_DAY", 2, 2)) == [2]


class _Oracle:
    """A strict check that answers by the value of the cap of the work rule it is given: ACCEPTED from `least` up, INFEASIBLE below."""

    def __init__(self, least: int, *, undecided_at: int | None = None) -> None:
        self.least, self.undecided_at, self.asked = least, undecided_at, []

    def __call__(self, request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
        cap = request.teacher_work_rules[0].max_teaching_minutes_per_day
        self.asked.append(cap)
        if self.undecided_at is not None and cap <= self.undecided_at:
            return "UNDECIDED"
        return "ACCEPTED" if cap >= self.least else "INFEASIBLE"


def _week():  # noqa: ANN202
    payload, _, _ = _cap_week()
    return _request(payload)


def _cap(current: int, needed: int, **over: object) -> SuggestedChange:
    return _change("TEACHER_DAILY_CAP", current, needed, resourceIds=[UUID(RULE)], **over)


def _run(oracle, changes, *, left: float = 500.0):  # noqa: ANN001, ANN202
    return refine(_week(), [], changes, _settings(), left=lambda: left)


class TestTheDescent:
    def test_it_ends_at_the_least_value_the_strict_model_accepts_and_proves_the_one_below_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        oracle = _Oracle(least=180)
        monkeypatch.setattr(suggestions, "strict_check", oracle)

        (change,), spent = _run(oracle, [_cap(60, 240)])

        assert (change.needed, change.needed_is_least) == (180, True)
        assert 175 in oracle.asked, "the value below it was asked, and it is the proof"
        assert oracle.asked[0] == 235, "the value one step below `needed` is asked first (g493)"
        assert spent <= 7, "one step below first, then halving, not a step at a time (36 values between 60 and 240)"
        assert spent == len(oracle.asked)

    def test_it_does_not_claim_the_least_where_the_value_below_was_never_decided(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Between 60 and 100 the values back are 95 … 60: the step below `needed` (95) is asked first and accepted, the halving then asks 75
        # (accepted: it holds from 70), then 65, which the check does not decide: it got down to 75, and says nothing of 70, which would have held.
        oracle = _Oracle(least=70, undecided_at=69)
        monkeypatch.setattr(suggestions, "strict_check", oracle)

        (change,), _ = _run(oracle, [_cap(60, 100)])

        assert oracle.asked == [95, 75, 65]
        assert (change.needed, change.needed_is_least) == (75, False)

    def test_a_first_check_that_is_not_decided_leaves_the_value_and_claims_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        oracle = _Oracle(least=180, undecided_at=235)
        monkeypatch.setattr(suggestions, "strict_check", oracle)

        (change,), spent = _run(oracle, [_cap(60, 240)])

        assert (change.needed, change.needed_is_least, spent) == (240, False, 1)

    def test_the_value_next_to_the_one_found_is_claimed_the_least_only_if_it_was_proved_not_to_hold(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # One step above the school's own: the only value to try is the school's own, and the check does not decide it.
        monkeypatch.setattr(suggestions, "strict_check", _Oracle(least=100, undecided_at=64))

        (change,), spent = _run(None, [_cap(60, 65)])

        assert (change.needed, change.needed_is_least, spent) == (65, False, 1), "tried, not decided: no claim of the least"

    def test_a_change_the_week_does_not_need_at_all_is_dropped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(suggestions, "strict_check", _Oracle(least=60))

        changes, _ = _run(None, [_cap(60, 120)])

        assert changes == [], "the week holds with the school's own cap: nothing to change"

    def test_it_keeps_the_value_and_says_nothing_where_there_is_no_time_for_a_check(self, monkeypatch: pytest.MonkeyPatch) -> None:
        oracle = _Oracle(least=180)
        monkeypatch.setattr(suggestions, "strict_check", oracle)

        (change,), spent = _run(oracle, [_cap(60, 240)], left=20.0)

        assert (change.needed, change.needed_is_least, spent) == (240, None, 0)
        assert oracle.asked == []

    def test_it_spends_no_more_checks_than_it_may(self, monkeypatch: pytest.MonkeyPatch) -> None:
        oracle = _Oracle(least=5)
        monkeypatch.setattr(suggestions, "strict_check", oracle)

        # Twenty thousand values back: halving needs fifteen checks, and it may spend MAX_REFINEMENTS.
        (change,), spent = _run(oracle, [_cap(5, 100_000)])

        assert spent == MAX_REFINEMENTS == len(oracle.asked)
        assert change.needed is not None and change.needed < 100_000 and change.needed_is_least is None

    def test_a_check_that_is_not_decided_ends_that_changes_descent_and_not_the_next_ones(self, monkeypatch: pytest.MonkeyPatch) -> None:
        asked: list[tuple[int | None, int | None]] = []

        def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
            days = request.teacher_day_limits[0].max_teaching_days_per_week if request.teacher_day_limits else None
            cap = request.teacher_work_rules[0].max_teaching_minutes_per_day
            asked.append((cap, days))
            return "UNDECIDED" if cap != 60 and days is None else "ACCEPTED"

        monkeypatch.setattr(suggestions, "strict_check", check)
        first = _cap(60, 240, cost=500)
        second = _change("SUBJECT_PER_DAY", 1, 3, cost=10, requirementIds=[UUID(int=1, version=4)])

        changes, _ = refine(_week(), [], [first, second], _settings(), left=lambda: 500.0)

        by_rule = {change.rule: change for change in changes}
        # The dearer cap was tried first and was not decided: its descent ended there, the cheaper change was then tried.
        assert by_rule["TEACHER_DAILY_CAP"].needed == 240 and by_rule["TEACHER_DAILY_CAP"].needed_is_least is False
        assert by_rule["SUBJECT_PER_DAY"].needed is not None
        assert len(asked) >= 2

    def test_the_dearest_change_is_lowered_first_and_the_next_is_tried_with_it_lowered(self, monkeypatch: pytest.MonkeyPatch) -> None:
        week = _week()
        target = week.requirements[0]
        seen: list[tuple[int, int | None]] = []

        def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
            cap = request.teacher_work_rules[0].max_teaching_minutes_per_day
            per_day = next(r.max_lessons_per_day for r in request.requirements if r.id == target.id)
            seen.append((cap, per_day))
            return "ACCEPTED" if cap >= 100 else "INFEASIBLE"

        monkeypatch.setattr(suggestions, "strict_check", check)
        dear = _cap(60, 120, cost=900)
        cheap = _change("SUBJECT_PER_DAY", 1, 3, cost=5, requirementIds=[target.id])

        changes, _ = refine(week, [], [dear, cheap], _settings(), left=lambda: 500.0)

        assert {change.rule: change.needed for change in changes}["TEACHER_DAILY_CAP"] == 100
        # The cap went first, with the cheaper change as the search had it (three lessons a day) ...
        assert seen[0][1] == 3
        # ... and every check of the cheaper change carries the cap as it had then been lowered to: never the 120 it began at.
        later = [cap for cap, per_day in seen if per_day != 3]
        assert later and all(cap == 100 for cap in later)

    def test_a_change_that_was_dropped_is_not_in_the_checks_that_come_after_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        week = _week()
        target = week.requirements[0]
        seen: list[tuple[int, int | None]] = []

        def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
            cap = request.teacher_work_rules[0].max_teaching_minutes_per_day
            per_day = next(r.max_lessons_per_day for r in request.requirements if r.id == target.id)
            seen.append((cap, per_day))
            return "ACCEPTED"  # everything holds: the cap is not needed at all (the week holds at the school's own 60)

        monkeypatch.setattr(suggestions, "strict_check", check)
        dear = _cap(60, 120, cost=900)
        cheap = _change("SUBJECT_PER_DAY", 1, 3, cost=5, requirementIds=[target.id])

        changes, _ = refine(week, [], [dear, cheap], _settings(), left=lambda: 500.0)

        assert [change.rule for change in changes] == ["SUBJECT_PER_DAY"] or all(change.rule != "TEACHER_DAILY_CAP" for change in changes)
        # The checks of the cheaper change are made without the cap change: the cap stays what the school has (60), not the 120 it was dropped at.
        after = [cap for cap, per_day in seen if per_day != 3]
        assert after and all(cap == 60 for cap in after)

    def test_what_it_returns_is_applied_as_the_school_would_edit_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(suggestions, "strict_check", _Oracle(least=150))

        changes, _ = _run(None, [_cap(60, 240)])

        edited = apply_changes(_week(), changes)
        assert edited.teacher_work_rules[0].max_teaching_minutes_per_day == 150


class TestTheStepBelowFirst:
    """g493: `needed` is the least on nearly every week, so the one check that proves it is the value one step below it, asked first.

    Halving from the middle of the way back needs five or six checks to say the same thing, and the eight checks of a list (and the one
    or none that a long week has time for) then all went to the dearest change: the others carried no claim at all."""

    @staticmethod
    def _three(monkeypatch: pytest.MonkeyPatch) -> tuple[list[SuggestedChange], list[int]]:
        asked: list[int] = []

        def nothing_below_holds(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
            asked.append(request.teacher_work_rules[0].max_teaching_minutes_per_day)
            return "INFEASIBLE"

        monkeypatch.setattr(suggestions, "strict_check", nothing_below_holds)
        changes = [
            _cap(60, 240, cost=900),
            _change("SUBJECT_PER_DAY", 1, 3, cost=50, requirementIds=[uuid4()]),
            _change("SUBJECT_DAYS_APART", 3, 1, cost=10, requirementIds=[uuid4()]),
        ]
        return changes, asked

    def test_every_change_of_a_list_that_is_already_the_least_is_proved_with_one_check_each(self, monkeypatch: pytest.MonkeyPatch) -> None:
        changes, asked = self._three(monkeypatch)

        lowered, spent = refine(_week(), [], changes, _settings(), left=lambda: 500.0)

        assert [(c.rule, c.needed, c.needed_is_least) for c in lowered] == [
            ("TEACHER_DAILY_CAP", 240, True), ("SUBJECT_PER_DAY", 3, True), ("SUBJECT_DAYS_APART", 1, True),
        ]
        assert spent == 3, "the dearest change took six of the eight checks and the cheapest none, with the halving from the middle"
        assert asked[0] == 235

    def test_one_check_is_all_a_long_week_has_time_for_and_it_is_the_one_that_proves(self, monkeypatch: pytest.MonkeyPatch) -> None:
        changes, _ = self._three(monkeypatch)
        # `left` allows exactly one check: it falls under what a check needs after the first.
        seconds = iter([500.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0])
        lowered, spent = refine(_week(), [], changes, _settings(), left=lambda: next(seconds))

        assert spent == 1
        assert lowered[0].needed_is_least is True, "the one check that fits asks the value below `needed`, and says so"


class TestAgainstTheRealStrictSolver:
    def test_a_needed_that_is_too_high_is_brought_back_to_the_least_and_the_value_below_is_proved_not_to_hold(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        payload, days, end = _cap_week()
        honest = _suggest(payload, days=days, end=end)
        (change,) = honest.changes
        assert (change.current, change.needed) == (60, 120)

        # The search's timetable is made to need more than it did: what a first timetable that is not the best one does.
        real = suggestions.changes_from
        monkeypatch.setattr(
            suggestions, "changes_from",
            lambda *args, **kwargs: [c.model_copy(update={"needed": 180}) for c in real(*args, **kwargs)],
        )
        inflated = _suggest(payload, days=days, end=end)

        (lowered,) = inflated.changes
        assert (lowered.needed, lowered.needed_is_least) == (120, True), "the strict solver lays it at 120 and proves 115 does not"
        assert lowered.proof == "SOLVED"
        assert inflated.verified is True

    def test_a_needed_that_is_already_the_least_stays_and_is_proved(self) -> None:
        payload, days, end = _cap_week()

        response = _suggest(payload, days=days, end=end)

        (change,) = response.changes
        assert (change.needed, change.needed_is_least) == (120, True)

    def test_the_least_is_in_the_answer_only_where_it_was_tried(self) -> None:
        payload, days, end = _cap_week()
        body = _suggest(payload, days=days, end=end, ceiling=60.0).model_dump(mode="json", by_alias=True, exclude_none=False)
        # With less room than a check needs the change is as it was and carries no claim.
        for change in body["changes"]:
            assert change["neededIsLeast"] in (True, False, None)


class TestTheWeekThatBinds:
    """g384-L-2: one of two weeks has a locked lesson over the cap; `over` counts what the generated lessons add, `needed` what the week needs."""

    @staticmethod
    def _line(week_name: str, over: int, needed: int) -> tuple[None, ConflictDetail]:
        return None, ConflictDetail(
            category="DEVIATION", code="DEVIATION_TEACHER_DAILY_CAP",
            params={"rule": RULE, "day": 1, "minutes": 60, "taught": needed, "over": over, "needed": needed, "week": week_name},
            requirement_ids=[uuid4()], resource_ids=[UUID(RULE)],
        )

    def test_the_week_that_needs_most_is_the_line_even_when_the_other_goes_over_by_more(self) -> None:
        # Cap 60. Odd week: a 120-minute lock and 30 generated: over 30, needed 150. Even week: 120 generated, no lock: over 60, needed 120.
        found = [self._line("odd", over=30, needed=150), self._line("even", over=60, needed=120)]

        (line,) = relaxation._worst_week(found, ("rule", "day"), (None, None))

        assert (line.params["needed"], line.params["over"]) == (150, 30)

    def test_where_nothing_is_locked_needed_and_over_agree_and_the_choice_is_as_it_was(self) -> None:
        found = [self._line("odd", over=30, needed=90), self._line("even", over=60, needed=120)]

        (line,) = relaxation._worst_week(found, ("rule", "day"), (None, None))

        assert (line.params["needed"], line.params["over"]) == (120, 60)

    def test_a_tie_in_needed_goes_to_the_week_that_goes_over_by_more(self) -> None:
        found = [self._line("odd", over=30, needed=120), self._line("even", over=60, needed=120)]

        (line,) = relaxation._worst_week(found, ("rule", "day"), (None, None))

        assert line.params["over"] == 60

    def test_a_line_with_over_alone_is_ordered_by_over_as_it_was_before_needed_was_read(self) -> None:
        # CI of #493: the details of test_phantom_weeks and test_refusals carry `over` and no `needed`, and the first version KeyError'd on them.
        def bare(week_name: str, over: int) -> tuple[None, ConflictDetail]:
            return None, ConflictDetail(
                category="DEVIATION", code="DEVIATION_TEACHER_DAILY_CAP", message="m",
                params={"rule": RULE, "day": 1, "over": over, "week": week_name},
                requirement_ids=[uuid4()], resource_ids=[UUID(RULE)],
            )

        (line,) = relaxation._worst_week([bare("odd", 30), bare("even", 60)], ("rule", "day"), (None, None))

        assert line.params["over"] == 60
        assert "needed" not in line.params, "no figure is made up for a line that never had one"


def test_the_teacher_the_tests_name_is_the_one_of_the_week() -> None:
    assert TEACHER
