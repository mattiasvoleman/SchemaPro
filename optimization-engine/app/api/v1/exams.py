from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, status

from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import SolverTimeoutError
from app.logging_config import get_logger
from app.solve_load import OTHER, SOLVE_LOAD
from app.schemas.exams import ExamSearch, PlanExamsRequest, PlanExamsResponse
from app.solver.exam_solver import ExamSolver, budget_seconds
from app.timing import BUILD_HEADROOM_SECONDS, RouteLimits

logger = get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["exams"])

# Head-room on top of the solver's own limit for what the limit does not
# bound: the narrowing, the build, the Python re-check and the reasons, which
# grow with the plan rather than the budget. The same figure as the other
# routes (app.timing.BUILD_HEADROOM_SECONDS, one number for every route): past
# it, the request fails rather than pin a worker. The ceiling is the REQUEST's
# budget (it can ask for less) and the headroom; GET /api/v1/timing reports it
# for a request that asks for the deployment's.
_BUILD_HEADROOM_SECONDS = BUILD_HEADROOM_SECONDS


def route_limits(settings: Settings, search: ExamSearch | None = None) -> RouteLimits:
    """The exam planner's times for a request: ITS budget (it can ask for less) and the headroom, no probe."""
    return RouteLimits(budget_seconds(settings, search), 0.0, _BUILD_HEADROOM_SECONDS)


async def run_exam_solver(payload: PlanExamsRequest, settings: Settings) -> PlanExamsResponse:
    """Run the CPU-bound solve off the event loop with a hard ceiling."""
    solver = ExamSolver(settings)
    timeout = route_limits(settings, payload.search).ceiling_seconds

    def counted() -> PlanExamsResponse:
        # The thread's life is what is counted (app.solve_load), as the generator's is.
        with SOLVE_LOAD.running(OTHER, str(payload.request_id)):
            return solver.solve(payload)

    try:
        return await asyncio.wait_for(asyncio.to_thread(counted), timeout=timeout)
    except asyncio.TimeoutError:
        logger.error("exam_plan_timed_out", request_id=str(payload.request_id))
        raise SolverTimeoutError(
            "Exam planning timed out.", route="plan-exams", ceiling_seconds=timeout,
        ) from None


@router.post(
    "/plan-exams",
    response_model=PlanExamsResponse,
    status_code=status.HTTP_200_OK,
    summary="Place exams in time, rooms and invigilators, and say why one is left out",
    dependencies=[Depends(verify_api_key)],
)
async def plan_exams(
    payload: PlanExamsRequest,
    settings: Settings = Depends(get_app_settings),
) -> PlanExamsResponse:
    """Accept an anonymised exam plan and return where each exam is held."""
    logger.info(
        "exam_plan_requested",
        request_id=str(payload.request_id),
        exam_count=len(payload.exams),
        room_count=len(payload.rooms),
        teacher_count=len(payload.teachers),
    )

    response = await run_exam_solver(payload, settings)

    logger.info(
        "exam_plan_completed",
        request_id=str(response.request_id),
        status=response.status,
        placed_count=len(response.placed),
        unplaced_count=len(response.unplaced),
    )
    return response
