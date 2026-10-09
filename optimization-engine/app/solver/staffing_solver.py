"""Staffing proposal: who leads each curriculum entry, solved.

WHY THIS EXISTS. A tjänstefördelning is settled before any timetable: every
row of the timplan needs a lead, and every teacher has a target the rows
should land near. Skola24 leaves the whole matrix to the admin; Untis proposes
one heuristically. This is a CP-SAT model over x[teacher, row], separate from
the generator in every way — its own request, its own route, its own model —
because it answers a question the generator never asks and must never change
the generator's answers.

WHAT MAKES IT SAFE TO PRESS. Keeping every row as it is and leaving the open
ones open satisfies every rule here, by construction (asserted in Python
before every solve). So the proposal never INFEASIBLEs, and it never asks for
something the write-time checks would refuse for load or turn a staffed row
into an unstaffed one:

* A row whose current lead is sent is KEPT: its lead is always in its domain
  whatever their target, qualification or room, and it has no unstaffed
  slack. Only OPEN rows (no lead, or one who has left) may end unstaffed.
* A teacher with a target above zero whose current load fits under the limit
  is NORMAL: a candidate for any row, held to the limit. Every other teacher
  — no target, a target of zero, or already over the limit — is KEEP-OR-SHED:
  they may keep or lose their own rows and are given nothing new, so their
  load after is a subset of their load before and never grows. This mirrors
  the gateway's enforcement exactly, which only refuses NEW placements and
  GROWING loads (overTargetFinding, judgeRequirementWrite).

TWO STAGES, NOT ONE WEIGHTED SUM. Stage 1 minimises what stays unstaffed,
alone — the number of rows first, then their lesson minutes between answers
leaving equally many; stage 2 minimises everything else under "no worse
than stage 1 found". A big-M weight on unstaffed rows in one objective could
not even find the right unstaffed count inside 10 s on the prototype (60
teachers, 400 rows), and a weight would let a school trade a staffed row for
balance. Two stages also make `unstaffed_proven` a claim the dialog can
state: when stage 1 is OPTIMAL, no proposal staffs more rows.

ONE ANSWER PER SCHOOL WHEN PROVEN. A school has many equally good proposals,
and the parallel portfolio returns whichever its fastest worker found. When
both stages are proven, a third solve picks the unique optimum of a fixed
tie-break among them (StaffingSolver._canonical), so OPTIMAL means the same
proposal on every press. A time-limited answer is FEASIBLE and may differ.

WHAT IT NEVER DOES: decide a co-teacher, split a row, change a load percent,
look at time (availability, work rules, overlaps — that is the generator's),
or read a name. See app/schemas/staffing.py for what crosses the wire.
"""

from __future__ import annotations

import logging
import math
import time
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.schemas.staffing import (
    AnonymousStaffRequirement,
    AnonymousStaffTeacher,
    StaffAssignment,
    StaffConflict,
    StaffRequest,
    StaffResponse,
    StaffTerms,
    StaffTermsComparison,
    StaffUnstaffed,
    StaffWeights,
)
from app.solver.scheduler_solver import _grade_span_text

logger = logging.getLogger(__name__)

#: CP-SAT's parallel portfolio. Measured on the 60×400 prototype on an 8-core
#: Mac: the portfolio proves stage 1 in 0.2–1.5 s and lands stage 2 within
#: 1–5 % of its bound, while the deterministic modes (one worker, interleaved
#: search, LNS only) were 25–90 % worse on stage 2 at the same time. The price
#: is that an answer cut at the time limit can differ between two presses. A
#: proven one is made not to: see the canonical pass in StaffingSolver._search.
STAFF_WORKERS = 8

#: The canonical pass's tie-break weights lie in 1..2**TIE_BREAK_BITS. Wide
#: enough that two different proposals of equal P and S summing to the same
#: tie-break is a coincidence of 20-bit numbers, narrow enough that the
#: objective stays far inside int64 and CP-SAT's LP relaxation.
TIE_BREAK_BITS = 20
_MASK64 = (1 << 64) - 1

#: The largest model this module builds, in CP-SAT variables — the room
#: optimiser's and the generator's budget, for the same reason: the time limit
#: bounds Solve() and nothing before it.
MAX_MODEL_VARIABLES = 1_000_000

#: One count in the secondary objective weighs this many TENTHS of a minute of
#: imbalance: sixty minutes. So a weight of 2 on new teachers in a class makes
#: one such teacher worth 120 minutes of distance from a target at balance 1.
COUNT_SCALE = 600

#: Stage 1's share of the time limit, and its ceiling. It is the cheaper
#: stage — the prototype proved it in under 1.5 s — and whatever it does not
#: use passes to stage 2.
STAGE1_SHARE = 0.4
STAGE1_MAX_SECONDS = 4.0

#: Below this much time left, stage 2 is not started: CP-SAT's own start-up
#: would eat it.
MIN_STAGE_SECONDS = 0.05

#: Kept back from stage 2 for what follows it — reading the answer, the
#: Python re-check, the reasons and the response — so the whole request,
#: not just the search, ends inside the time limit. Measured at 60×400 that
#: tail is a few hundredths of a second; the rest is margin for a loaded host.
AFTER_SEARCH_SECONDS = 0.25


def _tenths_to_minutes_ceil(tenths: int) -> int:
    return -(-tenths // 10)


def _tie_break_weight(row: int, teacher: int) -> int:
    """A fixed pseudo-random weight in 1..2**TIE_BREAK_BITS for x[row, teacher].

    A function of payload POSITIONS (splitmix64), never of uuids or Python's
    hash: the gateway sends canonical order with fresh uuids, so the same
    school gets the same weights on every press and on every host.
    """
    z = (row * 0x9E3779B97F4A7C15 + teacher * 0xBF58476D1CE4E5B9 + 0x94D049BB133111EB) & _MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK64
    z ^= z >> 31
    return 1 + (z & ((1 << TIE_BREAK_BITS) - 1))


def _row_unit(problem: StaffProblem) -> int:
    """What one unstaffed row costs in stage 1: more than every open row's
    lesson minutes together, so the row count decides first and the minutes
    only between answers leaving equally many rows. A row of zero minutes is
    still a row nobody leads."""
    return sum(problem.rows[row].lesson_minutes for row in problem.open) + 1


def _grades_param(row: AnonymousStaffRequirement) -> str:
    """The `grades` value STAFF_* sentences select on: "7", "7–9" or "any"."""
    return _grade_span_text(row.min_grade_level, row.max_grade_level) or "any"


# ---------------------------------------------------------------------------
# The problem, as indices.
# ---------------------------------------------------------------------------


@dataclass
class StaffProblem:
    """The request, with every id turned into a payload position.

    Positions, never uuids, are what everything below iterates and orders by:
    the gateway mints fresh uuids for every request, so anything sorted by
    one would be ordered at random, and the model (and its answer) would
    differ between two presses on the same school.
    """

    request: StaffRequest
    teachers: list[AnonymousStaffTeacher]
    rows: list[AnonymousStaffRequirement]
    weights: StaffWeights
    respect: bool
    recorded: bool
    #: Free rows (not fixed), payload order, and their two kinds.
    free: list[int]
    open: list[int]
    kept: list[int]
    #: Row → its current lead, for kept rows only.
    current: dict[int, int]
    #: Row → its co-teacher, when sent.
    co: dict[int, int]
    #: Row → its eligibility set (teacher positions), empty when it has none.
    eligible: list[frozenset[int]]
    last_year: list[frozenset[int]]
    #: Row → its class, as a position in order of first appearance.
    group: list[int]
    #: Class → teachers already in it through a fixed row's lead or any
    #: row's co-teacher. Those cost no "new teacher in the class".
    present: dict[int, frozenset[int]]
    #: Per teacher: fixed + the kept rows they lead today, in tenths.
    current_load: list[int]
    #: NORMAL teachers (candidates for any row, held to their limit); the
    #: rest are KEEP-OR-SHED.
    normal: list[bool]
    #: limit − fixed for a normal teacher, 0 otherwise.
    cap: list[int]
    #: Row → the teachers who may lead it, in payload order. Filled by
    #: build_domains once the size guard has passed.
    domain: dict[int, tuple[int, ...]] = field(default_factory=dict)
    #: Open rows whose last-year teacher is in their domain: only these carry
    #: the continuity term. Filled with the domains.
    continuity: frozenset[int] = frozenset()

    def target_above_zero(self, teacher: int) -> bool:
        target = self.teachers[teacher].target_tenths
        return target is not None and target > 0

    def qualified_pool(self, row: int) -> list[int]:
        """Teachers not excluded from `row` by qualification or by being its
        co-teacher — whatever their target or room."""
        co = self.co.get(row)
        if self.respect:
            return sorted(t for t in self.eligible[row] if t != co)
        return [t for t in range(len(self.teachers)) if t != co]


def prepare(request: StaffRequest) -> StaffProblem:
    teachers = list(request.teachers)
    rows = list(request.requirements)
    teacher_index = {teacher.id: index for index, teacher in enumerate(teachers)}
    sets = {
        entry.id: frozenset(teacher_index[teacher] for teacher in entry.teacher_ids)
        for entry in request.eligibility_sets
    }
    group_index: dict[UUID, int] = {}
    group: list[int] = []
    for row in rows:
        group.append(group_index.setdefault(row.student_group_id, len(group_index)))

    free: list[int] = []
    open_rows: list[int] = []
    kept: list[int] = []
    current: dict[int, int] = {}
    co: dict[int, int] = {}
    present: dict[int, set[int]] = defaultdict(set)
    current_load = [teacher.fixed_tenths for teacher in teachers]
    for index, row in enumerate(rows):
        if row.co_teacher_id is not None:
            co[index] = teacher_index[row.co_teacher_id]
            present[group[index]].add(co[index])
        lead = teacher_index[row.current_teacher_id] if row.current_teacher_id else None
        if row.fixed:
            if lead is not None:
                present[group[index]].add(lead)
            continue
        free.append(index)
        if lead is None:
            open_rows.append(index)
        else:
            kept.append(index)
            current[index] = lead
            current_load[lead] += row.charge_tenths

    normal: list[bool] = []
    cap: list[int] = []
    for index, teacher in enumerate(teachers):
        is_normal = (
            teacher.target_tenths is not None
            and teacher.target_tenths > 0
            and teacher.limit_tenths is not None
            and current_load[index] <= teacher.limit_tenths
        )
        normal.append(is_normal)
        cap.append(teacher.limit_tenths - teacher.fixed_tenths if is_normal else 0)  # type: ignore[operator]

    return StaffProblem(
        request=request,
        teachers=teachers,
        rows=rows,
        weights=request.weights,
        respect=request.respect_qualifications,
        recorded=request.qualifications_recorded,
        free=free,
        open=open_rows,
        kept=kept,
        current=current,
        co=co,
        eligible=[
            sets[row.eligibility_set_id] if row.eligibility_set_id is not None else frozenset()
            for row in rows
        ],
        last_year=[
            frozenset(teacher_index[teacher] for teacher in row.last_year_teacher_ids)
            for row in rows
        ],
        group=group,
        present={key: frozenset(value) for key, value in present.items()},
        current_load=current_load,
        normal=normal,
        cap=cap,
    )


class _ByCap:
    """Normal teachers ordered by room, so "who has room for c" is a suffix.

    Without it, the size guard and the domains walk every teacher for every
    row — five million steps at the wire's upper range, before the guard has
    had a chance to refuse.
    """

    def __init__(self, problem: StaffProblem, members: Sequence[int]) -> None:
        ordered = sorted((problem.cap[t], t) for t in members if problem.normal[t])
        self.caps = [cap for cap, _t in ordered]
        self.teachers = [t for _cap, t in ordered]

    def with_room(self, charge: int) -> list[int]:
        return self.teachers[bisect_left(self.caps, charge):]

    def count_with_room(self, charge: int) -> int:
        return len(self.caps) - bisect_left(self.caps, charge)


def _pools(problem: StaffProblem) -> list[_ByCap]:
    """Per free row, the normal teachers its qualification rule admits."""
    everybody = _ByCap(problem, range(len(problem.teachers)))
    by_set: dict[frozenset[int], _ByCap] = {}
    pools: list[_ByCap] = []
    for row in range(len(problem.rows)):
        if not problem.respect:
            pools.append(everybody)
            continue
        members = problem.eligible[row]
        if members not in by_set:
            by_set[members] = _ByCap(problem, sorted(members))
        pools.append(by_set[members])
    return pools


def _in_pool_with_room(problem: StaffProblem, row: int, teacher: int) -> bool:
    """Whether `teacher` is among the row's pool's normal teachers with room —
    what _ByCap.with_room returns — co-teacher or not."""
    if not problem.normal[teacher]:
        return False
    if problem.respect and teacher not in problem.eligible[row]:
        return False
    return problem.rows[row].charge_tenths <= problem.cap[teacher]


def candidate_counts(problem: StaffProblem) -> dict[int, int]:
    """|E_r| for every free row, counted without building a single domain."""
    pools = _pools(problem)
    counts: dict[int, int] = {}
    for row in problem.free:
        count = pools[row].count_with_room(problem.rows[row].charge_tenths)
        co = problem.co.get(row)
        if co is not None and _in_pool_with_room(problem, row, co):
            count -= 1
        lead = problem.current.get(row)
        if lead is not None and not _in_pool_with_room(problem, row, lead):
            count += 1  # a kept row's lead is in its domain whatever else holds
        counts[row] = count
    return counts


def estimate_model_size(problem: StaffProblem) -> int:
    """Σ|E_r| + an upper bound on the class variables + the teachers, before
    a single domain is built."""
    per_group: dict[int, int] = defaultdict(int)
    total = 0
    for row, count in candidate_counts(problem).items():
        total += count
        per_group[problem.group[row]] += count
    classes = sum(min(len(problem.teachers), count) for count in per_group.values())
    return total + classes + len(problem.teachers)


def build_domains(problem: StaffProblem) -> None:
    """E_r: the normal teachers with room who may take the row, plus — for a
    kept row — its current lead, always."""
    pools = _pools(problem)
    for row in problem.free:
        charge = problem.rows[row].charge_tenths
        co = problem.co.get(row)
        candidates = {t for t in pools[row].with_room(charge) if t != co}
        lead = problem.current.get(row)
        if lead is not None:
            candidates.add(lead)
        problem.domain[row] = tuple(sorted(candidates))
    # A kept row's lead was chosen this year — the Fas 5 roll already carried
    # last year's onto it, and an admin who has changed it since did so on
    # purpose — so continuity is weighed on open rows only.
    problem.continuity = frozenset(
        row for row in problem.open if problem.last_year[row] & set(problem.domain[row])
    )


# ---------------------------------------------------------------------------
# An answer, judged in plain Python.
# ---------------------------------------------------------------------------

#: Row position → the teacher position leading it, or None. Only free rows
#: are ever read.
Assignment = list[int | None]


def status_quo(problem: StaffProblem) -> Assignment:
    """Every kept row with its lead, every open row unstaffed."""
    answer: Assignment = [None] * len(problem.rows)
    for row, lead in problem.current.items():
        answer[row] = lead
    return answer


def check(problem: StaffProblem, answer: Assignment) -> None:
    """Every hard rule, from first principles rather than from the domains.

    Run on the status quo before the solve (a failure there is a model built
    wrong, never the school's data) and on every answer after it, so a model
    bug reaches a log as a 500 instead of a school as a proposal.
    """
    load = [teacher.fixed_tenths for teacher in problem.teachers]
    for row in problem.free:
        teacher = answer[row]
        lead = problem.current.get(row)
        if teacher is None:
            if lead is not None:
                msg = f"The staffing model left kept row {row} unstaffed."
                raise SolverBuildError(msg)
            continue
        if teacher == problem.co.get(row):
            msg = f"The staffing model made row {row}'s co-teacher its lead."
            raise SolverBuildError(msg)
        if teacher != lead:
            if not problem.normal[teacher]:
                msg = f"The staffing model gave keep-or-shed teacher {teacher} row {row}."
                raise SolverBuildError(msg)
            if problem.respect and teacher not in problem.eligible[row]:
                msg = f"The staffing model gave row {row} to an unqualified teacher."
                raise SolverBuildError(msg)
        load[teacher] += problem.rows[row].charge_tenths
    for teacher, total in enumerate(load):
        limit = problem.teachers[teacher].limit_tenths
        if problem.normal[teacher] and limit is not None and total > limit:
            msg = f"The staffing model put teacher {teacher} over their limit."
            raise SolverBuildError(msg)


@dataclass(frozen=True)
class Score:
    """The objective's parts for one answer. `primary` is stage 1's P."""

    primary: int
    unstaffed_rows: int
    unstaffed_minutes: int
    deviation: int
    under_band: int
    new_class_teachers: int
    continuity: int
    current_changes: int
    unqualified: int
    secondary: int

    def key(self) -> tuple[int, int]:
        return self.primary, self.secondary

    def terms(self) -> StaffTerms:
        return StaffTerms(
            unstaffed_rows=self.unstaffed_rows,
            unstaffed_minutes=self.unstaffed_minutes,
            deviation_tenths=self.deviation,
            under_band_tenths=self.under_band,
            new_class_teachers=self.new_class_teachers,
            continuity_changes=self.continuity,
            current_changes=self.current_changes,
            unqualified_assignments=self.unqualified,
        )


def _unqualified(problem: StaffProblem, row: int, teacher: int) -> bool:
    """Whether leading `row` costs the `unqualified` weight.

    A NEW placement outside the row's set always does (under respect there are
    none). Keeping the current lead does only when qualifications are
    recorded: with nothing recorded the set is "who teaches the subject", and
    a teacher already leading the row plainly does.
    """
    if teacher in problem.eligible[row]:
        return False
    if teacher == problem.current.get(row):
        return problem.recorded
    return True


def evaluate(problem: StaffProblem, answer: Assignment) -> Score:
    weights = problem.weights
    unit = _row_unit(problem)
    load = [teacher.fixed_tenths for teacher in problem.teachers]
    primary = unstaffed_rows = unstaffed_minutes = 0
    continuity = current_changes = unqualified = 0
    in_class: dict[int, set[int]] = defaultdict(set)
    for row in problem.free:
        teacher = answer[row]
        spec = problem.rows[row]
        if teacher is None:
            primary += unit + spec.lesson_minutes
            unstaffed_rows += 1
            unstaffed_minutes += spec.lesson_minutes
            continue
        load[teacher] += spec.charge_tenths
        if teacher not in problem.present.get(problem.group[row], frozenset()):
            in_class[problem.group[row]].add(teacher)
        if row in problem.continuity and teacher not in problem.last_year[row]:
            continuity += 1
        lead = problem.current.get(row)
        if lead is not None and teacher != lead:
            current_changes += 1
        if _unqualified(problem, row, teacher):
            unqualified += 1
    deviation = under_band = 0
    for index, teacher in enumerate(problem.teachers):
        if teacher.target_tenths is None or teacher.floor_tenths is None:
            continue
        deviation += abs(load[index] - teacher.target_tenths)
        under_band += max(0, teacher.floor_tenths - load[index])
    new_class_teachers = sum(len(members) for members in in_class.values())
    secondary = weights.balance * (deviation + under_band) + COUNT_SCALE * (
        weights.class_teachers * new_class_teachers
        + weights.continuity * continuity
        + weights.keep_current * current_changes
        + weights.unqualified * unqualified
    )
    return Score(
        primary=primary,
        unstaffed_rows=unstaffed_rows,
        unstaffed_minutes=unstaffed_minutes,
        deviation=deviation,
        under_band=under_band,
        new_class_teachers=new_class_teachers,
        continuity=continuity,
        current_changes=current_changes,
        unqualified=unqualified,
        secondary=secondary,
    )


# ---------------------------------------------------------------------------
# The greedy: the hint, the search order, and the answer of last resort.
# ---------------------------------------------------------------------------


@dataclass
class Greedy:
    answer: Assignment
    #: (row, teacher) pairs in the order the greedy would try them — the
    #: decision strategy handed to CP-SAT.
    order: list[tuple[int, int]]


def greedy(problem: StaffProblem) -> Greedy:
    """Hardest-to-staff subject first, the cheapest teacher that still fits.

    Starts from the status quo and only fills open rows. Subjects are taken
    by scarcity — demanded minutes over the room of the teachers who may take
    them, an unstaffable subject first — and within one, the row with the
    fewest candidates, then the largest, then payload order. Each row goes to
    last year's teacher, else one already in the class, else one inside the
    row's set, else the one with the most room, else the first in the payload.
    """
    answer = status_quo(problem)
    remaining = list(problem.cap)
    for row, lead in problem.current.items():
        if problem.normal[lead]:
            remaining[lead] -= problem.rows[row].charge_tenths
    in_class: dict[int, set[int]] = defaultdict(set)
    for group, members in problem.present.items():
        in_class[group] |= members
    for row, lead in problem.current.items():
        in_class[problem.group[row]].add(lead)

    by_subject: dict[UUID, list[int]] = {}
    for row in problem.open:
        if problem.domain[row]:
            by_subject.setdefault(problem.rows[row].subject_id, []).append(row)

    def scarcity(item: tuple[int, tuple[UUID, list[int]]]) -> tuple[float, int]:
        position, (_subject, rows) = item
        demand = sum(problem.rows[row].charge_tenths for row in rows)
        teachers = {t for row in rows for t in problem.domain[row]}
        available = sum(max(0, remaining[t]) for t in teachers)
        ratio = math.inf if available == 0 else demand / available
        return -ratio, position

    subjects = sorted(enumerate(by_subject.items()), key=scarcity)

    def preference(row: int, teacher: int) -> tuple[bool, bool, bool, int, int]:
        return (
            teacher not in problem.last_year[row],
            teacher not in in_class[problem.group[row]],
            teacher not in problem.eligible[row],
            -remaining[teacher],
            teacher,
        )

    order: list[tuple[int, int]] = []
    for _position, (_subject, rows) in subjects:
        rows_in_order = sorted(
            rows, key=lambda row: (len(problem.domain[row]), -problem.rows[row].charge_tenths, row),
        )
        for row in rows_in_order:
            ranked = sorted(problem.domain[row], key=lambda t, row=row: preference(row, t))
            order.extend((row, t) for t in ranked)
            charge = problem.rows[row].charge_tenths
            for teacher in ranked:
                if remaining[teacher] >= charge:
                    answer[row] = teacher
                    remaining[teacher] -= charge
                    in_class[problem.group[row]].add(teacher)
                    break
    for row in problem.kept:
        lead = problem.current[row]
        order.append((row, lead))
        order.extend((row, t) for t in problem.domain[row] if t != lead)
    return Greedy(answer=answer, order=order)


# ---------------------------------------------------------------------------
# The model.
# ---------------------------------------------------------------------------


@dataclass
class StaffModel:
    model: cp_model.CpModel
    x: dict[tuple[int, int], cp_model.IntVar]
    u: dict[int, cp_model.IntVar]
    y: dict[tuple[int, int], cp_model.IntVar]
    d: dict[int, cp_model.IntVar]
    e: dict[int, cp_model.IntVar]
    primary: cp_model.LinearExprT
    secondary: cp_model.LinearExprT


def build_model(problem: StaffProblem, order: list[tuple[int, int]]) -> StaffModel:
    """The two objectives over one set of constraints.

    Built in payload order only — rows, then each row's candidates by teacher
    position — so two builds of one request are byte-identical, and so are
    two requests that differ only in their fresh uuids.
    """
    weights = problem.weights
    model = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    u: dict[int, cp_model.IntVar] = {}
    y: dict[tuple[int, int], cp_model.IntVar] = {}
    d: dict[int, cp_model.IntVar] = {}
    e: dict[int, cp_model.IntVar] = {}
    by_teacher: dict[int, list[tuple[cp_model.IntVar, int]]] = defaultdict(list)
    open_rows = set(problem.open)
    unit = _row_unit(problem)

    primary_vars: list[cp_model.IntVar] = []
    primary_coeffs: list[int] = []
    secondary_vars: list[cp_model.IntVar] = []
    secondary_coeffs: list[int] = []
    constant = 0

    for row in problem.free:
        spec = problem.rows[row]
        literals = []
        for teacher in problem.domain[row]:
            literal = model.NewBoolVar(f"x{row}_{teacher}")
            x[row, teacher] = literal
            literals.append(literal)
            by_teacher[teacher].append((literal, spec.charge_tenths))
        if row in open_rows:
            slack = model.NewBoolVar(f"u{row}")
            u[row] = slack
            model.AddExactlyOne([slack, *literals])
            primary_vars.append(slack)
            primary_coeffs.append(unit + spec.lesson_minutes)
        else:
            model.AddExactlyOne(literals)

        group = problem.group[row]
        present = problem.present.get(group, frozenset())
        lead = problem.current.get(row)
        for teacher in problem.domain[row]:
            literal = x[row, teacher]
            if teacher not in present:
                if (group, teacher) not in y:
                    y[group, teacher] = model.NewBoolVar(f"y{group}_{teacher}")
                    secondary_vars.append(y[group, teacher])
                    secondary_coeffs.append(COUNT_SCALE * weights.class_teachers)
                model.AddImplication(literal, y[group, teacher])
            if row in problem.continuity and teacher not in problem.last_year[row]:
                secondary_vars.append(literal)
                secondary_coeffs.append(COUNT_SCALE * weights.continuity)
            if _unqualified(problem, row, teacher):
                secondary_vars.append(literal)
                secondary_coeffs.append(COUNT_SCALE * weights.unqualified)
            if lead is not None and teacher == lead:
                # keepCurrent·(1 − x[cur, r])
                constant += COUNT_SCALE * weights.keep_current
                secondary_vars.append(literal)
                secondary_coeffs.append(-COUNT_SCALE * weights.keep_current)

    for teacher, terms in by_teacher.items():
        spec = problem.teachers[teacher]
        charged = cp_model.LinearExpr.WeightedSum(
            [literal for literal, _c in terms], [charge for _l, charge in terms],
        )
        if problem.normal[teacher]:
            model.Add(charged <= problem.cap[teacher])
        if spec.target_tenths is None or spec.floor_tenths is None:
            continue
        low = spec.fixed_tenths
        high = spec.fixed_tenths + sum(charge for _l, charge in terms)
        target = spec.target_tenths
        distance = model.NewIntVar(0, max(abs(low - target), abs(high - target)), f"d{teacher}")
        model.Add(distance >= spec.fixed_tenths + charged - target)
        model.Add(distance >= target - spec.fixed_tenths - charged)
        d[teacher] = distance
        secondary_vars.append(distance)
        secondary_coeffs.append(weights.balance)
        if spec.floor_tenths > low:
            below = model.NewIntVar(0, spec.floor_tenths - low, f"e{teacher}")
            model.Add(below >= spec.floor_tenths - spec.fixed_tenths - charged)
            e[teacher] = below
            secondary_vars.append(below)
            secondary_coeffs.append(weights.balance)

    # A teacher with a target and no variable still has a distance from it,
    # constant whatever the answer. Kept in, so the model's S is evaluate()'s
    # S exactly: the canonical pass fixes S at the optimum's own value, and an
    # S short by a constant would admit a worse answer there.
    for teacher, spec in enumerate(problem.teachers):
        if teacher in by_teacher or spec.target_tenths is None or spec.floor_tenths is None:
            continue
        constant += weights.balance * (
            abs(spec.fixed_tenths - spec.target_tenths)
            + max(0, spec.floor_tenths - spec.fixed_tenths)
        )

    model.AddDecisionStrategy(
        [x[pair] for pair in order], cp_model.CHOOSE_FIRST, cp_model.SELECT_MAX_VALUE,
    )
    return StaffModel(
        model=model,
        x=x,
        u=u,
        y=y,
        d=d,
        e=e,
        primary=cp_model.LinearExpr.WeightedSum(primary_vars, primary_coeffs),
        secondary=cp_model.LinearExpr.WeightedSum(secondary_vars, secondary_coeffs) + constant,
    )


def _hint(problem: StaffProblem, built: StaffModel, answer: Assignment) -> None:
    """A complete hint: every variable, at the value the answer implies."""
    built.model.ClearHints()
    load = [teacher.fixed_tenths for teacher in problem.teachers]
    in_class: set[tuple[int, int]] = set()
    for row in problem.free:
        teacher = answer[row]
        if row in built.u:
            built.model.AddHint(built.u[row], teacher is None)
        for candidate in problem.domain[row]:
            built.model.AddHint(built.x[row, candidate], candidate == teacher)
        if teacher is not None:
            load[teacher] += problem.rows[row].charge_tenths
            in_class.add((problem.group[row], teacher))
    for key, literal in built.y.items():
        built.model.AddHint(literal, key in in_class)
    for teacher, distance in built.d.items():
        built.model.AddHint(distance, abs(load[teacher] - problem.teachers[teacher].target_tenths))  # type: ignore[operator]
    for teacher, below in built.e.items():
        built.model.AddHint(below, max(0, problem.teachers[teacher].floor_tenths - load[teacher]))  # type: ignore[operator]


def _read(problem: StaffProblem, built: StaffModel, solver: cp_model.CpSolver) -> Assignment:
    answer: Assignment = [None] * len(problem.rows)
    for (row, teacher), literal in built.x.items():
        if solver.Value(literal):
            if answer[row] is not None:
                msg = f"The staffing model gave row {row} two leads."
                raise SolverBuildError(msg)
            answer[row] = teacher
    return answer


# ---------------------------------------------------------------------------
# Verdicts: what the arithmetic says before any model is built.
# ---------------------------------------------------------------------------


def _normal_pools(problem: StaffProblem) -> list[frozenset[int]]:
    """Per row, the NORMAL teachers its qualification rule admits, whatever
    their room — one frozenset per distinct set, shared, never per row."""
    everybody = frozenset(t for t in range(len(problem.teachers)) if problem.normal[t])
    by_set: dict[frozenset[int], frozenset[int]] = {}
    pools: list[frozenset[int]] = []
    for row in range(len(problem.rows)):
        if not problem.respect:
            pools.append(everybody)
            continue
        members = problem.eligible[row]
        if members not in by_set:
            by_set[members] = frozenset(t for t in members if problem.normal[t])
        pools.append(by_set[members])
    return pools


def verdicts(problem: StaffProblem) -> list[StaffConflict]:
    """The three conflict lines, in payload order of their first row/teacher.

    Each is a fact about the school's numbers, true whatever the search does;
    none names a person. A teacher appears only as an opaque id in
    teacher_ids, for the gateway to map back in its own field.
    """
    conflicts: list[StaffConflict] = []
    pools = _normal_pools(problem)

    # STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT: per (subject, grades), the
    # open rows nobody holds a covering qualification for — the co-teacher
    # included, so the sentence "no active teacher holds one" stays true. A
    # row only its co-teacher qualifies for gets the row reason, not a line.
    if problem.recorded and problem.respect:
        nobody: dict[tuple[UUID, str], list[int]] = {}
        for row in problem.open:
            if not problem.eligible[row]:
                spec = problem.rows[row]
                nobody.setdefault((spec.subject_id, _grades_param(spec)), []).append(row)
        for (subject, grades), rows in nobody.items():
            conflicts.append(StaffConflict(
                code="STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT",
                params={"subject": str(subject), "grades": grades, "count": len(rows)},
                requirement_ids=[problem.rows[row].id for row in rows],
                subject_ids=[subject],
            ))

    # STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT: the Fach-Engpass, as a lower bound.
    # D_s is what the subject's free rows that SOMEBODY may take charge — E_r
    # before the room prune: the normal teachers the row's rule admits, its
    # co-teacher excepted, and a kept row's lead. A_s is the most the teachers
    # who may take any of them could give it: a normal teacher's whole room
    # (shared with other subjects, so an over-estimate), a keep-or-shed
    # teacher's own kept rows in the subject. Whatever the search does, at
    # least D_s − A_s of the subject stays unstaffed. Measured against the
    # hard limit, unlike Fas 1's planning bottleneck against the target.
    by_subject: dict[UUID, list[int]] = {}
    for row in problem.free:
        by_subject.setdefault(problem.rows[row].subject_id, []).append(row)
    for subject, rows in by_subject.items():
        demand = 0
        counted: list[int] = []
        normal: set[int] = set()
        shed: dict[int, int] = defaultdict(int)
        for row in rows:
            pool = pools[row]
            co = problem.co.get(row)
            lead = problem.current.get(row)
            reachable = len(pool) - (1 if co in pool else 0)
            if reachable == 0 and lead is None:
                continue
            charge = problem.rows[row].charge_tenths
            demand += charge
            counted.append(row)
            if co in pool:
                normal |= pool - {co}
            elif not pool <= normal:
                normal |= pool
            if lead is not None:
                if problem.normal[lead]:
                    normal.add(lead)
                else:
                    shed[lead] += charge
        available = sum(problem.cap[t] for t in normal) + sum(shed.values())
        if demand > available:
            conflicts.append(StaffConflict(
                code="STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT",
                params={
                    "subject": str(subject),
                    "count": len(counted),
                    "demandedMinutes": _tenths_to_minutes_ceil(demand),
                    "availableMinutes": available // 10,
                    "shortMinutes": _tenths_to_minutes_ceil(demand - available),
                },
                requirement_ids=[problem.rows[row].id for row in counted],
                subject_ids=[subject],
            ))

    # STAFF_TEACHER_CAPACITY_ZERO: a teacher with a target whose own rows
    # already leave no room for the smallest row they could otherwise take —
    # one they do not lead or co-teach, and (respected) one they qualify for.
    # A target of zero (a full nedsättning) is not a capacity problem to
    # report, and a teacher with no target has no limit to be at. Rows are
    # walked smallest first, so a teacher costs a step or two, not a pass.
    by_charge = sorted(problem.free, key=lambda row: (problem.rows[row].charge_tenths, row))
    for teacher, spec in enumerate(problem.teachers):
        if not problem.target_above_zero(teacher) or spec.limit_tenths is None:
            continue
        smallest = next(
            (
                problem.rows[row].charge_tenths
                for row in by_charge
                if problem.current.get(row) != teacher
                and problem.co.get(row) != teacher
                and (not problem.respect or teacher in problem.eligible[row])
            ),
            None,
        )
        if smallest is not None and problem.current_load[teacher] + smallest > spec.limit_tenths:
            conflicts.append(StaffConflict(
                code="STAFF_TEACHER_CAPACITY_ZERO",
                params={
                    "fixedMinutes": (problem.current_load[teacher] + 5) // 10,
                    "limitMinutes": spec.limit_tenths // 10,
                },
                teacher_ids=[spec.id],
            ))
    return conflicts


def answer_loads(problem: StaffProblem, answer: Assignment) -> list[int]:
    """What each teacher's free rows charge them in `answer`, in tenths."""
    load = [0] * len(problem.teachers)
    for row in problem.free:
        teacher = answer[row]
        if teacher is not None:
            load[teacher] += problem.rows[row].charge_tenths
    return load


def unstaffed_reason(problem: StaffProblem, row: int, load: list[int]) -> str:
    """Why an open row ends unstaffed, judged on the final answer's loads
    (answer_loads)."""
    if problem.recorded and problem.respect and not (
        problem.eligible[row] - {problem.co.get(row)}
    ):
        return "NO_QUALIFIED_TEACHER"
    pool = problem.qualified_pool(row)
    with_target = [t for t in pool if problem.target_above_zero(t)]
    if not with_target:
        return "NO_TEACHER_WITH_TARGET"
    charge = problem.rows[row].charge_tenths
    if any(problem.normal[t] and load[t] + charge <= problem.cap[t] for t in with_target):
        return "NOT_REACHED"
    return "NO_CAPACITY_LEFT"


# ---------------------------------------------------------------------------
# The solve.
# ---------------------------------------------------------------------------


@dataclass
class SolveReport:
    """Where one solve's time went, for the log and benchmarks/staff_60x400.py."""

    build: float = 0.0
    stage1: float = 0.0
    stage2: float = 0.0
    total: float = 0.0
    canonical: float = 0.0
    stage1_status: str = "NOT_RUN"
    stage2_status: str = "NOT_RUN"
    canonical_status: str = "NOT_RUN"
    #: Stage 2's objective and CP-SAT's lower bound on it: how far from
    #: proven a time-limited answer is.
    stage2_objective: float = 0.0
    stage2_bound: float = 0.0


class StaffingSolver:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        #: The last solve's report; read by the benchmark, never by the route.
        self.last_report = SolveReport()

    def _solver(self, seconds: float) -> cp_model.CpSolver:
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = seconds
        solver.parameters.num_workers = STAFF_WORKERS
        solver.parameters.random_seed = 0
        return solver

    def solve(self, request: StaffRequest) -> StaffResponse:
        started = time.monotonic()
        problem = prepare(request)
        before = status_quo(problem)
        timings = SolveReport()
        self.last_report = timings

        size = estimate_model_size(problem)
        if size > MAX_MODEL_VARIABLES:
            raise InvalidScheduleInputError.of("STAFF_MODEL_TOO_LARGE", {
                "variables": size, "limit": MAX_MODEL_VARIABLES,
            })
        conflicts = verdicts(problem)
        build_domains(problem)
        check(problem, before)

        answer, status, proven = self._search(problem, started, timings)
        response = self._response(problem, request, before, answer, status, proven, conflicts)
        timings.total = time.monotonic() - started
        logger.info(
            "staff_solve request_id=%s teachers=%d rows=%d free=%d open=%d status=%s "
            "proven=%s stage1=%s stage2=%s canonical=%s build=%.2fs stage1=%.2fs stage2=%.2fs "
            "canonical=%.2fs total=%.2fs",
            request.request_id, len(problem.teachers), len(problem.rows), len(problem.free),
            len(problem.open), status, proven, timings.stage1_status, timings.stage2_status,
            timings.canonical_status, timings.build, timings.stage1, timings.stage2,
            timings.canonical, timings.total,
        )
        return response

    def _search(
        self, problem: StaffProblem, started: float, timings: SolveReport,
    ) -> tuple[Assignment, str, bool]:
        quo = status_quo(problem)
        if not any(problem.domain[row] for row in problem.open) and all(
            len(problem.domain[row]) == 1 for row in problem.kept
        ):
            # Nothing can change: the status quo is the only answer there is.
            return quo, "OPTIMAL", True

        hint = greedy(problem)
        check(problem, hint.answer)

        began = time.monotonic()
        built = build_model(problem, hint.order)
        timings.build = time.monotonic() - began

        cap = self._settings.staff_solver_max_time_seconds
        # Measured from the start of the request: on a very large school the
        # domains and the build eat into the cap, and the search gets what is
        # left rather than adding its own on top. With nothing left the
        # greedy is the answer.
        left = cap - AFTER_SEARCH_SECONDS - (time.monotonic() - started)
        if left < MIN_STAGE_SECONDS:
            return hint.answer, "FEASIBLE", False

        # Stage 1: as few unstaffed as possible, and nothing else.
        _hint(problem, built, hint.answer)
        built.model.Minimize(built.primary)
        solver = self._solver(min(STAGE1_MAX_SECONDS, STAGE1_SHARE * cap, left))
        began = time.monotonic()
        code = solver.Solve(built.model)
        timings.stage1 = time.monotonic() - began
        timings.stage1_status = solver.StatusName(code)
        self._refuse_broken(built, code)
        first = hint.answer
        if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            found = _read(problem, built, solver)
            check(problem, found)
            if evaluate(problem, found).primary <= evaluate(problem, first).primary:
                first = found
        proven = code == cp_model.OPTIMAL
        best_primary = evaluate(problem, first).primary

        # Stage 2: everything else, under "no more unstaffed than stage 1".
        candidates: list[Assignment] = []
        second_proven = False
        left = cap - AFTER_SEARCH_SECONDS - (time.monotonic() - started)
        if left >= MIN_STAGE_SECONDS:
            built.model.Add(built.primary <= best_primary)
            built.model.Minimize(built.secondary)
            _hint(problem, built, first)
            solver = self._solver(left)
            began = time.monotonic()
            code = solver.Solve(built.model)
            timings.stage2 = time.monotonic() - began
            timings.stage2_status = solver.StatusName(code)
            self._refuse_broken(built, code)
            if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                timings.stage2_objective = solver.ObjectiveValue()
                timings.stage2_bound = solver.BestObjectiveBound()
                found = _read(problem, built, solver)
                check(problem, found)
                candidates.append(found)
                second_proven = code == cp_model.OPTIMAL
        candidates += [first, hint.answer]

        # The better answer under the Python score — P, then S — with CP-SAT's
        # own first on a tie. Taken on the score, not the model's word.
        best = min(candidates, key=lambda answer: evaluate(problem, answer).key())
        optimal = proven and second_proven and best is candidates[0]
        if optimal:
            # OPTIMAL is promised to repeat; an optimum the tie-break could
            # not settle in time is just as good but may not, so it goes out
            # as FEASIBLE ("bästa hittills inom tidsgränsen") — unstaffed
            # stays proven.
            best, optimal = self._canonical(problem, built, best, started, timings)
        return best, "OPTIMAL" if optimal else "FEASIBLE", proven

    def _canonical(
        self,
        problem: StaffProblem,
        built: StaffModel,
        optimum: Assignment,
        started: float,
        timings: SolveReport,
    ) -> tuple[Assignment, bool]:
        """The proven optimum every press returns, and whether it was found.

        A school has many equally good proposals — two teachers with the same
        target and the same subjects are interchangeable — and the parallel
        portfolio returns whichever worker reached one first. Here the
        optimum's value is fixed (P ≤ P* is already in the model, S ≤ S*
        joins it) and the portfolio minimises a fixed tie-break,
        Σ w(r, t)·x[r, t] with _tie_break_weight's pseudo-random weights of
        payload positions. Its proven optimum is one answer, whichever worker
        proves it, on whatever host.

        It replaced a single-worker search for "the first answer at S*" under
        a deterministic budget: with no objective to steer it, that search
        could not find S* again on a 30-teacher, 120-row school even in 30
        units of deterministic time, so every press there waited two seconds
        and then sent the portfolio's own (varying) answer as OPTIMAL. The
        tie-break is proven in 0.01–3 s up to 50 teachers and 200 rows.

        Returns the optimum unchanged and False when the tie-break is not
        proven in the time left.
        """
        left = self._settings.staff_solver_max_time_seconds - AFTER_SEARCH_SECONDS - (
            time.monotonic() - started
        )
        if left < MIN_STAGE_SECONDS:
            return optimum, False
        score = evaluate(problem, optimum)
        built.model.Add(built.secondary <= score.secondary)
        pairs = list(built.x)  # insertion order: payload order
        built.model.Minimize(cp_model.LinearExpr.WeightedSum(
            [built.x[pair] for pair in pairs], [_tie_break_weight(*pair) for pair in pairs],
        ))
        _hint(problem, built, optimum)
        solver = self._solver(left)
        began = time.monotonic()
        code = solver.Solve(built.model)
        timings.canonical = time.monotonic() - began
        timings.canonical_status = solver.StatusName(code)
        self._refuse_broken(built, code)
        if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return optimum, False
        found = _read(problem, built, solver)
        check(problem, found)
        if evaluate(problem, found).key() != score.key():
            msg = "The canonical staffing answer is not the proven optimum's equal."
            raise SolverBuildError(msg)
        return found, code == cp_model.OPTIMAL

    @staticmethod
    def _refuse_broken(built: StaffModel, code: int) -> None:
        # Either is a bug in this module, never a property of the school's
        # data: the status quo satisfies every row by construction.
        if code == cp_model.MODEL_INVALID:
            msg = f"CP-SAT rejected the staffing model: {built.model.Validate()}"
            raise SolverBuildError(msg)
        if code == cp_model.INFEASIBLE:
            msg = "The staffing model refused the status quo; it was built wrong."
            raise SolverBuildError(msg)

    @staticmethod
    def _response(
        problem: StaffProblem,
        request: StaffRequest,
        before: Assignment,
        after: Assignment,
        status: str,
        proven: bool,
        conflicts: list[StaffConflict],
    ) -> StaffResponse:
        assignments: list[StaffAssignment] = []
        unstaffed: list[StaffUnstaffed] = []
        load = answer_loads(problem, after)
        for row in problem.free:
            teacher = after[row]
            if teacher is None:
                unstaffed.append(StaffUnstaffed(
                    requirement_id=problem.rows[row].id,
                    reason=unstaffed_reason(problem, row, load),
                ))
            else:
                assignments.append(StaffAssignment(
                    requirement_id=problem.rows[row].id,
                    teacher_id=problem.teachers[teacher].id,
                ))
        return StaffResponse(
            request_id=request.request_id,
            status=status,
            unstaffed_proven=proven,
            assignments=assignments,
            unstaffed=unstaffed,
            conflicts=conflicts,
            terms=StaffTermsComparison(
                before=evaluate(problem, before).terms(),
                after=evaluate(problem, after).terms(),
            ),
        )
