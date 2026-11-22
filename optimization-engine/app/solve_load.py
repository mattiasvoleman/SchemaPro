"""How many solves this process is running, by kind: the one count that /optimize and /suggest-changes share.

WHY THERE IS A COUNT. The engine is shared by every school and a production deployment is one process on one
replica (`--workers 1`). A Generera (`/optimize`, and `/v1/schedule`, the gateway's older name for it) asks CP-SAT for
every core unless its request names `workers`. An analysis (`/suggest-changes`, Åtgärdsförslag vid vägran) is a solve
of its own, up to a minute of search and half a minute of checking, with four workers. The analysis route had a gate
of one for analyses and knew nothing of a Generera, so an analysis for one school could start beside, and slow down,
a Generera for another school: the Generera is what a school came for and the analysis is the courtesy that follows a
refusal (review of #384).

WHAT IT DECIDES. A Generera is never refused or queued by this count: it has no admission at all and gets none here.
An analysis is refused (429, the gateway's ENGINE_BUSY) while any Generera runs, and answers "try again in a moment".
The converse is not closed and is said here and not left to be found: a Generera that starts while an analysis is
already running shares the cores with it until it ends, at most its workers' four and a minute and a half (up to the
ceiling of 270 s at the largest `maxSeconds`). The count only makes that visible (a warning, `generation_beside_analysis`)
so that it can be measured before anything is built to stop an analysis.

IT COUNTS THE THREAD'S LIFE, NOT THE ANSWER'S. A solve's thread cannot be cancelled, so the 503 at a route's ceiling ends
the wait and not the work (the same lesson as the analysis gate's). `running` is entered INSIDE the thread, around the
solve, and left in a `finally`: a thread that outlived its 503 still counts, and a coroutine that was closed before its
thread was started (a client that went away) counts nothing and cannot leave a count behind. The price is a window of
microseconds between a thread being handed to the executor and its starting, in which an analysis may be admitted beside
a Generera that has just arrived: the harmless direction, since a Generera is never refused.

ONE PER PROCESS, NOT PER APP. The gates live on `app.state` so that a test's app is its own. This count is read by
`run_solver`, which has no request to read it from, and what it counts is the process's cores, so it is a module-level
instance. Nothing in it is written outside `running`, and every `running` ends, so a test that uses it leaves it at zero.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager

#: A Generera: `run_solver`, which both /api/v1/optimize and the legacy /v1/schedule go through.
GENERATION = "generation"
#: An analysis of what to change after a refusal: /api/v1/suggest-changes.
ANALYSIS = "analysis"

_KINDS = (GENERATION, ANALYSIS)


class SolveLoad:
    """The solves running in this process, by kind. Thread-safe: it is entered and left on solve threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running = {kind: 0 for kind in _KINDS}

    @contextmanager
    def running(self, kind: str) -> Iterator[None]:
        """Count one solve of `kind` for as long as the block runs, whatever ends it."""
        if kind not in self._running:
            raise ValueError(f"unknown kind of solve: {kind!r}")
        with self._lock:
            self._running[kind] += 1
        try:
            yield
        finally:
            with self._lock:
                self._running[kind] -= 1

    def count(self, kind: str) -> int:
        """How many solves of `kind` run now."""
        with self._lock:
            return self._running[kind]


#: The process's own count (see the head of this module).
SOLVE_LOAD = SolveLoad()
