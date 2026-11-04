"""The least time a year's week needs, counted with its teachers in it.

WHAT THIS ANSWERS THAT THE OTHER COUNTS CANNOT. _clique_hours_verdict and
_class_hours_verdict count a CLASS's hours against the class's own frame: a
clique of groups that share pupils, which the model never lets overlap.
Teachers are left out of those counts on purpose — it is what makes them sound
by inspection — but a week can be full for a reason that sits wholly in the
teachers.

The case this was written for (2026-11-03): three to six language groups in
each of years 7-9, the same three teachers on all of them. The groups share no
pupils with each other, so a count of cliques lets them run side by side. They
cannot — one teacher is in one room — and each group takes pupils from nearly
every class of the year, so every class must sit through the groups one after
the other: twelve occasions where four would do. The count that sees only
pupils said 80 %; the count below says 94-98 %, and CP-SAT searched twelve
hundred seconds on eight workers without finding the week.

THE BOUND. Take one node per set of lessons the model treats alike — a
timetable entry, or the part of a split entry one teacher leads — weighted with
the time its lessons occupy, and an edge between two nodes the model never lets
overlap: they share a pupil (the same pupil key, or a pair in groupConflicts)
or they share a teacher. At any instant the lessons that run form an
independent set, so the time needed is at least the weighted FRACTIONAL
CHROMATIC NUMBER: the cheapest way to cover every node for its weight with
independent sets, each given a duration. That is a linear program with one
column per independent set, solved here by column generation.

IT IS A LOWER BOUND, and every choice below leans the way that makes it lower:

* lessons may be cut into pieces (the relaxation of "a lesson is one piece");
* rooms, rasts, locked lessons, teachers' absences and the pupils' own margins
  are left out, each of which can only take more time;
* the supply is the UNION of the windows of every entry of the year, so a
  frame that closes one group's day early does not shrink the others';
* a meal is counted only for the minutes it must spend inside that supply.

THE ARITHMETIC IS EXACT. A dual vector rounded to integers is a valid
certificate for any rounding — the bound it gives is
sum(weight * dual) / (the heaviest independent set under that dual), and the
heaviest set is proved by CP-SAT (or its proven upper bound is used), so a
floating-point slip in the linear program can lower the bound but never raise
it past the truth. A week is refused only when that bound is above the supply.

COST. A cheap feasible cover (a greedy colouring) is built first, and a year
whose cover already fits under the threshold needs no linear program. The graph
and its cliques are still built for it: the school's own week (856 lessons)
takes 0.04-0.07 s in all, a dense synthetic year of up to 440 entries 0.2-0.5 s.
Column generation runs only for a year that is close,
stops the moment the answer is decided, and gives up at the deadline with the
best bound it holds — which is a bound, whatever it is. The deadline is read
by the column generation and between years; the graph and the clique cover
before it are not interrupted (2,000 entries on one teacher: 6 s).
"""
from __future__ import annotations

import math
import random
import time
from collections import defaultdict
from dataclasses import dataclass, field
from fractions import Fraction
from typing import TYPE_CHECKING
from uuid import UUID

from ortools.linear_solver import pywraplp
from ortools.sat.python import cp_model

from app.solver.frames import changeover_slots, day_windows, span_of

if TYPE_CHECKING:
    from collections.abc import Callable, Collection, Iterable, Mapping, Sequence

    from app.schemas.schedule import AnonymousRequirement, FrameTime
    from app.solver.time_grid import TimeGrid

#: Dual values are rounded to this many parts of one before the heaviest
#: independent set is proved. Large enough that the rounding cannot move the
#: bound by a minute on any week the engine accepts, small enough for CP-SAT's
#: integer objective.
_DUAL_SCALE = 1_000_000

#: A column must beat 1 by more than this to be worth adding. The linear
#: program is solved in floating point; a column that "improves" by less is
#: noise that would only slow the loop.
_IMPROVES_BY = 1e-7

#: Longest CP-SAT may spend proving one heaviest independent set. The sets are
#: small (a year is a hundred nodes) and nearly always proved in milliseconds.
_PRICING_SECONDS = 1.0

#: Teachers named in a refusal or a notice, heaviest first. A year can have a
#: dozen; the sentence is about the pattern, and a screen listing every
#: teacher of every language would bury it.
MAX_SHARED_TEACHERS_NAMED = 6


@dataclass(frozen=True)
class LunchFacts:
    """What the lunch rule asks of the week, read once by the solver.

    The solver owns who eats and on which days (the payload's groups, the
    constraints that close a day); this module only counts the minutes. Kept
    as a plain record so the two cannot disagree about "who eats": the solver
    hands over its own answer.
    """

    #: Every home class that gets a break, with the years it belongs to.
    group_spans: Mapping[UUID, tuple[int, int] | None]
    #: The lunch may start anywhere in [window_start, window_end - slots].
    window_start: int
    window_end: int
    slots: int
    #: (group, day index) pairs the school has closed; no break is owed there.
    exempt_days: Collection[tuple[UUID, int]] = frozenset()
    #: (group, day index) -> the day-local slot the school placed the meal at.
    #: A pin outranks the window (it may be after the frame closes), so a
    #: pinned meal is counted where it is and not where the window would put it.
    pins: Mapping[tuple[UUID, int], int] = field(default_factory=dict)


@dataclass(frozen=True)
class Relations:
    """How the model decides who may not overlap whom, read from the solver.

    Four readers the solver already has, passed in rather than copied: a copy
    here would be a second statement of "who shares a pupil" that could drift
    from the model's, and a bound built on a drifted rule can refuse a week
    the model solves.
    """

    #: group_conflicts as the model reads them, both directions.
    sharing: Mapping[UUID, Collection[UUID]]
    #: A requirement's key in the pupil space (pupil_key_of).
    pupil_key: Callable[[AnonymousRequirement], UUID]
    #: Who teaches lesson `index` of a requirement (_teachers_at).
    teachers_at: Callable[[AnonymousRequirement, int], Collection[UUID]]
    #: Whether an eater's meal is kept clear of the lessons filed under a
    #: class (_meal_keeps_clear_of): (eater, class) -> bool.
    meal_clear_of: Callable[[UUID, UUID], bool]
    #: The home classes the payload names (`groups`). Only a class two groups
    #: have in common makes a shared teacher matter to the pupils; see
    #: _shared_teachers.
    home_classes: Collection[UUID] = frozenset()


@dataclass(frozen=True)
class SharedTeacher:
    """One teacher who stands on groups that could otherwise run together."""

    #: The engine's own id for the teacher. Read by the timeout probe, which
    #: gives each group a teacher of its own; never put in a sentence.
    teacher_id: UUID
    requirement_ids: tuple[UUID, ...]
    #: Teaching minutes a week of those entries, margins not counted.
    minutes: int


@dataclass(frozen=True)
class StageLoad:
    """One year's least week, against what its frames offer."""

    #: The year, or None for the entries whose years are unknown.
    year: int | None
    #: The proven lower bound, in minutes, rounded UP (so "demand > capacity"
    #: in these numbers is true exactly when it is true of the real bound).
    demand_minutes: int
    capacity_minutes: int
    #: Every entry the year holds, in payload order.
    requirement_ids: tuple[UUID, ...]
    #: Every teacher that qualifies, heaviest first. A sentence names the first
    #: few (MAX_SHARED_TEACHERS_NAMED); the probe relaxes all of them.
    shared: tuple[SharedTeacher, ...] = ()
    #: True when the bound is proved above the supply (the week is impossible).
    over: bool = False

    @property
    def load(self) -> float:
        return self.demand_minutes / self.capacity_minutes if self.capacity_minutes else math.inf


@dataclass
class _Bound:
    """What column generation holds when it stops."""

    lower: Fraction
    upper: float
    converged: bool = False
    columns: int = 0
    iterations: int = 0


@dataclass
class _Graph:
    """The nodes of one year, their weights, and who may not overlap whom."""

    ids: list[object]
    weights: list[int]
    #: Bit v of adjacency[u] is set when u and v may never overlap.
    adjacency: list[int] = field(default_factory=list)
    #: Cliques that cover every edge, for the pricing model's AtMostOnes.
    cliques: list[list[int]] = field(default_factory=list)


def _ranges_union(ranges: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


@dataclass(frozen=True)
class _Piece:
    """The lessons of one requirement that one set of teachers leads."""

    requirement: AnonymousRequirement
    teachers: frozenset[UUID]
    weight: int


def _pieces_of(
    requirement: AnonymousRequirement,
    relations: Relations,
    padding: int,
    grid: TimeGrid,
) -> list[_Piece]:
    """A requirement split by who teaches each lesson.

    One piece for every requirement whose lessons all have the same teachers
    (every post nobody split), so the graph has one node per entry. A split post
    (lessonTeacherIds) gets one node per distinct set of teachers: its lessons
    share a pupil key, so those nodes are pairwise adjacent, and each is
    adjacent to the other entries of its own teachers only.
    """
    weights: dict[frozenset[UUID], int] = {}
    for index, minutes in enumerate(requirement.lesson_minutes()):
        teachers = frozenset(relations.teachers_at(requirement, index))
        weights[teachers] = weights.get(teachers, 0) + grid.minutes_to_slots(minutes) + padding
    return [_Piece(requirement, teachers, weight) for teachers, weight in weights.items()]


def week_loads(
    requirements: Sequence[AnonymousRequirement],
    frames: Sequence[FrameTime],
    grid: TimeGrid,
    relations: Relations,
    lunch: LunchFacts | None,
    *,
    threshold: float,
    deadline: float,
) -> list[StageLoad]:
    """The years whose proven least week exceeds `threshold` of their supply.

    Heaviest first. A year at or below the threshold is not returned, and
    neither is one the deadline stopped short of the threshold: what is not
    proved is not said. `deadline` is a time.monotonic() instant. `over` on a
    returned year means the bound exceeds the supply itself.
    """
    if not requirements:
        return []

    spd = grid.slots_per_day
    days = len(grid.schedule_days)
    spans = {requirement.id: span_of(requirement) for requirement in requirements}

    # Window and margin per span, once: every entry of a span has the same frames.
    windows_by_span = {span: day_windows(frames, span, grid) for span in set(spans.values())}
    changeover_by_span = {span: changeover_slots(frames, span, grid) for span in set(spans.values())}

    years: set[int | None] = set()
    for span in spans.values():
        if span is None:
            years.add(None)
        else:
            years.update(range(span[0], span[1] + 1))

    pieces_of: dict[UUID, list[_Piece]] = {
        requirement.id: _pieces_of(
            requirement, relations, changeover_by_span[spans[requirement.id]], grid,
        )
        for requirement in requirements
    }

    loads: list[StageLoad] = []
    for year in sorted(years, key=lambda y: (y is None, y or 0)):
        if time.monotonic() >= deadline:
            break
        members = [
            requirement
            for requirement in requirements
            if _in_year(spans[requirement.id], year)
        ]
        # The supply: every slot of every day at which some entry of the year
        # may have a lesson running. A padded interval may run past its
        # frame's close but not past the day (see _start_domains).
        supply_by_day: list[list[tuple[int, int]]] = []
        for day_index in range(days):
            ranges: list[tuple[int, int]] = []
            for span in {spans[member.id] for member in members}:
                window = windows_by_span[span].get(day_index)
                if window is not None:
                    ranges.append((window[0], min(window[1] + changeover_by_span[span], spd)))
            supply_by_day.append(_ranges_union(ranges))
        supply = sum(end - start for day in supply_by_day for start, end in day)
        if supply <= 0:
            continue
        # The cheapest test first: with nothing running in parallel the whole
        # weight is a cover, so a year whose weight fits under the threshold
        # is not tight. It saves the graph only for a year with little in it:
        # the classes of a year run side by side and this sum lines them up
        # one after the other, so a year of several classes passes it rarely.
        if sum(piece.weight for member in members for piece in pieces_of[member.id]) <= threshold * supply:
            continue

        graph = _stage_graph(members, pieces_of, relations, supply_by_day, lunch, year)
        bound = _stage_bound(
            graph, stop_at_or_below=threshold * supply, stop_above=supply, deadline=deadline,
        )
        if bound.lower <= threshold * supply:
            continue
        shared = _shared_teachers(members, pieces_of, relations)
        loads.append(
            StageLoad(
                year=year,
                demand_minutes=math.ceil(bound.lower) * grid.slot_minutes,
                capacity_minutes=supply * grid.slot_minutes,
                requirement_ids=tuple(member.id for member in members),
                shared=shared,
                over=bound.lower > supply,
            ),
        )
    loads.sort(key=lambda load: -load.load)
    return loads


def _inside(ranges: Iterable[tuple[int, int]], start: int, end: int) -> int:
    """Slots of [start, end) that lie in `ranges`."""
    return sum(max(0, min(stop, end) - max(begin, start)) for begin, stop in ranges)


def _in_year(span: tuple[int, int] | None, year: int | None) -> bool:
    if year is None:
        return span is None
    return span is not None and span[0] <= year <= span[1]


def _stage_graph(
    members: list[AnonymousRequirement],
    pieces_of: dict[UUID, list[_Piece]],
    relations: Relations,
    supply_by_day: list[list[tuple[int, int]]],
    lunch: LunchFacts | None,
    year: int | None,
) -> _Graph:
    pieces = [piece for member in members for piece in pieces_of[member.id]]
    ids: list[object] = [piece.requirement.id for piece in pieces]
    weights = [piece.weight for piece in pieces]
    keys = [relations.pupil_key(piece.requirement) for piece in pieces]
    sharing = relations.sharing

    adjacency = [0] * len(pieces)
    by_key: dict[UUID, list[int]] = defaultdict(list)
    by_teacher: dict[UUID, list[int]] = defaultdict(list)
    for index, piece in enumerate(pieces):
        by_key[keys[index]].append(index)
        for teacher_id in piece.teachers:
            by_teacher[teacher_id].append(index)

    def join(first: Iterable[int], second: Iterable[int]) -> None:
        second_mask = 0
        for node in second:
            second_mask |= 1 << node
        for node in first:
            adjacency[node] |= second_mask & ~(1 << node)
        first_mask = 0
        for node in first:
            first_mask |= 1 << node
        for node in second:
            adjacency[node] |= first_mask & ~(1 << node)

    for nodes in by_key.values():
        join(nodes, nodes)
    for key, nodes in by_key.items():
        for other in sharing.get(key, ()):
            if other != key and other in by_key:
                join(nodes, by_key[other])
    for nodes in by_teacher.values():
        join(nodes, nodes)

    if lunch is not None and lunch.slots > 0:
        starts = range(lunch.window_start, lunch.window_end - lunch.slots + 1)
        # The least a meal can take from this year's supply on a day, over
        # every start the window allows. A meal wholly outside the supply
        # takes none of it and is not a node at all.
        least_by_day: list[int] = []
        for ranges in supply_by_day:
            least = lunch.slots
            for start in starts:
                least = min(least, _inside(ranges, start, start + lunch.slots))
                if least == 0:
                    break
            least_by_day.append(least)
        for group_id, span in lunch.group_spans.items():
            if not _in_year(span, year):
                continue
            owed = 0
            for day_index, least in enumerate(least_by_day):
                if (group_id, day_index) in lunch.exempt_days:
                    continue
                pin = lunch.pins.get((group_id, day_index))
                owed += (
                    least if pin is None
                    else _inside(supply_by_day[day_index], pin, pin + lunch.slots)
                )
            conflicting = [
                index
                for index, piece in enumerate(pieces)
                if relations.meal_clear_of(group_id, piece.requirement.student_group_id)
            ]
            if owed <= 0 or not conflicting:
                continue
            node = len(ids)
            ids.append(("lunch", group_id))
            weights.append(owed)
            adjacency.append(0)
            join([node], conflicting)

    graph = _Graph(ids=ids, weights=weights, adjacency=adjacency)
    graph.cliques = _clique_cover(graph.adjacency)
    return graph


def _clique_cover(adjacency: Sequence[int]) -> list[list[int]]:
    """Cliques that together contain every edge, grown greedily.

    The pricing model posts one AtMostOne per clique; a clique propagates what
    its pairwise edges would take n^2 constraints to say. Every edge is in at
    least one, so the independent sets the model admits are exactly the graph's.

    Bit masks all the way down: `open_[v]` is the neighbours of v whose edge no
    clique holds yet, and the node that closes the most open edges is one AND
    and one popcount, so a clique of a hundred nodes costs a hundred steps and
    not a hundred times a hundred.
    """
    n = len(adjacency)
    open_ = list(adjacency)
    cliques: list[list[int]] = []
    for v in range(n):
        while open_[v]:
            u = (open_[v] & -open_[v]).bit_length() - 1
            members = [v, u]
            held = (1 << v) | (1 << u)
            candidates = adjacency[v] & adjacency[u]
            while candidates:
                best, best_gain = -1, -1
                scan = candidates
                while scan:
                    bit = scan & -scan
                    scan ^= bit
                    w = bit.bit_length() - 1
                    gain = (open_[w] & held).bit_count()
                    if gain > best_gain:
                        best, best_gain = w, gain
                members.append(best)
                held |= 1 << best
                candidates &= adjacency[best] & ~held
            for node in members:
                open_[node] &= ~held
            cliques.append(sorted(members))
    return cliques


def _components(adjacency: Sequence[int]) -> list[list[int]]:
    n = len(adjacency)
    seen = [False] * n
    out: list[list[int]] = []
    for start in range(n):
        if seen[start]:
            continue
        seen[start] = True
        stack, nodes = [start], []
        while stack:
            node = stack.pop()
            nodes.append(node)
            reach = adjacency[node]
            while reach:
                bit = reach & -reach
                reach ^= bit
                other = bit.bit_length() - 1
                if not seen[other]:
                    seen[other] = True
                    stack.append(other)
        out.append(sorted(nodes))
    return out


def _stage_bound(
    graph: _Graph,
    *,
    stop_at_or_below: float,
    stop_above: float,
    deadline: float,
) -> _Bound:
    """The largest bound over the graph's components: a year needs its heaviest."""
    best = _Bound(lower=Fraction(0), upper=0.0, converged=True)
    components = _components(graph.adjacency)
    # Heaviest first, so a component that decides the year is met early.
    components.sort(key=lambda nodes: -sum(graph.weights[node] for node in nodes))
    for nodes in components:
        place = {node: position for position, node in enumerate(nodes)}
        adjacency = []
        for node in nodes:
            mask = 0
            reach = graph.adjacency[node]
            while reach:
                bit = reach & -reach
                reach ^= bit
                mask |= 1 << place[bit.bit_length() - 1]
            adjacency.append(mask)
        sub = _Graph(
            ids=list(range(len(nodes))),
            weights=[graph.weights[node] for node in nodes],
            adjacency=adjacency,
            cliques=_clique_cover(adjacency),
        )
        bound = _fractional_cover(
            sub,
            stop_at_or_below=stop_at_or_below,
            stop_above=stop_above,
            deadline=deadline,
        )
        if bound.lower > best.lower:
            best.lower = bound.lower
        best.upper = max(best.upper, bound.upper)
        best.converged = best.converged and bound.converged
        best.columns += bound.columns
        best.iterations += bound.iterations
        if best.lower > stop_above:
            break
    return best


def _greedy_set(order: Sequence[int], adjacency: Sequence[int]) -> int:
    blocked = 0
    chosen = 0
    for node in order:
        bit = 1 << node
        if blocked & bit or chosen & bit:
            continue
        chosen |= bit
        blocked |= adjacency[node]
    return chosen


def _nodes_of(mask: int) -> list[int]:
    out: list[int] = []
    while mask:
        low = mask & -mask
        out.append(low.bit_length() - 1)
        mask ^= low
    return out


def _fractional_cover(
    graph: _Graph,
    *,
    stop_at_or_below: float,
    stop_above: float,
    deadline: float,
) -> _Bound:
    """Weighted fractional chromatic number of one connected piece, bounded.

    `lower` is proved (see the module docstring) and `upper` is a cover held,
    so the true value lies between them. Stops as soon as `upper` is at or
    below `stop_at_or_below` (not tight) or `lower` passes `stop_above`
    (impossible), when no column improves (converged) or at the deadline.
    """
    n = len(graph.ids)
    weights = graph.weights
    adjacency = graph.adjacency
    if n == 0:
        return _Bound(lower=Fraction(0), upper=0.0, converged=True)

    # A clique is a bound by itself: its nodes are never in one set.
    lower = Fraction(max(
        max(weights),
        max((sum(weights[node] for node in clique) for clique in graph.cliques), default=0),
    ))

    columns: dict[int, None] = {}
    residual = list(weights)
    upper = 0.0
    while any(residual):
        live = sorted((v for v in range(n) if residual[v] > 0), key=lambda v: -residual[v])
        chosen = _greedy_set(live, adjacency)
        members = _nodes_of(chosen)
        step = min(residual[v] for v in members)
        for v in members:
            residual[v] -= step
        upper += step
        columns.setdefault(chosen)
    bound = _Bound(lower=lower, upper=upper, columns=len(columns))
    if upper <= stop_at_or_below or lower > stop_above or lower >= upper:
        bound.converged = lower >= upper
        if lower >= upper:
            bound.upper = float(lower)
        return bound

    solver = pywraplp.Solver.CreateSolver("GLOP")
    rows = [solver.Constraint(weights[v], solver.infinity()) for v in range(n)]
    objective = solver.Objective()
    objective.SetMinimization()
    variables: list[pywraplp.Variable] = []

    def add_column(mask: int) -> None:
        variable = solver.NumVar(0, solver.infinity(), f"x{len(variables)}")
        for v in _nodes_of(mask):
            rows[v].SetCoefficient(variable, 1)
        objective.SetCoefficient(variable, 1)
        variables.append(variable)

    for mask in columns:
        add_column(mask)

    rng = random.Random(0)  # noqa: S311 - a search order, not a secret
    while time.monotonic() < deadline:
        bound.iterations += 1
        if solver.Solve() != pywraplp.Solver.OPTIMAL:
            break
        value = objective.Value()
        bound.upper = min(bound.upper, value)
        if bound.upper <= stop_at_or_below:
            return bound
        duals = [rows[v].dual_value() for v in range(n)]

        # Cheap pricing first: a few greedy sets under the duals.
        found: list[int] = []
        orders = [sorted(range(n), key=lambda v: -duals[v])]
        for _ in range(8):
            noisy = [duals[v] * (0.7 + 0.6 * rng.random()) for v in range(n)]
            orders.append(sorted(range(n), key=lambda v, noisy=noisy: -noisy[v]))
        for order in orders:
            mask = _greedy_set(order, adjacency)
            if mask not in columns and sum(duals[v] for v in _nodes_of(mask)) > 1 + _IMPROVES_BY:
                found.append(mask)
        if found:
            for mask in found:
                columns.setdefault(mask)
                add_column(mask)
            bound.columns = len(columns)
            continue

        # None found by hand: prove the heaviest set, which is also the bound.
        scaled = [max(0, round(duals[v] * _DUAL_SCALE)) for v in range(n)]
        proved = _heaviest_set(scaled, graph.cliques, deadline=deadline)
        if proved is None:
            break
        heaviest, mask = proved
        if heaviest <= 0:
            break
        certificate = Fraction(sum(weights[v] * scaled[v] for v in range(n)), heaviest)
        if certificate > lower:
            lower = certificate
            bound.lower = lower
            if lower > stop_above:
                return bound
        if heaviest <= _DUAL_SCALE * (1 + _IMPROVES_BY) or mask in columns or mask == 0:
            bound.converged = True
            bound.upper = max(float(lower), min(bound.upper, value))
            return bound
        columns.setdefault(mask)
        add_column(mask)
        bound.columns = len(columns)
    return bound


def _heaviest_set(
    scaled: Sequence[int], cliques: Sequence[Sequence[int]], *, deadline: float,
) -> tuple[int, int] | None:
    """(an upper bound on the heaviest independent set, a set reaching its best).

    The first number is PROVED: CP-SAT's optimum when it finishes, its
    best-objective bound when it does not. Either is at least the true
    maximum, which is all the certificate needs. None when CP-SAT found no set
    at all (out of time before one): there is then no bound to claim.
    """
    model = cp_model.CpModel()
    chosen = [model.NewBoolVar(f"z{v}") for v in range(len(scaled))]
    for clique in cliques:
        if len(clique) > 1:
            model.AddAtMostOne(chosen[v] for v in clique)
    model.Maximize(sum(scaled[v] * chosen[v] for v in range(len(scaled))))
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.max_time_in_seconds = max(
        0.05, min(_PRICING_SECONDS, deadline - time.monotonic()),
    )
    status = solver.Solve(model)
    if status == cp_model.OPTIMAL:
        bound = round(solver.ObjectiveValue())
    elif status == cp_model.FEASIBLE:
        bound = math.ceil(solver.BestObjectiveBound() - 1e-6)
    else:
        return None
    mask = 0
    for v, variable in enumerate(chosen):
        if solver.Value(variable):
            mask |= 1 << v
    return bound, mask


def _shared_teachers(
    members: list[AnonymousRequirement],
    pieces_of: dict[UUID, list[_Piece]],
    relations: Relations,
) -> tuple[SharedTeacher, ...]:
    """Teachers whose groups would run side by side if they were not one person.

    Two entries of one teacher QUALIFY when they share no pupil with each other
    but both take pupils from the same HOME CLASS: that class has to sit through
    them one after the other only because their teacher is shared. That is the
    language-choice pattern. Two classes' mathematics under one teacher do not
    qualify — they have no home class in common — and a teacher is not named
    for teaching them, which every teacher in every school does. (Not "a group
    both share pupils with": the language groups take pupils from every class,
    so any two classes would then have one in common.)

    A payload that names no home classes names no shared teacher; the bound
    stands without them.
    """
    sharing = relations.sharing
    homes = set(relations.home_classes)
    by_teacher: dict[UUID, dict[UUID, AnonymousRequirement]] = defaultdict(dict)
    for member in members:
        for piece in pieces_of[member.id]:
            for teacher_id in piece.teachers:
                by_teacher[teacher_id].setdefault(member.id, member)

    found: list[SharedTeacher] = []
    for teacher_id, entries in by_teacher.items():
        rows = list(entries.values())
        qualifying: dict[UUID, AnonymousRequirement] = {}
        for position, first in enumerate(rows):
            a = relations.pupil_key(first)
            for second in rows[position + 1:]:
                b = relations.pupil_key(second)
                if a == b or b in sharing.get(a, ()):
                    continue
                if homes.intersection(sharing.get(a, ())).intersection(sharing.get(b, ())):
                    qualifying.setdefault(first.id, first)
                    qualifying.setdefault(second.id, second)
        if len({relations.pupil_key(entry) for entry in qualifying.values()}) < 2:
            continue
        found.append(
            SharedTeacher(
                teacher_id=teacher_id,
                requirement_ids=tuple(entry.id for entry in qualifying.values()),
                # Only the lessons this teacher leads: an entry a post splits
                # between teachers (lessonTeacherIds) counts here for the part
                # that is theirs, not for the whole entry.
                minutes=sum(
                    minutes
                    for entry in qualifying.values()
                    for index, minutes in enumerate(entry.lesson_minutes())
                    if teacher_id in relations.teachers_at(entry, index)
                ),
            ),
        )
    found.sort(key=lambda teacher: (-teacher.minutes, str(teacher.requirement_ids[0])))
    return tuple(found)
