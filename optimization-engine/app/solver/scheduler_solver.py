from __future__ import annotations

import logging
import math
import re
import time
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from collections.abc import Callable
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date as date_type
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import (
    InvalidScheduleInputError,
    OptimizationEngineError,
    SolverBuildError,
)
from app.solver.frames import changeover_slots, day_windows, span_of
from app.solver.rasts import blocks_for, blocks_with_demand, forbidden_starts
from app.solver.servings import allowed_starts
from app.schemas.schedule import (
    AnonymousRoomPreference,
    AnonymousConstraint,
    ConflictAnalysis,
    ConflictDetail,
    AnonymousGroup,
    AnonymousRequirement,
    AnonymousRoom,
    AnonymousTeacherDayLimit,
    AnonymousTeacherWorkRule,
    FixedLesson,
    FrameTime,
    LunchPlacement,
    LunchServing,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    PreviousLesson,
    Rast,
    ScheduledLesson,
    ScheduledLunch,
    ScheduleRules,
    SearchOptions,
    SolverStatus,
)

logger = logging.getLogger(__name__)


from app.solver.conflict_analyzer import (
    AssumptionRegistry,
    build_conflict_analysis,
    no_core_analysis,
)
from app.solver.room_allocator import (
    RoomPlan,
    add_room_allocation,
    collect_distinguished_room_ids,
)
from app.solver.time_grid import TimeGrid
from app.solver.travel import (
    CATEGORIES as TRAVEL_CATEGORIES,
    CODES as TRAVEL_CODES,
    Family,
    Party,
    Placed,
    TravelMap,
    TravelRows,
    breached,
    families_of,
    site_choices,
    site_plan,
    travel_map,
)


@dataclass(frozen=True)
class ResolvedWeights:
    preferred_free: int
    preferred_busy: int
    room_preference: int
    disruption: int
    spread: int
    teacher_gap: int
    lunch_drift: int
    date_unavailable: int
    #: Paid per day a teacher teaches on their wished free weekday. Settings
    #: only, no per-request override: the contract stays the two fields the
    #: work rule carries.
    free_day_wish: int = 0


@dataclass(frozen=True)
class LessonInstance:
    requirement: AnonymousRequirement
    lesson_index: int

    def key(self) -> str:
        return f"{self.requirement.id}_{self.lesson_index}"


@dataclass
class LessonDecision:
    lesson: LessonInstance
    start: cp_model.IntVar
    duration: int
    end: cp_model.IntVar
    interval: cp_model.IntervalVar
    room_index: cp_model.IntVar
    #: Slots of corridor this lesson's stage asks for after it. Zero by default.
    changeover: int = 0
    #: Slots the PUPILS are occupied before the lesson and after it — changing,
    #: showering, changing again — rounded up onto the grid from the
    #: requirement's minutesBefore and minutesAfter. Zero for every lesson
    #: nobody has written a number for. See pupil_padded_of for who sees them.
    lead: int = 0
    trail: int = 0
    #: The interval plus that margin, built once and shared. See padded_of.
    _padded: cp_model.IntervalVar | None = None
    #: The same lesson as the PUPILS are occupied by it. See pupil_padded_of.
    _pupils: cp_model.IntervalVar | None = None
    #: The starts `start` was built on, kept for the builders that ask which
    #: DAYS a lesson can fall on and which slots of them it can take — see
    #: _day_reach. The domain itself, not a second computation of it, so a
    #: rule reading it and the variable it constrains cannot disagree.
    starts: cp_model.Domain | None = None


def padded_of(model: cp_model.CpModel, decision: LessonDecision) -> cp_model.IntervalVar:
    """The interval a NO-OVERLAP family should see: the lesson plus its corridor.

    CP-SAT intervals are half-open, so a lesson ending 09:00 and one starting
    09:00 do not overlap and the teacher walks between two rooms in no time at
    all. Lengthening the interval the OVERLAP CHECK sees, while leaving the one
    the school is shown alone, is the whole mechanism.

    NO NEW VARIABLES. The padded interval reuses the same `start` and an affine
    end, so it adds one interval proto and not a single IntVar or BoolVar —
    which is why _estimate_model_size, which predicts variable counts, needs no
    new term for it.

    THE CORRIDOR IS PADDED AT ONE END, THE PUPILS' CHANGING AT BOTH, AND THE
    DIFFERENCE IS NOT A STYLE. A corridor is ONE body walking between two
    places: the walk happens once between a pair of lessons, so each lesson
    carries it once, and a lesson carrying it at both ends would turn a
    ten-minute rule into a silent twenty and make 08:00 an illegal start for
    the first lesson of the day. Changing and showering are not a distance
    between two lessons but TIME THE PUPILS ARE UNAVAILABLE, and they are
    unavailable before the lesson as well as after it — so that margin is
    two-sided, and it lives in pupil_padded_of rather than here.

    THIS interval is what the TEACHER's family sees, and it is exactly what it
    saw before the pupils had a margin at all. The teacher is not the one
    changing: the user's decision is that idrottsläraren may take the next
    class the minute the lesson ends, and the room the pupils have left may be
    taken by anybody. Neither of them reads pupil_padded_of.

    Memoised on the decision: a lesson appears in the teacher family, its own
    group's family, one family per group that shares its pupils and the lunch
    family, and four copies of the same interval would be four protos for one
    fact.
    """
    if decision.changeover == 0:
        return decision.interval
    if decision._padded is None:
        decision._padded = model.NewIntervalVar(
            decision.start,
            decision.duration + decision.changeover,
            decision.end + decision.changeover,
            f"padded_{decision.lesson.key()}",
        )
    return decision._padded


def pupil_padded_of(
    model: cp_model.CpModel, decision: LessonDecision,
) -> cp_model.IntervalVar:
    """The interval a family of PUPILS should see: `[start - lead, end + trail + changeover)`.

    The lesson, the minutes before it the class spends changing, and the
    minutes after it they spend showering and changing back. Every family whose
    members are the children reads this one — the class's own no-overlap, each
    family for a group that shares its pupils, and the lunch — while the
    teacher's family and the room pool keep reading padded_of. That split IS
    the feature: the pupils are busy, nobody else is.

    THE TRAILING MARGIN IS ADDITIVE, NOT A MAX. After idrotten a class showers,
    changes, and THEN walks to the next room, so a school that declares both a
    corridor and twenty minutes of shower has asked for both and gets their
    sum. A max would quietly spend the corridor twice — once as a corridor and
    once as part of the shower — and deliver a class to its next lesson still
    walking. The leading side takes no corridor of its own for the reason
    padded_of gives: the walk between two lessons is carried once, by the
    lesson before.

    NO NEW VARIABLES, on the same terms as padded_of: the start is `start`
    shifted by a constant and the end is `end` shifted by a constant, both
    affine, so this is one more interval proto and not one more IntVar. The
    start domain is what keeps `start - lead` inside its own day — see
    _create_lesson_decisions, which raises the lower bound by the lead for
    exactly that reason.

    Memoised like _padded, and for the same arithmetic: a lesson sits in its
    own group's family, in one family per sharing group and in the lunch's, so
    the interval is built once and handed out.

    ZERO IS THE MODEL AS IT WAS. With no buffers declared this returns
    padded_of's own answer — the padded interval, or the bare lesson when there
    is no corridor either — so a school that has written no number gets not one
    extra proto, and the pupils' families are the sets they have always been.
    """
    if decision.lead == 0 and decision.trail == 0:
        return padded_of(model, decision)
    if decision._pupils is None:
        decision._pupils = model.NewIntervalVar(
            decision.start - decision.lead,
            decision.duration + decision.lead + decision.trail + decision.changeover,
            decision.end + decision.trail + decision.changeover,
            f"pupils_{decision.lesson.key()}",
        )
    return decision._pupils


def pupil_key_of(requirement: AnonymousRequirement) -> UUID:
    """The requirement's key in the PUPIL space: who sits its lessons.

    Ersättande grupper. The engine keeps two key spaces, and every rule reads
    exactly one of them for its own lessons, its locked lessons and its
    partners alike:

    - THE PUPIL SPACE: who may not overlap whom because a pupil sits in both.
      This key, pupil_keys_of for a lock, and `groupConflicts` as the
      relation. The pairs' no-overlap, the locks' blocking, the walk's
      families, the cliques and every count that leans on "these lessons
      share pupils" read it.
    - THE CLASS SPACE: rules about the class — its daily maximum, the
      reservations on it, its rasts and its lunch, and every name a refusal
      gives. `student_group_id`, and a lock's studentGroupId and
      extraGroupIds, exactly as before.

    7A's svenska with pupilGroupId X is X's here and 7A's there. A rule that
    read its own lessons in one space and its partners' in the other would
    put the svenska into one no-overlap twice, through 7A and through X — an
    interval asked not to overlap itself, INFEASIBLE for every school with
    SvA (_add_group_no_overlap's docstring has the self-pair version) — or,
    the other way round, drop a constraint without a word. So every reader of
    this key says so by calling it, and a grep for pupil_key_of is the list of
    the pupil space's rules.

    Absent pupilGroupId is today's key, so a payload without the field reads
    every rule exactly as it did.
    """
    if requirement.pupil_group_id is not None:
        return requirement.pupil_group_id
    return requirement.student_group_id


def pupil_keys_of(fixed: FixedLesson) -> list[UUID]:
    """A locked lesson's keys in the PUPIL space: the groups whose pupils sit it.

    Its pupilGroupIds when the gateway sent them, which then REPLACE the
    groups the lock names; [studentGroupId, *extraGroupIds] otherwise, in
    that order, which is the reading every pupil rule made before. See
    pupil_key_of for the two spaces.
    """
    if fixed.pupil_group_ids is not None:
        return list(fixed.pupil_group_ids)
    return [fixed.student_group_id, *fixed.extra_group_ids]


def _by_pupils(decisions: list[LessonDecision]) -> list[list[LessonDecision]]:
    """The lessons split by pupil key, each part in the order given, parts by first seen.

    For a class-space rule that must say something about each lesson without
    saying anything about two of them together: every lesson filed under one
    class is ONE part when no pupilGroupId splits it, so such a rule posts
    exactly what it posted before.
    """
    parts: dict[UUID, list[LessonDecision]] = {}
    for decision in decisions:
        parts.setdefault(pupil_key_of(decision.lesson.requirement), []).append(decision)
    return list(parts.values())


def _grade_span_text(low: int | None, high: int | None) -> str:
    """A year span as a sentence shows it: "7", "4–6", or "" when unknown.

    An EN DASH, which is what the school's own screens use for a range, and a
    single year written once rather than as "7-7". Typography rather than
    language, so it belongs on this side: the value is substituted into every
    translation unchanged.
    """
    if low is None or high is None:
        return ""
    return str(low) if low == high else f"{low}\u2013{high}"


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Half-open [a, b) ranges, merged where they touch or overlap, in order."""
    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _subtract_range(
    ranges: list[tuple[int, int]], hole: tuple[int, int],
) -> list[tuple[int, int]]:
    """The ranges with [hole) cut out of them."""
    lo, hi = hole
    out: list[tuple[int, int]] = []
    for start, end in ranges:
        if hi <= start or lo >= end:
            out.append((start, end))
            continue
        if start < lo:
            out.append((start, lo))
        if hi < end:
            out.append((hi, end))
    return out


def _widest_free_run(
    open_slot: int,
    close_slot: int,
    blocks: list[tuple[int, int]],
) -> int:
    """The longest unbroken stretch of slots inside [open, close) after rasts.

    A frame leaves ONE window and its width is the answer; rasts leave several
    fragments, and a lesson needs one of them whole. Taking the total free time
    instead would accept a day of ten five-minute gaps as room for an hour.
    """
    longest = 0
    cursor = open_slot
    for first, last in blocks:
        start = max(first, open_slot)
        end = min(last, close_slot)
        if end <= start:
            continue
        longest = max(longest, start - cursor)
        cursor = max(cursor, end)
    return max(longest, close_slot - cursor)


@dataclass(frozen=True)
class _Clique:
    """A class and the groups the model will never let overlap with it or each other.

    `free_by_day` is day index -> merged [a, b) slot ranges within the day
    that at least one member may be taught in, less the locked lessons that
    block every member. `measure` is the greatest common divisor of the
    lessons' lengths in slots: every lesson is a whole number of it, so a gap
    rounded down to a multiple of it is a bound no placement beats.
    """

    members: list[UUID]
    requirements: list[AnonymousRequirement]
    demand: int
    measure: int
    free_by_day: dict[int, list[tuple[int, int]]]
    #: The one frame window every open day shares, as "08:00-13:30", for a
    #: sentence to quote; None when the days differ or nothing narrows them.
    window_text: str | None
    #: Slots of lessons one day can hold at the school's daily maximum: each
    #: class places at most min(weekly, maximum) lessons a day, none longer
    #: than its longest. Its weekly lessons when the school sets no maximum.
    day_cap: int


def _holds(ranges: list[tuple[int, int]], measure: int) -> int:
    """Slots of lessons the ranges can hold, each rounded down to whole measures."""
    return sum(((end - start) // measure) * measure for start, end in ranges)


@dataclass(eq=False)
class _LessonKind:
    """Lessons of one length on one set of starts, as the gaps verdict reads them.

    `lows` and `highs` are the start intervals, absolute and inclusive, after
    the bare cuts _lesson_kinds makes; `reach` is day index -> the merged
    [a, b) slots a lesson of the kind can occupy there. Compared by identity:
    two requirements whose lessons have the same length and the same starts
    share one kind. The benchmark schools have one or two kinds in all; a
    week whose teachers each have locks of their own has nearly one per
    requirement (1,292 for the 969 of a 2,000-pupil week with locks off the
    half hour, frames per year and teaching groups), which is why a gap
    reads lengths and a day set reads totals, never the kinds one by one.
    """

    slots: int
    lows: list[int]
    highs: list[int]
    reach: dict[int, list[tuple[int, int]]]

    def fits(self, start: int, end: int) -> bool:
        """Some start of the kind puts a whole lesson inside [start, end)."""
        last = end - self.slots
        if last < start:
            return False
        index = bisect_left(self.highs, start)
        return index < len(self.lows) and self.lows[index] <= last


@dataclass(frozen=True)
class _GapFill:
    """What one gap can take of the lessons that fit it, by minutes and by count.

    `sums` has bit k set when some of the lessons add up to exactly k slots,
    which is the subset sum, and `prefix` is their lengths shortest first,
    summed. Both answer for any length up to the gap's own, so a gap the lunch
    cuts in two is read twice from one table rather than built twice.
    """

    sums: int
    prefix: list[int]

    @classmethod
    def of(cls, length: int, lessons: Iterable[tuple[int, int]]) -> _GapFill:
        """From (slots, how many) pairs: a gap reads lengths, not kinds."""
        sums, limit = 1, (1 << (length + 1)) - 1
        sizes: list[int] = []
        for slots, count in lessons:
            # Never more copies than the gap could take: a sixth 60-minute
            # lesson changes nothing about a five-hour gap.
            copies = min(count, length // slots)
            sizes.extend([slots] * copies)
            for _ in range(copies):
                sums = (sums | (sums << slots)) & limit
        prefix = [0]
        for size in sorted(sizes):
            prefix.append(prefix[-1] + size)
        return cls(sums=sums, prefix=prefix)

    def slots(self, length: int) -> int:
        """The most slots whole lessons fill in `length`."""
        if length <= 0:
            return 0
        return (self.sums & ((1 << (length + 1)) - 1)).bit_length() - 1

    def lessons(self, length: int) -> int:
        """The most whole lessons `length` takes: the shortest, one after another."""
        if length <= 0:
            return 0
        return bisect_right(self.prefix, length) - 1


@dataclass(frozen=True)
class _Shortfall:
    """Some lessons of one teacher, group or set of rooms that their gaps cannot take.

    The lessons counted are those of `shortest` slots or more whose every
    possible day lies in `days`, a bit mask of day indices; `kinds` names them.
    `short_of` says which count gave out: "nowhere" when they fit no gap at
    all, "lessons" when there are more of them than the gaps take, else
    "minutes".
    """

    shortest: int
    days: int
    lessons: int
    fit_lessons: int
    demand: int
    capacity: int
    short_of: str
    kinds: frozenset[_LessonKind]


class _Gaps:
    """The gaps one teacher, group or set of rooms leaves its lessons, and what they take.

    SOUND BY THE BARE MODEL, and by nothing else. Every lesson of the
    resource lies inside one RUN, a maximal stretch of the union of the slots
    its lessons' kinds reach on a day: a lesson is contiguous and starts where
    its kind does, and a kind was cut to miss every locked lesson that shares
    its teacher or its pupils, so a teacher's or a group's runs never cross
    one of theirs. The resource's lessons never overlap (its NoOverlap), so
    the lessons in one run fill at most what its _GapFill says, by minutes
    and by count. A set of rooms holds `machines` lessons at once (the class
    pools' cumulatives, add_room_allocation), which is as many NoOverlaps,
    since intervals at most k deep split into k sets that never overlap, so
    its count is `machines` times one. A group's own lunch is in its
    NoOverlap too, and wherever the meal sits on a day it takes its slots out
    of the run it lands in, so a day holds at most its best placement. A
    lesson can fall only on the days it fits a run of, so lessons whose days
    all lie in D need no more than D's days hold: Hall's condition, checked
    over the unions of the days the lessons have. Every number here is an
    upper bound on a timetable of the bare model, so a shortfall means there
    is none, with every rule released.

    THE SHORTEST LESSON COUNTED IS A THRESHOLD, and each length of the
    resource's lessons is tried as one. Five lessons of 100 minutes and more
    in three 160-minute gaps is a shortfall that every lesson together hides,
    since the 45-minute ones fill the space the long ones cannot share.
    """

    #: Hall's condition is checked over every union of the lessons' day sets
    #: while there are at most this many distinct ones (2^10 unions), and over
    #: each set and the whole week beyond it. Real lessons have one or two.
    MAX_DAY_SETS = 10

    def __init__(
        self,
        kinds: Counter[_LessonKind],
        meals: dict[int, list[tuple[int, int]]],
        lunch_slots: int,
        machines: int = 1,
    ) -> None:
        self.kinds = kinds
        self.meals = meals
        self.lunch_slots = lunch_slots
        self.machines = machines
        spans: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for kind in kinds:
            for day_index, reach in kind.reach.items():
                spans[day_index].extend(reach)
        self.runs = {day_index: _merge_ranges(reach) for day_index, reach in spans.items()}
        self.days_of: dict[_LessonKind, int] = dict.fromkeys(kinds, 0)
        # Run -> lesson length -> how many of the lessons that fit it have it.
        # A gap's fill reads lengths only, and a week whose teachers each have
        # locks of their own has a kind per requirement but a handful of
        # lengths, so the fills are built from these and not from the kinds.
        self.lengths: dict[tuple[int, int], Counter[int]] = {}
        for day_index, runs in self.runs.items():
            for run in runs:
                lengths: Counter[int] = Counter()
                for kind, count in kinds.items():
                    if kind.fits(*run):
                        lengths[kind.slots] += count
                        self.days_of[kind] |= 1 << day_index
                self.lengths[run] = lengths
        self._held: dict[int, tuple[dict[int, int], dict[int, int]]] = {}

    def held(self, shortest: int) -> tuple[dict[int, int], dict[int, int]]:
        """Day index -> the most slots, and the most lessons, of `shortest` or more it takes."""
        if shortest in self._held:
            return self._held[shortest]
        slots_by_day: dict[int, int] = {}
        lessons_by_day: dict[int, int] = {}
        for day_index, runs in self.runs.items():
            fills = [
                _GapFill.of(
                    end - start,
                    (
                        (slots, count)
                        for slots, count in self.lengths[(start, end)].items()
                        if slots >= shortest
                    ),
                )
                for start, end in runs
            ]
            whole_slots = [fill.slots(end - start) for fill, (start, end) in zip(fills, runs)]
            whole_lessons = [fill.lessons(end - start) for fill, (start, end) in zip(fills, runs)]
            best_slots, best_lessons = sum(whole_slots), sum(whole_lessons)
            meal = self.meals.get(day_index)
            if meal:
                best_slots = best_lessons = -1
                length = self.lunch_slots
                for low, high in meal:
                    for lunch in range(low, high + 1):
                        filled, taken = sum(whole_slots), sum(whole_lessons)
                        for index, (start, end) in enumerate(runs):
                            if lunch + length <= start or lunch >= end:
                                continue
                            fill = fills[index]
                            filled += (
                                fill.slots(lunch - start) + fill.slots(end - lunch - length)
                                - whole_slots[index]
                            )
                            taken += (
                                fill.lessons(lunch - start) + fill.lessons(end - lunch - length)
                                - whole_lessons[index]
                            )
                        best_slots = max(best_slots, filled)
                        best_lessons = max(best_lessons, taken)
            slots_by_day[day_index] = best_slots
            lessons_by_day[day_index] = best_lessons
        self._held[shortest] = (slots_by_day, lessons_by_day)
        return self._held[shortest]

    def counted(self, shortest: int, days: int) -> list[_LessonKind]:
        """The kinds of `shortest` or more whose every day lies in `days`."""
        return [
            kind for kind in self.kinds
            if kind.slots >= shortest and self.days_of[kind] & ~days == 0
        ]

    def capacity(self, shortest: int, days: int) -> tuple[int, int]:
        """(lessons, slots) the days in `days` take of lessons of `shortest` or more."""
        slots_by_day, lessons_by_day = self.held(shortest)
        chosen = [day_index for day_index in self.runs if days >> day_index & 1]
        return (
            self.machines * sum(lessons_by_day[day_index] for day_index in chosen),
            self.machines * sum(slots_by_day[day_index] for day_index in chosen),
        )

    def shortfall(self) -> _Shortfall | None:
        """The first count the gaps cannot meet, the whole week before fewer days.

        The whole week is the sentence a school reads most easily, so it is
        looked at first; then the fewest days, which names the narrowest
        cause — "these lessons can only fall on Thursday". Within each, the
        shortest threshold first, so a refusal counts as many lessons as it can.
        """
        found: list[tuple[tuple[bool, int, int, int], tuple[int, int, int, int, int, int]]] = []
        for shortest in sorted({kind.slots for kind in self.kinds}):
            # Day set -> [lessons, slots] of the lessons of `shortest` or more
            # whose days are exactly that set: a handful of sets, however
            # many kinds.
            by_days: dict[int, list[int]] = defaultdict(lambda: [0, 0])
            for kind, count in self.kinds.items():
                if kind.slots >= shortest:
                    totals = by_days[self.days_of[kind]]
                    totals[0] += count
                    totals[1] += count * kind.slots
            week = 0
            for days in by_days:
                week |= days
            candidates = {0, week, *by_days}
            if len(by_days) <= self.MAX_DAY_SETS:
                for days in by_days:
                    candidates |= {union | days for union in candidates}
            for days in candidates:
                lessons = demand = 0
                for held_on, (count, slots) in by_days.items():
                    if held_on & ~days == 0:
                        lessons += count
                        demand += slots
                if lessons == 0:
                    continue
                fit_lessons, capacity = self.capacity(shortest, days)
                if lessons > fit_lessons or demand > capacity:
                    found.append((
                        (days != week, bin(days).count("1"), shortest, days),
                        (shortest, days, lessons, fit_lessons, demand, capacity),
                    ))
        if not found:
            return None
        shortest, days, lessons, fit_lessons, demand, capacity = min(
            found, key=lambda item: item[0],
        )[1]
        return _Shortfall(
            shortest=shortest,
            days=days,
            lessons=lessons,
            fit_lessons=fit_lessons,
            demand=demand,
            capacity=capacity,
            short_of=(
                "nowhere" if days == 0
                else "lessons" if lessons > fit_lessons
                else "minutes"
            ),
            kinds=frozenset(self.counted(shortest, days)),
        )


def _spaced_capacity(caps: list[tuple[int, int]], apart: int | None) -> int:
    """The most lessons (weekday, cap) pairs hold when lesson days lie `apart` apart.

    Without a spacing every day gives its cap. With one it is the best choice
    of days no two of which are closer than `apart` weekdays — weighted
    interval scheduling on a line, so a pass in weekday order: each day either
    joins the best answer among the days far enough before it, or does not.
    Five days at one a day and "not on consecutive days" is 3 (Monday,
    Wednesday, Friday); four days with Wednesday gone is 2.
    """
    if apart is None:
        return sum(cap for _weekday, cap in caps)
    days = sorted(caps)
    best = [0] * (len(days) + 1)
    for index, (weekday, cap) in enumerate(days, start=1):
        earlier = index - 1
        while earlier > 0 and days[earlier - 1][0] > weekday - apart:
            earlier -= 1
        best[index] = max(best[index - 1], best[earlier] + cap)
    return best[-1]


@dataclass(frozen=True)
class _LunchStarts:
    """One class's lunch starts on one day, as the model's four sentences.

    Absolute slots. The window is the school-wide rule and the variable's
    bounds; the other three are the narrowings the builder adds as
    constraints — the stage's sitting or frame, what the locked lessons
    leave, what the reservations leave — None where nothing narrows. Kept
    apart so a reader can name each one; composed() is what the variable
    may actually take.
    """

    window: cp_model.Domain
    declared: cp_model.Domain | None
    locked: cp_model.Domain | None
    closed: cp_model.Domain | None
    #: The start the school placed by hand, as a domain of one. Where it is set
    #: the other three are None — a pin outranks the window and the sitting,
    #: and the locks and reservations were checked against it before any build
    #: — and `window` is widened to hold it, so a meal drawn outside the school
    #: window is a narrowing like any other and never a variable that cannot
    #: be built.
    pinned: cp_model.Domain | None = None

    def composed(self) -> cp_model.Domain:
        domain = self.window
        for narrowing in (self.declared, self.locked, self.closed, self.pinned):
            if narrowing is not None:
                domain = domain.intersection_with(narrowing)
        return domain


@dataclass(frozen=True)
class _LunchStage:
    """The lunch stage's model, with one free literal per sentence it makes.

    `literals` is keyed (cause, group id): "eats", "lessons", "declared",
    "locked" and "closed" per class, and "hall" for the school with no group.
    "lessons" is there for a class that eats on no day too, with no "eats"
    beside it (_name_lunch_causes asks about those first).
    pinned() fixes every literal for one solve — true unless relaxed — on a
    clone, so the stage is built once and solved as many times as the
    naming needs. Clone() keeps variable indices, which is what lets the
    original's literals and starts address the clone's.
    """

    model: cp_model.CpModel
    starts: dict[tuple[UUID, int], cp_model.IntVar]
    literals: dict[tuple[str, UUID | None], cp_model.IntVar]
    headcounts: dict[UUID, int]
    #: Class -> the frame window its lessons share, for the sentence about them.
    window_texts: dict[UUID, str | None]

    def pinned(self, relaxed: set[tuple[str, UUID | None]]) -> cp_model.CpModel:
        clone = self.model.Clone()
        for key, literal in self.literals.items():
            clone.Add(literal == (0 if key in relaxed else 1))
        return clone


@dataclass(frozen=True)
class _TeacherDay:
    """One teacher's day, as the model addresses its two ends.

    `first` is the start of their earliest lesson that day and `last` the end
    of their latest, both in absolute slots; `works` is true exactly when they
    have a lesson on the day at all; `on_day` is the literal per lesson that
    decides it, and `taught` the slots those lessons occupy.

    TWO-SIDED AND UNCONDITIONAL, which is the difference between this and the
    pair _add_idle_time_objective used to build for itself. That one bounds
    `first` only from above and `last` only from below and says so: the
    objective minimises `last - first`, which drives each to the true extreme
    on its own, and the other half of every equality would have been two
    constraints bought for nothing.

    A HARD RULE CANNOT LEAN ON AN OBJECTIVE. The rest rule reads `last` on one
    day and `first` on the next, and the objective is not there to push them:
    it is switched off by a weight of zero, it skips a teacher with a single
    lesson, and on a day with no lesson at all nothing bounds either end. The
    direction the rest inequality happens to lean is the safe one today — it
    wants `last` small and `first` large, which are exactly the bounds the
    one-sided pair already carries — but that is a property of one inequality's
    shape and not of these variables, and the consecutive-teaching rule that is
    already planned reads them the other way round. So both ends are pinned,
    `works` is a variable rather than an assumption, and an empty day gives
    `first` the day's close and `last` its open: a span of minus a whole day,
    which the objective's floor at zero already handles and which no rest
    constraint is enforced over.
    """

    first: cp_model.IntVar
    last: cp_model.IntVar
    works: cp_model.IntVar
    on_day: tuple[cp_model.IntVar, ...]
    taught: cp_model.LinearExpr


@dataclass
class _TeacherDayLiterals:
    """Where each lesson landed and whether a teacher works a day: Lärarens dag's own.

    A SEPARATE CACHE FROM `teacher_days`, and the separation is the encoding.
    _TeacherDay is the rest rule's two-sided day, and _add_idle_time_objective
    reads first, last and taught off any entry it finds there — so an entry
    written by the cap would switch the idle term from its one-sided pair to
    the two-sided one for every teacher with a cap, and roughly double the
    satisfaction model for them (the rest rule measured +9,267 variables on
    the gate week for the same pair). Nothing here has a first or a last.

    `on_day` is keyed by the LESSON, not by the teacher: one literal per lesson
    and day it can fall on, exactly one of them true, shared by the lead and
    the co-teacher, since a co-taught lesson lands on one day for both.
    `works` is keyed (teacher, day index): true exactly when one of the
    teacher's lessons is there. Built lazily, for the teachers and days a rule
    can bind, so a school with no rule builds none of either.
    """

    on_day: dict[str, dict[int, cp_model.IntVar]] = field(default_factory=dict)
    works: dict[tuple[UUID, int], cp_model.IntVar] = field(default_factory=dict)


def settings_for_search(settings: Settings, search: SearchOptions | None) -> Settings:
    """The Settings one request is solved under: the deployment's, with the
    request's own budget when it brought one.

    A COPY, NEVER THE SHARED OBJECT. app.state.settings is read by every
    request this process serves at once, and a schemaförslag candidate and a
    school's own Generera can be solving side by side. A candidate's thirty
    seconds written onto it would become the next Generera's budget, and that
    Generera's TIMEOUT would tell a school it ran out of a minute it was never
    given.

    ONE FIELD CARRIES THE BUDGET EVERYWHERE. The phase caps, solve()'s
    deadline, the explanation's cap, the blocks verdict's remainder, the
    timeout diagnosis and the `budget` a TIMEOUT's conflict reports all read
    solver_max_time_seconds. Replacing that one value is what makes every one
    of them the request's; threading a number through instead would leave
    whichever reader nobody remembered on the configured minute.

    ONLY EVER SMALLER. The request's maxSeconds is min'd with the configured
    budget, so no caller buys more time than the deployment gives a Generera.
    The TIMEOUT probe is bounded by half of maxSeconds, so a candidate's
    explanation costs at most half of what its search was allowed; with
    probes off it is never run, and its bound does not matter.

    IDEMPOTENT, and the very same object when nothing changes: absent search,
    one without maxSeconds, or a maxSeconds that lowers neither bound returns
    `settings` itself. run_solver scopes the settings before it builds
    the solver and solve() scopes them again for a direct caller (the
    benchmarks, the tests); the second call is then a no-op.
    """
    if search is None or search.max_seconds is None:
        return settings
    update: dict[str, float] = {}
    budget = min(float(search.max_seconds), settings.solver_max_time_seconds)
    if budget != settings.solver_max_time_seconds:
        update["solver_max_time_seconds"] = budget
    if search.runs_probes:
        probe = min(settings.solver_probe_seconds, search.max_seconds / 2)
        if probe != settings.solver_probe_seconds:
            update["solver_probe_seconds"] = probe
    return settings.model_copy(update=update) if update else settings


def _runs_probes(request: OptimizeScheduleRequest) -> bool:
    """Whether this request pays for the explaining work a refusal buys.

    True unless the request says otherwise: see SearchOptions.probes.
    """
    return request.search is None or request.search.runs_probes


#: A UUID anywhere in an exception's text. The model's variable names carry the
#: payload's ids (lunchstart_<group>_<day>), and an OR-Tools message may quote
#: one.
_UUID_TEXT = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
)


def _without_ids(error: Exception) -> str:
    """The exception's own text for the log, with every id taken out."""
    return _UUID_TEXT.sub("<id>", str(error))[:200]


class SolverCrashedError(RuntimeError):
    """CP-SAT threw out of phase 1b, with presolve and without.

    NOT an OptimizationEngineError, deliberately: main.py answers those with
    the exception's own text, and this one's is CP-SAT's internals, nothing a
    school can read. It reaches unhandled_exception_handler, the 500 it was
    before _solve_guarded, with its text already stripped of ids.
    """


def _solve_guarded(
    solver: cp_model.CpSolver,
    model: cp_model.CpModel,
    *,
    what: str,
    request_id: UUID,
    degrade: bool = True,
) -> cp_model.CpSolverStatus:
    """solver.Solve(model), retried once without presolve when CP-SAT throws.

    EVERY Solve in this module goes through here. CP-SAT can throw out of
    Solve on a model it accepts, and nothing above the call caught it: the
    request reached main.py's unhandled_exception_handler and the school's
    Generera came back a 500. Lärarens dag met it in production code —
    CP-SAT 9.15.6755's presolve threw `IndexError:
    absl::container_internal::raw_hash_map<>::at` on two constant-bound
    weighted rows over the same one-hot day literals — and this guard's fuzz
    then found the same throw from three builders' caps on a day, which now
    stand on day totals that presolve does not throw on (_day_totals, where
    the upstream bug is named). The next such row needs nobody to find it
    first.

    ONCE MORE WITHOUT PRESOLVE. The crash seen is presolve's, and a search
    without presolve works on the model exactly as built: the same
    constraints, so the same verdicts, found more slowly. A week of that
    shape written straight in CP-SAT, the old rows and all, throws with
    presolve and is proved INFEASIBLE without it (test_solve_guard.py keeps
    it). The retry gets what the first attempt left of the solver's
    own time limit, never a second one: run_solver answers 503 at the budget
    plus thirty seconds, and a slice paid twice would trade the 500 for that.

    UNKNOWN WHEN THE RETRY THROWS TOO, or no time is left for it, wherever
    the caller has something truer to say than the throw. UNKNOWN is the
    status of a solve that decided nothing, and every such caller already
    reads it so: phase 1a hands over to the cleared clone, a phase 2 with
    nothing returns phase 1's timetable, the explanation leaves the proved
    INFEASIBLE unexplained, a probe finds nothing and the lunch stage leaves
    the full model to decide. A guard around solve() as a whole would have
    thrown away a timetable phase 1 had already found.

    RAISED IN PHASE 1B (degrade=False), the last solve that can find a
    timetable. Its UNKNOWN becomes the TIMEOUT, and a TIMEOUT tells the
    school that its week did not fit in the budget and that a longer one may
    help. A crash is neither: a deterministic one came back TIMEOUT after
    0.00 s, under probes that reported nothing helped because they had
    crashed too. So it is raised as SolverCrashedError — a 500, as before
    this guard, an ERROR in the log, and no probe run.

    ANY EXCEPTION BUT OUR OWN. OR-Tools turns a C++ exception into whatever
    Python type its binding maps it to — IndexError for absl's out_of_range,
    RuntimeError, ValueError — so naming the one type seen would guard only
    the crash already fixed. An OptimizationEngineError carries a meaning its
    own handler gives the school, and passes through.

    THE LOG NAMES THE SOLVE, THE REQUEST AND THE EXCEPTION, never one of the
    school's ids. The request as _timeout_diagnosis writes it,
    [requestId=…]: this runs on run_solver's thread through the stdlib
    logger, which merges no structlog context, and two schemaförslag
    candidates solving side by side must be told apart when a retry that
    succeeded leaves this line as its only trace. The exception's text with
    every UUID taken out: the model's variable names carry the payload's.
    """
    # Outside the try: an OR-Tools without the deprecated alias must fail
    # loudly, not turn every solve into a TIMEOUT.
    solve = solver.Solve
    limit = solver.parameters.max_time_in_seconds
    started = time.monotonic()
    try:
        return solve(model)
    except OptimizationEngineError:
        raise
    except Exception as error:
        last = error
    how = "with no time left to retry"
    left = limit - (time.monotonic() - started)
    if left > 0:
        logger.warning(
            "cp-sat raised %s in %s [requestId=%s] (%s); solving once more without presolve",
            type(last).__name__, what, request_id, _without_ids(last),
        )
        presolve = solver.parameters.cp_model_presolve
        solver.parameters.cp_model_presolve = False
        solver.parameters.max_time_in_seconds = left
        try:
            return solve(model)
        except OptimizationEngineError:
            raise
        except Exception as error:
            last = error
            how = "again without presolve"
        finally:
            solver.parameters.cp_model_presolve = presolve
            solver.parameters.max_time_in_seconds = limit
    said = (
        f"cp-sat raised {type(last).__name__} in {what} {how} "
        f"[requestId={request_id}] ({_without_ids(last)})"
    )
    if not degrade:
        raise SolverCrashedError(said) from None
    logger.error("%s; the solve decided nothing", said)
    return cp_model.UNKNOWN


class SchedulerSolver:
    """CP-SAT weekly master timetable optimizer."""

    # Hard ceilings applied before any CP-SAT model is constructed. The solver's
    # wall-clock timeout only bounds Solve(); the model-BUILD phase (variable and
    # constraint creation) runs first and scales multiplicatively with the input
    # list lengths. These budgets reject pathological payloads up front so a
    # single request cannot exhaust CPU/RAM before the timeout can engage.
    #
    # MAX_MODEL_COMPLEXITY bounds _estimate_model_size, a per-builder prediction
    # of the variable count (within ~8% of the real model on the benchmark
    # school). Build cost is ~17 microseconds per variable single-threaded, so
    # one million variables is roughly 15-20s of build and one to two GB of
    # proto — the edge of acceptable for a single request, and an order of
    # magnitude above a 2,000-student school (~100K).
    #
    # An earlier formula (lessons x rooms + lessons x constraints x days)
    # predated the room-class and interval-lunch encodings: its dominant term
    # tracked 3% of the real cost, grew ~n^3 against a ~n^2 model, and rejected
    # the 2,000-student benchmark that actually builds in 1.6s.
    MAX_LESSON_INSTANCES = 5_000
    MAX_MODEL_COMPLEXITY = 1_000_000

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._grid = TimeGrid(
            day_start_minutes=settings.schedule_day_start_minutes,
            day_end_minutes=settings.schedule_day_end_minutes,
            slot_minutes=settings.slot_minutes,
            schedule_days=tuple(settings.schedule_days),
        )

    def _build_model(
        self,
        request: OptimizeScheduleRequest,
        *,
        use_assumptions: bool,
        include_objective: bool = True,
    ) -> tuple[
        cp_model.CpModel,
        AssumptionRegistry,
        list[LessonDecision],
        RoomPlan,
        dict[tuple[UUID, int], cp_model.IntVar],
    ]:
        """Construct the CP-SAT model.

        `use_assumptions` is threaded through to the registry; see its docstring
        for why the default build keeps CpModel.assumptions empty.

        `include_objective=False` builds the satisfaction model for phase 1.
        Constraints are identical either way — only the objective terms and
        their auxiliary variables are omitted. Merely clearing the objective on
        a clone is NOT equivalent: the auxiliary variables stay behind as free
        variables, and a few thousand functionally-determined free literals are
        measurably enough to flip a solvable satisfaction model to UNKNOWN.
        """
        model = cp_model.CpModel()
        registry = AssumptionRegistry(use_assumptions=use_assumptions)
        rooms = request.rooms
        # Read off THIS request, never kept on the solver: the timeout probe
        # builds a relaxed copy of the week, and a week without its rasts or
        # its sittings may step further than the week that timed out.
        step = _start_step(request, self._grid)
        # Restid i generatorn, None unless the school turned it on and wrote a
        # walk between two sites its rooms stand on: then nothing below builds
        # a row of it, and the model is the one it was. See travel.py.
        travel = travel_map(request, slot_minutes=self._grid.slot_minutes, step=step)
        decisions = self._create_lesson_decisions(
            model, request.requirements, len(rooms), request.frame_times, request.rasts,
            step=step,
        )

        # Parallella block, first among the rules because it only says which
        # starts are the same start: every family below then sees one block
        # lesson where the school sees one.
        self._add_block_constraints(model, registry, decisions, request.requirements)
        self._add_capacity_constraints(model, registry, decisions, rooms)
        self._add_teacher_no_overlap(model, decisions)
        self._add_group_no_overlap(model, decisions, request.group_conflicts)
        room_plan = self._add_room_allocation(
            model,
            decisions,
            rooms,
            request.constraints,
            request.fixed_lessons,
            request.room_preferences,
            site_key=travel.site_key if travel is not None else None,
        )
        self._add_availability_constraints(model, registry, decisions, rooms, request.constraints)
        # Before the locked lessons, whose rows read the sites; the day cache
        # is made here for the same builder, which stretches a row over the
        # night only where the domains need it (travel.TravelRows._wraps).
        day_vars: dict[str, cp_model.IntVar] = {}
        travel_rows = (
            self._travel_rows(model, registry, room_plan, travel, day_vars)
            if travel is not None
            else None
        )
        self._add_fixed_lesson_constraints(
            model, decisions, rooms, request.fixed_lessons, request.group_conflicts,
            travel_rows=travel_rows,
        )
        if travel_rows is not None:
            for family in families_of(decisions, request.group_conflicts):
                travel_rows.add_family(model, family)

        lunch_starts = self._add_rules_constraints(
            model, registry, decisions, request.rules, day_vars,
            request.fixed_lessons, request.groups, request.constraints,
            request.lunch_servings, request.frame_times,
            request.group_conflicts, request.lunch_placements,
            step=step,
        )
        # After the lunch, because a rast's stretch is counted from the
        # previous break and the class's own meal can be that break.
        self._add_rast_ordering_constraints(
            model, registry, request, decisions, lunch_starts,
        )
        # The teachers' own lunch and rest. BEFORE THE OBJECTIVE, and that is
        # the only ordering this builder has: the idle term measures the same
        # two ends the rest rule bounds, and reads the pair left here in
        # `teacher_days` rather than building a second, weaker one of its own.
        # See _TeacherDay. Nothing here touches a lunch or a rast variable, so
        # its place among the other rule builders says nothing at all.
        teacher_days: dict[tuple[UUID, int], _TeacherDay] = {}
        self._add_teacher_work_constraints(
            model,
            registry,
            decisions,
            request.teacher_work_rules,
            request.fixed_lessons,
            request.constraints,
            day_vars,
            teacher_days,
            step=step,
        )
        # Lärarens dag: the cap on a teacher's minutes a day and the post's
        # limit on their days. RIGHT AFTER the work rules, because it READS
        # what the rest rule left in `teacher_days` — a teacher with a rest
        # already has a literal per lesson and day and a `works`, and building
        # a second set beside them would be two answers to "does Anna teach on
        # Tuesday" — and never writes there. Its own literals go in
        # `day_literals`, which the free-day wish below reads in turn.
        day_literals = _TeacherDayLiterals()
        self._add_teacher_day_constraints(
            model,
            registry,
            decisions,
            request.teacher_work_rules,
            request.teacher_day_limits,
            request.fixed_lessons,
            day_vars,
            teacher_days,
            day_literals,
        )
        # Ämnesfördelning. On the day variables alone, so its place among the
        # rule builders says nothing; it reads `day_vars` as the spread
        # objective does and builds the same one per lesson where both run.
        self._add_distribution_constraints(model, registry, decisions, day_vars)
        if include_objective:
            weights = self._resolve_weights(request)
            # The wishes the objective prices, read once: the free-day term
            # pays for them and the disruption term stops paying AGAINST them.
            wished_free = self._free_day_wishes(request, weights)
            objective_terms = [
                *self._add_preference_objective(
                    model, decisions, rooms, request.constraints, weights,
                ),
                *self._add_disruption_objective(
                    model, decisions, request.previous_lessons, weights,
                    wished_free=set(wished_free),
                ),
                *self._add_lunch_stability_objective(model, lunch_starts, weights),
                *self._add_spread_objective(model, decisions, weights, day_vars),
                *self._add_idle_time_objective(
                    model, decisions, request.constraints, weights, day_vars,
                    teacher_days,
                ),
                *self._add_room_preference_objective(
                    model, decisions, rooms, room_plan, request.room_preferences, weights,
                ),
                *self._add_free_day_objective(
                    model, decisions, wished_free, weights, teacher_days, day_literals,
                ),
            ]
            model.Minimize(sum(objective_terms) if objective_terms else 0)
        return model, registry, decisions, room_plan, lunch_starts

    def _dining_hall_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """The whole hall against the whole window, decided by arithmetic.

        The validator refuses one class too big for the hall, and one sitting
        too small for its stage. Between them sat the school in the report:
        every class fits, no sittings declared, and 480 children eating thirty
        minutes each in 115 seats over a 150-minute window is 14,400
        student-minutes against 17,250 — a week with a timetable only if every
        wave of the hall fills to within a class of capacity, every day. CP-SAT
        hunted that needle for the whole budget and answered TIMEOUT, which
        names nothing.

        Student-minutes is the cumulative's own relaxation, so a payload that
        fails it has no timetable, and this can say so without a solve. It says
        so in the SAME SHAPE the solver would have: INFEASIBLE, a
        DINING_CAPACITY conflict carrying the registry's own sentence, and the
        numbers in the summary — the page already translates the category, and
        a 400 for the same fact would be a second way of saying it. A payload
        that passes narrowly is left to the solver, and to the probe.
        """
        rules = request.rules
        if (
            rules is None
            or not _lunch_window_is_set(rules)
            or rules.dining_seats is None
            or rules.lunch_minutes is None
            or not request.groups
        ):
            return None
        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
        lunch_group_ids = _lunch_group_ids(
            request.groups, _group_ids_with_lessons(request.requirements),
        )
        _, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        headcount_by_group = _lunch_headcounts(request.groups)
        # A meal the school placed outside the window takes no chair inside it,
        # and counting it would refuse a week whose hall is fine. Left out
        # generously — a pin partly inside is left out whole — because this is
        # a proof of impossibility, and every child it under-counts only hands
        # the question to the solver.
        pins = self._lunch_pins(request.lunch_placements, lunch_group_ids)
        window_minutes = (window_end - window_start) * self._grid.slot_minutes
        offered = rules.dining_seats * window_minutes
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            eating = sum(
                headcount_by_group.get(group_id, 0)
                for group_id in lunch_group_ids
                if (group_id, day_index) not in exempt_days
                and (
                    (group_id, day_index) not in pins
                    or window_start <= pins[(group_id, day_index)] <= window_end - lunch_slots
                )
            )
            needed = eating * rules.lunch_minutes
            if needed > offered:
                return ConflictAnalysis(
                    summary_code="LUNCH_HALL_CANNOT_FEED_THE_SCHOOL",
                    summary_params={
                        "day": day_of_week,
                        "students": eating,
                        "minutes": rules.lunch_minutes,
                        "needed": needed,
                        "seats": rules.dining_seats,
                        "windowStart": rules.lunch_start_time[:5],
                        "windowEnd": rules.lunch_end_time[:5],
                        "offered": offered,
                    },
                    conflicts=[
                        ConflictDetail(
                            category="DINING_CAPACITY",
                            code="LUNCH_SEATS_CANNOT_STAGGER",
                            params={"seats": rules.dining_seats},
                        ),
                    ],
                )
        return None

    def _cliques(self, request: OptimizeScheduleRequest) -> list[tuple[AnonymousGroup, _Clique]]:
        """One clique per group in the payload, with its hours and its free time.

        SOUND BY THE MODEL'S OWN RULE, not by who is in which group. The engine
        forbids overlap PAIRWISE between any two groups that share a pupil, so
        a set of groups that pairwise share pupils — a clique — may never run
        two lessons at once, whether or not one child sits in all of them. The
        lessons of a clique therefore need, between them, at least their summed
        length of the clique's free time; and this counts only cliques, never
        the looser set of "everyone who shares with the class", because two
        halves of a class share with it and not with each other and CAN overlap.

        Greedy, in payload order — any clique is sound, and the whole set is
        not. Two readers, the hours verdict and the lunch stage, and one
        builder, so they can never disagree about who may not overlap whom.
        The lunch stage reads day_cap twice, in its sentence and in its count
        with no meal, and the field is what keeps the two the same bound.

        EVERYTHING LEANS THE OPTIMISTIC WAY, so a refusal built on these
        numbers is a refusal the model would have made: the free time is the
        UNION of the windows the model binds the clique's lessons by — each
        requirement's own years, see below — and only a locked lesson that
        blocks EVERY member is subtracted; one that blocks some leaves the
        others free, and subtracting it would refuse a week the model accepts.

        THE MEMBERS ARE THE PUPIL SPACE'S (pupil_key_of, pupil_keys_of), the
        keys the pairwise no-overlap and the locks' blocking are posted on,
        which is what makes "pairwise share" mean "may never overlap". 7A's
        svenska sat by "7A without SvA7" is X's: X and SvA7 are no pair, so
        no clique holds both, and a week that fits only with SvA beside the
        svenska is not refused for 7A's hours plus SvA7's. The class still
        leads its clique (its group entry is the class); its lessons a
        derived key holds join through that key, a pair of the class's.
        """
        sharing = _groups_sharing_students(request.group_conflicts)
        requirements_of: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
        for requirement in request.requirements:
            requirements_of[pupil_key_of(requirement)].append(requirement)
        slots_per_day = self._grid.slots_per_day
        max_per_day = request.rules.max_lessons_per_day_per_group if request.rules else None
        fixed_windows = [
            (fixed, self._fixed_window(fixed))
            for fixed in request.fixed_lessons
        ]

        cliques: list[tuple[AnonymousGroup, _Clique]] = []
        for group in request.groups:
            members: list[UUID] = [group.id]
            for other in sharing.get(group.id, ()):
                if other in requirements_of and all(
                    other in sharing.get(member, ()) for member in members
                ):
                    members.append(other)
            requirements = [
                requirement for member in members for requirement in requirements_of.get(member, [])
            ]
            if not requirements:
                continue
            # Every LESSON's length, not every requirement's: a requirement of
            # 1 × 80 + 1 × 40 demands 120 minutes and packs on gcd(80, 40).
            lengths = [
                self._grid.minutes_to_slots(minutes)
                for r in requirements
                for minutes in r.lesson_minutes()
            ]

            # Whose years open which window: EVERY REQUIREMENT'S OWN, the way
            # the model binds each lesson (span_of(requirement) in the
            # decision builder), and never the group's. The group's span
            # governs only where its lunch may sit. This first read the class
            # off its group entry and a member off its first requirement, and
            # a panel found the week it refuses: a class whose group carries
            # years 4-4 under a frame closing 12:30 while its requirement
            # carries none — the model lets those lessons run to 18:00, the
            # count did not, and a schedulable week was refused twice over.
            # The gateway sends one span to both today; the engine does not
            # get to rely on that.
            spans = {span_of(requirement) for requirement in requirements}
            windows_of = [day_windows(request.frame_times, span, self._grid) for span in spans]
            member_set = set(members)

            free_by_day: dict[int, list[tuple[int, int]]] = {}
            open_by_day: dict[int, list[tuple[int, int]]] = {}
            for day_index in range(len(self._grid.schedule_days)):
                base = day_index * slots_per_day
                open_ranges = [windows[day_index] for windows in windows_of if day_index in windows]
                if not open_ranges:
                    continue
                free = _merge_ranges(open_ranges)
                open_by_day[day_index] = free
                for fixed, window in fixed_windows:
                    if window is None:
                        continue
                    blocked_groups = set(pupil_keys_of(fixed))
                    blocks_all = all(
                        member in blocked_groups
                        or any(g in sharing.get(member, ()) for g in blocked_groups)
                        for member in member_set
                    )
                    if not blocks_all:
                        continue
                    lo, hi = window[0] - base, window[1] - base
                    if hi <= 0 or lo >= slots_per_day:
                        continue
                    free = _subtract_range(free, (max(lo, 0), min(hi, slots_per_day)))
                free_by_day[day_index] = free

            # THE CLASS SPACE, deliberately, though the clique is the pupils':
            # this bound reads the school's daily maximum, which the model
            # counts per class (7A's svenska is 7A's lesson there, whoever sits
            # it). Every requirement of the clique is in exactly one class, so
            # the sum over classes still bounds the clique's day. Each places
            # at most its weekly lessons, and at most the maximum, on one day
            # — each no longer than its longest. A bound on the count, not a
            # placement.
            by_class: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
            for requirement in requirements:
                by_class[requirement.student_group_id].append(requirement)
            day_cap = 0
            for class_requirements in by_class.values():
                weekly = sum(r.lessons_per_week for r in class_requirements)
                longest = max(
                    self._grid.minutes_to_slots(r.minutes_per_lesson) for r in class_requirements
                )
                per_day = weekly if max_per_day is None else min(weekly, max_per_day)
                day_cap += per_day * longest

            cliques.append((
                group,
                _Clique(
                    members=members,
                    requirements=requirements,
                    demand=sum(lengths),
                    measure=math.gcd(*lengths),
                    free_by_day=free_by_day,
                    window_text=self._shared_window_text(open_by_day),
                    day_cap=day_cap,
                ),
            ))
        return cliques

    def _shared_window_text(self, open_by_day: dict[int, list[tuple[int, int]]]) -> str | None:
        """"08:00-13:30" when every open day is that one window, else None.

        The sentence that names a packed day wants to quote the frame that
        packs it, and can only do so honestly when there is one such frame;
        a week of differing days, or one nothing narrows, gets no times.
        """
        windows = {tuple(ranges) for ranges in open_by_day.values()}
        if len(windows) != 1:
            return None
        (ranges,) = windows
        if len(ranges) != 1:
            return None
        (open_slot, close_slot) = ranges[0]
        if open_slot == 0 and close_slot == self._grid.slots_per_day:
            return None

        def clock(slot: int) -> str:
            minutes = self._grid.day_start_minutes + slot * self._grid.slot_minutes
            return f"{minutes // 60:02d}:{minutes % 60:02d}"

        return f"{clock(open_slot)}-{clock(close_slot)}"

    def _clique_hours_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """Hours against hours, for groups the model will never let overlap.

        The second reproduction of the report: two locked lessons at 11-12 and
        12-13 on every weekday pin the class's lunch to 10:30, the class is
        busy 10:30-13:00, and 08:00-10:30 plus 13:00-15:30 hold four lessons a
        day — twenty a week for a class that needs twenty-four. Provably
        infeasible by counting; CP-SAT could not prove it in 120 s and answered
        UNKNOWN, which the engine reported as TIMEOUT.

        The clique and its free time come from _cliques, which says why the
        count is sound. What is decided here is what a gap HOLDS: the lunch is
        placed wherever it wastes least, and a gap is rounded down to a
        multiple of the clique's lessons' COMMON MEASURE, their greatest common
        divisor. Not the shortest lesson, which this first shipped with: a
        105-minute day holds a 60- and a 45-minute lesson exactly, and rounding
        it down to a multiple of 45 called it 90 and refused five such days
        for a class the model placed in under a second. The measure is still
        a bound the model cannot beat — every lesson is a whole number of it.
        """
        if not request.groups:
            return None
        classes = _derived_key_classes(request)
        rules = request.rules
        lunch_on = rules is not None and _lunch_window_is_set(rules)
        if lunch_on:
            window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
            lunch_group_ids = _lunch_group_ids(
                request.groups, _group_ids_with_lessons(request.requirements),
            )
            _, exempt_days = self._lunch_starts_blocked_by_constraints(
                request.constraints, set(lunch_group_ids),
                window_start, window_end - lunch_slots, window_end, lunch_slots,
            )
        else:
            window_start = window_end = lunch_slots = 0
            exempt_days = set()

        for group, clique in self._cliques(request):
            measure = clique.measure
            capacity = 0
            # The same count with no meal to seat: when THAT would have held the
            # lessons, the lunch is the difference and is named as such.
            capacity_without_lunch = 0
            for day_index, free in clique.free_by_day.items():
                capacity_without_lunch += _holds(free, measure)
                if lunch_on and (group.id, day_index) not in exempt_days:
                    # The meal must sit inside the window AND inside free time;
                    # the placement that wastes least is the one that counts.
                    best = 0
                    placed = False
                    for start in range(window_start, window_end - lunch_slots + 1):
                        if any(a <= start and start + lunch_slots <= b for a, b in free):
                            placed = True
                            best = max(
                                best,
                                _holds(_subtract_range(free, (start, start + lunch_slots)), measure),
                            )
                    if not placed:
                        # No lunch fits this day at all — a refusal of its own,
                        # made elsewhere by name. Not this verdict's to make.
                        return None
                    capacity += best
                else:
                    capacity += _holds(free, measure)

            demand = clique.demand
            if demand > capacity:
                minutes = self._grid.slot_minutes
                details = []
                if lunch_on and demand <= capacity_without_lunch:
                    # The hours do not fit, and the same count without the meal
                    # would let them through. A school that reads only "too
                    # many lessons" would go to the timplan; the lever may be
                    # the lunch window or the lock beside it. Said as a count
                    # and no more: the count leaves out the margins between
                    # lessons and every rule, so it cannot say the week would
                    # fit without the lunch, and the sentence does not.
                    details.append(
                        ConflictDetail(
                            category="LUNCH_WINDOW",
                            code="LUNCH_BREAK_IS_THE_DIFFERENCE",
                            params={
                                "lunchMinutes": rules.lunch_minutes,
                                "freeMinutes": capacity_without_lunch * minutes,
                            },
                            resource_ids=[group.id],
                        ),
                    )
                # The groups sharing the class's pupils, as the school names
                # them: a derived key ("7A without SvA7") is its class, not a
                # group of its own (_derived_key_classes, empty without
                # pupilGroupId, when the count is the one it always was).
                sharing_groups = (
                    len({classes.get(member, member) for member in clique.members} - {group.id})
                    if classes
                    else len(clique.members) - 1
                )
                return ConflictAnalysis(
                    summary_code="DEMAND_CLIQUE_HOURS_SHORT",
                    summary_params={
                        "group": str(group.id),
                        "sharingGroups": sharing_groups,
                        "demandMinutes": demand * minutes,
                        "capacityMinutes": capacity * minutes,
                    },
                    conflicts=[
                        ConflictDetail(
                            category="REQUIREMENT_DEMAND",
                            code="DEMAND_REQUIREMENTS_EXCEED_WEEK",
                            params={
                                "requirements": len(clique.requirements),
                                "demandMinutes": demand * minutes,
                                "capacityMinutes": capacity * minutes,
                            },
                            requirement_ids=[r.id for r in clique.requirements],
                            resource_ids=[group.id],
                        ),
                        *details,
                    ],
                )
        return None

    def _teacher_hours_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """A teacher's week against the room their lessons can take, decided by arithmetic.

        The four weeks of the fuzz that still came back CONFLICT_NO_CORE after
        the class maximum got its literal were one week four times. The frame
        times closed every day but one for year 7, and a teacher whose classes
        were all year 7 had more minutes of lessons than that day held: 550
        against Tuesday's 420 in one of them, 800 against 785 in another. No
        rule is needed for that. The lessons' starts are their frames, and the
        teacher's NoOverlap and the locked lessons' avoidance are posted bare,
        so the explaining solve proved the week impossible with every literal
        released. The core was empty, and the school read the guess about
        rooms and teacher time, of which only the teacher's time was right.
        Lärarens dag's bare linking rows are what let presolve see the sum at
        once. Where a teacher has no days limit, CP-SAT finds a slower proof
        through literals, and the core it returns is worse than empty: on the
        smallest such week it said no room held the classes, with two rooms of
        thirty for classes of twenty and sixteen. In the same fuzz this count
        decides 119 of the 557 impossible weeks; 114 of them came back with a
        core, and every one of those weeks is impossible with every literal
        released, so no line of their cores was needed.

        So the count is made here, before any model, and named for what it is:
        the hours, not a rule. The days pre-flight makes the same count for a
        teacher with a post, and leaves the week alone where it tips, because
        the post is not what tips it (_verify_teacher_day_rules).

        SOUND BY THE LINKING ROWS' ARGUMENT (_teaching_room). Every lesson the
        teacher has lies inside the union of the slots its starts can reach.
        No two of them overlap (their NoOverlap, corridor included), and none
        overlaps a locked one (its avoidance, at the outward window). So no
        timetable gives them more minutes than the union less the locks.
        Reservations are not subtracted. They hang on literals, so a week they
        make impossible goes to the model and is named by the reservation.
        Neither is the cap or the post: the room is every day's, uncapped,
        so a week this refuses has no timetable with every rule released.

        EVERY TEACHER, lead and co-teacher alike (_teachers_of), each
        requirement once. The bound has nothing to do with a post or a cap,
        and a teacher with neither is the one whose core used to blame the
        rooms. A teacher whose every lesson is locked has nothing to place,
        and is refused nothing.

        NEVER THE TEACHER'S ID. The gateway discards the teacher map by
        design, and an anonymous teacher id would leave as a uuid nobody can
        look up. So each line names that teacher's requirements, which the
        page shows as "Matematik för 7B", the way the unstaffed refusal does.
        """
        # Per lesson (_teacher_week): a split post charges each lead their own
        # lessons only, so Bertil's one of the three is never read as all three.
        week_minutes, _longest, requirements_of = _teacher_week(request.requirements)
        if not week_minutes:
            return None

        minutes = self._grid.slot_minutes
        rooms = self._teacher_rooms(request, requirements_of)
        conflicts = []
        for teacher_id, demand in week_minutes.items():
            room = rooms[teacher_id]
            capacity = sum(room.values()) * minutes
            if demand <= capacity:
                continue
            requirements = requirements_of[teacher_id]
            conflicts.append(
                ConflictDetail(
                    category="REQUIREMENT_DEMAND",
                    code="DEMAND_TEACHER_LESSONS_EXCEED_ROOM",
                    params={
                        "requirements": len(requirements),
                        "demandMinutes": demand,
                        "capacityMinutes": capacity,
                        "days": sum(1 for slots in room.values() if slots > 0),
                        "weekDays": len(self._grid.schedule_days),
                    },
                    requirement_ids=[requirement.id for requirement in requirements],
                    resource_ids=[requirement.id for requirement in requirements],
                ),
            )
        if not conflicts:
            return None
        return ConflictAnalysis(
            summary_code="DEMAND_TEACHER_HOURS_SHORT",
            summary_params={"teachers": len(conflicts)},
            conflicts=conflicts,
        )

    def _teacher_rooms(
        self,
        request: OptimizeScheduleRequest,
        requirements_of: dict[UUID, list[AnonymousRequirement]],
    ) -> dict[UUID, dict[int, int]]:
        """Teacher -> day index -> the slots their lessons can take there, at most.

        _teaching_room on the starts the model builds (_start_domains) and the
        teacher's own locked lessons. Read by the hours verdict and by the
        days pre-flight, one computation for both, so the two can never
        disagree about a day. A requirement's starts are read once, for its
        lead and its co-teacher alike, and once per LENGTH rather than per
        lesson: lessons of one length start on one domain and reach the same
        slots, and the room is their union, which a second copy cannot change.
        Read per lesson, the 2,000-student benchmark spent two thirds of the
        verdict reaching the same slots three times.
        """
        slots_per_day = self._grid.slots_per_day
        lattice = _start_lattice(_start_step(request, self._grid), self._grid.horizon)
        locked_busy = self._teacher_busy_from_locks(request.fixed_lessons)
        reaches_of: dict[UUID, list[dict[int, list[tuple[int, int]]]]] = {}
        rooms: dict[UUID, dict[int, int]] = {}
        for teacher_id, requirements in requirements_of.items():
            reaches = []
            for requirement in requirements:
                if requirement.id not in reaches_of:
                    domains = self._start_domains(
                        requirement, request.frame_times, request.rasts, lattice,
                    )
                    reaches_of[requirement.id] = [
                        _day_reach(domains[duration], duration, slots_per_day)
                        for duration in sorted({
                            self._grid.minutes_to_slots(minutes)
                            for minutes in requirement.lesson_minutes()
                        })
                    ]
                reaches.extend(reaches_of[requirement.id])
            rooms[teacher_id] = self._teaching_room(reaches, locked_busy, teacher_id)
        return rooms

    def _lesson_gaps_verdict(self, request: OptimizeScheduleRequest) -> ConflictAnalysis | None:
        """Whole lessons against the gaps they can be taught in, decided by arithmetic.

        After the hours verdict, 73 of the fuzz's impossible weeks still came
        back with a core, and every one of them is impossible in the explaining
        model with every literal released: no line of those cores was needed.
        The cores said there was no room for classes that fit their rooms. The
        hours were there and the gaps were not. A lesson is taught whole, in
        one stretch: five 90-minute lessons on four mornings of two hours take
        four of them; an hour's lunch inside 09:05-10:15 leaves a day of
        08:00-11:00 one 70-minute lesson, whichever side of it; and a teacher
        whose five long lessons each need a morning before the classes' lunch
        has four mornings in a week with one of them locked. None of it needs
        a rule. This names 68 of the 73; the other five need two resources at
        once, or a packing finer than these counts, and stay the model's.

        So the gaps are counted here, before any model, for each teacher, each
        student group and each set of rooms: see _Gaps for the arithmetic and
        why it is a bound no timetable of the bare model beats. The starts are
        _start_domains', so frames, rasts and the school day are in them, and
        each lesson's starts are cut by what the model binds it by bare
        (_lesson_kinds). Nothing that hangs on a literal is counted: not a
        reservation, not a cap, a post, a teacher's own lunch or rest, a
        maximum, a block, a lock's effect on the lunch, or a lunch placed by
        hand. A week this refuses has no timetable with every rule released,
        and a week a rule makes impossible goes to the model, which names it.

        ONE LINE PER TEACHER, GROUP OR SET OF ROOMS THAT IS SHORT, groups first
        because a group has a name to give, and a line that counts exactly the
        timplan rows an earlier line counted is not said twice. A teacher is
        never named, for the reason _teacher_hours_verdict gives: the line
        names the teacher's rows. Where the same count without the lunch lets
        the resource's lessons through, LUNCH_BREAK_IS_THE_DIFFERENCE follows
        the line, as it does for the clique's hours, and says that much and no
        more: a count is not a timetable.

        After _teacher_hours_verdict, which it subsumes, so the weeks that
        verdict names keep their answer.
        """
        resources = self._gap_resources(request, lunch=True)
        found = [
            (key, gaps, members, room_ids, shortfall)
            for key, (gaps, members, room_ids) in resources.items()
            if (shortfall := gaps.shortfall()) is not None
        ]
        if not found:
            return None
        rules = request.rules
        lunch_on = rules is not None and _lunch_window_is_set(rules)
        without_lunch = self._gap_resources(request, lunch=False) if lunch_on else {}
        minutes = self._grid.slot_minutes
        # A group resource is a PUPIL-space key, and a derived one names no
        # group a school has: the line names the class its lessons are filed
        # under instead (_derived_key_classes; empty without pupilGroupId).
        classes = _derived_key_classes(request)
        conflicts: list[ConflictDetail] = []
        said: set[frozenset[UUID]] = set()
        for (what, subject), gaps, members, room_ids, shortfall in found:
            requirement_ids = list(dict.fromkeys(
                requirement.id
                for requirement, kinds in members
                if any(kind in shortfall.kinds for kind in kinds)
            ))
            if frozenset(requirement_ids) in said:
                continue
            said.add(frozenset(requirement_ids))
            if what == "group":
                named = classes.get(subject, subject)  # type: ignore[call-overload]
                resource_ids = [named]
                line = ConflictDetail(
                    category="REQUIREMENT_DEMAND",
                    code="DEMAND_GROUP_LESSONS_EXCEED_GAPS",
                    params={
                        "group": str(named),
                        **self._gap_params(shortfall, len(requirement_ids)),
                    },
                    requirement_ids=requirement_ids,
                    resource_ids=resource_ids,
                )
            elif what == "teacher":
                resource_ids = requirement_ids
                line = ConflictDetail(
                    category="REQUIREMENT_DEMAND",
                    code="DEMAND_TEACHER_LESSONS_EXCEED_GAPS",
                    params={
                        **self._gap_params(shortfall, len(requirement_ids)),
                    },
                    requirement_ids=requirement_ids,
                    resource_ids=resource_ids,
                )
            else:
                # The rows, as the teacher's line names them, and the rooms in
                # roomIds: the gateway names a timplan row and a class, and a
                # room by nothing.
                resource_ids = requirement_ids
                line = ConflictDetail(
                    category="REQUIREMENT_DEMAND",
                    code="DEMAND_ROOM_LESSONS_EXCEED_GAPS",
                    params={
                        "rooms": len(room_ids),
                        **self._gap_params(shortfall, len(requirement_ids)),
                    },
                    requirement_ids=requirement_ids,
                    room_ids=room_ids,
                    resource_ids=resource_ids,
                )
            conflicts.append(line)
            bare = without_lunch.get((what, subject))
            if bare is not None and bare[0].shortfall() is None:
                # The same count without the lunch lets these lessons through,
                # so the meal is part of what the count finds short. Never
                # more than that: the count leaves out the pupils' margins
                # between lessons, groups sharing pupils and the other
                # resources the lessons meet, and the review of this verdict
                # found weeks that stay impossible without their lunch (two
                # lessons of 100 minutes with 40 after each in a morning of
                # 270). The figure is the same lessons' without the lunch, on
                # the days they can fall on without it, which may be more days
                # than with it.
                gaps_without, members_without, _ = bare
                counted_ids = set(requirement_ids)
                days_without = 0
                for requirement, kinds in members_without:
                    if requirement.id in counted_ids:
                        for kind in kinds:
                            if kind.slots >= shortfall.shortest:
                                days_without |= gaps_without.days_of[kind]
                _, free = gaps_without.capacity(shortfall.shortest, days_without)
                conflicts.append(
                    ConflictDetail(
                        category="LUNCH_WINDOW",
                        code="LUNCH_BREAK_IS_THE_DIFFERENCE",
                        params={
                            "lunchMinutes": rules.lunch_minutes,
                            "freeMinutes": free * minutes,
                        },
                        resource_ids=resource_ids,
                    ),
                )
        return ConflictAnalysis(
            summary_code="DEMAND_LESSONS_EXCEED_GAPS",
            summary_params={"resources": len(said)},
            conflicts=conflicts,
        )

    def _gap_params(self, shortfall: _Shortfall, requirements: int) -> dict[str, str | int]:
        """The values every gaps line says, whoever it is about.

        `shortOf` picks the sentence's ending: "nowhere" when the lessons fit
        no gap at all, "lessons" when there are more of them than the gaps
        take, "minutes" when they are few enough and too long. Both figures
        travel either way, so a reader can say both.
        """
        minutes = self._grid.slot_minutes
        return {
            "requirements": requirements,
            "lessons": shortfall.lessons,
            "shortestMinutes": shortfall.shortest * minutes,
            "demandMinutes": shortfall.demand * minutes,
            "days": bin(shortfall.days).count("1"),
            "weekDays": len(self._grid.schedule_days),
            "shortOf": shortfall.short_of,
            "fitLessons": shortfall.fit_lessons,
            "capacityMinutes": shortfall.capacity * minutes,
        }

    def _gap_resources(
        self, request: OptimizeScheduleRequest, *, lunch: bool,
    ) -> dict[tuple[str, object], tuple[_Gaps, list[tuple[AnonymousRequirement, list[_LessonKind]]], list[UUID]]]:
        """(what, whose) -> its _Gaps, its requirements with their kinds, and its rooms.

        Groups, then teachers, then the rooms, each in payload order. `lunch`
        False reads the week as if the school had asked for no lunch: the
        count LUNCH_BREAK_IS_THE_DIFFERENCE reports.

        THE LUNCH IS THE MODEL'S, AND ONLY ITS BARE PART: the meal's own
        interval in the group's NoOverlap, on the starts its variable takes —
        the window on the step, or its hull with a hand-placed start — less
        what the stage's sitting or frame narrows bare. The pin, the locks'
        and the reservations' narrowings hang on literals and are not read.
        _lunch_start_narrowings keeps those apart, which is why it is read.

        THE ROOMS BY WHO MAY USE THEM. Every lesson takes one room for its
        length, of the ones _room_allowed and the room locks allow it, as the
        class pools do (add_room_allocation). So the lessons that may use only
        rooms of one set, each set some lesson has and the whole school's, are
        counted against that many rooms at once.

        A GROUP IS THE PUPIL SPACE'S KEY (pupil_key_of): its lessons are one
        no-overlap in the model (_add_group_no_overlap), which is what lets
        them be counted end to end. The class's lessons are not, any more:
        two derived keys of one class that share no pupil may run at once.
        Its meals are the class's (the CLASS space), so a key's gaps take them
        only when every lesson it holds is filed under that class — every key
        of a payload without pupilGroupId — and a derived key's take none,
        which only lets more through.
        """
        meals: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        lunch_slots = 0
        if lunch:
            narrowings = self._lunch_start_narrowings(
                request, step=_start_step(request, self._grid),
            )
            if narrowings:
                _, _, lunch_slots = self._lunch_window_slots(request.rules)
                for key, parts in narrowings.items():
                    starts = (
                        parts.window
                        if parts.declared is None
                        else parts.window.intersection_with(parts.declared)
                    )
                    meals[key] = _domain_intervals(starts)
        kinds_of = self._lesson_kinds(
            request, meals, lunch_slots, _groups_sharing_students(request.group_conflicts),
        )
        meals_of: dict[UUID, dict[int, list[tuple[int, int]]]] = defaultdict(dict)
        for (group_id, day_index), starts in meals.items():
            meals_of[group_id][day_index] = starts

        by_group: dict[UUID, list[tuple[AnonymousRequirement, list[_LessonKind]]]] = {}
        by_teacher: dict[UUID, list[tuple[AnonymousRequirement, list[_LessonKind]]]] = {}
        for requirement in request.requirements:
            member = (requirement, kinds_of[requirement.id])
            by_group.setdefault(pupil_key_of(requirement), []).append(member)
            if requirement.lesson_teacher_ids is None:
                for teacher_id in dict.fromkeys(_teachers_of(requirement)):
                    by_teacher.setdefault(teacher_id, []).append(member)
                continue
            # A split post (lessonTeacherIds): each teacher is counted the
            # lessons they are on (_teachers_at), never the row's — Bo's one
            # lesson of three is the only one in his gaps.
            own: dict[UUID, list[_LessonKind]] = {}
            for index, kind in enumerate(kinds_of[requirement.id]):
                for teacher_id in dict.fromkeys(_teachers_at(requirement, index)):
                    own.setdefault(teacher_id, []).append(kind)
            for teacher_id, kinds in own.items():
                by_teacher.setdefault(teacher_id, []).append((requirement, kinds))

        def counts(members: list[tuple[AnonymousRequirement, list[_LessonKind]]]) -> Counter[_LessonKind]:
            return Counter(kind for _, kinds in members for kind in kinds)

        resources: dict[
            tuple[str, object],
            tuple[_Gaps, list[tuple[AnonymousRequirement, list[_LessonKind]]], list[UUID]],
        ] = {}
        for group_id, members in by_group.items():
            # The class's meals on a key only the class's own lessons hold.
            meals_here = (
                meals_of.get(group_id, {})
                if all(requirement.student_group_id == group_id for requirement, _ in members)
                else {}
            )
            resources[("group", group_id)] = (
                _Gaps(counts(members), meals_here, lunch_slots), members, [],
            )
        for teacher_id, members in by_teacher.items():
            resources[("teacher", teacher_id)] = (_Gaps(counts(members), {}, 0), members, [])

        rooms = request.rooms
        if rooms:
            allowed, profile_key = self._lock_aware(
                resolve_room_locks(request.requirements, request.room_preferences or [], rooms),
            )
            everywhere = frozenset(range(len(rooms)))
            # Once per profile, which is exactly what the predicate reads (see
            # _lock_aware): 960 requirements and 92 rooms are a dozen profiles.
            # A requirement no room allows is refused by _validate_request; the
            # pools open every class to it, and so does this.
            by_profile: dict[tuple, frozenset[int]] = {}
            eligible: dict[UUID, frozenset[int]] = {}
            for requirement in request.requirements:
                profile = profile_key(requirement)
                if profile not in by_profile:
                    by_profile[profile] = frozenset(
                        index for index, room in enumerate(rooms) if allowed(room, requirement)
                    ) or everywhere
                eligible[requirement.id] = by_profile[profile]
            for room_set in sorted(
                {everywhere, *eligible.values()}, key=lambda rs: (len(rs), sorted(rs)),
            ):
                members = [
                    (requirement, kinds_of[requirement.id])
                    for requirement in request.requirements
                    if eligible[requirement.id] <= room_set
                ]
                resources[("rooms", room_set)] = (
                    _Gaps(counts(members), {}, 0, machines=len(room_set)),
                    members,
                    [rooms[index].id for index in sorted(room_set)],
                )
        return resources

    def _lesson_kinds(
        self,
        request: OptimizeScheduleRequest,
        meals: dict[tuple[UUID, int], list[tuple[int, int]]],
        lunch_slots: int,
        sharing: dict[UUID, list[UUID]],
    ) -> dict[UUID, list[_LessonKind]]:
        """Requirement id -> a kind per lesson, on the starts the bare model leaves it.

        _start_domains' starts, cut twice, and both cuts are the model's own
        bare rows read for one lesson at a time:

        - A LOCKED LESSON the requirement shares a teacher or pupils with is
          avoided by a disjunction posted bare (_add_fixed_lesson_constraints),
          so no start may put the lesson across the locked window. The window
          is the outward one; the corridor and the pupils' margins widen it in
          the model and are not counted, which only leaves more starts.
        - A LUNCH of the requirement's group, or of a group sharing its pupils,
          is an interval in a NoOverlap with the lesson, so a start that leaves
          no start of that day's meal clear of the lesson is no start at all.
          The meal's starts span [first, last], and a lesson [s, s + d) blocks
          every one of them exactly when s lies in [last - d + 1, first +
          lunch - 1]. A meal whose starts have a hole in the middle is read by
          its ends, which again only leaves more.

        EACH CUT IN THE SPACE ITS ROW IS POSTED IN, and they are two. The
        locks' disjunctions are the PUPIL space's (_add_fixed_lesson_constraints:
        the lock's pupil_keys_of against the lesson's pupil_key_of and the
        groups sharing it), so a locked 7A svenska sat by "7A without SvA7"
        cuts no start of SvA7's. The meals' no-overlaps are the CLASS space's
        (_add_rules_constraints: a class's lunch beside the lessons filed
        under it and under the groups sharing its pupils), so 7A's svenska is
        cut by 7A's meal whoever sits it. One `pupils` tuple for both, as this
        read before, would cut SvA by the locked svenska — a start the model
        allows, and a gaps refusal of a week that has a timetable.

        Requirements whose lessons of one length end on the same starts share
        a kind; see _LessonKind.
        """
        grid = self._grid
        lattice = _start_lattice(_start_step(request, grid), grid.horizon)
        teacher_windows: dict[UUID, list[tuple[int, int]]] = defaultdict(list)
        for (teacher_id, _), windows in self._teacher_busy_from_locks(request.fixed_lessons).items():
            teacher_windows[teacher_id].extend(windows)
        # The locks by the pupils they hold: the PUPIL space.
        group_windows: dict[UUID, list[tuple[int, int]]] = defaultdict(list)
        for fixed in request.fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                continue
            for group_id in set(pupil_keys_of(fixed)):
                group_windows[group_id].append(window)
        meal_spans: dict[UUID, list[tuple[int, int]]] = defaultdict(list)
        for (group_id, _), starts in meals.items():
            if starts:
                meal_spans[group_id].append((starts[0][0], starts[-1][1]))

        shared: dict[tuple[int, tuple[int, ...]], _LessonKind] = {}
        kinds_of: dict[UUID, list[_LessonKind]] = {}
        # _start_domains reads a requirement's years, its margins and its
        # lengths, and the week's frames, rasts and step; requirements alike in
        # the first three share one computation. A field it starts to read
        # belongs in this key.
        domains_of: dict[tuple, dict[int, cp_model.Domain]] = {}
        for requirement in request.requirements:
            shape = (
                span_of(requirement),
                requirement.minutes_before,
                requirement.minutes_after,
                frozenset(requirement.lesson_minutes()),
            )
            if shape not in domains_of:
                domains_of[shape] = self._start_domains(
                    requirement, request.frame_times, request.rasts, lattice,
                )
            domains = domains_of[shape]
            # Whose locks cut the lesson (the PUPIL space) and whose meals do
            # (the CLASS space): see the docstring. The same tuple twice for
            # every requirement without a pupilGroupId.
            sat_by = pupil_key_of(requirement)
            pupils = (sat_by, *sharing.get(sat_by, ()))
            filed = requirement.student_group_id
            eaters = (filed, *sharing.get(filed, ()))
            # A kind is per length, not per lesson, so a teacher's locks cut
            # it only when they are on every lesson (_teachers_on_every_lesson):
            # Bo's locked Monday is no Monday shut to Anna's lessons of a split
            # post. For a post one person leads that is _teachers_of.
            windows = {
                window
                for teacher_id in _teachers_on_every_lesson(requirement)
                for window in teacher_windows.get(teacher_id, ())
            }
            windows.update(window for group_id in pupils for window in group_windows.get(group_id, ()))
            spans = {span for group_id in eaters for span in meal_spans.get(group_id, ())}
            by_length: dict[int, _LessonKind] = {}
            for duration in sorted({grid.minutes_to_slots(m) for m in requirement.lesson_minutes()}):
                cuts = [[start - duration + 1, end - 1] for start, end in windows]
                cuts += [
                    [last - duration + 1, first + lunch_slots - 1]
                    for first, last in spans
                    if last - duration + 1 <= first + lunch_slots - 1
                ]
                starts = domains[duration]
                if cuts:
                    starts = starts.intersection_with(cp_model.Domain.FromIntervals(cuts).complement())
                # Flat, [lo, hi, lo, hi, ...]: on a coarse step a domain is
                # hundreds of single starts, and pairing them up was most of
                # this method's time at 2,000 students.
                flat = starts.FlattenedIntervals()
                key = (duration, tuple(flat))
                if key not in shared:
                    shared[key] = _LessonKind(
                        slots=duration,
                        lows=flat[0::2],
                        highs=flat[1::2],
                        reach={
                            day_index: _merge_ranges(reach)
                            for day_index, reach in _day_reach(
                                starts, duration, grid.slots_per_day,
                            ).items()
                        },
                    )
                by_length[duration] = shared[key]
            kinds_of[requirement.id] = [
                by_length[grid.minutes_to_slots(m)] for m in requirement.lesson_minutes()
            ]
        return kinds_of

    def _lunch_pins(
        self,
        placements: list[LunchPlacement],
        lunch_group_ids: list[UUID] | set[UUID],
    ) -> dict[tuple[UUID, int], int]:
        """(class, day index) -> the day-local slot the school put the meal at.

        One reader for the builder, the lunch stage, the narrowings and the
        dining-hall verdict, so the four can never disagree about which meals
        are pinned. Placements that cannot stand — off the grid, on a day the
        engine does not teach — are left out rather than raised: every one of
        them is refused by name in _verify_lunch_placements before any of these
        readers runs, and a reader that also refused would be a second rule.

        Only classes the payload feeds. A placement for a group with no lunch
        variable has nothing to pin; the gateway sends placements only for the
        classes it also sends in `groups`.
        """
        eating = set(lunch_group_ids)
        pins: dict[tuple[UUID, int], int] = {}
        for placement in placements:
            if placement.student_group_id not in eating:
                continue
            if placement.day_of_week not in self._grid.schedule_days:
                continue
            try:
                slot = self._grid.parse_hhmmss(placement.start_time)
            except ValueError:
                continue
            day_index = self._grid.day_index(placement.day_of_week)
            pins[(placement.student_group_id, day_index)] = slot
        return pins

    @staticmethod
    def _lunch_start_bounds(
        pin: int | None,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> tuple[int, int]:
        """The lunch variable's inclusive bounds, widened to hold a pin.

        THE WHOLE FEATURE HANGS ON THIS. The variable used to be built on the
        school window unconditionally, and a pin outside it is not an
        infeasible model but an invalid one — MODEL_INVALID, a crash. That is
        exactly the school this exists for: locked lessons fill 10:30-13:00, so
        the meal they place goes at 13:00, outside the window. The hull of the
        window and the pin holds it; the pin itself is then a constraint under
        a literal, so relaxing it widens the meal's choices instead of leaving
        a variable with nowhere to be.
        """
        low, high = day_offset + window_start, day_offset + window_end - lunch_slots
        if pin is not None:
            low, high = min(low, day_offset + pin), max(high, day_offset + pin)
        return low, high

    def _verify_lunch_placements(
        self,
        request: OptimizeScheduleRequest,
        lunch_group_ids: list[UUID],
        exempt_days: set[tuple[UUID, int]],
        lunch_slots: int,
    ) -> dict[tuple[UUID, int], int]:
        """Refuse a hand-placed meal that cannot stand; return the ones that can.

        A PIN OUTRANKS THE WINDOW AND THE SITTING, and nothing else. The window
        and the stage's sitting are rules about when a STAGE eats, and a school
        placing one class's meal by hand is overriding them on purpose. A
        locked lesson and a reservation are facts about the CLASS's own time,
        and a meal placed on top of one is two of the school's sentences that
        cannot both be true — refused here, by name, rather than left to the
        model.

        And it has to be refused here, not merely because a name is better
        than a core. The locked lessons reach the meal only as a narrowing of
        its domain — they are never intervals beside it — and a pinned day
        drops that narrowing. A pin on a lock that got past this check would
        not be refused at all: the meal would be served in a classroom.

        Tested on the PIN'S OWN SLOT, not on the starts the window leaves:
        blocked_starts is computed across the lunch window, and a meal placed
        outside it — the whole point — would be checked against nothing. The
        same two helpers the builder uses, asked about one start, so the check
        and the model can never round a locked lesson differently.
        """
        eating = set(lunch_group_ids)
        sharing = _groups_sharing_students(request.group_conflicts)
        slots_per_day = self._grid.slots_per_day
        pins: dict[tuple[UUID, int], int] = {}
        for placement in request.lunch_placements:
            group_id = placement.student_group_id
            if group_id not in eating:
                continue
            try:
                if placement.day_of_week not in self._grid.schedule_days:
                    msg = f"{placement.day_of_week} is not a teaching day"
                    raise ValueError(msg)
                slot = self._grid.parse_hhmmss(placement.start_time)
                if slot + lunch_slots > slots_per_day:
                    msg = "the meal runs past the end of the day"
                    raise ValueError(msg)
            except ValueError as exc:
                raise InvalidScheduleInputError.of("LUNCH_PLACEMENT_OFF_GRID", {
                    "group": str(group_id),
                    "day": placement.day_of_week,
                    "start": placement.start_time[:5],
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            day_index = self._grid.day_index(placement.day_of_week)
            key = (group_id, day_index)
            day_offset = day_index * slots_per_day
            what: str | None = None
            if key in exempt_days:
                # The school has said the class is not here that day. A meal
                # placed on it would have no variable to pin and would vanish
                # without a word.
                what = "day"
            else:
                locked = self._lunch_starts_blocked_by_fixed_lessons(
                    request.fixed_lessons, {group_id}, sharing, slot, slot, lunch_slots,
                ).get(key)
                closed, covered = self._lunch_starts_blocked_by_constraints(
                    request.constraints, {group_id}, slot, slot, slot + lunch_slots, lunch_slots,
                )
                if locked and self._admissible_lunch_starts(
                    day_offset, slot, slot + lunch_slots, lunch_slots, locked,
                ).is_empty():
                    what = "locked"
                elif key in covered or (
                    closed.get(key)
                    and self._admissible_lunch_starts(
                        day_offset, slot, slot + lunch_slots, lunch_slots, closed[key],
                    ).is_empty()
                ):
                    what = "closed"
            if what is not None:
                raise InvalidScheduleInputError.of("LUNCH_PLACEMENT_COLLIDES", {
                    "group": str(group_id),
                    "day": placement.day_of_week,
                    "start": placement.start_time[:5],
                    "what": what,
                })
            pins[key] = slot
        return pins

    def _lunch_start_narrowings(
        self, request: OptimizeScheduleRequest, *, step: int,
    ) -> dict[tuple[UUID, int], _LunchStarts] | None:
        """Where each class's lunch may start on each day, as the model says it.

        The model states the fact as four constraints on one variable: the
        window as its bounds, the stage's sitting or frame as a domain, and
        the locked lessons and the reservations as two more, each under the
        assumption literal that names it. Read here through the same helpers
        and in the same order, and KEPT APART, so a reader that needs to name
        one of them — the lunch stage — can put the same literal on the same
        sentence. None when the school asked for no lunch, the same test the
        builder makes.

        A payload that names nobody gets the builder's reading too: a meal for
        every group with lessons, on no stage's sitting (see _lunch_group_ids).
        The lunch stage does not run on such a week — it seats a hall the
        gateway has said nothing about — but the gaps verdict counts those
        meals all the same, because the model builds them.

        Empty compositions are allowed to come out: _validate_request refuses
        a sitting or a lock that alone leaves no start, and only their
        intersection can still be empty. The caller decides what to make of
        that.

        The window is on `step`, the variable's own domain in the builder, so
        every narrowing composed with it is too. Nothing is lost by that: the
        window's ends and a pin are multiples of the step (see _start_step).
        """
        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules):
            return None
        lattice = _start_lattice(step, self._grid.horizon)
        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
        lunch_group_ids = _lunch_group_ids(
            request.groups, _group_ids_with_lessons(request.requirements),
        )
        blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
            request.fixed_lessons,
            set(lunch_group_ids),
            _groups_sharing_students(request.group_conflicts),
            window_start,
            window_end - lunch_slots,
            lunch_slots,
        )
        closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }
        slots_per_day = self._grid.slots_per_day
        pins = self._lunch_pins(request.lunch_placements, lunch_group_ids)
        starts: dict[tuple[UUID, int], _LunchStarts] = {}
        for group_id in lunch_group_ids:
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                if (group_id, day_index) in exempt_days:
                    continue
                day_offset = day_index * slots_per_day
                pin = pins.get((group_id, day_index))
                if pin is not None:
                    low, high = self._lunch_start_bounds(
                        pin, day_offset, window_start, window_end, lunch_slots,
                    )
                    starts[(group_id, day_index)] = _LunchStarts(
                        window=_on_lattice(cp_model.Domain(low, high), lattice),
                        declared=None,
                        locked=None,
                        closed=None,
                        pinned=cp_model.Domain(day_offset + pin, day_offset + pin),
                    )
                    continue
                declared = self._declared_lunch_domain(
                    request.lunch_servings,
                    request.frame_times,
                    span_by_group.get(group_id),
                    day_of_week,
                    day_offset,
                    window_start,
                    window_end,
                    lunch_slots,
                )
                left: list[cp_model.Domain | None] = []
                for forbidden in (
                    blocked_starts.get((group_id, day_index)),
                    closed_starts.get((group_id, day_index)),
                ):
                    left.append(
                        self._admissible_lunch_starts(
                            day_offset, window_start, window_end, lunch_slots, forbidden,
                        )
                        if forbidden
                        else None,
                    )
                starts[(group_id, day_index)] = _LunchStarts(
                    window=_on_lattice(
                        cp_model.Domain(
                            day_offset + window_start, day_offset + window_end - lunch_slots,
                        ),
                        lattice,
                    ),
                    declared=declared,
                    locked=left[0],
                    closed=left[1],
                )
        return starts

    def _lunch_start_domains(
        self, request: OptimizeScheduleRequest,
    ) -> dict[tuple[UUID, int], cp_model.Domain] | None:
        """The four sentences of _lunch_start_narrowings composed into one domain."""
        narrowings = self._lunch_start_narrowings(
            request, step=_start_step(request, self._grid),
        )
        if narrowings is None:
            return None
        return {key: parts.composed() for key, parts in narrowings.items()}

    def _lunch_stage_one(
        self, request: OptimizeScheduleRequest,
    ) -> tuple[ConflictAnalysis | None, dict[tuple[UUID, int], int]]:
        """The lunches alone, before the lessons: a verdict or a warm start.

        The first reproduction of the timeout report. Years 4-6 are framed
        08:00-13:30 — exactly five hour-long lessons and one thirty-minute
        meal — so a five-lesson day is packed and its lunch can only start at
        11:00 or 12:00; twenty-four lessons a week at most five a day force
        four packed days per class; two disjoint sittings of floor(115/24) =
        4 classes seat eight packed class-days a day, forty a week, and eleven
        classes need forty-four. A counting argument over all fifty-five
        class-days at once, which CP-SAT's clause learning never assembled
        from the full model's per-slot encoding in 60 s: UNKNOWN, reported as
        TIMEOUT, on a week that has no timetable.

        A model of ONLY the lunch starts finds it in under a second: one
        boolean per start in the window, one linear seat row per slot — equal
        coefficients that presolve divides down to "at most four classes
        here" — and a per-day lesson count bounded by what the clique's free
        time holds around the chosen start. Measured on this week: the rows
        prove it in 0.2 s; the full model's cumulative in their place takes
        4 s, and beside them adds nothing, so it is not built here. The panel
        that found the encoding saw the cumulative with element-bounded caps
        stay UNKNOWN at 15 s.

        EVERY CONSTRAINT HERE RELAXES ONE THE FULL MODEL ENFORCES, which is
        what makes INFEASIBLE here INFEASIBLE for the week: the starts are the
        model's own four sentences (_lunch_start_narrowings); the seat rows
        say per slot exactly what the model's cumulative says over
        fixed-length intervals; the day count is the hours verdict's
        arithmetic, with the school's maximum lessons per day on top. Rasts,
        rooms, teachers and the lessons' actual placement are simply absent,
        and absence only widens.

        NAMED BY DELETION, not by a rule of thumb and not by CP-SAT's
        assumption cores. The first version named "the classes that cannot
        avoid a packed day", which is one way a week fails and not the way a
        real one did: twenty-four classes with no lessons at all, sent to a
        hall of 115 seats, cannot be seated in five thirty-minute waves — no
        packed day anywhere — and the school read "0 class(es)". Assumption
        literals were tried next and could not reproduce the proof in ten
        seconds: with assumptions CP-SAT runs one thread and keeps presolve
        from the very rewriting that IS the proof. So every sentence the
        stage builds — a class at school, its lessons, the hall, a sitting or
        frame, a lock, a reservation — is a literal the fast solve can pin
        either way, and _name_lunch_causes drops sentences while the week
        stays impossible. What is left is a sufficient set, from the first
        solve to the last, so running out of time mid-way still names
        truthfully; the summary says the set is sufficient, not smallest.

        On a feasible week the stage costs at most its cap and repays part of
        it: its starts are hinted into the existence search (measured 1.3x on
        a plain school with seats, 1.04x without). On UNKNOWN it costs the cap
        and decides nothing, and the full solve proceeds unhinted. Returns
        (verdict, hints): a verdict when the week is refused, else the chosen
        starts, empty when the stage could not decide — or when it proved the
        week impossible on lessons no lunch is among (_name_lunch_causes says
        why that is the full model's to explain).

        ON THE FULL MODEL'S STEP, and still a relaxation of it: every start the
        stage may choose is one the model's own variable may take. A refusal
        here is a refusal of the model on the step, which _start_step shows is
        a refusal of the week.
        """
        # A payload that names nobody: the stage decides nothing for that week
        # and the full model carries its meals alone — slower to refuse a week
        # with no room for them, and no less bound by them.
        if not request.groups:
            return None, {}
        narrowings = self._lunch_start_narrowings(
            request, step=_start_step(request, self._grid),
        )
        if narrowings is None:
            return None, {}
        if any(parts.composed().is_empty() for parts in narrowings.values()):
            # A sitting and a lock that each leave a start and together leave
            # none. _validate_request refuses that by name before any solve;
            # kept because CP-SAT calls a model with an empty domain invalid,
            # and a direct caller must not be able to hand it one.
            return None, {}
        stage = self._build_lunch_stage(request, narrowings)
        solver = self._lunch_stage_solver(self.LUNCH_STAGE_CAP_SECONDS)
        started = time.monotonic()
        code = _solve_guarded(
            solver, stage.pinned(set()), what="the lunch stage", request_id=request.request_id,
        )
        logger.info(
            "lunch stage: %s in %.2fs over %d lunch starts",
            solver.StatusName(code), time.monotonic() - started, len(stage.starts),
        )
        if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None, {key: solver.Value(start) for key, start in stage.starts.items()}
        if code != cp_model.INFEASIBLE:
            return None, {}
        # IMPOSSIBLE WITH NO MEAL AT ALL is no lunch's refusal. The stage
        # counts each clique's lessons around its lunch, under the daily
        # maximum, and a clique whose lessons the days cannot hold even with
        # every lunch gone was named "no placement of the lunch breaks", with
        # advice — widen the frame or the lunch window — about the wrong rule.
        # Among 37,923 gen.py weeks that was every one of the 170 such
        # refusals; one class at school and eating, seven lessons on two days
        # at most two a day, is OPTIMAL as soon as the maximum goes.
        #
        # NAMED HERE, from the same count, and never left to the full model.
        # Standing aside was tried, and is safe only where the shortage is
        # the trivial one — more lessons than the maximum times the open
        # days, which presolve refutes at once. Where the frames take part —
        # one class of 30 hour-long lessons, Monday and Tuesday framed to
        # four, at most seven a day — the full model cannot assemble the
        # pigeonhole from its per-slot encoding: TIMEOUT at 80 s, and at 620 s
        # on a ten-minute budget, where this count answers at once.
        #
        # So the clique the maximum holds back gets the maximum's own line,
        # GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT, at `measured` 3: what this count
        # shows and nothing more (_cliques_short_at_the_maximum). The rest of
        # the refusal is named as before over what is left
        # (_name_lunch_causes). A clique short even without the maximum is not
        # the maximum's to name; with none held back the stage names exactly
        # as it did.
        held_back, short_anyway = self._cliques_short_at_the_maximum(request)
        if not held_back:
            return self._name_lunch_causes(request, stage), {}
        logger.info(
            "lunch stage: the daily maximum holds back %d class(es)%s",
            len(held_back),
            f" and {len(short_anyway)} more fit not even without it" if short_anyway else "",
        )
        return self._name_lunch_causes(
            request, stage, held_back=held_back, short_anyway=short_anyway,
        ), {}

    def _cliques_short_at_the_maximum(
        self, request: OptimizeScheduleRequest,
    ) -> tuple[list[UUID], list[UUID]]:
        """Classes whose lessons sentence fails with no meal: held back, or short anyway.

        _build_lunch_stage bounds each day's count of a clique's lessons by
        held(): its free time with the lunch cut out, rounded down to whole
        measures and capped at the daily maximum (_Clique.day_cap). With no
        lunch anywhere the cut goes, and the sentence holds exactly when the
        days' counts can sum to the clique's demand.

        Returns (held back, short anyway), each a list of the cliques' classes.
        HELD BACK: short with the cap and not without it — the maximum, and
        nothing the count reads but the maximum, is the difference. SHORT
        ANYWAY: short without the cap too, so the frames and the locks alone
        cannot hold the lessons; the hours verdict refuses such a clique before
        the stage runs, unless a day of it has no room for a lunch at all,
        which it leaves to be refused by name elsewhere.

        WHAT THE COUNT READS, which is all a line built on it may say: the
        union of the windows the frame times give the clique's requirements,
        less the locked lessons that block every member (_cliques), each
        class's lessons at most min(weekly, maximum) a day of its longest
        length. Not the reservations, which _cliques does not subtract, nor
        margins, rooms, teachers or any other rule: leaving them out lets
        more through, so short here is short with them too.
        """
        held_back: list[UUID] = []
        short_anyway: list[UUID] = []
        for group, clique in self._cliques(request):
            measure = clique.measure
            capped = uncapped = 0
            for free in clique.free_by_day.values():
                holds = _holds(free, measure)
                capped += min(holds, clique.day_cap) // measure * measure
                uncapped += holds
            if capped >= clique.demand:
                continue
            (held_back if uncapped >= clique.demand else short_anyway).append(group.id)
        return held_back, short_anyway

    def _lunch_stage_solver(self, seconds: float) -> cp_model.CpSolver:
        """A solver for the stage whose search does not depend on the machine.

        THE PROOF IS THE LP RELAXATION, and asking for it by name is the whole
        point of this method. Left to itself CP-SAT sizes its portfolio from
        the host's core count, and the subsolver that carries the full
        linearization — max_lp_sym, which finishes this model while it is still
        loading — is only in the portfolio on a machine with cores to spare.
        Measured on Reproduction G, ortools 9.15: 0.17 s at eight workers,
        0.20 s at four, and 7.6-18.8 s at two or one, against a 10 s cap. So a
        two-core host did not refuse the week at all — it spent the cap, said
        UNKNOWN, and handed the school the 60 s TIMEOUT this stage exists to
        prevent. That is what CI's two-core runner had been reporting since the
        stage was written; a small VPS with SOLVER_CPUS=2 would read the same.

        One worker, not eight: asked for the linearization directly the proof
        takes 0.09 s single-threaded, which is faster than any portfolio found
        it, and a single worker makes CP-SAT deterministic — the same week now
        yields the same named causes on every machine, which matters more here
        than anywhere else in the solver, because these names are read by a
        school and quoted back to us in support.
        """
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        solver.parameters.num_workers = 1
        solver.parameters.linearization_level = 2
        return solver

    def _build_lunch_stage(
        self,
        request: OptimizeScheduleRequest,
        narrowings: dict[tuple[UUID, int], _LunchStarts],
    ) -> _LunchStage:
        """The stage model with every sentence behind a literal of its own.

        Literals are left FREE here; _LunchStage.pinned fixes each one true
        or false per solve. Pinned true they are unit clauses presolve folds
        away, so the first solve is the plain model. Pinned false they drop
        the sentence: a class not at school chooses no start and takes no
        seat, the hall has no limit, a narrowing does not apply, a clique's
        count is not made.
        """
        rules = request.rules
        _, _, lunch_slots = self._lunch_window_slots(rules)
        headcounts = _lunch_headcounts(request.groups)
        seats = rules.dining_seats
        slots_per_day = self._grid.slots_per_day
        hall_open = seats is not None and any(
            headcounts.get(group_id, 0) > 0 for group_id, _ in narrowings
        )

        model = cp_model.CpModel()
        starts: dict[tuple[UUID, int], cp_model.IntVar] = {}
        choices: dict[tuple[UUID, int], dict[int, cp_model.IntVar]] = {}
        load: dict[int, list[tuple[int, cp_model.IntVar]]] = defaultdict(list)
        literals: dict[tuple[str, UUID | None], cp_model.IntVar] = {}

        def sentence(cause: str, group_id: UUID | None) -> cp_model.IntVar:
            key = (cause, group_id)
            literal = literals.get(key)
            if literal is None:
                literal = literals[key] = model.NewBoolVar(f"{cause}_{group_id}")
            return literal

        for (group_id, day_index), parts in narrowings.items():
            present = sentence("eats", group_id)
            start = model.NewIntVarFromDomain(parts.window, f"lunchstart_{group_id}_{day_index}")
            options = {
                slot: model.NewBoolVar(f"lunchat_{group_id}_{day_index}_{slot}")
                for lo, hi in _domain_intervals(parts.window)
                for slot in range(lo, hi + 1)
            }
            # Exactly one start while the class is at school. Nothing at all
            # otherwise — not even "at most one": the start literals are free
            # variables, all-zero is always open to them, and a solve looking
            # for a solution never fills a hall it does not have to, so a
            # constraint saying so could not change one verdict. (Tried; it
            # did not.)
            model.Add(sum(options.values()) == 1).OnlyEnforceIf(present)
            model.Add(
                start == sum(slot * literal for slot, literal in options.items()),
            ).OnlyEnforceIf(present)
            for cause in ("declared", "locked", "closed", "pinned"):
                narrowing = getattr(parts, cause)
                if narrowing is None:
                    continue
                outside = [
                    literal for slot, literal in options.items() if not narrowing.contains(slot)
                ]
                if outside:
                    model.Add(sum(outside) == 0).OnlyEnforceIf(sentence(cause, group_id))
            starts[(group_id, day_index)] = start
            choices[(group_id, day_index)] = options
            headcount = headcounts.get(group_id, 0)
            if hall_open and headcount > 0:
                for slot, literal in options.items():
                    for occupied in range(slot, slot + lunch_slots):
                        load[occupied].append((headcount, literal))
        if load:
            hall = sentence("hall", None)
            for terms in load.values():
                model.Add(
                    sum(headcount * literal for headcount, literal in terms) <= seats,
                ).OnlyEnforceIf(hall)

        window_texts: dict[UUID, str | None] = {}
        for group, clique in self._cliques(request):
            window_texts[group.id] = clique.window_text
            measure = clique.measure
            # The day under the school's daily maximum, as _cliques bounds it;
            # _cliques_short_at_the_maximum reads the same field.
            day_cap = clique.day_cap

            def held(ranges: list[tuple[int, int]]) -> int:
                return min(_holds(ranges, measure), day_cap) // measure

            lessons = sentence("lessons", group.id)
            day_counts = []
            for day_index, free in clique.free_by_day.items():
                base = day_index * slots_per_day
                options = choices.get((group.id, day_index))
                if options is None:
                    count = model.NewIntVar(0, held(free), f"lessons_{group.id}_{day_index}")
                else:
                    caps = {
                        slot: held(_subtract_range(free, (slot - base, slot - base + lunch_slots)))
                        for slot in options
                    }
                    count = model.NewIntVar(0, max(caps.values()), f"lessons_{group.id}_{day_index}")
                    # A class the naming leaves out chooses no start, and this
                    # bound would then read that as a day with no room at all
                    # — which is why the naming drops a class's sentences
                    # together, never its presence alone.
                    model.Add(
                        count <= sum(caps[slot] * literal for slot, literal in options.items()),
                    ).OnlyEnforceIf(lessons)
                day_counts.append(count)
            model.Add(measure * sum(day_counts) == clique.demand).OnlyEnforceIf(lessons)

        return _LunchStage(
            model=model, starts=starts, literals=literals, headcounts=headcounts,
            window_texts=window_texts,
        )

    def _name_lunch_causes(
        self,
        request: OptimizeScheduleRequest,
        stage: _LunchStage,
        *,
        held_back: list[UUID] | None = None,
        short_anyway: list[UUID] | None = None,
    ) -> ConflictAnalysis | None:
        """Which sentences the refusal needs, by dropping the ones it does not.

        Every solve here re-proves the week impossible with fewer sentences
        pinned, so the set still pinned is sufficient at every step — which
        is what lets the deadline cut the search anywhere and the answer stay
        true. Coarse before fine: the classes that eat on no day, the hall
        alone, then each kind of narrowing for the whole school, then the
        lessons for the whole school, then the classes in chunks that split
        only when a chunk turns out to matter. A solve that cannot decide in
        the time left counts as "needed", the conservative reading.

        None when the refusal is not the lunch's: see the first question.

        `held_back`: classes whose cliques the daily maximum holds back with no
        meal at all (_cliques_short_at_the_maximum). Their line leads, and the
        rest is named with their lessons sentences dropped; `short_anyway`,
        the cliques short even without the maximum, are dropped whole beside
        them, and no line says anything of them.
        """
        rules = request.rules
        seats = rules.dining_seats
        deadline = time.monotonic() + self.LUNCH_STAGE_CAP_SECONDS
        relaxed: set[tuple[str, UUID | None]] = set()

        def still_impossible(extra: set[tuple[str, UUID | None]]) -> bool | None:
            """True when the week stays impossible with `extra` dropped too;
            None when the clock ran out before CP-SAT could say."""
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            solver = self._lunch_stage_solver(remaining)
            code = _solve_guarded(
                solver, stage.pinned(relaxed | extra),
                what="the lunch naming", request_id=request.request_id,
            )
            if code == cp_model.INFEASIBLE:
                return True
            if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                return False
            return None

        def drop_if_unneeded(candidates: set[tuple[str, UUID | None]]) -> None:
            if candidates and still_impossible(candidates):
                relaxed.update(candidates)

        # THE MAXIMUM FIRST, when it holds a clique back. The count proves
        # that clique impossible on its own, so its line is a sufficient set
        # by itself: whatever the solves below say, or fail to say in the
        # time left, the refusal stands on it. Their lessons sentences go —
        # the line already says what they would — and their meals stay, so a
        # hall that cannot seat them still says so. A clique short even
        # without the maximum is dropped whole: the line does not name it,
        # and no line below may say anything of a class the count found
        # impossible by its hours, which is not what the stage asked.
        #
        # The rest of the week is then solved again, as #204 does for the
        # classes that eat on no day. Still impossible: its causes are named
        # as ever and follow the line, true both. Possible, or undecided: the
        # line alone.
        maximum_line: ConflictDetail | None = None
        if held_back:
            maximum_line = ConflictDetail(
                # "För många lektioner", as the model's own line files it.
                category="REQUIREMENT_DEMAND",
                code="GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT",
                params={"maxPerDay": rules.max_lessons_per_day_per_group, "measured": 3},
                resource_ids=held_back,
            )
            dropped = set(short_anyway or ())
            relaxed.update(("lessons", group_id) for group_id in held_back)
            relaxed.update(key for key in stage.literals if key[1] in dropped)
            if still_impossible(set()) is not True:
                return ConflictAnalysis(
                    summary_code="CONFLICT_CORE_SUMMARY",
                    summary_params={},
                    conflicts=[maximum_line],
                )

        # A CLASS THAT EATS ON NO DAY still has a "lessons" sentence. _cliques
        # makes one for every class whose clique has lessons — its own, or a
        # teaching group's that shares its pupils, so a class with no lessons
        # of its own has one too — and a reservation over the
        # whole lunch window on every school day exempts the class from lunch
        # (_lunch_starts_blocked_by_constraints), so it has no start and no
        # "eats". Its sentence then reads no lunch start at all: it is the
        # hours count with the daily maximum on top, a part of the model on
        # its own. The pruning below walks the classes that eat and never
        # reaches it, so whenever the lessons were needed it stayed pinned,
        # was named, and the sort by `classes` raised ValueError — a 500 where
        # the school should have read a verdict. A class away at lunch all
        # week, seven lessons and at most two a day on two days: the stage
        # proved that, and every lunch sentence about it would be false.
        #
        # So it is asked first, before the hall, whose answer it would
        # otherwise decide: the week impossible without those sentences, and
        # they go and the naming goes on over the classes that eat. Possible
        # without them, and the refusal rests on lessons no lunch is among:
        # the stage gives no verdict. The full model keeps every rule the
        # stage relaxes, so it is just as impossible, and its own explanation
        # names the cause (GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT in that week, in
        # 0.03 s); at worst it runs out of time, a TIMEOUT where there was a
        # 500. Undecided in the time left, the same: sufficiency drops nothing
        # unproved, and what stays pinned would be named.
        #
        # That class's sentence is a count with no meal in it, which
        # _cliques_short_at_the_maximum makes before the naming. Where the
        # maximum holds it back it is named above and dropped; where it is
        # short anyway and nothing is held back, the naming is main's, and
        # this question leaves the week to the full model as it always has.
        eating = {group_id for (cause, group_id) in stage.literals if cause == "eats"}
        lunch_free = {
            key for key in stage.literals
            if key[1] is not None and key[1] not in eating and key not in relaxed
        }
        if lunch_free:
            needed = still_impossible(lunch_free)
            if needed is not True and maximum_line is not None:
                # Undecided, with the maximum's line standing on its own.
                return ConflictAnalysis(
                    summary_code="CONFLICT_CORE_SUMMARY",
                    summary_params={},
                    conflicts=[maximum_line],
                )
            if needed is not True:
                logger.info(
                    "lunch stage: %s %d class(es) that eat on no day; "
                    "the full model decides the week",
                    "the refusal rests on" if needed is False
                    else "out of time before deciding whether the refusal needs",
                    len(lunch_free),
                )
                return None
            relaxed.update(lunch_free)

        by_cause: dict[str, set[tuple[str, UUID | None]]] = defaultdict(set)
        for key in stage.literals:
            by_cause[key[0]].add(key)

        # The hall is the difference when the week is refused with its seats
        # and not without them — the one question the summary leads with.
        hall = by_cause.get("hall", set())
        seats_matter: bool | None = False
        if hall:
            without = still_impossible(hall)
            # None: the clock ran out before the question was answered. The
            # hall then stays pinned — sufficiency needs nothing dropped
            # unproved — and the summary says neither "the hall" nor "not".
            seats_matter = None if without is None else not without
            if seats_matter is False:
                relaxed.update(hall)
        for cause in ("pinned", "declared", "closed", "locked", "lessons"):
            drop_if_unneeded(by_cause.get(cause, set()))

        # The classes, in chunks: a chunk that can go, goes whole; one that
        # cannot is split until the classes that matter stand alone.
        classes = [group_id for (cause, group_id) in stage.literals if cause == "eats"]

        def sentences_of(group_ids: list[UUID]) -> set[tuple[str, UUID | None]]:
            return {key for key in stage.literals if key[1] in set(group_ids)}

        def prune(chunk: list[UUID]) -> None:
            candidates = sentences_of(chunk) - relaxed
            if not candidates:
                return
            verdict = still_impossible(candidates)
            if verdict is True:
                relaxed.update(candidates)
            elif verdict is False and len(chunk) > 1:
                half = len(chunk) // 2
                prune(chunk[:half])
                prune(chunk[half:])

        chunk_size = max(1, -(-len(classes) // 4))
        for index in range(0, len(classes), chunk_size):
            prune(classes[index:index + chunk_size])

        kept = {key for key in stage.literals if key not in relaxed}
        # Read off the classes that eat, in their order, so that no group the
        # lunch sentences cannot be about is ever among them; the question
        # above leaves no other group's sentence pinned.
        kept_groups = {group_id for (_, group_id) in kept}
        named = [group_id for group_id in classes if group_id in kept_groups]
        children = sum(stage.headcounts.get(group_id, 0) for group_id in named)

        def named_for(cause: str) -> list[UUID]:
            return [group_id for group_id in named if (cause, group_id) in kept]

        details: list[ConflictDetail] = []
        if seats_matter is not False:
            details.append(ConflictDetail(
                category="DINING_CAPACITY",
                code="LUNCH_SEATS_CAP",
                params={"seats": seats},
            ))
        # One sentence per cause, the same for every class, with the classes
        # in the ids: a school reads one line, not twenty-four copies of it.
        if named_for("eats"):
            details.append(ConflictDetail(
                category="LUNCH_WINDOW" if seats_matter is False else "DINING_CAPACITY",
                code=(
                    "LUNCH_CLASSES_EAT_DAILY"
                    if seats_matter is False
                    else "LUNCH_CLASSES_FILL_THE_HALL_DAILY"
                ),
                resource_ids=named_for("eats"),
            ))
        # The lessons, quoting the frame that packs the day where there is
        # one to quote: in the frame reproduction the frame IS the lever, and
        # a line that only said "lessons" sent the school to its timplan.
        # One line per distinct frame, so classes under different frames are
        # not put under one sentence that fits neither. Two codes rather than
        # one with an optional clause: a translator cannot inflect a sentence
        # around a hole that is sometimes empty.
        by_window: dict[str | None, list[UUID]] = defaultdict(list)
        for group_id in named_for("lessons"):
            by_window[stage.window_texts.get(group_id)].append(group_id)
        for window_text, group_ids in by_window.items():
            details.append(ConflictDetail(
                category="LUNCH_WINDOW",
                code=(
                    "LUNCH_LESSONS_FILL_THE_FRAMED_DAY"
                    if window_text
                    else "LUNCH_LESSONS_FILL_THE_DAY"
                ),
                params={"window": window_text} if window_text else {},
                resource_ids=group_ids,
            ))
        for cause, category, code in (
            ("pinned", "LUNCH_WINDOW", "LUNCH_STARTS_PLACED_BY_HAND"),
            ("declared", "LUNCH_WINDOW", "LUNCH_STARTS_NARROWED_BY_SITTING_OR_FRAME"),
            ("locked", "GROUP_OVERLAP", "LUNCH_STARTS_TAKEN_BY_LOCKED_LESSONS"),
            ("closed", "AVAILABILITY", "LUNCH_STARTS_TAKEN_BY_RESERVATION"),
        ):
            group_ids = named_for(cause)
            if group_ids:
                details.append(ConflictDetail(
                    category=category, code=code, resource_ids=group_ids,
                ))

        # Three summaries rather than one with a substituted lead: a lead
        # built here would arrive at the translator as a finished English
        # sentence with a Swedish tail stapled to it.
        if seats_matter is None:
            code = "LUNCH_NO_PLACEMENT_SEATS_UNDECIDED"
            params: dict[str, str | int] = {"seats": seats, "classes": len(named)}
        elif seats_matter:
            code = "LUNCH_HALL_CANNOT_SEAT_CLASSES"
            params = {
                "seats": seats,
                "classes": len(named),
                "students": children,
                "lunchMinutes": rules.lunch_minutes,
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
            }
        else:
            code = "LUNCH_NO_PLACEMENT_FOR_CLASSES"
            params = {"classes": len(named)}
        if maximum_line is not None:
            # The line the count proved leads; what the solves named follows.
            details.insert(0, maximum_line)
        return ConflictAnalysis(
            summary_code=code, summary_params=params, conflicts=details,
        )

    def _explain_infeasible(
        self,
        request: OptimizeScheduleRequest,
        *,
        deadline: float | None = None,
    ) -> OptimizeScheduleResponse:
        """Re-solve with assumptions so CP-SAT can name the guilty constraints.

        Only reached once the fast build has already *proved* infeasibility.
        This second solve is the single-threaded one, which is affordable here:
        it runs on a payload that has no timetable, where a precise explanation
        is the whole value of the response.

        If it cannot reproduce the proof within the budget, the verdict still
        stands — it was proved by the first solve — and the response degrades to
        an unexplained INFEASIBLE rather than an invented explanation.

        Not run at all for a request that turned its probes off: the verdict
        is the proof's, and a candidate after the first has the first one's
        hard rules, so the first one's explanation is already the school's.
        """
        if not _runs_probes(request):
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=None,
            )
        # WITH the objective, though the proof came from a model without one,
        # and that is not an oversight. Dropping it here shortens some solves —
        # measured on the lunch-bounded rast payload, UNKNOWN at the 15-second
        # cap becomes INFEASIBLE in 5.3 s with the rule named — but a
        # sufficient assumption set is not unique, and the objective-free model
        # answers an oversubscribed week with INSUFFICIENT_RESOURCES where this
        # one names ROOM_CAPACITY. Trading one school's precise cause for
        # another's is a change that needs its own measurement across the
        # refusal suite, not a line borrowed from a rast fix.
        # WHERE THE SCHOOL KEEPS THE WALK, A SECOND TRY WITHOUT IT. Measured on
        # the review's tight week (gentravel.tight(3070), a walk of 40), the
        # objective's assumption solve ran past the 15-second cap and the
        # refusal reached the school with no cause at all; without the
        # objective, 1.9 s and a core of six. Not instead of the objective,
        # though: on the högstadium week at four lessons a day with the walk,
        # the objective's core came in 0.4 s and the objective-free one in
        # 10.2. So the objective first, on EXPLAIN_WALK_FIRST_SECONDS of the
        # cap, and only when it names nothing the model without it, on the
        # rest. A school that has not turned the walk on is explained exactly
        # as before.
        keeps_walk = travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        ) is not None
        model, registry, _, _, _ = self._build_model(request, use_assumptions=True)
        solver = cp_model.CpSolver()
        # Capped, because the verdict is already in. Measured: a payload phase 1
        # proves INFEASIBLE in under a second can keep this single-threaded
        # assumption solve busy for the whole budget and still hand back
        # nothing — 60 s of waiting for an explanation that does not come. An
        # unexplained INFEASIBLE after fifteen seconds says the same thing as
        # one after sixty, and the school has its answer forty-five seconds
        # sooner.
        cap = min(self._settings.solver_max_time_seconds, self.EXPLAIN_CAP_SECONDS)
        solver.parameters.max_time_in_seconds = (
            min(cap, self.EXPLAIN_WALK_FIRST_SECONDS) if keeps_walk else cap
        )
        conflicts = None
        status = _solve_guarded(
            solver, model, what="the explanation", request_id=request.request_id,
        )
        if keeps_walk and status != cp_model.INFEASIBLE:
            left = cap - solver.wall_time
            if left >= self.MIN_PHASE_SECONDS:
                model, registry, _, _, _ = self._build_model(
                    request, use_assumptions=True, include_objective=False,
                )
                solver = cp_model.CpSolver()
                solver.parameters.max_time_in_seconds = left
                status = _solve_guarded(
                    solver, model, what="the explanation without the objective",
                    request_id=request.request_id,
                )
        if status == cp_model.INFEASIBLE:
            conflicts = build_conflict_analysis(solver, registry)
            # Before the blocks below: a core the maximum alone filled is a
            # core with nothing to say once its line goes.
            if conflicts is not None:
                left = None if deadline is None else deadline - time.monotonic()
                conflicts = self._daily_maximum_verdict(request, conflicts, seconds_left=left)
                left = None if deadline is None else deadline - time.monotonic()
                conflicts = self._travel_verdict(request, conflicts, seconds_left=left)
        # A PROOF WITH NOTHING TO SAY, ON A WEEK WITH BLOCKS. A block is the
        # one rule a school writes to make its week NARROWER, so a refusal that
        # names nothing while blocks are in force sends the school looking
        # everywhere but at the thing it just did. When the explaining solve
        # finds no core, the week is solved again without its blocks; if that
        # finds a timetable, the blocks are what make the week impossible, and
        # the refusal says so by name rather than as an unexplained INFEASIBLE.
        unexplained = conflicts is None or conflicts.summary_code == "CONFLICT_NO_CORE"
        # THE SAME, FOR THE WALK, and first: the one rule a school with two
        # sites turned on itself. Solved again without it; a timetable then
        # names whom it leaves short of a walk, measured 1.
        if unexplained and keeps_walk:
            left = None if deadline is None else deadline - time.monotonic()
            conflicts = self._travel_without_core(request, seconds_left=left) or conflicts
            unexplained = conflicts is None or conflicts.summary_code == "CONFLICT_NO_CORE"
        if unexplained and _blocks_of(request.requirements):
            # Out of the solve's own budget, not on top of it: `deadline` is
            # solve()'s, a time.monotonic() value, and the probe gets what the
            # proof and the explanation left of it.
            left = None if deadline is None else deadline - time.monotonic()
            conflicts = self._blocks_verdict(request, seconds_left=left) or conflicts
        return OptimizeScheduleResponse(
            request_id=request.request_id,
            status="INFEASIBLE",
            lessons=[],
            # The walk's pupils are keyed in the pupil space; a derived key
            # leaves named by its class (_named_by_class).
            conflicts=_named_by_class(request, conflicts),
        )

    # A phase below this gets no real search done — it is all presolve — so a
    # smaller remainder is not worth a second solve and the winning phase-1
    # schedule is returned directly.
    MIN_PHASE_SECONDS = 0.5
    # Ceiling on the assumption re-solve that names an INFEASIBLE's causes. The
    # verdict is proved before it runs; this only decides how long the school
    # waits for the names.
    EXPLAIN_CAP_SECONDS = 15.0
    # Restid i generatorn: the objective's share of that cap before the
    # explanation tries the model without it. See _explain_infeasible.
    EXPLAIN_WALK_FIRST_SECONDS = 5.0
    # Cap on the objective-free build's slice of phase 1. Beyond mid-size
    # schools it stops converging at all (>240s at 1,000 students), so letting
    # it run longer only starves the encoding that does work there.
    CLEAN_SAT_CAP_SECONDS = 60.0
    # Cap on the lunch stage that runs before the models are built. On a week
    # it refuses it has paid for itself many times over; on a feasible week
    # this is the most it can cost, and its starts are hinted onward.
    LUNCH_STAGE_CAP_SECONDS = 10.0
    # Restid i generatorn: the most of the budget the week on planned sites
    # may take before phase 1a gets the rest, and the cap on planning them.
    # See _solve_on_planned_sites.
    TRAVEL_PLANNED_SHARE = 0.6
    SITE_PLAN_CAP_SECONDS = 5.0

    def _solve_on_planned_sites(
        self,
        request: OptimizeScheduleRequest,
        travel: TravelMap,
        feas_model: cp_model.CpModel,
        feas_decisions: list[LessonDecision],
        feas_plan: RoomPlan,
        seconds: float,
        *,
        make_solver: Callable[[float], cp_model.CpSolver],
        what: str = "the planned sites",
        tie_break: bool = True,
    ) -> cp_model.CpSolver | None:
        """Search the week with each lesson on the site planned for it.

        WHY A SECOND SEARCH. A lesson that may use rooms on two sites chooses
        its site and its time in one search, and the walk's rows bind only
        once a site is chosen, so the free search guesses blind: on the
        högstadium week on two sites it found nothing where the same week with
        its sites fixed found a timetable (travel.site_plan has the
        measurement). So the sites are planned first — every teacher and
        group a home site and as few lessons away from it as the rooms allow —
        and phase 1a's own model is searched with each lesson's other sites
        closed.

        NOTHING IS PROVED HERE. The pinned model is phase 1a's with rows
        added, so a timetable found keeps every rule and is returned as phase
        1a's would be (a clone keeps every variable's index). An INFEASIBLE or
        an UNKNOWN says only that these sites were a bad guess: None, and
        solve() goes on to phase 1a with what is left, which proves or finds
        what it can on the free model, as it did before. The probes use it the
        same way (_probe_search).

        `seconds` is the whole of it; the plan itself takes at most
        SITE_PLAN_CAP_SECONDS of that. `make_solver` builds each solver for
        the seconds it may take — solve()'s generation solver, with the
        request's seed and workers, or a probe's.
        """
        if seconds < 2 * self.MIN_PHASE_SECONDS:
            return None
        started = time.monotonic()
        slots_per_day = self._grid.slots_per_day
        decision_of = {decision.lesson.key(): decision for decision in feas_decisions}
        spans: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for key, _start, duration, _room in feas_plan.placements:
            decision = decision_of[key]
            forced = feas_plan.forced_class.get(key)
            classes = [forced] if forced is not None else list(feas_plan.literals[key])
            starts = decision.starts or cp_model.Domain(0, self._grid.horizon - duration)
            reach = [
                span
                for ranges in _day_reach(starts, duration, slots_per_day).values()
                for span in ranges
            ]
            for class_index in classes:
                spans[class_index].extend(reach)
        # A room closed for part of the week, or held there by a locked lesson,
        # gives its class less than its lessons can reach. Such a room is a
        # class of its own (collect_distinguished_room_ids), so its windows are
        # its class's, exactly.
        room_class = {
            room_class.room_indices[0]: room_class.index
            for room_class in feas_plan.classes
            if room_class.capacity == 1
        }
        index_of = {room.id: index for index, room in enumerate(request.rooms)}
        blocked: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for constraint in request.constraints:
            if (
                constraint.kind != "UNAVAILABLE"
                or constraint.date is not None
                or constraint.resource_kind != "ROOM"
            ):
                continue
            class_index = room_class.get(index_of.get(constraint.resource_id, -1))
            if class_index is None:
                continue
            try:
                blocked[class_index].extend(self._grid.window_to_absolute_range(
                    constraint.day_of_week, constraint.start_time, constraint.end_time,
                ))
            except ValueError:
                continue
        for fixed in request.fixed_lessons:
            if fixed.room_id is None:
                continue
            class_index = room_class.get(index_of.get(fixed.room_id, -1))
            window = self._fixed_window(fixed)
            if class_index is not None and window is not None:
                blocked[class_index].append(window)
        open_slots = {
            class_index: _covered(ranges) - _covered_both(ranges, blocked.get(class_index, []))
            for class_index, ranges in spans.items()
        }
        families = families_of(feas_decisions, request.group_conflicts)
        locked_sites: dict[tuple[Party, tuple[UUID, ...]], set[object]] = defaultdict(set)
        for fixed in request.fixed_lessons:
            site = travel.site_of_room.get(fixed.room_id) if fixed.room_id else None
            if site is None:
                continue
            teachers = {tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid}
            # The families are the pupil space's (families_of), so the lock's
            # pupils are read in it too.
            groups = set(pupil_keys_of(fixed))
            for family in families:
                ids = set(family.resource_ids)
                if (family.party == "TEACHER" and ids & teachers) or (
                    family.party == "PUPILS" and ids & groups
                ):
                    locked_sites[(family.party, family.resource_ids)].add(site)
        planned = site_plan(
            feas_decisions,
            feas_plan,
            families,
            locked_sites,
            open_slots,
            solver=make_solver(min(self.SITE_PLAN_CAP_SECONDS, seconds * 0.1)),
            solve=lambda solver, model: _solve_guarded(
                solver, model, what="the site plan", request_id=request.request_id,
            ),
            tie_break=tie_break,
        )
        if planned is None:
            logger.info("%s [requestId=%s]: no site plan", what, request.request_id)
            return None
        sites, away = planned
        pinned = feas_model.Clone()
        for key, site in sites.items():
            for other, literal in feas_plan.site_choices.get(key, {}).items():
                if literal is None:
                    continue
                variable = pinned.get_bool_var_from_proto_index(literal.Index())
                pinned.Add(variable == (1 if other == site else 0))
        left = seconds - (time.monotonic() - started)
        if left < self.MIN_PHASE_SECONDS:
            return None
        solver = make_solver(left)
        code = _solve_guarded(solver, pinned, what=what, request_id=request.request_id)
        logger.info(
            "%s [requestId=%s]: sites planned for %d lessons (%d away from home) in %.1fs; %s",
            what, request.request_id, len(sites), away, time.monotonic() - started,
            solver.StatusName(code),
        )
        if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return solver
        return None

    def _probe_search(
        self,
        request: OptimizeScheduleRequest,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        plan: RoomPlan,
        seconds: float,
        *,
        what: str,
    ) -> tuple[int, cp_model.CpSolver]:
        """A probe's search: on planned sites first, where the probe keeps the walk.

        Every probe that keeps the walk — the daily maximum's, the blocks', a
        timeout relaxation's, the walk's own against the fixed part — searches
        a model the free search finds no two-site timetable in
        (_solve_on_planned_sites), and its UNKNOWN is a verdict lost: on the
        högstadium week at four lessons a day the maximum's line fell from
        `measured` 1 to 0, at place 22 of 256, and the refusal took 61.5 s
        where it took 19.1 without the walk. So it searches as solve() does:
        the planned sites on TRAVEL_PLANNED_SHARE of its seconds, then the
        free model on what is left. A timetable on planned sites keeps every
        rule of the probe's model; an INFEASIBLE there proves nothing, and the
        free search goes on. A probe without the walk is the one solve it was,
        on a solver with nothing but its time limit set, as the probes' are.
        """
        def make(left: float) -> cp_model.CpSolver:
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = max(0.0, left)
            return solver

        left = seconds
        travel = travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        )
        if travel is not None:
            started = time.monotonic()
            # No tie-break: a probe asks whether a timetable exists at all, and
            # the plan's second stage cost each one up to a second of that.
            found = self._solve_on_planned_sites(
                request, travel, model, decisions, plan, seconds * self.TRAVEL_PLANNED_SHARE,
                make_solver=make, what=f"{what} on planned sites", tie_break=False,
            )
            if found is not None:
                return cp_model.FEASIBLE, found
            left = seconds - (time.monotonic() - started)
        probe = make(left)
        status = _solve_guarded(probe, model, what=what, request_id=request.request_id)
        return status, probe

    def solve(self, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        """Two-phase solve: prove a timetable exists, then improve it.

        A single solve of the optimising model stops producing anything beyond
        ~400 students: CP-SAT hunts for a first solution of the full objective
        model and finds none within budget, so the response is TIMEOUT with
        zero lessons. Splitting existence from quality changes what the budget
        buys — measured on the benchmark school, one solve vs this method:

            750 students    nothing -> valid timetable well inside 120s
            1,300 students  nothing -> valid timetable in ~9 min

        Phase 1 proves existence with a SEQUENTIAL PORTFOLIO of two
        satisfaction encodings, because neither dominates (measured, seconds
        to first solution):

            students        250    400    500     1000
            clean build     3.6    8.3   35.4    >240 (fails)
            cleared clone   9.4   19.5   44.4      82

        The "clean" model is a fresh build without the objective builders; the
        "clone" is the full model with the objective cleared, which keeps the
        objective's auxiliary variables as free variables. Intuition says the
        smaller clean model should always win; at 1,000 students it is the
        clone that solves and the clean build that fails, reproducibly. So the
        clean build runs first (capped — see CLEAN_SAT_CAP_SECONDS), and the
        clone takes the remaining budget if needed. Both share the full
        model's constraint set exactly, so an INFEASIBLE from either is a real
        proof, and either schedule already satisfies every hard rule.

        Phase 2 re-solves the full model with every decision hinted to the
        winning phase-1 values — starting from a solution instead of searching
        for one — in whatever time remains. If it cannot produce a solution in
        that remainder, the phase-1 schedule is returned: a solver holding a
        valid timetable must never answer "nothing". It is reported as
        FEASIBLE, never as phase 1's raw status — a satisfaction solve calls
        any solution OPTIMAL, which would misstate an objective it never
        evaluated.

        A request carrying `search` is solved by a solver of its own, built on
        the request's own Settings — see settings_for_search — so nothing
        below reads a budget the request did not ask for, and this solver's
        own Settings, which may be the app's, are left as they were.
        """
        scoped = settings_for_search(self._settings, request.search)
        if scoped is not self._settings:
            return SchedulerSolver(scoped).solve(request)
        entered = time.monotonic()
        self._validate_request(request)
        # THE STEP, beside the grid it counts in. Per request, because the week
        # decides it: one lesson locked at 08:05 takes a school searched every
        # thirty minutes back to every five, and a log that only named the
        # grid would not show why the same school slowed down.
        step = _start_step(request, self._grid)
        logger.info(
            "start step: slot_minutes=%d step_slots=%d step_minutes=%d",
            self._grid.slot_minutes, step, step * self._grid.slot_minutes,
        )
        # Arithmetic first, models second: a hall the school cannot fit in is
        # decided here in microseconds and reported the way a solve would have.
        verdict = (
            self._dining_hall_verdict(request)
            or self._clique_hours_verdict(request)
            or self._teacher_hours_verdict(request)
            or self._lesson_gaps_verdict(request)
        )
        if verdict is not None:
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=verdict,
            )
        # Then the lunches alone: a small model that proves what the full one
        # could not in a minute, or hands it a warm start. See _lunch_stage_one.
        verdict, lunch_hints = self._lunch_stage_one(request)
        if verdict is not None:
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=verdict,
            )

        rooms = request.rooms
        model, _, decisions, room_plan, lunch_full = self._build_model(
            request, use_assumptions=False, include_objective=True,
        )
        feas_model, _, feas_decisions, feas_plan, lunch_feas = self._build_model(
            request, use_assumptions=False, include_objective=False,
        )

        total_budget = self._settings.solver_max_time_seconds
        travel = travel_map(request, slot_minutes=self._grid.slot_minutes, step=step)
        # WHERE THE SCHOOL KEEPS THE WALK THE BUILDS COUNT, from the moment the
        # request arrived: two builds of a 2,000-pupil week with the walk took
        # 3.3 s each, twice their time without it, and the review's timeout
        # path ran to 91 s against the gateway's and the API's 90. A week
        # without the walk keeps the clock it always had.
        started = entered if travel is not None else time.monotonic()
        probe_deadline = (
            None
            if travel is None
            else entered + total_budget + self._settings.solver_probe_seconds
        )

        def _remaining() -> float:
            return total_budget - (time.monotonic() - started)

        # Warm start: the previous schedule's slots seed the existence search.
        # Measured on the benchmark school, this is the difference between
        # minutes of satisfaction search and settling into last term's shape
        # in seconds — see the warm-start table in verification-baseline.md.
        self._hint_previous_lessons(feas_model, feas_decisions, request.previous_lessons)
        # The lunch stage's starts as well: a school's meals settled before its
        # lessons are searched. Different variables from the ones above, so no
        # hint names a variable twice.
        for key, slot in lunch_hints.items():
            if key in lunch_feas:
                feas_model.AddHint(lunch_feas[key], slot)

        # ---- phase 1s: Restid i generatorn, the week on planned sites -------
        # FIRST, on a week that keeps the walk, and only there: the free
        # search below guesses sites blind and finds no first timetable where
        # this finds one (_solve_on_planned_sites). A timetable found here has
        # phase 1a's own variables (a clone keeps every index) and is read and
        # hinted onward exactly as phase 1a's would be.
        # WHAT IT COSTS A REFUSAL, stated rather than hidden. Nothing proved
        # here is kept: an INFEASIBLE on the pinned model says only that the
        # sites were a bad guess, so a week impossible for any other reason is
        # proved twice, here and in phase 1a, and phase 1a proves it on what
        # this left. Where the pinned model refutes fast — the walk itself the
        # cause, or a contradiction no site choice touches — that is seconds;
        # where it searches its whole share and answers nothing, phase 1a has
        # 1 − TRAVEL_PLANNED_SHARE of the budget, and a refusal phase 1a needs
        # longer than that to prove comes back TIMEOUT, whose probes still
        # name the walk where dropping it helps. Measured in the review with a
        # clock replaced: at 60 s, refusals needing 30–59 s of phase 1a were
        # lost when the pinned model was as hard to refute as the free one.
        # Posting the pins as assumptions, so that an INFEASIBLE with none in
        # its core is a proof of the free week, was measured too and not
        # taken: CP-SAT runs an assumption solve on one worker with
        # presolve held back, 6.2 s where phase 1a's own proof took 3.0.
        # Capped at CLEAN_SAT_CAP_SECONDS, the clean encoding's own cap: the
        # pinned model is a clone of that build, and past mid-size schools
        # time beyond the cap is better spent on phase 1b.
        sited = (
            self._solve_on_planned_sites(
                request, travel, feas_model, feas_decisions, feas_plan,
                # Of what is LEFT, not of the budget: with the walk the builds
                # count (above), and a share of the whole budget taken after
                # slow builds left phase 1a a negative time limit, which
                # CP-SAT calls MODEL_INVALID (the review's 2,000-pupil week
                # at ten seconds: an HTTP 500).
                min(max(0.0, _remaining()) * self.TRAVEL_PLANNED_SHARE, self.CLEAN_SAT_CAP_SECONDS),
                make_solver=lambda seconds: self._generation_solver(request, seconds),
            )
            if travel is not None
            else None
        )
        if sited is not None:
            phase1, phase1_code = sited, cp_model.FEASIBLE
        else:
            # ---- phase 1a: clean satisfaction build -------------------------
            if travel is not None and _remaining() < self.MIN_PHASE_SECONDS:
                # Nothing left after the builds and the planned sites: the
                # timeout below, as phase 1b's own guard has it, never a
                # solve on a time limit at or under zero.
                phase1_code = cp_model.UNKNOWN
            else:
                phase1 = self._generation_solver(
                    request,
                    min(total_budget, self.CLEAN_SAT_CAP_SECONDS)
                    if travel is None
                    else min(max(0.0, _remaining()), self.CLEAN_SAT_CAP_SECONDS),
                )
                phase1_code = _solve_guarded(
                    phase1, feas_model, what="phase 1a", request_id=request.request_id,
                )

            # MODEL_INVALID is a bug in model construction, not a property of
            # the school's data — surface it as a server error instead of
            # dressing it up as a scheduling verdict.
            if phase1_code == cp_model.MODEL_INVALID:
                msg = f"CP-SAT rejected the generated model: {feas_model.Validate()}"
                raise SolverBuildError(msg)

            # Conflict analysis is only meaningful once CP-SAT has *proved*
            # infeasibility, and the proof needs the assumptions field, which
            # these builds leave empty so the search can use every core.
            # Explaining the failure means rebuilding — paid only on a payload
            # that has no timetable.
            if phase1_code == cp_model.INFEASIBLE:
                return self._explain_infeasible(request, deadline=started + total_budget)

        if phase1_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            winner_solver: cp_model.CpSolver = phase1
            winner_decisions = feas_decisions
            winner_plan = feas_plan
            winner_lunch = lunch_feas
            # The two builds iterate the same request in the same order, so
            # their decision lists and room-class literal maps correspond
            # one-to-one. Guarded rather than assumed: hinting mismatched
            # variables would silently corrupt the search.
            if (
                len(decisions) != len(feas_decisions)
                or set(room_plan.literals) != set(feas_plan.literals)
                # The lunch keys as well: the two builds must agree on which
                # groups eat on which days, or the map read below belongs to a
                # different school week than the one being returned.
                or set(lunch_full) != set(lunch_feas)
                # And the walk's site literals, made in build order.
                or [(key, site) for key, site, _ in room_plan.site_vars]
                != [(key, site) for key, site, _ in feas_plan.site_vars]
            ):
                msg = "objective-free and full builds disagree on model structure"
                raise SolverBuildError(msg)
            hint_pairs = list(zip(decisions, feas_decisions))
            hint_literals = [
                (literal, feas_plan.literals[key][class_index])
                for key, literals in room_plan.literals.items()
                for class_index, literal in literals.items()
            ] + [
                (literal, source)
                for (_, _, literal), (_, _, source) in zip(
                    room_plan.site_vars, feas_plan.site_vars,
                )
            ]
        else:
            # ---- phase 1b: the cleared clone takes what is left -------------
            remaining = _remaining()
            if remaining < self.MIN_PHASE_SECONDS:
                logger.warning(self._timeout_diagnosis(
                    request,
                    "phase 1a used the whole budget"
                    if travel is None
                    else "the planned sites and phase 1a used the whole budget",
                ))
                return OptimizeScheduleResponse(
                    request_id=request.request_id,
                    status="TIMEOUT",
                    lessons=[],
                    conflicts=(
                        self._probe_timeout(request)
                        if probe_deadline is None
                        else self._probe_timeout(request, deadline=probe_deadline)
                    ),
                )
            clone_model = model.Clone()
            clone_model.ClearObjective()
            phase1b = self._generation_solver(request, remaining)
            # Raised, not degraded, when both attempts throw: its UNKNOWN
            # would be the TIMEOUT below. See _solve_guarded.
            phase1b_code = _solve_guarded(
                phase1b, clone_model, what="phase 1b", request_id=request.request_id,
                degrade=False,
            )

            if phase1b_code == cp_model.MODEL_INVALID:
                msg = f"CP-SAT rejected the generated model: {clone_model.Validate()}"
                raise SolverBuildError(msg)
            if phase1b_code == cp_model.INFEASIBLE:
                return self._explain_infeasible(request, deadline=started + total_budget)
            if phase1b_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                logger.warning(self._timeout_diagnosis(request, "neither satisfaction encoding found a timetable"))
                return OptimizeScheduleResponse(
                    request_id=request.request_id,
                    status="TIMEOUT",
                    lessons=[],
                    conflicts=(
                        self._probe_timeout(request)
                        if probe_deadline is None
                        else self._probe_timeout(request, deadline=probe_deadline)
                    ),
                )
            # Clone() preserves variable indices, so the full model's own
            # variables read their values straight off the clone's solver.
            winner_solver = phase1b
            winner_decisions = decisions
            winner_plan = room_plan
            winner_lunch = lunch_full
            hint_pairs = [(decision, decision) for decision in decisions]
            hint_literals = [
                (literal, literal)
                for literals in room_plan.literals.values()
                for literal in literals.values()
            ] + [(literal, literal) for _, _, literal in room_plan.site_vars]

        def _phase1_response() -> OptimizeScheduleResponse:
            lessons = self._extract_lessons(
                winner_solver, winner_decisions, rooms, winner_plan,
            )
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="FEASIBLE",
                lessons=lessons,
                lunches=self._lunches_of(winner_solver, winner_lunch, request.rules),
                conflicts=None,
            )

        remaining = _remaining()
        if remaining < self.MIN_PHASE_SECONDS:
            return _phase1_response()

        # ---- phase 2: improve the schedule in the remaining budget ----------
        # _add_disruption_objective already hints previous-lesson slots; they
        # must yield to the complete phase-1 solution — CP-SAT rejects a model
        # whose hint names the same variable twice, and a full feasible
        # assignment is a strictly stronger starting point than a partial
        # guess.
        model.ClearHints()
        for decision, source in hint_pairs:
            model.AddHint(decision.start, winner_solver.Value(source.start))
            model.AddHint(decision.room_index, winner_solver.Value(source.room_index))
        for literal, source_literal in hint_literals:
            model.AddHint(literal, winner_solver.Value(source_literal))
        if request.search is not None:
            # A schemaförslag candidate's phase 2 starts from a COMPLETE hint.
            # Only for a request that carries `search`, so a Generera is solved
            # exactly as before; see _complete_the_hint for what it buys.
            self._complete_the_hint(
                model, request, winner_solver, lunch_full, winner_lunch,
                seconds=remaining,
            )
            remaining = _remaining()
            if remaining < self.MIN_PHASE_SECONDS:
                return _phase1_response()

        phase2 = self._generation_solver(request, remaining)
        phase2_code = _solve_guarded(
            phase2, model, what="phase 2", request_id=request.request_id,
        )
        if phase2_code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the generated model: {model.Validate()}"
            raise SolverBuildError(msg)

        if phase2_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            lessons = self._extract_lessons(phase2, decisions, rooms, room_plan)
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status=self._map_status(phase2_code),
                lessons=lessons,
                # lunch_full, not winner_lunch: phase 2 solved the full model.
                lunches=self._lunches_of(phase2, lunch_full, request.rules),
                conflicts=None,
            )

        # Phase 2 came up empty: fall back to the phase-1 schedule rather than
        # returning nothing. FEASIBLE, deliberately.
        return _phase1_response()

    # Ceiling on the solve that completes phase 2's hint, and its share of
    # what is left: measured at under half a CPU-second on the 500- and
    # 1,000-pupil bench schools, so either bound only matters on a week far
    # larger than the benchmark's.
    HINT_COMPLETION_CAP_SECONDS = 10.0
    HINT_COMPLETION_SHARE = 1 / 3

    def _complete_the_hint(
        self,
        model: cp_model.CpModel,
        request: OptimizeScheduleRequest,
        winner: cp_model.CpSolver,
        lunch_full: dict[tuple[UUID, int], cp_model.IntVar],
        winner_lunch: dict[tuple[UUID, int], cp_model.IntVar],
        *,
        seconds: float,
    ) -> bool:
        """Turn phase 2's hint into a whole solution of the full model.

        THE HINT phase 2 is given is phase 1's timetable — every start, every
        room — and nothing else: none of the variables the objective adds.
        CP-SAT says so in its own log, on the 500-pupil bench school warm-started
        from its draft: "The solution hint is incomplete: 3240 out of 18679 non
        fixed variables hinted". It completes the rest itself, and badly. Its
        first solution held the draft's lessons exactly and scored 16,274 —
        the same lessons had scored 825 when the draft was solved — because a
        teacher's `first` and `last`, a pair's same-day literal and a
        kept-lesson literal are whatever the completing search happened to
        set. The local search then spends the budget repairing a start it was
        handed broken, and moves lessons while it does. Measured on
        thirty-second candidates (docs/verification-baseline.md,
        "Schemaförslag"): at 500 pupils every emphasis came back with more
        håltimmar than the draft it started from — "Färre håltimmar för
        lärarna" with 6,840 minutes against the draft's 930 — and at 1,000 no
        candidate's phase 2 found anything in its thirty seconds, two of the
        three coming back as the draft itself.

        SO THE TIMETABLE IS HELD AND ONLY THE REST IS SOLVED: the lessons, the
        rooms and the lunches pinned to phase 1's values
        (fix_variables_to_their_hinted_value), which leaves CP-SAT a small
        problem it solves to optimality in a fraction of a second, and its
        answer becomes the hint for every variable. Phase 2 then starts from
        phase 1's timetable at that timetable's true objective. The same
        candidates, same budgets: 390 minutes for "Färre håltimmar", and at
        1,000 pupils a timetable of its own from every one.

        Only for a request carrying `search` — every schemaförslag candidate
        sends it — so a Generera's solve is unchanged byte for byte; whether
        Generera should have it too is a measurement of its own.

        False, and the partial hint left as it was, when the completing solve
        finds nothing inside its share of the budget.
        """
        for key, variable in lunch_full.items():
            source = winner_lunch.get(key)
            if source is not None:
                model.AddHint(variable, winner.Value(source))
        completion = self._generation_solver(
            request,
            min(seconds * self.HINT_COMPLETION_SHARE, self.HINT_COMPLETION_CAP_SECONDS),
        )
        completion.parameters.fix_variables_to_their_hinted_value = True
        code = _solve_guarded(
            completion, model, what="the hint completion", request_id=request.request_id,
        )
        if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            logger.info("hint completion: %s, phase 2 keeps the partial hint", completion.StatusName(code))
            return False
        values = list(completion.response_proto.solution)
        model.ClearHints()
        for index, value in enumerate(values):
            model.AddHint(model.get_int_var_from_proto_index(index), value)
        logger.info(
            "hint completion: %s, objective %d, %d variables hinted",
            completion.StatusName(code), completion.ObjectiveValue(), len(values),
        )
        return True

    @staticmethod
    def _generation_solver(
        request: OptimizeScheduleRequest, seconds: float,
    ) -> cp_model.CpSolver:
        """A CpSolver for one of solve()'s generation solves.

        THE GENERATION SOLVES ONLY: phase 1a, phase 1b, phase 2 and the solve
        that completes phase 2's hint, the ones that decide which timetable
        the school gets. The lunch stage keeps its
        one deterministic worker, for the reason _lunch_stage_solver gives.
        The probes and the explanation are left as they were: they run only
        on a refusal, which a seed cannot turn into a timetable, and a seed
        that moved a refusal's named causes would have the same week explain
        itself differently from one request to the next.

        Nothing but the time limit is set when the request names neither a
        seed nor a worker count, which is every request but a candidate's: the
        parameters are then exactly what they were before `search` existed.
        """
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        search = request.search
        if search is not None:
            if search.seed is not None:
                solver.parameters.random_seed = search.seed
            if search.workers is not None:
                solver.parameters.num_workers = search.workers
        return solver

    def _hint_previous_lessons(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
    ) -> int:
        """Warm-start a model from the previous schedule's placements.

        One hint per previous slot, on one not-yet-hinted lesson instance of
        the same requirement — the same pairing _add_disruption_objective uses
        for its penalty terms, so the hint and the objective pull toward the
        same assignment.

        This exists because the two-phase split silently disabled the warm
        start: the hints used to ride along inside _add_disruption_objective,
        which the objective-free phase-1a build never runs, and phase 2 clears
        all hints in favour of the phase-1 solution. Phase 1a must therefore
        be hinted explicitly. (Phase 1b needs no call — it clones the full
        model, inheriting the disruption builder's own hints.)

        Hints are guidance, not constraints: a stale slot — say the teacher it
        belonged to has a new unavailability — costs nothing beyond the search
        repairing that part of the schedule.

        Returns the number of hints installed.
        """
        pairs = self._previous_hints(decisions, previous_lessons)
        for decision, slot in pairs:
            model.AddHint(decision.start, slot)
        return len(pairs)

    def _previous_hints(
        self,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
    ) -> list[tuple[LessonDecision, int]]:
        """Which lesson instance each previous slot hints, in the order they are hinted.

        ONE PAIRING FOR BOTH HINTERS, _hint_previous_lessons and the warm start
        inside _add_disruption_objective, so the two builds of a solve start
        from the same guess. A requirement in no block is paired as it always
        was: each previous slot, in the payload's order, on the first instance
        of its requirement not yet hinted, skipping a slot off the grid.

        A BLOCK IS HINTED AS ONE. Its members' k-th lessons must start
        together, and hinting Ty7's first lesson at Monday 09:00 and Fr7's at
        Wednesday 10:00 would point the search at an assignment the block
        rules out before it has begun. So every member is hinted from one list:
        the previous slots of the member that had the most of them (the first
        such in the payload), in time order, the k-th slot on each member's
        k-th lesson. A block placed as one last run is hinted back where it
        was; a member added since has no slots of its own and takes the
        block's; members placed apart before the block existed are hinted
        where one of them was.
        """
        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        own: dict[UUID, list[int]] = {}
        order: list[UUID] = []
        for previous in previous_lessons:
            if previous.requirement_id not in by_requirement:
                continue
            try:
                start_slot = self._grid.parse_hhmmss(previous.start_time)
                abs_slot = self._grid.absolute_start(previous.day_of_week, start_slot)
            except ValueError:
                continue  # off-grid previous slot — nothing to warm-start from
            own.setdefault(previous.requirement_id, []).append(abs_slot)
            order.append(previous.requirement_id)

        slots = dict(own)
        requirements = {
            decision.lesson.requirement.id: decision.lesson.requirement for decision in decisions
        }
        for members in _blocks_of(requirements.values()).values():
            richest = max(members, key=lambda member: len(own.get(member.id, ())))
            shared = sorted(own.get(richest.id, ()))
            for member in members:
                slots[member.id] = shared

        pairs: list[tuple[LessonDecision, int]] = []
        used: dict[UUID, int] = {}
        for requirement_id in order:
            index = used.get(requirement_id, 0)
            used[requirement_id] = index + 1
            candidates = by_requirement[requirement_id]
            if index < len(candidates) and index < len(slots[requirement_id]):
                pairs.append((candidates[index], slots[requirement_id][index]))
        # A member with fewer previous slots of its own than the block's list
        # takes the rest of it. Every other requirement has used all of its own.
        for requirement_id, shared in slots.items():
            candidates = by_requirement[requirement_id]
            for index in range(used.get(requirement_id, 0), min(len(candidates), len(shared))):
                pairs.append((candidates[index], shared[index]))
        return pairs

    def _estimate_model_size(self, request: OptimizeScheduleRequest) -> int:
        """Predict the variable count of the model this request would build.

        Computed in O(requirements + constraints + rooms) without building
        anything, one term per builder:

            3L              decisions          start, end, room_index per lesson
            L               capacity           one pinned literal per lesson
            L x classes     room allocator     one class literal per eligible
                                               class; bounded by the distinct
                                               (type, capacity) signatures plus
                                               the identity-pinned rooms
            2 x affected    availability +     before/after (or preference)
                            preference         booleans per touched lesson;
                                               ROOM-kind constraints touch every
                                               lesson and add an assignment
                                               literal each, and a GRADE_LEVEL
                                               one is charged as if every group
                                               shared the year
            (1 + D)L + GD   rules              day var per lesson, on-day
                            + GD if locks      boolean per lesson-day, one lunch
                            + 1 if seats       start per group-day, and with a
                            + G'(D + 1)        daily maximum a count per day of
                              if a max         each group with more lessons
                                               than it (G') and the literal
                                               its maximum hangs on. G counts
                                               every group that eats — the ones
                                               with lessons plus the ones only
                                               `groups` names, since a class
                                               whose week is locked still gets a
                                               break. Locked lessons add one
                                               literal per group-day whose lunch
                                               they narrow; which pairs those
                                               are needs a fixed-lessons x
                                               groups scan, so the worst case is
                                               charged instead, as the ROOM
                                               branch above also does. A seat
                                               limit adds exactly one variable
                                               however big the school: its
                                               cumulative reuses those same
                                               starts through optional
                                               intervals, and every one of them
                                               is present on the single
                                               registered dining literal, so the
                                               literal is the whole cost
            pairs(req)      spread             one boolean per same-requirement
                                               lesson pair
            TD(2)           teacher lunch      a movable start and the literal
                            + TD(3L + 3)       its presence hangs on, per rule
                            teacher rest       and day; and for the rest, per
                                               day, a literal per lesson saying
                                               whether it is here, the two
                                               clamped ends it feeds a minimum
                                               and a maximum, and the day's own
                                               first, last and `works`, plus a
                                               literal per pair of consecutive
                                               days and, where the payload
                                               holds locked lessons, two more
                                               per day for folding one in. T
                                               counts only the teachers the
                                               timplan gives a lesson to, which
                                               is the builder's own skip
            2 x pairs(t)    teacher gap        boolean + gap var per
                                               same-teacher pair, mirroring the
                                               builder's own skip of any teacher
                                               above 600 pairs
            2P              disruption         per previous lesson
            (D + 1)L_r      distribution       per requirement with a rule: a
            + 2D + 2                           day literal per lesson and day, the
                                               lesson's own day variable where the
                                               spread did not build it, a `used`
                                               flag and a count per day, and the
                                               two rule literals. Zero without a
                                               rule
            RD(2L + G) + G  rast ordering      an `inside` and a `late` flag per
                                               lesson, and a `still_here`
                                               literal per class, for every day
                                               and every rast that asks for a
                                               lesson before it, plus one
                                               assumption literal per class for
                                               the week. Zero unless a rast
                                               asks; the minutes a rast reserves
                                               cost no variables at all
            S'L + 2L        travel             with the walk on (travel.py): a
            + T + G + C                        literal per lesson and site it
                                               may stand on (S' sites a walk
                                               is counted from), a day and a
                                               stretched start per lesson for
                                               a row the night could reach, and
                                               one literal per teacher, group
                                               and pair of groups sharing a
                                               pupil (C). The class partition
                                               above splits by site as well,
                                               and the bound counts the site.
                                               Zero with the rule off
            (D + 1)L_t      teacher's day      per teacher whose row caps the
            + 2D + DC + 1                      day or whose post limits the
            + W                                days, and who has a lesson: a
                                               day literal per lesson and day,
                                               the lesson's own day variable, a
                                               `works` and the minutes per day,
                                               a cap literal per day and
                                               capping row (C of them) and the
                                               days literal; and one `works`
                                               per free-day wish (W) whose
                                               teacher has a lesson. Zero
                                               without a rule

        NO TERM FOR THE PADDED INTERVALS, and that is a measurement rather than
        an omission. A lesson can now carry two extra interval protos — the
        corridor's padded_of and the pupils' pupil_padded_of — and each reuses
        the lesson's own `start` and `end` through affine expressions, so
        neither adds an IntVar or a BoolVar. What this function predicts is the
        VARIABLE count, which is what MAX_MODEL_COMPLEXITY is calibrated in, so
        the honest update for the pupils' interval was to check the arithmetic
        and write this paragraph. A future padding that needs a variable of its
        own — an AddMinEquality against the day's end, say, which is exactly
        what _create_lesson_decisions rejected in favour of clipping a domain —
        owes this table a term.

        On the 2,000-student benchmark this predicts ~99.6K against a measured
        92,546 — an upper bound within 8%. It is LOOSER where the teachers' work
        rules are filled in, and knowingly: on the 400-student gate week with
        both halves given to all 33 teachers it predicts 22,642 against 17,732,
        because the rest rule's day and the idle objective's are the same
        variables charged twice. Still an upper bound, which is the contract. If
        a builder's encoding changes,
        change its term here in the same commit; the benchmark check is
        `benchmarks/solve_2000_students.py --json | grep -i complexity`.
        """
        lessons_per_requirement = {
            requirement.id: requirement.lessons_per_week
            for requirement in request.requirements
        }
        total_lessons = sum(lessons_per_requirement.values())
        day_count = len(self._grid.schedule_days)

        lessons_by_teacher: dict[UUID, int] = {}
        lessons_by_group: dict[UUID, int] = {}
        spread_pairs = 0
        for requirement in request.requirements:
            count = requirement.lessons_per_week
            # Per lesson, because a split post's lessons are not all one
            # teacher's (_teachers_at); an unsplit one counts `count` for its
            # lead and its co-teacher, as it always did.
            for lesson_index in range(count):
                for teacher_id in _teachers_at(requirement, lesson_index):
                    lessons_by_teacher[teacher_id] = (
                        lessons_by_teacher.get(teacher_id, 0) + 1
                    )
            lessons_by_group[requirement.student_group_id] = (
                lessons_by_group.get(requirement.student_group_id, 0) + count
            )
            spread_pairs += count * (count - 1) // 2

        # The room-class partition merges rooms whose eligibility signature is
        # identical. Two rooms share a signature only if they agree on every
        # field _room_allowed reads FROM THE ROOM — type, capacity and the
        # room's own stage limits — and on which preferences name them.
        #
        # The stage limits used to be missing from this tuple, under a comment
        # asserting that (type, capacity) decided it. That was the same omission
        # that made the partition itself place year-4 lessons in a years-7-9
        # room, and here it made the bound an UNDER-estimate: the min() below
        # takes the smaller of the two, so a bound that is too low is not a
        # conservative guess but a wrong one.
        distinguished = collect_distinguished_room_ids(
            request.constraints, request.fixed_lessons,
        )
        preference_sets = [
            set(preference.room_ids)
            for preference in request.room_preferences
            if preference.kind == "WISH"
        ]
        # Restid i generatorn keeps each class on one site, so the site is
        # one more field the signature splits on — None for every room when
        # the rule is off, which leaves the bound as it was.
        travel = travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        )
        signature_bound = len(
            {
                (
                    room.type,
                    room.capacity,
                    room.min_grade_level,
                    room.max_grade_level,
                    tuple(room.id in preferred for preferred in preference_sets),
                    travel.site_key(room) if travel is not None else None,
                )
                for room in request.rooms
            },
        ) + min(len(distinguished), len(request.rooms))
        room_class_vars = total_lessons * min(signature_bound, len(request.rooms))

        affected_vars = 0
        for constraint in request.constraints:
            if constraint.resource_kind == "TEACHER":
                affected_vars += 2 * lessons_by_teacher.get(constraint.resource_id, 0)
            elif constraint.resource_kind == "STUDENT_GROUP":
                affected_vars += 2 * lessons_by_group.get(constraint.resource_id, 0)
            elif constraint.resource_kind == "GRADE_LEVEL":
                # Reaches every group whose own years overlap the reservation,
                # which is knowable only by scanning every group per constraint
                # — an O(constraints x groups) pass in a function that is
                # deliberately linear. Charged at its worst case instead, the
                # same bound the ROOM branch settles for, so the estimate stays
                # an upper bound and stays cheap.
                affected_vars += 2 * total_lessons
            else:  # ROOM: an assignment literal plus before/after for every lesson
                affected_vars += 3 * total_lessons

        # Everyone who gets a lunch start, which is more than the groups with
        # lessons: a class whose week is entirely hand-placed reaches the
        # engine only through `groups` and still eats.
        lunch_groups = len(
            _lunch_group_ids(
                request.groups, _group_ids_with_lessons(request.requirements),
            ),
        )
        # The daily maximum's count per day (_day_totals) and the literal the
        # maximum hangs on, for each group with more lessons than the maximum:
        # the builder's own skip.
        max_per_day = request.rules.max_lessons_per_day_per_group if request.rules else None
        daily_count_vars = (
            (day_count + 1)
            * sum(1 for count in lessons_by_group.values() if count > max_per_day)
            if max_per_day is not None
            else 0
        )
        # One literal per group-day whose lunch a locked lesson narrows, at its
        # worst case. Nothing is charged for a payload with no locked lessons,
        # which is every payload the benchmarks build.
        lunch_lock_vars = day_count * lunch_groups if request.fixed_lessons else 0
        # The same shape for the school's own reservations, which narrow the
        # lunch domain under a literal of their own. Charged only when a
        # STUDENT_GROUP row that could reach a lunch actually exists, so a
        # payload whose rules are all about teachers and rooms pays nothing.
        lunch_closure_vars = (
            day_count * lunch_groups
            if any(
                constraint.kind == "UNAVAILABLE"
                and constraint.date is None
                and constraint.resource_kind == "STUDENT_GROUP"
                for constraint in request.constraints
            )
            else 0
        )
        # Two per group-day beyond the first: a signed drift and its magnitude,
        # so a group's meal can be held to the time it ate at on its own first
        # day.
        #
        # Charged whether or not this payload has a lunch window, exactly as the
        # (1 + D)L and GD terms above are, and for the reason stated there: an
        # over-estimate on a ruleless payload is cheaper than an estimator that
        # reads the rules to decide what to charge. The seat literal stays the
        # only rules-dependent term in the whole function.
        lunch_drift_vars = (
            2 * lunch_groups * max(0, day_count - 1)
            if self._settings.weight_lunch_drift > 0
            else 0
        )
        # The seat rule's entire variable cost, charged whether or not the lunch
        # window that would build it is set — an estimate that is high by one is
        # still an upper bound.
        dining_vars = (
            1
            if request.rules is not None and request.rules.dining_seats is not None
            else 0
        )

        # _add_idle_time_objective, which replaced a pairwise encoding. The old
        # term here was `2 * pairs(t)` under a 600-pair cap that mirrored the
        # builder's own silent skip; both are gone with it. A teacher with two
        # or more lessons now costs, per day: one literal per lesson, plus
        # `first`, `last` and `idle`. Quadratic in a teacher's load became
        # linear, which is why the cap could go.
        #
        # The credit variables are NOT charged. They exist only for teachers who
        # wrote an UNAVAILABLE row on themselves, three per window, and this
        # function's own contract is an UPPER BOUND on a payload it can read —
        # counting them would mean walking the constraints a second time to
        # learn which teacher each belongs to, for a term that is zero on almost
        # every payload. Stated rather than silently omitted.
        # AND CHARGED IN FULL EVEN WHERE THE REST RULE PAID FOR IT. A teacher
        # with a rest rule has their day built two-sided by
        # _add_teacher_work_constraints, and this term then reuses that pair and
        # adds one `idle` variable — so the two terms together over-count such a
        # teacher by a day's worth of literals each. Deliberate: this function's
        # contract is an upper bound, and the alternative is a term that has to
        # know which of two builders ran first.
        idle_vars = 0
        if self._settings.weight_teacher_gap > 0:
            for teacher_lessons in lessons_by_teacher.values():
                if teacher_lessons >= 2:
                    idle_vars += day_count * (teacher_lessons + 3)

        # _add_teacher_work_constraints, one term per half. Only teachers the
        # timplan actually gives a lesson to, which is the builder's own skip: a
        # rule naming a teacher with nothing left to place builds nothing, and
        # charging it would make this an over-estimate for every school that
        # hand-places a teacher's whole week.
        teacher_work_vars = 0
        for rule in request.teacher_work_rules:
            teacher_lessons = lessons_by_teacher.get(rule.teacher_id, 0)
            if teacher_lessons == 0:
                continue
            if rule.has_lunch:
                teacher_work_vars += 2 * day_count
            if rule.min_daily_rest_minutes is not None:
                teacher_work_vars += (
                    day_count * (3 * teacher_lessons + 3)
                    + max(0, day_count - 1)
                    # The folded locked edge, at its worst case — which pair of
                    # (teacher, day) a locked lesson reaches needs a
                    # fixed-lessons x teachers scan, and the lunch-lock term
                    # above settles for the same bound for the same reason.
                    + (2 * day_count if request.fixed_lessons else 0)
                )

        # _add_rast_ordering_constraints, and the only rast term there is: the
        # minutes a rast reserves cost no variables at all, while the demand for
        # a lesson before one costs two per lesson per day per asking rast — an
        # `inside` flag and a `late` one — plus a `still_here` literal per
        # class-day-rast. Charged at the payload's total lessons rather than per
        # class, which is an over-estimate for a school whose classes each own
        # their lessons and the right bound for one where a teaching group is
        # shared: the builder reads a class's lessons THROUGH the groups that
        # share its pupils, so the per-class sums can exceed the week's lessons.
        asking_rasts = sum(1 for rast in request.rasts if rast.requires_lesson_before)
        rast_order_vars = (
            asking_rasts * day_count * (2 * total_lessons + len(request.groups))
            # And the assumption literal that lets the refusal name the rule:
            # one per class for the whole week, not one per day.
            + (len(request.groups) if asking_rasts else 0)
        )

        # _add_distribution_constraints, charged per requirement that carries
        # either half of a rule, whether or not the rule can bind: the builder
        # skips a cap no day can reach, and an upper bound may count it anyway.
        # The day variable is charged again although the spread usually built
        # it, for the reason the idle term above gives for its own overlap.
        distribution_vars = sum(
            (day_count + 1) * requirement.lessons_per_week + 2 * day_count + 2
            for requirement in request.requirements
            if requirement.max_lessons_per_day is not None
            or requirement.min_days_between is not None
        )

        # _add_teacher_day_constraints and _add_free_day_objective, charged per
        # teacher with a lesson as if every day of every rule could bind: the
        # builders skip what cannot, and an upper bound may count it anyway.
        # The day literals are charged to each teacher though a co-taught
        # lesson's are one set for both, and the day variable though the
        # spread usually built it — the reasons the idle and distribution
        # terms above give for their own overlaps. A teacher whose rest rule
        # built the day reuses its literals and pays here for nothing it adds.
        # A post's weeks (lockedWeekdays) are rows under its one literal and
        # add no variable: every `works` they count is charged here already.
        ruled = {
            rule.teacher_id
            for rule in request.teacher_work_rules
            if rule.max_teaching_minutes_per_day is not None
        } | {limit.teacher_id for limit in request.teacher_day_limits}
        teacher_day_vars = sum(
            (day_count + 1) * lessons_by_teacher[teacher_id] + 2 * day_count
            for teacher_id in ruled
            if lessons_by_teacher.get(teacher_id, 0) > 0
        )
        for rule in request.teacher_work_rules:
            if lessons_by_teacher.get(rule.teacher_id, 0) == 0:
                continue
            if rule.max_teaching_minutes_per_day is not None:
                teacher_day_vars += day_count
            if rule.preferred_free_day is not None:
                teacher_day_vars += 1
        teacher_day_vars += sum(
            1
            for limit in request.teacher_day_limits
            if lessons_by_teacher.get(limit.teacher_id, 0) > 0
        )

        # The walk's own variables (travel.py), at their worst case: every
        # lesson a choice of every site and every row stretched over the
        # night, which the domains almost never ask for. "Every site" counts
        # the rooms on no counted site as one more: a lesson with two classes
        # there gets a literal for it too (travel.site_choices).
        travel_vars = (
            total_lessons * (
                len(set(travel.site_of_room.values()))
                + any(room.id not in travel.site_of_room for room in request.rooms)
            )
            + 2 * total_lessons
            + len(lessons_by_teacher)
            # A literal per pupils' family: one per PUPIL-space group
            # (travel.families_of), which a derived key adds to the classes.
            + len({pupil_key_of(requirement) for requirement in request.requirements})
            + len(request.group_conflicts)
            if travel is not None
            else 0
        )

        return (
            4 * total_lessons
            + room_class_vars
            + travel_vars
            + affected_vars
            + (1 + day_count) * total_lessons
            + daily_count_vars
            + day_count * lunch_groups
            + lunch_lock_vars
            + lunch_closure_vars
            # One literal per meal the school placed by hand.
            + len(request.lunch_placements)
            + lunch_drift_vars
            + dining_vars
            + spread_pairs
            + idle_vars
            + teacher_work_vars
            + rast_order_vars
            + distribution_vars
            + teacher_day_vars
            # _add_block_constraints: one literal per block. Its equalities are
            # constraints on starts that exist already, and add no variable.
            + len(_blocks_of(request.requirements))
            + 2 * len(request.previous_lessons)
        )

    def _validate_request(self, request: OptimizeScheduleRequest) -> None:
        if not request.requirements:
            raise InvalidScheduleInputError.of("INPUT_NO_REQUIREMENTS")
        if not request.rooms:
            raise InvalidScheduleInputError.of("INPUT_NO_ROOMS")
        # ONE ID, ONE REQUIREMENT. Every reader of the week keys a requirement
        # by its id: the builder's start domains (_create_lesson_decisions, the
        # last row wins), the hours verdict's reach (_teacher_rooms, the first
        # wins), every lesson's key. Two rows sharing an id would be two
        # different weeks to two readers of one payload. The gateway mints each
        # id with randomUUID and never sends one twice, so a payload that does
        # is not one this engine can answer, and it is refused by name.
        seen: set[UUID] = set()
        for requirement in request.requirements:
            if requirement.id in seen:
                raise InvalidScheduleInputError.of("INPUT_DUPLICATE_REQUIREMENT_ID", {
                    "requirement": str(requirement.id),
                })
            seen.add(requirement.id)

        # Aggregate complexity budget — reject oversized models before building.
        total_lessons = sum(r.lessons_per_week for r in request.requirements)
        if total_lessons > self.MAX_LESSON_INSTANCES:
            raise InvalidScheduleInputError.of("INPUT_TOO_MANY_LESSONS", {
                "lessons": total_lessons, "limit": self.MAX_LESSON_INSTANCES,
            })

        estimated_size = self._estimate_model_size(request)
        if estimated_size > self.MAX_MODEL_COMPLEXITY:
            raise InvalidScheduleInputError.of("INPUT_MODEL_TOO_LARGE", {
                "variables": estimated_size, "limit": self.MAX_MODEL_COMPLEXITY,
            })

        # Resolved once for the whole request: the same map _add_room_allocation
        # builds, so a refusal here describes the model that would have been
        # built rather than a second reading of the same rows.
        locked_by_requirement = resolve_room_locks(
            request.requirements, request.room_preferences, request.rooms,
        )

        for requirement in request.requirements:
            # A duration that does not land on the grid is bad INPUT, not a
            # broken solver. `minutes_to_slots` signals it with a bare
            # ValueError, which nothing above catches — so a 40-minute lesson on
            # a 15-minute grid escaped as an unhandled exception and reached the
            # caller as a 500 with a stack trace, while the very next check in
            # this loop reports a too-long lesson as a clean 4xx. Same field,
            # same loop, two different fates.
            #
            # EVERY LENGTH OF THE REQUIREMENT, longest first, so a uniform one
            # is asked exactly what it always was and a split one names the
            # length that misses the grid rather than the one that does not.
            for minutes in sorted(set(requirement.lesson_minutes()), reverse=True):
                try:
                    self._grid.minutes_to_slots(minutes)
                except ValueError as error:
                    raise InvalidScheduleInputError.of("INPUT_LESSON_LENGTH_OFF_GRID", {
                        "requirement": str(requirement.id),
                        "minutes": minutes,
                        "slotMinutes": self._grid.slot_minutes,
                    }) from error
            # The longest is the one every check below measures: a frame, a
            # margin or a rast that holds it holds every shorter lesson too.
            duration_slots = self._grid.minutes_to_slots(requirement.minutes_per_lesson)
            if duration_slots > self._grid.slots_per_day:
                raise InvalidScheduleInputError.of("INPUT_LESSON_LONGER_THAN_DAY", {
                    "requirement": str(requirement.id),
                    "minutes": requirement.minutes_per_lesson,
                })

            # A frame narrows the start domain, and a domain can be narrowed to
            # nothing. Left to CP-SAT that is an ordinary INFEASIBLE with no
            # assumption to blame — the model simply has no variable to report —
            # so the school is told its timetable is impossible and not which
            # sentence made it so. Caught here it names the requirement, the
            # window that remains, and the lesson length that will not fit.
            if request.frame_times:
                windows = day_windows(request.frame_times, span_of(requirement), self._grid)
                widest = max(
                    (close - open_slot for open_slot, close in windows.values()),
                    default=0,
                )
                if widest < duration_slots:
                    grades = (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    )
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("FRAME_NO_WINDOW_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "remaining": remaining,
                    })

            # AND THE MARGINS ROUND THE LESSON, which the check above does not
            # count. It asks whether the WINDOW holds the lesson; the domain the
            # model then builds pushes the first start forward by the pupils'
            # leading buffer and pulls the last one back by their trailing one
            # and the corridor, because neither margin may cross into a
            # neighbouring day (_build_decisions argues both clips there). So a
            # window exactly as wide as the lesson passes the frame check and
            # empties the domain anyway — and an empty domain is not even an
            # INFEASIBLE with a core: CP-SAT raises `var #0 has no domain()`,
            # which became a SolverBuildError and reached the school as a 500
            # with nothing in it to act on. The corridor alone could do it
            # wherever a frame reached the day's end, which is older than the
            # pupils' buffer; the buffer widens the trigger to any window that
            # opens on the day's first slot.
            #
            # BEFORE THE RASTS, in the order the model itself empties the
            # domain: the day ranges are cut from the windows and these margins,
            # and only then do the rasts intersect what is left. A margin that
            # has already left no day to start on is the earlier fact.
            #
            # The arithmetic is _build_decisions', deliberately down to the
            # rounding: a second rule here would eventually disagree with the
            # model about which days it kept, and this refusal would either
            # refuse a week that would have solved or let the 500 back through.
            span = span_of(requirement)
            changeover = changeover_slots(request.frame_times, span, self._grid)
            lead = -(-requirement.minutes_before // self._grid.slot_minutes)
            trail = -(-requirement.minutes_after // self._grid.slot_minutes)
            # Skipped when every margin is zero, and not merely as an economy:
            # with no margins this asks exactly what the frame check above asked,
            # and the sentence would blame margins of zero for a window that is
            # simply too narrow for the lesson.
            if lead or trail or changeover:
                widest = 0
                for open_slot, close_slot in day_windows(
                    request.frame_times, span, self._grid,
                ).values():
                    first = max(open_slot, lead)
                    last = min(
                        close_slot, self._grid.slots_per_day - changeover - trail,
                    )
                    widest = max(widest, last - first)
                if widest < duration_slots:
                    grades = (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    )
                    # What a day still leaves for the LESSON once the margins
                    # have taken theirs — not the window, which the frame check
                    # already reports and which this school's window may be
                    # perfectly good.
                    #
                    # THE MARGINS ARE REPORTED AS THE GRID ROUNDS THEM, not as
                    # they were typed: seven minutes before on a five-minute grid
                    # takes ten, and ten is what leaves the window. Written the
                    # other way the sentence's own numbers would not add up to
                    # the window a school can measure them against — and the
                    # rounded figure is the one it has to get under.
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("MARGIN_NO_WINDOW_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "before": lead * self._grid.slot_minutes,
                        "after": trail * self._grid.slot_minutes,
                        "changeover": changeover * self._grid.slot_minutes,
                        "remaining": remaining,
                    })

            # And a rast cuts holes in the same domain, so it can empty it the
            # same way — worse, in fact: a frame leaves one narrow window, while
            # rasts can leave several fragments none of which holds the lesson.
            # An empty domain is a proof CP-SAT reaches without touching a
            # single assumption literal, and an empty conflict core erases every
            # other cause in the payload; the school is handed
            # INSUFFICIENT_RESOURCES for a sentence it wrote itself.
            #
            # ONLY THE DAYS THE FRAMES LEAVE OPEN. A day the frames close is
            # absent from day_windows, and this loop used to read it with a
            # default of the whole day — so the one day whose rasts left room
            # was counted although no lesson could ever start on it. A fuzz of
            # the engine found the week: six days 08:00-10:00, a 70-minute
            # year-8 lesson, a year-8 frame closing Monday and a Monday rast
            # that leaves 08:50-10:00 there, while every other day's longest
            # stretch is 60 minutes. Accepted here, the builder made an empty
            # domain, CP-SAT answered MODEL_INVALID and the school read a 500
            # quoting a variable named after the requirement's id. A stage no
            # frame reaches has every day there, whole, so a school without
            # frames is asked what it always was.
            #
            # AND WITH THE MARGINS, in a second reading of the same days. The
            # builder clips each open day by the margins first and lets the
            # rasts cut what is left, so a stretch the rasts leave at the day's
            # edge can be longer than the lesson and still too short once the
            # pupils' buffer or the corridor has taken its minutes there: the
            # fuzz's other week was 08:00-12:00, a 120-minute lesson with 15
            # minutes after it and a rast 09:45-09:55, whose 125 minutes after
            # the rast hold 110 for the lesson. Neither check alone refuses
            # it — the window holds the margins, the stretch holds the lesson —
            # and the composition is the empty domain all the same. Read
            # without margins, `with_margins` IS `widest`, so a week with none
            # is asked exactly what it always was.
            if request.rasts:
                span = span_of(requirement)
                windows = day_windows(request.frame_times, span, self._grid)
                widest = 0
                with_margins = 0
                for day_index, (open_slot, close_slot) in sorted(windows.items()):
                    blocks = blocks_for(
                        request.rasts, span, self._grid.schedule_days[day_index], self._grid,
                    )
                    widest = max(
                        widest,
                        _widest_free_run(open_slot, close_slot, blocks),
                    )
                    # _start_domains' clip, down to the rounding, for the reason
                    # the margins' refusal above gives for sharing it.
                    with_margins = max(
                        with_margins,
                        _widest_free_run(
                            max(open_slot, lead),
                            min(close_slot, self._grid.slots_per_day - changeover - trail),
                            blocks,
                        ),
                    )
                grades = (
                    "any"
                    if requirement.min_grade_level is None
                    else _grade_span_text(
                        requirement.min_grade_level, requirement.max_grade_level,
                    )
                )
                # Whether a frame closes or narrows any of the stage's days, so
                # both sentences below offer the frame time only where there is
                # one to widen. Without one the rasts cut the configured day,
                # which no school row moves.
                framed = int(windows != {
                    day_index: (0, self._grid.slots_per_day)
                    for day_index in range(len(self._grid.schedule_days))
                })
                if widest < duration_slots:
                    remaining = widest * self._grid.slot_minutes
                    raise InvalidScheduleInputError.of("RAST_NO_STRETCH_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "remaining": remaining,
                        "framed": framed,
                    })
                # Its own sentence, as the margins have one beside the frames'.
                # Folded into the one above, that sentence would tell the school
                # its rasts leave 110 minutes where it can measure 125, and send
                # it to shorten a rast when the fifteen minutes after the lesson
                # are the other half of the cause.
                if with_margins < duration_slots:
                    raise InvalidScheduleInputError.of("RAST_MARGIN_NO_STRETCH_FOR_REQUIREMENT", {
                        "requirement": str(requirement.id),
                        "grades": grades,
                        "minutes": requirement.minutes_per_lesson,
                        "before": lead * self._grid.slot_minutes,
                        "after": trail * self._grid.slot_minutes,
                        "changeover": changeover * self._grid.slot_minutes,
                        "remaining": with_margins * self._grid.slot_minutes,
                        "framed": framed,
                    })

            grades = (
                "any"
                if requirement.min_grade_level is None
                else _grade_span_text(
                    requirement.min_grade_level, requirement.max_grade_level,
                )
            )
            eligible_rooms = [
                room for room in request.rooms if self._room_allowed(room, requirement)
            ]
            if not eligible_rooms:
                raise InvalidScheduleInputError.of("ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT", {
                    "requirement": str(requirement.id),
                    "groupSize": requirement.student_group_size,
                    "roomType": str(requirement.required_room_type or "any"),
                    "grades": grades,
                })

            # THE LOCK GETS ITS OWN SENTENCE, and the branch is the point. The
            # message above sends a school to the room list to change a seat
            # count or a stage limit; a school whose maths is locked into a room
            # too small wrote that rule on another screen entirely, and would
            # read the sentence above and change the wrong thing.
            #
            # Checked after the general refusal so the more basic cause wins:
            # a requirement with no eligible room AT ALL has a problem the lock
            # did not create.
            locked_rooms = locked_by_requirement.get(requirement.id)
            if locked_rooms is not None:
                survivors = [
                    room for room in eligible_rooms if room.id in locked_rooms
                ]
                if not survivors:
                    raise InvalidScheduleInputError.of("ROOM_LOCK_LEAVES_NO_ROOM", {
                        "requirement": str(requirement.id), "grades": grades,
                    })

        # ÄMNESFÖRDELNING, per requirement and after the per-requirement checks
        # above, which name the more basic cause: a lesson with no window at all
        # is not a distribution problem. Before the week-wide verdicts below,
        # because "four lessons do not fit on five days without consecutive
        # days" is a contradiction inside ONE row, fixed on that row.
        self._verify_subject_distribution(request)

        # PARALLELLA BLOCK, for the same reason and in the same place: a block
        # whose members differ, share a teacher or share pupils, or have no
        # start in common, is a contradiction inside the block, and the model
        # it would build is INFEASIBLE with nothing to say why. After the
        # per-requirement checks, which name a member's own problem first.
        self._validate_blocks(request)

        # THE BREAKS THAT ASK FOR A LESSON, before any of the counting below:
        # a demand no stretch can hold is a contradiction between two of the
        # school's own sentences, and every verdict that follows would be
        # measuring a week the solver is about to be told to empty.
        self._verify_rast_demands(request)

        # THE TEACHERS' OWN LUNCH AND REST, whose refusals are arithmetic on
        # constants and belong here for the reason every refusal below gives: a
        # narrowed domain that turns out empty is a proof CP-SAT reaches without
        # touching one assumption literal, and the empty conflict core that
        # follows takes every other cause in the payload down with it.
        #
        # BEFORE THE LUNCH BLOCK BELOW, which returns early for a school that has
        # not set a lunch window. A teacher's own break has nothing to do with
        # the pupils' one, and behind that return a school with teacher rules and
        # no school-wide lunch would never have been told a thing.
        self._verify_teacher_work_rules(request)

        # LÄRARENS DAG, beside the work rules and for their reason: a cap no
        # day can hold, or days too few for the week, is arithmetic on
        # constants, and the model would otherwise refuse it with a core about
        # every teacher's every day. Also before the lunch block's early
        # return, which a school without a pupils' lunch would never get past.
        self._verify_teacher_day_rules(request)

        # THE WEEK, not the lesson. Every locked requirement above can have a
        # room and the set of them still not fit: three subjects locked into one
        # room, forty lessons each, against a week that holds fifty. Left to
        # CP-SAT that is an ordinary INFEASIBLE whose core names room capacity —
        # sending a school to the seat counts for a rule it wrote elsewhere.
        #
        # The bound is lesson-slots against room-slots, which is the room
        # NoOverlap's own relaxation, so violating it proves infeasibility and
        # refusing here can never refuse a week that would have worked. It
        # ignores frame times and availability, which only ever shrink the
        # supply — so it under-refuses and never over-refuses.
        by_locked_rooms: dict[frozenset[UUID], list[AnonymousRequirement]] = defaultdict(
            list,
        )
        for requirement in request.requirements:
            rooms_allowed = locked_by_requirement.get(requirement.id)
            if rooms_allowed:
                by_locked_rooms[rooms_allowed].append(requirement)

        slots_per_day = self._grid.slots_per_day
        days = len(self._grid.schedule_days)
        for rooms_allowed, group in by_locked_rooms.items():
            # Every requirement here is captive to this set by construction:
            # specificity resolution gives each ONE resolved room set, so there
            # is no choice to protect against and no requirement to exclude.
            # An earlier version filtered on base eligibility instead, which
            # asked whether the requirement could use an unlocked room — and the
            # answer is yes for exactly the requirements the lock has just taken
            # that option away from, so nothing was ever charged.
            needed = sum(
                self._grid.minutes_to_slots(minutes)
                for requirement in group
                for minutes in requirement.lesson_minutes()
            )
            # Rooms that at least one of them could actually use. A locked room
            # too small for every requirement in the group supplies nothing, and
            # counting it would hide the very shortage this refuses.
            usable = sum(
                1
                for room in request.rooms
                if room.id in rooms_allowed
                and any(self._room_allowed(room, r) for r in group)
            )
            available = usable * days * slots_per_day
            if needed > available:
                minutes = self._grid.slot_minutes
                raise InvalidScheduleInputError.of("ROOM_LOCK_WEEK_TOO_SMALL", {
                    "requirements": len(group),
                    "rooms": usable,
                    "neededMinutes": needed * minutes,
                    "offeredMinutes": available * minutes,
                })

        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules):
            # Nothing below exists without a lunch window. A school that has
            # typed a seat count and not yet decided when lunch is has made no
            # error and must not be told it has.
            return

        window_start, window_end, lunch_slots = self._lunch_window_slots(rules)

        if rules.dining_seats is not None and request.groups:
            # One class that does not fit in the hall makes the cumulative
            # unsatisfiable on every day of the week, whatever else the
            # timetable does. CP-SAT would spend the whole budget proving that
            # and answer INFEASIBLE without naming a class or a number.
            #
            # Reads `groups`, the same list the cumulative's demands come from.
            # Reading the requirements instead is exactly how a class whose
            # week is entirely locked slipped past both. The largest class is
            # named rather than the first one over, because its headcount is
            # the number the hall has to reach.
            largest = max(request.groups, key=lambda group: group.lunch_headcount)
            if largest.lunch_headcount > rules.dining_seats:
                raise InvalidScheduleInputError.of("LUNCH_GROUP_LARGER_THAN_HALL", {
                    "group": str(largest.id),
                    "students": largest.lunch_headcount,
                    "seats": rules.dining_seats,
                })

        # Whether locked lessons leave a group any admissible lunch start is
        # arithmetic on constants — no search decides it. Left to the model it
        # becomes an empty variable domain, and an empty domain is a proof of
        # infeasibility CP-SAT can reach without touching one assumption
        # literal, which returns an empty conflict core and takes every other
        # cause in the payload down with it. Answering here spends no solve
        # budget and names the group and the day.
        #
        # The same window arithmetic and the same reachability rule the builder
        # uses, through the same two helpers — a second rounding rule here
        # would eventually disagree with the model about when lunch is. The
        # groups that get a break are knowable without building anything:
        # every requirement carries lessons_per_week >= 1, so each one's group
        # is in `by_group` there exactly as it is in this list here.
        lunch_group_ids = _lunch_group_ids(
            request.groups, _group_ids_with_lessons(request.requirements),
        )
        blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
            request.fixed_lessons,
            set(lunch_group_ids),
            _groups_sharing_students(request.group_conflicts),
            window_start,
            window_end - lunch_slots,
            lunch_slots,
        )
        slots_per_day = self._grid.slots_per_day
        # Computed before either loop: an exempt day is one the school has said
        # the class is not in, and neither a locked lesson nor another rule can
        # deny it a meal it was never owed.
        closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
            request.constraints,
            set(lunch_group_ids),
            window_start,
            window_end - lunch_slots,
            window_end,
            lunch_slots,
        )
        # THE MEALS THE SCHOOL PLACED BY HAND, before any check that would
        # refuse the day they rescue. Then every lunch refusal below skips a
        # pinned day, and the skip list is the feature: miss one and a school
        # that drew its meal to escape "locked lessons leave 4.1 no lunch gap"
        # is refused by the NEXT loop for the same class on the same day —
        # the worst thing this can do, and the default if a loop is added
        # later without it. Five places: the locks, the sitting, the captive
        # count, the reservations and the four sources together.
        pins = self._verify_lunch_placements(
            request, lunch_group_ids, exempt_days, lunch_slots,
        )
        for (group_id, day_index), forbidden in blocked_starts.items():
            if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                continue
            allowed = self._admissible_lunch_starts(
                day_index * slots_per_day,
                window_start,
                window_end,
                lunch_slots,
                forbidden,
            )
            if allowed.is_empty():
                raise InvalidScheduleInputError.of("LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK", {
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": self._grid.schedule_days[day_index],
                })

        # The declarations, before either subtraction: a serving or a frame too
        # tight to hold the break empties the domain outright, and an empty
        # domain is a proof CP-SAT reaches without touching one assumption
        # literal — an empty conflict core that takes every other cause in the
        # payload down with it.
        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }
        if request.lunch_servings or request.frame_times:
            for group_id in lunch_group_ids:
                for day_index, day_of_week in enumerate(self._grid.schedule_days):
                    if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                        continue
                    declared = self._declared_lunch_domain(
                        request.lunch_servings,
                        request.frame_times,
                        span_by_group.get(group_id),
                        day_of_week,
                        day_index * slots_per_day,
                        window_start,
                        window_end,
                        lunch_slots,
                    )
                    if declared is not None and declared.is_empty():
                        raise InvalidScheduleInputError.of("LUNCH_NO_SERVING_FOR_GROUP", {
                            "group": str(group_id),
                            "minutes": rules.lunch_minutes,
                            "day": day_of_week,
                        })

        # Can the declared sittings physically feed the stages that must use
        # them? A window wide enough to hold ONE meal can still be far too small
        # for a stage's whole headcount, and that failure lands in the seat
        # cumulative — an INFEASIBLE with no assumption to name, on a payload
        # whose windows all look reasonable.
        #
        # The bound is student-minutes, which is the cumulative's own
        # relaxation: over a window of W minutes with S chairs, at most S x W
        # student-minutes can be served, and a stage of N children eating for L
        # minutes needs N x L. Violating it proves infeasibility, so refusing
        # here can never refuse a flow that would have worked.
        #
        # Counted only for groups this serving is the ONLY one open to. A group
        # with a choice of sittings could go to the other one, and charging it
        # to both would refuse schools whose overlapping windows are exactly how
        # they cope.
        if request.lunch_servings and rules.dining_seats is not None:
            headcount_by_group = _lunch_headcounts(request.groups)
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                applicable: dict[UUID, list[LunchServing]] = {}
                for group_id in lunch_group_ids:
                    # A pinned class eats where it was placed, not in this
                    # sitting, and counting it here would refuse a flow that
                    # works.
                    if (group_id, day_index) in exempt_days or (group_id, day_index) in pins:
                        continue
                    matching = _servings_for(
                        request.lunch_servings, span_by_group.get(group_id), day_of_week,
                    )
                    if matching:
                        applicable[group_id] = matching

                for serving in request.lunch_servings:
                    captive = sum(
                        headcount_by_group.get(group_id, 0)
                        for group_id, options in applicable.items()
                        if options == [serving]
                    )
                    if captive == 0:
                        continue
                    seats = serving.seats if serving.seats is not None else rules.dining_seats
                    minutes = _clock_minutes(serving.end_time) - _clock_minutes(
                        serving.start_time,
                    )
                    if captive * rules.lunch_minutes > seats * minutes:
                        raise InvalidScheduleInputError.of("LUNCH_SERVING_CANNOT_FEED_STAGE", {
                            "servingStart": serving.start_time[:5],
                            "servingEnd": serving.end_time[:5],
                            "grades": _grade_span_text(
                                serving.min_grade_level, serving.max_grade_level,
                            ),
                            "students": captive,
                            "minutes": rules.lunch_minutes,
                            "seats": seats,
                        })

        # The same question of the school's own reservations. Separate loop and
        # separate sentence: a lesson to move and a rule to change are fixed in
        # two different screens, and one message covering both would send half
        # the schools to the wrong one.
        for (group_id, day_index), closed in closed_starts.items():
            if (group_id, day_index) in pins:
                continue
            allowed = self._admissible_lunch_starts(
                day_index * slots_per_day,
                window_start,
                window_end,
                lunch_slots,
                closed,
            )
            if allowed.is_empty():
                raise InvalidScheduleInputError.of("LUNCH_AVAILABILITY_LEAVES_NO_BREAK", {
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": self._grid.schedule_days[day_index],
                })

        # ALL FOUR SOURCES TOGETHER, last, because each can leave room on its own
        # while the intersection is empty. A locked lesson over the first half
        # of a sitting and a frame closing the second half is the ordinary way
        # to get there, and no single-cause loop above says a word about it.
        #
        # Left to the model this is an empty variable domain — a proof CP-SAT
        # reaches without touching an assumption literal. It does produce a
        # conflict analysis here, because the locked-lesson literal happens to
        # be in the core, but that is luck: it names one contributor of four and
        # arrives as INFEASIBLE rather than as something to fix.
        for group_id in lunch_group_ids:
            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                key = (group_id, day_index)
                if key in exempt_days or key in pins:
                    continue
                allowed = self._admissible_lunch_starts(
                    day_index * slots_per_day,
                    window_start,
                    window_end,
                    lunch_slots,
                    blocked_starts.get(key, []) + closed_starts.get(key, []),
                )
                declared = self._declared_lunch_domain(
                    request.lunch_servings,
                    request.frame_times,
                    span_by_group.get(group_id),
                    day_of_week,
                    day_index * slots_per_day,
                    window_start,
                    window_end,
                    lunch_slots,
                )
                if declared is not None:
                    allowed = allowed.intersection_with(declared)
                if not allowed.is_empty():
                    continue

                # Name what is actually in play, so the sentence sends the
                # reader to the screen that holds the fix. As ONE key rather
                # than a joined list: "locked lessons and availability rules"
                # is an English list, and a language that inflects the members
                # cannot be handed it already punctuated. The sentence branches
                # on the key instead, in whatever language reads it.
                causes: list[str] = []
                if blocked_starts.get(key):
                    causes.append("locked")
                if closed_starts.get(key):
                    causes.append("closed")
                if declared is not None:
                    causes.append("declared")
                raise InvalidScheduleInputError.of("LUNCH_CAUSES_LEAVE_NO_BREAK", {
                    "causes": "_".join(causes),
                    "group": str(group_id),
                    "minutes": rules.lunch_minutes,
                    "windowStart": rules.lunch_start_time[:5],
                    "windowEnd": rules.lunch_end_time[:5],
                    "day": day_of_week,
                })

    def _validate_blocks(self, request: OptimizeScheduleRequest) -> None:
        """Refuse by name a block the model could only call INFEASIBLE.

        Each check is a pair of members that cannot start together whatever
        the rest of the week is, so each is decided here on constants, and the
        refusal names the block and the two members — "Språkval åk 7: Tyska
        för Ty7 and Franska för Fr7 share pupils" — where the model would have
        proved the week impossible with an empty core.

        THE SAME LESSONS (BLOCK_MEMBERS_DIFFER). The k-th lessons start
        together, so they must be as long as each other and as many. The
        gateway refuses a block like that when it is written (409) and when a
        lock leaves members with different lessons to place
        (BLOCK_PARTLY_LOCKED); this holds the engine to it whatever a caller
        sends.

        NO TEACHER IN TWO MEMBERS (BLOCK_MEMBERS_SHARE_TEACHER), lead or
        co-teacher: one body, two rooms, the same minute.

        NO PUPIL IN TWO MEMBERS (BLOCK_MEMBERS_SHARE_PUPILS): two members on
        one group, or a pair the gateway's groupConflicts says share a pupil —
        read in the PUPIL space (pupil_key_of), as the no-overlap that would
        otherwise make the block impossible is posted. SvA beside class
        svenska is the case a school meets first, and Ersättande grupper
        settled it: an SvA pupil leaves class svenska. Once the gateway sends
        7A's svenska with its pupilGroupId ("7A without SvA7", never paired
        with SvA7), the two members share no pupil, the block is accepted and
        their lessons start together. Sent without it, 7A's svenska is all of
        7A's and 7A pairs SvA7, and the block is refused as before: a block is
        still not the place to decide that a pupil may be in two rooms.

        A START IN COMMON (BLOCK_NO_COMMON_START). Each member's starts are
        its own domain — frames, rasts, margins, the week's step — and the
        block's are their intersection, computed by the builder's own
        _start_domains so the two cannot disagree. Members in different years
        can have frames that never meet.
        """
        blocks = _blocks_of(request.requirements)
        if not blocks:
            return
        conflicts = {frozenset(pair) for pair in request.group_conflicts}
        step = _start_step(request, self._grid)
        lattice = _start_lattice(step, self._grid.horizon)
        for block_id, members in blocks.items():
            leader = members[0]
            for member in members[1:]:
                if member.lesson_minutes() != leader.lesson_minutes():
                    raise InvalidScheduleInputError.of("BLOCK_MEMBERS_DIFFER", {
                        "block": str(block_id),
                        "requirement": str(member.id),
                        "other": str(leader.id),
                    })
            for index, first in enumerate(members):
                for second in members[index + 1:]:
                    if set(_teachers_of(first)) & set(_teachers_of(second)):
                        raise InvalidScheduleInputError.of("BLOCK_MEMBERS_SHARE_TEACHER", {
                            "block": str(block_id),
                            "requirement": str(first.id),
                            "other": str(second.id),
                        })
                    first_pupils, second_pupils = pupil_key_of(first), pupil_key_of(second)
                    if (
                        first_pupils == second_pupils
                        or frozenset((first_pupils, second_pupils)) in conflicts
                    ):
                        raise InvalidScheduleInputError.of("BLOCK_MEMBERS_SHARE_PUPILS", {
                            "block": str(block_id),
                            "requirement": str(first.id),
                            "other": str(second.id),
                        })
            common = _common_domains([
                self._start_domains(member, request.frame_times, request.rasts, lattice)
                for member in members
            ])
            for duration in sorted(common, reverse=True):
                if common[duration].is_empty():
                    raise InvalidScheduleInputError.of("BLOCK_NO_COMMON_START", {
                        "block": str(block_id),
                        "minutes": duration * self._grid.slot_minutes,
                    })

    def _verify_subject_distribution(self, request: OptimizeScheduleRequest) -> None:
        """Refuse a requirement whose lessons cannot be spread as its rule asks.

        COUNTING, NOT SEARCH. A rule of at most N a day over D days holds at
        most N x D lessons; "not on consecutive days" holds at most the best
        choice of days no two of which are neighbours. Both are arithmetic on
        constants, and a week that breaks them is refused here, in
        microseconds, with the requirement, its lessons and its days named —
        "Idrott för 7A: 4 lektioner ryms inte på de 5 dagar ..." — where the
        model would have spent its budget finding the same thing out and
        reported it as one cause among a core.

        WITHOUT A CAP THERE IS NOTHING TO COUNT. "Not on consecutive days" on
        its own is kept by putting every lesson on one day, so a rule with no
        maximum a day never refuses here; whether one day can HOLD them all is
        a question about hours, and the model answers it under the rule's own
        literal.

        AN UPPER BOUND, SO IT NEVER REFUSES A WEEK THAT WOULD HAVE WORKED. The
        days counted are the ones the requirement could start a lesson on at
        all — the builder's own arithmetic for frames and margins, see
        _distribution_days — and every other rule only takes more away. What
        is locked counts as the builder counts it: a day's cap less what the
        school placed there, and no day next to a locked one under the
        days-apart rule.
        """
        weekdays = self._grid.schedule_days
        for requirement in request.requirements:
            per_day = requirement.max_lessons_per_day
            if per_day is None:
                continue
            apart = requirement.min_days_between
            locked = Counter(requirement.locked_days)
            open_days = self._distribution_days(request, requirement)
            caps: list[tuple[int, int]] = []
            for day_index in open_days:
                weekday = weekdays[day_index]
                if apart is not None and any(
                    0 < abs(weekday - other) < apart for other in locked
                ):
                    continue
                caps.append((weekday, max(0, per_day - locked[weekday])))
            if _spaced_capacity(caps, apart) >= requirement.lessons_per_week:
                continue
            raise InvalidScheduleInputError.of("SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT", {
                "requirement": str(requirement.id),
                # The week's lessons as the school counts them: what the
                # solver places and what is locked, since a school reads "4"
                # off the timplan and not off the payload.
                "lessons": requirement.lessons_per_week + len(requirement.locked_days),
                "days": len(open_days),
                "maxPerDay": per_day,
                "minDaysBetween": apart or 0,
                "locked": len(requirement.locked_days),
            })

    def _distribution_days(
        self, request: OptimizeScheduleRequest, requirement: AnonymousRequirement,
    ) -> list[int]:
        """Day indices on which the requirement could start a lesson at all.

        The builder's arithmetic, down to the rounding: a day is open when the
        stage's frame leaves a window, and that window still holds the SHORTEST
        lesson once the pupils' margins and the corridor have taken theirs —
        _create_lesson_decisions drops exactly the other days. And a day a
        recurring closure takes whole is shut too: a teacher who does not work
        Fridays, a class that is not taught on Tuesdays, a stage held free. A
        school with a part-time idrottslärare is the ordinary case of a rule
        that does not fit, and "5 days" in that sentence would be a number the
        reader cannot find in their week.

        THE RASTS ARE NOT SUBTRACTED, and neither are rooms or locked lessons.
        Each can only make a day harder to use, so counting the day anyway
        keeps this an upper bound: the pre-flight then lets a week through
        that the model refuses under the rule's literal, and never the other
        way round.
        """
        slot = self._grid.slot_minutes
        slots_per_day = self._grid.slots_per_day
        span = span_of(requirement)
        changeover = changeover_slots(request.frame_times, span, self._grid)
        lead = -(-requirement.minutes_before // slot)
        trail = -(-requirement.minutes_after // slot)
        shortest = self._grid.minutes_to_slots(requirement.shortest_lesson_minutes())

        # Closed ranges per day, in day-relative slots, from every recurring
        # UNAVAILABLE row that reaches every lesson of the requirement. A ROOM
        # row reaches a lesson only through the room it is given, so it never
        # closes a day for the requirement; and a TEACHER row only when the
        # teacher is on every lesson (_teachers_on_every_lesson) — a split
        # post's Friday that Bertil does not work is still Anna's Friday, and
        # the day stays open, which is the direction an upper bound may err.
        closed: dict[int, list[tuple[int, int]]] = defaultdict(list)
        teachers = _teachers_on_every_lesson(requirement)
        for constraint in request.constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.resource_kind == "TEACHER":
                reaches = constraint.resource_id in teachers
            elif constraint.resource_kind == "STUDENT_GROUP":
                reaches = constraint.resource_id == requirement.student_group_id
            elif constraint.resource_kind == "GRADE_LEVEL":
                reaches = _grade_span_overlaps(constraint, requirement)
            else:
                reaches = False
            if not reaches:
                continue
            try:
                ranges = self._grid.window_to_absolute_range(
                    constraint.day_of_week, constraint.start_time, constraint.end_time,
                )
            except ValueError:
                # Unreadable here is refused by name when the model is built;
                # counting the day as open keeps this an upper bound meanwhile.
                continue
            for low, high in ranges:
                day_index = low // slots_per_day
                base = day_index * slots_per_day
                closed[day_index].append((low - base, high - base))

        days: list[int] = []
        for day_index, (open_slot, close_slot) in sorted(
            day_windows(request.frame_times, span, self._grid).items(),
        ):
            first = max(open_slot, lead)
            last = min(close_slot, slots_per_day - changeover - trail) - shortest
            if last < first:
                continue
            # Every start from `first` to `last` overlaps a merged closure that
            # runs from at or before the first start to at or after the last
            # end: then no lesson of the requirement can be taught that day.
            if any(
                low <= first and high >= last + shortest
                for low, high in _merge_ranges(closed.get(day_index, []))
            ):
                continue
            days.append(day_index)
        return days

    def _verify_teacher_work_rules(self, request: OptimizeScheduleRequest) -> None:
        """The three refusals a teacher's own lunch and rest can be arithmetic.

        THE ORDER IS THE ROW'S OWN. The lunch window's arithmetic first, because
        a window narrower than the break it has to hold is a number the school
        typed and can read back on the same screen; then what the locked lessons
        and reservations leave of that window, which sends the reader somewhere
        else entirely; then the rest, which is a different field and the one a
        school is least likely to have got wrong. A school whose window is too
        narrow must not be handed a sentence about Tuesday's locked lessons
        first, and change the wrong thing.

        A RULE THAT REACHES NO LESSON IS SKIPPED WHOLE, matching
        _add_teacher_work_constraints: a teacher with nothing left for the solver
        to place has no variable either rule could bound, and refusing a week
        over a row that could not have changed it is the one mistake a pre-flight
        check must not make.

        COUNTED GENEROUSLY, as _verify_rast_demands argues: every one of these
        over-counts what the week offers, so a week that is merely tight goes to
        the solver and is refused there by name. The rest check ignores the
        teacher's locked lessons and every frame, both of which can only shorten
        the night it measures; the lunch checks read the window through the same
        grid the model does, because there the alternative to agreeing with the
        model is not a refused week but an empty domain and a 500.
        """
        rules = request.teacher_work_rules
        if not rules:
            return

        # Per lesson: a split post's lessons are each their own lead's
        # (_teachers_at), and Bertil's one 40 is not Anna's shortest lesson.
        # An unsplit post adds its lessons_per_week and its shortest lesson to
        # its lead and its co-teacher, as the per-requirement count did.
        lessons_by_teacher: dict[UUID, int] = {}
        shortest_by_teacher: dict[UUID, int] = {}
        for requirement in request.requirements:
            for lesson_index, minutes in enumerate(requirement.lesson_minutes()):
                duration = self._grid.minutes_to_slots(minutes)
                for teacher_id in _teachers_at(requirement, lesson_index):
                    lessons_by_teacher[teacher_id] = lessons_by_teacher.get(teacher_id, 0) + 1
                    shortest_by_teacher[teacher_id] = min(
                        shortest_by_teacher.get(teacher_id, duration), duration,
                    )

        slots_per_day = self._grid.slots_per_day
        day_count = len(self._grid.schedule_days)
        minutes = self._grid.slot_minutes
        reaching = [
            rule for rule in rules if lessons_by_teacher.get(rule.teacher_id, 0) > 0
        ]

        # The window against the break it has to hold.
        for rule in reaching:
            window = _teacher_lunch_slots(rule, self._grid)
            if window is None:
                continue
            window_start, window_end, lunch_slots = window
            if window_end - window_start < lunch_slots:
                raise InvalidScheduleInputError.of("TEACHER_LUNCH_WINDOW_TOO_NARROW", {
                    "rule": str(rule.id),
                    "minutes": rule.lunch_minutes,
                    "windowStart": rule.lunch_start_time[:5],
                    "windowEnd": rule.lunch_end_time[:5],
                    "remaining": max(0, window_end - window_start) * minutes,
                })

        # And what the locked lessons and the reservations leave of it, day by
        # day. The same two readers and the same subtraction the builder makes —
        # a second rounding rule here would eventually disagree with the model
        # about when a teacher may eat.
        if any(rule.has_lunch for rule in reaching):
            locked_busy = self._teacher_busy_from_locks(request.fixed_lessons)
            closed_busy = self._teacher_busy_from_constraints(request.constraints)
            for rule in reaching:
                window = _teacher_lunch_slots(rule, self._grid)
                if window is None:
                    continue
                window_start, window_end, lunch_slots = window
                for day_index, day_of_week in enumerate(self._grid.schedule_days):
                    day_offset = day_index * slots_per_day
                    key = (rule.teacher_id, day_index)
                    closed = closed_busy.get(key, [])
                    # A reservation over the whole window says the teacher is not
                    # here; the builder grants no break on such a day, so nothing
                    # can leave one too short.
                    if _covers(
                        closed, day_offset + window_start, day_offset + window_end,
                    ):
                        continue
                    locked = locked_busy.get(key, [])
                    # PER SOURCE, and not from `locked + closed`, because the
                    # `causes` key below names what the school has to go and
                    # change. Asking only whether the teacher HAS a lock or a
                    # reservation somewhere that day answers a different
                    # question: a locked lesson at 08:00 cannot take a lunch
                    # start away from a window that opens at 10:30, and naming
                    # it sends the rektor to move a lesson whose removal changes
                    # nothing. _forbidden_lunch_starts has already dropped the
                    # rows that rule out no admissible start, so its OUTPUT is
                    # the honest answer — which is what the group lunch's own
                    # causes read, from blocked_starts and closed_starts.
                    #
                    # Splitting the call changes no outcome: the helper is per
                    # interval and coalesces nothing, so two calls concatenated
                    # are the one call's list in another order, and the domain
                    # subtraction below is order-blind.
                    forbidden_by_source = [
                        (
                            name,
                            _forbidden_lunch_starts(
                                rows,
                                day_offset + window_start,
                                day_offset + window_end - lunch_slots,
                                lunch_slots,
                            ),
                        )
                        for name, rows in (("locked", locked), ("closed", closed))
                    ]
                    forbidden = [
                        band for _, bands in forbidden_by_source for band in bands
                    ]
                    if not forbidden:
                        continue
                    allowed = self._admissible_lunch_starts(
                        day_offset, window_start, window_end, lunch_slots, forbidden,
                    )
                    if not allowed.is_empty():
                        continue
                    # Which of the two it was, as ONE key rather than a joined
                    # list: "locked lessons and reservations" is an English list,
                    # and a language that inflects its members cannot be handed
                    # one already punctuated. The sentence branches on the key.
                    causes = [name for name, bands in forbidden_by_source if bands]
                    raise InvalidScheduleInputError.of("TEACHER_LUNCH_LEAVES_NO_START", {
                        "causes": "_".join(causes),
                        "rule": str(rule.id),
                        "minutes": rule.lunch_minutes,
                        "windowStart": rule.lunch_start_time[:5],
                        "windowEnd": rule.lunch_end_time[:5],
                        "day": day_of_week,
                    })

        # The rest against the longest night the week can offer.
        #
        # A week of one day has no pair of consecutive days and the builder adds
        # no constraint, so there is nothing to refuse.
        if day_count < 2:
            return
        for rule in reaching:
            if rule.min_daily_rest_minutes is None:
                continue
            rest_slots = -(-rule.min_daily_rest_minutes // minutes)
            shortest = shortest_by_teacher[rule.teacher_id]
            # The most favourable placement there is: the last lesson of one day
            # taken first thing in the morning, the first lesson of the next
            # taken as late as the day allows, and the teacher's SHORTEST lesson
            # in both places. Over the most favourable pair of days, which for a
            # school teaching Monday, Wednesday and Friday is a pair with two
            # nights in it.
            #
            # `pad + slots_per_day` is the whole distance between the same clock
            # time on the two days, which is what the rest is measured against:
            # the pad alone is the part of it the grid does not address, and
            # taking it for the night would refuse a week for want of the hours
            # the school teaches in.
            widest_night = (
                max(
                    _night_pad_slots(self._grid, day_index)
                    for day_index in range(day_count - 1)
                )
                + slots_per_day
            )
            longest_night = widest_night + (slots_per_day - shortest) - shortest
            if rest_slots <= longest_night:
                continue
            # THE ESCAPE, before refusing: a teacher who never teaches two days
            # in a row is never asked to rest between them. Whether their week
            # fits on the days that are not next to each other is counted
            # generously — every day filled to the brim with their shortest
            # lesson, frames, rooms and other teachers ignored — so this refuses
            # only a teacher whose lessons cannot possibly avoid a pair.
            per_day = slots_per_day // shortest
            if lessons_by_teacher[rule.teacher_id] <= -(-day_count // 2) * per_day:
                continue
            raise InvalidScheduleInputError.of("TEACHER_REST_LONGER_THAN_THE_NIGHT", {
                "rule": str(rule.id),
                "restMinutes": rule.min_daily_rest_minutes,
                "nightMinutes": max(0, longest_night) * minutes,
                "lessons": lessons_by_teacher[rule.teacher_id],
            })

    def _verify_teacher_day_rules(self, request: OptimizeScheduleRequest) -> None:
        """The three refusals Lärarens dag can be arithmetic.

        ON THE MINUTES STILL TO PLACE. A teacher's week here is what the solver
        has to put somewhere — the generated lessons they are on, as lead or
        co-teacher, each lesson once — and what is locked is a fact that
        only takes room away: from the cap on its own weekday, from the day it
        sits on. A teacher whose whole week is hand-placed has nothing to
        place, and is refused nothing, as the builder skips them.

        UPPER BOUNDS ONLY, so a week this refuses is a week no timetable
        exists for, and a week that is merely tight goes to the solver and is
        refused there under the rule's literal:

          a lesson longer than the cap fits on no day at all;
          the week's minutes against every school day's residual — the cap
          less what the teacher's locked lessons take that weekday — with
          rooms, frames and every other teacher ignored;
          the week's minutes against the N best days, a day holding at most
          the room the teacher's lessons can take there (_teaching_room: the
          frames, rasts and margins in the domains, less the locked lessons)
          and, under a cap, at most its residual. N is the limit or, in a
          week whose locks already sit on more of the grid's days, that many
          — and ANY week refuses, because the model holds every one
          (_week_sets). In a week with locks on L the solver's lessons take
          the grid days of L and at most max(0, N − |L|) more, which is no
          more than max(N, |L ∩ grid|) days and no more than the grid has;
          taking the BEST that many days, locked or not, can only overcount.
          The week with the fewest locked grid days is the one that can tip,
          so it is the one read — a week inside another the model leaves out
          has at most N of them, and counts N either way.
          ONLY WHERE THE LIMIT TIPS THE WEEK: a week every day together cannot
          hold either is too much with no post at all, and is the model's to
          refuse with whatever does tip it — a limit allowing every day with
          room among them, which the model does not even build.

        EVERY CAP BEFORE ANY DAYS, and the order is for a reader without HR
        read access. The days refusal carries the post's figure and is masked
        for them into a sentence with nothing in it to act on; a cap refusal
        is theirs to read. Where both are true, the one they can act on comes
        first, and fixing it may be all the week needed.
        """
        capped = [
            rule
            for rule in request.teacher_work_rules
            if rule.max_teaching_minutes_per_day is not None
        ]
        limits = request.teacher_day_limits
        if not capped and not limits:
            return

        # PER LESSON, each lesson once per person on it (_teachers_at as a
        # set): a split post's lessons are each their own lead's, so Bertil's
        # week holds his one lesson of the three and its length, never Anna's
        # two. An unsplit post gives its lead and its co-teacher every lesson,
        # which is the sum, the longest and the list the per-requirement
        # reading made (_teacher_week).
        week_minutes, longest, requirements_of = _teacher_week(request.requirements)

        weekdays = self._grid.schedule_days
        lock_minutes, _lock_days = _teacher_locks(request.fixed_lessons)
        reaching = [rule for rule in capped if rule.teacher_id in week_minutes]

        def residual(teacher_id: UUID, cap: int, weekday: int) -> int:
            return max(0, cap - lock_minutes.get((teacher_id, weekday), 0))

        for rule in reaching:
            cap = rule.max_teaching_minutes_per_day
            assert cap is not None
            if longest[rule.teacher_id] > cap:
                raise InvalidScheduleInputError.of("TEACHER_LESSON_LONGER_THAN_DAILY_CAP", {
                    "rule": str(rule.id),
                    "minutes": cap,
                    "lessonMinutes": longest[rule.teacher_id],
                })
        for rule in reaching:
            cap = rule.max_teaching_minutes_per_day
            assert cap is not None
            room = sum(residual(rule.teacher_id, cap, weekday) for weekday in weekdays)
            if week_minutes[rule.teacher_id] > room:
                raise InvalidScheduleInputError.of("TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {
                    "rule": str(rule.id),
                    "minutes": cap,
                    "days": len(weekdays),
                    "weekMinutes": week_minutes[rule.teacher_id],
                })

        if not limits:
            return
        rooms = self._teacher_rooms(request, {
            limit.teacher_id: requirements_of[limit.teacher_id]
            for limit in limits
            if limit.teacher_id in week_minutes
        })
        for limit in limits:
            teacher_id = limit.teacher_id
            if teacher_id not in week_minutes:
                continue
            room = rooms[teacher_id]
            caps = [
                rule.max_teaching_minutes_per_day
                for rule in reaching
                if rule.teacher_id == teacher_id
                and rule.max_teaching_minutes_per_day is not None
            ]
            per_day = []
            for day_index, weekday in enumerate(weekdays):
                held = room.get(day_index, 0) * self._grid.slot_minutes
                for cap in caps:
                    held = min(held, residual(teacher_id, cap, weekday))
                per_day.append(held)
            days = max(
                min(limit.max_teaching_days_per_week, len(weekdays)),
                min(len(week & set(weekdays)) for week in _week_sets(limit)),
            )
            if week_minutes[teacher_id] > sum(per_day):
                # Every day, no limit: the week is too much for the teacher
                # whatever the post says, and the post is not what tips it.
                # Named, it would tell a decider to allow more days when no
                # number of days helps, and a reader without HR read access
                # would get the masked sentence in place of a cause they can
                # act on. Where the room alone tips it, with no cap in it,
                # that cause is the hours, and _teacher_hours_verdict names
                # them before any model: the model itself has no literal to
                # name, and its core came back empty. Where a cap is what
                # tips it, the cap's literal is in the model. This is also
                # the model's "allowed >= candidates" skip, read here: a count
                # reaching every day with room takes all of them, so its sum
                # is this one.
                continue
            if week_minutes[teacher_id] > sum(sorted(per_day, reverse=True)[:days]):
                raise InvalidScheduleInputError.of("TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK", {
                    "limit": str(limit.id),
                    "days": limit.max_teaching_days_per_week,
                    "weekMinutes": week_minutes[teacher_id],
                })

    def _locks_in_stretch(
        self,
        request: OptimizeScheduleRequest,
        members: set[UUID],
        day_index: int,
        opens: int,
        first: int,
    ) -> bool:
        """Has a hand-placed lesson already taught this class in this stretch?

        A LOCKED LESSON IS A LESSON, and the rule asks whether the class was
        taught before the break, not whether the SOLVER put it there. Without
        this the engine reads a school that has hand-placed Monday 08:00-09:10
        as a class with nothing before its 09:40 break: it demands another
        lesson in a stretch the locks have already filled, cannot find one, and
        concludes the class must have gone home — deleting the rest of every
        such day. Measured on one class with three locked mornings: OPTIMAL in
        0.5 s without the rule, sixty seconds of silence with it.

        The window is the one _fixed_window rounds OUTWARD, so a lock is only
        counted when it fits inside the stretch with the rounding against it —
        which is the safe direction for a test that excuses an obligation.
        """
        base = day_index * self._grid.slots_per_day
        for fixed in request.fixed_lessons:
            if not ({fixed.student_group_id, *fixed.extra_group_ids} & members):
                continue
            window = self._fixed_window(fixed)
            if window is None:
                continue
            if base + opens <= window[0] and window[1] <= base + first:
                return True
        return False

    def _locked_after(
        self,
        request: OptimizeScheduleRequest,
        members: set[UUID],
        day_index: int,
        last: int,
    ) -> bool:
        """Is the class hand-placed into a lesson AFTER the break?

        The mirror of the test above, and it closes the other half of the same
        hole. "Still at school" is read off the lessons the solver places, so a
        class whose only afternoon is locked looked like a class that had gone
        home, and the break's demand was excused by a lesson the school had
        already written down. Here the demand is unconditional instead.
        """
        base = day_index * self._grid.slots_per_day
        for fixed in request.fixed_lessons:
            if not ({fixed.student_group_id, *fixed.extra_group_ids} & members):
                continue
            window = self._fixed_window(fixed)
            if window is not None and window[0] >= base + last:
                return True
        return False

    def _reserved_ranges(
        self,
        request: OptimizeScheduleRequest,
        requirement: AnonymousRequirement,
        day_index: int,
        teachers: tuple[UUID, ...] | None = None,
    ) -> list[tuple[int, int]]:
        """Day-local ranges a reservation provably keeps this requirement out of.

        The stretch before a break is measured from the calendar — the frame,
        the previous break, the meal — and a calendar cannot see a school that
        has reserved those very minutes. Measured on the payloads that survived
        the first fix: a class with a break at 11:10, a stretch of fifty roomy
        minutes behind it, and an availability row over 10:20-11:10 taking
        every one of them. Nothing fits, the rule concludes the class has gone
        home, the afternoons close, and three lessons a day against sixteen a
        week is a pigeonhole no counting argument in the model ever assembles:
        sixty seconds of silence.

        EXACTLY THE ROWS THE MODEL ITSELF APPLIES, and no others. This decides
        whether an obligation is dropped and whether a week is refused, so a row
        counted here that the solver does not enforce refuses a timetable that
        exists. Three exclusions, each for its own reason:

          A DATED ROW IS SKIPPED, because _add_availability_constraints skips
          it: the engine places a generic week and a single date is not part of
          one. Subtracting it here would refuse a week the solver would place
          without complaint — the sharpest way this could go wrong, and the
          first thing a measurement of it caught.

          A ROOM ROW IS SKIPPED, because it blocks only the lessons actually
          assigned to that room, which is a decision the solver has not made
          yet. A class is stuck only when NO eligible room is free, and that is
          not arithmetic on one row.

          ONLY UNAVAILABLE. A reservation of any other kind does not empty the
          minutes.

        The remaining three match exactly as _decisions_for_constraint matches
        them, which is the point: a teacher's row reaches the requirements that
        teacher carries, a group's row reaches its own, and a year's row
        reaches every requirement whose years OVERLAP it.

        A TEACHER'S ROW REACHES A LESSON, NOT A ROW, once a post is split:
        Bertil's Friday keeps out his lesson of the three and leaves Anna's
        two where they were. `teachers` names the lesson's own
        (_lesson_teachers) for the one caller that asks about a lesson, the
        rast ordering's flag. Left out, the question is about the requirement
        — the pre-flight's — and only a teacher on EVERY lesson counts
        (_teachers_on_every_lesson): counting Bertil's row against the whole
        row would shrink what the week holds and refuse a week that has a
        timetable. For a post one person leads both readings are its lead and
        its co-teacher, as they always were.
        """
        if teachers is None:
            teachers = _teachers_on_every_lesson(requirement)
        blocked: list[tuple[int, int]] = []
        day_of_week = self._grid.schedule_days[day_index]
        for constraint in request.constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.day_of_week not in (None, day_of_week):
                continue
            if constraint.resource_kind == "TEACHER":
                reaches = constraint.resource_id in teachers
            elif constraint.resource_kind == "STUDENT_GROUP":
                reaches = requirement.student_group_id == constraint.resource_id
            elif constraint.resource_kind == "GRADE_LEVEL":
                reaches = _grade_span_overlaps(constraint, requirement)
            else:
                reaches = False
            if not reaches:
                continue
            start = self._grid.clamp_to_grid(constraint.start_time)
            end = self._grid.clamp_to_grid(constraint.end_time)
            if start is None or end is None or end <= start:
                continue
            blocked.append((start, end))
        return blocked

    def _reserved_for_all(
        self,
        request: OptimizeScheduleRequest,
        requirements: list[AnonymousRequirement],
        day_index: int,
    ) -> list[tuple[int, int]]:
        """Minutes no requirement of this class may be taught in, today.

        The INTERSECTION of what each one is barred from, because the class is
        only barred where all of them are: a row against one teacher leaves the
        hour open to every other subject, and counting it against the class
        would shrink a week that has not shrunk.
        """
        common: list[tuple[int, int]] | None = None
        for requirement in requirements:
            blocked = self._reserved_ranges(request, requirement, day_index)
            if common is None:
                common = blocked
                continue
            common = [
                (max(a, c), min(b, d))
                for a, b in common
                for c, d in blocked
                if max(a, c) < min(b, d)
            ]
            if not common:
                return []
        return common or []

    def _room_in_stretch(
        self,
        blocked: list[tuple[int, int]],
        opens: int,
        first: int,
    ) -> int:
        """The longest unbroken run left of [opens, first) once those are gone.

        A run, not a total: a lesson needs its minutes in one piece, which is
        the same thing _widest_free_run says about a day full of rasts.
        """
        free = [(opens, first)] if first > opens else []
        for start, end in blocked:
            free = _subtract_range(free, (start, end))
        return max((end - start for start, end in free), default=0)

    def _verify_rast_demands(self, request: OptimizeScheduleRequest) -> None:
        """A break whose demand can never be met, on a week that then has no room.

        BOTH HALVES, and the second one is what makes this sound. A stretch that
        cannot hold a lesson does not by itself make a week impossible: the rule
        is satisfied just as well by a class that has GONE HOME before the
        break, and a class whose Friday ends at noon owes a 12:30 break nothing.
        Refusing on the first half alone — which is what the first version of
        this did — turns down weeks that have a timetable, and that is the worst
        answer this engine can give.

        So the arithmetic runs the whole way. When no lesson of the class can
        ever sit in the stretch, the class can never be at school after that
        break: the only remaining way to satisfy the clause is to be gone, so
        that day is worth only its minutes BEFORE the break. Cap the closed days
        that way, count what the week still holds, and refuse only when the
        class needs more than that. Then the refusal is one the model would have
        made too — it just could not make it in a minute, because the proof is a
        pigeonhole across five separate days and the search never assembles it.

        Measured: a class with an availability row over the whole stretch, 16
        lessons of 40 minutes, and mornings holding 3 a day — 15 against 16, a
        shortfall of one lesson. Sixty seconds of silence before, refused by
        name in milliseconds after.

        THE CAPACITY IS COUNTED GENEROUSLY, on purpose. No lunch is subtracted
        and no fragment is discounted beyond what _holds already does, because
        every minute this over-counts is a week that goes to the solver instead
        of being refused, and that is the direction to be wrong in.
        """
        if not any(rast.requires_lesson_before for rast in request.rasts):
            return
        by_group: dict[UUID, list[AnonymousRequirement]] = defaultdict(list)
        for requirement in request.requirements:
            by_group[requirement.student_group_id].append(requirement)

        for group, clique in self._cliques(request):
            if group.min_grade_level is None or group.max_grade_level is None:
                continue
            # The rule is the CLASS's: _add_rast_ordering_constraints reads
            # every lesson filed under the class and under every group sharing
            # its pupils. This verdict tries fewer: the lessons filed under a
            # member of the clique (7A's svenska under 7A, whoever sits it)
            # and the clique's own requirements (a derived key's lessons filed
            # under a class outside it). A partner the greedy clique left out
            # (M2b, when M2a was chosen) can fill the stretch unseen, and the
            # verdict then refuses a week the model solves. That gap is
            # main's, and it is left as it is here, so that a payload without
            # pupilGroupId gets main's list, in main's order, and main's
            # answer; closing it is a change of its own.
            owned = [r for member in clique.members for r in by_group.get(member, [])]
            seen = {r.id for r in owned}
            owned += [r for r in clique.requirements if r.id not in seen]
            if not owned:
                continue

            # The days this class is shut out of the rest of, and the break that
            # shuts it — the first one found, which is the one to name.
            closed: dict[int, tuple[int, int]] = {}
            for day_index, _opens, room, first, last, meal in self._asked_stretches(
                request, (group.min_grade_level, group.max_grade_level),
            ):
                # THE BEST-PLACED REQUIREMENT DECIDES, because the demand is for
                # A lesson and not a particular one: one subject whose teacher
                # is free and whose lessons are short enough answers it for the
                # whole class. Measuring the shortest lesson alone would close a
                # day whose maths teacher is away and whose music teacher is not.
                # A split post's lead being away closes nothing here either: a
                # reservation counts against a requirement only where it
                # reaches every lesson of it (_reserved_ranges).
                if any(
                    self._room_in_stretch(
                        self._reserved_ranges(request, requirement, day_index), room, first,
                    ) >= self._grid.minutes_to_slots(requirement.shortest_lesson_minutes())
                    for requirement in owned
                ):
                    continue
                # A lesson the school placed by hand is a lesson, so a stretch
                # a lock already fills is not closed at all.
                if self._locks_in_stretch(
                    request, set(clique.members), day_index, room, first,
                ):
                    continue
                closed.setdefault(day_index, (first, last, room, meal))
            if not closed:
                continue

            rules = request.rules
            lunch_on = rules is not None and _lunch_window_is_set(rules)
            if lunch_on:
                window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
            capacity = 0
            for day_index, free in clique.free_by_day.items():
                shut = closed.get(day_index)
                if shut is not None:
                    free = [
                        (start, min(end, shut[0])) for start, end in free
                        if start < shut[0]
                    ]
                # And the minutes reserved away from EVERY requirement the
                # class has. Every one, not any: a row that stops the maths
                # teacher leaves the hour open to music, and subtracting it
                # would count a week as smaller than it is — which is the
                # direction that refuses a timetable.
                for start, end in self._reserved_for_all(request, owned, day_index):
                    free = _subtract_range(free, (start, end))
                if not lunch_on:
                    capacity += _holds(free, clique.measure)
                    continue
                # The meal placed where it wastes least, the same search the
                # hours verdict makes: the class must eat, and counting a day
                # as if it need not would over-count exactly the hour that
                # decides these weeks. Best-case, so the count stays generous
                # and a refusal stays one the model would have made.
                best = 0
                fits = False
                for start in range(window_start, window_end - lunch_slots + 1):
                    if any(a <= start and start + lunch_slots <= b for a, b in free):
                        fits = True
                        best = max(best, _holds(
                            _subtract_range(free, (start, start + lunch_slots)),
                            clique.measure,
                        ))
                # No meal fits this day at all: a refusal of its own, made
                # elsewhere by name, and not this one's to make.
                capacity += best if fits else _holds(free, clique.measure)
            if clique.demand <= capacity:
                continue

            day_index, (first, _last, room, meal) = next(iter(closed.items()))
            widest = max(
                self._room_in_stretch(
                    self._reserved_ranges(request, requirement, day_index), room, first,
                )
                for requirement in owned
            )
            minutes = self._grid.slot_minutes
            raise InvalidScheduleInputError.of("RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT", {
                "day": self._grid.schedule_days[day_index],
                "grades": _grade_span_text(group.min_grade_level, group.max_grade_level),
                "rast": self._grid.format_hhmmss(first, 0)[0][:5],
                "opens": self._grid.format_hhmmss(room, 0)[0][:5],
                "remaining": widest * minutes,
                "minutes": min(
                    self._grid.minutes_to_slots(r.shortest_lesson_minutes()) for r in owned
                ) * minutes,
                # Which of the three took the minutes, so the school is sent to
                # the screen that holds the lever.
                "bound": (
                    "closed" if widest < first - room else "lunch" if meal else "day"
                ),
                "demandMinutes": clique.demand * minutes,
                "capacityMinutes": capacity * minutes,
            })

    def _earliest_meal_end(
        self,
        request: OptimizeScheduleRequest,
        span: tuple[int, int] | None,
        day_of_week: int,
    ) -> int:
        """The first slot this stage's meal can possibly free, today.

        THE SITTINGS COUNT, not just the school-wide window, and a stage that
        eats in the second sitting is the case this exists for: a school whose
        window opens 11:00 but whose åk 4-6 sitting is 12:00-12:45 frees those
        classes at 12:45 at the earliest, and a break at 13:00 has fifteen
        minutes before it rather than the hour the window alone suggests.

        A LOWER BOUND, deliberately, and it may only ever be raised by
        something the payload PROVES. Everything downstream skips an obligation
        or refuses a payload on this number, so an over-estimate would drop a
        rule the school asked for or refuse a week that has a timetable. The
        dining hall's seats can push a class later still — the solver decides
        that, not arithmetic — so a week narrow enough to need that reasoning
        is left to the solver, exactly as it was before.
        """
        rules = request.rules
        if rules is None or not _lunch_window_is_set(rules):
            return 0
        window_start, _window_end, lunch_slots = self._lunch_window_slots(rules)
        starts = allowed_starts(
            request.lunch_servings, span, day_of_week, lunch_slots, self._grid,
        )
        intervals = _domain_intervals(starts) if starts is not None else []
        earliest = max(window_start, intervals[0][0]) if intervals else window_start
        return earliest + lunch_slots

    def _asked_stretches(
        self,
        request: OptimizeScheduleRequest,
        span: tuple[int, int] | None,
    ) -> list[tuple[int, int, int, int, int, bool]]:
        """A stretch a rast demands a lesson of: (day, opens, room, first, last, meal).

        ONE READER FOR TWO CALLERS, and the reason is the bug this was written
        after. The builder used to measure the stretch one way and BOUND it
        another: it skipped a lesson longer than `rast start - previous rast
        end`, then wrote the flag against `lunch start + meal` whenever the meal
        lay inside. Where the meal ended less than a lesson before the break —
        an 11:00-12:30 window with a 60-minute meal and a break at 12:30, which
        is an ordinary Swedish lunch hour — the filter measured a roomy 150
        minutes, kept every flag, and every flag was unsatisfiable. The clause
        then collapsed to "nobody is here after this break", the rule stopped
        meaning "be taught before it" and started meaning "go home at it", and
        the class lost every afternoon of the week. The week that was left was
        over capacity and infeasible, and no counting argument in the model
        could prove it: sixty seconds of silence and a TIMEOUT, on one class
        with twenty-four lessons. Measured: 0.2 s OPTIMAL without the flag.

        So the stretch is measured ONCE, honestly, and both the filter and the
        refusal read the same number.

          `opens` is where a lesson in the stretch may first START by the
          constants alone: the end of the previous break, or the frame's
          opening, whichever is later. The frame belongs here for the same
          reason the previous break does — a day that opens 09:20 has no
          08:00 — and leaving it out was half of the same bug.

          `room` is what the stretch can hold AT BEST, which is `opens` unless
          the whole lunch window lies inside it, and then the EARLIEST slot the
          meal can free. Earliest, not latest: a lesson is skipped only when no
          admissible meal leaves space for it. The latest meal end would skip
          obligations a legal early meal could still honour.

        Days the frames close entirely are absent from `day_windows` and absent
        from here: a stage with no Friday owes its Friday breaks nothing.
        """
        rules = request.rules
        lunch_on = rules is not None and _lunch_window_is_set(rules)
        if lunch_on:
            window_start, window_end, _lunch_slots = self._lunch_window_slots(rules)
        windows = day_windows(request.frame_times, span, self._grid)

        out: list[tuple[int, int, int, int, int, bool]] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            window = windows.get(day_index)
            if window is None:
                continue
            frame_open, _frame_close = window
            blocks = blocks_with_demand(request.rasts, span, day_of_week, self._grid)
            for first, last, demands in blocks:
                if not demands:
                    continue
                opens = max(
                    max((end for _start, end, _asks in blocks if end <= first), default=0),
                    frame_open,
                )
                bounded_by_lunch = (
                    lunch_on and opens <= window_start and window_end <= first
                )
                room = (
                    max(opens, self._earliest_meal_end(request, span, day_of_week))
                    if bounded_by_lunch
                    else opens
                )
                out.append((day_index, opens, room, first, last, bounded_by_lunch))
        return out

    def _add_rast_ordering_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        request: OptimizeScheduleRequest,
        decisions: list[LessonDecision],
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
    ) -> None:
        """A class still at school after a rast was taught before it.

        A rast has otherwise only been a hole in the day, and a class whose
        Monday begins at the morning break has broken no rule the engine knows.
        Measured through the whole solve on twenty-four classes: of the 110
        mornings where a class was still at school after its break, 16 had
        nothing before it, and 2 afternoons of 39. So this changes real
        schedules rather than restating what the solver already did — but the
        measurement has to be taken with the OBJECTIVE in place. A phase-1
        satisfaction solve hugs the lower bound of every domain, puts every
        lesson as early as it will go, and honours a rule about mornings by
        accident; measured there the baseline broke it not once.

        "STILL AT SCHOOL" IS THE CONDITION, not the calendar. The obligation is
        on the stretch a lesson FOLLOWS, so a class that has gone home owes
        nothing and a class whose Friday is empty owes nothing either. Written
        without it — a bare demand on every stretch of every school day — two
        asking rasts oblige every class to be taught ten times a week: measured
        on one class over five days, eight lessons was INFEASIBLE and ten the
        first count that solved.

        THE STRETCH IS COUNTED FROM THE PREVIOUS BREAK, and the class's own
        LUNCH counts as one. Read without that, "a lesson before the afternoon
        rast" is satisfied by a lesson before lunch, and the whole afternoon
        can be empty — measured, and at twenty-four classes every one of the
        hundred and twenty afternoon stretches came out that way. The lunch is
        a variable, which is the part that looked expensive and is not.

        THE WHOLE RULE IS THE EXPENSIVE ONE, and it is the only rast setting
        that makes the model bigger rather than smaller: two booleans and four
        rows per lesson per asking rast per day, about six times the variables
        of the same week without it. Measured, satisfaction phase: 0.08 s to
        3.0 s at twenty-four classes, 0.44 s to 9.6 s on a week 83% full; the
        whole solve on those twenty-four classes went 20.4 s to 38.5 s, both
        OPTIMAL and both inside the budget. That is why the flag is per rast
        and defaults false, and why a TIMEOUT probes it on its own.

        THE LUNCH BOUNDS THE STRETCH ONLY WHEN ITS WHOLE WINDOW LIES INSIDE IT.
        A lunch window straddling the rast leaves their order undecided, and
        "a lesson between them" is not a sentence about a week yet; requiring
        one anyway would refuse a schedule for a question nobody asked. That
        test is on constants and costs nothing.

        WHERE THE STRETCH IS MEASURED, _asked_stretches owns — and it is not a
        detail. Measuring it one way and bounding the flag another left every
        flag unsatisfiable on an ordinary lunch hour, which turned this clause
        into "go home at the break" and cost a school its whole afternoon and
        the engine its whole budget. Read that function before changing this
        one.

        THE CLASS'S LESSONS ARE ITS TEACHING GROUPS', the same reach the lunch
        and the hours verdict use: 4.1's maths is filed under 4ma1, and a rule
        reading only lessons filed under "4.1" would find a class with no
        lessons at all and be satisfied by nothing.

        ONE ASSUMPTION LITERAL PER CLASS, because this rule can refuse a week
        on its own — a day whose lessons will not fit before its rasts has no
        timetable — and a hard row here would be an INFEASIBLE with no
        assumption to name. The core would then be empty or made of unrelated
        rows, and the school is told its timetable is impossible without being
        told which sentence it wrote made it so; the frame and the rast
        domains already refuse that outcome by name a few hundred lines up.
        Per class rather than per row: the school reads one line naming the
        classes, and it is the class whose day the school has to change.
        """
        wanted = [rast for rast in request.rasts if rast.requires_lesson_before]
        if not wanted or not request.groups:
            return

        grid = self._grid
        slots_per_day = grid.slots_per_day
        sharing = _groups_sharing_students(request.group_conflicts)
        # The CLASS space (pupil_key_of has the two): a rast is the class's,
        # and its lessons are the ones filed under it and under the groups
        # sharing its pupils. A derived key among those partners files none.
        by_group: dict[UUID, list[LessonDecision]] = defaultdict(list)
        for decision in decisions:
            by_group[decision.lesson.requirement.student_group_id].append(decision)

        rules = request.rules
        lunch_slots = (
            self._lunch_window_slots(rules)[2]
            if rules is not None and _lunch_window_is_set(rules)
            else 0
        )

        span_by_group = {
            group.id: (group.min_grade_level, group.max_grade_level)
            for group in request.groups
            if group.min_grade_level is not None and group.max_grade_level is not None
        }

        # One read per (requirement, teachers, day) for the whole build: the
        # same requirement is looked at once per class that shares its pupils,
        # once per day, once per asking break. The teachers are the LESSON's
        # (_lesson_teachers), so a split post's lessons are each kept out of
        # what reaches their own lead; an unsplit post's lessons all share one
        # key, and the reads are the ones the requirement always made.
        cache: dict[tuple[UUID, tuple[UUID, ...], int], list[tuple[int, int]]] = {}

        def reserved(decision: LessonDecision, day_index: int) -> list[tuple[int, int]]:
            requirement = decision.lesson.requirement
            teachers = _lesson_teachers(decision.lesson)
            key = (requirement.id, teachers, day_index)
            if key not in cache:
                cache[key] = self._reserved_ranges(
                    request, requirement, day_index, teachers,
                )
            return cache[key]

        for group in request.groups:
            members = {group.id, *sharing.get(group.id, ())}
            lessons = [
                decision for member in members for decision in by_group.get(member, [])
            ]
            if not lessons:
                continue
            span = span_by_group.get(group.id)
            # Built lazily: a class no asking rast reaches adds no literal, and
            # a payload where nobody asked adds none at all.
            asks: cp_model.IntVar | None = None
            for day_index, opens, room, first, last, meal_bounds in self._asked_stretches(
                request, span,
            ):
                base = day_index * slots_per_day
                lunch_start = lunch_starts.get((group.id, day_index))
                after_lunch = meal_bounds and lunch_start is not None
                # A lesson the school placed by hand is a lesson: when one sits
                # in the stretch the demand is already met, and the cheapest
                # obligation is the one never written. `room` and not `opens`,
                # so this reads the same stretch _verify_rast_demands does —
                # see there for why the permissive end of the meal is the right
                # one to measure from.
                if self._locks_in_stretch(request, members, day_index, room, first):
                    continue
                inside = []
                for decision in lessons:
                    # A lesson too long for the stretch can never be in it,
                    # and `room` is measured against the same boundary the
                    # flag below is written against — the meal's earliest
                    # end when the meal bounds the stretch. Skipping it here
                    # is one boolean and two rows the model never sees; NOT
                    # skipping it was the timeout, because a flag that can
                    # never be true turns the clause into "go home".
                    #
                    # PER LESSON, not per stretch, because a reservation
                    # reaches a teacher rather than a class: the maths teacher
                    # being away leaves the stretch open to every other
                    # subject, and a room measured across the class would close
                    # it for all of them.
                    if decision.duration > self._room_in_stretch(
                        reserved(decision, day_index), room, first,
                    ):
                        continue
                    flag = model.NewBoolVar(
                        f"before_{group.id}_{day_index}_{first}_{decision.lesson.key()}",
                    )
                    # The lunch's own start, not an intermediate variable
                    # equal to its end: one linear row rather than two, and
                    # presolve reads straight through to the meal.
                    if after_lunch:
                        model.Add(
                            decision.start >= lunch_start + lunch_slots,
                        ).OnlyEnforceIf(flag)
                    else:
                        model.Add(decision.start >= base + opens).OnlyEnforceIf(flag)
                    model.Add(decision.end <= base + first).OnlyEnforceIf(flag)
                    inside.append(flag)
                if asks is None:
                    asks = registry.register(
                        model,
                        name=f"rast_order_{group.id}",
                        category="AVAILABILITY",
                        code="RAST_NO_LESSON_FITS_BEFORE_IT",
                        resource_ids=[group.id],
                    )
                if not inside:
                    # NOTHING CAN EVER SIT IN THIS STRETCH, so the demand has
                    # exactly one remaining way to be met: the class is gone by
                    # then. Said outright, as a hole in every one of its
                    # lessons' start domains, and NOT left to a clause over
                    # flags that can never be true — that was the timeout, and
                    # an empty BoolOr would be an unexplained INFEASIBLE
                    # besides. A domain is also the cheapest thing this engine
                    # has: no boolean, no row, and presolve reads it directly.
                    #
                    # Whether the week then still holds the class's lessons is
                    # _verify_rast_demands' question, asked before the solve.
                    for decision in lessons:
                        model.AddLinearExpressionInDomain(
                            decision.start,
                            cp_model.Domain(
                                base + last, base + slots_per_day - 1,
                            ).complement(),
                        ).OnlyEnforceIf(asks)
                    continue
                # WHO IS STILL AT SCHOOL AFTER THE RAST. Read without this
                # the rule demands a lesson in the stretch on every school
                # day, which is a different sentence: two asking rasts
                # would oblige every class to be taught ten times a week,
                # and a class with eight lessons is refused outright.
                # Measured on a five-day week with one class: 8 lessons
                # INFEASIBLE, 10 the first that solved.
                #
                # Fully reified, unlike the flags above, and that is the
                # whole reason it costs a second boolean per lesson: the
                # solver WANTS these false — false is what excuses it from
                # the stretch — so only the reverse implication, "a lesson
                # here means the class is still at school", makes them
                # true. `inside` needs no such thing.
                # A lock after the break has already answered the question the
                # literals below exist to ask, and answered it yes. The demand
                # is then unconditional, and costs one clause instead of a
                # boolean and three rows per lesson.
                if self._locked_after(request, members, day_index, last):
                    model.AddBoolOr([*inside, asks.Not()])
                    continue
                still_here = model.NewBoolVar(
                    f"after_{group.id}_{day_index}_{first}",
                )
                rest_of_day = cp_model.Domain(
                    base + last, base + slots_per_day - 1,
                )
                for decision in lessons:
                    late = model.NewBoolVar(
                        f"late_{group.id}_{day_index}_{first}_"
                        f"{decision.lesson.key()}",
                    )
                    model.AddLinearExpressionInDomain(
                        decision.start, rest_of_day,
                    ).OnlyEnforceIf(late)
                    model.AddLinearExpressionInDomain(
                        decision.start, rest_of_day.complement(),
                    ).OnlyEnforceIf(late.Not())
                    model.AddImplication(late, still_here)
                model.AddBoolOr([*inside, still_here.Not(), asks.Not()])

    def _rast_free_starts(
        self,
        rasts: list[Rast],
        span: tuple[int, int] | None,
        duration: int,
    ) -> cp_model.Domain:
        """Every absolute start a lesson of `duration` may take, rasts removed.

        Built as the COMPLEMENT of the forbidden ranges rather than as a union
        of the free ones, because the free ranges are what is left over and
        would have to be derived; the forbidden ones are what a rast says.
        """
        slots_per_day = self._grid.slots_per_day
        forbidden: list[list[int]] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            blocks = blocks_for(rasts, span, day_of_week, self._grid)
            base = day_index * slots_per_day
            forbidden.extend(
                [base + first, base + last]
                for first, last in forbidden_starts(blocks, duration)
            )
        if not forbidden:
            return cp_model.Domain(0, self._grid.horizon)
        # `complement()` over the whole integer line, then clipped back to the
        # horizon. ortools' Domain has no `difference`, and complement-then-
        # intersect is the composition it does have — the intersection with the
        # caller's own domain in _create_lesson_decisions does the clipping, but
        # doing it here too keeps this function's return value meaningful on its
        # own rather than only in the one place it is used.
        return cp_model.Domain.FromIntervals(forbidden).complement().intersection_with(
            cp_model.Domain(0, self._grid.horizon),
        )

    def _daily_maximum_verdict(
        self,
        request: OptimizeScheduleRequest,
        conflicts: ConflictAnalysis,
        *,
        seconds_left: float | None = None,
    ) -> ConflictAnalysis:
        """Keep the class daily maximum in a refusal only where it is a cause.

        THE CORE NAMES IT WHATEVER THE CAUSE. CP-SAT's sufficient set on these
        models is close to all or nothing — the review of #182 found every
        assumption in it in 376 of 376 capped impossible fuzz weeks, and 486 of
        486 on the högstadium week — and nearly every class has more lessons
        than the maximum, so a literal per class put the maximum into nearly
        every refusal. On hogstadium.py --teacher-day-rules --infeasible-days,
        whose cause is a post, it was 18 lines of "Raise Max lessons per day"
        on a week that stays impossible with no maximum at all.

        SO IT IS MEASURED, as the blocks are: the week is solved once more
        without the maximum, every other rule in force, on the probe's budget
        and never more than the solve has left.
        - A timetable: the maximum is what makes the week impossible
          (`measured` 1). The line names the groups that timetable gives more
          than the maximum on some day: lifting it for those alone is enough,
          which is the one thing the timetable proves; it does not prove each
          of them needs it.
        - Still impossible: the maximum is not needed for the proof, which
          does not make it no cause. A class of eleven lessons under one a day
          on a five-day week is impossible whatever else the week holds, and a
          school told only of its blocks and rooms fixes those and is refused
          again for the maximum (dist/500057 of the fuzz). So the maximum is
          measured on its own (_held_back_by_the_maximum): a group whose
          lessons the days open to it cannot hold at the maximum, and can
          without it, keeps the line, `measured` 2, and is named. No group
          held back, the line goes; a core that was nothing else is then
          CONFLICT_NO_CORE.
        - Nothing inside the budget, no budget, or a probe that could not be
          built or solved: the line stays as the core gave it, every capped
          group in it and `measured` 0, since the maximum may matter and
          nothing says it does not.

        PER GROUP AND NOT FOR THE WEEK, the second time, because a solve of the
        whole week cannot tell the cause apart at a price a refusal can pay.
        The maximum's literals as the only assumptions answer "impossible" on
        66 of the 120 fuzz weeks that get this far, and 45 of those are
        impossible with no assumption
        at all — the fixed part of the model, days and frames and locks and
        overlaps, refuses them alone — so the answer names the maximum where
        nothing about it is the matter. Telling those apart takes a timetable
        with every other rule lifted, which on the högstadium post week took
        15 s on all of the host's cores, and which the single-threaded
        assumption solve did not find in 30 s. The count, with each group it
        names placed on its own without the maximum, names all 21 weeks where
        the maximum alone is the matter and the rest of the week is not, none
        of the 54 where the maximum alone is possible, and 6 of the 45 — in
        those, only groups whose own week holds them without the maximum and
        not with it.

        A line measured to be a cause leads the refusal: it is the one line
        on it that was checked, and the reading order puts first what an
        administrator can check (conflict_analyzer._how_far_it_narrows).
        The week is solved once without the maximum for all the groups and not
        once per group, for _blocks_verdict's reason; what is solved per group
        is the group alone, a few dozen intervals.
        """
        line = next(
            (
                detail for detail in conflicts.conflicts
                if detail.code == "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT"
            ),
            None,
        )
        rules = request.rules
        if line is None or rules is None or rules.max_lessons_per_day_per_group is None:
            return conflicts
        cap = rules.max_lessons_per_day_per_group
        budget = self._settings.solver_probe_seconds
        if seconds_left is not None:
            budget = min(budget, seconds_left)
        if budget < self.MIN_PHASE_SECONDS:
            return conflicts
        deadline = time.monotonic() + budget
        others = [detail for detail in conflicts.conflicts if detail is not line]

        def said(measured: int, groups: list[UUID]) -> ConflictAnalysis:
            # The core's groups first and in its order, then any the
            # measurement adds. Built again rather than copied: the message
            # is rendered from the values once, when the detail is made.
            named = [group_id for group_id in line.resource_ids if group_id in groups]
            named += sorted(set(groups).difference(line.resource_ids), key=str)
            measured_line = ConflictDetail(
                category=line.category,
                code=line.code,
                params={**line.params, "measured": measured},
                requirement_ids=line.requirement_ids,
                room_ids=line.room_ids,
                constraint_ids=line.constraint_ids,
                resource_ids=named or line.resource_ids,
            )
            return conflicts.model_copy(update={"conflicts": [measured_line, *others]})

        without = request.model_copy(
            update={"rules": rules.model_copy(update={"max_lessons_per_day_per_group": None})},
        )
        try:
            model, _, decisions, plan, _ = self._build_model(
                without, use_assumptions=False, include_objective=False,
            )
        except InvalidScheduleInputError:
            return conflicts
        status, probe = self._probe_search(
            without, model, decisions, plan, budget, what="the daily maximum probe",
        )
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            per_day = Counter(
                (
                    decision.lesson.requirement.student_group_id,
                    probe.Value(decision.start) // self._grid.slots_per_day,
                )
                for decision in decisions
            )
            return said(1, [group_id for (group_id, _day), count in per_day.items() if count > cap])
        if status != cp_model.INFEASIBLE:
            return conflicts
        held_back = self._held_back_by_the_maximum(
            request, decisions, cap, deadline=deadline,
        )
        if held_back:
            return said(2, held_back)
        if not others:
            return no_core_analysis()
        return conflicts.model_copy(update={"conflicts": others})

    def _held_back_by_the_maximum(
        self,
        request: OptimizeScheduleRequest,
        decisions: list[LessonDecision],
        cap: int,
        *,
        deadline: float,
    ) -> list[UUID]:
        """The groups the maximum, and nothing about the group but it, holds back.

        TWO HALVES, both on the fixed part of the model, which no literal
        lifts, so both hold with every other rule set aside:
        - With the maximum the group's lessons do not fit: counted. A lesson
          lands on a day its starts reach (_day_reach: frames, margins, rasts,
          the school's days), and a group's lessons never overlap
          (_add_group_no_overlap, posted bare). So a day takes at most `cap`
          of a group's lessons, at most the ones that reach it, and at most as
          many of the shortest of those as fit end to end in the time they can
          reach there — a frame that leaves Tuesday one hour leaves it one
          lesson of an hour. Where the days' bounds sum to fewer than the
          group's lessons, no timetable keeps the maximum for it. The margins
          around a lesson are left out of the time it takes, which only lets
          more through.
        - Without it they do: solved, on the group alone
          (_placeable_without_the_maximum). A group whose lessons fit no week
          with or without a maximum — two of an hour and one of 45 minutes on
          two days of 90 — is held back by its days, and a line blaming the
          maximum for it was false (the review of #182: 11 of 42 measured
          weeks named such a group). The same count without the cap rules most
          of them out first, a solve the rest; a solve that cannot answer in
          the time left proves nothing, and the group is not named.

        THE GROUP IS THE CLASS (student_group_id), because the maximum is the
        class's: 7A's svenska counts toward 7A's day whoever sits it. "Never
        overlap" is the PUPIL space's: the class's lessons are one no-overlap
        per pupil key (_by_pupils), so a day's lessons are counted end to end
        per key and summed — an upper bound either way, and the count it
        always was for a class without a pupilGroupId.
        """
        by_group: dict[UUID, list[LessonDecision]] = defaultdict(list)
        for decision in decisions:
            by_group[decision.lesson.requirement.student_group_id].append(decision)
        slots_per_day = self._grid.slots_per_day
        whole_day = {
            day_index: [(day_index * slots_per_day, (day_index + 1) * slots_per_day)]
            for day_index in range(len(self._grid.schedule_days))
        }
        held_back = []
        for group_id, group in by_group.items():
            if len(group) <= cap:
                continue
            fits_by_day: dict[int, int] = defaultdict(int)
            for part in _by_pupils(group):
                durations: dict[int, list[int]] = defaultdict(list)
                spans: dict[int, list[tuple[int, int]]] = defaultdict(list)
                for decision in part:
                    reach = (
                        _day_reach(decision.starts, decision.duration, slots_per_day)
                        if decision.starts is not None
                        else whole_day
                    )
                    for day_index, ranges in reach.items():
                        durations[day_index].append(decision.duration)
                        spans[day_index].extend(ranges)
                for day_index, lengths in durations.items():
                    time_there = _covered(spans[day_index])
                    fits = 0
                    for length in sorted(lengths):
                        if time_there < length:
                            break
                        time_there -= length
                        fits += 1
                    fits_by_day[day_index] += fits
            capped = uncapped = 0
            for fits in fits_by_day.values():
                capped += min(cap, fits)
                uncapped += fits
            if capped < len(group) <= uncapped and self._placeable_without_the_maximum(
                request, group, deadline=deadline,
            ):
                held_back.append(group_id)
        return held_back

    #: The most one group's placement without the maximum may take. It is a
    #: few dozen intervals; one that takes longer is not worth the refusal's
    #: wait, and is not named.
    PLACEABLE_CAP_SECONDS = 0.5

    def _placeable_without_the_maximum(
        self,
        request: OptimizeScheduleRequest,
        group: list[LessonDecision],
        *,
        deadline: float,
    ) -> bool:
        """Whether one group's lessons fit its week when nothing caps a day.

        THE GROUP'S OWN FIXED PART, AS THE MODEL POSTS IT. Each lesson on the
        starts it was built on, the class's own no-overlap over the pupils'
        intervals (pupil_padded_of: the lead, the lesson, the corridor, the
        trail), and every locked lesson the model keeps it off: one that holds
        its pupils or a group sharing them blocks the pupils' interval, one
        that only shares a teacher blocks the lesson and its corridor
        (_add_fixed_lesson_constraints). Other groups' lessons are not in it,
        so a group that fits here may still clash with them; what this rules
        out is a group no week could ever hold, which is the false accusation.
        True only for a placement found inside the time left.

        The group is the class; its no-overlap and its locks are the PUPIL
        space's, as the model posts them: one no-overlap per pupil key among
        its lessons and one per pair of them groupConflicts names, and a lock
        holding the pupils of some of its lessons (pupil_keys_of) in those
        lessons' no-overlaps and in no other's — a locked SvA7 lesson keeps
        7A's matte off it and not 7A's svenska that SvA replaces. For a class
        without a pupilGroupId that is the one no-overlap it always was.
        """
        left = min(self.PLACEABLE_CAP_SECONDS, deadline - time.monotonic())
        if left <= 0:
            return False
        model = cp_model.CpModel()
        keys = [pupil_key_of(decision.lesson.requirement) for decision in group]
        sharing_of: dict[UUID, set[UUID]] = {}
        for key in dict.fromkeys(keys):
            sharing = {key}
            for first_id, second_id in request.group_conflicts or []:
                if key in (first_id, second_id):
                    sharing.update((first_id, second_id))
            sharing_of[key] = sharing
        pupils: list[cp_model.IntervalVar] = []
        lessons: list[tuple[set[UUID], cp_model.IntervalVar]] = []
        for k, decision in enumerate(group):
            domain = decision.starts or cp_model.Domain(0, self._grid.horizon)
            start = model.NewIntVarFromDomain(domain, f"start_{k}")
            pupils.append(model.NewFixedSizeIntervalVar(
                start - decision.lead,
                decision.lead + decision.duration + decision.changeover + decision.trail,
                f"pupils_{k}",
            ))
            # The lesson's own teachers, as _add_fixed_lesson_constraints reads
            # them: a lock of Bertil's keeps his lesson of a split post off it
            # and none of Anna's.
            lessons.append((
                set(_lesson_teachers(decision.lesson)),
                model.NewFixedSizeIntervalVar(
                    start, decision.duration + decision.changeover, f"lesson_{k}",
                ),
            ))
        # One no-overlap per pupil key, each its lessons' pupils' intervals
        # and then the locks that hold those pupils.
        parts: dict[UUID, list[cp_model.IntervalVar]] = {key: [] for key in sharing_of}
        for key, interval in zip(keys, pupils):
            parts[key].append(interval)
        for fixed in request.fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                continue
            blocked = model.NewFixedSizeIntervalVar(
                window[0], window[1] - window[0], f"locked_{fixed.id}",
            )
            held = set(pupil_keys_of(fixed))
            reached = {key for key, sharing in sharing_of.items() if held & sharing}
            for key in parts:
                if key in reached:
                    parts[key].append(blocked)
            if len(reached) == len(parts):
                continue
            teachers = {tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid}
            for key, (own, interval) in zip(keys, lessons):
                if key not in reached and own & teachers:
                    model.AddNoOverlap([interval, blocked])
        for part in parts.values():
            model.AddNoOverlap(part)
        # And each pair of the class's keys the model holds apart.
        joined: set[frozenset[UUID]] = set()
        for first_id, second_id in request.group_conflicts or []:
            pair = frozenset((first_id, second_id))
            if (
                first_id == second_id
                or pair in joined
                or not all(key in parts for key in pair)
            ):
                continue
            joined.add(pair)
            model.AddNoOverlap([
                interval for key, interval in zip(keys, pupils)
                if key in pair
            ])
        solver = cp_model.CpSolver()
        solver.parameters.num_workers = 1
        solver.parameters.max_time_in_seconds = left
        status = _solve_guarded(
            solver, model, what="a group without the daily maximum", request_id=request.request_id,
        )
        return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)

    def _travel_verdict(
        self,
        request: OptimizeScheduleRequest,
        conflicts: ConflictAnalysis,
        *,
        seconds_left: float | None = None,
    ) -> ConflictAnalysis:
        """Keep the walk in a refusal only where it is a cause, and name whose.

        THE DAILY MAXIMUM'S VERDICT, for the walk, and for its reason: a core is
        close to all or nothing on these models, and a literal per teacher,
        group and pair of groups puts the walk into nearly every refusal of a
        school that has turned it on, whatever the cause. So it is measured:
        - The week is solved once more without the walk, every other rule in
          force, on the probe's budget and never more than the solve has left.
          A timetable means the walk is what makes the week impossible
          (`measured` 1), and each party's line names the teachers, or groups,
          that timetable leaves short of a walk — read as the rows hold it
          (travel.breached). A party the timetable leaves short of none is no
          part of the answer, since that same timetable keeps its walk, and
          its line goes.
          That timetable proves that dropping the walk for those named is
          enough, and not that each of them needs it: it was found without
          the walk and keeps a walk only where it happens to, so the sentence
          says what the timetable shows and never "cannot be kept". A party
          the timetable names and the core left out gets its line too.
        - Still impossible: the walk is not needed for the proof, which does
          not make it no cause. Each family is measured on its own
          (_held_back_by_travel), the core's own first: one that cannot be
          placed with the walk and can without it keeps its line, `measured`
          2; a party whose families the caps left unanswered keeps the line
          the core gave it, `measured` 0.
        - None held back, every family answered: the walk may still be a cause
          only TOGETHER — three teachers who each fit alone and not with one
          laboratory between them, beside a second cause the probe keeps
          (_walk_against_the_fixed_part). Where the week's fixed part refuses
          the walk and holds without it, the lines stay, `measured` 0; where
          it holds the walk, the lines go, and a core that was nothing else is
          then CONFLICT_NO_CORE.
        - Nothing inside the budget, no budget, a probe that could not be
          built or solved, or a family the deadline left unanswered: the lines
          stay as the core gave them, `measured` 0. An unmeasured walk is
          never read as one measured and found innocent.

        A measured line leads the refusal, as the daily maximum's does: it is
        the one line on it that was checked. The core's other lines beside it
        are judged by _lines_that_stand: beside `measured` 1 only what is
        measured stands, beside `measured` 2 the core's lines stay, room lines
        measured against the week without the walk.
        """
        lines = [
            detail for detail in conflicts.conflicts
            if detail.code in TRAVEL_CODES.values()
        ]
        if not lines:
            return conflicts
        step = _start_step(request, self._grid)
        travel = travel_map(request, slot_minutes=self._grid.slot_minutes, step=step)
        if travel is None:
            return conflicts
        budget = self._settings.solver_probe_seconds
        if seconds_left is not None:
            budget = min(budget, seconds_left)
        if budget < self.MIN_PHASE_SECONDS:
            return conflicts
        deadline = time.monotonic() + budget
        others = [detail for detail in conflicts.conflicts if not any(detail is line for line in lines)]
        party_of = {code: party for party, code in TRAVEL_CODES.items()}

        def said(
            measured: int,
            named: dict[Party, list[UUID]],
            unanswered: set[Party] | frozenset[Party] = frozenset(),
        ) -> ConflictAnalysis:
            kept: list[ConflictDetail] = []
            for line in lines:
                ids = named.get(party_of[line.code], [])
                if not ids:
                    # A party the measurement could not finish keeps the line
                    # the core gave it, `measured` 0: unmeasured is never read
                    # as measured and found innocent.
                    if party_of[line.code] in unanswered:
                        kept.append(line)
                    continue
                # The core's own first and in its order, then any the
                # measurement adds, as the daily maximum's line is built.
                ordered = [rid for rid in line.resource_ids if rid in ids]
                ordered += [rid for rid in ids if rid not in ordered]
                kept.append(ConflictDetail(
                    category=line.category,
                    code=line.code,
                    params={**line.params, "measured": measured},
                    requirement_ids=line.requirement_ids,
                    room_ids=line.room_ids,
                    constraint_ids=line.constraint_ids,
                    resource_ids=ordered,
                ))
            # A party the measurement names and the core did not: its line, as
            # the model registers it, under the same measurement.
            for party, code in TRAVEL_CODES.items():
                ids = named.get(party, [])
                if ids and not any(party_of[line.code] == party for line in lines):
                    kept.append(ConflictDetail(
                        category=TRAVEL_CATEGORIES[party],  # type: ignore[arg-type]
                        code=code,
                        params={"stepMinutes": travel.step_minutes, "measured": measured},
                        resource_ids=list(ids),
                    ))
            standing = others
            if kept and measured in (1, 2):
                standing = self._lines_that_stand(request, others, measured, deadline=deadline)
            if not kept and not standing:
                return no_core_analysis()
            return conflicts.model_copy(update={"conflicts": [*kept, *standing]})

        status, short = self._without_the_walk(request, travel, budget)
        if short is not None:
            if not short["TEACHER"] and not short["PUPILS"]:
                # A timetable without the walk that keeps every walk would be
                # a timetable with it, which the proof rules out: the reading
                # and the rows disagree. Say nothing measured rather than
                # something false.
                logger.error(
                    "travel probe [requestId=%s]: a timetable without the walk keeps "
                    "every walk on a week proved impossible with it",
                    request.request_id,
                )
                return conflicts
            return said(1, short)
        if status != cp_model.INFEASIBLE:
            return conflicts
        held, unanswered = self._held_back_by_travel(
            request, travel, deadline=deadline,
            first={rid for line in lines for rid in line.resource_ids},
        )
        if held["TEACHER"] or held["PUPILS"]:
            return said(2, held, unanswered)
        if unanswered:
            return conflicts
        if self._walk_against_the_fixed_part(request, deadline=deadline) is not False:
            return conflicts
        return said(2, held)

    def _without_the_walk(
        self, request: OptimizeScheduleRequest, travel: TravelMap, seconds: float,
    ) -> tuple[int, dict[Party, list[UUID]] | None]:
        """The week solved once more without the walk, every other rule in force.

        The status, and with a timetable whom it leaves short of a walk, read
        as the rows hold it (travel.breached): None without one. A week that
        refuses by name without the walk is UNKNOWN here, not a finding.
        """
        without = request.model_copy(update={"site_travel_times": []})
        try:
            model, _, decisions, plan, _ = self._build_model(
                without, use_assumptions=False, include_objective=False,
            )
        except InvalidScheduleInputError:
            return cp_model.UNKNOWN, None
        probe = cp_model.CpSolver()
        probe.parameters.max_time_in_seconds = max(0.0, seconds)
        status = _solve_guarded(
            probe, model, what="the travel probe", request_id=request.request_id,
        )
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return status, None
        rooms = plan.assign_rooms(probe)
        placed = {
            decision.lesson.key(): Placed(
                key=decision.lesson.key(),
                start=probe.Value(decision.start),
                end=probe.Value(decision.start) + decision.duration,
                lead=decision.lead,
                trail=decision.trail,
                site=travel.site_of_room.get(request.rooms[rooms[decision.lesson.key()]].id),
            )
            for decision in decisions
        }
        return status, breached(
            travel,
            families_of(decisions, request.group_conflicts),
            placed,
            self._locked_travel_pairs(request, decisions, travel),
            self._grid.slots_per_day,
        )

    def _travel_without_core(
        self, request: OptimizeScheduleRequest, *, seconds_left: float | None = None,
    ) -> ConflictAnalysis | None:
        """Name the walk in a proved INFEASIBLE week the explanation said nothing about.

        _blocks_verdict's reasoning, for the other rule a school turns on to
        make its week narrower: the explaining solve can run out of its cap on
        a week the walk alone makes impossible, and an unexplained refusal
        then sends a school with two sites everywhere but to the rule it just
        turned on. So the week is solved once more without the walk, on the
        probe's budget and never more than the solve has left; a timetable
        names, for each party, whom it leaves short of a walk (`measured` 1,
        as _travel_verdict's lines are), under TRAVEL_PROBE_SUMMARY. None when
        there is no budget, no timetable, or one that keeps every walk.
        """
        travel = travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        )
        if travel is None:
            return None
        budget = self._settings.solver_probe_seconds
        if seconds_left is not None:
            budget = min(budget, seconds_left)
        if budget < self.MIN_PHASE_SECONDS:
            return None
        started = time.perf_counter()
        _status, short = self._without_the_walk(request, travel, budget)
        if not short or not (short["TEACHER"] or short["PUPILS"]):
            return None
        return ConflictAnalysis(
            summary_code="TRAVEL_PROBE_SUMMARY",
            summary_params={"seconds": round(time.perf_counter() - started, 1)},
            conflicts=[
                ConflictDetail(
                    category=TRAVEL_CATEGORIES[party],  # type: ignore[arg-type]
                    code=TRAVEL_CODES[party],
                    params={"stepMinutes": travel.step_minutes, "measured": 1},
                    resource_ids=list(ids),
                )
                for party, ids in short.items()
                if ids
            ],
        )

    def _walk_against_the_fixed_part(
        self, request: OptimizeScheduleRequest, *, deadline: float,
    ) -> bool | None:
        """Whether the walk is a cause together with the week's fixed part alone.

        The week with every rule a literal stands for set aside but the walk —
        starts, rooms and their types, overlaps, locked lessons, every family's
        walk — and then without the walk too. Impossible with it and possible
        without it is a walk that is a cause across families, which no family
        measured alone shows (the review's three teachers, one laboratory and
        a second cause beside them): True. A timetable with the walk, or a
        fixed part impossible even without it: False, the walk is not the
        matter. None when either solve did not answer by `deadline`, or in
        TRAVEL_JOINT_CAP_SECONDS each: plain searches, not the planned sites.
        The weeks it decides (the review's: three teachers, one laboratory)
        are a few dozen lessons and answer at once; on the högstadium week
        the two searches through the planned sites took 17 s to answer
        UNKNOWN twice, which kept the lines at `measured` 0 as an unanswered
        check does anyway.
        """
        if deadline - time.monotonic() < self.MIN_PHASE_SECONDS:
            return None
        try:
            model, registry, _decisions, _plan, _ = self._build_model(
                request, use_assumptions=True, include_objective=False,
            )
        except InvalidScheduleInputError:
            return None
        # Every literal free: the fixed part is what no literal stands for.
        model.ClearAssumptions()
        bare = model.Clone()
        model.AddBoolAnd(registry.literals(TRAVEL_CODES.values()))

        def tried(candidate: cp_model.CpModel, what: str) -> int:
            left = min(self.TRAVEL_JOINT_CAP_SECONDS, deadline - time.monotonic())
            if left < 0.1:
                return cp_model.UNKNOWN
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = left
            return _solve_guarded(solver, candidate, what=what, request_id=request.request_id)

        status = tried(model, "the walk against the fixed part")
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return False
        if status != cp_model.INFEASIBLE:
            return None
        status = tried(bare, "the fixed part without the walk")
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return True
        return False if status == cp_model.INFEASIBLE else None

    #: Restid i generatorn's refusal, kept to a couple of seconds over the
    #: same refusal without the walk (the review measured 28.8 s against
    #: 1.3 s on the högstadium week at four lessons a day, 17 s of it in the
    #: joint check below answering UNKNOWN twice). Each is a hard cap, inside
    #: the verdict's own deadline: the joint check per solve, the family
    #: pass as a whole, the room lines as a whole and per line. The weeks
    #: where these answer — a few dozen lessons — answer in milliseconds; on
    #: a large week they answered nothing in any time the school would wait.
    TRAVEL_JOINT_CAP_SECONDS = 1.0
    TRAVEL_FAMILIES_CAP_SECONDS = 1.0
    TRAVEL_ROOM_LINES_CAP_SECONDS = 2.0
    TRAVEL_ROOM_LINE_CAP_SECONDS = 0.5

    #: The core's room lines, which the walk drags in: a lesson's site is its
    #: room's, so the literals that keep a lesson in its own kind of room sit
    #: in nearly every core the walk is in. See _lines_that_stand.
    ROOM_LINE_CODES = frozenset({
        "ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT", "ROOM_NO_ROOM_FOR_REQUIREMENT",
    })

    def _lines_that_stand(
        self,
        request: OptimizeScheduleRequest,
        lines: list[ConflictDetail],
        measured: int,
        *,
        deadline: float,
    ) -> list[ConflictDetail]:
        """The other lines of a refusal the walk is measured in, those that stand.

        BESIDE A LINE MEASURED 1 nothing unmeasured stands. That line says the
        week has a timetable once the walk is dropped for those it names,
        which is the whole of the answer; the core's other lines are at best
        other ways out, and the review found a lunch's and a block's beside
        it on weeks whose only cause was the walk. A line another verdict
        measured (`measured` 1 or 2: the daily maximum's) stands, and a room
        line stands where it is measured to restore the week on its own.

        BESIDE A LINE MEASURED 2 the week has other causes, and the core's
        lines are kept, room lines measured against the week WITHOUT the walk
        — which is impossible on its own, so a room line measured against the
        walk could never restore it, and a genuine second cause (two
        laboratory hours and one laboratory) would be hidden. A room line
        measured not to restore it goes; one the caps leave unmeasured stays.

        A ROOM LINE IS MEASURED AS A SCHOOL WOULD FIX IT, by the payload: the
        requirement's room type dropped and its group size set to one, so
        every room is eligible, and the week built again. Not by its literal,
        which only forbids room_index values: the classes a lesson may use
        come from the payload, so opening the literal never moved a lesson
        and no room line ever stood. First all the room lines at once — an
        open room holds no more than it did, so nothing impossible with all
        of them open is possible with one — and then, where that found a
        timetable, each alone, within TRAVEL_ROOM_LINES_CAP_SECONDS.
        """
        room_lines = [line for line in lines if line.code in self.ROOM_LINE_CODES]
        if measured == 1:
            standing_others = {
                id(line) for line in lines
                if line.code not in self.ROOM_LINE_CODES
                and line.params.get("measured") in (1, 2)
            }
        else:
            standing_others = {id(line) for line in lines if line.code not in self.ROOM_LINE_CODES}
        verdict: dict[int, bool | None] = {id(line): None for line in room_lines}
        if room_lines:
            stop = min(deadline, time.monotonic() + self.TRAVEL_ROOM_LINES_CAP_SECONDS)
            base = (
                request if measured == 1
                else request.model_copy(update={"site_travel_times": []})
            )

            def opened(chosen: list[ConflictDetail]) -> OptimizeScheduleRequest:
                ids = {rid for line in chosen for rid in line.requirement_ids}
                return base.model_copy(update={"requirements": [
                    requirement.model_copy(update={
                        "required_room_type": None, "student_group_size": 1,
                    }) if requirement.id in ids else requirement
                    for requirement in base.requirements
                ]})

            def restores(candidate: OptimizeScheduleRequest) -> bool | None:
                left = min(self.TRAVEL_ROOM_LINE_CAP_SECONDS, stop - time.monotonic())
                if left < 0.05:
                    return None
                try:
                    model, *_ = self._build_model(
                        candidate, use_assumptions=False, include_objective=False,
                    )
                except InvalidScheduleInputError:
                    return None
                solver = cp_model.CpSolver()
                solver.parameters.max_time_in_seconds = left
                status = _solve_guarded(
                    solver, model, what="the room lines", request_id=request.request_id,
                )
                if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                    return True
                return False if status == cp_model.INFEASIBLE else None

            together = restores(opened(room_lines))
            if together is False:
                verdict = {key: False for key in verdict}
            elif together:
                for line in room_lines:
                    verdict[id(line)] = restores(opened([line]))
        return [
            line for line in lines
            if id(line) in standing_others
            or (
                line.code in self.ROOM_LINE_CODES
                and (verdict[id(line)] or (measured == 2 and verdict[id(line)] is None))
            )
        ]

    def _locked_travel_pairs(
        self,
        request: OptimizeScheduleRequest,
        decisions: list[LessonDecision],
        travel: TravelMap,
    ) -> list[tuple[Party, tuple[UUID, ...], str, Placed]]:
        """Each generated lesson beside each locked one on a site it shares a party with.

        The pairs _add_fixed_lesson_constraints holds apart, keyed as its walk
        rows are (_fixed_relations), for travel.breached to read a timetable
        against: the locks are not in a response, so they are placed here at
        the window every builder blocks.
        """
        conflicts_with: dict[UUID, set[UUID]] = defaultdict(set)
        for first_id, second_id in request.group_conflicts or []:
            conflicts_with[first_id].add(second_id)
            conflicts_with[second_id].add(first_id)
        pairs: list[tuple[Party, tuple[UUID, ...], str, Placed]] = []
        for fixed in request.fixed_lessons:
            site = travel.site_of_room.get(fixed.room_id) if fixed.room_id else None
            if site is None:
                continue
            window = self._fixed_window(fixed)
            if window is not None:
                lock = Placed(
                    key=f"fixed_{fixed.id}", start=window[0], end=window[1], lead=0, trail=0,
                    site=site,
                )
            else:
                # Before or after the day's hours (outside_rows): placed at its
                # clock time, on its own day.
                outside = _fixed_lesson_outside(fixed, self._grid)
                if outside is None:
                    continue
                day_start, (start, end) = outside
                lock = Placed(
                    key=f"fixed_{fixed.id}", start=day_start + start, end=day_start + end,
                    lead=0, trail=0, site=site, day=day_start // self._grid.slots_per_day,
                )
            for decision in decisions:
                for party, resource_ids in _fixed_relations(
                    decision.lesson, fixed, conflicts_with,
                ):
                    pairs.append((party, resource_ids, decision.lesson.key(), lock))
        return pairs

    #: The most one family's placement, with or without the walk, may take: a
    #: few dozen intervals. One that takes longer proves nothing, and the
    #: family is not named.
    TRAVEL_ALONE_CAP_SECONDS = 0.5

    def _held_back_by_travel(
        self,
        request: OptimizeScheduleRequest,
        travel: TravelMap,
        *,
        deadline: float,
        first: set[UUID] | None = None,
    ) -> tuple[dict[Party, list[UUID]], set[Party]]:
        """The families the walk, and nothing about them but it, holds back.

        Each family alone — a teacher's lessons, a group's, or two groups'
        that share a pupil — on the starts its lessons were built on, the
        sites their rooms allow, its own no-overlap and the locked lessons it
        shares, and nothing of any other family: solved with its walk, and,
        when that finds nothing, without it. Impossible with the walk and
        possible without it names the family. What it rules out is a family no
        week could hold with its walk, whatever else the school changes, which
        is the one thing a line measured 2 claims. Room capacity is left out:
        it only lets more through, so a family named here is held back in the
        week too.

        The families whose ids are in `first` (the core's) come first, the
        rest in the order they are built (teachers, groups, pairs); each solve
        on one worker and capped at TRAVEL_ALONE_CAP_SECONDS, never past
        `deadline`. A family not reached, or not answered in time, is not
        named — and the second value is the parties with a family left
        unanswered either way it needed, which is what lets the verdict read
        an empty answer for a party as "none of them" rather than "none
        measured", and keep that party's line as the core gave it.
        """
        named: dict[Party, list[UUID]] = {"TEACHER": [], "PUPILS": []}
        deadline = min(deadline, time.monotonic() + self.TRAVEL_FAMILIES_CAP_SECONDS)
        try:
            model, _, decisions, plan, _ = self._build_model(
                request, use_assumptions=False, include_objective=False,
            )
        except InvalidScheduleInputError:
            return named, {"TEACHER", "PUPILS"}
        sites: dict[str, list[object]] = {}
        for key, _start, _duration, _room in plan.placements:
            forced = plan.forced_class.get(key)
            sites[key] = (
                [plan.class_sites[forced]]
                if forced is not None
                else list(dict.fromkeys(plan.class_sites[c] for c in plan.literals[key]))
            )
        conflicts_with: dict[UUID, set[UUID]] = defaultdict(set)
        for first_id, second_id in request.group_conflicts or []:
            conflicts_with[first_id].add(second_id)
            conflicts_with[second_id].add(first_id)
        by_key: dict[tuple[Party, tuple[UUID, ...]], list[Family]] = defaultdict(list)
        for family in families_of(decisions, request.group_conflicts):
            by_key[(family.party, family.resource_ids)].append(family)
        unanswered: set[Party] = set()
        order = sorted(
            by_key.items(),
            key=lambda item: not (first and set(item[0][1]) & first),
        )
        for (party, resource_ids), families in order:
            members = list({
                decision.lesson.key(): decision
                for family in families
                for decision in (*family.leaving, *family.arriving)
            }.values())
            # A family none of whose lessons can stand on a site a walk is
            # counted from has no row, with the walk or without it.
            if not any(site is not None for d in members for site in sites[d.lesson.key()]):
                continue
            if time.monotonic() >= deadline:
                unanswered.add(party)
                continue
            with_walk = self._family_alone(
                request, travel, party, resource_ids, families, members, sites,
                conflicts_with, walk=True, deadline=deadline,
            )
            if with_walk is None:
                unanswered.add(party)
            if with_walk is not False:
                continue
            without_walk = self._family_alone(
                request, travel, party, resource_ids, families, members, sites,
                conflicts_with, walk=False, deadline=deadline,
            )
            if without_walk is None:
                unanswered.add(party)
            if without_walk:
                for resource_id in resource_ids:
                    if resource_id not in named[party]:
                        named[party].append(resource_id)
        return named, unanswered

    def _family_alone(
        self,
        request: OptimizeScheduleRequest,
        travel: TravelMap,
        party: Party,
        resource_ids: tuple[UUID, ...],
        families: list[Family],
        members: list[LessonDecision],
        sites: dict[str, list[object]],
        conflicts_with: dict[UUID, set[UUID]],
        *,
        walk: bool,
        deadline: float,
    ) -> bool | None:
        """Whether one family's lessons fit their week alone; None when not answered.

        THE FAMILY'S OWN FIXED PART, AS THE MODEL POSTS IT, built afresh: each
        lesson on its starts, its no-overlap over the interval the party is
        occupied by (padded_of for a teacher, pupil_padded_of for pupils), a
        site from the ones its rooms allow, every locked lesson the model keeps
        it off with the same margins, and — with `walk` — the family's rows
        and the walk to each such lock, built by the same TravelRows as the
        week's, its literal pinned true.
        """
        left = min(self.TRAVEL_ALONE_CAP_SECONDS, deadline - time.monotonic())
        if left <= 0:
            return None
        model = cp_model.CpModel()
        horizon = self._grid.horizon
        local: dict[str, LessonDecision] = {}
        choices: dict[str, dict[object, cp_model.IntVar | None]] = {}
        for k, decision in enumerate(members):
            key = decision.lesson.key()
            domain = decision.starts or cp_model.Domain(0, horizon - decision.duration)
            start = model.NewIntVarFromDomain(domain, f"start_{k}")
            end = model.NewIntVar(0, horizon, f"end_{k}")
            model.Add(end == start + decision.duration)
            local[key] = LessonDecision(
                lesson=decision.lesson,
                start=start,
                duration=decision.duration,
                end=end,
                interval=model.NewIntervalVar(start, decision.duration, end, f"lesson_{k}"),
                room_index=model.NewConstant(0),
                changeover=decision.changeover,
                lead=decision.lead,
                trail=decision.trail,
                starts=decision.starts,
            )
            options = sites[key]
            if len(options) == 1:
                choices[key] = {options[0]: None}
            else:
                literals = {site: model.NewBoolVar(f"site_{k}_{i}") for i, site in enumerate(options)}
                model.AddExactlyOne(literals.values())
                choices[key] = dict(literals)
        lessons = list(local.values())
        # The family's own no-overlap families, as _add_teacher_no_overlap and
        # _add_group_no_overlap post them: a teacher's lessons together; a
        # group's together, and each pair of groups sharing a pupil together.
        # Never one across all of a hub's groups — two of its neighbours may
        # well run at once (a språkval's groups do), and holding them apart
        # would be a rule the week does not have.
        if party == "TEACHER":
            model.AddNoOverlap([padded_of(model, lesson) for lesson in lessons])
        else:
            # The PUPIL space, as _add_group_no_overlap and families_of key it.
            by_group: dict[UUID, list[LessonDecision]] = defaultdict(list)
            for lesson in lessons:
                by_group[pupil_key_of(lesson.lesson.requirement)].append(lesson)
            for members_of_group in by_group.values():
                model.AddNoOverlap([pupil_padded_of(model, lesson) for lesson in members_of_group])
            for first_id, second_id in request.group_conflicts or []:
                if first_id != second_id and first_id in by_group and second_id in by_group:
                    model.AddNoOverlap([
                        pupil_padded_of(model, lesson)
                        for lesson in (*by_group[first_id], *by_group[second_id])
                    ])
        pinned = model.NewBoolVar("walk")
        model.Add(pinned == 1)
        day_vars: dict[str, cp_model.IntVar] = {}
        rows = TravelRows(
            travel=travel,
            choices=choices,  # type: ignore[arg-type]
            register=lambda _party, _ids: pinned,
            day_var=lambda lesson: self._day_var(model, lesson, day_vars),
            slots_per_day=self._grid.slots_per_day,
            horizon=horizon,
        )
        if walk:
            for family in families:
                rows.add_family(model, Family(
                    family.party,
                    family.resource_ids,
                    tuple(local[d.lesson.key()] for d in family.leaving),
                    tuple(local[d.lesson.key()] for d in family.arriving),
                ))
        for fixed in request.fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                if walk:
                    self._walk_to_lock_outside(
                        model, rows, lessons, fixed, conflicts_with,
                        only=(party, resource_ids),
                    )
                continue
            fixed_site = (
                travel.site_of_room.get(fixed.room_id) if fixed.room_id is not None else None
            )
            for lesson in lessons:
                relations = [
                    relation
                    for relation in _fixed_relations(
                        lesson.lesson, fixed, conflicts_with,
                    )
                    if relation == (party, resource_ids)
                ]
                if not relations:
                    continue
                pupils = party == "PUPILS"
                before, after = self._add_window_avoidance(
                    model, lesson, window[0], window[1],
                    tag=f"fixed_{fixed.id}_{lesson.lesson.key()}",
                    guard=None,
                    margin=lesson.changeover,
                    lead=lesson.lead if pupils else 0,
                    trail=lesson.trail if pupils else 0,
                )
                if walk and fixed_site is not None:
                    rows.fixed_rows(model, lesson, window, fixed_site, before, after, relations)
        solver = cp_model.CpSolver()
        solver.parameters.num_workers = 1
        solver.parameters.max_time_in_seconds = left
        status = _solve_guarded(
            solver, model, what="a family's walk alone", request_id=request.request_id,
        )
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return True
        if status == cp_model.INFEASIBLE:
            return False
        return None

    def _blocks_verdict(
        self, request: OptimizeScheduleRequest, *, seconds_left: float | None = None,
    ) -> ConflictAnalysis | None:
        """Name the blocks of a proved INFEASIBLE week the core did not explain.

        The week is solved once more without its blocks, the requirements
        kept, on the satisfaction model and the probe's budget. A timetable
        found then means removing the blocks is enough, so the blocks are
        named, each as BLOCK_CANNOT_BE_PLACED, under a summary that says how it
        was established. Not one probe per block: that tells which subset
        would do, which the school learns faster by moving one entry and
        generating again, and it would multiply the wait on a week that is
        already refused.

        THE PROBE'S BUDGET, AND NEVER MORE THAN THE SOLVE HAS LEFT. The school
        asked for an answer within solver_max_time_seconds, and the proof and
        its explanation have already spent part of it; `seconds_left` is the
        rest. Below MIN_PHASE_SECONDS a solve is all presolve, so the probe is
        not run at all.

        None when the probe has no budget, the relaxed week refuses by name,
        or it finds nothing inside the budget: the unexplained verdict stands
        rather than an invented one. None as well for a request that turned its
        probes off.
        """
        if not _runs_probes(request):
            return None
        budget = self._settings.solver_probe_seconds
        if seconds_left is not None:
            budget = min(budget, seconds_left)
        blocks = _blocks_of(request.requirements)
        if budget < self.MIN_PHASE_SECONDS or not blocks:
            return None
        relaxed = _without_blocks(request)
        try:
            feas_model, _, decisions, plan, _ = self._build_model(
                relaxed, use_assumptions=False, include_objective=False,
            )
        except InvalidScheduleInputError:
            return None
        started = time.perf_counter()
        status, _ = self._probe_search(
            relaxed, feas_model, decisions, plan, budget, what="the blocks probe",
        )
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None
        return ConflictAnalysis(
            summary_code="BLOCK_PROBE_SUMMARY",
            summary_params={"seconds": round(time.perf_counter() - started, 1)},
            conflicts=[
                ConflictDetail(
                    category="TEACHING_BLOCK",
                    code="BLOCK_CANNOT_BE_PLACED",
                    params={"block": str(block_id)},
                    requirement_ids=[member.id for member in members],
                    resource_ids=[block_id],
                )
                for block_id, members in blocks.items()
            ],
        )

    def _probe_timeout(
        self, request: OptimizeScheduleRequest, *, deadline: float | None = None,
    ) -> ConflictAnalysis | None:
        """Name what does not fit, when nothing was proved.

        _explain_infeasible works from a proof: CP-SAT said INFEASIBLE, so
        assumptions can be asked which constraints the proof rests on. A TIMEOUT
        is UNKNOWN — no proof, no core — and the school was being handed a bare
        status with four freshly declared rules to guess between: the rasts, a
        corridor, the meal, the dining hall.

        So this measures instead. One rule at a time is switched off, the
        satisfaction model is rebuilt and given a slice of a short budget, and
        every relaxation that then FINDS a timetable is reported by name. Only
        rules the payload actually carries are tried, in the order the
        measurements rank them — the corridor first, because on a 12-class,
        96-group school it alone turns a one-second solve into the whole budget.

        Not a proof either: a relaxation that stays UNKNOWN in its slice says
        nothing, and the summary says so. But "with the corridor at 0 this week
        solves in four seconds" is a sentence a rektor can act on, and it is
        true.

        None for a request that turned its probes off, as for a deployment
        that set SOLVER_PROBE_SECONDS to zero: the TIMEOUT then stands bare.
        Likewise where the school keeps the walk and `deadline` came before
        any probe could run.
        """
        budget = self._settings.solver_probe_seconds
        if budget <= 0 or not _runs_probes(request):
            return None

        relaxations = self._timeout_relaxations(request)
        if not relaxations:
            return None
        # RESTID I GENERATORN: the walk's own probe first, where the school
        # keeps it. It is the rule this school turned on itself, the one whose
        # search is the hardest (the planned sites), and on a week that runs
        # out of time the probes run out of time too — the walk's goes before
        # `deadline` can take it.
        keeps_walk = any(code == "PROBE_SOLVED_WITHOUT_TRAVEL" for code, _ in relaxations)
        if keeps_walk:
            relaxations.sort(key=lambda item: item[0] != "PROBE_SOLVED_WITHOUT_TRAVEL")

        slice_seconds = max(self.MIN_PHASE_SECONDS, budget / len(relaxations))
        found: list[tuple[str, float]] = []
        probed = 0
        # What the walk's own probe did: how long it searched and what it
        # answered. None while it has not run.
        walk_probe: tuple[int, float] | None = None
        for code, relaxed in relaxations:
            # `deadline` (a week that keeps the walk; see solve()) bounds the
            # probes and their builds together: a probe that cannot have the
            # rest of its slice is not started, and the summary counts only
            # the rules that were probed.
            if deadline is not None and deadline - time.monotonic() < self.MIN_PHASE_SECONDS:
                break
            try:
                feas_model, _, decisions, plan, _ = self._build_model(
                    relaxed, use_assumptions=False, include_objective=False,
                )
            except InvalidScheduleInputError:
                # A relaxation can also make the payload refuse by name (a
                # sitting that no longer reaches a stage, say). Not a finding.
                continue
            seconds = slice_seconds
            if keeps_walk and code == "PROBE_SOLVED_WITHOUT_TRAVEL":
                # THE WALK'S PROBE TAKES THE WHOLE PROBE BUDGET. A slice of it
                # was too short to say anything: the högstadium week at seven
                # a day needs 14-21 s without the walk, and its slice was 6.7.
                # It is the answer a school with two sites can act on, so the
                # other rules yield: they get what it leaves, which on a large
                # week is nothing, and the summary counts only the rules that
                # ran. Their probes keep the walk, so on a week the walk's own
                # probe could not solve in the whole budget a slice of it
                # would not have solved them either.
                seconds = budget
            if deadline is not None:
                seconds = min(seconds, deadline - time.monotonic())
                if seconds < self.MIN_PHASE_SECONDS:
                    break
            probed += 1
            started = time.perf_counter()
            status, _ = self._probe_search(
                relaxed, feas_model, decisions, plan, seconds, what="the timeout probe",
            )
            if code == "PROBE_SOLVED_WITHOUT_TRAVEL":
                walk_probe = (status, time.perf_counter() - started)
            if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                found.append((code, time.perf_counter() - started))

        budget = round(self._settings.solver_max_time_seconds)
        if keeps_walk and not found:
            # WITH THE WALK KEPT ONLY WHAT RAN IS SAID. No probe ran when the
            # builds ate the probes' time (the review's slow setup on a
            # five-second candidate): no sentence, and the TIMEOUT stands bare
            # as it does where probes are off — "none of the 0 rules probed"
            # and "searching without it for 0 s" were both written about
            # searches that never happened. The summary names no time per
            # rule, because the walk's probe had more than the others; its
            # line carries its own seconds. And the line says what the probe
            # measured and nothing more: the 2,000-pupil week runs out of time
            # with the walk off as well, so "the walk is likely why" was a
            # claim nothing had measured. A walk probe that proved the week
            # impossible even without the walk measured that the walk is not
            # the difference, and gets no line.
            if probed == 0:
                return None
            return ConflictAnalysis(
                summary_code="PROBE_NOTHING_HELPED_WITH_TRAVEL",
                summary_params={"budget": budget, "rules": probed},
                conflicts=(
                    [ConflictDetail(
                        category="TIMEOUT_PROBE",
                        code="PROBE_TRAVEL_UNMEASURED",
                        params={"seconds": round(walk_probe[1], 1)},
                    )]
                    if walk_probe is not None and walk_probe[0] == cp_model.UNKNOWN
                    else []
                ),
            )
        if not found:
            return ConflictAnalysis(
                summary_code="PROBE_NOTHING_HELPED",
                summary_params={
                    "budget": budget,
                    "rules": len(relaxations),
                    "slice": round(slice_seconds),
                },
                conflicts=[],
            )
        # The rules are named in the details, one complete sentence each,
        # never joined into the summary: a list punctuated in English inside a
        # Swedish sentence is what a fragment param buys.
        return ConflictAnalysis(
            summary_code="PROBE_ONE_RULE_HELPED",
            summary_params={"budget": budget, "rules": len(found)},
            conflicts=[
                ConflictDetail(
                    category="TIMEOUT_PROBE",
                    code=code,
                    params={"seconds": round(seconds, 1)},
                )
                for code, seconds in found
            ],
        )

    def _timeout_relaxations(
        self, request: OptimizeScheduleRequest,
    ) -> list[tuple[str, OptimizeScheduleRequest]]:
        """The rules a timed-out week can be probed without, one at a time.

        Each is returned as the CODE of the sentence that reports it, so the
        finding reaches a school as one whole named sentence rather than an
        English fragment glued into a summary — a fragment cannot be
        translated into a language that inflects around it.

        Only what the payload carries, in the order the measurements rank them.
        THE TEACHERS' OWN TIME IS TWO, on the same principle — see there.
        THE LUNCH IS THREE THINGS, NOT ONE: the school's sittings per stage, the
        dining hall's seats, and the guaranteed break itself. The first probe
        reported "with the guaranteed lunch break switched off, a timetable was
        found in 0.1 s" — true, and useless, because a school cannot switch its
        lunch off. Which of the three it is decides what they do next: widen a
        sitting, count the chairs again, or move the window.
        """
        out: list[tuple[str, OptimizeScheduleRequest]] = []
        if any(f.changeover_minutes > 0 for f in request.frame_times):
            out.append((
                "PROBE_SOLVED_WITHOUT_CHANGEOVER",
                request.model_copy(update={
                    "frame_times": [
                        f.model_copy(update={"changeover_minutes": 0}) for f in request.frame_times
                    ],
                }),
            ))
        if any(
            requirement.minutes_before > 0 or requirement.minutes_after > 0
            for requirement in request.requirements
        ):
            # BESIDE THE CORRIDOR AND FOR THE SAME MEASURED REASON: it lengthens
            # the interval an overlap check sees, and that is what turns a
            # one-second week into a whole budget. Worse than the corridor per
            # minute, in fact — it lengthens at both ends, so two lessons of the
            # class cost lead + trail between them — and better to report,
            # because a school CAN act on it: somebody typed twenty minutes on a
            # requirement, and fifteen may do. Named apart from the corridor
            # because the two are different rows on different screens, and "the
            # margin between lessons" would send a rektor to the wrong one.
            out.append((
                "PROBE_SOLVED_WITHOUT_PUPIL_BUFFERS",
                request.model_copy(update={
                    "requirements": [
                        requirement.model_copy(
                            update={"minutes_before": 0, "minutes_after": 0},
                        )
                        for requirement in request.requirements
                    ],
                }),
            ))
        if travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        ) is not None:
            # RESTID I GENERATORN, beside the corridor and the pupils' margins
            # because it is the same kind of thing for the search: a gap the
            # overlap checks must leave, here only between two sites. One
            # probe for the whole rule, since it is one switch and one card: a
            # school told the walk is what the budget ran out on knows both
            # places it can act — the switch in Skolregler, the figures under
            # Rooms.
            out.append((
                "PROBE_SOLVED_WITHOUT_TRAVEL",
                request.model_copy(update={"site_travel_times": []}),
            ))
        if any(
            requirement.max_lessons_per_day is not None
            or requirement.min_days_between is not None
            for requirement in request.requirements
        ):
            # ONE PROBE FOR BOTH HALVES OF THE RULE, unlike the teachers' two
            # below, and the difference is where the fix lives. A teacher's
            # lunch and rest are two numbers a rektor weighs separately; a
            # subject's "at most N a day" and "not on consecutive days" sit
            # side by side in one dialog, and "with the subjects' distribution
            # rules dropped" sends the school to exactly that dialog, where it
            # can see which of the two a crowded week can spare. Every
            # requirement at once, because a timeout is a fact about the week
            # and a probe per subject would split a short budget into slices
            # too thin to find anything. The locked days stay: they say where
            # the school's own lessons are, which no relaxation changes.
            out.append((
                "PROBE_SOLVED_WITHOUT_DISTRIBUTION",
                request.model_copy(update={
                    "requirements": [
                        requirement.model_copy(
                            update={"max_lessons_per_day": None, "min_days_between": None},
                        )
                        for requirement in request.requirements
                    ],
                }),
            ))
        if _blocks_of(request.requirements):
            # EVERY BLOCK AT ONCE, for the reason the distribution is one probe
            # above: a timeout is a fact about the week, and a probe per block
            # would split a short budget into slices too thin to find anything.
            # The requirements stay, each with its own lessons; only the rule
            # that their lessons start together goes. Next to the
            # distribution because both are rules of the timplan page, about
            # how a row's lessons may lie.
            out.append(("PROBE_SOLVED_WITHOUT_BLOCKS", _without_blocks(request)))
        # THE TEACHERS' OWN TIME IS TWO PROBES AND NEVER ONE, for the reason the
        # lunch below is three: "with the teachers' working time switched off, a
        # timetable was found" is true and useless, because a school cannot
        # switch its teachers' working time off. A guaranteed lunch is widened or
        # shortened; a night's rest is a different number on the same row; and
        # which of the two it is decides what a rektor does next.
        #
        # HERE IN THE ORDER, and the place is measured rather than guessed. On
        # the 400-student nightly gate week, 33 teachers and 576 lessons, with
        # both halves given to every teacher: the lunch adds 330 variables of
        # 8,465 and no measurable time (7.6s against 7.8s), while the rest adds
        # 9,267 — it builds three per teacher, day and lesson where the lunch
        # builds two per teacher and day — and takes the satisfaction solve from
        # 7.8s to 11.1s. So the rest is probed first.
        if any(
            rule.min_daily_rest_minutes is not None
            for rule in request.teacher_work_rules
        ):
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_REST",
                request.model_copy(update={
                    "teacher_work_rules": [
                        rule.model_copy(update={"min_daily_rest_minutes": None})
                        for rule in request.teacher_work_rules
                    ],
                }),
            ))
        # LÄRARENS DAG IS TWO PROBES AS WELL, for the same reason and one more:
        # the cap is a number on the work rule and the days a number on the
        # post, two screens and two people — and the days are HR, so a single
        # probe naming both would leave a reader without HR access unable to
        # tell whether the fix is theirs to make. The days probe names no post
        # and no figure; it says only that some post limits its days.
        #
        # BETWEEN THE REST AND THE LUNCH, AND THE DAYS FIRST. After the rest,
        # whose 9,267 variables on the gate week are an order more than these
        # cost (the högstadium week's three caps add 336 variables to 6,627,
        # its three posts 258); before the lunch, which adds no measurable
        # time. The days before the cap because a days limit is the harder of
        # the two to search: a pigeonhole over day literals, where a cap is
        # one sum a day. Measured on the högstadium week with one worker and
        # fixed seeds, so the host's load does not enter the number: to a
        # first timetable the three posts alone took 2.8 and 5.1 units of
        # deterministic time and one seed in three was still searching at
        # 240 s, the three caps alone 0.9 to 4.5, and neither 0.2 to 0.3. The
        # same week's deliberately impossible post
        # (benchmarks/hogstadium.py --infeasible-days) was still UNKNOWN after
        # 60 s with the linking rows taken out. Each probe keeps the other
        # rule, or a finding would name one and measure two.
        if request.teacher_day_limits:
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS",
                request.model_copy(update={"teacher_day_limits": []}),
            ))
        if any(
            rule.max_teaching_minutes_per_day is not None
            for rule in request.teacher_work_rules
        ):
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP",
                request.model_copy(update={
                    "teacher_work_rules": [
                        rule.model_copy(update={"max_teaching_minutes_per_day": None})
                        for rule in request.teacher_work_rules
                    ],
                }),
            ))
        if any(rule.has_lunch for rule in request.teacher_work_rules):
            out.append((
                "PROBE_SOLVED_WITHOUT_TEACHER_LUNCH",
                request.model_copy(update={
                    "teacher_work_rules": [
                        rule.model_copy(update={
                            "lunch_minutes": None,
                            "lunch_start_time": None,
                            "lunch_end_time": None,
                        })
                        for rule in request.teacher_work_rules
                    ],
                }),
            ))
        if any(rast.requires_lesson_before for rast in request.rasts):
            # BEFORE the rasts themselves, and separately from them, for the
            # reason the lunch is three probes and not one: "with the rasts
            # removed" is true and useless, because a school cannot delete its
            # breaks. This one it can act on — it is a switch somebody ticked,
            # and the only rast setting that makes the model bigger rather
            # than smaller.
            out.append((
                "PROBE_SOLVED_WITHOUT_LESSON_BEFORE_RAST",
                request.model_copy(update={
                    "rasts": [
                        rast.model_copy(update={"requires_lesson_before": False})
                        for rast in request.rasts
                    ],
                }),
            ))
        if request.rasts:
            out.append(("PROBE_SOLVED_WITHOUT_RASTS", request.model_copy(update={"rasts": []})))
        rules = request.rules
        if rules is not None and _lunch_window_is_set(rules):
            if request.lunch_servings:
                out.append((
                    "PROBE_SOLVED_WITHOUT_SERVINGS",
                    request.model_copy(update={"lunch_servings": []}),
                ))
            if rules.dining_seats is not None:
                out.append((
                    "PROBE_SOLVED_WITHOUT_DINING_SEATS",
                    request.model_copy(update={
                        "rules": rules.model_copy(update={"dining_seats": None}),
                    }),
                ))
            out.append((
                "PROBE_SOLVED_WITHOUT_LUNCH",
                request.model_copy(update={
                    "lunch_servings": [],
                    "rules": rules.model_copy(update={
                        "lunch_start_time": None,
                        "lunch_end_time": None,
                        "lunch_minutes": None,
                        "dining_seats": None,
                    }),
                }),
            ))
        return out

    def _timeout_diagnosis(self, request: OptimizeScheduleRequest, why: str) -> str:
        """One line naming what shaped the model that would not solve.

        A TIMEOUT carries no conflict core — UNKNOWN is not a proof — so the
        response cannot say what made the week hard, and the school is left
        guessing between the rasts it just declared, a corridor it just wrote
        and a dining hall that became real. The log can say which of those
        were in force. Measured on a 12-class, 96-group school: the same
        payload solves in 1 s with no corridor and burns the whole budget with
        five minutes of one, so the corridor is named first.
        """
        lessons = sum(r.lessons_per_week for r in request.requirements)
        corridor = max((f.changeover_minutes for f in request.frame_times), default=0)
        # The widest SUM, not the widest single number: what the model pays per
        # lesson is the two ends together, and a requirement asking 10 before and
        # 20 after is a thirty-minute lesson longer than it looks.
        buffer_minutes = max(
            (r.minutes_before + r.minutes_after for r in request.requirements),
            default=0,
        )
        seats = request.rules.dining_seats if request.rules is not None else None
        # THE NUMBER THE MODEL FED, not the length of `groups`. They differ
        # exactly where this line matters most: a payload that names nobody is
        # still owed a meal per group with lessons, and reading the list's
        # length reported "0 groups eating" over a model carrying eighty lunch
        # intervals — naming as absent the very thing that shaped the week.
        # Zero without a lunch window, where the field says nothing either way.
        eating = (
            len(_lunch_group_ids(
                request.groups, _group_ids_with_lessons(request.requirements),
            ))
            if request.rules is not None and _lunch_window_is_set(request.rules)
            else 0
        )
        # How far apart the starts were searched. Equal to the grid means one
        # time somewhere off the week's coarser step — a lock at 08:05, a
        # 45-minute lesson among hours — put the whole school on every slot.
        step_minutes = _start_step(request, self._grid) * self._grid.slot_minutes
        # THE RULES THE MODEL ACTUALLY BUILT, not the length of the list, for the
        # reason the `eating` count above gives: a row naming a teacher the
        # timplan gives no lesson builds nothing at all, and a line reporting it
        # as in force would name as the week's shape a rule that never touched
        # it. Counted here rather than off the builder because this line is
        # written on a path where no model survives to be asked.
        with_lessons = {
            teacher_id
            for requirement in request.requirements
            for teacher_id in _teachers_of(requirement)
        }
        teacher_lunches = sum(
            1
            for rule in request.teacher_work_rules
            if rule.has_lunch and rule.teacher_id in with_lessons
        )
        teacher_rests = sum(
            1
            for rule in request.teacher_work_rules
            if rule.min_daily_rest_minutes is not None
            and rule.teacher_id in with_lessons
        )
        # Lärarens dag on the same terms. A count of posts with a limit, never
        # which post or how many days: the gateway masks the figure on read
        # for whoever may not see it, and a log line has no reader to mask for.
        teacher_caps = sum(
            1
            for rule in request.teacher_work_rules
            if rule.max_teaching_minutes_per_day is not None
            and rule.teacher_id in with_lessons
        )
        teacher_day_limits = sum(
            1 for limit in request.teacher_day_limits if limit.teacher_id in with_lessons
        )
        # The wishes the full model prices; the satisfaction phase that timed
        # out built none of them, and the cleared clone carries them as free
        # variables, which is why they are worth a number here at all.
        free_day_wishes = len(self._free_day_wishes(request, self._resolve_weights(request)))
        # Requirements carrying an ämnesfördelning, either half. Off the
        # requirements themselves, which are exactly what the model built from:
        # a requirement in the payload has lessons left to place.
        distribution_rules = sum(
            1
            for requirement in request.requirements
            if requirement.max_lessons_per_day is not None
            or requirement.min_days_between is not None
        )
        # Parallella block the model held together: two or more members each.
        blocks = len(_blocks_of(request.requirements))
        # Restid i generatorn: the walks the model held, and the longest of
        # them as the step made it. Counts and minutes only, as every number
        # on this line.
        travel = travel_map(
            request, slot_minutes=self._grid.slot_minutes, step=_start_step(request, self._grid),
        )
        travel_pairs = len(travel.slots) if travel is not None else 0
        travel_minutes = travel.longest * self._grid.slot_minutes if travel is not None else 0
        # One sentence per thing worth trying at zero, in the order the
        # measurements rank them, and none at all for a week that carries
        # neither — the line already says what was in force, and advice about a
        # rule nobody wrote is noise in a log somebody is reading at speed.
        hints = []
        if corridor > 0:
            hints.append(
                "A changeover lengthens every lesson for the overlap check and is the "
                "first thing to try at 0.",
            )
        if buffer_minutes > 0:
            hints.append(
                "A pupil buffer lengthens it at BOTH ends for the classes' own "
                "families — the teacher and the room are left free — so two lessons "
                "of one class cost the sum between them; worth a run at 0.",
            )
        return (
            f"TIMEOUT ({why}) [requestId={request.request_id}]: {lessons} lessons, "
            f"{len(request.requirements)} requirements, {eating} groups eating, "
            f"changeoverMinutes={corridor}, "
            f"pupilBufferMinutes={buffer_minutes}, rasts={len(request.rasts)}, "
            f"frameTimes={len(request.frame_times)}, diningSeats={seats}, "
            f"fixedLessons={len(request.fixed_lessons)}, "
            f"teacherLunches={teacher_lunches}, teacherRests={teacher_rests}, "
            f"teacherDailyCaps={teacher_caps}, teacherDayLimits={teacher_day_limits}, "
            f"freeDayWishes={free_day_wishes}, "
            f"distributionRules={distribution_rules}, blocks={blocks}, "
            f"travelPairs={travel_pairs}, travelMinutes={travel_minutes}, "
            f"startStepMinutes={step_minutes}, "
            f"budget={self._settings.solver_max_time_seconds}s. "
            + " ".join(hints)
        )

    def _create_lesson_decisions(
        self,
        model: cp_model.CpModel,
        requirements: list[AnonymousRequirement],
        room_count: int,
        frames: list[FrameTime],
        rasts: list[Rast],
        *,
        step: int,
    ) -> list[LessonDecision]:
        decisions: list[LessonDecision] = []
        horizon = self._grid.horizon
        lattice = _start_lattice(step, horizon)

        # EACH REQUIREMENT ITS OWN STARTS, a block's members included. Their
        # common starts follow from the equalities under the block's literal
        # (_add_block_constraints), and only from them: a member's domain cut
        # to the block's here would be a narrowing no literal carries, so a
        # week the block makes impossible — a closure inside the hours two
        # members' frames share — would be proved without the block and named
        # as the closure alone. Presolve intersects the equal starts once the
        # literal is pinned true, so the search sees the same narrowed domains.
        domains_of = {
            requirement.id: self._start_domains(requirement, frames, rasts, lattice)
            for requirement in requirements
        }

        for requirement in requirements:
            span = span_of(requirement)
            changeover = changeover_slots(frames, span, self._grid)
            lead = -(-requirement.minutes_before // self._grid.slot_minutes)
            trail = -(-requirement.minutes_after // self._grid.slot_minutes)
            domains = domains_of[requirement.id]
            lengths = [self._grid.minutes_to_slots(m) for m in requirement.lesson_minutes()]
            for lesson_index, duration in enumerate(lengths):
                lesson = LessonInstance(requirement=requirement, lesson_index=lesson_index)
                start = model.NewIntVarFromDomain(domains[duration], f"start_{lesson.key()}")
                end = model.NewIntVar(duration, horizon, f"end_{lesson.key()}")
                interval = model.NewIntervalVar(start, duration, end, f"interval_{lesson.key()}")
                model.Add(end == start + duration)
                room_index = model.NewIntVar(0, room_count - 1, f"room_{lesson.key()}")
                decisions.append(
                    LessonDecision(
                        lesson=lesson,
                        start=start,
                        duration=duration,
                        end=end,
                        interval=interval,
                        room_index=room_index,
                        changeover=changeover,
                        lead=lead,
                        trail=trail,
                        starts=domains[duration],
                    ),
                )

        return decisions

    def _start_domains(
        self,
        requirement: AnonymousRequirement,
        frames: list[FrameTime],
        rasts: list[Rast],
        lattice: cp_model.Domain | None,
    ) -> dict[int, cp_model.Domain]:
        """The starts each length of a requirement may take, one domain per length.

        Read by _create_lesson_decisions, which builds the variables on them,
        and by _validate_blocks, which refuses a block whose members share none
        of their starts before the model.
        One computation for both, for the reason the margins' refusal gives for
        sharing its arithmetic with the builder: two would disagree.
        """
        slots_per_day = self._grid.slots_per_day
        # One interval per day, each ending in time for the lesson to finish
        # before that day does. A single contiguous [0, horizon - duration]
        # range would also admit starts near a day's end, which put a lesson
        # across the 18:00 -> 08:00 boundary: reported as e.g. "Monday
        # 17:30-18:30" (past the configured day end) while the model has
        # actually reserved the teacher, group and room for Tuesday morning.
        #
        # RAMTIDER NARROW THIS DOMAIN RATHER THAN FORBIDDING INTERVALS IN
        # IT. A frame is a positive window, so the hours it closes never
        # become variables at all — which is the whole reason a frame is its
        # own row and not the two UNAVAILABLE constraints around it. With no
        # frames every day is (0, slots_per_day) and this is the expression
        # it always was. _validate_request has already refused the case
        # where the WINDOWS leave a requirement nowhere to go, so every
        # interval below is non-empty as far as the windows go.
        #
        # AND THE MARGINS BELOW ARE IN A REFUSAL OF THEIR OWN, beside that
        # one: a lesson that fits its stage's window exactly, whose margin
        # then does not, used to empty this domain and reach the caller as
        # CP-SAT's own "var has no domain" — a 500 where a named 4xx belongs.
        # The corridor can only do it where a frame reaches the day's end,
        # which is older than the pupils' buffer; a lead can do it wherever a
        # window is exactly as wide as the lesson and opens on the day's
        # first slot. MARGIN_NO_WINDOW_FOR_REQUIREMENT names the margin
        # rather than blaming the frame for minutes it does offer, and is
        # deliberately not folded into FRAME_NO_WINDOW_FOR_REQUIREMENT, whose
        # sentence would then be untrue about the frame. Its arithmetic is
        # the arithmetic below, and the two must stay the same one: a check
        # that rounded differently would either refuse a week this builds
        # perfectly well or let the 500 back through.
        span = span_of(requirement)
        windows = day_windows(frames, span, self._grid)
        changeover = changeover_slots(frames, span, self._grid)
        # The pupils' own margin, rounded UP for the reason a corridor is:
        # it is a floor on time the class is unavailable, so a value that
        # misses the grid takes the next whole slot rather than lose the
        # remainder. Seven minutes on a five-minute grid is two slots.
        lead = -(-requirement.minutes_before // self._grid.slot_minutes)
        trail = -(-requirement.minutes_after // self._grid.slot_minutes)
        # THE DAY'S EDGE IS CLIPPED IN THE DOMAIN, not with a constraint.
        #
        # A padded interval runs `changeover` slots past the lesson, and the
        # horizon addresses day d as [d*spd, (d+1)*spd) — so an unclipped
        # last lesson would pad into tomorrow morning's slots and collide
        # with a lesson that is not on the same day at all.
        #
        # BOTH EDGES NOW, because the pupils' interval reaches backwards as
        # well: it starts `lead` slots before the lesson, and a first lesson
        # left unclipped would have its changing room in YESTERDAY's last
        # slots — the same collision in the other direction, and an interval
        # with a start below the horizon's floor on day 0 besides.
        #
        # Two other fixes were considered and both are worse. A guard band
        # in TimeGrid (a `day_stride` wider than `slots_per_day`) re-encodes
        # every absolute slot for every school, so the next regeneration
        # moves lessons across the whole estate — and two places decode with
        # `// slots_per_day` that a rename would miss silently. An
        # AddMinEquality against the day's end costs an IntVar and a
        # constraint per lesson. Clipping the bounds costs nothing.
        #
        # THE FRAME BOUNDS THE TEACHING, THE DAY'S EDGE BOUNDS THE BODIES,
        # which is why the two compose as a min and a max rather than by
        # subtraction. A frame says which hours a stage may be TAUGHT in: a
        # lesson may end exactly at its close and still let the corridor and
        # the shower run past it, exactly as the corridor has always been
        # allowed to. What may not happen is either margin crossing into a
        # neighbouring day, and that is the day's own edge talking. So the
        # close is clipped with the whole trailing margin and the open is
        # raised only where the lead would otherwise reach below the day.
        #
        # The price is that the last lesson of a day may not END later than
        # the day's close minus those margins, which binds only for a school
        # teaching to 18:00 with no ramtid. Wherever a frame closes earlier,
        # `close_slot - duration` is the tighter bound and nothing is lost.
        #
        # ONE DOMAIN PER LENGTH. A requirement of 1 × 80 + 1 × 40 has two
        # kinds of lesson, and the last start of a day is the close minus
        # the lesson, so the 40 may start forty minutes later than the 80.
        # Built once per distinct length, longest first; a uniform
        # requirement builds the one domain it always built. Every check
        # _validate_request makes reads the longest, and a window, a margin
        # or a rast that holds the longest holds every shorter lesson too,
        # so no domain built here is empty where the longest's is not.
        domains: dict[int, cp_model.Domain] = {}
        lengths = [self._grid.minutes_to_slots(m) for m in requirement.lesson_minutes()]
        for duration in sorted(set(lengths), reverse=True):
            day_ranges: list[list[int]] = []
            for day, (open_slot, close_slot) in sorted(windows.items()):
                first = max(open_slot, lead)
                last = min(close_slot, slots_per_day - changeover - trail) - duration
                # A day too narrow for this lesson drops out here rather than
                # reaching Domain.FromIntervals as a reversed pair. That happens
                # to be safe today — FromIntervals discards such a pair silently
                # — but it is undocumented behaviour to hang a whole feature's
                # correctness on, and "silently discards" is one release away
                # from "raises".
                if last < first:
                    continue
                day_ranges.append(
                    [day * slots_per_day + first, day * slots_per_day + last],
                )
            start_domain = cp_model.Domain.FromIntervals(day_ranges)

            # RASTER CUT HOLES IN THE SAME DOMAIN, for the reason the paragraph
            # above gives for frames: the minutes a stage is free never become
            # variable values at all. No new variables, no new constraints, and
            # a strictly smaller search space than the same model without them.
            # _validate_request has already refused the case where the holes
            # leave a requirement nowhere to go on any day, so what remains here
            # is never empty.
            #
            # LESSONS ONLY. The lunch interval is deliberately NOT narrowed the
            # same way, and the reason is in the Swedish word: a lunchrast IS a
            # rast. A school that writes "lunchrast 11:30-12:30" and lets the
            # engine seat its classes inside it is describing the ordinary case,
            # and subtracting the rast from the meal's domain would push the
            # meal out of exactly the window the school reserved for it — then
            # refuse the run when nowhere else is left. A rast keeps TEACHING
            # out; it has nothing to say about a break.
            if rasts:
                start_domain = start_domain.intersection_with(
                    self._rast_free_starts(rasts, span, duration),
                )
            # A BACKSTOP, NOT A PRE-FLIGHT. Everything above is the school's own
            # rows — frames, margins, rasts — so a domain they empty is a week
            # to refuse with the requirement named, never a model to hand
            # CP-SAT: an empty domain is not an INFEASIBLE but MODEL_INVALID,
            # which solve() raises as SolverBuildError and the school reads as
            # a 500 quoting `start_<requirement id>_0`. _validate_request
            # refuses every composition of the three by its own sentence
            # first, and a fuzz found two it once let through, so this sentence
            # is the generic one for the next rule that narrows a domain
            # without a refusal of its own. The warning is how we hear of it.
            if start_domain.is_empty():
                minutes = duration * self._grid.slot_minutes
                logger.warning(
                    "a %d-minute lesson reached the builder with no start; "
                    "_validate_request has no refusal for what emptied it",
                    minutes,
                )
                raise InvalidScheduleInputError.of("LESSON_NO_START_FOR_REQUIREMENT", {
                    "requirement": str(requirement.id),
                    "grades": (
                        "any"
                        if requirement.min_grade_level is None
                        else _grade_span_text(
                            requirement.min_grade_level, requirement.max_grade_level,
                        )
                    ),
                    "minutes": minutes,
                })
            # ON THE WEEK'S STEP, last. Every bound and hole above is cut on the
            # grid the school wrote it on, and only the starts between the
            # step's multiples go — none of which a timetable needs, and every
            # bound above is itself a multiple. _start_step says why.
            start_domain = _on_lattice(start_domain, lattice)
            # And the step can therefore never empty a domain the rows left
            # starts in. If it does, a constant is missing from _start_step's
            # gcd — our bug, not the school's, so a 500, and one whose message
            # names no requirement.
            if start_domain.is_empty():
                msg = (
                    f"the week's start step left a {duration}-slot lesson no start "
                    "its rows allow; _start_step is missing a constant"
                )
                raise SolverBuildError(msg)
            domains[duration] = start_domain
        return domains

    def _add_block_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        requirements: list[AnonymousRequirement],
    ) -> None:
        """Parallella block: the k-th lesson of every member starts with the k-th of the first.

        Språkval åk 7 is Tyska for Ty7, Franska for Fr7 and Spanska for Sp7. 7A
        shares pupils with all three, so without the block each language took
        a slot of 7A's week of its own wherever the search happened to put it;
        with it, the three are one slot of 7A's week per lesson.

        FEWER FREE STARTS, NOT MORE VARIABLES. One equality per member and
        lesson, on the start variables that already exist, each on its own
        member's domain (_create_lesson_decisions says why not the block's).
        With the literal pinned true, as every build but the explaining one
        pins it, presolve merges the equal starts into one variable per block
        lesson, on the intersection of the members' domains.
        The end follows, since the k-th lessons have the same length: the
        members have the same lesson lengths, longest first, or
        _validate_blocks refused them.

        ONE ASSUMPTION LITERAL PER BLOCK, carrying BLOCK_CANNOT_BE_PLACED and
        the block's id, which the gateway turns back into the block's name.
        Per block and not per lesson or member, because the school's fix is
        the block: its times, its groups, or taking an entry out of it. Every
        equality hangs on it, so a core can only blame the block by naming the
        literal, and lifting the literal lifts the whole block.

        The order of the lessons inside a member is the builder's, by length
        and then by index, and nothing else reads it: the lessons of one
        requirement are interchangeable, so holding the k-th to the k-th loses
        no timetable that holding the sets equal would keep.
        """
        blocks = _blocks_of(requirements)
        if not blocks:
            return
        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)
        for block_id, members in blocks.items():
            literal = registry.register(
                model,
                name=f"block_{block_id}",
                category="TEACHING_BLOCK",
                code="BLOCK_CANNOT_BE_PLACED",
                params={"block": str(block_id)},
                requirement_ids=[member.id for member in members],
                resource_ids=[block_id],
            )
            leader = by_requirement.get(members[0].id, [])
            for member in members[1:]:
                for first, other in zip(leader, by_requirement.get(member.id, [])):
                    model.Add(other.start == first.start).OnlyEnforceIf(literal)

    def _add_capacity_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
    ) -> None:
        for decision in decisions:
            requirement = decision.lesson.requirement
            allowed_indices = [
                idx for idx, room in enumerate(rooms) if self._room_allowed(room, requirement)
            ]
            if not allowed_indices:
                continue

            assumption = registry.register(
                model,
                name=f"capacity_{requirement.id}_{decision.lesson.lesson_index}",
                category="ROOM_CAPACITY",
                # Two codes rather than one sentence with an optional tail:
                # a translator cannot inflect around a clause that is
                # sometimes absent, and the room type is a token the school
                # named itself.
                code=(
                    "ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT"
                    if requirement.required_room_type
                    else "ROOM_NO_ROOM_FOR_REQUIREMENT"
                ),
                params=(
                    {
                        "requirement": str(requirement.id),
                        "groupSize": requirement.student_group_size,
                        "roomType": str(requirement.required_room_type),
                    }
                    if requirement.required_room_type
                    else {
                        "requirement": str(requirement.id),
                        "groupSize": requirement.student_group_size,
                    }
                ),
                requirement_ids=[requirement.id],
            )

            forbidden = [idx for idx in range(len(rooms)) if idx not in allowed_indices]
            for room_idx in forbidden:
                model.Add(decision.room_index != room_idx).OnlyEnforceIf(assumption)

    def _add_teacher_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
    ) -> None:
        """One teacher is one body: no overlapping lessons, corridor included.

        padded_of, NOT pupil_padded_of, and the line is the user's decision
        rather than an oversight. The minutes around an idrottslektion are the
        PUPILS' — changing and showering — and the teacher spends none of them
        undressed. Reading the pupils' interval here would forbid the very thing
        a school does on purpose: idrottsläraren taking the next class in the
        hall while the last one is still in the changing room.

        PER LESSON (_lesson_teachers): a split post's lesson is in its own
        lead's family and the co-teacher's, and in no other lead's — Bertil's
        one lesson of Matematik för 7A may clash with nothing of Bertil's, and
        Anna's two are free to sit beside it. A post one person leads puts
        every lesson in the lead's family and the co-teacher's, as before.
        """
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            for teacher_id in _lesson_teachers(decision.lesson):
                grouped.setdefault(teacher_id, []).append(decision)

        for teacher_decisions in grouped.values():
            if len(teacher_decisions) > 1:
                model.AddNoOverlap(
                    [padded_of(model, decision) for decision in teacher_decisions],
                )

    def _add_group_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
    ) -> None:
        """One student group is one set of students: no overlapping lessons.

        Two layers. Within a group, all lessons share every student, so one
        NoOverlap per group. Across groups, `group_conflicts` lists pairs that
        share AT LEAST one student — a home class vs a teaching group cut from
        it (7A vs Ma71), or two teaching groups with common members (Ma71 vs
        Sv73). Each pair gets a NoOverlap over the union of both groups'
        lessons: any overlap would double-book every shared student, which is
        exactly as hard a clash as a within-group one.

        Pairs whose groups have no scheduled lessons are skipped silently —
        the relation is derived from membership data, which can name groups
        that have no timplan entries. A self-pair (A, A) is skipped for the
        same reason: it states a truth the per-group NoOverlap above already
        enforces, and taking it literally would put every one of A's intervals
        into a single NoOverlap TWICE — asking each interval not to overlap
        itself, which turns the whole request INFEASIBLE.

        BOTH LAYERS ARE FAMILIES OF CHILDREN, so both read pupil_padded_of: a
        class changing for idrotten is as unavailable as a class being taught,
        and the pupils Ma71 shares with 7A are the ones in the changing room.
        The teacher's family next door reads padded_of instead — see there.

        BOTH LAYERS ARE KEYED IN THE PUPIL SPACE (pupil_key_of), own lessons
        and partners alike. 7A's svenska sat by "7A without SvA7" (X) is X's
        lesson here: X's own layer holds it, the pair (X, 7A) keeps it off
        7A's matte, and no pair (X, SvA7) exists, so SvA7 may run beside it
        and beside nothing else of 7A's. Keyed by the class on one side and
        by the pupils on the other, the svenska would sit in the pair (X, 7A)
        twice — the self-pair failure above. Nothing new hangs on a literal:
        a derived key only moves lessons between no-overlaps that were
        always posted bare.
        """
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            group_id = pupil_key_of(decision.lesson.requirement)
            grouped.setdefault(group_id, []).append(decision)

        for group_decisions in grouped.values():
            if len(group_decisions) > 1:
                model.AddNoOverlap(
                    [pupil_padded_of(model, decision) for decision in group_decisions],
                )

        for first_id, second_id in group_conflicts or []:
            if first_id == second_id:
                continue
            combined = grouped.get(first_id, []) + grouped.get(second_id, [])
            if len(combined) > 1:
                model.AddNoOverlap([pupil_padded_of(model, decision) for decision in combined])

    def _add_room_allocation(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
        fixed_lessons: list[FixedLesson],
        room_preferences: list[AnonymousRoomPreference] | None = None,
        *,
        site_key: Callable[[AnonymousRoom], object] | None = None,
    ) -> RoomPlan:
        """Enforce room capacity by interchangeability class, not by named room.

        The previous encoding reified "lesson L is in room R" for every pair —
        264,960 booleans at 2,000 students — and made 76 identical classrooms 76
        distinct search decisions. See app/solver/room_allocator.py for the
        encoding and the proof that the post-pass always succeeds.

        The returned plan is REQUIRED to read rooms back: room_index is no
        longer authoritative except for pinned rooms.
        """
        # Wishes only, and for a lock the bit would be redundant rather than
        # merely wasteful: the signature's first half is eligibility, a lock's
        # whole effect on eligibility IS "in this room set", so the bit it would
        # add is the distinction the partition has already made.
        #
        # Stated rather than tested. Once the lock is enforced there is no
        # payload where adding the bit changes the class count, so the test that
        # guarded this during the wish-only step could no longer say anything
        # and was removed instead of given a contrived fixture.
        preference_sets = [
            _preference_room_ids(preference, rooms)
            for preference in (room_preferences or [])
            if preference.kind == "WISH"
        ]
        allowed, key = self._lock_aware(
            resolve_room_locks(
                [decision.lesson.requirement for decision in decisions],
                room_preferences or [],
                rooms,
            ),
        )
        return add_room_allocation(
            model,
            decisions,
            rooms,
            distinguished_room_ids=collect_distinguished_room_ids(
                constraints, fixed_lessons,
            ),
            room_allowed=allowed,
            profile_key=key,
            preference_sets=preference_sets,
            site_key=site_key,
        )

    def _travel_rows(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        room_plan: RoomPlan,
        travel: TravelMap,
        day_vars: dict[str, cp_model.IntVar],
    ) -> TravelRows:
        """The builder of the walk's rows for this model. See travel.py.

        ONE LITERAL PER FAMILY — a teacher, a group, a pair of groups sharing a
        pupil — registered the first time a row needs it, so a family the rule
        cannot touch registers nothing. Every literal of one party carries the
        same values, so a core holding several becomes one line naming them all
        (build_conflict_analysis), the way the daily maximum's do; the measured
        verdict narrows it afterwards (_travel_verdict).
        """

        def register(party: Party, resource_ids: tuple[UUID, ...]) -> cp_model.IntVar:
            return registry.register(
                model,
                name=f"travel_{party.lower()}_{'_'.join(str(r) for r in resource_ids)}",
                category=TRAVEL_CATEGORIES[party],  # type: ignore[arg-type]
                code=TRAVEL_CODES[party],
                params={"stepMinutes": travel.step_minutes, "measured": 0},
                resource_ids=list(resource_ids),
            )

        return TravelRows(
            travel=travel,
            choices=site_choices(model, room_plan),
            register=register,
            day_var=lambda decision: self._day_var(model, decision, day_vars),
            slots_per_day=self._grid.slots_per_day,
            horizon=self._grid.horizon,
        )

    def _add_availability_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
    ) -> None:
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue

            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            affected = self._decisions_for_constraint(constraint, decisions, room_index_by_id, model)
            if not affected:
                continue

            assumption = registry.register(
                model,
                name=f"availability_{constraint.id}",
                category="AVAILABILITY",
                code="AVAIL_CONSTRAINT_BLOCKS_LESSONS",
                params=self._constraint_params(constraint),
                constraint_ids=[constraint.id],
                # A year reservation names no resource, and a conflict detail
                # carries UUIDs only — the constraint id is what the admin has
                # to look up anyway.
                resource_ids=[constraint.resource_id] if constraint.resource_id else [],
                requirement_ids=[decision.lesson.requirement.id for decision, _ in affected],
            )

            for decision, guard in affected:
                for abs_start, abs_end in windows:
                    before = model.NewBoolVar(
                        f"before_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    after = model.NewBoolVar(
                        f"after_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                    model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                    model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                    model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())

                    if guard is None:
                        model.AddBoolOr([before, after]).OnlyEnforceIf(assumption)
                    else:
                        # Both literals in ONE call. OnlyEnforceIf returns None
                        # in ortools 9.15, so chaining a second call raises
                        # AttributeError — and `guard` is non-None exactly for
                        # ROOM-scoped constraints, so every "this room is
                        # unavailable on Wednesday afternoons" payload crashed.
                        model.AddBoolOr([before, after]).OnlyEnforceIf([guard, assumption])

    def _decisions_for_constraint(
        self,
        constraint: AnonymousConstraint,
        decisions: list[LessonDecision],
        room_index_by_id: dict[UUID, int],
        model: cp_model.CpModel,
    ) -> list[tuple[LessonDecision, cp_model.IntVar | None]]:
        affected: list[tuple[LessonDecision, cp_model.IntVar | None]] = []

        if constraint.resource_kind == "TEACHER":
            # The lessons the teacher is ON (_lesson_teachers), which for a
            # split post is their own lessons of it and not the colleague's:
            # Bertil's Friday off keeps his one lesson off Friday and leaves
            # Anna's two free to take it, hard row and wish alike.
            for decision in decisions:
                if constraint.resource_id in _lesson_teachers(decision.lesson):
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "STUDENT_GROUP":
            # The CLASS space: a reservation on 7A keeps out every lesson
            # filed under 7A, its svenska too whoever sits it (pupil_key_of).
            for decision in decisions:
                if decision.lesson.requirement.student_group_id == constraint.resource_id:
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "GRADE_LEVEL":
            # One row, every group of those years — including the teaching
            # groups, whose own grade level is null but whose members are year
            # 7 all the same. Fanning this out into one constraint per group in
            # the gateway would turn "hold year 7 free at 11:30" into sixty rows
            # against a payload capped at five thousand.
            #
            # THIS EVICTS LESSONS AND NOTHING ELSE. The example here used to
            # read "year 7 eats at 11:30", which was wrong in a way that
            # mattered: a reservation empties the half hour of LESSONS and says
            # nothing about where the meal goes, so a school following that
            # advice got a hole and a lunch somewhere else entirely. A sitting
            # is declared with LunchServing, which the lunch variable's own
            # domain reads.
            #
            # And a GRADE_LEVEL row deliberately does NOT subtract from that
            # domain, unlike a STUDENT_GROUP one. Schools were told to write
            # sittings this way; making the rows close the lunch would push the
            # meal out of exactly the window they reserved FOR it, and break the
            # schools that followed our own documentation.
            for decision in decisions:
                if _grade_span_overlaps(constraint, decision.lesson.requirement):
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "ROOM":
            room_idx = room_index_by_id.get(constraint.resource_id)
            if room_idx is None:
                return affected
            for decision in decisions:
                assigned_here = model.NewBoolVar(
                    f"avail_room_{constraint.id}_{decision.lesson.key()}",
                )
                model.Add(decision.room_index == room_idx).OnlyEnforceIf(assigned_here)
                model.Add(decision.room_index != room_idx).OnlyEnforceIf(assigned_here.Not())
                affected.append((decision, assigned_here))
            return affected

        return affected

    def _add_fixed_lesson_constraints(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        fixed_lessons: list[FixedLesson],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
        *,
        travel_rows: TravelRows | None = None,
    ) -> None:
        """Hard-block generated lessons from overlapping locked placements.

        A generated lesson may not overlap a fixed lesson that shares its
        teacher or student group — where "shares its group" includes any group
        that shares STUDENTS with it per `group_conflicts`, so a locked 7A
        mentor hour also blocks Ma71's generated lessons for the window. If
        the fixed lesson occupies a room, no generated lesson may be assigned
        that room during the window.

        ONE DISJUNCTION PER PAIR, WIDENED BY THE UNION OF THE MARGINS. A lesson
        can share a locked lesson's teacher and its pupils at once, and then two
        margins apply to the same window: the teacher's corridor and the
        pupils' changing. Both are intervals AROUND THE SAME LESSON BODY, so
        each side's requirement is nested inside the other's — avoiding the
        window for the wider of the two is avoiding it for both — and the widest
        margin on each side is the whole answer. Two separate disjunctions would
        cost two more booleans per pair to say it.

        THE WALK TO A LOCKED LESSON ON ANOTHER SITE rides on the same pair's
        before/after literals (travel.TravelRows.fixed_rows), so it costs no
        boolean either; two locked lessons are never held apart, as nothing
        here ever compares two of them.

        "SHARES ITS GROUP" IS THE PUPIL SPACE, on both sides: the lock's
        pupil_keys_of against the lesson's pupil_key_of and the groups sharing
        it. A locked 7A svenska sat by "7A without SvA7" keeps 7A's matte out
        (the pair (X, 7A)) and lets SvA7 in; a locked 7A matte keeps SvA7 out
        (the pair (7A, SvA7)). These disjunctions are posted bare as they
        always were; a derived key only changes which lessons meet which lock.
        """
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        # Symmetric lookup: conflicts_with[G] = groups sharing students with G.
        conflicts_with: dict[UUID, set[UUID]] = {}
        for first_id, second_id in group_conflicts or []:
            conflicts_with.setdefault(first_id, set()).add(second_id)
            conflicts_with.setdefault(second_id, set()).add(first_id)

        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                # Outside the scheduling grid (e.g. weekend when the grid is
                # Mon-Fri): generated lessons can never collide with it. Before
                # or after a scheduled day's hours, the walk to it still binds.
                if travel_rows is not None:
                    self._walk_to_lock_outside(
                        model, travel_rows, decisions, fixed, conflicts_with,
                    )
                continue
            abs_start, abs_end = window

            room_idx = (
                room_index_by_id.get(fixed.room_id) if fixed.room_id is not None else None
            )
            fixed_site = (
                travel_rows.travel.site_of_room.get(fixed.room_id)
                if travel_rows is not None and fixed.room_id is not None
                else None
            )

            for decision in decisions:
                requirement = decision.lesson.requirement
                fixed_teachers = {
                    tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid
                }
                # The LESSON's teachers: a lock of Bertil's is in the way of
                # his lesson of a split post and of none of Anna's.
                own_teachers = set(_lesson_teachers(decision.lesson))
                shares_teacher = bool(fixed_teachers & own_teachers)
                fixed_groups = set(pupil_keys_of(fixed))
                own_group = pupil_key_of(requirement)
                shares_group = own_group in fixed_groups or any(
                    fixed_group in conflicts_with.get(own_group, ())
                    for fixed_group in fixed_groups
                )

                if shares_teacher or shares_group:
                    before, after = self._add_window_avoidance(
                        model,
                        decision,
                        abs_start,
                        abs_end,
                        tag=f"fixed_{fixed.id}_{decision.lesson.key()}",
                        guard=None,
                        # A hand-placed lesson is not an interval in this model
                        # — it is a constant window — so padded_of never reaches
                        # it. The margin has to be applied here or a generated
                        # lesson lands flush against a locked one, which is the
                        # very collision the corridor exists to prevent, on the
                        # placements a human chose deliberately.
                        margin=decision.changeover,
                        # AND THE PUPILS' OWN MARGIN, BUT ONLY WHERE THE LOCK
                        # REACHES THE PUPILS. A locked lesson that merely shares
                        # the teacher blocks nothing for the children — the class
                        # is not in it — so their changing time has no business
                        # widening that window, and widening it anyway would
                        # forbid the teacher the back-to-back the whole feature
                        # promises they may keep. Where the lock DOES hold the
                        # class (its own group, or one sharing its pupils), the
                        # children cannot be changing during it either: they
                        # would have to be in two places.
                        lead=decision.lead if shares_group else 0,
                        trail=decision.trail if shares_group else 0,
                    )
                    if fixed_site is not None:
                        relations = _fixed_relations(decision.lesson, fixed, conflicts_with)
                        travel_rows.fixed_rows(  # type: ignore[union-attr]
                            model, decision, window, fixed_site, before, after, relations,
                        )
                    continue

                if room_idx is not None:
                    assigned_here = model.NewBoolVar(
                        f"fixed_room_{fixed.id}_{decision.lesson.key()}",
                    )
                    model.Add(decision.room_index == room_idx).OnlyEnforceIf(assigned_here)
                    model.Add(decision.room_index != room_idx).OnlyEnforceIf(
                        assigned_here.Not(),
                    )
                    self._add_window_avoidance(
                        model,
                        decision,
                        abs_start,
                        abs_end,
                        tag=f"fixed_roomwin_{fixed.id}_{decision.lesson.key()}",
                        guard=assigned_here,
                        # NO margin on the room arm, and no pupil buffer either.
                        # The corridor is about a body walking between two
                        # places; a room needs no time to become itself again,
                        # and a school that wants the room to breathe declares a
                        # rast. Changing and showering are the same answer from
                        # the other side: they happen to the children, not to the
                        # hall, and the hall is free the moment they walk out of
                        # it. This mirrors the decision not to pad the room
                        # cumulative.
                        margin=0,
                    )

    def _walk_to_lock_outside(
        self,
        model: cp_model.CpModel,
        travel_rows: TravelRows,
        decisions: Iterable[LessonDecision],
        fixed: FixedLesson,
        conflicts_with: dict[UUID, set[UUID]],
        *,
        only: tuple[Party, tuple[UUID, ...]] | None = None,
    ) -> None:
        """The walk to a lock before or after the day's hours, for whoever shares it.

        `only` keeps one family's row, as _family_alone measures one family.
        """
        outside = _fixed_lesson_outside(fixed, self._grid)
        site = (
            travel_rows.travel.site_of_room.get(fixed.room_id)
            if fixed.room_id is not None
            else None
        )
        if outside is None or site is None:
            return
        day_start, lock = outside
        for decision in decisions:
            relations = [
                relation
                for relation in _fixed_relations(decision.lesson, fixed, conflicts_with)
                if only is None or relation == only
            ]
            if relations:
                travel_rows.outside_rows(model, decision, day_start, lock, site, relations)

    def _add_window_avoidance(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        abs_start: int,
        abs_end: int,
        tag: str,
        guard: cp_model.IntVar | None,
        margin: int = 0,
        lead: int = 0,
        trail: int = 0,
    ) -> tuple[cp_model.IntVar, cp_model.IntVar]:
        """decision must end before, or start after, the [abs_start, abs_end) window.

        `margin` widens the window by the same corridor padded_of gives a
        generated pair — on BOTH sides, because the body moves in both
        directions: out of the room the fixed lesson is about to fill, and into
        it after the fixed lesson leaves. That is not the double-padding
        padded_of avoids; there the two lessons each carry their own margin, so
        padding both ends would count one corridor twice.

        `lead` and `trail` widen it ASYMMETRICALLY, by the minutes the pupils
        spend changing before this lesson and showering after it. Each lands on
        its own side and nowhere else: `trail` where the generated lesson ends
        before the locked window, `lead` where it starts after — which is the
        one place the two halves of the corridor argument above do not apply,
        because these minutes are not a distance to be walked once but time the
        class is unavailable at a particular end of its lesson.
        THEY ADD TO THE CORRIDOR RATHER THAN REPLACING IT, exactly as
        pupil_padded_of adds them to a generated pair: a class showers, changes
        and then walks. Only the caller knows whether a lock reaches the
        children at all, so it passes zero where it does not.
        """
        before = model.NewBoolVar(f"before_{tag}")
        after = model.NewBoolVar(f"after_{tag}")
        model.Add(decision.end + margin + trail <= abs_start).OnlyEnforceIf(before)
        model.Add(decision.end + margin + trail > abs_start).OnlyEnforceIf(before.Not())
        model.Add(decision.start >= abs_end + margin + lead).OnlyEnforceIf(after)
        model.Add(decision.start < abs_end + margin + lead).OnlyEnforceIf(after.Not())
        if guard is None:
            model.AddBoolOr([before, after])
        else:
            model.AddBoolOr([before, after]).OnlyEnforceIf(guard)
        return before, after

    def _constraint_params(self, constraint: AnonymousConstraint) -> dict[str, str | int]:
        """The values a sentence about one reservation substitutes.

        Structured, never a label assembled here: the gateway turns the
        resource id into the school's own name and the reader puts the words
        in its own order. `day` is the ISO weekday, or 0 for a one-off, which
        is the branch that reads `date` instead — a reservation is written
        either way round on the Tillgänglighet page.
        """
        return {
            "constraint": str(constraint.id),
            "kind": constraint.resource_kind,
            "resource": str(constraint.resource_id or ""),
            "grades": _grade_span_text(
                constraint.min_grade_level, constraint.max_grade_level,
            ),
            "day": constraint.day_of_week or 0,
            "date": constraint.date or "",
            "start": constraint.start_time[:5],
            "end": constraint.end_time[:5],
        }

    def _fixed_window(self, fixed: FixedLesson) -> tuple[int, int] | None:
        """Absolute slot window blocked by a fixed lesson, rounded outward.

        The rounding lives in _fixed_lesson_window, so _start_step reads the
        very window every builder blocks rather than a second copy of it.
        """
        return _fixed_lesson_window(fixed, self._grid)

    def _resolve_weights(self, request: OptimizeScheduleRequest) -> ResolvedWeights:
        override = request.weights
        return ResolvedWeights(
            preferred_free=(
                override.preferred_free
                if override and override.preferred_free is not None
                else self._settings.weight_preferred_free_violation
            ),
            preferred_busy=(
                override.preferred_busy
                if override and override.preferred_busy is not None
                else self._settings.weight_preferred_busy_violation
            ),
            disruption=(
                override.disruption
                if override and override.disruption is not None
                else self._settings.weight_disruption
            ),
            lunch_drift=self._settings.weight_lunch_drift,
            spread=(
                override.spread
                if override and override.spread is not None
                else self._settings.weight_spread
            ),
            teacher_gap=(
                override.teacher_gap
                if override and override.teacher_gap is not None
                else self._settings.weight_teacher_gap
            ),
            room_preference=(
                override.room_preference
                if override and override.room_preference is not None
                else self._settings.weight_room_preference
            ),
            date_unavailable=self._settings.weight_date_unavailable,
            free_day_wish=self._settings.weight_free_day_wish,
        )

    def _add_preference_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        constraints: list[AnonymousConstraint],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Soft PREFERRED_FREE / PREFERRED_BUSY windows.

        Applies to teachers and student groups directly, and to rooms via the
        room-assignment literal (a room preference only counts for lessons
        actually placed in that room).
        """
        penalties: list[cp_model.LinearExpr] = []
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        for constraint in constraints:
            # Dated constraints act exactly at publish time; inside the weekly
            # solver they become SOFT signals on their weekday (a dated
            # UNAVAILABLE nudges lessons away from slots where one-off
            # absences fall). Recurring UNAVAILABLE stays hard elsewhere.
            if constraint.date is not None:
                try:
                    weekday = date_type.fromisoformat(constraint.date).isoweekday()
                except ValueError:
                    continue
                if weekday not in self._grid.schedule_days:
                    continue
                effective_day: int | None = weekday
                dated = True
            else:
                if constraint.kind not in {"PREFERRED_FREE", "PREFERRED_BUSY"}:
                    continue
                effective_day = constraint.day_of_week
                dated = False

            try:
                windows = self._grid.window_to_absolute_range(
                    effective_day,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            affected = self._decisions_for_constraint(
                constraint, decisions, room_index_by_id, model,
            )

            for decision, guard in affected:
                for abs_start, abs_end in windows:
                    tag = f"{constraint.id}_{decision.lesson.key()}_{abs_start}"
                    before = model.NewBoolVar(f"pref_before_{tag}")
                    after = model.NewBoolVar(f"pref_after_{tag}")
                    overlaps = model.NewBoolVar(f"pref_overlap_{tag}")
                    model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                    model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                    model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                    model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())
                    model.AddBoolAnd([before.Not(), after.Not()]).OnlyEnforceIf(overlaps)
                    model.AddBoolOr([before, after]).OnlyEnforceIf(overlaps.Not())

                    violation = model.NewBoolVar(f"pref_violation_{tag}")
                    # The "raw" violation condition, before the room guard.
                    condition = (
                        overlaps
                        if constraint.kind in {"PREFERRED_FREE", "UNAVAILABLE"}
                        else overlaps.Not()
                    )
                    if guard is None:
                        model.Add(violation == 1).OnlyEnforceIf(condition)
                        model.Add(violation == 0).OnlyEnforceIf(condition.Not())
                    else:
                        model.AddBoolAnd([condition, guard]).OnlyEnforceIf(violation)
                        model.AddBoolOr([condition.Not(), guard.Not()]).OnlyEnforceIf(
                            violation.Not(),
                        )

                    if dated and constraint.kind == "UNAVAILABLE":
                        weight = weights.date_unavailable
                    elif constraint.kind == "PREFERRED_FREE":
                        weight = weights.preferred_free
                    else:
                        weight = weights.preferred_busy
                    penalties.append(violation * weight)

        return penalties

    def _add_room_preference_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        room_plan: RoomPlan,
        preferences: list[AnonymousRoomPreference],
        weights: _Weights,
    ) -> list[cp_model.LinearExpr]:
        """Pay per lesson that misses its subject's preferred rooms.

        The class literals do the work: a lesson picks exactly one class, and a
        preference's rooms form classes of their own (see build_room_classes),
        so "landed somewhere preferred" is the sum of the literals of those
        classes — 0 or 1, never more, because AddExactlyOne holds across every
        eligible class.

        A lesson with only one eligible class has no literal at all. Its
        placement is already decided, so whether it satisfies the wish is a
        constant, and a constant term cannot change which timetable wins.
        Adding it would only inflate the objective value.
        """
        if not preferences:
            return []

        penalties: list[cp_model.LinearExpr] = []
        by_subject: dict[UUID, list[AnonymousRoomPreference]] = defaultdict(list)
        for preference in preferences:
            # A LOCK is not a price. It restricts eligibility through
            # _room_allowed and must never also appear as a penalty: paying for
            # a room the lesson cannot reach anyway is a constant, and one that
            # would inflate the objective without steering anything.
            if preference.kind != "WISH":
                continue
            by_subject[preference.subject_id].append(preference)

        for decision in decisions:
            requirement = decision.lesson.requirement
            wanted = by_subject.get(requirement.subject_id)
            if not wanted:
                continue

            key = decision.lesson.key()
            literals = room_plan.literals.get(key)
            if not literals:
                continue

            for preference in wanted:
                # The stage the rule is about. Gated HERE and nowhere else: the
                # room-class partition treats "preferred" as a static property
                # of a room, and _class_is_preferred decides a whole class by
                # testing its first member, so a per-lesson room set would
                # destroy the invariant the encoding rests on.
                if not _rule_reaches(preference, requirement):
                    continue
                preferred_rooms = _preference_room_ids(preference, rooms)
                satisfied = [
                    literal
                    for class_index, literal in literals.items()
                    if _class_is_preferred(room_plan, class_index, rooms, preferred_rooms)
                ]
                if not satisfied or len(satisfied) == len(literals):
                    # Impossible or unavoidable: either way the term is a
                    # constant and steers nothing.
                    continue
                weight = preference.weight or weights.room_preference
                penalties.append((1 - sum(satisfied)) * weight)

        return penalties

    def _add_disruption_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
        weights: ResolvedWeights,
        *,
        wished_free: set[tuple[UUID, int]] | None = None,
    ) -> list[cp_model.LinearExpr]:
        """Minimal-disruption re-optimization.

        For every slot the previous schedule used, the solver is penalized
        unless some lesson instance of the same requirement stays on it. The
        previous slots are also fed in as solver hints (warm start).

        NOT ON A DAY ITS TEACHER WISHES FREE. `wished_free` holds (teacher, ISO
        weekday) for every free-day wish the objective prices, and a previous
        slot on that weekday of a requirement that teacher teaches, as lead or
        co-teacher, earns nothing for being kept. The wish says exactly those
        slots are not worth keeping, and left in, the two terms would bid
        against each other over the same lessons: at 8 a slot, five lessons on
        last term's Friday cancel a wish of 40 before anything else in the week
        has had a say, and a school re-generating to give a teacher Fridays
        free would get last term's Fridays back. The hint stays — it is a place to
        START searching, which last term's week still is — and every other
        requirement's slots on that day keep their reward.

        PER LESSON, where a post is split: the slot is kept, for the reward,
        only by a lesson none of whose teachers wishes the weekday free. Anna's
        two lessons may still hold last term's Friday when Bertil wishes his
        Fridays free; his one lesson earns nothing there, and a slot only his
        lessons could keep is no term at all. A post one person leads has the
        same teachers on every lesson, so either every lesson keeps the slot
        or none does — the requirement-wide reading, slot for slot.

        None or empty is the term as it always was, slot for slot.
        """
        if weights.disruption <= 0 or not previous_lessons:
            return []

        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        penalties: list[cp_model.LinearExpr] = []

        for index, previous in enumerate(previous_lessons):
            candidates = by_requirement.get(previous.requirement_id)
            if candidates and wished_free:
                candidates = [
                    decision
                    for decision in candidates
                    if not any(
                        (teacher_id, previous.day_of_week) in wished_free
                        for teacher_id in _lesson_teachers(decision.lesson)
                    )
                ]
            if not candidates:
                continue
            try:
                start_slot = self._grid.parse_hhmmss(previous.start_time)
                abs_slot = self._grid.absolute_start(previous.day_of_week, start_slot)
            except ValueError:
                continue  # off-grid previous slot — nothing to preserve

            matches: list[cp_model.IntVar] = []
            for decision in candidates:
                b = model.NewBoolVar(f"prev_{index}_{decision.lesson.key()}")
                model.Add(decision.start == abs_slot).OnlyEnforceIf(b)
                model.Add(decision.start != abs_slot).OnlyEnforceIf(b.Not())
                matches.append(b)

            kept = model.NewBoolVar(f"prev_kept_{index}")
            model.AddBoolOr(matches).OnlyEnforceIf(kept)
            model.AddBoolAnd([m.Not() for m in matches]).OnlyEnforceIf(kept.Not())
            penalties.append((1 - kept) * weights.disruption)

        # Warm-start hints: one not-yet-hinted instance per previous slot, a
        # block's members from one list. The pairing is _hint_previous_lessons'
        # own; see _previous_hints.
        for decision, slot in self._previous_hints(decisions, previous_lessons):
            model.AddHint(decision.start, slot)

        return penalties

    def _day_var(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        cache: dict[str, cp_model.IntVar],
    ) -> cp_model.IntVar:
        """Lazily creates the day-index variable of a decision (shared)."""
        key = decision.lesson.key()
        existing = cache.get(key)
        if existing is not None:
            return existing
        day_var = model.NewIntVar(
            0, max(0, len(self._grid.schedule_days) - 1), f"day_{key}",
        )
        model.AddDivisionEquality(day_var, decision.start, self._grid.slots_per_day)
        cache[key] = day_var
        return day_var

    def _add_spread_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        weights: ResolvedWeights,
        day_vars: dict[str, cp_model.IntVar],
    ) -> list[cp_model.LinearExpr]:
        """Penalizes two lessons of the same requirement on the same weekday."""
        if weights.spread <= 0:
            return []

        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        penalties: list[cp_model.LinearExpr] = []

        for requirement_id, group in by_requirement.items():
            if len(group) < 2:
                continue
            group_days = [self._day_var(model, d, day_vars) for d in group]
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    same = model.NewBoolVar(f"sameday_{requirement_id}_{i}_{j}")
                    model.Add(group_days[i] == group_days[j]).OnlyEnforceIf(same)
                    model.Add(group_days[i] != group_days[j]).OnlyEnforceIf(same.Not())
                    penalties.append(same * weights.spread)

        return penalties

    def _add_distribution_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        day_vars: dict[str, cp_model.IntVar],
    ) -> None:
        """Ämnesfördelning: at most N lessons a day, no two lesson days too close.

        The HARD twin of _add_spread_objective just above, which only prices a
        same-day pair and sells it for any placement worth more. A school that
        writes "idrott inte två gånger samma dag, inte dagar i följd" is not
        stating a taste, and a week with Monday and Tuesday idrott is one it
        will send back.

        ON THE DAY VARIABLES THE SPREAD ALREADY READS. Each lesson gets one
        literal per weekday, exactly one of them true and their weighted sum
        equal to its `day_` variable — the channelling the per-group cap below
        builds by reification, said once per lesson instead of twice per day.
        The rules are then sums and clauses over those literals: a day's lessons
        at most its cap, and for two days closer than the rule allows, not both.
        The cap bounds a count per day, the counts summing to the lessons, and
        never the day's sum itself, which CP-SAT's presolve threw on
        (_day_totals).
        A pairwise `day_i != day_j` would cover "one a day" with no literal at
        all, but nothing else: N = 2, a day next to a locked lesson and the
        refusal's own counting all want the per-day view.

        ONE ASSUMPTION LITERAL PER REQUIREMENT AND RULE. The per-day cap and
        the days apart are two sentences a school fixes in two different places
        on one row — "allow two a day" against "allow consecutive days" — so a
        core that named them as one would send the reader to guess. Per
        requirement rather than per day because the requirement is what the
        school opens; the day is in the pre-flight's sentence, where arithmetic
        can name it.

        THE LOCKED LESSONS COUNT AS FACTS. They are no decision here — the
        gateway subtracts them from lessons_per_week and they arrive as fixed
        lessons with no requirement id — so `locked_days` says where they are.
        A day's cap is N less what is locked on it, and a weekday next to a
        locked one is closed to the rule's lessons. Two lessons the SCHOOL
        locked onto one Monday are never refused here: that was a hand edit,
        warned about when it was made, and a refusal of the whole week for it
        would turn the warning into a block.

        NOTHING AT ALL FOR A REQUIREMENT WITHOUT A RULE, and nothing for a rule
        that cannot bind — a cap no day can reach, or days apart for a single
        lesson with nothing locked. A school that has written no rule gets the
        model it had, variable for variable.
        """
        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            requirement = decision.lesson.requirement
            if (
                requirement.max_lessons_per_day is None
                and requirement.min_days_between is None
            ):
                continue
            by_requirement.setdefault(requirement.id, []).append(decision)

        weekdays = self._grid.schedule_days
        for requirement_id, group in by_requirement.items():
            requirement = group[0].lesson.requirement
            locked = Counter(requirement.locked_days)
            per_day = requirement.max_lessons_per_day
            apart = requirement.min_days_between

            # day index -> what the rule's own lessons may still take there,
            # kept only where that is less than all of them.
            caps: dict[int, int] = {}
            if per_day is not None:
                for day_index, weekday in enumerate(weekdays):
                    cap = max(0, per_day - locked[weekday])
                    if cap < len(group):
                        caps[day_index] = cap
            near: list[tuple[int, int]] = []
            shut: list[int] = []
            if apart is not None:
                if len(group) > 1:
                    near = [
                        (first, second)
                        for first in range(len(weekdays))
                        for second in range(first + 1, len(weekdays))
                        if abs(weekdays[second] - weekdays[first]) < apart
                    ]
                # In ISO weekdays and not in positions, as the field says: a
                # lock on a Saturday this grid does not teach still closes its
                # Friday under "not on consecutive days".
                shut = [
                    day_index
                    for day_index, weekday in enumerate(weekdays)
                    if any(0 < abs(weekday - other) < apart for other in locked)
                ]
            if not caps and not near and not shut:
                continue

            on_day: list[list[cp_model.IntVar]] = []
            for decision in group:
                day = self._day_var(model, decision, day_vars)
                literals = [
                    model.NewBoolVar(f"distday_{decision.lesson.key()}_{day_index}")
                    for day_index in range(len(weekdays))
                ]
                model.AddExactlyOne(literals)
                model.Add(
                    day == sum(day_index * literal for day_index, literal in enumerate(literals)),
                )
                on_day.append(literals)

            if caps:
                per_day_literal = registry.register(
                    model,
                    name=f"distperday_{requirement_id}",
                    category="SUBJECT_DISTRIBUTION",
                    code="SUBJECT_DISTRIBUTION_PER_DAY",
                    params={"requirement": str(requirement_id), "maxPerDay": per_day},
                    requirement_ids=[requirement_id],
                )
                # A count per day under the cap, and never `Σ distday ≤ cap`:
                # see _day_totals. The counts are bare, as definitions are;
                # the cap on them hangs on the literal.
                counts = _day_totals(
                    model,
                    f"distcount_{requirement_id}",
                    {
                        day_index: sum(literals[day_index] for literals in on_day)
                        for day_index in range(len(weekdays))
                    },
                    dict.fromkeys(range(len(weekdays)), len(group)),
                    len(group),
                )
                for day_index, cap in caps.items():
                    model.Add(counts[day_index] <= cap).OnlyEnforceIf(per_day_literal)

            if near or shut:
                apart_literal = registry.register(
                    model,
                    name=f"distapart_{requirement_id}",
                    category="SUBJECT_DISTRIBUTION",
                    code="SUBJECT_DISTRIBUTION_DAYS_APART",
                    params={"requirement": str(requirement_id), "minDaysBetween": apart},
                    requirement_ids=[requirement_id],
                )
                # Whether the rule's lessons use a day at all: implied by each
                # lesson's literal and free otherwise, so a pair of days is one
                # clause rather than one per pair of lessons.
                used = {
                    day_index: model.NewBoolVar(f"distused_{requirement_id}_{day_index}")
                    for day_index in sorted({d for pair in near for d in pair} | set(shut))
                }
                for literals in on_day:
                    for day_index, flag in used.items():
                        model.AddImplication(literals[day_index], flag)
                for first, second in near:
                    model.AddBoolOr(
                        [used[first].Not(), used[second].Not()],
                    ).OnlyEnforceIf(apart_literal)
                for day_index in shut:
                    model.AddBoolAnd([used[day_index].Not()]).OnlyEnforceIf(apart_literal)

    def _add_idle_time_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        constraints: list[AnonymousConstraint],
        weights: ResolvedWeights,
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay] | None = None,
    ) -> list[cp_model.LinearExpr]:
        """Penalises a teacher's idle minutes, measured once per day.

        REPLACES a pairwise encoding that charged every unordered pair of a
        teacher's same-day lessons the positive distance between them. Three
        things were wrong with it and all three are gone.

          IT CHARGED NON-ADJACENT PAIRS. With three lessons in an unbroken
          chain the first and third are still an hour apart, so a teacher paid
          for the middle lesson's own length — which quietly pushed their third
          lesson off the day, an effect no comment, document or UI string
          mentioned.

          IT GAVE UP SILENTLY. Above 600 pairs a teacher's terms were skipped
          with no log and nothing in the response, so the most heavily loaded
          teacher — the one a compact day matters most to — was the one teacher
          the objective ignored. A day is O(lessons) and needs no such guard.

          IT PUNISHED A PROTECTED BREAK. The one way a teacher can reserve their
          own time today is an UNAVAILABLE row on themselves, and the pairwise
          gap read only lesson variables: the hole their own protection created
          was charged to them at full price.

        WHAT IS MEASURED. For each teacher and each day: the span from the first
        lesson's start to the last lesson's end, minus the minutes actually
        taught, minus the minutes the teacher had protected inside that span.
        Floored at zero.

        THE CREDIT IS MEASURED, NOT SUMMED. Adding up the lengths of the
        matching windows double-counts two that overlap, and gives nothing at
        all for a window that only partly falls inside the day's span. The
        windows are merged into a disjoint union at build time and each one's
        OVERLAP with [first, last] is what is credited.

        ONLY THE TEACHER'S OWN WINDOWS ARE CREDITED. A stage's rast subtracts
        from a GROUP's lesson domain and says nothing about where a teacher is;
        crediting it here would pay a teacher for a break they spent teaching
        another class — the very defect this codebase already documents
        elsewhere, recreated inside the CP model where it is far harder to see.

        AND WHERE A HARD RULE HAS ALREADY BUILT THE DAY, THIS READS ITS PAIR.
        The teachers' rest rule needs the same two ends and needs them
        two-sided, so `teacher_days` carries a (teacher, day) it has already
        encoded and this method takes it rather than adding a second, weaker
        `first` and `last` beside it — which would be twice the literals for one
        fact, and two answers to "when did Anna's Tuesday begin". A pinned pair
        is what minimising `last - first` drives the one-sided pair to anyway,
        so the term's value is unchanged; what changes is that it costs nothing
        here. Teachers no work rule names keep the one-sided pair below, which
        is why the paragraph about it is still true and still the common case.

        AND THERE IS NO PUPIL EQUIVALENT, deliberately. lib/gaps.ts opens by
        refusing the question — "'Where are 7A's håltimmar' cannot be asked that
        way" — because while Ma71 runs, sixteen of 7A are taught and fourteen
        may have nothing. A span-minus-taught term per group would price ghost
        holes in every 7-9 school with språkval, and pull 7A's own lessons
        together against the placements its teaching groups need. Pupils' holes
        are closed by rasts, which are hard and which the school wrote itself.
        """
        if weights.teacher_gap <= 0:
            return []

        # A teacher's day is the lessons they are on (_lesson_teachers): a
        # split post's lesson is in its own lead's span and not the other's.
        by_teacher: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            for teacher_id in _lesson_teachers(decision.lesson):
                by_teacher.setdefault(teacher_id, []).append(decision)

        protected = self._protected_windows(constraints)
        penalties: list[cp_model.LinearExpr] = []
        slots_per_day = self._grid.slots_per_day

        for teacher_id, group in by_teacher.items():
            if len(group) < 2:
                # One lesson is a span equal to its own length: no idle time can
                # exist, and the variables would be provably zero.
                continue
            days = [self._day_var(model, d, day_vars) for d in group]

            for day_index, day_of_week in enumerate(self._grid.schedule_days):
                base = day_index * slots_per_day
                tag = f"idle_{teacher_id}_{day_index}"
                built = (teacher_days or {}).get((teacher_id, day_index))
                if built is not None:
                    first, last, taught = built.first, built.last, built.taught
                else:
                    on_day: list[cp_model.IntVar] = []
                    for k, decision in enumerate(group):
                        literal = model.NewBoolVar(
                            f"idle_on_{teacher_id}_{day_index}_{decision.lesson.key()}",
                        )
                        model.Add(days[k] == day_index).OnlyEnforceIf(literal)
                        model.Add(days[k] != day_index).OnlyEnforceIf(literal.Not())
                        on_day.append(literal)

                    first = model.NewIntVar(base, base + slots_per_day, f"first_{tag}")
                    last = model.NewIntVar(base, base + slots_per_day, f"last_{tag}")
                    # ONE-SIDED ON PURPOSE. `first` is only bounded from above and
                    # `last` only from below, so nothing forces either to the true
                    # extreme — the OBJECTIVE does. Minimising `last - first` pushes
                    # first up to the earliest present start and last down to the
                    # latest present end, which is exactly the pair of equalities a
                    # two-sided encoding would cost twice as many constraints to
                    # state. A HARD rule cannot lean on that, which is why
                    # _TeacherDay is two-sided and why this branch is only for the
                    # teachers no work rule has already built a day for.
                    for k, decision in enumerate(group):
                        model.Add(first <= decision.start).OnlyEnforceIf(on_day[k])
                        model.Add(last >= decision.end).OnlyEnforceIf(on_day[k])

                    taught = sum(
                        decision.duration * on_day[k] for k, decision in enumerate(group)
                    )
                credit = self._protected_overlap(
                    model, protected.get((teacher_id, day_of_week), ()), first, last, tag,
                )

                idle = model.NewIntVar(0, slots_per_day, f"idle_{tag}")
                model.Add(idle >= last - first - taught - credit)
                penalties.append(idle * weights.teacher_gap)

        return penalties

    def _protected_windows(
        self,
        constraints: list[AnonymousConstraint],
    ) -> dict[tuple[UUID, int], tuple[tuple[int, int], ...]]:
        """(teacher, weekday) -> the teacher's own free windows, as a disjoint union.

        Merged here rather than credited row by row: two rows that overlap would
        otherwise be counted twice, and a teacher who wrote the same hour down
        in two forms would be paid for it twice over.

        Weekly rows only, matching _add_availability_constraints: the model is
        one generic week and has nowhere to put a single date.
        """
        by_key: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for constraint in constraints:
            if constraint.resource_kind != "TEACHER" or constraint.resource_id is None:
                continue
            if constraint.date is not None or constraint.day_of_week is None:
                continue
            window = self._grid.window_to_absolute_range(
                constraint.day_of_week, constraint.start_time, constraint.end_time,
            )
            if not window:
                continue
            for start, end in window:
                by_key.setdefault(
                    (constraint.resource_id, constraint.day_of_week), [],
                ).append((start, end))

        merged: dict[tuple[UUID, int], tuple[tuple[int, int], ...]] = {}
        for key, ranges in by_key.items():
            ranges.sort()
            union: list[tuple[int, int]] = []
            for start, end in ranges:
                if union and start <= union[-1][1]:
                    union[-1] = (union[-1][0], max(union[-1][1], end))
                else:
                    union.append((start, end))
            merged[key] = tuple(union)
        return merged

    def _protected_overlap(
        self,
        model: cp_model.CpModel,
        windows: Sequence[tuple[int, int]],
        first: cp_model.IntVar,
        last: cp_model.IntVar,
        tag: str,
    ) -> cp_model.LinearExpr:
        """Minutes of [first, last] the teacher had already reserved.

        Built only for teachers who actually wrote a row, which in a real school
        is a handful — so the three variables per window cost nothing on the
        common path and the term is exactly zero without them.
        """
        if not windows:
            return 0
        parts: list[cp_model.IntVar] = []
        for index, (start, end) in enumerate(windows):
            lo = model.NewIntVar(0, self._grid.horizon, f"lo_{tag}_{index}")
            hi = model.NewIntVar(0, self._grid.horizon, f"hi_{tag}_{index}")
            model.AddMaxEquality(lo, [first, start])
            model.AddMinEquality(hi, [last, end])
            overlap = model.NewIntVar(0, self._grid.slots_per_day, f"ov_{tag}_{index}")
            model.AddMaxEquality(overlap, [hi - lo, 0])
            parts.append(overlap)
        return sum(parts)

    def _lunch_window_slots(self, rules: ScheduleRules) -> tuple[int, int, int]:
        """The lunch window and break length in slots: (start, end, length).

        One rounding rule, read from two places. _validate_request needs the
        same arithmetic the builder does — it settles up front what locked
        lessons leave a group, so the solve budget is not spent proving a
        subtraction — and two copies of "which slot is 11:30" would eventually
        disagree about a school's lunch.

        Every rejection here is bad input, not a solver verdict. In particular
        a 40-minute break is off the 15-minute grid and minutes_to_slots says
        so with a bare ValueError, which outside this block escapes to
        main.py's generic handler and becomes a 500. Now that lunch is a saved
        setting rather than a value retyped per run, that 500 would come back
        on every run.
        """
        try:
            window_start = self._grid.parse_hhmmss(rules.lunch_start_time)
            window_end = self._grid.parse_hhmmss(rules.lunch_end_time)
            lunch_slots = self._grid.minutes_to_slots(rules.lunch_minutes)
        except ValueError as exc:
            # Named for the lunch rather than passed through: the grid's
            # duration complaint reads "Lesson duration 40 minutes is not
            # aligned", and a school that typed a 40-minute LUNCH on a
            # 15-minute grid went looking through its timplan for a lesson.
            raise InvalidScheduleInputError.of("LUNCH_WINDOW_OFF_GRID", {
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
                "minutes": rules.lunch_minutes,
                "slotMinutes": self._grid.slot_minutes,
            }) from exc
        if window_end - window_start < lunch_slots:
            raise InvalidScheduleInputError.of("LUNCH_WINDOW_SHORTER_THAN_BREAK", {
                "windowStart": rules.lunch_start_time[:5],
                "windowEnd": rules.lunch_end_time[:5],
                "minutes": rules.lunch_minutes,
            })
        return window_start, window_end, lunch_slots

    def _admissible_lunch_starts(
        self,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
        forbidden: list[tuple[int, int]],
    ) -> cp_model.Domain:
        """What is left of one lunch window on one day, in absolute slots.

        A domain, not a NoOverlap against constant intervals: one variable's
        domain is the strongest and cheapest form the fact has. Shared with
        _validate_request, which asks the same question and only wants to know
        whether the answer is empty — and with the TEACHERS' own break, which is
        a window, a length and a list of what is taken exactly as a class's is.
        Whose break it is changes what fills `forbidden`, and nothing here.
        """
        allowed = cp_model.Domain(
            day_offset + window_start,
            day_offset + window_end - lunch_slots,
        )
        for first_bad, last_bad in forbidden:
            allowed = allowed.intersection_with(
                cp_model.Domain(first_bad, last_bad).complement(),
            )
        return allowed

    def _declared_lunch_domain(
        self,
        servings: list[LunchServing],
        frames: list[FrameTime],
        span: tuple[int, int] | None,
        day_of_week: int,
        day_offset: int,
        window_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> cp_model.Domain | None:
        """Where this stage's meal may start on this day, in ABSOLUTE slots.

        Two declarations meet here and they are not the same kind of thing. A
        SERVING says when the stage eats — a permission, so several union. A
        FRAME says which hours the stage may be taught in at all — a bound, so
        several intersect, and the meal has to sit inside it like everything
        else does. A school that opens the hall until 13:30 for a stage whose
        day ends at 13:00 has said two things, and the narrower one wins.

        None means nothing was declared for this group on this day: neither a
        serving nor a frame reaches it, and the school-wide lunch window stands
        untouched. An EMPTY domain is the other answer entirely — a declaration
        too tight to hold the break — and _validate_request refuses that by name
        before a solve begins.
        """
        serving_domain = allowed_starts(servings, span, day_of_week, lunch_slots, self._grid)

        frame_domain: cp_model.Domain | None = None
        if frames and span is not None:
            windows = day_windows(frames, span, self._grid)
            day_index = day_offset // self._grid.slots_per_day
            window = windows.get(day_index)
            if window is None:
                # The frames closed this day for the stage. Nowhere to eat.
                frame_domain = cp_model.Domain.FromIntervals([])
            else:
                open_slot, close_slot = window
                frame_domain = (
                    cp_model.Domain(open_slot, close_slot - lunch_slots)
                    if close_slot - lunch_slots >= open_slot
                    else cp_model.Domain.FromIntervals([])
                )

        if serving_domain is None and frame_domain is None:
            return None

        declared = serving_domain if serving_domain is not None else frame_domain
        if serving_domain is not None and frame_domain is not None:
            declared = serving_domain.intersection_with(frame_domain)

        # Day-local so far, because both sources reason inside one day. The
        # variable lives on the week's line, so shift once, here, rather than in
        # two modules that would then have to agree about it.
        assert declared is not None
        return cp_model.Domain.FromIntervals(
            [
                [day_offset + low, day_offset + high]
                for low, high in _domain_intervals(declared)
            ],
        ).intersection_with(
            cp_model.Domain(day_offset + window_start, day_offset + window_end - lunch_slots),
        )

    def _lunch_starts_blocked_by_constraints(
        self,
        constraints: list[AnonymousConstraint],
        lunch_group_ids: set[UUID],
        earliest_start: int,
        latest_start: int,
        window_end: int,
        lunch_slots: int,
    ) -> tuple[dict[tuple[UUID, int], list[tuple[int, int]]], set[tuple[UUID, int]]]:
        """Lunch starts a group may not take, because the school closed the time.

        The lunch interval has never seen an AvailabilityConstraint. Availability
        is applied in _add_availability_constraints, which runs before the lunch
        variable exists and only ever touches LessonDecisions — so an hour a
        school emptied for samling correctly pushed the LESSONS away and then
        received the class for lunch instead. Worse than neutral: no objective
        term mentions lunch, so the emptied hour is the widest free region the
        mandatory interval can occupy, and it is where lunch tends to land.

        STUDENT_GROUP rows only, deliberately. TEACHER and ROOM rows constrain
        resources the lunch interval does not model. GRADE_LEVEL is left out
        here for a sharper reason: this engine's own comments have been telling
        schools that a year reservation is how you say "åk 7 eats at 11:30", so
        subtracting those windows would forbid lunch in exactly the half hour
        the admin reserved FOR it. That advice is retired once LunchServings can
        state the intent properly, and GRADE_LEVEL joins this subtraction then.

        Dated rows are skipped, matching _add_availability_constraints: the
        model is one generic week and has nowhere to put a single date.

        TWO ANSWERS, NOT ONE, and the difference is the whole of this method.
        A rule that covers the ENTIRE lunch window is the school saying the
        class is not here — "7A undervisas inte på tisdagar" has no other way to
        be written, and the same row blocks that day's lessons too. Refusing the
        timetable over it would answer a correct statement with an error nobody
        can act on. Such a (group, day) is returned as EXEMPT: no lunch, and no
        chairs booked either, which is strictly more accurate than the standing
        "every home class eats every school day" simplification.

        A rule that merely leaves fragments too short for the break is the
        opposite case: the class is in school, busy, and the school has asked
        for something impossible. That is subtracted, and refused by name if
        nothing survives.

        The arithmetic is _lunch_starts_blocked_by_fixed_lessons's, and the
        blocked shape is the same — absolute slots, keyed by (group, day) —
        so the two merge into one domain subtraction.
        """
        blocked: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        exempt: set[tuple[UUID, int]] = set()
        slots_per_day = self._grid.slots_per_day

        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.resource_kind != "STUDENT_GROUP":
                continue
            group_id = constraint.resource_id
            if group_id is None or group_id not in lunch_group_ids:
                continue

            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from ("Time 11:07:00 is not aligned to 5-minute slots"), which
                # leaves a school to find which of its reservations that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc

            for abs_start, abs_end in windows:
                day_index = abs_start // slots_per_day
                day_offset = day_index * slots_per_day
                local_start = abs_start - day_offset
                local_end = abs_end - day_offset

                # Covers the lunch window whole: the class is not here.
                if local_start <= earliest_start and local_end >= window_end:
                    exempt.add((group_id, day_index))
                    continue

                first_bad = local_start - lunch_slots + 1
                last_bad = local_end - 1
                if last_bad < earliest_start or first_bad > latest_start:
                    continue
                # ABSOLUTE slots, as the locked-lesson helper returns them: the
                # domain these are cut from is absolute. Day-relative, as this
                # first shipped, a range met the domain only on the first day
                # of the week, and a Tuesday reservation never moved a lunch.
                blocked.setdefault((group_id, day_index), []).append(
                    (
                        day_offset + max(first_bad, earliest_start),
                        day_offset + min(last_bad, latest_start),
                    ),
                )

        # An exempt day needs no subtraction: there is no lunch to place.
        for key in exempt:
            blocked.pop(key, None)
        return blocked, exempt

    def _lunch_starts_blocked_by_fixed_lessons(
        self,
        fixed_lessons: list[FixedLesson],
        lunch_group_ids: set[UUID],
        shares_students: dict[UUID, list[UUID]],
        earliest_start: int,
        latest_start: int,
        lunch_slots: int,
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """Lunch starts a group may not take, because a human already booked it.

        A locked lesson exists in the model only as a window the *generated*
        lessons steer around (_add_fixed_lesson_constraints); it is never an
        interval, so the free-window guarantee below has always been free to
        drop a class's lunch straight on top of a lesson somebody placed by
        hand. Now that the same interval also books seats, that puts the class
        in the hall at a time it is demonstrably sitting in a classroom.

        Both windows are constant, so the answer is arithmetic rather than a
        constraint: a break of `lunch_slots` starting at s clashes with a
        locked window [a, b) exactly for s in [a - lunch_slots + 1, b - 1].
        Handing that back as a domain to subtract costs no boolean, no
        interval and no propagator — and unlike a NoOverlap over constant
        intervals it stays quiet about two locked lessons that overlap each
        other, which is a school's own data problem and not a reason to refuse
        the whole week.

        `earliest_start` and `latest_start` bound an admissible lunch start
        within its day. A locked lesson that clears the window entirely is
        dropped here rather than carried down to subtract nothing.

        Which locked lessons reach a group is the rule
        _add_fixed_lesson_constraints already applies: the groups the lesson
        names (extra_group_ids included, since a lesson two classes attend
        holds both of them), plus every group sharing students with one of
        them. `lunch_group_ids` is the set that will actually get a break, so
        a lesson naming a group nobody is feeding subtracts nothing.
        """
        blocked: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        slots_per_day = self._grid.slots_per_day
        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                # Outside the grid: it falls on no day a lunch falls on.
                continue
            abs_start, abs_end = window
            day_index = abs_start // slots_per_day
            day_offset = day_index * slots_per_day
            # Starts this locked lesson rules out, in the day's own coordinates
            # so they can be compared with the lunch window straight off.
            first_bad = abs_start - day_offset - lunch_slots + 1
            last_bad = abs_end - day_offset - 1
            if last_bad < earliest_start or first_bad > latest_start:
                # Wholly outside the lunch window: every start it forbids was
                # inadmissible to begin with.
                continue

            # The CLASS space, as the meal is the class's: a locked 7A svenska
            # takes 7A's window whoever sits it, and pupilGroupIds is not read.
            reached: list[UUID] = []
            for named_id in (fixed.student_group_id, *fixed.extra_group_ids):
                for group_id in (named_id, *shares_students.get(named_id, ())):
                    if group_id in lunch_group_ids and group_id not in reached:
                        reached.append(group_id)
            for group_id in reached:
                blocked.setdefault((group_id, day_index), []).append(
                    (day_offset + first_bad, day_offset + last_bad),
                )
        return blocked

    def _add_rules_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        rules: ScheduleRules | None,
        day_vars: dict[str, cp_model.IntVar],
        fixed_lessons: list[FixedLesson],
        groups: list[AnonymousGroup],
        constraints: list[AnonymousConstraint],
        servings: list[LunchServing],
        frames: list[FrameTime],
        group_conflicts: list[tuple[UUID, UUID]] | None = None,
        lunch_placements: list[LunchPlacement] | None = None,
        *,
        step: int,
    ) -> dict[tuple[UUID, int], cp_model.IntVar]:
        """Hard school rules: lunch break, dining hall seats, lessons per day.

        Returns the lunch start variable per (student group, day index), so the
        sitting the solver chose can be read back. It was always decided here
        and always discarded — this method was declared `-> None` and the
        variable was a loop-local. Returning the map is the whole of the fix;
        no constraint changes.

        `fixed_lessons` and `groups` are required, unlike `group_conflicts`,
        which follows its siblings in defaulting to None. The difference is
        what a caller that forgets one gets: an omitted `group_conflicts` is a
        payload that genuinely has none, while an omitted `fixed_lessons` or
        `groups` would build a model with no locked-lesson blocking and an
        empty dining hall and say nothing about it. A TypeError names the
        caller; a default would have let it profile the wrong model in silence.
        """
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar] = {}
        if rules is None:
            return lunch_starts

        # THE CLASS SPACE (pupil_key_of has the two): the maximum and the
        # lunch are rules about the class, so 7A's svenska is 7A's lesson here
        # whoever sits it, and a derived pupil key has no lessons at all.
        by_group: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_group.setdefault(
                decision.lesson.requirement.student_group_id, [],
            ).append(decision)

        shares_students = _groups_sharing_students(group_conflicts)

        # --- Max lessons per day per student group -------------------------
        max_per_day = rules.max_lessons_per_day_per_group
        if max_per_day is not None:
            day_count = len(self._grid.schedule_days)
            for group_id, group in by_group.items():
                if len(group) <= max_per_day:
                    continue
                # ONE LITERAL PER GROUP, the way distribution has one per
                # requirement: the maximum binds each group on its own.
                # Posted bare it named nothing — a week it alone made
                # impossible (five lessons on two open days, two a day) came
                # back CONFLICT_NO_CORE, and the school read a guess about
                # rooms and teacher time for a rule it can raise in one field.
                #
                # THE SAME VALUES FOR EVERY GROUP, so the core's groups merge
                # into one line naming them in resource_ids
                # (build_conflict_analysis): the maximum is one field on the
                # school rules, and a line per class said it eighteen times.
                # Whether the line is said at all is _daily_maximum_verdict's
                # to measure, and `measured` its to set.
                daily_literal = registry.register(
                    model,
                    name=f"groupdailymax_{group_id}",
                    # "För många lektioner", as DEMAND_CLIQUE_HOURS_SHORT
                    # files a class's week: the class has more lessons than
                    # its days take at the maximum.
                    category="REQUIREMENT_DEMAND",
                    code="GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT",
                    params={"maxPerDay": max_per_day, "measured": 0},
                    resource_ids=[group_id],
                )
                days = [self._day_var(model, d, day_vars) for d in group]
                on_days: dict[int, cp_model.LinearExpr] = {}
                for day_index in range(day_count):
                    on_day: list[cp_model.IntVar] = []
                    for k, decision in enumerate(group):
                        b = model.NewBoolVar(
                            f"onday_{group_id}_{day_index}_{decision.lesson.key()}",
                        )
                        model.Add(days[k] == day_index).OnlyEnforceIf(b)
                        model.Add(days[k] != day_index).OnlyEnforceIf(b.Not())
                        on_day.append(b)
                    on_days[day_index] = sum(on_day)
                # A count per day under the maximum, and never `Σ on_day ≤
                # max`: see _day_totals. The counts and their week are bare,
                # as definitions are, so their domain is the group's lessons
                # and not the maximum; the maximum on them hangs on the
                # literal. Phase 1 pins the literal true, so presolve still
                # refutes on the week row the weeks it once threw on
                # (test_solve_guard.py keeps them).
                counts = _day_totals(
                    model, f"ondaycount_{group_id}", on_days,
                    dict.fromkeys(on_days, len(group)), len(group),
                )
                for count in counts.values():
                    model.Add(count <= max_per_day).OnlyEnforceIf(daily_literal)

        # --- Guaranteed lunch break per student group per day ---------------
        if _lunch_window_is_set(rules):
            window_start, window_end, lunch_slots = self._lunch_window_slots(rules)
            lattice = _start_lattice(step, self._grid.horizon)

            seats = rules.dining_seats
            seats_literal = None
            if seats is not None:
                # A cumulative takes no OnlyEnforceIf, so the only way a full
                # dining hall can reach a conflict core is to be the PRESENCE
                # of the sittings in it: assume the literal and the seat rule
                # is in force, drop it and every sitting vanishes and the
                # cumulative says nothing. One literal serves every sitting —
                # they stand or fall together — so the whole mechanism costs a
                # single boolean. Without it the response degrades to the
                # INSUFFICIENT_RESOURCES fallback, which tells a school to
                # look at its rooms and teacher time for a problem that is
                # neither.
                seats_literal = registry.register(
                    model,
                    name="dining_capacity",
                    category="DINING_CAPACITY",
                    code="LUNCH_SEATS_CANNOT_STAGGER",
                    params={"seats": seats},
                )

            # Everyone who gets a break, and what each of them needs in chairs.
            # Both prefer the payload's `groups` to the decisions, which is the
            # whole of the fix for a class whose week is hand-placed: such a
            # class has no requirement left and so no decisions, and while
            # these came off the requirements it was invisible at lunch while
            # being plainly visible everywhere else. `by_group` is passed as
            # the reading for a payload that sends no `groups` AT ALL — not as
            # something unioned in on top of one that does.
            lunch_group_ids = _lunch_group_ids(groups, by_group)
            headcount_by_group = _lunch_headcounts(groups)
            # A meal has no requirement, so the stage it belongs to comes off
            # the group itself. A group with no derivable years matches no
            # serving and no frame and keeps the school-wide window.
            span_by_group = {
                group.id: (group.min_grade_level, group.max_grade_level)
                for group in groups
                if group.min_grade_level is not None and group.max_grade_level is not None
            }

            # The meals the school placed by hand, read once for the model.
            pins = self._lunch_pins(lunch_placements or [], lunch_group_ids)

            # Lunch starts a locked lesson has already taken away. Computed
            # once for the whole model: the windows are constant, so this is
            # arithmetic on the payload rather than anything in the model.
            blocked_starts = self._lunch_starts_blocked_by_fixed_lessons(
                fixed_lessons,
                set(lunch_group_ids),
                shares_students,
                window_start,
                window_end - lunch_slots,
                lunch_slots,
            )
            closed_starts, exempt_days = self._lunch_starts_blocked_by_constraints(
                constraints,
                set(lunch_group_ids),
                window_start,
                window_end - lunch_slots,
                window_end,
                lunch_slots,
            )

            # "There is a contiguous free window of `lunch_slots` inside the
            # lunch window" is exactly "a mandatory task of that length can be
            # placed among this group's lessons". Handing that to the
            # disjunctive propagator as one movable interval per (group, day)
            # replaces an existential over every candidate start:
            #
            #   was:  3 booleans per (group x day x candidate x lesson)
            #         — 302,400 variables at 2,000 students, 46% of the model
            #   now:  1 interval per (group, day) — 400 variables
            #
            # The old encoding also propagated almost nothing: its final
            # AddBoolOr over the per-candidate literals could not prune until
            # every candidate but one had been individually refuted, which needs
            # the lesson starts nearly fixed. The interval form lets CP-SAT
            # deduce "these lessons plus a mandatory break do not fit" up front.
            #
            # The NoOverlap below spans the group's lessons *and* its lunch
            # intervals, so it also covers single-lesson groups, which
            # _add_group_no_overlap skips.

            # --- The dining hall's seats ----------------------------------
            #
            # EVERY HOME CLASS EATS EVERY SCHOOL DAY. The demand is
            # unconditional: the class's headcount, on the lunch interval it
            # already has, on every day of the grid. Two rounds of review
            # killed the alternative, which asked a presence literal whether
            # the group was "in the building" that day. The payload carries one
            # headcount per group and no finer grain — it cannot say "eight of
            # 7A are here" — so that question has no honest answer. Asking only
            # about the group's own lessons booked nought seats for a class at
            # school through a teaching group. Widening it to every group
            # sharing its students booked all N home classes in full the moment
            # one nivågrupp met, an over-count unbounded in N that refuses a
            # timetable and blames the hall. Locked lessons were invisible to
            # both. Unconditional demand has neither error: a day's total is
            # exactly the size of the school.
            #
            # What it costs, said plainly rather than buried: a class with a
            # completely empty day still books seats it will not use. That is
            # the only inexactness left, it errs towards a hall held for
            # children who stayed at home rather than children sent to a room
            # with no chairs in it, and a school can be told it in one
            # sentence — every class eats every school day.
            sittings: list[cp_model.IntervalVar] = []
            headcounts: list[int] = []

            slots_per_day = self._grid.slots_per_day
            for group_id in lunch_group_ids:
                # Empty for a class whose whole week is locked. Its NoOverlap
                # below then spans nothing but its own five lunch intervals,
                # one per day, which are disjoint by construction — a vacuous
                # constraint, and deliberately not special-cased. The interval
                # is still worth building: it is what the locked-lesson domain
                # restriction narrows and what books the class's chairs.
                lessons = by_group.get(group_id, [])
                # Partners with lessons to dodge. The relation itself keeps the
                # ones the timplan never mentions, because their locked lessons
                # still count; here there is nothing to put in a NoOverlap.
                sharing = [
                    other_id
                    for other_id in shares_students.get(group_id, ())
                    if other_id in by_group
                ]
                # Home classes only. The gateway sends a teaching group's
                # headcount as 0 because its students already eat with their
                # home class, and a group contributing nothing is left out of
                # the cumulative rather than added with demand 0: an interval
                # that occupies no seat is pure propagator work. A group the
                # gateway has not listed at all reads the same way — "nobody
                # has told us who eats" — which is what the engine sees until
                # the gateway that sends `groups` is deployed.
                headcount = headcount_by_group.get(group_id, 0)
                lunch_intervals: list[cp_model.IntervalVar] = []
                for day_index in range(len(self._grid.schedule_days)):
                    # The school has closed this day for this class. No lunch
                    # variable, no mandatory interval, no seat demand — the
                    # class is not in the building to eat.
                    if (group_id, day_index) in exempt_days:
                        continue
                    day_offset = day_index * slots_per_day
                    # Inclusive bounds matching the candidate enumeration this
                    # replaces: range(window_start, window_end - lunch_slots + 1).
                    pin = pins.get((group_id, day_index))
                    low, high = self._lunch_start_bounds(
                        pin, day_offset, window_start, window_end, lunch_slots,
                    )
                    # On the week's step, as every lesson start is. Both bounds
                    # and a pin are multiples of it (see _start_step), so the
                    # hull loses neither end.
                    lunch_start = model.NewIntVarFromDomain(
                        _on_lattice(cp_model.Domain(low, high), lattice),
                        f"lunchstart_{group_id}_{day_index}",
                    )
                    lunch_starts[(group_id, day_index)] = lunch_start

                    # The school's own sentence about when this stage eats, and
                    # the hours its stage may be taught in at all. Both narrow
                    # the DOMAIN rather than forbidding intervals in it — the
                    # same reason a frame narrows a lesson's start.
                    #
                    # UNCONDITIONAL, not under an assumption literal, unlike the
                    # two subtractions below. A narrowed domain that turns out
                    # empty is refused by name in _validate_request before any
                    # solve begins, so CP-SAT never meets one; an assumption
                    # would buy a conflict core for a case that cannot reach it.
                    declared = self._declared_lunch_domain(
                        servings,
                        frames,
                        span_by_group.get(group_id),
                        self._grid.schedule_days[day_index],
                        day_offset,
                        window_start,
                        window_end,
                        lunch_slots,
                    )
                    # A pinned meal outranks the sitting and the frame: that
                    # is what placing it by hand means.
                    if declared is not None and pin is None:
                        model.AddLinearExpressionInDomain(lunch_start, declared)

                    # And the locks and reservations are not narrowings of a
                    # pinned meal: _verify_lunch_placements refused any pin
                    # that lands on one, so on a pinned day they say nothing.
                    forbidden = None if pin is not None else blocked_starts.get((group_id, day_index))
                    if forbidden:
                        # UNDER AN ASSUMPTION LITERAL, not bare. A bare domain
                        # subtraction lets CP-SAT prove infeasibility without
                        # touching a single assumption, and
                        # SufficientAssumptionsForInfeasibility then returns an
                        # empty core — which does not merely lose this cause,
                        # it erases every other cause in the payload and hands
                        # the school the INSUFFICIENT_RESOURCES fallback,
                        # telling it to go and look at rooms and teacher time.
                        # One lock anywhere silently blinded the whole
                        # diagnosis. AddLinearExpressionInDomain takes
                        # OnlyEnforceIf (verified on ortools 9.15: the proto
                        # carries an enforcement_literal on the linear
                        # constraint), so the fact costs one boolean and
                        # nothing else. In the fast build the literal is pinned
                        # by AddBoolAnd and presolve folds the enforcement
                        # away, so the encoding is unchanged there.
                        #
                        # GROUP_OVERLAP, deliberately not AVAILABILITY: in this
                        # engine AVAILABILITY means an AvailabilityConstraint
                        # row and its message names one, so an admin sent there
                        # would open the reservations page and find nothing to
                        # change. Nor DINING_CAPACITY, which would be a lie —
                        # this fails with no seat limit set at all. What
                        # actually collides is the group's mandatory break and
                        # lessons its own children are sitting in, which is a
                        # group double-booked.
                        #
                        # Per (group, day) rather than one literal for the
                        # school, because "7A on Tuesday" is the whole content
                        # of the answer. The count is bounded by groups x days,
                        # an order of magnitude under what
                        # _add_capacity_constraints already registers per lesson.
                        lunch_literal = registry.register(
                            model,
                            name=f"lunchlock_{group_id}_{day_index}",
                            category="GROUP_OVERLAP",
                            # The same fact _validate_request refuses by
                            # name when the locks alone leave nothing, said
                            # through the one code both use.
                            code="LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
                            params={
                                "group": str(group_id),
                                "minutes": rules.lunch_minutes,
                                "windowStart": rules.lunch_start_time[:5],
                                "windowEnd": rules.lunch_end_time[:5],
                                "day": self._grid.schedule_days[day_index],
                            },
                            resource_ids=[group_id],
                        )
                        model.AddLinearExpressionInDomain(
                            lunch_start,
                            self._admissible_lunch_starts(
                                day_offset,
                                window_start,
                                window_end,
                                lunch_slots,
                                forbidden,
                            ),
                        ).OnlyEnforceIf(lunch_literal)

                    closed = None if pin is not None else closed_starts.get((group_id, day_index))
                    if closed:
                        # A SECOND literal rather than one domain merged with
                        # the locked-lesson one above. The two fail for reasons
                        # a school fixes in different places — a lesson to move
                        # versus a reservation to change — and a merged literal
                        # could only name one of them. AVAILABILITY here is
                        # honest, unlike the locked-lesson case: this IS an
                        # AvailabilityConstraint row and the id below is one an
                        # admin can look up.
                        closed_literal = registry.register(
                            model,
                            name=f"lunchclosed_{group_id}_{day_index}",
                            category="AVAILABILITY",
                            code="LUNCH_AVAILABILITY_LEAVES_NO_BREAK",
                            params={
                                "group": str(group_id),
                                "minutes": rules.lunch_minutes,
                                "windowStart": rules.lunch_start_time[:5],
                                "windowEnd": rules.lunch_end_time[:5],
                                "day": self._grid.schedule_days[day_index],
                            },
                            resource_ids=[group_id],
                        )
                        model.AddLinearExpressionInDomain(
                            lunch_start,
                            self._admissible_lunch_starts(
                                day_offset,
                                window_start,
                                window_end,
                                lunch_slots,
                                closed,
                            ),
                        ).OnlyEnforceIf(closed_literal)
                    if pin is not None:
                        # THE SCHOOL'S OWN MEAL, held where it was placed. Under
                        # a literal, never bare, for the reason the locked
                        # lessons above give: a bare equality lets CP-SAT prove
                        # a week impossible without touching an assumption, and
                        # the empty core that follows erases every other cause
                        # in the payload. The mandatory interval below is
                        # unchanged — the lessons still route round the meal —
                        # and so is the seat interval, because a meal the
                        # school placed does not make the hall any larger.
                        pin_literal = registry.register(
                            model,
                            name=f"lunchpin_{group_id}_{day_index}",
                            category="LUNCH_WINDOW",
                            code="LUNCH_PLACED_BY_HAND",
                            params={
                                "group": str(group_id),
                                "day": self._grid.schedule_days[day_index],
                                "start": self._grid.format_hhmmss(pin, 0)[0][:5],
                            },
                            resource_ids=[group_id],
                        )
                        model.Add(lunch_start == day_offset + pin).OnlyEnforceIf(pin_literal)
                    lunch_intervals.append(
                        model.NewFixedSizeIntervalVar(
                            lunch_start,
                            lunch_slots,
                            f"lunch_{group_id}_{day_index}",
                        ),
                    )
                    if seats_literal is not None and headcount > 0:
                        # The same start and the same length as the mandatory
                        # interval beside it, so the two views of one lunch can
                        # never disagree — but a SECOND interval object, because
                        # its presence is the dining assumption. Relaxing that
                        # assumption must empty the hall without also giving up
                        # the free-window guarantee, and it would give it up if
                        # the interval in the NoOverlap were the optional one.
                        sittings.append(
                            model.NewOptionalFixedSizeIntervalVar(
                                lunch_start,
                                lunch_slots,
                                seats_literal,
                                f"sitting_{group_id}_{day_index}",
                            ),
                        )
                        headcounts.append(headcount)
                if lunch_intervals:
                    # THE PUPILS' OWN INTERVAL, like every other family whose
                    # members are the children: a class still in the changing
                    # room has not got its break, and a meal that starts while
                    # they are showering is a meal the model records and nobody
                    # eats. Twenty minutes of shower is worth more of a lunch
                    # break than a corridor ever was.
                    #
                    # THE CLASS SPACE FOR WHO EATS, THE PUPIL SPACE FOR NOTHING
                    # ELSE. The meal is the class's, so it avoids every lesson
                    # filed under the class, its svenska too whoever sits it.
                    # But one no-overlap over all of them would also hold them
                    # apart from EACH OTHER, a lesson-against-lesson row the
                    # pupils' own relation may not have: two derived keys of
                    # one class sharing no pupil may run at once. So one
                    # no-overlap per pupil key among them (_by_pupils), which
                    # is one, the one it always was, for every class without a
                    # pupilGroupId — and the bare lunch row for a class with no
                    # lessons, as before. Bare no-overlaps of the kind always
                    # posted here, so no literal is owed: a derived key only
                    # takes rows away from the one this was.
                    for part in _by_pupils(lessons) or [lessons]:
                        model.AddNoOverlap(
                            [pupil_padded_of(model, decision) for decision in part]
                            + lunch_intervals,
                        )
                    # The break also has to be free of the lessons this group's
                    # own children sit in elsewhere. 7A cannot be eating while
                    # Ma71 is taught: those are the same thirty pupils, and the
                    # model would otherwise record a lunch that nobody had.
                    #
                    # One NoOverlap per sharing group, deliberately NOT one
                    # over the union of them all. Ma71 and Sp71 are both cut
                    # out of 7A but share no student with each other, and a
                    # single set containing both would forbid them from running
                    # at the same time — which is precisely what a school cuts
                    # parallel groups in order to do.
                    #
                    # Nothing lesson-against-lesson is added here: the partner's
                    # own lessons are already pairwise disjoint through
                    # _add_group_no_overlap, and so is every lesson pair across
                    # a sharing pair. The one new fact is lunch-against-lesson,
                    # so do not "simplify" this by folding it into the pair
                    # NoOverlap over there — that one carries no lunch. Split
                    # by pupil key for the reason just above.
                    for other_id in sharing:
                        for part in _by_pupils(by_group[other_id]):
                            model.AddNoOverlap(
                                [
                                    pupil_padded_of(model, decision)
                                    for decision in part
                                ]
                                + lunch_intervals,
                            )

            if sittings:
                # One cumulative for the whole week, not one per day. Every
                # sitting's start is confined to its own day by day_offset —
                # TimeGrid addresses day d as [d * slots_per_day, (d+1) *
                # slots_per_day) and the interval ends inside the lunch window —
                # so two sittings on different days provably cannot overlap and
                # five per-day cumulatives would only cost five times the
                # constraints to say the same thing.
                model.AddCumulative(sittings, headcounts, seats)

        return lunch_starts

    def _teacher_day_bounds(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        group: list[LessonDecision],
        day_index: int,
        day_vars: dict[str, cp_model.IntVar],
        cache: dict[tuple[UUID, int], _TeacherDay],
    ) -> _TeacherDay:
        """The two ends of one teacher's day, built once and handed out.

        Shared with _add_idle_time_objective through `cache`, which is why it is
        keyed on (teacher, day) and not on anything about the caller: the
        objective measures the same span this rule bounds, and two encodings of
        "when does Anna's Tuesday begin" would eventually disagree — and cost
        twice the literals while doing it.

        THE ABSENT LESSON IS GIVEN THE DAY'S OWN EDGE rather than left free.
        `AddMinEquality` needs a value from every lesson, including the ones on
        another day entirely, so each contributes its real start when it is here
        and the day's CLOSE when it is not — the identity for a minimum — and
        its real end or the day's OPEN for the maximum. Two IntVars per lesson
        and day, which is the price of a pair that means what its name says;
        the alternative, a literal per lesson saying "this one is the first",
        costs the same and propagates worse.
        """
        key = (teacher_id, day_index)
        existing = cache.get(key)
        if existing is not None:
            return existing

        slots_per_day = self._grid.slots_per_day
        base = day_index * slots_per_day
        tag = f"{teacher_id}_{day_index}"
        on_day: list[cp_model.IntVar] = []
        starts: list[cp_model.IntVar] = []
        ends: list[cp_model.IntVar] = []
        for decision in group:
            day_var = self._day_var(model, decision, day_vars)
            literal = model.NewBoolVar(f"tworks_{tag}_{decision.lesson.key()}")
            model.Add(day_var == day_index).OnlyEnforceIf(literal)
            model.Add(day_var != day_index).OnlyEnforceIf(literal.Not())
            on_day.append(literal)

            eff_start = model.NewIntVar(
                base, base + slots_per_day, f"tstart_{tag}_{decision.lesson.key()}",
            )
            model.Add(eff_start == decision.start).OnlyEnforceIf(literal)
            model.Add(eff_start == base + slots_per_day).OnlyEnforceIf(literal.Not())
            starts.append(eff_start)

            eff_end = model.NewIntVar(
                base, base + slots_per_day, f"tend_{tag}_{decision.lesson.key()}",
            )
            model.Add(eff_end == decision.end).OnlyEnforceIf(literal)
            model.Add(eff_end == base).OnlyEnforceIf(literal.Not())
            ends.append(eff_end)

        first = model.NewIntVar(base, base + slots_per_day, f"tfirst_{tag}")
        last = model.NewIntVar(base, base + slots_per_day, f"tlast_{tag}")
        model.AddMinEquality(first, starts)
        model.AddMaxEquality(last, ends)
        # A maximum over booleans is their disjunction, and one constraint says
        # it: `works` is true exactly when some lesson of this teacher is here.
        works = model.NewBoolVar(f"tday_{tag}")
        model.AddMaxEquality(works, on_day)

        built = _TeacherDay(
            first=first,
            last=last,
            works=works,
            on_day=tuple(on_day),
            taught=sum(
                decision.duration * literal
                for decision, literal in zip(group, on_day)
            ),
        )
        cache[key] = built
        return built

    def _add_teacher_work_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        work_rules: list[AnonymousTeacherWorkRule],
        fixed_lessons: list[FixedLesson],
        constraints: list[AnonymousConstraint],
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        *,
        step: int,
    ) -> None:
        """The two hours a teacher is owed: a lunch every day, a night's rest.

        THE FIRST RULE IN THIS MODEL WRITTEN FOR THE ADULTS. The lunch beside it
        is the PUPILS' — a window per class, a rast per stage — and the only
        per-teacher row that existed was an UNAVAILABLE reservation, which is a
        teacher CLOSING hours rather than being owed any. A teacher had no lunch
        anywhere in the model, and the idle-time objective is an objective: it
        prefers a compact day and will sell any hour of it for a placement.

        EMPTY IS NOT A DEFAULT. A rule naming no lunch and no rest constrains
        nothing, and a teacher no rule names is not reached at all, so a school
        that has filled in nobody is refused nothing. That is the user's own
        decision and it is also what lets the engine ship before the gateway
        that fills the list.

        A TEACHER WITH NO LESSON LEFT TO PLACE IS SKIPPED, and the line is
        deliberate. Both rules constrain where the SOLVER may put a lesson; a
        teacher whose whole week is hand-placed has no variable for either rule
        to bound, and refusing that week would be refusing the school's own
        arrangement in the name of a rule that could not have changed it. Their
        locked lessons are still read, everywhere a teacher who does have
        lessons meets them.

        padded_of AND NOT pupil_padded_of, which is _add_teacher_no_overlap's
        decision and its reason: the minutes around an idrottslektion are the
        PUPILS' — changing and showering — and the teacher spends none of them
        undressed. A lunch that read the pupils' interval would forbid what a
        school does on purpose, idrottsläraren eating while the class showers.

        TWO ROWS FOR ONE TEACHER ARE BUILT AS TWO, and the table's own unique
        index on the teacher is what makes that unreachable. Read literally, two
        rows are two breaks and two rests, which is what this builds; a silent
        "the first one wins" would be the engine quietly deciding which half of a
        payload it disagrees with, and that is worse than a week that is harder
        than anybody asked for.
        """
        if not work_rules:
            return

        # Every decision once per time the teacher is named on the LESSON
        # (_lesson_teachers) — a split post's lesson is its own lead's lunch
        # and rest to keep, not the colleague's — and _teacher_day_on reads
        # the positions of this very list.
        by_teacher: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            for teacher_id in _lesson_teachers(decision.lesson):
                by_teacher.setdefault(teacher_id, []).append(decision)

        locked_busy = self._teacher_busy_from_locks(fixed_lessons)
        closed_busy = self._teacher_busy_from_constraints(constraints)
        lattice = _start_lattice(step, self._grid.horizon)

        for rule in work_rules:
            group = by_teacher.get(rule.teacher_id)
            if not group:
                continue
            window = _teacher_lunch_slots(rule, self._grid)
            if window is not None:
                self._add_teacher_lunch(
                    model,
                    registry,
                    rule,
                    group,
                    window,
                    locked_busy,
                    closed_busy,
                    lattice,
                )
            if rule.min_daily_rest_minutes is not None:
                self._add_teacher_rest(
                    model,
                    registry,
                    rule,
                    group,
                    locked_busy,
                    day_vars,
                    teacher_days,
                )

    def _add_teacher_lunch(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        rule: AnonymousTeacherWorkRule,
        group: list[LessonDecision],
        window: tuple[int, int, int],
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        closed_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        lattice: cp_model.Domain | None,
    ) -> None:
        """One movable break per day, kept clear of everything the teacher does.

        THE SAME SHAPE THE GROUP LUNCH SETTLED ON, and for the same measured
        reason: "there is a contiguous free window of `lunch_slots` inside the
        window" is exactly "a task of that length can be placed among these
        lessons", and one movable interval per (teacher, day) hands that to the
        disjunctive propagator instead of an existential over every candidate
        start. One IntVar per teacher and day, against three booleans per
        candidate and lesson.

        NO `len(group) < 2` SKIP, which _add_idle_time_objective does make: idle
        time needs two lessons to exist between, and a lunch does not. A teacher
        with one four-hour lesson across the whole window is exactly the teacher
        this rule is for.

        THE INTERVAL IS OPTIONAL AND ITS PRESENCE IS THE ASSUMPTION. A mandatory
        interval in a NoOverlap takes no OnlyEnforceIf, so a week made
        impossible by the break alone would be proved impossible without
        touching a single assumption literal —
        SufficientAssumptionsForInfeasibility then returns an EMPTY core, which
        does not merely lose this cause but erases every other cause in the
        payload and hands the school the INSUFFICIENT_RESOURCES fallback,
        telling it to go and look at rooms and teacher time. Presence on a
        literal is the same trick the dining hall's seats use, for the same
        reason. In the fast build the literal is pinned by AddBoolAnd and
        presolve folds the optionality away, so the encoding is unchanged there.

        PER TEACHER AND DAY, like the group lunch's own literals and unlike the
        one literal per teacher this could have been. Two reasons, and the
        second is the load-bearing one. "Anna's Tuesday" is the whole content of
        the answer, as "7A on Tuesday" is next door. And the reading order in
        _how_far_it_narrows puts a line naming neither a day nor a resource
        last, as a line about the whole week — which a teacher's own rule is
        not; it cannot name a resource, because the only id it could put there
        is the teacher's and the gateway discards that map on purpose, so the
        DAY is the only thing that can lift this sentence out of the cellar.

        ONE LITERAL FOR BOTH SUBTRACTIONS, where the group lunch uses two. It
        can afford two because it has two sentences to say, one about a lesson
        to move and one about a reservation to change. This rule has one, and a
        second literal carrying the same code and the same values would be
        merged back into a single line by build_conflict_analysis — a variable
        for nothing. Which of the two it was is in the pre-flight refusal, which
        has the `causes` the day needs.
        """
        window_start, window_end, lunch_slots = window
        breaks: list[cp_model.IntervalVar] = []
        for day_index, day_of_week in enumerate(self._grid.schedule_days):
            day_offset = day_index * self._grid.slots_per_day
            key = (rule.teacher_id, day_index)
            closed = closed_busy.get(key, [])
            # The school has closed the whole window for this teacher: they are
            # not here, and a break they were never owed must not refuse the
            # week. The same reading _lunch_starts_blocked_by_constraints makes
            # of a class whose Tuesday is reserved end to end.
            if _covers(closed, day_offset + window_start, day_offset + window_end):
                continue

            lunch_start = model.NewIntVarFromDomain(
                _on_lattice(
                    cp_model.Domain(
                        day_offset + window_start,
                        day_offset + window_end - lunch_slots,
                    ),
                    lattice,
                ),
                f"teacherlunch_{rule.teacher_id}_{day_index}",
            )
            literal = registry.register(
                model,
                name=f"teacherlunchstart_{rule.teacher_id}_{day_index}",
                category="LUNCH_WINDOW",
                code="TEACHER_LUNCH_HAS_NOWHERE_TO_GO",
                params={
                    "rule": str(rule.id),
                    "minutes": rule.lunch_minutes,
                    "windowStart": rule.lunch_start_time[:5],
                    "windowEnd": rule.lunch_end_time[:5],
                    "day": day_of_week,
                },
                # THE RULE'S ID AND NEVER THE TEACHER'S. The gateway keeps a map
                # for the rule and reverses it here as well as in the sentence,
                # so this is a row an administrator can open; the teacher map is
                # discarded by design, so a teacher id put here would reach the
                # school as a uuid in no table, and no name would ever fill the
                # slot beside it. It also lifts this line to the top of the
                # reading order in _how_far_it_narrows, which ranks a cause
                # naming both a day and a something above one naming neither —
                # and a teacher's own rule on a known day is the most checkable
                # thing in the whole report.
                resource_ids=[rule.id],
            )
            forbidden = _forbidden_lunch_starts(
                locked_busy.get(key, []) + closed,
                day_offset + window_start,
                day_offset + window_end - lunch_slots,
                lunch_slots,
            )
            if forbidden:
                # UNDER THE LITERAL, never bare, for the reason the group
                # lunch's own subtraction gives: a bare domain narrowing lets
                # CP-SAT prove a week impossible without touching an assumption,
                # and the empty core that follows takes every other cause in the
                # payload down with it.
                #
                # Through the class lunch's own helper, which asks exactly this
                # question of exactly this shape — the window less what is taken,
                # in absolute slots — so a teacher's break and a class's are
                # subtracted by one rule and not by two that could disagree.
                model.AddLinearExpressionInDomain(
                    lunch_start,
                    self._admissible_lunch_starts(
                        day_offset, window_start, window_end, lunch_slots, forbidden,
                    ),
                ).OnlyEnforceIf(literal)
            breaks.append(
                model.NewOptionalFixedSizeIntervalVar(
                    lunch_start,
                    lunch_slots,
                    literal,
                    f"teacherbreak_{rule.teacher_id}_{day_index}",
                ),
            )
        if breaks:
            # ONE NoOverlap FOR THE WEEK, as the group lunch builds one per
            # class: every break's start is confined to its own day and ends
            # inside the window, so two of them provably cannot overlap, and one
            # constraint per day would only cost five times as much to say the
            # same thing about the same lessons.
            model.AddNoOverlap(
                [padded_of(model, decision) for decision in group] + breaks,
            )

    def _add_teacher_rest(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        rule: AnonymousTeacherWorkRule,
        group: list[LessonDecision],
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
    ) -> None:
        """Hours between the end of one teaching day and the start of the next.

        ONE INEQUALITY PER PAIR OF CONSECUTIVE DAYS: `last(d) + rest <=
        first(d+1) + pad`, where pad is the closed part of the night the grid
        itself leaves (see _night_pad_slots — absolute slots count only the
        hours the school teaches in, so the night has to be added back).

        ENFORCED ONLY WHERE BOTH DAYS HOLD A LESSON. A day nobody works must not
        refuse the week: without the guard a teacher with a free Wednesday would
        be asked to rest between two days they did not work, and `first` and
        `last` on an empty day are the day's own edges rather than any lesson's.
        The guard is a variable and not an assumption, so relaxing the rule
        cannot accidentally decide which days the teacher works.

        THE TEACHER'S LOCKED LESSONS ARE FOLDED IN AS CONSTANTS, and leaving
        them out was the one way this rule could have been quietly optional. A
        locked lesson is real teaching — _add_fixed_lesson_constraints makes it
        a hard blocker for the same teacher — and a school whose Monday evening
        is hand-placed would otherwise have its Tuesday morning placed freely
        against a rest rule that could not see the evening at all. Folding costs
        two IntVars on a day that has one, no new literal, and it also closes
        the case where BOTH ends are locked: the day is then certainly worked,
        so its `works` guard is dropped and the inequality is left to compare
        two constants — which is a refusal the literal can name, rather than one
        nothing in the model would have made.

        A WEEK THE GRID CANNOT BREAK. With the engine's own 08:00-18:00 day the
        closed night is fourteen hours, so eleven hours of rest can never bind:
        the rule bites exactly where a school's configured day runs longer than
        the night the rest asks for, which is why 660 minutes is a safe
        suggestion for a grundskola and a real constraint for a school teaching
        into the evening. Stated here because a rule that holds vacuously is
        worth knowing about before somebody measures its cost and finds none.

        A WEEK OF ONE DAY HAS NO PAIR OF CONSECUTIVE DAYS, and nothing is built
        for it — not the inequality, and not the day it would compare either,
        which is several variables per lesson bought to be measured against
        nothing.
        """
        if len(self._grid.schedule_days) < 2:
            return
        rest_slots = -(-rule.min_daily_rest_minutes // self._grid.slot_minutes)
        bounds = [
            self._teacher_day_bounds(
                model, rule.teacher_id, group, day_index, day_vars, teacher_days,
            )
            for day_index in range(len(self._grid.schedule_days))
        ]
        for day_index, day_of_week in enumerate(self._grid.schedule_days[:-1]):
            literal = registry.register(
                model,
                name=f"teacherrest_{rule.teacher_id}_{day_index}",
                category="TEACHER_OVERLAP",
                code="TEACHER_REST_CANNOT_BE_KEPT",
                params={
                    "rule": str(rule.id),
                    "restMinutes": rule.min_daily_rest_minutes,
                    "day": day_of_week,
                },
                # The rule and never the teacher — see the lunch literal above.
                resource_ids=[rule.id],
            )
            enforce = [literal]
            ends = self._teacher_locked_edge(
                model, rule.teacher_id, day_index, bounds[day_index], locked_busy,
                latest=True,
            )
            if ends is None:
                ends = bounds[day_index].last
                enforce.append(bounds[day_index].works)
            starts = self._teacher_locked_edge(
                model, rule.teacher_id, day_index + 1, bounds[day_index + 1],
                locked_busy, latest=False,
            )
            if starts is None:
                starts = bounds[day_index + 1].first
                enforce.append(bounds[day_index + 1].works)
            model.Add(
                ends + rest_slots <= starts + _night_pad_slots(self._grid, day_index),
            ).OnlyEnforceIf(enforce)

    def _teacher_locked_edge(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        day_index: int,
        bounds: _TeacherDay,
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        *,
        latest: bool,
    ) -> cp_model.IntVar | None:
        """One end of a day that also holds locked lessons, or None if it has none.

        The generated end folded with the hand-placed one: the latest end of the
        two, or the earliest start. None where the teacher has no locked lesson
        that day, which is the ordinary case and pays nothing — the caller then
        uses the day's own end and guards it with `works`, since a day with
        nothing locked may hold no lesson at all.
        """
        windows = locked_busy.get((teacher_id, day_index))
        if not windows:
            return None
        slots_per_day = self._grid.slots_per_day
        base = day_index * slots_per_day
        folded = model.NewIntVar(
            base,
            base + slots_per_day,
            f"tlocked{'end' if latest else 'start'}_{teacher_id}_{day_index}",
        )
        if latest:
            model.AddMaxEquality(
                folded, [bounds.last, max(end for _start, end in windows)],
            )
        else:
            model.AddMinEquality(
                folded, [bounds.first, min(start for start, _end in windows)],
            )
        return folded

    def _teacher_busy_from_locks(
        self, fixed_lessons: list[FixedLesson],
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """(teacher, day index) -> the absolute windows a hand-placed lesson takes.

        The reach _add_fixed_lesson_constraints uses, which is the lesson's own
        teacher and its co-teacher: a lesson two adults give occupies both of
        them, and a rule that read the lead alone would let every co-taught
        school out of both halves of this feature.

        The window is _fixed_lesson_window's, rounded outward and clipped to the
        day, so a lunch subtracted from it and a lesson blocked by it agree to
        the slot.
        """
        busy: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                continue
            day_index = window[0] // self._grid.slots_per_day
            for teacher_id in (fixed.teacher_id, fixed.co_teacher_id):
                if teacher_id is not None:
                    busy.setdefault((teacher_id, day_index), []).append(window)
        return busy

    def _teacher_busy_from_constraints(
        self, constraints: list[AnonymousConstraint],
    ) -> dict[tuple[UUID, int], list[tuple[int, int]]]:
        """(teacher, day index) -> the absolute windows the school has closed.

        TEACHER rows only, and weekly ones only, matching
        _add_availability_constraints: the model is one generic week and has
        nowhere to put a single date. A dated absence is already a soft penalty
        over there and must not become a hard hole in a break somebody is owed.

        NOT the other kinds. A room being closed says nothing about where a
        teacher eats, and a class's reservation is the class's own time — the
        teacher is very often the person the class was reserved FOR.

        These windows are read by the lunch and NOT by the rest, and the
        asymmetry is the point: a reservation is time the teacher is NOT
        teaching, so it can take a lunch start away, and it can never be the
        late lesson that shortens a night.
        """
        busy: dict[tuple[UUID, int], list[tuple[int, int]]] = {}
        for constraint in constraints:
            if constraint.kind != "UNAVAILABLE" or constraint.date is not None:
                continue
            if constraint.resource_kind != "TEACHER" or constraint.resource_id is None:
                continue
            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week, constraint.start_time, constraint.end_time,
                )
            except ValueError as exc:
                # The grid's own complaint names a time and not the row it came
                # from, which leaves a school to find which reservation that was.
                raise InvalidScheduleInputError.of("INPUT_CONSTRAINT_TIME_OFF_GRID", {
                    **self._constraint_params(constraint),
                    "slotMinutes": self._grid.slot_minutes,
                }) from exc
            for abs_start, abs_end in windows:
                day_index = abs_start // self._grid.slots_per_day
                busy.setdefault(
                    (constraint.resource_id, day_index), [],
                ).append((abs_start, abs_end))
        return busy

    def _add_teacher_day_constraints(
        self,
        model: cp_model.CpModel,
        registry: AssumptionRegistry,
        decisions: list[LessonDecision],
        work_rules: list[AnonymousTeacherWorkRule],
        day_limits: list[AnonymousTeacherDayLimit],
        fixed_lessons: list[FixedLesson],
        day_vars: dict[str, cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        literals: _TeacherDayLiterals,
    ) -> None:
        """Lärarens dag: at most a cap of minutes a day, on at most N days a week.

        TWO RULES ON TWO ROWS, AND TWO LITERALS. The cap is the work rule's —
        staff-readable, named by the rule's id — and the days are the post's,
        which is HR and named by the post's id. A core that blamed them as one
        would put the deltid figure inside a sentence every administrator
        reads, so they never share a literal or a code: one per (teacher, day)
        for the cap, under TEACHER_DAILY_CAP_CANNOT_BE_KEPT, because "Anna's
        Tuesday" is what the school opens and the day lifts the line in the
        reading order; one per teacher for the days, under
        TEACHER_WORK_DAYS_CANNOT_BE_KEPT, because the week is the unit of a
        days limit. Every rule constraint hangs on its literal and nothing
        rule-shaped is ever posted bare: a bare narrowing proves a week
        impossible without touching an assumption, and the empty core that
        follows erases every other cause the payload has.

        IN MINUTES, EACH LESSON ITS OWN. The cap is a sum over the day's
        literals of each lesson's length in minutes — 90 for slöjd, 40 for a
        short idrott — against what the cap leaves. The lengths are on the
        grid (INPUT_LESSON_LENGTH_OFF_GRID), so the sum is exact.

        THE LOCKED LESSONS ARE FACTS, the distribution builder's precedent. A
        teacher's hand-placed lessons are counted at their exact clock spans,
        unclipped and their union once (_teacher_locks), and they are never
        refused here: what they already take is subtracted from the cap — the
        residual, floored at zero, which then closes the day to the solver's
        own lessons under the literal and never bare. The cap counts every
        lock on a weekday, an odd week's beside an even week's, which is the
        strict reading and the safe one for a generator. A school that
        hand-placed a breach was warned beside that edit
        (master-lessons.service.ts), and refusing the week for it would turn
        the warning into a block one screen later.

        THE DAYS ARE HELD IN EVERY WEEK THE LOCKS MAKE, and not against the
        weekdays of every lock at once. The gateway reads the real ISO weeks
        and sends the sets of weekdays the teacher's locks hold together in
        one (AnonymousTeacherDayLimit.locked_weekdays); for each set L the
        days the solver's own lessons take outside L number at most
        max(0, N − |L|). A generated lesson runs every week, so a weekday
        outside some week's locks is a day added to that week, wherever else
        the locks sit. The union of the weekdays was the reading once, and it
        let a post of two, locked Monday and Tuesday in odd weeks and
        Wednesday and Thursday in even ones, take a weekly Monday and a
        weekly Wednesday: N − 4 floored at zero closed Friday alone, and
        every real week had three days. Every set hangs on the one literal,
        because the post is one rule and the week its unit; a set inside
        another of at most N days says nothing the larger does not and is
        never built (_week_sets proves it). For a teacher locked the same
        every week the list is that one set, and the model is the one the
        union built.

        THE LINKING CONSTRAINT IS THE ONE BARE RULE LINE, AND IT IS SAFE BARE.
        For a teacher with a days limit, every day's minutes are at most the
        room the day has for them times `works`: `minutes ≤ C·works`, C being
        the slots any of the teacher's lessons could occupy that day less what
        their locked lessons take (_teaching_room). That is implied by the
        teacher's NoOverlap and the locked lessons' own avoidance, both bare,
        so it can refuse nothing — and it is what turns a days limit the week
        cannot hold from a pigeonhole the search walks for its whole budget
        into an LP the solver closes at once. Measured by the design review on
        a sixteen-lesson week, UNKNOWN after 20 s without it and INFEASIBLE in
        0.02 s with it; and on the högstadium week's impossible post
        (benchmarks/hogstadium.py --infeasible-days), side by side on one
        loaded host, UNKNOWN after 60 s without it and INFEASIBLE in 3.1 s
        with it. A locked day gets its row too, and needs it most: that post
        is impossible because its two locked afternoons hold less than the
        week does.

        Implied, so a week these rows refuse on their own is a week the
        teacher's NoOverlap refuses too. With the days' totals summed that is
        the week's minutes against every day's room, and no rule is in it.
        The fuzz found four such weeks: frame times left a teacher's year-7
        classes one day, and the explaining solve proved them impossible with
        every literal released, so the core came back empty.
        _teacher_hours_verdict counts them before the model and names the
        hours. Hanging these rows on the post's literal would not have named
        anything true: the post would have been in a core it is no part of.

        ON THE DAY'S MINUTES, NEVER ON THEIR SUM. Each row bounds the day's
        total of the teacher's minutes, a variable equal to `Σ minutes·x` with
        the week's minutes the sum of the days' (_day_totals, bare: a
        definition and the lessons' own one day each, which refuse nothing).
        Two `Σ minutes·x ≤ R` rows on two days are what CP-SAT 9.15.6755's
        presolve threw an IndexError on (absl raw_hash_map::at, out of Solve,
        a 500 to the school), once each lesson's day literals were down to
        those two — phase 1 pins every literal, so a row under one is as
        constant there as a bare one. The review's fuzz found it in 3 weeks
        of about 1,000 from the linking row, and with that row dropped once in
        1,500 from the cap's, each a week that should have named the post
        (test_teacher_day.py keeps both).

        AND TIMES `works`, a locked day included, though that was the first
        cure and is not the cure. A locked day's rows — the cap's under its
        literal, the linking one bare — are `≤ R·works` and not `≤ R`, though
        the lock makes it a teaching day either way: `works` is 1 whenever a
        term of the sum is not 0, so the bound is the same and the LP row no
        weaker, and one row sees the cap and the days limit together. (The
        rest rule's `works` is its lessons' maximum, so a lock does not force
        it to 1 either.) It ended the throws above, but not the cause: where a
        week's minutes force both days to be worked, presolve fixes `works`
        to 1 and the row is `≤ R` again, and the guard's fuzz found one such
        week in 5,865 (test_solve_guard.py keeps it). Dropping the locked
        days' rows is no cure either: side by side at a load of 237-300 on
        the högstadium week's impossible post, INFEASIBLE in 14.6 s times
        `works`, 16.2 s against the constant, and TIMEOUT on the 90 s budget
        with the linking rows of the locked days left out.

        `works` IS NOT FREE. Each lesson on the day implies it, and it is at
        most their sum, so it is true exactly when the teacher teaches there;
        a free literal would be a decision the search could take for nothing,
        and a few thousand such were measured flipping a solvable model to
        UNKNOWN (see _build_model).

        THE REST RULE'S DAY IS REUSED, NEVER REBUILT, AND NEVER WRITTEN.
        Where _add_teacher_rest already built a teacher's day, its per-lesson
        literals and its `works` are these, read off `teacher_days`; anywhere
        else the literals are one per lesson in `literals`, shared by lead and
        co-teacher. _teacher_day_bounds is not called: an entry it wrote would
        switch the idle objective to the two-sided pair for every capped
        teacher. See _TeacherDayLiterals.

        NOTHING THAT CANNOT BIND IS BUILT. A day whose residual already holds
        every minute the teacher's lessons could bring there — or every minute
        the day has room for — has no cap constraint, a week whose locks leave
        at least as many days as the teacher's lessons can reach outside them
        has no days row, and a limit none of whose weeks has one has no
        literal either. A rule naming a teacher with nothing left to place builds
        nothing at all, as the lunch and the rest skip them. With no rule set
        this returns before reading anything, and the model is the one every
        school had before.

        A CO-TAUGHT LESSON IS FULL TEACHING FOR BOTH, as everywhere a teacher
        rule reads the week (_lesson_teachers), and a legacy row naming one
        person as both lead and co-teacher is one lesson for them, not two. A
        split post's lesson is its own lead's minutes and day, and never the
        other lead's: Bertil's cap counts his one lesson of the three.
        """
        capped = [
            rule for rule in work_rules if rule.max_teaching_minutes_per_day is not None
        ]
        if not capped and not day_limits:
            return

        by_teacher = _lessons_by_teacher(decisions)
        slots_per_day = self._grid.slots_per_day
        slot_minutes = self._grid.slot_minutes
        weekdays = self._grid.schedule_days
        lock_minutes, _lock_days = _teacher_locks(fixed_lessons)
        locked_busy = self._teacher_busy_from_locks(fixed_lessons)

        reach_of: dict[str, dict[int, list[tuple[int, int]]]] = {}

        def reach(decision: LessonDecision) -> dict[int, list[tuple[int, int]]]:
            key = decision.lesson.key()
            if key not in reach_of:
                assert decision.starts is not None
                reach_of[key] = _day_reach(decision.starts, decision.duration, slots_per_day)
            return reach_of[key]

        # One teacher at a time, in the payload's order of first mention, so a
        # payload builds the same variables in the same order on every run.
        teachers = list(dict.fromkeys(
            [rule.teacher_id for rule in capped] + [limit.teacher_id for limit in day_limits],
        ))
        for teacher_id in teachers:
            group = by_teacher.get(teacher_id)
            if not group:
                continue
            rules = [rule for rule in capped if rule.teacher_id == teacher_id]
            limits = [limit for limit in day_limits if limit.teacher_id == teacher_id]
            on = self._teacher_day_on(
                model, teacher_id, decisions, teacher_days, day_vars, literals, reach,
            )
            reaching = {
                day_index: [decision for decision in group if day_index in reach(decision)]
                for day_index in range(len(weekdays))
            }
            room = self._teaching_room(
                [reach(decision) for decision in group], locked_busy, teacher_id,
            )

            def works(day_index: int) -> cp_model.IntVar:
                return self._teacher_day_works(
                    model, teacher_id, day_index, reaching[day_index], on,
                    teacher_days, literals,
                )

            minutes: dict[int, cp_model.IntVar] = {}

            def taught(day_index: int) -> cp_model.IntVar:
                # The day's minutes, one total per day the teacher's lessons
                # reach and the week's minutes their sum (_day_totals), built
                # with the first row that reads one: rows on these, and never
                # on `Σ minutes·x`, are what presolve no longer throws on.
                if not minutes:
                    days = [index for index in range(len(weekdays)) if reaching[index]]
                    minutes.update(_day_totals(
                        model,
                        f"ldminutes_{teacher_id}",
                        {
                            index: sum(
                                decision.duration * slot_minutes * on(decision, index)
                                for decision in reaching[index]
                            )
                            for index in days
                        },
                        {
                            index: sum(decision.duration for decision in reaching[index])
                            * slot_minutes
                            for index in days
                        },
                        sum(decision.duration for decision in group) * slot_minutes,
                    ))
                return minutes[day_index]

            for rule in rules:
                cap = rule.max_teaching_minutes_per_day
                assert cap is not None
                for day_index, weekday in enumerate(weekdays):
                    lessons = reaching[day_index]
                    if not lessons:
                        continue
                    residual = max(0, cap - lock_minutes.get((teacher_id, weekday), 0))
                    bringable = sum(decision.duration for decision in lessons) * slot_minutes
                    if residual >= min(bringable, room.get(day_index, 0) * slot_minutes):
                        continue
                    literal = registry.register(
                        model,
                        name=f"ldcap_{teacher_id}_{day_index}",
                        category="TEACHER_OVERLAP",
                        code="TEACHER_DAILY_CAP_CANNOT_BE_KEPT",
                        params={"rule": str(rule.id), "minutes": cap, "day": weekday},
                        # The rule and never the teacher — see the lunch's
                        # literal in _add_teacher_lunch.
                        resource_ids=[rule.id],
                    )
                    # On the day's minutes and times its `works`, a locked
                    # day's too: one LP row sees the cap and the days limit
                    # together, and presolve gets no sum against a number to
                    # throw on — the docstring's two CP-SAT paragraphs.
                    model.Add(
                        taught(day_index) <= residual * works(day_index),
                    ).OnlyEnforceIf(literal)

            for limit in limits:
                # One row per week the locks make: the days outside that
                # week's locks, against what they leave of N.
                weeks = []
                for held in _week_sets(limit):
                    allowed = max(0, limit.max_teaching_days_per_week - len(held))
                    candidates = [
                        day_index
                        for day_index, weekday in enumerate(weekdays)
                        if weekday not in held and reaching[day_index]
                    ]
                    if allowed < len(candidates):
                        weeks.append((candidates, allowed))
                if not weeks:
                    continue
                literal = registry.register(
                    model,
                    name=f"lddays_{teacher_id}",
                    category="TEACHER_OVERLAP",
                    code="TEACHER_WORK_DAYS_CANNOT_BE_KEPT",
                    params={"limit": str(limit.id), "days": limit.max_teaching_days_per_week},
                    # The POST, never the teacher: the gateway reverses it
                    # through its own map and masks the sentence on read.
                    resource_ids=[limit.id],
                )
                # A count of `works`, under the literal: no weighted row
                # against a constant here either.
                for candidates, allowed in weeks:
                    model.Add(
                        sum(works(day_index) for day_index in candidates) <= allowed,
                    ).OnlyEnforceIf(literal)
                # The linking rows, bare and implied — see the docstring — on
                # every day, the locked ones included: they are what tells the
                # LP that a locked day holds its room and no more. A row whose
                # room holds every minute the day's lessons could bring says
                # nothing the lessons' own implications on `works` do not,
                # and is left out.
                for day_index in range(len(weekdays)):
                    lessons = reaching[day_index]
                    capacity = room.get(day_index, 0) * slot_minutes
                    bringable = sum(decision.duration for decision in lessons) * slot_minutes
                    if not lessons or capacity >= bringable:
                        continue
                    model.Add(taught(day_index) <= capacity * works(day_index))

    def _teacher_day_on(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        decisions: list[LessonDecision],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        day_vars: dict[str, cp_model.IntVar],
        literals: _TeacherDayLiterals,
        reach: Callable[[LessonDecision], dict[int, list[tuple[int, int]]]],
    ) -> Callable[[LessonDecision, int], cp_model.IntVar]:
        """`on(lesson, day)`: the literal saying this teacher's lesson is on that day.

        The rest rule's own where it built the teacher's day: _teacher_day_bounds
        took the teacher's lessons in the order _add_teacher_work_constraints
        collected them — every decision once per time the teacher is named on
        it, so a legacy row with one person as lead and co-teacher is there
        twice — and its `on_day` is aligned with that list. The first position
        of a lesson is its literal; a second is the same fact.

        Anywhere else, the lesson's own one-hot in `literals`, built on first
        use: a literal per day the lesson can fall on, exactly one true, their
        weighted sum the lesson's `day_` variable — the channelling the
        distribution rule uses, on the same day variable the spread reads.
        """
        # The same walk _add_teacher_work_constraints made, lesson by lesson
        # (_lesson_teachers), or the positions belong to another list.
        position: dict[str, int] = {}
        for index, decision in enumerate(
            decision
            for decision in decisions
            for named in _lesson_teachers(decision.lesson)
            if named == teacher_id
        ):
            position.setdefault(decision.lesson.key(), index)

        def on(decision: LessonDecision, day_index: int) -> cp_model.IntVar:
            built = teacher_days.get((teacher_id, day_index))
            if built is not None:
                return built.on_day[position[decision.lesson.key()]]
            key = decision.lesson.key()
            one_hot = literals.on_day.get(key)
            if one_hot is None:
                day = self._day_var(model, decision, day_vars)
                one_hot = {
                    index: model.NewBoolVar(f"ldon_{key}_{index}")
                    for index in sorted(reach(decision))
                }
                model.AddExactlyOne(one_hot.values())
                model.Add(day == sum(index * literal for index, literal in one_hot.items()))
                literals.on_day[key] = one_hot
            return one_hot[day_index]

        return on

    def _teacher_day_works(
        self,
        model: cp_model.CpModel,
        teacher_id: UUID,
        day_index: int,
        lessons: list[LessonDecision],
        on: Callable[[LessonDecision, int], cp_model.IntVar],
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        literals: _TeacherDayLiterals,
    ) -> cp_model.IntVar:
        """True exactly when the teacher teaches on the day: implied by every
        lesson there, and at most their sum. The rest rule's own where it built
        the day, which is the same fact by AddMaxEquality."""
        built = teacher_days.get((teacher_id, day_index))
        if built is not None:
            return built.works
        key = (teacher_id, day_index)
        works = literals.works.get(key)
        if works is None:
            present = [on(decision, day_index) for decision in lessons]
            works = model.NewBoolVar(f"ldworks_{teacher_id}_{day_index}")
            for literal in present:
                model.AddImplication(literal, works)
            model.Add(works <= sum(present))
            literals.works[key] = works
        return works

    def _teaching_room(
        self,
        reaches: list[dict[int, list[tuple[int, int]]]],
        locked_busy: dict[tuple[UUID, int], list[tuple[int, int]]],
        teacher_id: UUID,
    ) -> dict[int, int]:
        """Day index -> the slots a teacher's lessons can take that day, at most.

        Every slot one of the lessons COULD occupy — the union, over the
        lessons and the starts their domains allow, of start to start plus
        length — less the slots the teacher's locked lessons take, at the
        outward windows _add_fixed_lesson_constraints blocks. Frames, rasts
        and the pupils' margins are in the domains already, so they are in
        this; reservations are not, because they hang on literals, and an
        upper bound that subtracted them would no longer be implied by what
        is bare.

        WHY THAT IS A BOUND NO TIMETABLE BEATS: every lesson the teacher has on
        the day lies inside the union, no two of them overlap (their NoOverlap)
        and none overlaps a locked one (its avoidance) — so their lengths add up
        to at most what is left. Read by the linking rows, and through
        _teacher_rooms by the days pre-flight and the hours verdict, which is
        the same arithmetic on the same domains.
        """
        by_day: dict[int, list[tuple[int, int]]] = defaultdict(list)
        for reach in reaches:
            for day_index, ranges in reach.items():
                by_day[day_index].extend(ranges)
        room: dict[int, int] = {}
        for day_index, ranges in by_day.items():
            covered = _merge_ranges(ranges)
            for window in locked_busy.get((teacher_id, day_index), []):
                covered = _subtract_range(covered, window)
            room[day_index] = sum(end - start for start, end in covered)
        return room

    def _free_day_wishes(
        self, request: OptimizeScheduleRequest, weights: ResolvedWeights,
    ) -> list[tuple[UUID, int]]:
        """(teacher, ISO weekday) for every free-day wish the objective prices.

        ONE READING FOR BOTH TERMS: the wish's own, which pays for a day the
        teacher works, and the disruption term, which stops paying for the
        teacher's previous slots on that day. Read apart they could disagree
        about which wishes are in force, and a day the wish gave up on would
        lose its slots' reward for nothing.

        A WISH NOTHING CAN KEEP OR BREAK IS NOT IN FORCE: a weekday the school
        does not teach — and never through TimeGrid.day_index, which raises
        for a Saturday on a Monday-to-Friday grid — a day the teacher's own
        locked lessons already hold, and a teacher with nothing left to place.
        With the weight at zero or below, no wish is in force at all.
        """
        if weights.free_day_wish <= 0:
            return []
        teaching = {
            teacher_id
            for requirement in request.requirements
            for teacher_id in _teachers_of(requirement)
        }
        _minutes, lock_days = _teacher_locks(request.fixed_lessons)
        wishes: list[tuple[UUID, int]] = []
        for rule in request.teacher_work_rules:
            weekday = rule.preferred_free_day
            if weekday is None or weekday not in self._grid.schedule_days:
                continue
            if rule.teacher_id not in teaching:
                continue
            if weekday in lock_days.get(rule.teacher_id, set()):
                continue
            wishes.append((rule.teacher_id, weekday))
        return wishes

    def _add_free_day_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        wishes: list[tuple[UUID, int]],
        weights: ResolvedWeights,
        teacher_days: dict[tuple[UUID, int], _TeacherDay],
        literals: _TeacherDayLiterals,
    ) -> list[cp_model.LinearExpr]:
        """A teacher's wished free weekday, paid once if they teach on it.

        `weight × works(teacher, day)` and nothing more: the wish is "no lessons
        that day", so the first lesson there breaks it and the fifth breaks
        nothing further. In the FULL model only, like every objective term —
        the satisfaction phase builds nothing for a wish, so a school's wishes
        cannot make its timetable harder to find.

        `works` IS REUSED WHERE IT EXISTS: the rest rule's day, or the one the
        cap or the days limit built. Otherwise one literal for the wish alone,
        held up by each lesson that can land on the day — through the lesson's
        day literal where the cap built one, and otherwise as "this lesson
        starts outside the day unless the teacher works it", which is a domain
        on the start and costs no variable at all. One variable per wish, then,
        and never a literal per lesson for a teacher whose only rule is a wish.
        Minimising pulls the literal down wherever no lesson holds it up.

        A day no lesson of the teacher can reach is a wish kept by the frames
        themselves: a constant, and no term.
        """
        if not wishes:
            return []
        by_teacher = _lessons_by_teacher(decisions)
        slots_per_day = self._grid.slots_per_day
        horizon = self._grid.horizon
        penalties: list[cp_model.LinearExpr] = []
        for teacher_id, weekday in wishes:
            day_index = self._grid.day_index(weekday)
            reaching = []
            for decision in by_teacher.get(teacher_id, []):
                assert decision.starts is not None
                if day_index in _day_reach(decision.starts, decision.duration, slots_per_day):
                    reaching.append(decision)
            if not reaching:
                continue
            built = teacher_days.get((teacher_id, day_index))
            works = built.works if built is not None else literals.works.get(
                (teacher_id, day_index),
            )
            if works is None:
                works = model.NewBoolVar(f"ldwish_{teacher_id}_{day_index}")
                outside = cp_model.Domain.FromIntervals([
                    interval
                    for interval in (
                        [0, day_index * slots_per_day - 1],
                        [(day_index + 1) * slots_per_day, horizon],
                    )
                    if interval[0] <= interval[1]
                ])
                for decision in reaching:
                    one_hot = literals.on_day.get(decision.lesson.key())
                    if one_hot is not None and day_index in one_hot:
                        model.AddImplication(one_hot[day_index], works)
                    else:
                        model.AddLinearExpressionInDomain(
                            decision.start, outside,
                        ).OnlyEnforceIf(works.Not())
                literals.works[(teacher_id, day_index)] = works
            penalties.append(works * weights.free_day_wish)
        return penalties

    @staticmethod
    def _room_allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
        capacity_ok = room.capacity is None or room.capacity >= requirement.student_group_size
        type_ok = (
            requirement.required_room_type is None
            or room.type == requirement.required_room_type
        )
        return capacity_ok and type_ok and _grade_allowed(room, requirement)

    @staticmethod
    def _lock_aware(
        locked: dict[UUID, frozenset[UUID]],
    ) -> tuple[
        Callable[[AnonymousRoom, AnonymousRequirement], bool],
        Callable[[AnonymousRequirement], tuple],
    ]:
        """The eligibility predicate and its profile key, both aware of locks.

        A LOCK IS FOLDED INTO ELIGIBILITY AND NOWHERE ELSE, and that placement
        is forced rather than chosen. add_room_allocation opens EVERY class when
        a lesson has none, and _add_capacity_constraints skips when nothing
        fits, so a lock enforced anywhere else is silently dropped rather than
        refused — on a run CP-SAT reports OPTIMAL. _room_allowed is already the
        single predicate behind all three consumers (the pre-solve refusal, the
        room_index constraints and the class partition), so folding it in here
        makes the lock inherit the existing refusal for free.
        Never as a large weight, either: the objective drops its term exactly
        when the rule is impossible, so a heavy "lock" would vanish in silence.

        THE KEY COMES BACK WITH THE PREDICATE, as one pair from one function.
        The partition stands one representative requirement in for its whole
        profile, so a field the predicate reads and the key omits places a
        lesson in a room it was never allowed — which is precisely the bug the
        stage limits caused, and locks are a second chance to cause it. Handing
        the two out together is what stops them being edited apart.
        """

        def allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
            if not SchedulerSolver._room_allowed(room, requirement):
                return False
            rooms_allowed = locked.get(requirement.id)
            return rooms_allowed is None or room.id in rooms_allowed

        def key(requirement: AnonymousRequirement) -> tuple:
            return (
                *SchedulerSolver._room_profile_key(requirement),
                locked.get(requirement.id),
            )

        return allowed, key

    @staticmethod
    def _room_profile_key(requirement: AnonymousRequirement) -> tuple:
        """Exactly the fields _room_allowed reads, and nothing else.

        DIRECTLY ABOVE ITS PREDICATE ON PURPOSE. build_room_classes stands one
        representative requirement in for its whole profile, so a field the
        predicate consults and this key omits collapses two different
        eligibilities into one class and places a lesson in a room it was never
        allowed. That is exactly how year limits leaked: the key named type and
        size, `_grade_allowed` had been added to the predicate, and nothing
        connected the two. Adding a term to _room_allowed means adding it here,
        and the pair is adjacent so the omission is visible rather than two
        files apart.
        """
        return (
            requirement.required_room_type,
            requirement.student_group_size,
            requirement.min_grade_level,
            requirement.max_grade_level,
        )

    def _add_lunch_stability_objective(
        self,
        model: cp_model.CpModel,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Pay for every slot a group's meal drifts off its own first day.

        NOTHING in this model mentioned lunch_start before: the five objective
        families all take `decisions`, so the meal was placed wherever
        propagation happened to leave it. Two runs of one payload could return
        different lunch times, which was invisible while the value was thrown
        away and is the first thing a school notices once it is drawn.

        Measured against the group's OWN first day, not against a fixed hour.
        A school-wide target would fight the seat cumulative, whose whole job is
        to put different groups at different times; this asks only that a class
        eats at the same time on Tuesday as it did on Monday, which staggering
        has no quarrel with.

        Day-local, so the comparison is between clock times rather than between
        positions on the week's line — every day's offset would otherwise swamp
        the difference this measures.

        The lowest weight in the model, and deliberately: a steady meal is worth
        having and worth nothing at the cost of a lesson.
        """
        if weights.lunch_drift <= 0:
            return []

        slots_per_day = self._grid.slots_per_day
        by_group: dict[UUID, list[tuple[int, cp_model.IntVar]]] = {}
        for (group_id, day_index), variable in lunch_starts.items():
            by_group.setdefault(group_id, []).append((day_index, variable))

        terms: list[cp_model.LinearExpr] = []
        for group_id, days in by_group.items():
            days.sort()
            if len(days) < 2:
                continue
            first_day, first_var = days[0]
            for day_index, variable in days[1:]:
                drift = model.NewIntVar(
                    -slots_per_day, slots_per_day, f"lunchdrift_{group_id}_{day_index}",
                )
                model.Add(
                    drift
                    == (variable - day_index * slots_per_day)
                    - (first_var - first_day * slots_per_day),
                )
                magnitude = model.NewIntVar(
                    0, slots_per_day, f"lunchdriftabs_{group_id}_{day_index}",
                )
                model.AddAbsEquality(magnitude, drift)
                terms.append(weights.lunch_drift * magnitude)

        return terms

    def _lunches_of(
        self,
        solver: cp_model.CpSolver,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        rules: ScheduleRules | None,
    ) -> list[ScheduledLunch]:
        """Sittings, or none if the school reserves no lunch.

        The map is empty in that case anyway; the guard is on `lunch_minutes`,
        which is what _extract_lunches needs and which is None exactly when the
        window is unset.
        """
        if rules is None or rules.lunch_minutes is None:
            return []
        return self._extract_lunches(solver, lunch_starts, rules.lunch_minutes)

    def _extract_lunches(
        self,
        solver: cp_model.CpSolver,
        lunch_starts: dict[tuple[UUID, int], cp_model.IntVar],
        lunch_minutes: int,
    ) -> list[ScheduledLunch]:
        """The sitting each group got, decoded the same way a lesson is.

        `lunch_starts` must come from the SAME build whose solver is passed in.
        solve() runs four models — the full one, an objective-free twin, a
        cleared Clone of the full one, and the assumptions rebuild — and
        solver.Value() resolves a variable by INDEX, not by identity.

        Measured, because the honest version of this warning is narrower than it
        first looks: today the two builds give the lunch variables the SAME
        indices, because _build_model appends every objective auxiliary after
        the rules are added. Passing the wrong map is therefore currently
        harmless — by accident. It stops being harmless the moment an objective
        term allocates a variable earlier, or the build order is rearranged, and
        the failure would be silent: a real number from a model nobody solved.
        Taking the map from the winning build costs nothing and removes the
        accident from the load-bearing path; test_the_two_builds_agree_on_lunch_
        variable_indices pins the assumption so its expiry is noisy.
        """
        duration = self._grid.minutes_to_slots(lunch_minutes)
        lunches: list[ScheduledLunch] = []
        for (group_id, _day_index), variable in lunch_starts.items():
            day_of_week, start_slot = self._grid.decode_absolute(solver.Value(variable))
            start_time, end_time = self._grid.format_hhmmss(start_slot, duration)
            lunches.append(
                ScheduledLunch(
                    student_group_id=group_id,
                    day_of_week=day_of_week,  # type: ignore[arg-type]
                    start_time=start_time,
                    end_time=end_time,
                ),
            )
        # Stable order: the dict is insertion-ordered by (group, day) already,
        # but a response a school reads should not depend on that being true.
        lunches.sort(key=lambda lunch: (str(lunch.student_group_id), lunch.day_of_week))
        return lunches

    def _extract_lessons(
        self,
        solver: cp_model.CpSolver,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        room_plan: RoomPlan,
    ) -> list[ScheduledLesson]:
        # room_index is not authoritative under the class encoding — the
        # post-pass is. Reading room_index here would double-book rooms.
        room_by_key = room_plan.assign_rooms(solver)
        lessons: list[ScheduledLesson] = []
        for decision in decisions:
            absolute_start = solver.Value(decision.start)
            day_of_week, start_slot = self._grid.decode_absolute(absolute_start)
            start_time, end_time = self._grid.format_hhmmss(start_slot, decision.duration)
            room_idx = room_by_key[decision.lesson.key()]
            requirement = decision.lesson.requirement
            lessons.append(
                ScheduledLesson(
                    requirement_id=requirement.id,
                    room_id=rooms[room_idx].id,
                    day_of_week=day_of_week,  # type: ignore[arg-type]
                    start_time=start_time,
                    end_time=end_time,
                    # Delade lektioner: which lead this placement is, and only
                    # for a split post — every other lesson leaves it None,
                    # which the response omits, so a school without a split
                    # gets the bytes it always got.
                    teacher_id=(
                        requirement.lesson_teacher(decision.lesson.lesson_index)
                        if requirement.lesson_teacher_ids is not None
                        else None
                    ),
                ),
            )
        return lessons

    @staticmethod
    def _map_status(status_code: int) -> SolverStatus:
        """Translate a CP-SAT status into the public API status.

        Only cp_model.INFEASIBLE maps to "INFEASIBLE" — that code means the
        search space was exhausted and no timetable exists. cp_model.UNKNOWN
        means the solver hit max_time_in_seconds with nothing found and nothing
        proven; reporting it as INFEASIBLE would tell a school its requirements
        are impossible when the real answer is "needs more solver time".

        cp_model.MODEL_INVALID is rejected in solve() before reaching here; it
        falls through to "TIMEOUT" only as a defensive default.
        """
        if status_code == cp_model.OPTIMAL:
            return "OPTIMAL"
        if status_code == cp_model.FEASIBLE:
            return "FEASIBLE"
        if status_code == cp_model.INFEASIBLE:
            return "INFEASIBLE"
        return "TIMEOUT"


def _hhmmss_to_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _clock_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _fixed_lesson_window(fixed: FixedLesson, grid: TimeGrid) -> tuple[int, int] | None:
    """Absolute slot window blocked by a fixed lesson, rounded outward.

    Locked lessons are hand-placed and need not align to the slot grid;
    the blocked window is expanded to whole slots so blocking stays
    conservative. Returns None when the lesson lies outside the grid.
    """
    if fixed.day_of_week not in grid.schedule_days:
        return None

    start_minutes = _hhmmss_to_minutes(fixed.start_time)
    end_minutes = _hhmmss_to_minutes(fixed.end_time)
    start_minutes = max(start_minutes, grid.day_start_minutes)
    end_minutes = min(end_minutes, grid.day_end_minutes)
    if end_minutes <= start_minutes:
        return None

    slot = grid.slot_minutes
    start_slot = (start_minutes - grid.day_start_minutes) // slot
    end_slot = -(-(end_minutes - grid.day_start_minutes) // slot)  # ceil

    day_offset = grid.day_index(fixed.day_of_week) * grid.slots_per_day
    return day_offset + start_slot, day_offset + end_slot


def _fixed_lesson_outside(
    fixed: FixedLesson, grid: TimeGrid,
) -> tuple[int, tuple[int, int]] | None:
    """A lock on a scheduled day lying wholly outside the day's hours.

    The lock _fixed_lesson_window clips to nothing: 07:20–08:00 on a grid that
    opens at 08:00, or one after it closes. It blocks no slot of the grid, but
    the walk to it is the walk to any lesson (TravelRows.outside_rows). Returns
    the day's first absolute slot and the lock's [start, end) in slots from
    it, rounded outward as the window is — below 0 for a morning lock, at or
    past the day's length for an evening one. None for every other lock.
    """
    if fixed.day_of_week not in grid.schedule_days:
        return None
    start_minutes = _hhmmss_to_minutes(fixed.start_time)
    end_minutes = _hhmmss_to_minutes(fixed.end_time)
    if end_minutes <= start_minutes:
        return None
    if start_minutes < grid.day_end_minutes and end_minutes > grid.day_start_minutes:
        return None
    slot = grid.slot_minutes
    start = (start_minutes - grid.day_start_minutes) // slot
    end = -(-(end_minutes - grid.day_start_minutes) // slot)
    return grid.day_index(fixed.day_of_week) * grid.slots_per_day, (start, end)


def _start_step(request: OptimizeScheduleRequest, grid: TimeGrid) -> int:
    """How many slots apart this week's lesson and lunch starts may be.

    THE GRID STAYS; ONLY THE STARTS STEP. Every length, rounding, refusal,
    weight and output is still counted on `grid`, and a school whose time is
    off the five-minute grid is still told so in those words. What the step
    changes is which values a lesson's start and a lunch's start may take:
    the multiples of it, as holes in their domains. The nightly 400-student
    gate writes every time on the half hour, so its lessons get 95 starts each
    instead of 545, over the same variables and constraints.

    THE STEP IS THE GCD OF EVERY CONSTANT A START IS COMPARED WITH, after the
    model's own rounding: the day's length; each lesson's length and the
    meal's; each teacher's own lunch window, that break's length rounded up,
    the rest they are owed rounded up and the night the grid leaves between two
    days; each requirement's two pupil buffers, rounded up; the lunch window;
    each frame's open and close, rounded both ways, and its changeover, rounded
    up; each rast rounded outward and each sitting inward; every availability
    row of every kind, dated or not, folded onto the grid; each locked lesson's
    outward window within its day; each hand-placed meal; each previous lesson
    the disruption term can read.

    A FRAME IS READ OUTWARD TOO, AND NEED NOT BE. frames.day_windows is the
    only reader of a frame's times, and it rounds inward: the open up, the
    close down. The open rounded down and the close rounded up are compared
    with nothing, and the argument below does without them. They stay as
    caution: a frame on the grid reads the same both ways and costs nothing,
    one off it costs the coarser step it could have had (08:07 gives five
    minutes where ten would do), and a later reader rounding a frame outward
    is already covered. Dropping them is a choice, and a row in
    tests/test_start_step.py says so.

    NO WEEK IS LOST. Let every one of those constants be a multiple of g, and
    take any timetable the model accepts without the step. Round every start
    DOWN to a multiple of g. Every rule still holds:

      - a start bounded by a constant, a start barred from a hole whose edges
        are constants, an end bounded by a constant (the same bound less a
        length): rounding down never crosses a multiple;
      - no-overlap: a ending before b starts is a + len_a <= b, and then
        floor(a) + len_a = floor(a + len_a) <= floor(b). So every NoOverlap
        holds, and every cumulative — rooms, seats — too: rounding can part
        two intervals and never join them, and intervals that pairwise meet
        share an instant, so no instant carries more than it did;
      - a teacher's rest, `last(d) + rest <= first(d+1) + pad`, is that same
        sentence with a constant added to each side: `last` is a start plus a
        length and `first` is a start, so from `a + c <= b + c'` with c and c'
        multiples of g it follows that floor(a) + c <= floor(b) + c'. Both
        constants are in the gcd for exactly this step, `pad` included;
      - the day a start falls on, `start // slots_per_day`, does not move;
      - a pinned meal is a multiple already and stays where it was;
      - the rast rule's "taught before" flags are bounds as above, and its
        "still at school" test, `start >= base + last`, answers the same
        before and after.

    So a timetable exists on the step exactly when one exists at all.
    FEASIBLE, INFEASIBLE, a conflict core and the lunch stage's refusal mean on
    the stepped model what they meant without it.

    NO OPTIMUM IS LOST EITHER, where a step is allowed. Round every start to
    g * floor((start + t) / g) instead, for a shift t in 0..g-1. Each shift
    keeps every rule above that is not strict, and averaged over the shifts
    every start stays exactly where it was. So every term linear in the starts
    keeps its average, and so does a lunch's drift, the size of a difference
    whose sign no common rounding flips. A teacher's idle time — span less
    taught and protected minutes, floored at zero — keeps it too, because its
    rounded values are two neighbouring multiples of g and never straddle
    zero. A PREFERRED_FREE or dated overlap can only shrink on average, and
    the disruption reward reads a multiple and keeps its value. Some shift
    then costs no more than the timetable it came from. Two sentences break
    that average, and the answer for them is a step of 1 rather than an
    OPTIMAL that is not one:

      - A PREFERRED_BUSY row pays when a lesson does NOT overlap it. A lesson
        straddling two adjacent busy half hours overlaps both, and only off
        the multiples can it straddle: tests/test_start_step.py builds that
        week, 0 without the step and 5 with it.
      - The rast rule's "gone home" side is strict, and a lesson its own rasts
        do not keep out of an asking break can be rounded up into lateness.
        See _rast_rule_reads_held_lessons.

    ANY NEW RULE THAT COMPARES A START WITH A CONSTANT MUST FEED THIS FUNCTION,
    and any new objective term must keep the average above or make the step 1.
    Nothing checks either at build time. A constant left out is a start the
    model can no longer reach, and the week that needed it is refused, or
    reported worse than it is, without a word — the drift solver-grid.ts risks
    for the gateway. tests/test_start_step.py holds one case per source and
    compares verdicts and optima with the step and without it.

    ONE ODD TIME ANYWHERE brings the whole school to a step of 1, as a lesson
    locked at 08:05 does, and it is then searched exactly as it was before the
    step existed: slower, never wrong. A step per connected part of the school
    is not worth its code, because the room pool joins nearly everything.

    UNREADABLE IS 1. A time or a length the grid cannot read is refused by name
    in _validate_request before any model is built, and a guess would buy
    nothing. A previous lesson the disruption term skips is skipped here too.

    Holes in the domains, not start = g * k over a narrower variable: that
    might propagate better, and has not been tried.
    """
    if any(constraint.kind == "PREFERRED_BUSY" for constraint in request.constraints):
        return 1
    if not _rast_rule_reads_held_lessons(request, grid):
        return 1

    slots_per_day = grid.slots_per_day

    def folded(value: str, *, upward: bool) -> int:
        # The rounding frames.py, rasts.py and servings.py apply to their own
        # rows, clipped to the day as each of them clips.
        offset = _clock_minutes(value) - grid.day_start_minutes
        slots = -(-offset // grid.slot_minutes) if upward else offset // grid.slot_minutes
        return min(max(slots, 0), slots_per_day)

    values = [slots_per_day]
    try:
        values.extend(
            grid.minutes_to_slots(minutes)
            for requirement in request.requirements
            for minutes in set(requirement.lesson_minutes())
        )
        rules = request.rules
        if rules is not None and _lunch_window_is_set(rules):
            # The three readings _lunch_window_slots makes, through the same
            # grid calls. Its refusals are _validate_request's to make.
            values.extend((
                grid.parse_hhmmss(rules.lunch_start_time),
                grid.parse_hhmmss(rules.lunch_end_time),
                grid.minutes_to_slots(rules.lunch_minutes),
            ))
        for constraint in request.constraints:
            for value in (constraint.start_time, constraint.end_time):
                slot = grid.clamp_to_grid(value)
                if slot is not None:
                    values.append(slot)
        values.extend(
            grid.parse_hhmmss(placement.start_time)
            for placement in request.lunch_placements
        )
    except ValueError:
        return 1

    for requirement in request.requirements:
        # The pupils' changing time, rounded up as _create_lesson_decisions
        # rounds it. Both bound a start — the lead from below, since the domain's
        # first slot of the day rises by it, and the trail from above through the
        # day's clipped close — and a buffer left out of this gcd is a week
        # refused for want of a start the school could have had. Zero feeds
        # nothing: gcd(0, n) is n, which is why the overwhelming majority of
        # requirements, carrying no buffer at all, cost no step here.
        values.extend((
            -(-requirement.minutes_before // grid.slot_minutes),
            -(-requirement.minutes_after // grid.slot_minutes),
        ))
    # The teachers' own lunch and rest. The window's two ends and the break's
    # length bound a lunch start exactly as the school's own three do, through
    # the same helper the builder reads them with — and the REST feeds two
    # constants, not one. It is compared with a start as `last(d) + rest <=
    # first(d+1) + pad`, and `pad` is a constant of the grid rather than of any
    # row: without it in the gcd a week whose starts step by 25 minutes would
    # have the inequality shifted by a number no multiple of 25 can reach, and
    # the rounding-down argument above — which needs both added constants to be
    # multiples of the step — would no longer hold. See _night_pad_slots.
    for rule in request.teacher_work_rules:
        window = _teacher_lunch_slots(rule, grid)
        if window is not None:
            values.extend(window)
        if rule.min_daily_rest_minutes is not None:
            values.append(-(-rule.min_daily_rest_minutes // grid.slot_minutes))
            values.extend(
                _night_pad_slots(grid, day_index)
                for day_index in range(len(grid.schedule_days) - 1)
            )
    for frame in request.frame_times:
        for value in (frame.start_time, frame.end_time):
            values.extend((folded(value, upward=False), folded(value, upward=True)))
        values.append(-(-frame.changeover_minutes // grid.slot_minutes))
    for rast in request.rasts:
        values.extend((
            folded(rast.start_time, upward=False), folded(rast.end_time, upward=True),
        ))
    for serving in request.lunch_servings:
        values.extend((
            folded(serving.start_time, upward=True), folded(serving.end_time, upward=False),
        ))
    for fixed in request.fixed_lessons:
        window = _fixed_lesson_window(fixed, grid)
        if window is not None:
            day_offset = window[0] // slots_per_day * slots_per_day
            values.extend((window[0] - day_offset, window[1] - day_offset))
    for previous in request.previous_lessons:
        try:
            values.append(grid.parse_hhmmss(previous.start_time))
        except ValueError:
            continue
    return max(math.gcd(*values), 1)


def _rast_rule_reads_held_lessons(request: OptimizeScheduleRequest, grid: TimeGrid) -> bool:
    """Whether every lesson an asking rast reads is kept out of that break.

    THE ONE STRICT COMPARISON IN THE MODEL. A class is still at school after
    an asking break when one of its lessons starts at or after the break's end.
    A lesson starting inside the break's last step is not, and rounded UP to
    the next multiple it is — so _start_step's optimum argument, which rounds
    some starts up, needs no lesson ever to start there. A lesson its own rasts
    keep out of the break never can: its domain has a hole from the break's
    first slot less its length to the break's last slot, and its length is at
    least the step.

    The lesson that is not kept out is a teaching group whose years the gateway
    could not derive: its class's rule reads it through the shared pupils, and
    no rast reaches the group itself. tests/test_start_step.py builds that
    week, and its verdict is the same either way while its optimum is not.

    The reach _add_rast_ordering_constraints uses — the class's own years for
    the break, each requirement's own years for its holes, the groups sharing
    pupils for its lessons — and cautious where that method skips: a day a
    frame closes, or a stretch no lesson fits, is still asked about.
    """
    if not request.groups or not any(rast.requires_lesson_before for rast in request.rasts):
        return True
    sharing = _groups_sharing_students(request.group_conflicts)
    spans_of: dict[UUID, set[tuple[int, int] | None]] = defaultdict(set)
    for requirement in request.requirements:
        spans_of[requirement.student_group_id].add(span_of(requirement))
    holes: dict[tuple[tuple[int, int] | None, int], list[tuple[int, int]]] = {}
    for group in request.groups:
        if group.min_grade_level is None or group.max_grade_level is None:
            continue
        span = (group.min_grade_level, group.max_grade_level)
        lesson_spans = {
            lesson_span
            for member in (group.id, *sharing.get(group.id, ()))
            for lesson_span in spans_of.get(member, ())
        }
        for day_of_week in grid.schedule_days:
            for _first, last, asks in blocks_with_demand(request.rasts, span, day_of_week, grid):
                if not asks:
                    continue
                for lesson_span in lesson_spans:
                    key = (lesson_span, day_of_week)
                    if key not in holes:
                        holes[key] = blocks_for(request.rasts, lesson_span, day_of_week, grid)
                    if not any(start < last <= end for start, end in holes[key]):
                        return False
    return True


def _start_lattice(step: int, horizon: int) -> cp_model.Domain | None:
    """Every multiple of the step across the week, or None at a step of 1.

    None rather than [0, horizon], so a week whose step is 1 builds exactly
    the model it built before steps existed.
    """
    if step <= 1:
        return None
    return cp_model.Domain.FromValues(list(range(0, horizon + 1, step)))


def _on_lattice(domain: cp_model.Domain, lattice: cp_model.Domain | None) -> cp_model.Domain:
    """The domain's values on the step; the domain itself at a step of 1."""
    return domain if lattice is None else domain.intersection_with(lattice)


def _servings_for(
    servings: list[LunchServing],
    span: tuple[int, int] | None,
    day_of_week: int,
) -> list[LunchServing]:
    """The sittings open to one stage on one day, in declaration order.

    The same shadowing rule servings.allowed_starts applies — a day-specific row
    replaces the every-day rows — kept here rather than duplicated because the
    pre-flight has to agree with the domain it is predicting.
    """
    if span is None:
        return []
    span_min, span_max = span
    matching = [
        serving
        for serving in servings
        if not (span_max < serving.min_grade_level or span_min > serving.max_grade_level)
    ]
    today = [serving for serving in matching if serving.day_of_week == day_of_week]
    return today or [serving for serving in matching if serving.day_of_week is None]


def _domain_intervals(domain: cp_model.Domain) -> list[tuple[int, int]]:
    """A Domain's [lo, hi] pairs. FlattenedIntervals() returns them flat."""
    flat = domain.FlattenedIntervals()
    return [(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)]


def _lunch_window_is_set(rules: ScheduleRules) -> bool:
    """Whether the school actually asked for a lunch break.

    All three fields or none: a window with no length, or a length with no
    window, describes nothing the solver can build. Seats alone do not make a
    lunch rule either, which is why the seat check reads this too.
    """
    return (
        rules.lunch_start_time is not None
        and rules.lunch_end_time is not None
        and rules.lunch_minutes is not None
    )


def _teacher_lunch_slots(
    rule: AnonymousTeacherWorkRule, grid: TimeGrid,
) -> tuple[int, int, int] | None:
    """One teacher's lunch window and the break's length, in a day's own slots.

    ONE ROUNDING RULE READ FROM THREE PLACES — the refusal in
    _validate_request, the builder, and _start_step's gcd — for the reason
    _lunch_window_slots gives about the school's own lunch: two copies of
    "which slot is 10:30" would eventually disagree about a teacher's break,
    and the copy that rounded outward would empty a variable's domain and reach
    the school as CP-SAT's own `var #0 has no domain()`, which is a 500 with
    nothing in it to act on.

    INWARD, LIKE A SITTING AND UNLIKE A RAST. The window is a PERMISSION the
    break has to sit inside, so its open rounds UP and its close rounds DOWN: a
    window of 10:32-13:28 on a five-minute grid offers 10:35-13:25, where
    rounding outward would let a lunch begin two minutes before the school said
    it may. The LENGTH rounds up, the one direction that cannot shorten a break
    somebody is owed — a 20-minute lunch on a 15-minute grid takes 30, which
    protects the teacher rather than the search.

    CLIPPED TO THE SCHOOL DAY, and never refused merely for reaching past it. A
    school whose day ends at 13:00 and whose teachers may eat until 13:30 has
    said two things, and the narrower one wins — exactly as a frame and a
    sitting compose. A window entirely outside the day clips to nothing, and
    nothing is too narrow to hold a lunch, which is refused by name with the
    width it really offers quoted in the sentence.

    None when the rule asks for no lunch at all. The trio is validated by the
    schema, so one field present means all three are.
    """
    if not rule.has_lunch:
        return None
    assert rule.lunch_start_time is not None
    assert rule.lunch_end_time is not None
    assert rule.lunch_minutes is not None

    def folded(value: str, *, upward: bool) -> int:
        offset = _clock_minutes(value) - grid.day_start_minutes
        slots = -(-offset // grid.slot_minutes) if upward else offset // grid.slot_minutes
        return min(max(slots, 0), grid.slots_per_day)

    return (
        folded(rule.lunch_start_time, upward=True),
        folded(rule.lunch_end_time, upward=False),
        -(-rule.lunch_minutes // grid.slot_minutes),
    )


def _covers(ranges: list[tuple[int, int]], start: int, end: int) -> bool:
    """Whether [start, end) is entirely inside the union of `ranges`.

    Used to read a reservation that covers a whole lunch window as the school
    saying the teacher is not there that day — the same reading
    _lunch_starts_blocked_by_constraints makes of a class's reserved Tuesday,
    and for the same reason: answering a correct statement with a refusal
    nobody can act on is worse than granting no break at all. Merged first, so
    two rows that between them cover the window are read as covering it.
    """
    cursor = start
    for low, high in _merge_ranges(list(ranges)):
        if low > cursor:
            return False
        cursor = max(cursor, high)
        if cursor >= end:
            return True
    return cursor >= end


def _forbidden_lunch_starts(
    busy: list[tuple[int, int]],
    earliest: int,
    latest: int,
    lunch_slots: int,
) -> list[tuple[int, int]]:
    """Lunch starts in [earliest, latest] that a busy window rules out.

    The arithmetic _lunch_starts_blocked_by_fixed_lessons states for a class: a
    break of `lunch_slots` starting at s clashes with a busy window [a, b)
    exactly for s in [a - lunch_slots + 1, b - 1]. Everything here is a
    constant, so the answer is a domain to subtract rather than a propagator —
    no boolean, no interval, and quiet about two busy windows that overlap each
    other, which is the school's own data and not a reason to refuse a week.

    Absolute slots throughout, and windows that rule out no admissible start at
    all are dropped rather than carried down to subtract nothing.
    """
    forbidden: list[tuple[int, int]] = []
    for start, end in busy:
        first_bad = start - lunch_slots + 1
        last_bad = end - 1
        if last_bad < earliest or first_bad > latest:
            continue
        forbidden.append((max(first_bad, earliest), min(last_bad, latest)))
    return forbidden


def _night_pad_slots(grid: TimeGrid, day_index: int) -> int:
    """Slots to add to a start on day_index + 1 to compare it with day_index's end.

    THE NIGHT IS NOT THE GRID. A start is an absolute slot and the grid
    addresses day d as [d * slots_per_day, (d+1) * slots_per_day), so the
    distance between two absolute slots on consecutive days counts only the
    hours the school teaches in — 08:00 Tuesday is 120 slots after 08:00 Monday
    on a ten-hour day, when the clock says 288. The difference, `slots in the
    calendar days crossed` less `slots_per_day`, is exactly the closed part of
    the night, and adding it to tomorrow's start turns a comparison of absolute
    slots into a comparison of real elapsed time.

    IT READS THE WEEKDAYS AND NOT THE INDICES, because SCHEDULE_DAYS need not
    be contiguous: a school that teaches Monday, Wednesday and Friday has two
    nights between index 0 and index 1, and a rest rule that counted one would
    refuse a week for want of hours the teacher slept through.

    1440 // slot_minutes is a whole number for every legal slot length — the
    settings validator requires one that divides 60.
    """
    days_apart = grid.schedule_days[day_index + 1] - grid.schedule_days[day_index]
    return days_apart * (1440 // grid.slot_minutes) - grid.slots_per_day


def _teachers_of(requirement: AnonymousRequirement) -> tuple[UUID, ...]:
    """Everyone who teaches this requirement: every lead and the co-teacher.

    Its own reader because every teacher-keyed rule in this module has to make
    the same union, and a rule that read `teacher_id` alone would let a
    co-taught school out of it: a co-taught lesson is teaching for both of
    them, and both are owed the lunch and the rest it takes away.

    THE ROW, NOT A LESSON. A split post (lessonTeacherIds) is taught by every
    lead it names, so the union is those leads in lesson order, each once,
    then the co-teacher — for the readers that ask whether a teacher is on the
    row at all: two members of a block sharing anybody, a rule that reaches
    no lesson, the TIMEOUT line's count. A reader that asks about A LESSON —
    who is in its no-overlap, whose day it fills — reads _lesson_teachers:
    Bertil leading one lesson of three is not on the other two. A post one
    person leads is the pair it always was, a legacy row naming one person
    twice included.
    """
    if requirement.lesson_teacher_ids is None:
        return tuple(
            teacher_id
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id)
            if teacher_id is not None
        )
    return tuple(dict.fromkeys(
        teacher_id
        for teacher_id in (*requirement.lesson_teacher_ids, requirement.co_teacher_id)
        if teacher_id is not None
    ))


def _teachers_at(requirement: AnonymousRequirement, lesson_index: int) -> tuple[UUID, ...]:
    """Who teaches lesson `lesson_index` of the requirement: its lead, then the co-teacher.

    LEAD FIRST AND NEITHER DROPPED FOR BEING THE OTHER, which is the pair
    every teacher-keyed builder read off the requirement before a post could
    be split — (teacher_id, co_teacher_id), the Nones left out, a legacy row
    naming one person twice twice. So for a post one person leads every
    lesson answers exactly that, and every family, sum and walk built from it
    is built in the order it always was; only a split post's lessons differ,
    each by its own lead (AnonymousRequirement.lesson_teacher). A lesson the
    list gives nobody is the co-teacher's alone, or nobody's — and a teacher
    whose only lesson that was simply has none, so no family is built empty.
    """
    lead = requirement.lesson_teacher(lesson_index)
    co_teacher = requirement.co_teacher_id
    if lead is None:
        return () if co_teacher is None else (co_teacher,)
    return (lead,) if co_teacher is None else (lead, co_teacher)


def _lesson_teachers(lesson: LessonInstance) -> tuple[UUID, ...]:
    """The teachers ON this lesson, lead first — see _teachers_at."""
    return _teachers_at(lesson.requirement, lesson.lesson_index)


def _teachers_on_every_lesson(requirement: AnonymousRequirement) -> tuple[UUID, ...]:
    """The teachers on every lesson of the requirement, for a check that reads the row.

    A pre-flight that asks one question per requirement — is this day shut
    to it, is this stretch reserved away from it — may only count a teacher's
    row against the requirement when it reaches every lesson, or it refuses
    a week the per-lesson model would place: Bertil's Friday off is not a
    Friday shut to Anna's lessons. For a post one person leads that is
    everybody on it (_teachers_of). For a split post it is the co-teacher
    alone: the list names two different leads, so no lead is on every lesson.
    """
    if requirement.lesson_teacher_ids is None:
        return _teachers_of(requirement)
    return () if requirement.co_teacher_id is None else (requirement.co_teacher_id,)


def _teacher_week(
    requirements: list[AnonymousRequirement],
) -> tuple[dict[UUID, int], dict[UUID, int], dict[UUID, list[AnonymousRequirement]]]:
    """Teacher -> their week's minutes, their longest lesson, and their requirements.

    PER LESSON, each lesson once per person on it (_teachers_at as a set), the
    one reading of a teacher's week the pre-flights share: the days and cap
    check (_verify_teacher_day_rules) and the hours verdict
    (_teacher_hours_verdict). A split post's lessons are each their own
    lead's, so a lead of one of its three is charged that one and its length.
    Each requirement is listed once per teacher it reaches, in the payload's
    order, for _teacher_rooms, which reads the requirement's every length —
    for a lead of some of a split post's lessons a wider room than theirs,
    which can only make a refusal rarer, never a feasible week refused.

    An unsplit requirement gives its lead and its co-teacher every lesson:
    the sum, the longest and the list the per-requirement reading made, in the
    same insertion order, so a payload with no split reads the dicts it read.
    """
    week_minutes: dict[UUID, int] = {}
    longest: dict[UUID, int] = {}
    requirements_of: dict[UUID, list[AnonymousRequirement]] = {}
    for requirement in requirements:
        if requirement.lesson_teacher_ids is None:
            for teacher_id in dict.fromkeys(_teachers_of(requirement)):
                week_minutes[teacher_id] = (
                    week_minutes.get(teacher_id, 0) + sum(requirement.lesson_minutes())
                )
                longest[teacher_id] = max(
                    longest.get(teacher_id, 0), requirement.minutes_per_lesson,
                )
                requirements_of.setdefault(teacher_id, []).append(requirement)
            continue
        for lesson_index, minutes in enumerate(requirement.lesson_minutes()):
            for teacher_id in dict.fromkeys(_teachers_at(requirement, lesson_index)):
                week_minutes[teacher_id] = week_minutes.get(teacher_id, 0) + minutes
                longest[teacher_id] = max(longest.get(teacher_id, 0), minutes)
                listed = requirements_of.setdefault(teacher_id, [])
                if not listed or listed[-1] is not requirement:
                    listed.append(requirement)
    return week_minutes, longest, requirements_of


def _fixed_relations(
    lesson: LessonInstance,
    fixed: FixedLesson,
    conflicts_with: dict[UUID, set[UUID]],
) -> list[tuple[Party, tuple[UUID, ...]]]:
    """Whom a locked lesson and a generated one share, as the walk's families key them.

    _add_fixed_lesson_constraints's own test, read per party: each teacher on
    both, and the pupils of the generated lesson's group when the lock holds
    that group or one sharing a pupil with it. The walk's rows hang on these
    keys' literals, and the verdict reads a timetable against the same keys.
    The teachers ON THE LESSON (_lesson_teachers), as that test reads them: a
    lock of Bertil's holds his lesson of a split post a walk away and none of
    Anna's, which the row's union of leads would hold too.

    The pupils in the PUPIL space (pupil_key_of, pupil_keys_of), as that test
    and travel.families_of read them, so the key a lock's walk hangs on is a
    family the week has.
    """
    requirement = lesson.requirement
    relations: list[tuple[Party, tuple[UUID, ...]]] = []
    fixed_teachers = {tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid}
    for teacher_id in dict.fromkeys(_lesson_teachers(lesson)):
        if teacher_id in fixed_teachers:
            relations.append(("TEACHER", (teacher_id,)))
    own = pupil_key_of(requirement)
    fixed_groups = pupil_keys_of(fixed)
    if own in fixed_groups or any(
        fixed_group in conflicts_with.get(own, ()) for fixed_group in fixed_groups
    ):
        # Keyed by the generated lesson's own group, the hub whose pupils
        # walk (travel.families_of): the lock holds some of them.
        relations.append(("PUPILS", (own,)))
    return relations


def _lessons_by_teacher(
    decisions: list[LessonDecision],
) -> dict[UUID, list[LessonDecision]]:
    """Teacher -> the lessons they are on, each lesson once.

    `_lesson_teachers` AS A SET, which is the difference from the older
    readers: a legacy row naming one person as both lead and co-teacher is one
    lesson for that person, and a cap that counted its minutes twice would
    refuse a day nobody teaches longer than the cap.
    """
    by_teacher: dict[UUID, list[LessonDecision]] = {}
    for decision in decisions:
        for teacher_id in dict.fromkeys(_lesson_teachers(decision.lesson)):
            by_teacher.setdefault(teacher_id, []).append(decision)
    return by_teacher


def _teacher_locks(
    fixed_lessons: list[FixedLesson],
) -> tuple[dict[tuple[UUID, int], int], dict[UUID, set[int]]]:
    """What a teacher's hand-placed lessons already take: minutes per weekday, and the weekdays.

    (teacher, ISO weekday) -> the minutes of the union of the clock spans of
    every locked lesson the teacher is on, as lead or co-teacher; and teacher
    -> the ISO weekdays those lessons are on.

    THE CLOCK, EXACT AND UNCLIPPED — not _teacher_busy_from_locks, which rounds
    a window outward to the slot and clips it to the school day, and drops a
    weekday the grid does not teach. Those are the right windows for keeping
    a generated lesson out of a locked one's way; they are the wrong minutes
    for a cap, which a lesson locked 07:30-09:00 on an 08:00 grid would have
    shortened by thirty minutes the teacher really does teach.

    THE WEEKDAYS ARE EVERY WEEK'S AT ONCE, which is what the free-day wish
    asks — is any lesson of the teacher's on that weekday — and NOT what the
    post's days are held against: an odd week's Monday and an even week's
    Wednesday are never one week's two days, and the days limit reads the
    weeks the gateway sends instead (AnonymousTeacherDayLimit.locked_weekdays,
    _week_sets).

    THE UNION, because two locked lessons the clash check let through overlap
    in time and not in teacher: the teacher is in one room at a time
    (src/common/teacher-day.ts counts the same way). A lesson with no length
    takes no time and makes no teaching day.
    """
    spans: dict[tuple[UUID, int], list[tuple[int, int]]] = defaultdict(list)
    for fixed in fixed_lessons:
        start = _clock_minutes(fixed.start_time)
        end = _clock_minutes(fixed.end_time)
        if end <= start:
            continue
        for teacher_id in dict.fromkeys(
            teacher_id
            for teacher_id in (fixed.teacher_id, fixed.co_teacher_id)
            if teacher_id is not None
        ):
            spans[(teacher_id, fixed.day_of_week)].append((start, end))
    minutes = {
        key: sum(end - start for start, end in _merge_ranges(ranges))
        for key, ranges in spans.items()
    }
    days: dict[UUID, set[int]] = defaultdict(set)
    for teacher_id, weekday in spans:
        days[teacher_id].add(weekday)
    return minutes, dict(days)


def _week_sets(limit: AnonymousTeacherDayLimit) -> list[frozenset[int]]:
    r"""The weeks a days limit is held in: each set of locked weekdays once,
    less every set another one already holds for it.

    A WEEK INSIDE ANOTHER OF AT MOST N DAYS IS IMPLIED, and only then. Write G
    for the grid days the solver's lessons take; a week with locks on L is
    held by |G \ L| ≤ max(0, N − |L|). For L' ⊂ L with |L| ≤ N,
    |G \ L'| = |G \ L| + |G ∩ (L \ L')| ≤ (N − |L|) + (|L| − |L'|) =
    N − |L'|, which is the line of L'. Past N the floor breaks it — L's line
    is then G ⊆ L, and G may take every day of L \ L' — so a set inside one
    the locks alone put over N is a week of its own and stays. A dropped set
    always has a kept one above it: whatever implied it is either kept or
    implied in turn by a larger set of at most N, and the sets are finite.

    In the payload's order of first mention, so the rows are built in the
    same order on every run, and a list of one set — a teacher locked the
    same every week — is that set and nothing else.
    """
    most = limit.max_teaching_days_per_week
    distinct = list(dict.fromkeys(frozenset(week) for week in limit.locked_weekdays))
    return [
        week
        for week in distinct
        if not any(week < other and len(other) <= most for other in distinct)
    ]


def _day_reach(
    starts: cp_model.Domain, duration: int, slots_per_day: int,
) -> dict[int, list[tuple[int, int]]]:
    """Day index -> the absolute [a, b) slots a lesson on these starts can occupy there.

    Every interval of the domain lies inside one day by construction —
    _start_domains builds one range per day and only ever cuts it — and is
    split at a day's edge all the same, so a domain from anywhere else cannot
    smear one day's slots into the next. The keys are the days the lesson can
    fall on at all.
    """
    reach: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for low, high in _domain_intervals(starts):
        for day_index in range(low // slots_per_day, high // slots_per_day + 1):
            first = max(low, day_index * slots_per_day)
            last = min(high, (day_index + 1) * slots_per_day - 1)
            reach[day_index].append((first, last + duration))
    return dict(reach)


def _covered(spans: list[tuple[int, int]]) -> int:
    """The slots the half-open [a, b) spans cover between them, overlaps once."""
    covered = 0
    reach = -1
    for low, high in sorted(spans):
        low = max(low, reach)
        if high > low:
            covered += high - low
            reach = high
    return covered


def _merged(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The half-open spans joined where they meet or overlap, in order."""
    out: list[tuple[int, int]] = []
    for low, high in sorted(spans):
        if high <= low:
            continue
        if out and low <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], high))
        else:
            out.append((low, high))
    return out


def _covered_both(first: list[tuple[int, int]], second: list[tuple[int, int]]) -> int:
    """The slots both sets of half-open spans cover."""
    covered = 0
    for low, high in _merged(first):
        for other_low, other_high in _merged(second):
            covered += max(0, min(high, other_high) - max(low, other_low))
    return covered


def _day_totals(
    model: cp_model.CpModel,
    name: str,
    on_days: dict[int, cp_model.LinearExpr],
    most: dict[int, int],
    week: int,
) -> dict[int, cp_model.IntVar]:
    """A variable per day equal to what lands there, and the days summing to the week.

    How a cap on a day is posted, by every builder that caps what a day takes:
    `total_d == Σ on day d`, `total_d` in [0, most_d], and `Σ_d total_d ==
    week`. The cap is then a row on `total_d` under the rule's literal, and
    never the day's sum against a number — nor the domain, which is what the
    day could hold at all and so a definition like the rest. A domain is
    posted bare, and a bare rule proves a week impossible without touching an
    assumption: the core comes back empty and names no cause. The class daily
    maximum was a domain once: of 557 impossible weeks from the guard's fuzz
    generator, 40 came back with an empty core, and on its literal 4 do, none
    of them a week with the maximum in it.

    THE SUM AGAINST A NUMBER IS WHAT CP-SAT 9.15.6755 THREW ON. Once presolve
    has narrowed a set of lessons to two days, a lesson's literal for one day
    is the negation of its literal for the other, and the two days' rows
    `Σ x ≤ a` and `Σ x ≤ b` turn into one row over one set of literals, bounded
    above and below. Where those bounds cannot both hold — the lessons need
    more than the two days take — presolve's duplicate pass is the step that
    proves the week impossible, the symmetry detection right after it runs on
    the model it has just proved infeasible, and Solve raises IndexError
    (absl raw_hash_map::at): google/or-tools#5494, fixed upstream in fb65967
    and in no release yet. The guard's fuzz found it in 25 of 5,865 accepted
    weeks, from three builders (_add_rules_constraints,
    _add_distribution_constraints and _add_teacher_day_constraints), and each
    of those weeks was then proved again without presolve.

    THE WEEK ROW REFUSES IT FIRST. Its terms are the day totals, so presolve's
    bound propagation reads off it what the duplicate pass would have found
    later — two days that take a and b hold a + b, and a week of more is
    refused there — and two days' rows can no longer turn into one, since each
    has its own total in it. Where the old rows threw, every build now answers
    INFEASIBLE out of presolve (tests/test_solve_guard.py keeps the weeks).

    NOTHING IS LOOSER AND NOTHING IS FREE. A total is its sum by definition,
    so a bound on it is the bound on the sum, row for row in the LP. The week
    row is "each lesson lands on exactly one day" added up: a one-hot's LP
    holds it already, and a reified literal per day held nothing of the kind,
    so the LP is as strong or stronger. Every total is fixed once the
    literals under it are, so none is a free variable — a few thousand of
    those once flipped a solvable model to UNKNOWN (_build_model).

    MEASURED side by side with the sum rows (benchmarks/hogstadium.py, one
    loaded host): the impossible post (--teacher-day-rules
    --infeasible-days) INFEASIBLE in 5.5-6.0 s against 18.6-19.8 s, and on
    one worker refuted by presolve alone; the first timetable no slower,
    within the portfolio's own spread — 22 runs each on the plain week, means
    9.3 s against 9.2 s, though the no-LP worker that sometimes won there no
    longer does — and even with the caps and posts on, or with a subject's
    days on every class.

    `on_days` maps every day a lesson can land on to that day's sum, and
    `most` gives each day's domain, never a rule's cap; a day missing from
    `on_days` must be one no lesson reaches, or the week row would be wrong.
    """
    totals = {
        day_index: model.NewIntVar(0, most[day_index], f"{name}_{day_index}")
        for day_index in on_days
    }
    for day_index, landed in on_days.items():
        model.Add(totals[day_index] == landed)
    model.Add(sum(totals.values()) == week)
    return totals


def _blocks_of(
    requirements: Iterable[AnonymousRequirement],
) -> dict[UUID, list[AnonymousRequirement]]:
    """Every parallel block the payload names, its members in payload order.

    TWO OR MORE MEMBERS, or it is no block at all: one requirement starting
    when itself starts constrains nothing, so a block whose other members are
    all locked or not yet written builds nothing and is refused for nothing.
    The gateway sends no blockId on such a member; this holds the engine to the
    same reading whatever a caller sends.

    The first member leads: its k-th lesson is the one every other member's
    k-th is held equal to, and its order is the payload's, so a refusal names
    the same two members on every run.
    """
    members: dict[UUID, list[AnonymousRequirement]] = {}
    for requirement in requirements:
        if requirement.block_id is not None:
            members.setdefault(requirement.block_id, []).append(requirement)
    return {block_id: rows for block_id, rows in members.items() if len(rows) >= 2}


def _common_domains(domains: list[dict[int, cp_model.Domain]]) -> dict[int, cp_model.Domain]:
    """The starts every member of a block may take, per lesson length.

    The members have the same lengths (_validate_blocks refuses any that do
    not), so the first member's keys are every member's.
    """
    common = dict(domains[0])
    for other in domains[1:]:
        for duration, domain in common.items():
            common[duration] = domain.intersection_with(other[duration])
    return common


def _without_blocks(request: OptimizeScheduleRequest) -> OptimizeScheduleRequest:
    """The same week with every block dropped and every requirement kept."""
    return request.model_copy(update={
        "requirements": [
            requirement.model_copy(update={"block_id": None})
            for requirement in request.requirements
        ],
    })


def _group_ids_with_lessons(
    requirements: list[AnonymousRequirement],
) -> Iterable[UUID]:
    """Every group the timplan gives a lesson to, in the payload's own order.

    One reader, so the callers of `_lunch_group_ids` that hold a request — the
    timeout diagnosis among them — cannot drift from each other about what
    "has lessons" means. The builder holds decisions rather than requirements
    and passes its own `by_group`, which is the same list: decisions are
    created requirement by requirement, and every requirement carries
    lessons_per_week >= 1.
    """
    return (requirement.student_group_id for requirement in requirements)


def _lunch_group_ids(
    groups: list[AnonymousGroup],
    with_lessons: Iterable[UUID],
) -> list[UUID]:
    """Every group the solver owes a lunch break, in a stable order.

    THE PAYLOAD'S `groups` WHEN IT HAS ANY, and the groups with lessons when
    it has none. The gateway decides who eats: it sends the HOME CLASSES, with
    their headcounts and their years, and a teaching group is not among them
    because its pupils already eat with their class. Reading anything else
    alongside a `groups` that is really there has a cost: a mandatory
    thirty-minute reservation on every teaching group's day for a meal nobody
    takes there, and an INFEASIBLE with a lunch cause on the day it did not
    fit. A class's meal is still kept clear of its teaching groups' lessons,
    through the shared-pupil pairs.

    AN ABSENT `groups` IS NOT AN EMPTY DINING ROOM. The field is optional so
    the engine can ship before the gateway that fills it, and the schema says
    what the engine owes until then: the free-window guarantee still reaches
    every group with requirements, and the hall simply hears about nobody.
    Read as "the payload's groups, full stop", an absent list withdrew the
    guarantee from the whole school in silence — every class taught edge to
    edge through 11:00-13:00, no lunch in the response, and an OPTIMAL over
    the top of it. That is what the benchmark validator caught: for its school
    the model built not one lunch interval, and the school had asked for
    lunch. A school that names nobody still gets its break; the hall is what
    goes unmodelled, and it does, because every headcount is then 0.

    `with_lessons` is required, not defaulted, for the reason
    _add_rules_constraints requires `groups`: a caller that forgets it would
    silently build the model with no lunch in it at all, which is precisely
    the bug this parameter exists to close.

    Ordered rather than a set because both builds of the model iterate this
    and `solve` refuses to hint one from the other unless they agree
    structurally.
    """
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for group_id in (group.id for group in groups) if groups else with_lessons:
        if group_id not in seen:
            seen.add(group_id)
            ordered.append(group_id)
    return ordered


def _lunch_headcounts(groups: list[AnonymousGroup]) -> dict[UUID, int]:
    """Seats each group needs, keyed by group id.

    The largest of any duplicates, never the last one seen: two entries for
    one group is the gateway contradicting itself, and the whole point of
    counting every home class every day is that this number must not come out
    low.
    """
    headcounts: dict[UUID, int] = {}
    for group in groups:
        headcounts[group.id] = max(
            headcounts.get(group.id, 0), group.lunch_headcount,
        )
    return headcounts


def _groups_sharing_students(
    group_conflicts: list[tuple[UUID, UUID]] | None,
) -> dict[UUID, list[UUID]]:
    """Which groups put a given group's children in a classroom.

    The teaching groups cut out of a class, and the class a teaching group was
    cut from. That is exactly `group_conflicts`, the relation
    _add_group_no_overlap already uses to keep their lessons apart, and lunch
    needs it in both directions — each side's break has to reckon with the
    other side's lessons.

    Groups the timplan never mentions are kept, unlike in
    _add_group_no_overlap: a class whose every lesson is locked has no
    generated lessons, and its locked lessons still have to keep the teaching
    groups cut out of it from eating while its children are being taught.
    Callers that need decisions filter on `by_group` themselves.
    """
    shares_students: dict[UUID, list[UUID]] = {}
    for first_id, second_id in group_conflicts or []:
        for owner_id, other_id in ((first_id, second_id), (second_id, first_id)):
            if owner_id == other_id:
                continue
            partners = shares_students.setdefault(owner_id, [])
            if other_id not in partners:
                partners.append(other_id)
    return shares_students


def _derived_key_classes(request: OptimizeScheduleRequest) -> dict[UUID, UUID]:
    """Each DERIVED pupil key, and the class whose lessons it sits.

    A derived key ("7A without SvA7") is a pupil key that no class key is: no
    requirement is filed under it, no lock names it and no group entry is it.
    Its class is the one the first requirement it sits is filed under, else
    the first lock carrying it names. A pupilGroupId that IS a group — a
    real teaching group named as a lesson's pupils — is no derived key and is
    named as itself.

    Empty for every payload without pupilGroupId or pupilGroupIds, which is
    what keeps every refusal of those payloads the bytes it was.
    """
    if not any(r.pupil_group_id is not None for r in request.requirements) and not any(
        f.pupil_group_ids is not None for f in request.fixed_lessons
    ):
        return {}
    classes = {r.student_group_id for r in request.requirements}
    classes.update(
        group_id
        for fixed in request.fixed_lessons
        for group_id in (fixed.student_group_id, *fixed.extra_group_ids)
    )
    classes.update(group.id for group in request.groups)
    derived: dict[UUID, UUID] = {}
    for requirement in request.requirements:
        key = pupil_key_of(requirement)
        if key not in classes:
            derived.setdefault(key, requirement.student_group_id)
    for fixed in request.fixed_lessons:
        for key in fixed.pupil_group_ids or ():
            if key not in classes:
                derived.setdefault(key, fixed.student_group_id)
    return derived


def _named_by_class(
    request: OptimizeScheduleRequest, conflicts: ConflictAnalysis | None,
) -> ConflictAnalysis | None:
    """A refusal with every derived pupil key named by its class instead.

    THE DERIVED KEY IS INPUT ONLY. The gateway coins "7A without SvA7" for
    groupConflicts and pupilGroupId and keeps no name for it, so a refusal
    that said it would name nobody. The rules of the pupil space key what
    they register by it — the walk's PUPILS families above all, whose lines
    the measured verdict also builds from the family keys — so the names are
    turned back here, once, where the refusal leaves _explain_infeasible:
    "the pupils of 7A's svenska" are 7A's. A line naming (X, 7A) then names
    7A once.

    The same object back when nothing is derived, so a payload without the
    fields is answered with exactly the refusal it always got.
    """
    if conflicts is None:
        return None
    classes = _derived_key_classes(request)
    if not classes:
        return conflicts
    details = []
    for detail in conflicts.conflicts:
        named = list(dict.fromkeys(classes.get(rid, rid) for rid in detail.resource_ids))
        details.append(
            detail
            if named == list(detail.resource_ids)
            else detail.model_copy(update={"resource_ids": named}),
        )
    return conflicts.model_copy(update={"conflicts": details})


def _grade_span_overlaps(
    constraint: AnonymousConstraint,
    requirement: AnonymousRequirement,
) -> bool:
    """Whether a reservation for a span of years reaches this group.

    OVERLAP, and deliberately the opposite test to _grade_allowed's
    containment a few lines below. Reserving 11:30 for years 4-6 holds those
    students free; a group spanning years 6-7 has year-6 students in it, so it
    has to be held free too. Holding a handful of year-7 students free as well
    costs the timetable a little room, whereas letting the lesson stand puts
    year-6 pupils in a classroom during their own lunch. One of those errors a
    school can live with and the other it cannot, so the rule is written to
    make the survivable one. Rooms reason the other way round because there
    half a group in an allowed year is still not an allowed placement.

    A group whose own years are unknown cannot be matched at all: with nothing
    to compare against, "overlaps" has no answer, and answering yes would
    sweep every group with no member years into a reservation meant for one
    stage of the school.

    A missing bound on the constraint is open at that end — "up to year 3" and
    "from year 7" are both a school's own way of saying stage.
    """
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return False

    if (
        constraint.min_grade_level is not None
        and requirement.max_grade_level < constraint.min_grade_level
    ):
        return False
    return not (
        constraint.max_grade_level is not None
        and requirement.min_grade_level > constraint.max_grade_level
    )


def _rule_reaches(
    preference: AnonymousRoomPreference,
    requirement: AnonymousRequirement,
) -> bool:
    """Whether a room rule scoped to a stage applies to this requirement.

    CONTAINMENT, like _grade_allowed and unlike _grade_span_overlaps, and for
    the same reason the one directly below states: a room decides where a group
    may GO, while a reservation only decides who must be left alone. Under
    overlap an åk 7-9 rule would seize a teaching group spanning 6-7 — a real
    shape, since spans come from members' home classes — and send its year-6
    pupils into a högstadie room. Not applying a rule is survivable; applying it
    to a group half outside the span is not.

    A rule with no span reaches everything, which is what every rule written
    before the span existed means, and is what keeps this change at exactly zero
    difference for a school that has not used it. A rule WITH a span does not
    reach a group whose own years are unknown: there is nothing to contain, and
    guessing would sweep every unlabelled group into a rule meant for one stage.
    """
    if preference.min_grade_level is None or preference.max_grade_level is None:
        return True
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return False
    return (
        requirement.min_grade_level >= preference.min_grade_level
        and requirement.max_grade_level <= preference.max_grade_level
    )


def _grade_allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
    """Whether a room limited to a stage may host this group.

    The group's whole year span has to fit inside the room's range: half a
    group being in an allowed year is not an allowed placement, since the
    other half would be sitting in a room the school reserved for somebody
    else. Containment, not the overlap _grade_span_overlaps uses for time
    reservations — the two rules read the same data and answer differently on
    purpose, because a room decides where a group may go while a reservation
    only decides who must be left alone.

    A group whose years are unknown — no members carrying a year — is let
    through. There is nothing to check it against, and refusing every limited
    room instead would make an unremarkable group unschedulable for a reason
    no message could explain.
    """
    if room.min_grade_level is None and room.max_grade_level is None:
        return True
    if requirement.min_grade_level is None or requirement.max_grade_level is None:
        return True

    if room.min_grade_level is not None and requirement.min_grade_level < room.min_grade_level:
        return False
    return not (
        room.max_grade_level is not None
        and requirement.max_grade_level > room.max_grade_level
    )


def resolve_room_locks(
    requirements: list[AnonymousRequirement],
    preferences: list[AnonymousRoomPreference],
    rooms: list[AnonymousRoom],
) -> dict[UUID, frozenset[UUID]]:
    """requirement id -> the only rooms its locks allow. Absent means unlocked.

    THE NARROWEST SPAN WINS, AND EQUALLY NARROW RULES ARE ALTERNATIVES. Among
    the locks that reach a requirement, only those of the smallest width survive
    (a lock with no span counts as the widest, since it reaches every year), and
    the rooms of that tier UNION.

    Not intersection, even though a bound intersects in principle and that is
    what FrameTimes chose for its own kind. A frame is an interval and
    intersects continuously; a room set goes empty in ONE step. "Matte åk 4-6 ->
    Bryggan 3" plus "matte åk 4 -> Optimisten 4" would intersect to nothing, and
    a whole subject x stage becomes unschedulable from two sentences a school
    would reasonably write. Under specificity the second sentence reads as what
    a school means by it: an exception to the first.

    Not a plain union across every tier either, which is the LunchServings rule.
    Adding one broad lock would then silently weaken every narrow lock already
    written, and the narrow rule stops meaning what it says.

    Because ties union, the result is a pure function of the row set: order
    does not matter, there is no tiebreak by id, and it can never come back
    empty from two rules that each name a room. It CAN come back empty from a
    single rule whose rooms are all gone — which is a refusal, and
    _validate_request names it before any solve begins.
    """
    by_subject: dict[UUID, list[AnonymousRoomPreference]] = defaultdict(list)
    for preference in preferences:
        if preference.kind == "LOCK":
            by_subject[preference.subject_id].append(preference)
    if not by_subject:
        return {}

    locked: dict[UUID, frozenset[UUID]] = {}
    for requirement in requirements:
        reaching = [
            preference
            for preference in by_subject.get(requirement.subject_id, ())
            if _rule_reaches(preference, requirement)
        ]
        if not reaching:
            continue
        narrowest = min(_span_width(preference) for preference in reaching)
        allowed: set[UUID] = set()
        for preference in reaching:
            if _span_width(preference) == narrowest:
                allowed |= _preference_room_ids(preference, rooms)
        locked[requirement.id] = frozenset(allowed)
    return locked


def _span_width(preference: AnonymousRoomPreference) -> int:
    """How many years a rule covers. No span is the widest thing there is."""
    if preference.min_grade_level is None or preference.max_grade_level is None:
        return 14  # one more than 0-12, so it loses every tie to a real span
    return preference.max_grade_level - preference.min_grade_level + 1


def _preference_room_ids(
    preference: AnonymousRoomPreference,
    rooms: list[AnonymousRoom],
) -> set[UUID]:
    """The rooms a preference points at, whether by type or by name."""
    if preference.room_type is not None:
        return {room.id for room in rooms if room.type == preference.room_type}
    return set(preference.room_ids)


def _class_is_preferred(
    room_plan: RoomPlan,
    class_index: int,
    rooms: list[AnonymousRoom],
    preferred_rooms: set[UUID],
) -> bool:
    """Whether a class sits inside the preferred set.

    Every room of a class shares the preference bits that built it, so testing
    the first member decides the class — the same argument that makes the
    eligibility signature sound.
    """
    room_class = room_plan.classes[class_index]
    return rooms[room_class.room_indices[0]].id in preferred_rooms
