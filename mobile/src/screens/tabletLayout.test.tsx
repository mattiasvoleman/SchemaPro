/**
 * Every screen at a phone's window and at a tablet's, in both appearances.
 *
 * A tablet shows what the phone layout never had to answer: rows a metre
 * wide, a button across the whole screen, a label far from its switch. This
 * runner renders no layout (react-test-renderer computes no positions), so
 * what is pinned is what each screen asks for at each width: the gutter that
 * centres a list, the cap on a column, the form beside its list. Rendering
 * all of them in light and dark also runs every style factory of the theme.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FORM_MAX, READABLE_MAX, REGISTER_MAX, TWO_COLUMN_MAX, columnLayout, sideBySide } from '../layout/responsive';

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
  ]),
}));
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
jest.mock('../services/familySchedule', () => ({
  ...jest.requireActual('../services/familySchedule'),
  fetchFamilySchedule: jest.fn(async (id: string) => ({
    student: { id, firstName: 'Ella' },
    week: { from: '2026-10-19', to: '2026-10-25', isoWeek: '2026-W43' },
    today: '2026-10-19',
    bounds: { earliest: '2026-08-17', latest: null },
    timezone: 'Europe/Stockholm',
    lessons: [],
    lunches: [],
    rasts: [],
  })),
}));
jest.mock('../services/notificationPreferences', () => ({
  ...jest.requireActual('../services/notificationPreferences'),
  fetchPreferences: jest.fn(async () => [{ type: 'LESSON_CANCELLED', enabled: true, required: false }]),
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

import { AppThemeProvider } from '../theme/ThemeContext';
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

const PHONE: [number, number] = [390, 844];
const SIZES: ReadonlyArray<[number, number]> = [PHONE, [820, 1180], [1180, 820], [1366, 1024]];

async function renderAt(width: number, height: number, Screen: React.ComponentType): Promise<TestRenderer.ReactTestRenderer> {
  const d = { width, height, scale: 2, fontScale: 1 };
  act(() => Dimensions.set({ window: d, screen: d }));
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <AppThemeProvider>
        <Screen />
      </AppThemeProvider>,
    );
  });
  // Let each screen's load settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return tree;
}

/** Every style a host view carries, flattened, plus every list's contentContainerStyle. */
function stylesOf(tree: TestRenderer.ReactTestRenderer): Style[] {
  const hosts = tree.root.findAll((n) => typeof n.type === 'string').map((n) => StyleSheet.flatten(n.props.style) as Style | undefined);
  const lists = tree.root
    .findAll((n) => n.props.contentContainerStyle !== undefined)
    .map((n) => StyleSheet.flatten(n.props.contentContainerStyle) as Style | undefined);
  return [...hosts, ...lists].filter((s): s is Style => Boolean(s));
}

const gutterOf = (styles: Style[]): number[] =>
  styles.map((s) => s.paddingHorizontal).filter((p): p is number => typeof p === 'number');
const capsOf = (styles: Style[]): number[] => styles.map((s) => s.maxWidth).filter((m): m is number => typeof m === 'number');

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
        expect(gutterOf(styles)).toContain(expected);
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
  });
});

describe('two columns only where they help', () => {
  const rows = (styles: Style[]) => styles.filter((s) => s.flexDirection === 'row' && s.alignItems === 'flex-start');

  it.each([
    ['guardian home', GuardianHomeScreen],
    ['leave requests', LeaveRequestsScreen],
  ] as const)('puts the %s form beside its list when the window is expanded, above it below that', async (_name, Screen) => {
    mockRole = 'GUARDIAN';
    const narrow = await renderAt(820, 1180, Screen);
    expect(rows(stylesOf(narrow))).toEqual([]);
    await act(async () => narrow.unmount());
    const wide = await renderAt(1366, 1024, Screen);
    expect(rows(stylesOf(wide)).length).toBeGreaterThan(0);
    await act(async () => wide.unmount());
  });

  it('keeps the register one column on every window: a register is read down, not across', async () => {
    mockRole = 'TEACHER';
    for (const [width, height] of SIZES) {
      const tree = await renderAt(width, height, AttendanceScreen);
      const lists = tree.root.findAll((n) => typeof n.props.renderItem === 'function');
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(list.props.numColumns ?? 1).toBe(1);
      await act(async () => tree.unmount());
    }
  });

  it('lays a screen out again when the window turns', async () => {
    mockRole = 'TEACHER';
    const tree = await renderAt(820, 1180, NotificationsScreen);
    expect(gutterOf(stylesOf(tree))).toContain(columnLayout(820).gutter);
    const turned = { width: 1180, height: 820, scale: 2, fontScale: 1 };
    await act(async () => {
      Dimensions.set({ window: turned, screen: turned });
    });
    expect(gutterOf(stylesOf(tree))).toContain(columnLayout(1180).gutter);
    await act(async () => tree.unmount());
  });
});
