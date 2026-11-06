/**
 * Meddelanden (Kvittens), rendered whole with the gateway's two calls replaced.
 *
 * What is pinned is what a guardian sees and what the screen asks of the
 * gateway: the messages that concern their own children, newest first, with
 * the school's rule in words and never a word about the other guardian; one
 * button per message that cannot be pressed twice and closes while its
 * request is in the air; the card that turns into "Bekräftat <tid>"; an
 * offline phone told so and the button left to press again, with nothing
 * queued; a guardianship that has ended (409) or a message that is gone (404)
 * said kindly with the list read again; and what a screen reader is told.
 * Under TZ=UTC, so the instants read as written.
 */
import React from 'react';
import { AccessibilityInfo, AppState, Platform, RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import type { AckMine, ConfirmOutcome } from '../../services/acknowledgements';

let mockLocale: 'sv' | 'en' = 'sv';
let mockFocusEffect: (() => void | (() => void)) | null = null;

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
jest.mock('../../context/LocaleContext', () => {
  // One object per language, built in the factory: a new t per render would reload the screen without end.
  const catalogue = require('../../i18n');
  const sv = { t: catalogue.translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  const en = { t: catalogue.translatorFor('en'), locale: 'en', setLocale: jest.fn() };
  return { useI18n: () => (mockLocale === 'en' ? en : sv) };
});
jest.mock('../../services/acknowledgements', () => ({
  ...jest.requireActual('../../services/acknowledgements'),
  fetchMyAcks: jest.fn(),
  confirmAck: jest.fn(),
}));
jest.mock('../../services/coverRequests', () => ({
  ...jest.requireActual('../../services/coverRequests'),
  loadProblem: jest.fn(),
}));

import { confirmAck, fetchMyAcks } from '../../services/acknowledgements';
import { loadProblem } from '../../services/coverRequests';
import { AcknowledgementsScreen } from './AcknowledgementsScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const sv = translatorFor('sv');
const BUTTON = 'Jag har tagit del av detta';

const ack = (id: string, over: Partial<AckMine> = {}): AckMine => ({
  id,
  title: 'Utflykten är på torsdag',
  body: 'Ta med matsäck och regnkläder.',
  rule: 'ANY',
  authorName: 'Anna Lind',
  createdAt: '2026-10-13T07:00:00.000Z',
  children: [{ id: 'c-1', name: 'Alva Elev' }],
  ackedAt: null,
  ...over,
});

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);
const hasText = (tree: Tree, text: string): boolean => texts(tree).includes(text);

/** What a finger presses where each text `label` is: the nearest holder of an onPress. */
function touchables(tree: Tree, label: string): Instance[] {
  return tree.root
    .findAll((n) => isHostOf(n, 'Text') && textOf(n) === label)
    .map((node) => {
      for (let at: Instance | null = node; at; at = at.parent) {
        if (typeof at.props.onPress === 'function') return at;
      }
      throw new Error(`nothing to press holds "${label}"`);
    });
}

/** The one thing a finger presses where the text `label` is. */
function touchable(tree: Tree, label: string): Instance {
  const found = touchables(tree, label);
  if (found.length !== 1) throw new Error(`expected one "${label}" to press, found ${found.length}`);
  return found[0]!;
}

/** The nearest live region around a node, or null. */
function liveRegionAround(node: Instance): Instance | null {
  let at: Instance | null = node.parent;
  while (at && at.props.accessibilityLiveRegion !== 'polite') at = at.parent;
  return at;
}

const isInside = (outer: Instance, inner: Instance): boolean => {
  for (let at: Instance | null = inner.parent; at; at = at.parent) if (at === outer) return true;
  return false;
};

/** Every button that confirms, in the order the list shows them: the innermost holder of each press (a busy one shows a spinner, not its words). */
function buttons(tree: Tree): Instance[] {
  const holders = tree.root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button' && !isHostOf(n, 'View'),
  );
  return holders.filter((holder) => !holders.some((other) => other !== holder && isInside(holder, other)));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    tree = TestRenderer.create(<AcknowledgementsScreen />);
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

const read = (rows: AckMine[]) => jest.mocked(fetchMyAcks).mockResolvedValue(rows);
const confirmed = (at = '2026-10-13T08:00:00.000Z'): ConfirmOutcome => ({ kind: 'CONFIRMED', ackedAt: at });

let tree: Tree | null = null;

// The first render of the screen loads React Native's list stack (FlatList,
// VirtualizedList, the touchables), which took seconds on a cold cache; a test
// that times out is not stopped and its body runs into the next. So it is done
// once, before the tests, with an allowance of its own (ScheduleScreen.test).
beforeAll(async () => {
  read([ack('warm')]);
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  mockLocale = 'sv';
  mockFocusEffect = null;
  read([]);
  jest.mocked(confirmAck).mockResolvedValue(confirmed());
  jest.mocked(loadProblem).mockResolvedValue('FAILED');
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});

describe('AcknowledgementsScreen', () => {
  describe('the list', () => {
    it('draws a message with its title, sender and time, its text, the children it is about, the rule and one button', async () => {
      read([ack('a1', { children: [{ id: 'c-1', name: 'Alva Elev' }, { id: 'c-2', name: 'Bo Elev' }] })]);
      tree = await render();
      expect(hasText(tree, sv('acks.title'))).toBe(true);
      expect(hasText(tree, '1 meddelande väntar på din bekräftelse')).toBe(true);
      for (const text of [
        'Utflykten är på torsdag',
        'Från Anna Lind, tis 13 okt 07:00',
        'Ta med matsäck och regnkläder.',
        'Gäller: Alva Elev, Bo Elev',
        BUTTON,
      ]) {
        expect(texts(tree)).toContain(text);
      }
      expect(touchables(tree, BUTTON)).toHaveLength(1);
    });

    it('shows the messages in the order it is given, newest first', async () => {
      read([
        ack('new', { title: 'Beslutet om ledighet', createdAt: '2026-10-13T09:00:00.000Z' }),
        ack('old', { title: 'Utflykten är på torsdag', createdAt: '2026-10-01T09:00:00.000Z' }),
      ]);
      tree = await render();
      const titles = texts(tree).filter((text) => text === 'Beslutet om ledighet' || text === 'Utflykten är på torsdag');
      expect(titles).toEqual(['Beslutet om ledighet', 'Utflykten är på torsdag']);
    });

    it('counts the messages that wait, and says when none does', async () => {
      read([ack('a1'), ack('a2'), ack('a3', { ackedAt: '2026-10-13T08:00:00.000Z' })]);
      tree = await render();
      expect(hasText(tree, '2 meddelanden väntar på din bekräftelse')).toBe(true);
      await act(async () => tree?.unmount());
      read([ack('a3', { ackedAt: '2026-10-13T08:00:00.000Z' })]);
      tree = await render();
      expect(hasText(tree, sv('acks.subtitleNone'))).toBe(true);
    });

    it('says "all guardians" for the rule ALL and "one of you is enough" for ANY', async () => {
      read([ack('all', { rule: 'ALL', title: 'Beslutet' }), ack('any', { rule: 'ANY', title: 'Utflykten' })]);
      tree = await render();
      expect(hasText(tree, 'Skolan ber alla vårdnadshavare bekräfta')).toBe(true);
      expect(hasText(tree, 'Det räcker att en av er bekräftar')).toBe(true);
    });

    it('never says whether another guardian has confirmed, under either rule, confirmed or not', async () => {
      read([
        ack('a1', { rule: 'ALL' }),
        ack('a2', { rule: 'ANY' }),
        ack('a3', { rule: 'ALL', ackedAt: '2026-10-13T08:00:00.000Z' }),
        ack('a4', { rule: 'ANY', ackedAt: '2026-10-13T08:00:00.000Z' }),
      ]);
      tree = await render();
      const everything = texts(tree).join('|');
      expect(everything).not.toMatch(/den andra|andra vårdnadshavaren|annan vårdnadshavare|övriga|medförälder/i);
      expect(everything).not.toMatch(/other guardian|the other/i);
      // The rule is the school's request, in the words it was asked in.
      expect(everything).toContain('Skolan ber alla vårdnadshavare bekräfta');
    });

    it('words a sender-less message by the time it was sent', async () => {
      read([ack('a1', { authorName: '' })]);
      tree = await render();
      expect(hasText(tree, 'Skickat tis 13 okt 07:00')).toBe(true);
    });

    it('draws a message with no child in it without a line about children', async () => {
      read([ack('a1', { children: [] })]);
      tree = await render();
      expect(texts(tree).some((text) => text.startsWith('Gäller'))).toBe(false);
    });

    it('draws a message already confirmed as "Bekräftat <tid>" and without a button', async () => {
      read([ack('a1', { ackedAt: '2026-10-13T08:05:00.000Z' })]);
      tree = await render();
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:05')).toBe(true);
      expect(hasText(tree, BUTTON)).toBe(false);
    });

    it('says there is nothing, in words, when the school has asked for nothing', async () => {
      tree = await render();
      expect(hasText(tree, sv('acks.emptyTitle'))).toBe(true);
      expect(hasText(tree, sv('acks.emptyBody'))).toBe(true);
    });

    it('reads again on a pull, and on the tab gaining focus', async () => {
      tree = await render();
      expect(fetchMyAcks).toHaveBeenCalledTimes(1);
      read([ack('a1')]);
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(fetchMyAcks).toHaveBeenCalledTimes(2);
      expect(hasText(tree, BUTTON)).toBe(true);
      read([]);
      await act(async () => {
        mockFocusEffect?.();
      });
      await settle();
      expect(fetchMyAcks).toHaveBeenCalledTimes(3);
      expect(hasText(tree, BUTTON)).toBe(false);
    });

    it('reads again when the app returns to the front while the tab is open', async () => {
      tree = await render();
      // React Native's jest setup makes addEventListener a mock; the handler is the last one registered.
      const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1] as (state: string) => void;
      await act(async () => handler('background'));
      expect(fetchMyAcks).toHaveBeenCalledTimes(1);
      await act(async () => handler('active'));
      await settle();
      expect(fetchMyAcks).toHaveBeenCalledTimes(2);
    });

    it('speaks English to an English reader', async () => {
      mockLocale = 'en';
      read([ack('a1', { rule: 'ALL' }), ack('a2', { ackedAt: '2026-10-13T08:05:00.000Z' })]);
      tree = await render();
      for (const text of [
        '1 message is waiting for your confirmation',
        'From Anna Lind, Tue 13 Oct 07:00',
        'About: Alva Elev',
        'The school asks all guardians to confirm',
        'One of you is enough to confirm',
        'I have taken note of this',
        'Confirmed Tue 13 Oct 08:05',
      ]) {
        expect(texts(tree)).toContain(text);
      }
    });
  });

  describe('reads that overlap', () => {
    it('never lets an older answer arriving late replace a newer one', async () => {
      read([ack('a1', { title: 'Första' })]);
      tree = await render();
      const slow = deferred<AckMine[]>();
      jest.mocked(fetchMyAcks).mockReturnValueOnce(slow.promise);
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      read([ack('a2', { title: 'Andra' })]);
      await act(async () => {
        mockFocusEffect?.();
      });
      await settle();
      expect(hasText(tree, 'Andra')).toBe(true);
      await act(async () => slow.resolve([ack('a1', { title: 'Första' })]));
      await settle();
      expect(hasText(tree, 'Andra')).toBe(true);
      expect(hasText(tree, 'Första')).toBe(false);
    });

    it('lets go of a request that is still in the air when the screen is left, without touching the screen again', async () => {
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        read([ack('a1')]);
        tree = await render();
        const pending = deferred<ConfirmOutcome>();
        jest.mocked(confirmAck).mockReturnValueOnce(pending.promise);
        await press(touchable(tree, BUTTON));
        await act(async () => tree?.unmount());
        tree = null;
        await act(async () => pending.resolve(confirmed()));
        await settle();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });

  describe('when it cannot be read', () => {
    it('tells an offline phone so, in place of the list', async () => {
      jest.mocked(fetchMyAcks).mockRejectedValue(new TypeError('Network request failed'));
      jest.mocked(loadProblem).mockResolvedValue('OFFLINE');
      tree = await render();
      expect(hasText(tree, sv('acks.offlineTitle'))).toBe(true);
      expect(hasText(tree, sv('acks.problemOffline'))).toBe(true);
      expect(hasText(tree, sv('acks.emptyTitle'))).toBe(false);
    });

    it('says a read that failed otherwise, in place of the list', async () => {
      jest.mocked(fetchMyAcks).mockRejectedValue(new Error('HTTP 500'));
      tree = await render();
      expect(hasText(tree, sv('acks.failedTitle'))).toBe(true);
      expect(hasText(tree, sv('acks.problemFailed'))).toBe(true);
    });

    it('keeps the list it had and says it may be out of date when a later read fails offline', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(fetchMyAcks).mockRejectedValue(new TypeError('Network request failed'));
      jest.mocked(loadProblem).mockResolvedValue('OFFLINE');
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, sv('acks.problemOffline'))).toBe(true);
      expect(hasText(tree, BUTTON)).toBe(true);
    });

    it('keeps the list it had and says the update failed when a later read fails otherwise', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(fetchMyAcks).mockRejectedValue(new Error('HTTP 500'));
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, sv('acks.problemFailed'))).toBe(true);
      expect(hasText(tree, BUTTON)).toBe(true);
    });
  });

  describe('the tap', () => {
    it('confirms that message with the gateway, closes its button while the request is in the air, drops a second tap, and turns the card into "Bekräftat <tid>"', async () => {
      read([ack('a1'), ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      tree = await render();
      const pending = deferred<ConfirmOutcome>();
      jest.mocked(confirmAck).mockReturnValueOnce(pending.promise);
      const [first, second] = buttons(tree);
      await press(first!);

      expect(confirmAck).toHaveBeenCalledTimes(1);
      expect(confirmAck).toHaveBeenCalledWith('a1');
      // That message's button is closed and busy; the other message stays pressable.
      expect(first!.props.disabled).toBe(true);
      expect(first!.props.accessibilityState).toEqual({ disabled: true, busy: true });
      expect(second!.props.disabled).toBe(false);
      // A second tap that gets in before the render is dropped.
      await press(first!);
      expect(confirmAck).toHaveBeenCalledTimes(1);

      await act(async () => pending.resolve(confirmed('2026-10-13T08:00:00.000Z')));
      await settle();

      expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
      expect(touchables(tree, BUTTON)).toHaveLength(1);
      expect(hasText(tree, '1 meddelande väntar på din bekräftelse')).toBe(true);
      // The gateway has said all there is to say: the list is not read again.
      expect(fetchMyAcks).toHaveBeenCalledTimes(1);
    });

    it('can confirm two messages at once: one that hangs does not lock the other', async () => {
      read([ack('a1'), ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      tree = await render();
      const hanging = deferred<ConfirmOutcome>();
      jest.mocked(confirmAck).mockReturnValueOnce(hanging.promise);
      const [first, second] = buttons(tree);
      await press(first!);
      await press(second!);
      expect(confirmAck).toHaveBeenCalledTimes(2);
      expect(jest.mocked(confirmAck).mock.calls.map(([id]) => id)).toEqual(['a1', 'a2']);
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
      await act(async () => hanging.resolve(confirmed('2026-10-13T08:01:00.000Z')));
      await settle();
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:01')).toBe(true);
      expect(hasText(tree, sv('acks.subtitleNone'))).toBe(true);
    });

    it('is not undone by a read that was already on its way when the person tapped', async () => {
      read([ack('a1')]);
      tree = await render();
      // A pull whose answer is slow, and still says "not confirmed".
      const slow = deferred<AckMine[]>();
      jest.mocked(fetchMyAcks).mockReturnValueOnce(slow.promise);
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
      await act(async () => slow.resolve([ack('a1')]));
      await settle();
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
      expect(hasText(tree, BUTTON)).toBe(false);
    });

    it('tells an offline phone so, keeps the button pressable, queues nothing, and lets the person try again', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'OFFLINE' });
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, 'Det gick inte att bekräfta. Kontrollera nätet och försök igen.')).toBe(true);
      expect(touchable(tree, BUTTON).props.disabled).toBe(false);
      expect(touchable(tree, BUTTON).props.accessibilityState).toEqual({ disabled: false, busy: false });
      expect(fetchMyAcks).toHaveBeenCalledTimes(1);

      await press(touchable(tree, BUTTON));
      expect(confirmAck).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
      expect(hasText(tree, 'Det gick inte att bekräfta. Kontrollera nätet och försök igen.')).toBe(false);
    });

    it('says a failure, and lets the person try again', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'FAILED' });
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, sv('acks.failed'))).toBe(true);
      expect(touchable(tree, BUTTON).props.disabled).toBe(false);
    });

    it('says a refusal for someone who is not a guardian, and leaves the button', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'NOT_GUARDIAN' });
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, sv('acks.notGuardian'))).toBe(true);
      expect(touchable(tree, BUTTON).props.disabled).toBe(false);
    });

    it('says kindly that the message no longer concerns the guardian (409), reads the list again, and the card is gone', async () => {
      read([ack('a1'), ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'ENDED' });
      read([ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      await press(buttons(tree)[0]!);
      expect(hasText(tree, 'Meddelandet gäller inte längre dig, så du behöver inte bekräfta det.')).toBe(true);
      expect(fetchMyAcks).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Utflykten är på torsdag')).toBe(false);
      expect(hasText(tree, 'Beslutet om ledighet')).toBe(true);
      // The sentence is not an error: nothing is announced as an alert, and it clears on the next visit.
      read([ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      await act(async () => {
        mockFocusEffect?.();
      });
      await settle();
      expect(hasText(tree, 'Meddelandet gäller inte längre dig, så du behöver inte bekräfta det.')).toBe(false);
    });

    it('says that a message that is gone is gone (404) and reads the list again', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'GONE' });
      read([]);
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, sv('acks.gone'))).toBe(true);
      expect(fetchMyAcks).toHaveBeenCalledTimes(2);
      expect(hasText(tree, BUTTON)).toBe(false);
    });

    it('keeps the sentence above the list even when the list cannot be read again', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'ENDED' });
      jest.mocked(fetchMyAcks).mockRejectedValue(new TypeError('Network request failed'));
      jest.mocked(loadProblem).mockResolvedValue('OFFLINE');
      await press(touchable(tree, BUTTON));
      expect(hasText(tree, sv('acks.custodyEnded'))).toBe(true);
      expect(hasText(tree, sv('acks.problemOffline'))).toBe(true);
    });
  });

  describe('what a screen reader is told', () => {
    it('gives each button the role of a button, a name that says which message it confirms, and its state', async () => {
      read([ack('a1'), ack('a2', { title: 'Beslutet om ledighet', createdAt: '2026-10-12T07:00:00.000Z' })]);
      tree = await render();
      const [first, second] = buttons(tree);
      expect(first!.props.accessibilityRole).toBe('button');
      expect(first!.props.accessibilityLabel).toBe('Bekräfta att du har tagit del av meddelandet Utflykten är på torsdag');
      expect(second!.props.accessibilityLabel).toBe('Bekräfta att du har tagit del av meddelandet Beslutet om ledighet');
      expect(first!.props.accessibilityState).toEqual({ disabled: false, busy: false });
    });

    it('names a confirmed message and when, as one thing, and marks the glyph as decoration', async () => {
      read([ack('a1', { ackedAt: '2026-10-13T08:05:00.000Z' })]);
      tree = await render();
      const line = tree.root.find((n) => n.props.accessibilityLabel === 'Meddelandet Utflykten är på torsdag är bekräftat tis 13 okt 08:05');
      expect(line.props.accessible).toBe(true);
      const glyph = tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === '✓');
      expect(glyph.props.accessibilityElementsHidden).toBe(true);
    });

    it('marks each title and the screen’s own as a header', async () => {
      read([ack('a1')]);
      tree = await render();
      const headers = tree.root.findAll((n) => isHostOf(n, 'Text') && n.props.accessibilityRole === 'header').map(textOf);
      expect(headers).toEqual([sv('acks.title'), 'Utflykten är på torsdag']);
    });

    it('keeps the button’s place in a live region, so what it turns into is read out on Android', async () => {
      read([ack('a1')]);
      tree = await render();
      const button = touchable(tree, BUTTON);
      const region = liveRegionAround(button);
      expect(region).not.toBeNull();
      await press(button);
      const line = tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === 'Bekräftat tis 13 okt 08:00');
      // The same region, still mounted, now holding the confirmation.
      expect(liveRegionAround(line)).toBe(region);
    });

    it('announces a confirmation on iOS, which has no live regions, and only a confirmation', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'OFFLINE' });
      await press(touchable(tree, BUTTON));
      expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
      await press(touchable(tree, BUTTON));
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Du har bekräftat meddelandet Utflykten är på torsdag');
    });

    it('does not announce on Android as well: the live region says it, and saying it twice would be noise', async () => {
      const spy = jest.replaceProperty(Platform, 'OS', 'android');
      try {
        read([ack('a1')]);
        tree = await render();
        await press(touchable(tree, BUTTON));
        expect(hasText(tree, 'Bekräftat tis 13 okt 08:00')).toBe(true);
        expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
      } finally {
        spy.restore();
      }
    });

    it('reads a failure as a live region too, so a screen reader hears that the tap did not go through', async () => {
      read([ack('a1')]);
      tree = await render();
      jest.mocked(confirmAck).mockResolvedValueOnce({ kind: 'OFFLINE' });
      await press(touchable(tree, BUTTON));
      const note = tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === sv('acks.offline'));
      expect(liveRegionAround(note)).not.toBeNull();
    });
  });
});
