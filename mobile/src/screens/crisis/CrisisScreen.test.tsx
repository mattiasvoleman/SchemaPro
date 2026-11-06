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
import { AppState, FlatList, RefreshControl, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import { fake } from '../../services/__testing__/crisisDatabase';
import { alarm, at, call, foundWith, gateway, mineOf, other, pupil, sevenA } from '../../services/__testing__/crisisGateway';
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
import { RETRY_MS, useCrisis, type CrisisState } from '../../hooks/useCrisis';
import { DEBOUNCE_MS, SEARCH_TIMEOUT_MS } from './FoundHerePicker';
import { CrisisScreen } from './CrisisScreen';
import { callTitle } from './crisisParts';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');
const NOW = new Date(at('09:20'));
const MARKS = '/api/v1/crisis/mine/marks';

/** The marks the gateway was sent, each once: a pass that found no network sent the same ones again. */
const sentMarks = (): Array<Record<string, string>> => {
  const once = new Map<string, Record<string, string>>();
  for (const call of gateway.to('POST', MARKS)) for (const mark of (call.body as { marks: Array<Record<string, string>> }).marks) once.set(mark['id']!, mark);
  return [...once.values()];
};

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
/** The school’s pupils by id, as the gateway knows them: it names a pupil found with a teacher, as the phone’s mark does not. */
const directory = new Map<string, { firstName: string; lastName: string; className: string | null }>();
function take(marks: Array<{ id: string }>): { status: number; body: unknown } {
  const taken = marks.map((mark) => ({
    callId: null,
    lessonId: null,
    teacherId: mockTeacher,
    retryCount: 0,
    pupil: directory.get((mark as unknown as { studentId: string }).studentId) ?? null,
    ...mark,
  })) as unknown as PendingCrisisMark[];
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
      expect(hasText(tree, 'Listan hämtades kl 09:08 (för 12 min sedan)')).toBe(true);
      expect(hasText(tree, t('crisis.problemOffline'))).toBe(true);
    });

    it('shows the kept list at once, before the gateway has been asked', async () => {
      fake.lists.set('t-1', { asOf: at('09:08'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:08'))) });
      const answer = deferred<{ status: number; body: unknown }>();
      gateway.mine = () => answer.promise as never;
      tree = await render();
      expect(hasText(tree, 'Anna Andersson')).toBe(true);
      expect(hasText(tree, 'Listan hämtades kl 09:08 (för 12 min sedan)')).toBe(true);
      await act(async () => answer.resolve({ status: 200, body: mineOf([alarm('a1', [sevenA()])]) }));
      await settle();
      expect(texts(tree).some((text) => text.startsWith('Listan hämtades'))).toBe(false);
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
      expect(hasText(tree, 'Listan hämtades kl 09:10 (för 10 min sedan)')).toBe(true);
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
      expect(hasText(tree, 'Gruppen eller larmet kunde inte ta emot markeringen.')).toBe(true);
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

  describe('a pupil who is on none of the teacher’s lists: "found with me"', () => {
    const SEARCH = '/api/v1/crisis/mine/pupils';
    const ASA = other('s20', 'Åsa', 'Lind', '7B');
    const KALLE = other('s21', 'Kalle', 'Lund', '7C');
    const MAJA = other('s22', 'Maja', 'Moa', '7B');
    const BUTTON = t('crisis.foundHere.button');
    /** The moment of a tap made after the typing paused: the clock is faked, and the pause is part of it. */
    const AFTER_TYPING = new Date(NOW.getTime() + DEBOUNCE_MS).toISOString();
    /** The school’s other pupils, as the gateway’s search finds them: by the start of a name or a class. */
    const SCHOOL = [ASA, KALLE, MAJA];
    const answerSearch = (): void => {
      gateway.pupils = (_alarm, q) => {
        const asked = q.toLowerCase();
        const words = (pupil: typeof ASA) => `${pupil.firstName} ${pupil.lastName} ${pupil.className ?? ''}`.toLowerCase().split(' ');
        return { status: 200, body: SCHOOL.filter((pupil) => words(pupil).some((word) => word.startsWith(asked))) };
      };
    };
    const searches = () => gateway.to('POST', SEARCH);

    beforeEach(() => {
      allTimers();
      directory.clear();
      for (const pupil of SCHOOL) directory.set(pupil.studentId, { firstName: pupil.firstName, lastName: pupil.lastName, className: pupil.className });
      answerSearch();
      serve(mineOf([alarm('a1', [sevenA()])]));
    });

    const searchBox = (tree: Tree): Instance => {
      const found = tree.root.findAll((n) => n.props.accessibilityLabel === t('crisis.foundHere.searchLabel') && typeof n.props.onChangeText === 'function');
      if (found.length === 0) throw new Error('the picker is not open');
      return found[0]!;
    };
    /** Types, and waits for the typing to pause: the question is asked then. */
    const type = async (tree: Tree, query: string): Promise<void> => {
      await act(async () => {
        searchBox(tree).props.onChangeText(query);
      });
      await settle(DEBOUNCE_MS);
    };
    const pick = (tree: Tree, name: string, group = '7A · Matematik') => pressable(tree, t('crisis.foundHere.pickA11y', { name, group }));
    const pickFree = (tree: Tree, name: string) => pressable(tree, t('crisis.foundHere.pickFreeA11y', { name }));
    const pickerOpen = (tree: Tree): boolean => tree.root.findAll((n) => n.props.accessibilityLabel === t('crisis.foundHere.searchLabel')).length > 0;
    const foundHereRow = (tree: Tree, name: string, waiting = false): string | undefined =>
      tree.root.findAll(
        (n) => isHostOf(n, 'View') && n.props.accessibilityLabel === t(waiting ? 'crisis.foundHere.rowWaitingA11y' : 'crisis.foundHere.rowA11y', { name }),
      )[0]?.props.accessibilityLabel;
    const retract = (tree: Tree, name: string) => pressable(tree, t('crisis.foundHere.retractA11y', { name }));
    describe('the button', () => {
      it('is offered once per open alarm that has a group of the teacher’s', async () => {
        tree = await render();
        expect(pressable(tree, BUTTON).props.accessibilityRole).toBe('button');
        expect(tree.root.findAll((n) => isHostOf(n, 'Text') && textOf(n) === BUTTON)).toHaveLength(1);
        expect(pickerOpen(tree)).toBe(false);
      });

      it('is a tap target of at least 48 pt', async () => {
        tree = await render();
        expect((StyleSheet.flatten(pressable(tree, BUTTON).props.style) as { minHeight?: number }).minHeight).toBeGreaterThanOrEqual(48);
      });

      it('is offered to a teacher with no group right now, while the alarm is open', async () => {
        serve(mineOf([alarm('a1', [])]));
        tree = await render();
        expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
        expect(pressable(tree, BUTTON)).toBeDefined();
      });

      it('is not offered once the alarm has ended', async () => {
        serve(mineOf([alarm('a1', [sevenA()], { endedAt: at('09:18') })]));
        tree = await render();
        expect(hasText(tree, 'Larmet är avslutat')).toBe(true);
        expect(() => pressable(tree!, BUTTON)).toThrow();
      });

      it('is not offered on a list the phone built itself: it has no alarm of the gateway’s to search in', async () => {
        fake.lessons = [{ id: 'l1', startTime: at('09:00'), endTime: at('09:50'), subjectName: 'Matematik', roomName: 'B204', studentIds: ['s1'] }];
        fake.names.set('s1', 'Anna Andersson');
        fake.hint = { alarmAt: at('09:15'), endedAt: null };
        gateway.down = true;
        tree = await render();
        expect(hasText(tree, t('crisis.localList'))).toBe(true);
        expect(() => pressable(tree!, BUTTON)).toThrow();
        expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      });
    });

    describe('the picker', () => {
      it('asks the gateway for the alarm and the text once the typing pauses, and shows the pupils it answers with their class', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        expect(pickerOpen(tree)).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.hint'))).toBe(true);
        expect(searches()).toEqual([]);

        await type(tree, 'Åsa');
        // The alarm and the text are in the body of a POST: nothing of a pupil’s name is in the URL.
        expect(searches().map((c) => [c.path, c.body])).toEqual([[SEARCH, { alarmId: 'a1', q: 'Åsa' }]]);
        expect(gateway.calls.filter((c) => c.path.includes('?') && c.path.includes('mine/pupils'))).toEqual([]);
        expect(hasText(tree, 'Åsa Lind')).toBe(true);
        expect(hasText(tree, '7B')).toBe(true);
        expect(hasText(tree, 'Kalle Lund')).toBe(false);
        await type(tree, '7b');
        expect(hasText(tree, 'Åsa Lind')).toBe(true);
        expect(hasText(tree, 'Maja Moa')).toBe(true);
        expect(hasText(tree, 'Kalle Lund')).toBe(false);
      });

      it('asks nothing for less than two characters, and nothing while the typing goes on', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'a');
        expect(searches()).toEqual([]);
        expect(hasText(tree, t('crisis.foundHere.hint'))).toBe(true);

        // Three keys within the pause are one question.
        await act(async () => searchBox(tree!).props.onChangeText('ka'));
        await settle(100);
        await act(async () => searchBox(tree!).props.onChangeText('kal'));
        await settle(100);
        await act(async () => searchBox(tree!).props.onChangeText('kall'));
        expect(searches()).toEqual([]);
        await settle(DEBOUNCE_MS);
        expect(searches().map((c) => (c.body as { q: string }).q)).toEqual(['kall']);
        expect(hasText(tree, 'Kalle Lund')).toBe(true);
        // Deleting back to one character goes back to the hint, and asks nothing more.
        await type(tree, 'k');
        expect(hasText(tree, t('crisis.foundHere.hint'))).toBe(true);
        expect(hasText(tree, 'Kalle Lund')).toBe(false);
        expect(searches()).toHaveLength(1);
      });

      it('does not look at an answer to a question that has been overtaken', async () => {
        const slow = deferred<{ status: number; body: unknown }>();
        gateway.pupils = (_alarm, q) => (q === 'an' ? (slow.promise as never) : { status: 200, body: [other('s30', 'Anna', 'Ek', '8A')] });
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'an');
        expect(hasText(tree, t('crisis.foundHere.searching'))).toBe(true);
        await type(tree, 'ann');
        expect(hasText(tree, 'Anna Ek')).toBe(true);
        // The first answer arrives last, and is not looked at.
        await act(async () => slow.resolve({ status: 200, body: [other('s31', 'Andreas', 'Berg', '9B')] }));
        await settle();
        expect(hasText(tree, 'Anna Ek')).toBe(true);
        expect(hasText(tree, 'Andreas Berg')).toBe(false);
      });

      it('says the search needs a network, rather than that nobody matches, when the phone has none', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        gateway.down = true;
        await type(tree, 'asa');
        expect(hasText(tree, t('crisis.foundHere.needsNetwork'))).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.none'))).toBe(false);
        expect(hasText(tree, 'Åsa Lind')).toBe(false);
        // And searches again when the network is back and the teacher types.
        gateway.down = false;
        await type(tree, 'asa ');
        await type(tree, 'Åsa');
        expect(hasText(tree, t('crisis.foundHere.needsNetwork'))).toBe(false);
        expect(hasText(tree, 'Åsa Lind')).toBe(true);
      });

      it('gives up on a question the network does not answer, and says the search needs a network', async () => {
        // A request that never answers, and ends as fetch does when it is aborted.
        const answering = gateway.fetch.getMockImplementation()!;
        gateway.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
          if (!String(url).includes('/mine/pupils')) return answering(url, init);
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        });
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'asa');
        expect(hasText(tree, t('crisis.foundHere.searching'))).toBe(true);
        await settle(SEARCH_TIMEOUT_MS);
        expect(hasText(tree, t('crisis.foundHere.needsNetwork'))).toBe(true);
      });

      it('says the search did not work when the gateway answers with a failure, and is tried again by typing', async () => {
        gateway.pupils = () => ({ status: 500, body: { message: 'x' } });
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'asa');
        expect(hasText(tree, t('crisis.foundHere.searchFailed'))).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.needsNetwork'))).toBe(false);
        answerSearch();
        await type(tree, 'Åsa');
        expect(hasText(tree, 'Åsa Lind')).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.searchFailed'))).toBe(false);
      });

      it('says nobody matches, and says when the gateway gave as many as it gives', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'zzz');
        expect(hasText(tree, t('crisis.foundHere.none'))).toBe(true);
        const many = Array.from({ length: 25 }, (_, i) => other(`o${i}`, `Elev${String(i).padStart(2, '0')}`, 'Test', '7B'));
        gateway.pupils = () => ({ status: 200, body: many });
        await type(tree, 'elev');
        expect(hasText(tree, t('crisis.foundHere.more', { count: 25 }))).toBe(true);
        expect(hasText(tree, 'Elev00 Test')).toBe(true);
      });

      it('does not offer a pupil already found with the teacher, whom the gateway may still list', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'åsa');
        expect(() => pick(tree!, 'Åsa Lind')).toThrow();
        expect(hasText(tree, t('crisis.foundHere.none'))).toBe(true);
      });

      it('keeps nothing of the search: not on the phone’s disk, not in the kept list, not in the queue', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, '7b');
        expect(hasText(tree, 'Åsa Lind')).toBe(true);
        await press(pressable(tree, t('crisis.foundHere.close')));
        const everything = JSON.stringify([...fake.lists.values()]) + JSON.stringify(fake.queue);
        for (const name of ['Åsa', 'Kalle', 'Maja', 'Lind', 'Moa']) expect(everything).not.toContain(name);
      });

      it('closes without a mark, and opens empty the next time', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'asa');
        await press(pressable(tree, t('crisis.foundHere.close')));
        expect(pickerOpen(tree)).toBe(false);
        expect(fake.queue).toEqual([]);
        expect(gateway.to('POST', MARKS)).toEqual([]);
        await press(pressable(tree, BUTTON));
        expect(hasText(tree, 'Åsa Lind')).toBe(false);
        expect(hasText(tree, t('crisis.foundHere.hint'))).toBe(true);
      });

      it('closes by itself when the alarm ends under it', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        expect(pickerOpen(tree)).toBe(true);
        serve(mineOf([alarm('a1', [sevenA()], { endedAt: at('09:21') })]));
        await act(async () => {
          tree!.root.findByType(RefreshControl).props.onRefresh();
        });
        await settle();
        expect(pickerOpen(tree)).toBe(false);
      });
    });

    describe('saying it', () => {
      it('queues a FOUND mark naming the teacher’s call, shows the pupil at once under "Hittade hos dig", and sends it like any mark', async () => {
        tree = await render();
        expect(hasText(tree, 'Hittade hos dig (1)')).toBe(false);
        await press(pressable(tree, BUTTON));
        await type(tree, 'åsa');
        await press(pick(tree, 'Åsa Lind'));

        expect(pickerOpen(tree)).toBe(false);
        const [post] = gateway.to('POST', MARKS);
        expect(post!.body).toEqual({
          marks: [{ id: '00000000-0000-4000-8000-000000000001', callId: 'c1', studentId: 's20', state: 'FOUND', at: AFTER_TYPING }],
        });
        expect(hasText(tree, 'Hittade hos dig (1)')).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.titleHint'))).toBe(true);
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
        expect(hasText(tree, '✓ Hittad hos dig')).toBe(true);
        expect(hasText(tree, '7B')).toBe(true);
        // The group’s own count is the group’s: the pupil counts on their own list.
        for (const chip of ['✓ Finns 1', '✕ Saknas 1', '– Frånvarande 1', '? Inte markerade 2']) expect(texts(tree)).toContain(chip);
        expect(fake.pending()).toEqual([]);
        expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      });

      it('keeps the pupil’s name on the queued mark while it waits, and the phone forgets it when the gateway has the mark', async () => {
        const answer = deferred<void>();
        gateway.marks = async (marks) => {
          await answer.promise;
          return take(marks);
        };
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'kalle');
        await press(pick(tree, 'Kalle Lund'));

        expect(fake.pending('t-1').map((row) => [row.studentId, row.state, row.callId, row.pupil])).toEqual([
          ['s21', 'FOUND', 'c1', { firstName: 'Kalle', lastName: 'Lund', className: '7C' }],
        ]);
        expect(foundHereRow(tree, 'Kalle Lund', true)).toBeDefined();
        expect(hasText(tree, '◷ Väntar på nät')).toBe(true);
        expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);
        // The name is not in the body: the gateway has the pupil’s id.
        expect(JSON.stringify(gateway.to('POST', MARKS)[0]!.body)).not.toContain('Kalle');

        await act(async () => answer.resolve());
        await settle();
        expect(foundHereRow(tree, 'Kalle Lund')).toBeDefined();
        expect(hasText(tree, '◷ Väntar på nät')).toBe(false);
        expect(fake.queue.map((row) => row.pupil)).toEqual([null]);
        expect(server.alarms[0]!.calls[0]!.foundHere.map((f) => f.studentId)).toEqual(['s21']);
      });

      it('works with no network once the pupil is picked: kept on the phone, shown with a clock, sent when the network is back', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'maja');
        gateway.down = true;
        await press(pick(tree, 'Maja Moa'));

        expect(fake.pending('t-1')).toMatchObject([{ callId: 'c1', lessonId: null, alarmId: null, studentId: 's22', state: 'FOUND' }]);
        expect(foundHereRow(tree, 'Maja Moa', true)).toBeDefined();
        expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);

        gateway.down = false;
        await settle(RETRY_MS);
        const last = gateway.to('POST', MARKS).filter((call) => !gateway.down).at(-1)!.body as { marks: Array<{ callId: string; studentId: string; state: string }> };
        expect(last.marks.map((m) => [m.callId, m.studentId, m.state])).toEqual([['c1', 's22', 'FOUND']]);
        expect(fake.pending()).toEqual([]);
        expect(foundHereRow(tree, 'Maja Moa')).toBeDefined();
        expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      });

      it('shows it again from the phone’s own copy after the network goes, once the gateway has taken the mark', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'åsa');
        await press(pick(tree, 'Åsa Lind'));
        await act(async () => tree!.unmount());
        gateway.down = true;
        tree = await render();
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
        expect(hasText(tree, 'Hittade hos dig (1)')).toBe(true);
      });

      it('never offers "missing" for them: the row has no found or missing buttons', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'åsa');
        await press(pick(tree, 'Åsa Lind'));
        expect(() => pressable(tree!, t('crisis.markMissingA11y', { name: 'Åsa Lind' }))).toThrow();
        expect(() => pressable(tree!, t('crisis.markFoundA11y', { name: 'Åsa Lind' }))).toThrow();
        expect(gateway.to('POST', MARKS)).toHaveLength(1);
      });

      it('asks which group when the teacher has more than one, begins with the lesson that is going on, and marks on the one chosen', async () => {
        const next = call('c1', 'l1', [pupil('s1', 'Anna', 'Andersson')], { basis: 'NEXT_LESSON', groupName: '7A' });
        const now = call('c2', 'l2', [pupil('s2', 'Bo', 'Berg')], { basis: 'LESSON', groupName: '8B' });
        serve(mineOf([alarm('a1', [next, now])]));
        tree = await render();
        await press(pressable(tree, BUTTON));
        expect(hasText(tree, t('crisis.foundHere.whichGroup'))).toBe(true);
        expect(pressable(tree, '8B · Matematik').props.accessibilityState).toEqual({ selected: true });
        expect(pressable(tree, '7A · Matematik').props.accessibilityState).toEqual({ selected: false });

        await type(tree, 'åsa');
        await press(pick(tree, 'Åsa Lind', '8B · Matematik'));
        await press(pressable(tree, BUTTON));
        await press(pressable(tree, '7A · Matematik'));
        await type(tree, 'kalle');
        await press(pick(tree, 'Kalle Lund', '7A · Matematik'));

        expect(sentMarks().map((m) => [m['callId'], m['studentId']])).toEqual([['c2', 's20'], ['c1', 's21']]);
      });

      it('does not ask which group when there is one', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        expect(hasText(tree, t('crisis.foundHere.whichGroup'))).toBe(false);
      });
    });

    describe('a teacher with no group right now', () => {
      beforeEach(() => serve(mineOf([alarm('a1', [])])));

      it('sends the mark with the alarm in place of a call, and shows the pupil under the alarm, with a clock', async () => {
        const answer = deferred<void>();
        gateway.marks = async (marks) => {
          await answer.promise;
          return take(marks);
        };
        tree = await render();
        await press(pressable(tree, BUTTON));
        // No group to choose from, and no group in the question.
        expect(hasText(tree, t('crisis.foundHere.whichGroup'))).toBe(false);
        await type(tree, 'åsa');
        await press(pickFree(tree, 'Åsa Lind'));

        expect(gateway.to('POST', MARKS)[0]!.body).toEqual({
          marks: [{ id: '00000000-0000-4000-8000-000000000001', alarmId: 'a1', studentId: 's20', state: 'FOUND', at: AFTER_TYPING }],
        });
        expect(fake.pending('t-1')).toMatchObject([{ callId: null, lessonId: null, alarmId: 'a1', studentId: 's20' }]);
        expect(hasText(tree, 'Hittade av dig (1)')).toBe(true);
        expect(hasText(tree, t('crisis.foundHere.freeTitleHint'))).toBe(true);
        expect(foundHereRow(tree, 'Åsa Lind', true)).toBeDefined();

        await act(async () => answer.resolve());
        await settle();
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
        expect(hasText(tree, '◷ Väntar på nät')).toBe(false);
        expect(server.alarms[0]!.foundFree.map((f) => f.studentId)).toEqual(['s20']);
      });

      it('keeps the mark with the alarm on the phone with no network, and sends it when the network is back', async () => {
        allTimers();
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'maja');
        gateway.down = true;
        await press(pickFree(tree, 'Maja Moa'));
        expect(foundHereRow(tree, 'Maja Moa', true)).toBeDefined();
        expect(fake.pending('t-1')).toMatchObject([{ alarmId: 'a1', callId: null }]);

        gateway.down = false;
        await settle(RETRY_MS);
        expect(sentMarks().map((m) => [m['alarmId'], m['studentId'], m['callId']])).toEqual([['a1', 's22', undefined]]);
        expect(foundHereRow(tree, 'Maja Moa')).toBeDefined();
      });

      it('shows the pupils the gateway holds as found with no group, from the list and from the phone’s copy of it', async () => {
        serve(mineOf([alarm('a1', [], { foundFree: [foundWith('s30', 'Nils', 'Ek', '8A'), foundWith('s31', 'Bea', 'Ek')] })]));
        tree = await render();
        expect(hasText(tree, 'Hittade av dig (2)')).toBe(true);
        expect(texts(tree).filter((text) => text.endsWith(' Ek'))).toEqual(['Bea Ek', 'Nils Ek']);
        await act(async () => tree!.unmount());
        gateway.down = true;
        tree = await render();
        expect(foundHereRow(tree, 'Nils Ek')).toBeDefined();
      });
    });

    describe('taking one back ("Ta tillbaka")', () => {
      it('queues a RETRACTED mark naming the same call and takes the pupil off the list at once, for a pupil the gateway holds', async () => {
        const answer = deferred<void>();
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        gateway.marks = async (marks) => {
          await answer.promise;
          return take(marks);
        };
        tree = await render();
        expect(hasText(tree, 'Hittade hos dig (1)')).toBe(true);
        await press(retract(tree, 'Åsa Lind'));

        expect(gateway.to('POST', MARKS)[0]!.body).toEqual({
          marks: [{ id: '00000000-0000-4000-8000-000000000001', callId: 'c1', studentId: 's20', state: 'RETRACTED', at: NOW.toISOString() }],
        });
        // Out of the list before the gateway has answered.
        expect(foundHereRow(tree, 'Åsa Lind')).toBeUndefined();
        expect(foundHereRow(tree, 'Åsa Lind', true)).toBeUndefined();
        expect(texts(tree).some((text) => text.startsWith('Hittade hos dig'))).toBe(false);
        await act(async () => answer.resolve());
        await settle();
        expect(foundHereRow(tree, 'Åsa Lind')).toBeUndefined();
        expect(server.alarms[0]!.calls[0]!.foundHere).toEqual([]);
        expect(fake.pending()).toEqual([]);
      });

      it('names the alarm for a pupil found with no group', async () => {
        serve(mineOf([alarm('a1', [], { foundFree: [foundWith('s30', 'Nils', 'Ek', '8A')] })]));
        tree = await render();
        await press(retract(tree, 'Nils Ek'));
        expect(gateway.to('POST', MARKS)[0]!.body).toEqual({
          marks: [{ id: '00000000-0000-4000-8000-000000000001', alarmId: 'a1', studentId: 's30', state: 'RETRACTED', at: NOW.toISOString() }],
        });
        expect(foundHereRow(tree, 'Nils Ek')).toBeUndefined();
        expect(server.alarms[0]!.foundFree).toEqual([]);
      });

      it('works with no network: the pupil is gone at once, the taking-back waits and is sent when the network is back', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        tree = await render();
        gateway.down = true;
        await press(retract(tree, 'Åsa Lind'));
        expect(foundHereRow(tree, 'Åsa Lind')).toBeUndefined();
        expect(fake.pending('t-1')).toMatchObject([{ callId: 'c1', studentId: 's20', state: 'RETRACTED' }]);
        expect(hasText(tree, '◷ 1 markering väntar på nät')).toBe(true);

        gateway.down = false;
        await settle(RETRY_MS);
        expect(sentMarks().map((m) => [m['studentId'], m['state']])).toEqual([['s20', 'RETRACTED']]);
        expect(fake.pending()).toEqual([]);
        expect(foundHereRow(tree, 'Åsa Lind')).toBeUndefined();
      });

      it('deletes a found that has not left the phone, and sends nothing about the pupil at all', async () => {
        tree = await render();
        await press(pressable(tree, BUTTON));
        await type(tree, 'maja');
        gateway.down = true;
        await press(pick(tree, 'Maja Moa'));
        expect(fake.pending('t-1')).toHaveLength(1);
        const postsBefore = gateway.to('POST', MARKS).length;

        await press(retract(tree, 'Maja Moa'));
        expect(foundHereRow(tree, 'Maja Moa')).toBeUndefined();
        expect(foundHereRow(tree, 'Maja Moa', true)).toBeUndefined();
        expect(fake.queue).toEqual([]);
        expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);

        gateway.down = false;
        await settle(RETRY_MS);
        expect(gateway.to('POST', MARKS).length).toBe(postsBefore);
        expect(sentMarks().filter((m) => m['studentId'] === 's22' && m['state'] === 'RETRACTED')).toEqual([]);
      });

      it('may be followed by finding the pupil again: the marks go in the order of the taps, and the pupil is found', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        tree = await render();
        gateway.down = true;
        await press(retract(tree, 'Åsa Lind'));
        expect(foundHereRow(tree, 'Åsa Lind')).toBeUndefined();
        gateway.down = false;
        await press(pressable(tree, BUTTON));
        await type(tree, 'åsa');
        await press(pick(tree, 'Åsa Lind'));
        await settle(RETRY_MS);
        expect(sentMarks().map((m) => [m['studentId'], m['state']])).toEqual([['s20', 'RETRACTED'], ['s20', 'FOUND']]);
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
        expect(fake.pending()).toEqual([]);
      });

      it('is not offered once the alarm has ended, and not for a list the phone built', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }], { endedAt: at('09:18'), foundFree: [foundWith('s30', 'Nils', 'Ek')] })]));
        tree = await render();
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
        expect(foundHereRow(tree, 'Nils Ek')).toBeDefined();
        expect(() => retract(tree!, 'Åsa Lind')).toThrow();
        expect(() => retract(tree!, 'Nils Ek')).toThrow();
        expect(gateway.to('POST', MARKS)).toEqual([]);
      });

      it('is told once, in words, and is no crash, when the gateway says there is nothing of the teacher’s to take back', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        gateway.marks = () => ({ status: 400, body: { message: 'Det finns inget att ta tillbaka.', code: 'CRISIS_MARK_INVALID' } });
        tree = await render();
        await press(retract(tree, 'Åsa Lind'));
        expect(hasText(tree, '1 markering skickades inte')).toBe(true);
        expect(fake.queue).toEqual([]);
        // The list is the gateway’s again: it still holds the pupil, as it said.
        expect(foundHereRow(tree, 'Åsa Lind')).toBeDefined();
      });

      it('is a tap target of at least 48 pt, named for the pupil', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        tree = await render();
        const button = retract(tree, 'Åsa Lind');
        expect((StyleSheet.flatten(button.props.style) as { minHeight?: number }).minHeight).toBeGreaterThanOrEqual(48);
        expect(button.props.accessibilityRole).toBe('button');
      });
    });

    describe('the hook behind the screen', () => {
      /** The state the screen is given, and a way to act on it as the screen does. */
      async function probe(): Promise<{ state: () => CrisisState }> {
        let latest!: CrisisState;
        const Probe = (): null => {
          latest = useCrisis(true);
          return null;
        };
        await act(async () => {
          tree = TestRenderer.create(<Probe />);
        });
        await settle();
        return { state: () => latest };
      }
      const theCall = (state: CrisisState) => state.blocks[0]!.calls[0]!;

      it('refuses to write "missing" for a pupil who is not on the call’s list, and writes "found" for them as found here', async () => {
        const { state } = await probe();
        await act(async () => state().mark(theCall(state()), 's20', 'MISSING'));
        expect(fake.queue).toEqual([]);
        expect(gateway.to('POST', MARKS)).toEqual([]);
        await act(async () => state().mark(theCall(state()), 's20', 'FOUND'));
        expect(fake.queue.map((row) => [row.studentId, row.state, row.callId])).toEqual([['s20', 'FOUND', 'c1']]);
      });

      it('writes nothing for a pupil already found with the teacher, and treats a pupil of the list as a tap on the list', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }])]));
        const { state } = await probe();
        await act(async () => state().markFoundHere({ call: theCall(state()) }, ASA));
        expect(fake.queue).toEqual([]);
        await act(async () => state().markFoundHere({ call: theCall(state()) }, other('s1', 'Anna', 'Andersson')));
        expect(fake.queue.map((row) => [row.studentId, row.state, row.callId])).toEqual([['s1', 'FOUND', 'c1']]);
      });

      it('does not say "found with me" on a list the phone built: its marks name a lesson, and there is no alarm to search', async () => {
        fake.lessons = [{ id: 'l1', startTime: at('09:00'), endTime: at('09:50'), subjectName: 'Matematik', roomName: 'B204', studentIds: ['s1'] }];
        fake.names.set('s1', 'Anna Andersson');
        fake.hint = { alarmAt: at('09:15'), endedAt: null };
        gateway.down = true;
        const { state } = await probe();
        expect(state().blocks[0]!.local).toBe(true);
        await act(async () => state().markFoundHere({ call: theCall(state()) }, ASA));
        await act(async () => state().markFoundHere({ alarmId: 'local' }, ASA));
        await act(async () => state().retractFoundHere({ alarmId: 'local' }, 's20'));
        expect(fake.queue).toEqual([]);
      });

      it('does not take anything back once the alarm has ended', async () => {
        serve(mineOf([alarm('a1', [{ ...sevenA(), foundHere: [foundWith('s20', 'Åsa', 'Lind', '7B')] }], { endedAt: at('09:18') })]));
        const { state } = await probe();
        await act(async () => state().retractFoundHere({ call: theCall(state()) }, 's20'));
        expect(fake.queue).toEqual([]);
      });
    });

    describe('what the gateway already holds', () => {
      it('shows the pupils it holds as found here, in Swedish order with their class, and waits on none of them', async () => {
        const held = sevenA();
        serve(mineOf([alarm('a1', [{ ...held, foundHere: [foundWith('s20', 'Örjan', 'Berg', '9A'), foundWith('s21', 'Åsa', 'Berg', '7B'), foundWith('s22', 'Anna', 'Berg')] }])]));
        tree = await render();
        expect(hasText(tree, 'Hittade hos dig (3)')).toBe(true);
        const names = texts(tree).filter((text) => text.endsWith(' Berg') && !text.startsWith('Bo'));
        expect(names).toEqual(['Anna Berg', 'Åsa Berg', 'Örjan Berg']);
        expect(foundHereRow(tree, 'Åsa Berg')).toBeDefined();
        expect(hasText(tree, '9A')).toBe(true);
        expect(texts(tree).some((text) => text.includes('väntar på nät'))).toBe(false);
      });

      it('draws no heading for a group, or an alarm, where nobody has been found', async () => {
        tree = await render();
        expect(texts(tree).some((text) => text.startsWith('Hittade hos dig') || text.startsWith('Hittade av dig'))).toBe(false);
      });

      it('reads a list from a gateway without `foundHere` and `foundFree` as it always was: no heading, the pupils as before', async () => {
        const old = JSON.parse(JSON.stringify(mineOf([alarm('a1', [sevenA()])]))) as { alarms: Array<{ foundFree?: unknown; calls: Array<{ foundHere?: unknown }> }> };
        delete old.alarms[0]!.foundFree;
        delete old.alarms[0]!.calls[0]!.foundHere;
        gateway.mine = () => ({ status: 200, body: old });
        tree = await render();
        expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
        expect(hasText(tree, '✓ Alla finns')).toBe(true);
        expect(texts(tree).some((text) => text.startsWith('Hittade'))).toBe(false);
      });
    });

    describe('a mark the gateway will not take', () => {
      it('is forgotten with a notice, the taps beside it are sent, and nothing crashes', async () => {
        gateway.marks = (marks) =>
          marks.some((m) => (m as { studentId?: string }).studentId === 's22')
            ? { status: 400, body: { message: 'Eleven står inte på gruppens lista.', code: 'CRISIS_MARK_INVALID' } }
            : take(marks);
        tree = await render();
        await press(found(tree, 'Anna Andersson'));
        await press(pressable(tree, BUTTON));
        await type(tree, 'maja');
        await press(pick(tree, 'Maja Moa'));

        expect(hasText(tree, '1 markering skickades inte')).toBe(true);
        expect(fake.queue.filter((row) => row.studentId === 's22')).toEqual([]);
        expect(foundHereRow(tree, 'Maja Moa')).toBeUndefined();
        expect(foundHereRow(tree, 'Maja Moa', true)).toBeUndefined();
        expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns');
        expect(fake.pending()).toEqual([]);
      });
    });
  });

  describe('a pupil the administration has marked not in the building', () => {
    const away = (): ReturnType<typeof call> =>
      call('c1', 'l1', [pupil('s1', 'Anna', 'Andersson', 'AWAY'), pupil('s2', 'Bo', 'Berg'), pupil('s3', 'Cia', 'Ceder', 'FOUND')]);

    it('shows as "Inte i huset", with its own glyph, its own figure, and never as found', async () => {
      serve(mineOf([alarm('a1', [away()])]));
      tree = await render();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte i huset');
      expect(texts(tree)).toContain('○ Inte i huset');
      for (const chip of ['✓ Finns 1', '○ Inte i huset 1', '? Inte markerade 1']) expect(texts(tree)).toContain(chip);
    });

    it('is not marked found by "Alla finns", which marks only the pupils nobody has marked', async () => {
      serve(mineOf([alarm('a1', [away()])]));
      tree = await render();
      await press(pressable(tree, t('crisis.allFoundA11y', { group: '7A · Matematik' })));
      expect(sentMarks()).toEqual([expect.objectContaining({ studentId: 's2', state: 'FOUND' })]);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte i huset');
    });

    it('is never offered to the teacher as something to say: the buttons are found and missing', async () => {
      serve(mineOf([alarm('a1', [away()])]));
      tree = await render();
      const labels = tree.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && typeof n.props.onPress === 'function').map((n) => n.props.accessibilityLabel as string);
      expect(labels.filter((label) => label.toLowerCase().includes('inte i huset'))).toEqual([]);
      // But a teacher who sees the pupil can still say they are found, as they can for one absent since before.
      await press(found(tree, 'Anna Andersson'));
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Finns');
    });

    it('is read from a gateway that does not count them as none, with the figures as before', async () => {
      const older = JSON.parse(JSON.stringify(mineOf([alarm('a1', [sevenA()])]))) as { alarms: Array<{ calls: Array<{ counts: Record<string, number> }> }> };
      delete older.alarms[0]!.calls[0]!.counts['away'];
      gateway.mine = () => ({ status: 200, body: older });
      tree = await render();
      for (const chip of ['✓ Finns 1', '✕ Saknas 1', '– Frånvarande 1', '? Inte markerade 2']) expect(texts(tree)).toContain(chip);
      expect(texts(tree).some((text) => text.includes('Inte i huset'))).toBe(false);
    });
  });

  describe('the group of pupils who are on no lesson', () => {
    const NO_LESSON = (): ReturnType<typeof call> =>
      call('c9', null, [pupil('s9', 'Siv', 'Sjö')], {
        basis: 'NO_LESSON',
        groupName: 'Utan lektion',
        subjectName: 'Ej i lektion',
        roomName: null,
        lessonStartsAt: at('09:05'),
        lessonEndsAt: at('09:05'),
      });

    it('is worded as "Ej i lektion just nu", with no lesson time and not the gateway’s Swedish stand-in', async () => {
      serve(mineOf([alarm('a1', [NO_LESSON()])]));
      tree = await render();
      expect(hasText(tree, t('crisis.noLesson'))).toBe(true);
      expect(hasText(tree, t('crisis.noLessonHint'))).toBe(true);
      expect(texts(tree).some((text) => text.includes('Utan lektion') || text === 'Ej i lektion')).toBe(false);
      expect(texts(tree).some((text) => text.includes('09:05–09:05'))).toBe(false);
      expect(rowLabel(tree, 'Siv Sjö')).toBe('Siv Sjö, Inte markerad');
    });

    it('is marked like any group, by its call', async () => {
      serve(mineOf([alarm('a1', [NO_LESSON()])]));
      tree = await render();
      await press(found(tree, 'Siv Sjö'));
      expect((gateway.to('POST', MARKS)[0]!.body as { marks: Array<{ callId: string }> }).marks[0]!.callId).toBe('c9');
    });

    it('is worded in English for an English reader', () => {
      const english = translatorFor('en');
      expect(callTitle({ basis: 'NO_LESSON', groupName: 'Utan lektion', subjectName: 'Ej i lektion' }, english)).toBe('Not in a lesson right now');
      expect(callTitle({ basis: 'LESSON', groupName: '7A', subjectName: 'Maths' }, english)).toBe('7A · Maths');
      expect(callTitle({ basis: 'NEXT_LESSON', groupName: '', subjectName: '' }, english)).toBe('Lesson');
    });

    it('does not fail on a basis from a gateway newer than this app: it is drawn as a lesson', async () => {
      serve(mineOf([alarm('a1', [call('c1', 'l1', [pupil('s1', 'Anna', 'Andersson')], { basis: 'SOMETHING_NEW' as never })])]));
      tree = await render();
      expect(hasText(tree, '7A · Matematik')).toBe(true);
    });
  });

  describe('a push that says an alarm began, and the gateway that knows better', () => {
    const lesson = { id: 'l1', startTime: at('09:00'), endTime: at('09:50'), subjectName: 'Matematik', roomName: 'B204', studentIds: ['s1', 's2'] };
    const alarmPush = (date: string) => ({ date: Date.parse(date), request: { content: { data: { notificationId: 'n', type: 'CRISIS_ALARM' } } } });

    beforeEach(() => {
      fake.lessons = [lesson];
      fake.names.set('s1', 'Anna Andersson');
      fake.names.set('s2', 'Bo Berg');
    });

    it('shows no list for a late push whose alarm has ended, only the alarm as the gateway shows it, and forgets the push', async () => {
      // The push in the tray was sent at 09:15 and is read at 09:20; the gateway says the alarm ended at 09:18.
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      serve(mineOf([alarm('a1', [sevenA()], { startedAt: at('09:14'), endedAt: at('09:18') })], at('09:19')));
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, 'Larmet är avslutat')).toBe(true);
      expect(fake.hint?.alarmAt ?? null).toBeNull();
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
      expect(found(tree, 'Anna Andersson').props.disabled).toBe(true);
    });

    it('shows no list at all for a late push when the gateway knows of no alarm', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      serve(mineOf([], at('09:19')));
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, t('crisis.emptyTitle'))).toBe(true);
      expect(fake.hint?.alarmAt ?? null).toBeNull();
    });

    it('does not show the phone’s own list while the gateway has not yet said whether the alarm is going, and not at all once it says it is over', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      // The screen’s own read fails (a patchy network); the question about the push is still in the air.
      const answer = deferred<{ status: number; body: unknown }>();
      let asked = 0;
      gateway.mine = () => (++asked === 1 ? 'network' : (answer.promise as never));
      tree = await render();
      expect(asked).toBe(2);
      expect(hasText(tree, t('crisis.noListTitle'))).toBe(true);
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(fake.hint).toBeNull();

      await act(async () => answer.resolve({ status: 200, body: mineOf([], at('09:19')) }));
      await settle();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(fake.hint?.alarmAt ?? null).toBeNull();
    });

    it('shows the phone’s own list as soon as the gateway cannot be asked after all', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      gateway.mine = () => 'network';
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(true);
    });

    it('shows the gateway’s list, not its own, when the alarm is going, and has it kept for the next time the network is gone', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      serve(mineOf([alarm('a1', [sevenA()], { startedAt: at('09:14') })], at('09:19')));
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
      expect(fake.lists.get('t-1')).toBeDefined();
      expect(fake.hint?.alarmAt).toBe(new Date(at('09:15')).toISOString());
    });

    it('keeps working with no network when the push is fresh: the list the phone builds, with how long ago the alarm was announced', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:15'))] as never);
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(true);
      expect(hasText(tree, 'Larmet meddelades kl 09:15 (för 5 min sedan)')).toBe(true);
      expect(rowLabel(tree, 'Anna Andersson')).toBe('Anna Andersson, Inte markerad');
    });

    it('believes no push sent more than a quarter of an hour ago when it cannot ask: no list is built from it', async () => {
      jest.mocked(getPresentedNotificationsAsync).mockResolvedValue([alarmPush(at('09:04'))] as never);
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, t('crisis.localList'))).toBe(false);
      expect(hasText(tree, t('crisis.noListTitle'))).toBe(true);
    });

    it('says how old a kept list is, in minutes and in hours', async () => {
      fake.lists.set('t-1', { asOf: at('09:19'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:19'))) });
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, 'Listan hämtades kl 09:19 (för 1 min sedan)')).toBe(true);
      await act(async () => tree!.unmount());
      fake.lists.set('t-1', { asOf: at('09:20'), payload: JSON.stringify(mineOf([alarm('a1', [sevenA()])], at('09:20'))) });
      tree = await render();
      expect(hasText(tree, 'Listan hämtades kl 09:20 (nyss)')).toBe(true);
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
