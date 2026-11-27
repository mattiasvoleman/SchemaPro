"""Åtgärdsförslag vid vägran: a part-timer's days do not move what is said of the other changes (G6b, g510).

The gateway shows no figure of a post's days to anyone, and says no `neededIsLeast` of them (g493-L-5). The lowering (`refine`) gives every change
checks from one budget of `MAX_REFINEMENTS`, dearest first, and a day weighs 1 200 against a cap's 14 for five minutes: the days came FIRST, and
what they spent was what the cheaper changes did not get. A reader who may not read HR saw `neededIsLeast` on the others: proved where the
post's `needed` was already the least (one check), not tried on more of the cheapest where it was not (three checks), and one more proved where
the post fell away (it was dropped, and nothing in the answer says it was there). Which of those it was is the post's: how far over its days it
is and whether one fewer would do.

What is held here: the answer for every OTHER change is the same whatever the part-timer's figures are (and is what a list with no part-timer
gives), against a strict check whose answer the test decides, and the days still get their checks, after the others'.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from app.schemas.schedule import OptimizeScheduleRequest
from app.schemas.suggestions import SuggestedChange
from app.solver import suggestions
from app.solver.suggestions import MAX_REFINEMENTS, MAX_REFINEMENTS_DAYS, refine
from tests.test_suggest_changes import _settings

VISIBLE = MAX_REFINEMENTS + 1  # one more cap than the checks of the list reach, so that the cheapest never gets one when something is ahead of it


def _week(caps: list[UUID], limit: UUID | None, days: int) -> OptimizeScheduleRequest:
    teachers = [uuid4() for _ in range(len(caps) + 1)]
    group, subject, room = uuid4(), uuid4(), uuid4()
    payload: dict[str, object] = {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "requirements": [{
            "id": str(uuid4()), "subjectId": str(subject), "studentGroupId": str(group), "teacherId": str(teachers[0]),
            "lessonsPerWeek": 1, "minutesPerLesson": 60, "studentGroupSize": 20, "minGradeLevel": 7, "maxGradeLevel": 7,
        }],
        "rooms": [{"id": str(room), "capacity": 30}],
        "teacherWorkRules": [
            {"id": str(rule), "teacherId": str(teachers[index]), "maxTeachingMinutesPerDay": 60} for index, rule in enumerate(caps)
        ],
    }
    if limit is not None:
        payload["teacherDayLimits"] = [{"id": str(limit), "teacherId": str(teachers[-1]), "maxTeachingDaysPerWeek": days, "lockedWeekdays": [[]]}]
    return OptimizeScheduleRequest.model_validate(payload)


class _Truth:
    """The strict model, decided by the test: a changed value holds from its least up, and not below it."""

    def __init__(self, caps: dict[UUID, int], days: dict[UUID, int]) -> None:
        self.caps, self.days, self.asked = caps, days, 0

    def __call__(self, request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
        self.asked += 1
        if any(rule.max_teaching_minutes_per_day < self.caps[rule.id] for rule in request.teacher_work_rules):
            return "INFEASIBLE"
        if any(limit.max_teaching_days_per_week < self.days[limit.id] for limit in request.teacher_day_limits):
            return "INFEASIBLE"
        return "ACCEPTED"


def _run(monkeypatch: pytest.MonkeyPatch, post: dict[str, int] | None, *, visible: int = VISIBLE):  # noqa: ANN202
    """The lowering of `visible` caps (each already at its least, the dearest first) and, if `post` is given, a part-timer's days.

    `post` is the part-timer's figures: the days it has (`current`), the days the search's timetable took (`needed`) and the fewest that
    would still lay the week (`least`).
    """
    caps = [uuid4() for _ in range(visible)]
    limit = uuid4() if post is not None else None
    request = _week(caps, limit, post["current"] if post is not None else 1)
    changes: list[SuggestedChange] = [
        SuggestedChange.model_validate({
            "rule": "TEACHER_DAILY_CAP", "cost": (visible - index) * 20, "current": 60, "needed": 120, "weekdays": [1],
            "requirementIds": [], "roomIds": [], "resourceIds": [str(rule)], "proof": "SOLVED_TOGETHER",
        })
        for index, rule in enumerate(caps)
    ]
    truth = _Truth({rule: 120 for rule in caps}, {})
    if post is not None and limit is not None:
        changes.append(SuggestedChange.model_validate({
            "rule": "TEACHER_WORK_DAYS", "cost": 1200 * (post["needed"] - post["current"]), "current": post["current"], "needed": post["needed"],
            "weekdays": [2], "requirementIds": [], "roomIds": [], "resourceIds": [str(limit)], "proof": "SOLVED_TOGETHER",
        }))
        truth.days[limit] = post["least"]
    monkeypatch.setattr(suggestions, "strict_check", truth)
    refined, spent = refine(request, [], sorted(changes, key=lambda change: change.cost), _settings(), left=lambda: 1000.0, workers=4)
    others = [(change.needed, change.needed_is_least) for change in refined if change.rule != "TEACHER_WORK_DAYS"]
    days = [change for change in refined if change.rule == "TEACHER_WORK_DAYS"]
    return others, days, spent, truth


# The post's figures: days it has, days the timetable took, the fewest that still lay the week.
POSTS = {
    "one day over, at its least": {"current": 3, "needed": 4, "least": 4},
    "four days over, at its least": {"current": 1, "needed": 5, "least": 5},
    "four days over, two of them not needed": {"current": 1, "needed": 5, "least": 3},
    "four days over, none of them needed": {"current": 1, "needed": 5, "least": 1},
}


class TestWhatIsSaidOfTheOthers:
    def test_it_is_the_same_whatever_the_part_timers_days_are_and_is_what_a_list_without_one_says(self, monkeypatch: pytest.MonkeyPatch) -> None:
        without, _, _, _ = _run(monkeypatch, None)
        said = {name: _run(monkeypatch, post)[0] for name, post in POSTS.items()}

        for name, others in said.items():
            assert others == without, f"{name}: what is said of the caps moved with the part-timer's days"

    def test_the_cheapest_cap_is_the_one_that_has_no_check_left_and_it_says_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        others, _, _, _ = _run(monkeypatch, POSTS["four days over, two of them not needed"])

        assert others[0] == (120, None), "the cheapest of nine caps, with eight checks for the caps"
        assert all(least is True for _, least in others[1:])


class TestTheDaysAreStillChecked:
    def test_a_post_that_is_over_by_more_than_it_needs_is_lowered_with_checks_of_its_own(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _, days, spent, truth = _run(monkeypatch, POSTS["four days over, two of them not needed"])

        (post,) = days
        assert (post.needed, post.needed_is_least) == (3, True)
        assert spent == MAX_REFINEMENTS + 3 == truth.asked, "eight for the caps and three, with the halving, for the days"

    def test_a_post_the_week_does_not_need_to_change_is_still_dropped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _, days, _, _ = _run(monkeypatch, POSTS["four days over, none of them needed"])

        assert days == []

    def test_the_days_are_checked_with_the_caps_as_they_ended_and_the_caps_with_the_days_as_the_search_had_them(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen: list[tuple[int, int]] = []

        def check(request, lessons, settings, *, seconds, workers=None):  # noqa: ANN001, ANN202
            lowest = min(rule.max_teaching_minutes_per_day for rule in request.teacher_work_rules)
            seen.append((lowest, request.teacher_day_limits[0].max_teaching_days_per_week))
            return "ACCEPTED" if lowest >= 65 else "INFEASIBLE"

        caps = [uuid4() for _ in range(2)]
        limit = uuid4()
        request = _week(caps, limit, 1)
        changes = [
            SuggestedChange.model_validate({
                "rule": "TEACHER_DAILY_CAP", "cost": 100 - index, "current": 60, "needed": 70, "weekdays": [1],
                "requirementIds": [], "roomIds": [], "resourceIds": [str(rule)], "proof": "SOLVED_TOGETHER",
            })
            for index, rule in enumerate(caps)
        ] + [SuggestedChange.model_validate({
            "rule": "TEACHER_WORK_DAYS", "cost": 4800, "current": 1, "needed": 5, "weekdays": [2],
            "requirementIds": [], "roomIds": [], "resourceIds": [str(limit)], "proof": "SOLVED_TOGETHER",
        })]
        monkeypatch.setattr(suggestions, "strict_check", check)

        refined, _ = refine(request, [], sorted(changes, key=lambda change: change.cost), _settings(), left=lambda: 1000.0)

        assert [change.needed for change in refined if change.rule == "TEACHER_DAILY_CAP"] == [65, 65], "both caps were lowered to what holds"
        assert seen[0][1] == 5, "the caps were checked first, with the days as the search had them"
        days_checks = [pair for pair in seen if pair[1] != 5]
        assert days_checks and all(lowest == 65 for lowest, _ in days_checks), "the days last, with both caps already at 65"

    def test_the_days_have_a_budget_of_their_own_and_it_is_bounded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A post over by a hundred days (a made-up figure, to see where it stops): it spends MAX_REFINEMENTS_DAYS and no more.
        limit = uuid4()
        request = _week([], limit, 1)
        change = SuggestedChange.model_validate({
            "rule": "TEACHER_WORK_DAYS", "cost": 1200 * 99, "current": 1, "needed": 100, "weekdays": [2],
            "requirementIds": [], "roomIds": [], "resourceIds": [str(limit)], "proof": "SOLVED",
        })
        truth = _Truth({}, {limit: 1})
        monkeypatch.setattr(suggestions, "strict_check", truth)

        _, spent = refine(request, [], [change], _settings(), left=lambda: 1000.0)

        assert spent == MAX_REFINEMENTS_DAYS == truth.asked
