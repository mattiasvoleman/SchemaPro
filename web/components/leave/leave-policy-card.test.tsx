import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeavePolicy } from "@/lib/types";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { LeavePolicyCard } from "./leave-policy-card";

/**
 * "Så tar skolan emot ledighetsansökningar" (Ledighetspolicy, K4), with the
 * real messages: the school's three choices, all off as delivered. Every
 * administrator reads them; saving is a decider's (rektor, full), as the
 * delegation beside it is.
 */

const save = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const read = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false, isError: false }));
vi.mock("@/lib/leave-policy-queries", () => ({ useLeavePolicy: () => read, useSaveLeavePolicy: () => save }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DELIVERED: LeavePolicy = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };

function renderCard(decides = true, language: "sv" | "en" = "sv") {
  return render(
    <NextIntlClientProvider locale={language} messages={language === "sv" ? sv : en} timeZone="Europe/Stockholm">
      <LeavePolicyCard decides={decides} />
    </NextIntlClientProvider>,
  );
}

const consent = () => screen.getByRole("checkbox", { name: "Be alla vårdnadshavare samtycka" });
const minimum = () => screen.getByRole("textbox", { name: "Minsta antal dagar före första dagen" });
const late = () => screen.getByRole("combobox", { name: "En ansökan som kommer för sent" });
const contact = () => screen.getByRole("combobox", { name: "Kontakt under ledigheten" });
const saveButton = () => screen.getByRole("button", { name: "Spara valen" });

beforeEach(() => {
  vi.clearAllMocks();
  read.data = DELIVERED;
  read.isLoading = false;
  read.isError = false;
  save.isPending = false;
  save.mutateAsync.mockResolvedValue(DELIVERED);
});

describe("the card as delivered", () => {
  it("is a named section that shows every choice off, in words, with what each does", () => {
    renderCard();
    expect(screen.getByRole("region", { name: "Så tar skolan emot ledighetsansökningar" })).toBeInTheDocument();
    expect(screen.getByText(/Valen gäller ansökningar som skrivs efter att du har sparat/)).toBeInTheDocument();
    expect(consent()).not.toBeChecked();
    expect(consent()).toHaveAccessibleDescription(/Den som ansökte räknas som att ha samtyckt, och de andra får en notis\. Ett nej avslutar ansökan\./);
    expect(minimum()).toHaveValue("");
    expect(minimum()).toHaveAccessibleDescription("Kalenderdagar, 1 till 90. Lämna tomt för inget minimum.");
    expect(contact()).toHaveValue("OFF");
    expect(contact()).toHaveAccessibleDescription(/tillhör en tredje part och syns bara för familjen, administratörer och mentorn som beslutar, aldrig i notiser eller e-post/);
  });

  it("offers the choice for a late request only once a minimum is set", async () => {
    const user = userEvent.setup();
    renderCard();
    expect(late()).toBeDisabled();
    expect(late()).toHaveValue("REFUSE");
    await user.type(minimum(), "14");
    expect(late()).toBeEnabled();
    expect(Array.from((late() as HTMLSelectElement).options).map((option) => option.text)).toEqual([
      "Neka – formuläret tar inte emot den",
      "Flagga – den som beslutar ser att den kom sent",
    ]);
  });

  it("offers the three contact choices, off first", () => {
    renderCard();
    expect(Array.from((contact() as HTMLSelectElement).options).map((option) => option.value)).toEqual(["OFF", "OPTIONAL", "REQUIRED"]);
  });

  it("has nothing to save until something is changed", () => {
    renderCard();
    expect(saveButton()).toBeDisabled();
  });
});

describe("what is saved", () => {
  it("is the whole policy, with the choice made, and the save is said", async () => {
    const user = userEvent.setup();
    save.mutateAsync.mockResolvedValue({ requireAllGuardians: true, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" });
    renderCard();
    await user.click(consent());
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalledWith({ requireAllGuardians: true, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" }));
    expect(toast.success).toHaveBeenCalledWith("Skolans val är sparade");
    // What was saved is what the card shows now, so there is nothing left to save.
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it("carries a minimum of 1 to 90 whole days, a flagged late request and a required contact", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(minimum(), " 14 ");
    await user.selectOptions(late(), "FLAG");
    await user.selectOptions(contact(), "REQUIRED");
    await user.click(saveButton());
    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalledWith({ requireAllGuardians: false, minDaysAhead: 14, shortNotice: "FLAG", contact: "REQUIRED" }));
  });

  it.each(["1", "90"])("takes %s days", async (days) => {
    const user = userEvent.setup();
    renderCard();
    await user.type(minimum(), days);
    await user.click(saveButton());
    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ minDaysAhead: Number(days) })));
  });

  it.each(["0", "91", "1.5", "tio", "-3", "1e1"])("refuses %s days with a message, and saves nothing", async (text) => {
    const user = userEvent.setup();
    renderCard();
    await user.type(minimum(), text);
    expect(await screen.findByRole("alert")).toHaveTextContent("Skriv ett heltal från 1 till 90, eller lämna tomt.");
    expect(minimum()).toBeInvalid();
    expect(saveButton()).toBeDisabled();
  });

  it("takes the minimum away again with an empty field, which is no minimum", async () => {
    const user = userEvent.setup();
    read.data = { ...DELIVERED, minDaysAhead: 7, shortNotice: "FLAG" };
    renderCard();
    expect(minimum()).toHaveValue("7");
    await user.clear(minimum());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalledWith({ requireAllGuardians: false, minDaysAhead: null, shortNotice: "FLAG", contact: "OFF" }));
  });

  it("shows the choices the school has made", () => {
    read.data = { requireAllGuardians: true, minDaysAhead: 30, shortNotice: "FLAG", contact: "OPTIONAL" };
    renderCard();
    expect(consent()).toBeChecked();
    expect(minimum()).toHaveValue("30");
    expect(late()).toHaveValue("FLAG");
    expect(contact()).toHaveValue("OPTIONAL");
  });

  it("is not saved by changing something back to what it was", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(consent());
    await user.click(consent());
    expect(saveButton()).toBeDisabled();
  });

  it("says the gateway's own words when the save fails, and keeps what was chosen", async () => {
    const user = userEvent.setup();
    save.mutateAsync.mockRejectedValue(new Error("Only the administrator who decides may change the policy."));
    renderCard();
    await user.click(consent());
    await user.click(saveButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Only the administrator who decides may change the policy."));
    expect(consent()).toBeChecked();
    expect(saveButton()).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("holds the button while the save is on its way, and says so", () => {
    save.isPending = true;
    renderCard();
    expect(screen.getByRole("button", { name: "Sparar …" })).toBeDisabled();
  });

  it("marks the save as a decision, and the choices as inert for a profile that does not decide", () => {
    renderCard();
    expect(saveButton()).toHaveAttribute("data-writes", "DECIDES");
    expect(consent().closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "DECIDES");
  });
});

describe("for an administrator who does not decide", () => {
  it("shows what was chosen, changes nothing, and says who may", () => {
    read.data = { requireAllGuardians: true, minDaysAhead: 30, shortNotice: "FLAG", contact: "REQUIRED" };
    renderCard(false);
    expect(consent()).toBeChecked();
    for (const control of [consent(), minimum(), late(), contact()]) expect(control).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Spara valen" })).not.toBeInTheDocument();
    expect(screen.getByText("Bara rektor eller en fullständig administratör ändrar de här valen. Du kan läsa dem.")).toBeInTheDocument();
  });

  it("does not offer that sentence to one who decides", () => {
    renderCard(true);
    expect(screen.queryByText(/Bara rektor eller en fullständig administratör/)).not.toBeInTheDocument();
  });
});

describe("while it is read", () => {
  it("is busy while the choices load, and offers neither a choice nor a save", () => {
    read.data = undefined;
    read.isLoading = true;
    const { container } = renderCard();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says the choices could not be read, never that nothing is chosen", () => {
    read.data = undefined;
    read.isError = true;
    renderCard();
    expect(screen.getByRole("alert")).toHaveTextContent("Skolans val kunde inte hämtas");
    expect(screen.getByRole("alert")).toHaveTextContent("Inget val är ändrat.");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Spara valen" })).not.toBeInTheDocument();
  });
});

it("is said in English as well", () => {
  renderCard(true, "en");
  expect(screen.getByRole("region", { name: "How the school receives leave requests" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Ask every guardian to consent" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "A request that comes too late" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save the choices" })).toBeDisabled();
});
