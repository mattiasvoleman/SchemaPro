#!/usr/bin/env python3
"""Does `lunchPerPeriod` leave a class that does not need parts the model it had?

model_identity.py compares two source TREES. This compares one tree with itself,
a request with and without a field: every payload of a harvest (or of `bench`)
that carries `periodWeeks` and a lunch rule is built twice, as it was sent and
with `lunchPerPeriod: true` added, and every build of both is reduced to the
digests model_identity.py takes (validate, estimate, full, feasible, explain,
diagnosis, placeable, response, solve).

THE PROMISE (Klassens måltid per del av läsåret, scheduler_solver._lunch_parts):
a class whose locked lessons and placed meals leave its meal the same STARTS in
every period is ONE part, builds the variable, the domain and the rows it always
built, and answers with one meal and no mask. So a payload on which no class has
starts that differ between periods must be the same under the flag in every
build; one on which some class has such starts is EXPECTED to differ (it is the
reason for the field) and is listed, not counted against the promise.

WHICH CLASSES HAVE DIFFERING STARTS IS READ FROM THE PAYLOAD ALONE (`classes_in_
parts`, in minutes, sharing no code with the engine), and NOT from the engine's
own `_lunch_parts`: a reading that trusted the engine's split could never see the
engine split what its starts do not tell apart (the review of #314, MEDEL-2). A
payload that differs where no class has differing starts is the finding, and so is
one that does not differ where one has (the engine missed a part); the exit
status is 1 for either.

Per-period pre-flights are the one place a request without parts can differ in
a build: `validate` asks the lunch refusals of each period instead of the year's,
so a payload the year's reading refuses (LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK
with `lockPeriods`) is read differently by design, and is classed as "refused
differently" with both refusals shown.

    E=optimization-engine; PY=$E/.venv/bin/python
    $PY $E/benchmarks/model_identity.py harvest --engine $E --out /tmp/h.jsonl
    $PY $E/benchmarks/lunch_flag_identity.py /tmp/h.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

os.environ.setdefault("API_KEY", "benchmark-key-0000000000000000000000")
os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost")


def _minutes(clock: str) -> int:
    hours, minutes, *_ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def classes_in_parts(request: dict[str, Any]) -> int:
    """How many classes the payload gives different meal starts in different periods: locks and placed meals, in minutes.

    A lock closes the starts s of a meal of m minutes with start - m < s < end;
    what a class has left of the lunch window [first, last] in a period, and the
    meals placed for it, is that period's reading, and a class with two
    different readings is in parts. The payload alone: no engine code, so an
    engine that splits what the starts do not tell apart is seen.
    """
    rules = request["rules"]
    first, last = _minutes(rules["lunchStartTime"]), _minutes(rules["lunchEndTime"]) - rules["lunchMinutes"]
    count = len(request["periodWeeks"])
    sharing: dict[str, set[str]] = {}
    for left, right in request.get("groupConflicts", []):
        sharing.setdefault(left, set()).add(right)
        sharing.setdefault(right, set()).add(left)
    eating = {group["id"] for group in request.get("groups", [])} or {
        requirement["studentGroupId"] for requirement in request.get("requirements", [])
    }
    closed: dict[tuple[str, int], list[list[tuple[int, int]]]] = {}
    placed: dict[tuple[str, int], list[dict[int, int]]] = {}
    for fixed in request.get("fixedLessons", []):
        low = max(_minutes(fixed["startTime"]) - rules["lunchMinutes"] + 1, first)
        high = min(_minutes(fixed["endTime"]) - 1, last)
        if low > high:
            continue
        named = {fixed["studentGroupId"], *fixed.get("extraGroupIds", [])}
        for group in {*named, *(other for name in named for other in sharing.get(name, ()))} & eating:
            per_period = closed.setdefault((group, fixed["dayOfWeek"]), [[] for _ in range(count)])
            for period in range(count):
                if fixed.get("periods") is None or fixed["periods"][period]:
                    per_period[period].append((low, high))
    for placement in request.get("lunchPlacements", []):
        per_period_pins = placed.setdefault((placement["studentGroupId"], placement["dayOfWeek"]), [{} for _ in range(count)])
        for period in range(count):
            if placement.get("periods") is None or placement["periods"][period]:
                per_period_pins[period][0] = _minutes(placement["startTime"])

    def merged(spans: list[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
        out: list[tuple[int, int]] = []
        for low, high in sorted(spans):
            if out and low <= out[-1][1] + 1:
                out[-1] = (out[-1][0], max(out[-1][1], high))
            else:
                out.append((low, high))
        return tuple(out)

    reading: dict[str, list[tuple[object, ...]]] = {group: [() for _ in range(count)] for group in eating}
    for group in eating:
        for period in range(count):
            reading[group][period] = (
                tuple(sorted(
                    (day, merged(per_period[period])) for (name, day), per_period in closed.items() if name == group
                )),
                tuple(sorted(
                    (day, pins[period].get(0)) for (name, day), pins in placed.items() if name == group
                )),
            )
    return sum(1 for group in eating if len({reading[group][period] for period in range(count)}) > 1)


def _carries_lunch_and_periods(request: dict[str, Any]) -> bool:
    rules = request.get("rules") or {}
    return bool(request.get("periodWeeks")) and bool(
        rules.get("lunchStartTime") and rules.get("lunchEndTime") and rules.get("lunchMinutes"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()

    import logging

    logging.disable(logging.CRITICAL)
    from pydantic import ValidationError

    import app.solver.scheduler_solver as module
    from model_identity import _hash_one

    original = module.SchedulerSolver._lunch_parts
    recorded: list[int] = []

    def watching(self: Any, *arguments: Any, **keywords: Any) -> Any:
        parts = original(self, *arguments, **keywords)
        recorded.append(len(parts))
        return parts

    module.SchedulerSolver._lunch_parts = watching  # type: ignore[method-assign]

    seen = identical = in_parts = refused_differently = estimated = 0
    findings: list[str] = []
    missed = split_without_cause = 0
    for path in args.files:
        for number, line in enumerate(path.open(encoding="utf-8"), 1):
            record = json.loads(line)
            request = record["request"]
            if not _carries_lunch_and_periods(request) or request.get("lunchPerPeriod"):
                continue
            key = f"{path.name}:{number}"
            try:
                before = _hash_one(record)
                recorded.clear()
                after = _hash_one({**record, "request": {**request, "lunchPerPeriod": True}})
            except ValidationError as error:
                findings.append(f"UNREADABLE {key}: {error.error_count()} errors")
                continue
            seen += 1
            differing = sorted(build for build in set(before) | set(after) if before.get(build) != after.get(build))
            # What the PAYLOAD says (classes_in_parts), and what the engine did with it (`recorded`).
            by_starts = classes_in_parts(request) > 0
            by_engine = any(count > 0 for count in recorded)
            if by_starts and not by_engine:
                missed += 1
                findings.append(f"MISSED {key}: a class has different starts in different periods and the engine built it as one part")
            if by_engine and not by_starts:
                split_without_cause += 1
                findings.append(f"SPLIT WITHOUT CAUSE {key}: the engine split a class whose starts are alike in every period")
            if not differing:
                identical += 1
                continue
            if differing == ["estimate"] and int(after["estimate"]) > int(before["estimate"]):
                # The size guard (_estimate_model_size) charges an upper bound for the parts a request that
                # asks for them could have, whether or not any class has more than one: no model differs.
                estimated += 1
                continue
            lunch_refusal = "validate" in differing and str(before.get("validate", "")).startswith(
                "refused LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
            )
            if by_starts:
                in_parts += 1
            elif lunch_refusal:
                refused_differently += 1
            elif not by_engine:
                findings.append(f"DIFFERENT {key}: {differing}")
    print(
        f"{seen} payloads with periods and a lunch rule: {identical} identical in every build, "
        f"{in_parts} differ with a class in parts by its starts (expected), "
        f"{refused_differently} refused differently by period (expected), "
        f"{estimated} differ only in the size guard's upper bound (expected)",
    )
    print(f"{missed} payloads where the starts differ and the engine saw one part, {split_without_cause} where it split a class whose starts are alike")
    for finding in findings:
        print(finding)
    if not findings:
        print("no payload without a class in parts by its starts differs under the flag, and the engine split exactly the classes its starts split")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
