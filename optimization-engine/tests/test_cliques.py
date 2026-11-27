"""Klickar (M8 PR 6): the pairs of groups that share a pupil, held by cliques of the pair graph.

`cliques.cover` is the combinatorial half of the rule: what it returns holds every pair it was given (so a row over a clique
forbids everything the pairs forbid) and holds nothing the pairs do not (so a row forbids nothing the school did not say). The
engine's half, that the rows posted for the cover keep exactly the timetables the rows posted for the pairs keep, is held by
tests/test_group_cliques_model.py.
"""

from __future__ import annotations

import random
import uuid
from itertools import combinations

import pytest

from app.solver import cliques


def _ids(count: int) -> list[uuid.UUID]:
    return [uuid.UUID(int=index + 1, version=4) for index in range(count)]


def _held(rows: list[tuple[uuid.UUID, ...]]) -> set[frozenset[uuid.UUID]]:
    return {frozenset(pair) for row in rows for pair in combinations(row, 2)}


def test_three_groups_that_pair_two_and_two_are_one_row() -> None:
    a, b, c = _ids(3)

    rows = cliques.cover([(a, b), (b, c), (a, c)], {a, b, c})

    assert [set(row) for row in rows] == [{a, b, c}]


def test_a_path_is_not_a_clique_and_its_ends_may_sit_at_once() -> None:
    """A and C share no pupil: a row over A, B and C would forbid them to overlap and the school never said that."""
    a, b, c = _ids(3)

    rows = cliques.cover([(a, b), (b, c)], {a, b, c})

    assert sorted(sorted(row) for row in rows) == sorted([sorted((a, b)), sorted((b, c))])
    assert frozenset((a, c)) not in _held(rows)


def test_a_pair_with_itself_and_a_pair_with_a_group_that_has_no_lessons_hold_nothing() -> None:
    a, b, ghost = _ids(3)

    rows = cliques.cover([(a, a), (a, ghost), (ghost, b)], {a, b})

    assert rows == []


def test_the_cover_holds_every_pair_and_only_the_pairs_of_the_relation() -> None:
    for seed in range(40):
        rnd = random.Random(seed)
        nodes = _ids(rnd.randint(2, 14))
        pairs = [(a, b) for a, b in combinations(nodes, 2) if rnd.random() < rnd.choice((0.15, 0.4, 0.8))]
        wanted = {frozenset(pair) for pair in pairs}

        rows = cliques.cover(pairs, set(nodes))

        assert _held(rows) == wanted, f"seed {seed}: the rows hold other pairs than the relation"
        assert all(wanted >= {frozenset(pair) for pair in combinations(row, 2)} for row in rows), (
            f"seed {seed}: a row has two groups that do not pair"
        )
        assert all(len(row) >= 2 for row in rows)


def test_the_cover_is_the_same_whatever_order_the_pairs_come_in() -> None:
    nodes = _ids(10)
    rnd = random.Random(5)
    pairs = [(a, b) for a, b in combinations(nodes, 2) if rnd.random() < 0.5]
    first = cliques.cover(pairs, set(nodes))

    shuffled = [(b, a) if rnd.random() < 0.5 else (a, b) for a, b in pairs]
    rnd.shuffle(shuffled)

    assert cliques.cover(shuffled, set(nodes)) == first


def test_a_dense_relation_is_far_fewer_rows_than_pairs() -> None:
    """The point of it: nine classes whose pupils are cut across them pair 2,000 times and are a few hundred cliques."""
    nodes = _ids(40)
    rnd = random.Random(1)
    # Eight cohorts of five groups each, pairing among themselves: 8 * 10 pairs, and 8 rows.
    cohorts = [nodes[i * 5:(i + 1) * 5] for i in range(8)]
    pairs = [pair for cohort in cohorts for pair in combinations(cohort, 2)]
    rnd.shuffle(pairs)

    rows = cliques.cover(pairs, set(nodes))

    assert len(pairs) == 80 and len(rows) == 8
    assert _held(rows) == {frozenset(pair) for pair in pairs}


@pytest.mark.parametrize("count", [0, 1])
def test_fewer_than_two_groups_have_no_rows(count: int) -> None:
    nodes = set(_ids(count))

    assert cliques.cover([], nodes) == []
