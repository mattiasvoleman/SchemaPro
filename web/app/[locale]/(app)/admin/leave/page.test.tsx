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
 *
 * Ledighetspolicy (K4): below the lists, the school's choices for how it receives
 * a request; on each row what the choices put on it (the flag for a late request,
 * the family's contact, how many guardians have consented and never who), the
 * buttons off while a guardian's consent is awaited, and a tab for the requests a
 * guardian's no ended. The card itself is components/leave/leave-policy-card.test.tsx's.
 */

const decide = vi.hoisted(() => vi.fn());
const delegate = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  inbox: { data: undefined as unknown, isLoading: false, isError: false },
  policy: { data: undefined as unknown, isLoading: false, isError: false },
  /** The status each render asked the inbox for. */
  statuses: [] as string[],
  delegation: { data: undefined as unknown, isLoading: false, isError: false },
  profile: { profile: {} } as { profile: { adminProfile?: string } },
}));

vi.mock("@/lib/leave-queries", () => ({
  useLeaveInbox: (status: string) => {
    state.statuses.push(status);
    return state.inbox;
  },
  useLeaveDelegation: () => state.delegation,
  useLeaveInboxActions: () => ({
    decide: { mutateAsync: decide, isPending: false, variables: undefined },
    refer: { mutateAsync: vi.fn(), isPending: false, variables: undefined },
    delegate: { mutateAsync: delegate, isPending: false },
  }),
}));
vi.mock("@/lib/leave-policy-queries", () => ({
  useLeavePolicy: () => state.policy,
  useSaveLeavePolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => state.profile }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DELEGATION = { mentorMaxSchoolDays: 3, reference: "Dnr 2026:12", decidedAt: "2026-08-10T08:00:00.000Z", decidedBy: "Rut Rektor" };
const ANNA = { id: "t-anna", name: "Anna Mentor" };
const YEAR = { name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", approvedDays: 5, approvedRequests: 2, pendingRequests: 1 };

const NO_CONSENT = { required: false, state: "NOT_REQUIRED", mine: "NOT_ASKED", asked: null, given: null, waiting: null };
const DELIVERED = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };

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
  shortNotice: false,
  contact: null,
  consent: NO_CONSENT,
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
  state.policy = { data: DELIVERED, isLoading: false, isError: false };
  state.statuses = [];
  state.profile = { profile: {} };
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

  it("shows the delegation to every administrator, and its change only to those who decide (Roller i skolan)", () => {
    for (const adminProfile of ["EXPEDITION", "SCHEMALAGGARE"]) {
      state.profile = { profile: { adminProfile } };
      const { unmount } = render(
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <LeaveRequestsPage />
        </NextIntlClientProvider>,
      );
      expect(screen.getByText("Mentorn beslutar om ledighet på högst 3 skoldagar")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ändra delegering" })).not.toBeInTheDocument();
      unmount();
    }
    state.profile = { profile: { adminProfile: "REKTOR" } };
    renderPage();
    expect(screen.getByRole("button", { name: "Ändra delegering" })).toBeInTheDocument();
  });

  it("marks each waiting request's decision as Drift's and the delegation's change as a decision, and leaves the filter to every reader", async () => {
    const user = userEvent.setup();
    renderPage();
    for (const name of [/^Bevilja Ada Berg/, /^Avslå Ada Berg/]) {
      expect(screen.getByRole("button", { name }).closest("[data-writes]")).toHaveAttribute("data-writes", "DRIFT");
    }
    expect(screen.getByRole("tablist", { name: "Visa ansökningar" }).closest("[data-writes]")).toBeNull();
    const edit = screen.getByRole("button", { name: "Ändra delegering" });
    expect(edit).toHaveAttribute("data-writes", "DECIDES");
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Delegera beslut om ledighet" });
    expect(within(dialog).getByRole("button", { name: "Spara beslutet" })).toHaveAttribute("data-writes", "DECIDES");
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

describe("Ledighetsansökningar under the school's policy (Ledighetspolicy)", () => {
  const WAITING = { required: true, state: "WAITING", mine: "NOT_ASKED", asked: 3, given: 2, waiting: 1 };
  const GIVEN = { required: true, state: "GIVEN", mine: "NOT_ASKED", asked: 3, given: 3, waiting: 0 };
  const CONTACT = { name: "Maria Ek", phone: "070-123 45 67", relation: "Mormor" };
  const list = () => screen.getByRole("region", { name: "Väntar på rektor" });

  it("adds nothing to a request that carries nothing, and no tab for requests a guardian ended", () => {
    renderPage();
    const row = within(list()).getByText(/^Ada Berg/).closest("li")!;
    expect(row).not.toHaveTextContent(/Kom sent|Kontakt under ledigheten|vårdnadshavare har samtyckt/);
    expect(screen.queryByRole("tab", { name: "Avslutade av vårdnadshavare" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^Bevilja Ada Berg/ })).toBeEnabled();
  });

  it("reads a request from a gateway older than the feature as it always did", () => {
    state.inbox = { data: [request({ shortNotice: undefined, contact: undefined, consent: undefined })], isLoading: false, isError: false };
    renderPage();
    const row = within(list()).getByText(/^Ada Berg/).closest("li")!;
    expect(row).not.toHaveTextContent(/Kom sent|Kontakt under ledigheten|vårdnadshavare har samtyckt/);
    expect(within(row).getByRole("button", { name: /^Bevilja Ada Berg/ })).toBeEnabled();
  });

  it("flags a request that came later than the school's minimum, in words", () => {
    state.inbox = { data: [request({ shortNotice: true })], isLoading: false, isError: false };
    renderPage();
    expect(within(list()).getByText("Kom sent: ansökan kom närmare första dagen än skolan har bestämt")).toBeInTheDocument();
  });

  it("shows the family's contact with the request the administrator decides, as name, relation and phone", () => {
    state.inbox = { data: [request({ contact: CONTACT })], isLoading: false, isError: false };
    renderPage();
    expect(within(list()).getByText("Kontakt under ledigheten: Maria Ek (Mormor), 070-123 45 67")).toBeInTheDocument();
  });

  it("says how many guardians have consented and never who, and turns the decision off with the reason beside it", async () => {
    const user = userEvent.setup();
    state.inbox = { data: [request({ consent: WAITING, requestedBy: "Gun Berg" })], isLoading: false, isError: false };
    renderPage();
    const row = within(list()).getByText(/^Ada Berg/).closest("li")!;
    expect(within(row).getByText("2 av 3 vårdnadshavare har samtyckt")).toBeInTheDocument();
    const approve = within(row).getByRole("button", { name: /^Bevilja Ada Berg/ });
    const reject = within(row).getByRole("button", { name: /^Avslå Ada Berg/ });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    const reason = "Kan inte beslutas ännu: ansökan väntar på vårdnadshavarnas samtycke.";
    expect(within(row).getByText(reason)).toBeInTheDocument();
    expect(approve).toHaveAccessibleDescription(reason);
    await user.click(approve);
    expect(decide).not.toHaveBeenCalled();
    // The applicant is named as before; no other guardian is, and no answer is tied to a person.
    expect(row).toHaveTextContent("Ansökt av Gun Berg");
    expect(row).not.toHaveTextContent(/Tom|Sara|nekade|sa nej/);
  });

  it("lets a request be decided once every guardian has consented, and says so", () => {
    state.inbox = { data: [request({ consent: GIVEN })], isLoading: false, isError: false };
    renderPage();
    const row = within(list()).getByText(/^Ada Berg/).closest("li")!;
    expect(within(row).getByText("3 av 3 vårdnadshavare har samtyckt")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^Bevilja Ada Berg/ })).toBeEnabled();
    expect(within(row).queryByText(/Kan inte beslutas ännu/)).not.toBeInTheDocument();
  });

  it("keeps the other requests decidable while one waits for consent", () => {
    state.inbox = {
      data: [request({ id: "l-wait", consent: WAITING }), request({ id: "l-free", student: { id: "p-bo", name: "Bo Ek", className: null } })],
      isLoading: false,
      isError: false,
    };
    renderPage();
    expect(screen.getByRole("button", { name: /^Bevilja Ada Berg/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Bevilja Bo Ek/ })).toBeEnabled();
  });

  it("says in words that a request still waits for consent when the gateway refuses a decision, never its English", async () => {
    decide.mockRejectedValueOnce(new ApiError(409, "The leave request waits for every guardian's consent.", "LEAVE_AWAITING_CONSENT"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Bevilja Ada Berg/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Ansökan väntar på vårdnadshavarnas samtycke och kan inte beslutas ännu. Listan är uppdaterad."),
    );
  });

  it("offers a tab for the requests a guardian's no ended while the school asks for consent, and asks the inbox for them", async () => {
    const user = userEvent.setup();
    state.policy = { data: { ...DELIVERED, requireAllGuardians: true }, isLoading: false, isError: false };
    state.inbox = {
      data: [
        request({
          status: "GUARDIAN_DECLINED",
          decides: null,
          consent: { required: true, state: "REFUSED", mine: "NOT_ASKED", asked: 3, given: 1, waiting: 0 },
        }),
      ],
      isLoading: false,
      isError: false,
    };
    renderPage();
    await user.click(screen.getByRole("tab", { name: "Avslutade av vårdnadshavare" }));
    expect(state.statuses.at(-1)).toBe("GUARDIAN_DECLINED");
    const section = screen.getByRole("region", { name: "Ansökningar som en vårdnadshavare avslutat" });
    const row = within(section).getByText(/^Ada Berg/).closest("li")!;
    // Its own status, in words, with no decider and no decision to take.
    expect(within(row).getByText("Avslutad")).toBeInTheDocument();
    expect(within(row).getByText("Avslutad: en vårdnadshavare samtyckte inte. Ingen beslutar den.")).toBeInTheDocument();
    expect(within(row).getByText("1 av 3 vårdnadshavare har samtyckt")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent(/Rektor beslutar|Mentorn beslutar/);
  });

  it("says nothing was ended when none was, under that tab", async () => {
    const user = userEvent.setup();
    state.policy = { data: { ...DELIVERED, requireAllGuardians: true }, isLoading: false, isError: false };
    renderPage();
    state.inbox = { data: [], isLoading: false, isError: false };
    await user.click(screen.getByRole("tab", { name: "Avslutade av vårdnadshavare" }));
    expect(screen.getByRole("heading", { level: 2, name: "Ingen vårdnadshavare har avslutat en ansökan" })).toBeInTheDocument();
  });

  it("shows the school's choices below the lists to every administrator", () => {
    for (const adminProfile of ["EXPEDITION", "REKTOR"]) {
      state.profile = { profile: { adminProfile } };
      const { unmount } = render(
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <LeaveRequestsPage />
        </NextIntlClientProvider>,
      );
      const card = screen.getByRole("region", { name: "Så tar skolan emot ledighetsansökningar" });
      expect(card).toBeInTheDocument();
      // After the lists, so the inbox is what the page opens on.
      expect(list().compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(card).queryByRole("button", { name: "Spara valen" }) === null).toBe(adminProfile === "EXPEDITION");
      unmount();
    }
  });
});
