import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { mineItem, page } from "@/lib/__fixtures__/ack";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import GuardianAcknowledgementsPage from "./page";

/**
 * /guardian/acknowledgements: the guardian's own messages from the school and
 * the button that says they have taken part of them, through the gateway's
 * routes and the real Swedish messages.
 *
 * What this guards: the guardian is never told anything about the other
 * guardian; a tap sends once, the button is closed while it is on its way, and
 * what takes its place is the moment the gateway answered and has focus; a
 * custody that has ended (409) or a message that is gone (404) is said as that
 * and the list is read again; any other failure leaves the button to try again;
 * the list comes a page at a time, "Visa äldre" asks for the next, the count of
 * waiting messages says it counts the ones shown while more exist, and a page
 * that cannot be read leaves the cards already loaded.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const MINE = "/api/v1/acknowledgements/mine";

const state = vi.hoisted(() => ({
  list: [] as Array<{ id: string }>,
  /** The gateway answers this many at a time. */
  pageSize: 50,
  listError: false,
  /** Every page after the first cannot be read. */
  moreError: false,
  hold: null as null | Promise<void>,
}));

// The time of a confirmation, written the way the page writes one (the browser's zone is UTC here).
const momentText = (iso: string) =>
  new Intl.DateTimeFormat("sv", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <GuardianAcknowledgementsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The page the gateway answers for a read of the list: `pageSize` messages after the id in `?after=`. */
function listPage(path: string) {
  const after = new URL(path, "http://gateway").searchParams.get("after");
  if (after && state.moreError) throw new ApiError(500, "boom");
  const from = after ? state.list.findIndex((one) => one.id === after) + 1 : 0;
  const items = state.list.slice(from, from + state.pageSize);
  return page(items, from + state.pageSize < state.list.length ? items[items.length - 1]!.id : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.list = [];
  state.pageSize = 50;
  state.listError = false;
  state.moreError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (path !== MINE && !path.startsWith(`${MINE}?`)) throw new Error(`unexpected read ${path}`);
    if (state.listError) throw new ApiError(500, "boom");
    return listPage(path);
  });
  api.post.mockResolvedValue({ ackedAt: "2026-11-06T09:41:00.000Z" });
});

const confirmButton = (name = "Jag har tagit del av detta") => screen.findByRole("button", { name });

describe("the guardian's messages", () => {
  it("is headed Kvittens, reads their own list alone, and welcomes an empty one", async () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Kvittens" })).toBeInTheDocument();
    expect(await screen.findByText("Inga meddelanden att bekräfta")).toBeInTheDocument();
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([MINE]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says a failed read as such and never as 'nothing here'", async () => {
    state.listError = true;
    renderPage();

    expect(await screen.findByText("Meddelandena kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Inga meddelanden att bekräfta")).not.toBeInTheDocument();
  });

  it("shows who it is from, when, which children it concerns and the text as the sender wrote it", async () => {
    state.list = [
      mineItem({
        title: "Utflykten på torsdag",
        children: [
          { id: "p-ada", name: "Ada Berg" },
          { id: "p-leo", name: "Leo Berg" },
        ],
      }),
    ];
    renderPage();

    const card = (await screen.findByRole("article", { name: "Utflykten på torsdag" })) as HTMLElement;
    expect(card).toHaveTextContent(`Från Anna Lind, ${momentText("2026-11-05T08:30:00.000Z")}`);
    expect(card).toHaveTextContent("Gäller Ada Berg och Leo Berg");
    // Line breaks the sender wrote are kept.
    const text = within(card).getByText(/Vi åker kl 8\./);
    expect(text.textContent).toBe("Vi åker kl 8.\nTa med matsäck.");
    expect(text).toHaveClass("whitespace-pre-wrap");
    expect(within(card).getByText("Väntar på dig")).toBeInTheDocument();
  });

  it("says only that the school asks all guardians when it does, and nothing of the other guardian in either rule", async () => {
    state.list = [
      mineItem({ id: "r-1", title: "Beslutet om ledighet", rule: "ALL" }),
      mineItem({ id: "r-2", title: "Utflykten på torsdag", rule: "ANY" }),
      mineItem({ id: "r-3", title: "Larmet", rule: "ALL", ackedAt: "2026-11-05T10:00:00.000Z" }),
    ];
    renderPage();

    const all = await screen.findByRole("article", { name: "Beslutet om ledighet" });
    expect(within(all).getByText("Skolan ber alla vårdnadshavare bekräfta.")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Larmet" })).toHaveTextContent("Skolan ber alla vårdnadshavare bekräfta.");
    expect(screen.getByRole("article", { name: "Utflykten på torsdag" })).not.toHaveTextContent("alla vårdnadshavare");
    // Nothing about the other one, not as a state and not as a word.
    expect(document.body).not.toHaveTextContent(/annan vårdnadshavare|andra vårdnadshavaren|har bekräftat|väntar på den andra/i);
  });

  it("counts the messages that wait, and shows the confirmed one with its moment instead of a button", async () => {
    state.list = [
      mineItem({ id: "r-1", title: "Beslutet om ledighet" }),
      mineItem({ id: "r-2", title: "Larmet", ackedAt: "2026-11-05T10:00:00.000Z" }),
    ];
    renderPage();

    expect(await screen.findByText("1 meddelande väntar på din bekräftelse")).toBeInTheDocument();
    const done = screen.getByRole("article", { name: "Larmet" });
    expect(done).toHaveTextContent(`Bekräftat ${momentText("2026-11-05T10:00:00.000Z")}`);
    expect(within(done).queryByRole("button")).not.toBeInTheDocument();
    expect(within(done).queryByText("Väntar på dig")).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Beslutet om ledighet" })).getByRole("button")).toBeInTheDocument();
  });

  describe("pressing the button", () => {
    it("sends one confirmation for that message, shows the gateway's moment, hands focus to it and announces it", async () => {
      const user = userEvent.setup();
      state.list = [mineItem({ id: "r-1" }), mineItem({ id: "r-2", title: "Larmet" })];
      renderPage();

      const first = within(await screen.findByRole("article", { name: "Utflykten på torsdag" }));
      await user.click(first.getByRole("button", { name: "Jag har tagit del av detta" }));

      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith("/api/v1/acknowledgements/r-1/confirm");
      const receipt = await first.findByText(`Bekräftat ${momentText("2026-11-06T09:41:00.000Z")}`);
      expect(first.queryByRole("button")).not.toBeInTheDocument();
      expect(receipt).toHaveFocus();
      expect(screen.getByText("Du har bekräftat: Utflykten på torsdag")).toBeInTheDocument();
      expect(screen.getByText("1 meddelande väntar på din bekräftelse")).toBeInTheDocument();
      // The other message still has its button.
      expect(within(screen.getByRole("article", { name: "Larmet" })).getByRole("button")).toBeEnabled();
    });

    it("closes every button while the confirmation is on its way, and a second tap sends nothing more", async () => {
      const user = userEvent.setup();
      let release!: () => void;
      api.post.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ackedAt: "2026-11-06T09:41:00.000Z" });
          }),
      );
      state.list = [mineItem({ id: "r-1" }), mineItem({ id: "r-2", title: "Larmet" })];
      renderPage();

      const first = within(await screen.findByRole("article", { name: "Utflykten på torsdag" }));
      const press = first.getByRole("button", { name: "Jag har tagit del av detta" });
      await user.click(press);

      const busy = await first.findByRole("button", { name: "Bekräftar…" });
      expect(busy).toBeDisabled();
      expect(within(screen.getByRole("article", { name: "Larmet" })).getByRole("button")).toBeDisabled();
      await user.click(busy);
      await user.click(within(screen.getByRole("article", { name: "Larmet" })).getByRole("button"));
      expect(api.post).toHaveBeenCalledTimes(1);

      release();
      expect(await first.findByText(/^Bekräftat /)).toBeInTheDocument();
      expect(within(screen.getByRole("article", { name: "Larmet" })).getByRole("button")).toBeEnabled();
    });

    it.each([
      ["custody has ended", new ApiError(409, "Du är inte längre vårdnadshavare.", "ACK_CUSTODY_ENDED")],
      ["the message is gone", new ApiError(404, "Meddelandet finns inte.", "ACK_NOT_FOUND")],
    ])("says the message no longer applies when %s, and reads the list again", async (_why, refusal) => {
      const user = userEvent.setup();
      state.list = [mineItem({ id: "r-1" }), mineItem({ id: "r-2", title: "Larmet" })];
      api.post.mockRejectedValue(refusal);
      renderPage();

      const first = within(await screen.findByRole("article", { name: "Utflykten på torsdag" }));
      // The list as it is when read again: the message is no longer there.
      state.list = [mineItem({ id: "r-2", title: "Larmet" })];
      await user.click(first.getByRole("button", { name: "Jag har tagit del av detta" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Meddelandet gäller inte längre dig");
      expect(screen.getByRole("alert")).toHaveTextContent("Listan är uppdaterad.");
      await waitFor(() => expect(screen.queryByRole("article", { name: "Utflykten på torsdag" })).not.toBeInTheDocument());
      expect(api.get.mock.calls.filter(([path]) => path === MINE).length).toBeGreaterThan(1);
      expect(screen.getByRole("article", { name: "Larmet" })).toBeInTheDocument();
    });

    it("says any other failure on the card and leaves the button to try again", async () => {
      const user = userEvent.setup();
      state.list = [mineItem({ id: "r-1" })];
      api.post.mockRejectedValueOnce(new ApiError(500, "boom"));
      renderPage();

      const card = within(await screen.findByRole("article", { name: "Utflykten på torsdag" }));
      await user.click(card.getByRole("button", { name: "Jag har tagit del av detta" }));

      expect(await card.findByText("Det gick inte att bekräfta")).toBeInTheDocument();
      expect(card.getByText("Din bekräftelse sparades inte. Försök igen om en stund.")).toBeInTheDocument();
      expect(screen.queryByText("Meddelandet gäller inte längre dig")).not.toBeInTheDocument();
      await user.click(card.getByRole("button", { name: "Jag har tagit del av detta" }));
      expect(await card.findByText(/^Bekräftat /)).toBeInTheDocument();
      expect(card.queryByText("Det gick inte att bekräfta")).not.toBeInTheDocument();
    });
  });

  describe("a page at a time", () => {
    const messages = (count: number) =>
      Array.from({ length: count }, (_, index) => mineItem({ id: `r-${index + 1}`, title: `Meddelande ${index + 1}` }));
    const titles = () => screen.getAllByRole("article").map((one) => one.querySelector("h2")!.textContent);

    it("offers no older messages, and does not say there are more, when the gateway names no next page", async () => {
      state.list = messages(2);
      renderPage();

      expect(await screen.findByText("2 meddelanden väntar på din bekräftelse")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Visa äldre" })).not.toBeInTheDocument();
      expect(screen.queryByText(/Fler finns/)).not.toBeInTheDocument();
    });

    it("says the count is of the messages shown while more exist, and drops the sentence when the last page is in", async () => {
      const user = userEvent.setup();
      state.pageSize = 2;
      state.list = messages(3);
      renderPage();

      const summary = await screen.findByText(/^2 meddelanden väntar på din bekräftelse/);
      expect(summary).toHaveTextContent("2 meddelanden väntar på din bekräftelse Räkningen gäller de meddelanden som visas. Fler finns: visa äldre.");
      // The live region stays one and the same: it is the sentence that changes, not a new region that appears.
      expect(summary).toHaveAttribute("aria-live", "polite");

      await user.click(screen.getByRole("button", { name: "Visa äldre" }));

      await waitFor(() => expect(screen.getByText("3 meddelanden väntar på din bekräftelse")).toBe(summary));
      expect(summary).toHaveAttribute("aria-live", "polite");
      expect(screen.queryByText(/Fler finns/)).not.toBeInTheDocument();
    });

    it("asks for the next page after the last id shown, puts its messages below the others and hands focus to the first of them", async () => {
      const user = userEvent.setup();
      state.pageSize = 2;
      state.list = messages(3);
      renderPage();
      await screen.findByRole("article", { name: "Meddelande 1" });
      expect(titles()).toEqual(["Meddelande 1", "Meddelande 2"]);
      expect(api.get.mock.calls.map(([path]) => path)).toEqual([MINE]);

      await user.click(screen.getByRole("button", { name: "Visa äldre" }));

      expect(api.get).toHaveBeenLastCalledWith(`${MINE}?after=r-2`);
      await waitFor(() => expect(titles()).toEqual(["Meddelande 1", "Meddelande 2", "Meddelande 3"]));
      await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Meddelande 3" })).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Visa äldre" })).not.toBeInTheDocument();
    });

    it("closes the button and says it is fetching while the page is on its way", async () => {
      const user = userEvent.setup();
      state.pageSize = 1;
      state.list = messages(2);
      renderPage();
      await screen.findByRole("article", { name: "Meddelande 1" });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const answer = api.get.getMockImplementation()!;
      api.get.mockImplementation(async (path: string) => {
        if (path.includes("after=")) await held;
        return answer(path);
      });

      await user.click(screen.getByRole("button", { name: "Visa äldre" }));

      expect(await screen.findByRole("button", { name: "Hämtar äldre…" })).toBeDisabled();
      release();
      expect(await screen.findByRole("article", { name: "Meddelande 2" })).toBeInTheDocument();
    });

    it("keeps the messages already loaded when a page cannot be read, says so under them and reads it again when asked", async () => {
      const user = userEvent.setup();
      state.pageSize = 2;
      state.list = messages(3);
      state.moreError = true;
      renderPage();
      await screen.findByRole("article", { name: "Meddelande 1" });

      await user.click(screen.getByRole("button", { name: "Visa äldre" }));

      expect(await screen.findByText("Äldre meddelanden kunde inte hämtas")).toBeInTheDocument();
      expect(screen.getByText("De som redan visas finns kvar. Försök igen om en stund.")).toBeInTheDocument();
      expect(titles()).toEqual(["Meddelande 1", "Meddelande 2"]);
      expect(screen.queryByText("Meddelandena kunde inte hämtas")).not.toBeInTheDocument();
      // Still said to count only the ones shown, and the cards still confirm.
      expect(screen.getByText(/Räkningen gäller de meddelanden som visas/)).toBeInTheDocument();

      state.moreError = false;
      await user.click(screen.getByRole("button", { name: "Försök igen" }));

      await waitFor(() => expect(titles()).toEqual(["Meddelande 1", "Meddelande 2", "Meddelande 3"]));
      expect(screen.queryByText("Äldre meddelanden kunde inte hämtas")).not.toBeInTheDocument();
    });

    it("confirms a message on a later page, shows its moment there and counts it", async () => {
      const user = userEvent.setup();
      state.pageSize = 2;
      state.list = messages(3);
      renderPage();
      await screen.findByRole("article", { name: "Meddelande 1" });
      await user.click(screen.getByRole("button", { name: "Visa äldre" }));
      const third = within(await screen.findByRole("article", { name: "Meddelande 3" }));

      await user.click(third.getByRole("button", { name: "Jag har tagit del av detta" }));

      expect(api.post).toHaveBeenCalledWith("/api/v1/acknowledgements/r-3/confirm");
      expect(await third.findByText(`Bekräftat ${momentText("2026-11-06T09:41:00.000Z")}`)).toBeInTheDocument();
      expect(third.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByText("2 meddelanden väntar på din bekräftelse")).toBeInTheDocument();
      // The ones on the first page have their buttons still.
      expect(within(screen.getByRole("article", { name: "Meddelande 1" })).getByRole("button")).toBeEnabled();
    });
  });

  it("speaks English too", async () => {
    state.list = [mineItem({ rule: "ALL" })];
    renderPage("en");

    expect(await screen.findByRole("heading", { level: 1, name: "Acknowledgements" })).toBeInTheDocument();
    expect(await confirmButton("I have read this")).toBeInTheDocument();
    expect(screen.getByText("The school asks all guardians to confirm.")).toBeInTheDocument();
    expect(screen.getByText("1 message is waiting for your confirmation")).toBeInTheDocument();
  });

  it("says in English that the count is of the messages shown, and offers the older ones", async () => {
    state.pageSize = 1;
    state.list = [mineItem({ id: "r-1" }), mineItem({ id: "r-2", title: "Larmet" })];
    renderPage("en");

    expect(await screen.findByText(/The count is of the messages shown\. There are more: show older\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show older" })).toBeInTheDocument();
  });
});
