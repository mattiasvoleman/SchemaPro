from __future__ import annotations

import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from threading import Lock
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.optimize import router as optimize_router
from app.api.v1.optimize import run_solver
from app.config import Settings, get_settings
from app.dependencies import get_app_settings, verify_api_key
from app.exceptions import (
    InvalidScheduleInputError,
    OptimizationEngineError,
    SolverBuildError,
    SolverTimeoutError,
    error_payload,
)
from app.logging_config import clear_request_context, configure_logging, get_logger
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse

logger = get_logger(__name__)

# Reject request bodies larger than this before parsing. The gateway's largest
# legitimate payload (max lists in OptimizeScheduleRequest) is well under 8 MB.
MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024


class SlidingWindowRateLimiter:
    """Dependency-free per-client fixed-window rate limiter.

    Correct for a single-instance deployment (which mirrors the gateway's own
    in-memory throttler). For horizontal scaling, back this with Redis.
    """

    def __init__(self, limit_per_minute: int) -> None:
        self._limit = limit_per_minute
        self._window_seconds = 60.0
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def allow(self, client_key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window_seconds
        with self._lock:
            bucket = self._hits.setdefault(client_key, deque())
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self._limit:
                return False
            bucket.append(now)
            return True


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    settings: Settings = application.state.settings
    configure_logging(settings.log_level)
    # The grid is here because it decides which lesson lengths a school can
    # have, and it is read from the environment — so the value in the code is
    # not evidence of the value in production. A deployment with SLOT_MINUTES
    # left at an old number rejects every 40- and 50-minute lesson, and the only
    # place that said so was the rejection itself, one generation attempt later.
    # Now the first line of the log answers it.
    logger.info(
        "service_starting",
        app_env=settings.app_env,
        allowed_origins=settings.allowed_origins,
        solver_timeout_seconds=settings.solver_max_time_seconds,
        slot_minutes=settings.slot_minutes,
        schedule_day=(
            f"{settings.schedule_day_start_minutes // 60:02d}:00-"
            f"{settings.schedule_day_end_minutes // 60:02d}:00"
        ),
    )
    yield
    logger.info("service_stopped")


def create_legacy_schedule_router() -> APIRouter:
    """NestJS gateway compatibility route (`POST /v1/schedule`)."""
    legacy = APIRouter(prefix="/v1", tags=["legacy"])

    @legacy.post(
        "/schedule",
        response_model=OptimizeScheduleResponse,
        status_code=status.HTTP_200_OK,
        include_in_schema=False,
        dependencies=[Depends(verify_api_key)],
    )
    async def schedule_legacy(
        payload: OptimizeScheduleRequest,
        settings: Settings = Depends(get_app_settings),
    ) -> OptimizeScheduleResponse:
        return await run_solver(payload, settings)

    return legacy


def register_exception_handlers(application: FastAPI) -> None:
    @application.middleware("http")
    async def bind_request_logging_context(request: Request, call_next: Callable[..., Any]) -> Any:
        clear_request_context()
        try:
            return await call_next(request)
        finally:
            clear_request_context()

    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        logger.warning("validation_error", path=request.url.path, error_count=len(exc.errors()))
        sanitised_errors = [
            {
                "type": error.get("type"),
                "loc": list(error.get("loc", [])),
                "msg": error.get("msg"),
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=error_payload(
                code="VALIDATION_ERROR",
                message="Request payload failed schema validation.",
                details={"errors": sanitised_errors},
            ),
        )

    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(
        request: Request,
        exc: StarletteHTTPException,
    ) -> JSONResponse:
        logger.warning(
            "http_error",
            path=request.url.path,
            status_code=exc.status_code,
        )
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(
            status_code=exc.status_code,
            content=error_payload(code="HTTP_ERROR", message=detail),
        )

    @application.exception_handler(InvalidScheduleInputError)
    async def invalid_input_handler(
        request: Request,
        exc: InvalidScheduleInputError,
    ) -> JSONResponse:
        logger.warning("invalid_schedule_input", path=request.url.path, error=str(exc))
        # `details` carries the refusal's own name and values beside the
        # English, so the gateway can hand them to a screen that says it in
        # the reader's language. The top-level code stays what it was: it
        # names the KIND of failure for an HTTP client, not the sentence.
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=error_payload(
                code="INVALID_SCHEDULE_INPUT",
                message=str(exc),
                details={"code": exc.code, "params": exc.params} if exc.code else None,
            ),
        )

    @application.exception_handler(SolverBuildError)
    async def solver_build_handler(
        request: Request,
        exc: SolverBuildError,
    ) -> JSONResponse:
        logger.error("solver_build_error", path=request.url.path, error=str(exc))
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=error_payload(code="SOLVER_BUILD_ERROR", message=str(exc)),
        )

    @application.exception_handler(SolverTimeoutError)
    async def solver_timeout_handler(
        request: Request,
        exc: SolverTimeoutError,
    ) -> JSONResponse:
        # 503, not 500: the request was valid and retrying with a larger budget
        # may succeed. Mirrors the asyncio wait_for ceiling in run_solver.
        logger.error("solver_timed_out", path=request.url.path, error=str(exc))
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=error_payload(code="SOLVER_TIMEOUT", message=str(exc)),
        )

    @application.exception_handler(OptimizationEngineError)
    async def optimization_engine_handler(
        request: Request,
        exc: OptimizationEngineError,
    ) -> JSONResponse:
        logger.error("optimization_engine_error", path=request.url.path, error=str(exc))
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=error_payload(code="OPTIMIZATION_ENGINE_ERROR", message=str(exc)),
        )

    @application.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled_exception", path=request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=error_payload(
                code="INTERNAL_SERVER_ERROR",
                message="An unexpected error occurred.",
            ),
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    application = FastAPI(
        title="SchemaPro Optimization Engine",
        description=(
            "Isolated CP-SAT scheduling microservice. Accepts anonymized UUID payloads "
            "from the NestJS gateway only."
        ),
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs" if resolved_settings.is_development else None,
        redoc_url="/redoc" if resolved_settings.is_development else None,
    )

    # The single source of truth for this app instance. Handlers read it via the
    # get_app_settings dependency so an explicitly passed Settings is actually
    # the one the solver path uses, rather than the cached env-backed default.
    application.state.settings = resolved_settings

    application.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.allowed_origins,
        # This is a service-to-service API authenticated by X-API-Key, not by
        # browser cookies — credentialed CORS provides no benefit and only widens
        # the attack surface if ALLOWED_ORIGINS is ever misconfigured.
        allow_credentials=False,
        allow_methods=["POST", "GET"],
        allow_headers=["Content-Type", "X-API-Key"],
    )

    rate_limiter = SlidingWindowRateLimiter(resolved_settings.rate_limit_per_minute)

    @application.middleware("http")
    async def enforce_rate_limit(request: Request, call_next: Callable[..., Any]) -> Any:
        # Health checks are unauthenticated and cheap — never rate-limit them.
        if request.url.path == "/health":
            return await call_next(request)
        client_key = request.client.host if request.client else "unknown"
        if not rate_limiter.allow(client_key):
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content=error_payload(
                    code="RATE_LIMITED",
                    message="Too many requests. Slow down and retry shortly.",
                ),
            )
        return await call_next(request)

    @application.middleware("http")
    async def enforce_max_body_size(request: Request, call_next: Callable[..., Any]) -> Any:
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = None
            if declared is not None and declared > MAX_REQUEST_BODY_BYTES:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content=error_payload(
                        code="PAYLOAD_TOO_LARGE",
                        message="Request body exceeds the maximum allowed size.",
                    ),
                )
        return await call_next(request)

    register_exception_handlers(application)
    application.include_router(optimize_router)
    application.include_router(create_legacy_schedule_router())

    @application.get("/health", tags=["health"])
    async def healthcheck() -> dict[str, str]:
        return {"status": "ok"}

    return application


def _default_app() -> FastAPI:
    try:
        return create_app()
    except Exception:
        # Allow test collection to inject env before the module-level app is used.
        return create_app(
            Settings(
                API_KEY="development-placeholder-0000000000000000",
                ALLOWED_ORIGINS="http://localhost:3000",
            ),
        )


app = _default_app()
