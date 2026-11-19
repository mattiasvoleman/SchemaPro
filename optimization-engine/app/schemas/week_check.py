"""Kontrollera veckan: the wire models of POST /api/v1/check-week.

The REQUEST is OptimizeScheduleRequest, byte for byte what Generera sends, so
the gateway builds the payload once (prepareSchedule) and asks either route
with it. Only the answer is new.

The answer says what the engine's quick checks found out about the week
BEFORE any timetable model is built, which is what Generera's own first
moments do (SchedulerSolver._prechecks) and what a school otherwise waits a
whole budget to be told. It can prove a week impossible and it can say a week
is tight; it can never say a week is possible, so an `OK` is read as "nothing
found", never as "a schedule exists" — `skipped` says which checks did not run.

Every name below is also listed by hand in tests/test_week_check.py and in the
gateway's src/optimization/ai-engine-contract.spec.ts. CamelModel forbids extra
fields, so change both lists in the commit that deploys the engine.
"""

from __future__ import annotations

from typing import Literal

from pydantic import UUID4, Field

from app.schemas.schedule import CamelModel, ConflictAnalysis

#: `IMPOSSIBLE`: a count or the year's week load PROVES no timetable exists,
#: and `conflicts` is the analysis Generera would have answered INFEASIBLE with.
#: `TIGHT`: nothing is proved impossible, but a year needs at least
#: SchedulerSolver.TIGHT_WEEK_LOAD of the time its frames offer.
#: `OK`: neither.
WeekCheckVerdict = Literal["OK", "TIGHT", "IMPOSSIBLE"]

#: What the check did not run, by name, so that a screen can say it:
#: `LUNCH_STAGE` always (it is a model of its own, up to ten seconds);
#: `PLACEMENTS_PROBE` on an impossible week that carries förläggningar or fästa
#: lektioner (Generera would ask whether releasing them lays it, with a solve);
#: `WEEK_LOAD_DEADLINE` when the week load's seconds ran out before every year
#: was counted, so a year without a row is NOT counted.
WeekCheckSkipped = Literal["LUNCH_STAGE", "PLACEMENTS_PROBE", "WEEK_LOAD_DEADLINE"]


class WeekCheckYear(CamelModel):
    """One year's least week against what its frames offer (week_load.StageLoad)."""

    #: The year, or None for the entries whose years are unknown.
    year: int | None = None
    demand_minutes: int = Field(alias="demandMinutes", ge=0)
    capacity_minutes: int = Field(alias="capacityMinutes", ge=0)
    #: Whole percent, rounded down, as TIGHT_WEEK_LOAD says it.
    percent: int = Field(ge=0)
    #: The bound is proved above the supply: no timetable exists.
    over: bool


class WeekCheckResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    verdict: WeekCheckVerdict
    #: The years at or above the tight threshold, heaviest first. A year under
    #: it has no row, and nothing is said of it.
    years: list[WeekCheckYear]
    conflicts: ConflictAnalysis | None = None
    skipped: list[WeekCheckSkipped]
    #: Wall-clock milliseconds the check took in the engine.
    elapsed_ms: int = Field(alias="elapsedMs", ge=0)
