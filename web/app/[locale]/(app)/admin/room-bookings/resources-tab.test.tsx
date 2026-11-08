import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { resourceBooking } from "@/lib/__fixtures__/local";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import RoomBookingsPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Lokalbokningar's second tab, Resurser (/admin/room-bookings): the bookings of resources in the list the
 * rooms have, through /resource-bookings. The tab is fetched when first opened, so a visit that only decides
 * rooms pays for none of it; the rooms' own behaviour is page.test.tsx's and is not repeated here.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The rooms' side is the existing page's; it is stood in for here so that only the tab is under test.
vi.mock("@/lib/queries", () => ({
  useRoomBookingRequests: () => ({ data: [], isLoading: false, isError: false }),
  useRoomBookingActions: () => ({ decide: { mutateAsync: vi.fn(), isPending: false, variables: undefined } }),
  useRooms: () => ({ data: [], isError: false }),
  usePeople: () => ({ data: [], isError: false }),
}));

const state = vi.hoisted(() => ({ bookings: undefined as unknown, error: false }));

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
        <RoomBookingsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bookings = [resourceBooking({ status: "PENDING" })];
  state.error = false;
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/resource-bookings?status=")) {
      if (state.error) throw new ApiError(500, "boom");
      const status = path.split("=")[1];
      return (state.bookings as Array<{ status: string }>).filter((booking) => booking.status === status);
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.patch.mockResolvedValue({ id: "b-1", status: "APPROVED" });
});

const openResources = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("tab", { name: "Resurser" }));

describe("Lokalbokningar, the Resurser tab", () => {
  it("opens on Salar and reads no resource booking until the tab is opened", async () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "Salar" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Resurser" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tablist", { name: "Visa" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("lists the waiting requests with the resource, the quantity, who asked and when", async () => {
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    expect(await screen.findByText(/Surfplattor klass 7 × 12/)).toBeInTheDocument();
    expect(screen.getByText("NO-lektion")).toBeInTheDocument();
    expect(screen.getByText(/Begärd av Nils Berg/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Godkänn Surfplattor klass 7/ }).closest("[data-writes]")).toHaveAttribute("data-writes", "DRIFT");
    expect(api.get).toHaveBeenCalledWith("/api/v1/resource-bookings?status=PENDING");
  });

  it("approves a request through the resource route", async () => {
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    await user.click(await screen.findByRole("button", { name: /^Godkänn Surfplattor klass 7/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-bookings/b-1/decide", { status: "APPROVED" }));
    expect(toast.success).toHaveBeenCalledWith("Bokning godkänd");
  });

  it("rejects only after the question, with the note", async () => {
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    await user.click(await screen.findByRole("button", { name: /^Avslå Surfplattor klass 7/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Avslå bokningen av Surfplattor klass 7?");
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Avslå" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-bookings/b-1/decide", { status: "REJECTED" }));
    expect(toast.success).toHaveBeenCalledWith("Bokning avslagen");
  });

  it("says a refused decision as it came", async () => {
    api.patch.mockRejectedValueOnce(new ApiError(409, "Already decided."));
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    await user.click(await screen.findByRole("button", { name: /^Godkänn Surfplattor klass 7/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already decided."));
  });

  it("lists a day of an external hire under the approved ones as such, with nobody to decide and nobody named", async () => {
    state.bookings = [
      resourceBooking({ id: "b-ext", resourceName: "Minibuss", quantity: 1, title: "Extern bokning", status: "APPROVED", external: true, bookedByName: null }),
    ];
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    await user.click(screen.getByRole("tab", { name: "Godkänd" }));
    expect(await screen.findByText(/Dag i en extern bokning/)).toBeInTheDocument();
    expect(screen.queryByText(/Begärd av/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Godkänn / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Avslå / })).not.toBeInTheDocument();
  });

  it("says nothing waits, in the tab's own words", async () => {
    state.bookings = [];
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    expect(await screen.findByRole("heading", { level: 2, name: "Inga bokningar väntar på beslut" })).toBeInTheDocument();
    expect(screen.getByText(/resurser som kräver godkännande/)).toBeInTheDocument();
  });

  it("says a failed read is a failed read, and never that nothing waits", async () => {
    state.error = true;
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    expect(await screen.findByRole("heading", { level: 2, name: "Bokningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga bokningar väntar på beslut")).not.toBeInTheDocument();
  });

  it("goes back to Salar and the filter stays when the tab is left", async () => {
    const user = userEvent.setup();
    renderPage();
    await openResources(user);
    await screen.findByText(/Surfplattor klass 7 × 12/);
    await user.click(screen.getByRole("tab", { name: "Salar" }));
    expect(screen.getByRole("tab", { name: "Väntar" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/Surfplattor klass 7 × 12/)).not.toBeInTheDocument();
  });

  it("is in English too", async () => {
    const user = userEvent.setup();
    renderPage("en");
    await user.click(screen.getByRole("tab", { name: "Resources" }));
    expect(await screen.findByText(/Requested by Nils Berg/)).toBeInTheDocument();
  });
});
