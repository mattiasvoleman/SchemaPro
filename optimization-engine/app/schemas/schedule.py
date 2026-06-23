from __future__ import annotations

from typing import Literal

from pydantic import UUID4, BaseModel, ConfigDict, Field, field_validator

DayOfWeek = Literal[1, 2, 3, 4, 5, 6, 7]
ConstraintKind = Literal["UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"]
ResourceKind = Literal["TEACHER", "ROOM", "STUDENT_GROUP"]
SolverStatus = Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE"]
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
        description="Headcount used for room capacity checks when provided by the gateway.",
    )


class AnonymousRoom(CamelModel):
    id: UUID4
    capacity: int | None = Field(default=None, ge=1)


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


class OptimizeScheduleRequest(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    academic_year_id: UUID4 = Field(alias="academicYearId")
    requirements: list[AnonymousRequirement] = Field(min_length=1)
    rooms: list[AnonymousRoom] = Field(min_length=1)
    constraints: list[AnonymousConstraint] = Field(default_factory=list)


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
