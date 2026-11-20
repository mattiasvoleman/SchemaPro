"""Lärarval: POST /api/v1/week-bounds.

Each year's exact least week, week by week, for the payload Generera sends (and
the copy of it a candidate choice of teachers makes). It is the oracle of the
gateway's search for the choice that eases the week (SchedulerSolver.week_bounds
says why /check-week cannot be): the gateway asks for one candidate at a time, a
few at once, and decides from the figures.

It never solves and builds no timetable model. It is CPU all the same, and a
search asks for hundreds, so the route holds a gate (`week_bounds_concurrency`):
beyond it the answer is 429 and the caller backs off. The ceiling is the same as
the week check's: a count that has not finished by then answers 503 and its
thread, which cannot be cancelled, finishes on its own.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.v1.week_check import _CHECK_CEILING_SECONDS
from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.logging_config import get_logger
from app.schemas.week_bounds import WeekBoundsRequest, WeekBoundsResponse
from app.solver.scheduler_solver import SchedulerSolver

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["optimization"])

#: The count's own seconds are in the request; this is what the thread may take beyond them (the graphs and
#: the arithmetic counts before and between the weeks are built synchronously and cannot be interrupted).
_BUILD_HEADROOM_SECONDS = _CHECK_CEILING_SECONDS


def _gate(request: Request, settings: Settings) -> asyncio.Semaphore:
    """The gate of this application (one per app instance, so a test's app is its own)."""
    state = request.app.state
    gate = getattr(state, "week_bounds_gate", None)
    if gate is None:
        gate = asyncio.Semaphore(settings.week_bounds_concurrency)
        state.week_bounds_gate = gate
    return gate  # type: ignore[no-any-return]


@router.post(
    "/week-bounds",
    response_model=WeekBoundsResponse,
    status_code=status.HTTP_200_OK,
    summary="Count each year's exact least week, week by week; no timetable is searched for",
    dependencies=[Depends(verify_api_key)],
)
async def week_bounds(
    payload: WeekBoundsRequest,
    request: Request,
    settings: Settings = Depends(get_app_settings),
) -> WeekBoundsResponse:
    """Accept the payload Generera sends and answer the exact figures of its weeks."""
    gate = _gate(request, settings)
    if gate.locked():
        # Not queued: a caller that waits here holds a connection for as long as the counts before it take.
        logger.warning("week_bounds_busy", request_id=str(payload.request_id))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="The week counter is busy. Try again in a moment.",
        )
    async with gate:
        logger.info(
            "week_bounds_requested",
            request_id=str(payload.request_id),
            requirement_count=len(payload.requirements),
            years=payload.years,
            seconds=payload.seconds,
        )
        solver = SchedulerSolver(settings)
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(
                    solver.week_bounds,
                    payload,
                    years=payload.years,
                    cutoffs={cutoff.year: (cutoff.demand_minutes, cutoff.capacity_minutes) for cutoff in payload.cutoffs},
                    seconds=payload.seconds,
                ),
                timeout=payload.seconds + _BUILD_HEADROOM_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.error("week_bounds_timed_out", request_id=str(payload.request_id))
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Week count timed out.",
            ) from None
    logger.info(
        "week_bounds_completed",
        request_id=str(response.request_id),
        rows=len(response.rows),
        weeks=f"{response.weeks_counted}/{response.weeks_total}",
        deadline_hit=response.deadline_hit,
        refused=response.refusal is not None,
        elapsed_ms=response.elapsed_ms,
    )
    return response
