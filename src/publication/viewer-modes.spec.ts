import { DEFAULT_VIEWER_MODES, legacySwitches, modeFor, modesRefusal, MODE_KEYS, PUBLIC_STUDENTS_NOT_LISTED, PUBLIC_TEACHERS_UNNAMED, viewerIsOn } from './viewer-modes';

const off = DEFAULT_VIEWER_MODES;

describe('Schemavisarens lägen', () => {
  it('starts with nothing shown, and to staff if anything ever is', () => {
    expect(off.viewerAudience).toBe('STAFF');
    for (const key of MODE_KEYS) expect(off[key]).toBe('OFF');
    expect(viewerIsOn(off)).toBe(false);
  });

  it('is on as soon as one kind is not off', () => {
    for (const key of MODE_KEYS) {
      expect(viewerIsOn({ ...off, [key]: 'CODE' })).toBe(true);
      expect(viewerIsOn({ ...off, [key]: 'LIST' })).toBe(true);
    }
  });

  describe('the four switches the viewer had before its modes, said from them', () => {
    it('is all false for a school that shows nothing', () => {
      expect(legacySwitches(off)).toEqual({ publicViewerEnabled: false, publicGroups: false, publicTeachers: false, publicRooms: false });
    });

    it.each([
      ['a class alone', { viewerClassMode: 'CODE' }, { publicViewerEnabled: true, publicGroups: true, publicTeachers: false, publicRooms: false }],
      ['a teaching group alone', { viewerGroupMode: 'LIST' }, { publicViewerEnabled: true, publicGroups: true, publicTeachers: false, publicRooms: false }],
      ['teachers', { viewerTeacherMode: 'CODE' }, { publicViewerEnabled: true, publicGroups: false, publicTeachers: true, publicRooms: false }],
      ['rooms', { viewerRoomMode: 'LIST' }, { publicViewerEnabled: true, publicGroups: false, publicTeachers: false, publicRooms: true }],
      // A pupil's page had no switch of its own: it makes the viewer on and nothing else.
      ['pupils', { viewerStudentMode: 'CODE' }, { publicViewerEnabled: true, publicGroups: false, publicTeachers: false, publicRooms: false }],
    ])('follows %s', (_what, change, expected) => {
      expect(legacySwitches({ ...off, ...change } as typeof off)).toEqual(expected);
    });
  });

  describe('the mode a link is shown in', () => {
    const modes = { ...off, viewerClassMode: 'LIST', viewerGroupMode: 'CODE', viewerTeacherMode: 'OFF', viewerStudentMode: 'CODE', viewerRoomMode: 'LIST' } as const;

    it('is the class mode for a class and the group mode for a teaching group', () => {
      expect(modeFor(modes, 'GROUP', 'CLASS')).toBe('LIST');
      expect(modeFor(modes, 'GROUP', 'TEACHING_GROUP')).toBe('CODE');
    });

    it('is the kind\'s own mode for the others', () => {
      expect(modeFor(modes, 'TEACHER', null)).toBe('OFF');
      expect(modeFor(modes, 'STUDENT', null)).toBe('CODE');
      expect(modeFor(modes, 'ROOM', null)).toBe('LIST');
    });

    it('is the class mode for a group link whose group is not known (an index)', () => {
      expect(modeFor(modes, 'GROUP', null)).toBe('LIST');
    });
  });

  describe('what the table\'s CHECKs refuse, said with the fields named', () => {
    it('refuses a list of pupils: a register of where they are', () => {
      expect(modesRefusal({ ...off, viewerStudentMode: 'LIST' }, 'SIGNATURE')?.code).toBe(PUBLIC_STUDENTS_NOT_LISTED);
    });

    it('refuses teachers shown while nobody is named', () => {
      for (const mode of ['LIST', 'CODE'] as const) {
        expect(modesRefusal({ ...off, viewerTeacherMode: mode }, 'NONE')?.code).toBe(PUBLIC_TEACHERS_UNNAMED);
        expect(modesRefusal({ ...off, viewerTeacherMode: mode }, 'SIGNATURE')).toBeNull();
        expect(modesRefusal({ ...off, viewerTeacherMode: mode }, 'NAME')).toBeNull();
      }
      expect(modesRefusal(off, 'NONE')).toBeNull();
    });

    it('lets a pupil\'s code stand', () => {
      expect(modesRefusal({ ...off, viewerStudentMode: 'CODE' }, 'NONE')).toBeNull();
    });
  });
});
