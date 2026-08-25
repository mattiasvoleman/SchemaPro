import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LunchSettingsCard } from "./lunch-settings-card";

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
      // PostgreSQL returns a `time` column with seconds; the input wants HH:MM.
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
