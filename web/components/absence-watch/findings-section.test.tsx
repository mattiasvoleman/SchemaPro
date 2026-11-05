import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { AbsenceWatchFinding } from "@/lib/absence-watch";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { FindingsSection, type FindingsAudience } from "./findings-section";

/**
 * The list a mentor and a guardian read (the administrator's is tested with
 * its page): the same component for all three, so what differs is what it says
 * about itself. The database decides which findings come back; an empty list is
 * normal and is said kindly, and a failed read is never taken for one.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const FINDINGS = "/api/v1/absence-watch/findings";

const finding = (over: Partial<AbsenceWatchFinding> = {}): AbsenceWatchFinding => ({
  id: "f-1",
  studentId: "p-ada",
  studentName: "Ada Berg",
  className: "7A",
  recipientGroup: "MENTOR",
  kind: "CONSECUTIVE",
  basis: "INVALID",
  percent: null,
  windowDays: null,
  consecutiveDays: 5,
  firstCrossedOn: "2026-11-02",
  lastSeenOn: "2026-11-04",
  clearedOn: null,
  absentMinutes: null,
  recordedMinutes: null,
  streakDays: 5,
  ...over,
});

function renderSection(audience: FindingsAudience, locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
        <FindingsSection audience={audience} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const reply = (findings: AbsenceWatchFinding[], truncated = false) =>
  api.get.mockImplementation(async () => ({ findings, truncated }));

beforeEach(() => {
  vi.clearAllMocks();
  reply([]);
});

describe("the findings of a mentor and of a guardian", () => {
  it("lists the mentor's pupils with their figures, and offers no recipient column or filter", async () => {
    reply([finding(), finding({ id: "f-2", studentId: "p-bo", studentName: "Bo Ek", className: "7B", streakDays: 7, firstCrossedOn: "2026-10-26" })]);
    renderSection("mentor");

    const region = await screen.findByRole("region", { name: "Dina mentorselever över en gräns" });
    const table = await within(region).findByRole("table");
    expect(within(table).queryByRole("columnheader", { name: "Mottagare" })).not.toBeInTheDocument();
    expect(within(region).queryByLabelText("Mottagare")).not.toBeInTheDocument();
    const [ada, bo] = within(table).getAllByRole("row").slice(1);
    expect(ada).toHaveTextContent("Ada Berg");
    expect(ada).toHaveTextContent("7A");
    expect(ada).toHaveTextContent("5 skoldagar i följd med ogiltig frånvaro");
    expect(bo).toHaveTextContent("7 skoldagar i följd");
    expect(screen.getByText("2 elever är över en gräns.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(FINDINGS);
  });

  it("asks for the recent findings too only when told to, and says since when a pupil came back under", async () => {
    const user = userEvent.setup();
    reply([finding()]);
    renderSection("guardian");
    await screen.findByText("Ada Berg");
    reply([finding(), finding({ id: "f-old", studentId: "p-bo", studentName: "Bo Ek", clearedOn: "2026-11-01", firstCrossedOn: "2026-10-20" })]);

    await user.click(screen.getByRole("switch", { name: "Visa även de som kommit under gränsen" }));

    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(`${FINDINGS}?recent=1`));
    const row = (await screen.findByText("Bo Ek")).closest("tr")!;
    expect(row).toHaveTextContent(/Under gränsen sedan 1 nov\. 2026/);
    expect(row).toHaveTextContent(/Var över gränsen sedan 20 okt\. 2026/);
  });

  it.each([
    ["mentor", "Ingen av dina mentorselever har passerat en gräns"],
    ["guardian", "Inget av dina barn har passerat en gräns"],
  ] as const)("says kindly that nobody has passed a limit (%s)", async (audience, title) => {
    renderSection(audience);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says that nothing was found in the recent days when asked for them and there is none", async () => {
    const user = userEvent.setup();
    renderSection("mentor");
    await screen.findByText("Ingen av dina mentorselever har passerat en gräns");

    await user.click(screen.getByRole("switch", { name: "Visa även de som kommit under gränsen" }));

    expect(await screen.findByText("Inga fynd de senaste 60 dagarna")).toBeInTheDocument();
  });

  it("says a failed read as a failure and not as a list nobody is on", async () => {
    api.get.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderSection("guardian");

    expect(await screen.findByText("Listan kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Inget av dina barn har passerat en gräns")).not.toBeInTheDocument();
  });

  it("says the list is cut short when the gateway left the oldest out", async () => {
    reply([finding()], true);
    renderSection("mentor");
    expect(await screen.findByText("Listan är avkortad")).toBeInTheDocument();
  });

  it("names no pupil the gateway did not name", async () => {
    reply([finding({ studentName: null, className: null })]);
    renderSection("mentor");
    expect(await screen.findByText("Namnet kan inte visas")).toBeInTheDocument();
  });

  it("says a Swedish week the same in English", async () => {
    reply([finding({ kind: "SHARE", basis: "VALID", percent: 25, windowDays: 30, consecutiveDays: null, streakDays: null, absentMinutes: 600, recordedMinutes: 2400 })]);
    renderSection("mentor", "en");

    const table = await screen.findByRole("table", { name: "Pupils who have passed a limit for absence" });
    expect(table).toHaveTextContent("25% excused absence of the registered minutes over 30 days");
    expect(table).toHaveTextContent(/600 of 2,400 minutes \(25%\)/);
    expect(table).toHaveTextContent("Over the limit since Nov 2, 2026");
  });
});
