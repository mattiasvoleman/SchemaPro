import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { ADMIN, HOLIDAY, PRAO, STAFF_DAY, TUESDAY, WEEK_DAYS, day, free, lesson, view } from "@/lib/__fixtures__/school-day";
import type { AdminProfile } from "@/lib/admin-areas";
import type { FreeView, SchoolDaySettings, SchoolDayView } from "@/lib/school-day";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import SchoolDayPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Skolans dag, the administrators' page (/admin/school-day), through the
 * gateway's routes and the real messages: a key missing from sv.json or en.json
 * throws here instead of printing its path.
 *
 * What this guards: the day as a table whose rows are named and whose blocks
 * each say what they are, a cancelled lesson in words and not only struck
 * through; the three kinds of row and the week; a lov said across the rows it
 * closes; the finder asks for what it was given and says which rules decided;
 * the school's decision is a decider's alone; the printout names no teacher the
 * school has marked, and the screen is restored after it; and a school that has
 * not opened the page is a state and not an error.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({ readOnly: false, admin: "REKTOR" as string | undefined }));
vi.mock("@/components/profile-context", () => ({
  useReadOnly: () => profile.readOnly,
  useProfile: () => ({ profile: { adminProfile: profile.admin } }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const marks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/protected-people", () => ({ readMarks: marks.read }));

const ROOT = "/api/v1/school-day";

const state = vi.hoisted(() => ({
  grid: undefined as unknown as (from: string, to: string) => unknown,
  free: undefined as unknown,
  settings: undefined as unknown,
  gridError: null as null | Error,
  freeError: false,
}));

const rangeOf = (path: string) => /from=([\d-]+)&to=([\d-]+)/.exec(path)!.slice(1, 3) as [string, string];
const reads = (prefix: string) => api.get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith(prefix));

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
        <SchoolDayPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Tuesday 3 November 2026, 10:25: "today", and the finder's first hour.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T10:25:00") });
  profile.readOnly = false;
  profile.admin = "REKTOR";
  state.grid = (from, to) => (from === to ? view({ from, to, days: [day(from)] }) : view({ from, to, days: WEEK_DAYS }));
  state.free = free();
  state.settings = { teacherView: "NONE" } satisfies SchoolDaySettings;
  state.gridError = null;
  state.freeError = false;
  api.get.mockImplementation(async (path: string) => {
    if (path === `${ROOT}/settings`) return state.settings;
    if (path.startsWith(`${ROOT}/free?`)) {
      if (state.freeError) throw new ApiError(500, "boom");
      return state.free;
    }
    if (path.startsWith(`${ROOT}?`)) {
      if (state.gridError) throw state.gridError;
      return state.grid(...rangeOf(path));
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.put.mockImplementation(async (_path: string, body: SchoolDaySettings) => body);
  marks.read.mockResolvedValue(new Set<string>());
});

afterEach(() => {
  vi.useRealTimers();
});

/** The row headers of the table on screen, in order. */
const rowNames = () => screen.getAllByRole("rowheader").map((one) => one.querySelector("span")?.textContent);
/** What a row holds, as the sentences a screen reader gets. */
const sentences = (name: string) =>
  within(screen.getAllByRole("rowheader").find((one) => one.querySelector("span")?.textContent?.startsWith(name))!.closest("tr")!)
    .getAllByRole("listitem")
    .map((one) => one.querySelector(".sr-only")?.textContent ?? one.textContent);

const loaded = async () => {
  renderPage();
  await screen.findAllByRole("rowheader");
};

describe("the day", () => {
  it("asks for today as a one-day range and draws the classes as a table with a named row each", async () => {
    await loaded();
    expect(reads(`${ROOT}?`)).toEqual([`${ROOT}?from=${TUESDAY}&to=${TUESDAY}`]);
    expect(screen.getByRole("heading", { level: 1, name: "Skolans dag" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Klasser, tisdag 3 november 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Klass" })).toBeInTheDocument();
    expect(rowNames()).toEqual(["7A", "9B", "En7"]);
  });

  it("names every block with its time, subject, other groups, room and teachers", async () => {
    await loaded();
    expect(sentences("7A")).toEqual([
      "08:15–09:00 Matematik, Sal 12, Anna Svensson",
      "08:30–09:15 Engelska, En7, Sal 12, Bo Ek",
      "11:00–11:45 Engelska, Anna Svensson, ombokad",
    ]);
  });

  it("says in words what is cancelled, what is an aktivitet's replacement and which teacher is not shown", async () => {
    await loaded();
    expect(sentences("9B")).toEqual([
      "08:00–15:00 Friluftsdag, Cecilia Ås, aktivitet",
      "08:15–09:00 Idrott, Gymnastiksalen, Cecilia Ås, inställd (aktivitet)",
      "10:00–10:45 Matematik, Sal 12, +1 lärare visas inte",
    ]);
  });

  it("keeps a lesson in the row of each group it is for, naming the other", async () => {
    await loaded();
    expect(sentences("En7")).toEqual(["08:30–09:15 Engelska, 7A, Sal 12, Bo Ek"]);
  });

  it("shows the teachers' day: lessons, the rastvakt, a booking and an absence, each for what it is", async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("tab", { name: "Lärare" }));
    expect(rowNames()).toEqual(["Anna Svensson", "Bo Ek", "Cecilia Ås"]);
    expect(sentences("Anna")).toContain("13:00–14:00 Bokning, Föräldramöte");
    expect(sentences("Bo")).toContain("09:55–10:15 Rastvakt");
    expect(sentences("Cecilia")).toContain("00:00–24:00 Frånvarande");
    // The absence is the whole day, and the axis stays a working day's.
    expect(within(screen.getAllByRole("rowheader")[0]!.closest("table")!).getByText("07:00")).toBeInTheDocument();
    expect(within(screen.getAllByRole("rowheader")[0]!.closest("table")!).queryByText("00:00")).not.toBeInTheDocument();
  });

  it("shows the rooms' day: the lessons held there, a booking and a closure", async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("tab", { name: "Salar" }));
    expect(rowNames()).toEqual(["Sal 12", "Gymnastiksalen"]);
    expect(screen.getByText("G1")).toBeInTheDocument();
    expect(sentences("Sal 12")).toContain("13:00–14:00 Bokning, Föräldramöte");
    expect(sentences("Gymnastiksalen")).toEqual([
      "08:15–09:00 Idrott, 9B, Cecilia Ås, inställd (aktivitet)",
      "12:00–13:00 Spärrad",
      "15:00–16:00 Utlånad till annan skola",
    ]);
  });

  it("filters the rows by name and says so when nothing matches", async () => {
    const user = userEvent.setup();
    await loaded();
    await user.type(screen.getByLabelText("Filtrera rader"), "9");
    expect(rowNames()).toEqual(["9B"]);
    await user.clear(screen.getByLabelText("Filtrera rader"));
    await user.type(screen.getByLabelText("Filtrera rader"), "zzz");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inga rader att visa" })).toBeInTheDocument();
  });

  it("steps to the next school day and over the weekend, and back to today", async () => {
    vi.setSystemTime(new Date("2026-11-06T10:25:00"));
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Nästa dag" }));
    await waitFor(() => expect(reads(`${ROOT}?`)).toContain(`${ROOT}?from=2026-11-09&to=2026-11-09`));
    expect(screen.getByText("måndag 9 november 2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Föregående dag" }));
    await waitFor(() => expect(reads(`${ROOT}?`).at(-1)).toBe(`${ROOT}?from=2026-11-06&to=2026-11-06`));
    expect(screen.getByRole("button", { name: "Idag" })).toBeDisabled();
  });

  it("reads the whole-school holiday across the page and across every row", async () => {
    state.grid = (from, to) => view({ from, to, days: [day(from, [HOLIDAY])], lessons: [], blocks: [] });
    renderPage();
    await screen.findAllByRole("rowheader");
    expect(screen.getByText("Lov: skolan är stängd")).toBeInTheDocument();
    // The notice, and one band across each of the two classes (no lesson, so no other rows).
    expect(screen.getAllByText("Lov: Höstlov")).toHaveLength(3);
  });

  it("closes only the classes a narrowed lov covers, and names its årskurs", async () => {
    state.grid = (from, to) => view({ from, to, days: [day(from, [PRAO])] });
    renderPage();
    await screen.findAllByRole("rowheader");
    const nine = screen.getAllByRole("rowheader").find((one) => one.querySelector("span")?.textContent === "9B")!.closest("tr")!;
    expect(within(nine).getByText("Lov för åk 9: Prao")).toBeInTheDocument();
    const seven = screen.getAllByRole("rowheader").find((one) => one.querySelector("span")?.textContent === "7A")!.closest("tr")!;
    expect(within(seven).queryByText(/Lov/)).not.toBeInTheDocument();
  });

  it("says a failed read is a failed read, and tries again on request", async () => {
    const user = userEvent.setup();
    state.gridError = new ApiError(500, "boom");
    renderPage();
    expect(await screen.findByText("Skolans dag kunde inte hämtas")).toBeInTheDocument();
    state.gridError = null;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findAllByRole("rowheader")).not.toHaveLength(0);
  });

  it("is a state, not an error, when the school closed the page for teachers since it was drawn", async () => {
    state.gridError = new ApiError(403, "no", "SCHOOL_DAY_NOT_OPEN");
    renderPage();
    expect(await screen.findByRole("heading", { name: "Skolan har inte öppnat Skolans dag för lärare" })).toBeInTheDocument();
    expect(screen.queryByText("Skolans dag kunde inte hämtas")).not.toBeInTheDocument();
  });
});

describe("the week", () => {
  const week = async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("tab", { name: "Vecka" }));
    await screen.findByRole("table", { name: /över veckan/ });
    return user;
  };

  it("asks for Monday to Sunday, and has a column for Monday to Friday", async () => {
    await week();
    expect(reads(`${ROOT}?`).at(-1)).toBe(`${ROOT}?from=2026-11-02&to=2026-11-08`);
    expect(screen.getAllByRole("columnheader").map((one) => one.textContent)).toEqual([
      "Klass",
      "mån 2 nov.",
      "tis 3 nov.",
      "ons 4 nov.",
      "tors 5 nov.",
      "fre 6 nov.",
    ]);
    expect(screen.getByText("Vecka 45 · mån 2 nov. – sön 8 nov.")).toBeInTheDocument();
  });

  it("gives a cell the same sentences as the day, and says when it holds nothing", async () => {
    await week();
    const seven = screen.getAllByRole("rowheader").find((one) => one.querySelector("span")?.textContent === "7A")!.closest("tr")!;
    const cells = within(seven).getAllByRole("cell");
    expect(cells).toHaveLength(5);
    expect(within(cells[1]!).getByText("08:15–09:00 Matematik, Sal 12, Anna Svensson")).toBeInTheDocument();
    expect(within(cells[0]!).getByText("Inget inlagt")).toBeInTheDocument();
  });

  it("opens a day from its name", async () => {
    const user = await week();
    await user.click(screen.getByRole("button", { name: "Visa dagen tis 3 nov." }));
    await waitFor(() => expect(reads(`${ROOT}?`).at(-1)).toBe(`${ROOT}?from=${TUESDAY}&to=${TUESDAY}`));
    expect(await screen.findByRole("table", { name: /tisdag 3 november 2026/ })).toBeInTheDocument();
  });

  it("closes a cell the lov covers, and the day's column says why", async () => {
    state.grid = (from, to) =>
      view({ from, to, days: WEEK_DAYS.map((one) => (one.date === "2026-11-04" ? day(one.date, [HOLIDAY]) : one)) });
    await week();
    expect(screen.getByRole("columnheader", { name: /ons 4 nov\./ })).toHaveTextContent("Höstlov");
    expect(screen.getAllByText("Lov: Höstlov").length).toBeGreaterThan(3);
  });

  it("steps a week at a time", async () => {
    const user = await week();
    await user.click(screen.getByRole("button", { name: "Nästa vecka" }));
    await waitFor(() => expect(reads(`${ROOT}?`).at(-1)).toBe(`${ROOT}?from=2026-11-09&to=2026-11-15`));
  });

  it("gives a Saturday a column when a lesson is on it", async () => {
    state.grid = (from, to) =>
      view({ from, to, days: WEEK_DAYS, lessons: [lesson({ id: "l-s", date: "2026-11-07", start: 600, end: 660, subjectId: "s-ma", groupId: "g-7a" })] });
    await week();
    expect(screen.getAllByRole("columnheader").map((one) => one.textContent)).toContain("lör 7 nov.");
  });
});

describe("the finder", () => {
  const ask = async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Visa lediga" }));
    await screen.findByRole("heading", { name: /tisdag 3 november 2026, 10:00–11:00/ });
    return user;
  };

  it("opens on the hour that is on and asks for nothing until it is pressed", async () => {
    await loaded();
    expect(reads(`${ROOT}/free?`)).toEqual([]);
    expect(screen.getByLabelText("Från")).toHaveValue("10:00");
    expect(screen.getByLabelText("Till")).toHaveValue("11:00");
  });

  it("asks for the date and the interval it was given", async () => {
    await ask();
    expect(reads(`${ROOT}/free?`)).toEqual([`${ROOT}/free?date=${TUESDAY}&from=10:00&to=11:00`]);
  });

  it("lists the free teachers and rooms with their counts", async () => {
    await ask();
    expect(screen.getByRole("heading", { name: "Lediga lärare (2)" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Lediga lärare (2)" })).getAllByRole("listitem").map((one) => one.textContent)).toEqual([
      "Anna Svensson",
      "Bo Ek",
    ]);
    expect(within(screen.getByRole("list", { name: "Lediga salar (1)" })).getByText("Gymnastiksalen (G1)")).toBeInTheDocument();
  });

  it("says which of the Vikarietavla's rules decided, and which question is another", async () => {
    await ask();
    expect(
      screen.getByText(
        "Lärare är lediga när Vikarietavlans regler för upptagen inte träffar: frånvarande, upptagen i lektion, rastvakt, uppdrag, spärrad, har bokat en sal, vikarie utan anmälda tider. Salar är lediga när ingenting av detta träffar: används i en lektion, bokad, spärrad, utlånad till en annan skola då, lånad sal, och lånet gäller inte hela tiden.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lunch, vila, dagtak och sammanhängande undervisning, som Vikarietavlan också prövar när någon ska vikariera, ingår inte i ”ledig”.",
      ),
    ).toBeInTheDocument();
  });

  it("gives an administrator the ones who are not free, and the rule that says so, in words", async () => {
    const user = await ask();
    await user.click(screen.getByText("Inte lediga (2)"));
    expect(screen.getByText("Cecilia Ås")).toBeInTheDocument();
    expect(screen.getByText("— frånvarande, upptagen i lektion")).toBeInTheDocument();
    expect(screen.getByText("— används i en lektion, bokad")).toBeInTheDocument();
  });

  it("names a lent room and a borrowed one outside its loan by the words of the rule, and a lent room is not free", async () => {
    state.free = free({
      rooms: [],
      busyRooms: [
        { id: "r-gym", name: "Gymnastiksalen", code: "G1", reasons: ["ROOM_LENT"] },
        { id: "r-12", name: "Sal 12", code: null, reasons: ["ROOM_BORROWED_OUTSIDE_LOAN"] },
      ],
    });
    const user = await ask();
    expect(screen.getByRole("heading", { name: "Lediga salar (0)" })).toBeInTheDocument();
    await user.click(screen.getByText("Inte lediga (3)"));
    expect(screen.getByText("— utlånad till en annan skola då")).toBeInTheDocument();
    expect(screen.getByText("— lånad sal, och lånet gäller inte hela tiden")).toBeInTheDocument();
  });

  it("takes a preset as the interval and asks at once", async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Lunch 11:00–13:00" }));
    await waitFor(() => expect(reads(`${ROOT}/free?`)).toEqual([`${ROOT}/free?date=${TUESDAY}&from=11:00&to=13:00`]));
    expect(screen.getByLabelText("Från")).toHaveValue("11:00");
  });

  it("will not ask for an interval that ends before it starts", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "09:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Sluttiden måste vara efter starttiden.");
    expect(screen.getByRole("button", { name: "Visa lediga" })).toBeDisabled();
  });

  it("says Lov: skolan är stängd instead of two empty lists on a holiday", async () => {
    state.free = free({ breaks: [HOLIDAY], teachers: [], rooms: [], busyTeachers: [], busyRooms: [] });
    await ask();
    const notice = screen.getAllByText("Lov: skolan är stängd").at(-1)!.closest("[data-tone]")!;
    expect(notice).toHaveTextContent("Lov: Höstlov");
    expect(screen.queryByRole("heading", { name: /Lediga lärare/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Lediga salar/ })).not.toBeInTheDocument();
  });

  it("tells a studiedag as a notice and still lists who is free", async () => {
    state.free = free({ breaks: [STAFF_DAY] });
    await ask();
    expect(screen.getByText(/Studiedag \(Planering\): personalen arbetar/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lediga lärare (2)" })).toBeInTheDocument();
  });

  it("counts the pool members left out for want of a declared time", async () => {
    state.free = free({ poolLeftOut: 2 });
    await ask();
    expect(screen.getByText("2 vikarier ur poolen har inga anmälda tider och räknas inte som lediga.")).toBeInTheDocument();
  });

  it("says the search failed, and nothing is made up", async () => {
    const user = userEvent.setup();
    state.freeError = true;
    await loaded();
    await user.click(screen.getByRole("button", { name: "Visa lediga" }));
    expect(await screen.findByText("Det gick inte att söka")).toBeInTheDocument();
  });
});

describe("what teachers have of the page", () => {
  const choices = () => screen.getAllByRole("radio");

  it("shows the school's choice, defaulting to nothing, with a sentence for each option", async () => {
    await loaded();
    expect(choices().map((one) => (one as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(screen.getByRole("radio", { name: "Hela schemat" })).toHaveAccessibleDescription(/aldrig veta vilka kolleger som är lediga/);
    expect(screen.getByRole("radio", { name: "Hela schemat" })).toHaveAccessibleDescription(/skyddad identitet visas inte vid namn/);
  });

  it("saves the choice a decider makes, and only then", async () => {
    const user = userEvent.setup();
    await loaded();
    const save = screen.getByRole("button", { name: "Spara" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Salar" }));
    expect(save).toBeEnabled();
    await user.click(save);
    expect(api.put).toHaveBeenCalledWith(`${ROOT}/settings`, { teacherView: "ROOMS" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Valet är sparat"));
  });

  it.each(["SCHEMALAGGARE", "EXPEDITION", "LASARE"] as AdminProfile[])("lets %s read the choice and change nothing, and says who decides", async (one) => {
    profile.admin = one;
    state.settings = { teacherView: "ALL" };
    await loaded();
    expect(await screen.findByRole("radio", { name: "Hela schemat" })).toBeChecked();
    for (const radio of choices()) expect(radio).toBeDisabled();
    expect(screen.getByText("Rektor och fulla administratörer bestämmer detta. Du ser vad skolan har valt.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara" })).toBeDisabled();
  });

  it("leaves a läsare's read-only mode to disable the choice, whatever the profile", async () => {
    profile.readOnly = true;
    await loaded();
    for (const radio of await screen.findAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("says a choice that could not be read, without a made-up default", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === `${ROOT}/settings`) throw new ApiError(500, "boom");
      return state.grid(...rangeOf(path));
    });
    renderPage();
    expect(await screen.findByText("Valet kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("the printout", () => {
  let print: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    print = vi.fn();
    window.print = print as unknown as typeof window.print;
  });

  const press = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
  };

  it("names the marked teacher as Skyddad identitet, in the row and in every lesson, and counts them, then prints", async () => {
    marks.read.mockResolvedValue(new Set(["t-1", "t-9"]));
    const user = userEvent.setup();
    await loaded();
    await press(user);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(screen.getByText("En person visas inte vid namn (skyddad identitet).")).toBeInTheDocument();
    expect(sentences("7A")[0]).toBe("08:15–09:00 Matematik, Sal 12, Skyddad identitet");
    expect(screen.queryByText(/Anna Svensson/)).not.toBeInTheDocument();
    // The others stay named.
    expect(sentences("7A")[1]).toBe("08:30–09:15 Engelska, En7, Sal 12, Bo Ek");
  });

  it("names the marked teacher's row by nothing either, on the teachers' tab", async () => {
    marks.read.mockResolvedValue(new Set(["t-1"]));
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole("tab", { name: "Lärare" }));
    await press(user);
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(rowNames()).toEqual(["Skyddad identitet", "Bo Ek", "Cecilia Ås"]);
  });

  it("restores the screen when the browser says the printing is done", async () => {
    marks.read.mockResolvedValue(new Set(["t-1"]));
    const user = userEvent.setup();
    await loaded();
    await press(user);
    await waitFor(() => expect(print).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(screen.queryByText("En person visas inte vid namn (skyddad identitet).")).not.toBeInTheDocument();
    expect(sentences("7A")[0]).toBe("08:15–09:00 Matematik, Sal 12, Anna Svensson");
  });

  it("prints without a count when nobody is marked", async () => {
    const user = userEvent.setup();
    await loaded();
    await press(user);
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(screen.queryByText(/visas inte vid namn \(skyddad/)).not.toBeInTheDocument();
  });

  it("prints nothing when the marks cannot be read: the sheet would name whom it is meant to leave out", async () => {
    marks.read.mockRejectedValue(new ApiError(500, "boom"));
    const user = userEvent.setup();
    await loaded();
    await press(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(print).not.toHaveBeenCalled();
    expect(sentences("7A")[0]).toContain("Anna Svensson");
  });

  it("is for administrators: a reader the gateway answers as a teacher has no Skriv ut", async () => {
    state.grid = (from, to) => view({ from, to, access: { admin: false, grids: true, freeTeachers: false }, days: [day(from)] });
    await loaded();
    expect(screen.queryByRole("button", { name: "Skriv ut" })).not.toBeInTheDocument();
  });
});

describe("both languages", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
      : [prefix.slice(0, -1)];

  it("has the same words in sv.json and en.json", () => {
    expect(keys((en as Record<string, unknown>).schoolDay).sort()).toEqual(keys((sv as Record<string, unknown>).schoolDay).sort());
  });

  it("draws in English too, the day and the finder", async () => {
    const user = userEvent.setup();
    renderPage("en");
    await screen.findAllByRole("rowheader");
    expect(screen.getByRole("heading", { level: 1, name: "School day" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show free" }));
    expect(await screen.findByRole("heading", { name: "Free teachers (2)" })).toBeInTheDocument();
  });
});

// Only to keep the type import honest for the fixtures this file shares with the teacher page's tests.
export type { FreeView, SchoolDayView };
void ADMIN;
