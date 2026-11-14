"""Fästa lektioner: a lesson of a requirement held where the school laid it.

A school lays some lessons by hand before it lets the generator place the
rest. One way to say that has always existed: the lesson is sent as a
FixedLesson and taken off its requirement (Förlagda poster, placements.py).
A lock is a constant window, though, and that is what it cannot do. It has to
name its room, because the engine gives rooms only to the lessons it places;
and it has no literal, so a week it makes impossible is refused with a
sentence about something else.

A PINNED LESSON IS THE OTHER WAY TO SAY IT. The lesson stays one of its
requirement's own (AnonymousRequirement.pinnedLessons, a place per lesson): it
keeps its start variable, its room choice and every rule a lesson the engine
places has. What is added is one equality, `start == where the school laid
it`, and when the pin names a room a second, `room_index == that room`.

BOTH HANG ON ONE ASSUMPTION LITERAL PER PINNED LESSON, and the start's domain
is left as it was. That is _create_lesson_decisions' reason for a block's
members: a domain cut to one value is a narrowing no literal carries, so a
week the pin makes impossible would be proved without it and named as
whatever it met. With the literal, the proof names the pin: two lessons pinned
onto one hour of a teacher's come back as those two and nothing else.

STRICTER THAN A LOCK, AND ON PURPOSE. A lock has no years, no subject and no
margins, and is never compared with another lock: it may lie outside its
class's frame, across a rast, on a day its subject's rule has already filled.
A pinned lesson is held to all of it, as the lesson beside it is. A caller
that wants the school's hand edit taken as a fact sends a lock.

A PINNED ROOM IS A DISTINGUISHED ROOM (room_allocator.py): its own class of
one, where room_index is the answer. In a class of several rooms room_index is
linked to nothing and the post-pass hands out the rooms in start order, so the
equality alone would be kept by the solver and broken by the answer.
`pinned_room_ids` is read wherever the distinguished rooms are, by the model
and by everything that predicts it.

A REQUEST WITHOUT A PIN BUILDS WHAT IT BUILT. No variable, no literal, no
value in the start step and no distinguished room comes from this module
unless a requirement carries the field.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Iterable, Mapping
from uuid import UUID

from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import ConflictDetail

#: The codes a pinned lesson's literal is registered under (Pin.line): what a
#: reader of the registry asks for to find the pins among its literals.
PIN_CODES = ("PLACED_LESSON_IN_THE_WAY", "PLACED_LESSON_IN_THE_WAY_ANY_ROOM")

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ortools.sat.python import cp_model

    from app.schemas.schedule import (
        AnonymousRequirement,
        AnonymousRoom,
        FrameTime,
        OptimizeScheduleRequest,
        PinnedLesson,
        Rast,
    )
    from app.solver.conflict_analyzer import AssumptionRegistry
    from app.solver.time_grid import TimeGrid


@dataclass(frozen=True)
class Pin:
    """One pinned lesson: its requirement, its place among the lessons, and where it is held."""

    requirement: AnonymousRequirement
    lesson_index: int
    lesson: PinnedLesson

    def where_params(self) -> dict[str, str | int]:
        """What every sentence about a pinned lesson says: its post, its day, its clock.

        The ids are the payload's, which the gateway names back as it names
        every other sentence's; the clock is the pin's own, to the minute.
        """
        return {
            "requirement": str(self.requirement.id),
            "day": self.lesson.day_of_week,
            "start": self.lesson.start_time[:5],
            "end": self.lesson.end_time[:5],
        }

    def line(self) -> ConflictDetail:
        """The pinned lesson as a refusal names it, in the words a förläggning has.

        With its room it is PLACED_LESSON_IN_THE_WAY, the sentence a förlagd
        lock is named with: to a school the two are one thing. Without one the
        sentence has no room to end on, and two codes say it rather than one
        with an optional tail.
        """
        if self.lesson.room_id is None:
            return ConflictDetail(
                category="PLACEMENT",
                code="PLACED_LESSON_IN_THE_WAY_ANY_ROOM",
                params=self.where_params(),
                requirement_ids=[self.requirement.id],
            )
        return ConflictDetail(
            category="PLACEMENT",
            code="PLACED_LESSON_IN_THE_WAY",
            params={**self.where_params(), "room": str(self.lesson.room_id)},
            requirement_ids=[self.requirement.id],
            room_ids=[self.lesson.room_id],
        )


def pins_of(requirements: Iterable[AnonymousRequirement]) -> list[Pin]:
    """Every pinned lesson of these requirements, in their order and then by place."""
    return [
        Pin(requirement=requirement, lesson_index=index, lesson=lesson)
        for requirement in requirements
        for index, lesson in enumerate(requirement.pinned_lessons or ())
        if lesson is not None
    ]


def has_pins(request: OptimizeScheduleRequest) -> bool:
    return any(requirement.pinned_lessons is not None for requirement in request.requirements)


def pinned_room_ids(requirements: Iterable[AnonymousRequirement]) -> set[UUID]:
    """The rooms pinned lessons name: distinguished rooms, each a class of its own.

    Empty without a pin that names a room, and the partition is then the one
    it was.
    """
    return {
        pin.lesson.room_id for pin in pins_of(requirements) if pin.lesson.room_id is not None
    }


def pinned_start_slots(
    requirements: Iterable[AnonymousRequirement], grid: TimeGrid,
) -> list[int] | None:
    """Each pinned start as a slot of its day, for the week's start step; None when one cannot be read.

    _start_step's rule: every constant a start is compared with feeds its gcd,
    and a pin is `start == constant`. The day's own offset is a multiple of
    the day's length, which is in the gcd already. Unreadable is the caller's
    step of 1, as every other source there has it: verify_pins refuses that
    pin by name before any model is built.
    """
    slots: list[int] = []
    for pin in pins_of(requirements):
        try:
            slots.append(grid.parse_hhmmss(pin.lesson.start_time))
        except ValueError:
            return None
    return slots


def slot_of(pin: Pin, grid: TimeGrid) -> int:
    """The absolute slot a pinned lesson starts on. verify_pins has read it once already."""
    return grid.absolute_start(pin.lesson.day_of_week, grid.parse_hhmmss(pin.lesson.start_time))


def verify_pins(
    request: OptimizeScheduleRequest,
    grid: TimeGrid,
    *,
    start_domains: Callable[
        [AnonymousRequirement, list[FrameTime], list[Rast], None], Mapping[int, "cp_model.Domain"],
    ],
    room_allowed: Callable[[AnonymousRoom, AnonymousRequirement], bool],
    locked_rooms: Mapping[UUID, set[UUID]],
    blocks: Mapping[UUID, list[AnonymousRequirement]],
) -> None:
    """Refuse by name a pin its own requirement's rows cannot hold.

    EVERYTHING HERE IS ARITHMETIC ON THE PIN AND ITS REQUIREMENT. What a pin
    meets in the rest of the week — a teacher away, another pinned lesson, a
    full room — is the model's to prove, and the proof names the pin. What is
    refused here is what the model would prove with the pin's literal alone
    and nothing beside it to say why: a start the requirement's frame, margins
    or rasts leave out, a room it may not use.

    `start_domains` is the builder's own (_start_domains), read before the
    week's step, so this and the model cannot disagree about which starts a
    requirement has. It is read three times, each with one more of the
    school's rows, and the first that leaves the pin out names its sentence:
    the frame alone; then the margins (the pupils' minutes round the lesson
    and the changeover, which may not cross the day's edge); then the rasts.
    One sentence for all three would blame the frame for minutes it offers,
    which is why the requirement's own refusals are three as well.
    `locked_rooms` is the requirement's room lock where one is enforced: empty
    in Bästa möjliga schema's own checks, where a lock is priced.
    """
    rooms = {room.id: room for room in request.rooms}
    bare_frames = [
        frame.model_copy(update={"changeover_minutes": 0}) for frame in request.frame_times
    ]

    def holds(requirement: AnonymousRequirement, duration: int, start: int, *, margins: bool, rasts: bool) -> bool:
        if margins:
            frames = request.frame_times
        else:
            requirement = requirement.model_copy(update={"minutes_before": 0, "minutes_after": 0})
            frames = bare_frames
        domains = start_domains(requirement, frames, request.rasts if rasts else [], None)
        return domains[duration].contains(start)

    for pin in pins_of(request.requirements):
        requirement, lesson = pin.requirement, pin.lesson
        duration = grid.minutes_to_slots(requirement.lesson_minutes()[pin.lesson_index])
        try:
            start = slot_of(pin, grid)
        except ValueError:
            start = None
        if start is None or start % grid.slots_per_day + duration > grid.slots_per_day:
            raise InvalidScheduleInputError.of("PLACED_LESSON_OUTSIDE_THE_WEEK", pin.where_params())
        if not holds(requirement, duration, start, margins=False, rasts=False):
            raise InvalidScheduleInputError.of("PLACED_LESSON_OUTSIDE_FRAME", pin.where_params())
        if not holds(requirement, duration, start, margins=True, rasts=False):
            raise InvalidScheduleInputError.of("PLACED_LESSON_MARGINS_PAST_THE_DAY", pin.where_params())
        if not holds(requirement, duration, start, margins=True, rasts=True):
            raise InvalidScheduleInputError.of("PLACED_LESSON_IN_A_RAST", pin.where_params())
        if lesson.room_id is None:
            continue
        room = rooms.get(lesson.room_id)
        if room is None:
            # Not the school's data: a caller named a room it did not send.
            msg = f"pinned lesson of requirement {requirement.id} names a room the request does not hold."
            raise InvalidScheduleInputError(msg)
        locked = locked_rooms.get(requirement.id)
        if not room_allowed(room, requirement) or (locked is not None and room.id not in locked):
            raise InvalidScheduleInputError.of("PLACED_LESSON_ROOM_NOT_ALLOWED", {
                **pin.where_params(), "room": str(room.id),
            })

    # A BLOCK'S k-TH LESSONS START TOGETHER (_add_block_constraints), so a
    # block is pinned place by place: place k of every member, or of none, on
    # one day and start. The lessons of ONE requirement are interchangeable
    # only until one of them is pinned — a pin on place 1 of one member and on
    # place 0 of another, at one hour, would be refused by the model though
    # the other pairing holds. Refused here with the block named, rather than
    # there with a core no school could read. The rooms may differ and may be
    # left out: each member has its own.
    #
    # STRICTER THAN THE MODEL NEEDS, and chosen. A place pinned in one member
    # only is coherent: the block's equalities carry the others there. It is
    # refused all the same, because a block is laid as one thing and "every
    # member or none" is a rule a caller can keep and a school can read, where
    # "any member, as long as no two disagree and no two places cross" is not.
    # Loosening it later refuses nothing that is accepted today.
    for block_id, members in blocks.items():
        for place in range(members[0].lessons_per_week):
            held = [
                (member, member.pinned_lessons[place])
                for member in members
                if member.pinned_lessons is not None and member.pinned_lessons[place] is not None
            ]
            if not held:
                continue
            first_member, first = held[0]
            apart = next(
                (
                    member for member, lesson in held[1:]
                    if (lesson.day_of_week, lesson.start_time)  # type: ignore[union-attr]
                    != (first.day_of_week, first.start_time)  # type: ignore[union-attr]
                ),
                None,
            )
            pinned = {member.id for member, _ in held}
            other = apart or next((member for member in members if member.id not in pinned), None)
            if other is not None:
                raise InvalidScheduleInputError.of("PLACED_LESSONS_OF_BLOCK_DIFFER", {
                    "block": str(block_id),
                    "requirement": str(first_member.id),
                    "other": str(other.id),
                })


def add_pins(
    model: "cp_model.CpModel",
    registry: AssumptionRegistry,
    decisions: Iterable[object],
    rooms: list[AnonymousRoom],
    grid: TimeGrid,
) -> None:
    """Hold every pinned lesson at its start, and in its room when it names one.

    One literal per pinned lesson, carrying the line that names it; both
    equalities hang on it and on nothing else. No hint: the start is hinted
    from the previous timetable already, and CP-SAT refuses a model that hints
    one variable twice.
    """
    room_index = {room.id: index for index, room in enumerate(rooms)}
    for decision in decisions:
        lesson = decision.lesson  # type: ignore[attr-defined]
        held = lesson.requirement.pinned_lessons
        if held is None or held[lesson.lesson_index] is None:
            continue
        pin = Pin(
            requirement=lesson.requirement,
            lesson_index=lesson.lesson_index,
            lesson=held[lesson.lesson_index],
        )
        line = pin.line()
        literal = registry.register(
            model,
            name=f"pin_{lesson.key()}",
            category=line.category,
            code=line.code,
            params=dict(line.params),
            requirement_ids=list(line.requirement_ids),
            room_ids=list(line.room_ids),
        )
        model.Add(decision.start == slot_of(pin, grid)).OnlyEnforceIf(literal)  # type: ignore[attr-defined]
        if pin.lesson.room_id is not None:
            model.Add(
                decision.room_index == room_index[pin.lesson.room_id],  # type: ignore[attr-defined]
            ).OnlyEnforceIf(literal)


def meal_starts_taken_by_pins(
    decisions: Iterable[object],
    grid: TimeGrid,
    *,
    periods: int,
    eating: set[UUID],
    shares_students: Mapping[UUID, Iterable[UUID]],
    window: tuple[int, int, int],
) -> list[dict[UUID, tuple[object, ...]]] | None:
    """For each period, the meal starts each eating class's pinned lessons take; None when no pin takes one.

    KLASSENS MÅLTID PER DEL AV LÄSÅRET cuts a class's year where its locked
    lessons hold its meal differently (scheduler_solver._lunch_parts), and
    leaves it whole for what the class is merely taught: a lesson the engine
    places stands at one hour and the meal finds the gap beside it. A PINNED
    LESSON IS A LESSON WITH A KNOWN HOUR, AS A LOCK IS. Two posts pinned across
    the lunch window, one in the autumn and one in the spring, leave a
    different gap in each term, and a meal that is one for the year fits
    neither. So what this returns is one more thing the parts are told apart
    by.

    IT CUTS, AND IT SUBTRACTS NOTHING. A lock takes its starts out of the
    meal's domain, because a lock is no interval. A pinned lesson is one: the
    rows that keep a part's meal clear of the class's lessons hold it
    (_post_lunch_rows), in the weeks both run, and the pin's own literal is
    then what a refusal names. A domain cut here would prove the same week
    impossible without it.

    The window is the one those rows read, pupil_padded_of's: the lesson with
    the minutes its pupils change before and after it. A class is reached as a
    lock reaches it: the lesson's own class and every group sharing its pupils.
    The starts are cut to the ones a meal may take, so a pin that touches no
    meal start cuts nothing, and two pins that take the same starts are alike
    wherever they stand.
    """
    window_start, window_end, lunch_slots = window
    earliest, latest = window_start, window_end - lunch_slots
    taken: list[dict[UUID, dict[int, list[tuple[int, int]]]]] | None = None
    for decision in decisions:
        lesson = decision.lesson  # type: ignore[attr-defined]
        requirement = lesson.requirement
        held = requirement.pinned_lessons
        if held is None or held[lesson.lesson_index] is None:
            continue
        reached = [
            group_id
            for group_id in (
                requirement.student_group_id,
                *shares_students.get(requirement.student_group_id, ()),
            )
            if group_id in eating
        ]
        day_index, start = divmod(
            slot_of(Pin(requirement, lesson.lesson_index, held[lesson.lesson_index]), grid),
            grid.slots_per_day,
        )
        first = max(start - decision.lead - lunch_slots + 1, earliest)  # type: ignore[attr-defined]
        last = min(
            start + decision.duration + decision.trail + decision.changeover - 1,  # type: ignore[attr-defined]
            latest,
        )
        if first > last or not reached:
            continue
        if taken is None:
            taken = [{} for _ in range(periods)]
        for period in range(periods):
            if requirement.periods is not None and not requirement.periods[period]:
                continue
            for group_id in reached:
                taken[period].setdefault(group_id, {}).setdefault(day_index, []).append((first, last))
    if taken is None:
        return None
    return [
        {
            group_id: tuple(sorted((day_index, _joined(spans)) for day_index, spans in days.items()))
            for group_id, days in of_period.items()
        }
        for of_period in taken
    ]


def _joined(spans: list[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
    """These inclusive spans of starts as the fewest that say the same, in order."""
    joined: list[tuple[int, int]] = []
    for low, high in sorted(spans):
        if joined and low <= joined[-1][1] + 1:
            joined[-1] = (joined[-1][0], max(joined[-1][1], high))
        else:
            joined.append((low, high))
    return tuple(joined)


def without_pins(request: OptimizeScheduleRequest) -> OptimizeScheduleRequest:
    """The same week with every pinned lesson free to move, or the request itself.

    A relaxation of the week, as release_placements is for the förlagda locks:
    the same lessons, on the same requirements, with nothing held. Asked by
    the explanation and by a timeout's probes, and its timetable is never an
    answer.
    """
    if not has_pins(request):
        return request
    return request.model_copy(update={
        "requirements": [
            requirement
            if requirement.pinned_lessons is None
            else requirement.model_copy(update={"pinned_lessons": None})
            for requirement in request.requirements
        ],
    })
