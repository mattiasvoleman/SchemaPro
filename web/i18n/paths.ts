/**
 * A locale-prefixed path, for pages that must not import ./navigation.
 *
 * ./navigation is next-intl's createNavigation, and importing anything from it
 * — even the pure getPathname — puts its <Link>'s client boundary into the
 * page: next-intl's BaseLink and use-intl's provider, ~15KB gzipped, on a page
 * that renders no next-intl link at all. BaseLink also reads the locale from
 * the client-side provider, which the unauthenticated routes do not mount.
 *
 * routing.ts prefixes every locale and declares no localized pathnames, so a
 * path is the locale followed by the href. paths.test.ts pins both properties
 * of routing.ts and fails the day either changes.
 */
export function localePath(locale: string, href: `/${string}`): string {
  return href === "/" ? `/${locale}` : `/${locale}${href}`;
}
