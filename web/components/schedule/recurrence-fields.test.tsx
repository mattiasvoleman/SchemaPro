import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecurrenceFields, recurrenceBadge } from "./recurrence-fields";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const t = (key: string) => key;

const value = {
  recurrence: "ALL_WEEKS" as const,
  startDate: "",
  endDate: "",
};

describe("recurrenceBadge", () => {
  it("says nothing for an ordinary weekly lesson", () => {
    // Most lessons run every week; a badge on every cell would be noise.
    expect(
      recurrenceBadge(
        { recurrence: "ALL_WEEKS", startDate: null, endDate: null },
        t,
      ),
    ).toBeNull();
  });

  it("marks odd and even weeks", () => {
    expect(
      recurrenceBadge({ recurrence: "ODD_WEEKS", startDate: null, endDate: null }, t),
    ).toBe("badgeOdd");
    expect(
      recurrenceBadge({ recurrence: "EVEN_WEEKS", startDate: null, endDate: null }, t),
    ).toBe("badgeEven");
  });

  it("marks a limited period even when the lesson runs every week", () => {
    // On a weekly grid a half-term lesson is the same rectangle as a year-long
    // one, so without this the grid claims more than is true.
    expect(
      recurrenceBadge(
        { recurrence: "ALL_WEEKS", startDate: null, endDate: "2026-10-30" },
        t,
      ),
    ).toBe("badgePeriod");
  });

  it("combines parity and period", () => {
    expect(
      recurrenceBadge(
        { recurrence: "ODD_WEEKS", startDate: "2026-08-17", endDate: null },
        t,
      ),
    ).toBe("badgeOdd · badgePeriod");
  });
});

describe("RecurrenceFields", () => {
  it("reports a parity change without disturbing the dates", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RecurrenceFields
        idPrefix="test"
        value={{ ...value, startDate: "2026-08-17" }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "recurrenceLabel" }));
    await user.click(screen.getByRole("option", { name: "recurrenceOdd" }));

    expect(onChange).toHaveBeenCalledWith({
      recurrence: "ODD_WEEKS",
      startDate: "2026-08-17",
      endDate: "",
    });
  });

  it("reports a date change without disturbing the parity", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RecurrenceFields
        idPrefix="test"
        value={{ ...value, recurrence: "EVEN_WEEKS" }}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByLabelText("periodTo"), "2026-10-30");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ recurrence: "EVEN_WEEKS" }),
    );
  });

  it("shows the current value rather than defaulting the control", () => {
    render(
      <RecurrenceFields
        idPrefix="test"
        value={{ recurrence: "ODD_WEEKS", startDate: "2026-08-17", endDate: "2026-10-30" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "recurrenceLabel" })).toHaveTextContent(
      "recurrenceOdd",
    );
    expect(screen.getByLabelText("periodFrom")).toHaveValue("2026-08-17");
    expect(screen.getByLabelText("periodTo")).toHaveValue("2026-10-30");
  });
});
