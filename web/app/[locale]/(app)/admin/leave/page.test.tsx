import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import LeaveRequestsPage from "./page";

/**
 * Ledighetsansökningar on the shared DecisionList: a read that failed is
 * said as such (never "nothing waits"), and an approval still says how many
 * absence days it wrote.
 */

const decide = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  leaves: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock("@/lib/guardian-queries", () => ({
  useLeaveRequests: () => state.leaves,
  useLeaveRequestActions: () => ({ decide: { mutateAsync: decide, isPending: false, variables: undefined } }),
}));
vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "p-ada", firstName: "Ada", lastName: "Berg" },
      { id: "p-gun", firstName: "Gun", lastName: "Berg" },
    ],
    isError: false,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const LEAVE = {
  id: "l-1",
  studentId: "p-ada",
  requestedById: "p-gun",
  startDate: "2026-10-19",
  endDate: "2026-10-21",
  reason: "Resa till mormor",
  status: "PENDING",
  createdAt: "2026-10-10T08:00:00.000Z",
};

function renderPage() {
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <LeaveRequestsPage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.leaves = { data: [LEAVE], isLoading: false, isError: false };
});

describe("Ledighetsansökningar", () => {
  it("says the requests could not be read, never that nothing waits", () => {
    state.leaves = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Ansökningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga ansökningar väntar på beslut")).not.toBeInTheDocument();
  });

  it("shows nothing as empty while the requests load", () => {
    state.leaves = { data: undefined, isLoading: true, isError: false };
    renderPage();
    expect(screen.queryByText("Inga ansökningar väntar på beslut")).not.toBeInTheDocument();
  });

  it("approves with the note, and says how many absence days the approval wrote", async () => {
    decide.mockResolvedValue({ absenceDays: 3 });
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole("tablist", { name: "Visa ansökningar" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Kommentar till vårdnadshavaren/ }), "Ha det fint");
    await user.click(screen.getByRole("button", { name: /^Bevilja Ada Berg/ }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith({ id: "l-1", status: "APPROVED", note: "Ha det fint" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Beviljad — 3 frånvarodagar registrerade");
  });
});
