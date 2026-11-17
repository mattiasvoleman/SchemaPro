/**
 * The staff shell's tab bar for each person who can be in it (app/(app)/_layout.tsx):
 * a teacher, an administrator, and an administrator marked as teaching
 * (Users.teaches). Tabs.Screen is replaced by a recorder, so what is pinned is
 * the options each tab is given: a tab with `href: null` is off the bar.
 *
 * The mark adds nothing to the bar. Larm is on it for every one of them (the
 * view behind it is what differs, CrisisScreen.teaching.test.tsx), and Vikarie
 * stays a teacher's: the gateway refuses every cover-request route to an
 * administrator, marked or not (SP409), so a tab that read nothing but a 403
 * would be worse than none. A student and a guardian have shells of their own.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

let mockRole: string | null = 'TEACHER';
let mockTeaches = false;

jest.mock('expo-router', () => {
  const Screen = (): null => null;
  const Tabs = ({ children }: { children: React.ReactNode }): React.ReactNode => children;
  Tabs.Screen = Screen;
  return { Tabs };
});
jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ authState: { isAuthenticated: true, teacherId: 'u1', role: mockRole, teaches: mockTeaches }, isLoading: false }),
}));
jest.mock('../context/LocaleContext', () => {
  const value = { t: (key: string) => key, locale: 'sv', setLocale: jest.fn() };
  return { useI18n: () => value };
});
jest.mock('./tabScreenOptions', () => ({ useTabScreenOptions: () => ({}) }));
jest.mock('./TabGlyph', () => ({ TabGlyph: () => null }));

import { Tabs } from 'expo-router';
import AppLayout from '../../app/(app)/_layout';

/** The tabs on the bar, in order, as the navigator would show them. */
function tabsOnTheBar(role: string | null, teaches: boolean): string[] {
  mockRole = role;
  mockTeaches = teaches;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(AppLayout));
  });
  const bar = tree.root
    .findAllByType(Tabs.Screen)
    .filter((screen) => (screen.props.options as { href?: null }).href !== null)
    .map((screen) => screen.props.name as string);
  act(() => tree.unmount());
  return bar;
}

const ALL = ['schedule', 'attendance', 'cover-requests', 'crisis', 'notifications', 'settings'];

describe('the staff shell’s tab bar', () => {
  it('gives a teacher every tab, Vikarie and Larm among them', () => {
    expect(tabsOnTheBar('TEACHER', false)).toEqual(ALL);
  });

  it('gives an administrator Larm and no Vikarie', () => {
    expect(tabsOnTheBar('SCHOOL_ADMIN', false)).toEqual(['schedule', 'attendance', 'crisis', 'notifications', 'settings']);
  });

  it('gives an administrator who teaches exactly the bar of one who does not: the mark opens no Vikarie', () => {
    expect(tabsOnTheBar('SCHOOL_ADMIN', true)).toEqual(['schedule', 'attendance', 'crisis', 'notifications', 'settings']);
    expect(tabsOnTheBar('SCHOOL_ADMIN', true)).toEqual(tabsOnTheBar('SCHOOL_ADMIN', false));
  });

  it('keeps a tab that is off the bar as a route (href: null), as before', () => {
    mockRole = 'SCHOOL_ADMIN';
    mockTeaches = true;
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(AppLayout));
    });
    const names = tree.root.findAllByType(Tabs.Screen).map((screen) => screen.props.name);
    act(() => tree.unmount());
    expect(names).toEqual(ALL);
  });

  // Not a persona of this shell: the gate sends them to their own (appGate.homeOf), and if one ever stood here it would have no Larm.
  it.each(['STUDENT', 'GUARDIAN', null])('gives %s no Larm and no Vikarie', (role) => {
    expect(tabsOnTheBar(role, false)).toEqual(['schedule', 'attendance', 'notifications', 'settings']);
    expect(tabsOnTheBar(role, true)).toEqual(['schedule', 'attendance', 'notifications', 'settings']);
  });
});
