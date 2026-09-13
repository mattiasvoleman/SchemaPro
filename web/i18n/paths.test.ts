import { describe, expect, it } from "vitest";
import { localePath } from "./paths";
import { routing } from "./routing";

/**
 * localePath exists so the unauthenticated pages can link without importing
 * next-intl's navigation, and it is only right while routing.ts keeps the two
 * properties it builds on: every locale is prefixed, and no pathname is
 * localized. The first test fails the day either changes.
 *
 * next-intl's own getPathname cannot be called here to compare against: its
 * ESM build imports "next/navigation" without an extension, which Node refuses
 * outside the Next compiler — the same reason other suites mock
 * @/i18n/navigation.
 */

describe("localePath", () => {
  it("builds on a routing config that prefixes every locale and localizes no pathname", () => {
    expect(routing.localePrefix).toBe("always");
    expect(Object.keys(routing)).not.toContain("pathnames");
  });

  it.each(routing.locales)("puts %s in front of the path, and alone for the root", (locale) => {
    expect(localePath(locale, "/")).toBe(`/${locale}`);
    expect(localePath(locale, "/login")).toBe(`/${locale}/login`);
    expect(localePath(locale, "/forgot-password")).toBe(`/${locale}/forgot-password`);
    expect(localePath(locale, "/update-password")).toBe(`/${locale}/update-password`);
  });
});
