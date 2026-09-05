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
    """Raised when CP-SAT exhausts its budget without proving anything.

    Distinct from INFEASIBLE: the model may well be satisfiable, the solver just
    ran out of time. Reporting it as INFEASIBLE would tell the gateway that no
    schedule exists, which it surfaces to the school as a hard failure.
    """


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
