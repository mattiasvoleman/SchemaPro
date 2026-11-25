"""Ett schema som start, granskningen av #460: another attempt is begun only where the request's clock can hold it.

An attempt begins with its checks and its two builds, and nothing in them is under the clock. A refusal that came
late (a proof at 538 s of 577, its explanation after it) was followed by another attempt with no time for its
builds: on a school whose builds take a minute the answer came at 632 s against a ceiling of 590, which the route
answers 503 at. A solve without startLessons answers such a proof with its explanation at about 550 s.
"""

from __future__ import annotations

import sys
import types
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

import app.solver.scheduler_solver as scheduler_solver  # noqa: E402
from app.config import Settings  # noqa: E402
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleResponse, StartedLesson  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from app.solver.stage_clock import StageClock  # noqa: E402
from app.timing import Deadline  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
CEILING = 590.0   # production: 540 s of search, 20 s of probe, 30 s of headroom


def _driven(monkeypatch: pytest.MonkeyPatch, *, builds: float, proof: float, refused: int):  # noqa: ANN202
    """The driver, with `_solve_strict` replaced by what the real one does to the clock and to `_build_seconds`:
    its checks and builds (`builds` seconds), a proof, an explanation with no step open, and a refusal that names
    one more held requirement. The attempt after `refused` refusals answers with a TIMEOUT."""
    now = [1000.0]
    monkeypatch.setattr(scheduler_solver, "time", types.SimpleNamespace(monotonic=lambda: now[0], perf_counter=lambda: now[0]))
    request = build_week(SHAPE).request
    given = request.requirements[:8]
    request = request.model_copy(update={
        "start_lessons": [
            StartedLesson(requirementId=r.id, dayOfWeek=1 + i % 5, startTime="08:00:00", endTime=f"{8 + r.lesson_minutes()[0] // 60:02d}:{r.lesson_minutes()[0] % 60:02d}:00")
            for i, r in enumerate(given)
        ],
        "group_conflicts": [], "constraints": [],
    })
    seen: list[tuple[float, float]] = []   # (the clock at the attempt's start, `entered` it was given)

    def fake(self, attempt, entered):  # noqa: ANN001, ANN202
        seen.append((now[0], entered))
        now[0] += builds
        self._build_seconds = (now[0] - entered) / 2     # as _solve_strict has it
        if len(seen) <= refused:
            now[0] += proof
            self._leave_stage()
            now[0] += 12.0                                # the explanation
            named = given[len(seen) - 1].id
            detail = ConflictDetail(category="PLACEMENT", code="PLACED_LESSON_IN_THE_WAY_ANY_ROOM", params={"requirement": str(named), "day": 1, "start": "08:00", "end": "09:00"}, requirement_ids=[named])
            return OptimizeScheduleResponse(request_id=uuid.uuid4(), status="INFEASIBLE", lessons=[], conflicts=ConflictAnalysis(conflicts=[detail]))  # type: ignore[arg-type]
        now[0] += 5.0
        return OptimizeScheduleResponse(request_id=uuid.uuid4(), status="FEASIBLE", lessons=[], conflicts=None)  # type: ignore[arg-type]

    monkeypatch.setattr(SchedulerSolver, "_solve_strict", fake)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=540, SOLVER_PROBE_SECONDS=20))  # type: ignore[call-arg]
    solver._deadline = Deadline(now[0], CEILING)
    solver._stages = StageClock(now[0])
    response = solver._solve_from_start(request, now[0])
    return response, seen, now[0] - 1000.0


def test_no_attempt_is_begun_that_the_clock_has_no_room_for_its_builds(monkeypatch: pytest.MonkeyPatch) -> None:
    response, seen, elapsed = _driven(monkeypatch, builds=60.0, proof=466.0, refused=1)

    assert response.status == "TIMEOUT", "a refusal after the schedule was let go in part is not the week's own, and not answered"
    assert len(seen) == 1, f"{len(seen)} attempts: the second was begun at {seen[1][0] - 1000.0:.0f} s of 577"
    assert elapsed < CEILING - 3, f"answered at {elapsed:.0f} s, the route's ceiling is {CEILING:.0f}"


def test_an_attempt_the_clock_can_hold_is_begun_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    response, seen, elapsed = _driven(monkeypatch, builds=8.0, proof=3.0, refused=3)

    assert response.status == "FEASIBLE" and len(seen) == 4
    assert elapsed < 100.0


def test_a_later_attempt_counts_its_builds_from_its_own_start(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_build_seconds` gates the probe and the explanation; from the request's arrival it is half of every round before."""
    response, seen, _elapsed = _driven(monkeypatch, builds=8.0, proof=20.0, refused=3)

    assert response.status == "FEASIBLE"
    first_started, first_given = seen[0]
    assert first_given == first_started, "the first attempt counts from the request's arrival, as always"
    for started, given in seen[1:]:
        assert given == started, "a later one counts from its own start, not from the request's arrival"
