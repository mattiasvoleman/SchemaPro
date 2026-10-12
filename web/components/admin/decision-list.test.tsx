import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { DecisionList, type DecisionRequest } from "./decision-list";

/**
 * The inbox Lokalbokningar and Ledighetsansökningar share: a labelled note
 * per request, Godkänn at once, Avslå only after a question (the requester is
 * told, and a decision cannot be changed), and only the request being decided
 * waits.
 */

const request = (id: string, name: string, open = true): DecisionRequest => ({
  id,
  title: name,
  name,
  details: [`${name} detail`],
  open,
  status: { label: open ? "Väntar" : "Godkänd", variant: open ? "warning" : "success" },
});

function renderList(props: Partial<React.ComponentProps<typeof DecisionList>> = {}) {
  const onDecide = vi.fn().mockResolvedValue(undefined);
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <DecisionList
        id="requests"
        title="Väntar på beslut"
        requests={[request("r-1", "Sal 12"), request("r-2", "Musiksalen"), request("r-3", "Aulan", false)]}
        labels={{ approve: "Godkänn", reject: "Avslå", note: "Anteckning till läraren" }}
        rejectCopy={(item) => ({ title: `Avslå ${item.name}?`, body: "Läraren får beskedet." })}
        deciding={null}
        onDecide={onDecide}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return onDecide;
}

describe("DecisionList", () => {
  it("is a named section whose note fields are labelled after their request", () => {
    renderList();
    expect(screen.getByRole("region", { name: "Väntar på beslut" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Anteckning till läraren, Sal 12/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Anteckning till läraren, Musiksalen/ })).toBeInTheDocument();
    // A decided request shows its state, not the controls.
    const decided = screen.getByText("Aulan").closest("li")!;
    expect(within(decided).getByText("Godkänd")).toBeInTheDocument();
    expect(within(decided).queryByRole("button")).not.toBeInTheDocument();
  });

  it("approves at once with the note written for that request", async () => {
    const user = userEvent.setup();
    const onDecide = renderList();
    await user.type(screen.getByRole("textbox", { name: /Sal 12/ }), "Nyckeln i receptionen");
    await user.click(screen.getByRole("button", { name: "Godkänn Sal 12" }));
    expect(onDecide).toHaveBeenCalledWith("r-1", "APPROVED", "Nyckeln i receptionen");
  });

  it("asks before rejecting, and sends nothing until the question is answered", async () => {
    const user = userEvent.setup();
    const onDecide = renderList();
    await user.click(screen.getByRole("button", { name: "Avslå Musiksalen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Avslå Musiksalen?");
    expect(onDecide).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Avslå" }));
    expect(onDecide).toHaveBeenCalledWith("r-2", "REJECTED", undefined);
  });

  it("holds only the request being decided", () => {
    renderList({ deciding: "r-1" });
    expect(screen.getByRole("button", { name: "Godkänn Sal 12" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Avslå Sal 12" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Godkänn Musiksalen" })).toBeEnabled();
  });
});
