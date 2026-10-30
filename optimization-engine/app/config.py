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
    # Extra seconds spent AFTER a phase-1 timeout, relaxing one rule at a time to
    # name the one that does not fit. Zero switches the probe off. Spent only on
    # the failure path, where a week with no timetable and no explanation is the
    # most expensive outcome the engine can produce.
    solver_probe_seconds: float = Field(default=20.0, alias="SOLVER_PROBE_SECONDS")
    # The room optimisation's own budget, apart from the generator's, because
    # the two answer different questions at different prices. A generation is a
    # job a school starts and waits for; the room proposal sits behind a button
    # on the grundschema page and someone is watching the spinner. And it can
    # always stop early with nothing lost: the school's current rooms are a
    # valid answer from the first instant, so a short budget only ever means a
    # smaller improvement, never a refusal.
    room_solver_max_time_seconds: float = Field(
        default=10.0, alias="ROOM_SOLVER_MAX_TIME_SECONDS",
    )
    # The staffing proposal's budget, shared by its two stages, for the room
    # budget's reason: it sits behind a button on /admin/staffing with someone
    # watching the spinner, and it can always stop early with nothing lost —
    # keeping every row as it is is a valid answer from the first instant. The
    # 60-teacher, 400-row bench proves its first stage well inside it.
    staff_solver_max_time_seconds: float = Field(
        default=10.0, alias="STAFF_SOLVER_MAX_TIME_SECONDS",
    )

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
    # Elevernas håltimmar, per PUPIL and five-minute slot, read only when the
    # school has turned the rule on (pupilGaps in the payload). The rest of the
    # objective is then scaled by pupil_gaps.PUPIL_GAP_SCALE (25), so a whole
    # class of 25 pays 4 x 25 = 100 a slot against a teacher's 2 x 25 = 50:
    # a class sitting idle weighs two teachers sitting idle, minute for minute,
    # and a språkval group of six about half a teacher. Against the rest: a
    # whole class's 40-minute håltimme (800) outweighs a teacher's free-day
    # wish (40 x 25 = 1,000) only together with a little more, a room wish
    # (125) six times over and a second lesson of a subject on one day (75)
    # ten times over.
    weight_pupil_gap: int = Field(
        default=4,
        alias="WEIGHT_PUPIL_GAP",
        description=(
            "Penalty per pupil per idle slot between a pupil's first and last "
            "lesson of a day, when the school keeps pupils' håltimmar down."
        ),
    )
    weight_lunch_drift: int = Field(
        default=1,
        alias="WEIGHT_LUNCH_DRIFT",
        description=(
            "Penalty per slot a group's lunch differs from its own Monday "
            "lunch. Lowest of all the weights on purpose: a steady meal is "
            "worth having and worth nothing at the cost of a lesson."
        ),
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
    # A teacher's wished free weekday, paid ONCE PER DAY the teacher teaches on
    # it — not per lesson, because the wish is "no lessons that day" and the
    # second lesson on a day already lost breaks nothing more.
    #
    # FORTY, AGAINST WHAT IT HAS TO BUY. Keeping a wish means moving every
    # lesson the teacher has on that day to another, so the price is what the
    # moves cost elsewhere: idle time is 2 per five-minute slot (24 an hour) on
    # the same teacher, a second lesson of one requirement on a day 3 (spread),
    # a lesson pulled off a preferred room 5, and a previous slot given up 8 —
    # though not the teacher's own previous slots on the wished day, which the
    # disruption term stops rewarding while the wish is in force. Forty
    # outbids an hour and a half of the teacher's own idle time, or five other
    # lessons moved off last term's slots, and gives way to two idle hours, or
    # to a whole reshuffle of other people's weeks. That is the order a rektor
    # states it in: a free Friday is worth a slightly looser Tuesday, and not
    # worth a week of håltimmar. It is also what one
    # PREFERRED_FREE row over a four-lesson day would cost at 10 a lesson, so
    # a school that wrote the wish as a reservation before this existed is
    # not suddenly paid a different price for the same sentence.
    #
    # Zero or below switches the wish off entirely, the disruption term's
    # change with it, and builds nothing.
    weight_free_day_wish: int = Field(
        default=40,
        alias="WEIGHT_FREE_DAY_WISH",
        description="Penalty per day a teacher teaches on their wished free weekday.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins_env.split(",") if origin.strip()]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def schedule_days(self) -> list[int]:
        return [int(day.strip()) for day in self.schedule_days_env.split(",") if day.strip()]

    @field_validator(
        "solver_timeout_seconds",
        "solver_max_time_seconds",
        "room_solver_max_time_seconds",
        "staff_solver_max_time_seconds",
    )
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
