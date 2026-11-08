"""Bästa möjliga schema (G2) beside Placeringsregler (G3): what each does to the other.

TWO REGELSYSTEM IN ONE MODEL, and this file pins the seam so that nobody has to
find it out again:

- A HARD placement rule is not on G2's list (relaxation.RELAXABLE_RULES) and
  never gives way: of the three rules only rule 3, the pupils of a shared room
  fitting its capacity, can be HARD (rules 1 and 2 are OFF or SOFT, by CHECK in
  the database, until a hard one is measured). The mode refuses a week it cannot
  keep, with the strict words, and `strip()` leaves the rule in.
- A SOFT placement rule is a price in the soft objective in both modes. The mode
  neither prices it a second time nor lists it as a deviation.
- A room LOCK (G2) and a shared room (G3) both reshape the room partition
  (`_add_room_allocation`): the lock's rooms join it as a preference set and the
  shared room is a class of its own. Both in one build must keep the hall within
  its seats while the lock is priced.

The weeks are the arithmetic of test_placement.py and test_best_effort.py: one
Monday slot of 60 minutes unless said.
"""

from __future__ import annotations

from uuid import UUID, uuid4

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.relaxation import HARD_RULES, Relax, strip
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_placement as tp

BEST_EFFORT = {"mode": "BEST_EFFORT"}


def _hall(capacity: int = 50) -> dict[str, object]:
    return {"id": str(uuid4()), "type": "GYM", "capacity": capacity, "shareable": True}


def _lock(subject: str, room: dict[str, object]) -> dict[str, object]:
    return {"id": str(uuid4()), "subjectId": subject, "kind": "LOCK", "roomType": None, "roomIds": [room["id"]], "weight": 5}


def _classes(pupils: int, count: int) -> list[dict[str, object]]:
    """`count` classes of `pupils`, each with one idrott lesson a week."""
    return [
        tp._requirement(tp.IDROTT, str(uuid4()), size=pupils, maxLessonsPerDay=1)
        for _ in range(count)
    ]


def _deviation_codes(response) -> list[str]:  # noqa: ANN001
    return [detail.code for detail in response.deviations or []]


class TestAHardSharedRoomNeverGivesWay:
    def test_it_is_among_the_rules_that_never_do(self) -> None:
        assert any("shared room" in rule for rule in HARD_RULES)
        assert len(HARD_RULES) == len(set(HARD_RULES))

    def test_the_strip_leaves_the_placement_rules_in(self) -> None:
        payload = tp._payload(
            _classes(30, 2), rooms=[_hall()], placementRules=tp._shared("HARD"), relaxation=BEST_EFFORT,
        )
        request = OptimizeScheduleRequest.model_validate(payload)

        assert strip(request).placement_rules == request.placement_rules
        assert strip(request).placement_rules is not None

    def test_a_week_the_hall_cannot_hold_is_refused_by_name_in_the_mode_too(self) -> None:
        # 30 + 30 pupils in a hall of 50 at the one hour there is. The mode has
        # something it could price (a per-day cap on each class), and still the
        # hall's capacity is not among it: the answer is the strict one.
        hall = _hall(50)
        payload = tp._payload(_classes(30, 2), rooms=[hall], placementRules=tp._shared("HARD"), relaxation=BEST_EFFORT)

        response = tp._solve(payload, day_end=540)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "SHARED_ROOM_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}
        assert not response.lessons

    def test_a_locked_hall_that_is_over_full_is_priced_and_never_over_seated(self) -> None:
        # Three classes of 20 locked to a hall of 50 at the one hour there is.
        # Strict has no week; the mode puts ONE class in the other room (the
        # lock gives way, and says so), and the two that stay are 40 pupils.
        hall, other = _hall(50), {"id": str(uuid4()), "capacity": 30}
        payload = tp._payload(
            _classes(20, 3), rooms=[hall, other], placementRules=tp._shared("HARD"),
            roomPreferences=[_lock(tp.IDROTT, hall)], relaxation=BEST_EFFORT,
        )

        response = tp._solve(payload, day_end=540)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _deviation_codes(response) == ["DEVIATION_ROOM_LOCK"]
        assert response.deviations is not None and response.deviations[0].params["lessons"] == 1
        in_hall = [lesson for lesson in response.lessons if lesson.room_id == UUID(str(hall["id"]))]
        assert len(in_hall) == 2
        assert 20 * len(in_hall) <= 50
        assert len(response.lessons) == 3

        # The same week, strict, is refused: the lock and the hall together have no timetable.
        strict = {key: value for key, value in payload.items() if key != "relaxation"}
        refused = tp._solve(strict, day_end=540)
        assert refused.status == "INFEASIBLE" or not refused.lessons

    def test_a_hall_that_holds_all_three_gives_the_lock_no_reason_to_give_way(self) -> None:
        hall, other = _hall(80), {"id": str(uuid4()), "capacity": 30}
        payload = tp._payload(
            _classes(20, 3), rooms=[hall, other], placementRules=tp._shared("HARD"),
            roomPreferences=[_lock(tp.IDROTT, hall)], relaxation=BEST_EFFORT,
        )

        response = tp._solve(payload, day_end=540)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert response.deviations == []
        assert {str(lesson.room_id) for lesson in response.lessons} == {str(hall["id"])}


class TestAHardRuleOneOrTwoThatTheEngineStillBuildsStaysHard:
    """The gateway offers rules 1 and 2 as OFF or SOFT only, and the database keeps HARD out of the Skolregler,
    but the engine builds all six; a request that carries one (an older gateway, the benchmarks) must keep it
    in the mode: it is not on G2's list, so it neither is priced nor dropped."""

    def test_a_hard_rule_1_that_the_week_cannot_keep_is_refused_by_name_in_the_mode_too(self) -> None:
        # Two groups that share pupils with 7A and not with each other, one hour: idrott of the one and a
        # locked lesson of the other start together, so neither is before the other (test_placement.py).
        group_one, group_two = str(uuid4()), str(uuid4())
        lock = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": group_two, "dayOfWeek": 1,
            "startTime": "08:00:00", "endTime": "09:00:00",
        }
        payload = tp._payload(
            [tp._requirement(tp.IDROTT, group_one, size=10, maxLessonsPerDay=1)],
            groups=[{"id": tp.CLASS_7A, "lunchHeadcount": 20}],
            groupConflicts=[[tp.CLASS_7A, group_one], [tp.CLASS_7A, group_two]],
            fixedLessons=[lock],
            placementRules=tp._edges("HARD", (tp.IDROTT, True, False)),
            relaxation=BEST_EFFORT,
        )

        response = tp._solve(payload, day_end=540)

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        assert "SUBJECT_EDGE_CANNOT_BE_KEPT" in {detail.code for detail in response.conflicts.conflicts}
        assert not response.lessons


class TestASoftPlacementRuleIsPaidOnceAndIsNoDeviation:
    def _request(self) -> OptimizeScheduleRequest:
        # Idrott not first and not last, SOFT, beside a lesson of its class, and
        # a per-day cap that gives the mode something it could price.
        group = str(uuid4())
        requirements = [
            tp._requirement(tp.IDROTT, group, maxLessonsPerDay=1),
            tp._requirement(tp.MATTE, group),
        ]
        return OptimizeScheduleRequest.model_validate(
            tp._payload(requirements, placementRules=tp._edges("SOFT", (tp.IDROTT, True, True)), relaxation=BEST_EFFORT),
        )

    def test_the_wish_is_built_once_in_the_mode_as_it_is_in_the_strict_solve(self) -> None:
        request = self._request()
        solver = SchedulerSolver(tp._settings(day_end=600))

        strict, *_ = solver._build_model(
            request.model_copy(update={"relaxation": None}), use_assumptions=False, include_objective=True,
        )
        priced, *_ = solver._build_model(
            request, use_assumptions=False, include_objective=True, relax=Relax(solver._grid.slot_minutes),
        )

        def wishes(model: object) -> int:
            return sum(1 for variable in model.Proto().variables if variable.name.startswith("edge_unmet"))  # type: ignore[attr-defined]

        assert wishes(strict) > 0
        assert wishes(priced) == wishes(strict)

    def test_a_wish_that_cannot_be_kept_is_no_deviation(self) -> None:
        # One lesson a week and the wish "not first, not last": it cannot hold,
        # the week is placed all the same, and the list says nothing gave way.
        group = str(uuid4())
        payload = tp._payload(
            [tp._requirement(tp.IDROTT, group, maxLessonsPerDay=1)],
            placementRules=tp._edges("SOFT", (tp.IDROTT, True, True)), relaxation=BEST_EFFORT,
        )

        response = tp._solve(payload, day_end=600, **tp.QUIET)

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 1
        assert response.deviations == []
