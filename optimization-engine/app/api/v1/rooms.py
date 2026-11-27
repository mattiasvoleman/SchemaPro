from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import SolverTimeoutError
from app.logging_config import get_logger
from app.solve_load import OTHER, SOLVE_LOAD
from app.schemas.rooms import OptimizeRoomsRequest, OptimizeRoomsResponse
from app.solver.room_walks import RoomWalkSolver
from app.timing import BUILD_HEADROOM_SECONDS, RouteLimits

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["rooms"])

# Head-room on top of the solver's own limit for the synchronous build, which
# here is plain Python over every (lesson, room) choice and every walker's step
# — it grows with the school, not with the budget. The same figure as the
# generator's route (app.timing.BUILD_HEADROOM_SECONDS, one number for every
# route): past it, the request fails rather than pin a worker.
_BUILD_HEADROOM_SECONDS = BUILD_HEADROOM_SECONDS


def route_limits(settings: Settings) -> RouteLimits:
    """The room proposal's times: its own budget and the headroom, no probe."""
    return RouteLimits(settings.room_solver_max_time_seconds, 0.0, _BUILD_HEADROOM_SECONDS)


async def run_room_solver(
    payload: OptimizeRoomsRequest,
    settings: Settings,
) -> OptimizeRoomsResponse:
    """Run the CPU-bound solve off the event loop with a hard ceiling."""
    solver = RoomWalkSolver(settings)
    timeout = route_limits(settings).ceiling_seconds

    def counted() -> OptimizeRoomsResponse:
        # The thread's life is what is counted (app.solve_load), as the generator's is.
        with SOLVE_LOAD.running(OTHER, str(payload.request_id)):
            return solver.solve(payload)

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(counted),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.error("room_optimization_timed_out", request_id=str(payload.request_id))
        raise SolverTimeoutError(
            "Room optimization timed out.", route="optimize-rooms", ceiling_seconds=timeout,
        ) from None


@router.post(
    "/optimize-rooms",
    response_model=OptimizeRoomsResponse,
    status_code=status.HTTP_200_OK,
    summary="Re-assign the rooms of a fixed timetable so fewer people walk",
    dependencies=[Depends(verify_api_key)],
)
async def optimize_rooms(
    payload: OptimizeRoomsRequest,
    settings: Settings = Depends(get_app_settings),
) -> OptimizeRoomsResponse:
    """Accept an anonymised grundschema and return a room-only proposal."""
    logger.info(
        "room_optimization_requested",
        request_id=str(payload.request_id),
        walkers=payload.walkers,
        lesson_count=len(payload.lessons),
        room_count=len(payload.rooms),
    )

    response = await run_room_solver(payload, settings)

    logger.info(
        "room_optimization_completed",
        request_id=str(response.request_id),
        status=response.status,
        change_count=len(response.changes),
        frozen_count=len(response.frozen_lesson_ids),
    )
    return response
