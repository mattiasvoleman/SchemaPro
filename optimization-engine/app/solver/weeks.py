"""The weeks of the year: A/B-veckor and terminer.

THE ENGINE PLANS EVERY WEEK A SCHOOL TEACHES. A school with an alternating
lesson — slöjd udda veckor, hemkunskap jämna veckor — teaches two different
weeks; a school whose hemkunskap runs for half the classes in the autumn and
the other half in the spring teaches two more. Every rule the model holds over
a class, a teacher or a room is a rule about each of those weeks on its own:
the autumn's lessons and the spring's never meet, so they may share an hour, a
teacher, a room and the pupils, and nothing counts them together.

WHICH WEEKS THERE ARE is the gateway's to say, because only the gateway has
dates. It cuts the year into PERIODS — the stretches in which the same entries
run — and tells each requirement and each locked lesson which of them it runs
in (`periods`, a mask; AnonymousRequirement.periods). Beside that stands the
parity it has always sent (`recurrence`). A concrete week is one period in one
parity, and `Weeks` is a set of them: what a lesson runs in, or what one row of
the model is about. None is every week, the field left out.

Two lessons MEET when some concrete week holds both (`meet`). That is the
gateway's weeksCanOverlap (src/calendar/lesson-recurrence.ts) with each
window widened to whole ISO weeks: opposed parities never meet, periods that
share no week never meet, everything else does. The product of period and
parity is what makes it that relation and no looser one — weeksCanOverlap is
itself "the dates overlap AND the parities are not opposed".

ONE MODEL, ONE VARIABLE PER LESSON. A lesson is placed once — the same day and
hour in every week it runs — so nothing about a lesson multiplies. What
multiplies is a ROW over several lessons: a no-overlap, a cumulative, a count
per day, a day's first and last lesson. `week_parts` cuts the members of such
a row into the weeks they run in, and the row is posted once per part. Weeks
with the same members are one part, so a period or a parity no member tells
apart costs nothing.

A ROW WHOSE MEMBERS ALL RUN EVERY WEEK IS POSTED ONCE, AS IT ALWAYS WAS. That
is the whole of the promise to a school without alternating or dated lessons:
every row of its model is built from the same members in the same order, so
the model is the one it was, byte for byte (benchmarks/model_identity.py
measures it), and names a variable nothing it did not name before. A school
with odd and even weeks and no periods has exactly the two weeks it had, in
the same order and under the same names.

TWO KINDS OF ROW, and `implied` says which:

- IMPLIED (the default): a row that only gets easier when a member is taken
  out — a no-overlap, a cumulative, a cap on a count, a walk between two
  lessons. Held over one week's members it also holds over any subset of
  them, so a week whose members all sit in another week's says nothing new
  and is left out. FOR THE SAME REASON A LARGE ROW IS CAPPED: past PART_LIMIT
  parts and ROW_LIMIT members in all, two parts are joined into their union,
  which holds both weeks' members apart at once — stricter than either week,
  never looser. A small row is never joined, however many periods a year has.
- NOT IMPLIED: a row that a missing member can break — "a class still at
  school after the rast was taught before it" is satisfied by a lesson the
  other week does not have. Every distinct week the members run in gets its
  own row, with exactly that week's members, and no two are ever joined: a
  union would let one week's lesson answer for a week that does not have it.

A PART IS NEVER EMPTY. A week with no member has nothing to hold.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import TypeVar

#: The most parts a LARGE implied row is cut into, and the most weeks a soft
#: term is measured in. A school's own weeks are few — two terms and the week
#: or two between them, perhaps a parity — and a row is cut only by the weeks
#: its own members tell apart, so this is reached by a row whose members carry
#: more than eight different sets of weeks between them.
PART_LIMIT = 8
#: What makes a row large: its parts' members, summed. A teacher's or a
#: class's own lessons are a few dozen, so their rows are cut exactly whatever
#: the year looks like — twelve courses of a month each take one hour of a
#: class's week between them, as they should. What reaches this is a row over
#: a school's lessons at once, a pool of rooms, and joining two parts of one
#: costs a pool with rooms to spare nothing it can feel. It is there so that a
#: year cut into fifty periods cannot post a school's rooms fifty times.
ROW_LIMIT = 2_000

T = TypeVar("T")


@dataclass(frozen=True)
class Weeks:
    """A set of the year's concrete weeks: each period in each parity.

    `bits` holds one bit per concrete week — bit 2·p for period p's odd
    weeks, bit 2·p + 1 for its even ones — and `periods` says how many
    periods the year is cut into, 1 for a payload that sends none. So the odd
    weeks of a year without periods are Weeks(0b01), and a requirement that
    runs in the first of three periods, every week, is Weeks(0b000011, 3).

    Hashable and compared by value: a part's weeks are a dictionary key
    wherever a row keeps something per week.
    """

    bits: int
    periods: int = 1

    def lifted(self, periods: int) -> int:
        """The same weeks as bits of a year cut into `periods` periods.

        Weeks that name no period (a parity alone) are those weeks of every
        period. Two different cuts of one year cannot be compared, and the
        request's own validator refuses a payload that carries two.
        """
        if self.periods == periods:
            return self.bits
        return _lift(self.bits, self.periods, periods)

    def _first(self) -> tuple[int, int, bool]:
        """The first concrete week: its period, its parity, and whether both of the period's are here."""
        index = (self.bits & -self.bits).bit_length() - 1
        period, parity = divmod(index, 2)
        return period, parity, (self.bits >> (2 * period)) & 0b11 == 0b11

    def suffix(self) -> str:
        """What a variable's name carries for these weeks: "odd", "even", "p2", "p2_odd"."""
        period, parity, both = self._first()
        side = "odd" if parity == 0 else "even"
        if self.periods == 1:
            return side
        return f"p{period}" if both else f"p{period}_{side}"

    def period(self) -> int | None:
        """The first period these weeks lie in; None for a year without periods."""
        return None if self.periods == 1 else self._first()[0]

    def held(self) -> tuple[int, ...]:
        """Every period these weeks lie in, in order; none for a year without periods.

        Usually one. Weeks of two periods are one part when a row's members do
        not tell them apart — the odd weeks of the autumn and of the spring,
        where only the even weeks have lessons of their own.
        """
        if self.periods == 1:
            return ()
        return tuple(
            period for period in range(self.periods) if (self.bits >> (2 * period)) & 0b11
        )

    def is_every_week(self) -> bool:
        """Whether these are every concrete week of the year: no week of any period is left out."""
        return self.bits == (1 << (2 * self.periods)) - 1

    def parity(self) -> str | None:
        """The gateway's name for the parity these weeks are of; None when they are of both."""
        odd = sum(1 << (2 * period) for period in range(self.periods))
        if self.bits & odd and self.bits & (odd << 1):
            return None
        return "ODD_WEEKS" if self.bits & odd else "EVEN_WEEKS"

    def __str__(self) -> str:
        # A year without periods keeps the gateway's own names, which is what
        # every name built from a week said before there were periods.
        if self.periods == 1:
            return "ODD_WEEKS" if self.bits == 0b01 else "EVEN_WEEKS"
        return self.suffix()

    def __lt__(self, other: Weeks) -> bool:
        # By name within a year without periods, as the names always sorted.
        return (self.periods, str(self), self.bits) < (other.periods, str(other), other.bits)


#: How many distinct readings the two caches below keep. A school's masks are
#: a handful, and a request reads each of them thousands of times, which is
#: what the caches are for; but an engine process lives for many requests, and
#: unbounded they would keep every mask any school ever sent. Past this the
#: least recently read is forgotten and read again when next met.
_CACHED_MASKS = 4096


@lru_cache(maxsize=_CACHED_MASKS)
def _lift(bits: int, held: int, periods: int) -> int:
    if held != 1:
        msg = f"Weeks of a year cut into {held} periods met weeks of one cut into {periods}."
        raise ValueError(msg)
    lifted = 0
    for period in range(periods):
        lifted |= bits << (2 * period)
    return lifted


ODD_WEEKS = Weeks(0b01)
EVEN_WEEKS = Weeks(0b10)
_BY_NAME: dict[str, Weeks] = {"ODD_WEEKS": ODD_WEEKS, "EVEN_WEEKS": EVEN_WEEKS}


def _weeks(value: Weeks | str | None) -> Weeks | None:
    """A parity by the gateway's name is that parity's weeks; everything else is itself."""
    if value is None or value.__class__ is Weeks:
        return value  # type: ignore[return-value]
    return _BY_NAME[value]  # type: ignore[index]


@lru_cache(maxsize=_CACHED_MASKS)
def _span(recurrence: str | None, periods: tuple[bool, ...]) -> Weeks:
    """The weeks of a mask in a parity: bit 2·p (odd) and 2·p + 1 (even) for each period p it names."""
    parity = 0b11 if recurrence is None else _BY_NAME[recurrence].bits
    bits = 0
    for period, runs in enumerate(periods):
        if runs:
            bits |= parity << (2 * period)
    return Weeks(bits, len(periods))


def weeks_of(entry: object) -> Weeks | None:
    """The weeks a requirement or a locked lesson runs in; None for every week.

    Its parity (`recurrence`) in the periods it names (`periods`), each read
    as every one when absent. The one reading of the two fields: every rule
    that asks when a lesson runs asks here.
    """
    try:
        recurrence, periods = entry.recurrence, entry.periods  # type: ignore[attr-defined]
    except AttributeError:
        # A stand-in that carries one of the two, or neither.
        recurrence = getattr(entry, "recurrence", None)
        periods = getattr(entry, "periods", None)
    if periods is None:
        return None if recurrence is None else _BY_NAME[recurrence]
    return _span(recurrence, periods if periods.__class__ is tuple else tuple(periods))


def meet(first: Weeks | str | None, second: Weeks | str | None) -> bool:
    """Whether some week holds both: every pair but two with no week in common."""
    if first is None or second is None:
        return True
    if first.__class__ is not Weeks:
        first = _BY_NAME[first]  # type: ignore[index]
    if second.__class__ is not Weeks:
        second = _BY_NAME[second]  # type: ignore[index]
    if first.periods == second.periods:  # type: ignore[union-attr]
        return bool(first.bits & second.bits)  # type: ignore[union-attr]
    periods = max(first.periods, second.periods)  # type: ignore[union-attr]
    return bool(first.lifted(periods) & second.lifted(periods))  # type: ignore[union-attr]


def whole_periods(week: Weeks | str | None) -> Weeks | None:
    """The periods these weeks lie in, in both parities; None when that is every week.

    What a row is cut by when it is held per PERIOD and not per parity: a
    teacher's own lunch (scheduler_solver._add_teacher_lunch) is one hour for
    the odd weeks and the even ones of a term, as it always was, and its own
    hour in each term. A parity alone — a year without periods — is every week
    here, so such a year is cut by nothing and builds what it built.
    """
    week = _weeks(week)
    if week is None:
        return None
    bits = 0
    for period in range(week.periods):
        if (week.bits >> (2 * period)) & 0b11:
            bits |= 0b11 << (2 * period)
    whole = Weeks(bits, week.periods)
    return None if whole.is_every_week() else whole


def alternates(weeks: Iterable[Weeks | str | None]) -> bool:
    """Whether any of these runs in some weeks only."""
    return any(runs is not None for runs in weeks)


def _size(rows: list[tuple[int, int, int]]) -> int:
    """The members of these rows, summed: what posting them costs."""
    return sum(members.bit_count() + others.bit_count() for _, members, others in rows)


def _joined(rows: list[tuple[int, int, int]], *, whatever_size: bool) -> list[tuple[int, int, int]]:
    """These rows with parts joined into their unions until they are few enough.

    Few enough is PART_LIMIT rows, or — unless `whatever_size` — no more than
    ROW_LIMIT members in all. Each row is (weeks, members, others), all as
    bits. The two whose union adds least to the larger of them go first, the
    earliest such pair on a tie, and the union stands where the earlier one
    stood — so the same rows come out in the same order on every run.
    """
    rows = list(rows)
    while len(rows) > PART_LIMIT and (whatever_size or _size(rows) > ROW_LIMIT):
        best: tuple[int, int, int] | None = None
        for first in range(len(rows)):
            _, members, others = rows[first]
            size = members.bit_count() + others.bit_count()
            for second in range(first + 1, len(rows)):
                _, other_members, other_others = rows[second]
                union = (members | other_members).bit_count() + (others | other_others).bit_count()
                grown = union - max(size, other_members.bit_count() + other_others.bit_count())
                if best is None or grown < best[0]:
                    best = (grown, first, second)
        assert best is not None
        _, first, second = best
        rows[first] = (
            rows[first][0] | rows[second][0],
            rows[first][1] | rows[second][1],
            rows[first][2] | rows[second][2],
        )
        del rows[second]
    return rows


def _maximal(rows: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    """The rows whose members are not all inside another row's."""
    return [
        row
        for index, row in enumerate(rows)
        if not any(
            (row[1] & ~other[1]) == 0 and (row[1] != other[1] or position < index)
            for position, other in enumerate(rows)
            if position != index
        )
    ]


def _by_weeks(weeks: list[Weeks | None]) -> tuple[int, dict[Weeks, int]]:
    """Which entries run in which weeks: every-week entries as bits, the rest by their weeks."""
    every = 0
    held: dict[Weeks, int] = {}
    for index, runs in enumerate(weeks):
        if runs is None:
            every |= 1 << index
        else:
            held[runs] = held.get(runs, 0) | (1 << index)
    return every, held


def each_week(
    weeks: Iterable[Weeks | str | None], *, capped: bool = False,
) -> tuple[Weeks | None, ...]:
    """The weeks these tell apart, in the order a per-week row is posted.

    `(None,)` — one week, every week — when none of them alternates.
    Otherwise the year's concrete weeks, those the same entries run in joined
    into one: the odd weeks and the even ones for a school with a parity and
    no periods, as it always was. A reader then asks of each entry whether it
    meets the week (`meet`).

    `capped` is for a soft term measured week by week: past PART_LIMIT weeks,
    two are joined and measured as one. A coarser measure, never a rule.
    """
    distinct = list(dict.fromkeys(runs for runs in map(_weeks, weeks) if runs is not None))
    if not distinct:
        return (None,)
    periods = max(runs.periods for runs in distinct)
    masks = [runs.lifted(periods) for runs in distinct]
    found: dict[int, int] = {}
    for index in range(2 * periods):
        bit = 1 << index
        signature = 0
        for position, mask in enumerate(masks):
            if mask & bit:
                signature |= 1 << position
        found[signature] = found.get(signature, 0) | bit
    rows = [(bits, signature, 0) for signature, bits in found.items()]
    if capped:
        rows = _joined(rows, whatever_size=True)
    return tuple(Weeks(bits, periods) for bits, _, _ in rows)


def week_parts(
    items: Iterable[T],
    runs_of: Callable[[T], Weeks | str | None],
    *,
    implied: bool = True,
    others: Iterable[Weeks | str | None] = (),
    capped: bool | None = None,
) -> list[tuple[Weeks | None, list[T]]]:
    """The members of one row, cut by the weeks they run in.

    `[(None, items)]` — the row as it always was — when no member runs in
    some weeks only. Otherwise one part per distinct week that has a member,
    each holding the lessons of that week in the order given, under the weeks
    it stands for. With `implied`, a week whose members all sit in another
    week's is left out (the module docstring has which rows may do that).

    `others` are the weeks of what the row reads BESIDE its items — the
    locked lessons of the teacher or the class the row is about. Two weeks
    are then one part only when the same items AND the same others run in
    both, and no week is left out as implied: the items alone cannot say
    which week the locks leave easier. A lock of the odd weeks so cuts a row
    in two with every generated lesson the same. A reader takes the locks of
    a part by asking which of them meet its weeks.

    A LARGE implied row is capped: past PART_LIMIT parts and ROW_LIMIT
    members in all, parts are joined into their unions, which is sound for
    such a row and for no other. `capped` true joins past PART_LIMIT whatever
    the size — for a soft term over a NOT IMPLIED reading, where a union is a
    coarser measure and never a rule — and false never joins.
    """
    members = list(items)
    weeks = [_weeks(runs_of(item)) for item in members]
    beside = [_weeks(runs) for runs in others]
    if not alternates(weeks) and not alternates(beside):
        return [(None, members)]
    periods = max(runs.periods for runs in (*weeks, *beside) if runs is not None)
    every, held = _by_weeks(weeks)
    every_other, held_others = _by_weeks(beside)
    lifted = [(runs.lifted(periods), inside) for runs, inside in held.items()]
    lifted_others = [(runs.lifted(periods), inside) for runs, inside in held_others.items()]
    found: dict[tuple[int, int], int] = {}
    for index in range(2 * periods):
        bit = 1 << index
        inside = every
        for mask, entries in lifted:
            if mask & bit:
                inside |= entries
        if not inside:
            continue
        outside = every_other
        for mask, entries in lifted_others:
            if mask & bit:
                outside |= entries
        found[(inside, outside)] = found.get((inside, outside), 0) | bit
    rows = [(bits, inside, outside) for (inside, outside), bits in found.items()]
    drop_implied = implied and not lifted_others
    if drop_implied:
        rows = _maximal(rows)
    if (implied if capped is None else capped) and len(rows) > PART_LIMIT:
        rows = _joined(rows, whatever_size=capped is True)
        if drop_implied:
            rows = _maximal(rows)
    # Never the whole year: a member or a lock that runs in some weeks only is
    # in one week and out of another, so no part holds every week.
    return [
        (
            Weeks(bits, periods),
            [member for index, member in enumerate(members) if inside >> index & 1],
        )
        for bits, inside, _ in rows
    ]


def tag(name: str, week: Weeks | str | None) -> str:
    """A variable's name in one week: the name itself for a row of every week."""
    week = _weeks(week)
    if week is None:
        return name
    return f"{name}_{week.suffix()}"


#: The words `named` says of a week, and the only keys a week adds to a
#: refusal's params. What decides which weeks a refusal is of, so what a
#: comparison of two refusals leaves out (refusals.py).
WEEK_WORDS = ("period", "periods", "parity")


def named(week: Weeks | str | None) -> dict[str, str | int]:
    """What a sentence counted in one week says of it: its period, and its parity if it has one.

    `period` is the index of the first period the week lies in, counted from
    0, which the gateway turns into dates, and `parity` the gateway's own
    name. A week that lies in several periods — weeks nothing counted tells
    apart — says all of them as well, `periods`, their indices in order with
    commas between ("0,2"): a flat value like every other, and only then, so a
    count made in one period says exactly what it said. Nothing at all for
    every week, and nothing for a week of a year without periods: a school
    with odd and even weeks and no periods is told what it always was.
    """
    week = _weeks(week)
    if week is None or week.periods == 1:
        return {}
    held = week.held()
    said: dict[str, str | int] = {"period": held[0]}
    if len(held) > 1:
        said["periods"] = ",".join(str(period) for period in held)
    parity = week.parity()
    if parity is not None:
        said["parity"] = parity
    return said


def together(weeks: Sequence[Weeks]) -> Weeks:
    """Several of one year's weeks as one set: what is true of each is said of them all."""
    periods = max(week.periods for week in weeks)
    bits = 0
    for week in weeks:
        bits |= week.lifted(periods)
    return Weeks(bits, periods)


def says_exactly(week: Weeks) -> bool:
    """Whether named() says these weeks and no others.

    Its words are periods and at most one parity — "the odd weeks of periods 0
    and 2". Weeks of one parity are always that: those weeks of each period
    they lie in. Weeks of both are said as their periods whole, and are more
    than they are said to be unless each of those periods is there in both:
    the odd weeks of the autumn with every week of the spring would come out
    as both terms whole.
    """
    if week.parity() is not None:
        return True
    pairs = ((week.bits >> (2 * period)) & 0b11 for period in range(week.periods))
    return all(pair == 0b11 for pair in pairs if pair)


def year_of(request: object) -> list[int]:
    """How many real weeks each period of the request's year is: [1] for a year without periods.

    The gateway's own figures where it sent them (periodWeeks), every period
    alike where it sent masks alone, and one period — the year — for every
    other payload. Divided through by what they have in common, since only
    their proportions are read.
    """
    sent = getattr(request, "period_weeks", None)
    if sent is not None:
        common = math.gcd(*sent)
        return [weeks // common for weeks in sent]
    for entry in (*request.requirements, *request.fixed_lessons):  # type: ignore[attr-defined]
        if getattr(entry, "periods", None) is not None:
            return [1] * len(entry.periods)
    return [1]


def half_weeks(request: object) -> int:
    """What `share` is counted in for this request: 1 where a parity is sent, 2 where none is.

    A week of one parity is half a real week, so shares come in halves. A
    request with no parity anywhere has only whole weeks, and every share of
    it is even: divided by this, the weights are the ones a school without
    alternating lessons always had.
    """
    entries = (*request.requirements, *request.fixed_lessons)  # type: ignore[attr-defined]
    return 1 if any(getattr(entry, "recurrence", None) is not None for entry in entries) else 2


def share(week: Weeks | str | None, period_weeks: Sequence[int]) -> int:
    """How much of the year these weeks are, in half weeks of `period_weeks`.

    `period_weeks` is how many real weeks each period is ([1] for a year
    without periods), and half of each period is odd. So the odd weeks of a
    year without periods are 1 of 2, and a week that is None — every week —
    is the whole year. For weighing a soft term measured in one week against
    the year it is a part of; no rule reads it.
    """
    week = _weeks(week)
    periods = len(period_weeks)
    if week is None:
        return 2 * sum(period_weeks)
    bits = week.lifted(periods)
    return sum(period_weeks[index // 2] for index in range(2 * periods) if bits >> index & 1)
