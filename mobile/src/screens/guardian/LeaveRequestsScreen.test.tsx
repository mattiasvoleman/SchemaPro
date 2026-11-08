/**
 * Ledighet (leave requests), rendered whole with the gateway's calls replaced.
 *
 * What is pinned is what a guardian sees and what the screen asks of the
 * gateway under Ledighetspolicy (K4). EVERYTHING THE POLICY ADDS IS OFF: with
 * the school's all-off policy, or none at all, the form is the three fields
 * it was and a row is the row it was. The contact's fields, the minimum of
 * days and the sentence about every guardian's consent appear only when the
 * policy says so, and are marked required only when it requires them; the
 * gateway's refusals are worded in the reader's language, the school's
 * minimum with the days it named. A row shows the consent question only to
 * the guardian who is asked, a yes at once and a no after a question that
 * says it cannot be taken back, and shows where the request stands to
 * everyone else without a word about who answered what.
 *
 * Under TZ=UTC. The day arithmetic is the school's (schoolDay.test.tsx).
 */
import React from 'react';
import { AccessibilityInfo, Alert, Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { translatorFor } from '../../i18n';
import { ApiError } from '../../services/api';
import type { ChildRow, LeaveConsentMine, LeaveConsentState, LeavePolicy, LeaveRequestRow } from '../../types';

let mockLocale: 'sv' | 'en' = 'sv';
let mockFocusEffect: (() => void | (() => void)) | null = null;

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({
  // As a focused tab: the effect runs on mount; the test can run it again, as the tab gaining focus does.
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockFocusEffect = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
}));
jest.mock('../../context/AuthContext', () => {
  const value = { authState: { isAuthenticated: true, teacherId: 'g1', role: 'GUARDIAN' }, isLoading: false };
  return { useAuth: () => value };
});
jest.mock('../../context/LocaleContext', () => {
  // One object per language, built in the factory: a new t per render would reload the screen without end.
  const catalogue = require('../../i18n');
  const sv = { t: catalogue.translatorFor('sv'), locale: 'sv', setLocale: jest.fn() };
  const en = { t: catalogue.translatorFor('en'), locale: 'en', setLocale: jest.fn() };
  return { useI18n: () => (mockLocale === 'en' ? en : sv) };
});
jest.mock('../../services/children', () => ({ fetchChildren: jest.fn() }));
jest.mock('../../services/leaveRequests', () => ({
  // The wording, the policy's reading and the row arithmetic are the real ones: the screen's use of them is under test.
  ...jest.requireActual('../../services/leaveRequests'),
  fetchLeaveRequests: jest.fn(),
  fetchLeavePolicy: jest.fn(),
  requestLeave: jest.fn(),
  answerLeaveConsent: jest.fn(),
}));

import { fetchChildren } from '../../services/children';
import {
  DEFAULT_LEAVE_POLICY,
  answerLeaveConsent,
  fetchLeavePolicy,
  fetchLeaveRequests,
  requestLeave,
} from '../../services/leaveRequests';
import { LeaveRequestsScreen } from './LeaveRequestsScreen';

type Tree = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

const sv = translatorFor('sv');
const en = translatorFor('en');

const ELLA: ChildRow = { linkId: 'k1', id: 'c1', firstName: 'Ella', lastName: 'Svensson', isActive: true, schoolToday: '2026-10-19' };

const policy = (over: Partial<LeavePolicy> = {}): LeavePolicy => ({ ...DEFAULT_LEAVE_POLICY, ...over });

const consent = (state: LeaveConsentState, mine: LeaveConsentMine, required = true): NonNullable<LeaveRequestRow['consent']> => ({
  required,
  state,
  mine,
});

const leave = (id: string, over: Partial<LeaveRequestRow> = {}): LeaveRequestRow => ({
  id,
  studentId: 'c1',
  startDate: '2026-11-02T00:00:00.000Z',
  endDate: '2026-11-06T00:00:00.000Z',
  reason: 'Familjeresa',
  status: 'PENDING',
  decisionNote: null,
  decidedAs: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  ...over,
});

const isHostOf = (node: Instance, name: string): boolean => (node.type as unknown) === name;
const textOf = (node: Instance): string => [node.props.children].flat(Infinity).join('');
const texts = (tree: Tree): string[] => tree.root.findAll((n) => isHostOf(n, 'Text')).map(textOf);
const hasText = (tree: Tree, text: string): boolean => texts(tree).includes(text);
const fieldLabels = (tree: Tree): unknown[] =>
  tree.root.findAll((n) => isHostOf(n, 'TextInput')).map((n) => n.props.accessibilityLabel);
const fieldOf = (tree: Tree, label: string): Instance =>
  tree.root.find((n) => isHostOf(n, 'TextInput') && n.props.accessibilityLabel === label);

const isInside = (outer: Instance, inner: Instance): boolean => {
  for (let at: Instance | null = inner.parent; at; at = at.parent) if (at === outer) return true;
  return false;
};

/** Every button, innermost holder of each press first-found: a busy one shows a spinner, not its words. */
function buttons(tree: Tree): Instance[] {
  const holders = tree.root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button' && !isHostOf(n, 'View'),
  );
  return holders.filter((holder) => !holders.some((other) => other !== holder && isInside(holder, other)));
}

/** The buttons whose accessibility label is `label`. */
const buttonsLabelled = (tree: Tree, label: string): Instance[] => buttons(tree).filter((b) => b.props.accessibilityLabel === label);

/** What a finger presses where the text `label` is: the nearest holder of an onPress. */
function pressable(tree: Tree, label: string): Instance {
  const found = tree.root.findAll((n) => isHostOf(n, 'Text') && textOf(n) === label);
  if (found.length !== 1) throw new Error(`expected one "${label}", found ${found.length}`);
  for (let at: Instance | null = found[0]!; at; at = at.parent) {
    if (typeof at.props.onPress === 'function') return at;
  }
  throw new Error(`nothing to press holds "${label}"`);
}

/** The nearest ancestor satisfying `test`, or null. */
function ancestorWhere(node: Instance, test: (n: Instance) => boolean): Instance | null {
  for (let at: Instance | null = node.parent; at; at = at.parent) if (test(at)) return at;
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
    tree = TestRenderer.create(<LeaveRequestsScreen />);
  });
  await settle();
  return tree;
}

async function press(node: Instance): Promise<void> {
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

async function type(tree: Tree, label: string, value: string): Promise<void> {
  await act(async () => {
    fieldOf(tree, label).props.onChangeText(value);
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const read = (rows: LeaveRequestRow[]) => jest.mocked(fetchLeaveRequests).mockResolvedValue(rows);
const readPolicy = (over: Partial<LeavePolicy>) => jest.mocked(fetchLeavePolicy).mockResolvedValue(policy(over));

const SUBMIT = sv('leave.submit');
const REASON = sv('leave.reason');
const NAME = sv('leave.fieldOptional', { label: sv('leave.contactName') });
const PHONE = sv('leave.fieldOptional', { label: sv('leave.contactPhone') });
const RELATION = sv('leave.fieldOptional', { label: sv('leave.contactRelation') });
const AGREE = sv('leave.consent.agreeA11y', { name: 'Ella Svensson', from: '2026-11-02', to: '2026-11-06' });
const DECLINE = sv('leave.consent.declineA11y', { name: 'Ella Svensson', from: '2026-11-02', to: '2026-11-06' });

let tree: Tree | null = null;

// The first render loads React Native's scroll and touchable stack, which took
// seconds on a cold cache; done once, before the tests, with an allowance of its own.
beforeAll(async () => {
  jest.mocked(fetchChildren).mockResolvedValue([ELLA]);
  read([]);
  readPolicy({});
  const warmed = await render();
  await act(async () => warmed.unmount());
}, 60_000);

beforeEach(() => {
  mockLocale = 'sv';
  mockFocusEffect = null;
  jest.mocked(fetchChildren).mockResolvedValue([ELLA]);
  read([]);
  readPolicy({});
  jest.mocked(requestLeave).mockResolvedValue({ id: 'new', studentId: 'c1', status: 'PENDING' });
  jest.mocked(answerLeaveConsent).mockResolvedValue({ id: 'l1', answer: 'GIVEN', state: 'GIVEN' });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

describe('the form under the school’s policy', () => {
  it('is the three fields it was, with no hint and no contact, when the school has chosen nothing', async () => {
    tree = await render();
    expect(fieldLabels(tree)).toEqual([sv('leave.from'), sv('leave.to'), REASON]);
    const words = texts(tree);
    for (const key of ['leave.contactTitle', 'leave.allGuardiansHint'] as const) expect(words).not.toContain(sv(key));
    expect(words.filter((w) => w.startsWith('Ansök minst'))).toEqual([]);
  });

  it('is that screen too when the policy cannot be read, and keeps the policy it had when a later read fails', async () => {
    jest.mocked(fetchLeavePolicy).mockRejectedValue(new Error('Network request failed'));
    tree = await render();
    expect(fieldLabels(tree)).toEqual([sv('leave.from'), sv('leave.to'), REASON]);
    expect(texts(tree)).toContain(sv('leave.submit'));

    readPolicy({ contact: 'OPTIONAL', minDaysAhead: 5 });
    await act(async () => {
      mockFocusEffect?.();
    });
    await settle();
    expect(fieldLabels(tree)).toEqual([sv('leave.from'), sv('leave.to'), REASON, NAME, PHONE, RELATION]);

    jest.mocked(fetchLeavePolicy).mockRejectedValue(new Error('Network request failed'));
    await act(async () => {
      mockFocusEffect?.();
    });
    await settle();
    expect(fieldLabels(tree)).toHaveLength(6);
    expect(hasText(tree, 'Ansök minst 5 dagar före första dagen.')).toBe(true);
  });

  it('is the old screen for the all-off policy of a gateway with no policy route, and draws the row as it was', async () => {
    jest.mocked(fetchLeavePolicy).mockResolvedValue(DEFAULT_LEAVE_POLICY);
    read([leave('l1')]);
    tree = await render();
    expect(fieldLabels(tree)).toHaveLength(3);
    expect(texts(tree)).toEqual(
      expect.arrayContaining(['Ella Svensson', sv('leave.status.PENDING'), '2026-11-02 – 2026-11-06', 'Familjeresa']),
    );
  });

  describe('the contact', () => {
    it('shows three optional fields, marked optional, with what is shown to whom', async () => {
      readPolicy({ contact: 'OPTIONAL' });
      tree = await render();
      expect(fieldLabels(tree)).toEqual([sv('leave.from'), sv('leave.to'), REASON, NAME, PHONE, RELATION]);
      expect(NAME).toBe('Kontaktens namn (frivilligt)');
      expect(PHONE).toBe('Kontaktens telefonnummer (frivilligt)');
      expect(RELATION).toBe('Kontaktens relation till barnet (frivilligt)');
      expect(hasText(tree, 'Kontakt under ledigheten')).toBe(true);
      expect(hasText(tree, sv('leave.contactHintOptional'))).toBe(true);
      expect(sv('leave.contactHintOptional')).toContain('bara för er, rektor och mentorn som beslutar');
    });

    it('marks the three required when the school requires them, and says so', async () => {
      readPolicy({ contact: 'REQUIRED' });
      tree = await render();
      expect(fieldLabels(tree).slice(3)).toEqual([
        'Kontaktens namn (obligatoriskt)',
        'Kontaktens telefonnummer (obligatoriskt)',
        'Kontaktens relation till barnet (obligatoriskt)',
      ]);
      expect(hasText(tree, sv('leave.contactHintRequired'))).toBe(true);
      expect(hasText(tree, sv('leave.contactHintOptional'))).toBe(false);
    });

    it('names a section header, keeps the phone’s own autofill off a third party’s details and fits the gateway’s lengths', async () => {
      readPolicy({ contact: 'OPTIONAL' });
      tree = await render();
      const header = tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === sv('leave.contactTitle'));
      expect(header.props.accessibilityRole).toBe('header');
      const name = fieldOf(tree, NAME).props;
      const phone = fieldOf(tree, PHONE).props;
      const relation = fieldOf(tree, RELATION).props;
      expect([name.maxLength, phone.maxLength, relation.maxLength]).toEqual([100, 30, 60]);
      expect(phone.keyboardType).toBe('phone-pad');
      for (const props of [name, phone, relation]) {
        expect(props.autoComplete).toBe('off');
        expect(props.textContentType).toBe('none');
        expect(props.importantForAutofill).toBe('no');
      }
    });

    it('sends what was typed, trimmed, and clears the three after a request that went through', async () => {
      readPolicy({ contact: 'OPTIONAL' });
      tree = await render();
      await type(tree, REASON, 'Familjeresa');
      await type(tree, NAME, ' Anna Lind ');
      await type(tree, PHONE, '070-123 45 67');
      await type(tree, RELATION, 'Faster');
      await press(pressable(tree, SUBMIT));
      expect(requestLeave).toHaveBeenCalledWith({
        studentId: 'c1',
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        reason: 'Familjeresa',
        contactName: ' Anna Lind ',
        contactPhone: '070-123 45 67',
        contactRelation: 'Faster',
      });
      expect([fieldOf(tree, NAME).props.value, fieldOf(tree, PHONE).props.value, fieldOf(tree, RELATION).props.value]).toEqual(['', '', '']);
    });

    it('hands the service empty fields when none was filled (which it leaves out), and no contact at all when the policy has none', async () => {
      readPolicy({ contact: 'OPTIONAL' });
      tree = await render();
      await type(tree, REASON, 'Resa');
      await press(pressable(tree, SUBMIT));
      expect(jest.mocked(requestLeave).mock.calls[0]![0]).toMatchObject({ contactName: '', contactPhone: '', contactRelation: '' });
      await act(async () => tree?.unmount());

      readPolicy({});
      tree = await render();
      await type(tree, REASON, 'Resa');
      await press(pressable(tree, SUBMIT));
      expect(jest.mocked(requestLeave).mock.calls[1]![0]).toEqual({
        studentId: 'c1',
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        reason: 'Resa',
      });
    });
  });

  describe('the minimum of days ahead', () => {
    it.each([
      [{ minDaysAhead: 14 }, 'Ansök minst 14 dagar före första dagen.'],
      [{ minDaysAhead: 14, shortNotice: 'REFUSE' as const }, 'Ansök minst 14 dagar före första dagen.'],
      [{ minDaysAhead: 1 }, 'Ansök minst 1 dag före första dagen.'],
      [
        { minDaysAhead: 7, shortNotice: 'FLAG' as const },
        'Ansök minst 7 dagar före första dagen. Kommer ansökan senare flaggas den för den som beslutar.',
      ],
    ])('explains %j as “%s”', async (over, sentence) => {
      readPolicy(over);
      tree = await render();
      expect(hasText(tree, sentence)).toBe(true);
    });

    it('says nothing of a minimum when the school has none, whatever it would do to a late request', async () => {
      readPolicy({ minDaysAhead: null, shortNotice: 'FLAG' });
      tree = await render();
      expect(texts(tree).filter((w) => w.includes('Ansök minst'))).toEqual([]);
    });

    it('is worded in English for an English reader', async () => {
      mockLocale = 'en';
      readPolicy({ minDaysAhead: 7, shortNotice: 'FLAG' });
      tree = await render();
      expect(hasText(tree, 'Apply at least 7 days before the first day. A later request is flagged for whoever decides.')).toBe(true);
    });
  });

  describe('every guardian’s consent', () => {
    it('says that every guardian is asked, and that whoever submits counts as having consented, only when the school asks', async () => {
      readPolicy({ requireAllGuardians: true });
      tree = await render();
      expect(hasText(tree, sv('leave.allGuardiansHint'))).toBe(true);
      expect(sv('leave.allGuardiansHint')).toBe(
        'Skolan ber alla vårdnadshavare samtycka innan en ansökan går till beslut. Den som skickar ansökan räknas som att ha samtyckt.',
      );
      await act(async () => tree?.unmount());
      readPolicy({ requireAllGuardians: false });
      tree = await render();
      expect(hasText(tree, sv('leave.allGuardiansHint'))).toBe(false);
    });
  });
});

describe('what the gateway answers a request', () => {
  const fill = async (t: Tree): Promise<void> => type(t, REASON, 'Familjeresa');

  it('tells that it was submitted, as it did, when the answer says nothing of consent or a late request', async () => {
    tree = await render();
    await fill(tree);
    await press(pressable(tree, SUBMIT));
    expect(Alert.alert).toHaveBeenCalledWith('Ledighet', 'Ledighetsansökan är skickad.');
  });

  it('adds that every guardian is asked when the school asked for consent, and that a late request was flagged', async () => {
    jest.mocked(requestLeave).mockResolvedValue({ id: 'new', studentId: 'c1', status: 'PENDING', consentRequired: true, shortNotice: true });
    tree = await render();
    await fill(tree);
    await press(pressable(tree, SUBMIT));
    expect(Alert.alert).toHaveBeenCalledWith(
      'Ledighet',
      'Ledighetsansökan är skickad. Skolan ber alla vårdnadshavare samtycka innan ansökan går till beslut. Ansökan kom senare än skolans minimum och har flaggats för den som beslutar.',
    );
  });

  it('reads the list again after a request, so the new one is there', async () => {
    tree = await render();
    expect(fetchLeaveRequests).toHaveBeenCalledTimes(1);
    read([leave('new')]);
    await fill(tree);
    await press(pressable(tree, SUBMIT));
    expect(fetchLeaveRequests).toHaveBeenCalledTimes(2);
    expect(hasText(tree, 'Familjeresa')).toBe(true);
  });
});

describe('what the form says of a refusal', () => {
  const refuse = (code: string, params?: Record<string, string | number>) =>
    jest.mocked(requestLeave).mockRejectedValue(new ApiError(400, 'Gatewayns egen mening.', code, params));

  /** The sentence as a live alert: the text, inside a region that is read out. */
  const alertOf = (t: Tree, text: string): { alert: Instance | null; region: Instance | null } => {
    const node = t.root.find((n) => isHostOf(n, 'Text') && textOf(n) === text);
    return {
      alert: ancestorWhere(node, (n) => n.props.accessibilityRole === 'alert'),
      region: ancestorWhere(node, (n) => n.props.accessibilityLiveRegion === 'polite'),
    };
  };

  it.each([
    ['sv', 'Ansökan kom för sent. Skolan vill ha den minst 7 dagar före första dagen.'],
    ['en', 'The request came too late. The school wants it at least 7 days before the first day.'],
  ] as const)('words LEAVE_REQUEST_TOO_LATE with the days the gateway named, in %s', async (language, sentence) => {
    mockLocale = language;
    refuse('LEAVE_REQUEST_TOO_LATE', { days: 7 });
    tree = await render();
    await type(tree, translatorFor(language)('leave.reason'), 'Familjeresa');
    await press(pressable(tree, translatorFor(language)('leave.submit')));
    expect(hasText(tree, sentence)).toBe(true);
    // Not the gateway’s own sentence, and not a dialog that hides the form it is about.
    expect(texts(tree)).not.toContain('Gatewayns egen mening.');
    expect(Alert.alert).not.toHaveBeenCalled();
    const { alert, region } = alertOf(tree, sentence);
    expect(alert).not.toBeNull();
    expect(region).not.toBeNull();
  });

  it('announces the refusal on iOS, which has no live regions, and not on Android, whose region says it', async () => {
    refuse('LEAVE_REQUEST_TOO_LATE', { days: 7 });
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await press(pressable(tree, SUBMIT));
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Ansökan kom för sent. Skolan vill ha den minst 7 dagar före första dagen.',
    );
    jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
    const spy = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      await press(pressable(tree, SUBMIT));
      expect(hasText(tree, 'Ansökan kom för sent. Skolan vill ha den minst 7 dagar före första dagen.')).toBe(true);
      expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
    } finally {
      spy.restore();
    }
  });

  it('falls back to the policy’s own minimum when the refusal named no days', async () => {
    readPolicy({ minDaysAhead: 10 });
    refuse('LEAVE_REQUEST_TOO_LATE');
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await press(pressable(tree, SUBMIT));
    expect(hasText(tree, 'Ansökan kom för sent. Skolan vill ha den minst 10 dagar före första dagen.')).toBe(true);
  });

  it('shows the contact’s fields, required, when the gateway asks for a contact the policy read did not promise', async () => {
    refuse('LEAVE_CONTACT_REQUIRED');
    tree = await render();
    expect(fieldLabels(tree)).toHaveLength(3);
    await type(tree, REASON, 'Familjeresa');
    await press(pressable(tree, SUBMIT));
    expect(hasText(tree, 'Skolan ber om en kontakt under ledigheten. Fyll i namn, telefonnummer och relation.')).toBe(true);
    expect(fieldLabels(tree).slice(3)).toEqual([
      'Kontaktens namn (obligatoriskt)',
      'Kontaktens telefonnummer (obligatoriskt)',
      'Kontaktens relation till barnet (obligatoriskt)',
    ]);
  });

  it('words a contact that was given in part, and keeps what was typed', async () => {
    readPolicy({ contact: 'OPTIONAL' });
    refuse('LEAVE_CONTACT_INCOMPLETE');
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await type(tree, NAME, 'Anna Lind');
    await press(pressable(tree, SUBMIT));
    expect(hasText(tree, 'En kontakt behöver namn, telefonnummer och relation. Fyll i alla tre eller töm alla.')).toBe(true);
    expect(fieldOf(tree, NAME).props.value).toBe('Anna Lind');
    expect(fieldOf(tree, REASON).props.value).toBe('Familjeresa');
  });

  it('says the generic sentence for a refusal it has no words for, and that the connection failed for a phone with none', async () => {
    jest.mocked(requestLeave).mockRejectedValueOnce(new ApiError(500, 'HTTP 500'));
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await press(pressable(tree, SUBMIT));
    expect(hasText(tree, sv('leave.submitFailed'))).toBe(true);
    jest.mocked(requestLeave).mockRejectedValueOnce(new TypeError('Network request failed'));
    await press(pressable(tree, SUBMIT));
    expect(hasText(tree, sv('leave.submitFailed'))).toBe(false);
    expect(hasText(tree, sv('leave.error.offline'))).toBe(true);
  });

  it('clears the sentence at the next try, and keeps the form filled in so it can be mended', async () => {
    refuse('LEAVE_REQUEST_TOO_LATE', { days: 7 });
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await press(pressable(tree, SUBMIT));
    expect(fieldOf(tree, REASON).props.value).toBe('Familjeresa');
    jest.mocked(requestLeave).mockReset();
    jest.mocked(requestLeave).mockResolvedValue({ id: 'new', studentId: 'c1', status: 'PENDING' });
    await press(pressable(tree, SUBMIT));
    expect(texts(tree).filter((w) => w.startsWith('Ansökan kom för sent'))).toEqual([]);
    expect(fieldOf(tree, REASON).props.value).toBe('');
  });

  it('keeps the old dialog for a form that is not filled in, which the gateway never saw', async () => {
    tree = await render();
    await press(pressable(tree, SUBMIT));
    expect(requestLeave).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Ledighet', sv('leave.pickChildAndReason'));
  });
});

describe('a request in the list', () => {
  it('is the row it was when the gateway sends none of Ledighetspolicy’s fields', async () => {
    read([leave('l1', { status: 'APPROVED', decidedAs: 'MENTOR', decisionNote: 'Trevlig resa' })]);
    tree = await render();
    const words = texts(tree);
    expect(words).toEqual(
      expect.arrayContaining(['Ella Svensson', 'Beviljad', '2026-11-02 – 2026-11-06', 'Familjeresa', 'Beslutad av mentor', 'Kommentar: Trevlig resa']),
    );
    for (const text of words) {
      for (const key of ['leave.consent.waiting', 'leave.consent.allGiven', 'leave.guardianDeclined', 'leave.flagged'] as const) {
        expect(text).not.toBe(sv(key));
      }
      expect(text).not.toContain('Kontakt under ledigheten:');
    }
    expect(buttons(tree).map((b) => b.props.accessibilityLabel)).not.toContain(AGREE);
  });

  describe('that waits for every guardian’s consent', () => {
    it('says so to whoever applied, or to a guardian who is not asked, and offers no answer', async () => {
      read([leave('l1', { consent: consent('WAITING', 'NOT_ASKED') })]);
      tree = await render();
      expect(hasText(tree, 'Väntar på vårdnadshavarnas samtycke')).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
      expect(buttonsLabelled(tree, DECLINE)).toHaveLength(0);
      expect(hasText(tree, sv('leave.consent.agree'))).toBe(false);
    });

    it('says to the guardian who has said yes that they have, and that the request still waits', async () => {
      read([leave('l1', { consent: consent('WAITING', 'GIVEN') })]);
      tree = await render();
      expect(hasText(tree, 'Du har samtyckt')).toBe(true);
      expect(hasText(tree, 'Väntar på vårdnadshavarnas samtycke')).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
    });

    it('says that every guardian has consented when they have, and nothing of it when the school did not ask', async () => {
      read([leave('l1', { consent: consent('GIVEN', 'NOT_ASKED') }), leave('l2', { consent: consent('NOT_REQUIRED', 'NOT_ASKED', false) })]);
      tree = await render();
      expect(texts(tree).filter((w) => w === 'Alla vårdnadshavare har samtyckt')).toHaveLength(1);
      expect(texts(tree).filter((w) => w === 'Väntar på vårdnadshavarnas samtycke')).toHaveLength(0);
    });
  });

  describe('that a guardian is asked to consent to', () => {
    const asked = (id = 'l1') => leave(id, { consent: consent('WAITING', 'WAITING') });

    it('shows the question and two buttons with text, and says that the answer cannot be changed', async () => {
      read([asked()]);
      tree = await render();
      expect(hasText(tree, sv('leave.consent.ask'))).toBe(true);
      expect(sv('leave.consent.ask')).toContain('svaret kan inte ändras');
      expect(hasText(tree, 'Samtycker')).toBe(true);
      expect(hasText(tree, 'Samtycker inte')).toBe(true);
      const yes = buttonsLabelled(tree, AGREE);
      const no = buttonsLabelled(tree, DECLINE);
      expect([yes.length, no.length]).toEqual([1, 1]);
      expect(yes[0]!.props.accessibilityRole).toBe('button');
      expect(AGREE).toBe('Samtycker till ledighetsansökan för Ella Svensson, 2026-11-02 till 2026-11-06. Svaret kan inte ändras.');
      expect(DECLINE).toContain('Ansökan avslutas och svaret kan inte ändras.');
      // The words are not the waiting line: a guardian who is asked is asked, not told it waits.
      expect(hasText(tree, 'Väntar på vårdnadshavarnas samtycke')).toBe(false);
    });

    it('records a yes at once, without a question, and shows the answer instead of the buttons', async () => {
      read([asked()]);
      tree = await render();
      jest.mocked(answerLeaveConsent).mockResolvedValue({ id: 'l1', answer: 'GIVEN', state: 'WAITING' });
      read([leave('l1', { consent: consent('WAITING', 'GIVEN') })]);
      await press(buttonsLabelled(tree, AGREE)[0]!);
      expect(answerLeaveConsent).toHaveBeenCalledTimes(1);
      expect(answerLeaveConsent).toHaveBeenCalledWith('l1', true);
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(hasText(tree, 'Du har samtyckt')).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
      expect(buttonsLabelled(tree, DECLINE)).toHaveLength(0);
      // Read again after the answer: the gateway’s own word.
      expect(fetchLeaveRequests).toHaveBeenCalledTimes(2);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Du har samtyckt till ansökan');
    });

    it('shows the answer at once even when the read after it is slow, and not the buttons back', async () => {
      read([asked()]);
      tree = await render();
      const slow = deferred<LeaveRequestRow[]>();
      jest.mocked(fetchLeaveRequests).mockReturnValue(slow.promise);
      await press(buttonsLabelled(tree, AGREE)[0]!);
      expect(hasText(tree, 'Du har samtyckt')).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
      slow.resolve([leave('l1', { consent: consent('GIVEN', 'GIVEN') })]);
      await settle();
      expect(hasText(tree, 'Alla vårdnadshavare har samtyckt')).toBe(true);
    });

    it('asks before a no, in words that say it ends the request and cannot be taken back, and does nothing on “Avbryt”', async () => {
      read([asked()]);
      tree = await render();
      await press(buttonsLabelled(tree, DECLINE)[0]!);
      expect(answerLeaveConsent).not.toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      const [title, body, options] = jest.mocked(Alert.alert).mock.calls[0]!;
      expect(title).toBe('Samtycker du inte?');
      expect(body).toBe('Ansökan för Ella Svensson avslutas och går inte till beslut. Svaret kan inte ändras.');
      expect(options!.map((o) => [o.text, o.style])).toEqual([
        ['Avbryt', 'cancel'],
        ['Samtycker inte', 'destructive'],
      ]);
      await act(async () => {
        options![0]!.onPress?.();
      });
      await settle();
      expect(answerLeaveConsent).not.toHaveBeenCalled();
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(1);
    });

    it('records a no only when it is confirmed, and ends the request on the screen as the gateway does', async () => {
      read([asked()]);
      tree = await render();
      jest.mocked(answerLeaveConsent).mockResolvedValue({ id: 'l1', answer: 'REFUSED', state: 'REFUSED' });
      read([leave('l1', { status: 'GUARDIAN_DECLINED', consent: consent('REFUSED', 'REFUSED') })]);
      await press(buttonsLabelled(tree, DECLINE)[0]!);
      const options = jest.mocked(Alert.alert).mock.calls[0]![2]!;
      await act(async () => {
        options[1]!.onPress?.();
      });
      await settle();
      expect(answerLeaveConsent).toHaveBeenCalledTimes(1);
      expect(answerLeaveConsent).toHaveBeenCalledWith('l1', false);
      expect(hasText(tree, 'Avslutad: en vårdnadshavare samtyckte inte')).toBe(true);
      expect(hasText(tree, 'Du har inte samtyckt')).toBe(true);
      expect(hasText(tree, sv('leave.status.GUARDIAN_DECLINED'))).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Du har inte samtyckt, och ansökan har avslutats');
    });

    it('closes both buttons while an answer is in the air, and drops a second tap on the same request', async () => {
      read([asked()]);
      tree = await render();
      const inAir = deferred<{ id: string; answer: 'GIVEN'; state: 'GIVEN' }>();
      jest.mocked(answerLeaveConsent).mockReturnValue(inAir.promise);
      const yes = buttonsLabelled(tree, AGREE)[0]!;
      await act(async () => {
        yes.props.onPress();
        yes.props.onPress();
      });
      expect(answerLeaveConsent).toHaveBeenCalledTimes(1);
      // The pressed one shows its spinner and keeps its label; both are closed and say they are busy.
      for (const label of [AGREE, DECLINE]) {
        const [button] = buttonsLabelled(tree, label);
        expect(button!.props.disabled).toBe(true);
        expect(button!.props.accessibilityState.disabled).toBe(true);
      }
      expect(buttonsLabelled(tree, AGREE)[0]!.props.accessibilityState.busy).toBe(true);
      expect(buttonsLabelled(tree, DECLINE)[0]!.props.accessibilityState.busy).toBe(false);
      await act(async () => {
        inAir.resolve({ id: 'l1', answer: 'GIVEN', state: 'GIVEN' });
      });
      await settle();
      expect(answerLeaveConsent).toHaveBeenCalledTimes(1);
    });

    it('leaves another request’s buttons open while one answer is in the air', async () => {
      const second = leave('l2', { consent: consent('WAITING', 'WAITING'), startDate: '2026-12-01T00:00:00.000Z', endDate: '2026-12-02T00:00:00.000Z' });
      read([asked('l1'), second]);
      tree = await render();
      jest.mocked(answerLeaveConsent).mockReturnValue(new Promise(() => undefined));
      await press(buttonsLabelled(tree, AGREE)[0]!);
      const other = buttonsLabelled(
        tree,
        sv('leave.consent.agreeA11y', { name: 'Ella Svensson', from: '2026-12-01', to: '2026-12-02' }),
      )[0]!;
      expect(other.props.disabled).toBeFalsy();
    });

    it.each([
      ['LEAVE_CONSENT_REQUEST_ENDED', 409, 'Ansökan är redan beslutad eller avslutad, så den väntar inte längre på ditt svar.', true],
      ['LEAVE_CONSENT_CUSTODY_ENDED', 409, 'Din vårdnad har upphört, så du kan inte svara på ansökan.', true],
      ['LEAVE_CONSENT_ANSWERED', 409, 'Du har redan svarat på ansökan, och svaret kan inte ändras.', true],
      ['LEAVE_CONSENT_NOT_FOUND', 404, 'Du har inte fått frågan om den här ansökan.', true],
      ['LEAVE_CONSENT_NOT_A_GUARDIAN', 403, 'Bara en vårdnadshavare kan svara på ansökan.', false],
    ])('words %s on the request, as a live alert, and reads the list again only when the request moved on', async (code, status, sentence, moved) => {
      read([asked()]);
      tree = await render();
      jest.mocked(answerLeaveConsent).mockRejectedValue(new ApiError(status, 'Gatewayns egen mening.', code));
      await press(buttonsLabelled(tree, AGREE)[0]!);
      expect(hasText(tree, sentence)).toBe(true);
      expect(texts(tree)).not.toContain('Gatewayns egen mening.');
      const node = tree.root.find((n) => isHostOf(n, 'Text') && textOf(n) === sentence);
      expect(ancestorWhere(node, (n) => n.props.accessibilityRole === 'alert')).not.toBeNull();
      expect(ancestorWhere(node, (n) => n.props.accessibilityLiveRegion === 'polite')).not.toBeNull();
      expect(fetchLeaveRequests).toHaveBeenCalledTimes(moved ? 2 : 1);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(sentence);
    });

    it('says a phone with no network could not send the answer, and leaves the buttons to press again', async () => {
      read([asked()]);
      tree = await render();
      jest.mocked(answerLeaveConsent).mockRejectedValueOnce(new TypeError('Network request failed'));
      await press(buttonsLabelled(tree, AGREE)[0]!);
      expect(hasText(tree, 'Svaret gick inte att skicka. Kontrollera anslutningen och försök igen.')).toBe(true);
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(1);
      expect(buttonsLabelled(tree, AGREE)[0]!.props.disabled).toBeFalsy();
      // Nothing was kept: the same tap goes through when the network is back.
      await press(buttonsLabelled(tree, AGREE)[0]!);
      expect(answerLeaveConsent).toHaveBeenCalledTimes(2);
      expect(hasText(tree, 'Svaret gick inte att skicka. Kontrollera anslutningen och försök igen.')).toBe(false);
    });

    it('does not offer the buttons for a request that is no longer undecided, whatever the row says of consent', async () => {
      read([leave('l1', { status: 'APPROVED', consent: consent('WAITING', 'WAITING') })]);
      tree = await render();
      expect(buttonsLabelled(tree, AGREE)).toHaveLength(0);
    });

    it('is worded in English for an English reader', async () => {
      mockLocale = 'en';
      read([asked()]);
      tree = await render();
      expect(hasText(tree, 'I consent')).toBe(true);
      expect(hasText(tree, 'I do not consent')).toBe(true);
      expect(hasText(tree, en('leave.consent.ask'))).toBe(true);
    });
  });

  describe('where a guardian has answered, or can no longer answer', () => {
    it('shows no buttons for a guardian who has already said yes or no', async () => {
      read([leave('l1', { consent: consent('WAITING', 'GIVEN') }), leave('l2', { consent: consent('GIVEN', 'GIVEN') })]);
      tree = await render();
      expect(buttons(tree).filter((b) => /Samtycker/.test(String(b.props.accessibilityLabel)))).toHaveLength(0);
      expect(texts(tree).filter((w) => w === 'Du har samtyckt')).toHaveLength(2);
    });

    it('tells a guardian whose custody ended that the request does not wait for them, with no buttons', async () => {
      read([leave('l1', { consent: consent('WAITING', 'ENDED') })]);
      tree = await render();
      expect(hasText(tree, 'Din vårdnad har upphört, så ansökan väntar inte på ditt svar')).toBe(true);
      expect(buttons(tree).filter((b) => /Samtycker/.test(String(b.props.accessibilityLabel)))).toHaveLength(0);
      expect(hasText(tree, 'Väntar på vårdnadshavarnas samtycke')).toBe(false);
    });
  });

  describe('that ended because a guardian did not consent', () => {
    it('says that, and never who', async () => {
      read([leave('l1', { status: 'GUARDIAN_DECLINED', consent: consent('REFUSED', 'NOT_ASKED') })]);
      tree = await render();
      expect(hasText(tree, 'Avslutad: en vårdnadshavare samtyckte inte')).toBe(true);
      expect(hasText(tree, 'Avslutad')).toBe(true);
      for (const word of texts(tree)) {
        expect(word).not.toMatch(/den andra|hon|han|pappa|mamma|Anna|Bertil/i);
      }
      expect(buttons(tree).filter((b) => /Samtycker/.test(String(b.props.accessibilityLabel)))).toHaveLength(0);
      expect(hasText(tree, 'Väntar på vårdnadshavarnas samtycke')).toBe(false);
    });

    it('says it in English', async () => {
      mockLocale = 'en';
      read([leave('l1', { status: 'GUARDIAN_DECLINED', consent: consent('REFUSED', 'NOT_ASKED') })]);
      tree = await render();
      expect(hasText(tree, 'Ended: a guardian did not consent')).toBe(true);
      expect(hasText(tree, 'Ended')).toBe(true);
    });

    it('draws a status this build does not know as its key, and does not fail', async () => {
      read([leave('l1', { status: 'FROM_A_NEWER_GATEWAY' as LeaveRequestRow['status'] })]);
      tree = await render();
      expect(hasText(tree, 'Ella Svensson')).toBe(true);
    });
  });

  describe('with the contact the family wrote and the flag of a late request', () => {
    it('shows the contact as one line under “Kontakt under ledigheten”, to the family that wrote it', async () => {
      read([leave('l1', { contact: { name: 'Anna Lind', phone: '070-123 45 67', relation: 'Faster' } })]);
      tree = await render();
      expect(hasText(tree, 'Kontakt under ledigheten: Anna Lind, 070-123 45 67, Faster')).toBe(true);
    });

    it('draws no contact line for a request without one', async () => {
      read([leave('l1', { contact: null })]);
      tree = await render();
      expect(texts(tree).filter((w) => w.includes('Kontakt under ledigheten:'))).toEqual([]);
    });

    it('says that a request came later than the school’s minimum when the answer says so', async () => {
      read([leave('l1', { shortNotice: true }), leave('l2', { shortNotice: false })]);
      tree = await render();
      expect(texts(tree).filter((w) => w === 'Kom senare än skolans minimum och är flaggad för den som beslutar')).toHaveLength(1);
    });
  });

  it('never draws a count of the guardians who have answered, which is the staff’s to see', async () => {
    const counted = { ...consent('WAITING', 'NOT_ASKED'), asked: 3, given: 2, waiting: 1 } as unknown as NonNullable<LeaveRequestRow['consent']>;
    read([leave('l1', { consent: counted })]);
    tree = await render();
    expect(texts(tree).filter((w) => /\b[123]\b.*vårdnadshavare|vårdnadshavare.*\b[123]\b/.test(w))).toEqual([]);
    expect(texts(tree).filter((w) => /^[123]$/.test(w))).toEqual([]);
  });
});

describe('reading again', () => {
  it('reads the list and the policy again whenever the tab is seen, so a push about a request finds it there', async () => {
    tree = await render();
    expect(fetchLeaveRequests).toHaveBeenCalledTimes(1);
    expect(fetchLeavePolicy).toHaveBeenCalledTimes(1);
    expect(buttons(tree).filter((b) => /Samtycker/.test(String(b.props.accessibilityLabel)))).toHaveLength(0);
    read([leave('l1', { consent: consent('WAITING', 'WAITING') })]);
    readPolicy({ requireAllGuardians: true });
    await act(async () => {
      mockFocusEffect?.();
    });
    await settle();
    expect(fetchLeaveRequests).toHaveBeenCalledTimes(2);
    expect(fetchLeavePolicy).toHaveBeenCalledTimes(2);
    expect(buttonsLabelled(tree, AGREE)).toHaveLength(1);
    expect(hasText(tree, sv('leave.allGuardiansHint'))).toBe(true);
  });

  it('keeps the form’s typing over a read', async () => {
    tree = await render();
    await type(tree, REASON, 'Familjeresa');
    await act(async () => {
      mockFocusEffect?.();
    });
    await settle();
    expect(fieldOf(tree, REASON).props.value).toBe('Familjeresa');
  });
});
