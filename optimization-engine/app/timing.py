"""The engine's times, in one place: what each route may take, and one request's clock.

WHY THERE IS A MODULE FOR THIS. Until the 2026-11-17 incident the chain of times
a generation passes through was set by hand in two Railway services and held
together by a paragraph of docs/DEPLOYMENT.md: the engine's budget
(SOLVER_MAX_TIME_SECONDS), its probe (SOLVER_PROBE_SECONDS), its hard ceiling,
and the API's wait (AI_ENGINE_TIMEOUT_MS). Three Generera runs ended in "The AI
engine returned an error." because the ceiling fell in the middle of the probe.
#344 made the ceiling a sum of the others; this makes the other half true too:

  - the engine SAYS its times (GET /api/v1/timing, built from each route's
    `RouteLimits`), so the API reads them instead of guessing;
  - a request CARRIES its deadline (`deadlineSeconds`, how long the caller
    waits), and the ceiling and every step's cap are counted from it
    (`ceiling_seconds`, `Deadline`), so a caller that waits less than the
    engine's own settings need gets an answer inside its wait, with a shorter
    but true budget, and not a 503 it never reads.

NOTHING HERE READS THE CLOCK. Every method takes `now` as an argument. The
solver's tests replace `scheduler_solver.time`, and a module that called
time.monotonic() itself would go on running on the real one.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings

#: What the engine keeps for the work that comes BEFORE the search's clock
#: starts (the prechecks, the lunch stage, the week-load count, the two model
#: builds) and for a search that stops after its budget: 8 s and 10 s on the
#: 809-lesson week of 2026-11-17, 3.3 s per build on a 2,000-pupil week with the
#: walk. Four routes had their own copy of this number.
BUILD_HEADROOM_SECONDS = 30.0

#: Between the moment a caller sends a request and the moment the engine's route
#: takes it: the network and the parsing of a body of up to 8 MB. A caller that
#: waits D seconds is answered by D minus this.
TRANSFER_MARGIN_SECONDS = 5.0

#: What the last step leaves for building and writing the answer. A step that
#: ends at the ceiling itself races the 503 that ends the wait.
ANSWER_SLACK_SECONDS = 3.0

#: How far past its own time limit a CP-SAT solve may stop. Not a guess: on
#: 2026-11-17 the search of the 809-lesson week stopped about ten seconds after
#: its 180. Every step the clock cuts (a search squeezed by a short deadline or
#: a slow setup, the explanation, a probe's last slice) is cut at `answer_by`
#: and may then run this far past it, so the edge lies this much before the
#: slack and not at it: with only the slack, the three seconds of it were all
#: such a step had, and the incident's own overrun passed the ceiling by two.
SOLVE_OVERRUN_SECONDS = 10.0

#: How much of the timeout probe the search always leaves behind when the clock
#: is tight (a slow build, a short deadline). The search is what the school asked
#: for and the probe is what it is told when the search finds nothing, so the
#: search gives way only as far as a short explanation needs.
PROBE_FLOOR_SECONDS = 5.0


@dataclass(frozen=True)
class RouteLimits:
    """What one route may take: the search, what it spends after it, and the build."""

    budget_seconds: float
    probe_seconds: float
    headroom_seconds: float = BUILD_HEADROOM_SECONDS

    @property
    def ceiling_seconds(self) -> float:
        return self.budget_seconds + self.probe_seconds + self.headroom_seconds


def generation_limits(
    settings: Settings,
    *,
    runs_probes: bool = True,
    headroom_seconds: float = BUILD_HEADROOM_SECONDS,
) -> RouteLimits:
    """The generator's own limits: its budget, the probe a request that runs probes pays, the headroom.

    `settings` is the request's own (settings_for_search), so for a schemaförslag
    candidate its budget and probe are the candidate's. A request that turned its
    probes off (SearchOptions.probes) pays nothing after the budget. The
    generator is the only route with a probe: the others have no step after
    their budget, and build their RouteLimits in their own modules.
    """
    return RouteLimits(
        settings.solver_max_time_seconds,
        settings.solver_probe_seconds if runs_probes else 0.0,
        headroom_seconds,
    )


def ceiling_seconds(limits: RouteLimits, deadline_seconds: float | None = None) -> float:
    """The wall-clock after which a solve is answered 503 instead of waited for.

    The search, the probe and the build's headroom: what the deployment's own
    settings need (`limits`).

    A REQUEST'S DEADLINE CAN ONLY SHORTEN IT. A caller that waits for
    `deadline_seconds` is answered by that minus the transfer margin at the
    latest, so a longer ceiling would only be a 503 nobody reads. The settings
    are not changed: the steps inside the solve count their time from this
    ceiling (Deadline), and the part they cannot hold is the optional part.
    """
    own = limits.ceiling_seconds
    if deadline_seconds is None:
        return own
    return min(own, max(0.0, deadline_seconds - TRANSFER_MARGIN_SECONDS))


@dataclass(frozen=True)
class Deadline:
    """One request's clock: when it came in, and how long the route will wait.

    `answer_by` is the one edge every step of a solve counts to. It lies before
    the ceiling by the answer's own slack and by how far a solve may stop past its
    limit (SOLVE_OVERRUN_SECONDS), so that the last step's answer is built before
    the route stops waiting even when that step overran.
    """

    entered: float
    ceiling: float

    @property
    def answer_by(self) -> float:
        return self.entered + self.ceiling - min(
            ANSWER_SLACK_SECONDS + SOLVE_OVERRUN_SECONDS, self.ceiling / 2,
        )

    def left(self, now: float) -> float:
        """Seconds until `answer_by`, negative once it has passed."""
        return self.answer_by - now

    def cap(self, now: float, seconds: float) -> float:
        """`seconds`, or what is left of the clock if that is less."""
        return min(seconds, self.left(now))

    def clamp(self, instant: float) -> float:
        """An instant of the solver's own, never later than `answer_by`."""
        return min(instant, self.answer_by)

    def search_budget(
        self, started: float, budget: float, probe_seconds: float, build_seconds: float = 0.0,
    ) -> float:
        """The seconds the search may have from `started`.

        `budget` itself, EXACTLY, while the clock holds it: a deployment whose
        builds are fast is solved for the number of seconds it set, not for that
        number less the rounding of two clock readings. When the clock does not
        (slow builds, or a caller that waits less than the settings need) the
        search ends where `answer_by` leaves the probe's floor AND the overrun
        a CP-SAT solve may stop past its limit, and the TIMEOUT that follows
        says so, with the seconds it had.

        THE OVERRUN IS IN THE SUM, because a search cut by the clock ends at
        its limit plus whatever CP-SAT runs over (SOLVE_OVERRUN_SECONDS: ten
        seconds on the 809-lesson week). Without it the limit lay at
        `answer_by` less the floor, and a search that stopped five seconds
        late ate the floor and the probe got nothing: a TIMEOUT that said the
        search found no timetable and could not say which rule stood in the
        way (g416-M-1, the review of #416). With it the probe has its floor
        however late the search stops, up to the overrun.

        The price is the same overrun off a search the clock cuts, and off the
        budget's own hold: a week whose setup took more than `answer_by` less
        the floor, the overrun and the budget is cut instead of held. At
        production's 540 s that is a setup of 22 s where it was 32 s.

        ONLY WHERE A PROBE FOLLOWS. A search with no probe after it (a request
        that turned its probes off, or a deployment with SOLVER_PROBE_SECONDS
        at zero) has no floor to keep, and `answer_by` already lies the overrun
        before the ceiling: a search ended at it and ran ten seconds over still
        answers three seconds before the route stops waiting. Holding the
        overrun back there is ten seconds of search paid for nothing, and it is
        paid by the schemaförslag candidates after the first (30 s each, no
        probes), where the lead keeps its 30 s up to a setup of 22 s and the
        others lose a second for every second of setup over 7, so the
        emphases are no longer compared at one budget.

        NEVER MORE THAN HALF OF WHAT IS LEFT. A caller that waits so little
        that ten seconds is most of what the clock has (`answer_by` itself
        gives up half of a ceiling shorter than its margins, for the same
        reason) would otherwise be given no search at all, where the clock
        leaves it some; its overrun is then not held for, and the floor is not
        promised.

        THE FLOOR IS A RULE'S SLICE AND THE BUILD THAT COMES BEFORE IT (g454, M-2). A
        rule is probed on a model of its own, built before its slice starts, and the
        probe does not begin a rule that cannot have its build and half a second
        (`_probe_timeout`). A floor of PROBE_FLOOR_SECONDS alone was a clock's floor
        and not a probe's: a week whose setup took 9 s or more left the probe the
        five seconds and no rule, a bare TIMEOUT all the same. `build_seconds` is the
        solve's own estimate of one build (half its setup, the dearest a build can
        have been), so that the floor leaves a rule a slice of the five.
        The price is paid in the budget's hold: a setup of 14.7 s keeps production's
        540 s where 22 s did (s + 5 + s/2 + 10 <= 37).
        """
        floor = min(max(0.0, probe_seconds), PROBE_FLOOR_SECONDS + max(0.0, build_seconds))
        left = self.answer_by - floor - started
        held = min(SOLVE_OVERRUN_SECONDS, max(0.0, left) / 2) if floor > 0 else 0.0
        room = left - held
        return budget if room >= budget else max(0.0, room)

    def probe_end(self, now: float, probe_seconds: float) -> float:
        """The instant the timeout probe stops: its seconds from `now`, but never past `answer_by`.

        Counted from where the search ENDED, not from where its budget did: a
        search that stops ten seconds late (as CP-SAT does on a large week) used
        to eat ten of the probe's twenty.
        """
        return min(now + probe_seconds, self.answer_by)
