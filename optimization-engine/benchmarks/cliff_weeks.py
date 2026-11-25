#!/usr/bin/env python3
"""The witnesses of the cliff weeks (M8, 2026-11-25): where every lesson was laid, and the proof the engine accepts it.

    python benchmarks/cliff_weeks.py --list
    python benchmarks/cliff_weeks.py --verify

A CLIFF WEEK (school_corpus.CLIFF_WEEKS) is a corpus week at the lowest day end at which some road has laid it. The
sweep's weeks have random pupil groups, and a random draw may have no timetable in its frame; a week that some road has
laid has one, and `corpus/cliff_witnesses.json` is the proof: for each week the road that laid it (the engine's own
search, with its group rows as pairs or as cliques, or the year-by-year road of M8's design note), the encoding, the seed,
the deterministic work and the engine tree it was found on, the digest of the request it was found for, and the start of
EVERY lesson (weekday and clock, per requirement in the request's order).

`witness_request` pins every lesson at its start. The engine must then accept the week (that is `verify`), and the rooms it
hands out must hold: no room has two lessons at once, a lesson's room is of the type it asks for and holds its group.
That last check is made HERE, from the answer, and is not the engine's word (the review of #437, L-4: a road's own rooms
were not checked, and `periods-calendar` once left a double booking behind a `verified` that was true).

TO MAKE THE ROW AGAIN: the week is `school_corpus.build_week` of its shape (name and day end), the road is named in the
witness, and a road that is `years:*` is benchmarks/m8_paths.py `years` with the same flags. A witness that no longer matches
its week (`requestDigest`) is a corpus that changed what a shape builds: bump CORPUS_VERSION and find the witnesses again.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

ENGINE_ROOT = Path(os.environ.get("ENGINE_ROOT") or Path(__file__).resolve().parent.parent).resolve()
sys.path.insert(0, str(ENGINE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest, PinnedLesson  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402

WITNESS_FILE = Path(__file__).resolve().parent / "corpus" / "cliff_witnesses.json"


def load_witnesses() -> dict[str, dict]:
    return json.loads(WITNESS_FILE.read_text())["weeks"]


def request_digest(request: OptimizeScheduleRequest) -> str:
    blob = json.dumps(request.model_dump(mode="json", by_alias=True, exclude_none=True), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def week_of(name: str) -> corpus.CorpusWeek:
    shape = next(shape for shape in corpus.cliff_shapes() if shape.name() == name)
    return corpus.build_week(shape)


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def witness_request(week: corpus.CorpusWeek, witness: dict) -> OptimizeScheduleRequest:
    """The week with every lesson pinned at the start its witness says."""
    requirements = []
    for requirement, starts in zip(week.request.requirements, witness["lessons"], strict=True):
        if len(starts) != requirement.lessons_per_week:
            msg = f"{requirement.id} has {len(starts)} lessons in the witness and {requirement.lessons_per_week} in the week"
            raise ValueError(msg)
        pins = []
        for day, start in starts:
            hours, minutes = (int(part) for part in start.split(":"))
            begin = hours * 60 + minutes
            pins.append(PinnedLesson(
                dayOfWeek=day, startTime=_clock(begin), endTime=_clock(begin + requirement.minutes_per_lesson),
            ))
        requirements.append(requirement.model_copy(update={"pinned_lessons": pins}))
    return week.request.model_copy(update={"requirements": requirements})


def room_faults(request: OptimizeScheduleRequest, lessons) -> list[str]:
    """What is wrong with the rooms of an answer, found from the answer: two lessons in one room at once, a room of the
    wrong type, a room too small. Empty when the rooms hold."""
    rooms = {room.id: room for room in request.rooms}
    requirement = {r.id: r for r in request.requirements}
    faults: list[str] = []
    by_room: dict[object, list[tuple[int, int, int, object]]] = defaultdict(list)
    for lesson in lessons:
        r = requirement[lesson.requirement_id]
        if lesson.room_id is None:
            faults.append(f"{lesson.requirement_id}: no room")
            continue
        room = rooms.get(lesson.room_id)
        if room is None:
            faults.append(f"{lesson.requirement_id}: a room that is not in the request")
            continue
        if r.required_room_type is not None and str(room.type) != str(r.required_room_type):
            faults.append(f"{lesson.requirement_id}: needs {r.required_room_type}, is in a {room.type}")
        if room.capacity < r.student_group_size:
            faults.append(f"{lesson.requirement_id}: {r.student_group_size} pupils in a room for {room.capacity}")
        begin = _minutes(lesson.start_time)
        by_room[lesson.room_id].append((lesson.day_of_week, begin, _minutes(lesson.end_time), lesson.requirement_id))
    for room_id, held in by_room.items():
        held.sort()
        for (day, begin, end, first), (day2, begin2, _end2, second) in zip(held, held[1:]):
            if day == day2 and begin2 < end:
                faults.append(f"room {room_id}: {first} and {second} overlap on day {day}")
    return faults


def _minutes(clock: str) -> int:
    hours, minutes, _ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def verify(name: str, witness: dict) -> list[str]:
    """Everything that can be wrong with one witness; empty when the engine accepts it and the rooms hold."""
    week = week_of(name)
    faults: list[str] = []
    if request_digest(week.request) != witness["requestDigest"]:
        faults.append("the week is not the one the witness was found for (requestDigest)")
        return faults
    request = witness_request(week, witness)
    response = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=0)).solve(request)  # type: ignore[call-arg]
    if response.status not in ("OPTIMAL", "FEASIBLE"):
        faults.append(f"the engine answers {response.status} with every lesson pinned")
        return faults
    placed = defaultdict(list)
    for lesson in response.lessons:
        placed[lesson.requirement_id].append((lesson.day_of_week, lesson.start_time[:5]))
    for requirement, starts in zip(week.request.requirements, witness["lessons"], strict=True):
        if sorted(placed[requirement.id]) != sorted((day, start) for day, start in starts):
            faults.append(f"{requirement.id}: the answer moved a pinned lesson")
    faults.extend(room_faults(request, response.lessons))
    return faults


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    witnesses = load_witnesses()
    if args.list:
        for name, witness in witnesses.items():
            print(json.dumps({"name": name, **{k: v for k, v in witness.items() if k != "lessons"}}))
        return 0
    if args.verify:
        bad = 0
        for name, witness in witnesses.items():
            faults = verify(name, witness)
            print(f"{name:34s} {'ok' if not faults else '; '.join(faults)}")
            bad += bool(faults)
        return 1 if bad else 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
