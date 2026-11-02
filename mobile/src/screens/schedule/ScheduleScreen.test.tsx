/**
 * The teacher's schedule when a rastvaktspass is among the lessons.
 *
 * The passes come from the gateway beside the lessons, which the screen reads
 * from Supabase itself, and each can fail without the other: a pass read that
 * fails says so and costs the schedule none of its lessons, and a schedule
 * that is empty is only empty when it has no pass either. Two places turn on
 * that and nothing else drew them: the condition that gives the list its
 * empty state (rows and passes both none), and the line that says the passes
 * could not be read (passesFailed, kept quiet while the lessons' own error is
 * shown). The screen is rendered whole here with both reads replaced, so what
 * is pinned is what a teacher sees.
 */
import React from 'react';
import { RefreshControl, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import type { WeekPass } from '../../services/supervisionWeek';

let mockLessonRows: unknown[] = [];
let mockLessonError: { message: string } | null = null;

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }) }));
jest.mock('../../context/AuthContext', () => {
  const value = { authState: { isAuthenticated: true, teacherId: 't1', role: 'TEACHER' }, isLoading: false };
  return { useAuth: () => value };
});
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload the screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../context/SyncContext', () => {
  const value = { setActiveLesson: jest.fn() };
  return { useSync: () => value };
});
jest.mock('../../services/roster', () => ({ openLessonForAttendance: jest.fn() }));
// The lessons, as PostgREST answers them: the query is awaited at its last step.
jest.mock('../../services/supabase', () => {
  const query: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      resolve(mockLessonError ? { data: null, error: mockLessonError } : { data: mockLessonRows, error: null }),
  };
  for (const step of ['select', 'eq', 'gte', 'lte']) query[step] = () => query;
  return { getSupabase: () => ({ from: () => query }) };
});
// passCardsOf is the real one: the cards the screen draws are the service's.
jest.mock('../../services/supervisionWeek', () => ({
  ...jest.requireActual('../../services/supervisionWeek'),
  fetchSupervisionWeek: jest.fn(),
}));

import { fetchSupervisionWeek } from '../../services/supervisionWeek';
import { ScheduleScreen } from './ScheduleScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');

const LESSON = {
  lesson: {
    id: 'a',
    date: '2026-10-19',
    startsAt: '2026-10-19T08:10:00+00:00',
    endsAt: '2026-10-19T09:00:00+00:00',
    status: 'SCHEDULED',
    subject: { name: 'Svenska' },
    room: { name: 'A1' },
  },
};

const PASS: WeekPass = {
  kind: 'OWN',
  shiftId: 's1',
  date: '2026-10-19',
  startsAt: '2026-10-19T09:00:00Z',
  endsAt: '2026-10-19T09:20:00Z',
  areaName: 'Skolgården',
  siteName: 'Norra',
  handover: null,
};

const PASS_TITLE = `${t('schedule.passTitle')}  ·  Skolgården`;

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const hasText = (tree: Tree, text: string): boolean => tree.root.findAll((n) => isHostOf(n, 'Text') && textOf(n) === text).length > 0;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(<ScheduleScreen />);
  });
  await settle();
  return tree;
}

/** A pull to refresh, as the list's RefreshControl hands it on. */
async function refresh(tree: Tree): Promise<void> {
  await act(async () => {
    tree.root.findByType(RefreshControl).props.onRefresh();
  });
  await settle();
}

/** The list's own style, flattened: the outermost node that is given sections. */
function listStyle(tree: Tree): Record<string, unknown> {
  const list = tree.root.findAll((n) => n.props.sections !== undefined && typeof n.props.renderItem === 'function')[0]!;
  return (StyleSheet.flatten(list.props.contentContainerStyle) as Record<string, unknown> | undefined) ?? {};
}

let tree: Tree | null = null;

// The first render of the screen is the one that loads React Native's list
// stack (SectionList, VirtualizedList, the touchables: its index requires them
// on first use), and on a cold transform cache that took 2.2 s here and more
// than a test's 5 s on a CI runner. A test that times out is not stopped: its
// body goes on into the next, which then draws a second tree inside its act()
// (the "overlapping act()" the first run of this file gave in CI), and into
// the environment's teardown. So the load is done once, before the tests,
// with an allowance of its own, with a lesson and a pass so that both cards
// are drawn; the tests are then measured on what they do.
beforeAll(async () => {
  mockLessonRows = [LESSON];
  jest.mocked(fetchSupervisionWeek).mockResolvedValue([PASS]);
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  mockLessonRows = [];
  mockLessonError = null;
  jest.mocked(fetchSupervisionWeek).mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});

describe('ScheduleScreen', () => {
  describe('the list is empty only when it has neither a lesson nor a pass', () => {
    it.each([
      ['no lesson and no pass', [], [], true],
      ['a pass and no lesson', [], [PASS], false],
      ['a lesson and no pass', [LESSON], [], false],
      ['a lesson and a pass', [LESSON], [PASS], false],
    ] as const)('with %s', async (_name, lessons, passes, empty) => {
      mockLessonRows = [...lessons];
      jest.mocked(fetchSupervisionWeek).mockResolvedValue([...passes]);
      tree = await render();
      // The empty state fills the screen to centre its sentence; a list does not.
      expect(hasText(tree, t('schedule.emptyTitle'))).toBe(empty);
      expect(listStyle(tree).flexGrow).toBe(empty ? 1 : undefined);
      expect(hasText(tree, 'Svenska')).toBe(lessons.length > 0);
      expect(hasText(tree, PASS_TITLE)).toBe(passes.length > 0);
    });
  });

  describe('a pass read that fails', () => {
    const FAILED = t('schedule.passesError');

    it('says so, and costs the schedule none of its lessons', async () => {
      mockLessonRows = [LESSON];
      jest.mocked(fetchSupervisionWeek).mockRejectedValue(new Error('offline'));
      tree = await render();
      expect(hasText(tree, FAILED)).toBe(true);
      expect(hasText(tree, 'Svenska')).toBe(true);
    });

    it('says nothing when the passes were read', async () => {
      mockLessonRows = [LESSON];
      jest.mocked(fetchSupervisionWeek).mockResolvedValue([PASS]);
      tree = await render();
      expect(hasText(tree, FAILED)).toBe(false);
      expect(hasText(tree, PASS_TITLE)).toBe(true);
    });

    it("leaves the lessons' own error to say it, when both reads failed", async () => {
      mockLessonError = { message: 'permission denied' };
      jest.mocked(fetchSupervisionWeek).mockRejectedValue(new Error('offline'));
      tree = await render();
      expect(hasText(tree, t('schedule.loadError'))).toBe(true);
      expect(hasText(tree, FAILED)).toBe(false);
    });

    it('drops the passes it had when a refresh fails, and says nothing again once the next read arrives', async () => {
      mockLessonRows = [LESSON];
      jest.mocked(fetchSupervisionWeek).mockResolvedValue([PASS]);
      tree = await render();
      expect(hasText(tree, PASS_TITLE)).toBe(true);
      expect(hasText(tree, FAILED)).toBe(false);

      jest.mocked(fetchSupervisionWeek).mockRejectedValueOnce(new Error('offline'));
      await refresh(tree);
      // Passes that may be a week old are not shown beside a line that says they could not be read.
      expect(hasText(tree, PASS_TITLE)).toBe(false);
      expect(hasText(tree, FAILED)).toBe(true);
      expect(hasText(tree, 'Svenska')).toBe(true);

      await refresh(tree);
      expect(hasText(tree, FAILED)).toBe(false);
      expect(hasText(tree, PASS_TITLE)).toBe(true);
    });
  });
});
