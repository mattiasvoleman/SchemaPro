"""The staffing proposal: POST /api/v1/staff and app/solver/staffing_solver.py.

Most fixtures are two or three teachers and a handful of rows, built so that
exactly one rule or one objective term decides the answer — and then switched
off to show that it was that term. The seeded 60-teacher, 400-row school is
benchmarks/staff_60x400.py's, so the pytest bench and the script measure the
same thing.
"""

from __future__ import annotations

import asyncio
import itertools
import math
import os
import random
import sys
import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.openapi.utils import get_openapi
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.api.v1 import staffing as staffing_route
from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.main import create_app
from app.schemas.staffing import (
    AnonymousStaffRequirement,
    AnonymousStaffTeacher,
    StaffAssignment,
    StaffConflict,
    StaffEligibilitySet,
    StaffRequest,
    StaffResponse,
    StaffTerms,
    StaffTermsComparison,
    StaffUnstaffed,
    StaffWeights,
)
from app.solver import staffing_solver
from app.solver.staffing_solver import (
    StaffingSolver,
    answer_loads,
    build_domains,
    build_model,
    candidate_counts,
    check,
    estimate_model_size,
    evaluate,
    greedy,
    prepare,
    status_quo,
    unstaffed_reason,
    verdicts,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from staff_60x400 import band, build_school  # noqa: E402

API_KEY = "test-api-key-000000000000000000000000"


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {"API_KEY": API_KEY, "ALLOWED_ORIGINS": "http://testserver"}
    values.update(overrides)
    return Settings(**values)


SETTINGS = _settings(STAFF_SOLVER_MAX_TIME_SECONDS=5.0)


# ---------------------------------------------------------------------------
# A small school, named by labels.
# ---------------------------------------------------------------------------


class School:
    """Teachers and rows by label; ids are fresh v4 uuids, as the gateway's are."""

    def __init__(
        self,
        *,
        respect: bool = True,
        recorded: bool = True,
        tolerance: int = 10,
        **weights: int,
    ) -> None:
        self.respect = respect
        self.recorded = recorded
        self.tolerance = tolerance
        self.weights = weights
        self.teachers: list[dict] = []
        self.rows: list[dict] = []
        self.ids: dict[str, str] = {}
        self._sets: dict[tuple[str, ...], str] = {}

    def id(self, label: str) -> str:
        return self.ids.setdefault(label, str(uuid4()))

    def teacher(self, label: str, target: int | None = None, fixed: float = 0) -> str:
        self.teachers.append({
            "id": self.id(label),
            **(band(target, self.tolerance) if target is not None else {}),
            "fixedTenths": math.ceil(10 * fixed - 1e-6),
        })
        return label

    def row(
        self,
        label: str,
        *,
        subject: str = "Ma",
        group: str = "7A",
        minutes: float = 60,
        lesson: int | None = None,
        grades: tuple[int, int] | None = (7, 7),
        fixed: bool = False,
        current: str | None = None,
        co: str | None = None,
        eligible: list[str] | None = None,
        last_year: list[str] = (),  # type: ignore[assignment]
    ) -> str:
        set_id = None
        if eligible:
            key = tuple(sorted(self.id(t) for t in eligible))
            set_id = self._sets.setdefault(key, str(uuid4()))
        self.rows.append({
            "id": self.id(label),
            "subjectId": self.id(f"subject:{subject}"),
            "studentGroupId": self.id(f"group:{group}"),
            "chargeTenths": math.ceil(10 * minutes - 1e-6),
            "lessonMinutes": round(minutes) if lesson is None else lesson,
            "minGradeLevel": grades[0] if grades else None,
            "maxGradeLevel": grades[1] if grades else None,
            "fixed": fixed,
            "currentTeacherId": self.id(current) if current else None,
            "coTeacherId": self.id(co) if co else None,
            "eligibilitySetId": set_id,
            "lastYearTeacherIds": [self.id(t) for t in last_year],
        })
        return label

    def payload(self) -> dict:
        return {
            "requestId": str(uuid4()),
            "respectQualifications": self.respect,
            "qualificationsRecorded": self.recorded,
            "weights": self.weights,
            "teachers": self.teachers,
            "requirements": self.rows,
            "eligibilitySets": [
                {"id": set_id, "teacherIds": list(members)}
                for members, set_id in self._sets.items()
            ],
        }

    def request(self) -> StaffRequest:
        return StaffRequest.model_validate(self.payload())

    def solve(self, settings: Settings = SETTINGS) -> Answer:
        return Answer(self, StaffingSolver(settings).solve(self.request()))


class Answer:
    def __init__(self, school: School, response: StaffResponse) -> None:
        self.response = response
        self._label = {value: key for key, value in school.ids.items()}
        self.leads = {
            self._label[str(a.requirement_id)]: self._label[str(a.teacher_id)]
            for a in response.assignments
        }
        self.reasons = {
            self._label[str(u.requirement_id)]: u.reason for u in response.unstaffed
        }

    def codes(self) -> list[str]:
        return [conflict.code for conflict in self.response.conflicts]


def _problem(school: School):
    problem = prepare(school.request())
    build_domains(problem)
    return problem


# ---------------------------------------------------------------------------
# The wire.
# ---------------------------------------------------------------------------


def _field_names(model: type) -> set[str]:
    return {field.alias or name for name, field in model.model_fields.items()}


def test_the_wire_contract_is_exactly_what_the_gateway_sends_and_reads() -> None:
    """Hand-kept on both sides on purpose, like the room optimiser's.

    The mirror is src/optimization/staffing-engine-contract.spec.ts.
    extra="forbid" makes a field one side has and the other lacks a 422 for
    the whole proposal, so change both lists with the engine deploy, engine
    first.
    """
    assert _field_names(StaffRequest) == {
        "requestId", "respectQualifications", "qualificationsRecorded", "weights",
        "teachers", "requirements", "eligibilitySets",
    }
    assert _field_names(StaffWeights) == {
        "balance", "classTeachers", "continuity", "keepCurrent", "unqualified",
    }
    assert _field_names(StaffEligibilitySet) == {"id", "teacherIds"}
    assert _field_names(AnonymousStaffTeacher) == {
        "id", "targetTenths", "limitTenths", "floorTenths", "fixedTenths",
    }
    assert _field_names(AnonymousStaffRequirement) == {
        "id", "subjectId", "studentGroupId", "chargeTenths", "lessonMinutes",
        "minGradeLevel", "maxGradeLevel", "fixed", "currentTeacherId", "coTeacherId",
        "eligibilitySetId", "lastYearTeacherIds",
    }
    assert _field_names(StaffResponse) == {
        "requestId", "status", "unstaffedProven", "assignments", "unstaffed", "conflicts",
        "terms",
    }
    assert _field_names(StaffAssignment) == {"requirementId", "teacherId"}
    assert _field_names(StaffUnstaffed) == {"requirementId", "reason"}
    assert _field_names(StaffConflict) == {
        "code", "params", "message", "requirementIds", "teacherIds", "subjectIds",
    }
    assert _field_names(StaffTermsComparison) == {"before", "after"}
    assert _field_names(StaffTerms) == {
        "unstaffedRows", "unstaffedMinutes", "deviationTenths", "underBandTenths",
        "newClassTeachers", "continuityChanges", "currentChanges", "unqualifiedAssignments",
    }
    assert StaffWeights().model_dump(by_alias=True) == {
        "balance": 3, "classTeachers": 2, "continuity": 4, "keepCurrent": 5, "unqualified": 5,
    }


def _random_school(
    seed: int,
    *,
    teachers: int = 6,
    rows: int = 12,
    targets: tuple[int | None, ...] = (None, 0, 300, 400, 600),
) -> School:
    """A small school with every kind of row and teacher, chosen at random."""
    rng = random.Random(seed)
    school = School(respect=rng.random() < 0.5)
    staff = [
        school.teacher(
            f"T{index}",
            target=rng.choice(targets),
            fixed=rng.choice([0, 50, 120]),
        )
        for index in range(rng.randint(2, teachers))
    ]
    for index in range(rng.randint(2, rows)):
        current = rng.choice([None, None, rng.choice(staff)])
        co = rng.choice([None] * 6 + [rng.choice(staff)])
        school.row(
            f"R{index}",
            subject=rng.choice(["Ma", "Sv", "En"]),
            group=rng.choice(["7A", "7B", "8A"]),
            minutes=rng.choice([0, 40, 59.3, 60, 120]),
            fixed=rng.random() < 0.2,
            current=current,
            co=None if co == current else co,
            eligible=rng.sample(staff, rng.randint(0, len(staff))),
            last_year=rng.sample(staff, rng.randint(0, 1)),
        )
    return school


def _assignment(problem, response: StaffResponse) -> list[int | None]:
    """A response read back as the solver's own Assignment."""
    teacher_at = {teacher.id: index for index, teacher in enumerate(problem.teachers)}
    row_at = {row.id: index for index, row in enumerate(problem.rows)}
    answer: list[int | None] = [None] * len(problem.rows)
    for assignment in response.assignments:
        answer[row_at[assignment.requirement_id]] = teacher_at[assignment.teacher_id]
    return answer


def _every_answer(problem):
    """Every assignment the hard rules allow, by brute force over the domains."""
    options = [
        list(problem.domain[row]) + ([None] if row not in problem.current else [])
        for row in problem.free
    ]
    for choice in itertools.product(*options):
        answer: list[int | None] = [None] * len(problem.rows)
        for row, teacher in zip(problem.free, choice, strict=True):
            answer[row] = teacher
        try:
            check(problem, answer)
        except SolverBuildError:
            continue
        yield answer


# ---------------------------------------------------------------------------
# The hard rules.
# ---------------------------------------------------------------------------


def test_capacity_is_never_exceeded_and_a_row_without_room_is_no_variable() -> None:
    school = School(tolerance=0)
    school.teacher("A", target=100)
    school.row("R1", group="7A", eligible=["A"])
    school.row("R2", group="7B", eligible=["A"])
    school.row("Big", group="7C", minutes=120, eligible=["A"])

    problem = _problem(school)
    assert problem.domain[2] == ()  # 120 min against 100.4: not even a variable

    answer = school.solve()
    assert len([row for row, lead in answer.leads.items() if lead == "A"]) == 1
    assert set(answer.reasons.values()) == {"NO_CAPACITY_LEFT"}
    assert answer.response.status == "OPTIMAL"


def test_an_unqualified_teacher_is_never_newly_given_a_row_under_respect() -> None:
    def school(respect: bool) -> School:
        built = School(respect=respect, tolerance=0)
        built.teacher("Q", target=600, fixed=600)  # qualified, and full
        built.teacher("U", target=600)  # room, and no behörighet
        built.row("R", eligible=["Q"])
        return built

    respected = school(True).solve()
    assert respected.leads == {}
    assert respected.reasons == {"R": "NO_CAPACITY_LEFT"}

    ignored = school(False).solve()
    assert ignored.leads == {"R": "U"}
    assert ignored.response.terms.after.unqualified_assignments == 1


def test_a_co_teacher_is_never_made_the_lead() -> None:
    school = School()
    school.teacher("C", target=600)
    school.row("R", co="C", eligible=["C"])

    assert _problem(school).domain[0] == ()
    answer = school.solve()
    assert answer.leads == {}
    # Only the co-teacher qualifies: the row's reason, never a conflict line
    # saying nobody active holds a behörighet — somebody does.
    assert answer.reasons == {"R": "NO_QUALIFIED_TEACHER"}
    assert answer.codes() == []


def test_a_fixed_row_has_no_variable_and_its_minutes_are_not_added() -> None:
    """fixedTenths is authoritative: the gateway already counted the fixed
    row in it. Adding the row's charge again would put A over the limit."""
    school = School(tolerance=0)
    school.teacher("A", target=100, fixed=0)
    school.row("F", fixed=True, current="A", minutes=600, eligible=["A"])
    school.row("R", minutes=100, eligible=["A"])

    problem = _problem(school)
    assert 0 not in problem.domain and problem.free == [1]

    answer = school.solve()
    assert answer.leads == {"R": "A"}
    # A is already in 7A through the fixed row: no new teacher in the class.
    assert answer.response.terms.after.new_class_teachers == 0


@pytest.mark.parametrize("kind", ["no target", "target zero", "over the limit"])
def test_a_teacher_who_may_not_grow_keeps_or_sheds_their_own_rows_only(kind: str) -> None:
    school = School(tolerance=0)
    if kind == "no target":
        school.teacher("K")
    elif kind == "target zero":
        school.teacher("K", target=0)
    else:
        school.teacher("K", target=100, fixed=100)
    school.teacher("N", target=600)
    school.row("Kept", group="7A", current="K", eligible=["K", "N"])
    school.row("Open", group="7B", eligible=["K", "N"])

    problem = _problem(school)
    assert problem.normal == [False, True]
    assert problem.domain[1] == (1,)  # only N may take the open row

    answer = school.solve()
    assert answer.leads["Open"] == "N"
    assert answer.leads["Kept"] in {"K", "N"}


def test_a_kept_row_is_never_unstaffed_even_with_nobody_qualified_holding_it() -> None:
    school = School(tolerance=0)
    school.teacher("K", target=600)  # leads it today, without a behörighet
    school.teacher("Q", target=600, fixed=600)  # holds one, and has no room
    school.row("Kept", current="K", eligible=["Q"])

    answer = school.solve()
    assert answer.leads == {"Kept": "K"}
    assert answer.reasons == {}
    assert answer.response.terms.after.unqualified_assignments == 1


def test_the_status_quo_is_always_feasible_and_infeasible_never_happens() -> None:
    settings = _settings(STAFF_SOLVER_MAX_TIME_SECONDS=2.0)
    statuses = set()
    for seed in range(200):
        school = _random_school(seed)
        problem = _problem(school)
        check(problem, status_quo(problem))
        check(problem, greedy(problem).answer)
        response = StaffingSolver(settings).solve(school.request())
        check(problem, _assignment(problem, response))
        statuses.add(response.status)
    assert statuses <= {"OPTIMAL", "FEASIBLE"}


def test_a_zero_minute_open_row_still_costs_a_row() -> None:
    school = School(tolerance=0)
    school.teacher("A", target=600, fixed=600)  # room for nothing but nothing
    school.row("Zero", minutes=0, eligible=["A"])
    school.row("Hour", group="7B", minutes=60, eligible=["A"])

    problem = _problem(school)
    assert evaluate(problem, status_quo(problem)).primary == (60 + 0) + (60 + 60)

    answer = school.solve()
    assert answer.leads == {"Zero": "A"}
    assert answer.reasons == {"Hour": "NO_CAPACITY_LEFT"}


def test_tenths_keep_fractional_rows_that_whole_minutes_would_lose() -> None:
    """Ten rows of 59.3 minutes at tolerance 0 against a 593-minute target:
    each one rounded up to 60 would come to 600 and leave one out."""
    school = School(tolerance=0)
    school.teacher("A", target=593)
    for index in range(10):
        school.row(f"R{index}", group=f"G{index}", minutes=59.3, eligible=["A"])

    answer = school.solve()
    assert len(answer.leads) == 10
    assert answer.reasons == {}


# ---------------------------------------------------------------------------
# The objective, one term at a time.
# ---------------------------------------------------------------------------


def _two_teachers(**weights: int) -> School:
    """A under target; B at it, and already in 7A through a fixed row."""
    school = School(**weights)
    school.teacher("A", target=600)
    school.teacher("B", target=600, fixed=600)
    school.row("F", fixed=True, current="B", subject="Sv", eligible=["B"])
    school.row("R", eligible=["A", "B"])
    return school


def test_balance_fills_the_teacher_under_target_before_one_already_in_the_class() -> None:
    assert _two_teachers().solve().leads == {"R": "A"}
    # Switched off, the class term alone decides.
    assert _two_teachers(balance=0).solve().leads == {"R": "B"}
    # And weighted past balance's 120 minutes, it wins.
    assert _two_teachers(classTeachers=10).solve().leads == {"R": "B"}


def test_the_under_band_term_lifts_the_teacher_below_the_band_first() -> None:
    """Σ|load − target| cannot tell two teachers under target apart: here
    both answers are 160 minutes from target in total. The band can: B is
    below it, A is not."""
    school = School()
    school.teacher("A", target=1000, fixed=950)
    school.teacher("B", target=1000, fixed=850)
    school.row("R", minutes=40, eligible=["A", "B"])

    problem = _problem(school)
    to_a = evaluate(problem, [0])
    to_b = evaluate(problem, [1])
    assert to_a.deviation == to_b.deviation
    assert to_b.under_band < to_a.under_band

    assert school.solve().leads == {"R": "B"}


def _continuity(**weights: int) -> School:
    """A is in the class already; B taught the row last year."""
    school = School(**weights)
    school.teacher("A", target=600, fixed=300)
    school.teacher("B", target=600, fixed=300)
    school.row("F", fixed=True, current="A", subject="Sv", eligible=["A"])
    school.row("R", eligible=["A", "B"], last_year=["B"])
    return school


def test_last_years_teacher_outweighs_one_already_in_the_class() -> None:
    assert _continuity().solve().leads == {"R": "B"}
    assert _continuity(continuity=0).solve().leads == {"R": "A"}
    assert _continuity(classTeachers=0).solve().leads == {"R": "B"}


def test_continuity_never_moves_a_kept_row() -> None:
    """Last year's teacher matters only for a row nobody leads now: the Fas 5
    roll carried last year's lead onto this year's rows, and an admin who has
    changed one since did it on purpose. Even at continuity 100 with
    keepCurrent off, the row stays where balance wants it."""
    school = School(keepCurrent=0, continuity=100)
    school.teacher("A", target=1000, fixed=900)
    school.teacher("B", target=1000, fixed=905)
    school.row("Kept", minutes=100, current="A", eligible=["A", "B"], last_year=["B"])

    answer = school.solve()
    assert answer.leads == {"Kept": "A"}
    assert answer.response.terms.after.continuity_changes == 0


def _kept_with_a_small_gain(**weights: int) -> School:
    """Moving the row to B would gain 60 minutes of balance."""
    school = School(**weights)
    school.teacher("A", target=1000, fixed=950)
    school.teacher("B", target=1000, fixed=920)
    school.row("Kept", minutes=100, current="A", eligible=["A", "B"])
    return school


def test_keep_current_holds_a_row_against_a_small_gain_in_balance() -> None:
    assert _kept_with_a_small_gain().solve().leads == {"Kept": "A"}
    moved = _kept_with_a_small_gain(keepCurrent=0).solve()
    assert moved.leads == {"Kept": "B"}
    assert moved.response.terms.after.current_changes == 1


def _qualified_or_not(*, recorded: bool = True, **weights: int) -> School:
    """Balance prefers A by 40 minutes; only B is in the row's set."""
    school = School(respect=False, recorded=recorded, **weights)
    school.teacher("A", target=600, fixed=550)
    school.teacher("B", target=600, fixed=570)
    school.row("R", eligible=["B"])
    return school


def test_the_unqualified_weight_prefers_a_qualified_teacher_when_not_respected() -> None:
    assert _qualified_or_not().solve().leads == {"R": "B"}
    assert _qualified_or_not(unqualified=0).solve().leads == {"R": "A"}


def test_with_nothing_recorded_the_subjects_own_teachers_are_preferred() -> None:
    """With no behörigheter recorded the set is "who already teaches the
    subject": a new placement outside it costs the same weight, a teacher
    keeping the row they lead does not."""
    assert _qualified_or_not(recorded=False).solve().leads == {"R": "B"}
    assert _qualified_or_not(recorded=False, unqualified=0).solve().leads == {"R": "A"}

    for recorded, cost in ((False, 0), (True, 1)):
        school = School(respect=False, recorded=recorded)
        school.teacher("K", target=600)
        school.teacher("B", target=600)
        school.row("Kept", current="K", eligible=["B"])
        problem = _problem(school)
        assert evaluate(problem, status_quo(problem)).unqualified == cost


def test_no_weight_ever_trades_a_staffable_row_for_anything_else() -> None:
    """Unstaffed is lexicographically first, so no weight in 0..100 can make
    the proposal staff fewer rows than the best any answer staffs."""
    settings = _settings(STAFF_SOLVER_MAX_TIME_SECONDS=3.0)
    rng = random.Random(7)
    for seed in range(40):
        school = _random_school(seed, teachers=4, rows=6)
        school.weights = {
            name: rng.randint(0, 100)
            for name in ("balance", "classTeachers", "continuity", "keepCurrent", "unqualified")
        }
        problem = _problem(school)
        best = min(evaluate(problem, answer).primary for answer in _every_answer(problem))
        response = StaffingSolver(settings).solve(school.request())
        assert response.unstaffed_proven
        assert evaluate(problem, _assignment(problem, response)).primary == best, seed


# ---------------------------------------------------------------------------
# Verdicts, reasons and refusals.
# ---------------------------------------------------------------------------


def test_rows_nobody_is_qualified_for_are_one_line_per_subject_and_years() -> None:
    school = School()
    school.teacher("A", target=600)
    school.row("Ma7a", group="7A", grades=(7, 7))
    school.row("Ma7b", group="7B", grades=(7, 7))
    school.row("Ma89", group="8A", grades=(8, 9))
    school.row("Sv", subject="Sv", group="7A", eligible=["A"])

    answer = school.solve()
    assert answer.leads == {"Sv": "A"}
    assert answer.reasons == {
        "Ma7a": "NO_QUALIFIED_TEACHER", "Ma7b": "NO_QUALIFIED_TEACHER",
        "Ma89": "NO_QUALIFIED_TEACHER",
    }
    lines = answer.response.conflicts
    assert [line.code for line in lines] == ["STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT"] * 2
    subject = school.id("subject:Ma")
    assert lines[0].params == {"subject": subject, "grades": "7", "count": 2}
    assert lines[1].params == {"subject": subject, "grades": "8–9", "count": 1}
    assert [str(i) for i in lines[0].requirement_ids] == [school.id("Ma7a"), school.id("Ma7b")]
    assert [str(i) for i in lines[0].subject_ids] == [subject]
    assert lines[0].message == (
        f"2 curriculum entries in {subject} for years 7 cannot be staffed: no active teacher "
        "holds a qualification that covers them. Record a qualification, or propose without "
        "respecting qualifications."
    )

    # Not respected, the same rows are staffed and nothing is refused.
    school.respect = False
    relaxed = school.solve()
    assert relaxed.reasons == {}
    assert "STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT" not in relaxed.codes()


def test_nobody_with_a_target_is_its_own_reason() -> None:
    school = School(respect=False)
    school.teacher("None")
    school.teacher("Zero", target=0)
    school.row("R", eligible=["None", "Zero"])

    answer = school.solve()
    assert answer.reasons == {"R": "NO_TEACHER_WITH_TARGET"}
    # A full nedsättning is not a capacity problem to report.
    assert answer.codes() == []


def test_a_candidate_with_room_left_unused_is_not_reached() -> None:
    """Only a search cut short can leave one; judged on the answer given."""
    school = School()
    school.teacher("A", target=600)
    school.row("R", eligible=["A"])
    problem = _problem(school)
    loads = answer_loads(problem, status_quo(problem))
    assert unstaffed_reason(problem, 0, loads) == "NOT_REACHED"


def test_a_subject_short_of_teachers_is_named_with_its_arithmetic() -> None:
    school = School(tolerance=0)
    school.teacher("A", target=100)
    for group in ("7A", "7B", "7C"):
        school.row(f"Ma{group}", group=group, eligible=["A"])

    answer = school.solve()
    line = answer.response.conflicts[0]
    assert line.code == "STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT"
    assert line.params == {
        "subject": school.id("subject:Ma"),
        "count": 3,
        "demandedMinutes": 180,
        "availableMinutes": 100,
        "shortMinutes": 80,
    }
    assert line.teacher_ids == []
    unstaffed = sum(60 for reason in answer.reasons.values())
    assert unstaffed >= line.params["shortMinutes"]


def test_a_teacher_already_at_the_limit_is_a_line_that_names_nobody() -> None:
    school = School(tolerance=0)
    school.teacher("Full", target=600, fixed=600)
    school.teacher("Zero", target=0)
    school.row("R", eligible=["Full", "Zero"])

    answer = school.solve()
    [line] = [c for c in answer.response.conflicts if c.code == "STAFF_TEACHER_CAPACITY_ZERO"]
    assert line.params == {"fixedMinutes": 600, "limitMinutes": 600}
    assert [str(t) for t in line.teacher_ids] == [school.id("Full")]
    assert line.message == (
        "Already carries 600 minutes a week against a limit of 600, so no further curriculum "
        "entry fits."
    )
    # The person is an id in its own field, never in the sentence.
    for teacher in school.teachers:
        assert teacher["id"] not in line.message
        assert teacher["id"] not in {str(value) for value in line.params.values()}


def test_the_capacity_verdict_is_a_lower_bound_the_best_answer_respects() -> None:
    """Brute force on small schools: no answer at all leaves less of the
    subject unstaffed than the verdict says will be."""
    lines_seen = 0
    for seed in range(60):
        # Targets small enough that a subject runs out.
        school = _random_school(seed, teachers=4, rows=6, targets=(None, 60, 100, 150))
        problem = _problem(school)
        for line in verdicts(problem):
            if line.code != "STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT":
                continue
            lines_seen += 1
            rows = {r for r in problem.free if problem.rows[r].subject_id == line.subject_ids[0]}
            least = min(
                sum(problem.rows[r].charge_tenths for r in rows if answer[r] is None)
                for answer in _every_answer(problem)
            )
            assert math.ceil(least / 10) >= line.params["shortMinutes"], seed
    assert lines_seen > 0, "no fixture exercised the verdict"


# ---------------------------------------------------------------------------
# Robustness.
# ---------------------------------------------------------------------------


def test_every_broken_answer_is_a_build_error_not_a_proposal() -> None:
    school = School(tolerance=0)
    school.teacher("K")  # keep-or-shed
    school.teacher("Q", target=100)
    school.teacher("C", target=600)
    school.row("Kept", group="7A", current="K", eligible=["Q"])
    school.row("Open", group="7B", co="C", eligible=["Q"])
    school.row("Other", group="7C", eligible=["Q"])
    problem = _problem(school)
    k, q, c = 0, 1, 2

    broken = {
        "left kept row": [None, None, None],
        "co-teacher its lead": [k, c, None],
        "keep-or-shed teacher": [k, k, None],
        "unqualified teacher": [k, None, c],
        "over their limit": [k, q, q],
    }
    check(problem, [k, q, None])
    for says, answer in broken.items():
        with pytest.raises(SolverBuildError, match=says):
            check(problem, answer)


class _Spy(cp_model.CpSolver):
    """Records every Solve's limit and can override what it answers."""

    seen: list[float] = []
    answers: list[int | None] = []

    def Solve(self, model, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202, N802
        _Spy.seen.append(self.parameters.max_time_in_seconds)
        override = _Spy.answers.pop(0) if _Spy.answers else None
        if override in (cp_model.UNKNOWN, cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
            return override  # without a solve: there is nothing to read
        code = super().Solve(model, *args, **kwargs)
        return code if override is None else override


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch) -> type[_Spy]:
    _Spy.seen = []
    _Spy.answers = []
    monkeypatch.setattr(staffing_solver.cp_model, "CpSolver", _Spy)
    return _Spy


def test_with_no_answer_from_cp_sat_the_greedy_stands(spy: type[_Spy]) -> None:
    spy.answers = [cp_model.UNKNOWN, cp_model.UNKNOWN]
    school = _continuity()
    answer = school.solve()
    problem = _problem(school)
    assert answer.leads == {"R": "B"}  # the greedy's: last year's teacher first
    assert _assignment(problem, answer.response) == greedy(problem).answer
    assert answer.response.status == "FEASIBLE"
    assert answer.response.unstaffed_proven is False


def test_optimal_only_when_both_stages_are_proven(spy: type[_Spy]) -> None:
    spy.answers = [None, cp_model.FEASIBLE]
    answer = _continuity().solve()
    assert answer.response.status == "FEASIBLE"
    assert answer.response.unstaffed_proven is True

    spy.answers = []
    assert _continuity().solve().response.status == "OPTIMAL"


def test_a_model_that_refuses_the_status_quo_is_a_build_error(spy: type[_Spy]) -> None:
    spy.answers = [cp_model.INFEASIBLE]
    with pytest.raises(SolverBuildError, match="refused the status quo"):
        _continuity().solve()
    spy.answers = [None, cp_model.MODEL_INVALID]
    with pytest.raises(SolverBuildError, match="rejected the staffing model"):
        _continuity().solve()


def test_a_canonical_pass_out_of_budget_keeps_the_proven_optimum(spy: type[_Spy]) -> None:
    spy.answers = [None, None, cp_model.UNKNOWN]
    answer = _continuity().solve()
    assert answer.response.status == "OPTIMAL"
    assert answer.leads == {"R": "B"}


def test_the_size_guard_refuses_before_anything_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def never(*_args: object) -> None:
        raise AssertionError("build_model ran for a model it had already refused")

    school = _random_school(3)
    problem = _problem(school)
    built = build_model(problem, greedy(problem).order)
    size = estimate_model_size(problem)
    assert size >= len(built.x) + len(built.y) + len(problem.teachers)

    monkeypatch.setattr(staffing_solver, "MAX_MODEL_VARIABLES", size - 1)
    monkeypatch.setattr(staffing_solver, "build_model", never)
    monkeypatch.setattr(staffing_solver, "build_domains", never)
    with pytest.raises(InvalidScheduleInputError) as refused:
        StaffingSolver(SETTINGS).solve(school.request())
    assert refused.value.code == "STAFF_MODEL_TOO_LARGE"
    assert refused.value.params == {"variables": size, "limit": size - 1}


def test_the_size_estimate_counts_each_rows_candidates_exactly() -> None:
    """Counted by bisection over the teachers' room, never by building the
    domains — that walk is what the guard exists to refuse."""
    for seed in range(80):
        school = _random_school(seed)
        problem = _problem(school)
        assert candidate_counts(problem) == {
            row: len(domain) for row, domain in problem.domain.items()
        }, seed
        built = build_model(problem, greedy(problem).order)
        assert estimate_model_size(problem) >= len(built.x) + len(built.y) + len(problem.teachers)


def test_two_leads_read_off_the_model_are_a_build_error() -> None:
    school = School()
    school.teacher("A", target=600)
    school.teacher("B", target=600)
    school.row("R", eligible=["A", "B"])
    problem = _problem(school)
    built = build_model(problem, greedy(problem).order)

    class EveryLiteralTrue:
        @staticmethod
        def Value(_literal: object) -> int:  # noqa: N802
            return 1

    with pytest.raises(SolverBuildError, match="two leads"):
        staffing_solver._read(problem, built, EveryLiteralTrue())  # type: ignore[arg-type]


def test_a_school_with_nothing_free_is_answered_without_a_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(staffing_solver, "build_model", lambda *_a: pytest.fail("built"))
    school = School()
    school.teacher("A", target=600)
    school.row("F", fixed=True, current="A", eligible=["A"])
    answer = school.solve()
    assert answer.response.status == "OPTIMAL"
    assert answer.response.unstaffed_proven is True
    assert answer.leads == {} and answer.reasons == {}


# ---------------------------------------------------------------------------
# Determinism.
# ---------------------------------------------------------------------------


def _relabelled(school: School) -> School:
    """The same school under fresh uuids — what the gateway sends next time."""
    other = School(respect=school.respect, recorded=school.recorded, **school.weights)
    mapping = {
        old: str(uuid4()) for old in [*school.ids.values(), *school._sets.values()]
    }
    other.teachers = [{**t, "id": mapping[t["id"]]} for t in school.teachers]
    other.rows = [
        {
            **r,
            **{
                key: mapping[r[key]] if r[key] else None
                for key in ("id", "subjectId", "studentGroupId", "currentTeacherId",
                            "coTeacherId", "eligibilitySetId")
            },
            "lastYearTeacherIds": [mapping[t] for t in r["lastYearTeacherIds"]],
        }
        for r in school.rows
    ]
    other._sets = {
        tuple(mapping[t] for t in members): mapping[set_id]
        for members, set_id in school._sets.items()
    }
    return other


def test_the_model_is_byte_identical_however_often_and_under_whatever_ids() -> None:
    for seed in range(20):
        school = _random_school(seed)
        protos = []
        for candidate in (school, school, _relabelled(school)):
            problem = _problem(candidate)
            built = build_model(problem, greedy(problem).order)
            protos.append(str(built.model.Proto()))  # the full text format
        assert protos[0] == protos[1] == protos[2], seed


def test_a_proven_answer_is_the_same_on_every_press() -> None:
    """Including the six small schools on which the parallel portfolio, left
    alone, returned a different (equally optimal) answer between presses."""
    for seed in (0, 19, 20, 23, 44, 51, 3, 7):
        request = _random_school(seed).request()
        dumps = set()
        for _ in range(5):
            response = StaffingSolver(SETTINGS).solve(request)
            assert response.status == "OPTIMAL", seed
            dumps.add(response.model_dump_json())
        assert len(dumps) == 1, seed


def test_the_unstaffed_verdict_repeats_on_the_bench_school() -> None:
    request = StaffRequest.model_validate(build_school())
    settings = _settings(STAFF_SOLVER_MAX_TIME_SECONDS=1.5)
    seen = set()
    for _ in range(3):
        response = StaffingSolver(settings).solve(request)
        assert response.unstaffed_proven
        seen.add((
            tuple(u.requirement_id for u in response.unstaffed),
            response.terms.after.unstaffed_rows,
            response.terms.after.unstaffed_minutes,
        ))
    assert len(seen) == 1


def test_everything_comes_back_in_payload_order() -> None:
    school = _random_school(11, teachers=6, rows=12)
    school.respect = True
    response = school.solve().response
    order = [row["id"] for row in school.rows]
    for listed in ([a.requirement_id for a in response.assignments],
                   [u.requirement_id for u in response.unstaffed]):
        positions = [order.index(str(i)) for i in listed]
        assert positions == sorted(positions)
    firsts = [
        order.index(str(line.requirement_ids[0]))
        for line in response.conflicts if line.code == "STAFF_NO_QUALIFIED_TEACHER_FOR_REQUIREMENT"
    ]
    assert firsts == sorted(firsts)


# ---------------------------------------------------------------------------
# The 60-teacher, 400-row bench.
# ---------------------------------------------------------------------------


def test_the_sixty_teacher_school_is_staffed_inside_the_cap() -> None:
    """What holds on any host: CI runs this on a shared GitHub runner. The
    strict numbers — stage 1 proven, under 10 s — hold on the 8-core Mac the
    budget was set on, and are asserted only with STAFF_BENCH_STRICT=1.
    benchmarks/staff_60x400.py records them with the host's load."""
    request = StaffRequest.model_validate(build_school())
    settings = _settings()
    began = time.monotonic()
    response = StaffingSolver(settings).solve(request)
    wall = time.monotonic() - began

    problem = prepare(request)
    build_domains(problem)
    answer = _assignment(problem, response)
    check(problem, answer)
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert wall < settings.staff_solver_max_time_seconds + 3.0, wall
    assert evaluate(problem, answer).primary <= evaluate(problem, greedy(problem).answer).primary
    for line in response.conflicts:
        if line.code == "STAFF_CAPACITY_EXHAUSTED_FOR_SUBJECT":
            short = sum(
                problem.rows[r].charge_tenths for r in problem.free
                if answer[r] is None and problem.rows[r].subject_id == line.subject_ids[0]
            )
            assert math.ceil(short / 10) >= line.params["shortMinutes"]
    if os.environ.get("STAFF_BENCH_STRICT") == "1":
        assert response.unstaffed_proven
        assert wall < 10.0, wall


# ---------------------------------------------------------------------------
# The route, the settings and the other two contracts.
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(SETTINGS))


def test_the_route_answers_with_the_key_and_refuses_without(client: TestClient) -> None:
    payload = _continuity().payload()
    assert client.post("/api/v1/staff", json=payload).status_code == 401

    response = client.post("/api/v1/staff", json=payload, headers={"X-API-Key": API_KEY})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["requestId"] == payload["requestId"]
    assert body["status"] == "OPTIMAL"
    assert body["unstaffedProven"] is True
    assert body["assignments"] == [{"requirementId": payload["requirements"][1]["id"],
                                    "teacherId": payload["teachers"][1]["id"]}]
    assert body["unstaffed"] == [] and body["conflicts"] == []
    assert set(body["terms"]["after"]) == _field_names(StaffTerms)


@pytest.mark.parametrize(
    "breakage",
    ["a teacher nobody sent", "the same teacher twice", "respect without records",
     "lead and co-teacher the same", "a field the engine never heard of",
     "a set nobody sent", "a limit under the target", "half a band", "a weight over 100",
     "a floor over the target", "the same row twice", "the same set twice",
     "a set naming a stranger", "a set naming one teacher twice",
     "last year's teacher twice", "years upside down"],
)
def test_a_malformed_staffing_request_is_a_422(client: TestClient, breakage: str) -> None:
    payload = _continuity().payload()
    row = payload["requirements"][1]
    teacher = payload["teachers"][0]
    if breakage == "a teacher nobody sent":
        row["currentTeacherId"] = str(uuid4())
    elif breakage == "the same teacher twice":
        payload["teachers"].append(dict(teacher))
    elif breakage == "respect without records":
        payload["qualificationsRecorded"] = False
    elif breakage == "lead and co-teacher the same":
        row["currentTeacherId"] = row["coTeacherId"] = teacher["id"]
    elif breakage == "a field the engine never heard of":
        teacher["employmentPercent"] = 100
    elif breakage == "a set nobody sent":
        row["eligibilitySetId"] = str(uuid4())
    elif breakage == "a limit under the target":
        teacher["limitTenths"] = teacher["targetTenths"] - 1
    elif breakage == "half a band":
        del teacher["floorTenths"]
    elif breakage == "a weight over 100":
        payload["weights"] = {"balance": 101}
    elif breakage == "a floor over the target":
        teacher["floorTenths"] = teacher["targetTenths"] + 1
    elif breakage == "the same row twice":
        payload["requirements"].append(dict(row))
    elif breakage == "the same set twice":
        payload["eligibilitySets"].append(dict(payload["eligibilitySets"][0]))
    elif breakage == "a set naming a stranger":
        payload["eligibilitySets"][0]["teacherIds"].append(str(uuid4()))
    elif breakage == "a set naming one teacher twice":
        members = payload["eligibilitySets"][0]["teacherIds"]
        members.append(members[0])
    elif breakage == "last year's teacher twice":
        row["lastYearTeacherIds"] = row["lastYearTeacherIds"] * 2
    else:
        row["minGradeLevel"], row["maxGradeLevel"] = 9, 7

    response = client.post("/api/v1/staff", json=payload, headers={"X-API-Key": API_KEY})
    assert response.status_code == 422, breakage


def test_a_school_too_large_to_build_is_a_400_with_its_code(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(staffing_solver, "MAX_MODEL_VARIABLES", 3)
    response = client.post(
        "/api/v1/staff", json=_continuity().payload(), headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 400, response.text
    details = response.json()["details"]
    assert details["code"] == "STAFF_MODEL_TOO_LARGE"
    assert details["params"]["limit"] == 3
    assert details["params"]["variables"] > 3


def test_the_solve_runs_off_the_event_loop_under_the_staffing_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    released = threading.Event()
    threads_with_a_loop: list[bool] = []
    original = StaffingSolver.solve

    def stuck(self: StaffingSolver, payload: StaffRequest) -> StaffResponse:
        try:
            asyncio.get_running_loop()
            threads_with_a_loop.append(True)
        except RuntimeError:
            threads_with_a_loop.append(False)
        released.wait(timeout=5.0)
        return original(self, payload)

    monkeypatch.setattr(StaffingSolver, "solve", stuck)
    monkeypatch.setattr(staffing_route, "_BUILD_HEADROOM_SECONDS", 0.3)
    app = create_app(_settings(STAFF_SOLVER_MAX_TIME_SECONDS=0.2, SOLVER_MAX_TIME_SECONDS=60.0))

    with TestClient(app) as client_:
        try:
            began = time.monotonic()
            response = client_.post(
                "/api/v1/staff", json=_continuity().payload(), headers={"X-API-Key": API_KEY},
            )
            waited = time.monotonic() - began
        finally:
            released.set()

    assert response.status_code == 503, response.text
    assert threads_with_a_loop == [False]
    assert 0.45 <= waited < 4.0, waited


def test_a_build_that_eats_the_cap_answers_with_the_greedy(
    spy: type[_Spy], monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cap is the request's, not the search's: when everything before the
    search has used it, no stage starts and the greedy is the answer."""
    original = staffing_solver.build_model

    def slow(*args: object) -> staffing_solver.StaffModel:
        built = original(*args)  # type: ignore[arg-type]
        time.sleep(0.3)
        return built

    monkeypatch.setattr(staffing_solver, "build_model", slow)
    school = _continuity()
    answer = school.solve(_settings(STAFF_SOLVER_MAX_TIME_SECONDS=0.4))
    assert spy.seen == []
    assert answer.response.status == "FEASIBLE"
    assert answer.response.unstaffed_proven is False
    assert answer.leads == {"R": "B"}


def test_the_staffing_budget_is_its_own_setting(spy: type[_Spy]) -> None:
    assert Settings.model_fields["staff_solver_max_time_seconds"].default == 10.0
    with pytest.raises(ValidationError):
        _settings(STAFF_SOLVER_MAX_TIME_SECONDS=0)

    _continuity().solve(_settings(STAFF_SOLVER_MAX_TIME_SECONDS=3.0))
    # Stage 1 gets 40 % of it; stage 2 and the canonical pass what is left.
    assert spy.seen[0] == pytest.approx(1.2)
    assert all(seconds <= 3.0 for seconds in spy.seen)
    assert len(spy.seen) == 3


def test_the_other_two_contracts_are_untouched_by_the_new_route() -> None:
    """/optimize and /optimize-rooms answer the gateway byte for byte as
    before: the OpenAPI document of both, components included, is the same
    with the staffing route as without it. A model here that reused one of
    their names would rename theirs."""
    app = create_app(SETTINGS)
    with_staff = app.openapi()
    without = get_openapi(
        title=app.title,
        version=app.version,
        routes=[route for route in app.routes if getattr(route, "path", "") != "/api/v1/staff"],
    )
    for path in ("/api/v1/optimize", "/api/v1/optimize-rooms"):
        assert with_staff["paths"][path] == without["paths"][path]
    for name, schema in without["components"]["schemas"].items():
        assert with_staff["components"]["schemas"][name] == schema, name
    assert "/api/v1/staff" in with_staff["paths"]
