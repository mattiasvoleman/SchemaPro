#!/usr/bin/env python3
"""The tables of a corpus measurement: for each size, how many weeks got a timetable, how many ran out of time, how many were refused, and how long the first took.

    python benchmarks/corpus_report.py sweep-count.json
    python benchmarks/corpus_report.py sweep-count.json --clock sweep-clock.json

`corpus_measure.py --profile sweep --json` writes a list of weeks; this reads one or two such
lists (the second measured in clock mode, for seconds) and prints what the handbook and
DEPLOYMENT.md §35 quote. Nothing here measures anything.

A WEEK'S OUTCOME is one of three: `schema` (a first timetable inside the budget), `timeout` (none
inside it) and `vägran` (the engine proved the week impossible, or refused it before it built a
model). A refusal is not a failure of the search and is not counted as one: the table says
how many weeks of a size cannot be timetabled at all, apart from how many the search gave up on.
A fourth status, ERROR, is a measurement that failed (the hook never called, a wall-clock limit that
decided, a tree that could not be handed the week): it is no outcome of the week, and the report
refuses it by name rather than count it as a refusal, which would put "the engine proved it
impossible" in a table nobody proved.

THE UNIT of the work column is CP-SAT's deterministic second (count mode), the same on every
machine; the seconds column, when a clock measurement is given, is the wall-clock seconds of the
same weeks with every core, on the machine and at the load the measurement says.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path

SOLVED = "FIRST_SCHEDULE"

#: The words of the tables: Swedish for the handbook, English for docs/ (DEPLOYMENT.md is English).
TEXT: dict[str, dict[str, str]] = {
    "sv": {
        "weeks": "veckor", "schema": "schema", "timeout": "timeout", "refused": "vägran",
        "work_median": "arbete median", "work_p90": "arbete p90", "sec_median": "sek median", "sec_p90": "sek p90",
        "n": "N klasser", "g": "G ämnen", "m": "M delade lärare", "terms": "terminsämnen",
        "m_each": "{m} (med {per} grupper var)", "n_variant": "N klasser (variant)",
        "t_n3": "Klasser, tre ämnen i grupper över klasserna (N)",
        "t_n0": "Klasser, varje ämne för sig (inga grupper över klasserna)",
        "t_g": "Ämnen i grupper över klasserna (G), {size} klasser",
        "t_m": "Delade lärare (M), {size} klasser, tre ämnen i grupper",
        "t_terms": "Terminslektioner (ämnen som bara går en termin), 12 klasser, tre ämnen i grupper",
        "t_prod": "Produktionsformen (tio ämnen i grupper, halvgrupper, terminer, produktionens ram)",
    },
    "en": {
        "weeks": "weeks", "schema": "timetable", "timeout": "timeout", "refused": "refused",
        "work_median": "work median", "work_p90": "work p90", "sec_median": "s median", "sec_p90": "s p90",
        "n": "N classes", "g": "G subjects", "m": "M shared teachers", "terms": "term subjects",
        "m_each": "{m} (with {per} groups each)", "n_variant": "N classes (variant)",
        "t_n3": "Classes, three subjects in groups across the classes (N)",
        "t_n0": "Classes, every subject by class (no groups across the classes)",
        "t_g": "Subjects in groups across the classes (G), {size} classes",
        "t_m": "Shared teachers (M), {size} classes, three subjects in groups",
        "t_terms": "Term lessons (subjects that run one term only), 12 classes, three subjects in groups",
        "t_prod": "The production form (ten subjects in groups, half groups, terms, production's frame)",
    },
}


def outcome(row: dict[str, object]) -> str:
    """`schema`, `timeout` or `vägran` for one measured week; an ERROR week has none and raises ValueError."""
    if row["status"] == SOLVED:
        return "schema"
    if row["status"] == "TIMEOUT":
        return "timeout"
    if row["status"] == "ERROR":
        codes = ", ".join(str(code) for code in list(row.get("conflictCodes") or [])[:1])
        msg = (
            f"{row.get('name')}: ERROR ({codes or 'no code'}) is a measurement that failed, not an outcome "
            "of the week: measure it again"
        )
        raise ValueError(msg)
    return "vägran"


def _variant(name: str) -> str:
    """What a production-form week's name says beyond its size and seed: `t5-h`, `t5p6-h`, `t5-q1-h` ..."""
    parts = name.split("-")
    return "-".join(parts[4:]) if len(parts) > 4 else "-"


def percentile(values: list[float], share: float) -> float | None:
    """The `share` percentile by linear interpolation; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = share * (len(ordered) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarise(
    rows: Iterable[dict[str, object]], seconds: dict[str, float] | None = None, factor: float | None = None,
) -> dict[str, object]:
    """Counts, medians and the 90th percentile of one cell of a table.

    Seconds come from a clock measurement of the same weeks (`seconds`, by name) or, with
    `factor`, are the work times that many seconds per deterministic second: an ESTIMATE for one
    worker on the machine the factor was measured on, never a measurement."""
    rows = list(rows)
    kinds = [outcome(row) for row in rows]
    work = [float(r["firstScheduleDeterministic"]) for r in rows if r["status"] == SOLVED]  # type: ignore[arg-type]
    if seconds:
        wall = [seconds[str(r["name"])] for r in rows if r["status"] == SOLVED and str(r["name"]) in seconds]
    elif factor is not None:
        wall = [value * factor for value in work]
    else:
        wall = []
    return {
        "weeks": len(rows),
        "schema": kinds.count("schema"),
        "timeout": kinds.count("timeout"),
        "vagran": kinds.count("vägran"),
        "workMedian": statistics.median(work) if work else None,
        "workP90": percentile(work, 0.9),
        "secondsMedian": statistics.median(wall) if wall else None,
        "secondsP90": percentile(wall, 0.9),
        "lessons": sorted({int(r["facts"]["lessons"]) for r in rows}),  # type: ignore[index,call-overload]
    }


def _fmt(value: float | None, digits: int = 2) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def table(
    title: str,
    rows: list[dict[str, object]],
    key: Callable[[dict[str, object]], object],
    *,
    seconds: dict[str, float] | None = None,
    factor: float | None = None,
    label: str = "",
    lang: str = "sv",
    show: Callable[[object], str] = str,
) -> list[str]:
    """A markdown table of `summarise` per value of `key`, in the key's own order."""
    groups: dict[object, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        groups[key(row)].append(row)
    shown = bool(seconds) or factor is not None
    sign = "" if seconds else "≈ "
    w = TEXT[lang]
    head = [f"### {title}", "", f"| {label} | {w['weeks']} | {w['schema']} | {w['timeout']} | {w['refused']} | "
            f"{w['work_median']} | {w['work_p90']} |"
            + (f" {sign}{w['sec_median']} | {sign}{w['sec_p90']} |" if shown else ""),
            "|---|---:|---:|---:|---:|---:|---:|" + ("---:|---:|" if shown else "")]
    body = []
    for value in sorted(groups, key=lambda v: (isinstance(v, str), v)):  # type: ignore[type-var]
        cell = summarise(groups[value], seconds, factor)
        body.append(
            f"| {show(value)} | {cell['weeks']} | {cell['schema']} | {cell['timeout']} | {cell['vagran']} | "
            f"{_fmt(cell['workMedian'])} | {_fmt(cell['workP90'])} |"  # type: ignore[arg-type]
            + (f" {_fmt(cell['secondsMedian'], 1)} | {_fmt(cell['secondsP90'], 1)} |" if shown else ""),  # type: ignore[arg-type]
        )
    return [*head, *body, ""]


def load_rows(path: str) -> list[dict[str, object]]:
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not all("facts" in r for r in rows):
        msg = f"{path} is not a list of corpus weeks (corpus_measure.py --profile ... --json)"
        raise ValueError(msg)
    return rows


def report(
    rows: list[dict[str, object]], clock: list[dict[str, object]] | None = None, factor: float | None = None,
    lang: str = "sv",
) -> list[str]:
    """The tables the handbook and DEPLOYMENT.md quote, as markdown lines."""
    w = TEXT[lang]
    for row in [*rows, *(clock or [])]:
        outcome(row)  # an ERROR week stops the report here, by name, in either measurement
    seconds = (
        {str(r["name"]): float(r["firstScheduleSeconds"]) for r in clock if r["status"] == SOLVED}  # type: ignore[arg-type]
        if clock else None
    )
    facts = lambda r: r["facts"]  # noqa: E731
    out: list[str] = []
    n = lambda r: facts(r)["classes"]  # noqa: E731
    common = {"seconds": seconds, "factor": factor, "lang": lang}

    def where(pred) -> list[dict[str, object]]:
        return [r for r in rows if pred(r)]

    base = where(lambda r: facts(r)["termSubjects"] == 0 and facts(r)["blockedRequirements"] == 0
                 and facts(r)["sharedTeachersAsked"] == 0 and "-h" not in str(r["name"])
                 and "-l" not in str(r["name"]))
    out += table(w["t_n3"], [r for r in base if facts(r)["groupSubjects"] == 3], n, label=w["n"], **common)
    out += table(w["t_n0"], [r for r in base if facts(r)["groupSubjects"] == 0], n, label=w["n"], **common)
    for size in (9, 12):
        out += table(w["t_g"].format(size=size), [r for r in base if n(r) == size],
                     lambda r: facts(r)["groupSubjects"], label=w["g"], **common)
        out += table(w["t_m"].format(size=size),
                     where(lambda r, size=size: n(r) == size and facts(r)["groupSubjects"] == 3
                           and facts(r)["termSubjects"] == 0 and "-b" not in str(r["name"])),
                     lambda r: (facts(r)["sharedTeachers"], 2 if "-p2" in str(r["name"]) else 3),
                     label=w["m"], show=lambda v: w["m_each"].format(m=v[0], per=v[1]) if v[0] else str(v[0]),
                     **common)
    out += table(w["t_terms"],
                 where(lambda r: n(r) == 12 and facts(r)["groupSubjects"] == 3
                       and facts(r)["sharedTeachersAsked"] == 0 and "-b" not in str(r["name"])),
                 lambda r: facts(r)["termSubjects"], label=w["terms"], **common)
    out += table(w["t_prod"], where(lambda r: facts(r)["groupSubjects"] == 10 and "-h" in str(r["name"])),
                 lambda r: (n(r), _variant(str(r["name"]))), label=w["n_variant"],
                 show=lambda v: f"{v[0]} ({v[1]})", **common)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("count", help="a count-mode (or clock-mode) measurement of a profile, as JSON")
    parser.add_argument("--clock", help="the same weeks measured in clock mode, for the seconds columns")
    parser.add_argument("--lang", choices=sorted(TEXT), default="sv", help="the language of the tables")
    parser.add_argument("--seconds-per-work", type=float, default=None,
                        help="estimate seconds as work times this (one worker, the measured machine)")
    args = parser.parse_args()
    rows = load_rows(args.count)
    clock = load_rows(args.clock) if args.clock else None
    print("\n".join(report(rows, clock, args.seconds_per_work, args.lang)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
