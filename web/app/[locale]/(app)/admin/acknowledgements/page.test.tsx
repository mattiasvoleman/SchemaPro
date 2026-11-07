import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AckSettings, AckUsage } from "@/lib/ack";
import { PUPILS, SETTINGS_OFF, SETTINGS_ON, detail, listItem, page, usage } from "@/lib/__fixtures__/ack";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import AcknowledgementsPage from "./page";

/**
 * Kvittens, the administrator's page (/admin/acknowledgements), through the
 * gateway's routes and the real Swedish messages: a key missing from sv.json
 * throws here instead of printing its path.
 *
 * What this guards: a failed read is said as such and never "nothing here"; the
 * switch and the days save as they turn and show what the gateway answered; a
 * school with Kvittens off offers no request and says so; the läsare changes
 * nothing and makes no request but reads the list and every request; and the
 * administrator's list is every request of the school; the day's use of the
 * limits is the school's, the reader's own share and the senders, in numbers and
 * in words, and a failed read of it is said as such. The requests, the form and
 * the detail are the teacher's too, and are tested on the teacher's page.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BASE = "/api/v1/acknowledgements";

const state = vi.hoisted(() => ({
  settings: undefined as unknown,
  list: [] as unknown[],
  pupils: [] as unknown[],
  detail: undefined as unknown,
  usage: undefined as unknown,
  settingsError: false,
  listError: false,
  usageError: false,
  hold: null as null | Promise<void>,
}));

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
        <AcknowledgementsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state.settings = SETTINGS_ON;
  state.list = [listItem()];
  state.pupils = PUPILS;
  state.detail = detail();
  state.usage = usage();
  state.settingsError = false;
  state.listError = false;
  state.usageError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path === `${BASE}/settings`) {
      if (state.settingsError) throw new ApiError(500, "boom");
      return state.settings;
    }
    if (path === `${BASE}/usage`) {
      if (state.usageError) throw new ApiError(500, "boom");
      return state.usage;
    }
    if (path === BASE) {
      if (state.listError) throw new ApiError(500, "boom");
      return page(state.list);
    }
    if (path === `${BASE}/pupils`) return state.pupils;
    if (path === `${BASE}/r-1`) return state.detail;
    throw new Error(`unexpected read ${path}`);
  });
  api.put.mockImplementation(async (_path: string, body: Partial<AckSettings>) => ({ ...(state.settings as AckSettings), ...body }));
  api.post.mockResolvedValue({ id: "r-new", pupils: 1, guardians: 2, withoutGuardian: [] });
});

const kvittensSwitch = () => screen.findByRole("switch", { name: "Kvittens" });

describe("Kvittens, the administrator's page", () => {
  it("is busy until the setting is read, then says Kvittens is on and what it lets staff do", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();

    const toggle = await kvittensSwitch();
    expect(toggle).toBeChecked();
    expect(screen.getByText("På. Personal kan be vårdnadshavare bekräfta meddelanden.")).toBeInTheDocument();
    expect(screen.getByText(/Vårdnadshavarna får en notis, och den som bad ser vem som har bekräftat och när/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Kvittens" })).toBeInTheDocument();
    expect(screen.getByText("Alla förfrågningar på skolan, de nyaste först.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Be om kvittens" })).toBeInTheDocument();
  });

  it("reads the setting once for the card and the list together", async () => {
    renderPage();
    await kvittensSwitch();
    await screen.findByRole("button", { name: "Be om kvittens" });

    expect(api.get.mock.calls.filter(([path]) => path === `${BASE}/settings`)).toHaveLength(1);
  });

  it("is off by default: says so, offers no request, and keeps the earlier requests", async () => {
    state.settings = SETTINGS_OFF;
    renderPage();

    const toggle = await kvittensSwitch();
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(
        "Av. Ingen kan be om kvittens, men tidigare förfrågningar finns kvar. Påminnelser som ska gå medan kvittens är av skickas inte, inte heller när du slår på den igen.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("Kvittens är av")).toBeInTheDocument();
    expect(screen.getByText(/Slå på kvittens ovan för att personal ska kunna be om kvittens/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Be om kvittens" })).not.toBeInTheDocument();
  });

  it("says a failed setting as such, and still shows the requests it can read", async () => {
    state.settingsError = true;
    renderPage();

    expect(await screen.findByText("Inställningarna för kvittens kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Kvittens" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
  });

  it("says a failed list as such, and still shows the switch", async () => {
    state.listError = true;
    renderPage();

    expect(await screen.findByText("Förfrågningarna kunde inte hämtas")).toBeInTheDocument();
    expect(await kvittensSwitch()).toBeInTheDocument();
  });

  it("turns Kvittens on with a press, saves it once, and then offers the request", async () => {
    const user = userEvent.setup();
    state.settings = SETTINGS_OFF;
    renderPage();
    const toggle = await kvittensSwitch();
    expect(screen.queryByRole("button", { name: "Be om kvittens" })).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`${BASE}/settings`, { enabled: true }));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Kvittens är på.");
    await waitFor(() => expect(toggle).toBeChecked());
    expect(await screen.findByRole("button", { name: "Be om kvittens" })).toBeInTheDocument();
    expect(screen.queryByText("Kvittens är av")).not.toBeInTheDocument();
  });

  it("says a refused save in a toast and leaves the switch where it was", async () => {
    const user = userEvent.setup();
    api.put.mockRejectedValueOnce(new ApiError(403, "Not allowed."));
    renderPage();
    const toggle = await kvittensSwitch();

    await user.click(toggle);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed."));
    expect(toggle).toBeChecked();
  });

  it("shows the days before the reminder and saves another choice, naming only it", async () => {
    const user = userEvent.setup();
    renderPage();
    await kvittensSwitch();
    const days = screen.getByLabelText("Påminnelse");
    expect(days).toHaveValue("2");
    expect(screen.getByRole("option", { name: "Efter 2 dygn" })).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /^Efter \d+ dygn$/ })).toHaveLength(30);

    await user.selectOptions(days, "5");
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith(`${BASE}/settings`, { remindAfterDays: 5 }));
    expect(toast.success).toHaveBeenCalledWith("Påminnelsen är sparad.");

    await user.selectOptions(screen.getByLabelText("Påminnelse"), "none");
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith(`${BASE}/settings`, { remindAfterDays: null }));
    await waitFor(() => expect(screen.getByLabelText("Påminnelse")).toHaveValue("none"));
    expect(screen.getByRole("option", { name: "Ingen påminnelse" })).toBeInTheDocument();
  });

  it("says that every guardian who has not confirmed is reminded once, also when another guardian of the pupil has, from the requests sent after the save", async () => {
    renderPage();
    await kvittensSwitch();

    expect(
      screen.getByText(
        "Varje vårdnadshavare som inte själv har bekräftat påminns en gång, också när en annan vårdnadshavare till eleven har bekräftat. Ändringen gäller förfrågningar som skickas efter att du har sparat.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a school with no reminder as that", async () => {
    state.settings = { enabled: true, remindAfterDays: null };
    renderPage();
    await kvittensSwitch();

    expect(screen.getByLabelText("Påminnelse")).toHaveValue("none");
  });

  it("marks the controls a writer has for the Drift area, which the läsare's style rule shuts", async () => {
    renderPage();
    const toggle = await kvittensSwitch();

    expect(toggle.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "DRIFT");
    expect(screen.getByLabelText("Påminnelse").closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "DRIFT");
    expect(await screen.findByRole("button", { name: "Be om kvittens" })).toHaveAttribute("data-writes", "DRIFT");
  });

  it("asks about every pupil of the school, which the gateway hands an administrator", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Be om kvittens" }));

    expect(await screen.findByRole("checkbox", { name: /Dan Dal/ })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`${BASE}/pupils`);
  });

  it("says there are no pupils to ask about when the school has none", async () => {
    const user = userEvent.setup();
    state.pupils = [];
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Be om kvittens" }));

    expect(await screen.findByText("Det finns inga elever att fråga om")).toBeInTheDocument();
  });

  describe("for a läsare (Läsbehörighet)", () => {
    beforeEach(() => {
      profile.readOnly = true;
    });

    it("sees the switch and the days as they are and changes none, and is offered no request", async () => {
      renderPage();
      const toggle = await kvittensSwitch();

      expect(toggle).toBeChecked();
      expect(toggle).toBeDisabled();
      expect(screen.getByLabelText("Påminnelse")).toBeDisabled();
      expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Be om kvittens" })).not.toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
    });

    it("reads a request with who confirmed it", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));

      expect(await screen.findByText("Ada Berg")).toBeInTheDocument();
      expect(screen.getByText("Sara Berg").closest("li")).toHaveTextContent("Bekräftade");
    });

    it("is not offered the stop of a reminder, whatever the gateway says of the right", async () => {
      const user = userEvent.setup();
      state.detail = detail({ mayStopReminder: true });
      renderPage();
      await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));

      expect(await screen.findByText("Ada Berg")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stoppa påminnelsen" })).not.toBeInTheDocument();
    });
  });

  it("offers an administrator the stop of a reminder the gateway says may be stopped, and stops it", async () => {
    const user = userEvent.setup();
    state.detail = detail({ mayStopReminder: true });
    api.post.mockResolvedValue({ reminder: "STOPPED" });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));

    await user.click(await screen.findByRole("button", { name: "Stoppa påminnelsen" }));
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stoppa" }));

    expect(await screen.findByText("Påminnelsen är stoppad.")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith(`${BASE}/r-1/stop-reminder`);
  });

  describe("the day's use of the limits", () => {
    /** The page writes a space before a unit and in a thousand as a no-break space; a test reads them as spaces. */
    const plain = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
    const card = async () => screen.findByRole("region", { name: "Dygnets förbrukning" });

    it("says what the school and the reader have used, and who has used most, in numbers", async () => {
      renderPage();
      const region = await card();
      await within(region).findByText("Skolan");

      // The school's 6 340 of 20 000 is 31 %, rounded down; the reader's own share is an administrator's 8 000.
      expect(plain(within(region).getByText("Skolan").nextElementSibling!.textContent)).toBe("6 340 av 20 000 (31 %)");
      expect(plain(within(region).getByText("Din andel").nextElementSibling!.textContent)).toBe("3 000 av 8 000 (37 %)");
      expect(within(region).getByRole("heading", { level: 3, name: "De som skickat mest" })).toBeInTheDocument();
      const table = within(region).getByRole("table", { name: "De som har begärt flest kvittenser det senaste dygnet" });
      const rows = within(table).getAllByRole("row").slice(1);
      // The gateway's order: the largest first.
      expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => plain(cell.textContent)))).toEqual([
        ["Rektor Rut", "3 000 av 8 000 (37 %)"],
        ["Bo Berg", "1 840 av 2 000 (92 %)Nära gränsen"],
        ["Anna Lind", "1 500 av 2 000 (75 %)Nära gränsen"],
      ]);
      expect(within(table).getAllByRole("columnheader").map((head) => head.textContent)).toEqual(["Avsändare", "Använt av andelen"]);
    });

    it("is a section with a heading of its own, in order under the page's, and reads the use once", async () => {
      renderPage();
      const region = await card();
      expect(within(region).getByRole("heading", { level: 2, name: "Dygnets förbrukning" })).toBeInTheDocument();
      await within(region).findByText("Skolan");
      expect(api.get.mock.calls.filter(([path]) => path === `${BASE}/usage`)).toHaveLength(1);
    });

    it("leaves the bar to the eye: hidden from assistive tech, with the numbers and the words as the reading", async () => {
      renderPage();
      const region = await card();
      await within(region).findByText("Skolan");

      const bars = region.querySelectorAll('[aria-hidden="true"]');
      expect(bars.length).toBeGreaterThanOrEqual(2);
      for (const bar of bars) expect(bar.textContent).toBe("");
      expect(region.querySelector('[role="meter"], [role="progressbar"], progress, meter')).toBeNull();
    });

    it("says nothing about the limit while there is room, and 'close to' from three quarters of it", async () => {
      state.usage = usage({ school: { used: 14999, limit: 20000 }, mine: { used: 5999, limit: 8000 }, senders: [] });
      renderPage();
      const region = await card();
      await within(region).findByText("Skolan");
      expect(within(region).queryByText("Nära gränsen")).not.toBeInTheDocument();
      expect(plain(within(region).getByText("Skolan").nextElementSibling!.textContent)).toBe("14 999 av 20 000 (74 %)");
    });

    it("says 'close to the limit' in words for the school and for the reader's share at three quarters", async () => {
      state.usage = usage({ school: { used: 15000, limit: 20000 }, mine: { used: 6000, limit: 8000 }, senders: [] });
      renderPage();
      const region = await card();
      await within(region).findByText("Skolan");
      expect(within(region).getAllByText("Nära gränsen")).toHaveLength(2);
      expect(within(region).queryByText(/Gränsen är nådd/)).not.toBeInTheDocument();
    });

    it("says what it means when the school's day is used up, and when the reader's share is", async () => {
      state.usage = usage({ school: { used: 20000, limit: 20000 }, mine: { used: 8000, limit: 8000 }, senders: [{ name: "Rektor Rut", used: 8000, limit: 8000 }] });
      renderPage();
      const region = await card();
      await within(region).findByText("Skolan");

      expect(within(region).getByText("Gränsen är nådd: fler kan inte skickas förrän äldre rader passerat ett dygn")).toBeInTheDocument();
      expect(within(region).getByText("Din andel är nådd: du kan inte skicka fler förrän äldre rader passerat ett dygn")).toBeInTheDocument();
      // 20 000 of 20 000 is all of it, and says so; a share of 99.6 % would be 99.
      expect(plain(within(region).getByText("Skolan").nextElementSibling!.textContent)).toBe("20 000 av 20 000 (100 %)");
      expect(within(region).getByText("Gränsen är nådd")).toBeInTheDocument();
    });

    it("says that nobody has asked for anything in the last day, and shows no empty table", async () => {
      state.usage = usage({ school: { used: 0, limit: 20000 }, mine: { used: 0, limit: 8000 }, senders: [] });
      renderPage();
      const region = await card();

      expect(await within(region).findByText("Ingen har bett om kvittens det senaste dygnet.")).toBeInTheDocument();
      expect(within(region).queryByRole("table")).not.toBeInTheDocument();
      expect(plain(within(region).getByText("Skolan").nextElementSibling!.textContent)).toBe("0 av 20 000 (0 %)");
    });

    it("shows a teacher's answer (no school, no senders) as the reader's share alone", async () => {
      const mine: AckUsage = { school: null, mine: { used: 40, limit: 2000 }, senders: null };
      state.usage = mine;
      renderPage();
      const region = await card();

      expect(plain((await within(region).findByText("Din andel")).nextElementSibling!.textContent)).toBe("40 av 2 000 (2 %)");
      expect(within(region).queryByText("Skolan")).not.toBeInTheDocument();
      expect(within(region).queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    });

    it("is busy until the use is read", async () => {
      let release!: () => void;
      state.hold = new Promise<void>((resolve) => (release = resolve));
      renderPage();
      const region = await card();
      expect(region.querySelector('[aria-busy="true"]')).not.toBeNull();
      release();
      await within(region).findByText("Skolan");
      expect(region.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it("says a failed read as such and never as an empty day, while the switch and the requests still show", async () => {
      state.usageError = true;
      renderPage();
      const region = await card();

      expect(await within(region).findByText("Förbrukningen kunde inte hämtas")).toBeInTheDocument();
      expect(within(region).getByText("Inget har ändrats. Ladda om sidan om en stund.")).toBeInTheDocument();
      expect(within(region).queryByText(/Ingen har bett om kvittens/)).not.toBeInTheDocument();
      expect(within(region).queryByText("Skolan")).not.toBeInTheDocument();
      expect(await kvittensSwitch()).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    });

    it("is read for the page whether Kvittens is on or off: the day's rows count either way", async () => {
      state.settings = SETTINGS_OFF;
      renderPage();
      const region = await card();
      expect(await within(region).findByText("Skolan")).toBeInTheDocument();
    });

    it("speaks English too", async () => {
      renderPage("en");
      const region = await screen.findByRole("region", { name: "The day's use" });
      expect(plain((await within(region).findByText("The school")).nextElementSibling!.textContent)).toBe("6,340 of 20,000 (31%)");
      expect(within(region).getByText("Your share")).toBeInTheDocument();
      expect(within(region).getByRole("table", { name: "Who has asked for the most acknowledgements in the last 24 hours" })).toBeInTheDocument();
      expect(within(region).getAllByText("Close to the limit")).toHaveLength(2);
    });
  });

  it("speaks English too", async () => {
    renderPage("en");

    expect(await screen.findByRole("switch", { name: "Acknowledgements" })).toBeChecked();
    expect(screen.getByRole("heading", { level: 1, name: "Acknowledgements" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "After 1 day" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "After 2 days" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No reminder" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Ask for acknowledgement" })).toBeInTheDocument();
  });
});
