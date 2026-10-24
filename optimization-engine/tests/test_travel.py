"""Restid i generatorn: the walk between two skolområden, kept by the generator.

THE SCAFFOLDING. One short day — 08:00 to a few hours later — on one or two
weekdays, lessons of 60 minutes, and two sites, NORRA and SODRA, WALK minutes
apart. A room type that only one site has (LAB at Norra, GYM at Södra) pins a
lesson to a site; a plain room on each site leaves the choice to the solver.
Every case is arithmetic a reader can do in their head: with 60-minute
lessons on a day of 150 minutes the start step is 30, so a walk of 10 is held
as 30 (the roadmap's decision: rounded up to the step), and two lessons fit
with one step between them and not back to back.

WHAT COUNTS is src/common/site-travel.ts's reading: a room on no site, a pair
with no figure and a figure of 0 keep nothing apart. What the school locked
is a fact: two locked lessons are never held apart, and a generated one is
held a walk away from a locked one on another site.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.messages import render
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver, _solve_guarded, _start_step
from app.solver.travel import families_of, site_plan, travel_map

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from validate_schedule import _travel_problems  # noqa: E402

NORRA = str(uuid4())
SODRA = str(uuid4())
ELSEWHERE = str(uuid4())
TEACHER = str(uuid4())
OTHER_TEACHER = str(uuid4())
GROUP = str(uuid4())
OTHER_GROUP = str(uuid4())
WALK = 10

#: 08:00-10:30 on Monday: 150 minutes, two 60-minute lessons with one 30-minute
#: step between them, or back to back with a step to spare.
ONE_DAY = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 630}
#: 08:00-10:00 on Monday: two 60-minute lessons fit only back to back.
TIGHT_DAY = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 600}


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, SOLVER_PROBE_SECONDS=5.0, **overrides)  # type: ignore[arg-type]


def _room(kind: str | None, site: str | None) -> dict[str, object]:
    room: dict[str, object] = {"id": str(uuid4()), "capacity": 30}
    if kind is not None:
        room["type"] = kind
    if site is not None:
        room["siteId"] = site
    return room


def _requirement(
    group: str, *, teacher: str | None = TEACHER, kind: str | None = None,
    lessons: int = 1, minutes_before: int = 0, minutes_after: int = 0,
    split: list[str] | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher,
        "lessonsPerWeek": lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 24,
        "minutesBefore": minutes_before,
        "minutesAfter": minutes_after,
    }
    if kind is not None:
        row["requiredRoomType"] = kind
    if split is not None:
        row["lessonTeacherIds"] = split
    return row


def _payload(
    requirements: list[dict[str, object]],
    *,
    rooms: list[dict[str, object]] | None = None,
    walk: int | None = WALK,
    conflicts: list[tuple[str, str]] | None = None,
    fixed: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": rooms if rooms is not None else [_room("LAB", NORRA), _room("GYM", SODRA)],
        "groupConflicts": [list(pair) for pair in conflicts or []],
        "fixedLessons": fixed or [],
    }
    if walk is not None:
        payload["siteTravelTimes"] = [{"siteAId": NORRA, "siteBId": SODRA, "minutes": walk}]
    return payload


def _solve(payload: dict[str, object], **settings: object):
    solver = SchedulerSolver(_settings(**{**ONE_DAY, **settings}))
    request = OptimizeScheduleRequest.model_validate(payload)
    return solver, request, solver.solve(request)


def _starts(response) -> list[str]:  # noqa: ANN001
    return sorted(lesson.start_time for lesson in response.lessons)


def _model_hash(payload: dict[str, object], **settings: object) -> str:
    solver = SchedulerSolver(_settings(**{**ONE_DAY, **settings}))
    model, *_ = solver._build_model(
        OptimizeScheduleRequest.model_validate(payload),
        use_assumptions=False, include_objective=True,
    )
    return hashlib.sha256(str(model.Proto()).encode()).hexdigest()


# ---------------------------------------------------------------------------
# Off is today's model.
# ---------------------------------------------------------------------------


class TestOffIsTodaysModel:
    def test_no_figures_build_the_model_without_sites(self) -> None:
        """No siteTravelTimes: the rooms' sites are read by nothing."""
        requirements = [
            _requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM"),
        ]
        rooms = [_room("LAB", NORRA), _room("GYM", SODRA)]
        bare = [{k: v for k, v in room.items() if k != "siteId"} for room in rooms]
        with_sites = _payload(requirements, rooms=rooms, walk=None)
        without = {**with_sites, "rooms": bare}
        assert _model_hash(with_sites) == _model_hash(without)

    @pytest.mark.parametrize("walk", [0])
    def test_a_walk_of_nothing_is_no_rule(self, walk: int) -> None:
        requirements = [_requirement(GROUP), _requirement(OTHER_GROUP)]
        rooms = [_room(None, NORRA), _room(None, SODRA)]
        on = _payload(requirements, rooms=rooms, walk=walk)
        off = _payload(requirements, rooms=rooms, walk=None)
        assert _model_hash(on) == _model_hash(off)

    def test_figures_between_sites_no_room_stands_on_are_no_rule(self) -> None:
        requirements = [_requirement(GROUP), _requirement(OTHER_GROUP)]
        rooms = [_room(None, NORRA), _room(None, NORRA)]
        payload = _payload(requirements, rooms=rooms)
        payload["siteTravelTimes"] = [{"siteAId": SODRA, "siteBId": ELSEWHERE, "minutes": 20}]
        off = _payload(requirements, rooms=rooms, walk=None)
        assert _model_hash(payload) == _model_hash(off)


# ---------------------------------------------------------------------------
# The contract.
# ---------------------------------------------------------------------------


class TestTheContract:
    def test_a_pair_twice_is_a_shape_refused(self) -> None:
        payload = _payload([_requirement(GROUP)])
        payload["siteTravelTimes"] = [
            {"siteAId": NORRA, "siteBId": SODRA, "minutes": 10},
            {"siteAId": SODRA, "siteBId": NORRA, "minutes": 12},
        ]
        with pytest.raises(ValidationError, match="names one pair of sites twice"):
            OptimizeScheduleRequest.model_validate(payload)

    def test_a_site_to_itself_is_refused(self) -> None:
        payload = _payload([_requirement(GROUP)])
        payload["siteTravelTimes"] = [{"siteAId": NORRA, "siteBId": NORRA, "minutes": 10}]
        with pytest.raises(ValidationError, match="two different sites"):
            OptimizeScheduleRequest.model_validate(payload)

    @pytest.mark.parametrize("minutes", [-1, 241])
    def test_the_minutes_keep_the_databases_bounds(self, minutes: int) -> None:
        payload = _payload([_requirement(GROUP)], walk=minutes)
        with pytest.raises(ValidationError):
            OptimizeScheduleRequest.model_validate(payload)

    def test_the_walk_is_rounded_up_to_the_start_step(self) -> None:
        """60-minute lessons on a 150-minute day step every 30: ten minutes is one step."""
        request = OptimizeScheduleRequest.model_validate(
            _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
        )
        solver = SchedulerSolver(_settings(**ONE_DAY))
        step = _start_step(request, solver._grid)
        assert step * solver._grid.slot_minutes == 30
        travel = travel_map(request, slot_minutes=solver._grid.slot_minutes, step=step)
        assert travel is not None
        assert travel.between(UUID(NORRA), UUID(SODRA)) == step
        assert travel.step_minutes == 30


# ---------------------------------------------------------------------------
# The teacher walks.
# ---------------------------------------------------------------------------


class TestTheTeacher:
    def test_two_sites_are_a_step_apart(self) -> None:
        """LAB at Norra, GYM at Södra, one teacher: never back to back."""
        _solver, request, response = _solve(_payload([
            _requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM"),
        ]))
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _starts(response) == ["08:00:00", "09:30:00"]
        assert _travel_problems(request, response.lessons) == []

    def test_one_site_may_be_back_to_back(self) -> None:
        """Both at Norra: no walk, and a tight day holds them both."""
        _solver, _request, response = _solve(
            _payload(
                [_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="LAB")],
                rooms=[_room("LAB", NORRA), _room("LAB", NORRA), _room("GYM", SODRA)],
            ),
            **TIGHT_DAY,
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _starts(response) == ["08:00:00", "09:00:00"]

    def test_the_solver_picks_the_site_that_needs_no_walk(self) -> None:
        """A plain room on each site: on a tight day the lessons share one."""
        _solver, request, response = _solve(
            _payload(
                [_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP)],
                rooms=[_room("LAB", NORRA), _room(None, NORRA), _room(None, SODRA)],
            ),
            **TIGHT_DAY,
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        sites = {
            room["id"]: room.get("siteId") for room in _payload([], rooms=None)["rooms"]
        }
        del sites
        assert _travel_problems(request, response.lessons) == []

    def test_a_tight_day_is_refused_and_names_the_teacher(self) -> None:
        _solver, _request, response = _solve(
            _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
            **TIGHT_DAY,
        )
        assert response.status == "INFEASIBLE"
        lines = [d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT"]
        assert len(lines) == 1
        # A day of two hours of 60-minute lessons steps every 60: the walk of
        # ten is held as an hour, and the sentence says so.
        assert lines[0].params == {"stepMinutes": 60, "measured": 1}
        assert [str(r) for r in lines[0].resource_ids] == [TEACHER]
        assert lines[0].category == "TEACHER_OVERLAP"
        # The line leads, and the pupils have no line: two groups, no pupil walks.
        assert response.conflicts.conflicts[0] is lines[0] or response.conflicts.conflicts[0] == lines[0]
        assert not [d for d in response.conflicts.conflicts if d.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT"]

    def test_a_co_teacher_walks_too(self) -> None:
        lab = _requirement(GROUP, teacher=OTHER_TEACHER, kind="LAB")
        lab["coTeacherId"] = TEACHER
        _solver, request, response = _solve(
            _payload([lab, _requirement(OTHER_GROUP, kind="GYM")]),
            **TIGHT_DAY,
        )
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert [str(r) for r in line.resource_ids] == [TEACHER]

    def test_a_room_on_no_site_walks_nowhere(self) -> None:
        """The gateway's unknown: no site, no walk, no refusal."""
        _solver, _request, response = _solve(
            _payload(
                [_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")],
                rooms=[_room("LAB", NORRA), _room("GYM", None), _room(None, SODRA)],
            ),
            **TIGHT_DAY,
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}

    def test_a_pair_with_no_figure_walks_nowhere(self) -> None:
        payload = _payload(
            [_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")],
            rooms=[_room("LAB", NORRA), _room("GYM", ELSEWHERE), _room(None, SODRA)],
        )
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status in {"OPTIMAL", "FEASIBLE"}

    def test_two_days_need_no_walk(self) -> None:
        """Monday and Tuesday on the tight day: one lesson each, back to back never."""
        _solver, _request, response = _solve(
            _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
            SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=540,
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert {lesson.day_of_week for lesson in response.lessons} == {1, 2}


# ---------------------------------------------------------------------------
# The pupils walk.
# ---------------------------------------------------------------------------


class TestThePupils:
    def test_one_group_walks_between_its_own_lessons(self) -> None:
        _solver, _request, response = _solve(
            _payload([
                _requirement(GROUP, teacher=TEACHER, kind="LAB"),
                _requirement(GROUP, teacher=OTHER_TEACHER, kind="GYM"),
            ]),
            **TIGHT_DAY,
        )
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT")
        assert [str(r) for r in line.resource_ids] == [GROUP]
        assert line.params["measured"] == 1

    def test_groups_sharing_a_pupil_walk_between_each_others_lessons(self) -> None:
        payload = _payload(
            [
                _requirement(GROUP, teacher=TEACHER, kind="LAB"),
                _requirement(OTHER_GROUP, teacher=OTHER_TEACHER, kind="GYM"),
            ],
            conflicts=[(GROUP, OTHER_GROUP)],
        )
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT")
        assert sorted(str(r) for r in line.resource_ids) == sorted([GROUP, OTHER_GROUP])

    def test_groups_sharing_nobody_do_not_walk(self) -> None:
        payload = _payload([
            _requirement(GROUP, teacher=TEACHER, kind="LAB"),
            _requirement(OTHER_GROUP, teacher=OTHER_TEACHER, kind="GYM"),
        ])
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status in {"OPTIMAL", "FEASIBLE"}

    def test_the_walk_comes_after_the_shower(self) -> None:
        """Twenty minutes after idrotten, THEN the walk: the two add up.

        The shower's twenty puts the step at 20, so the walk of ten is held as
        twenty: 60 + 20 + 20 + 60 = 160 minutes from the first start to the
        last end. A day of 160 holds them exactly, idrott first; a day of 140
        would hold them if the walk were the larger of the two rather than
        their sum, and does not.
        """
        payload = _payload([
            _requirement(GROUP, teacher=TEACHER, kind="GYM", minutes_after=20),
            _requirement(GROUP, teacher=OTHER_TEACHER, kind="LAB"),
        ])
        _solver, request, response = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=640)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        by_start = sorted(response.lessons, key=lambda lesson: lesson.start_time)
        assert [lesson.start_time for lesson in by_start] == ["08:00:00", "09:40:00"]
        assert _travel_problems(request, response.lessons) == []
        _solver, _request, refused = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=620)
        assert refused.status == "INFEASIBLE"


# ---------------------------------------------------------------------------
# Locked lessons are facts.
# ---------------------------------------------------------------------------


def _locked(
    start: str, end: str, room: dict[str, object], *, teacher: str | None = TEACHER,
    group: str | None = None, day: int = 1,
) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "teacherId": teacher,
        "studentGroupId": group or str(uuid4()),
        "roomId": room["id"],
        "dayOfWeek": day,
        "startTime": start,
        "endTime": end,
    }


class TestLockedLessons:
    def test_a_generated_lesson_keeps_the_walk_to_a_locked_one(self) -> None:
        lab, gym = _room("LAB", NORRA), _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="GYM")],
            rooms=[lab, gym],
            fixed=[_locked("08:00:00", "09:00:00", lab)],
        )
        _solver, request, response = _solve(payload)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _starts(response) == ["09:30:00"]
        assert _travel_problems(request, response.lessons) == []

    def test_no_room_for_the_walk_to_a_locked_lesson_is_refused_by_name(self) -> None:
        lab, gym = _room("LAB", NORRA), _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="GYM")],
            rooms=[lab, gym],
            fixed=[_locked("08:00:00", "09:00:00", lab)],
        )
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert [str(r) for r in line.resource_ids] == [TEACHER]

    def test_two_locked_lessons_are_never_held_apart(self) -> None:
        """The school locked a walk nobody can make: that was the warning's to say."""
        lab, gym, plain = _room("LAB", NORRA), _room("GYM", SODRA), _room(None, NORRA)
        payload = _payload(
            [_requirement(GROUP, teacher=OTHER_TEACHER)],
            rooms=[lab, gym, plain],
            fixed=[
                _locked("08:00:00", "09:00:00", lab),
                _locked("09:00:00", "10:00:00", gym),
            ],
        )
        _solver, _request, response = _solve(payload)
        assert response.status in {"OPTIMAL", "FEASIBLE"}

    def test_a_lesson_the_evening_before_does_not_walk_to_the_morning(self) -> None:
        """Monday's last hour at Norra, Tuesday's first locked at Södra: a night apart."""
        gym = _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="LAB")],
            rooms=[_room("LAB", NORRA), gym],
            fixed=[_locked("08:00:00", "09:00:00", gym, day=2)],
        )
        # Monday 08:00-09:00 only, so the generated lesson ends at the grid's
        # end, and Tuesday's lock starts at its first slot.
        _solver, _request, response = _solve(
            payload, SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=540,
        )
        assert response.status in {"OPTIMAL", "FEASIBLE"}

    def test_a_lock_before_the_day_opens_is_walked_from(self) -> None:
        """07:20–08:00 at Södra on a grid that opens at 08:00: it blocks no slot,
        and the teacher still walks from it before the lesson at Norra."""
        lab, gym = _room("LAB", NORRA), _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="LAB")],
            rooms=[lab, gym],
            fixed=[_locked("07:20:00", "08:00:00", gym)],
        )
        _solver, request, response = _solve(payload)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _starts(response)[0] >= "08:30:00"
        assert _travel_problems(request, response.lessons) == []

    def test_a_lock_after_the_day_closes_is_walked_to(self) -> None:
        """10:30–11:10 at Södra on a day that closes at 10:30: a lesson at Norra
        may end at 10:00 and not at 10:30, the walk of ten held as a step."""
        lab, gym = _room("LAB", NORRA), _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="LAB")],
            rooms=[lab, gym],
            fixed=[_locked("10:30:00", "11:10:00", gym)],
        )
        solver = SchedulerSolver(_settings(**ONE_DAY))
        model, _registry, decisions, _plan, _lunch = solver._build_model(
            OptimizeScheduleRequest.model_validate(payload),
            use_assumptions=False, include_objective=False,
        )

        def starting_at(slot: int) -> int:
            pinned = model.Clone()
            pinned.Add(pinned.GetIntVarFromProtoIndex(decisions[0].start.Index()) == slot)
            return cp_model.CpSolver().Solve(pinned)

        nine, half_past_nine = 12, 18  # five-minute slots from 08:00
        assert starting_at(nine) in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        assert starting_at(half_past_nine) == cp_model.INFEASIBLE

    def test_no_room_after_a_lock_before_the_day_is_refused_by_name(self) -> None:
        """Two hours at Norra on a day of two hours: no step left for the walk
        from the 07:20 lock, and the verdict reads the lock where it stands."""
        gym = _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, kind="LAB", lessons=2)],
            rooms=[_room("LAB", NORRA), gym],
            fixed=[_locked("07:20:00", "08:00:00", gym)],
        )
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert line.params["measured"] == 1
        assert [str(r) for r in line.resource_ids] == [TEACHER]


class TestSplitPosts:
    """A post split between leads (#189's lessonTeacherIds): each lesson walks
    with the teachers ON it, as the expanded twin — one row per lead — does."""

    def test_a_split_lesson_holds_its_own_lead_to_the_walk(self) -> None:
        """Bertil leads the lab's second hour at Norra and has the gym at Södra:
        on a day of two hours his walk cannot be kept, and he is the one named."""
        payload = _payload([
            _requirement(GROUP, teacher=TEACHER, kind="LAB", lessons=2, split=[TEACHER, OTHER_TEACHER]),
            _requirement(OTHER_GROUP, teacher=OTHER_TEACHER, kind="GYM"),
        ])
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status == "INFEASIBLE"
        line = next(d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert [str(r) for r in line.resource_ids] == [OTHER_TEACHER]

    def test_a_lead_is_not_held_to_the_other_leads_lessons(self) -> None:
        """Anna leads one lab hour and has the gym; Bertil, locked at 08 and 10
        elsewhere, leads the other lab hour at 09. Anna does not walk to
        Bertil's lesson: gym 08, Bertil's lab 09, her lab 10 is a timetable."""
        lock_room = _room(None, None)
        payload = _payload(
            [
                _requirement(GROUP, teacher=TEACHER, kind="LAB", lessons=2, split=[TEACHER, OTHER_TEACHER]),
                _requirement(OTHER_GROUP, teacher=TEACHER, kind="GYM"),
            ],
            rooms=[_room("LAB", NORRA), _room("GYM", SODRA), lock_room],
            fixed=[
                _locked("08:00:00", "09:00:00", lock_room, teacher=OTHER_TEACHER),
                _locked("10:00:00", "11:00:00", lock_room, teacher=OTHER_TEACHER),
            ],
        )
        _solver, request, response = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=660)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _travel_problems(request, response.lessons) == []

    def test_a_lock_holds_only_its_own_teachers_lesson_a_walk_away(self) -> None:
        """Bertil is locked at Södra until 08:00, before the day opens, and leads
        the lab's second hour at Norra: his hour waits for the walk, to 09.
        Anna's hour does not — read off the row, both would wait, and a day of
        two hours holds only one of them after 09."""
        gym = _room("GYM", SODRA)
        payload = _payload(
            [_requirement(GROUP, teacher=TEACHER, kind="LAB", lessons=2, split=[TEACHER, OTHER_TEACHER])],
            rooms=[_room("LAB", NORRA), gym],
            fixed=[_locked("07:20:00", "08:00:00", gym, teacher=OTHER_TEACHER)],
        )
        _solver, request, response = _solve(payload, **TIGHT_DAY)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _travel_problems(request, response.lessons) == []
        bertils = [lesson for lesson in response.lessons if str(lesson.teacher_id) == OTHER_TEACHER]
        assert [lesson.start_time for lesson in bertils] == ["09:00:00"]


# ---------------------------------------------------------------------------
# The night.
# ---------------------------------------------------------------------------


class TestTheNight:
    def test_the_last_lesson_and_the_next_mornings_first_need_no_walk(self) -> None:
        """Monday ends at Norra on the grid's last slot; Tuesday begins at Södra on its first.

        Absolute slots run on from one day into the next, so a trail of a walk
        after Monday's last lesson reaches Tuesday's first slots; the rows are
        posted over the night (stretched) and the week has its timetable.
        """
        payload = _payload([
            _requirement(GROUP, kind="LAB", lessons=1),
            _requirement(OTHER_GROUP, kind="GYM", lessons=1),
        ])
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=540))
        request = OptimizeScheduleRequest.model_validate(payload)
        response = solver.solve(request)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert {lesson.day_of_week for lesson in response.lessons} == {1, 2}

    def test_the_stretch_is_only_built_where_the_night_can_be_reached(self) -> None:
        payload = _payload([
            _requirement(GROUP, kind="LAB", lessons=1),
            _requirement(OTHER_GROUP, kind="GYM", lessons=1),
        ])
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=720))
        model, *_ = solver._build_model(
            OptimizeScheduleRequest.model_validate(payload),
            use_assumptions=False, include_objective=False,
        )
        # A frame-free day of four hours reaches its last slot; the stretch is built.
        names = [v.name for v in model.Proto().variables]
        assert any(name.startswith("stretched_") for name in names)


# ---------------------------------------------------------------------------
# The refusal is measured.
# ---------------------------------------------------------------------------


def _core(request: OptimizeScheduleRequest, *lines: tuple[str, list[str]], extra=()) -> "ConflictAnalysis":  # noqa: ANN001
    """A core as the explanation hands one over: the walk's lines, unmeasured,
    and whatever else it held. Cores are CP-SAT's to choose, and a sufficient
    set may well leave the walk out where something else is enough; the
    verdict's job is to judge the lines it is handed, so its tests hand them."""
    step = _start_step(request, SchedulerSolver(_settings(**ONE_DAY))._grid)
    codes = {"TEACHER": "TEACHER_TRAVEL_CANNOT_BE_KEPT", "PUPILS": "PUPILS_TRAVEL_CANNOT_BE_KEPT"}
    categories = {"TEACHER": "TEACHER_OVERLAP", "PUPILS": "GROUP_OVERLAP"}
    details = [
        ConflictDetail(
            category=categories[party], code=codes[party],
            params={"stepMinutes": step * 5, "measured": 0},
            resource_ids=[UUID(i) for i in ids],
        )
        for party, ids in lines
    ]
    return ConflictAnalysis(summary_code="CONFLICT_CORE_SUMMARY", conflicts=[*details, *extra])


def _held_back_week() -> dict[str, object]:
    """The teacher's lock at Norra 08:00-09:00 leaves the gym lesson at Södra
    09:00 on a two-hour day: no step for the walk, whatever else the week does.
    And a class with two lessons under a daily maximum of one: impossible
    without any walk."""
    lab, gym = _room("LAB", NORRA), _room("GYM", SODRA)
    payload = _payload(
        [
            _requirement(GROUP, kind="GYM"),
            _requirement(OTHER_GROUP, teacher=OTHER_TEACHER, lessons=2),
        ],
        rooms=[lab, gym, _room(None, NORRA), _room(None, NORRA)],
        fixed=[_locked("08:00:00", "09:00:00", lab)],
    )
    payload["rules"] = {"maxLessonsPerDayPerGroup": 1}
    return payload


class TestTheVerdict:
    def test_a_family_alone_without_room_for_its_walk_is_named_measured_two(self) -> None:
        """Impossible without the walk too (the maximum), and the teacher alone
        cannot keep it: the walk's line stays, measured 2."""
        request = OptimizeScheduleRequest.model_validate(_held_back_week())
        solver = SchedulerSolver(_settings(**TIGHT_DAY))
        answer = solver._travel_verdict(request, _core(request, ("TEACHER", [TEACHER])))
        line = next(d for d in answer.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert line.params["measured"] == 2
        assert [str(r) for r in line.resource_ids] == [TEACHER]

    def test_a_walk_that_is_no_part_of_the_answer_is_dropped(self) -> None:
        """Too many lessons for the day: the walk was in the core and is not the cause."""
        payload = _payload([
            _requirement(GROUP, kind="LAB"),
            _requirement(OTHER_GROUP, kind="GYM", lessons=3),
        ])
        _solver, _request, response = _solve(payload, **TIGHT_DAY)
        assert response.status == "INFEASIBLE"
        assert not [
            d for d in (response.conflicts.conflicts if response.conflicts else [])
            if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT"
        ]

    def test_a_family_not_answered_in_time_keeps_the_line_unmeasured(self, monkeypatch) -> None:
        """No family measured is no family found innocent: the line stays, measured 0."""
        monkeypatch.setattr(SchedulerSolver, "_family_alone", lambda *_args, **_kwargs: None)
        request = OptimizeScheduleRequest.model_validate(_held_back_week())
        solver = SchedulerSolver(_settings(**TIGHT_DAY))
        answer = solver._travel_verdict(request, _core(request, ("TEACHER", [TEACHER])))
        line = next(d for d in answer.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert line.params["measured"] == 0
        assert [str(r) for r in line.resource_ids] == [TEACHER]

    @staticmethod
    def _across_families() -> tuple[dict[str, object], list[str]]:
        """Three teachers each with a lesson in the one lab and one in the gym on
        a day of three hours: each fits alone, not together. And a class over
        the daily maximum, which makes the week impossible without the walk."""
        teachers = [str(uuid4()) for _ in range(3)]
        requirements = [
            _requirement(str(uuid4()), teacher=teacher, kind=kind)
            for teacher in teachers
            for kind in ("LAB", "GYM")
        ]
        requirements.append(_requirement(GROUP, teacher=OTHER_TEACHER, lessons=2))
        payload = _payload(
            requirements, rooms=[_room("LAB", NORRA), _room("GYM", SODRA), _room(None, NORRA)],
        )
        payload["rules"] = {"maxLessonsPerDayPerGroup": 1}
        return payload, teachers

    def test_a_walk_that_is_a_cause_only_across_families_stays(self) -> None:
        """The walk is a cause beside the maximum, though no teacher alone is
        held back: the line stays, measured 0."""
        payload, teachers = self._across_families()
        request = OptimizeScheduleRequest.model_validate(payload)
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=660))
        answer = solver._travel_verdict(request, _core(request, ("TEACHER", teachers)))
        line = next(d for d in answer.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert line.params["measured"] == 0
        assert {str(r) for r in line.resource_ids} == set(teachers)

    def test_the_maximums_probe_searches_the_planned_sites(self, monkeypatch) -> None:
        """The maximum's probe keeps the walk, so it searches as solve() does —
        and the maximum, impossible on its own, leads the refusal measured."""
        calls: list[str] = []
        real = SchedulerSolver._solve_on_planned_sites

        def spy(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            calls.append(kwargs.get("what", "the planned sites"))
            return real(self, *args, **kwargs)

        monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", spy)
        payload, _teachers = self._across_families()
        _solver, _request, response = _solve(payload, SCHEDULE_DAY_END_MINUTES=660)
        assert response.status == "INFEASIBLE"
        assert response.conflicts.conflicts[0].code == "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"
        assert response.conflicts.conflicts[0].params["measured"] in (1, 2)
        assert "the daily maximum probe on planned sites" in calls

    def test_a_refusal_the_walk_alone_causes_is_explained(self) -> None:
        """The review's tight week, its walk at 40: impossible by the walk alone,
        and with the objective in the explaining solve it reached the school
        with no cause at all. Explained without it, the walk is named, measured."""
        data = json.loads((Path(__file__).parent / "data" / "travel_tight_3070_walk40.json").read_text())
        # The production budgets: the explanation's two tries take their
        # share of the solve's, and the verdict needs what is left.
        solver = SchedulerSolver(Settings(  # type: ignore[arg-type]
            SOLVER_MAX_TIME_SECONDS=60.0, SOLVER_PROBE_SECONDS=20.0, **data["settings"],
        ))
        request = OptimizeScheduleRequest.model_validate(data["payload"])
        response = solver.solve(request)
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        lines = [d for d in response.conflicts.conflicts if d.code.endswith("TRAVEL_CANNOT_BE_KEPT")]
        assert lines and all(line.params["measured"] == 1 for line in lines)
        # And no room line: the school has every room the week asks for.
        assert not [d for d in response.conflicts.conflicts if d.code.startswith("ROOM_NO_ROOM")]

    def test_an_explanation_with_no_core_tries_the_week_without_the_walk(self, monkeypatch) -> None:
        """Where the explaining solve names nothing, the week is solved without
        the walk, as without the blocks: a timetable names whom it leaves short."""
        import app.solver.scheduler_solver as module

        monkeypatch.setattr(module, "build_conflict_analysis", lambda *_args, **_kwargs: None)
        _solver, _request, response = _solve(
            _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
            **TIGHT_DAY,
        )
        assert response.status == "INFEASIBLE"
        assert response.conflicts.summary_code == "TRAVEL_PROBE_SUMMARY"
        line = next(d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT")
        assert line.params["measured"] == 1
        assert [str(r) for r in line.resource_ids] == [TEACHER]

    def test_a_room_line_stands_only_where_opening_its_room_restores_the_week(self) -> None:
        """Beside a walk measured 1: opening the lab lesson's room puts it in the
        gym at Södra beside the teacher's other lesson, and the week has its
        timetable — that line stands. Opening a third class's lab lesson,
        which no walk touches, changes nothing — that line goes."""
        payload = _payload([
            _requirement(GROUP, kind="LAB"),
            _requirement(OTHER_GROUP, kind="GYM"),
            _requirement(str(uuid4()), teacher=OTHER_TEACHER, kind="LAB"),
        ])
        request = OptimizeScheduleRequest.model_validate(payload)
        solver = SchedulerSolver(_settings(**TIGHT_DAY))
        walking_lab, _gym, third = request.requirements

        def room_line(requirement):  # noqa: ANN001, ANN202
            return ConflictDetail(
                category="ROOM_CAPACITY", code="ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT",
                params={"requirement": str(requirement.id), "groupSize": 24,
                        "roomType": str(requirement.required_room_type)},
                requirement_ids=[requirement.id],
            )

        answer = solver._travel_verdict(
            request, _core(request, ("TEACHER", [TEACHER]), extra=[room_line(walking_lab), room_line(third)]),
        )
        standing = {d.requirement_ids[0] for d in answer.conflicts if d.code.startswith("ROOM_NO_ROOM")}
        assert standing == {walking_lab.id}

    @staticmethod
    def _review(name: str) -> tuple[dict, OptimizeScheduleRequest, object]:
        data = json.loads((Path(__file__).parent / "data" / f"review2_{name}.json").read_text())
        solver = SchedulerSolver(_settings(**data["settings"]))
        request = OptimizeScheduleRequest.model_validate(data["payload"])
        return data, request, solver.solve(request)

    def test_a_genuine_second_cause_is_named_beside_a_walk_measured_two(self) -> None:
        """The teacher's walk between two locks, and two lab hours for one lab:
        impossible without the walk too. The lab's lines are measured against
        the week without the walk, where opening either restores it: they stand."""
        _data, _request, response = self._review("roomline_measured2_week")
        codes = [(d.code, d.params.get("measured")) for d in response.conflicts.conflicts]
        assert ("TEACHER_TRAVEL_CANNOT_BE_KEPT", 2) in codes
        assert any(code == "ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT" for code, _ in codes)

    def test_a_room_line_that_restores_the_week_is_not_hidden(self) -> None:
        data, _request, response = self._review("roomline_hidden_tight_233")
        assert data["requirement"] in {
            str(rid) for d in response.conflicts.conflicts
            if d.code.startswith("ROOM_NO_ROOM") for rid in d.requirement_ids
        }

    def test_nothing_unmeasured_stands_beside_a_walk_measured_one(self) -> None:
        """A lunch's and a block's lines sat beside the walk's on a week the
        walk alone made impossible."""
        _data, _request, response = self._review("lunch_line_next_to_measured1_any_block1247")
        lines = response.conflicts.conflicts
        assert any(d.code.endswith("TRAVEL_CANNOT_BE_KEPT") and d.params["measured"] == 1 for d in lines)
        assert not [d for d in lines if d.code.startswith(("LUNCH_", "BLOCK_"))]

    def test_a_party_the_caps_left_unanswered_keeps_its_line(self) -> None:
        """The pupils' families measured 2, the teacher's not answered inside its
        cap: the teacher's line stays as the core gave it, measured 0."""
        _data, _request, response = self._review("caps_drop_teacher_line_tight151")
        teacher = [d for d in response.conflicts.conflicts if d.code == "TEACHER_TRAVEL_CANNOT_BE_KEPT"]
        assert teacher and teacher[0].params["measured"] == 0

    def test_a_party_the_timetable_names_gets_its_line(self, monkeypatch) -> None:
        """The core held the teachers only; the timetable without the walk also
        leaves a group short, and that group gets the pupils' line."""
        import app.solver.scheduler_solver as module

        monkeypatch.setattr(
            module, "breached",
            lambda *_args, **_kwargs: {"TEACHER": [UUID(TEACHER)], "PUPILS": [UUID(GROUP)]},
        )
        _solver, _request, response = _solve(
            _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
            **TIGHT_DAY,
        )
        assert response.status == "INFEASIBLE"
        pupils = next(d for d in response.conflicts.conflicts if d.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT")
        assert pupils.params == {"stepMinutes": 60, "measured": 1}
        assert pupils.category == "GROUP_OVERLAP"
        assert [str(r) for r in pupils.resource_ids] == [GROUP]

    def test_the_sentence_names_the_step(self) -> None:
        text = render("TEACHER_TRAVEL_CANNOT_BE_KEPT", {"stepMinutes": 30, "measured": 1})
        assert "whole start steps of 30 min" in text

    def test_no_branch_says_a_named_teacher_cannot_keep_it(self) -> None:
        # A line measured 1 names whoever one timetable WITHOUT the walk
        # leaves short, and one measured 0 whoever the core holds: neither
        # proves any of them could not keep it, so only the rule is stated
        # ahead of the branch, and only branch 2 — measured alone — says the
        # walk cannot be fitted for those named.
        for code in ("TEACHER_TRAVEL_CANNOT_BE_KEPT", "PUPILS_TRAVEL_CANNOT_BE_KEPT"):
            for measured in (0, 1):
                text = render(code, {"stepMinutes": 30, "measured": measured})
                assert "cannot be kept" not in text
                assert "cannot be placed" not in text
            assert "cannot be placed" in render(code, {"stepMinutes": 30, "measured": 2})


# ---------------------------------------------------------------------------
# The timeout probe.
# ---------------------------------------------------------------------------


def test_the_timeout_probe_tries_the_week_without_the_walk() -> None:
    request = OptimizeScheduleRequest.model_validate(
        _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
    )
    solver = SchedulerSolver(_settings(**ONE_DAY))
    codes = [code for code, _relaxed in solver._timeout_relaxations(request)]
    assert "PROBE_SOLVED_WITHOUT_TRAVEL" in codes
    relaxed = dict(solver._timeout_relaxations(request))["PROBE_SOLVED_WITHOUT_TRAVEL"]
    assert relaxed.site_travel_times == []


def test_a_timeout_with_the_walk_on_probes_the_walk_first_and_names_it_unmeasured(monkeypatch) -> None:
    """Nothing helped, the walk's probe included: the walk is still named, as
    the rule this school turned on that nothing measured, and probed first.
    The line carries the walk probe's own seconds, and the summary names no
    time per rule — the walk's probe had more than the others (the review's
    2,000-pupil week: 19 s against a summary saying 10 s per rule)."""
    probed: list[bool] = []

    def nothing(self, request, *_args, **_kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        probed.append(request.site_travel_times == [])
        if request.site_travel_times == []:
            time.sleep(0.3)
        return cp_model.UNKNOWN, None

    monkeypatch.setattr(SchedulerSolver, "_probe_search", nothing)
    payload = _payload([_requirement(GROUP, kind="LAB", minutes_before=10), _requirement(OTHER_GROUP, kind="GYM")])
    request = OptimizeScheduleRequest.model_validate(payload)
    analysis = SchedulerSolver(_settings(**ONE_DAY))._probe_timeout(request)
    assert analysis.summary_code == "PROBE_NOTHING_HELPED_WITH_TRAVEL"
    assert analysis.summary_params == {"budget": 10, "rules": len(probed)}
    assert probed[0] is True and len(probed) >= 2
    assert [d.code for d in analysis.conflicts] == ["PROBE_TRAVEL_UNMEASURED"]
    assert 0.3 <= analysis.conflicts[0].params["seconds"] < 1.5


def test_the_walk_line_claims_nothing_its_probe_did_not_measure() -> None:
    """The review's 2,000-pupil week runs out of time with the walk off as
    well (82.9 s), so the line may not say the walk is likely why: only that
    the rule is on, that a search without it found nothing in its time, and
    how to measure the rest. In both languages."""
    english = render("PROBE_TRAVEL_UNMEASURED", {"seconds": 18.7})
    assert english.startswith("The travel time between the school's sites is turned on.")
    assert "Searching without it for 18.7 s did not find a timetable either" in english
    for claim in ("likely", "why", "harder", "may need"):
        assert claim not in english
    root = Path(__file__).resolve().parents[2]
    swedish = json.loads((root / "web/messages/sv.json").read_text(encoding="utf-8"))["engineMessages"]
    for code in ("PROBE_TRAVEL_UNMEASURED", "PROBE_NOTHING_HELPED_WITH_TRAVEL"):
        for claim in ("troligen", "därför", "svårare"):
            assert claim not in swedish[code]


def test_a_walk_probe_that_proves_the_week_impossible_names_no_walk(monkeypatch) -> None:
    """Without the walk the week has no timetable either: that measured the
    walk is not the difference, and no line says it might be."""
    monkeypatch.setattr(
        SchedulerSolver, "_probe_search",
        lambda self, request, *_a, **_k: (
            cp_model.INFEASIBLE if request.site_travel_times == [] else cp_model.UNKNOWN, None,
        ),
    )
    payload = _payload([_requirement(GROUP, kind="LAB", minutes_before=10), _requirement(OTHER_GROUP, kind="GYM")])
    analysis = SchedulerSolver(_settings(**ONE_DAY))._probe_timeout(
        OptimizeScheduleRequest.model_validate(payload), deadline=time.monotonic() + 30,
    )
    assert analysis.summary_code == "PROBE_NOTHING_HELPED_WITH_TRAVEL"
    assert analysis.conflicts == []


def test_a_timeout_without_the_walk_is_probed_as_it_was(monkeypatch) -> None:
    monkeypatch.setattr(SchedulerSolver, "_probe_search", lambda *_a, **_k: (cp_model.UNKNOWN, None))
    payload = _payload([_requirement(GROUP, kind="LAB", minutes_before=10)], walk=None)
    analysis = SchedulerSolver(_settings(**ONE_DAY))._probe_timeout(
        OptimizeScheduleRequest.model_validate(payload),
    )
    assert analysis.summary_code == "PROBE_NOTHING_HELPED"
    assert analysis.conflicts == []


def test_the_timeout_probes_stop_at_the_deadline(monkeypatch) -> None:
    """Past the deadline no probe starts, and nothing is said about probes
    that never ran: the TIMEOUT stands bare, as where probes are off."""
    searched: list[object] = []
    monkeypatch.setattr(
        SchedulerSolver, "_probe_search", lambda *_a, **_k: searched.append(1) or (cp_model.UNKNOWN, None),
    )
    request = OptimizeScheduleRequest.model_validate(
        _payload([_requirement(GROUP, kind="LAB", minutes_before=10), _requirement(OTHER_GROUP, kind="GYM")]),
    )
    assert SchedulerSolver(_settings(**ONE_DAY))._probe_timeout(request, deadline=time.monotonic()) is None
    assert searched == []


@pytest.mark.parametrize("walk", [WALK, None])
def test_solve_bounds_the_timeout_probes_only_where_the_walk_is_kept(monkeypatch, walk) -> None:
    """With the walk the timeout probes get a deadline counted from the
    request's arrival, builds included; without it, the probes they always had."""
    import app.solver.scheduler_solver as module

    seen: list[object] = []
    real = module._solve_guarded

    def out_of_time(solver, model, *, what, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if what in ("phase 1a", "phase 1b"):
            return cp_model.UNKNOWN
        return real(solver, model, what=what, **kwargs)

    monkeypatch.setattr(module, "_solve_guarded", out_of_time)
    monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", lambda *_a, **_k: None)
    monkeypatch.setattr(
        SchedulerSolver, "_probe_timeout",
        lambda self, request, **kwargs: seen.append(kwargs.get("deadline")),
    )
    payload = _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")], walk=walk)
    _solver, _request, response = _solve(payload)
    assert response.status == "TIMEOUT"
    assert (seen[0] is not None) is (walk is not None)


def test_slow_builds_on_a_short_budget_time_out_rather_than_fail(monkeypatch) -> None:
    """With the walk the builds count against the budget; builds that eat it
    all leave phase 1a nothing, and nothing is a TIMEOUT — never a negative
    time limit, which CP-SAT calls MODEL_INVALID and the API answers with 500
    (the review's 2,000-pupil week on a ten-second candidate)."""
    real = SchedulerSolver._build_model

    def slow(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        time.sleep(0.6)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", slow)
    solver = SchedulerSolver(Settings(  # type: ignore[arg-type]
        SOLVER_MAX_TIME_SECONDS=1.0, SOLVER_PROBE_SECONDS=0.0, **ONE_DAY,
    ))
    request = OptimizeScheduleRequest.model_validate(
        _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
    )
    assert solver.solve(request).status == "TIMEOUT"


def test_builds_that_eat_the_probes_time_leave_the_timeout_bare(monkeypatch) -> None:
    """The review's slow setup (SLOW_SETUP=12 on a five-second candidate):
    the builds take the probes' time too, no probe runs, and the answer was
    "none of the 0 rules probed" beside "searching without it for 0 s". Now
    the TIMEOUT carries no sentence about searches that never happened."""
    real = SchedulerSolver._build_model

    def slow(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        time.sleep(1.1)
        return real(self, *args, **kwargs)

    searched: list[object] = []
    monkeypatch.setattr(SchedulerSolver, "_build_model", slow)
    monkeypatch.setattr(
        SchedulerSolver, "_probe_search", lambda *_a, **_k: searched.append(1) or (cp_model.UNKNOWN, None),
    )
    solver = SchedulerSolver(Settings(  # type: ignore[arg-type]
        SOLVER_MAX_TIME_SECONDS=1.0, SOLVER_PROBE_SECONDS=1.0, **ONE_DAY,
    ))
    request = OptimizeScheduleRequest.model_validate(
        _payload([_requirement(GROUP, kind="LAB"), _requirement(OTHER_GROUP, kind="GYM")]),
    )
    response = solver.solve(request)
    assert response.status == "TIMEOUT"
    assert searched == []
    assert response.conflicts is None


def test_the_estimate_stays_an_upper_bound_with_the_walk() -> None:
    payload = _payload(
        [
            _requirement(GROUP, kind="LAB", lessons=2),
            _requirement(OTHER_GROUP, lessons=2),
            _requirement(GROUP, teacher=OTHER_TEACHER, lessons=1),
        ],
        # Two classes on no site (a plain room and a lab), so a lesson has a
        # literal for "no counted site" too.
        rooms=[
            _room("LAB", NORRA), _room(None, NORRA), _room(None, SODRA), _room("GYM", SODRA),
            _room(None, None), _room("LAB", None),
        ],
        conflicts=[(GROUP, OTHER_GROUP)],
    )
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2", SCHEDULE_DAY_END_MINUTES=720))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    assert len(model.Proto().variables) <= solver._estimate_model_size(request)


def test_rooms_come_back_on_the_site_the_model_chose() -> None:
    """Each class stands on one site, so the post-pass never hands out the other one."""
    rooms = [_room(None, NORRA), _room(None, NORRA), _room(None, SODRA), _room(None, SODRA)]
    payload = _payload(
        [
            _requirement(GROUP, lessons=2),
            _requirement(OTHER_GROUP, teacher=OTHER_TEACHER, lessons=2),
        ],
        rooms=rooms,
        conflicts=[(GROUP, OTHER_GROUP)],
    )
    # Four hours for the four lessons the shared pupils have between them.
    _solver, request, response = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720)
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert _travel_problems(request, response.lessons) == []
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720))
    _model, _registry, _decisions, plan, _lunch = solver._build_model(
        request, use_assumptions=False, include_objective=False,
    )
    site_of = {room["id"]: room["siteId"] for room in rooms}
    for room_class in plan.classes:
        assert len({site_of[str(request.rooms[i].id)] for i in room_class.room_indices}) == 1


# ---------------------------------------------------------------------------
# The planned sites: the search's help, never a verdict.
# ---------------------------------------------------------------------------


def _two_classes_on_plain_rooms() -> dict[str, object]:
    """Two classes sharing a teacher, every room plain, two on each site: every
    lesson chooses its site, and the walk decides how the day can mix them."""
    return _payload(
        [
            _requirement(GROUP, lessons=2),
            _requirement(OTHER_GROUP, lessons=2),
        ],
        rooms=[_room(None, NORRA), _room(None, NORRA), _room(None, SODRA), _room(None, SODRA)],
    )


def _plan_solver() -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5.0
    solver.parameters.num_workers = 1
    return solver


class TestThePlannedSites:
    def test_the_plan_keeps_a_teacher_on_one_site_when_the_rooms_allow(self) -> None:

        request = OptimizeScheduleRequest.model_validate(_two_classes_on_plain_rooms())
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720))
        _model, _registry, decisions, plan, _lunch = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        planned = site_plan(
            decisions, plan, families_of(decisions, request.group_conflicts), {},
            {index: 1000 for index in range(len(plan.classes))},
            solver=_plan_solver(),
            solve=lambda cp, model: _solve_guarded(cp, model, what="test", request_id=request.request_id),
        )
        assert planned is not None
        sites, away = planned
        # One teacher, two groups: every lesson on one site, none away.
        assert len(set(sites.values())) == 1
        assert away == 0

    def test_the_rooms_week_splits_the_plan_when_one_site_cannot_hold_it(self) -> None:

        request = OptimizeScheduleRequest.model_validate(_two_classes_on_plain_rooms())
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720))
        _model, _registry, decisions, plan, _lunch = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        # Each class's rooms can hold three of the four lessons' twelve slots.
        planned = site_plan(
            decisions, plan, families_of(decisions, request.group_conflicts), {},
            {index: 18 for index in range(len(plan.classes))},
            solver=_plan_solver(),
            solve=lambda cp, model: _solve_guarded(cp, model, what="test", request_id=request.request_id),
        )
        assert planned is not None
        assert len(set(planned[0].values())) == 2

    def test_groups_sharing_a_pupil_are_planned_on_one_site(self) -> None:
        """A ring of five groups, each sharing pupils with its two neighbours, one
        lesson each: every split costs a group nothing, so only the pairs' own
        homes keep a pair from being split across the sites."""
        groups = [str(uuid4()) for _ in range(5)]
        ring = [(groups[i], groups[(i + 1) % 5]) for i in range(5)]
        payload = _payload(
            [_requirement(group, teacher=str(uuid4())) for group in groups],
            rooms=[_room(None, NORRA) for _ in range(5)] + [_room(None, SODRA) for _ in range(5)],
            conflicts=ring,
        )
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=660))
        request = OptimizeScheduleRequest.model_validate(payload)
        _model, _registry, decisions, plan, _lunch = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        planned = site_plan(
            decisions, plan, families_of(decisions, request.group_conflicts), {},
            {index: 1000 for index in range(len(plan.classes))},
            solver=_plan_solver(),
            solve=lambda cp, model: _solve_guarded(cp, model, what="test", request_id=request.request_id),
        )
        assert planned is not None
        site_of_group = {
            str(d.lesson.requirement.student_group_id): planned[0][d.lesson.key()] for d in decisions
        }
        assert all(site_of_group[a] == site_of_group[b] for a, b in ring)
        assert planned[1] == 0

    def test_a_room_the_locks_fill_is_not_planned_full(self, monkeypatch) -> None:
        """The one room at Norra is locked from 09:00 to 12:00 by other lessons,
        and the teacher's own lock there pulls them home: planned as if the
        room were open all day, both lessons went to it and the week on those
        sites was impossible. Read as the room's week holds it, they go to
        Södra, and the planned sites find the week."""
        calls: list[str] = []
        real = SchedulerSolver._solve_on_planned_sites

        def spy(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            found = real(self, *args, **kwargs)
            calls.append("found" if found is not None else "none")
            return found

        monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", spy)
        north, south = _room(None, NORRA), _room(None, SODRA)
        payload = _payload(
            [_requirement(GROUP, lessons=2)],
            rooms=[north, south],
            fixed=[
                _locked("09:00:00", "10:00:00", north, teacher=str(uuid4())),
                _locked("10:00:00", "11:00:00", north, teacher=str(uuid4())),
                _locked("11:00:00", "12:00:00", north),
            ],
        )
        _solver, request, response = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720)
        assert calls == ["found"]
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _travel_problems(request, response.lessons) == []

    def test_a_week_that_keeps_the_walk_is_searched_on_planned_sites_first(self, monkeypatch) -> None:
        """The planned sites come before the free search, and find the week."""
        calls: list[str] = []
        real = SchedulerSolver._solve_on_planned_sites

        def spy(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            found = real(self, *args, **kwargs)
            calls.append("found" if found is not None else "none")
            return found

        monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", spy)
        _solver, request, response = _solve(
            _two_classes_on_plain_rooms(), SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720,
        )
        assert calls == ["found"]
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 4
        assert _travel_problems(request, response.lessons) == []

    def test_a_bad_plan_is_no_refusal(self, monkeypatch) -> None:
        """Sites planned so the walk cannot fit: the free search still finds the week."""
        import app.solver.scheduler_solver as module


        def contrary(decisions, plan, *_args, **_kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            # The teacher's lessons alternate sites in build order: on a day
            # that holds them only back to back, no timetable keeps it.
            sites = sorted({site for site in plan.class_sites if site is not None}, key=str)
            return {d.lesson.key(): sites[i % 2] for i, d in enumerate(decisions)}, 0

        monkeypatch.setattr(module, "site_plan", contrary)
        payload = _payload(
            [_requirement(GROUP, lessons=2), _requirement(OTHER_GROUP, lessons=2)],
            rooms=[_room(None, NORRA), _room(None, NORRA), _room(None, SODRA), _room(None, SODRA)],
        )
        _solver, request, response = _solve(payload, SCHEDULE_DAYS="1", SCHEDULE_DAY_END_MINUTES=720)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _travel_problems(request, response.lessons) == []
