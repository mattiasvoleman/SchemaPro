import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import AbsenceWatchPage from "./page";

/**
 * The form and the question before a removal are fetched on the first click
 * (limits-card.tsx), so a chunk that does not arrive is possible on a click.
 * It is said in a toast, in the reader's language, and the page stays whole:
 * the table, the switch and the findings are still there to use.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => false }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./limit-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/limit-dialog.js");
});
vi.mock("@/components/ui/confirm-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module: /_next/static/chunks/confirm-dialog.js");
});

const LIMIT = {
  id: "11111111-1111-4111-8111-111111111111",
  recipientGroup: "MENTOR",
  kind: "SHARE",
  basis: "INVALID",
  percent: 10,
  windowDays: 14,
  consecutiveDays: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (path: string) =>
    path === "/api/v1/absence-watch"
      ? { settings: { enabled: true, enabledOn: null, cadence: { MENTOR: "WEEKLY", REKTOR: "WEEKLY", KANSLI: "WEEKLY", GUARDIAN: "MONTHLY" } }, limits: [LIMIT] }
      : { findings: [], truncated: false },
  );
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm" onError={(error) => { throw error; }}>
        <AbsenceWatchPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("a dialog chunk that does not arrive", () => {
  it.each([
    ["the form", "Lägg till gräns"],
    ["the question before a removal", /^Ta bort Mentor/],
  ])("says so in a toast when %s cannot be opened, and leaves the page whole", async (_what, name) => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Bekräftelsen kunde inte öppnas. Inget är ändrat – försök igen."));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("dynamically imported module"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Frånvarobevakning" })).toBeChecked();
    expect(screen.getByRole("table", { name: "Skolans gränser för frånvaro" })).toBeInTheDocument();
  });
});
