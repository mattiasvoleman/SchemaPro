import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MealCountsView, MealDay, MealSettings } from "@/lib/meal-counts";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import fixture from "../../../../../../src/meal-counts/__fixtures__/week.json";
import MealsPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Måltidskollen, the administrator's page (/admin/meals), through the gateway's routes and the real
 * messages: a key missing from sv.json or en.json throws here instead of printing its path. The week it reads
 * is the one the gateway's own spec holds to its rows (src/meal-counts/__fixtures__/week.json).
 *
 * What this guards: the page opens on the school's today, which only the gateway knows; the day says the
 * classes of each sitting with what they add and the portions, and the week a day to a row, a day with no
 * sitting said so; what is taken off and what is only shown (absence after the cut-off, a class under an
 * activity) are different columns; what is not counted is said, since the kitchen orders from it; a failed
 * read is said as such; the file and the print go out; and the settings save what changed, refuse what the
 * gateway would, and are read-only for the läsare.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const download = vi.hoisted(() => vi.fn());
vi.mock("@/lib/meal-counts-queries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/meal-counts-queries")>()), downloadMealCsv: download }));

const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The page draws on every click, and a host running a dozen sessions takes seconds over a test that steps through days.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

/** The page writes a date with the locale's own ICU; the test asks the same, so a Node with other data still agrees. */
const longDay = (iso: string, locale = "sv-SE") =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });

/** The DateField is a text input that takes yyyy-mm-dd typed in full. */
const jumpTo = (iso: string) => fireEvent.change(screen.getByRole("textbox", { name: "Dag" }), { target: { value: iso } });

const WEEK: MealCountsView = fixture.view;
const SETTINGS: MealSettings = { cutoffTime: "08:30", letterEnabled: true, kitchenEmail: "kok@skolan.se", lastLetterOn: "2027-02-03" };
const NONE: MealSettings = { cutoffTime: null, letterEnabled: false, kitchenEmail: null, lastLetterOn: null };

const state = vi.hoisted(() => ({
  week: undefined as unknown,
  alone: undefined as unknown,
  settings: undefined as unknown,
  weekError: false,
  settingsError: false,
}));

const emptyDay = (date: string, weekday: number): MealDay => ({
  date,
  weekday,
  sittings: [],
  totals: { pupils: 0, absentBefore: 0, staff: 0, portions: 0, absentAfter: 0, underActivity: 0 },
});

/** A view of `days` days from `from`, none with a sitting. */
function bare(from: string, days: number, over: Partial<MealCountsView> = {}): MealCountsView {
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  return { from, to: dates.at(-1)!, cutoff: "08:30", staffModelled: true, days: dates.map((date) => emptyDay(date, new Date(`${date}T12:00:00Z`).getUTCDay() || 7)), ...over };
}

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <MealsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state.week = WEEK;
  state.alone = undefined;
  state.settings = SETTINGS;
  state.weekError = false;
  state.settingsError = false;
  api.get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/meal-counts/settings") {
      if (state.settingsError) throw new ApiError(500, "boom");
      return state.settings;
    }
    if (path === "/api/v1/meal-counts?days=7") {
      if (state.weekError) throw new ApiError(500, "boom");
      return state.week;
    }
    if (path.startsWith("/api/v1/meal-counts?days=1&from=")) return state.alone;
    throw new Error(`unexpected ${path}`);
  });
  api.put.mockImplementation(async (_path: string, change: Partial<MealSettings>) => ({ ...(state.settings as MealSettings), ...change }));
  download.mockResolvedValue(undefined);
});

const dayTable = (iso = "2027-02-04") => screen.findByRole("table", { name: `Portioner per sittning ${longDay(iso)}` });

describe("the day", () => {
  it("opens on the school's today, which the gateway names, and says the portions of each sitting", async () => {
    renderPage();
    const table = await dayTable();
    const rows = within(table).getAllByRole("row");
    // The header, the two sittings and the total.
    expect(rows).toHaveLength(4);
    const first = within(rows[1]!).getAllByRole("cell");
    expect(first.map((cell) => cell.textContent)).toEqual(["10:30–11:00", "7A 237B 23", "49", "−3", "+4", "50", "1"]);
    const second = within(rows[2]!).getAllByRole("cell");
    expect(second.map((cell) => cell.textContent)).toEqual(["11:00–11:30", "10A 30 aktivitet", "30", "−0", "+0", "30", "3"]);
    expect(within(rows[3]!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Totalt", "79", "−3", "+4", "80", "4"]);
    expect(api.get).toHaveBeenCalledWith("/api/v1/meal-counts?days=7");
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("days=1"));
  });

  it("shows the day's figures first: portions, pupils, what is taken off, the staff and what came after the cut-off", async () => {
    renderPage();
    await dayTable();
    const strip = document.querySelector("dl")!;
    const tile = (label: string) => within(strip).getByText(label).parentElement!.textContent;
    expect(tile("Portioner")).toBe("Portioner80");
    expect(tile("Elever")).toBe("Elever79");
    expect(tile("Frånvaro, avdragen")).toBe("Frånvaro, avdragen−3");
    expect(tile("Personal")).toBe("Personal+4");
    expect(tile("Anmäld efter brytpunkten")).toContain("4");
    expect(tile("Anmäld efter brytpunkten")).toContain("Visas, dras inte av");
  });

  it("marks a class under an activity, and says on the page what is counted and what is not", async () => {
    renderPage();
    await dayTable();
    expect(screen.getByText("aktivitet")).toHaveAttribute("title", expect.stringContaining("räknas med"));
    const notes = screen.getByText("Så här räknas det").closest("div")!.parentElement!;
    expect(notes.textContent).toContain("Frånvaro som anmälts före klockan 08:30 den dagen är avdragen.");
    expect(notes.textContent).toContain("Bara frånvaro som täcker hela sittningen dras av");
    expect(notes.textContent).toContain("Personal räknas enligt den pedagogiska lunch med fast tid");
    expect(notes.textContent).toContain("Klasser med en schemabrytande aktivitet över sittningen räknas med");
    expect(notes.textContent).toContain("Allergier och kostval ingår inte. De lagras inte i Rastra.");
  });

  it("says there is no cut-off, and does not pretend that no absence came in", async () => {
    state.week = { ...WEEK, cutoff: null, days: WEEK.days.map((d) => ({ ...d })) };
    renderPage();
    const table = await dayTable();
    const first = within(within(table).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(first.map((cell) => cell.textContent)).toEqual(["10:30–11:00", "7A 237B 23", "49", "–", "+4", "50", "–"]);
    const strip = document.querySelector("dl")!;
    expect(within(strip).getByText("Frånvaro, avdragen").parentElement!.textContent).toContain("Ingår inte");
    expect(screen.getByText(/Ingen brytpunkt är satt, så ingen frånvaro dras av/)).toBeInTheDocument();
    expect(screen.queryByText(/Bara frånvaro som täcker hela sittningen/)).not.toBeInTheDocument();
  });

  it("says staff are not in the counts when the school has placed no pedagogisk lunch", async () => {
    state.week = { ...WEEK, staffModelled: false };
    renderPage();
    const table = await dayTable();
    expect(within(within(table).getAllByRole("row")[1]!).getAllByRole("cell")[4]!.textContent).toBe("–");
    expect(screen.getByText(/Personal ingår inte: ingen pedagogisk lunch med fast tid är lagd/)).toBeInTheDocument();
    const strip = document.querySelector("dl")!;
    expect(within(strip).getByText("Personal").parentElement!.textContent).toContain("Ingår inte");
  });

  it("steps through the days: back to today is disabled, forward uses the week already read, a later day is asked for alone", async () => {
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    expect(screen.getByRole("button", { name: "Föregående dag" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "I dag" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Nästa dag" }));
    expect(await dayTable("2027-02-05")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("days=1"));
    expect(screen.getByRole("button", { name: "I dag" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Föregående dag" }));
    expect(await dayTable()).toBeInTheDocument();
    // A day that is not in the week that was read is asked for alone.
    state.alone = bare("2027-02-11", 1, { days: [{ ...WEEK.days[0]!, date: "2027-02-11", weekday: 4 }] });
    jumpTo("2027-02-11");
    expect(await dayTable("2027-02-11")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/meal-counts?days=1&from=2027-02-11");
    await user.click(screen.getByRole("button", { name: "I dag" }));
    expect(await dayTable()).toBeInTheDocument();
  });

  it("stops at the last day the gateway answers for, and takes no day before today", async () => {
    renderPage();
    await dayTable();
    state.alone = bare("2027-02-17", 1);
    jumpTo("2027-02-17");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/v1/meal-counts?days=1&from=2027-02-17"));
    expect(screen.getByRole("button", { name: "Nästa dag" })).toBeDisabled();
    // A day typed outside today and thirteen days on is taken to the nearest one inside; nothing is asked for it.
    jumpTo("2027-02-18");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Dag" })).toHaveValue("2027-02-17"));
    jumpTo("2027-02-03");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Dag" })).toHaveValue("2027-02-04"));
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("2027-02-18"));
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("2027-02-03"));
  });

  it("says a day with no sitting, and offers neither the print nor the file", async () => {
    renderPage();
    await dayTable();
    jumpTo("2027-02-06");
    expect(await screen.findByText("Ingen lunch i det publicerade schemat den här dagen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skriv ut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hämta fil för Excel" })).toBeDisabled();
  });
});

describe("the week ahead", () => {
  async function openWeek() {
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    await user.click(screen.getByRole("tab", { name: "Veckan framåt" }));
    return { user, table: await screen.findByRole("table", { name: "Portioner per dag, veckan framåt" }) };
  }

  it("has a row for each of the seven days, with its sittings and portions, and says a day with none", async () => {
    const { table } = await openWeek();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(8);
    expect(within(rows[1]!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      shortDay("2027-02-04"),
      "10:30–11:00 · 5011:00–11:30 · 30",
      "79",
      "−3",
      "+4",
      "80",
      "4",
      "Visa dagen",
    ]);
    expect(within(rows[3]!).getByText("Ingen sittning")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("Ingen sittning")).toBeInTheDocument();
    expect(within(rows[5]!).getAllByRole("cell").map((cell) => cell.textContent)).toContain("19");
  });

  it("opens a day from its row", async () => {
    const { user, table } = await openWeek();
    await user.click(within(table).getByRole("button", { name: `Visa ${longDay("2027-02-05")}` }));
    expect(await screen.findByRole("table", { name: `Portioner per sittning ${longDay("2027-02-05")}` })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Dagen" })).toHaveAttribute("aria-selected", "true");
  });

  it("says that nothing is published when no day of the week has a sitting", async () => {
    state.week = bare("2027-02-04", 7);
    renderPage();
    await screen.findByText("Ingen lunch i det publicerade schemat den här dagen");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Veckan framåt" }));
    expect(await screen.findByText("Ingen lunch i det publicerade schemat den närmaste veckan")).toBeInTheDocument();
  });
});

describe("the file and the print", () => {
  it("fetches the day as a file named for it, and the week as one named for the week", async () => {
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    await user.click(screen.getByRole("button", { name: "Hämta fil för Excel" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith("2027-02-04", 1, "portioner-2027-02-04.csv"));
    await user.click(screen.getByRole("tab", { name: "Veckan framåt" }));
    await screen.findByRole("table", { name: "Portioner per dag, veckan framåt" });
    await user.click(screen.getByRole("button", { name: "Hämta fil för Excel" }));
    await waitFor(() => expect(download).toHaveBeenLastCalledWith(null, 7, "portioner-2027-02-04-2027-02-10.csv"));
  });

  it("says when the file could not be fetched", async () => {
    download.mockRejectedValueOnce(new ApiError(500, "boom"));
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    await user.click(screen.getByRole("button", { name: "Hämta fil för Excel" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Filen kunde inte hämtas. Försök igen om en stund."));
  });

  it("prints the page, with the day's title for the paper and the controls left off it", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: `Rastra Måltidskollen · Portioner ${longDay("2027-02-04")}` })).toHaveClass("print:block");
    expect(screen.getByRole("tablist").closest("div.print\\:hidden")).not.toBeNull();
    print.mockRestore();
  });

  it("titles the week's paper with its first and last day", async () => {
    const user = userEvent.setup();
    renderPage();
    await dayTable();
    await user.click(screen.getByRole("tab", { name: "Veckan framåt" }));
    expect(await screen.findByRole("heading", { name: `Rastra Måltidskollen · Portioner ${longDay("2027-02-04")} – ${longDay("2027-02-10")}` })).toBeInTheDocument();
  });
});

describe("when the read fails", () => {
  it("says so, and reads again on request", async () => {
    state.weekError = true;
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Portionerna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Ingen lunch i det publicerade schemat den här dagen")).not.toBeInTheDocument();
    state.weekError = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await dayTable()).toBeInTheDocument();
  });
});

describe("the settings", () => {
  const cutoff = () => screen.findByLabelText("Brytpunkt");

  it("shows what is stored and when the last letter went", async () => {
    renderPage();
    expect(await cutoff()).toHaveValue("08:30");
    expect(screen.getByLabelText("Köksadress")).toHaveValue("kok@skolan.se");
    expect(screen.getByRole("switch", { name: "Skicka ett brev till köket varje skoldag" })).toBeChecked();
    expect(screen.getByText("Brevet går klockan 08:30 varje dag som har en sittning.")).toBeInTheDocument();
    expect(screen.getByText(`Senaste brev: ${longDay("2027-02-03")}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();
  });

  it("saves what differs and nothing else", async () => {
    const user = userEvent.setup();
    renderPage();
    const field = await cutoff();
    await user.clear(field);
    await user.type(field, "09:15");
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/v1/meal-counts/settings", { cutoffTime: "09:15" }));
    expect(toast.success).toHaveBeenCalledWith("Inställningarna är sparade.");
  });

  it("says no letter has gone when none has, and will not turn the letter on without an hour and an address", async () => {
    state.settings = NONE;
    const user = userEvent.setup();
    renderPage();
    await cutoff();
    expect(screen.getByText("Inget brev har gått ännu.")).toBeInTheDocument();
    const letter = screen.getByRole("switch", { name: "Skicka ett brev till köket varje skoldag" });
    expect(letter).toBeDisabled();
    expect(screen.getByText("Ange en brytpunkt och en köksadress för att slå på brevet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Brytpunkt"), "08:30");
    expect(letter).toBeDisabled();
    await user.type(screen.getByLabelText("Köksadress"), "kok@skolan.se");
    expect(letter).toBeEnabled();
    await user.click(letter);
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/v1/meal-counts/settings", { cutoffTime: "08:30", kitchenEmail: "kok@skolan.se", letterEnabled: true }),
    );
  });

  it("refuses an address that is two, and a time that is none, before it asks the gateway", async () => {
    const user = userEvent.setup();
    renderPage();
    const email = await screen.findByLabelText("Köksadress");
    await user.clear(email);
    await user.type(email, "a@skolan.se, b@skolan.se");
    expect(screen.getByText("Köksadressen ska vara en e-postadress, bara en.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();
    await user.clear(email);
    await user.type(email, "kok@skolan.se");
    await user.clear(screen.getByLabelText("Brytpunkt"));
    expect(screen.getByText("Brevet kan bara vara på när brytpunkt och köksadress är angivna.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("says a refused save, with the gateway's words", async () => {
    api.put.mockRejectedValueOnce(new ApiError(400, "Brevet kan bara vara på när en brytpunkt och en köksadress är angivna.", "MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR"));
    const user = userEvent.setup();
    renderPage();
    const field = await cutoff();
    await user.clear(field);
    await user.type(field, "10:00");
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Brevet kan bara vara på när en brytpunkt och en köksadress är angivna."));
  });

  it("says the settings could not be read, and leaves the counts as they are", async () => {
    state.settingsError = true;
    renderPage();
    expect(await screen.findByText("Inställningarna kunde inte hämtas")).toBeInTheDocument();
    expect(await dayTable()).toBeInTheDocument();
  });

  it("leaves the fields to the läsare, who sees them set", async () => {
    profile.readOnly = true;
    renderPage();
    expect(await cutoff()).toBeDisabled();
    expect(screen.getByLabelText("Köksadress")).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Skicka ett brev till köket varje skoldag" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();
    expect(screen.getByLabelText("Brytpunkt")).toHaveValue("08:30");
  });

  it("marks the written controls for the profiles that do not write Drift", async () => {
    renderPage();
    const field = await cutoff();
    expect(field.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "DRIFT");
    expect(screen.getByRole("button", { name: "Spara" })).toHaveAttribute("data-writes", "DRIFT");
  });
});

describe("in English", () => {
  it("has every word", async () => {
    renderPage("en");
    expect(await screen.findByRole("table", { name: `Portions per sitting ${longDay("2027-02-04", "en-GB")}` })).toBeInTheDocument();
    expect(screen.getByText("Allergies and diets are not included. They are not stored in Rastra.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: "The week ahead" }));
    expect(await screen.findByRole("table", { name: "Portions per day, the week ahead" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Cut-off")).toHaveValue("08:30");
  });
});
