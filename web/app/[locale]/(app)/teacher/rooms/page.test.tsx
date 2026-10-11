import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeacherRoomsPage from "./page";

/**
 * Lokalbokning for a teacher: the cancel confirmation is a lazy chunk, fetched
 * on its first open. A chunk that does not arrive is said in a toast in the
 * reader's language, never as the loader's English error text.
 */

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "t-1", role: "TEACHER" }, school: null }),
}));
vi.mock("@/lib/queries", () => ({
  useRooms: () => ({ data: [{ id: "r-1", name: "Sal 12", requiresApproval: false }], isLoading: false, isError: false }),
  useCalendarLessons: () => ({ data: [], isLoading: false, isError: false }),
  useRoomBookings: () => ({ data: [], isLoading: false, isError: false }),
  useMyRoomBookings: () => ({
    data: [
      {
        id: "b-1",
        roomId: "r-1",
        bookedById: "t-1",
        title: "Prov",
        startsAt: "2099-03-02T08:00:00Z",
        endsAt: "2099-03-02T09:00:00Z",
        status: "APPROVED",
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: "2099-03-01T08:00:00Z",
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useRoomBookingActions: () => ({
    book: { mutateAsync: vi.fn(), isPending: false },
    cancel: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
// The cancel confirmation's chunk never arrives.
vi.mock("@/components/ui/confirm-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/confirm-dialog.js");
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelling a booking from Lokalbokning", () => {
  it("says in the reader's language that the confirmation could not be opened when its chunk does not arrive", async () => {
    const user = userEvent.setup();
    render(<TeacherRoomsPage />);
    await user.click(screen.getByRole("button", { name: /^common\.actionNamed\(teacherRooms\.cancel\|Sal 12/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("common.confirmLoadFailed"));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
  });
});
