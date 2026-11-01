"""Sammanhängande undervisning: at most X minutes of teaching in a row, then Y free.

THE RULE, PER FLAGGED TEACHER. A teacher whose work rule sets
`maxConsecutiveTeachingMinutes` (X) and `consecutiveBreakMinutes` (Y) is
never to teach more than X minutes without a break of at least Y. Empty means
the rule does not apply, as on the rest of the work rule: a school that has
flagged nobody builds the model it always built, variable for variable.

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
warning, the Vikarietavla) and benchmarks/validate_schedule.py is a third that
shares no code with this one.

THE ENCODING, and why it is exact. Write a for a lesson's start and F(t) for
"no lesson of the teacher's overlaps [t, t + Y)". If a lesson starts at a, the
stretch it begins (or sits in) is at most X exactly when some F(t) holds for a
t in [a + length, a + X]: the free time is there, so the stretch ended by it.
Conversely a stretch that starts at a and ends at b <= a + X has F(b), and a
stretch that is longer has no F in the window, because the only free time in
it is shorter than Y. For a lesson that is not the first of its stretch the
condition is only weaker, so one such row per lesson, applied to all of them,
is exactly "no stretch is longer than X". No successor variables, no pair
literals and no per-slot occupancy.

F(t) IS A MOVABLE INTERVAL. Per lesson an optional break of Y slots whose start
is confined to [end, start + X] and which is in a no-overlap with the
teacher's lessons — the teacher's lunch in _add_teacher_lunch, in the same
shape, for the same reason: "a free window of Y slots exists inside this
window" is "a task of that length can be placed among these lessons", which is
what the disjunctive propagator is for. One variable per lesson of a flagged
teacher, and nothing for any other. The break's presence is the rule's
assumption literal, so a week the rule makes impossible names the rule.

THE NIGHT IS A BREAK, AND IS PAID FOR WITH A SHIFTED CLOCK. A lesson that ends
at five with X = 180 has the rest of the day, and the night, to rest in; but
the engine's slots count only the hours the school teaches, so Monday's last
slot is next to Tuesday's first. Each day is therefore pushed Y slots later
than the one before it for this rule's intervals (start + Y * day), which
leaves a gap of exactly Y between any two days: a break that ends a day fits
in it, and a lesson on Tuesday morning cannot be mistaken for the continuation
of Monday's afternoon. The shifted starts are one variable per lesson of a
flagged teacher.

THE LOCKED LESSONS ARE FACTS, as for the cap (_add_teacher_day_constraints).
They are constant intervals in every row, and they are never refused for what
they do alone: a locked stretch longer than X was warned beside the edit that
made it (master-lessons.service.ts), and refusing the week for it would turn
the warning into a block one screen later. What the rule holds is the
SOLVER'S: a stretch with a generated lesson in it is at most X. A locked
stretch that is within X still needs its break (it begins a row of its own,
below), and one that is already longer is closed to the solver's lessons —
none may start within Y of either end of it — so that no generated lesson
makes a bad stretch worse.

A/B-VECKOR. The rule is a real week's, so a teacher whose two weeks differ is
held in each, with that week's lessons and that week's locks (week_parts, the
rest rule's own reading); the literal is the rule's and is shared by both.

EVERY ROW HANGS ON THE LITERAL. A bare narrowing proves a week impossible
without touching an assumption, and the empty core that follows erases every
other cause the payload has (see _add_teacher_lunch).
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

from ortools.sat.python import cp_model

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from app.schemas.schedule import AnonymousTeacherWorkRule, WeekParity
    from app.solver.conflict_analyzer import AssumptionRegistry
    from app.solver.scheduler_solver import LessonDecision
    from app.solver.time_grid import TimeGrid

#: The code a refusal carries. The catalogue (messages.py) has its sentence.
CODE = "TEACHER_CONSECUTIVE_TEACHING_CANNOT_BE_KEPT"

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
    """The stretches of these windows of ONE day: (first start, last end), in order.

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


def add_stretch_rule(
    model: cp_model.CpModel,
    registry: AssumptionRegistry,
    *,
    grid: TimeGrid,
    lattice: cp_model.Domain | None,
    rule: AnonymousTeacherWorkRule,
    weeks: list[StretchWeek],
    day_of: Callable[[LessonDecision], cp_model.IntVar],
) -> None:
    """Post one flagged teacher's rule, once for each week they have.

    Nothing is built for a limit no stretch of the grid's day can exceed (X is
    a whole day or more), nor for a week with no lesson left to place and no
    locked stretch to break: the teacher whose whole week is hand-placed is
    refused nothing, as the lunch and the rest skip them.
    """
    x_slots, y_slots = stretch_slots(rule, grid.slot_minutes)
    slots_per_day = grid.slots_per_day
    if x_slots >= slots_per_day:
        return
    days = len(grid.schedule_days)
    shifted_horizon = grid.horizon + days * y_slots
    literal: cp_model.IntVar | None = None

    def rule_literal() -> cp_model.IntVar:
        nonlocal literal
        if literal is None:
            literal = registry.register(
                model,
                name=f"stretch_{rule.teacher_id}",
                category="TEACHER_OVERLAP",
                code=CODE,
                params={
                    "rule": str(rule.id),
                    "minutes": rule.max_consecutive_teaching_minutes or 0,
                    "breakMinutes": rule.consecutive_break_minutes or 0,
                },
                # The rule and never the teacher — see _add_teacher_lunch.
                resource_ids=[rule.id],
            )
        return literal

    def on_lattice(low: int, high: int) -> cp_model.Domain:
        domain = cp_model.Domain(low, high)
        if lattice is None:
            return domain
        return domain.intersection_with(lattice)

    for week, members, raw_windows in weeks:
        windows = merge_windows(raw_windows, slots_per_day)
        chains = locked_stretches(windows, y_slots, slots_per_day)
        needs = [chain for chain in chains if chain[1] - chain[0] <= x_slots]
        closed = [chain for chain in chains if chain[1] - chain[0] > x_slots]
        if not members and not needs:
            continue
        stretch_literal = rule_literal()
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
        for index, (low, high) in enumerate(windows):
            offset = y_slots * (low // slots_per_day)
            base.append(
                model.NewFixedSizeIntervalVar(low + offset, high - low, f"stretchk_{tag}_{index}"),
            )

        # One break per generated lesson: the lesson's stretch ends by it.
        for index, (decision, start) in enumerate(shifted):
            brk = _post_break(
                model, base, stretch_literal, y_slots, f"stretchb_{tag}_{index}",
                on_lattice(0, shifted_horizon - y_slots),
            )
            model.Add(brk >= start + decision.duration).OnlyEnforceIf(stretch_literal)
            model.Add(brk <= start + x_slots).OnlyEnforceIf(stretch_literal)

        # A locked stretch within X still needs its break, somewhere between
        # its end and X after its start.
        for index, (low, high) in enumerate(needs):
            offset = y_slots * (low // slots_per_day)
            _post_break(
                model, base, stretch_literal, y_slots, f"stretchc_{tag}_{index}",
                on_lattice(high + offset, low + offset + x_slots),
            )

        # A locked stretch already longer than X is closed to the solver's
        # lessons: none may start within Y of either end of it, on its day.
        for low, high in closed:
            day_low = low // slots_per_day * slots_per_day
            day_high = day_low + slots_per_day - 1
            for decision, _start in shifted:
                forbidden = cp_model.Domain(
                    max(day_low, low - y_slots - decision.duration + 1),
                    min(day_high, high + y_slots - 1),
                )
                assert decision.starts is not None
                if decision.starts.intersection_with(forbidden).is_empty():
                    continue
                model.AddLinearExpressionInDomain(
                    decision.start, forbidden.complement(),
                ).OnlyEnforceIf(stretch_literal)


def _post_break(
    model: cp_model.CpModel,
    base: list[cp_model.IntervalVar],
    literal: cp_model.IntVar,
    y_slots: int,
    name: str,
    domain: cp_model.Domain,
) -> cp_model.IntVar:
    """A movable break of Y slots kept clear of every lesson in `base`.

    Optional, and its presence is the rule's assumption literal. Its start is
    returned for the caller to confine, under the same literal.
    """
    start = model.NewIntVarFromDomain(domain, name)
    interval = model.NewOptionalFixedSizeIntervalVar(start, y_slots, literal, f"{name}_i")
    model.AddNoOverlap([*base, interval])
    return start


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
