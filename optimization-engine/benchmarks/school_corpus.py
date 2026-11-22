#!/usr/bin/env python3
"""A corpus of weeks shaped like real schools (omgång 13, M5 Riktiga veckor som mätstock).

    python benchmarks/school_corpus.py --list sweep
    python benchmarks/school_corpus.py --week n12-g3-m0-s1 > week.json

WHY A CORPUS. The four earlier bench schools (solve_2000_students.py,
validate_schedule.py, hogstadium.py, staff_60x400.py) give every class its own
lessons, and what they share is a block or a specialist room. The one real school in
production is shaped otherwise (analysis 2026-11-17, and the aggregates of m5-prod):
24 classes in åk 4-9 and 877 lessons, and in åk 8 and 9 (five classes and about 115
pupils each) every subject but Teknik taught in groups that cut across the classes:
12-13 groups for every pupil, 85 groups and 2,149 pairs of them that share a pupil in
åk 9 alone, 4,493 of the engine's 5,000 pairs in all. Twenty-one of its teachers
stand on parallel groups that take pupils from the same class, one of them on ten.
Matematik, Engelska and Svenska are level groups that draw from 4.7-4.9 of a grade's
five classes; SO, NO, Bild, Idrott, Musik and Slöjd draw from 2.7-2.9. Hemkunskap and
Musik are half groups. More than a quarter of the weekly minutes (134 of 355 posts) are in posts
that run one term only. That shape, and the språkval of 2026-11-03 (three or four groups of
one teacher drawing pupils from every class), is what made Generera answer TIMEOUT,
and no bench had it.

THE AXES are the ones a school can count itself (SchoolShape):

  N  classes          classes per year x the years
  M  shared teachers  teachers who stand on two or more parallel groups that
                      take pupils from the same class. This is the engine's own
                      reading (week_load._shared_teachers (a) and (b)), and
                      `shared_teachers_of` counts it from the request alone.
  G  group_subjects   how many of the year's ten subjects are taught in groups cut
                      across the classes (0 = every subject by class, the earlier
                      benches; the production school ten, Teknik aside)
  mixing, group_factor
                      how many classes a group draws its pupils from, and how big
                      the groups are against a class (the production school's: 2.8
                      of 5 for the practical subjects, level groups from every class)
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
where the production school's is 24-26), the same rooms scaled to the number of
classes, a planning afternoon for every teacher. It is written here, not imported
from there, so that the corpus does not move when that bench does: the nightly gate
compares one corpus against two engines. What it does not copy from the production
school is the length of its lessons (40, 50, 65, up to 130 minutes: here every lesson
is one of the högstadium's), its rooms (one kitchen, one laboratory, one art room) and
its pupils (a pupil's group list is 110 different ones in 111 pupils: the corpus's are
what `mixing` makes them).

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

from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402

#: Bump when a change to the generator changes what a shape builds, so a stored
#: result can tell which corpus it was measured on.
CORPUS_VERSION = 1

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
#: nearly every class (its åk 9: Engelska 4.8 classes of 5 to a group, Matematik 4.7,
#: Svenska 4.9). The others' groups draw from 2.7-2.9 of the five classes, which is
#: `mixing` 0.5. A level subject is always fully mixed.
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
    #: random (each group takes pupils from nearly every class: the production
    #: school's 7+2+4+7+2), 0.0 is the classes themselves (group k is class k).
    #: Between them a group takes pupils from the classes near its own, so the pairs
    #: of groups that share a pupil are fewer and WHO sits where decides which
    #: ones: the seed matters. At 1.0 with groups of a class's size nearly every
    #: pair is present whatever the seed, and the seed moves nothing the engine
    #: sees (it sees pairs, never pupils).
    mixing: float = 0.5
    #: Parallel groups of a group subject per class of the year (1.0: as many
    #: groups as classes, so a group is a class's size; 1.5: groups of two thirds of it).
    #: The production school's groups are smaller than its classes (about 17 pupils
    #: against 22), which is what leaves pairs of groups that share no pupil.
    group_factor: float = 1.0
    half_groups: bool = False
    #: Run the groups of a group subject that have a teacher of their own as one
    #: parallel block (the same times), as the 2026-11-03 week was solved: the engine
    #: sees one slot for the year's class instead of one per group. A group whose
    #: teacher stands on more than one group of the subject cannot be in the block.
    block_subjects: bool = False
    #: The school day: (start, end, changeover minutes between lessons).
    day: tuple[str, str, int] = ("08:00:00", "16:00:00", 0)
    #: Lunch: (window start, window end, minutes).
    lunch: tuple[str, str, int] = ("11:00:00", "13:00:00", 30)
    shared_teachers: int = 0
    groups_per_shared_teacher: int = 3
    #: Språkval groups per year. None is one fewer than the year's classes (at
    #: least two, and enough that no group is above 30 pupils, which is what a
    #: classroom holds), as a school runs them; 0 is no språkval.
    languages: int | None = None
    #: Teachers of the språkval groups of ALL the years. None is one for every
    #: four groups, the 3-4 groups to a teacher of the 2026-11-03 week.
    language_teachers: int | None = None
    language_block: bool = False
    term_subjects: int = 0
    seed: int = 1

    @property
    def classes(self) -> int:
        return self.classes_per_year * len(self.years)

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
            f"-t{self.term_subjects}" if self.term_subjects else "",
            "-b" if self.language_block else "",
            "-h" if self.half_groups else "",
            "-k" if self.block_subjects else "",
            f"-l{self.language_teachers}" if self.language_teachers is not None else "",
        ))
        return f"n{self.classes}-g{self.group_subjects}-m{self.shared_teachers}-s{self.seed}{extras}"

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
        if not 0 <= self.term_subjects <= len(TERM_ORDER):
            msg = f"term_subjects is 0..{len(TERM_ORDER)}, not {self.term_subjects}"
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
    group_codes = GROUP_ORDER[: shape.group_subjects]
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
                name = f"teacher-{code}-{year}-{k}"
                teacher_of_group[(year, code, k)] = name
                teachers.add(name)

    # ---- the years ------------------------------------------------------------------
    class_form_lessons: dict[str, int] = defaultdict(int)
    for code, lessons, _minutes, _room in SUBJECTS:
        if code not in group_codes:
            class_form_lessons[code] = lessons * len(years) * classes_per_year
    pool = {
        code: max(1, -(-total // LESSONS_PER_TEACHER)) for code, total in class_form_lessons.items()
    }

    def _term_periods(index: int, count: int) -> tuple[bool, bool]:
        """First half of `count` units in the autumn, the rest in the spring."""
        return (True, False) if index < (count + 1) // 2 else (False, True)

    def _requirement(
        key: str, code: str, group: str, teacher: str, size: int, year: int, *,
        term: tuple[bool, bool] | None = None,
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

        for code in group_codes:
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
            if code in group_codes:
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
        "sharedTeachers": shared_teachers_of(request),
        "sharedTeachersAsked": shape.shared_teachers,
        "groupSubjects": shape.group_subjects,
        "languageGroups": shape.language_groups * len(years),
        "termSubjects": shape.term_subjects,
        "termRequirements": sum(1 for r in request.requirements if r.periods is not None),
        "blockedRequirements": sum(1 for r in request.requirements if r.block_id is not None),
    }
    return CorpusWeek(name=shape.name(), shape=shape, request=request, facts=facts)


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

#: The production school's åk 8-9 (analysis 2026-11-17 and m5-prod/q2-q7): ten subjects
#: in groups, Matematik, Engelska and Svenska as level groups, half groups in Hemkunskap
#: and Musik, groups about the size of a class, 08:15-16:00 with five minutes between
#: lessons and fifteen minutes of lunch in 10:30-13:00, and about a quarter of the week in
#: posts that run one term only. The sweep starts from it at its own size.
PRODUCTION = SchoolShape(
    classes_per_year=3, group_subjects=10, half_groups=True, term_subjects=5,
    day=("08:15:00", "16:00:00", 5), lunch=("10:30:00", "13:00:00", 15),
)


def with_classes(shape: SchoolShape, classes: int, **changes) -> SchoolShape:
    """`shape` with `classes` classes in all (a third of them in each of its years)."""
    return replace(shape, classes_per_year=max(1, classes // len(shape.years)), **changes)


def sweep_shapes(seeds: tuple[int, ...] = (1, 2)) -> list[SchoolShape]:
    """The corpus the limits table is measured on: four axes, each moving from the base alone.

    N      classes from 6 to 24 (to 18 where groups cross the classes), by class and with
           three ämnen in groups;
    G      ämnen in groups across the classes, 0 to 10 (the production school: ten), at nine
           and at twelve classes;
    M      shared teachers, at nine and twelve classes;
    terms  subjects that run one term only, språkval in a block, and half groups, at twelve.

    Every week once (a shape that two axes both reach is not measured twice), and no week the
    engine would refuse."""
    shapes: dict[str, SchoolShape] = {}

    def add(shape: SchoolShape) -> None:
        try:
            build_week(shape)
        except ValueError:
            return
        shapes.setdefault(shape.name(), shape)

    for seed in seeds:
        for classes in (6, 9, 12, 15, 18):
            add(with_classes(BASE, classes, seed=seed))
        for classes in (6, 9, 12, 18, 24):
            add(with_classes(BASE, classes, group_subjects=0, seed=seed))
        for classes in (9, 12):
            for groups in (0, 2, 3, 4, 5, 6, 8, 10):
                add(with_classes(BASE, classes, group_subjects=groups, seed=seed))
            for m in (0, 2, 4, 8):
                add(with_classes(BASE, classes, shared_teachers=m, seed=seed))
        for terms in (3, 5):
            add(with_classes(BASE, 12, term_subjects=terms, seed=seed))
        add(with_classes(BASE, 12, language_block=True, seed=seed))
        add(with_classes(BASE, 12, group_subjects=6, half_groups=True, seed=seed))
        add(with_classes(PRODUCTION, 6, seed=seed))
        add(with_classes(PRODUCTION, 9, seed=seed))
    return list(shapes.values())


#: Weeks for the nightly gate, picked where a change shows (m5-design.md §5).
GATE_SHAPES: tuple[SchoolShape, ...] = ()


def profile(name: str) -> list[SchoolShape]:
    if name == "sweep":
        return sweep_shapes()
    if name == "gate":
        return list(GATE_SHAPES)
    msg = f"profile must be 'gate' or 'sweep', not {name!r}"
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
