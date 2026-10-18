import { KeyRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import type { ClosedPages } from "@/components/profile-context";
import {
  ADMIN_AREAS,
  WRITER_ORDER,
  profileDecides,
  profileWrites,
  type AdminArea,
  type AdminProfile,
  type ClosedPage,
  type ReadOnlyPage,
} from "@/lib/admin-areas";

/**
 * What AppShell shows in place of an admin page the profile does not use.
 *
 * A server component with no client part: the (app) layout renders it for
 * every gate the profile has closed pages behind (closedPagesFor), and
 * AppShell only picks one. A client part here would be named by every route's
 * manifest and re-slice the app's chunks (measured: +0.7 KB on each route).
 * So PageHeader's h1 and title are written out (the tab's title through
 * React's <title>, as PageHeader's DocumentTitle names it), and the way back
 * is a plain link: the overview loads in full, which this page is never in
 * the way of.
 */
export function AreaRefusal({
  gate,
  profile,
  overviewHref,
}: {
  gate: AdminArea | "DECIDES";
  profile: AdminProfile | null;
  overviewHref: string;
}) {
  const t = useTranslations("adminAreas");
  const tCommon = useTranslations("common");
  const profileName = t(`profile.${profile ?? "FULL"}`);
  return (
    <Page width="narrow">
      <title>{`${t("gateTitle")} · ${tCommon("appName")}`}</title>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("gateTitle")}</h1>
      </div>
      <EmptyState
        icon={KeyRound}
        headingLevel={2}
        title={gate === "DECIDES" ? t("decisions") : t(`area.${gate}`)}
        description={
          gate === "DECIDES"
            ? t("gateDecides", { profile: profileName })
            : t("gateArea", { area: t(`area.${gate}`), profile: profileName })
        }
        action={
          <Button asChild variant="outline">
            <a href={overviewHref}>{t("gateBack")}</a>
          </Button>
        }
      />
    </Page>
  );
}

/** A profile's closed pages for AppShell: each path with the refusal page of its gate. */
export function closedPagesFor(
  closed: readonly ClosedPage[],
  profile: AdminProfile | null,
  locale: string,
): ClosedPages {
  const byGate = new Map<ClosedPage["gate"], React.ReactNode>();
  for (const { gate } of closed) {
    if (!byGate.has(gate)) {
      byGate.set(gate, <AreaRefusal key={gate} gate={gate} profile={profile} overviewHref={`/${locale}/admin`} />);
    }
  }
  return Object.fromEntries(closed.map((page) => [page.path, byGate.get(page.gate)]));
}

/**
 * The menu without the profile's closed pages, as a style rule the (app)
 * layout renders on the server: a closed page's link is hidden, and so is a
 * group left with none. No code reaches the browser for it (see
 * components/profile-context.tsx ClosedPages for why the shell's chunk
 * takes none).
 * Hidden this way the links leave the accessibility tree as well; reaching a
 * closed page anyway gets the page that says why.
 */
export function closedMenuStyle(closed: readonly ClosedPage[], menuLabel: string): string {
  if (closed.length === 0) return "";
  const menu = `nav[aria-label="${menuLabel.replace(/["\\]/g, "\\$&")}"]`;
  const links = `:is(${closed.map((page) => `a[href$="${page.path}"]`).join(",")})`;
  return `${menu} li:has(> ${links}){display:none}${menu} > div:not(:has(a:not(${links}))){display:none}`;
}

/**
 * Läsbehörighet: the notice above a page the profile reads but does not
 * change. It names each of the page's areas and who changes it, so the
 * reader knows whom to ask; the page's write controls are hidden by
 * readOnlyStyle below.
 *
 * A server component like AreaRefusal: the (app) layout renders one per set
 * of areas the profile reads read-only, above every page, each hidden until
 * the style rule shows the one whose page is open. No code reaches the
 * browser for it. Static text, so no live role: it is the page's state, not
 * news.
 */
export function ReadOnlyNotice({ areas, profile }: { areas: readonly AdminArea[]; profile: AdminProfile }) {
  const t = useTranslations("adminAreas");
  const locale = useLocale();
  const list = new Intl.ListFormat(locale, { type: "disjunction" });
  const writersOf = (area: AdminArea) =>
    list.format(WRITER_ORDER.filter((writer) => profileWrites(writer, area)).map((writer) => t(`doer.${writer}`)));
  return (
    <div data-read-only={noticeKey(areas)} className="mb-4 print:hidden">
      <Notice role={null} title={t("readOnlyTitle")}>
        {[
          t("readOnlyBody", { profile: t(`profile.${profile}`) }),
          ...areas.map((area) => t("readOnlyWriters", { area: t(`area.${area}`), writers: writersOf(area) })),
        ].join(" ")}
      </Notice>
    </div>
  );
}

/** The notice's name in the style rule: its areas, space-separated. */
function noticeKey(areas: readonly AdminArea[]): string {
  return areas.join(" ");
}

/** One ReadOnlyNotice per set of areas the profile reads read-only, for the layout to put above the page. */
export function readOnlyNoticesFor(pages: readonly ReadOnlyPage[], profile: AdminProfile | null): React.ReactNode {
  if (profile === null || pages.length === 0) return null;
  const sets = new Map(pages.map((page) => [noticeKey(page.areas), page.areas]));
  return [...sets].map(([key, areas]) => <ReadOnlyNotice key={key} areas={areas} profile={profile} />);
}

/**
 * What the profile does not change, as a style rule the (app) layout renders
 * on the server, beside closedMenuStyle:
 *
 *  - a control marked data-writes="AREA" (or "DECIDES", or several areas)
 *    is hidden from a profile that does not write the area, so a page
 *    offers no button the gateway would refuse;
 *  - a part marked data-writes-inert="AREA" stays on the page but takes no
 *    pointer: a lesson card one drags to move, a cell one clicks to edit.
 *    What it shows is the page's reading; what it does is a write;
 *  - the notices are hidden, and the one whose page the menu marks as
 *    current (aria-current="page", which a sub-page's parent link carries
 *    too) is shown. The desktop menu is in the document at every width, so
 *    :has() finds it on a phone as well.
 *
 * The gateway refuses the same writes by name (RolesGuard), and the
 * database refuses them under it: hiding is a courtesy, not the rule.
 */
export function readOnlyStyle(pages: readonly ReadOnlyPage[], profile: AdminProfile | null, menuLabel: string): string {
  const unwritten: string[] = ADMIN_AREAS.filter((area) => !profileWrites(profile, area));
  if (!profileDecides(profile)) unwritten.push("DECIDES");
  let css =
    unwritten.length > 0
      ? `${unwritten.map((gate) => `[data-writes~="${gate}"]`).join(",")}{display:none!important}` +
        `${unwritten.map((gate) => `[data-writes-inert~="${gate}"]`).join(",")}{pointer-events:none}`
      : "";
  if (pages.length === 0) return css;
  const menu = `nav[aria-label="${menuLabel.replace(/["\\]/g, "\\$&")}"]`;
  // Hidden, and never printed: a printout is the page's reading, not its state.
  css += "[data-read-only]{display:none}@media print{[data-read-only]{display:none!important}}";
  const byNotice = new Map<string, string[]>();
  for (const page of pages) {
    const key = noticeKey(page.areas);
    byNotice.set(key, [...(byNotice.get(key) ?? []), page.path]);
  }
  for (const [key, paths] of byNotice) {
    const current = `${menu} a[aria-current="page"]:is(${paths.map((path) => `[href$="${path}"]`).join(",")})`;
    css += `body:has(${current}) [data-read-only="${key}"]{display:block}`;
  }
  return css;
}
