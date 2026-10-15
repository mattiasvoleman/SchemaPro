import { notFound } from "next/navigation";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { SHEET_PAGE_STYLE, WeekSheet, type Translate } from "@/components/timetable-sheet/week-sheet";
import { weekNumberOf } from "@/lib/print-sheet";
import {
  canGoBack,
  isIndex,
  shiftWeek,
  TOKEN_PATTERN,
  viewerHref,
  viewerQueryOf,
  type PublicIndex,
  type PublicWeek,
  type ViewerQuery,
} from "@/lib/public-timetable";
import { readViewer } from "../read-viewer";

/*
 * Schemavisaren in a frame on the school's own website (Utskrift och
 * inbäddning, 20261102090000): the share link's week, or its index, compact.
 *
 * WHAT IT SHOWS is the viewer's document, asked of the gateway exactly as the
 * viewer page asks it (../read-viewer.ts): embedding adds a frame, not a
 * field. WHO MAY FRAME IT is the proxy's to say (proxy.ts, lib/embed-policy.ts):
 * the school's websites when the school lets this link be embedded, nobody
 * otherwise — so this page needs no check of its own, and opened on its own
 * it shows no more than the viewer page does.
 *
 * Compact for a frame: a smaller header, the list in a narrow frame and the
 * grid in a wide one (the frame's width is the page's viewport), the week's
 * links inside the frame, and one link out to the full viewer in a new tab.
 * The tab order is the navigation's, then the link out; the week itself is
 * read, not tabbed through.
 */

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function EmbeddedTimetablePage({
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
  if (!TOKEN_PATTERN.test(token)) notFound();

  const query = viewerQueryOf({ target: search.target, date: search.date });
  const outcome = await readViewer(token, query);
  if (outcome.kind === "notFound") notFound();

  return (
    <main lang={locale} className="px-2 py-2 text-sm print:p-0">
      <style>{SHEET_PAGE_STYLE}</style>
      {outcome.kind === "busy" || outcome.kind === "unavailable" ? (
        <div className="space-y-1 py-6 text-center">
          <title>{t(outcome.kind === "busy" ? "busyTitle" : "unavailableTitle")}</title>
          <h1 className="text-base font-semibold">{t(outcome.kind === "busy" ? "busyTitle" : "unavailableTitle")}</h1>
          <p>{t(outcome.kind === "busy" ? "busyBody" : "unavailableBody")}</p>
        </div>
      ) : isIndex(outcome.document) ? (
        <EmbeddedIndex document={outcome.document} token={token} locale={locale} t={t} />
      ) : (
        <EmbeddedWeek document={outcome.document} token={token} query={query} locale={locale} t={t} tDays={tDays} />
      )}
    </main>
  );
}

/** Out of the frame: the full viewer, in a new tab, never inside the school's page. */
function OpenFull({ token, query, locale, t }: { token: string; query: Partial<ViewerQuery>; locale: string; t: Translate }) {
  return (
    <a
      href={viewerHref(token, { ...query, lang: locale })}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4"
    >
      {t("openFull")}
    </a>
  );
}

function EmbeddedIndex({ document, token, locale, t }: { document: PublicIndex; token: string; locale: string; t: Translate }) {
  return (
    <div className="space-y-2">
      <title>{`${t(`index.${document.kind}`)} – ${document.school}`}</title>
      <header>
        <p className="text-xs">{document.school}</p>
        <h1 className="text-lg font-semibold">{t(`index.${document.kind}`)}</h1>
      </header>
      {document.targets.length === 0 ? (
        <p>{t("indexEmpty")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
          {document.targets.map((target) => (
            <li key={target.id}>
              <a
                href={viewerHref(token, { target: target.id, lang: locale }, { embed: true })}
                className="block rounded-md border px-2 py-1.5 font-medium hover:bg-neutral-100"
              >
                {target.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {/* The way out after the targets, as after a week's navigation: the frame's own links come first. */}
      <p>
        <OpenFull token={token} query={{}} locale={locale} t={t} />
      </p>
    </div>
  );
}

function EmbeddedWeek({
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
  const week = weekNumberOf(document);
  const nav = (date: string | null) => viewerHref(token, { target: query.target, date, lang: locale }, { embed: true });
  return (
    <div className="space-y-2">
      <title>{`${document.title} – ${t("week", { week })}`}</title>
      <WeekSheet
        document={document}
        locale={locale}
        t={t}
        tDays={tDays}
        variant="embed"
        actions={
          <nav className="flex flex-wrap items-center gap-3 text-xs" aria-label={t("title")}>
            {query.target ? (
              <a href={viewerHref(token, { lang: locale }, { embed: true })} className="underline underline-offset-4">
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
            <OpenFull token={token} query={query} locale={locale} t={t} />
          </nav>
        }
      />
    </div>
  );
}
