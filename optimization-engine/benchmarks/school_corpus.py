#!/usr/bin/env python3
"""A corpus of weeks shaped like real schools (omgång 13, M5 Riktiga veckor som mätstock).

    python benchmarks/school_corpus.py --list sweep
    python benchmarks/school_corpus.py --week n12-g3-m0-s1 > week.json

WHY A CORPUS. The four earlier bench schools (solve_2000_students.py,
validate_schedule.py, hogstadium.py, staff_60x400.py) give every class its own
lessons, and what they share is a block or a specialist room. A real school with every
year filled in is shaped otherwise. It is described here by its form and by no count that
would point to it (the repository is public: no name, no id, no figure of one school's):
in its upper years every subject but one is taught in groups that cut across the classes,
a pupil sits in about a dozen groups and most pairs of groups share a pupil, so that the
pairs are within a few classes of the engine's 5,000. Many of its teachers stand on
parallel groups that take pupils from the same class. Matematik, Engelska and Svenska are
level groups that draw from nearly every class of a year; the other subjects draw from about
half of them. Two subjects run in half groups, and about a quarter of the weekly minutes
are in posts that run one term only. That shape, and a språkval of three or four groups to
one teacher drawing pupils from every class, is what has made Generera answer TIMEOUT, and
no bench had it.

THE AXES are the ones a school can count itself (SchoolShape):

  N  classes          classes per year x the years
  M  shared teachers  teachers who stand on two or more parallel groups that
                      take pupils from the same class. This is the engine's own
                      reading (week_load._shared_teachers (a) and (b)), and
                      `shared_teachers_of` counts it from the request alone: over the
                      WHOLE request, a union. The engine counts per week (a period
                      times a parity), so for a week with terms the figure here can
                      be larger than any one of its weeks' (g386-L-5). The tables print this
                      figure (`facts["sharedTeachers"]`) and only for weeks without terms, where
                      it is the engine's own.
  G  group_subjects   how many of the year's ten subjects are taught in groups cut
                      across the classes (0 = every subject by class, the earlier
                      benches; the production school ten, Teknik aside)
  mixing, group_factor
                      how many classes a group draws its pupils from, and how big
                      the groups are against a class (a real school's: about half
                      the classes for the practical subjects, level groups from every class)
  languages           språkval groups per year, their teachers shared across the
                      years, with or without a block
  term_subjects       subjects that run one term only, half of the classes or
                      groups in the autumn and the other half in the spring
                      (`periods`, with the lessons doubled in their term)
  block_subjects      the groups that have a teacher of their own as one parallel block
  seed                who sits in which group. The pair graph is the same for every
                      seed when the groups are fully mixed and nearly every pair
                      shares a pupil; with `mixing` below one a seed is a different
                      week, as one school size is easy one week and hard the next.

THE WEEK ITSELF is the högstadium's (hogstadium.py): the same eleven subjects,
the same hours (a pupil's week is about 24 hours of the 40 the frame offers,
and a real school's is much the same), the same rooms scaled to the number of
classes, a planning afternoon for every teacher. It is written here, not imported
from there, so that the corpus does not move when that bench does: the nightly gate
compares one corpus against two engines. What it does not copy from the production
school is the length of its lessons (a school's run from 40 to 130 minutes: here every
lesson is one of the högstadium's), its rooms (the specialist rooms are single) and its
pupils (in a real year nearly every pupil's list of groups is a list of their own: the
corpus's are what `mixing` makes them).

DETERMINISTIC. Fixed ids, and a pseudo-random generator seeded from `seed`
and the label of what is drawn (never the process's), so the same shape gives
the same request byte for byte on every machine.

THE ENGINE'S OWN LIMITS APPLY. The engine takes at most 5,000 group pairs in a
request (`groupConflicts`; the gateway refuses with a named answer at that
number), and 2,000 requirements. A shape that needs more is refused here with
the numbers, never built: a corpus week that the engine would not take would
measure the refusal. The production form reaches the pair limit at about fifteen
classes.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import uuid
from collections import defaultdict
from dataclasses import dataclass, replace
from itertools import combinations
from pathlib import Path

# The engine tree to validate against: this one, or the one ENGINE_ROOT names (corpus_measure.py).
sys.path.insert(0, str(Path(os.environ.get("ENGINE_ROOT") or Path(__file__).resolve().parent.parent).resolve()))

from app.schemas.schedule import MAX_PERIODS, OptimizeScheduleRequest  # noqa: E402

#: Bump when a change to the generator changes what a shape builds, so a stored
#: result can tell which corpus it was measured on.
#:
#: 2 (M8, 2026-11-25): the week's name says a day that ends otherwise than at 16:00 (`-e1630`), so that a
#: shape that differs only in it is another week with another name and requestId (g386-L-1, for the one
#: field this version adds), and the cliff weeks exist (CLIFF_WEEKS). EVERY SHAPE OF VERSION 1 BUILDS THE
#: SAME WEEK: only its requestId moved, because the version is in it. test_school_corpus_pins.py holds the
#: v1 digests of the gate's thirteen weeks with the requestId left out, which is what "the gate's rows
#: have not changed meaning" is.
CORPUS_VERSION = 2

#: The engine's limits (schemas/schedule.py), repeated here so that a shape is
#: refused with the numbers before the request is built.
ENGINE_GROUP_CONFLICTS_LIMIT = 5000
ENGINE_REQUIREMENTS_LIMIT = 2000

_NS = uuid.UUID("5d1e6a0c-3c4b-4e8e-9a64-2f7b1c9d4e10")

#: (code, lessons a week, minutes, required room type). The högstadium's week.
SUBJECTS: tuple[tuple[str, int, int, str | None], ...] = (
    ("MA", 3, 60, None),
    ("SV", 3, 60, None),
    ("EN", 2, 60, None),
    ("NO", 3, 60, "LABORATORY"),
    ("SO", 3, 60, None),
    ("IDH", 2, 60, "GYMNASIUM"),
    ("BL", 1, 60, "ART"),
    ("MU", 1, 60, "MUSIC"),
    ("SL", 1, 90, "WORKSHOP"),
    ("HKK", 1, 60, "KITCHEN"),
    ("TK", 1, 60, None),
)
_BY_CODE = {code: (lessons, minutes, room) for code, lessons, minutes, room in SUBJECTS}

#: Which subjects move into groups first, as `group_subjects` grows: the order
#: the production school's groups come in (SO, NO, Hemkunskap, Musik, Idrott and
#: Bild are all groups in its åk 9, then the core subjects). Teknik stays on the
#: class, as it does there: the class keeps one post of its own.
GROUP_ORDER = ("SO", "NO", "IDH", "BL", "HKK", "MU", "SL", "MA", "EN", "SV")
#: The subjects the production school teaches in LEVEL groups, whose pupils come from
#: nearly every class of the year. The others' groups draw from about half of the
#: classes, which is `mixing` 0.5. A level subject is always fully mixed.
LEVEL_SUBJECTS = ("MA", "EN", "SV")
#: Subjects the production school runs in half groups (ten groups for five
#: classes), taken when `half_groups` is on.
HALF_GROUP_SUBJECTS = ("HKK", "MU")
#: Which subjects run one term only, as `term_subjects` grows: the practical ones.
TERM_ORDER = ("SL", "HKK", "BL", "MU", "TK")
#: Språkval: one two-lesson hour a week, as in hogstadium.py.
LANGUAGE_LESSONS = 2
LANGUAGE_MINUTES = 60
#: Lessons a week a class-form teacher is given (the pool per subject follows).
LESSONS_PER_TEACHER = 20

#: What a room holds, as in hogstadium.py.
ROOM_CAPACITY = 32
ROOM_TYPES = ("LABORATORY", "GYMNASIUM", "ART", "MUSIC", "WORKSHOP", "KITCHEN")
#: (rooms at 18 classes, scaled by classes/18 and rounded up), per type.
ROOMS_AT_18 = {"LABORATORY": 3, "GYMNASIUM": 2, "ART": 1, "MUSIC": 1, "WORKSHOP": 2, "KITCHEN": 1}


def _uid(label: str) -> str:
    """A deterministic version-4 UUID for `label` (see hogstadium._uid)."""
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


@dataclass(frozen=True)
class SchoolShape:
    """The axes of one corpus week; see the module docstring."""

    classes_per_year: int
    years: tuple[int, ...] = (7, 8, 9)
    pupils_per_class: int = 22
    group_subjects: int = 3
    #: How far a group's pupils are drawn from every class of the year: 1.0 is
    #: random (each group takes pupils from nearly every class), 0.0 is the classes
    #: themselves (group k is class k).
    #: Between them a group takes pupils from the classes near its own, so the pairs
    #: of groups that share a pupil are fewer and WHO sits where decides which
    #: ones: the seed matters. At 1.0 with groups of a class's size nearly every
    #: pair is present whatever the seed, and the seed moves nothing the engine
    #: sees (it sees pairs, never pupils).
    mixing: float = 0.5
    #: Parallel groups of a group subject per class of the year (1.0: as many
    #: groups as classes, so a group is a class's size; 1.5: groups of two thirds of it).
    #: A real school's groups are smaller than its classes, which is what leaves pairs of
    #: groups that share no pupil.
    group_factor: float = 1.0
    half_groups: bool = False
    #: Run the groups of a group subject that have a teacher of their own as one
    #: parallel block (the same times), as a språkval week has been solved: the engine
    #: sees one slot for the year's class instead of one per group. A group whose
    #: teacher stands on more than one group of the subject cannot be in the block.
    block_subjects: bool = False
    #: The school day: (start, end, changeover minutes between lessons).
    day: tuple[str, str, int] = ("08:00:00", "16:00:00", 0)
    #: Lunch: (window start, window end, minutes).
    lunch: tuple[str, str, int] = ("11:00:00", "13:00:00", 30)
    shared_teachers: int = 0
    groups_per_shared_teacher: int = 3
    #: Teachers of the group subjects. 0 gives every group a teacher of its own (about one post to
    #: a teacher in the production form, and no teacher that couples one year to another or one
    #: subject to another); a real school's teachers have many posts each, and some stand on posts
    #: in every year. With n >= 1 the group subjects are taken n at a time (GROUP_ORDER) and group
    #: k of every subject of the team, in EVERY year, is one teacher's: n = 1 is a teacher who
    #: teaches a subject's k:th group in every year (three posts), n = 2 one who teaches two
    #: subjects as well (six). The groups of one teacher are never parallel, so M is not what this
    #: moves, and the week load is not either (measured: 85 % and 96 % for both); all subjects on
    #: one teacher is refused by the engine (IMPOSSIBLE).
    subjects_per_teacher: int = 0
    #: Språkval groups per year. None is one fewer than the year's classes (at
    #: least two, and enough that no group is above 30 pupils, which is what a
    #: classroom holds), as a school runs them; 0 is no språkval.
    languages: int | None = None
    #: Teachers of the språkval groups of ALL the years. None is one for every
    #: four groups, the three or four groups to a teacher that a school runs.
    language_teachers: int | None = None
    language_block: bool = False
    term_subjects: int = 0
    #: How many periods the year is cut into by the dates of the term posts (AnonymousRequirement.
    #: periods is a mask over them, and the engine plans, checks and prices every one as a week of
    #: its own: app/solver/weeks.py). 2 is autumn and spring and nothing between, which no real
    #: school has: every dated post cuts the year again (periods-are-not-terms), and a real
    #: school's posts end on several dates and start on several more, so six to eight periods.
    #: With more than two the autumn's units stop in turn, one after another, and the spring's
    #: start in turn, so that the later periods hold some of each, as the weeks around New Year do.
    term_periods: int = 2
    #: One number of group subjects for each of `years` (None: `group_subjects` in every year).
    #: A real school's lower years are mostly by class and its upper years by group, and the
    #: pairs of groups that share a pupil, the engine's 5,000, are spent in the upper ones. With
    #: one number for all the years a week of a whole school's size (a few dozen classes, hundreds
    #: of lessons) has no form to be built in: the form of the upper years alone is over the limit
    #: at fifteen classes. Overrides `group_subjects` where given.
    group_subjects_by_year: tuple[int, ...] | None = None
    seed: int = 1

    @property
    def classes(self) -> int:
        return self.classes_per_year * len(self.years)

    def group_subjects_of(self, year: int) -> int:
        """The number of group subjects of `year`."""
        if self.group_subjects_by_year is None:
            return self.group_subjects
        return self.group_subjects_by_year[self.years.index(year)]

    def group_count(self, code: str) -> int:
        """Parallel groups of group subject `code` in one year."""
        half = self.half_groups and code in HALF_GROUP_SUBJECTS
        return max(2, round(self.classes_per_year * self.group_factor * (2 if half else 1)))

    @property
    def language_groups(self) -> int:
        """Språkval groups per year."""
        if self.languages is not None:
            return self.languages
        pupils = self.classes_per_year * self.pupils_per_class
        return max(2, self.classes_per_year - 1, -(-pupils // 30))

    @property
    def language_teacher_count(self) -> int:
        if self.language_teachers is not None:
            return self.language_teachers
        return max(1, -(-self.language_groups * len(self.years) // 4))

    def name(self) -> str:
        """n<classes>-g<group subjects>-m<shared teachers asked>-s<seed>, plus what is not the form's default."""
        extras = "".join((
            f"-t{self.term_subjects}" + (f"p{self.term_periods}" if self.term_periods != 2 else "")
            if self.term_subjects else "",
            f"-q{self.subjects_per_teacher}" if self.subjects_per_teacher else "",
            # One number of group subjects a year, as the form of the whole school: "-y0.0.0.3.10.10".
            "-y" + ".".join(str(n) for n in self.group_subjects_by_year)
            if self.group_subjects_by_year is not None else "",
            "-b" if self.language_block else "",
            "-h" if self.half_groups else "",
            "-k" if self.block_subjects else "",
            f"-l{self.language_teachers}" if self.language_teachers is not None else "",
            # How many parallel groups a shared teacher stands on is what M means in this week:
            # two shapes that differ in it are two weeks, and must not share a name (or requestId).
            f"-p{self.groups_per_shared_teacher}"
            if self.shared_teachers and self.groups_per_shared_teacher != 3 else "",
        ))
        # A day that ends otherwise than at 16:00 is another week (the cliff weeks, CLIFF_WEEKS). The start and the
        # changeover are still not in the name (g386-L-1's other fields: nothing varies them yet).
        end = "" if self.day[1] == "16:00:00" else f"-e{self.day[1][:2]}{self.day[1][3:5]}"
        return f"n{self.classes}-g{self.group_subjects}-m{self.shared_teachers}-s{self.seed}{extras}{end}"

    def checked(self) -> None:
        if self.classes_per_year < 1 or not self.years:
            msg = "a school has at least one class in at least one year"
            raise ValueError(msg)
        if self.group_factor < 1.0:
            msg = f"group_factor is at least 1 (as many groups as classes), not {self.group_factor}"
            raise ValueError(msg)
        if not 0.0 <= self.mixing <= 1.0:
            msg = f"mixing is 0..1, not {self.mixing}"
            raise ValueError(msg)
        if not 0 <= self.group_subjects <= len(GROUP_ORDER):
            msg = f"group_subjects is 0..{len(GROUP_ORDER)}, not {self.group_subjects}"
            raise ValueError(msg)
        if self.group_subjects_by_year is not None and (
            len(self.group_subjects_by_year) != len(self.years)
            or not all(0 <= n <= len(GROUP_ORDER) for n in self.group_subjects_by_year)
        ):
            msg = f"group_subjects_by_year is one number 0..{len(GROUP_ORDER)} for each of the years {self.years}"
            raise ValueError(msg)
        if not 0 <= self.term_subjects <= len(TERM_ORDER):
            msg = f"term_subjects is 0..{len(TERM_ORDER)}, not {self.term_subjects}"
            raise ValueError(msg)
        if self.subjects_per_teacher < 0:
            msg = f"subjects_per_teacher is 0 or more, not {self.subjects_per_teacher}"
            raise ValueError(msg)
        if not 2 <= self.term_periods <= MAX_PERIODS:
            msg = f"term_periods is 2..{MAX_PERIODS}, not {self.term_periods}"
            raise ValueError(msg)
        if self.language_groups and self.language_teacher_count < 1:
            msg = "språkval needs at least one teacher"
            raise ValueError(msg)


@dataclass(frozen=True)
class CorpusWeek:
    """One corpus week: what was asked, the request, and what it came to."""

    name: str
    shape: SchoolShape
    request: OptimizeScheduleRequest
    facts: dict[str, object]
    #: The pupils' lists of groups, one entry for each DISTINCT list a pupil has (the class and its
    #: groups). The engine never sees a pupil, only the pairs of groups that share one; this is
    #: what the pairs were made from, kept for the measurements of M8 (benchmarks/m8_paths.py) that
    #: ask what a row per pupil list would be against a row per pair. Not part of the request.
    cohorts: tuple[frozenset[uuid.UUID], ...] = ()


def _order_pupils(pupils: int, per_class: int, mixing: float, rng: random.Random) -> list[int]:
    """The pupils of a year in the order they are cut into groups.

    A pupil's key blends their place among their class's pupils (the classes in
    order, one after another) with a draw over the whole year, `mixing` of it the
    draw: at 0 the order is the classes', at 1 it is random, between them a
    group's pupils come from neighbouring classes."""
    keys = [
        (1 - mixing) * ((pupil // per_class) + rng.random()) * per_class + mixing * rng.random() * pupils
        for pupil in range(pupils)
    ]
    return sorted(range(pupils), key=lambda pupil: keys[pupil])


def _chunk_of(position: int, count: int, groups: int) -> int:
    """Which of `groups` near-equal chunks the `position`-th of `count` falls in."""
    return position * groups // count


def build_week(shape: SchoolShape) -> CorpusWeek:
    """The week `shape` describes, as a validated engine request with its facts.

    Raises ValueError when the shape needs more group pairs or requirements than
    the engine takes in one request."""
    shape.checked()
    years = shape.years
    classes_per_year = shape.classes_per_year
    pupils_per_year = classes_per_year * shape.pupils_per_class
    group_codes = GROUP_ORDER[: max(shape.group_subjects_of(year) for year in years)]
    term_codes = TERM_ORDER[: shape.term_subjects]

    requirements: list[dict[str, object]] = []
    class_ids: dict[str, str] = {}
    #: pupil -> the groups a pupil sits in (own class included), per year.
    memberships: list[set[str]] = []
    teachers: set[str] = set()
    block_of_year: dict[int, str] = {}

    # ---- who teaches the groups -------------------------------------------------
    # Group-form subject-years, in a fixed order, with the number of parallel groups.
    slots: list[tuple[int, str, int]] = []
    for code in group_codes:
        for year in years:
            if code in GROUP_ORDER[: shape.group_subjects_of(year)]:
                slots.append((year, code, shape.group_count(code)))
    # One subject's groups, year by year, are cut into runs of `groups_per_shared_teacher`
    # (the last run shorter): a run of two or more is a teacher who stands on parallel
    # groups, which is what "shared" means; a run of one is an ordinary teacher. The runs of
    # every subject are then taken in turn, subject after subject, and the first M of them
    # become the shared teachers, so a larger M is always more of the groups on shared
    # teachers and never fewer (monotone), up to every group that a run of two covers.
    per_teacher = max(2, shape.groups_per_shared_teacher)
    runs_of_subject: dict[str, list[list[tuple[int, str, int]]]] = {}
    for code in group_codes:
        groups = [(year, code, k) for (year, c, count) in slots if c == code for k in range(count)]
        runs = [groups[i : i + per_teacher] for i in range(0, len(groups), per_teacher)]
        runs_of_subject[code] = [run for run in runs if len(run) >= 2]
    teacher_of_group: dict[tuple[int, str, int], str] = {}
    made = 0
    depth = 0
    while made < shape.shared_teachers and any(len(r) > depth for r in runs_of_subject.values()):
        for code in group_codes:
            runs = runs_of_subject[code]
            if depth < len(runs) and made < shape.shared_teachers:
                name = f"teacher-{code}-S{depth}"
                teachers.add(name)
                for group in runs[depth]:
                    teacher_of_group[group] = name
                made += 1
        depth += 1
    for year, code, count in slots:
        for k in range(count):
            if (year, code, k) not in teacher_of_group:
                if shape.subjects_per_teacher:
                    team = group_codes.index(code) // shape.subjects_per_teacher
                    name = f"teacher-T{team}-{k}"
                else:
                    name = f"teacher-{code}-{year}-{k}"
                teacher_of_group[(year, code, k)] = name
                teachers.add(name)

    # ---- the years ------------------------------------------------------------------
    class_form_lessons: dict[str, int] = defaultdict(int)
    for code, lessons, _minutes, _room in SUBJECTS:
        by_class = sum(1 for year in years if code not in GROUP_ORDER[: shape.group_subjects_of(year)])
        if by_class:
            class_form_lessons[code] = lessons * by_class * classes_per_year
    pool = {
        code: max(1, -(-total // LESSONS_PER_TEACHER)) for code, total in class_form_lessons.items()
    }

    periods = shape.term_periods

    def _term_periods(index: int, count: int) -> tuple[bool, ...]:
        """First half of `count` units in the autumn, the rest in the spring.

        With two periods that is all there is. With more, the autumn unit number i runs periods
        0..(i mod (n - 1)) and the spring unit number j the last periods from (n - 1 - j mod
        (n - 1)) on, so the posts that stop and start in the middle do so on different dates."""
        autumn = index < (count + 1) // 2
        unit = index if autumn else index - (count + 1) // 2
        if autumn:
            last = unit % (periods - 1)
            return tuple(period <= last for period in range(periods))
        first = periods - 1 - unit % (periods - 1)
        return tuple(period >= first for period in range(periods))

    def _requirement(
        key: str, code: str, group: str, teacher: str, size: int, year: int, *,
        term: tuple[bool, ...] | None = None,
    ) -> dict[str, object]:
        lessons, minutes, room = _BY_CODE[code]
        row: dict[str, object] = {
            "id": _uid(f"req-{key}"),
            "subjectId": _uid(f"subject-{code}"),
            "studentGroupId": group,
            "teacherId": _uid(teacher),
            "lessonsPerWeek": lessons * 2 if term is not None else lessons,
            "minutesPerLesson": minutes,
            "studentGroupSize": size,
            "minGradeLevel": year,
            "maxGradeLevel": year,
        }
        if room is not None:
            row["requiredRoomType"] = room
        if term is not None:
            row["periods"] = list(term)
        return row

    language_teacher_names = [
        f"teacher-LANG-{index}" for index in range(shape.language_teacher_count)
    ]
    if shape.language_groups:
        teachers.update(language_teacher_names)

    for year_index, year in enumerate(years):
        classes = [f"{year}{chr(ord('A') + index)}" for index in range(classes_per_year)]
        for name in classes:
            class_ids[name] = _uid(f"group-{name}")
        # pupil -> own class, then the group of each group-form subject and of språkval.
        own_class = [classes[p // shape.pupils_per_class] for p in range(pupils_per_year)]
        groups_of_pupil: list[set[str]] = [{class_ids[own_class[p]]} for p in range(pupils_per_year)]

        for code in GROUP_ORDER[: shape.group_subjects_of(year)]:
            count = shape.group_count(code)
            order = _order_pupils(
                pupils_per_year, shape.pupils_per_class,
                1.0 if code in LEVEL_SUBJECTS else shape.mixing,
                random.Random(f"{shape.seed}:{year}:{code}"),
            )
            chunks: dict[int, int] = defaultdict(int)
            for position, pupil in enumerate(order):
                k = _chunk_of(position, pupils_per_year, count)
                chunks[k] += 1
                groups_of_pupil[pupil].add(_uid(f"group-{year}-{code}-{k}"))
            teacher_load: dict[str, int] = defaultdict(int)
            for k in range(count):
                teacher_load[teacher_of_group[(year, code, k)]] += 1
            blockable = [k for k in range(count) if teacher_load[teacher_of_group[(year, code, k)]] == 1]
            block = (
                _uid(f"block-{year}-{code}") if shape.block_subjects and len(blockable) >= 2 else None
            )
            for k in range(count):
                term = _term_periods(k, count) if code in term_codes else None
                row = _requirement(
                    f"{year}-{code}-{k}", code, _uid(f"group-{year}-{code}-{k}"),
                    teacher_of_group[(year, code, k)], chunks[k], year, term=term,
                )
                if block is not None and k in blockable:
                    row["blockId"] = block
                requirements.append(row)

        for code, _lessons, _minutes, _room in SUBJECTS:
            if code in GROUP_ORDER[: shape.group_subjects_of(year)]:
                continue
            for index, name in enumerate(classes):
                term = _term_periods(index, classes_per_year) if code in term_codes else None
                teacher = f"teacher-{code}-{(index + year) % pool[code]}"
                teachers.add(teacher)
                requirements.append(_requirement(
                    f"{name}-{code}", code, class_ids[name], teacher, shape.pupils_per_class, year,
                    term=term,
                ))

        if shape.language_groups:
            # Språkval is chosen by the pupil, not by the class: always drawn from the whole year.
            order = list(range(pupils_per_year))
            random.Random(f"{shape.seed}:{year}:språkval").shuffle(order)
            sizes: dict[int, int] = defaultdict(int)
            for position, pupil in enumerate(order):
                k = _chunk_of(position, pupils_per_year, shape.language_groups)
                sizes[k] += 1
                groups_of_pupil[pupil].add(_uid(f"group-{year}-språkval-{k}"))
            block = _uid(f"block-sprakval-{year}") if shape.language_block else None
            if block is not None:
                block_of_year[year] = block
            for k in range(shape.language_groups):
                teacher = language_teacher_names[
                    (k + year_index * shape.language_groups) % len(language_teacher_names)
                ]
                row = {
                    "id": _uid(f"req-{year}-språkval-{k}"),
                    "subjectId": _uid(f"subject-M2-{k}"),
                    "studentGroupId": _uid(f"group-{year}-språkval-{k}"),
                    "teacherId": _uid(teacher),
                    "lessonsPerWeek": LANGUAGE_LESSONS,
                    "minutesPerLesson": LANGUAGE_MINUTES,
                    "studentGroupSize": sizes[k],
                    "minGradeLevel": year,
                    "maxGradeLevel": year,
                }
                if block is not None:
                    row["blockId"] = block
                requirements.append(row)
        memberships.extend(groups_of_pupil)

    pairs = sorted({
        tuple(sorted(pair)) for groups in memberships for pair in combinations(sorted(groups), 2)
    })
    if len(pairs) > ENGINE_GROUP_CONFLICTS_LIMIT:
        msg = (
            f"{shape.name()}: {len(pairs)} group pairs, the engine takes {ENGINE_GROUP_CONFLICTS_LIMIT}"
            " (fewer group_subjects or fewer classes)"
        )
        raise ValueError(msg)
    if len(requirements) > ENGINE_REQUIREMENTS_LIMIT:
        msg = f"{shape.name()}: {len(requirements)} requirements, the engine takes {ENGINE_REQUIREMENTS_LIMIT}"
        raise ValueError(msg)

    biggest = max(r["studentGroupSize"] for r in requirements)  # type: ignore[type-var]
    if biggest > ROOM_CAPACITY:
        msg = (
            f"{shape.name()}: a group of {biggest} pupils fits no room (a room holds {ROOM_CAPACITY};"
            " more språkval groups or fewer pupils per class)"
        )
        raise ValueError(msg)

    total_classes = shape.classes
    classrooms = total_classes + 4
    rooms: list[dict[str, object]] = [
        {"id": _uid(f"room-CLASSROOM-{index}"), "capacity": ROOM_CAPACITY, "type": "CLASSROOM"}
        for index in range(classrooms)
    ]
    for kind in ROOM_TYPES:
        count = max(1, -(-ROOMS_AT_18[kind] * total_classes // 18))
        rooms.extend(
            {"id": _uid(f"room-{kind}-{index}"), "capacity": ROOM_CAPACITY, "type": kind} for index in range(count)
        )

    all_teachers = sorted(teachers)
    constraints = [
        {
            "id": _uid(f"constraint-{teacher}"),
            "resourceKind": "TEACHER",
            "resourceId": _uid(teacher),
            "dayOfWeek": (index % 5) + 1,
            "startTime": "14:00:00",
            "endTime": "16:00:00",
            "kind": "UNAVAILABLE",
        }
        for index, teacher in enumerate(all_teachers)
    ]
    frames = [
        {
            "minGradeLevel": min(years),
            "maxGradeLevel": max(years),
            "dayOfWeek": day,
            "startTime": shape.day[0],
            "endTime": shape.day[1],
            "changeoverMinutes": shape.day[2],
        }
        for day in range(1, 6)
    ]
    payload: dict[str, object] = {
        "requestId": _uid(f"request-{shape.name()}-v{CORPUS_VERSION}"),
        "academicYearId": _uid("year"),
        "requirements": requirements,
        "groups": [
            {
                "id": class_ids[f"{year}{chr(ord('A') + index)}"],
                "lunchHeadcount": shape.pupils_per_class,
                "minGradeLevel": year,
                "maxGradeLevel": year,
            }
            for year in years
            for index in range(classes_per_year)
        ],
        "rooms": rooms,
        "constraints": constraints,
        "frameTimes": frames,
        "groupConflicts": [list(pair) for pair in pairs],
        "rules": {
            "lunchStartTime": shape.lunch[0],
            "lunchEndTime": shape.lunch[1],
            "lunchMinutes": shape.lunch[2],
            "maxLessonsPerDayPerGroup": 7,
        },
    }
    request = OptimizeScheduleRequest.model_validate(payload)
    lessons = sum(r.lessons_per_week for r in request.requirements)
    facts: dict[str, object] = {
        "corpusVersion": CORPUS_VERSION,
        "classes": total_classes,
        "pupils": pupils_per_year * len(years),
        "requirements": len(request.requirements),
        "lessons": lessons,
        "groupConflicts": len(pairs),
        "teachers": len(all_teachers),
        # The union over the request; the engine's own count is per week (see the docstring, M).
        "sharedTeachers": shared_teachers_of(request),
        "sharedTeachersAsked": shape.shared_teachers,
        "groupSubjects": max(shape.group_subjects_of(year) for year in years),
        "languageGroups": shape.language_groups * len(years),
        "termSubjects": shape.term_subjects,
        # getattr: an engine from before the engine planned terms has no `periods` field, and drops
        # the key without saying so (corpus_measure's facts then tell the gate it read another week).
        "termRequirements": sum(1 for r in request.requirements if getattr(r, "periods", None) is not None),
        "blockedRequirements": sum(1 for r in request.requirements if r.block_id is not None),
    }
    cohorts = tuple(sorted(
        {frozenset(uuid.UUID(group) for group in groups) for groups in memberships},
        key=lambda cohort: sorted(str(group) for group in cohort),
    ))
    return CorpusWeek(name=shape.name(), shape=shape, request=request, facts=facts, cohorts=cohorts)


def shared_teacher_ids_of(request: OptimizeScheduleRequest) -> set[uuid.UUID]:
    """The teachers who stand on groups that could otherwise run together.

    The engine's reading of "shared" (week_load._shared_teachers): two of a
    teacher's requirements qualify when (a) their groups share no pupil with
    each other (no pair between them) and (b) both pair with the same home class
    (a group in `request.groups`). One such pair of requirements is enough for
    the teacher to count. Counted from the request alone, which is what the
    engine has too: it never sees a pupil. (test_school_corpus.py holds this to
    the engine's own list.)"""
    pairs = {frozenset(pair) for pair in request.group_conflicts}
    classes = {group.id for group in request.groups}
    by_teacher: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for requirement in request.requirements:
        if requirement.teacher_id is not None:
            by_teacher[requirement.teacher_id].append(requirement.student_group_id)
    homes: dict[uuid.UUID, set[uuid.UUID]] = {}

    def _homes(group: uuid.UUID) -> set[uuid.UUID]:
        if group not in homes:
            homes[group] = {
                c for c in classes if c != group and frozenset((group, c)) in pairs
            }
        return homes[group]

    shared: set[uuid.UUID] = set()
    for teacher, groups in by_teacher.items():
        distinct = sorted(set(groups))
        if any(
            frozenset((a, b)) not in pairs and _homes(a) & _homes(b)
            for a, b in combinations(distinct, 2)
        ):
            shared.add(teacher)
    return shared


def shared_teachers_of(request: OptimizeScheduleRequest) -> int:
    """How many teachers are shared (`shared_teacher_ids_of`)."""
    return len(shared_teacher_ids_of(request))


# ---- the profiles ------------------------------------------------------------------

#: The shape of the school the sweeps hold fixed while they move one axis: three ämnen
#: (SO, NO, Idrott) in groups across the classes, the rest by class, språkval in groups
#: with a teacher for every four groups of the years together, no terms.
BASE = SchoolShape(classes_per_year=3, group_subjects=3)

#: The form of a real school's upper years (aggregates only, no count of one school's): ten subjects
#: in groups, Matematik, Engelska and Svenska as level groups, half groups in Hemkunskap
#: and Musik, groups about the size of a class, 08:15-16:00 with five minutes between
#: lessons and fifteen minutes of lunch in 10:30-13:00, and about a quarter of the week in
#: posts that run one term only. The sweep starts from it at its own size.
PRODUCTION = SchoolShape(
    classes_per_year=3, group_subjects=10, half_groups=True, term_subjects=5,
    day=("08:15:00", "16:00:00", 5), lunch=("10:30:00", "13:00:00", 15),
)


def with_classes(shape: SchoolShape, classes: int, **changes) -> SchoolShape:
    """`shape` with `classes` classes in all, the same number in each of its years.

    The years are the ones the shape will have: `years=(8, 9)` in `changes` makes five classes
    a year of ten, not three of nine (it divided by the years the shape had before the change)."""
    years = changes.get("years", shape.years)
    if classes < len(years) or classes % len(years):
        msg = f"{classes} classes do not divide into {len(years)} years ({years}): the same number of classes in each"
        raise ValueError(msg)
    return replace(shape, classes_per_year=classes // len(years), **changes)


def sweep_shapes(seeds: tuple[int, ...] = (1, 2)) -> list[SchoolShape]:
    """The corpus the limits table is measured on: four axes, each moving from the base alone.

    N      classes from 6 to 24 (to 18 where groups cross the classes), by class and with
           three ämnen in groups;
    G      ämnen in groups across the classes, 0 to 10 (the production school: ten), at nine
           and at twelve classes;
    M      shared teachers, at nine and twelve classes;
    terms  subjects that run one term only, språkval in a block, and half groups, at twelve.

    Every week once (a shape that two axes both reach is not measured twice), and no week the
    engine would refuse: not by its limits (build_week) and not by its own arithmetic either
    (SchedulerSolver.check_week must not say IMPOSSIBLE of any of them; tests/test_school_corpus_sweep.py)."""
    shapes: dict[str, SchoolShape] = {}

    def add(shape: SchoolShape) -> None:
        try:
            build_week(shape)
        except ValueError:
            return
        held = shapes.setdefault(shape.name(), shape)
        if held != shape:
            msg = f"two different shapes are both called {shape.name()}: {held} and {shape}"
            raise ValueError(msg)

    for seed in seeds:
        for classes in (6, 9, 12, 15, 18):
            add(with_classes(BASE, classes, seed=seed))
        for classes in (6, 9, 12, 18, 24):
            add(with_classes(BASE, classes, group_subjects=0, seed=seed))
        for classes in (9, 12):
            for groups in (0, 2, 3, 4, 5, 6, 8, 10):
                add(with_classes(BASE, classes, group_subjects=groups, seed=seed))
            # Three parallel groups on one teacher put a year over the engine's own week load
            # at the third shared teacher (check_week: IMPOSSIBLE, DEMAND_YEAR_WEEK_SHORT), so a
            # week asking for four or eight of them measured the refusal, in milliseconds, and not
            # a search. Up to two shared teachers stand on three groups; past that on two.
            for m in (0, 1, 2):
                add(with_classes(BASE, classes, shared_teachers=m, seed=seed))
            for m in (4, 8):
                add(with_classes(BASE, classes, shared_teachers=m, groups_per_shared_teacher=2, seed=seed))
        for terms in (3, 5):
            add(with_classes(BASE, 12, term_subjects=terms, seed=seed))
        add(with_classes(BASE, 12, language_block=True, seed=seed))
        add(with_classes(BASE, 12, group_subjects=6, half_groups=True, seed=seed))
        add(with_classes(PRODUCTION, 6, seed=seed))
        add(with_classes(PRODUCTION, 9, seed=seed))
        # The same two with the year cut as the production school's is (six periods, not two).
        add(with_classes(PRODUCTION, 6, term_periods=6, seed=seed))
        add(with_classes(PRODUCTION, 9, term_periods=6, seed=seed))
        # Teachers who teach groups in every year, and two subjects: 3 and 6 posts to a teacher
        # in the production form where a teacher of its own for every group gives 1.1.
        for subjects in (1, 2):
            add(with_classes(PRODUCTION, 9, subjects_per_teacher=subjects, seed=seed))
        # A whole school: åk 4-9, five classes a year, the lower years by class and the upper two by
        # group. About 660 pupils and 4,150 pairs of groups, and a model of 18,600 variables and
        # 61,000 constraints: four times the size of the sweep's largest other week that has
        # groups across the classes.
        add(replace(
            PRODUCTION, classes_per_year=5, years=(4, 5, 6, 7, 8, 9),
            group_subjects_by_year=(0, 0, 0, 3, 10, 10), seed=seed,
        ))
    return list(shapes.values())


#: The nightly gate's weeks (scripts/bench/solve-corpus-gate.mjs), named as the sweep names them.
#: Picked from the first measurement (2026-11-22, count mode, a budget of 4 deterministic seconds)
#: as weeks that get a timetable with between 0.17 and 3.5 deterministic seconds of work: far
#: enough from nothing that a change shows in the work, and far enough from the budget (8 seconds
#: for the two searches a solve runs) that it does not tip into TIMEOUT on a harmless change. Three
#: sizes and four kinds of week: by class (to 24 classes), three to five ämnen in groups, a term
#: split, a språkval block. The weeks the search gives up on (the sweep's TIMEOUTs) are left out:
#: they cost the whole budget twice and say nothing until one of them solves. Nor are there weeks
#: the engine refuses on arithmetic alone: the sweep has none (a corpus week the engine refuses
#: would measure the refusal), and a refusal that appears is the gate's "refused" verdict.
#: Nor is n9-g5-m0-s1: picked at seed 1 (0.49), it finds nothing in 8 deterministic seconds at 2 of 7
#: seeds (0.49, none, 0.48, none, 0.69, 0.34, 0.21), so any change that re-throws the search's dice can
#: flip it to a timeout. n12-g3-m0-s1-t3 is on the same edge (none at 4 of 7) and stays only because it
#: is the gate's one week with terms: the gate's rule keeps a week like that from deciding alone
#: (solve-corpus-gate.mjs, with `corpus_measure.py --seeds`).
GATE_WEEKS: tuple[str, ...] = (
    "n9-g3-m0-s2",
    "n9-g4-m0-s1",
    "n12-g2-m0-s2",
    "n12-g3-m0-s1",
    "n12-g3-m0-s2",
    "n12-g4-m0-s2",
    "n12-g3-m0-s1-t3",
    "n12-g3-m0-s1-b",
    "n12-g3-m0-s2-b",
    "n18-g0-m0-s1",
    "n18-g0-m0-s2",
    "n24-g0-m0-s1",
    "n24-g0-m0-s2",
)


#: THE CLIFF WEEKS (M8, 2026-11-25): a corpus week at the LOWEST day end at which some road has laid it, so that
#: a week has a witness (benchmarks/corpus/cliff_witnesses.json: the road, the encoding, the seed, the work, and
#: where every lesson was laid; the engine accepts the week with every lesson pinned there, and the rooms hold).
#:
#: WHY. The sweep's weeks have random pupil groups, and a random draw of pupils may have no timetable in the
#: frame: one that is TIMEOUT at 16:00 and a matter of 0.01-4 deterministic seconds at 17:00 is on a cliff, and
#: its TIMEOUT does not say whether it has a timetable (DEPLOYMENT §35.2, the correction; §35.7). A week at its
#: cliff end is solvable by construction, so a TIMEOUT on it is the search and not the week. Terms are not in
#: them (the gate does not cover terms), and the gate does not read them yet: a week no tree lays is no
#: measurement, and they are for the measurement of M8's roads (`corpus_measure.py --profile cliff`).
#: (shape name in the sweep, day end). A week whose end is 16:00 is the sweep's own week.
CLIFF_WEEKS: tuple[tuple[str, str], ...] = (
    ("n9-g6-m0-s1", "16:00"),
    ("n9-g8-m0-s1", "16:30"),
    ("n9-g10-m0-s1", "16:30"),
    ("n12-g4-m0-s1", "15:30"),
    ("n12-g5-m0-s1", "16:00"),
    ("n12-g6-m0-s1", "16:45"),
    ("n12-g10-m0-s1", "17:00"),
)


def cliff_shapes() -> list[SchoolShape]:
    """The cliff weeks, in CLIFF_WEEKS' order: each sweep week with its day ending where the witness says."""
    by_name = {shape.name(): shape for shape in sweep_shapes()}
    out = []
    for name, end in CLIFF_WEEKS:
        if name not in by_name:
            msg = f"the cliff weeks name a week the sweep does not have: {name}"
            raise ValueError(msg)
        shape = by_name[name]
        out.append(replace(shape, day=(shape.day[0], f"{end}:00", shape.day[2])))
    names = [shape.name() for shape in out]
    if len(set(names)) != len(names):
        msg = "two cliff weeks have the same name"
        raise ValueError(msg)
    return out


def gate_shapes() -> list[SchoolShape]:
    """The gate's weeks, in GATE_WEEKS' order. A name the sweep no longer has is an error, not a shorter gate."""
    by_name = {shape.name(): shape for shape in sweep_shapes()}
    missing = [name for name in GATE_WEEKS if name not in by_name]
    if missing:
        msg = f"the gate names weeks the sweep does not have: {', '.join(missing)}"
        raise ValueError(msg)
    return [by_name[name] for name in GATE_WEEKS]


def profile(name: str) -> list[SchoolShape]:
    if name == "sweep":
        return sweep_shapes()
    if name == "gate":
        return gate_shapes()
    if name == "cliff":
        return cliff_shapes()
    msg = f"profile must be 'gate', 'sweep' or 'cliff', not {name!r}"
    raise ValueError(msg)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", metavar="PROFILE", help="print the facts of every week of a profile")
    parser.add_argument("--week", metavar="NAME", help="print one week's request as JSON (name from --list)")
    parser.add_argument("--profile", default="sweep", help="the profile --week looks in")
    args = parser.parse_args()
    if args.list:
        for shape in profile(args.list):
            week = build_week(shape)
            print(json.dumps({"name": week.name, **week.facts}))
        return 0
    if args.week:
        for shape in profile(args.profile):
            if shape.name() == args.week:
                print(build_week(shape).request.model_dump_json(by_alias=True, exclude_none=True))
                return 0
        parser.error(f"no week called {args.week} in {args.profile}")
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
