#!/usr/bin/env python3
"""Do the schemaförslag variants actually give a school different timetables?

A candidate run asks for two to four timetables of one week, each with its own
emphasis, and every one warm-started from the school's current draft. The
emphasis is nothing but a few ObjectiveWeights overrides and a seed, so whether
"Färre håltimmar för lärarna" has fewer håltimmar than "Behåll mest" — or is
the same timetable under another name — is a measurement, not a property of
the code. This is it.

    python benchmarks/candidate_variants.py --students 500
    python benchmarks/candidate_variants.py --students 1000 --draft-budget 300 \\
        --draft-cache /tmp/draft-1000.json
    python benchmarks/candidate_variants.py --students 500 \\
        --variant 'SPREAD:disruption=2,spread=20:2' --only KEEP,SPREAD
    python benchmarks/candidate_variants.py --students 500 --compare-workers
    python benchmarks/candidate_variants.py --students 1000 --cpu-clock \\
        --compare-workers --draft-cache /tmp/draft-1000.json
    python benchmarks/candidate_variants.py --students 500 --keep-max-seconds 0

THE PROCEDURE is the gateway's. The bench school (solve_2000_students.py) is
solved once, cold, on the engine's own weights: that is the draft. The draft's
lessons go back as previousLessons, and each variant is solved with its
overrides, its seed and the gateway's `search`: every ordinal, KEEP's
included, gets maxSeconds = --candidate-seconds (the gateway's
CANDIDATE_MAX_SECONDS) and four workers; KEEP alone has the probes on and no
seed. --keep-max-seconds N gives KEEP a budget of its own, and 0 sends it
none (the engine's configured sixty seconds), which is the design's first
procedure: KEEP's sixty seconds against the others' thirty measures the
budget, not the weights (docs/verification-baseline.md, "Schemaförslag").

WHAT IS REPORTED, per variant:

    moved %          lessons whose (requirement, weekday, start) differ from
                     the draft's, matched as a multiset per requirement
    teacher idle     per teacher and day, the minutes between the first
                     lesson's start and the last one's end not spent teaching,
                     summed over the week (raw)
    håltimmar        the same holes read the way the compare page reads them
                     (web/lib/gaps.ts findIdleGaps): the teacher's own weekly
                     UNAVAILABLE rows occupy time like a lesson, one school
                     lunch a day is credited in clock order, and a hole under
                     15 minutes is not a håltimme. The engine's own idle term
                     credits the UNAVAILABLE rows too, which is why this, and
                     not the raw figure, is what a variant can be asked to move
    same-day pairs   per requirement and day, pairs of its lessons on that day:
                     what the spread weight prices
    day variance     per class, the variance of its lessons per weekday,
                     averaged over the classes
    valid            benchmarks/validate_schedule.py over the answer, because a
                     solver's status is not evidence

The draft can be cached (--draft-cache) so a retune re-solves only the
variants: a cold solve of the 1,000-pupil school is minutes, every variant
after it seconds.

--cpu-clock MEASURES AN IDLE HOST ON A BUSY ONE. Every budget here is wall
clock, and on a shared development machine running other sessions' suites a
thirty-second candidate gets a fraction of the cores it would get alone — the
numbers then describe the neighbours, not the weights. With the flag, each
CP-SAT solve is stopped when its process has spent `limit x workers` CPU
seconds, and the solver's own clock (scheduler_solver's time.monotonic) is
read as Python's CPU time plus each solve's CPU time divided by its workers:
the wall time the same work takes on a host with those cores to itself. It
flatters a solve slightly, because presolve runs on one thread and is counted
as if it ran on all of them.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
import types
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

from app.config import Settings  # noqa: E402
from app.schemas.schedule import (  # noqa: E402
    ObjectiveWeights,
    OptimizeScheduleRequest,
    PreviousLesson,
    ScheduledLesson,
    ScheduledLunch,
    SearchOptions,
)
from app.solver import scheduler_solver  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from solve_2000_students import SchoolShape, build_request  # noqa: E402
from validate_schedule import validate  # noqa: E402

#: (code, overrides, seed) — the design's table, ordinal by position.
VARIANTS: list[tuple[str, dict[str, int], int | None]] = [
    ("KEEP", {}, None),
    ("TEACHER_GAPS", {"disruption": 2, "teacherGap": 8}, 1),
    ("SPREAD", {"disruption": 2, "spread": 9}, 2),
    ("FREE", {"disruption": 0}, 3),
]
CANDIDATE_MAX_SECONDS = 30
CANDIDATE_WORKERS = 4
#: The engine's configured budget: Generera's, and KEEP's under --keep-max-seconds 0.
CONFIGURED_BUDGET = 60.0


def _settings(budget: float) -> Settings:
    return Settings(
        API_KEY="benchmark-key-0000000000000000000000",
        ALLOWED_ORIGINS="http://localhost",
        SOLVER_MAX_TIME_SECONDS=budget,
    )


class _SolveLog:
    """Every CpSolver.Solve of one engine call: seconds, status, objective."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self._original = cp_model.CpSolver.Solve

    def __enter__(self) -> _SolveLog:
        log = self
        original = self._original

        def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
            started = time.perf_counter()
            cpu = time.process_time()
            code = original(solver, model, *args, **kwargs)
            entry: dict[str, object] = {
                "seconds": round(time.perf_counter() - started, 2),
                "cpu": round(time.process_time() - cpu, 2),
                "status": solver.StatusName(code),
                "limit": round(solver.parameters.max_time_in_seconds, 1),
            }
            if model.HasObjective() and code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                entry["objective"] = solver.ObjectiveValue()
                entry["bound"] = solver.BestObjectiveBound()
            log.calls.append(entry)
            return code

        cp_model.CpSolver.Solve = solve  # type: ignore[method-assign]
        return self

    def __exit__(self, *exc: object) -> None:
        cp_model.CpSolver.Solve = self._original  # type: ignore[method-assign]


class _CpuClock:
    """The idle-host emulation behind --cpu-clock; see the module docstring."""

    def __init__(self, cores: int) -> None:
        self._cores = cores
        self._in_solves = 0.0
        self._virtual = 0.0
        self._original = cp_model.CpSolver.Solve
        self._original_time = scheduler_solver.time

    def monotonic(self) -> float:
        return (time.process_time() - self._in_solves) + self._virtual

    def __enter__(self) -> _CpuClock:
        clock = self
        original = self._original

        def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
            limit = solver.parameters.max_time_in_seconds
            workers = solver.parameters.num_workers or clock._cores
            # The wall limit only as a backstop: the CPU watchdog is the budget.
            solver.parameters.max_time_in_seconds = limit * 50 + 60
            started = time.process_time()
            done = threading.Event()

            def watch() -> None:
                while not done.wait(0.02):
                    if time.process_time() - started >= limit * workers:
                        solver.stop_search()
                        return

            watchdog = threading.Thread(target=watch, daemon=True)
            watchdog.start()
            try:
                return original(solver, model, *args, **kwargs)
            finally:
                done.set()
                watchdog.join()
                used = time.process_time() - started
                clock._in_solves += used
                clock._virtual += used / workers
                solver.parameters.max_time_in_seconds = limit

        cp_model.CpSolver.Solve = solve  # type: ignore[method-assign]
        scheduler_solver.time = types.SimpleNamespace(  # type: ignore[assignment]
            monotonic=self.monotonic, perf_counter=time.perf_counter,
        )
        return self

    def __exit__(self, *exc: object) -> None:
        cp_model.CpSolver.Solve = self._original  # type: ignore[method-assign]
        scheduler_solver.time = self._original_time  # type: ignore[assignment]


def _minutes(clock: str) -> int:
    hours, minutes, _ = clock.split(":")
    return int(hours) * 60 + int(minutes)


def _key(lesson: ScheduledLesson) -> tuple[str, int, str]:
    return (str(lesson.requirement_id), lesson.day_of_week, lesson.start_time)


def moved(draft: list[ScheduledLesson], lessons: list[ScheduledLesson]) -> int:
    """Draft lessons with no lesson of the same requirement at the same weekday and start."""
    left = Counter(_key(lesson) for lesson in lessons)
    count = 0
    for key in (_key(lesson) for lesson in draft):
        if left[key] > 0:
            left[key] -= 1
        else:
            count += 1
    return count


def teacher_idle_minutes(request: OptimizeScheduleRequest, lessons: list[ScheduledLesson]) -> int:
    teacher_of = {r.id: r.teacher_id for r in request.requirements}
    days: dict[tuple[object, int], list[tuple[int, int]]] = defaultdict(list)
    for lesson in lessons:
        teacher = teacher_of.get(lesson.requirement_id)
        if teacher is None:
            continue
        days[(teacher, lesson.day_of_week)].append(
            (_minutes(lesson.start_time), _minutes(lesson.end_time)),
        )
    idle = 0
    for spans in days.values():
        first = min(start for start, _ in spans)
        last = max(end for _, end in spans)
        idle += (last - first) - sum(end - start for start, end in spans)
    return idle


#: gaps.ts DEFAULT_MINIMUM_GAP_MINUTES: a shorter hole is a changeover, not a håltimme.
MINIMUM_GAP_MINUTES = 15


def haltimmar(request: OptimizeScheduleRequest, lessons: list[ScheduledLesson]) -> int:
    """Teachers' idle minutes a week as the compare page counts them.

    A port of what findIdleGaps does for a teacher on a timetable with no
    alternating weeks: busy is the teacher's lessons and their own weekly
    UNAVAILABLE windows, the day is bounded by the first and last LESSON, the
    holes in between are credited one school lunch in clock order, and holes
    whose remainder is under fifteen minutes are dropped.
    """
    teacher_of = {r.id: r.teacher_id for r in request.requirements}
    own: dict[tuple[object, int], list[tuple[int, int]]] = defaultdict(list)
    days = sorted({lesson.day_of_week for lesson in lessons})
    for constraint in request.constraints:
        if (
            constraint.kind != "UNAVAILABLE"
            or constraint.resource_kind != "TEACHER"
            or constraint.date is not None
        ):
            continue
        for day in ([constraint.day_of_week] if constraint.day_of_week else days):
            own[(constraint.resource_id, day)].append(
                (_minutes(constraint.start_time), _minutes(constraint.end_time)),
            )
    rules = request.rules
    lunch = None
    if rules is not None and rules.lunch_start_time and rules.lunch_end_time and rules.lunch_minutes:
        window = (_minutes(rules.lunch_start_time), _minutes(rules.lunch_end_time))
        lunch = (*window, min(rules.lunch_minutes, window[1] - window[0]))

    taught: dict[tuple[object, int], list[tuple[int, int]]] = defaultdict(list)
    for lesson in lessons:
        teacher = teacher_of.get(lesson.requirement_id)
        if teacher is not None:
            taught[(teacher, lesson.day_of_week)].append(
                (_minutes(lesson.start_time), _minutes(lesson.end_time)),
            )
    total = 0
    for key, spans in taught.items():
        first = min(start for start, _ in spans)
        last = max(end for _, end in spans)
        busy = sorted(spans + own.get(key, []))
        holes: list[tuple[int, int]] = []
        cursor = first
        for start, end in busy:
            if start > cursor and cursor < last:
                holes.append((cursor, min(start, last)))
            cursor = max(cursor, end)
        remaining = lunch[2] if lunch else 0
        for start, end in holes:
            overlap = max(0, min(end, lunch[1]) - max(start, lunch[0])) if lunch else 0
            credit = min(overlap, remaining)
            remaining -= credit
            idle = (end - start) - credit
            if idle >= MINIMUM_GAP_MINUTES:
                total += idle
    return total


def lunch_drift_minutes(lunches: list[ScheduledLunch]) -> int:
    """Per class, how far each day's lunch is from its first day's: the engine's
    lunch_drift term, in minutes rather than slots."""
    by_group: dict[object, dict[int, int]] = defaultdict(dict)
    for lunch in lunches:
        by_group[lunch.student_group_id][lunch.day_of_week] = _minutes(lunch.start_time)
    drift = 0
    for days in by_group.values():
        anchor = days[min(days)]
        drift += sum(abs(start - anchor) for start in days.values())
    return drift


def same_day_pairs(lessons: list[ScheduledLesson]) -> int:
    per_day = Counter((lesson.requirement_id, lesson.day_of_week) for lesson in lessons)
    return sum(count * (count - 1) // 2 for count in per_day.values())


def day_variance(request: OptimizeScheduleRequest, lessons: list[ScheduledLesson], days: list[int]) -> float:
    group_of = {r.id: r.student_group_id for r in request.requirements}
    counts: dict[object, Counter[int]] = defaultdict(Counter)
    for lesson in lessons:
        counts[group_of[lesson.requirement_id]][lesson.day_of_week] += 1
    variances = [statistics.pvariance([per_day[day] for day in days]) for per_day in counts.values()]
    return round(statistics.fmean(variances), 3) if variances else 0.0


def draft_of(request: OptimizeScheduleRequest, budget: float, cache: Path | None) -> tuple[list[ScheduledLesson], dict[str, object]]:
    if cache is not None and cache.exists():
        stored = json.loads(cache.read_text())
        return [ScheduledLesson.model_validate(row) for row in stored["lessons"]], stored["facts"]
    started = time.perf_counter()
    with _SolveLog() as log:
        response = SchedulerSolver(_settings(budget)).solve(request)
    facts: dict[str, object] = {
        "status": response.status,
        "seconds": round(time.perf_counter() - started, 1),
        "budget": budget,
        "lessons": len(response.lessons),
        "solves": log.calls,
    }
    if response.status not in ("OPTIMAL", "FEASIBLE"):
        msg = f"the draft did not solve: {facts}"
        raise SystemExit(msg)
    if cache is not None:
        cache.write_text(json.dumps({
            "facts": facts,
            "lessons": [lesson.model_dump(mode="json") for lesson in response.lessons],
        }))
    return response.lessons, facts


def solve_variant(
    request: OptimizeScheduleRequest,
    draft: list[ScheduledLesson],
    *,
    ordinal: int,
    code: str,
    overrides: dict[str, int],
    seed: int | None,
    workers: int | None,
    cpu_clock: bool = False,
    keep_max_seconds: int | None = None,
    candidate_seconds: int = CANDIDATE_MAX_SECONDS,
) -> dict[str, object]:
    search = SearchOptions(
        seed=seed,
        max_seconds=keep_max_seconds if ordinal == 1 else candidate_seconds,
        probes=ordinal == 1,
        workers=workers,
    )
    candidate = request.model_copy(update={
        "previous_lessons": [
            PreviousLesson(
                requirement_id=lesson.requirement_id,
                day_of_week=lesson.day_of_week,
                start_time=lesson.start_time,
            )
            for lesson in draft
        ],
        "weights": ObjectiveWeights(**overrides) if overrides else None,
        "search": search,
    })
    solver = SchedulerSolver(_settings(CONFIGURED_BUDGET))
    started = time.perf_counter()
    if cpu_clock:
        # The log inside the clock, so its timings are the clock's solves.
        with _CpuClock(os.cpu_count() or 1) as clock, _SolveLog() as log:
            began = clock.monotonic()
            response = solver.solve(candidate)
            emulated = clock.monotonic() - began
    else:
        with _SolveLog() as log:
            response = solver.solve(candidate)
        emulated = None
    seconds = time.perf_counter() - started
    lessons = response.lessons
    out: dict[str, object] = {
        "ordinal": ordinal,
        "code": code,
        "overrides": overrides,
        "seed": seed,
        "workers": workers if workers is not None else 0,
        "status": response.status,
        "seconds": round(seconds, 1) if emulated is None else round(emulated, 1),
        "realSeconds": round(seconds, 1),
        "solves": log.calls,
    }
    if lessons:
        out.update({
            "lessons": len(lessons),
            "moved": moved(draft, lessons),
            "movedPct": round(100 * moved(draft, lessons) / len(draft), 1),
            "teacherIdleMinutes": teacher_idle_minutes(request, lessons),
            "haltimmar": haltimmar(request, lessons),
            "lunchDriftMinutes": lunch_drift_minutes(response.lunches),
            "sameDayPairs": same_day_pairs(lessons),
            "dayVariance": day_variance(request, lessons, list(solver._grid.schedule_days)),
            "valid": not validate(solver._grid, request, lessons),
            "_lessons": lessons,
        })
    return out


def _parse_variant(text: str) -> tuple[str, dict[str, int], int | None]:
    """CODE:key=value,key=value:seed — an empty middle or seed is allowed."""
    code, _, rest = text.partition(":")
    weights, _, seed = rest.partition(":")
    overrides = {}
    for pair in filter(None, weights.split(",")):
        name, _, value = pair.partition("=")
        overrides[name.strip()] = int(value)
    return code, overrides, int(seed) if seed else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--students", type=int, default=500)
    parser.add_argument("--draft-budget", type=float, default=120.0)
    parser.add_argument("--draft-cache", type=Path, default=None)
    parser.add_argument("--variant", action="append", default=[],
                        help="override one variant: CODE:key=value,...:seed")
    parser.add_argument("--extra", action="append", default=[],
                        help="append a variant after the table's: CODE:key=value,...:seed")
    parser.add_argument("--candidate-seconds", type=int, default=CANDIDATE_MAX_SECONDS,
                        help="maxSeconds for every ordinal (the gateway's "
                        "CANDIDATE_MAX_SECONDS, default %(default)s)")
    parser.add_argument("--keep-max-seconds", type=int, default=None,
                        help="KEEP's own maxSeconds (default: --candidate-seconds, as the "
                        "gateway sends); 0 sends none, the design's first procedure")
    parser.add_argument("--only", default=None, help="comma-separated codes to run")
    parser.add_argument("--workers", type=int, default=CANDIDATE_WORKERS,
                        help="search.workers for every variant (0 = leave unset)")
    parser.add_argument("--compare-workers", action="store_true",
                        help="also solve KEEP with workers unset (every core)")
    parser.add_argument("--cpu-clock", action="store_true",
                        help="count budgets in CPU seconds per worker (see above)")
    parser.add_argument("--save-lessons", type=Path, default=None, metavar="DIR",
                        help="write each variant's lessons to DIR/<students>-<code>.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    variants = list(VARIANTS)
    for text in args.variant:
        code, overrides, seed = _parse_variant(text)
        variants = [
            (code, overrides, seed) if existing == code else (existing, o, s)
            for existing, o, s in variants
        ]
    variants += [_parse_variant(text) for text in args.extra]
    only = set(args.only.split(",")) if args.only else None

    request = build_request(SchoolShape(students=args.students))
    draft, draft_facts = draft_of(request, args.draft_budget, args.draft_cache)
    workers = args.workers or None

    # The gateway sends KEEP the candidate budget; 0 reproduces the design's
    # first procedure, KEEP under the engine's own configured budget.
    if args.keep_max_seconds is None:
        keep_max_seconds: int | None = args.candidate_seconds
    else:
        keep_max_seconds = args.keep_max_seconds or None
    results = []
    for ordinal, (code, overrides, seed) in enumerate(variants, start=1):
        if only is not None and code not in only:
            continue
        results.append(solve_variant(
            request, draft, ordinal=ordinal, code=code, overrides=overrides,
            seed=seed, workers=workers, cpu_clock=args.cpu_clock,
            keep_max_seconds=keep_max_seconds, candidate_seconds=args.candidate_seconds,
        ))
        if code == "KEEP" and args.compare_workers:
            results.append(solve_variant(
                request, draft, ordinal=ordinal, code="KEEP(workers 0)", overrides=overrides,
                seed=seed, workers=None, cpu_clock=args.cpu_clock,
                keep_max_seconds=keep_max_seconds, candidate_seconds=args.candidate_seconds,
            ))

    # How far each answer is from KEEP's own, on the same matching as moved:
    # the figure the storage's sameAs (< 1 %) is read off.
    keep_lessons = next((r.get("_lessons") for r in results if r["code"] == "KEEP"), None)
    for result in results:
        lessons = result.pop("_lessons", None)
        if args.save_lessons is not None and lessons:
            args.save_lessons.mkdir(parents=True, exist_ok=True)
            (args.save_lessons / f"{args.students}-{result['code']}.json").write_text(
                json.dumps([lesson.model_dump(mode="json") for lesson in lessons]),
            )
        if keep_lessons and lessons:
            result["differsFromKeepPct"] = round(
                100 * moved(keep_lessons, lessons) / len(keep_lessons), 1,
            )

    report = {
        "students": args.students,
        "lessonsRequested": sum(r.lessons_per_week for r in request.requirements),
        "draft": draft_facts,
        "draftMetrics": {
            "teacherIdleMinutes": teacher_idle_minutes(request, draft),
            "haltimmar": haltimmar(request, draft),
            "sameDayPairs": same_day_pairs(draft),
            "dayVariance": day_variance(request, draft, [1, 2, 3, 4, 5]),
        },
        "variants": results,
    }
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"{args.students} students, {report['lessonsRequested']} lessons; draft "
          f"{draft_facts['status']} in {draft_facts['seconds']}s, metrics {report['draftMetrics']}")
    header = (f"{'variant':<18}{'status':<10}{'wall s':>7}{'moved %':>9}{'vs KEEP %':>10}"
              f"{'idle min':>10}{'håltim':>8}{'pairs':>7}{'day var':>9}  valid  overrides / seed")
    print(header)
    for r in results:
        print(
            f"{r['code']:<18}{r['status']:<10}{r['seconds']:>7}{r.get('movedPct', '-'):>9}"
            f"{r.get('differsFromKeepPct', '-'):>10}{r.get('teacherIdleMinutes', '-'):>10}"
            f"{r.get('haltimmar', '-'):>8}"
            f"{r.get('sameDayPairs', '-'):>7}{r.get('dayVariance', '-'):>9}  "
            f"{str(r.get('valid', '-')):<6} {r['overrides']} / {r['seed']}",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
