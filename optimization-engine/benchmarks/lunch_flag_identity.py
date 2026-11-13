#!/usr/bin/env python3
"""Does `lunchPerPeriod` leave a class that does not need parts the model it had?

model_identity.py compares two source TREES. This compares one tree with itself,
a request with and without a field: every payload of a harvest (or of `bench`)
that carries `periodWeeks` and a lunch rule is built twice, as it was sent and
with `lunchPerPeriod: true` added, and every build of both is reduced to the
digests model_identity.py takes (validate, estimate, full, feasible, explain,
diagnosis, placeable, response, solve).

THE PROMISE (Klassens måltid per del av läsåret, scheduler_solver._lunch_parts):
a class whose locked lessons and placed meals are alike in every period is ONE
part, builds the variable, the domain and the rows it always built, and answers
with one meal and no mask. So a payload on which no class has more than one part
must be the same under the flag in every build; one on which some class has
several is EXPECTED to differ (it is the reason for the field) and is listed, not
counted against the promise. A payload that differs and has no class in parts is
the finding, and the exit status is 1.

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

    seen = identical = in_parts = refused_differently = 0
    findings: list[str] = []
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
            if not differing:
                identical += 1
                continue
            parted = any(count > 0 for count in recorded)
            lunch_refusal = "validate" in differing and str(before.get("validate", "")).startswith(
                "refused LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK",
            )
            if parted:
                in_parts += 1
            elif lunch_refusal:
                refused_differently += 1
            else:
                findings.append(f"DIFFERENT {key}: {differing}")
    print(
        f"{seen} payloads with periods and a lunch rule: {identical} identical in every build, "
        f"{in_parts} differ with a class in parts (expected), "
        f"{refused_differently} refused differently by period (expected)",
    )
    for finding in findings:
        print(finding)
    if not findings:
        print("no payload without a class in parts differs under the flag")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
