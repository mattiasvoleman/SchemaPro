"""Sammanhängande undervisning: at most X minutes of teaching in a row, then Y free — as a wish.

THE ORACLE IS THE POINT. A short week — one teacher, a handful of lessons on a
four-hour day — is small enough to try EVERY placement of the lessons, and for
each one the full model must price what the definition says: with the lessons
pinned, the objective is the weight times the number of lessons that do NOT
have a free break of Y minutes somewhere between their end and X minutes after
their start. A model that charges a lesson whose stretch is fine is a school
whose timetable is bent for nothing, and one that lets a long stretch go free
is a wish that holds nothing. The definition below shares no code with
app/solver/consecutive.py; stretch_breaches (benchmarks/validate_schedule.py)
is a third reading of it and is replayed against the fixture the gateway's
src/common/stretch.ts replays too.

A WISH IS NEVER A REFUSAL, and the satisfaction phase builds nothing for it:
both are pinned below, the second down to the byte.

THE SCAFFOLDING IS test_teacher_day.py's: 08:00-... days of 60-minute lessons
make every case arithmetic a reader can do in their head.
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.consecutive import merge_windows
from app.solver.scheduler_solver import SchedulerSolver, _start_step

BENCHMARKS = Path(__file__).resolve().parents[1] / "benchmarks"
if str(BENCHMARKS) not in sys.path:
    sys.path.insert(0, str(BENCHMARKS))

from validate_schedule import stretch_breaches  # noqa: E402

TEACHER = str(uuid4())
RULE = str(uuid4())

#: Every other term of the objective off, so that what is left is the wish.
QUIET = {
    "WEIGHT_TEACHER_GAP": 0,
    "WEIGHT_SPREAD": 0,
    "WEIGHT_DISRUPTION": 0,
    "WEIGHT_LUNCH_DRIFT": 0,
    "WEIGHT_ROOM_PREFERENCE": 0,
    "WEIGHT_DATE_UNAVAILABLE": 0,
}


def _settings(*, day_end: int = 720, days: str = "1", **overrides: object) -> Settings:
    return Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=10.0,
        SCHEDULE_DAYS=days,
        SCHEDULE_DAY_END_MINUTES=day_end,
        **overrides,
    )


#: What the wish pays for a lesson: the setting's own default.
WEIGHT = _settings().weight_consecutive_teaching


def _payload(
    *,
    limit: int | None,
    pause: int | None,
    lengths: list[int],
    locked: list[tuple[str, str]] | None = None,
    recurrence: list[str | None] | None = None,
) -> dict[str, object]:
    """One teacher with one requirement per lesson, each in a class of its own."""
    requirements = []
    for index, minutes in enumerate(lengths):
        requirements.append({
            "id": str(uuid4()),
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": TEACHER,
            "lessonsPerWeek": 1,
            "minutesPerLesson": minutes,
            "studentGroupSize": 20,
            **({"recurrence": recurrence[index]} if recurrence and recurrence[index] else {}),
        })
    rule: dict[str, object] = {"id": RULE, "teacherId": TEACHER}
    if limit is not None:
        rule["maxConsecutiveTeachingMinutes"] = limit
        rule["consecutiveBreakMinutes"] = pause
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in lengths],
        "fixedLessons": [
            {
                "id": str(uuid4()),
                "teacherId": TEACHER,
                "studentGroupId": str(uuid4()),
                "dayOfWeek": 1,
                "startTime": f"{start}:00",
                "endTime": f"{end}:00",
            }
            for start, end in (locked or [])
        ],
        "teacherWorkRules": [rule],
    }


def _build(payload: dict[str, object], *, objective: bool, **settings: object):
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    return solver, request, solver._build_model(
        request, use_assumptions=False, include_objective=objective,
    )


def _minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:5])


def _cost(solver, model, decisions, starts: list[int]) -> int | None:
    """The objective with these lessons pinned to these start slots (day 0), or None if infeasible."""
    clone = model.Clone()
    for decision, start in zip(decisions, starts):
        clone.Add(decision.start == start)
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10
    status = cp.Solve(clone)
    assert status != cp_model.MODEL_INVALID, clone.Validate()
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    return round(cp.ObjectiveValue())


def _read(
    solver, decisions, starts: list[int], limit: int, pause: int, locked: list[tuple[int, int]],
) -> tuple[int, bool] | None:
    """The definition, from the module docstring, on minutes and nothing else.

    None when two lessons overlap (the teacher is in one room at a time).
    Otherwise (the number of the solver's lessons with no free break of `pause`
    minutes beginning between their end and `limit` minutes after their start,
    whether some stretch with one of the solver's lessons in it is longer than
    `limit`). The night counts as free: a break may begin at the end of the day.
    """
    slot = solver._grid.slot_minutes
    base = solver._grid.day_start_minutes
    day_end = base + solver._grid.slots_per_day * slot
    placed = [
        (base + start * slot, base + (start + decision.duration) * slot)
        for decision, start in zip(decisions, starts)
    ]
    busy = sorted(placed + locked)
    for (_s1, e1), (s2, _e2) in zip(busy, busy[1:]):
        if s2 < e1:
            return None

    def free(begin: int) -> bool:
        return begin <= day_end and all(
            end <= begin or start >= begin + pause or start >= day_end
            for start, end in busy
        )

    unkept = sum(
        not any(free(begin) for begin in range(end, start + limit + 1, 5))
        for start, end in placed
    )
    violated = False
    stretch = None  # [first start, latest end, holds a placed lesson]
    for start, end in busy:
        is_placed = (start, end) in placed
        if stretch is not None and start - stretch[1] < pause:
            stretch[1] = max(stretch[1], end)
            stretch[2] = stretch[2] or is_placed
        else:
            if stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit:
                violated = True
            stretch = [start, end, is_placed]
    if stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit:
        violated = True
    return unkept, violated


def _digest(model: cp_model.CpModel, tmp_path: Path) -> bytes:
    """The model's own bytes, as benchmarks/model_identity.py compares models."""
    path = tmp_path / f"{uuid4()}.pbtxt"
    assert model.ExportToFile(str(path))
    return path.read_bytes()


class TestHelpers:
    def test_merge_windows_merges_touching_windows_within_a_day_only(self) -> None:
        assert merge_windows([(0, 12), (12, 18), (30, 36)], 120) == [(0, 18), (30, 36)]
        assert merge_windows([(108, 120), (120, 132)], 120) == [(108, 120), (120, 132)]


CASES = [
    # (limit, pause, lengths, locked windows (hh:mm, hh:mm))
    (120, 30, [60, 60, 60], []),
    (120, 15, [60, 60, 60], []),
    # Lessons of 40 and 80 minutes on a 30-minute start step: their ends fall
    # between two steps, and the free time begins there.
    (120, 30, [40, 60, 80], []),
    (90, 15, [40, 40, 40], []),
    (120, 30, [60, 60], [("10:00", "11:00")]),
    # A locked stretch already at the limit: the lesson that joins it pays, the
    # one half an hour later does not.
    (90, 30, [60], [("08:00", "09:30")]),
    # Two locks ten minutes apart are one stretch of two hours: the lesson of an
    # hour and a half that joins it makes 210 minutes, and one half an hour
    # later does not join it.
    (180, 30, [90], [("08:00", "09:00"), ("09:10", "10:00")]),
    # A locked stretch longer than the limit: the lesson that joins it is part
    # of a stretch over the limit, and one that keeps its distance is not.
    (90, 30, [60], [("08:00", "10:00")]),
    # The break is not a whole number of start steps, so the starts the lesson
    # may take cannot be confined to the lattice of the others.
    (120, 15, [40, 60, 80], []),
    (150, 20, [40, 40, 80], []),
    # A limit one slot off a boundary: three lessons of 35 minutes with five
    # free between two of them are one stretch of exactly X + 5, which is over,
    # and without the five minutes one of exactly X, which is not.
    (100, 10, [50, 50, 50], []),
    (105, 10, [35, 35, 35], []),
    # Locked windows Y - 5 apart are one stretch (exactly Y apart: SILENT_CASES).
    (120, 30, [60], [("08:00", "09:00"), ("09:25", "10:25")]),
    # A lock that ends between two steps.
    (90, 15, [45], [("08:07", "09:00")]),
]


def _check_every_placement(
    limit: int, pause: int, lengths: list[int], locked: list[tuple[str, str]],
) -> tuple[int, int]:
    """(placements tried, placements charged): every one agrees with the definition."""
    payload = _payload(limit=limit, pause=pause, lengths=lengths, locked=locked)
    solver, request, (model, _registry, decisions, *_rest) = _build(
        payload, objective=True, **QUIET,
    )
    spd = solver._grid.slots_per_day
    slot = solver._grid.slot_minutes
    windows = [(_minutes(start), _minutes(end)) for start, end in locked]
    grid = range(0, spd, _start_step(request, solver._grid))
    tried = priced = 0
    for starts in itertools.product(grid, repeat=len(decisions)):
        if any(
            start + decision.duration > spd for decision, start in zip(decisions, starts)
        ):
            continue
        read = _read(solver, decisions, list(starts), limit, pause, windows)
        got = _cost(solver, model, decisions, list(starts))
        where = [solver._grid.day_start_minutes + s * slot for s in starts]
        if read is None:
            assert got is None, f"placement {where}: the teacher is in two rooms, the model took it"
            continue
        unkept, violated = read
        assert got is not None, f"placement {where}: the wish refused a week"
        # Free exactly when no stretch with one of the solver's lessons in it
        # is over the limit.
        assert (got > 0) == violated, (
            f"placement {where} limit {limit} break {pause}: the model charges {got}, "
            f"the definition says a stretch is over: {violated}"
        )
        if not windows:
            # With nothing locked, every lesson that begins an over-long stretch
            # pays, and each pays the weight.
            assert (unkept > 0) == violated
            assert got == unkept * WEIGHT, (
                f"placement {where} limit {limit} break {pause}: the model charges {got}, "
                f"the definition {unkept} lessons x {WEIGHT}"
            )
        tried += 1
        priced += violated
    return tried, priced


@pytest.mark.parametrize(("limit", "pause", "lengths", "locked"), CASES)
def test_every_placement_is_priced_as_the_definition_prices_it(
    limit: int, pause: int, lengths: list[int], locked: list[tuple[str, str]],
) -> None:
    tried, priced = _check_every_placement(limit, pause, lengths, locked)
    assert tried > 0
    # The wish must bind for the case to prove anything: some placement the
    # teacher's own no-overlap allows is charged, and some is not.
    assert 0 < priced < tried


#: Cases the definition never charges, which the model must not charge either.
#: What they hold apart is a mutant that reads the break wrongly: locks exactly
#: Y apart are two stretches of an hour, and the lesson that joins one makes
#: exactly X; read as one stretch of 150 minutes they would charge it.
SILENT_CASES = [
    (120, 30, [60], [("08:00", "09:00"), ("09:30", "10:30")]),
]


@pytest.mark.parametrize(("limit", "pause", "lengths", "locked"), SILENT_CASES)
def test_a_placement_no_stretch_of_which_is_over_is_never_charged(
    limit: int, pause: int, lengths: list[int], locked: list[tuple[str, str]],
) -> None:
    tried, priced = _check_every_placement(limit, pause, lengths, locked)
    assert tried > 0
    assert priced == 0


def _read_days(
    solver, decisions, recurrence: list[str | None], starts: list[int], limit: int, pause: int,
    locked: list[tuple[int, int, int]],
) -> bool | None:
    """The definition on minutes, day by day, week by week, for placements over several days.

    `starts` are absolute slots (a day is `slots_per_day` of them) and `locked`
    are (weekday index, start minute, end minute). None when two lessons of one
    week overlap; otherwise whether a stretch with one of the solver's lessons
    in it is over the limit. The night ends a stretch: the days are read apart,
    and an odd week's lessons are not beside an even week's.
    """
    per_day = solver._grid.slots_per_day
    slot = solver._grid.slot_minutes
    base = solver._grid.day_start_minutes
    placed = []
    for decision, week, start in zip(decisions, recurrence, starts):
        day, offset = divmod(start, per_day)
        placed.append((day, week, base + offset * slot, base + (offset + decision.duration) * slot))
    violated = False
    for week in ("ODD_WEEKS", "EVEN_WEEKS"):
        mine = [(day, a, b) for day, kind, a, b in placed if kind in (None, week)]
        runs = mine + list(locked)
        for day in sorted({run[0] for run in runs}):
            windows = sorted((a, b) for d, a, b in runs if d == day)
            for (_s1, e1), (s2, _e2) in zip(windows, windows[1:]):
                if s2 < e1:
                    return None
            held = {(a, b) for d, a, b in mine if d == day}
            stretch = None  # [first start, latest end, holds a placed lesson]
            for window in windows:
                if stretch is not None and window[0] - stretch[1] < pause:
                    stretch[1] = max(stretch[1], window[1])
                    stretch[2] = stretch[2] or window in held
                else:
                    if stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit:
                        violated = True
                    stretch = [window[0], window[1], window in held]
            if stretch is not None and stretch[2] and stretch[1] - stretch[0] > limit:
                violated = True
    return violated


#: (limit, pause, lengths, recurrence, locks as (weekday index, start, end)).
#: Two four-hour days: a clock that restarted each morning and a clock that ran
#: on through the night price these differently, and so do a break that is not
#: a whole number of steps and a lock that ends one day beside one that opens
#: the next.
OVER_DAYS = [
    (90, 30, [60, 60, 60], [None, None, None], []),
    (90, 15, [60, 60, 60], [None, None, None], []),
    (60, 15, [60, 60, 60], ["ODD_WEEKS", None, None], []),
    (90, 30, [60, 60], [None, None], [(0, "11:00", "12:00"), (1, "08:00", "09:00")]),
    (60, 15, [60, 60], [None, None], [(0, "11:00", "12:00"), (1, "08:00", "09:00")]),
    (120, 30, [60, 60], [None, None], [(0, "10:30", "12:00"), (1, "08:00", "09:30")]),
]


def _check_over_days(
    limit: int, pause: int, lengths: list[int], recurrence: list[str | None],
    locks: list[tuple[int, str, str]],
) -> tuple[int, int]:
    """(placements tried, placements charged) over two days: every one agrees with the definition."""
    payload = _payload(
        limit=limit, pause=pause, lengths=lengths, recurrence=recurrence,
        locked=[(start, end) for _day, start, end in locks],
    )
    for fixed, (day, _start, _end) in zip(payload["fixedLessons"], locks):  # type: ignore[arg-type]
        fixed["dayOfWeek"] = day + 1
    windows = [(day, _minutes(start), _minutes(end)) for day, start, end in locks]
    solver, request, (model, _registry, decisions, *_rest) = _build(
        payload, objective=True, days="1,2", **QUIET,
    )
    per_day = solver._grid.slots_per_day
    grid = range(0, 2 * per_day, _start_step(request, solver._grid))
    tried = priced = 0
    for starts in itertools.product(grid, repeat=len(decisions)):
        if any((start % per_day) + decision.duration > per_day for decision, start in zip(decisions, starts)):
            continue
        violated = _read_days(solver, decisions, recurrence, list(starts), limit, pause, windows)
        got = _cost(solver, model, decisions, list(starts))
        if violated is None:
            # A/B: lessons of different weeks may share an hour, which the
            # definition's per-week reading never calls an overlap.
            assert got is None, f"placement {starts}: two lessons of one week overlap, the model took it"
            continue
        assert got is not None, f"placement {starts}: the wish refused a week"
        assert (got > 0) == violated, (
            f"placement {starts} limit {limit} break {pause}: the model charges {got}, "
            f"the definition says a stretch is over: {violated}"
        )
        tried += 1
        priced += violated
    return tried, priced


@pytest.mark.parametrize(("limit", "pause", "lengths", "recurrence", "locks"), OVER_DAYS)
def test_every_placement_over_two_days_is_priced_as_the_definition_prices_it(
    limit: int, pause: int, lengths: list[int], recurrence: list[str | None],
    locks: list[tuple[int, str, str]],
) -> None:
    tried, priced = _check_over_days(limit, pause, lengths, recurrence, locks)
    assert tried > 0
    assert 0 < priced < tried


#: Over two days, never charged: an odd week's lesson is not beside an even
#: week's, so the three hours of lessons that would be one stretch if the weeks
#: were put together are two hours at most in each.
SILENT_OVER_DAYS = [
    (120, 30, [60, 60, 60], ["ODD_WEEKS", "EVEN_WEEKS", None], []),
]


@pytest.mark.parametrize(("limit", "pause", "lengths", "recurrence", "locks"), SILENT_OVER_DAYS)
def test_two_weeks_apart_are_never_charged_as_one_stretch(
    limit: int, pause: int, lengths: list[int], recurrence: list[str | None],
    locks: list[tuple[int, str, str]],
) -> None:
    tried, priced = _check_over_days(limit, pause, lengths, recurrence, locks)
    assert tried > 0
    assert priced == 0


def test_a_limit_as_long_as_the_day_prices_nothing() -> None:
    # X of four hours in a four-hour day: no stretch of the day can pass it.
    payload = _payload(limit=240, pause=30, lengths=[60, 60])
    solver, request, (model, _registry, decisions, *_rest) = _build(payload, objective=True, **QUIET)
    spd = solver._grid.slots_per_day
    for starts in itertools.product(range(0, spd, _start_step(request, solver._grid)), repeat=2):
        if any(start + decision.duration > spd for decision, start in zip(decisions, starts)):
            continue
        assert _cost(solver, model, decisions, list(starts)) in (0, None)


def _fixture_cases() -> list[dict]:
    path = Path(__file__).resolve().parents[2] / "src/common/__fixtures__/stretch-cases.json"
    return json.loads(path.read_text())["cases"]


def _every_week(case: dict) -> bool:
    return all(
        lesson.get("recurrence") in (None, "ALL_WEEKS")
        and lesson.get("startDate") is None
        and lesson.get("endDate") is None
        for lesson in case["lessons"]
    )


def test_the_fixture_has_every_week_cases_to_replay() -> None:
    # A filter that kept nothing would pass the replay below vacuously.
    cases = [case for case in _fixture_cases() if _every_week(case)]
    assert len(cases) >= 9
    assert any(case["breaches"] for case in cases)
    assert any(not case["breaches"] for case in cases)


@pytest.mark.parametrize(
    "case", [case for case in _fixture_cases() if _every_week(case)], ids=lambda case: case["name"],
)
def test_the_checker_reads_the_stretch_as_the_gateway_does(case: dict) -> None:
    """stretch_breaches against the gateway's own verdicts, case by case.

    The engine has no weeks, so the cases about parities and terms are the
    gateway's alone and this checker is held to the rest: the weekday, the
    longest stretch and the limit of each breach.
    """
    rule = case["rule"]
    requirements = []
    lessons = []
    for lesson in case["lessons"]:
        requirement_id = str(uuid4())
        minutes = max(15, _minutes(lesson["end"]) - _minutes(lesson["start"]))
        requirements.append({
            "id": requirement_id,
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": TEACHER,
            "lessonsPerWeek": 1,
            "minutesPerLesson": minutes,
            "studentGroupSize": 24,
        })
        lessons.append({
            "requirementId": requirement_id,
            "roomId": None,
            "dayOfWeek": lesson["dayOfWeek"],
            "startTime": f"{lesson['start']}:00",
            "endTime": f"{lesson['end']}:00",
        })
    payload = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "teacherWorkRules": [],
    }
    if rule["maxConsecutiveTeachingMinutes"] is not None:
        payload["teacherWorkRules"] = [{
            "id": RULE,
            "teacherId": TEACHER,
            "maxConsecutiveTeachingMinutes": rule["maxConsecutiveTeachingMinutes"],
            "consecutiveBreakMinutes": rule["consecutiveBreakMinutes"],
        }]
    request = OptimizeScheduleRequest.model_validate(payload)
    scheduled = [
        type("Scheduled", (), {
            "requirement_id": request.requirements[index].id,
            "teacher_id": None,
            "day_of_week": lesson["dayOfWeek"],
            "start_time": f"{lesson['start']}:00",
            "end_time": f"{lesson['end']}:00",
        })()
        for index, lesson in enumerate(case["lessons"])
    ]
    found = sorted(
        (breach["weekday"], breach["minutes"], breach["limit"])
        for breach in stretch_breaches(request, scheduled)
    )
    expected = sorted(
        (breach["dayOfWeek"], breach["minutes"], breach["max"]) for breach in case["breaches"]
    )
    # The fixture says the LONGEST stretch of a weekday; the checker names every
    # one over the limit, so compare each weekday's longest.
    longest: dict[int, tuple[int, int, int]] = {}
    for weekday, minutes, limit in found:
        if weekday not in longest or minutes > longest[weekday][1]:
            longest[weekday] = (weekday, minutes, limit)
    assert sorted(longest.values()) == expected


class TestAWishIsNeverARefusal:
    def test_the_satisfaction_model_is_the_one_a_school_without_the_rule_gets(self, tmp_path: Path) -> None:
        # Byte for byte: the teacher is flagged, has lessons to place, and the
        # model the first solution is found in does not know it.
        plain = _payload(limit=None, pause=None, lengths=[60, 60, 60])
        flagged = _payload(limit=120, pause=30, lengths=[60, 60, 60])
        flagged["requirements"] = plain["requirements"]
        flagged["rooms"] = plain["rooms"]
        flagged["requestId"] = plain["requestId"]
        flagged["academicYearId"] = plain["academicYearId"]
        plain["teacherWorkRules"] = []
        _solver, _request, (without, *_rest) = _build(plain, objective=False)
        _solver, _request, (with_rule, *_rest) = _build(flagged, objective=False)
        assert _digest(with_rule, tmp_path) == _digest(without, tmp_path)

    def test_the_full_model_pays_for_it_and_only_the_full_model(self) -> None:
        plain = _payload(limit=None, pause=None, lengths=[60, 60, 60])
        flagged = _payload(limit=120, pause=30, lengths=[60, 60, 60])
        flagged["requirements"] = plain["requirements"]
        flagged["rooms"] = plain["rooms"]
        plain["teacherWorkRules"] = []
        _solver, _request, (without, *_rest) = _build(plain, objective=True)
        _solver, _request, (with_rule, *_rest) = _build(flagged, objective=True)
        assert len(with_rule.Proto().variables) > len(without.Proto().variables)

    def test_a_weight_of_zero_builds_nothing(self, tmp_path: Path) -> None:
        plain = _payload(limit=None, pause=None, lengths=[60, 60, 60])
        flagged = _payload(limit=120, pause=30, lengths=[60, 60, 60])
        flagged["requirements"] = plain["requirements"]
        flagged["rooms"] = plain["rooms"]
        plain["teacherWorkRules"] = []
        _solver, _request, (without, *_rest) = _build(
            plain, objective=True, WEIGHT_CONSECUTIVE_TEACHING=0,
        )
        _solver, _request, (with_rule, *_rest) = _build(
            flagged, objective=True, WEIGHT_CONSECUTIVE_TEACHING=0,
        )
        assert _digest(with_rule, tmp_path) == _digest(without, tmp_path)

    def test_a_limit_no_week_can_keep_is_still_a_timetable(self) -> None:
        # Every 60-minute lesson is an hour in a row against a limit of half an
        # hour: nothing can be kept, and the answer is a timetable all the same.
        payload = _payload(limit=30, pause=15, lengths=[60, 60, 60])
        solver = SchedulerSolver(_settings())
        request = OptimizeScheduleRequest.model_validate(payload)
        response = solver.solve(request)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 3
        assert response.conflicts is None

    def test_a_teacher_with_nothing_to_place_builds_the_model_it_always_built(self, tmp_path: Path) -> None:
        plain = _payload(limit=None, pause=None, lengths=[60, 60])
        flagged = _payload(limit=120, pause=30, lengths=[60, 60])
        flagged["requirements"] = plain["requirements"]
        flagged["rooms"] = plain["rooms"]
        flagged["teacherWorkRules"][0]["teacherId"] = str(uuid4())  # type: ignore[index]
        plain["teacherWorkRules"] = []
        _solver, _request, (without, *_rest) = _build(plain, objective=True)
        _solver, _request, (with_rule, *_rest) = _build(flagged, objective=True)
        assert _digest(with_rule, tmp_path) == _digest(without, tmp_path)


class TestTheWishMovesLessons:
    def test_the_generator_leaves_the_break_a_packed_afternoon_would_not(self) -> None:
        # Three hours of lessons in a four-hour morning. Packed, they are one
        # stretch of 180 minutes; the idle-time term alone would keep them
        # packed. A limit of 120 minutes then 30 free is bought with a break.
        lengths = [60, 60, 60]
        packed = _payload(limit=None, pause=None, lengths=lengths)
        wished = _payload(limit=120, pause=30, lengths=lengths)
        wished["requirements"] = packed["requirements"]
        wished["rooms"] = packed["rooms"]
        request = OptimizeScheduleRequest.model_validate(wished)

        def breaches(payload: dict[str, object]) -> int:
            solver = SchedulerSolver(_settings())
            response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
            assert response.status in {"OPTIMAL", "FEASIBLE"}
            return len(stretch_breaches(request, response.lessons))

        # Counted against the wished request's rule on both timetables.
        without_rule = dict(packed)
        without_rule["teacherWorkRules"] = []
        assert breaches(without_rule) == 1
        assert breaches(wished) == 0

    def test_a_locked_lesson_is_a_fact_the_break_goes_around(self) -> None:
        payload = _payload(limit=120, pause=30, lengths=[60, 60], locked=[("08:00", "09:00")])
        solver = SchedulerSolver(_settings())
        request = OptimizeScheduleRequest.model_validate(payload)
        response = solver.solve(request)
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 2
        assert stretch_breaches(request, response.lessons) == []

    def test_the_two_weeks_of_an_a_b_teacher_are_each_held(self) -> None:
        payload = _payload(
            limit=120, pause=30, lengths=[60, 60, 60, 60],
            recurrence=["ODD_WEEKS", "ODD_WEEKS", "EVEN_WEEKS", "EVEN_WEEKS"],
        )
        solver = SchedulerSolver(_settings())
        response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 4


class TestTheContract:
    def test_one_of_the_two_fields_without_the_other_is_refused(self) -> None:
        for fields in (
            {"maxConsecutiveTeachingMinutes": 180},
            {"consecutiveBreakMinutes": 30},
        ):
            payload = _payload(limit=None, pause=None, lengths=[60])
            payload["teacherWorkRules"][0].update(fields)  # type: ignore[index]
            with pytest.raises(ValueError, match="together, or neither"):
                OptimizeScheduleRequest.model_validate(payload)

    def test_the_bounds_are_the_databases(self) -> None:
        for limit, pause in ((25, 15), (485, 15), (180, 0), (180, 125), (182, 15), (180, 17)):
            with pytest.raises(ValueError):  # noqa: PT011
                OptimizeScheduleRequest.model_validate(
                    _payload(limit=limit, pause=pause, lengths=[60]),
                )

    def test_the_estimate_is_an_upper_bound_with_the_wish_in_it(self) -> None:
        payload = _payload(limit=120, pause=30, lengths=[60, 60, 60, 60])
        solver, request, (model, *_rest) = _build(payload, objective=True)
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)
