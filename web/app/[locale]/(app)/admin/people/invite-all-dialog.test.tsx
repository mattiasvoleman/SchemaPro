import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { InvitationReport } from "@/lib/mass-invitation";
import { InviteAllDialog } from "./invite-all-dialog";

/**
 * The mass invitation's dialog (Första veckan utan operatören), in the real Swedish words: what it says before it starts, how far it has
 * got, why it stopped and what taking it up again does. What it sends and when it stops is lib/mass-invitation.ts's (its own test); what
 * is here is what the person sees and presses.
 */
const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i + 1}`);
const sentAll = (part: string[]): InvitationReport => ({ sent: part.length, alreadyRegistered: 0, errors: [] });

function setup(options: {
  count?: number;
  perHour?: number | null;
  pending?: string[][];
  send?: (part: string[]) => Promise<InvitationReport>;
} = {}) {
  const pendingReads = [...(options.pending ?? [ids(options.count ?? 45)])];
  const readPending = vi.fn(async () => pendingReads.shift() ?? []);
  const send = vi.fn(options.send ?? (async (part: string[]) => sentAll(part)));
  const onClose = vi.fn();
  const onRunEnded = vi.fn();
  const view = render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <InviteAllDialog open onClose={onClose} count={options.count ?? 45} perHour={options.perHour ?? null} send={send} readPending={readPending} onRunEnded={onRunEnded} />
    </NextIntlClientProvider>,
  );
  return { ...view, readPending, send, onClose, onRunEnded };
}

describe("InviteAllDialog", () => {
  it("says how long a run takes at the project's limit before it starts, and that it can be stopped and taken up again", () => {
    setup({ count: 300, perHour: 30 });

    expect(screen.getByRole("heading", { name: "Bjud in 300 personer" })).toBeInTheDocument();
    expect(screen.getByText(/Supabase släpper igenom 30 mejl i timmen, så 300 personer tar ungefär 10 timmar/)).toBeInTheDocument();
    expect(screen.getByText(/ingen får två inbjudningar/)).toBeInTheDocument();
  });

  it("says nothing of hours for a run that fits in the first, and says that nobody has stated the limit when nobody has", () => {
    const { unmount } = setup({ count: 20, perHour: 30 });
    expect(screen.queryByText(/tar ungefär/)).not.toBeInTheDocument();
    unmount();

    setup({ count: 20, perHour: null });
    expect(screen.getByText(/Ingen har uppgett hur många mejl i timmen/)).toBeInTheDocument();
  });

  it("sends the register's list in parts of twenty, shows the progress and says when it is done, and the register is read once at the end", async () => {
    const user = userEvent.setup();
    const { send, onRunEnded, readPending } = setup({ count: 45 });

    await user.click(screen.getByRole("button", { name: "Bjud in 45 personer" }));

    expect(await screen.findByText(/45 inbjudningar skickade\. Alla i urvalet är inbjudna\./)).toBeInTheDocument();
    expect(send.mock.calls.map(([part]) => part.length)).toEqual([20, 20, 5]);
    expect(readPending).toHaveBeenCalledTimes(1);
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(screen.getByText("45 av 45")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Inbjudningar" });
    expect(bar).toHaveAttribute("aria-valuenow", "45");
    expect(bar).toHaveAttribute("aria-valuemax", "45");
    // Done: nothing more to start, and the way out says Stäng.
    expect(screen.queryByRole("button", { name: "Ta om" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Klart" })).toBeInTheDocument();
  });

  it("counts the people it did not invite for a reason, each in its own line", async () => {
    const user = userEvent.setup();
    setup({
      count: 4,
      send: async () => ({ sent: 1, alreadyRegistered: 1, alreadyInvited: 1, noAddress: 1, errors: [] }),
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 4 personer" }));

    expect(await screen.findByText("1 inbjudan skickad")).toBeInTheDocument();
    expect(screen.getByText("1 hade redan ett konto: inget mejl skickades")).toBeInTheDocument();
    expect(screen.getByText("1 var redan inbjuden och fick ingen ny")).toBeInTheDocument();
    expect(screen.getByText("1 saknar e-postadress och kan inte bjudas in")).toBeInTheDocument();
  });

  it("pauses when the project's mail limit is spent, says how many are left, and takes up again from the register's own list", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { send, readPending, onRunEnded } = setup({
      count: 60,
      // The first read: sixty. The second, after the pause, what the register says is left: the thirty who were not invited.
      pending: [ids(60), ids(60).slice(30)],
      send: async (part) => {
        calls += 1;
        // The second part meets the limit after ten of its twenty.
        return calls === 2 ? { sent: 10, alreadyRegistered: 0, errors: [], stopped: "RATE_LIMITED", notTried: 10 } : sentAll(part);
      },
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 60 personer" }));

    expect(await screen.findByText("Supabase har nått sin gräns för mejl")).toBeInTheDocument();
    // Twenty went out, and ten of the second part's twenty before the limit: thirty are left.
    expect(screen.getByText(/30 personer återstår/)).toBeInTheDocument();
    expect(screen.getByText("30 av 60")).toBeInTheDocument();
    expect(onRunEnded).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Ta om" }));

    expect(await screen.findByText(/Alla i urvalet är inbjudna/)).toBeInTheDocument();
    expect(readPending).toHaveBeenCalledTimes(2);
    // What the first run did stays in the sums: the run on the screen is one run. 30 (the first part and ten of the second) + 30.
    expect(screen.getByText("60 av 60")).toBeInTheDocument();
    expect(screen.getByText("60 inbjudningar skickade")).toBeInTheDocument();
    expect(onRunEnded).toHaveBeenCalledTimes(2);
  });

  it("pauses on a call that failed, with the words of the failure, and says that Ta om reads the register again", async () => {
    const user = userEvent.setup();
    const { onRunEnded } = setup({
      count: 40,
      send: async (part) => {
        if (part[0] === "id-21") throw new Error("HTTP 503");
        return sentAll(part);
      },
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 40 personer" }));

    expect(await screen.findByText("Det gick inte att fortsätta")).toBeInTheDocument();
    expect(screen.getByText(/Anropet misslyckades \(HTTP 503\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ta om" })).toBeEnabled();
    expect(onRunEnded).toHaveBeenCalledTimes(1);
  });

  it("is stopped by Stoppa after the part that is running, with what went out kept, and taken up again from there", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const { send } = setup({
      count: 60,
      pending: [ids(60), ids(60).slice(20)],
      send: async (part) => {
        calls += 1;
        if (calls === 1) await gate;
        return sentAll(part);
      },
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 60 personer" }));
    await user.click(await screen.findByRole("button", { name: "Stoppa" }));
    release();

    expect(await screen.findByText(/Stoppad\. 40 personer återstår/)).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Ta om" }));
    expect(await screen.findByText(/Alla i urvalet är inbjudna/)).toBeInTheDocument();
    expect(screen.getByText("60 av 60")).toBeInTheDocument();
  });

  it("says that the register could not be read when it could not, and starts nothing", async () => {
    const user = userEvent.setup();
    const { send, readPending } = setup({ count: 10 });
    readPending.mockRejectedValueOnce(new Error("HTTP 500"));

    await user.click(screen.getByRole("button", { name: "Bjud in 10 personer" }));

    await waitFor(() => expect(readPending).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bjud in 10 personer" })).toBeEnabled();
  });

  it("does not say that everybody is invited when some could not be: it says how many, offers Ta om, and counts those people once when they go", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { send, readPending } = setup({
      count: 40,
      // The second read, for Ta om: what the register says is still to do, the two who failed.
      pending: [ids(40), ["id-3", "id-27"]],
      send: async (part) => {
        calls += 1;
        // The first run: two of the forty are refused by the provider (a bad address, say).
        if (calls <= 2) {
          const bad = part.filter((id) => id === "id-3" || id === "id-27");
          return { sent: part.length - bad.length, alreadyRegistered: 0, errors: bad.map((userId) => ({ userId, message: "Kunde inte skicka" })) };
        }
        return sentAll(part);
      },
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 40 personer" }));

    expect(await screen.findByText(/2 personer kunde inte bjudas in: tryck Ta om/)).toBeInTheDocument();
    expect(screen.queryByText(/Alla i urvalet är inbjudna/)).not.toBeInTheDocument();
    expect(screen.getByText("38 inbjudningar skickade")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ta om" }));

    expect(await screen.findByText(/Alla i urvalet är inbjudna/)).toBeInTheDocument();
    expect(readPending).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(3);
    // Forty people, not forty-two: the two who failed were handled once, and are counted once when they went.
    expect(screen.getByText("40 av 40")).toBeInTheDocument();
    expect(screen.getByText("40 inbjudningar skickade")).toBeInTheDocument();
    expect(screen.queryByText(/kunde inte skickas/)).not.toBeInTheDocument();
  });

  it("cannot be closed while a part is on its way, and can before and after", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { onClose } = setup({ count: 10, send: async (part) => { await gate; return sentAll(part); } });

    await user.click(screen.getByRole("button", { name: "Bjud in 10 personer" }));
    await screen.findByRole("button", { name: "Stoppa" });
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    release();
    await screen.findByText(/Alla i urvalet är inbjudna/);
    await user.click(screen.getByRole("button", { name: "Klart" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The page mounts the dialog while it is open and drops it on onClose (people/page.tsx): a dialog that is gone has no Stoppa.
  it("sends nothing more once the page has been left: a run does not go on where nobody can see it or stop it", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const { send, unmount, onRunEnded } = setup({
      count: 60,
      send: async (part) => {
        calls += 1;
        if (calls === 1) await gate;
        return sentAll(part);
      },
    });

    await user.click(screen.getByRole("button", { name: "Bjud in 60 personer" }));
    await screen.findByRole("button", { name: "Stoppa" });
    unmount();
    release();

    await waitFor(() => expect(onRunEnded).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when Avbryt was pressed while the register was being read", async () => {
    const user = userEvent.setup();
    let release!: (ids: string[]) => void;
    const read = new Promise<string[]>((resolve) => (release = resolve));
    const readPending = vi.fn(() => read);
    const send = vi.fn(async (part: string[]) => sentAll(part));
    function Page() {
      const [open, setOpen] = useState(true);
      return open ? (
        <InviteAllDialog open onClose={() => setOpen(false)} count={30} perHour={null} send={send} readPending={readPending} onRunEnded={() => undefined} />
      ) : null;
    }
    render(
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <Page />
      </NextIntlClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Bjud in 30 personer" }));
    await waitFor(() => expect(readPending).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Avbryt" }));
    release(ids(30));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(send).not.toHaveBeenCalled();
  });
});
