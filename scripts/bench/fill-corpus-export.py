#!/usr/bin/env python3
"""Korpusens vittnesveckor som JSON för E7a:s prov (`scripts/bench/fill-corpus.ts`).

    ENGINE_ROOT=<träd>/optimization-engine <venv>/bin/python scripts/bench/fill-corpus-export.py <ut-katalog> [vecka ...]

Läser motorns korpus (`benchmarks/school_corpus.py`) och dess vittnen (`benchmarks/cliff_weeks.py`) och rör ingenting i
`optimization-engine/`: scriptet importerar bara. För varje klippvecka (eller de namngivna) ger det en fil `<namn>.json` med

  - veckans begäran som motorn tar den (krav, grupper, salar, tillgänglighet, ramtider, lunchfönster, gruppar som delar en elev);
  - vittnets lektioner med de salar motorn delar ut när varje lektion är fastlåst på sitt vittnesläge (samma körning som
    `cliff_weeks.py --verify` gör, och samma kontroll av salarna), och de luncher motorn lägger då;
  - elevernas listor över grupper (`cohorts`: en post för varje OLIKA lista en elev har), som begäran själv inte bär.

Vittnet säger var varje lektion ligger, inte i vilken sal. Salarna och lunchen kommer därför ur motorns svar med allt fastlåst.
En vecka vars vittne motorn inte längre tar (digesten) eller vars salar inte håller hoppas över med skälet, aldrig tyst.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ENGINE_ROOT = Path(os.environ.get("ENGINE_ROOT") or Path(__file__).resolve().parents[2] / "optimization-engine").resolve()
sys.path.insert(0, str(ENGINE_ROOT))
sys.path.insert(0, str(ENGINE_ROOT / "benchmarks"))
os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

import cliff_weeks  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402


def export_week(name: str, witness: dict, out_dir: Path) -> str | None:
    week = cliff_weeks.week_of(name)
    if cliff_weeks.request_digest(week.request) != witness["requestDigest"]:
        return "veckan är inte den vittnet hittades för (requestDigest)"
    request = cliff_weeks.witness_request(week, witness)
    response = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=0)).solve(request)  # type: ignore[call-arg]
    if response.status not in ("OPTIMAL", "FEASIBLE"):
        return f"motorn svarar {response.status} med varje lektion fastlåst"
    faults = cliff_weeks.room_faults(request, response.lessons)
    if faults:
        return "salarna håller inte: " + "; ".join(faults[:3])
    plain = week.request.model_dump(mode="json", by_alias=True, exclude_none=True)
    for requirement in plain["requirements"]:
        requirement.pop("pinnedLessons", None)
    document = {
        "name": name,
        "shape": witness["shape"],
        "dayEnd": witness["dayEnd"],
        "corpusVersion": 2,
        "request": plain,
        "lessons": [
            {
                "requirementId": str(lesson.requirement_id),
                "roomId": None if lesson.room_id is None else str(lesson.room_id),
                "dayOfWeek": lesson.day_of_week,
                "startTime": lesson.start_time,
                "endTime": lesson.end_time,
            }
            for lesson in response.lessons
        ],
        "lunches": [
            {"studentGroupId": str(lunch.student_group_id), "dayOfWeek": lunch.day_of_week, "startTime": lunch.start_time, "endTime": lunch.end_time}
            for lunch in response.lunches
        ],
        "cohorts": [sorted(str(group) for group in cohort) for cohort in week.cohorts],
    }
    (out_dir / f"{name}.json").write_text(json.dumps(document, separators=(",", ":")))
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    witnesses = cliff_weeks.load_witnesses()
    names = sys.argv[2:] or list(witnesses)
    skipped = 0
    for name in names:
        reason = export_week(name, witnesses[name], out_dir)
        print(f"{name:34s} {'skrivet' if reason is None else 'HOPPAS ÖVER: ' + reason}", flush=True)
        skipped += reason is not None
    return 1 if skipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
