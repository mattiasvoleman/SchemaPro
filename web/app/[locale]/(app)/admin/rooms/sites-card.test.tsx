import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { minutesFromField, SitesCard } from "./sites-card";

/**
 * Skolområden och restid: the card names the pairs still missing a travel
 * time and the rooms on no site, because the gateway treats both as unknown
 * and says nothing about them anywhere else; and it saves every pair at
 * once, an empty field as no figure rather than as 0.
 */

const saveMock = vi.fn();
const state = vi.hoisted(() => ({
  data: undefined as
    | { sites: { id: string; name: string; roomCount: number }[]; travelTimes: { siteAId: string; siteBId: string; minutes: number }[]; roomsWithoutSite: number }
    | undefined,
}));

vi.mock("./use-sites", async () => {
  const actual = await vi.importActual<typeof import("./use-sites")>("./use-sites");
  return {
    ...actual,
    useSites: () => ({ data: state.data, isLoading: false, isError: false }),
    useSaveTravelTimes: () => ({ mutateAsync: saveMock, isPending: false }),
  };
});
vi.mock("@/lib/queries", () => ({
  useCrudMutations: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@tanstack/react-query", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    t.has = () => false;
    return t;
  },
}));

const NORRA = "10000000-0000-4000-8000-000000000001";
const SODRA = "20000000-0000-4000-8000-000000000002";
const HALLEN = "30000000-0000-4000-8000-000000000003";

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue([]);
  state.data = undefined;
});

describe("SitesCard", () => {
  it("says a school with no site needs none, and one site has no travel to count", () => {
    state.data = { sites: [], travelTimes: [], roomsWithoutSite: 4 };
    const { unmount } = render(<SitesCard />);
    expect(screen.getByText("empty")).toBeInTheDocument();
    // Rooms on no site are said only where a walk could be counted.
    expect(screen.queryByText("roomsWithoutSiteTitle")).not.toBeInTheDocument();
    unmount();

    state.data = { sites: [{ id: NORRA, name: "Norra", roomCount: 4 }], travelTimes: [], roomsWithoutSite: 0 };
    render(<SitesCard />);
    expect(screen.getByText("oneSite")).toBeInTheDocument();
    expect(screen.queryByText("travelTitle")).not.toBeInTheDocument();
  });

  it("names the pairs with no travel time and the rooms on no site", () => {
    state.data = {
      sites: [
        { id: NORRA, name: "Norra", roomCount: 3 },
        { id: SODRA, name: "Södra", roomCount: 2 },
        { id: HALLEN, name: "Hallen", roomCount: 1 },
      ],
      travelTimes: [{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }],
      roomsWithoutSite: 2,
    };
    render(<SitesCard />);
    expect(screen.getByText("missing(Norra–Hallen, Södra–Hallen)")).toBeInTheDocument();
    expect(screen.getByText("roomsWithoutSite(2)")).toBeInTheDocument();
    expect(screen.getByLabelText("pairLabel(Norra|Södra) (optional)")).toHaveValue("15");
  });

  it("saves every pair at once, an empty field as no figure, and refuses minutes the database would", async () => {
    state.data = {
      sites: [
        { id: NORRA, name: "Norra", roomCount: 3 },
        { id: SODRA, name: "Södra", roomCount: 2 },
        { id: HALLEN, name: "Hallen", roomCount: 1 },
      ],
      travelTimes: [{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }],
      roomsWithoutSite: 0,
    };
    const user = userEvent.setup();
    render(<SitesCard />);
    const save = screen.getByRole("button", { name: "saveTravel" });
    // Nothing changed yet.
    expect(save).toBeDisabled();

    const hallen = screen.getByLabelText("pairLabel(Södra|Hallen) (optional)");
    await user.type(hallen, "241");
    expect(screen.getByText("minutesInvalid")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(hallen);
    await user.type(hallen, "0");
    await user.clear(screen.getByLabelText("pairLabel(Norra|Södra) (optional)"));
    expect(save).toBeEnabled();
    await user.click(save);

    // With the figures it was looking at, so a save made meanwhile is not undone.
    expect(saveMock).toHaveBeenCalledWith({
      times: [{ siteIds: [SODRA, HALLEN], minutes: 0 }],
      basis: `${NORRA}|${SODRA}:15`,
    });
  });
});

describe("SitesCard keeps what the admin typed", () => {
  it("through a refetch: an edited field keeps its text, an untouched one takes the new figure", async () => {
    const sites = [
      { id: NORRA, name: "Norra", roomCount: 3 },
      { id: SODRA, name: "Södra", roomCount: 2 },
      { id: HALLEN, name: "Hallen", roomCount: 1 },
    ];
    const travelTimes = [{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }];
    state.data = { sites, travelTimes, roomsWithoutSite: 0 };
    const user = userEvent.setup();
    const { rerender } = render(<SitesCard />);
    const hallen = screen.getByLabelText("pairLabel(Södra|Hallen) (optional)");
    await user.type(hallen, "25");

    // A room saved elsewhere: the counts move, the pairs are the same array.
    state.data = { sites: sites.map((site) => ({ ...site, roomCount: site.roomCount + 1 })), travelTimes, roomsWithoutSite: 0 };
    rerender(<SitesCard />);
    expect(screen.getByLabelText("pairLabel(Södra|Hallen) (optional)")).toHaveValue("25");

    // Another tab saved Norra–Hallen: the untouched field takes it, the edited one keeps its text.
    state.data = {
      sites,
      travelTimes: [...travelTimes, { siteAId: NORRA, siteBId: HALLEN, minutes: 30 }],
      roomsWithoutSite: 0,
    };
    rerender(<SitesCard />);
    expect(screen.getByLabelText("pairLabel(Norra|Hallen) (optional)")).toHaveValue("30");
    expect(screen.getByLabelText("pairLabel(Södra|Hallen) (optional)")).toHaveValue("25");
  });
});

describe("minutesFromField", () => {
  it("is null when empty, whole minutes 0..240, and undefined for anything else", () => {
    expect(minutesFromField("  ")).toBeNull();
    expect(minutesFromField("0")).toBe(0);
    expect(minutesFromField(" 240 ")).toBe(240);
    for (const bad of ["241", "-1", "-", "7.5", "1e2", "tio"]) expect(minutesFromField(bad)).toBeUndefined();
  });
});
