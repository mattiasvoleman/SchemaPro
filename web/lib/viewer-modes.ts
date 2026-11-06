import {
  VIEWER_MODE_KEYS,
  type PublicScopeKind,
  type PublicationSettings,
  type ViewerKind,
  type ViewerMode,
} from "@/lib/publication-types";

/*
 * Schemavisarens lägen, said for the screen (the gateway's
 * src/publication/viewer-modes.ts and public-links.service.ts
 * notShownReasons are the rule; this is the same arithmetic so that a page can
 * tell what a setting will do before it is saved). The database decides what a
 * link answers, never this.
 *
 *   OFF   no link of the kind resolves;
 *   LIST  a list of the kind resolves, and so does a link to one target;
 *   CODE  Fritext-ID: only a link to one target resolves, to its holder.
 */

type Modes = Pick<PublicationSettings, (typeof VIEWER_MODE_KEYS)[ViewerKind]>;

/** The modes a kind may be set to: a pupil is never in a list (PUBLIC_STUDENTS_NOT_LISTED). */
export function modesOf(kind: ViewerKind): readonly ViewerMode[] {
  return kind === "STUDENT" ? ["OFF", "CODE"] : ["OFF", "LIST", "CODE"];
}

export function modeOfKind(settings: Modes, kind: ViewerKind): ViewerMode {
  return settings[VIEWER_MODE_KEYS[kind]];
}

/** Whether any kind is shown at all. */
export function viewerIsOn(settings: Modes): boolean {
  return (Object.keys(VIEWER_MODE_KEYS) as ViewerKind[]).some((kind) => modeOfKind(settings, kind) !== "OFF");
}

/**
 * The mode that governs a link the admin is about to make, as the gateway
 * reads it: its kind's, and for a link to one group its group's kind (a class
 * or a teaching group). A list of groups is a list if either classes or
 * groups are, and a code if either is shown at all.
 *
 * `target`: null = a list of the kind; otherwise the target, with the kind of
 * StudentGroup it is when the link is a group's.
 */
export function modeOfLink(
  settings: Modes,
  kind: PublicScopeKind,
  target: { groupKind: "CLASS" | "TEACHING_GROUP" | null } | null,
): ViewerMode {
  if (kind === "TEACHER") return settings.viewerTeacherMode;
  if (kind === "ROOM") return settings.viewerRoomMode;
  if (kind === "STUDENT") return settings.viewerStudentMode;
  if (target === null) {
    const { viewerClassMode: classes, viewerGroupMode: groups } = settings;
    return classes === "LIST" || groups === "LIST" ? "LIST" : classes !== "OFF" || groups !== "OFF" ? "CODE" : "OFF";
  }
  return target.groupKind === "TEACHING_GROUP" ? settings.viewerGroupMode : settings.viewerClassMode;
}

/** The kinds an embedding switch covers: a class and a group share one, a pupil has none. */
export const EMBED_KINDS = {
  publicEmbedGroups: ["CLASS", "GROUP"],
  publicEmbedTeachers: ["TEACHER"],
  publicEmbedRooms: ["ROOM"],
} as const satisfies Record<string, readonly ViewerKind[]>;
export type EmbedFlag = keyof typeof EMBED_KINDS;

/**
 * Whether a kind may be embedded at all: the viewer is open to everyone and
 * shows some kind the switch covers (embedding adds a frame, not a field).
 */
export function embedOffered(settings: Modes & Pick<PublicationSettings, "viewerAudience">, flag: EmbedFlag): boolean {
  return settings.viewerAudience === "EVERYONE" && EMBED_KINDS[flag].some((kind) => modeOfKind(settings, kind) !== "OFF");
}

/** The two refusals the gateway makes of a set of modes (PUBLIC_TEACHERS_UNNAMED; the pupil's list cannot be chosen here). */
export function teachersUnnamed(modes: Pick<PublicationSettings, "viewerTeacherMode" | "publicTeacherDisplay">): boolean {
  return modes.viewerTeacherMode !== "OFF" && modes.publicTeacherDisplay === "NONE";
}
