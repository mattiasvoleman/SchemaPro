import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WeekSchedule } from "./week-schedule";
import type { TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

function makeLesson(overrides: Partial<TimetableLesson> = {}): TimetableLesson {
  return {
    id: "math-mon",
    dayOfWeek: 1,
    startMinutes: 540,
    endMinutes: 600,
    title: "Math",
    color: "#6366f1",
    ...overrides,
  };
}

// Monday 2026-08-03 (ISO week 32). The harness pins TZ=UTC, so local
// construction is deterministic.
const WEEK_START = new Date(2026, 7, 3);

describe("WeekSchedule", () => {
  it("shows only a skeleton while loading, even with no lessons", () => {
    const { container } = render(
      <WeekSchedule
        weekStart={WEEK_START}
        onWeekChange={vi.fn()}
        lessons={[]}
        isLoading
      />,
    );

    // The skeleton is a decorative pulsing block with no role or text, so we
    // fall back to its class.
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("noLessons")).not.toBeInTheDocument();
    expect(screen.queryByText("monday")).not.toBeInTheDocument();
    // Week navigation stays available while loading.
    expect(screen.getByRole("button", { name: "previousWeek" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "nextWeek" })).toBeInTheDocument();
  });

  it("shows the empty state when the week has no lessons", () => {
    const { container } = render(
      <WeekSchedule
        weekStart={WEEK_START}
        onWeekChange={vi.fn()}
        lessons={[]}
        isLoading={false}
      />,
    );

    expect(screen.getByText("noLessons")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.queryByText("monday")).not.toBeInTheDocument();
  });

  it("renders the grid with the week's dates and forwards lesson clicks", async () => {
    const user = userEvent.setup();
    const onLessonClick = vi.fn();
    render(
      <WeekSchedule
        weekStart={WEEK_START}
        onWeekChange={vi.fn()}
        lessons={[makeLesson()]}
        isLoading={false}
        onLessonClick={onLessonClick}
      />,
    );

    expect(screen.getByText("monday")).toBeInTheDocument();
    // dates[0] is the week start itself: 3 August.
    expect(screen.getByText("3/8")).toBeInTheDocument();
    expect(screen.getByText("week 32")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Math/ }));
    expect(onLessonClick).toHaveBeenCalledTimes(1);
    expect(onLessonClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "math-mon" }),
    );
  });

  it("navigates exactly one week back and forward", async () => {
    const user = userEvent.setup();
    const onWeekChange = vi.fn();
    render(
      <WeekSchedule
        weekStart={WEEK_START}
        onWeekChange={onWeekChange}
        lessons={[]}
        isLoading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previousWeek" }));
    await user.click(screen.getByRole("button", { name: "nextWeek" }));

    expect(onWeekChange).toHaveBeenCalledTimes(2);
    expect(onWeekChange.mock.calls[0]?.[0]).toEqual(new Date(2026, 6, 27));
    expect(onWeekChange.mock.calls[1]?.[0]).toEqual(new Date(2026, 7, 10));
  });

  it("labels a year-boundary week with its ISO week number", () => {
    // Monday 2025-12-29 belongs to ISO week 1 of 2026.
    render(
      <WeekSchedule
        weekStart={new Date(2025, 11, 29)}
        onWeekChange={vi.fn()}
        lessons={[]}
        isLoading={false}
      />,
    );

    expect(screen.getByText("week 1")).toBeInTheDocument();
  });
});
