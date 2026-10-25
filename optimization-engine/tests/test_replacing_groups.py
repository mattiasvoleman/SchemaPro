"""Ersättande grupper: SvA7 replaces 7A's svenska for the pupils in it.

The user's decision: an SvA pupil goes to SvA INSTEAD of 7A's svenska, so
SvA7's lessons may run beside 7A's svenska and beside nothing else of 7A's.
No parallel block. The engine keeps pupils apart only through groupConflicts,
so the gateway — Halvklasser-style — coins one anonymous id per group and
replaced subject: X, "7A's svenska without SvA7". It reaches the engine as
the svenska requirement's `pupilGroupId` (a locked svenska's
`pupilGroupIds`) and in groupConflicts, paired with 7A and 7A's other
partners and never with SvA7. The pair (7A, SvA7) stays: SvA pupils sit
7A's matte.

TWO KEY SPACES (scheduler_solver.pupil_key_of). Who may not overlap whom
reads the pupils: X for the svenska. What is a rule about the class — the
daily maximum, a reservation on 7A, 7A's lunch, every name in a refusal —
reads the class: 7A for the svenska, exactly as before. These tests pin both
halves, and that a payload without the fields is the week it always was.

THE SCAFFOLDING is one short Monday and lessons of an hour, so every case is
arithmetic: a day of six hours holds 7A's six and SvA7's three only if SvA
sits on top of the svenska.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import (
    FixedLesson,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    ScheduledLesson,
)
from app.solver.scheduler_solver import (
    SchedulerSolver,
    _solve_guarded,
    pupil_key_of,
    pupil_keys_of,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from validate_schedule import _travel_problems, validate  # noqa: E402

CLASS_7A = str(uuid4())
SVA7 = str(uuid4())
#: "7A's svenska without SvA7": the derived pupil key, a group nobody has.
WITHOUT_SVA = str(uuid4())
SVENSKA = str(uuid4())
MATTE = str(uuid4())
SVA = str(uuid4())
NORRA = str(uuid4())
SODRA = str(uuid4())

#: What the gateway sends: SvA pupils sit 7A's other lessons, and the derived
#: key is 7A's. Never (WITHOUT_SVA, SVA7).
PAIRS = [[CLASS_7A, SVA7], [CLASS_7A, WITHOUT_SVA]]
#: Today's payload: no derived key anywhere.
TODAY = [[CLASS_7A, SVA7]]

#: 08:00-14:00, Monday only: six hours.
SIX_HOURS = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 840}
#: 08:00-10:00, Monday only: two hours, back to back.
TWO_HOURS = {"SCHEDULE_DAYS": "1", "SCHEDULE_DAY_END_MINUTES": 600}

_SOLVED = {"OPTIMAL", "FEASIBLE"}


def _settings(**overrides: object) -> Settings:
    return Settings(  # type: ignore[arg-type]
        SOLVER_MAX_TIME_SECONDS=10.0, SOLVER_PROBE_SECONDS=5.0, **{**SIX_HOURS, **overrides},
    )


def _requirement(
    requirement_id: str, group: str, lessons: int, *, pupils: str | None = None,
    teacher: str | None = None, **values: object,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": requirement_id,
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher or str(uuid4()),
        "lessonsPerWeek": lessons,
        "minutesPerLesson": 60,
        "studentGroupSize": 12,
    }
    if pupils is not None:
        row["pupilGroupId"] = pupils
    row.update(values)
    return row


def _week(
    *, svenska: int = 3, matte: int = 3, sva: int = 3, derived: bool = True,
    conflicts: list[list[str]] | None = None, **extra: object,
) -> dict[str, object]:
    """7A's svenska and matte, SvA7's SvA; the svenska sat by WITHOUT_SVA when `derived`."""
    requirements = []
    if svenska:
        requirements.append(_requirement(
            SVENSKA, CLASS_7A, svenska, pupils=WITHOUT_SVA if derived else None,
        ))
    if matte:
        requirements.append(_requirement(MATTE, CLASS_7A, matte))
    if sva:
        requirements.append(_requirement(SVA, SVA7, sva))
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [{"id": CLASS_7A, "lunchHeadcount": 24}],
        "rooms": [{"id": str(uuid4()), "capacity": 30} for _ in range(4)],
        "groupConflicts": conflicts if conflicts is not None else (PAIRS if derived else TODAY),
    }
    payload.update(extra)
    return payload


def _solve(payload: dict[str, object], **settings: object) -> OptimizeScheduleResponse:
    return SchedulerSolver(_settings(**settings)).solve(OptimizeScheduleRequest.model_validate(payload))


def _minutes(clock: str) -> int:
    hours, mins, *_ = (int(part) for part in clock.split(":"))
    return hours * 60 + mins


def _spans(lessons: list[ScheduledLesson], requirement_id: str) -> list[tuple[int, int]]:
    return sorted(
        (_minutes(lesson.start_time), _minutes(lesson.end_time))
        for lesson in lessons
        if lesson.requirement_id == UUID(requirement_id)
    )


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> bool:
    return any(start < other_end and other_start < end for start, end in a for other_start, other_end in b)


def _disjoint(spans: list[tuple[int, int]]) -> bool:
    ordered = sorted(spans)
    return all(first[1] <= second[0] for first, second in zip(ordered, ordered[1:]))


def _validate(payload: dict[str, object], lessons: list[ScheduledLesson], **settings: object) -> list[str]:
    solver = SchedulerSolver(_settings(**settings))
    return validate(solver._grid, OptimizeScheduleRequest.model_validate(payload), lessons)


def _named(response: OptimizeScheduleResponse) -> set[UUID]:
    assert response.conflicts is not None
    return {rid for detail in response.conflicts.conflicts for rid in detail.resource_ids}


def _model_status(payload: dict[str, object], **settings: object) -> str:
    """The bare satisfaction model alone, solved: what the model says, no verdict before it."""
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = 10.0
    cp.parameters.num_workers = 1
    return cp.StatusName(_solve_guarded(cp, model, what="a test", request_id=request.request_id))


def _refused(payload: dict[str, object], **settings: object) -> bool:
    """INFEASIBLE, or refused by name before any model: either way, no timetable."""
    try:
        return _solve(payload, **settings).status == "INFEASIBLE"
    except InvalidScheduleInputError:
        return True


def _proto(payload: dict[str, object], *, objective: bool, **settings: object) -> str:
    solver = SchedulerSolver(_settings(**settings))
    model, *_ = solver._build_model(
        OptimizeScheduleRequest.model_validate(payload),
        use_assumptions=False, include_objective=objective,
    )
    return hashlib.sha256(str(model.Proto()).encode()).hexdigest()


# ---------------------------------------------------------------------------
# The contract: two optional keys, absent is today.
# ---------------------------------------------------------------------------


def test_the_keys_are_optional_and_read_as_the_groups_named_when_absent() -> None:
    """Absent pupilGroupId is the requirement's own group; absent pupilGroupIds the lock's groups.

    The two helpers ARE the pupil space: every rule that asks who sits a
    lesson asks them, so their absent reading is what keeps every payload
    without the keys the week it was.
    """
    request = OptimizeScheduleRequest.model_validate(_week(derived=False))
    for requirement in request.requirements:
        assert requirement.pupil_group_id is None
        assert pupil_key_of(requirement) == requirement.student_group_id
    request = OptimizeScheduleRequest.model_validate(_week())
    svenska = next(r for r in request.requirements if r.id == UUID(SVENSKA))
    assert pupil_key_of(svenska) == UUID(WITHOUT_SVA)
    assert svenska.student_group_id == UUID(CLASS_7A)

    other = str(uuid4())
    plain = FixedLesson.model_validate({
        "id": str(uuid4()), "studentGroupId": CLASS_7A, "extraGroupIds": [other],
        "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
    })
    assert pupil_keys_of(plain) == [UUID(CLASS_7A), UUID(other)]
    derived = plain.model_copy(update={"pupil_group_ids": [UUID(WITHOUT_SVA)]})
    assert pupil_keys_of(derived) == [UUID(WITHOUT_SVA)]


# ---------------------------------------------------------------------------
# 1. SvA beside svenska, and beside nothing else of 7A's.
# ---------------------------------------------------------------------------


def test_sva_takes_the_svenska_hours_on_a_day_that_has_no_others() -> None:
    """Six hours: 7A's three of svenska and three of matte fill them, and SvA's three fit
    only on top of the svenska. With the derived key the week is placed, SvA
    beside the svenska and clear of the matte, and 7A's own six apart."""
    payload = _week()
    response = _solve(payload)

    assert response.status in _SOLVED
    svenska, matte, sva = (_spans(response.lessons, rid) for rid in (SVENSKA, MATTE, SVA))
    assert len(svenska) == len(matte) == len(sva) == 3
    assert not _overlap(sva, matte)
    assert _disjoint(svenska + matte)
    # The only way the day holds it: every SvA hour is a svenska hour.
    assert sva == svenska
    assert _validate(payload, response.lessons) == []


def test_without_the_derived_key_the_same_day_is_refused_as_it_always_was() -> None:
    """Today's payload: the svenska is all of 7A's, 7A pairs SvA7, and nine hours
    of lessons that may not overlap do not fit six. Refused before any model,
    by the clique's hours (_clique_hours_verdict), as it was before this field."""
    response = _solve(_week(derived=False))

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "DEMAND_CLIQUE_HOURS_SHORT"


def test_a_derived_key_pair_with_sva7_puts_the_svenska_back_out_of_reach() -> None:
    """Non-vacuity of the pair the gateway never sends: paired with SvA7, the
    derived key keeps SvA off the svenska again, and the day does not hold."""
    response = _solve(_week(conflicts=[*PAIRS, [WITHOUT_SVA, SVA7]]))

    assert response.status == "INFEASIBLE"


# ---------------------------------------------------------------------------
# 2. Locked lessons block in the pupil space.
# ---------------------------------------------------------------------------


def _locked(requirement_group: str, start: str, end: str, **values: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": requirement_group,
        "dayOfWeek": 1, "startTime": start, "endTime": end,
    }
    row.update(values)
    return row


def test_a_locked_svenska_sat_by_the_derived_key_lets_sva_be_placed_at_its_time() -> None:
    """Two hours: the locked svenska at 08:00 and 7A's one matte, which must take 09:00.
    SvA may not sit beside the matte, so it fits only at 08:00 beside the
    locked svenska — which a lock of all of 7A would keep it out of."""
    lock = _locked(CLASS_7A, "08:00:00", "09:00:00", pupilGroupIds=[WITHOUT_SVA])
    payload = _week(svenska=0, matte=1, sva=1, fixedLessons=[lock])
    response = _solve(payload, **TWO_HOURS)

    assert response.status in _SOLVED
    assert _spans(response.lessons, MATTE) == [(540, 600)]
    assert _spans(response.lessons, SVA) == [(480, 540)]

    plain = {**payload, "fixedLessons": [{k: v for k, v in lock.items() if k != "pupilGroupIds"}]}
    assert _solve(plain, **TWO_HOURS).status == "INFEASIBLE"


def test_a_locked_sva_lets_7as_svenska_be_placed_beside_it() -> None:
    """The mirror, read from the generated side: SvA locked at 08:00 keeps 7A's
    matte out (the pair (7A, SvA7)) but not the svenska, whose pupils are the
    derived key's. Two hours, so the matte takes 09:00 and the svenska fits only
    at 08:00 beside the lock — keyed by its class the lock would close it."""
    lock = _locked(SVA7, "08:00:00", "09:00:00")
    payload = _week(svenska=1, matte=1, sva=0, fixedLessons=[lock])
    response = _solve(payload, **TWO_HOURS)

    assert response.status in _SOLVED
    assert _spans(response.lessons, MATTE) == [(540, 600)]
    assert _spans(response.lessons, SVENSKA) == [(480, 540)]


def test_a_locked_svenska_leaves_its_hour_to_sva_in_the_gaps_count_too() -> None:
    """SvA7's two hours on a two-hour day with 7A's svenska locked at 08:00: SvA
    takes both hours, one of them beside the lock. The gaps verdict cuts a
    lesson's starts by the locks it shares pupils with (_lesson_kinds); read by
    the lock's class it would cut 08:00 from SvA and refuse a placed week."""
    lock = _locked(CLASS_7A, "08:00:00", "09:00:00", pupilGroupIds=[WITHOUT_SVA])
    payload = _week(svenska=0, matte=0, sva=2, fixedLessons=[lock])
    response = _solve(payload, **TWO_HOURS)

    assert response.status in _SOLVED
    assert _spans(response.lessons, SVA) == [(480, 540), (540, 600)]


def test_the_walk_to_a_lock_is_keyed_by_the_pupils_who_walk() -> None:
    """_fixed_relations names the family a lock's walk hangs on, and it must be one the
    week has (travel.families_of): the svenska beside a locked matte is the
    derived key's walk, and SvA beside a locked svenska is nobody's."""
    from app.solver.scheduler_solver import LessonInstance, _fixed_relations

    request = OptimizeScheduleRequest.model_validate(_week(svenska=1, matte=0, sva=1))
    svenska = next(r for r in request.requirements if r.id == UUID(SVENSKA))
    sva = next(r for r in request.requirements if r.id == UUID(SVA))
    conflicts_with: dict[UUID, set[UUID]] = {}
    for first, second in request.group_conflicts:
        conflicts_with.setdefault(first, set()).add(second)
        conflicts_with.setdefault(second, set()).add(first)
    matte = FixedLesson.model_validate(_locked(CLASS_7A, "08:00:00", "09:00:00"))
    locked_svenska = FixedLesson.model_validate(
        _locked(CLASS_7A, "08:00:00", "09:00:00", pupilGroupIds=[WITHOUT_SVA]),
    )

    assert _fixed_relations(LessonInstance(svenska, 0), matte, conflicts_with) == [
        ("PUPILS", (UUID(WITHOUT_SVA),)),
    ]
    assert _fixed_relations(LessonInstance(sva, 0), locked_svenska, conflicts_with) == []
    assert _fixed_relations(LessonInstance(sva, 0), matte, conflicts_with) == [
        ("PUPILS", (UUID(SVA7),)),
    ]


def test_a_locked_matte_still_keeps_sva_out() -> None:
    """A locked 7A matte at 08:00 holds SvA7's pupils too (the pair (7A, SvA7)): SvA
    goes to 09:00, beside 7A's svenska that the lock keeps out as well."""
    lock = _locked(CLASS_7A, "08:00:00", "09:00:00")
    payload = _week(svenska=1, matte=0, sva=1, fixedLessons=[lock])
    response = _solve(payload, **TWO_HOURS)

    assert response.status in _SOLVED
    assert _spans(response.lessons, SVA) == [(540, 600)]
    assert _spans(response.lessons, SVENSKA) == [(540, 600)]


# ---------------------------------------------------------------------------
# 3. A block of svenska and SvA.
# ---------------------------------------------------------------------------


def test_a_block_of_the_derived_svenska_and_sva_is_accepted_and_starts_together() -> None:
    """The members share no pupil once the svenska carries its derived key, so the
    block is no BLOCK_MEMBERS_SHARE_PUPILS and the two run at one hour."""
    block = str(uuid4())
    payload = _week(svenska=2, matte=1, sva=2)
    for requirement in payload["requirements"]:  # type: ignore[union-attr]
        if requirement["id"] in (SVENSKA, SVA):
            requirement["blockId"] = block
    response = _solve(payload)

    assert response.status in _SOLVED
    assert _spans(response.lessons, SVENSKA) == _spans(response.lessons, SVA)
    assert not _overlap(_spans(response.lessons, SVA), _spans(response.lessons, MATTE))
    assert _validate(payload, response.lessons) == []

    for requirement in payload["requirements"]:  # type: ignore[union-attr]
        requirement.pop("pupilGroupId", None)
    payload["groupConflicts"] = TODAY
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(_settings())._validate_request(OptimizeScheduleRequest.model_validate(payload))
    assert refused.value.code == "BLOCK_MEMBERS_SHARE_PUPILS"


# ---------------------------------------------------------------------------
# 4. The class's rules still read the class.
# ---------------------------------------------------------------------------


def test_the_daily_maximum_still_counts_the_svenska_as_7as() -> None:
    """One day, a maximum of three a day, and 7A's two of svenska and two of matte:
    four lessons of 7A's whoever sits the svenska, so the week is refused, and
    the refusal names 7A — never the derived key nobody can look up. Read in
    the pupil space the svenska would be the derived key's two and 7A's two,
    and the maximum would have let both through."""
    rules = {"maxLessonsPerDayPerGroup": 3}
    assert _model_status(_week(svenska=2, matte=2, sva=0, rules=rules)) == "INFEASIBLE"
    response = _solve(_week(svenska=2, matte=2, sva=0, rules=rules))

    assert response.status == "INFEASIBLE"
    codes = {detail.code for detail in response.conflicts.conflicts}  # type: ignore[union-attr]
    assert "GROUP_DAILY_MAXIMUM_CANNOT_BE_KEPT" in codes
    assert UUID(CLASS_7A) in _named(response)
    assert UUID(WITHOUT_SVA) not in _named(response)

    response = _solve(_week(svenska=2, matte=2, sva=0, rules={"maxLessonsPerDayPerGroup": 4}))
    assert response.status in _SOLVED


def test_a_reservation_on_7a_still_keeps_the_svenska_out() -> None:
    """A one-hour day 7A is reserved away from: its svenska has nowhere to go,
    whoever sits it. Read in the pupil space the reservation would reach
    nothing the derived key holds, and the svenska would be placed in it."""
    reserved = {
        "id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": CLASS_7A,
        "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00", "kind": "UNAVAILABLE",
    }
    payload = _week(svenska=1, matte=0, sva=0, constraints=[reserved])
    response = _solve(payload, SCHEDULE_DAY_END_MINUTES=600)

    assert response.status in _SOLVED
    assert _spans(response.lessons, SVENSKA) == [(540, 600)]

    assert _refused(payload, SCHEDULE_DAY_END_MINUTES=540)


#: A lunch of an hour anywhere in a three-hour day's first two and a half.
LUNCH = {"lunchStartTime": "08:00:00", "lunchEndTime": "10:30:00", "lunchMinutes": 60}


def test_7as_lunch_still_avoids_its_svenska() -> None:
    """Three hours, 7A's two of svenska and one of matte, and an hour's lunch: four
    hours of 7A's, refused. The meal is 7A's and the svenska is filed under 7A;
    read in the pupil space the derived key eats nothing, the meal could sit
    on the svenska, and the day would be placed."""
    payload = _week(svenska=2, matte=1, sva=0, rules=LUNCH)

    assert _solve(payload, SCHEDULE_DAY_END_MINUTES=660).status == "INFEASIBLE"
    # The model's own lunch, not only the verdict that counts it first.
    assert _model_status(payload, SCHEDULE_DAY_END_MINUTES=660) == "INFEASIBLE"


def test_7as_lunch_still_avoids_sva7s_lessons() -> None:
    """Three hours, 7A's two of matte, SvA7's one of SvA beside neither, and 7A's
    hour of lunch: SvA7's pupils eat with 7A, so the meal keeps off the SvA as
    well, and four hours do not fit three."""
    payload = _week(svenska=0, matte=2, sva=1, rules=LUNCH)

    assert _solve(payload, SCHEDULE_DAY_END_MINUTES=660).status == "INFEASIBLE"
    assert _model_status(payload, SCHEDULE_DAY_END_MINUTES=660) == "INFEASIBLE"


def test_with_room_for_it_7as_lunch_clears_the_svenska_and_the_sva() -> None:
    """Four hours: the same week placed, and the meal on none of 7A's lessons or SvA7's."""
    payload = _week(svenska=2, matte=1, sva=2, rules=LUNCH)
    response = _solve(payload, SCHEDULE_DAY_END_MINUTES=720)

    assert response.status in _SOLVED
    (lunch,) = [meal for meal in response.lunches if meal.student_group_id == UUID(CLASS_7A)]
    meal = [(_minutes(lunch.start_time), _minutes(lunch.end_time))]
    for requirement_id in (SVENSKA, MATTE, SVA):
        assert not _overlap(meal, _spans(response.lessons, requirement_id))
    assert _validate(payload, response.lessons, SCHEDULE_DAY_END_MINUTES=720) == []


# ---------------------------------------------------------------------------
# 5. The walk between sites is the pupils' walk.
# ---------------------------------------------------------------------------

#: Ten minutes between Norra and Södra, held as a whole step on these days.
WALK = [{"siteAId": NORRA, "siteBId": SODRA, "minutes": 10}]


def _sited(
    *, first: tuple[str, str, int, str | None], second: tuple[str, str, int, str | None],
    derived: bool = True,
) -> dict[str, object]:
    """Two lessons, each on its own site, the first forced to 08:00 and the second to 09:00.

    Each is (requirement id, group, room type, pupils): the first's teacher is
    away 09:00-10:00 and the second's away 08:00-09:00 — the teachers, so no
    rule of the class's moves either — and on a two-hour day they run back
    to back. Two teachers: only the pupils can make that a walk.
    """
    first_teacher, second_teacher = str(uuid4()), str(uuid4())
    requirements = [
        _requirement(first[0], first[1], 1, teacher=first_teacher,
                     requiredRoomType=first[2], pupils=first[3] if derived else None),
        _requirement(second[0], second[1], 1, teacher=second_teacher,
                     requiredRoomType=second[2], pupils=second[3] if derived else None),
    ]
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [
            {"id": str(uuid4()), "capacity": 30, "type": "LAB", "siteId": NORRA},
            {"id": str(uuid4()), "capacity": 30, "type": "GYM", "siteId": SODRA},
        ],
        "constraints": [
            {"id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": first_teacher,
             "dayOfWeek": 1, "startTime": "09:00:00", "endTime": "10:00:00", "kind": "UNAVAILABLE"},
            {"id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": second_teacher,
             "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00", "kind": "UNAVAILABLE"},
        ],
        "groupConflicts": PAIRS if derived else TODAY,
        "siteTravelTimes": WALK,
    }


def test_sva_on_the_other_site_right_after_the_svenska_needs_no_walk() -> None:
    """The svenska at Norra 08:00, SvA at Södra 09:00: no pupil sits both, so no walk.
    Without the derived key the svenska is 7A's, SvA7's pupils walk from it,
    and the same two lessons are refused."""
    payload = _sited(
        first=(SVENSKA, CLASS_7A, "LAB", WITHOUT_SVA), second=(SVA, SVA7, "GYM", None),
    )
    response = _solve(payload, **TWO_HOURS)

    assert response.status in _SOLVED
    request = OptimizeScheduleRequest.model_validate(payload)
    assert _travel_problems(request, response.lessons) == []

    today = _sited(
        first=(SVENSKA, CLASS_7A, "LAB", WITHOUT_SVA), second=(SVA, SVA7, "GYM", None),
        derived=False,
    )
    assert _solve(today, **TWO_HOURS).status == "INFEASIBLE"


def test_sva_right_after_7as_matte_on_the_other_site_keeps_the_walk() -> None:
    """The matte at Norra 08:00, SvA at Södra 09:00: SvA7's pupils sit the matte and
    walk, and back to back is no walk at all. Refused, and named by the classes."""
    payload = _sited(first=(MATTE, CLASS_7A, "LAB", None), second=(SVA, SVA7, "GYM", None))
    # The derived key in the payload, on a svenska that fits anywhere.
    payload["requirements"].append(  # type: ignore[union-attr]
        _requirement(SVENSKA, CLASS_7A, 1, pupils=WITHOUT_SVA, requiredRoomType="LAB"),
    )
    response = _solve(payload, **TWO_HOURS)

    assert response.status == "INFEASIBLE"
    assert UUID(WITHOUT_SVA) not in _named(response)
    (walk,) = [
        detail for detail in response.conflicts.conflicts  # type: ignore[union-attr]
        if detail.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT"
    ]
    assert set(walk.resource_ids) == {UUID(CLASS_7A), UUID(SVA7)}


def test_a_refusal_of_the_derived_keys_walk_names_the_class() -> None:
    """The svenska at Norra 08:00 and 7A's matte at Södra 09:00: the svenska's pupils
    walk to the matte and cannot. The walk's families are keyed by the pupils,
    so the core's line is the derived key's — and it leaves named 7A, the one
    group of the two a school has a name for."""
    payload = _sited(
        first=(SVENSKA, CLASS_7A, "LAB", WITHOUT_SVA), second=(MATTE, CLASS_7A, "GYM", None),
    )
    response = _solve(payload, **TWO_HOURS)

    assert response.status == "INFEASIBLE"
    assert UUID(WITHOUT_SVA) not in _named(response)
    (walk,) = [
        detail for detail in response.conflicts.conflicts  # type: ignore[union-attr]
        if detail.code == "PUPILS_TRAVEL_CANNOT_BE_KEPT"
    ]
    assert walk.resource_ids == [UUID(CLASS_7A)]


# ---------------------------------------------------------------------------
# 6. The verdicts count cliques of the pupils.
# ---------------------------------------------------------------------------


def test_no_pre_flight_verdict_refuses_the_week_that_needs_the_overlap() -> None:
    """7A's six hours and SvA7's three exceed 7A's six free ones only if they may not
    overlap. Every arithmetic verdict that runs before a model leaves the week
    to the model, the lunch stage included, and the model places it."""
    payload = _week(rules={"lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00",
                           "lunchMinutes": 60})
    settings = {"SCHEDULE_DAY_END_MINUTES": 900}
    solver = SchedulerSolver(_settings(**settings))
    request = OptimizeScheduleRequest.model_validate(payload)

    assert solver._clique_hours_verdict(request) is None
    assert solver._teacher_hours_verdict(request) is None
    assert solver._lesson_gaps_verdict(request) is None
    assert solver._lunch_stage_one(request)[0] is None
    solver._validate_request(request)
    response = _solve(payload, **settings)
    assert response.status in _SOLVED
    assert _spans(response.lessons, SVA) == _spans(response.lessons, SVENSKA)


def test_a_gaps_refusal_of_the_derived_keys_lessons_names_the_class() -> None:
    """Three hours of svenska, each its own teacher's, on a two-hour day: the derived
    key's lessons do not fit its gaps (_lesson_gaps_verdict, keyed by the
    pupils), and the line names 7A, whose svenska it is."""
    teachers = [str(uuid4()) for _ in range(3)]
    svenska = _requirement(SVENSKA, CLASS_7A, 3, pupils=WITHOUT_SVA, teacher=teachers[0],
                           lessonTeacherIds=teachers)
    payload = {**_week(svenska=0, matte=0, sva=1), "groups": []}
    payload["requirements"] = [svenska, *payload["requirements"]]  # type: ignore[misc]
    response = _solve(payload, **TWO_HOURS)

    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "DEMAND_LESSONS_EXCEED_GAPS"
    (line,) = [d for d in response.conflicts.conflicts if d.code == "DEMAND_GROUP_LESSONS_EXCEED_GAPS"]
    assert line.resource_ids == [UUID(CLASS_7A)]
    assert line.params["group"] == CLASS_7A


# ---------------------------------------------------------------------------
# 7. Edges.
# ---------------------------------------------------------------------------


def test_two_derived_keys_of_one_class_that_share_no_pupil_may_run_at_once() -> None:
    """Every pupil of 7A in SvA7 or in another replacing group: 7A's svenska and its
    engelska are sat by two derived keys that share nobody, and the gateway
    pairs each with 7A and not with each other. Three hours, two of each and
    7A's hour of lunch: the week holds only with the two side by side.

    Class rules may not put back what the pupils' relation leaves out: 7A's
    meal still keeps off both (it is 7A's), but one no-overlap over all of
    7A's lessons beside it would hold them apart from each other as well
    (_by_pupils), and the gaps verdict would count them end to end (it keys
    its groups by the pupils)."""
    engelska, without_e7 = str(uuid4()), str(uuid4())
    payload = _week(svenska=2, matte=0, sva=0, rules=LUNCH)
    payload["requirements"].append(  # type: ignore[union-attr]
        _requirement(engelska, CLASS_7A, 2, pupils=without_e7),
    )
    payload["groupConflicts"] = [[CLASS_7A, WITHOUT_SVA], [CLASS_7A, without_e7]]
    response = _solve(payload, SCHEDULE_DAY_END_MINUTES=660)

    assert response.status in _SOLVED
    assert _spans(response.lessons, SVENSKA) == _spans(response.lessons, engelska)
    (lunch,) = response.lunches
    meal = [(_minutes(lunch.start_time), _minutes(lunch.end_time))]
    assert not _overlap(meal, _spans(response.lessons, SVENSKA))
    assert _model_status(payload, SCHEDULE_DAY_END_MINUTES=660) in _SOLVED


def test_a_pupil_key_equal_to_the_group_is_the_requirement_without_one() -> None:
    """pupilGroupId = studentGroupId names the same pupils, so it builds the same model."""
    today = _week(derived=False, rules=LUNCH)
    same = copy.deepcopy(today)
    for requirement in same["requirements"]:  # type: ignore[union-attr]
        requirement["pupilGroupId"] = requirement["studentGroupId"]
    for objective in (True, False):
        assert _proto(same, objective=objective) == _proto(today, objective=objective)

    lock = _locked(CLASS_7A, "08:00:00", "09:00:00", extraGroupIds=[SVA7])
    named = {**today, "fixedLessons": [lock]}
    spelled = {**today, "fixedLessons": [{**lock, "pupilGroupIds": [CLASS_7A, SVA7]}]}
    for objective in (True, False):
        assert _proto(spelled, objective=objective) == _proto(named, objective=objective)


def test_a_derived_key_no_lesson_carries_is_a_group_without_lessons() -> None:
    """A derived key in groupConflicts that no requirement or lock carries is read as
    any group without lessons is — byte for byte the model of the same pairs
    naming some other lessonless group — and the week is placed as before.
    (A pair of which one side has no lessons posts the other side's own
    no-overlap once more, on main as here: redundant, never a new row.)"""
    today = _week(svenska=2, matte=2, sva=1, derived=False, rules=LUNCH, siteTravelTimes=WALK)
    for room, site in zip(today["rooms"], (NORRA, SODRA, NORRA, SODRA)):  # type: ignore[arg-type]
        room["siteId"] = site
    stray = {**today, "groupConflicts": [*TODAY, [CLASS_7A, WITHOUT_SVA], [WITHOUT_SVA, SVA7]]}
    nobody = str(uuid4())
    lessonless = {**today, "groupConflicts": [*TODAY, [CLASS_7A, nobody], [nobody, SVA7]]}
    for objective in (True, False):
        assert _proto(stray, objective=objective) == _proto(lessonless, objective=objective)
    assert _solve(stray).status in _SOLVED


def test_the_clique_hours_refusal_counts_a_derived_key_as_its_class() -> None:
    """The independent review's reproduction (cliquecount): the same day,
    refused by the clique's hours with the field and without it. The refusal
    names how many groups share the class's pupils; "7A without SvA7" is 7A's
    own pupils, not a group of its own, so the count is the one the school
    knows — the same with the field as without it."""
    data = json.loads((Path(__file__).parent / "data" / "replacing_groups_cliquecount.json").read_text())
    on = _solve(data["on"], **data["settings"])
    off = _solve(data["off"], **data["settings"])

    for response in (on, off):
        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert response.conflicts.summary_code == "DEMAND_CLIQUE_HOURS_SHORT"
    assert on.conflicts.summary_params["sharingGroups"] == off.conflicts.summary_params["sharingGroups"] == 1
