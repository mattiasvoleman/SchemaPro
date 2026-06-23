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
    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=8000, alias="PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    api_key: str = Field(alias="API_KEY")

    allowed_origins_env: str = Field(
        default="http://nestjs-backend:3000",
        alias="ALLOWED_ORIGINS",
    )
    schedule_days_env: str = Field(default="1,2,3,4,5", alias="SCHEDULE_DAYS")

    solver_timeout_seconds: float = Field(default=60.0, alias="SOLVER_TIMEOUT_SECONDS")
    solver_max_time_seconds: float = Field(default=60.0, alias="SOLVER_MAX_TIME_SECONDS")

    schedule_day_start_minutes: int = Field(default=480, alias="SCHEDULE_DAY_START_MINUTES")
    schedule_day_end_minutes: int = Field(default=1080, alias="SCHEDULE_DAY_END_MINUTES")
    slot_minutes: int = Field(default=15, alias="SLOT_MINUTES")

    weight_preferred_free_violation: int = Field(
        default=10,
        alias="WEIGHT_PREFERRED_FREE_VIOLATION",
    )
    weight_preferred_busy_violation: int = Field(
        default=5,
        alias="WEIGHT_PREFERRED_BUSY_VIOLATION",
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

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() in {"development", "dev", "local"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
