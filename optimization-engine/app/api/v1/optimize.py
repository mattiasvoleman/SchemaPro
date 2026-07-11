from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.config import Settings, get_settings
from app.dependencies import verify_api_key
from app.logging_config import get_logger
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse
from app.solver.scheduler_solver import SchedulerSolver

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["optimization"])

# Head-room added on top of the solver wall-clock limit to cover the synchronous
# model-build phase. If the whole solve exceeds this, we fail rather than let a
# pathological request pin the worker indefinitely.
_SOLVE_BUILD_HEADROOM_SECONDS = 30.0


async def run_solver(
    payload: OptimizeScheduleRequest,
    settings: Settings,
) -> OptimizeScheduleResponse:
    """Run the CPU-bound solve off the event loop with a hard ceiling."""
    solver = SchedulerSolver(settings)
    timeout = settings.solver_max_time_seconds + _SOLVE_BUILD_HEADROOM_SECONDS
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(solver.solve, payload),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.error("optimization_timed_out", request_id=str(payload.request_id))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Optimization timed out.",
        ) from None


@router.post(
    "/optimize",
    response_model=OptimizeScheduleResponse,
    status_code=status.HTTP_200_OK,
    summary="Run CP-SAT master timetable optimization",
    dependencies=[Depends(verify_api_key)],
)
async def optimize_schedule(
    payload: OptimizeScheduleRequest,
    settings: Settings = Depends(get_settings),
) -> OptimizeScheduleResponse:
    """Accept anonymized scheduling demand and return a weekly master timetable."""
    logger.info(
        "optimization_requested",
        request_id=str(payload.request_id),
        academic_year_id=str(payload.academic_year_id),
        requirement_count=len(payload.requirements),
        room_count=len(payload.rooms),
        constraint_count=len(payload.constraints),
    )

    response = await run_solver(payload, settings)

    log_fields: dict[str, Any] = {
        "request_id": str(response.request_id),
        "status": response.status,
        "lesson_count": len(response.lessons),
    }
    if response.conflicts is not None:
        log_fields["conflict_count"] = len(response.conflicts.conflicts)

    logger.info("optimization_completed", **log_fields)
    return response
