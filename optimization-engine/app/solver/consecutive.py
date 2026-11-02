"""Sammanhängande undervisning: at most X minutes of teaching in a row, then Y free.

A WISH, NOT A RULE. A teacher whose work rule sets `maxConsecutiveTeachingMinutes`
(X) and `consecutiveBreakMinutes` (Y) is better off never teaching more than X
minutes without a break of at least Y, and the full model's objective pays
WEIGHT for every lesson of theirs whose stretch is not ended by such a break in
time. No week is ever refused over it. The satisfaction phase builds nothing
for it, so the school's wishes cannot make its timetable harder to find, and a
school that has flagged nobody builds the model it always built, variable for
variable. That is the free-day wish's way (_add_free_day_objective), chosen on
a measurement and not on taste:

    A HARD RULE WAS BUILT FIRST, with the same encoding below and the break
    present under an assumption literal, and measured on the högstadium school
    (450 pupils, 26 teachers, 423 lessons, the eight busiest teachers flagged
    with 180 minutes then 30 free, paired and concurrent with main's model).
    The first solution took 27–85 s where main's takes 8 in two pairs of three,
    and the full solve found no timetable at all in 90 s in three pairs of
    three. The whole cost is the disjunctive rows that keep a floating break
    clear of the teacher's lessons: with the same variables and no
    no-overlap the time is main's, and a rule that binds hardly costs as much
    as one that binds. Pair-links between the lessons' breaks, a single
    cumulative per teacher and solver parameters did not help. As a wish in the
    objective the same school solves 423 of 423 lessons in every pair, with
    0–3 of the eight teachers left over the limit (one or two in the usual
    run) where main's model leaves 7–8 (docs/verification-baseline.md).
    "The generator tries" is the promise,
    the gateway names the teachers it did not manage (consecutive-wishes.ts),
    and the rule stays hard where it is cheap: the hand edit's warning and the
    Vikarietavla's exclusion.

WHAT A STRETCH IS, and the whole of the definition. On one day of one real
week, sort the teacher's lessons — lead or co-teacher, generated or locked —
by start. A lesson JOINS the stretch before it when it starts less than Y
after the stretch's latest end (a lesson that overlaps it joins too). A stretch
runs from its first lesson's start to its last lesson's end, and its length
counts the short gaps inside it: a teacher walking between two rooms, or
waiting out ten minutes, is still on duty. The rule says every stretch is at
most X minutes. The corridor between two rooms is part of the gap and not of
the lesson, so two lessons ten minutes apart with a break of fifteen are one
stretch, and a break is time with no lesson of the teacher's in it at all —
their own lunch is a break when it is long enough, and so is an hour the
school has closed to them (UNAVAILABLE), because the rule limits TEACHING and
the teacher is not teaching then.

src/common/stretch.ts is the same definition for the gateway (a hand edit's
warning, the Vikarietavla, the notes of a finished run) and
benchmarks/validate_schedule.py (stretch_breaches) is a third that shares no
code with this one; both replay src/common/__fixtures__/stretch-cases.json.

THE ENCODING, and why it is exact. Write a for a lesson's start and F(t) for
"no lesson of the teacher's overlaps [t, t + Y)". If a lesson starts at a, the
stretch it begins (or sits in) is at most X exactly when some F(t) holds for a
t in [a + length, a + X]: the free time is there, so the stretch ended by it.
Conversely a stretch that starts at a and ends at b <= a + X has F(b), and a
stretch that is longer has no F in the window, because the only free time in
it is shorter than Y. For a lesson that is not the first of its stretch the
condition is only weaker, so one such row per lesson, applied to all of them,
is exactly "no stretch is longer than X"; the lessons that miss their row are
the ones that begin an over-long stretch, or sit in its first part, and the
objective pays for each, so a longer stretch costs more than a slightly
longer one. No successor variables, no pair literals and no per-slot
occupancy.

F(t) IS A MOVABLE INTERVAL. Per lesson an optional break of Y slots whose start
is confined to [end, start + X] (when the lesson is "kept") and which is in a
no-overlap with the teacher's lessons — the teacher's lunch in
_add_teacher_lunch, in the same shape, for the same reason: "a free window of Y
slots exists inside this window" is "a task of that length can be placed among
these lessons", which is what the disjunctive propagator is for. 

WHERE A BREAK MAY BEGIN. In principle on any slot, and not only on a lesson's
start step: a lesson of 40 minutes on a 30-minute grid ends between two steps,
and the free time begins there. A break confined to the steps is a much
smaller search (six values for X = 180 where thirty-seven are open), and it
loses nothing when X and Y are whole steps and every edge of a locked stretch
is on a step: a free window of Y that starts between two steps can slide
forward to the next step, because the lesson after the gap starts on one and Y
is a whole number of them, and it stays inside [end, start + X] because the
upper bound is on a step too. When any of that fails (a break of 15 minutes on
a 30-minute step, a lock from 08:20), the break is free on every slot, and
the model is exact in all cases (test_consecutive.py tries every placement
both ways).

THE NIGHT IS A BREAK, AND IS PAID FOR WITH A SHIFTED CLOCK. A lesson that ends
at five with X = 180 has the rest of the day, and the night, to rest in; but
the engine's slots count only the hours the school teaches, so Monday's last
slot is next to Tuesday's first. Each day is therefore pushed Y slots later
than the one before it for this wish's intervals (start + Y * day), which
leaves a gap of exactly Y between any two days: a break that ends a day fits
in it, and a lesson on Tuesday morning cannot be mistaken for the continuation
of Monday's afternoon.

THE LOCKED LESSONS ARE FACTS, as for the cap (_add_teacher_day_constraints).
They are constant intervals beside the generated ones, so a break cannot be
laid across them. The school's locked lessons, joined where the gap between
them is under Y, make stretches of their own, and the wish is about the ones
the solver can make worse:

    * a locked stretch within X is a row of its own, begun by a locked lesson
      and so with no generated lesson to carry it: its break must come between
      its end and X after its start, and a generated lesson placed against it
      that pushes the stretch past X takes that break away and PAYS the same
      price a generated lesson does;
    * a locked stretch already longer than X is the school's own doing, warned
      beside the edit that made it (master-lessons.service.ts), and costs
      nothing by itself; a generated lesson that JOINS it (starts within Y of
      either end) is part of a stretch over X, and is not "kept".

So the model's cost is zero exactly when no stretch with a generated lesson in
it is longer than X, which is how the tests state the oracle.

A/B-VECKOR. The wish is a real week's, so a teacher whose two weeks differ is
held in each, with that week's lessons and that week's locks (week_parts, the
rest rule's own reading); each week's lessons pay for themselves.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

from ortools.sat.python import cp_model

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from app.schemas.schedule import AnonymousTeacherWorkRule, WeekParity
    from app.solver.scheduler_solver import LessonDecision
    from app.solver.time_grid import TimeGrid

#: One week of a teacher as the builder reads it: the week (None for every
#: week), the generated lessons in it, and the windows the teacher's locked
#: lessons take in it, absolute slots, outward-rounded and clipped to the day.
StretchWeek = tuple["WeekParity | None", "list[LessonDecision]", "list[tuple[int, int]]"]


def stretch_slots(rule: AnonymousTeacherWorkRule, slot_minutes: int) -> tuple[int, int]:
    """(X, Y) in slots: the limit rounded down and the break rounded up.

    Both toward the stricter reading, which the grid never needs: the work
    rule's bounds are multiples of five minutes and the engine's slot is five.
    """
    assert rule.max_consecutive_teaching_minutes is not None
    assert rule.consecutive_break_minutes is not None
    return (
        rule.max_consecutive_teaching_minutes // slot_minutes,
        -(-rule.consecutive_break_minutes // slot_minutes),
    )


def stretches(windows: list[tuple[int, int]], break_slots: int) -> list[tuple[int, int]]:
    """The stretches these windows of ONE day make: (first start, last end), in order.

    A window joins the stretch before it when it starts less than `break_slots`
    after the stretch's latest end; the module docstring has the definition.
    Empty windows take no time and are left out.
    """
    merged: list[tuple[int, int]] = []
    for start, end in sorted(window for window in windows if window[1] > window[0]):
        if merged and start - merged[-1][1] < break_slots:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def locked_stretches(
    windows: list[tuple[int, int]], break_slots: int, slots_per_day: int,
) -> list[tuple[int, int]]:
    """The stretches the locked windows make by themselves, day by day.

    Absolute slots count only the school's hours, so Monday's last slot is
    next to Tuesday's first and a window pair across the night would read as
    one stretch if the days were merged together.
    """
    by_day: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for window in windows:
        by_day[window[0] // slots_per_day].append(window)
    return [
        stretch
        for day in sorted(by_day)
        for stretch in stretches(by_day[day], break_slots)
    ]


def add_stretch_wish(
    model: cp_model.CpModel,
    *,
    grid: TimeGrid,
    step: int = 1,
    rule: AnonymousTeacherWorkRule,
    weeks: list[StretchWeek],
    day_of: Callable[[LessonDecision], cp_model.IntVar],
    weight: int,
) -> list[cp_model.LinearExpr]:
    """One flagged teacher's wish, once for each week they have.

    Returns the objective terms: `weight` for every generated lesson whose
    stretch is not ended in time. Nothing is built for a limit no stretch of
    the grid's day can exceed (X is a whole day or more), nor for a week with
    no generated lesson: a teacher whose whole week is hand-placed has nothing
    to pay for.
    """
    x_slots, y_slots = stretch_slots(rule, grid.slot_minutes)
    slots_per_day = grid.slots_per_day
    if x_slots >= slots_per_day or weight <= 0:
        return []
    on_step = step > 1 and x_slots % step == 0 and y_slots % step == 0
    days = len(grid.schedule_days)
    shifted_horizon = grid.horizon + days * y_slots
    terms: list[cp_model.LinearExpr] = []

    for week, members, raw_windows in weeks:
        if not members:
            continue
        # Joined where the gap is under Y: a break of Y cannot be laid in one,
        # so the merged windows keep every place a break can go.
        chains = locked_stretches(merge_windows(raw_windows, slots_per_day), y_slots, slots_per_day)
        needs = [chain for chain in chains if chain[1] - chain[0] <= x_slots]
        closed = [chain for chain in chains if chain[1] - chain[0] > x_slots]
        # Breaks go where lessons can START, the step, when that loses no break
        # (see "WHERE A BREAK MAY BEGIN" above): X and Y are whole steps and
        # no locked stretch has an edge between two steps.
        lattice = (
            cp_model.Domain.FromValues(list(range(0, shifted_horizon + 1, step)))
            if on_step and all(low % step == 0 and high % step == 0 for low, high in chains)
            else None
        )
        tag = str(rule.teacher_id)
        if week is not None:
            tag += "_odd" if week == "ODD_WEEKS" else "_even"

        # The solver's lessons on the shifted clock, and the locks beside them.
        base: list[cp_model.IntervalVar] = []
        shifted: list[tuple[LessonDecision, cp_model.IntVar]] = []
        for index, decision in enumerate(members):
            day = day_of(decision)
            start = model.NewIntVar(0, shifted_horizon, f"stretchs_{tag}_{index}")
            model.Add(start == decision.start + y_slots * day)
            base.append(
                model.NewIntervalVar(
                    start, decision.duration, start + decision.duration,
                    f"stretchl_{tag}_{index}",
                ),
            )
            shifted.append((decision, start))
        for index, (low, high) in enumerate(chains):
            offset = y_slots * (low // slots_per_day)
            base.append(
                model.NewFixedSizeIntervalVar(low + offset, high - low, f"stretchk_{tag}_{index}"),
            )

        # One optional break per generated lesson: when the lesson is kept, its
        # stretch ends by the break; when it is not, the lesson pays.
        for index, (decision, start) in enumerate(shifted):
            kept = model.NewBoolVar(f"stretchkept_{tag}_{index}")
            brk = model.NewIntVarFromDomain(
                _on(cp_model.Domain(0, shifted_horizon - y_slots), lattice), f"stretchb_{tag}_{index}",
            )
            model.Add(brk >= start + decision.duration).OnlyEnforceIf(kept)
            model.Add(brk <= start + x_slots).OnlyEnforceIf(kept)
            interval = model.NewOptionalFixedSizeIntervalVar(
                brk, y_slots, kept, f"stretchbi_{tag}_{index}",
            )
            model.AddNoOverlap([*base, interval])
            # A lesson placed against a locked stretch that is already too long
            # is part of a stretch over X, and is not kept.
            for low, high in closed:
                day_low = low // slots_per_day * slots_per_day
                forbidden = cp_model.Domain(
                    max(day_low, low - y_slots - decision.duration + 1),
                    min(day_low + slots_per_day - 1, high + y_slots - 1),
                )
                assert decision.starts is not None
                if decision.starts.intersection_with(forbidden).is_empty():
                    continue
                model.AddLinearExpressionInDomain(
                    decision.start, forbidden.complement(),
                ).OnlyEnforceIf(kept)
            terms.append(weight * (1 - kept))

        # A locked stretch within X needs its break, somewhere between its end
        # and X after its start: a generated lesson that pushes the stretch
        # past X takes the break away, and pays for it.
        for index, (low, high) in enumerate(needs):
            offset = y_slots * (low // slots_per_day)
            kept = model.NewBoolVar(f"stretchlockedkept_{tag}_{index}")
            brk = model.NewIntVarFromDomain(
                _on(cp_model.Domain(high + offset, low + offset + x_slots), lattice),
                f"stretchc_{tag}_{index}",
            )
            interval = model.NewOptionalFixedSizeIntervalVar(
                brk, y_slots, kept, f"stretchci_{tag}_{index}",
            )
            model.AddNoOverlap([*base, interval])
            terms.append(weight * (1 - kept))
    return terms


def _on(domain: cp_model.Domain, lattice: cp_model.Domain | None) -> cp_model.Domain:
    """The domain's values on the lattice; the domain itself without one."""
    return domain if lattice is None else domain.intersection_with(lattice)


def merge_windows(
    windows: list[tuple[int, int]], slots_per_day: int,
) -> list[tuple[int, int]]:
    """The windows merged where they touch or overlap, day by day, in order.

    Two locked lessons the clash check let through can overlap in time and not
    in teacher, and two constant intervals that overlap in a no-overlap would
    refuse a week for a lock the school made on purpose. Never across a
    night: Monday's last slot is next to Tuesday's first.
    """
    by_day: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for window in windows:
        if window[1] > window[0]:
            by_day[window[0] // slots_per_day].append(window)
    merged: list[tuple[int, int]] = []
    for day in sorted(by_day):
        first = len(merged)
        for start, end in sorted(by_day[day]):
            if len(merged) > first and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
    return merged


def teacher_windows(
    busy: dict[tuple[UUID, int], list[tuple[int, int]]], teacher_id: UUID,
) -> list[tuple[int, int]]:
    """Every window a teacher's locked lessons take, across the week's days."""
    return [
        window
        for (teacher, _day), windows in busy.items()
        if teacher == teacher_id
        for window in windows
    ]
