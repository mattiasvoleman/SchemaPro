"""The cliff weeks of the corpus (M8, PR 3): each stands at its lowest day end and has a witness the engine accepts.

A random draw of pupils may have no timetable in its frame, and a corpus week that is TIMEOUT cannot say which. A cliff
week is one that some road HAS laid, at the lowest day end it was laid at, and `benchmarks/corpus/cliff_witnesses.json`
says where every lesson went. What is held here:

  * the weeks are the sweep's weeks with a day end and nothing else, and every one has a witness (and no witness is
    without a week);
  * the engine accepts each week with every lesson pinned at its witnessed start, and does not move one, and the rooms it
    hands out hold when read from the answer (two lessons in a room at once, the wrong type, too small);
  * a witness belongs to the week it was found for (`requestDigest`): a corpus that changes what a shape builds fails here
    and the witnesses must be found again;
  * the room check can say no (a double booking, the wrong type, a room too small).
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import cliff_weeks as cliff  # noqa: E402
import school_corpus as corpus  # noqa: E402

WITNESSES = cliff.load_witnesses()
ROADS = ("monolith:pairs", "monolith:cliques", "monolith:cohorts", "years:down", "years:hardest", "years:up", "years:coupled")


def test_the_cliff_weeks_are_sweep_weeks_with_a_day_end_and_each_has_a_witness() -> None:
    shapes = corpus.cliff_shapes()
    names = [shape.name() for shape in shapes]
    assert names and len(set(names)) == len(names)
    assert set(names) == set(WITNESSES), "a cliff week without a witness, or a witness without a week"
    sweep = {shape.name(): shape for shape in corpus.sweep_shapes()}
    for (base, end), shape in zip(corpus.CLIFF_WEEKS, shapes, strict=True):
        assert shape.day[1] == f"{end}:00"
        assert shape.day[:1] == sweep[base].day[:1] and shape.day[2] == sweep[base].day[2]
        assert (shape.day[1] == "16:00:00") == (shape.name() == base), "the name says the day end, and only when it is not 16:00"
        assert shape.term_subjects == 0, "the gate does not cover terms, and the cliff weeks keep to that"


def test_the_cliff_profile_is_a_profile_the_measuring_stick_reads() -> None:
    assert [shape.name() for shape in corpus.profile("cliff")] == [shape.name() for shape in corpus.cliff_shapes()]


@pytest.mark.parametrize("name", sorted(WITNESSES))
def test_the_engine_accepts_the_week_with_every_lesson_pinned_where_the_witness_says_and_the_rooms_hold(name: str) -> None:
    assert cliff.verify(name, WITNESSES[name]) == []


@pytest.mark.parametrize("name", sorted(WITNESSES))
def test_a_witness_says_how_it_was_found_so_that_the_row_can_be_made_again(name: str) -> None:
    witness = WITNESSES[name]
    assert witness["road"] in ROADS
    assert isinstance(witness["seed"], int) and witness["work"] > 0
    assert witness["deterministicBudget"] == 4.0 and witness["engine"]
    assert witness["dayEnd"] == next(end for base, end in corpus.CLIFF_WEEKS if _name(base, end) == name)
    assert len(witness["lessons"]) == len(cliff.week_of(name).request.requirements)


def _name(base: str, end: str) -> str:
    return base if end == "16:00" else f"{base}-e{end.replace(':', '')}"


def _lesson(requirement_id, room_id, day, begin, end):  # noqa: ANN001, ANN202
    return SimpleNamespace(
        requirement_id=requirement_id, room_id=room_id, day_of_week=day,
        start_time=f"{begin // 60:02d}:{begin % 60:02d}:00", end_time=f"{end // 60:02d}:{end % 60:02d}:00",
    )


def test_the_room_check_says_no_to_a_double_booking_a_wrong_type_and_a_room_too_small() -> None:
    request = corpus.build_week(corpus.with_classes(corpus.BASE, 6, seed=1)).request
    plain = next(r for r in request.requirements if r.required_room_type is None)
    other = next(r for r in request.requirements if r is not plain and r.required_room_type is None)
    lab = next(r for r in request.requirements if r.required_room_type == "LABORATORY")
    classroom = next(room for room in request.rooms if str(room.type) == "CLASSROOM")
    laboratory = next(room for room in request.rooms if str(room.type) == "LABORATORY")

    ok = [_lesson(plain.id, classroom.id, 1, 480, 540), _lesson(other.id, classroom.id, 1, 540, 600)]
    assert cliff.room_faults(request, ok) == []

    double = [_lesson(plain.id, classroom.id, 1, 480, 540), _lesson(other.id, classroom.id, 1, 500, 560)]
    assert any("overlap" in fault for fault in cliff.room_faults(request, double))

    wrong_type = [_lesson(lab.id, classroom.id, 1, 480, 540)]
    assert any("needs LABORATORY" in fault for fault in cliff.room_faults(request, wrong_type))

    big = plain.model_copy(update={"student_group_size": 33})
    small_room = request.model_copy(update={"requirements": [big], "rooms": [classroom.model_copy(update={"capacity": 30})]})
    assert any("pupils in a room for" in fault for fault in cliff.room_faults(small_room, [_lesson(big.id, classroom.id, 1, 480, 540)]))

    nowhere = [_lesson(plain.id, None, 1, 480, 540)]
    assert any("no room" in fault for fault in cliff.room_faults(request, nowhere))
    assert laboratory.id != classroom.id


# ---- verify() itself: each check it makes has a test that can see it go (g455, mutants M1, M3, M2, M4) -----------------

_REAL_SOLVER = cliff.SchedulerSolver
_NAME = "n9-g6-m0-s1"


def _tamper(monkeypatch: pytest.MonkeyPatch, change) -> None:  # noqa: ANN001
    """`verify` against the engine's own answer with `change` done to its lessons afterwards: what does it say to a wrong one?"""

    class Tampering:
        def __init__(self, settings) -> None:  # noqa: ANN001
            self._solver = _REAL_SOLVER(settings)

        def solve(self, request):  # noqa: ANN001, ANN202
            response = self._solver.solve(request)
            return response.model_copy(update={"lessons": change(list(response.lessons))})

    monkeypatch.setattr(cliff, "SchedulerSolver", Tampering)


def test_verify_says_no_to_an_answer_that_books_one_room_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    """The room check of the PR is a function with its own test; this holds that `verify` CALLS it on the engine's answer."""

    def double_book(lessons):  # noqa: ANN001, ANN202
        for first in lessons:
            for other in lessons:
                if (
                    other is not first and other.day_of_week == first.day_of_week and other.room_id != first.room_id
                    and other.start_time < first.end_time and first.start_time < other.end_time
                ):
                    return [lesson.model_copy(update={"room_id": first.room_id}) if lesson is other else lesson for lesson in lessons]
        msg = "no two lessons of the answer overlap in time"
        raise AssertionError(msg)

    _tamper(monkeypatch, double_book)
    faults = cliff.verify(_NAME, WITNESSES[_NAME])
    assert any("overlap" in fault for fault in faults), faults


def test_verify_says_no_to_an_answer_that_moved_a_pinned_lesson(monkeypatch: pytest.MonkeyPatch) -> None:
    def move_one(lessons):  # noqa: ANN001, ANN202
        first = lessons[0]
        return [first.model_copy(update={"day_of_week": first.day_of_week % 5 + 1}), *lessons[1:]]

    _tamper(monkeypatch, move_one)
    faults = cliff.verify(_NAME, WITNESSES[_NAME])
    assert any("moved a pinned lesson" in fault for fault in faults), faults


def test_verify_says_no_to_a_witness_found_for_another_week() -> None:
    stale = {**WITNESSES[_NAME], "requestDigest": "0" * 64}
    assert cliff.verify(_NAME, stale) == ["the week is not the one the witness was found for (requestDigest)"]


def test_verify_says_no_when_the_pinned_week_is_one_the_engine_refuses() -> None:
    """Two posts of one teacher at one time: the engine must say no with every lesson pinned, and `verify` must say that."""
    week = cliff.week_of(_NAME)
    witness = copy.deepcopy(WITNESSES[_NAME])
    posts_of: dict[object, list[int]] = {}
    for index, requirement in enumerate(week.request.requirements):
        if requirement.teacher_id is not None:
            posts_of.setdefault(requirement.teacher_id, []).append(index)
    first, second = next(posts[:2] for posts in posts_of.values() if len(posts) >= 2)
    witness["lessons"][second][0] = list(witness["lessons"][first][0])
    faults = cliff.verify(_NAME, witness)
    assert any("with every lesson pinned" in fault for fault in faults), faults
