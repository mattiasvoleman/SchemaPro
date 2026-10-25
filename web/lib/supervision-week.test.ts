import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { PASS_COLOR, isPassEntry, readSupervisionWeek, weekPassesToGrid, type WeekPass } from "./supervision-week";

/**
 * The teacher's own rastvaktspass as blocks of their week (Rastvakt i
 * vardagen): on the reader's clock as the lessons are, with the area and the
 * skolområde, a vikarie's pass and a handover said, and an id no lesson page
 * is opened for.
 */

const labels = { title: "Rastvakt", cover: "Vikarie", handedOver: "Vikarie tar passet", noCover: "Utan ersättare" };
const local = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();

const pass = (overrides: Partial<WeekPass> = {}): WeekPass => ({
  kind: "OWN",
  shiftId: "s-1",
  date: "2026-10-12",
  startsAt: local("2026-10-12", "10:00"),
  endsAt: local("2026-10-12", "10:20"),
  areaName: "Skolgården",
  siteName: "Norra",
  handover: null,
  ...overrides,
});

describe("the teacher's passes in their week", () => {
  it("draws an own pass at its weekday and minutes, the area under the title and the site as the room", () => {
    expect(weekPassesToGrid([pass()], labels)).toEqual([
      {
        id: "pass:OWN:s-1:2026-10-12",
        dayOfWeek: 1,
        startMinutes: 600,
        endMinutes: 620,
        title: "Rastvakt",
        subtitle: "Skolgården",
        room: "Norra",
        color: PASS_COLOR,
        duty: true,
      },
    ]);
  });

  it("says a pass taken as vikarie, and an own pass a vikarie takes or nobody does", () => {
    const [cover, handed, none] = weekPassesToGrid(
      [
        pass({ kind: "COVER", shiftId: "s-2", siteName: null }),
        pass({ handover: "SUBSTITUTE" }),
        pass({ shiftId: "s-3", handover: "NO_COVER" }),
      ],
      labels,
    );
    // Whose it is that day before the place: a narrow column cuts the place, never that.
    expect(cover).toMatchObject({ id: "pass:COVER:s-2:2026-10-12", subtitle: "Vikarie · Skolgården" });
    expect(cover).not.toHaveProperty("room");
    expect(cover).not.toHaveProperty("relieved");
    expect(handed).toMatchObject({ subtitle: "Vikarie tar passet · Skolgården", relieved: true });
    expect(none).toMatchObject({ subtitle: "Utan ersättare · Skolgården", relieved: true });
  });

  it("tells a pass's block from a lesson's", () => {
    expect(isPassEntry({ id: "pass:OWN:s-1:2026-10-12" })).toBe(true);
    expect(isPassEntry({ id: "0b1e…-lesson" })).toBe(false);
  });
});

describe("the week's read", () => {
  it("reads a gateway without the route (a 404 without a code) as no passes, and any refusal of its own as one", async () => {
    const get = vi.spyOn(api, "get");
    get.mockRejectedValueOnce(new ApiError(404, "Cannot GET /api/v1/supervision/week"));
    await expect(readSupervisionWeek("2026-10-12", "2026-10-18")).resolves.toEqual({ from: "2026-10-12", to: "2026-10-18", passes: [] });
    get.mockRejectedValueOnce(new ApiError(400, "Högst 14 dagar åt gången.", "SUPERVISION_WEEK_RANGE"));
    await expect(readSupervisionWeek("2026-10-12", "2026-11-18")).rejects.toBeInstanceOf(ApiError);
    get.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(readSupervisionWeek("2026-10-12", "2026-10-18")).rejects.toBeInstanceOf(ApiError);
    get.mockRestore();
  });
});
