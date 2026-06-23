from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.optimize import router as optimize_router
from app.config import Settings, get_settings
from app.dependencies import verify_api_key
from app.exceptions import (
    InvalidScheduleInputError,
    OptimizationEngineError,
    SolverBuildError,
    error_payload,
)
from app.logging_config import clear_request_context, configure_logging, get_logger
from app.schemas.schedule import OptimizeScheduleRequest, OptimizeScheduleResponse
from app.solver.scheduler_solver import SchedulerSolver

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    logger.info(
        "service_starting",
        app_env=settings.app_env,
        allowed_origins=settings.allowed_origins,
        solver_timeout_seconds=settings.solver_max_time_seconds,
    )
    yield
    logger.info("service_stopped")


def create_legacy_schedule_router(settings: Settings) -> APIRouter:
    """NestJS gateway compatibility route (`POST /v1/schedule`)."""
    legacy = APIRouter(prefix="/v1", tags=["legacy"])

    @legacy.post(
        "/schedule",
        response_model=OptimizeScheduleResponse,
        status_code=status.HTTP_200_OK,
        include_in_schema=False,
        dependencies=[Depends(verify_api_key)],
    )
    async def schedule_legacy(payload: OptimizeScheduleRequest) -> OptimizeScheduleResponse:
        solver = SchedulerSolver(settings)
        return solver.solve(payload)

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
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=error_payload(code="INVALID_SCHEDULE_INPUT", message=str(exc)),
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

    application.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["POST", "GET"],
        allow_headers=["Content-Type", "X-API-Key"],
    )

    register_exception_handlers(application)
    application.include_router(optimize_router)
    application.include_router(create_legacy_schedule_router(resolved_settings))

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
                API_KEY="development-placeholder",
                ALLOWED_ORIGINS="http://localhost:3000",
            ),
        )


app = _default_app()
