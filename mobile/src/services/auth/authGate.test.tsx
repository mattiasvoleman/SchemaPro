/**
 * Where AuthGate sends a person, drawn from app/_layout.tsx as it ships.
 *
 * appGate.test.ts pins homeOf as a table. What it cannot pin is how the layout
 * uses it: an effect that moves a signed-in person out of a shell their role
 * does not belong in. The staff shell, the pupil shell and the guardian shell
 * are three route groups in one bundle (both apps ship the same JavaScript),
 * so this redirect is the only thing that keeps a guardian off the register
 * and a teacher off the guardian's leave form. The server decides what a role
 * may read either way; this is the layer in front of it, and without a test a
 * change to the effect (its condition, or the dependencies it re-runs on)
 * would go through green.
 *
 * The default export is mounted whole, so the file under test is the one the
 * apps run. Its providers are replaced by pass-throughs and the router by a
 * recorder: what is pinned is which route the gate replaces to, and when.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as Notifications from 'expo-notifications';
import RootLayout from '../../../app/_layout';
import { forgetTap, startSignedIn, takeLastTap } from '../pushRegistration';
import { rememberCrisisPush } from '../crisisOffline';

type AuthShape = { authState: { isAuthenticated: boolean; teacherId: string | null; role: string | null }; isLoading: boolean };

let mockAuth: AuthShape;
let mockSegments: string[];
const mockReplace = jest.fn();
const mockPush = jest.fn();
// One object for every render, as expo-router's router is: a new one per render
// would re-run every effect that lists it, whatever else it lists.
const mockRouter = { replace: mockReplace, push: mockPush };

jest.mock('expo-router', () => ({
  Slot: () => null,
  useRouter: () => mockRouter,
  useSegments: () => mockSegments,
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
// What the phone remembers of an alarm push (its database is not under test here).
jest.mock('../crisisOffline', () => ({ rememberCrisisPush: jest.fn(async () => undefined) }));
jest.mock('../pushRegistration', () => ({
  ensureAndroidChannel: jest.fn(async () => undefined),
  forgetTap: jest.fn(),
  startSignedIn: jest.fn(async () => undefined),
  takeLastTap: jest.fn((): { type: string | null; notification?: unknown } | null => null),
}));
jest.mock('../../context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockAuth,
}));
jest.mock('../../context/LocaleContext', () => {
  const value = { t: (key: string) => key, locale: 'sv', setLocale: jest.fn() };
  return { LocaleProvider: ({ children }: { children: React.ReactNode }) => children, useI18n: () => value };
});
jest.mock('../../context/NetworkContext', () => ({ NetworkProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../context/SyncContext', () => ({ SyncProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../../theme/ThemeContext', () => ({
  AppThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppTheme: () => ({ statusBar: 'dark' }),
}));

const signedIn = (role: string | null): AuthShape => ({ authState: { isAuthenticated: true, teacherId: 'u1', role }, isLoading: false });
const signedOut: AuthShape = { authState: { isAuthenticated: false, teacherId: null, role: null }, isLoading: false };

let tree: TestRenderer.ReactTestRenderer | null = null;

async function mount(auth: AuthShape, segments: string[]): Promise<void> {
  mockAuth = auth;
  mockSegments = segments;
  await act(async () => {
    tree = TestRenderer.create(<RootLayout />);
  });
}

async function rerender(auth: AuthShape, segments: string[] = mockSegments): Promise<void> {
  mockAuth = auth;
  mockSegments = segments;
  await act(async () => {
    tree?.update(<RootLayout />);
  });
}

beforeEach(() => {
  mockReplace.mockClear();
  mockPush.mockClear();
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});

describe('AuthGate (app/_layout.tsx)', () => {
  describe('a signed-in person in a shell that is not their role\'s', () => {
    it.each([
      ['GUARDIAN', '(app)', '/(guardian)/children'],
      ['GUARDIAN', '(student)', '/(guardian)/children'],
      ['STUDENT', '(guardian)', '/(student)/schedule'],
      ['STUDENT', '(app)', '/(student)/schedule'],
      ['TEACHER', '(guardian)', '/(app)/schedule'],
      ['TEACHER', '(student)', '/(app)/schedule'],
      ['SCHOOL_ADMIN', '(guardian)', '/(app)/schedule'],
    ])('%s in %s is sent to %s', async (role, group, home) => {
      await mount(signedIn(role), [group, 'whatever']);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith(home);
    });

    it('is sent home from the login screen too', async () => {
      await mount(signedIn('GUARDIAN'), ['(auth)', 'login']);
      expect(mockReplace).toHaveBeenCalledWith('/(guardian)/children');
    });
  });

  describe('a signed-in person in their own shell', () => {
    it.each([
      ['GUARDIAN', '(guardian)'],
      ['STUDENT', '(student)'],
      ['TEACHER', '(app)'],
      ['SCHOOL_ADMIN', '(app)'],
    ])('%s in %s stays', async (role, group) => {
      await mount(signedIn(role), [group, 'whatever']);
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('a person who is not signed in', () => {
    it.each(['(app)', '(student)', '(guardian)'])('is sent to the login screen from %s', async (group) => {
      await mount(signedOut, [group, 'whatever']);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    });

    it('stays on the login screen', async () => {
      await mount(signedOut, ['(auth)', 'login']);
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  it('decides nothing while the session is still being restored', async () => {
    await mount({ ...signedIn('GUARDIAN'), isLoading: true }, ['(app)', 'schedule']);
    await rerender({ ...signedOut, isLoading: true }, ['(guardian)', 'children']);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  describe('when something the decision rests on changes under the same screen', () => {
    it('moves a person whose role arrives after the session did (role is a dependency of the effect)', async () => {
      // The restored session is authenticated before its role is known to the
      // gate, so the first pass has the staff shell as the home; the role then
      // changes with nothing else changing.
      await mount(signedIn(null), ['(app)', 'schedule']);
      expect(mockReplace).not.toHaveBeenCalled();
      await rerender(signedIn('GUARDIAN'));
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/(guardian)/children');
    });

    it('sends a person to the login screen when the session ends under a screen', async () => {
      await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
      expect(mockReplace).not.toHaveBeenCalled();
      await rerender(signedOut);
      expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    });

    it('moves a person who signs in as another role on the same screen', async () => {
      await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
      await rerender(signedIn('STUDENT'));
      expect(mockReplace).toHaveBeenCalledWith('/(student)/schedule');
    });

    it('moves a person whose route changes under the same session (segments is a dependency of the effect)', async () => {
      // A link or a tap on a push takes a signed-in guardian into the staff
      // shell with nothing else about them changing. Every other re-render in
      // this file changes the session too, so only this one needs the route
      // itself to re-run the gate.
      await mount(signedIn('GUARDIAN'), ['(guardian)', 'children']);
      expect(mockReplace).not.toHaveBeenCalled();
      await rerender(mockAuth, ['(app)', 'attendance']);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/(guardian)/children');
    });

    it('decides when the restore ends, for the same session on the same screen (isLoading is a dependency)', async () => {
      // The restored session is the one the screen was already drawn for; the
      // only thing that changes is that the app now knows it is settled.
      await mount({ ...signedIn('GUARDIAN'), isLoading: true }, ['(app)', 'schedule']);
      expect(mockReplace).not.toHaveBeenCalled();
      await rerender({ ...signedIn('GUARDIAN'), isLoading: false });
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/(guardian)/children');
    });
  });

  describe('a tap on a notification', () => {
    /** The function the app handed expo-notifications to call on a tap, with the notice type its push carried (none by default). */
    const tapListener = (type?: string): (() => void) => {
      const calls = jest.mocked(Notifications.addNotificationResponseReceivedListener).mock.calls;
      const listener = calls[calls.length - 1]?.[0];
      if (!listener) throw new Error('no listener was registered');
      const response = type ? { notification: { request: { content: { data: { notificationId: 'n-1', type } } } } } : {};
      return () => listener(response as never);
    };

    it.each([
      ['GUARDIAN', '(guardian)', '/(guardian)/notifications'],
      ['STUDENT', '(student)', '/(student)/notifications'],
      ['TEACHER', '(app)', '/(app)/notifications'],
      ['SCHOOL_ADMIN', '(app)', '/(app)/notifications'],
    ])('opens the Notiser tab of the shell of a signed-in %s', async (role, group, notifications) => {
      await mount(signedIn(role), [group, 'whatever']);
      expect(mockPush).not.toHaveBeenCalled();
      await act(async () => tapListener()());
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith(notifications);
      // The tap is forgotten once it has led somewhere, so no later sign-in replays it.
      expect(forgetTap).toHaveBeenCalledTimes(1);
    });

    it('goes to the Notiser tab of the role the person has by then, when the role came after the session did', async () => {
      // The listener is registered for the role it was made with; with role
      // out of the effect's dependencies it would stay the staff shell's, and a
      // guardian's tap would open the register's notices.
      await mount(signedIn(null), ['(app)', 'schedule']);
      await rerender(signedIn('GUARDIAN'));
      await act(async () => tapListener()());
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/(guardian)/notifications');
    });

    it('is heard once: the listener a re-run replaces is removed, and the last one goes with the screen', async () => {
      await mount(signedIn(null), ['(app)', 'schedule']);
      await rerender(signedIn('GUARDIAN'));
      const subscriptions = jest.mocked(Notifications.addNotificationResponseReceivedListener).mock.results.map(
        (result) => result.value as { remove: jest.Mock },
      );
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0]!.remove).toHaveBeenCalledTimes(1);
      expect(subscriptions[1]!.remove).not.toHaveBeenCalled();
      await act(async () => tree?.unmount());
      tree = null;
      expect(subscriptions[1]!.remove).toHaveBeenCalledTimes(1);
    });

    it('opens the Notiser tab of a tap that launched the app, which arrived before there was a listener', async () => {
      jest.mocked(takeLastTap).mockReturnValueOnce({ type: null });
      await mount(signedIn('GUARDIAN'), ['(guardian)', 'children']);
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/(guardian)/notifications');
    });

    describe('on a cover question (Vikariefrågan)', () => {
      it.each(['COVER_REQUESTED', 'COVER_REQUEST_CLOSED'])('opens a teacher\'s Vikarie tab on a %s push', async (type) => {
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        await act(async () => tapListener(type)());
        expect(mockPush).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith('/(app)/cover-requests');
        expect(forgetTap).toHaveBeenCalledTimes(1);
      });

      it('opens the Vikarie tab of a cover push that launched the app', async () => {
        jest.mocked(takeLastTap).mockReturnValueOnce({ type: 'COVER_REQUESTED' });
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        expect(mockPush).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith('/(app)/cover-requests');
      });

      it('leaves every other push, and every other role, on its Notiser tab', async () => {
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        await act(async () => tapListener('LESSON_SUBSTITUTE')());
        expect(mockPush).toHaveBeenLastCalledWith('/(app)/notifications');
        await rerender(signedIn('SCHOOL_ADMIN'));
        await act(async () => tapListener('COVER_REQUEST_ACCEPTED')());
        expect(mockPush).toHaveBeenLastCalledWith('/(app)/notifications');
        // The administrator is not asked: a stray question push still lands on the inbox.
        await act(async () => tapListener('COVER_REQUESTED')());
        expect(mockPush).toHaveBeenLastCalledWith('/(app)/notifications');
      });
    });

    describe('on an alarm (Krisläge)', () => {
      it.each([
        ['TEACHER', 'CRISIS_ALARM'],
        ['TEACHER', 'CRISIS_ENDED'],
        ['SCHOOL_ADMIN', 'CRISIS_ALARM'],
        ['SCHOOL_ADMIN', 'CRISIS_ENDED'],
      ])('opens the Larm tab of a %s on a %s push', async (role, type) => {
        await mount(signedIn(role), ['(app)', 'schedule']);
        await act(async () => tapListener(type)());
        expect(mockPush).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith('/(app)/crisis');
        expect(forgetTap).toHaveBeenCalledTimes(1);
      });

      it('opens the Larm tab of an alarm push that launched the app, and remembers when it arrived', async () => {
        const notification = { date: 1_800_000_000, request: { content: { data: { notificationId: 'n-9', type: 'CRISIS_ALARM' } } } };
        jest.mocked(takeLastTap).mockReturnValueOnce({ type: 'CRISIS_ALARM', notification });
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        expect(mockPush).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith('/(app)/crisis');
        expect(rememberCrisisPush).toHaveBeenCalledWith(notification);
      });

      it('remembers the push of a tap, and of one that arrives while the app is open, without opening anything for the latter', async () => {
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        const arrived = jest.mocked(Notifications.addNotificationReceivedListener).mock.calls.at(-1)?.[0];
        if (!arrived) throw new Error('no listener for arriving pushes was registered');
        const notification = { date: 1_800_000_000, request: { content: { data: { type: 'CRISIS_ALARM' } } } };
        await act(async () => arrived(notification as never));
        expect(rememberCrisisPush).toHaveBeenCalledWith(notification);
        expect(mockPush).not.toHaveBeenCalled();

        await act(async () => tapListener('CRISIS_ALARM')());
        expect(rememberCrisisPush).toHaveBeenCalledTimes(2);
      });

      it('leaves a student and a guardian in their own shell, and a guardian\'s notice an inbox row', async () => {
        await mount(signedIn('STUDENT'), ['(student)', 'schedule']);
        await act(async () => tapListener('CRISIS_ALARM')());
        expect(mockPush).toHaveBeenLastCalledWith('/(student)/notifications');
        await rerender(signedIn('GUARDIAN'), ['(guardian)', 'children']);
        await act(async () => tapListener('CRISIS_GUARDIAN_AFTER')());
        expect(mockPush).toHaveBeenLastCalledWith('/(guardian)/notifications');
        await rerender(signedIn('TEACHER'), ['(app)', 'schedule']);
        await act(async () => tapListener('CRISIS_GUARDIAN_AFTER')());
        expect(mockPush).toHaveBeenLastCalledWith('/(app)/notifications');
      });

      it('stops listening for arriving pushes when the screen goes', async () => {
        await mount(signedIn('TEACHER'), ['(app)', 'schedule']);
        const arrival = jest.mocked(Notifications.addNotificationReceivedListener).mock.results.at(-1)?.value as { remove: jest.Mock };
        await act(async () => tree?.unmount());
        tree = null;
        expect(arrival.remove).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('the push side of a start', () => {
    it('begins for the person who is signed in', async () => {
      await mount(signedIn('GUARDIAN'), ['(guardian)', 'children']);
      expect(startSignedIn).toHaveBeenCalledTimes(1);
      expect(startSignedIn).toHaveBeenCalledWith('u1');
    });

    it('does not begin, listen or take a launching tap while nobody is signed in', async () => {
      // A launching tap is kept for the person who signs in; taking it signed
      // out would spend it on the login screen.
      await mount(signedOut, ['(auth)', 'login']);
      expect(startSignedIn).not.toHaveBeenCalled();
      expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
      expect(takeLastTap).not.toHaveBeenCalled();
    });
  });
});
