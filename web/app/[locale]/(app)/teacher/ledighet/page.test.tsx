import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import sv from "@/messages/sv.json";
import TeacherLeavePage from "./page";

/**
 * /teacher/ledighet, the mentor's inbox: what rektor has delegated, the
 * requests theirs to decide with the facts they decide on, a co-mentor who
 * may decide first, and Bevilja, Avslå and Skicka till rektor. A school that
 * delegates nothing says so instead of an empty list.
 */

const decide = vi.hoisted(() => vi.fn());
const refer = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  inbox: { data: undefined as unknown, isLoading: false, isError: false },
  delegation: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock("@/lib/leave-queries", () => ({
  useLeaveInbox: () => state.inbox,
  useLeaveDelegation: () => state.delegation,
  useLeaveInboxActions: () => ({
    decide: { mutateAsync: decide, isPending: false, variables: undefined },
    refer: { mutateAsync: refer, isPending: false, variables: undefined },
    delegate: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "t-anna", role: "TEACHER", firstName: "Anna", lastName: "Mentor" }, school: null }),
}));
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DELEGATION = { mentorMaxSchoolDays: 3, reference: null, decidedAt: "2026-08-10T08:00:00.000Z", decidedBy: "Rut Rektor" };
const REQUEST = {
  id: "l-1",
  studentId: "p-ella",
  requestedById: "g-vera",
  startDate: "2027-02-18",
  endDate: "2027-03-02",
  reason: "Resa till mormor",
  status: "PENDING",
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: "2027-02-01T08:00:00.000Z",
  decidedAs: null,
  student: { id: "p-ella", name: "Ella Elev", className: "7A" },
  requestedBy: "Vera Vårdnadshavare",
  decidedByName: null,
  referral: null,
  schoolDays: 2,
  decides: "MENTOR",
  mentors: [
    { id: "t-anna", name: "Anna Mentor" },
    { id: "t-bertil", name: "Bertil Mentor" },
  ],
  decidingMentors: [
    { id: "t-anna", name: "Anna Mentor" },
    { id: "t-bertil", name: "Bertil Mentor" },
  ],
  year: { name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", approvedDays: 0, approvedRequests: 0, pendingRequests: 0 },
};

function renderPage() {
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <TeacherLeavePage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inbox = { data: [REQUEST], isLoading: false, isError: false };
  state.delegation = { data: { current: DELEGATION, history: [DELEGATION] }, isLoading: false, isError: false };
});

describe("Ledighet, the mentor's inbox", () => {
  it("says what rektor has delegated, and the request with the facts the mentor decides on", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Ledighet" })).toBeInTheDocument();
    expect(screen.getByText("Mentorn beslutar om ledighet på högst 3 skoldagar")).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Väntar på ditt beslut" });
    // Eleven days over sportlovet, two of them skoldagar; Bertil is the
    // other mentor, and the first decision stands.
    expect(within(list).getByText("2 skoldagar · Även Bertil Mentor kan besluta, och det första beslutet gäller")).toBeInTheDocument();
    expect(within(list).getByText("Ingen annan ledighet i läsåret 2026/27")).toBeInTheDocument();
    expect(within(list).getByText("Resa till mormor")).toBeInTheDocument();
    expect(within(list).getByText(/Ansökt av Vera Vårdnadshavare/)).toBeInTheDocument();
  });

  it("approves with the note, and says how many absence days it wrote", async () => {
    decide.mockResolvedValue({ absenceDays: 2 });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByRole("textbox", { name: /Kommentar till familjen/ }), "Trevlig resa");
    await user.click(screen.getByRole("button", { name: /^Bevilja Ella Elev/ }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ id: "l-1", status: "APPROVED", note: "Trevlig resa" }));
    expect(toast.success).toHaveBeenCalledWith("Beviljad — 2 frånvarodagar registrerade");
  });

  it("passes a request on to rektor only after asking, and says it went", async () => {
    refer.mockResolvedValue({ id: "l-1", referred: true });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Skicka till rektor Ella Elev/ }));
    const dialog = await screen.findByRole("dialog", { name: "Skicka ansökan för Ella Elev till rektor?" });
    expect(refer).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Du ser den inte här efteråt/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Skicka till rektor" }));
    await waitFor(() => expect(refer).toHaveBeenCalledWith("l-1"));
    expect(toast.success).toHaveBeenCalledWith("Ansökan skickad till rektor");
  });

  it.each([
    ["a co-mentor or rektor decided first", new ApiError(409, "Leave request is already decided.", "LEAVE_REQUEST_DECIDED")],
    ["it is out of the mentor's reach", new ApiError(404, "Leave request not found.")],
  ])("says the request is no longer the mentor's when %s, never the gateway's English", async (_why, error) => {
    decide.mockRejectedValue(error);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Bevilja Ella Elev/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Ansökan är redan beslutad eller inte längre din att besluta. Listan är uppdaterad.",
      ),
    );
  });

  it("says the same of a referral that lost the race", async () => {
    refer.mockRejectedValue(new ApiError(409, "Leave request is already decided.", "LEAVE_REQUEST_DECIDED"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /^Skicka till rektor Ella Elev/ }));
    const dialog = await screen.findByRole("dialog", { name: "Skicka ansökan för Ella Elev till rektor?" });
    await user.click(within(dialog).getByRole("button", { name: "Skicka till rektor" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Ansökan är redan beslutad eller inte längre din att besluta. Listan är uppdaterad.",
      ),
    );
  });

  it("says rektor decides everything at a school that delegates nothing, rather than that nothing waits", () => {
    state.inbox = { data: [], isLoading: false, isError: false };
    state.delegation = { data: { current: null, history: [] }, isLoading: false, isError: false };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Rektor beslutar om all ledighet" })).toBeInTheDocument();
    expect(screen.queryByText("Inga ansökningar väntar på dig")).not.toBeInTheDocument();
  });

  it("says nothing waits when the school delegates and nothing is the mentor's", () => {
    state.inbox = { data: [], isLoading: false, isError: false };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Inga ansökningar väntar på dig" })).toBeInTheDocument();
  });

  it("says nothing waits, never that rektor decides everything, while the delegation cannot be read", () => {
    state.inbox = { data: [], isLoading: false, isError: false };
    state.delegation = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Inga ansökningar väntar på dig" })).toBeInTheDocument();
    expect(screen.queryByText("Rektor beslutar om all ledighet")).not.toBeInTheDocument();
  });

  it("says the requests could not be read, never that nothing waits", () => {
    state.inbox = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Ansökningarna kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga ansökningar väntar på dig")).not.toBeInTheDocument();
  });

  it("shows the mentor's own decision with its badge and no buttons", () => {
    state.inbox = {
      data: [
        {
          ...REQUEST,
          status: "APPROVED",
          decides: null,
          decidingMentors: [],
          decidedById: "t-anna",
          decidedAt: "2027-02-02T08:00:00.000Z",
          decisionNote: "Trevlig resa",
          decidedAs: "MENTOR",
          decidedByName: "Anna Mentor",
        },
      ],
      isLoading: false,
      isError: false,
    };
    renderPage();
    expect(screen.getByText("2 skoldagar · Beslutad av mentorn Anna Mentor")).toBeInTheDocument();
    expect(screen.getByText("Kommentar: Trevlig resa")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Bevilja/ })).not.toBeInTheDocument();
  });
});
