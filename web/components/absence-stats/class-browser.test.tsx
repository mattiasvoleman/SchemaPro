import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  CLASSES,
  CLASS_ID,
  CLASS_VIEW,
  OTHER_CLASS_ID,
  PUPILS,
  STUDENT_ID,
  SUPPRESSED,
  WINDOW,
  pupilView,
} from "./__fixtures__/views";
import { plain, renderStats } from "./__fixtures__/render";
import { ClassBrowser } from "./class-browser";

/**
 * The classes over a period and, from a class, its months, patterns, pupils
 * and a pupil's card: what an administrator's tab and a mentor's page share.
 * Read through the gateway's routes, under the real messages.
 *
 * What this guards: a failed read is said as such and never "nothing here";
 * a mentor's page asks for the classes, never for the school; the huvudman's
 * läsare is never offered a pupil (and no pupil is asked for); a class too
 * small to count shows no pattern; the pupils a school has marked as having
 * a protected identity are counted for an administrator and are not a hint
 * for a mentor.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({
  value: {
    profile: { schoolId: "sch-1", role: "SCHOOL_ADMIN" },
    school: { id: "sch-1", name: "Exempelskolan", slug: "exempel", timezone: "Europe/Stockholm" },
    schools: [{ schoolId: "sch-1", huvudman: null }] as Array<{ schoolId: string; huvudman: unknown }>,
  },
}));
vi.mock("@/components/profile-context", () => ({ useProfile: () => profile.value }));

const ROOT = "/api/v1/absence-stats";

const state = vi.hoisted(() => ({
  classes: undefined as unknown,
  classView: undefined as unknown,
  pupils: undefined as unknown,
  pupil: undefined as unknown,
  fail: new Set<string>(),
  hold: null as null | Promise<void>,
}));

const reads = () => api.get.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  vi.clearAllMocks();
  profile.value.profile.role = "SCHOOL_ADMIN";
  profile.value.schools = [{ schoolId: "sch-1", huvudman: null }];
  state.classes = CLASSES;
  state.classView = CLASS_VIEW;
  state.pupils = PUPILS;
  state.pupil = pupilView();
  state.fail = new Set();
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    const route = path.split("?")[0]!.slice(ROOT.length);
    const kind = route === "/classes" ? "classes" : route.endsWith("/pupils") ? "pupils" : route.startsWith("/classes/") ? "classView" : "pupil";
    const refusal = state.fail.has(kind);
    if (refusal && state.pupils instanceof ApiError && kind === "pupils") throw state.pupils;
    if (refusal) throw new ApiError(500, "boom");
    return state[kind];
  });
});

// The card is a chunk of its own, fetched when the first one is opened: slow on a cold, loaded machine.
const cardOf = (name: string) => screen.findByRole("heading", { level: 2, name }, { timeout: 20_000 });

const open = async (user: ReturnType<typeof userEvent.setup>, name = "Visa klass 7A") => {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("heading", { level: 2, name: "Klass 7A" });
};

describe("the classes", () => {
  it("is busy until the classes are read, then gives each class its sums and the pupils they rest on", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderStats(<ClassBrowser audience="admin" />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();

    const table = await screen.findByRole("table", { name: "Frånvaro per klass" });
    const rows = within(table).getAllByRole("row").slice(1);
    const a = within(rows[0]!).getAllByRole("cell");
    expect(plain(a[0])).toBe("7A 2026/2027 · 3 månader med siffra");
    expect(plain(a[1])).toBe("23 av 24");
    expect(plain(a[2])).toBe("270 min · 3,0 %");
    expect(plain(a[3])).toBe("195 min · 2,2 %");
    expect(plain(a[4])).toBe("3");
    expect(plain(a[5])).toBe("90,0 % 270 av 300 lektioner");
    expect(reads()).toEqual([`${ROOT}/classes`]);
  });

  it("says that a class with fewer than five pupils behind it has no figure, and never writes it as 0", async () => {
    renderStats(<ClassBrowser audience="admin" />);
    const table = await screen.findByRole("table", { name: "Frånvaro per klass" });
    const row = within(table).getAllByRole("row")[2]!;
    expect(plain(within(row).getAllByRole("cell")[0])).toBe("7B ingen månad med siffra");
    expect(within(row).getByText("Ingen siffra: färre än 5 elever har markeringar")).toBeInTheDocument();
    expect(within(row).queryByText(/min ·/)).not.toBeInTheDocument();
    expect(plain(within(row).getAllByRole("cell")[2])).toBe("Ingen siffra: färre än 5 elever har markeringar");
  });

  it("says that the read failed, with the way to try again, and shows no figure", async () => {
    state.fail.add("classes");
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    expect(await screen.findByText("Klasserna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText(/Inga siffror visas och inget har ändrats/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    state.fail.clear();
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Frånvaro per klass" })).toBeInTheDocument();
  });

  it("welcomes an administrator's empty school and a mentor with no class, each in its own words", async () => {
    state.classes = { ...CLASSES, classes: [] };
    const first = renderStats(<ClassBrowser audience="admin" />);
    expect(await screen.findByText("Inga klasser att visa")).toBeInTheDocument();
    first.unmount();

    profile.value.profile.role = "TEACHER";
    renderStats(<ClassBrowser audience="mentor" />);
    expect(await screen.findByText("Du är inte mentor för någon klass")).toBeInTheDocument();
    expect(screen.getByText(/klasserna där du har uppdraget mentorskap/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("the period", () => {
  it("opens on the läsår so far with no dates, and says which dates the gateway used", async () => {
    renderStats(<ClassBrowser audience="admin" />);
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    expect(screen.getByLabelText("Period")).toHaveValue("YEAR");
    expect(screen.getByText("Perioden är 17 aug. 2026 – 6 nov. 2026")).toBeInTheDocument();
    expect(reads()).toEqual([`${ROOT}/classes`]);
  });

  it("offers the choices the window reaches, and asks again with the dates of the one chosen", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    const select = screen.getByLabelText("Period");
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Läsåret hittills",
      "Föregående läsår",
      "Senaste 90 dagarna",
      "Alla tre läsåren",
    ]);

    await user.selectOptions(select, "Senaste 90 dagarna");
    await waitFor(() => expect(reads()).toContain(`${ROOT}/classes?from=2026-08-09&to=2026-11-06`));
    await user.selectOptions(select, "Föregående läsår");
    await waitFor(() => expect(reads()).toContain(`${ROOT}/classes?from=2025-08-01&to=2026-06-30`));
  });

  it("leaves out the previous läsår when the window does not reach it", async () => {
    state.classes = { ...CLASSES, window: { ...WINDOW, firstMonth: "2026-08-01" } };
    renderStats(<ClassBrowser audience="admin" />);
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    expect(within(screen.getByLabelText("Period")).queryByRole("option", { name: "Föregående läsår" })).not.toBeInTheDocument();
  });

  it("carries the period into the class, its pupils and the pupil", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    await user.selectOptions(screen.getByLabelText("Period"), "Alla tre läsåren");
    await waitFor(() => expect(reads()).toContain(`${ROOT}/classes?from=2024-08-01&to=2026-11-06`));
    await open(user);
    await user.click(await screen.findByRole("button", { name: "Visa elevkort för Berg, Ola" }));
    await cardOf("Ola Berg");
    const query = "?from=2024-08-01&to=2026-11-06";
    expect(reads()).toEqual(
      expect.arrayContaining([
        `${ROOT}/classes/${CLASS_ID}${query}`,
        `${ROOT}/classes/${CLASS_ID}/pupils${query}`,
        `${ROOT}/pupils/${STUDENT_ID}${query}`,
      ]),
    );
  });
});

describe("a class", () => {
  it("opens on the reader's choice with the class's months, patterns and pupils, and moves focus to it", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    const heading = await open(user);
    expect(heading).toHaveFocus();
    expect(await screen.findByRole("region", { name: "Klassen månad för månad" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Frånvaro per månad i klass 7A" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mönster" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Frånvaro per veckodag" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Elever" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visa klass 7A" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Visa klass 7B" })).toHaveAttribute("aria-pressed", "false");
    expect(reads()).toEqual(
      expect.arrayContaining([`${ROOT}/classes/${CLASS_ID}`, `${ROOT}/classes/${CLASS_ID}/pupils`]),
    );
  });

  it("shows no pattern for a class with fewer than five pupils with a mark, and says why", async () => {
    state.classView = { ...CLASS_VIEW, classId: OTHER_CLASS_ID, patterns: SUPPRESSED };
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    await user.click(screen.getByRole("button", { name: "Visa klass 7B" }));
    expect(await screen.findByText("Mönster visas inte")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Frånvaro per veckodag" })).not.toBeInTheDocument();
  });

  it("says that the class could not be read, and still offers the pupils' list its own read", async () => {
    state.fail.add("classView");
    renderStats(<ClassBrowser audience="admin" />);
    const user = userEvent.setup();
    await open(user);
    expect(await screen.findByText("Klassens månader och mönster kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Elever" })).toBeInTheDocument();
  });

  it("opens the class of a mentor who has just one, without taking focus on the first draw", async () => {
    profile.value.profile.role = "TEACHER";
    state.classes = { ...CLASSES, classes: [CLASSES.classes[0]!] };
    renderStats(<ClassBrowser audience="mentor" />);
    const heading = await screen.findByRole("heading", { level: 2, name: "Klass 7A" });
    expect(heading).not.toHaveFocus();
    expect(await screen.findByRole("table", { name: "Frånvaro per månad i klass 7A" })).toBeInTheDocument();
    // A mentor's page asks for the classes and never for the school's months.
    expect(reads().some((path) => path.endsWith("/school"))).toBe(false);
    expect(screen.getByText(/Klasserna där du är mentor/)).toBeInTheDocument();
  });
});

describe("the pupils of a class", () => {
  it("lists them by name in Swedish order, each with the sums, and says a pupil with no registration has none", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    const table = await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => plain(within(row).getAllByRole("cell")[0]))).toEqual(["Berg, Ola", "Dal, Eli", "Öberg, Siri"]);
    expect(plain(within(rows[0]!).getAllByRole("cell")[1])).toBe("50 min · 5,0 %");
    expect(plain(within(rows[0]!).getAllByRole("cell")[2])).toBe("115 min · 11,5 %");
    expect(plain(within(rows[0]!).getAllByRole("cell")[3])).toBe("1");
    // A pupil with no registered minute is not 0 %.
    expect(plain(within(rows[1]!).getAllByRole("cell")[1])).toBe("Ingen registrering i perioden");
    expect(within(rows[1]!).queryByText(/^0,0 %$/)).not.toBeInTheDocument();
  });

  it("tells an administrator how many were left out for a protected identity, and a mentor nothing", async () => {
    const user = userEvent.setup();
    const first = renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText("2 elever med skyddad identitet visas inte i listan.")).toBeInTheDocument();
    first.unmount();

    profile.value.profile.role = "TEACHER";
    state.pupils = { ...PUPILS, heldOut: null };
    renderStats(<ClassBrowser audience="mentor" />);
    await open(user);
    await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" });
    expect(screen.queryByText(/skyddad identitet/)).not.toBeInTheDocument();
  });

  it("says one in the singular, and nothing when none was left out", async () => {
    const user = userEvent.setup();
    state.pupils = { ...PUPILS, heldOut: 1 };
    const first = renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText("1 elev med skyddad identitet visas inte i listan.")).toBeInTheDocument();
    first.unmount();

    state.pupils = { ...PUPILS, heldOut: 0 };
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" });
    expect(screen.queryByText(/skyddad identitet/)).not.toBeInTheDocument();
  });

  it("says so when the class has no pupil to list, still counting the ones held out", async () => {
    state.pupils = { ...PUPILS, pupils: [], heldOut: 3 };
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText("Inga elever att visa")).toBeInTheDocument();
    expect(screen.getByText("3 elever med skyddad identitet visas inte i listan.")).toBeInTheDocument();
  });

  it("says that the list could not be read, and offers it again", async () => {
    state.fail.add("pupils");
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText("Eleverna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Elevernas frånvaro i klassen" })).not.toBeInTheDocument();
    state.fail.clear();
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" })).toBeInTheDocument();
  });

  it("notes in the läslogg's words that opening the list is recorded", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText(/registreras i läsloggen/)).toBeInTheDocument();
  });
});

describe("the huvudman's läsare", () => {
  beforeEach(() => {
    profile.value.schools = [{ schoolId: "sch-1", huvudman: { id: "h-1", name: "Kommunen" } }];
  });

  it("sees the class's months and patterns, and is told why there are no pupils; no pupil is asked for", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByRole("table", { name: "Frånvaro per månad i klass 7A" })).toBeInTheDocument();
    expect(await screen.findByText("Elever visas inte för huvudmannens läsare")).toBeInTheDocument();
    expect(screen.getByText(/aldrig en enskild elev/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Elevernas frånvaro i klassen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Visa elevkort/ })).not.toBeInTheDocument();
    expect(reads().some((path) => path.includes("/pupils"))).toBe(false);
  });

  it("is not mistaken for a school's own läsare, who is an ordinary administrator here", async () => {
    profile.value.schools = [{ schoolId: "sch-1", huvudman: null }, { schoolId: "sch-2", huvudman: { id: "h-1" } }];
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" })).toBeInTheDocument();
  });

  it("reads a refusal that arrives anyway as the same explanation, not as a failure", async () => {
    profile.value.schools = [{ schoolId: "sch-1", huvudman: null }];
    state.fail.add("pupils");
    state.pupils = new ApiError(403, "Forbidden", "ABSENCE_STATS_NO_PUPILS_FOR_THE_READER");
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    expect(await screen.findByText("Elever visas inte för huvudmannens läsare")).toBeInTheDocument();
    expect(screen.queryByText("Eleverna kunde inte hämtas")).not.toBeInTheDocument();
  });
});

describe("the pupil's card from the list", () => {
  it("opens in place of the class, loaded when asked for, and the way back names the class", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />);
    await open(user);
    await user.click(await screen.findByRole("button", { name: "Visa elevkort för Berg, Ola" }));

    const heading = await cardOf("Ola Berg");
    expect(heading).toHaveFocus();
    expect(screen.queryByRole("heading", { level: 2, name: "Klass 7A" })).not.toBeInTheDocument();
    expect(reads()).toContain(`${ROOT}/pupils/${STUDENT_ID}`);

    await user.click(screen.getByRole("button", { name: "Till klass 7A" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Klass 7A" })).toHaveFocus();
    expect(screen.queryByRole("heading", { level: 2, name: "Ola Berg" })).not.toBeInTheDocument();
  });

  it("has the same words in English", async () => {
    const user = userEvent.setup();
    renderStats(<ClassBrowser audience="admin" />, "en");
    await screen.findByRole("table", { name: "Absence per class" });
    await user.click(screen.getByRole("button", { name: "Show class 7A" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Class 7A" })).toBeInTheDocument();
    expect(await screen.findByText("2 pupils with a protected identity are not shown in the list.")).toBeInTheDocument();
  });
});
