import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import GuardianAbsenceWatchPage from "./page";

/**
 * /guardian/absence-watch: the guardian's list of their own children over a
 * limit the school set for guardians. The overview is the administrators', so
 * the page reads the findings and nothing else, and a school that sets no
 * limit for guardians (or has the watch off) gives an empty list, said kindly.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const finding = {
  id: "f-1",
  studentId: "p-ada",
  studentName: "Ada Berg",
  className: "7A",
  recipientGroup: "GUARDIAN",
  kind: "SHARE",
  basis: "ALL",
  percent: 20,
  windowDays: 28,
  consecutiveDays: null,
  firstCrossedOn: "2026-10-28",
  lastSeenOn: "2026-11-04",
  clearedOn: null,
  absentMinutes: 600,
  recordedMinutes: 2400,
  streakDays: null,
};

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm" onError={(error) => { throw error; }}>
        <GuardianAbsenceWatchPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ findings: [], truncated: false });
});

describe("the guardian's page", () => {
  it("is headed Frånvarobevakning, reads the findings alone, and welcomes an empty list", async () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Frånvarobevakning" })).toBeInTheDocument();
    expect(await screen.findByText("Inget av dina barn har passerat en gräns")).toBeInTheDocument();
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(["/api/v1/absence-watch/findings"]);
    expect(screen.queryByRole("switch", { name: "Frånvarobevakning" })).not.toBeInTheDocument();
  });

  it("lists a child over a limit with the figures and since when, and no recipient column", async () => {
    api.get.mockResolvedValue({ findings: [finding], truncated: false });
    renderPage();

    const row = (await screen.findByText("Ada Berg")).closest("tr")!;
    expect(row).toHaveTextContent("20 % all frånvaro av de registrerade minuterna över 28 dagar");
    expect(row).toHaveTextContent(/600 av 2\s400 minuter \(25 %\)/);
    expect(row).toHaveTextContent(/Över gränsen sedan 28 okt\. 2026/);
    expect(screen.queryByRole("columnheader", { name: "Mottagare" })).not.toBeInTheDocument();
  });
});
