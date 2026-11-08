import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import TeacherAbsenceWatchPage from "./page";

/**
 * /teacher/absence-watch: the mentor's list. A teacher is not offered the
 * overview (the switch and the limits are the administrators'), so the page
 * must read the findings and nothing else; and a teacher who mentors nobody
 * is handed an empty list, said kindly.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ findings: [], truncated: false });
});

describe("the mentor's page", () => {
  it("is headed Frånvarobevakning, reads the findings alone, and welcomes an empty list", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm" onError={(error) => { throw error; }}>
          <TeacherAbsenceWatchPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Frånvarobevakning" })).toBeInTheDocument();
    expect(screen.getByText(/klasser där du är mentor som har passerat en gräns/)).toBeInTheDocument();
    expect(await screen.findByText("Ingen av dina mentorselever har passerat en gräns")).toBeInTheDocument();
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(["/api/v1/absence-watch/findings"]);
    expect(screen.queryByRole("switch", { name: "Frånvarobevakning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Lägg till|Redigera|Ta bort/ })).not.toBeInTheDocument();
  });

  it("leads on to the absence statistics over time, which has no menu row of its own", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm" onError={(error) => { throw error; }}>
          <TeacherAbsenceWatchPage />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("link", { name: "Frånvarostatistik över tid" })).toHaveAttribute("href", expect.stringContaining("/teacher/absence-stats"));
  });
});
