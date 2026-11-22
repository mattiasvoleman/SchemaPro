"""Åtgärdsförslag vid vägran: what a school could change so that its week can be laid, and what the engine has shown of it.

A WEEK THE ENGINE REFUSED, OR RAN OUT OF TIME ON, HAS A REASON A SCHOOL CAN OFTEN
ACT ON: a teacher's cap of minutes a day, a part-timer's days, a subject's spread
or a room it is locked to. Bästa möjliga schema (app/solver/relaxation.py) already
places such a week by letting those five rules give way, and says how far each did
(`deviations`) and the value it would have needed. This module reads that answer
as a list of changes, and then asks the one question nothing else asks: does the
STRICT model, with exactly those changes applied, accept the timetable the search
found?

NOTHING HERE IS A MODEL. The search is a Bästa möjliga schema solve, run by
SchedulerSolver.solve exactly as a candidate run is; the check builds the strict
model of the changed week and gives it the timetable as a warm start. This file
reads the answer, writes changes and asks; relaxation.py and scheduler_solver.py
are not changed.

WHAT A CHANGE IS WORTH, THE FOUR THINGS IT DOES NOT SAY. They are why `proof` has
three values and not a yes:

1. IT IS ABOUT THE WHOLE LIST. The timetable breaks every rule of the list at
   once, so the check applies every change at once. A list of several is shown to
   work TOGETHER (SOLVED_TOGETHER); one change of it alone is not shown to
   suffice. Only a list of one is SOLVED.
2. IT IS NOT THE CHEAPEST. The search's first timetable is not the best one: on a
   week the strict solver lays cleanly, the priced search came back with five
   deviations at the budget's end (docs/verification-baseline.md, Bästa möjliga
   schema). The list is what the engine found, never the least a school could do.
3. IT IS A TIMETABLE THAT EXISTS, NOT ONE THE NEXT GENERERA FINDS. The check hands
   the strict model the timetable as a hint. A Generera has no such hint and may
   still run out of time on the changed week.
4. A CHECK THAT DID NOT FINISH IS NOT A YES. It drops the whole list to MAY_HELP.

THE PRICE OF A CHANGE is the engine's own (relaxation.RELAXABLE_RULES): the weight
of a unit times the units of the deviation lines it removes, which is what the
search minimised, so the order is one a reader can be told in one sentence. The
cap is priced per five minutes, as `Relax` prices it, on every grid.

THE NAMES ARE NOT HERE. A change carries the ids the request carried, as a
deviation line does: the work rule of a cap, the post of its days, the
requirements, the rooms. The gateway turns them back into the school's own words.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from ortools.sat.python import cp_model

from app.config import Settings
from app.exceptions import InvalidScheduleInputError, SolverBuildError
from app.logging_config import get_logger
from app.schemas.schedule import (
    AnonymousRequirement,
    AnonymousRoomPreference,
    AnonymousTeacherDayLimit,
    ConflictDetail,
    OptimizeScheduleRequest,
    PreviousLesson,
    Relaxation,
    ScheduledLesson,
    SearchOptions,
)
from app.schemas.suggestions import (
    SuggestChangesResponse,
    SuggestedChange,
    SuggestedRule,
    SuggestionProof,
)
from app.solver.relaxation import (
    CODE,
    RELAXABLE_RULES,
    WEIGHT,
    _held_weekdays,
    _teachers_on,
    _weeks_of,
    prices_anything,
)
from app.solver.scheduler_solver import (
    SchedulerSolver,
    _rule_reaches,
    _solve_guarded,
    _span_width,
)
from app.timing import ANSWER_SLACK_SECONDS, BUILD_HEADROOM_SECONDS, SOLVE_OVERRUN_SECONDS, RouteLimits

logger = get_logger(__name__)

#: The seconds the search is given when the request names none, and the seconds the
#: strict model is given to accept its timetable. 60 s is a third of production's
#: budget for a Generera (180 s) and finds a first timetable on every week measured
#: (the strict solver's 20 s took 2.7 s priced, docs/verification-baseline.md); the
#: check pins every start of a timetable that is already there.
DEFAULT_SEARCH_SECONDS = 60
VERIFY_SECONDS = 30
#: Under this a check is not started: a build and a solve cannot answer in less, and a
#: check that stops at the clock says nothing.
MIN_VERIFY_SECONDS = 5

#: The cap's price is per five minutes (relaxation._CAP_BASE_MINUTES, pinned by a test).
_CAP_UNIT_MINUTES = 5

_RULE_OF_CODE: dict[str, SuggestedRule] = {code: name for name, code in CODE.items()}  # type: ignore[misc]
_RULE_ORDER: dict[str, int] = {rule.name: index for index, rule in enumerate(RELAXABLE_RULES)}


def route_limits(settings: Settings, search: SearchOptions | None = None) -> RouteLimits:
    """What this route may take: the search, the check, and the builds before each.

    The headroom counts two builds' worth (the search's models and the check's),
    as the generator's counts the builds before its search. No probe: nothing runs
    after the check.
    """
    budget = min(
        float(settings.solver_max_time_seconds),
        float(DEFAULT_SEARCH_SECONDS if search is None or search.max_seconds is None else search.max_seconds),
    )
    return RouteLimits(budget + VERIFY_SECONDS, 0.0, 2 * BUILD_HEADROOM_SECONDS)


# ---------------------------------------------------------------------------
# Deviations -> changes
# ---------------------------------------------------------------------------


@dataclass
class _Draft:
    """A change while its lines are being added up."""

    rule: SuggestedRule
    cost: int = 0
    current: int | None = None
    needed: int | None = None
    weekdays: set[int] = field(default_factory=set)
    requirement_ids: dict[UUID, None] = field(default_factory=dict)
    room_ids: dict[UUID, None] = field(default_factory=dict)
    resource_ids: dict[UUID, None] = field(default_factory=dict)

    def sort_key(self) -> tuple[int, int, tuple[str, ...]]:
        return (
            self.cost,
            _RULE_ORDER[self.rule],
            tuple(sorted(str(identity) for identity in (*self.resource_ids, *self.requirement_ids))),
        )

    def done(self, proof: SuggestionProof) -> SuggestedChange:
        return SuggestedChange(
            rule=self.rule,
            cost=self.cost,
            current=self.current,
            needed=self.needed,
            weekdays=sorted(self.weekdays),
            requirement_ids=list(self.requirement_ids),
            room_ids=list(self.room_ids),
            resource_ids=list(self.resource_ids),
            proof=proof,
        )


def _int(line: ConflictDetail, name: str) -> int:
    return int(line.params[name])


def _bigger(held: int | None, value: int) -> int:
    return value if held is None else max(held, value)


def changes_from(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    deviations: list[ConflictDetail],
    *,
    proof: SuggestionProof = "MAY_HELP",
) -> list[SuggestedChange]:
    """The changes the deviations of one timetable ask for, cheapest first.

    ONE CHANGE PER THING A SCHOOL EDITS, not one per line: a teacher's cap is one
    number, so every day it was breached on is one change whose `needed` is the
    largest of them; a part-timer's days likewise; a subject's cap or spread is the
    requirement's; and a room lock, which is a room rule of a subject (and a span of
    years), is ONE change however many of its classes were placed outside it. Every
    `needed` is the value for which the timetable the deviations were counted on
    holds the rule; the check below says whether the strict model agrees.

    A line of a code this module does not know (an engine with a sixth rule) is
    left out and logged: a change this reader cannot apply would be a change it cannot
    check, and one it cannot check is not said.
    """
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    work_limits = {limit.id: limit for limit in request.teacher_day_limits}
    drafts: dict[tuple, _Draft] = {}
    for line in deviations:
        rule = _RULE_OF_CODE.get(line.code)
        if rule is None:
            logger.warning("suggestion_unknown_deviation", code=line.code)
            continue
        if rule == "TEACHER_DAILY_CAP":
            work_rule = UUID(str(line.params["rule"]))
            draft = drafts.setdefault((rule, work_rule), _Draft(rule, resource_ids={work_rule: None}))
            draft.current = _int(line, "minutes")
            draft.needed = _bigger(draft.needed, _int(line, "needed"))
            draft.cost += _int(line, "over") * WEIGHT[rule] // _CAP_UNIT_MINUTES
            draft.weekdays.add(_int(line, "day"))
        elif rule == "TEACHER_WORK_DAYS":
            limit_id = UUID(str(line.params["limit"]))
            draft = drafts.setdefault((rule, limit_id), _Draft(rule, resource_ids={limit_id: None}))
            draft.current = _int(line, "days")
            draft.needed = _bigger(draft.needed, _int(line, "needed"))
            draft.cost += _int(line, "over") * WEIGHT[rule]
            limit = work_limits.get(limit_id)
            if limit is not None:
                draft.weekdays.update(_added_days(request, limit, lessons, _int(line, "over")))
        elif rule == "SUBJECT_PER_DAY":
            requirement_id = UUID(str(line.params["requirement"]))
            draft = drafts.setdefault((rule, requirement_id), _Draft(rule))
            draft.current = _int(line, "maxPerDay")
            draft.needed = _bigger(draft.needed, _int(line, "needed"))
            draft.cost += _int(line, "over") * WEIGHT[rule]
            draft.weekdays.add(_int(line, "day"))
        elif rule == "SUBJECT_DAYS_APART":
            requirement_id = UUID(str(line.params["requirement"]))
            draft = drafts.setdefault((rule, requirement_id), _Draft(rule))
            draft.current = _int(line, "minDaysBetween")
            draft.needed = _int(line, "needed")
            draft.cost += _int(line, "pairs") * WEIGHT[rule]
        else:
            requirement_id = UUID(str(line.params["requirement"]))
            requirement = by_requirement.get(requirement_id)
            tier = [] if requirement is None else _narrowest_locks(request, requirement)
            # One change per room rule of the tier, so every class a rule locks adds to it.
            key = (rule, tuple(sorted(str(preference.id) for preference in tier)) or str(requirement_id))
            draft = drafts.setdefault(key, _Draft(rule, resource_ids=dict.fromkeys(p.id for p in tier)))
            draft.cost += _int(line, "lessons") * WEIGHT[rule]
            draft.room_ids.update(dict.fromkeys(line.room_ids))
        draft.requirement_ids.update(dict.fromkeys(line.requirement_ids))
    return [draft.done(proof) for draft in sorted(drafts.values(), key=_Draft.sort_key)]


def _narrowest_locks(
    request: OptimizeScheduleRequest, requirement: AnonymousRequirement,
) -> list[AnonymousRoomPreference]:
    """The room locks of the narrowest tier that reaches `requirement`: the rules whose rooms it is held to.

    The same tier resolve_room_locks keeps (the narrowest span wins and equally narrow
    rules are alternatives), so what a school edits is what the engine read.
    """
    reaching = [
        preference
        for preference in request.room_preferences
        if preference.kind == "LOCK"
        and preference.subject_id == requirement.subject_id
        and _rule_reaches(preference, requirement)
    ]
    if not reaching:
        return []
    narrowest = min(_span_width(preference) for preference in reaching)
    return [preference for preference in reaching if _span_width(preference) == narrowest]


def _added_days(
    request: OptimizeScheduleRequest, limit: AnonymousTeacherDayLimit,
    lessons: list[ScheduledLesson], over: int,
) -> list[int]:
    """The weekdays a post is asked to take: the lightest days the lessons add, `over` of them.

    ONLY FOR A SCHOOL WITH ONE WEEK. With odd and even weeks, or periods, the days the
    post goes over its limit are not the same in each, and a weekday named for the
    worst of them would be named for a week the reader does not know: the change
    then says that the post needs a day more, and which day is the school's to read
    off the timetable.
    """
    weeks = _weeks_of(request)
    if len(weeks) != 1:
        return []
    held: set[int] = set().union(*_held_weekdays(limit, weeks[0]))
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    minutes: Counter[int] = Counter()
    for lesson in lessons:
        requirement = by_requirement.get(lesson.requirement_id)
        if requirement is None or limit.teacher_id not in _teachers_on(requirement, lesson):
            continue
        start = int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5])
        end = int(lesson.end_time[:2]) * 60 + int(lesson.end_time[3:5])
        minutes[lesson.day_of_week] += end - start
    added = sorted((day for day in minutes if day not in held), key=lambda day: (minutes[day], day))
    return sorted(added[:over])


# ---------------------------------------------------------------------------
# Changes -> the changed week
# ---------------------------------------------------------------------------


def apply_changes(
    request: OptimizeScheduleRequest, changes: list[SuggestedChange],
) -> OptimizeScheduleRequest:
    """The same week with every change made: the STRICT week a school would have after editing.

    No `relaxation` and no `search`: it is the request Generera would send once the
    school had made the changes by hand. A copy; `request` is not written to.
    """
    caps = {
        change.resource_ids[0]: change.needed
        for change in changes
        if change.rule == "TEACHER_DAILY_CAP" and change.needed is not None
    }
    days = {
        change.resource_ids[0]: change.needed
        for change in changes
        if change.rule == "TEACHER_WORK_DAYS" and change.needed is not None
    }
    per_day = {
        change.requirement_ids[0]: change.needed
        for change in changes
        if change.rule == "SUBJECT_PER_DAY" and change.needed is not None
    }
    apart = {
        change.requirement_ids[0]: change.needed
        for change in changes
        if change.rule == "SUBJECT_DAYS_APART" and change.needed is not None
    }
    update: dict[str, object] = {"relaxation": None, "search": None}
    if caps:
        update["teacher_work_rules"] = [
            rule.model_copy(update={"max_teaching_minutes_per_day": caps[rule.id]}) if rule.id in caps else rule
            for rule in request.teacher_work_rules
        ]
    if days:
        update["teacher_day_limits"] = [
            limit.model_copy(update={"max_teaching_days_per_week": min(6, max(1, days[limit.id]))})
            if limit.id in days
            else limit
            for limit in request.teacher_day_limits
        ]
    if per_day or apart:
        update["requirements"] = [
            requirement.model_copy(update={
                **({"max_lessons_per_day": min(20, max(1, per_day[requirement.id]))} if requirement.id in per_day else {}),
                # A spread of one day is no rule: the field starts at two.
                **(
                    {"min_days_between": apart[requirement.id] if apart[requirement.id] >= 2 else None}
                    if requirement.id in apart
                    else {}
                ),
            })
            if requirement.id in per_day or requirement.id in apart
            else requirement
            for requirement in request.requirements
        ]
    locks = _room_additions(request, changes)
    if locks:
        update["room_preferences"] = [*request.room_preferences, *locks]
    return request.model_copy(update=update)


def _room_additions(
    request: OptimizeScheduleRequest, changes: list[SuggestedChange],
) -> list[AnonymousRoomPreference]:
    """A room rule of its own for each rule of a lock that gave way: the rooms the lessons were placed in.

    Equally narrow rules are alternatives and their rooms union
    (resolve_room_locks), so a rule with the same subject and years and the missing
    rooms widens the lock exactly as editing the rule's rooms would, and it works
    for a rule that names a room TYPE, whose own list of rooms the engine does not read.
    """
    by_id = {preference.id: preference for preference in request.room_preferences}
    additions: list[AnonymousRoomPreference] = []
    for change in changes:
        if change.rule != "ROOM_LOCK" or not change.resource_ids:
            continue
        rule = by_id.get(change.resource_ids[0])
        if rule is None:
            continue
        additions.append(AnonymousRoomPreference(
            id=uuid4(),
            subject_id=rule.subject_id,
            room_ids=list(change.room_ids),
            kind="LOCK",
            min_grade_level=rule.min_grade_level,
            max_grade_level=rule.max_grade_level,
        ))
    return additions


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def strict_accepts(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    settings: Settings,
    *,
    seconds: float,
    workers: int | None = None,
) -> bool:
    """Whether the strict model of `request` finds a timetable within `seconds`, warm-started from `lessons`.

    THE STRICT BUILD, NO RELAXATION: the rules of the changed week are rows again
    and a timetable that breaks one is not a solution. The lessons are a hint, in
    the pairing a warm start has always had (_previous_hints), and the solve stops at
    its first solution: a hint that holds is accepted at once, one that does not
    holds the solve for what it needs to repair it, and a solution found that way is
    as good a proof of the changed week as the hint itself.

    A build the engine refuses, a solve that decides nothing in time and a model
    that is infeasible are all "not accepted": the caller says "may help" and
    logs. None of them is an error for the school.
    """
    solver = SchedulerSolver(settings)
    try:
        model, _, decisions, *_ = solver._build_model(request, use_assumptions=False, include_objective=False)  # noqa: SLF001
    except (InvalidScheduleInputError, SolverBuildError) as refusal:
        logger.warning("suggestion_check_refused_build", reason=str(refusal))
        return False
    previous = [
        PreviousLesson(
            requirement_id=lesson.requirement_id,
            day_of_week=lesson.day_of_week,
            start_time=lesson.start_time,
        )
        for lesson in lessons
    ]
    solver._hint_previous_lessons(model, decisions, previous)  # noqa: SLF001
    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = seconds
    cp.parameters.stop_after_first_solution = True
    if workers is not None:
        cp.parameters.num_workers = workers
    status = _solve_guarded(cp, model, what="the suggestion check", request_id=request.request_id)
    return status in (cp_model.OPTIMAL, cp_model.FEASIBLE)


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def suggest_changes(
    request: OptimizeScheduleRequest,
    settings: Settings,
    *,
    ceiling_seconds: float,
) -> SuggestChangesResponse:
    """Search for a timetable that lets the five rules give way, read the changes off it, check them.

    `ceiling_seconds` is the wall-clock after which the route stops waiting (route_limits,
    shortened by the caller's deadline): the check is given what is left of it, and not
    started when that is less than MIN_VERIFY_SECONDS plus a build.
    """
    entered = time.monotonic()
    own = request.search
    seconds = int(min(
        settings.solver_max_time_seconds,
        DEFAULT_SEARCH_SECONDS if own is None or own.max_seconds is None else own.max_seconds,
    ))
    workers = None if own is None else own.workers
    seed = None if own is None else own.seed
    search = SearchOptions(max_seconds=max(5, seconds), probes=False, workers=workers, seed=seed)
    relaxed = request.model_copy(update={"relaxation": Relaxation(mode="BEST_EFFORT"), "search": search})
    response = SchedulerSolver(settings).solve(relaxed)

    def elapsed() -> int:
        return round((time.monotonic() - entered) * 1000)

    if response.status == "INFEASIBLE":
        return SuggestChangesResponse(
            request_id=request.request_id, verdict="HARD_REFUSAL", search_seconds=seconds,
            elapsed_ms=elapsed(), conflicts=response.conflicts,
        )
    if response.status == "TIMEOUT" or not response.lessons:
        return SuggestChangesResponse(
            request_id=request.request_id, verdict="NOT_FOUND", search_seconds=seconds,
            elapsed_ms=elapsed(),
        )

    deviations = response.deviations or []
    changes = changes_from(request, response.lessons, deviations)
    # A week with nothing on the list to relax was solved strictly by the search itself.
    already_strict = not prices_anything(request)
    verified = already_strict
    verify_seconds: float | None = None
    if not already_strict:
        left = ceiling_seconds - (time.monotonic() - entered) - ANSWER_SLACK_SECONDS - SOLVE_OVERRUN_SECONDS
        # The check's own build comes first and is not under its clock.
        available = min(float(VERIFY_SECONDS), left - BUILD_HEADROOM_SECONDS)
        if available >= MIN_VERIFY_SECONDS:
            started = time.monotonic()
            verified = strict_accepts(
                apply_changes(request, changes), response.lessons, settings,
                seconds=available, workers=workers,
            )
            verify_seconds = round(time.monotonic() - started, 1)
            if not verified:
                logger.warning(
                    "suggestion_check_not_accepted",
                    request_id=str(request.request_id), changes=len(changes),
                    verify_seconds=verify_seconds,
                )
        else:
            logger.warning("suggestion_check_skipped", request_id=str(request.request_id), left=round(left, 1))

    proof: SuggestionProof = (
        "MAY_HELP" if not verified else "SOLVED" if len(changes) == 1 else "SOLVED_TOGETHER"
    )
    return SuggestChangesResponse(
        request_id=request.request_id,
        verdict="CHANGES" if changes else "SOLVABLE_AS_IS",
        changes=[change.model_copy(update={"proof": proof}) for change in changes],
        verified=verified,
        search_seconds=seconds,
        verify_seconds=verify_seconds,
        elapsed_ms=elapsed(),
    )
