"""What the manual and DEPLOYMENT section 35.2 say of shared teachers, held to the engine (M5 del 3, review of #395).

The measurement's JSON says which weeks timed out; it cannot say why a week the corpus left out is not in it. The
sentences below stand on the engine's own year count (`check_week`), and on how the corpus builds its shared teachers,
so that the manual's "three of them are already refused" and its rows' "three to four" and "five to eight" are tied to
the code and not to a run of the author's.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402


def _verdict(classes: int, shared: int, per_teacher: int = 3) -> tuple[str, list[tuple[int, int]]]:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    shape = corpus.with_classes(
        corpus.BASE, classes, shared_teachers=shared, groups_per_shared_teacher=per_teacher, seed=1,
    )
    answer = solver.check_week(corpus.build_week(shape).request)
    return answer.verdict, [(year.year, year.percent) for year in answer.years]


def test_teachers_on_three_parallel_groups_one_fits_two_are_tight_three_are_refused() -> None:
    """The manual: two teachers on three parallel groups each time out (the year is 95 % full), and three
    already make the week one the engine refuses (105 %), at nine classes and at twelve."""
    for classes in (9, 12):
        assert _verdict(classes, 1)[0] == "OK"
        assert _verdict(classes, 2) == ("TIGHT", [(7, 95)])
        assert _verdict(classes, 3) == ("IMPOSSIBLE", [(7, 105)])


def test_teachers_on_two_parallel_groups_are_fine_and_nine_classes_hold_three_and_five_of_them() -> None:
    """The rows of four and eight shared teachers: at twelve classes the week has four and eight, at nine it has
    three and five, so the manual says "three to four" and "five to eight"."""
    for asked, nine, twelve in ((4, 3, 4), (8, 5, 8)):
        for classes, held in ((9, nine), (12, twelve)):
            shape = corpus.with_classes(
                corpus.BASE, classes, shared_teachers=asked, groups_per_shared_teacher=2, seed=1,
            )
            assert corpus.build_week(shape).facts["sharedTeachers"] == held
            assert _verdict(classes, asked, per_teacher=2)[0] == "OK"


def test_the_fifteen_and_the_eighteen_class_weeks_have_three_shared_teachers_on_four_groups_each() -> None:
    """The row "15 or 18 classes" is not the class count alone: from fifteen classes the språkval has four groups
    to a language, and its three teachers each stand on four parallel groups of one class."""
    for classes in (12, 15, 18):
        week = corpus.build_week(corpus.with_classes(corpus.BASE, classes, seed=1))
        shared = corpus.shared_teacher_ids_of(week.request)
        groups = Counter(r.teacher_id for r in week.request.requirements if r.teacher_id in shared)
        assert sorted(groups.values()) == ([] if classes == 12 else [4, 4, 4])
        assert week.facts["sharedTeachers"] == len(shared)
