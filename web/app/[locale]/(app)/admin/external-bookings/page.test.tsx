import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { clash, day, detail, resource, series } from "@/lib/__fixtures__/local";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import ExternalBookingsPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Externa bokningar, the administrator's page (/admin/external-bookings), through the gateway's routes and the
 * real messages: a key missing from sv.json or en.json throws here instead of printing its path.
 *
 * What this guards: the list is read by state and a failed read is said as such; the band says how many days
 * now clash with a lesson and which; a series opens with its contact and its days; a day or the series is
 * cancelled only after the question; the contact can be changed and no value of it reaches a toast; and a
 * series is previewed (every day with what it meets, BLOCK and WARN apart), registered with the body the
 * DTOs take, and a refusal for clashing days (409 EXTERNAL_BOOKING_CONFLICTS) lists the days.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries", () => ({
  useRooms: () => ({
    data: [
      { id: "room-1", name: "Gymnastiksalen" },
      { id: "room-2", name: "Musiksalen" },
    ],
    isError: false,
  }),
}));

// A dialog with a form of this size draws on every key, and a host running a dozen sessions takes seconds over it.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const state = vi.hoisted(() => ({
  lists: {} as Record<string, unknown>,
  detail: undefined as unknown,
  clashes: [] as unknown[],
  resources: [] as unknown[],
  preview: undefined as unknown,
  created: { id: "s-new", created: 3, skipped: [] } as unknown,
  createError: null as unknown,
  listError: false,
  clashesError: false,
  detailError: false,
}));

const PREVIEW = {
  occurrences: [
    { date: "2099-03-02", startsAt: "2099-03-02T17:00:00.000Z", endsAt: "2099-03-02T19:00:00.000Z", conflicts: [] },
    {
      date: "2099-03-09",
      startsAt: "2099-03-09T17:00:00.000Z",
      endsAt: "2099-03-09T19:00:00.000Z",
      conflicts: [
        { kind: "LESSON", severity: "BLOCK", label: "Matematik 7A" },
        { kind: "LOAN", severity: "BLOCK", label: "ROOM_LENT" },
      ],
    },
    {
      date: "2099-03-16",
      startsAt: "2099-03-16T17:00:00.000Z",
      endsAt: "2099-03-16T19:00:00.000Z",
      conflicts: [{ kind: "ACTIVITY", severity: "WARN", label: "Temadag" }],
    },
  ],
  count: 3,
  blocked: 1,
  warned: 1,
  framesMissing: false,
};

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
        <ExternalBookingsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.lists = { active: [series()], ended: [], cancelled: [] };
  state.detail = detail();
  state.clashes = [];
  state.resources = [resource(), resource({ id: "res-2", name: "Minibuss", quantity: 2 })];
  state.preview = PREVIEW;
  state.created = { id: "s-new", created: 3, skipped: [] };
  state.createError = null;
  state.listError = false;
  state.clashesError = false;
  state.detailError = false;
  api.get.mockImplementation(async (path: string) => {
    const list = /^\/api\/v1\/external-bookings\?state=(\w+)$/.exec(path);
    if (list) {
      if (state.listError) throw new ApiError(500, "boom");
      return state.lists[list[1]!];
    }
    if (path === "/api/v1/external-bookings/clashes") {
      if (state.clashesError) throw new ApiError(500, "boom");
      return state.clashes;
    }
    if (path === "/api/v1/external-bookings/s-1") {
      if (state.detailError) throw new ApiError(500, "boom");
      return state.detail;
    }
    if (path === "/api/v1/resources") return state.resources;
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockImplementation(async (path: string) => {
    if (path === "/api/v1/external-bookings/preview") {
      if (state.preview instanceof Error) throw state.preview;
      return state.preview;
    }
    if (path === "/api/v1/external-bookings") {
      if (state.createError) throw state.createError;
      return state.created;
    }
    throw new Error(`unexpected write ${path}`);
  });
  api.patch.mockImplementation(async () => ({}));
});

const openSeries = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Öppna Idrottsföreningen, Gymnastiksalen" }));
  return screen.findByRole("dialog", { name: "Idrottsföreningen" });
};

describe("Externa bokningar, the list", () => {
  it("is busy until the list is read, then names each series with its rule in plain words and its days", async () => {
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    const table = await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    const row = within(table).getByRole("row", { name: /Idrottsföreningen/ });
    expect(row).toHaveTextContent("Innebandy");
    expect(row).toHaveTextContent("Gymnastiksalen");
    expect(row).toHaveTextContent("tisdagar 18:00–20:00, 2099-02-02–2099-06-08");
    expect(row).toHaveTextContent("17 av 18");
    expect(screen.getByRole("heading", { level: 1, name: "Externa bokningar" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/external-bookings?state=active");
  });

  it("names no contact in the table: the contact is read one series at a time", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    expect(table).not.toHaveTextContent("Kim Berg");
    expect(table).not.toHaveTextContent("kim@if.example");
    expect(table).not.toHaveTextContent("070-123 45 67");
  });

  it("says every other week, a resource's quantity and the kind of the target", async () => {
    state.lists = {
      active: [series({ target: { kind: "RESOURCE", id: "res-2", name: "Minibuss" }, resourceQuantity: 2, intervalWeeks: 2, weekdays: [1, 3], purpose: null })],
      ended: [],
      cancelled: [],
    };
    renderPage();
    const table = await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    const row = within(table).getByRole("row", { name: /Minibuss/ });
    expect(row).toHaveTextContent("Minibuss × 2");
    expect(row).toHaveTextContent("Resurs");
    expect(row).toHaveTextContent("måndagar och onsdagar 18:00–20:00, 2099-02-02–2099-06-08, varannan vecka");
  });

  it("is in English too", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "External bookings" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Active external bookings" });
    expect(within(table).getByRole("row", { name: /Idrottsföreningen/ })).toHaveTextContent("Tuesdays 18:00–20:00");
    expect(screen.getByRole("button", { name: "New external booking" })).toBeInTheDocument();
  });

  it("reads the ended and the cancelled series when asked, each with its own words for none", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    await user.click(screen.getByRole("tab", { name: "Avslutade" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Inga avslutade externa bokningar" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/external-bookings?state=ended");
    await user.click(screen.getByRole("tab", { name: "Avbokade" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Inga avbokade externa bokningar" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/external-bookings?state=cancelled");
  });

  it("says there are no active series when there are none, and where to start", async () => {
    state.lists = { active: [], ended: [], cancelled: [] };
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Inga aktiva externa bokningar" })).toBeInTheDocument();
    expect(screen.getByText(/Registrera en serie med Ny extern bokning/)).toBeInTheDocument();
  });

  it("says a failed read is a failed read, and never that there are none", async () => {
    state.listError = true;
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "De externa bokningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inga aktiva externa bokningar" })).not.toBeInTheDocument();
  });

  it("marks the button that registers as Drift's, so the läsare is shown none", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    expect(screen.getByRole("button", { name: "Ny extern bokning" }).closest("[data-writes]")).toHaveAttribute("data-writes", "DRIFT");
  });
});

describe("Externa bokningar, the band of clashes", () => {
  it("says nothing when no day clashes", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Aktiva externa bokningar" });
    expect(screen.queryByText(/krockar med/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Dagar som krockar med lektioner" })).not.toBeInTheDocument();
  });

  it("counts the days that clash with lessons and lists each with the lesson it clashes with", async () => {
    state.clashes = [clash(), clash({ dayId: "d-5", date: "2099-02-16", lesson: "Engelska 8B" })];
    state.lists = { active: [series({ clashes: 2 })], ended: [], cancelled: [] };
    renderPage();
    expect(await screen.findByText("2 dagar krockar med lektioner")).toBeInTheDocument();
    const list = within(screen.getByRole("region", { name: "Dagar som krockar med lektioner" }));
    const items = list.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Idrottsföreningen, Gymnastiksalen");
    expect(items[0]).toHaveTextContent("9 feb. 2099");
    expect(items[0]).toHaveTextContent("18:00–20:00");
    expect(items[0]).toHaveTextContent("lektion Matematik 7A");
    expect(items[1]).toHaveTextContent("lektion Engelska 8B");
    // The series' own row carries the same count.
    expect(await screen.findByText("2 dagar krockar")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/external-bookings/clashes");
  });

  it("says one day in the singular", async () => {
    state.clashes = [clash()];
    renderPage();
    expect(await screen.findByText("1 dag krockar med en lektion")).toBeInTheDocument();
  });

  it("opens the series of a clashing day", async () => {
    state.clashes = [clash()];
    const user = userEvent.setup();
    renderPage();
    const list = within(await screen.findByRole("region", { name: "Dagar som krockar med lektioner" }));
    await user.click(list.getByRole("button", { name: "Öppna Idrottsföreningen, Gymnastiksalen" }));
    expect(await screen.findByRole("dialog", { name: "Idrottsföreningen" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/v1/external-bookings/s-1");
  });

  it("says the clashes could not be checked, and the list below stands", async () => {
    state.clashesError = true;
    renderPage();
    expect(await screen.findByText("Krockarna kunde inte kontrolleras")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Aktiva externa bokningar" })).toBeInTheDocument();
  });
});

describe("Externa bokningar, one series", () => {
  it("shows who it is for, what it is and its days with what each meets", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    expect(await dialog.findByText("Kim Berg")).toBeInTheDocument();
    expect(dialog.getByText("070-123 45 67")).toBeInTheDocument();
    expect(dialog.getByText("kim@if.example")).toBeInTheDocument();
    expect(dialog.getByText("Innebandy")).toBeInTheDocument();
    expect(dialog.getByText(/Gymnastiksalen\. tisdagar 18:00–20:00/)).toBeInTheDocument();
    expect(dialog.getByText(/Registrerad .*2099 av Anna Lind/)).toBeInTheDocument();
    expect(dialog.getByText("17 kommande av 18, 1 avbokade")).toBeInTheDocument();

    const days = within(dialog.getByRole("table", { name: "Dagarna i serien" }));
    const clashing = days.getByRole("row", { name: /9 feb/ });
    expect(clashing).toHaveTextContent("Krockar");
    expect(clashing).toHaveTextContent("Lektion: Matematik 7A");
    expect(days.getByRole("row", { name: /2 feb/ })).toHaveTextContent("Bokad");
    expect(days.getByRole("row", { name: /16 feb/ })).toHaveTextContent("Avbokad");
  });

  it("offers to cancel a day only where one can still be cancelled", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await dialog.findByText("Kim Berg");
    expect(dialog.getAllByRole("button", { name: /^Avboka .* 2099$/ })).toHaveLength(2);
    // The cancelled day and the day that has passed have none.
    const days = within(dialog.getByRole("table", { name: "Dagarna i serien" }));
    expect(within(days.getByRole("row", { name: /16 feb/ })).queryByRole("button")).not.toBeInTheDocument();
    expect(within(days.getByRole("row", { name: /7 jan/ })).queryByRole("button")).not.toBeInTheDocument();
  });

  it("cancels one day after the question, and only that day", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: /^Avboka .*9 feb/ }));
    const confirm = await screen.findByRole("dialog", { name: /^Avboka .*9 feb.*\?$/ });
    expect(confirm).toHaveTextContent("Bara den dagen avbokas.");
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Avboka" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/external-bookings/s-1/days/d-2/cancel", {}));
    expect(toast.success).toHaveBeenCalledWith("Dagen är avbokad");
  });

  it("cancels the series after the question, which says how many days go", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Avboka serien" }));
    const confirm = await screen.findByRole("dialog", { name: "Avboka serien för Idrottsföreningen?" });
    expect(confirm).toHaveTextContent("De 17 kommande dagarna avbokas.");
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Avboka serien" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/external-bookings/s-1/cancel", {}));
    expect(toast.success).toHaveBeenCalledWith("Serien är avbokad");
  });

  it("says a refused cancellation as it came and keeps the series", async () => {
    api.patch.mockRejectedValueOnce(new ApiError(500, "boom"));
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Avboka serien" }));
    await user.click(within(await screen.findByRole("dialog", { name: /Avboka serien för/ })).getByRole("button", { name: "Avboka serien" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("offers no cancellation of a series that is cancelled, and says it is", async () => {
    state.detail = detail({ cancelledAt: "2099-01-20T09:00:00.000Z", days: { total: 18, upcoming: 0, cancelled: 18, skipped: [] }, occurrences: [day({ status: "CANCELLED" })] });
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    expect(await dialog.findByText("Serien är avbokad")).toBeInTheDocument();
    expect(dialog.getByText(/Den avbokades 20 jan\. 2099/)).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Avboka serien" })).not.toBeInTheDocument();
  });

  it("lists the days left out at registration", async () => {
    state.detail = detail({ days: { total: 16, upcoming: 16, cancelled: 0, skipped: ["2099-02-09", "2099-02-23"] } });
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    expect(await dialog.findByText(/2 dagar hoppades över vid registreringen:/)).toBeInTheDocument();
    expect(dialog.getByText("2099-02-09, 2099-02-23")).toBeInTheDocument();
  });

  it("says a failed read of the series is that, and offers nothing to cancel", async () => {
    state.detailError = true;
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Öppna Idrottsföreningen, Gymnastiksalen" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Extern bokning" }));
    expect(await dialog.findByText("Serien kunde inte hämtas")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Avboka serien" })).not.toBeInTheDocument();
  });

  it("changes who it is for, from what is there, and says nothing of the contact in the toast", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Ändra kontaktuppgifter" }));
    const phone = dialog.getByRole("textbox", { name: "Telefon" });
    expect(phone).toHaveValue("070-123 45 67");
    expect(dialog.getByRole("textbox", { name: "Organisation" })).toHaveValue("Idrottsföreningen");
    await user.clear(phone);
    await user.type(phone, "08-123 456");
    await user.clear(dialog.getByRole("textbox", { name: "E-post" }));
    await user.click(dialog.getByRole("button", { name: "Spara" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/external-bookings/s-1", {
        organisation: "Idrottsföreningen",
        contactName: "Kim Berg",
        contactPhone: "08-123 456",
        contactEmail: null,
        purpose: "Innebandy",
        note: null,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Uppgifterna är sparade");
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toMatch(/Kim|08-123|070|kim@/);
  });

  it("refuses a change that leaves no way to reach the contact, naming both fields", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Ändra kontaktuppgifter" }));
    await user.clear(dialog.getByRole("textbox", { name: "Telefon" }));
    await user.clear(dialog.getByRole("textbox", { name: "E-post" }));
    await user.click(dialog.getByRole("button", { name: "Spara" }));
    expect(dialog.getAllByText("Ange ett telefonnummer eller en e-postadress, eller båda.")).toHaveLength(2);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("goes back to reading when the change is called off, with nothing sent", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Ändra kontaktuppgifter" }));
    await user.click(dialog.getByRole("button", { name: "Avbryt" }));
    expect(dialog.getByRole("button", { name: "Ändra kontaktuppgifter" })).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("says a refused change as it came and keeps the form", async () => {
    api.patch.mockRejectedValueOnce(new ApiError(400, "contactEmail must be an email"));
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await user.click(await dialog.findByRole("button", { name: "Ändra kontaktuppgifter" }));
    await user.click(dialog.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("contactEmail must be an email"));
    expect(dialog.getByRole("textbox", { name: "Telefon" })).toBeInTheDocument();
  });

  it("closes", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = within(await openSeries(user));
    await dialog.findByText("Kim Berg");
    // The footer's button and the corner's cross are both called Stäng.
    await user.click(dialog.getAllByRole("button", { name: "Stäng" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

/** Types a day into a DateField, which takes yyyy-mm-dd typed in full. */
const setDay = (name: string, iso: string) => fireEvent.change(screen.getByRole("textbox", { name }), { target: { value: iso } });

/** Fills the rule: a room, Tuesdays, 2 March to 16 March 2099, the usual evening. */
async function fillRule(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByRole("combobox", { name: "Sal" }), "room-1");
  await user.click(screen.getByRole("checkbox", { name: "Tis" }));
  setDay("Första dagen", "2099-03-02");
  setDay("Sista dagen", "2099-03-16");
}

async function fillContact(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Organisation" }), "Idrottsföreningen");
  await user.type(screen.getByRole("textbox", { name: "Kontaktperson" }), "Kim Berg");
  await user.type(screen.getByRole("textbox", { name: "E-post" }), "kim@if.example");
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Ny extern bokning" }));
  return within(await screen.findByRole("dialog", { name: "Ny extern bokning" }));
}

describe("Externa bokningar, a new series", () => {
  it("opens with every field labelled and the usual evening filled in", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    for (const name of ["Sal", "Första dagen", "Sista dagen", "Från klockan", "Till klockan", "Organisation", "Kontaktperson", "Telefon", "E-post"]) {
      expect(dialog.getByLabelText(new RegExp(`^${name}`))).toBeInTheDocument();
    }
    expect(dialog.getByLabelText("Från klockan")).toHaveValue("18:00");
    expect(dialog.getByLabelText("Till klockan")).toHaveValue("20:00");
    expect(dialog.getByRole("checkbox", { name: "Varannan vecka" })).not.toBeChecked();
    expect(dialog.getByRole("checkbox", { name: /Hoppa över dagar som krockar/ })).not.toBeChecked();
    expect(dialog.getByRole("group", { name: "Veckodagar" })).toBeInTheDocument();
  });

  it("refuses a preview of a rule that is not one, naming each field, and asks the gateway nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    expect(dialog.getByText("Fyll i det här fältet.")).toBeInTheDocument();
    expect(dialog.getByText("Välj minst en veckodag.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    setDay("Första dagen", "2099-03-02");
    setDay("Sista dagen", "2099-03-01");
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    expect(dialog.getByText("Sista dagen kan inte vara före första dagen.")).toBeInTheDocument();
  });

  it("previews the days with what each meets, BLOCK and WARN apart, in words and not in colour alone", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/external-bookings/preview", {
        target: "ROOM",
        roomId: "room-1",
        weekdays: [2],
        intervalWeeks: 1,
        startDate: "2099-03-02",
        endDate: "2099-03-16",
        startTime: "18:00",
        endTime: "20:00",
      }),
    );
    expect(await dialog.findByText("3 dagar: 1 krockar, 1 med varning.")).toBeInTheDocument();
    const table = within(dialog.getByRole("table", { name: "Dagarna i serien" }));
    expect(table.getByRole("row", { name: /2 mars/ })).toHaveTextContent("Ledig");
    const blocked = table.getByRole("row", { name: /9 mars/ });
    expect(blocked).toHaveTextContent("Krockar");
    // A label is data and shown as it is; the loan's code is turned into a sentence.
    expect(blocked).toHaveTextContent("Lektion: Matematik 7A");
    expect(blocked).toHaveTextContent("Lån: utlånad till en annan skola då");
    expect(blocked).not.toHaveTextContent("ROOM_LENT");
    const warned = table.getByRole("row", { name: /16 mars/ });
    expect(warned).toHaveTextContent("Varning");
    expect(warned).toHaveTextContent("Aktivitet: Temadag (varning)");
  });

  it("announces the preview where it arrives", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    const live = dialog.getByText("Visar varje dag och vad den möter, utan att boka något.").closest("div")!.parentElement!.querySelector("[aria-live]");
    expect(live).not.toBeNull();
    expect(live).toBeEmptyDOMElement();
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() => expect(live).toHaveTextContent("3 dagar"));
  });

  it("says when the school has no ramtider, so that FRAME was not asked", async () => {
    state.preview = { ...PREVIEW, framesMissing: true };
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    expect(await dialog.findByText(/inte lagt in några ramtider/)).toBeInTheDocument();
  });

  it("writes a quantity of 28 of 30 as a sentence and a closure's reason as it is", async () => {
    state.preview = {
      ...PREVIEW,
      occurrences: [
        { date: "2099-03-02", startsAt: "", endsAt: "", conflicts: [{ kind: "BOOKING", severity: "BLOCK", label: "28 av 30" }] },
        { date: "2099-03-09", startsAt: "", endsAt: "", conflicts: [{ kind: "CLOSED", severity: "BLOCK", label: "Renovering" }, { kind: "FRAME", severity: "BLOCK", label: "08:00-16:00" }] },
      ],
      count: 2,
      blocked: 2,
      warned: 0,
    };
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    const table = within(await dialog.findByRole("table", { name: "Dagarna i serien" }));
    expect(table.getByRole("row", { name: /2 mars/ })).toHaveTextContent("Bokning: 28 av 30 upptagna");
    expect(table.getByRole("row", { name: /9 mars/ })).toHaveTextContent("Stängd: Renovering");
    expect(table.getByRole("row", { name: /9 mars/ })).toHaveTextContent("Ramtid: 08:00-16:00");
  });

  it("says a failed preview as it came, and shows no days", async () => {
    state.preview = new ApiError(500, "boom");
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
    expect(dialog.queryByRole("table")).not.toBeInTheDocument();
  });

  it("registers with the rule and who it is for, the days that clash refused whole unless skipping is chosen", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    // Who it is for is asked as well, and the field that says so is named.
    expect(dialog.getAllByText("Fyll i det här fältet.").length).toBeGreaterThanOrEqual(2);
    expect(api.post).not.toHaveBeenCalled();

    await fillContact(user);
    await user.type(dialog.getByRole("textbox", { name: /Syfte/ }), "Innebandy");
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/v1/external-bookings", {
        target: "ROOM",
        roomId: "room-1",
        weekdays: [2],
        intervalWeeks: 1,
        startDate: "2099-03-02",
        endDate: "2099-03-16",
        startTime: "18:00",
        endTime: "20:00",
        organisation: "Idrottsföreningen",
        contactName: "Kim Berg",
        contactPhone: null,
        contactEmail: "kim@if.example",
        purpose: "Innebandy",
        note: null,
        skipConflicts: false,
      }),
    );
    expect(await dialog.findByText("Serien är registrerad")).toBeInTheDocument();
    expect(dialog.getByText("3 dagar är bokade.")).toBeInTheDocument();
    // The toast outlives the dialog: it says that it is done and nothing of who it is for.
    expect(toast.success).toHaveBeenCalledWith("Den externa bokningen är registrerad");
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toMatch(/Kim|kim@|Idrott/);
  });

  it("registers every other week with the days that clash skipped, and lists the days that were left out", async () => {
    state.created = {
      id: "s-new",
      created: 1,
      skipped: [
        { date: "2099-03-09", conflicts: [{ kind: "LESSON", severity: "BLOCK", label: "Matematik 7A" }] },
        { date: "2099-03-16", conflicts: [{ kind: "BOOKING", severity: "BLOCK", label: "Körövning" }] },
      ],
    };
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    await user.click(dialog.getByRole("checkbox", { name: "Varannan vecka" }));
    await user.click(dialog.getByRole("checkbox", { name: /Hoppa över dagar som krockar/ }));
    await user.click(dialog.getByRole("button", { name: "Registrera" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/v1/external-bookings", expect.objectContaining({ intervalWeeks: 2, skipConflicts: true })));
    expect(await dialog.findByText("1 dag är bokad.")).toBeInTheDocument();
    expect(dialog.getByText("2 dagar hoppades över eftersom något annat redan håller dem.")).toBeInTheDocument();
    const left = within(dialog.getByRole("table", { name: "Dagar som hoppades över" }));
    expect(left.getByRole("row", { name: /9 mars/ })).toHaveTextContent("Lektion: Matematik 7A");
    expect(left.getByRole("row", { name: /16 mars/ })).toHaveTextContent("Bokning: Körövning");
  });

  it("lists the days a refused registration met when the gateway answers EXTERNAL_BOOKING_CONFLICTS, and books nothing", async () => {
    state.createError = new ApiError(409, "Några dagar går inte att boka.", "EXTERNAL_BOOKING_CONFLICTS");
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    await user.click(dialog.getByRole("button", { name: "Registrera" }));

    // The gateway's answer carries the code and not the days (the filter forwards no list), so the days are asked again.
    const refused = within(await dialog.findByRole("alert"));
    expect(refused.getByText("Serien registrerades inte")).toBeInTheDocument();
    expect(refused.getByText(/1 dag går inte att boka\. Ingen dag har bokats\. Kryssa i Hoppa över dagar som krockar/)).toBeInTheDocument();
    const list = within(refused.getByRole("table", { name: "Dagar som inte går att boka" }));
    expect(list.getByRole("row", { name: /9 mars/ })).toHaveTextContent("Lektion: Matematik 7A");
    expect(list.queryByRole("row", { name: /2 mars/ })).not.toBeInTheDocument();
    expect(api.post.mock.calls.map(([path]) => path)).toEqual(["/api/v1/external-bookings", "/api/v1/external-bookings/preview"]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(dialog.queryByText("Serien är registrerad")).not.toBeInTheDocument();
  });

  it("clears the refusal when the form changes, since it was about the form it was given", async () => {
    state.createError = new ApiError(409, "x", "EXTERNAL_BOOKING_CONFLICTS");
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("checkbox", { name: /Hoppa över dagar som krockar/ }));
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the days could not be named when the preview that explains a refusal fails too", async () => {
    state.createError = new ApiError(409, "x", "EXTERNAL_BOOKING_CONFLICTS");
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    state.preview = new ApiError(500, "boom");
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    expect(await dialog.findByText(/vilka kunde inte hämtas/)).toBeInTheDocument();
    expect(dialog.queryByRole("table", { name: "Dagar som inte går att boka" })).not.toBeInTheDocument();
  });

  it("says something else took the time when the refusal is no longer about any day the preview sees", async () => {
    state.createError = new ApiError(409, "x", "EXTERNAL_BOOKING_CONFLICTS");
    state.preview = { ...PREVIEW, occurrences: [PREVIEW.occurrences[0]], count: 1, blocked: 0, warned: 0 };
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    expect(await dialog.findByText(/Något annat bokade tiden medan serien registrerades/)).toBeInTheDocument();
  });

  it("says any other refusal as it came, without the contact", async () => {
    state.createError = new ApiError(400, "organisation must be shorter than or equal to 120 characters");
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await fillContact(user);
    await user.click(dialog.getByRole("button", { name: "Registrera" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("organisation must be shorter than or equal to 120 characters"));
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("registers a resource with its quantity, chosen from the resources the school has", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await user.selectOptions(dialog.getByRole("combobox", { name: "Gäller" }), "RESOURCE");
    await user.selectOptions(await dialog.findByRole("combobox", { name: "Resurs" }), "res-2");
    const quantity = dialog.getByRole("spinbutton", { name: "Antal" });
    expect(dialog.getByText("Av 2 som finns")).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, "0");
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    expect(dialog.getByText("Ange ett heltal från 1 till 1000.")).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, "2");
    await user.click(dialog.getByRole("checkbox", { name: "Tis" }));
    setDay("Första dagen", "2099-03-02");
    setDay("Sista dagen", "2099-03-16");
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/external-bookings/preview",
        expect.objectContaining({ target: "RESOURCE", resourceId: "res-2", resourceQuantity: 2, weekdays: [2] }),
      ),
    );
    expect(api.post.mock.calls[0]![1]).not.toHaveProperty("roomId");
  });

  it("does not keep a preview for a rule that has since changed", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await fillRule(user);
    await user.click(dialog.getByRole("button", { name: "Förhandsgranska" }));
    await dialog.findByRole("table", { name: "Dagarna i serien" });
    await user.click(dialog.getByRole("checkbox", { name: "Ons" }));
    expect(dialog.queryByRole("table", { name: "Dagarna i serien" })).not.toBeInTheDocument();
  });

  it("closes on Avbryt without sending anything", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openNew(user);
    await user.click(dialog.getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("is in English too", async () => {
    const user = userEvent.setup();
    renderPage("en");
    await user.click(await screen.findByRole("button", { name: "New external booking" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New external booking" }));
    expect(dialog.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(dialog.getByRole("checkbox", { name: /Skip days that clash/ })).toBeInTheDocument();
  });
});
