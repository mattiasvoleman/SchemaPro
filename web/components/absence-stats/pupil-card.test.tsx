import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { STUDENT_ID, pupilView } from "./__fixtures__/views";
import { plain, renderStats } from "./__fixtures__/render";
import { PupilCard } from "./pupil-card";

/**
 * One pupil over three läsår, and the A4 that goes to the development talk.
 *
 * What this guards: a month with no mark is "ingen registrering" and never a
 * 0; the class and its reporting rate stand beside the pupil; the card says
 * from which day the marks stand; and a pupil with a protected identity is
 * never printed — not when the gateway flags the card, not when the school's
 * marks (read at the click) name the pupil, and not when that read fails.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({
  value: {
    profile: { schoolId: "sch-1", role: "SCHOOL_ADMIN" },
    school: { id: "sch-1", name: "Exempelskolan", slug: "exempel", timezone: "Europe/Stockholm" },
    schools: [{ schoolId: "sch-1", huvudman: null }],
  },
}));
vi.mock("@/components/profile-context", () => ({ useProfile: () => profile.value }));

const PUPIL_PATH = `/api/v1/absence-stats/pupils/${STUDENT_ID}`;
const MARKS_PATH = "/api/v1/person-protections";

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  viewError: null as unknown,
  marks: [] as Array<{ userId: string; source: string }>,
  marksError: false,
}));

const reads = () => api.get.mock.calls.map(([path]) => path as string);
const onBack = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  profile.value.profile.role = "SCHOOL_ADMIN";
  state.view = pupilView();
  state.viewError = null;
  state.marks = [];
  state.marksError = false;
  window.print = vi.fn();
  document.documentElement.classList.remove("printing-sheet");
  api.get.mockImplementation(async (path: string) => {
    if (path === MARKS_PATH) {
      if (state.marksError) throw new ApiError(500, "boom");
      return state.marks;
    }
    if (path.startsWith(PUPIL_PATH)) {
      if (state.viewError) throw state.viewError;
      return state.view;
    }
    throw new Error(`unexpected read ${path}`);
  });
});

const card = (period: { from: string; to: string } | null = null) => (
  <PupilCard studentId={STUDENT_ID} period={period} backName="7A" onBack={onBack} />
);
const loaded = () => screen.findByRole("heading", { level: 2, name: "Ola Berg" });
const rowOf = (name: RegExp) => screen.getByRole("row", { name });
const cellsOf = (name: RegExp) => within(rowOf(name)).getAllByRole("cell");

describe("the card", () => {
  it("is busy until the pupil is read, then names the pupil, the class and the dates the patterns cover", async () => {
    renderStats(card());
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    const heading = await loaded();
    expect(heading).toHaveFocus();
    expect(screen.getByText("Klass 7A · Mönstren gäller 17 aug. 2026 – 6 nov. 2026")).toBeInTheDocument();
    expect(reads()).toEqual([PUPIL_PATH]);
  });

  it("asks with the period it was given", async () => {
    renderStats(card({ from: "2025-08-01", to: "2026-06-30" }));
    await loaded();
    expect(reads()).toEqual([`${PUPIL_PATH}?from=2025-08-01&to=2026-06-30`]);
  });

  it("sums the months and writes the pupil's own figures with last year's under them", async () => {
    renderStats(card());
    await loaded();
    const tile = (label: string) => plain(screen.getByText(label, { selector: "dt" }).closest("div"));
    expect(tile("Giltig frånvaro")).toBe("Giltig frånvaro 4,5 % 100 min");
    expect(tile("Ogiltig frånvaro")).toBe("Ogiltig frånvaro 3,0 % 65 min");
    expect(tile("Sena ankomster")).toBe("Sena ankomster 1");
    expect(tile("Registrerade minuter")).toBe("Registrerade minuter 2 200 min");

    const october = cellsOf(/^okt\. 2026/);
    expect(plain(october[0])).toBe("okt. 2026 36 lektioner med markering");
    expect(plain(october[1])).toBe("60 min · 5,0 % Förra året: 4,0 %");
    expect(plain(october[2])).toBe("45 min · 3,8 % Förra året: 2,0 %");
    expect(plain(october[3])).toBe("1 Förra året: 0");
  });

  it("puts the class beside the pupil, with the class's reporting rate", async () => {
    renderStats(card());
    await loaded();
    const october = cellsOf(/^okt\. 2026/);
    expect(plain(october[4])).toBe("Giltig 4,0 % · ogiltig 2,3 %");
    expect(plain(october[5])).toBe("95,0 % 399 av 420 lektioner");
    // A month the pupil has no mark in has one cell for all three figures; a month the class has no row for is a dash.
    expect(plain(cellsOf(/^sep\. 2025/)[2])).toBe("—");
    expect(plain(cellsOf(/^sep\. 2025/)[3])).toBe("—");
  });

  it("says 'ingen registrering' for a month with no mark, never 0 and never 'no absence'", async () => {
    renderStats(card());
    await loaded();
    for (const month of [/^sep\. 2025/, /^nov\. 2026/]) {
      const row = rowOf(month);
      expect(within(row).getAllByText("Ingen registrering").length).toBeGreaterThan(0);
      expect(within(row).queryByText(/min ·/)).not.toBeInTheDocument();
      expect(within(row).queryByText(/^0,0 %$/)).not.toBeInTheDocument();
    }
    expect(plain(cellsOf(/^nov\. 2026/)[0])).toBe("nov. 2026 Hittills, till och med 6 nov. 2026");
  });

  it("says from which day the marks stand, and that what is before them is purged or was never reported", async () => {
    renderStats(card());
    await loaded();
    expect(screen.getByText(/Markeringar finns kvar från 6 okt\. 2025 till 6 nov\. 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Närvaron före 6 okt\. 2025 har gallrats eller rapporterades aldrig/)).toBeInTheDocument();
    expect(screen.getByText(/de månaderna visas som ”Ingen registrering”, inte som ingen frånvaro/)).toBeInTheDocument();
    expect(screen.getByText(/Att öppna elevkortet registreras i läsloggen/)).toBeInTheDocument();
  });

  it("says that no mark is left at all, with no figure in any tile", async () => {
    state.view = pupilView({ marksFrom: null, marksTo: null, months: [{ month: "2026-10-01", figures: null, lessons: 0, previousYear: null }], total: null });
    renderStats(card());
    await loaded();
    expect(screen.getByText(/Det finns inga markeringar kvar för eleven/)).toBeInTheDocument();
    const tile = screen.getByText("Giltig frånvaro", { selector: "dt" }).closest("div")!;
    expect(plain(tile)).toBe("Giltig frånvaro Ingen registrering");
  });

  it("says that the pupil is in no class, with nothing to compare with", async () => {
    state.view = pupilView({
      student: { ...pupilView().student, classId: null, className: null },
      classSeries: null,
    });
    renderStats(<PupilCard studentId={STUDENT_ID} period={null} backName={null} onBack={onBack} />);
    await loaded();
    expect(screen.getByText(/^Ingen klass · Mönstren gäller/)).toBeInTheDocument();
    expect(screen.getByText(/Eleven går inte i någon klass/)).toBeInTheDocument();
    expect(plain(cellsOf(/^okt\. 2026/)[4])).toBe("—");
    expect(screen.getByRole("button", { name: "Till elevlistan" })).toBeInTheDocument();
  });

  it("shows the pupil's patterns, and no count of pupils behind them", async () => {
    renderStats(card());
    await loaded();
    expect(screen.getByRole("region", { name: "Mönster för eleven" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Frånvaro per veckodag" })).toBeInTheDocument();
    expect(screen.queryByText(/Mönstret bygger på/)).not.toBeInTheDocument();
  });

  it("goes back to the class it came from", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Till klass 7A" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("keeps the screen out of a print that did not come from the button, and says where the button is", async () => {
    const { container } = renderStats(card());
    await loaded();
    expect(container.querySelector(".print\\:hidden")).not.toBeNull();
    const hint = screen.getByText(/skrivs ut med knappen Skriv ut på kortet/);
    expect(hint).toHaveClass("hidden", "print:block");
    expect(document.querySelector(".print-sheet-root")).toBeNull();
  });

  it("has the same words in English", async () => {
    renderStats(card(), "en");
    expect(await screen.findByRole("heading", { level: 2, name: "Ola Berg" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.getAllByText("No registration").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "To class 7A" })).toBeInTheDocument();
  });
});

describe("when the read does not go through", () => {
  it("says that the card could not be read, shows no figure and offers it again", async () => {
    state.viewError = new ApiError(500, "boom");
    const user = userEvent.setup();
    renderStats(card());
    expect(await screen.findByText("Elevkortet kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText(/Inga siffror visas och inget har ändrats/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    state.viewError = null;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await loaded()).toBeInTheDocument();
  });

  it("explains the huvudman's läsare's refusal instead of calling it a failure", async () => {
    state.viewError = new ApiError(403, "Forbidden", "ABSENCE_STATS_NO_PUPILS_FOR_THE_READER");
    renderStats(card());
    expect(await screen.findByText("Elever visas inte för huvudmannens läsare")).toBeInTheDocument();
    expect(screen.queryByText("Elevkortet kunde inte hämtas")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Till klass 7A" })).toBeInTheDocument();
  });
});

describe("Skriv ut", () => {
  const dispatchAfterPrint = () => act(() => void window.dispatchEvent(new Event("afterprint")));

  it("reads the school's marks at the click, then puts one A4 on the page alone and prints it", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    expect(reads()).not.toContain(MARKS_PATH);

    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    expect(reads().filter((path) => path === MARKS_PATH)).toHaveLength(1);
    expect(document.documentElement).toHaveClass("printing-sheet");

    const sheet = document.body.querySelector<HTMLElement>(".print-sheet-root")!;
    expect(sheet.parentElement).toBe(document.body);
    expect(within(sheet).getByRole("heading", { level: 1, name: "Ola Berg" })).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Exempelskolan · Frånvaro över tid");
    expect(sheet).toHaveTextContent("Klass 7A · Utskrivet 7 nov. 2026");
    expect(within(sheet).getByText("Läsår 2025/26")).toBeInTheDocument();
    expect(within(sheet).getByText("Läsår 2026/27")).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Uppgifter om en enskild elev");
    expect(within(sheet).getAllByText("Måndag").length).toBeGreaterThan(0);
  });

  it("gives the page back when the browser says the print is done", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    dispatchAfterPrint();
    await waitFor(() => expect(document.body.querySelector(".print-sheet-root")).toBeNull());
    expect(document.documentElement).not.toHaveClass("printing-sheet");
  });

  it("gives the page back at the next click for a browser that never says the print is done", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    await user.click(screen.getByRole("heading", { level: 2, name: "Ola Berg" }));
    await waitFor(() => expect(document.body.querySelector(".print-sheet-root")).toBeNull());
    expect(document.documentElement).not.toHaveClass("printing-sheet");
  });

  it("leaves nothing behind when the card is left mid-print", async () => {
    const user = userEvent.setup();
    const { unmount } = renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    unmount();
    expect(document.documentElement).not.toHaveClass("printing-sheet");
    expect(document.body.querySelector(".print-sheet-root")).toBeNull();
  });

  it("prints nothing for a pupil the school's marks name, and says so", async () => {
    state.marks = [{ userId: STUDENT_ID, source: "MANUAL" }];
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    expect(await screen.findByText("Utskrift görs inte för en elev med skyddad identitet")).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
    expect(document.body.querySelector(".print-sheet-root")).toBeNull();
    expect(document.documentElement).not.toHaveClass("printing-sheet");
  });

  it("prints for a pupil the marks do not name, even when they name others", async () => {
    state.marks = [{ userId: "someone-else", source: "SS12000" }];
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
  });

  it("prints nothing when the marks cannot be read, and says that it could not check", async () => {
    state.marksError = true;
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    expect(await screen.findByText("Det gick inte att kontrollera skyddad identitet")).toBeInTheDocument();
    expect(screen.getByText(/Ingenting har skrivits ut/)).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
    expect(document.body.querySelector(".print-sheet-root")).toBeNull();
  });

  it("has no button for a card the gateway flags as protected, reads no marks, and says it is never printed", async () => {
    state.view = pupilView({ student: { ...pupilView().student, isProtected: true } });
    renderStats(card());
    await loaded();
    expect(screen.queryByRole("button", { name: "Skriv ut" })).not.toBeInTheDocument();
    expect(screen.getByText("Eleven har skyddad identitet")).toBeInTheDocument();
    expect(screen.getByText(/Utskrift görs inte för en elev med skyddad identitet/)).toBeInTheDocument();
    expect(reads()).not.toContain(MARKS_PATH);
    expect(window.print).not.toHaveBeenCalled();
  });

  it("prints a mentor's pupil without reading the marks, which a mentor may not", async () => {
    profile.value.profile.role = "TEACHER";
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    expect(reads()).not.toContain(MARKS_PATH);
  });

  it("prints again at the next press once the browser has said the print is done", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    dispatchAfterPrint();
    await waitFor(() => expect(document.body.querySelector(".print-sheet-root")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(2));
    // Every print asks the school's marks again: a mark set in between is never missed.
    expect(reads().filter((path) => path === MARKS_PATH)).toHaveLength(2);
  });

  it("draws the sheet from what the card read, and reads nothing more about the pupil", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(reads().filter((path) => path.startsWith(PUPIL_PATH))).toHaveLength(1);
  });

  it("writes nothing about the pupil to the browser's storage", async () => {
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(stored).not.toHaveBeenCalled();
    stored.mockRestore();
  });

  it("leaves a month with no mark as a dash on the paper, not a zero", async () => {
    const user = userEvent.setup();
    renderStats(card());
    await loaded();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    const sheet = document.body.querySelector<HTMLElement>(".print-sheet-root")!;
    const september = within(sheet).getByRole("row", { name: /^sep\./ });
    expect(plain(september)).toBe("sep. – – – –");
    expect(sheet).toHaveTextContent("”–” betyder att siffra saknas");
  });
});
