"""The staffing proposal's wire models: POST /api/v1/staff.

A third request beside OptimizeScheduleRequest and OptimizeRoomsRequest,
because it asks a third question. The generator places requirements in time
with their teachers given; the room optimiser re-deals rooms with everything
else given. This one decides WHO leads each curriculum entry, before there is
any time at all: a tjänstefördelning, solved.

WHAT CROSSES. Opaque ids minted fresh by the gateway for every request
(teachers, requirements, groups, subjects, eligibility sets), integer tenths
of a minute, lesson minutes, grade numbers, booleans and weights. Never a
name, an email, a signature, an employment percentage, a qualification's kind
or its dates. Who may teach what arrives already decided as an ELIGIBILITY SET
of teacher ids, computed in the gateway by the one rule that decides it
(qualificationCovers in src/staffing/teacher-load.ts) — a Python copy of that
rule would be a second definition, and the engine has no use for the reasons.

WHY TENTHS. A charged minute is a fraction as often as not: a row two teachers
alternate on, odd weeks, a FACTOR subject. Rounding each row up to a whole
minute loses up to a minute per row, and ten rows of 59.3 then cost a teacher
seven minutes the write-time check would never charge — rows a PATCH accepts
would be unstaffable here. Tenths, rounded up by the gateway, lose at most a
tenth per row. The limit carries loadStatus's own rounding band, so a load the
model accepts is never a load the gateway's status calls OVER: see
AnonymousStaffTeacher.

Every name below is also listed by hand in tests/test_staffing.py and in the
gateway's src/optimization/staffing-engine-contract.spec.ts. CamelModel
forbids extra fields, so a field one side sends and the other has not heard of
is a 422 for the whole proposal — change both lists in the commit that deploys
the engine, engine first.
"""

from __future__ import annotations

from typing import Literal

from pydantic import UUID4, Field, model_validator

from app.messages import render
from app.schemas.schedule import CamelModel

#: Never INFEASIBLE and never TIMEOUT: keeping every row as it is and leaving
#: the open ones unstaffed always satisfies every rule, so the worst this can
#: say is "this is the best found inside the time".
StaffSolveStatus = Literal["OPTIMAL", "FEASIBLE"]

#: Why an open row ends without a teacher, judged on the final answer.
UnstaffedReason = Literal[
    # Qualifications are respected and nobody but (at most) the row's own
    # co-teacher holds one that covers it.
    "NO_QUALIFIED_TEACHER",
    # Somebody could take it, but nobody among them has a target above zero —
    # and a teacher with no target is never given a new row (unknown room is
    # not infinite room).
    "NO_TEACHER_WITH_TARGET",
    # Some candidate has a target, and none of them has room left for it in
    # the answer.
    "NO_CAPACITY_LEFT",
    # A candidate with room exists: the search stopped before reaching it.
    # Only possible when the first stage was not proven.
    "NOT_REACHED",
]


class StaffWeights(CamelModel):
    """The secondary objective's weights, each 0..100, overridable per request.

    Staffing as many rows as possible is NOT among them: it is the first,
    lexicographic stage, never traded for anything here (StaffingSolver).

    The units: balance is per TENTH of a minute of distance from a teacher's
    target (and below its band); every other weight is per count, scaled by
    600 — sixty minutes in tenths. So at these defaults a new teacher in a
    class weighs 40 minutes of imbalance, a break of continuity on an open row
    80, moving a row away from its current lead 100, and an unqualified (or,
    with nothing recorded, an outside-the-subject) placement 100.
    """

    balance: int = Field(default=3, ge=0, le=100)
    class_teachers: int = Field(default=2, alias="classTeachers", ge=0, le=100)
    continuity: int = Field(default=4, ge=0, le=100)
    keep_current: int = Field(default=5, alias="keepCurrent", ge=0, le=100)
    unqualified: int = Field(default=5, ge=0, le=100)


class StaffEligibilitySet(CamelModel):
    """One list of teachers who may take a row, shared by every row it fits.

    Deduplicated by the gateway: an F–9 school with broad klasslärare
    behörighet repeats the same 150 ids on two thousand rows, which per row
    was 11.7 MB — past the engine's 8 MB body limit.

    With qualifications recorded it is the active staff holding a covering
    qualification; with none recorded it is the staff who already teach the
    subject (or did last year) — a soft preference then, never a rule.
    """

    id: UUID4
    teacher_ids: list[UUID4] = Field(alias="teacherIds", max_length=1000)

    @model_validator(mode="after")
    def validate_unique(self) -> StaffEligibilitySet:
        if len(set(self.teacher_ids)) != len(self.teacher_ids):
            msg = "An eligibility set names a teacher twice."
            raise ValueError(msg)
        return self


class AnonymousStaffTeacher(CamelModel):
    """A member of the active staff, as minutes and nothing else.

    `target_tenths` is the teacher's weekly target ×10. `limit_tenths` is the
    most the model may charge them: 10·floor(target·(1 + tolerance/100)) + 4,
    so any load at or under it rounds to a whole minute loadStatus calls OK.
    `floor_tenths` is the band's lower edge the same way,
    max(0, 10·ceil(target·(1 − tolerance/100)) − 5): any load at or above it
    rounds to a minute loadStatus does not call UNDER. The engine is never
    sent the tolerance itself — the two edges are the only thing it is used
    for, and computing them on the gateway's side keeps loadStatus's rounding
    in one language.

    A teacher with no target (no employment row, or no riktmärke) carries
    None in all three and is never given a new row: unknown room is not
    infinite room. They keep the rows they already lead, unless a teacher
    with a target takes one over.

    `fixed_tenths` is everything the proposal may not touch: rows that are
    fixed, the rows this teacher co-teaches, and duties counted as teaching.
    Authoritative — the engine never adds a fixed row's charge itself.
    """

    id: UUID4
    target_tenths: int | None = Field(default=None, alias="targetTenths", ge=0, le=24000)
    limit_tenths: int | None = Field(default=None, alias="limitTenths", ge=0, le=48004)
    floor_tenths: int | None = Field(default=None, alias="floorTenths", ge=0, le=24000)
    fixed_tenths: int = Field(alias="fixedTenths", ge=0, le=200000)

    @model_validator(mode="after")
    def validate_band(self) -> AnonymousStaffTeacher:
        given = (self.target_tenths, self.limit_tenths, self.floor_tenths)
        if any(value is None for value in given) and any(value is not None for value in given):
            msg = "targetTenths, limitTenths and floorTenths are given together or not at all."
            raise ValueError(msg)
        target, limit, floor = given
        if target is not None and limit is not None and limit < target:
            msg = "limitTenths is below targetTenths."
            raise ValueError(msg)
        if target is not None and floor is not None and floor > target:
            msg = "floorTenths is above targetTenths."
            raise ValueError(msg)
        return self


class AnonymousStaffRequirement(CamelModel):
    """One curriculum entry: whose it is now, who may take it, what it costs.

    `fixed` rows are not decided here (already staffed under "only unstaffed",
    or pinned by the admin); they are sent for what they say about a class —
    who already teaches in it — and their charge is in the teachers'
    fixedTenths. Every other row is FREE: a free row with a current lead is
    KEPT (it may change hands, but never ends unstaffed), one without is OPEN.

    The co-teacher is never decided: the proposal staffs the lead only. Their
    charge is already fixed load, they count as present in the class, and
    they are never made the lead of their own row.

    `charge_tenths` is what the row costs its lead, ×10, rounded up.
    `lesson_minutes` is the row's weekly teaching time for its class — what a
    row left unstaffed costs the pupils, used only to rank the unstaffed.
    """

    id: UUID4
    subject_id: UUID4 = Field(alias="subjectId")
    student_group_id: UUID4 = Field(alias="studentGroupId")
    charge_tenths: int = Field(alias="chargeTenths", ge=0, le=200000)
    lesson_minutes: int = Field(alias="lessonMinutes", ge=0, le=20000)
    min_grade_level: int | None = Field(default=None, alias="minGradeLevel", ge=0, le=12)
    max_grade_level: int | None = Field(default=None, alias="maxGradeLevel", ge=0, le=12)
    fixed: bool
    current_teacher_id: UUID4 | None = Field(default=None, alias="currentTeacherId")
    co_teacher_id: UUID4 | None = Field(default=None, alias="coTeacherId")
    #: None is no set, which is the same as an empty one.
    eligibility_set_id: UUID4 | None = Field(default=None, alias="eligibilitySetId")
    #: Last year's lead(s) of the predecessor row, among the active staff.
    last_year_teacher_ids: list[UUID4] = Field(
        default_factory=list, alias="lastYearTeacherIds", max_length=20,
    )

    @model_validator(mode="after")
    def validate_row(self) -> AnonymousStaffRequirement:
        if self.current_teacher_id is not None and self.current_teacher_id == self.co_teacher_id:
            # No database CHECK forbids it, only the writers do; the gateway
            # sends such a row as fixed without either id rather than this.
            msg = "currentTeacherId and coTeacherId are the same teacher."
            raise ValueError(msg)
        if len(set(self.last_year_teacher_ids)) != len(self.last_year_teacher_ids):
            msg = "lastYearTeacherIds names a teacher twice."
            raise ValueError(msg)
        if (
            self.min_grade_level is not None
            and self.max_grade_level is not None
            and self.min_grade_level > self.max_grade_level
        ):
            msg = "minGradeLevel is above maxGradeLevel."
            raise ValueError(msg)
        return self


class StaffRequest(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    #: Hard: a teacher outside a row's eligibility set is never newly given it.
    respect_qualifications: bool = Field(alias="respectQualifications")
    #: Whether the school has recorded any qualification at all. Without one
    #: the sets are "who already teaches the subject" — a preference, never a
    #: rule — so respecting them is refused below.
    qualifications_recorded: bool = Field(alias="qualificationsRecorded")
    weights: StaffWeights = Field(default_factory=StaffWeights)
    teachers: list[AnonymousStaffTeacher] = Field(min_length=1, max_length=1000)
    requirements: list[AnonymousStaffRequirement] = Field(min_length=1, max_length=5000)
    eligibility_sets: list[StaffEligibilitySet] = Field(
        default_factory=list, alias="eligibilitySets", max_length=5000,
    )

    @model_validator(mode="after")
    def validate_references(self) -> StaffRequest:
        """Unique ids, and every id a row or a set names is in the payload.

        A teacher id nobody sent is the gateway having dropped a row of its
        map; reading it as "some other teacher" would hand a curriculum entry
        to a person the gateway cannot name on the way back. Loud instead.
        """
        teacher_ids = {teacher.id for teacher in self.teachers}
        if len(teacher_ids) != len(self.teachers):
            msg = "Teacher ids must be unique."
            raise ValueError(msg)
        if len({row.id for row in self.requirements}) != len(self.requirements):
            msg = "Requirement ids must be unique."
            raise ValueError(msg)
        set_ids = {entry.id for entry in self.eligibility_sets}
        if len(set_ids) != len(self.eligibility_sets):
            msg = "Eligibility set ids must be unique."
            raise ValueError(msg)
        for entry in self.eligibility_sets:
            if not teacher_ids.issuperset(entry.teacher_ids):
                msg = f"Eligibility set {entry.id} names a teacher that is not in teachers."
                raise ValueError(msg)
        for row in self.requirements:
            named = [row.current_teacher_id, row.co_teacher_id, *row.last_year_teacher_ids]
            if any(teacher is not None and teacher not in teacher_ids for teacher in named):
                msg = f"Requirement {row.id} names a teacher that is not in teachers."
                raise ValueError(msg)
            if row.eligibility_set_id is not None and row.eligibility_set_id not in set_ids:
                msg = f"Requirement {row.id} names an eligibility set that is not in eligibilitySets."
                raise ValueError(msg)
        if self.respect_qualifications and not self.qualifications_recorded:
            msg = "respectQualifications needs qualificationsRecorded."
            raise ValueError(msg)
        return self


class StaffAssignment(CamelModel):
    requirement_id: UUID4 = Field(alias="requirementId")
    teacher_id: UUID4 = Field(alias="teacherId")


class StaffUnstaffed(CamelModel):
    requirement_id: UUID4 = Field(alias="requirementId")
    reason: UnstaffedReason


class StaffConflict(CamelModel):
    """A verdict about the school's staffing, never about a person.

    Shaped like ConflictDetail (code, params, the English rendered FROM the
    code) with the three kinds of id this question has. A teacher appears
    only as an opaque id in `teacher_ids`, which the gateway maps back in its
    own field — the params and the sentence never hold one.
    """

    code: str
    params: dict[str, str | int] = Field(default_factory=dict)
    message: str = ""
    requirement_ids: list[UUID4] = Field(default_factory=list, alias="requirementIds")
    teacher_ids: list[UUID4] = Field(default_factory=list, alias="teacherIds")
    subject_ids: list[UUID4] = Field(default_factory=list, alias="subjectIds")

    @model_validator(mode="after")
    def _render_message(self) -> StaffConflict:
        if not self.message:
            object.__setattr__(self, "message", render(self.code, self.params))
        return self


class StaffTerms(CamelModel):
    """The objective's parts for one answer, each as a plain count.

    `unstaffed_minutes` is the pupils' weekly lesson minutes left without a
    lead — what stage 1 weighs, beside a fixed cost per row — not the
    teachers' charge. `new_class_teachers` counts, per class, the teachers it
    gets through free rows beyond those already present through a fixed row
    or co-teaching. `deviation_tenths` is Σ|load − target| and
    `under_band_tenths` Σ how far each teacher is below the band, over
    teachers with a target.
    """

    unstaffed_rows: int = Field(alias="unstaffedRows", ge=0)
    unstaffed_minutes: int = Field(alias="unstaffedMinutes", ge=0)
    deviation_tenths: int = Field(alias="deviationTenths", ge=0)
    under_band_tenths: int = Field(alias="underBandTenths", ge=0)
    new_class_teachers: int = Field(alias="newClassTeachers", ge=0)
    continuity_changes: int = Field(alias="continuityChanges", ge=0)
    current_changes: int = Field(alias="currentChanges", ge=0)
    unqualified_assignments: int = Field(alias="unqualifiedAssignments", ge=0)


class StaffTermsComparison(CamelModel):
    #: Every kept row with its current lead and every open row unstaffed.
    before: StaffTerms
    after: StaffTerms


class StaffResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    status: StaffSolveStatus
    #: The first stage was proven: no answer staffs more (by its weight).
    unstaffed_proven: bool = Field(alias="unstaffedProven")
    #: Every free row that ends staffed — kept rows keeping their lead
    #: included — in payload order.
    assignments: list[StaffAssignment]
    #: Open rows only; a kept row is never unstaffed.
    unstaffed: list[StaffUnstaffed]
    conflicts: list[StaffConflict]
    terms: StaffTermsComparison
