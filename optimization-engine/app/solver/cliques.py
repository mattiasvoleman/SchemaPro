"""Klickar: the pairs of groups that share a pupil, written as a few rows over many groups instead of many rows over two (M8 PR 6).

A PAIR (A, B) IN `groupConflicts` SAYS THAT SOME PUPIL SITS BOTH, so no lesson of A may overlap a lesson of B, and the model
posts one NoOverlap over the lessons of the two for each pair. A school whose pupils are cut into groups across its classes has
2,000 to 4,000 such pairs, and the same lessons are in hundreds of those rows. Three groups that pair two and two (A–B, B–C, A–C)
say exactly what ONE NoOverlap over the lessons of all three says, and it is one row for three: a CLIQUE of the pair graph. A cover
by cliques holds every pair of the relation and no pair that is not in it, so it is the same rule written in fewer rows (on a
corpus week of nine classes, 2,661 rows against 310 for the cover; DEPLOYMENT §35.10).

WHAT IS NEVER DONE: a clique is a set of groups that ALL pair, and a path (A–B, B–C, not A–C) is not one. A and C may sit at once
when no pupil is in both, and a row over A, B and C would forbid it. `cover` takes only cliques of the graph, which is what the
property test of this module holds against the pairs themselves.

THE COVER IS GREEDY AND DETERMINISTIC: the same pairs give the same rows on every machine, in the same order (the model's
rows are in the order they are posted, and a search that reads them in another order is another search).
"""

from __future__ import annotations

from itertools import combinations
from uuid import UUID


def cover(pairs: list[tuple[UUID, UUID]], nodes: set[UUID]) -> list[tuple[UUID, ...]]:
    """Cliques of the pair graph that between them hold every pair whose two groups are in `nodes` (greedy, deterministic).

    Each clique starts from the first pair (in id order) not yet held and takes, while it can, the neighbour of every one of its
    members that holds the most pairs not yet held (ties: the group with most neighbours, then by id). It is then a MAXIMAL clique,
    so a row over it says everything its pairs say and as much more as any clique of those groups can. A pair of a group with
    itself is no pair, and a pair with a group that is not in `nodes` (a group with no lessons) holds nothing."""
    adjacent: dict[UUID, set[UUID]] = {node: set() for node in nodes}
    edges: set[frozenset[UUID]] = set()
    for first, second in pairs:
        if first == second or first not in nodes or second not in nodes:
            continue
        adjacent[first].add(second)
        adjacent[second].add(first)
        edges.add(frozenset((first, second)))
    held: set[frozenset[UUID]] = set()
    cliques: list[tuple[UUID, ...]] = []
    for first, second in sorted(tuple(sorted(edge)) for edge in edges):
        if frozenset((first, second)) in held:
            continue
        clique = [first, second]
        candidates = adjacent[first] & adjacent[second]
        while candidates:
            best = max(
                sorted(candidates),
                key=lambda node: (
                    sum(frozenset((node, member)) not in held for member in clique),
                    len(adjacent[node]),
                ),
            )
            clique.append(best)
            candidates &= adjacent[best]
        for pair in combinations(clique, 2):
            held.add(frozenset(pair))
        cliques.append(tuple(sorted(clique)))
    return cliques
