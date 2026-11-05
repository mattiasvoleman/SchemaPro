/**
 * Vikarieförfrågningar, rendered whole with the gateway's three calls replaced.
 *
 * What is pinned is what a teacher sees and what the screen asks of the
 * gateway: the lessons of a question (never who is away or why), the time to
 * answer by, a yes and a no that cannot be pressed while one is in the air,
 * the card that turns into its confirmation, the sentence for a colleague who
 * was first (COVER_REQUEST_TAKEN), the rule's own sentence for a yes that
 * breaks one (the card stays), a question that has moved on (the list is read
 * again), an offline phone told so rather than failing silently, and a pass
 * confirmed with one tap. Under TZ=UTC and a pinned clock, so the instants
 * read as written.
 */
import React from 'react';
import { AppState, RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import type { AnswerOutcome, ConfirmOutcome, CoverLesson, MyCoverPass, MyCoverRequest, MyRequestState } from '../../services/coverRequests';

let mockRole = 'TEACHER';
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
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: 't1', role: mockRole }, isLoading: false }),
}));
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload the screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../services/coverRequests', () => ({
  ...jest.requireActual('../../services/coverRequests'),
  fetchMyCover: jest.fn(),
  answerCoverRequest: jest.fn(),
  confirmCoverPass: jest.fn(),
  loadProblem: jest.fn(),
}));

import { answerCoverRequest, confirmCoverPass, fetchMyCover, loadProblem } from '../../services/coverRequests';
import { CoverRequestsScreen } from './CoverRequestsScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');

const lesson = (over: Partial<CoverLesson> = {}): CoverLesson => ({
  lessonId: 'l1',
  date: '2026-10-13',
  startsAt: '2026-10-13T08:10:00.000Z',
  endsAt: '2026-10-13T09:00:00.000Z',
  subjectName: 'Matematik',
  groupName: '7A',
  roomName: 'B204',
  cancelled: false,
  ...over,
});

const request = (id: string, state: MyRequestState = 'OPEN', lessons: CoverLesson[] = [lesson()]): MyCoverRequest => ({
  id,
  state,
  createdAt: '2026-10-13T06:00:00.000Z',
  expiresAt: '2026-10-13T08:30:00.000Z',
  lessons,
  // What a gateway must never send and the screen must never draw.
  ...({ absentTeacherName: 'Berit Frånvarande', reason: 'Sjuk' } as object),
});

const pass = (over: Partial<MyCoverPass> = {}): MyCoverPass => ({
  lessonId: 'p1',
  date: '2026-10-14',
  startsAt: '2026-10-14T09:15:00.000Z',
  endsAt: '2026-10-14T10:00:00.000Z',
  subjectName: 'Svenska',
  groupName: '8B',
  roomName: 'A1',
  confirmedAt: null,
  ...over,
});

const TWO = [lesson(), lesson({ lessonId: 'l2', startsAt: '2026-10-14T08:10:00.000Z', endsAt: '2026-10-14T09:00:00.000Z', date: '2026-10-14', subjectName: 'Fysik' })];

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
    tree = TestRenderer.create(<CoverRequestsScreen />);
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

const read = (requests: MyCoverRequest[], passes: MyCoverPass[] = []) => jest.mocked(fetchMyCover).mockResolvedValue({ requests, passes });

let tree: Tree | null = null;

// The clock is the 13th, 06:00, so "Svara senast 08:30" is today's. Only Date
// is faked: the renderer and the settle() below need the real timers.
const REAL_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime'] as const;

// The first render of the screen loads React Native's list stack (SectionList,
// VirtualizedList, the touchables), which took seconds on a cold cache; a test
// that times out is not stopped and its body runs into the next. So it is done
// once, before the tests, with an allowance of its own (ScheduleScreen.test).
beforeAll(async () => {
  mockRole = 'TEACHER';
  read([request('warm')], [pass()]);
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-13T06:00:00.000Z'), doNotFake: [...REAL_TIMERS] });
  mockRole = 'TEACHER';
  mockFocusEffect = null;
  read([]);
  jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'ACCEPTED', lessons: 1 });
  jest.mocked(confirmCoverPass).mockResolvedValue({ kind: 'CONFIRMED' });
  jest.mocked(loadProblem).mockResolvedValue('FAILED');
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

describe('CoverRequestsScreen', () => {
  describe('the list', () => {
    it('draws an open question with its lessons, the time to answer by, a yes and a no, and nothing about who is away or why', async () => {
      read([request('r1', 'OPEN', TWO)]);
      tree = await render();
      expect(hasText(tree, t('coverRequests.title'))).toBe(true);
      expect(hasText(tree, t('coverRequests.subtitleOpen', { count: 1 }))).toBe(true);
      expect(hasText(tree, t('coverRequests.sectionOpen'))).toBe(true);
      // Weekday and date once per day, then the time, subject, group and room of each lesson.
      for (const text of ['tisdag 13 oktober', 'onsdag 14 oktober', '08:10', '09:00', 'Matematik', 'Fysik', '7A  ·  B204']) {
        expect(texts(tree)).toContain(text);
      }
      expect(hasText(tree, 'Svara senast 08:30')).toBe(true);
      expect(hasText(tree, 'Ja, jag tar dem')).toBe(true);
      expect(hasText(tree, 'Nej')).toBe(true);
      const everything = texts(tree).join('|');
      expect(everything).not.toContain('Berit');
      expect(everything).not.toContain('Sjuk');
    });

    it('says "det" for one lesson and "dem" for several', async () => {
      read([request('r1', 'OPEN', [lesson()])]);
      tree = await render();
      expect(hasText(tree, 'Ja, jag tar det')).toBe(true);
      expect(hasText(tree, 'Ja, jag tar dem')).toBe(false);
    });

    it('puts the day with the deadline when it is not today', async () => {
      read([{ ...request('r1'), expiresAt: '2026-10-14T08:30:00.000Z' }]);
      tree = await render();
      expect(hasText(tree, 'Svara senast ons 14 okt 08:30')).toBe(true);
    });

    it('says in words what became of each question that is no longer open', async () => {
      read(
        (['ACCEPTED_BY_ME', 'DECLINED_BY_ME', 'TAKEN', 'WITHDRAWN', 'EXPIRED', 'CLOSED'] as const).map((state, i) => request(`e${i}`, state)),
      );
      tree = await render();
      for (const words of ['Du tackade ja', 'Du tackade nej', 'Redan tillsatt av en kollega', 'Återkallad', 'Gick ut', 'Avslutad']) {
        expect(hasText(tree, words)).toBe(true);
      }
      expect(hasText(tree, t('coverRequests.sectionPast'))).toBe(true);
      expect(hasText(tree, t('coverRequests.noneOpen'))).toBe(true);
      expect(hasText(tree, t('coverRequests.subtitleNone'))).toBe(true);
      // Nothing to answer, so no buttons.
      expect(hasText(tree, 'Nej')).toBe(false);
    });

    it('lists the passes with a Bekräfta for one not yet confirmed and Bekräftad for one that is', async () => {
      read([], [pass(), pass({ lessonId: 'p2', subjectName: 'Engelska', confirmedAt: '2026-10-13T05:00:00.000Z' })]);
      tree = await render();
      expect(hasText(tree, t('coverRequests.sectionPasses'))).toBe(true);
      expect(texts(tree)).toEqual(expect.arrayContaining(['Svenska', 'Engelska', 'onsdag 14 oktober', '8B  ·  A1']));
      expect(hasText(tree, 'Bekräfta')).toBe(true);
      expect(hasText(tree, '✓ Bekräftad')).toBe(true);
    });

    it('says there is nothing, in words, when the school has asked for nothing', async () => {
      tree = await render();
      expect(hasText(tree, t('coverRequests.emptyTitle'))).toBe(true);
      expect(hasText(tree, t('coverRequests.emptyBody'))).toBe(true);
    });

    it('reads again on a pull, and on the tab gaining focus', async () => {
      tree = await render();
      expect(fetchMyCover).toHaveBeenCalledTimes(1);
      read([request('r1')]);
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(true);
      read([]);
      await act(async () => {
        mockFocusEffect?.();
      });
      await settle();
      expect(fetchMyCover).toHaveBeenCalledTimes(3);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(false);
    });

    it('reads again when the app returns to the front while the tab is open', async () => {
      tree = await render();
      // React Native's jest setup makes addEventListener a mock; the handler is the last one registered.
      const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1] as (state: string) => void;
      await act(async () => handler('background'));
      expect(fetchMyCover).toHaveBeenCalledTimes(1);
      await act(async () => handler('active'));
      await settle();
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
    });
  });

  describe('when it cannot be read', () => {
    it('tells an offline phone so, in place of the list', async () => {
      jest.mocked(fetchMyCover).mockRejectedValue(new TypeError('Network request failed'));
      jest.mocked(loadProblem).mockResolvedValue('OFFLINE');
      tree = await render();
      expect(hasText(tree, 'Du är offline')).toBe(true);
      expect(hasText(tree, t('coverRequests.problemOffline'))).toBe(true);
      expect(hasText(tree, t('coverRequests.emptyTitle'))).toBe(false);
    });

    it('says a read that failed otherwise, in place of the list', async () => {
      jest.mocked(fetchMyCover).mockRejectedValue(new Error('HTTP 500'));
      tree = await render();
      expect(hasText(tree, t('coverRequests.failedTitle'))).toBe(true);
      expect(hasText(tree, t('coverRequests.problemFailed'))).toBe(true);
    });

    it('keeps the list it had and says it may be out of date when a later read fails offline', async () => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(fetchMyCover).mockRejectedValue(new TypeError('Network request failed'));
      jest.mocked(loadProblem).mockResolvedValue('OFFLINE');
      await act(async () => {
        tree!.root.findByType(RefreshControl).props.onRefresh();
      });
      await settle();
      expect(hasText(tree, t('coverRequests.problemOffline'))).toBe(true);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(true);
    });
  });

  describe('a yes', () => {
    it('is sent to the gateway for that question, disabling every button while it is in the air, and the card turns into its confirmation', async () => {
      read([request('r1', 'OPEN', TWO), request('r2', 'OPEN', [lesson({ lessonId: 'l9', startsAt: '2026-10-15T08:10:00.000Z', date: '2026-10-15' })])]);
      tree = await render();
      const pending = deferred<AnswerOutcome>();
      jest.mocked(answerCoverRequest).mockReturnValueOnce(pending.promise);
      const yes = touchable(tree, 'Ja, jag tar dem');
      const other = touchable(tree, 'Ja, jag tar det');
      await press(yes);

      expect(answerCoverRequest).toHaveBeenCalledTimes(1);
      expect(answerCoverRequest).toHaveBeenCalledWith('r1', 'YES');
      // Both buttons of the question and the other question's too: one answer at a time.
      expect(yes.props.disabled).toBe(true);
      expect(other.props.disabled).toBe(true);
      expect(touchables(tree, 'Nej').map((no) => no.props.disabled)).toEqual([true, true]);
      // A second tap that gets in before the render is dropped.
      await press(yes);
      expect(answerCoverRequest).toHaveBeenCalledTimes(1);

      read([request('r1', 'ACCEPTED_BY_ME', TWO), request('r2')], [pass({ lessonId: 'l1' })]);
      await act(async () => pending.resolve({ kind: 'ACCEPTED', lessons: 2 }));
      await settle();

      expect(hasText(tree, 'Du har tagit uppdraget')).toBe(true);
      expect(hasText(tree, t('coverRequests.acceptedHint'))).toBe(true);
      // The list was read again, and the question keeps its place as the confirmation, not as "Du tackade ja".
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Du tackade ja')).toBe(false);
      // The other question is answerable again.
      expect(touchable(tree, 'Ja, jag tar det').props.disabled).toBe(false);
      expect(hasText(tree, t('coverRequests.sectionPasses'))).toBe(true);
    });

    it('shows the colleague who was first, in words, and takes the buttons away', async () => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'TAKEN' });
      read([request('r1', 'TAKEN')]);
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(hasText(tree, 'Uppdraget är redan tillsatt – en kollega hann före')).toBe(true);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(false);
      expect(hasText(tree, 'Nej')).toBe(false);
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
    });

    it('shows a rule’s own sentence as the gateway wrote it, and keeps the card and its buttons', async () => {
      const message = 'Du kan inte ta uppdraget (tis 13 okt 08:10) eftersom du skulle överskrida dagens tak för undervisning.';
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message });
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(hasText(tree, message)).toBe(true);
      expect(hasText(tree, 'Svara senast 08:30')).toBe(true);
      expect(touchable(tree, 'Ja, jag tar det').props.disabled).toBe(false);
      expect(touchable(tree, 'Nej').props.disabled).toBe(false);
      // The question is still open for the others: nothing changed, nothing to read again.
      expect(fetchMyCover).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['COVER_REQUEST_GONE', 'Förfrågan är avslutad. Listan är uppdaterad.'],
      ['COVER_REQUEST_ANSWERED', 'Du har redan svarat på förfrågan.'],
    ] as const)('reads the list again when the gateway says %s', async (code, words) => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'STALE', code });
      read([request('r1', 'EXPIRED')]);
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
      expect(hasText(tree, words)).toBe(true);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(false);
    });

    it('tells an offline phone so, keeps the buttons, and reads nothing again', async () => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'OFFLINE' });
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(hasText(tree, t('coverRequests.offline'))).toBe(true);
      expect(touchable(tree, 'Ja, jag tar det').props.disabled).toBe(false);
      expect(fetchMyCover).toHaveBeenCalledTimes(1);
    });

    it('says a failure, and lets the teacher try again', async () => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValueOnce({ kind: 'FAILED' });
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(hasText(tree, t('coverRequests.failed'))).toBe(true);
      await press(touchable(tree, 'Ja, jag tar det'));
      expect(answerCoverRequest).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Du har tagit uppdraget')).toBe(true);
      expect(hasText(tree, t('coverRequests.failed'))).toBe(false);
    });

    it('cannot be given to a question whose lesson is cancelled', async () => {
      read([request('r1', 'OPEN', [lesson({ cancelled: true })])]);
      tree = await render();
      expect(touchable(tree, 'Ja, jag tar det').props.disabled).toBe(true);
      expect(touchable(tree, 'Nej').props.disabled).toBe(true);
      expect(hasText(tree, t('common.cancelled'))).toBe(true);
    });
  });

  describe('a no', () => {
    it('is sent to the gateway for that question, and the card says "Du tackade nej"', async () => {
      read([request('r1')]);
      tree = await render();
      jest.mocked(answerCoverRequest).mockResolvedValue({ kind: 'DECLINED' });
      read([request('r1', 'DECLINED_BY_ME')]);
      await press(touchable(tree, 'Nej'));
      expect(answerCoverRequest).toHaveBeenCalledWith('r1', 'NO');
      expect(hasText(tree, 'Du tackade nej')).toBe(true);
      expect(hasText(tree, 'Ja, jag tar det')).toBe(false);
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
    });
  });

  describe('a pass', () => {
    it('is confirmed with one tap, disabled while the call is in the air, and reads Bekräftad after', async () => {
      read([], [pass()]);
      tree = await render();
      const pending = deferred<ConfirmOutcome>();
      jest.mocked(confirmCoverPass).mockReturnValueOnce(pending.promise);
      const confirm = touchable(tree, 'Bekräfta');
      await press(confirm);
      expect(confirmCoverPass).toHaveBeenCalledWith('p1');
      expect(confirm.props.disabled).toBe(true);
      read([], [pass({ confirmedAt: '2026-10-13T06:00:01.000Z' })]);
      await act(async () => pending.resolve({ kind: 'CONFIRMED' }));
      await settle();
      expect(hasText(tree, '✓ Bekräftad')).toBe(true);
      expect(hasText(tree, 'Bekräfta')).toBe(false);
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
    });

    it('tells an offline phone so and leaves the pass to confirm', async () => {
      read([], [pass()]);
      tree = await render();
      jest.mocked(confirmCoverPass).mockResolvedValue({ kind: 'OFFLINE' });
      await press(touchable(tree, 'Bekräfta'));
      expect(hasText(tree, t('coverRequests.offline'))).toBe(true);
      expect(touchable(tree, 'Bekräfta').props.disabled).toBe(false);
      expect(fetchMyCover).toHaveBeenCalledTimes(1);
    });

    it('reads the list again when the pass is no longer the teacher’s', async () => {
      read([], [pass()]);
      tree = await render();
      jest.mocked(confirmCoverPass).mockResolvedValue({ kind: 'STALE', code: 'COVER_PASS_NOT_FOUND' });
      read([], []);
      await press(touchable(tree, 'Bekräfta'));
      expect(fetchMyCover).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Bekräfta')).toBe(false);
    });
  });

  describe('for anyone but a teacher', () => {
    it('reads nothing and asks nothing: the administrator shares the shell, not the question', async () => {
      mockRole = 'SCHOOL_ADMIN';
      read([request('r1')]);
      tree = await render();
      expect(hasText(tree, t('coverRequests.teachersOnly'))).toBe(true);
      expect(fetchMyCover).not.toHaveBeenCalled();
      expect(hasText(tree, 'Ja, jag tar det')).toBe(false);
    });
  });
});
