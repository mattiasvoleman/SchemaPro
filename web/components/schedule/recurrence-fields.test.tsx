import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecurrenceFields } from "./recurrence-fields";

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => (key: string) => key,
}));

const value = {
  recurrence: "ALL_WEEKS" as const,
  startDate: "",
  endDate: "",
};

// recurrenceBadge moved to lib/recurrence.ts, and its tests with it: the grid
// needs the label on first paint, these fields only once a dialog opens.
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
