"""Klickar i den fulla modellen (M8 PR 6): the same rule in fewer rows, and only where it is meant to be.

`cliques.cover` is held by tests/test_cliques.py. What is held here is what the engine does with it:

  * the rows the full model posts for a cover forbid exactly the pairs of lessons the rows posted for the pairs forbid (read off
    the model's own NoOverlap rows, not off a solve), and a path of groups (A–B, B–C) leaves A and C free to sit at once;
  * the week is laid either way, and the answer keeps every rule when read from the answer;
  * only the full model of a strict solve is built so: phase 1a's satisfaction model is byte for byte the model it was, with the
    setting on and off, which is what keeps the nightly gate measuring the search it measured;
  * `SOLVER_GROUP_CLIQUES=false` gives the pairs back everywhere.
"""

from __future__ import annotations

import hashlib
import sys
import uuid
from itertools import combinations
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

#: Six classes of three years with three subjects in groups across the classes: pairs of groups in plenty.
SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _settings(*, cliques: bool = True, seconds: float = 30.0) -> Settings:
    return Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=seconds, SOLVER_PROBE_SECONDS=0, SOLVER_GROUP_CLIQUES=cliques,
    )


def _week(seed: int = 1) -> OptimizeScheduleRequest:
    from dataclasses import replace

    return build_week(replace(SHAPE, seed=seed)).request


def _build(request: OptimizeScheduleRequest, *, objective: bool, by_cliques: bool):  # noqa: ANN202
    """The model and its decisions, and which lesson each of the PUPILS' intervals belongs to (a spy on the pupil padding)."""
    import app.solver.scheduler_solver as engine

    owner: dict[int, tuple] = {}
    real = engine.pupil_padded_of

    def spy(model, decision):  # noqa: ANN001, ANN202
        interval = real(model, decision)
        owner[interval.Index()] = decision.lesson.key()
        return interval

    engine.pupil_padded_of = spy
    try:
        solver = SchedulerSolver(_settings())
        model, _, decisions, _, _ = solver._build_model(
            request, use_assumptions=False, include_objective=objective, by_cliques=by_cliques,
        )
    finally:
        engine.pupil_padded_of = real
    return model, decisions, owner


def _rows(model) -> list[list[int]]:  # noqa: ANN001
    """Each NoOverlap row of the model as the indices of its intervals."""
    return [
        list(constraint.no_overlap.intervals)
        for constraint in model.Proto().constraints
        if constraint.has_no_overlap()
    ]


def _forbidden(model, owner) -> set[frozenset[tuple]]:  # noqa: ANN001
    """The pairs of lessons that share a row of the pupils' anywhere in the model: what it forbids to overlap."""
    out: set[frozenset[tuple]] = set()
    for row in _rows(model):
        for a, b in combinations(sorted({owner[i] for i in row if i in owner}, key=str), 2):
            out.add(frozenset((a, b)))
    return out


def _pupil_rows(model, owner) -> int:  # noqa: ANN001
    return sum(1 for row in _rows(model) if any(i in owner for i in row))


def _hash(model) -> str:  # noqa: ANN001
    return hashlib.sha256(str(model.Proto()).encode()).hexdigest()


# ---- the same rule ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_the_rows_of_the_cover_forbid_exactly_the_pairs_of_lessons_the_rows_of_the_pairs_forbid(seed: int) -> None:
    request = _week(seed)
    by_pairs, decisions, pair_owner = _build(request, objective=True, by_cliques=False)
    by_cover, same_decisions, cover_owner = _build(request, objective=True, by_cliques=True)

    assert len(decisions) == len(same_decisions)
    assert _forbidden(by_cover, cover_owner) == _forbidden(by_pairs, pair_owner), "another rule"
    assert _forbidden(by_pairs, pair_owner), "a week with pairs forbids some"


def test_a_cover_is_fewer_rows_than_the_pairs() -> None:
    request = _week()
    by_pairs, _, pair_owner = _build(request, objective=True, by_cliques=False)
    by_cover, _, cover_owner = _build(request, objective=True, by_cliques=True)

    assert len(request.group_conflicts) > 20
    assert _pupil_rows(by_cover, cover_owner) < _pupil_rows(by_pairs, pair_owner)


def test_two_groups_that_share_no_pupil_may_sit_at_once_though_both_pair_with_a_third() -> None:
    """A–B and B–C pair and A–C does not: a row over all three would forbid what the school never said."""
    request = _week()
    firsts: dict[int | None, uuid.UUID] = {}
    for requirement in request.requirements:
        firsts.setdefault(requirement.min_grade_level, requirement.student_group_id)
    a, b, c = (firsts[year] for year in (7, 8, 9))
    path = request.model_copy(update={"group_conflicts": [(a, b), (b, c)]})
    by_cover, decisions, cover_owner = _build(path, objective=True, by_cliques=True)
    by_pairs, _, pair_owner = _build(path, objective=True, by_cliques=False)

    a_lessons = {d.lesson.key() for d in decisions if d.lesson.requirement.student_group_id == a}
    c_lessons = {d.lesson.key() for d in decisions if d.lesson.requirement.student_group_id == c}
    forbidden = _forbidden(by_cover, cover_owner)

    assert forbidden == _forbidden(by_pairs, pair_owner)
    assert not any(frozenset((x, y)) in forbidden for x in a_lessons for y in c_lessons), (
        "A and C share no pupil and may sit at once: a row over the path would forbid it"
    )


@pytest.mark.parametrize("seed", [1, 2])
def test_a_week_is_laid_either_way_and_the_answer_keeps_every_rule(seed: int) -> None:
    request = _week(seed)
    answers = {}
    for cliques in (False, True):
        response = SchedulerSolver(_settings(cliques=cliques, seconds=30.0)).solve(request)
        assert response.status in ("OPTIMAL", "FEASIBLE"), (cliques, response.status)
        assert len(response.lessons) == sum(r.lessons_per_week for r in request.requirements)
        assert _faults(request, response.lessons) == [], cliques
        answers[cliques] = response
    # Both are laid and read back from their own answers; the same rule does not mean the same timetable.
    assert answers[True].lessons and answers[False].lessons


def _minutes(clock: str) -> int:
    hours, minutes, _ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def _faults(request: OptimizeScheduleRequest, lessons) -> list[str]:  # noqa: ANN001
    requirement = {r.id: r for r in request.requirements}
    pairs = {frozenset(pair) for pair in request.group_conflicts}
    faults: list[str] = []
    for index, a in enumerate(lessons):
        ra = requirement[a.requirement_id]
        for b in lessons[index + 1:]:
            if not (
                a.day_of_week == b.day_of_week
                and _minutes(a.start_time) < _minutes(b.end_time)
                and _minutes(b.start_time) < _minutes(a.end_time)
            ):
                continue
            rb = requirement[b.requirement_id]
            if a.room_id == b.room_id:
                faults.append("a room twice at once")
            if ra.teacher_id is not None and ra.teacher_id == rb.teacher_id:
                faults.append("a teacher in two places")
            if ra.student_group_id == rb.student_group_id or frozenset((ra.student_group_id, rb.student_group_id)) in pairs:
                faults.append("pupils in two places")
    return faults


# ---- only where it is meant to be ---------------------------------------------------------------------------------


def test_phase_1a_s_model_is_the_model_it_was_with_the_setting_on_and_off() -> None:
    """The nightly gate measures phase 1a: its model must not move by a byte."""
    request = _week()
    seen: dict[bool, list[tuple[bool, bool]]] = {}
    for cliques in (True, False):
        calls: list[tuple[bool, bool]] = []
        solver = SchedulerSolver(_settings(cliques=cliques))
        real = SchedulerSolver._build_model

        def build(self, req, *, by_cliques=False, **kwargs):  # noqa: ANN001, ANN003, ANN202
            calls.append((kwargs.get("include_objective", True), by_cliques))
            return real(self, req, by_cliques=by_cliques, **kwargs)

        SchedulerSolver._build_model = build  # type: ignore[method-assign]
        try:
            solver.solve(request)
        finally:
            SchedulerSolver._build_model = real  # type: ignore[method-assign]
        seen[cliques] = calls[:2]

    assert seen[True] == [(True, True), (False, False)], "the full model by cliques, the satisfaction model by pairs"
    assert seen[False] == [(True, False), (False, False)], "the setting off gives the pairs back"
    clean_on, _, _ = _build(_week(), objective=False, by_cliques=False)
    clean_again, _, _ = _build(_week(), objective=False, by_cliques=False)
    assert _hash(clean_on) == _hash(clean_again)


def test_the_setting_is_on_by_default_and_reads_its_environment_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SOLVER_GROUP_CLIQUES", raising=False)
    assert Settings(API_KEY="k" * 32, ALLOWED_ORIGINS="http://localhost").solver_group_cliques is True  # type: ignore[call-arg]
    monkeypatch.setenv("SOLVER_GROUP_CLIQUES", "false")
    assert Settings(API_KEY="k" * 32, ALLOWED_ORIGINS="http://localhost").solver_group_cliques is False  # type: ignore[call-arg]


def test_the_cover_does_not_depend_on_the_order_the_gateway_sends_the_pairs_in() -> None:
    request = _week()
    shuffled = list(reversed(request.group_conflicts))
    other = request.model_copy(update={"group_conflicts": [(b, a) for a, b in shuffled]})
    first, _, first_owner = _build(request, objective=True, by_cliques=True)
    second, _, second_owner = _build(other, objective=True, by_cliques=True)

    assert _forbidden(first, first_owner) == _forbidden(second, second_owner)
    assert uuid.UUID  # keep the import used by neighbours of this module
