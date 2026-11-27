"""Åtgärdsförslag vid vägran: POST /api/v1/suggest-changes.

The week as Generera would send it, answered with the changes a school could make
so that the week can be laid, and how well the engine has shown each of them (see
app/solver/suggestions.py). It places nothing and stores nothing: the timetable the
search finds is read for its deviations and thrown away.

IT IS A SOLVE, so it is held like one. One runs in this process at a time, whatever
a caller sends: the engine is shared by every school, a production deployment has
one replica, and an analysis of 60 s and a check of up to 30 more is not something
two schools should be able to stack. Beyond the gate the answer is 429, never a
queue, and the caller backs off (the gateway reads it as "try again in a moment").
/optimize is not behind the gate and is never queued behind this route; they share
the machine's cores, which is why the gateway does not start this while the school's
own Generera is running and why the search is given at most the workers it names.

AN ANALYSIS YIELDS TO A GENERERA, WHOSEVER IT IS. The gate knows only analyses; the gateway's own check knows only the
school's own run. A Generera for another school on the same engine asks CP-SAT for every core, so an analysis that
starts beside it takes them from it. app.solve_load counts the Generera runs of this process (from /optimize and from
/v1/schedule alike, by the thread's life) and this route answers 429 while the count is not zero. The converse, a
Generera that starts beside an analysis already running, is not refused (a Generera never is) and is logged.

THE GATE IS THE THREAD'S, NOT THE ANSWER'S. A solve's thread cannot be cancelled, so
the 503 at the ceiling ends the wait and not the work. A gate that opened with the
503 let a second analysis start beside the first one's still-running thread, and a
third beside those: "one at a time" held only for analyses that answered in time. The
gate now opens when the thread ends, whatever the caller has been told (review of
#384).

An engine older than this route answers 404 and the gateway says so; it is never
sent a request that would reach a route that does not exist as anything but that.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import SolverTimeoutError
from app.logging_config import get_logger
from app.schemas.schedule import OptimizeScheduleRequest, SearchOptions
from app.schemas.suggestions import SuggestChangesResponse
from app.solve_load import ANALYSIS, GENERATION, OTHER, SOLVE_LOAD
from app.solver.scheduler_solver import settings_for_search
from app.solver.suggestions import route_limits, suggest_changes
from app.timing import ceiling_seconds

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["optimization"])

#: How many analyses this process runs at once. One, and not a setting, for the reason
#: week_bounds gives for its own gate.
SUGGEST_AT_ONCE = 1


def _gate(request: Request) -> asyncio.Semaphore:
    """The gate of this application (one per app instance, so a test's app is its own)."""
    state = request.app.state
    gate = getattr(state, "suggest_changes_gate", None)
    if gate is None:
        gate = asyncio.Semaphore(SUGGEST_AT_ONCE)
        state.suggest_changes_gate = gate
    return gate  # type: ignore[no-any-return]


def solve_ceiling_seconds(
    settings: Settings, search: SearchOptions | None, deadline_seconds: float | None,
) -> float:
    """After this long the route stops waiting: the search, the check and the builds, never past the caller's deadline."""
    return ceiling_seconds(route_limits(settings, search), deadline_seconds)


@router.post(
    "/suggest-changes",
    response_model=SuggestChangesResponse,
    status_code=status.HTTP_200_OK,
    summary="Name the changes that would let a refused week be laid, checked against the strict model",
    dependencies=[Depends(verify_api_key)],
)
async def suggest_changes_route(
    payload: OptimizeScheduleRequest,
    request: Request,
    settings: Settings = Depends(get_app_settings),
) -> SuggestChangesResponse:
    """Accept the payload Generera sends and answer what the five rules that may give way would need."""
    # An analysis yields to every Generera on this engine, whichever school's (app.solve_load): the Generera is what a school
    # came for, and it asks CP-SAT for every core unless it names its workers. A 429, never a queue, like the gate's.
    generations = SOLVE_LOAD.count(GENERATION)
    # And to the three short solves that share the cores (a staffing proposal, an exam plan, a room proposal: g391-L-5).
    others = SOLVE_LOAD.count(OTHER)
    if generations or others:
        logger.warning(
            "suggest_changes_yields_to_generation",
            request_id=str(payload.request_id),
            generations_running=generations,
            other_solves_running=others,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="A timetable is being generated on this engine. Try again in a moment.",
        )
    gate = _gate(request)
    if gate.locked():
        logger.warning("suggest_changes_busy", request_id=str(payload.request_id))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Another analysis is running. Try again in a moment.",
        )
    await gate.acquire()
    work: asyncio.Future[SuggestChangesResponse] | None = None
    try:
        logger.info(
            "suggest_changes_requested",
            request_id=str(payload.request_id),
            academic_year_id=str(payload.academic_year_id),
            requirement_count=len(payload.requirements),
        )
        # The request's own settings, as run_solver scopes them: the budget the caller asks for can only
        # shrink the deployment's.
        scoped = settings_for_search(settings, payload.search)
        ceiling = solve_ceiling_seconds(scoped, payload.search, payload.deadline_seconds)

        def counted() -> SuggestChangesResponse:
            # The thread's life is what is counted, as for a Generera, so that a Generera's log line can say it started
            # beside this one (run_solver).
            with SOLVE_LOAD.running(ANALYSIS, str(payload.request_id)):
                beside, generation_id, generation_age = SOLVE_LOAD.oldest(GENERATION)
                if beside:
                    # The route found no Generera running and a Generera's thread began before this one did: the window
                    # between the two checks. Said from this side too, since the Generera's own line cannot see it.
                    logger.warning(
                        "analysis_beside_generation",
                        request_id=str(payload.request_id),
                        generations_running=beside,
                        generation_request_id=generation_id,
                        generation_seconds=round(generation_age, 1),
                    )
                return suggest_changes(payload, settings, ceiling_seconds=ceiling)

        work = asyncio.ensure_future(asyncio.to_thread(counted))
        # The gate opens when the THREAD ends (see the head of this module), and an error the nobody waits for
        # any more is read here so that it is logged by the route and not by the event loop's "never retrieved".
        work.add_done_callback(_open(gate))
        try:
            response = await asyncio.wait_for(asyncio.shield(work), timeout=ceiling)
        except asyncio.TimeoutError:
            logger.error("suggest_changes_timed_out", request_id=str(payload.request_id))
            raise SolverTimeoutError(
                "Suggestion run timed out.", route="suggest-changes", ceiling_seconds=ceiling,
            ) from None
    finally:
        if work is None:
            gate.release()
    logger.info(
        "suggest_changes_completed",
        request_id=str(response.request_id),
        verdict=response.verdict,
        changes=len(response.changes),
        verified=response.verified,
        elapsed_ms=response.elapsed_ms,
    )
    return response


def _open(gate: asyncio.Semaphore) -> Callable[[asyncio.Future[SuggestChangesResponse]], None]:
    """What runs when the analysis's thread has ended: the gate opens, and an error nobody awaited is read."""

    def opened(done: asyncio.Future[SuggestChangesResponse]) -> None:
        gate.release()
        if not done.cancelled():
            done.exception()

    return opened
