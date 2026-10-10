import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { layoutDay } from "@/lib/day-lanes";
import {
  isIndex,
  placement,
  readViewerResponse,
  shiftWeek,
  shownDays,
  timed,
  TOKEN_PATTERN,
  viewerFetchOf,
  viewerHref,
  viewerQueryOf,
  weekSpan,
  type PublicIndex,
  type PublicLesson,
  type PublicWeek,
  type ViewerOutcome,
  type ViewerQuery,
} from "@/lib/public-timetable";

/*
 * Schemavisaren: a class's, a teacher's or a room's PUBLISHED week, or an
 * index of a school's classes or rooms, without a login, behind a share link
 * an admin made on /admin/publishing. What a school's printed schedule shows
 * on the classroom door: times, subject, group, room, and the teacher as the
 * school chose (signature, name, or nothing).
 *
 * A SERVER COMPONENT with no client code of its own: the week is laid out
 * here (lib/day-lanes.ts, the timetable's own lane rule) and sent as HTML, so
 * a phone on a slow connection gets the week in one response and the page's
 * JavaScript is Next's runtime alone. The same HTML is the print view: one
 * A4 page, landscape, without the navigation.
 *
 * THE GATEWAY DECIDES WHAT EXISTS (lib/public-timetable.ts says what the
 * document can hold). This page fetches it with no cache of its own
 * (cache: "no-store"), so a revoked link is gone when the gateway's minute
 * of public caching is — the HTML itself is dynamic, which Next serves
 * private and uncached. Every "not found" is one page, as the gateway's 404
 * is one answer.
 */

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

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
  if (!TOKEN_PATTERN.test(token)) notFound();

  const query = viewerQueryOf({ target: search.target, date: search.date });
  const base = process.env.PUBLIC_VIEWER_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const request = viewerFetchOf(
    base,
    token,
    query,
    (await headers()).get("x-forwarded-for"),
    process.env.PUBLIC_VIEWER_PROXY_KEY,
  );
  let outcome: ViewerOutcome;
  try {
    outcome = await readViewerResponse(await fetch(request.url, { cache: "no-store", headers: request.headers }));
  } catch {
    outcome = { kind: "unavailable" };
  }
  if (outcome.kind === "notFound") notFound();

  return (
    <main lang={locale} className="mx-auto max-w-6xl px-4 py-6 print:max-w-none print:p-0">
      {/* One A4, landscape; the blocks keep their tint on paper. */}
      <style>{`@page { size: A4 landscape; margin: 8mm; }
@media print { .viewer-block { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }`}</style>
      {outcome.kind === "busy" || outcome.kind === "unavailable" ? (
        <Message
          title={t(outcome.kind === "busy" ? "busyTitle" : "unavailableTitle")}
          body={t(outcome.kind === "busy" ? "busyBody" : "unavailableBody")}
        />
      ) : isIndex(outcome.document) ? (
        <IndexView document={outcome.document} token={token} locale={locale} t={t} />
      ) : (
        <WeekView document={outcome.document} token={token} query={query} locale={locale} t={t} tDays={tDays} />
      )}
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-2 py-16 text-center">
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

function lessonText(lesson: PublicLesson, t: Translate): { main: string; detail: string } {
  if (lesson.busy) return { main: t("busy"), detail: "" };
  const groups = (lesson.groups ?? []).map((group) => group ?? t("group")).join(", ");
  return {
    main: lesson.subject ?? "",
    detail: [groups, lesson.room ?? null, (lesson.teachers ?? []).join(", ") || null].filter(Boolean).join(" · "),
  };
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
  const days = shownDays(document.days);
  const span = weekSpan(document.days);
  const hours = Array.from({ length: (span.end - span.start) / 60 + 1 }, (_, index) => span.start / 60 + index);
  const dateFormat = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const short = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const dayName = (date: string) => tDays(String(new Date(`${date}T00:00:00Z`).getUTCDay() || 7));
  const week = Number(document.week.isoWeek.split("W")[1]);
  const nav = (date: string | null) => viewerHref(token, { target: query.target, date, lang: locale });

  return (
    <div className="space-y-3 print:space-y-1">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm">
            {document.school} · {t(`kind.${document.kind}`)}
          </p>
          <h1 className="text-2xl font-semibold print:text-lg">{document.title}</h1>
          <p className="text-sm">
            {t("week", { week })} · {short(document.week.from)} – {short(document.week.to)}
          </p>
        </div>
        <nav className="viewer-nav flex flex-wrap items-center gap-3 text-sm print:hidden" aria-label={t("title")}>
          {query.target ? (
            <a href={viewerHref(token, { lang: locale })} className="underline underline-offset-4">
              {t("backToIndex")}
            </a>
          ) : null}
          <a href={nav(shiftWeek(document.week.from, -1))} className="underline underline-offset-4">
            ← {t("previous")}
          </a>
          <a href={nav(null)} className="underline underline-offset-4">
            {t("thisWeek")}
          </a>
          <a href={nav(shiftWeek(document.week.from, 1))} className="underline underline-offset-4">
            {t("next")} →
          </a>
          <LanguageLink token={token} query={query} locale={locale} t={t} />
        </nav>
      </header>

      {/*
        A phone gets the week as a list, day by day; a wider screen and the
        printout get the grid. Both from the same document, one shown at a
        time (display: none hides the other from screen readers too).
      */}
      <ol className="space-y-3 md:hidden print:hidden">
        {days.map((day) => (
          <li key={`list-${day.date}`} className="space-y-1">
            <h2 className="font-semibold">
              {dayName(day.date)} <span className="font-normal">{short(day.date)}</span>
            </h2>
            {day.lessons.length === 0 && (day.meals ?? []).length === 0 ? (
              <p className="text-sm">{t("noLessons")}</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {[
                  ...day.lessons.map((lesson) => ({ at: lesson.start, lesson })),
                  ...(day.meals ?? []).map((meal) => ({ at: meal.start, meal })),
                ]
                  .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
                  .map((entry, index) => {
                    if ("meal" in entry && entry.meal) {
                      return (
                        <li key={`m-${index}`} className="bg-amber-50 px-3 py-1.5">
                          <span className="tabular-nums">
                            {entry.meal.start}–{entry.meal.end}
                          </span>{" "}
                          {t("meal")}
                        </li>
                      );
                    }
                    const lesson = (entry as { lesson: PublicLesson }).lesson;
                    const text = lessonText(lesson, t);
                    return (
                      <li key={`l-${index}`} className={`px-3 py-1.5 ${lesson.cancelled ? "text-neutral-600" : ""}`}>
                        <span className="tabular-nums">
                          {lesson.start}–{lesson.end}
                        </span>{" "}
                        <span className={`font-semibold ${lesson.cancelled ? "line-through" : ""}`}>{text.main}</span>
                        {lesson.cancelled ? <strong> · {t("cancelled")}</strong> : null}
                        {text.detail ? <span className="block text-xs">{text.detail}</span> : null}
                      </li>
                    );
                  })}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <div
        className="hidden rounded-md border text-xs md:grid print:grid print:text-[9px]"
        style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div className="border-b" />
        {days.map((day) => (
          <h2
            key={`h-${day.date}`}
            className="min-w-0 truncate border-b border-l px-2 py-1 text-sm font-semibold print:text-[10px]"
          >
            {dayName(day.date)} <span className="font-normal">{short(day.date)}</span>
          </h2>
        ))}
        <div className="relative h-[40rem] print:h-[145mm]" aria-hidden>
          {hours.slice(0, -1).map((hour) => (
            <span
              key={hour}
              className="absolute right-1 -translate-y-0 tabular-nums"
              style={{ top: `${placement({ start: `${hour}:00`, end: `${hour}:00` }, span).top}%` }}
            >
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((day) => {
          const lessons = layoutDay(timed(day.lessons));
          return (
            <div key={day.date} className="relative h-[40rem] border-l print:h-[145mm]">
              {hours.slice(1, -1).map((hour) => (
                <div
                  key={hour}
                  className="absolute inset-x-0 border-t border-dashed border-neutral-200"
                  style={{ top: `${placement({ start: `${hour}:00`, end: `${hour}:00` }, span).top}%` }}
                  aria-hidden
                />
              ))}
              {(day.meals ?? []).map((meal) => {
                const at = placement(meal, span);
                return (
                  <div
                    key={`meal-${meal.start}`}
                    className="viewer-block absolute inset-x-0 border-y border-dashed border-amber-300 bg-amber-50 px-1"
                    style={{ top: `${at.top}%`, height: `${at.height}%` }}
                  >
                    {t("meal")} {meal.start}–{meal.end}
                  </div>
                );
              })}
              {lessons.length === 0 ? <p className="sr-only">{t("noLessons")}</p> : null}
              <ol>
                {lessons.map((lesson, index) => {
                  const at = placement(lesson, span);
                  const text = lessonText(lesson, t);
                  return (
                    <li
                      key={`${lesson.start}-${index}`}
                      className={`viewer-block absolute overflow-hidden rounded border px-1 py-0.5 leading-tight ${
                        lesson.busy
                          ? "border-neutral-300 bg-neutral-200 italic"
                          : lesson.cancelled
                            ? "border-neutral-300 bg-neutral-50 text-neutral-600"
                            : "border-indigo-200 bg-indigo-50"
                      }`}
                      style={{
                        top: `${at.top}%`,
                        height: `${at.height}%`,
                        left: `${(lesson.lane * 100) / lesson.laneCount}%`,
                        width: `${100 / lesson.laneCount}%`,
                      }}
                    >
                      <span className="block tabular-nums">
                        {lesson.start}–{lesson.end}
                        {lesson.cancelled ? <strong> · {t("cancelled")}</strong> : null}
                      </span>
                      <span className={`block font-semibold ${lesson.cancelled ? "line-through" : ""}`}>{text.main}</span>
                      {text.detail ? <span className="block">{text.detail}</span> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
      <p className="text-xs">
        {t("footer")} <span className="print:hidden">{t("printHint")}</span>
      </p>
    </div>
  );
}
