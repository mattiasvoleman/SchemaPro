from __future__ import annotations

from dataclasses import dataclass, field, replace
from uuid import UUID

from ortools.sat.python import cp_model

from app.schemas.schedule import ConflictAnalysis, ConflictCategory, ConflictDetail


@dataclass
class AssumptionRecord:
    literal: cp_model.IntVar
    category: ConflictCategory
    #: The sentence's name and the values it substitutes; the English is
    #: rendered from them by ConflictDetail. See app/messages.py.
    code: str
    params: dict[str, str | int | float] = field(default_factory=dict)
    requirement_ids: list[UUID] = field(default_factory=list)
    room_ids: list[UUID] = field(default_factory=list)
    constraint_ids: list[UUID] = field(default_factory=list)
    resource_ids: list[UUID] = field(default_factory=list)


class AssumptionRegistry:
    """Tracks assumption literals for OR-Tools infeasible-core extraction.

    The literal is created either way; what changes is how it is pinned true.

    ``use_assumptions=False`` (the default) fixes it with a unit clause. The
    feasible set is identical, but the ``CpModel.assumptions`` field stays
    empty — and that field is expensive. CP-SAT refuses to run multi-threaded
    while it is populated, and says so in its own log::

        Forcing sequential search as assumptions are not supported in multi-thread.
        Forcing presolve to keep all feasible solutions in the presence of assumptions.
        Starting search at 0.80s with 1 workers.

    Because ``_add_capacity_constraints`` registers once per lesson instance, a
    2,000-student payload carried 3,046 assumption literals and therefore ran on
    one core, with the weakest search strategy, no LNS portfolio, and
    solution-losing presolve reductions disabled. On the 250-student benchmark
    that alone is the difference between TIMEOUT and a valid timetable.

    ``use_assumptions=True`` restores the native behaviour, which is what makes
    ``SufficientAssumptionsForInfeasibility()`` return a core. The solver builds
    the model that way only on the INFEASIBLE path, where the diagnosis is the
    point of the response and the single-threaded cost is worth paying.
    """

    def __init__(self, *, use_assumptions: bool = False) -> None:
        self._records: list[AssumptionRecord] = []
        self._use_assumptions = use_assumptions

    def register(
        self,
        model: cp_model.CpModel,
        *,
        name: str,
        category: ConflictCategory,
        code: str,
        params: dict[str, str | int | float] | None = None,
        requirement_ids: list[UUID] | None = None,
        room_ids: list[UUID] | None = None,
        constraint_ids: list[UUID] | None = None,
        resource_ids: list[UUID] | None = None,
    ) -> cp_model.IntVar:
        literal = model.NewBoolVar(name)
        if self._use_assumptions:
            model.AddAssumption(literal)
        else:
            # Same effect on the feasible set, without populating the
            # assumptions field. Presolve folds this away.
            model.AddBoolAnd([literal])
        self._records.append(
            AssumptionRecord(
                literal=literal,
                category=category,
                code=code,
                params=params or {},
                requirement_ids=requirement_ids or [],
                room_ids=room_ids or [],
                constraint_ids=constraint_ids or [],
                resource_ids=resource_ids or [],
            ),
        )
        return literal

    def resolve(self, indices: list[int]) -> list[AssumptionRecord]:
        """Find the records behind a conflict core.

        ``indices`` are LITERAL REFERENCES — the same encoding ``CpModel``
        stores in its ``assumptions`` field — and not offsets into
        ``self._records``. A reference counts every variable built before the
        literal, and the builders make thousands of those, so the two agree
        only by coincidence. On the payloads exercised here a real core of
        ``[6, 7, 8]`` fell past the end of a three-record list and resolved to
        nothing, and the response degraded to the INSUFFICIENT_RESOURCES
        fallback — which does reach the school, and sends it to look at rooms
        and teacher time whatever the true cause was. Where the numbers happen
        to land *inside* the list the offsets reading is worse than the
        fallback: unrelated records resolve and name a cause with confidence.

        Every literal handed out by ``register`` is a fresh positive variable,
        so its reference is its own non-negative variable index. A negative
        reference is the *negation* of a variable, which this registry never
        assumes; it is skipped like any other index it did not register, which
        keeps the original contract that unknown indices contribute nothing.
        """
        by_reference = {record.literal.Index(): record for record in self._records}
        return [by_reference[index] for index in indices if index in by_reference]


def build_conflict_analysis(
    solver: cp_model.CpSolver,
    registry: AssumptionRegistry,
) -> ConflictAnalysis:
    """Map OR-Tools sufficient assumptions to admin-facing conflict payloads."""
    core_indices = solver.SufficientAssumptionsForInfeasibility()
    records = registry.resolve(core_indices)

    if not records:
        return ConflictAnalysis(
            summary_code="CONFLICT_NO_CORE",
            conflicts=[
                ConflictDetail(
                    category="INSUFFICIENT_RESOURCES",
                    code="CONFLICT_NO_CORE_GUESS",
                ),
            ],
        )

    # One cause, one line. Several builders register per lesson instance rather
    # than per cause — _add_capacity_constraints does it once for every lesson
    # of a requirement — so a requirement with forty lessons a week put forty
    # word-for-word identical details in front of an administrator, and a real
    # payload buried the other causes under them. The category, the CODE and
    # the VALUES together are what identify a cause: the values already name
    # the requirement, the constraint, the seat count or the group and day, so
    # two records that agree on all three are the same sentence about the same
    # thing. Keyed on those rather than on the rendered English, which says the
    # same but only until somebody translates it.
    #
    # Merged rather than dropped, though on today's builders the two are
    # equivalent. Every message written here names the ids of what it is about,
    # so records that agree on the message agree on their ids as well — the
    # copies _add_capacity_constraints registers per lesson instance all carry
    # the one requirement its own sentence quotes. That equivalence is a
    # property of how the messages happen to be phrased and not of this
    # function, and the first builder to register one sentence about several
    # resources would, under a drop, show an administrator an arbitrary member
    # of the set. A dict and four appends buy not having to notice.
    merged: dict[tuple[str, str, tuple[tuple[str, object], ...]], AssumptionRecord] = {}
    for record in records:
        key = (record.category, record.code, tuple(sorted(record.params.items())))
        existing = merged.get(key)
        if existing is None:
            # A copy with id lists of its own, so appending below cannot reach
            # back into the registry's records. `literal` rides along unused —
            # the merged record is a local accumulator, never a return value.
            merged[key] = replace(
                record,
                requirement_ids=list(record.requirement_ids),
                room_ids=list(record.room_ids),
                constraint_ids=list(record.constraint_ids),
                resource_ids=list(record.resource_ids),
            )
            continue
        for target, extra in (
            (existing.requirement_ids, record.requirement_ids),
            (existing.room_ids, record.room_ids),
            (existing.constraint_ids, record.constraint_ids),
            (existing.resource_ids, record.resource_ids),
        ):
            for identifier in extra:
                if identifier not in target:
                    target.append(identifier)

    conflicts = [
        ConflictDetail(
            category=record.category,
            code=record.code,
            params=record.params,
            requirement_ids=record.requirement_ids,
            room_ids=record.room_ids,
            constraint_ids=record.constraint_ids,
            resource_ids=record.resource_ids,
        )
        for record in merged.values()
    ]

    # Not "infeasible because of these". SufficientAssumptionsForInfeasibility
    # returns a core that is SUFFICIENT, not minimal: it routinely carries
    # literals that constrain nothing here, and the solver never claimed
    # otherwise. Saying they caused the failure states as fact something
    # nothing proved — and this text is read by a school, which will go and
    # change whatever it names. So: where to look, what is actually
    # established, and the caveat, in that order.
    #
    # The categories used to be listed here, lower-cased and joined — in
    # English, sorted in English, and repeating what the rows below already
    # show as a labelled badge each. The summary points at them instead.
    return ConflictAnalysis(summary_code="CONFLICT_CORE_SUMMARY", conflicts=conflicts)
