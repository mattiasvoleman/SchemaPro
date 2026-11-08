import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  CLASSES,
  CLASS_ID,
  CLASS_VIEW,
  PUPILS,
  STUDENT_ID,
  pupilView,
} from "@/components/absence-stats/__fixtures__/views";
import { renderStats } from "@/components/absence-stats/__fixtures__/render";
import TeacherAbsenceStatsPage from "./page";

/**
 * /teacher/absence-stats: the mentor's page, through the gateway's routes and
 * the real messages. The gateway answers a mentor with their own classes and
 * pupils only; what this guards is that the page asks for those and nothing
 * of the school's, says an empty answer kindly and a failed one as such, and
 * tells a mentor nothing about the pupils the school has marked.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const profile = vi.hoisted(() => ({
  value: {
    profile: { schoolId: "sch-1", role: "TEACHER" },
    school: { id: "sch-1", name: "Exempelskolan", slug: "exempel", timezone: "Europe/Stockholm" },
    schools: [{ schoolId: "sch-1", huvudman: null }],
  },
}));
vi.mock("@/components/profile-context", () => ({ useProfile: () => profile.value }));

const ROOT = "/api/v1/absence-stats";
const state = vi.hoisted(() => ({ classes: undefined as unknown, classesError: false }));
const reads = () => api.get.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  vi.clearAllMocks();
  state.classes = CLASSES;
  state.classesError = false;
  api.get.mockImplementation(async (path: string) => {
    if (path === `${ROOT}/classes`) {
      if (state.classesError) throw new ApiError(500, "boom");
      return state.classes;
    }
    if (path === `${ROOT}/classes/${CLASS_ID}`) return CLASS_VIEW;
    if (path === `${ROOT}/classes/${CLASS_ID}/pupils`) return { ...PUPILS, heldOut: null };
    if (path === `${ROOT}/pupils/${STUDENT_ID}`) return pupilView();
    throw new Error(`unexpected read ${path}`);
  });
});

describe("the mentor's page", () => {
  it("is headed Frånvarostatistik över tid, links back to the watch and reads the classes alone", async () => {
    renderStats(<TeacherAbsenceStatsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Frånvarostatistik över tid" })).toBeInTheDocument();
    expect(screen.getByText(/Frånvaron i klasserna där du är mentor/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Till Frånvarobevakning" })).toHaveAttribute(
      "href",
      expect.stringContaining("/teacher/absence-watch"),
    );
    expect(await screen.findByRole("table", { name: "Frånvaro per klass" })).toBeInTheDocument();
    expect(reads()).toEqual([`${ROOT}/classes`]);
  });

  it("goes from a class to its pupils and a pupil's card, and tells a mentor nothing of a protected identity", async () => {
    const user = userEvent.setup();
    renderStats(<TeacherAbsenceStatsPage />);
    await user.click(await screen.findByRole("button", { name: "Visa klass 7A" }));
    expect(await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" })).toBeInTheDocument();
    expect(screen.queryByText(/skyddad identitet/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Visa elevkort för Berg, Ola" }));
    // The card is a chunk of its own, fetched on this click.
    expect(await screen.findByRole("heading", { level: 2, name: "Ola Berg" }, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skriv ut" })).toBeInTheDocument();
    expect(reads().some((path) => path.endsWith("/school"))).toBe(false);
  });

  it("welcomes a teacher who is mentor for nobody", async () => {
    state.classes = { ...CLASSES, classes: [] };
    renderStats(<TeacherAbsenceStatsPage />);
    expect(await screen.findByText("Du är inte mentor för någon klass")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(reads()).toEqual([`${ROOT}/classes`]);
  });

  it("says that the classes could not be read and shows no figure, never an empty list", async () => {
    state.classesError = true;
    renderStats(<TeacherAbsenceStatsPage />);
    expect(await screen.findByText("Klasserna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Du är inte mentor för någon klass")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("speaks English too", async () => {
    renderStats(<TeacherAbsenceStatsPage />, "en");
    expect(screen.getByRole("heading", { level: 1, name: "Absence statistics over time" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Absence per class" })).toBeInTheDocument();
  });
});
