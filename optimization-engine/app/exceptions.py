from __future__ import annotations

from typing import Any


class OptimizationEngineError(Exception):
    """Base error for optimization engine failures."""


class SolverBuildError(OptimizationEngineError):
    """Raised when the CP-SAT model cannot be constructed from input."""


class InvalidScheduleInputError(OptimizationEngineError):
    """Raised when request payload fails business validation."""


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
