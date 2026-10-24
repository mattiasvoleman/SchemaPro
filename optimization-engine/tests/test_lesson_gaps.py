"""Whole lessons against the gaps they can be taught in: SchedulerSolver._lesson_gaps_verdict.

After the hours verdict, 73 of the impossible weeks #174's generator makes
(seeds 500000-500149) still came back CONFLICT_CORE_SUMMARY, and every one is
impossible in the explaining model with every literal released: no line of
those cores was needed, and most of them said there was no room for classes
that fit their rooms. The deletion filter over the released model's rows left,
for every one of them, rows that are posted bare: the start domains, a
teacher's, a group's, a room's or a lunch's NoOverlap, and the locked lessons'
avoidance. The hours were there and the gaps were not. A lesson is taught
whole, in one stretch, and a gap too short for it, or one that takes two
lessons where three were counted, is arithmetic, which the verdict now does
before any model.

EACH WEEK BELOW IS ONE OF THE FUZZ'S, CUT DOWN, and its docstring names the
week it stands for. Each was checked the same way: impossible with every
literal released, the earlier verdicts silent, and the bare rows that refute
it found by deletion. Each has a control, the same week with the one thing
the line names changed, which the solver schedules.

THROUGH THE API for the weeks, because the codes, the values and the ids in
resourceIds are what the gateway reads; the verdict itself for the edges.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver

API_KEY = "test-api-key-000000000000000000000000"
_HEADERS = {"X-API-Key": API_KEY}
_YEAR_7 = {"minGradeLevel": 7, "maxGradeLevel": 7}
_YEAR_8 = {"minGradeLevel": 8, "maxGradeLevel": 8}
_SOLVED = {"OPTIMAL", "FEASIBLE"}


def _settings(**overrides: object) -> Settings:
    return Settings(**{
        "API_KEY": API_KEY,
        "ALLOWED_ORIGINS": "http://testserver",
        "SCHEDULE_DAYS": "1,2,3,4,5",
        "SOLVER_PROBE_SECONDS": 5,
        **overrides,
    })


def _requirement(
    group: str, teacher: str, lengths: list[int], grades: dict[str, int] = _YEAR_7,
    **extra: object,
) -> dict[str, object]:
    """One timplan row: a lesson a week of each length."""
    return {
        "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
        "teacherId": teacher, "lessonsPerWeek": len(lengths), "minutesPerLesson": max(lengths),
        **({"lessonLengths": lengths} if len(set(lengths)) > 1 else {}),
        "studentGroupSize": 24, **grades, **extra,
    }


def _week(requirements: list[dict[str, object]], *, rooms: int = 2, **extra: object) -> dict[str, object]:
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(rooms)],
        **extra,
    }


def _lock(day: int, start: str, end: str, *, teacher: str | None = None, group: str | None = None) -> dict[str, object]:
    return {
        "id": str(uuid4()), "teacherId": teacher, "studentGroupId": group or str(uuid4()),
        "dayOfWeek": day, "startTime": start, "endTime": end,
    }


def _closed(grades: dict[str, int], *days: int) -> list[dict[str, object]]:
    """Frame times that close these days for these years, as the fuzz writes them."""
    return [
        {**grades, "dayOfWeek": day, "startTime": "06:00:00", "endTime": "07:00:00"}
        for day in days
    ]


def _lunch(minutes: int, start: str, end: str) -> dict[str, object]:
    return {"lunchMinutes": minutes, "lunchStartTime": start, "lunchEndTime": end}


def _post(settings: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
    client = TestClient(create_app(_settings(**settings)))
    return client.post("/api/v1/optimize", json=payload, headers=_HEADERS).json()


def _ids(*requirements: dict[str, object]) -> list[str]:
    return [str(requirement["id"]) for requirement in requirements]


def _refusal(body: dict[str, object]) -> tuple[dict[str, object], list[dict[str, object]]]:
    """The summary and the lines of a refusal the gaps verdict made."""
    assert body["status"] == "INFEASIBLE", body
    conflicts = body["conflicts"]
    assert conflicts["summaryCode"] == "DEMAND_LESSONS_EXCEED_GAPS", conflicts  # type: ignore[index]
    return conflicts, conflicts["conflicts"]  # type: ignore[index, return-value]


class TestTheFuzzWeeks:
    """The kinds of week the cores were noise for, one each, through the API."""

    def test_more_lessons_than_the_days_take_whole_are_counted(self) -> None:
        """mixed/500002: five 90-minute lessons for one class and one teacher,
        on four mornings of two hours. 450 minutes against 480, and each
        morning takes one of them.

        The core named a room for every lesson and the teacher's lunch and
        rest; the released model is refuted by the class's NoOverlap alone.
        One line, the class's: the teacher's and the room's count the same
        timplan row and are not said again.
        """
        group, teacher = str(uuid4()), str(uuid4())
        lessons = _requirement(group, teacher, [90] * 5)
        settings = {"SCHEDULE_DAYS": "1,2,3,4", "SCHEDULE_DAY_END_MINUTES": 600}

        conflicts, lines = _refusal(_post(settings, _week([lessons], rooms=1)))

        assert conflicts["summaryParams"] == {"resources": 1}
        assert str(conflicts["summary"]).startswith(
            "Too many lessons for the gaps: a lesson is taught whole, in one stretch,",
        )
        (line,) = lines
        assert line["category"] == "REQUIREMENT_DEMAND"
        assert line["code"] == "DEMAND_GROUP_LESSONS_EXCEED_GAPS"
        assert line["params"] == {
            "group": group, "requirements": 1, "lessons": 5, "shortestMinutes": 90,
            "demandMinutes": 450, "days": 4, "weekDays": 4, "shortOf": "lessons",
            "fitLessons": 4, "capacityMinutes": 360,
        }
        assert line["requirementIds"] == _ids(lessons)
        assert line["resourceIds"] == [group]
        assert line["message"] == (
            f"Student group {group} has 5 lessons of 90 minutes or more in 1 requirement, "
            "450 minutes in all. On the 4 days of the week's 4 they can fall on, the school "
            "day, the frame times, the rasts, the margins around the lessons, the locked lessons "
            "and the pupils' lunch leave gaps that take at most 4 of them."
        )
        assert teacher not in str(lines)

        lessons["lessonsPerWeek"] = 4
        assert _post(settings, _week([lessons], rooms=1))["status"] in _SOLVED

    def test_a_lunch_that_cuts_the_day_leaves_one_lesson_a_day(self) -> None:
        """dist/500100: three 70-minute lessons on two days of 08:00-11:00,
        and an hour's lunch inside 09:05-10:15. Wherever the meal sits, one
        side of it is under 70 minutes, so each day takes one lesson.

        The lunch's NoOverlap with the lessons is the whole proof, and the
        line says the meal is the difference: the days hold four without it.
        No `groups` is sent, so every group with lessons eats, as the model
        builds it, and the clique's hours, which read the payload's groups,
        never looked.
        """
        group, teacher = str(uuid4()), str(uuid4())
        lessons = _requirement(group, teacher, [70] * 3)
        settings = {"SCHEDULE_DAYS": "3,5", "SCHEDULE_DAY_END_MINUTES": 660}
        week = _week([lessons], rules=_lunch(60, "09:05:00", "10:15:00"))

        _, lines = _refusal(_post(settings, week))

        line, lunch = lines
        assert line["code"] == "DEMAND_GROUP_LESSONS_EXCEED_GAPS"
        assert (line["params"]["lessons"], line["params"]["fitLessons"]) == (3, 2)
        assert lunch["category"] == "LUNCH_WINDOW"
        assert lunch["code"] == "LUNCH_BREAK_IS_THE_DIFFERENCE"
        assert lunch["params"] == {"lunchMinutes": 60, "freeMinutes": 280}
        assert lunch["resourceIds"] == [group]

        week["rules"] = _lunch(30, "09:05:00", "10:15:00")
        assert _post(settings, week)["status"] in _SOLVED

    def test_the_stage_s_sitting_holds_the_lunch_where_the_days_take_one_lesson(self) -> None:
        """lunch/500057: six days of 08:00-11:30, a 30-minute lunch inside
        09:30-10:30, and year 7's sitting at 10:00-10:30. Around that sitting
        a day takes one 70-minute lesson, and the class has seven.

        The sitting narrows the meal bare, so its six rows are in the proof
        beside the lunch's NoOverlap. Without the sitting the meal goes to
        09:30 and every day takes two.
        """
        group, teacher = str(uuid4()), str(uuid4())
        lessons = _requirement(group, teacher, [70] * 7)
        settings = {"SCHEDULE_DAYS": "1,2,3,4,5,6", "SCHEDULE_DAY_END_MINUTES": 690}
        week = _week(
            [lessons],
            rules=_lunch(30, "09:30:00", "10:30:00"),
            groups=[{"id": group, "lunchHeadcount": 24, **_YEAR_7}],
            lunchServings=[{**_YEAR_7, "startTime": "10:00:00", "endTime": "10:30:00"}],
        )

        _, lines = _refusal(_post(settings, week))

        line, lunch = lines
        assert line["params"] == {
            "group": group, "requirements": 1, "lessons": 7, "shortestMinutes": 70,
            "demandMinutes": 490, "days": 6, "weekDays": 6, "shortOf": "lessons",
            "fitLessons": 6, "capacityMinutes": 420,
        }
        assert lunch["code"] == "LUNCH_BREAK_IS_THE_DIFFERENCE"

        week["lunchServings"] = []
        assert _post(settings, week)["status"] in _SOLVED

    def test_the_long_lessons_are_counted_on_their_own(self) -> None:
        """lunch/500030: one teacher, two classes, and the classes' 45-minute
        lunch inside 10:30-11:25. A lesson of 100 minutes or more has to end
        by 10:40, so a day takes one of them, and the teacher's Wednesday
        morning is locked: five long lessons, four mornings.

        Counted with the 45-minute lessons the gaps hold enough, since those
        fit after the lunch; counted from the long lessons up they do not.
        The proof is the teacher's NoOverlap, the lock and both lunches.
        """
        first, second, teacher = str(uuid4()), str(uuid4()), str(uuid4())
        lessons = [
            _requirement(first, teacher, [120, 100, 45, 45]),
            _requirement(second, teacher, [100, 100, 120, 45]),
        ]
        settings = {"SCHEDULE_DAY_END_MINUTES": 720}
        week = _week(
            lessons,
            rules=_lunch(45, "10:30:00", "11:25:00"),
            fixedLessons=[_lock(3, "08:30:00", "09:30:00", teacher=teacher)],
        )

        _, lines = _refusal(_post(settings, week))

        line, lunch = lines
        assert line["code"] == "DEMAND_TEACHER_LESSONS_EXCEED_GAPS"
        assert line["params"] == {
            "requirements": 2, "lessons": 5, "shortestMinutes": 100, "demandMinutes": 540,
            "days": 4, "weekDays": 5, "shortOf": "lessons", "fitLessons": 4,
            "capacityMinutes": 480,
        }
        assert line["resourceIds"] == _ids(*lessons)
        assert line["message"] == (
            "One teacher gives 5 lessons of 100 minutes or more in 2 requirements, 540 minutes "
            "in all. On the 4 days of the week's 5 they can fall on, the school day, the frame "
            "times, the rasts, the margins around the lessons, the locked lessons and the "
            "pupils' lunch leave gaps that take at most 4 of them."
        )
        assert lunch["code"] == "LUNCH_BREAK_IS_THE_DIFFERENCE"
        assert lunch["resourceIds"] == _ids(*lessons)
        assert teacher not in str(lines)

        week["fixedLessons"] = []
        assert _post(settings, week)["status"] in _SOLVED

    def test_a_lesson_that_fits_no_gap_is_said_to_fit_none(self) -> None:
        """lunch/500020: one 100-minute lesson on a Thursday of 08:00-12:00,
        the class's hour of lunch held at 09:45-10:45 by its window, and the
        teacher locked 08:55-09:15. The gaps are 55, 30 and 75 minutes.

        The lock's avoidance and the lunch's NoOverlap are the proof. A
        75-minute lesson fits after the meal.
        """
        group, teacher = str(uuid4()), str(uuid4())
        lessons = _requirement(group, teacher, [100])
        settings = {"SCHEDULE_DAYS": "4", "SCHEDULE_DAY_END_MINUTES": 720}
        week = _week(
            [lessons],
            rules=_lunch(60, "09:45:00", "10:45:00"),
            fixedLessons=[_lock(4, "08:55:00", "09:15:00", teacher=teacher)],
        )

        _, lines = _refusal(_post(settings, week))

        line, lunch = lines
        assert line["params"]["shortOf"] == "nowhere"
        assert (line["params"]["days"], line["params"]["fitLessons"]) == (0, 0)
        assert line["message"] == (
            f"Student group {group} has 1 lesson of 100 minutes or more in 1 requirement, "
            "100 minutes in all. No gap that the school day, the frame times, the rasts, the "
            "margins around the lessons, the locked lessons and the pupils' lunch leave on the "
            "week's 1 days takes it whole."
        )
        assert lunch["params"] == {"lunchMinutes": 60, "freeMinutes": 100}

        lessons["minutesPerLesson"] = 75
        assert _post(settings, week)["status"] in _SOLVED

    def test_lessons_the_frames_hold_to_one_day_are_counted_against_that_day(self) -> None:
        """ldnear/500088: year 7 closed Monday to Wednesday, one teacher with
        six year-7 lessons and a year-8 one, and a lock on Thursday at
        09:42-10:22. Thursday's gaps of 100 and 95 minutes fill 190 of the
        year-7 lessons' 210; the week has room enough.

        The teacher's NoOverlap and the lock are the proof, the frames in the
        lessons' starts. Opening Wednesday for year 7 solves it.
        """
        teacher = str(uuid4())
        lessons = [
            _requirement(str(uuid4()), teacher, [40, 30]),
            _requirement(str(uuid4()), teacher, [40, 40, 30, 30]),
            _requirement(str(uuid4()), teacher, [40], _YEAR_8),
        ]
        settings = {"SCHEDULE_DAYS": "1,2,3,4", "SCHEDULE_DAY_END_MINUTES": 720}
        week = _week(
            lessons,
            frameTimes=_closed(_YEAR_7, 1, 2, 3),
            fixedLessons=[_lock(4, "09:42:00", "10:22:00", teacher=teacher)],
        )

        _, lines = _refusal(_post(settings, week))

        (line,) = lines
        assert line["code"] == "DEMAND_TEACHER_LESSONS_EXCEED_GAPS"
        assert line["params"] == {
            "requirements": 2, "lessons": 6, "shortestMinutes": 30, "demandMinutes": 210,
            "days": 1, "weekDays": 4, "shortOf": "minutes", "fitLessons": 6,
            "capacityMinutes": 190,
        }
        assert line["resourceIds"] == _ids(*lessons[:2])
        assert line["message"].endswith(
            "On the one day of the week's 4 they can fall on, the school day, the frame times, "
            "the rasts, the margins around the lessons, the locked lessons and the pupils' lunch "
            "leave gaps that take at most 190 of those minutes in whole lessons.",
        )

        week["frameTimes"] = _closed(_YEAR_7, 1, 2)
        assert _post(settings, week)["status"] in _SOLVED

    def test_a_class_short_of_its_one_day_is_named_with_no_groups_sent(self) -> None:
        """ldnear/500066, one of the three weeks short of a class's hours:
        year 8 is closed Monday to Thursday, and its class has 90, 80 and 80
        minutes for Friday's four hours. Two of them fit.

        The clique's hours count classes from the payload's `groups`, and the
        fuzz sends none; the class's NoOverlap is the whole proof. Opening
        Thursday solves it.
        """
        group, teacher = str(uuid4()), str(uuid4())
        lessons = [
            _requirement(str(uuid4()), teacher, [90]),
            _requirement(group, teacher, [90, 80, 80], _YEAR_8),
        ]
        settings = {"SCHEDULE_DAY_END_MINUTES": 720}
        week = _week(lessons, frameTimes=_closed(_YEAR_8, 1, 2, 3, 4))

        _, lines = _refusal(_post(settings, week))

        (line,) = lines
        assert line["params"] == {
            "group": group, "requirements": 1, "lessons": 3, "shortestMinutes": 80,
            "demandMinutes": 250, "days": 1, "weekDays": 5, "shortOf": "lessons",
            "fitLessons": 2, "capacityMinutes": 170,
        }

        week["frameTimes"] = _closed(_YEAR_8, 1, 2, 3)
        assert _post(settings, week)["status"] in _SOLVED

    def test_one_room_for_two_classes_is_counted_as_one_room(self) -> None:
        """dist/500054, mixed/500101, lunch/500045: one room, and lessons of
        different classes and teachers that each fit their own week. Three
        100-minute and three 50-minute lessons on two days of four hours: a
        day fills 200 minutes whole, two days 400 of 450.

        The room's NoOverlap is the proof, and the core had named it lesson
        by lesson. A second room solves it.
        """
        first, second = str(uuid4()), str(uuid4())
        lessons = [
            _requirement(first, str(uuid4()), [100] * 3),
            _requirement(second, str(uuid4()), [50] * 3),
        ]
        settings = {"SCHEDULE_DAYS": "1,2", "SCHEDULE_DAY_END_MINUTES": 720}
        week = _week(lessons, rooms=1)

        _, lines = _refusal(_post(settings, week))

        (line,) = lines
        room = week["rooms"][0]["id"]  # type: ignore[index]
        assert line["code"] == "DEMAND_ROOM_LESSONS_EXCEED_GAPS"
        assert line["params"] == {
            "rooms": 1, "requirements": 2, "lessons": 6, "shortestMinutes": 50,
            "demandMinutes": 450, "days": 2, "weekDays": 2, "shortOf": "minutes",
            "fitLessons": 6, "capacityMinutes": 400,
        }
        assert line["roomIds"] == [room]
        assert line["resourceIds"] == _ids(*lessons)
        assert line["message"].startswith(
            "The one room these lessons may use takes one lesson at a time, and there are 6 "
            "lessons of 50 minutes or more to place in 2 requirements, 450 minutes in all.",
        )

        week["rooms"] = [*week["rooms"], {"id": str(uuid4()), "capacity": 30}]  # type: ignore[misc]
        assert _post(settings, week)["status"] in _SOLVED


class TestTheGapsVerdict:
    """The count itself, at its edges."""

    @staticmethod
    def _solver(**settings: object) -> SchedulerSolver:
        return SchedulerSolver(_settings(**{"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 720, **settings}))

    def _verdict(self, payload: dict[str, object], **settings: object):  # type: ignore[no-untyped-def]
        return self._solver(**settings)._lesson_gaps_verdict(OptimizeScheduleRequest.model_validate(payload))

    def _solve(self, payload: dict[str, object], **settings: object):  # type: ignore[no-untyped-def]
        return self._solver(**settings).solve(OptimizeScheduleRequest.model_validate(payload))

    def test_gaps_the_lessons_fill_exactly_are_the_models(self) -> None:
        """Three 80-minute lessons fill a morning of four hours exactly, and
        that is a timetable. Five minutes more on one of them and two fit,
        filling 165 minutes: whole lessons, not the morning's 240."""
        group, teacher = str(uuid4()), str(uuid4())
        full = _week([_requirement(group, teacher, [80] * 3)])
        assert self._verdict(full) is None
        assert self._solve(full).status in _SOLVED

        over = _week([_requirement(group, teacher, [80, 80, 85])])
        verdict = self._verdict(over)
        assert verdict is not None
        params = verdict.conflicts[0].params
        assert (params["shortOf"], params["fitLessons"], params["capacityMinutes"]) == ("lessons", 2, 165)

    def test_three_gaps_take_four_lessons_though_their_minutes_add_up(self) -> None:
        """The class's own locks at 09:50 and 11:00 cut its day into gaps of
        110, 60 and 60 minutes, and its lessons of 20, 45, 50, 55 and 60
        minutes add up to the same 230. No two of them fit an hour and no
        three fit the long gap, so the gaps take four: the count, which the
        minutes do not see. Without the 20-minute lesson they fit."""
        group = str(uuid4())
        lessons = _requirement(group, str(uuid4()), [20, 45, 50, 55, 60])
        week = _week(
            [lessons],
            fixedLessons=[
                _lock(1, "09:50:00", "10:00:00", group=group),
                _lock(1, "11:00:00", "11:10:00", group=group),
            ],
        )

        verdict = self._verdict(week, SCHEDULE_DAY_END_MINUTES=730)
        assert verdict is not None
        assert verdict.conflicts[0].params == {
            "group": group, "requirements": 1, "lessons": 5, "shortestMinutes": 20,
            "demandMinutes": 230, "days": 1, "weekDays": 1, "shortOf": "lessons",
            "fitLessons": 4, "capacityMinutes": 230,
        }

        lessons["lessonLengths"] = [60, 45, 50, 55]
        lessons["lessonsPerWeek"] = 4
        assert self._verdict(week, SCHEDULE_DAY_END_MINUTES=730) is None
        assert self._solve(week, SCHEDULE_DAY_END_MINUTES=730).status in _SOLVED

    def test_a_meal_that_may_move_still_cuts_the_day_it_sits_in(self) -> None:
        """Two days of 08:00-11:30, a 30-minute lunch inside 10:00-11:00, and
        lessons of 90, 90, 100 and 30 minutes. The short one fits after the
        meal, so the day is one gap for the lessons together; but wherever the
        meal sits, at most 150 minutes are left before it and at most 60 after,
        so a day takes one of the long lessons, not the two its 180 minutes
        without the meal would. Without the lunch the week solves."""
        group = str(uuid4())
        week = _week(
            [_requirement(group, str(uuid4()), [90, 30, 100, 90])],
            rules=_lunch(30, "10:00:00", "11:00:00"),
        )

        verdict = self._verdict(week, SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=690)
        assert verdict is not None
        line, lunch = verdict.conflicts
        assert (line.params["lessons"], line.params["shortestMinutes"], line.params["fitLessons"]) == (3, 90, 2)
        assert lunch.code == "LUNCH_BREAK_IS_THE_DIFFERENCE"

        del week["rules"]
        assert self._solve(week, SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=690).status in _SOLVED

    def test_and_the_minutes_it_leaves_are_counted_on_either_side_of_it(self) -> None:
        """The same on two days of 08:00-12:00, a 20-minute lunch inside
        10:30-11:15, and lessons of 80, 90, 100 and 80 minutes beside a 60
        that fits after the meal. Wherever the meal sits, under 80 minutes are
        left after it, so the long lessons fill at most 170 minutes a day
        before it: 340 of their 350, though they are few enough to count."""
        week = _week(
            [_requirement(str(uuid4()), str(uuid4()), [80, 90, 60, 100, 80])],
            rules=_lunch(20, "10:30:00", "11:15:00"),
        )

        verdict = self._verdict(week, SCHEDULE_DAYS="1,2")
        assert verdict is not None
        params = verdict.conflicts[0].params
        assert (params["shortOf"], params["shortestMinutes"]) == ("minutes", 80)
        assert (params["demandMinutes"], params["capacityMinutes"]) == (350, 340)

    def test_the_lunch_line_says_what_the_count_shows_and_no_more(self) -> None:
        """The review of this verdict: two 100-minute lessons with 40 minutes
        for the pupils after each, a day of 08:00-12:30, and the lunch held at
        10:00-10:30. The last start that leaves the 40 minutes inside the day
        is 10:10, so one lesson fits, before the meal. Counted without the
        lunch the day takes both, but the week without it is impossible all
        the same, since the 40 minutes after the first put the second's end
        and its own 40 past 12:30. The count does not see margins between
        lessons, so the line beside the refusal says what the count shows,
        and never that the week would fit without the lunch."""
        week = _week(
            [{**_requirement(str(uuid4()), str(uuid4()), [100, 100]), "minutesAfter": 40}],
            rules=_lunch(30, "10:00:00", "10:30:00"),
        )

        verdict = self._verdict(week, SCHEDULE_DAY_END_MINUTES=750)
        assert verdict is not None
        line, lunch = verdict.conflicts
        assert (line.params["lessons"], line.params["fitLessons"]) == (2, 1)
        assert lunch.code == "LUNCH_BREAK_IS_THE_DIFFERENCE"
        assert lunch.message == (
            "Counted without the 30-minute lunch break, the time these lessons can take has room "
            "for 200 minutes of them, enough to hold them, so the lunch is part of what this count "
            "finds short. It is a count and not a timetable, and does not say the week would fit "
            "without the lunch."
        )

        del week["rules"]
        assert self._verdict(week, SCHEDULE_DAY_END_MINUTES=750) is None
        assert self._solve(week, SCHEDULE_DAY_END_MINUTES=750).status == "INFEASIBLE"

    def test_a_room_line_for_one_lesson_says_it_in_the_singular(self) -> None:
        from app.messages import render

        text = render("DEMAND_ROOM_LESSONS_EXCEED_GAPS", {
            "rooms": 1, "lessons": 1, "shortestMinutes": 100, "requirements": 1,
            "demandMinutes": 100, "shortOf": "nowhere", "days": 0, "weekDays": 5,
            "fitLessons": 0, "capacityMinutes": 0,
        })
        assert text.startswith(
            "The one room these lessons may use takes one lesson at a time, and there is 1 lesson "
            "of 100 minutes or more to place in 1 requirement, 100 minutes in all. No gap",
        )
        assert text.endswith("takes it whole.")

    def test_lessons_held_to_overlapping_days_are_counted_over_their_union(self) -> None:
        """One teacher, mornings of two hours, a 100-minute lesson a morning.
        Year 7's two lessons may fall on Monday and Tuesday, year 8's two on
        Tuesday and Wednesday, and year 9's one on any day. Each year fits its
        own days and the week has five mornings for five lessons, but years 7
        and 8 have four lessons for the three days they share between them.
        Opening Thursday for year 7 solves it."""
        teacher = str(uuid4())
        rows = [
            _requirement(str(uuid4()), teacher, [100, 100]),
            _requirement(str(uuid4()), teacher, [100, 100], _YEAR_8),
            _requirement(str(uuid4()), teacher, [100], {"minGradeLevel": 9, "maxGradeLevel": 9}),
        ]
        week = _week(rows, frameTimes=_closed(_YEAR_7, 3, 4, 5) + _closed(_YEAR_8, 1, 4, 5))
        five_mornings = {"SCHEDULE_DAYS": "1,2,3,4,5", "SCHEDULE_DAY_END_MINUTES": 600}

        verdict = self._verdict(week, **five_mornings)
        assert verdict is not None
        (line,) = verdict.conflicts
        assert line.code == "DEMAND_TEACHER_LESSONS_EXCEED_GAPS"
        assert (line.params["lessons"], line.params["days"], line.params["fitLessons"]) == (4, 3, 3)
        assert [str(value) for value in line.resource_ids] == _ids(*rows[:2])

        week["frameTimes"] = _closed(_YEAR_7, 3, 5) + _closed(_YEAR_8, 1, 4, 5)
        assert self._verdict(week, **five_mornings) is None
        assert self._solve(week, **five_mornings).status in _SOLVED

    @pytest.mark.parametrize("whose", ["teacher", "co-teacher", "class"])
    def test_a_lock_is_missed_at_its_outward_window(self, whose: str) -> None:
        """08:47-09:13 rounds out to 08:45-09:15, and a morning of 08:00-10:00
        then has two 45-minute gaps: two 45-minute lessons fit, one of 50
        fits neither. The lesson's own teacher's lock, one they co-teach, or
        its class's with nobody in common, alike."""
        group, teacher = str(uuid4()), str(uuid4())
        lock = _lock(1, "08:47:00", "09:13:00")
        if whose == "teacher":
            lock["teacherId"] = teacher
        elif whose == "co-teacher":
            lock["teacherId"] = str(uuid4())
            lock["coTeacherId"] = teacher
        else:
            lock["studentGroupId"] = group
        fits = _week([_requirement(group, teacher, [45, 45])], fixedLessons=[lock])
        assert self._verdict(fits, SCHEDULE_DAY_END_MINUTES=600) is None
        assert self._solve(fits, SCHEDULE_DAY_END_MINUTES=600).status in _SOLVED

        long = _week([_requirement(group, teacher, [50])], fixedLessons=[lock])
        verdict = self._verdict(long, SCHEDULE_DAY_END_MINUTES=600)
        assert verdict is not None
        assert verdict.conflicts[0].params["shortOf"] == "nowhere"

    def test_a_reservation_is_left_to_the_model_which_names_it(self) -> None:
        """A reservation hangs on a literal, so the week it makes impossible is
        the model's to refuse, by the reservation's name. Counted here, the
        gaps would be blamed for a sentence the school wrote."""
        teacher = str(uuid4())
        reserved = _week(
            [_requirement(str(uuid4()), teacher, [45, 45])],
            constraints=[{
                "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": teacher,
                "dayOfWeek": 1, "startTime": "08:45:00", "endTime": "09:20:00",
                "kind": "UNAVAILABLE",
            }],
        )

        assert self._verdict(reserved, SCHEDULE_DAY_END_MINUTES=600) is None
        response = self._solve(reserved, SCHEDULE_DAY_END_MINUTES=600)
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "AVAIL_CONSTRAINT_BLOCKS_LESSONS" in {line.code for line in response.conflicts.conflicts}

    def test_a_lunch_placed_by_hand_is_counted_where_the_window_would_have_it(self) -> None:
        """Two 75-minute lessons on a morning of 08:00-11:30 and a 30-minute
        lunch inside 09:00-11:00: at 10:30 the meal leaves room for both
        before it. The school placed it at 09:00, where it leaves room for
        one; that pin hangs on a literal, so the week is the model's, which
        names the pin."""
        group = str(uuid4())
        week = _week(
            [_requirement(group, str(uuid4()), [75, 75])],
            rules=_lunch(30, "09:00:00", "11:00:00"),
            lunchPlacements=[{"studentGroupId": group, "dayOfWeek": 1, "startTime": "09:00:00"}],
        )

        assert self._verdict(week, SCHEDULE_DAY_END_MINUTES=690) is None
        response = self._solve(week, SCHEDULE_DAY_END_MINUTES=690)
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "LUNCH_PLACED_BY_HAND" in {line.code for line in response.conflicts.conflicts}

    def test_a_group_sharing_the_pupils_of_a_class_keeps_clear_of_its_lunch(self) -> None:
        """7A eats at 10:00-11:00 on a day of 08:00-12:00 and has no lessons
        of its own; Ma71 is cut from it and does not eat, but its 130-minute
        lesson is taught to 7A's pupils, so it cannot cross 7A's meal, and no
        side of the meal is long enough. Without the pair the lesson fits."""
        home, cut = str(uuid4()), str(uuid4())
        week = _week(
            [_requirement(cut, str(uuid4()), [130])],
            rules=_lunch(60, "10:00:00", "11:00:00"),
            groups=[{"id": home, "lunchHeadcount": 24, **_YEAR_7}],
            groupConflicts=[[home, cut]],
        )

        verdict = self._verdict(week)
        assert verdict is not None
        assert verdict.conflicts[0].resource_ids == [UUID(cut)]
        assert verdict.conflicts[0].params["shortOf"] == "nowhere"

        week["groupConflicts"] = []
        assert self._verdict(week) is None

    def test_lessons_that_need_one_room_type_are_counted_against_those_rooms(self) -> None:
        """Two classes with three 90-minute lab lessons each, one lab and a
        classroom, and two days of four hours. A day takes two of them in the
        lab, and the classroom does not take them at all; any other lesson
        could use either room."""
        lab = {"id": str(uuid4()), "capacity": 30, "type": "LAB"}
        week = {
            **_week([
                _requirement(str(uuid4()), str(uuid4()), [90] * 3, requiredRoomType="LAB"),
                _requirement(str(uuid4()), str(uuid4()), [90] * 3, requiredRoomType="LAB"),
            ]),
            "rooms": [lab, {"id": str(uuid4()), "capacity": 30}],
        }

        verdict = self._verdict(week, SCHEDULE_DAYS="1,2")
        assert verdict is not None
        (line,) = verdict.conflicts
        assert line.code == "DEMAND_ROOM_LESSONS_EXCEED_GAPS"
        assert [str(room) for room in line.room_ids] == [lab["id"]]
        assert (line.params["rooms"], line.params["lessons"], line.params["fitLessons"]) == (1, 6, 4)

        week["rooms"] = [lab, {**lab, "id": str(uuid4())}]
        assert self._verdict(week, SCHEDULE_DAYS="1,2") is None

    def test_a_co_teacher_counts_every_lesson_they_are_on_and_a_person_once(self) -> None:
        """Anna leads an hour and co-teaches another that Bo leads, on a
        morning of 90 minutes: two hours are hers, and both rows are named.
        Down as lead and co-teacher of one row, she counts it once."""
        anna, bo = str(uuid4()), str(uuid4())
        rows = [
            _requirement(str(uuid4()), anna, [60]),
            _requirement(str(uuid4()), bo, [60], coTeacherId=anna),
        ]
        verdict = self._verdict(_week(rows), SCHEDULE_DAY_END_MINUTES=570)
        assert verdict is not None
        (line,) = verdict.conflicts
        assert line.code == "DEMAND_TEACHER_LESSONS_EXCEED_GAPS"
        assert [str(value) for value in line.resource_ids] == _ids(*rows)

        legacy = _week([_requirement(str(uuid4()), anna, [60], coTeacherId=anna)])
        assert self._verdict(legacy, SCHEDULE_DAY_END_MINUTES=570) is None

    def test_a_week_with_nobody_named_gets_the_builder_s_meals_and_no_lunch_stage(self) -> None:
        """_lunch_start_narrowings reads every group with lessons when the
        payload names nobody, the meals the model builds; the lunch stage,
        which seats a hall nobody described, still decides nothing."""
        group = str(uuid4())
        week = _week(
            [_requirement(group, str(uuid4()), [60])],
            rules=_lunch(30, "10:00:00", "11:00:00"),
        )
        solver = self._solver()
        request = OptimizeScheduleRequest.model_validate(week)

        narrowings = solver._lunch_start_narrowings(request, step=1)
        assert narrowings is not None
        assert [str(key[0]) for key in narrowings] == [group]
        assert solver._lunch_stage_one(request) == (None, {})


class TestASplitPost:
    """Delade lektioner: a post whose lessons are split between teachers
    (lessonTeacherIds) is in each teacher's gaps with the lessons they are on.

    The verdict reads a teacher's lessons as the model posts them — one
    NoOverlap per teacher, each lesson in its own lead's — so Bo's one lesson
    of 7A's two is his, and Anna's is hers. Counted with the row's union
    (_teachers_of) the verdict would put both in Bo's gaps and refuse a week
    the model places; that is what each test below would see.
    """

    def test_a_share_teacher_is_counted_only_their_own_lesson(self) -> None:
        """Bo has three 90-minute lessons of his own and one of 7A's two, on
        four mornings that take one each: four in four. Anna has the other."""
        g1, g2, anna, bo = (str(uuid4()) for _ in range(4))
        shared = _requirement(g1, anna, [90, 90], lessonTeacherIds=[anna, bo])
        bos_own = _requirement(g2, bo, [90] * 3)
        settings = {"SCHEDULE_DAYS": "1,2,3,4", "SCHEDULE_DAY_END_MINUTES": 600}

        body = _post(settings, _week([shared, bos_own], rooms=2))

        assert body["status"] in _SOLVED, body.get("conflicts")

    def test_with_both_lessons_his_the_week_is_refused(self) -> None:
        """The control: 7A's two lessons both Bo's make five in four, and
        the verdict says so before any model."""
        g1, g2, bo = (str(uuid4()) for _ in range(3))
        both = _requirement(g1, bo, [90, 90])
        bos_own = _requirement(g2, bo, [90] * 3)
        settings = {"SCHEDULE_DAYS": "1,2,3,4", "SCHEDULE_DAY_END_MINUTES": 600}

        _conflicts, lines = _refusal(_post(settings, _week([both, bos_own], rooms=2)))

        assert any(line["code"] == "DEMAND_TEACHER_LESSONS_EXCEED_GAPS" for line in lines), lines

    def test_a_share_teacher_s_lock_cuts_only_their_own_lesson(self) -> None:
        """Bo's lesson locked elsewhere on Monday morning shuts Monday to his
        lesson of 7A, not to Anna's: hers goes on Monday, his on Tuesday."""
        g1, anna, bo = (str(uuid4()) for _ in range(3))
        shared = _requirement(g1, anna, [90, 90], lessonTeacherIds=[anna, bo])
        settings = {"SCHEDULE_DAYS": "1,2", "SCHEDULE_DAY_END_MINUTES": 600}
        week = _week([shared], rooms=1, fixedLessons=[_lock(1, "08:00:00", "09:30:00", teacher=bo)])

        body = _post(settings, week)

        assert body["status"] in _SOLVED, body.get("conflicts")
