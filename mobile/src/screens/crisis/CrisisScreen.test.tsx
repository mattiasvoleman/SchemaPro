/**
 * The teacher's roll call, rendered whole against a stubbed gateway and an
 * in-memory database: the real hook, queue and services run, so what is
 * pinned is what a teacher sees and what the gateway receives. The cases are
 * the ones a schoolyard produces: the list and the taps with a network, the
 * same list and the same taps without one (a clock on the pupil until the
 * gateway has the tap, and the tap sent when the network is back), an alarm
 * that is a drill, one that has ended, a list the phone built itself and the
 * gateway's replacing it, a tap the gateway will never take, and what a screen
 * reader is told. Under TZ=UTC and a pinned clock, so the instants read as
 * written.
 */
import React from 'react';
import { AppState, RefreshControl, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import { fake } from '../../services/__testing__/crisisDatabase';
import { alarm, at, call, gateway, mineOf, pupil, sevenA } from '../../services/__testing__/crisisGateway';
import { flushCrisisQueue, resetCrisisQueueForTests } from '../../services/crisisQueue';
import { enqueueCrisisMarks } from '../../services/database/localDatabase';
import { resetAlarmHintForTests } from '../../services/crisisOffline';
import { withSentMarks, type MyCrisisResponse } from '../../services/crisis';
import type { PendingCrisisMark } from '../../types';

let mockRole = 'TEACHER';
let mockTeacher = 't-1';
let mockFocusEffect: (() => void | (() => void)) | null = null;
let mockNetwork = { isConnected: true, isInternetReachable: true };
let mockCrisisUpdate: { alarmId: string; changedAt: string } | null = null;

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  // As a focused tab: the effect runs on mount; the test can run it again, as the tab gaining focus does.
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockFocusEffect = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: mockTeacher, role: mockRole }, isLoading: false }),
}));
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload the screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../context/NetworkContext', () => ({ useNetwork: () => ({ networkState: mockNetwork }) }));
jest.mock('../../context/SyncContext', () => ({ useSync: () => ({ crisisUpdate: mockCrisisUpdate }) }));
jest.mock('../../services/database/localDatabase', () => require('../../services/__testing__/crisisDatabase').api);
jest.mock('../../services/auth/secureTokenStore', () => ({
  SecureTokenStore: { getTeacherSession: jest.fn(async () => ({ teacherId: mockTeacher, role: 'TEACHER', authId: null })) },
}));
jest.mock('../../services/supabase', () => ({ getAccessToken: jest.fn(async () => 'token'), getSupabase: jest.fn() }));
jest.mock('../../services/network/deviceOffline', () => ({
  deviceOffline: jest.fn(async () => false),
  noNetwork: jest.fn(async () => false),
}));
jest.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: jest.fn(async () => []) }));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));

import { getPresentedNotificationsAsync } from 'expo-notifications';
import { RETRY_MS } from '../../hooks/useCrisis';
import { CrisisScreen } from './CrisisScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');
const NOW = new Date(at('09:20'));
const MARKS = '/api/v1/crisis/mine/marks';

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);
const hasText = (tree: Tree, text: string): boolean => texts(tree).includes(text);

/** What a finger presses where the accessibility label is: the nearest holder of an onPress. */
function pressable(tree: Tree, label: string): Instance {
  const found = tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  if (found.length === 0) throw new Error(`nothing to press is labelled "${label}"`);
  return found[0]!;
}

/** What a screen reader says of a pupil's row. */
const rowLabel = (tree: Tree, name: string): string | undefined =>
  tree.root.findAll((n) => isHostOf(n, 'View') && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(`${name},`))[0]?.props
    .accessibilityLabel;

let fullFake = false;
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (fullFake) await jest.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * The tab gaining focus again: its effect runs once more, as the navigator runs it, and its cleanup (the
 * timer it started) is kept to be run at the end of the test, as the navigator runs it when the tab blurs.
 */
const blurs: Array<() => void> = [];
async function refocus(): Promise<void> {
  await act(async () => {
    const cleanup = mockFocusEffect?.();
    if (typeof cleanup === 'function') blurs.push(cleanup);
  });
  await settle();
}

async function press(node: Instance): Promise<void> {
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

const found = (tree: Tree, name: string) => pressable(tree, t('crisis.markFoundA11y', { name }));
const missing = (tree: Tree, name: string) => pressable(tree, t('crisis.markMissingA11y', { name }));

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(<CrisisScreen />);
  });
  await settle();
  return tree;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The gateway as a server: what it is told of marks, it holds, as a list read afterwards shows. */
let server: MyCrisisResponse;
function take(marks: Array<{ id: string }>): { status: number; body: unknown } {
  const taken = marks.map((mark) => ({ callId: null, lessonId: null, teacherId: mockTeacher, retryCount: 0, ...mark })) as unknown as PendingCrisisMark[];
  server = withSentMarks(server, taken);
  return { status: 200, body: { stored: marks.length, duplicates: 0, unresolved: [] } };
}
function serve(response: MyCrisisResponse): void {
  server = response;
  gateway.mine = () => ({ status: 200, body: server });
  gateway.marks = take;
}

let tree: Tree | null = null;

const REAL_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime'] as const;

/** Only Date is faked: the renderer and settle() need the real timers. */
function dateOnly(): void {
  fullFake = false;
  jest.useFakeTimers({ now: NOW, doNotFake: [...REAL_TIMERS] });
}
/** Every timer is faked, to let the screen's own timer tick. */
function allTimers(): void {
  fullFake = true;
  jest.useFakeTimers({ now: NOW });
}

// The first render of the screen loads React Native's list stack, which took
// seconds on a cold cache; a test that times out is not stopped and its body
// runs into the next. So it is done once, before the tests, with an allowance of
// its own (CoverRequestsScreen.test does the same).
beforeAll(async () => {
  gateway.install();
  serve(mineOf([alarm('a1', [sevenA()])]));
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  dateOnly();
  gateway.install();
  fake.reset();
  resetCrisisQueueForTests();
  resetAlarmHintForTests();
  mockUuid = 0;
  mockRole = 'TEACHER';
  mockTeacher = 't-1';
  mockFocusEffect = null;
  mockNetwork = { isConnected: true, isInternetReachable: true };
  mockCrisisUpdate = null;
  jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([]);
  serve(mineOf([alarm('a1', [sevenA()])]));
});

afterEach(async () => {
  for (const blur of blurs.splice(0)) blur();
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

describe('CrisisScreen, a teacher’s roll call', () => {
  describe('the list, with a network', () => {
    it('says what is going on, and draws the group with each pupil in one of three states in words, a glyph and a colour', async () => {
      tree = await render();
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
      expect(hasText(tree, 'Startade kl 09:05')).toBe(true);
      expect(hasText(tree, '7A · Matematik')).toBe(true);
      expect(hasText(tree, '09:00–09:50  ·  B204')).toBe(true);
      // Each pupil, with the state in words and the glyph: never colour alone.
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(rowLabel(tree, 'Bo Berg')).toBe('Bo Berg, Finns');
      expect(rowLabel(tree, 'Cia Ceder')).toBe('Cia Ceder, Saknas');
      expect(rowLabel(tree, 'Dan Dahl')).toBe('Dan Dahl, Frånvarande sedan tidigare');
      for (const status of ['? Inte markerad', '✓ Finns', '✕ Saknas', '– Frånvarande sedan tidigare · enligt närvaron']) {
        expect(texts(tree)).toContain(status);
      }
      // The counts, each with its glyph and its words.
      for (const chip of ['✓ Finns 1', '✕ Saknas 1', '– Frånvarande 1', '? Inte markerade 2']) expect(texts(tree)).toContain(chip);
      expect(hasText(tree, '✓ Alla finns')).toBe(true);
      // Nothing is waiting, nothing is old, nothing is wrong.
      expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      expect(texts(tree).some((text) => text.startsWith('Listan hämtades'))).toBe(false);
    });

    it('asks the gateway for the teacher’s list, and for nothing else', async () => {
      tree = await render();
      expect(gateway.calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /api/v1/crisis/mine');
      expect(gateway.calls.every((c) => c.path.startsWith('/api/v1/crisis/mine'))).toBe(true);
    });

    it('says "Rast – du har gruppen nästa lektion" for a group the teacher meets after the break, and the colleagues beside them', async () => {
      serve(mineOf([alarm('a1', [call('c2', 'l2', [pupil('s1', 'Anna', 'Andersson')], { basis: 'NEXT_LESSON', colleagues: ['Karin Lind', 'Olof Ek'] })])]));
      tree = await render();
      expect(hasText(tree, t('crisis.nextLesson'))).toBe(true);
      expect(hasText(tree, 'Tillsammans med Karin Lind, Olof Ek')).toBe(true);
    });

    it('calls a drill a drill: amber, and the word ÖVNING before the kind', async () => {
      serve(mineOf([alarm('a1', [sevenA()], { mode: 'DRILL', kind: 'LOCKDOWN' })]));
      tree = await render();
      expect(hasText(tree, 'ÖVNING – Inrymning')).toBe(true);
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(false);
    });

    it('says "Larmet är avslutat" once the alarm has ended, keeps the list, and takes no more taps from the list', async () => {
      serve(mineOf([alarm('a1', [sevenA()], { endedAt: at('09:18') })]));
      tree = await render();
      expect(hasText(tree, 'Larmet är avslutat')).toBe(true);
      expect(texts(tree).some((text) => text.startsWith('Avslutat kl 09:18'))).toBe(true);
      expect(hasText(tree, 'Anna Andersson')).toBe(true);
      expect(found(tree, 'Anna Andersson').props.disabled).toBe(true);
      expect(missing(tree, 'Anna Andersson').props.disabled).toBe(true);
      expect(hasText(tree, '✓ Alla finns')).toBe(false);
      expect(gateway.to('POST', MARKS)).toEqual([]);
    });

    it('says a drill is over as a drill', async () => {
      serve(mineOf([alarm('a1', [sevenA()], { mode: 'DRILL', endedAt: at('09:18') })]));
      tree = await render();
      expect(hasText(tree, 'Övningen är avslutad')).toBe(true);
    });

    it('puts the open alarm before the one that ended, and does not show one that ended long ago', async () => {
      serve(
        mineOf([
          alarm('old', [call('c-old', 'l0', [pupil('s9', 'Gammal', 'Elev')])], { startedAt: '2027-01-12T07:00:00.000Z', endedAt: '2027-01-12T07:30:00.000Z' }),
          alarm('ended', [call('c-e', 'l-e', [pupil('s8', 'Nyss', 'Elev')])], { startedAt: at('08:50'), endedAt: at('09:10') }),
          alarm('open', [sevenA()]),
        ]),
      );
      tree = await render();
      const names = texts(tree);
      expect(names.indexOf('Anna Andersson')).toBeLessThan(names.indexOf('Nyss Elev'));
      expect(names).not.toContain('Gammal Elev');
    });

    it('says there is no alarm, in words', async () => {
      serve(mineOf([]));
      tree = await render();
      expect(hasText(tree, t('crisis.emptyTitle'))).toBe(true);
      expect(hasText(tree, t('crisis.emptyBody'))).toBe(true);
    });

    it('reads again on a pull, on the tab gaining focus, and when the gateway says an alarm began or ended', async () => {
      serve(mineOf([]));
      tree = await render();
      const reads = () => gateway.to('GET', '/api/v1/crisis/mine').length;
      expect(reads()).toBe(1);
      serve(mineOf([alarm('a1', [sevenA()])]));
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(reads()).toBe(2);
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);

      await refocus();
      expect(reads()).toBe(3);

      mockCrisisUpdate = { alarmId: 'a1', changedAt: at('09:21') };
      await act(async () => {
        tree!.update(<CrisisScreen />);
      });
      await settle();
      expect(reads()).toBe(4);
    });

    it('reads again, and sends, when the app returns to the front', async () => {
      tree = await render();
      const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1] as (state: string) => void;
      const reads = () => gateway.to('GET', '/api/v1/crisis/mine').length;
      const before = reads();
      await act(async () => handler('background'));
      expect(reads()).toBe(before);
      await act(async () => handler('active'));
      await settle();
      expect(reads()).toBe(before + 1);
    });
  });

  describe('a tap, with a network', () => {
    it('is written to the phone first, sent as the gateway takes it, and the pupil shows as found', async () => {
      tree = await render();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      await press(found(tree, 'Anna Andersson'));

      const [post] = gateway.to('POST', MARKS);
      expect(post!.body).toEqual({
        marks: [{ id: '00000000-0000-4000-8000-000000000001', callId: 'c1', studentId: 's1', state: 'FOUND', at: NOW.toISOString() }],
      });
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns');
      for (const chip of ['✓ Finns 2', '? Inte markerade 1']) expect(texts(tree)).toContain(chip);
      expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      expect(fake.pending()).toEqual([]);
    });

    it('writes the tap to the phone before the gateway has answered, and shows a clock until it has', async () => {
      const answer = deferred<void>();
      gateway.marks = async (marks) => {
        await answer.promise;
        return take(marks);
      };
      tree = await render();
      await press(missing(tree, 'Anna Andersson'));

      // The gateway has the request and has not answered: the tap is already kept, and shown.
      expect(gateway.to('POST', MARKS)).toHaveLength(1);
      expect(fake.pending('t-1').map((row) => [row.studentId, row.state, row.callId])).toEqual([['s1', 'MISSING', 'c1']]);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas, väntar på nät');
      expect(hasText(tree, '◷ Väntar på nät')).toBe(true);
      expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);

      await act(async () => answer.resolve());
      await settle();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas');
      expect(hasText(tree, '◷ Väntar på nät')).toBe(false);
    });

    it('changes a pupil from found to missing and back, and sends each tap', async () => {
      tree = await render();
      await press(found(tree, 'Anna Andersson'));
      await press(missing(tree, 'Anna Andersson'));
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas');
      const sent = gateway.to('POST', MARKS).flatMap((call) => (call.body as { marks: Array<{ state: string }> }).marks.map((m) => m.state));
      expect(sent).toEqual(['FOUND', 'MISSING']);
    });

    it('lets a tap overrule "absent since before": the pupil turned up', async () => {
      tree = await render();
      expect(rowLabel(tree, 'Dan Dahl')).toBe('Dan Dahl, Frånvarande sedan tidigare');
      await press(found(tree, 'Dan Dahl'));
      expect(rowLabel(tree, 'Dan Dahl')).toBe('Dan Dahl, Finns');
      expect(texts(tree)).not.toContain('– Frånvarande 1');
    });

    it('sends nothing for a tap on the state the pupil already has', async () => {
      tree = await render();
      await press(found(tree, 'Bo Berg'));
      expect(gateway.to('POST', MARKS)).toEqual([]);
      expect(fake.queue).toEqual([]);
    });
  });

  describe('"Alla finns"', () => {
    it('marks the pupils nobody has marked, in one call, and leaves a pupil marked missing and one absent since before as they are', async () => {
      tree = await render();
      await press(pressable(tree, t('crisis.allFoundA11y', { group: '7A · Matematik' })));

      const posts = gateway.to('POST', MARKS);
      expect(posts).toHaveLength(1);
      const marks = (posts[0]!.body as { marks: Array<{ callId: string; studentId: string; state: string }> }).marks;
      expect(marks.map((m) => [m.studentId, m.state, m.callId])).toEqual([
        ['s1', 'FOUND', 'c1'],
        ['s5', 'FOUND', 'c1'],
      ]);
      expect(rowLabel(tree, 'Cia Ceder')).toBe('Cia Ceder, Saknas');
      expect(rowLabel(tree, 'Dan Dahl')).toBe('Dan Dahl, Frånvarande sedan tidigare');
      expect(rowLabel(tree, 'Eva Ek')).toBe('Eva Ek, Finns');
      // Everyone expected has a mark: the button goes and the group says so.
      expect(hasText(tree, '✓ Alla finns')).toBe(false);
      expect(hasText(tree, '✓ Alla är markerade')).toBe(true);
    });
  });

  describe('with no network', () => {
    it('shows the same list the phone kept, says when it was read, and says why', async () => {
      // The list as the phone kept it at 09:08, from the last read with a network.
      fake.lists.set('t-1', { asOf: at('09:08'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:08'))) });
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(hasText(tree, 'Listan hämtades kl 09:08')).toBe(true);
      expect(hasText(tree, t('crisis.problemOffline'))).toBe(true);
    });

    it('shows the kept list at once, before the gateway has been asked', async () => {
      fake.lists.set('t-1', { asOf: at('09:08'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:08'))) });
      const answer = deferred<{ status: number; body: unknown }>();
      gateway.mine = () => answer.promise as never;
      tree = await render();
      expect(hasText(tree, 'Anna Andersson')).toBe(true);
      expect(hasText(tree, 'Listan hämtades kl 09:08')).toBe(true);
      await act(async () => answer.resolve({ status: 200, body: mineOf([alarm('a1', [sevenA()])]) }));
      await settle();
      expect(hasText(tree, 'Listan hämtades kl 09:08')).toBe(false);
    });

    it('keeps the list it had when a later read fails, and says it may be old', async () => {
      tree = await render();
      gateway.down = true;
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, 'Anna Andersson')).toBe(true);
      expect(hasText(tree, t('crisis.problemOffline'))).toBe(true);
      expect(hasText(tree, 'Listan hämtades kl 09:10')).toBe(true);
    });

    it('says a read that failed otherwise, and tries again', async () => {
      gateway.mine = () => ({ status: 500, body: { message: 'x' } });
      fake.lists.set('t-1', { asOf: at('09:08'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:08'))) });
      tree = await render();
      expect(hasText(tree, t('crisis.problemFailed'))).toBe(true);
    });

    it('has no list to show for a phone that never had one, and says so rather than that no alarm is going', async () => {
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, t('crisis.noListTitle'))).toBe(true);
      expect(hasText(tree, t('crisis.noListBody'))).toBe(true);
      expect(hasText(tree, t('crisis.emptyTitle'))).toBe(false);
    });

    it('shows a tap at once with a clock on it and a count of what waits, keeps it, and sends it when the network is back', async () => {
      allTimers();
      tree = await render();
      gateway.down = true;
      await press(found(tree, 'Anna Andersson'));

      // Shown at once, waiting.
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns, väntar på nät');
      expect(hasText(tree, '◷ Väntar på nät')).toBe(true);
      expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);
      // Kept on the phone, for the teacher who taps and for no one else.
      const [kept] = fake.pending('t-1');
      expect(kept).toMatchObject({ id: '00000000-0000-4000-8000-000000000001', callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND' });
      expect(fake.pending('t-2')).toEqual([]);

      // Another tap while the network is still gone: both wait, both shown.
      await press(missing(tree, 'Eva Ek'));
      expect(hasText(tree, '◷ 2 markeringar väntar på nät')).toBe(true);

      // The network is back: the screen's own timer sends them, with the same ids.
      gateway.down = false;
      await settle(RETRY_MS);
      const sent = gateway.to('POST', MARKS).filter((call) => !gateway.down && (call.body as { marks: unknown[] }).marks.length === 2);
      const last = sent.at(-1)!.body as { marks: Array<{ id: string; callId: string; studentId: string; state: string }> };
      expect(last.marks.map((m) => [m.id, m.callId, m.studentId, m.state])).toEqual([
        ['00000000-0000-4000-8000-000000000001', 'c1', 's1', 'FOUND'],
        ['00000000-0000-4000-8000-000000000002', 'c1', 's5', 'MISSING'],
      ]);
      expect(fake.pending()).toEqual([]);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns');
      expect(rowLabel(tree, 'Eva Ek')).toBe('Eva Ek, Saknas');
      expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
    });

    it('sends again, when the network returns, a tap the gateway never answered', async () => {
      allTimers();
      tree = await render();
      gateway.marks = () => 'network' as never;
      await press(found(tree, 'Anna Andersson'));
      const firstTry = gateway.to('POST', MARKS)[0]!.body as { marks: Array<{ id: string }> };
      expect(hasText(tree, '◷ Väntar på nät')).toBe(true);

      serve(server);
      await settle(RETRY_MS);
      const again = gateway.to('POST', MARKS).at(-1)!.body as { marks: Array<{ id: string }> };
      expect(again.marks.map((m) => m.id)).toEqual(firstTry.marks.map((m) => m.id));
      expect(hasText(tree, '◷ Väntar på nät')).toBe(false);
    });

    it('sends what was left from the last time the app was open, without a tap', async () => {
      await enqueueCrisisMarks([
        { id: 'left-over', callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND', at: at('09:12'), teacherId: 't-1' },
      ]);
      tree = await render();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns');
      const posts = gateway.to('POST', MARKS);
      expect(posts).toHaveLength(1);
      expect((posts[0]!.body as { marks: Array<{ id: string }> }).marks[0]!.id).toBe('left-over');
    });

    it('does not show, count or send a colleague’s taps on the same tablet', async () => {
      await enqueueCrisisMarks([
        { id: 'theirs', callId: 'c1', lessonId: null, studentId: 's1', state: 'MISSING', at: at('09:12'), teacherId: 't-2' },
      ]);
      tree = await render();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      expect(gateway.to('POST', MARKS)).toEqual([]);
      expect(fake.pending('t-2')).toHaveLength(1);
    });

    it('does not show the kept list of a colleague', async () => {
      fake.lists.set('t-2', { asOf: at('09:08'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:08'))) });
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, 'Anna Andersson')).toBe(false);
      expect(hasText(tree, t('crisis.noListTitle'))).toBe(true);
    });
  });

  describe('a tap the gateway will never take', () => {
    it('is forgotten, and the teacher is told once, in words: the alarm had ended', async () => {
      gateway.marks = () => ({ status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } });
      tree = await render();
      await press(found(tree, 'Anna Andersson'));

      expect(hasText(tree, '1 markering skickades inte')).toBe(true);
      expect(hasText(tree, 'Larmet hann avslutas.')).toBe(true);
      expect(fake.queue).toEqual([]);
      // The pupil is back to what the gateway says, and nothing waits.
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);

      await press(pressable(tree, t('crisis.dropped.dismiss')));
      expect(hasText(tree, '1 markering skickades inte')).toBe(false);
    });

    it('is told when the screen was away: a flush by the app’s own timer dropped it', async () => {
      await enqueueCrisisMarks([{ id: 'x', callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND', at: at('09:12'), teacherId: 't-1' }]);
      gateway.marks = () => ({ status: 403, body: { message: 'x', code: 'CRISIS_NOT_YOURS' } });
      await flushCrisisQueue();
      tree = await render();
      expect(hasText(tree, '1 markering skickades inte')).toBe(true);
      expect(hasText(tree, 'Du svarar inte för den gruppen.')).toBe(true);
    });

    it('is told for each reason, and counted together', async () => {
      tree = await render();
      await enqueueCrisisMarks([
        { id: 'a', callId: 'c1', lessonId: null, studentId: 's1', state: 'FOUND', at: at('09:12'), teacherId: 't-1' },
        { id: 'b', callId: 'c1', lessonId: null, studentId: 's5', state: 'FOUND', at: at('09:13'), teacherId: 't-1' },
      ]);
      gateway.marks = (marks) =>
        marks.some((m) => m.id === 'a') && marks.length === 2
          ? { status: 400, body: { message: 'x', code: 'CRISIS_MARK_INVALID' } }
          : marks[0]!.id === 'a'
            ? { status: 400, body: { message: 'x', code: 'CRISIS_MARK_INVALID' } }
            : { status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } };
      await act(async () => {
        await flushCrisisQueue();
      });
      await settle();
      expect(hasText(tree, '2 markeringar skickades inte')).toBe(true);
      expect(hasText(tree, 'Eleven står inte på gruppens lista.')).toBe(true);
      expect(hasText(tree, 'Larmet hann avslutas.')).toBe(true);
    });
  });

  describe('a phone that was told of an alarm and never got its list', () => {
    const lesson = {
      id: 'l1',
      startTime: at('09:00'),
      endTime: at('09:50'),
      subjectName: 'Matematik',
      roomName: 'B204',
      studentIds: ['s1', 's2', 's3'],
    };

    beforeEach(() => {
      // The alarm push arrived at 09:15; the phone holds the lesson and its pupils from the register.
      fake.lessons = [lesson];
      fake.names.set('s1', 'Anna Andersson');
      fake.names.set('s2', 'Bo Berg');
      fake.names.set('s3', 'Cia Ceder');
      fake.register.set('t-1', new Map([['l1', new Set(['s3'])]]));
      fake.hint = { alarmAt: at('09:15'), endedAt: null };
      gateway.down = true;
    });

    it('builds the list from what it holds, calls it local, and shows who the register had absent', async () => {
      tree = await render();
      expect(hasText(tree, t('crisis.bannerLocal'))).toBe(true);
      expect(hasText(tree, t('crisis.localList'))).toBe(true);
      expect(hasText(tree, t('crisis.localListHint'))).toBe(true);
      // The cache holds a subject and a room, not the group's name.
      expect(hasText(tree, 'Matematik')).toBe(true);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(rowLabel(tree, 'Cia Ceder')).toBe('Cia Ceder, Frånvarande sedan tidigare');
      // A drill or a real alarm is not something the push said.
      expect(hasText(tree, 'ÖVNING')).toBe(false);
    });

    it('queues a tap on it by the lesson, not by a call, timed no earlier than the push', async () => {
      tree = await render();
      await press(missing(tree, 'Anna Andersson'));
      const [row] = fake.pending('t-1');
      expect(row).toMatchObject({ callId: null, lessonId: 'l1', studentId: 's1', state: 'MISSING' });
      expect(Date.parse(row!.at)).toBeGreaterThanOrEqual(Date.parse(at('09:15')));
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas, väntar på nät');
      expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);
    });

    it('is replaced by the gateway’s list when it arrives: the tap stays, and is sent by the lesson', async () => {
      allTimers();
      tree = await render();
      await press(missing(tree, 'Anna Andersson'));

      // The network is back and the gateway has the alarm, whose call for the lesson is the teacher's.
      gateway.down = false;
      serve(mineOf([alarm('a1', [sevenA()], { startedAt: '2027-01-12T09:14:30.000Z' })], at('09:16')));
      await settle(RETRY_MS);

      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
      expect(hasText(tree, '7A · Matematik')).toBe(true);
      const sent = gateway.to('POST', MARKS).filter((call) => !gateway.down).at(-1)!.body as { marks: Array<{ lessonId?: string; callId?: string; studentId: string }> };
      expect(sent.marks.map((m) => [m.lessonId, m.callId, m.studentId])).toEqual([['l1', undefined, 's1']]);
      expect(fake.pending()).toEqual([]);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas');
    });

    it('keeps the tap while the gateway’s list is there and the tap is not yet sent', async () => {
      tree = await render();
      await press(missing(tree, 'Anna Andersson'));
      gateway.down = false;
      gateway.marks = () => 'network' as never;
      serve(mineOf([alarm('a1', [sevenA()], { startedAt: '2027-01-12T09:14:30.000Z' })], at('09:16')));
      gateway.marks = () => 'network' as never;
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      // The server's call for the lesson, with the teacher's tap on it, waiting.
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Saknas, väntar på nät');
    });

    it('does not build one once the end of the alarm has been told of', async () => {
      fake.hint = { alarmAt: at('09:15'), endedAt: at('09:18') };
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, t('crisis.noListTitle'))).toBe(true);
    });

    it('does not build one without a lesson to build it from', async () => {
      fake.lessons = [];
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
    });

    it('learns of the alarm from the push still in the tray when the teacher opens the app by hand', async () => {
      fake.hint = null;
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([
        { date: Date.parse(at('09:15')), request: { content: { data: { notificationId: 'n', type: 'CRISIS_ALARM' } } } },
      ] as never);
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(true);
    });
  });

  describe('what a screen reader is told, and what a finger can hit', () => {
    it('names each button for the pupil and the state, and says which is chosen', async () => {
      tree = await render();
      const foundBo = found(tree, 'Bo Berg');
      expect(foundBo.props.accessibilityRole).toBe('button');
      expect(foundBo.props.accessibilityState).toEqual({ selected: true, disabled: false });
      expect(missing(tree, 'Bo Berg').props.accessibilityState).toEqual({ selected: false, disabled: false });
      expect(missing(tree, 'Cia Ceder').props.accessibilityState).toEqual({ selected: true, disabled: false });
    });

    it('makes every tap target at least 48 pt, the pupils’ buttons and "Alla finns" alike', async () => {
      tree = await render();
      const high = (node: Instance): number => (StyleSheet.flatten(node.props.style) as { minHeight?: number }).minHeight ?? 0;
      expect(high(found(tree, 'Anna Andersson'))).toBeGreaterThanOrEqual(48);
      expect(high(missing(tree, 'Anna Andersson'))).toBeGreaterThanOrEqual(48);
      expect(high(pressable(tree, t('crisis.allFoundA11y', { group: '7A · Matematik' })))).toBeGreaterThanOrEqual(48);
    });

    it('announces the banner and a count that changes', async () => {
      tree = await render();
      const banner = tree.root.findAll((n) => n.props.accessibilityRole === 'header' && String(n.props.accessibilityLabel).startsWith('Utrymning – skarpt larm'));
      expect(banner.length).toBeGreaterThan(0);
      expect(banner[0]!.props.accessibilityLiveRegion).toBe('polite');
    });
  });

  describe('who is shown it', () => {
    it('shows an administrator the administration’s side, not the teacher’s list', async () => {
      mockRole = 'SCHOOL_ADMIN';
      tree = await render();
      expect(gateway.to('GET', '/api/v1/crisis/mine')).toEqual([]);
      expect(hasText(tree, t('crisis.admin.startTitle'))).toBe(true);
    });

    it('shows a student or a guardian that it is not for them, and reads nothing', async () => {
      mockRole = 'STUDENT';
      tree = await render();
      expect(hasText(tree, t('crisis.unavailable'))).toBe(true);
      expect(gateway.calls).toEqual([]);
    });
  });
});
