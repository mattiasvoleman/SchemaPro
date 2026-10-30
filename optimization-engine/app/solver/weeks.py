"""A/B-veckor: lessons that run only in odd or only in even ISO weeks.

THE ENGINE PLANS TWO WEEKS WHERE A SCHOOL HAS TWO. A school with an
alternating lesson — slöjd udda veckor, hemkunskap jämna veckor — teaches two
different weeks, and every rule the model holds over a class, a teacher or a
room is a rule about each of them. A lesson every week is in both; an
ODD_WEEKS lesson only in the odd one; an EVEN_WEEKS lesson only in the even
one. Two lessons meet when their weeks do (`meet`), which is the gateway's
weeksCanOverlap (src/calendar/lesson-recurrence.ts) for a lesson with no dates:
opposed parities never meet, everything else does.

ONE MODEL, ONE VARIABLE PER LESSON. A lesson is placed once — the same day and
hour in every week it runs — so nothing about a lesson doubles. What doubles is
a ROW over several lessons: a no-overlap, a cumulative, a count per day, a
day's first and last lesson. `week_parts` cuts the members of such a row into
the weeks they run in, and the row is posted once per part.

A ROW WITH NO ALTERNATING MEMBER IS POSTED ONCE, AS IT ALWAYS WAS. That is the
whole of the promise to a school without alternating lessons: every row of its
model is built from the same members in the same order, so the model is the
one it was, byte for byte (benchmarks/model_identity.py measures it), and
names a variable nothing it did not name before.

TWO KINDS OF ROW, and `implied` says which:

- IMPLIED (the default): a row that only gets easier when a member is taken
  out — a no-overlap, a cumulative, a cap on a count, a walk between two
  lessons. Held over the odd week's members it also holds over any subset of
  them, so when only one parity alternates (every-week lessons and some odd
  ones) the even week's members are a subset of the odd week's and its row
  says nothing new: one row, not two.
- NOT IMPLIED: a row that a missing member can break — "a class still at
  school after the rast was taught before it" is satisfied by a lesson the
  other week does not have. Every week the members run in gets its own row.

A PART IS NEVER EMPTY. A week with no member has nothing to hold.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TypeVar

from app.schemas.schedule import WeekParity

ODD_WEEKS: WeekParity = "ODD_WEEKS"
EVEN_WEEKS: WeekParity = "EVEN_WEEKS"
#: The two weeks, in the order every per-week row is posted.
WEEKS: tuple[WeekParity, ...] = (ODD_WEEKS, EVEN_WEEKS)

T = TypeVar("T")


def weeks_of(recurrence: WeekParity | None) -> tuple[WeekParity, ...]:
    """The weeks a lesson runs in: both for None, its own parity otherwise."""
    return WEEKS if recurrence is None else (recurrence,)


def meet(first: WeekParity | None, second: WeekParity | None) -> bool:
    """Whether some week holds both: every pair but odd against even."""
    return first is None or second is None or first == second


def alternates(recurrences: Iterable[WeekParity | None]) -> bool:
    """Whether any of these runs on alternate weeks only."""
    return any(recurrence is not None for recurrence in recurrences)


def week_parts(
    items: Iterable[T],
    recurrence_of: Callable[[T], WeekParity | None],
    *,
    implied: bool = True,
    alternating: bool = False,
) -> list[tuple[WeekParity | None, list[T]]]:
    """The members of one row, cut by the weeks they run in.

    `[(None, items)]` — the row as it always was — when no member alternates.
    Otherwise one part per week that has a member, each holding the lessons of
    that week in the order given: every-week lessons and the week's own. With
    `implied`, a week whose members all sit in the other week's is left out
    (the module docstring has which rows may do that).

    `alternating` cuts the row even when no item alternates, for a row whose
    OTHER members do — a rule that also reads the locked lessons, where a
    lock of the odd weeks makes the two weeks different with every generated
    lesson the same. Both weeks are then kept, implied or not: the items alone
    cannot say which week the locks leave easier.
    """
    members = list(items)
    parities = [recurrence_of(item) for item in members]
    if not alternating and not alternates(parities):
        return [(None, members)]
    parts = [
        (week, [item for item, parity in zip(members, parities) if meet(parity, week)])
        for week in WEEKS
    ]
    if implied and not alternating:
        present = set(parities)
        if EVEN_WEEKS not in present:
            parts = [parts[0]]
        elif ODD_WEEKS not in present:
            parts = [parts[1]]
    return [(week, part) for week, part in parts if part]


def tag(name: str, week: WeekParity | None) -> str:
    """A variable's name in one week: the name itself for a row of every week."""
    if week is None:
        return name
    return f"{name}_{'odd' if week == ODD_WEEKS else 'even'}"
