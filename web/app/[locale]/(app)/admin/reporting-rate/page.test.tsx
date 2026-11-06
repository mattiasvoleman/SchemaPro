import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { ReportingRateView, ReportingSettings, ReportingTeacherRow } from "@/lib/reporting-rate";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import ReportingRatePage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Rapporteringsgrad, the administrator's page (/admin/reporting-rate), through
 * the gateway's routes and the real messages: a key missing from sv.json or
 * en.json throws here instead of printing its path.
 *
 * What this guards: a failed read is said as such and never "nothing here"; the
 * table opens on the lowest share and every column sorts, by mouse and by
 * keyboard, with aria-sort on the sorted one; the arrows take the days the
 * gateway names and the period tabs keep the day; a period with no läsår and a
 * period with no lesson are each said; the switches and the limit save as they
 * turn; and the läsare changes nothing.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ROOT = "/api/v1/reporting-rate";
const SETTINGS_PATH = `${ROOT}/settings`;

const teacher = (id: string, lastName: string, firstName: string, held: number, reported: number): ReportingTeacherRow => ({
  teacherId: id,
  firstName,
  lastName,
  held,
  reported,
});

// As the gateway sorts them: the lowest share first, then the name.
const TEACHERS = [
  teacher("t-5", "Holm", "Eva", 5, 0),
  teacher("t-3", "Ås", "Cecilia", 6, 2),
  teacher("t-1", "Lind", "Anna", 12, 9),
  teacher("t-2", "Berg", "David", 3, 3),
  teacher("t-4", "Ek", "Bo", 14, 14),
];

const week = (over: Partial<ReportingRateView> = {}): ReportingRateView => ({
  period: "WEEK",
  anchor: "2026-11-04",
  from: "2026-11-02",
  to: "2026-11-08",
  yearName: null,
  previousAnchor: "2026-11-01",
  nextAnchor: "2026-11-09",
  through: "2026-11-03",
  total: { held: 40, reported: 28 },
  teachers: TEACHERS,
  ...over,
});

const SETTINGS: ReportingSettings = { teacherReminders: false, rektorDigest: false, openAfterDays: 2 };

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  settings: undefined as unknown,
  viewError: false,
  settingsError: false,
  hold: null as null | Promise<void>,
}));

const dayText = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

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
        <ReportingRatePage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state.view = week();
  state.settings = SETTINGS;
  state.viewError = false;
  state.settingsError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path === SETTINGS_PATH) {
      if (state.settingsError) throw new ApiError(500, "boom");
      return state.settings;
    }
    if (path.startsWith(`${ROOT}?`)) {
      if (state.viewError) throw new ApiError(500, "boom");
      return state.view;
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.put.mockImplementation(async (_path: string, body: Partial<ReportingSettings>) => ({
    ...(state.settings as ReportingSettings),
    ...body,
  }));
});

/** The teachers' rows, as "Efternamn, Förnamn", in the order on screen. */
const order = () =>
  within(screen.getByRole("table", { name: "Rapporteringsgrad per lärare" }))
    .getAllByRole("row")
    .slice(1)
    .map((one) => within(one).getAllByRole("cell")[0]!.textContent);

const column = (name: string) => screen.getByRole("columnheader", { name });
const reads = () => api.get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith(`${ROOT}?`));

describe("Rapporteringsgrad, the administrator's page", () => {
  it("is busy until the figures are read, then says the school's share, how far the count reaches and what counts as reported", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();

    expect(await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" })).toBeInTheDocument();
    // 28 of 40 lessons: 70 %; the open ones are held minus reported.
    expect(screen.getByText("Skolans rapporteringsgrad")).toBeInTheDocument();
    expect(screen.getByText("70 %", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("28 av 40 lektioner")).toBeInTheDocument();
    expect(screen.getByText("Öppna lektioner").nextElementSibling).toHaveTextContent("12");
    expect(screen.getByText(`Uppdaterad t.o.m. ${dayText("2026-11-03")}`)).toBeInTheDocument();
    expect(screen.getByText(/Registret är sparat när minst en elev har fått en markering/)).toBeInTheDocument();
    // The first read names no day: the gateway's school today.
    expect(reads()).toEqual([`${ROOT}?period=WEEK`]);
  });

  it("opens on the lowest share first and says so on that column alone", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });

    expect(order()).toEqual(["Holm, Eva", "Ås, Cecilia", "Lind, Anna", "Berg, David", "Ek, Bo"]);
    expect(column("Rapporteringsgrad")).toHaveAttribute("aria-sort", "ascending");
    for (const name of ["Lärare", "Hållna", "Rapporterade", "Öppna"]) {
      expect(column(name)).not.toHaveAttribute("aria-sort");
    }
  });

  it("shows each teacher's lessons held, reported and open, and the share as a percent", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });
    const [lind] = within(screen.getByRole("table")).getAllByRole("row").filter((one) => /Lind, Anna/.test(one.textContent ?? ""));
    expect(within(lind!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Lind, Anna", "12", "9", "3", "75 %"]);
    const [holm] = within(screen.getByRole("table")).getAllByRole("row").filter((one) => /Holm, Eva/.test(one.textContent ?? ""));
    expect(within(holm!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Holm, Eva", "5", "0", "5", "0 %"]);
    // 14 of 14 and 3 of 3 read 100 %.
    expect(within(screen.getByRole("table")).getAllByText("100 %", { selector: "span", exact: true })).toHaveLength(2);
  });

  it("sorts on a column by mouse and by keyboard, and turns the same column round", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });

    await user.click(within(column("Lärare")).getByRole("button", { name: "Lärare" }));
    expect(order()).toEqual(["Berg, David", "Ek, Bo", "Holm, Eva", "Lind, Anna", "Ås, Cecilia"]);
    expect(column("Lärare")).toHaveAttribute("aria-sort", "ascending");
    expect(column("Rapporteringsgrad")).not.toHaveAttribute("aria-sort");

    // The heading is a real button: Tab reaches it and Enter presses it.
    const held = within(column("Hållna")).getByRole("button", { name: "Hållna" });
    held.focus();
    await user.keyboard("{Enter}");
    expect(order()).toEqual(["Ek, Bo", "Lind, Anna", "Ås, Cecilia", "Holm, Eva", "Berg, David"]);
    expect(column("Hållna")).toHaveAttribute("aria-sort", "descending");
    await user.keyboard(" ");
    expect(order()).toEqual(["Berg, David", "Holm, Eva", "Ås, Cecilia", "Lind, Anna", "Ek, Bo"]);
    expect(column("Hållna")).toHaveAttribute("aria-sort", "ascending");

    // And a polite line says what the table is ordered by now, which aria-sort alone does not.
    expect(screen.getByText("Sorterad efter Hållna, stigande")).toBeInTheDocument();
  });

  it("keeps the sort when the period changes", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });
    await user.click(within(column("Öppna")).getByRole("button", { name: "Öppna" }));
    state.view = week({ period: "MONTH", teachers: TEACHERS.map((one) => ({ ...one, held: one.held * 4, reported: one.reported * 4 })) });

    await user.click(screen.getByRole("tab", { name: "Månad" }));

    await waitFor(() => expect(reads()).toEqual([`${ROOT}?period=WEEK`, `${ROOT}?period=MONTH`]));
    await waitFor(() => expect(screen.getByText("40")).toBeInTheDocument());
    expect(column("Öppna")).toHaveAttribute("aria-sort", "descending");
  });

  it("names the period and its dates, and pages with the days the gateway names", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });
    expect(screen.getByText(`Vecka 45 · ${dayText("2026-11-02")} – ${dayText("2026-11-08")}`)).toBeInTheDocument();
    // On the school's today there is nowhere to return to.
    expect(screen.getByRole("button", { name: "Idag" })).toBeDisabled();

    state.view = week({ anchor: "2026-11-01", from: "2026-10-26", to: "2026-11-01", previousAnchor: "2026-10-25", nextAnchor: "2026-11-02" });
    await user.click(screen.getByRole("button", { name: "Föregående vecka" }));

    await waitFor(() => expect(reads()).toEqual([`${ROOT}?period=WEEK`, `${ROOT}?period=WEEK&anchor=2026-11-01`]));
    expect(await screen.findByText(`Vecka 44 · ${dayText("2026-10-26")} – ${dayText("2026-11-01")}`)).toBeInTheDocument();

    // The next arrow goes to the day after the period; the tab keeps the day.
    state.view = week({ period: "MONTH", anchor: "2026-11-02", from: "2026-11-01", to: "2026-11-30" });
    await user.click(screen.getByRole("button", { name: "Nästa vecka" }));
    await waitFor(() => expect(reads().at(-1)).toBe(`${ROOT}?period=WEEK&anchor=2026-11-02`));

    await user.click(screen.getByRole("tab", { name: "Månad" }));
    await waitFor(() => expect(reads().at(-1)).toBe(`${ROOT}?period=MONTH&anchor=2026-11-02`));
    expect(await screen.findByText(/^november 2026 · /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Föregående månad" })).toBeInTheDocument();

    // And back to the school's today.
    await user.click(screen.getByRole("button", { name: "Idag" }));
    await waitFor(() => expect(reads().at(-1)).toBe(`${ROOT}?period=MONTH`));
  });

  it("names the läsår for the year tab", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });
    state.view = week({ period: "YEAR", from: "2026-08-17", to: "2027-06-11", yearName: "2026/27", previousAnchor: "2026-08-16", nextAnchor: "2027-06-12" });

    await user.click(screen.getByRole("tab", { name: "Läsår" }));

    expect(await screen.findByText(`Läsåret 2026/27 · ${dayText("2026-08-17")} – ${dayText("2027-06-11")}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Föregående läsår" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Nästa läsår" })).toBeEnabled();

    // The day before the läsår is in the summer, where there is no läsår: the arrow aims into last year instead.
    await user.click(screen.getByRole("button", { name: "Föregående läsår" }));
    await waitFor(() => expect(reads().at(-1)).toBe(`${ROOT}?period=YEAR&anchor=2026-01-13`));
  });

  it("says a period with no läsår as that, turns the arrows off and leaves the way back", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" });
    state.view = week({
      period: "YEAR",
      anchor: "2026-07-20",
      from: null,
      to: null,
      yearName: null,
      previousAnchor: null,
      nextAnchor: null,
      total: { held: 0, reported: 0 },
      teachers: [],
    });

    await user.click(screen.getByRole("tab", { name: "Läsår" }));

    expect(await screen.findByRole("heading", { name: "Det finns inget läsår för den här dagen" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Inget läsår")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Föregående läsår" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Nästa läsår" })).toBeDisabled();
    // A week or a month still works from the same tabs.
    expect(screen.getByRole("tab", { name: "Vecka" })).toBeEnabled();
  });

  it("says a period with no lesson held as that, with a share of nothing instead of 0 %", async () => {
    state.view = week({ total: { held: 0, reported: 0 }, teachers: [] });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Inga hållna lektioner i perioden" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Rapporteringsgrad per lärare" })).not.toBeInTheDocument();
    expect(screen.getByText("Skolans rapporteringsgrad").nextElementSibling).toHaveTextContent("Inga hållna lektioner");
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
  });

  it("says before the first night's count that no day is counted", async () => {
    state.view = week({ through: null });
    renderPage();
    expect(await screen.findByText("Ingen dag är räknad ännu. Räkningen görs varje natt.")).toBeInTheDocument();
  });

  it("says a failed read as such, never as an empty week, and offers another try and the way back", async () => {
    const user = userEvent.setup();
    state.viewError = true;
    renderPage();

    expect(await screen.findByText("Rapporteringsgraden kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Inga hållna lektioner i perioden")).not.toBeInTheDocument();
    // The settings are a read of their own: the failure does not take them away.
    expect(await screen.findByRole("switch", { name: "Påminn lärare om öppna lektioner" })).toBeInTheDocument();

    state.viewError = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" })).toBeInTheDocument();
  });

  it("says a failed settings read as such and still shows the figures", async () => {
    state.settingsError = true;
    renderPage();

    expect(await screen.findByText("Inställningarna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Rapporteringsgrad per lärare" })).toBeInTheDocument();
  });
});

describe("the switches and the limit", () => {
  const reminders = () => screen.findByRole("switch", { name: "Påminn lärare om öppna lektioner" });
  const digest = () => screen.findByRole("switch", { name: "Skicka rektor ett veckobesked" });

  it("are off, with two days, until an administrator turns them on, and say what the notices hold", async () => {
    renderPage();

    expect(await reminders()).not.toBeChecked();
    expect(await digest()).not.toBeChecked();
    expect(screen.getByText("Av. Ingen lärare påminns.")).toBeInTheDocument();
    expect(screen.getByText("Av. Rektor får inget veckobesked.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Öppen för länge efter" })).toHaveValue("2");
    expect(screen.getByText(/aldrig namn, ämne eller klass/)).toBeInTheDocument();
  });

  it("turn the reminders on with one press, save once, and show what the gateway answered", async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await reminders();

    await user.click(toggle);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(SETTINGS_PATH, { teacherReminders: true }));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Påminnelserna är på.");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText("På. En lärare påminns när en lektion hölls för minst 2 dagar sedan och registret inte är sparat.")).toBeInTheDocument();
  });

  it("turn the weekly note on and off, and change only the field pressed", async () => {
    const user = userEvent.setup();
    state.settings = { ...SETTINGS, teacherReminders: true, openAfterDays: 5 };
    renderPage();
    const toggle = await digest();

    await user.click(toggle);
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith(SETTINGS_PATH, { rektorDigest: true }));
    expect(toast.success).toHaveBeenLastCalledWith("Veckobeskedet är på.");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText(/Varje måndag får rektor förra veckans rapporteringsgrad/)).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith(SETTINGS_PATH, { rektorDigest: false }));
    expect(toast.success).toHaveBeenLastCalledWith("Veckobeskedet är av.");
  });

  it("save the limit in days when it is changed", async () => {
    const user = userEvent.setup();
    renderPage();
    const select = await screen.findByRole("combobox", { name: "Öppen för länge efter" });
    // One to thirty, as the gateway takes them.
    expect(within(select).getAllByRole("option")).toHaveLength(30);

    await user.selectOptions(select, "7");

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(SETTINGS_PATH, { openAfterDays: 7 }));
    expect(toast.success).toHaveBeenCalledWith("Gränsen är sparad.");
    await waitFor(() => expect(select).toHaveValue("7"));
  });

  it("say a refused save with the gateway's own words, and leave the switch where it was", async () => {
    const user = userEvent.setup();
    api.put.mockRejectedValueOnce(new ApiError(400, "openAfterDays: ett helt antal dagar, 1 till 30."));
    renderPage();
    const toggle = await reminders();

    await user.click(toggle);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("openAfterDays: ett helt antal dagar, 1 till 30."));
    expect(toggle).not.toBeChecked();
  });

  it("are shown and cannot be changed by a läsare, and every one of them is marked as Drift's", async () => {
    const user = userEvent.setup();
    profile.readOnly = true;
    state.settings = { ...SETTINGS, teacherReminders: true };
    renderPage();
    const toggle = await reminders();

    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(await digest()).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Öppen för länge efter" })).toBeDisabled();
    // What is shown but must take no pointer is marked, so the läsare's style rule can find it.
    const inert = document.querySelectorAll('[data-writes-inert="DRIFT"]');
    expect(inert).toHaveLength(3);
    await user.click(toggle);
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe("in English", () => {
  it("says the same, with every key found", async () => {
    renderPage("en");

    expect(await screen.findByRole("heading", { level: 1, name: "Reporting rate" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Reporting rate per teacher" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "School year" })).toBeInTheDocument();
    expect(screen.getByText("Week 45", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("70%", { selector: "dd" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Remind teachers about open lessons" })).toBeInTheDocument();
    expect(screen.getByText(/Updated through/)).toBeInTheDocument();
  });
});
