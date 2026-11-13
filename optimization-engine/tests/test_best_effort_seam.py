"""Bästa möjliga schema (G2) beside Placeringsregler (G3): the two arguments of the seam that nothing pinned.

test_best_effort_placement.py pins the seam for a hard rule 3, a shared hall under a lock and a wish priced once. These two
are what its review (#284, third round, LÅG-1) found still unpinned, each with the mutant that shows it: the solver passes the
building key to `_add_room_allocation` and `shared_counted` to `_add_fixed_lesson_constraints` also when the mode is on, and
dropping either of them in the mode left every test green.

- Without the building key in the mode, a soft building limit (one building a day for a class, price 250) is no longer the thing
  that pulls the class's two lessons to one house: two wishes of price 5 each win, and the lessons are put in two.
- Without `shared_counted` in the mode, a lock that says how many pupils it seats takes the whole shared hall, so a week that
  has room for a class of 20 beside 30 locked pupils in a hall of 50 is refused as infeasible.

Both hold on the engine as it is; they fail on the mutants and nowhere else.
"""

from __future__ import annotations

from uuid import uuid4

from tests import test_placement as tp

BEST_EFFORT = {"mode": "BEST_EFFORT"}


def test_a_soft_building_limit_is_kept_in_the_mode_too() -> None:
    """Two wishes pull the class's lessons to different buildings; the limit (price 250) wins in the mode as it does strictly."""
    ra, rb, rc = tp._room(None, building="A"), tp._room(None, building="B"), tp._room(None, building="C")
    s1, s2, other = str(uuid4()), str(uuid4()), str(uuid4())
    requirements = [
        tp._requirement(s1, tp.CLASS_7A, maxLessonsPerDay=1),
        tp._requirement(s2, tp.CLASS_7A, maxLessonsPerDay=1),
        tp._requirement(other, tp.CLASS_7B, maxLessonsPerDay=1),
    ]
    preferences = [
        {"id": str(uuid4()), "subjectId": s1, "kind": "WISH", "roomType": None, "roomIds": [ra["id"]], "weight": 5},
        {"id": str(uuid4()), "subjectId": s2, "kind": "WISH", "roomType": None, "roomIds": [rb["id"]], "weight": 5},
        # A lock on a subject that has nothing to do with it: the mode has something to price.
        {"id": str(uuid4()), "subjectId": other, "kind": "LOCK", "roomType": None, "roomIds": [rc["id"]], "weight": 5},
    ]
    payload = tp._payload(
        requirements,
        rooms=[ra, rb, rc],
        roomPreferences=preferences,
        placementRules=tp._places("SOFT", 250, maxClassBuildings=1),
        relaxation=BEST_EFFORT,
    )

    response = tp._solve(payload, day_end=660)

    buildings = {str(ra["id"]): "A", str(rb["id"]): "B"}
    ours = {str(requirements[0]["id"]), str(requirements[1]["id"])}
    used = {buildings[str(lesson.room_id)] for lesson in response.lessons if str(lesson.requirement_id) in ours}
    assert response.status in {"OPTIMAL", "FEASIBLE"}
    assert len(used) == 1
    assert response.deviations == []


def test_a_lock_that_says_its_pupils_takes_seats_in_the_shared_hall_in_the_mode_too() -> None:
    """30 pupils locked at 08:00 in a hall of 50: a class of 20 fits beside them, strictly and in the mode."""
    hall = tp._gym(capacity=50)
    locked = {
        "id": str(uuid4()),
        "teacherId": str(uuid4()),
        "studentGroupId": tp.CLASS_7B,
        "roomId": hall["id"],
        "dayOfWeek": 1,
        "startTime": "08:00:00",
        "endTime": "09:00:00",
        "studentCount": 30,
    }
    requirements = [tp._requirement(tp.IDROTT, tp.CLASS_7A, requiredRoomType="GYM", size=20, maxLessonsPerDay=1)]
    lock = {"id": str(uuid4()), "subjectId": tp.IDROTT, "kind": "LOCK", "roomType": None, "roomIds": [hall["id"]], "weight": 5}
    for extra in ({}, {"relaxation": BEST_EFFORT}):
        payload = tp._payload(
            requirements,
            rooms=[hall],
            fixedLessons=[locked],
            roomPreferences=[lock],
            placementRules=tp._shared("HARD"),
            **extra,
        )

        response = tp._solve(payload, day_end=540)

        assert response.status in {"OPTIMAL", "FEASIBLE"}, extra
        assert len(response.lessons) == 1
