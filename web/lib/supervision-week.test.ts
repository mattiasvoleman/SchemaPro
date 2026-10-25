import { describe, expect, it } from "vitest";
import { PASS_COLOR, isPassEntry, weekPassesToGrid, type WeekPass } from "./supervision-week";

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
    expect(cover).toMatchObject({ id: "pass:COVER:s-2:2026-10-12", subtitle: "Skolgården · Vikarie" });
    expect(cover).not.toHaveProperty("room");
    expect(handed!.subtitle).toBe("Skolgården · Vikarie tar passet");
    expect(none!.subtitle).toBe("Skolgården · Utan ersättare");
  });

  it("tells a pass's block from a lesson's", () => {
    expect(isPassEntry({ id: "pass:OWN:s-1:2026-10-12" })).toBe(true);
    expect(isPassEntry({ id: "0b1e…-lesson" })).toBe(false);
  });
});
