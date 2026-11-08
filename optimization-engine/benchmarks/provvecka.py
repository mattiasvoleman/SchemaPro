#!/usr/bin/env python3
"""A provvecka at a högstadium school: 20-30 prov, three exam rooms, ~55 teachers.

The exam planner (POST /api/v1/plan-exams, app/solver/exam_solver.py) is a
small model with a big number of choices: every exam picks a time among 35-60
candidates, a split of its writers over three rooms and a handful of
invigilators out of a pool where half the teachers are teaching at any hour.
This builds that week, deterministically from a seed, and measures how long
the solve takes.

    python benchmarks/provvecka.py                       # one solve, a summary
    python benchmarks/provvecka.py --seed 3 --budget 60 --json
    python benchmarks/provvecka.py --pairs 20 --budget 60 --out DIR   # the measurement

THE SHAPE. Years 7-9, four classes each (12 classes of 25). Per year two or
three year-wide prov (all four classes, 100 writers) and per class one or two
of its own (25 writers), a few of them nationella prov (fixed, one slot).
Exam rooms of 30, 60 and 90 seats, so a year-wide exam takes two or three
rooms and a class's exam one. A five-day window with a start every hour
between 08:00 and 14:00 (--starts-per-day 7, 35 candidate times; 12 gives a
start every half hour, 60), each time priced by the lesson minutes it cancels
(loss). Fifty-five teachers with a weekly timetable of their own: every one
is busy at about half of the hours, the same hours for every exam, and the
rooms at a fifth of them. A prior of 0-300 invigilation minutes per teacher
is the year's counter. At most one exam a day and four a week per class.

THE MEASUREMENT (--pairs N). Wall-clock on this Mac is a fact about the host
as much as the model: eleven other sessions share it. So every trial runs the
exam solve and a FIXED reference problem (a 15x15 job-shop stopped after a fixed
amount of deterministic work, the same on every trial) at the same moment, in two processes started together, and the figure
that means anything is the exam's time DIVIDED BY the reference's — the host's
load hits both. Median and p95 over N trials with different seeds (a different
week each), at --workers workers each. The incumbent's trajectory is recorded
too, so a single run at a long budget also says what a shorter one would have
returned: the best plan found by 10, 20 and 60 seconds.

    --child exam|ref are the two processes; they print one JSON line.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

REFERENCE_DETERMINISTIC_SECONDS = 0.5
AFTER_SEARCH_SECONDS = 0.25     # exam_solver.AFTER_SEARCH_SECONDS, kept in step by hand

_NS = uuid.UUID("7c0e2d1a-3b5f-4e68-8a91-5d4c3b2a1f00")

YEARS = (7, 8, 9)
CLASSES_PER_YEAR = 4
PUPILS_PER_CLASS = 25
ROOM_SEATS = (30, 60, 90)
TEACHERS = 55
DAYS = 5
FIRST_HOUR = 8


def _uid(label: str) -> str:
    """A deterministic version-4 UUID (the schema pins every id to UUID4)."""
    return str(uuid.UUID(int=uuid.uuid5(_NS, label).int, version=4))


def build_week(
    seed: int,
    *,
    exams: int = 26,
    starts_per_day: int = 7,
    day_cap: int = 1,
    week_cap: int = 4,
) -> dict:
    """One provvecka as the gateway's request body (camelCase JSON)."""
    rng = random.Random(seed)
    klass = {
        (year, index): _uid(f"class:{year}:{index}")
        for year in YEARS for index in range(CLASSES_PER_YEAR)
    }
    rooms = [{"id": _uid(f"room:{i}"), "seats": seats} for i, seats in enumerate(ROOM_SEATS)]
    # Each teacher's and each room's own week: busy at an hour or free.
    teacher_busy = [
        {(d, h) for d in range(DAYS) for h in range(FIRST_HOUR, 16) if rng.random() < 0.5}
        for _ in range(TEACHERS)
    ]
    room_busy = [
        {(d, h) for d in range(DAYS) for h in range(FIRST_HOUR, 16) if rng.random() < 0.2}
        for _ in rooms
    ]
    teachers = [
        {"id": _uid(f"teacher:{i}"), "prior": 30 * rng.randint(0, 10)} for i in range(TEACHERS)
    ]

    # Which classes each exam is for: year-wide first, then one class's own.
    plan: list[tuple[list[tuple[int, int]], int, bool]] = []
    for year in YEARS:
        for _ in range(rng.choice((2, 3))):
            plan.append(([(year, i) for i in range(CLASSES_PER_YEAR)],
                         rng.choice((60, 90, 120)), False))
    while len(plan) < exams:
        year = rng.choice(YEARS)
        pick = rng.sample(range(CLASSES_PER_YEAR), rng.choice((1, 1, 2)))
        plan.append(([(year, i) for i in pick], rng.choice((40, 60, 80)), False))
    rng.shuffle(plan)
    plan = plan[:exams]
    for index in rng.sample(range(len(plan)), k=min(3, len(plan))):
        members, length, _ = plan[index]
        plan[index] = (members, length, True)

    starts = [
        FIRST_HOUR * 60 + round(step * 360 / max(1, starts_per_day - 1))
        for step in range(starts_per_day)
    ]
    payload_exams = []
    for number, (members, length, fixed) in enumerate(plan):
        slots, blocks_room, blocks_teacher = [], [[] for _ in rooms], [[] for _ in teachers]
        grid = [(d, s) for d in range(DAYS) for s in starts]
        if fixed:
            grid = [rng.choice(grid)]
        for position, (day, start) in enumerate(grid):
            slots.append({"day": day, "week": 0, "start": start,
                          "loss": rng.choice((0, 0, 30, 60, 60, 90, 120, 180))})
            hours = range(start // 60, math.ceil((start + length) / 60))
            for r, busy in enumerate(room_busy):
                if any((day, h) in busy for h in hours):
                    blocks_room[r].append(position)
            for t, busy in enumerate(teacher_busy):
                if any((day, h) in busy for h in hours):
                    blocks_teacher[t].append(position)
        payload_exams.append({
            "id": _uid(f"exam:{number}"),
            "length": length,
            "writers": PUPILS_PER_CLASS * len(members) - rng.randint(0, 3),
            "classes": [klass[m] for m in members],
            "slots": slots,
            "roomBlocks": [
                {"id": rooms[r]["id"], "slots": b} for r, b in enumerate(blocks_room) if b
            ],
            "teacherBlocks": [
                {"id": teachers[t]["id"], "slots": b} for t, b in enumerate(blocks_teacher) if b
            ],
            "fixed": fixed,
        })
    return {
        "requestId": _uid(f"request:{seed}"),
        "exams": payload_exams,
        "rooms": rooms,
        "teachers": teachers,
        "limits": {
            "maxPerClassPerDay": day_cap,
            "maxPerClassPerWeek": week_cap,
            "writersPerInvigilator": 30,
            "turnoverMinutes": 15,
        },
        "existingDayLoad": [],
        "existingWeekLoad": [],
    }


# ---------------------------------------------------------------------------
# The two halves of a paired trial.
# ---------------------------------------------------------------------------


def _wait_until(start_at: float) -> None:
    while time.time() < start_at:
        time.sleep(0.001)


def run_exam(seed: int, budget: float, workers: int, start_at: float, **shape: int) -> dict:
    """Solve one week, recording when each better plan was found."""
    from ortools.sat.python import cp_model

    from app.config import Settings
    from app.schemas.exams import PlanExamsRequest
    from app.solver.exam_solver import ExamSolver

    payload = build_week(seed, **shape)
    payload["search"] = {"workers": workers, "seed": 0}
    request = PlanExamsRequest.model_validate(payload)
    settings = Settings(EXAM_SOLVER_MAX_TIME_SECONDS=budget)
    trajectory: list[dict] = []
    original = cp_model.CpSolver.Solve

    class Trace(cp_model.CpSolverSolutionCallback):
        def __init__(self, model: cp_model.CpModel, began: float) -> None:
            super().__init__()
            self._began = began
            proto = model.Proto()
            self._placed = [
                model.GetBoolVarFromProtoIndex(i)
                for i, var in enumerate(proto.variables) if var.name.startswith("placed_")
            ]

        def on_solution_callback(self) -> None:
            trajectory.append({
                "seconds": round(time.monotonic() - self._began, 3),
                "placed": sum(self.Value(v) for v in self._placed),
                "objective": self.ObjectiveValue(),
                "bound": self.BestObjectiveBound(),
            })

    def traced(self, model, solution_callback=None):  # type: ignore[no-untyped-def]
        return original(self, model, Trace(model, time.monotonic()))

    cp_model.CpSolver.Solve = traced  # type: ignore[method-assign]
    _wait_until(start_at)
    solver = ExamSolver(settings)
    began = time.monotonic()
    response = solver.solve(request)
    seconds = time.monotonic() - began
    return {
        "seconds": round(seconds, 3),
        "status": response.status,
        "cpsat": solver.last_report.status,
        "build": round(solver.last_report.build, 3),
        "search": round(solver.last_report.search, 3),
        "placed": response.metrics.placed,
        "unplaced": response.metrics.unplaced,
        "exams": len(payload["exams"]),
        "fixed": sum(1 for e in payload["exams"] if e["fixed"]),
        "fixedPlaced": sum(
            1 for p in response.placed
            if any(e["id"] == str(p.exam) and e["fixed"] for e in payload["exams"])
        ),
        "loss": response.metrics.loss,
        "roomsUsed": response.metrics.rooms_used,
        "invigilatorPasses": response.metrics.invigilator_passes,
        "maxLoad": response.metrics.max_load,
        "minLoad": response.metrics.min_load,
        "objective": solver.last_report.objective,
        "bound": solver.last_report.bound,
        "reasons": sorted({u.reason for u in response.unplaced}),
        "trajectory": trajectory,
    }


def run_reference(workers: int, start_at: float) -> dict:
    """The fixed reference load: a job-shop of 15 jobs on 15 machines that
    CP-SAT does not prove in any reasonable time, stopped after a fixed amount
    of DETERMINISTIC time (CP-SAT's own count of work done, which does not
    move with the host's load). Every trial does the same work, so its wall
    clock is the host's load and nothing else."""
    from ortools.sat.python import cp_model

    rng = random.Random(20261107)
    jobs, machines = 15, 15
    routes = [rng.sample(range(machines), machines) for _ in range(jobs)]
    lengths = [[rng.randint(1, 99) for _ in range(machines)] for _ in range(jobs)]
    horizon = sum(sum(row) for row in lengths)
    model = cp_model.CpModel()
    on_machine: list[list] = [[] for _ in range(machines)]
    ends = []
    for job in range(jobs):
        previous = None
        for step, machine in enumerate(routes[job]):
            start = model.NewIntVar(0, horizon, f"s{job}_{step}")
            interval = model.NewFixedSizeIntervalVar(start, lengths[job][step], f"i{job}_{step}")
            on_machine[machine].append(interval)
            if previous is not None:
                model.Add(start >= previous)
            previous = start + lengths[job][step]
        ends.append(previous)
    for intervals in on_machine:
        model.AddNoOverlap(intervals)
    span = model.NewIntVar(0, horizon, "span")
    model.AddMaxEquality(span, ends)
    model.Minimize(span)
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = workers
    solver.parameters.random_seed = 1
    solver.parameters.interleave_search = True
    solver.parameters.max_deterministic_time = REFERENCE_DETERMINISTIC_SECONDS
    solver.parameters.max_time_in_seconds = 600
    _wait_until(start_at)
    began = time.monotonic()
    code = solver.Solve(model)
    return {
        "seconds": round(time.monotonic() - began, 3),
        "status": solver.StatusName(code),
        "makespan": solver.ObjectiveValue(),
        "cpuSeconds": round(solver.UserTime(), 3),
    }


def _load() -> list[float]:
    return [round(x, 1) for x in os.getloadavg()]


def pair(seed: int, budget: float, workers: int, shape: dict) -> dict:
    """One paired trial: two child processes released at the same instant."""
    start_at = time.time() + 4.0
    me = [sys.executable, os.path.abspath(__file__)]
    common = ["--workers", str(workers), "--start-at", repr(start_at)]
    shape_args = [
        "--exams", str(shape["exams"]), "--starts-per-day", str(shape["starts_per_day"]),
        "--day-cap", str(shape["day_cap"]), "--week-cap", str(shape["week_cap"]),
    ]
    before = _load()
    exam = subprocess.Popen(
        [*me, "--child", "exam", "--seed", str(seed), "--budget", str(budget), *common, *shape_args],
        stdout=subprocess.PIPE, text=True,
    )
    reference = subprocess.Popen(
        [*me, "--child", "ref", *common], stdout=subprocess.PIPE, text=True,
    )
    exam_out, _ = exam.communicate()
    ref_out, _ = reference.communicate()
    result = json.loads(exam_out.strip().splitlines()[-1])
    ref = json.loads(ref_out.strip().splitlines()[-1])
    return {
        "seed": seed, "exam": result, "reference": ref,
        "ratio": round(result["seconds"] / ref["seconds"], 3),
        "loadAverage": [before, _load()],
    }


def _percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    position = share * (len(ordered) - 1)
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _incumbent_at(trajectory: list[dict], seconds: float) -> dict | None:
    found = [item for item in trajectory if item["seconds"] <= seconds]
    return found[-1] if found else None


def greedy_placed(seed: int, shape: dict) -> int:
    """How many exams the greedy floor places in this week: what a run too
    short for any better plan answers with (exam_solver.greedy_plan)."""
    from app.schemas.exams import PlanExamsRequest
    from app.solver.exam_solver import greedy_plan, prepare

    problem = prepare(PlanExamsRequest.model_validate(build_week(seed, **shape)))
    return len(greedy_plan(problem))


def summarise(trials: list[dict], budget: float, shape: dict) -> dict:
    exam = [t["exam"]["seconds"] for t in trials]
    ref = [t["reference"]["seconds"] for t in trials]
    ratio = [t["ratio"] for t in trials]

    def stats(values: list[float]) -> dict:
        return {"median": round(statistics.median(values), 3),
                "p95": round(_percentile(values, 0.95), 3),
                "min": round(min(values), 3), "max": round(max(values), 3)}

    # When the search last found a better plan, counted from the start of
    # CP-SAT's Solve (after the narrowing, the greedy and the build): what a
    # shorter budget would have returned the same plan at.
    improved = [t["exam"]["trajectory"][-1]["seconds"] for t in trials if t["exam"]["trajectory"]]
    improved_ratio = [
        t["exam"]["trajectory"][-1]["seconds"] / t["reference"]["seconds"]
        for t in trials if t["exam"]["trajectory"]
    ]
    out: dict = {
        "lastImprovementSeconds": stats(improved) if improved else None,
        "lastImprovementOverReference": stats(improved_ratio) if improved_ratio else None,
        "greedyPlacedMedian": statistics.median(greedy_placed(t["seed"], shape) for t in trials),
        "trials": len(trials),
        "budgetSeconds": budget,
        "examSeconds": stats(exam),
        "referenceSeconds": stats(ref),
        "ratio": stats(ratio),
        "optimalShare": round(sum(t["exam"]["status"] == "OPTIMAL" for t in trials) / len(trials), 3),
        "placedMedian": statistics.median(t["exam"]["placed"] for t in trials),
        "examsMedian": statistics.median(t["exam"]["exams"] for t in trials),
        "fixedAlwaysPlacedWhenPossible": all(
            t["exam"]["fixedPlaced"] <= t["exam"]["fixed"] for t in trials
        ),
        "byBudget": {},
    }
    for limit in (10, 20, 60):
        if limit > budget:
            continue
        rows = []
        for t in trials:
            # A run with this limit searches for the limit minus what comes
            # before the search (narrowing, greedy, build) and the tail kept
            # back for the answer (AFTER_SEARCH_SECONDS), so the plan it
            # returns is the incumbent at that moment of a longer run.
            before = t["exam"]["seconds"] - t["exam"]["search"]
            at = _incumbent_at(t["exam"]["trajectory"], limit - AFTER_SEARCH_SECONDS - before)
            proven = t["exam"]["status"] == "OPTIMAL" and t["exam"]["seconds"] <= limit
            rows.append((at, proven, t["exam"]["placed"]))
        floors = [greedy_placed(t["seed"], shape) for t in trials]
        # No incumbent yet means the answer is the greedy floor.
        placed_at = [max(r[0]["placed"] if r[0] else 0, f) for r, f in zip(rows, floors)]
        final = [t["exam"]["placed"] for t in trials]
        out["byBudget"][str(limit)] = {
            "placedMedian": statistics.median(placed_at),
            "placedMin": min(placed_at),
            "sameAsFinalPlacedShare": round(
                sum(a == f for a, f in zip(placed_at, final)) / len(trials), 3),
            "provenOptimalShare": round(sum(r[1] for r in rows) / len(trials), 3),
            "floorOnlyShare": round(sum(r[0] is None for r in rows) / len(trials), 3),
        }
    return out


def markdown(summary: dict, trials: list[dict], shape: dict, workers: int) -> str:
    lines = [
        "# Provvecka: mätning av exam_solver",
        "",
        f"{summary['trials']} parade samtidiga körningar, {workers} arbetare vardera, budget "
        f"{summary['budgetSeconds']} s, "
        f"{shape['exams']} prov, {shape['starts_per_day']} starter per dag "
        f"({shape['starts_per_day'] * 5} kandidattider), tak {shape['day_cap']}/dag och "
        f"{shape['week_cap']}/vecka, tre skrivsalar (30/60/90), {TEACHERS} lärare.",
        "",
        "| | median | p95 | min | max |",
        "|---|---|---|---|---|",
    ]
    for label, key in (("provlösning (s)", "examSeconds"), ("referens (s)", "referenceSeconds"),
                       ("kvot prov/referens", "ratio")):
        s = summary[key]
        lines.append(f"| {label} | {s['median']} | {s['p95']} | {s['min']} | {s['max']} |")
    if summary["lastImprovementSeconds"]:
        s = summary["lastImprovementSeconds"]
        r = summary["lastImprovementOverReference"]
        lines += [
            f"| sista förbättring (s, från Solve) | {s['median']} | {s['p95']} | {s['min']} | "
            f"{s['max']} |",
            f"| sista förbättring / referens | {r['median']} | {r['p95']} | {r['min']} | "
            f"{r['max']} |",
        ]
    lines += [
        "",
        f"Optimala (bevisade): {summary['optimalShare']:.0%}. Lagda prov i median: "
        f"{summary['placedMedian']} av {summary['examsMedian']} (girigt golv: "
        f"{summary['greedyPlacedMedian']}).",
        "",
        "| tidsgräns | lagda prov (median) | lagda (min) | lika många som slutresultatet | "
        "bevisat optimal | bara girigt golv |",
        "|---|---|---|---|---|---|",
    ]
    for limit, row in summary["byBudget"].items():
        lines.append(
            f"| {limit} s | {row['placedMedian']} | {row['placedMin']} | "
            f"{row['sameAsFinalPlacedShare']:.0%} | {row['provenOptimalShare']:.0%} | "
            f"{row['floorOnlyShare']:.0%} |"
        )
    lines += ["", "Värdens belastning (load average före/efter) per försök:", ""]
    for t in trials:
        lines.append(
            f"- frö {t['seed']}: prov {t['exam']['seconds']} s ({t['exam']['status']}, "
            f"{t['exam']['placed']}/{t['exam']['exams']} lagda), referens "
            f"{t['reference']['seconds']} s, kvot {t['ratio']}, load {t['loadAverage']}"
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--budget", type=float, default=20.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--exams", type=int, default=26)
    parser.add_argument("--starts-per-day", type=int, default=7)
    parser.add_argument("--day-cap", type=int, default=1)
    parser.add_argument("--week-cap", type=int, default=4)
    parser.add_argument("--pairs", type=int, default=0, help="paired trials (the measurement)")
    parser.add_argument("--out", type=Path, default=None, help="directory for the JSON + markdown")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--from-json", type=Path, default=None,
                        help="summarise the trials of an earlier --pairs run again")
    parser.add_argument("--child", choices=("exam", "ref"), default=None)
    parser.add_argument("--start-at", type=float, default=0.0)
    args = parser.parse_args()
    shape = {"exams": args.exams, "starts_per_day": args.starts_per_day,
             "day_cap": args.day_cap, "week_cap": args.week_cap}

    if args.child == "exam":
        print(json.dumps(run_exam(args.seed, args.budget, args.workers, args.start_at, **shape)))
        return 0
    if args.child == "ref":
        print(json.dumps(run_reference(args.workers, args.start_at)))
        return 0
    if args.from_json is not None:
        saved = json.loads(args.from_json.read_text())
        shape = saved["shape"]
        summary = summarise(saved["trials"], saved["summary"]["budgetSeconds"], shape)
        saved["summary"] = summary
        args.from_json.write_text(json.dumps(saved, indent=2) + "\n")
        args.from_json.with_suffix(".md").write_text(
            markdown(summary, saved["trials"], shape, saved["workers"]))
        print(json.dumps(summary, indent=2))
        return 0
    if args.pairs:
        trials = []
        for number in range(args.pairs):
            trial = pair(args.seed + number, args.budget, args.workers, shape)
            trials.append(trial)
            print(f"trial {number + 1}/{args.pairs} seed {trial['seed']}: exam "
                  f"{trial['exam']['seconds']} s ({trial['exam']['status']}, placed "
                  f"{trial['exam']['placed']}/{trial['exam']['exams']}), ref "
                  f"{trial['reference']['seconds']} s, ratio {trial['ratio']}, "
                  f"load {trial['loadAverage'][1]}", file=sys.stderr, flush=True)
        summary = summarise(trials, args.budget, shape)
        if args.out is not None:
            args.out.mkdir(parents=True, exist_ok=True)
            stem = (f"provvecka-{args.exams}p-{args.starts_per_day}s-"
                    f"dag{args.day_cap}-b{int(args.budget)}-w{args.workers}")
            (args.out / f"{stem}.json").write_text(
                json.dumps({"shape": shape, "workers": args.workers, "summary": summary,
                            "trials": trials}, indent=2) + "\n")
            (args.out / f"{stem}.md").write_text(markdown(summary, trials, shape, args.workers))
        print(json.dumps(summary, indent=2))
        return 0

    start_at = time.time()
    result = run_exam(args.seed, args.budget, args.workers, start_at, **shape)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"provvecka seed {args.seed}: {result['status']} ({result['cpsat']}), "
            f"{result['placed']}/{result['exams']} prov lagda ({result['fixedPlaced']}/"
            f"{result['fixed']} fasta) på {result['seconds']} s (bygge {result['build']} s, "
            f"sökning {result['search']} s, budget {args.budget} s, load {_load()}), "
            f"förlust {result['loss']}, rum {result['roomsUsed']}, vakter "
            f"{result['invigilatorPasses']}, last {result['minLoad']}-{result['maxLoad']}, "
            f"skäl {result['reasons']}"
        )
        last = result["trajectory"][-1] if result["trajectory"] else None
        if last:
            print(f"  sista lösningen efter {last['seconds']} s, mål {last['objective']}, "
                  f"gräns {last['bound']}")
    return 0 if result["placed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
