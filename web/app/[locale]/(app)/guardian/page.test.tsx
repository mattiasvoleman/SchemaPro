import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { GuardianChild } from "@/lib/guardian-queries";
import type { LeavePolicy, LeaveRequest, MySchool } from "@/lib/types";
import GuardianPage from "./page";

const NO_POLICY: LeavePolicy = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };
const NO_CONSENT: LeaveRequest["consent"] = { required: false, state: "NOT_REQUIRED", mine: "NOT_ASKED", asked: null, given: null, waiting: null };

/**
 * The guardian's start page and its "Undervisningstid" cards (timplan P4):
 * one card per child of the guardian's own, asked for by that child's id,
 * and none for any other role that opens the page. What a card says is
 * components/teaching-time-card.test.tsx's; which rows exist for the guardian
 * is RLS's (scripts/test/rls-policies.sql, section 26d).
 */

const state = vi.hoisted(() => ({
  role: "GUARDIAN",
  // The gateway's shape (GET /api/v1/family/children): no role, email or phone.
  children: [] as GuardianChild[],
  /** The guardian id each render asked useMyChildren for. */
  childrenAskedFor: [] as (string | null)[],
  reports: [] as Record<string, unknown>[],
  leaves: [] as Record<string, unknown>[],
  requestLeave: vi.fn(),
  /** What the school asks of a leave request (Ledighetspolicy); as delivered: nothing. */
  policy: undefined as LeavePolicy | undefined,
  answerConsent: vi.fn(),
  /** The login's schools (Flera skolor per inloggning); none: one school. */
  schools: [] as MySchool[],
}));

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: {
      id: "g-1",
      authId: "a-1",
      schoolId: "s-1",
      role: state.role,
      firstName: "Gun",
      lastName: "Förälder",
      email: "gun@example.se",
      studentGroupId: null,
    },
    school: null,
    schools: state.schools,
  }),
}));
vi.mock("@/components/guardian/other-schools", () => ({
  OtherSchools: ({ schools }: { schools: MySchool[] }) => (
    <p>other-schools {schools.map((school) => school.schoolName).join(",")}</p>
  ),
}));
// "Gallrat före": nothing gallrat in these rows.
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("@/lib/guardian-queries", () => ({
  useMyChildren: (guardianUserId: string | null) => {
    state.childrenAskedFor.push(guardianUserId);
    return { data: state.children, isLoading: false };
  },
  useAbsenceReports: () => ({ data: state.reports }),
  useLeaveRequests: () => ({ data: state.leaves }),
  useAbsenceReportActions: () => ({ report: { isPending: false }, remove: { isPending: false } }),
  useLeaveRequestActions: () => ({ request: { isPending: false, mutateAsync: state.requestLeave } }),
}));
vi.mock("@/lib/leave-policy-queries", () => ({ useLeavePolicy: () => ({ data: state.policy }) }));
vi.mock("@/lib/leave-consent-queries", () => ({
  useAnswerLeaveConsent: () => ({ isPending: false, mutateAsync: state.answerConsent }),
}));
vi.mock("@/components/teaching-time-card", () => ({
  TeachingTimeCard: ({ studentId, childName }: { studentId: string; childName?: string }) => (
    <p>teaching-time {studentId} {childName}</p>
  ),
}));
vi.mock("@/components/guardian/child-schedule", () => ({
  ChildSchedule: ({ childList }: { childList: { id: string; firstName: string }[] }) => (
    <p>child-schedule {childList.map((child) => child.id).join(",")}</p>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The calendar is its own spec's (components/ui/date-field.test.tsx); here a
// field is the bounds the page gives it.
vi.mock("@/components/ui/date-field", () => ({
  DateField: (props: { id: string; label?: string; value: string; min?: string; max?: string; onChange: (value: string) => void }) => (
    <input
      id={props.id}
      aria-label={props.label}
      value={props.value}
      data-min={props.min ?? ""}
      data-max={props.max ?? ""}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
// The delete confirmation is a lazy chunk; here it never arrives.
vi.mock("@/components/ui/confirm-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/confirm-dialog.js");
});
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.schools = [];
  state.reports = [];
  state.childrenAskedFor = [];
  state.leaves = [];
  state.policy = NO_POLICY;
  state.requestLeave.mockResolvedValue({ id: "l-new", studentId: "c-1", status: "PENDING", consentRequired: false, shortNotice: false });
  state.answerConsent.mockResolvedValue({ id: "l-1", answer: "GIVEN", state: "WAITING" });
  state.role = "GUARDIAN";
  state.children = [
    { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
    { linkId: "l-2", id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
  ];
});

describe("the guardian's leave requests", () => {
  const leave = (id: string, status: string, decidedAs: string | null) => ({
    id,
    studentId: "c-1",
    requestedById: "g-1",
    startDate: "2026-10-19",
    endDate: "2026-10-21",
    reason: `Resa ${id}`,
    status,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    decidedAs,
    createdAt: "2026-10-10T08:00:00.000Z",
    shortNotice: false,
    contact: null,
    consent: NO_CONSENT,
  });

  it("says who decided: the mentor or rektor, and nothing while it waits or for an older decision", async () => {
    state.leaves = [
      leave("l-mentor", "APPROVED", "MENTOR"),
      leave("l-rektor", "REJECTED", "ADMIN"),
      leave("l-old", "APPROVED", null),
      leave("l-pending", "PENDING", null),
    ];
    render(<GuardianPage />);
    expect(await screen.findByText("Resa l-mentor")).toBeInTheDocument();
    expect(screen.getAllByText("guardian.decidedByMentor")).toHaveLength(1);
    expect(screen.getAllByText("guardian.decidedByRektor")).toHaveLength(1);
  });

  it.each([
    ["more than a year", new ApiError(400, "A leave request covers at most 366 days.", "LEAVE_REQUEST_TOO_LONG", { days: 366 }), "guardian.leaveTooLong"],
    ["an end before the start", new ApiError(400, "endDate must not be before startDate.", "LEAVE_REQUEST_ENDS_BEFORE_START"), "guardian.leaveEndsBeforeStart"],
  ])("says in the guardian's language what the gateway refused for %s, never its English", async (_what, error, said) => {
    state.requestLeave.mockRejectedValue(error);
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    await user.click(screen.getByRole("button", { name: /guardian.leaveSubmit/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(said));
    expect(toast.error).not.toHaveBeenCalledWith(error.message);
  });

  it("offers no last day before the first, or more than a year after it", () => {
    render(<GuardianPage />);
    const start = (document.getElementById("leave-start") as HTMLInputElement).value;
    const end = document.getElementById("leave-end") as HTMLInputElement;
    const year = new Date(Date.parse(`${start}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10);
    expect(end.dataset["min"]).toBe(start);
    expect(end.dataset["max"]).toBe(year);
  });
});

/**
 * Ledighetspolicy (K4) on the page: the form asks and explains only what the
 * school's policy says, and the list says only what a request carries. The
 * words of each part are components/guardian/leave-extras.test.tsx's, with the
 * real messages; here the keys stand for them.
 */
describe("the leave form and list under the school's policy (Ledighetspolicy)", () => {
  const FULL = { name: "Maria Ek", phone: "070-123 45 67", relation: "Mormor" };
  const fill = async (user: ReturnType<typeof userEvent.setup>, contact = FULL) => {
    await user.type(await screen.findByRole("textbox", { name: "guardian.leavePolicy.contactName" }), contact.name);
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactPhone" }), contact.phone);
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactRelation" }), contact.relation);
  };
  const submit = () => screen.getByRole("button", { name: /guardian.leaveSubmit/ });

  it("asks and explains nothing more as delivered, and sends exactly the request it always did", async () => {
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    expect(screen.queryByText(/^guardian\.leavePolicy/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /guardian.leavePolicy/ })).not.toBeInTheDocument();
    await user.click(submit());
    await waitFor(() => expect(state.requestLeave).toHaveBeenCalledTimes(1));
    expect(Object.keys(state.requestLeave.mock.calls[0]![0] as object).sort()).toEqual(["endDate", "reason", "startDate", "studentId"]);
    expect(toast.success).toHaveBeenCalledWith("guardian.leaveSubmitted");
  });

  it("explains the minimum, and what a later request meets: refused, or flagged for whoever decides", async () => {
    state.policy = { ...NO_POLICY, minDaysAhead: 14, shortNotice: "REFUSE" };
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText(/guardian.leavePolicy.minAhead/)).toHaveTextContent("guardian.leavePolicy.refuse");
    unmount();
    state.policy = { ...NO_POLICY, minDaysAhead: 14, shortNotice: "FLAG" };
    render(<GuardianPage />);
    const line = await screen.findByText(/guardian.leavePolicy.minAhead/);
    expect(line).toHaveTextContent("guardian.leavePolicy.flag");
    expect(line).not.toHaveTextContent("guardian.leavePolicy.refuse");
  });

  it("says that every guardian is asked to consent when the school asks them to", async () => {
    state.policy = { ...NO_POLICY, requireAllGuardians: true };
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.leavePolicy.allGuardians")).toBeInTheDocument();
    expect(screen.queryByText("guardian.leavePolicy.contactLegend")).not.toBeInTheDocument();
  });

  it("holds the request back until a required contact is whole, and then sends it trimmed and clears it", async () => {
    state.policy = { ...NO_POLICY, contact: "REQUIRED" };
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    expect(await screen.findByText("guardian.leavePolicy.contactLegend")).toBeInTheDocument();
    // Required, said in words, and on each field for assistive technology.
    expect(screen.getByRole("group")).toHaveAccessibleName(/guardian.leavePolicy.contactLegend.*guardian.leavePolicy.contactRequired/);
    expect(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactName" })).toBeRequired();
    expect(submit()).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactName" }), "  Maria Ek ");
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactPhone" }), "070-123 45 67");
    expect(submit()).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactRelation" }), "Mormor");
    expect(submit()).toBeEnabled();

    await user.click(submit());
    await waitFor(() => expect(state.requestLeave).toHaveBeenCalledTimes(1));
    expect(state.requestLeave.mock.calls[0]![0]).toMatchObject({
      reason: "Familjeresa",
      contactName: "Maria Ek",
      contactPhone: "070-123 45 67",
      contactRelation: "Mormor",
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactName" })).toHaveValue(""));
  });

  it("lets an optional contact be left out, but not given in part or with a phone number the gateway would refuse", async () => {
    state.policy = { ...NO_POLICY, contact: "OPTIONAL" };
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    expect((await screen.findByText("guardian.leavePolicy.contactLegend")).closest("legend")).toHaveTextContent("common.optional");
    expect(submit()).toBeEnabled();

    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactName" }), "Maria Ek");
    expect(submit()).toBeDisabled();
    // Told once the reader has left the fields, not while the others are still to be typed.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("guardian.leaveContactIncomplete");

    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactPhone" }), "ring mig");
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactRelation" }), "Mormor");
    expect(submit()).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("guardian.leavePolicy.contactPhoneInvalid");
    await user.clear(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactPhone" }));
    await user.type(screen.getByRole("textbox", { name: "guardian.leavePolicy.contactPhone" }), "070-123 45 67");
    expect(submit()).toBeEnabled();
  });

  it("sends no contact the school does not ask for, even if one was typed before the policy changed", async () => {
    state.policy = { ...NO_POLICY, contact: "OPTIONAL" };
    const user = userEvent.setup();
    const { rerender } = render(<GuardianPage />);
    await fill(user);
    state.policy = NO_POLICY;
    rerender(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    await user.click(submit());
    await waitFor(() => expect(state.requestLeave).toHaveBeenCalledTimes(1));
    expect(Object.keys(state.requestLeave.mock.calls[0]![0] as object)).not.toContain("contactName");
  });

  it("tells a request that asked for consent from one that did not", async () => {
    state.requestLeave.mockResolvedValue({ id: "l-new", studentId: "c-1", status: "PENDING", consentRequired: true, shortNotice: false });
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    await user.click(submit());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("guardian.leaveSubmittedConsent"));
  });

  it.each([
    ["too late", new ApiError(400, "The school asks for a leave request at least 14 days before the first day.", "LEAVE_REQUEST_TOO_LATE", { days: 14 }), "guardian.leaveTooLate"],
    ["no contact", new ApiError(400, "The school requires a contact.", "LEAVE_CONTACT_REQUIRED"), "guardian.leaveContactRequired"],
    ["a contact in part", new ApiError(400, "The contact is incomplete.", "LEAVE_CONTACT_INCOMPLETE"), "guardian.leaveContactIncomplete"],
  ])("says in the guardian's language what the gateway refused for %s", async (_what, error, said) => {
    state.requestLeave.mockRejectedValue(error);
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.type(screen.getByRole("textbox", { name: "guardian.reason" }), "Familjeresa");
    await user.click(submit());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(said));
    expect(toast.error).not.toHaveBeenCalledWith(error.message);
  });

  const asked = (id: string, over: Partial<LeaveRequest>) => ({
    id,
    studentId: "c-1",
    requestedById: "g-1",
    startDate: "2026-10-19",
    endDate: "2026-10-21",
    reason: `Resa ${id}`,
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    decidedAs: null,
    createdAt: "2026-10-10T08:00:00.000Z",
    shortNotice: false,
    contact: null,
    consent: NO_CONSENT,
    ...over,
  });

  it("adds nothing to a request that carries nothing, and says what the others carry", async () => {
    state.leaves = [
      asked("l-plain", {}),
      asked("l-waiting", { consent: { ...NO_CONSENT, required: true, state: "WAITING" } }),
      asked("l-contact", { contact: FULL }),
      asked("l-ended", { status: "GUARDIAN_DECLINED", consent: { ...NO_CONSENT, required: true, state: "REFUSED" } }),
    ];
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.consent.waiting")).toBeInTheDocument();
    expect(screen.getByText("guardian.consent.declined")).toBeInTheDocument();
    expect(screen.getByText("guardian.contactTitle")).toBeInTheDocument();
    const plain = screen.getByText("Resa l-plain").closest("li")!;
    expect(plain.querySelectorAll("p")).toHaveLength(2);
    // The ended request has its own status, in words.
    expect(screen.getByText("Resa l-ended").closest("li")).toHaveTextContent("guardian.statusGUARDIAN_DECLINED");
  });

  it("takes a guardian's yes from the list and says it was recorded", async () => {
    state.leaves = [asked("l-ask", { consent: { ...NO_CONSENT, required: true, state: "WAITING", mine: "WAITING" } })];
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.click(await screen.findByRole("button", { name: "guardian.consent.yesNamed" }));
    await waitFor(() => expect(state.answerConsent).toHaveBeenCalledWith({ id: "l-ask", consent: true }));
    expect(toast.success).toHaveBeenCalledWith("guardian.consent.answeredYes");
  });
});

describe("the guardian's Undervisningstid cards", () => {
  it("shows one card per child, each asked for by the child's own id", async () => {
    render(<GuardianPage />);
    expect(await screen.findByText("teaching-time c-1 Alva")).toBeInTheDocument();
    expect(screen.getByText("teaching-time c-2 Bo")).toBeInTheDocument();
  });

  it("asks for none when another role opens the page", async () => {
    state.role = "SCHOOL_ADMIN";
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^teaching-time/)).not.toBeInTheDocument();
  });

  it("asks for none for a guardian without children, whose page says so", () => {
    state.children = [];
    render(<GuardianPage />);
    expect(screen.getByText("guardian.noChildrenTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^teaching-time/)).not.toBeInTheDocument();
  });
});

/**
 * The children come from the gateway (GET /api/v1/family/children), which
 * answers a guardian and refuses every other role. Another role that opens
 * the page must not ask, or it would read a refusal as a failed load.
 */
describe("the children read", () => {
  it("is asked as the signed-in guardian", () => {
    render(<GuardianPage />);
    expect(state.childrenAskedFor).not.toHaveLength(0);
    expect(state.childrenAskedFor.every((id) => id === "g-1")).toBe(true);
  });

  it("is not asked when another role opens the page", () => {
    state.role = "SCHOOL_ADMIN";
    render(<GuardianPage />);
    expect(state.childrenAskedFor).not.toHaveLength(0);
    expect(state.childrenAskedFor.every((id) => id === null)).toBe(true);
  });
});

/**
 * The "Schema" card (elev- och vårdnadshavarytan): one card for the
 * guardian's own children, lazily loaded, and none for any other role. What it
 * shows is components/guardian/child-schedule.test.tsx's.
 */
describe("the guardian's Schema card", () => {
  it("is given exactly the guardian's own children", async () => {
    render(<GuardianPage />);
    expect(await screen.findByText("child-schedule c-1,c-2")).toBeInTheDocument();
  });

  it("leaves out a child who has left, whose week the gateway never answers, and is not there when every child has", async () => {
    state.children = [
      { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false, studentGroupId: "g-7a" },
      { linkId: "l-2", id: "c-2", firstName: "Bo", lastName: "Elev", isActive: true, studentGroupId: "g-7a" },
    ];
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText("child-schedule c-2")).toBeInTheDocument();
    unmount();
    state.children = [
      { linkId: "l-1", id: "c-1", firstName: "Alva", lastName: "Elev", isActive: false, studentGroupId: "g-7a" },
    ];
    render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
  });

  it("is not there for another role or for a guardian without children", async () => {
    state.role = "SCHOOL_ADMIN";
    const { unmount } = render(<GuardianPage />);
    expect(await screen.findByText("guardian.reportTitle")).toBeInTheDocument();
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
    unmount();
    state.role = "GUARDIAN";
    state.children = [];
    render(<GuardianPage />);
    expect(screen.queryByText(/^child-schedule/)).not.toBeInTheDocument();
  });
});

/*
 * "Today" for a report or a leave is the child's school's day as the gateway
 * said it (schoolToday, removable), not the browser's: in New York at 20:00
 * Stockholm is already on tomorrow, in Bangkok at 03:00 still on yesterday.
 * The days below are far from any browser's today, so the page can only have
 * them from the gateway.
 */
describe("the school's day, not the browser's", () => {
  const report = (id: string, date: string, removable?: boolean) => ({
    id, studentId: "c-1", reportedById: "g-1", date, startTime: null, endTime: null, type: "SICK", note: null,
    createdAt: "2026-10-01T08:00:00Z", ...(removable === undefined ? {} : { removable }),
  });

  it("starts the report and the leave on the child's school's today, and offers no day before it", () => {
    state.children = [{ ...state.children[0]!, schoolToday: "2099-03-02" }, state.children[1]!];
    render(<GuardianPage />);
    const day = document.getElementById("absence-date") as HTMLInputElement;
    const start = document.getElementById("leave-start") as HTMLInputElement;
    expect([day.value, day.dataset["min"]]).toEqual(["2099-03-02", "2099-03-02"]);
    expect([start.value, start.dataset["min"]]).toEqual(["2099-03-02", "2099-03-02"]);
    expect((document.getElementById("leave-end") as HTMLInputElement).value).toBe("2099-03-02");
  });

  it("offers a withdrawal exactly where the gateway says one is possible", () => {
    // Every browser calls 2099 future and 2000 past; the gateway says the opposite.
    state.reports = [
      report("r-future", "2099-03-02", false),
      report("r-past", "2000-01-03", true),
      report("r-past-too", "2000-01-04", true),
    ];
    render(<GuardianPage />);
    expect(screen.getAllByRole("button", { name: "guardian.deleteReportNamed" })).toHaveLength(2);
  });

  it("decides by the child's today when an older gateway says nothing", () => {
    state.children = [{ ...state.children[0]!, schoolToday: "2099-03-02" }, state.children[1]!];
    state.reports = [report("r-today", "2099-03-02"), report("r-before", "2099-03-01")];
    render(<GuardianPage />);
    expect(screen.getAllByRole("button", { name: "guardian.deleteReportNamed" })).toHaveLength(1);
  });
});

describe("the guardian's delete confirmation", () => {
  it("says in the reader's language that it could not be opened when its chunk does not arrive", async () => {
    state.reports = [
      { id: "r-1", studentId: "c-1", reportedById: "g-1", date: "2099-03-02", startTime: null, endTime: null, type: "SICK", note: null, createdAt: "2099-03-01T08:00:00Z" },
    ];
    const user = userEvent.setup();
    render(<GuardianPage />);
    await user.click(screen.getByRole("button", { name: "guardian.deleteReportNamed" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("common.confirmLoadFailed"));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
  });
});

describe("a guardian with children at another school (Flera skolor per inloggning)", () => {
  const school = (name: string, extra: Partial<MySchool>): MySchool => ({
    schoolId: `${name}-id`,
    schoolName: name,
    role: "GUARDIAN",
    adminProfile: null,
    closed: null,
    current: false,
    ...extra,
  });

  it("names the other schools where the login is a guardian, not this one or one where it has another role", async () => {
    state.schools = [
      school("Ekbacken", { current: true }),
      school("Granen", {}),
      school("Hagen", { role: "TEACHER" }),
    ];
    render(<GuardianPage />);
    expect(await screen.findByText("other-schools Granen")).toBeInTheDocument();
  });

  it("names them also when this school has no child linked", async () => {
    state.children = [];
    state.schools = [school("Ekbacken", { current: true }), school("Granen", {})];
    render(<GuardianPage />);
    expect(await screen.findByText("other-schools Granen")).toBeInTheDocument();
    expect(screen.getByText("guardian.noChildrenTitle")).toBeInTheDocument();
  });

  it("shows no card for a guardian with one school", () => {
    state.schools = [school("Ekbacken", { current: true })];
    render(<GuardianPage />);
    expect(screen.queryByText(/other-schools/)).toBeNull();
  });
});
