/**
 * The Notiser tab, rendered whole with the inbox read replaced.
 *
 * What is pinned is what the inbox does with a row: every row is worded in
 * the reader's language, and a guardian's row that asks them to confirm a
 * message (Kvittens: ACK_REQUESTED and its reminder ACK_REMINDER) is a button
 * that opens the Meddelanden tab, where the other rows are plain text that
 * goes nowhere; and that the inbox is read again when the tab gains focus (a
 * confirmation in Meddelanden reads that message's notices in the database).
 * Under TZ=UTC, so the instants read as written.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import type { NotificationRow, NotificationType } from '../../types';

let mockRole: string | null = 'GUARDIAN';
let mockFocusEffect: (() => void | (() => void)) | null = null;
const mockPush = jest.fn();

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  // As a focused tab: the effect runs on mount; the test can run it again, as the tab gaining focus does.
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockFocusEffect = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: 'u1', role: mockRole }, isLoading: false }),
}));
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload the screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../services/notifications', () => ({
  fetchNotifications: jest.fn(),
  markAllRead: jest.fn(),
}));

import { fetchNotifications, markAllRead } from '../../services/notifications';
import { NotificationsScreen } from './NotificationsScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');

const row = (id: string, type: NotificationType, meta: Record<string, unknown> | null, readAt: string | null = null): NotificationRow => ({
  id,
  type,
  meta,
  readAt,
  createdAt: '2026-10-13T07:00:00.000Z',
});

const ASKED = row('n1', 'ACK_REQUESTED', { requestId: 'r-1', title: 'Utflykten är på torsdag' });
const REMINDED = row('n2', 'ACK_REMINDER', { requestId: 'r-1', title: 'Utflykten är på torsdag' });
const CONSENT_META = { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06' };
const CONSENT_ASKED = row('n4', 'LEAVE_CONSENT_REQUESTED', CONSENT_META);
const CONSENT_REMINDED = row('n5', 'LEAVE_CONSENT_REMINDER', CONSENT_META);
const CONSENT_REFUSED = row('n6', 'LEAVE_CONSENT_REFUSED', CONSENT_META);
const LEAVE = row('n3', 'LEAVE_DECIDED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06', status: 'APPROVED' });

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);

/** The one thing a finger presses where the text `label` is, or null when the row is plain text. */
function pressableAt(tree: Tree, label: string): Instance | null {
  const [node, ...more] = tree.root.findAll((n) => isHostOf(n, 'Text') && textOf(n) === label);
  if (!node || more.length > 0) throw new Error(`expected one "${label}", found ${more.length + (node ? 1 : 0)}`);
  for (let at: Instance | null = node; at; at = at.parent) {
    if (typeof at.props.onPress === 'function') return at;
  }
  return null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(<NotificationsScreen />);
  });
  await settle();
  return tree;
}

const read = (rows: NotificationRow[]) => jest.mocked(fetchNotifications).mockResolvedValue(rows);

let tree: Tree | null = null;

// The first render loads React Native's list stack, which took seconds on a
// cold cache; done once, before the tests, with an allowance of its own.
beforeAll(async () => {
  read([LEAVE]);
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  mockRole = 'GUARDIAN';
  mockFocusEffect = null;
  read([]);
  jest.mocked(markAllRead).mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});

describe('NotificationsScreen', () => {
  it('says there is nothing when there is nothing', async () => {
    tree = await render();
    expect(texts(tree)).toContain(t('notifications.empty'));
  });

  it('words each row in the reader’s language, with the time it was written', async () => {
    read([ASKED, LEAVE]);
    tree = await render();
    expect(texts(tree)).toEqual(
      expect.arrayContaining([
        'Skolan ber dig bekräfta: Utflykten är på torsdag',
        'Ledighet för Alva Elev (2026-11-02 – 2026-11-06) beviljades.',
        'tis 13 okt 07:00',
      ]),
    );
  });

  it('reads the inbox again when the tab gains focus, so a notice read since is no longer marked unread', async () => {
    read([ASKED]);
    tree = await render();
    expect(fetchNotifications).toHaveBeenCalledTimes(1);
    expect(texts(tree)).toContain(t('notifications.unread', { count: 1 }));
    read([row('n1', 'ACK_REQUESTED', ASKED.meta, '2026-10-13T08:00:00.000Z')]);
    await act(async () => {
      mockFocusEffect?.();
    });
    await settle();
    expect(fetchNotifications).toHaveBeenCalledTimes(2);
    expect(texts(tree)).not.toContain(t('notifications.unread', { count: 1 }));
  });

  it('counts the unread rows and marks them all read', async () => {
    read([ASKED, row('n4', 'LEAVE_DECIDED', LEAVE.meta, '2026-10-13T08:00:00.000Z')]);
    tree = await render();
    expect(texts(tree)).toContain(t('notifications.unread', { count: 1 }));
    const mark = pressableAt(tree, t('notifications.markAllRead'))!;
    await act(async () => {
      mark.props.onPress();
    });
    await settle();
    expect(markAllRead).toHaveBeenCalledWith('u1');
    expect(fetchNotifications).toHaveBeenCalledTimes(2);
  });

  describe('a guardian’s Kvittens rows', () => {
    it.each([
      ['ACK_REQUESTED', ASKED, 'Skolan ber dig bekräfta: Utflykten är på torsdag'],
      ['ACK_REMINDER', REMINDED, 'Påminnelse: skolan väntar på din bekräftelse av Utflykten är på torsdag'],
    ])('open the Meddelanden tab when %s is tapped', async (_type, entry, words) => {
      read([entry]);
      tree = await render();
      const button = pressableAt(tree, words)!;
      expect(button).not.toBeNull();
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityHint).toBe(t('acks.openHint'));
      await act(async () => {
        button.props.onPress();
      });
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/(guardian)/acknowledgements');
    });

    it('are the only rows that go anywhere', async () => {
      read([ASKED, LEAVE]);
      tree = await render();
      expect(pressableAt(tree, 'Ledighet för Alva Elev (2026-11-02 – 2026-11-06) beviljades.')).toBeNull();
      expect(pressableAt(tree, 'Skolan ber dig bekräfta: Utflykten är på torsdag')).not.toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('a guardian’s rows about consent to a leave request (Ledighetspolicy)', () => {
    it.each([
      ['LEAVE_CONSENT_REQUESTED', CONSENT_ASKED, 'Ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) väntar på ditt samtycke.'],
      ['LEAVE_CONSENT_REMINDER', CONSENT_REMINDED, 'Påminnelse: ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) väntar fortfarande på ditt samtycke.'],
      ['LEAVE_CONSENT_REFUSED', CONSENT_REFUSED, 'Ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) har avslutats, eftersom en vårdnadshavare inte samtyckte.'],
    ])('open the Ledighet tab when %s is tapped', async (_type, entry, words) => {
      read([entry]);
      tree = await render();
      const button = pressableAt(tree, words)!;
      expect(button).not.toBeNull();
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityHint).toBe(t('leave.openHint'));
      expect(button.props.accessibilityHint).toBe('Öppnar Ledighet');
      await act(async () => {
        button.props.onPress();
      });
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/(guardian)/leave');
    });

    it('leave a Kvittens row going to Meddelanden, and the decision of a request plain text', async () => {
      read([ASKED, CONSENT_ASKED, LEAVE]);
      tree = await render();
      const ack = pressableAt(tree, 'Skolan ber dig bekräfta: Utflykten är på torsdag')!;
      expect(ack.props.accessibilityHint).toBe(t('acks.openHint'));
      await act(async () => {
        ack.props.onPress();
      });
      expect(mockPush).toHaveBeenLastCalledWith('/(guardian)/acknowledgements');
      expect(pressableAt(tree, 'Ledighet för Alva Elev (2026-11-02 – 2026-11-06) beviljades.')).toBeNull();
    });

    it.each(['TEACHER', 'SCHOOL_ADMIN', 'STUDENT', null])('are plain text for %s, who has no Ledighet tab to answer in', async (role) => {
      mockRole = role;
      read([CONSENT_ASKED, CONSENT_REMINDED, CONSENT_REFUSED]);
      tree = await render();
      for (const entry of [CONSENT_ASKED, CONSENT_REMINDED, CONSENT_REFUSED]) {
        const words = texts(tree).find((text) => text.includes('Alva Elev') && text.includes(entry.type === 'LEAVE_CONSENT_REFUSED' ? 'avslutats' : 'samtycke'))!;
        expect(words).toBeDefined();
        expect(pressableAt(tree, words)).toBeNull();
      }
    });
  });

  it.each(['TEACHER', 'SCHOOL_ADMIN', 'STUDENT', null])('leaves a Kvittens row plain text for %s, who has no Meddelanden tab', async (role) => {
    mockRole = role;
    read([ASKED]);
    tree = await render();
    expect(pressableAt(tree, 'Skolan ber dig bekräfta: Utflykten är på torsdag')).toBeNull();
  });
});
