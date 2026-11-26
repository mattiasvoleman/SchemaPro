"""Årskurs för årskurs (M8 PR 5): a week that phase 1a does not lay is laid one year at a time, each year held where it was laid.

What is held, in the order the solve uses it:

  * `units_of` cuts the week into its years (requirements that share a pupil, a block or a year are one unit) and puts the one
    with most pairs of groups first; a week of fewer than two units, or of more than MAX_UNITS, is not cut;
  * `places_of` puts a requirement's laid lessons where `pinnedLessons` has them (longest lesson first, a split post's lead's);
  * `step_request` is the week as a step asks it: the years laid pinned, the year being laid free, the others left out;
  * `_lay_by_years` builds and solves each step with the engine's own model and gives back a timetable of the whole week as hints,
    or None the moment a step does not come (in time, or INFEASIBLE with the years above it held, or refused by the model);
  * `_solve_strict` takes that road only BETWEEN phase 1a and 1b, on a week without the walk: a week 1a lays never takes it, and
    one it does not lay is laid by 1b from the hint. The report of a solve that timed out names the step `YEARS`.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from ortools.sat.python import cp_model

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.config import Settings  # noqa: E402
from app.exceptions import InvalidScheduleInputError  # noqa: E402
from app.schemas.schedule import (  # noqa: E402
    AnonymousRequirement,
    OptimizeScheduleRequest,
    PinnedLesson,
    ScheduledLesson,
    StartedLesson,
)
from app.solver import staged, years  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

#: Six classes of three years (7, 8, 9), three subjects in groups: laid by phase 1a in a second.
SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _week() -> OptimizeScheduleRequest:
    return build_week(SHAPE).request


def _settings(seconds: float = 30.0) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=seconds, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


def _minutes(clock: str) -> int:
    hours, minutes, _ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def _overlap(a: ScheduledLesson, b: ScheduledLesson) -> bool:
    return (
        a.day_of_week == b.day_of_week
        and _minutes(a.start_time) < _minutes(b.end_time)
        and _minutes(b.start_time) < _minutes(a.end_time)
    )


def _faults(request: OptimizeScheduleRequest, lessons: list[ScheduledLesson]) -> list[str]:
    """What is wrong with an answer, read from the answer: pupils, teachers and rooms in two places at once."""
    requirement = {r.id: r for r in request.requirements}
    pairs = {frozenset(pair) for pair in request.group_conflicts}
    faults: list[str] = []
    for index, a in enumerate(lessons):
        ra = requirement[a.requirement_id]
        for b in lessons[index + 1:]:
            if not _overlap(a, b):
                continue
            rb = requirement[b.requirement_id]
            if a.room_id == b.room_id:
                faults.append("a room twice at once")
            if ra.teacher_id is not None and ra.teacher_id == rb.teacher_id:
                faults.append("a teacher in two places")
            if ra.student_group_id == rb.student_group_id or frozenset((ra.student_group_id, rb.student_group_id)) in pairs:
                faults.append("pupils in two places")
    return faults


class _GivesUp(cp_model.CpSolver):
    """A search that ends with nothing found, as phase 1a of a week it cannot lay does."""

    def Solve(self, model, solution_callback=None):  # noqa: N802
        return cp_model.UNKNOWN


class _Answers(cp_model.CpSolver):
    """A search that ends with a fixed status, nothing run."""

    def __init__(self, status) -> None:  # noqa: ANN001
        super().__init__()
        self._status = status

    def Solve(self, model, solution_callback=None):  # noqa: N802
        return self._status


class Scripted(SchedulerSolver):
    """The engine, with phase 1a giving up as it does on a week it cannot lay, and every call it makes written down.

    `year_solver` is what the years' steps are given, by number: the engine's own (None) or a search that answers a status."""

    def __init__(self, settings: Settings, *, year_solver: dict[int, object] | None = None, gives_up: bool = True) -> None:
        super().__init__(settings)
        self.calls: list[str] = []
        self._year_solver = year_solver or {}
        self._gives_up = gives_up

    def _generation_solver(self, request, seconds):  # type: ignore[override]
        self.calls.append("generation")
        if self._gives_up and self.calls.count("generation") == 1:
            return _GivesUp()
        return SchedulerSolver._generation_solver(request, seconds)

    def _years_solver(self, request, seconds):  # type: ignore[override]
        self.calls.append("year")
        step = self.calls.count("year")
        if step in self._year_solver:
            return _Answers(self._year_solver[step])
        return SchedulerSolver._generation_solver(request, seconds)


# ---- the years of a week --------------------------------------------------------------------------------------


def test_a_week_of_three_years_is_three_units_and_every_requirement_is_in_one() -> None:
    request = _week()

    units = years.units_of(request)

    assert units is not None and len(units) == 3
    ids = [i for unit in units for i in unit.ids]
    assert sorted(ids) == sorted(r.id for r in request.requirements), "every requirement is in exactly one unit"
    by_id = {r.id: r for r in request.requirements}
    assert all(len({by_id[i].min_grade_level for i in unit.ids}) == 1 for unit in units), "one year to a unit"
    assert sorted(y for unit in units for y in unit.years) == [7, 8, 9]


def test_the_unit_with_most_pairs_of_groups_comes_first() -> None:
    request = _week()
    by_year = {y: [r for r in request.requirements if r.min_grade_level == y] for y in (7, 8, 9)}
    keys = {y: sorted({r.student_group_id for r in by_year[y]}, key=str) for y in by_year}
    extra = [(a, b) for a in keys[8] for b in keys[8] if a != b] * 3
    request = request.model_copy(update={"group_conflicts": [*request.group_conflicts, *extra]})

    units = years.units_of(request)

    assert units is not None
    assert units[0].years == (8,), "year 8 has the most pairs"
    assert [u.pairs for u in units] == sorted((u.pairs for u in units), reverse=True)


def test_a_group_that_draws_on_two_years_joins_them() -> None:
    request = _week()
    seven = next(r for r in request.requirements if r.min_grade_level == 7)
    eight = next(r for r in request.requirements if r.min_grade_level == 8)
    request = request.model_copy(update={
        "group_conflicts": [*request.group_conflicts, (seven.student_group_id, eight.student_group_id)],
    })

    units = years.units_of(request)

    assert units is not None and len(units) == 2
    assert sorted(tuple(u.years) for u in units) == [(7, 8), (9,)]


def test_a_week_whose_years_are_all_joined_is_one_unit_and_is_not_cut() -> None:
    request = _week()
    firsts = {y: next(r for r in request.requirements if r.min_grade_level == y).student_group_id for y in (7, 8, 9)}
    request = request.model_copy(update={
        "group_conflicts": [*request.group_conflicts, (firsts[7], firsts[8]), (firsts[8], firsts[9])],
    })

    assert years.units_of(request) is None


def test_the_members_of_a_block_are_laid_together() -> None:
    request = _week()
    seven = next(r for r in request.requirements if r.min_grade_level == 7)
    nine = next(r for r in request.requirements if r.min_grade_level == 9)
    block = uuid.UUID(int=77, version=4)
    request = request.model_copy(update={"requirements": [
        r.model_copy(update={"block_id": block}) if r.id in (seven.id, nine.id) else r for r in request.requirements
    ]})

    units = years.units_of(request)

    assert units is not None and len(units) == 2
    assert any(set(unit.years) == {7, 9} for unit in units)


def test_a_week_of_more_units_than_the_road_takes_is_not_cut(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(years, "MAX_UNITS", 2)

    assert years.units_of(_week()) is None


def test_a_week_of_one_year_is_not_cut() -> None:
    request = _week()
    one = [r for r in request.requirements if r.min_grade_level == 7]
    request = request.model_copy(update={"requirements": one})

    assert years.units_of(request) is None


# ---- where the laid lessons sit --------------------------------------------------------------------------------


def _lesson(requirement_id, day: int, start: str, end: str, teacher=None) -> ScheduledLesson:  # noqa: ANN001
    return ScheduledLesson(requirementId=requirement_id, dayOfWeek=day, startTime=start, endTime=end, teacherId=teacher)


def _requirement(**changes) -> AnonymousRequirement:  # noqa: ANN003
    base = _week().requirements[0].model_dump(by_alias=True, exclude_none=True)
    base.pop("pinnedLessons", None)
    base.pop("lessonLengths", None)
    base.pop("lessonTeacherIds", None)
    return AnonymousRequirement.model_validate({**base, **changes})


def test_a_post_of_two_lengths_has_its_longest_lesson_at_place_zero_whatever_the_clock_says() -> None:
    requirement = _requirement(lessonsPerWeek=2, minutesPerLesson=90, lessonLengths=[60, 90])
    laid = [_lesson(requirement.id, 1, "09:00:00", "10:00:00"), _lesson(requirement.id, 2, "08:00:00", "09:30:00")]

    places = years.places_of(requirement, laid)

    assert [(p.day_of_week, p.start_time, p.end_time) for p in places] == [
        (2, "08:00:00", "09:30:00"), (1, "09:00:00", "10:00:00"),
    ]


def test_a_split_post_puts_each_lesson_at_its_leads_place() -> None:
    first, second = uuid.UUID(int=1, version=4), uuid.UUID(int=2, version=4)
    requirement = _requirement(lessonsPerWeek=2, minutesPerLesson=60, lessonTeacherIds=[first, second], teacherId=first)
    laid = [_lesson(requirement.id, 1, "08:00:00", "09:00:00", teacher=second), _lesson(requirement.id, 3, "08:00:00", "09:00:00", teacher=first)]

    places = years.places_of(requirement, laid)

    assert [(p.day_of_week) for p in places] == [3, 1], "place 0 is the first lead's, laid on Wednesday"


def test_lessons_that_are_not_the_requirements_places_are_refused() -> None:
    requirement = _requirement(lessonsPerWeek=2, minutesPerLesson=60)
    one = [_lesson(requirement.id, 1, "08:00:00", "09:00:00")]
    three = [_lesson(requirement.id, d, "08:00:00", "09:00:00") for d in (1, 2, 3)]

    with pytest.raises(ValueError, match="no lesson of 60 minutes"):
        years.places_of(requirement, one)
    with pytest.raises(ValueError, match="more lessons laid than places"):
        years.places_of(requirement, three)


# ---- the week as a step asks it --------------------------------------------------------------------------------


def test_a_step_has_the_years_laid_pinned_the_year_being_laid_free_and_no_other() -> None:
    request = _week()
    first, second, third = years.units_of(request) or []
    by_id = {r.id: r for r in request.requirements}
    held = {i: [PinnedLesson(dayOfWeek=1, startTime="08:00:00", endTime=_end(by_id[i]))] * by_id[i].lessons_per_week for i in first.ids}

    step = years.step_request(request, second.ids, held, "years-2")

    assert {r.id for r in step.requirements} == first.ids | second.ids
    assert all(r.pinned_lessons is not None for r in step.requirements if r.id in first.ids)
    assert all(r.pinned_lessons is None for r in step.requirements if r.id in second.ids)
    assert not any(r.id in third.ids for r in step.requirements)
    assert step.previous_lessons == [] and step.start_lessons is None
    classes = {r.student_group_id for r in step.requirements}
    assert all(a in classes | {r.pupil_group_id for r in step.requirements} for pair in step.group_conflicts for a in pair)
    assert step.request_id != request.request_id
    assert step.request_id == years.step_request(request, second.ids, held, "years-2").request_id, "the same step is the same id"
    assert step.rooms == request.rooms and step.frame_times == request.frame_times


def _end(requirement: AnonymousRequirement) -> str:
    total = 8 * 60 + requirement.minutes_per_lesson
    return f"{total // 60:02d}:{total % 60:02d}:00"


def test_a_requirement_the_school_pinned_in_part_is_held_whole_and_keeps_the_pins_the_school_made() -> None:
    request = _week()
    first, second, _ = years.units_of(request) or []
    mine = next(r for r in request.requirements if r.id in first.ids and r.lessons_per_week >= 2)
    school = PinnedLesson(dayOfWeek=2, startTime="08:00:00", endTime=_end(mine), roomId=request.rooms[0].id)
    request = request.model_copy(update={"requirements": [
        r.model_copy(update={"pinned_lessons": [school] + [None] * (r.lessons_per_week - 1)}) if r.id == mine.id else r
        for r in request.requirements
    ]})
    mine = next(r for r in request.requirements if r.id == mine.id)
    laid = [
        _lesson(mine.id, 2, "08:00:00", _end(mine)),
        *(_lesson(mine.id, 3 + k, "09:00:00", _end_from(mine, "09:00:00")) for k in range(mine.lessons_per_week - 1)),
    ]

    held = years.held_of(mine, laid)
    step = years.step_request(request, second.ids, {mine.id: held}, "years-2")

    assert held[0] == school, "the school's pin, its room too"
    assert all(place is not None for place in held), "no place is left for a later step to lay again"
    kept = next(r for r in step.requirements if r.id == mine.id)
    assert kept.pinned_lessons == held


def _end_from(requirement: AnonymousRequirement, start: str) -> str:
    total = _minutes(start) + requirement.minutes_per_lesson
    return f"{total // 60:02d}:{total % 60:02d}:00"


# ---- the road ---------------------------------------------------------------------------------------------------


def test_the_years_lay_a_week_that_keeps_every_rule_and_hint_every_lesson() -> None:
    request = _week()
    solver = SchedulerSolver(_settings())

    laid = solver._lay_by_years(request, 120.0)

    assert laid is not None
    assert len(laid) == sum(r.lessons_per_week for r in request.requirements), "a hint for every lesson of the week"
    held = staged.held_places(request.model_copy(update={"start_lessons": [
        StartedLesson(requirementId=p.requirement_id, dayOfWeek=p.day_of_week, startTime=p.start_time,
                      endTime=_end_of(request, p)) for p in laid
    ]}))
    assert staged.clashes(request, held) == set(), "no teacher, group or pair of groups in two places"


def _end_of(request: OptimizeScheduleRequest, previous) -> str:  # noqa: ANN001
    requirement = next(r for r in request.requirements if r.id == previous.requirement_id)
    total = _minutes(previous.start_time) + requirement.minutes_per_lesson
    return f"{total // 60:02d}:{total % 60:02d}:00"


def test_a_week_that_phase_1a_lays_never_takes_the_road(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[int] = []
    real = SchedulerSolver._lay_by_years
    monkeypatch.setattr(SchedulerSolver, "_lay_by_years", lambda self, *a, **k: asked.append(1) or real(self, *a, **k))

    response = SchedulerSolver(_settings()).solve(_week())

    assert response.status in ("OPTIMAL", "FEASIBLE") and response.lessons
    assert asked == [], "the road is between phase 1a and 1b, and phase 1a laid this week"


def test_a_week_phase_1a_gives_up_on_is_laid_by_the_years_and_phase_1b_finishes_it() -> None:
    request = _week()
    solver = Scripted(_settings())

    response = solver.solve(request)

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert len(response.lessons) == sum(r.lessons_per_week for r in request.requirements)
    assert _faults(request, response.lessons) == []
    assert solver.calls[:5] == ["generation", "year", "year", "year", "generation"], solver.calls


def test_a_step_that_gives_up_ends_the_road_and_phase_1b_goes_on_as_it_always_did() -> None:
    request = _week()
    solver = Scripted(_settings(), year_solver={2: cp_model.UNKNOWN})

    response = solver.solve(request)

    assert response.status in ("OPTIMAL", "FEASIBLE") and response.lessons
    assert _faults(request, response.lessons) == []
    assert solver.calls[:4] == ["generation", "year", "year", "generation"], solver.calls


def test_a_step_that_is_infeasible_with_the_years_above_it_held_proves_nothing_about_the_week() -> None:
    request = _week()
    solver = Scripted(_settings(), year_solver={1: cp_model.INFEASIBLE})

    response = solver.solve(request)

    assert response.status in ("OPTIMAL", "FEASIBLE") and response.lessons, "phase 1b, not a refusal, says what the week is"
    assert solver.calls[:3] == ["generation", "year", "generation"], solver.calls


def test_a_step_the_engine_refuses_to_build_ends_the_road(monkeypatch: pytest.MonkeyPatch) -> None:
    request = _week()
    solver = Scripted(_settings())
    real = SchedulerSolver._build_model
    built: list[int] = []

    def build(self, req, **kwargs):  # noqa: ANN001, ANN003, ANN202
        built.append(1)
        if len(built) == 4:  # the two of the week, then the first step, then the second
            raise InvalidScheduleInputError("a pin the frame cannot hold", code="PLACED_LESSON_OUTSIDE_FRAME")
        return real(self, req, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", build)

    response = solver.solve(request)

    assert response.status in ("OPTIMAL", "FEASIBLE") and response.lessons
    assert solver.calls.count("year") == 1, "the second step was never searched"


def test_the_report_of_a_week_that_timed_out_names_the_road_between_the_two_searches() -> None:
    request = _week()
    solver = Scripted(
        _settings(), year_solver={1: cp_model.UNKNOWN},
    )
    # Phase 1b gives up as well: the generation solver of its call.
    real = solver._generation_solver

    def generation(req, seconds):  # noqa: ANN001, ANN202
        solver_ = real(req, seconds)
        return _GivesUp() if solver.calls.count("generation") == 2 else solver_

    solver._generation_solver = generation  # type: ignore[method-assign]

    response = solver.solve(request)

    assert response.status == "TIMEOUT" and response.report is not None
    assert [s.stage for s in response.report.stages] == [
        "PRECHECKS", "BUILD", "SEARCH_CLEAN", "YEARS", "SEARCH_CLONE", "PROBE",
    ]
    assert [p.phase for p in response.report.search.phases] == ["CLEAN", "CLONE"], "the road is a step and not a search phase"


def test_a_week_of_one_unit_goes_from_phase_1a_to_phase_1b_with_no_step_between() -> None:
    request = _week()
    firsts = {y: next(r for r in request.requirements if r.min_grade_level == y).student_group_id for y in (7, 8, 9)}
    request = request.model_copy(update={
        "group_conflicts": [*request.group_conflicts, (firsts[7], firsts[8]), (firsts[8], firsts[9])],
    })
    solver = Scripted(_settings())

    response = solver.solve(request)

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert "year" not in solver.calls
    assert solver.calls[:2] == ["generation", "generation"]


def test_the_steps_are_searched_with_the_seed_and_workers_of_the_request() -> None:
    from app.schemas.schedule import SearchOptions

    request = _week().model_copy(update={"search": SearchOptions(seed=7, workers=1)})
    seen: list[tuple[int, int]] = []
    real = SchedulerSolver._generation_solver

    class Spy(SchedulerSolver):
        def _years_solver(self, req, seconds):  # type: ignore[override]
            solver = super()._years_solver(req, seconds)
            seen.append((solver.parameters.random_seed, solver.parameters.num_workers))
            return solver

    assert SchedulerSolver._generation_solver is real
    laid = Spy(_settings())._lay_by_years(request, 120.0)

    assert laid is not None
    assert seen and all(seed == 7 and workers == 1 for seed, workers in seen)


def test_the_hint_the_road_gives_replaces_the_hints_the_disruption_term_made() -> None:
    """A variable hinted twice is a model CP-SAT rejects: a week with a previous schedule is laid by the road all the same."""
    request = _week()
    first = Scripted(_settings()).solve(request)
    assert first.lessons
    previous = [
        {"requirementId": str(l.requirement_id), "dayOfWeek": l.day_of_week, "startTime": l.start_time}
        for l in first.lessons
    ]
    again = request.model_copy(update={
        "previous_lessons": [__import__("app.schemas.schedule", fromlist=["PreviousLesson"]).PreviousLesson.model_validate(p) for p in previous],
    })
    solver = Scripted(_settings())

    response = solver.solve(again)

    assert response.status in ("OPTIMAL", "FEASIBLE") and response.lessons
    assert "year" in solver.calls


def test_a_week_that_keeps_the_walk_between_sites_is_left_to_phase_1b(monkeypatch: pytest.MonkeyPatch) -> None:
    """The road does not plan the sites; a week with the walk has them planned first and goes on from phase 1a as it did."""
    from tests import test_travel as tt

    group_a, group_b = str(uuid.uuid4()), str(uuid.uuid4())
    payload = tt._payload([tt._requirement(group_a, teacher=None), tt._requirement(group_b, teacher=None)])
    request = OptimizeScheduleRequest.model_validate(payload)
    assert years.units_of(request) is not None and len(years.units_of(request) or []) == 2, "it has years to cut"
    monkeypatch.setattr(SchedulerSolver, "_solve_on_planned_sites", lambda self, *a, **k: None)
    solver = Scripted(_settings(30.0))

    response = solver.solve(request)

    assert response.lessons
    assert "year" not in solver.calls, solver.calls
