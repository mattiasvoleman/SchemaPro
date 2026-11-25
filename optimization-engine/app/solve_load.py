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
ceiling of 270 s at the largest `maxSeconds`). The count only makes that visible (a warning, `generation_beside_analysis`,
that names the analysis it started beside and how long that had run, so that the overlap can be read from the log) so that it can
be measured before anything is built to stop an analysis.

IT COUNTS THE THREAD'S LIFE, NOT THE ANSWER'S. A solve's thread cannot be cancelled, so the 503 at a route's ceiling ends
the wait and not the work (the same lesson as the analysis gate's). `running` is entered INSIDE the thread, around the
solve, and left in a `finally`: a thread that outlived its 503 still counts, and a coroutine that was closed before its
thread was started (a client that went away) counts nothing and cannot leave a count behind. The price is a window between a
thread being handed to the executor and its starting, in which an analysis may be admitted beside a Generera that has
just arrived: the harmless direction, since a Generera is never refused. The window is microseconds only while the
executor has an idle worker; when it is full the thread waits for one, and the window lasts as long as that wait, silently
as far as the count goes. What is said is that the overlap is logged from both sides, not that the window cannot be long:
the Generera's line (`generation_beside_analysis`) names the analysis it started beside and how long that had run, and the
analysis's own line (`analysis_beside_generation`) names the Generera it was admitted beside and how long that had run.

ONE PER PROCESS, NOT PER APP. The gates live on `app.state` so that a test's app is its own. This count is read by
`run_solver`, which has no request to read it from, and what it counts is the process's cores, so it is a module-level
instance. Nothing in it is written outside `running`, and every `running` ends, so a test that uses it leaves it at zero.
"""

from __future__ import annotations

import itertools
import threading
import time
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
        #: The solves running now, by a token of their own: (kind, when it began, the label it was counted with).
        self._live: dict[int, tuple[str, float, str | None]] = {}
        self._tokens = itertools.count()

    @contextmanager
    def running(self, kind: str, label: str | None = None) -> Iterator[None]:
        """Count one solve of `kind` for as long as the block runs, whatever ends it.

        `label` is what a log line says of it (the request's id), so that two solves that shared the cores can be paired.
        """
        if kind not in self._running:
            raise ValueError(f"unknown kind of solve: {kind!r}")
        with self._lock:
            token = next(self._tokens)
            self._running[kind] += 1
            self._live[token] = (kind, time.monotonic(), label)
        try:
            yield
        finally:
            with self._lock:
                self._running[kind] -= 1
                del self._live[token]

    def count(self, kind: str) -> int:
        """How many solves of `kind` run now."""
        with self._lock:
            return self._running[kind]

    def oldest(self, kind: str) -> tuple[int, str | None, float]:
        """How many solves of `kind` run, the label of the one that has run longest and its seconds, read together.

        `(0, None, 0.0)` when none runs. One read, so that the number and the solve it names are of the same moment.
        """
        with self._lock:
            started = [(at, label) for live_kind, at, label in self._live.values() if live_kind == kind]
        if not started:
            return 0, None, 0.0
        at, label = min(started, key=lambda entry: entry[0])
        return len(started), label, time.monotonic() - at


#: The process's own count (see the head of this module).
SOLVE_LOAD = SolveLoad()
