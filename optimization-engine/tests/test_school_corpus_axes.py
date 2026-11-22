"""The axes of benchmarks/school_corpus.py that test_school_corpus.py leaves without a test (M5).

Found by mutating the generator: each of these is a line whose change the first 21 tests did
not notice (block_subjects, the level subjects, one term for the groups of a subject, the odd
class count of a term split, the pool of teachers a class-form subject has, the rooms, the
frame and the lunch, the limit on requirements). A table that says "N classes, M shared
teachers" is only as true as the week behind each row.
"""

from __future__ import annotations

import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import replace
from math import ceil
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SMALL = SchoolShape(classes_per_year=2, group_subjects=3)
CODE_OF = {uuid.UUID(corpus._uid(f"subject-{code}")): code for code, *_ in corpus.SUBJECTS}


def _code(requirement) -> str | None:
    return CODE_OF.get(requirement.subject_id)


def _pairs(week) -> set[frozenset]:
    return {frozenset(pair) for pair in week.request.group_conflicts}


def _classes_drawn_from(week, group, year: int) -> int:
    pairs = _pairs(week)
    classes = [g.id for g in week.request.groups if g.min_grade_level == year]
    return sum(1 for c in classes if frozenset((group, c)) in pairs)


def test_block_subjects_run_the_groups_with_a_teacher_of_their_own_as_one_block_per_year_and_subject() -> None:
    shape = replace(
        SMALL, classes_per_year=4, group_subjects=3, languages=0, block_subjects=True,
        shared_teachers=1, groups_per_shared_teacher=2,
    )
    week = build_week(shape)
    assert week.facts["blockedRequirements"] > 0
    blocks: dict[uuid.UUID, list] = defaultdict(list)
    for requirement in week.request.requirements:
        if requirement.block_id is not None:
            blocks[requirement.block_id].append(requirement)
    assert len(blocks) == 3 * 3  # three years x three group subjects
    for members in blocks.values():
        assert len({r.min_grade_level for r in members}) == 1
        assert len({r.subject_id for r in members}) == 1
        # One teacher cannot stand in two groups that run at the same time.
        assert len({r.teacher_id for r in members}) == len(members)
    # The subject whose first two groups share a teacher keeps those two out of the block.
    so_year7 = [r for r in week.request.requirements if _code(r) == "SO" and r.min_grade_level == 7]
    shared = Counter(r.teacher_id for r in so_year7)
    assert any(n == 2 for n in shared.values())
    assert all(r.block_id is None for r in so_year7 if shared[r.teacher_id] > 1)
    assert all(r.block_id is None for r in build_week(replace(shape, block_subjects=False)).request.requirements)


def test_the_level_subjects_draw_from_every_class_and_the_others_only_as_far_as_mixing_says() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, group_subjects=10, mixing=0.0, languages=0))
    classes = {g.id for g in week.request.groups}
    drawn: dict[str, set[int]] = defaultdict(set)
    for requirement in week.request.requirements:
        if requirement.student_group_id in classes or requirement.min_grade_level != 8:
            continue
        drawn[_code(requirement)].add(_classes_drawn_from(week, requirement.student_group_id, 8))
    # Written out and not read from the module: the test is what says which subjects are level groups.
    for code in ("MA", "EN", "SV"):
        assert drawn[code] == {4}, code  # level groups: pupils from every class of the year
    for code in ("SO", "NO", "IDH", "BL", "SL"):
        assert drawn[code] == {1}, code  # mixing 0: the group is a class
    assert set(drawn) == {"MA", "EN", "SV", "SO", "NO", "IDH", "BL", "SL", "HKK", "MU"}


def test_a_term_split_of_an_odd_number_of_units_gives_the_autumn_the_extra_one_and_doubles_the_lessons() -> None:
    week = build_week(replace(SMALL, classes_per_year=3, group_subjects=0, languages=0, term_subjects=1))
    termed = [r for r in week.request.requirements if r.periods is not None]
    assert {_code(r) for r in termed} == {"SL"}  # the first of TERM_ORDER
    for year in (7, 8, 9):
        mine = [r.periods for r in termed if r.min_grade_level == year]
        assert sorted(mine) == [(False, True), (True, False), (True, False)]
    base_lessons = dict((code, lessons) for code, lessons, *_ in corpus.SUBJECTS)["SL"]
    assert {r.lessons_per_week for r in termed} == {2 * base_lessons}


def test_the_groups_of_a_term_subject_run_one_term_each() -> None:
    """BL is the fourth group subject and the third term subject: its groups carry the periods."""
    week = build_week(replace(SMALL, classes_per_year=4, group_subjects=4, languages=0, term_subjects=3))
    bl = [r for r in week.request.requirements if _code(r) == "BL" and r.min_grade_level == 7]
    assert len(bl) == 4
    assert sorted(r.periods for r in bl) == [(False, True), (False, True), (True, False), (True, False)]
    assert all(r.lessons_per_week == 2 for r in bl)


def test_half_groups_double_the_groups_of_hemkunskap_and_musik_and_no_other_subject() -> None:
    week = build_week(replace(SMALL, classes_per_year=3, group_subjects=6, languages=0, half_groups=True))
    per_subject = Counter(_code(r) for r in week.request.requirements if r.min_grade_level == 7)
    assert per_subject["HKK"] == 6
    assert per_subject["MU"] == 6
    assert {per_subject[code] for code in ("SO", "NO", "IDH", "BL")} == {3}
    # Halves are half a class: 22 pupils a class, six groups of 11.
    assert {r.student_group_size for r in week.request.requirements if _code(r) in {"HKK", "MU"}} == {11}


def test_a_one_class_year_still_has_two_groups_in_a_group_subject() -> None:
    week = build_week(replace(SMALL, classes_per_year=1, group_subjects=1, languages=0))
    assert sum(1 for r in week.request.requirements if _code(r) == "SO" and r.min_grade_level == 7) == 2


def test_the_default_språkval_has_a_teacher_for_every_four_groups_of_the_years_together() -> None:
    week = build_week(replace(SMALL, classes_per_year=5, group_subjects=0, languages=None))
    language = [r for r in week.request.requirements if _code(r) is None]
    assert len(language) == 4 * 3  # max(2, 5 - 1, ceil(110 / 30)) groups a year
    assert len({r.teacher_id for r in language}) == 3
    assert {(r.lessons_per_week, r.minutes_per_lesson) for r in language} == {(2, 60)}


def test_a_shared_teacher_stands_on_at_least_two_groups_even_when_asked_for_one() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, group_subjects=2, languages=0,
                              shared_teachers=2, groups_per_shared_teacher=1))
    assert week.facts["sharedTeachers"] == 2


def test_a_class_form_subject_has_one_teacher_for_every_twenty_lessons_and_each_is_used() -> None:
    week = build_week(replace(SMALL, classes_per_year=6, group_subjects=0, languages=0))
    lessons: dict[str, int] = defaultdict(int)
    by_teacher: dict[str, Counter] = defaultdict(Counter)
    for requirement in week.request.requirements:
        code = _code(requirement)
        lessons[code] += requirement.lessons_per_week
        by_teacher[code][requirement.teacher_id] += requirement.lessons_per_week
    for code, total in lessons.items():
        pool = by_teacher[code]
        assert len(pool) == ceil(total / 20), code  # twenty lessons a teacher
        # Dealt round the pool, so no teacher is more than a class's lessons over their share.
        class_lessons = dict((c, n) for c, n, *_ in corpus.SUBJECTS)[code]
        assert max(pool.values()) <= ceil(total / len(pool)) + 2 * class_lessons, code


def test_the_rooms_are_the_classes_plus_four_and_the_subject_rooms_scaled_to_the_classes() -> None:
    week = build_week(replace(SMALL, classes_per_year=4, languages=0))  # 12 classes
    kinds = Counter(room.type for room in week.request.rooms)
    assert kinds["CLASSROOM"] == 12 + 4
    assert {kind: kinds[kind] for kind in corpus.ROOM_TYPES} == {
        "LABORATORY": 2, "GYMNASIUM": 2, "ART": 1, "MUSIC": 1, "WORKSHOP": 2, "KITCHEN": 1,
    }
    assert {room.capacity for room in week.request.rooms} == {32}
    wanted = {code: room for code, _lessons, _minutes, room in corpus.SUBJECTS}
    for requirement in week.request.requirements:
        code = _code(requirement)
        assert requirement.required_room_type == wanted[code], code


def test_the_day_the_changeover_and_the_lunch_are_the_shapes_and_every_class_eats() -> None:
    shape = replace(SMALL, day=("08:15:00", "16:00:00", 5), lunch=("10:30:00", "13:00:00", 15))
    request = build_week(shape).request
    assert {(f.start_time, f.end_time, f.changeover_minutes) for f in request.frame_times} == {
        ("08:15:00", "16:00:00", 5)
    }
    assert (request.rules.lunch_start_time, request.rules.lunch_end_time, request.rules.lunch_minutes) == (
        "10:30:00", "13:00:00", 15,
    )
    assert {(f.min_grade_level, f.max_grade_level) for f in request.frame_times} == {(7, 9)}
    assert {g.lunch_headcount for g in request.groups} == {shape.pupils_per_class}
    assert request.rules.max_lessons_per_day_per_group == 7


def test_a_shape_with_more_requirements_than_the_engine_takes_is_refused_with_the_numbers() -> None:
    with pytest.raises(ValueError, match=r"requirements, the engine takes 2000"):
        build_week(replace(SMALL, classes_per_year=61, group_subjects=0, languages=0))


def test_the_facts_count_what_the_request_holds() -> None:
    week = build_week(replace(SMALL, classes_per_year=3, group_subjects=2, languages=3, language_block=True,
                              block_subjects=True, term_subjects=2))
    request = week.request
    assert week.facts["lessons"] == sum(r.lessons_per_week for r in request.requirements)
    assert week.facts["blockedRequirements"] == sum(1 for r in request.requirements if r.block_id is not None) > 0
    assert week.facts["termRequirements"] == sum(1 for r in request.requirements if r.periods is not None) > 0
    assert week.facts["groupConflicts"] == len(request.group_conflicts)
    assert week.facts["teachers"] == len({r.teacher_id for r in request.requirements})
