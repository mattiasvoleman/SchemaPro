"""Åtgärdsförslag vid vägran: "solvable as it is" is said only with the strict model's proof.

SOLVABLE_AS_IS claims that the strict week has a timetable. A list of changes falls back to MAY_HELP when
the check did not finish; this verdict has nothing to fall back to, so it is given only when `verified`.
"""

from __future__ import annotations

import pytest

from app.solver import suggestions
from tests.test_best_effort import RULE, TEACHER, _payload
from tests.test_suggest_changes import _suggest


def _not_binding() -> dict[str, object]:
    # Four hours over three days at 120 a day: the cap is not what holds the week.
    return _payload(
        relax=False,
        teacherWorkRules=[{"id": RULE, "teacherId": TEACHER, "maxTeachingMinutesPerDay": 120}],
    )


def test_a_week_nothing_gave_way_in_is_not_called_solvable_when_the_check_had_no_time() -> None:
    # 45 s less the answer's slack and a solve's overrun leaves 32 s; the check's own build takes 30 of them.
    response = _suggest(_not_binding(), ceiling=45.0)
    assert response.verified is False and response.verify_seconds is None
    assert response.verdict == "NOT_FOUND"
    assert response.changes == []


def test_a_week_nothing_gave_way_in_is_not_called_solvable_when_the_strict_model_did_not_accept_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(suggestions, "strict_accepts", lambda *args, **kwargs: False)
    response = _suggest(_not_binding())
    assert response.verified is False
    assert response.verdict == "NOT_FOUND"
    assert response.verify_seconds is not None


def test_solvable_as_it_is_always_carries_the_proof() -> None:
    response = _suggest(_not_binding())
    assert response.verdict == "SOLVABLE_AS_IS"
    assert response.verified is True
    # A week with nothing on the list is solved strictly by the search itself: also proven.
    plain = _suggest(_payload(relax=False))
    assert plain.verdict == "SOLVABLE_AS_IS" and plain.verified is True
