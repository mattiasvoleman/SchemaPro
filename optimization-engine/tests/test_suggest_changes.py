"""Åtgärdsförslag vid vägran: POST /api/v1/suggest-changes and app/solver/suggestions.py.

A WEEK THE ENGINE REFUSED HAS A REASON A SCHOOL CAN ACT ON, and the engine already
knows it: Bästa möjliga schema lets five rules give way and says how far. This route
turns that into changes, and asks the one question the deviations cannot answer for
themselves: does the STRICT model, with exactly those changes applied, accept the
timetable the search found?

WHAT THESE TESTS HOLD, in the order a reader would ask:

* the CHANGES the deviations ask for, by rule, added up per thing a school edits, in
  the engine's price and order (pure: fabricated deviation lines);
* the CHANGED WEEK (`apply_changes`), request untouched, and the same week the school
  would have after editing by hand;
* THE ORACLE: for each of the five rules, the engine's strict solver, given the
  changed week by hand and nothing else, lays the week; and with the change one step
  short of `needed` it does not. That is what makes "needed" a number and not a
  claim, and it is independent of the check the route runs;
* THE PROOF'S SHAPE: a list of one is SOLVED, a list of several is SOLVED_TOGETHER
  and one of them alone does NOT lay the week, a check that does not accept or does
  not run is MAY_HELP;
* the four VERDICTS;
* the route: key, validation, the payload's own refusals, the gate, the ceiling, and
  that the OpenAPI document gains a route and schemas and changes nothing else.

THE WEEKS ARE ARITHMETIC A READER CAN DO IN THEIR HEAD, as in test_best_effort.py.
"""

from __future__ import annotations

import asyncio
import time
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import (
    ConflictDetail,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    Relaxation,
    ScheduledLesson,
    SearchOptions,
)
from app.schemas.suggestions import SuggestedChange
from app.solver import relaxation, suggestions
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.suggestions import apply_changes, changes_from, strict_accepts, suggest_changes
from tests import test_optimize as to
from tests.test_best_effort import (
    GROUP,
    LIMIT,
    OTHER_GROUP,
    OTHER_REQUIREMENT,
    OTHER_TEACHER,
    REQUIREMENT,
    ROOM_A,
    ROOM_B,
    RULE,
    SUBJECT,
    TEACHER,
    _payload,
    _requirement,
    _settings,
)

HEADERS = {"X-API-Key": to.API_KEY}

#: Every name of the answer, by hand: a field renamed on one side only is a 422 or a missing key in
#: the other. The gateway's contract spec lists the same.
RESPONSE_KEYS = {
    "requestId", "verdict", "changes", "verified", "searchSeconds", "verifySeconds", "elapsedMs", "conflicts",
}
CHANGE_KEYS = {
    "rule", "cost", "current", "needed", "weekdays", "requirementIds", "roomIds", "resourceIds", "proof",
}


def _engine(**overrides: object) -> Settings:
    """The engine's settings with the week's own days and a budget the test names."""
    values: dict[str, object] = {"SOLVER_MAX_TIME_SECONDS": 20.0, "SCHEDULE_DAYS": "1,2,3", "SCHEDULE_DAY_END_MINUTES": 720}
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate({k: v for k, v in payload.items() if k != "relaxation"})


def _suggest(payload: dict[str, object], *, days: str = "1,2,3", end: int = 720, ceiling: float = 200.0):  # noqa: ANN202
    return suggest_changes(_request(payload), _settings(days=days, end=end), ceiling_seconds=ceiling)


def _strict_solves(request: OptimizeScheduleRequest, *, days: str, end: int = 720) -> bool:
    """Whether the strict solver, asked cold, lays the week: the oracle, which shares nothing with the check."""
    try:
        response = SchedulerSolver(_settings(days=days, end=end)).solve(request)
    except InvalidScheduleInputError:
        return False
    return response.status in ("OPTIMAL", "FEASIBLE") and bool(response.lessons) and not response.deviations


def _deviation(code: str, params: dict[str, str | int], **ids: list[UUID]) -> ConflictDetail:
    return ConflictDetail(category="DEVIATION", code=code, params=params, **ids)  # type: ignore[arg-type]


def _cap_line(day: int, over: int, needed: int, cap: int = 60, rule: str = RULE) -> ConflictDetail:
    return _deviation(
        "DEVIATION_TEACHER_DAILY_CAP",
        {"rule": rule, "day": day, "minutes": cap, "taught": needed, "over": over, "needed": needed},
        requirement_ids=[UUID(REQUIREMENT)], resource_ids=[UUID(rule)],
    )


# ---------------------------------------------------------------------------
# The changes the deviations ask for
# ---------------------------------------------------------------------------


class TestTheChanges:
    def _week(self) -> OptimizeScheduleRequest:
        return _request(_payload(
            relax=False,
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        ))

    def test_a_cap_breached_on_two_days_is_one_change_with_the_largest_need(self) -> None:
        lines = [_cap_line(1, over=30, needed=90), _cap_line(3, over=60, needed=120)]
        (change,) = changes_from(self._week(), [], lines)
        assert change.rule == "TEACHER_DAILY_CAP"
        assert (change.current, change.needed) == (60, 120)
        assert change.weekdays == [1, 3]
        assert change.resource_ids == [UUID(RULE)]
        assert change.proof == "MAY_HELP"  # not said until the check has run

    def test_the_cap_is_priced_per_five_minutes_whatever_the_grid(self) -> None:
        # 90 minutes over, at 14 per five minutes: 18 x 14. A 15-minute breach is 3 x 14 = 42 (relaxation's own
        # reading, tests/test_best_effort.py): the same price per minute on every grid.
        assert changes_from(self._week(), [], [_cap_line(1, over=90, needed=150)])[0].cost == 18 * 14
        assert changes_from(self._week(), [], [_cap_line(1, over=15, needed=75)])[0].cost == 42

    def test_the_cap_unit_is_the_one_the_prices_are_read_in(self) -> None:
        assert suggestions._CAP_UNIT_MINUTES == relaxation._CAP_BASE_MINUTES

    def test_the_days_of_a_post(self) -> None:
        request = _request(_payload(
            relax=False,
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]]}],
        ))
        line = _deviation(
            "DEVIATION_TEACHER_WORK_DAYS",
            {"limit": LIMIT, "days": 1, "taught": 2, "over": 1, "needed": 2},
            requirement_ids=[UUID(REQUIREMENT)], resource_ids=[UUID(LIMIT)],
        )
        (change,) = changes_from(request, [], [line])
        assert change.rule == "TEACHER_WORK_DAYS"
        assert (change.current, change.needed, change.cost) == (1, 2, 1200)
        assert change.resource_ids == [UUID(LIMIT)]

    def test_a_subject_s_cap_per_day_and_its_days_apart_are_the_requirement_s(self) -> None:
        request = _request(_payload(relax=False))
        per_day = _deviation(
            "DEVIATION_SUBJECT_PER_DAY",
            {"requirement": REQUIREMENT, "day": 2, "maxPerDay": 1, "count": 2, "over": 1, "needed": 2},
            requirement_ids=[UUID(REQUIREMENT)],
        )
        apart = _deviation(
            "DEVIATION_SUBJECT_DAYS_APART",
            {"requirement": OTHER_REQUIREMENT, "minDaysBetween": 2, "pairs": 3, "closest": 1, "needed": 1},
            requirement_ids=[UUID(OTHER_REQUIREMENT)],
        )
        changes = changes_from(request, [], [per_day, apart])
        by_rule = {change.rule: change for change in changes}
        assert (by_rule["SUBJECT_PER_DAY"].current, by_rule["SUBJECT_PER_DAY"].needed) == (1, 2)
        assert by_rule["SUBJECT_PER_DAY"].cost == 20
        assert by_rule["SUBJECT_PER_DAY"].weekdays == [2]
        assert (by_rule["SUBJECT_DAYS_APART"].current, by_rule["SUBJECT_DAYS_APART"].needed) == (2, 1)
        assert by_rule["SUBJECT_DAYS_APART"].cost == 30  # three pairs at 10

    def test_every_class_a_room_rule_locks_adds_to_one_change(self) -> None:
        preference = str(uuid4())
        request = _request(_payload(
            relax=False,
            requirements=[
                _requirement(lessonsPerWeek=1),
                _requirement(id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, teacherId=OTHER_TEACHER, lessonsPerWeek=1),
            ],
            roomPreferences=[{"id": preference, "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"}],
        ))
        lines = [
            _deviation("DEVIATION_ROOM_LOCK", {"requirement": REQUIREMENT, "lessons": 1, "of": 1},
                       requirement_ids=[UUID(REQUIREMENT)], room_ids=[UUID(ROOM_B)]),
            _deviation("DEVIATION_ROOM_LOCK", {"requirement": OTHER_REQUIREMENT, "lessons": 2, "of": 2},
                       requirement_ids=[UUID(OTHER_REQUIREMENT)], room_ids=[UUID(ROOM_B)]),
        ]
        (change,) = changes_from(request, [], lines)
        assert change.rule == "ROOM_LOCK"
        assert change.resource_ids == [UUID(preference)]
        assert change.room_ids == [UUID(ROOM_B)]
        assert change.requirement_ids == [UUID(REQUIREMENT), UUID(OTHER_REQUIREMENT)]
        assert change.cost == 3 * 40
        assert (change.current, change.needed) == (None, None)

    def test_the_cheapest_change_comes_first_and_ties_go_to_the_milder_rule(self) -> None:
        request = _request(_payload(
            relax=False,
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        ))
        per_day = _deviation(
            "DEVIATION_SUBJECT_PER_DAY",
            {"requirement": REQUIREMENT, "day": 1, "maxPerDay": 1, "count": 2, "over": 1, "needed": 2},
            requirement_ids=[UUID(REQUIREMENT)],
        )
        # 20 for the lesson over its day; 140 for half an hour over a cap.
        changes = changes_from(request, [], [_cap_line(1, over=50, needed=110), per_day])
        assert [change.rule for change in changes] == ["SUBJECT_PER_DAY", "TEACHER_DAILY_CAP"]
        assert [change.cost for change in changes] == [20, 140]
        # Equal price: the rule that gives way first in relaxation.RELAXABLE_RULES goes first. Two pairs too
        # close (2 x 10) cost what one lesson over its day does (20), and the spacing is the milder.
        tie = changes_from(request, [], [
            per_day,
            _deviation("DEVIATION_SUBJECT_DAYS_APART",
                       {"requirement": OTHER_REQUIREMENT, "minDaysBetween": 2, "pairs": 2, "closest": 1, "needed": 1},
                       requirement_ids=[UUID(OTHER_REQUIREMENT)]),
        ])
        assert [change.cost for change in tie] == [20, 20]
        assert [change.rule for change in tie] == ["SUBJECT_DAYS_APART", "SUBJECT_PER_DAY"]

    def test_an_order_is_the_same_whatever_order_the_lines_came_in(self) -> None:
        request = self._week()
        lines = [_cap_line(1, over=30, needed=90), _cap_line(2, over=60, needed=120)]
        assert changes_from(request, [], lines) == changes_from(request, [], lines[::-1])

    def test_a_line_of_a_rule_this_reader_does_not_know_is_left_out_and_not_said(self) -> None:
        # A sentence the catalogue has no entry for: its message is given, as a newer engine would send it.
        unknown = ConflictDetail(category="DEVIATION", code="DEVIATION_SOMETHING_NEW", params={"over": 1}, message="x")
        assert changes_from(self._week(), [], [unknown]) == []

    def test_the_names_of_the_rules_are_the_engine_s_own(self) -> None:
        assert set(suggestions._RULE_ORDER) == {rule.name for rule in relaxation.RELAXABLE_RULES}
        assert set(suggestions._RULE_OF_CODE.values()) == set(suggestions._RULE_ORDER)

    def test_a_part_time_post_is_told_its_days_only_for_a_school_with_one_week(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # One week, locks on Monday: the post takes two days more than it allows; the lightest day the
        # lessons add is the one named.
        request = _request(_payload(
            relax=False,
            requirements=[_requirement(lessonsPerWeek=3)],
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]]}],
        ))
        # Two hours on Monday and one on Wednesday: the post goes over by a day, and the day to give is the lighter.
        lessons = [
            ScheduledLesson(requirement_id=REQUIREMENT, room_id=ROOM_A, day_of_week=1,
                            start_time="08:00:00", end_time="09:00:00"),
            ScheduledLesson(requirement_id=REQUIREMENT, room_id=ROOM_A, day_of_week=1,
                            start_time="09:00:00", end_time="10:00:00"),
            ScheduledLesson(requirement_id=REQUIREMENT, room_id=ROOM_A, day_of_week=3,
                            start_time="08:00:00", end_time="09:00:00"),
        ]
        line = _deviation(
            "DEVIATION_TEACHER_WORK_DAYS",
            {"limit": LIMIT, "days": 1, "taught": 2, "over": 1, "needed": 2},
            requirement_ids=[UUID(REQUIREMENT)], resource_ids=[UUID(LIMIT)],
        )
        (change,) = changes_from(request, lessons, [line])
        assert change.weekdays == [3]
        # With alternating weeks the day is not the same in each: none is named.
        monkeypatch.setattr(suggestions, "_weeks_of", lambda request: (None, None))
        (unnamed,) = changes_from(request, lessons, [line])
        assert unnamed.weekdays == []


# ---------------------------------------------------------------------------
# The changed week
# ---------------------------------------------------------------------------


class TestTheChangedWeek:
    def test_it_is_the_week_a_school_would_have_after_editing(self) -> None:
        request = _request(_payload(
            relax=False,
            requirements=[_requirement(lessonsPerWeek=3, maxLessonsPerDay=1, minDaysBetween=3)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]]}],
        ))
        changes = [
            SuggestedChange(rule="TEACHER_DAILY_CAP", cost=1, current=60, needed=120,
                            resource_ids=[UUID(RULE)], proof="MAY_HELP"),
            SuggestedChange(rule="TEACHER_WORK_DAYS", cost=1, current=1, needed=2,
                            resource_ids=[UUID(LIMIT)], proof="MAY_HELP"),
            SuggestedChange(rule="SUBJECT_PER_DAY", cost=1, current=1, needed=2,
                            requirement_ids=[UUID(REQUIREMENT)], proof="MAY_HELP"),
            SuggestedChange(rule="SUBJECT_DAYS_APART", cost=1, current=3, needed=2,
                            requirement_ids=[UUID(REQUIREMENT)], proof="MAY_HELP"),
        ]
        changed = apply_changes(request, changes)
        assert changed.teacher_work_rules[0].max_teaching_minutes_per_day == 120
        assert changed.teacher_day_limits[0].max_teaching_days_per_week == 2
        assert changed.requirements[0].max_lessons_per_day == 2
        assert changed.requirements[0].min_days_between == 2
        assert changed.relaxation is None and changed.search is None

    def test_the_changed_week_carries_neither_the_mode_nor_the_search_of_the_request_it_came_from(self) -> None:
        request = _request(_payload(
            relax=False,
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        )).model_copy(update={
            "relaxation": Relaxation(mode="BEST_EFFORT"),
            "search": SearchOptions(max_seconds=30, probes=False),
        })
        changed = apply_changes(request, [])
        assert changed.relaxation is None and changed.search is None

    def test_the_request_it_is_given_is_not_written_to(self) -> None:
        request = _request(_payload(
            relax=False,
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        ))
        before = request.model_dump_json()
        apply_changes(request, [SuggestedChange(rule="TEACHER_DAILY_CAP", cost=1, current=60, needed=120,
                                                resource_ids=[UUID(RULE)], proof="MAY_HELP")])
        assert request.model_dump_json() == before

    def test_a_spread_of_one_day_is_no_rule(self) -> None:
        request = _request(_payload(relax=False, requirements=[_requirement(minDaysBetween=2)]))
        changed = apply_changes(request, [SuggestedChange(
            rule="SUBJECT_DAYS_APART", cost=1, current=2, needed=1, requirement_ids=[UUID(REQUIREMENT)],
            proof="MAY_HELP",
        )])
        assert changed.requirements[0].min_days_between is None

    def test_a_post_is_never_asked_for_more_days_than_a_week_has(self) -> None:
        request = _request(_payload(
            relax=False,
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 5, "lockedWeekdays": [[]]}],
        ))
        changed = apply_changes(request, [SuggestedChange(
            rule="TEACHER_WORK_DAYS", cost=1, current=5, needed=9, resource_ids=[UUID(LIMIT)], proof="MAY_HELP",
        )])
        assert changed.teacher_day_limits[0].max_teaching_days_per_week == 6

    def test_a_room_lock_is_widened_by_a_rule_of_its_own_so_that_a_room_type_works_too(self) -> None:
        preference = str(uuid4())
        request = _request(_payload(
            relax=False,
            roomPreferences=[{"id": preference, "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK",
                              "minGradeLevel": 7, "maxGradeLevel": 9}],
        ))
        changed = apply_changes(request, [SuggestedChange(
            rule="ROOM_LOCK", cost=1, room_ids=[UUID(ROOM_B)], resource_ids=[UUID(preference)],
            requirement_ids=[UUID(REQUIREMENT)], proof="MAY_HELP",
        )])
        assert len(changed.room_preferences) == 2
        added = changed.room_preferences[1]
        # The same subject and years, so that the two are alternatives of one tier and their rooms union.
        assert (added.subject_id, added.kind, added.min_grade_level, added.max_grade_level) == (
            UUID(SUBJECT), "LOCK", 7, 9,
        )
        assert added.room_ids == [UUID(ROOM_B)]
        assert request.room_preferences[0].room_ids == [UUID(ROOM_A)]


# ---------------------------------------------------------------------------
# The oracle: the strict solver, asked cold, lays the changed week and not one step short of it
# ---------------------------------------------------------------------------


def _cap_week() -> tuple[dict[str, object], str, int]:
    return _payload(
        relax=False,
        teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
    ), "1,2,3", 720


def _days_week() -> tuple[dict[str, object], str, int]:
    return _payload(
        relax=False,
        requirements=[_requirement(lessonsPerWeek=8)],
        teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]]}],
    ), "1,2,3", 720


def _per_day_week() -> tuple[dict[str, object], str, int]:
    return _payload(relax=False, requirements=[_requirement(lessonsPerWeek=3, maxLessonsPerDay=1)]), "1,2", 720


def _apart_week() -> tuple[dict[str, object], str, int]:
    return _payload(
        relax=False,
        requirements=[_requirement(lessonsPerWeek=2, minDaysBetween=2, maxLessonsPerDay=1)],
    ), "1,2", 720


def _lock_week() -> tuple[dict[str, object], str, int]:
    payload = _payload(
        relax=False,
        requirements=[
            _requirement(lessonsPerWeek=1),
            _requirement(id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, teacherId=OTHER_TEACHER, lessonsPerWeek=1),
        ],
        roomPreferences=[{"id": str(uuid4()), "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"}],
    )
    payload["rooms"] = [{"id": ROOM_A, "capacity": 30}, {"id": ROOM_B, "capacity": 30}]
    return payload, "1", 540


WEEKS = {
    "TEACHER_DAILY_CAP": _cap_week,
    "TEACHER_WORK_DAYS": _days_week,
    "SUBJECT_PER_DAY": _per_day_week,
    "SUBJECT_DAYS_APART": _apart_week,
    "ROOM_LOCK": _lock_week,
}


class TestTheOracle:
    @pytest.mark.parametrize("rule", list(WEEKS))
    def test_the_strict_solver_refuses_the_week_and_lays_the_changed_one(self, rule: str) -> None:
        payload, days, end = WEEKS[rule]()
        request = _request(payload)
        assert not _strict_solves(request, days=days, end=end), "the week must be refused as it stands"

        response = _suggest(payload, days=days, end=end)

        assert response.verdict == "CHANGES"
        assert [change.rule for change in response.changes] == [rule]
        assert response.verified is True
        assert [change.proof for change in response.changes] == ["SOLVED"]
        # The oracle: the change made by hand, the strict solver asked cold.
        assert _strict_solves(apply_changes(request, response.changes), days=days, end=end)

    @pytest.mark.parametrize("rule", ["TEACHER_DAILY_CAP", "TEACHER_WORK_DAYS", "SUBJECT_PER_DAY"])
    def test_one_step_short_of_what_is_needed_does_not_lay_it(self, rule: str) -> None:
        payload, days, end = WEEKS[rule]()
        request = _request(payload)
        (change,) = _suggest(payload, days=days, end=end).changes
        assert change.needed is not None
        step = 5 if rule == "TEACHER_DAILY_CAP" else 1
        short = change.model_copy(update={"needed": change.needed - step})
        assert not _strict_solves(apply_changes(request, [short]), days=days, end=end)

    def test_a_week_that_needs_two_changes_is_laid_by_both_and_by_neither_alone(self) -> None:
        # A cap the teacher's four hours break (60 a day over two days) and a subject of three
        # lessons one a day on the same two days.
        payload = _payload(
            relax=False,
            requirements=[
                _requirement(lessonsPerWeek=4),
                _requirement(id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, teacherId=OTHER_TEACHER,
                             lessonsPerWeek=3, maxLessonsPerDay=1),
            ],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        )
        request = _request(payload)

        response = _suggest(payload, days="1,2")

        assert {change.rule for change in response.changes} == {"TEACHER_DAILY_CAP", "SUBJECT_PER_DAY"}
        assert response.verified is True
        assert {change.proof for change in response.changes} == {"SOLVED_TOGETHER"}
        # Cheapest first: a lesson over its day (20) before two hours over a cap.
        assert [change.rule for change in response.changes] == ["SUBJECT_PER_DAY", "TEACHER_DAILY_CAP"]
        assert _strict_solves(apply_changes(request, response.changes), days="1,2")
        for kept in response.changes:
            alone = [change for change in response.changes if change is not kept]
            assert not _strict_solves(apply_changes(request, alone), days="1,2"), kept.rule

    def test_the_check_accepts_the_changed_week_and_refuses_one_that_is_too_small(self) -> None:
        payload, days, end = _cap_week()
        request = _request(payload)
        settings = _settings(days=days)
        (change,) = suggest_changes(request, settings, ceiling_seconds=200).changes
        found = SchedulerSolver(settings).solve(request.model_copy(update={"relaxation": Relaxation(mode="BEST_EFFORT")}))
        assert strict_accepts(apply_changes(request, [change]), found.lessons, settings, seconds=10)
        short = change.model_copy(update={"needed": 90})
        assert not strict_accepts(apply_changes(request, [short]), found.lessons, settings, seconds=10)


# ---------------------------------------------------------------------------
# The proof's shape and the verdicts
# ---------------------------------------------------------------------------


class TestTheVerdicts:
    def test_a_check_that_does_not_accept_says_may_help_and_not_solved(self, monkeypatch: pytest.MonkeyPatch) -> None:
        payload, days, end = _cap_week()
        monkeypatch.setattr(suggestions, "strict_accepts", lambda *args, **kwargs: False)
        response = _suggest(payload, days=days, end=end)
        assert response.verdict == "CHANGES"
        assert response.verified is False
        assert [change.proof for change in response.changes] == ["MAY_HELP"]

    def test_a_check_that_has_no_time_is_not_started_and_says_may_help(self, monkeypatch: pytest.MonkeyPatch) -> None:
        payload, days, end = _cap_week()
        ran: list[bool] = []
        monkeypatch.setattr(suggestions, "strict_accepts", lambda *args, **kwargs: ran.append(True) or True)
        # A ceiling of 45 s less the answer's slack and the overrun a solve may make (13 s) leaves 32 s, and the
        # check's own build is not under its clock: 30 s of headroom leave it 2 s, and under five it is not started.
        response = _suggest(payload, days=days, end=end, ceiling=45.0)
        assert ran == []
        assert response.verified is False and response.verify_seconds is None
        assert [change.proof for change in response.changes] == ["MAY_HELP"]
        # With room for it, the same week is checked.
        response = _suggest(payload, days=days, end=end, ceiling=60.0)
        assert ran == [True]
        assert response.verified is True and response.verify_seconds is not None

    def test_a_week_the_search_lays_with_nothing_giving_way_is_solvable_as_it_is(self) -> None:
        # The cap is not binding: four hours over three days at 120 a day.
        payload = _payload(
            relax=False,
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
        )
        response = _suggest(payload)
        assert response.verdict == "SOLVABLE_AS_IS"
        assert response.changes == []
        assert response.verified is True

    def test_a_week_with_no_rule_to_relax_is_solved_strictly_by_the_search_itself(self) -> None:
        response = _suggest(_payload(relax=False))
        assert response.verdict == "SOLVABLE_AS_IS"
        assert response.verified is True and response.verify_seconds is None

    def test_a_hard_rule_that_refuses_the_week_is_a_refusal_with_its_explanation_and_no_change(self) -> None:
        # One class, two 60-minute lessons, one slot in the whole week, and a cap on the teacher that
        # does not matter: the class is in one place at a time, and no rule on the list can help.
        payload = _payload(
            relax=False,
            requirements=[_requirement(lessonsPerWeek=2)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
        )
        response = _suggest(payload, days="1", end=540)
        assert response.verdict == "HARD_REFUSAL"
        assert response.changes == [] and response.verified is False
        assert response.conflicts is not None and response.conflicts.conflicts

    def test_a_search_that_found_nothing_in_its_time_says_so_and_not_that_none_exists(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        payload, days, end = _cap_week()

        def timeout(self: SchedulerSolver, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
            return OptimizeScheduleResponse(request_id=request.request_id, status="TIMEOUT", lessons=[])

        monkeypatch.setattr(SchedulerSolver, "solve", timeout)
        response = _suggest(payload, days=days, end=end)
        assert response.verdict == "NOT_FOUND"
        assert response.changes == [] and response.verified is False

    def test_the_search_is_the_one_a_candidate_run_makes_and_never_probes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        payload, days, end = _cap_week()
        seen: list[OptimizeScheduleRequest] = []
        original = SchedulerSolver.solve

        def spy(self: SchedulerSolver, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
            seen.append(request)
            return original(self, request)

        monkeypatch.setattr(SchedulerSolver, "solve", spy)
        payload["search"] = {"maxSeconds": 9, "workers": 2, "seed": 3, "probes": True}
        payload["relaxation"] = None  # a caller's own is ignored: the route asks for the mode itself
        _suggest(payload, days=days, end=end)
        # solve() builds a solver of its own for a request that carries `search` and calls it again: the first
        # call is the route's.
        request = seen[0]
        assert request.relaxation is not None and request.relaxation.mode == "BEST_EFFORT"
        assert request.search is not None
        assert (request.search.max_seconds, request.search.workers, request.search.seed, request.search.probes) == (
            9, 2, 3, False,
        )

    def test_the_search_is_given_the_default_when_the_request_names_none_and_never_more_than_the_engine_allows(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        payload, days, end = _cap_week()
        seen: list[int | None] = []
        original = SchedulerSolver.solve

        def spy(self: SchedulerSolver, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
            seen.append(None if request.search is None else request.search.max_seconds)
            return original(self, request)

        monkeypatch.setattr(SchedulerSolver, "solve", spy)
        suggest_changes(_request(payload), _engine(), ceiling_seconds=200)
        suggest_changes(_request({**payload, "search": {"maxSeconds": 600}}), _engine(), ceiling_seconds=200)
        assert seen == [20, 20]  # 60 s by default, cut to the engine's 20; 600 s asked, cut to 20

    def test_the_limits_are_the_search_the_check_and_two_builds(self) -> None:
        from app.timing import BUILD_HEADROOM_SECONDS

        limits = suggestions.route_limits(_engine(SOLVER_MAX_TIME_SECONDS=180.0))
        assert limits.budget_seconds == suggestions.DEFAULT_SEARCH_SECONDS + suggestions.VERIFY_SECONDS
        assert limits.probe_seconds == 0.0
        assert limits.headroom_seconds == 2 * BUILD_HEADROOM_SECONDS
        short = suggestions.route_limits(_engine(SOLVER_MAX_TIME_SECONDS=20.0))
        assert short.budget_seconds == 20 + suggestions.VERIFY_SECONDS


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def _app_settings() -> object:
    return to._settings(SCHEDULE_DAYS="1,2,3", SCHEDULE_DAY_END_MINUTES=720, SOLVER_MAX_TIME_SECONDS=20.0)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(_app_settings()))  # type: ignore[arg-type]


def _body() -> dict[str, object]:
    payload, _, _ = _cap_week()
    return payload


def test_the_route_answers_with_exactly_the_published_names(client: TestClient) -> None:
    response = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_KEYS
    assert body["verdict"] == "CHANGES" and body["verified"] is True
    (change,) = body["changes"]
    assert set(change) == CHANGE_KEYS
    assert (change["rule"], change["current"], change["needed"], change["proof"]) == (
        "TEACHER_DAILY_CAP", 60, 120, "SOLVED",
    )
    assert change["resourceIds"] == [RULE]
    assert body["elapsedMs"] >= 0 and body["searchSeconds"] == 20


def test_the_route_ignores_a_relaxation_the_caller_sends(client: TestClient) -> None:
    payload = _body()
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    assert client.post("/api/v1/suggest-changes", json=payload, headers=HEADERS).json()["verdict"] == "CHANGES"


def test_the_route_wants_the_service_key(client: TestClient) -> None:
    assert client.post("/api/v1/suggest-changes", json=_body()).status_code == 401
    assert client.post("/api/v1/suggest-changes", json=_body(), headers={"X-API-Key": "wrong"}).status_code == 401


def test_the_route_refuses_a_body_generera_would_refuse(client: TestClient) -> None:
    payload = _body()
    payload["somethingNew"] = 1
    response = client.post("/api/v1/suggest-changes", json=payload, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_refusal_of_the_payload_is_the_400_generera_gives(client: TestClient) -> None:
    payload = to._dining_payload([30])
    payload["rules"] = to._lunch_rules(diningSeats=20)
    suggest = client.post("/api/v1/suggest-changes", json=payload, headers=HEADERS)
    run = client.post("/api/v1/optimize", json=payload, headers=HEADERS)
    assert suggest.status_code == run.status_code == 400
    assert suggest.json() == run.json()


def test_a_second_analysis_while_one_runs_is_answered_429_and_not_queued(client: TestClient) -> None:
    client.app.state.suggest_changes_gate = asyncio.Semaphore(0)  # type: ignore[attr-defined]
    response = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
    assert response.status_code == 429
    assert "Another analysis" in response.json()["message"]


def test_an_analysis_that_is_not_done_in_its_ceiling_is_answered_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1 import suggest_changes as route

    monkeypatch.setattr(route, "solve_ceiling_seconds", lambda *args: 0.05)
    monkeypatch.setattr(route, "suggest_changes", lambda *args, **kwargs: time.sleep(0.5))
    response = client.post("/api/v1/suggest-changes", json=_body(), headers=HEADERS)
    assert response.status_code == 503
    assert response.json()["code"] == "SOLVER_TIMEOUT"
    assert response.json()["details"]["route"] == "suggest-changes"


def test_a_caller_who_waits_less_is_answered_inside_the_wait() -> None:
    from app.api.v1.suggest_changes import solve_ceiling_seconds

    settings = _engine()
    own = suggestions.route_limits(settings).ceiling_seconds
    assert solve_ceiling_seconds(settings, None, None) == own
    assert solve_ceiling_seconds(settings, None, 60.0) == 55.0  # the caller's wait less the transfer margin
    assert solve_ceiling_seconds(settings, None, 10_000.0) == own  # a deadline only ever shortens it


def test_an_analysis_does_not_change_what_a_run_is_told(client: TestClient) -> None:
    payload, _, _ = _per_day_week()
    first = client.post("/api/v1/optimize", json=payload, headers=HEADERS).json()
    client.post("/api/v1/suggest-changes", json=payload, headers=HEADERS)
    again = client.post("/api/v1/optimize", json=payload, headers=HEADERS).json()
    assert first == again


# ---------------------------------------------------------------------------
# The published contract only grows
# ---------------------------------------------------------------------------


def test_the_openapi_document_gains_a_route_and_schemas_and_changes_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deployed with the API from one merge, so an older gateway must read every other route and schema
    exactly as before. The baseline is an app built with this router swapped for an empty one; a model
    named like one that exists would rename BOTH in the document, which is why every key of the baseline
    must be equal, not merely present.
    """
    from app import main as main_module

    with_route = create_app(to._settings()).openapi()
    monkeypatch.setattr(main_module, "suggest_changes_router", APIRouter())
    without = create_app(to._settings()).openapi()

    assert set(with_route["paths"]) == set(without["paths"]) | {"/api/v1/suggest-changes"}
    for path, item in without["paths"].items():
        assert with_route["paths"][path] == item, path
    assert set(with_route["paths"]["/api/v1/suggest-changes"]) == {"post"}
    for name, schema in without["components"]["schemas"].items():
        assert with_route["components"]["schemas"][name] == schema, name
    added = set(with_route["components"]["schemas"]) - set(without["components"]["schemas"])
    assert added == {"SuggestChangesResponse", "SuggestedChange"}, added
    assert not [name for name in with_route["components"]["schemas"] if "__" in name]

    operation = with_route["paths"]["/api/v1/suggest-changes"]["post"]
    # The request IS Generera's, so no request schema is added for it.
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/OptimizeScheduleRequest",
    }
    schemas = with_route["components"]["schemas"]
    assert set(schemas["SuggestChangesResponse"]["properties"]) == RESPONSE_KEYS
    assert set(schemas["SuggestedChange"]["properties"]) == CHANGE_KEYS
    assert schemas["SuggestChangesResponse"]["properties"]["verdict"]["enum"] == [
        "CHANGES", "SOLVABLE_AS_IS", "NOT_FOUND", "HARD_REFUSAL",
    ]
    assert schemas["SuggestedChange"]["properties"]["proof"]["enum"] == ["SOLVED", "SOLVED_TOGETHER", "MAY_HELP"]
    assert schemas["SuggestedChange"]["properties"]["rule"]["enum"] == [
        rule.name for rule in relaxation.RELAXABLE_RULES
    ]


def test_the_timing_report_is_not_changed(client: TestClient) -> None:
    """GET /timing is read by an API that deploys beside this engine: the route adds no entry to it."""
    routes = client.get("/api/v1/timing", headers=HEADERS).json()["routes"]
    assert set(routes) == {"optimize", "optimize-rooms", "staff", "plan-exams"}
