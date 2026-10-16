import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api, ApiError } from "@/lib/api";
import { toast } from "sonner";
import CalendarFeedPage from "./page";

/**
 * "Kalenderprenumeration" over the real hooks and the Swedish messages, the
 * gateway answering by path. What only this page decides: that an audience
 * the school has off is said, that the address is shown once (copyable, the
 * https address only, with the focus on it) and never read back, that making
 * a new address and stopping are asked first, that a refusal is said in the
 * page's words, and that a guardian has one feed per active child. Who may
 * have which feed is the gateway's (test/calendar-feed.e2e-spec.ts, RLS
 * sections 145–148).
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const remove = api.delete as unknown as Mock;
const state = vi.hoisted(() => ({ role: "TEACHER" }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: { id: "u-1", role: state.role }, school: null }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const FEED = { id: "f-1", audience: "TEACHER", studentId: null, locale: "sv", createdAt: "2026-10-01T06:00:00.000Z", lastUsedAt: "2026-10-15T05:30:00.000Z" };

function answer(feeds: { enabled: boolean; feeds: unknown[] }, children: unknown[] = []) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/calendar-feeds") return feeds;
    if (path === "/api/v1/family/children") return children;
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CalendarFeedPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("/calendar-feed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.role = "TEACHER";
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.schema.example/");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says the school has the audience off, and offers nothing to make", async () => {
    answer({ enabled: false, feeds: [] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Skolan har inte slagit på kalenderprenumeration" })).toBeInTheDocument();
    expect(screen.getByText(/Skolan väljer om lärare får prenumerera/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skapa prenumeration" })).not.toBeInTheDocument();
  });

  it("says an admin where the switch is", async () => {
    state.role = "SCHOOL_ADMIN";
    answer({ enabled: false, feeds: [] });
    renderPage();
    expect(await screen.findByText(/Schemaläggning › Kalenderprenumeration/)).toBeInTheDocument();
  });

  it("makes a feed and shows its address once, with the focus on it, and copies it", async () => {
    answer({ enabled: true, feeds: [] });
    post.mockImplementation(async () => {
      answer({ enabled: true, feeds: [FEED] });
      return { feed: FEED, token: TOKEN };
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Skapa prenumeration" }));
    expect(post).toHaveBeenCalledWith("/api/v1/calendar-feeds", { studentId: undefined, locale: "sv" });
    const address = await screen.findByRole("textbox", { name: "Prenumerationens adress" });
    const url = `https://api.schema.example/public/v1/calendar-feeds/${TOKEN}.ics`;
    expect(address).toHaveValue(url);
    await waitFor(() => expect(address).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Ditt schema: prenumerationen är skapad, och adressen är markerad.");
    expect(screen.getByText(/Adressen visas bara nu/)).toBeInTheDocument();
    // No webcal:// link: some calendar apps fetch it over plain http.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kopiera adressen" }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(toast.success).toHaveBeenCalledWith("Adressen är kopierad");
    // A refused clipboard says so; the address is still there to copy by hand.
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Kopiera adressen" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Adressen kunde inte kopieras. Den är markerad, så du kan kopiera den själv."));
  });

  it("keeps a shown address when the list is read again and fails", async () => {
    answer({ enabled: true, feeds: [] });
    post.mockResolvedValue({ feed: FEED, token: TOKEN });
    const user = userEvent.setup();
    renderPage();
    const make = await screen.findByRole("button", { name: "Skapa prenumeration" });
    // The refetch after making fails: the list read once stands, and the address with it.
    get.mockRejectedValue(new ApiError(503, "unavailable"));
    await user.click(make);
    expect(await screen.findByRole("textbox", { name: "Prenumerationens adress" })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Prenumerationerna kunde inte hämtas")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prenumerationens adress" })).toBeInTheDocument();
  });

  it("says a refusal in the page's words, by the gateway's code", async () => {
    answer({ enabled: true, feeds: [] });
    post.mockRejectedValue(new ApiError(429, "Too Many Requests"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Skapa prenumeration" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("För många försök. Vänta en minut och försök igen."));
  });

  it("reads the list again after a refusal, and shows the school's switch as it now is", async () => {
    answer({ enabled: true, feeds: [] });
    post.mockImplementation(async () => {
      // The school turned it off a moment ago: the list read again says so.
      answer({ enabled: false, feeds: [] });
      throw new ApiError(409, "Calendar feeds are off for this audience", "CALENDAR_FEEDS_OFF");
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Skapa prenumeration" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Skolan har stängt av kalenderprenumeration."));
    expect(await screen.findByRole("heading", { name: "Skolan har inte slagit på kalenderprenumeration" })).toBeInTheDocument();
  });

  it("lists a feed by when it was made and last fetched, never by its address", async () => {
    answer({ enabled: true, feeds: [FEED] });
    renderPage();
    expect(await screen.findByText("Skapad 1 okt. 2026 08:00.")).toBeInTheDocument();
    expect(screen.getByText("Senast hämtad 15 okt. 2026 07:30.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Prenumerationens adress" })).not.toBeInTheDocument();
  });

  it("asks before making a new address and before stopping, and stops the feed that is live", async () => {
    answer({ enabled: true, feeds: [FEED] });
    const renewed = { ...FEED, id: "f-2" };
    post.mockImplementation(async () => {
      answer({ enabled: true, feeds: [renewed] });
      return { feed: renewed, token: TOKEN };
    });
    remove.mockImplementation(async () => {
      answer({ enabled: true, feeds: [] });
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Skapa ny adress" }));
    const renew = await screen.findByRole("dialog");
    expect(within(renew).getByText(/Den gamla adressen slutar fungera direkt/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    await user.click(within(renew).getByRole("button", { name: "Skapa ny adress" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // Once the dialog has gone, the new address has the focus and is said.
    const address = await screen.findByRole("textbox", { name: "Prenumerationens adress" });
    await waitFor(() => expect(address).toHaveFocus());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ditt schema: prenumerationen är skapad"));

    await user.click(screen.getByRole("button", { name: "Sluta prenumerera" }));
    const stop = await screen.findByRole("dialog");
    await user.click(within(stop).getByRole("button", { name: "Sluta prenumerera" }));
    // The new feed is the one stopped, not the one it replaced.
    await waitFor(() => expect(remove).toHaveBeenCalledWith("/api/v1/calendar-feeds/f-2"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Prenumerationens adress" })).not.toBeInTheDocument());
    // No feed now: the button that makes one has the focus.
    await waitFor(() => expect(screen.getByRole("button", { name: "Skapa prenumeration" })).toHaveFocus());
  });

  it("stops the new feed even when the list cannot be read again after making it", async () => {
    answer({ enabled: true, feeds: [FEED] });
    post.mockResolvedValue({ feed: { ...FEED, id: "f-2" }, token: TOKEN });
    remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Skapa ny adress" }));
    get.mockRejectedValue(new ApiError(503, "unavailable"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Skapa ny adress" }));
    expect(await screen.findByRole("textbox", { name: "Prenumerationens adress" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sluta prenumerera" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sluta prenumerera" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("/api/v1/calendar-feeds/f-2"));
  });

  it("gives a guardian one feed per active child, each made for that child", async () => {
    state.role = "GUARDIAN";
    answer(
      { enabled: true, feeds: [{ ...FEED, audience: "GUARDIAN", studentId: "c-2" }] },
      [
        { linkId: "l-1", id: "c-1", firstName: "Ella", lastName: "Nord", isActive: true, studentGroupId: "g" },
        { linkId: "l-2", id: "c-2", firstName: "Hugo", lastName: "Nord", isActive: true, studentGroupId: "g" },
        { linkId: "l-3", id: "c-3", firstName: "Lämnat", lastName: "Nord", isActive: false, studentGroupId: null },
      ],
    );
    post.mockResolvedValue({ feed: { ...FEED, audience: "GUARDIAN", studentId: "c-1" }, token: TOKEN });
    const user = userEvent.setup();
    renderPage();
    const ella = (await screen.findByRole("heading", { name: "Schema för Ella" })).closest("section") as HTMLElement;
    const hugo = screen.getByRole("heading", { name: "Schema för Hugo" }).closest("section") as HTMLElement;
    expect(screen.queryByRole("heading", { name: "Schema för Lämnat" })).not.toBeInTheDocument();
    expect(within(hugo).getByText("Skapad 1 okt. 2026 08:00.")).toBeInTheDocument();
    await user.click(within(ella).getByRole("button", { name: "Skapa prenumeration" }));
    expect(post).toHaveBeenCalledWith("/api/v1/calendar-feeds", { studentId: "c-1", locale: "sv" });
  });
});
