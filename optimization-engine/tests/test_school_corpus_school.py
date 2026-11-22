"""A corpus week can have the size and the form of a whole school (M5).

One number of group subjects for every year builds a school whose every year is dense or none is, so
the week of a whole school (six years, a few dozen classes, hundreds of lessons and most of the
engine's 5,000 pairs) had no form to be built in: the upper years alone are over the limit at fifteen
classes. The largest week of the sweep with groups across the classes was 141 requirements, 288
lessons and a model of 16,000 constraints.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

SMALL = corpus.SchoolShape(classes_per_year=2, group_subjects=3)
CODE_OF = {corpus._uid(f"subject-{code}"): code for code, *_ in corpus.SUBJECTS}


def _groups_in_year(week, year: int) -> int:
    classes = {g.id for g in week.request.groups}
    return sum(1 for r in week.request.requirements if r.min_grade_level == year and r.student_group_id not in classes)


def test_each_year_has_its_own_number_of_group_subjects() -> None:
    week = corpus.build_week(replace(SMALL, classes_per_year=3, languages=0, group_subjects_by_year=(0, 3, 10)))
    assert _groups_in_year(week, 7) == 0
    assert _groups_in_year(week, 8) == 3 * 3
    assert _groups_in_year(week, 9) == 10 * 3
    # A subject taught by group in one year and by class in another: class posts only where it is by class.
    classes = {g.id for g in week.request.groups}
    class_posts_in_9 = [r for r in week.request.requirements if r.min_grade_level == 9 and r.student_group_id in classes]
    assert {CODE_OF[str(r.subject_id)] for r in class_posts_in_9} == {"TK"}
    assert len([r for r in week.request.requirements if r.min_grade_level == 7 and r.student_group_id in classes]) == 3 * 11
    assert week.facts["groupSubjects"] == 10


def test_the_same_number_for_every_year_is_the_week_group_subjects_builds() -> None:
    plain = corpus.build_week(replace(SMALL, classes_per_year=3, languages=None, group_subjects=3))
    by_year = corpus.build_week(replace(SMALL, classes_per_year=3, languages=None, group_subjects_by_year=(3, 3, 3)))
    assert by_year.request.requirements == plain.request.requirements
    assert by_year.request.group_conflicts == plain.request.group_conflicts
    assert by_year.request.rooms == plain.request.rooms
    assert by_year.name == plain.name + "-y3.3.3"


def test_a_number_for_every_year_or_none() -> None:
    for bad in ((3, 3), (3, 3, 3, 3), (0, 11, 0), (0, -1, 0)):
        with pytest.raises(ValueError, match="group_subjects_by_year"):
            corpus.build_week(replace(SMALL, group_subjects_by_year=bad))


def test_the_sweep_has_a_week_of_a_whole_school_and_the_engine_takes_it() -> None:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    school = [s for s in corpus.sweep_shapes(seeds=(1,)) if s.group_subjects_by_year is not None]
    assert len(school) == 1
    week = corpus.build_week(school[0])
    assert week.facts["classes"] == 30
    assert week.facts["lessons"] > 800
    assert 3500 < week.facts["groupConflicts"] <= corpus.ENGINE_GROUP_CONFLICTS_LIMIT
    assert week.facts["requirements"] > 350
    assert solver.check_week(week.request).verdict != "IMPOSSIBLE"
    model, *_ = solver._build_model(week.request, use_assumptions=False, include_objective=False)
    assert len(model.Proto().constraints) > 50_000
