"""benchmarks/school_corpus.py: the corpus of weeks shaped like real schools (M5).

The corpus is what the nightly gate and the limits table measure, so what these
tests hold is that a shape builds the week it names: the axes (N classes, M
shared teachers, groups across classes, språkval, terms) are what they say, a
shape builds the same bytes every time, and a shape the engine would refuse is
refused here with the numbers, never sent.
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week, shared_teachers_of  # noqa: E402

SMALL = SchoolShape(classes_per_year=2, group_subjects=3)


def _class_ids(week) -> set[uuid.UUID]:
    return {group.id for group in week.request.groups}


def test_the_same_shape_builds_the_same_bytes_and_another_seed_another_pupil_graph() -> None:
    shape = replace(SMALL, classes_per_year=5, group_subjects=4, languages=None)
    first = build_week(shape).request.model_dump_json()
    assert build_week(shape).request.model_dump_json() == first
    other = build_week(replace(shape, seed=2)).request
    assert other.model_dump_json() != first
    # What a seed moves is who sits with whom, never the staffing or the hours.
    base = build_week(shape).request
    assert [r.id for r in other.requirements] == [r.id for r in base.requirements]
    assert sorted(map(tuple, other.group_conflicts)) != sorted(map(tuple, base.group_conflicts))


def test_n_is_the_classes_of_every_year_and_pupils_follow() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, years=(7, 8)))
    assert week.facts["classes"] == 8
    assert len(week.request.groups) == 8
    assert week.facts["pupils"] == 8 * SMALL.pupils_per_class


def test_with_no_groups_across_classes_and_no_språkval_nothing_shares_a_pupil() -> None:
    """The earlier benches' form: every lesson is a class's, so there is no pair at all."""
    week = build_week(replace(SMALL, group_subjects=0, languages=0))
    assert week.request.group_conflicts == []
    classes = _class_ids(week)
    assert {r.student_group_id for r in week.request.requirements} <= classes
    assert week.facts["sharedTeachers"] == 0


def test_a_group_subject_has_one_group_per_class_and_each_group_pairs_with_every_class_of_its_year() -> None:
    shape = replace(SMALL, classes_per_year=4, group_subjects=2, languages=0, mixing=1.0)
    week = build_week(shape)
    classes = _class_ids(week)
    pairs = {frozenset(pair) for pair in week.request.group_conflicts}
    year7 = {g.id for g in week.request.groups if g.min_grade_level == 7}
    groups = [r for r in week.request.requirements if r.student_group_id not in classes and r.min_grade_level == 7]
    assert len(groups) == 2 * 4  # two group subjects, four groups each
    for requirement in groups:
        assert {c for c in year7 if frozenset((requirement.student_group_id, c)) in pairs} == year7


def test_mixing_zero_makes_a_group_a_class_and_one_makes_it_draw_from_every_class() -> None:
    """What `mixing` says about how many classes a group draws pupils from."""
    shape = replace(SMALL, classes_per_year=4, group_subjects=1, languages=0)

    def classes_per_group(mixing: float) -> list[int]:
        week = build_week(replace(shape, mixing=mixing))
        classes = _class_ids(week)
        pairs = {frozenset(pair) for pair in week.request.group_conflicts}
        year7 = {c for c in classes if next(g for g in week.request.groups if g.id == c).min_grade_level == 7}
        groups = [r.student_group_id for r in week.request.requirements
                  if r.student_group_id not in classes and r.min_grade_level == 7]
        return [sum(1 for c in year7 if frozenset((g, c)) in pairs) for g in groups]

    assert classes_per_group(0.0) == [1, 1, 1, 1]
    assert classes_per_group(1.0) == [4, 4, 4, 4]
    middle = classes_per_group(0.5)
    assert all(1 <= n <= 4 for n in middle) and sum(middle) > 4


def test_group_factor_makes_more_and_smaller_groups_in_a_group_subject() -> None:
    shape = replace(SMALL, classes_per_year=4, group_subjects=1, languages=0)
    plain = build_week(shape)
    small = build_week(replace(shape, group_factor=1.5))

    def sizes(week) -> list[int]:
        """The group subject's groups of year 7: the requirements smaller than a class."""
        return sorted(
            r.student_group_size for r in week.request.requirements
            if r.min_grade_level == 7 and r.student_group_size < 22
        )

    assert sizes(plain) == []
    assert len(sizes(small)) == 6  # four classes of 22 cut into six groups of 14-15
    assert all(14 <= n <= 15 for n in sizes(small))
    with pytest.raises(ValueError, match="group_factor"):
        build_week(replace(shape, group_factor=0.5))


def test_the_groups_of_one_subject_share_no_pupil_with_each_other() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, group_subjects=1, languages=0))
    classes = _class_ids(week)
    pairs = {frozenset(pair) for pair in week.request.group_conflicts}
    soi = [r.student_group_id for r in week.request.requirements
           if r.student_group_id not in classes and r.min_grade_level == 8]
    assert len(set(soi)) == 4
    assert not any(frozenset((a, b)) in pairs for a in soi for b in soi if a != b)


def test_m_asks_for_shared_teachers_and_is_monotone_up_to_what_the_groups_can_carry() -> None:
    shape = replace(SMALL, classes_per_year=6, group_subjects=5, languages=0, groups_per_shared_teacher=5)
    counts = [build_week(replace(shape, shared_teachers=m)).facts["sharedTeachers"] for m in range(0, 40, 4)]
    # Six classes a year: each subject's eighteen groups are cut into runs of five, five, five and
    # three, so four teachers a subject can be shared and five subjects carry twenty in all.
    asked = list(range(0, 40, 4))
    assert counts == [min(m, 20) for m in asked]
    assert counts == sorted(counts)


def test_a_shared_teacher_stands_on_parallel_groups_of_one_subject_in_a_year_or_across_years() -> None:
    week = build_week(replace(SMALL, classes_per_year=6, group_subjects=1, languages=0, shared_teachers=1,
                              groups_per_shared_teacher=4))
    by_teacher: dict[uuid.UUID, int] = {}
    for requirement in week.request.requirements:
        if requirement.teacher_id is not None:
            by_teacher[requirement.teacher_id] = by_teacher.get(requirement.teacher_id, 0) + 1
    # One shared teacher with four groups; every other teacher of a group has one.
    group_teachers = [n for n in by_teacher.values() if n >= 2]
    assert 4 in group_teachers
    assert week.facts["sharedTeachers"] == 1


def test_språkval_groups_hold_every_pupil_once_and_their_teachers_are_shared_across_years() -> None:
    shape = replace(SMALL, classes_per_year=5, group_subjects=0, languages=4, language_teachers=2)
    week = build_week(shape)
    language = [r for r in week.request.requirements if r.subject_id not in {
        uuid.UUID(corpus._uid(f"subject-{code}")) for code, *_ in corpus.SUBJECTS
    }]
    assert len(language) == 4 * 3
    for year in (7, 8, 9):
        sizes = [r.student_group_size for r in language if r.min_grade_level == year]
        assert sum(sizes) == 5 * shape.pupils_per_class
    teachers = {r.teacher_id for r in language}
    assert len(teachers) == 2
    years_of = {t: {r.min_grade_level for r in language if r.teacher_id == t} for t in teachers}
    assert all(len(years) > 1 for years in years_of.values())
    # Two teachers on twelve groups that draw from every class: a språkval week that has timed out.
    assert week.facts["sharedTeachers"] == 2


def test_every_språkval_teacher_is_used_and_stands_on_groups_of_more_than_one_year() -> None:
    week = build_week(replace(SMALL, classes_per_year=3, group_subjects=0, languages=3, language_teachers=4))
    language = [r for r in week.request.requirements if r.subject_id not in {
        uuid.UUID(corpus._uid(f"subject-{code}")) for code, *_ in corpus.SUBJECTS
    }]
    years_of: dict[uuid.UUID, set[int]] = {}
    for requirement in language:
        years_of.setdefault(requirement.teacher_id, set()).add(requirement.min_grade_level)
    assert len(years_of) == 4
    assert all(len(years) >= 2 for years in years_of.values())


def test_the_default_språkval_never_makes_a_group_larger_than_a_classroom() -> None:
    for classes in (2, 3, 4, 6, 8):
        week = build_week(replace(SMALL, classes_per_year=classes, group_subjects=0, languages=None))
        assert max(r.student_group_size for r in week.request.requirements) <= 30


def test_a_language_block_puts_a_year_s_groups_in_one_block() -> None:
    shape = replace(SMALL, group_subjects=0, languages=3, language_block=True)
    week = build_week(shape)
    blocks = {r.min_grade_level: set() for r in week.request.requirements}
    for requirement in week.request.requirements:
        if requirement.block_id is not None:
            blocks[requirement.min_grade_level].add(requirement.block_id)
    assert all(len(ids) == 1 for ids in blocks.values())
    assert week.facts["languageGroups"] == 9
    assert all(r.block_id is None for r in build_week(replace(shape, language_block=False)).request.requirements)


def test_term_subjects_run_one_term_each_with_the_lessons_doubled() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, group_subjects=0, languages=0, term_subjects=2))
    termed = [r for r in week.request.requirements if r.periods is not None]
    assert week.facts["termRequirements"] == len(termed) == 2 * 4 * 3  # SL and HKK, four classes, three years
    assert {tuple(r.periods) for r in termed} == {(True, False), (False, True)}
    autumn = [r for r in termed if r.periods == (True, False)]
    assert len(autumn) == len(termed) // 2
    for requirement in termed:
        assert requirement.lessons_per_week % 2 == 0
    assert all(r.periods is None for r in week.request.requirements if r not in termed)


def test_a_shape_the_engine_would_refuse_is_refused_with_the_numbers() -> None:
    with pytest.raises(ValueError, match=r"group pairs, the engine takes 5000"):
        build_week(replace(SMALL, classes_per_year=10, group_subjects=9, mixing=1.0))
    with pytest.raises(ValueError, match=r"a group of 33 pupils fits no room"):
        build_week(replace(SMALL, classes_per_year=3, group_subjects=0, languages=2))


def test_the_corpus_week_passes_the_engine_s_own_validation_without_a_solve() -> None:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    for shape in (
        SMALL,
        replace(SMALL, classes_per_year=3, shared_teachers=2, term_subjects=2, language_block=True,
                languages=None),
        replace(SMALL, group_subjects=0, languages=0),
    ):
        week = build_week(shape)
        solver._validate_request(week.request)  # a refusal here is the corpus's fault
        assert solver._estimate_model_size(week.request) > 0


def test_shared_teachers_are_the_ones_the_engine_s_own_year_load_names() -> None:
    """Held to the engine, so the table's M is the number the product's warning counts."""
    for shape in (
        replace(SMALL, classes_per_year=4, group_subjects=5, shared_teachers=4, languages=0),
        replace(SMALL, classes_per_year=3, group_subjects=2, shared_teachers=2, languages=3, language_teachers=1),
        replace(SMALL, group_subjects=0, languages=2, language_teachers=1),
    ):
        request = build_week(shape).request
        solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
        # Every year, however light: the list is named only for a year above the threshold.
        solver.TIGHT_WEEK_LOAD = 0.0
        loads = solver._week_loads(request)
        engine = {teacher.teacher_id for load in loads for teacher in load.shared}
        assert corpus.shared_teacher_ids_of(request) == engine, shape


def test_the_sweep_has_no_week_twice_and_every_week_is_buildable_and_inside_the_engine_s_limits() -> None:
    shapes = corpus.sweep_shapes(seeds=(1,))
    names = [shape.name() for shape in shapes]
    assert len(set(names)) == len(names)
    assert len(shapes) > 30
    for shape in shapes:
        facts = build_week(shape).facts
        assert facts["groupConflicts"] <= corpus.ENGINE_GROUP_CONFLICTS_LIMIT
        assert facts["requirements"] <= corpus.ENGINE_REQUIREMENTS_LIMIT


def test_the_sweep_moves_each_axis_from_the_base_and_reaches_the_production_school() -> None:
    shapes = {shape.name(): shape for shape in corpus.sweep_shapes(seeds=(1,))}
    base = corpus.BASE
    # N alone, G alone, M alone from the base at twelve classes.
    assert "n12-g3-m0-s1" in shapes
    assert shapes["n12-g3-m0-s1"] == corpus.with_classes(base, 12, seed=1)
    assert {s.group_subjects for s in shapes.values() if s.classes == 12} >= {0, 2, 3, 4, 5, 6, 8, 10}
    assert {s.shared_teachers for s in shapes.values() if s.classes == 12} >= {0, 2, 4, 8}
    assert max(s.classes for s in shapes.values() if s.group_subjects == 0) == 24
    production = [s for s in shapes.values() if s.group_subjects == 10 and s.half_groups]
    assert production and all(s.term_subjects == 5 and s.day[2] == 5 for s in production)


def test_the_production_form_is_where_the_production_school_stands_against_the_engine_s_limit() -> None:
    """At fifteen classes the production form needs more group pairs than the engine takes: a real
    school of that form is within a few classes of that wall."""
    ok = build_week(corpus.with_classes(corpus.PRODUCTION, 12))
    assert 3000 < ok.facts["groupConflicts"] <= corpus.ENGINE_GROUP_CONFLICTS_LIMIT
    with pytest.raises(ValueError, match="group pairs"):
        build_week(corpus.with_classes(corpus.PRODUCTION, 15))


def test_profile_names_are_checked() -> None:
    with pytest.raises(ValueError, match="gate', 'sweep' or 'cliff"):
        corpus.profile("night")


def test_the_gate_s_weeks_are_in_the_sweep_with_sizes_and_kinds_to_see_a_change_in() -> None:
    shapes = corpus.profile("gate")
    names = [shape.name() for shape in shapes]
    assert names == list(corpus.GATE_WEEKS) and len(set(names)) == len(names)
    assert 12 <= len(shapes) <= 20
    assert {shape.classes for shape in shapes} >= {9, 12, 18, 24}
    assert any(shape.term_subjects for shape in shapes) and any(shape.language_block for shape in shapes)
    assert any(shape.group_subjects == 0 for shape in shapes) and any(shape.group_subjects >= 4 for shape in shapes)
    # Weeks the engine refuses on arithmetic alone are not in the corpus (test_school_corpus_sweep.py),
    # so none stands guard: the gate's weeks are all weeks the search can find a timetable for.
    assert not any(shape.shared_teachers >= 4 for shape in shapes)


def test_a_gate_week_the_sweep_no_longer_has_is_an_error_and_not_a_shorter_gate(monkeypatch) -> None:
    monkeypatch.setattr(corpus, "GATE_WEEKS", (*corpus.GATE_WEEKS, "n99-g9-m9-s9"))
    with pytest.raises(ValueError, match="n99-g9-m9-s9"):
        corpus.gate_shapes()
