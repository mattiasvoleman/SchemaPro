import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AckSettings } from "@/lib/ack";
import { PUPILS, SETTINGS_OFF, SETTINGS_ON, detail, listItem } from "@/lib/__fixtures__/ack";
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
 * administrator's list is every request of the school. The requests, the form
 * and the detail are the teacher's too, and are tested on the teacher's page.
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
  settingsError: false,
  listError: false,
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
  state.settingsError = false;
  state.listError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path === `${BASE}/settings`) {
      if (state.settingsError) throw new ApiError(500, "boom");
      return state.settings;
    }
    if (path === BASE) {
      if (state.listError) throw new ApiError(500, "boom");
      return state.list;
    }
    if (path === `${BASE}/pupils`) return state.pupils;
    if (path === `${BASE}/r-1`) return detail();
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
    expect(screen.getByText("Av. Ingen kan be om kvittens, men tidigare förfrågningar finns kvar.")).toBeInTheDocument();
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
