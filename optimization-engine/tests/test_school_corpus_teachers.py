"""A corpus week has teachers who teach more than one group, as a school's do (M5).

A real school's teachers have many posts each. A corpus week where every group has a teacher of its
own (the generator's first form) has about one post to a teacher in the production form, and M = 0
or 2: no teacher's week couples the groups of one year to those of another, which is most of what a
teacher is to a timetable. Adding SHARED teachers (M) is not the way to get there: every shared
teacher of the production form puts the year over the engine's week load (check_week: IMPOSSIBLE),
because a shared teacher's groups are parallel by definition.
"""

from __future__ import annotations

import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

PRODUCTION_9 = corpus.with_classes(corpus.PRODUCTION, 9)


def _posts_per_teacher(week) -> float:
    return len(week.request.requirements) / len({r.teacher_id for r in week.request.requirements})


def test_a_team_of_subjects_has_one_teacher_for_the_same_numbered_group_of_every_year() -> None:
    plain = corpus.build_week(PRODUCTION_9)
    across = corpus.build_week(replace(PRODUCTION_9, subjects_per_teacher=1))
    pairs = corpus.build_week(replace(PRODUCTION_9, subjects_per_teacher=2))
    assert _posts_per_teacher(plain) < 1.2
    assert 3.0 < _posts_per_teacher(across) < 3.3
    assert 5.5 < _posts_per_teacher(pairs) < 6.0
    # Three years, so a group subject's teacher has a post in each year (the language teachers
    # and the class-form pool keep their own counts).
    posts = Counter(r.teacher_id for r in across.request.requirements)
    group_teachers = [n for n in posts.values() if n == 3]
    assert len(group_teachers) >= 30
    # No two groups of one teacher are parallel: the same pupils cannot be in both, and the
    # teacher is one person, so M stays what it was.
    assert across.facts["sharedTeachers"] == plain.facts["sharedTeachers"]


def test_a_teacher_of_several_subjects_and_years_is_not_a_second_kind_of_shared_teacher() -> None:
    week = corpus.build_week(replace(PRODUCTION_9, subjects_per_teacher=1))
    assert week.facts["sharedTeachers"] == 0
    assert week.facts["teachers"] < corpus.build_week(PRODUCTION_9).facts["teachers"] / 2


def test_the_sweep_has_the_production_form_with_teachers_who_teach_in_every_year() -> None:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    rungs = [s for s in corpus.sweep_shapes(seeds=(1,)) if s.subjects_per_teacher]
    assert sorted(s.subjects_per_teacher for s in rungs) == [1, 2]
    for shape in rungs:
        assert solver.check_week(corpus.build_week(shape).request).verdict != "IMPOSSIBLE", shape.name()
    assert replace(PRODUCTION_9, subjects_per_teacher=1).name() == "n9-g10-m0-s1-t5-q1-h"


def test_a_negative_team_size_is_refused() -> None:
    with pytest.raises(ValueError, match="subjects_per_teacher"):
        corpus.build_week(replace(PRODUCTION_9, subjects_per_teacher=-1))
