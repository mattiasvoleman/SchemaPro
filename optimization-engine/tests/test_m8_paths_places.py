"""`_pinned` of benchmarks/m8_paths.py pins a lesson at the place of its post that is its own (M8).

`pinnedLessons` has one place for each lesson of a requirement, and the places are in the order of
`lesson_minutes()` (the longest lesson first); for a split post (`lessonTeacherIds`) place i is lead i's. The
road's lessons come back in no such order, and `_pinned` used to line them up by the clock. For a post whose
lessons are all as long as each other, and have one lead, the two orders are the same and nothing was wrong:
that is every post of the corpus today. A post of a 90- and a 60-minute lesson, laid 60 on Monday and 90 on
Tuesday, was pinned as a Monday of 90 and a Tuesday of 60: another timetable than the one the road laid, which
the engine (it holds the start of a pin, not its end) may accept or refuse for reasons of its own, and
`verified` would then answer for that one.
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402
from app.schemas.schedule import ScheduledLesson  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)


def _post(**changes):
    """A requirement of the corpus with its fields changed as a copy does it (the copy does not validate)."""
    return build_week(TINY).request.requirements[0].model_copy(update=changes)


def _lesson(post, day: int, start: str, end: str, teacher=None) -> ScheduledLesson:
    return ScheduledLesson(
        requirementId=post.id, dayOfWeek=day, startTime=start, endTime=end, **({"teacherId": teacher} if teacher else {}),
    )


def _held(post, lessons):
    (pinned,) = paths._pinned([post], lessons)
    return [(place.day_of_week, place.start_time, place.end_time) for place in pinned.pinned_lessons]


def test_a_post_of_two_lengths_has_its_longest_lesson_at_its_first_place() -> None:
    post = _post(lessons_per_week=2, minutes_per_lesson=90, lesson_lengths=[60, 90])
    monday_60 = _lesson(post, 1, "08:00:00", "09:00:00")
    tuesday_90 = _lesson(post, 2, "10:00:00", "11:30:00")
    assert _held(post, [monday_60, tuesday_90]) == [(2, "10:00:00", "11:30:00"), (1, "08:00:00", "09:00:00")]
    assert _held(post, [tuesday_90, monday_60]) == _held(post, [monday_60, tuesday_90])


def test_the_lessons_of_a_post_of_one_length_stay_in_the_order_of_the_clock() -> None:
    post = _post(lessons_per_week=3, lesson_lengths=None)
    minutes = post.minutes_per_lesson
    end = f"{8 + minutes // 60:02d}:{minutes % 60:02d}:00"
    lessons = [_lesson(post, day, "08:00:00", end) for day in (4, 1, 3)]
    assert [place[0] for place in _held(post, lessons)] == [1, 3, 4]


def test_a_split_post_pins_each_lead_s_lesson_at_that_lead_s_place() -> None:
    first, second = uuid4(), uuid4()
    post = _post(lessons_per_week=2, lesson_lengths=None, lesson_teacher_ids=[first, second])
    minutes = post.minutes_per_lesson
    end = f"{8 + minutes // 60:02d}:{minutes % 60:02d}:00"
    seconds_on_monday = _lesson(post, 1, "08:00:00", end, teacher=second)
    firsts_on_tuesday = _lesson(post, 2, "08:00:00", end, teacher=first)
    assert [place[0] for place in _held(post, [seconds_on_monday, firsts_on_tuesday])] == [2, 1]
