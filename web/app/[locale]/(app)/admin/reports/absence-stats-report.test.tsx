import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { CLASSES, CLASS_ID, CLASS_VIEW, PUPILS, SCHOOL_SERIES, WINDOW } from "@/components/absence-stats/__fixtures__/views";
import { plain, renderStats } from "@/components/absence-stats/__fixtures__/render";
import { AbsenceStatsReport } from "./absence-stats-report";

/**
 * The Frånvarostatistik tab of /admin/reports, through the gateway's routes
 * and the real messages: the school's months first, then the classes.
 *
 * What this guards: a failed read of the school is said as such and leaves the
 * classes alone (each part reads on its own); nothing is drawn as 0 for a
 * month without a figure; and the huvudman's läsare, who reads the school and
 * the classes, is never asked for a pupil.
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
  school: undefined as unknown,
  schoolError: false,
  hold: null as null | Promise<void>,
}));

const reads = () => api.get.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  vi.clearAllMocks();
  profile.value.schools = [{ schoolId: "sch-1", huvudman: null }];
  state.school = { window: WINDOW, series: SCHOOL_SERIES };
  state.schoolError = false;
  state.hold = null;
  api.get.mockImplementation(async (path: string) => {
    if (state.hold) await state.hold;
    if (path === `${ROOT}/school`) {
      if (state.schoolError) throw new ApiError(500, "boom");
      return state.school;
    }
    if (path === `${ROOT}/classes`) return CLASSES;
    if (path === `${ROOT}/classes/${CLASS_ID}`) return CLASS_VIEW;
    if (path === `${ROOT}/classes/${CLASS_ID}/pupils`) return PUPILS;
    throw new Error(`unexpected read ${path}`);
  });
});

describe("the school's months", () => {
  it("is busy until the school is read, then says what is counted and draws the months beside the reporting rate", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    renderStats(<AbsenceStatsReport />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();

    expect(await screen.findByRole("region", { name: "Skolan månad för månad" }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(/Giltig och ogiltig frånvaro i procent av de registrerade minuterna/)).toBeInTheDocument();
    expect(screen.getByText(/ingen siffra visas för en grupp med färre än 5 elever/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Skolans frånvaro per månad" });
    expect(within(table).getByRole("columnheader", { name: "Rapporteringsgrad" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Diagram över giltig och ogiltig frånvaro/ })).toBeInTheDocument();
    expect(plain(within(screen.getByRole("row", { name: /^okt\. 2026/ })).getAllByRole("cell")[5])).toBe(
      "95,0 % 399 av 420 lektioner Förra året: 90,0 %",
    );
    expect(reads()).toEqual(expect.arrayContaining([`${ROOT}/school`, `${ROOT}/classes`]));
  });

  it("marks the month that is going on, and a month with too few pupils has no figure rather than a zero", async () => {
    renderStats(<AbsenceStatsReport />);
    await screen.findByRole("table", { name: "Skolans frånvaro per månad" });
    await screen.findByRole("table", { name: "Frånvaro per klass" });
    expect(screen.getByText("Hittills, till och med 6 nov. 2026")).toBeInTheDocument();
    // The school's September, and the class that is too small to count.
    expect(screen.getAllByText("Ingen siffra: färre än 5 elever har markeringar")).toHaveLength(2);
  });

  it("says that the school could not be read, shows no figure for it, and leaves the classes alone", async () => {
    state.schoolError = true;
    const user = userEvent.setup();
    renderStats(<AbsenceStatsReport />);
    expect(await screen.findByText("Skolans frånvaro kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Skolans frånvaro per månad" })).not.toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Frånvaro per klass" })).toBeInTheDocument();

    state.schoolError = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: "Skolans frånvaro per månad" })).toBeInTheDocument();
  });

  it("says that nothing has been counted yet, in place of a chart of nothing", async () => {
    state.school = { window: WINDOW, series: [] };
    renderStats(<AbsenceStatsReport />);
    expect(await screen.findByText("Ingen frånvaro att visa än")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("speaks English too", async () => {
    renderStats(<AbsenceStatsReport />, "en");
    expect(await screen.findByRole("region", { name: "The school, month by month" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "The school's absence per month" })).toBeInTheDocument();
    expect(screen.getByText(/no figure is shown for a group of fewer than 5 pupils/)).toBeInTheDocument();
  });
});

describe("down to a class and its pupils", () => {
  it("opens a class from the classes, with its pupils for an administrator", async () => {
    const user = userEvent.setup();
    renderStats(<AbsenceStatsReport />);
    await user.click(await screen.findByRole("button", { name: "Visa klass 7A" }));
    expect(await screen.findByRole("table", { name: "Elevernas frånvaro i klassen" })).toBeInTheDocument();
  });

  it("gives the huvudman's läsare the school and the classes, and is never asked for a pupil", async () => {
    profile.value.schools = [{ schoolId: "sch-1", huvudman: { id: "h-1", name: "Kommunen" } }];
    const user = userEvent.setup();
    renderStats(<AbsenceStatsReport />);
    expect(await screen.findByRole("table", { name: "Skolans frånvaro per månad" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Visa klass 7A" }));
    expect(await screen.findByText("Elever visas inte för huvudmannens läsare")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /elevkort/i })).not.toBeInTheDocument();
    expect(reads().some((path) => path.includes("/pupils"))).toBe(false);
  });
});
