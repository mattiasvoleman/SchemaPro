"""Lärarval: the wire models of POST /api/v1/week-bounds.

The REQUEST is OptimizeScheduleRequest and what Generera sends, plus three
optional fields that say what to count (`years`, `cutoffs`, `seconds`). The
gateway builds one payload (prepareSchedule), lays each candidate choice of
teachers over it, and asks this route for each candidate's weeks.

The answer is FIGURES, not a verdict: each year's exact least week for each real
week (SchedulerSolver.week_bounds says why that is not what /check-week gives),
and for each figure whether it is exact. A week one of the quick arithmetic counts
refuses has no figures and a `refusal`. Every name below is also listed by hand in
tests/test_week_bounds.py and in the gateway's src/optimization/week-bounds-contract.spec.ts.
CamelModel forbids extra fields, so change both lists in the commit that deploys the engine.

THE NAMES ARE THIS MODULE'S OWN (`WeekBounds*`): the OpenAPI document names a
schema by its class, and a second class with the name of one in another module
renames both.
"""

from __future__ import annotations

from typing import Literal

from pydantic import UUID4, Field

from app.schemas import schedule as _schedule
from app.schemas.schedule import CamelModel, OptimizeScheduleRequest

#: The longest one count runs: the same ceiling as the week check, and the route's own answer after it.
MAX_BOUNDS_SECONDS = 30.0


class WeekBoundsCutoff(CamelModel):
    """Stop counting a year's week once its proved lower bound passes this share of the week's supply.

    The share is `demandMinutes / capacityMinutes`: the tightest week the caller already has for the year,
    so that a candidate whose bound is proved above it is known to make the year's tightest week worse.
    """

    year: int = Field(ge=0, le=20)
    demand_minutes: int = Field(alias="demandMinutes", ge=0, le=1_000_000)
    capacity_minutes: int = Field(alias="capacityMinutes", ge=1, le=1_000_000)


class WeekBoundsRequest(OptimizeScheduleRequest):
    """What Generera sends, and which of it to count."""

    #: The years to count (the payload's own numbering); every year when left out.
    years: list[int] | None = Field(default=None, max_length=16)
    #: Per year: stop at a week above this share of its supply. The figure is then `cutoff` and only a lower bound.
    cutoffs: list[WeekBoundsCutoff] = Field(default_factory=list, max_length=16)
    #: The whole count's seconds, from the request's arrival. A figure the seconds cut is not exact.
    seconds: float = Field(default=25.0, gt=0, le=MAX_BOUNDS_SECONDS)


# The request's inherited fields name types of schedule.py as strings (`from __future__ import annotations`), and a
# subclass in another module is built in this module's names: told where to look, or the class is never complete.
WeekBoundsRequest.model_rebuild(_types_namespace=vars(_schedule))


class WeekBoundsRow(CamelModel):
    """One year's least week in one real week."""

    year: int | None = None
    #: The period the week is in, counted from 0, and None for a year without periods.
    period: int | None = None
    #: ODD_WEEKS or EVEN_WEEKS for a week of one parity, None for a week of both (and for a school without alternating weeks).
    parity: Literal["ODD_WEEKS", "EVEN_WEEKS"] | None = None
    #: The proved lower bound, in minutes rounded up; the exact value when `converged`.
    demand_minutes: int = Field(alias="demandMinutes", ge=0)
    capacity_minutes: int = Field(alias="capacityMinutes", ge=0)
    #: The bound is above the supply: no timetable exists in this week.
    over: bool
    #: Every pricing step of the count was proved and nothing stopped it: `demandMinutes` is the exact value.
    converged: bool
    #: The count was stopped because the bound passed the request's cutoff for the year: only "above the cutoff".
    cutoff: bool


class WeekBoundsRefusal(CamelModel):
    """The quick count that refused the week, by the code and values the week check names it with."""

    code: str
    params: dict[str, str | int | float] = Field(default_factory=dict)


class WeekBoundsResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    #: The real weeks of the year (each period in each parity it has lessons in).
    weeks_total: int = Field(alias="weeksTotal", ge=0)
    #: How many of them were counted: the heaviest, up to the engine's cap. A figure of fewer weeks than exist ranks nothing.
    weeks_counted: int = Field(alias="weeksCounted", ge=0)
    #: A row for each year asked for that was reached in each week counted. A missing row is a year not counted.
    rows: list[WeekBoundsRow]
    refusal: WeekBoundsRefusal | None = None
    #: The seconds ran out: some year or week may have no row.
    deadline_hit: bool = Field(alias="deadlineHit")
    elapsed_ms: int = Field(alias="elapsedMs", ge=0)
