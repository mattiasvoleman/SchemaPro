"""The start step: lessons and lunches start on the week's own coarsest interval.

The grid stays five minutes, and every refusal, rounding and weight with it;
_start_step only thins out where a start may fall. What has to hold is that the
thinning loses no week and no optimum, and neither shows in a solved
timetable: a schedule on the half hours satisfies a model that allowed every
five minutes just as well. So the tests come in three kinds.

  THE DERIVATION, one case per constant the model compares a start with. A
  source that stopped feeding the gcd would keep every solve green and lose
  weeks in silence; here it turns a row red.

  THE VERDICT, over many small random weeks: the same FEASIBLE or INFEASIBLE
  with the step forced to 1 and with the step the week derives.

  THE OPTIMUM, on small weeks solved to OPTIMAL both ways, and on the two
  weeks whose optimum a step WOULD change, which is why the derivation refuses
  to step them.

Every solve here is one worker under a deterministic time limit, so a verdict
is the same on every machine, and an UNKNOWN is left out of the comparison
rather than counted as agreement.
"""

from __future__ import annotations

import random
import sys
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver, _start_step


def _gate_payload() -> dict:
    """The nightly gate's own week: validate_schedule.py --students 400."""
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from solve_2000_students import SchoolShape, build_request

    request = build_request(SchoolShape(students=400, constraint_density=1.0))
    return request.model_dump(by_alias=True, mode="json")


def _step_minutes(payload: dict, **settings: object) -> int:
    solver = SchedulerSolver(Settings(**settings))  # type: ignore[arg-type]
    request = OptimizeScheduleRequest.model_validate(payload)
    return _start_step(request, solver._grid) * solver._grid.slot_minutes


def _clock(offset: int) -> str:
    """Minutes after 08:00 as the payload writes a time."""
    total = 480 + offset
    return f"{total // 60:02d}:{total % 60:02d}:00"


def _hhmm(value: str) -> str:
    return f"{value}:00" if value.count(":") == 1 else value


def _row(
    payload: dict, start: str, end: str, *,
    kind: str = "UNAVAILABLE", resource: str = "TEACHER", date: str | None = None,
) -> dict:
    row = {
        "id": str(uuid4()),
        "resourceKind": resource,
        "dayOfWeek": None if date else 2,
        "date": date,
        "startTime": _hhmm(start),
        "endTime": _hhmm(end),
        "kind": kind,
    }
    if resource == "TEACHER":
        row["resourceId"] = payload["requirements"][0]["teacherId"]
    elif resource == "ROOM":
        row["resourceId"] = payload["rooms"][0]["id"]
    elif resource == "STUDENT_GROUP":
        row["resourceId"] = payload["requirements"][0]["studentGroupId"]
    else:
        row["minGradeLevel"], row["maxGradeLevel"] = 4, 6
    return row


def _locked(payload: dict, start: str, end: str) -> dict:
    first = payload["requirements"][0]
    return {
        "id": str(uuid4()), "teacherId": first["teacherId"], "coTeacherId": None,
        "studentGroupId": first["studentGroupId"], "extraGroupIds": [], "roomId": None,
        "dayOfWeek": 3, "startTime": _hhmm(start), "endTime": _hhmm(end),
    }


def _window(start: str, end: str) -> dict:
    """Every year, every day: the shape a frame, a rast and a sitting share."""
    return {
        "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
        "startTime": _hhmm(start), "endTime": _hhmm(end),
    }


def _frame(start: str, end: str, changeover: int = 0) -> dict:
    return {**_window(start, end), "changeoverMinutes": changeover}


def _append(payload: dict, field: str, row: dict) -> None:
    payload[field] = [*(payload.get(field) or []), row]


def _set_rule(payload: dict, **values: object) -> None:
    payload["rules"] = {**payload["rules"], **values}


# ---------------------------------------------------------------------------
# The derivation
# ---------------------------------------------------------------------------


def test_the_gate_steps_every_start_by_half_an_hour() -> None:
    """Lessons of an hour, a thirty-minute meal in 11:00-13:00, teachers away
    13:00-16:00. Thirty minutes is the coarsest interval all of them agree on,
    and the meal is what makes it thirty: without it the hour would do."""
    payload = _gate_payload()

    assert _step_minutes(payload) == 30

    payload["rules"] = None
    assert _step_minutes(payload) == 60


def test_the_day_is_a_source_of_its_own() -> None:
    """Starts are absolute across the week, so a day of 117 slots puts Tuesday's
    first start at 117, and a step of 6 would not reach it."""
    assert _step_minutes(_gate_payload(), SCHEDULE_DAY_END_MINUTES=1065) == 15


# One row per constant the model compares a start with. Each is added to the
# gate's thirty-minute week, and the step falls to the gcd the rounded value
# leaves: 09:40 is slot 20, and gcd(6, 20) is 2, ten minutes.
SOURCES: list[tuple[str, Callable[[dict], None], int]] = [
    ("a 45-minute lesson among hours",
     lambda p: p["requirements"][0].update(minutesPerLesson=45), 15),
    ("a lesson locked at 08:05",
     lambda p: _append(p, "fixedLessons", _locked(p, "08:05", "09:05")), 5),
    ("a lock ending 11:40",
     lambda p: _append(p, "fixedLessons", _locked(p, "11:00", "11:40")), 10),
    ("a lock off the grid, 08:32-09:30, rounded outward to 08:30",
     lambda p: _append(p, "fixedLessons", _locked(p, "08:32", "09:30")), 30),
    ("a teacher away from 11:05",
     lambda p: _append(p, "constraints", _row(p, "11:05", "12:00")), 5),
    ("a room closed until 14:45",
     lambda p: _append(p, "constraints", _row(p, "13:00", "14:45", resource="ROOM")), 15),
    ("a class reserved from 09:20",
     lambda p: _append(p, "constraints", _row(p, "09:20", "10:00", resource="STUDENT_GROUP")), 10),
    ("years 4-6 reserved from 09:15",
     lambda p: _append(p, "constraints", _row(p, "09:15", "10:00", resource="GRADE_LEVEL")), 15),
    ("a dated closure at 10:10",
     lambda p: _append(p, "constraints", _row(p, "10:10", "11:00", date="2026-09-14")), 10),
    ("a wish to be free at 09:20",
     lambda p: _append(p, "constraints", _row(p, "09:20", "10:00", kind="PREFERRED_FREE")), 10),
    ("a frame opening 08:15",
     lambda p: _append(p, "frameTimes", _frame("08:15", "18:00")), 15),
    ("a frame closing 15:10",
     lambda p: _append(p, "frameTimes", _frame("08:00", "15:10")), 10),
    ("a frame opening off the grid at 08:07, read both ways",
     lambda p: _append(p, "frameTimes", _frame("08:07", "18:00")), 5),
    ("a changeover of ten minutes",
     lambda p: _append(p, "frameTimes", _frame("08:00", "18:00", changeover=10)), 10),
    ("a changeover of seven minutes, rounded up to ten",
     lambda p: _append(p, "frameTimes", _frame("08:00", "18:00", changeover=7)), 10),
    ("a rast 09:40-10:00",
     lambda p: _append(p, "rasts", _window("09:40", "10:00")), 10),
    ("a rast off the grid, 09:42-10:30, rounded outward to 09:40",
     lambda p: _append(p, "rasts", _window("09:42", "10:30")), 10),
    ("a sitting 11:45-12:30",
     lambda p: _append(p, "lunchServings", _window("11:45", "12:30")), 15),
    ("a sitting off the grid, 11:02-12:30, rounded inward to 11:05",
     lambda p: _append(p, "lunchServings", _window("11:02", "12:30")), 5),
    ("a lunch window from 11:15",
     lambda p: _set_rule(p, lunchStartTime="11:15:00"), 15),
    ("a lunch window to 12:50",
     lambda p: _set_rule(p, lunchEndTime="12:50:00"), 10),
    # The thirty-minute meal is what held the gate to thirty minutes; forty
    # replaces it, and the hour's other values share twenty.
    ("a forty-minute meal instead of thirty",
     lambda p: _set_rule(p, lunchMinutes=40), 20),
    ("a meal placed by hand at 11:15",
     lambda p: _append(p, "lunchPlacements", {
         "studentGroupId": p["groups"][0]["id"], "dayOfWeek": 1, "startTime": "11:15:00",
     }), 15),
    ("last term's lesson at 09:10",
     lambda p: _append(p, "previousLessons", {
         "requirementId": p["requirements"][0]["id"], "dayOfWeek": 1, "startTime": "09:10:00",
     }), 10),
]


@pytest.mark.parametrize(
    ("change", "minutes"),
    [(change, minutes) for _, change, minutes in SOURCES],
    ids=[label for label, _, _ in SOURCES],
)
def test_every_constant_a_start_meets_feeds_the_step(
    change: Callable[[dict], None], minutes: int,
) -> None:
    payload = _gate_payload()
    change(payload)

    assert _step_minutes(payload) == minutes


UNREADABLE: list[tuple[str, Callable[[dict], None]]] = [
    ("a 42-minute lesson", lambda p: p["requirements"][0].update(minutesPerLesson=42)),
    ("a lunch window from 11:07", lambda p: _set_rule(p, lunchStartTime="11:07:00")),
    ("a reservation ending 11:59:30",
     lambda p: _append(p, "constraints", _row(p, "11:00", "11:59:30"))),
    ("a meal placed at 11:07", lambda p: _append(p, "lunchPlacements", {
        "studentGroupId": p["groups"][0]["id"], "dayOfWeek": 1, "startTime": "11:07:00",
    })),
]


@pytest.mark.parametrize(
    "change", [change for _, change in UNREADABLE], ids=[label for label, _ in UNREADABLE],
)
def test_a_time_the_grid_cannot_read_gives_a_step_of_one(change: Callable[[dict], None]) -> None:
    """_validate_request refuses each of these by name before a model is built.
    A step guessed from them would buy nothing, and 1 is always sound."""
    payload = _gate_payload()
    change(payload)

    assert _step_minutes(payload) == 5


def test_a_previous_lesson_the_model_skips_is_skipped_here_too() -> None:
    """The disruption term drops a slot it cannot read without a word, so that
    slot is no constant a start is compared with, and it must not cost the
    school its step."""
    payload = _gate_payload()
    _append(payload, "previousLessons", {
        "requirementId": payload["requirements"][0]["id"], "dayOfWeek": 1, "startTime": "09:07:00",
    })

    assert _step_minutes(payload) == 30


def test_a_wish_to_be_busy_takes_the_step_to_one() -> None:
    """The one objective term that pays for NOT overlapping, and the only one
    whose optimum a step can move (see the straddle below). A wish to be FREE
    at the same hour keeps the step."""
    busy, free = _gate_payload(), _gate_payload()
    _append(busy, "constraints", _row(busy, "09:00", "10:00", kind="PREFERRED_BUSY"))
    _append(free, "constraints", _row(free, "09:00", "10:00", kind="PREFERRED_FREE"))

    assert _step_minutes(busy) == 5
    assert _step_minutes(free) == 30


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------


def _small_school() -> dict:
    """One class of years 4, two subjects of an hour, a meal in 11:00-12:00."""
    group = str(uuid4())
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group,
                "teacherId": str(uuid4()), "lessonsPerWeek": 2, "minutesPerLesson": 60,
                "studentGroupSize": 24, "minGradeLevel": 4, "maxGradeLevel": 4,
            }
            for _ in range(2)
        ],
        "groups": [{"id": group, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 4}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "rules": {"lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00", "lunchMinutes": 30},
    }


def _forced(step: int | None) -> pytest.MonkeyPatch:
    """A context in which every build reads `step`; None keeps the derivation."""
    patch = pytest.MonkeyPatch()
    if step is not None:
        patch.setattr(scheduler_solver, "_start_step", lambda _request, _grid: step)
    return patch


def _start_values(
    solver: SchedulerSolver, request: OptimizeScheduleRequest, step: int | None = None,
) -> set[int]:
    patch = _forced(step)
    try:
        _model, _, decisions, _, lunches = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
    finally:
        patch.undo()
    variables = [decision.start for decision in decisions] + list(lunches.values())
    assert lunches, "the week has meals to place"
    values: set[int] = set()
    for variable in variables:
        bounds = list(variable.proto.domain)
        for low, high in zip(bounds[::2], bounds[1::2]):
            values.update(range(low, high + 1))
    return values


def test_lessons_and_lunches_are_only_ever_offered_the_step() -> None:
    solver = SchedulerSolver(Settings(SCHEDULE_DAYS="1,2"))  # type: ignore[arg-type]
    request = OptimizeScheduleRequest.model_validate(_small_school())

    stepped = _start_values(solver, request)
    unstepped = _start_values(solver, request, step=1)

    assert _start_step(request, solver._grid) == 6
    assert stepped and all(value % 6 == 0 for value in stepped)
    # Nothing a multiple could hold was dropped, and everything else was.
    assert stepped == {value for value in unstepped if value % 6 == 0}
    assert unstepped - stepped


def test_a_relaxed_week_in_the_timeout_probe_steps_on_its_own() -> None:
    """The probe rebuilds the week without one rule at a time, and a week
    without its rasts is a different week: here the 09:40 rast is all that
    holds the school to ten minutes."""
    payload = _small_school()
    payload["rasts"] = [{
        "minGradeLevel": 4, "maxGradeLevel": 4, "dayOfWeek": None,
        "startTime": "09:40:00", "endTime": "10:00:00",
    }]
    solver = SchedulerSolver(Settings(SCHEDULE_DAYS="1,2"))  # type: ignore[arg-type]
    request = OptimizeScheduleRequest.model_validate(payload)
    relaxed = dict(solver._timeout_relaxations(request))["PROBE_SOLVED_WITHOUT_RASTS"]

    assert _start_step(request, solver._grid) == 2
    assert all(value % 2 == 0 for value in _start_values(solver, request))
    assert any(value % 6 for value in _start_values(solver, request))
    assert all(value % 6 == 0 for value in _start_values(solver, relaxed))


def test_a_timeout_says_how_far_apart_the_starts_were_searched() -> None:
    solver = SchedulerSolver(Settings())  # type: ignore[arg-type]
    gate = OptimizeScheduleRequest.model_validate(_gate_payload())
    locked = _gate_payload()
    _append(locked, "fixedLessons", _locked(locked, "08:05", "09:05"))

    assert "startStepMinutes=30" in solver._timeout_diagnosis(gate, "test")
    assert "startStepMinutes=5" in solver._timeout_diagnosis(
        OptimizeScheduleRequest.model_validate(locked), "test",
    )


# ---------------------------------------------------------------------------
# Random small weeks
# ---------------------------------------------------------------------------

#: Two days of 08:00-12:00, 48 slots each: small enough that a solve is
#: milliseconds, tight enough that some weeks have no timetable.
SMALL_WEEK = {"SCHEDULE_DAYS": "1,2", "SCHEDULE_DAY_END_MINUTES": 720}
DAY_MINUTES = 240


def _random_week(rng: random.Random) -> dict:
    """A small week touching every source the step reads.

    Times are drawn on a unit the week picks for itself — the hour, the half
    hour, the quarter, ten minutes — and now and then nudged off it, so most
    weeks step and some do not. A drawn week the schema or _validate_request
    refuses is simply not compared.
    """
    unit = rng.choice((30, 30, 60, 15, 10))

    def at(low: int, high: int) -> int:
        first = -(-low // unit)
        return rng.randint(first, max(first, high // unit)) * unit

    def nudged(minutes: int) -> int:
        return minutes + rng.choice((-5, 5, 10)) if rng.random() < 0.08 else minutes

    teachers = [str(uuid4()) for _ in range(2)]
    rooms = [{"id": str(uuid4()), "capacity": 30} for _ in range(rng.choice((1, 1, 2)))]
    classes = []
    for _ in range(rng.choice((1, 2))):
        year = rng.choice((4, 5, 6))
        classes.append({
            "id": str(uuid4()), "lunchHeadcount": rng.choice((20, 25, 30)),
            "minGradeLevel": year, "maxGradeLevel": year,
        })

    def requirement(group_id: str, span: tuple[int, int] | None) -> dict:
        minutes = (
            rng.choice((60, 60, 30, 90)) if rng.random() > 0.15 else rng.choice((45, 40, 50))
        )
        row = {
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": group_id,
            "teacherId": rng.choice(teachers), "lessonsPerWeek": rng.randint(1, 3),
            "minutesPerLesson": minutes, "studentGroupSize": 24,
        }
        if span is not None:
            row["minGradeLevel"], row["maxGradeLevel"] = span
        return row

    requirements = [
        requirement(cls["id"], (cls["minGradeLevel"], cls["maxGradeLevel"]))
        for cls in classes
        for _ in range(rng.choice((1, 2)))
    ]
    conflicts = []
    if rng.random() < 0.4:
        # A teaching group cut from the first class, sometimes with no years
        # of its own — the shape the asking-rast rule has to be careful with.
        teaching_group = str(uuid4())
        year = classes[0]["minGradeLevel"]
        requirements.append(requirement(
            teaching_group, rng.choice(((year, year), (year, year), None, (4, 6))),
        ))
        conflicts.append([classes[0]["id"], teaching_group])
    group_ids = [row["studentGroupId"] for row in requirements]

    frames = []
    if rng.random() < 0.35:
        frames.append({
            "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": rng.choice((None, None, 1, 2)),
            "startTime": _clock(nudged(at(0, 60))), "endTime": _clock(nudged(at(180, 240))),
            "changeoverMinutes": rng.choice((0, 0, 0, 5, 10)),
        })

    rasts = []
    for _ in range(rng.choice((0, 0, 1, 2))):
        start = nudged(at(30, 180))
        rasts.append({
            "minGradeLevel": rng.choice((0, 4, 5)), "maxGradeLevel": rng.choice((6, 12)),
            "dayOfWeek": rng.choice((None, None, 1, 2)),
            "startTime": _clock(start),
            "endTime": _clock(min(start + rng.choice((unit, unit, 20)), DAY_MINUTES)),
            "requiresLessonBefore": rng.random() < 0.5,
        })

    rules: dict[str, object] = {}
    servings, placements = [], []
    if rng.random() < 0.5:
        window = at(90, 150)
        rules.update(
            lunchStartTime=_clock(window),
            lunchEndTime=_clock(min(rng.choice((window + 60, DAY_MINUTES)), DAY_MINUTES)),
            lunchMinutes=rng.choice((30, 30, 20)),
        )
        if rng.random() < 0.3:
            rules["diningSeats"] = rng.choice((30, 40, 60))
        if rng.random() < 0.3:
            servings.append({
                "minGradeLevel": 4, "maxGradeLevel": 6, "dayOfWeek": None,
                "startTime": _clock(window),
                "endTime": _clock(min(window + rng.choice((30, 60, 90)), DAY_MINUTES)),
            })
        if rng.random() < 0.2:
            placements.append({
                "studentGroupId": classes[0]["id"], "dayOfWeek": 1,
                "startTime": _clock(nudged(at(window, window + 30))),
            })
    if rng.random() < 0.2:
        rules["maxLessonsPerDayPerGroup"] = rng.choice((2, 3))

    fixed = []
    if rng.random() < 0.3:
        start = nudged(at(0, 180))
        fixed.append({
            "id": str(uuid4()), "teacherId": teachers[0], "coTeacherId": None,
            "studentGroupId": rng.choice(group_ids), "extraGroupIds": [],
            "roomId": rng.choice((None, rooms[0]["id"])), "dayOfWeek": rng.choice((1, 2)),
            "startTime": _clock(start), "endTime": _clock(start + rng.choice((30, 60))),
        })

    constraints = []
    for _ in range(rng.choice((0, 1, 2))):
        start = nudged(at(0, 180))
        resource = rng.choice(("TEACHER", "STUDENT_GROUP", "ROOM", "GRADE_LEVEL"))
        row: dict[str, object] = {
            "id": str(uuid4()), "resourceKind": resource,
            "dayOfWeek": rng.choice((None, 1, 2)), "date": None,
            "startTime": _clock(start),
            "endTime": _clock(min(start + rng.choice((30, 60, 120)), DAY_MINUTES)),
            "kind": rng.choices(("UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"), (7, 2, 1))[0],
        }
        if resource == "TEACHER":
            row["resourceId"] = rng.choice(teachers)
        elif resource == "STUDENT_GROUP":
            row["resourceId"] = rng.choice(group_ids)
        elif resource == "ROOM":
            row["resourceId"] = rooms[0]["id"]
        else:
            row["minGradeLevel"], row["maxGradeLevel"] = 4, 5
        if rng.random() < 0.15:
            row["date"], row["dayOfWeek"] = "2026-09-14", None  # a Monday
        constraints.append(row)

    previous = []
    if rng.random() < 0.3:
        previous.append({
            "requirementId": requirements[0]["id"], "dayOfWeek": rng.choice((1, 2)),
            "startTime": _clock(nudged(at(0, 180))),
        })

    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "requirements": requirements, "groups": classes, "rooms": rooms,
        "constraints": constraints, "frameTimes": frames, "rasts": rasts,
        "lunchServings": servings, "lunchPlacements": placements, "fixedLessons": fixed,
        "groupConflicts": conflicts, "previousLessons": previous, "rules": rules or None,
    }


def _prepared(seed: int) -> tuple[SchedulerSolver, OptimizeScheduleRequest] | None:
    """The seed's week, or None when the schema or the validator refuses it."""
    try:
        request = OptimizeScheduleRequest.model_validate(_random_week(random.Random(seed)))
    except ValidationError:
        return None
    solver = SchedulerSolver(Settings(**SMALL_WEEK))  # type: ignore[arg-type]
    try:
        solver._validate_request(request)
    except InvalidScheduleInputError:
        return None
    return solver, request


def _solve(
    solver: SchedulerSolver, request: OptimizeScheduleRequest, *, step: int | None, objective: bool,
) -> tuple[int, cp_model.CpSolver]:
    """One worker, a deterministic budget: the same answer on every machine."""
    patch = _forced(step)
    try:
        model, *_ = solver._build_model(
            request, use_assumptions=False, include_objective=objective,
        )
    finally:
        patch.undo()
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_deterministic_time = 10.0
    cp.parameters.max_time_in_seconds = 60.0
    code = cp.Solve(model)
    assert code != cp_model.MODEL_INVALID, model.Validate()
    return code, cp


def _reading(code: int) -> str | None:
    if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return "FEASIBLE"
    if code == cp_model.INFEASIBLE:
        return "INFEASIBLE"
    return None


def test_a_step_never_changes_whether_a_week_has_a_timetable() -> None:
    """The claim _start_step rests on, asked of weeks nobody designed.

    And the lunch stage with it: the stage is built on the stepped starts, so a
    refusal from it has to be a week the unstepped model cannot place either.
    """
    compared: dict[str, int] = {"FEASIBLE": 0, "INFEASIBLE": 0}
    stage_refusals = 0
    for seed in range(160):
        prepared = _prepared(seed)
        if prepared is None:
            continue
        solver, request = prepared
        derived = _start_step(request, solver._grid)
        if derived == 1:
            continue  # the same model twice
        unstepped = _reading(_solve(solver, request, step=1, objective=False)[0])
        stepped = _reading(_solve(solver, request, step=None, objective=False)[0])
        if unstepped is None or stepped is None:
            continue
        assert stepped == unstepped, (seed, derived, unstepped, stepped)
        compared[unstepped] += 1

        narrowings = solver._lunch_start_narrowings(request, step=derived)
        if narrowings and not any(parts.composed().is_empty() for parts in narrowings.values()):
            stage = solver._build_lunch_stage(request, narrowings)
            if solver._lunch_stage_solver(10.0).Solve(stage.pinned(set())) == cp_model.INFEASIBLE:
                assert unstepped == "INFEASIBLE", (seed, derived)
                stage_refusals += 1

    # Not vacuous: enough stepped weeks, and both answers among them. The
    # stage refuses none of these small weeks, whose meals always find a
    # slot; its stepped refusals are held by the reproductions in
    # test_optimize.py, which now run stepped: the packed frames on ten
    # minutes, the register of idle classes on thirty.
    # Measured when written: 39 and 23 of 160 seeds.
    assert compared["FEASIBLE"] >= 25 and compared["INFEASIBLE"] >= 12, compared


def test_a_step_never_changes_the_best_timetable() -> None:
    compared = 0
    for seed in range(200, 300):
        prepared = _prepared(seed)
        if prepared is None:
            continue
        solver, request = prepared
        if _start_step(request, solver._grid) == 1:
            continue
        values = []
        for step in (1, None):
            code, cp = _solve(solver, request, step=step, objective=True)
            if code != cp_model.OPTIMAL:
                break
            values.append(round(cp.ObjectiveValue()))
        if len(values) < 2:
            continue
        assert values[0] == values[1], (seed, values)
        compared += 1

    # A stepped week not proved OPTIMAL both ways within the deterministic
    # budget is left out rather than counted; enough are left to mean something.
    assert compared >= 15, compared


def _optimum(payload: dict, step: int | None) -> int:
    solver = SchedulerSolver(Settings(SCHEDULE_DAYS="1"))  # type: ignore[arg-type]
    request = OptimizeScheduleRequest.model_validate(payload)
    solver._validate_request(request)
    code, cp = _solve(solver, request, step=step, objective=True)
    assert code == cp_model.OPTIMAL
    return round(cp.ObjectiveValue())


def _straddle_week(kind: str) -> dict:
    """One thirty-minute lesson, and its teacher's wish for 08:00-08:30 and
    08:30-09:00. At 08:15 the lesson overlaps both half hours."""
    teacher = str(uuid4())

    def wish(start: str, end: str) -> dict:
        return {
            "id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": teacher,
            "dayOfWeek": 1, "date": None, "startTime": start, "endTime": end, "kind": kind,
        }

    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "requirements": [{
            "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": str(uuid4()),
            "teacherId": teacher, "lessonsPerWeek": 1, "minutesPerLesson": 30,
            "studentGroupSize": 24,
        }],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [wish("08:00:00", "08:30:00"), wish("08:30:00", "09:00:00")],
    }


def test_a_lesson_straddling_two_busy_wishes_is_why_they_are_not_stepped() -> None:
    """Every constant here is on the half hour, so a step of thirty minutes is
    what the gcd alone would give. Stepped, the lesson can overlap one wish and
    pays for the other; unstepped it sits across both and pays nothing."""
    busy = _straddle_week("PREFERRED_BUSY")

    assert _optimum(busy, step=1) == 0
    assert _optimum(busy, step=6) == 5  # weight_preferred_busy_violation
    assert _optimum(busy, step=None) == 0

    free = _straddle_week("PREFERRED_FREE")
    solver = SchedulerSolver(Settings(SCHEDULE_DAYS="1"))  # type: ignore[arg-type]
    assert _start_step(OptimizeScheduleRequest.model_validate(free), solver._grid) == 6
    assert _optimum(free, step=None) == _optimum(free, step=1)


def _asking_rast_week(teaching_group_years: tuple[int, int] | None) -> dict:
    """A class of year 4 with a break at 09:00-09:30 that asks for a lesson
    before it, and no lessons of its own: its one lesson a week belongs to a
    teaching group cut from it. The group's teacher also teaches year 9, whose
    frame holds that lesson at 10:00-10:30.

    The class cannot be taught before 09:00 and still be there after 09:30, so
    its lesson has to start before 09:30. With no years of its own the teaching
    group has no rast to keep it out of the break, and the best start is 09:25,
    ending 09:55: five minutes of the teacher's idle time before 10:00."""
    cls, teaching_group, teacher = str(uuid4()), str(uuid4()), str(uuid4())
    years = (
        {}
        if teaching_group_years is None
        else dict(zip(("minGradeLevel", "maxGradeLevel"), teaching_group_years))
    )
    return {
        "requestId": str(uuid4()), "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": teaching_group,
                "teacherId": teacher, "lessonsPerWeek": 1, "minutesPerLesson": 30,
                "studentGroupSize": 24, **years,
            },
            {
                "id": str(uuid4()), "subjectId": str(uuid4()), "studentGroupId": str(uuid4()),
                "teacherId": teacher, "lessonsPerWeek": 1, "minutesPerLesson": 30,
                "studentGroupSize": 24, "minGradeLevel": 9, "maxGradeLevel": 9,
            },
        ],
        "groups": [{"id": cls, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 4}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "groupConflicts": [[cls, teaching_group]],
        "frameTimes": [{
            "minGradeLevel": 9, "maxGradeLevel": 9, "dayOfWeek": None,
            "startTime": "10:00:00", "endTime": "10:30:00",
        }],
        "rasts": [{
            "minGradeLevel": 4, "maxGradeLevel": 4, "dayOfWeek": None,
            "startTime": "09:00:00", "endTime": "09:30:00", "requiresLessonBefore": True,
        }],
    }


def test_a_lesson_its_rasts_do_not_hold_out_of_an_asking_break_is_why_it_is_not_stepped() -> None:
    """Rounded up from 09:25 to 09:30 the lesson would be late, and a late
    lesson needs one before the break that this class cannot have. Stepped,
    the best start is 09:00 and the teacher waits half an hour."""
    unknown = _asking_rast_week(None)

    assert _optimum(unknown, step=1) == 2  # one idle slot, weight_teacher_gap 2
    assert _optimum(unknown, step=6) == 12
    assert _optimum(unknown, step=None) == 2

    # With years of its own the group is kept out of the break, and the step
    # is safe again: the lesson can start at 08:30 at the latest, either way.
    known = _asking_rast_week((4, 4))
    solver = SchedulerSolver(Settings(SCHEDULE_DAYS="1"))  # type: ignore[arg-type]
    assert _start_step(OptimizeScheduleRequest.model_validate(known), solver._grid) == 6
    assert _optimum(known, step=None) == _optimum(known, step=1) == 24
