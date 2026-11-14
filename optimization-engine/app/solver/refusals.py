"""When two weeks' refusals are one refusal, and which of them is said.

A school with periods is refused week by week, and the weeks that are refused
alike are said together (scheduler_solver._refusal_of_most_weeks). What "alike" means is
decided here, once, for everything that is said of a week: the counted
refusals (an INFEASIBLE answer before the model), the 400s of
_verify_week, and the lines of Bästa möjliga schema.

THE RULE IS WHAT THE SCHOOL READS. Two refusals are one when they have the
same sentence (the code), the same figures (the params) and name the same
posts, rooms, rules and people (the ids). Not the week they were counted in
(`period`, `periods`, `parity`: those are what is being decided), not the
order the ids come in (a list of names read in another order is the same
list), and not the rendered message, which is made from the code and the
figures.

A 400 carries a code and params and no id lists, so its reading is those two:
what a 400 names it names in its params. That is not a second rule. Two terms
with other posts and the same figures are one 400, because what it says is the
same, and two counted refusals, whose lines name the posts, are two.

THE ONE THAT IS SAID (`of_most_weeks`) is the one whose weeks are most of the
year. A läsår starts on a Saturday, so its first two days are a period of their
own, and a teacher who has a post of her own from the first Monday is counted
there with other figures than in the autumn. Said by the first week it would
be the two days that stood first, and the autumn, which is the refusal the
school has, would not be named at all.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Hashable, Sequence
from typing import TypeVar

from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import ConflictAnalysis, ConflictDetail
from app.solver.weeks import WEEK_WORDS, Weeks, as_said, closed, says_exactly, share, together

R = TypeVar("R")


def _figures(params: dict[str, str | int | float]) -> frozenset[tuple[str, str | int | float]]:
    """The values a sentence substitutes, less the words that say which week it was counted in."""
    return frozenset((name, value) for name, value in params.items() if name not in WEEK_WORDS)


def of_line(line: ConflictDetail) -> Hashable:
    """What one line says: its sentence, its figures, and the ids it names, each kind as a set."""
    return (
        line.code,
        _figures(line.params),
        frozenset(map(str, line.requirement_ids)),
        frozenset(map(str, line.room_ids)),
        frozenset(map(str, line.constraint_ids)),
        frozenset(map(str, line.resource_ids)),
    )


def of_analysis(analysis: ConflictAnalysis) -> Hashable:
    """What a counted refusal says: its headline and the lines under it, in no order."""
    return (
        analysis.summary_code,
        _figures(analysis.summary_params),
        frozenset(Counter(map(of_line, analysis.conflicts)).items()),
    )


def of_error(error: InvalidScheduleInputError) -> Hashable:
    """What a 400 says: its code and its figures."""
    return (error.code, _figures(error.params))


def of_most_weeks(
    found: Sequence[tuple[Weeks, R]],
    same: Callable[[R], Hashable],
    period_weeks: Sequence[int],
    odd_weeks: Sequence[int] | None = None,
) -> tuple[R, list[Weeks]]:
    """The refusal that is said, and the weeks that give it: the one whose weeks are most of the year.

    `found` is each refused week and its refusal, in the order of the year.
    Weeks whose refusals are one (`same`) are one answer, and the answer whose
    weeks add up to most real weeks (weeks.share, `period_weeks` being how
    many each period has, and `odd_weeks` how many of them are odd where the
    gateway said so: without it a period's odd and even weeks weigh the same,
    and "most" is most to within a week a period) is the one said, in the
    words of its first week. The earliest of the answers that tie. The weeks
    of one answer never overlap, so their shares add.
    """
    answers: dict[Hashable, list[tuple[Weeks, R]]] = {}
    for week, refusal in found:
        answers.setdefault(same(refusal), []).append((week, refusal))
    # `max` keeps the first of equals, and a dict keeps the order the answers came in.
    best = max(
        answers.values(),
        key=lambda held: share(together([week for week, _ in held]), period_weeks, odd_weeks),
    )
    return best[0][1], [week for week, _ in best]


def said_weeks(
    held: Sequence[Weeks],
    asked: Sequence[Weeks],
    the_year_gives_it: Callable[[], bool],
    phantom: Weeks | None = None,
) -> Weeks | None:
    """The weeks a refusal is said of; None when it is the year's.

    `held` are the weeks that give it, and `asked` every week that was asked,
    which are not every week of the year when some had nothing to place. A
    refusal every asked week gives is the year's if no week was left out, or
    if the year without a post of its own gives it too (`the_year_gives_it`,
    asked only then). Otherwise the weeks that give it, as one set of weeks,
    when the words for a week say exactly those and no others
    (weeks.says_exactly); else the first of them alone, and if the words do
    not say that one either, its first CELL: a week is a group of cells that the
    same posts run in, and a group can hold one period's both parities beside
    another's one, which no words say, so its first concrete week is said and
    no period more than that (the review of #304, LÅG-1).

    `phantom` is the cells of the year that no real week is in (weeks.
    phantom_cells), filled in beside the real cell of their period in what is
    said and in what is compared with the year: a period that is one even week
    is said as the period, and the year it is a part of is every week.
    """
    if len(held) == len(asked) and (closed(together(asked), phantom).is_every_week() or the_year_gives_it()):
        return None
    said = as_said(together(held), phantom)
    if said is not None:
        return said
    first = held[0]
    real = first.bits if phantom is None else first.bits & ~phantom.lifted(first.periods)
    group = closed(Weeks(real, first.periods), phantom)
    if says_exactly(group):
        return group
    return closed(Weeks(real & -real, first.periods), phantom)
