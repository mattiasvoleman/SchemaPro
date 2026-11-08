import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import RoomBookingsPage from "./page";

/**
 * The Resurser tab is a chunk fetched when first opened. One that does not arrive is said in a toast in the
 * reader's language, never as the loader's English error, and the page goes back to Salar instead of leaving
 * the reader on a blank tab.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries", () => ({
  useRoomBookingRequests: () => ({ data: [], isLoading: false, isError: false }),
  useRoomBookingActions: () => ({ decide: { mutateAsync: vi.fn(), isPending: false, variables: undefined } }),
  useRooms: () => ({ data: [], isError: false }),
  usePeople: () => ({ data: [], isError: false }),
}));
vi.mock("./resource-requests", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/resource-requests.js");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lokalbokningar, the Resurser tab's chunk", () => {
  it("says in the reader's language that the tab could not be opened, and goes back to Salar", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <RoomBookingsPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("tab", { name: "Resurser" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Resurserna kunde inte öppnas. Inget är ändrat – försök igen."));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Salar" })).toHaveAttribute("aria-selected", "true"));
    spy.mockRestore();
  });
});
