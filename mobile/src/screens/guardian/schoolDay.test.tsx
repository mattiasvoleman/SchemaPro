/**
 * What "today" is on the guardian's two forms: the child's school's, not the phone's.
 *
 * The gateway holds an absence report and a leave request to the school's day
 * (ChildRow.schoolToday), wherever the phone is: in New York at 20:00 it is
 * already tomorrow in Stockholm. Four places on the two screens turn on that
 * and nothing else drew them: the day a report starts on (reportDate), whether
 * a report is offered to be taken back (mayWithdraw, against the day of the
 * report's own child), and the two days a leave starts and ends on. The
 * screens are rendered whole here, with the services under them replaced, so
 * what is pinned is what the guardian sees and what the gateway is sent.
 *
 * The two children's school days are 2099-01-01 and 2000-01-01, either side of
 * any day this suite can run on, so the phone's own date is wrong for both
 * without the test having to know it. The phone's day is pinned only where no
 * school day was given, with a fake Date.
 */
import React from 'react';
import { Alert } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import type { AbsenceReportRow, ChildRow, LeaveRequestRow } from '../../types';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('../../context/AuthContext', () => {
  const value = { authState: { isAuthenticated: true, teacherId: 'g1', role: 'GUARDIAN' }, isLoading: false };
  return { useAuth: () => value };
});
jest.mock('../../context/LocaleContext', () => {
  // One object, built in the factory: a new t per render would reload a screen without end.
  const value = { t: require('../../i18n').translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('../../services/children', () => ({ fetchChildren: jest.fn() }));
jest.mock('../../services/absenceReports', () => ({
  // mayWithdraw is the real one: the screen's call of it is what is under test.
  ...jest.requireActual('../../services/absenceReports'),
  fetchAbsenceReports: jest.fn(),
  reportAbsence: jest.fn(),
  removeAbsenceReport: jest.fn(),
}));
jest.mock('../../services/leaveRequests', () => ({
  ...jest.requireActual('../../services/leaveRequests'),
  fetchLeaveRequests: jest.fn(),
  requestLeave: jest.fn(),
}));

import { fetchChildren } from '../../services/children';
import { fetchAbsenceReports, reportAbsence } from '../../services/absenceReports';
import { fetchLeaveRequests, requestLeave } from '../../services/leaveRequests';
import { GuardianHomeScreen } from './GuardianHomeScreen';
import { LeaveRequestsScreen } from './LeaveRequestsScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const t = translatorFor('sv');

/** Ella's school is on 2099-01-01 and Liam's on 2000-01-01; Ella is the first, so the one chosen at first. */
const ELLA: ChildRow = { linkId: 'k1', id: 'c1', firstName: 'Ella', lastName: 'Svensson', isActive: true, schoolToday: '2099-01-01' };
const LIAM: ChildRow = { linkId: 'k2', id: 'c2', firstName: 'Liam', lastName: 'Svensson', isActive: true, schoolToday: '2000-01-01' };

const report = (id: string, studentId: string, date: string, reportedById = 'g1'): AbsenceReportRow => ({
  id,
  studentId,
  reportedById,
  date: `${date}T00:00:00.000Z`,
  startTime: null,
  endTime: null,
  type: 'SICK',
  note: null,
});

const isHost = (node: Instance): boolean => typeof node.type === 'string';
const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;

function ancestors(node: Instance): Instance[] {
  const found: Instance[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) found.push(parent);
  return found;
}

/** The text a host Text shows, as one string. */
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');

/** The one host Text that reads `text`. */
const textNode = (tree: Tree, text: string): Instance => tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === text);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(Screen: React.ComponentType): Promise<Tree> {
  let tree!: Tree;
  await act(async () => {
    tree = TestRenderer.create(<Screen />);
  });
  await settle();
  return tree;
}

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

/** The field named `label`. */
const fieldOf = (tree: Tree, label: string): Instance =>
  tree.root.find((n) => isHostOf(n, 'TextInput') && n.props.accessibilityLabel === label);

async function type(tree: Tree, label: string, value: string): Promise<void> {
  await act(async () => {
    fieldOf(tree, label).props.onChangeText(value);
  });
}

/** What the field named `label` shows. */
const valueOf = (tree: Tree, label: string): unknown => fieldOf(tree, label).props.value;

let tree: Tree | null = null;

beforeEach(() => {
  jest.mocked(fetchChildren).mockResolvedValue([ELLA, LIAM]);
  jest.mocked(fetchAbsenceReports).mockResolvedValue([]);
  jest.mocked(fetchLeaveRequests).mockResolvedValue([]);
  jest.mocked(reportAbsence).mockResolvedValue({ id: 'new', studentId: 'c1', date: '' });
  jest.mocked(requestLeave).mockResolvedValue({} as LeaveRequestRow);
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('GuardianHomeScreen', () => {
  const DATE = t('guardian.dateLabel');

  describe('the day a report is for', () => {
    it("starts as the chosen child's school day, and follows the choice of child", async () => {
      tree = await render(GuardianHomeScreen);
      expect(valueOf(tree, DATE)).toBe('2099-01-01');
      await press(tree, 'Liam Svensson');
      expect(valueOf(tree, DATE)).toBe('2000-01-01');
      await press(tree, 'Ella Svensson');
      expect(valueOf(tree, DATE)).toBe('2099-01-01');
    });

    it("is sent to the gateway as the chosen child's school day", async () => {
      tree = await render(GuardianHomeScreen);
      await press(tree, 'Liam Svensson');
      await press(tree, t('guardian.submit'));
      expect(reportAbsence).toHaveBeenCalledTimes(1);
      expect(reportAbsence).toHaveBeenCalledWith({ studentId: 'c2', date: '2000-01-01', type: 'SICK' });
    });

    it('is the day the guardian typed, once they have typed one', async () => {
      tree = await render(GuardianHomeScreen);
      await type(tree, DATE, '2099-02-03');
      expect(valueOf(tree, DATE)).toBe('2099-02-03');
      // The typed day stays when the child is changed: it is the guardian's, not the school's.
      await press(tree, 'Liam Svensson');
      expect(valueOf(tree, DATE)).toBe('2099-02-03');
      await press(tree, t('guardian.submit'));
      expect(reportAbsence).toHaveBeenCalledWith({ studentId: 'c2', date: '2099-02-03', type: 'SICK' });
    });

    it("is the phone's day only for a child whose gateway named no school day", async () => {
      // A gateway from before schoolToday: the field falls back to the phone's
      // calendar day, in the phone's zone. Only the clock is faked, so the
      // runner's own timers still run.
      jest.useFakeTimers({
        now: new Date(2026, 9, 19, 12, 0, 0),
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      });
      jest.mocked(fetchChildren).mockResolvedValue([{ ...ELLA, schoolToday: undefined }]);
      tree = await render(GuardianHomeScreen);
      expect(valueOf(tree, DATE)).toBe('2026-10-19');
    });
  });

  describe("a report's offer to be taken back", () => {
    /** The date of each report that has a button to take it back, as the row shows it. */
    function withdrawableDates(root: Tree): string[] {
      const meta = /^(\d{4}-\d{2}-\d{2}) · /;
      const buttons = root.root.findAll((n) => isHost(n) && n.props.accessibilityLabel === t('guardian.deleteA11y'));
      return buttons.map((button) => {
        const row = ancestors(button).find((a) => a.findAll((n) => isHostOf(n, 'Text') && meta.test(textOf(n))).length > 0)!;
        return meta.exec(textOf(row.find((n) => isHostOf(n, 'Text') && meta.test(textOf(n)))))![1]!;
      });
    }

    it("is decided by the day of the report's own child, whichever child is chosen, and by who made it", async () => {
      jest.mocked(fetchAbsenceReports).mockResolvedValue([
        // Ella's school is on 2099-01-01: the day before is past there, though it is still to come for the phone.
        report('r1', 'c1', '2098-12-31'),
        // Ella's own school day is not past.
        report('r2', 'c1', '2099-01-01'),
        // Liam's school is on 2000-01-01: the day itself, and the days after, are not past there, though they are for the phone.
        report('r3', 'c2', '2000-01-01'),
        report('r4', 'c2', '2000-01-03'),
        // The same days, made by another guardian of the family: not the guardian's to take back.
        report('r5', 'c2', '2000-01-04', 'g2'),
      ]);
      tree = await render(GuardianHomeScreen);
      // Ella is the child chosen, and her day is not the day of Liam's reports.
      expect(valueOf(tree, DATE)).toBe('2099-01-01');
      expect(withdrawableDates(tree)).toEqual(['2099-01-01', '2000-01-01', '2000-01-03']);
    });
  });
});

describe('LeaveRequestsScreen', () => {
  const FROM = t('leave.from');
  const TO = t('leave.to');
  const REASON = t('leave.reason');

  it("starts both days as the chosen child's school day, and follows the choice of child", async () => {
    tree = await render(LeaveRequestsScreen);
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2099-01-01', '2099-01-01']);
    await press(tree, 'Liam Svensson');
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2000-01-01', '2000-01-01']);
    await press(tree, 'Ella Svensson');
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2099-01-01', '2099-01-01']);
  });

  it("sends the school's day for each day the guardian did not type, and the day typed for the one they did", async () => {
    tree = await render(LeaveRequestsScreen);
    await press(tree, 'Liam Svensson');
    await type(tree, REASON, 'Resa');
    await press(tree, t('leave.submit'));
    expect(requestLeave).toHaveBeenLastCalledWith({ studentId: 'c2', startDate: '2000-01-01', endDate: '2000-01-01', reason: 'Resa' });

    await type(tree, FROM, '2000-02-01');
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2000-02-01', '2000-01-01']);
    await type(tree, REASON, 'Resa');
    await press(tree, t('leave.submit'));
    expect(requestLeave).toHaveBeenLastCalledWith({ studentId: 'c2', startDate: '2000-02-01', endDate: '2000-01-01', reason: 'Resa' });

    await type(tree, TO, '2000-02-09');
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2000-02-01', '2000-02-09']);
    await type(tree, REASON, 'Resa');
    await press(tree, t('leave.submit'));
    expect(requestLeave).toHaveBeenLastCalledWith({ studentId: 'c2', startDate: '2000-02-01', endDate: '2000-02-09', reason: 'Resa' });
  });

  it("starts at the phone's day only for a child whose gateway named no school day", async () => {
    jest.useFakeTimers({
      now: new Date(2026, 9, 19, 12, 0, 0),
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    jest.mocked(fetchChildren).mockResolvedValue([{ ...ELLA, schoolToday: undefined }]);
    tree = await render(LeaveRequestsScreen);
    expect([valueOf(tree, FROM), valueOf(tree, TO)]).toEqual(['2026-10-19', '2026-10-19']);
  });
});
