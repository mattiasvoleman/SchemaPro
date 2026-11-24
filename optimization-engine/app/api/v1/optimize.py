from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import SolverTimeoutError
from app.logging_config import get_logger
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse, SearchOptions
from app.solve_load import ANALYSIS, GENERATION, SOLVE_LOAD
from app.solver.scheduler_solver import SchedulerSolver, settings_for_search
from app.timing import BUILD_HEADROOM_SECONDS, ceiling_seconds, generation_limits

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["optimization"])

# Head-room added on top of the solver wall-clock limit to cover the synchronous
# model-build phase. If the whole solve exceeds this, we fail rather than let a
# pathological request pin the worker indefinitely. One number for every route
# now (app.timing); the name stays for what imports it.
_SOLVE_BUILD_HEADROOM_SECONDS = BUILD_HEADROOM_SECONDS


def solve_ceiling_seconds(
    settings: Settings,
    search: SearchOptions | None = None,
    deadline_seconds: float | None = None,
) -> float:
    """The wall-clock after which a solve is answered 503 instead of waited for.

    THE PROBE IS COUNTED FOR A REQUEST THAT RUNS IT. A schemaförslag candidate
    after the first sends `probes: false` (SearchOptions.probes): nothing is
    spent after its budget, and its ceiling is the budget and the builds as it
    was. Counting the deployment's probe for it put the ceiling (30 + 20 + 30 =
    80 s) after the gateway's own wait for it (30 + 45 = 75 s,
    candidate-variants.ts callTimeoutMs), which the engine is meant to answer
    first. `settings` is the request's scoped copy (settings_for_search).

    THE SEARCH, THE PROBE AND THE BUILDS, NOT THE SEARCH ALONE. A solve that
    runs out of time answers TIMEOUT after its budget AND the timeout probe
    (SOLVER_PROBE_SECONDS), which names the rule that does not fit; the model
    builds come before the budget's clock starts. The ceiling was the budget
    plus thirty seconds, which held at a 60 s budget, and at 180 s on a
    809-lesson week (2026-11-17) the builds took eight seconds, the search
    stopped ten after its budget, and the ceiling fell in the middle of the
    probe three times running: the school read "The AI engine returned an
    error." instead of the TIMEOUT and what the probe had found. The probe now
    has a deadline of its own (SchedulerSolver.solve), and the ceiling lies
    past it, so the 503 is left for a solve that hangs.

    A REQUEST THAT CARRIES ITS DEADLINE (`deadline_seconds`, how long the caller
    waits) HAS A CEILING THAT IS NEVER PAST IT: the settings' own sum, or the
    deadline less the transfer margin, whichever is less (app.timing). The
    solver counts every step's time from this same number, so the answer comes
    inside the caller's wait. The sum itself is app.timing.ceiling_seconds,
    which GET /api/v1/timing reports too.
    """
    return ceiling_seconds(
        generation_limits(
            settings,
            runs_probes=search is None or search.runs_probes,
            headroom_seconds=_SOLVE_BUILD_HEADROOM_SECONDS,
        ),
        deadline_seconds,
    )


async def run_solver(
    payload: OptimizeScheduleRequest,
    settings: Settings,
) -> OptimizeScheduleResponse:
    """Run the CPU-bound solve off the event loop with a hard ceiling.

    The ceiling is the REQUEST'S budget and probe plus the headroom
    (solve_ceiling_seconds): a schemaförslag candidate that asked for thirty
    seconds, whose probe is then fifteen, is answered 503 at seventy-five, not
    at a Generera's 110. `settings` is the app's and is never written to;
    settings_for_search returns a copy when the request brings a budget.
    """
    settings = settings_for_search(settings, payload.search)
    solver = SchedulerSolver(settings)
    timeout = solve_ceiling_seconds(settings, payload.search, payload.deadline_seconds)

    def counted() -> OptimizeScheduleResponse:
        # The thread's life is what is counted (app.solve_load): a 503 ends the wait, not this.
        with SOLVE_LOAD.running(GENERATION, str(payload.request_id)):
            beside, analysis_id, analysis_age = SOLVE_LOAD.oldest(ANALYSIS)
            if beside:
                # The one case the count does not close: an analysis is already running on the cores this solve
                # asks for. Said in the log so that how often it happens is measured and not guessed, with the
                # analysis's own id and how long it had run, so that how long the two shared the cores can be read.
                logger.warning(
                    "generation_beside_analysis",
                    request_id=str(payload.request_id),
                    analyses_running=beside,
                    analysis_request_id=analysis_id,
                    analysis_seconds=round(analysis_age, 1),
                )
            return solver.solve(payload)

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(counted),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.error("optimization_timed_out", request_id=str(payload.request_id))
        # The solve's thread is still running (it cannot be stopped from here),
        # and its clock says which step it is in: what the 503 tells the school
        # instead of only that the longest wait passed.
        where = solver.stage_where()
        raise SolverTimeoutError(
            "Optimization timed out.", route="optimize", ceiling_seconds=timeout,
            stage=None if where is None else where[0],
            stage_seconds=None if where is None else where[1],
            elapsed_seconds=None if where is None else where[2],
        ) from None


def log_optimization_requested(payload: OptimizeScheduleRequest) -> None:
    """The line a generation request leaves in the log, for BOTH of the engine's doors.

    `POST /api/v1/optimize` said it and `POST /v1/schedule`, the older door the gateway actually
    uses, did not (omgång 15, the 2026-11-23 incident): the engine's log of two Generera runs that a
    proxy closed at 300 s showed a 540 s search and a TIMEOUT, and no line that said what the request
    was or how long its caller waited. Whether the call carried a `deadlineSeconds` decides whether the
    engine's own clock cuts the search before the road closes the call, and nothing in the log said it.
    One function, so that a field added for one door cannot be missing from the other.
    """
    logger.info(
        "optimization_requested",
        request_id=str(payload.request_id),
        academic_year_id=str(payload.academic_year_id),
        requirement_count=len(payload.requirements),
        room_count=len(payload.rooms),
        constraint_count=len(payload.constraints),
        # Both only when sent, so a Generera's log line reads as it always has.
        **(
            {"search": payload.search.model_dump(exclude_none=True)}
            if payload.search is not None
            else {}
        ),
        **(
            {"deadline_seconds": payload.deadline_seconds}
            if payload.deadline_seconds is not None
            else {}
        ),
    )


def log_optimization_completed(response: OptimizeScheduleResponse) -> None:
    """What the engine answered, for both doors: the status, and what it carried."""
    log_fields: dict[str, Any] = {
        "request_id": str(response.request_id),
        "status": response.status,
        "lesson_count": len(response.lessons),
    }
    if response.conflicts is not None:
        log_fields["conflict_count"] = len(response.conflicts.conflicts)

    logger.info("optimization_completed", **log_fields)


@router.post(
    "/optimize",
    response_model=OptimizeScheduleResponse,
    status_code=status.HTTP_200_OK,
    summary="Run CP-SAT master timetable optimization",
    dependencies=[Depends(verify_api_key)],
)
async def optimize_schedule(
    payload: OptimizeScheduleRequest,
    settings: Settings = Depends(get_app_settings),
) -> OptimizeScheduleResponse:
    """Accept anonymized scheduling demand and return a weekly master timetable."""
    log_optimization_requested(payload)

    response = await run_solver(payload, settings)

    log_optimization_completed(response)
    return response
