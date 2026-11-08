"""Bästa möjliga schema: the rules that may give way, and the report of how far they did.

TWO MODES, ONE ENGINE. A request without `relaxation` is solved exactly as it
always was: every rule below is a hard row, and a week that cannot hold them is
refused by name with nothing placed. A request with `relaxation.mode ==
"BEST_EFFORT"` is solved against the same week with ONE list of rules turned
from rows into prices (RELAXABLE_RULES, below), and answered with a timetable
and the list of what gave way (`deviations`). Everything not on the list stays
hard, in both modes, and is refused by name in both.

WHAT MAY GIVE WAY IS ONE LIST, IN ONE PLACE, AND THE LIST IS SHORT. Each rule
was tried against the same three questions before it went in:

1. Is it the SCHOOL'S OWN rule about how a week is shaped, and not a fact of the
   building or of the law? A teacher's cap of minutes a day, a part-timer's
   days, "no two idrott lessons in a row" and "matte in the matte-rooms" are
   things a schemaläggare already breaks by hand, with a warning beside the
   edit (master-lessons.service.ts), because the school wrote them.
2. Does a timetable that breaks it still TEACH what the timplan owes? Yes for
   all five: the same lessons, of the same lengths, are held. That is what
   keeps the lesson lengths off the list (below).
3. Can its breach be NAMED, MEASURED AND UNDONE by a person? Each of the five
   is a number a school can raise (the cap, the post's days, the per-day cap,
   the days apart) or a room it can open.

NEVER, IN EITHER MODE (HARD_RULES): a teacher, class, pupil or room booked
twice; a lesson outside the school's frame times; the walk between two sites.
They are what makes a timetable a timetable and not a wish list; no price, however
high, makes "Anna in two rooms at once" something a school can accept. The
teacher's own lunch and night's rest are hard too: they are the working-time
law's, not the school's taste, and the same goes for a teacher marked
unavailable (another employer, a leave): unavailable is a fact and not a wish.

CANDIDATES ARGUED OUT, so the next reader does not have to find out again:

- LESSON LENGTHS (`lessonLengths`, [80, 40]): shortening a lesson delivers
  fewer minutes than the timplan owes, which is the guaranteed teaching time
  and not the school's taste; and splitting 80 into 40 + 40 keeps the minutes
  but changes the NUMBER of lessons of a requirement, which every consumer of
  the answer (the gateway's apply, the spread, the previous-lesson hint, the
  timplan credits) counts. Hard. A candidate for a later round with its own
  contract.
- HÅLTIMMEGRÄNSER: there is no hard rule to give way. The teachers' gaps
  (`teacherGap`) and the pupils' (`pupilGaps`) are already prices in the
  objective and have never refused a week; what refuses a week there is the
  lessons not fitting between the locks and the frames (_lesson_gaps_verdict),
  which is arithmetic on hard rules.
- A TEACHER'S FREE-DAY WISH (`preferredFreeDay`) and the stretch of teaching
  (`maxConsecutiveTeachingMinutes`) are already soft; nothing changes for them.
- THE GROUP'S OWN DAILY CAP (`maxLessonsPerDayPerGroup`): it is the pupils'
  school day, shared by every class of the school, and it is what the frame
  times and the lunch are counted against. Hard.

WHAT A PRICE MEANS HERE. Each unit of a deviation costs `weight`; the sum is
multiplied by a number larger than anything the soft objective can reach
(`dominating_scale`), so the solver breaks a rule only when no timetable
exists without breaking it, and then breaks the least it can. The weights are
the ORDER the rules give way in: the mildest first (the days apart, then the
per-day cap, then a room, then a teacher's minutes, and last a day a part-timer
does not have). They are not lexicographic — one extra post day is worth about
thirty lessons in the wrong room — because a strict ladder would ask a school to
accept thirty small breaches before one larger one, which is not the order
anybody would choose by hand.

THE ORDER HOLDS FOR EVERY LESSON LENGTH. The cap is priced per five minutes and
the others per unit, so a cap breached by one whole lesson costs more the longer
the lesson, and a weight that puts the cap after a room for an hour lesson puts
it BEFORE the room for a 40-minute one (4 per five minutes: 32 against 40; found
by the review of #285). The weights below are therefore worked from the two
ends of the lesson lengths the product allows (15 to 240 minutes), and
tests/test_best_effort.py walks every length and keeps them worked:

- the cap must cost more than a room for the SHORTEST lesson: 15 minutes is
  three slots, 3 x 14 = 42 > 40 (13 gives 39 and breaks it);
- a post's extra day must cost more than the cap for a whole teaching day: seven
  hours is 84 slots, 84 x 14 = 1 176 < 1 200.

THE REPORT IS COUNTED IN PYTHON ON THE TIMETABLE THAT CAME BACK, not read off
the slack variables: the numbers a school reads are then facts about the
timetable it holds, and the model cannot misreport them. (The slack is a
means; the lessons are the answer.)
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from ortools.sat.python import cp_model

from app.schemas.schedule import (
    AnonymousRequirement,
    ConflictDetail,
    FixedLesson,
    OptimizeScheduleRequest,
    ScheduledLesson,
)
from app.solver.weeks import WEEKS, meet

if TYPE_CHECKING:
    from collections.abc import Callable

    from app.schemas.schedule import AnonymousRoom, WeekParity


@dataclass(frozen=True)
class RelaxableRule:
    """One rule that may give way, and what one unit of its breach costs."""

    #: Stable name. The key of WEIGHT and of every test that walks the list.
    name: str
    #: The sentence a breach is reported under (app/messages.py).
    code: str
    #: What the weight counts, for a reader of the code.
    unit: str
    #: Cost of one unit before it is scaled above every soft rule.
    weight: int
    #: Why it is on the list: the argument, once.
    reason: str


#: THE LIST. Mildest first; the order is the order the rules give way in, and
#: the test pins the weights ascending. Adding a rule here without a builder
#: that prices it is caught by tests/test_best_effort.py, which walks the list.
RELAXABLE_RULES: tuple[RelaxableRule, ...] = (
    RelaxableRule(
        "SUBJECT_DAYS_APART",
        "DEVIATION_SUBJECT_DAYS_APART",
        "two weekdays with lessons of the subject closer than the rule allows",
        10,
        "A spacing the school prefers for the subject; nobody's working "
        "conditions or the lessons' content change when it is broken.",
    ),
    RelaxableRule(
        "SUBJECT_PER_DAY",
        "DEVIATION_SUBJECT_PER_DAY",
        "lesson over the subject's cap for a weekday",
        20,
        "Two lessons of one subject on a day: milder than a room or a "
        "teacher's hours, worse than a spacing.",
    ),
    RelaxableRule(
        "ROOM_LOCK",
        "DEVIATION_ROOM_LOCK",
        "lesson outside the rooms the subject is locked to",
        40,
        "A room rule of the school's, not a physical requirement: a "
        "requirement's own room type (requiredRoomType) stays hard.",
    ),
    RelaxableRule(
        "TEACHER_DAILY_CAP",
        "DEVIATION_TEACHER_DAILY_CAP",
        "five minutes of teaching over the teacher's cap for a day",
        14,
        "The school's own cap on a teacher's day; a longer day for one "
        "teacher, named and measured, which the school can accept or fix. "
        "14 per five minutes is the least that keeps a room ahead of it for a "
        "lesson of 15 minutes (3 x 14 = 42 > 40), and so for every longer one.",
    ),
    RelaxableRule(
        "TEACHER_WORK_DAYS",
        "DEVIATION_TEACHER_WORK_DAYS",
        "teaching day over what the teacher's post allows",
        1200,
        "The most harmful of the five: a part-time post's days are in a "
        "contract. It gives way last, and every breach is named. 1 200 keeps "
        "it above the cap for a whole teaching day of up to seven hours "
        "(84 slots x 14 = 1 176).",
    ),
)

#: What never gives way in either mode. Names only; the argument is in the
#: module docstring. tests/test_best_effort.py proves each still refuses.
HARD_RULES: tuple[str, ...] = (
    "A teacher, class, pupil or room booked twice",
    "A lesson outside the school's frame times",
    "The walk between two sites",
    "A teacher marked unavailable",
    "A teacher's lunch and night's rest",
    "A requirement's own room type, capacity and years",
    "Lunch, the dining hall and the rasts",
    "Lesson lengths and lessons per week",
    "A parallel block's shared start",
    "The group's own daily cap (maxLessonsPerDayPerGroup)",
)

WEIGHT: dict[str, int] = {rule.name: rule.weight for rule in RELAXABLE_RULES}
CODE: dict[str, str] = {rule.name: rule.code for rule in RELAXABLE_RULES}

#: One slot is five minutes on the default grid; the cap's weight is per five
#: minutes and is scaled to the grid the model counts in.
_CAP_BASE_MINUTES = 5


def strip(request: OptimizeScheduleRequest) -> OptimizeScheduleRequest:
    """The same week with every relaxable rule taken out: the HARD rules alone.

    A RELAXATION OF THE MODEL, so what it refuses the best-effort model refuses
    too, and the refusal names a hard rule (the explanation and the probes of
    the strict mode run on this, not on a week whose rules were about to give
    way). Its solutions are exactly the best-effort model's with every slack
    free, which is why the arithmetic verdicts that read these fields cannot be
    allowed to see them: a verdict that said "the cap cannot hold" would refuse
    the very week this mode exists to place.

    The locked days a requirement carries stay: they say where the school's own
    lessons are, which no relaxation changes.
    """
    requirements = [
        requirement.model_copy(update={"max_lessons_per_day": None, "min_days_between": None})
        if requirement.max_lessons_per_day is not None
        or requirement.min_days_between is not None
        else requirement
        for requirement in request.requirements
    ]
    rules = [
        rule.model_copy(update={"max_teaching_minutes_per_day": None})
        if rule.max_teaching_minutes_per_day is not None
        else rule
        for rule in request.teacher_work_rules
    ]
    return request.model_copy(update={
        "requirements": requirements,
        "teacher_work_rules": rules,
        "teacher_day_limits": [],
        "room_preferences": [
            preference for preference in request.room_preferences if preference.kind != "LOCK"
        ],
        "relaxation": None,
    })


def prices_anything(request: OptimizeScheduleRequest) -> bool:
    """Whether the week carries any rule on the list: if not, the mode has nothing to relax."""
    return (
        any(
            requirement.max_lessons_per_day is not None
            or requirement.min_days_between is not None
            for requirement in request.requirements
        )
        or any(rule.max_teaching_minutes_per_day is not None for rule in request.teacher_work_rules)
        or bool(request.teacher_day_limits)
        or any(preference.kind == "LOCK" for preference in request.room_preferences)
    )


class Relax:
    """The prices one model build collects: slack variables and their weights.

    A build without one adds nothing, so the strict model is the model it was,
    variable for variable (benchmarks/model_identity.py measures it). The
    builders call `over`/`flag` where a hard row becomes a priced one and read
    nothing else from here; `total()` is the deviations' share of the
    objective, in units, before it is scaled above the soft rules.
    """

    def __init__(self, slot_minutes: int) -> None:
        self._terms: list[cp_model.LinearExpr] = []
        # A slot of the cap is slot_minutes/5 of the weight's five minutes.
        self._cap_slot_weight = max(1, round(WEIGHT["TEACHER_DAILY_CAP"] * slot_minutes / _CAP_BASE_MINUTES))

    def over(
        self,
        model: cp_model.CpModel,
        name: str,
        upper: int,
        rule: str,
    ) -> cp_model.IntVar:
        """An amount a rule may be exceeded by, at the rule's price per unit."""
        var = model.NewIntVar(0, max(0, upper), name)
        weight = self._cap_slot_weight if rule == "TEACHER_DAILY_CAP" else WEIGHT[rule]
        self._terms.append(var * weight)
        return var

    def flag(self, model: cp_model.CpModel, name: str, rule: str) -> cp_model.IntVar:
        """A breach that is there or not, at the rule's price."""
        var = model.NewBoolVar(name)
        self._terms.append(var * WEIGHT[rule])
        return var

    def add(self, term: cp_model.LinearExpr, rule: str) -> None:
        """A breach counted by a term the caller built (a lesson outside its rooms)."""
        weight = self._cap_slot_weight if rule == "TEACHER_DAILY_CAP" else WEIGHT[rule]
        self._terms.append(term * weight)

    @property
    def empty(self) -> bool:
        return not self._terms

    def total(self) -> cp_model.LinearExpr:
        return sum(self._terms)


def upper_bound(model: cp_model.CpModel, expression: cp_model.LinearExpr) -> int:
    """The largest value a linear expression can take, from its variables' domains.

    CP-SAT has no call for it. The expression is minimised once so that its
    proto can be read, and the caller minimises the combined objective after.
    """
    model.Minimize(expression)
    objective = model.Proto().objective
    bound = objective.offset
    variables = model.Proto().variables
    for index, coefficient in zip(objective.vars, objective.coeffs, strict=True):
        # A list, because this protobuf's repeated field answers a negative
        # index with 0 (found the hard way: a bound of 0 made the scale 2).
        domain = list(variables[index].domain)
        low, high = domain[0], domain[len(domain) - 1]
        bound += max(coefficient * low, coefficient * high)
    return int(bound)


def dominating_scale(soft_bound: int) -> int:
    """A multiplier for the deviations that no combination of soft terms can outweigh."""
    return max(1, soft_bound) + 1


# ---------------------------------------------------------------------------
# The report: what gave way in the timetable that came back.
# ---------------------------------------------------------------------------


def _clock(value: str) -> int:
    hours, minutes, _ = value.split(":")
    return int(hours) * 60 + int(minutes)


def _union_minutes(spans: list[tuple[int, int]]) -> int:
    covered = 0
    last_end = -1
    for start, end in sorted(spans):
        start = max(start, last_end)
        if end > start:
            covered += end - start
            last_end = end
    return covered


def _teachers_on(
    requirement: AnonymousRequirement, lesson: ScheduledLesson,
) -> tuple[UUID, ...]:
    """Who is on a placed lesson: its lead (a split post's own) and the co-teacher."""
    lead = lesson.teacher_id if lesson.teacher_id is not None else requirement.teacher_id
    teachers = [teacher for teacher in (lead, requirement.co_teacher_id) if teacher is not None]
    return tuple(dict.fromkeys(teachers))


def _week_lessons(
    requirement: AnonymousRequirement | None, week: WeekParity,
) -> bool:
    return requirement is not None and meet(requirement.recurrence, week)


def deviations_of(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    rooms: list[AnonymousRoom],
    locked_rooms: dict[UUID, frozenset[UUID]],
    grid_days: tuple[int, ...],
    *,
    flatten: Callable[[list[FixedLesson]], dict[tuple[UUID, int], int]],
) -> list[ConflictDetail]:
    """Every relaxable rule the timetable breaks, with how much and what it would take.

    COUNTED THE WAY THE MODEL HOLDS EACH RULE, so a breach reported here is one
    the model priced and a rule kept here is one it kept:

    - The teacher's cap is per weekday, in minutes, over the generated lessons
      PLUS the teacher's locked lessons (their clock union, never refused); a
      breach is reported only for the part the generated lessons add.
    - The post's days are per real week (A/B-veckor: the odd week's lessons
      and locks, then the even week's); a breach is the days the generated
      lessons add beyond max(N, the days the locks already hold).
    - A subject's per-day cap and days apart count the generated lessons and
      `lockedDays`, as the rule's field says.
    - A locked room is breached by every lesson of the subject placed outside
      the rooms its lock allows.

    "NEEDED" IS THE VALUE THE RULE WOULD HAVE TO HAVE FOR THIS TIMETABLE TO
    HOLD. It is not a promise that no other timetable keeps the rule, which the
    solve already looked for: it is what a school reads to decide whether to
    accept this one or change the rule.
    """
    by_requirement = {requirement.id: requirement for requirement in request.requirements}
    out: list[ConflictDetail] = []
    out.extend(_cap_deviations(request, lessons, by_requirement, flatten))
    out.extend(_work_day_deviations(request, lessons, by_requirement))
    out.extend(_distribution_deviations(request, lessons, by_requirement, grid_days))
    out.extend(_room_lock_deviations(lessons, by_requirement, rooms, locked_rooms))
    return out


def _cap_deviations(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    by_requirement: dict[UUID, AnonymousRequirement],
    flatten: Callable[[list[FixedLesson]], dict[tuple[UUID, int], int]],
) -> list[ConflictDetail]:
    capped = [rule for rule in request.teacher_work_rules if rule.max_teaching_minutes_per_day]
    if not capped:
        return []
    found: list[ConflictDetail] = []
    for week in WEEKS:
        locked = flatten([fixed for fixed in request.fixed_lessons if meet(fixed.recurrence, week)])
        taught: dict[tuple[UUID, int], int] = defaultdict(int)
        on_day: dict[tuple[UUID, int], list[UUID]] = defaultdict(list)
        for lesson in lessons:
            requirement = by_requirement.get(lesson.requirement_id)
            if not _week_lessons(requirement, week):
                continue
            assert requirement is not None
            minutes = _clock(lesson.end_time) - _clock(lesson.start_time)
            for teacher in _teachers_on(requirement, lesson):
                taught[(teacher, lesson.day_of_week)] += minutes
                on_day[(teacher, lesson.day_of_week)].append(requirement.id)
        for rule in capped:
            cap = rule.max_teaching_minutes_per_day
            assert cap is not None
            for (teacher, day), generated in sorted(taught.items(), key=lambda item: item[0][1]):
                if teacher != rule.teacher_id:
                    continue
                locked_minutes = locked.get((teacher, day), 0)
                over = generated - max(0, cap - locked_minutes)
                if over <= 0:
                    continue
                found.append(ConflictDetail(
                    category="DEVIATION",
                    code="DEVIATION_TEACHER_DAILY_CAP",
                    params={
                        "rule": str(rule.id),
                        "day": day,
                        "minutes": cap,
                        "taught": generated + locked_minutes,
                        "over": over,
                        "needed": generated + locked_minutes,
                    },
                    requirement_ids=list(dict.fromkeys(on_day[(teacher, day)])),
                    resource_ids=[rule.id],
                ))
    return _worst_week(found, ("rule", "day"))


def _work_day_deviations(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    by_requirement: dict[UUID, AnonymousRequirement],
) -> list[ConflictDetail]:
    """The days a post allows, counted the way the model holds them.

    For every set L of locked weekdays the gateway sent for the post (one per
    real week the locks make), the generated lessons may take at most
    max(0, N - |L|) weekdays outside L: so the breach in that week is
    |G \\ L| - max(0, N - |L|), G being the weekdays the generated lessons of
    that ISO week take. The worst of them is the line. Read off the post's own
    sets and not off the locked lessons, so the report and the model cannot
    read two weeks from one payload.
    """
    if not request.teacher_day_limits:
        return []
    found: list[ConflictDetail] = []
    for week in WEEKS:
        days: dict[UUID, Counter[int]] = defaultdict(Counter)
        requirements_of: dict[tuple[UUID, int], list[UUID]] = defaultdict(list)
        for lesson in lessons:
            requirement = by_requirement.get(lesson.requirement_id)
            if not _week_lessons(requirement, week):
                continue
            assert requirement is not None
            minutes = _clock(lesson.end_time) - _clock(lesson.start_time)
            for teacher in _teachers_on(requirement, lesson):
                days[teacher][lesson.day_of_week] += minutes
                requirements_of[(teacher, lesson.day_of_week)].append(requirement.id)
        for limit in request.teacher_day_limits:
            generated = days.get(limit.teacher_id)
            if not generated:
                continue
            worst: tuple[int, frozenset[int]] | None = None
            for held in {frozenset(weekdays) for weekdays in limit.locked_weekdays}:
                outside = [day for day in generated if day not in held]
                over = len(outside) - max(0, limit.max_teaching_days_per_week - len(held))
                if over > 0 and (worst is None or over > worst[0]):
                    worst = (over, held)
            if worst is None:
                continue
            over, held = worst
            # The lightest days the generated lessons add: where moving a
            # lesson costs least, and so where a reader should look first.
            added = sorted((day for day in generated if day not in held), key=lambda d: generated[d])
            extra = added[:over]
            found.append(ConflictDetail(
                category="DEVIATION",
                code="DEVIATION_TEACHER_WORK_DAYS",
                params={
                    "limit": str(limit.id),
                    "days": limit.max_teaching_days_per_week,
                    "taught": len(set(generated) | held),
                    "over": over,
                    "needed": len(set(generated) | held),
                },
                requirement_ids=list(dict.fromkeys(
                    requirement
                    for day in extra
                    for requirement in requirements_of[(limit.teacher_id, day)]
                )),
                resource_ids=[limit.id],
            ))
    return _worst_week(found, ("limit",))


def _distribution_deviations(
    request: OptimizeScheduleRequest,
    lessons: list[ScheduledLesson],
    by_requirement: dict[UUID, AnonymousRequirement],
    grid_days: tuple[int, ...],
) -> list[ConflictDetail]:
    ruled = {
        requirement.id: requirement
        for requirement in request.requirements
        if requirement.max_lessons_per_day is not None or requirement.min_days_between is not None
    }
    if not ruled:
        return []
    placed: dict[UUID, Counter[int]] = defaultdict(Counter)
    for lesson in lessons:
        if lesson.requirement_id in ruled:
            placed[lesson.requirement_id][lesson.day_of_week] += 1
    out: list[ConflictDetail] = []
    for requirement_id, requirement in ruled.items():
        counts = placed.get(requirement_id)
        if not counts:
            continue
        locked = Counter(requirement.locked_days)
        per_day = requirement.max_lessons_per_day
        if per_day is not None:
            for day in sorted(counts):
                allowed = max(0, per_day - locked[day])
                if counts[day] > allowed:
                    out.append(ConflictDetail(
                        category="DEVIATION",
                        code="DEVIATION_SUBJECT_PER_DAY",
                        params={
                            "requirement": str(requirement_id),
                            "day": day,
                            "maxPerDay": per_day,
                            "count": counts[day] + locked[day],
                            "over": counts[day] - allowed,
                            "needed": counts[day] + locked[day],
                        },
                        requirement_ids=[requirement_id],
                    ))
        apart = requirement.min_days_between
        if apart is not None:
            used = sorted(counts)
            facts = sorted(set(requirement.locked_days))
            closest: int | None = None
            pairs = 0
            for index, first in enumerate(used):
                for second in used[index + 1:]:
                    if second - first < apart:
                        pairs += 1
                        closest = second - first if closest is None else min(closest, second - first)
                for locked_day in facts:
                    if 0 < abs(first - locked_day) < apart:
                        pairs += 1
                        gap = abs(first - locked_day)
                        closest = gap if closest is None else min(closest, gap)
            if pairs:
                assert closest is not None
                out.append(ConflictDetail(
                    category="DEVIATION",
                    code="DEVIATION_SUBJECT_DAYS_APART",
                    params={
                        "requirement": str(requirement_id),
                        "minDaysBetween": apart,
                        "pairs": pairs,
                        "closest": closest,
                        "needed": closest,
                    },
                    requirement_ids=[requirement_id],
                ))
    del grid_days  # the rule counts ISO weekdays, as the field says
    return out


def _room_lock_deviations(
    lessons: list[ScheduledLesson],
    by_requirement: dict[UUID, AnonymousRequirement],
    rooms: list[AnonymousRoom],
    locked_rooms: dict[UUID, frozenset[UUID]],
) -> list[ConflictDetail]:
    if not locked_rooms:
        return []
    outside: dict[UUID, list[ScheduledLesson]] = defaultdict(list)
    for lesson in lessons:
        allowed = locked_rooms.get(lesson.requirement_id)
        if allowed is not None and lesson.room_id not in allowed:
            outside[lesson.requirement_id].append(lesson)
    out: list[ConflictDetail] = []
    known = {room.id for room in rooms}
    for requirement_id, placed in outside.items():
        out.append(ConflictDetail(
            category="DEVIATION",
            code="DEVIATION_ROOM_LOCK",
            params={
                "requirement": str(requirement_id),
                "lessons": len(placed),
                "of": by_requirement[requirement_id].lessons_per_week,
            },
            requirement_ids=[requirement_id],
            room_ids=list(dict.fromkeys(
                lesson.room_id for lesson in placed if lesson.room_id in known
            )),
        ))
    return out


def _worst_week(
    found: list[ConflictDetail], key: tuple[str, ...],
) -> list[ConflictDetail]:
    """One line per rule (and day), the week that breaks it by most.

    A school without alternating lessons has the same week twice; one with
    them has two, and a reader is told about the worse and not about both.
    """
    best: dict[tuple, ConflictDetail] = {}
    for detail in found:
        identity = tuple(detail.params[name] for name in key)
        held = best.get(identity)
        if held is None or int(detail.params["over"]) > int(held.params["over"]):
            best[identity] = detail
    return list(best.values())
