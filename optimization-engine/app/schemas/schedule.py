from __future__ import annotations

from typing import Literal

from pydantic import UUID4, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.messages import render

DayOfWeek = Literal[1, 2, 3, 4, 5, 6, 7]
ConstraintKind = Literal["UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"]
# GRADE_LEVEL is the odd one out: it names no resource at all, only a span of
# years. A school that reserves 11:30 for years 4-6 owns no row called "year 5",
# and the groups the reservation must hold free are the ones whose own years
# overlap the span — a match the solver makes per requirement, which is why the
# gateway sends one rule rather than one rule per group.
RoomRuleKind = Literal["WISH", "LOCK"]
ResourceKind = Literal["TEACHER", "ROOM", "STUDENT_GROUP", "GRADE_LEVEL"]
# An opaque room-type token, not a fixed vocabulary. Room types are rows a
# school owns and names itself (Hemkunskapssal, Trä- och metallslöjd), and the
# gateway anonymises the id before it reaches here. The solver only ever
# compares tokens for equality — see SchedulerSolver._room_allowed — so it
# needs no knowledge of what any of them mean.
RoomTypeKind = str
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
    "DINING_CAPACITY",
    "AVAILABILITY",
    "INSUFFICIENT_RESOURCES",
    # The guaranteed lunch break is what leaves no room. Named beside a
    # REQUIREMENT_DEMAND when the same hours would have held the lessons
    # without it; the web has carried a label for it since the lunch shipped.
    "LUNCH_WINDOW",
    # Not a proof — a TIMEOUT has none — but a measurement: which single rule,
    # switched off, let the same week solve inside a short probe budget.
    "TIMEOUT_PROBE",
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
    #: The years this group's students actually belong to, derived by the
    #: gateway from their home classes. None when the group has no members
    #: carrying a year, in which case no room limit can be checked against it.
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
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


class AnonymousGroup(CamelModel):
    """A student group that is in the building, and the chairs it needs.

    Its own entry rather than a field on AnonymousRequirement, because being
    at school has nothing to do with having lessons left for the solver to
    place. The gateway subtracts locked lessons from a requirement's weekly
    demand and drops the requirement when the remainder reaches zero, so a
    class whose week is entirely hand-placed arrives carrying no requirement
    at all — only fixed lessons. While the headcount rode on the requirement
    that class ate nothing and took no chairs, though its locked lessons were
    visibly pushing every other group's lunch around. Thirty children were in
    the building and the hall was told about none of them.

    The gateway sends one entry per HOME CLASS that is at school this week:
    one with a requirement or a locked lesson of its own, or with a pupil who
    sits in a teaching group that has one. Not every class in the register —
    a school scheduling two classes as a trial had its other twenty-two sent
    to the hall as well, and was told the hall was too small for two.
    """

    id: UUID4
    #: How many students eat lunch *as* this group. Only home classes carry a
    #: number: a Ma71 student eats with 7A, so adding the teaching group's own
    #: headcount would seat the same child twice and shrink the hall for
    #: everyone else. 0 therefore means "already counted under another group",
    #: not "nobody eats" — and it is also what the whole payload looks like
    #: until the gateway that fills this field is deployed.
    lunch_headcount: int = Field(default=0, alias="lunchHeadcount", ge=0, le=1000)
    #: The years this group holds, derived by the gateway from its members'
    #: home classes with the group's own year as the fallback. Needed because a
    #: sitting and a frame both reach a stage, and a MEAL has no requirement to
    #: read a span off — a class whose whole week is hand-placed arrives with no
    #: requirement at all and still eats.
    #:
    #: Optional, and None means "unknown" rather than "year 0": a group with no
    #: derivable years matches no serving and no frame, and keeps the
    #: school-wide lunch window. Guessing would sweep every yearless group into
    #: a sitting written for one stage.
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )

    @model_validator(mode="after")
    def validate_span(self) -> AnonymousGroup:
        """Both years or neither, and ordered. A half span is a gateway bug."""
        if (self.min_grade_level is None) != (self.max_grade_level is None):
            msg = "A group's year span needs both bounds or neither."
            raise ValueError(msg)
        if (
            self.min_grade_level is not None
            and self.max_grade_level is not None
            and self.min_grade_level > self.max_grade_level
        ):
            msg = "minGradeLevel must not be above maxGradeLevel."
            raise ValueError(msg)
        return self


class AnonymousRoom(CamelModel):
    id: UUID4
    capacity: int | None = Field(default=None, ge=1, le=10000)
    type: RoomTypeKind | None = Field(default=None)
    #: Inclusive year range the room may host; None means no limit at that end.
    #: A school uses this to keep a stage's rooms to that stage.
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )


class AnonymousRoomPreference(CamelModel):
    """A soft wish that a subject's lessons land in particular rooms.

    Soft on purpose: a school would rather have NO in the lab, but not at the
    price of an unschedulable week. The solver pays `weight` per lesson placed
    elsewhere and trades that against the other objectives.

    Either a room type or an explicit set of rooms — the gateway sends exactly
    one of them, and a preference naming neither would be a rule that can never
    be violated or satisfied.
    """

    id: UUID4
    subject_id: UUID4 = Field(alias="subjectId")
    room_type: RoomTypeKind | None = Field(default=None, alias="roomType")
    room_ids: list[UUID4] = Field(default_factory=list, alias="roomIds")
    #: Same scale as the other objective weights (spread 3, disruption 8,
    #: preferred_free 10). Defaults to the engine's own weight_room_preference.
    weight: int = Field(default=5, ge=1, le=1000)
    #: WISH pays `weight` per lesson placed elsewhere; LOCK forbids everywhere
    #: else and the week is refused by name if that cannot be honoured.
    #:
    #: Defaulted so the engine can deploy alone against a gateway that does not
    #: send it yet — and defaulted to the half that cannot make a week
    #: impossible.
    kind: RoomRuleKind = Field(default="WISH")
    #: The years the rule applies to; None on both means every year, which is
    #: what every rule written before this field existed means.
    #:
    #: Matched by CONTAINMENT — the requirement's whole span inside this one.
    #: Overlap would let an åk 7-9 rule seize a teaching group spanning 6-7 and
    #: send year-6 pupils to a högstadie room.
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )

    @model_validator(mode="after")
    def validate_span(self) -> AnonymousRoomPreference:
        """Both years or neither, and ordered. A half span is a gateway bug."""
        if (self.min_grade_level is None) != (self.max_grade_level is None):
            msg = "A room rule's year span needs both bounds or neither."
            raise ValueError(msg)
        if (
            self.min_grade_level is not None
            and self.max_grade_level is not None
            and self.min_grade_level > self.max_grade_level
        ):
            msg = "minGradeLevel must not be above maxGradeLevel."
            raise ValueError(msg)
        return self


class AnonymousConstraint(CamelModel):
    id: UUID4
    resource_kind: ResourceKind = Field(alias="resourceKind")
    #: None only for GRADE_LEVEL, which targets a span of years instead — see
    #: validate_resource_target for why the field is optional rather than a
    #: placeholder id.
    resource_id: UUID4 | None = Field(default=None, alias="resourceId")
    #: The inclusive years a GRADE_LEVEL reservation holds free; a missing bound
    #: is open at that end, so "up to year 3" needs only maxGradeLevel. The
    #: other kinds name their resource outright and leave both unset.
    min_grade_level: int | None = Field(
        default=None, alias="minGradeLevel", ge=0, le=12,
    )
    max_grade_level: int | None = Field(
        default=None, alias="maxGradeLevel", ge=0, le=12,
    )
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

    @model_validator(mode="after")
    def validate_resource_target(self) -> AnonymousConstraint:
        """A reservation must say what it holds free — exactly one way.

        Making resourceId optional is what closes the gap this feature would
        otherwise open. The gateway builds the id from whichever of teacher,
        room or group the row carries; a year rule carries none of them, so
        the field would have had to be filled with something. Anything minted
        there points at a resource the engine has never heard of: the lock is
        accepted, validated and matches no lesson, and no layer reports a
        thing. Rejecting the shape here is the only place that failure becomes
        loud.

        For the same reason a year rule with no bound at either end is
        refused: it reads as "every year" but the gateway that built it almost
        certainly lost the range on the way.
        """
        if self.resource_kind == "GRADE_LEVEL":
            if self.resource_id is not None:
                msg = "GRADE_LEVEL constraints target a year range, not a resourceId."
                raise ValueError(msg)
            if self.min_grade_level is None and self.max_grade_level is None:
                msg = "GRADE_LEVEL constraints need minGradeLevel or maxGradeLevel."
                raise ValueError(msg)
        elif self.resource_id is None:
            msg = f"{self.resource_kind} constraints need a resourceId."
            raise ValueError(msg)
        return self


class FrameTime(CamelModel):
    """A ramtid: the hours one stage of the school may be taught in.

    The positive twin of an UNAVAILABLE constraint, and it is positive on
    purpose. A window the lessons of a stage must fall INSIDE can narrow the
    domain of the start variable, which shrinks the search; the same fact
    expressed as the holes around it can only add forbidden intervals to it.

    MATCHING IS OVERLAP AND EVERY MATCH APPLIES, so a group is bound by the
    intersection of the frames its years touch — the same overlap test
    _grade_span_overlaps uses for reservations, for the same reason: a group
    spanning years 6-7 has year-6 pupils in it, and their stage's afternoon is
    closed to them wherever they are timetabled. It is also what lets a weekday
    row and an every-day row compose with no precedence rule between them.

    Both bounds are required, unlike on a constraint. A frame with no years
    would be a school-wide day length, which is what the engine's own configured
    window already is, and a second way to say it is a second way to disagree.
    """

    min_grade_level: int = Field(alias="minGradeLevel", ge=0, le=12)
    max_grade_level: int = Field(alias="maxGradeLevel", ge=0, le=12)
    #: ISO weekday, or None for every teaching day.
    day_of_week: DayOfWeek | None = Field(default=None, alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    #: Minutes a body needs between two lessons. MAX over matching frames.
    changeover_minutes: int = Field(
        default=0, alias="changeoverMinutes", ge=0, le=60,
    )

    @model_validator(mode="after")
    def validate_window(self) -> FrameTime:
        """A frame has to hold something, and its years have to be a span.

        Checked here rather than left to the solver because an empty or
        inverted frame closes a stage's whole week, and the model would then be
        infeasible with nothing to point at. A 422 naming the row is an answer;
        "no feasible schedule" is not.
        """
        if self.min_grade_level > self.max_grade_level:
            msg = "minGradeLevel must not be above maxGradeLevel."
            raise ValueError(msg)
        if self.start_time >= self.end_time:
            msg = "startTime must be before endTime."
            raise ValueError(msg)
        return self


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
    #: Paid per lesson that misses its subject's preferred rooms.
    room_preference: int | None = Field(
        default=None, alias="roomPreference", ge=0, le=1000,
    )


class ScheduleRules(CamelModel):
    """Optional hard scheduling rules, sent per request by the gateway."""

    lunch_start_time: str | None = Field(
        default=None, alias="lunchStartTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    lunch_end_time: str | None = Field(
        default=None, alias="lunchEndTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    lunch_minutes: int | None = Field(default=None, alias="lunchMinutes", ge=15, le=120)
    #: Seats in the dining hall, which is what forces lunch to be staggered:
    #: without it the solver only guarantees every group a free window and is
    #: free to send the whole school in at 11:30. None means the school has not
    #: defined a limit, and then the seat machinery is not built at all — no
    #: sittings, no cumulative, no literal standing for the hall. Most schools
    #: have room to spare and should not pay a search for counting who sits
    #: when.
    dining_seats: int | None = Field(default=None, alias="diningSeats", ge=1, le=5000)
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
    # Who is in the building, which is not the same list as who has lessons to
    # place — see AnonymousGroup. Optional so the engine can ship before the
    # gateway that fills it: until then the lunch guarantee still reaches every
    # group with requirements, and the hall simply hears about nobody.
    groups: list[AnonymousGroup] = Field(default_factory=list, max_length=2000)
    rooms: list[AnonymousRoom] = Field(min_length=1, max_length=1000)
    constraints: list[AnonymousConstraint] = Field(default_factory=list, max_length=5000)
    # Ramtider. Optional so the engine can ship before the gateway that fills
    # it: with none, every stage may use the whole configured day, which is
    # exactly the behaviour that existed before frames did. The cap is generous
    # against the real shape — thirteen years by seven weekdays is 91 rows even
    # if a school writes one frame per single year per day.
    frame_times: list[FrameTime] = Field(
        default_factory=list, alias="frameTimes", max_length=500,
    )
    # Lunchsittningar. Empty means every stage may eat anywhere in the school's
    # lunch window, which is the behaviour that existed before servings did.
    lunch_servings: list[LunchServing] = Field(
        default_factory=list, alias="lunchServings", max_length=500,
    )
    # Raster. Empty means no stage has a declared break, which is the behaviour
    # every school had before this field existed — and the behaviour the rektor
    # reported as lessons placed edge to edge.
    rasts: list[Rast] = Field(
        default_factory=list, alias="rasts", max_length=500,
    )
    room_preferences: list[AnonymousRoomPreference] = Field(
        default_factory=list,
        alias="roomPreferences",
        max_length=500,
        description="Soft wishes that a subject's lessons land in particular rooms.",
    )
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

    @field_validator("group_conflicts")
    @classmethod
    def drop_self_pairs(
        cls, value: list[tuple[UUID4, UUID4]],
    ) -> list[tuple[UUID4, UUID4]]:
        """Strip (A, A) pairs — a group always shares students with itself.

        Membership-derived data can emit a self-pair (an unfiltered self-join
        on the gateway side); it states nothing the per-group NoOverlap does
        not already enforce. Dropping it here rather than rejecting the
        request keeps one vacuous pair from 422-ing an entire optimisation
        run, and keeps every consumer of the list honest: read literally, a
        self-pair makes the solver INFEASIBLE and makes the benchmark
        validator report every lesson as overlapping itself.
        """
        return [(first, second) for first, second in value if first != second]


class ScheduledLesson(CamelModel):
    requirement_id: UUID4 = Field(alias="requirementId")
    room_id: UUID4 | None = Field(default=None, alias="roomId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


class LunchServing(CamelModel):
    """A lunchsittning: the window one stage of the school may eat in.

    The declaration half of the flow. The school states WHEN a stage eats; the
    solver still decides which class goes when inside that window, and the seat
    cumulative splits a stage too big for the hall into waves.

    Windows UNION across matching servings — the opposite of FrameTime, which
    intersects — because a serving grants permission where a frame imposes a
    bound. A day-specific row replaces the every-day row for that day. See
    app/solver/servings.py, which owns the rules.
    """

    min_grade_level: int = Field(alias="minGradeLevel", ge=0, le=12)
    max_grade_level: int = Field(alias="maxGradeLevel", ge=0, le=12)
    #: ISO weekday, or None for every teaching day.
    day_of_week: DayOfWeek | None = Field(default=None, alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    #: Chairs for THIS sitting; None means the hall's own diningSeats.
    seats: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_window(self) -> LunchServing:
        """A sitting has to hold something, and its years have to be a span.

        Checked here rather than left to the solver because an inverted window
        empties a stage's whole domain, and the model would then be infeasible
        with nothing to point at. A 422 naming the row is an answer.
        """
        if self.min_grade_level > self.max_grade_level:
            msg = "minGradeLevel must not be above maxGradeLevel."
            raise ValueError(msg)
        if self.start_time >= self.end_time:
            msg = "startTime must be before endTime."
            raise ValueError(msg)
        return self


class Rast(CamelModel):
    """A rast: minutes of a day one stage of the school is not taught.

    The whole declaration, unlike a LunchServing — nothing about a rast is
    chosen by the solver, so there is no second half. The engine subtracts it
    from every matching lesson's start domain, which costs no variables and
    leaves a strictly smaller search space.

    Every matching row APPLIES, and the union is an obligation where a serving's
    is a permission. A day-specific row shadows only the every-day rows it
    OVERLAPS — narrower than the serving rule, because several rasts a day is
    the ordinary Swedish week and replacing all of them would silently delete a
    stage's other Friday breaks. See app/solver/rasts.py, which owns the rules.
    """

    min_grade_level: int = Field(alias="minGradeLevel", ge=0, le=12)
    max_grade_level: int = Field(alias="maxGradeLevel", ge=0, le=12)
    #: ISO weekday, or None for every teaching day.
    day_of_week: DayOfWeek | None = Field(default=None, alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    #: Whether the stretch ENDING at this rast must hold a lesson.
    #:
    #: A rast is otherwise only a hole in the day, and a class whose Monday
    #: begins at the morning break has broken no rule the engine knows. This
    #: turns the hole into an obligation, counted from the previous break —
    #: the rast before it, or the class's own lunch. See
    #: SchedulerSolver._add_rast_ordering_constraints, which owns the counting.
    #:
    #: False by default: the constraint roughly doubles the model's variables,
    #: and a school that has not asked for it should not pay for it.
    requires_lesson_before: bool = Field(
        default=False, alias="requiresLessonBefore",
    )

    @model_validator(mode="after")
    def validate_window(self) -> Rast:
        """A rast has to hold something, and its years have to be a span.

        Checked here rather than left to the solver for the same reason a
        serving is: an inverted window would subtract a nonsensical range from
        every matching lesson's domain, and the model would be infeasible with
        nothing to point at. A 422 naming the row is an answer.

        There is deliberately no MINIMUM length. Three minutes is what a
        changeover between two rooms is, and blocks_for rounds outward to a
        whole slot rather than to nothing.
        """
        if self.min_grade_level > self.max_grade_level:
            msg = "minGradeLevel must not be above maxGradeLevel."
            raise ValueError(msg)
        if self.start_time >= self.end_time:
            msg = "startTime must be before endTime."
            raise ValueError(msg)
        return self


class ScheduledLunch(CamelModel):
    """When one student group eats, on one day.

    The solver has always decided this — `lunchstart_<group>_<day>` is a real
    decision variable, constrained against the group's lessons and against the
    dining hall's seats. It was simply never read back, which is why a school
    could see the reserved gap in its timetable and nothing in it. The engine's
    own test helper says so: "the chosen lunch start exists nowhere outside the
    model — a known gap that also leaves benchmarks/validate_schedule.py unable
    to check the rule".

    NOT a ScheduledLesson, and it could not be one: that type is keyed on
    `requirementId` and a meal has no teaching requirement. A separate list also
    keeps every existing assertion on `len(response.lessons)` meaning what it
    meant before.
    """

    student_group_id: UUID4 = Field(alias="studentGroupId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


class ConflictDetail(CamelModel):
    """One cause, in a form every reader can render in its own language.

    `code` names the sentence and `params` are the values it substitutes;
    `message` is that sentence rendered in English by app/messages.py, and is
    derived rather than passed — a call site that wrote its own text would,
    sooner or later, name one sentence and say another, and a school would
    read the Swedish for the first and the English for the second.

    PARAMS ARE SCALARS. A sentence about several groups names them through
    `resource_ids`, which the gateway turns into the school's own names and
    the page lists itself; a list joined into a string here would be a list
    punctuated in English inside a Swedish sentence.
    """

    category: ConflictCategory
    code: str
    #: Floats allowed for the one thing measured rather than counted: the
    #: seconds a probe took. ICU renders a number in the reader's own
    #: notation, so 0.1 s reaches a Swedish screen as "0,1 s".
    params: dict[str, str | int | float] = Field(default_factory=dict)
    message: str = ""
    requirement_ids: list[UUID4] = Field(default_factory=list, alias="requirementIds")
    room_ids: list[UUID4] = Field(default_factory=list, alias="roomIds")
    constraint_ids: list[UUID4] = Field(default_factory=list, alias="constraintIds")
    resource_ids: list[UUID4] = Field(default_factory=list, alias="resourceIds")

    @model_validator(mode="after")
    def _render_message(self) -> ConflictDetail:
        if not self.message:
            object.__setattr__(self, "message", render(self.code, self.params))
        return self


class ConflictAnalysis(CamelModel):
    """The refusal: a headline and the causes under it.

    `summary_code` and `summary_params` are to `summary` what a detail's code
    is to its message — see ConflictDetail.
    """

    summary: str = ""
    summary_code: str = Field(default="", alias="summaryCode")
    summary_params: dict[str, str | int | float] = Field(
        default_factory=dict, alias="summaryParams",
    )
    conflicts: list[ConflictDetail]

    @model_validator(mode="after")
    def _render_summary(self) -> ConflictAnalysis:
        if not self.summary and self.summary_code:
            object.__setattr__(self, "summary", render(self.summary_code, self.summary_params))
        return self


class OptimizeScheduleResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    status: SolverStatus
    lessons: list[ScheduledLesson]
    #: The sittings the solver chose. Defaults to empty so an older gateway
    #: reading this response is unaffected, and so every response built on a
    #: failure path stays valid without naming the field.
    lunches: list[ScheduledLunch] = Field(default_factory=list)
    conflicts: ConflictAnalysis | None = None
