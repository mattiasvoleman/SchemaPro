"""Ett schema som start (M8 PR 4, M9's engine half): a week laid by holding a schedule that exists and letting go of what clashes.

What is held, in the order the solve uses it:

  * `held_places` reads `startLessons` as the places of the requirements' lessons, by LENGTH, and says what it left out;
  * `clashes` names the held requirements that sit on something they may not in THIS week (a teacher in two places, two
    groups that share a pupil, a reservation), counting periods and parity;
  * `attempt` makes the request one attempt lays, and `_solve_from_start` loops: an INFEASIBLE that names held lessons lets
    them go, one that names none widens to their neighbours, a pin the frame cannot hold is let go by name, and after
    MAX_ROUNDS (or with nothing held) the schedule is only a hint;
  * a week from a schedule that resembles it is laid, with the pairs, the teachers and the rooms holding when read from the
    ANSWER (not on the engine's word: the review of #437, L-4), and with most of the schedule where it was;
  * the report of a solve that was asked again says each step once, and the step `START` exists.
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import replace
from pathlib import Path
from typing import get_args

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import (  # noqa: E402
    AnonymousRequirement,
    ConflictAnalysis,
    ConflictDetail,
    OptimizeScheduleRequest,
    OptimizeScheduleResponse,
    PinnedLesson,
    StartedLesson,
    TimeoutStageName,
)
from app.solver import staged  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from app.solver.stage_clock import StageClock  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

#: Two weeks of one school: the same posts, teachers and groups, the pupils in other groups (so other pairs).
SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
OTHER = replace(SHAPE, seed=2)


def _settings(seconds: float = 30.0) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=seconds, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


def _entry(requirement_id, day: int, start: str, end: str) -> StartedLesson:  # noqa: ANN001
    return StartedLesson(requirementId=requirement_id, dayOfWeek=day, startTime=start, endTime=end)


def _started_from(lessons) -> list[StartedLesson]:  # noqa: ANN001
    return [_entry(l.requirement_id, l.day_of_week, l.start_time, l.end_time) for l in lessons]


def _minutes(clock: str) -> int:
    hours, minutes, _ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def _overlap(a, b) -> bool:  # noqa: ANN001
    return a.day_of_week == b.day_of_week and _minutes(a.start_time) < _minutes(b.end_time) and _minutes(b.start_time) < _minutes(a.end_time)


def _faults(request: OptimizeScheduleRequest, lessons) -> list[str]:  # noqa: ANN001
    """What is wrong with an answer, found from the answer: a group or two groups sharing a pupil on top of each other, a
    teacher in two places, a room twice at once, a room of the wrong type or too small."""
    requirement = {r.id: r for r in request.requirements}
    rooms = {room.id: room for room in request.rooms}
    pairs = {frozenset(pair) for pair in request.group_conflicts}
    faults: list[str] = []
    for index, a in enumerate(lessons):
        ra = requirement[a.requirement_id]
        room = rooms[a.room_id]
        if ra.required_room_type is not None and str(room.type) != str(ra.required_room_type):
            faults.append("a room of the wrong type")
        if room.capacity < ra.student_group_size:
            faults.append("a room too small")
        for b in lessons[index + 1:]:
            if not _overlap(a, b):
                continue
            rb = requirement[b.requirement_id]
            if a.room_id == b.room_id:
                faults.append("a room twice at once")
            if ra.teacher_id is not None and ra.teacher_id == rb.teacher_id:
                faults.append("a teacher in two places")
            if ra.student_group_id == rb.student_group_id or frozenset((ra.student_group_id, rb.student_group_id)) in pairs:
                faults.append("pupils in two places")
    return faults


def _ids(prefix: int) -> uuid.UUID:
    return uuid.UUID(int=prefix, version=4)


# ---- what is held ---------------------------------------------------------------------------------------------


def test_the_lessons_of_a_requirement_with_two_lengths_go_to_the_places_of_their_own_length() -> None:
    request = build_week(SHAPE).request
    base = request.requirements[0]
    mixed = AnonymousRequirement.model_validate({
        **base.model_dump(by_alias=True, exclude_none=True),
        "lessonsPerWeek": 2, "minutesPerLesson": 90, "lessonLengths": [60, 90],
    })
    request = request.model_copy(update={"requirements": [mixed, *request.requirements[1:]]})
    # Given in clock order (Tuesday's 60 first, Monday's 90 second): the places are longest first.
    request = request.model_copy(update={"start_lessons": [
        _entry(mixed.id, 1, "09:00:00", "10:00:00"), _entry(mixed.id, 2, "08:00:00", "09:30:00"),
    ]})

    held = staged.held_places(request)

    row = held.places[mixed.id]
    assert [(p.day_of_week, p.start_time, p.end_time) for p in row] == [
        (2, "08:00:00", "09:30:00"), (1, "09:00:00", "10:00:00"),
    ], "the 90 minutes is place 0 and the 60 place 1, whatever order the entries came in"


def test_what_cannot_be_held_is_left_out_and_counted() -> None:
    request = build_week(SHAPE).request
    plain, pinned, split = request.requirements[0], request.requirements[1], request.requirements[2]
    pins = [PinnedLesson(dayOfWeek=1, startTime="08:00:00", endTime=_end(pinned, "08:00:00"))] + [None] * (pinned.lessons_per_week - 1)
    teachers = [plain.teacher_id] * split.lessons_per_week
    request = request.model_copy(update={"requirements": [
        plain, pinned.model_copy(update={"pinned_lessons": pins}), split.model_copy(update={"lesson_teacher_ids": teachers}),
        *request.requirements[3:],
    ]})
    length = plain.minutes_per_lesson
    request = request.model_copy(update={"start_lessons": [
        _entry(plain.id, 1, "08:00:00", _end(plain, "08:00:00")),
        _entry(plain.id, 2, "08:00:00", _end(plain, "08:00:00")),
        *([_entry(plain.id, 3, "08:00:00", _end(plain, "08:00:00"))] * plain.lessons_per_week),  # more than places
        _entry(pinned.id, 2, "08:00:00", _end(pinned, "08:00:00")),
        _entry(split.id, 2, "08:00:00", _end(split, "08:00:00")),
        _entry(_ids(99), 2, "08:00:00", "09:00:00"),  # a requirement the week no longer has
        _entry(request.requirements[3].id, 2, "08:00:00", f"{8 + (length + 30) // 60:02d}:{(length + 30) % 60:02d}:00"),  # no place of that length
    ]})

    held = staged.held_places(request)

    assert set(held.places) == {plain.id}
    assert len([p for p in held.places[plain.id] if p is not None]) == plain.lessons_per_week
    # the plain requirement has three places and five entries, the last three of them the same lesson (the same
    # day and time, the entry the test repeats): two of those are the lesson twice, and the fourth requirement's
    # one entry has no place of its length, the one entry that no place takes
    assert held.dropped == {
        "the week has no such requirement": 1,
        "the school pinned this requirement": 1,
        "a split lesson": 1,
        "the same lesson twice": 2,
        "more entries than places of that length": 1,
    }


def _end(requirement, start: str) -> str:  # noqa: ANN001
    total = _minutes(start) + requirement.minutes_per_lesson
    return f"{total // 60:02d}:{total % 60:02d}:00"


def test_a_block_the_schedule_does_not_hold_together_is_not_held_at_all() -> None:
    request = build_week(replace(SHAPE, language_block=True)).request
    block = next(r.block_id for r in request.requirements if r.block_id is not None)
    members = [r for r in request.requirements if r.block_id == block]
    assert len(members) >= 2

    def given(*, apart: bool) -> OptimizeScheduleRequest:
        entries = []
        for member in members:
            for place in range(member.lessons_per_week):
                day, start = (1 + place, "08:00:00")
                if apart and member is members[1] and place == 0:
                    start = "09:00:00"
                entries.append(_entry(member.id, day, start, _end(member, start)))
        return request.model_copy(update={"start_lessons": entries})

    assert set(staged.held_places(given(apart=False)).places) == {m.id for m in members}
    refused = staged.held_places(given(apart=True))
    assert not ({m.id for m in members} & set(refused.places))
    assert refused.dropped["a block the schedule does not hold together"] == len(members)


# ---- what clashes -----------------------------------------------------------------------------------------------


def _held_two(request: OptimizeScheduleRequest, first, second, *, same_time: bool = True):  # noqa: ANN001
    entries = [
        _entry(first.id, 1, "08:00:00", _end(first, "08:00:00")),
        _entry(second.id, 1 if same_time else 3, "08:00:00", _end(second, "08:00:00")),
    ]
    only = request.model_copy(update={"requirements": [first, second], "start_lessons": entries})
    return only, staged.held_places(only)


def test_two_lessons_of_one_teacher_at_one_time_clash_and_at_two_times_do_not() -> None:
    request = build_week(SHAPE).request
    teacher = request.requirements[0].teacher_id
    first = request.requirements[0]
    second = request.requirements[5].model_copy(update={"teacher_id": teacher, "lessons_per_week": 1})
    second = second.model_copy(update={"minutes_per_lesson": first.minutes_per_lesson})
    together, held = _held_two(request, first.model_copy(update={"lessons_per_week": 1}), second)
    assert staged.clashes(together, held) == {first.id, second.id}
    apart, held = _held_two(request, first.model_copy(update={"lessons_per_week": 1}), second, same_time=False)
    assert staged.clashes(apart, held) == set()


def test_two_groups_that_share_a_pupil_clash_and_two_that_do_not_do_not() -> None:
    request = build_week(SHAPE).request
    a = request.requirements[0].model_copy(update={"lessons_per_week": 1})
    b = next(r for r in request.requirements if r.student_group_id != a.student_group_id and r.teacher_id != a.teacher_id)
    b = b.model_copy(update={"lessons_per_week": 1, "minutes_per_lesson": a.minutes_per_lesson})
    one = request.model_copy(update={"group_conflicts": [(a.student_group_id, b.student_group_id)]})
    sharing, held = _held_two(one, a, b)
    assert staged.clashes(sharing, held) == {a.id, b.id}
    none = request.model_copy(update={"group_conflicts": []})
    strangers, held = _held_two(none, a, b)
    assert staged.clashes(strangers, held) == set()


def test_a_teachers_reservation_clashes_with_the_lesson_it_covers() -> None:
    request = build_week(SHAPE).request
    lesson = request.requirements[0].model_copy(update={"lessons_per_week": 1})
    reservation = next(c for c in request.constraints if str(c.kind) == "UNAVAILABLE" and c.resource_id == lesson.teacher_id)
    moved = reservation.model_copy(update={"day_of_week": 1, "start_time": "08:00:00", "end_time": "09:00:00"})
    held_request = request.model_copy(update={
        "requirements": [lesson], "constraints": [moved], "group_conflicts": [],
        "start_lessons": [_entry(lesson.id, 1, "08:30:00", _end(lesson, "08:30:00"))],
    })
    assert staged.clashes(held_request, staged.held_places(held_request)) == {lesson.id}
    elsewhere = held_request.model_copy(update={"constraints": [moved.model_copy(update={"day_of_week": 2})]})
    assert staged.clashes(elsewhere, staged.held_places(elsewhere)) == set()


def test_lessons_that_never_run_in_the_same_week_do_not_clash() -> None:
    request = build_week(SHAPE).request
    teacher = request.requirements[0].teacher_id
    first = request.requirements[0].model_copy(update={"lessons_per_week": 1, "recurrence": "ODD_WEEKS"})
    second = request.requirements[5].model_copy(update={
        "teacher_id": teacher, "lessons_per_week": 1, "recurrence": "EVEN_WEEKS", "minutes_per_lesson": first.minutes_per_lesson,
    })
    odd_even, held = _held_two(request, first, second)
    assert staged.clashes(odd_even, held) == set()
    both_odd, held = _held_two(request, first, second.model_copy(update={"recurrence": "ODD_WEEKS"}))
    assert staged.clashes(both_odd, held) == {first.id, second.id}


# ---- the attempt, and what a refusal names ----------------------------------------------------------------------


def test_an_attempt_pins_what_is_held_clears_startlessons_and_gives_the_schedule_as_the_hint() -> None:
    request = build_week(SHAPE).request
    first, second = request.requirements[0], request.requirements[1]
    request = request.model_copy(update={"start_lessons": [
        _entry(first.id, 1, "08:00:00", _end(first, "08:00:00")), _entry(second.id, 2, "08:00:00", _end(second, "08:00:00")),
    ]})
    held = staged.held_places(request)

    attempt = staged.attempt(request, held, {second.id})

    by_id = {r.id: r for r in attempt.requirements}
    assert by_id[first.id].pinned_lessons is not None and by_id[second.id].pinned_lessons is None
    assert attempt.start_lessons is None
    assert {p.requirement_id for p in attempt.previous_lessons} == {first.id, second.id}, "the whole schedule is the hint"
    mine = request.model_copy(update={"previous_lessons": attempt.previous_lessons[:1]})
    assert staged.attempt(mine, held, set()).previous_lessons == attempt.previous_lessons[:1], "a caller's own hint is kept"


def test_a_refusal_names_the_pins_of_its_core_first_and_the_widening_goes_one_step() -> None:
    request = build_week(SHAPE).request
    ids = [r.id for r in request.requirements[:4]]
    candidates = set(ids)
    analysis = ConflictAnalysis(conflicts=[
        _detail("PLACED_LESSON_IN_THE_WAY_ANY_ROOM", ids[0]),
        _detail("ROOM_NO_ROOM_FOR_REQUIREMENT", ids[1]),
    ])
    assert staged.in_the_way(analysis, candidates) == {ids[0]}, "the pin of the core, not every row"
    only_rows = ConflictAnalysis(conflicts=[analysis.conflicts[1]])
    assert staged.in_the_way(only_rows, candidates) == {ids[1]}
    assert staged.in_the_way(None, candidates) == set()
    # Nothing named: the held requirements that share a teacher with what is free.
    teacher = request.requirements[0].teacher_id
    shares = [r for r in request.requirements[1:] if r.teacher_id == teacher]
    if shares:
        assert shares[0].id in staged.neighbours(request, {request.requirements[0].id}, {shares[0].id})
    assert staged.neighbours(request, set(), candidates) == set()
    assert staged.named_by_refusal({"requirement": str(ids[2]), "day": 1}, candidates) == {ids[2]}
    assert staged.named_by_refusal({"requirement": str(_ids(7))}, candidates) == set()


# ---- the loop ----------------------------------------------------------------------------------------------------


def _drive(monkeypatch: pytest.MonkeyPatch, responses: list) -> tuple[list[set[uuid.UUID]], OptimizeScheduleResponse]:  # noqa: ANN001
    """Run _solve_from_start with `_solve_strict` replaced by canned answers; return what each attempt held."""
    request = build_week(SHAPE).request
    given = request.requirements[:6]
    request = request.model_copy(update={
        "start_lessons": [_entry(r.id, 1 + index % 5, "08:00:00", _end(r, "08:00:00")) for index, r in enumerate(given)],
        "group_conflicts": [], "constraints": [],
    })
    held_per_call: list[set[uuid.UUID]] = []
    answers = iter(responses)

    def fake(self, attempt, entered):  # noqa: ANN001, ANN202
        held_per_call.append({r.id for r in attempt.requirements if r.pinned_lessons is not None})
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer(attempt) if callable(answer) else answer

    monkeypatch.setattr(SchedulerSolver, "_solve_strict", fake)
    solver = SchedulerSolver(_settings())
    return held_per_call, solver._solve_from_start(request, 0.0), given  # type: ignore[return-value]


def _detail(code: str, *named: uuid.UUID) -> ConflictDetail:
    """A row of a refusal: the code, the params its sentence needs, and the requirements it names."""
    params: dict[str, str | int] = {"requirement": str(named[0]), "day": 1, "start": "08:00", "end": "09:00", "groupSize": 20}
    return ConflictDetail(category="PLACEMENT", code=code, params=params, requirement_ids=list(named))


def _answer(status: str, *named: uuid.UUID, code: str = "PLACED_LESSON_IN_THE_WAY_ANY_ROOM") -> OptimizeScheduleResponse:
    conflicts = ConflictAnalysis(conflicts=[_detail(code, *named)]) if named else None
    return OptimizeScheduleResponse(request_id=_ids(1), status=status, lessons=[], conflicts=conflicts)  # type: ignore[arg-type]


def test_a_refusal_that_names_held_lessons_lets_them_go_and_the_week_is_asked_again(monkeypatch: pytest.MonkeyPatch) -> None:
    request = build_week(SHAPE).request
    given = request.requirements[:6]
    first, second = given[0].id, given[1].id
    held_per_call, response, _given = _drive(monkeypatch, [_answer("INFEASIBLE", first, second), _answer("FEASIBLE")])
    assert response.status == "FEASIBLE"
    assert len(held_per_call) == 2
    assert {r.id for r in given} - {first, second} == held_per_call[1] and {first, second} <= held_per_call[0]


def test_a_refusal_that_names_nothing_held_and_has_nothing_free_is_the_weeks_own(monkeypatch: pytest.MonkeyPatch) -> None:
    # explained, and every cause it names is something that is not held
    held_per_call, response, _ = _drive(monkeypatch, [_answer("INFEASIBLE", _ids(77), code="ROOM_NO_ROOM_FOR_REQUIREMENT")])
    assert response.status == "INFEASIBLE" and len(held_per_call) == 1


def test_a_refusal_that_says_nothing_is_not_taken_for_the_weeks_own(monkeypatch: pytest.MonkeyPatch) -> None:
    """No explanation (probes off, no room on the clock, no core): the held lessons may be all of it, so the week is asked
    once more with nothing held, as a week that has a timetable is never refused for what the schedule held."""
    held_per_call, response, _ = _drive(monkeypatch, [_answer("INFEASIBLE"), _answer("FEASIBLE")])
    assert response.status == "FEASIBLE" and len(held_per_call) == 2 and held_per_call[1] == set()

    no_core = OptimizeScheduleResponse(
        request_id=_ids(1), status="INFEASIBLE", lessons=[],  # type: ignore[arg-type]
        conflicts=ConflictAnalysis(summaryCode="CONFLICT_NO_CORE", conflicts=[ConflictDetail(category="INSUFFICIENT_RESOURCES", code="CONFLICT_NO_CORE_GUESS")]),
    )
    held_per_call, response, _ = _drive(monkeypatch, [no_core, _answer("INFEASIBLE")])
    assert response.status == "INFEASIBLE" and len(held_per_call) == 2 and held_per_call[1] == set(), "and the plain solve's refusal is the answer"


def test_a_timeout_is_final(monkeypatch: pytest.MonkeyPatch) -> None:
    held_per_call, response, _ = _drive(monkeypatch, [_answer("TIMEOUT")])
    assert response.status == "TIMEOUT" and len(held_per_call) == 1


def test_a_pin_the_frame_cannot_hold_is_let_go_by_name_and_the_week_asked_again(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.exceptions import InvalidScheduleInputError

    request = build_week(SHAPE).request
    outside = request.requirements[2].id
    refused = InvalidScheduleInputError.of("PLACED_LESSON_OUTSIDE_FRAME", {"requirement": str(outside), "day": 1, "start": "08:00", "end": "09:00"})
    held_per_call, response, given = _drive(monkeypatch, [refused, _answer("FEASIBLE")])
    assert response.status == "FEASIBLE" and outside in held_per_call[0] and outside not in held_per_call[1]


def test_a_refusal_before_the_model_that_names_nothing_held_is_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.exceptions import InvalidScheduleInputError

    with pytest.raises(InvalidScheduleInputError):
        _drive(monkeypatch, [InvalidScheduleInputError.of("PLACED_LESSON_OUTSIDE_FRAME", {"requirement": str(_ids(5)), "day": 1, "start": "08:00", "end": "09:00"})])


def test_after_the_last_round_the_schedule_is_only_a_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(staged, "MAX_ROUNDS", 2)
    request = build_week(SHAPE).request
    given = request.requirements[:6]
    # Each attempt names one more requirement; the third call has nothing held and is the hint's solve.
    held_per_call, response, _ = _drive(
        monkeypatch, [_answer("INFEASIBLE", given[0].id), _answer("INFEASIBLE", given[1].id), _answer("FEASIBLE")],
    )
    assert response.status == "FEASIBLE"
    assert len(held_per_call) == 3 and held_per_call[2] == set()


# ---- the solve, end to end ----------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def schedule_of_the_first_week() -> list:
    first = build_week(SHAPE).request
    answer = SchedulerSolver(_settings(20.0)).solve(first)
    assert answer.status in ("OPTIMAL", "FEASIBLE")
    return answer.lessons


def test_a_week_that_resembles_the_schedule_is_laid_with_most_of_it_where_it_was(schedule_of_the_first_week: list) -> None:
    request = build_week(OTHER).request.model_copy(update={"start_lessons": _started_from(schedule_of_the_first_week)})

    answer = SchedulerSolver(_settings(30.0)).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert len(answer.lessons) == sum(r.lessons_per_week for r in request.requirements)
    assert _faults(request, answer.lessons) == [], "pairs, teachers and rooms, read from the answer"
    before = {}
    for lesson in schedule_of_the_first_week:
        before.setdefault(lesson.requirement_id, []).append((lesson.day_of_week, lesson.start_time))
    after = {}
    for lesson in answer.lessons:
        after.setdefault(lesson.requirement_id, []).append((lesson.day_of_week, lesson.start_time))
    moved = sum(1 for rid in after if sorted(after[rid]) != sorted(before.get(rid, [])))
    assert moved < len(after) / 2, f"{moved} of {len(after)} requirements moved: most of the schedule should stay"


def test_the_same_week_from_its_own_schedule_keeps_every_lesson(schedule_of_the_first_week: list) -> None:
    request = build_week(SHAPE).request.model_copy(update={"start_lessons": _started_from(schedule_of_the_first_week)})

    answer = SchedulerSolver(_settings(30.0)).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert sorted((l.requirement_id, l.day_of_week, l.start_time) for l in answer.lessons) == sorted(
        (l.requirement_id, l.day_of_week, l.start_time) for l in schedule_of_the_first_week
    )
    assert _faults(request, answer.lessons) == []


def test_a_lesson_the_frame_cannot_hold_does_not_refuse_the_week(schedule_of_the_first_week: list) -> None:
    started = _started_from(schedule_of_the_first_week)
    started[0] = _entry(started[0].requirement_id, 1, "20:00:00", "21:00:00")  # past the day
    request = build_week(SHAPE).request.model_copy(update={"start_lessons": started})

    answer = SchedulerSolver(_settings(30.0)).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert _faults(request, answer.lessons) == []


def test_with_no_rounds_allowed_the_schedule_is_a_hint_and_the_week_is_still_laid(
    schedule_of_the_first_week: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(staged, "MAX_ROUNDS", 0)
    request = build_week(OTHER).request.model_copy(update={"start_lessons": _started_from(schedule_of_the_first_week)})

    answer = SchedulerSolver(_settings(30.0)).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert _faults(request, answer.lessons) == []


def test_a_best_effort_run_with_nothing_priced_starts_from_the_schedule(
    schedule_of_the_first_week: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Where nothing in the week is priced Bästa möjliga schema IS the strict solve, so the driver runs.

    (A week with something priced goes straight to the relaxed solve, which does not read the field:
    test_start_from_schedule_best_effort.py.)
    """
    calls: list[int] = []
    original = SchedulerSolver._solve_from_start

    def counted(self, request, entered):  # noqa: ANN001, ANN202
        calls.append(len(request.start_lessons or []))
        return original(self, request, entered)

    monkeypatch.setattr(SchedulerSolver, "_solve_from_start", counted)
    base = build_week(SHAPE).request.model_copy(update={"start_lessons": _started_from(schedule_of_the_first_week)})
    payload = base.model_dump(by_alias=True, exclude_none=True)
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    request = OptimizeScheduleRequest.model_validate(payload)
    assert request.relaxation is not None
    assert request.start_lessons

    answer = SchedulerSolver(_settings(30.0)).solve(request)

    assert calls == [len(request.start_lessons or [])], "the strict try, once, and nothing else reached the driver"
    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert _faults(request, answer.lessons) == []


def test_the_field_is_absent_byte_for_byte_when_the_gateway_sends_none() -> None:
    request = build_week(SHAPE).request
    assert request.start_lessons is None
    assert "startLessons" not in request.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert OptimizeScheduleRequest.model_validate({**request.model_dump(mode="json", by_alias=True, exclude_none=True), "startLessons": None}).start_lessons is None


# ---- the report -----------------------------------------------------------------------------------------------------


def test_the_step_start_exists_and_runs_before_the_builds() -> None:
    names = list(get_args(TimeoutStageName))
    assert "START" in names
    assert names.index("PRECHECKS") < names.index("START") < names.index("BUILD")


def test_a_solve_that_was_asked_again_reports_each_step_once_with_the_seconds_summed() -> None:
    clock = StageClock(0.0)
    clock.enter("START", 0.5)
    clock.enter("PRECHECKS", 1.0)
    clock.enter("BUILD", 3.0)
    clock.enter("SEARCH_CLEAN", 4.0)
    clock.enter("START", 9.0)       # an attempt was refused: the schedule is read again
    clock.enter("PRECHECKS", 10.0)
    clock.enter("BUILD", 12.0)
    clock.enter("SEARCH_CLEAN", 13.0)

    report = clock.report(
        20.0, budget_seconds=5, configured_budget_seconds=5, caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(s.stage, s.seconds) for s in report.stages] == [
        ("PRECHECKS", 4.5), ("START", 1.5), ("BUILD", 2.0), ("SEARCH_CLEAN", 12.0),
    ]
    assert sum(s.seconds for s in report.stages) == report.total_seconds == 20.0


def test_a_search_that_ran_in_two_attempts_is_reported_once_with_its_effort_summed() -> None:
    clock = StageClock(0.0)
    clock.enter("SEARCH_CLEAN", 1.0)
    clock.note_search("CLEAN", 4.0, conflicts=100, branches=None)   # 3 s into its step, then refused: asked again
    clock.enter("PRECHECKS", 4.5)
    clock.enter("SEARCH_CLEAN", 5.0)
    clock.note_search("CLEAN", 7.0, conflicts=40, branches=None)
    clock.enter("SEARCH_CLONE", 7.0)
    clock.note_search("CLONE", 9.0, conflicts=None, branches=None)

    report = clock.report(
        9.0, budget_seconds=5, configured_budget_seconds=5, caller_wait_seconds=None, week_load_cut=False,
    )

    assert [(p.phase, p.seconds, p.conflicts, p.branches) for p in report.search.phases] == [
        ("CLEAN", 5.0, 140, None),   # 3.0 + 2.0 s; the branches were read by neither run
        ("CLONE", 2.0, None, None),
    ]



def test_a_driver_at_its_most_attempts_fits_what_the_gateway_keeps_of_a_report() -> None:
    """Seven attempts (six rounds and the last one), each through every step and both searches: 7 steps and 2 searches, not 40.

    The gateway keeps 12 steps and 6 searches of a report, counted as raw entries, and refuses the whole report beyond it.
    """
    clock = StageClock(0.0)
    now = 0.0
    clock.enter("START", now)
    for _attempt in range(staged.MAX_ROUNDS + 1):
        for stage in ("PRECHECKS", "BUILD", "SITES", "SEARCH_CLEAN"):
            now += 1.0
            clock.enter(stage, now)  # type: ignore[arg-type]
        now += 1.0
        clock.note_search("CLEAN", now, conflicts=10, branches=20)
        clock.enter("SEARCH_CLONE", now)
        now += 1.0
        clock.note_search("CLONE", now, conflicts=10, branches=20)
        clock.enter("START", now)

    report = clock.report(
        now, budget_seconds=5, configured_budget_seconds=5, caller_wait_seconds=None, week_load_cut=False,
    )

    # a solve begins in its checks, so that is the first step; the order is the order each step first ran in
    assert [s.stage for s in report.stages] == ["PRECHECKS", "START", "BUILD", "SITES", "SEARCH_CLEAN", "SEARCH_CLONE"]
    assert [(p.phase, p.conflicts, p.branches) for p in report.search.phases] == [
        ("CLEAN", 10 * (staged.MAX_ROUNDS + 1), 20 * (staged.MAX_ROUNDS + 1)),
        ("CLONE", 10 * (staged.MAX_ROUNDS + 1), 20 * (staged.MAX_ROUNDS + 1)),
    ]
    assert len(report.stages) <= 12 and len(report.search.phases) <= 6
    assert round(sum(s.seconds for s in report.stages), 1) == report.total_seconds
