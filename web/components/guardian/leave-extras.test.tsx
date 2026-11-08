import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { EMPTY_CONTACT, contactProblem } from "@/lib/leave-policy";
import type { LeaveContact, LeavePolicy, LeaveRequest } from "@/lib/types";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { LeavePolicyFields, LeaveRowExtras } from "./leave-extras";

/**
 * What the school's leave policy (Ledighetspolicy, K4) adds to the guardian's
 * form and list, with the real messages: the minimum explained, the contact asked
 * for as the policy says, and the question to a guardian the school waits for.
 * A guardian's answer is final and a no ends the request for everybody, so the
 * no is asked about first; nothing here ever says who answered what.
 */

const answer = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock("@/lib/leave-consent-queries", () => ({ useAnswerLeaveConsent: () => answer }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const POLICY: LeavePolicy = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };
const FULL: LeaveContact = { name: "Maria Ek", phone: "070-123 45 67", relation: "Mormor" };

const intl = (language: "sv" | "en", children: React.ReactNode) => (
  <NextIntlClientProvider locale={language} messages={language === "sv" ? sv : en} timeZone="Europe/Stockholm">
    {children}
  </NextIntlClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  answer.isPending = false;
  answer.mutateAsync.mockResolvedValue({ id: "l-1", answer: "GIVEN", state: "WAITING" });
});

/** The form's part with its own contact state, as the page holds it. */
function Fields({ policy, initial = EMPTY_CONTACT }: { policy: LeavePolicy; initial?: LeaveContact }) {
  const [contact, setContact] = useState(initial);
  return <LeavePolicyFields policy={policy} contact={contact} problem={contactProblem(policy.contact, contact)} onChange={setContact} />;
}

describe("the form's part", () => {
  it("explains the minimum in days, and that a later request is refused", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, minDaysAhead: 14 }} />));
    expect(screen.getByText("Ansök minst 14 dagar före första dagen. En ansökan som kommer senare går inte att skicka.")).toBeInTheDocument();
  });

  it("explains that a later request is only flagged for whoever decides, when the school chose that", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, minDaysAhead: 1, shortNotice: "FLAG" }} />));
    expect(
      screen.getByText("Ansök minst 1 dag före första dagen. Kommer ansökan senare flaggas den för den som beslutar."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/går inte att skicka/)).not.toBeInTheDocument();
  });

  it("says that an unset minimum means nothing, whatever the choice for a later request", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, shortNotice: "FLAG", contact: "OPTIONAL" }} />));
    expect(screen.queryByText(/Ansök minst/)).not.toBeInTheDocument();
    expect(screen.queryByText(/flaggas/)).not.toBeInTheDocument();
  });

  it("says that every guardian is asked to consent, and that the others get a notice", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, requireAllGuardians: true }} />));
    expect(
      screen.getByText("Skolan ber alla vårdnadshavare samtycka innan ansökan går till beslut. Eventuella andra vårdnadshavare får en notis."),
    ).toBeInTheDocument();
  });

  it("asks for no contact when the school does not", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, minDaysAhead: 7 }} />));
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("asks for a required contact in three labelled fields, each marked required, with the third party's privacy said", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "REQUIRED" }} />));
    const group = screen.getByRole("group", { name: "Kontakt under ledigheten (obligatorisk)" });
    for (const label of ["Namn", "Telefon", "Relation till barnet"]) {
      expect(within(group).getByRole("textbox", { name: label })).toBeRequired();
    }
    expect(within(group).getByRole("textbox", { name: "Telefon" })).toHaveAttribute("type", "tel");
    // Said before the reader types, and linked to the group.
    expect(group).toHaveAccessibleDescription(/syns bara för er familj, skolans administratörer och mentorn som beslutar, och skickas aldrig i notiser eller e-post/);
  });

  it("asks for an optional contact as optional, with fields that are not required", () => {
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "OPTIONAL" }} />));
    expect(screen.getByRole("group", { name: "Kontakt under ledigheten (valfritt)" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Namn" })).not.toBeRequired();
  });

  it("holds what is typed, with the gateway's lengths", async () => {
    const user = userEvent.setup();
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "OPTIONAL" }} />));
    await user.type(screen.getByRole("textbox", { name: "Namn" }), "Maria Ek");
    expect(screen.getByRole("textbox", { name: "Namn" })).toHaveValue("Maria Ek");
    expect(screen.getByRole("textbox", { name: "Namn" })).toHaveAttribute("maxlength", "100");
    expect(screen.getByRole("textbox", { name: "Telefon" })).toHaveAttribute("maxlength", "30");
    expect(screen.getByRole("textbox", { name: "Relation till barnet" })).toHaveAttribute("maxlength", "60");
  });

  it("tells a problem with the contact only after the reader has left the fields, as an alert", async () => {
    const user = userEvent.setup();
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "REQUIRED" }} />));
    await user.type(screen.getByRole("textbox", { name: "Namn" }), "Maria Ek");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Fyll i namn, telefon och relation till barnet, eller lämna alla tre tomma.");
  });

  it("says a required contact is missing when the reader leaves the fields empty", async () => {
    const user = userEvent.setup();
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "REQUIRED" }} />));
    await user.click(screen.getByRole("textbox", { name: "Namn" }));
    await user.tab();
    await user.tab();
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Skolan kräver en kontakt under ledigheten.");
  });

  it("names a phone number the gateway would refuse, on the phone field", async () => {
    const user = userEvent.setup();
    render(intl("sv", <Fields policy={{ ...POLICY, contact: "OPTIONAL" }} initial={{ ...FULL, phone: "123" }} />));
    await user.click(screen.getByRole("textbox", { name: "Namn" }));
    await user.tab();
    await user.tab();
    await user.tab();
    const phone = screen.getByRole("textbox", { name: "Telefon" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Skriv telefonnumret med siffror, mellanslag och tecknen + ( ) -, 5 till 30 tecken.");
    expect(phone).toBeInvalid();
    expect(phone).toHaveAccessibleDescription(/Skriv telefonnumret/);
  });

  it("is said in English as well", () => {
    render(intl("en", <Fields policy={{ ...POLICY, minDaysAhead: 7, shortNotice: "FLAG", contact: "REQUIRED" }} />));
    expect(
      screen.getByText("Apply at least 7 days before the first day. If a request comes later, it is flagged for whoever decides."),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Contact during the leave (required)" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Relation to the child" })).toBeRequired();
  });
});

const NO_CONSENT: LeaveRequest["consent"] = { required: false, state: "NOT_REQUIRED", mine: "NOT_ASKED", asked: null, given: null, waiting: null };
const leave = (over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id: "l-1",
  studentId: "c-1",
  requestedById: "g-1",
  startDate: "2026-10-19",
  endDate: "2026-10-21",
  reason: "Resa",
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
const consentOf = (state: LeaveRequest["consent"]["state"], mine: LeaveRequest["consent"]["mine"]): LeaveRequest["consent"] => ({
  ...NO_CONSENT,
  required: true,
  state,
  mine,
});
const row = (request: LeaveRequest, language: "sv" | "en" = "sv") =>
  render(intl(language, <LeaveRowExtras leave={request} name="Ella Nord" span="19–21 okt 2026" />));

describe("the list's part: where the consent stands", () => {
  it("says a request waits for the guardians' consent, to whoever applied, and offers no answer", () => {
    row(leave({ consent: consentOf("WAITING", "NOT_ASKED") }));
    expect(screen.getByText("Väntar på vårdnadshavarnas samtycke")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says every guardian has consented while the request waits for its decision", () => {
    row(leave({ consent: consentOf("GIVEN", "NOT_ASKED") }));
    expect(screen.getByText("Alla vårdnadshavare har samtyckt")).toBeInTheDocument();
    expect(screen.queryByText("Väntar på vårdnadshavarnas samtycke")).not.toBeInTheDocument();
  });

  it("says a request a guardian's no ended is ended, and never who", () => {
    const { container } = row(
      leave({ status: "GUARDIAN_DECLINED", requestedBy: "Gun Berg", consent: consentOf("REFUSED", "NOT_ASKED") } as Partial<LeaveRequest>),
    );
    expect(screen.getByText("Avslutad: en vårdnadshavare samtyckte inte")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Gun|Berg/);
  });

  it("says nothing of consent on a request already decided", () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const { container, unmount } = row(leave({ status, consent: consentOf("GIVEN", "GIVEN") }));
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("tells a guardian their own answer is final, whichever it was", () => {
    const { unmount } = row(leave({ consent: consentOf("WAITING", "GIVEN") }));
    expect(screen.getByText("Du har samtyckt. Svaret kan inte ändras.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    row(leave({ status: "GUARDIAN_DECLINED", consent: consentOf("REFUSED", "REFUSED") }));
    expect(screen.getByText("Du har inte samtyckt. Svaret kan inte ändras.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("tells a guardian whose custody has ended that the request does not wait for them, with no answer to give", () => {
    row(leave({ consent: consentOf("WAITING", "ENDED") }));
    expect(screen.getByText("Din vårdnad har upphört, så ansökan väntar inte på ditt svar.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers no answer on a request that is no longer open, even if the row still says the guardian is waited for", () => {
    row(leave({ status: "APPROVED", consent: consentOf("WAITING", "WAITING") }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the contact the family wrote as a plain line, with its name, relation and phone", () => {
    row(leave({ contact: FULL }));
    expect(screen.getByText("Kontakt under ledigheten").parentElement).toHaveTextContent("Kontakt under ledigheten: Maria Ek (Mormor), 070-123 45 67");
  });

  it("is said in English as well", () => {
    row(leave({ contact: FULL, consent: consentOf("WAITING", "NOT_ASKED") }), "en");
    expect(screen.getByText("Waiting for the guardians’ consent")).toBeInTheDocument();
    expect(screen.getByText("Contact during the leave").parentElement).toHaveTextContent("Contact during the leave: Maria Ek (Mormor), 070-123 45 67");
  });

  it("does not break on a request from a gateway older than the feature", () => {
    const { container } = row({ ...leave(), consent: undefined, contact: undefined } as unknown as LeaveRequest);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the list's part: the question to a guardian the school waits for", () => {
  const ask = () => row(leave({ consent: consentOf("WAITING", "WAITING") }));
  const yes = () => screen.getByRole("button", { name: "Samtycker, Ella Nord, 19–21 okt 2026" });
  const no = () => screen.getByRole("button", { name: "Samtycker inte, Ella Nord, 19–21 okt 2026" });

  it("asks, says that a no ends the request and that the answer cannot be changed, and names each button after the child and the days", () => {
    ask();
    const group = screen.getByRole("group", { name: "Skolan ber dig samtycka" });
    expect(group).toHaveTextContent("Ansökan går till beslut först när alla vårdnadshavare har samtyckt. Säger du nej avslutas ansökan. Du kan inte ändra svaret efteråt.");
    expect(within(group).getByRole("button", { name: /^Samtycker,/ })).toHaveTextContent("Samtycker");
    expect(within(group).getByRole("button", { name: /^Samtycker inte,/ })).toHaveTextContent("Samtycker inte");
    // The row also says the request waits, for whoever reads it with a screen reader line by line.
    expect(screen.getByText("Väntar på vårdnadshavarnas samtycke")).toBeInTheDocument();
  });

  it("sends a yes at once and says it is recorded", async () => {
    const user = userEvent.setup();
    ask();
    await user.click(yes());
    await waitFor(() => expect(answer.mutateAsync).toHaveBeenCalledWith({ id: "l-1", consent: true }));
    expect(toast.success).toHaveBeenCalledWith("Tack, ditt samtycke är registrerat");
  });

  it("asks before a no, with focus on the question, and sends nothing until it is confirmed", async () => {
    const user = userEvent.setup();
    ask();
    await user.click(no());
    const question = screen.getByText("Samtycker du inte till ansökan?");
    expect(question).toHaveFocus();
    expect(screen.getByText("Ansökan avslutas för alla och går inte vidare till beslut. Du kan inte ändra svaret efteråt.")).toBeInTheDocument();
    // The yes and the first button are gone: only the confirmation and the way back.
    expect(screen.queryByRole("button", { name: /^Samtycker/ })).not.toBeInTheDocument();
    expect(answer.mutateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Ja, jag samtycker inte/ }));
    await waitFor(() => expect(answer.mutateAsync).toHaveBeenCalledWith({ id: "l-1", consent: false }));
    expect(toast.success).toHaveBeenCalledWith("Ditt svar är registrerat. Ansökan är avslutad.");
  });

  it("names the confirmation after the child and the days for a screen reader", async () => {
    const user = userEvent.setup();
    ask();
    await user.click(no());
    expect(screen.getByRole("button", { name: "Ja, jag samtycker inte, Ella Nord, 19–21 okt 2026" })).toBeInTheDocument();
  });

  it("takes the no back before it is sent, and returns to the button that asked", async () => {
    const user = userEvent.setup();
    ask();
    await user.click(no());
    await user.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(answer.mutateAsync).not.toHaveBeenCalled();
    expect(yes()).toBeInTheDocument();
    await waitFor(() => expect(no()).toHaveFocus());
  });

  it("holds every button while an answer is on its way", async () => {
    answer.isPending = true;
    ask();
    expect(yes()).toBeDisabled();
    expect(no()).toBeDisabled();
  });

  it.each([
    ["the other answer already given", new ApiError(409, "x", "LEAVE_CONSENT_ANSWERED"), "Du har redan svarat på ansökan. Svaret kan inte ändras."],
    ["a request decided or ended in between", new ApiError(409, "x", "LEAVE_CONSENT_REQUEST_ENDED"), "Ansökan är redan beslutad eller avslutad. Listan är uppdaterad."],
    ["custody that has ended", new ApiError(409, "x", "LEAVE_CONSENT_CUSTODY_ENDED"), "Din vårdnad har upphört, så du kan inte längre svara."],
    ["a question never asked", new ApiError(404, "x", "LEAVE_CONSENT_NOT_FOUND"), "Skolan har inte bett dig samtycka till den här ansökan."],
    ["a caller who is no guardian", new ApiError(403, "x", "LEAVE_CONSENT_NOT_A_GUARDIAN"), "Bara en vårdnadshavare kan svara på den här frågan."],
  ])("says in the guardian's language why the answer was refused for %s, and closes the question", async (_what, error, said) => {
    answer.mutateAsync.mockRejectedValue(error);
    const user = userEvent.setup();
    ask();
    await user.click(no());
    await user.click(screen.getByRole("button", { name: /^Ja, jag samtycker inte/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(said));
    expect(toast.error).not.toHaveBeenCalledWith("x");
    // Back to the two answers, for the list that is read again to settle.
    expect(await screen.findByRole("button", { name: /^Samtycker,/ })).toBeInTheDocument();
  });

  it("is asked in English as well", () => {
    row(leave({ consent: consentOf("WAITING", "WAITING") }), "en");
    expect(screen.getByRole("button", { name: "Consent, Ella Nord, 19–21 okt 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do not consent, Ella Nord, 19–21 okt 2026" })).toBeInTheDocument();
  });
});
