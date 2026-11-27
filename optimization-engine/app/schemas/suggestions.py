"""Åtgärdsförslag vid vägran: the wire models of POST /api/v1/suggest-changes.

The REQUEST is OptimizeScheduleRequest, byte for byte what Generera sends, so the
gateway builds the payload once and asks either route with it (as it does for
/check-week). `search.maxSeconds` is the search's budget (60 s when absent) and
`search.workers` the workers it may use; `relaxation` is ignored, the route asks
for Bästa möjliga schema itself. Only the answer is new.

THE ANSWER IS A LIST OF CHANGES A SCHOOL COULD MAKE and how well each is known
(`proof`). It is never a timetable: nothing here is placed, applied or stored by
the engine. A change names the rule it relaxes, the value the rule has today
(`current`) and the value this very timetable needs (`needed`), by the ANONYMOUS
ids the request carried: no teacher, subject or room id of the school's own and
no name is in it, and the gateway puts the names back, as it does for a
`deviations` line.

WHAT `proof` MEANS, and the only things it may mean:

- `SOLVED`: the engine solved the week with exactly this one change. It is the
  whole list (a list of one), and the strict model accepted the timetable the
  search found, with the change applied.
- `SOLVED_TOGETHER`: the engine solved the week with exactly the changes of the
  list, together. One of them alone is NOT shown to be enough.
- `MAY_HELP`: a timetable exists that breaks the rule this much (the search found
  it), but the strict model's check of it did not finish. It says what the
  search measured and not that the change is enough.

Every name below is also listed by hand in tests/test_suggest_changes.py and, from
the gateway's part of this phase, in src/optimization/ai-engine-contract.spec.ts.
CamelModel forbids extra fields, so change both lists in the commit that deploys the
engine.
"""

from __future__ import annotations

from typing import Literal

from pydantic import UUID4, Field

from app.schemas.schedule import CamelModel, ConflictAnalysis, TimeoutReport

#: The five rules that may give way (app/solver/relaxation.py RELAXABLE_RULES),
#: by the same names, mildest first.
SuggestedRule = Literal[
    "SUBJECT_DAYS_APART",
    "SUBJECT_PER_DAY",
    "ROOM_LOCK",
    "TEACHER_DAILY_CAP",
    "TEACHER_WORK_DAYS",
]

SuggestionProof = Literal["SOLVED", "SOLVED_TOGETHER", "MAY_HELP"]

#: `CHANGES`: the search placed the week by letting the rules of `changes` give way.
#: `SOLVABLE_AS_IS`: the search placed the week and nothing gave way, AND THE STRICT
#: MODEL ACCEPTED THE TIMETABLE (`verified` is always true here): the strict week has
#: a timetable, whatever its own run said (a TIMEOUT searched too short).
#: `NOT_FOUND`: the search found no timetable in its time, even with the five
#: rules free to give way, or found one on which nothing gave way that the strict
#: model was not shown to accept (no time for the check). That is not a proof
#: that none exists.
#: `HARD_REFUSAL`: a rule that never gives way refuses the week (the strict
#: explanation is in `conflicts`); no change of the five can help.
SuggestChangesVerdict = Literal["CHANGES", "SOLVABLE_AS_IS", "NOT_FOUND", "HARD_REFUSAL"]


class SuggestedChange(CamelModel):
    """One rule that gave way in the timetable the search found, and what it would need to hold."""

    rule: SuggestedRule
    #: What it costs the school, in the engine's own price (relaxation.RELAXABLE_RULES:
    #: the weight of one unit times the units this change removes). The order of the
    #: list is this, cheapest first, and only means something against another price
    #: of the same answer.
    cost: int = Field(ge=0)
    #: The value the rule has today: the cap in minutes, the days of the post, the
    #: subject's lessons a day, its days apart. None for a room lock, which has none.
    current: int | None = None
    #: The value the timetable needs: what the rule would have to be set to for this very
    #: timetable to hold. After the engine has tried to lower it (suggestions.refine) it is the LEAST VALUE IT FOUND A TIMETABLE FOR, with
    #: the other changes of the list as they then were: not the least value any timetable needs unless `needed_is_least` says it was
    #: proved.
    needed: int | None = None
    #: Whether the value below `needed` (one step: five minutes for a cap, one day or one lesson otherwise) was PROVED to hold no timetable
    #: with the rest of the list as it is: the strict model answered INFEASIBLE for it. True says `needed` is the least; False that the
    #: engine tried the lower value and did not finish; None that it did not try (a room lock has no number, the check had no time, the
    #: list was not verified, or the value was already as low as it can go). A caller that reads only `needed` reads what it always did.
    #: OMITTED WHERE IT IS NONE, so a change the engine did not try to lower is the bytes it always was.
    needed_is_least: bool | None = Field(default=None, alias="neededIsLeast", exclude_if=lambda value: value is None)
    #: The ISO weekdays the change is about, where the engine can say them (the days a
    #: part-time post is asked to take, the days a subject goes over its cap).
    weekdays: list[int] = Field(default_factory=list)
    #: The requirements the change is about (the lessons that make the rule give way).
    requirement_ids: list[UUID4] = Field(default_factory=list, alias="requirementIds")
    #: The rooms a locked subject was placed in: the rooms the lock would have to allow.
    room_ids: list[UUID4] = Field(default_factory=list, alias="roomIds")
    #: The rule's own anonymous id: the work rule of a cap, the post of its days, the
    #: room rules (of the narrowest tier that reaches the requirement) of a lock.
    resource_ids: list[UUID4] = Field(default_factory=list, alias="resourceIds")
    proof: SuggestionProof


class SuggestChangesResponse(CamelModel):
    request_id: UUID4 = Field(alias="requestId")
    verdict: SuggestChangesVerdict
    #: Ranked: the cheapest change first. Empty unless the verdict is CHANGES.
    changes: list[SuggestedChange] = Field(default_factory=list)
    #: The strict model accepted the search's timetable with every change of the list
    #: applied (also for SOLVABLE_AS_IS: with none). False says it was not checked or the
    #: check did not finish, and then no change is above MAY_HELP.
    verified: bool = False
    #: Seconds the search for the timetable was given, and the check's, as the engine ran them. For NOT_FOUND it is the
    #: budget the search REALLY had (a caller that waits less than the engine's budget leaves it less, down to none); for the
    #: other verdicts the seconds it was asked for.
    search_seconds: float = Field(alias="searchSeconds", ge=0)
    verify_seconds: float | None = Field(default=None, alias="verifySeconds", ge=0)
    #: Wall-clock milliseconds the whole run took in the engine.
    elapsed_ms: int = Field(alias="elapsedMs", ge=0)
    #: The strict explanation, for HARD_REFUSAL only.
    conflicts: ConflictAnalysis | None = None
    #: Where the search's time went and what each search had done (M2's account), for NOT_FOUND where the search itself ran out of its
    #: time (G6b, g384-L-4): "found nothing in 60 s" does not say whether the minute was the builds or the search, and the account does.
    #: OMITTED WHERE IT IS NONE, so every other answer is the bytes it always was.
    report: TimeoutReport | None = Field(default=None, exclude_if=lambda value: value is None)
