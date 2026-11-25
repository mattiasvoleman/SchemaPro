"""The repair of benchmarks/m8_paths.py: what a refusal that names held lessons lets go of (M8).

test_m8_paths.py hands the roads `repair=2` and `repair=3`, but the weeks it uses never refuse, so the loop that
lets go of the held lessons a refusal names (`_run_with_repair`, the heart of every road that cuts the week
and of the M9 start) never turned in a test. The engine is stood in for here: it answers INFEASIBLE, naming a
held post or none, and then lays the week; what is held is read off the requests that were asked.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)
_CACHE: dict[str, tuple] = {}


def _laid():
    """TINY, a timetable the engine laid for it, and that timetable's lessons by requirement."""
    if "tiny" not in _CACHE:
        week = build_week(TINY)
        stage = paths.run_stage(
            week.request, label="laid", free=0, encoding="pairs", cohorts=week.cohorts, mode="count",
            budget=0, deterministic_budget=5, seed=1,
        )
        assert stage.status == "FIRST_SCHEDULE", stage.row()
        by_requirement: dict = {}
        for lesson in stage.lessons:
            by_requirement.setdefault(lesson.requirement_id, []).append(lesson)
        _CACHE["tiny"] = (week, list(stage.lessons), by_requirement)
    return _CACHE["tiny"]


def _args(repair: int) -> types.SimpleNamespace:
    return types.SimpleNamespace(repair=repair, stage_encoding="pairs", mode="count", budget=0.0, det_budget=5.0)


def _answer(status: str, *, blamed=(), lessons=None) -> paths.Stage:
    return paths.Stage(
        label="stub", status=status, lessons_asked=0, lessons_free=0, seconds=None, work=None, wall=0.0,
        load=(0.0, 0.0), codes=[], lessons=lessons, blamed=frozenset(blamed),
    )


def _run(monkeypatch: pytest.MonkeyPatch, answers: list, *, repair: int, free_index: int = 0):
    week, lessons, laid = _laid()
    requirements = week.request.requirements
    free = [requirements[free_index]]
    held = [r for r in requirements if r.id != free[0].id]
    asked: list = []
    remaining = list(answers)

    def stand_in(request, **_ignored):
        asked.append(request)
        answer = remaining.pop(0)
        return answer if answer.status != "FIRST_SCHEDULE" else _answer("FIRST_SCHEDULE", lessons=lessons)

    monkeypatch.setattr(paths, "run_stage", stand_in)
    stage, wide = paths._run_with_repair(
        week, _args(repair), label="t", held=held, laid=laid, free=free, seed=1, stages=[],
    )
    return week, free, held, asked, stage, wide


def _pinned_ids(request) -> set:
    return {r.id for r in request.requirements if r.pinned_lessons is not None}


def test_a_refusal_that_names_a_held_post_lets_it_go_and_asks_again(monkeypatch: pytest.MonkeyPatch) -> None:
    week, lessons, _ = _laid()
    named = week.request.requirements[5].id
    _, free, held, asked, stage, wide = _run(
        monkeypatch, [_answer("INFEASIBLE", blamed={named}), _answer("FIRST_SCHEDULE")], repair=2,
    )
    assert stage.status == "FIRST_SCHEDULE"
    assert len(asked) == 2
    assert _pinned_ids(asked[0]) == {r.id for r in held}
    assert _pinned_ids(asked[1]) == {r.id for r in held} - {named}, "the post the refusal names is free the second time"
    assert {r.id for r in asked[1].requirements} == {r.id for r in week.request.requirements}, "nothing else left out"
    assert {r.id for r in wide} == {free[0].id, named}


def test_a_refusal_that_names_nothing_widens_to_the_posts_that_share_a_teacher_or_a_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    week, free, held, asked, stage, wide = _run(
        monkeypatch, [_answer("INFEASIBLE"), _answer("FIRST_SCHEDULE")], repair=2,
    )
    assert stage.status == "FIRST_SCHEDULE" and len(asked) == 2
    let_go = {r.id for r in held} - _pinned_ids(asked[1])
    assert let_go, "nothing was let go of"
    assert let_go == {r.id for r in paths._neighbours(week, free, held)}
    assert {r.id for r in wide} == {free[0].id} | let_go


def test_without_repair_rounds_the_refusal_is_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    *_, asked, stage, _wide = _run(monkeypatch, [_answer("INFEASIBLE")], repair=0)
    assert len(asked) == 1 and stage.status == "INFEASIBLE"


def test_a_search_that_ran_out_of_time_is_not_a_refusal_and_is_not_repaired(monkeypatch: pytest.MonkeyPatch) -> None:
    *_, asked, stage, _wide = _run(monkeypatch, [_answer("TIMEOUT")], repair=3)
    assert len(asked) == 1 and stage.status == "TIMEOUT"


def test_the_rounds_are_as_many_as_were_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    week, _, _ = _laid()
    named = week.request.requirements[5].id
    refusals = [_answer("INFEASIBLE", blamed={named}) for _ in range(5)]
    *_, asked, stage, _wide = _run(monkeypatch, refusals, repair=2)
    assert len(asked) == 3 and stage.status == "INFEASIBLE"
