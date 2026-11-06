/**
 * Schemavisarens lägen (20270118090000): the school's choice, per kind of
 * schedule, of how the viewer shows it, and to whom. The database decides
 * what a link answers (app.schemavisaren_read); this is the same vocabulary
 * for the settings, the admin's list of links and the tests.
 *
 *   OFF   not shown: no link of the kind resolves;
 *   LIST  a list the viewer can pick from: an index link of the kind
 *         resolves, and so does a link to one target;
 *   CODE  Fritext-ID: shown only to the holder of the exact code, a link to
 *         one target; an index link of the kind does not resolve.
 *
 * Five kinds: a class and a teaching group (both StudentGroups, told apart by
 * their kind), a teacher, a pupil and a room. A pupil is never LIST.
 */
export const VIEWER_MODES = ['OFF', 'LIST', 'CODE'] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];

export const VIEWER_AUDIENCES = ['STAFF', 'EVERYONE'] as const;
export type ViewerAudience = (typeof VIEWER_AUDIENCES)[number];

export type ViewerKind = 'CLASS' | 'GROUP' | 'TEACHER' | 'STUDENT' | 'ROOM';

/** The settings column of each kind. */
export const VIEWER_MODE_KEYS = {
  CLASS: 'viewerClassMode',
  GROUP: 'viewerGroupMode',
  TEACHER: 'viewerTeacherMode',
  STUDENT: 'viewerStudentMode',
  ROOM: 'viewerRoomMode',
} as const satisfies Record<ViewerKind, string>;

export type ViewerModes = { viewerAudience: ViewerAudience } & { [K in (typeof VIEWER_MODE_KEYS)[ViewerKind]]: ViewerMode };

/** A school with no settings row: nothing shown, and to staff if it ever is. */
export const DEFAULT_VIEWER_MODES: ViewerModes = {
  viewerAudience: 'STAFF',
  viewerClassMode: 'OFF',
  viewerGroupMode: 'OFF',
  viewerTeacherMode: 'OFF',
  viewerStudentMode: 'OFF',
  viewerRoomMode: 'OFF',
};

export const MODE_KEYS = Object.values(VIEWER_MODE_KEYS);

/** Whether any kind is shown at all: the old "viewer on". */
export function viewerIsOn(modes: Pick<ViewerModes, (typeof MODE_KEYS)[number]>): boolean {
  return MODE_KEYS.some((key) => modes[key] !== 'OFF');
}

/**
 * The four switches Schemavisaren had before the modes (publicViewerEnabled,
 * publicGroups, publicTeachers, publicRooms), as the modes imply them. They
 * stay in their columns for the API that runs beside a deploy and for a
 * rollback, and the API writes them from the modes; the viewer reads only
 * the modes.
 */
export function legacySwitches(modes: Pick<ViewerModes, (typeof MODE_KEYS)[number]>): {
  publicViewerEnabled: boolean;
  publicGroups: boolean;
  publicTeachers: boolean;
  publicRooms: boolean;
} {
  return {
    publicViewerEnabled: viewerIsOn(modes),
    publicGroups: modes.viewerClassMode !== 'OFF' || modes.viewerGroupMode !== 'OFF',
    publicTeachers: modes.viewerTeacherMode !== 'OFF',
    publicRooms: modes.viewerRoomMode !== 'OFF',
  };
}

/** The mode a link's kind (and, for a GROUP link, its target's kind) is shown in. */
export function modeFor(
  modes: Pick<ViewerModes, (typeof MODE_KEYS)[number]>,
  kind: 'GROUP' | 'TEACHER' | 'ROOM' | 'STUDENT',
  groupKind: 'CLASS' | 'TEACHING_GROUP' | null,
): ViewerMode {
  if (kind === 'TEACHER') return modes.viewerTeacherMode;
  if (kind === 'ROOM') return modes.viewerRoomMode;
  if (kind === 'STUDENT') return modes.viewerStudentMode;
  return groupKind === 'TEACHING_GROUP' ? modes.viewerGroupMode : modes.viewerClassMode;
}

export const PUBLIC_STUDENTS_NOT_LISTED = 'PUBLIC_STUDENTS_NOT_LISTED';
export const PUBLIC_TEACHERS_UNNAMED = 'PUBLIC_TEACHERS_UNNAMED';

/** The table's two CHECKs, said with the fields named; null when the modes stand. */
export function modesRefusal(
  modes: Pick<ViewerModes, (typeof MODE_KEYS)[number]>,
  teacherDisplay: 'NONE' | 'SIGNATURE' | 'NAME',
): { code: string; message: string } | null {
  if (modes.viewerStudentMode === 'LIST') {
    return {
      code: PUBLIC_STUDENTS_NOT_LISTED,
      message: 'viewerStudentMode: en elevs schema visas bara med kod, aldrig i en lista; en lista över elever vore ett register över var de är.',
    };
  }
  if (modes.viewerTeacherMode !== 'OFF' && teacherDisplay === 'NONE') {
    return {
      code: PUBLIC_TEACHERS_UNNAMED,
      message: 'publicTeacherDisplay: lärarscheman visar läraren som signatur eller namn; välj ett av dem.',
    };
  }
  return null;
}
