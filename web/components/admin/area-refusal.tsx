import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { ClosedPages } from "@/components/profile-context";
import type { AdminArea, AdminProfile, ClosedPage } from "@/lib/admin-areas";

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
  const profileName = t(`profile.${profile ?? "FULL"}`);
  return (
    <Page width="narrow">
      <title>{`${t("gateTitle")} · SchemaPro`}</title>
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
