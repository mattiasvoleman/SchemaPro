from __future__ import annotations

from functools import lru_cache

from pydantic import Field, computed_field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # NOTE: there are deliberately no `host` / `port` settings here. Nothing in
    # this package calls uvicorn.run() — the server is started by the
    # Dockerfile CMD, which reads ${PORT} from the environment directly and
    # always binds 0.0.0.0 inside the container. Declaring them as settings
    # made `PORT` look configurable through this class while having no effect
    # whatsoever. `extra="ignore"` above means a PORT variable in the
    # environment is still accepted and simply passed through to the CMD.

    api_key: str = Field(alias="API_KEY")

    rate_limit_per_minute: int = Field(default=120, alias="RATE_LIMIT_PER_MINUTE", ge=1)

    allowed_origins_env: str = Field(
        default="http://nestjs-backend:3000",
        alias="ALLOWED_ORIGINS",
    )
    schedule_days_env: str = Field(default="1,2,3,4,5", alias="SCHEDULE_DAYS")

    solver_timeout_seconds: float = Field(default=60.0, alias="SOLVER_TIMEOUT_SECONDS")
    solver_max_time_seconds: float = Field(default=60.0, alias="SOLVER_MAX_TIME_SECONDS")

    schedule_day_start_minutes: int = Field(default=480, alias="SCHEDULE_DAY_START_MINUTES")
    schedule_day_end_minutes: int = Field(default=1080, alias="SCHEDULE_DAY_END_MINUTES")
    # Five, not fifteen. A 15-minute grid cannot express a 40- or 50-minute
    # lesson, and both are ordinary in a Swedish school — a timplan carrying one
    # reached the solver and raised on it. Five divides 60, so it satisfies the
    # validator below, and it admits every length a school actually uses.
    #
    # Measured before changing it, at 400 students on the §2 budget of 90s: both
    # grids placed 576 lessons and produced a valid timetable, though neither
    # reached OPTIMAL. Tripling the horizon (200 -> 600 slots a week) cost
    # nothing observable at that size. Variable COUNT is unchanged either way —
    # one interval per lesson — it is the domain of each that widens.
    slot_minutes: int = Field(default=5, alias="SLOT_MINUTES")

    weight_preferred_free_violation: int = Field(
        default=10,
        alias="WEIGHT_PREFERRED_FREE_VIOLATION",
    )
    weight_preferred_busy_violation: int = Field(
        default=5,
        alias="WEIGHT_PREFERRED_BUSY_VIOLATION",
    )
    weight_disruption: int = Field(
        default=8,
        alias="WEIGHT_DISRUPTION",
        description="Reward for keeping a lesson on its previous slot during re-optimization.",
    )
    weight_spread: int = Field(
        default=3,
        alias="WEIGHT_SPREAD",
        description="Penalty per pair of same-requirement lessons on the same day.",
    )
    weight_teacher_gap: int = Field(
        default=2,
        alias="WEIGHT_TEACHER_GAP",
        description="Penalty per idle slot between two same-day lessons of a teacher.",
    )
    weight_room_preference: int = Field(
        default=5,
        alias="WEIGHT_ROOM_PREFERENCE",
        description=(
            "Default penalty per lesson placed outside its subject's preferred "
            "rooms, when a preference carries no weight of its own."
        ),
    )
    weight_date_unavailable: int = Field(
        default=2,
        alias="WEIGHT_DATE_UNAVAILABLE",
        description="Soft penalty for placing weekly lessons where one-off dated absences fall.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins_env.split(",") if origin.strip()]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def schedule_days(self) -> list[int]:
        return [int(day.strip()) for day in self.schedule_days_env.split(",") if day.strip()]

    @field_validator("solver_timeout_seconds", "solver_max_time_seconds")
    @classmethod
    def validate_positive_timeout(cls, value: float) -> float:
        if value <= 0:
            msg = "Solver timeout must be greater than zero."
            raise ValueError(msg)
        return value

    @field_validator("slot_minutes")
    @classmethod
    def validate_slot_minutes(cls, value: int) -> int:
        if value <= 0 or 60 % value != 0:
            msg = "SLOT_MINUTES must divide 60 evenly and be greater than zero."
            raise ValueError(msg)
        return value

    @field_validator("api_key")
    @classmethod
    def validate_api_key_strength(cls, value: str) -> str:
        if len(value) < 32:
            msg = "API_KEY must be at least 32 characters (use e.g. `openssl rand -hex 32`)."
            raise ValueError(msg)
        return value

    @field_validator("allowed_origins_env")
    @classmethod
    def reject_wildcard_origin(cls, value: str) -> str:
        if any(origin.strip() == "*" for origin in value.split(",")):
            msg = "Wildcard '*' origin is not permitted for this service."
            raise ValueError(msg)
        return value

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() in {"development", "dev", "local"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
