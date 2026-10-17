import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import { toast } from "sonner";
import CalendarFeedSettingsPage from "./page";

/**
 * /admin/calendar-feeds: the school's switch per audience
 * (20261112091000). What only this page decides: each switch shows the
 * setting and how many live feeds it holds, turning one on saves at once,
 * and turning one off is always asked first, saying how many stop by a
 * count read again as it asks, or that every one does when the count
 * cannot be had (the database revokes them; RLS section 147).
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const settings = { calendarFeedTeachers: true, calendarFeedStudents: false, calendarFeedGuardians: true };
let counts: Record<string, number> = { TEACHER: 4, STUDENT: 0, GUARDIAN: 0 };

function renderPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CalendarFeedSettingsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("/admin/calendar-feeds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    counts = { TEACHER: 4, STUDENT: 0, GUARDIAN: 0 };
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/publication-settings") return settings;
      if (path === "/api/v1/calendar-feeds/counts") return counts;
      throw new Error(`unexpected GET ${path}`);
    });
    put.mockImplementation(async (_path: string, body: object) => ({ ...settings, ...body }));
  });

  it("shows each audience's switch and its live feeds", async () => {
    renderPage();
    expect(await screen.findByRole("switch", { name: "Lärare" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Elever" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Vårdnadshavare" })).toBeChecked();
    expect(await screen.findByText("4 prenumerationer")).toBeInTheDocument();
    expect(screen.getAllByText("Inga prenumerationer")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Din egen prenumeration" })).toHaveAttribute("href", "/calendar-feed");
  });

  it("marks each switch's row as Publicering's, so a profile that does not publish reads it but cannot press it", async () => {
    renderPage();
    for (const name of ["Lärare", "Elever", "Vårdnadshavare"]) {
      // The row, label and all: a press on the label would press the switch.
      const row = (await screen.findByRole("switch", { name })).closest("[data-writes-inert]");
      expect(row).toHaveAttribute("data-writes-inert", "PUBLICERING");
      expect(row).toContainElement(screen.getByText(name));
    }
    // The admin's own feed is theirs, whatever their profile.
    expect(screen.getByRole("link", { name: "Din egen prenumeration" }).closest("[data-writes],[data-writes-inert]")).toBeNull();
  });

  it("turns an audience on at once, and has the admin's own feed list read again", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(["calendarFeeds"], { enabled: true, feeds: [] });
    renderPage(queryClient);
    await user.click(await screen.findByRole("switch", { name: "Elever" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", { calendarFeedStudents: true }));
    await waitFor(() => expect(queryClient.getQueryState(["calendarFeeds"])?.isInvalidated).toBe(true));
  });

  it("says the count is being read until it is", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/publication-settings") return settings;
      return new Promise(() => {});
    });
    renderPage();
    await screen.findByRole("switch", { name: "Lärare" });
    expect(screen.getAllByText("Räknar prenumerationerna…")).toHaveLength(3);
    expect(screen.queryByText("Inga prenumerationer")).not.toBeInTheDocument();
  });

  it("does nothing with a second switch while a save is under way, and says so", async () => {
    let release: () => void = () => {};
    put.mockImplementation((_path: string, body: object) => new Promise((resolve) => (release = () => resolve({ ...settings, ...body }))));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("4 prenumerationer");
    await user.click(screen.getByRole("switch", { name: "Elever" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Lärare" })).toHaveAttribute("aria-disabled", "true"));
    await user.click(screen.getByRole("switch", { name: "Lärare" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Lärare" })).toHaveAttribute("aria-disabled", "false"));
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("asks before stopping an audience, saying how many stop by the count read again", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("4 prenumerationer");
    await user.click(screen.getByRole("switch", { name: "Lärare" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stäng av prenumeration för lärare?")).toBeInTheDocument();
    expect(await within(dialog).findByText(/4 prenumerationer slutar fungera direkt/)).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Stäng av" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/v1/publication-settings", { calendarFeedTeachers: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lärarnas prenumerationer är avstängda"));
  });

  it("asks before stopping an audience the page counted none of, as someone may have made one since", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findAllByText("Inga prenumerationer")).toHaveLength(2);
    counts = { TEACHER: 4, STUDENT: 0, GUARDIAN: 1 };
    await user.click(screen.getByRole("switch", { name: "Vårdnadshavare" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Stäng av prenumeration för vårdnadshavare?")).toBeInTheDocument();
    expect(await within(dialog).findByText(/1 prenumeration slutar fungera direkt/)).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it("says every feed stops when the count cannot be had", async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/publication-settings") return settings;
      throw new Error("unavailable");
    });
    renderPage();
    expect(await screen.findAllByText("Antalet kunde inte hämtas.")).toHaveLength(3);
    await user.click(screen.getByRole("switch", { name: "Lärare" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Alla gruppens prenumerationer slutar fungera direkt/)).toBeInTheDocument();
  });
});
