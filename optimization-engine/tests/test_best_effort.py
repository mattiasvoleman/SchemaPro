"""Bästa möjliga schema: the week placed even when its rules cannot all hold.

TWO MODES, ONE ENGINE (app/solver/relaxation.py). A request without
`relaxation` is solved as it always was; with `relaxation.mode ==
"BEST_EFFORT"` the five rules on the list become prices, and the answer is a
timetable with `deviations` beside it. What follows pins, in the order a
reader would ask:

- the CONTRACT (the field is additive; absent is today's bytes);
- the LIST (its order is the order the rules give way in, every rule has a
  sentence, the strip takes out exactly the list);
- EACH RULE, strict against best-effort: strict refuses by name, best-effort
  places and says how far the rule gave way and what it would need;
- THE ORDER: the mildest deviation is chosen first;
- WHAT NEVER GIVES WAY: the hard rules refuse in best-effort with the strict
  words;
- DOMINANCE: a soft wish never outweighs a rule that can be kept.

THE WEEKS ARE ARITHMETIC A READER CAN DO IN THEIR HEAD, as in
test_teacher_day.py: 08:00-12:00, four 60-minute lessons a day.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.messages import MESSAGES, arguments_of, render
from app.schemas.schedule import (
    AnonymousRequirement,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    ScheduledLesson,
)
from app.solver import relaxation
from app.solver.relaxation import (
    HARD_RULES,
    RELAXABLE_RULES,
    WEIGHT,
    deviations_of,
    dominating_scale,
    prices_anything,
    strip,
)
from app.solver.scheduler_solver import SchedulerSolver, _teacher_locks

TEACHER = str(uuid4())
OTHER_TEACHER = str(uuid4())
GROUP = str(uuid4())
OTHER_GROUP = str(uuid4())
RULE = str(uuid4())
LIMIT = str(uuid4())
REQUIREMENT = str(uuid4())
OTHER_REQUIREMENT = str(uuid4())
SUBJECT = str(uuid4())
ROOM_A = str(uuid4())
ROOM_B = str(uuid4())


def _settings(days: str = "1,2,3", end: int = 720, **overrides: object) -> Settings:
    return Settings(
        SOLVER_MAX_TIME_SECONDS=20.0, SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end,
        **overrides,  # type: ignore[arg-type]
    )


def _requirement(**values: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": REQUIREMENT,
        "subjectId": SUBJECT,
        "studentGroupId": GROUP,
        "teacherId": TEACHER,
        "lessonsPerWeek": 4,
        "minutesPerLesson": 60,
        "studentGroupSize": 24,
        "minGradeLevel": 7,
        "maxGradeLevel": 7,
    }
    row.update(values)
    return row


def _payload(
    *,
    requirements: list[dict[str, object]] | None = None,
    rooms: int = 2,
    relax: bool = True,
    **extra: object,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements or [_requirement()],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(rooms)],
    }
    payload.update(extra)
    if relax:
        payload["relaxation"] = {"mode": "BEST_EFFORT"}
    return payload


def _solve(payload: dict[str, object], **settings: object) -> OptimizeScheduleResponse:
    return SchedulerSolver(_settings(**settings)).solve(  # type: ignore[arg-type]
        OptimizeScheduleRequest.model_validate(payload),
    )


def _codes(response: OptimizeScheduleResponse) -> list[str]:
    return [detail.code for detail in response.deviations or []]


def _strict(payload: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in payload.items() if key != "relaxation"}


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


class TestTheContract:
    def test_absent_is_a_strict_solve_without_the_key(self) -> None:
        response = _solve(_payload(relax=False), days="1,2,3")
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert response.deviations is None
        assert "deviations" not in response.model_dump(by_alias=True, exclude_none=False) or (
            response.model_dump(by_alias=True)["lessons"]
        )
        assert "deviations" not in response.model_dump_json(by_alias=True)

    def test_a_week_with_nothing_on_the_list_comes_back_with_an_empty_list(self) -> None:
        response = _solve(_payload())
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert response.deviations == []
        assert '"deviations":[]' in response.model_dump_json(by_alias=True)

    def test_the_mode_is_one_known_word(self) -> None:
        with pytest.raises(ValidationError):
            OptimizeScheduleRequest.model_validate({**_payload(), "relaxation": {"mode": "ANYTHING"}})

    def test_there_is_no_list_on_the_wire(self) -> None:
        # What may give way is the code's one list, never the request's.
        with pytest.raises(ValidationError):
            OptimizeScheduleRequest.model_validate(
                {**_payload(), "relaxation": {"mode": "BEST_EFFORT", "rules": ["ROOM_LOCK"]}},
            )

    def test_a_refusal_never_carries_the_list(self) -> None:
        # One class, two 60-minute lessons, a single slot in the whole week:
        # a hard rule (the class is in one place at a time) cannot hold.
        payload = _payload(requirements=[_requirement(lessonsPerWeek=2)])
        response = _solve(payload, days="1", end=540)
        assert response.status == "INFEASIBLE"
        assert response.deviations is None
        assert response.conflicts is not None

    def test_a_candidate_call_carries_the_mode_and_the_search_together(self) -> None:
        # The gateway's schemaförslag call sends `search` on every request:
        # its budget, workers and seed shape the solve, and the mode is the
        # same mode. Phase 2 then starts from a completed hint.
        payload = _payload(
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            search={"maxSeconds": 10, "workers": 2, "seed": 1, "probes": False},
        )
        response = _solve(payload, days="1")
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert _codes(response) == ["DEVIATION_TEACHER_DAILY_CAP"]

    def test_a_refusal_without_probes_is_still_a_refusal_of_a_hard_rule(self) -> None:
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=2)],
            search={"maxSeconds": 10, "probes": False},
        )
        response = _solve(payload, days="1", end=540)
        assert response.status == "INFEASIBLE"
        assert response.deviations is None

    def test_the_category_is_new_and_only_deviations_use_it(self) -> None:
        response = _solve(
            _payload(teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}]),
            days="1",
        )
        assert response.deviations
        assert {detail.category for detail in response.deviations} == {"DEVIATION"}
        assert response.conflicts is None


# ---------------------------------------------------------------------------
# The list
# ---------------------------------------------------------------------------


class TestTheList:
    def test_the_weights_are_the_order_the_rules_give_way_in(self) -> None:
        # Mildest first. The cap is priced per five minutes, so it is compared
        # on a lesson of an hour (twelve slots); every other rule on its unit.
        per_lesson = {
            "SUBJECT_DAYS_APART": WEIGHT["SUBJECT_DAYS_APART"],
            "SUBJECT_PER_DAY": WEIGHT["SUBJECT_PER_DAY"],
            "ROOM_LOCK": WEIGHT["ROOM_LOCK"],
            "TEACHER_DAILY_CAP": WEIGHT["TEACHER_DAILY_CAP"] * 12,
            "TEACHER_WORK_DAYS": WEIGHT["TEACHER_WORK_DAYS"],
        }
        names = [rule.name for rule in RELAXABLE_RULES]
        assert names == list(per_lesson)
        values = [per_lesson[name] for name in names]
        assert values == sorted(values)
        assert len(set(values)) == len(values)

    @staticmethod
    def _lesson_lengths_the_product_allows() -> range:
        # Read off the schema, not typed here: lowering the shortest lesson
        # breaks this test and asks for the weights to be worked again.
        metadata = AnonymousRequirement.model_fields["minutes_per_lesson"].metadata
        shortest = next(item.ge for item in metadata if hasattr(item, "ge"))
        longest = next(item.le for item in metadata if hasattr(item, "le"))
        return range(shortest, longest + 1, 5)

    def test_a_room_is_ahead_of_a_cap_breached_by_one_lesson_of_any_length(self) -> None:
        # MEDEL-1 of the review of #285: at 4 per five minutes a 40-minute
        # lesson over the cap cost 32, less than a room (40), against the
        # screen's and the manual's "mildest first". Every length the product
        # allows, 15 to 240 minutes.
        cap_per_slot = WEIGHT["TEACHER_DAILY_CAP"]
        for minutes in self._lesson_lengths_the_product_allows():
            assert cap_per_slot * (minutes // 5) > WEIGHT["ROOM_LOCK"], minutes
            assert cap_per_slot * (minutes // 5) > WEIGHT["SUBJECT_PER_DAY"], minutes

    def test_a_post_s_day_is_ahead_of_a_cap_breached_for_a_whole_teaching_day(self) -> None:
        # The other end: raising the cap's price must not put it after the
        # contract's day. Seven hours of teaching, 84 slots, over the cap.
        assert WEIGHT["TEACHER_DAILY_CAP"] * (7 * 60 // 5) < WEIGHT["TEACHER_WORK_DAYS"]
        # The longest lesson there is, over the cap by all of it, is cheaper too.
        longest = self._lesson_lengths_the_product_allows()[-1]
        assert WEIGHT["TEACHER_DAILY_CAP"] * (longest // 5) < WEIGHT["TEACHER_WORK_DAYS"]

    def test_the_cap_is_priced_the_same_per_minute_on_every_grid(self) -> None:
        # The builders count the cap in slots; the price per minute is the
        # weight's whatever the grid (SLOT_MINUTES divides 60).
        for slot_minutes in (5, 10, 15, 20, 30):
            relax = relaxation.Relax(slot_minutes)
            per_slot = relax._cap_slot_weight  # noqa: SLF001
            assert per_slot == WEIGHT["TEACHER_DAILY_CAP"] * slot_minutes // 5

    def test_every_rule_has_a_sentence_and_the_sentence_renders(self) -> None:
        for rule in RELAXABLE_RULES:
            assert rule.code in MESSAGES, rule.code
            assert rule.reason and rule.unit
            args = arguments_of(MESSAGES[rule.code])
            assert args, rule.code
            # Rendering with every argument given never leaves a brace.
            text = render(rule.code, {name: 1 for name in args})
            assert "{" not in text and "}" not in text

    def test_the_post_s_sentence_carries_the_masked_word(self) -> None:
        # The gateway masks every sentence whose code contains WORK_DAYS for a
        # reader without HR access; the deviation about a post's days must be
        # one of them.
        assert "WORK_DAYS" in relaxation.CODE["TEACHER_WORK_DAYS"]

    def test_the_hard_rules_are_named_once(self) -> None:
        assert len(HARD_RULES) == len(set(HARD_RULES))
        assert any("booked twice" in rule for rule in HARD_RULES)
        assert any("frame times" in rule for rule in HARD_RULES)
        assert any("walk" in rule for rule in HARD_RULES)

    def test_strip_takes_out_exactly_the_list(self) -> None:
        request = OptimizeScheduleRequest.model_validate(_payload(
            requirements=[_requirement(maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[1])],
            teacherWorkRules=[{
                "id": RULE, "teacherId": TEACHER,
                "maxTeachingMinutesPerDay": 240, "minDailyRestMinutes": 660,
                "lunchMinutes": 30, "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00",
            }],
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[]]}],
            roomPreferences=[
                {"id": str(uuid4()), "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"},
                {"id": str(uuid4()), "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "WISH"},
            ],
        ))
        hard = strip(request)
        assert hard.relaxation is None
        assert hard.teacher_day_limits == []
        requirement = hard.requirements[0]
        assert requirement.max_lessons_per_day is None
        assert requirement.min_days_between is None
        assert requirement.locked_days == [1]  # where the school's own lessons are
        rule = hard.teacher_work_rules[0]
        assert rule.max_teaching_minutes_per_day is None
        # The teacher's own rest and lunch are the law's and stay.
        assert rule.min_daily_rest_minutes == 660
        assert rule.lunch_minutes == 30
        assert [preference.kind for preference in hard.room_preferences] == ["WISH"]
        assert prices_anything(request)
        assert not prices_anything(hard)

    def test_the_step_does_not_move_when_the_list_is_taken_out(self) -> None:
        from app.solver.scheduler_solver import _start_step

        request = OptimizeScheduleRequest.model_validate(_payload(
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 125}],
        ))
        solver = SchedulerSolver(_settings())
        assert _start_step(strip(request), solver._grid) == _start_step(request, solver._grid)

    def test_the_dominating_scale_is_above_the_bound_it_is_given(self) -> None:
        assert dominating_scale(0) == 2
        assert dominating_scale(1_000) == 1_001
        assert dominating_scale(-5) == 2

    def test_the_bound_is_the_largest_value_the_expression_can_take(self) -> None:
        # A bound of 0 once made the scale 2 and let a wish outweigh a rule
        # that could be kept: this protobuf answers domain[-1] with 0.
        from ortools.sat.python import cp_model

        model = cp_model.CpModel()
        flag = model.NewBoolVar("flag")
        count = model.NewIntVar(0, 10, "count")
        shifted = model.NewIntVar(-5, 7, "shifted")
        assert relaxation.upper_bound(model, 1000 * flag + 3 * count) == 1030
        assert relaxation.upper_bound(model, 2 * shifted + 1) == 15
        assert relaxation.upper_bound(model, -4 * shifted) == 20
        assert relaxation.upper_bound(model, 3 * (1 - flag) + count) == 13

    def test_the_prices_in_a_build_are_above_the_whole_soft_objective(self) -> None:
        payload = _payload(
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            weights={"preferredFree": 1000},
        )
        solver = SchedulerSolver(_settings())
        request = OptimizeScheduleRequest.model_validate(_strict(payload))
        relax = relaxation.Relax(solver._grid.slot_minutes)
        model, *_ = solver._build_model(
            request, use_assumptions=False, include_objective=True, relax=relax,
        )
        proto = model.Proto()
        names = [variable.name for variable in proto.variables]
        priced = {
            coefficient for index, coefficient in zip(proto.objective.vars, proto.objective.coeffs)
            if names[index].startswith("ldcapover_")
        }
        soft_total = sum(
            abs(coefficient) * max(abs(v) for v in (list(proto.variables[index].domain)[0], list(proto.variables[index].domain)[-1]))
            for index, coefficient in zip(proto.objective.vars, proto.objective.coeffs)
            if not names[index].startswith(("ldcapover_", "lddaysover_", "dist"))
        )
        assert priced
        # One slot of the cap, at its price, outweighs every soft term at once.
        assert min(priced) > soft_total


# ---------------------------------------------------------------------------
# Each rule: strict refuses, best-effort places and says how far
# ---------------------------------------------------------------------------


class TestTheDailyCap:
    PAYLOAD = _payload(
        teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
    )

    def test_strict_refuses_by_name(self) -> None:
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(_strict(self.PAYLOAD), days="1")
        assert refusal.value.code.startswith("TEACHER_DAILY_CAP")

    def test_best_effort_places_all_four_and_names_the_cap(self) -> None:
        response = _solve(self.PAYLOAD, days="1")
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert len(response.lessons) == 4
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_TEACHER_DAILY_CAP"
        assert detail.params == {
            "rule": RULE, "day": 1, "minutes": 120, "taught": 240, "over": 120, "needed": 240,
        }
        assert detail.resource_ids == [UUID(RULE)]
        assert detail.requirement_ids == [UUID(REQUIREMENT)]
        assert "240" in detail.message and "Monday" in detail.message

    def test_a_cap_that_can_be_kept_is_kept(self) -> None:
        # Three days: 2 + 1 + 1 under a 120-minute cap, so nothing gives way.
        response = _solve(self.PAYLOAD, days="1,2,3")
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert response.deviations == []

    def test_the_least_over_is_chosen(self) -> None:
        # Two days, 4 hours, cap 120: two a day is the only way to give least.
        response = _solve(self.PAYLOAD, days="1,2")
        assert response.deviations == []

    def test_locked_lessons_are_facts_and_only_the_added_part_is_reported(self) -> None:
        locked = {
            "id": str(uuid4()), "teacherId": TEACHER, "studentGroupId": str(uuid4()),
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "10:00:00",
        }
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=1)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            fixedLessons=[locked],
        )
        # One day, the lock fills the cap: the generated hour is all that is added.
        response = _solve(payload, days="1")
        (detail,) = response.deviations or []
        assert detail.params["over"] == 60
        assert detail.params["taught"] == 180


class TestTheWorkDays:
    PAYLOAD = _payload(
        requirements=[_requirement(lessonsPerWeek=8)],
        teacherDayLimits=[{
            "id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]],
        }],
    )

    def test_strict_refuses_by_name(self) -> None:
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(_strict(self.PAYLOAD))
        assert "WORK_DAYS" in refusal.value.code

    def test_best_effort_adds_the_fewest_days(self) -> None:
        response = _solve(self.PAYLOAD)
        assert len(response.lessons) == 8
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_TEACHER_WORK_DAYS"
        assert detail.params == {
            "limit": LIMIT, "days": 1, "taught": 2, "over": 1, "needed": 2,
        }
        assert detail.resource_ids == [UUID(LIMIT)]
        assert len({lesson.day_of_week for lesson in response.lessons}) == 2

    def test_a_post_that_can_be_kept_is_kept(self) -> None:
        payload = {**self.PAYLOAD, "requirements": [_requirement(lessonsPerWeek=4)]}
        assert _solve(payload).deviations == []


class TestTheSubjectsDistribution:
    def test_per_day(self) -> None:
        # Three lessons, one a day, two days: one day holds two.
        payload = _payload(requirements=[_requirement(lessonsPerWeek=3, maxLessonsPerDay=1)])
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(_strict(payload), days="1,2")
        assert refusal.value.code.startswith("SUBJECT_DISTRIBUTION")
        response = _solve(payload, days="1,2")
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_SUBJECT_PER_DAY"
        assert detail.params["over"] == 1
        assert detail.params["maxPerDay"] == 1
        assert detail.params["needed"] == 2
        assert detail.requirement_ids == [UUID(REQUIREMENT)]

    def test_days_apart(self) -> None:
        # Two lessons, not on consecutive days, and the week has Monday and Tuesday.
        # Two lessons of the subject may share a day (that is the per-day
        # cap's question, not this rule's), so the spacing only binds with
        # "one a day" beside it and a week of two consecutive days.
        payload = _payload(requirements=[_requirement(
            lessonsPerWeek=2, minDaysBetween=2, maxLessonsPerDay=1,
        )])
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(_strict(payload), days="1,2")
        assert refusal.value.code == "SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT"
        response = _solve(payload, days="1,2")
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_SUBJECT_DAYS_APART"
        assert detail.params["closest"] == 1
        assert detail.params["pairs"] == 1
        assert detail.params["minDaysBetween"] == 2
        assert detail.params["needed"] == 1

    def test_a_lock_next_to_a_day_is_a_day_too_close(self) -> None:
        # The school locked a lesson on Monday; the rest may not be on Tuesday.
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=1, minDaysBetween=2, lockedDays=[1])],
        )
        response = _solve(payload, days="2")
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_SUBJECT_DAYS_APART"
        assert detail.params["closest"] == 1

    def test_a_rule_that_can_be_kept_is_kept(self) -> None:
        payload = _payload(requirements=[_requirement(
            lessonsPerWeek=2, maxLessonsPerDay=1, minDaysBetween=2,
        )])
        assert _solve(payload, days="1,2,3").deviations == []


class TestTheRoomLock:
    def _payload(self, **extra: object) -> dict[str, object]:
        # Two classes of one subject, locked to ROOM_A, and one slot in the
        # whole week: they meet at 08:00, and only one of them can have A.
        rooms = [{"id": ROOM_A, "capacity": 30}, {"id": ROOM_B, "capacity": 30}]
        payload = _payload(
            requirements=[
                _requirement(lessonsPerWeek=1),
                _requirement(
                    id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, teacherId=OTHER_TEACHER,
                    lessonsPerWeek=1,
                ),
            ],
            roomPreferences=[{"id": str(uuid4()), "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"}],
            **extra,
        )
        payload["rooms"] = rooms
        return payload

    def test_strict_refuses_by_name(self) -> None:
        with pytest.raises(InvalidScheduleInputError) as refusal:
            _solve(_strict(self._payload()), days="1", end=540)
        assert refusal.value.code == "ROOM_LOCK_WEEK_TOO_SMALL"

    def test_best_effort_puts_one_class_outside_and_says_which(self) -> None:
        response = _solve(self._payload(), days="1", end=540)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert len(response.lessons) == 2
        (detail,) = response.deviations or []
        assert detail.code == "DEVIATION_ROOM_LOCK"
        assert detail.params["lessons"] == 1
        assert detail.room_ids == [UUID(ROOM_B)]
        placed_in_b = [lesson for lesson in response.lessons if str(lesson.room_id) == ROOM_B]
        assert [str(lesson.requirement_id) for lesson in placed_in_b] == [str(detail.requirement_ids[0])]

    def test_with_room_for_both_nothing_gives_way(self) -> None:
        response = _solve(self._payload(), days="1", end=600)  # two slots: one each, A both times
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert response.deviations == []
        assert {str(lesson.room_id) for lesson in response.lessons} == {ROOM_A}


# ---------------------------------------------------------------------------
# The order: the mildest first
# ---------------------------------------------------------------------------


class TestTheOrder:
    def test_a_spacing_goes_before_a_per_day_cap(self) -> None:
        # Two lessons, "at most one a day" and "not on consecutive days", and
        # only Monday and Tuesday: either rule can give way, and the spacing
        # is the milder (10 against 20), so the lessons stay one a day.
        payload = _payload(requirements=[_requirement(
            lessonsPerWeek=2, maxLessonsPerDay=1, minDaysBetween=2,
        )])
        response = _solve(payload, days="1,2")
        assert _codes(response) == ["DEVIATION_SUBJECT_DAYS_APART"]
        assert {lesson.day_of_week for lesson in response.lessons} == {1, 2}

    def test_a_per_day_cap_goes_before_a_teacher_s_extra_day(self) -> None:
        # Four lessons, a teacher on one day only and "one a day" for the
        # subject. Both cannot hold on Monday and Tuesday: the cap on the
        # subject is the milder breach, so the teacher stays on one day.
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=4, maxLessonsPerDay=1)],
            teacherDayLimits=[{
                "id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]],
            }],
        )
        response = _solve(payload, days="1,2")
        assert _codes(response) == ["DEVIATION_SUBJECT_PER_DAY"]
        assert len({lesson.day_of_week for lesson in response.lessons}) == 1

    def test_a_cap_goes_before_a_teacher_s_extra_day(self) -> None:
        # Four hours, a cap of two hours a day and a post of one day: the cap
        # gives way (120 minutes over is 24 slots of four) before the post
        # gets a day it does not have (500).
        payload = _payload(
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            teacherDayLimits=[{
                "id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]],
            }],
        )
        response = _solve(payload, days="1,2")
        assert _codes(response) == ["DEVIATION_TEACHER_DAILY_CAP"]

    @staticmethod
    def _lock_against(minutes: int, **requirement: object) -> OptimizeScheduleResponse:
        # One teacher, one subject locked to room A, Monday and Tuesday, and
        # room A closed on Tuesday: the last lesson goes either beside the
        # others on Monday (what the Monday rule gives way) or on Tuesday in
        # room B (the lock gives way). A cap is given as True and is then
        # one lesson short of the Monday: (n - 1) lessons, so Monday is over it
        # by one whole lesson. A cap is 30 minutes at the least (the schema),
        # so lessons shorter than that are three, not two.
        lessons = 3 if minutes < 30 else 2
        cap = (lessons - 1) * minutes if requirement.pop("cap", False) else None
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=lessons, minutesPerLesson=minutes, **requirement)],
            roomPreferences=[{"id": str(uuid4()), "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"}],
            constraints=[{
                "id": str(uuid4()), "resourceKind": "ROOM", "resourceId": ROOM_A, "dayOfWeek": 2,
                "startTime": "08:00:00", "endTime": "12:00:00", "kind": "UNAVAILABLE",
            }],
        )
        if cap is not None:
            payload["teacherWorkRules"] = [{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": cap}]
        payload["rooms"] = [{"id": ROOM_A, "capacity": 30}, {"id": ROOM_B, "capacity": 30}]
        return _solve(payload, days="1,2")

    @pytest.mark.parametrize("minutes", [15, 20, 25, 30, 40, 45, 50, 60, 80, 90])
    def test_a_room_lock_goes_before_a_teacher_s_cap_whatever_the_lesson_length(self, minutes: int) -> None:
        # The review's case (MEDEL-1): at 40 and 45 minutes the cap used to
        # give way first, against "mildest first". Now a lesson goes to the
        # other room at every length from the shortest the product allows.
        response = self._lock_against(minutes, cap=True)
        assert response.status in ("OPTIMAL", "FEASIBLE")
        assert _codes(response) == ["DEVIATION_ROOM_LOCK"], minutes
        assert {lesson.day_of_week for lesson in response.lessons} == {1, 2}

    @pytest.mark.parametrize("minutes", [15, 30, 40, 60])
    def test_a_per_day_cap_goes_before_a_room_lock(self, minutes: int) -> None:
        # The pair on the other side of the lock: "one a day" gives way (20)
        # before the lock does (40), so both lessons stay in room A.
        response = self._lock_against(minutes, maxLessonsPerDay=1)
        assert _codes(response) == ["DEVIATION_SUBJECT_PER_DAY"], minutes
        assert {str(lesson.room_id) for lesson in response.lessons} == {ROOM_A}

    def test_the_least_amount_is_chosen_within_one_rule(self) -> None:
        # 90-minute lessons under a 120-minute cap, three of them, two days:
        # 180 + 90 is 60 over on one day; the other split is the same. Nothing
        # better exists, and nothing worse is chosen.
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=3, minutesPerLesson=45)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 90}],
        )
        response = _solve(payload, days="1,2")
        assert response.deviations == []  # 45 + 45 on one day, 45 on the other

    def test_a_soft_wish_never_outweighs_a_rule_that_can_be_kept(self) -> None:
        # A teacher wants Tuesday and Wednesday free (the strongest wish the
        # objective prices) and has a two-hour cap: the lessons must spread
        # over Monday and the other days to keep the cap, wish or not.
        constraints = [
            {
                "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": TEACHER,
                "dayOfWeek": day, "startTime": "08:00:00", "endTime": "12:00:00",
                "kind": "PREFERRED_FREE",
            }
            for day in (2, 3)
        ]
        payload = _payload(
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            constraints=constraints,
            weights={"preferredFree": 1000},
        )
        response = _solve(payload, days="1,2,3")
        assert response.deviations == []
        assert len({lesson.day_of_week for lesson in response.lessons}) >= 2


# ---------------------------------------------------------------------------
# What never gives way
# ---------------------------------------------------------------------------


class TestTheHardRules:
    def test_a_class_in_two_places_is_refused_as_strict_refuses_it(self) -> None:
        payload = _payload(requirements=[_requirement(lessonsPerWeek=2)])
        strict = _solve(_strict(payload), days="1", end=540)
        relaxed = _solve(payload, days="1", end=540)
        assert strict.status == relaxed.status == "INFEASIBLE"
        assert strict.conflicts is not None and relaxed.conflicts is not None
        assert relaxed.conflicts.summary_code == strict.conflicts.summary_code
        assert relaxed.lessons == []

    def test_a_teacher_in_two_places_is_refused(self) -> None:
        payload = _payload(requirements=[
            _requirement(lessonsPerWeek=1),
            _requirement(
                id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, lessonsPerWeek=1,
            ),
        ])
        strict = _solve(_strict(payload), days="1", end=540)
        relaxed = _solve(payload, days="1", end=540)
        assert strict.status == relaxed.status == "INFEASIBLE"
        assert relaxed.conflicts is not None

    def test_a_lesson_outside_the_frame_is_refused(self) -> None:
        frames = [{
            "minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "08:00:00", "endTime": "09:00:00",
        }]
        payload = _payload(requirements=[_requirement(lessonsPerWeek=2)], frameTimes=frames)
        response = _solve(payload, days="1")
        assert response.status == "INFEASIBLE"
        assert response.deviations is None

    def test_a_week_that_gives_way_on_the_list_is_still_refused_for_a_hard_rule(self) -> None:
        # The cap would give way; the class cannot be in two places, and that
        # is what the refusal names.
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=2)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 30}],
        )
        response = _solve(payload, days="1", end=540)
        assert response.status == "INFEASIBLE"
        assert response.lessons == []
        assert response.deviations is None

    def test_a_teachers_unavailable_hours_are_not_a_price(self) -> None:
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=1)],
            constraints=[{
                "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": TEACHER,
                "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "12:00:00",
                "kind": "UNAVAILABLE",
            }],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 30}],
        )
        response = _solve(payload, days="1")
        assert response.status == "INFEASIBLE"

    def test_the_teachers_rest_is_not_on_the_list(self) -> None:
        rule = {"id": RULE, "teacherId": TEACHER, "minDailyRestMinutes": 1320}
        request = OptimizeScheduleRequest.model_validate(_payload(teacherWorkRules=[rule]))
        assert strip(request).teacher_work_rules[0].min_daily_rest_minutes == 1320
        assert not prices_anything(request)


# ---------------------------------------------------------------------------
# The report is counted on the timetable
# ---------------------------------------------------------------------------


def _lesson(day: int, start: str, end: str, requirement: str = REQUIREMENT, room: str | None = None) -> ScheduledLesson:
    return ScheduledLesson.model_validate({
        "requirementId": requirement, "roomId": room or ROOM_A,
        "dayOfWeek": day, "startTime": start, "endTime": end,
    })


def _evaluate(payload: dict[str, object], lessons: list[ScheduledLesson]):
    request = OptimizeScheduleRequest.model_validate(payload)
    from app.solver.scheduler_solver import resolve_room_locks

    return deviations_of(
        request, lessons, request.rooms,
        resolve_room_locks(request.requirements, request.room_preferences, request.rooms),
        (1, 2, 3, 4, 5),
        flatten=lambda fixed: _teacher_locks(fixed)[0],
    )


class TestTheReport:
    def test_a_cap_is_read_off_the_timetable_in_minutes_and_not_lessons(self) -> None:
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=2, minutesPerLesson=90)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 150}],
        )
        both = _evaluate(payload, [_lesson(1, "08:00:00", "09:30:00"), _lesson(1, "10:00:00", "11:30:00")])
        assert [detail.params["over"] for detail in both] == [30]
        apart = _evaluate(payload, [_lesson(1, "08:00:00", "09:30:00"), _lesson(2, "08:00:00", "09:30:00")])
        assert apart == []

    def test_a_co_teacher_is_taught_the_cap_too(self) -> None:
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=2, coTeacherId=OTHER_TEACHER)],
            teacherWorkRules=[{"id": RULE, "teacherId": OTHER_TEACHER, "maxTeachingMinutesPerDay": 60}],
        )
        report = _evaluate(payload, [_lesson(1, "08:00:00", "09:00:00"), _lesson(1, "09:00:00", "10:00:00")])
        assert [detail.params["taught"] for detail in report] == [120]

    def test_a_split_posts_lesson_is_its_own_leads(self) -> None:
        other_lesson = ScheduledLesson.model_validate({
            "requirementId": REQUIREMENT, "roomId": ROOM_A, "dayOfWeek": 1,
            "startTime": "09:00:00", "endTime": "10:00:00", "teacherId": OTHER_TEACHER,
        })
        own_lesson = ScheduledLesson.model_validate({
            "requirementId": REQUIREMENT, "roomId": ROOM_A, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00", "teacherId": TEACHER,
        })
        payload = _payload(
            requirements=[_requirement(
                lessonsPerWeek=2, lessonTeacherIds=[TEACHER, OTHER_TEACHER],
            )],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 60}],
        )
        assert _evaluate(payload, [own_lesson, other_lesson]) == []

    def test_an_odd_weeks_lock_is_not_the_even_weeks_cap(self) -> None:
        lock = {
            "id": str(uuid4()), "teacherId": TEACHER, "studentGroupId": str(uuid4()),
            "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "10:00:00",
            "recurrence": "ODD_WEEKS",
        }
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=1)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            fixedLessons=[lock],
        )
        report = _evaluate(payload, [_lesson(1, "10:00:00", "11:00:00")])
        # Over in the odd week (2 h locked + 1 h), fine in the even one: the
        # worse week is the line.
        assert [detail.params["over"] for detail in report] == [60]

    def test_locks_over_the_post_on_their_own_are_not_the_timetable_s_breach(self) -> None:
        locks = [
            {
                "id": str(uuid4()), "teacherId": TEACHER, "studentGroupId": str(uuid4()),
                "dayOfWeek": day, "startTime": "08:00:00", "endTime": "09:00:00",
            }
            for day in (1, 2)
        ]
        payload = _payload(
            requirements=[_requirement(lessonsPerWeek=1)],
            teacherDayLimits=[{
                "id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[1, 2]],
            }],
            fixedLessons=locks,
        )
        # Monday is a locked day: the generated lesson adds nothing.
        assert _evaluate(payload, [_lesson(1, "10:00:00", "11:00:00")]) == []
        # Wednesday adds a day.
        report = _evaluate(payload, [_lesson(3, "10:00:00", "11:00:00")])
        assert [detail.code for detail in report] == ["DEVIATION_TEACHER_WORK_DAYS"]

    def test_the_lightest_days_are_the_ones_to_look_at(self) -> None:
        payload = _payload(
            requirements=[
                _requirement(lessonsPerWeek=3),
                _requirement(id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, lessonsPerWeek=1),
            ],
            teacherDayLimits=[{
                "id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]],
            }],
        )
        payload["requirements"][1]["teacherId"] = TEACHER  # type: ignore[index]
        report = _evaluate(payload, [
            _lesson(1, "08:00:00", "09:00:00"), _lesson(1, "09:00:00", "10:00:00"),
            _lesson(1, "10:00:00", "11:00:00"),
            _lesson(2, "08:00:00", "09:00:00", requirement=OTHER_REQUIREMENT),
        ])
        (detail,) = report
        assert detail.requirement_ids == [UUID(OTHER_REQUIREMENT)]

    def test_nothing_in_a_deviation_names_a_person(self) -> None:
        response = _solve(
            _payload(teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}]),
            days="1",
        )
        text = response.model_dump_json(by_alias=True)
        deviations = str([detail.model_dump(by_alias=True) for detail in response.deviations or []])
        assert TEACHER not in deviations
        assert GROUP not in deviations
        assert "deviations" in text


# ---------------------------------------------------------------------------
# The strict model is the model it was
# ---------------------------------------------------------------------------


class TestTheStrictModelIsUntouched:
    PREFIXES = ("ldcapover_", "lddaysover_", "distover_", "distnear_", "distshut_")

    def _names(self, payload: dict[str, object], **kwargs: object) -> list[str]:
        solver = SchedulerSolver(_settings())
        request = OptimizeScheduleRequest.model_validate(_strict(payload))
        model, *_ = solver._build_model(request, use_assumptions=False, **kwargs)  # type: ignore[arg-type]
        return [variable.name for variable in model.Proto().variables]

    def test_a_strict_build_makes_no_slack(self) -> None:
        payload = _payload(
            requirements=[_requirement(maxLessonsPerDay=1, minDaysBetween=2)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[]]}],
        )
        names = self._names(payload)
        assert not [name for name in names if name.startswith(self.PREFIXES)]

    def test_a_relaxed_build_makes_them(self) -> None:
        payload = _payload(
            requirements=[_requirement(maxLessonsPerDay=1, minDaysBetween=2)],
            teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
            teacherDayLimits=[{"id": LIMIT, "teacherId": TEACHER, "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[]]}],
        )
        solver = SchedulerSolver(_settings())
        request = OptimizeScheduleRequest.model_validate(_strict(payload))
        relax = relaxation.Relax(solver._grid.slot_minutes)
        model, *_ = solver._build_model(request, use_assumptions=False, relax=relax)
        names = [variable.name for variable in model.Proto().variables]
        for prefix in self.PREFIXES[:-1]:
            assert [name for name in names if name.startswith(prefix)], prefix
        assert not relax.empty


# ---------------------------------------------------------------------------
# The report against the strict model, on random weeks
# ---------------------------------------------------------------------------


def _random_week(seed: int) -> tuple[dict[str, object], str]:
    """A small week with rules on the list, pushed hard enough to bind often."""
    import random

    rng = random.Random(seed)
    teachers = [str(uuid4()) for _ in range(rng.randint(1, 3))]
    requirements = []
    for index in range(rng.randint(2, 4)):
        requirements.append(_requirement(
            id=str(uuid4()),
            studentGroupId=str(uuid4()),
            teacherId=rng.choice(teachers),
            lessonsPerWeek=rng.randint(1, 4),
            **({"maxLessonsPerDay": rng.randint(1, 2)} if rng.random() < 0.5 else {}),
            **({"minDaysBetween": 2} if rng.random() < 0.4 else {}),
        ))
    rules = [
        {"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": rng.choice([60, 120, 180])}
        for teacher in teachers
        if rng.random() < 0.6
    ]
    limits = [
        {
            "id": str(uuid4()), "teacherId": teacher,
            "maxTeachingDaysPerWeek": rng.randint(1, 2), "lockedWeekdays": [[]],
        }
        for teacher in teachers
        if rng.random() < 0.5
    ]
    payload = _payload(
        requirements=requirements, rooms=4, teacherWorkRules=rules, teacherDayLimits=limits,
    )
    return payload, rng.choice(["1,2", "1,2,3", "1,2,3,4"])


def _keeps_every_rule(payload: dict[str, object], response: OptimizeScheduleResponse, days: str) -> bool:
    """Whether the STRICT model accepts exactly this timetable's days and times.

    The strict build of the same week, every lesson's start pinned to the one
    the response placed it at: feasible if and only if no rule on the list is
    broken. The lessons of one requirement are interchangeable, so they are
    matched in time order, longest first.
    """
    from ortools.sat.python import cp_model

    solver = SchedulerSolver(_settings(days=days))
    request = OptimizeScheduleRequest.model_validate(_strict(payload))
    model, _, decisions, *_ = solver._build_model(request, use_assumptions=False)
    placed: dict[UUID, list[ScheduledLesson]] = {}
    for lesson in response.lessons:
        placed.setdefault(lesson.requirement_id, []).append(lesson)
    by_requirement: dict[UUID, list] = {}
    for decision in decisions:
        by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)
    grid = solver._grid
    for requirement_id, group in by_requirement.items():
        lessons = sorted(
            placed[requirement_id], key=lambda lesson: (lesson.day_of_week, lesson.start_time),
        )
        for decision, lesson in zip(group, lessons, strict=True):
            minutes = int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5])
            slot = (minutes - grid.day_start_minutes) // grid.slot_minutes
            day_index = list(grid.schedule_days).index(lesson.day_of_week)
            model.Add(decision.start == day_index * grid.slots_per_day + slot)
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 20
    return cp.Solve(model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


class TestTheReportAgreesWithTheStrictModel:
    @pytest.mark.parametrize("seed", range(30))
    def test_no_deviation_exactly_when_the_strict_model_accepts_the_timetable(self, seed: int) -> None:
        payload, days = _random_week(seed)
        try:
            response = _solve(payload, days=days)
        except InvalidScheduleInputError as refusal:
            # A hard rule refused the week in both modes: not this test's subject.
            assert not refusal.code.startswith(("TEACHER_DAILY_CAP", "TEACHER_WORK_DAYS", "SUBJECT_DISTRIBUTION"))
            return
        if not response.lessons:
            assert response.status in ("INFEASIBLE", "TIMEOUT")
            return
        kept = _keeps_every_rule(payload, response, days)
        assert kept == (response.deviations == []), [
            (detail.code, detail.params) for detail in response.deviations or []
        ]
