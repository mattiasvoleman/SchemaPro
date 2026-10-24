import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import type { CalendarLessonRow } from "@/lib/types";
import { StudentLessonLog } from "./student-lesson-log";

/** The pupil's week's ämne och läxa: the lessons with something written, in the week's order, and nothing else. */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn() } };
});
const get = api.get as unknown as Mock;

const row = (id: string, date: string, start: string, subjectId: string) =>
  ({
    id,
    subjectId,
    studentGroupId: "g",
    roomId: null,
    date,
    startsAt: `${date}T${start}:00.000Z`,
    endsAt: `${date}T${start}:45.000Z`,
    status: "SCHEDULED",
    note: null,
  }) as unknown as CalendarLessonRow;

function renderList(lessons: CalendarLessonRow[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <StudentLessonLog
          from="2026-10-19"
          to="2026-10-25"
          lessons={lessons}
          subjectName={new Map([["ma", "Matematik"], ["sv", "Svenska"], ["en", "Engelska"]])}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("StudentLessonLog", () => {
  it("lists the week's lessons with a topic or homework, in the week's order, and asks for the week on screen", async () => {
    get.mockResolvedValue({
      entries: [
        { lessonId: "l-sv", topic: null, homework: "Läs kapitel 2" },
        { lessonId: "l-ma", topic: "Bråk", homework: "Uppgift 4.1\nUppgift 4.2" },
      ],
    });
    renderList([row("l-sv", "2026-10-21", "08:00", "sv"), row("l-ma", "2026-10-20", "09:00", "ma"), row("l-en", "2026-10-20", "10:00", "en")]);
    const card = await screen.findByRole("region", { name: "Ämne och läxa" });
    const items = await within(card).findAllByRole("listitem");
    expect(items.map((item) => within(item).getAllByText(/Matematik|Svenska/)[0]!.textContent)).toEqual(["Matematik", "Svenska"]);
    expect(within(items[0]!).getByText("Bråk")).toBeInTheDocument();
    expect(within(card).queryByText("Engelska")).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/lesson-logs?from=2026-10-19&to=2026-10-25");
  });

  it("says when nothing is written for the week, and when the read failed", async () => {
    get.mockResolvedValue({ entries: [] });
    const { unmount } = renderList([row("l-ma", "2026-10-20", "09:00", "ma")]);
    expect(await screen.findByText("Inget är skrivet för veckans lektioner.")).toBeInTheDocument();
    unmount();
    get.mockRejectedValue(new Error("network"));
    renderList([]);
    expect(await screen.findByText("Ämne och läxa gick inte att hämta")).toBeInTheDocument();
  });
});
