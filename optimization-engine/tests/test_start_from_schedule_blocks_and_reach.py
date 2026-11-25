"""Ett schema som start, granskningen av #460: the two things of staged.py no test of the PR reaches.

`with_blocks` (a block is held whole or let go whole: one member let go with the others held is refused by name,
`PLACED_LESSONS_OF_BLOCK_DIFFER`, and costs a round for each member) and the two directions of `neighbours`' reach
along `groupConflicts`. Lines 156, 168, 256 and 258 of staged.py ran in no test: a driver that let a block go one
member at a time, or widened along a pair in one direction only, passed all 25.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

from app.schemas.schedule import StartedLesson  # noqa: E402
from app.solver import staged  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _clock(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}:00"


def test_a_block_is_let_go_whole_when_one_member_is() -> None:
    request = build_week(replace(SHAPE, language_block=True)).request
    block = next(r.block_id for r in request.requirements if r.block_id is not None)
    members = {r.id for r in request.requirements if r.block_id == block}
    assert len(members) >= 2
    outsider = next(r.id for r in request.requirements if r.block_id is None)
    one = next(iter(members))

    assert staged.with_blocks(request, {one}) == members
    assert staged.with_blocks(request, {outsider}) == {outsider}
    assert staged.with_blocks(request, {one, outsider}) == members | {outsider}
    assert staged.with_blocks(request, set()) == set()


def test_a_clash_of_one_member_of_a_block_frees_the_whole_block() -> None:
    request = build_week(replace(SHAPE, language_block=True)).request
    block = next(r.block_id for r in request.requirements if r.block_id is not None)
    members = [r for r in request.requirements if r.block_id == block]
    # The block is held whole and together; one member's teacher is also on another requirement at that very time.
    entries = []
    for member in members:
        for place in range(member.lessons_per_week):
            entries.append(StartedLesson(requirementId=member.id, dayOfWeek=1 + place, startTime="08:00:00", endTime=_clock(480 + member.lesson_minutes()[place])))
    other = next(r for r in request.requirements if r.block_id is None and r.teacher_id is not None and r.teacher_id != members[0].teacher_id)
    other = other.model_copy(update={"teacher_id": members[0].teacher_id, "lessons_per_week": 1})
    entries.append(StartedLesson(requirementId=other.id, dayOfWeek=1, startTime="08:00:00", endTime=_clock(480 + other.lesson_minutes()[0])))
    only = request.model_copy(update={
        "requirements": [*members, other], "start_lessons": entries, "group_conflicts": [], "constraints": [],
    })
    held = staged.held_places(only)
    assert set(held.places) == {m.id for m in members} | {other.id}

    free = staged.with_blocks(only, staged.clashes(only, held))

    assert {m.id for m in members} <= free, "the block goes whole"
    assert other.id in free


def test_the_reach_of_a_free_group_goes_along_a_pair_in_both_directions() -> None:
    request = build_week(SHAPE).request
    a = request.requirements[0]
    b = next(r for r in request.requirements if r.student_group_id != a.student_group_id and r.teacher_id != a.teacher_id)
    pair = request.model_copy(update={"requirements": [a, b], "group_conflicts": [(a.student_group_id, b.student_group_id)]})

    assert staged.neighbours(pair, {a.id}, {b.id}) == {b.id}, "from the first group of the pair to the second"
    assert staged.neighbours(pair, {b.id}, {a.id}) == {a.id}, "and from the second to the first"
    alone = pair.model_copy(update={"group_conflicts": []})
    assert staged.neighbours(alone, {a.id}, {b.id}) == set()
