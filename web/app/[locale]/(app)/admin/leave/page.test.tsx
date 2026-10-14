import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import sv from "@/messages/sv.json";
import LeaveRequestsPage from "./page";

/**
 * Ledighetsansökningar, rektor's inbox through the gateway: a read that
 * failed is said as such (never "nothing waits"); pending requests are split
 * into rektor's and the mentors', each with its skoldagar, who decides it and
 * why, and the pupil's leave so far this läsår; an approval still says how
 * many absence days it wrote; and rektor records the delegation in a dialog.
 */

const decide = vi.hoisted(() => vi.fn());
const delegate = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  inbox: { data: undefined as unknown, isLoading: false, isError: false },
  delegation: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock("@/lib/leave-queries", () => ({
  useLeaveInbox: () => state.inbox,
  useLeaveDelegation: () => state.delegation,
  useLeaveInboxActions: () => ({
    decide: { mutateAsync: decide, isPending: false, variables: undefined },
    refer: { mutateAsync: vi.fn(), isPending: false, variables: undefined },
    delegate: { mutateAsync: delegate, isPending: false },
  }),
}));
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DELEGATION = { mentorMaxSchoolDays: 3, reference: "Dnr 2026:12", decidedAt: "2026-08-10T08:00:00.000Z", decidedBy: "Rut Rektor" };
const ANNA = { id: "t-anna", name: "Anna Mentor" };
const YEAR = { name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", approvedDays: 5, approvedRequests: 2, pendingRequests: 1 };

const request = (overrides: Record<string, unknown>) => ({
  id: "l-1",
  studentId: "p-ada",
  requestedById: "g-gun",
  startDate: "2026-10-19",
  endDate: "2026-10-21",
  reason: "Resa till mormor",
  status: "PENDING",
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: "2026-10-10T08:00:00.000Z",
  decidedAs: null,
  student: { id: "p-ada", name: "Ada Berg", className: "7A" },
  requestedBy: "Gun Berg",
  decidedByName: null,
  referral: null,
  schoolDays: 3,
  decides: "ADMIN",
  mentors: [ANNA],
  decidingMentors: [],
  year: YEAR,
  ...overrides,
});

function renderPage() {
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <LeaveRequestsPage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inbox = { data: [request({ schoolDays: 5 })], isLoading: false, isError: false };
  state.delegation = { data: { current: DELEGATION, history: [DELEGATION] }, isLoading: false, isError: false };
});

describe("Ledighetsansökningar", () => {
  it("says the requests could not be read, never that nothing waits", () => {
    state.inbox = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Ansökningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga ansökningar väntar på beslut")).not.toBeInTheDocument();
  });

  it("shows nothing as empty while the requests load", () => {
    state.inbox = { data: undefined, isLoading: true, isError: false };
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
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ id: "l-1", status: "APPROVED", note: "Ha det fint" }));
    expect(toast.success).toHaveBeenCalledWith("Beviljad — 3 frånvarodagar registrerade");
  });

  it("says an approval that covered no skoldag wrote no absence", async () => {
    decide.mockResolvedValue({ absenceDays: 0 });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Bevilja Ada Berg/ }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Beviljad — ingen frånvarodag registrerad, ansökan gäller inga skoldagar"),
    );
  });

  it("says a request the mentor decided first is already decided, and any other failure in the gateway's words", async () => {
    decide.mockRejectedValueOnce(new ApiError(409, "Leave request is already decided.", "LEAVE_REQUEST_DECIDED"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Bevilja Ada Berg/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ansökan är redan beslutad. Listan är uppdaterad."));

    // Rektor reads every request: a 404 is no lost race.
    decide.mockRejectedValueOnce(new ApiError(404, "Leave request not found."));
    await user.click(screen.getByRole("button", { name: /^Bevilja Ada Berg/ }));
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("Leave request not found."));
  });

  it("splits the pending requests into rektor's and the mentors', and says who decides each and why", () => {
    state.inbox = {
      data: [
        request({ id: "l-over", schoolDays: 5 }),
        request({ id: "l-none", student: { id: "p-bo", name: "Bo Ek", className: null }, mentors: [], schoolDays: 1 }),
        request({ id: "l-passed", student: { id: "p-cy", name: "Cy Ek", className: "7B" }, referral: { by: "Anna Mentor", at: "2026-10-11T08:00:00.000Z" } }),
        request({ id: "l-mentor", student: { id: "p-di", name: "Di Ek", className: "7A" }, decides: "MENTOR", decidingMentors: [ANNA] }),
      ],
      isLoading: false,
      isError: false,
    };
    renderPage();
    const rektor = screen.getByRole("region", { name: "Väntar på rektor" });
    const mentor = screen.getByRole("region", { name: "Hos elevens mentor" });
    expect(within(rektor).getByText("5 skoldagar · Rektor beslutar: mer än 3 skoldagar")).toBeInTheDocument();
    expect(within(rektor).getByText("1 skoldag · Rektor beslutar: eleven har ingen mentor de dagarna")).toBeInTheDocument();
    expect(within(rektor).getByText("3 skoldagar · Skickad till rektor av Anna Mentor")).toBeInTheDocument();
    expect(within(mentor).getByText("3 skoldagar · Mentorn beslutar: Anna Mentor")).toBeInTheDocument();
    // Rektor may still decide what waits for the mentor.
    expect(within(mentor).getByRole("button", { name: /^Bevilja Di Ek/ })).toBeInTheDocument();
    expect(within(mentor).getAllByText("Läsåret 2026/27: 5 skoldagar beviljade i 2 ansökningar, 1 ansökan till väntar")).toHaveLength(1);
  });

  it("says rektor decides every request when nothing is delegated", () => {
    state.delegation = { data: { current: null, history: [] }, isLoading: false, isError: false };
    state.inbox = { data: [request({ schoolDays: 2 })], isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText("Rektor beslutar om all ledighet")).toBeInTheDocument();
    expect(screen.getByText("2 skoldagar · Rektor beslutar")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Hos elevens mentor" })).not.toBeInTheDocument();
  });

  it("says the delegation in force, and rektor records a new one in the dialog", async () => {
    delegate.mockResolvedValue(DELEGATION);
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText("Mentorn beslutar om ledighet på högst 3 skoldagar")).toBeInTheDocument();
    expect(screen.getByText(/Beslutat .* av Rut Rektor, Dnr 2026:12\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ändra delegering" }));
    const dialog = await screen.findByRole("dialog", { name: "Delegera beslut om ledighet" });
    expect(within(dialog).getByText(/Låt skolans jurist bekräfta/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Mentorn beslutar om ansökningar på högst" }), "5");
    const reference = within(dialog).getByRole("textbox", { name: /Beslutets diarienummer/ });
    await user.clear(reference);
    await user.type(reference, "Dnr 2026:40");
    await user.click(within(dialog).getByRole("button", { name: "Spara beslutet" }));
    await waitFor(() => expect(delegate).toHaveBeenCalledWith({ mentorMaxSchoolDays: 5, reference: "Dnr 2026:40" }));
    expect(toast.success).toHaveBeenCalledWith("Delegeringen är sparad");
  });

  it("records no delegation as a decision of its own", async () => {
    delegate.mockResolvedValue({ ...DELEGATION, mentorMaxSchoolDays: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Ändra delegering" }));
    const dialog = await screen.findByRole("dialog", { name: "Delegera beslut om ledighet" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Mentorn beslutar om ansökningar på högst" }), "");
    await user.clear(within(dialog).getByRole("textbox", { name: /Beslutets diarienummer/ }));
    await user.click(within(dialog).getByRole("button", { name: "Spara beslutet" }));
    await waitFor(() => expect(delegate).toHaveBeenCalledWith({ mentorMaxSchoolDays: null }));
  });
});
