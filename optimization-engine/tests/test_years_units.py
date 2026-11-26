"""Årskurs för årskurs, granskningen av #482: what the units and the steps say that no test held them to.

  * a year is a unit with no group to join its classes (`units_of` joins on `minGradeLevel`): a week of classes alone is cut
    into its years, not into its classes;
  * `MAX_UNITS` (12) as it is set, not as a test sets it: twelve units are laid year by year, thirteen are not;
  * a step has the groups of its own classes and of their years and no other year's, and no `startLessons`, the schedule
    the week as a whole starts from (a step asks the week it is, which is a part of it).
"""

from __future__ import annotations

import sys
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.schemas.schedule import StartedLesson  # noqa: E402
from app.solver import years  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402


def test_the_classes_of_a_year_are_one_unit_when_no_group_joins_them() -> None:
    request = build_week(SchoolShape(classes_per_year=2, group_subjects=0, languages=0, seed=1)).request

    units = years.units_of(request)

    assert units is not None
    assert sorted(unit.years for unit in units) == [(7,), (8,), (9,)], "three years, not six classes"


def _classes_alone(classes: int):  # noqa: ANN202
    week = build_week(SchoolShape(classes_per_year=classes, years=(7,), group_subjects=0, languages=0, seed=1)).request
    return week.model_copy(update={"requirements": [r.model_copy(update={"min_grade_level": None}) for r in week.requirements]})


def test_twelve_units_are_laid_year_by_year_and_thirteen_are_not() -> None:
    assert years.MAX_UNITS == 12
    assert len(years.units_of(_classes_alone(12)) or []) == 12
    assert years.units_of(_classes_alone(13)) is None


def test_a_step_has_the_groups_of_its_own_years_and_no_start_lessons() -> None:
    request = build_week(SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)).request
    first, second, _third = years.units_of(request) or []
    by_id = {r.id: r for r in request.requirements}
    started = [
        StartedLesson(requirementId=r.id, dayOfWeek=1, startTime="08:00:00", endTime="08:" + f"{r.minutes_per_lesson:02d}" + ":00")
        for r in request.requirements[:3]
    ]
    request = request.model_copy(update={"start_lessons": started})

    step = years.step_request(request, first.ids, {}, "years-1")

    assert step.start_lessons is None
    own = {by_id[i].min_grade_level for i in first.ids}
    classes = {by_id[i].student_group_id for i in first.ids}
    foreign = [g for g in step.groups if g.id not in classes and g.min_grade_level not in own]
    assert foreign == [], "no group of another year is in the step"
    assert len(step.groups) < len(request.groups), "the step is a part of the week"
    assert second.ids.isdisjoint({r.id for r in step.requirements})
