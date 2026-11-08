"""The exam planner's wire models: POST /api/v1/plan-exams.

A fourth request beside the generator's, the room optimiser's and the staffing
proposal's, because it asks a fourth question. The generator places lessons in
a week; this places the PRÖV of a provvecka (or of fixed dates) into times the
gateway has already found possible, picks the rooms they are written in and
the teachers who invigilate, and says in a named reason why an exam was left
out. It is small on purpose: 20-30 exams, a few exam rooms, a pool of
invigilators.

WHAT CROSSES. Opaque ids minted fresh by the gateway for every request
(exams, classes, rooms, teachers), whole minutes, running day and week
indices, counts and booleans. Never a name, a date, a subject, a pupil or a
signature. The gateway has already decided which times an exam MAY have and
what each costs (`loss`: the lesson minutes the exam cancels beyond its own
subject's), which room and which teacher is busy at which of them (blocks),
and what each class already has that day and week (existingDayLoad,
existingWeekLoad). The engine only chooses.

Every name below is also listed by hand in tests/test_exams.py and in the
gateway's contract spec. CamelModel forbids extra fields, so a field one side
sends and the other has not heard of is a 422 for the whole plan — change both
lists in the commit that deploys the engine, engine first.
"""

from __future__ import annotations

from typing import Literal

from pydantic import UUID4, Field, model_validator

from app.messages import render
from app.schemas.schedule import CamelModel

#: Never INFEASIBLE and never TIMEOUT: leaving every exam unplaced always
#: satisfies every rule, so the worst this can say is "the best found inside
#: the time".
ExamSolveStatus = Literal["OPTIMAL", "FEASIBLE"]

#: Why an exam ends unplaced, judged on the final answer (ExamSolver reasons).
ExamUnplacedReason = Literal[
    "EXAM_NO_SLOT",
    "EXAM_NO_ROOM_SEATS",
    "EXAM_NO_INVIGILATORS",
    "EXAM_CLASS_DAY_CAP",
    "EXAM_CLASS_WEEK_CAP",
    "EXAM_CLASS_CLASH",
    "EXAM_ROOMS_TAKEN",
    "EXAM_INVIGILATORS_TAKEN",
    "EXAM_NOT_REACHED",
]


class ExamSlot(CamelModel):
    """One time an exam may be held: a running day, its week, a start minute.

    `day` is a running index (the gateway counts from the start of the
    window), so two exams on the same `day` are on the same calendar day and
    `week` groups days for the weekly cap. `loss` is the lesson minutes the
    exam cancels at this time beyond what its own subject would have used —
    the gateway counts them from the timetable; the engine only adds them up.
    """

    day: int = Field(ge=0, le=400)
    week: int = Field(ge=0, le=60)
    start: int = Field(ge=0, le=1439)
    loss: int = Field(ge=0, le=100000)


class ExamBlock(CamelModel):
    """A room or a teacher that is busy at some of an exam's slots.

    `slots` are indices into THE EXAM'S `slots`. A resource an exam's blocks
    do not name is free at every slot of that exam.
    """

    id: UUID4
    slots: list[int] = Field(max_length=500)


class ExamIn(CamelModel):
    id: UUID4
    #: Minutes the pupils write.
    length: int = Field(ge=5, le=480)
    #: Pupils who write it, across the classes.
    writers: int = Field(ge=1, le=2000)
    #: The home classes that have writers. They share the exam's conflicts and
    #: caps: a class sits at most one exam at a time, at most so many a day.
    classes: list[UUID4] = Field(min_length=1, max_length=40)
    slots: list[ExamSlot] = Field(max_length=500)
    room_blocks: list[ExamBlock] = Field(default_factory=list, alias="roomBlocks", max_length=100)
    teacher_blocks: list[ExamBlock] = Field(
        default_factory=list, alias="teacherBlocks", max_length=1000,
    )
    #: A nationellt prov: exactly one slot, never moved, but its rooms and
    #: invigilators are chosen. Placed before anything that is not fixed when
    #: they compete.
    fixed: bool = False


class ExamRoomIn(CamelModel):
    id: UUID4
    #: Writing places, not the room's ordinary capacity.
    seats: int = Field(ge=1, le=2000)


class InvigilatorIn(CamelModel):
    id: UUID4
    #: The invigilation minutes the teacher has already carried this year: the
    #: counter that makes the shares fair over the whole läsår.
    prior: int = Field(ge=0, le=100000)


class ExamLimits(CamelModel):
    max_per_class_per_day: int = Field(alias="maxPerClassPerDay", ge=1, le=10)
    max_per_class_per_week: int = Field(alias="maxPerClassPerWeek", ge=1, le=30)
    #: A room with x writers needs max(1, ceil(x / ratio)) invigilators.
    writers_per_invigilator: int = Field(alias="writersPerInvigilator", ge=1, le=200)
    #: Minutes a room or an invigilator needs after an exam before the next
    #: one may begin (length + turnover is the stretch they are held).
    turnover_minutes: int = Field(alias="turnoverMinutes", ge=0, le=120)


class ExamWeights(CamelModel):
    """The soft terms' weights, each 0..100.

    Placing as many exams as possible is NOT among them: it outweighs all of
    them together (ExamSolver). The units: `loss` per cancelled lesson minute,
    `rooms` per room beyond an exam's first, `spread` per exam placed on a day
    its class already has one, and `fairness` per half hour (30 minutes) of
    invigilation a teacher carries above each of eight thresholds a half hour
    apart, starting at the lowest prior of the teachers who can invigilate —
    so every extra half hour costs more the more the teacher already has.
    """

    loss: int = Field(default=10, ge=0, le=100)
    rooms: int = Field(default=30, ge=0, le=100)
    fairness: int = Field(default=5, ge=0, le=100)
    spread: int = Field(default=2, ge=0, le=100)


class ExamClassDayLoad(CamelModel):
    """Exams a class already has on a day, from outside this plan."""

    class_id: UUID4 = Field(alias="class")
    day: int = Field(ge=0, le=400)
    count: int = Field(ge=0, le=100)


class ExamClassWeekLoad(CamelModel):
    class_id: UUID4 = Field(alias="class")
    week: int = Field(ge=0, le=60)
    count: int = Field(ge=0, le=100)


class ExamSearch(CamelModel):
    """How one request's search is run. NEVER WHAT IS SEARCHED FOR.

    The budget can only shrink: `maxTimeSeconds` is min'd with the engine's
    EXAM_SOLVER_MAX_TIME_SECONDS, so no caller buys a longer turn on a shared
    machine than the deployment gives the button.
    """

    max_time_seconds: float | None = Field(default=None, alias="maxTimeSeconds", gt=0, le=600)
    workers: int | None = Field(default=None, ge=1, le=16)
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)


class PlanExamsRequest(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    exams: list[ExamIn] = Field(min_length=1, max_length=300)
    rooms: list[ExamRoomIn] = Field(default_factory=list, max_length=100)
    teachers: list[InvigilatorIn] = Field(default_factory=list, max_length=1000)
    limits: ExamLimits
    weights: ExamWeights = Field(default_factory=ExamWeights)
    existing_day_load: list[ExamClassDayLoad] = Field(
        default_factory=list, alias="existingDayLoad", max_length=50000,
    )
    existing_week_load: list[ExamClassWeekLoad] = Field(
        default_factory=list, alias="existingWeekLoad", max_length=20000,
    )
    search: ExamSearch | None = None

    @model_validator(mode="after")
    def validate_references(self) -> PlanExamsRequest:
        """Unique ids, and every id a block names is in the payload.

        A room or teacher id nobody sent is the gateway having dropped a row
        of its map; reading it as "some other room" would put an exam in a
        room the gateway cannot name on the way back. Loud instead.
        """
        if len({exam.id for exam in self.exams}) != len(self.exams):
            msg = "Exam ids must be unique."
            raise ValueError(msg)
        room_ids = {room.id for room in self.rooms}
        if len(room_ids) != len(self.rooms):
            msg = "Room ids must be unique."
            raise ValueError(msg)
        teacher_ids = {teacher.id for teacher in self.teachers}
        if len(teacher_ids) != len(self.teachers):
            msg = "Teacher ids must be unique."
            raise ValueError(msg)
        for exam in self.exams:
            if len(set(exam.classes)) != len(exam.classes):
                msg = f"Exam {exam.id} names a class twice."
                raise ValueError(msg)
            starts = {(slot.day, slot.start) for slot in exam.slots}
            if len(starts) != len(exam.slots):
                msg = f"Exam {exam.id} has two slots at the same day and start."
                raise ValueError(msg)
            if exam.fixed and len(exam.slots) > 1:
                msg = f"Exam {exam.id} is fixed and has more than one slot."
                raise ValueError(msg)
            for kind, blocks, known in (
                ("room", exam.room_blocks, room_ids),
                ("teacher", exam.teacher_blocks, teacher_ids),
            ):
                named = [block.id for block in blocks]
                if len(set(named)) != len(named):
                    msg = f"Exam {exam.id} blocks a {kind} twice."
                    raise ValueError(msg)
                if not known.issuperset(named):
                    msg = f"Exam {exam.id} blocks a {kind} that is not in the request."
                    raise ValueError(msg)
                for block in blocks:
                    if any(not 0 <= index < len(exam.slots) for index in block.slots):
                        msg = f"Exam {exam.id} blocks a {kind} at a slot it does not have."
                        raise ValueError(msg)
                    if len(set(block.slots)) != len(block.slots):
                        msg = f"Exam {exam.id} blocks a {kind} at one slot twice."
                        raise ValueError(msg)
        days = [(load.class_id, load.day) for load in self.existing_day_load]
        if len(set(days)) != len(days):
            msg = "existingDayLoad names a class and day twice."
            raise ValueError(msg)
        weeks = [(load.class_id, load.week) for load in self.existing_week_load]
        if len(set(weeks)) != len(weeks):
            msg = "existingWeekLoad names a class and week twice."
            raise ValueError(msg)
        return self


class PlacedRoom(CamelModel):
    room: UUID4
    writers: int
    invigilators: list[UUID4]


class PlacedExam(CamelModel):
    exam: UUID4
    #: Index into the exam's own `slots`.
    slot: int
    rooms: list[PlacedRoom]


class UnplacedExam(CamelModel):
    """An exam left out, with the one rule that most often stopped it.

    Shaped like ConflictDetail and StaffConflict: a code, the flat params the
    sentence substitutes, and the English rendered FROM the code. A class
    appears only as an opaque id (`classId`) in the params of the class
    reasons, which the gateway maps back; the sentence never holds one.
    """

    exam: UUID4
    reason: ExamUnplacedReason
    params: dict[str, str | int] = Field(default_factory=dict)
    message: str = ""

    @model_validator(mode="after")
    def _render_message(self) -> UnplacedExam:
        if not self.message:
            object.__setattr__(self, "message", render(self.reason, self.params))
        return self


class InvigilatorMinutes(CamelModel):
    teacher: UUID4
    minutes: int


class ExamMetrics(CamelModel):
    """One answer's numbers, each a plain count.

    `loss` is the cancelled lesson minutes of the placed exams' slots.
    `roomsUsed` counts a room once per exam it is used for, `invigilatorPasses`
    one per teacher per exam. `maxLoad` and `minLoad` are the highest and the
    lowest of prior + this run's invigilation minutes over the whole pool
    (0 and 0 with no teachers).
    """

    placed: int
    unplaced: int
    loss: int
    rooms_used: int = Field(alias="roomsUsed")
    invigilator_passes: int = Field(alias="invigilatorPasses")
    max_load: int = Field(alias="maxLoad")
    min_load: int = Field(alias="minLoad")
    solve_seconds: float = Field(alias="solveSeconds")


class PlanExamsResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    status: ExamSolveStatus
    placed: list[PlacedExam]
    unplaced: list[UnplacedExam]
    invigilator_minutes: list[InvigilatorMinutes] = Field(alias="invigilatorMinutes")
    metrics: ExamMetrics
