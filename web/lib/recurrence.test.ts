import { describe, expect, it } from "vitest";
import { recurrenceBadge } from "./recurrence";

const t = (key: string) => key;

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
