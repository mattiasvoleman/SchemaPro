import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import RoomBookingsPage from "./page";

/**
 * Lokalbokningar on the shared DecisionList: no "nothing waits" while the
 * requests load or after a failed read, and a rejection only after the
 * question has been answered.
 */

const decide = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  bookings: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock("@/lib/queries", () => ({
  useRoomBookingRequests: () => state.bookings,
  useRoomBookingActions: () => ({ decide: { mutateAsync: decide, isPending: false, variables: undefined } }),
  useRooms: () => ({ data: [{ id: "r-mu", name: "Musiksalen" }], isError: false }),
  usePeople: () => ({ data: [{ id: "t-1", firstName: "Nils", lastName: "Berg" }], isError: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BOOKING = {
  id: "b-1",
  roomId: "r-mu",
  bookedById: "t-1",
  title: "Kör",
  startsAt: "2026-10-14T12:00:00.000Z",
  endsAt: "2026-10-14T13:00:00.000Z",
  status: "PENDING",
  createdAt: "2026-10-10T08:00:00.000Z",
};

function renderPage() {
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <RoomBookingsPage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bookings = { data: [BOOKING], isLoading: false, isError: false };
});

describe("Lokalbokningar", () => {
  it("says the bookings could not be read, never that nothing waits", () => {
    state.bookings = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Bokningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga bokningar väntar på beslut")).not.toBeInTheDocument();
  });

  it("rejects only after the question, and says so", async () => {
    decide.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Avslå Musiksalen/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Avslå bokningen av Musiksalen?");
    expect(decide).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Avslå" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ id: "b-1", status: "REJECTED", note: undefined }));
    expect(toast.success).toHaveBeenCalledWith("Bokning avslagen");
  });
});
