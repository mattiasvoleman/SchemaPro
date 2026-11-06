/**
 * The administrator's side of an alarm, rendered whole against a stubbed
 * gateway: starting one (a real one asks twice), what the gateway answers
 * when it refuses, the roll call as it comes in (groups done, teachers who
 * have not answered by name, pupils missing), the poll every five seconds and
 * the read at crisis_updated, and ending it. Nothing here is queued: a phone
 * with no network is told so. Under TZ=UTC and a pinned clock.
 */
import React from 'react';
import { Alert, AppState, RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import { alarm, at, callView, detailOf, gateway, pupil, summary } from '../../services/__testing__/crisisGateway';
import { POLL_MS } from '../../hooks/useCrisisAdmin';
import type { AlarmDetail, AlarmSummary } from '../../services/crisis';

let mockRole = 'SCHOOL_ADMIN';
let mockFocusEffect: (() => void | (() => void)) | null = null;
let mockCrisisUpdate: { alarmId: string; changedAt: string } | null = null;

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockFocusEffect = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: 'admin-1', role: mockRole }, isLoading: false }),
}));
jest.mock('../../context/LocaleContext', () => {
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../context/SyncContext', () => ({ useSync: () => ({ crisisUpdate: mockCrisisUpdate }) }));
// The teacher's half of the screen is imported with it and is not under test here: its push and database are doubles.
jest.mock('expo-notifications', () => ({ getPresentedNotificationsAsync: jest.fn(async () => []) }));
jest.mock('../../services/database/localDatabase', () => require('../../services/__testing__/crisisDatabase').api);
jest.mock('../../services/supabase', () => ({ getAccessToken: jest.fn(async () => 'token'), getSupabase: jest.fn() }));
jest.mock('../../services/network/deviceOffline', () => ({
  deviceOffline: jest.fn(async () => false),
  noNetwork: jest.fn(async () => false),
}));

import { CrisisScreen } from './CrisisScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');
const NOW = new Date(at('09:20'));
const ALARMS = '/api/v1/crisis/alarms';

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);
const hasText = (tree: Tree, text: string): boolean => texts(tree).includes(text);

/** The one thing a finger presses where the text `label` is: the nearest holder of an onPress. */
function touchable(tree: Tree, label: string): Instance {
  const found = tree.root
    .findAll((n) => isHostOf(n, 'Text') && textOf(n) === label)
    .map((node) => {
      for (let at: Instance | null = node; at; at = at.parent) {
        if (typeof at.props.onPress === 'function') return at;
      }
      throw new Error(`nothing to press holds "${label}"`);
    });
  if (found.length !== 1) throw new Error(`expected one "${label}" to press, found ${found.length}`);
  return found[0]!;
}

/** A choice of the start form (a radio), by its words, whether it is chosen or not. */
function choice(tree: Tree, words: string): Instance {
  const found = tree.root.findAll(
    (n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function' && textOf(n.findAll((c) => isHostOf(c, 'Text'))[0]!).replace('✓ ', '') === words,
  );
  if (found.length === 0) throw new Error(`no choice "${words}"`);
  return found[0]!;
}

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

const REAL_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime'] as const;
function dateOnly(): void {
  fullFake = false;
  jest.useFakeTimers({ now: NOW, doNotFake: [...REAL_TIMERS] });
}
function allTimers(): void {
  fullFake = true;
  jest.useFakeTimers({ now: NOW });
}

/** The school's open alarms as the gateway holds them: what start and end change. */
let held: AlarmDetail[];
function hold(...alarms: AlarmDetail[]): void {
  held = alarms;
  gateway.alarms = () => ({ status: 200, body: held.map((d) => d.alarm) });
  gateway.detail = (id) => {
    const found = held.find((d) => d.alarm.id === id);
    return found ? { status: 200, body: found } : { status: 404, body: { message: 'x', code: 'CRISIS_ALARM_NOT_FOUND' } };
  };
}

const going = (over: Partial<AlarmSummary> = {}): AlarmDetail => {
  const teacher = (name: string, answeredAt: string | null) => ({ userId: `u-${name}`, name, role: 'LEAD' as const, answeredAt });
  return detailOf(summary('a1', over), [
    callView('c1', '7A', [pupil('s1', 'Anna', 'Andersson', 'FOUND'), pupil('s2', 'Eva', 'Ek', 'MISSING'), pupil('s3', 'Bo', 'Berg')], {
      teachers: [teacher('Anna Lind', null), teacher('Olof Ek', at('09:08'))],
    }),
    callView('c2', '8B', [pupil('s4', 'Cia', 'Ceder'), pupil('s5', 'Dan', 'Dahl', 'ABSENT_BEFORE')], { teachers: [teacher('Anna Lind', null)] }),
    callView('c3', '9C', [pupil('s6', 'Fia', 'Falk')], { uncovered: true }),
  ]);
};

let tree: Tree | null = null;

beforeAll(async () => {
  gateway.install();
  hold(going());
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  dateOnly();
  gateway.install();
  mockRole = 'SCHOOL_ADMIN';
  mockFocusEffect = null;
  mockCrisisUpdate = null;
  hold();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const blur of blurs.splice(0)) blur();
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

/** The buttons of the last Alert.alert, by their words. */
function alertButtons(): Array<{ text?: string; style?: string; onPress?: () => void }> {
  return (jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as never;
}

describe('CrisisScreen, the administration’s side', () => {
  describe('starting an alarm', () => {
    it('offers a drill, an evacuation, by default; reads the school’s open alarms and nothing of the teacher’s', async () => {
      tree = await render();
      expect(hasText(tree, t('crisis.admin.startTitle'))).toBe(true);
      expect(choice(tree, 'Utrymning').props.accessibilityState).toEqual({ selected: true });
      expect(choice(tree, 'Inrymning').props.accessibilityState).toEqual({ selected: false });
      expect(choice(tree, 'Övning').props.accessibilityState).toEqual({ selected: true });
      expect(choice(tree, 'Skarpt larm').props.accessibilityState).toEqual({ selected: false });
      expect(hasText(tree, 'Starta övning')).toBe(true);
      expect(hasText(tree, t('crisis.admin.modeDrillHint'))).toBe(true);
      expect(gateway.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${ALARMS}?limit=5`]);
    });

    it('starts a drill with a tap, on the kind and the mode chosen, and shows the alarm that is then going', async () => {
      tree = await render();
      gateway.start = () => {
        hold(going());
        return { status: 201, body: going() };
      };
      await press(choice(tree, 'Inrymning'));
      await press(touchable(tree, 'Starta övning'));

      expect(gateway.to('POST', ALARMS).map((c) => c.body)).toEqual([{ kind: 'LOCKDOWN', mode: 'DRILL' }]);
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(hasText(tree, t('crisis.admin.groupsDone', { done: 1, total: 2 }))).toBe(true);
    });

    it('asks twice for a real one: the mode is chosen, then confirmed, and only the confirmation starts it', async () => {
      tree = await render();
      gateway.start = () => {
        hold(going({ mode: 'LIVE' }));
        return { status: 201, body: going() };
      };
      await press(choice(tree, 'Skarpt larm'));
      expect(hasText(tree, 'Starta skarpt larm')).toBe(true);
      expect(hasText(tree, t('crisis.admin.modeLiveHint'))).toBe(true);
      expect(hasText(tree, 'Starta övning')).toBe(false);

      await press(touchable(tree, 'Starta skarpt larm'));
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      expect(jest.mocked(Alert.alert).mock.calls[0]![0]).toBe('Starta skarpt larm?');
      expect(jest.mocked(Alert.alert).mock.calls[0]![1]).toBe(t('crisis.admin.confirmLiveBody'));
      expect(alertButtons().map((b) => [b.text, b.style])).toEqual([
        ['Avbryt', 'cancel'],
        ['Starta skarpt larm', 'destructive'],
      ]);
      // Nothing has been sent yet.
      expect(gateway.to('POST', ALARMS)).toEqual([]);

      await act(async () => alertButtons()[1]!.onPress!());
      await settle();
      expect(gateway.to('POST', ALARMS).map((c) => c.body)).toEqual([{ kind: 'EVACUATION', mode: 'LIVE' }]);
    });

    it('sends nothing for a real alarm that is cancelled', async () => {
      tree = await render();
      await press(choice(tree, 'Skarpt larm'));
      await press(touchable(tree, 'Starta skarpt larm'));
      // The cancel button has no handler: the dialog closes.
      expect(alertButtons()[0]!.onPress).toBeUndefined();
      expect(gateway.to('POST', ALARMS)).toEqual([]);
    });

    it('is one start at a time: the buttons are off while it is in the air, and a second tap is dropped', async () => {
      tree = await render();
      const answer = deferred<{ status: number; body: unknown }>();
      gateway.start = () => answer.promise as never;
      const start = touchable(tree, 'Starta övning');
      await press(start);
      expect(gateway.to('POST', ALARMS)).toHaveLength(1);
      expect(start.props.disabled).toBe(true);
      await press(start);
      expect(gateway.to('POST', ALARMS)).toHaveLength(1);
      await act(async () => answer.resolve({ status: 201, body: going() }));
      await settle();
      expect(touchable(tree, 'Starta övning').props.disabled).toBe(false);
    });
  });

  describe('when the gateway refuses', () => {
    it('says, in words, that the role may not start an alarm (CRISIS_NOT_YOURS)', async () => {
      tree = await render();
      gateway.start = () => ({ status: 403, body: { message: 'Din roll får inte starta larm.', code: 'CRISIS_NOT_YOURS' } });
      await press(touchable(tree, 'Starta övning'));
      expect(hasText(tree, 'Din roll får inte starta larm. Rektor bestämmer vilka som får det, under Krisläge.')).toBe(true);
    });

    it.each([
      ['a drill', 'Starta övning', undefined, 'En övning pågår redan.'],
      ['a live alarm', 'Starta skarpt larm', 'Skarpt larm', 'Ett skarpt larm pågår redan.'],
    ])('says that %s is already going (CRISIS_ALARM_OPEN), and shows it, whether the gateway named it or not', async (_name, button, mode, words) => {
      for (const body of [
        { message: 'x', code: 'CRISIS_ALARM_OPEN', params: { alarmId: 'a1' } },
        // The loser of a race cannot know the id yet: no params.
        { message: 'x', code: 'CRISIS_ALARM_OPEN' },
      ]) {
        tree = await render();
        gateway.start = () => {
          hold(going());
          return { status: 409, body };
        };
        if (mode) await press(choice(tree, mode));
        await press(touchable(tree, button));
        if (mode) await act(async () => alertButtons()[1]!.onPress!());
        await settle();
        expect(hasText(tree, words)).toBe(true);
        // The alarm that is going is read, not looked up by the id the answer may not have.
        expect(hasText(tree, t('crisis.admin.groupsDone', { done: 1, total: 2 }))).toBe(true);
        await act(async () => tree?.unmount());
        hold();
      }
    });

    it('says there is no network when the request never got there', async () => {
      tree = await render();
      gateway.start = () => 'network';
      await press(touchable(tree, 'Starta övning'));
      expect(hasText(tree, 'Inget nät. Larmet startades inte.')).toBe(true);
    });

    it('says a failure otherwise, and a new tap clears it', async () => {
      tree = await render();
      gateway.start = () => ({ status: 500, body: { message: 'x' } });
      await press(touchable(tree, 'Starta övning'));
      expect(hasText(tree, 'Larmet gick inte att starta. Försök igen.')).toBe(true);
      gateway.start = () => ({ status: 201, body: going() });
      await press(touchable(tree, 'Starta övning'));
      expect(hasText(tree, 'Larmet gick inte att starta. Försök igen.')).toBe(false);
    });
  });

  describe('the roll call of an alarm that is going', () => {
    beforeEach(() => hold(going()));

    it('says what it is and who started it, how far the groups are, how many teachers have answered, and the counts', async () => {
      tree = await render();
      expect(hasText(tree, 'Utrymning – skarpt larm')).toBe(true);
      expect(hasText(tree, 'Startades av Rita Rektor kl 09:05')).toBe(true);
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(true);
      expect(hasText(tree, '2 av 3 lärare har svarat')).toBe(true);
      for (const chip of ['✓ Finns 2', '✕ Saknas 1', '– Frånvarande 1', '? Inte markerade 2']) expect(texts(tree)).toContain(chip);
    });

    it('names the pupils who are missing, with their group', async () => {
      tree = await render();
      expect(hasText(tree, t('crisis.admin.missingTitle'))).toBe(true);
      expect(hasText(tree, '✕ Eva Ek (7A)')).toBe(true);
    });

    it('says when nobody is', async () => {
      hold(detailOf(summary('a1'), [callView('c1', '7A', [pupil('s1', 'Anna', 'Andersson', 'FOUND')])]));
      tree = await render();
      expect(hasText(tree, t('crisis.admin.noneMissing'))).toBe(true);
      expect(hasText(tree, t('crisis.admin.allAnswered'))).toBe(true);
    });

    it('names the teachers who have not answered, with their groups, and not those who have', async () => {
      tree = await render();
      expect(hasText(tree, t('crisis.admin.silentTitle'))).toBe(true);
      expect(hasText(tree, 'Anna Lind (7A, 8B)')).toBe(true);
      expect(texts(tree).some((text) => text.startsWith('Olof Ek'))).toBe(false);
    });

    it('says how many groups nobody answers for', async () => {
      tree = await render();
      expect(hasText(tree, t('crisis.admin.uncovered', { count: 1 }))).toBe(true);
    });

    it('draws a drill as a drill, and says "Avsluta övningen"', async () => {
      hold(going({ mode: 'DRILL', kind: 'LOCKDOWN' }));
      tree = await render();
      expect(hasText(tree, 'ÖVNING – Inrymning')).toBe(true);
      expect(hasText(tree, 'Avsluta övningen')).toBe(true);
    });

    it('reads again every five seconds while an alarm is going, and not when none is', async () => {
      allTimers();
      tree = await render();
      const reads = () => gateway.to('GET', `${ALARMS}/a1`).length;
      expect(reads()).toBe(1);
      hold(going({ teachersAnswered: 3, callsComplete: 2 }));
      await settle(POLL_MS);
      expect(reads()).toBe(2);
      expect(hasText(tree, '2 av 2 grupper klara')).toBe(true);
      await settle(POLL_MS);
      expect(reads()).toBe(3);

      hold();
      await settle(POLL_MS);
      const lists = gateway.to('GET', `${ALARMS}?limit=5`).length;
      await settle(POLL_MS * 3);
      expect(gateway.to('GET', `${ALARMS}?limit=5`).length).toBe(lists);
      expect(hasText(tree, t('crisis.admin.startTitle'))).toBe(true);
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(false);
    });

    it('reads again when the gateway says an alarm began or ended, on a pull, on focus and when the app returns', async () => {
      tree = await render();
      const lists = () => gateway.to('GET', `${ALARMS}?limit=5`).length;
      expect(lists()).toBe(1);
      mockCrisisUpdate = { alarmId: 'a1', changedAt: at('09:21') };
      await act(async () => {
        tree!.update(<CrisisScreen />);
      });
      await settle();
      expect(lists()).toBe(2);
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(lists()).toBe(3);
      await refocus();
      expect(lists()).toBe(4);
      const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1] as (state: string) => void;
      await act(async () => handler('active'));
      await settle();
      expect(lists()).toBe(5);
    });

    it('keeps the roll call it had when a read fails, and says it may be old', async () => {
      tree = await render();
      gateway.down = true;
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(true);
      expect(hasText(tree, t('crisis.admin.updateFailed'))).toBe(true);
    });
  });

  describe('ending it', () => {
    beforeEach(() => hold(going()));

    it('asks first, and only the confirmation ends the alarm, on that alarm', async () => {
      tree = await render();
      gateway.end = () => {
        hold();
        return { status: 200, body: going({ endedAt: at('09:21') }) };
      };
      await press(touchable(tree, 'Avsluta larmet'));
      expect(jest.mocked(Alert.alert).mock.calls[0]![0]).toBe('Avsluta larmet?');
      expect(gateway.to('POST', `${ALARMS}/a1/end`)).toEqual([]);

      await act(async () => alertButtons()[1]!.onPress!());
      await settle();
      expect(gateway.to('POST', `${ALARMS}/a1/end`)).toHaveLength(1);
      // The roll call is gone and the form to start another is there.
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(false);
      expect(hasText(tree, t('crisis.admin.startTitle'))).toBe(true);
    });

    it('asks about a drill as a drill', async () => {
      hold(going({ mode: 'DRILL' }));
      tree = await render();
      await press(touchable(tree, 'Avsluta övningen'));
      expect(jest.mocked(Alert.alert).mock.calls[0]![0]).toBe('Avsluta övningen?');
    });

    it('says that an alarm already over was over, and reads the list again', async () => {
      tree = await render();
      gateway.end = () => {
        hold();
        return { status: 409, body: { message: 'x', code: 'CRISIS_ALARM_ENDED' } };
      };
      await press(touchable(tree, 'Avsluta larmet'));
      await act(async () => alertButtons()[1]!.onPress!());
      await settle();
      expect(hasText(tree, 'Larmet var redan avslutat.')).toBe(true);
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(false);
    });

    it.each([
      ['no network', 'network' as const, 'Inget nät. Larmet avslutades inte.'],
      ['a failure', { status: 500, body: { message: 'x' } }, 'Larmet gick inte att avsluta. Försök igen.'],
    ])('says %s, and keeps the alarm', async (_name, answer, words) => {
      tree = await render();
      gateway.end = () => answer;
      await press(touchable(tree, 'Avsluta larmet'));
      await act(async () => alertButtons()[1]!.onPress!());
      await settle();
      expect(hasText(tree, words)).toBe(true);
      expect(hasText(tree, '1 av 2 grupper klara')).toBe(true);
    });
  });

  describe('with no network', () => {
    it('says so in place of the form, since an alarm is started and ended only live', async () => {
      gateway.down = true;
      tree = await render();
      expect(hasText(tree, t('crisis.admin.offlineBody'))).toBe(true);
    });

    it('says a failed read otherwise', async () => {
      gateway.alarms = () => ({ status: 500, body: { message: 'x' } });
      tree = await render();
      expect(hasText(tree, t('crisis.admin.loadFailedTitle'))).toBe(true);
    });
  });
});
