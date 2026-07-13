from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type
from uuid import UUID

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.schemas.schedule import (
    AnonymousConstraint,
    AnonymousRequirement,
    AnonymousRoom,
    FixedLesson,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    PreviousLesson,
    ScheduledLesson,
    ScheduleRules,
    SolverStatus,
)


from app.solver.conflict_analyzer import AssumptionRegistry, build_conflict_analysis
from app.solver.time_grid import TimeGrid


@dataclass(frozen=True)
class ResolvedWeights:
    preferred_free: int
    preferred_busy: int
    disruption: int
    spread: int
    teacher_gap: int
    date_unavailable: int


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
        self._add_fixed_lesson_constraints(model, decisions, rooms, request.fixed_lessons)

        weights = self._resolve_weights(request)
        day_vars: dict[str, cp_model.IntVar] = {}
        self._add_rules_constraints(model, decisions, request.rules, day_vars)
        objective_terms = [
            *self._add_preference_objective(model, decisions, rooms, request.constraints, weights),
            *self._add_disruption_objective(model, decisions, request.previous_lessons, weights),
            *self._add_spread_objective(model, decisions, weights, day_vars),
            *self._add_teacher_gap_objective(model, decisions, weights, day_vars),
        ]
        model.Minimize(sum(objective_terms) if objective_terms else 0)

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
                room for room in request.rooms if self._room_allowed(room, requirement)
            ]
            if not eligible_rooms:
                msg = (
                    f"No room satisfies capacity/type for requirement {requirement.id} "
                    f"(group size {requirement.student_group_size}, "
                    f"required type {requirement.required_room_type or 'any'})."
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
                idx for idx, room in enumerate(rooms) if self._room_allowed(room, requirement)
            ]
            if not allowed_indices:
                continue

            assumption = registry.register(
                model,
                name=f"capacity_{requirement.id}_{decision.lesson.lesson_index}",
                category="ROOM_CAPACITY",
                message=(
                    f"Requirement {requirement.id} needs a room with capacity "
                    f">= {requirement.student_group_size}"
                    + (
                        f" and type {requirement.required_room_type}."
                        if requirement.required_room_type
                        else "."
                    )
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
            requirement = decision.lesson.requirement
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id):
                if teacher_id is not None:
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
                requirement = decision.lesson.requirement
                if constraint.resource_id in (
                    requirement.teacher_id,
                    requirement.co_teacher_id,
                ):
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

    def _add_fixed_lesson_constraints(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rooms: list[AnonymousRoom],
        fixed_lessons: list[FixedLesson],
    ) -> None:
        """Hard-block generated lessons from overlapping locked placements.

        A generated lesson may not overlap a fixed lesson that shares its
        teacher or student group; if the fixed lesson occupies a room, no
        generated lesson may be assigned that room during the window.
        """
        room_index_by_id = {room.id: idx for idx, room in enumerate(rooms)}

        for fixed in fixed_lessons:
            window = self._fixed_window(fixed)
            if window is None:
                # Outside the scheduling grid (e.g. weekend when the grid is
                # Mon-Fri): generated lessons can never collide with it.
                continue
            abs_start, abs_end = window

            room_idx = (
                room_index_by_id.get(fixed.room_id) if fixed.room_id is not None else None
            )

            for decision in decisions:
                requirement = decision.lesson.requirement
                fixed_teachers = {
                    tid for tid in (fixed.teacher_id, fixed.co_teacher_id) if tid
                }
                own_teachers = {
                    tid
                    for tid in (requirement.teacher_id, requirement.co_teacher_id)
                    if tid
                }
                shares_teacher = bool(fixed_teachers & own_teachers)
                fixed_groups = {fixed.student_group_id, *fixed.extra_group_ids}
                shares_group = requirement.student_group_id in fixed_groups

                if shares_teacher or shares_group:
                    self._add_window_avoidance(
                        model,
                        decision,
                        abs_start,
                        abs_end,
                        tag=f"fixed_{fixed.id}_{decision.lesson.key()}",
                        guard=None,
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
                    )

    def _add_window_avoidance(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        abs_start: int,
        abs_end: int,
        tag: str,
        guard: cp_model.IntVar | None,
    ) -> None:
        """decision must end before, or start after, the [abs_start, abs_end) window."""
        before = model.NewBoolVar(f"before_{tag}")
        after = model.NewBoolVar(f"after_{tag}")
        model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
        model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
        model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
        model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())
        if guard is None:
            model.AddBoolOr([before, after])
        else:
            model.AddBoolOr([before, after]).OnlyEnforceIf(guard)

    def _fixed_window(self, fixed: FixedLesson) -> tuple[int, int] | None:
        """Absolute slot window blocked by a fixed lesson, rounded outward.

        Locked lessons are hand-placed and need not align to the slot grid;
        the blocked window is expanded to whole slots so blocking stays
        conservative. Returns None when the lesson lies outside the grid.
        """
        if fixed.day_of_week not in self._grid.schedule_days:
            return None

        start_minutes = _hhmmss_to_minutes(fixed.start_time)
        end_minutes = _hhmmss_to_minutes(fixed.end_time)
        start_minutes = max(start_minutes, self._grid.day_start_minutes)
        end_minutes = min(end_minutes, self._grid.day_end_minutes)
        if end_minutes <= start_minutes:
            return None

        slot = self._grid.slot_minutes
        start_slot = (start_minutes - self._grid.day_start_minutes) // slot
        end_slot = -(-(end_minutes - self._grid.day_start_minutes) // slot)  # ceil

        day_offset = self._grid.day_index(fixed.day_of_week) * self._grid.slots_per_day
        return day_offset + start_slot, day_offset + end_slot

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
            date_unavailable=self._settings.weight_date_unavailable,
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
                raise InvalidScheduleInputError(str(exc)) from exc

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

    def _add_disruption_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        previous_lessons: list[PreviousLesson],
        weights: ResolvedWeights,
    ) -> list[cp_model.LinearExpr]:
        """Minimal-disruption re-optimization.

        For every slot the previous schedule used, the solver is penalized
        unless some lesson instance of the same requirement stays on it. The
        previous slots are also fed in as solver hints (warm start).
        """
        if weights.disruption <= 0 or not previous_lessons:
            return []

        by_requirement: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_requirement.setdefault(decision.lesson.requirement.id, []).append(decision)

        hinted: set[str] = set()
        penalties: list[cp_model.LinearExpr] = []

        for index, previous in enumerate(previous_lessons):
            candidates = by_requirement.get(previous.requirement_id)
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

            # Warm-start hint: point one not-yet-hinted instance at the slot.
            for decision in candidates:
                if decision.lesson.key() not in hinted:
                    model.AddHint(decision.start, abs_slot)
                    hinted.add(decision.lesson.key())
                    break

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

    def _add_teacher_gap_objective(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        weights: ResolvedWeights,
        day_vars: dict[str, cp_model.IntVar],
    ) -> list[cp_model.LinearExpr]:
        """Penalizes idle time between two same-day lessons of a teacher.

        For every same-teacher lesson pair on the same day, the pairwise gap
        (positive distance between the intervals) is penalized. Compact
        teacher days therefore score better; pairs on different days incur
        no penalty. Co-taught lessons count for both teachers.
        """
        if weights.teacher_gap <= 0:
            return []

        by_teacher: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            requirement = decision.lesson.requirement
            for teacher_id in (requirement.teacher_id, requirement.co_teacher_id):
                if teacher_id is not None:
                    by_teacher.setdefault(teacher_id, []).append(decision)

        penalties: list[cp_model.LinearExpr] = []
        horizon = self._grid.horizon
        max_pairs_per_teacher = 600  # model-size guard

        for teacher_id, group in by_teacher.items():
            if len(group) < 2 or len(group) * (len(group) - 1) // 2 > max_pairs_per_teacher:
                continue
            days = [self._day_var(model, d, day_vars) for d in group]
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    tag = f"tgap_{teacher_id}_{i}_{j}"
                    same = model.NewBoolVar(f"same_{tag}")
                    model.Add(days[i] == days[j]).OnlyEnforceIf(same)
                    model.Add(days[i] != days[j]).OnlyEnforceIf(same.Not())

                    gap = model.NewIntVar(0, horizon, f"gap_{tag}")
                    # When on the same day, gap >= the positive distance
                    # between the two intervals (0 if adjacent).
                    model.Add(gap >= group[i].start - group[j].end).OnlyEnforceIf(same)
                    model.Add(gap >= group[j].start - group[i].end).OnlyEnforceIf(same)
                    model.Add(gap == 0).OnlyEnforceIf(same.Not())
                    penalties.append(gap * weights.teacher_gap)

        return penalties

    def _add_rules_constraints(
        self,
        model: cp_model.CpModel,
        decisions: list[LessonDecision],
        rules: ScheduleRules | None,
        day_vars: dict[str, cp_model.IntVar],
    ) -> None:
        """Hard school rules: guaranteed lunch break, max lessons per day."""
        if rules is None:
            return

        by_group: dict[UUID, list[LessonDecision]] = {}
        for decision in decisions:
            by_group.setdefault(
                decision.lesson.requirement.student_group_id, [],
            ).append(decision)

        # --- Max lessons per day per student group -------------------------
        max_per_day = rules.max_lessons_per_day_per_group
        if max_per_day is not None:
            day_count = len(self._grid.schedule_days)
            for group_id, group in by_group.items():
                if len(group) <= max_per_day:
                    continue
                days = [self._day_var(model, d, day_vars) for d in group]
                for day_index in range(day_count):
                    on_day: list[cp_model.IntVar] = []
                    for k, decision in enumerate(group):
                        b = model.NewBoolVar(
                            f"onday_{group_id}_{day_index}_{decision.lesson.key()}",
                        )
                        model.Add(days[k] == day_index).OnlyEnforceIf(b)
                        model.Add(days[k] != day_index).OnlyEnforceIf(b.Not())
                        on_day.append(b)
                    model.Add(sum(on_day) <= max_per_day)

        # --- Guaranteed lunch break per student group per day ---------------
        if (
            rules.lunch_start_time is not None
            and rules.lunch_end_time is not None
            and rules.lunch_minutes is not None
        ):
            try:
                window_start = self._grid.parse_hhmmss(rules.lunch_start_time)
                window_end = self._grid.parse_hhmmss(rules.lunch_end_time)
            except ValueError as exc:
                raise InvalidScheduleInputError(str(exc)) from exc
            lunch_slots = self._grid.minutes_to_slots(rules.lunch_minutes)
            if window_end - window_start < lunch_slots:
                raise InvalidScheduleInputError(
                    "Lunch window is shorter than the required lunch break.",
                )

            for group_id, group in by_group.items():
                for day_index in range(len(self._grid.schedule_days)):
                    day_offset = day_index * self._grid.slots_per_day
                    candidates: list[cp_model.IntVar] = []
                    for cand_start in range(
                        window_start, window_end - lunch_slots + 1,
                    ):
                        abs_start = day_offset + cand_start
                        abs_end = abs_start + lunch_slots
                        outside_all: list[cp_model.IntVar] = []
                        for decision in group:
                            tag = f"lunch_{group_id}_{day_index}_{cand_start}_{decision.lesson.key()}"
                            before = model.NewBoolVar(f"b_{tag}")
                            after = model.NewBoolVar(f"a_{tag}")
                            outside = model.NewBoolVar(f"o_{tag}")
                            model.Add(decision.end <= abs_start).OnlyEnforceIf(before)
                            model.Add(decision.end > abs_start).OnlyEnforceIf(before.Not())
                            model.Add(decision.start >= abs_end).OnlyEnforceIf(after)
                            model.Add(decision.start < abs_end).OnlyEnforceIf(after.Not())
                            model.AddBoolOr([before, after]).OnlyEnforceIf(outside)
                            model.AddBoolAnd([before.Not(), after.Not()]).OnlyEnforceIf(
                                outside.Not(),
                            )
                            outside_all.append(outside)
                        free = model.NewBoolVar(
                            f"lunchfree_{group_id}_{day_index}_{cand_start}",
                        )
                        model.AddBoolAnd(outside_all).OnlyEnforceIf(free)
                        model.AddBoolOr(
                            [o.Not() for o in outside_all],
                        ).OnlyEnforceIf(free.Not())
                        candidates.append(free)
                    if candidates:
                        model.AddBoolOr(candidates)

    @staticmethod
    def _room_allowed(room: AnonymousRoom, requirement: AnonymousRequirement) -> bool:
        capacity_ok = room.capacity is None or room.capacity >= requirement.student_group_size
        type_ok = (
            requirement.required_room_type is None
            or room.type == requirement.required_room_type
        )
        return capacity_ok and type_ok

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
    def _map_status(status_code: int) -> SolverStatus:
        if status_code == cp_model.OPTIMAL:
            return "OPTIMAL"
        if status_code == cp_model.FEASIBLE:
            return "FEASIBLE"
        return "INFEASIBLE"


def _hhmmss_to_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes
