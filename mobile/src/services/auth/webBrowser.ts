/**
 * expo-web-browser, loaded on first use rather than when the app starts.
 *
 * Its module asks for the native module as it is imported, and throws when
 * the binary has none. Imported at the top of the auth service, that throw
 * would happen at launch in any build made before the dependency (a
 * development client or an internal build running newer JavaScript), before
 * the login screen could even show. Loaded here, only "Logga in med
 * skolkonto" fails in such a build, and it says that the app needs an update.
 */
export function loadWebBrowser(): typeof import('expo-web-browser') {
  // An inline require, Metro's way to load a module on first use.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-web-browser') as typeof import('expo-web-browser');
}
