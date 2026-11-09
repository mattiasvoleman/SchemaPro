import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { available, resourceBooking } from "@/lib/__fixtures__/local";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import TeacherResourcesPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Boka resurs, the teacher's page (/teacher/resources), through the gateway's routes and the real messages.
 *
 * What this guards: the figures of what is free are the gateway's (/resources/availability) and the page only
 * draws them and refuses a quantity above them; a failed read is said as such and never "nothing free"; a
 * resource that needs Drift's yes is requested and not booked, and what the toast says is what the gateway
 * answered; a refusal because somebody was quicker is said in the reader's language; and a booking can be
 * cancelled after the question while it waits or stands and is not over.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = vi.hoisted(() => ({
  free: undefined as unknown,
  mine: undefined as unknown,
  freeError: false,
  mineError: false,
  posted: { id: "b-new", status: "APPROVED" } as { id: string; status: string },
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
        <TeacherResourcesPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const availabilityCalls = () => api.get.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/v1/resources/availability"));

beforeEach(() => {
  vi.clearAllMocks();
  state.free = [available(), available({ id: "r-2", name: "Minibuss", resourceTypeName: "Fordon", quantity: 1, free: 1, place: null, requiresApproval: true })];
  state.mine = [resourceBooking()];
  state.freeError = false;
  state.mineError = false;
  state.posted = { id: "b-new", status: "APPROVED" };
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/resources/availability")) {
      if (state.freeError) throw new ApiError(500, "boom");
      return state.free;
    }
    if (path === "/api/v1/resource-bookings?mine=true") {
      if (state.mineError) throw new ApiError(500, "boom");
      return state.mine;
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockImplementation(async () => state.posted);
  api.patch.mockResolvedValue({ id: "b-1", status: "CANCELLED" });
});

describe("Boka resurs, the teacher's page", () => {
  it("is busy until the lists are read, then says how many of each are free for the window and where it is kept", async () => {
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    const free = within(await screen.findByRole("region", { name: "Resurser för denna tid" }));
    expect(await free.findByText("Surfplattor klass 7")).toBeInTheDocument();
    expect(free.getByText("24 av 30 lediga")).toBeInTheDocument();
    expect(free.getByText("Skåp 3 i B-huset")).toBeInTheDocument();
    expect(free.getByText("1 av 1 lediga")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Boka resurs" })).toBeInTheDocument();
  });

  it("asks the gateway what is free for the window, from today at 09:00 to 10:00 unless changed, and again when it moves", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Boka Surfplattor klass 7" });
    expect(availabilityCalls()).toHaveLength(1);
    expect(availabilityCalls()[0]).toMatch(/^\/api\/v1\/resources\/availability\?from=\d{4}-\d{2}-\d{2}T09%3A00%3A00\.000Z&to=\d{4}-\d{2}-\d{2}T10%3A00%3A00\.000Z$/);

    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "11:30" } });
    await waitFor(() => expect(availabilityCalls()).toHaveLength(2));
    expect(availabilityCalls()[1]).toMatch(/T11%3A30%3A00\.000Z$/);
  });

  it("is in English too", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "Book resource" })).toBeInTheDocument();
    expect(await screen.findByText("24 of 30 free")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request Minibuss" })).toBeInTheDocument();
  });

  it("books one with the window, the quantity and a title of the teacher's own, and clears the title", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByRole("textbox", { name: "Syfte" }), "  NO-lektion ");
    const quantity = screen.getByRole("spinbutton", { name: "Antal" });
    await user.clear(quantity);
    await user.type(quantity, "12");
    await user.click(await screen.findByRole("button", { name: "Boka Surfplattor klass 7" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, body] = api.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/v1/resource-bookings");
    expect(body).toMatchObject({ resourceId: "r-1", title: "NO-lektion", quantity: 12 });
    expect(String(body.startsAt)).toMatch(/T09:00:00\.000Z$/);
    expect(String(body.endsAt)).toMatch(/T10:00:00\.000Z$/);
    expect(toast.success).toHaveBeenCalledWith("Resurs bokad");
    expect(screen.getByRole("textbox", { name: "Syfte" })).toHaveValue("");
  });

  it("names the booking by default when no title is given", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Boka Surfplattor klass 7" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/v1/resource-bookings", expect.objectContaining({ title: "Resursbokning", quantity: 1 })));
  });

  it("requests a resource that needs Drift's yes, and says what the gateway answered", async () => {
    state.posted = { id: "b-new", status: "PENDING" };
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Kräver godkännande")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Begär Minibuss" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Bokning begärd — väntar på godkännande"));
    expect(screen.queryByRole("button", { name: "Boka Minibuss" })).not.toBeInTheDocument();
  });

  it("says it is booked when the gateway approved a resource that asks for approval, as it does for an administrator", async () => {
    state.posted = { id: "b-new", status: "APPROVED" };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Begär Minibuss" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Resurs bokad"));
    expect(toast.success).not.toHaveBeenCalledWith("Bokning begärd — väntar på godkännande");
  });

  it("says in the reader's language that somebody was quicker, and shows what is free now", async () => {
    api.post.mockRejectedValueOnce(new ApiError(409, "The quantity is held."));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Boka Surfplattor klass 7" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Någon hann före: så många lediga finns inte längre. Listan är uppdaterad."));
    // The list is read again, whatever the answer was.
    await waitFor(() => expect(availabilityCalls().length).toBeGreaterThanOrEqual(2));
  });

  it("says another refusal as it came", async () => {
    api.post.mockRejectedValueOnce(new ApiError(400, "title must be shorter"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Boka Surfplattor klass 7" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("title must be shorter"));
  });

  it("will not book more than are free, and says how many are wanted", async () => {
    const user = userEvent.setup();
    renderPage();
    const quantity = await screen.findByRole("spinbutton", { name: "Antal" });
    await user.clear(quantity);
    await user.type(quantity, "2");
    expect(await screen.findByRole("button", { name: "Boka Surfplattor klass 7" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Begär Minibuss" })).toBeDisabled();
    expect(screen.getByText(/1 av 1 lediga · du vill ha 2/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Begär Minibuss" }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a quantity that is not a whole number from 1, before anything is booked", async () => {
    const user = userEvent.setup();
    renderPage();
    const quantity = await screen.findByRole("spinbutton", { name: "Antal" });
    await user.clear(quantity);
    await user.type(quantity, "0");
    expect(await screen.findByRole("alert")).toHaveTextContent("Antalet måste vara ett heltal från 1 till 1000.");
    expect(quantity).toBeInvalid();
    expect(screen.getByRole("button", { name: "Boka Surfplattor klass 7" })).toBeDisabled();
  });

  it("asks for nothing and says why when the end is not after the start", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Boka Surfplattor klass 7" });
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "08:00" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Sluttiden måste vara efter starttiden.");
    expect(screen.getByText("Lediga resurser visas när sluttiden är efter starttiden.")).toBeInTheDocument();
    expect(availabilityCalls()).toHaveLength(1);
  });

  it("says a failed read of what is free is a failed read, and not that nothing is free", async () => {
    state.freeError = true;
    renderPage();
    expect(await screen.findByText("Resurserna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Skolan har inga resurser registrerade ännu.")).not.toBeInTheDocument();
  });

  it("says the school has no resources when it has none", async () => {
    state.free = [];
    state.mine = [];
    renderPage();
    expect(await screen.findByText("Skolan har inga resurser registrerade ännu.")).toBeInTheDocument();
    expect(await screen.findByText("Du har inga resursbokningar ännu.")).toBeInTheDocument();
  });

  it("says a failed read of the reader's bookings is that, and not that there are none", async () => {
    state.mineError = true;
    renderPage();
    expect(await screen.findByText("Dina bokningar kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Du har inga resursbokningar ännu.")).not.toBeInTheDocument();
    // The free list is a read of its own and still stands.
    expect(await screen.findByText("Surfplattor klass 7")).toBeInTheDocument();
  });

  it("lists the reader's bookings with their state and the administrator's note, and lets a standing or waiting one be cancelled", async () => {
    state.mine = [
      resourceBooking(),
      resourceBooking({ id: "b-2", resourceName: "Minibuss", quantity: 1, status: "PENDING", title: "Utflykt" }),
      resourceBooking({ id: "b-3", resourceName: "Aulan", quantity: 1, status: "REJECTED", decisionNote: "Aulan är upptagen" }),
      resourceBooking({ id: "b-4", resourceName: "Gammal", status: "APPROVED", startsAt: "2020-03-02T08:00:00.000Z", endsAt: "2020-03-02T09:00:00.000Z" }),
    ];
    renderPage();
    const mine = within(await screen.findByRole("region", { name: "Mina resursbokningar" }));
    expect(await mine.findByText("Väntar")).toBeInTheDocument();
    expect(mine.getAllByText("Godkänd")).toHaveLength(2);
    expect(mine.getByText("Avslagen")).toBeInTheDocument();
    expect(mine.getByText("Anteckning: Aulan är upptagen")).toBeInTheDocument();
    expect(mine.getAllByText("× 12")).toHaveLength(2);
    expect(mine.getAllByRole("button", { name: /^Avboka / })).toHaveLength(2);
    expect(mine.queryByRole("button", { name: /Avboka Aulan/ })).not.toBeInTheDocument();
    expect(mine.queryByRole("button", { name: /Avboka Gammal/ })).not.toBeInTheDocument();
  });

  it("cancels only after the question", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Avboka Surfplattor klass 7/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/^Avboka Surfplattor klass 7,/);
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Avboka" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-bookings/b-1/cancel", {}));
    expect(toast.success).toHaveBeenCalledWith("Bokning avbokad");
  });

  it("says a refused cancellation as it came, and keeps the question's answer out of the way", async () => {
    api.patch.mockRejectedValueOnce(new ApiError(400, "Too late."));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Avboka Surfplattor klass 7/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Avboka" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Too late."));
  });
});
