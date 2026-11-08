import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { LunchSettingsCard, toInputTime } from "./lunch-settings-card";

const save = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  data: null as unknown,
  isSuccess: true,
  isError: false,
}));

// The subjects the card counts markings on (Inte först eller sist på dagen).
const subjects = vi.hoisted(() => ({ data: [] as unknown[], isSuccess: true }));

vi.mock("@/lib/queries", () => ({
  useLunchSettings: () => settings,
  useSaveLunchSettings: () => ({ mutateAsync: save, isPending: false }),
  useSubjects: () => subjects,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  // A key with its values, so a count or a weight can be told from its key.
  // `has` is true for the codes the card renders from its catalogue
  // (placementRules.errors), which then echo as their own key.
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${Object.values(values).join("|")})` : key,
      {
        has: (key: string) =>
          ["PLACEMENT_EDGE_HARD_NOT_OFFERED", "PLACEMENT_PLACES_HARD_NOT_OFFERED", "PLACEMENT_PLACES_NEEDS_A_LIMIT"].includes(key),
      },
    ),
}));

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("LunchSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.data = null;
    settings.isSuccess = true;
    settings.isError = false;
    subjects.data = [];
    subjects.isSuccess = true;
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

describe("LunchSettingsCard: Placeringsregler", () => {
  /*
   * Three rules, each Av / Mjuk / Hård, a weight only while a rule is Mjuk,
   * and ten keys that reach the API together or not at all.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    settings.data = null;
    settings.isSuccess = true;
    settings.isError = false;
    subjects.data = [];
    subjects.isSuccess = true;
  });

  const stored = (overrides: Record<string, unknown> = {}) => {
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
      generatorKeepsTravelTime: false,
      generatorKeepsPupilGapsDown: false,
      generatorKeepsConsecutiveTeaching: false,
      placementEdgeMode: "OFF",
      placementEdgeWeight: 250,
      placementPlacesMode: "OFF",
      placementPlacesWeight: 250,
      placementSharedMode: "OFF",
      placementSharedWeight: 250,
      maxClassRoomsPerDay: null,
      maxTeacherRoomsPerDay: null,
      maxClassBuildingsPerDay: null,
      maxTeacherBuildingsPerDay: null,
      ...overrides,
    };
  };

  /** The row an API from before the rules sends: none of their fields. */
  const predating = () => {
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
    };
  };

  const rule = (title: "edge.title" | "places.title" | "shared.title") =>
    screen.findByRole("group", { name: title });
  const pick = async (
    user: ReturnType<typeof userEvent.setup>,
    group: HTMLElement,
    mode: "OFF" | "SOFT" | "HARD",
  ) => user.click(within(group).getByRole("radio", { name: `mode.${mode}` }));
  const type = (group: HTMLElement, label: string, value: string) =>
    fireEvent.change(within(group).getByLabelText(label), { target: { value } });
  const saveButton = () => screen.getByRole("button", { name: "save" });

  it("starts every rule on Av with no weight asked for, for a school that never set one", async () => {
    predating();
    render(<LunchSettingsCard />);

    for (const title of ["edge.title", "places.title", "shared.title"] as const) {
      const group = await rule(title);
      expect(within(group).getByRole("radio", { name: "mode.OFF" })).toBeChecked();
      expect(within(group).queryByLabelText("weight")).toBeNull();
    }
    expect(screen.getByLabelText("limit.classRoom")).toHaveValue(null);
  });

  it("fills modes, weights and limits from the school's rules, a null limit as an empty box", async () => {
    stored({
      placementEdgeMode: "SOFT",
      placementEdgeWeight: 400,
      placementPlacesMode: "SOFT",
      placementPlacesWeight: 300,
      placementSharedMode: "HARD",
      placementSharedWeight: 90,
      maxClassRoomsPerDay: 1,
      maxTeacherRoomsPerDay: 3,
      maxClassBuildingsPerDay: null,
      maxTeacherBuildingsPerDay: 1,
    });
    render(<LunchSettingsCard />);

    const edge = await rule("edge.title");
    expect(within(edge).getByRole("radio", { name: "mode.SOFT" })).toBeChecked();
    expect(within(edge).getByLabelText("weight")).toHaveValue(400);
    const places = await rule("places.title");
    expect(within(places).getByRole("radio", { name: "mode.SOFT" })).toBeChecked();
    expect(within(places).getByLabelText("weight")).toHaveValue(300);
    expect(within(places).getByLabelText("limit.classRoom")).toHaveValue(1);
    expect(within(places).getByLabelText("limit.teacherRoom")).toHaveValue(3);
    expect(within(places).getByLabelText("limit.classBuilding")).toHaveValue(null);
    expect(within(places).getByLabelText("limit.teacherBuilding")).toHaveValue(1);
    const shared = await rule("shared.title");
    expect(within(shared).getByRole("radio", { name: "mode.HARD" })).toBeChecked();
    // Hård has no weight, though one is stored.
    expect(within(shared).queryByLabelText("weight")).toBeNull();
    // Read, not changed: nothing to save.
    expect(saveButton()).toBeDisabled();
  });

  it("asks for a weight only while the rule is Mjuk", async () => {
    stored();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const edge = await rule("edge.title");
    expect(within(edge).queryByLabelText("weight")).toBeNull();
    await pick(user, edge, "SOFT");
    expect(within(edge).getByLabelText("weight")).toHaveValue(250);
    expect(within(edge).getByText("weightHint")).toBeInTheDocument();
    await pick(user, edge, "OFF");
    expect(within(edge).queryByLabelText("weight")).toBeNull();
    // Hård has none: shown on rule 3, which is offered hard.
    const shared = await rule("shared.title");
    await pick(user, shared, "SOFT");
    expect(within(shared).getByLabelText("weight")).toBeInTheDocument();
    await pick(user, shared, "HARD");
    expect(within(shared).queryByLabelText("weight")).toBeNull();
  });

  it("offers rules 1 and 2 as Av and Mjuk only, and rule 3 as all three", async () => {
    // A hard rule 1 cost 4.5 times the first timetable and a hard rule 2 2.8 to 3.6 times (BESLUT 3 and 4 in the PR);
    // the API and the database refuse them too.
    stored();
    render(<LunchSettingsCard />);

    for (const [title, hint] of [
      ["edge.title", "edge.hardHint"],
      ["places.title", "places.hardHint"],
    ] as const) {
      const group = await rule(title);
      expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "SOFT"]);
      expect(within(group).queryByRole("radio", { name: "mode.HARD" })).toBeNull();
      expect(within(group).getByText(hint)).toBeInTheDocument();
    }
    expect((await rule("edge.title")).querySelector("input")?.getAttribute("aria-describedby")).toBe(
      "placement-edge-hint placement-edge-hard-hint",
    );
    expect((await rule("places.title")).querySelector("input")?.getAttribute("aria-describedby")).toBe(
      "placement-places-hint placement-places-hard-hint",
    );
    const shared = await rule("shared.title");
    expect(within(shared).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["OFF", "SOFT", "HARD"]);
    expect(within(shared).queryByText(/hardHint/)).toBeNull();
  });

  it.each([
    ["PLACEMENT_EDGE_HARD_NOT_OFFERED", "placementEdgeMode: ... OFF eller SOFT."],
    ["PLACEMENT_PLACES_HARD_NOT_OFFERED", "placementPlacesMode: ... OFF eller SOFT."],
  ])("says the gateway's refusal of a hard rule (%s) in the reader's language, and any other refusal as the gateway wrote it", async (code, sentence) => {
    // Not reachable from the card, which does not offer it: a tab, a script or
    // a row written before the refusal.
    stored();
    const user = userEvent.setup();
    save.mockRejectedValueOnce(new ApiError(400, sentence, code));
    save.mockRejectedValueOnce(new ApiError(400, "Något annat som gateway skrev", "SOMETHING_ELSE"));
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("seats").value).toBe("180"));
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(code);
    expect(screen.getByRole("alert")).not.toHaveTextContent("OFF eller SOFT");

    await user.click(saveButton());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Något annat som gateway skrev"));
    expect(screen.getByRole("alert")).not.toHaveTextContent(code);
  });

  it("sends all ten keys with the numbers as numbers and empty limits as null", async () => {
    stored();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const edge = await rule("edge.title");
    await pick(user, edge, "SOFT");
    type(edge, "weight", "400");
    const places = await rule("places.title");
    await pick(user, places, "SOFT");
    type(places, "limit.classRoom", "2");
    type(places, "limit.teacherBuilding", "1");
    await pick(user, await rule("shared.title"), "HARD");
    await user.click(saveButton());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      placementEdgeMode: "SOFT",
      placementEdgeWeight: 400,
      placementPlacesMode: "SOFT",
      placementPlacesWeight: 250,
      placementSharedMode: "HARD",
      placementSharedWeight: 250,
      maxClassRoomsPerDay: 2,
      maxTeacherRoomsPerDay: null,
      maxClassBuildingsPerDay: null,
      // "1" is a single one all day, a real limit, and not the same as empty.
      maxTeacherBuildingsPerDay: 1,
    });
  });

  it("keeps a stored weight through a rule that is off, and sends the default for one never typed", async () => {
    stored({ placementEdgeWeight: 400, placementPlacesWeight: 250 });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await waitFor(() => expect(field("seats").value).toBe("180"));
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(saveButton());

    expect(save.mock.calls[0]?.[0]).toMatchObject({
      placementEdgeMode: "OFF",
      placementEdgeWeight: 400,
      placementPlacesWeight: 250,
    });
  });

  it("sends 250 for a weight left unusable on a rule that is then switched off", async () => {
    stored();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const edge = await rule("edge.title");
    await pick(user, edge, "SOFT");
    type(edge, "weight", "");
    expect(saveButton()).toBeDisabled();
    await pick(user, edge, "OFF");
    fireEvent.change(field("seats"), { target: { value: "200" } });
    await user.click(saveButton());

    expect(save.mock.calls[0]?.[0]).toMatchObject({ placementEdgeMode: "OFF", placementEdgeWeight: 250 });
  });

  it("does not let a weight typed wrong and then hidden by Hård block Spara: Hård has no weight, and 250 goes", async () => {
    // A weight counts only while the rule is Mjuk; a field nobody can see must not hold the button shut.
    stored();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    const group = await rule("shared.title");
    await pick(user, group, "SOFT");
    type(group, "weight", "5000");
    expect(saveButton()).toBeDisabled();
    await pick(user, group, "HARD");
    expect(within(group).queryByLabelText("weight")).toBeNull();
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());

    expect(save.mock.calls[0]?.[0]).toMatchObject({ placementSharedMode: "HARD", placementSharedWeight: 250 });
  });

  it.each([["edge.title"], ["places.title"]] as const)(
    "does not let a weight typed wrong on %s and then hidden by Av block Spara: the rule that is off has no weight, and 250 goes",
    async (title) => {
      // Rules 1 and 2 are Av or Mjuk, so the weight is hidden by Av here (by Hård on rule 3, above); a limit stands
      // so that rule 2 has what it needs while Mjuk.
      stored({ maxClassRoomsPerDay: 2 });
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      const group = await rule(title);
      await pick(user, group, "SOFT");
      type(group, "weight", "5000");
      expect(saveButton()).toBeDisabled();
      await pick(user, group, "OFF");
      expect(within(group).queryByLabelText("weight")).toBeNull();
      expect(saveButton()).toBeEnabled();
      fireEvent.change(field("seats"), { target: { value: "200" } });
      await user.click(saveButton());

      expect(save.mock.calls[0]?.[0]).toMatchObject(
        title === "edge.title"
          ? { placementEdgeMode: "OFF", placementEdgeWeight: 250 }
          : { placementPlacesMode: "OFF", placementPlacesWeight: 250 },
      );
    },
  );

  describe("weights", () => {
    it.each([["0"], ["1001"], ["2.5"], ["-3"], [""], ["1e2"]])(
      "refuse %j on the field while the rule is Mjuk, and keep Spara closed",
      async (typed) => {
        stored();
        const user = userEvent.setup();
        render(<LunchSettingsCard />);

        const group = await rule("shared.title");
        await pick(user, group, "SOFT");
        type(group, "weight", typed);

        expect(within(group).getByText("weightInvalid")).toBeInTheDocument();
        expect(within(group).getByLabelText("weight")).toHaveAttribute("aria-invalid", "true");
        expect(saveButton()).toBeDisabled();
      },
    );

    it.each([["1"], ["1000"], ["40"]])("take %j", async (typed) => {
      stored();
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      const group = await rule("shared.title");
      await pick(user, group, "SOFT");
      type(group, "weight", typed);
      await user.click(saveButton());

      expect(save.mock.calls[0]?.[0]).toMatchObject({ placementSharedMode: "SOFT", placementSharedWeight: Number(typed) });
    });
  });

  describe("Salar och byggnader per dag", () => {
    it(
      "is not saved as Mjuk without at least one limit, and says so at the fields",
      async () => {
        stored();
        const user = userEvent.setup();
        render(<LunchSettingsCard />);

        const group = await rule("places.title");
        await pick(user, group, "SOFT");

        expect(within(group).getByText("limitsMissing")).toBeInTheDocument();
        for (const label of ["limit.classRoom", "limit.teacherRoom", "limit.classBuilding", "limit.teacherBuilding"]) {
          const input = within(group).getByLabelText(label);
          expect(input).toHaveAttribute("aria-invalid", "true");
          expect(input.getAttribute("aria-describedby")).toContain("placement-limits-error");
        }
        expect(saveButton()).toBeDisabled();

        // One limit is enough, and the error goes with the need for it.
        type(group, "limit.teacherRoom", "1");
        expect(within(group).queryByText("limitsMissing")).toBeNull();
        expect(within(group).getByLabelText("limit.classRoom")).not.toHaveAttribute("aria-invalid");
        expect(saveButton()).toBeEnabled();
      },
    );

    it("asks for no limit while the rule is Av, and 1 counts as a limit", async () => {
      stored();
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      const group = await rule("places.title");
      await pick(user, group, "SOFT");
      expect(within(group).getByText("limitsMissing")).toBeInTheDocument();
      type(group, "limit.classBuilding", "1");
      expect(within(group).queryByText("limitsMissing")).toBeNull();
      type(group, "limit.classBuilding", "");
      await pick(user, group, "OFF");
      expect(within(group).queryByText("limitsMissing")).toBeNull();
    });

    it.each([["21"], ["0"], ["-1"], ["1.5"], ["1e1"]])(
      "refuses %j in a limit, on that field, even while the rule is Av",
      async (typed) => {
        stored();
        render(<LunchSettingsCard />);

        const group = await rule("places.title");
        type(group, "limit.teacherRoom", typed);

        expect(within(group).getByText("limitInvalid")).toBeInTheDocument();
        expect(within(group).getByLabelText("limit.teacherRoom")).toHaveAttribute("aria-invalid", "true");
        expect(within(group).getByLabelText("limit.classRoom")).not.toHaveAttribute("aria-invalid");
        expect(saveButton()).toBeDisabled();
      },
    );

    it("stops the arrows of a limit box at 1 and 20, the range the API takes", async () => {
      stored();
      render(<LunchSettingsCard />);

      const group = await rule("places.title");
      for (const label of ["limit.classRoom", "limit.teacherRoom", "limit.classBuilding", "limit.teacherBuilding"]) {
        expect(within(group).getByLabelText(label)).toHaveAttribute("min", "1");
        expect(within(group).getByLabelText(label)).toHaveAttribute("max", "20");
      }
    });

    it("takes 1 and 20 at the two ends of the range", async () => {
      stored();
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      const group = await rule("places.title");
      await pick(user, group, "SOFT");
      type(group, "limit.classRoom", "1");
      type(group, "limit.teacherRoom", "20");
      await user.click(saveButton());

      expect(save.mock.calls[0]?.[0]).toMatchObject({
        maxClassRoomsPerDay: 1,
        maxTeacherRoomsPerDay: 20,
      });
    });

    it("explains what is counted: buildings, room groups and the number visited", async () => {
      stored();
      render(<LunchSettingsCard />);

      // The sentence itself is the copy's (placement-rules-fields.test.tsx
      // reads it in both languages); here it is linked to the rule.
      const group = await rule("places.title");
      expect(within(group).getByText("places.hint")).toBeInTheDocument();
      expect(within(group).getByText("limitsHint")).toBeInTheDocument();
      expect(within(group).getByRole("radio", { name: "mode.OFF" }).getAttribute("aria-describedby")).toBe(
        "placement-places-hint placement-places-hard-hint",
      );
    });
  });

  describe("Inte först eller sist på dagen", () => {
    it("says how many subjects carry a marking, and points at the subjects", async () => {
      stored();
      subjects.data = [
        { id: "s-1", name: "Idrott", notFirstInDay: true, notLastInDay: false },
        { id: "s-2", name: "Matematik", notFirstInDay: false, notLastInDay: true },
        { id: "s-3", name: "Svenska", notFirstInDay: true, notLastInDay: true },
        { id: "s-4", name: "Bild" },
      ];
      render(<LunchSettingsCard />);

      const group = await rule("edge.title");
      // Three subjects, not four boxes.
      expect(within(group).getByText(/edge\.count\(3\)/)).toBeInTheDocument();
      expect(within(group).getByRole("link", { name: "edge.link" })).toHaveAttribute("href", "/admin/subjects");
    });

    it("says none are marked yet, and says nothing about the count while the subjects load", async () => {
      stored();
      const { unmount } = render(<LunchSettingsCard />);
      expect(await screen.findByText(/edge\.count\(0\)/)).toBeInTheDocument();
      unmount();

      subjects.isSuccess = false;
      render(<LunchSettingsCard />);
      const group = await rule("edge.title");
      expect(within(group).queryByText(/edge\.count/)).toBeNull();
      expect(within(group).getByRole("link", { name: "edge.link" })).toBeInTheDocument();
    });
  });

  describe("an API from before the rules", () => {
    it("is not sent their keys by a save that does not touch them", async () => {
      // forbidNonWhitelisted: a web out before the API would otherwise refuse
      // every lunch save with a 400.
      predating();
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      await waitFor(() => expect(field("seats").value).toBe("180"));
      fireEvent.change(field("seats"), { target: { value: "200" } });
      await user.click(saveButton());

      const sent = save.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(sent).filter((key) => /^placement|sPerDay$/.test(key))).toEqual([]);
    });

    it("is sent all ten once an admin turns a rule on", async () => {
      predating();
      const user = userEvent.setup();
      render(<LunchSettingsCard />);

      await pick(user, await rule("shared.title"), "HARD");
      await user.click(saveButton());

      expect(save.mock.calls[0]?.[0]).toMatchObject({
        placementEdgeMode: "OFF",
        placementEdgeWeight: 250,
        placementPlacesMode: "OFF",
        placementPlacesWeight: 250,
        placementSharedMode: "HARD",
        placementSharedWeight: 250,
        maxClassRoomsPerDay: null,
        maxTeacherRoomsPerDay: null,
        maxClassBuildingsPerDay: null,
        maxTeacherBuildingsPerDay: null,
      });
    });
  });

  it("keeps the other keys in a save that only touches one rule", async () => {
    stored({
      generatorKeepsTravelTime: true,
      placementEdgeMode: "SOFT",
      placementPlacesMode: "SOFT",
      placementPlacesWeight: 120,
      maxClassRoomsPerDay: 2,
    });
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await pick(user, await rule("shared.title"), "SOFT");
    await user.click(saveButton());

    expect(save.mock.calls[0]?.[0]).toMatchObject({
      generatorKeepsTravelTime: true,
      placementEdgeMode: "SOFT",
      placementPlacesMode: "SOFT",
      placementPlacesWeight: 120,
      maxClassRoomsPerDay: 2,
      placementSharedMode: "SOFT",
    });
  });

  it("sends nothing while the form is refused", async () => {
    stored();
    const user = userEvent.setup();
    render(<LunchSettingsCard />);

    await pick(user, await rule("places.title"), "SOFT");
    await user.click(saveButton());

    expect(save).not.toHaveBeenCalled();
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
    subjects.data = [];
    subjects.isSuccess = true;
  });

  it("keeps the weight of a Mjuk placement rule inert as well", async () => {
    settings.data = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
      diningSeats: 180,
      maxLessonsPerDayPerGroup: 7,
      placementSharedMode: "SOFT",
      placementSharedWeight: 90,
    };
    render(<LunchSettingsCard />);

    const weight = await screen.findByLabelText("weight");
    expect(weight.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "PLANERING");
    expect(weight.closest("[data-writes]")).toBeNull();
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
      // Placeringsregler: the choice, a weight (shown while Mjuk) and a limit.
      screen.getAllByRole("radio", { name: "mode.HARD" })[0]!,
      screen.getByLabelText("limit.classRoom"),
    ]) {
      expect(control.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "PLANERING");
      expect(control.closest("[data-writes]")).toBeNull();
    }
  });
});
