"""The teachers' own lunch and rest — the first hours this model owes an adult.

Everything else in the solver protects the PUPILS: a lunch window per class, a
rast per grade span, a margin for changing before idrotten. The only
per-teacher row that existed was an UNAVAILABLE reservation, which is a teacher
CLOSING hours rather than being owed any, and the idle-time objective is an
objective — it prefers a compact day and will sell any hour of it for a
placement.

THE SCAFFOLDING IS test_idle_time.py's, for its reasons. A single narrow day
makes the arithmetic visible: with five open days the solver spreads the
lessons and every rule here holds without being asked. And the placements are
PINNED, which turns each case from an observation about the solver's taste into
an assertion about the encoding — a compact day and a scattered one are both
feasible on any week with room.

THE BREAK IS READ OUT OF THE MODEL BY NAME, because it is in no response. A
teacher's guaranteed lunch is a reservation the timetable has to leave alone,
not a row a school is shown, so unlike a class's sitting it is never extracted.
Naming the variable is the price of asserting where it actually landed, and the
name is as much a part of the encoding as the domain is.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver

#: 08:00-13:00. Five hours is four 60-minute lessons and an hour to eat in, so
#: every case below is arithmetic a reader can do in their head.
SHORT_DAY = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 780}
#: 08:00-21:30 over two days, which is the only shape eleven hours of rest can
#: bind on: the rule bites exactly where a school's day runs longer than the
#: night the rest asks for, and 13.5 hours leaves 10.5. See
#: _add_teacher_rest, which says so about the engine's own default day.
EVENING_WEEK = {"SCHEDULE_DAYS": "1,2", "SCHEDULE_DAY_END_MINUTES": 1290}

TEACHER = str(uuid4())
CO_TEACHER = str(uuid4())
GROUP = str(uuid4())
RULE = str(uuid4())


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, **overrides)  # type: ignore[arg-type]


def _rule(**values: object) -> dict[str, object]:
    """One work rule for TEACHER, with every field empty but the ones named.

    Empty is the whole of "this half of the rule does not apply", so a test that
    asks about the lunch says nothing about the rest and gets nothing.
    """
    row: dict[str, object] = {
        "id": RULE,
        "teacherId": TEACHER,
        "lunchMinutes": None,
        "lunchStartTime": None,
        "lunchEndTime": None,
        "minDailyRestMinutes": None,
    }
    row.update(values)
    return row


#: The user's own suggested values, which live in the UI and not in a default.
LUNCH = {"lunchMinutes": 30, "lunchStartTime": "10:30:00", "lunchEndTime": "13:30:00"}
REST = 660


def _payload(
    *,
    rules: list[dict[str, object]] | None = None,
    lessons_per_week: int = 4,
    minutes_per_lesson: int = 60,
    co_teacher: str | None = None,
    fixed_lessons: list[dict[str, object]] | None = None,
    constraints: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    """One teacher, one class, one room, and nothing else in the way."""
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": GROUP,
                "teacherId": TEACHER,
                "coTeacherId": co_teacher,
                "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": minutes_per_lesson,
                "studentGroupSize": 24,
            },
        ],
        "groups": [{"id": GROUP, "lunchHeadcount": 24}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": constraints or [],
        "fixedLessons": fixed_lessons or [],
        "teacherWorkRules": rules if rules is not None else [],
    }


def _locked(
    start: str, end: str, day_of_week: int = 1, *, teacher: str | None = TEACHER,
    co_teacher: str | None = None,
) -> dict[str, object]:
    """A lesson somebody placed by hand, for a class of nobody's in particular.

    Its own student group on purpose: what these cases are about is the
    TEACHER's time, and borrowing GROUP would also block the class and make
    every verdict below answerable two ways.
    """
    return {
        "id": str(uuid4()),
        "teacherId": teacher,
        "coTeacherId": co_teacher,
        "studentGroupId": str(uuid4()),
        "extraGroupIds": [],
        "roomId": None,
        "dayOfWeek": day_of_week,
        "startTime": start,
        "endTime": end,
    }


def _closure(
    start: str, end: str, day_of_week: int = 1, *, resource: str = TEACHER,
) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": "TEACHER",
        "resourceId": resource,
        "dayOfWeek": day_of_week,
        "date": None,
        "startTime": start,
        "endTime": end,
        "kind": "UNAVAILABLE",
    }


def _at(hhmm: str, day_index: int = 0) -> tuple[int, str]:
    """A placement this file writes as the school reads it: (day, wall clock)."""
    return day_index, hhmm


def _solve(
    payload: dict[str, object],
    placements: list[tuple[int, str]] | None = None,
    **settings: object,
) -> tuple[str, dict[str, str]]:
    """Build the satisfaction model, pin the lessons, and solve it once.

    Returns the status and where each teacher's break landed, as wall-clock
    times keyed by the variable's own name. One worker under a fixed budget, so
    a verdict is the same on every machine.
    """
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, _registry, decisions, _plan, _lunches = solver._build_model(
        request, use_assumptions=False, include_objective=False,
    )
    slots_per_day = solver._grid.slots_per_day
    for decision, (day_index, hhmm) in zip(decisions, placements or []):
        slot = (int(hhmm[:2]) * 60 + int(hhmm[3:5]) - solver._grid.day_start_minutes) // (
            solver._grid.slot_minutes
        )
        model.Add(decision.start == day_index * slots_per_day + slot)

    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10.0
    code = cp.Solve(model)
    assert code != cp_model.MODEL_INVALID, model.Validate()
    breaks: dict[str, str] = {}
    if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for index, variable in enumerate(model.Proto().variables):
            if variable.name.startswith("teacherlunch_"):
                absolute = cp.Value(model.GetIntVarFromProtoIndex(index))
                breaks[variable.name] = solver._grid.format_hhmmss(
                    absolute % slots_per_day, 0,
                )[0][:5]
    return cp.StatusName(code), breaks


def _reading(status: str) -> str:
    """FEASIBLE or INFEASIBLE; anything else is a test that proves nothing."""
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, status
    return "INFEASIBLE" if status == "INFEASIBLE" else "FEASIBLE"


def _variable_names(payload: dict[str, object], **settings: object) -> list[str]:
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, *_ = solver._build_model(
        request, use_assumptions=False, include_objective=True,
    )
    return [variable.name for variable in model.Proto().variables]


def _shape(payload: dict[str, object], **settings: object) -> tuple[list[str], int]:
    """Every variable's name and the constraint count — the model, as a value."""
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, *_ = solver._build_model(
        request, use_assumptions=False, include_objective=True,
    )
    proto = model.Proto()
    return [variable.name for variable in proto.variables], len(proto.constraints)


def _refusal(payload: dict[str, object], **settings: object) -> str | None:
    """The code _validate_request refuses this payload with, or None."""
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    try:
        solver._validate_request(request)
    except InvalidScheduleInputError as error:
        return error.code
    return None


def _refusal_params(
    payload: dict[str, object], **settings: object,
) -> dict[str, str | int]:
    """The values the refusal substitutes, for the sentences that branch on one."""
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    try:
        solver._validate_request(request)
    except InvalidScheduleInputError as error:
        return error.params
    msg = "the payload was not refused at all"
    raise AssertionError(msg)


def _conflict_codes(payload: dict[str, object], **settings: object) -> list[str]:
    """The codes a full solve puts in front of a school."""
    solver = SchedulerSolver(_settings(**settings))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status == "INFEASIBLE", response.status
    assert response.conflicts is not None
    return [detail.code for detail in response.conflicts.conflicts]


class TestTheGuaranteedLunch:
    """A movable break per day, kept clear of everything the teacher does."""

    def test_the_break_lands_in_the_hour_the_lessons_leave(self) -> None:
        """Four lessons to 12:00 leave exactly the hour 12:00-13:00 of the window.

        The window is 10:30-13:30 and the day ends at 13:00, so the window the
        model uses is 10:30-13:00 — the narrower of the two, the way a frame and
        a sitting compose. A 60-minute break then has one place to be, and the
        assertion is that place rather than the mere fact that one was found.
        """
        status, breaks = _solve(
            _payload(rules=[_rule(**{**LUNCH, "lunchMinutes": 60})]),
            [_at("08:00"), _at("09:00"), _at("10:00"), _at("11:00")],
            **SHORT_DAY,
        )

        assert _reading(status) == "FEASIBLE"
        assert list(breaks.values()) == ["12:00"]

    def test_one_minute_more_than_the_hour_is_refused(self) -> None:
        # The exact boundary from the other side: 65 minutes does not fit in the
        # 60 the same day leaves, and no placement of anything else can help.
        status, _breaks = _solve(
            _payload(rules=[_rule(**{**LUNCH, "lunchMinutes": 65})]),
            [_at("08:00"), _at("09:00"), _at("10:00"), _at("11:00")],
            **SHORT_DAY,
        )

        assert _reading(status) == "INFEASIBLE"

    def test_a_full_day_leaves_no_break_and_the_week_is_refused(self) -> None:
        # Five 60-minute lessons fill 08:00-13:00 exactly. The pupils' own rules
        # are all satisfied — the class is taught its hours and the room holds
        # them — and the teacher eats nothing.
        full = _payload(rules=[_rule(**LUNCH)], lessons_per_week=5)

        assert _reading(_solve(full, **SHORT_DAY)[0]) == "INFEASIBLE"
        # And the same week with nobody's lunch guaranteed is a timetable.
        assert _reading(_solve(_payload(lessons_per_week=5), **SHORT_DAY)[0]) == "FEASIBLE"

    def test_a_teacher_with_a_single_lesson_is_owed_the_break_all_the_same(self) -> None:
        """The `len(group) < 2` skip _add_idle_time_objective makes is not copied.

        Idle time needs two lessons to exist between; a lunch does not. One
        four-hour lesson across the whole window is exactly the teacher this
        rule is for, and skipping them would have left the rule holding for
        everybody except the worst case.
        """
        one = _payload(rules=[_rule(**LUNCH)], lessons_per_week=1, minutes_per_lesson=240)

        assert _reading(_solve(one, [_at("09:00")], **SHORT_DAY)[0]) == "INFEASIBLE"
        # Moved an hour earlier the same lesson leaves 12:00-13:00 for the break.
        status, breaks = _solve(one, [_at("08:00")], **SHORT_DAY)
        assert _reading(status) == "FEASIBLE"
        assert list(breaks.values()) == ["12:00"]

    def test_a_co_taught_lesson_occupies_the_second_teacher_too(self) -> None:
        """Both adults in the room, or a co-taught school escapes the rule.

        The rule here names the CO-teacher, who appears in no requirement's
        `teacherId` at all. A reader that took the lead teacher alone would build
        no lunch for them and report a week that works.
        """
        co_taught = _payload(
            rules=[_rule(teacherId=CO_TEACHER, **LUNCH)],
            lessons_per_week=5,
            co_teacher=CO_TEACHER,
        )

        assert _reading(_solve(co_taught, **SHORT_DAY)[0]) == "INFEASIBLE"

    def test_a_day_the_school_closed_owes_no_break_at_all(self) -> None:
        """"Anna undervisar inte på fredagar" is a correct statement, not an error.

        A reservation covering the whole window is the school saying the teacher
        is not there, which is the same reading the class's own lunch makes of a
        reserved Tuesday. Asserted on the ENCODING — there is no variable for
        that day — because a refusal is exactly what must not happen and a
        feasible week could be feasible for any number of reasons.
        """
        names = _variable_names(
            _payload(rules=[_rule(**LUNCH)], constraints=[_closure("10:00:00", "13:30:00")]),
            SCHEDULE_DAYS="1,2",
            SCHEDULE_DAY_END_MINUTES=780,
        )

        assert f"teacherlunch_{TEACHER}_0" not in names
        assert f"teacherlunch_{TEACHER}_1" in names

    def test_a_reservation_that_only_narrows_still_owes_the_break(self) -> None:
        # The other half of the same rule: a reservation that leaves fragments
        # too short for the break is a school asking for something impossible,
        # and it is refused by name rather than read as a day off.
        narrowed = _payload(
            rules=[_rule(**LUNCH)], constraints=[_closure("10:40:00", "13:30:00")],
        )

        assert _refusal(narrowed, **SHORT_DAY) == "TEACHER_LUNCH_LEAVES_NO_START"


class TestTheNightsRest:
    """Hours between the end of one teaching day and the start of the next."""

    def test_eleven_hours_after_an_evening_lesson_holds_the_morning(self) -> None:
        """21:30 to 08:30 is eleven hours to the minute, and 08:25 is not.

        The exact boundary, and the whole of the rule's arithmetic: absolute
        slots count only the hours the school teaches in, so the night has to be
        added back — get that wrong by a day and this reads 08:00 as legal.
        """
        rested = _payload(rules=[_rule(minDailyRestMinutes=REST)], lessons_per_week=2)

        assert _reading(
            _solve(rested, [_at("20:30"), _at("08:30", 1)], **EVENING_WEEK)[0],
        ) == "FEASIBLE"
        assert _reading(
            _solve(rested, [_at("20:30"), _at("08:25", 1)], **EVENING_WEEK)[0],
        ) == "INFEASIBLE"

    def test_five_minutes_more_rest_moves_the_boundary_by_one_slot(self) -> None:
        # The same placement against 665 minutes: the rule is the number, not a
        # rounding of it, and a break of one slot is visible in the verdict.
        rested = _payload(rules=[_rule(minDailyRestMinutes=REST + 5)], lessons_per_week=2)

        assert _reading(
            _solve(rested, [_at("20:30"), _at("08:30", 1)], **EVENING_WEEK)[0],
        ) == "INFEASIBLE"

    def test_without_the_rule_the_same_evening_and_morning_are_a_timetable(self) -> None:
        # The control every case above needs: what refuses these weeks is the
        # rule and not the fixture.
        bare = _payload(lessons_per_week=2)

        assert _reading(
            _solve(bare, [_at("20:30"), _at("08:00", 1)], **EVENING_WEEK)[0],
        ) == "FEASIBLE"

    def test_a_day_nobody_works_does_not_refuse_the_week(self) -> None:
        """The guard, without which a free Wednesday is asked to rest around.

        Twenty-two hours between two teaching days cannot be had on consecutive
        days of a 13.5-hour school, so the two lessons have to land on days that
        are not next to each other — which is a timetable, and the rule saying
        nothing about the day between them is why.
        """
        status, _breaks = _solve(
            _payload(rules=[_rule(minDailyRestMinutes=1320)], lessons_per_week=2),
            SCHEDULE_DAYS="1,2,3",
            SCHEDULE_DAY_END_MINUTES=1290,
        )

        assert _reading(status) == "FEASIBLE"

    def test_the_teachers_own_locked_evening_holds_the_next_morning(self) -> None:
        """A hand-placed lesson is teaching, and leaving it out made this optional.

        The locked lesson is not an interval in this model — generated lessons
        merely steer around it — so a rest rule reading only what the solver
        places would let a school hand-place an evening and have the next
        morning placed freely against a rule that could not see it.
        """
        evening = _payload(
            rules=[_rule(minDailyRestMinutes=REST)],
            lessons_per_week=1,
            fixed_lessons=[_locked("18:30:00", "21:30:00")],
        )

        assert _reading(_solve(evening, [_at("08:00", 1)], **EVENING_WEEK)[0]) == "INFEASIBLE"
        assert _reading(_solve(evening, [_at("08:30", 1)], **EVENING_WEEK)[0]) == "FEASIBLE"

    def test_a_locked_lesson_on_another_teacher_holds_nothing(self) -> None:
        # The same lock on somebody else's name leaves this teacher's morning
        # where it was: the rule is per teacher, and the reach is the lock's own
        # teacher and co-teacher.
        other = _payload(
            rules=[_rule(minDailyRestMinutes=REST)],
            lessons_per_week=1,
            fixed_lessons=[_locked("18:30:00", "21:30:00", teacher=str(uuid4()))],
        )

        assert _reading(_solve(other, [_at("08:00", 1)], **EVENING_WEEK)[0]) == "FEASIBLE"

    def test_a_co_taught_locked_lesson_holds_the_co_teacher_s_morning(self) -> None:
        co_taught = _payload(
            rules=[_rule(teacherId=CO_TEACHER, minDailyRestMinutes=REST)],
            lessons_per_week=1,
            co_teacher=CO_TEACHER,
            fixed_lessons=[
                _locked("18:30:00", "21:30:00", teacher=str(uuid4()), co_teacher=CO_TEACHER),
            ],
        )

        assert _reading(
            _solve(co_taught, [_at("08:00", 1)], **EVENING_WEEK)[0],
        ) == "INFEASIBLE"
        assert _reading(
            _solve(co_taught, [_at("08:30", 1)], **EVENING_WEEK)[0],
        ) == "FEASIBLE"


class TestWhatIsRefusedBeforeAnySolve:
    """Arithmetic on constants, answered in microseconds and named."""

    def test_a_window_narrower_than_the_break_is_named(self) -> None:
        narrow = _payload(
            rules=[
                _rule(lunchMinutes=30, lunchStartTime="10:30:00", lunchEndTime="10:50:00"),
            ],
        )

        assert _refusal(narrow, **SHORT_DAY) == "TEACHER_LUNCH_WINDOW_TOO_NARROW"
        # The control: the same rule with the window the user suggested.
        assert _refusal(_payload(rules=[_rule(**LUNCH)]), **SHORT_DAY) is None

    def test_a_window_the_school_day_cuts_short_is_measured_as_it_stands(self) -> None:
        """10:30-13:30 on a day that ends at 13:00 offers 150 minutes, not 180.

        The refusal reads the window through the same grid the model does, and
        it has to: the alternative to agreeing with the model here is not a
        refused week but an empty variable domain, which reaches a school as
        CP-SAT's own "var has no domain" 500.
        """
        too_long = _payload(rules=[_rule(**{**LUNCH, "lunchMinutes": 180})])

        assert _refusal(too_long, **SHORT_DAY) == "TEACHER_LUNCH_WINDOW_TOO_NARROW"
        assert _refusal(_payload(rules=[_rule(**{**LUNCH, "lunchMinutes": 150})]), **SHORT_DAY) is None

    def test_locked_lessons_that_leave_no_start_are_named(self) -> None:
        # A lock over the whole window: arithmetic on two constants, and left to
        # the model it is an empty domain — a proof CP-SAT reaches without
        # touching one assumption, whose empty core takes every other cause in
        # the payload down with it.
        blocked = _payload(
            rules=[_rule(**LUNCH)], fixed_lessons=[_locked("10:30:00", "13:00:00")],
        )

        assert _refusal(blocked, **SHORT_DAY) == "TEACHER_LUNCH_LEAVES_NO_START"
        # The control: the same lock half an hour shorter leaves 12:30 free.
        allowed = _payload(
            rules=[_rule(**LUNCH)], fixed_lessons=[_locked("10:30:00", "12:30:00")],
        )
        assert _refusal(allowed, **SHORT_DAY) is None

    def test_the_sentence_names_what_took_the_last_start_and_nothing_else(self) -> None:
        """`causes` is the fix the school has to make, so it has to be the truth.

        The sentence tells a rektor to move a locked lesson, shorten a
        reservation, or widen the window, and the branch decides which of the
        three it leads with. Read off "does this teacher have a lock somewhere
        today" it blames an 08:00 lesson for a window that opens at 10:30 —
        advice that cannot change the outcome, about the one screen the reader
        is least able to change. Read off the forbidden starts it names what
        actually left none.

        All four cases on the same day, so only the cause differs.
        """
        lock_only = _payload(
            rules=[_rule(**LUNCH)], fixed_lessons=[_locked("10:30:00", "13:00:00")],
        )
        assert _refusal_params(lock_only, **SHORT_DAY)["causes"] == "locked"

        closure_only = _payload(
            rules=[_rule(**LUNCH)], constraints=[_closure("10:40:00", "13:30:00")],
        )
        assert _refusal_params(closure_only, **SHORT_DAY)["causes"] == "closed"

        # THE REGRESSION. The reservation is what empties the window; the lock
        # is at breakfast and _forbidden_lunch_starts drops it. Before the fix
        # this read "locked_closed" and sent the reader to the morning.
        irrelevant_lock = _payload(
            rules=[_rule(**LUNCH)],
            constraints=[_closure("10:40:00", "13:30:00")],
            fixed_lessons=[_locked("08:00:00", "09:00:00")],
        )
        assert _refusal_params(irrelevant_lock, **SHORT_DAY)["causes"] == "closed"

        # And both, when both really do take starts away: the lock rules out
        # 10:30-11:40 and the reservation 11:05-12:30, which is the lot.
        both = _payload(
            rules=[_rule(**LUNCH)],
            fixed_lessons=[_locked("10:30:00", "11:45:00")],
            constraints=[_closure("11:30:00", "13:00:00")],
        )
        assert _refusal_params(both, **SHORT_DAY)["causes"] == "locked_closed"

    def test_a_rest_longer_than_any_night_is_named(self) -> None:
        """Three-hour lessons on a three-hour day: one a day, and 21 hours apart.

        The only shape this refusal can have. A rest is capped at 22 hours by
        the row itself, and the night between two teaching days is shorter than
        that only where a teacher's own lessons take up more than half the
        school's day — so the sentence exists for the rows near the database's
        own ceiling, which are exactly the rows the model cannot express.
        """
        impossible = _payload(
            rules=[_rule(minDailyRestMinutes=1265)],
            lessons_per_week=4,
            minutes_per_lesson=180,
        )
        settings = {"SCHEDULE_DAYS": "1,2,3,4,5", "SCHEDULE_DAY_END_MINUTES": 660}

        assert _refusal(impossible, **settings) == "TEACHER_REST_LONGER_THAN_THE_NIGHT"
        # The control: 21 hours is exactly the night those days leave.
        possible = _payload(
            rules=[_rule(minDailyRestMinutes=1260)],
            lessons_per_week=4,
            minutes_per_lesson=180,
        )
        assert _refusal(possible, **settings) is None

    def test_a_teacher_who_can_avoid_two_days_in_a_row_is_not_refused(self) -> None:
        # The escape, counted generously: two lessons fit on Monday, Wednesday
        # and Friday, so no pair of consecutive days is ever asked about.
        few = _payload(
            rules=[_rule(minDailyRestMinutes=1265)],
            lessons_per_week=2,
            minutes_per_lesson=180,
        )

        assert _refusal(
            few, SCHEDULE_DAYS="1,2,3,4,5", SCHEDULE_DAY_END_MINUTES=660,
        ) is None

    def test_a_rule_naming_a_teacher_with_no_lessons_refuses_nothing(self) -> None:
        """The builder skips such a rule, so the validator must skip it too.

        A teacher with nothing left for the solver to place has no variable
        either half of the rule could bound. Refusing a week over a row that
        could not have changed it is the one mistake a pre-flight check must not
        make — and an impossible window on a teacher nobody timetables is
        exactly what a school's half-finished configuration looks like.
        """
        nobody = _payload(
            rules=[
                _rule(
                    teacherId=str(uuid4()),
                    lunchMinutes=240,
                    lunchStartTime="10:30:00",
                    lunchEndTime="10:35:00",
                    minDailyRestMinutes=1320,
                ),
            ],
        )

        assert _refusal(nobody, **SHORT_DAY) is None

    def test_half_a_lunch_is_refused_at_the_boundary(self) -> None:
        # Two of the three fields is not a weaker rule but an unanswerable one,
        # and the shape is a gateway that lost a field rather than an
        # administrator who typed something impossible — so it is a 422 about a
        # shape, not a sentence a school reads.
        with pytest.raises(ValidationError, match="lunchMinutes, lunchStartTime"):
            OptimizeScheduleRequest.model_validate(
                _payload(rules=[_rule(lunchMinutes=30, lunchStartTime="10:30:00")]),
            )


class TestTheRefusalNamesTheRuleAndNeverTheTeacher:
    """What reaches a school when the model, not the arithmetic, says no."""

    def test_a_lunch_with_nowhere_to_go_names_its_own_rule(self) -> None:
        """On a payload the pre-flight lets through: the window is wide, no lock
        touches it, and it is the teacher's own lessons that fill the day."""
        full = _payload(rules=[_rule(**LUNCH)], lessons_per_week=5)
        assert _refusal(full, **SHORT_DAY) is None

        codes = _conflict_codes(full, **SHORT_DAY)

        assert "TEACHER_LUNCH_HAS_NOWHERE_TO_GO" in codes

    def test_a_rest_that_cannot_be_kept_names_its_own_rule(self) -> None:
        # Both ends hand-placed: the night between two locked lessons is 10.5
        # hours and the rule asks for 11. Nothing the solver chooses can help,
        # and without the literal this would be an INFEASIBLE with an empty core
        # — which reaches a school as "look at your rooms and teacher time".
        locked_night = _payload(
            rules=[_rule(minDailyRestMinutes=REST)],
            lessons_per_week=1,
            fixed_lessons=[
                _locked("18:30:00", "21:30:00", day_of_week=1),
                _locked("08:00:00", "11:00:00", day_of_week=2),
            ],
        )
        assert _refusal(locked_night, **EVENING_WEEK) is None

        codes = _conflict_codes(locked_night, **EVENING_WEEK)

        assert "TEACHER_REST_CANNOT_BE_KEPT" in codes

    def test_no_sentence_carries_the_teacher_s_id(self) -> None:
        """The teacher map is discarded by the gateway on purpose.

        A detail naming a teacher would reach the school as a uuid resolving to
        nobody, and a person's name may not enter a stored conflict at all. The
        RULE is both reversible and the thing to go and change.
        """
        full = _payload(rules=[_rule(**LUNCH)], lessons_per_week=5)
        solver = SchedulerSolver(_settings(**SHORT_DAY))
        response = solver.solve(OptimizeScheduleRequest.model_validate(full))
        assert response.conflicts is not None

        named = [
            detail for detail in response.conflicts.conflicts
            if detail.code.startswith("TEACHER_")
        ]
        assert named, [detail.code for detail in response.conflicts.conflicts]
        for detail in named:
            assert detail.params["rule"] == RULE
            assert TEACHER not in str(detail.params.values())
            assert TEACHER not in detail.message
            # And the rule id travels in resourceIds too, which is the half the
            # gateway reverses: its own comment says the arbetstid's id arrives
            # there, and an id left out of this list is one no screen can link.
            assert [str(value) for value in detail.resource_ids] == [RULE]


class TestNoRulesChangeNothing:
    def test_an_empty_list_builds_the_model_it_always_built(self) -> None:
        """The field's whole promise: a school that has filled in nobody pays
        nothing — not a variable, not a constraint, not a refusal."""
        # ONE payload, three readings of it. Built from the same row so the
        # comparison is on the model and not on a fresh set of uuids: the
        # variables are named after the requirement, and a second _payload()
        # would differ in every name while being the same week.
        absent = _payload(lessons_per_week=4)
        empty = {**absent, "teacherWorkRules": []}
        # And a row that names a teacher while asking for neither half. Empty is
        # the whole of "the rule does not apply", so this must cost nothing too.
        vacuous = {**absent, "teacherWorkRules": [_rule()]}
        del absent["teacherWorkRules"]

        baseline = _shape(absent, **SHORT_DAY)
        for payload in (empty, vacuous):
            assert _shape(payload, **SHORT_DAY) == baseline

    def test_nothing_in_the_model_mentions_a_teacher_rule(self) -> None:
        names = _variable_names(_payload(rules=[], lessons_per_week=4), **SHORT_DAY)

        assert not [name for name in names if name.startswith(("teacher", "tfirst_"))]


class TestTheIdleObjectiveKeepsItsMeaning:
    """The rest rule builds the day two-sided; the objective reads that pair."""

    def test_the_shared_pair_is_built_once_and_only_once(self) -> None:
        with_rest = _payload(rules=[_rule(minDailyRestMinutes=REST)], lessons_per_week=2)

        names = _variable_names(with_rest, **EVENING_WEEK)

        # The two-sided pair, and NOT the one-sided one beside it: a second
        # `first` and `last` would be twice the literals for one fact, and two
        # answers to "when did this teacher's Tuesday begin".
        assert f"tfirst_{TEACHER}_0" in names
        assert not [name for name in names if name.startswith("first_idle_")]

    def test_a_teacher_no_rule_names_keeps_the_one_sided_pair(self) -> None:
        names = _variable_names(_payload(rules=[], lessons_per_week=2), **EVENING_WEEK)

        assert f"first_idle_{TEACHER}_0" in names
        assert not [name for name in names if name.startswith("tfirst_")]

    def test_the_idle_minutes_are_the_same_either_way(self) -> None:
        """A pinned pair is what minimising `last - first` drives the one-sided
        pair to anyway, so the term's value cannot move — which is the whole
        claim in _add_idle_time_objective's own docstring, asserted as a
        number."""
        costs = []
        for rules in ([], [_rule(minDailyRestMinutes=REST)]):
            solver = SchedulerSolver(_settings(**EVENING_WEEK))
            request = OptimizeScheduleRequest.model_validate(
                _payload(rules=rules, lessons_per_week=2),
            )
            model, _registry, decisions, _plan, _lunches = solver._build_model(
                request, use_assumptions=False, include_objective=True,
            )
            # 08:00 and 11:00 on the same day: a two-hour hole, and every other
            # objective term is indifferent to it.
            model.Add(decisions[0].start == 0)
            model.Add(decisions[1].start == 36)
            cp = cp_model.CpSolver()
            cp.parameters.num_workers = 1
            cp.parameters.max_time_in_seconds = 10.0
            assert cp.Solve(model) in {cp_model.OPTIMAL, cp_model.FEASIBLE}
            costs.append(round(cp.ObjectiveValue()))

        assert costs[0] == costs[1]


class TestTheTimeoutProbe:
    def test_each_half_is_probed_on_its_own(self) -> None:
        """Never one "teachers' working time" switch, for the reason the lunch is
        three probes: a school cannot switch its teachers' working time off, and
        being told it could is true and useless."""
        solver = SchedulerSolver(_settings(**EVENING_WEEK))
        request = OptimizeScheduleRequest.model_validate(
            _payload(rules=[_rule(minDailyRestMinutes=REST, **LUNCH)]),
        )

        relaxations = solver._timeout_relaxations(request)
        codes = [code for code, _relaxed in relaxations]

        assert "PROBE_SOLVED_WITHOUT_TEACHER_REST" in codes
        assert "PROBE_SOLVED_WITHOUT_TEACHER_LUNCH" in codes
        # Measured, not guessed. On the 400-student gate week with both halves
        # given to all 33 teachers, the lunch adds 330 variables of 8,465 and no
        # measurable time, and the rest adds 9,267 and takes the satisfaction
        # solve from 7.8s to 11.1s — so the rest is probed first.
        assert codes.index("PROBE_SOLVED_WITHOUT_TEACHER_REST") < codes.index(
            "PROBE_SOLVED_WITHOUT_TEACHER_LUNCH",
        )
        # And each keeps the other half, or the finding would name one rule and
        # measure two.
        by_code = dict(relaxations)
        rest_off = by_code["PROBE_SOLVED_WITHOUT_TEACHER_REST"].teacher_work_rules[0]
        assert rest_off.min_daily_rest_minutes is None
        assert rest_off.has_lunch
        lunch_off = by_code["PROBE_SOLVED_WITHOUT_TEACHER_LUNCH"].teacher_work_rules[0]
        assert not lunch_off.has_lunch
        assert lunch_off.min_daily_rest_minutes == REST

    def test_a_payload_with_no_rules_is_not_probed_for_them(self) -> None:
        solver = SchedulerSolver(_settings(**EVENING_WEEK))
        request = OptimizeScheduleRequest.model_validate(_payload(rules=[]))

        codes = [code for code, _relaxed in solver._timeout_relaxations(request)]

        assert not [code for code in codes if "TEACHER" in code]

    def test_the_diagnosis_counts_the_rules_the_model_built(self) -> None:
        """The number the MODEL fed, not the length of the list, for the reason
        the `eating` count beside it gives: a row naming a teacher the timplan
        gives no lesson builds nothing, and reporting it as in force would name
        as the week's shape a rule that never touched it."""
        solver = SchedulerSolver(_settings(**EVENING_WEEK))
        reaching = OptimizeScheduleRequest.model_validate(
            _payload(rules=[_rule(minDailyRestMinutes=REST, **LUNCH)]),
        )
        stranded = OptimizeScheduleRequest.model_validate(
            _payload(
                rules=[_rule(teacherId=str(uuid4()), minDailyRestMinutes=REST, **LUNCH)],
            ),
        )

        assert "teacherLunches=1, teacherRests=1" in solver._timeout_diagnosis(
            reaching, "test",
        )
        assert "teacherLunches=0, teacherRests=0" in solver._timeout_diagnosis(
            stranded, "test",
        )


def test_the_estimate_still_bounds_the_model_it_predicts() -> None:
    """_estimate_model_size's own contract, over the two new builders.

    A builder that changes its encoding owes that table a term in the same
    commit, and the property the table exists for is this one.
    """
    solver = SchedulerSolver(_settings(**EVENING_WEEK))
    for payload in (
        _payload(rules=[_rule(**LUNCH)], lessons_per_week=4),
        _payload(rules=[_rule(minDailyRestMinutes=REST)], lessons_per_week=4),
        _payload(
            rules=[_rule(minDailyRestMinutes=REST, **LUNCH)],
            lessons_per_week=4,
            co_teacher=CO_TEACHER,
            fixed_lessons=[_locked("18:30:00", "21:30:00")],
        ),
    ):
        request = OptimizeScheduleRequest.model_validate(payload)
        model, *_ = solver._build_model(request, use_assumptions=False)
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)
