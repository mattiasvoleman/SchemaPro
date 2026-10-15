import { EMBED_ORIGIN_PATTERN, normalizeEmbedOrigin, normalizeEmbedOrigins } from './embed-origins';
import { embedsKind } from './public-links.service';
import { defaultTeacherDisplay } from './print-timetables.service';

/**
 * The websites a school lets frame Schemavisaren (20261102090000): what an
 * admin types becomes a frame-ancestors source or stays as typed for the DTO
 * to refuse, by the same pattern the PublicationSettings CHECK holds.
 */
describe('embed origins', () => {
  it.each([
    ['skolan.se', 'https://skolan.se'],
    [' Skolan.SE ', 'https://skolan.se'],
    ['https://skolan.se/', 'https://skolan.se'],
    ['HTTPS://www.Skolan.se:8443', 'https://www.skolan.se:8443'],
    ['www.skolan.se', 'https://www.skolan.se'],
    ['https://skolan.se:65535', 'https://skolan.se:65535'],
    ['https://skolan.se:443', 'https://skolan.se'],
    ['skolgården.se', 'https://xn--skolgrden-92a.se'],
  ])('takes %j as %s', (typed, origin) => {
    expect(normalizeEmbedOrigin(typed)).toBe(origin);
    expect(EMBED_ORIGIN_PATTERN.test(origin)).toBe(true);
  });

  it.each([
    'http://skolan.se', // frame-ancestors over plain http is a frame anyone on the path can rewrite
    'https://skolan.se/schema', // an origin, not a page: the page is the school's to choose
    'https://skolan.se?x=1',
    'https://skolan.se#top',
    'https://user:pass@skolan.se',
    'https://*.skolan.se',
    'https://skolan', // no dot: no public site
    'ftp://skolan.se',
    'https://skolan.se https://andra.se',
    'https://skolan.se:0', // a port no browser's origin carries
    'https://skolan.se:65536',
    'https://skolan.se:99999',
  ])('leaves %j as typed for validation to refuse', (typed) => {
    const normalized = normalizeEmbedOrigin(typed);
    expect(EMBED_ORIGIN_PATTERN.test(normalized)).toBe(false);
  });

  it('drops blanks and repeats, keeps the order, and leaves what is no list of strings to the validator', () => {
    expect(normalizeEmbedOrigins(['b.se', '', 'https://a.se', 'B.se/', ' '])).toEqual(['https://b.se', 'https://a.se']);
    expect(normalizeEmbedOrigins('https://a.se')).toBe('https://a.se');
    expect(normalizeEmbedOrigins([1])).toEqual([1]);
  });
});

describe('embedsKind (app.public_timetable_embed, said in TypeScript)', () => {
  const on = {
    publicViewerEnabled: true,
    publicGroups: true,
    publicTeachers: true,
    publicRooms: true,
    publicTeacherDisplay: 'SIGNATURE' as const,
    publicEmbedGroups: true,
    publicEmbedTeachers: true,
    publicEmbedRooms: true,
    publicEmbedOrigins: ['https://skolan.se'],
  };

  it('frames a link while the viewer, its scope, the scope\'s embedding and a website are all there', () => {
    expect(['GROUP', 'TEACHER', 'ROOM'].map((kind) => embedsKind(on, kind as 'GROUP'))).toEqual([true, true, true]);
  });

  it.each<[string, Parameters<typeof embedsKind>[0], Parameters<typeof embedsKind>[1]]>([
    ['no settings row', null, 'GROUP'],
    ['the viewer off', { ...on, publicViewerEnabled: false }, 'GROUP'],
    ['no website', { ...on, publicEmbedOrigins: [] }, 'ROOM'],
    ['the classes off', { ...on, publicGroups: false }, 'GROUP'],
    ['the classes\' embedding off', { ...on, publicEmbedGroups: false }, 'GROUP'],
    ['the rooms\' embedding off', { ...on, publicEmbedRooms: false }, 'ROOM'],
    ['the teachers\' embedding off', { ...on, publicEmbedTeachers: false }, 'TEACHER'],
    ['teachers named by nothing', { ...on, publicTeacherDisplay: 'NONE' }, 'TEACHER'],
  ])('frames nothing with %s', (_why, settings, kind) => {
    expect(embedsKind(settings, kind)).toBe(false);
  });
});

describe('defaultTeacherDisplay', () => {
  it('follows the school\'s Schemavisaren choice, so a class\'s or a room\'s set names no more than its public pages', () => {
    for (const kind of ['GROUP', 'ROOM', 'TEACHER'] as const) {
      expect(defaultTeacherDisplay('NAME', kind)).toBe('NAME');
      expect(defaultTeacherDisplay('SIGNATURE', kind)).toBe('SIGNATURE');
    }
    expect(defaultTeacherDisplay('NONE', 'GROUP')).toBe('NONE');
    expect(defaultTeacherDisplay('NONE', 'ROOM')).toBe('NONE');
  });

  it('signs a teachers\' set when the school names nobody: each sheet is titled by its teacher', () => {
    expect(defaultTeacherDisplay('NONE', 'TEACHER')).toBe('SIGNATURE');
  });
});
