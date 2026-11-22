from __future__ import annotations

from typing import Any

from app.messages import render


class OptimizationEngineError(Exception):
    """Base error for optimization engine failures."""


class SolverBuildError(OptimizationEngineError):
    """Raised when the CP-SAT model cannot be constructed from input."""


class InvalidScheduleInputError(OptimizationEngineError):
    """Raised when request payload fails business validation.

    Carries the same two fields a conflict does — the sentence's `code` and
    the `params` it substitutes — because a refused payload is a refusal a
    school has to act on ("locked lessons leave 4A no lunch break on Tuesday")
    and it reads it in the same screen, in the same language, as the conflicts.
    The message is rendered from the code by app/messages.py; passing one
    without the other is what lets the two drift apart.

    The code is optional for the handful of raises that are our own bug rather
    than the school's data. Those reach a developer through a log, and there is
    nothing for a school to do about them.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "",
        params: dict[str, str | int] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.params = params or {}

    @classmethod
    def of(
        cls,
        code: str,
        params: dict[str, str | int] | None = None,
    ) -> InvalidScheduleInputError:
        """The refusal named by `code`, with its English rendered from it."""
        values = params or {}
        return cls(render(code, values), code=code, params=values)


class SolverTimeoutError(OptimizationEngineError):
    """A route stopped waiting for its solve: its ceiling (app.timing) passed.

    Distinct from INFEASIBLE and from a TIMEOUT answer: the model may well be
    satisfiable, and a TIMEOUT is an ANSWER (the search ran out of its budget and
    the probe said what it could). This is the other thing, a solve that did not
    answer at all inside the longest the route waits, so there is nothing to
    return, not even an explanation. Reporting it as INFEASIBLE would tell the
    gateway that no schedule exists, which it surfaces to the school as a hard
    failure.

    Raised by all four routes (optimize, optimize-rooms, staff, plan-exams) and
    answered by main.py as 503 with the code SOLVER_TIMEOUT and `details`
    carrying the route and the ceiling that passed. `message` is the sentence
    each route has always answered with, word for word: a gateway older than the
    code reads that sentence and nothing else (tests/data/solver_timeout_body.json
    is the one example both sides read).
    """

    def __init__(
        self,
        message: str,
        *,
        route: str,
        ceiling_seconds: float,
        stage: str | None = None,
        stage_seconds: float | None = None,
        elapsed_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.route = route
        self.ceiling_seconds = ceiling_seconds
        # WHERE THE SOLVE WAS when the ceiling fell (app/solver/stage_clock.py),
        # for the one route that keeps such an account: the step it was in, the
        # seconds in it and the seconds since entry. None for the others, and
        # for a solve that had closed its last step as the route gave up.
        self.stage = stage
        self.stage_seconds = stage_seconds
        self.elapsed_seconds = elapsed_seconds


def error_payload(
    *,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if details:
        payload["details"] = details
    return payload
