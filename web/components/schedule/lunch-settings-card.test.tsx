import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LunchSettingsCard, toInputTime } from "./lunch-settings-card";

const save = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  data: null as unknown,
  isSuccess: true,
  isError: false,
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
    settings.isError = false;
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

  it("fills the walk switch from the school's rules, and sends what it is turned to", async () => {
    // Restid i generatorn: off until the school turns it on, and a save to an
    // API that names it sends it every time, so the stored rule is always the
    // one on screen.
    saved({ generatorKeepsTravelTime: false });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const travel = await screen.findByRole("switch", { name: "travel" });
    expect(travel.getAttribute("aria-checked")).toBe("false");
    expect(travel.getAttribute("aria-describedby")).toBe("generator-keeps-travel-hint");
    await user.click(travel);
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).toMatchObject({ generatorKeepsTravelTime: true });
  });

  it("reads a school whose API predates the switch as off, and offers nothing to save", async () => {
    saved();
    render(<LunchSettingsCard />);

    const travel = await screen.findByRole("switch", { name: "travel" });
    expect(travel.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the switch out of a save to an API that predates it", async () => {
    // That API refuses a key it does not know (forbidNonWhitelisted): a web
    // out before it would otherwise refuse every lunch save with a 400.
    saved();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("seats").value).toBe("180"));
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("generatorKeepsTravelTime");
  });

  it("sends the switch turned off when the API named it", async () => {
    saved({ generatorKeepsTravelTime: true });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await user.click(await screen.findByRole("switch", { name: "travel" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).toMatchObject({ generatorKeepsTravelTime: false });
  });

  it("fills the pupils' håltimmar switch from the school's rules, and sends both ways it is turned", async () => {
    // Elevernas håltimmar: off until the school turns it on, beside the walk
    // and on the same terms, and its own key on the save.
    saved({ generatorKeepsTravelTime: false, generatorKeepsPupilGapsDown: false });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const gaps = await screen.findByRole("switch", { name: "pupilGaps" });
    expect(gaps.getAttribute("aria-checked")).toBe("false");
    expect(gaps.getAttribute("aria-describedby")).toBe("generator-keeps-pupil-gaps-hint");
    await user.click(gaps);
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      generatorKeepsPupilGapsDown: true,
      generatorKeepsTravelTime: false,
    });

    await user.click(gaps);
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ generatorKeepsPupilGapsDown: false });
  });

  it("reads the pupils' håltimmar switch on when the school turned it on", async () => {
    saved({ generatorKeepsTravelTime: false, generatorKeepsPupilGapsDown: true });
    render(<LunchSettingsCard />);

    const gaps = await screen.findByRole("switch", { name: "pupilGaps" });
    await waitFor(() => expect(gaps.getAttribute("aria-checked")).toBe("true"));
    // Read, not changed: nothing to save.
    expect((screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the pupils' håltimmar switch out of a save to an API that predates it", async () => {
    saved({ generatorKeepsTravelTime: false });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    expect((await screen.findByRole("switch", { name: "pupilGaps" })).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(field("seats").value).toBe("180"));
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("generatorKeepsPupilGapsDown");
    expect(save.mock.calls[0]?.[0]).toMatchObject({ generatorKeepsTravelTime: false });
  });

  it("fills the teaching-in-a-row switch from the school's rules, and sends both ways it is turned", async () => {
    // Sammanhängande undervisning: off until the school turns it on, beside
    // the others and on the same terms, and its own key on the save.
    saved({
      generatorKeepsTravelTime: false,
      generatorKeepsPupilGapsDown: false,
      generatorKeepsConsecutiveTeaching: false,
    });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const consecutive = await screen.findByRole("switch", { name: "consecutive" });
    expect(consecutive.getAttribute("aria-checked")).toBe("false");
    expect(consecutive.getAttribute("aria-describedby")).toBe("generator-keeps-consecutive-hint");
    expect(screen.getByText("consecutiveHint")).toBeInTheDocument();
    await user.click(consecutive);
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      generatorKeepsConsecutiveTeaching: true,
      generatorKeepsTravelTime: false,
      generatorKeepsPupilGapsDown: false,
    });

    await user.click(consecutive);
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ generatorKeepsConsecutiveTeaching: false });
  });

  it("reads the teaching-in-a-row switch on when the school turned it on", async () => {
    saved({
      generatorKeepsTravelTime: false,
      generatorKeepsPupilGapsDown: false,
      generatorKeepsConsecutiveTeaching: true,
    });
    render(<LunchSettingsCard />);

    const consecutive = await screen.findByRole("switch", { name: "consecutive" });
    await waitFor(() => expect(consecutive.getAttribute("aria-checked")).toBe("true"));
    // Read, not changed: nothing to save.
    expect((screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the teaching-in-a-row switch out of a save to an API that predates it", async () => {
    // That API refuses a key it does not know (forbidNonWhitelisted): a web
    // out before it would otherwise refuse every lunch save with a 400.
    saved({ generatorKeepsTravelTime: false, generatorKeepsPupilGapsDown: false });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    expect((await screen.findByRole("switch", { name: "consecutive" })).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(field("seats").value).toBe("180"));
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("generatorKeepsConsecutiveTeaching");
    expect(save.mock.calls[0]?.[0]).toMatchObject({ generatorKeepsTravelTime: false, generatorKeepsPupilGapsDown: false });
  });

  it("warns beside the teaching-in-a-row switch only while the pupils' idle time is on too", async () => {
    // Measured: with both weighed in on the default search time, the limits
    // were often not kept. The notice is read off the form, so it follows the
    // switches before anything is saved.
    saved({
      generatorKeepsTravelTime: false,
      generatorKeepsPupilGapsDown: true,
      generatorKeepsConsecutiveTeaching: false,
    });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const consecutive = await screen.findByRole("switch", { name: "consecutive" });
    expect(screen.queryByText("consecutiveWithPupilGapsTitle")).not.toBeInTheDocument();

    await user.click(consecutive);
    expect(screen.getByText("consecutiveWithPupilGapsTitle")).toBeInTheDocument();
    expect(screen.getByText("consecutiveWithPupilGaps")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "pupilGaps" }));
    expect(screen.queryByText("consecutiveWithPupilGapsTitle")).not.toBeInTheDocument();

    // The pupils' switch alone, and this switch alone, say nothing.
    await user.click(screen.getByRole("switch", { name: "pupilGaps" }));
    await user.click(consecutive);
    expect(screen.queryByText("consecutiveWithPupilGapsTitle")).not.toBeInTheDocument();
  });

  it("keeps the other two switches in a save that changes only this one", async () => {
    // Each switch is its own key on one PUT; turning one must not drop or
    // flip the others the school already had on.
    saved({
      generatorKeepsTravelTime: true,
      generatorKeepsPupilGapsDown: true,
      generatorKeepsConsecutiveTeaching: false,
    });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await user.click(await screen.findByRole("switch", { name: "consecutive" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(save.mock.calls[0]?.[0]).toMatchObject({
      generatorKeepsTravelTime: true,
      generatorKeepsPupilGapsDown: true,
      generatorKeepsConsecutiveTeaching: true,
    });
  });

  describe("Bästa möjliga schema", () => {
    // The mode that lets Schemaförslag lay a week with some of the school's own
    // rules broken. Off until the school turns it on, beside the others and on
    // the same terms, and its own key on the save.
    const off = { generatorKeepsTravelTime: false, generatorKeepsPupilGapsDown: false, generatorKeepsConsecutiveTeaching: false };

    it("is off for a school that never turned it on, and for an API that sends no such field", async () => {
      saved({ ...off, generatorBestEffort: false });
      const { unmount } = render(<LunchSettingsCard />);
      expect((await screen.findByRole("switch", { name: "bestEffort" })).getAttribute("aria-checked")).toBe("false");
      unmount();

      saved(off);
      render(<LunchSettingsCard />);
      expect((await screen.findByRole("switch", { name: "bestEffort" })).getAttribute("aria-checked")).toBe("false");
    });

    it("reads on when the school turned it on, and offers nothing to save for a reading", async () => {
      saved({ ...off, generatorBestEffort: true });
      render(<LunchSettingsCard />);

      const best = await screen.findByRole("switch", { name: "bestEffort" });
      await waitFor(() => expect(best.getAttribute("aria-checked")).toBe("true"));
      expect((screen.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("sends both ways it is turned, and leaves the other switches as they were", async () => {
      saved({ ...off, generatorKeepsTravelTime: true, generatorBestEffort: false });
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      const best = await screen.findByRole("switch", { name: "bestEffort" });
      await user.click(best);
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(save.mock.calls[0]?.[0]).toMatchObject({
        generatorBestEffort: true,
        generatorKeepsTravelTime: true,
        generatorKeepsPupilGapsDown: false,
        generatorKeepsConsecutiveTeaching: false,
      });

      await user.click(best);
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(save.mock.calls[1]?.[0]).toMatchObject({ generatorBestEffort: false });
    });

    it("leaves the switch out of a save to an API that predates it", async () => {
      // That API refuses a key it does not know (forbidNonWhitelisted).
      saved(off);
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      expect((await screen.findByRole("switch", { name: "bestEffort" })).getAttribute("aria-checked")).toBe("false");
      await waitFor(() => expect(field("seats").value).toBe("180"));
      fireEvent.change(field("seats"), { target: { value: "200" } });
      await user.click(screen.getByRole("button", { name: "save" }));

      expect(save.mock.calls[0]?.[0]).not.toHaveProperty("generatorBestEffort");
    });

    it("says what the mode never gives way on and what it can, as two lists the switch is described by", async () => {
      // The reader is told, where the mode is chosen, that a double booking,
      // the frame times and the travel time are not among the rules that give
      // way (relaxation.py HARD_RULES): as lists, not one run of text.
      saved({ ...off, generatorBestEffort: false });
      render(<LunchSettingsCard />);

      const best = await screen.findByRole("switch", { name: "bestEffort" });
      const hint = document.getElementById(best.getAttribute("aria-describedby") ?? "")!;
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain("bestEffortHint");

      const [never, may] = within(hint).getAllByRole("list");
      expect(within(never!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "bestEffortNeverOverlap",
        "bestEffortNeverFrames",
        "bestEffortNeverTravel",
        "bestEffortNeverTeacher",
        "bestEffortNeverMeals",
        "bestEffortNeverRooms",
        "bestEffortNeverLessons",
        "bestEffortNeverGroups",
      ]);
      expect(within(may!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "bestEffortMayCap",
        "bestEffortMayDays",
        "bestEffortMayDistribution",
        "bestEffortMayRoomLock",
      ]);
      // Each list is introduced by its own sentence, in the order they are read.
      const text = hint.textContent ?? "";
      expect(text.indexOf("bestEffortNeverTitle")).toBeLessThan(text.indexOf("bestEffortNeverOverlap"));
      expect(text.indexOf("bestEffortMayTitle")).toBeGreaterThan(text.indexOf("bestEffortNeverGroups"));
      expect(text.indexOf("bestEffortMayTitle")).toBeLessThan(text.indexOf("bestEffortMayCap"));
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

  describe("before the school's own rules have arrived", () => {
    /*
     * The card used to draw its defaults while the request was in flight, with
     * Save enabled — so a press in that second PUT lunch switched off, no seat
     * limit and no daily cap over whatever the school had set.
     */
    it("draws no fields to type into, and a Save that cannot be pressed", () => {
      settings.isSuccess = false;
      render(<LunchSettingsCard />);

      expect(screen.queryByLabelText("windowStart")).toBeNull();
      expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    });

    it("says the rules could not be read rather than offering the defaults", () => {
      settings.isSuccess = false;
      settings.isError = true;
      render(<LunchSettingsCard />);

      expect(screen.getByRole("alert")).toHaveTextContent("loadFailed");
      expect(screen.queryByLabelText("windowStart")).toBeNull();
      expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    });
  });

  it("is the section the other pages link to", () => {
    // Generera schema and Lunchsittningar send the admin to #skolregler.
    render(<LunchSettingsCard />);

    expect(screen.getByRole("region", { name: "rulesTitle" }).id).toBe("skolregler");
  });

  it("waits for a change before it offers to save the school's own rules", async () => {
    saved();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).toBe("11:00"));
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    fireEvent.change(field("seats"), { target: { value: "200" } });
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("says beside the form that a save failed, and what still applies", async () => {
    // A toast scrolls away while the fields still hold what did not save.
    save.mockRejectedValueOnce(new Error("lunchStartTime måste vara en kvart"));
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("windowStart").value).toBe("11:00"));
    await user.click(screen.getByRole("button", { name: "save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("saveFailed");
    expect(alert).toHaveTextContent("lunchStartTime måste vara en kvart");
    expect(alert).toHaveTextContent("saveFailedHint");
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
      expect((screen.getByRole("switch", { name: "enabled" }) as HTMLElement).getAttribute("aria-checked")).toBe(
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

describe("LunchSettingsCard under Läsbehörighet", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] and
  // takes the pointer from [data-writes-inert~="PLANERING"] for a profile
  // that does not write planering (lunch-settings.controller.ts @Area).
  beforeEach(() => {
    settings.data = null;
    settings.isSuccess = true;
    settings.isError = false;
  });

  it("keeps the rules readable but inert, and hides Spara", async () => {
    render(<LunchSettingsCard />);
    await waitFor(() => expect(field("windowStart")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "save" })).toHaveAttribute("data-writes", "PLANERING");
    for (const control of [
      field("windowStart"),
      field("seats"),
      screen.getByRole("switch", { name: "enabled" }),
      screen.getByRole("switch", { name: "travel" }),
      screen.getByRole("switch", { name: "pupilGaps" }),
    ]) {
      expect(control.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "PLANERING");
      expect(control.closest("[data-writes]")).toBeNull();
    }
  });
});
