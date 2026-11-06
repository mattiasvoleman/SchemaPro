import { describe, expect, it } from "vitest";
import type { PublicationSettings } from "@/lib/publication-types";
import { embedOffered, modeOfKind, modeOfLink, modesOf, teachersUnnamed, viewerIsOn } from "@/lib/viewer-modes";

/**
 * The modes as the page reasons about them before a save, held to the
 * gateway's rules (src/publication/viewer-modes.ts; the links' reasons in
 * public-links.service.ts): a pupil is never in a list, a group link follows
 * its group's kind, a list of groups is a list if either kind is.
 */

type Settings = Pick<
  PublicationSettings,
  | "viewerAudience"
  | "viewerClassMode"
  | "viewerGroupMode"
  | "viewerTeacherMode"
  | "viewerStudentMode"
  | "viewerRoomMode"
  | "publicTeacherDisplay"
>;
const OFF: Settings = {
  viewerAudience: "STAFF",
  viewerClassMode: "OFF",
  viewerGroupMode: "OFF",
  viewerTeacherMode: "OFF",
  viewerStudentMode: "OFF",
  viewerRoomMode: "OFF",
  publicTeacherDisplay: "NONE",
};

describe("viewer modes on the screen", () => {
  it("offers a pupil Av and Fritext-ID and no list, every other kind all three", () => {
    expect(modesOf("STUDENT")).toEqual(["OFF", "CODE"]);
    for (const kind of ["CLASS", "GROUP", "TEACHER", "ROOM"] as const) expect(modesOf(kind)).toEqual(["OFF", "LIST", "CODE"]);
  });

  it("is on when any kind is shown, and off for a school with nothing set", () => {
    expect(viewerIsOn(OFF)).toBe(false);
    expect(viewerIsOn({ ...OFF, viewerStudentMode: "CODE" })).toBe(true);
    expect(modeOfKind({ ...OFF, viewerRoomMode: "LIST" }, "ROOM")).toBe("LIST");
  });

  it("reads a link's mode from its kind, and a group's from the kind of group it is", () => {
    const modes: Settings = { ...OFF, viewerClassMode: "LIST", viewerGroupMode: "CODE", viewerTeacherMode: "CODE", viewerRoomMode: "LIST", viewerStudentMode: "CODE" };
    expect(modeOfLink(modes, "GROUP", { groupKind: "CLASS" })).toBe("LIST");
    expect(modeOfLink(modes, "GROUP", { groupKind: "TEACHING_GROUP" })).toBe("CODE");
    expect(modeOfLink(modes, "TEACHER", null)).toBe("CODE");
    expect(modeOfLink(modes, "ROOM", null)).toBe("LIST");
    expect(modeOfLink(modes, "STUDENT", { groupKind: null })).toBe("CODE");
  });

  it("makes a list of groups a list if classes or groups are, a code if either is shown at all, else off", () => {
    expect(modeOfLink({ ...OFF, viewerGroupMode: "LIST" }, "GROUP", null)).toBe("LIST");
    expect(modeOfLink({ ...OFF, viewerClassMode: "LIST", viewerGroupMode: "CODE" }, "GROUP", null)).toBe("LIST");
    expect(modeOfLink({ ...OFF, viewerClassMode: "CODE" }, "GROUP", null)).toBe("CODE");
    expect(modeOfLink(OFF, "GROUP", null)).toBe("OFF");
  });

  it("offers embedding only for a kind that is shown, and only to a viewer open to everyone", () => {
    const open: Settings = { ...OFF, viewerAudience: "EVERYONE", viewerClassMode: "CODE", viewerStudentMode: "CODE" };
    expect(embedOffered(open, "publicEmbedGroups")).toBe(true);
    expect(embedOffered(open, "publicEmbedTeachers")).toBe(false);
    expect(embedOffered(open, "publicEmbedRooms")).toBe(false);
    // A teaching group alone is enough for the groups' switch.
    expect(embedOffered({ ...OFF, viewerAudience: "EVERYONE", viewerGroupMode: "LIST" }, "publicEmbedGroups")).toBe(true);
    // A viewer for staff is framed nowhere, whatever is shown.
    expect(embedOffered({ ...open, viewerAudience: "STAFF" }, "publicEmbedGroups")).toBe(false);
  });

  it("names the combination the gateway refuses: a teacher shown while the teacher is not named", () => {
    expect(teachersUnnamed({ viewerTeacherMode: "LIST", publicTeacherDisplay: "NONE" })).toBe(true);
    expect(teachersUnnamed({ viewerTeacherMode: "OFF", publicTeacherDisplay: "NONE" })).toBe(false);
    expect(teachersUnnamed({ viewerTeacherMode: "CODE", publicTeacherDisplay: "SIGNATURE" })).toBe(false);
  });
});
