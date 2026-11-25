#!/usr/bin/env python3
"""M8, Veckor i skolans form: measuring the three roads on the corpus (designanteckningen, steg 1).

    python benchmarks/m8_paths.py encoding --profile sweep --only 'n9-g6*' --encodings pairs,cliques,cohorts
    python benchmarks/m8_paths.py years    --only 'n9-g10-m0-s1-t5-h'
    python benchmarks/m8_paths.py periods-core     --only 'n12-g3-m0-s1-t3'
    python benchmarks/m8_paths.py periods-calendar --only 'n12-g3-m0-s1-t3'
    python benchmarks/m8_paths.py start    --only 'n12-g4-m0-s1' --into 1 --from-seed 2
    python benchmarks/m8_paths.py slack    --only 'n9-g10-m0-s1-t5-h' --ends 18:00,16:00

NOTHING IN THE ENGINE IS CHANGED. Like corpus_measure.py, every road is a subclass of the engine's own
SchedulerSolver, or a sequence of ordinary requests handed to it, so a road that wins here is one the
engine can be built to take, and a road that loses costs nothing to drop.

THE THREE ROADS (roadmap-omgang-15, M8):

  (c) `encoding`: how the group conflicts become rows. Today every PAIR of groups that share a pupil is one
      NoOverlap over the two groups' lessons: a school of the production form has 2,000-4,000 of them. The
      alternatives post the same truth in fewer, larger rows:
        pairs    the engine's own (the control),
        cliques  a greedy cover of the pair graph by maximal cliques, one NoOverlap each, from the pairs
                 alone (no change to what the gateway sends),
        cohorts  one NoOverlap per distinct list of a pupil's groups (exact, and what the gateway could
                 send: it knows the pupils). The corpus keeps them (CorpusWeek.cohorts).
        both     the pairs AND the cliques (redundant rows: the same truth said twice, at two grains).
      All of them say the same thing (a clique's rows are exactly its pairs' rows), so a week one of them
      lays is a week any of them lays; what moves is how fast CP-SAT finds it.

  (b) `years`: one year at a time, the years already laid held where they were laid (PinnedLesson, the
      engine's own way of holding a lesson), in an order the shared teachers decide. A week is laid when
      every year is; a year that finds no place given the others is where the road fails.

  (a) `periods`: one week per period, instead of one week with the terms as variables. The lessons that run
      all year are laid first, then each term's own lessons over them (the layers are told apart by the
      periods mask); `calendar` order is the other reading: the first period whole, then the next with what
      it shares held.

Every measurement is made in COUNT mode (one worker, a fixed seed, a budget in CP-SAT's deterministic
seconds: the same on every machine) unless `--mode clock` says every core and wall seconds. Each row carries
the load average. Nothing here makes load: `--jobs` runs weeks side by side and the default is one.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from uuid import UUID

ENGINE_ROOT = Path(os.environ.get("ENGINE_ROOT") or Path(__file__).resolve().parent.parent).resolve()
sys.path.insert(0, str(ENGINE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")

from ortools.sat.python import cp_model  # noqa: E402

import corpus_measure  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver import scheduler_solver as ss  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from app.solver.weeks import week_parts  # noqa: E402
from corpus_measure import FirstScheduleReached, MeasuringSolver  # noqa: E402

ENCODINGS = ("pairs", "cliques", "cohorts", "both")


# ---- the weeks M8 adds to the corpus's own ---------------------------------------------------------


def m8_shapes():
    """One school year of the production form on its own, and two together: what a road that cuts by year hands a stage.

    The corpus's production-form weeks all have three years of g10 side by side (6 or 9 classes) or a whole
    school (30 classes, 868 lessons, 4,154 pairs). The roads that cut by year ask a different question: can the
    engine lay ONE year of that form, 3 to 6 classes, groups of the production school's kind, with the terms.

    `language_teachers` is one a group: the corpus gives a språkval teacher to every four groups of ALL the years
    together, so a single year of three groups would stand on one teacher (a chain of three parallel groups, 96 %
    of the frame by the engine's own count) where the three years together stand on three. A year laid on its own
    is judged by what it is, not by that."""
    from dataclasses import replace

    from school_corpus import PRODUCTION

    def year(classes: int, years=(9,), **changes):
        shape = replace(PRODUCTION, classes_per_year=classes, years=years, **changes)
        return replace(shape, language_teachers=shape.language_groups * len(years))

    shapes = [year(classes) for classes in (2, 3, 4, 5, 6)]
    # A teacher with four subjects' posts (the real year 9: 88 posts on 20 teachers, about four each).
    for classes in (3, 5):
        shapes.append(year(classes, subjects_per_teacher=4))
        shapes.append(year(classes, term_subjects=0))
    shapes.append(year(5, years=(8, 9)))
    shapes.append(year(5, years=(8, 9), subjects_per_teacher=4))
    # The groups of a subject that have a teacher of their own as ONE parallel block (the corpus's `-k`): the
    # groups of a subject in a year share no pupil, so nothing forbids them side by side, and a school lays them so.
    from school_corpus import BASE

    for classes, groups in ((9, 6), (9, 10), (12, 6), (12, 10)):
        shapes.append(replace(BASE, classes_per_year=classes // 3, group_subjects=groups, block_subjects=True))
    for classes in (6, 9):
        shapes.append(replace(PRODUCTION, classes_per_year=classes // 3, block_subjects=True))
    shapes.append(replace(
        PRODUCTION, classes_per_year=5, years=(4, 5, 6, 7, 8, 9), group_subjects_by_year=(0, 0, 0, 3, 10, 10),
        block_subjects=True,
    ))
    return shapes


def week_of(shape_name: str, profile_name: str):
    """The corpus week of a shape of `profile_name`; an m8 week's name says its years (`m8/y9/n5-...`)."""
    from dataclasses import replace

    from school_corpus import build_week

    shape = next(s for s in profile_shapes(profile_name) if s.name() == shape_name)
    week = build_week(shape)
    if profile_name == "m8":
        week = replace(week, name=f"m8/y{''.join(str(y) for y in shape.years)}/{week.name}")
    return week


def profile_shapes(name: str):
    from school_corpus import profile

    return m8_shapes() if name == "m8" else profile(name)


# ---- (c) the encodings ------------------------------------------------------------------------


def clique_cover(pairs: list[tuple[UUID, UUID]], nodes: set[UUID]) -> list[tuple[UUID, ...]]:
    """Maximal cliques of the pair graph that between them hold every pair (greedy, deterministic).

    Each clique starts from the first pair not yet held (in id order) and takes, while it can, the
    neighbour of all its members that holds the most pairs not yet held (ties by id). It is then a
    MAXIMAL clique, so a NoOverlap over it says everything its pairs say and as much more as any
    clique of those groups can."""
    adjacent: dict[UUID, set[UUID]] = {node: set() for node in nodes}
    edges: set[frozenset[UUID]] = set()
    for first, second in pairs:
        if first == second or first not in nodes or second not in nodes:
            continue
        adjacent[first].add(second)
        adjacent[second].add(first)
        edges.add(frozenset((first, second)))
    held: set[frozenset[UUID]] = set()
    cliques: list[tuple[UUID, ...]] = []
    for first, second in sorted(tuple(sorted(edge)) for edge in edges):
        if frozenset((first, second)) in held:
            continue
        clique = [first, second]
        candidates = adjacent[first] & adjacent[second]
        while candidates:
            best = max(
                sorted(candidates),
                key=lambda node: (
                    sum(frozenset((node, member)) not in held for member in clique),
                    len(adjacent[node]),
                ),
            )
            clique.append(best)
            candidates &= adjacent[best]
        for pair in combinations(clique, 2):
            held.add(frozenset(pair))
        cliques.append(tuple(sorted(clique)))
    return cliques


def maximal_sets(sets: list[frozenset[UUID]]) -> list[frozenset[UUID]]:
    """The sets that no other set contains, each once, in a fixed order."""
    unique = sorted({s for s in sets if len(s) > 1}, key=lambda s: (-len(s), sorted(str(x) for x in s)))
    kept: list[frozenset[UUID]] = []
    for candidate in unique:
        if not any(candidate <= other for other in kept):
            kept.append(candidate)
    return kept


class EncodingSolver(MeasuringSolver):
    """MeasuringSolver whose cross-group rows are posted as `encoding` says (pairs: the engine's own)."""

    def __init__(self, settings: Settings, *, encoding: str, cohorts=(), **kwargs) -> None:
        super().__init__(settings, **kwargs)
        if encoding not in ENCODINGS:
            msg = f"encoding is one of {ENCODINGS}, not {encoding!r}"
            raise ValueError(msg)
        self.encoding = encoding
        self._cohorts = list(cohorts)
        #: What the last build posted: rows and the lessons in them, for the table.
        self.rows: dict[str, int] = {}

    def _add_group_no_overlap(self, model, decisions, group_conflicts=None, *, by_cliques=False):  # type: ignore[override]
        # `by_cliques` is the engine's own (M8 PR 6); the encoding a measurement asks for is `self.encoding`, and decides.
        grouped: dict[UUID, list] = {}
        for decision in decisions:
            grouped.setdefault(ss.pupil_key_of(decision.lesson.requirement), []).append(decision)
        rows = 0
        members = 0

        def post(part) -> None:
            nonlocal rows, members
            if len(part) > 1:
                model.AddNoOverlap([ss.pupil_padded_of(model, decision) for decision in part])
                rows += 1
                members += len(part)

        for group_decisions in grouped.values():
            for _, part in week_parts(group_decisions, ss._parity):
                post(part)
        if self.encoding in ("pairs", "both"):
            for first_id, second_id in group_conflicts or []:
                if first_id == second_id:
                    continue
                combined = grouped.get(first_id, []) + grouped.get(second_id, [])
                for _, part in week_parts(combined, ss._parity):
                    post(part)
        if self.encoding != "pairs":
            if self.encoding in ("cliques", "both"):
                sets = [frozenset(clique) for clique in clique_cover(list(group_conflicts or []), set(grouped))]
            else:
                sets = maximal_sets([frozenset(g for g in cohort if g in grouped) for cohort in self._cohorts])
            for clique in sets:
                combined = [d for group in sorted(clique, key=str) for d in grouped.get(group, [])]
                for _, part in week_parts(combined, ss._parity):
                    post(part)
        self.rows = {"noOverlapRows": rows, "noOverlapMembers": members}


def measure_encoding(
    week, encoding: str, *, mode: str, budget: float, deterministic_budget: float, seed: int,
) -> dict[str, object]:
    """One corpus week at one encoding: the corpus_measure row, plus what the build posted."""
    if mode == "count":
        budget = deterministic_budget * corpus_measure.COUNT_WALL_MULTIPLE
    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]
    solver = EncodingSolver(
        settings, encoding=encoding, cohorts=week.cohorts, mode=mode,
        deterministic_budget=deterministic_budget, seed=seed,
    )
    result = solver.measure(week.request)
    return {
        "name": week.name, "encoding": encoding, "seed": seed, "mode": mode, **solver.rows, **result,
        "facts": {k: week.facts[k] for k in ("classes", "requirements", "lessons", "groupConflicts", "teachers")},
        "cohorts": len(maximal_sets(list(week.cohorts))),
    }


# ---- the roads that cut the week: stages, each held by the next -------------------------------------


class _StageCp(cp_model.CpSolver):
    """A CpSolver that records its search, never stops the solve, and answers UNKNOWN to a second one.

    A stage wants the FIRST timetable and its lessons: phase 2 (improving it) is refused, so `solve()`
    falls back to phase 1's timetable and returns it with its lessons (the engine's own fallback)."""

    def __init__(self, recording, stage_of) -> None:
        super().__init__()
        self._recording = recording
        self._stage_of = stage_of

    def Solve(self, model, solution_callback=None):  # noqa: N802
        rec = self._recording
        if rec.first_at is not None:
            return cp_model.UNKNOWN
        started = time.monotonic()
        status = super().Solve(model, solution_callback)
        now = time.monotonic()
        response = self.ResponseProto()
        rec.searches.append(corpus_measure.Search(
            status=self.StatusName(status), seconds=now - started,
            deterministic=response.deterministic_time, conflicts=self.NumConflicts(),
            first_only=bool(self.parameters.stop_after_first_solution),
        ))
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            rec.first_at = now - rec.entered
            rec.first_deterministic = sum(s.deterministic for s in rec.searches)
            rec.stages = self._stage_of(now)
        return status


class StageSolver(EncodingSolver):
    """EncodingSolver that gives its generation searches `_StageCp` (the stage keeps the timetable)."""

    def _generation_solver(self, request, seconds):  # type: ignore[override]
        base = SchedulerSolver._generation_solver(request, seconds)
        solver = _StageCp(self.recording, self._stage_seconds)
        solver.parameters.copy_from(base.parameters)
        if self._mode == "count":
            solver.parameters.num_workers = 1
            solver.parameters.random_seed = self._seed
            solver.parameters.max_deterministic_time = self._deterministic_budget
            solver.parameters.max_time_in_seconds = self._deterministic_budget * corpus_measure.COUNT_WALL_MULTIPLE
        return solver


@dataclass
class Stage:
    """One solve of a road: what it was asked, what it found."""

    label: str
    status: str
    lessons_asked: int
    lessons_free: int
    seconds: float | None
    work: float | None
    wall: float
    load: tuple[float, float]
    codes: list[str]
    lessons: list = None  # type: ignore[assignment]
    #: The requirements an INFEASIBLE names (the engine's own explanation): what a repair lets go of.
    blamed: frozenset = frozenset()

    def row(self) -> dict[str, object]:
        return {
            "stage": self.label, "status": self.status, "lessonsAsked": self.lessons_asked,
            "lessonsFree": self.lessons_free,
            "firstScheduleSeconds": None if self.seconds is None else round(self.seconds, 2),
            "firstScheduleDeterministic": None if self.work is None else round(self.work, 3),
            "wallSeconds": round(self.wall, 2), "load": list(self.load), "codes": self.codes,
        }


def run_stage(
    request, *, label: str, free: int, encoding: str, cohorts, mode: str, budget: float,
    deterministic_budget: float, seed: int,
) -> Stage:
    """Solve `request` for its first timetable and keep the lessons (`free`: how many it had to place)."""
    from app.exceptions import OptimizationEngineError

    if mode == "count":
        budget = deterministic_budget * corpus_measure.COUNT_WALL_MULTIPLE
    settings = Settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]
    solver = StageSolver(
        settings, encoding=encoding, cohorts=cohorts, mode=mode,
        deterministic_budget=deterministic_budget, seed=seed,
    )
    load_before = os.getloadavg()[0]
    solver.recording.entered = started = time.monotonic()
    codes: list[str] = []
    lessons = None
    blamed: set = set()
    try:
        response = solver.solve(request)
        status = response.status
        if response.conflicts is not None:
            codes = sorted({detail.code for detail in response.conflicts.conflicts})
            for detail in response.conflicts.conflicts:
                blamed.update(detail.requirement_ids or ())
        if response.lessons:
            lessons = response.lessons
            status = "FIRST_SCHEDULE"
    except OptimizationEngineError as refusal:
        status = "REFUSED"
        codes = [type(refusal).__name__, str(refusal)[:160]]
    rec = solver.recording
    asked = sum(r.lessons_per_week for r in request.requirements)
    return Stage(
        label=label, status=status, lessons_asked=asked, lessons_free=free,
        seconds=rec.first_at, work=rec.first_deterministic, wall=time.monotonic() - started,
        load=(round(load_before, 1), round(os.getloadavg()[0], 1)), codes=codes, lessons=lessons,
        blamed=frozenset(blamed),
    )


def _in_places(requirement, placed: list) -> list:
    """`placed` in the order of the requirement's places, which is not the order of the clock.

    `pinnedLessons` has one place for each lesson IN THE ORDER OF `lesson_minutes()` (the longest first), and for
    a split post (`lessonTeacherIds`) place i is lead i's. A post of a 90- and a 60-minute lesson laid 60 on Monday
    and 90 on Tuesday has its 90 at place 0: pinned in clock order the engine would be asked about a Monday of 90
    and a Tuesday of 60, another timetable than the one the road laid, and `verified` would say yes to that one.
    Where every lesson of a post is as long as the others and has no lead of its own the order is the clock's, as before."""
    from_clock = sorted(placed, key=lambda l: (l.day_of_week, l.start_time))
    out: list = []
    for index, minutes in enumerate(requirement.lesson_minutes()):
        lead = requirement.lesson_teacher(index) if requirement.lesson_teacher_ids is not None else None
        pick = next(
            (
                l for l in from_clock
                if (int(l.end_time[:2]) * 60 + int(l.end_time[3:5])) - (int(l.start_time[:2]) * 60 + int(l.start_time[3:5])) == minutes
                and (lead is None or l.teacher_id == lead)
            ),
            None,
        )
        if pick is None:
            msg = f"{requirement.id} has no lesson of {minutes} minutes laid for place {index}"
            raise ValueError(msg)
        from_clock.remove(pick)
        out.append(pick)
    return out


def _pinned(requirements, lessons):
    """The requirements with every lesson in `lessons` pinned where it was laid (start only: rooms stay the engine's)."""
    from app.schemas.schedule import PinnedLesson

    by_requirement: dict[UUID, list] = {}
    for lesson in lessons:
        by_requirement.setdefault(lesson.requirement_id, []).append(lesson)
    out = []
    for requirement in requirements:
        placed = by_requirement.get(requirement.id, [])
        if len(placed) != requirement.lessons_per_week:
            msg = f"{requirement.id} has {len(placed)} lessons laid, the requirement asks {requirement.lessons_per_week}"
            raise ValueError(msg)
        placed = _in_places(requirement, placed)
        out.append(requirement.model_copy(update={"pinned_lessons": [
            PinnedLesson(dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time) for l in placed
        ]}))
    return out


def _sub_request(request, requirements, *, label: str, drop_periods: bool = False):
    """`request` over these requirements only: its groups, pairs and years follow."""
    import uuid

    ids = {requirement.student_group_id for requirement in requirements}
    pupil_ids = {r.pupil_group_id for r in requirements if getattr(r, "pupil_group_id", None)}
    grades = {r.min_grade_level for r in requirements}
    update = {
        "request_id": uuid.UUID(int=uuid.uuid5(request.request_id, label).int, version=4),
        "requirements": requirements,
        "groups": [g for g in request.groups if g.id in ids or g.min_grade_level in grades],
        "group_conflicts": [p for p in request.group_conflicts if p[0] in ids | pupil_ids and p[1] in ids | pupil_ids],
    }
    if drop_periods:
        update.update({"period_weeks": None, "period_odd_weeks": None, "lunch_per_period": False})
    return request.model_copy(update=update)


def _teacher_coupling(requirements) -> dict[int, int]:
    """For each year: the lessons of its teachers who also teach in another year (what shared teachers couple)."""
    years_of: dict[UUID, set[int]] = {}
    for r in requirements:
        if r.teacher_id is not None:
            years_of.setdefault(r.teacher_id, set()).add(r.min_grade_level)
    coupling: dict[int, int] = {}
    for r in requirements:
        coupling.setdefault(r.min_grade_level, 0)
        if r.teacher_id is not None and len(years_of[r.teacher_id]) > 1:
            coupling[r.min_grade_level] += r.lessons_per_week
    return coupling


def year_order(week, how: str) -> list[int]:
    """The order the years are laid in. `hardest`: most group pairs first (then most lessons, then coupling);
    `coupled`: the most teacher coupling first, then hardest; `up`/`down`: by the year."""
    years = sorted({r.min_grade_level for r in week.request.requirements})
    group_year = {r.student_group_id: r.min_grade_level for r in week.request.requirements}
    pairs = {y: 0 for y in years}
    for first, second in week.request.group_conflicts:
        if first in group_year and group_year.get(first) == group_year.get(second):
            pairs[group_year[first]] += 1
    lessons = {y: sum(r.lessons_per_week for r in week.request.requirements if r.min_grade_level == y) for y in years}
    coupling = _teacher_coupling(week.request.requirements)
    if how == "up":
        return years
    if how == "down":
        return years[::-1]
    if how == "coupled":
        return sorted(years, key=lambda y: (-coupling[y], -pairs[y], -lessons[y], y))
    if how == "hardest":
        return sorted(years, key=lambda y: (-pairs[y], -lessons[y], -coupling[y], y))
    msg = f"order is hardest, coupled, up or down, not {how!r}"
    raise ValueError(msg)


def _verify(week, lessons, args) -> bool:
    """The whole week, every lesson pinned where the road laid it: the engine must agree there is a timetable."""
    full = week.request.model_copy(update={"requirements": _pinned(week.request.requirements, lessons)})
    check = run_stage(
        full, label="verify", free=0, encoding="pairs", cohorts=(), mode="count", budget=0,
        deterministic_budget=args.det_budget, seed=1,
    )
    return check.status == "FIRST_SCHEDULE"


def _neighbours(week, free: list, held: list) -> list:
    """The held requirements one step from the free ones: the same teacher, or a group that shares a pupil."""
    teachers = {r.teacher_id for r in free if r.teacher_id is not None}
    groups = {r.student_group_id for r in free}
    reach = set(groups)
    for first, second in week.request.group_conflicts:
        if first in groups:
            reach.add(second)
        if second in groups:
            reach.add(first)
    return [r for r in held if r.teacher_id in teachers or r.student_group_id in reach]


def _run_with_repair(
    week, args, *, label: str, held: list, laid: dict, free: list, seed: int, stages: list, drop_periods: bool = False,
    flatten: bool = False,
):
    """Solve one stage; when it is INFEASIBLE with held lessons in the way, let go of those the engine names and again.

    `held` are the requirements already laid (pinned where `laid` has them), `free` the ones this stage places.
    A repair frees the held requirements the refusal's explanation names (`PLACED_LESSON_IN_THE_WAY`): the
    explanation is the engine's own and is what an in-engine road would use. Up to `args.repair` rounds.
    Returns the stage that answered and the requirements it left free."""
    freed: list = []
    for attempt in range(args.repair + 1):
        keep = [r for r in held if r not in freed]
        wide = [*free, *freed]
        flat = [r.model_copy(update={"periods": None}) for r in keep] if flatten else keep
        pinned = _pinned(flat, [l for r in keep for l in laid[r.id]]) if keep else []
        free_now = [r.model_copy(update={"periods": None}) for r in wide] if flatten else wide
        sub = _sub_request(week.request, [*pinned, *free_now], label=f"{label}-{attempt}", drop_periods=drop_periods)
        stage = run_stage(
            sub, label=label + (f" (repair {attempt})" if attempt else ""),
            free=sum(r.lessons_per_week for r in wide), encoding=args.stage_encoding, cohorts=week.cohorts,
            mode=args.mode, budget=args.budget, deterministic_budget=args.det_budget, seed=seed,
        )
        stages.append(stage)
        print("   ", json.dumps(stage.row()), flush=True)
        if stage.status == "FIRST_SCHEDULE":
            return stage, wide
        named = [r for r in keep if r.id in stage.blamed]
        if stage.status != "INFEASIBLE" or attempt == args.repair:
            return stage, wide
        # The explanation names the lessons in the way where it can; where it names a rule and no lesson
        # (a teacher's hours, say) the neighbourhood widens by one step: the held posts that share a teacher or
        # a pupil with what is free. Neither names anything: nothing is left to let go of.
        named = named or _neighbours(week, wide, keep)
        if not named:
            return stage, wide
        freed.extend(named)
    return stage, wide


def road_years(week, args, *, seed: int) -> dict[str, object]:
    """(b): one year at a time, the years laid held where they were laid."""
    order = year_order(week, args.order)
    stages: list[Stage] = []
    laid: dict[UUID, list] = {}
    done: list[int] = []
    failed = None
    for year in order:
        held = [r for r in week.request.requirements if r.min_grade_level in done]
        free = [r for r in week.request.requirements if r.min_grade_level == year]
        stage, wide = _run_with_repair(
            week, args, label=f"year {year}", held=held, laid=laid, free=free, seed=seed, stages=stages,
        )
        if stage.status != "FIRST_SCHEDULE":
            failed = stage.label
            break
        by_req: dict[UUID, list] = {}
        for lesson in stage.lessons:
            by_req.setdefault(lesson.requirement_id, []).append(lesson)
        laid.update(by_req)
        done.append(year)
    final = [l for group in laid.values() for l in group]
    return _road_row(week, "years:" + args.order, seed, args, stages, failed, final)


def _layers(requirements):
    """The requirements cut by the periods they run in: the year-round ones first, then the widest masks."""
    layers: dict[tuple[bool, ...] | None, list] = {}
    for r in requirements:
        layers.setdefault(r.periods, []).append(r)
    return sorted(layers.items(), key=lambda item: (item[0] is not None, -(sum(item[0]) if item[0] else 0), item[0] or ()))


def road_periods_core(week, args, *, seed: int) -> dict[str, object]:
    """(a), core first: the lessons that run all year, then each layer of the terms over what it shares periods with."""
    layers = _layers(week.request.requirements)
    stages: list[Stage] = []
    laid: dict[UUID, list] = {}
    placed: list = []  # (mask, requirements)
    failed = None
    for index, (mask, free) in enumerate(layers):
        # EVERY layer laid so far is held, the ones that share no period with this layer too: they cost the stage
        # nothing (a row is cut by period), and a repair that moves a held lesson must meet what was laid on it.
        # (The first version held only the layers that share a period; a repair then moved an earlier layer's
        # lesson under a later layer, and the merged week did not hold: `verified` said so.)
        held = [r for _earlier_mask, reqs in placed for r in reqs]
        name = "all year" if mask is None else "".join("x" if b else "." for b in mask)
        stage, wide = _run_with_repair(
            week, args, label=f"layer {index} {name}", held=held, laid=laid, free=free, seed=seed, stages=stages,
        )
        if stage.status != "FIRST_SCHEDULE":
            failed = stage.label
            break
        by_req: dict[UUID, list] = {}
        for lesson in stage.lessons:
            by_req.setdefault(lesson.requirement_id, []).append(lesson)
        laid.update(by_req)
        placed.append((mask, free))
    final = [l for group in laid.values() for l in group]
    return _road_row(week, "periods:core", seed, args, stages, failed, final)


def road_periods_calendar(week, args, *, seed: int) -> dict[str, object]:
    """(a), calendar: the week of the first period whole, then each next period with what it shares held."""
    count = max((len(r.periods) for r in week.request.requirements if r.periods), default=1)
    stages: list[Stage] = []
    laid: dict[UUID, list] = {}
    placed_ids: set[UUID] = set()
    failed = None
    for period in range(count):
        running = [r for r in week.request.requirements if r.periods is None or r.periods[period]]
        held = [r for r in running if r.id in placed_ids]
        free = [r for r in running if r.id not in placed_ids]
        if not free and period:
            continue
        stage, wide = _run_with_repair(
            week, args, label=f"period {period}", held=held, laid=laid, free=free, seed=seed, stages=stages,
            drop_periods=True, flatten=True,
        )
        if stage.status != "FIRST_SCHEDULE":
            failed = stage.label
            break
        by_req: dict[UUID, list] = {}
        for lesson in stage.lessons:
            by_req.setdefault(lesson.requirement_id, []).append(lesson)
        laid.update(by_req)
        placed_ids.update(r.id for r in running)
    final = [l for group in laid.values() for l in group]
    return _road_row(week, "periods:calendar", seed, args, stages, failed, final)


def _road_row(week, road: str, seed: int, args, stages, failed, lessons) -> dict[str, object]:
    solved = failed is None and bool(stages)
    verified = None
    if solved and args.verify:
        verified = _verify(week, lessons, args)
    works = [s.work for s in stages if s.work is not None]
    return {
        "name": week.name, "road": road, "seed": seed, "mode": args.mode,
        "status": "FIRST_SCHEDULE" if solved else "FAILED",
        "failedAt": failed, "verified": verified,
        "stages": [s.row() for s in stages],
        "firstScheduleDeterministic": round(sum(works), 3) if solved else None,
        "maxStageWork": round(max(works), 3) if works else None,
        "firstScheduleSeconds": round(sum(s.seconds for s in stages if s.seconds is not None), 2) if solved else None,
        "load": [stages[0].load[0], stages[-1].load[1]] if stages else [0, 0],
        "facts": {k: week.facts[k] for k in ("classes", "requirements", "lessons", "groupConflicts", "teachers")},
    }


def _road_job(task) -> dict[str, object]:
    import types

    shape_name, profile_name, road, seed, opts = task
    week = week_of(shape_name, profile_name)
    args = types.SimpleNamespace(**opts)
    runner = {"years": road_years, "periods-core": road_periods_core, "periods-calendar": road_periods_calendar}[road]
    return runner(week, args, seed=seed)


def cmd_road(args) -> int:
    road = args.command
    opts = {
        "mode": args.mode, "budget": args.budget, "det_budget": args.det_budget, "order": getattr(args, "order", "hardest"),
        "stage_encoding": args.stage_encoding, "verify": not args.no_verify, "repair": args.repair,
    }
    tasks = [
        (week.name.split("/")[-1], args.profile, road, seed, opts)
        for week in _shapes(args) for seed in range(1, args.seeds + 1)
    ]
    rows = []
    for task in tasks:
        print(f"== {task[0]} {road} seed {task[3]}", flush=True)
        row = _road_job(task)
        rows.append(row)
        print(_line(row), "verified", row["verified"], "failedAt", row["failedAt"], "maxStage",
              row["maxStageWork"], flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))
    return 0


# ---- M9: a schedule that exists, as the start ------------------------------------------------------


def _clashes(week, lessons) -> set[UUID]:
    """The requirements whose lessons sit on top of each other in `lessons` under THIS week's pairs.

    A schedule laid for another week of the same school (another seed: the same posts, teachers and groups, the
    pupils sitting in other groups, so a few other pairs) clashes only where a pair that is new meets lessons
    that overlap. Teachers and rooms are the same, and so are the posts."""
    groups: dict[UUID, list] = {}
    by_requirement = {r.id: r for r in week.request.requirements}
    for lesson in lessons:
        groups.setdefault(by_requirement[lesson.requirement_id].student_group_id, []).append(lesson)

    def overlap(first, second) -> bool:
        return first.day_of_week == second.day_of_week and first.start_time < second.end_time and second.start_time < first.end_time

    out: set[UUID] = set()
    for first, second in week.request.group_conflicts:
        for a in groups.get(first, ()):
            for b in groups.get(second, ()):
                if overlap(a, b):
                    out.update((a.requirement_id, b.requirement_id))
    return out


def start_from(week_from, week_into, args, *, seed: int) -> dict[str, object]:
    """M9, as far as it tells which road it shares: the schedule of `week_from` as the start of `week_into`.

    Three ways, each a first-timetable measurement of week_into:
      none   the week alone (the control),
      hint   the schedule as `previousLessons` (the engine's existing hint and disruption path),
      repair the lessons that clash with this week's pairs let go, the rest pinned where they were, and again
             with `--repair` rounds if the pins are in the way (the same driver as the roads that cut the week)."""
    base = run_stage(
        week_from.request, label="the earlier schedule", free=0, encoding=args.stage_encoding, cohorts=week_from.cohorts,
        mode=args.mode, budget=args.budget, deterministic_budget=args.det_budget, seed=seed,
    )
    out: dict[str, object] = {
        "name": week_into.name, "from": week_from.name, "seed": seed, "mode": args.mode,
        "earlier": base.row(),
    }
    if base.status != "FIRST_SCHEDULE":
        out["status"] = "NO_EARLIER_SCHEDULE"
        return out
    clashing = _clashes(week_into, base.lessons)
    out["clashingRequirements"] = len(clashing)
    out["requirements"] = len(week_into.request.requirements)
    from app.schemas.schedule import PreviousLesson

    for label, build in (
        (way, build) for way, build in (
        ("none", lambda: week_into.request),
        ("hint", lambda: week_into.request.model_copy(update={"previous_lessons": [
            PreviousLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time)
            for l in base.lessons
        ]})),
        ) if way in args.ways.split(",")
    ):
        stage = run_stage(
            build(), label=label, free=0, encoding=args.stage_encoding, cohorts=week_into.cohorts, mode=args.mode,
            budget=args.budget, deterministic_budget=args.det_budget, seed=seed,
        )
        out[label] = stage.row()
        print("   ", label, json.dumps(stage.row()), flush=True)
    if "repair" not in args.ways.split(","):
        return out
    held = [r for r in week_into.request.requirements if r.id not in clashing]
    free = [r for r in week_into.request.requirements if r.id in clashing]
    laid = {}
    for lesson in base.lessons:
        laid.setdefault(lesson.requirement_id, []).append(lesson)
    stages: list[Stage] = []
    stage, _wide = _run_with_repair(week_into, args, label="repair", held=held, laid=laid, free=free, seed=seed, stages=stages)
    out["repair"] = [s.row() for s in stages]
    out["repairStatus"] = stage.status
    return out


def cmd_start(args) -> int:
    rows = []
    for week_into in _shapes(args):
        for seed in range(1, args.seeds + 1):
            name = week_into.name.split("/")[-1]
            other = name.replace(f"-s{args.into}", f"-s{args.from_seed}", 1)
            week_from = week_of(other, args.profile)
            print(f"== {week_from.name} -> {week_into.name} seed {seed}", flush=True)
            row = start_from(week_from, week_into, args, seed=seed)
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k not in ("earlier", "none", "hint", "repair")}), flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))
    return 0


# ---- how tight a week each encoding can lay: the same week with the day ending later ---------------


def year_loads(week) -> list[float]:
    """The engine's own lower bound on each year's week as a share of its frame (week_load), the largest of each period."""
    from app.solver.scheduler_solver import _weeks_and_requests

    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=0))  # type: ignore[call-arg]
    solver.TIGHT_WEEK_LOAD = 0.0
    out = []
    for _label, one in solver._solved_weeks(_weeks_and_requests(week.request)):
        out.append(round(100 * max([load.load for load in solver._week_loads(one)] or [0.0]), 1))
    return out


def _slack_job(task) -> dict[str, object]:
    from dataclasses import replace

    from school_corpus import build_week

    shape_name, profile_name, end, encoding, mode, budget, det, seed = task
    shape = next(s for s in profile_shapes(profile_name) if s.name() == shape_name)
    shape = replace(shape, day=(shape.day[0], end + ":00", shape.day[2]))
    week = build_week(shape)
    row = measure_encoding(week, encoding, mode=mode, budget=budget, deterministic_budget=det, seed=seed)
    row["name"] = f"{shape_name}@{end}"
    row["yearLoad"] = year_loads(week)
    return row


def cmd_slack(args) -> int:
    tasks = [
        (week.name.split("/")[-1], args.profile, end, encoding, args.mode, args.budget, args.det_budget, seed)
        for week in _shapes(args)
        for end in args.ends.split(",")
        for seed in range(1, args.seeds + 1)
        for encoding in args.encodings.split(",")
    ]
    rows = []
    for task in tasks:
        row = _slack_job(task)
        rows.append(row)
        print(_line(row), "yearLoad", row["yearLoad"], flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))
    return 0


# ---- the table ------------------------------------------------------------------------------------


def _line(row: dict[str, object]) -> str:
    work = row.get("firstScheduleDeterministic")
    sec = row.get("firstScheduleSeconds")
    return (
        f"{row['name']:36s} {str(row.get('encoding', row.get('road', ''))):8s} seed {row['seed']} "
        f"{str(row['status']):14s} work {'-' if work is None else format(work, '.2f'):>6s} "
        f"sec {'-' if sec is None else format(sec, '.1f'):>6s} rows {row.get('noOverlapRows', '-')} "
        f"load {row['load'][0]}->{row['load'][1]}"
    )


def _shapes(args):
    wanted = args.only.split(",") if args.only else None
    shapes = [
        shape for shape in profile_shapes(args.profile)
        if wanted is None or any(
            shape.name().startswith(token[:-1]) if token.endswith("*") else shape.name() == token
            for token in wanted
        )
    ]
    if not shapes:
        raise SystemExit(f"no week of {args.profile} matches {args.only}")
    return [week_of(shape.name(), args.profile) for shape in shapes]


def _encoding_job(task) -> dict[str, object]:
    shape_name, profile_name, encoding, mode, budget, det, seed = task
    return measure_encoding(
        week_of(shape_name, profile_name), encoding, mode=mode, budget=budget, deterministic_budget=det, seed=seed,
    )


def cmd_encoding(args) -> int:
    tasks = [
        (week.name.split("/")[-1], args.profile, encoding, args.mode, args.budget, args.det_budget, seed)
        for week in _shapes(args)
        for seed in range(1, args.seeds + 1)
        for encoding in args.encodings.split(",")
    ]
    rows: list[dict[str, object]] = []
    if args.jobs <= 1:
        for task in tasks:
            row = _encoding_job(task)
            rows.append(row)
            print(_line(row), flush=True)
    else:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for row in pool.map(_encoding_job, tasks):
                rows.append(row)
                print(_line(row), flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("encoding",):
        one = sub.add_parser(name)
        one.add_argument("--profile", default="sweep")
        one.add_argument("--only", default=None)
        one.add_argument("--mode", choices=("count", "clock"), default="count")
        one.add_argument("--budget", type=float, default=180.0, help="seconds, clock mode")
        one.add_argument("--det-budget", type=float, default=4.0, help="deterministic seconds a search, count mode")
        one.add_argument("--seeds", type=int, default=1)
        one.add_argument("--jobs", type=int, default=1)
        one.add_argument("--encodings", default="pairs,cliques,cohorts")
        one.add_argument("--out", default=None)
    for name in ("years", "periods-core", "periods-calendar"):
        one = sub.add_parser(name)
        one.add_argument("--profile", default="sweep")
        one.add_argument("--only", default=None)
        one.add_argument("--mode", choices=("count", "clock"), default="count")
        one.add_argument("--budget", type=float, default=180.0)
        one.add_argument("--det-budget", type=float, default=4.0)
        one.add_argument("--seeds", type=int, default=1)
        one.add_argument("--stage-encoding", default="pairs", choices=ENCODINGS)
        one.add_argument("--order", default="hardest", choices=("hardest", "coupled", "up", "down"))
        one.add_argument("--no-verify", action="store_true")
        one.add_argument("--repair", type=int, default=0, help="rounds that let go of the held lessons a refusal names")
        one.add_argument("--out", default=None)
    one = sub.add_parser("slack")
    one.add_argument("--profile", default="sweep")
    one.add_argument("--only", default=None)
    one.add_argument("--ends", default="18:00,17:00,16:30,16:00", help="the day's end, as the corpus has it at 16:00")
    one.add_argument("--mode", choices=("count", "clock"), default="count")
    one.add_argument("--budget", type=float, default=180.0)
    one.add_argument("--det-budget", type=float, default=4.0)
    one.add_argument("--seeds", type=int, default=1)
    one.add_argument("--encodings", default="pairs,cliques")
    one.add_argument("--out", default=None)
    one = sub.add_parser("start")
    one.add_argument("--profile", default="sweep")
    one.add_argument("--only", default=None, help="the weeks to lay (the target seed's names)")
    one.add_argument("--into", type=int, default=1, help="the seed of the week to lay")
    one.add_argument("--from-seed", type=int, default=2, help="the seed of the week whose schedule is the start")
    one.add_argument("--mode", choices=("count", "clock"), default="count")
    one.add_argument("--budget", type=float, default=180.0)
    one.add_argument("--det-budget", type=float, default=4.0)
    one.add_argument("--seeds", type=int, default=1)
    one.add_argument("--stage-encoding", default="pairs", choices=ENCODINGS)
    one.add_argument("--repair", type=int, default=3)
    one.add_argument("--ways", default="none,hint,repair", help="which of none, hint, repair to measure")
    one.add_argument("--out", default=None)
    args = parser.parse_args()
    if args.command == "start":
        return cmd_start(args)
    if args.command == "slack":
        return cmd_slack(args)
    if args.command == "encoding":
        return cmd_encoding(args)
    return cmd_road(args)


if __name__ == "__main__":
    raise SystemExit(main())
