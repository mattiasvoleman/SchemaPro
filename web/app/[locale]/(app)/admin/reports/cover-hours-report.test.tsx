import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import type { Hours } from "@/lib/cover-types";
import { CoverHoursReport, lastMonth } from "./cover-hours-report";

/**
 * Vikarietimmar: the held covers per substitute and period, the booked ones
 * beside them (never exported), and the two payroll files built on click
 * with the school's own clock.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn() } };
});
const get = api.get as unknown as Mock;
const download = vi.hoisted(() => vi.fn());
vi.mock("@/lib/csv-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/csv-export")>();
  return { ...actual, downloadCsv: download };
});
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "admin" }, school: { timezone: "Europe/Stockholm" } }),
}));
vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "u-pool", firstName: "Cia", lastName: "Holm", email: "cia@example.se" },
      { id: "u-staff", firstName: "Bo", lastName: "Ek", email: "bo@skola.se" },
    ],
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }] }),
  useRooms: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const HOURS: Hours = {
  from: "2026-09-01",
  to: "2026-09-30",
  rows: [
    {
      lessonId: "l-1",
      userId: "u-pool",
      kind: "POOL",
      date: "2026-09-14",
      startsAt: "2026-09-14T06:00:00.000Z",
      endsAt: "2026-09-14T07:30:00.000Z",
      minutes: 90,
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      roomId: null,
    },
  ],
  summary: [{ userId: "u-pool", kind: "POOL", lessons: 1, minutes: 90 }],
  planned: [{ userId: "u-staff", lessons: 2, minutes: 120 }],
  toCheck: [],
};

function renderReport() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CoverHoursReport />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue(HOURS);
});

describe("Vikarietimmar", () => {
  it("opens on last month", () => {
    expect(lastMonth("2026-10-10")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(lastMonth("2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("shows held covers per person and the booked ones beside them", async () => {
    renderReport();
    const row = (await screen.findByText("Cia Holm")).closest("tr")!;
    expect(within(row).getByText("Vikariepool")).toBeInTheDocument();
    expect(within(row).getByText("90")).toBeInTheDocument();
    expect(within(row).getByText("1,5")).toBeInTheDocument();
    const booked = screen.getByText("Bo Ek").closest("tr")!;
    expect(within(booked).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Totalt 90 min (1,5 timmar)")).toBeInTheDocument();
  });

  it("builds the lessons file on click, on the school's clock, with no replaced teacher", async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findByText("Cia Holm");
    await user.click(screen.getByRole("button", { name: "Exportera pass (CSV)" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("vikarietimmar-lektioner-2026-09-01-2026-09-30.csv");
    expect(csv).toContain("Cia Holm;cia@example.se;Vikariepool;2026-09-14;08:00;09:30;90;Matematik;7A;");
  });

  it("lists, outside the files, a cover the calendar credits to a substitute who was away themself — to check, without saying why", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      ...HOURS,
      toCheck: [{ ...HOURS.rows[0]!, lessonId: "l-2", userId: "u-staff", kind: "STAFF", date: "2026-09-15", startsAt: "2026-09-15T06:00:00.000Z", endsAt: "2026-09-15T07:00:00.000Z", minutes: 60 }],
    });
    renderReport();
    const note = await screen.findByRole("region", { name: "Kontrollera innan lönen" });
    expect(within(note).getByText(/Bo Ek/)).toHaveTextContent("Bo Ek · 2026-09-15 08:00–09:00 · Matematik · 7A");
    expect(note).not.toHaveTextContent(/sjuk|orsak/i);
    // Not in the payroll file.
    await user.click(screen.getByRole("button", { name: "Exportera pass (CSV)" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect((download.mock.calls[0] as [string, string])[1]).not.toContain("Bo Ek");
  });

  it("refuses a period longer than the gateway's 93 days before asking it", async () => {
    renderReport();
    await screen.findByText("Cia Holm");
    get.mockClear();
    fireEvent.change(screen.getByLabelText("Från"), { target: { value: "2026-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Välj en period på högst 93 dagar.");
    expect(get).not.toHaveBeenCalled();
  });
});
