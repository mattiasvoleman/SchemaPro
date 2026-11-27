from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import SolverTimeoutError
from app.logging_config import get_logger
from app.schemas.staffing import StaffRequest, StaffResponse
from app.solve_load import OTHER, SOLVE_LOAD
from app.solver.staffing_solver import StaffingSolver
from app.timing import BUILD_HEADROOM_SECONDS, RouteLimits

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["staffing"])

# Head-room on top of the solver's own limit for what the limit does not
# bound: the domains, the greedy, the build and the Python re-checks, which
# grow with the school rather than the budget. The same figure as the other
# two routes (app.timing.BUILD_HEADROOM_SECONDS, one number for every route):
# past it, the request fails rather than pin a worker.
_BUILD_HEADROOM_SECONDS = BUILD_HEADROOM_SECONDS


def route_limits(settings: Settings) -> RouteLimits:
    """The staffing proposal's times: its own budget and the headroom, no probe."""
    return RouteLimits(settings.staff_solver_max_time_seconds, 0.0, _BUILD_HEADROOM_SECONDS)


async def run_staffing_solver(payload: StaffRequest, settings: Settings) -> StaffResponse:
    """Run the CPU-bound solve off the event loop with a hard ceiling."""
    solver = StaffingSolver(settings)
    timeout = route_limits(settings).ceiling_seconds

    def counted() -> StaffResponse:
        # The thread's life is what is counted (app.solve_load), as the generator's is.
        with SOLVE_LOAD.running(OTHER, str(payload.request_id)):
            return solver.solve(payload)

    try:
        return await asyncio.wait_for(asyncio.to_thread(counted), timeout=timeout)
    except asyncio.TimeoutError:
        logger.error("staffing_proposal_timed_out", request_id=str(payload.request_id))
        raise SolverTimeoutError(
            "Staffing proposal timed out.", route="staff", ceiling_seconds=timeout,
        ) from None


@router.post(
    "/staff",
    response_model=StaffResponse,
    status_code=status.HTTP_200_OK,
    summary="Propose a lead teacher for every curriculum entry",
    dependencies=[Depends(verify_api_key)],
)
async def staff(
    payload: StaffRequest,
    settings: Settings = Depends(get_app_settings),
) -> StaffResponse:
    """Accept an anonymised tjänstefördelning and return a staffing proposal."""
    logger.info(
        "staffing_proposal_requested",
        request_id=str(payload.request_id),
        teacher_count=len(payload.teachers),
        requirement_count=len(payload.requirements),
        eligibility_set_count=len(payload.eligibility_sets),
        respect_qualifications=payload.respect_qualifications,
    )

    response = await run_staffing_solver(payload, settings)

    logger.info(
        "staffing_proposal_completed",
        request_id=str(response.request_id),
        status=response.status,
        unstaffed_proven=response.unstaffed_proven,
        assignment_count=len(response.assignments),
        unstaffed_count=len(response.unstaffed),
        conflict_count=len(response.conflicts),
    )
    return response
