import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeArea, IntakeGap, IntakeView } from "@/lib/intake";
import IntakePage from "./page";

/**
 * Vad kom in. The page counts what the gateway counted and links each gap to the page that owns it; it writes nothing, says that
 * nothing stops Generera and never that the school is ready, and says it could not read rather than showing a school with no data.
 */

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, refetch: vi.fn() },
}));

vi.mock("@/lib/intake-queries", () => ({ useIntake: () => state.query }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace?: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${namespace ? `${namespace}.` : ""}${key}${values ? `(${Object.values(values).join("|")})` : ""}`;
    // A text a newer gateway has and this build lacks: the key the mock is asked about names it.
    t.has = (key: string) => !key.includes("A_GAP_FROM_NEXT_YEAR") && !key.includes("aCountFromNextYear");
    return t;
  },
}));

const gap = (code: string, level: IntakeGap["level"], count = 0, items: string[] = [], more = 0): IntakeGap => ({ code, level, count, items, more });
const area = (name: string, found: Record<string, number>, gaps: IntakeGap[], waitsForYear = false): IntakeArea => ({ area: name, found, waitsForYear, gaps });
const view = (areas: IntakeArea[], year: IntakeView["year"] = { id: "y", name: "2026/27", isActive: true }): IntakeView => {
  const there = areas.flatMap((entry) => entry.gaps).filter((entry) => entry.count > 0);
  return {
    year,
    areas,
    hard: there.filter((entry) => entry.level === "HARD").length,
    soft: there.filter((entry) => entry.level === "SOFT").length,
    info: there.filter((entry) => entry.level === "INFO").length,
  };
};

const card = (name: string) => screen.getByRole("region", { name: `intake.areas.${name}` });

beforeEach(() => {
  state.query = { data: undefined, isLoading: false, refetch: vi.fn() };
});

describe("while it is read, and when it cannot be", () => {
  it("shows a busy placeholder and no figure while the answer is on its way", () => {
    state.query = { ...state.query, isLoading: true };
    const { container } = render(<IntakePage />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("intake.nothingMissing")).toBeNull();
  });

  it("says it could not read, offers another try, and shows no area as empty", async () => {
    const refetch = vi.fn();
    state.query = { data: undefined, isLoading: false, refetch };
    render(<IntakePage />);
    expect(screen.getByText("intake.loadFailed")).toBeTruthy();
    expect(screen.queryByText("intake.nothingMissing")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "intake.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("what stops Generera", () => {
  const empty = view(
    [
      area("YEAR", { years: 0 }, [gap("NO_YEAR", "HARD", 1)]),
      area("ROOMS", { rooms: 0 }, [gap("NO_ROOMS", "HARD", 1)]),
      area("PEOPLE", { teachers: 0, students: 0 }, [gap("NO_TEACHERS", "HARD", 1), gap("NO_STUDENTS", "SOFT", 1)]),
    ],
    null,
  );

  it("counts what stops it, in the warning tone's words, and points at Generera", () => {
    state.query = { ...state.query, data: empty };
    render(<IntakePage />);
    expect(screen.getByText("intake.summary.hardTitle(3)")).toBeTruthy();
    expect(screen.getByText("intake.summary.hardBody")).toBeTruthy();
    expect(screen.queryByText("intake.summary.okTitle")).toBeNull();
    expect(screen.getByRole("link", { name: /intake\.summary\.generate/ }).getAttribute("href")).toBe("/admin/generate");
  });

  it("names each gap's level in words, beside its colour", () => {
    state.query = { ...state.query, data: empty };
    render(<IntakePage />);
    const people = within(card("PEOPLE"));
    expect(people.getByText("intake.levels.HARD")).toBeTruthy();
    expect(people.getByText("intake.levels.SOFT")).toBeTruthy();
    expect(people.getByText("intake.gaps.NO_TEACHERS.title(1)")).toBeTruthy();
  });

  it("links each gap to the page that owns it, by the menu's own word", () => {
    state.query = { ...state.query, data: empty };
    render(<IntakePage />);
    expect(within(card("ROOMS")).getByRole("link").getAttribute("href")).toBe("/admin/rooms");
    expect(within(card("ROOMS")).getByRole("link").textContent).toContain("intake.open(nav.rooms)");
    expect(within(card("YEAR")).getByRole("link").getAttribute("href")).toBe("/admin/setup");
    expect(within(card("PEOPLE")).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/admin/people", "/admin/people"]);
  });
});

describe("a school with nothing that stops Generera", () => {
  const nearly = view([
    area("SUBJECTS", { subjects: 8 }, [gap("SUBJECTS_WITHOUT_POSTS", "INFO", 1, ["Teknik"])]),
    area("FRAME_TIMES", { frameTimes: 2 }, [gap("FRAME_TIMES_MISSING", "SOFT", 1, ["9"])]),
    area("CLASSES", { classes: 4 }, [gap("CLASSES_WITHOUT_POSTS", "SOFT", 11, ["7A", "7B"], 9)]),
    area("ROOMS", { rooms: 7 }, [gap("NO_ROOMS", "HARD", 0)]),
  ]);

  it("says nothing it counts stops Generera, and not that the week can be laid or that the school is ready", () => {
    state.query = { ...state.query, data: nearly };
    render(<IntakePage />);
    expect(screen.getByText("intake.summary.okTitle")).toBeTruthy();
    expect(screen.getByText("intake.summary.okBody")).toBeTruthy();
    expect(screen.queryByText("intake.summary.hardTitle(0)")).toBeNull();
    // The year and the lesser gaps are counted under it, so a clean top is not a clean page.
    expect(screen.getByText(/intake\.year\(2026\/27\).*intake\.summary\.soft\(2\).*intake\.summary\.info\(1\)/)).toBeTruthy();
  });

  it("writes an årskurs as a year group and a class by its name, and says how many more there are", () => {
    state.query = { ...state.query, data: nearly };
    render(<IntakePage />);
    expect(within(card("FRAME_TIMES")).getByText("intake.appliesTo(intake.grade(9))")).toBeTruthy();
    expect(within(card("SUBJECTS")).getByText("intake.appliesTo(Teknik)")).toBeTruthy();
    expect(within(card("CLASSES")).getByText("intake.appliesTo(7A, 7B, intake.more(9))")).toBeTruthy();
  });

  it("lists no gap that is not there, and says nothing is missing for an area with none", () => {
    state.query = { ...state.query, data: nearly };
    render(<IntakePage />);
    const rooms = within(card("ROOMS"));
    expect(rooms.getByText("intake.nothingMissing")).toBeTruthy();
    expect(rooms.queryByText(/NO_ROOMS/)).toBeNull();
    expect(rooms.queryByRole("link")).toBeNull();
  });

  it("gives each area its found counts under its name", () => {
    state.query = { ...state.query, data: nearly };
    render(<IntakePage />);
    expect(within(card("ROOMS")).getByText("intake.foundHeading: intake.found.rooms(7)")).toBeTruthy();
  });
});

describe("a school with no active läsår", () => {
  it("says the year-bound areas wait for it, and does not say that nothing is missing or how many it found", () => {
    state.query = {
      ...state.query,
      data: view(
        [
          area("YEAR", { years: 0 }, [gap("NO_YEAR", "HARD", 1)]),
          area("CLASSES", { classes: 0 }, [], true),
          area("REQUIREMENTS", { requirements: 0 }, [], true),
        ],
        null,
      ),
    };
    render(<IntakePage />);
    for (const name of ["CLASSES", "REQUIREMENTS"]) {
      const waiting = within(card(name));
      expect(waiting.getByText("intake.waitsForYear")).toBeTruthy();
      expect(waiting.queryByText("intake.nothingMissing")).toBeNull();
      expect(waiting.queryByText(/intake\.foundHeading/)).toBeNull();
    }
    // The area that is not waiting says what it found and what is missing, as before.
    expect(within(card("YEAR")).getByText("intake.gaps.NO_YEAR.title(1)")).toBeTruthy();
    expect(within(card("YEAR")).queryByText("intake.waitsForYear")).toBeNull();
  });
});

describe("a post with no teacher", () => {
  it("reads the choice of Vägra in its hint, and the ordinary hint otherwise", () => {
    state.query = { ...state.query, data: view([area("STAFFING", { posts: 3 }, [gap("UNSTAFFED_POSTS", "HARD", 2)])]) };
    const { unmount } = render(<IntakePage />);
    expect(screen.getByText("intake.gaps.UNSTAFFED_POSTS.hintHard")).toBeTruthy();
    unmount();
    state.query = { ...state.query, data: view([area("STAFFING", { posts: 3 }, [gap("UNSTAFFED_POSTS", "SOFT", 2)])]) };
    render(<IntakePage />);
    expect(screen.getByText("intake.gaps.UNSTAFFED_POSTS.hint")).toBeTruthy();
  });
});

describe("a gap a newer gateway has", () => {
  it("is a row with its code where the title would be, no link, and the area does not say nothing is missing", () => {
    state.query = { ...state.query, data: view([area("ROOMS", { rooms: 4, aCountFromNextYear: 2 }, [gap("A_GAP_FROM_NEXT_YEAR", "SOFT", 3)])]) };
    render(<IntakePage />);
    const rooms = within(card("ROOMS"));
    expect(rooms.getByText("A_GAP_FROM_NEXT_YEAR")).toBeTruthy();
    expect(rooms.queryByRole("link")).toBeNull();
    expect(rooms.queryByText("intake.nothingMissing")).toBeNull();
    // A count with no words is left out of the found line, not written as a key.
    expect(rooms.getByText("intake.foundHeading: intake.found.rooms(4)")).toBeTruthy();
  });
});
