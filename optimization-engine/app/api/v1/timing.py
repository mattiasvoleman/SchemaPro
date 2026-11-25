from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.v1 import exams, optimize, rooms, staffing
from app.config import Settings
from app.dependencies import get_app_settings, verify_api_key
from app.schemas.timing import EngineTiming, RouteTiming
from app.timing import TRANSFER_MARGIN_SECONDS, RouteLimits, generation_limits

router = APIRouter(prefix="/api/v1", tags=["timing"])

#: What this engine can be sent that an older one refuses (EngineTiming.capabilities). `startLessons` (M8, PR 4) is a
#: field of the generation request: an older engine answers it with a 422, extra_forbidden at ['body', 'startLessons'].
CAPABILITIES = ["deadlineSeconds", "startLessons"]


def engine_timing(settings: Settings) -> EngineTiming:
    """The times of every route for a plain request, built from the routes' OWN limits.

    Not a second formula: each route waits by a RouteLimits it builds (its
    module's route_limits, and generation_limits for the generator), and this
    reports those same objects, so what it says is the number that slams the
    door. A route's headroom is its module's own, which is the one a test
    shortens, so the report follows it too.
    """
    limits: dict[str, RouteLimits] = {
        "optimize": generation_limits(
            settings, headroom_seconds=optimize._SOLVE_BUILD_HEADROOM_SECONDS,
        ),
        "optimize-rooms": rooms.route_limits(settings),
        "staff": staffing.route_limits(settings),
        "plan-exams": exams.route_limits(settings),
    }
    return EngineTiming(
        capabilities=list(CAPABILITIES),
        transfer_margin_seconds=TRANSFER_MARGIN_SECONDS,
        routes={
            name: RouteTiming(
                budget_seconds=route.budget_seconds,
                probe_seconds=route.probe_seconds,
                headroom_seconds=route.headroom_seconds,
                ceiling_seconds=route.ceiling_seconds,
            )
            for name, route in limits.items()
        },
    )


@router.get(
    "/timing",
    response_model=EngineTiming,
    status_code=status.HTTP_200_OK,
    summary="How long each route may take: its budget, its probe and its ceiling",
    dependencies=[Depends(verify_api_key)],
)
async def timing(settings: Settings = Depends(get_app_settings)) -> EngineTiming:
    """What the API reads, instead of a second number set by hand, to know how long to wait.

    For a plain request: no `search`, no `deadlineSeconds`. A request that
    carries either has a ceiling of its own (optimize.solve_ceiling_seconds).
    """
    return engine_timing(settings)
