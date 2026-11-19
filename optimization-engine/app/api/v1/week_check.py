"""Kontrollera veckan: POST /api/v1/check-week.

The week as Generera would send it, answered in seconds with what the engine's
own quick checks find out before any timetable model is built (see
SchedulerSolver.check_week). It never solves: the scheduling model is not
built and no search is started. The request is OptimizeScheduleRequest, so the
gateway builds one payload and asks either route with it; a school learns
"year 9 sits at 97 % of its frame time" before it waits a budget for a no.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.logging_config import get_logger
from app.schemas.schedule import OptimizeScheduleRequest
from app.schemas.week_check import WeekCheckResponse
from app.solver.scheduler_solver import SchedulerSolver

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["optimization"])

# The ceiling on one check. The week load has its own deadline (four seconds,
# SchedulerSolver.WEEK_LOAD_SECONDS) and the counts are arithmetic, but the
# payload's own refusals and the graphs are built synchronously and cannot be
# interrupted. A check that is not done in this long is failing the one thing it
# is for, which is to be quick: it is answered 503 and the thread, which cannot
# be cancelled, finishes on its own.
_CHECK_CEILING_SECONDS = 30.0


@router.post(
    "/check-week",
    response_model=WeekCheckResponse,
    status_code=status.HTTP_200_OK,
    summary="Check a week with the quick checks only; no timetable is searched for",
    dependencies=[Depends(verify_api_key)],
)
async def check_week(
    payload: OptimizeScheduleRequest,
    settings: Settings = Depends(get_app_settings),
) -> WeekCheckResponse:
    """Accept the payload Generera sends and answer what is already known of the week."""
    logger.info(
        "week_check_requested",
        request_id=str(payload.request_id),
        academic_year_id=str(payload.academic_year_id),
        requirement_count=len(payload.requirements),
    )
    # A solver of its own, as run_solver builds one: nothing is kept between
    # requests and `settings` is never written to.
    solver = SchedulerSolver(settings)
    try:
        response = await asyncio.wait_for(
            asyncio.to_thread(solver.check_week, payload),
            timeout=_CHECK_CEILING_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error("week_check_timed_out", request_id=str(payload.request_id))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Week check timed out.",
        ) from None

    logger.info(
        "week_check_completed",
        request_id=str(response.request_id),
        verdict=response.verdict,
        year_count=len(response.years),
        skipped=response.skipped,
        elapsed_ms=response.elapsed_ms,
    )
    return response
