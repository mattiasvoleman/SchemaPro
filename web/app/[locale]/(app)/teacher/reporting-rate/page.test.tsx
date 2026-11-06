import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MyReportingRate, OpenLesson } from "@/lib/reporting-rate";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import TeacherReportingRatePage from "./page";

/**
 * /teacher/reporting-rate, through the gateway's /mine and the real messages:
 * the lessons that stand open, the oldest first, each a link to the register,
 * the ones open for long marked; the teacher's own share for the week, the
 * month and the läsår; a failed read said as such, and an empty list said
 * kindly. Nothing here is anyone else's.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

// next-intl's Link needs the routing context; an anchor is what it renders.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const lesson = (id: string, date: string, from: string, to: string, subjectName: string, groupName: string, overdue: boolean): OpenLesson => ({
  lessonId: id,
  date,
  startsAt: `${date}T${from}:00.000Z`,
  endsAt: `${date}T${to}:00.000Z`,
  subjectName,
  groupName,
  overdue,
});

const MINE: MyReportingRate = {
  openAfterDays: 2,
  through: "2026-11-04",
  open: [
    lesson("l-1", "2026-11-02", "08:10", "09:10", "Svenska", "7A", true),
    lesson("l-2", "2026-11-02", "10:40", "11:40", "Svenska", "7B", true),
    lesson("l-3", "2026-11-03", "08:10", "09:10", "Engelska", "7A", false),
  ],
  week: { from: "2026-11-02", to: "2026-11-08", held: 12, reported: 9 },
  month: { from: "2026-11-01", to: "2026-11-30", held: 48, reported: 41 },
  year: { name: "2026/27", from: "2026-08-17", to: "2027-06-11", held: 360, reported: 330 },
};

const dayText = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

const state = vi.hoisted(() => ({ mine: undefined as unknown, error: false, hold: null as null | Promise<void> }));

function renderPage(locale: "sv" | "en" = "sv") {
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
        <TeacherReportingRatePage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mine = MINE;
  state.error = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path !== "/api/v1/reporting-rate/mine") throw new Error(`unexpected read ${path}`);
    if (state.error) throw new ApiError(500, "boom");
    return state.mine;
  });
});

describe("Min rapportering, the teacher's page", () => {
  it("is busy until the lessons are read", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();
    expect(await screen.findByRole("heading", { level: 2, name: "Öppna lektioner" })).toBeInTheDocument();
  });

  it("lists the open lessons as they come, each a link to its register, and marks the ones open for long", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "Dina öppna lektioner" });

    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/teacher/attendance/l-1",
      "/teacher/attendance/l-2",
      "/teacher/attendance/l-3",
    ]);
    expect(links[0]).toHaveTextContent("Svenska");
    expect(links[0]).toHaveTextContent("7A");
    // The clock on the wall, from the lesson's instants (the harness runs in UTC).
    expect(links[0]).toHaveTextContent("08:10–09:10");
    expect(links[1]).toHaveTextContent("10:40–11:40");
    expect(links[2]).toHaveTextContent("Engelska");
    // The first two are past the school's two days, the third is not.
    expect(within(items[0]!).getByText("Öppen för länge")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Öppen för länge")).toBeInTheDocument();
    expect(within(items[2]!).queryByText("Öppen för länge")).not.toBeInTheDocument();
    expect(screen.getByText("3 öppna lektioner, varav 2 öppen för länge")).toBeInTheDocument();
    expect(screen.getByText(/hölls för minst 2 dagar sedan märks Öppen för länge/)).toBeInTheDocument();
  });

  it("puts the oldest first even when the gateway sent them in another order", async () => {
    state.mine = { ...MINE, open: [MINE.open[2]!, MINE.open[1]!, MINE.open[0]!] };
    renderPage();
    const list = await screen.findByRole("list", { name: "Dina öppna lektioner" });

    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/teacher/attendance/l-1",
      "/teacher/attendance/l-2",
      "/teacher/attendance/l-3",
    ]);
  });

  it("says one open lesson in the singular and leaves out the part about long when none is", async () => {
    state.mine = { ...MINE, open: [MINE.open[2]!] };
    renderPage();
    expect(await screen.findByText("1 öppen lektion")).toBeInTheDocument();
    expect(screen.queryByText(/varav/)).not.toBeInTheDocument();
  });

  it("says no open lessons kindly, not as an empty list", async () => {
    state.mine = { ...MINE, open: [] };
    renderPage();

    expect(await screen.findByRole("heading", { level: 3, name: "Inga öppna lektioner" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Dina öppna lektioner" })).not.toBeInTheDocument();
  });

  it("gives the share for the week, the month and the läsår, with the lessons behind each and how far the count reaches", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "Din rapporteringsgrad per period" });

    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Vecka 45");
    expect(rows[0]).toHaveTextContent(`${dayText("2026-11-02")} – ${dayText("2026-11-08")}`);
    expect(rows[0]).toHaveTextContent("9 av 12 lektioner");
    expect(rows[0]).toHaveTextContent("75 %");
    expect(rows[1]).toHaveTextContent("november 2026");
    expect(rows[1]).toHaveTextContent("41 av 48 lektioner");
    expect(rows[1]).toHaveTextContent("85 %");
    expect(rows[2]).toHaveTextContent("Läsåret 2026/27");
    expect(rows[2]).toHaveTextContent("330 av 360 lektioner");
    expect(rows[2]).toHaveTextContent("92 %");
    expect(screen.getByText(`Uppdaterad t.o.m. ${dayText("2026-11-04")}`)).toBeInTheDocument();
  });

  it("leaves out the läsår when there is none, and shows a dash for a period with no lesson held, not 0 %", async () => {
    state.mine = { ...MINE, year: null, week: { ...MINE.week, held: 0, reported: 0 } };
    renderPage();
    const list = await screen.findByRole("list", { name: "Din rapporteringsgrad per period" });

    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("0 av 0 lektioner");
    expect(rows[0]).toHaveTextContent("—");
    expect(rows[0]).not.toHaveTextContent("0 %");
  });

  it("says before the first night's count that no day is counted", async () => {
    state.mine = { ...MINE, through: null };
    renderPage();
    expect(await screen.findByText("Ingen dag är räknad ännu. Räkningen görs varje natt.")).toBeInTheDocument();
  });

  it("says a failed read as such, never as no open lessons", async () => {
    state.error = true;
    renderPage();

    expect(await screen.findByText("Din rapportering kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Inga öppna lektioner")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("says what counts as reported, and that a colleague's saved register counts for the teacher too", async () => {
    renderPage();
    expect(await screen.findByText(/Registret är sparat när minst en elev har fått en markering/)).toBeInTheDocument();
    expect(screen.getByText(/Har en kollega på samma lektion sparat det/)).toBeInTheDocument();
  });

  it("says the same in English, with every key found", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "My reporting" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Your open lessons" })).toBeInTheDocument();
    expect(screen.getByText("3 open lessons, of which 2 open for long")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Your reporting rate per period" })).toBeInTheDocument();
  });
});
