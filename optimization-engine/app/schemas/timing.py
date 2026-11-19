from __future__ import annotations

from pydantic import Field

from app.schemas.schedule import CamelModel


class RouteTiming(CamelModel):
    """What one route of the engine may take, for a plain request (app.timing)."""

    budget_seconds: float = Field(alias="budgetSeconds")
    #: What the route spends AFTER its budget: the generator's timeout probe.
    #: Zero for a route with no step after its budget.
    probe_seconds: float = Field(alias="probeSeconds")
    #: What the route keeps for the work before the search's clock starts.
    headroom_seconds: float = Field(alias="headroomSeconds")
    #: Budget, probe and headroom: after it the route answers 503
    #: (SOLVER_TIMEOUT) instead of waiting for its solve.
    ceiling_seconds: float = Field(alias="ceilingSeconds")


class EngineTiming(CamelModel):
    """The engine's times, said by the engine (GET /api/v1/timing).

    Read by the API so that its wait for the engine follows what the engine
    needs instead of a second number set by hand. An engine older than this
    answers 404 and the API falls back to the constants it had.
    """

    version: int = 1
    #: What this engine can be sent that an older one refuses. "deadlineSeconds":
    #: OptimizeScheduleRequest.deadlineSeconds.
    capabilities: list[str]
    #: Between a caller's sending a request and the route's taking it. A caller
    #: that waits D seconds is answered by D minus this at the latest.
    transfer_margin_seconds: float = Field(alias="transferMarginSeconds")
    #: Keyed by the last segment of the route's path.
    routes: dict[str, RouteTiming]
