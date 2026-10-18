/**
 * Every screen at a phone's window and at a tablet's, in both appearances.
 *
 * A tablet shows what the phone layout never had to answer: rows a metre
 * wide, a button across the whole screen, a label far from its switch. This
 * runner renders no layout (react-test-renderer computes no positions), so
 * what is pinned is what each screen asks for at each width, on the element
 * that asks for it: the list's own gutter (its header has the same one, so a
 * search of the whole screen would find the header's), the cap on a column,
 * the two halves of a form beside its list, the week grid's day columns, the
 * register's 44 pt targets. Each screen is drawn in light and in dark, which
 * runs every style factory of the theme, and every colour it draws has to
 * come from that appearance's palette. The data the screens are given holds
 * the states that draw differently (a cancelled lesson, a required notice
 * type), so those are drawn too, and what a screen reader is told about
 * them is pinned with them.
 */
import React from 'react';
import { Dimensions, Platform, StyleSheet, Switch } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FORM_MAX, READABLE_MAX, REGISTER_MAX, TWO_COLUMN_MAX, columnLayout, sideBySide } from '../layout/responsive';
import { DISABLED_OPACITY, PALETTES, type SchemeName } from '../theme/tokens';
import { over } from '../theme/contrast';
import { translatorFor } from '../i18n';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

let mockRole = 'TEACHER';
jest.mock('../context/LocaleContext', () => {
  // One object per locale, built in the factory: a new t per render would
  // reload every screen whose load depends on it, without end.
  const value = { t: require('../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../context/AuthContext', () => {
  const states: Record<string, unknown> = {};
  const value = (role: string) =>
    (states[role] ??= {
      authState: { isAuthenticated: true, teacherId: 'u1', role },
      isLoading: false,
      error: null,
      login: jest.fn(),
      loginWithSchoolAccount: jest.fn(),
      logout: jest.fn(),
    });
  return { useAuth: () => value(mockRole) };
});
jest.mock('../context/NetworkContext', () => {
  const value = { networkState: { isConnected: true, isInternetReachable: true } };
  return { useNetwork: () => value };
});
jest.mock('../context/SyncContext', () => {
  const lesson = {
    id: 'l1',
    startTime: '2026-10-19T08:10:00Z',
    endTime: '2026-10-19T09:00:00Z',
    subjectName: 'Matematik',
    roomName: 'B204',
    studentIds: ['s1', 's2'],
  };
  const value = {
    syncState: { status: 'connected', lastSyncedAt: null, pendingCount: 0, problem: null },
    activeLesson: lesson,
    activeLessonFromCache: false,
    setActiveLesson: jest.fn(),
    triggerManualSync: jest.fn(),
    refusedLessons: jest.fn(async () => []),
    discardRefused: jest.fn(),
  };
  return { useSync: () => value };
});
jest.mock('../hooks/useBiometrics', () => ({ useBiometrics: () => ({ authenticate: jest.fn(), isAuthenticating: false }) }));
jest.mock('../hooks/useOfflineAttendance', () => ({ useOfflineAttendance: () => ({ enqueue: jest.fn(), isSubmitting: false }) }));
jest.mock('../services/database/localDatabase', () => ({
  getStudentsByIds: jest.fn(async () => [
    { id: 's1', displayName: 'Ada Andersson', photoUri: null },
    { id: 's2', displayName: 'Bo Berg', photoUri: null },
  ]),
}));
jest.mock('../services/notifications', () => ({
  ...jest.requireActual('../services/notifications'),
  fetchNotifications: jest.fn(async () => [
    { id: 'n1', type: 'LESSON_CANCELLED', meta: {}, readAt: null, createdAt: '2026-10-17T08:00:00Z' },
  ]),
  markAllRead: jest.fn(),
}));
jest.mock('../services/schedule', () => ({
  ...jest.requireActual('../services/schedule'),
  fetchSchedule: jest.fn(async () => [
    {
      kind: 'LESSON',
      id: 'a',
      date: '2026-10-19',
      startsAt: '2026-10-19T08:10:00Z',
      endsAt: '2026-10-19T09:00:00Z',
      status: 'SCHEDULED',
      subject: { name: 'Svenska' },
      room: { name: 'A1' },
    },
    {
      kind: 'LESSON',
      id: 'b',
      date: '2026-10-19',
      startsAt: '2026-10-19T09:20:00Z',
      endsAt: '2026-10-19T10:00:00Z',
      status: 'CANCELLED',
      subject: { name: 'Engelska' },
      room: { name: 'A2' },
    },
  ]),
}));
// The teacher's schedule reads its lessons from the database itself: one to
// open, and one the school has cancelled, which is drawn differently.
jest.mock('../services/supabase', () => {
  const lesson = (id: string, start: string, end: string, status: string, subject: string) => ({
    lesson: {
      id, date: '2026-10-19', startsAt: `2026-10-19T${start}:00Z`, endsAt: `2026-10-19T${end}:00Z`, status,
      subject: { name: subject }, room: { name: 'B204' },
    },
  });
  const answer = {
    data: [lesson('a', '08:10', '09:00', 'SCHEDULED', 'Svenska'), lesson('b', '09:20', '10:00', 'CANCELLED', 'Samhällskunskap')],
    error: null,
  };
  const query: Record<string, unknown> = { then: (resolve: (value: typeof answer) => unknown) => resolve(answer) };
  for (const step of ['select', 'eq', 'gte', 'lte']) query[step] = () => query;
  return { ...jest.requireActual('../services/supabase'), getSupabase: () => ({ from: () => query }) };
});
jest.mock('../services/children', () => ({
  ...jest.requireActual('../services/children'),
  fetchChildren: jest.fn(async () => [
    { linkId: 'k1', id: 'c1', firstName: 'Ella', lastName: 'Svensson', isActive: true },
    { linkId: 'k2', id: 'c2', firstName: 'Liam', lastName: 'Svensson', isActive: true },
  ]),
}));
jest.mock('../services/absenceReports', () => ({
  fetchAbsenceReports: jest.fn(async () => []),
  reportAbsence: jest.fn(),
  removeAbsenceReport: jest.fn(),
}));
jest.mock('../services/leaveRequests', () => ({
  ...jest.requireActual('../services/leaveRequests'),
  fetchLeaveRequests: jest.fn(async () => []),
  requestLeave: jest.fn(),
}));
/** A subject's own colour, from the school's data: the one colour a screen draws that the palette does not hold. */
const mockSubjectColour = '#0e7490';
jest.mock('../services/familySchedule', () => {
  const lesson = (id: string, date: string, start: string, end: string, subject: string, rest: object = {}) => ({
    id, date, start, end, subject, subjectColor: null, room: 'A1', teachers: ['Karin Lund'], status: 'SCHEDULED', substitute: false,
    ...rest,
  });
  // Something on every school day, so the week view has a grid, and today
  // (Monday) one card of each kind, so the today view draws them all.
  return {
    ...jest.requireActual('../services/familySchedule'),
    fetchFamilySchedule: jest.fn(async (id: string) => ({
      student: { id, firstName: 'Ella' },
      week: { from: '2026-10-19', to: '2026-10-25', isoWeek: '2026-W43' },
      today: '2026-10-19',
      bounds: { earliest: '2026-08-17', latest: null },
      timezone: 'Europe/Stockholm',
      lessons: [
        lesson('m1', '2026-10-19', '08:10', '08:50', 'Matematik', { subjectColor: mockSubjectColour }),
        lesson('m2', '2026-10-19', '09:20', '10:00', 'Svenska som andraspråk', { status: 'CANCELLED', teachers: [] }),
        lesson('m3', '2026-10-19', '10:10', '10:50', 'Engelska', { substitute: true, teachers: [] }),
        lesson('t1', '2026-10-20', '08:10', '08:50', 'Bild'),
        lesson('w1', '2026-10-21', '08:10', '08:50', 'Musik'),
        lesson('h1', '2026-10-22', '08:10', '08:50', 'Slöjd'),
        lesson('f1', '2026-10-23', '08:10', '08:50', 'Idrott och hälsa'),
      ],
      lunches: [{ id: 'lu1', date: '2026-10-19', start: '11:30', end: '12:00' }],
      rasts: [{ id: 'r1', date: '2026-10-19', start: '09:00', end: '09:20', name: 'Förmiddagsrast' }],
    })),
  };
});
jest.mock('../services/notificationPreferences', () => ({
  ...jest.requireActual('../services/notificationPreferences'),
  // One the reader may turn off, and one the school requires: shown on and locked.
  fetchPreferences: jest.fn(async () => [
    { type: 'LESSON_CANCELLED', enabled: true, required: false },
    { type: 'ABSENCE_UNREPORTED', enabled: true, required: true },
  ]),
  savePreferences: jest.fn(),
}));
jest.mock('../services/pushRegistration', () => ({
  serverPushEnabled: jest.fn(async () => true),
  isPushEnabledFor: jest.fn(async () => false),
  enablePush: jest.fn(),
  disablePush: jest.fn(),
  refreshRegistration: jest.fn(),
  ensureAndroidChannel: jest.fn(async () => undefined),
}));

import { AppThemeProvider, useAppTheme, type AppTheme } from '../theme/ThemeContext';
import { fetchFamilySchedule } from '../services/familySchedule';
import { TabGlyph } from './TabGlyph';
import { AttendanceScreen } from './attendance/AttendanceScreen';
import { ScheduleScreen } from './schedule/ScheduleScreen';
import { NotificationsScreen } from './notifications/NotificationsScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { StudentScheduleScreen } from './student/StudentScheduleScreen';
import { GuardianHomeScreen } from './guardian/GuardianHomeScreen';
import { ChildScheduleScreen } from './guardian/ChildScheduleScreen';
import { LeaveRequestsScreen } from './guardian/LeaveRequestsScreen';
// A route file outside jest's roots; importing it from here is fine.
import LoginScreen from '../../app/(auth)/login';

type Style = Record<string, unknown>;
type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');
const PHONE: [number, number] = [390, 844];
const SIZES: ReadonlyArray<[number, number]> = [PHONE, [820, 1180], [1180, 820], [1366, 1024]];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(width: number, height: number, Screen: React.ComponentType): Promise<Tree> {
  const d = { width, height, scale: 2, fontScale: 1 };
  act(() => Dimensions.set({ window: d, screen: d }));
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(
      <AppThemeProvider>
        <Screen />
      </AppThemeProvider>,
    );
  });
  // Let each screen's load settle.
  await settle();
  return tree;
}

const isHost = (node: Instance): boolean => typeof node.type === 'string';
/** A host view of one kind ('Text', 'View'); the renderer types a node's type as any element type. */
const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const flat = (node: Instance): Style => (StyleSheet.flatten(node.props.style) as Style | undefined) ?? {};

function ancestors(node: Instance): Instance[] {
  const found: Instance[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) found.push(parent);
  return found;
}

/** A view's host children, through the components between them. */
function hostChildren(node: Instance): Instance[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [] : isHost(child) ? [child] : hostChildren(child)));
}

/** The cap of the column a node is drawn in: the nearest maxWidth at or above it. */
function capAbove(node: Instance): unknown {
  const column = [node, ...ancestors(node)].find((n) => isHost(n) && typeof flat(n).maxWidth === 'number');
  return column ? flat(column).maxWidth : undefined;
}

/** The one host Text that reads `text`. */
const textNode = (tree: Tree, text: string): Instance =>
  tree.root.find((n) => isHostOf(n, 'Text') && [n.props.children].flat().join('') === text);

/** Taps what holds the text `label`, as a finger would, and lets what it starts settle. */
async function press(tree: Tree, label: string): Promise<void> {
  const node = textNode(tree, label);
  const target = [node, ...ancestors(node)].find((n) => typeof n.props.onPress === 'function');
  if (!target) throw new Error(`nothing to press holds "${label}"`);
  await act(async () => {
    target.props.onPress();
  });
  await settle();
}

/** Every style a host view carries, flattened, plus every list's contentContainerStyle. */
function stylesOf(tree: Tree): Style[] {
  const hosts = tree.root.findAll(isHost).map((n) => StyleSheet.flatten(n.props.style) as Style | undefined);
  const lists = tree.root
    .findAll((n) => n.props.contentContainerStyle !== undefined)
    .map((n) => StyleSheet.flatten(n.props.contentContainerStyle) as Style | undefined);
  return [...hosts, ...lists].filter((s): s is Style => Boolean(s));
}

const capsOf = (styles: Style[]): number[] => styles.map((s) => s.maxWidth).filter((m): m is number => typeof m === 'number');

const rendersItems = (node: Instance): boolean =>
  typeof node.props.renderItem === 'function' && (node.props.data !== undefined || node.props.sections !== undefined);

/** The screen's list itself: the outermost node that renders items, not the views it hands them on to. */
function listOf(tree: Tree): Instance {
  const lists = tree.root.findAll(rendersItems).filter((n) => !ancestors(n).some(rendersItems));
  expect(lists).toHaveLength(1);
  return lists[0]!;
}

const listGutter = (tree: Tree): unknown =>
  (StyleSheet.flatten(listOf(tree).props.contentContainerStyle) as Style | undefined)?.paddingHorizontal;

/** What an appearance may paint: its palette, the tone tints in it, nothing at all, and a subject's own colour. */
function allowedColours(scheme: SchemeName): Set<unknown> {
  const palette = PALETTES[scheme];
  return new Set([...Object.values(palette), ...Object.values(palette.toneTint), 'transparent', mockSubjectColour]);
}

/** Every colour a host view is given, in its style or as a prop (a placeholder, a switch's track), as `View.color: #fff`. */
function coloursOutside(tree: Tree, allowed: Set<unknown>): string[] {
  return tree.root.findAll(isHost).flatMap((node) =>
    [...Object.entries(flat(node)), ...Object.entries(node.props)]
      .filter(([key, value]) => /color$/i.test(key) && value !== undefined && !allowed.has(value))
      .map(([key, value]) => `${String(node.type)}.${key}: ${String(value)}`),
  );
}

const SCREENS: ReadonlyArray<[string, React.ComponentType, string, 'list' | 'column' | 'split' | 'form']> = [
  ['login', LoginScreen, 'TEACHER', 'form'],
  ['schedule', ScheduleScreen, 'TEACHER', 'list'],
  ['attendance', AttendanceScreen, 'TEACHER', 'list'],
  ['notifications', NotificationsScreen, 'TEACHER', 'list'],
  ['settings', SettingsScreen, 'TEACHER', 'column'],
  ['student schedule', StudentScheduleScreen, 'STUDENT', 'list'],
  ['guardian home', GuardianHomeScreen, 'GUARDIAN', 'split'],
  ['child schedule', ChildScheduleScreen, 'GUARDIAN', 'column'],
  ['leave requests', LeaveRequestsScreen, 'GUARDIAN', 'split'],
];

describe.each(['light', 'dark'] as const)('in %s', (scheme) => {
  beforeEach(() => {
    mockScheme = scheme;
  });

  describe.each(SCREENS)('%s', (_name, Screen, role, kind) => {
    it.each(SIZES)('keeps its content to a readable column at %ix%i', async (width, height) => {
      mockRole = role;
      const tree = await renderAt(width, height, Screen);
      const styles = stylesOf(tree);
      // Nothing is wider than the window it is drawn in.
      for (const s of styles) {
        if (typeof s.width === 'number') expect(s.width).toBeLessThanOrEqual(width);
      }
      if (kind === 'list') {
        // The list keeps the window as its scroll area and centres its rows.
        const expected = columnLayout(width, Screen === AttendanceScreen ? REGISTER_MAX : READABLE_MAX).gutter;
        expect(listGutter(tree)).toBe(expected);
        if (width > PHONE[0]) expect(expected).toBeGreaterThan(16);
      } else {
        // A column or a form, capped and centred: never as wide as a tablet.
        // A form and its list side by side share a wider cap, about half each.
        const cap = kind === 'form' ? FORM_MAX : kind === 'split' && sideBySide(width) ? TWO_COLUMN_MAX : READABLE_MAX;
        const caps = capsOf(styles);
        expect(caps.length).toBeGreaterThan(0);
        expect(Math.min(...caps)).toBeLessThanOrEqual(cap);
      }
      await act(async () => tree.unmount());
    });

    it(`paints its page and every colour from the ${scheme} palette`, async () => {
      mockRole = role;
      const tree = await renderAt(1366, 1024, Screen);
      // The screen's outermost view is the page itself.
      expect(flat(tree.root.findAll(isHost)[0]!).backgroundColor).toBe(PALETTES[scheme].background);
      expect(coloursOutside(tree, allowedColours(scheme))).toEqual([]);
      await act(async () => tree.unmount());
    });
  });
});

describe('two columns only where they help', () => {
  const splitRows = (tree: Tree) =>
    tree.root.findAll((n) => isHost(n) && flat(n).flexDirection === 'row' && flat(n).alignItems === 'flex-start');

  it.each([
    ['guardian home', GuardianHomeScreen],
    ['leave requests', LeaveRequestsScreen],
  ] as const)('puts the %s form beside its list when the window is expanded, above it below that', async (_name, Screen) => {
    mockRole = 'GUARDIAN';
    const narrow = await renderAt(820, 1180, Screen);
    expect(splitRows(narrow)).toHaveLength(0);
    await act(async () => narrow.unmount());
    const wide = await renderAt(1366, 1024, Screen);
    const rows = splitRows(wide);
    expect(rows).toHaveLength(1);
    // Two halves that share the row equally, whatever each of them holds.
    expect(hostChildren(rows[0]!).map((half) => [flat(half).flexGrow, flat(half).flexBasis])).toEqual([
      [1, 0],
      [1, 0],
    ]);
    await act(async () => wide.unmount());
  });

  it('keeps the register one column on every window: a register is read down, not across', async () => {
    mockRole = 'TEACHER';
    for (const [width, height] of SIZES) {
      const tree = await renderAt(width, height, AttendanceScreen);
      expect(listOf(tree).props.numColumns ?? 1).toBe(1);
      await act(async () => tree.unmount());
    }
  });

  it('lays a screen out again when the window turns', async () => {
    mockRole = 'TEACHER';
    const tree = await renderAt(820, 1180, NotificationsScreen);
    expect(listGutter(tree)).toBe(columnLayout(820).gutter);
    const turned = { width: 1180, height: 820, scale: 2, fontScale: 1 };
    await act(async () => {
      Dimensions.set({ window: turned, screen: turned });
    });
    expect(listGutter(tree)).toBe(columnLayout(1180).gutter);
    await act(async () => tree.unmount());
  });
});

describe('the register', () => {
  const STATUSES = ['present', 'absent', 'late', 'excused'] as const;
  const LABELS = new Set(
    ['Ada Andersson', 'Bo Berg'].flatMap((name) =>
      STATUSES.map((status) => t('attendance.markA11y', { name, status: t(`attendance.statusName.${status}`) })),
    ),
  );

  it.each([
    [390, 38],
    [599, 38],
    [600, 44],
    [820, 44],
    [1366, 44],
  ])('at %i pt wide has %i pt status buttons, and a submit button no wider than a form', async (width, size) => {
    mockRole = 'TEACHER';
    const tree = await renderAt(width, 1024, AttendanceScreen);
    const buttons = tree.root.findAll((n) => isHost(n) && LABELS.has(n.props.accessibilityLabel));
    expect(buttons).toHaveLength(LABELS.size);
    for (const button of buttons) expect([flat(button).width, flat(button).height]).toEqual([size, size]);
    const submit = tree.root.find((n) => isHost(n) && n.props.accessibilityLabel === t('attendance.submitA11y'));
    expect(capAbove(submit)).toBe(FORM_MAX);
    await act(async () => tree.unmount());
  });
});

describe("a child's week on a tablet", () => {
  beforeEach(() => {
    mockScheme = 'light';
    mockRole = 'GUARDIAN';
  });

  /** Each day's share of the week grid's row; none when the week is one column. */
  const dayShares = (tree: Tree): unknown[] =>
    tree.root.findAll((n) => isHost(n) && typeof flat(n).width === 'string' && flat(n).width !== '100%').map((n) => flat(n).width);
  /** The screen's column caps, top to bottom: the controls', then the body's. */
  const columnCaps = (tree: Tree): unknown[] =>
    tree.root.findAll((n) => isHost(n) && typeof flat(n).maxWidth === 'number').map((n) => flat(n).maxWidth);

  it.each([
    [1366, 1024, '20%'],
    [1032, 1376, '50%'],
  ])('at %ix%i lays the week out in day columns, %s of the row each', async (width, height, share) => {
    const tree = await renderAt(width, height, ChildScheduleScreen);
    expect(dayShares(tree)).toEqual([]);
    await press(tree, t('childSchedule.week'));
    // Monday to Friday.
    expect(dayShares(tree)).toEqual(Array(5).fill(share));
    await act(async () => tree.unmount());
  });

  it('keeps the week one column below the expanded class, as on a phone', async () => {
    const tree = await renderAt(820, 1180, ChildScheduleScreen);
    await press(tree, t('childSchedule.week'));
    expect(textNode(tree, t('childSchedule.weekLabel', { week: 43 }))).toBeTruthy();
    expect(dayShares(tree)).toEqual([]);
    await act(async () => tree.unmount());
  });

  it.each([
    [1366, 1024],
    [1032, 1376],
  ])('at %ix%i keeps the controls where they were in the today view, the week view and while a week loads', async (width, height) => {
    const tree = await renderAt(width, height, ChildScheduleScreen);
    const controls = (): unknown => capAbove(textNode(tree, t('childSchedule.title', { name: 'Ella' })));
    expect(controls()).toBe(READABLE_MAX);
    expect(columnCaps(tree)).toEqual([READABLE_MAX, READABLE_MAX]);

    await press(tree, t('childSchedule.week'));
    expect(controls()).toBe(READABLE_MAX);
    const week = columnCaps(tree);
    // Only the body widens, and it takes the whole window for the grid.
    expect(week[0]).toBe(READABLE_MAX);
    expect(week[1]).toBeGreaterThanOrEqual(width);

    // The next week has not answered yet: nothing narrows while it loads.
    jest.mocked(fetchFamilySchedule).mockImplementationOnce(() => new Promise<never>(() => undefined));
    await press(tree, '›');
    expect(dayShares(tree)).toEqual([]);
    expect(controls()).toBe(READABLE_MAX);
    expect(columnCaps(tree)).toEqual(week);
    await act(async () => tree.unmount());
  });

  it('at 1366x1024 keeps a week with nothing on it, and a week that failed, under the controls', async () => {
    const tree = await renderAt(1366, 1024, ChildScheduleScreen);
    await press(tree, t('childSchedule.week'));
    const answer = jest.mocked(fetchFamilySchedule).getMockImplementation()!;
    // Höstlov: the week answers, with nothing on any day of it.
    jest.mocked(fetchFamilySchedule).mockImplementationOnce(async (id, week) => ({
      ...(await answer(id, week)),
      week: { from: '2026-10-26', to: '2026-11-01', isoWeek: '2026-W44' },
      lessons: [],
      lunches: [],
      rasts: [],
    }));
    await press(tree, '›');
    expect(textNode(tree, t('childSchedule.weekLabel', { week: 44 }))).toBeTruthy();
    // The body keeps the grid's width, so nothing jumps when a week with
    // lessons answers; the sentence in it keeps the controls' column.
    expect(columnCaps(tree)[1]).toBeGreaterThanOrEqual(1366);
    expect(capAbove(textNode(tree, t('childSchedule.title', { name: 'Ella' })))).toBe(READABLE_MAX);
    expect(capAbove(textNode(tree, t('childSchedule.emptyWeek')))).toBe(READABLE_MAX);

    jest.mocked(fetchFamilySchedule).mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    await press(tree, '›');
    expect(columnCaps(tree)[1]).toBeGreaterThanOrEqual(1366);
    expect(capAbove(textNode(tree, t('childSchedule.loadError')))).toBe(READABLE_MAX);
    await act(async () => tree.unmount());
  });

  it("keeps a lesson's colour beside its subject in a day column, and gives the badge a line of its own", async () => {
    const tree = await renderAt(1180, 820, ChildScheduleScreen);
    await press(tree, t('childSchedule.week'));
    const title = textNode(tree, 'Svenska som andraspråk');
    const row = ancestors(title).find(isHost)!;
    // A long subject wraps beside the dot rather than dropping under it.
    expect(flat(row).flexDirection).toBe('row');
    expect(flat(row).flexWrap ?? 'nowrap').toBe('nowrap');
    expect(flat(title).flexShrink).toBe(1);
    expect(ancestors(textNode(tree, t('common.cancelled')))).not.toContain(row);
    expect(ancestors(textNode(tree, t('childSchedule.substitute')))).not.toContain(row);
    await act(async () => tree.unmount());
  });
});

describe('the theme around the screens', () => {
  it.each([
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const)('in %s, gives the status bar %s glyphs, against the page', async (scheme, glyphs) => {
    mockScheme = scheme;
    let theme: AppTheme | undefined;
    function Probe(): null {
      theme = useAppTheme();
      return null;
    }
    let tree!: Tree;
    await act(async () => {
      tree = TestRenderer.create(
        <AppThemeProvider>
          <Probe />
        </AppThemeProvider>,
      );
    });
    expect(theme?.statusBar).toBe(glyphs);
    expect(theme?.colors).toBe(PALETTES[scheme]);
    await act(async () => tree.unmount());
  });

  it('marks the open tab with a bar in its colour, and no other tab (colour alone would not say which, WCAG 1.4.1)', async () => {
    const barOf = async (color: string, focused: boolean): Promise<unknown> => {
      let tree!: Tree;
      await act(async () => {
        tree = TestRenderer.create(<TabGlyph glyph="◷" color={color} focused={focused} />);
      });
      // The bar is the view that holds no text.
      const bars = tree.root.findAll((n) => isHostOf(n, 'View') && n.findAll((m) => isHostOf(m, 'Text')).length === 0);
      expect(bars).toHaveLength(1);
      const colour = flat(bars[0]!).backgroundColor;
      await act(async () => tree.unmount());
      return colour;
    };
    for (const { primary, textMuted } of Object.values(PALETTES)) {
      expect(await barOf(primary, true)).toBe(primary);
      expect(await barOf(textMuted, false)).toBe('transparent');
    }
  });
});

describe('what a screen reader and a locked switch are told', () => {
  beforeEach(() => {
    mockScheme = 'light';
  });

  /** Whether a screen reader hears the button that holds `label` as the chosen one. */
  const selectedOf = (tree: Tree, label: string): unknown => {
    const node = textNode(tree, label);
    const button = [node, ...ancestors(node)].find((n) => isHost(n) && n.props.accessibilityRole === 'button');
    return button?.props.accessibilityState?.selected;
  };

  it.each([PHONE, [1366, 1024]] as const)(
    'at %ix%i strikes a cancelled lesson through, says so in a word of its own and is told as cancelled',
    async (width, height) => {
      mockRole = 'TEACHER';
      const tree = await renderAt(width, height, ScheduleScreen);
      const subject = textNode(tree, 'Samhällskunskap');
      expect(flat(subject)).toMatchObject({ textDecorationLine: 'line-through', color: PALETTES.light.textMuted });
      expect(subject.props.numberOfLines).toBe(1);
      // The word is not inside the subject's one line, so a long subject or a
      // large text size truncates the subject and never the word.
      expect(ancestors(textNode(tree, t('common.cancelled')))).not.toContain(subject);
      const card = (node: Instance) => [node, ...ancestors(node)].find((n) => isHost(n) && n.props.accessibilityLabel !== undefined)!;
      expect(card(subject).props.accessibilityLabel).toBe(`Samhällskunskap, ${t('common.cancelled')}`);
      expect(card(subject).props.accessibilityState?.disabled).toBe(true);
      // A lesson that goes ahead is offered to open, and not struck through.
      const open = textNode(tree, 'Svenska');
      expect(flat(open).textDecorationLine).toBeUndefined();
      expect(card(open).props.accessibilityLabel).toBe(t('schedule.openA11y', { subject: 'Svenska' }));
      await act(async () => tree.unmount());
    },
  );

  it.each([
    ['guardian home', GuardianHomeScreen, [['Ella Svensson', 'Liam Svensson'], [t('guardian.types.SICK'), t('guardian.types.APPOINTMENT'), t('guardian.types.OTHER')]]],
    ['leave requests', LeaveRequestsScreen, [['Ella Svensson', 'Liam Svensson']]],
    ['child schedule', ChildScheduleScreen, [['Ella', 'Liam'], [t('childSchedule.today'), t('childSchedule.week')]]],
  ] as const)('%s tells which chip of each row is chosen, and follows a tap', async (_name, Screen, rows) => {
    mockRole = 'GUARDIAN';
    const tree = await renderAt(...PHONE, Screen);
    for (const row of rows) {
      expect(row.map((label) => selectedOf(tree, label))).toEqual(row.map((_, i) => i === 0));
      await press(tree, row[row.length - 1]!);
      expect(row.map((label) => selectedOf(tree, label))).toEqual(row.map((_, i) => i === row.length - 1));
    }
    await act(async () => tree.unmount());
  });

  it.each([
    ['login', LoginScreen, 'TEACHER', [t('login.email'), t('login.password')]],
    ['guardian home', GuardianHomeScreen, 'GUARDIAN', [t('guardian.dateLabel')]],
    ['leave requests', LeaveRequestsScreen, 'GUARDIAN', [t('leave.from'), t('leave.to'), t('leave.reason')]],
  ] as const)('%s names every field it draws', async (_name, Screen, role, labels) => {
    mockRole = role;
    const tree = await renderAt(...PHONE, Screen);
    expect(tree.root.findAll((n) => isHostOf(n, 'TextInput')).map((n) => n.props.accessibilityLabel)).toEqual(labels);
    await act(async () => tree.unmount());
  });

  it("keeps a tab's glyph out of what a screen reader reads, and at one size at every text size", async () => {
    let tree!: Tree;
    await act(async () => {
      tree = TestRenderer.create(<TabGlyph glyph="◷" color={PALETTES.light.primary} focused />);
    });
    expect(tree.root.findAll(isHost)[0]!.props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(tree.root.find((n) => isHostOf(n, 'Text')).props.allowFontScaling).toBe(false);
    await act(async () => tree.unmount());
  });

  /** The settings switch named `label`. */
  const switchFor = (tree: Tree, label: string): Instance =>
    tree.root.find((n) => n.type === Switch && n.props.accessibilityLabel === label);
  const REQUIRED = t('settings.types.ABSENCE_UNREPORTED');
  const CHOSEN = t('settings.types.LESSON_CANCELLED');

  it.each(['light', 'dark'] as const)("in %s on iOS, locks a required type's switch in the palette's own colours", async (scheme) => {
    mockScheme = scheme;
    mockRole = 'TEACHER';
    const palette = PALETTES[scheme];
    const tree = await renderAt(1366, 1024, SettingsScreen);
    // UISwitch fades a disabled switch itself; faded here too, it would be faded twice.
    expect(switchFor(tree, REQUIRED).props).toMatchObject({
      disabled: true,
      value: true,
      trackColor: { false: palette.borderStrong, true: palette.primary },
      ios_backgroundColor: palette.borderStrong,
    });
    expect(switchFor(tree, CHOSEN).props.trackColor).toEqual({ false: palette.borderStrong, true: palette.primary });
    await act(async () => tree.unmount());
  });

  // Kept out of the palette test, which draws on iOS: this faded track is off
  // the palette on purpose.
  it.each(['light', 'dark'] as const)("in %s on Android, fades a locked switch's track as a disabled button fades, and no other", async (scheme) => {
    mockScheme = scheme;
    mockRole = 'TEACHER';
    const palette = PALETTES[scheme];
    const fade = (colour: string): string => over(colour, DISABLED_OPACITY, palette.surface);
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      const tree = await renderAt(1366, 1024, SettingsScreen);
      expect(switchFor(tree, REQUIRED).props).toMatchObject({
        disabled: true,
        trackColor: { false: fade(palette.borderStrong), true: fade(palette.primary) },
        thumbColor: palette.surface,
      });
      expect(switchFor(tree, CHOSEN).props).toMatchObject({
        disabled: false,
        trackColor: { false: palette.borderStrong, true: palette.primary },
        thumbColor: palette.surface,
      });
      await act(async () => tree.unmount());
    } finally {
      os.restore();
    }
  });
});
