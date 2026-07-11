from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.schemas.schedule import (
    AnonymousConstraint,
    AnonymousRequirement,
    AnonymousRoom,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    ScheduledLesson,
    SolverStatus,
)
from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis
from app.solver.time_grid import TimeGrid


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


class SchedulerSolver:
    """CP-SAT weekly master timetable optimizer."""

    # Hard ceilings applied before any CP-SAT model is constructed. The solver's
    # wall-clock timeout only bounds Solve(); the model-BUILD phase (variable and
    # constraint creation) runs first and scales multiplicatively with the input
    # list lengths. These budgets reject pathological payloads up front so a
    # single request cannot exhaust CPU/RAM before the timeout can engage.
    MAX_LESSON_INSTANCES = 5_000
    MAX_MODEL_COMPLEXITY = 2_000_000

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._grid = TimeGrid(
            day_start_minutes=settings.schedule_day_start_minutes,
            day_end_minutes=settings.schedule_day_end_minutes,
            slot_minutes=settings.slot_minutes,
            schedule_days=tuple(settings.schedule_days),
        )

    def solve(self, request: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        self._validate_request(request)

        model = cp_model.CpModel()
        registry = AssumptionRegistry()
        rooms = request.rooms
        decisions = self._create_lesson_decisions(model, request.requirements, len(rooms))

        self._add_capacity_constraints(model, registry, decisions, rooms)
        self._add_teacher_no_overlap(model, decisions)
        self._add_group_no_overlap(model, decisions)
        self._add_room_no_overlap(model, decisions, rooms)
        self._add_availability_constraints(model, registry, decisions, rooms, request.constraints)

        preference_penalties = self._add_preference_objective(model, decisions, request.constraints)
        model.Minimize(sum(preference_penalties) if preference_penalties else 0)

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self._settings.solver_max_time_seconds

        status_code = solver.Solve(model)
        status = self._map_status(status_code)

        if status == "INFEASIBLE":
            return OptimizeScheduleResponse(
                request_id=request.request_id,
                status="INFEASIBLE",
                lessons=[],
                conflicts=build_conflict_analysis(solver, registry),
            )

        if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            msg = "Solver terminated without a usable schedule."
            raise SolverBuildError(msg)

        lessons = self._extract_lessons(solver, decisions, rooms)
        return OptimizeScheduleResponse(
            request_id=request.request_id,
            status=status,
            lessons=lessons,
            conflicts=None,
        )

    def _validate_request(self, request: OptimizeScheduleRequest) -> None:
        if not request.requirements:
            raise InvalidScheduleInputError("At least one teaching requirement is required.")
        if not request.rooms:
            raise InvalidScheduleInputError("At least one room is required.")

        # Aggregate complexity budget — reject oversized models before building.
        total_lessons = sum(r.lessons_per_week for r in request.requirements)
        if total_lessons > self.MAX_LESSON_INSTANCES:
            msg = (
                f"Too many lesson instances ({total_lessons}); "
                f"limit is {self.MAX_LESSON_INSTANCES}."
            )
            raise InvalidScheduleInputError(msg)

        estimated_complexity = (
            total_lessons * len(request.rooms)
            + total_lessons * len(request.constraints) * len(self._grid.schedule_days)
        )
        if estimated_complexity > self.MAX_MODEL_COMPLEXITY:
            msg = (
                "Scheduling request is too large to solve; "
                "reduce the number of rooms, requirements, or constraints."
            )
            raise InvalidScheduleInputError(msg)

        for requirement in request.requirements:
            duration_slots = self._grid.minutes_to_slots(requirement.minutes_per_lesson)
            if duration_slots > self._grid.slots_per_day:
                msg = (
                    f"Requirement {requirement.id} exceeds the daily scheduling window "
                    f"({requirement.minutes_per_lesson} minutes)."
                )
                raise InvalidScheduleInputError(msg)

            eligible_rooms = [
                room
                for room in request.rooms
                if room.capacity is None or room.capacity >= requirement.student_group_size
            ]
            if not eligible_rooms:
                msg = (
                    f"No room satisfies capacity for requirement {requirement.id} "
                    f"(group size {requirement.student_group_size})."
                )
                raise InvalidScheduleInputError(msg)

    def _create_lesson_decisions(
        self,
        model: cp_model.CpModel,
        requirements: list[AnonymousRequirement],
        room_count: int,
    ) -> list[LessonDecision]:
        decisions: list[LessonDecision] = []
        horizon = self._grid.horizon

        for requirement in requirements:
            duration = self._grid.minutes_to_slots(requirement.minutes_per_lesson)
            for lesson_index in range(requirement.lessons_per_week):
                lesson = LessonInstance(requirement=requirement, lesson_index=lesson_index)
                start = model.NewIntVar(0, max(0, horizon - duration), f"start_{lesson.key()}")
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
                    ),
                )

        return decisions

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
                idx
                for idx, room in enumerate(rooms)
                if room.capacity is None or room.capacity >= requirement.student_group_size
            ]
            if not allowed_indices:
                continue

            assumption = registry.register(
                model,
                name=f"capacity_{requirement.id}_{decision.lesson.lesson_index}",
                category="ROOM_CAPACITY",
                message=(
                    f"Requirement {requirement.id} needs a room with capacity "
                    f">= {requirement.student_group_size}."
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
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            teacher_id = decision.lesson.requirement.teacher_id
            if teacher_id is None:
                continue
            grouped.setdefault(teacher_id, []).append(decision)

        for teacher_decisions in grouped.values():
            if len(teacher_decisions) > 1:
                model.AddNoOverlap([decision.interval for decision in teacher_decisions])

    def _add_group_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
    ) -> None:
        grouped: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            group_id = decision.lesson.requirement.student_group_id
            grouped.setdefault(group_id, []).append(decision)

        for group_decisions in grouped.values():
            if len(group_decisions) > 1:
                model.AddNoOverlap([decision.interval for decision in group_decisions])

    def _add_room_no_overlap(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
    ) -> None:
        for room_idx, room in enumerate(rooms):
            room_intervals: list[cp_model.IntervalVar] = []
            for decision in decisions:
                assigned_here = model.NewBoolVar(f"room_{room.id}_{decision.lesson.key()}")
                model.Add(decision.room_index == room_idx).OnlyEnforceIf(assigned_here)
                model.Add(decision.room_index != room_idx).OnlyEnforceIf(assigned_here.Not())
                optional = model.NewOptionalIntervalVar(
                    decision.start,
                    decision.duration,
                    decision.end,
                    assigned_here,
                    f"room_opt_{room.id}_{decision.lesson.key()}",
                )
                room_intervals.append(optional)

            if len(room_intervals) > 1:
                model.AddNoOverlap(room_intervals)

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
                raise InvalidScheduleInputError(str(exc)) from exc

            affected = self._decisions_for_constraint(constraint, decisions, room_index_by_id, model)
            if not affected:
                continue

            assumption = registry.register(
                model,
                name=f"availability_{constraint.id}",
                category="AVAILABILITY",
                message=f"Availability constraint {constraint.id} blocks required lesson placement.",
                constraint_ids=[constraint.id],
                resource_ids=[constraint.resource_id],
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
                        model.AddBoolOr([before, after]).OnlyEnforceIf(guard).OnlyEnforceIf(assumption)

    def _decisions_for_constraint(
        self,
        constraint: AnonymousConstraint,
        decisions: list[LessonDecision],
        room_index_by_id: dict[UUID, int],
        model: cp_model.CpModel,
    ) -> list[tuple[LessonDecision, cp_model.IntVar | None]]:
        affected: list[tuple[LessonDecision, cp_model.IntVar | None]] = []

        if constraint.resource_kind == "TEACHER":
            for decision in decisions:
                if decision.lesson.requirement.teacher_id == constraint.resource_id:
                    affected.append((decision, None))
            return affected

        if constraint.resource_kind == "STUDENT_GROUP":
            for decision in decisions:
                if decision.lesson.requirement.student_group_id == constraint.resource_id:
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

    def _add_preference_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        constraints: list[AnonymousConstraint],
    ) -> list[cp_model.IntVar]:
        penalties: list[cp_model.IntVar] = []

        for constraint in constraints:
            if constraint.kind not in {"PREFERRED_FREE", "PREFERRED_BUSY"} or constraint.date is not None:
                continue

            try:
                windows = self._grid.window_to_absolute_range(
                    constraint.day_of_week,
                    constraint.start_time,
                    constraint.end_time,
                )
            except ValueError as exc:
                raise InvalidScheduleInputError(str(exc)) from exc

            for decision in decisions:
                if not self._constraint_applies_to_teacher(constraint, decision):
                    continue

                for abs_start, abs_end in windows:
                    before = model.NewBoolVar(
                        f"pref_before_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    after = model.NewBoolVar(
                        f"pref_after_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    overlaps = model.NewBoolVar(
                        f"pref_overlap_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                    model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                    model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                    model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())
                    model.AddBoolAnd([before.Not(), after.Not()]).OnlyEnforceIf(overlaps)
                    model.AddBoolOr([before, after]).OnlyEnforceIf(overlaps.Not())

                    violation = model.NewBoolVar(
                        f"pref_violation_{constraint.id}_{decision.lesson.key()}_{abs_start}",
                    )
                    if constraint.kind == "PREFERRED_FREE":
                        model.Add(violation == 1).OnlyEnforceIf(overlaps)
                        model.Add(violation == 0).OnlyEnforceIf(overlaps.Not())
                        penalties.append(
                            violation * self._settings.weight_preferred_free_violation,
                        )
                    else:
                        model.Add(violation == 1).OnlyEnforceIf(overlaps.Not())
                        model.Add(violation == 0).OnlyEnforceIf(overlaps)
                        penalties.append(
                            violation * self._settings.weight_preferred_busy_violation,
                        )

        return penalties

    def _extract_lessons(
        self,
        solver: cp_model.CpSolver,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
    ) -> list[ScheduledLesson]:
        lessons: list[ScheduledLesson] = []
        for decision in decisions:
            absolute_start = solver.Value(decision.start)
            day_of_week, start_slot = self._grid.decode_absolute(absolute_start)
            start_time, end_time = self._grid.format_hhmmss(start_slot, decision.duration)
            room_idx = solver.Value(decision.room_index)
            lessons.append(
                ScheduledLesson(
                    requirement_id=decision.lesson.requirement.id,
                    room_id=rooms[room_idx].id,
                    day_of_week=day_of_week,  # type: ignore[arg-type]
                    start_time=start_time,
                    end_time=end_time,
                ),
            )
        return lessons

    @staticmethod
    def _constraint_applies_to_teacher(
        constraint: AnonymousConstraint,
        decision: LessonDecision,
    ) -> bool:
        requirement = decision.lesson.requirement
        return (
            constraint.resource_kind == "TEACHER"
            and requirement.teacher_id == constraint.resource_id
        )

    @staticmethod
    def _map_status(status_code: int) -> SolverStatus:
        if status_code == cp_model.OPTIMAL:
            return "OPTIMAL"
        if status_code == cp_model.FEASIBLE:
            return "FEASIBLE"
        return "INFEASIBLE"
