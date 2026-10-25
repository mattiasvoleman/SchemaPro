"""Restid i generatorn: the walk between a school's skolområden as a hard rule.

WHAT IT KEEPS. A teacher, or the pupils of a lesson, who have two lessons on
one day at two different skolområden get at least the walk between them in
between: the minutes the school wrote for the pair (SiteTravelTimes), the same
both ways. Skolområden och restid (#161) holds the figures and warns about a
hand edit that breaks one (src/common/site-travel.ts); this module makes the
generator keep them. A school turns it on in its Skolregler, and until it does
the gateway sends no figure and no room's site, so the model is byte for byte
the one it was.

WHAT IS KNOWN, exactly as the gateway reads it. A walk is counted between two
lessons only when both rooms stand on a site, the sites differ and the pair
has a figure above zero. A room on no site, a pair with no figure and a figure
of 0 are all unknown or nothing, and keep nothing apart: the warning says
nothing about them either, and a generator stricter than the warning on a walk
nobody described would refuse weeks for a reason no screen can show.

THE WALK IS ROUNDED UP TO THE START STEP, the roadmap's decision (rad 1187).
Every lesson start and end, every locked window and every pupil margin lies on
the step's lattice (scheduler_solver._start_step), so the gap between any two
of them is a multiple of the step, and "a gap of at least ten minutes" is the
same sentence as "a gap of at least one step" when the step is thirty. The walk
is therefore NOT fed into the step's gcd: a ten-minute walk would take a school
searched every thirty minutes back to every ten, three times the starts, for a
precision the decision gives up. What it costs is stated rather than hidden: a
week that needed the ten minutes exactly is refused, and the refusal names the
step (`stepMinutes`).

WHERE A LESSON IS. The generator never names a room in its model; a lesson
picks a CLASS of interchangeable rooms (room_allocator.py). With the rule on,
the partition keeps sites apart, so every class stands on one site and a
lesson's site is the sum of its class literals per site: a literal per (lesson,
site) where it has a choice, and nothing at all where every class it may use
stands on one site.

THE ENCODING, per FAMILY — lessons one party walks between: a teacher's (lead
or co-teacher), a group's own, and for every pair of groups that share a pupil
each group's lessons leaving for the other's (the pupils of 7A who read
Spanska walk from 7A's lesson to Spanska's); families_of, and PUPIL_FAMILIES
for the other cut measured. For each site s a lesson can leave from, and each
walk t it can face from there:

    Cumulative over
      a TRAIL [end + m, end + m + t) for every member that may stand on s,
          present on that site literal, demand 1, and
      a BODY  [start - l, end) for every member that may stand on a site t
          away from s, present on its site literal, demand K·L,
    capacity K.

A trail overlapping a body is exactly a lesson starting less than t after one
on another site ended, so with L = 1 none may. Trails of one family never
overlap a body of a lesson they do not walk to: a lesson before the one that
left starts before the trail does. Trails may overlap one another when t is
longer than the family's shortest lesson, and K = ceil(t / dmin) is the most
that can: the lessons are disjoint, so two ends are at least the later lesson's
length apart. A body never overlaps another body. So the capacity is reached
only by a body under a trail, and with L = 0 the bodies ask for nothing and the
row says nothing — which is how the row hangs on L, the family's own literal,
WITHOUT A VARIABLE of its own: CP-SAT has no enforcement literal on a
cumulative, but a demand may be an affine expression.

For pupils, `m` is the lesson's trail (showering, changing back) and `l` the
next one's lead: a class showers, changes, THEN walks, so the walk is added to
those margins as the corridor is (pupil_padded_of). For a teacher both are
zero. The corridor itself is the walk between two rooms of one house; between
two houses the walk replaces it, so the two are not added: the corridor's own
no-overlap still holds beside this one, and the stricter of the two wins.

EVERY PAIR, NOT ONLY NEIGHBOURS. The warning counts the walk from the lesson a
party actually comes from (neighboursOf). Constraining every pair is the same
rule wherever the school's figures keep the triangle inequality — a lesson
between two others on a third site then makes the gap longer than the direct
walk anyway — and stricter where they do not, AND WHERE THE LESSON BETWEEN IS
IN A ROOM ON NO SITE, or on a site with no figure: the warning then reads two
unknown walks and says nothing, while the generator still holds Norra to
Södra apart by the whole walk. That is a choice and not an oversight. Holding
only neighbours exactly takes a literal per lesson saying "nothing of this
party in between", cubic in a family's lessons; and a lesson in a room nobody
placed is a walk nobody described, which the generator neither shortens nor
lengthens. Stricter is the safe side: a timetable the generator accepts is
never one the hand-edit warning flags. The manual says so (5.1), and a school
that wants the warning's reading exactly puts every room on a site.

THE SEARCH NEEDS HELP, AND GETS IT WITHOUT A VERDICT RESTING ON IT. A lesson
that may use rooms on two sites chooses its site and its time in one search,
and these rows bind only once the site is chosen; on the högstadium week with
its rooms on two sites, the free search found no first timetable where the
same week with its sites fixed did. So when phase 1a has not answered,
solve() plans the sites first (site_plan: a small model without time, every
family a home site and as few lessons away from it as the rooms' week holds)
and searches phase 1a's own model again with each lesson's other sites
closed. A timetable found there keeps every rule; a week impossible there is
only a bad guess, and solve() goes on as before. Every refusal is proved on
the free model. The probes that keep the walk search the same way
(SchedulerSolver._probe_search), or their verdicts would be lost to the same
blind search.

LOCKED LESSONS ARE FACTS, as everywhere in this engine: two locked lessons are
never held apart by this rule (the warning beside the edit that put them there
said so), and a generated lesson is held apart from a locked one by two rows
under the before/after literals _add_fixed_lesson_constraints already builds,
clamped at the day's edge so a lesson the evening before is not caught. See
fixed_rows. A lock wholly before or after the day's hours blocks no slot and
gets no such pair, but is walked from or to all the same, by a hole in the
lesson's starts on that day (outside_rows).

THE NIGHT. Absolute slots run day after day, so a trail leaving 17:50 on
Monday could reach a body at 08:00 on Tuesday. Where the start domains allow
that — a lesson that can end within a walk of the grid's end and one that can
start within the overshoot of its start — the family's rows are posted on
stretched slots, `start + P·day`, which puts P slots of night between days.
On the 08:00–18:00 grid and a school's own hours this is in practice never
needed, and the domains decide it per row, so nobody pays for it who does not.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable, Hashable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from ortools.sat.python import cp_model

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.schemas.schedule import AnonymousRoom, FixedLesson, OptimizeScheduleRequest
    from app.solver.room_allocator import RoomPlan
    from app.solver.scheduler_solver import LessonDecision

Party = Literal["TEACHER", "PUPILS"]

#: The sentence for each party's line, and the category it is filed under: a
#: teacher who cannot make it is a teacher's clash with time, the pupils' one
#: a group's. Existing categories, so neither /openapi.json nor the gateway's
#: type changes; the web already labels both.
CODES: dict[Party, str] = {
    "TEACHER": "TEACHER_TRAVEL_CANNOT_BE_KEPT",
    "PUPILS": "PUPILS_TRAVEL_CANNOT_BE_KEPT",
}
CATEGORIES: dict[Party, str] = {
    "TEACHER": "TEACHER_OVERLAP",
    "PUPILS": "GROUP_OVERLAP",
}


@dataclass(frozen=True)
class TravelMap:
    """The rule as one request reads it: which room is where, and how far apart."""

    #: Room id -> its site, for every room on a site some walk is counted from.
    site_of_room: dict[UUID, UUID]
    #: The walk of each pair, in slots on the start step, above zero only.
    slots: dict[frozenset[UUID], int]
    #: The figure the school wrote, for the same pairs.
    minutes: dict[frozenset[UUID], int]
    step: int
    slot_minutes: int

    def site_key(self, room: AnonymousRoom) -> UUID | None:
        """The room's site as the rule reads it; None is a site no walk is counted from."""
        return self.site_of_room.get(room.id)

    def between(self, first: Hashable, second: Hashable) -> int:
        """Slots of walk between two sites; 0 where nothing is counted."""
        if first is None or second is None or first == second:
            return 0
        return self.slots.get(frozenset((first, second)), 0)

    @property
    def step_minutes(self) -> int:
        return self.step * self.slot_minutes

    @property
    def longest(self) -> int:
        return max(self.slots.values())


def travel_map(
    request: OptimizeScheduleRequest, *, slot_minutes: int, step: int,
) -> TravelMap | None:
    """The request's walks, or None when it carries none the rule can count.

    None is the rule switched off, and every builder reads it so: a payload
    without `siteTravelTimes`, one whose every figure is 0, and one whose
    figures join only sites no room stands on all build today's model.
    """
    sites_with_rooms = {room.site_id for room in request.rooms if room.site_id is not None}
    unit = step * slot_minutes
    slots: dict[frozenset[UUID], int] = {}
    minutes: dict[frozenset[UUID], int] = {}
    for row in request.site_travel_times:
        if row.minutes <= 0:
            continue
        if row.site_a_id not in sites_with_rooms or row.site_b_id not in sites_with_rooms:
            continue
        pair = frozenset((row.site_a_id, row.site_b_id))
        slots[pair] = -(-row.minutes // unit) * step
        minutes[pair] = row.minutes
    if not slots:
        return None
    counted = {site for pair in slots for site in pair}
    return TravelMap(
        site_of_room={
            room.id: room.site_id for room in request.rooms if room.site_id in counted
        },
        slots=slots,
        minutes=minutes,
        step=step,
        slot_minutes=slot_minutes,
    )


# ---------------------------------------------------------------------------
# Where each lesson can be.
# ---------------------------------------------------------------------------

#: A lesson's possible sites. The value is the literal that says it stands
#: there, or None when it stands there whatever the solver does.
SiteChoice = dict[Hashable, cp_model.IntVar | None]


def site_choices(model: cp_model.CpModel, plan: RoomPlan) -> dict[str, SiteChoice]:
    """Each lesson's sites off its class choice. The partition kept sites apart.

    One literal per (lesson, site) where the lesson has a choice: the class
    literal itself when one class stands there, and otherwise a new one equal
    to their sum — exactly one class is chosen, so the sum is 0 or 1. A lesson
    whose classes all stand on one site has that site and no literal.
    """
    choices: dict[str, SiteChoice] = {}
    for key, _start, _duration, _room_index in plan.placements:
        forced = plan.forced_class.get(key)
        if forced is not None:
            choices[key] = {plan.class_sites[forced]: None}
            continue
        by_site: dict[Hashable, list[cp_model.IntVar]] = defaultdict(list)
        for class_index, literal in plan.literals[key].items():
            by_site[plan.class_sites[class_index]].append(literal)
        if len(by_site) == 1:
            choices[key] = {next(iter(by_site)): None}
            continue
        choice: SiteChoice = {}
        for site, literals in by_site.items():
            if len(literals) == 1:
                choice[site] = literals[0]
                continue
            here = model.NewBoolVar(f"site_{site}_{key}")
            model.Add(here == sum(literals))
            choice[site] = here
            plan.site_vars.append((key, site, here))
        choices[key] = choice
    plan.site_choices = choices
    return choices


# ---------------------------------------------------------------------------
# Who walks.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Family:
    """Lessons one party walks between: from a `leaving` lesson to an `arriving` one.

    A teacher's or a group's own lessons walk among themselves (the two lists
    are one). A pair of groups that share a pupil is two families, each
    group's lessons leaving for the other's, so a pair inside one group is
    never posted twice.
    """

    party: Party
    #: The literal's key: a teacher, a group, or a pair of groups.
    resource_ids: tuple[UUID, ...]
    leaving: tuple[LessonDecision, ...]
    arriving: tuple[LessonDecision, ...]


def _lesson_teachers(decision: LessonDecision) -> tuple[UUID, ...]:
    """The teachers ON this lesson, lead first: scheduler_solver._lesson_teachers.

    THE LESSON'S, NOT THE ROW'S. A post split between leads (lessonTeacherIds)
    has each lesson taught by its own lead and the co-teacher, and a walk is
    the walk of the person who teaches both lessons: Bertil, leading one lesson
    of a split post, walks to his own next lesson and not to Anna's. Read off
    the row's union, the rule held Bertil to Anna's lessons — refusing weeks
    that have a timetable — and let a lesson of his own go unheld where the
    row named him first. The one reader every teacher rule uses, imported
    where it is read: scheduler_solver imports this module.
    """
    from app.solver.scheduler_solver import _lesson_teachers as on_lesson

    return on_lesson(decision.lesson)


#: How the pupils' families are cut. "pairs": a group's own lessons, and each
#: pair of groups sharing a pupil both ways. "hubs": one family per group,
#: every lesson of the group and of each group sharing a pupil with it leaving
#: for the group's own lessons. The same pairs either way (see families_of);
#: the difference is the rows. A pair's lessons never overlap, so each of its
#: rows is a no-overlap once the site literals are fixed; a hub's leaving
#: lessons do (a språkval's groups run together), so its row is a cumulative
#: of capacity summed over its groups, fewer rows but a weaker propagation.
#: Measured on the högstadium week with its sites planned, one worker: pairs
#: found a first timetable at 5.7 deterministic units, hubs at 7.1.
PUPIL_FAMILIES = "pairs"


def families_of(
    decisions: Iterable[LessonDecision],
    group_conflicts: Iterable[tuple[UUID, UUID]] | None,
    *,
    cut: str | None = None,
) -> list[Family]:
    """Every family the rule holds, in a stable order: teachers, then groups.

    EVERY ORDERED PAIR OF LESSONS THAT SHARE A PERSON IS IN EXACTLY ONE
    FAMILY'S (leaving, arriving), however the pupils are cut:
    - a teacher's: every pair of the teacher's lessons;
    - by HUB, for each group G, lessons of G and of every group sharing a
      pupil with G leaving for G's own lessons. A pair (x, y) of lessons
      sharing a pupil, y's group G: x is G's or a neighbour's, so (x, y) is
      in G's family, and in no other — the arriving lesson names its hub.
    - by PAIR, a group's own lessons among themselves, and for each pair of
      groups sharing a pupil each group's lessons leaving for the other's.

    THE GROUPS ARE THE PUPIL SPACE'S (scheduler_solver.pupil_key_of), as
    _add_group_no_overlap keys them: the pupils of 7A's svenska are "7A
    without SvA7", who walk to 7A's matte and never to SvA7's lesson, which
    none of them sits. Keyed by the class, the pair (7A, SvA7) would hold
    the svenska a walk away from SvA beside it — a walk nobody takes.
    """
    from app.solver.scheduler_solver import pupil_key_of

    cut = cut or PUPIL_FAMILIES
    by_teacher: dict[UUID, list[LessonDecision]] = defaultdict(list)
    by_group: dict[UUID, list[LessonDecision]] = defaultdict(list)
    for decision in decisions:
        requirement = decision.lesson.requirement
        for teacher_id in dict.fromkeys(_lesson_teachers(decision)):
            by_teacher[teacher_id].append(decision)
        by_group[pupil_key_of(requirement)].append(decision)
    families: list[Family] = []
    for teacher_id, lessons in by_teacher.items():
        families.append(Family("TEACHER", (teacher_id,), tuple(lessons), tuple(lessons)))
    if cut == "hubs":
        neighbours: dict[UUID, list[UUID]] = defaultdict(list)
        for first_id, second_id in group_conflicts or []:
            if first_id == second_id:
                continue
            if second_id not in neighbours[first_id]:
                neighbours[first_id].append(second_id)
            if first_id not in neighbours[second_id]:
                neighbours[second_id].append(first_id)
        for group_id, lessons in by_group.items():
            leaving = list(lessons)
            for other in neighbours.get(group_id, []):
                leaving.extend(by_group.get(other, []))
            families.append(Family("PUPILS", (group_id,), tuple(leaving), tuple(lessons)))
        return families
    for group_id, lessons in by_group.items():
        families.append(Family("PUPILS", (group_id,), tuple(lessons), tuple(lessons)))
    seen: set[frozenset[UUID]] = set()
    for first_id, second_id in group_conflicts or []:
        pair = frozenset((first_id, second_id))
        if first_id == second_id or pair in seen:
            continue
        seen.add(pair)
        first, second = by_group.get(first_id), by_group.get(second_id)
        if not first or not second:
            continue
        key = tuple(sorted((first_id, second_id), key=str))
        families.append(Family("PUPILS", key, tuple(first), tuple(second)))
        families.append(Family("PUPILS", key, tuple(second), tuple(first)))
    return families


# ---------------------------------------------------------------------------
# The rows.
# ---------------------------------------------------------------------------


def _offsets(decision: LessonDecision, slots_per_day: int, horizon: int) -> tuple[int, int]:
    """The latest end and the earliest start a lesson can have within its day."""
    starts = decision.starts or cp_model.Domain(0, max(0, horizon - decision.duration))
    flat = starts.FlattenedIntervals()
    latest_end = 0
    earliest_start = slots_per_day
    for index in range(0, len(flat), 2):
        low, high = flat[index], flat[index + 1]
        # Every interval of a start domain lies in one day (_day_reach); split
        # at the edges all the same, as _day_reach does, so this cannot be
        # fooled by a domain from anywhere else.
        for day in range(low // slots_per_day, high // slots_per_day + 1):
            first = max(low, day * slots_per_day) - day * slots_per_day
            last = min(high, (day + 1) * slots_per_day - 1) - day * slots_per_day
            latest_end = max(latest_end, last + decision.duration)
            earliest_start = min(earliest_start, first)
    return latest_end, earliest_start


@dataclass
class TravelRows:
    """Builds the rule's rows into one model, and remembers what it built.

    One per model build. The literals are registered on first use, one per
    family key, so a family with no row registers nothing and a week the rule
    cannot touch carries no literal at all.
    """

    travel: TravelMap
    choices: dict[str, SiteChoice]
    #: Registers a family's literal: (party, resource ids) -> literal.
    register: Callable[[Party, tuple[UUID, ...]], cp_model.IntVar]
    #: The day variable of a lesson, shared with the other rules' cache.
    day_var: Callable[[LessonDecision], cp_model.IntVar]
    slots_per_day: int
    horizon: int
    literals: dict[tuple[Party, tuple[UUID, ...]], cp_model.IntVar] = field(default_factory=dict)
    #: (lesson key, party, site, walk) -> trail interval, and (key, party,
    #: site) -> body, per coordinate system: shared across families, since a
    #: lesson's trail out of a site is the same interval in every family that
    #: holds it.
    _trails: dict[tuple, cp_model.IntervalVar] = field(default_factory=dict)
    _bodies: dict[tuple, cp_model.IntervalVar] = field(default_factory=dict)
    _stretched: dict[str, cp_model.IntVar] = field(default_factory=dict)
    _offsets: dict[str, tuple[int, int]] = field(default_factory=dict)
    #: Counts, for the log and the tests.
    rows: int = 0
    stretched_rows: int = 0

    def literal(self, party: Party, resource_ids: tuple[UUID, ...]) -> cp_model.IntVar:
        key = (party, resource_ids)
        existing = self.literals.get(key)
        if existing is None:
            existing = self.register(party, resource_ids)
            self.literals[key] = existing
        return existing

    def sites(self, decision: LessonDecision) -> SiteChoice:
        return self.choices.get(decision.lesson.key(), {None: None})

    # -- margins ----------------------------------------------------------
    @staticmethod
    def _leaves_after(decision: LessonDecision, party: Party) -> int:
        """Slots after the lesson's end before the walk starts: the pupils' trail."""
        return decision.trail if party == "PUPILS" else 0

    @staticmethod
    def _arrives_before(decision: LessonDecision, party: Party) -> int:
        """Slots before the lesson's start the party must be there: the pupils' lead."""
        return decision.lead if party == "PUPILS" else 0

    def _offset(self, decision: LessonDecision) -> tuple[int, int]:
        key = decision.lesson.key()
        cached = self._offsets.get(key)
        if cached is None:
            cached = _offsets(decision, self.slots_per_day, self.horizon)
            self._offsets[key] = cached
        return cached

    # -- intervals ----------------------------------------------------------
    def _trail(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        party: Party,
        site: Hashable,
        walk: int,
        stretched: bool,
    ) -> cp_model.IntervalVar:
        key = (decision.lesson.key(), party, site, walk, stretched)
        interval = self._trails.get(key)
        if interval is not None:
            return interval
        presence = self.sites(decision)[site]
        begin = self._stretched_start(model, decision) if stretched else decision.start
        start = begin + decision.duration + self._leaves_after(decision, party)
        name = f"trail_{party}_{site}_{walk}_{decision.lesson.key()}"
        interval = (
            model.NewFixedSizeIntervalVar(start, walk, name)
            if presence is None
            else model.NewOptionalFixedSizeIntervalVar(start, walk, presence, name)
        )
        self._trails[key] = interval
        return interval

    def _body(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        party: Party,
        site: Hashable,
        stretched: bool,
    ) -> cp_model.IntervalVar:
        key = (decision.lesson.key(), party, site, stretched)
        interval = self._bodies.get(key)
        if interval is not None:
            return interval
        presence = self.sites(decision)[site]
        begin = self._stretched_start(model, decision) if stretched else decision.start
        lead = self._arrives_before(decision, party)
        name = f"body_{party}_{site}_{decision.lesson.key()}"
        interval = (
            model.NewFixedSizeIntervalVar(begin - lead, decision.duration + lead, name)
            if presence is None
            else model.NewOptionalFixedSizeIntervalVar(
                begin - lead, decision.duration + lead, presence, name,
            )
        )
        self._bodies[key] = interval
        return interval

    def _stretched_start(self, model: cp_model.CpModel, decision: LessonDecision) -> cp_model.IntVar:
        """`start + P·day`: the lesson's start with P slots of night before each day."""
        key = decision.lesson.key()
        var = self._stretched.get(key)
        if var is None:
            days = max(1, self.horizon // self.slots_per_day)
            night = self.night
            var = model.NewIntVar(0, self.horizon + night * days, f"stretched_{key}")
            model.Add(var == decision.start + night * self.day_var(decision))
            self._stretched[key] = var
        return var

    @property
    def night(self) -> int:
        """Slots of night between stretched days: longer than any trail can reach.

        A trail reaches at most its lesson's trail margin plus the longest walk
        past the lesson's end, and the margin is at most 60 minutes
        (minutesAfter's bound) — so the longest walk plus an hour of slots is
        always enough, with room to spare.
        """
        return self.travel.longest + -(-60 // self.travel.slot_minutes)

    # -- the families -------------------------------------------------------
    def add_family(self, model: cp_model.CpModel, family: Family) -> None:
        """Post the family's rows: one cumulative per site left and walk faced."""
        leaving_sites: dict[Hashable, list[LessonDecision]] = defaultdict(list)
        for decision in family.leaving:
            for site in self.sites(decision):
                if site is not None:
                    leaving_sites[site].append(decision)
        if not leaving_sites:
            return
        for site, leaving in leaving_sites.items():
            # Every site an arriving lesson can stand on that is a walk away
            # from this one, grouped by the walk.
            by_walk: dict[int, list[tuple[LessonDecision, Hashable]]] = defaultdict(list)
            for decision in family.arriving:
                for other in self.sites(decision):
                    walk = self.travel.between(site, other)
                    if walk > 0:
                        by_walk[walk].append((decision, other))
            for walk, arriving in sorted(by_walk.items(), key=lambda item: item[0]):
                keys = {decision.lesson.key() for decision in leaving} | {
                    decision.lesson.key() for decision, _ in arriving
                }
                if len(keys) < 2:
                    # One lesson leaving a site for another it might stand on
                    # instead: it cannot be on both, so there is no pair.
                    continue
                self._post(model, family, site, walk, leaving, arriving)

    def _wraps(
        self,
        family: Family,
        walk: int,
        leaving: list[LessonDecision],
        arriving: list[tuple[LessonDecision, Hashable]],
    ) -> bool:
        """Whether a trail of these can reach past midnight into an arrival's morning."""
        overshoot = max(
            self._offset(decision)[0] + self._leaves_after(decision, family.party) + walk
            for decision in leaving
        ) - self.slots_per_day
        if overshoot <= 0:
            return False
        earliest = min(
            self._offset(decision)[1] - self._arrives_before(decision, family.party)
            for decision, _ in arriving
        )
        return earliest < overshoot

    def _post(
        self,
        model: cp_model.CpModel,
        family: Family,
        site: Hashable,
        walk: int,
        leaving: list[LessonDecision],
        arriving: list[tuple[LessonDecision, Hashable]],
    ) -> None:
        stretched = self._wraps(family, walk, leaving, arriving)
        capacity = _capacity(family.party, walk, leaving)
        literal = self.literal(family.party, family.resource_ids)
        intervals: list[cp_model.IntervalVar] = []
        demands: list[cp_model.LinearExprT] = []
        for decision in leaving:
            intervals.append(self._trail(model, decision, family.party, site, walk, stretched))
            demands.append(1)
        for decision, other in arriving:
            intervals.append(self._body(model, decision, family.party, other, stretched))
            demands.append(capacity * literal)
        model.AddCumulative(intervals, demands, capacity)
        self.rows += 1
        if stretched:
            self.stretched_rows += 1

    # -- locked lessons -----------------------------------------------------
    def fixed_rows(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        window: tuple[int, int],
        fixed_site: Hashable,
        before: cp_model.IntVar,
        after: cp_model.IntVar,
        relations: list[tuple[Party, tuple[UUID, ...]]],
    ) -> None:
        """Hold a generated lesson a walk away from a locked one on another site.

        ON THE BEFORE/AFTER LITERALS _add_window_avoidance ALREADY BUILT, so a
        locked lesson costs the rule no variable: `before` is the lesson ending
        ahead of the window, `after` starting behind it, and one of them holds.
        Under `before`, on each site the lesson may stand on a walk away, its
        end moves up by the walk (and the pupils' trail); under `after` its
        start moves back by the walk (and their lead).

        CLAMPED AT THE DAY'S EDGE, because `before` is also true of a lesson on
        an earlier day and `after` of one on a later day, and neither walks to
        this lesson. A lesson on an earlier day ends by this day's first slot,
        one on a later day starts at the next day's: so the end is bounded by
        whichever is later of "a walk before the window" and "this day's
        start", and the start by whichever is earlier of "a walk after it" and
        "the next day's start". On the window's own day the clamp is the walk;
        where the walk would reach into yesterday, no lesson of today may sit
        before the window at all, which is the truth.

        One row per relation the lock has with the lesson — the teacher's, the
        pupils', or both — each under its family's literal, so a refusal names
        whoever cannot make it.
        """
        start, end = window
        day = start // self.slots_per_day
        day_start = day * self.slots_per_day
        next_day = day_start + self.slots_per_day
        for other, presence in self.sites(decision).items():
            walk = self.travel.between(fixed_site, other)
            if walk <= 0:
                continue
            for party, resource_ids in relations:
                literal = self.literal(party, resource_ids)
                guard = [literal] if presence is None else [literal, presence]
                trail = self._leaves_after(decision, party)
                lead = self._arrives_before(decision, party)
                model.Add(
                    decision.end <= max(start - walk - trail, day_start),
                ).OnlyEnforceIf([before, *guard])
                model.Add(
                    decision.start >= min(end + walk + lead, next_day),
                ).OnlyEnforceIf([after, *guard])
                self.rows += 1

    def outside_rows(
        self,
        model: cp_model.CpModel,
        decision: LessonDecision,
        day_start: int,
        lock: tuple[int, int],
        fixed_site: Hashable,
        relations: list[tuple[Party, tuple[UUID, ...]]],
    ) -> None:
        """Hold a generated lesson a walk away from a lock outside the day's hours.

        A lock at 07:20–08:00 on a grid that opens at 08:00, or one after it
        closes, blocks nothing in the grid, so no before/after pair is built
        for it — but the teacher who taught it still walks, and the warning
        reads the lock at its clock time. `lock` is its [start, end) in slots
        from `day_start`, outward, and lies wholly before 0 or wholly at or
        after the day's length, so every lesson of that day is on one side of
        it: after a morning lock, before an evening one. Under the family's
        literal and the lesson's site, the starts the walk does not leave
        room for are taken out of the lesson's domain on that day alone — no
        day literal, since a start on another day lies outside the hole. A
        start beyond the hole is a start on the step, as every start is.
        """
        lock_start, lock_end = lock
        next_day = day_start + self.slots_per_day
        for other, presence in self.sites(decision).items():
            walk = self.travel.between(fixed_site, other)
            if walk <= 0:
                continue
            for party, resource_ids in relations:
                literal = self.literal(party, resource_ids)
                guard = [literal] if presence is None else [literal, presence]
                if lock_end <= 0:
                    # The first start the walk allows, after the lock and the
                    # pupils' lead.
                    first = day_start + lock_end + walk + self._arrives_before(decision, party)
                    hole = (day_start, first - 1)
                else:
                    # The last start that ends, sheds the pupils' trail and
                    # walks before the lock.
                    last = (
                        day_start + lock_start - walk - self._leaves_after(decision, party)
                        - decision.duration
                    )
                    hole = (max(day_start, last + 1), next_day - 1)
                if hole[1] < hole[0]:
                    continue
                model.AddLinearExpressionInDomain(
                    decision.start, cp_model.Domain(*hole).complement(),
                ).OnlyEnforceIf(guard)
                self.rows += 1


def _capacity(party: Party, walk: int, leaving: list[LessonDecision]) -> int:
    """The most trails that can cover one instant: the row's capacity.

    Lessons that never overlap end at least the later one's length apart, so
    their trails of `walk` cover one instant at most ceil(walk / shortest)
    deep. A teacher's lessons never overlap; a group's never overlap one
    another, but two groups' may (a språkval's groups run together), so for
    the pupils the depth is summed over the groups the trails come from —
    the PUPIL space's groups (pupil_key_of), the ones a no-overlap holds
    apart: 7A's svenska and SvA beside it are two groups' trails here.
    """
    from app.solver.scheduler_solver import pupil_key_of

    by_group: dict[object, list[int]] = defaultdict(list)
    for decision in leaving:
        key = pupil_key_of(decision.lesson.requirement) if party == "PUPILS" else None
        by_group[key].append(decision.duration)
    return max(1, sum(math.ceil(walk / min(lengths)) for lengths in by_group.values()))


# ---------------------------------------------------------------------------
# Where each lesson stands, chosen before any time is: the search's help.
# ---------------------------------------------------------------------------

#: The most the plan's tie-break (pairs of groups apart, after the lessons
#: away) may take of its cap: it ran to the whole 3.6 s of solve()'s plan on
#: the högstadium week, and every refusal of a school with the walk on paid it.
TIE_BREAK_SECONDS = 1.0


def site_plan(
    decisions: Sequence[LessonDecision],
    plan: RoomPlan,
    families: Iterable[Family],
    locked_sites: dict[tuple[Party, tuple[UUID, ...]], set[Hashable]],
    open_slots: dict[int, int],
    *,
    solver: cp_model.CpSolver,
    solve: Callable[[cp_model.CpSolver, cp_model.CpModel], int],
    tie_break: bool = True,
) -> tuple[dict[str, Hashable], int] | None:
    """A site for every lesson that has a choice: as few sites per family as fit.

    WHY. With the rule on, every lesson that may use rooms on two sites
    chooses its site and its time in one search, and the walk's rows bind
    only once the site is chosen — so the search sees almost nothing until it
    has guessed. Measured on the högstadium week with its rooms on two sites,
    eight workers: the week with its sites fixed found a timetable where the
    same week with its sites free found none in three times as long. So
    solve() asks this first, when the free search has not answered, and
    searches the week again on the sites it gives (_solve_on_planned_sites).

    NO VERDICT RESTS ON IT. A site chosen here is a guess about a good
    timetable; the week on these sites is the whole model with each choice
    pinned, so a timetable found there keeps every rule, and a week
    impossible there may well be possible on other sites — solve() then goes
    on as it would have, and nothing is refused for it.

    THE MODEL, without time: a class per lesson among the ones its rooms
    allow (the generator's own classes, each on one site); a class's lessons
    fit its rooms' week (minutes ≤ rooms × the slots its lessons can reach,
    less what the room's closures and the school's locks there take); a
    block's lessons, which start together, take no more of a class than it
    has rooms; and for every teacher and group a home site, and every lesson
    of it on another site counted: a family at home walks nowhere, and one
    with few lessons away needs few walks placed. A locked lesson away from
    home counts too. Two groups sharing a pupil with different homes count
    as a tie-break below that.

    None when there is nothing to choose or nothing was found within the
    solver's limit; else the sites, by lesson key, and how many lessons they
    put away from their family's home.
    """
    model = cp_model.CpModel()
    #: Lesson key -> {class: literal} for a lesson with more than one class,
    #: and the one class of a lesson that has only it.
    chosen: dict[str, dict[int, cp_model.IntVar]] = {}
    only: dict[str, int] = {}
    duration: dict[str, int] = {}
    any_choice = False
    for key, _start, length, _room in plan.placements:
        duration[key] = length
        forced = plan.forced_class.get(key)
        classes = [forced] if forced is not None else list(plan.literals[key])
        if len(classes) == 1:
            only[key] = classes[0]
            continue
        chosen[key] = {c: model.NewBoolVar(f"c{c}_{key}") for c in classes}
        model.AddExactlyOne(chosen[key].values())
        any_choice = any_choice or len({plan.class_sites[c] for c in classes}) > 1
    if not any_choice:
        return None

    # A class's rooms, over the week: what its lessons take is at most its
    # rooms times the slots those lessons can reach.
    load: dict[int, list] = defaultdict(list)
    for key, literals in chosen.items():
        for class_index, literal in literals.items():
            load[class_index].append(duration[key] * literal)
    for key, class_index in only.items():
        load[class_index].append(duration[key])
    for class_index, terms in load.items():
        if any(not isinstance(term, int) for term in terms):
            model.Add(sum(terms) <= plan.classes[class_index].capacity * open_slots.get(class_index, 0))

    # A block's lessons start together: per lesson index, a class holds no
    # more of them than it has rooms.
    together: dict[tuple[UUID, int], list[str]] = defaultdict(list)
    for decision in decisions:
        block_id = decision.lesson.requirement.block_id
        if block_id is not None:
            together[(block_id, decision.lesson.lesson_index)].append(decision.lesson.key())
    for keys in together.values():
        per_class: dict[int, list] = defaultdict(list)
        for key in keys:
            if key in only:
                per_class[only[key]].append(1)
            for class_index, literal in chosen.get(key, {}).items():
                per_class[class_index].append(literal)
        for class_index, terms in per_class.items():
            if len(terms) > plan.classes[class_index].capacity and any(
                not isinstance(term, int) for term in terms
            ):
                model.Add(sum(terms) <= plan.classes[class_index].capacity)

    def at(key: str, site: Hashable):  # noqa: ANN202
        if key in only:
            return 1 if plan.class_sites[only[key]] == site else 0
        terms = [v for c, v in chosen[key].items() if plan.class_sites[c] == site]
        if not terms:
            return 0
        if len(terms) == len(chosen[key]):
            return 1
        return sum(terms)

    # Every family a home site, and every lesson of it elsewhere counted.
    # Not merely the sites a family uses: a class that must go to Södra for
    # music uses both sites whatever else happens, and then only the count of
    # its lessons away from home tells a plan with one walk from a plan with
    # six. The pairs of groups sharing a pupil are left out of that count:
    # every lesson of a group would be counted again for every group it
    # shares a pupil with, and on the högstadium week, whose språkval joins
    # most classes, the plan then stopped converging in its few seconds and
    # handed the search a week it found nothing in (53 deterministic units,
    # where the plan without them took 7.5).
    # BUT A PAIR SPLIT ACROSS TWO HOMES IS STILL COUNTED, after the lessons
    # away and only as a tie-break (below): each group picks its own home, and where
    # every split costs no lesson away — a ring of groups sharing pupils,
    # each with one lesson — the groups' homes alone split the pairs across
    # the sites. The review's ring did, in 4 of 8 runs, and every week on
    # that plan was impossible. One literal per pair, not one per lesson.
    away: list = []
    homes: dict[tuple[Party, tuple[UUID, ...]], dict[Hashable, cp_model.IntVar]] = {}
    pairs: list[tuple[UUID, ...]] = []
    by_key: dict[tuple[Party, tuple[UUID, ...]], set[str]] = defaultdict(set)
    for family in families:
        if family.party == "PUPILS" and len(family.resource_ids) > 1:
            if family.resource_ids not in pairs:
                pairs.append(family.resource_ids)
            continue
        key = (family.party, family.resource_ids)
        for decision in (*family.leaving, *family.arriving):
            by_key[key].add(decision.lesson.key())
    sites = sorted({site for site in plan.class_sites if site is not None}, key=str)
    for key, members in by_key.items():
        presences = {
            member: {site: at(member, site) for site in sites} for member in sorted(members)
        }
        if all(
            all(isinstance(p, int) for p in by_site.values()) for by_site in presences.values()
        ) and not locked_sites.get(key):
            continue
        home = {site: model.NewBoolVar(f"home_{site}") for site in sites}
        model.AddExactlyOne(home.values())
        homes[key] = home
        for site in locked_sites.get(key, set()):
            if site in home:
                away.append(1 - home[site])
        for member, by_site in presences.items():
            for site, presence in by_site.items():
                if isinstance(presence, int) and presence == 0:
                    continue
                # away ≥ at(member, site) − home(site): a lesson on a site the
                # family does not call home is one lesson away.
                gone = model.NewBoolVar(f"away_{site}_{member}")
                model.Add(gone >= presence - home[site])
                away.append(gone)
    cap = solver.parameters.max_time_in_seconds
    model.Minimize(sum(away))
    status = solve(solver, model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    def read() -> tuple[dict[str, Hashable], int]:
        planned: dict[str, Hashable] = {}
        for key, literals in chosen.items():
            if len({plan.class_sites[c] for c in literals}) > 1:
                for class_index, literal in literals.items():
                    if solver.Value(literal):
                        planned[key] = plan.class_sites[class_index]
        return planned, sum(int(solver.Value(term)) for term in away)

    best = read()
    # THE TIE-BREAK, SECOND AND ON WHAT IS LEFT: as few pairs apart as the
    # same lessons away allow, from the plan just found. Weighted into one
    # objective instead (lessons away times the pairs plus one), the
    # högstadium week's 255 pairs took the plan from 42 lessons away, optimal
    # in 0.2 s on eight workers, to 107 after its whole 5 s.
    left = min(cap - solver.wall_time, TIE_BREAK_SECONDS)
    if not tie_break or not pairs or left < 0.1:
        return best
    split: list[cp_model.IntVar] = []
    for first_id, second_id in pairs:
        first, second = homes.get(("PUPILS", (first_id,))), homes.get(("PUPILS", (second_id,)))
        if first is None or second is None:
            continue
        apart = model.NewBoolVar(f"apart_{first_id}_{second_id}")
        for site in sites:
            model.Add(apart >= first[site] - second[site])
        split.append(apart)
    if not split:
        return best
    for variable in (
        *(literal for literals in chosen.values() for literal in literals.values()),
        *(literal for home in homes.values() for literal in home.values()),
    ):
        model.AddHint(variable, solver.Value(variable))
    model.Add(sum(away) <= best[1])
    model.Minimize(sum(split))
    solver.parameters.max_time_in_seconds = left
    if solve(solver, model) in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return read()
    return best


# ---------------------------------------------------------------------------
# Reading a timetable: whose walk does it break?
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Placed:
    """A lesson where a timetable put it, as the rule reads it."""

    key: str
    start: int
    end: int
    lead: int
    trail: int
    site: Hashable
    #: The day, where `start` does not say it: a lock before the day's hours
    #: starts in slots that belong to the day before.
    day: int | None = None

    def on_day(self, slots_per_day: int) -> int:
        return self.start // slots_per_day if self.day is None else self.day


def _too_close(
    travel: TravelMap, party: Party, first: Placed, second: Placed, slots_per_day: int,
) -> bool:
    """Whether the party cannot make it from `first` to `second` or back, on one day."""
    if first.on_day(slots_per_day) != second.on_day(slots_per_day):
        return False
    walk = travel.between(first.site, second.site)
    if walk <= 0:
        return False
    if first.start > second.start:
        first, second = second, first
    trail = first.trail if party == "PUPILS" else 0
    lead = second.lead if party == "PUPILS" else 0
    return (second.start - lead) - (first.end + trail) < walk


def breached(
    travel: TravelMap,
    families: Iterable[Family],
    placed: dict[str, Placed],
    locked_pairs: Iterable[tuple[Party, tuple[UUID, ...], str, Placed]],
    slots_per_day: int,
) -> dict[Party, list[UUID]]:
    """The teachers and groups a timetable leaves short of a walk, by party.

    Read exactly as the rows hold it: every pair of a family on one day, the
    walk on the step, the pupils' margins added; and every generated lesson
    against each locked lesson it shares a party with (`locked_pairs`: the
    family key, the generated lesson's key and the lock as placed). Two
    locked lessons are never read against each other, as the rows never hold
    them.
    """
    out: dict[Party, list[UUID]] = {"TEACHER": [], "PUPILS": []}

    def name(party: Party, resource_ids: tuple[UUID, ...]) -> None:
        for resource_id in resource_ids:
            if resource_id not in out[party]:
                out[party].append(resource_id)

    for family in families:
        leaving = [placed[d.lesson.key()] for d in family.leaving]
        arriving = [placed[d.lesson.key()] for d in family.arriving]
        if any(
            first.key != second.key
            and _too_close(travel, family.party, first, second, slots_per_day)
            for first in leaving
            for second in arriving
        ):
            name(family.party, family.resource_ids)
    for party, resource_ids, key, fixed in locked_pairs:
        if _too_close(travel, party, placed[key], fixed, slots_per_day):
            name(party, resource_ids)
    return out
