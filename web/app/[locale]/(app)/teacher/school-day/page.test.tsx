import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { HOLIDAY, TEACHER_ALL, TEACHER_ROOMS, TUESDAY, day, free, lesson, view } from "@/lib/__fixtures__/school-day";
import type { RoomBusyCode, SchoolDaySettings, TeacherView } from "@/lib/school-day";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import TeacherSchoolDayPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /teacher/school-day, through the gateway's routes and the real messages: the
 * page a teacher has in the form the school decided. Nothing until the school
 * decides (a calm page that leads to the room booking, not an error), the rooms
 * (no class or teacher rows, lessons without teachers), or the whole schedule
 * (never who is free, never a protected teacher by name, and no printout).
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

const ROOT = "/api/v1/school-day";

// All five of the rooms' rules, as the gateway lists them (src/school-day/school-day-rules.ts ROOM_RULES).
const ROOM_RULES: RoomBusyCode[] = ["ROOM_IN_USE", "ROOM_BOOKED", "ROOM_CLOSED", "ROOM_LENT", "ROOM_BORROWED_OUTSIDE_LOAN"];

const state = vi.hoisted(() => ({ settings: undefined as unknown, grid: undefined as unknown, free: undefined as unknown, settingsError: false }));

const reads = (prefix: string) => api.get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith(prefix));

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
        <TeacherSchoolDayPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The gateway as it answers a teacher of a school that chose `choice`. */
function school(choice: TeacherView) {
  state.settings = { teacherView: choice } satisfies SchoolDaySettings;
  if (choice === "ROOMS") {
    state.grid = view({
      access: TEACHER_ROOMS,
      groups: view().groups,
      teachers: [],
      // Lessons with a room only, and no teachers: the gateway's ROOMS form.
      lessons: view().lessons.filter((one) => one.roomId !== null).map((one) => ({ ...one, teachers: [], hiddenTeachers: 0 })),
      blocks: view().blocks.filter((one) => one.resource === "ROOM"),
    });
    state.free = free({ access: TEACHER_ROOMS, teachers: null, busyTeachers: null, busyRooms: null, rules: { teachers: [], rooms: ROOM_RULES } });
  } else {
    state.grid = view({ access: TEACHER_ALL });
    state.free = free({ access: TEACHER_ALL, teachers: null, busyTeachers: null, busyRooms: null, rules: { teachers: [], rooms: ROOM_RULES } });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T10:25:00") });
  state.settingsError = false;
  school("ALL");
  api.get.mockImplementation(async (path: string) => {
    if (path === `${ROOT}/settings`) {
      if (state.settingsError) throw new ApiError(500, "boom");
      return state.settings;
    }
    if (path.startsWith(`${ROOT}/free?`)) return state.free;
    if (path.startsWith(`${ROOT}?`)) return state.grid;
    throw new Error(`unexpected read ${path}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const rowNames = () => screen.getAllByRole("rowheader").map((one) => one.querySelector("span")?.textContent);

describe("a school that has decided nothing for teachers", () => {
  beforeEach(() => {
    school("NONE");
  });

  it("says so calmly and leads to the room booking, and asks the gateway for no day", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Skolan har inte öppnat Skolans dag för lärare" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Till Boka lokal" })).toHaveAttribute("href", "/teacher/rooms");
    expect(reads(`${ROOT}?`)).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("is also what a teacher gets if the school closed the page since the choice was read", async () => {
    school("ALL");
    api.get.mockImplementation(async (path: string) => {
      if (path === `${ROOT}/settings`) return state.settings;
      throw new ApiError(403, "no", "SCHOOL_DAY_NOT_OPEN");
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Skolan har inte öppnat Skolans dag för lärare" })).toBeInTheDocument();
  });
});

describe("a school that gives teachers the rooms", () => {
  beforeEach(() => {
    school("ROOMS");
  });

  it("has the rooms only: no tab to choose between rows, and no teacher on a lesson", async () => {
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.queryByRole("tab", { name: "Lärare" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Klasser" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Salar, tisdag 3 november 2026/ })).toBeInTheDocument();
    expect(rowNames()).toEqual(["Sal 12", "Gymnastiksalen"]);
    expect(screen.getByText("08:15–09:00 Matematik, 7A")).toBeInTheDocument();
    expect(screen.queryByText(/Anna Svensson/)).not.toBeInTheDocument();
  });

  it("finds the free rooms and says why it names no teacher", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByRole("rowheader");
    await user.click(screen.getByRole("button", { name: "Visa lediga" }));
    expect(await screen.findByRole("heading", { name: "Lediga salar (1)" })).toBeInTheDocument();
    expect(screen.getByText(/Vilka lärare som är lediga visas inte för lärare/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Lediga lärare/ })).not.toBeInTheDocument();
    // No list of the ones who are not, and only the rooms' rules are named.
    expect(screen.queryByText(/Inte lediga/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Salar är lediga när ingenting av detta träffar: används i en lektion, bokad, spärrad, utlånad till en annan skola då, lånad sal, och lånet gäller inte hela tiden.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Lärare är lediga när/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lunch, vila, dagtak/)).not.toBeInTheDocument();
  });

  it("has no printout", async () => {
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.queryByRole("button", { name: "Skriv ut" })).not.toBeInTheDocument();
  });
});

describe("a school that gives teachers the whole schedule", () => {
  it("has the classes, the teachers and the rooms, and opens on the classes", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.getAllByRole("tab").map((one) => one.textContent)).toEqual(["Dag", "Vecka", "Klasser", "Lärare", "Salar"]);
    expect(rowNames()).toEqual(["7A", "9B", "En7"]);
    await user.click(screen.getByRole("tab", { name: "Lärare" }));
    expect(rowNames()).toEqual(["Anna Svensson", "Bo Ek", "Cecilia Ås"]);
  });

  it("never tells who is free, nor who is away, nor a protected teacher by name or id", async () => {
    // As the gateway answers a teacher: the marked teacher is out of the rows and the lessons, without a count.
    state.grid = view({
      access: TEACHER_ALL,
      teachers: view().teachers.filter((one) => one.id !== "t-1"),
      lessons: view().lessons.map((one) => ({ ...one, teachers: one.teachers.filter((t) => t.id !== "t-1") })),
      blocks: view().blocks.filter((one) => !(one.resource === "TEACHER" && one.resourceId === "t-1")),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.queryByText(/Anna Svensson/)).not.toBeInTheDocument();
    // The lesson is drawn as a lesson nobody holds; the page cannot say that someone was left out, whatever a gateway sends.
    expect(screen.getByText("08:15–09:00 Matematik, Sal 12")).toBeInTheDocument();
    expect(screen.queryByText(/visas inte/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Visa lediga" }));
    await screen.findByRole("heading", { name: "Lediga salar (1)" });
    expect(screen.queryByRole("heading", { name: /Lediga lärare/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skriv ut" })).not.toBeInTheDocument();
  });

  it("reads a lov across the rows like the administrators' page", async () => {
    state.grid = view({ access: TEACHER_ALL, days: [day(TUESDAY, [HOLIDAY])], lessons: [], blocks: [] });
    renderPage();
    expect(await screen.findByText("Lov: skolan är stängd")).toBeInTheDocument();
  });

  it("does not draw the administrators' card for the school's choice", async () => {
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.queryByText("Vad lärare ser av Skolans dag")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("asks for the week as the administrators' page does", async () => {
    state.grid = view({ access: TEACHER_ALL, lessons: [lesson({ id: "l-s", date: "2026-11-07", start: 600, end: 660, subjectId: "s-ma", groupId: "g-7a" })], days: [day("2026-11-07")] });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByRole("rowheader");
    await user.click(screen.getByRole("tab", { name: "Vecka" }));
    await waitFor(() => expect(reads(`${ROOT}?`).at(-1)).toBe(`${ROOT}?from=2026-11-02&to=2026-11-08`));
  });
});

describe("a failed read of the choice", () => {
  it("is said as such, and the day is not drawn as though the school had decided", async () => {
    state.settingsError = true;
    renderPage();
    expect(await screen.findByText("Skolans dag kunde inte hämtas")).toBeInTheDocument();
    expect(reads(`${ROOT}?`)).toEqual([]);
  });
});

describe("in English", () => {
  it("draws the closed page and the rooms", async () => {
    school("NONE");
    const first = renderPage("en");
    expect(await screen.findByRole("heading", { name: "The school has not opened School day for teachers" })).toBeInTheDocument();
    first.unmount();
    school("ROOMS");
    renderPage("en");
    const table = await screen.findByRole("table", { name: /Rooms/ });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(2);
  });
});
