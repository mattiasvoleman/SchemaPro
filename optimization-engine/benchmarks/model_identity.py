#!/usr/bin/env python3
"""Does a change to the engine leave the model it builds exactly as it was?

An additive contract field promises every school that never sends it the same
model — the same variables, the same rows, in the same order — and so the same
timetable and the same bytes back. That is a property of two source trees and
not of either one, so this measures it: both trees build the same payloads,
and every build is reduced to a sha256 of its proto, serialised
deterministically (_proto_digest), under PYTHONHASHSEED=0.

WHAT IS COMPARED, per payload, each build on its own line:

    validate    _validate_request: "ok", or the refusal's code and params
    estimate    _estimate_model_size
    full        _build_model with the objective, phase 2's model
    feasible    _build_model without it, phase 1a's — and the probes' and the
                daily maximum's, which build the same on a relaxed copy
    explain     _build_model with assumptions, _explain_infeasible's, and the
                registry's records: every literal's index, code and params
    diagnosis   the TIMEOUT log line and the free-day wishes the objective prices
    placeable   _placeable_without_the_maximum's model for every group, taken
                off _solve_guarded before it would solve
    response    for a week of at most RESPOND_LESSONS lessons: phase 1a solved
                on one worker, seed 0, a deterministic-time budget, and the
                response it makes, as JSON bytes

THE PAYLOADS come from two places:

    bench       the benchmark schools — solve_2000_students.py at four sizes,
                hogstadium.py in every variant — and copies of them carrying
                what a teacher-keyed rule reads: co-teachers, reservations,
                locked lessons, previous lessons, rasts, the teachers' lunch
                and rest, Lärarens dag
    harvest     every request the test suite validates or builds a model for,
                recorded by running pytest with this file as a plugin

THE COMPARISON, as run for lessonTeacherIds (delade lektioner), from the
repository root:

    E=optimization-engine; PY=$E/.venv/bin/python; T=$(mktemp -d)
    git archive origin/main $E src/common/__fixtures__ src/calendar/__fixtures__ \\
        web/i18n/__fixtures__ | tar -x -C $T
    $PY $E/benchmarks/model_identity.py bench --out $T/bench.jsonl
    $PY $E/benchmarks/model_identity.py harvest --engine $T/$E --out $T/harvest.jsonl
    $PY $E/benchmarks/model_identity.py compare --base $T/$E --head $E \\
        $T/bench.jsonl $T/harvest.jsonl

HARVEST ON THE BASE TREE: CamelModel forbids a key it has not heard of, so a
payload recorded from the head's own tests can carry a field the base refuses.
A payload neither tree can read is counted and skipped; one that only one of
them reads is a difference. The summary tallies what each build came to —
built, refused by name, raised, solved or not — so "identical" is never read
off a column of errors. Exit status 1 on any difference, naming the payload
and the build.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
#: A week this small is solved for its response bytes; a bigger one is only built.
RESPOND_LESSONS = 240
#: The deterministic-time budget of that solve: the same proto searched the same
#: way stops at the same point on any machine and under any load.
RESPOND_DETERMINISTIC_SECONDS = 1.0
#: The methods whose first argument is the request, wrapped by the harvest.
RECORDED = (
    "solve",
    "_validate_request",
    "_build_model",
    "_estimate_model_size",
    "_validate_blocks",
    "_verify_subject_distribution",
    "_verify_teacher_work_rules",
    "_verify_teacher_day_rules",
    "_verify_rast_demands",
    "_timeout_diagnosis",
    "_free_day_wishes",
    "_daily_maximum_verdict",
    "_blocks_verdict",
    "_probe_timeout",
    "_explain_infeasible",
)


def _digest(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def _proto_digest(model: Any) -> str:
    """The model's proto in its binary wire form, hashed.

    Through ExportToFile, because ortools 9.15's proto is a C++ object with no
    SerializeToString. A CpModelProto has no map field, so its serialisation
    is deterministic: the same model is the same bytes, hints included.
    """
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "model.pb"
        if not model.ExportToFile(str(path)):
            msg = "ExportToFile failed"
            raise RuntimeError(msg)
        return _digest(path.read_bytes())


def _settings_dump(settings: Any) -> dict[str, Any]:
    """Every field of a Settings by its environment name, so it rebuilds exactly."""
    return {
        field.alias or name: getattr(settings, name)
        for name, field in type(settings).model_fields.items()
    }


def _payload_of(request: Any) -> dict[str, Any]:
    """The request as the keys it was given: a field it never set is left out,
    so a field the other tree has never heard of is not sent to it as null."""
    return request.model_dump(mode="json", by_alias=True, exclude_unset=True)


def _record(settings: Any, request: Any) -> dict[str, Any]:
    return {"settings": _settings_dump(settings), "request": _payload_of(request)}


# ---------------------------------------------------------------------------
# harvest: pytest with this file as a plugin
# ---------------------------------------------------------------------------


def pytest_configure(config: Any) -> None:  # noqa: ARG001 - pytest hook
    """Record every request the suite hands the solver, when asked to."""
    out = os.environ.get("MODEL_IDENTITY_HARVEST")
    if not out:
        return
    from app.schemas.schedule import OptimizeScheduleRequest
    from app.solver.scheduler_solver import SchedulerSolver

    seen: set[str] = set()
    sink = open(out, "a", encoding="utf-8")  # noqa: SIM115 - lives as long as the run

    def wrap(name: str) -> None:
        original = getattr(SchedulerSolver, name, None)
        if original is None:
            return

        def recording(self: Any, *args: Any, **kwargs: Any) -> Any:
            request = args[0] if args else kwargs.get("request")
            if isinstance(request, OptimizeScheduleRequest):
                try:
                    line = json.dumps(_record(self._settings, request), sort_keys=True)
                except (TypeError, ValueError):
                    line = None
                if line is not None:
                    key = _digest(line)
                    if key not in seen:
                        seen.add(key)
                        sink.write(line + "\n")
                        sink.flush()
            return original(self, *args, **kwargs)

        setattr(SchedulerSolver, name, recording)

    for name in RECORDED:
        wrap(name)


def harvest(engine: Path, out: Path, pytest_args: list[str]) -> int:
    """Run ENGINE's own test suite with the recorder in it."""
    out = out.resolve()
    out.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory() as plugin_dir:
        # A copy under its own name in a directory of its own, so the plugin is
        # importable without putting this tree's benchmarks/ on the suite's path.
        shutil.copy(__file__, Path(plugin_dir) / "_model_identity_plugin.py")
        env = {
            **os.environ,
            "PYTHONPATH": plugin_dir,
            "PYTHONHASHSEED": "0",
            "MODEL_IDENTITY_HARVEST": str(out),
        }
        code = subprocess.call(
            [sys.executable, "-m", "pytest", "-q", "-p", "_model_identity_plugin",
             "-p", "no:cacheprovider", *(pytest_args or ["tests"])],
            cwd=engine,
            env=env,
        )
    lines = sum(1 for _ in out.open(encoding="utf-8")) if out.exists() else 0
    print(f"harvested {lines} payloads into {out} (pytest exit {code})")
    return 0 if lines else 1


# ---------------------------------------------------------------------------
# bench: the benchmark schools and copies of them that reach every teacher rule
# ---------------------------------------------------------------------------


def _with_teacher_rules(payload: dict[str, Any], *, label: str) -> dict[str, Any]:
    """The same school with something on it for every teacher-keyed builder.

    Deterministic, off the payload's own rows: a co-teacher on every seventh
    requirement, a PREFERRED_FREE and a dated UNAVAILABLE on every fifth
    teacher, a locked lesson for every eleventh, a lunch, a rest, a cap and a
    free-day wish on every third and a post of four days on every ninth,
    previous lessons for every requirement, and a rast that asks for a lesson
    before it wherever the groups have years.
    """
    import uuid

    namespace = uuid.UUID("5d1e0f7a-3c2b-4a19-8e6d-2b7c9f0a1e44")

    def uid(text: str) -> str:
        return str(uuid.UUID(int=uuid.uuid5(namespace, f"{label}-{text}").int, version=4))

    payload = json.loads(json.dumps(payload))
    requirements = payload["requirements"]
    teachers = list(dict.fromkeys(r["teacherId"] for r in requirements if r.get("teacherId")))
    for index, requirement in enumerate(requirements):
        if index % 7 == 3 and len(teachers) > 1:
            co = teachers[(teachers.index(requirement["teacherId"]) + 1) % len(teachers)]
            if co != requirement["teacherId"]:
                requirement["coTeacherId"] = co
    constraints = payload.setdefault("constraints", [])
    for index, teacher in enumerate(teachers):
        if index % 5 == 0:
            constraints.append({
                "id": uid(f"pref-{index}"), "resourceKind": "TEACHER", "resourceId": teacher,
                "dayOfWeek": (index % 5) + 1, "startTime": "08:00:00", "endTime": "09:00:00",
                "kind": "PREFERRED_FREE",
            })
            constraints.append({
                "id": uid(f"dated-{index}"), "resourceKind": "TEACHER", "resourceId": teacher,
                "date": "2026-11-0" + str((index % 5) + 2), "startTime": "10:00:00",
                "endTime": "11:00:00", "kind": "UNAVAILABLE",
            })
    fixed = payload.setdefault("fixedLessons", [])
    for index, teacher in enumerate(teachers):
        if index % 11 == 0:
            fixed.append({
                "id": uid(f"locked-{index}"), "teacherId": teacher,
                "studentGroupId": uid(f"locked-group-{index}"),
                "dayOfWeek": (index % 5) + 1, "startTime": "15:00:00", "endTime": "16:00:00",
            })
    rules = payload.setdefault("teacherWorkRules", [])
    limits = payload.setdefault("teacherDayLimits", [])
    ruled = {rule["teacherId"] for rule in rules}
    posted = {limit["teacherId"] for limit in limits}
    for index, teacher in enumerate(teachers):
        if index % 3 == 0 and teacher not in ruled:
            rules.append({
                "id": uid(f"rule-{index}"), "teacherId": teacher,
                "lunchMinutes": 30, "lunchStartTime": "11:00:00", "lunchEndTime": "13:30:00",
                "minDailyRestMinutes": 11 * 60,
                "maxTeachingMinutesPerDay": 360,
                "preferredFreeDay": (index % 5) + 1,
            })
        if index % 9 == 0 and teacher not in posted:
            held = sorted({
                lesson["dayOfWeek"] for lesson in fixed
                if teacher in (lesson.get("teacherId"), lesson.get("coTeacherId"))
            })
            limits.append({
                "id": uid(f"post-{index}"), "teacherId": teacher,
                "maxTeachingDaysPerWeek": 4, "lockedWeekdays": [held],
            })
    previous = payload.setdefault("previousLessons", [])
    for index, requirement in enumerate(requirements):
        for lesson in range(requirement["lessonsPerWeek"]):
            previous.append({
                "requirementId": requirement["id"],
                "dayOfWeek": ((index + lesson) % 5) + 1,
                "startTime": f"{8 + (index + 2 * lesson) % 6:02d}:00:00",
            })
    years = [
        (group["minGradeLevel"], group["maxGradeLevel"])
        for group in payload.get("groups") or []
        if group.get("minGradeLevel") is not None and group.get("maxGradeLevel") is not None
    ]
    if years:
        payload.setdefault("rasts", []).append({
            "minGradeLevel": min(low for low, _ in years),
            "maxGradeLevel": max(high for _, high in years),
            "startTime": "09:40:00", "endTime": "10:00:00", "requiresLessonBefore": True,
        })
    return payload


def bench(out: Path) -> int:
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(HERE.parent))
    os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
    os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")
    import hogstadium
    import solve_2000_students
    from app.config import Settings

    settings = Settings(SOLVER_MAX_TIME_SECONDS=60.0)  # type: ignore[call-arg]
    payloads: list[tuple[str, dict[str, Any]]] = []
    for students in (250, 500, 1000, 2000):
        request = solve_2000_students.build_request(
            solve_2000_students.SchoolShape(students=students),
        )
        payloads.append((f"school-{students}", _payload_of(request)))
    for blocks in (True, False):
        for rules, infeasible in ((False, False), (True, False), (True, True)):
            request = hogstadium.build_request(
                blocks=blocks, teacher_day_rules=rules, infeasible_days=infeasible,
            )
            payloads.append((
                f"hogstadium-blocks{int(blocks)}-rules{int(rules)}-infeasible{int(infeasible)}",
                _payload_of(request),
            ))
    for label, payload in list(payloads):
        if label in ("school-250", "school-500", "hogstadium-blocks1-rules1-infeasible0",
                     "hogstadium-blocks0-rules0-infeasible0"):
            payloads.append((f"{label}-teacher-rules", _with_teacher_rules(payload, label=label)))
    with out.open("w", encoding="utf-8") as sink:
        for label, payload in payloads:
            sink.write(json.dumps(
                {"label": label, "settings": _settings_dump(settings), "request": payload},
                sort_keys=True,
            ) + "\n")
    print(f"wrote {len(payloads)} benchmark payloads into {out}")
    return 0


# ---------------------------------------------------------------------------
# hash: one tree's digests, in a process of its own
# ---------------------------------------------------------------------------


def _hash_one(record: dict[str, Any]) -> dict[str, str]:
    from ortools.sat.python import cp_model

    import app.solver.scheduler_solver as module
    from app.config import Settings
    from app.exceptions import InvalidScheduleInputError
    from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse

    settings = Settings(**record["settings"])
    request = OptimizeScheduleRequest.model_validate(record["request"])
    solver = module.SchedulerSolver(settings)
    out: dict[str, str] = {}

    def attempt(key: str, build: Any) -> None:
        try:
            out[key] = build()
        except InvalidScheduleInputError as error:
            out[key] = f"refused {error.code} {json.dumps(error.params, sort_keys=True)}"
        except Exception as error:  # noqa: BLE001 - the difference IS the finding
            out[key] = f"raised {type(error).__name__}: {error}"

    attempt("validate", lambda: (solver._validate_request(request), "ok")[1])
    attempt("estimate", lambda: str(solver._estimate_model_size(request)))

    def built(*, objective: bool, assumptions: bool) -> str:
        model, registry, decisions, plan, lunches = solver._build_model(
            request, use_assumptions=assumptions, include_objective=objective,
        )
        parts = [
            _proto_digest(model),
            str(len(decisions)),
            str(sorted(plan.literals)),
            str(list(lunches)),
        ]
        if assumptions:
            parts.append(repr([
                (r.literal.Index(), r.category, r.code, sorted(r.params.items()),
                 [str(i) for i in r.requirement_ids], [str(i) for i in r.room_ids],
                 [str(i) for i in r.constraint_ids], [str(i) for i in r.resource_ids])
                for r in registry._records
            ]))
        return _digest("|".join(parts))

    attempt("full", lambda: built(objective=True, assumptions=False))
    attempt("feasible", lambda: built(objective=False, assumptions=False))
    attempt("explain", lambda: built(objective=False, assumptions=True))
    attempt("diagnosis", lambda: _digest(
        solver._timeout_diagnosis(request, "identity")
        + repr(solver._free_day_wishes(request, solver._resolve_weights(request))),
    ))

    def placeable() -> str:
        _model, _registry, decisions, _plan, _lunches = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        groups: dict[Any, list[Any]] = {}
        for decision in decisions:
            groups.setdefault(decision.lesson.requirement.student_group_id, []).append(decision)
        taken: list[str] = []
        original = module._solve_guarded

        def capture(_solver: Any, model: Any, **_kwargs: Any) -> int:
            taken.append(_proto_digest(model))
            return cp_model.UNKNOWN

        module._solve_guarded = capture
        try:
            for group in groups.values():
                solver._placeable_without_the_maximum(
                    request, group, deadline=time.monotonic() + 3600,
                )
        finally:
            module._solve_guarded = original
        return _digest("|".join(taken))

    attempt("placeable", placeable)

    def respond() -> str:
        if sum(r.lessons_per_week for r in request.requirements) > RESPOND_LESSONS:
            return "not solved: too big"
        model, _registry, decisions, plan, lunches = solver._build_model(
            request, use_assumptions=False, include_objective=False,
        )
        cp = cp_model.CpSolver()
        cp.parameters.num_workers = 1
        cp.parameters.random_seed = 0
        cp.parameters.max_deterministic_time = RESPOND_DETERMINISTIC_SECONDS
        status = cp.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return f"status {cp.StatusName(status)}"
        response = OptimizeScheduleResponse(
            request_id=request.request_id,
            status=solver._map_status(status),
            lessons=solver._extract_lessons(cp, decisions, request.rooms, plan),
            lunches=solver._lunches_of(cp, lunches, request.rules),
        )
        return _digest(response.model_dump_json())

    attempt("response", respond)
    return out


def hash_payloads(engine: Path, out: Path, files: list[Path]) -> int:
    sys.path.insert(0, str(engine.resolve()))
    os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
    os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")
    import logging

    logging.disable(logging.CRITICAL)
    from pydantic import ValidationError

    results: dict[str, Any] = {}
    for path in files:
        for number, line in enumerate(path.open(encoding="utf-8"), 1):
            record = json.loads(line)
            key = f"{path.name}:{number}:{record.get('label', '')}"
            try:
                results[key] = _hash_one(record)
            except ValidationError as error:
                results[key] = {"unreadable": f"{error.error_count()} errors"}
    out.write_text(json.dumps(results, sort_keys=True, indent=1), encoding="utf-8")
    return 0


# ---------------------------------------------------------------------------
# compare: both trees, then every digest against its twin
# ---------------------------------------------------------------------------


def compare(base: Path, head: Path, files: list[Path]) -> int:
    with tempfile.TemporaryDirectory() as scratch:
        jobs = []
        for name, engine in (("base", base), ("head", head)):
            target = Path(scratch) / f"{name}.json"
            jobs.append((name, target, subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "hash",
                 "--engine", str(engine.resolve()), "--out", str(target),
                 *[str(f.resolve()) for f in files]],
                # An empty directory, so no .env of either tree's reaches Settings.
                cwd=scratch,
                env={**os.environ, "PYTHONHASHSEED": "0"},
            )))
        digests = {}
        for name, target, process in jobs:
            if process.wait() != 0:
                print(f"{name}: hashing failed (exit {process.returncode})")
                return 1
            digests[name] = json.loads(target.read_text(encoding="utf-8"))
    base_d, head_d = digests["base"], digests["head"]
    differences = []
    compared = skipped = builds = 0
    for key in sorted(set(base_d) | set(head_d)):
        one, other = base_d.get(key, {}), head_d.get(key, {})
        if "unreadable" in one or "unreadable" in other:
            skipped += 1
            if ("unreadable" in one) != ("unreadable" in other):
                differences.append((key, "readable", one, other))
            continue
        compared += 1
        for build in sorted(set(one) | set(other)):
            builds += 1
            if one.get(build) != other.get(build):
                differences.append((key, build, one.get(build), other.get(build)))
    print(f"compared {compared} payloads, {builds} builds; {skipped} unreadable skipped")
    # What the builds were, so "identical" is not read off a column of errors.
    outcomes: dict[str, dict[str, int]] = {}
    for digests in base_d.values():
        for build, value in digests.items():
            kind = value.split(" ", 1)[0] if value.startswith(
                ("refused", "raised", "not", "status")) else "built"
            outcomes.setdefault(build, {}).setdefault(kind, 0)
            outcomes[build][kind] += 1
    for build in sorted(outcomes):
        print(f"  {build:10} " + ", ".join(
            f"{count} {kind}" for kind, count in sorted(outcomes[build].items())))
    for key, build, one, other in differences:
        print(f"DIFFERENT {key} {build}\n  base {one}\n  head {other}")
    if not differences:
        print("every build is identical")
    return 1 if differences else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("bench", help="write the benchmark payloads")
    one.add_argument("--out", type=Path, required=True)
    one = commands.add_parser("harvest", help="record the test suite's payloads")
    one.add_argument("--engine", type=Path, default=HERE.parent)
    one.add_argument("--out", type=Path, required=True)
    one.add_argument("pytest_args", nargs="*")
    one = commands.add_parser("hash", help="one tree's digests")
    one.add_argument("--engine", type=Path, required=True)
    one.add_argument("--out", type=Path, required=True)
    one.add_argument("files", nargs="+", type=Path)
    one = commands.add_parser("compare", help="both trees' digests, compared")
    one.add_argument("--base", type=Path, required=True)
    one.add_argument("--head", type=Path, default=HERE.parent)
    one.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    if args.command == "bench":
        return bench(args.out)
    if args.command == "harvest":
        return harvest(args.engine, args.out, args.pytest_args)
    if args.command == "hash":
        # The digests are only comparable under one hash seed. compare and
        # harvest start their children with PYTHONHASHSEED=0; a hash run by
        # hand is asked to, rather than this process restarting itself.
        if os.environ.get("PYTHONHASHSEED") != "0":
            print("hash: run under PYTHONHASHSEED=0, as compare runs it", file=sys.stderr)
            return 2
        return hash_payloads(args.engine, args.out, args.files)
    return compare(args.base, args.head, args.files)


if __name__ == "__main__":
    raise SystemExit(main())
