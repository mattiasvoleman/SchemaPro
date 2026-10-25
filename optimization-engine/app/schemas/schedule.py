from __future__ import annotations

from typing import Annotated, Literal

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
    # The guaranteed lunch break is part of what leaves no room. Named beside
    # a REQUIREMENT_DEMAND when the same count without it would have let the
    # lessons through; the web has carried a label for it since the lunch
    # shipped.
    "LUNCH_WINDOW",
    # Not a proof — a TIMEOUT has none — but a measurement: which single rule,
    # switched off, let the same week solve inside a short probe budget.
    "TIMEOUT_PROBE",
    # Ämnesfördelning: a requirement's own rule about how its lessons spread
    # over the week — at most N a day, no two days in a row. A category of its
    # own rather than REQUIREMENT_DEMAND, because the fix is a different row on
    # a different screen: the subject's rule, not the lessons per week.
    "SUBJECT_DISTRIBUTION",
    # Parallella block: requirements the school runs at the same times
    # (språkval, elevens val). A category of its own because the fix is the
    # block on the timplan page, not any one of its rows.
    "TEACHING_BLOCK",
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
    #: Minutes the PUPILS need on either side of the lesson and nobody else:
    #: changing before idrotten, showering and changing after it.
    #:
    #: OUTSIDE THE LESSON. Teaching is still minutes_per_lesson — the hour the
    #: timplan owes the subject is untouched, and the class is merely occupied
    #: from start - minutesBefore to end + minutesAfter. Folding the time into
    #: the lesson instead would have paid a school's idrott out of its own
    #: hours, and the school's own screens would show a lesson it does not give.
    #:
    #: PER REQUIREMENT, not per subject, because the same subject is not the
    #: same errand twice: a year-2 class changing its shoes needs five minutes
    #: where a year-9 class that showers needs twenty, and one Idrott row
    #: serves both.
    #:
    #: WHAT THEY BLOCK IS THE PUPILS: their own class, every group that shares
    #: their pupils, and their lunch. Not the teacher, who walks in as the
    #: lesson starts and may take another class the minute it ends, and not the
    #: room, which the next class can be changing for while this one showers.
    #: A margin that every body around a lesson needs is what a frame's
    #: changeoverMinutes says, and it says it for all of them at once; this one
    #: is asymmetric on purpose, because only one set of bodies is undressed.
    minutes_before: int = Field(default=0, alias="minutesBefore", ge=0, le=60)
    minutes_after: int = Field(default=0, alias="minutesAfter", ge=0, le=60)
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
    #: Lektionslängder: one length per lesson of the week when the lessons are
    #: NOT all one length — [80, 40] is idrott as "1 × 80 + 1 × 40". Absent on
    #: a uniform requirement, which is then lessons_per_week lessons of
    #: minutes_per_lesson exactly as before; the gateway sends the key only
    #: when the lessons it still wants placed have two or more lengths, so a
    #: uniform payload is byte for byte what it was.
    #:
    #: ONE REQUIREMENT, NOT ONE PER LENGTH. Splitting [80, 40] into two
    #: requirements would give them two ids, and everything keyed on the id —
    #: the spread across days, the disruption term, the previous-lesson hints,
    #: every refusal that names a requirement — would treat idrott as two
    #: subjects that may happily share a Monday.
    #:
    #: THE SCALARS STAY TRUE: lessons_per_week is the list's length and
    #: minutes_per_lesson its longest (the validator below), so every reader
    #: that asks whether "a lesson of this requirement" fits a frame, a margin
    #: or a rast reads the length that binds, and every count stays a count.
    #: Only the sites that place or measure EACH lesson read lesson_minutes().
    lesson_lengths: list[Annotated[int, Field(ge=15, le=240)]] | None = Field(
        default=None, alias="lessonLengths", min_length=1, max_length=40,
    )
    #: Ämnesfördelning: at most this many of the requirement's lessons on any
    #: one weekday. 1 is "inte två gånger samma dag". None means no rule, which
    #: is every requirement whose school has not written one — rules are off
    #: until a school sets them, and the gateway sends the key only when one is
    #: set, so a payload without rules is byte for byte what it was.
    #:
    #: THE WHOLE WEEK COUNTS, not only what the solver places: lockedDays below
    #: carries the lessons already placed by hand, which reach this engine as
    #: fixed lessons with no requirement id at all.
    max_lessons_per_day: int | None = Field(
        default=None, alias="maxLessonsPerDay", ge=1, le=20,
    )
    #: Ämnesfördelning: two weekdays that both hold a lesson of the requirement
    #: lie at least this many days apart. 2 is "inte dagar i följd" — Monday
    #: and Wednesday, never Monday and Tuesday. Counted in ISO weekdays and not
    #: in positions in the school's week, so a school that teaches Monday,
    #: Wednesday and Friday has no two days in a row; and not across the
    #: weekend, because the timetable is one week and Friday's lesson does not
    #: meet next Monday's in it.
    #:
    #: SAME-DAY LESSONS ARE NOT ITS BUSINESS. Two lessons on Monday are one day
    #: with lessons, and whether that is allowed is max_lessons_per_day's
    #: question. Folding it in here would leave a school no way to say "a
    #: double lesson is fine, but not Monday and Tuesday".
    min_days_between: int | None = Field(
        default=None, alias="minDaysBetween", ge=2, le=6,
    )
    #: The weekday of every lesson of this requirement the school placed by
    #: hand, once per lesson: [1, 1] is two on Monday. A locked lesson reaches
    #: this engine as a FixedLesson, which names a teacher, a group and a room
    #: and no requirement — so a rule that read only the lessons it places
    #: would accept a generated Monday lesson beside a locked one under "at most
    #: one a day". Sent with a rule and never without one, since nothing else
    #: reads it.
    #:
    #: THE LOCKED LESSONS ARE FACTS, NOT CANDIDATES. Two the school locked onto
    #: Monday break "at most one a day" on their own, and that is the school's
    #: hand edit, which already warned it; refusing the week for them would
    #: turn a warning into a block one screen later. What the rule holds is
    #: every lesson the solver places: it takes no Monday there, and none on a
    #: day next to one.
    #:
    #: Up to 80, twice the most lessons a week a requirement can have, because
    #: a school locking alternating weeks holds two lessons where it teaches
    #: one — the engine has no weeks and counts them both.
    locked_days: list[DayOfWeek] = Field(
        default_factory=list, alias="lockedDays", max_length=80,
    )
    #: Parallella block: the anonymous id of the block this requirement runs
    #: in, shared by every member. Språkval åk 7 is Tyska for Ty7, Franska for
    #: Fr7 and Spanska for Sp7, and the k-th lesson of each starts when the
    #: k-th lesson of the others does — so the block takes one slot of 7A's
    #: week per lesson, not one per language.
    #:
    #: OPTIONAL AND ADDITIVE. None is a requirement in no block, which is every
    #: requirement of every school until one writes a block; the gateway sends
    #: the key only on a member of a block with two or more members still to
    #: place, so a payload without blocks is byte for byte what it was.
    #:
    #: THE MEMBERS MUST AGREE, and the engine says so by name rather than
    #: building a model that cannot hold: the same lesson lengths
    #: (BLOCK_MEMBERS_DIFFER), no teacher in two of them
    #: (BLOCK_MEMBERS_SHARE_TEACHER) and no pupil in two of them
    #: (BLOCK_MEMBERS_SHARE_PUPILS), read on each member's pupils
    #: (pupilGroupId below): 7A's svenska sat by "7A without SvA7" and SvA7
    #: share none, and may run as one block. See SchedulerSolver._validate_blocks.
    block_id: UUID4 | None = Field(default=None, alias="blockId")
    #: Delade lektioner: the lead teacher of each lesson of the week, when the
    #: lessons are NOT all one person's — [A, A, B] is Matematik för 7A with
    #: two lessons of Anna's and one of Bertil's. One entry per lesson, in
    #: lesson_minutes() order (longest first), so [80, 40] with [A, B] is
    #: Anna's 80 and Bertil's 40; None is a lesson nobody leads.
    #:
    #: OPTIONAL AND ADDITIVE. Absent on every requirement one person leads,
    #: which is every requirement of every school until one splits a post;
    #: the gateway sends the key only when the lessons it still wants placed
    #: have two or more leads, so a payload without a split is byte for byte
    #: what it was, builds the model it built, and is answered with the bytes
    #: it was answered with.
    #:
    #: ONE REQUIREMENT, NOT ONE PER TEACHER, for lessonLengths' reason: the
    #: spread across days, the subject's distribution rule, its block, the
    #: previous-lesson reward and every refusal that names the row are the
    #: SUBJECT's, and two requirements would be two subjects that may share
    #: a Monday.
    #:
    #: THE SCALARS STAY TRUE: lessons_per_week is the list's length,
    #: teacher_id its first entry — a reader of the scalar still finds one of
    #: the post's real teachers — and the co-teacher, who is on every lesson
    #: already, is never in it (the validator below). Every reader that asks
    #: who teaches A LESSON reads lesson_teacher(); a reader that needs
    #: everybody on the row reads the union (SchedulerSolver's _teachers_of).
    lesson_teacher_ids: list[UUID4 | None] | None = Field(
        default=None, alias="lessonTeacherIds", max_length=40,
    )
    #: Ersättande grupper: the group whose pupils sit this requirement's
    #: lessons, when not all of studentGroupId's do. SvA7 (svenska som
    #: andraspråk) REPLACES 7A's svenska for its members, so 7A's svenska is
    #: sat by 7A without SvA7's pupils — a set of children no group in the
    #: school is, and which the gateway names with an anonymous id of its own
    #: (Halvklasser-style: one id per group and replaced subject). That id
    #: appears here and in groupConflicts and nowhere else: paired with 7A
    #: (its pupils are 7A's), with every partner of 7A but SvA7, and with the
    #: other derived ids near 7A — and NEVER with SvA7, which shares no pupil
    #: with it. So SvA7's lessons may run beside 7A's svenska and beside no
    #: other lesson of 7A's, which is the whole feature; there is no parallel
    #: block, and a school that wants the two at one hour writes one.
    #:
    #: OPTIONAL AND ADDITIVE. Absent (None) is a requirement every pupil of
    #: studentGroupId sits, which is every requirement of every school until
    #: one writes a replacing group; the gateway sends the key only on a
    #: requirement whose subject a replacing group replaces for some of the
    #: class, so a payload without one is byte for byte what it was, builds
    #: the model it built and is answered with the bytes it was answered with.
    #: Equal to studentGroupId it is the same requirement as absent.
    #:
    #: TWO KEY SPACES, AND EVERY RULE READS EXACTLY ONE. Who may not overlap
    #: whom because a pupil sits in both — the pairs' no-overlap, the locked
    #: lessons' blocking, the walk's families, the cliques the verdicts count,
    #: a block's shared pupils — reads THIS key (scheduler_solver.pupil_key_of).
    #: Rules about the CLASS read studentGroupId as they always did: 7A's
    #: svenska still counts toward 7A's maxLessonsPerDayPerGroup, a
    #: reservation on 7A still keeps it out, 7A's rasts and 7A's lunch still
    #: read it as 7A's, and every refusal names 7A. A builder that mixed the
    #: two inside one rule would put 7A's svenska into one no-overlap twice,
    #: through 7A and through the derived id — an interval asked not to
    #: overlap itself, and an INFEASIBLE for every school with SvA.
    pupil_group_id: UUID4 | None = Field(default=None, alias="pupilGroupId")

    @model_validator(mode="after")
    def validate_lesson_lengths(self) -> AnonymousRequirement:
        """The list and the scalars say the same: its count, its longest."""
        if self.lesson_lengths is None:
            return self
        if len(self.lesson_lengths) != self.lessons_per_week:
            msg = "lessonLengths must hold exactly lessonsPerWeek lengths."
            raise ValueError(msg)
        if max(self.lesson_lengths) != self.minutes_per_lesson:
            msg = "minutesPerLesson must be the longest of lessonLengths."
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def validate_lesson_teachers(self) -> AnonymousRequirement:
        """The list and the scalars say the same, and only a split is a list.

        ONE REPRESENTATION PER MEANING: a post one person leads is teacherId
        alone, so a list naming one teacher throughout is a gateway that
        forgot to drop it, and refused here rather than carried as a second
        way of saying the same week.
        """
        teachers = self.lesson_teacher_ids
        if teachers is None:
            return self
        if len(teachers) != self.lessons_per_week:
            msg = "lessonTeacherIds must hold exactly lessonsPerWeek entries."
            raise ValueError(msg)
        if teachers[0] != self.teacher_id:
            msg = "teacherId must be the first entry of lessonTeacherIds."
            raise ValueError(msg)
        if self.co_teacher_id is not None and self.co_teacher_id in teachers:
            msg = "coTeacherId is on every lesson and must not be in lessonTeacherIds."
            raise ValueError(msg)
        if len(set(teachers)) < 2:
            msg = "lessonTeacherIds must name two different leads; one lead is teacherId alone."
            raise ValueError(msg)
        return self

    def lesson_minutes(self) -> tuple[int, ...]:
        """One length per lesson, longest first; a uniform requirement repeats its one."""
        if self.lesson_lengths is None:
            return (self.minutes_per_lesson,) * self.lessons_per_week
        return tuple(sorted(self.lesson_lengths, reverse=True))

    def lesson_teacher(self, lesson_index: int) -> UUID4 | None:
        """Lesson `lesson_index`'s lead, in lesson_minutes() order; an unsplit post's is teacherId."""
        if self.lesson_teacher_ids is None:
            return self.teacher_id
        return self.lesson_teacher_ids[lesson_index]

    def shortest_lesson_minutes(self) -> int:
        """The shortest lesson: the one a tight stretch can still hold."""
        return min(self.lesson_minutes())


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
    #: The skolområde the room stands on, anonymised like every other id.
    #: Sent only by a school that has asked the generator to keep the walk
    #: between its skolområden (Skolregler), and absent on every other
    #: payload, which is therefore byte for byte what it was. None is a room
    #: on no site, or a school that has not asked: either way an unknown, and
    #: an unknown walk is never charged (src/common/site-travel.ts). See
    #: app/solver/travel.py.
    site_id: UUID4 | None = Field(default=None, alias="siteId")


class SiteTravelTime(CamelModel):
    """The minutes between two skolområden, one figure for both directions.

    The school's own row (SiteTravelTimes), anonymised. One per pair: the
    table stores the lower id first, so a pair cannot carry two figures, and a
    payload that names one pair twice is a gateway that joined something twice
    — refused as a shape below rather than read either way round.
    """

    site_a_id: UUID4 = Field(alias="siteAId")
    site_b_id: UUID4 = Field(alias="siteBId")
    #: 0..240, the database's own bounds (SiteTravelTimes_minutes_check). Zero
    #: is a walk of no time, which keeps nothing apart.
    minutes: int = Field(ge=0, le=240)

    @model_validator(mode="after")
    def validate_sites(self) -> SiteTravelTime:
        if self.site_a_id == self.site_b_id:
            msg = "A travel time joins two different sites."
            raise ValueError(msg)
        return self


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


class AnonymousTeacherWorkRule(CamelModel):
    """One teacher's own lunch and rest, as their school wrote them down.

    THE FIRST ROW IN THIS MODEL THAT IS OWED TO A TEACHER. Everything else
    about a teacher is a closure: an UNAVAILABLE AvailabilityConstraint says
    the hours they are not there, and the model has never had a sentence for
    the hours they are there and must not be teaching. A lunch window and a
    night's rest are that sentence.

    EVERY FIELD IS OPTIONAL AND EMPTY MEANS THE RULE DOES NOT APPLY, which is
    the user's own decision and the only shape that lets this ship: a school
    that has filled in nobody is refused nothing, and one that has filled in
    two teachers is held to exactly those two. A default here would have
    imposed a lunch on every teacher in the country the day the column
    appeared.

    THE LUNCH IS A TRIO AND IT IS ALL OR NOTHING. Two of the three is not a
    weaker rule, it is an unanswerable one — thirty minutes inside no window,
    or a window with no length to fill it — and the database refuses the shape
    with a CHECK constraint. Refused here as well, as a shape and not as a
    sentence a school reads, because a half-filled trio is a gateway that lost
    a field rather than an administrator who typed something impossible.

    THE WINDOW'S OWN ARITHMETIC IS NOT REFUSED HERE. A window narrower than
    the lunch it has to hold, or one that closes before it opens, is a school's
    own typo, and it reaches a school as a named sentence from
    SchedulerSolver._validate_request — which reads the window through the same
    grid the model does, so the refusal and the model agree to the minute. A
    422 from this class would be the right verdict in the wrong language.

    A DAILY CAP, NOW, AND STILL NO MAXIMUM CONSECUTIVE TEACHING. The cap was
    left out of the first version beside the consecutive rule, on the strength
    of the one comparable CHAIN rule in this repo six-folding the variable
    count. The cap is not a chain. It is one linear sum per teacher and day —
    the minutes of the lessons that land there, at most the cap — over one
    literal per lesson and day saying where the lesson landed, and those
    literals are built only for a teacher whose row sets a cap (or whose post
    limits their days): a school that has set none builds the model it always
    built, variable for variable. Nothing orders the lessons inside the day,
    which is exactly the part the consecutive rule needs and the part that
    costs, so that rule still waits for a per-teacher flag of its own.

    MINUTES, NOT LESSONS: every lesson the teacher is on — lead or co-teacher,
    generated or locked — counted in its own minutes, start to end, because
    lessons are not one length and every other figure about a teacher's time
    is minutes already (src/common/teacher-day.ts is the one definition).

    THE FREE-DAY WISH IS THE ONE SOFT FIELD ON THIS ROW. The lunch, the rest
    and the cap are refused by name when they cannot hold; the wish is paid
    for in the objective and never refuses anything, which is why it reaches
    only the full model and builds nothing in the satisfaction phase.

    THE DAYS A WEEK ARE NOT HERE, and must not be: this row is read by every
    member of staff, and a deltid limit is HR. They come on
    AnonymousTeacherDayLimit, a list of their own with an id space of their
    own, so that the gateway can mask every sentence about them for a reader
    without HR read access without touching a sentence about the cap.
    """

    #: The RULE's id, not the teacher's, and it is the one thing in this model
    #: that must survive the round trip: the gateway keeps a map for it and
    #: reverses it in realiseConflicts. Every refusal below names the rule and
    #: never the teacher — the teacher map is discarded on purpose, so a
    #: sentence naming one would reach the school as a uuid resolving to
    #: nobody, and no person's name may enter a stored conflict.
    id: UUID4
    teacher_id: UUID4 = Field(alias="teacherId")
    lunch_minutes: int | None = Field(default=None, alias="lunchMinutes", ge=5, le=240)
    lunch_start_time: str | None = Field(
        default=None, alias="lunchStartTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    lunch_end_time: str | None = Field(
        default=None, alias="lunchEndTime", pattern=r"^\d{2}:\d{2}:\d{2}$",
    )
    #: Minutes between the end of one teaching day and the start of the next.
    #: Bounded as the database bounds it: an hour is the least that means
    #: anything, and 22 hours is the most a week of five days can be asked for
    #: before it is really a day off.
    min_daily_rest_minutes: int | None = Field(
        default=None, alias="minDailyRestMinutes", ge=60, le=1320,
    )
    #: The most minutes of teaching on any one day. Bounded and stepped as the
    #: database bounds it (TeacherWorkRules_maxTeachingMinutesPerDay_check):
    #: half an hour is the least that is still a day's teaching, twelve hours
    #: the most a school day can hold, and the multiple of five is this
    #: engine's grid, so the cap is a number the model can compare a sum of
    #: lesson lengths with exactly. Outside those it is a gateway that lost
    #: the database's own CHECK, and a 422 about a shape rather than a
    #: sentence a school reads.
    max_teaching_minutes_per_day: int | None = Field(
        default=None, alias="maxTeachingMinutesPerDay", ge=30, le=720, multiple_of=5,
    )
    #: The ISO weekday the teacher would rather have free. SOFT: paid for in
    #: the objective (weight_free_day_wish) and never refused. A weekday the
    #: school does not teach, or one the teacher's own locked lessons already
    #: hold, is a wish nothing the solver does can keep or break, and builds
    #: nothing at all.
    preferred_free_day: DayOfWeek | None = Field(default=None, alias="preferredFreeDay")

    @model_validator(mode="after")
    def validate_lunch_trio(self) -> AnonymousTeacherWorkRule:
        """All three lunch fields or none of them — see the class docstring."""
        present = [
            self.lunch_minutes is not None,
            self.lunch_start_time is not None,
            self.lunch_end_time is not None,
        ]
        if any(present) and not all(present):
            msg = (
                "A teacher's lunch needs lunchMinutes, lunchStartTime and "
                "lunchEndTime together, or none of them."
            )
            raise ValueError(msg)
        return self

    @property
    def has_lunch(self) -> bool:
        """Whether this rule asks for a lunch at all. Validated as a trio."""
        return self.lunch_minutes is not None


class AnonymousTeacherDayLimit(CamelModel):
    """Deltid in days: a teacher's post allows teaching on at most N days a week.

    HR DATA, AND THE REASON THIS IS NOT A FIELD ON THE WORK RULE. The work
    rule is read by every member of staff; how many days a part-time post
    covers is read by the principal, a full administrator and whoever holds
    HR read access, and by nobody else. So the limit travels apart, with an
    id space of its own — the POST's id, which the gateway keeps a map for
    (dayLimitAnonMap) as it keeps one for the work rule — and every sentence
    about it has a code of its own containing WORK_DAYS. That is what lets
    the gateway mask exactly the sentences that carry the figure, on read,
    for a reader without HR access, and leave the cap's sentences alone.

    NOT REFUSED FOR WHAT THE LOCKED LESSONS DO. A week whose hand-placed
    lessons already sit on more days than the post allows broke the limit by
    hand, and was warned beside that edit; the engine holds what it PLACES to
    the days that week has left, and to the locked days themselves where none
    are. See SchedulerSolver._add_teacher_day_constraints.

    COUNTED WEEK BY WEEK, as the gateway's own check counts a hand edit. A
    teacher whose post allows two days and who is locked on Monday and
    Tuesday in odd weeks and on Wednesday and Thursday in even ones teaches
    two days in every week the school has; the four weekdays together are no
    week at all, and a limit read off them would let the generator put a
    weekly lesson on Monday and another on Wednesday — three days in every
    week, and nobody told. The engine has no weeks, so the gateway reads them
    and sends what they hold: `locked_weekdays` below.

    A TEACHING DAY is a weekday with at least one lesson the teacher is on,
    as lead or as co-teacher, generated or locked — src/common/teacher-day.ts.
    """

    #: The post's id, never the teacher's — the reason the work rule gives:
    #: the teacher map is discarded, and a refusal naming a teacher would reach
    #: the school as a uuid that resolves to nobody.
    id: UUID4
    teacher_id: UUID4 = Field(alias="teacherId")
    #: 1..6 as the database bounds it (TeacherEmployments_maxTeachingDaysPerWeek_check).
    #: Seven would be no limit at all on any week a school has.
    max_teaching_days_per_week: int = Field(alias="maxTeachingDaysPerWeek", ge=1, le=6)
    #: The weeks the post is held in: every distinct set of ISO weekdays the
    #: teacher's preserved lessons — every lesson the payload sends as a
    #: FixedLesson the teacher is lead or co-teacher on, ending after it
    #: starts — hold together in one real ISO week, by their recurrence and
    #: their dates (src/common/teacher-day.ts's week reading). [[]] for a
    #: teacher with no preserved lesson; [[1, 2]] for one locked on Monday and
    #: Tuesday every week; [[1, 2], [3, 4]] for the odd and even weeks above.
    #:
    #: WHAT THE ENGINE HOLDS, for every set L: the generated lessons take at
    #: most max(0, N − |L|) of the grid's days outside L. A generated lesson
    #: is a weekly lesson — the stricter reading for an A/B or dated
    #: requirement, as everywhere the engine has no weeks — so it adds a day
    #: to every week whose locks do not already hold its weekday, and a week
    #: with |L| days locked has N − |L| left to add. A week the locks alone
    #: put over N gets nothing added, and is not refused for what it holds.
    #: |L| counts a weekday the grid does not teach: a Saturday lesson is a
    #: teaching day on any reading of the post.
    #:
    #: A SET INSIDE ANOTHER MAY BE LEFT OUT — BUT ONLY INSIDE ONE OF AT MOST N.
    #: Write G for the weekdays the generated lessons take. L's line is
    #: |G \ L| ≤ max(0, N − |L|). For L' ⊆ L with |L| ≤ N:
    #:   |G \ L'| = |G \ L| + |G ∩ (L \ L')| ≤ (N − |L|) + (|L| − |L'|) = N − |L'|,
    #: which is L''s line, so L's implies it and a week with L' in it is safe
    #: wherever every week with L is. Past N the floor breaks the step: L's
    #: line is then G ⊆ L, which still lets G take every day of L \ L'. With
    #: L = {Mon, Tue, Wed} on a post of two and L' = {Mon}, G = {Tue, Wed}
    #: keeps L's week at its three locked days and gives L''s week three —
    #: the silent breach this field exists to close, one week over. So "only
    #: the maximal sets" is wrong exactly there. The gateway leaves out what
    #: this proves and nothing more (lockedWeekdaySets, src/common/
    #: teacher-day.ts), and the engine prunes by the same rule itself
    #: (scheduler_solver._week_sets), so a gateway that sent every distinct
    #: set would build no row more. Measured against an encoding of every
    #: real week: of 400 random payloads sending only the maximal sets, 25
    #: came back with a week the generator had put over its post; of 2,000
    #: sending every distinct set, none did, none was refused that had a
    #: timetable, and none raised.
    #:
    #: REQUIRED, and it breaks nothing deployed: the limit is new, unmerged,
    #: and no gateway that sends it is running. A default would be a reading
    #: of the weeks the engine cannot make — every lock every week is the
    #: lenient one this field replaces — and a gateway that forgot the field
    #: would get it silently. At most 128: every set of weekdays there is,
    #: once each.
    locked_weekdays: list[list[DayOfWeek]] = Field(
        alias="lockedWeekdays", min_length=1, max_length=128,
    )

    @field_validator("locked_weekdays")
    @classmethod
    def weekdays_once_each(cls, value: list[list[DayOfWeek]]) -> list[list[DayOfWeek]]:
        """A set of weekdays, each at most once.

        A weekday twice in one week is a gateway that joined two lessons'
        weekdays without reading them as a set, and what else that reading
        got wrong the engine cannot tell from here: |L| is what the line
        subtracts from the post. A shape, refused as one, as two limits for
        one post are below. The same SET twice is only a repeat, and the
        engine reads the list as sets.
        """
        for weekdays in value:
            if len(set(weekdays)) != len(weekdays):
                msg = "lockedWeekdays names a weekday twice in one week."
                raise ValueError(msg)
        return value


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

    "Shares its student group" is read in the PUPIL space — the pupils the
    lock holds (pupilGroupIds below, or the groups it names) against the
    generated lesson's pupils and the groups sharing them — while the rules
    about the class (its lunch, its rasts) keep reading the groups it names.
    See AnonymousRequirement.pupil_group_id for the two spaces.
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
    #: Ersättande grupper, for a lesson the school locked: the groups whose
    #: pupils sit it, when they are not studentGroupId's and extraGroupIds'.
    #: A locked 7A svenska is sat by 7A without SvA7's pupils, the derived id
    #: AnonymousRequirement.pupil_group_id describes, so it keeps 7A's matte
    #: and every group sharing those pupils out of its window — and lets
    #: SvA7, which shares none of them, be placed beside it.
    #:
    #: WHEN PRESENT IT REPLACES [studentGroupId, *extraGroupIds] IN EVERY
    #: PUPIL QUESTION (scheduler_solver.pupil_keys_of): whom the lock blocks,
    #: whose walk it is, which clique it closes. The class questions keep the
    #: groups it names: a locked 7A svenska still takes 7A's lunch window and
    #: still counts as 7A's lesson before a rast. Absent is today's reading
    #: exactly, and the gateway sends the key only on a lock whose subject a
    #: replacing group replaces, so every other payload is byte for byte what
    #: it was. An empty list is a lock no pupil sits in a pupil question:
    #: honest for a lesson every pupil of which a replacing group has taken.
    #: At most the 21 groups the two fields above can name between them.
    pupil_group_ids: list[UUID4] | None = Field(
        default=None, alias="pupilGroupIds", max_length=21,
    )


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


class SearchOptions(CamelModel):
    """How one request's search is run: where it starts, how long, on how much.

    NEVER WHAT IS SEARCHED FOR. Every rule and every weight stays where it
    was; a request carrying this is solved against exactly the week and the
    objective it would be solved against without it. That is what lets a
    schemaförslag run ask for two to four different candidates of one week
    without a second notion of the school: the candidates differ by their
    weights and by where CP-SAT starts looking, and these four fields are the
    second half of that.

    Sent ONLY for a candidate run, and absent is today's request byte for
    byte. PRESENT, EVEN EMPTY, IT ALSO MEANS "THIS IS A CANDIDATE": phase 2
    then starts from a completed hint (SchedulerSolver._complete_the_hint),
    which a candidate warm-started from a draft cannot do without — measured,
    a thirty-second candidate otherwise comes back worse than the draft it
    started from. Each field below only ever adds to that; one left out keeps
    CP-SAT's default, or the configured budget.

    THE BUDGET CAN ONLY SHRINK. maxSeconds is min'd with the engine's own
    SOLVER_MAX_TIME_SECONDS, so a gateway that asks for ten minutes never gets
    more than the deployment allows a Generera, and a candidate run cannot buy
    itself a longer turn on a shared machine than the school's own button.
    """

    #: CP-SAT's random_seed on the generation solves. Different seeds start the
    #: portfolio's workers in different places, which is the cheap way to get a
    #: different timetable of equal quality out of the same objective.
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    #: The solve budget, in whole seconds, and the probe's with it: see
    #: settings_for_search, which turns it into the request's own Settings.
    #: Five is the floor: under it a candidate is little more than its warm
    #: start, and the TIMEOUT that follows would read as a fact about the
    #: school's week when it is a fact about the caller's number.
    max_seconds: int | None = Field(default=None, alias="maxSeconds", ge=5, le=600)
    #: False skips the explaining work a refusal pays for — the TIMEOUT probe,
    #: the INFEASIBLE explanation and the blocks verdict. Absent means true.
    #: A candidate after the first has the same hard rules as the first, so the
    #: first one's refusal already said everything a probe could.
    probes: bool | None = None
    #: CP-SAT's num_workers on the generation solves. Absent is CP-SAT's own
    #: default (every core), which is right for one Generera at a time and
    #: wrong for two candidate runs sharing a machine with it.
    workers: int | None = Field(default=None, ge=1, le=16)

    @property
    def runs_probes(self) -> bool:
        return self.probes is not False


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
    #: Meals the school placed by hand. Empty means the solver places every one,
    #: which is what every payload before this field looked like.
    lunch_placements: list[LunchPlacement] = Field(
        default_factory=list, alias="lunchPlacements", max_length=5000,
    )
    # Raster. Empty means no stage has a declared break, which is the behaviour
    # every school had before this field existed — and the behaviour the rektor
    # reported as lessons placed edge to edge.
    rasts: list[Rast] = Field(
        default_factory=list, alias="rasts", max_length=500,
    )
    # The teachers' own lunch and rest, one row per teacher who has any. Empty
    # means no teacher has been given either, which is the behaviour every
    # school had before this field existed — and, since the engine ships before
    # the gateway that fills it, the behaviour every school still has today. A
    # teacher the list does not name is owed nothing, exactly as a teacher whose
    # row leaves both halves empty is: see AnonymousTeacherWorkRule for why an
    # empty value is the whole of "the rule does not apply here".
    #
    # The cap matches `requirements`: one row per teacher, and a payload naming
    # more teachers than it has teaching requirements is not a school.
    teacher_work_rules: list[AnonymousTeacherWorkRule] = Field(
        default_factory=list, alias="teacherWorkRules", max_length=2000,
    )
    # Deltid in days, one row per post that has a limit. Empty is every school
    # that has set none, and the gateway sends the key only when it is not, so
    # such a school's payload is byte for byte what it was. Capped as the work
    # rules are, for their reason: one post per teacher and year.
    teacher_day_limits: list[AnonymousTeacherDayLimit] = Field(
        default_factory=list, alias="teacherDayLimits", max_length=2000,
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
    #
    # The relation is the PUPIL space's, and its ids may be derived ones that
    # name no group: "7A's svenska without SvA7" (a requirement's
    # pupilGroupId, a lock's pupilGroupIds) is paired with 7A and its partners
    # and never with SvA7. A derived id no requirement or lock carries is a
    # pair that keeps nothing apart, as any group without lessons is.
    group_conflicts: list[tuple[UUID4, UUID4]] = Field(
        default_factory=list, alias="groupConflicts", max_length=5000,
    )
    previous_lessons: list[PreviousLesson] = Field(
        default_factory=list,
        alias="previousLessons",
        max_length=5000,
    )
    #: Restid i generatorn: the walk between the school's skolområden, sent
    #: with each room's `siteId` by a school whose Skolregler turn the rule on,
    #: and never otherwise — so an empty list is every other school's payload,
    #: byte for byte, and builds exactly today's model. At most one row per
    #: pair of the 50 sites a school may have (SITE_LIMIT): 50·49/2.
    site_travel_times: list[SiteTravelTime] = Field(
        default_factory=list, alias="siteTravelTimes", max_length=1225,
    )
    weights: ObjectiveWeights | None = None
    rules: ScheduleRules | None = None
    # Optional, and absent on every request but a schemaförslag candidate's;
    # absent is today's solve byte for byte. See SearchOptions.
    search: SearchOptions | None = None

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

    @model_validator(mode="after")
    def validate_day_limits(self) -> OptimizeScheduleRequest:
        """One limit per post, and one post per teacher.

        A SHAPE, NOT A SENTENCE, refused here as a 422 for the reason the work
        rule's half-filled lunch is: the database keeps one post per teacher
        and year (the unique index on TeacherEmployments), and the payload
        carries one year, so a second limit for one teacher — or the same post
        twice — is a gateway that joined something twice, never an
        administrator who typed something impossible. A school has nothing to
        go and change, and a sentence in its language would send it looking.

        AND IT CANNOT BE READ EITHER WAY ROUND. Two limits for one teacher
        built as two would hold the stricter and name both, and "the first one
        wins" would be the engine quietly choosing which half of a payload it
        believes; for an HR figure the gateway masks per post, a refusal
        naming the wrong post is a leak in the making. So neither: the payload
        is refused before anything reads it. (The work rule's own two-rows
        case is built as two, and argued in _add_teacher_work_constraints;
        it carries no HR figure.)
        """
        ids = [limit.id for limit in self.teacher_day_limits]
        if len(set(ids)) != len(ids):
            msg = "teacherDayLimits ids must be unique."
            raise ValueError(msg)
        teachers = [limit.teacher_id for limit in self.teacher_day_limits]
        if len(set(teachers)) != len(teachers):
            msg = "teacherDayLimits names one teacher twice."
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def validate_travel_pairs(self) -> OptimizeScheduleRequest:
        """One figure per pair of skolområden, in either order.

        A SHAPE, refused as the day limits above are: the table keeps one row
        per pair (the lower id first), so two rows for one pair — in the same
        order or reversed — are a gateway that joined something twice. Read
        either way round, the generator would be choosing which of two figures
        the school meant.
        """
        pairs = [
            frozenset((row.site_a_id, row.site_b_id)) for row in self.site_travel_times
        ]
        if len(set(pairs)) != len(pairs):
            msg = "siteTravelTimes names one pair of sites twice."
            raise ValueError(msg)
        return self


class ScheduledLesson(CamelModel):
    requirement_id: UUID4 = Field(alias="requirementId")
    room_id: UUID4 | None = Field(default=None, alias="roomId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    end_time: str = Field(alias="endTime", pattern=r"^\d{2}:\d{2}:\d{2}$")
    #: Delade lektioner: which lead this placement is, for a lesson of a
    #: requirement that carried lessonTeacherIds — the lessons of one
    #: requirement are otherwise interchangeable, and the gateway cannot tell
    #: Bertil's Tuesday from Anna's without it. Its entry of the list, so
    #: None — omitted — on a lesson the list gives nobody.
    #:
    #: OMITTED WHEREVER IT IS NONE, and on every lesson of an unsplit
    #: requirement it is: a response for a school without a split carries no
    #: key it did not carry before, byte for byte. Set by
    #: SchedulerSolver._extract_lessons and nowhere else.
    teacher_id: UUID4 | None = Field(
        default=None, alias="teacherId", exclude_if=lambda value: value is None,
    )


class LunchPlacement(CamelModel):
    """A lunch the school placed by hand: one class, one weekday, one start.

    A PIN ON THE MEAL THE ENGINE ALREADY OWNS, and deliberately not a fixed
    lesson. The migration that made a meal its own row refused an isLocked flag
    for exactly the reason this shape avoids: a preserved sitting forwarded as a
    fixed lesson sits beside a lunch variable the solver still builds for the
    same class — two mandatory reservations in one window, and an INFEASIBLE
    whose cause nobody can see. Here there is one reservation, the solver's own,
    held where the school put it.

    It OUTRANKS the lunch window and the stage's sitting, because a school that
    places a meal by hand is overriding those on purpose — a Tuesday whose
    locked lessons fill 10:30-13:00 has its meal at 13:00 or nowhere. It does
    NOT outrank a locked lesson or a reservation on the class: those are facts
    about the class's own time, and a pin on top of one is refused by name.

    Only the start. The meal's length is the school's one lunchMinutes, and a
    second length here would be a second answer to "how long is lunch".
    """

    student_group_id: UUID4 = Field(alias="studentGroupId")
    day_of_week: DayOfWeek = Field(alias="dayOfWeek")
    start_time: str = Field(alias="startTime", pattern=r"^\d{2}:\d{2}:\d{2}$")


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
