import { notFound } from "next/navigation";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { SHEET_PAGE_STYLE, WeekSheet, type Translate } from "@/components/timetable-sheet/week-sheet";
import { weekNumberOf } from "@/lib/print-sheet";
import {
  isIndex,
  shiftWeek,
  viewerAddressOf,
  viewerHref,
  viewerQueryOf,
  canGoBack,
  type PublicIndex,
  type PublicWeek,
  type ViewerQuery,
} from "@/lib/public-timetable";
import { readViewer } from "./read-viewer";
import { readViewerAsStaff } from "./read-as-staff";

/*
 * Schemavisaren: a class's, a teaching group's, a teacher's, a room's or one
 * pupil's PUBLISHED week, or a list of the school's classes, teachers or
 * rooms, behind a link or a code the school made on /admin/schemavisaren.
 * What a school's printed schedule shows on the classroom door: times,
 * subject, group, room, and the teacher as the school chose (signature, name,
 * or nothing). A pupil's page names no group and, unless the school gave the
 * link a label, no title but "Elevens schema".
 *
 * A SERVER COMPONENT with no client code of its own: the week is laid out
 * here (lib/day-lanes.ts, lanes per overlap cluster) and sent as HTML, so
 * a phone on a slow connection gets the week in one response and the page's
 * JavaScript is Next's runtime alone. The same HTML is the print view: one
 * A4 page, landscape, without the navigation.
 *
 * THE GATEWAY DECIDES WHAT EXISTS (lib/public-timetable.ts says what the
 * document can hold). This page fetches it with no cache of its own
 * (cache: "no-store"), so a revoked link is gone when the gateway's minute
 * of public caching is — the HTML itself is dynamic, which Next serves
 * private and uncached. Every "not found" is one page, as the gateway's 404
 * is one answer: an unknown address, a kind that is off, a schedule that is
 * hidden or protected, a viewer that is for staff.
 *
 * THAT LAST ONE has a second door. When the public answer is the 404 and the
 * visitor already carries a session, the page asks once more as that person
 * (./read-as-staff.ts) and shows what the signed-in twin answers; only when
 * that is the 404 too is the page "not found". Nobody without a session is
 * asked twice, and nobody is told which of the reasons it was.
 *
 * THE ADDRESS may be written any way a person writes a code: the page reads
 * it (lib/viewer-token.ts) and links to the one spelling.
 */

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PublicTimetablePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { token } = await params;
  const search = await searchParams;
  const locale = search.lang === "en" ? "en" : "sv";
  const messages = locale === "en" ? en : sv;
  const t = createTranslator({ locale, messages, namespace: "publicViewer" }) as unknown as Translate;
  const tDays = createTranslator({ locale, messages, namespace: "days" }) as unknown as Translate;
  // The address in the spelling the page links to; an address that is no link is not asked about.
  const address = viewerAddressOf(token);
  if (address === null) notFound();

  const query = viewerQueryOf({ target: search.target, date: search.date });
  let outcome = await readViewer(address, query);
  if (outcome.kind === "notFound") outcome = (await readViewerAsStaff(address, query)) ?? outcome;
  if (outcome.kind === "notFound") notFound();

  return (
    <main lang={locale} className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:p-0">
      {/* One A4, landscape; the blocks keep their tint on paper. */}
      <style>{SHEET_PAGE_STYLE}</style>
      {outcome.kind === "busy" || outcome.kind === "unavailable" ? (
        <Message
          title={t(outcome.kind === "busy" ? "busyTitle" : "unavailableTitle")}
          body={t(outcome.kind === "busy" ? "busyBody" : "unavailableBody")}
        />
      ) : isIndex(outcome.document) ? (
        <IndexView document={outcome.document} token={address} locale={locale} t={t} />
      ) : (
        <WeekView document={outcome.document} token={address} query={query} locale={locale} t={t} tDays={tDays} />
      )}
      {/* The tillgänglighetsredogörelse, which a visitor without an account
          can reach from nowhere else. The screen's, not the paper's. */}
      <p className="mt-6 text-xs print:hidden">
        <a href={`/${locale}/tillganglighet`} className="underline underline-offset-4">
          {t("accessibility")}
        </a>
      </p>
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-2 py-16 text-center">
      <title>{title}</title>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p>{body}</p>
    </div>
  );
}

function LanguageLink({ token, query, locale, t }: { token: string; query: Partial<ViewerQuery>; locale: string; t: Translate }) {
  return (
    <a
      href={viewerHref(token, { ...query, lang: locale === "en" ? "sv" : "en" })}
      className="underline underline-offset-4"
    >
      {t("otherLanguage")}
    </a>
  );
}

function IndexView({ document, token, locale, t }: { document: PublicIndex; token: string; locale: string; t: Translate }) {
  return (
    <div className="space-y-4">
      <title>{`${t(`index.${document.kind}`)} – ${document.school}`}</title>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm">{document.school}</p>
          <h1 className="text-2xl font-semibold">{t(`index.${document.kind}`)}</h1>
        </div>
        <LanguageLink token={token} query={{}} locale={locale} t={t} />
      </header>
      {document.targets.length === 0 ? (
        <p>{t("indexEmpty")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {document.targets.map((target) => (
            <li key={target.id}>
              <a
                href={viewerHref(token, { target: target.id, lang: locale })}
                className="block rounded-md border px-3 py-2 font-medium hover:bg-neutral-100"
              >
                {target.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeekView({
  document,
  token,
  query,
  locale,
  t,
  tDays,
}: {
  document: PublicWeek;
  token: string;
  query: ViewerQuery;
  locale: string;
  t: Translate;
  tDays: Translate;
}) {
  // A pupil's link has the title the school gave it, or none: then the page
  // says what it is, and still not whose it is.
  const shown: PublicWeek = document.title === "" ? { ...document, title: t("studentTitle") } : document;
  const week = weekNumberOf(shown);
  const nav = (date: string | null) => viewerHref(token, { target: query.target, date, lang: locale });

  return (
    <div className="space-y-3 print:space-y-1">
      <title>{`${shown.title} – ${t("week", { week })}`}</title>
      <WeekSheet
        document={shown}
        locale={locale}
        t={t}
        tDays={tDays}
        variant="page"
        actions={
          <nav className="viewer-nav flex flex-wrap items-center gap-3 text-sm" aria-label={t("title")}>
            {query.target ? (
              <a href={viewerHref(token, { lang: locale })} className="underline underline-offset-4">
                {t("backToIndex")}
              </a>
            ) : null}
            {canGoBack(document.week.from, new Date().toISOString().slice(0, 10)) ? (
              <a href={nav(shiftWeek(document.week.from, -1))} className="underline underline-offset-4">
                ← {t("previous")}
              </a>
            ) : null}
            <a href={nav(null)} className="underline underline-offset-4">
              {t("thisWeek")}
            </a>
            <a href={nav(shiftWeek(document.week.from, 1))} className="underline underline-offset-4">
              {t("next")} →
            </a>
            <LanguageLink token={token} query={query} locale={locale} t={t} />
          </nav>
        }
      />
      <p className="text-xs">
        {t("footer")} <span className="print:hidden">{t("printHint")}</span>
      </p>
    </div>
  );
}
