from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

from ortools.sat.python import cp_model

from app.schemas.schedule import ConflictAnalysis, ConflictCategory, ConflictDetail


@dataclass
class AssumptionRecord:
    literal: cp_model.IntVar
    category: ConflictCategory
    message: str
    requirement_ids: list[UUID] = field(default_factory=list)
    room_ids: list[UUID] = field(default_factory=list)
    constraint_ids: list[UUID] = field(default_factory=list)
    resource_ids: list[UUID] = field(default_factory=list)


class AssumptionRegistry:
    """Tracks assumption literals for OR-Tools infeasible-core extraction."""

    def __init__(self) -> None:
        self._records: list[AssumptionRecord] = []

    def register(
        self,
        model: cp_model.CpModel,
        *,
        name: str,
        category: ConflictCategory,
        message: str,
        requirement_ids: list[UUID] | None = None,
        room_ids: list[UUID] | None = None,
        constraint_ids: list[UUID] | None = None,
        resource_ids: list[UUID] | None = None,
    ) -> cp_model.IntVar:
        literal = model.NewBoolVar(name)
        model.AddAssumption(literal)
        self._records.append(
            AssumptionRecord(
                literal=literal,
                category=category,
                message=message,
                requirement_ids=requirement_ids or [],
                room_ids=room_ids or [],
                constraint_ids=constraint_ids or [],
                resource_ids=resource_ids or [],
            ),
        )
        return literal

    def resolve(self, indices: list[int]) -> list[AssumptionRecord]:
        resolved: list[AssumptionRecord] = []
        for index in indices:
            if 0 <= index < len(self._records):
                resolved.append(self._records[index])
        return resolved


def build_conflict_analysis(
    solver: cp_model.CpSolver,
    registry: AssumptionRegistry,
) -> ConflictAnalysis:
    """Map OR-Tools sufficient assumptions to admin-facing conflict payloads."""
    core_indices = solver.SufficientAssumptionsForInfeasibility()
    records = registry.resolve(core_indices)

    if not records:
        return ConflictAnalysis(
            summary="The timetable is infeasible, but no minimal conflict core was returned.",
            conflicts=[
                ConflictDetail(
                    category="INSUFFICIENT_RESOURCES",
                    message=(
                        "Total teaching demand likely exceeds available room or teacher time. "
                        "Review lessons per week, unavailable windows, and room capacity."
                    ),
                ),
            ],
        )

    conflicts = [
        ConflictDetail(
            category=record.category,
            message=record.message,
            requirement_ids=record.requirement_ids,
            room_ids=record.room_ids,
            constraint_ids=record.constraint_ids,
            resource_ids=record.resource_ids,
        )
        for record in records
    ]

    categories = sorted({conflict.category for conflict in conflicts})
    summary = (
        "Scheduling is infeasible due to conflicting constraints: "
        + ", ".join(category.lower().replace("_", " ") for category in categories)
        + "."
    )
    return ConflictAnalysis(summary=summary, conflicts=conflicts)
