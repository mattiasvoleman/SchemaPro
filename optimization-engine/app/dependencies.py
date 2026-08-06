from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from app.config import Settings


def get_app_settings(request: Request) -> Settings:
    """Return the Settings instance the running app was built with.

    Request handlers must resolve configuration through this dependency rather
    than calling `get_settings()`. `create_app()` accepts an explicit Settings,
    and the lru_cached env-backed factory would silently shadow it — leaving the
    caller's solver budgets, grid geometry and objective weights unused.
    """
    return request.app.state.settings


async def verify_api_key(
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
    settings: Settings = Depends(get_app_settings),
) -> None:
    """Validate the shared service API key issued by the NestJS gateway.

    Uses a constant-time comparison so the endpoint does not leak key material
    through response-timing analysis.
    """
    if not x_api_key or not secrets.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing service API key.",
        )
