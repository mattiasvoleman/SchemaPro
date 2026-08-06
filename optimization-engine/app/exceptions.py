from __future__ import annotations

from typing import Any


class OptimizationEngineError(Exception):
    """Base error for optimization engine failures."""


class SolverBuildError(OptimizationEngineError):
    """Raised when the CP-SAT model cannot be constructed from input."""


class InvalidScheduleInputError(OptimizationEngineError):
    """Raised when request payload fails business validation."""


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
