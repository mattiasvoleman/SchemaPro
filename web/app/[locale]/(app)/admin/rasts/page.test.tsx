import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RastsPage from "./page";

// Radix needs these in jsdom to open a Select or a Dialog — environment, not
// behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * What this file guards: WHAT GETS SENT.
 *
 * `requiresLessonBefore` is the one field on this page whose effect is
 * invisible here. Everything else a school writes shows up in the resolved
 * week below the table, so a mistake is on screen; this flag changes what the
 * solver is asked for a fortnight later, and a form that drops it looks
 * exactly like a form that carries it. The gateway and the engine both test
 * the rule; nothing but this tests that the checkbox reaches them.
 *
 * The every-day sentinel is the same shape of bug and has the same claim on a
 * test: a Select cannot hold `dayOfWeek: null`, so the string "all" has to be
 * converted back on the way out, and a form that sends it fails only against a
 * real API.
 */

interface RastFixture {
  id: string;
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
  requiresLessonBefore: boolean;
}

const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();

const state = vi.hoisted(() => ({
  rasts: { data: [] as unknown[], isLoading: false },
}));

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useRasts: () => state.rasts,
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const rast = (overrides: Partial<RastFixture> = {}): RastFixture => ({
  id: "r1",
  name: "Förmiddagsrast",
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: null,
  startTime: "09:40:00",
  endTime: "10:00:00",
  requiresLessonBefore: false,
  ...overrides,
});

beforeEach(() => {
  cleanup();
  createMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
  removeMock.mockReset().mockResolvedValue({});
  state.rasts = { data: [], isLoading: false };
});

/** The rows of the list above the resolved week. */
const listRows = () =>
  within(screen.getByRole("region", { name: "rowsTitle" })).getAllByRole("row").slice(1);

describe("what the form sends", () => {
  it("carries the lesson-before requirement when it is switched on", async () => {
    const user = userEvent.setup();
    render(<RastsPage />);

    await user.click(screen.getByRole("button", { name: "add" }));
    await user.click(screen.getByRole("switch", { name: "lessonBefore" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ requiresLessonBefore: true, dayOfWeek: null }),
    );
  });

  it("leaves it off by default", async () => {
    const user = userEvent.setup();
    render(<RastsPage />);

    await user.click(screen.getByRole("button", { name: "add" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ requiresLessonBefore: false }),
    );
  });

  it("keeps a stored requirement when the rast is edited for something else", async () => {
    /*
     * The edit dialog is filled from the row, and a field the fill forgets is
     * silently turned OFF by the next save of an unrelated field — the school
     * renames a rast and loses a rule it set a term ago.
     */
    state.rasts = { data: [rast({ requiresLessonBefore: true })], isLoading: false };
    const user = userEvent.setup();
    render(<RastsPage />);

    await user.click(screen.getByRole("button", { name: "editRast(Förmiddagsrast)" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", requiresLessonBefore: true }),
    );
  });
});

describe("the list", () => {
  it("marks the rasts that require a lesson before them", () => {
    state.rasts = {
      data: [
        rast({ id: "r1", name: "Förmiddagsrast", requiresLessonBefore: true }),
        rast({ id: "r2", name: "Eftermiddagsrast", requiresLessonBefore: false }),
      ],
      isLoading: false,
    };
    render(<RastsPage />);

    const [morning, afternoon] = listRows();
    expect(within(morning).getByText("lessonBeforeShort")).toBeTruthy();
    expect(within(afternoon).queryByText("lessonBeforeShort")).toBeNull();
  });
});
