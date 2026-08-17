from __future__ import annotations

from typing import Literal

from pydantic import UUID4, BaseModel, ConfigDict, Field, field_validator

DayOfWeek = Literal[1, 2, 3, 4, 5, 6, 7]
ConstraintKind = Literal["UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"]
ResourceKind = Literal["TEACHER", "ROOM", "STUDENT_GROUP"]
RoomTypeKind = Literal[
    "CLASSROOM",
    "LABORATORY",
    "GYMNASIUM",
    "AUDITORIUM",
    "WORKSHOP",
    "OTHER",
]
# INFEASIBLE is a *proof*: CP-SAT searched the whole space and showed no
# timetable exists. TIMEOUT means the solver ran out of wall-clock budget
# without finding a schedule and without proving anything — the same request
# may well succeed with a larger SOLVER_MAX_TIME_SECONDS. The two must never
# be conflated: only INFEASIBLE justifies telling a school its requirements
# are impossible, and only INFEASIBLE carries a conflict analysis.
SolverStatus = Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMEOUT"]
ConflictCategory = Literal[
    "REQUIREMENT_DEMAND",
    "TEACHER_OVERLAP",
    "ROOM_OVERLAP",
    "GROUP_OVERLAP",
    "ROOM_CAPACITY",
    "AVAILABILITY",
    "INSUFFICIENT_RESOURCES",
]


class CamelModel(BaseModel):
    """Base model that accepts and emits camelCase JSON for NestJS interop."""

    model_config = ConfigDict(
        populate_by_name=True,
        serialize_by_alias=True,
        str_strip_whitespace=True,
        extra="forbid",
    )


class AnonymousRequirement(CamelModel):
    """Anonymized teaching requirement — UUIDs only, no PII."""

    id: UUID4
    subject_id: UUID4 = Field(alias="subjectId")
    student_group_id: UUID4 = Field(alias="studentGroupId")
    teacher_id: UUID4 | None = Field(default=None, alias="teacherId")
    lessons_per_week: int = Field(alias="lessonsPerWeek", ge=1, le=40)
    minutes_per_lesson: int = Field(alias="minutesPerLesson", ge=15, le=240)
    student_group_size: int = Field(
        default=1,
        alias="studentGroupSize",
        ge=1,
        le=1000,
        description="Headcount used for room capacity checks when provided by the gateway.",
    )
    required_room_type: RoomTypeKind | None = Field(
        default=None,
        alias="requiredRoomType",
        description="When set, lessons for this requirement may only use rooms of this type.",
    )
    co_teacher_id: UUID4 | None = Field(
        default=None,
        alias="coTeacherId",
        description="Optional second teacher scheduled together with the lead (co-teaching).",
    )


class AnonymousRoom(CamelModel):
    id: UUID4
    capacity: int | None = Field(default=None, ge=1, le=10000)
    type: RoomTypeKind | None = Field(default=None)


class AnonymousConstraint(CamelModel):
    id: UUID4
    resource_kind: ResourceKind = Field(alias="resourceKind")
    resource_id: UUID4 = Field(alias="resourceId")
    day_of_week: DayOfWeek | None = Field(default=None, alias="dayOfWeek")
    date: str | None = Field(
        default=None,
        description="ISO date (YYYY-MM-DD) for one-off constraints; null for recurring weekly rules.",
    )
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    kind: ConstraintKind

    @field_validator("date")
    @classmethod
    def validate_iso_date(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if len(value) != 10 or value[4] != "-" or value[7] != "-":
            msg = "date must be an ISO-8601 calendar date (YYYY-MM-DD)."
            raise ValueError(msg)
        return value


class FixedLesson(CamelModel):
    """A locked master lesson the solver must plan around (never re-placed).

    Fixed lessons are hard blockers: no generated lesson may overlap a fixed
    lesson that shares its teacher, student group, or room. Times need not be
    slot-aligned — the solver rounds the blocked window outward to whole slots.
    """

    id: UUID4
    teacher_id: UUID4 | None = Field(default=None, alias="teacherId")
    co_teacher_id: UUID4 | None = Field(default=None, alias="coTeacherId")
    student_group_id: UUID4 = Field(alias="studentGroupId")
    extra_group_ids: list[UUID4] = Field(
        default_factory=list,
        alias="extraGroupIds",
        max_length=20,
        description="Additional classes attending — the blocker covers them all.",
    )
    room_id: UUID4 | None = Field(default=None, alias="roomId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


class PreviousLesson(CamelModel):
    """A slot the previous schedule used for a requirement.

    Enables minimal-disruption re-optimization: the solver is rewarded for
    keeping lesson instances of the requirement on these slots.
    """

    requirement_id: UUID4 = Field(alias="requirementId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


class ObjectiveWeights(CamelModel):
    """Per-request objective weights (override server defaults when set)."""

    preferred_free: int | None = Field(default=None, alias="preferredFree", ge=0, le=1000)
    preferred_busy: int | None = Field(default=None, alias="preferredBusy", ge=0, le=1000)
    disruption: int | None = Field(default=None, ge=0, le=1000)
    spread: int | None = Field(default=None, ge=0, le=1000)
    teacher_gap: int | None = Field(default=None, alias="teacherGap", ge=0, le=1000)


class ScheduleRules(CamelModel):
    """Optional hard scheduling rules, sent per request by the gateway."""

    lunch_start_time: str | None = Field(
        default=None, alias="lunchStartTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    lunch_end_time: str | None = Field(
        default=None, alias="lunchEndTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    lunch_minutes: int | None = Field(default=None, alias="lunchMinutes", ge=15, le=120)
    max_lessons_per_day_per_group: int | None = Field(
        default=None, alias="maxLessonsPerDayPerGroup", ge=1, le=20,
    )


class OptimizeScheduleRequest(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    academic_year_id: UUID4 = Field(alias="academicYearId")
    # Upper bounds cap the payload size so an oversized request cannot force
    # unbounded CP-SAT model construction before the solver timeout applies.
    # See also SchedulerSolver._validate_request for the aggregate complexity budget.
    requirements: list[AnonymousRequirement] = Field(min_length=1, max_length=2000)
    rooms: list[AnonymousRoom] = Field(min_length=1, max_length=1000)
    constraints: list[AnonymousConstraint] = Field(default_factory=list, max_length=5000)
    fixed_lessons: list[FixedLesson] = Field(
        default_factory=list,
        alias="fixedLessons",
        max_length=5000,
    )
    # Pairs of group ids that share at least one student (home class vs
    # teaching group, or two teaching groups with common members). Lessons for
    # such a pair are hard-forbidden from overlapping — a shared student
    # cannot be in two rooms. The gateway derives these from real membership
    # data; the engine never sees student ids.
    group_conflicts: list[tuple[UUID4, UUID4]] = Field(
        default_factory=list, alias="groupConflicts", max_length=5000,
    )
    previous_lessons: list[PreviousLesson] = Field(
        default_factory=list,
        alias="previousLessons",
        max_length=5000,
    )
    weights: ObjectiveWeights | None = None
    rules: ScheduleRules | None = None


class ScheduledLesson(CamelModel):
    requirement_id: UUID4 = Field(alias="requirementId")
    room_id: UUID4 | None = Field(default=None, alias="roomId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


class ConflictDetail(CamelModel):
    category: ConflictCategory
    message: str
    requirement_ids: list[UUID4] = Field(default_factory=list, alias="requirementIds")
    room_ids: list[UUID4] = Field(default_factory=list, alias="roomIds")
    constraint_ids: list[UUID4] = Field(default_factory=list, alias="constraintIds")
    resource_ids: list[UUID4] = Field(default_factory=list, alias="resourceIds")


class ConflictAnalysis(CamelModel):
    summary: str
    conflicts: list[ConflictDetail]


class OptimizeScheduleResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    status: SolverStatus
    lessons: list[ScheduledLesson] = Field(default_factory=list)
    conflicts: ConflictAnalysis | None = None
