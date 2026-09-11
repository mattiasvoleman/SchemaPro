"""The room optimisation's wire models: POST /api/v1/optimize-rooms.

A separate request from OptimizeScheduleRequest because it asks a different
question. The generator places DEMAND (a requirement, n lessons a week) into
time; this re-assigns the ROOMS of a timetable that already exists, with every
time, teacher, group and date held exactly as the school has it. So a lesson
here is a placed MasterLesson, not a requirement, and it carries the fields
eligibility needs directly on itself.

Every name below is also listed by hand in tests/test_room_walks.py and in the
gateway's src/optimization/ai-engine-contract.spec.ts. CamelModel forbids extra
fields, so a field one side sends and the other has not heard of is a 422 for
the whole proposal — change both lists in the commit that deploys the engine.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import UUID4, Field, model_validator

from app.schemas.schedule import (
    AnonymousConstraint,
    AnonymousRoomPreference,
    CamelModel,
    DayOfWeek,
    RoomTypeKind,
)

#: Whose walking the objective counts. Both kinds are always TALLIED, so a
#: school that spares its teachers can see what that did to its classes.
WalkerScope = Literal["TEACHERS", "GROUPS", "BOTH"]
WalkerKind = Literal["TEACHER", "GROUP"]
Recurrence = Literal["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"]
#: Never INFEASIBLE and never TIMEOUT: the school's current rooms are always a
#: valid answer, so the worst this can say is "nothing better was found".
RoomSolveStatus = Literal["OPTIMAL", "FEASIBLE"]

_CLOCK = r"^\d{2}:\d{2}:\d{2}$"


def _clock_minutes(value: str) -> int:
    hours, minutes, _seconds = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


class WalkRoom(CamelModel):
    """A room, with where it is.

    The eligibility fields carry the SAME names as AnonymousRoom on purpose:
    SchedulerSolver._room_allowed and the lock resolution read them off this
    object unchanged, which is what makes "a lesson may only move where the
    generator would have put it" one rule rather than two copies of it.
    """

    id: UUID4
    capacity: int | None = Field(default=None, ge=1, le=10000)
    type: RoomTypeKind | None = Field(default=None)
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )
    #: An opaque token, like a room type. Buildings are names a school writes
    #: ("Hus B", "Gamla skolan") and the gateway anonymises them; the engine
    #: only ever asks whether two rooms share one, so it needs nothing else.
    #: None is itself a value: two rooms with no building are compared as
    #: being in the same (unnamed) one, which is how most one-house schools
    #: will leave the field.
    building: str | None = Field(default=None, min_length=1, max_length=200)
    #: The storey; unknown when None, and an unknown floor never counts as a
    #: floor change — guessing either way would steer rooms on a fact nobody
    #: gave us. Same bounds as the database check.
    floor: int | None = Field(default=None, ge=-5, le=50)


class PlacedLesson(CamelModel):
    """One lesson of the current grundschema, exactly where it is.

    The eligibility fields (id, subject_id, student_group_size,
    required_room_type, min_grade_level, max_grade_level) carry
    AnonymousRequirement's attribute names on purpose, for the same reason as
    WalkRoom's: the generator's own predicates read them off this object.
    """

    id: UUID4
    subject_id: UUID4 = Field(alias="subjectId")
    student_group_id: UUID4 = Field(alias="studentGroupId")
    extra_group_ids: list[UUID4] = Field(
        default_factory=list, alias="extraGroupIds", max_length=20,
    )
    teacher_id: UUID4 | None = Field(default=None, alias="teacherId")
    co_teacher_id: UUID4 | None = Field(default=None, alias="coTeacherId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=_CLOCK)
    end_time: str = Field(alias="endTime", pattern=_CLOCK)
    recurrence: Recurrence
    #: Inclusive; None is "from the start of the year" / "until it ends", as in
    #: src/calendar/lesson-recurrence.ts, whose weeksCanOverlap this mirrors.
    start_date: date | None = Field(default=None, alias="startDate")
    end_date: date | None = Field(default=None, alias="endDate")
    #: None is a lesson the school has not given a room. It is never given one
    #: here — that is a decision about the lesson, not about walking — but it
    #: is still sent, because a teacher who has it between two others does
    #: not walk straight from the first to the third.
    room_id: UUID4 | None = Field(default=None, alias="roomId")
    #: False for a locked lesson: its room is part of the lock.
    movable: bool
    student_group_size: int = Field(alias="studentGroupSize", ge=1, le=1000)
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )
    required_room_type: RoomTypeKind | None = Field(
        default=None, alias="requiredRoomType",
    )

    @model_validator(mode="after")
    def validate_times(self) -> PlacedLesson:
        """A lesson that ends when it starts occupies nothing and walks nowhere.

        Refused rather than read as empty: the half-open overlap rule would let
        it share any room with anything, and a pair built on it would put a
        walker in two places at one instant. The database cannot hold one, so
        seeing it here is a gateway bug.
        """
        if _clock_minutes(self.end_time) <= _clock_minutes(self.start_time):
            msg = "endTime must be after startTime."
            raise ValueError(msg)
        return self


class OptimizeRoomsRequest(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    walkers: WalkerScope
    rooms: list[WalkRoom] = Field(min_length=1, max_length=1000)
    lessons: list[PlacedLesson] = Field(min_length=1, max_length=5000)
    #: The generator's own rule rows, reused whole. WISHes steer; LOCKs narrow
    #: where a lesson may MOVE, exactly as they narrow where it may be placed.
    room_preferences: list[AnonymousRoomPreference] = Field(
        default_factory=list, alias="roomPreferences", max_length=500,
    )
    #: Only undated UNAVAILABLE rows on a ROOM are read — they close a room to
    #: lessons moving in. Every other row is about time, and no time changes.
    constraints: list[AnonymousConstraint] = Field(
        default_factory=list, max_length=5000,
    )

    @model_validator(mode="after")
    def validate_references(self) -> OptimizeRoomsRequest:
        """Every room a lesson names is in the payload, and ids are unique.

        A lesson in a room the engine has not been told about cannot be
        checked for clashes against anything — and the solver would treat the
        room as free, moving another lesson into it. That is the gateway having
        dropped a row, and it has to be loud rather than become a proposal.
        Duplicate ids would silently collapse two lessons (or rooms) into one
        in every lookup keyed by id.
        """
        room_ids = {room.id for room in self.rooms}
        if len(room_ids) != len(self.rooms):
            msg = "Room ids must be unique."
            raise ValueError(msg)
        if len({lesson.id for lesson in self.lessons}) != len(self.lessons):
            msg = "Lesson ids must be unique."
            raise ValueError(msg)
        for lesson in self.lessons:
            if lesson.room_id is not None and lesson.room_id not in room_ids:
                msg = f"Lesson {lesson.id} names a room that is not in rooms."
                raise ValueError(msg)
        return self


class Walk(CamelModel):
    """How far the walkers go, counted per consecutive pair of lessons."""

    room_changes: int = Field(alias="roomChanges", ge=0)
    floor_changes: int = Field(alias="floorChanges", ge=0)
    building_changes: int = Field(alias="buildingChanges", ge=0)


class WalkComparison(CamelModel):
    before: Walk
    after: Walk


class CountComparison(CamelModel):
    before: int = Field(ge=0)
    after: int = Field(ge=0)


class RoomChange(CamelModel):
    lesson_id: UUID4 = Field(alias="lessonId")
    room_id: UUID4 = Field(alias="roomId")


class WalkerWalk(CamelModel):
    kind: WalkerKind
    id: UUID4
    before: Walk
    after: Walk


class OptimizeRoomsResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    status: RoomSolveStatus
    #: Only lessons whose room changed. Empty is an answer, not a failure.
    changes: list[RoomChange]
    teachers: WalkComparison
    groups: WalkComparison
    missed_wishes: CountComparison = Field(alias="missedWishes")
    #: Every walker whose own walk changed, most improved first.
    walkers: list[WalkerWalk]
    #: Movable lessons already sharing a room with a lesson they meet. Left
    #: exactly where they are — a shared hall may well be deliberate.
    frozen_lesson_ids: list[UUID4] = Field(alias="frozenLessonIds")
