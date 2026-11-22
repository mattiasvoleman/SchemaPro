"""Two small ways a corpus call went wrong without a word (M5)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402


def test_with_classes_divides_by_the_years_the_shape_will_have() -> None:
    shape = corpus.with_classes(corpus.PRODUCTION, 10, years=(8, 9))
    assert shape.years == (8, 9)
    assert shape.classes_per_year == 5
    assert shape.classes == 10
    assert corpus.build_week(shape).facts["classes"] == 10


def test_with_classes_does_not_round_a_number_of_classes_it_cannot_divide() -> None:
    """with_classes(BASE, 10) was nine classes, named n9: the week was not the one asked for."""
    for classes in (10, 8, 2):
        with pytest.raises(ValueError, match="do not divide"):
            corpus.with_classes(corpus.BASE, classes)
    with pytest.raises(ValueError, match="do not divide"):
        corpus.with_classes(corpus.BASE, 9, years=(7, 8, 9, 10))


def test_the_gate_profile_has_weeks_and_an_empty_one_would_not_be_measured_as_a_pass() -> None:
    """A loop over an empty profile is a gate that passes: the profile is the named weeks, never none."""
    assert corpus.GATE_WEEKS
    assert [shape.name() for shape in corpus.profile("gate")] == list(corpus.GATE_WEEKS)
