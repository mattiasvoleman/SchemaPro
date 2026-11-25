"""Where one solve's time went, step by step (omgång 13, M2 Förklaringen när tiden tar slut).

WHY A SOLVE KEEPS ITS OWN ACCOUNT. A Generera that runs out of time used to
answer a status and a hint, and the only record of where the minutes had gone
was a line in the engine's log that a school never reads. M1's clock
(app/timing.py) says how long a request MAY take; this says how long each step
of one DID: the checks before a model, the builds, the walk's search, the two
satisfaction searches, the timeout probe. A solve that is answered 503 at its
ceiling has no response to carry such an account, so the route reads the clock
of the solve that is still running (`where`) and puts the step it was in into
the 503's details.

MEASURED, NEVER A RULE. Nothing here changes a limit, a cap or the order of
anything; a solve with its clock removed gives the same answer. Like
app/timing.py it never reads the clock itself: every method takes `now`, so the
tests that replace `scheduler_solver.time` go on steering all of it.

THE STEPS ARE CONTIGUOUS. `enter` closes the step in progress at `now` and opens
the next one at the same instant, so no time falls between two of them and the
steps cover the solve from its entry (not the route's) to the answer. Each
figure is rounded to a tenth on its own (`_seconds`), so the rounded seconds
add up to the rounded total only to within 0.05 s a step. A step the solve skipped has no entry,
and a step entered twice is summed (a best-effort solve's phase 1a runs once,
but the rule is the same for every step).
"""

from __future__ import annotations

from app.schemas.schedule import (
    TimeoutPhaseName,
    TimeoutReport,
    TimeoutSearch,
    TimeoutSearchPhase,
    TimeoutStage,
    TimeoutStageName,
)


def _seconds(value: float) -> float:
    """A tenth of a second: what a school can read, and enough to tell a minute from a second."""
    return round(max(0.0, value), 1)


class StageClock:
    """One solve's steps and the searches' effort, from the moment it was entered."""

    def __init__(self, entered: float) -> None:
        self.entered = entered
        self._done: list[tuple[TimeoutStageName, float]] = []
        # THE STEP IN PROGRESS, as one tuple: the route reads it from its own
        # thread while the solve's thread replaces it, and a pair of
        # attributes could be read half changed. A solve begins in its checks.
        self._open: tuple[TimeoutStageName, float] | None = ("PRECHECKS", entered)
        self._phases: list[TimeoutSearchPhase] = []

    # -- the solve's side -----------------------------------------------------

    def enter(self, stage: TimeoutStageName, now: float) -> None:
        """Close the step in progress at `now` and open `stage` at the same instant."""
        self._close(now)
        self._open = (stage, now)

    def note_search(
        self,
        phase: TimeoutPhaseName,
        now: float,
        *,
        conflicts: int | None,
        branches: int | None,
    ) -> None:
        """A satisfaction search that has just returned without a timetable.

        Its seconds are the step it is in, up to `now`: the search's own time,
        and before the probe's, which is a step of its own.
        """
        opened = self._open
        since = self.entered if opened is None else opened[1]
        self._phases.append(
            TimeoutSearchPhase(
                phase=phase,
                seconds=_seconds(now - since),
                conflicts=conflicts,
                branches=branches,
            ),
        )

    def finish(self, now: float) -> None:
        """Close the step in progress: the solve is over."""
        self._close(now)

    def report(
        self,
        now: float,
        *,
        budget_seconds: int,
        configured_budget_seconds: int,
        caller_wait_seconds: float | None,
        week_load_cut: bool,
    ) -> TimeoutReport:
        """The account of a solve that has just answered TIMEOUT, as the wire has it."""
        self._close(now)
        return TimeoutReport(
            total_seconds=_seconds(now - self.entered),
            budget_seconds=budget_seconds,
            configured_budget_seconds=configured_budget_seconds,
            caller_wait_seconds=caller_wait_seconds,
            stages=[
                TimeoutStage(stage=stage, seconds=_seconds(seconds))
                for stage, seconds in self._done
            ],
            search=TimeoutSearch(solutions=0, phases=list(self._phases)),
            week_load_cut=week_load_cut,
        )

    # -- the route's side -----------------------------------------------------

    def where(self, now: float) -> tuple[TimeoutStageName, float, float] | None:
        """The step the solve is in at `now`, the seconds it has been in it, and the seconds since entry.

        None once the solve has closed its last step: an answer was on its way
        out when the route gave up waiting, and there is no step to name.
        """
        opened = self._open
        if opened is None:
            return None
        stage, since = opened
        return stage, _seconds(now - since), _seconds(now - self.entered)

    # -- internal -------------------------------------------------------------

    def _close(self, now: float) -> None:
        opened = self._open
        if opened is None:
            return
        stage, since = opened
        seconds = max(0.0, now - since)
        if self._done and self._done[-1][0] == stage:
            self._done[-1] = (stage, self._done[-1][1] + seconds)
        else:
            self._done.append((stage, seconds))
        self._open = None
