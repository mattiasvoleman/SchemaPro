from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TimeGrid:
    day_start_minutes: int
    day_end_minutes: int
    slot_minutes: int
    schedule_days: tuple[int, ...]

    @property
    def slots_per_day(self) -> int:
        return (self.day_end_minutes - self.day_start_minutes) // self.slot_minutes

    @property
    def horizon(self) -> int:
        return len(self.schedule_days) * self.slots_per_day

    def day_index(self, day_of_week: int) -> int:
        try:
            return self.schedule_days.index(day_of_week)
        except ValueError as exc:
            msg = f"Day {day_of_week} is outside the configured schedule week."
            raise ValueError(msg) from exc

    def absolute_start(self, day_of_week: int, start_slot: int) -> int:
        return self.day_index(day_of_week) * self.slots_per_day + start_slot

    def decode_absolute(self, absolute_start: int) -> tuple[int, int]:
        day_idx = absolute_start // self.slots_per_day
        start_slot = absolute_start % self.slots_per_day
        return self.schedule_days[day_idx], start_slot

    def minutes_to_slots(self, minutes: int) -> int:
        if minutes <= 0:
            msg = "Lesson duration must be positive."
            raise ValueError(msg)
        slots = (minutes + self.slot_minutes - 1) // self.slot_minutes
        if slots * self.slot_minutes != minutes:
            msg = (
                f"Lesson duration {minutes} minutes is not aligned to "
                f"{self.slot_minutes}-minute slots."
            )
            raise ValueError(msg)
        return slots

    def parse_hhmmss(self, value: str) -> int:
        hours, minutes, seconds = (int(part) for part in value.split(":"))
        if seconds != 0:
            msg = f"Time {value} must align to whole minutes."
            raise ValueError(msg)
        total = hours * 60 + minutes
        if total < self.day_start_minutes or total >= self.day_end_minutes:
            msg = f"Time {value} is outside the configured daily schedule window."
            raise ValueError(msg)
        if (total - self.day_start_minutes) % self.slot_minutes != 0:
            msg = f"Time {value} is not aligned to {self.slot_minutes}-minute slots."
            raise ValueError(msg)
        return (total - self.day_start_minutes) // self.slot_minutes

    def format_hhmmss(self, start_slot: int, duration_slots: int) -> tuple[str, str]:
        start_minutes = self.day_start_minutes + start_slot * self.slot_minutes
        end_minutes = start_minutes + duration_slots * self.slot_minutes
        return (
            self._minutes_to_hhmmss(start_minutes),
            self._minutes_to_hhmmss(end_minutes),
        )

    @staticmethod
    def _minutes_to_hhmmss(total_minutes: int) -> str:
        hours = total_minutes // 60
        minutes = total_minutes % 60
        return f"{hours:02d}:{minutes:02d}:00"

    def clamp_to_grid(self, value: str) -> int | None:
        """A wall-clock time as a slot, folded into the scheduling day.

        `parse_hhmmss` is strict because the times IT reads are typed by an
        administrator who can be told to correct them. The times reaching HERE
        are availability windows, and a school writes those in whole days: this
        product's own full-day closure is 00:00-23:59 (see `isFullDay` in
        calendar.service.ts) and the seed ships a teacher rule of 12:00-23:59.
        Neither lands inside an 08:00-18:00 grid, and strict parsing turned each
        of them into a 400 for the ENTIRE optimization — one holiday closure and
        the school could not generate a timetable at all.

        Folding is what the times mean anyway: "unavailable until 23:59" says
        the rest of the school day, and the rest of the school day ends when the
        grid does. A window that misses the day altogether returns None, because
        clamping it would invent a constraint the school never wrote.

        Returns a slot index; the end of the day is `slots_per_day`, one past
        the last slot, which is what a half-open range needs.
        """
        hours, minutes, seconds = (int(part) for part in value.split(":"))
        if seconds not in (0, 59):
            msg = f"Time {value} must align to whole minutes."
            raise ValueError(msg)
        # 23:59:59 and 23:59 are both the same thing a school means by "all day".
        total = hours * 60 + minutes + (1 if seconds == 59 else 0)
        if total <= self.day_start_minutes:
            return 0
        if total >= self.day_end_minutes:
            return self.slots_per_day
        # Outward, never inward: a window that starts mid-slot covers that slot,
        # or a lesson could be placed in the half of it the school has taken.
        offset = total - self.day_start_minutes
        return offset // self.slot_minutes

    def window_to_absolute_range(
        self,
        day_of_week: int | None,
        start_time: str,
        end_time: str,
    ) -> list[tuple[int, int]]:
        start_slot = self.clamp_to_grid(start_time)
        end_slot = self.clamp_to_grid(end_time)
        if end_slot <= start_slot:
            # Not an error any more: a window can legitimately fall entirely
            # outside the school day (an evening booking, a 06:00-07:00 rule),
            # and such a window constrains nothing rather than being invalid.
            return []

        days = (day_of_week,) if day_of_week is not None else self.schedule_days
        ranges: list[tuple[int, int]] = []
        for day in days:
            absolute_start = self.absolute_start(day, start_slot)
            absolute_end = self.absolute_start(day, end_slot)
            ranges.append((absolute_start, absolute_end))
        return ranges

    def intervals_overlap(
        self,
        start_a: int,
        duration_a: int,
        start_b: int,
        duration_b: int,
    ) -> bool:
        end_a = start_a + duration_a
        end_b = start_b + duration_b
        return start_a < end_b and start_b < end_a
