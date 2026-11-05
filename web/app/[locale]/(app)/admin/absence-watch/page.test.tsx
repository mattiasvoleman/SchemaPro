import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AbsenceWatchFinding, AbsenceWatchLimit, AbsenceWatchOverview } from "@/lib/absence-watch";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import AbsenceWatchPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Frånvarobevakning, the administrator's page (/admin/absence-watch), through
 * the gateway's routes and the real Swedish messages: a key missing from sv.json
 * throws here instead of printing its path.
 *
 * What this guards: a failed read is said as such and never "nothing here"; the
 * switch and the cadences save as they turn; the limit form offers the figures
 * of the kind and refuses nothing silently (a figure out of bounds is named, a
 * second limit of the same group, kind and basis is the gateway's 409 said in
 * the dialog); removing a limit asks first; the läsare changes nothing; and the
 * findings are figures and dates, never a reason.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OVERVIEW = "/api/v1/absence-watch";
const FINDINGS = "/api/v1/absence-watch/findings";

const SHARE_INVALID: AbsenceWatchLimit = {
  id: "11111111-1111-4111-8111-111111111111",
  recipientGroup: "MENTOR",
  kind: "SHARE",
  basis: "INVALID",
  percent: 10,
  windowDays: 14,
  consecutiveDays: null,
};
const RUN_ALL: AbsenceWatchLimit = {
  id: "22222222-2222-4222-8222-222222222222",
  recipientGroup: "GUARDIAN",
  kind: "CONSECUTIVE",
  basis: "ALL",
  percent: null,
  windowDays: null,
  consecutiveDays: 5,
};

const overview = (over: Partial<AbsenceWatchOverview["settings"]> = {}, limits: AbsenceWatchLimit[] = [SHARE_INVALID, RUN_ALL]): AbsenceWatchOverview => ({
  settings: {
    enabled: false,
    enabledOn: null,
    cadence: { MENTOR: "WEEKLY", REKTOR: "WEEKLY", KANSLI: "WEEKLY", GUARDIAN: "MONTHLY" },
    ...over,
  },
  limits,
});

const finding = (over: Partial<AbsenceWatchFinding> = {}): AbsenceWatchFinding => ({
  id: "f-1",
  studentId: "p-ada",
  studentName: "Ada Berg",
  className: "7A",
  recipientGroup: "MENTOR",
  kind: "SHARE",
  basis: "INVALID",
  percent: 10,
  windowDays: 14,
  consecutiveDays: null,
  firstCrossedOn: "2026-10-28",
  lastSeenOn: "2026-11-04",
  clearedOn: null,
  absentMinutes: 240,
  recordedMinutes: 1200,
  streakDays: null,
  ...over,
});

const state = vi.hoisted(() => ({
  overview: undefined as unknown,
  findings: { findings: [], truncated: false } as unknown,
  overviewError: false,
  findingsError: false,
  hold: null as null | Promise<void>,
}));

const dayText = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("sv", { day: "numeric", month: "short", year: "numeric" });

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
        <AbsenceWatchPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state.overview = overview();
  state.findings = { findings: [], truncated: false };
  state.overviewError = false;
  state.findingsError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path === OVERVIEW) {
      if (state.overviewError) throw new ApiError(500, "boom");
      return state.overview;
    }
    if (path === FINDINGS || path === `${FINDINGS}?recent=1`) {
      if (state.findingsError) throw new ApiError(500, "boom");
      return state.findings;
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.put.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    const current = state.overview as AbsenceWatchOverview;
    return { ...current, settings: { ...current.settings, ...(body["enabled"] !== undefined ? { enabled: body["enabled"] } : {}) } };
  });
  api.post.mockResolvedValue({ ...SHARE_INVALID, id: "33333333-3333-4333-8333-333333333333" });
  api.delete.mockResolvedValue(undefined);
});

const watchSwitch = () => screen.findByRole("switch", { name: "Frånvarobevakning" });
const openDialog = (name: string) => screen.findByRole("dialog", { name });

describe("Frånvarobevakning, the administrator's page", () => {
  it("is busy until the overview is read, then says the watch is off and what the summaries hold", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();

    const toggle = await watchSwitch();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Av. Inga elever räknas och inga sammanställningar skickas.")).toBeInTheDocument();
    // Off by default, counts only, never a name or a reason in the e-mail.
    expect(screen.getByText(/avstängd tills du slår på den/)).toBeInTheDocument();
    expect(screen.getByText(/aldrig namn eller anledning/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(OVERVIEW);
  });

  it("says a failed overview as such, and still shows the findings it can read", async () => {
    state.overviewError = true;
    state.findings = { findings: [finding()], truncated: false };
    renderPage();

    expect(await screen.findByText("Frånvarobevakningen kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Frånvarobevakning" })).not.toBeInTheDocument();
    expect(await screen.findByText("Ada Berg")).toBeInTheDocument();
  });

  it("turns the watch on with a press, saves it once, and shows what the gateway answered", async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await watchSwitch();

    await user.click(toggle);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${OVERVIEW}/settings`, { enabled: true }));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Frånvarobevakningen är på.");
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("says since when the watch has been on, and warns when it is on with no limit to count", async () => {
    state.overview = overview({ enabled: true, enabledOn: "2026-10-12" }, []);
    renderPage();

    expect(await screen.findByText(`På sedan ${dayText("2026-10-12")}. Eleverna räknas varje natt.`)).toBeInTheDocument();
    expect(screen.getByText("Inga gränser är satta")).toBeInTheDocument();
    expect(screen.getByText("Inga gränser ännu")).toBeInTheDocument();
  });

  it("says a refused save in a toast and leaves the switch where it was", async () => {
    const user = userEvent.setup();
    api.put.mockRejectedValueOnce(new ApiError(403, "Not allowed."));
    renderPage();
    const toggle = await watchSwitch();

    await user.click(toggle);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed."));
    expect(toggle).not.toBeChecked();
  });

  it("saves a group's cadence as it is chosen, naming only that group", async () => {
    const user = userEvent.setup();
    renderPage();
    await watchSwitch();

    await user.selectOptions(screen.getByLabelText("Vårdnadshavare"), "WEEKLY");

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${OVERVIEW}/settings`, { guardianCadence: "WEEKLY" }));
    expect(toast.success).toHaveBeenCalledWith("Sparat för Vårdnadshavare.");
    // The other three groups keep what they had.
    expect(screen.getByLabelText("Mentor")).toHaveValue("WEEKLY");
  });

  it("lists the limits by group in words, with the group, the kind and the basis each says", async () => {
    state.overview = overview({}, [RUN_ALL, SHARE_INVALID]);
    renderPage();

    const table = await screen.findByRole("table", { name: "Skolans gränser för frånvaro" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // Mentor before Vårdnadshavare, whatever order the gateway answered in.
    expect(rows[0]).toHaveTextContent("Mentor");
    expect(rows[0]).toHaveTextContent("10 % ogiltig frånvaro av de registrerade minuterna över 14 dagar");
    expect(rows[1]).toHaveTextContent("Vårdnadshavare");
    expect(rows[1]).toHaveTextContent("5 skoldagar i följd med all frånvaro");
  });

  it("speaks English too", async () => {
    renderPage("en");
    expect(await screen.findByRole("switch", { name: "Absence watch" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "The school's limits for absence" });
    expect(within(table).getByText("10% unexcused absence of the registered minutes over 14 days")).toBeInTheDocument();
    expect(within(table).getByText("5 school days in a row with all absence")).toBeInTheDocument();
  });

  describe("adding a limit", () => {
    it("offers a percent and a number of days for a share, tells what it will say, and sends exactly those", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Lägg till gräns" }));
      const dialog = await openDialog("Lägg till gräns");

      await user.selectOptions(within(dialog).getByLabelText("Mottagare"), "REKTOR");
      await user.selectOptions(within(dialog).getByLabelText("Vilken frånvaro som räknas"), "VALID");
      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "20");
      await user.type(within(dialog).getByLabelText("Antal dagar att räkna över"), "30");
      expect(within(dialog).queryByLabelText("Antal skoldagar i följd")).not.toBeInTheDocument();
      expect(
        within(dialog).getByText("Rektor får veta när en elev har 20 % giltig frånvaro av de registrerade minuterna över 30 dagar."),
      ).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(`${OVERVIEW}/limits`, {
          recipientGroup: "REKTOR",
          kind: "SHARE",
          basis: "VALID",
          percent: 20,
          windowDays: 30,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Gränsen är tillagd.");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // The overview is read again, so the table shows what the gateway now holds.
      await waitFor(() => expect(api.get.mock.calls.filter(([path]) => path === OVERVIEW).length).toBeGreaterThan(1));
    });

    it("offers the days in a row for a run, and sends no percent and no window with them", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Lägg till gräns" }));
      const dialog = await openDialog("Lägg till gräns");

      await user.selectOptions(within(dialog).getByLabelText("Slag av gräns"), "CONSECUTIVE");
      expect(within(dialog).queryByLabelText("Andel av de registrerade minuterna (%)")).not.toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Antal dagar att räkna över")).not.toBeInTheDocument();
      await user.type(within(dialog).getByLabelText("Antal skoldagar i följd"), "7");
      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(`${OVERVIEW}/limits`, {
          recipientGroup: "MENTOR",
          kind: "CONSECUTIVE",
          basis: "ALL",
          consecutiveDays: 7,
        }),
      );
    });

    it("names a figure that is missing or out of bounds and sends nothing until every figure fits", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Lägg till gräns" }));
      const dialog = await openDialog("Lägg till gräns");

      await user.click(within(dialog).getByRole("button", { name: "Spara" }));
      expect(within(dialog).getByText("Ange ett heltal från 1 till 100.")).toBeInTheDocument();
      expect(within(dialog).getByText("Ange ett heltal från 7 till 60.")).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();

      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "101");
      await user.type(within(dialog).getByLabelText("Antal dagar att räkna över"), "6");
      await user.click(within(dialog).getByRole("button", { name: "Spara" }));
      expect(api.post).not.toHaveBeenCalled();
      expect(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)")).toBeInvalid();

      await user.clear(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"));
      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "100");
      await user.clear(within(dialog).getByLabelText("Antal dagar att räkna över"));
      await user.type(within(dialog).getByLabelText("Antal dagar att räkna över"), "60");
      await user.click(within(dialog).getByRole("button", { name: "Spara" }));
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    });

    it("says the gateway's 409 in the dialog, keeps the dialog open and the figures typed", async () => {
      const user = userEvent.setup();
      api.post.mockRejectedValueOnce(new ApiError(409, "The school already has a limit.", "ABSENCE_WATCH_LIMIT_EXISTS"));
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Lägg till gräns" }));
      const dialog = await openDialog("Lägg till gräns");
      await user.selectOptions(within(dialog).getByLabelText("Vilken frånvaro som räknas"), "INVALID");
      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "15");
      await user.type(within(dialog).getByLabelText("Antal dagar att räkna över"), "14");

      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      expect(
        await within(dialog).findByText(
          "Det finns redan en gräns för Mentor med det slaget och den grunden. Ändra den som finns i stället.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Lägg till gräns" })).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)")).toHaveValue(15);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("says any other refusal as the gateway worded it", async () => {
      const user = userEvent.setup();
      api.post.mockRejectedValueOnce(new ApiError(400, "A share limit has a percent and a number of days.", "ABSENCE_WATCH_FIGURES"));
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Lägg till gräns" }));
      const dialog = await openDialog("Lägg till gräns");
      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "15");
      await user.type(within(dialog).getByLabelText("Antal dagar att räkna över"), "14");

      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      expect(await within(dialog).findByText("A share limit has a percent and a number of days.")).toBeInTheDocument();
      expect(within(dialog).getByText("Gränsen kunde inte sparas")).toBeInTheDocument();
    });
  });

  describe("changing and removing a limit", () => {
    it("changes only the figures: the group, kind and basis are shown fixed, and the body carries no others", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: /^Redigera Mentor/ }));
      const dialog = await openDialog("Ändra gräns");

      expect(within(dialog).getByLabelText("Mottagare")).toBeDisabled();
      expect(within(dialog).getByLabelText("Slag av gräns")).toBeDisabled();
      expect(within(dialog).getByLabelText("Vilken frånvaro som räknas")).toBeDisabled();
      expect(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)")).toHaveValue(10);

      await user.clear(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"));
      await user.type(within(dialog).getByLabelText("Andel av de registrerade minuterna (%)"), "15");
      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${OVERVIEW}/limits/${SHARE_INVALID.id}`, { percent: 15, windowDays: 14 }));
      expect(toast.success).toHaveBeenCalledWith("Gränsen är ändrad.");
    });

    it("changes the days of a run with the days alone", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: /^Redigera Vårdnadshavare/ }));
      const dialog = await openDialog("Ändra gräns");

      await user.clear(within(dialog).getByLabelText("Antal skoldagar i följd"));
      await user.type(within(dialog).getByLabelText("Antal skoldagar i följd"), "3");
      await user.click(within(dialog).getByRole("button", { name: "Spara" }));

      await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${OVERVIEW}/limits/${RUN_ALL.id}`, { consecutiveDays: 3 }));
    });

    it("asks before removing, says what happens to the pupils who passed it, and removes that limit only", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: /^Ta bort Mentor/ }));
      const dialog = await openDialog("Ta bort gränsen för Mentor?");

      expect(dialog).toHaveTextContent("10 % ogiltig frånvaro av de registrerade minuterna över 14 dagar");
      expect(dialog).toHaveTextContent("räknas som under gränsen från i dag");
      expect(api.delete).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));

      await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${OVERVIEW}/limits/${SHARE_INVALID.id}`));
      expect(toast.success).toHaveBeenCalledWith("Gränsen är borttagen.");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("removes nothing when the question is answered no", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: /^Ta bort Vårdnadshavare/ }));
      const dialog = await openDialog("Ta bort gränsen för Vårdnadshavare?");

      await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.delete).not.toHaveBeenCalled();
    });

    it("says a refused removal and keeps the limit in the list", async () => {
      const user = userEvent.setup();
      api.delete.mockRejectedValueOnce(new ApiError(404, "No such limit."));
      renderPage();
      await user.click(await screen.findByRole("button", { name: /^Ta bort Mentor/ }));
      const dialog = await openDialog("Ta bort gränsen för Mentor?");

      await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No such limit."));
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe("for a läsare (Läsbehörighet)", () => {
    it("reads the switch, the cadences and the limits and changes none of them", async () => {
      profile.readOnly = true;
      state.overview = overview({ enabled: true, enabledOn: "2026-10-12" });
      renderPage();

      const toggle = await watchSwitch();
      expect(toggle).toBeChecked();
      expect(toggle).toBeDisabled();
      for (const group of ["Mentor", "Rektor", "Kansli", "Vårdnadshavare"]) {
        expect(screen.getByLabelText(group)).toBeDisabled();
      }
      const table = screen.getByRole("table", { name: "Skolans gränser för frånvaro" });
      expect(within(table).getByText("Mentor")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Lägg till gräns" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Redigera/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Ta bort/ })).not.toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
    });

    it("marks every control a writer has for the Drift area, which the läsare's style rule hides", async () => {
      renderPage();
      await screen.findByRole("button", { name: "Lägg till gräns" });
      for (const name of ["Lägg till gräns", /^Redigera Mentor/, /^Ta bort Mentor/]) {
        expect(screen.getByRole("button", { name }).closest('[data-writes="DRIFT"]')).not.toBeNull();
      }
    });
  });

  describe("the findings", () => {
    it("shows the figures and since when, for a share and for a run, and nothing about a reason", async () => {
      state.findings = {
        findings: [
          { ...finding(), reason: "Sjuk", absenceType: "SICK", note: "Vård av barn" },
          finding({
            id: "f-2",
            studentId: "p-bo",
            studentName: "Bo Ek",
            className: "8B",
            recipientGroup: "GUARDIAN",
            kind: "CONSECUTIVE",
            basis: "ALL",
            percent: null,
            windowDays: null,
            consecutiveDays: 5,
            absentMinutes: null,
            recordedMinutes: null,
            streakDays: 6,
            firstCrossedOn: "2026-11-02",
            lastSeenOn: "2026-11-04",
          }),
        ],
        truncated: false,
      };
      renderPage();

      const table = await screen.findByRole("table", { name: "Elever som har passerat en gräns för frånvaro" });
      const [ada, bo] = within(table).getAllByRole("row").slice(1);
      expect(ada).toHaveTextContent("Ada Berg");
      expect(ada).toHaveTextContent("7A");
      expect(ada).toHaveTextContent("Mentor");
      expect(ada).toHaveTextContent("10 % ogiltig frånvaro av de registrerade minuterna över 14 dagar");
      expect(ada).toHaveTextContent(/240 av 1\s200 minuter \(20 %\)/);
      expect(ada).toHaveTextContent(`Över gränsen sedan ${dayText("2026-10-28")}`);
      expect(ada).toHaveTextContent(`Mätt ${dayText("2026-11-04")}`);
      expect(bo).toHaveTextContent("Bo Ek");
      expect(bo).toHaveTextContent("Vårdnadshavare");
      expect(bo).toHaveTextContent("6 skoldagar i följd");
      expect(bo).toHaveTextContent(`Över gränsen sedan ${dayText("2026-11-02")}`);
      expect(screen.getByText("2 elever är över en gräns.")).toBeInTheDocument();
      // A reason is not a thing this list can say, whatever a row carries beyond what the contract names.
      const list = screen.getByRole("region", { name: "Elever som har passerat en gräns" });
      expect(list).not.toHaveTextContent(/sjuk|orsak|anledning|vård av barn|giltigt skäl|SICK/i);
      expect(api.get).toHaveBeenCalledWith(FINDINGS);
    });

    it("rounds the share to a whole percent and says only minutes when nothing was registered", async () => {
      state.findings = {
        findings: [
          finding({ absentMinutes: 100, recordedMinutes: 900 }),
          finding({ id: "f-2", studentId: "p-bo", studentName: "Bo Ek", absentMinutes: 90, recordedMinutes: 0 }),
        ],
        truncated: false,
      };
      renderPage();

      expect(await screen.findByText("100 av 900 minuter (11 %)")).toBeInTheDocument();
      expect(screen.getByText("90 minuter")).toBeInTheDocument();
    });

    it("reads the recent ones too when asked, lists those under the limit again after the others, and says since when", async () => {
      const user = userEvent.setup();
      state.findings = { findings: [finding()], truncated: false };
      renderPage();
      await screen.findByText("Ada Berg");
      state.findings = {
        findings: [
          finding({ id: "f-old", studentId: "p-cy", studentName: "Cy Dahl", clearedOn: "2026-11-03", firstCrossedOn: "2026-10-30" }),
          finding(),
        ],
        truncated: false,
      };

      await user.click(screen.getByRole("switch", { name: "Visa även de som kommit under gränsen" }));

      await waitFor(() => expect(api.get).toHaveBeenCalledWith(`${FINDINGS}?recent=1`));
      const table = await screen.findByRole("table", { name: "Elever som har passerat en gräns för frånvaro" });
      await within(table).findByText("Cy Dahl");
      const [first, second] = within(table).getAllByRole("row").slice(1);
      expect(first).toHaveTextContent("Ada Berg");
      expect(second).toHaveTextContent("Cy Dahl");
      expect(second).toHaveTextContent(`Under gränsen sedan ${dayText("2026-11-03")}`);
      expect(second).toHaveTextContent(`Var över gränsen sedan ${dayText("2026-10-30")}`);
      expect(screen.getByText(/1 har kommit under gränsen igen\./)).toBeInTheDocument();
    });

    it("filters by recipient group on the page, without asking again", async () => {
      const user = userEvent.setup();
      state.findings = {
        findings: [finding(), finding({ id: "f-2", studentId: "p-bo", studentName: "Bo Ek", recipientGroup: "KANSLI" })],
        truncated: false,
      };
      renderPage();
      await screen.findByText("Bo Ek");
      const reads = api.get.mock.calls.length;

      await user.selectOptions(screen.getByLabelText("Mottagare", { selector: "#absence-watch-group" }), "KANSLI");

      expect(screen.queryByText("Ada Berg")).not.toBeInTheDocument();
      expect(screen.getByText("Bo Ek")).toBeInTheDocument();
      expect(api.get.mock.calls.length).toBe(reads);

      await user.selectOptions(screen.getByLabelText("Mottagare", { selector: "#absence-watch-group" }), "REKTOR");
      expect(screen.getByText("Ingen i den här mottagargruppen")).toBeInTheDocument();
    });

    it("never prints a name it was not given: the pupil's row may be closed to the reader", async () => {
      state.findings = { findings: [finding({ studentName: null, className: null })], truncated: false };
      renderPage();

      const table = await screen.findByRole("table", { name: "Elever som har passerat en gräns för frånvaro" });
      expect(within(table).getByText("Namnet kan inte visas")).toBeInTheDocument();
      expect(table).not.toHaveTextContent("null");
    });

    it("says nobody has passed a limit when the watch is on, and that it is off when it is off", async () => {
      state.overview = overview({ enabled: true });
      const { unmount } = renderPage();
      expect(await screen.findByText("Ingen elev har passerat en gräns")).toBeInTheDocument();
      unmount();

      state.overview = overview({ enabled: false });
      renderPage();
      expect(await screen.findByText("Bevakningen är avstängd")).toBeInTheDocument();
      expect(screen.queryByText("Ingen elev har passerat en gräns")).not.toBeInTheDocument();
    });

    it("says the list is cut short when the gateway left the oldest out", async () => {
      state.findings = { findings: [finding()], truncated: true };
      renderPage();

      expect(await screen.findByText("Listan är avkortad")).toBeInTheDocument();
      expect(screen.getByText(/Fler än 2\s000 fynd stämde/)).toBeInTheDocument();
    });

    it("says a failed read of the findings as such, never as an empty list, and leaves the settings alone", async () => {
      state.findingsError = true;
      renderPage();

      expect(await screen.findByText("Listan kunde inte hämtas")).toBeInTheDocument();
      expect(screen.queryByText("Ingen elev har passerat en gräns")).not.toBeInTheDocument();
      expect(await watchSwitch()).toBeInTheDocument();
    });
  });
});
