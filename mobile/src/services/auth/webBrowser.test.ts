import { loadWebBrowser } from './webBrowser';

// What expo-web-browser does in a binary built without it.
jest.mock('expo-web-browser', () => {
  throw new Error("Cannot find native module 'ExpoWebBrowser'");
});

/**
 * Importing this module (and the auth service that imports it) must not
 * load the native module: only the call does, so an older build starts and
 * only the school-account button fails.
 */
describe('loadWebBrowser', () => {
  it('loads expo-web-browser when called, not when imported', () => {
    expect(() => loadWebBrowser()).toThrow('ExpoWebBrowser');
  });
});
