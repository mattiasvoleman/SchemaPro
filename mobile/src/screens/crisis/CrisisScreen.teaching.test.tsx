/**
 * Larm for each person who can open it, rendered whole against a stubbed
 * gateway (the real screen, hooks, queue and services; what is pinned is what
 * the person sees and which routes the gateway is asked): a teacher, an
 * administrator, and an administrator marked as teaching (Users.teaches).
 *
 * The marked administrator counts her own groups FIRST, with the
 * administration's view one tap away, and back. Everyone else sees exactly
 * what they saw before: the teacher's roll call alone, the administrator's
 * view alone, and nothing for a pupil or a guardian. Every route the screen
 * asks the gateway for is one the gateway admits the person (the app's
 * contract test, services/auth/teachingAdmin.contract.test.ts, reads the
 * controllers for that): the roll call's three doors and the administration's
 * own routes, and never the cover requests, which stay a teacher's (SP409).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import { fake } from '../../services/__testing__/crisisDatabase';
import { alarm, at, gateway, mineOf, sevenA } from '../../services/__testing__/crisisGateway';
import { resetCrisisQueueForTests } from '../../services/crisisQueue';
import { resetAlarmHintForTests } from '../../services/crisisOffline';

let mockRole = 'TEACHER';
let mockTeaches = false;
let mockTeacher = 'u-1';
/** The focus effects of what is mounted now: the tab gaining focus runs each of them, as the navigator does. */
const mockFocusEffects = new Set<() => void | (() => void)>();

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  // As a focused tab: the effect runs on mount and is known while it is mounted, so the test can run it again.
  useFocusEffect: (effect: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(() => {
      mockFocusEffects.add(effect);
      const cleanup = effect();
      return () => {
        mockFocusEffects.delete(effect);
        if (typeof cleanup === 'function') cleanup();
      };
    }, [effect]);
  },
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: mockTeacher, role: mockRole, teaches: mockTeaches }, isLoading: false }),
}));
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload the screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../context/NetworkContext', () => ({ useNetwork: () => ({ networkState: { isConnected: true, isInternetReachable: true } }) }));
jest.mock('../../context/SyncContext', () => ({ useSync: () => ({ crisisUpdate: null }) }));
jest.mock('../../services/database/localDatabase', () => require('../../services/__testing__/crisisDatabase').api);
jest.mock('../../services/auth/secureTokenStore', () => ({
  SecureTokenStore: {
    getTeacherSession: jest.fn(async () => ({ teacherId: mockTeacher, role: mockRole, authId: null, teaches: mockTeaches })),
  },
}));
jest.mock('../../services/supabase', () => ({ getAccessToken: jest.fn(async () => 'token'), getSupabase: jest.fn() }));
jest.mock('../../services/network/deviceOffline', () => ({
  deviceOffline: jest.fn(async () => false),
  noNetwork: jest.fn(async () => false),
}));
jest.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: jest.fn(async () => []) }));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));

import { CrisisScreen } from './CrisisScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');
const NOW = new Date(at('09:20'));

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);
const hasText = (tree: Tree, text: string): boolean => texts(tree).includes(text);

/** The labelled thing a finger presses. */
function pressable(tree: Tree, label: string): Instance {
  const found = tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  if (found.length === 0) throw new Error(`nothing to press is labelled "${label}"`);
  return found[0]!;
}
const canPress = (tree: Tree, label: string): boolean => tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function').length > 0;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function press(node: Instance): Promise<void> {
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

/** The tab gaining focus again: the effect of everything mounted runs once more, and its cleanup at the end of the test. */
const blurs: Array<() => void> = [];
async function refocus(): Promise<void> {
  await act(async () => {
    for (const effect of [...mockFocusEffects]) {
      const cleanup = effect();
      if (typeof cleanup === 'function') blurs.push(cleanup);
    }
  });
  await settle();
}

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(<CrisisScreen />);
  });
  await settle();
  return tree;
}

/** Draws the screen again with the person as they are now (the auth context is read at every render). */
async function rerender(tree: Tree): Promise<void> {
  await act(async () => {
    tree.update(<CrisisScreen />);
  });
  await settle();
}

/** Who is signed in. */
function as(role: string, teaches: boolean): void {
  mockRole = role;
  mockTeaches = teaches;
}

const MINE = 'GET /api/v1/crisis/mine';
const ADMIN_LIST = 'GET /api/v1/crisis/alarms?limit=5';
const asked = (): string[] => [...new Set(gateway.calls.map((c) => `${c.method} ${c.path}`))];
const askedAbout = (prefix: string): string[] => asked().filter((route) => route.split(' ')[1]!.startsWith(prefix));

const SWITCH_TO_MANAGEMENT = t('crisis.switch.toManagement');
const SWITCH_TO_ROLL_CALL = t('crisis.switch.toRollCall');
/** A pupil the roll call lists, and a heading only the administration's view has. */
const ROLL_CALL_SIGN = 'Anna Andersson';
const MANAGEMENT_SIGN = t('crisis.admin.startTitle');
const rollCall = (tree: Tree): boolean => tree.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(`${ROLL_CALL_SIGN},`)).length > 0;
const management = (tree: Tree): boolean => hasText(tree, MANAGEMENT_SIGN);

let tree: Tree | null = null;

const REAL_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime'] as const;

// The first render of the screen loads React Native's list stack, which took
// seconds on a cold cache; a test that times out is not stopped and its body
// runs into the next. So it is done once, before the tests, with an allowance
// of its own (CrisisScreen.test does the same).
beforeAll(async () => {
  gateway.install();
  gateway.mine = () => ({ status: 200, body: mineOf([alarm('a1', [sevenA()])]) });
  as('TEACHER', false);
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  // Only Date is faked: the renderer and settle() need the real timers.
  jest.useFakeTimers({ now: NOW, doNotFake: [...REAL_TIMERS] });
  gateway.install();
  fake.reset();
  resetCrisisQueueForTests();
  resetAlarmHintForTests();
  mockUuid = 0;
  mockTeacher = 'u-1';
  mockFocusEffects.clear();
  as('TEACHER', false);
  gateway.mine = () => ({ status: 200, body: mineOf([alarm('a1', [sevenA()])]) });
});

afterEach(async () => {
  for (const blur of blurs.splice(0)) blur();
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

describe('Larm for each person (Users.teaches)', () => {
  it('shows a teacher the roll call alone, and asks the gateway for the teacher’s list and nothing else', async () => {
    as('TEACHER', false);
    tree = await render();
    expect(rollCall(tree)).toBe(true);
    expect(management(tree)).toBe(false);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
    expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(false);
    expect(asked()).toEqual([MINE]);
  });

  it('shows an administrator who does not teach the administration’s view alone, with no way to a roll call she has no groups for', async () => {
    as('SCHOOL_ADMIN', false);
    tree = await render();
    expect(management(tree)).toBe(true);
    expect(rollCall(tree)).toBe(false);
    expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(false);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
    // The gateway refuses her the teacher's list (a 403 she would draw as an error), so it is never asked.
    expect(askedAbout('/api/v1/crisis/mine')).toEqual([]);
    expect(asked()).toEqual([ADMIN_LIST]);
  });

  it('shows an administrator who teaches her own roll call first, with the way to the administration’s view', async () => {
    as('SCHOOL_ADMIN', true);
    tree = await render();
    expect(rollCall(tree)).toBe(true);
    expect(management(tree)).toBe(false);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(true);
    // She is not looking at the other view: its routes are not asked for.
    expect(asked()).toEqual([MINE]);
    expect(texts(tree)).toContain(`${SWITCH_TO_MANAGEMENT} ›`);
  });

  it('takes her to the administration’s view and back, and the way back is in its header', async () => {
    as('SCHOOL_ADMIN', true);
    tree = await render();
    await press(pressable(tree, SWITCH_TO_MANAGEMENT));
    expect(management(tree)).toBe(true);
    expect(rollCall(tree)).toBe(false);
    expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(true);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
    expect(asked()).toEqual([MINE, ADMIN_LIST]);

    await press(pressable(tree, SWITCH_TO_ROLL_CALL));
    expect(rollCall(tree)).toBe(true);
    expect(management(tree)).toBe(false);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(true);
  });

  it('opens on her roll call every time the tab is shown, also after she moved to the administration’s view', async () => {
    as('SCHOOL_ADMIN', true);
    tree = await render();
    await press(pressable(tree, SWITCH_TO_MANAGEMENT));
    expect(management(tree)).toBe(true);
    // She leaves for another tab and comes back, in the next alarm: her own groups are what she is wanted for.
    await refocus();
    expect(rollCall(tree)).toBe(true);
    expect(management(tree)).toBe(false);
  });

  it('keeps the way to the administration’s view when no alarm is going and she has no groups: starting one is there', async () => {
    as('SCHOOL_ADMIN', true);
    gateway.mine = () => ({ status: 200, body: mineOf([]) });
    tree = await render();
    expect(rollCall(tree)).toBe(false);
    expect(hasText(tree, t('crisis.emptyTitle'))).toBe(true);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(true);
    await press(pressable(tree, SWITCH_TO_MANAGEMENT));
    expect(management(tree)).toBe(true);
  });

  it('counts a pupil found for her own group through the roll call’s own door', async () => {
    as('SCHOOL_ADMIN', true);
    tree = await render();
    await press(pressable(tree, t('crisis.markFoundA11y', { name: ROLL_CALL_SIGN })));
    const marks = gateway.to('POST', '/api/v1/crisis/mine/marks');
    expect(marks.length).toBeGreaterThan(0);
    expect((marks[0]!.body as { marks: Array<{ studentId: string; state: string }> }).marks).toMatchObject([{ studentId: 's1', state: 'FOUND' }]);
    // Nothing the roll call asks is a route of the cover requests or the administration's alarms.
    expect(asked().every((route) => route.split(' ')[1]!.startsWith('/api/v1/crisis/mine'))).toBe(true);
  });

  it('follows the mark being given or taken away under the screen, with nothing carried over', async () => {
    as('SCHOOL_ADMIN', false);
    tree = await render();
    expect(management(tree)).toBe(true);
    expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(false);

    // Marked (a profile read at the next recheck): her roll call is first, as it is for any marked administrator.
    as('SCHOOL_ADMIN', true);
    await rerender(tree);
    expect(rollCall(tree)).toBe(true);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(true);

    // She moves to the administration's view, and the head teacher takes the mark away: the view stays, the switch goes.
    await press(pressable(tree, SWITCH_TO_MANAGEMENT));
    as('SCHOOL_ADMIN', false);
    await rerender(tree);
    expect(management(tree)).toBe(true);
    expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(false);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
  });

  it.each([['STUDENT'], ['GUARDIAN']])('shows %s nothing of an alarm, marked or not, and asks the gateway nothing', async (role) => {
    for (const teaches of [false, true]) {
      as(role, teaches);
      tree = await render();
      expect(hasText(tree, t('crisis.unavailable'))).toBe(true);
      expect(rollCall(tree)).toBe(false);
      expect(management(tree)).toBe(false);
      expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
      expect(canPress(tree, SWITCH_TO_ROLL_CALL)).toBe(false);
      await act(async () => tree?.unmount());
      tree = null;
    }
    expect(gateway.calls).toEqual([]);
  });

  it('gives the mark on a teacher no second view: a teacher is a teacher', async () => {
    as('TEACHER', true);
    tree = await render();
    expect(rollCall(tree)).toBe(true);
    expect(canPress(tree, SWITCH_TO_MANAGEMENT)).toBe(false);
    expect(asked()).toEqual([MINE]);
  });

  it('asks the gateway for nothing under the cover requests, whichever view she is in', async () => {
    as('SCHOOL_ADMIN', true);
    tree = await render();
    await press(pressable(tree, SWITCH_TO_MANAGEMENT));
    await press(pressable(tree, SWITCH_TO_ROLL_CALL));
    expect(asked().filter((route) => route.includes('/cover-requests'))).toEqual([]);
  });
});
