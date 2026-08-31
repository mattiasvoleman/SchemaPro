import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LunchSettingsCard, toInputTime } from "./lunch-settings-card";

const save = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  data: null as unknown,
  isSuccess: true,
}));

vi.mock("@/lib/queries", () => ({
  useLunchSettings: () => settings,
  useSaveLunchSettings: () => ({ mutateAsync: save, isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => (key: string) => key,
}));

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("LunchSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.data = null;
    settings.isSuccess = true;
    window.localStorage.clear();
  });

  it("fills the form from the school's saved settings", async () => {
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      // HH:MM:SS is what PostgreSQL holds, and what this fixture has always
      // said the API sends. It does not — it sends HH:MM — and for a while it
      // sent the raw `Date`, which is the bug the two tests below cover. Kept
      // as-is because the field must tolerate seconds either way.
      lunchStartTime: "10:45:00",
      lunchEndTime: "12:30:00",
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
    };

    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).toBe("10:45"));
    expect(field("windowEnd").value).toBe("12:30");
    expect(field("seats").value).toBe("180");
    expect(field("maxPerDay").value).toBe("7");
  });

  const saved = (overrides: Record<string, unknown> = {}) => {
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
      ...overrides,
    };
  };

  it("fills the times from the shape the API actually sends", async () => {
    // HH:MM, because the endpoint serialises the `@db.Time` column now. While
    // it returned the raw column instead, this field held
    // "1970-01-01T11:00:00.000Z".
    saved();

    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).toBe("11:00"));
    expect(field("windowEnd").value).toBe("13:00");
  });

  describe("toInputTime", () => {
    /*
     * Tested directly, because through the DOM the two outcomes are the same
     * thing: jsdom reports an invalid `type="time"` value as "" exactly as it
     * reports an empty one, so a rendered test passed whether the guard existed
     * or not. Found by mutation.
     */
    it.each([
      ["11:00", "11:00"],
      ["11:00:00", "11:00"],
      ["07:30:45.123", "07:30"],
    ])("keeps %s as %s", (given, expected) => {
      expect(toInputTime(given)).toBe(expected);
    });

    it.each([
      ["1970-01-01T11:00:00.000Z", "the shape the endpoint used to send"],
      ["", "an empty field"],
      ["elva", "something that is not a time at all"],
    ])("refuses %s — %s", (given) => {
      // "" and not "1970-": an input given a value it cannot parse draws empty
      // and writes a warning nobody reads. Empty on purpose is the same picture
      // with a reason behind it.
      expect(toInputTime(given)).toBe("");
    });
  });

  it("draws nothing rather than 1970 if a timestamp ever arrives", async () => {
    /*
     * The regression, and what it looked like: `.slice(0, 5)` of
     * "1970-01-01T11:00:00.000Z" is "1970-", which an `<input type="time">`
     * refuses — "The specified value '1970-' does not conform to the required
     * format" in the console, and an empty box on screen with no explanation.
     *
     * The field ends up empty either way. The difference is that it is empty on
     * purpose, and that this test fails if the truncation comes back.
     */
    saved({
      lunchStartTime: "1970-01-01T11:00:00.000Z",
      lunchEndTime: "1970-01-01T13:00:00.000Z",
    });

    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).not.toBe("1970-"));
    expect(field("windowStart").value).toBe("");
  });

  it("shows an absent seat limit as an empty field, not as a zero", async () => {
    // Null means "no limit worth modelling". A 0 in the box would read as a
    // dining hall with no chairs, and it would be saved as one.
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00:00",
      lunchEndTime: "13:00:00",
      lunchMinutes: 30,
      diningSeats: null,
      maxLessonsPerDayPerGroup: null,
    };

    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("seats").value).toBe(""));
    expect(field("maxPerDay").value).toBe("");
  });

  it("sends numbers, and an empty seat field as null", async () => {
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).toBe("11:00"));
    await user.click(screen.getByRole("button", { name: "save" }));

    // Real numbers, not strings: the API runs with implicit conversion off, so
    // "30" would be rejected with a 400 the admin cannot act on.
    expect(save).toHaveBeenCalledWith({
      lunchEnabled: false,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
      diningSeats: null,
      maxLessonsPerDayPerGroup: null,
    });
  });

  it("sends the seat count as a number once one is typed", async () => {
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("seats")).toBeTruthy());
    fireEvent.change(field("seats"), { target: { value: "180" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).toMatchObject({ diningSeats: 180 });
  });

  describe("the rules left behind in one browser's localStorage", () => {
    it("fills the form from them when the school has no saved settings", async () => {
      // The whole reason this card exists: these lived in one administrator's
      // browser, so a colleague generating the schedule ran different rules.
      window.localStorage.setItem(
        "schemapro.scheduleRules",
        JSON.stringify({
          lunchEnabled: true,
          lunchStart: "10:30",
          lunchEnd: "12:15",
          lunchMinutes: 45,
          maxPerDay: "6",
        }),
      );

      render(<LunchSettingsCard />);

      await waitFor(() => expect(field("windowStart").value).toBe("10:30"));
      expect(field("windowEnd").value).toBe("12:15");
      expect(field("minutes").value).toBe("45");
      // Stored as a string, sent as a number — the two shapes never matched.
      expect(field("maxPerDay").value).toBe("6");
    });

    it("respects a lunch the school deliberately switched off", async () => {
      // lunchEnabled never reached the server, so a migration that only read
      // the times would switch lunch back on for a school that turned it off.
      window.localStorage.setItem(
        "schemapro.scheduleRules",
        JSON.stringify({
          lunchEnabled: false,
          lunchStart: "10:30",
          lunchEnd: "12:15",
          lunchMinutes: 45,
        }),
      );

      render(<LunchSettingsCard />);

      await waitFor(() => expect(field("windowStart").value).toBe("10:30"));
      expect((screen.getByRole("switch") as HTMLElement).getAttribute("aria-checked")).toBe(
        "false",
      );
    });

    it("ignores them once the school has settings of its own", async () => {
      window.localStorage.setItem(
        "schemapro.scheduleRules",
        JSON.stringify({ lunchEnabled: true, lunchStart: "09:00" }),
      );
      settings.data = {
        id: "ls-1",
        lunchEnabled: true,
        lunchStartTime: "10:45:00",
        lunchEndTime: "12:30:00",
        lunchMinutes: 30,
        diningSeats: 180,
        maxLessonsPerDayPerGroup: null,
      };

      render(<LunchSettingsCard />);

      await waitFor(() => expect(field("windowStart").value).toBe("10:45"));
    });

    it("falls back to the defaults on a blob from an older build", async () => {
      window.localStorage.setItem("schemapro.scheduleRules", "{not json");

      render(<LunchSettingsCard />);

      await waitFor(() => expect(field("windowStart").value).toBe("11:00"));
    });

    it("does not write anything back to localStorage", async () => {
      // Reading it is a courtesy; saving on the reader's behalf would commit a
      // school to rules nobody has looked at.
      const user = userEvent.setup();
      window.localStorage.setItem(
        "schemapro.scheduleRules",
        JSON.stringify({ lunchEnabled: true, lunchStart: "10:30" }),
      );

      render(<LunchSettingsCard />);
      await waitFor(() => expect(field("windowStart").value).toBe("10:30"));
      await user.click(screen.getByRole("button", { name: "save" }));

      expect(window.localStorage.getItem("schemapro.scheduleRules")).toBe(
        JSON.stringify({ lunchEnabled: true, lunchStart: "10:30" }),
      );
    });
  });
});
