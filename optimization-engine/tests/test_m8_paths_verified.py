"""`verified` in benchmarks/m8_paths.py (M8): what it says, and that it can say no.

The design note stands on one word: a road's result is `verified` when the engine itself accepts the
whole week with EVERY lesson pinned where the road laid it. test_m8_paths.py only ever asks for
`verified is True`, so a `_verify` that always answered yes, one that pinned nothing, or one that
left a lesson free would have passed every test there. These hold the three halves of the word:

  * the request `_verify` hands the engine pins every lesson of every requirement, once, where it was laid;
  * a schedule with two of a class's lessons at one time is NOT verified (the engine says no, and the
    script carries it);
  * a schedule with a lesson missing or laid twice is refused before the engine is asked.
"""

from __future__ import annotations

import sys
import types
from collections import Counter
from itertools import combinations
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)
ARGS = types.SimpleNamespace(det_budget=5.0)

_LAID: dict[str, tuple] = {}


def _week_and_lessons():
    """TINY and a timetable the engine laid for it (once: it is the same for every test here)."""
    if "tiny" not in _LAID:
        week = build_week(TINY)
        stage = paths.run_stage(
            week.request, label="laid", free=0, encoding="pairs", cohorts=week.cohorts, mode="count",
            budget=0, deterministic_budget=5, seed=1,
        )
        assert stage.status == "FIRST_SCHEDULE", stage.row()
        _LAID["tiny"] = (week, list(stage.lessons))
    week, lessons = _LAID["tiny"]
    return week, list(lessons)


def _minutes(clock: str) -> int:
    return int(clock[:2]) * 60 + int(clock[3:5])


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def test_the_engines_own_timetable_is_verified() -> None:
    week, lessons = _week_and_lessons()
    assert paths._verify(week, lessons, ARGS) is True


def test_verify_asks_the_engine_with_every_lesson_pinned_where_it_was_laid(monkeypatch: pytest.MonkeyPatch) -> None:
    week, lessons = _week_and_lessons()
    asked: list = []

    def fake_stage(request, **_ignored):
        asked.append(request)
        return paths.Stage(
            label="verify", status="FIRST_SCHEDULE", lessons_asked=0, lessons_free=0, seconds=None, work=None,
            wall=0.0, load=(0.0, 0.0), codes=[],
        )

    monkeypatch.setattr(paths, "run_stage", fake_stage)
    assert paths._verify(week, lessons, ARGS) is True
    assert len(asked) == 1
    request = asked[0]
    # The whole week, not a part of it.
    assert [r.id for r in request.requirements] == [r.id for r in week.request.requirements]
    laid = Counter()
    for lesson in lessons:
        laid[(lesson.requirement_id, lesson.day_of_week, lesson.start_time, lesson.end_time)] += 1
    pinned = Counter()
    for requirement in request.requirements:
        places = requirement.pinned_lessons
        assert places is not None, f"{requirement.id}: nothing is pinned"
        assert len(places) == requirement.lessons_per_week
        assert all(place is not None for place in places), f"{requirement.id}: a lesson is left free"
        for place in places:
            pinned[(requirement.id, place.day_of_week, place.start_time, place.end_time)] += 1
    assert pinned == laid, "the engine is asked about a timetable other than the one the road laid"


def test_a_class_with_two_lessons_at_one_time_is_not_verified() -> None:
    week, lessons = _week_and_lessons()
    group_of = {r.id: r.student_group_id for r in week.request.requirements}
    # Two posts of one class (a group of a subject in groups has one post, a class has a post for each subject).
    first, other = next(
        (a, b) for a, b in combinations(lessons, 2)
        if a.requirement_id != b.requirement_id and group_of[a.requirement_id] == group_of[b.requirement_id]
    )
    length = _minutes(other.end_time) - _minutes(other.start_time)
    moved = [
        lesson.model_copy(update={
            "day_of_week": first.day_of_week, "start_time": first.start_time,
            "end_time": _clock(_minutes(first.start_time) + length),
        }) if lesson is other else lesson
        for lesson in lessons
    ]
    assert paths._verify(week, moved, ARGS) is False


def test_a_lesson_missing_or_laid_twice_is_refused_before_the_engine_is_asked() -> None:
    week, lessons = _week_and_lessons()
    with pytest.raises(ValueError, match="lessons laid"):
        paths._verify(week, lessons[1:], ARGS)
    with pytest.raises(ValueError, match="lessons laid"):
        paths._verify(week, [*lessons, lessons[0]], ARGS)
