import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmploymentHistoryCard } from "./employment-history-card";

const history = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  asked: [] as unknown[][],
}));

vi.mock("@/lib/staffing-history-queries", () => ({
  useEmploymentHistory: (...args: unknown[]) => {
    history.asked.push(args);
    return history;
  },
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-admin" }, school: { timezone: "Europe/Stockholm" } }),
}));
vi.mock("next-intl", () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key;
  t.has = () => true;
  return { useTranslations: () => t };
});

const renderCard = () =>
  render(
    <EmploymentHistoryCard
      userId="t-anna"
      academicYearId="y1"
      personName={(id) => (id === "u-admin" ? "Anna Admin" : null)}
      subjectName={() => null}
      groupName={(id) => (id === "g-7b" ? "7B" : null)}
      dutyLabel={(id) => (id === "d1" ? "Mentor 7B" : null)}
    />,
  );

describe("EmploymentHistoryCard", () => {
  beforeEach(() => {
    history.asked = [];
    history.isLoading = false;
    history.isError = false;
    history.data = {
      truncated: false,
      entries: [
        {
          id: "l2",
          version: 2,
          entity: "DUTY",
          entityId: "d1",
          action: "UPDATE",
          actorId: "u-gone",
          createdAt: "2026-10-09T12:05:00.000Z",
          changes: [{ field: "minutesPerWeek", before: 60, after: 90 }],
        },
        {
          id: "l1",
          version: 1,
          entity: "EMPLOYMENT",
          entityId: "e1",
          action: "CREATE",
          actorId: null,
          createdAt: "2026-10-09T12:02:00.000Z",
          changes: [{ field: "employmentPercent", before: null, after: 80 }],
        },
      ],
    };
  });

  it("opens collapsed and reads nothing until it is unfolded", async () => {
    const user = userEvent.setup();
    renderCard();
    expect(history.asked.at(-1)).toEqual(["t-anna", "y1", false]);
    expect(screen.queryByText("version(2)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(history.asked.at(-1)).toEqual(["t-anna", "y1", true]);
    expect(screen.getByRole("button", { name: "hide" })).toHaveAttribute("aria-expanded", "true");
  });

  it("cites each version with its school-local time, its actor and what changed", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "show" }));
    const items = screen.getAllByRole("listitem").filter((item) => item.querySelector("ul"));
    expect(items[0]).toHaveTextContent("version(2)");
    expect(items[0]).toHaveTextContent("2026-10-09 14:05 · deletedUser");
    // An update that does not carry its label is named by today's uppdrag.
    expect(items[0]).toHaveTextContent("action.DUTY_UPDATE: Mentor 7B");
    expect(items[0]).toHaveTextContent("field.minutesPerWeek: minutes(60) → minutes(90)");
    expect(items[1]).toHaveTextContent("2026-10-09 14:02 · system");
    expect(items[1]).toHaveTextContent("field.employmentPercent: percent(80)");
  });

  it("says when the history is empty or could not be read, never an empty list", async () => {
    const user = userEvent.setup();
    history.data = { entries: [], truncated: false };
    const { unmount } = renderCard();
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByText("empty")).toBeInTheDocument();
    unmount();
    history.isError = true;
    history.data = undefined;
    renderCard();
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
  });
});
