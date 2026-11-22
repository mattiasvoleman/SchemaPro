#!/usr/bin/env python3
"""How many conflicts a week's first search has made at each deterministic second (M5, §35.5).

    python benchmarks/corpus_trajectory.py --weeks n15-g3-m0-s1,n9-g6-m0-s1 --points 0.25,0.5,1,2,4 --out trajectory.json

WHY. `scripts/bench/solve-corpus-calibrate.mjs` asks a running engine to search a week that it
cannot solve with ONE worker and a fixed seed for a short budget; the engine's TIMEOUT answer says how
many conflicts that search made in how many seconds. Conflicts are not time, but they are work: the
same search makes the same conflicts at the same deterministic second on every machine (one worker,
a fixed seed, `corpus_measure.py` count mode). So the table written here (conflicts at each deterministic
second, for the first search of the week) turns "this many conflicts in that many seconds" on any
engine into "that many seconds for this much deterministic work": the seconds per deterministic second
of the engine's processor, with no baseline run on a quiet machine, and the same on a loaded one.

Each point is one count-mode solve of the week with a budget of that many deterministic seconds, ended
by the limit; the conflicts are those of its first search. A week that gets a timetable before a point
has no conflicts at it (`conflicts: null`), which `convert` reads as "the table ends there".
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus_measure import measure_request  # noqa: E402
from school_corpus import profile, build_week  # noqa: E402


def trajectory(request, points: list[float], seed: int = 1) -> list[dict[str, object]]:
    """[{work, conflicts, deterministic}] for each budget in `points`, from first searches that the budget ended."""
    out: list[dict[str, object]] = []
    for point in points:
        result = measure_request(request, mode="count", deterministic_budget=point, seed=seed)
        first = result["searches"][0] if result["searches"] else None
        ended_by_budget = first is not None and first["status"] == "UNKNOWN"
        out.append({
            "work": point,
            "deterministic": first["deterministic"] if first else None,
            "conflicts": first["conflicts"] if ended_by_budget else None,
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weeks", required=True, help="names from the sweep, comma separated")
    parser.add_argument("--points", default="0.25,0.5,1,2,4", help="deterministic seconds, comma separated")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    points = [float(p) for p in args.points.split(",")]
    wanted = args.weeks.split(",")
    shapes = {shape.name(): shape for shape in profile("sweep")}
    missing = [w for w in wanted if w not in shapes]
    if missing:
        parser.error(f"not in the sweep: {', '.join(missing)}")
    result = {name: trajectory(build_week(shapes[name]).request, points) for name in wanted}
    Path(args.out).write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
